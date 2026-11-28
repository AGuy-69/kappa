using System.Diagnostics;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Effects;

/// <summary>
/// The whole dock. A pill of dark glass floating just under the top of the screen: it rests as a circle holding only the orb,
/// and widens to show what Kappa is doing, with a stop button while it works. Knows nothing about Kappa itself: it is told a state.
/// </summary>
sealed class DockView : Canvas
{
    // Dark smoked glass: a transparent window cannot blur what is behind it, so the tint carries legibility (text stays at 7:1 or better over a white window).
    static readonly Brush Tint = Ink.Solid(Ink.K(.78)), TintSolid = Ink.Solid(Ink.K(.96));
    static readonly Brush Sheen = Ink.Linear(new Point(0, 0), new Point(0, 1), (0, Ink.W(.15)), (.55, Ink.W(.035)), (1, Ink.W(.09)));
    static readonly Brush Specular = Ink.Radial(new Point(.18, -.1), 1.2, .9, (0, Ink.W(.28)), (.55, Ink.W(0)));
    static readonly Brush Lift = Ink.Linear(new Point(0, 1), new Point(0, 0), (0, Ink.W(.07)), (.4, Ink.W(0)));
    static readonly Brush RimWhite = Ink.Linear(new Point(0, 0), new Point(1, 1), (0, Ink.W(.95)), (.3, Ink.W(.4)), (.55, Ink.W(.1)), (.8, Ink.W(.38)), (1, Ink.W(.8)));
    static readonly Brush RimRed = Ink.Linear(new Point(0, 0), new Point(1, 1), (0, Ink.Alpha(Ink.Red, .95)), (.3, Ink.Alpha(Ink.Red, .4)), (.55, Ink.Alpha(Ink.Red, .1)), (.8, Ink.Alpha(Ink.Red, .38)), (1, Ink.Alpha(Ink.Red, .8)));
    static readonly Pen Rim = Round(new Pen(RimWhite, 1.2)), RimError = Round(new Pen(RimRed, 1.2));
    static readonly Pen Glow = Round(new Pen(RimWhite, 8)), GlowError = Round(new Pen(RimRed, 8));
    static readonly Brush ShadowFill = Ink.Solid(Ink.K(.5));

    static Pen Round(Pen p) { p.LineJoin = PenLineJoin.Round; p.Freeze(); return p; }

    readonly Ease width = new(Pill.Compact);
    readonly Layer shadow, glass, glow, rim;
    readonly OrbView orb = new();
    readonly TextView text = new();
    readonly Button stop = MakeStop();
    string state = "idle";
    bool error;
    long last = Stopwatch.GetTimestamp();
    int dir = 1;    // which way the pill grows from the orb: 1 to the right, -1 to the left, 0 both ways (centred on where the orb rests)
    Rect orbZone;   // the orb's click area

    public event Action? OrbClicked, StopClicked, QuitRequested, DragEnded, Rested;
    public event Action<Vector>? Dragged; // how far the pointer moved, in screen units, since the last report

    Point downAt, lastAt;
    bool dragging;

    public DockView()
    {
        Width = Pill.WindowW; Height = Pill.WindowH;
        shadow = new Layer((dc, g) => dc.DrawGeometry(ShadowFill, null, g)) { Effect = new BlurEffect { Radius = 8 }, Opacity = .35, RenderTransform = new TranslateTransform(0, 4) };
        glass = new Layer(PaintGlass, interactive: true);
        glow = new Layer((dc, g) => dc.DrawGeometry(null, error ? GlowError : Glow, g)) { Effect = new BlurEffect { Radius = 6 }, Opacity = .55 };
        rim = new Layer(PaintRim);
        foreach (UIElement e in new UIElement[] { shadow, glass, glow, rim, orb, text, stop }) Children.Add(e);

        // Press and move anywhere on the pill to drag it. A press that barely moves is a click, which on the orb means "talk".
        glass.MouseLeftButtonDown += (_, e) => { downAt = lastAt = ScreenPoint(e); dragging = false; glass.CaptureMouse(); };
        glass.MouseMove += (_, e) =>
        {
            if (!glass.IsMouseCaptured) { Hover(orbZone.Contains(e.GetPosition(this))); return; }
            var p = ScreenPoint(e);
            if (!dragging && (p - downAt).Length > SystemParameters.MinimumHorizontalDragDistance) { dragging = true; Hover(false); glass.Cursor = Cursors.SizeAll; Retarget(); }
            if (!dragging) return;
            Dragged?.Invoke(p - lastAt); lastAt = p;
        };
        glass.MouseLeftButtonUp += (_, e) =>
        {
            if (!glass.IsMouseCaptured) return;
            glass.ReleaseMouseCapture();
            if (dragging) { dragging = false; glass.Cursor = null; Retarget(); DragEnded?.Invoke(); }
            else if (orbZone.Contains(e.GetPosition(this))) OrbClicked?.Invoke();
        };
        glass.MouseLeave += (_, _) => { if (!dragging) Hover(false); };
        glass.MouseRightButtonUp += (_, _) => QuitRequested?.Invoke();
        stop.Click += (_, _) => StopClicked?.Invoke();

        Access.Changed += ApplyAccess;
        ApplyAccess();
        SetState("idle");
        CompositionTarget.Rendering += (_, _) => Tick();
    }

