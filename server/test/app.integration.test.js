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

test('ساخت task payload تأییدشده را ترتیبی با import-issue می‌فرستد و auto-start می‌کند', async t => {
  const repo = makeFakeRepo(t);
  // manager تست اصلی externalId را در root انتظار دارد؛ برای این تست manager سازگار با flow می‌سازیم.
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs = require('node:fs');
const args = process.argv.slice(2); const cmd = args[0];
if (cmd === 'status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else if (cmd === 'import-issue') { const p=JSON.parse(fs.readFileSync(args[args.indexOf('--file')+1],'utf8')); process.stdout.write(JSON.stringify({ok:true,taskId:p.source?.externalId || '0099'})); }
else if (cmd === 'run') { console.log('flow-run'); setTimeout(()=>process.exit(10),80); }
else if (cmd === 'events') process.stdout.write('[]');
else if (cmd === 'artifact') process.stdout.write('');
else if (cmd === 'answer') process.stdout.write(JSON.stringify({ok:true}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, run: { maxConcurrent: 1, autoStartOnCreate: true, autoResumeAfterAnswer: true }, issueSource: {} });
  const response = await fetch(`${base}/api/tasks/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items: [{ repo:'fake', type:'task', slug:'sample', requestText:'متن خام', source:{system:'internal',externalId:'2041',url:'',fetchedAt:new Date().toISOString()} }] }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.succeeded, 1);
  assert.equal(body.results[0].taskId, '2041');
  const running = await (await fetch(`${base}/api/repos/fake/running`)).json();
  assert.equal(running[0].taskId, '2041');
});

test('clarification از فایل می‌رود و پاسخ موفق auto-resume می‌شود', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'answer-capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){ const i=args.indexOf('--file'); const file=i>=0?args[i+1]:null; fs.writeFileSync(path.join(process.cwd(),'answer-capture.json'),JSON.stringify({args,text:file?fs.readFileSync(file,'utf8'):null})); process.stdout.write(JSON.stringify({ok:true})); }
else if(cmd==='run'){ console.log('resume'); setTimeout(()=>process.exit(10),70); }
else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, run: { maxConcurrent: 1, autoResumeAfterAnswer: true }, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/tasks/2041/answer`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({mode:'clarify',text:'فقط همین scope'}) });
  assert.equal(response.status, 200);
  const captured = JSON.parse(fs.readFileSync(capture,'utf8'));
  assert.ok(captured.args.includes('--clarify'));
  assert.ok(captured.args.includes('--file'));
  assert.equal(captured.text, 'فقط همین scope');
  const running = await (await fetch(`${base}/api/repos/fake/running`)).json();
  assert.equal(running[0].taskId, '2041');
});

test('شکست یک import بقیه draftها را متوقف نمی‌کند', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const args=process.argv.slice(2);
if(args[0]==='import-issue'){ const p=JSON.parse(fs.readFileSync(args[args.indexOf('--file')+1],'utf8')); const id=p.source?.externalId; if(id==='2'){ console.error('duplicate'); process.exit(1); } process.stdout.write(JSON.stringify({ok:true,taskId:id})); }
else if(args[0]==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos:[repo], server:{}, run:{autoStartOnCreate:false}, issueSource:{} });
  const items = ['1','2','3'].map(id => ({ repo:'fake', type:'task', slug:`task-${id}`, requestText:`request ${id}`, source:{system:'internal',externalId:id} }));
  const response = await fetch(`${base}/api/tasks/create`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({items,start:false}) });
  assert.equal(response.status, 207);
  const body = await response.json();
  assert.equal(body.succeeded, 2);
  assert.equal(body.failed, 1);
  assert.deepEqual(body.results.map(x => x.ok), [true,false,true]);
});

test('maxConcurrent اضافی‌ها را در queue نگه می‌دارد', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2); if(args[0]==='run'){ console.log('run '+args[1]); setTimeout(()=>process.exit(10),220); } else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos:[repo], server:{}, run:{maxConcurrent:1}, issueSource:{} });
  const first = await fetch(`${base}/api/repos/fake/tasks/1/run`, {method:'POST'});
  const second = await fetch(`${base}/api/repos/fake/tasks/2/run`, {method:'POST'});
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  const list = await (await fetch(`${base}/api/repos/fake/running`)).json();
  const one = list.find(x => x.taskId === '1'); const two = list.find(x => x.taskId === '2');
  assert.equal(one.running, true);
  assert.equal(two.queued, true);
  assert.equal(two.queuePosition, 1);
  await new Promise(resolve => setTimeout(resolve, 280));
  const after = await (await fetch(`${base}/api/repos/fake/running`)).json();
  assert.equal(after.find(x => x.taskId === '2').running, true);
});
