import fs from 'node:fs';
import path from 'node:path';
import { KappaError } from '../../util/errors.ts';
import type { Spawn } from '../process.ts';
import type { Recording } from '../types.ts';

/** Handy (github.com/cjpais/Handy) is a separate offline dictation app: it records, transcribes and pastes the text into the focused window. Kappa only presses its start/stop button. */
export interface HandyOptions { spawn: Spawn; platform: NodeJS.Platform; handyPath?: string; env?: Record<string, string | undefined> }

export function findHandy(o: HandyOptions): string {
  if (o.handyPath) return o.handyPath;
  const e = o.env ?? process.env;
  const candidates =
    o.platform === 'win32' ? [path.join(e.ProgramFiles ?? 'C:\\Program Files', 'Handy', 'handy.exe'), path.join(e.LOCALAPPDATA ?? '', 'Handy', 'handy.exe'), path.join(e.LOCALAPPDATA ?? '', 'Programs', 'Handy', 'handy.exe')]
    : o.platform === 'darwin' ? ['/Applications/Handy.app/Contents/MacOS/Handy']
    : [];
  return candidates.find((c) => c && fs.existsSync(c)) ?? 'handy'; // otherwise hope it is on PATH
}

const notFound = () => new KappaError('stt_unavailable', 'Handy was not found. Install it ("winget install cjpais.Handy" on Windows, "brew install --cask handy" on macOS), open it once, or set KAPPA_HANDY_PATH to handy.exe.');

function run(o: HandyOptions, cmd: string, args: string[], capture = false): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try { child = o.spawn(cmd, args, { stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'], windowsHide: true }); } catch { return reject(notFound()); }
    const timer = setTimeout(() => child.kill(), 8000);
    child.stdout?.on('data', (d) => { out += String(d); });
    child.on('error', (e) => { clearTimeout(timer); reject((e as { code?: string }).code === 'ENOENT' ? notFound() : new KappaError('stt_failed', `Could not run ${cmd}: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/** The remote-control flags only reach a Handy that is already running (it sits in the system tray). */
async function isRunning(o: HandyOptions): Promise<boolean> {
  const r = o.platform === 'win32' ? await run(o, 'tasklist', ['/FI', 'IMAGENAME eq handy.exe', '/NH'], true) : await run(o, 'pgrep', ['-ix', 'handy'], true);
  return o.platform === 'win32' ? /handy\.exe/i.test(r.out) : r.code === 0;
}

export async function startHandy(o: HandyOptions): Promise<Recording> {
  const exe = findHandy(o);
  if (!(await isRunning(o).catch(() => true))) { // if we cannot tell, try anyway
    throw new KappaError('stt_unavailable', 'Handy is not running. Open Handy (it sits in the system tray), then try /listen again.');
  }
  await run(o, exe, ['--toggle-transcription']);
  let over = false;
  return {
    async stop() {
      if (!over) { over = true; await run(o, exe, ['--toggle-transcription']); } // stops recording; Handy then transcribes and types the text
      return '';
    },
    cancel() {
      if (!over) { over = true; void run(o, exe, ['--cancel']).catch(() => {}); }
    },
  };
}