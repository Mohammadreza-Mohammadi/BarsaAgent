import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { authedFetch, startAuthedServer } from './helpers.js';
import { HELD_RUN, makeFakeManagerRepo, releaseHeldRun } from './fake-manager.js';
import { onCleanup, removeDirOnCleanup, trackChild, waitUntil } from './cleanup.js';
import { Lifecycle, createShutdown, openHandles } from '../src/shutdown.js';
import { isPidAlive } from '../src/process-tools.js';

// shutdown ِ مرتب (الف): سیگنال ← سرور با اتصال‌های باز (SSE / keep-alive) بسته می‌شود، timerها می‌ایستند، run های زنده در لاگ
// نام برده می‌شوند، و فرآیند در مهلت خارج می‌شود. شاهد ِ باگ: `nssm stop` در STOP_PENDING می‌ماند چون `server.close()` منتظر ِ SSE بود.

const logs = () => {
  const lines = [];
  return { lines, info: m => lines.push(m), warn: m => lines.push(m) };
};

async function boot(t, { run = HELD_RUN, shutdown = { timeoutMs: 8000 }, tasks = [] } = {}) {
  const fake = makeFakeManagerRepo(t, { run, status: { schemaVersion: 1, repo: {}, tasks } });
  const log = logs();
  const exits = [];
  const started = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, run: { stopGraceMs: 300 }, shutdown }, { exit: code => exits.push(code), shutdownLog: log });
  return { fake, log, exits, ...started };
}

