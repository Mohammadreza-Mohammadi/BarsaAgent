// اجرای‌کننده‌ی تست‌ها (`npm test`). جایگزین ِ `node --test server/test/*.test.js` که یک تست ِ شکسته می‌توانست کل ِ اجرا را
// برای همیشه معلق نگه دارد (فرزند ِ زنده‌ی fake run، سرور با SSE ِ باز، ...).
//
// هر فایل ِ تست در **فرآیند ِ جدا** و موازی (استخر ِ jobs) اجرا می‌شود با:
//   • `--test-timeout` : سقف ِ هر تست (پیش‌فرض ۱۲۰ ثانیه)؛ تست ِ گیر کرده «شکست» می‌شود و hookهای پاک‌سازی‌اش اجرا می‌شوند
//   • سقف ِ هر فایل (پیش‌فرض ۳۰۰ ثانیه): از آن بگذرد، درخت ِ فرآیندش بسته می‌شود و با پیام ِ روشن «TIMEOUT» گزارش می‌شود
//   • `--test-force-exit` : فرآیند ِ تست بعد از پایان ِ تست‌ها حتی با handle ِ باقی‌مانده خارج می‌شود
// کد ِ خروج ≠ ۰ اگر هر فایلی شکست یا timeout بخورد.
//
// استفاده:  node server/run-tests.mjs [filter ...] [--jobs=N] [--file-timeout=ثانیه] [--test-timeout=ثانیه] [--name=الگو]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.join(here, 'test');

const opts = { jobs: Math.max(2, Math.min(8, os.availableParallelism() - 1)), fileTimeout: 300, testTimeout: 120, name: null, filters: [] };
for (const arg of process.argv.slice(2)) {
  const [key, value] = arg.startsWith('--') ? arg.slice(2).split('=') : [null, null];
  if (key === 'jobs') opts.jobs = Math.max(1, Number(value));
  else if (key === 'file-timeout') opts.fileTimeout = Number(value);
  else if (key === 'test-timeout') opts.testTimeout = Number(value);
  else if (key === 'name') opts.name = value;
  else if (!key) opts.filters.push(arg);
  else { console.error(`گزینه‌ی ناشناخته: ${arg}`); process.exit(2); }
}
// تست ِ خود ِ اجراکننده (hang proof): فایل‌هایی از پوشه‌ی دیگر
const dir = process.env.BARSA_TEST_DIR ? path.resolve(process.env.BARSA_TEST_DIR) : testDir;
const files = fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && (!opts.filters.length || opts.filters.some(x => f.includes(x)))).sort();
if (!files.length) { console.error('هیچ فایل ِ تستی پیدا نشد.'); process.exit(2); }

function killTree(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* مرده */ } } }
}

const count = (text, label) => Number(new RegExp(`^ℹ ${label} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
const tail = (text, lines) => text.trimEnd().split(/\r?\n/).slice(-lines).join('\n');

function runFile(file) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const args = ['--test', `--test-timeout=${opts.testTimeout * 1000}`, '--test-force-exit', ...(opts.name ? [`--test-name-pattern=${opts.name}`] : []), path.join(dir, file)];
    // NODE_TEST_CONTEXT را از env ِ فرزند حذف می‌کنیم: اگر خود ِ اجراکننده زیر یک `node --test` اجرا شود (مثل تست ِ runner.test.js)، node
    // فرزند را «زیرتست» می‌پندارد، خروجی ِ متنی نمی‌دهد و با exit 0 و صفر تست «موفق» برمی‌گردد.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, args, { cwd: path.dirname(here), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', d => { output += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.fileTimeout * 1000);
    child.on('error', error => { clearTimeout(timer); resolve({ file, ms: Date.now() - startedAt, output: String(error), code: 1, error: true }); });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ file, ms: Date.now() - startedAt, output, code: timedOut ? null : code, timedOut });
    });
  });
}

const results = [];
const queue = [...files];
const started = Date.now();
await Promise.all(Array.from({ length: Math.min(opts.jobs, files.length) }, async () => {
  while (queue.length) {
    const file = queue.shift();
    const result = await runFile(file);
    result.tests = count(result.output, 'tests');
    result.pass = count(result.output, 'pass');
    result.fail = count(result.output, 'fail') + count(result.output, 'cancelled');
    result.empty = !result.timedOut && !result.error && result.tests === 0; // صفر تست «موفقیت» نیست (مثلاً خطای import یا خروجی ِ گم‌شده)
    result.ok = !result.timedOut && !result.error && result.code === 0 && result.fail === 0 && !result.empty;
    results.push(result);
    const mark = result.ok ? '✔' : result.timedOut ? '⏱' : '✖';
    console.log(`${mark} ${file}  (${(result.ms / 1000).toFixed(1)}s · ${result.pass}/${result.tests} موفق${result.timedOut ? ' · TIMEOUT' : ''})`);
    if (!result.ok) {
      if (result.timedOut) {
        console.log(`   ⏱ TIMEOUT: «${file}» بعد از ${opts.fileTimeout} ثانیه تمام نشد و (با درخت ِ فرآیندش) بسته شد.`);
        console.log(`   معمولاً یعنی فرآیند/سرور/timerای در پاک‌سازی ِ یک تست بسته نشده. ۱۵ خط ِ آخر ِ خروجی:`);
        console.log(tail(result.output, 15).split('\n').map(l => `   | ${l}`).join('\n'));
      } else {
        if (result.empty) console.log(`   ✖ از «${file}» هیچ تستی گزارش نشد (خطای import / خروجی ِ گم‌شده)؛ این موفقیت حساب نمی‌شود.`);
        const failing = result.output.split('✖ failing tests:')[1];
        console.log((failing ? `✖ failing tests:${failing}` : tail(result.output, 30)).trimEnd().split('\n').map(l => `   | ${l}`).join('\n'));
      }
    }
  }
}));

results.sort((a, b) => a.file.localeCompare(b.file));
const total = results.reduce((s, r) => s + r.tests, 0);
const pass = results.reduce((s, r) => s + r.pass, 0);
const bad = results.filter(r => !r.ok);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nخلاصه: ${results.length} فایل · ${total} تست · ${pass} موفق · ${bad.length} فایل ناموفق · ${seconds} ثانیه (jobs=${opts.jobs})`);
if (bad.length) {
  for (const r of bad) console.log(`  ✖ ${r.file}${r.timedOut ? ' (TIMEOUT)' : ''}`);
  process.exit(1);
}
process.exit(0);
