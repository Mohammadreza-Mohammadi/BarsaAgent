import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ts from '../../client/src/app/task-health.ts';
import * as view from '../src/task-health-view.js';
import { opsButtons, renderedActionKeys, unknownActionKeys, ACTION_PLACEMENT, KNOWN_ACTION_KEYS } from '../../client/src/app/task-actions.ts';

// منطق ِ «سلامت ِ تسک» (۰۴۸/۰۴۹): دو نسخه (UI: task-health.ts، CLI/diag: task-health-view.js) باید یکی باشند، و برچسب‌ها همان‌هایی که
// brief می‌خواهد. منبع ِ مقدارها schema ِ Manager است.

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const LABELS = {
  dead: 'مرده — run ِ بعدی پس می‌گیرد',
  'pid-reused': 'مرده (شماره‌ی فرآیند به برنامه‌ی دیگری رسیده)',
  alive: 'زنده',
  'alive-unverified': 'احتمالاً زنده — سنجیده نشد',
  'other-host': 'روی ماشین دیگر',
  'no-pid': 'بدون شماره‌ی فرآیند'
};

test('liveness: شش مقدار ِ Manager برچسب ِ فارسی ِ brief را دارند؛ ناشناخته همان‌طور؛ نبودن null', () => {
  for (const [key, label] of Object.entries(LABELS)) {
    assert.equal(ts.livenessLabel(key), label, key);
    assert.equal(view.livenessLabel(key), label, key);
  }
  assert.deepEqual(Object.keys(ts.LIVENESS_LABELS).sort(), Object.keys(LABELS).sort(), 'همه‌ی مقدارهای schema');
  for (const impl of [ts, view]) {
    assert.equal(impl.livenessLabel('some-future-value'), 'some-future-value');
    assert.equal(impl.livenessLabel(null), null);
    assert.equal(impl.livenessLabel(undefined), null);
    assert.equal(impl.livenessLabel(''), null);
  }
});

test('lockStatus: برچسب از liveness، بدون آن از alive (Manager قدیمی)؛ alive-unverified دلیل و فرمان را از پیام ِ Manager می‌آورد', () => {
  const recovery = { suggested: 'unlock', reason: 'pid 4242 هست ولی هویتش سنجیده نشد؛ اگر مطمئنی مرده است: unlock --force', commands: ['unlock', 'run'] };
  const fixtures = [
    [{ pid: 1, alive: false, liveness: 'dead' }, null],
    [{ pid: 1, alive: false, liveness: 'pid-reused' }, null],
    [{ pid: 1, alive: true, liveness: 'alive' }, null],
    [{ pid: 4242, alive: true, liveness: 'alive-unverified' }, recovery],
    [{ pid: 4242, alive: true, liveness: 'alive-unverified' }, null],
    [{ pid: null, alive: null, liveness: 'other-host' }, null],
    [{ pid: null, alive: null, liveness: 'no-pid' }, null],
    [{ pid: 1, alive: true }, null],
    [{ pid: 1, alive: false }, null],
    [{ pid: 1, alive: null }, null]
  ];
  for (const [lock, rec] of fixtures) assert.deepEqual(view.lockStatus(lock, rec), ts.lockStatus(lock, rec), JSON.stringify(lock));
  const unverified = ts.lockStatus({ pid: 4242, alive: true, liveness: 'alive-unverified' }, recovery);
  assert.equal(unverified.label, 'احتمالاً زنده — سنجیده نشد');
  assert.match(unverified.detail, /unlock --force/, 'دلیل ِ Manager عیناً');
  assert.match(unverified.detail, /فرمان‌های بازیابی: unlock، run \(پیشنهاد Manager: unlock\)/);
  assert.equal(ts.lockStatus({ pid: 1, alive: false, liveness: 'dead' }, recovery).detail, null, 'دلیل فقط برای alive-unverified');
  assert.deepEqual([ts.lockStatus({ alive: true }).label, ts.lockStatus({ alive: false }).label, ts.lockStatus({ alive: null }).label], ['زنده', 'مرده', 'نامشخص']);
  assert.equal(ts.lockStatus(null), null);

  assert.equal(ts.lockNeedsForce({ alive: null, liveness: 'no-pid' }), true);
  assert.equal(ts.lockNeedsForce({ alive: true, liveness: 'alive-unverified' }), true);
  assert.equal(ts.lockNeedsForce({ alive: false, liveness: 'dead' }), false);
  assert.equal(ts.lockNeedsForce(null), false);
});

const WRITE_BLOCKER = {
  kind: 'tooling', stage: 'tool-write-failed', role: 'implementer', attempt: '003', detail: 'Write ناموفق بود',
  failedWrites: [
    { tool: 'Write', path: 'src/app/a.ts', error: 'EACCES: permission denied', kind: 'subagent-report-file' },
    { tool: 'Edit', path: 'src/app/b.ts', error: 'old_string پیدا نشد', kind: null }
  ]
};

