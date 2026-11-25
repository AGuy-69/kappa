import type { Config } from '../config.ts';
import type { PathValidator } from '../security/paths.ts';
import type { Exec, Launch } from '../util/exec.ts';
import type { Logger } from '../util/logger.ts';

export type Risk = 'low' | 'approval' | 'high';

export interface Prop {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  description?: string;
  enum?: unknown[];
  items?: Prop;
  minimum?: number;
  maximum?: number;
}
export interface Schema {
  type: 'object';
  properties: Record<string, Prop>;
  required?: string[];
}

export interface ToolCtx {
  cfg: Config;
  signal: AbortSignal;
  exec: Exec;
  launch: Launch;
  fetch: typeof fetch;
  log: Logger;
  validatePath: PathValidator;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  parameters: Schema;
  /** Declared by the tool author, enforced by the harness. The model never sees or sets it. */
  risk: Risk | ((args: A) => Risk);
  /** Short human description of what is acted on (shown at approval and logged). */
  target(args: A): string;
  /** Extra text shown at approval, e.g. the content about to be written. */
  detail?(args: A, ctx: ToolCtx): string | Promise<string>;
  /** Paths to validate before anything else happens (so a blocked path never reaches a prompt). */
  paths?(args: A): string[];
  /** Throws to refuse a call outright (before any approval prompt). */
  precheck?(args: A, ctx: ToolCtx): void;
  /** Harness-enforced ceiling for run(); defaults to cfg.toolTimeoutMs. */
  timeoutMs?: number;
  run(args: A, ctx: ToolCtx): Promise<unknown>;
}

function check(p: Prop, v: unknown, at: string, errs: string[]): void {
  const got = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : got === p.type;
  if (!ok) return void errs.push(`${at}: expected ${p.type}, got ${got}`);
  if (p.enum && !p.enum.includes(v)) errs.push(`${at}: must be one of ${p.enum.join(', ')}`);
  if (typeof v === 'number') {
    if (p.minimum !== undefined && v < p.minimum) errs.push(`${at}: must be >= ${p.minimum}`);
    if (p.maximum !== undefined && v > p.maximum) errs.push(`${at}: must be <= ${p.maximum}`);
  }
  if (Array.isArray(v) && p.items) v.forEach((x, i) => check(p.items!, x, `${at}[${i}]`, errs));
}

/** Validates model-supplied arguments against the tool schema. Unknown arguments are rejected. */
export function validate(schema: Schema, args: unknown): string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return ['arguments must be a JSON object'];
  const errs: string[] = [];
  const a = args as Record<string, unknown>;
  for (const k of schema.required ?? []) if (a[k] === undefined) errs.push(`${k}: required`);
  for (const [k, v] of Object.entries(a)) {
    const p = schema.properties[k];
    if (!p) errs.push(`${k}: unknown argument`);
    else check(p, v, k, errs);
  }
  return errs;
}

export class Registry {
  private tools = new Map<string, Tool>();
  constructor(tools: Tool[]) {
    for (const t of tools) this.tools.set(t.name, t);
  }
  get = (name: string) => this.tools.get(name);
  names = () => [...this.tools.keys()];
  /** OpenAI/Groq function-calling format. */
  specs = () =>
    [...this.tools.values()].map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
}