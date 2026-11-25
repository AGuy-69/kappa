import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DENY_SOURCES } from '../security/paths.ts';
import { KappaError } from '../util/errors.ts';
import type { Tool, ToolCtx } from './registry.ts';

type Lang = 'python' | 'javascript';
const EXT: Record<Lang, string> = { python: '.py', javascript: '.js' };
const ID = /^[a-z0-9][a-z0-9_-]{0,80}$/;
const RUN_ID = /^[a-z0-9-]{1,40}$/;
const scriptsDir = (c: ToolCtx) => path.join(c.cfg.home, 'scripts');
const runsDir = (c: ToolCtx) => path.join(c.cfg.home, 'runs');

const clip = (s: string, n = 8000) =>
  s.length <= n ? s : `${s.slice(0, n / 2)}\n…[${s.length - n} chars clipped, full text is in the run folder]…\n${s.slice(-n / 2)}`;
const preview = (s: string, lines: number) => {
  const l = s.split('\n');
  return l.slice(0, lines).join('\n') + (l.length > lines ? `\n… (${l.length - lines} more lines)` : '');
};

async function findScript(c: ToolCtx, id: string): Promise<{ file: string; lang: Lang }> {
  if (!ID.test(id)) throw new KappaError('bad_args', 'Invalid script_id');
  for (const lang of ['python', 'javascript'] as const) {
    const file = path.join(scriptsDir(c), id + EXT[lang]);
    if (await fs.access(file).then(() => true, () => false)) return { file, lang };
  }
  throw new KappaError('not_found', `No script "${id}". Create it with create_script first.`);
}

async function syntaxError(c: ToolCtx, lang: Lang, file: string): Promise<string | null> {
  const r =
    lang === 'python'
      ? await c.exec(c.cfg.pythonCmd, ['-I', '-B', '-c', 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1])', file], { timeoutMs: 15_000, signal: c.signal })
      : await c.exec(process.execPath, ['--check', file], { timeoutMs: 15_000, signal: c.signal });
  return r.code === 0 ? null : clip(r.stderr || r.stdout, 2000);
}

// Python has no OS-level permission model we can switch on, so this audit hook blocks writes outside
// the allowed folders, reads of protected secrets, new processes and network sockets.
// shortcut: in-process hook, not a security boundary (a determined script can evade it). Upgrade: container or Windows Sandbox.
const PY_GUARD = String.raw`import sys, os, json, re, runpy
policy = json.load(open(sys.argv[1], encoding="utf-8"))
real = lambda p: os.path.normcase(os.path.realpath(os.fsdecode(p)))
writable = [real(d) for d in policy["write"]]
deny = [re.compile(p, re.I) for p in policy["deny"]]
WRITE_ARGS = {"os.remove": [0], "os.rmdir": [0], "os.mkdir": [0], "os.truncate": [0], "os.chmod": [0],
              "os.rename": [0, 1], "os.symlink": [1], "os.link": [1],
              "shutil.copyfile": [1], "shutil.copytree": [1], "shutil.move": [0, 1], "shutil.rmtree": [0]}
BLOCKED = ("subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "os.spawn", "os.fork",
           "os.startfile", "ctypes.dlopen", "socket.connect", "socket.bind", "socket.sendto")
def can_write(p):
    p = real(p)
    return any(p == d or p.startswith(d + os.sep) for d in writable)
def hook(event, args):
    if event.startswith(BLOCKED):
        raise PermissionError(f"kappa sandbox: {event} is blocked")
    if event == "open" and not isinstance(args[0], int):
        norm = real(args[0]).replace("\\", "/")
        if any(r.search(norm) for r in deny):
            raise PermissionError("kappa sandbox: protected path")
        mode, flags = args[1] or "", args[2] or 0
        if any(c in mode for c in "wax+") or flags & (os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC):
            if not can_write(args[0]):
                raise PermissionError(f"kappa sandbox: write outside allowed folders: {args[0]}")
    elif event in WRITE_ARGS:
        for i in WRITE_ARGS[event]:
            if isinstance(args[i], (str, bytes, os.PathLike)) and not can_write(args[i]):
                raise PermissionError(f"kappa sandbox: {event} outside allowed folders")
sys.addaudithook(hook)
script = sys.argv[2]
sys.argv = [script, *sys.argv[3:]]
runpy.run_path(script, run_name="__main__")
`;

const KEEP_ENV = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'COMSPEC', 'PATHEXT', 'LANG']);
// Scripts never see GROQ_API_KEY or any other secret from Kappa's environment.
const cleanEnv = (): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => v !== undefined && KEEP_ENV.has(k.toUpperCase())) as [string, string][]),
  PYTHONUTF8: '1',
});

const folders = (a: { allow_read?: string[]; allow_write?: string[] }, c: ToolCtx) => ({
  reads: (a.allow_read ?? []).map((p) => c.validatePath(p)),
  writes: (a.allow_write ?? []).map((p) => c.validatePath(p)),
});

export const createScript: Tool<{ name: string; language: Lang; code: string; script_id?: string }> = {
  name: 'create_script',
  description:
    "Save a Python or JavaScript script in Kappa's private scripts folder and check its syntax. It does NOT run it: use execute_script for that. " +
    'To fix or revise a script, call this again with the same script_id.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Short descriptive name' },
      language: { type: 'string', enum: ['python', 'javascript'] },
      code: { type: 'string', description: 'Complete script source' },
      script_id: { type: 'string', description: 'Existing script_id to overwrite with a revised version' },
    },
    required: ['name', 'language', 'code'],
  },
  // Low risk by design: it only writes inside Kappa's own scripts folder and nothing runs.
  // The user sees the full code at the execute_script approval. Change to 'approval' for a prompt here too.
  risk: 'low',
  target: (a) => `${a.name} (${a.language})`,
  async run(a, c) {
    const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'script';
    const id = a.script_id ?? `${slug}-${Date.now().toString(36)}`;
    if (!ID.test(id)) throw new KappaError('bad_args', 'Invalid script_id');
    const file = path.join(scriptsDir(c), id + EXT[a.language]);
    await fs.mkdir(scriptsDir(c), { recursive: true });
    await fs.writeFile(file, a.code, 'utf8');
    const err = await syntaxError(c, a.language, file);
    return { script_id: id, path: file, language: a.language, syntax_ok: err === null, syntax_error: err ?? undefined };
  },
};

