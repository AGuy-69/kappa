import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { trim } from '../src/agent/context.ts';
import { createGroq } from '../src/llm/groq.ts';
import type { Msg } from '../src/llm/groq.ts';
import { makePathValidator } from '../src/security/paths.ts';
import { authorize } from '../src/security/permissions.ts';
import { validate } from '../src/tools/registry.ts';
import type { Schema } from '../src/tools/registry.ts';

// ---------- schema validation ----------
const schema: Schema = {
  type: 'object',
  required: ['path'],
  properties: {
    path: { type: 'string' },
    n: { type: 'integer', minimum: 1, maximum: 10 },
    mode: { type: 'string', enum: ['a', 'b'] },
    tags: { type: 'array', items: { type: 'string' } },
  },
};
test('validate: accepts good arguments', () => assert.deepEqual(validate(schema, { path: 'x', n: 3, mode: 'a', tags: ['t'] }), []));
test('validate: reports every problem', () => {
  const e = validate(schema, { n: 1.5, mode: 'z', tags: [1], extra: true });
  assert.ok(e.includes('path: required'));
  assert.ok(e.some((x) => x.startsWith('n: expected integer')));
  assert.ok(e.some((x) => x.startsWith('mode: must be one of')));
  assert.ok(e.some((x) => x.startsWith('tags[0]: expected string')));
  assert.ok(e.includes('extra: unknown argument'));
});
test('validate: bounds and non-objects', () => {
  assert.ok(validate(schema, { path: 'x', n: 11 })[0].includes('<= 10'));
  assert.ok(validate(schema, { path: 'x', n: 0 })[0].includes('>= 1'));
  assert.deepEqual(validate(schema, [1]), ['arguments must be a JSON object']);
  assert.deepEqual(validate(schema, null), ['arguments must be a JSON object']);
});

// ---------- permission gate ----------
test('authorize: only an explicit true passes; missing/throwing/truthy-but-not-true approvers do not', async () => {
  const s = new AbortController().signal;
  const req = { tool: 't', risk: 'approval' as const, target: 'x' };
  assert.equal(await authorize({ ...req, risk: 'low' }, undefined, s), true);
  assert.equal(await authorize(req, undefined, s), false);
  assert.equal(await authorize(req, async () => true, s), true);
  assert.equal(await authorize(req, async () => false, s), false);
  assert.equal(await authorize(req, (async () => 'yes') as any, s), false);
  assert.equal(await authorize(req, async () => { throw new Error('boom'); }, s), false);
});

// ---------- path validation ----------
test('paths: roots, secrets, traversal and symlink escapes', (t) => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kappa-paths-')));
  const root = path.join(tmp, 'root');
  const other = path.join(tmp, 'other');
  fs.mkdirSync(root); fs.mkdirSync(other);
  const v = makePathValidator({ roots: [root], cwd: root });

  assert.equal(v('a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.equal(v(path.join(root, 'new', 'deep', 'file.txt')), path.join(root, 'new', 'deep', 'file.txt'));
  for (const bad of [other, '../other', path.join(root, '..'), path.sep]) assert.throws(() => v(bad), { code: 'path_outside_roots' }, bad);
  for (const bad of ['.env', '.env.local', '.ssh/config', 'k/id_rsa', 'x.pem', '.aws/credentials']) assert.throws(() => v(bad), { code: 'path_denied' }, bad);
  assert.doesNotThrow(() => v('.env.example'));
  for (const bad of ['', '  ', 'a\0b']) assert.throws(() => v(bad), { code: 'path_invalid' });

  try {
    fs.symlinkSync(other, path.join(root, 'link'), 'dir');
  } catch {
    return t.diagnostic('symlinks not permitted here, escape check skipped');
  }
  assert.throws(() => v('link/file.txt'), { code: 'path_outside_roots' }, 'a symlink inside the root must not lead outside it');
});

// ---------- context trimming ----------
test('trim: drops oldest whole turns, keeps the latest, never starts mid-turn', () => {
  const turn = (i: number, pad: number): Msg[] => [
    { role: 'user', content: `q${i}` },
    { role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `c${i}`, content: 'r'.repeat(pad) },
    { role: 'assistant', content: `a${i}` },
  ];
  const msgs = [...turn(1, 1000), ...turn(2, 1000), ...turn(3, 1000)];
  const out = trim(msgs, 2500);
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content, 'q2');
  assert.equal(out.at(-1)!.content, 'a3');
  assert.equal(trim(msgs, 10).length, 4, 'the latest turn is kept even if it alone is over budget');
  assert.equal(trim(msgs, 1e9).length, msgs.length);
});

