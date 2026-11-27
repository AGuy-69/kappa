using System.Runtime.InteropServices;

/// <summary>The few Win32 calls the dock needs. 64-bit Windows only (GetWindowLongPtrW does not exist on 32-bit).</summary>
static class Native
{
    public const int WM_HOTKEY = 0x0312;
    public const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_NOREPEAT = 0x4000;

    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;
    const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;
    static readonly IntPtr HWND_TOPMOST = new(-1);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr h, int i);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr h, int id);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);

    static void Style(IntPtr h, int flag, bool on)
    {
        long v = GetLong(h, GWL_EXSTYLE).ToInt64();
        SetLong(h, GWL_EXSTYLE, new IntPtr(on ? v | (long)flag : v & ~(long)flag));
    }

    /// <summary>On: clicking the window never takes keyboard focus from the app behind it.</summary>
    public static void NoActivate(IntPtr h, bool on) => Style(h, WS_EX_NOACTIVATE, on);

    /// <summary>No taskbar button and not listed in Alt+Tab.</summary>
    public static void ToolWindow(IntPtr h) => Style(h, WS_EX_TOOLWINDOW, true);

    /// <summary>Re-asserts topmost without activating: another topmost window may have been placed above ours.</summary>
    public static void KeepOnTop(IntPtr h) => SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE);
}
