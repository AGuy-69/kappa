import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import type { Spawn } from '../src/voice/process.ts';
import { createListener, sttOptionsFromEnv } from '../src/voice/stt/index.ts';
import { parseDshowAudioDevices } from '../src/voice/stt/record.ts';
import { cleanTranscript } from '../src/voice/stt/engines.ts';

type Call = { cmd: string; args: string[] };
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { write: (s: string) => { if (s.includes('q')) setImmediate(() => this.emit('close', 0)); return true; }, end: () => {} });
  killed = false;
  kill() { this.killed = true; setImmediate(() => this.emit('close', null)); return true; }
}
const DSHOW_NEW = '[dshow @ 0000] DirectShow video devices\n[dshow @ 0000] "Integrated Camera" (video)\n[dshow @ 0000] DirectShow audio devices\n[dshow @ 0000] "Microphone Array (Realtek)" (audio)\n[dshow @ 0000]   Alternative name "@device_cm_{33D9}/wave_{1}"\n[dshow @ 0000] "Headset (BT)" (audio)\n';
const DSHOW_OLD = '[dshow @ 0000] DirectShow video devices\n[dshow @ 0000]  "Integrated Camera"\n[dshow @ 0000] DirectShow audio devices\n[dshow @ 0000]  "Microphone (USB)"\n';

/** Acts like ffmpeg (records a WAV when asked to, lists devices, dies for a bad one), whisper-cli, and nothing else. */
function fakes(o: { bytes?: number; ffmpeg?: 'ok' | 'missing' | 'baddevice'; whisperOut?: string; devices?: string } = {}) {
  const calls: Call[] = [];
  const children: FakeChild[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    if (cmd.includes('ffmpeg')) {
      if (o.ffmpeg === 'missing') setImmediate(() => c.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      else if (args.includes('-list_devices')) setImmediate(() => { c.stderr.emit('data', o.devices ?? DSHOW_NEW); c.emit('close', 1); });
      else if (o.ffmpeg === 'baddevice') setImmediate(() => { c.stderr.emit('data', 'Could not find audio only device'); c.emit('close', 1); });
      else fs.writeFileSync(args[args.length - 1], Buffer.alloc(o.bytes ?? 32_000));
    } else {
      setImmediate(() => { c.stdout.emit('data', o.whisperOut ?? ' Hello Kappa. [BLANK_AUDIO]\n'); c.emit('close', 0); });
    }
    return c;
  }) as unknown as Spawn;
  return { spawn, calls, children };
}
const okFetch = (text: string, status = 200) => {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => (seen.push({ url, init }), new Response(status === 200 ? JSON.stringify({ text }) : 'nope', { status }))) as unknown as typeof fetch;
  return { f, seen };
};

test('parseDshowAudioDevices: new and old ffmpeg formats, no video devices', () => {
  assert.deepEqual(parseDshowAudioDevices(DSHOW_NEW), ['Microphone Array (Realtek)', 'Headset (BT)']);
  assert.deepEqual(parseDshowAudioDevices(DSHOW_OLD), ['Microphone (USB)']);
  assert.deepEqual(parseDshowAudioDevices('nothing useful'), []);
});

test('cleanTranscript: drops whisper tags and extra spaces', () => {
  assert.equal(cleanTranscript(' Hello  there. [BLANK_AUDIO]\n'), 'Hello there.');
  assert.equal(cleanTranscript('[ Silence ]'), '');
  assert.equal(cleanTranscript('(music) Play it'), 'Play it');
});

