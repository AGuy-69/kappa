import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listModels } from '../src/llm/models.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const cfg = { baseUrl: 'https://api.mistral.ai/v1/', apiKey: 'k' };

test('listModels: Mistral shape, with tool-support flags, sorted, correct URL and auth', async () => {
  let seen = { url: '', auth: '' };
  const f = (async (u: any, i: any) => (seen = { url: String(u), auth: i.headers.authorization }, json({ data: [
    { id: 'mistral-small-latest', capabilities: { function_calling: true } },
    { id: 'ministral-3b-2512', capabilities: { function_calling: false } },
  ] }))) as typeof fetch;
  assert.deepEqual(await listModels(cfg, f), [{ id: 'ministral-3b-2512', tools: false }, { id: 'mistral-small-latest', tools: true }]);
  assert.deepEqual(seen, { url: 'https://api.mistral.ai/v1/models', auth: 'Bearer k' });
});

test('listModels: Groq shape (no capabilities) and Gemini shape ("models/" prefix, "models" key)', async () => {
  assert.deepEqual(await listModels(cfg, (async () => json({ data: [{ id: 'openai/gpt-oss-120b' }] })) as typeof fetch), [{ id: 'openai/gpt-oss-120b' }]);
  assert.deepEqual(await listModels(cfg, (async () => json({ models: [{ name: 'models/gemini-3.7-flash' }] })) as typeof fetch), [{ id: 'gemini-3.7-flash' }]);
});

test('listModels: an HTTP error is reported with its status', async () => {
  await assert.rejects(listModels(cfg, (async () => json({ message: 'Unauthorized' }, 401)) as typeof fetch), /HTTP 401.*Unauthorized/);
});