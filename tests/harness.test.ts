import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { Conversation } from '../src/agent/conversation.ts';
import type { Tool } from '../src/tools/registry.ts';
import { hasPython, lastTool, say, setup, toolCallsAnswered, use } from './helpers.ts';

const py = { skip: !hasPython && 'python not installed' };

test('1. normal conversation without tools', async () => {
  const t = setup();
  t.script(say('Hello! How can I help?'));
  const r = await t.run('hi');
  assert.equal(r.status, 'done');
  assert.equal(r.text, 'Hello! How can I help?');
  assert.deepEqual(t.conv.messages.map((m) => m.role), ['user', 'assistant']);
  assert.equal(t.approvals.length, 0);
  const first = t.llm.calls[0];
  assert.equal(first.messages[0].role, 'system');
  assert.ok(first.tools.length >= 18, 'all tools are offered to the model');
});

test('2. list a directory', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.work, 'a.txt'), 'A');
  fs.mkdirSync(path.join(t.work, 'sub'));
  t.script(use(['list_directory', { path: '.' }]), (o) => say(`found ${lastTool(o).entries.map((e: any) => e.name).sort()}`));
  const r = await t.run('what is here?');
  assert.equal(r.text, 'found a.txt,sub');
  assert.equal(t.approvals.length, 0, 'reading needs no approval');
});

test('3. read a file', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.work, 'note.txt'), 'line1\nline2');
  t.script(use(['read_file', { path: 'note.txt' }]), (o) => say(lastTool(o).content));
  assert.equal((await t.run('read note.txt')).text, 'line1\nline2');
});

test('4. create a file (approval required; decline is respected)', async () => {
  const t = setup();
  t.script(use(['create_file', { path: 'out/new.txt', content: 'hi' }]), say('done'));
  await t.run('make it');
  assert.equal(fs.readFileSync(path.join(t.work, 'out/new.txt'), 'utf8'), 'hi');
  assert.equal(t.approvals[0].tool, 'create_file');
  assert.equal(t.approvals[0].risk, 'approval');

  const d = setup({ approve: false });
  d.script(use(['create_file', { path: 'nope.txt', content: 'x' }]), say('ok'));
  await d.run('make it');
  assert.equal(fs.existsSync(path.join(d.work, 'nope.txt')), false);
  assert.equal(d.results()[0].error, 'not_approved');
});

test('5. edit a file', async () => {
  const t = setup();
  const f = path.join(t.work, 'e.txt');
  fs.writeFileSync(f, 'a b a');
  t.script(
    use(['edit_file', { path: 'e.txt', old_text: 'a', new_text: 'z' }]), // ambiguous
    use(['edit_file', { path: 'e.txt', old_text: 'b', new_text: 'B' }]),
    say('ok'),
  );
  await t.run('edit');
  assert.equal(t.results()[0].error, 'ambiguous');
  assert.equal(fs.readFileSync(f, 'utf8'), 'a B a');
});

test('6a. generate and execute a Python script', py, async () => {
  const t = setup();
  t.script(
    use(['create_script', { name: 'answer', language: 'python', code: 'print(6*7)' }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id }]),
    (o) => say(`output: ${lastTool(o).stdout.trim()}`),
  );
  const r = await t.run('compute');
  assert.equal(r.text, 'output: 42');
  const exec = t.approvals.find((a) => a.tool === 'execute_script')!;
  assert.match(exec.detail!, /print\(6\*7\)/, 'the user is shown the code that will run');
  assert.equal(t.results()[0].syntax_ok, true);
  assert.equal(t.results()[1].status, 'ok');
  // the stored result can be fetched again
  t.script(use(['get_execution_result', { run_id: t.results()[1].run_id }]), say('fetched'));
  await t.run('again');
  assert.equal(t.results()[2].stdout.trim(), '42');
});

