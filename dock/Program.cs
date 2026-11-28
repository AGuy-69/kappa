using System.Globalization;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

static class Program
{
    [STAThread] static void Main()
    {
        Native.AttachParentConsole();
        new Application().Run(new DockWindow());
    }
}

/// <summary>The window: transparent, always on top, and never takes focus from the app you are working in (proven by the spike).</summary>
sealed class DockWindow : Window
{
    const int HotVoice = 1, HotType = 2;
    readonly DockView view = new();
    readonly KappaLink link = new();
    IntPtr hwnd;

    string state = "idle";   // what the dock shows: idle, listening, thinking, working, responding or error
    Window? asking, typing;  // the approval question and the typing box, while they are open
    bool Free => state is "idle" or "error";

    // A reply streams in; the dock shows it a few words at a time (see NextBatch).
    static readonly char[] Blank = [' ', '\n', '\r', '\t'];
    readonly Queue<string> words = new();
    readonly DispatcherTimer pace = new() { Interval = TimeSpan.FromSeconds(1.55) };
    string tail = "";                          // the reply's last word, which may not be finished yet
    bool replying, finished;                   // words are on show / the bridge has sent the whole reply
    (string state, string? detail)? after;     // an idle or error that arrived while words were still on show

    // With a voice that reports what it is saying (ElevenLabs), the words follow the voice instead of the model's stream.
    bool timedVoice;
    readonly Queue<(DateTime due, string[] words)> schedule = new();
    const double SpeechLag = .6; // seconds from "this piece starts" to sound coming out (PowerShell starting the player); tune it on your machine

    public DockWindow()
    {
        WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true; Background = null; // null, not Transparent: a Transparent brush would catch clicks
        Topmost = true; ShowInTaskbar = false; ShowActivated = false;
        Width = Pill.WindowW; Height = Pill.WindowH;
        Content = view;
        var area = SystemParameters.WorkArea; // the top-centre snap point, unless you moved it last time
        Place(area.Left + area.Width / 2 - Pill.Center, area.Top + SnapMargin - Pill.Top);
        if (LoadPosition() is { } saved) Place(saved.cx - Pill.Center, saved.cy - Pill.Height / 2 - Pill.Top);

        view.Rested += () => view.SetDirection(ChooseDirection()); // decided while it rests, so it never changes its mind mid-way
        view.Dragged += d => { raw = Clamp((raw ?? new Point(Left, Top)) + d); Place(raw.Value.X, raw.Value.Y, snap: true); };
        view.DragEnded += () => { raw = null; Place(Left, Top); SavePosition(); }; // it may be wide again: keep it on screen
        view.OrbClicked += Talk;
        view.StopClicked += Stop;
        view.QuitRequested += Close; // shortcut: right-click quits until the dock has a tray icon
        pace.Tick += (_, _) => NextBatch();
        link.Message += m => Dispatcher.InvokeAsync(() => OnMessage(m));
        link.Stopped += why => Dispatcher.InvokeAsync(() => { ResetReply(); Display("error", why); });
        link.Start();
        var keepOnTop = new DispatcherTimer { Interval = TimeSpan.FromSeconds(2) };
        keepOnTop.Tick += (_, _) => Native.KeepOnTop(hwnd); // another topmost window may have been placed above us
        keepOnTop.Start();
    }

    // ---- moving the dock ---------------------------------------------------------------------------------------

    // The saved position is the orb's centre, not the window corner, so changing the window's size can never shift it.
    static readonly string PositionFile = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Kappa", "dock-center.txt");
    const double SnapMargin = 12, SnapRadius = 36, EdgeMargin = 4;
    Point? raw; // where the pointer says the window is while dragging, before snapping, so snapping never makes it drift

