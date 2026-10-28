import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  runtimeRows, currentRole, nextRole, liveAttempt, pendingFor, attemptModelCell, queuedRejections, runtimeEventText, sourceLabel, fieldSourcesTitle,
  providerChoices, modelsFor, effortsFor, reconcileSelection, changeSpec, buildSetRuntime, effectNote, presetBaseline, createRuntimePayload,
  duplicateText, runtimeInvalidText, roleOrder, RUNTIME_FINISHED_STATES
} from '../../client/src/app/runtime.ts';
import {
  KNOWN_ACTION_KEYS, ACTION_PLACEMENT, opsButtons, unknownActionKeys, activeActionKeys, renderedActionKeys, canRetryProvision, provisionStageText, PROVISION_STAGE_TEXT,
  SELF_RESUMING_ACTIONS, AUTO_RESUME_ACTIONS
} from '../../client/src/app/task-actions.ts';
import { FINISHED_STATES } from '../../client/src/app/task-archive.ts';
import * as view from '../src/runtime-view.js';

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const OPTIONS = JSON.parse(read('./fixtures/runtime-options.json'));
const MANAGER_ACTION_KEYS = JSON.parse(read('./fixtures/manager-action-keys.json'));

// --- fixtureهای status --json (شکل ِ واقعی ِ ۰۴۶) --------------------------------------------------------------------

const eff = (provider, model, effort, source = 'default', fieldSources = { provider: source, model: source, effort: source }) => ({ provider, model, requestedModel: model, effort, source, fieldSources });
const DEFAULTS = {
  intake: eff('claude', 'claude-sonnet-5-5', 'medium'), architect: eff('claude', 'claude-opus-5-5', 'high'),
  implementer: eff('claude', 'claude-sonnet-5-5', 'high'), reviewer: eff('claude', 'claude-opus-5-5', 'high')
};
const rt = (effective, extra = {}) => ({ stored: { preset: null, roles: {} }, effective, summary: null, pending: [], effectiveAfterPending: null, error: null, ...extra });
const attempt = (n, role, outcome, runtime = null) => ({ n, id: String(n).padStart(3, '0'), role, outcome, artifacts: [], runtime });
const task = (patch = {}) => ({ id: '10', state: 'implementing', runtime: rt(DEFAULTS), attempts: [], lastAttempt: null, actions: { setRuntime: true }, ...patch });

// --- الف: جدول ِ runtime -------------------------------------------------------------------------------------------

test('جدول: ردیف‌ها از کلیدهای effective (نه فهرست ِ ثابت)؛ ترتیب از runtime --options ← roles؛ نقش ِ ناشناخته‌ی آینده هم می‌آید', () => {
  const t = task({ runtime: rt({ ...DEFAULTS, analyst: eff('codex', 'gpt-6-sol', 'high') }) });
  assert.deepEqual(runtimeRows(t).map(r => r.role), ['intake', 'architect', 'implementer', 'reviewer', 'analyst']);
  assert.deepEqual(runtimeRows(t, ['reviewer', 'intake']).map(r => r.role), ['reviewer', 'intake', 'architect', 'implementer', 'analyst']);
  assert.deepEqual(roleOrder(['a', 'b'], ['b', 'zzz']), ['b', 'a'], 'نقش ِ options که در effective نیست ردیف نمی‌شود');
  assert.deepEqual(runtimeRows(task({ runtime: undefined })), [], 'Manager قدیمی (بدون بلوک runtime)');
  assert.deepEqual(runtimeRows(task({ runtime: rt(null, { error: 'agent-runtime.yaml خراب' }) })), []);
});

