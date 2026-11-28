using Microsoft.Win32;
using System.Windows;

/// <summary>The three Windows accessibility settings the dock honours: animations off, transparency off, high contrast.</summary>
static class Access
{
    public static bool ReducedMotion, ReducedTransparency, HighContrast;
    public static event Action? Changed;

    static Access()
    {
        Read();
        SystemEvents.UserPreferenceChanged += (_, _) => Application.Current?.Dispatcher.InvokeAsync(() => { Read(); Changed?.Invoke(); });
    }

    static void Read()
    {
        ReducedMotion = !SystemParameters.ClientAreaAnimation;
        HighContrast = SystemParameters.HighContrast;
        ReducedTransparency = Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "EnableTransparency", 1) is 0;
    }
}