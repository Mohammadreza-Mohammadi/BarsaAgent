import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Scheduler } from '../../client/src/app/scheduler.ts';
import { LogBuffer, clipText, LOG_TAIL_DEFAULT, LOG_TAIL_MAX } from '../../client/src/app/log-buffer.ts';

// مصرف ِ CPU/حافظه‌ی مرورگر: زمان‌بند ِ مرکزی (یک timer، توقف با visibilitychange)، بافر ِ سقف‌دار ِ لاگ، و نبودن ِ timer ِ پراکنده.

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

/** محیط ِ ساختگی: ساعت ِ دستی، شمارش ِ setInterval/clearInterval، visibility قابل‌تنظیم. */
function fakeEnv() {
  const env = {
    time: 0, hidden: false, intervals: new Map(), nextId: 1, created: 0, cleared: 0, listeners: new Set(),
    setInterval(fn) { const id = env.nextId++; env.intervals.set(id, fn); env.created += 1; return id; },
    clearInterval(id) { if (env.intervals.delete(id)) env.cleared += 1; },
    now: () => env.time,
    isHidden: () => env.hidden,
    onVisibilityChange(cb) { env.listeners.add(cb); return () => env.listeners.delete(cb); },
    advance(ms) { env.time += ms; for (const fn of [...env.intervals.values()]) fn(); },
    setHidden(value) { env.hidden = value; for (const cb of [...env.listeners]) cb(); }
  };
  return env;
}

test('زمان‌بند: چند کار، فقط یک timer؛ هر کار در بازه‌ی خودش اجرا می‌شود', () => {
  const env = fakeEnv();
  const s = new Scheduler(env, 1000);
  const calls = { board: 0, drain: 0, health: 0 };
  s.add({ name: 'board', everyMs: 3000, run: () => { calls.board += 1; } });
  s.add({ name: 'drain', everyMs: 3000, run: () => { calls.drain += 1; } });
  s.add({ name: 'health', everyMs: 30_000, run: () => { calls.health += 1; } });
  assert.equal(env.created, 1, 'فقط یک setInterval');
  assert.equal(s.activeTimers, 1);
  for (let i = 0; i < 30; i += 1) env.advance(1000);
  assert.equal(calls.board, 10);
  assert.equal(calls.drain, 10);
  assert.equal(calls.health, 1);
  assert.equal(env.created, 1);
});

test('tab پنهان: timer خاموش و هیچ کاری اجرا نمی‌شود؛ برگشتن: hook ها، یک اجرای فوری، و timer دوباره روشن', () => {
  const env = fakeEnv();
  const s = new Scheduler(env, 1000);
  const log = [];
  s.add({ name: 'board', everyMs: 3000, run: () => log.push('board'), onHide: () => log.push('hide'), onShow: () => log.push('show') });
  env.advance(3000);
  assert.deepEqual(log, ['board']);

  env.setHidden(true);
  assert.equal(s.activeTimers, 0, 'timer خاموش');
  assert.equal(env.intervals.size, 0);
  assert.deepEqual(log, ['board', 'hide']);
  s.tick(); // حتی اگر کسی tick را دستی بزند
  for (let i = 0; i < 20; i += 1) env.advance(1000);
  assert.deepEqual(log, ['board', 'hide'], 'در پنهان بودن هیچ اجرایی نیست');

  env.setHidden(false);
  assert.deepEqual(log, ['board', 'hide', 'show', 'board'], 'اول show، بعد یک اجرای فوری');
  assert.equal(s.activeTimers, 1);
  env.advance(3000);
  assert.equal(log.at(-1), 'board');
  assert.equal(log.filter(x => x === 'board').length, 3);
});

