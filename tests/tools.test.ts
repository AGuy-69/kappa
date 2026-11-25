import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import { after, before, test } from 'node:test';
import type { Exec, ExecResult, Launch } from '../src/util/exec.ts';
import { say, setup, use } from './helpers.ts';

const realLookup = dns.lookup;
before(() => { (dns as any).lookup = async () => [{ address: '93.184.216.34', family: 4 }]; });
after(() => { (dns as any).lookup = realLookup; });

const done = (stdout = '', code = 0): ExecResult => ({ code, stdout, stderr: '', timedOut: false, aborted: false, truncated: false });
function fakeExec(stdout = '') {
  const calls: { cmd: string; args: string[]; input?: string; env?: Record<string, string> }[] = [];
  const exec: Exec = async (cmd, args, o) => (calls.push({ cmd, args, input: o?.input, env: o?.env }), done(stdout));
  return { exec, calls };
}
const enoent = () => Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
async function asPlatform<T>(p: NodeJS.Platform, f: () => Promise<T>): Promise<T> {
  const orig = process.platform;
  Object.defineProperty(process, 'platform', { value: p });
  try { return await f(); } finally { Object.defineProperty(process, 'platform', { value: orig }); }
}
const decode = (a: string[]) => Buffer.from(a[a.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');

// ---- open_application ----

test('open_application: reaches launch (regression: c.launch was missing from the tool context)', async () => {
  const t = setup();
  t.script(use(['open_application', { target: 'firefox', args: ['--private-window'] }]), say('ok'));
  await t.run('open firefox');
  assert.deepEqual(t.results(), [{ opened: 'firefox' }]);
  assert.deepEqual(t.launched, [['firefox', ['--private-window']]]);
  assert.equal(t.approvals.length, 1);
});

test('open_application: not approved means not launched', async () => {
  const t = setup({ approve: false });
  t.script(use(['open_application', { target: 'firefox' }]), say('ok'));
  await t.run('open firefox');
  assert.equal(t.results()[0].error, 'not_approved');
  assert.equal(t.launched.length, 0);
});

test('open_application: refuses scripts, shells with args, credential files, dangerous schemes, missing files', async () => {
  const t = setup();
  t.script(use(
    ['open_application', { target: 'run.bat' }],
    ['open_application', { target: 'powershell', args: ['-c', 'del x'] }],
    ['open_application', { target: '~/.ssh/id_rsa' }],
    ['open_application', { target: 'file:///etc/passwd' }],
    ['open_application', { target: path.join(t.work, 'nope.txt') }],
  ), say('ok'));
  await t.run('try');
  assert.deepEqual(t.results().map((r) => r.error), ['protected', 'protected', 'path_denied', 'protected', 'not_found']);
  assert.equal(t.approvals.length, 1, 'only the missing-file call got as far as a prompt');
  assert.equal(t.launched.length, 0);
});

test('open_application (linux): tries name variants, then links go to xdg-open', async () => {
  const seen: string[] = [];
  const launch: Launch = async (cmd) => { seen.push(cmd); if (cmd === 'Visual Studio Code' || cmd === 'visual studio code') throw enoent(); };
  const t = setup({ launch });
  t.script(use(['open_application', { target: 'Visual Studio Code' }], ['open_application', { target: 'https://example.com' }], ['open_application', { target: 'Nothing' }]), say('ok'));
  await asPlatform('linux', () => t.run('go'));
  const r = t.results();
  assert.equal(r[0].opened, 'visual-studio-code');
  assert.deepEqual(seen.slice(0, 3), ['Visual Studio Code', 'visual studio code', 'visual-studio-code']);
  assert.equal(r[1].opened, 'https://example.com');
  assert.ok(seen.includes('xdg-open'));
  assert.equal(r[2].error, undefined, 'fake launch accepts unknown names');
});

test('open_application (windows): PATH program launches directly; URLs use the default browser', async () => {
  const { exec, calls } = fakeExec();
  const t = setup({ exec });
  t.script(use(['open_application', { target: 'notepad' }], ['open_application', { target: 'https://example.com/a?b=1' }]), say('ok'));
  await asPlatform('win32', () => t.run('go'));
  assert.deepEqual(t.launched, [['notepad', []]]);
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [['rundll32', ['url.dll,FileProtocolHandler', 'https://example.com/a?b=1']]]);
});

test('open_application (windows): an app that is not on PATH is found in the Start menu', async () => {
  const { exec, calls } = fakeExec('{"ok":true,"via":"start-menu","app":"Spotify","other_matches":["Spotify Beta"]}');
  const t = setup({ exec, launch: async () => { throw enoent(); } });
  t.script(use(['open_application', { target: 'spotify' }]), say('ok'));
  await asPlatform('win32', () => t.run('open spotify'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.match(decode(calls[0].args), /Get-StartApps/);
  assert.equal(calls[0].env?.KAPPA_TARGET, 'spotify', 'the name travels in the environment, never inside the script text');
  assert.deepEqual(t.results()[0], { opened: 'Spotify', via: 'start-menu', other_matches: ['Spotify Beta'] });
});

test('open_application (macOS): apps by name use open -a', async () => {
  const { exec, calls } = fakeExec();
  const t = setup({ exec });
  t.script(use(['open_application', { target: 'Safari' }]), say('ok'));
  await asPlatform('darwin', () => t.run('go'));
  assert.deepEqual(calls.map((c) => [c.cmd, c.args]), [['open', ['-a', 'Safari']]]);
});

// ---- clipboard ----

test('clipboard: read and write need approval and use the right program', async () => {
  const { exec, calls } = fakeExec('copied text');
  const t = setup({ exec });
  t.script(use(['clipboard', { action: 'read' }], ['clipboard', { action: 'write', text: 'héllo' }], ['clipboard', { action: 'write' }]), say('ok'));
  await asPlatform('darwin', () => t.run('go'));
  const r = t.results();
  assert.equal(r[0].text, 'copied text');
  assert.deepEqual(r[1], { ok: true, characters: 5 });
  assert.equal(r[2].error, 'bad_args');
  assert.deepEqual(calls.map((c) => [c.cmd, c.input]), [['pbpaste', undefined], ['pbcopy', 'héllo']]);
  assert.equal(t.approvals.length, 2);
});

test('clipboard (windows): text goes through the environment, not the script', async () => {
  const { exec, calls } = fakeExec();
  const t = setup({ exec });
  t.script(use(['clipboard', { action: 'write', text: "it's \"quoted\" $(bad)" }]), say('ok'));
  await asPlatform('win32', () => t.run('go'));
  assert.equal(calls[0].env?.KAPPA_TEXT, "it's \"quoted\" $(bad)");
  assert.ok(!decode(calls[0].args).includes('quoted'));
});

// ---- media_control ----

test('media_control: needs no approval; builds the right commands', async () => {
  const { exec, calls } = fakeExec();
  const t = setup({ exec });
  t.script(use(['media_control', { action: 'volume_up', steps: 3 }], ['media_control', { action: 'play_pause' }]), say('ok'));
  await asPlatform('linux', () => t.run('go'));
  assert.equal(t.approvals.length, 0);
  assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [['pactl', 'set-sink-volume', '@DEFAULT_SINK@', '+6%'], ['playerctl', 'play-pause']]);
});

test('media_control (windows): sends the media key code', async () => {
  const { exec, calls } = fakeExec();
  const t = setup({ exec });
  t.script(use(['media_control', { action: 'mute' }]), say('ok'));
  await asPlatform('win32', () => t.run('go'));
  assert.match(decode(calls[0].args), /SendKeys\(\[char\]173\)/);
});

// ---- download_file ----

const fakeFetch = (body: string | Uint8Array, init: ResponseInit = {}) => (async () => new Response(body, init)) as unknown as typeof fetch;

test('download_file: saves a file inside the allowed folders, after approval', async () => {
  const t = setup({ fetch: fakeFetch('hello world', { headers: { 'content-type': 'text/plain' } }) });
  t.script(use(['download_file', { url: 'http://example.com/a.txt', path: 'a.txt' }]), say('ok'));
  await t.run('get it');
  assert.equal(fs.readFileSync(path.join(t.work, 'a.txt'), 'utf8'), 'hello world');
  assert.equal(t.results()[0].bytes, 11);
  assert.equal(t.approvals.length, 1);
  assert.deepEqual(fs.readdirSync(t.work), ['a.txt'], 'no leftover .part file');
});

test('download_file: never overwrites, never leaves partial files, refuses bad targets', async () => {
  const t = setup({ fetch: fakeFetch('x', { status: 404 }) });
  fs.writeFileSync(path.join(t.work, 'exists.txt'), 'mine');
  t.script(use(
    ['download_file', { url: 'http://example.com/a', path: 'exists.txt' }],
    ['download_file', { url: 'http://example.com/a', path: 'new.txt' }],
    ['download_file', { url: 'ftp://example.com/a', path: 'f.txt' }],
    ['download_file', { url: 'http://example.com/a', path: '~/.ssh/id_rsa' }],
    ['download_file', { url: 'http://example.com/a', path: '/definitely/outside/roots.txt' }],
  ), say('ok'));
  await t.run('go');
  assert.deepEqual(t.results().map((r) => r.error), ['exists', 'http_error', 'bad_url', 'path_denied', 'path_outside_roots']);
  assert.equal(fs.readFileSync(path.join(t.work, 'exists.txt'), 'utf8'), 'mine');
  assert.deepEqual(fs.readdirSync(t.work), ['exists.txt']);
});

test('download_file: a declared size over the limit is refused before any bytes are written', async () => {
  const t = setup({ fetch: fakeFetch('x', { headers: { 'content-length': String(300 * 2 ** 20) } }) });
  t.script(use(['download_file', { url: 'http://example.com/big', path: 'big.bin' }]), say('ok'));
  await t.run('go');
  assert.equal(t.results()[0].error, 'too_large');
  assert.deepEqual(fs.readdirSync(t.work), []);
});

test('download_file: private addresses are refused (same guard as web_fetch)', async () => {
  const t = setup({ fetch: fakeFetch('secret') });
  t.script(use(['download_file', { url: 'http://127.0.0.1/x', path: 'x.txt' }]), say('ok'));
  await t.run('go');
  assert.equal(t.results()[0].error, 'blocked_host');
});
