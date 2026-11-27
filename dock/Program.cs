// SPIKE: proves the window behaviour before any drawing is written. Nothing here is the final look.
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

static class Program
{
    [STAThread] static void Main() => new Application().Run(new Spike());
}

sealed class Spike : Window
{
    const int HotVoice = 1, HotType = 2;
    readonly TextBlock status = new() { Foreground = Brushes.White, FontSize = 12, Margin = new Thickness(0, 0, 0, 4), TextTrimming = TextTrimming.CharacterEllipsis };
    readonly TextBox box = new() { Width = 150, Visibility = Visibility.Collapsed, Margin = new Thickness(8, 0, 0, 0) };
    readonly Button button = new() { Content = "Click me", Padding = new Thickness(10, 2, 10, 2) };
    IntPtr hwnd, previous;
    int clicks;
    bool typing, listening;

    public Spike()
    {
        WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true; Background = null; // null, not Transparent: a Transparent brush would catch clicks
        Topmost = true; ShowInTaskbar = false; ShowActivated = false;
        Width = 344; Height = 72;
        var area = SystemParameters.WorkArea;
        Left = area.Left + (area.Width - Width) / 2; Top = area.Top;

        var row = new StackPanel { Orientation = Orientation.Horizontal, Children = { button, box } };
        Content = new Border
        {
            CornerRadius = new CornerRadius(36), BorderThickness = new Thickness(1), BorderBrush = new SolidColorBrush(Color.FromArgb(120, 255, 255, 255)),
            Background = new SolidColorBrush(Color.FromArgb(150, 0, 0, 0)), Padding = new Thickness(26, 10, 26, 10),
            Child = new StackPanel { Children = { status, row } },
        };
        Say("SPIKE. Ctrl+Alt+K voice, Ctrl+Alt+J type, right-click quits");

        button.Click += (_, _) => Say($"clicks: {++clicks}. Did focus stay in your other app? (dock is foreground: {Native.GetForegroundWindow() == hwnd})");
        MouseRightButtonUp += (_, _) => Close();
        box.KeyDown += (_, e) =>
        {
            if (e.Key == Key.Enter) { Say($"would send: \"{box.Text}\""); EndType(); }
            else if (e.Key == Key.Escape) { Say("typing cancelled"); EndType(); }
        };
        Deactivated += (_, _) => { if (typing) EndType(restore: false); }; // you clicked somewhere else: let go
        var keepOnTop = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        keepOnTop.Tick += (_, _) => { if (!typing) Native.KeepOnTop(hwnd); };
        keepOnTop.Start();
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var src = (HwndSource)PresentationSource.FromVisual(this)!;
        hwnd = src.Handle;
        Native.ToolWindow(hwnd);
        Native.NoActivate(hwnd, true);
        src.AddHook(Hook);
        // shortcut: no fallback if another program already owns a hotkey; the dock will say so on screen then
        var mods = Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT;
        if (!Native.RegisterHotKey(hwnd, HotVoice, mods, 0x4B) || !Native.RegisterHotKey(hwnd, HotType, mods, 0x4A))
            Say("A hotkey (Ctrl+Alt+K or J) is taken by another program");
    }

    protected override void OnClosed(EventArgs e)
    {
        Native.UnregisterHotKey(hwnd, HotVoice);
        Native.UnregisterHotKey(hwnd, HotType);
        base.OnClosed(e);
    }

    IntPtr Hook(IntPtr h, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != Native.WM_HOTKEY) return IntPtr.Zero;
        handled = true;
        if (wParam.ToInt32() == HotVoice) { listening = !listening; Say(listening ? "Listening... (Ctrl+Alt+K again to stop)" : "Stopped listening"); }
        else if (!typing) BeginType();
        return IntPtr.Zero;
    }

    async void BeginType()
    {
        previous = Native.GetForegroundWindow();
        if (previous == hwnd) previous = IntPtr.Zero;
        typing = true;
        Native.NoActivate(hwnd, false);
        box.Visibility = Visibility.Visible;
        Activate();
        Native.SetForegroundWindow(hwnd);
        box.Focus(); Keyboard.Focus(box);
        await Task.Delay(150);
        Say($"type, Enter or Esc. Got keyboard focus: {Native.GetForegroundWindow() == hwnd}");
    }

    void EndType(bool restore = true)
    {
        typing = false;
        box.Clear(); box.Visibility = Visibility.Collapsed;
        Native.NoActivate(hwnd, true);
        if (restore && previous != IntPtr.Zero) Native.SetForegroundWindow(previous); // back to the app you were in
    }

    void Say(string s) => status.Text = s;
}