export const executeScript: Tool<{ script_id: string; args?: string[]; timeout_seconds?: number; allow_read?: string[]; allow_write?: string[] }> = {
  name: 'execute_script',
  description:
    'Run a script created with create_script in a restricted environment and return its exit code, stdout and stderr. ' +
    "By default a script can write only to its own run folder (its working directory). Grant more with allow_write / allow_read; the user approves exactly what is granted. " +
    'Scripts cannot start other programs. JavaScript can read only its run folder plus allow_read folders.',
  parameters: {
    type: 'object',
    properties: {
      script_id: { type: 'string' },
      args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments' },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 300, description: 'Default 30' },
      allow_read: { type: 'array', items: { type: 'string' }, description: 'Extra folders the script may read (needed for JavaScript)' },
      allow_write: { type: 'array', items: { type: 'string' }, description: 'Extra folders the script may write, e.g. where an output file should go' },
    },
    required: ['script_id'],
  },
  risk: 'approval',
  timeoutMs: 330_000, // the script's own timeout (max 300s) fires first; this is the harness backstop
  target: (a) => a.script_id,
  paths: (a) => [...(a.allow_read ?? []), ...(a.allow_write ?? [])],
  async detail(a, c) {
    const { file, lang } = await findScript(c, a.script_id);
    const { reads, writes } = folders(a, c);
    return [
      `Language: ${lang}, timeout ${a.timeout_seconds ?? 30}s`,
      lang === 'python'
        ? 'Can read: any file you can read, except protected secrets (Python reads are not strictly sandboxed)'
        : `Can read: its run folder${reads.map((r) => `, ${r}`).join('')}`,
      `Can write: its run folder${writes.map((w) => `, ${w}`).join('')}`,
      `Network: ${lang === 'python' ? 'blocked' : 'NOT restricted (Node cannot block it)'}. Cannot start other programs.`,
      '--- code ---',
      preview(await fs.readFile(file, 'utf8'), 60),
    ].join('\n');
  },
  async run(a, c) {
    const { file, lang } = await findScript(c, a.script_id);
    const { reads, writes } = folders(a, c);
    const runId = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
    const runDir = path.join(runsDir(c), runId);
    await fs.mkdir(runDir, { recursive: true });

    let cmd: string;
    let args: string[];
    if (lang === 'javascript') {
      cmd = process.execPath;
      args = [
        '--permission',
        `--allow-fs-read=${runDir}`, `--allow-fs-read=${file}`, ...reads.map((r) => `--allow-fs-read=${r}`),
        `--allow-fs-write=${runDir}`, ...writes.map((w) => `--allow-fs-write=${w}`),
        '--max-old-space-size=512',
        file, ...(a.args ?? []),
      ];
    } else {
      const guard = path.join(runDir, '_guard.py');
      const policy = path.join(runDir, '_policy.json');
      await fs.writeFile(guard, PY_GUARD);
      await fs.writeFile(policy, JSON.stringify({ write: [runDir, ...writes], deny: DENY_SOURCES }));
      cmd = c.cfg.pythonCmd;
      args = ['-I', '-B', guard, policy, file, ...(a.args ?? [])];
    }

    const t0 = Date.now();
    const r = await c.exec(cmd, args, { cwd: runDir, env: cleanEnv(), timeoutMs: (a.timeout_seconds ?? 30) * 1000, signal: c.signal });
    const status = r.aborted ? 'cancelled' : r.timedOut ? 'timeout' : r.code === 0 ? 'ok' : 'failed';
    const blocked = /kappa sandbox|ERR_ACCESS_DENIED/.test(r.stderr);
    const result = {
      run_id: runId,
      script_id: a.script_id,
      status,
      exit_code: r.code,
      duration_ms: Date.now() - t0,
      stdout: clip(r.stdout),
      stderr: clip(r.stderr),
      output_truncated: r.truncated,
      run_folder: runDir,
      hint: blocked
        ? 'Blocked by the sandbox. If the script legitimately needs a folder, call execute_script again with allow_read / allow_write (the user must approve).'
        : status === 'failed'
          ? 'Read stderr, fix the script with create_script (same script_id) and run it again.'
          : undefined,
    };
    await fs.writeFile(path.join(runDir, 'stdout.txt'), r.stdout);
    await fs.writeFile(path.join(runDir, 'stderr.txt'), r.stderr);
    await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify(result));
    return result;
  },
};

export const getExecutionResult: Tool<{ run_id: string }> = {
  name: 'get_execution_result',
  description: 'Fetch the stored result (status, exit code, stdout, stderr) of an earlier execute_script run by run_id.',
  parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'] },
  risk: 'low',
  target: (a) => a.run_id,
  async run(a, c) {
    if (!RUN_ID.test(a.run_id)) throw new KappaError('bad_args', 'Invalid run_id');
    const file = path.join(runsDir(c), a.run_id, 'result.json');
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      throw new KappaError('not_found', `No finished run "${a.run_id}"`);
    }
  },
};

export const scriptTools = [createScript, executeScript, getExecutionResult];
