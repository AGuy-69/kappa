import fs from 'node:fs';
import { KappaError } from '../../util/errors.ts';
import type { Listener, Recording, SttOptions } from '../types.ts';
import { realSpawn } from '../process.ts';
import { GROQ_STT_MODEL, GROQ_STT_URL, groqTranscribe, whisperTranscribe } from './engines.ts';
import { startHandy } from './handy.ts';
import { MicRecording } from './record.ts';

/** The one function the rest of Kappa needs: createListener(sttOptionsFromEnv()). Throws a KappaError when the settings cannot work. */
export function createListener(o: SttOptions = {}): Listener {
  const provider = o.provider ?? 'auto';
  if (provider === 'off') throw new KappaError('stt_config', 'Speech input is turned off (KAPPA_STT=off).');
  if (provider === 'handy') {
    const h = { spawn: o.spawn ?? realSpawn, platform: o.platform ?? process.platform, handyPath: o.handyPath };
    return { name: 'handy', pastes: true, start: () => startHandy(h) };
  }
  const useGroq = provider === 'groq' || (provider === 'auto' && Boolean(o.groqKey));
  if (useGroq && !o.groqKey) throw new KappaError('stt_config', 'Groq speech-to-text needs GROQ_API_KEY.');
  if (!useGroq && !o.whisperModel) throw new KappaError('stt_config', 'No speech recognizer is set up. Set GROQ_API_KEY (cloud, free tier) or KAPPA_WHISPER_MODEL to a whisper.cpp model (offline).');

  const spawn = o.spawn ?? realSpawn;
  const rec = {
    spawn,
    platform: o.platform ?? process.platform,
    ffmpegPath: o.ffmpegPath ?? 'ffmpeg',
    mic: o.mic,
    maxSeconds: Math.min(300, Math.max(3, o.maxSeconds ?? 60)),
  };
  const transcribe = useGroq
    ? (wav: string, signal?: AbortSignal) => groqTranscribe({ fetch: o.fetch ?? fetch, key: o.groqKey!, baseUrl: o.baseUrl ?? GROQ_STT_URL, model: o.model ?? GROQ_STT_MODEL, language: o.language }, wav, signal)
    : (wav: string, signal?: AbortSignal) => whisperTranscribe({ spawn, path: o.whisperPath ?? 'whisper-cli', model: o.whisperModel!, language: o.language }, wav, signal);

  return {
    name: useGroq ? 'groq' : 'whispercpp',
    async start(signal?: AbortSignal): Promise<Recording> {
      if (!useGroq && !fs.existsSync(o.whisperModel!)) throw new KappaError('stt_config', `Whisper model not found: ${o.whisperModel}`);
      const r = await MicRecording.begin(rec);
      signal?.addEventListener('abort', () => r.discard(), { once: true });
      return {
        async stop() {
          try { return await transcribe(await r.finish(), signal); } finally { r.discard(); } // the audio never outlives the transcription
        },
        cancel: () => r.discard(),
      };
    },
  };
}

/** KAPPA_STT=auto|groq|whispercpp|handy|off, KAPPA_HANDY_PATH, KAPPA_STT_MODEL, KAPPA_STT_LANGUAGE, KAPPA_STT_MAX_SECONDS, KAPPA_MIC, KAPPA_FFMPEG_PATH, KAPPA_WHISPER_PATH, KAPPA_WHISPER_MODEL, KAPPA_STT_BASE_URL. The key is GROQ_API_KEY. */
export function sttOptionsFromEnv(env: Record<string, string | undefined> = process.env): SttOptions {
  const p = env.KAPPA_STT?.trim().toLowerCase();
  if (p && !['auto', 'groq', 'whispercpp', 'handy', 'off'].includes(p)) throw new KappaError('stt_config', `KAPPA_STT must be auto, groq, whispercpp, handy or off (got "${p}").`);
  return {
    provider: (p as SttOptions['provider']) || undefined,
    groqKey: env.GROQ_API_KEY || undefined,
    baseUrl: env.KAPPA_STT_BASE_URL || undefined,
    model: env.KAPPA_STT_MODEL || undefined,
    language: env.KAPPA_STT_LANGUAGE || undefined,
    whisperPath: env.KAPPA_WHISPER_PATH || undefined,
    whisperModel: env.KAPPA_WHISPER_MODEL || undefined,
    handyPath: env.KAPPA_HANDY_PATH || undefined,
    ffmpegPath: env.KAPPA_FFMPEG_PATH || undefined,
    mic: env.KAPPA_MIC || undefined,
    maxSeconds: env.KAPPA_STT_MAX_SECONDS ? Number(env.KAPPA_STT_MAX_SECONDS) : undefined,
  };
}