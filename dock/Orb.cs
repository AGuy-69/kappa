using System.Windows;
using System.Windows.Media;

/// <summary>
/// The glass orb with a dandelion of spokes. Every spoke has its own breathing rhythm, angular drift and occasional surge,
/// and the whole bloom turns slowly. The state sets its personality: calm / synced breathing / lively / slumped and red.
/// Ported from the mockup's burst.
/// </summary>
sealed class OrbView : FrameworkElement
{
    public const double Size = 38;           // on screen; everything below is drawn in a 42-unit design space and scaled down to this
    const double Design = 42, R = 19, Scale = .8; // spoke reach, and spoke-units to design pixels (the mockup draws a 40-unit box into 32px)

    // spin, tempo, amp, fire, jitter, sync
    static readonly Dictionary<string, double[]> Moods = new()
    {
        ["idle"] = [.12, .55, .9, .35, 0, 0],
        ["thinking"] = [.08, 1, 1, 0, 0, 1],
        ["working"] = [.2, 1.4, 1.05, 0, 0, 0],
        ["error"] = [.03, .4, .75, .15, 1, 0],
    };

    sealed class Spoke
    {
        public double A, Base, F, Ph, Wf, Wph, Wamp, Fire, Next, X, Y, Dot;
    }

    static double Rnd(double a, double b) => a + Random.Shared.NextDouble() * (b - a);

    readonly Spoke[] spokes;
    readonly double[] mood = [.12, .55, .9, .35, 0, 0];
    double[] target = Moods["idle"];
    double bt, bs, rot, jolt = 99, joltX;
    bool error, hover;

