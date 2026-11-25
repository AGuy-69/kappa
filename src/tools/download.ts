import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { KappaError } from '../util/errors.ts';
import type { Tool } from './registry.ts';
import { get } from './web.ts';

const MAX_BYTES = 200 * 2 ** 20;

export const downloadFile: Tool<{ url: string; path: string }> = {
  name: 'download_file',
  description: 'Download an http(s) URL to a new file (public internet only, never overwrites, max 200 MB).',
  parameters: { type: 'object', properties: { url: { type: 'string' }, path: { type: 'string' } }, required: ['url', 'path'] },
  risk: 'approval',
  target: (a) => `${a.url} -> ${a.path}`,
  paths: (a) => [a.path],
  timeoutMs: 10 * 60_000,
  precheck(a) {
    let u: URL;
    try { u = new URL(a.url); } catch { throw new KappaError('bad_url', 'Not a valid URL.'); }
    if (!/^https?:$/.test(u.protocol)) throw new KappaError('bad_url', 'Only http and https URLs are allowed.');
  },
  async run(a, c) {
    const dest = c.validatePath(a.path);
    if (fs.existsSync(dest)) throw new KappaError('exists', `${dest} already exists. Pick another name; download_file never overwrites.`);
    const { res, url } = await get(c, a.url, {}, 60_000); // the clock covers the connection and headers; c.signal covers the rest
    if (!res.ok || !res.body) throw new KappaError('http_error', `The server answered ${res.status}.`);
    const declared = Number(res.headers.get('content-length'));
    if (declared > MAX_BYTES) throw new KappaError('too_large', `The file is ${Math.round(declared / 2 ** 20)} MB; the limit is ${MAX_BYTES / 2 ** 20} MB.`);

    const part = `${dest}.kappa-part`;
    let bytes = 0;
    const count = new Transform({
      transform(chunk, _enc, cb) {
        bytes += chunk.length;
        cb(bytes > MAX_BYTES ? new KappaError('too_large', `The download passed the ${MAX_BYTES / 2 ** 20} MB limit and was stopped.`) : null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), count, fs.createWriteStream(part, { flags: 'wx' }), { signal: c.signal });
      if (fs.existsSync(dest)) throw new KappaError('exists', `${dest} appeared during the download; nothing was overwritten.`);
      fs.renameSync(part, dest);
    } catch (e) {
      fs.rmSync(part, { force: true }); // never leave a half-written file behind
      throw e;
    }
    return { saved: dest, bytes, content_type: res.headers.get('content-type') ?? undefined, final_url: url.href };
  },
};

export const downloadTools = [downloadFile];
