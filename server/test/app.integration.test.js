import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
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

async function startServer(t, config, deps) {
  const server = createApp(config, deps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function waitForRun(base, taskId, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = await (await fetch(`${base}/api/repos/fake/running`)).json();
    const run = runs.find(x => x.taskId === String(taskId));
    if (run && predicate(run)) return run;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`run ${taskId} در ${timeoutMs}ms به وضعیت مورد انتظار نرسید.`);
}

test('open-editor وضعیت تازهٔ task را می‌خواند و executable را detached و بدون shell اجرا می‌کند', async t => {
  const repo = makeFakeRepo(t);
  const livePath = path.join(repo.path, 'worktree-0003');
  fs.mkdirSync(livePath, { recursive: true });
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2);
if(args[0]==='status') process.stdout.write(JSON.stringify({schemaVersion:1,repo:{},tasks:[{id:'0003',worktree:{status:'active',path:${JSON.stringify(livePath)}}}]}));
else process.exit(0);
`, 'utf8');
  let called;
  const child = new EventEmitter();
  child.unref = () => { called.unref = true; };
  const spawnEditor = (command, args, options) => {
    called = { command, args, options, unref: false };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const base = await startServer(t, { repos:[repo], server:{}, editor:{ command:'C:/VSCode/Code.exe' }, issueSource:{} }, { spawnEditor });
  const response = await fetch(`${base}/api/repos/fake/tasks/0003/open-editor`, { method:'POST' });
  assert.equal(response.status, 200);
  assert.equal(called.command, 'C:/VSCode/Code.exe');
  assert.deepEqual(called.args, [livePath]);
  assert.deepEqual(called.options, { detached:true, stdio:'ignore', shell:false, windowsHide:true });
  assert.equal(called.unref, true);
});

test('open-editor مسیر worktree نسبی manifest (نسبت به repo.path) را resolve می‌کند، نه نسبت به cwd سرور', async t => {
  const repo = makeFakeRepo(t);
  const worktreeAbsPath = path.join(repo.path, '..', 'agent-worktrees', '0003-slug');
  fs.mkdirSync(worktreeAbsPath, { recursive: true });
  const relPath = path.relative(repo.path, worktreeAbsPath);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2);
if(args[0]==='status') process.stdout.write(JSON.stringify({schemaVersion:1,repo:{},tasks:[{id:'0003',worktree:{status:'active',path:${JSON.stringify(relPath)}}}]}));
else process.exit(0);
`, 'utf8');
  let called;
  const child = new EventEmitter();
  child.unref = () => { called.unref = true; };
  const spawnEditor = (command, args, options) => {
    called = { command, args, options, unref: false };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const base = await startServer(t, { repos:[repo], server:{}, editor:{ command:'C:/VSCode/Code.exe' }, issueSource:{} }, { spawnEditor });
  const response = await fetch(`${base}/api/repos/fake/tasks/0003/open-editor`, { method:'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(called.args, [worktreeAbsPath]);
});

test('open-editor برای worktree مرده 409 می‌دهد و بدون editor.command مسیر قابل کپی را برمی‌گرداند', async t => {
  const repo = makeFakeRepo(t);
  const livePath = path.join(repo.path, 'worktree-0003');
  fs.mkdirSync(livePath, { recursive: true });
  const writeStatus = status => fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2);
if(args[0]==='status') process.stdout.write(JSON.stringify({schemaVersion:1,repo:{},tasks:[{id:'0003',worktree:{status:${JSON.stringify(status)},path:${JSON.stringify(livePath)}}}]}));
else process.exit(0);
`, 'utf8');

  writeStatus('removed');
  const deadBase = await startServer(t, { repos:[repo], server:{}, editor:{ command:'C:/VSCode/Code.exe' }, issueSource:{} });
  let response = await fetch(`${deadBase}/api/repos/fake/tasks/0003/open-editor`, { method:'POST' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /زنده نیست/);

  writeStatus('active');
  const unconfiguredBase = await startServer(t, { repos:[repo], server:{}, issueSource:{} });
  response = await fetch(`${unconfiguredBase}/api/repos/fake/tasks/0003/open-editor`, { method:'POST' });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /editor\.command تنظیم نشده/);
  assert.equal(body.worktreePath, livePath);
});

test('open-editor خطای خام spawn و مسیر worktree را با هم برمی‌گرداند', async t => {
  const repo = makeFakeRepo(t);
  const livePath = path.join(repo.path, 'worktree-0003');
  fs.mkdirSync(livePath, { recursive: true });
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2);
if(args[0]==='status') process.stdout.write(JSON.stringify({schemaVersion:1,repo:{},tasks:[{id:'0003',worktree:{status:'active',path:${JSON.stringify(livePath)}}}]}));
else process.exit(0);
`, 'utf8');
  const spawnEditor = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('ENOENT Code.exe')));
    return child;
  };
  const base = await startServer(t, { repos:[repo], server:{}, editor:{ command:'C:/missing/Code.exe' }, issueSource:{} }, { spawnEditor });
  const response = await fetch(`${base}/api/repos/fake/tasks/0003/open-editor`, { method:'POST' });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.match(body.error, /ENOENT Code\.exe/);
  assert.equal(body.worktreePath, livePath);
  assert.ok(body.error.includes(livePath));
});

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
  const run = await waitForRun(base, '0003', value => value.running === false);
  assert.equal(run.exitCode, 10);
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
  await waitForRun(base, '2041', value => value.running === false);
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
  await waitForRun(base, '2041', value => value.running === false);
});

