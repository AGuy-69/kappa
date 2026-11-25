import dns from 'node:dns/promises';
import net from 'node:net';
import { KappaError, errMsg } from '../util/errors.ts';
import type { Tool, ToolCtx } from './registry.ts';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const v4Private = (ip: string) => {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
};
export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Private(ip);
  const l = ip.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (dotted) return v4Private(dotted[1]);
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(l); // URL parser normalises mapped v4 to this form
  if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return v4Private([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.')); }
  return l === '::1' || l === '::' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
}
const bare = (u: URL) => u.hostname.replace(/^\[|\]$/g, '');

// shortcut: DNS is resolved here and again by fetch, so a hostile DNS server could rebind in between.
async function assertPublic(u: URL) {
  if (!/^https?:$/.test(u.protocol)) throw new KappaError('bad_url', 'Only http and https URLs are allowed.');
  const host = bare(u);
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new KappaError('blocked_host', `${host} is a local or private address. Web tools only reach the public internet.`);
}

// Follows redirects by hand so every hop is checked, not just the first URL.
export async function get(c: ToolCtx, start: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<{ res: Response; url: URL }> {
  let url = new URL(start);
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const res = await c.fetch(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(timeoutMs)]),
      headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8', ...(init.headers as object) },
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { url = new URL(loc, url); init = {}; continue; }
    return { res, url };
  }
  throw new KappaError('too_many_redirects', 'Too many redirects');
}

async function readText(res: Response, maxBytes = 1_500_000): Promise<string> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const ch of res.body!) {
    chunks.push(ch);
    if ((n += ch.length) > maxBytes) break; // breaking cancels the download
  }
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1] ?? 'utf-8';
  let text: string;
  try { text = new TextDecoder(charset).decode(Buffer.concat(chunks)); } catch { text = Buffer.concat(chunks).toString('utf8'); }
  return text;
}

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (entities[e.toLowerCase()] ?? m));

export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const text = decode(
    html
      .replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\/t[dh]>/gi, ' | ')
      .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/table)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/[ \t\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

export function parseDuckDuckGo(html: string): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  const strip = (s: string) => decode(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  for (const m of html.matchAll(/<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = /href="([^"]+)"/.exec(m[0])?.[1];
    if (!href) continue;
    let url = decode(href);
    try {
      const u = new URL(url.startsWith('//') ? `https:${url}` : url);
      url = u.searchParams.get('uddg') ?? u.href;
    } catch { continue; }
    if (/^https?:\/\/(www\.)?duckduckgo\.com\//i.test(url)) continue; // ads and internal links
    const rest = html.slice(m.index! + m[0].length);
    const block = rest.slice(0, Math.max(0, rest.indexOf('result__a')) || 3000);
    const snippet = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)?.[1] ?? '';
    out.push({ title: strip(m[1]), url, snippet: strip(snippet) });
  }
  return out;
}

