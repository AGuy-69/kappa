using System.Windows;
using System.Windows.Media;

/// <summary>The palette: black and white only. Red is for errors and high-risk approvals, nothing else.</summary>
static class Ink
{
    public static readonly Color Red = Color.FromRgb(0xff, 0x45, 0x3a); // Apple system red

    public static Color W(double a) => Color.FromArgb((byte)Math.Round(a * 255), 255, 255, 255);
    public static Color K(double a) => Color.FromArgb((byte)Math.Round(a * 255), 0, 0, 0);
    public static Color Alpha(Color c, double a) => Color.FromArgb((byte)Math.Round(a * 255), c.R, c.G, c.B);

    public static SolidColorBrush Solid(Color c) { var b = new SolidColorBrush(c); b.Freeze(); return b; }

    public static LinearGradientBrush Linear(Point from, Point to, params (double at, Color c)[] stops)
    {
        var b = new LinearGradientBrush { StartPoint = from, EndPoint = to };
        foreach (var (at, c) in stops) b.GradientStops.Add(new GradientStop(c, at));
        b.Freeze();
        return b;
    }

    public static RadialGradientBrush Radial(Point center, double rx, double ry, params (double at, Color c)[] stops)
    {
        var b = new RadialGradientBrush { Center = center, GradientOrigin = center, RadiusX = rx, RadiusY = ry };
        foreach (var (at, c) in stops) b.GradientStops.Add(new GradientStop(c, at));
        b.Freeze();
        return b;
    }
}
