import type { Config } from '../config.ts';
import type { ToolCall } from '../llm/groq.ts';
import { authorize, riskOf } from '../security/permissions.ts';
import type { Approver } from '../security/permissions.ts';
import type { PathValidator } from '../security/paths.ts';
import { validate } from '../tools/registry.ts';
import type { Registry, ToolCtx } from '../tools/registry.ts';
import { KappaError, errMsg } from '../util/errors.ts';
import type { Exec, Launch } from '../util/exec.ts';
import type { Logger } from '../util/logger.ts';

export interface ToolEnv {
  cfg: Config;
  registry: Registry;
  log: Logger;
  exec: Exec;
  launch: Launch;
  fetch: typeof fetch;
  validatePath: PathValidator;
  approve?: Approver;
}
export type Status = 'ok' | 'error' | 'denied' | 'invalid';
export interface Outcome {
  status: Status;
  content: string; // exactly what the model is shown
  ms: number;
}

// Abort/timeout must free the harness even if a tool ignores its signal.
const abortable = <T>(p: Promise<T>, s: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (s.aborted) return reject(s.reason);
    s.addEventListener('abort', () => reject(s.reason), { once: true });
    p.then(resolve, reject);
  });

/**
 * The only path from a model tool call to a side effect:
 * lookup -> parse -> schema validation -> path validation -> permission check -> timed execution.
 * Never throws; every failure becomes a result the model can read and recover from.
 */
export async function executeToolCall(env: ToolEnv, call: ToolCall, signal: AbortSignal): Promise<Outcome> {
  const { name } = call.function;
  const t0 = Date.now();
  const finish = (status: Status, payload: unknown): Outcome => {
    let content = JSON.stringify(payload ?? null);
    const max = env.cfg.maxResultChars;
    if (content.length > max) content = `${content.slice(0, max)}…[result truncated, ${content.length - max} more chars]`;
    const ms = Date.now() - t0;
    env.log.log('tool', { name, status, ms, args: call.function.arguments, result: content });
    return { status, content, ms };
  };
  const fail = (status: Status, code: string, message: string) => finish(status, { error: code, message });

  const tool = env.registry.get(name);
  if (!tool) return fail('invalid', 'unknown_tool', `There is no tool named "${name}". Available tools: ${env.registry.names().join(', ')}`);

  let args: any;
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return fail('invalid', 'bad_json', 'The arguments were not valid JSON. Send a single JSON object.');
  }
  if (args && typeof args === 'object') for (const k of Object.keys(args)) if (args[k] === null) delete args[k]; // models send null for "omitted"
  const errs = validate(tool.parameters, args);
  if (errs.length) return fail('invalid', 'invalid_arguments', errs.join('; '));

  let runSignal: AbortSignal | undefined;
  try {
    const ctx: ToolCtx = { cfg: env.cfg, signal, exec: env.exec, launch: env.launch, fetch: env.fetch, log: env.log, validatePath: env.validatePath };
    for (const p of tool.paths?.(args) ?? []) env.validatePath(p); // blocked paths never reach a prompt
    tool.precheck?.(args, ctx);

    const risk = riskOf(tool, args);
    if (risk !== 'low') {
      const approved = await authorize({ tool: name, risk, target: tool.target(args), detail: await tool.detail?.(args, ctx) }, env.approve, signal);
      env.log.log('approval', { tool: name, risk, target: tool.target(args), approved });
      if (!approved) return fail('denied', 'not_approved', `The user did not approve ${name}. It was NOT executed. Do not retry it unless the user asks again.`);
    }

    const ms = tool.timeoutMs ?? env.cfg.toolTimeoutMs;
    runSignal = AbortSignal.any([signal, AbortSignal.timeout(ms)]); // the clock starts after approval, not before
    return finish('ok', await abortable(tool.run(args, { ...ctx, signal: runSignal }), runSignal));
  } catch (e) {
    if (signal.aborted) return fail('error', 'cancelled', 'Cancelled by the user.');
    if (runSignal?.aborted) return fail('error', 'timeout', `${name} timed out after ${(tool.timeoutMs ?? env.cfg.toolTimeoutMs) / 1000}s.`);
    if (e instanceof KappaError) return fail(/^path_|^protected$/.test(e.code) ? 'denied' : 'error', e.code, e.message);
    return fail('error', 'tool_failed', errMsg(e));
  }
}