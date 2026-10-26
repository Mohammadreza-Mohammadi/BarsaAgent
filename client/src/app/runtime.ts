// منطق خالص ِ «مدل و effort ِ هر مرحله» (TOOLING-046): جدول ردیف‌ها، تغییرهای در صف، ستون ِ attemptها، گزینه‌های dialog
// و payload ِ فرم ساخت. بدون Angular تا با `node --test` هم تست شود (فقط import ِ type).
//
// اصل‌ها:
//  - ردیف‌ها از کلیدهای `runtime.effective` (و `runtime --options` ← `roles`) ساخته می‌شوند، نه از فهرست ِ ثابت ِ نقش‌ها.
//  - گزینه‌ها (provider، مدل، effort، preset) **فقط** از `runtime --options --json` می‌آیند.
//  - کانبان نگاشت ِ state به نقش ندارد و نقش را حدس نمی‌زند: نقش ِ «جاری» و «بعدی» از `task.roles` ِ Manager می‌آید (TOOLING-048).
//    `roles` غایب (Manager ِ قدیمی‌تر) ⇒ هیچ برجسته‌سازی، بدون خطا.
//  - اعتبارسنجی ِ معنایی کار ِ Manager است؛ این‌جا فقط جلوگیری از انتخاب ِ آشکارا ناممکن (و reason ِ خالی).
import type {
  Attempt, AttemptRuntime, EffectiveRoleRuntime, QueuedRuntimeChange, RuntimeOptions, RuntimeProviderOption, RuntimeSelection, StructuredFailure, Task
} from './models';

// نسخه‌ی محلی ِ FINISHED_STATES (task-archive.ts): import ِ بدون پسوند در `node --test` حل نمی‌شود؛ تست یکی بودنشان را می‌سنجد.
export const RUNTIME_FINISHED_STATES: readonly string[] = ['integrated', 'cancelled', 'abandoned'];

// --- منبع ---------------------------------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  default: 'پیش‌فرض', 'task-preset': 'preset', 'task-role': 'تنظیم همین تسک', env: 'env', cli: 'cli'
};

export function sourceLabel(source: string | null | undefined): string {
  return source ? (SOURCE_LABELS[source] ?? source) : '—';
}

/** tooltip ِ منبع ِ هر فیلد، فقط وقتی فیلدها منبع ِ متفاوت دارند؛ وگرنه null. */
export function fieldSourcesTitle(entry: Pick<EffectiveRoleRuntime, 'fieldSources'> | null | undefined): string | null {
  const fs = entry?.fieldSources;
  if (!fs) return null;
  const values = [fs.provider, fs.model, fs.effort];
  if (new Set(values).size <= 1) return null;
  return `provider: ${sourceLabel(fs.provider)} · مدل: ${sourceLabel(fs.model)} · effort: ${sourceLabel(fs.effort)}`;
}

// --- نقش‌ها ---------------------------------------------------------------------------------------------------

/** attempt ِ زنده: آخرین attempt که هنوز outcome ندارد. */
export function liveAttempt(task: Pick<Task, 'attempts'> | null | undefined): Attempt | null {
  const last = task?.attempts?.at(-1);
  return last && (last.outcome == null || last.outcome === '') ? last : null;
}

/** نقش ِ «جاری» همان‌طور که Manager در `roles.current` داد (null = ندارد / `roles` غایب). هیچ حدسی روی attempt ِ آخر نیست. */
export function currentRole(task: Pick<Task, 'roles'> | null | undefined): string | null {
  return task?.roles?.current ?? null;
}

/** نقش ِ «بعدی» (`roles.next`)؛ null = پس از گام ِ جاری نقشی نیست (مثلاً بعد از review) یا `roles` غایب. */
export function nextRole(task: Pick<Task, 'roles'> | null | undefined): string | null {
  return task?.roles?.next ?? null;
}