    // ---- what the rest of the app calls ------------------------------------------------------------------------

    /// <summary>idle, listening, thinking, working, responding or error. detail is the tool name or the error message.</summary>
    public void SetState(string s, string? detail = null)
    {
        state = s;
        error = s == "error";
        bool busy = s is "listening" or "thinking" or "working" or "responding";
        orb.SetState(s is "listening" or "thinking" ? "thinking" : s is "working" or "responding" ? "working" : s);
        Retarget();
        stop.Visibility = busy ? Visibility.Visible : Visibility.Collapsed;
        string spoken;
        switch (s)
        {
            case "listening": text.Set("Listening", "Press Ctrl+Alt+K to send"); spoken = "Listening"; break;
            case "thinking": text.Set("Thinking"); spoken = "Thinking"; break;
            case "working": text.Set("Working", Humanize(detail)); spoken = "Working" + (detail is null ? "" : ", " + Humanize(detail)); break;
            case "responding": text.Set(""); spoken = "Responding"; break;
            case "error": text.Set("Couldn't finish", detail); spoken = "Couldn't finish. " + detail; break;
            default: text.Set(""); spoken = "Idle"; break;
        }
        if (Access.ReducedMotion) width.Snap();
        Rebuild();
        glow.InvalidateVisual(); rim.InvalidateVisual();
        Announce(spoken);
        if (s == "idle" && width.Settled) Rested?.Invoke();
    }

    /// <summary>Wide while Kappa is busy, except while the dock is being dragged: then it is the orb.</summary>
    void Retarget()
    {
        width.Target = state == "idle" || dragging ? Pill.Compact : Pill.Full;
        if (Access.ReducedMotion) { width.Snap(); Rebuild(); }
    }

    /// <summary>Which way the pill grows from the orb. Only honoured while it is a circle, so it never changes its mind halfway.</summary>
    public void SetDirection(int d)
    {
        if (d == dir || width.X > Pill.Compact + .5) return;
        dir = d;
        Rebuild();
    }

    /// <summary>Left and right ends of the pill in window units, once it has grown to the size it is heading for.</summary>
    public (double left, double right) Extent
    {
        get
        {
            double w = width.Target, r = Pill.Height / 2;
            return dir > 0 ? (Pill.Center - r, Pill.Center - r + w) : dir < 0 ? (Pill.Center + r - w, Pill.Center + r) : (Pill.Center - w / 2, Pill.Center + w / 2);
        }
    }

    public void ShowWords(string[] batch) => text.ShowWords(batch);

    // ---- drawing -----------------------------------------------------------------------------------------------

    void PaintGlass(DrawingContext dc, Geometry g)
    {
        if (Access.HighContrast) { dc.DrawGeometry(new SolidColorBrush(SystemColors.WindowColor), null, g); return; }
        if (Access.ReducedTransparency) { dc.DrawGeometry(TintSolid, null, g); return; }
        foreach (var b in new[] { Tint, Sheen, Specular, Lift }) dc.DrawGeometry(b, null, g);
    }

    void PaintRim(DrawingContext dc, Geometry g) =>
        dc.DrawGeometry(null, Access.HighContrast ? new Pen(new SolidColorBrush(SystemColors.WindowTextColor), 2) : error ? RimError : Rim, g);

    void ApplyAccess()
    {
        shadow.Visibility = glow.Visibility = Access.ReducedTransparency || Access.HighContrast ? Visibility.Collapsed : Visibility.Visible;
        glass.InvalidateVisual(); rim.InvalidateVisual();
        if (Access.ReducedMotion) { width.Snap(); Rebuild(); }
    }