    /// <summary>Keeps the pill, at the size it is heading for, completely on a screen. A resting orb can therefore go right to an edge,
    /// a widened pill never leaves the screen, and a position saved on a monitor that is gone lands on one that is there.</summary>
    Point Clamp(Point p)
    {
        double vl = SystemParameters.VirtualScreenLeft, vt = SystemParameters.VirtualScreenTop;
        double vw = SystemParameters.VirtualScreenWidth, vh = SystemParameters.VirtualScreenHeight;
        var (l, r) = view.Extent;
        return new Point(Math.Clamp(p.X, vl + EdgeMargin - l, vl + vw - EdgeMargin - r),
                         Math.Clamp(p.Y, vt + EdgeMargin - Pill.Top, vt + vh - EdgeMargin - Pill.Top - Pill.Height));
    }

    void Place(double left, double top, bool snap = false)
    {
        var p = Clamp(new Point(left, top));
        if (snap) p = Clamp(Snap(p));
        Left = p.X; Top = p.Y;
        view.SetDirection(ChooseDirection());
    }

    /// <summary>A magnet: near one of six common places (top and bottom, each at left, centre and right of the screen the orb is on) it locks on.</summary>
    Point Snap(Point p)
    {
        double r = Pill.Height / 2, cx = p.X + Pill.Center, cy = p.Y + Pill.Top + r;
        var a = WorkAreaAt(new Point(cx, cy));
        double[] xs = [a.Left + SnapMargin + r, a.Left + a.Width / 2, a.Right - SnapMargin - r];
        double[] ys = [a.Top + SnapMargin + r, a.Bottom - SnapMargin - r];
        double best = SnapRadius, bx = cx, by = cy;
        foreach (var x in xs)
            foreach (var y in ys)
            {
                double d = Math.Sqrt((cx - x) * (cx - x) + (cy - y) * (cy - y));
                if (d <= best) { best = d; bx = x; by = y; }
            }
        return new Point(bx - Pill.Center, by - r - Pill.Top);
    }

    /// <summary>Grow both ways if there is room on both sides, else toward a side that has room, else toward whichever has more.</summary>
    int ChooseDirection()
    {
        double r = Pill.Height / 2, cx = Left + Pill.Center, cy = Top + Pill.Top + r;
        var a = WorkAreaAt(new Point(cx, cy));
        double right = a.Right - (cx + r) - SnapMargin, left = cx - r - a.Left - SnapMargin;
        if (right >= Pill.Reach / 2 && left >= Pill.Reach / 2) return 0;
        return right >= Pill.Reach ? 1 : left >= Pill.Reach ? -1 : right >= left ? 1 : -1;
    }

    /// <summary>The usable area of the monitor under a point, in the same units as Left and Top.</summary>
    Rect WorkAreaAt(Point p)
    {
        var dpi = VisualTreeHelper.GetDpi(this);
        double sx = dpi.DpiScaleX, sy = dpi.DpiScaleY;
        return Native.WorkAreaAt((int)(p.X * sx), (int)(p.Y * sy), out var w)
            ? new Rect(w.Left / sx, w.Top / sy, (w.Right - w.Left) / sx, (w.Bottom - w.Top) / sy)
            : SystemParameters.WorkArea;
    }

    static (double cx, double cy)? LoadPosition()
    {
        try
        {
            var parts = System.IO.File.ReadAllText(PositionFile).Split(' ');
            return (double.Parse(parts[0], CultureInfo.InvariantCulture), double.Parse(parts[1], CultureInfo.InvariantCulture));
        }
        catch { return null; } // no file yet, or unreadable: use the default
    }

    void SavePosition()
    {
        try
        {
            System.IO.Directory.CreateDirectory(System.IO.Path.GetDirectoryName(PositionFile)!);
            System.IO.File.WriteAllText(PositionFile, string.Create(CultureInfo.InvariantCulture, $"{Left + Pill.Center} {Top + Pill.Top + Pill.Height / 2}"));
        }
        catch { /* shortcut: if the position cannot be saved, it simply opens at the top next time */ }
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        base.OnSourceInitialized(e);
        var src = (HwndSource)PresentationSource.FromVisual(this)!;
        hwnd = src.Handle;
        Native.ToolWindow(hwnd);
        Native.NoActivate(hwnd, true);
        src.AddHook(Hook);
        // shortcut: no fallback if another program already owns a hotkey; the dock shows an error then
        var mods = Native.MOD_CONTROL | Native.MOD_ALT | Native.MOD_NOREPEAT;
        if (!Native.RegisterHotKey(hwnd, HotVoice, mods, 0x4B) || !Native.RegisterHotKey(hwnd, HotType, mods, 0x4A))
            Display("error", "Ctrl+Alt+K or J is used by another program");
    }