/** ترتیب ِ نقش‌ها: اول ترتیب ِ `runtime --options` ← roles، بعد بقیه‌ی کلیدهای effective به ترتیب ِ خودشان. */
export function roleOrder(effectiveKeys: readonly string[], optionRoles: readonly string[] | null | undefined): string[] {
  const first = (optionRoles ?? []).filter(role => effectiveKeys.includes(role));
  return [...first, ...effectiveKeys.filter(role => !first.includes(role))];
}

export interface PendingRow {
  provider: string | null;
  model: string | null;
  effort: string | null;
  decision: number | null;
  queuedAt: string | null;
  reason: string | null;
}

export interface RuntimeRow {
  role: string;
  provider: string | null;
  model: string | null;
  requestedModel: string | null;
  effort: string | null;
  source: string | null;
  sourceText: string;
  sourceTitle: string | null;
  /** resolve نشد (`{error, code}`). */
  error: string | null;
  isCurrent: boolean;
  /** نقش ِ بعدی (`roles.next`): با نشانه‌ی کم‌رنگ‌تر. */
  isNext: boolean;
  /** تغییر ِ در صف که روی این نقش اثر دارد (آخری برنده است). */
  pending: PendingRow | null;
  /** attempt ِ زنده‌ی همین نقش با runtime ی که با مؤثر ِ امروز فرق دارد (تغییر وسط ِ کار). */
  liveDiffers: AttemptRuntime | null;
}

const differs = (a: EffectiveRoleRuntime | undefined, b: EffectiveRoleRuntime | undefined): boolean =>
  !!a && !!b && (a.provider !== b.provider || (a.requestedModel ?? a.model ?? null) !== (b.requestedModel ?? b.model ?? null) || a.effort !== b.effort);

/** کدام تصمیم ِ در صف روی این نقش اثر دارد؛ آخری برنده است. */
function touches(item: QueuedRuntimeChange, role: string): boolean {
  const change = item.change;
  if (!change) return false;
  return !!change.roles?.[role] || change.preset !== undefined || (change.reset ?? []).some(target => target === role || target === 'all' || target === 'preset');
}

export function pendingFor(runtime: Task['runtime'], role: string): PendingRow | null {
  if (!runtime?.effectiveAfterPending || !runtime.effective) return null;
  const after = runtime.effectiveAfterPending[role];
  if (!differs(runtime.effective[role], after)) return null;
  const queue = runtime.pending ?? [];
  const item = [...queue].reverse().find(entry => touches(entry, role)) ?? queue.at(-1) ?? null;
  return {
    provider: after?.provider ?? null, model: after?.requestedModel ?? after?.model ?? null, effort: after?.effort ?? null,
    decision: item?.decision ?? null, queuedAt: item?.queuedAt ?? null, reason: item?.reason ?? null
  };
}

function liveRuntimeDiffers(live: Attempt | null, role: string, entry: EffectiveRoleRuntime | undefined): AttemptRuntime | null {
  const rt = live?.runtime;
  if (!live || !rt || live.role !== role || !entry || entry.error) return null;
  const modelDiffers = !!rt.requestedModel && !!(entry.requestedModel ?? entry.model) && rt.requestedModel !== (entry.requestedModel ?? entry.model);
  const providerDiffers = !!rt.provider && rt.provider !== entry.provider;
  const effortDiffers = !!rt.requestedEffort && rt.requestedEffort !== entry.effort;
  return modelDiffers || providerDiffers || effortDiffers ? rt : null;
}

/** ردیف‌های بخش «مدل‌ها». \`runtime\` غایب (Manager قدیمی‌تر از ۰۴۶) یا بدون effective ⇒ []. */
export function runtimeRows(task: Task | null | undefined, optionRoles?: readonly string[] | null): RuntimeRow[] {
  const runtime = task?.runtime;
  const effective = runtime?.effective;
  if (!task || !effective) return [];
  const current = currentRole(task);
  const next = nextRole(task);
  const live = liveAttempt(task);
  return roleOrder(Object.keys(effective), optionRoles).map(role => {
    const entry = effective[role];
    const error = entry?.error ? `${entry.error}${entry.code ? ` (${entry.code})` : ''}` : null;
    return {
      role,
      provider: entry?.provider ?? null,
      model: entry?.model ?? entry?.requestedModel ?? null,
      requestedModel: entry?.requestedModel ?? null,
      effort: entry?.effort ?? null,
      source: entry?.source ?? null,
      sourceText: sourceLabel(entry?.source),
      sourceTitle: fieldSourcesTitle(entry),
      error,
      isCurrent: current === role,
      isNext: next === role && next !== current,
      pending: error ? null : pendingFor(runtime, role),
      liveDiffers: liveRuntimeDiffers(live, role, entry)
    };
  });
}