/** اتصال ِ keep-alive ِ بیکار: یک درخواست می‌زند و سوکت را باز نگه می‌دارد. */
async function idleKeepAlive(t, base) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  onCleanup(t, 'agent ِ keep-alive', () => agent.destroy());
  await new Promise((resolve, reject) => {
    http.get(`${base}/api/auth/session`, { agent }, res => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  return agent;
}

/** SSE ِ باز: تا بسته شدن ِ سرور می‌خواند. */
async function openStream(t, base, repo, taskId) {
  const controller = new AbortController();
  onCleanup(t, 'SSE', () => controller.abort());
  const response = await authedFetch(`${base}/api/repos/${repo}/tasks/${taskId}/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const closed = (async () => { try { for (;;) { const { done } = await reader.read(); if (done) return 'ended'; } } catch { return 'errored'; } })();
  return { closed };
}

test('shutdown با SSE ِ باز، اتصال ِ keep-alive و run ِ زنده: در مهلت تمام می‌شود، نام ِ run در لاگ است، اتصال‌ها بسته‌اند', async t => {
  const s = await boot(t);
  const post = await authedFetch(`${s.base}/api/repos/fake/tasks/7/run`, { method: 'POST' });
  assert.equal(post.status, 202);
  await waitUntil(() => fs.existsSync(path.join(s.fake.root, 'started-7')), { label: 'شروع ِ run ِ 7' });
  const childPid = Number(fs.readFileSync(path.join(s.fake.root, 'started-7'), 'utf8'));
  const stream = await openStream(t, s.base, 'fake', '7');
  await idleKeepAlive(t, s.base);

  const t0 = Date.now();
  const code = await s.server.barsa.shutdown('SIGTERM');
  const elapsed = Date.now() - t0;

  assert.equal(code, 0);
  assert.deepEqual(s.exits, [0], 'exit دقیقاً یک بار و با 0');
  assert.ok(elapsed < 6000, `shutdown باید در مهلت (۸ثانیه) و عملاً سریع تمام شود؛ ${elapsed}ms طول کشید`);
  assert.ok(['ended', 'errored'].includes(await stream.closed), 'SSE ِ باز بسته شد (وگرنه server.close تا ابد منتظر می‌ماند)');
  assert.equal(s.server.listening, false);
  assert.equal(s.server.barsa.lifecycle.timerCount, 0, 'ping ِ SSE و timerهای دیگر متوقف شدند');

  const text = s.log.lines.join('\n');
  assert.match(text, /SIGTERM دریافت شد/);
  assert.match(text, /1 run ِ زنده هست: #7 \(fake،/, 'نام ِ run ِ زنده در لاگ');
  assert.match(text, /بازیابی ِ #7/);
  assert.match(text, /node scripts\/manager\.js run 7/, 'فرمان ِ بازیابی');
  assert.match(text, /barsa run 7/);
  assert.match(text, /تمام شد در/);
  await waitUntil(() => !isPidAlive(childPid), { label: 'مرگ ِ فرآیند ِ run' });
});

test('shutdown با liveRuns=leave: فرآیند ِ run رها می‌شود (مسئولیت با NSSM AppKillProcessTree) و لاگ همین را می‌گوید', async t => {
  const s = await boot(t, { shutdown: { timeoutMs: 8000, liveRuns: 'leave' } });
  await authedFetch(`${s.base}/api/repos/fake/tasks/7/run`, { method: 'POST' });
  await waitUntil(() => fs.existsSync(path.join(s.fake.root, 'started-7')), { label: 'شروع ِ run' });
  const childPid = Number(fs.readFileSync(path.join(s.fake.root, 'started-7'), 'utf8'));
  onCleanup(t, 'فرآیند ِ رهاشده', () => { releaseHeldRun(s.fake.root); });

  assert.equal(await s.server.barsa.shutdown('SIGINT'), 0);
  assert.match(s.log.lines.join('\n'), /liveRuns=leave: فرآیند ِ run های زنده رها شد/);
  assert.match(s.log.lines.join('\n'), /#7/);
  assert.equal(isPidAlive(childPid), true, 'در حالت ِ leave فرآیند ِ run بسته نمی‌شود');
});

test('shutdown: صف ِ حافظه‌ای در لاگ می‌آید و (بدون drain) هشدار می‌دهد که از دست می‌رود، با فرمان ِ بازیابی', async t => {
  const s = await boot(t, { shutdown: { timeoutMs: 8000 } });
  // maxConcurrent پیش‌فرض ۲ است؛ سه run می‌فرستیم تا سومی در صف بماند
  for (const id of ['1', '2', '3']) await authedFetch(`${s.base}/api/repos/fake/tasks/${id}/run`, { method: 'POST' });
  await waitUntil(() => fs.existsSync(path.join(s.fake.root, 'started-1')) && fs.existsSync(path.join(s.fake.root, 'started-2')), { label: 'شروع ِ دو run' });
  assert.equal(await s.server.barsa.shutdown('SIGTERM'), 0);
  const text = s.log.lines.join('\n');
  assert.match(text, /2 run ِ زنده هست: #1.*#2/);
  assert.match(text, /1 run ِ در صف: #3 — صف در حافظه است و از دست می‌رود/);
  assert.equal(fs.existsSync(path.join(s.fake.root, 'started-3')), false, 'run ِ صف‌شده هنگام ِ خاموش شدن شروع نمی‌شود');
});

test('در حال خاموش شدن: درخواست ِ تازه 503 می‌گیرد', async t => {
  const s = await boot(t);
  assert.equal((await authedFetch(`${s.base}/api/repos`)).status, 200); // ورود
  s.server.barsa.lifecycle.closing = true;
  const response = await authedFetch(`${s.base}/api/repos`);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '10');
  assert.match((await response.json()).error, /خاموش/);
});

test('مهلت: اگر چیزی جلوی خروج را بگیرد، handleهای باز در لاگ می‌آید و خروج اجباری (کد 1) انجام می‌شود', async t => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onCleanup(t, 'سرور', () => { server.closeAllConnections(); server.close(); });
  const log = logs();
  const exits = [];
  const t0 = Date.now();
  const shutdown = createShutdown({
    server, lifecycle: new Lifecycle(), timeoutMs: 400, log, exit: code => exits.push(code),
    registry: { beginShutdown() {}, liveSnapshot: () => [{ repoId: 'fake', taskId: '9', startedAt: new Date().toISOString() }], queuedSnapshot: () => [], stopAll: () => new Promise(() => {}) },
    runner: { list: () => [] }, getResources: () => ['Timeout', 'Timeout', 'TCPSocketWrap']
  });
  shutdown('SIGTERM'); // stopAll هرگز تمام نمی‌شود
  await waitUntil(() => exits.length > 0, { timeoutMs: 3000, label: 'خروج ِ اجباری' });
  assert.deepEqual(exits, [1]);
  assert.ok(Date.now() - t0 < 2000);
  const text = log.lines.join('\n');
  assert.match(text, /مهلت \(\d+ ثانیه\) تمام شد/);
  assert.match(text, /handleهای باز: Timeout×2، TCPSocketWrap×1/, 'نام ِ handle ِ باز در لاگ');
  assert.match(text, /#9/, 'نام ِ run ِ زنده هم');
});

test('سیگنال ِ دوم در حین ِ خاموش شدن = خروج ِ فوری با کد 1', async t => {
  const server = http.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onCleanup(t, 'سرور', () => { server.closeAllConnections(); server.close(); });
  const log = logs();
  const exits = [];
  const shutdown = createShutdown({
    server, lifecycle: new Lifecycle(), timeoutMs: 5000, log, exit: code => exits.push(code),
    registry: { beginShutdown() {}, liveSnapshot: () => [{ repoId: 'fake', taskId: '9', startedAt: new Date().toISOString() }], queuedSnapshot: () => [], stopAll: () => new Promise(() => {}) },
    runner: { list: () => [] }
  });
  shutdown('SIGINT');
  shutdown('SIGINT');
  assert.deepEqual(exits, [1]);
  assert.match(log.lines.join('\n'), /سیگنال ِ دوم/);
});

test('openHandles: نام و تعداد، بدون وابستگی به فرآیند ِ تست', () => {
  assert.deepEqual(openHandles(() => ['Timeout', 'TCPServerWrap', 'Timeout']), ['Timeout×2', 'TCPServerWrap×1']);
  assert.deepEqual(openHandles(() => []), []);
});

test('فرآیند ِ واقعی (مسیر ِ production): SIGINT ← خودش خارج می‌شود (کد 0) در مهلت، لاگ نام ِ run را دارد و هیچ handle ِ باز نمی‌ماند', async t => {
  const fake = makeFakeManagerRepo(t, { run: HELD_RUN, status: { schemaVersion: 1, repo: {}, tasks: [] } });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-shutdown-child-'));
  removeDirOnCleanup(t, dataDir);
  const configFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(configFile, JSON.stringify({ repos: [fake.repo], server: {}, issueSource: {}, dataDir, run: { stopGraceMs: 300 }, shutdown: { timeoutMs: 8000 } }));

  const child = trackChild(t, spawn(process.execPath, [new URL('./fixtures/shutdown-child.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), configFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }), 'فرآیند ِ سرور');
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));

  await waitUntil(() => /PORT \d+/.test(output), { label: 'بالا آمدن ِ سرور ِ فرزند' });
  const base = `http://127.0.0.1:${/PORT (\d+)/.exec(output)[1]}`;
  const post = await authedFetch(`${base}/api/repos/fake/tasks/7/run`, { method: 'POST' });
  assert.equal(post.status, 202);
  await waitUntil(() => fs.existsSync(path.join(fake.root, 'started-7')), { label: 'شروع ِ run' });
  const stream = await openStream(t, base, 'fake', '7');
  await idleKeepAlive(t, base);

  const t0 = Date.now();
  child.stdin.write('go\n');
  const result = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve('TIMEOUT'), 15_000))]);
  assert.notEqual(result, 'TIMEOUT', `فرآیند در ۱۵ ثانیه خارج نشد. خروجی:\n${output}`);
  assert.deepEqual(result, { code: 0, signal: null }, `خروجی:\n${output}`);
  assert.ok(Date.now() - t0 < 9000);
  assert.ok(['ended', 'errored'].includes(await stream.closed), 'SSE ِ باز بسته شد (وگرنه server.close تا ابد منتظر می‌ماند)');

  assert.match(output, /\[shutdown\] SIGINT دریافت شد/);
  assert.match(output, /run ِ زنده هست: #7 \(fake،/);
  assert.match(output, /barsa run 7/);
  assert.doesNotMatch(output, /مهلت .* تمام شد/, 'خروج با مهلت ِ اجباری نبود');
  const handles = /handleهای باز: (.*)/.exec(output)?.[1] ?? '';
  assert.ok(handles, `خط ِ handleها در لاگ نیست:\n${output}`);
  assert.doesNotMatch(handles, /Timeout|TCPServerWrap|TCPSocketWrap|ChildProcess|Immediate|Process/, `handle ِ باز مانده: ${handles}`);
});
