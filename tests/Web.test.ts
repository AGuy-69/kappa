import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import { after, before, test } from 'node:test';
import { htmlToText, isPrivateIp, parseDuckDuckGo } from '../src/tools/web.ts';
import { lastTool, say, setup, use } from './helpers.ts';

// No network in tests: DNS resolves everything to a public address, and fetch is a fake.
const realLookup = dns.lookup;
before(() => { (dns as any).lookup = async (h: string) => [{ address: h === 'evil.test' ? '10.0.0.5' : '93.184.216.34', family: 4 }]; });
after(() => { (dns as any).lookup = realLookup; });

const DDG = `
<div class="result"><h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.motogp.com%2Fen%2Fnews%2Fveda&amp;rut=abc">Veda Ega &amp; Moto3 <b>standings</b></a></h2>
<a class="result__snippet" href="x">Veda Ega is <b>5th</b> in the championship.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad">AD</a><a class="result__snippet" href="x">ad snippet</a></div>
<div class="result"><a rel="nofollow" href="https://other.example/page" class="result__a">Other page</a></div>`;
const PAGE = '<html><head><title>Moto3 &amp; Standings</title><style>p{}</style></head><body><table><tr><td>1</td><td>Rider A</td></tr><tr><td>5</td><td>Veda Ega Pratama</td></tr></table><script>track()</script></body></html>';
const html = (body: string, status = 200, type = 'text/html; charset=utf-8') => new Response(body, { status, headers: { 'content-type': type } });

function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const f = (async (u: any) => {
    const url = new URL(String(u));
    seen.push(url.href);
    return (routes[url.hostname] ?? (() => html('nope', 404)))();
  }) as typeof fetch;
  return { f, seen };
}

test('htmlToText: drops scripts/styles, keeps table rows readable, decodes entities', () => {
  const { title, text } = htmlToText(PAGE);
  assert.equal(title, 'Moto3 & Standings');
  assert.match(text, /5 \| Veda Ega Pratama/);
  assert.doesNotMatch(text, /track\(\)|p\{\}/);
});

test('parseDuckDuckGo: unwraps redirect links, decodes text, drops ads, tolerates missing snippets', () => {
  const r = parseDuckDuckGo(DDG);
  assert.deepEqual(r, [
    { title: 'Veda Ega & Moto3 standings', url: 'https://www.motogp.com/en/news/veda', snippet: 'Veda Ega is 5th in the championship.' },
    { title: 'Other page', url: 'https://other.example/page', snippet: '' },
  ]);
});

test('isPrivateIp: loopback, private, link-local, metadata, mapped v6', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1'])
    assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1::1']) assert.equal(isPrivateIp(ip), false, ip);
});

test('web: search, then read a result page without a prompt; other hosts need approval once', async () => {
  const { f, seen } = fakeFetch({ 'html.duckduckgo.com': () => html(DDG), 'www.motogp.com': () => html(PAGE), 'other.example': () => html(PAGE), 'new.example': () => html(PAGE) });

  // hosts that appeared in search results are trusted, so no approver is even needed
  const t = setup({ approve: 'none', fetch: f });
  t.script(
    use(['web_search', { query: 'veda ega moto3 standings' }]),
    (o) => use(['web_fetch', { url: lastTool(o).results[0].url }]),
    (o) => say(lastTool(o).text),
  );
  const r = await t.run('where is Veda Ega in Moto3?');
  assert.match(r.text, /5 \| Veda Ega Pratama/);
  assert.equal(t.approvals.length, 0);
  assert.equal(seen[0], 'https://html.duckduckgo.com/html/');

  // an unseen host: declined = not fetched
  const d = setup({ approve: false, fetch: f });
  d.script(use(['web_fetch', { url: 'https://new.example/x' }]), say('ok'));
  await d.run('read it');
  assert.equal(d.results()[0].error, 'not_approved');
  assert.ok(!seen.some((u) => u.includes('new.example')));

  // approved once, then the same host no longer prompts
  const a = setup({ approve: true, fetch: f });
  a.script(use(['web_fetch', { url: 'https://new.example/x' }]), use(['web_fetch', { url: 'https://new.example/y' }]), say('ok'));
  await a.run('read it');
  assert.equal(a.approvals.length, 1);
  assert.equal(a.approvals[0].tool, 'web_fetch');
  assert.equal(a.results()[1].title, 'Moto3 & Standings');
});