test('منبع: پیش‌فرض، preset، تنظیم ِ همین تسک، env، cli؛ tooltip فقط وقتی فیلدها منبع ِ متفاوت دارند', () => {
  assert.deepEqual(['default', 'task-preset', 'task-role', 'env', 'cli', 'x', null].map(sourceLabel), ['پیش‌فرض', 'preset', 'تنظیم همین تسک', 'env', 'cli', 'x', '—']);
  const t = task({
    runtime: rt({
      intake: eff('claude', 'claude-sonnet-5-5', 'medium', 'default'),
      architect: eff('claude', 'claude-opus-5-5', 'high', 'task-preset'),
      implementer: eff('codex', 'gpt-6-sol', 'xhigh', 'task-role', { provider: 'task-role', model: 'task-role', effort: 'task-preset' }),
      reviewer: eff('claude', 'claude-opus-5-5', 'low', 'env')
    }, { stored: { preset: 'heavy', roles: { implementer: { provider: 'codex', model: 'gpt-6-sol' } } } })
  });
  const rows = runtimeRows(t);
  assert.deepEqual(rows.map(r => r.sourceText), ['پیش‌فرض', 'preset', 'تنظیم همین تسک', 'env']);
  assert.equal(rows[0].sourceTitle, null);
  assert.equal(rows[2].sourceTitle, 'provider: تنظیم همین تسک · مدل: تنظیم همین تسک · effort: preset');
  assert.equal(fieldSourcesTitle(undefined), null);
  assert.equal(rows[2].provider, 'codex');
});

test('ردیف ِ resolve-نشده ({error, code}) خطای همان ردیف است، نه شکستن ِ جدول', () => {
  const t = task({ runtime: rt({ ...DEFAULTS, reviewer: { error: 'مدل ناشناخته', code: 'unknown-model' } }) });
  const row = runtimeRows(t).find(r => r.role === 'reviewer');
  assert.equal(row.error, 'مدل ناشناخته (unknown-model)');
  assert.equal(row.pending, null);
});

// --- نقش ِ جاری ----------------------------------------------------------------------------------------------------------

test('نقش ِ جاری و بعدی: از task.roles ِ Manager (TOOLING-048)، نه حدس روی attempt ِ آخر؛ roles غایب = بدون برجسته‌سازی', () => {
  const t = task({ roles: { current: 'implementer', next: 'reviewer' }, attempts: [attempt(1, 'intake', 'completed'), attempt(2, 'architect', null)], lastAttempt: { n: 1, role: 'intake' } });
  assert.equal(liveAttempt(t).role, 'architect', 'attempt ِ زنده هنوز برای «تغییر وسط ِ کار» استفاده می‌شود');
  assert.equal(currentRole(t), 'implementer', 'نقش ِ جاری از roles.current است، نه از attempt ِ زنده/آخر');
  assert.equal(nextRole(t), 'reviewer');
  const rows = runtimeRows(t);
  assert.deepEqual(rows.filter(r => r.isCurrent).map(r => r.role), ['implementer']);
  assert.deepEqual(rows.filter(r => r.isNext).map(r => r.role), ['reviewer']);

  // Manager: مقدار ِ خالی null است (تسک ِ بسته، یا next پس از review)
  const closing = task({ roles: { current: 'reviewer', next: null } });
  assert.equal(nextRole(closing), null);
  assert.deepEqual(runtimeRows(closing).filter(r => r.isNext), []);
  assert.equal(currentRole(task({ roles: { current: null, next: null }, state: 'integrated' })), null);
  // current == next هرگز دو نشانه روی یک ردیف نمی‌گذارد
  assert.deepEqual(runtimeRows(task({ roles: { current: 'implementer', next: 'implementer' } })).filter(r => r.isNext), []);

  // Manager ِ قدیمی‌تر (بدون roles): هیچ نقشی حدس زده نمی‌شود، بدون خطا
  for (const old of [task({ attempts: [attempt(1, 'architect', null)], lastAttempt: { n: 1, role: 'architect' } }), task({ roles: undefined }), task({ roles: null })]) {
    assert.equal(currentRole(old), null);
    assert.equal(nextRole(old), null);
    assert.equal(runtimeRows(old).filter(r => r.isCurrent || r.isNext).length, 0);
    assert.equal(runtimeRows(old).length, 4, 'بخش «مدل‌ها» بدون برجسته‌سازی نمایش داده می‌شود');
  }
  assert.deepEqual([...RUNTIME_FINISHED_STATES], [...FINISHED_STATES], 'نسخه‌ی محلی با task-archive یکی است');
  const source = read('../../client/src/app/runtime.ts');
  assert.doesNotMatch(source, /ready'\s*:\s*'implementer/);
  assert.doesNotMatch(source, /lastAttempt\??\.role/, 'حدس ِ نقش از lastAttempt حذف شده است');
});