test('6b. the Downloads example: script lists a folder and saves a text file where it was allowed to', py, async () => {
  const t = setup();
  const src = path.join(t.work, 'downloads');
  const dst = path.join(t.work, 'out');
  fs.mkdirSync(src); fs.mkdirSync(dst);
  fs.writeFileSync(path.join(src, 'b.pdf'), ''); fs.writeFileSync(path.join(src, 'a.zip'), '');
  const code = "import os, sys\nsrc, dst = sys.argv[1], sys.argv[2]\nopen(os.path.join(dst, 'listing.txt'), 'w').write('\\n'.join(sorted(os.listdir(src))))\n";
  t.script(
    use(['create_script', { name: 'list downloads', language: 'python', code }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id, args: [src, dst], allow_write: [dst] }]),
    say('saved'),
  );
  await t.run('list my downloads into a text file');
  assert.equal(t.results()[1].status, 'ok', JSON.stringify(t.results()[1]));
  assert.equal(fs.readFileSync(path.join(dst, 'listing.txt'), 'utf8'), 'a.zip\nb.pdf');
  assert.match(t.approvals.find((a) => a.tool === 'execute_script')!.detail!, /Can write: .*out/);
});

test('6c. Python sandbox blocks writes outside the granted folders, and reports it', py, async () => {
  const t = setup();
  const outside = path.join(t.work, 'outside.txt');
  t.script(
    use(['create_script', { name: 'bad', language: 'python', code: 'import sys\nopen(sys.argv[1], "w").write("x")' }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id, args: [outside] }]),
    say('blocked'),
  );
  await t.run('go');
  const r = t.results()[1];
  assert.equal(r.status, 'failed');
  assert.match(r.stderr, /kappa sandbox/);
  assert.match(r.hint, /allow_write/);
  assert.equal(fs.existsSync(outside), false);
});

test('6d. scripts do not inherit secrets from the environment', py, async () => {
  process.env.KAPPA_TEST_SECRET = 'leak';
  try {
    const t = setup();
    t.script(
      use(['create_script', { name: 'env', language: 'python', code: 'import os; print(os.environ.get("KAPPA_TEST_SECRET"))' }]),
      (o) => use(['execute_script', { script_id: lastTool(o).script_id }]),
      say('ok'),
    );
    await t.run('go');
    assert.equal(t.results()[1].stdout.trim(), 'None');
  } finally {
    delete process.env.KAPPA_TEST_SECRET;
  }
});

test('7a. generate and execute a JavaScript script', async () => {
  const t = setup();
  t.script(
    use(['create_script', { name: 'sum', language: 'javascript', code: 'console.log(JSON.stringify({ sum: [1, 2, 3].reduce((a, b) => a + b) }))' }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id }]),
    (o) => say(lastTool(o).stdout.trim()),
  );
  assert.equal((await t.run('sum')).text, '{"sum":6}');
});

test('7b. JavaScript runs under the Node permission model: no writes outside, no child processes', async () => {
  const t = setup();
  const outside = path.join(t.work, 'outside.txt');
  const code = 'const fs=require("fs"),cp=require("child_process");const r={};' +
    'try{fs.writeFileSync(process.argv[2],"x");r.write="ALLOWED"}catch(e){r.write=e.code}' +
    'try{cp.execSync("echo hi");r.spawn="ALLOWED"}catch(e){r.spawn=e.code}' +
    'console.log(JSON.stringify(r))';
  t.script(
    use(['create_script', { name: 'probe', language: 'javascript', code }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id, args: [outside] }]),
    say('done'),
  );
  await t.run('probe');
  assert.deepEqual(JSON.parse(t.results()[1].stdout), { write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED' });
  assert.equal(fs.existsSync(outside), false);
});

test('8. invalid tool calls are rejected without executing anything', async () => {
  const t = setup();
  const victim = path.join(t.work, 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  t.script(
    use(
      ['no_such_tool', {}],
      ['read_file', '{not json'],
      ['read_file', { path: 42 }],
      ['delete_file', { path: 'victim.txt', approved: true }], // the model cannot grant itself permission
    ),
    say('recovered'),
  );
  const r = await t.run('go');
  assert.equal(r.status, 'done');
  assert.deepEqual(t.results().map((x) => x.error), ['unknown_tool', 'bad_json', 'invalid_arguments', 'invalid_arguments']);
  assert.match(t.results()[3].message, /approved: unknown argument/);
  assert.equal(fs.existsSync(victim), true);
  assert.equal(t.approvals.length, 0);
  assert.ok(toolCallsAnswered(t.conv.messages));
});

test('9. unauthorized destructive operations are rejected', async () => {
  const mk = (approve: any) => {
    const t = setup({ approve });
    fs.writeFileSync(path.join(t.work, 'x.txt'), 'x');
    t.script(use(['delete_file', { path: 'x.txt' }]), say('ok'));
    return t;
  };
  const declined = mk(false);
  await declined.run('delete x.txt');
  assert.equal(declined.results()[0].error, 'not_approved');
  assert.equal(declined.approvals[0].risk, 'high');
  assert.equal(fs.existsSync(path.join(declined.work, 'x.txt')), true);

  const noApprover = mk('none'); // a missing approval is never an approval
  await noApprover.run('delete x.txt');
  assert.equal(noApprover.results()[0].error, 'not_approved');
  assert.equal(fs.existsSync(path.join(noApprover.work, 'x.txt')), true);

  const approved = mk(true); // positive control: the same call does run once a human says yes
  await approved.run('delete x.txt');
  assert.equal(fs.existsSync(path.join(approved.work, 'x.txt')), false);
});

test('9b. protected locations and secrets are refused before any prompt', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.work, '.ssh'));
  fs.writeFileSync(path.join(t.work, '.ssh', 'id_rsa'), 'PRIVATE');
  const outside = path.join(t.tmp, 'elsewhere.txt');
  fs.writeFileSync(outside, 'x');
  t.script(
    use(
      ['read_file', { path: '.ssh/id_rsa' }],
      ['create_file', { path: '.env', content: 'K=v' }],
      ['read_file', { path: outside }],
      ['read_file', { path: '../elsewhere.txt' }],
      ['delete_file', { path: '.', recursive: true }], // a configured root
    ),
    say('ok'),
  );
  await t.run('go');
  assert.deepEqual(t.results().map((r) => r.error), ['path_denied', 'path_denied', 'path_outside_roots', 'path_outside_roots', 'protected']);
  assert.equal(t.approvals.length, 0, 'none of these may even reach the user as a prompt');
  assert.equal(fs.existsSync(path.join(t.work, '.env')), false);
});