test('failedWrites: جدول فقط برای tooling/tool-write-failed؛ legacy (null)؛ هر دو نسخه یکی', () => {
  const fixtures = [
    WRITE_BLOCKER,
    { ...WRITE_BLOCKER, failedWrites: null },
    { ...WRITE_BLOCKER, failedWrites: [] },
    { ...WRITE_BLOCKER, failedWrites: [{ tool: 'Write', relPath: 'rel/x.ts', path: '/abs/x.ts', error: 'e' }] },
    { kind: 'environment', stage: 'build' },
    { kind: 'tooling', stage: 'other' },
    null, undefined
  ];
  for (const blocker of fixtures) assert.deepEqual(view.failedWrites(blocker), ts.failedWrites(blocker));
  const full = ts.failedWrites(WRITE_BLOCKER);
  assert.deepEqual(full.rows.map(r => [r.tool, r.path, r.error]), [['Write', 'src/app/a.ts', 'EACCES: permission denied'], ['Edit', 'src/app/b.ts', 'old_string پیدا نشد']]);
  assert.equal(full.rows[0].kind, 'subagent-report-file');
  assert.equal(full.legacy, false);
  assert.deepEqual([full.role, full.attempt], ['implementer', '003']);
  assert.equal(ts.failedWrites({ ...WRITE_BLOCKER, failedWrites: null }).legacy, true);
  assert.equal(ts.failedWrites({ kind: 'tooling', stage: 'tool-write-failed', failedWrites: [{ tool: 'Write', relPath: 'rel/x.ts', path: '/abs/x.ts' }] }).rows[0].path, 'rel/x.ts', 'مسیر نسبی مقدم است');
  assert.equal(ts.failedWrites({ kind: 'environment', stage: 'build' }), null);

  const lines = view.failedWritesLines(view.failedWrites(WRITE_BLOCKER));
  assert.equal(lines[0], 'نوشتن‌های ناموفق ِ ابزار (نقش implementer، attempt 003):');
  assert.equal(lines[1], '  ابزار | مسیر نسبی | خطا');
  assert.equal(lines[2], '  Write | src/app/a.ts | EACCES: permission denied [subagent-report-file]');
  assert.match(view.failedWritesLines(view.failedWrites({ ...WRITE_BLOCKER, failedWrites: null })).join('\n'), /ثبت نشده/);
  assert.deepEqual(view.failedWritesLines(null), []);
  assert.equal(view.moreLine(45, 40), '… و 5 مسیر دیگر');
  assert.equal(view.moreLine(10, 10), null);
});

test('runMode: فقط attempt ِ قدیمی ِ relay برچسب و outerModel دارد؛ main-agent و بی‌runtime چیزی اضافه نمی‌کنند', () => {
  const att = runtime => ({ n: 1, runtime });
  for (const a of [att({ runMode: 'subagent-relay', outerModel: 'claude-opus-5-5' }), att({ runMode: 'subagent-relay' }), att({ runMode: 'main-agent', outerModel: null }), att({ runMode: null }), att(null), null]) {
    assert.deepEqual(view.attemptRunMode(a), ts.attemptRunMode(a));
  }
  assert.deepEqual(ts.attemptRunMode(att({ runMode: 'subagent-relay', outerModel: 'claude-opus-5-5' })), { legacy: true, label: 'قدیمی، relay', outerModel: 'claude-opus-5-5' });
  assert.equal(ts.attemptRunMode(att({ runMode: 'main-agent' })), null);
  assert.equal(ts.attemptRunMode(att(null)), null);
});

test('suggestedRecovery: فقط recheck/unblock دکمه‌ی پیشنهادی دارند', () => {
  const t = suggested => ({ health: { recovery: { suggested, reason: 'x', commands: [] } } });
  assert.equal(ts.suggestedRecovery(t('recheck')), 'recheck');
  assert.equal(ts.suggestedRecovery(t('unblock')), 'unblock');
  assert.equal(ts.suggestedRecovery(t('run')), null);
  assert.equal(ts.suggestedRecovery(t('recover')), null);
  assert.equal(ts.suggestedRecovery({}), null);
});

test('actions.recheck: دکمه‌ی ops (اولین)، کلید ِ شناخته‌شده، و هیچ کلید ِ فعالی بی‌دکمه نمی‌ماند', () => {
  assert.ok(KNOWN_ACTION_KEYS.includes('recheck'));
  assert.equal(ACTION_PLACEMENT.recheck, 'ops');
  const t = { actions: { recheck: true, unblock: true } };
  assert.deepEqual(opsButtons(t).map(b => b.id), ['recheck', 'unblock']);
  assert.deepEqual(opsButtons({ actions: { recheck: false } }).map(b => b.id), []);
  assert.deepEqual(unknownActionKeys(t), []);
  assert.deepEqual(renderedActionKeys(t).sort(), ['recheck', 'unblock']);
});

test('رابط کاربری: دکمه‌ی recheck با توضیح، نتیجه‌ی رویداد، جدول ِ failedWrites، liveness و برجسته‌سازی ِ نقش', () => {
  const ops = read('../../client/src/app/task-ops.component.ts');
  assert.match(ops, /سنجش دوباره \(بدون اجرای agent\)/);
  assert.match(ops, /همان خروجی ِ موجود دوباره سنجیده می‌شود\. budget مصرف نمی‌شود\./);
  assert.match(ops, /recheckTask\(repo, id\)/);
  assert.match(ops, /attempt\.rechecked/);
  assert.match(ops, /accepted: 'پذیرفته شد/);
  assert.match(ops, /<th>ابزار<\/th><th>مسیر نسبی<\/th><th>خطا<\/th>/);
  assert.match(ops, /\[class\.recovery-suggested\]="b\.id === suggested\(\)"/);
  assert.match(ops, /failedWrites: null/);
  const runtime = read('../../client/src/app/task-runtime.component.ts');
  assert.match(runtime, /r\.isNext/);
  assert.match(runtime, /roles\.current از Manager/);
  assert.match(runtime, /فیلد <code>roles<\/code> را نمی‌دهد/);
  const app = read('../../client/src/app/app.component.html');
  assert.match(app, /relay-badge/);
  assert.match(app, /lockInfo\(t\)\?\.label/);
  const api = read('../../client/src/app/api.service.ts');
  assert.match(api, /\/api\/remote\/tasks\/\$\{encodeURIComponent\(id\)\}\/recheck/);
});
