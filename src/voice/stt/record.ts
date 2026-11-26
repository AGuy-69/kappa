import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KappaError } from '../../util/errors.ts';
import type { Spawn } from '../process.ts';

export interface RecordOptions {
  spawn: Spawn;
  platform: NodeJS.Platform;
  ffmpegPath: string;
  mic?: string;
  maxSeconds: number;
}

const MIN_BYTES = 6_000; // 16 kHz mono 16-bit is 32 KB/s, so this is about 0.2 s: anything shorter is a stray keypress

const missing = (cmd: string) => new KappaError('stt_unavailable', `${cmd} is not installed or not on PATH. Recording needs ffmpeg: on Windows run "winget install Gyan.FFmpeg", on macOS "brew install ffmpeg", on Linux "sudo apt install ffmpeg", then open a new terminal.`);

/** Runs ffmpeg to the end and returns what it printed on stderr (device listings go there, and the command "fails" by design). */
function ffmpegText(o: RecordOptions, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let child: ChildProcess;
    try { child = o.spawn(o.ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }); } catch { return reject(missing(o.ffmpegPath)); }
    child.stderr?.on('data', (d) => { if (out.length < 200_000) out += String(d); });
    child.on('error', (e) => reject((e as { code?: string }).code === 'ENOENT' ? missing(o.ffmpegPath) : new KappaError('stt_failed', `Could not start ${o.ffmpegPath}: ${e.message}`)));
    child.on('close', () => resolve(out));
  });
}

/** Pulls microphone names out of `ffmpeg -list_devices true -f dshow -i dummy`. Handles the old and the new output format. */
export function parseDshowAudioDevices(text: string): string[] {
  const tagged = [...text.matchAll(/"([^"]+)"\s+\(audio\)/g)].map((m) => m[1]);
  if (tagged.length) return tagged;
  const i = text.indexOf('DirectShow audio devices');
  if (i < 0) return [];
  return [...text.slice(i).matchAll(/^\[dshow[^\]]*\]\s+"([^"]+)"\s*$/gm)].map((m) => m[1]);
}

async function inputArgs(o: RecordOptions): Promise<string[]> {
  if (o.platform === 'win32') {
    let mic = o.mic;
    if (!mic) {
      const devices = parseDshowAudioDevices(await ffmpegText(o, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']));
      if (!devices.length) throw new KappaError('stt_no_mic', 'No microphone was found. Plug one in, or set KAPPA_MIC to its name (see: ffmpeg -list_devices true -f dshow -i dummy).');
      mic = devices[0];
    }
    return ['-f', 'dshow', '-i', `audio=${mic}`];
  }
  if (o.platform === 'darwin') return ['-f', 'avfoundation', '-i', `:${o.mic ?? '0'}`];
  return ['-f', 'pulse', '-i', o.mic ?? 'default'];
}

/** A recording in progress: ffmpeg writing 16 kHz mono WAV to a private temp folder. */
export class MicRecording {
  readonly wav: string;
  private dir: string;
  private child!: ChildProcess;
  private exit: Promise<{ code: number | null; err: string }>;
  private finished = false;

  private constructor(dir: string) {
    this.dir = dir;
    this.wav = path.join(dir, 'speech.wav');
    this.exit = Promise.resolve({ code: 0, err: '' });
  }

  static async begin(o: RecordOptions): Promise<MicRecording> {
    const input = await inputArgs(o);
    const rec = new MicRecording(fs.mkdtempSync(path.join(os.tmpdir(), 'kappa-stt-')));
    try {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', ...input, '-ac', '1', '-ar', '16000', '-t', String(o.maxSeconds), '-c:a', 'pcm_s16le', rec.wav];
      rec.child = o.spawn(o.ffmpegPath, args, { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true });
      rec.exit = new Promise((resolve) => {
        let err = '';
        rec.child.stderr?.on('data', (d) => { if (err.length < 2000) err += String(d); });
        rec.child.stdin?.on('error', () => {});
        rec.child.on('error', (e) => resolve({ code: -1, err: (e as { code?: string }).code === 'ENOENT' ? 'ENOENT' : e.message }));
        rec.child.on('close', (code) => resolve({ code, err }));
      });
    } catch {
      rec.discard();
      throw missing(o.ffmpegPath);
    }
    // A bad device or a missing program fails within a moment: report that now, not after the user has spoken.
    const early = await Promise.race([rec.exit, new Promise<null>((r) => setTimeout(() => r(null), 400))]);
    if (early && early.code !== 0) {
      rec.discard();
      throw early.err === 'ENOENT' ? missing(o.ffmpegPath) : new KappaError('stt_failed', `The microphone could not be opened: ${early.err.trim().slice(0, 300) || `ffmpeg exited with code ${early.code}`}`);
    }
    return rec;
  }

  /** Ends the recording ('q' lets ffmpeg finish the WAV header properly) and returns the audio file. The caller must call discard(). */
  async finish(): Promise<string> {
    if (!this.finished) {
      this.finished = true;
      try { this.child.stdin?.write('q'); this.child.stdin?.end(); } catch { /* already gone */ }
      const killer = setTimeout(() => this.child.kill(), 4000);
      const { code, err } = await this.exit;
      clearTimeout(killer);
      if (code !== 0 && code !== null && !fs.existsSync(this.wav)) throw new KappaError('stt_failed', `Recording failed: ${err.trim().slice(0, 300) || `ffmpeg exited with code ${code}`}`);
    }
    const size = fs.existsSync(this.wav) ? fs.statSync(this.wav).size : 0;
    if (size < MIN_BYTES) throw new KappaError('stt_empty', 'Nothing was recorded (too short). Press Enter, speak, then press Enter again.');
    return this.wav;
  }

  /** Stops ffmpeg without waiting and deletes the audio. */
  discard(): void {
    this.finished = true;
    try { this.child?.kill(); } catch { /* already gone */ }
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