// --- ب۲: در صف ----------------------------------------------------------------------------------------------------------

test('تغییر ِ در صف: «در انتظار اعمال» با مقدار ِ تازه، زمان و reason؛ آخری روی هر نقش برنده است', () => {
  const after = { ...DEFAULTS, implementer: eff('claude', 'claude-opus-5-5', 'xhigh', 'task-role') };
  const t = task({
    runtime: rt(DEFAULTS, {
      pending: [
        { decision: 3, queuedAt: '2026-10-25T08:00:00Z', reason: 'first', state: 'implementing', change: { roles: { implementer: { effort: 'max' } } } },
        { decision: 4, queuedAt: '2026-10-25T09:00:00Z', reason: 'second wins', state: 'implementing', change: { roles: { implementer: { provider: '', model: 'claude-opus-5-5', effort: 'xhigh' } } } },
        { decision: 5, queuedAt: '2026-10-25T09:30:00Z', reason: 'other role', state: 'implementing', change: { roles: { reviewer: { effort: 'high' } } } }
      ],
      effectiveAfterPending: after
    })
  });
  const rows = runtimeRows(t);
  const impl = rows.find(r => r.role === 'implementer');
  assert.deepEqual(impl.pending, { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', decision: 4, queuedAt: '2026-10-25T09:00:00Z', reason: 'second wins' });
  assert.equal(impl.effort, 'high', 'مقدار ِ مؤثر ِ امروز همان می‌ماند');
  assert.equal(rows.find(r => r.role === 'reviewer').pending, null, 'مقدار ِ بعد از صف برابر است ⇒ برچسب ندارد');
  assert.equal(pendingFor(undefined, 'implementer'), null);
  // reset/preset هم نقش را لمس می‌کند
  const resetOnly = task({ runtime: rt(after, { pending: [{ decision: 6, reason: 'reset', change: { reset: ['implementer'] } }], effectiveAfterPending: DEFAULTS }) });
  assert.equal(runtimeRows(resetOnly).find(r => r.role === 'implementer').pending.decision, 6);
});

test('رویداد: runtime.changed با appliedAtAttempt، و runtime.queued-rejected به‌صورت هشدار', () => {
  const changed = runtimeEventText({ event: 'runtime.changed', appliedAtAttempt: '004', queuedDecisions: [3, 4], reason: 'bump' });
  assert.equal(changed.label, 'runtime از attempt ِ 004 اعمال شد');
  assert.match(changed.details, /2 تغییر ِ در صف.*دلیل: bump/);
  assert.equal(runtimeEventText({ event: 'runtime.changed', mode: 'direct', reason: 'x' }).label, 'runtime عوض شد (برای attemptهای بعدی)');
  const rejected = runtimeEventText({ event: 'runtime.queued-rejected', decision: 5, error: 'effort نامجاز', code: 'unknown-effort' });
  assert.match(rejected.label, /^⚠/);
  assert.match(rejected.details, /تصمیم 5.*effort نامجاز.*unknown-effort/);
  assert.equal(runtimeEventText({ event: 'state.changed' }), null);
  assert.deepEqual(queuedRejections([{ event: 'x' }, { event: 'runtime.queued-rejected', decision: 5, error: 'e', code: 'c', reason: 'r', at: 't' }]),
    [{ decision: 5, error: 'e', code: 'c', reason: 'r', at: 't' }]);
  assert.deepEqual(queuedRejections(undefined), []);
});

test('attempt ِ زنده با runtime ِ متفاوت از مؤثر ِ امروز جدا نشان داده می‌شود', () => {
  const live = attempt(2, 'implementer', null, { provider: 'claude', model: 'sonnet', requestedModel: 'claude-sonnet-5-5', requestedEffort: 'medium', effectiveEffort: 'medium' });
  const t = task({ attempts: [live], runtime: rt(DEFAULTS) });
  const row = runtimeRows(t).find(r => r.role === 'implementer');
  assert.equal(row.liveDiffers.requestedEffort, 'medium', 'مؤثر ِ امروز high است ولی attempt ِ زنده با medium شروع شد');
  const same = attempt(2, 'implementer', null, { provider: 'claude', requestedModel: 'claude-sonnet-5-5', requestedEffort: 'high' });
  assert.equal(runtimeRows(task({ attempts: [same] })).find(r => r.role === 'implementer').liveDiffers, null);
  assert.equal(runtimeRows(task({ attempts: [attempt(2, 'implementer', null, null)] })).find(r => r.role === 'implementer').liveDiffers, null, 'attempt ِ قدیمی بدون runtime');
});

// --- فهرست ِ attemptها ------------------------------------------------------------------------------------------------------

test('ستون «مدل / effort»: درخواستی و واقعی (اگر فرق داشت هر دو)؛ attempt ِ قدیمی «—» بدون خطا', () => {
  assert.deepEqual(attemptModelCell(attempt(1, 'intake', 'completed', null)), { model: '—', effort: '—' });
  assert.deepEqual(attemptModelCell({}), { model: '—', effort: '—' });
  assert.deepEqual(attemptModelCell(undefined), { model: '—', effort: '—' });
  assert.deepEqual(attemptModelCell(attempt(2, 'architect', 'completed', { provider: 'claude', model: 'opus', requestedModel: 'claude-opus-5-5', actualModels: ['claude-opus-5-5'], requestedEffort: 'high', effectiveEffort: 'high' })),
    { model: 'claude:claude-opus-5-5', effort: 'high' });
  assert.deepEqual(attemptModelCell(attempt(3, 'implementer', 'completed', { provider: 'claude', requestedModel: 'claude-opus-5-5', actualModels: ['claude-sonnet-5-5'], requestedEffort: 'xhigh', effectiveEffort: 'high' })),
    { model: 'claude:claude-opus-5-5 ← claude-sonnet-5-5', effort: 'xhigh ← high' });
  assert.equal(attemptModelCell({ runtime: { provider: 'codex', model: 'gpt-6-sol', effectiveEffort: 'high' } }).model, 'codex:gpt-6-sol');
});

// --- dialog ------------------------------------------------------------------------------------------------------------------

test('dialog: گزینه‌ها فقط از runtime --options؛ provider ِ ناآماده غیرفعال با دلیل', () => {
  const options = structuredClone(OPTIONS);
  options.providers.codex.ready = { installed: false, authenticated: null, detail: 'codex در PATH نیست' };
  options.providers.claude.ready = { installed: true, authenticated: false, detail: null };
  const choices = providerChoices(options, 'implementer');
  assert.deepEqual(choices.map(c => [c.id, c.disabled]), [['claude', true], ['codex', true]]);
  assert.match(choices[0].reason, /احراز هویت نشده/);
  assert.match(choices[1].reason, /نصب نیست.*codex در PATH نیست/);
  options.providers.codex.ready = { installed: true, authenticated: true };
  options.providers.claude.ready = { installed: true, authenticated: true };
  assert.deepEqual(providerChoices(options, 'implementer').map(c => c.disabled), [false, false]);
  options.providers.codex.enabled = false;
  assert.match(providerChoices(options, 'implementer')[1].reason, /غیرفعال/);
  options.providers.claude.roles = ['intake'];
  assert.match(providerChoices(options, 'reviewer')[0].reason, /نقش «reviewer» را پشتیبانی نمی‌کند/);
  assert.deepEqual(providerChoices(null, 'x'), []);
  // هیچ فهرست ِ سخت‌کدشده‌ای در منطق ِ dialog نیست
  const source = read('../../client/src/app/runtime.ts');
  assert.doesNotMatch(source, /claude-opus|claude-sonnet|gpt-6|'xhigh'|"xhigh"/);
});

test('dialog: مدل‌ها با provider فیلتر می‌شوند و effortها با عوض شدن ِ مدل (models[].efforts)', () => {
  const options = structuredClone(OPTIONS);
  options.providers.claude.models = [
    { id: 'claude-opus-5-5', aliases: ['opus'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-haiku-5-5', aliases: ['haiku'], efforts: ['low', 'medium'] }
  ];
  assert.deepEqual(modelsFor(options, 'claude').map(m => m.id), ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.deepEqual(modelsFor(options, 'codex').map(m => m.id).slice(0, 2), ['gpt-6-sol', 'gpt-6-astra']);
  assert.deepEqual(effortsFor(options, 'claude', 'claude-opus-5-5'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(effortsFor(options, 'claude', 'claude-haiku-5-5'), ['low', 'medium'], 'effort ِ مجاز ِ هر مدل جداست');
  assert.deepEqual(effortsFor(options, 'claude', 'haiku'), ['low', 'medium'], 'alias هم resolve می‌شود');
  assert.deepEqual(effortsFor(options, 'claude', 'unknown-model'), options.providers.claude.efforts, 'مدل ِ ناشناخته ⇒ effort ِ provider');
  // عوض شدن ِ مدل: effort ِ نامجاز به مقدار ِ مجاز می‌رود
  assert.deepEqual(reconcileSelection(options, { provider: 'claude', model: 'claude-haiku-5-5', effort: 'max' }), { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
  assert.deepEqual(reconcileSelection(options, { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' }), { provider: 'claude', model: 'claude-opus-5-5', effort: 'max' });
  // عوض شدن ِ provider: مدل ِ آن provider
  const switched = reconcileSelection(options, { provider: 'codex', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(switched.provider, 'codex');
  assert.equal(switched.model, 'gpt-6-sol');
  assert.ok(effortsFor(options, 'codex', switched.model).includes(switched.effort));
});

test('dialog: reason ِ خالی رد می‌شود؛ بدون تغییر رد؛ فقط فیلدهای عوض‌شده (با عوض شدن ِ provider هر سه)', () => {
  const current = DEFAULTS.implementer;
  assert.deepEqual(buildSetRuntime('implementer', current, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'max' }, '   '), { ok: false, error: 'reason الزامی است (به انگلیسی بنویس).' });
  assert.deepEqual(buildSetRuntime('implementer', current, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, 'x'), { ok: false, error: 'چیزی عوض نشده است.' });
  assert.deepEqual(buildSetRuntime('implementer', current, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'max' }, ' bump '),
    { ok: true, body: { mode: 'set', role: 'implementer', provider: '', model: '', effort: 'max', reason: 'bump' } });
  assert.deepEqual(changeSpec(current, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }), { provider: '', model: 'claude-opus-5-5', effort: '' });
  assert.deepEqual(changeSpec(current, { provider: 'codex', model: 'gpt-6-sol', effort: 'high' }), { provider: 'codex', model: 'gpt-6-sol', effort: 'high' });
  assert.deepEqual(changeSpec(undefined, { provider: 'claude', model: 'm', effort: 'e' }), { provider: 'claude', model: 'm', effort: 'e' });
  assert.match(effectNote(task(), false), /روی attempt ِ بعدی ِ این نقش اثر دارد، نه اجرای در جریان/);
  assert.match(effectNote(task({ attempts: [attempt(2, 'implementer', null)] }), false), /در صف می‌نشیند و در شروع ِ attempt ِ بعدی/);
  assert.match(effectNote(task(), true), /در صف می‌نشیند/);
});

// --- فرم ساخت ---------------------------------------------------------------------------------------------------------------

test('فرم ساخت: فقط ردیف‌های عوض‌شده نسبت به preset فرستاده می‌شوند؛ preset ِ default فرستاده نمی‌شود', () => {
  const base = presetBaseline(OPTIONS, 'default');
  assert.deepEqual(base.implementer, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
  assert.deepEqual(presetBaseline(OPTIONS, 'heavy').implementer, { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(presetBaseline(OPTIONS, 'heavy').intake, base.intake, 'نقش ِ بدون override ِ preset پیش‌فرض می‌ماند');

  assert.equal(createRuntimePayload(OPTIONS, undefined), undefined);
  assert.equal(createRuntimePayload(OPTIONS, { preset: 'default', roles: {} }), undefined, 'هیچ تغییری ⇒ فیلد runtime اصلاً نمی‌رود');
  assert.equal(createRuntimePayload(OPTIONS, { preset: 'default', roles: { implementer: base.implementer } }), undefined, 'ردیف ِ برابر با baseline فرستاده نمی‌شود');

  assert.deepEqual(createRuntimePayload(OPTIONS, { preset: 'heavy', roles: {} }), { preset: 'heavy', roles: {} });
  assert.deepEqual(
    createRuntimePayload(OPTIONS, { preset: 'default', roles: { implementer: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'max' }, reviewer: base.reviewer } }),
    { preset: 'default', roles: { implementer: { provider: '', model: '', effort: 'max' } } }
  );
  // با preset ِ heavy، ردیفی که برابر baseline ِ heavy است نمی‌رود، ولی برابر ِ default هست و فرق دارد ⇒ می‌رود
  const heavy = presetBaseline(OPTIONS, 'heavy');
  assert.deepEqual(createRuntimePayload(OPTIONS, { preset: 'heavy', roles: { implementer: heavy.implementer, intake: { ...heavy.intake, effort: 'high' } } }),
    { preset: 'heavy', roles: { intake: { provider: '', model: '', effort: 'high' } } });
  // عوض شدن ِ provider ⇒ هر سه
  assert.deepEqual(createRuntimePayload(OPTIONS, { preset: 'default', roles: { reviewer: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } } }),
    { preset: 'default', roles: { reviewer: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } } });
});

test('خطای Manager: import ِ تکراری (44) و runtime ِ نامعتبر (45) به فارسی و کنار ِ همان ردیف', () => {
  const dup = { kind: 'duplicate', taskId: '10019', state: 'integrated', externalId: '4201', message: 'x', hint: null };
  assert.equal(duplicateText(dup), 'این issue قبلاً تسک #10019 دارد (state: integrated).');
  assert.equal(duplicateText(undefined), null);
  assert.equal(duplicateText({ kind: 'runtime-invalid', code: 'c', role: null, message: 'm', details: {}, explanation: null }), null);
  const bad = { kind: 'runtime-invalid', code: 'unknown-effort', role: 'implementer', message: 'effort "ultra" برای claude مجاز نیست', details: { role: 'implementer' }, explanation: 'effort برای این مدل مجاز نیست' };
  assert.deepEqual(runtimeInvalidText(bad), { role: 'implementer', text: 'effort برای این مدل مجاز نیست: effort "ultra" برای claude مجاز نیست' });
  assert.deepEqual(runtimeInvalidText({ ...bad, role: null, explanation: null }), { role: null, text: 'unknown-effort: effort "ultra" برای claude مجاز نیست' });
  assert.equal(runtimeInvalidText(dup), null);
});

// --- د: اکشن‌های Manager و جدول ِ نگاشت ---------------------------------------------------------------------------------------

test('همه‌ی اکشن‌های شناخته‌شده‌ی Manager در جدول ِ نگاشت هستند (fixture = taskActions ِ schema)', () => {
  assert.ok(MANAGER_ACTION_KEYS.includes('setRuntime') && MANAGER_ACTION_KEYS.includes('retryProvision'));
  for (const key of MANAGER_ACTION_KEYS) {
    assert.ok(KNOWN_ACTION_KEYS.includes(key), `${key} در ACTION_PLACEMENT نیست`);
    assert.ok(['ops', 'gate', 'tools', 'runtime', 'run'].includes(ACTION_PLACEMENT[key]), key); // 'run' = دکمه‌ی «اجرا / ادامه» (فقط actions.run)
  }
  // هر کلید ِ فعال ِ شناخته‌شده یک رندر دارد (دکمه‌ی ops/gate/tools یا بخش ِ «مدل‌ها»)
  for (const key of MANAGER_ACTION_KEYS) {
    const isList = ['closeOrphan', 'externalAccess', 'resetExternal', 'raiseLimit'].includes(key);
    const t = { actions: { [key]: isList ? ['x'] : true } };
    const rendered = renderedActionKeys(t);
    assert.equal(rendered.length, 1, `${key} رندر نمی‌شود`);
    if (key !== 'retryInstall') assert.deepEqual(rendered, [key]);
    else assert.deepEqual(rendered, ['retryProvision'], 'retryInstall alias است: همان یک دکمه');
  }
});

test('retryProvision / recover: دکمه‌ی ops؛ retryInstall فقط alias (یک دکمه، نه دو)؛ stageها خط ِ توضیح دارند', () => {
  assert.deepEqual(opsButtons({ actions: { retryProvision: true } }).map(b => b.id), ['retry-provision']);
  assert.deepEqual(opsButtons({ actions: { retryInstall: true } }).map(b => b.id), ['retry-provision']);
  assert.deepEqual(opsButtons({ actions: { retryProvision: true, retryInstall: true } }).map(b => b.id), ['retry-provision']);
  assert.deepEqual(opsButtons({ actions: { recover: true, unblock: true } }).map(b => b.id), ['recover', 'unblock']);
  assert.equal(canRetryProvision({ actions: { retryInstall: true } }), true);
  assert.equal(canRetryProvision({ actions: { retryProvision: false, retryInstall: false } }), false);
  for (const stage of ['install', 'build', 'worktree-baseline']) assert.match(provisionStageText(stage), /./);
  assert.match(PROVISION_STAGE_TEXT.install, /npm ci/);
  assert.match(PROVISION_STAGE_TEXT.build, /buildDependencies/);
  assert.match(PROVISION_STAGE_TEXT['worktree-baseline'], /verify\.build/);
  assert.match(provisionStageText(null), /provisioning/);
  assert.ok(SELF_RESUMING_ACTIONS.includes('retry-provision') && !AUTO_RESUME_ACTIONS.includes('retryProvision'));
});

test('اکشن ِ ناشناخته: دکمه‌ی غیرفعال با نام خودش و «در کانبان پشتیبانی نمی‌شود»', () => {
  const t = { actions: { unblock: true, brandNewAction: true, futureList: ['a'], futureOff: false, setRuntime: true } };
  assert.deepEqual(unknownActionKeys(t), ['brandNewAction', 'futureList']);
  assert.deepEqual(activeActionKeys(t).sort(), ['brandNewAction', 'futureList', 'setRuntime', 'unblock']);
  const ops = read('../../client/src/app/task-ops.component.ts');
  assert.match(ops, /@for \(k of unknownKeys\(\); track k\)[\s\S]*<button[^>]*disabled[\s\S]*\{\{ k \}\}[\s\S]*در کانبان پشتیبانی نمی‌شود/);
});

// --- قالب‌ها و کامپوننت‌ها (نگهبان) ---------------------------------------------------------------------------------------------

test('قالب‌ها: بخش «مدل‌ها»، dialog، فرم ساخت و import ِ تکراری وصل‌اند', () => {
  const html = read('../../client/src/app/app.component.html');
  assert.match(html, /<ba-task-runtime[^>]*\[events\]="events\(\)"[^>]*\(changed\)="onRuntimeChanged\(\)"/);
  assert.match(html, /<ba-runtime-picker[^>]*\[options\]="runtimeOptions\(\)"[^>]*\[errors\]="runtimeErrorsFor\(d\)"/);
  assert.match(html, /attemptCell\(a\)\.model[\s\S]*attemptCell\(a\)\.effort/);
  assert.match(html, /ساخت تسک تکراری/);
  assert.match(html, /openTaskById\(dp\.taskId\)/);
  const panel = read('../../client/src/app/task-runtime.component.ts');
  for (const needle of ['تغییر', 'برگشت به پیش‌فرض', 'تغییر preset ِ تسک', 'در انتظار اعمال', 'attempt ِ زنده', 'جاری', 'reason (اجباری)', 'effectNote(', 'actions.setRuntime']) assert.ok(panel.includes(needle), needle);
  assert.match(panel, /api\.runtimeOptions\(this\.repoId\(\)\)/);
  assert.match(panel, /\[disabled\]="c\.disabled"/);
  const ts = read('../../client/src/app/app.component.ts');
  assert.match(ts, /createRuntimePayload\(this\.runtimeOptions\(\), item\.runtime\)/);
  assert.match(ts, /allowDuplicate: \{ reason \}/);
  const api = read('../../client/src/app/api.service.ts');
  assert.match(api, /runtime-options/);
  assert.match(api, /\/runtime`, body\)/);
});

test('تاریخچه: رویدادهای runtime در Timeline برچسب ِ فارسی دارند', () => {
  const ts = read('../../client/src/app/app.component.ts');
  assert.match(ts, /const runtime = runtimeEventText\(e\);\s*if \(runtime\) return runtime\.label;/);
  assert.match(ts, /if \(runtime\) return runtime\.details;/);
});

// --- هم‌ارزی ِ runtime-view.js (CLI) با runtime.ts ِ UI --------------------------------------------------------------------------

test('runtime-view.js (CLI) ≡ runtime.ts (UI) روی همان fixtureها', () => {
  const fixtures = [
    task(),
    task({ roles: { current: 'implementer', next: 'reviewer' } }),
    task({ roles: { current: 'reviewer', next: null }, state: 'review' }),
    task({ attempts: [attempt(1, 'intake', 'completed'), attempt(2, 'implementer', null, { provider: 'claude', requestedModel: 'claude-sonnet-5-5', requestedEffort: 'medium' })] }),
    task({ attempts: [attempt(1, 'architect', 'completed')], lastAttempt: { n: 1, role: 'architect', outcome: 'completed' } }),
    task({ state: 'integrated', lastAttempt: { n: 3, role: 'reviewer' } }),
    task({ runtime: rt({ ...DEFAULTS, reviewer: { error: 'x', code: 'y' } }) }),
    task({
      runtime: rt(DEFAULTS, {
        pending: [{ decision: 4, queuedAt: 't', reason: 'r', change: { roles: { implementer: { effort: 'max' } } } }],
        effectiveAfterPending: { ...DEFAULTS, implementer: eff('claude', 'claude-sonnet-5-5', 'max', 'task-role') }
      })
    })
  ];
  for (const t of fixtures) {
    assert.equal(view.currentRole(t), currentRole(t));
    assert.equal(view.nextRole(t), nextRole(t));
    assert.deepEqual(view.liveAttempt(t)?.n ?? null, liveAttempt(t)?.n ?? null);
    const a = runtimeRows(t, OPTIONS.roles).map(r => ({ role: r.role, provider: r.provider, model: r.model, effort: r.effort, source: r.source, error: r.error, isCurrent: r.isCurrent, isNext: r.isNext, pending: r.pending }));
    const b = view.runtimeRows(t, OPTIONS.roles).map(r => ({ role: r.role, provider: r.provider, model: r.model, effort: r.effort, source: r.source, error: r.error, isCurrent: r.isCurrent, isNext: r.isNext, pending: r.pending }));
    assert.deepEqual(b, a);
  }
  for (const att of [null, attempt(1, 'x', 'c', { provider: 'claude', requestedModel: 'a', actualModels: ['b'], requestedEffort: 'high', effectiveEffort: 'low' }), attempt(1, 'x', 'c', { provider: 'codex', model: 'm', effectiveEffort: 'high' })]) {
    assert.deepEqual(view.attemptModelCell(att), attemptModelCell(att));
  }
  assert.equal(view.sourceLabel('task-role'), sourceLabel('task-role'));
  assert.deepEqual(view.parseRuntimeSpec('implementer=::high'), { role: 'implementer', provider: '', model: '', effort: 'high' });
  assert.equal(view.parseRuntimeSpec('implementer=::'), null);
  assert.equal(view.parseRuntimeSpec('Implementer=a:b:c'), null);
  assert.equal(view.parseRuntimeSpec('implementer=a;b:c:d'), null);
});
