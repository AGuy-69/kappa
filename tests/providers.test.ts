import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GEMINI_URL, loadConfig, useProvider } from '../src/config.ts';
import { createGroq } from '../src/llm/groq.ts';
import type { Msg } from '../src/llm/groq.ts';

test('providers: both keys configured, first one is active, /provider switches everything the client reads', () => {
  const cfg = loadConfig({ GROQ_API_KEY: 'g-key', GEMINI_API_KEY: 'm-key' });
  assert.deepEqual(Object.keys(cfg.providers), ['groq', 'gemini']);
  assert.deepEqual([cfg.provider, cfg.apiKey, cfg.model], ['groq', 'g-key', 'openai/gpt-oss-120b']);
  assert.equal(useProvider(cfg, 'gemini'), true);
  assert.deepEqual([cfg.provider, cfg.apiKey, cfg.baseUrl, cfg.model], ['gemini', 'm-key', GEMINI_URL, 'gemini-3.7-flash']);
  assert.equal(useProvider(cfg, 'nope'), false);
  assert.equal(cfg.provider, 'gemini', 'an unknown name changes nothing');
});

test('providers: KAPPA_PROVIDER, per-provider models, gemini-only and no-key setups', () => {
  const both = { GROQ_API_KEY: 'g', GEMINI_API_KEY: 'm', KAPPA_GEMINI_MODEL: 'gemini-x', KAPPA_GROQ_MODEL: 'groq-x' };
  const c = loadConfig({ ...both, KAPPA_PROVIDER: 'gemini' });
  assert.deepEqual([c.provider, c.model], ['gemini', 'gemini-x']);
  assert.equal(loadConfig(both).model, 'groq-x');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'm' }).provider, 'gemini');
  assert.equal(loadConfig({ GEMINI_API_KEY: 'm', KAPPA_PROVIDER: 'groq' }).provider, 'gemini', 'an unavailable choice falls back to what exists');
  const none = loadConfig({});
  assert.deepEqual([none.provider, none.apiKey], ['', '']);
});

test('providers: legacy single-server setup (GROQ_BASE_URL + GROQ_API_KEY + KAPPA_MODEL) still works', () => {
  const c = loadConfig({ GROQ_API_KEY: 'k', GROQ_BASE_URL: 'http://localhost:9/v1', KAPPA_MODEL: 'my-combo' });
  assert.deepEqual([c.baseUrl, c.model, c.apiKey], ['http://localhost:9/v1', 'my-combo', 'k']);
});

test('switching providers changes where the next request goes, and Gemini extras are not sent to Groq', async () => {
  const cfg = loadConfig({ GROQ_API_KEY: 'g-key', GEMINI_API_KEY: 'm-key' });
  const seen: { url: string; auth: string; body: any }[] = [];
  const f = (async (u: any, i: any) => (seen.push({ url: String(u), auth: i.headers.authorization, body: JSON.parse(i.body) }), new Response('data: [DONE]\n\n'))) as typeof fetch;
  const llm = createGroq(cfg, { fetch: f }); // one client; it reads cfg at call time
  const history: Msg[] = [{ role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' }, extra_content: { google: { thought_signature: 'S' } } }] }, { role: 'tool', tool_call_id: 'a', content: '{}' }];
  await llm.chat({ model: cfg.model, messages: history, tools: [] });
  useProvider(cfg, 'gemini');
  await llm.chat({ model: cfg.model, messages: history, tools: [] });
  assert.deepEqual(seen.map((s) => [s.url.split('/chat')[0], s.auth]), [['https://api.groq.com/openai/v1', 'Bearer g-key'], [GEMINI_URL.replace(/\/$/, ''), 'Bearer m-key']]);
  assert.equal(seen[0].body.messages[0].tool_calls[0].extra_content, undefined);
  assert.deepEqual(seen[1].body.messages[0].tool_calls[0].extra_content, { google: { thought_signature: 'S' } });
  assert.equal(history[0].tool_calls![0].extra_content !== undefined, true, 'the stored history is untouched');
});