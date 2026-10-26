// نمای ِ «سلامت ِ تسک» برای CLI ِ `barsa` و diag (TOOLING-048/049): برچسب ِ فارسی ِ زنده بودن ِ قفل، جدول ِ failedWrites ِ blocker ِ
// `tool-write-failed`، و برچسب ِ runMode ِ attemptهای قدیمی. همان محاسبه‌ی client/src/app/task-health.ts است، به JS (CLI نباید به
// type-stripping برای فایل‌های client وابسته باشد)؛ تست ِ «task-health ≡ task-health.ts» دو نسخه را یکی نگه می‌دارد.
//
// منبع ِ حقیقت ِ مقدارها: Manager (`status --json`، schema ِ مخزن ِ Angular). این‌جا هیچ منطق ِ تصمیم نیست، فقط نمایش.

/** `health.transitionLock.liveness` و `repository.health.managerLock.liveness`. */
export const LIVENESS_LABELS = Object.freeze({
  dead: 'مرده — run ِ بعدی پس می‌گیرد',
  'pid-reused': 'مرده (شماره‌ی فرآیند به برنامه‌ی دیگری رسیده)',
  alive: 'زنده',
  'alive-unverified': 'احتمالاً زنده — سنجیده نشد',
  'other-host': 'روی ماشین دیگر',
  'no-pid': 'بدون شماره‌ی فرآیند'
});

/** برچسب ِ liveness؛ مقدار ِ تازه‌ی ناشناخته (Manager جدیدتر) همان‌طور که هست نشان داده می‌شود؛ نبودن = null. */
export function livenessLabel(liveness) {
  if (typeof liveness !== 'string' || !liveness) return null;
  return LIVENESS_LABELS[liveness] ?? liveness;
}

/**
 * یک خط ِ وضعیت ِ قفل (transitionLock یا managerLock). بدون liveness (Manager ِ قدیمی‌تر از ۰۴۸) از `alive` می‌آید.
 * برای `alive-unverified` دلیل و فرمان ِ بازیابی از پیام ِ خود ِ Manager (`recovery.reason` / `recovery.commands`) می‌آید.
 */
export function lockStatus(lock, recovery = null) {
  if (!lock) return null;
  const label = livenessLabel(lock.liveness) ?? (lock.alive === true ? 'زنده' : lock.alive === false ? 'مرده' : 'نامشخص');
  const detail = lock.liveness === 'alive-unverified' ? unverifiedDetail(recovery) : null;
  return { liveness: lock.liveness ?? null, label, detail };
}

function unverifiedDetail(recovery) {
  if (!recovery) return null;
  const parts = [];
  if (recovery.reason) parts.push(String(recovery.reason));
  const commands = Array.isArray(recovery.commands) ? recovery.commands.filter(Boolean) : [];
  if (commands.length) parts.push(`فرمان‌های بازیابی: ${commands.join('، ')}${recovery.suggested ? ` (پیشنهاد Manager: ${recovery.suggested})` : ''}`);
  return parts.length ? parts.join(' — ') : null;
}

/**
 * blocker ِ `tooling` / `tool-write-failed` (TOOLING-049) ← { role, attempt, detail, legacy, rows[] }، وگرنه null.
 * `failedWrites: null` = رویداد ِ قدیمی (legacy)، ردیفی نیست. مسیر نسبت به ِ ریشه‌ی نقش است (`path`؛ `relPath` اگر Manager داد).
 */
export function failedWrites(blocker) {
  if (!blocker || blocker.kind !== 'tooling' || blocker.stage !== 'tool-write-failed') return null;
  const list = Array.isArray(blocker.failedWrites) ? blocker.failedWrites : null;
  return {
    role: blocker.role ?? null,
    attempt: blocker.attempt ?? null,
    detail: blocker.detail ?? null,
    legacy: list === null,
    rows: (list ?? []).map(w => ({ tool: w?.tool ?? '—', path: w?.relPath ?? w?.path ?? '—', error: w?.error ?? '', kind: w?.kind ?? null }))
  };
}

/** attempt ِ قدیمی ِ relay (فقط این‌ها outerModel دارند)؛ main-agent و بی‌runtime ← null (چیزی اضافه نمی‌شود). */
export function attemptRunMode(attempt) {
  const rt = attempt?.runtime;
  if (!rt || rt.runMode !== 'subagent-relay') return null;
  return { legacy: true, label: 'قدیمی، relay', outerModel: rt.outerModel ?? null };
}

/** جدول ِ failedWrites به خط‌های متن (diag / artifact / task). `totalRows` اگر بیش از ردیف‌های نمایش‌داده بود «و N مورد دیگر». */
export function failedWritesLines(view) {
  if (!view) return [];
  const head = `نوشتن‌های ناموفق ِ ابزار${view.role ? ` (نقش ${view.role}${view.attempt ? `، attempt ${view.attempt}` : ''})` : ''}:`;
  if (view.legacy) return [head, '  (ثبت نشده — رویداد ِ قدیمی؛ failedWrites: null)'];
  if (!view.rows.length) return [head, '  (فهرست خالی)'];
  const out = [head, '  ابزار | مسیر نسبی | خطا'];
  for (const r of view.rows) out.push(`  ${r.tool} | ${r.path} | ${r.error}${r.kind ? ` [${r.kind}]` : ''}`);
  const more = (view.totalRows ?? view.rows.length) - view.rows.length;
  if (more > 0) out.push(`  … و ${more} مورد دیگر`);
  return out;
}

/** «و N مسیر دیگر» وقتی فهرست ِ نمایش‌داده‌شده از کل کمتر است؛ وگرنه null. بریدن ِ بی‌صدا ممنوع. */
export function moreLine(total, shown, what = 'مسیر') {
  return Number.isFinite(total) && total > shown ? `… و ${total - shown} ${what} دیگر` : null;
}