test('کار ِ ناهمگام: تا تمام نشده دوباره شروع نمی‌شود', async () => {
  const env = fakeEnv();
  const s = new Scheduler(env, 1000);
  let starts = 0; let release;
  s.add({ name: 'slow', everyMs: 1000, run: () => { starts += 1; return new Promise(resolve => { release = resolve; }); } });
  env.advance(1000); env.advance(1000); env.advance(1000);
  assert.equal(starts, 1);
  release(); await Promise.resolve(); await Promise.resolve();
  env.advance(1000);
  assert.equal(starts, 2);
});

test('خطای یک کار timer را نمی‌کشد؛ کار ِ Infinity فقط hook دارد', () => {
  const env = fakeEnv();
  const s = new Scheduler(env, 1000);
  let ok = 0; const hooks = [];
  s.add({ name: 'bad', everyMs: 1000, run: () => { throw new Error('x'); } });
  s.add({ name: 'ok', everyMs: 1000, run: () => { ok += 1; } });
  s.add({ name: 'stream', everyMs: Infinity, onHide: () => hooks.push('hide'), onShow: () => hooks.push('show') });
  env.advance(1000); env.advance(1000);
  assert.equal(ok, 2);
  env.setHidden(true); env.setHidden(false);
  assert.deepEqual(hooks, ['hide', 'show']);
});

test('پاک شدن: برداشتن ِ آخرین کار timer را می‌بندد؛ dispose همه چیز را پاک می‌کند؛ کار ِ برداشته‌شده دیگر اجرا نمی‌شود', () => {
  const env = fakeEnv();
  const s = new Scheduler(env, 1000);
  let a = 0; let b = 0;
  const removeA = s.add({ name: 'a', everyMs: 1000, run: () => { a += 1; } });
  const removeB = s.add({ name: 'b', everyMs: 1000, run: () => { b += 1; } });
  env.advance(1000);
  removeA();
  env.advance(1000);
  assert.deepEqual([a, b], [1, 2]);
  assert.equal(s.activeTimers, 1);
  removeB();
  assert.equal(s.activeTimers, 0, 'آخرین کار رفت ⇒ timer بسته');
  assert.equal(env.intervals.size, 0);

  const again = s.add({ name: 'c', everyMs: 1000, run: () => {} });
  assert.equal(s.activeTimers, 1);
  s.dispose();
  assert.equal(s.activeTimers, 0);
  assert.equal(env.listeners.size, 0, 'شنونده‌ی visibilitychange برداشته شد');
  again(); // بعد از dispose بی‌اثر
  assert.equal(s.add({ name: 'd', everyMs: 1000, run: () => {} }) instanceof Function, true);
  assert.equal(s.activeTimers, 0);
});

test('ثبت با نام ِ تکراری جای قبلی را می‌گیرد (دو timer/کار ِ هم‌نام نمی‌شود)؛ remove ِ قدیمی کار ِ جدید را نمی‌برد', () => {
  const env = fakeEnv();
  const s = new Scheduler(env, 1000);
  let n = 0; let m = 0;
  const removeOld = s.add({ name: 'x', everyMs: 1000, run: () => { n += 1; } });
  s.add({ name: 'x', everyMs: 1000, run: () => { m += 1; } });
  removeOld();
  env.advance(1000);
  assert.deepEqual([n, m], [0, 1]);
  assert.deepEqual(s.names, ['x']);
});

test('LogBuffer: حافظه سقف‌دار است (۱۰۰ هزار خط) و تعداد ِ کنارگذاشته‌ها شمرده می‌شود', () => {
  const buf = new LogBuffer(LOG_TAIL_DEFAULT);
  for (let i = 1; i <= 100_000; i += 1) {
    buf.push(`line-${i}`);
    assert.ok(buf.size <= LOG_TAIL_DEFAULT * 2, 'هیچ‌وقت بیشتر از دو برابر ِ سقف نگه نمی‌دارد');
  }
  const snap = buf.snapshot();
  assert.equal(snap.length, LOG_TAIL_DEFAULT);
  assert.equal(snap[0], `line-${100_000 - LOG_TAIL_DEFAULT + 1}`);
  assert.equal(snap.at(-1), 'line-100000');
  assert.equal(buf.olderLines, 100_000 - LOG_TAIL_DEFAULT);
  buf.noteSkipped(1500);
  assert.equal(buf.olderLines, 100_000 - LOG_TAIL_DEFAULT + 1500);
  buf.reset();
  assert.deepEqual([buf.snapshot().length, buf.olderLines], [0, 0]);
});

