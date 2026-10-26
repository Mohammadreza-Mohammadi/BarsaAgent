import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { trackChild } from './cleanup.js';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';
import { isPidAlive, killProcessTree } from '../src/process-tools.js';

const post = (base, p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(40);
  }
  throw new Error('شرط برقرار نشد');
}

// فرزند + نوه که منتظر می‌مانند؛ pid نوه در فایل می‌آید.
const LONG_RUN = `
const { spawn } = require('node:child_process');
const grand = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(dir, 'grandchild-' + args[1] + '.pid'), String(grand.pid));
console.log('started ' + args[1]);
setInterval(() => {}, 1000);
`;

function externalProcess(t) {
  // فرآیندی که کانبان راه نینداخته (مثل ng serve یا سرور MCP): نباید بسته شود.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  trackChild(t, child, 'فرآیند ِ بیرونی');
  return child;
}

test('توقف: فقط درخت فرزندان اجرای خود کانبان بسته می‌شود؛ فرآیند بیرون از registry دست نمی‌خورد', async t => {
  const fake = makeFakeManagerRepo(t, {
    run: LONG_RUN,
    status: { schemaVersion: 1, repo: {}, tasks: [{ id: '7', state: 'implementing', health: { stuck: true, stuckReasons: ['stale-lock'], recovery: { suggested: 'run', reason: 'قفل مرده', commands: ['run 7'] } } }] }
  });
  const { base, config } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, run: { stopGraceMs: 300 } });
  const outsider = externalProcess(t);

  assert.equal((await post(base, '/api/repos/fake/tasks/7/run')).status, 202);
  const pidFile = path.join(fake.root, 'grandchild-7.pid');
  const grandchild = Number(await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')));
  assert.ok(isPidAlive(grandchild));
  const runs = await (await authedFetch(`${base}/api/repos/fake/running`)).json();
  assert.equal(runs[0].running, true);

  const response = await post(base, '/api/repos/fake/tasks/7/stop');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stopped, true);
  // بعد از توقف، وضعیت واقعی از Manager خوانده می‌شود: همان اخطار health.stuck
  assert.equal(body.health.stuck, true);
  assert.deepEqual(body.health.stuckReasons, ['stale-lock']);

  await until(() => !isPidAlive(grandchild));
  assert.equal(isPidAlive(outsider.pid), true, 'فرآیند بیرون از registry نباید بسته شود');

  const after = (await (await authedFetch(`${base}/api/repos/fake/running`)).json())[0];
  assert.equal(after.running, false);
  assert.equal(after.stopped, true);

  const audit = new AuditLog({ dir: config.dataDir });
  const stop = audit.summaries({ action: 'run.stop' })[0];
  assert.equal(stop.user, 'operator');
  assert.equal(stop.taskId, '7');
  assert.equal(stop.status, 'stopped');
  assert.equal(audit.summaries({ action: 'run' })[0].status, 'stopped');
});

test('توقف: اجرای در صف فقط از صف حذف می‌شود؛ چیزی برای توقف نباشد → 409 و هیچ فرآیندی بسته نمی‌شود', async t => {
  const fake = makeFakeManagerRepo(t, { run: LONG_RUN });
  const { base } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, run: { maxConcurrent: 1, stopGraceMs: 300 } });
  const outsider = externalProcess(t);

  assert.equal((await post(base, '/api/repos/fake/tasks/1/run')).status, 202);
  assert.equal((await post(base, '/api/repos/fake/tasks/2/run')).status, 202);
  const second = (await (await authedFetch(`${base}/api/repos/fake/running`)).json()).find(r => r.taskId === '2');
  assert.equal(second.queued, true);

  const dequeued = await post(base, '/api/repos/fake/tasks/2/stop');
  assert.equal(dequeued.status, 200);
  assert.equal((await dequeued.json()).wasQueued, true);
  assert.equal(fs.existsSync(path.join(fake.root, 'grandchild-2.pid')), false, 'task 2 هیچ‌وقت شروع نشد');

  assert.equal((await post(base, '/api/repos/fake/tasks/999/stop')).status, 409);
  assert.equal((await post(base, '/api/execs/20260101000000-deadbeef/stop')).status, 409);
  assert.equal(isPidAlive(outsider.pid), true);

  await post(base, '/api/repos/fake/tasks/1/stop');
});

test('killProcessTree: pid نامعتبر یا ۱ هرگز پذیرفته نمی‌شود (API هیچ pid دلخواهی از بیرون نمی‌گیرد)', async () => {
  await assert.rejects(() => killProcessTree(0), /pid/);
  await assert.rejects(() => killProcessTree(1), /pid/);
  await assert.rejects(() => killProcessTree('12'), /pid/);
  await assert.rejects(() => killProcessTree(-5), /pid/);
});

test('killProcessTree روی ویندوز اول taskkill /T /PID (بدون /F) و فقط در صورت زنده ماندن /T /F را صدا می‌زند', async () => {
  const calls = [];
  let alive = true;
  await killProcessTree(4242, {
    platform: 'win32', graceMs: 50,
    exec: async (file, args) => { calls.push([file, ...args]); if (args.includes('/F')) alive = false; return {}; },
    alive: () => alive
  });
  assert.deepEqual(calls, [['taskkill', '/T', '/PID', '4242'], ['taskkill', '/T', '/F', '/PID', '4242']]);

  const polite = [];
  let up = true;
  await killProcessTree(4243, {
    platform: 'win32', graceMs: 500,
    exec: async (file, args) => { polite.push(args); up = false; return {}; },
    alive: () => up
  });
  assert.equal(polite.length, 1, 'اگر مؤدبانه بسته شد، /F لازم نیست');
});