/** Fresh instance per agent: the set of hosts already trusted (seen in search results or approved) lives in the closure. */
export function makeWebTools(): Tool[] {
  const trusted = new Set<string>();
  const hostOf = (u: string) => { try { return bare(new URL(u)); } catch { return ''; } };
  const isTrusted = (host: string) => trusted.has(host) || /(^|\.)wikipedia\.org$/.test(host);

  async function tavily(a: { query: string; max_results?: number }, c: ToolCtx) {
    const res = await c.fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${c.cfg.tavilyKey}` },
      body: JSON.stringify({ query: a.query, max_results: a.max_results ?? 5, include_answer: true }),
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(8_000)]), // fail fast so the fallback can run
    });
    if (!res.ok) throw new KappaError(`search_http_${res.status}`, `Tavily search failed with HTTP ${res.status}. Check TAVILY_API_KEY.`);
    const j: any = await res.json();
    const results = (j.results ?? []).map((r: any) => ({ title: String(r.title ?? ''), url: String(r.url ?? ''), snippet: String(r.content ?? '').slice(0, 500) }));
    return { query: a.query, answer: j.answer ?? undefined, results };
  }

  const webSearch: Tool<{ query: string; max_results?: number }> = {
    name: 'web_search',
    description: 'Search the web; returns titles, URLs, snippets and sometimes a direct answer.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 10 } },
      required: ['query'],
    },
    risk: 'low',
    target: (a) => a.query,
    async run(a, c) {
      let note: string | undefined;
      if (c.cfg.tavilyKey) {
        try {
          const out = await tavily(a, c);
          for (const r of out.results) trusted.add(hostOf(r.url));
          return out;
        } catch (e) {
          if (e instanceof KappaError || c.signal.aborted) throw e; // a bad key etc. must be reported, not hidden
          note = `Tavily was unreachable (${errMsg(e)}), so DuckDuckGo was used instead.`;
        }
      }
      let html: string;
      try {
        const { res } = await get(c, 'https://html.duckduckgo.com/html/', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ q: a.query }).toString(),
        });
        if (!res.ok) throw new KappaError(`http_${res.status}`, `Search failed with HTTP ${res.status}`);
        html = await readText(res);
      } catch (e) {
        if (e instanceof KappaError || c.signal.aborted) throw e;
        throw new KappaError('network', `Could not reach the search service: ${[note, `DuckDuckGo: ${errMsg(e)}`].filter(Boolean).join(' ')} Check the internet connection, VPN, proxy or firewall. Do not retry or search elsewhere: tell the user the web is unreachable.`);
      }
      const results = parseDuckDuckGo(html).slice(0, a.max_results ?? 5);
      if (!results.length) {
        if (/anomaly|captcha|unusual traffic/i.test(html)) throw new KappaError('search_blocked', 'DuckDuckGo showed a bot check. Try again later, or use web_fetch on a URL you know.');
        return { query: a.query, results: [], note: note ?? 'No results. Try different keywords.' };
      }
      for (const r of results) trusted.add(hostOf(r.url));
      return { query: a.query, results, note };
    },
  };

  const webFetch: Tool<{ url: string; max_chars?: number; offset?: number }> = {
    name: 'web_fetch',
    description:
      'Fetch a web page as readable text (public internet only). JS-rendered pages may come back empty. Use offset to continue.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'integer', minimum: 500, maximum: 30_000 },
        offset: { type: 'integer', minimum: 0 },
      },
      required: ['url'],
    },
    // Hosts from search results are low risk. Any other host needs approval: this stops a hostile page from
    // making the model send data out to an address of its choosing without the user seeing it.
    risk: (a) => (isTrusted(hostOf(a.url)) ? 'low' : 'approval'),
    target: (a) => a.url,
    precheck(a) {
      const u = new URL(a.url); // throws on garbage, which becomes an error result
      const h = bare(u);
      if (!/^https?:$/.test(u.protocol)) throw new KappaError('bad_url', 'Only http and https URLs are allowed.');
      if (h === 'localhost' || h.endsWith('.localhost') || (net.isIP(h) && isPrivateIp(h))) throw new KappaError('blocked_host', `${h} is a local or private address.`);
    },
    async run(a, c) {
      const { res, url } = await get(c, a.url);
      if (res.status >= 400) throw new KappaError(`http_${res.status}`, `The server answered HTTP ${res.status}`);
      const type = res.headers.get('content-type') ?? '';
      if (type && !/^(text\/|application\/(json|xml|xhtml|rss|atom))/i.test(type)) throw new KappaError('unsupported_content', `Cannot read "${type}" content (PDFs and binaries are not supported).`);
      const raw = await readText(res);
      const { title, text } = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw) ? htmlToText(raw) : { title: '', text: raw };
      trusted.add(hostOf(a.url));
      const start = a.offset ?? 0, max = a.max_chars ?? 6_000;
      return {
        url: url.href, title, total_chars: text.length, offset: start, more: start + max < text.length,
        text: text.slice(start, start + max),
        note: text.length < 200 ? 'Very little text came back. The page probably needs JavaScript; try another source.' : undefined,
      };
    },
  };

  return [webSearch, webFetch];
}