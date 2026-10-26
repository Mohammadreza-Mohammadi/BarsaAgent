import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter, once } from 'node:events';
import { authedFetch, startAuthedServer } from './helpers.js';
import { removeDirOnCleanup, waitUntil } from './cleanup.js';

// ورود اجباری است: همه‌ی fetchهای این فایل با نشست واقعی (Cookie + CSRF) می‌روند.
const fetch = authedFetch;

function makeFakeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-server-'));
  removeDirOnCleanup(t, root);
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
  const { base } = await startAuthedServer(t, config, deps);
  return base;
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

// release-note-at-merge.md، بند ه: releaseNoteText از فایل موقت mode 0o600
// می‌رود (نه argv خام)، و noReleaseNote بدون reason قبل از صدا زدن manager.js
// با ۴۰۰ رد می‌شود — هیچ فرمان/endpoint تازه، همان answer موجود.
test('answer با releaseNoteText از فایل موقت --release-note-file می‌رود، با mode 0o600، و بعد پاک می‌شود', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  let capturedPath = null;
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){
  const ri=args.indexOf('--release-note-file'); const file = ri>=0?args[ri+1]:null;
  fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({ args, file, text: file?fs.readFileSync(file,'utf8'):null }));
  process.stdout.write(JSON.stringify({ok:true}));
} else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, run: { autoResumeAfterAnswer: false }, issueSource: {} });

  const noteText = '---\nuserVisible: true\nheadline: "عنوان"\n---\n\nبدنه';
  const response = await fetch(`${base}/api/repos/fake/tasks/0005/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'approve', releaseNoteText: noteText })
  });
  assert.equal(response.status, 200);
  const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.ok(captured.args.includes('--release-note-file'));
  assert.equal(captured.text, noteText);
  capturedPath = captured.file;
  assert.ok(capturedPath, 'مسیر فایل موقت باید ثبت شده باشد');
  assert.equal(fs.existsSync(capturedPath), false, 'فایل موقت باید بعد از answer پاک شده باشد');
});

test('answer با noReleaseNote بدون reason، قبل از صدا زدن manager.js با 400 رد می‌شود', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){ process.stderr.write('باید اصلاً صدا زده نشود'); process.exit(1); }
else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, run: { autoResumeAfterAnswer: false }, issueSource: {} });

  const response = await fetch(`${base}/api/repos/fake/tasks/0006/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'approve', noReleaseNote: true })
  });
  assert.equal(response.status, 400);
});

