import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeps, runTurn } from '../src/agent/agent.ts';
import { Conversation } from '../src/agent/conversation.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { Store } from '../src/database/database.ts';
import type { ChatOpts, LLM, Msg, Reply } from '../src/llm/groq.ts';
import type { ApprovalRequest, Approver } from '../src/security/permissions.ts';
import type { Tool } from '../src/tools/registry.ts';
import type { Exec, Launch } from '../src/util/exec.ts';

export const say = (content: string): Reply => ({ content, tool_calls: [], finish_reason: 'stop' });
let n = 0;
export const use = (...calls: [string, unknown][]): Reply => ({
  content: '',
  finish_reason: 'tool_calls',
  tool_calls: calls.map(([name, args]) => ({
    id: `call_${++n}`,
    type: 'function' as const,
    function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
  })),
});

export type Step = Reply | ((o: ChatOpts) => Reply);
/** A fake model that follows a script. Everything downstream of it (harness, tools, sandbox, SQLite) is real. */
export function scriptedLLM() {
  const steps: Step[] = [];
  const calls: ChatOpts[] = [];
  const llm: LLM = {
    async chat(o) {
      calls.push({ ...o, messages: [...o.messages] });
      const s = steps[calls.length - 1];
      if (!s) throw new Error(`scripted model ran out of steps (call #${calls.length})`);
      return typeof s === 'function' ? s(o) : s;
    },
  };
  return { llm, steps, calls };
}

export const lastTool = (o: ChatOpts): any => JSON.parse([...o.messages].reverse().find((m) => m.role === 'tool')!.content!);
export const hasPython = spawnSync(loadConfig({}).pythonCmd, ['--version']).status === 0;

export function setup(opts: { approve?: boolean | Approver | 'none'; cfg?: Partial<Config>; exec?: Exec; launch?: Launch; fetch?: typeof fetch; extraTools?: Tool[] } = {}) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kappa-test-')));
  const work = path.join(tmp, 'work');
  const home = path.join(tmp, 'kappa-home');
  fs.mkdirSync(work);
  const cfg: Config = { ...loadConfig({}), apiKey: 'test', home, cwd: work, roots: [work, home], ...opts.cfg };
  const approvals: ApprovalRequest[] = [];
  const a = opts.approve;
  const approve: Approver | undefined =
    a === 'none' ? undefined
    : typeof a === 'function' ? async (r, sig) => (approvals.push(r), a(r, sig))
    : async (r) => (approvals.push(r), a ?? true);
  const launched: [string, string[]][] = [];
  const launch: Launch = opts.launch ?? (async (cmd, args) => void launched.push([cmd, args]));
  const { llm, steps, calls } = scriptedLLM();
  const store = new Store(':memory:');
  const conv = new Conversation(store);
  const deps = createDeps(cfg, { llm, approve, exec: opts.exec, launch, fetch: opts.fetch, extraTools: opts.extraTools });
  return {
    tmp, work, home, cfg, approvals, launched, store, conv, deps, llm: { calls },
    script: (...s: Step[]) => void steps.push(...s),
    run: (text: string, signal: AbortSignal = new AbortController().signal) => runTurn(deps, conv, text, signal),
    /** Parsed results of every tool message, in order. */
    results: (): any[] => conv.messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!)),
  };
}

/** Every assistant tool_call must be answered by a tool message, or the next API request is rejected. */
export function toolCallsAnswered(msgs: Msg[]): boolean {
  const asked = msgs.flatMap((m) => m.tool_calls?.map((c) => c.id) ?? []);
  const answered = new Set(msgs.filter((m) => m.role === 'tool').map((m) => m.tool_call_id));
  return asked.every((id) => answered.has(id));
}