import readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { runTurn } from '../agent/agent.ts';
import type { AgentDeps } from '../agent/agent.ts';
import type { Conversation } from '../agent/conversation.ts';
import { errMsg } from '../util/errors.ts';
import type { Listener, Recording, Speaker } from '../voice/index.ts';

/**
 * Line protocol between Kappa and the desktop dock (dock/): one JSON object per line each way, and stdout carries nothing else.
 *
 * dock -> Kappa  {t:'say',text} {t:'approve',id,ok} {t:'cancel'} {t:'new'} {t:'listen',on} {t:'voice',on}
 * Kappa -> dock  {t:'ready'} {t:'state',s:'idle'|'thinking'|'working'|'error',label} {t:'text',d}
 *                {t:'approval',id,tool,risk,target,detail?} {t:'done',status,text,error?} {t:'heard',text} {t:'voice',on,error?}
 *
 * Approvals are answered only by {t:'approve'}; if the dock goes away or the turn is cancelled, every open one is denied.
 */
export interface BridgeOpts {
  deps: AgentDeps;
  conv: Conversation;
  newConv(): Conversation;
  input: Readable;
  output: Writable;
  makeSpeaker(): Speaker;
  makeListener(): Listener;
}

/** Resolves when the dock closes its end. */
export function runBridge(o: BridgeOpts): Promise<void> {
  const { deps } = o;
  let conv = o.conv;
  let turn: AbortController | null = null; // set while a request runs or a recording is open: nothing else may start
  let rec: Recording | null = null;
  let speaker: Speaker | undefined;
  let listener: Listener | undefined;
  let voiceOn = false;
  let closed = false;
  let ids = 0;
  const pending = new Map<number, (ok: boolean) => void>();

  const send = (m: object) => { if (!closed) o.output.write(JSON.stringify(m) + '\n'); };
  const state = (s: string, label = '') => send({ t: 'state', s, label });
  const fail = (msg: string) => { send({ t: 'done', status: 'error', text: '', error: msg }); state('error', msg); };

  deps.approve = (req, signal) => new Promise<boolean>((resolve) => {
    if (closed || signal.aborted) return resolve(false);
    const id = ++ids;
    const finish = (ok: boolean) => { signal.removeEventListener('abort', deny); pending.delete(id); resolve(ok); };
    const deny = () => finish(false);
    signal.addEventListener('abort', deny);
    pending.set(id, finish);
    send({ t: 'approval', id, ...req });
  });

  async function run(text: string) {
    const ctl = (turn = new AbortController());
    state('thinking');
    let streaming = false;
    let r;
    try {
      r = await runTurn(deps, conv, text, ctl.signal, {
        onText(d) { if (!streaming) { streaming = true; state('working', 'Responding'); } send({ t: 'text', d }); },
        onToolStart(name) { streaming = false; state('working', name); },
        onToolEnd() { state('thinking'); },
      });
    } catch (e) { // e.g. the database failed: never leave the dock waiting
      r = { status: 'error' as const, text: '', iterations: 0, error: errMsg(e) };
    }
    turn = null;
    const err = r.status === 'error' ? r.error ?? 'Error' : r.status === 'max_iterations' ? `Stopped after ${deps.cfg.maxIterations} steps. Say "continue".` : '';
    send({ t: 'done', status: r.status, text: r.text, ...(err ? { error: err } : {}) });
    state(err ? 'error' : 'idle', err);
    if (voiceOn && r.status === 'done' && r.text) { // not awaited: she may talk while you do something else
      speaker!.speak(r.text).catch((e) => { voiceOn = false; send({ t: 'voice', on: false, error: errMsg(e) }); });
    }
  }

  async function listen(on: boolean) {
    if (on) {
      if (turn) return;
      speaker?.stop(); // never let the microphone hear Kappa
      const ctl = (turn = new AbortController());
      try {
        listener ??= o.makeListener();
        if (listener.pastes) throw new Error('Handy types into the focused window, so it cannot work with the dock. Set KAPPA_STT to groq or whispercpp.');
        rec = await listener.start(ctl.signal);
        state('thinking', 'Listening');
      } catch (e) { turn = null; fail(errMsg(e)); }
      return;
    }
    if (!rec) return;
    const r = rec;
    rec = null;
    state('thinking', 'Transcribing');
    let text: string;
    try { text = (await r.stop()).trim(); } catch (e) { turn = null; return fail(errMsg(e)); }
    turn = null;
    send({ t: 'heard', text });
    if (text) await run(text); else state('idle');
  }

  const go = (p: Promise<void>) => p.catch((e) => deps.log.log('bridge_error', { message: errMsg(e) }));
  const rl = readline.createInterface({ input: o.input });
  rl.on('line', (line) => {
    let m: Record<string, any> | null;
    try { m = JSON.parse(line); } catch { return; }
    switch (m?.t) {
      case 'say':
        if (typeof m.text === 'string' && m.text.trim() && !turn) go(run(m.text.trim())); // busy: the dock should not offer this
        break;
      case 'approve': pending.get(m.id)?.(m.ok === true); break;
      case 'cancel':
        turn?.abort(); // a running request ends itself with status 'cancelled'
        if (rec) { rec.cancel(); rec = null; turn = null; state('idle'); }
        break;
      case 'new': if (!turn) conv = o.newConv(); break;
      case 'listen': go(listen(m.on === true)); break;
      case 'voice':
        try {
          if (m.on === true) { speaker ??= o.makeSpeaker(); voiceOn = true; } else { voiceOn = false; speaker?.stop(); }
        } catch (e) { voiceOn = false; send({ t: 'voice', on: false, error: errMsg(e) }); break; }
        send({ t: 'voice', on: voiceOn });
        break;
    }
  });

  send({ t: 'ready' });
  return new Promise((resolve) => rl.on('close', () => {
    closed = true;
    turn?.abort(); // also denies any open approval: its signal is this one
    rec?.cancel();
    speaker?.stop();
    resolve();
  }));
}
