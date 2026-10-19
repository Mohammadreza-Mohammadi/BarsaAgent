import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  can, allowed, hasActions, canAnswerGate, anyAction, conflictFiles, RAISE_LIMIT_FIELDS
} from '../../client/src/app/task-actions.ts';

const ALL_FALSE = {
  approve: false, reject: false, clarify: false, note: false, unblock: false, raiseLimit: false, closeOrphan: [],
  allowPath: false, allowSharedKnowledgeFile: false, externalAccess: [], resetExternal: [], cancel: false, abandon: false, void: false, unlock: false
};

// نمونه‌ی واقعی task 10013 از status --json ِ Manager بعد از TOOLING-037
const BLOCKED_10013 = {
  id: '10013', state: 'blocked', blocker: { kind: 'budget-exhausted', field: 'implementerRuns' },
  actions: { ...ALL_FALSE, note: true, unblock: true, raiseLimit: true, allowPath: true, externalAccess: ['webiii'], resetExternal: ['webiii'], cancel: true, abandon: true, void: true }
};

test('can: فقط true ِ دقیق مجاز است؛ هر چیز دیگر (false، غایب، رشته، عدد) نه', () => {
  assert.equal(can(BLOCKED_10013, 'unblock'), true);
  assert.equal(can(BLOCKED_10013, 'approve'), false);
  assert.equal(can(BLOCKED_10013, 'unlock'), false);
  assert.equal(can({ actions: { approve: 'true' } }, 'approve'), false);
  assert.equal(can({ actions: { approve: 1 } }, 'approve'), false);
  assert.equal(can({ actions: { approve: [] } }, 'approve'), false);
  assert.equal(can({ actions: {} }, 'approve'), false);
  assert.equal(can({}, 'approve'), false);
  assert.equal(can(null, 'approve'), false);
  assert.equal(can(undefined, 'approve'), false);
});

test('هیچ تصمیمی از state/blocker/awaitingHuman نیست: همان state با actions متفاوت → نتیجه‌ی متفاوت', () => {
  const stuck = { ...BLOCKED_10013, actions: { ...ALL_FALSE, unblock: true } };   // قفل زنده: همه false جز unblock/unlock
  const live = { ...BLOCKED_10013, actions: { ...ALL_FALSE } };
  assert.equal(can(stuck, 'unblock'), true);
  assert.equal(can(live, 'unblock'), false, 'state=blocked و blocker دارد ولی Manager اجازه نداده');
  const awaiting = { state: 'new', awaitingHuman: { kind: 'spec-approval' }, actions: { ...ALL_FALSE } };
  assert.equal(canAnswerGate(awaiting), false, 'گیت باز است ولی Manager اجازه نداده → هیچ دکمه‌ای');
  assert.equal(canAnswerGate({ state: 'integrated', actions: { ...ALL_FALSE, approve: true } }), true, 'عکسش هم برقرار است');
});

test('allowed: فهرست منبع/attempt؛ [] یعنی مجاز نیست؛ شکل نامعتبر هم []', () => {
  assert.deepEqual(allowed(BLOCKED_10013, 'externalAccess'), ['webiii']);
  assert.deepEqual(allowed(BLOCKED_10013, 'resetExternal'), ['webiii']);
  assert.deepEqual(allowed(BLOCKED_10013, 'closeOrphan'), []);
  assert.deepEqual(allowed({ actions: { closeOrphan: ['013', '014'] } }, 'closeOrphan'), ['013', '014']);
  assert.deepEqual(allowed({ actions: { externalAccess: 'webiii' } }, 'externalAccess'), []);
  assert.deepEqual(allowed({ actions: { externalAccess: ['a', 3, null] } }, 'externalAccess'), ['a']);
  assert.deepEqual(allowed({}, 'externalAccess'), []);
  assert.deepEqual(allowed(null, 'resetExternal'), []);
});

test('Manager قدیمی (بدون بلاک actions): هیچ دکمه‌ای و hasActions=false', () => {
  const old = { id: '1', state: 'blocked', blocker: { kind: 'rebase-conflict' }, awaitingHuman: { kind: 'merge-approval' } };
  assert.equal(hasActions(old), false);
  assert.equal(anyAction(old), false);
  assert.equal(canAnswerGate(old), false);
  for (const name of ['approve', 'reject', 'clarify', 'note', 'unblock', 'raiseLimit', 'allowPath', 'allowSharedKnowledgeFile', 'cancel', 'abandon', 'void', 'unlock']) {
    assert.equal(can(old, name), false, name);
  }
  assert.equal(hasActions(BLOCKED_10013), true);
});