    static readonly Brush Shell = Ink.Radial(new Point(.3, .22), 1.05, 1.05, (0, Ink.W(.34)), (.62, Ink.W(.06)), (1, Ink.W(.06)));
    static readonly Brush ShellBase = Ink.Solid(Ink.K(.22));
    static readonly Pen Edge = Freeze(new Pen(Ink.Solid(Ink.W(.3)), 1));
    static readonly Pen EdgeRed = Freeze(new Pen(Ink.Solid(Ink.Alpha(Ink.Red, .55)), 1));
    // top lip catches the light, bottom has a soft lift: the orb's inset highlights in one stroke
    static readonly Pen Lip = Freeze(new Pen(Ink.Linear(new Point(0, 0), new Point(0, 1), (0, Ink.W(.75)), (.3, Ink.W(0)), (.7, Ink.W(0)), (1, Ink.W(.22))), 1.5));
    static readonly Brush Halo = Ink.Radial(new Point(.5, .5), .5, .5, (0, Ink.W(.2)), (1, Ink.W(0)));
    static readonly Brush HaloRed = Ink.Radial(new Point(.5, .5), .5, .5, (0, Ink.Alpha(Ink.Red, .3)), (1, Ink.Alpha(Ink.Red, 0)));
    static readonly Pen Spoke1 = Freeze(new Pen(Ink.Solid(Ink.W(.9)), .7) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round });
    static readonly Pen SpokeRed = Freeze(new Pen(Ink.Solid(Ink.Alpha(Ink.Red, .9)), .7) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round });
    static readonly Brush Plate = Ink.Solid(Ink.W(.12)); // hover feedback: the orb is a button
    static readonly Brush DotWhite = Ink.Solid(Colors.White);
    static readonly Brush DotRed = Ink.Solid(Ink.Red);

    static Pen Freeze(Pen p) { p.Freeze(); return p; }

    public OrbView()
    {
        Width = Height = Size;
        IsHitTestVisible = false;
        spokes = new Spoke[64];
        for (int i = 0; i < spokes.Length; i++)
            spokes[i] = new Spoke
            {
                A = Rnd(0, 6.2832), Base = R * (.28 + .72 * Math.Pow(Random.Shared.NextDouble(), .55)),
                F = Rnd(.6, 2.2), Ph = Rnd(0, 6.28), Wf = Rnd(.3, 1), Wph = Rnd(0, 6.28), Wamp = Rnd(.03, .12),
                Next = Rnd(0, 4), Dot = Rnd(.55, .95),
            };
    }

    public bool Hover { set { if (hover != value) { hover = value; InvalidateVisual(); } } }

    public void SetState(string state)
    {
        target = Moods.GetValueOrDefault(state, Moods["idle"]);
        error = state == "error";
        if (Access.ReducedMotion) { Array.Copy(target, mood, mood.Length); jolt = 99; } // no easing, no jolt: the new state just appears
        else if (error) jolt = 0;
        InvalidateVisual();
    }

    public void Advance(double dt)
    {
        double k = 1 - Math.Pow(1 - .06, dt * 60);
        for (int i = 0; i < mood.Length; i++) mood[i] += (target[i] - mood[i]) * k;
        double spin = mood[0], tempo = mood[1], amp = mood[2], fire = mood[3], jit = mood[4], sync = mood[5];
        bt += dt * tempo; bs += dt * 1.7; rot += dt * spin;
        double breath = Math.Sin(bs); // shared breath: every point goes in and out together
        foreach (var sp in spokes)
        {
            sp.Next -= dt * fire;
            if (sp.Next <= 0) { sp.Fire = 1; sp.Next = Rnd(1.2, 4.5); }
            sp.Fire *= Math.Pow(.18, dt);
            double wave = Math.Sin(bt * sp.F + sp.Ph) * (1 - sync) + breath * sync;
            double len = (sp.Base * ((.72 + .12 * sync) + (.22 - .11 * sync) * wave) + sp.Fire * (R - sp.Base) * .6 + sp.Fire * 2) * amp
                         + (Access.ReducedMotion ? 0 : Random.Shared.NextDouble() * jit * 1.2);
            double ang = sp.A + rot + Math.Sin(bt * sp.Wf + sp.Wph) * sp.Wamp * (1 - sync);
            sp.X = Math.Cos(ang) * len; sp.Y = Math.Sin(ang) * len;
        }
        // error: two quick sideways jolts of 2px
        jolt += dt;
        double u = jolt < .7 ? (jolt % .35) / .35 : -1;
        joltX = u < 0 ? 0 : u < .25 ? -2 * (u / .25) : u < .75 ? -2 + 4 * ((u - .25) / .5) : 2 * (1 - (u - .75) / .25);
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext dc)
    {
        var c = new Point(Design / 2, Design / 2);
        dc.PushTransform(new ScaleTransform(Size / Design, Size / Design));
        if (hover) dc.DrawEllipse(Plate, null, c, 24.5, 24.5);
        dc.DrawEllipse(ShellBase, null, c, 21, 21);
        dc.DrawEllipse(Shell, null, c, 21, 21);
        dc.DrawEllipse(null, error ? EdgeRed : Edge, c, 20.5, 20.5);
        dc.DrawEllipse(null, Lip, c, 19.9, 19.9);

        dc.PushClip(new EllipseGeometry(c, 21, 21));
        dc.PushTransform(new TranslateTransform(c.X + joltX, c.Y));
        dc.DrawEllipse(error ? HaloRed : Halo, null, new Point(0, 0), 17, 17); // soft glow behind the bloom
        dc.PushTransform(new ScaleTransform(Scale, Scale));
        var pen = error ? SpokeRed : Spoke1;
        var dot = error ? DotRed : DotWhite;
        foreach (var sp in spokes)
        {
            var p = new Point(sp.X, sp.Y);
            dc.DrawLine(pen, new Point(0, 0), p);
            dc.DrawEllipse(dot, null, p, sp.Dot, sp.Dot);
        }
        dc.DrawEllipse(dot, null, new Point(0, 0), 1.9, 1.9); // the dense core
        dc.Pop(); dc.Pop(); dc.Pop(); dc.Pop();
    }
}