test('web_fetch refuses local/private targets before any prompt or request', async () => {
  const { f, seen } = fakeFetch({});
  const t = setup({ approve: true, fetch: f });
  t.script(
    use(
      ['web_fetch', { url: 'http://127.0.0.1:8080/admin' }],
      ['web_fetch', { url: 'http://localhost/' }],
      ['web_fetch', { url: 'http://169.254.169.254/latest/meta-data/' }],
      ['web_fetch', { url: 'http://[::1]/' }],
      ['web_fetch', { url: 'file:///C:/Windows/win.ini' }],
    ),
    say('ok'),
  );
  await t.run('go');
  assert.deepEqual(t.results().map((r) => r.error), ['blocked_host', 'blocked_host', 'blocked_host', 'blocked_host', 'bad_url']);
  assert.equal(t.approvals.length, 0);
  assert.equal(seen.length, 0);
});

test('web_fetch refuses names that resolve to private addresses, and redirects into private ranges', async () => {
  const { f, seen } = fakeFetch({ '93.184.216.34': () => new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/secret' } }) });
  const t = setup({ approve: true, fetch: f });
  t.script(use(['web_fetch', { url: 'http://evil.test/' }], ['web_fetch', { url: 'http://93.184.216.34/' }]), say('ok'));
  await t.run('go');
  assert.deepEqual(t.results().map((r) => r.error), ['blocked_host', 'blocked_host']);
  assert.deepEqual(seen, ['http://93.184.216.34/'], 'evil.test was never requested; the redirect target was never requested');
});

test('web_fetch: HTTP errors, unsupported content, JS-only pages and paging', async () => {
  const { f } = fakeFetch({
    '93.184.216.34': () => html('<html><body><div id="app"></div><script>boot()</script></body></html>'),
    '8.8.8.8': () => html('%PDF-1.7', 200, 'application/pdf'),
    '1.1.1.1': () => html('missing', 404),
    '9.9.9.9': () => html('x'.repeat(1000), 200, 'text/plain'),
  });
  const t = setup({ approve: true, fetch: f });
  t.script(
    use(['web_fetch', { url: 'http://93.184.216.34/' }], ['web_fetch', { url: 'http://8.8.8.8/' }], ['web_fetch', { url: 'http://1.1.1.1/' }],
        ['web_fetch', { url: 'http://9.9.9.9/', max_chars: 500 }], ['web_fetch', { url: 'http://9.9.9.9/', max_chars: 500, offset: 500 }]),
    say('ok'),
  );
  await t.run('go');
  const r = t.results();
  assert.match(r[0].note, /JavaScript/);
  assert.equal(r[1].error, 'unsupported_content');
  assert.equal(r[2].error, 'http_404');
  assert.deepEqual([r[3].more, r[3].text.length, r[4].more, r[4].text.length], [true, 500, false, 500]);
});

test('web_search: a bot-check page gives a clear error instead of empty results', async () => {
  const { f } = fakeFetch({ 'html.duckduckgo.com': () => html('<html>Unfortunately, bots use DuckDuckGo too. anomaly-modal</html>') });
  const t = setup({ fetch: f });
  t.script(use(['web_search', { query: 'x' }]), say('ok'));
  await t.run('go');
  assert.equal(t.results()[0].error, 'search_blocked');
});

test('web_search uses Tavily when a key is set: one call gives an answer plus trusted sources', async () => {
  let req: { url: string; auth: string; body: any } | undefined;
  const f = (async (u: any, init: any) => {
    const url = String(u);
    if (url === 'https://api.tavily.com/search') {
      req = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ answer: 'Kimi Antonelli', results: [{ title: 'T', url: 'https://racefans.example/a', content: 'c'.repeat(900) }] }), { status: 200 });
    }
    return html(PAGE);
  }) as typeof fetch;
  const t = setup({ approve: 'none', fetch: f, cfg: { tavilyKey: 'tvly-test' } });
  t.script(use(['web_search', { query: 'f1 champion 2026', max_results: 3 }]), use(['web_fetch', { url: 'https://racefans.example/a' }]), say('ok'));
  await t.run('who is champion');
  assert.equal(req!.auth, 'Bearer tvly-test');
  assert.deepEqual([req!.body.query, req!.body.max_results, req!.body.include_answer], ['f1 champion 2026', 3, true]);
  const r = t.results();
  assert.equal(r[0].answer, 'Kimi Antonelli');
  assert.equal(r[0].results[0].snippet.length, 500);
  assert.equal(r[1].title, 'Moto3 & Standings', 'a Tavily result host is trusted: fetched without approval');
  assert.equal(t.approvals.length, 0);
});