test('anyAction و canAnswerGate', () => {
  assert.equal(anyAction({ actions: ALL_FALSE }), false);
  assert.equal(anyAction({ actions: { ...ALL_FALSE, closeOrphan: ['013'] } }), true);
  assert.equal(anyAction({ actions: { ...ALL_FALSE, void: true } }), true);
  for (const k of ['approve', 'reject', 'clarify']) assert.equal(canAnswerGate({ actions: { ...ALL_FALSE, [k]: true } }), true, k);
  assert.equal(canAnswerGate({ actions: { ...ALL_FALSE, note: true, unblock: true } }), false);
});

test('conflictFiles: null = ثبت نشده، [] = git فایلی نگفت، آرایه = فایل‌ها', () => {
  assert.equal(conflictFiles({ blocker: { kind: 'rebase-conflict', conflictFiles: null } }), null);
  assert.equal(conflictFiles({ blocker: { kind: 'rebase-conflict' } }), null);
  assert.equal(conflictFiles({ blocker: null }), null);
  assert.deepEqual(conflictFiles({ blocker: { kind: 'rebase-conflict', conflictFiles: [] } }), []);
  assert.deepEqual(conflictFiles({ blocker: { kind: 'rebase-conflict', conflictFiles: ['a.ts', 'b/c.ts'] } }), ['a.ts', 'b/c.ts']);
  assert.deepEqual(conflictFiles({ blocker: { kind: 'rebase-conflict', conflictFiles: ['a.ts', 7] } }), ['a.ts']);
});

test('فیلدهای raise-limit با usage ِ واقعی answer در Manager یکی است', () => {
  const usage = fs.readFileSync(new URL('./fixtures/manager-answer-usage.txt', import.meta.url), 'utf8');
  const m = /field: ([^)]+)\)/.exec(usage);
  assert.ok(m, 'usage باید فهرست field ها را داشته باشد');
  assert.deepEqual([...RAISE_LIMIT_FIELDS].sort(), m[1].split('/').map(s => s.trim()).sort());
});