test('answer با هم releaseNoteText هم noReleaseNote → 400 (دو فلگ متضاد)', async t => {
  const repo = makeFakeRepo(t);
  const base = await startServer(t, { repos: [repo], server: {}, run: { autoResumeAfterAnswer: false }, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/tasks/0007/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'approve', releaseNoteText: 'x', noReleaseNote: true, reason: 'چرا' })
  });
  assert.equal(response.status, 400);
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
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2);
if(args[0]==='run'){
  // تا فایل ِ release-<id> ساخته نشود زنده می‌ماند (قطعی؛ نه وابسته به زمان). سقف ِ عمر: اگر پاک‌سازی جا ماند یتیم نماند.
  fs.writeFileSync(path.join(__dirname,'started-'+args[1]),'1'); console.log('run '+args[1]);
  const t0=Date.now(); const timer=setInterval(()=>{ if(fs.existsSync(path.join(__dirname,'release-'+args[1]))||Date.now()-t0>120000){ clearInterval(timer); process.exit(10); } },20);
} else process.exit(0);
`, 'utf8');
  const release = id => fs.writeFileSync(path.join(repo.path, 'release-' + id), '1');
  const base = await startServer(t, { repos:[repo], server:{}, run:{maxConcurrent:1}, issueSource:{} });
  const first = await fetch(`${base}/api/repos/fake/tasks/1/run`, {method:'POST'});
  const second = await fetch(`${base}/api/repos/fake/tasks/2/run`, {method:'POST'});
  assert.equal(first.status, 202); assert.equal(second.status, 202);
  // run ِ اول واقعاً شروع شده (فایل ِ started) و تا آزاد نشود تمام نمی‌شود: وضعیت ِ «اولی running، دومی queued» قطعی است.
  await waitUntil(() => fs.existsSync(path.join(repo.path, 'started-1')), { label: 'شروع ِ run ِ اول' });
  const list = await (await fetch(`${base}/api/repos/fake/running`)).json();
  const one = list.find(x => x.taskId === '1'); const two = list.find(x => x.taskId === '2');
  assert.equal(one.running, true);
  assert.equal(two.queued, true);
  assert.equal(two.queuePosition, 1);
  assert.equal(fs.existsSync(path.join(repo.path, 'started-2')), false, 'دومی تا آزاد شدن ِ اولی شروع نمی‌شود');
  release('1');
  const secondRun = await waitForRun(base, '2', value => value.running === true);
  assert.equal(secondRun.running, true);
  release('2');
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

// کانبان-اکشن‌های-وب‌تری، بند ج: --external-checked-in <sourceId> [--changeset Cxxxx]
test('external-checked-in آرگومان‌های دقیق می‌سازد؛ شماره‌ی ثبت بدون C خودکار C می‌گیرد؛ بدون changeset، فلگ اصلاً نمی‌رود', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){ fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({args})); process.stdout.write(JSON.stringify({ok:true})); }
else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });

  const withChangesets = await fetch(`${base}/api/repos/fake/tasks/0005/external-checked-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'webiii', changesets: ['12345', 'C999'] })
  });
  assert.equal(withChangesets.status, 200);
  let captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(captured.args, ['answer', '0005', '--external-checked-in', 'webiii', '--changeset', 'C12345,C999']);

  const noChangesets = await fetch(`${base}/api/repos/fake/tasks/0005/external-checked-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'webiii', changesets: [] })
  });
  assert.equal(noChangesets.status, 200);
  captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(captured.args, ['answer', '0005', '--external-checked-in', 'webiii']);
});

test('external-checked-in با sourceId یا شماره‌ی ثبت نامعتبر 400 می‌دهد، بدون صدا زدن manager.js', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){ process.stderr.write('نباید صدا زده شود'); process.exit(1); }
else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });

  const badSource = await fetch(`${base}/api/repos/fake/tasks/0005/external-checked-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'web iii', changesets: [] })
  });
  assert.equal(badSource.status, 400);

  const badChangeset = await fetch(`${base}/api/repos/fake/tasks/0005/external-checked-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'webiii', changesets: ['not-a-number'] })
  });
  assert.equal(badChangeset.status, 400);
});

test('رد مشروع Manager روی external-checked-in (state اشتباه) → 422 با پیام خام', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args = process.argv.slice(2);
if (args[0] === 'answer') { process.stderr.write('state="review" است، نه "awaiting-external-checkin"'); process.exit(1); }
else if (args[0] === 'status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/tasks/0005/external-checked-in`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sourceId: 'webiii', changesets: [] })
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /awaiting-external-checkin/);
});

// کانبان-اکشن‌های-وب‌تری، بند د: answer --note --file <tmp-utf8>، هرگز --text خام
test('note متن را از فایل موقت UTF-8 با --file می‌فرستد و بعد پاک می‌کند؛ بدون متن 400', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){
  const fi=args.indexOf('--file'); const file = fi>=0?args[fi+1]:null;
  fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({args,file,text:file?fs.readFileSync(file,'utf8'):null}));
  process.stdout.write(JSON.stringify({ok:true}));
} else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });

  const empty = await fetch(`${base}/api/repos/fake/tasks/0005/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '   ' }) });
  assert.equal(empty.status, 400);

  const noteText = 'یادداشت فارسی چندخطی\nبرای اجرای بعدی';
  const response = await fetch(`${base}/api/repos/fake/tasks/0005/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: noteText }) });
  assert.equal(response.status, 200);
  const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(captured.args, ['answer', '0005', '--note', '--file', captured.file]);
  assert.equal(captured.text, noteText);
  assert.equal(fs.existsSync(captured.file), false, 'فایل موقت باید بعد از صدا زدن manager.js پاک شده باشد');
});

test('رد مشروع Manager روی note (یادداشت مصرف‌نشده‌ی قبلی) → 422 با پیام خام', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args = process.argv.slice(2);
if (args[0] === 'answer') { process.stderr.write('یک یادداشت مصرف‌نشده از قبل روی دیسک است'); process.exit(1); }
else if (args[0] === 'status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/tasks/0005/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'یادداشت تازه' }) });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /مصرف‌نشده/);
});

