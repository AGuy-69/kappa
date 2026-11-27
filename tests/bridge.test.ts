import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { Conversation } from '../src/agent/conversation.ts';
import { runBridge } from '../src/app/bridge.ts';
import type { BridgeOpts } from '../src/app/bridge.ts';
import { say, setup, toolCallsAnswered, use } from './helpers.ts';

/** A fake dock: writes protocol lines to the bridge and records what comes back. */
function dock(extra: Partial<BridgeOpts> = {}) {
  const t = setup({ approve: 'none' });
  const input = new PassThrough();
  const output = new PassThrough();
  const seen: any[] = [];
  readline.createInterface({ input: output }).on('line', (l) => seen.push(JSON.parse(l)));
  const closed = runBridge({
    deps: t.deps, conv: t.conv, newConv: () => new Conversation(t.store), input, output,
    makeSpeaker: () => { throw new Error('no voice here'); },
    makeListener: () => { throw new Error('no microphone here'); },
    ...extra,
  });
  const raw = (s: string) => void input.write(s);
  const tx = (m: object) => raw(JSON.stringify(m) + '\n');
  const wait = async (f: (m: any) => boolean, what = 'message'): Promise<any> => {
    for (let i = 0; i < 300; i++) {
      const m = seen.find(f);
      if (m) return m;
      await sleep(10);
    }
    assert.fail(`never saw ${what}; got ${JSON.stringify(seen)}`);
  };
  const done = () => wait((m) => m.t === 'done', 'done');
  return { t, seen, raw, tx, wait, done, closed, close: () => input.end() };
}
const types = (seen: any[]) => seen.map((m) => (m.t === 'state' ? `state:${m.s}${m.label ? `:${m.label}` : ''}` : m.t));
const newFile = { path: 'out/a.txt', content: 'hi' };

test('bridge: a plain reply streams as ready, thinking, responding, text, done, idle', async () => {
  const d = dock();
  d.t.script((o) => { o.onText?.('hi '); o.onText?.('there'); return say('hi there'); });
  d.tx({ t: 'say', text: 'hello' });
  await d.wait((m) => m.t === 'state' && m.s === 'idle', 'idle');
  assert.deepEqual(types(d.seen), ['ready', 'state:thinking', 'state:working:Responding', 'text', 'text', 'done', 'state:idle']);
  assert.deepEqual(d.seen.filter((m) => m.t === 'text').map((m) => m.d), ['hi ', 'there']);
  assert.deepEqual(d.seen.find((m) => m.t === 'done'), { t: 'done', status: 'done', text: 'hi there' });
});

test('bridge: a tool call shows its name while it runs, then goes back to thinking', async () => {
  const d = dock();
  d.t.script(use(['list_directory', { path: '.' }]), say('ok'));
  d.tx({ t: 'say', text: 'look' });
  await d.wait((m) => m.t === 'state' && m.s === 'idle', 'idle');
  assert.deepEqual(types(d.seen).slice(0, 4), ['ready', 'state:thinking', 'state:working:list_directory', 'state:thinking']);
});

test('bridge: approve runs the tool, and the card carries tool, risk and target', async () => {
  const d = dock();
  d.t.script(use(['create_file', newFile]), say('done'));
  d.tx({ t: 'say', text: 'make it' });
  const a = await d.wait((m) => m.t === 'approval', 'approval');
  assert.equal(a.tool, 'create_file');
  assert.equal(a.risk, 'approval');
  assert.ok(a.target.includes('a.txt'));
  d.tx({ t: 'approve', id: a.id, ok: true });
  assert.equal((await d.done()).status, 'done');
  assert.equal(fs.readFileSync(path.join(d.t.work, 'out/a.txt'), 'utf8'), 'hi');
});

test('bridge: deny, a wrong id and a non-true value all leave the file uncreated', async () => {
  const d = dock();
  d.t.script(use(['create_file', newFile]), say('ok'));
  d.tx({ t: 'say', text: 'make it' });
  const a = await d.wait((m) => m.t === 'approval', 'approval');
  d.tx({ t: 'approve', id: a.id + 99, ok: true }); // some other request: must not count
  d.tx({ t: 'approve', id: a.id, ok: 'true' }); // only a real boolean true approves
  await d.done();
  assert.equal(fs.existsSync(path.join(d.t.work, 'out/a.txt')), false);
  assert.ok(JSON.stringify(d.t.results()[0]).includes('not_approved'));
});

test('bridge: cancel while an approval is open denies it and ends the turn as cancelled', async () => {
  const d = dock();
  d.t.script(use(['create_file', newFile]), say('never'));
  d.tx({ t: 'say', text: 'make it' });
  await d.wait((m) => m.t === 'approval', 'approval');
  d.tx({ t: 'cancel' });
  assert.equal((await d.done()).status, 'cancelled');
  await d.wait((m) => m.t === 'state' && m.s === 'idle', 'idle');
  assert.equal(fs.existsSync(path.join(d.t.work, 'out/a.txt')), false);
  assert.ok(toolCallsAnswered(d.t.conv.messages));
});

test('bridge: the dock disappearing denies the open approval and ends the bridge', async () => {
  const d = dock();
  d.t.script(use(['create_file', newFile]), say('never'));
  d.tx({ t: 'say', text: 'make it' });
  await d.wait((m) => m.t === 'approval', 'approval');
  d.close();
  await d.closed;
  await sleep(50);
  assert.equal(fs.existsSync(path.join(d.t.work, 'out/a.txt')), false);
  assert.ok(toolCallsAnswered(d.t.conv.messages));
});

