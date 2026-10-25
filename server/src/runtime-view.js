// نمای «مدل‌ها»ی یک تسک برای CLI ِ `barsa` (TOOLING-046). همان محاسبه‌ی client/src/app/runtime.ts است، به JS (چون CLI
// نباید به type-stripping ِ node برای فایل‌های client وابسته باشد)؛ تست «runtime-view ≡ runtime.ts» روی همان fixtureها دو
// نسخه را یکی نگه می‌دارد.
//
// قاعده‌ها: ردیف‌ها از کلیدهای `runtime.effective`؛ نقش ِ «جاری» از attempt ِ زنده وگرنه lastAttempt؛ «بعدی» را status نمی‌دهد و
// نشان داده نمی‌شود؛ هیچ نگاشت ِ state ← نقش این‌جا نیست.

const FINISHED = ['integrated', 'cancelled', 'abandoned'];

const SOURCE_LABELS = { default: 'پیش‌فرض', 'task-preset': 'preset', 'task-role': 'تنظیم همین تسک', env: 'env', cli: 'cli' };
export const sourceLabel = source => (source ? (SOURCE_LABELS[source] ?? source) : '—');

export function liveAttempt(task) {
  const last = task?.attempts?.at(-1);
  return last && (last.outcome == null || last.outcome === '') ? last : null;
}

export function currentRole(task) {
  if (!task || FINISHED.includes(task.state)) return null;
  return liveAttempt(task)?.role ?? task.lastAttempt?.role ?? null;
}

const differs = (a, b) => !!a && !!b && (a.provider !== b.provider || (a.requestedModel ?? a.model ?? null) !== (b.requestedModel ?? b.model ?? null) || a.effort !== b.effort);

function touches(item, role) {
  const change = item?.change;
  if (!change) return false;
  return !!change.roles?.[role] || change.preset !== undefined || (change.reset ?? []).some(target => target === role || target === 'all' || target === 'preset');
}

export function pendingFor(runtime, role) {
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

export function runtimeRows(task, optionRoles) {
  const effective = task?.runtime?.effective;
  if (!task || !effective) return [];
  const keys = Object.keys(effective);
  const first = (optionRoles ?? []).filter(role => keys.includes(role));
  const roles = [...first, ...keys.filter(role => !first.includes(role))];
  const current = currentRole(task);
  return roles.map(role => {
    const entry = effective[role];
    const error = entry?.error ? `${entry.error}${entry.code ? ` (${entry.code})` : ''}` : null;
    return {
      role,
      provider: entry?.provider ?? null,
      model: entry?.model ?? entry?.requestedModel ?? null,
      effort: entry?.effort ?? null,
      source: entry?.source ?? null,
      fieldSources: entry?.fieldSources ?? null,
      error,
      isCurrent: current === role,
      pending: error ? null : pendingFor(task.runtime, role)
    };
  });
}

/** ستون «مدل / effort» ِ یک attempt (قدیمی ⇒ «—»). */
export function attemptModelCell(attempt) {
  const rt = attempt?.runtime;
  if (!rt) return { model: '—', effort: '—' };
  const requested = rt.requestedModel ?? rt.model ?? null;
  const actual = (rt.actualModels ?? []).filter(Boolean);
  const actualText = actual.length ? actual.join('، ') : null;
  const model = requested && actualText && !(actual.length === 1 && actual[0] === requested) ? `${requested} ← ${actualText}` : (requested ?? actualText ?? '—');
  const requestedEffort = rt.requestedEffort ?? null;
  const effective = rt.effectiveEffort ?? null;
  const effort = effective && requestedEffort && effective !== requestedEffort ? `${requestedEffort} ← ${effective}` : (effective ?? requestedEffort ?? '—');
  return { model: model === '—' ? '—' : `${rt.provider ? `${rt.provider}:` : ''}${model}`, effort };
}

/** `<role>=<provider>:<model>:<effort>` ← { role, provider, model, effort }؛ قطعه‌ی خالی = پیش‌فرض. */
export function parseRuntimeSpec(text) {
  const match = /^([a-z][a-z-]{0,31})=([A-Za-z0-9._-]{0,64}):([A-Za-z0-9._-]{0,64}):([A-Za-z0-9._-]{0,64})$/.exec(String(text));
  if (!match) return null;
  const [, role, provider, model, effort] = match;
  if (!provider && !model && !effort) return null;
  return { role, provider, model, effort };
}