test('10. a tool failure is reported to the model, which can carry on', async () => {
  const t = setup();
  t.script(use(['read_file', { path: 'missing.txt' }]), (o) => say(`failed: ${lastTool(o).error}`));
  const r = await t.run('read missing.txt');
  assert.equal(r.status, 'done');
  assert.equal(r.text, 'failed: tool_failed');
  assert.match(t.results()[0].message, /ENOENT/);
});

test('11. several tools in sequence within one request', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.work, 'a.py'), '');
  fs.writeFileSync(path.join(t.work, 'b.py'), '');
  fs.writeFileSync(path.join(t.work, 'c.txt'), '');
  t.script(
    use(['search_files', { path: '.', name_pattern: '*.py' }]),
    (o) => use(['create_file', { path: 'report.txt', content: lastTool(o).results.map((r: any) => path.basename(r.path)).sort().join(',') }]),
    use(['read_file', { path: 'report.txt' }]),
    (o) => say(`report: ${lastTool(o).content}`),
  );
  const r = await t.run('find python files and write a report');
  assert.equal(r.text, 'report: a.py,b.py');
  assert.equal(r.iterations, 4);
});

test('11b. search_files finds text inside files', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.work, 'd'));
  fs.writeFileSync(path.join(t.work, 'd', 'x.txt'), 'one\nNeedle here\nthree');
  fs.writeFileSync(path.join(t.work, 'y.txt'), 'nothing');
  t.script(use(['search_files', { path: '.', content: 'needle' }]), say('ok'));
  await t.run('search');
  const res = t.results()[0].results;
  assert.equal(res.length, 1);
  assert.equal(res[0].line, 2);
});

test('12. recovers from a script error by revising and rerunning', py, async () => {
  const t = setup();
  t.script(
    use(['create_script', { name: 'avg', language: 'python', code: 'print(total / 3)' }]), // bug: undefined name
    (o) => use(['execute_script', { script_id: lastTool(o).script_id }]),
    (o) => use(['create_script', { name: 'avg', language: 'python', script_id: t.results()[0].script_id, code: 'total = 9\nprint(total / 3)' }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id }]),
    (o) => say(`fixed: ${lastTool(o).stdout.trim()}`),
  );
  const r = await t.run('average');
  assert.equal(t.results()[1].status, 'failed');
  assert.match(t.results()[1].stderr, /NameError/);
  assert.match(t.results()[1].hint, /fix the script/);
  assert.equal(r.text, 'fixed: 3.0');
  assert.equal(t.approvals.filter((a) => a.tool === 'execute_script').length, 2, 'each run is approved separately');
});

