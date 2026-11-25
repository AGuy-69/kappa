import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KappaError } from '../util/errors.ts';
import { inside, isDenied } from '../security/paths.ts';
import type { Tool, ToolCtx } from './registry.ts';

const PATH = { type: 'string' } as const;
const preview = (s: string, lines = 15) => {
  const l = s.split('\n');
  return l.slice(0, lines).join('\n') + (l.length > lines ? `\n… (${l.length - lines} more lines)` : '');
};
const exists = (p: string) => fs.access(p).then(() => true, () => false);

// Deleting or moving a root, the home folder, Kappa's data folder or any parent of them is never allowed.
function refuseProtected(p: string, c: ToolCtx) {
  if ([...c.cfg.roots, os.homedir(), c.cfg.home].some((g) => inside(path.resolve(p), path.resolve(g))))
    throw new KappaError('protected', `Refusing to touch ${p}: it is, or contains, a protected folder.`);
}

export const listDirectory: Tool<{ path: string }> = {
  name: 'list_directory',
  description: 'List a directory (name, type, size, modified).',
  parameters: { type: 'object', properties: { path: PATH }, required: ['path'] },
  risk: 'low',
  target: (a) => a.path,
  paths: (a) => [a.path],
  async run(a, c) {
    const dir = c.validatePath(a.path);
    const ents = await fs.readdir(dir, { withFileTypes: true });
    const entries = await Promise.all(
      ents.slice(0, 100).map(async (e) => {
        const s = await fs.stat(path.join(dir, e.name)).catch(() => null);
        return { name: e.name, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file', size: s?.size, modified: s?.mtime.toISOString().slice(0, 16) };
      }),
    );
    return { path: dir, total: ents.length, truncated: ents.length > 100, entries };
  },
};

export const readFile: Tool<{ path: string; offset?: number; max_bytes?: number }> = {
  name: 'read_file',
  description: 'Read a UTF-8 text file in chunks; use offset to continue.',
  parameters: {
    type: 'object',
    properties: {
      path: PATH,
      offset: { type: 'integer', minimum: 0 },
      max_bytes: { type: 'integer', minimum: 1, maximum: 200_000 },
    },
    required: ['path'],
  },
  risk: 'low',
  target: (a) => a.path,
  paths: (a) => [a.path],
  async run(a, c) {
    const p = c.validatePath(a.path);
    const fh = await fs.open(p, 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new KappaError('not_file', `${p} is not a regular file`);
      const buf = Buffer.alloc(a.max_bytes ?? 8_000);
      const offset = a.offset ?? 0;
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      const chunk = buf.subarray(0, bytesRead);
      if (chunk.includes(0)) throw new KappaError('binary_file', 'This looks like a binary file. Process it with a script instead.');
      return { path: p, size: st.size, offset, bytes_read: bytesRead, more: offset + bytesRead < st.size, content: chunk.toString('utf8') };
    } finally {
      await fh.close();
    }
  },
};

export const createFile: Tool<{ path: string; content: string; overwrite?: boolean }> = {
  name: 'create_file',
  description: 'Create a text file (parent folders created). Fails if it exists unless overwrite.',
  parameters: {
    type: 'object',
    properties: { path: PATH, content: { type: 'string' }, overwrite: { type: 'boolean' } },
    required: ['path', 'content'],
  },
  risk: 'approval',
  target: (a) => a.path,
  detail: (a) => `${a.overwrite ? 'OVERWRITES if it exists. ' : ''}Content:\n${preview(a.content)}`,
  paths: (a) => [a.path],
  async run(a, c) {
    const p = c.validatePath(a.path);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, a.content, { flag: a.overwrite ? 'w' : 'wx' });
    return { path: p, bytes: Buffer.byteLength(a.content) };
  },
};

