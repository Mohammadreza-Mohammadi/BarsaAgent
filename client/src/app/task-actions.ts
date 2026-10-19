// «این دکمه الان مجاز است؟» — فقط از بلوک `actions` ِ `status --json` (TOOLING-037).
//
// Manager همان تابعی را می‌پرسد که handlerها پیش از اجرا می‌پرسند، پس false یعنی فرمان واقعاً رد
// می‌شود و true یعنی به‌خاطر state/گیت/قفل رد نمی‌شود. کانبان هیچ نسخه‌ی دومی از این منطق
// ندارد: نه از روی state، نه از blocker، نه از awaitingHuman.
//
// `actions` غایب (Manager قدیمی‌تر از TOOLING-037) = هیچ دکمه‌ای؛ اکشن از «کنسول» انجام می‌شود.
import type { Task } from './models';

export type BooleanAction =
  | 'approve' | 'reject' | 'clarify' | 'note' | 'unblock' | 'raiseLimit'
  | 'allowPath' | 'allowSharedKnowledgeFile' | 'cancel' | 'abandon' | 'void' | 'unlock';

export type ListAction = 'closeOrphan' | 'externalAccess' | 'resetExternal';

export function can(task: Pick<Task, 'actions'> | null | undefined, action: BooleanAction): boolean {
  return task?.actions?.[action] === true;
}

/** آرایه‌ی منبع‌ها/attemptهای مجاز. غایب یا شکل نامعتبر = []. */
export function allowed(task: Pick<Task, 'actions'> | null | undefined, action: ListAction): string[] {
  const value = task?.actions?.[action];
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

export function hasActions(task: Pick<Task, 'actions'> | null | undefined): boolean {
  return !!task?.actions && typeof task.actions === 'object';
}

/** یکی از سه اکشن گیت انسانی مجاز است؟ (برای دکمه‌ی «اقدام» روی کارت.) */
export function canAnswerGate(task: Pick<Task, 'actions'> | null | undefined): boolean {
  return can(task, 'approve') || can(task, 'reject') || can(task, 'clarify');
}

/** هر اکشن مجاز (برای تصمیم «پنل اکشن‌ها اصلاً چیزی دارد؟»). */
export function anyAction(task: Pick<Task, 'actions'> | null | undefined): boolean {
  const a = task?.actions;
  if (!a) return false;
  return Object.values(a).some(v => v === true || (Array.isArray(v) && v.length > 0));
}

/** فیلدهای --raise-limit که Manager می‌پذیرد (منبع: usage ِ answer در manager.js). */
export const RAISE_LIMIT_FIELDS: readonly string[] = [
  'maxAttempts', 'maxSpecRevisions', 'architectRuns', 'implementerRuns', 'intakeRuns', 'reviewerRuns', 'rebaseRuns'
];

/** فهرست فایل‌های درگیر rebase از blocker.conflictFiles: null = ثبت نشده (رویداد قدیمی)، [] = git فایلی نگفت. */
export function conflictFiles(task: Pick<Task, 'blocker'> | null | undefined): string[] | null {
  const files = task?.blocker?.conflictFiles;
  return Array.isArray(files) ? files.filter((x): x is string => typeof x === 'string') : null;
}