// --- attemptها ------------------------------------------------------------------------------------------------

export interface AttemptModelCell { model: string; effort: string }

/** ستون «مدل / effort»: قدیمی (بدون runtime) ⇒ «—». درخواستی و واقعی اگر فرق داشتند هر دو. */
export function attemptModelCell(attempt: Pick<Attempt, 'runtime'> | null | undefined): AttemptModelCell {
  const rt = attempt?.runtime;
  if (!rt) return { model: '—', effort: '—' };
  const requested = rt.requestedModel ?? rt.model ?? null;
  const actual = (rt.actualModels ?? []).filter(Boolean);
  const actualText = actual.length ? actual.join('، ') : null;
  let model: string;
  if (requested && actualText && !(actual.length === 1 && actual[0] === requested)) model = `${requested} ← ${actualText}`;
  else model = requested ?? actualText ?? '—';
  const provider = rt.provider ? `${rt.provider}:` : '';
  const requestedEffort = rt.requestedEffort ?? null;
  const effective = rt.effectiveEffort ?? null;
  const effort = effective && requestedEffort && effective !== requestedEffort ? `${requestedEffort} ← ${effective}` : (effective ?? requestedEffort ?? '—');
  return { model: model === '—' ? '—' : `${provider}${model}`, effort };
}

// --- رویدادها --------------------------------------------------------------------------------------------------

export interface RuntimeWarning { decision: number | null; error: string; code: string | null; reason: string | null; at: string | null }

/** \`runtime.queued-rejected\`ها: تغییر ِ در صفی که هنگام اعمال نامعتبر شد. */
export function queuedRejections(events: ReadonlyArray<Record<string, unknown>> | null | undefined): RuntimeWarning[] {
  return (events ?? []).filter(e => e['event'] === 'runtime.queued-rejected').map(e => ({
    decision: typeof e['decision'] === 'number' ? e['decision'] : null,
    error: String(e['error'] ?? ''), code: typeof e['code'] === 'string' ? e['code'] : null,
    reason: typeof e['reason'] === 'string' ? e['reason'] : null, at: typeof e['at'] === 'string' ? e['at'] : null
  }));
}

/** برچسب و توضیح ِ رویدادهای runtime در Timeline. null = رویداد ِ runtime نیست. */
export function runtimeEventText(e: Record<string, unknown>): { label: string; details: string } | null {
  if (e['event'] === 'runtime.changed') {
    const applied = e['appliedAtAttempt'];
    const queuedCount = Array.isArray(e['queuedDecisions']) ? e['queuedDecisions'].length : 0;
    const label = applied != null ? `runtime از attempt ِ ${String(applied)} اعمال شد` : 'runtime عوض شد (برای attemptهای بعدی)';
    const parts: string[] = [];
    if (queuedCount) parts.push(`${queuedCount} تغییر ِ در صف`);
    if (typeof e['reason'] === 'string' && e['reason']) parts.push(`دلیل: ${e['reason']}`);
    return { label, details: parts.join(' · ') };
  }
  if (e['event'] === 'runtime.queued-rejected') {
    return { label: '⚠ تغییر ِ runtime ِ در صف رد شد', details: [`تصمیم ${String(e['decision'] ?? '؟')}`, String(e['error'] ?? ''), e['code'] ? `(${String(e['code'])})` : ''].filter(Boolean).join(' · ') };
  }
  return null;
}

// --- dialog ِ تغییر ----------------------------------------------------------------------------------------------

export interface ProviderChoice { id: string; disabled: boolean; reason: string | null }