export const editFile: Tool<{ path: string; old_text: string; new_text: string; replace_all?: boolean }> = {
  name: 'edit_file',
  description: 'Replace exact text in a file. old_text must match once unless replace_all.',
  parameters: {
    type: 'object',
    properties: { path: PATH, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
    required: ['path', 'old_text', 'new_text'],
  },
  risk: 'approval',
  target: (a) => a.path,
  detail: (a) => `Replace:\n${preview(a.old_text, 8)}\nWith:\n${preview(a.new_text, 8)}`,
  paths: (a) => [a.path],
  async run(a, c) {
    const p = c.validatePath(a.path);
    if (!a.old_text) throw new KappaError('bad_args', 'old_text must not be empty');
    const text = await fs.readFile(p, 'utf8');
    if (text.includes('\0')) throw new KappaError('binary_file', 'Refusing to edit a binary file');
    const n = text.split(a.old_text).length - 1;
    if (n === 0) throw new KappaError('no_match', 'old_text was not found. Read the file again and copy the text exactly.');
    if (n > 1 && !a.replace_all) throw new KappaError('ambiguous', `old_text matches ${n} places. Add surrounding context or set replace_all.`);
    const out = a.replace_all ? text.split(a.old_text).join(a.new_text) : text.replace(a.old_text, () => a.new_text);
    await fs.writeFile(p, out);
    return { path: p, replacements: a.replace_all ? n : 1 };
  },
};

const SKIP = new Set(['node_modules', '.git', '__pycache__', '$Recycle.Bin', 'System Volume Information']);

export const searchFiles: Tool<{ path: string; name_pattern?: string; content?: string; max_results?: number }> = {
  name: 'search_files',
  description: 'Recursively find files by name glob and/or contained text (case-insensitive).',
  parameters: {
    type: 'object',
    properties: {
      path: PATH,
      name_pattern: { type: 'string' },
      content: { type: 'string' },
      max_results: { type: 'integer', minimum: 1, maximum: 500 },
    },
    required: ['path'],
  },
  risk: 'low',
  target: (a) => `${a.path} ${a.name_pattern ?? ''} ${a.content ? `contains "${a.content}"` : ''}`.trim(),
  paths: (a) => [a.path],
  async run(a, c) {
    const root = c.validatePath(a.path);
    if (!a.name_pattern && !a.content) throw new KappaError('bad_args', 'Provide name_pattern and/or content');
    const nameRe = a.name_pattern && new RegExp('^' + a.name_pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    const needle = a.content?.toLowerCase();
    const max = a.max_results ?? 30;
    const hits: { path: string; line?: number; text?: string }[] = [];
    let scanned = 0;
    const deadline = Date.now() + 15_000;
    let reads = 0, stopped = '';
    const full = () => {
      if (hits.length >= max || c.signal.aborted) return true;
      if (Date.now() > deadline) return !!(stopped ||= 'the 15 second time limit');
      if (reads >= 5000) return !!(stopped ||= 'the limit of 5000 files read');
      return false;
    };

    const walk = async (dir: string): Promise<void> => {
      const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of ents) {
        if (full()) return;
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink() || isDenied(p)) continue; // children of a validated root cannot escape it without symlinks
        if (e.isDirectory()) {
          if (!SKIP.has(e.name)) await walk(p);
          continue;
        }
        if (!e.isFile() || (nameRe && !nameRe.test(e.name))) continue;
        scanned++;
        if (!needle) {
          hits.push({ path: p });
          continue;
        }
        reads++;
        const st = await fs.stat(p).catch(() => null);
        if (!st || st.size > 2_000_000) continue;
        const text = await fs.readFile(p, 'utf8').catch(() => '');
        if (text.includes('\0')) continue;
        for (const [i, l] of text.split('\n').entries()) {
          if (l.toLowerCase().includes(needle)) hits.push({ path: p, line: i + 1, text: l.trim().slice(0, 200) });
          if (full()) break;
        }
      }
    };
    await walk(root);
    return { root, matches: hits.length, truncated: hits.length >= max, files_scanned: scanned, results: hits, ...(stopped ? { incomplete: true, note: `Stopped at ${stopped}. Narrow the folder or pattern.` } : {}) };
  },
};

export const getFileMetadata: Tool<{ path: string }> = {
  name: 'get_file_metadata',
  description: 'Size, type and timestamps of a file or folder.',
  parameters: { type: 'object', properties: { path: PATH }, required: ['path'] },
  risk: 'low',
  target: (a) => a.path,
  paths: (a) => [a.path],
  async run(a, c) {
    const p = c.validatePath(a.path);
    const s = await fs.lstat(p);
    return {
      path: p,
      type: s.isDirectory() ? 'dir' : s.isSymbolicLink() ? 'symlink' : s.isFile() ? 'file' : 'other',
      size: s.size,
      created: s.birthtime.toISOString(),
      modified: s.mtime.toISOString(),
      accessed: s.atime.toISOString(),
      mode: (s.mode & 0o777).toString(8),
    };
  },
};

export const moveFile: Tool<{ source: string; destination: string }> = {
  name: 'move_file',
  description: 'Move or rename. Fails if the destination exists.',
  parameters: { type: 'object', properties: { source: PATH, destination: PATH }, required: ['source', 'destination'] },
  risk: 'approval',
  target: (a) => `${a.source} -> ${a.destination}`,
  paths: (a) => [a.source, a.destination],
  precheck: (a, c) => refuseProtected(c.validatePath(a.source), c),
  async run(a, c) {
    const src = c.validatePath(a.source);
    const dst = c.validatePath(a.destination);
    refuseProtected(src, c);
    if (await exists(dst)) throw new KappaError('exists', `${dst} already exists`);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fs.rename(src, dst);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e; // different drive: copy then remove
      await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
      await fs.rm(src, { recursive: true });
    }
    return { moved: src, to: dst };
  },
};

export const copyFile: Tool<{ source: string; destination: string }> = {
  name: 'copy_file',
  description: 'Copy a file or folder. Fails if the destination exists.',
  parameters: { type: 'object', properties: { source: PATH, destination: PATH }, required: ['source', 'destination'] },
  risk: 'approval',
  target: (a) => `${a.source} -> ${a.destination}`,
  paths: (a) => [a.source, a.destination],
  async run(a, c) {
    const src = c.validatePath(a.source);
    const dst = c.validatePath(a.destination);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true, errorOnExist: true, force: false });
    return { copied: src, to: dst };
  },
};

export const deleteFile: Tool<{ path: string; recursive?: boolean }> = {
  name: 'delete_file',
  description: 'Permanently delete a file (a folder if recursive).',
  parameters: { type: 'object', properties: { path: PATH, recursive: { type: 'boolean' } }, required: ['path'] },
  risk: 'high',
  target: (a) => a.path,
  detail: (a) => (a.recursive ? 'Deletes the folder and EVERYTHING inside it. Permanent: not sent to the recycle bin.' : 'Permanent: not sent to the recycle bin.'),
  paths: (a) => [a.path],
  precheck: (a, c) => refuseProtected(c.validatePath(a.path), c),
  async run(a, c) {
    const p = c.validatePath(a.path);
    refuseProtected(p, c);
    const st = await fs.lstat(p);
    if (st.isDirectory() && !a.recursive) throw new KappaError('is_directory', `${p} is a folder. Set recursive=true to delete it and its contents.`);
    await fs.rm(p, { recursive: !!a.recursive });
    return { deleted: p };
  },
};

export const filesystemTools = [listDirectory, readFile, createFile, editFile, searchFiles, getFileMetadata, moveFile, copyFile, deleteFile];