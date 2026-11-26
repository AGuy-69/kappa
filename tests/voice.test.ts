import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { cleanForSpeech, splitSentences } from '../src/voice/speech-text.ts';
import { createSpeaker, ttsOptionsFromEnv } from '../src/voice/tts/index.ts';
import type { Spawn } from '../src/voice/process.ts';

type Call = { cmd: string; args: string[]; input?: string; env?: Record<string, string | undefined>; child: FakeChild };
class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: (t: string) => { this.input = t; } });
  input?: string;
  killed = false;
  kill() { this.killed = true; setImmediate(() => this.emit('close', null)); return true; }
}
/** mode: 'finish' exits 0 on its own, 'hang' waits for kill(), 'missing' fails like a program that is not installed. */
function fakeSpawn(mode: 'finish' | 'hang' | ((cmd: string) => 'finish' | 'hang' | 'missing') = 'finish') {
  const calls: Call[] = [];
  const spawn = ((cmd: string, args: string[], o: { env?: Record<string, string | undefined> }) => {
    const child = new FakeChild();
    calls.push({ cmd, args, env: o.env, child, get input() { return child.input; } } as Call);
    const m = typeof mode === 'function' ? mode(cmd) : mode;
    setImmediate(() => {
      if (m === 'finish') child.emit('close', 0);
      else if (m === 'missing') child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    });
    return child;
  }) as unknown as Spawn;
  return { spawn, calls };
}
const decode = (a: string[]) => Buffer.from(a[a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

test('cleanForSpeech: drops code, links and markup but keeps the words', () => {
  const md = '# Title\n\nSome **bold** and _italic_ text with `code` and open_application.\n\n```js\nconsole.log(1)\n```\n\n- first item\n- second item\n\nSee [the docs](https://x.dev/a) or https://y.dev/b 🎉';
  assert.equal(cleanForSpeech(md), 'Title. Some bold and italic text with code and open application. first item. second item. See the docs or link.');
});

test('cleanForSpeech: unterminated code fence, tables, empty input, length cap at a sentence', () => {
  assert.equal(cleanForSpeech('Hello there.\n```py\nprint(1)'), 'Hello there.');
  assert.equal(cleanForSpeech('| a | b |\n|---|---|\n| 1 | 2 |'), 'a, b. 1, 2.');
  assert.equal(cleanForSpeech('   \n\n  '), '');
  const long = 'One sentence here. '.repeat(100);
  const cut = cleanForSpeech(long, 100);
  assert.ok(cut.length <= 100 && cut.endsWith('.'));
});

test('splitSentences: groups sentences up to the size limit', () => {
  assert.deepEqual(splitSentences('A one. B two. C three.', 12), ['A one.', 'B two.', 'C three.']);
  assert.deepEqual(splitSentences('A one. B two.', 100), ['A one. B two.']);
  assert.deepEqual(splitSentences(''), []);
});

test('system voice (windows): SAPI via PowerShell, female voice, text in the environment', async () => {
  const { spawn, calls } = fakeSpawn();
  const s = createSpeaker({ spawn, platform: 'win32', rate: 2 });
  assert.equal(s.name, 'sapi');
  await s.speak('Hi **there**, "quoted" $(bad)');
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.match(decode(calls[0].args), /Gender -eq 'Female'/);
  assert.match(decode(calls[0].args), /Zira/);
  assert.ok(!decode(calls[0].args).includes('quoted'), 'the text is never part of the script');
  assert.equal(calls[0].env?.KAPPA_TTS_TEXT, 'Hi there, "quoted" $(bad).');
  assert.equal(calls[0].env?.KAPPA_TTS_RATE, '2');
  assert.equal(s.speaking, false);
});

test('system voice (macOS and Linux): female defaults, text on stdin', async () => {
  const mac = fakeSpawn();
  await createSpeaker({ spawn: mac.spawn, platform: 'darwin' }).speak('Hello');
  assert.deepEqual([mac.calls[0].cmd, ...mac.calls[0].args, mac.calls[0].child.input], ['say', '-v', 'Samantha', '-r', '175', 'Hello.']);
  const lin = fakeSpawn();
  await createSpeaker({ spawn: lin.spawn, platform: 'linux', voice: 'en-gb+f2' }).speak('Hello');
  assert.deepEqual([lin.calls[0].cmd, ...lin.calls[0].args], ['espeak-ng', '-v', 'en-gb+f2', '-s', '165', '--stdin']);
});

test('stop() cuts speech off and speak() resolves; speaking flag follows', async () => {
  const { spawn, calls } = fakeSpawn('hang');
  const s = createSpeaker({ spawn, platform: 'darwin' });
  const p = s.speak('A long answer.');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.speaking, true);
  s.stop();
  await p;
  assert.equal(calls[0].child.killed, true);
  assert.equal(s.speaking, false);
});

test('a new speak() interrupts the old one; an aborted signal never starts', async () => {
  const { spawn, calls } = fakeSpawn('hang');
  const s = createSpeaker({ spawn, platform: 'darwin' });
  const first = s.speak('First.');
  const second = s.speak('Second.');
  await first;
  assert.equal(calls[0].child.killed, true);
  s.stop();
  await second;
  const ac = new AbortController();
  ac.abort();
  await s.speak('Never.', ac.signal);
  assert.equal(calls.length, 2);
});

test('nothing speakable means nothing runs; a missing engine is a clear error', async () => {
  const none = fakeSpawn();
  await createSpeaker({ spawn: none.spawn, platform: 'linux' }).speak('```\ncode only\n```');
  assert.equal(none.calls.length, 0);
  const missing = fakeSpawn('missing');
  await assert.rejects(createSpeaker({ spawn: missing.spawn, platform: 'linux' }).speak('Hi'), { code: 'tts_unavailable', message: /espeak-ng is not installed/ });
});

test('piper: synthesizes sentence by sentence, plays each, cleans up', async () => {
  const { spawn, calls } = fakeSpawn();
  const s = createSpeaker({ spawn, platform: 'win32', piperModel: 'C:\\v\\en_US-amy-medium.onnx', piperPath: 'piper.exe', rate: 0 });
  assert.equal(s.name, 'piper');
  await s.speak('First sentence is here. Second sentence is here. '.repeat(10));
  const synths = calls.filter((c) => c.cmd === 'piper.exe');
  const plays = calls.filter((c) => c.cmd === 'powershell.exe');
  assert.ok(synths.length >= 2 && synths.length === plays.length);
  assert.deepEqual(synths[0].args.slice(0, 4), ['--model', 'C:\\v\\en_US-amy-medium.onnx', '--length_scale', '1.00']);
  assert.ok(synths[0].child.input!.startsWith('First sentence'));
  assert.match(plays[0].env!.KAPPA_WAV!, /0\.wav$/);
  assert.equal(s.speaking, false);
});

test('piper: stop() mid-answer stops playing the rest', async () => {
  const { spawn, calls } = fakeSpawn((cmd) => (cmd === 'afplay' ? 'hang' : 'finish'));
  const s = createSpeaker({ spawn, platform: 'darwin', piperModel: 'v.onnx' });
  const p = s.speak('One. '.repeat(200));
  await new Promise((r) => setTimeout(r, 20));
  s.stop();
  await p;
  assert.equal(calls.filter((c) => c.cmd === 'afplay').length, 1);
});

test('piper (linux): falls back from paplay to aplay', async () => {
  const { spawn, calls } = fakeSpawn((cmd) => (cmd === 'paplay' ? 'missing' : 'finish'));
  await createSpeaker({ spawn, platform: 'linux', piperModel: 'v.onnx' }).speak('Hello there.');
  assert.deepEqual(calls.map((c) => c.cmd), ['piper', 'paplay', 'aplay']);
});

test('factory: off is silent, auto picks the system voice without a model, bad settings are explained', async () => {
  const off = createSpeaker({ provider: 'off' });
  assert.equal(off.name, 'off');
  await off.speak('x');
  assert.equal(createSpeaker({ platform: 'win32' }).name, 'sapi');
  assert.throws(() => createSpeaker({ provider: 'piper' }), { code: 'tts_config' });
  assert.throws(() => ttsOptionsFromEnv({ KAPPA_TTS: 'robot' }), { code: 'tts_config' });
  assert.deepEqual(ttsOptionsFromEnv({ KAPPA_TTS: 'Piper', KAPPA_TTS_RATE: '-2', KAPPA_PIPER_MODEL: 'm.onnx' }), {
    provider: 'piper', voice: undefined, rate: -2, maxChars: undefined, piperPath: undefined, piperModel: 'm.onnx',
    elevenKey: undefined, elevenVoice: undefined, elevenVoiceId: undefined, elevenModel: undefined,
  });
});