/** provider ها از options؛ ناآماده/غیرفعال/بدون پشتیبانی از نقش ⇒ غیرفعال با دلیل. */
export function providerChoices(options: RuntimeOptions | null | undefined, role: string): ProviderChoice[] {
  return Object.entries(options?.providers ?? {}).map(([id, p]) => {
    let reason: string | null = null;
    if (!p.enabled) reason = 'در config غیرفعال است';
    else if (!p.roles.includes(role)) reason = `نقش «${role}» را پشتیبانی نمی‌کند`;
    else if (p.ready && p.ready.installed === false) reason = `روی این ماشین نصب نیست${p.ready.detail ? ` (${p.ready.detail})` : ''}`;
    else if (p.ready && p.ready.authenticated === false) reason = `احراز هویت نشده${p.ready.detail ? ` (${p.ready.detail})` : ''}`;
    return { id, disabled: reason !== null, reason };
  });
}

export function modelsFor(options: RuntimeOptions | null | undefined, provider: string): Array<{ id: string; aliases: string[]; efforts: string[] }> {
  return options?.providers?.[provider]?.models ?? [];
}

function findModel(p: RuntimeProviderOption | undefined, model: string | null | undefined) {
  if (!p || !model) return undefined;
  return p.models.find(m => m.id === model || m.aliases.includes(model));
}

/** effortهای مجاز با عوض شدن ِ **مدل** (\`models[].efforts\`)؛ مدل ِ ناشناخته ⇒ effortهای خود ِ provider. */
export function effortsFor(options: RuntimeOptions | null | undefined, provider: string, model: string | null | undefined): string[] {
  const p = options?.providers?.[provider];
  return findModel(p, model)?.efforts ?? p?.efforts ?? [];
}

export interface Selection { provider: string; model: string; effort: string }

/** با عوض شدن ِ provider مدل، و با عوض شدن ِ مدل effort ِ نامجاز به نزدیک‌ترین مقدار ِ مجاز می‌رود. */
export function reconcileSelection(options: RuntimeOptions | null | undefined, sel: Selection): Selection {
  const models = modelsFor(options, sel.provider);
  const model = findModel(options?.providers?.[sel.provider], sel.model)?.id ?? models[0]?.id ?? '';
  const efforts = effortsFor(options, sel.provider, model);
  const effort = efforts.includes(sel.effort) ? sel.effort : (efforts.includes('high') ? 'high' : efforts[0] ?? '');
  return { provider: sel.provider, model, effort };
}

export interface ChangeSpec { provider: string; model: string; effort: string }

/**
 * فقط فیلدهای عوض‌شده نسبت به مؤثر ِ امروز (قطعه‌ی خالی = دست نزن). با عوض شدن ِ provider هر سه فرستاده می‌شود،
 * چون مدل و effort به provider وابسته‌اند. هیچ تغییری ⇒ null.
 */
export function changeSpec(current: Pick<EffectiveRoleRuntime, 'provider' | 'requestedModel' | 'model' | 'effort'> | null | undefined, next: Selection): ChangeSpec | null {
  const currentModel = current?.requestedModel ?? current?.model ?? '';
  const providerChanged = next.provider !== (current?.provider ?? '');
  const modelChanged = next.model !== currentModel;
  const effortChanged = next.effort !== (current?.effort ?? '');
  if (!providerChanged && !modelChanged && !effortChanged) return null;
  return providerChanged
    ? { provider: next.provider, model: next.model, effort: next.effort }
    : { provider: '', model: modelChanged ? next.model : '', effort: effortChanged ? next.effort : '' };
}

export interface SetRuntimeBody { mode: 'set'; role: string; provider: string; model: string; effort: string; reason: string }

/** ورودی ِ dialog ← بدنه‌ی \`POST …/runtime\`، یا پیام ِ خطا (reason خالی رد می‌شود). */
export function buildSetRuntime(
  role: string, current: EffectiveRoleRuntime | null | undefined, next: Selection, reason: string
): { ok: true; body: SetRuntimeBody } | { ok: false; error: string } {
  if (!reason.trim()) return { ok: false, error: 'reason الزامی است (به انگلیسی بنویس).' };
  const spec = changeSpec(current, next);
  if (!spec) return { ok: false, error: 'چیزی عوض نشده است.' };
  return { ok: true, body: { mode: 'set', role, ...spec, reason: reason.trim() } };
}