    protected override void OnClosed(EventArgs e)
    {
        Native.UnregisterHotKey(hwnd, HotVoice);
        Native.UnregisterHotKey(hwnd, HotType);
        asking?.Close(); typing?.Close(); // an open approval answers no
        link.Dispose();
        base.OnClosed(e);
    }

    IntPtr Hook(IntPtr h, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != Native.WM_HOTKEY) return IntPtr.Zero;
        handled = true;
        if (wParam.ToInt32() == HotVoice) Talk(); else Compose();
        return IntPtr.Zero;
    }

    // ---- what the user does ------------------------------------------------------------------------------------

    /// <summary>Ctrl+Alt+K or the orb: start listening, and while listening, send what was said.</summary>
    void Talk()
    {
        if (state == "listening") link.Send(new { t = "listen", on = false });
        else if (Free) link.Send(new { t = "listen", on = true });
    }

    /// <summary>Ctrl+Alt+J: a box under the pill to type a request into.</summary>
    void Compose()
    {
        if (typing != null) { typing.Activate(); return; }
        if (!Free) return;
        var a = WorkAreaAt(new Point(Left + Pill.Center, Top + Pill.Top));
        double below = Top + Pill.Top + Pill.Height + 6;
        double x = Math.Clamp(Left + Pill.Center - Dialogs.TypeWidth / 2, a.Left, a.Right - Dialogs.TypeWidth);
        double y = below + Dialogs.TypeHeight > a.Bottom ? Top + Pill.Top - Dialogs.TypeHeight - 6 : below; // no room under it: above
        var w = typing = Dialogs.TypeBox(x, y, text => link.Send(new { t = "say", text }));
        w.Closed += (_, _) => typing = null;
        w.Show();
    }

    void Stop()
    {
        link.Send(new { t = "cancel" });
        asking?.Close();
        if (replying) EndReply();
    }

    // ---- what Kappa says ---------------------------------------------------------------------------------------

    static string Str(JsonElement m, string key) => m.TryGetProperty(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString()! : "";

    void OnMessage(JsonElement m)
    {
        switch (Str(m, "t"))
        {
            case "state": Apply(Str(m, "s"), Str(m, "label")); break;
            case "text": Stream(Str(m, "d")); break;
            case "ready": link.Send(new { t = "voice", on = true }); break; // voice is on by default
            case "done": Print(m); Done(m); break;
            case "speech": Say(Str(m, "text"), m.TryGetProperty("seconds", out var sec) && sec.TryGetDouble(out var d) ? d : 0); break;
            case "spoken": Spoken(); break;
            case "approval": Ask(m); break;
            case "voice":
                timedVoice = m.TryGetProperty("timed", out var t) && t.ValueKind == JsonValueKind.True;
                if (Str(m, "error") != "") { ResetReply(); Apply("error", Str(m, "error")); }
                break;
        }
    }

    /// <summary>For debugging: the whole reply, and any error, in the terminal the dock was started from.</summary>
    static void Print(JsonElement m)
    {
        if (Str(m, "text") != "") Console.WriteLine("Kappa: " + Str(m, "text"));
        if (Str(m, "error") != "") Console.WriteLine("Error: " + Str(m, "error"));
    }

    void Display(string s, string? detail)
    {
        state = s;
        view.SetState(s, detail);
    }

    /// <summary>The bridge has four states, the dock six: listening and responding are told apart by the label.</summary>
    void Apply(string s, string label)
    {
        (string, string?) next = s switch
        {
            "thinking" when label == "Listening" => ("listening", null),
            "thinking" => ("thinking", null),
            "working" when label == "Responding" => ("responding", null),
            "working" => ("working", label),
            "error" => ("error", label),
            _ => ("idle", null),
        };
        if ((next.Item1 is "idle" or "error") && replying) { after = next; return; } // wait until the words have been shown
        if (next.Item1 != "responding") ResetReply();
        Display(next.Item1, next.Item2);
    }

    void Stream(string d)
    {
        if (timedVoice) { if (!replying) { replying = true; finished = false; } return; } // the idle that follows waits for the voice
        tail += d;
        int cut = tail.LastIndexOfAny(Blank) + 1;
        foreach (var w in tail[..cut].Split(Blank, StringSplitOptions.RemoveEmptyEntries)) words.Enqueue(w);
        tail = tail[cut..];
        if (replying) return;
        replying = true; finished = false;
        pace.Interval = TimeSpan.FromSeconds(1.55);
        NextBatch();
        pace.Start();
    }

    void Done(JsonElement m)
    {
        asking?.Close();
        if (!replying) return;
        if (timedVoice) { if (Str(m, "status") != "done" || Str(m, "text") == "") EndReply(); return; } // else nothing will be said: the voice ends it
        if (tail != "") { words.Enqueue(tail); tail = ""; }
        finished = true;
        if (words.Count == 0) EndReply();
    }

    /// <summary>A piece of the reply starts playing: its words are spread over how long it lasts, by their length.</summary>
    void Say(string text, double seconds)
    {
        var ws = text.Split(Blank, StringSplitOptions.RemoveEmptyEntries);
        if (ws.Length == 0) return;
        if (!replying) { replying = true; after = ("idle", null); Display("responding", null); }
        finished = false;
        var start = DateTime.UtcNow.AddSeconds(SpeechLag);
        double total = ws.Sum(w => w.Length + 1), seen = 0;
        for (int i = 0; i < ws.Length; i += 3)
        {
            var batch = ws[i..Math.Min(i + 3, ws.Length)];
            schedule.Enqueue((start.AddSeconds(seconds * seen / total), batch));
            seen += batch.Sum(w => w.Length + 1);
        }
        pace.Interval = TimeSpan.FromMilliseconds(60);
        pace.Start();
    }

    /// <summary>The whole reply has been said, or cut off: once its last words have been shown, the dock can rest.</summary>
    void Spoken()
    {
        if (!replying) return;
        finished = true;
        if (schedule.Count == 0) EndReply();
    }

    void NextBatch()
    {
        if (timedVoice)
        {
            string[]? due = null;
            while (schedule.Count > 0 && schedule.Peek().due <= DateTime.UtcNow) due = schedule.Dequeue().words;
            if (due != null) view.ShowWords(due);
            if (schedule.Count == 0 && finished) EndReply();
            return;
        }
        if (words.Count == 0) { if (finished) EndReply(); return; }
        view.ShowWords(Enumerable.Range(0, Math.Min(3, words.Count)).Select(_ => words.Dequeue()).ToArray());
    }

    void ResetReply()
    {
        pace.Stop(); words.Clear(); schedule.Clear(); tail = ""; replying = finished = false; after = null;
    }

    /// <summary>The last words have been shown: now the idle or error that was waiting for them can appear.</summary>
    void EndReply()
    {
        var a = after;
        ResetReply();
        if (a is { } s) Display(s.state, s.detail);
    }

    /// <summary>Kappa wants to do something that needs a yes. The window shows everything; closing it, or Kappa stopping, is a no.</summary>
    void Ask(JsonElement m)
    {
        int id = m.TryGetProperty("id", out var i) && i.TryGetInt32(out var n) ? n : -1;
        var w = asking = Dialogs.Approval(Str(m, "tool"), Str(m, "risk"), Str(m, "target"), Str(m, "detail"), ok => link.Send(new { t = "approve", id, ok }));
        w.Closed += (_, _) => { if (asking == w) asking = null; };
        w.Show();
    }
}