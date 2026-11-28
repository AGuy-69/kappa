using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;

/// <summary>The two small windows the dock opens: a box to type a request into, and the question "may Kappa do this?".</summary>
static class Dialogs
{
    public const double TypeWidth = 420, TypeHeight = 56;

    static Window Base(double width) => new()
    {
        Width = width, ResizeMode = ResizeMode.NoResize, Topmost = true, ShowInTaskbar = false,
        Background = Ink.Solid(Color.FromRgb(0x1c, 0x1c, 0x1e)), Foreground = Brushes.White,
        FontFamily = new FontFamily("Segoe UI Variable Text, Segoe UI"),
    };

    /// <summary>A one-line box. Enter sends it; Escape, or clicking elsewhere, closes it.</summary>
    public static Window TypeBox(double left, double top, Action<string> send)
    {
        var w = Base(TypeWidth);
        w.WindowStyle = WindowStyle.None; w.Height = TypeHeight; w.Left = left; w.Top = top;
        var box = new TextBox
        {
            Margin = new Thickness(10), Padding = new Thickness(6, 4, 6, 4), FontSize = 14, BorderThickness = new Thickness(0),
            Background = Ink.Solid(Ink.W(.08)), Foreground = Brushes.White, CaretBrush = Brushes.White,
        };
        w.Content = box;
        bool closing = false; // closing a window that is already closing throws
        w.Closing += (_, _) => closing = true;
        w.Deactivated += (_, _) => { if (!closing) w.Close(); };
        w.Loaded += (_, _) => { w.Activate(); Native.SetForegroundWindow(new WindowInteropHelper(w).Handle); box.Focus(); };
        box.KeyDown += (_, e) =>
        {
            if (e.Key == Key.Escape) w.Close();
            else if (e.Key == Key.Enter && box.Text.Trim() is { Length: > 0 } text) { w.Close(); send(text); }
        };
        return w;
    }

    /// <summary>Shows what Kappa wants to do, in full. Allow is a click; Enter and Space are Deny, so a stray key never says yes.
    /// Closing the window is a no. <paramref name="answer"/> is called once.</summary>
    public static Window Approval(string tool, string risk, string target, string detail, Action<bool> answer)
    {
        var w = Base(460);
        w.Title = "Kappa asks"; w.SizeToContent = SizeToContent.Height; w.WindowStartupLocation = WindowStartupLocation.CenterScreen;
        bool high = risk == "high", answered = false;
        void Finish(bool ok) { if (answered) return; answered = true; answer(ok); }

        var deny = new Button { Content = "Deny", MinWidth = 80, IsDefault = true };
        var allow = new Button { Content = "Allow", MinWidth = 80, Margin = new Thickness(8, 0, 0, 0) };
        deny.Click += (_, _) => w.Close();                       // Closed answers no
        allow.Click += (_, _) => { Finish(true); w.Close(); };
        w.Closed += (_, _) => Finish(false);
        w.KeyDown += (_, e) => { if (e.Key == Key.Escape) w.Close(); };
        w.Loaded += (_, _) => deny.Focus();

        var body = new StackPanel { Margin = new Thickness(16) };
        body.Children.Add(new TextBlock
        {
            Text = tool + (high ? "   HIGH RISK" : ""), FontSize = 16, FontWeight = FontWeights.SemiBold,
            Foreground = high ? Ink.Solid(Ink.Red) : Brushes.White,
        });
        body.Children.Add(new TextBlock { Text = target, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 8, 0, 0) });
        if (detail != "")
            body.Children.Add(new ScrollViewer
            {
                MaxHeight = 240, VerticalScrollBarVisibility = ScrollBarVisibility.Auto, Margin = new Thickness(0, 8, 0, 0),
                Content = new TextBlock { Text = detail, FontFamily = new FontFamily("Consolas"), TextWrapping = TextWrapping.Wrap, Opacity = .8 },
            });
        body.Children.Add(new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Right, Margin = new Thickness(0, 14, 0, 0), Children = { deny, allow } });
        w.Content = body;
        return w;
    }
}