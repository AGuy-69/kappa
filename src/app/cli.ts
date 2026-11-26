import dns from 'node:dns';
import path from 'node:path';
import readline from 'node:readline/promises';
import { Conversation } from '../agent/conversation.ts';
import { createDeps, runTurn } from '../agent/agent.ts';
import { loadConfig, useProvider } from '../config.ts';
import { Store } from '../database/database.ts';
import { systemPrompt } from '../agent/context.ts';
import { createGroq } from '../llm/groq.ts';
import { listModels } from '../llm/models.ts';
import type { Approver } from '../security/permissions.ts';
import { errMsg } from '../util/errors.ts';
import { createListener, createSpeaker, sttOptionsFromEnv, ttsOptionsFromEnv } from '../voice/index.ts';
import type { Listener, Speaker } from '../voice/index.ts';
import { createLogger } from '../util/logger.ts';

// Broken IPv6 routes make Node's fetch hang until it times out; prefer IPv4 (KAPPA_DNS_ORDER=verbatim to turn this off).
dns.setDefaultResultOrder(process.env.KAPPA_DNS_ORDER === 'verbatim' ? 'verbatim' : 'ipv4first');
for (const f of ['.env', path.join(import.meta.dirname, '../../.env')]) {
  try { process.loadEnvFile(f); } catch { /* no .env there */ }
}
const cfg = loadConfig();
if (!cfg.apiKey) {
  console.error('No API key found. Copy .env.example to .env and set MISTRAL_API_KEY (console.mistral.ai), GROQ_API_KEY (console.groq.com/keys) and/or GEMINI_API_KEY (aistudio.google.com/apikey).');
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

const store = new Store(path.join(cfg.home, 'kappa.db'));
const log = createLogger(path.join(cfg.home, 'logs', 'kappa.log'), [...Object.values(cfg.providers).map((p) => p.apiKey), cfg.tavilyKey]);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let turn: AbortController | null = null; // set only while a request is running

rl.on('SIGINT', () => {
  if (turn) turn.abort(); // Ctrl+C cancels the running request (model call, tool, or script)
  else console.log('\n(type /exit to quit)');
});
rl.on('close', () => process.exit(0));

const approve: Approver = async (req, signal) => {
  console.log(`\n${yellow('Kappa wants to execute:')} ${req.tool}${req.risk === 'high' ? red('  [HIGH RISK]') : ''}`);
  console.log(`Target: ${req.target}`);
  if (req.detail) console.log(dim(req.detail));
  return /^y(es)?$/i.test((await rl.question('Approve? [y/N] ', { signal })).trim());
};

const deps = createDeps(cfg, { llm: createGroq(cfg), approve, log });
// ---- voice (optional): /voice on speaks Kappa's replies; /listen records you. Approvals always stay on the keyboard. ----
let speaker: Speaker | undefined;
let listener: Listener | undefined;
let voiceOn = false;
process.stdin.on('keypress', () => speaker?.stop()); // any key cuts the voice off (does nothing while it is silent)
process.on('exit', () => speaker?.stop());

/** Push-to-talk: records until you press Enter, then returns what you said ("" if nothing or cancelled). */
async function listen(): Promise<string> {
  speaker?.stop(); // never let the microphone hear Kappa
  const ctl = new AbortController();
  turn = ctl; // Ctrl+C cancels
  try {
    listener ??= createListener(sttOptionsFromEnv());
    const rec = await listener.start(ctl.signal);
    console.log(yellow(`🎤 Listening (${listener.name})… speak, then press Enter to stop. Ctrl+C cancels.`));
    try { await rl.question('', { signal: ctl.signal }); } catch { rec.cancel(); console.log(yellow('⏹ Cancelled.')); return ''; }
    console.log(dim('… transcribing'));
    const text = await rec.stop();
    if (listener.pastes) { // Handy types the text itself, into this prompt
      console.log(dim('Handy will type what you said at the prompt in a moment. Check it, then press Enter to send.'));
      return '';
    }
    if (text) console.log(`${dim('heard:')} ${text}`);
    else console.log(dim('Heard nothing.'));
    return text;
  } catch (e) {
    console.log(red(`Voice: ${errMsg(e)}`));
    return '';
  } finally {
    turn = null;
  }
}

let conv = new Conversation(store, process.argv.includes('--resume') ? store.latest() : undefined);

let midLine = false;
const hooks = {
  onText(s: string) { process.stdout.write(s); midLine = !s.endsWith('\n'); },
  onStatus(msg: string) {
    if (midLine) { console.log(); midLine = false; }
    console.log(dim(`… ${msg}`));
  },
  onToolStart(name: string, args: string) {
    if (midLine) { console.log(); midLine = false; }
    console.log(dim(`⚙ ${name} ${args.length > 140 ? args.slice(0, 140) + '…' : args}`));
  },
  onToolEnd(_name: string, o: { status: string; ms: number; content: string }) {
    let msg = '';
    if (o.status !== 'ok') {
      let text = o.content;
      try { text = JSON.parse(o.content).message ?? text; } catch { /* not JSON */ }
      msg = ` ${text.slice(0, 300)}`;
    }
    console.log(dim(`  ${o.status === 'ok' ? '✓' : '✗'} ${o.status} (${o.ms}ms)${msg}`));
  },
};

console.log(`Kappa ${dim(`${cfg.provider}: ${cfg.model} · search: ${cfg.tavilyKey ? 'Tavily' : 'DuckDuckGo (set TAVILY_API_KEY for reliable search)'} · conversation #${conv.id}${conv.messages.length ? ` (resumed, ${conv.messages.length} messages)` : ''}`)}`);
console.log(dim('Ctrl+C cancels a running task. Commands: /new  /provider [name]  /models  /model <name>  /ping  /net  /voice  /listen  /exit'));

for (;;) {
  let line = (await rl.question('\nyou> ')).trim();
  let spoken = false;
  if (line === '/listen' || line === '/talk' || (!line && voiceOn)) { line = await listen(); spoken = true; } // Enter on an empty line also talks while voice is on
  if (spoken) line = line.replace(/^\/+/, ''); // what you said is never a command
  if (!line) continue;
  if (line === '/exit') break;
  if (line.startsWith('/voice')) {
    const arg = line.slice(6).trim().toLowerCase();
    if (arg === 'on') {
      try { speaker ??= createSpeaker(ttsOptionsFromEnv()); voiceOn = true; } catch (e) { console.log(red(`Voice: ${errMsg(e)}`)); }
    } else if (arg === 'off') {
      voiceOn = false;
      speaker?.stop();
    } else if (arg && arg !== 'status') {
      console.log('Usage: /voice on | off | status');
    }
    console.log(`Voice replies: ${voiceOn ? `on (${speaker?.name})` : 'off'}. ${dim('/listen, or Enter on an empty line while voice is on, to talk. Any key stops the voice.')}`);
    continue;
  }
  if (line === '/new') { conv = new Conversation(store); console.log(`New conversation #${conv.id}`); continue; }
  if (line === '/ping') { // smallest possible request, no tools: tells an account/key problem apart from a request that is too big
    const overhead = Math.round((JSON.stringify(deps.registry.specs()).length + systemPrompt(cfg).length) / 3.5);
    const t0 = Date.now();
    try {
      const r = await deps.llm.chat({ model: cfg.model, messages: [{ role: 'user', content: 'Reply with one word: ok' }], tools: [] });
      console.log(`  ✓ ${cfg.provider} / ${cfg.model} answered "${r.content.trim().slice(0, 60)}" in ${Date.now() - t0}ms`);
      console.log(dim(`  (a normal request also carries about ${overhead} tokens of tools and instructions; if /ping works but chat fails, that is what hits the limit)`));
    } catch (e) {
      console.log(red(`  ✗ ${errMsg(e)}`));
      console.log(dim(/LLM API \d{3}/.test(errMsg(e))
        ? '  The server answered with an error even to a tiny request, so the cause is the account, key or plan, not the size of Kappa\'s requests.'
        : '  The server could not be reached at all. Try /net.'));
    }
    continue;
  }
  if (line === '/models') { // what can this key use? (free plans differ per model, and names change often)
    try {
      const ms = await listModels(cfg);
      console.log(`${cfg.provider} models for your key (${ms.length}). Use /model <id> to try one. ✓ = supports tools:`);
      console.log(ms.map((m) => `  ${m.tools === true ? '✓' : m.tools === false ? '✗' : ' '} ${m.id}`).join('\n'));
    } catch (e) {
      console.log(red(`Could not list models: ${errMsg(e)}`));
    }
    continue;
  }
  if (line === '/net') { // which services can this machine actually reach?
    for (const host of ['api.groq.com', 'generativelanguage.googleapis.com', 'api.tavily.com', 'html.duckduckgo.com']) {
      const t0 = Date.now();
      try {
        const r = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
        console.log(`  ✓ ${host}  HTTP ${r.status}  ${Date.now() - t0}ms`);
      } catch (e) {
        console.log(red(`  ✗ ${host}  ${errMsg(e)}  ${Date.now() - t0}ms`));
      }
    }
    continue;
  }
  if (line.startsWith('/provider')) {
    const want = line.slice(9).trim();
    if (want && !useProvider(cfg, want)) console.log(red(`Unknown provider "${want}".`));
    console.log(`Provider: ${cfg.provider} (${cfg.model}). Available: ${Object.keys(cfg.providers).join(', ')}`);
    continue;
  }
  if (line.startsWith('/model')) {
    cfg.model = line.slice(6).trim() || cfg.model;
    console.log(`Model: ${cfg.model}`);
    continue;
  }
  turn = new AbortController();
  midLine = false;
  const r = await runTurn(deps, conv, line, turn.signal, hooks);
  turn = null;
  if (midLine) console.log();
  if (voiceOn && r.status === 'done' && r.text) { // not awaited: typing is never blocked while she talks
    speaker!.speak(r.text).catch((e) => {
      voiceOn = false;
      console.log(red(`Voice: ${errMsg(e)}`), dim('\nVoice replies turned off. Fix that, then /voice on.'));
    });
  }
  if (r.status === 'cancelled') console.log(yellow('⏹ Cancelled.'));
  else if (r.status === 'max_iterations') console.log(yellow(`Stopped after ${cfg.maxIterations} steps without a final answer. Say "continue" to keep going.`));
  else if (r.status === 'error') {
    console.log(red(`Error: ${r.error}`));
    if (cfg.provider === 'mistral' && /429/.test(r.error ?? ''))
      console.log(yellow('Mistral rejected the request as rate limited. On a brand-new key this usually means the free Experiment plan is not activated yet: check admin.mistral.ai (Subscription, and Limits under La Plateforme).'));
    const others = Object.keys(cfg.providers).filter((n) => n !== cfg.provider);
    if (others.length && /429|quota|rate|5\d\d/i.test(r.error ?? '')) console.log(yellow(`Tip: /provider ${others[0]} to switch, then repeat your request.`));
  }
}
speaker?.stop();
rl.close();