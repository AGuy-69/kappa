import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { KappaError } from '../util/errors.ts';

export type Spawn = typeof nodeSpawn;
export const realSpawn: Spawn = nodeSpawn;

export interface Running {
  /** Resolves on a clean exit or after kill(); rejects with a KappaError if the program is missing or fails. */
  done: Promise<void>;
  kill(): void;
}

/** Starts a program that can be cut off at any moment (unlike exec(), which always waits for the end). */
export function start(spawn: Spawn, cmd: string, args: string[], o: { env?: Record<string, string | undefined>; input?: string } = {}): Running {
  let killed = false;
  let child: ChildProcess | undefined;
  const done = new Promise<void>((resolve, reject) => {
    let err = '';
    try {
      child = spawn(cmd, args, { stdio: [o.input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'], env: o.env ?? process.env, windowsHide: true });
    } catch (e) {
      return reject(new KappaError('tts_unavailable', `Could not start ${cmd}: ${(e as Error).message}`));
    }
    child.stderr?.on('data', (d) => { if (err.length < 1000) err += String(d); });
    child.on('error', (e) => reject(new KappaError('tts_unavailable', (e as { code?: string }).code === 'ENOENT' ? `${cmd} is not installed or not on PATH.` : `Could not start ${cmd}: ${e.message}`)));
    child.on('close', (code) => (code === 0 || killed ? resolve() : reject(new KappaError('tts_failed', `${cmd} stopped with code ${code}${err.trim() ? `: ${err.trim().slice(0, 300)}` : ''}`))));
    if (o.input !== undefined) {
      child.stdin?.on('error', () => {}); // EPIPE when the program is killed mid-write
      child.stdin?.end(o.input);
    }
  });
  return { done, kill: () => { killed = true; child?.kill(); } };
}
