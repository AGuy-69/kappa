import type { Config } from '../config.ts';
import type { LLM } from '../llm/groq.ts';
import { makePathValidator } from '../security/paths.ts';
import type { Approver } from '../security/permissions.ts';
import { Registry } from '../tools/registry.ts';
import type { Tool } from '../tools/registry.ts';
import { defaultTools } from '../tools/index.ts';
import { makeWebTools } from '../tools/web.ts';
import { errMsg } from '../util/errors.ts';
import { exec, launch } from '../util/exec.ts';
import type { Exec, Launch } from '../util/exec.ts';
import { nullLogger } from '../util/logger.ts';
import type { Logger } from '../util/logger.ts';
import { clipOld, systemPrompt, trim } from './context.ts';
import type { Conversation } from './conversation.ts';
import { executeToolCall } from './execute-tool.ts';
import type { Outcome, ToolEnv } from './execute-tool.ts';

export interface AgentDeps extends ToolEnv {
  llm: LLM;
}
export interface Hooks {
  onText?(delta: string): void;
  onToolStart?(name: string, args: string): void;
  onToolEnd?(name: string, outcome: Outcome): void;
}
export interface TurnResult {
  status: 'done' | 'cancelled' | 'max_iterations' | 'error';
  text: string;
  iterations: number;
  error?: string;
}

export function createDeps(
  cfg: Config,
  o: { llm: LLM; approve?: Approver; log?: Logger; exec?: Exec; launch?: Launch; fetch?: typeof fetch; extraTools?: Tool[] },
): AgentDeps {
  return {
    cfg,
    llm: o.llm,
    registry: new Registry([...defaultTools, ...makeWebTools(), ...(o.extraTools ?? [])]),
    log: o.log ?? nullLogger,
    exec: o.exec ?? exec,
    launch: o.launch ?? launch,
    fetch: o.fetch ?? fetch,
    validatePath: makePathValidator(cfg),
    approve: o.approve,
  };
}

/** One user request: model -> tool calls -> results -> model ... until the model answers, the limit is hit, or the user cancels. */
export async function runTurn(deps: AgentDeps, conv: Conversation, userText: string, signal: AbortSignal, hooks: Hooks = {}): Promise<TurnResult> {
  const { cfg, llm, registry, log } = deps;
  conv.add({ role: 'user', content: userText });
  log.log('turn_start', { conversation: conv.id, text: userText });

  for (let i = 1; i <= cfg.maxIterations; i++) {
    if (signal.aborted) return { status: 'cancelled', text: '', iterations: i - 1 };

    let reply;
    try {
      reply = await llm.chat({
        model: cfg.model,
        messages: [{ role: 'system', content: systemPrompt(cfg) }, ...trim(clipOld(conv.messages), cfg.contextChars)],
        tools: registry.specs(),
        signal,
        onText: hooks.onText,
      });
    } catch (e) {
      if (signal.aborted) return { status: 'cancelled', text: '', iterations: i };
      log.log('llm_error', { message: errMsg(e) });
      return { status: 'error', text: '', iterations: i, error: errMsg(e) };
    }

    conv.add({ role: 'assistant', content: reply.content || null, ...(reply.tool_calls.length ? { tool_calls: reply.tool_calls } : {}) });
    if (!reply.tool_calls.length) return { status: 'done', text: reply.content, iterations: i };

    for (const call of reply.tool_calls) {
      // Every tool_call needs a matching tool message or the next API request is rejected, even when cancelling.
      if (signal.aborted) {
        conv.add({ role: 'tool', tool_call_id: call.id, content: '{"error":"cancelled","message":"Cancelled by the user."}' });
        continue;
      }
      hooks.onToolStart?.(call.function.name, call.function.arguments);
      const out = await executeToolCall(deps, call, signal);
      hooks.onToolEnd?.(call.function.name, out);
      conv.add({ role: 'tool', tool_call_id: call.id, content: out.content });
    }
  }
  log.log('max_iterations', { limit: cfg.maxIterations });
  return { status: 'max_iterations', text: '', iterations: cfg.maxIterations };
}