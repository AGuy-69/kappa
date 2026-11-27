import dns from 'node:dns';
import path from 'node:path';
import { Conversation } from '../agent/conversation.ts';
import { createDeps } from '../agent/agent.ts';
import { loadConfig } from '../config.ts';
import { Store } from '../database/database.ts';
import { createGroq } from '../llm/groq.ts';
import { createLogger } from '../util/logger.ts';
import { createListener, createSpeaker, sttOptionsFromEnv, ttsOptionsFromEnv } from '../voice/index.ts';
import { runBridge } from './bridge.ts';

// Entry point the desktop dock (dock/) starts. stdout is the protocol channel (see bridge.ts), so problems go to stderr.
// shortcut: this bootstrap is copied from cli.ts, share it if a third entry point appears.
dns.setDefaultResultOrder(process.env.KAPPA_DNS_ORDER === 'verbatim' ? 'verbatim' : 'ipv4first');
for (const f of ['.env', path.join(import.meta.dirname, '../../.env')]) {
  try { process.loadEnvFile(f); } catch { /* no .env there */ }
}
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error('No API key found. Copy .env.example to .env and set MISTRAL_API_KEY, GROQ_API_KEY and/or GEMINI_API_KEY.');
  process.exit(1);
}

const store = new Store(path.join(cfg.home, 'kappa.db'));
const log = createLogger(path.join(cfg.home, 'logs', 'kappa.log'), [...Object.values(cfg.providers).map((p) => p.apiKey), cfg.tavilyKey]);
const deps = createDeps(cfg, { llm: createGroq(cfg), log }); // the bridge installs the approver

process.stdout.on('error', () => process.exit(0)); // the dock is gone
await runBridge({
  deps,
  conv: new Conversation(store, process.argv.includes('--resume') ? store.latest() : undefined),
  newConv: () => new Conversation(store),
  input: process.stdin,
  output: process.stdout,
  makeSpeaker: () => createSpeaker(ttsOptionsFromEnv()),
  makeListener: () => createListener(sttOptionsFromEnv()),
});
process.exit(0);