test('رد گیت از --reason-file می‌رود، نه --reason argv؛ و respec به answer اضافه می‌شود', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){
  const ri=args.indexOf('--reason-file'); const reasonFile = ri>=0?args[ri+1]:null;
  const fi=args.indexOf('--file'); const clarifyFile = fi>=0?args[fi+1]:null;
  fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({
    args,
    reasonText: reasonFile?fs.readFileSync(reasonFile,'utf8'):null,
    clarifyText: clarifyFile?fs.readFileSync(clarifyFile,'utf8'):null
  }));
  process.stdout.write(JSON.stringify({ok:true}));
} else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, run: { autoResumeAfterAnswer: false }, issueSource: {} });

  const reject = await fetch(`${base}/api/repos/fake/tasks/0004/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'reject', reason: 'دلیل فارسی چندخطی\nخط دوم' }) });
  assert.equal(reject.status, 200);
  let captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.ok(!captured.args.includes('--reason'), 'argv نباید هرگز --reason خام داشته باشد');
  assert.ok(captured.args.includes('--reason-file'));
  assert.equal(captured.reasonText, 'دلیل فارسی چندخطی\nخط دوم');

  const clarify = await fetch(`${base}/api/repos/fake/tasks/0004/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'clarify', text: 'پاسخ', respec: true }) });
  assert.equal(clarify.status, 200);
  captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.ok(captured.args.includes('--respec'));
  assert.equal(captured.clarifyText, 'پاسخ');
});

test('void/cancel/rebase مسیرهای جدید manager.js را با --reason-file صدا می‌زنند', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='void'||cmd==='cancel'||cmd==='rebase'){
  const ri=args.indexOf('--reason-file'); const reasonFile = ri>=0?args[ri+1]:null;
  fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({cmd,args,reasonText: reasonFile?fs.readFileSync(reasonFile,'utf8'):null}));
  process.stdout.write(JSON.stringify({ok:true}));
} else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });

  const noReason = await fetch(`${base}/api/repos/fake/tasks/0005/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(noReason.status, 400);

  const voidRes = await fetch(`${base}/api/repos/fake/tasks/0005/void`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'اشتباه بود' }) });
  assert.equal(voidRes.status, 200);
  let captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(captured.cmd, 'void');
  assert.ok(!captured.args.includes('--reason'));
  assert.equal(captured.reasonText, 'اشتباه بود');

  const cancelRes = await fetch(`${base}/api/repos/fake/tasks/0005/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'دیگر لازم نیست' }) });
  assert.equal(cancelRes.status, 200);
  captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(captured.cmd, 'cancel');
  assert.equal(captured.reasonText, 'دیگر لازم نیست');

  const rebaseRes = await fetch(`${base}/api/repos/fake/tasks/0005/rebase`, { method: 'POST' });
  assert.equal(rebaseRes.status, 200);
  captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(captured.cmd, 'rebase');
});