/** متن ِ توضیح ِ زیر dialog: attempt ِ زنده ⇒ «در صف می‌نشیند». */
export function effectNote(task: Pick<Task, 'attempts'> | null | undefined, running: boolean): string {
  return running || liveAttempt(task)
    ? 'attempt ِ زنده‌ای هست: تغییر در صف می‌نشیند و در شروع ِ attempt ِ بعدی ِ این نقش اعمال می‌شود، نه اجرای در جریان.'
    : 'روی attempt ِ بعدی ِ این نقش اثر دارد، نه اجرای در جریان.';
}

// --- فرم ساخت --------------------------------------------------------------------------------------------------

/** مقدار ِ پایه‌ی هر نقش برای یک preset: پیش‌فرض‌ها + override ِ preset. */
export function presetBaseline(options: RuntimeOptions | null | undefined, preset: string): Record<string, Selection> {
  const out: Record<string, Selection> = {};
  for (const role of options?.roles ?? []) {
    const d = options?.defaults?.[role];
    const o = options?.presets?.[preset]?.roles?.[role] ?? {};
    out[role] = { provider: o.provider ?? d?.provider ?? '', model: o.model ?? d?.model ?? '', effort: o.effort ?? d?.effort ?? '' };
  }
  return out;
}

export interface CreateRuntimeDraft { preset: string; roles: Record<string, RuntimeSelection> }

/**
 * payload ِ ساخت: فقط ردیف‌هایی که انسان عوض کرده (متفاوت با baseline ِ preset)؛ preset ِ \`default\` فرستاده نمی‌شود.
 * هیچ تغییری ⇒ undefined (فیلد runtime اصلاً فرستاده نمی‌شود).
 */
export function createRuntimePayload(options: RuntimeOptions | null | undefined, draft: CreateRuntimeDraft | null | undefined): CreateRuntimeDraft | undefined {
  if (!draft) return undefined;
  const base = presetBaseline(options, draft.preset || 'default');
  const roles: Record<string, RuntimeSelection> = {};
  for (const [role, sel] of Object.entries(draft.roles ?? {})) {
    const b = base[role];
    const s = sel ?? {};
    const changed = !b || (s.provider ?? b.provider) !== b.provider || (s.model ?? b.model) !== b.model || (s.effort ?? b.effort) !== b.effort;
    if (!changed) continue;
    const providerChanged = !b || (s.provider ?? b.provider) !== b.provider;
    roles[role] = providerChanged
      ? { provider: s.provider ?? '', model: s.model ?? '', effort: s.effort ?? '' }
      : { provider: '', model: (s.model ?? b.model) !== b.model ? s.model ?? '' : '', effort: (s.effort ?? b.effort) !== b.effort ? s.effort ?? '' : '' };
  }
  const preset = draft.preset && draft.preset !== 'default' ? draft.preset : '';
  if (!preset && !Object.keys(roles).length) return undefined;
  return { preset: preset || 'default', roles };
}

// --- خطاهای ساخت -----------------------------------------------------------------------------------------------

/** exit 44: «این issue قبلاً تسک #N دارد (state: …)». */
export function duplicateText(failure: StructuredFailure | null | undefined): string | null {
  if (failure?.kind !== 'duplicate') return null;
  return `این issue قبلاً تسک #${failure.taskId ?? '؟'} دارد (state: ${failure.state ?? '—'}).`;
}

/** exit 45: پیام ِ فارسی برای کنار ِ ردیف ِ نقش (یا null اگر مربوط به نقش نبود). */
export function runtimeInvalidText(failure: StructuredFailure | null | undefined): { role: string | null; text: string } | null {
  if (failure?.kind !== 'runtime-invalid') return null;
  const head = failure.explanation ?? failure.code;
  return { role: failure.role, text: `${head}: ${failure.message}` };
}
