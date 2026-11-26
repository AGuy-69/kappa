import fs from 'node:fs';
import { KappaError } from '../../util/errors.ts';
import type { Spawn } from '../process.ts';

export const GROQ_STT_URL = 'https://api.groq.com/openai/v1';
export const GROQ_STT_MODEL = 'whisper-large-v3-turbo';

/** Whisper writes tags like [BLANK_AUDIO], [ Silence ] or (music) for non-speech: they are not what the user said. */
export function cleanTranscript(t: string): string {
  return t.replace(/\[[^\]]{1,30}\]/g, ' ').replace(/\((?:music|silence|noise|applause|laughter)[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
}

export async function groqTranscribe(o: { fetch: typeof fetch; key: string; baseUrl: string; model: string; language?: string }, wav: string, signal?: AbortSignal): Promise<string> {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'speech.wav');
  form.append('model', o.model);
  form.append('response_format', 'json');
  form.append('temperature', '0');
  if (o.language) form.append('language', o.language);
  let res: Response;
  try {
    res = await o.fetch(`${o.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${o.key}` },
      body: form,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
  } catch (e) {
    if (signal?.aborted) throw e;
    throw new KappaError('stt_failed', `Could not reach the speech service: ${(e as Error).message}`);
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200);
    const hint = res.status === 401 ? ' (check GROQ_API_KEY)' : res.status === 429 ? ' (rate limited: wait a moment)' : '';
    throw new KappaError('stt_failed', `Speech-to-text answered ${res.status}${hint}: ${body}`);
  }
  const json = (await res.json().catch(() => ({}))) as { text?: string };
  return cleanTranscript(json.text ?? '');
}

/** whisper.cpp: offline. -nt drops timestamps and -np drops its progress chatter, so stdout is only the words. */
export function whisperTranscribe(o: { spawn: Spawn; path: string; model: string; language?: string }, wav: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['-m', o.model, '-f', wav, '-nt', '-np', ...(o.language ? ['-l', o.language] : [])];
    let out = '';
    let err = '';
    let child;
    try { child = o.spawn(o.path, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { return reject(new KappaError('stt_unavailable', `Could not start ${o.path}: ${(e as Error).message}`)); }
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.on('data', (d) => { out += String(d); });
    child.stderr?.on('data', (d) => { if (err.length < 1000) err += String(d); });
    child.on('error', (e) => reject(new KappaError('stt_unavailable', (e as { code?: string }).code === 'ENOENT' ? `${o.path} was not found. Set KAPPA_WHISPER_PATH to whisper-cli (whisper.cpp).` : `Could not start ${o.path}: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new KappaError('cancelled', 'Cancelled.'));
      code === 0 ? resolve(cleanTranscript(out)) : reject(new KappaError('stt_failed', `whisper.cpp stopped with code ${code}: ${err.trim().slice(0, 300)}`));
    });
  });
}
