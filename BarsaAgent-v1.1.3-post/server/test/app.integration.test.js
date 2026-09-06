import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';

function makeFakeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-server-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = path.join(root, 'manager.cjs');
  fs.writeFileSync(manager, String.raw`
const args = process.argv.slice(2);
const cmd = args[0];
if (cmd === 'capabilities') {
  process.stdout.write(JSON.stringify({contract:'barsa-agent-manager',contractVersion:1,managerVersion:'test-manager',capabilities:{status:true,taskStatus:true,events:true,artifact:true,run:true,answer:{approve:true,reject:true,clarify:true},importIssue:true}}));
} else if (cmd === 'status') {
  const task = args.includes('--task');
  process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{id:'fake',path:process.cwd()},tasks: task ? [{id:'0003',title:'نمونه',state:'review',artifacts:['request.md']}] : [{id:'0003',title:'نمونه',state:'review',artifacts:['request.md']}]}));
} else if (cmd === 'events') {
  process.stdout.write(JSON.stringify([{event:'state.changed',from:'implementing',to:'review',at:new Date().toISOString()}]));
} else if (cmd === 'artifact') {
  process.stdout.write('# artifact\nمتن');
} else if (cmd === 'run') {
  console.log('starting');
  console.log('token=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN || 'none'));
  setTimeout(() => { console.log('done'); process.exit(10); }, 220);
} else if (cmd === 'answer') {
  process.stdout.write(JSON.stringify({ok:true}));
} else if (cmd === 'import-issue') {
  const file = args[args.indexOf('--file') + 1];
  const issue = JSON.parse(require('node:fs').readFileSync(file, 'utf8'));
  process.stdout.write(JSON.stringify({ok:true,taskId:String(issue.externalId)}));
} else { process.stderr.write('unknown'); process.exit(1); }
`, 'utf8');
  return { id: 'fake', path: root, managerScript: 'manager.cjs' };
}

async function startServer(t, config) {
  const server = createApp(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

test('API board/task/events فقط از CLI پاسخ می‌گیرد و traversal artifact را رد می‌کند', async t => {
  const repo = makeFakeRepo(t);
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const board = await (await fetch(`${base}/api/repos/fake/board`)).json();
  assert.equal(board.tasks[0].id, '0003');
  const task = await (await fetch(`${base}/api/repos/fake/tasks/0003`)).json();
  assert.equal(task.state, 'review');
  const events = await (await fetch(`${base}/api/repos/fake/tasks/0003/events`)).json();
  assert.equal(events[0].event, 'state.changed');
  const bad = await fetch(`${base}/api/repos/fake/tasks/0003/artifact?path=${encodeURIComponent('../../secret')}`);
  assert.equal(bad.status, 400);
});

test('دوبار run هم‌زمان برای یک task، دومی 409 می‌گیرد و SSE توکن را ماسک می‌کند', async t => {
  const repo = makeFakeRepo(t);
  const old = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret-oauth-123456789';
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = old; });
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const first = await fetch(`${base}/api/repos/fake/tasks/0003/run`, { method: 'POST' });
  const second = await fetch(`${base}/api/repos/fake/tasks/0003/run`, { method: 'POST' });
  assert.equal(first.status, 202);
  assert.equal(second.status, 409);

  const stream = await fetch(`${base}/api/repos/fake/tasks/0003/stream`);
  const text = await stream.text();
  assert.match(text, /starting/);
  assert.match(text, /\[MASKED\]/);
  assert.doesNotMatch(text, /secret-oauth-123456789/);
  assert.match(text, /event: end/);
  assert.match(text, /"code":10/);
});

test('بستن SSE فرآیند run را نمی‌کشد و بافر برای اتصال بعدی باقی می‌ماند', async t => {
  const repo = makeFakeRepo(t);
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  await fetch(`${base}/api/repos/fake/tasks/0003/run`, { method: 'POST' });
  await new Promise(resolve => setTimeout(resolve, 350));
  const running = await (await fetch(`${base}/api/repos/fake/running`)).json();
  assert.equal(running[0].running, false);
  assert.equal(running[0].exitCode, 10);
  const replay = await (await fetch(`${base}/api/repos/fake/tasks/0003/stream`)).text();
  assert.match(replay, /starting/);
  assert.match(replay, /done/);
});