    void Tick()
    {
        long now = Stopwatch.GetTimestamp();
        double dt = Math.Min(.05, (now - last) / (double)Stopwatch.Frequency);
        bool settled = width.Settled;
        if (Access.ReducedMotion) { if (settled) return; }                  // nothing moves by itself
        else if (state == "idle" && settled && dt < 1 / 30.0) return;       // at rest the orb only needs about 30 frames a second
        last = now;
        if (!settled) { width.Step(dt); Rebuild(); if (width.Settled && state == "idle") Rested?.Invoke(); }
        orb.Advance(Access.ReducedMotion ? 0 : dt);
        text.Advance();
    }

    /// <summary>
    /// Lays everything out. The orb's circle stays put; the pill grows away from it, to the right, to the left (mirrored, orb on the right), or both ways.
    /// Layers are positioned over the widest the pill gets in its direction, and drawn in their own coordinates.
    /// </summary>
    void Rebuild()
    {
        double w = width.X, r = Pill.Height / 2, c = Pill.Center;
        double x0 = dir > 0 ? c - r : dir < 0 ? c + r - w : c - w / 2, x1 = x0 + w;   // the pill, in window units
        double layerLeft = dir > 0 ? c - r - 10 : dir < 0 ? c + r + 10 - Pill.LayerW : c - Pill.LayerW / 2;
        bool orbLeft = dir >= 0;                                                       // growing both ways keeps the orb at the left end, like growing right
        var pill = new RectangleGeometry(new Rect(x0 - layerLeft, Pill.Top, w, Pill.Height), r, r);
        pill.Freeze();
        foreach (var l in new[] { shadow, glass, glow, rim }) { SetLeft(l, layerLeft); l.Set(pill); }
        glow.Clip = pill; // the inner glow stays inside the glass

        orbZone = new Rect(orbLeft ? x0 : x1 - Pill.Height, Pill.Top, Pill.Height, Pill.Height);
        SetLeft(orb, orbZone.X + 7); SetTop(orb, Pill.Top + 7);
        SetLeft(text, orbLeft ? x0 + 55 : x0 + 48); SetTop(text, Pill.Top);          // text sits between the orb and the stop button
        text.Clip = new RectangleGeometry(new Rect(0, 0, Math.Max(0, w - 103), Pill.Height));
        text.Opacity = Math.Clamp((w - 120) / 160, 0, 1);                              // text arrives as the pill widens
        SetLeft(stop, orbLeft ? x1 - 40 : x0 + 12); SetTop(stop, Pill.Top + 12);
        stop.Opacity = text.Opacity;
    }

    /// <summary>The pointer in screen units. The window moves under the pointer while dragging, so positions inside it would drift.</summary>
    Point ScreenPoint(MouseEventArgs e)
    {
        var p = glass.PointToScreen(e.GetPosition(glass));
        var dpi = VisualTreeHelper.GetDpi(this);
        return new Point(p.X / dpi.DpiScaleX, p.Y / dpi.DpiScaleY);
    }

    void Hover(bool over)
    {
        orb.Hover = over;
        glass.Cursor = over ? Cursors.Hand : null;
    }

    // ---- screen readers ----------------------------------------------------------------------------------------

    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);

    void Announce(string spoken)
    {
        AutomationProperties.SetName(this, "Kappa: " + spoken);
        AutomationProperties.SetLiveSetting(this, AutomationLiveSetting.Polite);
        UIElementAutomationPeer.FromElement(this)?.RaiseAutomationEvent(AutomationEvents.LiveRegionChanged);
    }

    static string? Humanize(string? tool) => string.IsNullOrEmpty(tool) ? null : char.ToUpperInvariant(tool[0]) + tool[1..].Replace('_', ' ');

    /// <summary>A 28x28 round stop button. Real WPF button, so screen readers can find it and the mouse gets hover and press feedback.</summary>
    static Button MakeStop() => (Button)XamlReader.Parse("""
        <Button xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
                Width="28" Height="28" Cursor="Hand" Focusable="False" AutomationProperties.Name="Stop" ToolTip="Stop">
          <Button.Template>
            <ControlTemplate TargetType="Button">
              <Grid Background="Transparent">
                <Ellipse x:Name="plate" Fill="#00FFFFFF"/>
                <Rectangle Width="10" Height="10" RadiusX="2.5" RadiusY="2.5" Fill="#F2FFFFFF" HorizontalAlignment="Center" VerticalAlignment="Center"/>
              </Grid>
              <ControlTemplate.Triggers>
                <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="plate" Property="Fill" Value="#29FFFFFF"/></Trigger>
                <Trigger Property="IsPressed" Value="True"><Setter TargetName="plate" Property="Fill" Value="#47FFFFFF"/></Trigger>
              </ControlTemplate.Triggers>
            </ControlTemplate>
          </Button.Template>
        </Button>
        """);
}