import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reuse, reuseIgnoring, sameData, shouldDeferRender, trackById, trackByKey, trackByPath } from '../../client/src/app/live-update.ts';

// پرش ِ اسکرول ِ جزئیات: به‌روزرسانی ِ زنده نباید جای کاربر را عوض کند. منطق ِ تصمیم (بدون DOM) این‌جا؛ رفتار ِ واقعی ِ DOM
// (MutationObserver، scrollTop، باز/بسته‌ی details، متن ِ در حال تایپ) در مرورگر با Manager ساختگی سنجیده شد (گزارش).

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const BOARD = () => ({
  generatedAt: '2026-11-01T10:00:00Z',
  repo: { id: 'fake' },
  tasks: [
    { id: '7', state: 'implementing', attempts: [{ id: '001', artifacts: ['result.yaml'] }, { id: '002', artifacts: ['result.yaml'] }], actions: { note: true, raiseLimit: [] } },
    { id: '8', state: 'ready', attempts: [], actions: { note: true, raiseLimit: [] } }
  ]
});

test('همان داده دو بار ⇒ همان reference (render ای ساخته نمی‌شود)', () => {
  const first = BOARD();
  const second = reuse(first, BOARD());
  assert.equal(second, first);
  assert.equal(sameData(first, BOARD()), true);
});

test('داده عوض شده ⇒ فقط شاخه‌ی ِ عوض‌شده reference ِ تازه می‌گیرد', () => {
  const first = BOARD();
  const changed = BOARD();
  changed.tasks[0].attempts.push({ id: '003', artifacts: [] });
  const next = reuse(first, changed);
  assert.notEqual(next, first);
  assert.notEqual(next.tasks, first.tasks);
  assert.notEqual(next.tasks[0], first.tasks[0]);
  assert.notEqual(next.tasks[0].attempts, first.tasks[0].attempts);
  // بقیه همان قبلی‌اند: DOM ِ آن‌ها به‌روز یا دوباره ساخته نمی‌شود
  assert.equal(next.tasks[1], first.tasks[1]);
  assert.equal(next.tasks[0].attempts[0], first.tasks[0].attempts[0]);
  assert.equal(next.tasks[0].attempts[1], first.tasks[0].attempts[1]);
  assert.equal(next.tasks[0].actions, first.tasks[0].actions);
  assert.equal(next.repo, first.repo);
});

test('کلید اضافه/کم شده، null، نوع ِ عوض‌شده و آرایه‌ی کوتاه‌تر داده‌ی ِ عوض‌شده حساب می‌شوند', () => {
  assert.equal(sameData({ a: 1 }, { a: 1, b: undefined }), false);
  assert.equal(sameData({ a: 1, b: 2 }, { a: 1 }), false);
  assert.equal(sameData({ a: null }, { a: {} }), false);
  assert.equal(sameData([1, 2, 3], [1, 2]), false);
  assert.equal(sameData([1, 2], [1, 2]), true);
  assert.equal(sameData({ a: [1] }, { a: { 0: 1 } }), false);
  assert.equal(sameData(null, null), true);
  const prev = { list: [{ id: 1 }, { id: 2 }] };
  const next = reuse(prev, { list: [{ id: 1 }] });
  assert.notEqual(next, prev);
  assert.equal(next.list[0], prev.list[0]);
});

test('کلید ِ ناپایدار (generatedAt): فقط آن فرق دارد ⇒ همان board؛ چیز دیگری فرق دارد ⇒ شاخه‌های ِ بی‌تغییر حفظ', () => {
  const first = BOARD();
  const onlyStamp = { ...BOARD(), generatedAt: '2026-11-01T10:00:03Z' };
  assert.equal(reuseIgnoring(first, onlyStamp, ['generatedAt']), first);
  const real = { ...BOARD(), generatedAt: '2026-11-01T10:00:06Z' };
  real.tasks[1].state = 'implementing';
  const next = reuseIgnoring(first, real, ['generatedAt']);
  assert.notEqual(next, first);
  assert.equal(next.generatedAt, '2026-11-01T10:00:06Z');
  assert.equal(next.tasks[0], first.tasks[0]);
  assert.notEqual(next.tasks[1], first.tasks[1]);
  assert.equal(reuseIgnoring(null, first, ['generatedAt']), first);
});

