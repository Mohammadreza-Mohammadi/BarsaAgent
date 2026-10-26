// shutdown ِ مرتب (SIGINT / SIGTERM / SIGBREAK / SIGHUP) با مهلت ِ مشخص.
//
// شاهد (سرور، NSSM): `nssm stop BarsaAgent` دو بار در SERVICE_STOP_PENDING گیر کرد، یک بار حتی بدون هیچ run ِ زنده. علت:
// `server.close(cb)` تا بسته شدن ِ **همه‌ی** اتصال‌ها (keep-alive، SSE ِ لاگ زنده با ping ِ ۱۵ثانیه‌ای) صبر می‌کند و یکی از
// آن‌ها هیچ‌وقت نمی‌بندد؛ پس `process.exit` هرگز نمی‌رسید.
//
// مسیر ِ واحد (هر چهار سیگنال):
//   ۱) پذیرفتن ِ کار ِ تازه متوقف می‌شود (HTTP ← 503، registry ← هیچ run ِ تازه‌ای شروع نمی‌شود)
//   ۲) سرور بسته می‌شود **همراه با** اتصال‌های باز (idle فوراً؛ باقی بعد از یک مهلت ِ کوتاه با closeAllConnections)
//   ۳) همه‌ی timerهای ثبت‌شده (ping ِ SSE، ...) متوقف می‌شوند
//   ۴) run های زنده: نام‌شان و فرمان ِ بازیابی در لاگ می‌آید؛ (اختیاری) تا runWaitMs صبر؛ بعد درخت ِ فرآیندشان بسته می‌شود
//   ۵) stdout/stderr flush و خروج. سقف ِ کل timeoutMs است؛ اگر چیزی جلویش را گرفت، نام ِ handle ِ باز در لاگ می‌آید و خارج می‌شود
import { durationText } from './drain.js';

export const SHUTDOWN_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']);
export const DEFAULT_TIMEOUT_MS = 10_000;

/** timerهای سرور (ping ِ SSE و ...) که shutdown باید همه را بتواند بیندازد. */
export class Lifecycle {
  closing = false;
  #timers = new Set();

  trackInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    this.#timers.add(timer);
    return timer;
  }

  clear(timer) {
    clearInterval(timer);
    this.#timers.delete(timer);
  }

  get timerCount() { return this.#timers.size; }

  disposeTimers() {
    const count = this.#timers.size;
    for (const timer of this.#timers) clearInterval(timer);
    this.#timers.clear();
    return count;
  }
}

/** نام و تعداد ِ handleهای باز ِ فرآیند (به‌جز stdout/stderr/stdin)، مثل `Timeout×2، TCPSocketWrap×1`. */
export function openHandles(getResources = () => process.getActiveResourcesInfo?.() ?? []) {
  const counts = new Map();
  for (const name of getResources()) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${name}×${count}`);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * @param o.server     http.Server
 * @param o.registry   ProcessRegistry
 * @param o.runner     ActionRunner
 * @param o.lifecycle  Lifecycle
 * @param o.audit      AuditLog (اختیاری)
 * @param o.log        { info(msg), warn(msg) }
 * @param o.exit       (code) => never — در تست تزریق می‌شود
 * @param o.timeoutMs  سقف ِ کل
 * @param o.runWaitMs  صبر برای پایان ِ طبیعی ِ run های زنده (پیش‌فرض ۰)
 * @param o.liveRuns   'terminate' (پیش‌فرض: درخت ِ فرآیند بسته می‌شود) | 'leave' (رها؛ مسئولیت با NSSM AppKillProcessTree)
 */
export function createShutdown(o) {
  const {
    server, registry, runner, lifecycle, audit = null, exit = code => process.exit(code), timeoutMs = DEFAULT_TIMEOUT_MS,
    runWaitMs = 0, liveRuns = 'terminate', getResources, now = () => Date.now(),
    log = { info: m => console.log(m), warn: m => console.warn(m) }
  } = o;
  const cmd = taskId => `node scripts/manager.js run ${taskId}  (یا در کانبان: barsa run ${taskId})`;
  let running = null;
  let signalCount = 0;

  async function run(signal) {
    const startedAt = now();
    const elapsed = () => durationText(now() - startedAt);
    log.info(`[shutdown] ${signal} دریافت شد؛ خاموش شدن ِ مرتب (سقف ${Math.round(timeoutMs / 1000)} ثانیه).`);

    // ۱) پذیرفتن ِ کار ِ تازه
    lifecycle.closing = true;
    registry.beginShutdown?.();

    // ۲) سرور + اتصال‌های باز
    const closed = new Promise(resolve => { try { server.close(() => resolve(true)); } catch { resolve(false); } });
    server.closeIdleConnections?.();
    const graceful = await Promise.race([closed, sleep(Math.min(1000, Math.floor(timeoutMs / 5))).then(() => false)]);
    if (!graceful) {
      server.closeAllConnections?.();
      await Promise.race([closed, sleep(500)]);
    }

    // ۳) timerها
    const timers = lifecycle.disposeTimers();
    log.info(`[shutdown] سرور HTTP بسته شد (${graceful ? 'اتصالی باز نبود' : 'اتصال‌های باز بسته شدند'}) · ${timers} timer متوقف شد.`);

    // ۴) run های زنده
    const live = registry.liveSnapshot?.() ?? [];
    const queued = registry.queuedSnapshot?.() ?? [];
    const execs = (runner?.list?.() ?? []).filter(x => x.running);
    const held = registry.draining === true;
    if (live.length || queued.length || execs.length) {
      if (live.length) {
        log.warn(`[shutdown] ⚠ ${live.length} run ِ زنده هست: ${live.map(x => `#${x.taskId} (${x.repoId}، ${durationText(now() - Date.parse(x.startedAt))})`).join('، ')}`);
      }
      if (execs.length) log.warn(`[shutdown] ⚠ ${execs.length} اجرای کانبان در جریان است: ${execs.map(x => `${x.action} (${x.id})`).join('، ')}`);
      if (queued.length) {
        log.warn(`[shutdown] ${queued.length} run ِ در صف: ${queued.map(x => `#${x.taskId}`).join('، ')} — ${held ? 'در drain.json ذخیره‌اند و بعد از restart در صف می‌مانند.' : 'صف در حافظه است و از دست می‌رود؛ بعد از راه‌اندازی دوباره بزن: ' + queued.map(x => cmd(x.taskId)).join('، ')}`);
      }
      if (runWaitMs > 0 && live.length) {
        const until = now() + runWaitMs;
        while (now() < until && (registry.liveSnapshot?.() ?? []).length) await sleep(100);
      }
      const stillLive = registry.liveSnapshot?.() ?? [];
      if (stillLive.length || execs.length) {
        if (liveRuns === 'terminate') {
          await registry.stopAll?.();
          await Promise.all(execs.map(x => runner.stop(x.id).catch(() => false)));
          // kill برگشته ولی رویداد ِ exit و بسته شدن ِ pipeهای فرزند (ProcessWrap / PipeWrap) یک چرخه‌ی event-loop بعد می‌رسد؛ تا آن موقع
          // handle باز است و لاگ ِ پایانی غلط گزارش می‌داد. تا ۲ ثانیه برای خالی شدن ِ registry صبر می‌کنیم.
          const settleUntil = now() + 2000;
          while (now() < settleUntil && (registry.activeCount?.() ?? 0) > 0) await sleep(25);
          await sleep(50);
          log.warn(`[shutdown] درخت ِ فرآیند ِ run های زنده بسته شد (${stillLive.map(x => `#${x.taskId}`).join('، ') || 'فقط اجراهای کانبان'}).`);
        } else {
          log.warn('[shutdown] liveRuns=leave: فرآیند ِ run های زنده رها شد (اگر NSSM با AppKillProcessTree=1 کار کند با سرویس بسته می‌شوند).');
        }
        for (const item of stillLive) {
          log.warn(`[shutdown] بازیابی ِ #${item.taskId}: بعد از راه‌اندازی دوباره «${cmd(item.taskId)}» — transition ِ نیمه‌کاره با قفل ِ مرده را Manager خودش پس می‌گیرد (TOOLING-030).`);
          try { audit?.note({ user: 'system', action: 'shutdown.run-interrupted', repoId: item.repoId, taskId: item.taskId, signal, mode: liveRuns }); } catch { /* ممیزی مانع خروج نیست */ }
        }
      }
    }

    // ۵) flush و خروج
    await new Promise(resolve => {
      let pending = 2;
      const done = () => { pending -= 1; if (pending === 0) resolve(); };
      process.stdout.write('', done);
      process.stderr.write('', done);
      setTimeout(resolve, 500).unref?.();
    });
    const handles = openHandles(getResources);
    log.info(`[shutdown] تمام شد در ${elapsed()}؛ خروج. handleهای باز: ${handles.join('، ') || '—'}`);
    return 0;
  }

  /** @returns {Promise<number>} exit code. دومین سیگنال (یا رسیدن به سقف) = خروج ِ فوری. */
  function shutdown(signal = 'SIGTERM') {
    signalCount += 1;
    if (running) {
      if (signalCount >= 2) {
        log.warn(`[shutdown] سیگنال ِ دوم (${signal}) در حین ِ خاموش شدن: خروج ِ فوری.`);
        exit(1);
      }
      return running;
    }
    const timer = setTimeout(() => {
      log.warn(`[shutdown] ⚠ مهلت (${Math.round(timeoutMs / 1000)} ثانیه) تمام شد و چیزی جلوی خروج را گرفت؛ handleهای باز: ${openHandles(getResources).join('، ') || '—'}. خروج ِ اجباری.`);
      exit(1);
    }, timeoutMs);
    timer.unref?.();
    running = run(signal).then(code => { clearTimeout(timer); exit(code); return code; }, error => {
      clearTimeout(timer);
      log.warn(`[shutdown] خطا در خاموش شدن: ${error?.message || error}`);
      exit(1);
      return 1;
    });
    return running;
  }

  shutdown.isRunning = () => running !== null;
  return shutdown;
}
