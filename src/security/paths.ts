import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KappaError } from '../util/errors.ts';

// Credential / secret locations that are never readable or writable, whatever the user approves.
// Regex sources are shared with the Python sandbox guard, so keep them plain (no JS-only syntax).
// shortcut: a deny-list is best-effort and cannot know every secret, extend it as needed.
export const DENY_SOURCES = [
  '(^|/)\\.(ssh|aws|gnupg|kube|azure)(/|$)',
  '(^|/)\\.docker/config\\.json$',
  '(^|/)\\.env(\\.(?!example$|sample$|template$)[^/]*)?$',
  '(^|/)id_(rsa|dsa|ecdsa|ed25519)$',
  '\\.(pem|key|pfx|p12|kdbx|ppk)$',
  '(^|/)\\.(git-credentials|netrc|npmrc|pypirc)$',
  '(^|/)(login data|cookies|local state|logins\\.json|key[34]\\.db)$',
  '(^|/)appdata/(roaming|local)/microsoft/(credentials|protect|vault)(/|$)',
  '(^|/)windows/system32/config(/|$)',
];
const DENY = DENY_SOURCES.map((s) => new RegExp(s, 'i'));
const slash = (p: string) => p.replace(/\\/g, '/');

export const isDenied = (p: string): boolean => DENY.some((r) => r.test(slash(p)));

/** True when `child` is `parent` or lies inside it. */
export function inside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// realpath of the deepest existing ancestor + the not-yet-existing remainder (defeats symlink escapes)
function real(p: string): string {
  const rest: string[] = [];
  for (let cur = p; ; ) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return p;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export type PathValidator = (input: string) => string;

/** Returns a function that resolves a user/model path and throws unless it is inside a root and not a protected secret. */
export function makePathValidator(cfg: { roots: string[]; cwd: string }): PathValidator {
  const roots = cfg.roots.map((r) => real(path.resolve(r)));
  return (input) => {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new KappaError('path_invalid', 'Invalid path');
    const expanded = input === '~' || /^~[\\/]/.test(input) ? path.join(os.homedir(), input.slice(1)) : input;
    const resolved = path.resolve(cfg.cwd, expanded);
    const actual = real(resolved);
    if (isDenied(resolved) || isDenied(actual)) throw new KappaError('path_denied', `Access to ${resolved} is blocked: it looks like a credential or secret.`);
    if (!roots.some((r) => inside(r, actual))) throw new KappaError('path_outside_roots', `${resolved} is outside the folders Kappa may access (${cfg.roots.join(', ')}).`);
    return resolved;
  };
}
