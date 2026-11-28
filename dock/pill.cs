/// <summary>The pill's measurements. It rests as a 52px circle holding just the orb, and widens to hold text and a stop button.</summary>
static class Pill
{
    public const double Full = 320, Compact = 52, Height = 52, Top = 8; // widths, height, gap under the top of the window
    public const double Reach = Full - Compact;                         // how far the pill grows beyond the orb's circle
    public const double WindowW = Compact + 2 * Reach, WindowH = 84;    // room to grow either way, plus the shadow below
    public const double Center = WindowW / 2;                           // the orb's circle is centred here and never moves
    public const double LayerW = Full + 20;                             // a glass layer covers the widest pill plus its shadow
}

/// <summary>A critically damped spring: it glides to its target and stops with no overshoot, in about a fifth of a second.</summary>
sealed class Ease
{
    const double Omega = 22, Step_ = 1 / 240.0;
    public double X, V, Target;

    public Ease(double x) { X = Target = x; }

    public bool Settled => Math.Abs(X - Target) < .05 && Math.Abs(V) < .5;
    public void Snap() { X = Target; V = 0; }

    public void Step(double dt)
    {
        for (double t = 0; t < dt; t += Step_)
        {
            double h = Math.Min(Step_, dt - t);
            V += (Omega * Omega * (Target - X) - 2 * Omega * V) * h;
            X += V * h;
        }
        if (Settled) Snap();
    }
}