test('LogBuffer: کوچک‌کردن ِ سقف می‌بُرد؛ بزرگ‌کردن چیزی را برنمی‌گرداند (باید دوباره از سرور خواست)', () => {
  const buf = new LogBuffer(10);
  for (let i = 1; i <= 25; i += 1) buf.push(`l${i}`);
  assert.equal(buf.snapshot().length, 10);
  buf.setLimit(4);
  assert.deepEqual(buf.snapshot(), ['l22', 'l23', 'l24', 'l25']);
  buf.setLimit(LOG_TAIL_MAX);
  assert.equal(buf.snapshot().length, 4);
  assert.equal(LOG_TAIL_MAX, 2000);
});

test('clipText: از ابتدا یا انتها می‌برد و فقط وقتی لازم است clipped می‌گوید', () => {
  const text = Array.from({ length: 10 }, (_, i) => `r${i + 1}`).join('\n');
  assert.deepEqual(clipText(text, 20), { text, clipped: false, totalLines: 10 });
  assert.deepEqual(clipText(text, 3, 'head'), { text: 'r1\nr2\nr3', clipped: true, totalLines: 10 });
  assert.deepEqual(clipText(text, 3, 'tail'), { text: 'r8\nr9\nr10', clipped: true, totalLines: 10 });
});

// --- ساختار ِ کد: timer ِ پراکنده نباشد -----------------------------------------------------------------------------------------------

test('هیچ setInterval ای بیرون از scheduler.ts نیست (همه‌ی polling از زمان‌بند ِ مرکزی)', () => {
  const dir = new URL('../../client/src/app/', import.meta.url);
  const offenders = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/\.(ts|html)$/.test(file) || file === 'scheduler.ts') continue;
    if (/\bsetInterval\s*\(/.test(fs.readFileSync(new URL(file, dir), 'utf8'))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});

test('component ها polling را با PollerService ثبت می‌کنند و با بسته‌شدن می‌برند', () => {
  const app = read('../../client/src/app/app.component.ts');
  assert.match(app, /inject\(PollerService\)/);
  assert.match(app, /poller\.add\(\{ name: 'board'/);
  assert.match(app, /poller\.add\(\{ name: 'drain'/);
  assert.match(app, /poller\.add\(\{ name: 'health'/);
  assert.match(app, /name: 'log-stream'/);
  const maintenance = read('../../client/src/app/maintenance.component.ts');
  assert.match(maintenance, /inject\(PollerService\)/);
  assert.match(maintenance, /ngOnDestroy\(\): void \{[^}]*stopDrainPoll/s);
});

test('فهرست‌های بلند صفحه‌بندی می‌شوند: Timeline و Attempt ها، و لاگ فقط انتها + «نمایش بیشتر»', () => {
  const html = read('../../client/src/app/app.component.html');
  assert.match(html, /\*ngFor="let e of visibleEvents\(\)/);
  assert.match(html, /\*ngFor="let a of visibleAttempts\(t\)/);
  assert.match(html, /showMoreEvents\(\)/);
  assert.match(html, /showMoreLog\(\)/);
  assert.match(html, /showFullArtifact\(/);
  const ts = read('../../client/src/app/app.component.ts');
  assert.match(ts, /streamUrl\(this\.repoId\(\), taskId, this\.logTail\(\)\)/);
  assert.match(ts, /new LogBuffer\(/);
  assert.match(ts, /hiddenEvents|visibleEvents/);
});
