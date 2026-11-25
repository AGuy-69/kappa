import fs from 'node:fs';
import path from 'node:path';

export interface Logger {
  log(event: string, data?: Record<string, unknown>): void;
}
export const nullLogger: Logger = { log() {} };

// JSON lines. Long strings are clipped and any secret (the API key) is redacted.
export function createLogger(file: string, secrets: string[] = []): Logger {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return {
    log(event, data = {}) {
      let line = JSON.stringify({ ts: new Date().toISOString(), event, ...data }, (_k, v) =>
        typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…(${v.length} chars)` : v,
      );
      for (const s of secrets) if (s) line = line.split(s).join('[redacted]');
      try {
        fs.appendFileSync(file, line + '\n');
      } catch {
        // logging must never take the agent down
      }
    },
  };
}
