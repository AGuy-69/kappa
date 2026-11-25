import { createHash } from 'node:crypto';
import { KappaError } from '../util/errors.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider extras that must be echoed back verbatim (Gemini 3 needs extra_content.google.thought_signature, or it answers 400). */
  extra_content?: unknown;
}
export interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface Reply {
  content: string;
  tool_calls: ToolCall[];
  finish_reason: string | null;
}
export interface ChatOpts {
  model: string;
  messages: Msg[];
  tools: unknown[];
  reasoning?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onRetry?: (message: string) => void; // called before waiting to retry a rate limit / server error
}
export interface LLM {
  chat(opts: ChatOpts): Promise<Reply>;
}

const sleepAbortable = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

async function readStream(res: Response, onText?: (s: string) => void): Promise<Reply> {
  const dec = new TextDecoder();
  let buf = '', content = '', finish: string | null = null;
  const calls: { id: string; name: string; args: string; extra?: unknown }[] = [];
  const handle = (line: string) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    const j = JSON.parse(data);
    if (j.error) throw new KappaError('llm_stream', j.error.message ?? 'Groq stream error');
    const ch = j.choices?.[0];
    if (!ch) return;
    if (ch.delta?.content) { content += ch.delta.content; onText?.(ch.delta.content); }
    for (const tc of ch.delta?.tool_calls ?? []) {
      // Some servers (Gemini) omit `index`: then a chunk that carries an id or name starts a new call, anything else continues the last.
      const idx = tc.index ?? (tc.id || tc.function?.name ? calls.length : Math.max(calls.length - 1, 0));
      const c = (calls[idx] ??= { id: '', name: '', args: '' });
      if (tc.extra_content) c.extra = tc.extra_content;
      if (tc.id) c.id = tc.id;
      if (tc.function?.name) c.name ||= tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };
  for await (const chunk of res.body!) {
    buf += dec.decode(chunk, { stream: true });
    for (let nl; (nl = buf.indexOf('\n')) >= 0; ) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf.trim());
  return {
    content,
    finish_reason: finish,
    tool_calls: calls.filter(Boolean).map((c, i) => ({
      id: c.id || `call_${Date.now().toString(36)}_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args },
      ...(c.extra ? { extra_content: c.extra } : {}),
    })),
  };
}

const isGemini = (url: string) => url.includes('generativelanguage.googleapis.com');
// Gemini's thought signatures mean nothing to other providers, and some reject unknown fields.
const dropExtras = (m: Msg): Msg => (m.tool_calls ? { ...m, tool_calls: m.tool_calls.map(({ extra_content: _x, ...c }) => c) } : m);

const isMistral = (url: string) => url.includes('mistral.ai');
// Mistral differs from the OpenAI format in two ways that break Kappa's history:
//  1. tool call ids must be exactly 9 letters/digits (ids from Groq/Gemini are longer), same mapping on the call and its result;
//  2. a tool result must not be followed directly by a user message (happens after a cancelled or step-limited request).
const mistralId = (id: string) => (/^[A-Za-z0-9]{9}$/.test(id) ? id : createHash('sha256').update(id).digest('hex').slice(0, 9));
export function toMistral(msgs: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (const raw of msgs) {
    let m = dropExtras(raw);
    if (m.role === 'assistant' && m.tool_calls) m = { ...m, content: m.content ?? '', tool_calls: m.tool_calls.map((c) => ({ ...c, id: mistralId(c.id) })) };
    if (m.role === 'tool' && m.tool_call_id) m = { ...m, tool_call_id: mistralId(m.tool_call_id) };
    if (m.role === 'user' && out.at(-1)?.role === 'tool') out.push({ role: 'assistant', content: 'Done.' });
    out.push(m);
  }
  return out;
}

const apiMessage = (body: string) => {
  try { const j = JSON.parse(body); return j.error?.message ?? j.message ?? body; } catch { return body; } // OpenAI/Groq nest it under error, Mistral does not
};

/** Groq through its OpenAI-compatible endpoint. fetch and sleep are injectable for tests. */
export function createGroq(
  cfg: { apiKey: string; baseUrl: string },
  deps: { fetch?: typeof fetch; sleep?: typeof sleepAbortable } = {},
): LLM {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? sleepAbortable;
  return {
    async chat(o) {
      for (let attempt = 0; ; attempt++) {
        const res = await doFetch(`${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: o.model,
            messages: isGemini(cfg.baseUrl) ? o.messages : isMistral(cfg.baseUrl) ? toMistral(o.messages) : o.messages.map(dropExtras),
            ...(o.tools.length ? { tools: o.tools, tool_choice: 'auto' } : {}),
            ...(o.model.startsWith('openai/gpt-oss') ? { reasoning_effort: o.reasoning ?? 'low' } : {}),
            stream: true,
            temperature: 0.2,
          }),
          signal: o.signal,
        });
        if (res.ok) return readStream(res, o.onText);
        const body = await res.text();
        // 429/5xx are transient; Groq's tool_use_failed means the model emitted a malformed call, a retry usually fixes it.
        const retryable = res.status === 429 || res.status >= 500 || body.includes('tool_use_failed');
        const wait = (Number(res.headers.get('retry-after')) || 2 ** attempt) * 1000;
        if (!retryable || attempt >= 3 || wait > 30_000) {
          // retry-after / x-ratelimit-* headers say which limit was hit and when it resets
          const rl = [...res.headers].filter(([k]) => /^(retry-after|x-ratelimit)/i.test(k)).map(([k, v]) => `${k}=${v}`).join(', ');
          throw new KappaError(`llm_http_${res.status}`, `LLM API ${res.status}: ${apiMessage(body).slice(0, 400)}${attempt ? ` (after ${attempt + 1} attempts)` : ''}${rl ? ` [${rl}]` : ''}`);
        }
        o.onRetry?.(`HTTP ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt + 1} of 3)`);
        await sleep(wait, o.signal);
      }
    },
  };
}