test('groq (windows): records the first microphone, uploads the WAV, returns the text, deletes the audio', async () => {
  const { spawn, calls } = fakes();
  const { f, seen } = okFetch(' Open Spotify. ');
  const l = createListener({ provider: 'auto', groqKey: 'gsk_test', spawn, fetch: f, platform: 'win32', language: 'en' });
  assert.equal(l.name, 'groq');
  const rec = await l.start();
  const record = calls.find((c) => !c.args.includes('-list_devices'))!;
  assert.deepEqual(record.args.slice(record.args.indexOf('-f'), record.args.indexOf('-f') + 3), ['-f', 'dshow', '-i']);
  assert.ok(record.args.includes('audio=Microphone Array (Realtek)'));
  assert.deepEqual(record.args.slice(record.args.indexOf('-ac'), record.args.indexOf('-ac') + 4), ['-ac', '1', '-ar', '16000']);
  const wav = record.args[record.args.length - 1];
  assert.ok(fs.existsSync(wav));
  assert.equal(await rec.stop(), 'Open Spotify.');
  assert.ok(!fs.existsSync(wav), 'the audio is gone after transcription');
  assert.equal(seen[0].url, 'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal((seen[0].init.headers as Record<string, string>).Authorization, 'Bearer gsk_test');
  const form = seen[0].init.body as FormData;
  assert.equal(form.get('model'), 'whisper-large-v3-turbo');
  assert.equal(form.get('language'), 'en');
  assert.ok(form.get('file') instanceof Blob);
});

test('KAPPA_MIC overrides the device; linux and macOS use their own inputs', async () => {
  for (const [platform, mic, expect] of [['win32', 'My Mic', ['-f', 'dshow', '-i', 'audio=My Mic']], ['darwin', undefined, ['-f', 'avfoundation', '-i', ':0']], ['linux', undefined, ['-f', 'pulse', '-i', 'default']]] as const) {
    const { spawn, calls } = fakes();
    const rec = await createListener({ groqKey: 'k', spawn, fetch: okFetch('x').f, platform, mic }).start();
    assert.ok(!calls.some((c) => c.args.includes('-list_devices')), 'no device scan needed');
    const a = calls[0].args;
    assert.deepEqual(a.slice(a.indexOf('-f'), a.indexOf('-f') + 4), [...expect]);
    rec.cancel();
  }
});

test('failures are reported clearly: no ffmpeg, bad device, no microphone, too-short audio, server errors', async () => {
  const base = { groqKey: 'k', platform: 'linux' as const };
  await assert.rejects(createListener({ ...base, spawn: fakes({ ffmpeg: 'missing' }).spawn }).start(), /ffmpeg is not installed.*winget install/);
  await assert.rejects(createListener({ ...base, spawn: fakes({ ffmpeg: 'baddevice' }).spawn }).start(), /microphone could not be opened.*audio only device/);
  await assert.rejects(createListener({ ...base, platform: 'win32', spawn: fakes({ devices: 'DirectShow audio devices\n' }).spawn }).start(), /No microphone was found/);
  const short = await createListener({ ...base, spawn: fakes({ bytes: 100 }).spawn, fetch: okFetch('x').f }).start();
  await assert.rejects(short.stop(), /too short/);
  const bad = await createListener({ ...base, spawn: fakes().spawn, fetch: okFetch('', 401).f }).start();
  await assert.rejects(bad.stop(), /401.*GROQ_API_KEY/);
});

test('cancel deletes the audio and nothing is uploaded', async () => {
  const { spawn, calls, children } = fakes();
  const { f, seen } = okFetch('x');
  const rec = await createListener({ groqKey: 'k', spawn, fetch: f, platform: 'linux' }).start();
  const wav = calls[0].args[calls[0].args.length - 1];
  rec.cancel();
  assert.ok(!fs.existsSync(wav));
  assert.equal(children[0].killed, true);
  assert.equal(seen.length, 0);
});

test('whisper.cpp: offline path passes model, file and language, and cleans the output', async () => {
  const model = `${process.env.TMPDIR ?? '/tmp'}/ggml-test.bin`;
  fs.writeFileSync(model, 'x');
  const { spawn, calls } = fakes();
  const l = createListener({ provider: 'whispercpp', whisperModel: model, spawn, platform: 'linux', language: 'en' });
  assert.equal(l.name, 'whispercpp');
  assert.equal(await (await l.start()).stop(), 'Hello Kappa.');
  const w = calls.find((c) => c.cmd === 'whisper-cli')!;
  assert.deepEqual(w.args.slice(0, 2), ['-m', model]);
  assert.ok(w.args.includes('-nt') && w.args.includes('-np'));
  assert.deepEqual(w.args.slice(-2), ['-l', 'en']);
  fs.rmSync(model);
});

test('createListener: provider choice and configuration errors', () => {
  assert.throws(() => createListener({}), /No speech recognizer is set up/);
  assert.throws(() => createListener({ provider: 'groq' }), /GROQ_API_KEY/);
  assert.throws(() => createListener({ provider: 'off', groqKey: 'k' }), /turned off/);
  assert.equal(createListener({ groqKey: 'k' }).name, 'groq');
  assert.equal(createListener({ provider: 'whispercpp', whisperModel: 'm.bin', groqKey: 'k' }).name, 'whispercpp');
  assert.throws(() => sttOptionsFromEnv({ KAPPA_STT: 'siri' }), /KAPPA_STT must be/);
  assert.deepEqual(sttOptionsFromEnv({ GROQ_API_KEY: 'k', KAPPA_STT_LANGUAGE: 'en', KAPPA_STT_MAX_SECONDS: '30', KAPPA_MIC: 'x' }), {
    provider: undefined, groqKey: 'k', baseUrl: undefined, model: undefined, language: 'en', whisperPath: undefined, whisperModel: undefined, ffmpegPath: undefined, mic: 'x', maxSeconds: 30,
  });
});
