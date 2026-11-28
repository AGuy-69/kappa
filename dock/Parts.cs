using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Media;

/// <summary>One layer of the glass, painted from the pill's current shape. Only the glass layer takes the mouse, and only inside the pill.</summary>
sealed class Layer : FrameworkElement
{
    readonly Action<DrawingContext, Geometry> paint;
    readonly bool interactive;
    Geometry shape = Geometry.Empty;

    public Layer(Action<DrawingContext, Geometry> paint, bool interactive = false)
    {
        this.paint = paint; this.interactive = interactive;
        IsHitTestVisible = interactive;
        Width = Pill.LayerW; Height = Pill.WindowH;
    }

    public void Set(Geometry g) { shape = g; InvalidateVisual(); }

    protected override void OnRender(DrawingContext dc) => paint(dc, shape);

    protected override HitTestResult? HitTestCore(PointHitTestParameters p) =>
        interactive && shape.FillContains(p.HitPoint) ? new PointHitTestResult(this, p.HitPoint) : null;
}

/// <summary>
/// What Kappa is saying or doing: a 14pt line and, when there is something more to say, a 12pt line under it.
/// A state label fades in as one; a reply arrives a few words at a time, each sliding up a little, staggered.
/// </summary>
sealed class TextView : FrameworkElement
{
    public const double Wide = 217;
    static readonly FontFamily Font = new("Segoe UI Variable Text, Segoe UI"); // the system font on Windows, as SF is on Apple platforms
    static readonly Typeface Medium = new(Font, FontStyles.Normal, FontWeights.Medium, FontStretches.Normal);
    static readonly Typeface Regular = new(Font, FontStyles.Normal, FontWeights.Normal, FontStretches.Normal);
    static readonly Brush Primary = Ink.Solid(Ink.W(.95)), Secondary = Ink.Solid(Ink.W(.8)); // 9.3:1 and 7.1:1 on the glass over a white window
    const double Space = 14 * .28;

    readonly List<FormattedText> words = [];
    FormattedText? detail;
    long started;
    bool wasAnimating;

    public TextView()
    {
        Width = Wide; Height = Pill.Height;
        IsHitTestVisible = false;
        OpacityMask = Ink.Linear(new Point(0, .5), new Point(1, .5), (0, Colors.Black), (.9, Colors.Black), (1, Colors.Transparent)); // long text fades out at the right
    }

    double Elapsed => (Stopwatch.GetTimestamp() - started) / (double)Stopwatch.Frequency;
    bool Animating => !Access.ReducedMotion && words.Count > 0 && Elapsed < (words.Count - 1) * .18 + .34;

    FormattedText Make(string s, Typeface face, double size, Brush brush, bool trim)
    {
        var ft = new FormattedText(s, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight, face, size, brush, VisualTreeHelper.GetDpi(this).PixelsPerDip);
        if (trim) { ft.MaxTextWidth = Wide; ft.MaxLineCount = 1; ft.Trimming = TextTrimming.CharacterEllipsis; }
        return ft;
    }

    /// <summary>A status: one main line and an optional smaller line under it.</summary>
    public void Set(string main, string? more = null)
    {
        words.Clear();
        if (main != "") words.Add(Make(main, Medium, 14, Primary, true));
        detail = string.IsNullOrEmpty(more) ? null : Make(more, Regular, 12, Secondary, true);
        Restart();
    }

    /// <summary>A few words of the reply.</summary>
    public void ShowWords(string[] batch)
    {
        words.Clear(); detail = null;
        foreach (var w in batch) words.Add(Make(w, Medium, 14, Primary, false));
        Restart();
    }

    void Restart() { started = Stopwatch.GetTimestamp(); wasAnimating = true; InvalidateVisual(); }

    public void Advance()
    {
        bool a = Animating;
        if (a || wasAnimating) InvalidateVisual(); // one extra frame after the end so the last word lands fully
        wasAnimating = a;
    }

    protected override void OnRender(DrawingContext dc)
    {
        if (words.Count == 0) return;
        double now = Access.ReducedMotion ? 99 : Elapsed;
        double total = words[0].Height + (detail != null ? 1 + detail.Height : 0);
        double y0 = (Height - total) / 2, x = 0;
        for (int i = 0; i < words.Count; i++)
        {
            double t = Math.Clamp((now - i * .18) / .34, 0, 1), e = 1 - Math.Pow(1 - t, 4); // fast start, soft landing
            dc.PushOpacity(e);
            dc.DrawText(words[i], new Point(x, y0 + 7 * (1 - e)));
            if (i == 0 && detail != null) dc.DrawText(detail, new Point(0, y0 + words[0].Height + 1 + 7 * (1 - e)));
            dc.Pop();
            x += words[i].Width + Space;
        }
    }
}