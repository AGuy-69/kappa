import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MISTRAL_URL, loadConfig, useProvider } from '../src/config.ts';
import { createGroq, toMistral } from '../src/llm/groq.ts';
import type { Msg } from '../src/llm/groq.ts';

const history = (id: string): Msg[] => [
  { role: 'user', content: 'list my files' },
  { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'list_directory', arguments: '{}' }, extra_content: { google: { thought_signature: 'S' } } }] },
  { role: 'tool', tool_call_id: id, content: '{"entries":[]}' },
  { role: 'user', content: 'now something else' }, // e.g. after a cancelled request: tool result directly followed by a user message
];

test('mistral: tool call ids from other providers become 9 alphanumeric chars, identically on the call and its result', () => {
  for (const id of ['call_k3j2h1g0_0', 'HZRaIv7rHZRaIv7r', 'x']) {
    const out = toMistral(history(id));
    const callId = out[1].tool_calls![0].id;
    assert.match(callId, /^[A-Za-z0-9]{9}$/, id);
    assert.equal(out[2].tool_call_id, callId, 'the result still points at its call');
  }
  assert.equal(toMistral(history('abc123XYZ'))[1].tool_calls![0].id, 'abc123XYZ', 'a valid 9-char id (Mistral\'s own) is kept');
  assert.equal(toMistral(history('call_1'))[1].tool_calls![0].id, toMistral(history('call_1'))[1].tool_calls![0].id, 'deterministic');
});

test('mistral: a tool result followed by a user message gets an assistant message in between; other fields are cleaned', () => {
  const out = toMistral(history('call_1'));
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant', 'user']);
  assert.equal(out[3].content, 'Done.');
  assert.equal(out[1].content, '', 'null content becomes an empty string');
  assert.equal(out[1].tool_calls![0].extra_content, undefined, 'Gemini extras are not sent');
  // the normal flow (tool result, then the model answers) gets nothing inserted
  assert.deepEqual(toMistral(history('c').slice(0, 3)).map((m) => m.role), ['user', 'assistant', 'tool']);
});

test('mistral: the request goes to Mistral with the normalised history; stored history is untouched', async () => {
  const cfg = loadConfig({ MISTRAL_API_KEY: 'm-key' });
  const seen: { url: string; auth: string; body: any }[] = [];
  const f = (async (u: any, i: any) => (seen.push({ url: String(u), auth: i.headers.authorization, body: JSON.parse(i.body) }), new Response('data: [DONE]\n\n'))) as typeof fetch;
  const h = history('call_longid_123');
  await createGroq(cfg, { fetch: f }).chat({ model: cfg.model, messages: h, tools: [] });
  assert.equal(seen[0].url, `${MISTRAL_URL}/chat/completions`);
  assert.equal(seen[0].auth, 'Bearer m-key');
  assert.equal(seen[0].body.messages.length, 5);
  assert.equal(seen[0].body.stream_options, undefined);
  assert.equal(seen[0].body.max_tokens, undefined);
  assert.equal(h[1].tool_calls![0].id, 'call_longid_123');
});

test('config: MISTRAL_API_KEY adds a provider; it can be the only one, or be switched to', () => {
  const only = loadConfig({ MISTRAL_API_KEY: 'm' });
  assert.deepEqual([only.provider, only.model, only.baseUrl], ['mistral', 'mistral-small-latest', MISTRAL_URL]);
  const all = loadConfig({ GROQ_API_KEY: 'g', GEMINI_API_KEY: 'x', MISTRAL_API_KEY: 'm', KAPPA_MISTRAL_MODEL: 'mistral-small-latest' });
  assert.deepEqual(Object.keys(all.providers), ['groq', 'gemini', 'mistral']);
  assert.equal(all.provider, 'groq');
  assert.equal(useProvider(all, 'mistral'), true);
  assert.deepEqual([all.apiKey, all.model], ['m', 'mistral-small-latest']);
  assert.equal(loadConfig({ GROQ_API_KEY: 'g', MISTRAL_API_KEY: 'm', KAPPA_PROVIDER: 'mistral' }).provider, 'mistral');
});

test('a persistent 429 reports the attempts made and every rate-limit header the server sent', async () => {
  let calls = 0;
  const f = (async () => (calls++, new Response('{"object":"error","message":"Rate limit exceeded","code":"1300"}', {
    status: 429, headers: { 'x-ratelimit-limit-tokens-minute': '50000', 'x-ratelimit-remaining-tokens-minute': '0', 'content-type': 'application/json' },
  }))) as typeof fetch;
  const llm = createGroq({ apiKey: 'k', baseUrl: 'https://api.mistral.ai/v1' }, { fetch: f, sleep: async () => {} });
  await assert.rejects(llm.chat({ model: 'm', messages: [], tools: [] }), (e: any) => {
    assert.equal(e.code, 'llm_http_429');
    assert.match(e.message, /Rate limit exceeded \(after 4 attempts\) \[.*x-ratelimit-limit-tokens-minute=50000.*x-ratelimit-remaining-tokens-minute=0.*\]/);
    return true;
  });
  assert.equal(calls, 4);
});