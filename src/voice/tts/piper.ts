import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KappaError } from '../../util/errors.ts';
import { start } from '../process.ts';
import type { Running, Spawn } from '../process.ts';
import { cleanForSpeech, splitSentences } from '../speech-text.ts';
import type { Speaker } from '../types.ts';

/** Piper: offline neural voices (pick a female one such as en_US-amy-medium or en_GB-jenny_dioco-medium). Synthesizes the next sentence while the current one plays. */
export class PiperSpeaker implements Speaker {
  readonly name = 'piper';
  private gen = 0;
  private live = new Set<Running>();
  private active = 0;
  private o: { platform: NodeJS.Platform; spawn: Spawn; piperPath: string; piperModel: string; rate: number; maxChars: number };

  constructor(o: { platform: NodeJS.Platform; spawn: Spawn; piperPath: string; piperModel: string; rate: number; maxChars: number }) {
    this.o = o;
  }

  get speaking() { return this.active > 0; }

  private run(cmd: string, args: string[], o: { input?: string; env?: Record<string, string> } = {}): Running {
    const r = start(this.o.spawn, cmd, args, { input: o.input, env: o.env ? { ...process.env, ...o.env } : undefined });
    this.live.add(r);
    r.done.finally(() => this.live.delete(r)).catch(() => {});
    return r;
  }

  private synth(text: string, wav: string): Promise<void> {
    // length_scale > 1 is slower; rate -10..10 maps to about 1.5..0.67
    const scale = (1.5 ** (-this.o.rate / 10)).toFixed(2);
    return this.run(this.o.piperPath, ['--model', this.o.piperModel, '--length_scale', scale, '--output_file', wav], { input: text }).done;
  }

  private async play(wav: string): Promise<void> {
    const { platform } = this.o;
    if (platform === 'win32') {
      await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:KAPPA_WAV).PlaySync()'], { env: { KAPPA_WAV: wav } }).done;
    } else if (platform === 'darwin') {
      await this.run('afplay', [wav]).done;
    } else {
      try { await this.run('paplay', [wav]).done; } catch (e) {
        if (!(e instanceof KappaError) || e.code !== 'tts_unavailable') throw e;
        await this.run('aplay', ['-q', wav]).done;
      }
    }
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    this.stop();
    const gen = this.gen;
    const chunks = splitSentences(cleanForSpeech(text, this.o.maxChars));
    if (!chunks.length || signal?.aborted) return;
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kappa-tts-'));
    const wav = (i: number) => path.join(dir, `${i}.wav`);
    this.active++;
    try {
      let next = this.synth(chunks[0], wav(0));
      for (let i = 0; i < chunks.length; i++) {
        await next;
        if (this.gen !== gen) return; // stop() was called
        if (i + 1 < chunks.length) { next = this.synth(chunks[i + 1], wav(i + 1)); next.catch(() => {}); }
        await this.play(wav(i));
        if (this.gen !== gen) return;
      }
    } finally {
      this.active--;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  stop(): void {
    this.gen++;
    for (const r of this.live) r.kill();
  }
}
