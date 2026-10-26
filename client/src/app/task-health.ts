// منطق ِ خالص ِ «سلامت ِ تسک» (TOOLING-048/049): برچسب ِ فارسی ِ زنده بودن ِ قفل، جدول ِ failedWrites ِ blocker ِ `tool-write-failed`،
// برچسب ِ runMode ِ attemptهای قدیمی، و دکمه‌های بازیابی از `health.recovery`. بدون Angular تا با `node --test` هم تست شود.
// نسخه‌ی JS ِ همین‌ها برای CLI: server/src/task-health-view.js (تست ِ هم‌ارزی دارد).
//
// منبع ِ حقیقت ِ مقدارها: Manager (`status --json`). این‌جا هیچ تصمیمی نیست، فقط نمایش؛ مجاز بودن ِ اکشن‌ها از `actions` می‌آید.
import type { Attempt, Task } from './models';

export const LIVENESS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  dead: 'مرده — run ِ بعدی پس می‌گیرد',
  'pid-reused': 'مرده (شماره‌ی فرآیند به برنامه‌ی دیگری رسیده)',
  alive: 'زنده',
  'alive-unverified': 'احتمالاً زنده — سنجیده نشد',
  'other-host': 'روی ماشین دیگر',
  'no-pid': 'بدون شماره‌ی فرآیند'
});

interface LockLike { alive?: boolean | null; liveness?: string | null }
interface RecoveryLike { reason?: string | null; commands?: readonly string[] | null; suggested?: string | null }

/** برچسب ِ liveness؛ مقدار ِ تازه‌ی ناشناخته همان‌طور که هست؛ نبودن = null. */
export function livenessLabel(liveness: string | null | undefined): string | null {
  if (typeof liveness !== 'string' || !liveness) return null;
  return LIVENESS_LABELS[liveness] ?? liveness;
}

export interface LockStatus { liveness: string | null; label: string; detail: string | null }

/** وضعیت ِ قفل؛ بدون liveness (Manager قدیمی‌تر) از `alive`. برای alive-unverified دلیل و فرمان از پیام ِ Manager. */
export function lockStatus(lock: LockLike | null | undefined, recovery: RecoveryLike | null | undefined = null): LockStatus | null {
  if (!lock) return null;
  const label = livenessLabel(lock.liveness) ?? (lock.alive === true ? 'زنده' : lock.alive === false ? 'مرده' : 'نامشخص');
  const detail = lock.liveness === 'alive-unverified' ? unverifiedDetail(recovery) : null;
  return { liveness: lock.liveness ?? null, label, detail };
}

function unverifiedDetail(recovery: RecoveryLike | null | undefined): string | null {
  if (!recovery) return null;
  const parts: string[] = [];
  if (recovery.reason) parts.push(String(recovery.reason));
  const commands = Array.isArray(recovery.commands) ? recovery.commands.filter(Boolean) : [];
  if (commands.length) parts.push(`فرمان‌های بازیابی: ${commands.join('، ')}${recovery.suggested ? ` (پیشنهاد Manager: ${recovery.suggested})` : ''}`);
  return parts.length ? parts.join(' — ') : null;
}

/** قفل ِ «مطمئن نیستیم»: unlock فقط با --force معنا دارد (alive=null یا alive-unverified). */
export function lockNeedsForce(lock: LockLike | null | undefined): boolean {
  return !!lock && (lock.alive === null || lock.liveness === 'alive-unverified');
}

export interface FailedWriteRow { tool: string; path: string; error: string; kind: string | null }
export interface FailedWritesView { role: string | null; attempt: string | null; detail: string | null; legacy: boolean; rows: FailedWriteRow[] }

/** blocker ِ tooling/tool-write-failed ← جدول؛ وگرنه null. `failedWrites: null` = رویداد ِ قدیمی (legacy). */
export function failedWrites(blocker: Task['blocker'] | null | undefined): FailedWritesView | null {
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

export interface RunModeBadge { legacy: true; label: string; outerModel: string | null }

/** attempt ِ relay (قدیمی) ← برچسب و outerModel؛ main-agent / بی‌runtime ← null. */
export function attemptRunMode(attempt: Pick<Attempt, 'runtime'> | null | undefined): RunModeBadge | null {
  const rt = attempt?.runtime;
  if (!rt || rt.runMode !== 'subagent-relay') return null;
  return { legacy: true, label: 'قدیمی، relay', outerModel: rt.outerModel ?? null };
}

/** پیشنهاد ِ Manager برای بازیابی: فقط recheck/unblock دکمه‌ی خودشان را دارند (بقیه در پنل ِ بازیابی). */
export function suggestedRecovery(task: Pick<Task, 'health'> | null | undefined): 'recheck' | 'unblock' | null {
  const suggested = task?.health?.recovery?.suggested;
  return suggested === 'recheck' || suggested === 'unblock' ? suggested : null;
}