test('web_search: a bad Tavily key is reported as such', async () => {
  const t = setup({ fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch, cfg: { tavilyKey: 'bad' } });
  t.script(use(['web_search', { query: 'x' }]), say('ok'));
  await t.run('go');
  assert.equal(t.results()[0].error, 'search_http_401');
});

test('web_fetch: Wikipedia is trusted by default, look-alike domains are not', async () => {
  const { f } = fakeFetch({ 'en.wikipedia.org': () => html(PAGE), 'evilwikipedia.org': () => html(PAGE) });
  const t = setup({ approve: false, fetch: f });
  t.script(use(['web_fetch', { url: 'https://en.wikipedia.org/wiki/X' }], ['web_fetch', { url: 'https://evilwikipedia.org/wiki/X' }]), say('ok'));
  await t.run('go');
  assert.equal(t.results()[0].title, 'Moto3 & Standings');
  assert.equal(t.results()[1].error, 'not_approved');
  assert.equal(t.approvals.length, 1);
});

// ---------- unreachable search services ----------
import { errMsg } from '../src/util/errors.ts';
const netFail = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error('connect timed out'), { code }) });

test('errMsg: surfaces the real cause behind "fetch failed"', () => {
  assert.equal(errMsg(netFail('UND_ERR_CONNECT_TIMEOUT')), 'fetch failed (UND_ERR_CONNECT_TIMEOUT)');
  assert.equal(errMsg(new Error('plain')), 'plain');
  assert.equal(errMsg('str'), 'str');
});

test('web_search: Tavily unreachable falls back to DuckDuckGo and says so', async () => {
  const f = (async (u: any) => {
    if (String(u).includes('tavily.com')) throw netFail('UND_ERR_CONNECT_TIMEOUT');
    return html(DDG);
  }) as typeof fetch;
  const t = setup({ fetch: f, cfg: { tavilyKey: 'tvly-x' } });
  t.script(use(['web_search', { query: 'doni hanafi' }]), say('ok'));
  await t.run('who is doni hanafi');
  const r = t.results()[0];
  assert.equal(r.results.length, 2);
  assert.match(r.note, /Tavily was unreachable \(fetch failed \(UND_ERR_CONNECT_TIMEOUT\)\).*DuckDuckGo was used/);
});

test('web_search: when nothing is reachable the error names the causes and what to check', async () => {
  const f = (async () => { throw netFail('ENOTFOUND'); }) as typeof fetch;
  const t = setup({ fetch: f, cfg: { tavilyKey: 'tvly-x' } });
  t.script(use(['web_search', { query: 'x' }]), say('ok'));
  await t.run('go');
  const r = t.results()[0];
  assert.equal(r.error, 'network');
  assert.match(r.message, /Tavily was unreachable.*ENOTFOUND.*DuckDuckGo: fetch failed \(ENOTFOUND\).*VPN, proxy or firewall/);
});

test('web_search: a rejected Tavily key is NOT hidden by the fallback', async () => {
  const t = setup({ fetch: (async () => new Response('{}', { status: 401 })) as typeof fetch, cfg: { tavilyKey: 'bad' } });
  t.script(use(['web_search', { query: 'x' }]), say('ok'));
  await t.run('go');
  assert.equal(t.results()[0].error, 'search_http_401');
});