test('trackBy: شناسه/کلید/مسیر؛ با تازه‌شدن ِ داده DOM ِ آیتم همان می‌ماند', () => {
  assert.equal(trackById(0, { id: '7' }), '7');
  assert.equal(trackByKey(3, ['result.yaml', 'x']), 'result.yaml');
  assert.equal(trackByPath(2, { path: 'src/a.ts' }), 'src/a.ts');
  assert.equal(trackByPath(2, {}), '2');
});

test('تعویق ِ render: فیلد ِ متنی/textarea/contenteditable فوکوس دارد یا متن انتخاب شده ⇒ بله؛ دکمه/چک‌باکس/هیچ ⇒ نه', () => {
  const idle = { activeTag: 'BODY', selectionActive: false };
  assert.equal(shouldDeferRender(idle), false);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'TEXTAREA' }), true);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'INPUT', activeType: 'text' }), true);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'INPUT', activeType: 'number' }), true);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'INPUT', activeType: 'checkbox' }), false);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'INPUT', activeType: 'file' }), false);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'BUTTON' }), false);
  assert.equal(shouldDeferRender({ ...idle, activeTag: 'DIV', activeEditable: true }), true);
  assert.equal(shouldDeferRender({ ...idle, selectionActive: true }), true);
});

// --- ساختار ِ قالب (همان علتی که پرش را ساخت) -----------------------------------------------------------------------------

test('قالب: هر *ngFor روی ِ نتیجه‌ی تابع، trackBy دارد (مگر فهرست ِ مقدارهای ِ ساده/signal ِ پایدار)', () => {
  const html = read('../../client/src/app/app.component.html');
  // فهرست‌هایی که آیتم‌شان primitive است یا مستقیم از signal ِ بدون بازسازی می‌آید
  const stable = new Set(['events()', 'repos()', 'issues()', 'createResults()', 'externalAccessChoices(t)']);
  const bad = [];
  for (const [, expr] of html.matchAll(/\*ngFor="([^"]*)"/g)) {
    const source = /\bof\s+([^;]+?)\s*(?:;|$)/.exec(expr)?.[1] ?? '';
    if (!/\)\s*$/.test(source) || stable.has(source) || /trackBy\s*:/.test(expr)) continue;
    bad.push(expr);
  }
  assert.deepEqual(bad, [], '*ngFor روی نتیجه‌ی تابع بدون trackBy: با هر change detection همه‌ی آیتم‌ها دوباره ساخته می‌شوند');
});

test('artifact entries: memoized (computed)، نه آرایه‌ی تازه در هر change detection', () => {
  const ts = read('../../client/src/app/app.component.ts');
  assert.match(ts, /actionArtifactList\s*=\s*computed\(/);
  assert.match(ts, /attemptArtifactList\s*=\s*computed\(/);
  assert.doesNotMatch(ts, /actionArtifactEntries\(\)[^{]*\{\s*return Object\.entries/);
  assert.doesNotMatch(ts, /attemptArtifactEntries\(\)[^{]*\{\s*return Object\.entries/);
});

test('poll: پنل ِ جزئیات هم زنده می‌ماند، و داده‌ی بی‌تغییر/تایپ/انتخاب ِ متن، render نمی‌سازد', () => {
  const ts = read('../../client/src/app/app.component.ts');
  assert.doesNotMatch(ts, /this\.panel\(\) === 'task' \|\| this\.panel\(\) === 'action' \|\| !this\.auth\.user\(\)/);
  assert.match(ts, /reuseIgnoring\(prev, next, \['generatedAt'\]\)/);
  assert.match(ts, /shouldDeferRender\(probeUi\(/);
  assert.match(ts, /drain\.set\(reuse\(/);
  // مقدار ِ board/running/selected فقط وقتی واقعاً عوض شده set می‌شود
  assert.match(ts, /if \(board !== prevBoard\) this\.board\.set\(board\)/);
  assert.match(ts, /if \(nextSelected !== selected\)/);
});
