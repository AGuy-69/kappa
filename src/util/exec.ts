import { spawn } from 'node:child_process';

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number; // per stream
  input?: string; // written to the program's stdin, then closed
}
export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
}
/** Starts a program detached and returns once it has actually started; does not wait for it to exit. Rejects if it cannot be started. */
export type Launch = (cmd: string, args: string[]) => Promise<void>;
export const launch: Launch = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    p.once('error', reject);
    p.once('spawn', () => { p.unref(); resolve(); });
  });

export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<ExecResult>;

// Runs a program (never through a shell) with a timeout, an output cap and whole-process-tree kill.
// Rejects only if the program cannot be started.
export const exec: Exec = (cmd, args, o = {}) =>
  new Promise((resolve, reject) => {
    const max = o.maxBytes ?? 1_000_000;
    const win = process.platform === 'win32';
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env ?? process.env,
      windowsHide: true,
      stdio: [o.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      detached: !win, // own process group so we can kill the whole tree on POSIX
    });
    const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
    const size = { out: 0, err: 0 };
    let truncated = false, timedOut = false, aborted = false;

    const collect = (k: 'out' | 'err') => (d: Buffer) => {
      if (size[k] < max) chunks[k].push(d.subarray(0, max - size[k]));
      if (size[k] + d.length > max) truncated = true;
      size[k] += d.length;
    };
    if (o.input !== undefined) { child.stdin!.on('error', () => {}); child.stdin!.end(o.input); } // EPIPE if the program exits early is fine
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));

    const kill = () => {
      if (child.pid === undefined) return;
      if (win) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, o.timeoutMs) : undefined;
    const onAbort = () => { aborted = true; kill(); };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: Buffer.concat(chunks.out).toString('utf8'),
        stderr: Buffer.concat(chunks.err).toString('utf8'),
        timedOut, aborted, truncated,
      });
    });
  });
  