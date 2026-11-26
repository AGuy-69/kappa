import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KappaError } from '../../util/errors.ts';
import { start } from '../process.ts';
import type { Running, Spawn } from '../process.ts';
import { cleanForSpeech, splitSentences } from '../speech-text.ts';
import type { Speaker } from '../types.ts';

const API = 'https://api.elevenlabs.io';
const RATE = 24_000; // output_format=pcm_24000: raw 16-bit mono little-endian samples

/** Wraps raw PCM in a WAV header so the operating system's own player can play it. */
export function pcmToWav(pcm: Buffer, rate = RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function apiError(res: Response, what: string): Promise<KappaError> {
  const body = (await res.text().catch(() => '')).slice(0, 200);
  const hint =
    res.status === 401 ? ' Check ELEVENLABS_API_KEY.'
    : res.status === 402 || res.status === 403 ? ' This voice or feature may need a paid ElevenLabs plan (library voices are often limited on the free plan).'
    : res.status === 429 ? ' Rate limited or out of credits: wait a moment, or check your ElevenLabs usage.'
    : '';
  return new KappaError('tts_failed', `ElevenLabs ${what} answered ${res.status}.${hint} ${body}`.trim());
}

/** Finds one voice by name in the account's voices. Exact name wins; several partial matches are listed so the user can pick an id. */
export async function findVoice(fetchFn: typeof fetch, key: string, name: string, signal?: AbortSignal): Promise<{ id: string; name: string }> {
  const res = await fetchFn(`${API}/v1/voices`, { headers: { 'xi-api-key': key }, signal });
  if (!res.ok) throw await apiError(res, 'voice list');
  const list = ((await res.json().catch(() => ({}))) as { voices?: { voice_id: string; name: string }[] }).voices ?? [];
  const want = name.trim().toLowerCase();
  const exact = list.filter((v) => v.name.trim().toLowerCase() === want);
  const hits = exact.length ? exact : list.filter((v) => v.name.toLowerCase().includes(want));
  if (hits.length === 1) return { id: hits[0].voice_id, name: hits[0].name };
  if (!hits.length) {
    throw new KappaError('tts_config', `No voice named "${name}" is in your ElevenLabs account. Add it from the Voice Library (elevenlabs.io, Voices) to My Voices, or set KAPPA_ELEVEN_VOICE_ID. Run "node src/voice/eleven-voices.ts" to see the voices you have.`);
  }
  throw new KappaError('tts_config', `Several voices match "${name}": ${hits.slice(0, 6).map((v) => `${v.name} (${v.voice_id})`).join(', ')}. Set KAPPA_ELEVEN_VOICE_ID to the one you want.`);
}

interface Opts { platform: NodeJS.Platform; spawn: Spawn; fetch: typeof fetch; key: string; voice: string; voiceId?: string; model: string; rate: number; maxChars: number }

/** ElevenLabs: cloud neural voices (default "Lauren"). Synthesizes the next sentences while the current one plays. */
export class ElevenSpeaker implements Speaker {
  readonly name = 'elevenlabs';
  private gen = 0;
  private active = 0;
  private ctl?: AbortController;
  private live = new Set<Running>();
  private id?: string;
  private o: Opts;

  constructor(o: Opts) {
    this.o = o;
    this.id = o.voiceId;
  }

  get speaking() { return this.active > 0; }

  private async synth(text: string, voiceId: string, signal: AbortSignal): Promise<Buffer> {
    // ElevenLabs has no speed setting that matches Kappa's -10..10 scale, so KAPPA_TTS_RATE is ignored here.
    const res = await this.o.fetch(`${API}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=pcm_24000`, {
      method: 'POST',
      headers: { 'xi-api-key': this.o.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: this.o.model }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    });
    if (!res.ok) throw await apiError(res, 'speech');
    return Buffer.from(await res.arrayBuffer());
  }

  private run(cmd: string, args: string[], env?: Record<string, string>): Running {
    const r = start(this.o.spawn, cmd, args, { env: env ? { ...process.env, ...env } : undefined });
    this.live.add(r);
    r.done.finally(() => this.live.delete(r)).catch(() => {});
    return r;
  }

  private async play(wav: string): Promise<void> {
    const { platform } = this.o;
    if (platform === 'win32') {
      await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(New-Object System.Media.SoundPlayer $env:KAPPA_WAV).PlaySync()'], { KAPPA_WAV: wav }).done;
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
    const chunks = splitSentences(cleanForSpeech(text, this.o.maxChars), 400);
    if (!chunks.length || signal?.aborted) return;
    const ctl = new AbortController();
    this.ctl = ctl;
    signal?.addEventListener('abort', () => this.stop(), { once: true });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kappa-tts-'));
    this.active++;
    try {
      this.id ??= (await findVoice(this.o.fetch, this.o.key, this.o.voice, ctl.signal)).id;
      const id = this.id;
      const fetchChunk = (i: number) => { const p = this.synth(chunks[i], id, ctl.signal); p.catch(() => {}); return p; };
      let next = fetchChunk(0);
      for (let i = 0; i < chunks.length; i++) {
        let pcm: Buffer;
        try { pcm = await next; } catch (e) { if (this.gen !== gen) return; throw e; }
        if (this.gen !== gen) return; // stop() was called
        if (i + 1 < chunks.length) next = fetchChunk(i + 1);
        const wav = path.join(dir, `${i}.wav`);
        fs.writeFileSync(wav, pcmToWav(pcm));
        await this.play(wav);
        if (this.gen !== gen) return;
      }
    } catch (e) {
      if (this.gen !== gen) return; // cut off on purpose, not a failure
      throw e;
    } finally {
      this.active--;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  stop(): void {
    this.gen++;
    this.ctl?.abort();
    for (const r of this.live) r.kill();
  }
}
