import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGroq } from '../src/llm/groq.ts';

const sse = (...e: unknown[]) => e.map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`).join('');
const res = (text: string) => new Response(text);
const delta = (d: object, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
const cfg = { apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' };

test('gemini: parallel tool calls that carry no `index` stay separate, and thought signatures are kept', async () => {
  const body = sse(
    // Gemini-style: whole calls per chunk, no index, signature on the first call only
    delta({ tool_calls: [{ id: 'a1', type: 'function', function: { name: 'list_directory', arguments: '{"path":"."}' }, extra_content: { google: { thought_signature: 'SIG123' } } }] }),
    delta({ tool_calls: [{ id: 'b2', type: 'function', function: { name: 'get_system_info', arguments: '{}' } }] }),
    delta({}, 'tool_calls'),
    '[DONE]',
  );
  const r = await createGroq(cfg, { fetch: async () => res(body) }).chat({ model: 'gemini-3.7-flash', messages: [], tools: [] });
  assert.deepEqual(r.tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]), [['a1', 'list_directory', '{"path":"."}'], ['b2', 'get_system_info', '{}']]);
  assert.deepEqual(r.tool_calls[0].extra_content, { google: { thought_signature: 'SIG123' } });
  assert.equal(r.tool_calls[1].extra_content, undefined);
});

test('gemini: the signature is sent back verbatim on the next request, and the base URL slash is handled', async () => {
  const urls: string[] = [];
  const bodies: any[] = [];
  const f = (async (u: any, i: any) => (urls.push(String(u)), bodies.push(JSON.parse(i.body)), res(sse(delta({ content: 'ok' }, 'stop'), '[DONE]')))) as typeof fetch;
  const call = { id: 'a1', type: 'function' as const, function: { name: 'x', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG123' } } };
  await createGroq(cfg, { fetch: f }).chat({
    model: 'gemini-3.7-flash', tools: [],
    messages: [{ role: 'assistant', content: null, tool_calls: [call] }, { role: 'tool', tool_call_id: 'a1', content: '{}' }],
  });
  assert.equal(urls[0], 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.deepEqual(bodies[0].messages[0].tool_calls[0].extra_content, { google: { thought_signature: 'SIG123' } });
  assert.equal(bodies[0].reasoning_effort, undefined, 'gpt-oss-only parameter is not sent to Gemini');
});

test('index-based streams (Groq/OpenAI style) still assemble fragmented calls', async () => {
  const body = sse(
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a"}' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_directory', arguments: '{}' } }] }),
    '[DONE]',
  );
  const r = await createGroq(cfg, { fetch: async () => res(body) }).chat({ model: 'm', messages: [], tools: [] });
  assert.deepEqual(r.tool_calls.map((c) => [c.id, c.function.name, c.function.arguments]), [['c1', 'read_file', '{"path":"a"}'], ['c2', 'list_directory', '{}']]);
});