import { KappaError } from '../../util/errors.ts';
import { realSpawn } from '../process.ts';
import type { Speaker, TtsOptions } from '../types.ts';
import { ElevenSpeaker } from './eleven.ts';
import { PiperSpeaker } from './piper.ts';
import { SystemSpeaker } from './system.ts';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : 0));

const silent: Speaker = { name: 'off', speaking: false, speak: async () => {}, stop: () => {} };

/** The one function the rest of Kappa needs: createSpeaker(ttsOptionsFromEnv()). */
export function createSpeaker(o: TtsOptions = {}): Speaker {
  const provider = o.provider ?? 'auto';
  if (provider === 'off') return silent;
  const common = {
    platform: o.platform ?? process.platform,
    spawn: o.spawn ?? realSpawn,
    rate: clamp(o.rate ?? 0, -10, 10),
    maxChars: Math.max(50, o.maxChars ?? 1500),
  };
  if (provider === 'elevenlabs' || (provider === 'auto' && o.elevenKey)) {
    if (!o.elevenKey) throw new KappaError('tts_config', 'ElevenLabs needs ELEVENLABS_API_KEY.');
    return new ElevenSpeaker({ ...common, fetch: o.fetch ?? fetch, key: o.elevenKey, voice: o.elevenVoice || 'Lauren', voiceId: o.elevenVoiceId, model: o.elevenModel || 'eleven_flash_v2_5' });
  }
  if (provider === 'piper' || (provider === 'auto' && o.piperModel)) {
    if (!o.piperModel) throw new KappaError('tts_config', 'piper needs a voice file: set KAPPA_PIPER_MODEL to the .onnx path.');
    return new PiperSpeaker({ ...common, piperPath: o.piperPath ?? 'piper', piperModel: o.piperModel });
  }
  return new SystemSpeaker({ ...common, voice: o.voice || undefined });
}

/** KAPPA_TTS=auto|system|piper|elevenlabs|off, ELEVENLABS_API_KEY, KAPPA_ELEVEN_VOICE, KAPPA_ELEVEN_VOICE_ID, KAPPA_ELEVEN_MODEL, KAPPA_TTS_VOICE, KAPPA_TTS_RATE, KAPPA_TTS_MAX_CHARS, KAPPA_PIPER_PATH, KAPPA_PIPER_MODEL. */
export function ttsOptionsFromEnv(env: Record<string, string | undefined> = process.env): TtsOptions {
  const p = env.KAPPA_TTS?.trim().toLowerCase();
  if (p && !['auto', 'system', 'piper', 'elevenlabs', 'off'].includes(p)) throw new KappaError('tts_config', `KAPPA_TTS must be auto, system, piper, elevenlabs or off (got "${p}").`);
  return {
    provider: (p as TtsOptions['provider']) || undefined,
    voice: env.KAPPA_TTS_VOICE || undefined,
    rate: env.KAPPA_TTS_RATE ? Number(env.KAPPA_TTS_RATE) : undefined,
    maxChars: env.KAPPA_TTS_MAX_CHARS ? Number(env.KAPPA_TTS_MAX_CHARS) : undefined,
    piperPath: env.KAPPA_PIPER_PATH || undefined,
    piperModel: env.KAPPA_PIPER_MODEL || undefined,
    elevenKey: env.ELEVENLABS_API_KEY || undefined,
    elevenVoice: env.KAPPA_ELEVEN_VOICE || undefined,
    elevenVoiceId: env.KAPPA_ELEVEN_VOICE_ID || undefined,
    elevenModel: env.KAPPA_ELEVEN_MODEL || undefined,
  };
}
