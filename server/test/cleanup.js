// پاک‌سازی ِ مشترک ِ تست‌ها: هر process / timer / سرور / پوشه‌ی موقتی که یک تست می‌سازد باید حتی وقتی تست وسط ِ کار شکست
// می‌خورد بسته شود، وگرنه فرزند ِ زنده (مثل `setInterval(() => {}, 1000)` در یک fake run) کل ِ `npm test` را برای همیشه معلق
// نگه می‌دارد و روی ویندوز پوشه‌ی موقت را قفل می‌کند (EPERM).
//
// چرا `t.after` ِ خام کافی نیست: hookهای `t.after` به ترتیب **ثبت** اجرا می‌شوند (FIFO)، نه برعکس. یعنی پوشه‌ی موقت (که اول ساخته
// شده) پیش از سرور و فرزندهایی که داخلش کار می‌کنند پاک می‌شد. `onCleanup` همه‌ی پاک‌سازی‌ها را در یک پشته نگه می‌دارد و در
// یک hook به ترتیب ِ **معکوس** (آخری‌ترین ساخته‌شده اول) اجرا می‌کند؛ خطای هر کدام بقیه را متوقف نمی‌کند و همه‌ی خطاها آخر گزارش می‌شوند.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const stacks = new WeakMap();
const STEP_TIMEOUT_MS = 20_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runStack(stack) {
  const errors = [];
  while (stack.length) {
    const { label, fn } = stack.pop();
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`پاک‌سازی «${label}» بعد از ${STEP_TIMEOUT_MS / 1000} ثانیه تمام نشد.`)), STEP_TIMEOUT_MS); })
      ]);
    } catch (error) {
      errors.push(new Error(`پاک‌سازی «${label}»: ${error?.message || error}`, { cause: error }));
    } finally { clearTimeout(timer); }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join(' | '));
}

/** @param t TestContext  @param label نام برای پیام خطا  @param fn () => void | Promise<void> — به ترتیب معکوس ِ ثبت اجرا می‌شود */
export function onCleanup(t, label, fn) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(() => runStack(stacks.get(t)));
  }
  stack.push({ label, fn });
}

/** پوشه‌ی موقت با تلاش ِ مجدد (ویندوز: چند ده میلی‌ثانیه طول می‌کشد تا قفل ِ فرزند ِ تازه‌مرده آزاد شود). */
export function removeDirOnCleanup(t, dir) {
  onCleanup(t, `حذف ${dir}`, () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
}

/** درخت ِ فرآیند را می‌بندد (ویندوز: taskkill /T /F؛ دیگر: kill ِ گروه/خود فرآیند). نبودن ِ فرآیند خطا نیست. */
export function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* مرده بود */ } } }
}

/** فرزندی که تست ساخته (spawn) حتی با شکست ِ تست بسته می‌شود. */
export function trackChild(t, child, label = `child ${child.pid}`) {
  onCleanup(t, label, () => killTree(child.pid));
  return child;
}

/**
 * سرور ِ createApp را کامل می‌بندد: run های زنده (registry)، timerها، اتصال‌های باز (SSE / keep-alive)، و خود ِ سرور.
 * `server.close()` ِ تنها تا بسته شدن ِ همه‌ی اتصال‌ها صبر می‌کند و با یک SSE ِ باز هرگز تمام نمی‌شود.
 */
export async function closeServer(server) {
  const handle = server.barsa;
  if (handle) {
    handle.lifecycle.closing = true;
    handle.registry.beginShutdown?.();
    try { await handle.registry.stopAll?.(); } catch { /* ادامه می‌دهیم */ }
    for (const exec of handle.runner?.list?.() ?? []) { if (exec.running) await handle.runner.stop(exec.id).catch(() => false); }
    handle.lifecycle.disposeTimers();
    const deadline = Date.now() + 5000;
    while (handle.registry.activeCount?.() > 0 && Date.now() < deadline) await sleep(25);
  }
  server.closeAllConnections?.();
  await new Promise(resolve => server.close(() => resolve()));
}

/** سرور را برای پایان ِ تست بسته نگه می‌دارد (ترتیب معکوس: پیش از پاک شدن ِ پوشه‌هایی که پیش‌تر ثبت شده‌اند). */
export function closeServerOnCleanup(t, server, label = 'بستن سرور') {
  onCleanup(t, label, () => closeServer(server));
}

/** تا برقرار شدن ِ شرط صبر می‌کند (رویداد/وضعیت ِ قطعی، نه زمان ِ ثابت). با تمام شدن ِ مهلت پیام ِ روشن می‌دهد. */
export async function waitUntil(predicate, { timeoutMs = 10_000, intervalMs = 25, label = 'شرط' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`${label} در ${timeoutMs}ms برقرار نشد.`);
    await sleep(intervalMs);
  }
}
