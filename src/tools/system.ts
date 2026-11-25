import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDenied } from '../security/paths.ts';
import { KappaError } from '../util/errors.ts';
import type { Tool, ToolCtx } from './registry.ts';

export const win = () => process.platform === 'win32';

/** PowerShell wraps its errors in CLIXML on stderr; pull out the readable message. */
export function cleanStderr(s: string): string {
  if (!s.includes('#< CLIXML')) return s;
  const msgs = [...s.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map((m) =>
    m[1].replace(/_x000D_|_x000A_/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  return msgs.join('').trim() || 'PowerShell failed without an error message';
}

export async function sh(c: ToolCtx, cmd: string, args: string[], env?: Record<string, string>, input?: string): Promise<string> {
  const r = await c.exec(cmd, args, { env: env ? ({ ...process.env, ...env } as Record<string, string>) : undefined, timeoutMs: 20_000, signal: c.signal, input });
  if (r.code !== 0) throw new KappaError('command_failed', (cleanStderr(r.stderr) || r.stdout || `exit code ${r.code}`).trim().slice(0, 500));
  return r.stdout;
}
// Script goes in via -EncodedCommand and user values via environment variables, so nothing is ever string-interpolated into a command.
export const ps = (c: ToolCtx, script: string, env?: Record<string, string>) =>
  sh(c, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${script}`, 'utf16le').toString('base64')], env);

interface Proc { pid: number; name: string; mem_mb: number }
async function listProcesses(c: ToolCtx): Promise<Proc[]> {
  if (win()) {
    const out = await sh(c, 'tasklist', ['/FO', 'CSV', '/NH']);
    return out.split(/\r?\n/).filter(Boolean).map((l) => {
      const f = l.replace(/^"|"$/g, '').split('","');
      return { name: f[0], pid: Number(f[1]), mem_mb: Math.round(parseInt((f[4] ?? '').replace(/\D/g, ''), 10) / 1024) || 0 };
    }).filter((p) => Number.isInteger(p.pid));
  }
  const out = await sh(c, 'ps', ['-eo', 'pid=,rss=,comm=']);
  return out.split('\n').flatMap((l) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(l);
    return m ? [{ pid: Number(m[1]), name: m[3].trim(), mem_mb: Math.round(Number(m[2]) / 1024) }] : [];
  });
}

export const getSystemInfo: Tool<Record<string, never>> = {
  name: 'get_system_info',
  description: 'OS, CPU, memory, uptime, user, local time.',
  parameters: { type: 'object', properties: {} },
  risk: 'low',
  target: () => 'system',
  async run(_a, c) {
    const cpus = os.cpus();
    return {
      time: new Date().toString(), platform: process.platform, os_release: os.release(), arch: os.arch(), hostname: os.hostname(),
      user: os.userInfo().username, home: os.homedir(), cwd: c.cfg.cwd,
      cpu: { count: cpus.length, model: cpus[0]?.model },
      memory_mb: { total: Math.round(os.totalmem() / 2 ** 20), free: Math.round(os.freemem() / 2 ** 20) },
      uptime_hours: Math.round(os.uptime() / 36) / 100, node: process.version,
    };
  },
};

export const inspectProcesses: Tool<{ name_contains?: string; limit?: number }> = {
  name: 'inspect_processes',
  description: 'List running processes (pid, name, MB), biggest first.',
  parameters: {
    type: 'object',
    properties: { name_contains: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
  },
  risk: 'low',
  target: (a) => a.name_contains ?? 'all processes',
  async run(a, c) {
    const needle = a.name_contains?.toLowerCase();
    const all = (await listProcesses(c)).filter((p) => !needle || p.name.toLowerCase().includes(needle)).sort((x, y) => y.mem_mb - x.mem_mb);
    return { total: all.length, processes: all.slice(0, a.limit ?? 50) };
  },
};

export const terminateProcess: Tool<{ pid: number }> = {
  name: 'terminate_process',
  description: 'Terminate a process by pid.',
  parameters: { type: 'object', properties: { pid: { type: 'integer', minimum: 1 } }, required: ['pid'] },
  risk: 'high',
  target: (a) => `PID ${a.pid}`,
  detail: async (a, c) => {
    const p = (await listProcesses(c)).find((x) => x.pid === a.pid);
    return p ? `Process: ${p.name} (${p.mem_mb} MB). Unsaved work in it will be lost.` : 'No process with that pid was found.';
  },
  precheck(a) {
    if (a.pid <= 4 || a.pid === process.pid || a.pid === process.ppid) throw new KappaError('protected', `Refusing to terminate PID ${a.pid}.`);
  },
  async run(a) {
    process.kill(a.pid);
    return { terminated: a.pid };
  },
};

// --- open_application -------------------------------------------------------------------------------------------
// Opening is not a back door around execute_script: scripts/installers are refused here, and shells only open without arguments.
const SCRIPT_EXT = /\.(bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|reg|scr|com|pif|cpl|jar|sh)$/i;
const SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'bash', 'sh', 'zsh', 'wsl', 'python', 'python3', 'py', 'node']);
const BAD_SCHEMES = new Set(['file', 'javascript', 'vbscript', 'data', 'ms-msdt', 'search-ms', 'ms-officecmd']);
const isUrl = (t: string) => /^[a-z][a-z0-9+.-]+:/i.test(t) && !/^[a-z]:[\\/]/i.test(t); // "C:\x" is a path, "spotify:track:1" is a URL
const isPath = (t: string) => /[\\/]/.test(t) || /^(~|\.{1,2}$)/.test(t) || /^[a-z]:/i.test(t);
const enoent = (e: unknown) => (e as { code?: string })?.code === 'ENOENT';

/** Finds a Start-menu app (classic or Store) when the name is not a program on PATH, e.g. "spotify", "whatsapp", "visual studio code". */
const OPEN_PS = String.raw`$t = $env:KAPPA_TARGET
$a = @($env:KAPPA_ARGS | ConvertFrom-Json | ForEach-Object { if ("$_" -match '[\s"]') { '"' + ("$_" -replace '"', '\"') + '"' } else { "$_" } })
function Go($f) { if ($a.Count) { Start-Process -FilePath $f -ArgumentList $a } else { Start-Process -FilePath $f } }
try { Go $t; ConvertTo-Json -Compress @{ ok = $true; via = 'start-process' }; exit } catch { $first = $_.Exception.Message }
$pat = '*' + [WildcardPattern]::Escape($t) + '*'
$apps = @(Get-StartApps | Where-Object { $_.Name -like $pat } | Sort-Object { $_.Name.Length })
if ($apps.Count -eq 0) { throw "No app named '$t' was found in the Start menu ($first)" }
$exact = @($apps | Where-Object { $_.Name -eq $t })
$pick = if ($exact.Count) { $exact[0] } else { $apps[0] }
Start-Process ('shell:AppsFolder\' + $pick.AppID)
ConvertTo-Json -Compress @{ ok = $true; via = 'start-menu'; app = $pick.Name; other_matches = @($apps | Where-Object { $_.Name -ne $pick.Name } | Select-Object -First 4 | ForEach-Object { $_.Name }) }`;

function resolveLocal(t: string, c: ToolCtx): string {
  const expanded = t === '~' || /^~[\\/]/.test(t) ? path.join(os.homedir(), t.slice(1)) : t;
  return path.resolve(c.cfg.cwd, expanded);
}

export const openApplication: Tool<{ target: string; args?: string[] }> = {
  name: 'open_application',
  description: 'Open an app by name (e.g. "spotify", "notepad"), or a file, folder or URL with its default app. Not for running scripts.',
  parameters: {
    type: 'object',
    properties: { target: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['target'],
  },
  risk: 'approval',
  target: (a) => [a.target, ...(a.args ?? [])].join(' '),
  precheck(a, c) {
    const t = a.target.trim();
    if (!t || t.includes('\0')) throw new KappaError('bad_args', 'target is empty');
    if (isUrl(t)) {
      const scheme = t.slice(0, t.indexOf(':')).toLowerCase();
      if (BAD_SCHEMES.has(scheme)) throw new KappaError('protected', `Refusing to open ${scheme}: links.`);
      return;
    }
    if (isPath(t) && isDenied(resolveLocal(t, c))) throw new KappaError('path_denied', `Access to ${t} is blocked: it looks like a credential or secret.`);
    if (SCRIPT_EXT.test(t)) throw new KappaError('protected', 'Scripts and installers are not opened with open_application. Use create_script and execute_script, which show the code first.');
    const base = t.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
    if (SHELLS.has(base) && a.args?.length) throw new KappaError('protected', `${base} cannot be opened with arguments. Use create_script and execute_script to run commands.`);
  },
  async run(a, c) {
    const args = a.args ?? [];
    const t = a.target.trim();
    const url = isUrl(t);
    const local = !url && isPath(t);
    const target = local ? resolveLocal(t, c) : t;
    if (local) await fs.access(target).catch(() => { throw new KappaError('not_found', `${target} does not exist.`); });

    if (win()) {
      if (url && /^https?:/i.test(t)) { await sh(c, 'rundll32', ['url.dll,FileProtocolHandler', t]); return { opened: t }; } // fast path: default browser, no PowerShell
      if (!url) {
        try { await c.launch(target, args); return { opened: target }; } catch { /* not a program on PATH: documents, folders, .cmd shims, App Paths, Store apps */ }
      }
      let r: { via?: string; app?: string; other_matches?: string[] } = {};
      try { r = JSON.parse(await ps(c, OPEN_PS, { KAPPA_TARGET: target, KAPPA_ARGS: JSON.stringify(args) })); } catch (e) { if (e instanceof KappaError) throw e; }
      return { opened: r.app ?? target, via: r.via, ...(r.other_matches?.length ? { other_matches: r.other_matches } : {}) };
    }

    if (process.platform === 'darwin') {
      if (!url && !local) { await sh(c, 'open', ['-a', target, ...(args.length ? ['--args', ...args] : [])]); return { opened: target }; } // exits non-zero if no such app
      if (args.length && local) { await sh(c, 'open', ['-a', target, '--args', ...args]); return { opened: target }; }
      await sh(c, 'open', [target]);
      return { opened: target };
    }

    // Linux and others: spawn() only reports that the process started, so a missing program is the one failure we can see.
    const exe = local && args.length ? true : local && (await fs.stat(target).then((s) => s.isFile() && (s.mode & 0o111) !== 0, () => false));
    if (url || (local && !exe)) {
      try { await c.launch('xdg-open', [target]); } catch (e) { throw new KappaError('failed', enoent(e) ? 'xdg-open is not installed, so files and links cannot be opened.' : `Could not open ${target}.`); }
      return { opened: target };
    }
    const names = local ? [target] : [...new Set([t, t.toLowerCase(), t.toLowerCase().replace(/\s+/g, '-')])];
    for (const n of names) {
      try { await c.launch(n, args); return { opened: n }; } catch (e) { if (!enoent(e)) throw new KappaError('failed', `Could not start ${n}.`); }
    }
    throw new KappaError('not_found', `No program named "${t}" was found on PATH.`);
  },
};

const WINDOW_PS = `[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -Namespace K -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int c); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'
$t = $env:KAPPA_TITLE; $act = $env:KAPPA_ACTION
$all = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ pid = $_.Id; name = $_.ProcessName; title = $_.MainWindowTitle; h = $_.MainWindowHandle } })
$m = @($all | Where-Object { -not $t -or $_.title.IndexOf($t, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
if ($act -eq 'list') { ConvertTo-Json -InputObject @($m | Select-Object pid, name, title) -Compress; exit }
if ($m.Count -ne 1) { ConvertTo-Json -InputObject @{ error = "expected exactly 1 matching window, found $($m.Count)"; matches = @($m | Select-Object pid, name, title) } -Compress; exit }
$h = [IntPtr]$m[0].h
switch ($act) {
  'minimize' { [K.W]::ShowWindowAsync($h, 6) | Out-Null }
  'maximize' { [K.W]::ShowWindowAsync($h, 3) | Out-Null }
  'restore'  { [K.W]::ShowWindowAsync($h, 9) | Out-Null }
  'focus'    { [K.W]::ShowWindowAsync($h, 9) | Out-Null; [K.W]::SetForegroundWindow($h) | Out-Null }
  'close'    { (Get-Process -Id $m[0].pid).CloseMainWindow() | Out-Null }
}
ConvertTo-Json -InputObject @{ ok = $true; action = $act; window = $m[0].title } -Compress`;

export const manageWindow: Tool<{ action: string; title_contains?: string }> = {
  name: 'manage_window',
  description: 'List windows, or focus/minimize/maximize/restore/close the one whose title contains title_contains (Windows only).',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close'] },
      title_contains: { type: 'string' },
    },
    required: ['action'],
  },
  risk: (a) => (a.action === 'list' ? 'low' : 'approval'),
  target: (a) => `${a.action} ${a.title_contains ?? ''}`.trim(),
  async run(a, c) {
    if (!win()) throw new KappaError('unsupported', 'manage_window is only implemented on Windows.');
    if (a.action !== 'list' && !a.title_contains) throw new KappaError('bad_args', 'title_contains is required for this action');
    const out = JSON.parse(await ps(c, WINDOW_PS, { KAPPA_ACTION: a.action, KAPPA_TITLE: a.title_contains ?? '' }));
    if (out?.error) throw new KappaError('window_error', `${out.error}: ${JSON.stringify(out.matches)}`);
    return out;
  },
};

export const systemPower: Tool<{ action: 'shutdown' | 'restart' | 'cancel'; delay_seconds?: number }> = {
  name: 'system_power',
  description: 'Shut down or restart the PC after a delay (default 30s), or cancel a pending one.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['shutdown', 'restart', 'cancel'] },
      delay_seconds: { type: 'integer', minimum: 0, maximum: 3600 },
    },
    required: ['action'],
  },
  risk: (a) => (a.action === 'cancel' ? 'low' : 'high'),
  target: (a) => (a.action === 'cancel' ? 'cancel pending shutdown' : `${a.action} this computer in ${a.delay_seconds ?? 30}s`),
  detail: (a) => (a.action === 'cancel' ? '' : 'Unsaved work in open applications will be lost.'),
  async run(a, c) {
    const delay = a.delay_seconds ?? 30;
    let args: string[];
    if (win()) args = a.action === 'cancel' ? ['/a'] : [a.action === 'shutdown' ? '/s' : '/r', '/t', String(delay)];
    else if (a.action === 'cancel') args = ['-c'];
    else args = [a.action === 'shutdown' ? '-h' : '-r', delay === 0 ? 'now' : `+${Math.ceil(delay / 60)}`]; // shortcut: POSIX path untested, minute granularity
    await sh(c, 'shutdown', args);
    return { ok: true, action: a.action, delay_seconds: a.action === 'cancel' ? undefined : delay, note: a.action === 'cancel' ? undefined : 'Run system_power with action=cancel to abort.' };
  },
};

export const systemTools = [getSystemInfo, inspectProcesses, terminateProcess, openApplication, manageWindow, systemPower];