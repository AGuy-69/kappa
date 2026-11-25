import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';
export const MISTRAL_URL = 'https://api.mistral.ai/v1';

export interface Provider {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface Config {
  providers: Record<string, Provider>; // every provider that has a key in the environment
  provider: string; // the active one; apiKey / baseUrl / model below mirror it
  apiKey: string;
  tavilyKey: string; // optional: reliable web search (https://tavily.com, free tier)
  model: string;
  baseUrl: string;
  home: string; // Kappa's own data: db, logs, scripts, runs
  cwd: string; // relative paths resolve against this
  roots: string[]; // the only folders the filesystem tools may touch
  maxIterations: number;
  toolTimeoutMs: number;
  maxResultChars: number; // cap on one tool result fed back to the model
  contextChars: number; // history budget before old turns are dropped
  pythonCmd: string;
  reasoning: string; // gpt-oss reasoning effort: low | medium | high. Lower = far fewer output tokens
}

/** Switch the active provider. Returns false for an unknown name. Only call between requests, never mid-task. */
export function useProvider(cfg: Config, name: string): boolean {
  const p = cfg.providers[name];
  if (!p) return false;
  Object.assign(cfg, { provider: name, apiKey: p.apiKey, baseUrl: p.baseUrl, model: p.model });
  return true;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (k: string, d: number) => (Number(env[k]) > 0 ? Number(env[k]) : d);
  const providers: Record<string, Provider> = {};
  // GROQ_BASE_URL still works for any single OpenAI-compatible server (OmniRoute, OpenRouter, ...)
  if (env.GROQ_API_KEY) providers.groq = { apiKey: env.GROQ_API_KEY, baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', model: env.KAPPA_GROQ_MODEL || env.KAPPA_MODEL || DEFAULT_MODEL };
  if (env.GEMINI_API_KEY) providers.gemini = { apiKey: env.GEMINI_API_KEY, baseUrl: GEMINI_URL, model: env.KAPPA_GEMINI_MODEL || 'gemini-3.7-flash' };
  if (env.MISTRAL_API_KEY) providers.mistral = { apiKey: env.MISTRAL_API_KEY, baseUrl: MISTRAL_URL, model: env.KAPPA_MISTRAL_MODEL || 'mistral-small-latest' };
  const cfg: Config = {
    providers,
    provider: '',
    apiKey: '',
    tavilyKey: env.TAVILY_API_KEY ?? '',
    model: env.KAPPA_MODEL || DEFAULT_MODEL,
    baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    home: path.resolve(env.KAPPA_HOME || path.join(os.homedir(), '.kappa')),
    cwd: process.cwd(),
    roots: env.KAPPA_FS_ROOTS ? env.KAPPA_FS_ROOTS.split(path.delimiter).filter(Boolean) : [os.homedir(), os.tmpdir()],
    maxIterations: num('KAPPA_MAX_ITERATIONS', 15),
    toolTimeoutMs: num('KAPPA_TOOL_TIMEOUT_MS', 60_000),
    maxResultChars: num('KAPPA_MAX_RESULT_CHARS', 12_000),
    contextChars: num('KAPPA_CONTEXT_CHARS', 40_000),
    reasoning: env.KAPPA_REASONING || 'low',
    pythonCmd: env.KAPPA_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
  };
  useProvider(cfg, providers[env.KAPPA_PROVIDER ?? ''] ? env.KAPPA_PROVIDER! : Object.keys(providers)[0] ?? '');
  return cfg;
}