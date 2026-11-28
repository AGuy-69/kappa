using System.IO;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

/// <summary>
/// Kappa's brain, run as a child process (node src/app/ui.ts, the same as `npm run ui`) and spoken to in lines of JSON.
/// The messages are listed at the top of src/app/bridge.ts. Message and Stopped are raised on a background thread.
/// </summary>
sealed class KappaLink : IDisposable
{
    public event Action<JsonElement>? Message;
    public event Action<string>? Stopped; // why Kappa is gone: its last line on stderr, or why it would not start

    Process? proc;
    string lastError = "";
    bool disposed;

    public void Start()
    {
        try
        {
            var psi = new ProcessStartInfo("node", "--disable-warning=ExperimentalWarning src/app/ui.ts")
            {
                WorkingDirectory = FindRoot(), UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8,
            };
            proc = Process.Start(psi)!;
        }
        catch (Exception e) { Stopped?.Invoke("Can't start Kappa: " + e.Message); return; } // e.g. Node is not installed
        proc.ErrorDataReceived += (_, e) => { if (!string.IsNullOrWhiteSpace(e.Data)) lastError = e.Data; };
        proc.BeginErrorReadLine();
        new Thread(Read) { IsBackground = true }.Start();
    }

    // shortcut: the project is found by walking up from the dock's exe, so the dock has to run from inside the repo; an installed build needs a setting.
    static string FindRoot()
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
            if (File.Exists(Path.Combine(d.FullName, "src", "app", "ui.ts"))) return d.FullName;
        throw new FileNotFoundException("src/app/ui.ts not found above " + AppContext.BaseDirectory);
    }

    void Read()
    {
        string? line;
        while ((line = proc!.StandardOutput.ReadLine()) != null)
        {
            JsonElement m;
            try { using var doc = JsonDocument.Parse(line); m = doc.RootElement.Clone(); }
            catch (JsonException) { continue; } // stdout carries only the protocol, so this is noise
            if (m.ValueKind == JsonValueKind.Object) Message?.Invoke(m);
        }
        proc.WaitForExit(); // lets stderr finish, so the reason is in lastError
        if (!disposed) Stopped?.Invoke(lastError == "" ? "Kappa stopped" : lastError);
    }

    public void Send(object m)
    {
        try { proc?.StandardInput.WriteLine(JsonSerializer.Serialize(m)); }
        catch (Exception e) when (e is IOException or InvalidOperationException) { /* it is gone, and Stopped has said so */ }
    }

    /// <summary>Closing its stdin is how Kappa is told to finish: the bridge cancels what it is doing, denies open approvals and exits.</summary>
    public void Dispose()
    {
        disposed = true;
        try { proc?.StandardInput.Close(); if (proc?.WaitForExit(2000) == false) proc.Kill(true); }
        catch (Exception e) when (e is IOException or InvalidOperationException) { /* already gone */ }
    }
}