// ---------- Groq client (fake streaming fetch) ----------
const enc = new TextEncoder();
const sse = (...events: unknown[]) => events.map((e) => `data: ${typeof e === 'string' ? e : JSON.stringify(e)}\n\n`).join('');
const stream = (text: string, chunk: number, status = 200, headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        const b = enc.encode(text);
        for (let i = 0; i < b.length; i += chunk) c.enqueue(b.subarray(i, i + chunk));
        c.close();
      },
    }),
    { status, headers },
  );
const delta = (d: object, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });
const cfg = { apiKey: 'k', baseUrl: 'https://example.test/v1' };
const opts = { model: 'm', messages: [{ role: 'user' as const, content: 'hi' }], tools: [{ type: 'function' }] };
const noSleep = async () => {};

test('groq: streams text even when chunks split lines and multibyte characters', async () => {
  const body = sse(delta({ content: 'Héllo ' }), delta({ content: 'wörld ✓' }), delta({}, 'stop'), '[DONE]');
  const seen: string[] = [];
  const llm = createGroq(cfg, { fetch: async () => stream(body, 7) });
  const r = await llm.chat({ ...opts, onText: (s) => seen.push(s) });
  assert.equal(r.content, 'Héllo wörld ✓');
  assert.equal(seen.join(''), 'Héllo wörld ✓');
  assert.equal(r.finish_reason, 'stop');
  assert.equal(r.tool_calls.length, 0);
});

test('groq: assembles tool-call arguments streamed in fragments, including parallel calls', async () => {
  const body = sse(
    delta({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
    delta({ tool_calls: [{ index: 1, id: 'c2', function: { name: 'list_directory', arguments: '{"path":"."}' } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }),
    delta({}, 'tool_calls'),
    '[DONE]',
  );
  const r = await createGroq(cfg, { fetch: async () => stream(body, 11) }).chat(opts);
  assert.deepEqual(r.tool_calls.map((c) => [c.id, c.function.name, JSON.parse(c.function.arguments)]), [
    ['c1', 'read_file', { path: 'a.txt' }],
    ['c2', 'list_directory', { path: '.' }],
  ]);
  assert.equal(r.finish_reason, 'tool_calls');
});

test('groq: sends auth, stream flag, tools and messages', async () => {
  let init: RequestInit | undefined, url = '';
  const llm = createGroq(cfg, { fetch: async (u, i) => ((url = String(u)), (init = i), stream(sse(delta({ content: 'x' }, 'stop'), '[DONE]'), 99)) });
  await llm.chat(opts);
  const body = JSON.parse(init!.body as string);
  assert.equal(url, 'https://example.test/v1/chat/completions');
  assert.equal((init!.headers as Record<string, string>).authorization, 'Bearer k');
  assert.equal(body.stream, true);
  assert.equal(body.model, 'm');
  assert.equal(body.tool_choice, 'auto');
  assert.equal(body.messages[0].content, 'hi');
});

test('groq: retries 429 honouring retry-after, then succeeds', async () => {
  const waits: number[] = [];
  let n = 0;
  const llm = createGroq(cfg, {
    sleep: async (ms) => void waits.push(ms),
    fetch: async () => (++n === 1 ? new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'retry-after': '2' } }) : stream(sse(delta({ content: 'ok' }, 'stop')), 99)),
  });
  assert.equal((await llm.chat(opts)).content, 'ok');
  assert.deepEqual(waits, [2000]);
});

test('groq: retries Groq tool_use_failed (malformed model tool call)', async () => {
  let n = 0;
  const llm = createGroq(cfg, {
    sleep: noSleep,
    fetch: async () => (++n === 1 ? new Response('{"error":{"message":"Failed to call a function","code":"tool_use_failed"}}', { status: 400 }) : stream(sse(delta({ content: 'ok' }, 'stop')), 99)),
  });
  assert.equal((await llm.chat(opts)).content, 'ok');
  assert.equal(n, 2);
});

test('groq: does not retry auth errors, and gives up on very long rate-limit waits', async () => {
  let n = 0;
  const auth = createGroq(cfg, { sleep: noSleep, fetch: async () => (n++, new Response('{"error":{"message":"Invalid API Key"}}', { status: 401 })) });
  await assert.rejects(auth.chat(opts), { code: 'llm_http_401', message: /Invalid API Key/ });
  assert.equal(n, 1);

  const limited = createGroq(cfg, { sleep: noSleep, fetch: async () => new Response('{"error":{"message":"daily limit"}}', { status: 429, headers: { 'retry-after': '3600' } }) });
  await assert.rejects(limited.chat(opts), { code: 'llm_http_429', message: /daily limit/ });
});

test('groq: an aborted request rejects', async () => {
  const ac = new AbortController();
  const llm = createGroq(cfg, { fetch: async (_u, i) => new Promise((_r, rej) => i!.signal!.addEventListener('abort', () => rej(i!.signal!.reason))) });
  const p = llm.chat({ ...opts, signal: ac.signal });
  ac.abort();
  await assert.rejects(p);
});
