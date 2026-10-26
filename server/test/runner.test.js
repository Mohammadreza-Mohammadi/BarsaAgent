import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { removeDirOnCleanup, trackChild, waitUntil } from './cleanup.js';
import { isPidAlive } from '../src/process-tools.js';

// اثبات ِ «هیچ تستی کل ِ npm test را معلق نمی‌کند» (ج): یک تست ِ عمداً شکسته که run ِ زنده و سرور باز گذاشته، یک تست ِ گیرکرده، و
// یک فایل که event-loop را می‌بندد؛ اجراکننده باید در زمان ِ کوتاه تمام شود، همه را با پیام ِ روشن گزارش کند، کد ِ خروج ≠ 0 بدهد، و
// هیچ فرزند ِ زنده‌ای (fake run) باقی نماند.

const RUNNER = new URL('../run-tests.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const HELPERS = new URL('./helpers.js', import.meta.url).href;
const FAKE = new URL('./fake-manager.js', import.meta.url).href;
const CLEANUP = new URL('./cleanup.js', import.meta.url).href;

test('اجراکننده: تست ِ شکسته، تست ِ گیرکرده و حلقه‌ی بی‌پایان ← تمام می‌شود، گزارش ِ روشن، فرزند ِ زنده نمی‌ماند', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-runner-'));
  removeDirOnCleanup(t, dir);
  const pidFile = path.join(dir, 'live-run.pid');

  // ۱) شکست در میانه‌ی تست، وقتی سرور + run ِ زنده + SSE باز است
  fs.writeFileSync(path.join(dir, 'broken.test.js'), `
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { authedFetch, startAuthedServer } from '${HELPERS}';
import { HELD_RUN, makeFakeManagerRepo } from '${FAKE}';
import { waitUntil } from '${CLEANUP}';
test('عمداً شکسته: run ِ زنده و SSE باز، بعد خطا', async t => {
  const fake = makeFakeManagerRepo(t, { run: HELD_RUN, status: { schemaVersion: 1, repo: {}, tasks: [] } });
  const { base } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {} });
  await authedFetch(base + '/api/repos/fake/tasks/7/run', { method: 'POST' });
  await waitUntil(() => fs.existsSync(path.join(fake.root, 'started-7')));
  fs.writeFileSync(${JSON.stringify(pidFile)}, fs.readFileSync(path.join(fake.root, 'started-7'), 'utf8'));
  const stream = await authedFetch(base + '/api/repos/fake/tasks/7/stream');
  void stream.body.getReader().read();
  throw new Error('شکست ِ عمدی ِ اثبات');
});
`);

  // ۲) تست ِ گیرکرده: هیچ‌وقت تمام نمی‌شود (باید با --test-timeout شکست بخورد، نه معلق بماند)
  fs.writeFileSync(path.join(dir, 'hang.test.js'), `
import test from 'node:test';
test('عمداً گیرکرده', async () => { setInterval(() => {}, 1000); await new Promise(() => {}); });
test('تست ِ سالم ِ بعدی هنوز اجرا می‌شود', () => {});
`);

  // ۳) event-loop بسته: هیچ تایمری کار نمی‌کند ← فقط سقف ِ فایل می‌تواند نجات بدهد
  fs.writeFileSync(path.join(dir, 'spin.test.js'), `
import test from 'node:test';
test('حلقه‌ی بی‌پایان', () => { for (;;) { /* busy */ } });
`);

  const child = trackChild(t, spawn(process.execPath, [RUNNER, '--file-timeout=25', '--test-timeout=4', '--jobs=3'], {
    env: { ...process.env, BARSA_TEST_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  }), 'اجراکننده');
  let output = '';
  child.stdout.on('data', d => { output += d; });
  child.stderr.on('data', d => { output += d; });
  const t0 = Date.now();
  const exit = await new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
  const seconds = (Date.now() - t0) / 1000;

  assert.equal(exit.code, 1, `باید با کد 1 (شکست) تمام شود:\n${output}`);
  assert.ok(seconds < 60, `باید در کمتر از ۶۰ ثانیه تمام شود؛ ${seconds}s طول کشید`);
  assert.match(output, /✖ broken\.test\.js/, 'تست ِ شکسته گزارش شد');
  assert.match(output, /شکست ِ عمدی ِ اثبات/, 'پیام ِ خطای تست در گزارش است');
  assert.match(output, /✖ hang\.test\.js/, 'تست ِ گیرکرده با --test-timeout شکست خورد (نه معلق)');
  assert.match(output, /⏱ spin\.test\.js[^\n]*TIMEOUT/, 'فایل ِ بسته‌ی event-loop با سقف ِ فایل کشته و گزارش شد');
  assert.match(output, /TIMEOUT: «spin\.test\.js» بعد از 25 ثانیه تمام نشد/);
  assert.match(output, /خلاصه: 3 فایل/);

  // پاک‌سازی ِ تست ِ شکسته کار کرد: fake run ِ زنده نمانده
  const livePid = Number(fs.readFileSync(pidFile, 'utf8'));
  await waitUntil(() => !isPidAlive(livePid), { timeoutMs: 5000, label: `مرگ ِ فرآیند ِ ${livePid} (fake run)` });
});
