import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { test } from 'node:test';
import type { Spawn } from '../src/voice/process.ts';
import { findVoice, pcmToWav } from '../src/voice/tts/eleven.ts';
import { createSpeaker, ttsOptionsFromEnv } from '../src/voice/tts/index.ts';

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  stdin = Object.assign(new EventEmitter(), { end: () => {} });
  kill() { setImmediate(() => this.emit('close', null)); return true; }
}
function fakeSpawn() {
  const calls: { cmd: string; args: string[]; wav?: Buffer }[] = [];
  const spawn = ((cmd: string, args: string[]) => {
    const c = new FakeChild();
    const wavPath = args.find((a) => a.endsWith('.wav'));
    calls.push({ cmd, args, wav: wavPath ? fs.readFileSync(wavPath) : undefined }); // the file exists only while it is playing
    setImmediate(() => c.emit('close', 0));
    return c;
  }) as unknown as Spawn;
  return { spawn, calls };
}
const VOICES = { voices: [{ voice_id: 'id-lauren', name: 'Lauren' }, { voice_id: 'id-rachel', name: 'Rachel' }] };
function fakeFetch(o: { voices?: unknown; status?: number } = {}) {
  const seen: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    if (o.status && o.status !== 200) return new Response('denied', { status: o.status });
    if (url.endsWith('/v1/voices')) return new Response(JSON.stringify(o.voices ?? VOICES));
    return new Response(Buffer.alloc(4800, 1)); // 0.1 s of "audio"
  }) as unknown as typeof fetch;
  return { f, seen };
}

test('pcmToWav: a valid 24 kHz mono 16-bit header in front of the samples', () => {
  const w = pcmToWav(Buffer.alloc(100));
  assert.equal(w.length, 144);
  assert.equal(w.toString('ascii', 0, 4), 'RIFF');
  assert.equal(w.readUInt32LE(4), 136);
  assert.equal(w.readUInt32LE(24), 24000);
  assert.equal(w.readUInt16LE(22), 1);
  assert.equal(w.readUInt16LE(34), 16);
  assert.equal(w.readUInt32LE(40), 100);
});

test('findVoice: exact name wins, several partial matches and no match explain what to do', async () => {
  const f = (v: unknown) => fakeFetch({ voices: { voices: v } }).f;
  assert.deepEqual(await findVoice(f([{ voice_id: 'a', name: 'Lauren B' }, { voice_id: 'b', name: 'lauren' }]), 'k', 'Lauren'), { id: 'b', name: 'lauren' });
  assert.deepEqual(await findVoice(f([{ voice_id: 'a', name: 'Lauren - Gentle' }]), 'k', 'Lauren'), { id: 'a', name: 'Lauren - Gentle' });
  await assert.rejects(findVoice(f([{ voice_id: 'a', name: 'Lauren A' }, { voice_id: 'b', name: 'Lauren B' }]), 'k', 'Lauren'), /Several voices match.*Lauren A \(a\).*KAPPA_ELEVEN_VOICE_ID/);
  await assert.rejects(findVoice(f([{ voice_id: 'a', name: 'Rachel' }]), 'k', 'Lauren'), /No voice named "Lauren".*Voice Library/);
  await assert.rejects(findVoice(fakeFetch({ status: 401 }).f, 'k', 'Lauren'), /401.*ELEVENLABS_API_KEY/);
});

test('elevenlabs: finds Lauren, requests PCM with the key header, plays the audio as WAV', async () => {
  const { f, seen } = fakeFetch();
  const { spawn, calls } = fakeSpawn();
  const s = createSpeaker({ elevenKey: 'xi_test', fetch: f, spawn, platform: 'linux' });
  assert.equal(s.name, 'elevenlabs');
  await s.speak('Hello **there**. How are you?');
  assert.equal(seen[0].url, 'https://api.elevenlabs.io/v1/voices');
  assert.equal(seen[1].url, 'https://api.elevenlabs.io/v1/text-to-speech/id-lauren?output_format=pcm_24000');
  assert.equal((seen[1].init.headers as Record<string, string>)['xi-api-key'], 'xi_test');
  assert.deepEqual(JSON.parse(seen[1].init.body as string), { text: 'Hello there. How are you?', model_id: 'eleven_flash_v2_5' });
  assert.equal(calls[0].cmd, 'paplay');
  assert.equal(calls[0].wav!.toString('ascii', 0, 4), 'RIFF');
  assert.equal(s.speaking, false);
});

test('elevenlabs: a given voice id skips the name lookup; the audio file is deleted afterwards', async () => {
  const { f, seen } = fakeFetch();
  const { spawn, calls } = fakeSpawn();
  const s = createSpeaker({ elevenKey: 'k', elevenVoiceId: 'my-id', elevenModel: 'eleven_multilingual_v2', fetch: f, spawn, platform: 'darwin' });
  await s.speak('Hi there.');
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /text-to-speech\/my-id\?/);
  assert.equal(JSON.parse(seen[0].init.body as string).model_id, 'eleven_multilingual_v2');
  assert.equal(calls[0].cmd, 'afplay');
  assert.ok(!fs.existsSync(calls[0].args[0]));
});

test('elevenlabs: server errors reach the caller; stop() is not an error', async () => {
  const { spawn } = fakeSpawn();
  const bad = createSpeaker({ elevenKey: 'k', elevenVoiceId: 'x', fetch: fakeFetch({ status: 402 }).f, spawn, platform: 'linux' });
  await assert.rejects(bad.speak('Hi there.'), /402.*paid/);
  const { f } = fakeFetch();
  const s = createSpeaker({ elevenKey: 'k', elevenVoiceId: 'x', fetch: f, spawn, platform: 'linux' });
  const p = s.speak('One. Two. Three.');
  s.stop();
  await p; // resolves quietly
  assert.equal(s.speaking, false);
});

test('provider choice: a key selects ElevenLabs under auto; off and system stay available; env names', () => {
  assert.equal(createSpeaker({ elevenKey: 'k' }).name, 'elevenlabs');
  assert.equal(createSpeaker({ elevenKey: 'k', provider: 'system', platform: 'win32' }).name, 'sapi');
  assert.equal(createSpeaker({ elevenKey: 'k', provider: 'off' }).name, 'off');
  assert.throws(() => createSpeaker({ provider: 'elevenlabs' }), /ELEVENLABS_API_KEY/);
  const o = ttsOptionsFromEnv({ KAPPA_TTS: 'elevenlabs', ELEVENLABS_API_KEY: 'k', KAPPA_ELEVEN_VOICE_ID: 'v', KAPPA_ELEVEN_MODEL: 'm' });
  assert.deepEqual([o.provider, o.elevenKey, o.elevenVoiceId, o.elevenModel, o.elevenVoice], ['elevenlabs', 'k', 'v', 'm', undefined]);
});