test('12b. a syntax error is caught at create_script, before anything runs', async () => {
  const t = setup();
  t.script(use(['create_script', { name: 'bad', language: 'javascript', code: 'const = ;' }]), say('ok'));
  await t.run('x');
  assert.equal(t.results()[0].syntax_ok, false);
  assert.ok(t.results()[0].syntax_error);
});

test('13. cancelling a running task kills the script and leaves a valid history', py, async () => {
  const ac = new AbortController();
  const t = setup({ approve: async (req) => (req.tool === 'execute_script' && setTimeout(() => ac.abort(), 1200), true) });
  t.script(
    use(['create_script', { name: 'sleeper', language: 'python', code: 'import os, time\nopen("pid.txt", "w").write(str(os.getpid()))\ntime.sleep(60)' }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id, timeout_seconds: 120 }]),
    say('should never get here'),
  );
  const t0 = Date.now();
  const r = await t.run('sleep for a minute', ac.signal);
  assert.equal(r.status, 'cancelled');
  assert.ok(Date.now() - t0 < 15_000, 'returned promptly, did not wait for the script');
  assert.ok(toolCallsAnswered(t.conv.messages));
  assert.equal(t.results()[1].error, 'cancelled');

  const runDir = path.join(t.home, 'runs', fs.readdirSync(path.join(t.home, 'runs'))[0]);
  const pid = Number(fs.readFileSync(path.join(runDir, 'pid.txt'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 30 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(alive(), false, 'the script process was actually killed');
});

test('13b. a script that exceeds its timeout is killed', py, async () => {
  const t = setup();
  t.script(
    use(['create_script', { name: 'slow', language: 'python', code: 'import time\ntime.sleep(30)' }]),
    (o) => use(['execute_script', { script_id: lastTool(o).script_id, timeout_seconds: 1 }]),
    say('ok'),
  );
  await t.run('go');
  assert.equal(t.results()[1].status, 'timeout');
});

test('14. conversation history is kept across turns and persisted in SQLite', async () => {
  const t = setup();
  t.script(say('Nice to meet you, Sam.'), (o) => say(`You said your name is ${o.messages.find((m) => m.content?.includes('I am Sam')) ? 'Sam' : '?'}`));
  await t.run('I am Sam');
  const r2 = await t.run('what is my name?');
  assert.equal(r2.text, 'You said your name is Sam');
  assert.deepEqual(t.llm.calls[1].messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  const reloaded = new Conversation(t.store, t.conv.id); // what --resume does
  assert.deepEqual(reloaded.messages, t.conv.messages);
  assert.equal(reloaded.messages.length, 4);
});

test('15. system operation: shutdown goes through the registered tool, a HIGH-risk approval and a fake exec', async () => {
  const calls: string[][] = [];
  const exec = async (cmd: string, args: string[]) => (calls.push([cmd, ...args]), { code: 0, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false });

  const declined = setup({ approve: false, exec });
  declined.script(use(['system_power', { action: 'shutdown' }]), say('ok'));
  await declined.run('Shut down my PC.');
  assert.equal(calls.length, 0, 'nothing ran without approval');
  assert.equal(declined.approvals[0].risk, 'high');

  const t = setup({ approve: true, exec });
  t.script(use(['system_power', { action: 'shutdown', delay_seconds: 10 }]), (o) => say(lastTool(o).ok ? 'shutting down' : 'failed'));
  const r = await t.run('Shut down my PC.');
  assert.equal(r.text, 'shutting down');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'shutdown');
  assert.ok(calls[0].includes('10') || calls[0].includes('now') || calls[0].includes('+1'));

  // cancelling a pending shutdown is low risk and needs no prompt
  const c = setup({ approve: false, exec });
  c.script(use(['system_power', { action: 'cancel' }]), say('cancelled'));
  await c.run('abort the shutdown');
  assert.equal(calls.length, 2);
  assert.equal(c.approvals.length, 0);
});

test('15b. terminate_process: approval required, and the process really dies', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  try {
    const declined = setup({ approve: false });
    declined.script(use(['terminate_process', { pid: child.pid }]), say('ok'));
    await declined.run('kill it');
    assert.equal(child.exitCode, null, 'still running after a declined request');

    const t = setup();
    t.script(use(['terminate_process', { pid: child.pid }, ], ['terminate_process', { pid: process.pid }]), say('ok'));
    await t.run('kill it');
    await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('process not terminated')), 5000))]);
    assert.equal(t.approvals.length, 1, 'only the legitimate call reached a prompt');
    assert.equal(t.results()[1].error, 'protected', 'Kappa refuses to terminate itself');
  } finally {
    child.kill();
  }
});