test('نگهبان: قالب‌ها و task-ops هیچ شرط «مجاز است؟»ی از state/blocker/awaitingHuman ندارند', () => {
  const read = name => fs.readFileSync(new URL(`../../client/src/app/${name}`, import.meta.url), 'utf8');
  const ops = read('task-ops.component.ts');
  const code = ops.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/**')).join('\n');
  assert.doesNotMatch(code, /\.state\b|awaitingHuman|previousState|NOTE_BLOCKED/, 'task-ops فقط از actions می‌خواند');
  // تنها استفاده‌ی مجاز از blocker در task-ops: نمایش کارت rebase-conflict و پیش‌فرض‌های فرم (نه اجازه)
  const blockerUses = code.match(/blocker\??\.[a-zA-Z]+/g) || [];
  for (const use of blockerUses) assert.match(use, /blocker\??\.(kind|base|source|field|maxSpecRevisions|maxAttempts|conflictFiles)/, use);
  const html = read('app.component.html');
  assert.doesNotMatch(html, /noteAllowed|\[disabled\][^>]*taskLocked\(/, 'قالب برد: هیچ disabled ِ وابسته به قفل ِ کانبان');
  const ts = read('app.component.ts');
  assert.doesNotMatch(ts, /NOTE_BLOCKED_STATES|noteAllowed/);
});

// --- «کدام دکمه‌ها رندر می‌شوند؟» (باگ: کارت ۱۰۰۱۳ فقط unblock و abandon نشان می‌داد) -------------

import {
  opsButtons, activeActionKeys, unknownActionKeys, renderedActionKeys, KNOWN_ACTION_KEYS, ACTION_PLACEMENT, AUTO_RESUME_ACTIONS
} from '../../client/src/app/task-actions.ts';

// دقیقاً همان بلوک و blocker ِ گزارش‌شده از status --json --task 10013 ِ واقعی
const REPORTED_10013 = {
  id: '10013', state: 'blocked',
  blocker: { kind: 'budget-exhausted', field: 'implementerRuns', role: 'implementer' },
  actions: JSON.parse('{"approve":false,"reject":false,"clarify":false,"note":true,"unblock":true,"raiseLimit":true,"closeOrphan":[],"allowPath":true,"allowSharedKnowledgeFile":false,"externalAccess":["webiii"],"resetExternal":["webiii"],"cancel":true,"abandon":true,"void":true,"unlock":false}')
};

test('fixture ِ ۱۰۰۱۳ (blocked + budget-exhausted): همه‌ی دکمه‌های مجاز رندر می‌شوند، نه فقط unblock و abandon', () => {
  assert.deepEqual(opsButtons(REPORTED_10013).map(b => b.id),
    ['unblock', 'raise-limit', 'allow-path', 'external-access', 'reset-external', 'void', 'cancel', 'abandon']);
  assert.deepEqual(activeActionKeys(REPORTED_10013).sort(),
    ['abandon', 'allowPath', 'cancel', 'externalAccess', 'note', 'raiseLimit', 'resetExternal', 'unblock', 'void']);
  // note در ردیف ابزار (tools) است، نه ops؛ باز هم برای کلید فعال یک دکمه دارد
  assert.equal(ACTION_PLACEMENT.note, 'tools');
  assert.deepEqual(renderedActionKeys(REPORTED_10013).sort(), activeActionKeys(REPORTED_10013).sort(), 'هیچ کلید فعالی بی‌دکمه نیست');
  // غیرفعال‌ها دکمه ندارند
  const ids = opsButtons(REPORTED_10013).map(b => b.id);
  for (const absent of ['close-orphan', 'allow-shared-knowledge-file', 'unlock', 'retry-rebase']) assert.ok(!ids.includes(absent), absent);
});

test('کارت ۱۰۰۱۳ به blocker/state بستگی ندارد: همان actions با state یا blocker دیگر → همان دکمه‌ها', () => {
  const same = { ...REPORTED_10013, state: 'implementing', blocker: null };
  assert.deepEqual(opsButtons(same).map(b => b.id), opsButtons(REPORTED_10013).map(b => b.id));
  const odd = { ...REPORTED_10013, state: 'something-new', blocker: { kind: 'never-seen-before' } };
  assert.deepEqual(opsButtons(odd).map(b => b.id), opsButtons(REPORTED_10013).map(b => b.id));
});

test('هر کلید به‌تنهایی یک دکمه‌ی دقیقاً یکی در جای خودش می‌دهد؛ فهرست‌ها یکی به‌ازای هر عنصر یا یکی برای منبع‌ها', () => {
  for (const key of KNOWN_ACTION_KEYS) {
    const isList = ['closeOrphan', 'externalAccess', 'resetExternal'].includes(key);
    const task = { actions: { [key]: isList ? ['x1'] : true } };
    assert.deepEqual(activeActionKeys(task), [key], key);
    assert.deepEqual(renderedActionKeys(task), [key], `${key} باید رندر شود`);
    const ops = opsButtons(task);
    assert.equal(ops.length, ACTION_PLACEMENT[key] === 'ops' ? 1 : 0, key);
  }
  // closeOrphan: یک دکمه به‌ازای هر attempt
  const orphans = opsButtons({ actions: { closeOrphan: ['013', '014'] } });
  assert.deepEqual(orphans.map(b => [b.id, b.target]), [['close-orphan', '013'], ['close-orphan', '014']]);
  // آرایه‌ی خالی/false = بدون دکمه
  assert.deepEqual(opsButtons({ actions: { closeOrphan: [], externalAccess: [], resetExternal: [], void: false } }), []);
});

test('rebase-conflict: unblock به «دوباره امتحان کن» تبدیل می‌شود، بدون اینکه چیزی مجاز/ممنوع شود', () => {
  const task = { actions: { unblock: true, abandon: true } };
  assert.deepEqual(opsButtons(task, { rebaseConflict: true }).map(b => b.id), ['retry-rebase', 'abandon']);
  assert.deepEqual(opsButtons({ actions: { abandon: true } }, { rebaseConflict: true }).map(b => b.id), ['abandon'], 'unblock مجاز نیست → دوباره امتحان هم نیست');
});

test('کلید فعال ناشناخته (Manager تازه‌تر) بی‌صدا گم نمی‌شود: در unknownActionKeys می‌آید', () => {
  const task = { actions: { ...ALL_FALSE, unblock: true, futureAction: true, futureList: ['a'] } };
  assert.deepEqual(unknownActionKeys(task).sort(), ['futureAction', 'futureList']);
  assert.deepEqual(unknownActionKeys(REPORTED_10013), []);
  assert.deepEqual(unknownActionKeys({ actions: { ...ALL_FALSE, futureOff: false } }), [], 'ناشناخته‌ی غیرفعال مهم نیست');
});

test('نگهبان قالب: دکمه‌های کارت از opsButtons می‌آیند و note/gate از can(...)', () => {
  const read = name => fs.readFileSync(new URL(`../../client/src/app/${name}`, import.meta.url), 'utf8');
  const ops = read('task-ops.component.ts');
  assert.match(ops, /opsButtons\(this\.task\(\)/);
  assert.match(ops, /@for \(b of buttons\(\)/);
  assert.doesNotMatch(ops, /@if \(can\('(unblock|raiseLimit|allowPath|void|cancel|abandon|unlock)'\)\)/, 'دکمه‌ها دستی با can نیستند');
  const html = read('app.component.html');
  assert.match(html, /\*ngIf="can\(t, 'note'\)"/);
  for (const k of ['approve', 'reject', 'clarify']) assert.match(html, new RegExp(`can\\(t, '${k}'\\)`), k);
});

test('resume ِ خودکار فقط برای approve/reject/clarify (سیاست مستند)', () => {
  assert.deepEqual([...AUTO_RESUME_ACTIONS], ['approve', 'reject', 'clarify']);
});