// کانبان-الحاقیه-۱، بند الف: env ِ فرآیند «run» (end-to-end، نه فقط unit
// buildAgentEnv) — سرور ساختگی با token و بدون پروکسی بالا می‌آید، فرزند
// manager.js همان envهای واقعی را که دید چاپ می‌کند.
function makeEnvPrintingRepo(t) {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args = process.argv.slice(2);
if (args[0] === 'run') {
  console.log('CLAUDE_CODE_OAUTH_TOKEN=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN || ''));
  console.log('HTTP_PROXY=' + (process.env.HTTP_PROXY || ''));
  console.log('HTTPS_PROXY=' + (process.env.HTTPS_PROXY || ''));
  setTimeout(() => process.exit(10), 60);
} else if (args[0] === 'status') {
  process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
} else process.exit(0);
`, 'utf8');
  return repo;
}

test('run: env ِ ساختگی سرور با token و بدون پروکسی → env ِ فرزند بدون token و با پروکسی پیش‌فرض', async t => {
  const repo = makeEnvPrintingRepo(t);
  const old = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const oldHttp = process.env.HTTP_PROXY;
  const oldHttps = process.env.HTTPS_PROXY;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'secret-oauth-must-not-reach-child';
  delete process.env.HTTP_PROXY;
  delete process.env.HTTPS_PROXY;
  t.after(() => {
    if (old === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = old;
    if (oldHttp === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldHttp;
    if (oldHttps === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = oldHttps;
  });

  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  await fetch(`${base}/api/repos/fake/tasks/0010/run`, { method: 'POST' });
  const run = await waitForRun(base, '0010', value => value.running === false);
  assert.equal(run.exitCode, 10);
  const stream = await (await fetch(`${base}/api/repos/fake/tasks/0010/stream`)).text();
  assert.ok(stream.includes('"text":"CLAUDE_CODE_OAUTH_TOKEN="'), 'باید خالی/بدون token چاپ شده باشد');
  assert.doesNotMatch(stream, /secret-oauth-must-not-reach-child/);
  assert.ok(stream.includes('"text":"HTTP_PROXY=http://127.0.0.1:10808"'));
  assert.ok(stream.includes('"text":"HTTPS_PROXY=http://127.0.0.1:10808"'));
});

test('run: config.run.proxy صریح جای پیش‌فرض را می‌گیرد', async t => {
  const repo = makeEnvPrintingRepo(t);
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {}, run: { proxy: 'http://10.20.30.40:8080' } });
  await fetch(`${base}/api/repos/fake/tasks/0011/run`, { method: 'POST' });
  await waitForRun(base, '0011', value => value.running === false);
  const stream = await (await fetch(`${base}/api/repos/fake/tasks/0011/stream`)).text();
  assert.ok(stream.includes('"text":"HTTP_PROXY=http://10.20.30.40:8080"'));
  assert.ok(stream.includes('"text":"HTTPS_PROXY=http://10.20.30.40:8080"'));
});

test('run: config.run.proxy خالی → بدون پروکسی، حتی اگر در env خودِ سرور باشد', async t => {
  const repo = makeEnvPrintingRepo(t);
  const oldHttp = process.env.HTTP_PROXY;
  process.env.HTTP_PROXY = 'http://leftover-from-server-shell:1';
  t.after(() => { if (oldHttp === undefined) delete process.env.HTTP_PROXY; else process.env.HTTP_PROXY = oldHttp; });

  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {}, run: { proxy: '' } });
  await fetch(`${base}/api/repos/fake/tasks/0012/run`, { method: 'POST' });
  await waitForRun(base, '0012', value => value.running === false);
  const stream = await (await fetch(`${base}/api/repos/fake/tasks/0012/stream`)).text();
  assert.ok(stream.includes('"text":"HTTP_PROXY="'), 'باید خالی چاپ شده باشد، نه مقدار leftover سرور');
  assert.doesNotMatch(stream, /leftover-from-server-shell/);
});

// الحاقیه‌ی ۱، بند ب: --stage-external (TOOLING-032). خودِ answer تصمیم
// می‌گیرد که آیا access=write/state=integrating/awaitingHuman=merge-approval
// برقرار است یا نه (computeExternalSourceActions) — سرور فقط args را دقیق
// می‌سازد و پیام رد Manager را خام پاس می‌دهد، هیچ شرطی خودش نمی‌سنجد.
test('stage-external آرگومان دقیق می‌سازد؛ sourceId نامعتبر 400 بدون صدا زدن manager.js', async t => {
  const repo = makeFakeRepo(t);
  const capture = path.join(repo.path, 'capture.json');
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const fs=require('node:fs'); const path=require('node:path'); const args=process.argv.slice(2); const cmd=args[0];
if(cmd==='answer'){ fs.writeFileSync(path.join(process.cwd(),'capture.json'),JSON.stringify({args})); process.stdout.write(JSON.stringify({ok:true})); }
else if(cmd==='status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });

  const bad = await fetch(`${base}/api/repos/fake/tasks/0013/stage-external`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'web iii' })
  });
  assert.equal(bad.status, 400);
  assert.equal(fs.existsSync(capture), false, 'manager.js با sourceId نامعتبر اصلاً صدا زده نشود');

  const ok = await fetch(`${base}/api/repos/fake/tasks/0013/stage-external`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'webiii' })
  });
  assert.equal(ok.status, 200);
  const captured = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.deepEqual(captured.args, ['answer', '0013', '--stage-external', 'webiii']);
});

test('رد مشروع Manager روی stage-external (مثلاً access=read یا گیت merge-approval باز نیست) → 422 با پیام خام', async t => {
  const repo = makeFakeRepo(t);
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
const args = process.argv.slice(2);
if (args[0] === 'answer') { process.stderr.write('منبع بیرونی "webiii" برای این تسک access="read" دارد — "--stage-external" فقط برای access=write معنا دارد.'); process.exit(1); }
else if (args[0] === 'status') process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:[]}));
else process.exit(0);
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const response = await fetch(`${base}/api/repos/fake/tasks/0013/stage-external`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceId: 'webiii' })
  });
  assert.equal(response.status, 422);
  const body = await response.json();
  assert.match(body.error, /access="read"/);
});

// الحاقیه‌ی ۱، بند ب: «برای هر ترکیب actions» — سرور هیچ تبدیل/فیلتری روی
// externalSources نمی‌کند، هر ۴ ترکیب canStageExternal×canMarkCheckedIn باید
// عیناً از status --json واقعی تا board API برسد؛ تصمیم نمایش دکمه‌ها کار UI
// است، نه سرور.
test('board externalSources را با هر ترکیب actions بدون تغییر پاس می‌دهد', async t => {
  const repo = makeFakeRepo(t);
  const combos = [
    { id: 't-both', canStageExternal: true, canMarkCheckedIn: true },
    { id: 't-stage-only', canStageExternal: true, canMarkCheckedIn: false },
    { id: 't-checkin-only', canStageExternal: false, canMarkCheckedIn: true },
    { id: 't-neither', canStageExternal: false, canMarkCheckedIn: false }
  ];
  const tasks = combos.map(c => ({
    id: c.id,
    state: 'integrating',
    externalSources: [{
      id: 'webiii',
      access: 'write',
      staged: c.canMarkCheckedIn ? { sha: 'abc1234567890', at: new Date().toISOString() } : null,
      checkedIn: null,
      actions: { canStageExternal: c.canStageExternal, canMarkCheckedIn: c.canMarkCheckedIn }
    }]
  }));
  fs.writeFileSync(path.join(repo.path, repo.managerScript), String.raw`
process.stdout.write(JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),repo:{},tasks:${JSON.stringify(tasks)}}));
`, 'utf8');
  const base = await startServer(t, { repos: [repo], server: {}, issueSource: {} });
  const board = await (await fetch(`${base}/api/repos/fake/board`)).json();
  for (const c of combos) {
    const task = board.tasks.find(x => x.id === c.id);
    assert.ok(task, `task ${c.id} باید در board باشد`);
    assert.deepEqual(task.externalSources[0].actions, { canStageExternal: c.canStageExternal, canMarkCheckedIn: c.canMarkCheckedIn });
  }
});