test('16. the iteration limit stops a runaway loop', async () => {
  const t = setup({ cfg: { maxIterations: 3 } });
  t.script(use(['get_system_info', {}]), use(['get_system_info', {}]), use(['get_system_info', {}]), say('never'));
  const r = await t.run('loop');
  assert.equal(r.status, 'max_iterations');
  assert.equal(t.llm.calls.length, 3);
});

test('17. a hung tool is cut off by the harness timeout', async () => {
  const hang: Tool = {
    name: 'hang', description: 'never returns', parameters: { type: 'object', properties: {} },
    risk: 'low', target: () => 'hang', run: () => new Promise(() => {}),
  };
  const t = setup({ cfg: { toolTimeoutMs: 200 }, extraTools: [hang] });
  t.script(use(['hang', {}]), (o) => say(lastTool(o).error));
  const r = await t.run('hang');
  assert.equal(r.text, 'timeout');
});

test('18. oversized tool results are truncated before reaching the model', async () => {
  const t = setup({ cfg: { maxResultChars: 300 } });
  fs.writeFileSync(path.join(t.work, 'big.txt'), 'x'.repeat(5000));
  t.script(use(['read_file', { path: 'big.txt' }]), say('ok'));
  await t.run('read');
  const raw = t.conv.messages.find((m) => m.role === 'tool')!.content!;
  assert.ok(raw.length < 400);
  assert.match(raw, /truncated/);
});

test('19. an LLM failure is reported, not thrown', async () => {
  const t = setup(); // no scripted steps: the fake model throws
  const r = await t.run('hi');
  assert.equal(r.status, 'error');
  assert.match(r.error!, /ran out of steps/);
});

test('20. the audit log records tool calls and approvals', async () => {
  const lines: any[] = [];
  const t = setup();
  t.deps.log = { log: (event, data) => void lines.push({ event, ...data }) };
  t.script(use(['create_file', { path: 'l.txt', content: 'x' }]), say('ok'));
  await t.run('log me');
  assert.ok(lines.some((l) => l.event === 'approval' && l.tool === 'create_file' && l.approved === true));
  assert.ok(lines.some((l) => l.event === 'tool' && l.name === 'create_file' && l.status === 'ok'));
});

test('13c. cancelling in the middle of a batch of tool calls: the remaining calls are not run but are still answered', async () => {
  const ac = new AbortController();
  const trigger: Tool = {
    name: 'trigger', description: 'cancels the request', parameters: { type: 'object', properties: {} },
    risk: 'low', target: () => 'trigger', run: async () => (ac.abort(), 'done'),
  };
  const t = setup({ extraTools: [trigger] });
  t.script(use(['trigger', {}], ['create_file', { path: 'must-not-exist.txt', content: 'x' }], ['get_system_info', {}]));
  const r = await t.run('go', ac.signal);
  assert.equal(r.status, 'cancelled');
  assert.deepEqual(t.results().map((x) => x.error), ['cancelled', 'cancelled', 'cancelled']);
  assert.ok(toolCallsAnswered(t.conv.messages), 'every tool_call has a tool message, so the next API request is valid');
  assert.equal(fs.existsSync(path.join(t.work, 'must-not-exist.txt')), false);
  assert.equal(t.approvals.length, 0);
});

test('21. search_files stops at a limit and says so, instead of grinding through a whole drive', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.work, 'big'));
  for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(t.work, 'big', `f${i}.txt`), 'zzz');
  t.script(use(['search_files', { path: '.', content: 'needle-that-is-not-there' }]), say('ok'));
  await t.run('find it');
  const r = t.results()[0];
  assert.equal(r.incomplete, true);
  assert.match(r.note, /5000 files read.*Narrow the folder/);
  assert.equal(r.matches, 0);
});