test('bridge: say and new while a request is running are ignored', async () => {
  const d = dock();
  d.t.script(use(['create_file', newFile]), say('never')); // the open approval keeps the request busy
  d.tx({ t: 'say', text: 'one' });
  await d.wait((m) => m.t === 'approval', 'approval');
  d.tx({ t: 'say', text: 'two' });
  d.tx({ t: 'new' });
  d.tx({ t: 'cancel' });
  assert.equal((await d.done()).status, 'cancelled');
  await sleep(50);
  assert.equal(d.t.llm.calls.length, 1);
  assert.equal(d.seen.filter((m) => m.t === 'done').length, 1);
  assert.equal(d.t.conv.messages.filter((m) => m.role === 'user').length, 1, 'nothing was queued and the conversation was not replaced');
});

test('bridge: model errors become an error state with the message', async () => {
  const d = dock();
  d.t.script(() => { throw new Error('429 rate limited'); });
  d.tx({ t: 'say', text: 'hi' });
  const m = await d.done();
  assert.equal(m.status, 'error');
  assert.match(m.error, /429/);
  assert.ok(d.seen.some((s) => s.t === 'state' && s.s === 'error' && /429/.test(s.label)));
});

test('bridge: garbage lines and malformed messages are ignored', async () => {
  const d = dock();
  d.t.script(say('fine'));
  d.raw('not json at all\n');
  d.raw('null\n');
  d.tx({ t: 'nope' });
  d.tx({ t: 'say', text: '   ' });
  d.tx({ t: 'say', text: 42 });
  d.tx({ t: 'approve', id: 'x' });
  d.tx({ t: 'say', text: 'real' });
  assert.equal((await d.done()).text, 'fine');
  assert.equal(d.t.llm.calls.length, 1);
});

test('bridge: /new starts a fresh conversation, but not while busy', async () => {
  const d = dock();
  d.t.script(say('a'), say('b'));
  d.tx({ t: 'say', text: 'one' });
  await d.done();
  d.tx({ t: 'new' });
  d.tx({ t: 'say', text: 'two' });
  await d.wait((m) => m.t === 'done' && m.text === 'b', 'second done');
  assert.equal(d.t.llm.calls[1].messages.filter((m) => m.role === 'user').length, 1, 'the second request has no history of the first');
});

function fakeListener(text: string, opts: { pastes?: boolean } = {}) {
  const log = { cancelled: false, stopped: false };
  return { log, make: () => ({ name: 'fake', ...opts, start: async () => ({ stop: async () => ((log.stopped = true), text), cancel: () => void (log.cancelled = true) }) }) };
}

test('bridge: listen on then off transcribes and runs the text as a request', async () => {
  const l = fakeListener(' open notepad ');
  const d = dock({ makeListener: l.make });
  d.t.script(say('opened'));
  d.tx({ t: 'listen', on: true });
  await d.wait((m) => m.t === 'state' && m.label === 'Listening', 'Listening');
  d.tx({ t: 'say', text: 'typed while recording' }); // busy: ignored
  d.tx({ t: 'listen', on: false });
  assert.equal((await d.wait((m) => m.t === 'heard', 'heard')).text, 'open notepad');
  assert.equal((await d.done()).text, 'opened');
  assert.equal(d.t.llm.calls[0].messages.at(-1)!.content, 'open notepad');
});

test('bridge: cancel while recording throws the recording away', async () => {
  const l = fakeListener('x');
  const d = dock({ makeListener: l.make });
  d.tx({ t: 'listen', on: true });
  await d.wait((m) => m.label === 'Listening', 'Listening');
  d.tx({ t: 'cancel' });
  await d.wait((m) => m.t === 'state' && m.s === 'idle', 'idle');
  assert.equal(l.log.cancelled, true);
  assert.equal(l.log.stopped, false);
});

test('bridge: silence ends quietly, and a missing microphone is reported', async () => {
  const quiet = dock({ makeListener: fakeListener('  ').make });
  quiet.tx({ t: 'listen', on: true });
  await quiet.wait((m) => m.label === 'Listening', 'Listening');
  quiet.tx({ t: 'listen', on: false });
  await quiet.wait((m) => m.t === 'state' && m.s === 'idle', 'idle');
  assert.equal(quiet.t.llm.calls.length, 0);

  const broken = dock(); // makeListener throws
  broken.tx({ t: 'listen', on: true });
  assert.match((await broken.done()).error, /no microphone/);
});

test('bridge: Handy (types into the focused window) is refused', async () => {
  const d = dock({ makeListener: fakeListener('x', { pastes: true }).make });
  d.tx({ t: 'listen', on: true });
  assert.match((await d.done()).error, /Handy/);
});

test('bridge: voice replies speak the answer, and a broken engine turns itself off', async () => {
  const spoken: string[] = [];
  const d = dock({ makeSpeaker: () => ({ name: 'fake', speaking: false, stop() {}, speak: async (s: string) => void spoken.push(s) }) });
  d.t.script(say('hello'));
  d.tx({ t: 'voice', on: true });
  assert.deepEqual(await d.wait((m) => m.t === 'voice', 'voice'), { t: 'voice', on: true });
  d.tx({ t: 'say', text: 'hi' });
  await d.done();
  await sleep(20);
  assert.deepEqual(spoken, ['hello']);

  const broken = dock(); // makeSpeaker throws
  broken.tx({ t: 'voice', on: true });
  const v = await broken.wait((m) => m.t === 'voice', 'voice');
  assert.equal(v.on, false);
  assert.match(v.error, /no voice/);
});