test('unlock بدون دلیل 400 می‌دهد؛ با دلیل --reason-file می‌زند؛ با force، --force هم اضافه می‌شود', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='unlock'){
  const ri=args.indexOf('--reason-file'); const reasonFile = ri>=0?args[ri+1]:null;
  fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({cmd,args,forced:args.includes('--force'),reasonText: reasonFile?fs.readFileSync(reasonFile,'utf8'):null}));
  process.stdout.write(JSON.stringify({ok:true}));
} else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });

  const noReason = await fetch(`${base}/api/repos/fake/tasks/0006/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(noReason.status, 400);

  const plainRes = await fetch(`${base}/api/repos/fake/tasks/0006/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'قفل کهنه، پاکش کن' }) });
  assert.equal(plainRes.status, 200);
  let captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(captured.cmd, 'unlock');
  assert.ok(!captured.args.includes('--reason'), 'متن آزاد هرگز argv نمی‌شود، همیشه --reason-file');
  assert.equal(captured.reasonText, 'قفل کهنه، پاکش کن');
  assert.equal(captured.forced, false);

  const forcedRes = await fetch(`${base}/api/repos/fake/tasks/0006/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'قفل نامشخص', force: true }) });
  assert.equal(forcedRes.status, 200);
  captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(captured.forced, true);
  assert.equal(captured.reasonText, 'قفل نامشخص');
});

test('رد مشروع Manager روی answer (مثلاً اثبات merge پاس نشد) → 422 با پیام خام، نه 500 عمومی', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args = process.argv.slice(2);
if (args[0] === 'answer') { process.stderr.write('اثبات merge پاس نشد: headCommit به base نرسیده است.'); process.exit(1); }
else if (args[0] === 'status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/tasks/0003/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'approve' }) });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /اثبات merge پاس نشد/);
});

test('parseTaskId: خروجی import-issue غیر-JSON یا بدون taskId → خطای صریح، نه حدسِ regex', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args = process.argv.slice(2);
if (args[0] === 'import-issue') { process.stdout.write('taskId: 1234 (not json, just text that an old regex fallback would have matched)'); }
else if (args[0] === 'status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const response = await fetch(`${base}/api/tasks/create`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ repo: 'fake', type: 'task', slug: 'x', requestText: 'متن' }] })
  });
  assert.equal(response.status, 207);
  const body = await response.json();
  assert.equal(body.results[0].ok, false);
  assert.match(body.results[0].message, /JSON معتبر نداد/);
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
  const secondRun = await waitForRun(base, '2', value => value.running === true);
  assert.equal(secondRun.running, true);
  await waitForRun(base, '2', value => value.running === false);
});

test('health روی validator مستقیم Node تکیه می‌کند و warning با exit 0 را سالم می‌داند', async t => {
  const repo = makeFakeRepo(t);
  const scripts = path.join(repo.path, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'validate-agent-work.js'), `
console.log('ℹ️ known exception');
console.error('⚠️ Phase 0 reminder');
console.log('Level 4A: 2 Task بررسی شد، مشکلی پیدا نشد.');
process.exit(0);
`, 'utf8');

  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/health?refresh=1`);
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);
  assert.equal(health.code, 0);
  assert.match(health.output, /known exception/);
  assert.match(health.output, /Phase 0 reminder/);
  assert.match(health.output, /مشکلی پیدا نشد/);
});
