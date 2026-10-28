// «این دکمه الان مجاز است؟» — فقط از بلوک `actions` ِ `status --json` (TOOLING-037).
//
// Manager همان تابعی را می‌پرسد که handlerها پیش از اجرا می‌پرسند، پس false یعنی فرمان واقعاً رد
// می‌شود و true یعنی به‌خاطر state/گیت/قفل رد نمی‌شود. کانبان هیچ نسخه‌ی دومی از این منطق
// ندارد: نه از روی state، نه از blocker، نه از awaitingHuman.
//
// `actions` غایب (Manager قدیمی‌تر از TOOLING-037) = هیچ دکمه‌ای؛ اکشن از «کنسول» انجام می‌شود.
import type { Task } from './models';

export type BooleanAction =
  | 'approve' | 'reject' | 'clarify' | 'note' | 'unblock'
  | 'allowPath' | 'allowSharedKnowledgeFile' | 'cancel' | 'abandon' | 'void' | 'unlock'
  | 'recover' | 'recheck' | 'retryProvision' | 'retryInstall' | 'setRuntime' | 'approveDependencies' | 'rejectDependencies' | 'run' | 'reevaluateReview';

/** اکشن‌های «فهرستی»: آرایه‌ی غیرخالی = مجاز (عنصرها: attempt، منبع یا فیلد سقف). */
export type ListAction = 'closeOrphan' | 'externalAccess' | 'resetExternal' | 'raiseLimit';

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
  return can(task, 'approve') || can(task, 'reject') || can(task, 'clarify') || can(task, 'approveDependencies') || can(task, 'rejectDependencies');
}

/** هر اکشن مجاز (برای تصمیم «پنل اکشن‌ها اصلاً چیزی دارد؟»). */
export function anyAction(task: Pick<Task, 'actions'> | null | undefined): boolean {
  const a = task?.actions;
  if (!a) return false;
  return Object.values(a).some(v => v === true || (Array.isArray(v) && v.length > 0));
}

/**
 * `actions.raiseLimit` (TOOLING-038، `actionsVersion: 2`) آرایه‌ای از نام فیلدهاست و فیلد سدکننده اول می‌آید.
 * دکمه فقط وقتی دیده می‌شود که مقدار **آرایه** باشد و دست‌کم یک عضو داشته باشد: `[]` در JS «مقدار دارد» حساب می‌شود،
 * پس «truthy» نسنج. boolean ِ قدیمی (actionsVersion: 1) هرگز دکمه نمی‌دهد.
 */
export function raiseLimitFields(task: Pick<Task, 'actions'> | null | undefined): string[] {
  return allowed(task, 'raiseLimit');
}

/** `capabilities.status.actionsVersion` ≥ ۲؟ کمتر یا نبودن = Manager قدیمی (raiseLimit بولین/نامعتبر). */
export function supportsRaiseLimitList(actionsVersion: unknown): boolean {
  return typeof actionsVersion === 'number' && Number.isFinite(actionsVersion) && actionsVersion >= 2;
}

/** actionsVersion از `capabilities` ِ Manager (ساختار: capabilities.status.actionsVersion)؛ نبودن = null. */
export function actionsVersionOf(capabilities: Record<string, unknown> | null | undefined): number | null {
  const status = capabilities?.['status'];
  const version = status && typeof status === 'object' ? (status as Record<string, unknown>)['actionsVersion'] : undefined;
  return typeof version === 'number' ? version : null;
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

// --- کدام دکمه‌ها؟ (تابع خالص؛ هم کامپوننت و هم تست از همین می‌خوانند) ------------------------
//
// هر کلید `actions` که true یا آرایه‌ی غیرخالی است دقیقاً **یک** دکمه دارد. جدول زیر تنها جای نگاشت
// کلید ← دکمه است؛ کلیدی که اینجا نباشد (Manager تازه‌تر از کانبان) در unknownActionKeys می‌آید و UI
// آن را صریح گزارش می‌کند، نه اینکه بی‌صدا ناپدید شود.

export type ButtonId =
  | 'unblock' | 'retry-rebase' | 'raise-limit' | 'close-orphan' | 'allow-path' | 'allow-shared-knowledge-file'
  | 'external-access' | 'reset-external' | 'void' | 'unlock' | 'cancel' | 'abandon' | 'recover' | 'recheck' | 'reevaluate-review' | 'retry-provision';

export interface CardButton {
  id: ButtonId;
  action: BooleanAction | ListAction;
  /** برای اکشن‌های آرایه‌ای: attempt یا منبعِ همین دکمه (closeOrphan: یک دکمه به‌ازای هر attempt). */
  target?: string;
}

/** نگاشت کلید actions ← جایی که دکمه‌اش رندر می‌شود. */
// 'runtime' = بخش «مدل‌ها» (setRuntime)؛ `retryInstall` alias ِ retryProvision است و دکمه‌ی جدا ندارد (همان یک دکمه).
// 'run' = دکمه‌ی «اجرا / ادامه» ِ فوتر ِ جزئیات (فقط از actions.run پیروی می‌کند)؛ reevaluateReview دکمه‌ی ops دارد.
export const ACTION_PLACEMENT: Readonly<Record<BooleanAction | ListAction, 'ops' | 'gate' | 'tools' | 'runtime' | 'run'>> = {
  approve: 'gate', reject: 'gate', clarify: 'gate', note: 'tools',
  unblock: 'ops', raiseLimit: 'ops', closeOrphan: 'ops', allowPath: 'ops', allowSharedKnowledgeFile: 'ops',
  externalAccess: 'ops', resetExternal: 'ops', cancel: 'ops', abandon: 'ops', void: 'ops', unlock: 'ops',
  recover: 'ops', recheck: 'ops', retryProvision: 'ops', retryInstall: 'ops', setRuntime: 'runtime', approveDependencies: 'gate', rejectDependencies: 'gate', run: 'run', reevaluateReview: 'ops'
};

/**
 * stage ِ blocker ← یک خط: با «دوباره امتحان کن» (retryProvision = unblock + run، idempotent) در این stage چه چیزی دوباره اجرا می‌شود
 * (جدول ِ TOOLING-045).
 */
export const PROVISION_STAGE_TEXT: Readonly<Record<string, string>> = {
  install: 'npm ci از نو اجرا می‌شود (marker ِ نصب نیست).',
  build: 'buildDependencies ِ صریح + کتابخانه‌های داخلیِ بی‌dist ساخته و Baseline دوباره اجرا می‌شود.',
  'worktree-baseline': 'worktree ِ موجود دوباره استفاده می‌شود: کتابخانه‌های بی‌dist ساخته و verify.build / verify.lint دوباره اجرا می‌شود.'
};

export function provisionStageText(stage: string | null | undefined): string {
  return (stage && PROVISION_STAGE_TEXT[stage]) || 'provisioning (نصب / build / baseline) دوباره اجرا می‌شود.';
}

/** دکمه‌ی «دوباره امتحان کن» (provisioning): retryProvision یا alias ِ retryInstall. */
export function canRetryProvision(task: Pick<Task, 'actions'> | null | undefined): boolean {
  return can(task, 'retryProvision') || can(task, 'retryInstall');
}

export const KNOWN_ACTION_KEYS: readonly string[] = Object.keys(ACTION_PLACEMENT);

const OPS_ORDER: ReadonlyArray<{ key: BooleanAction | ListAction; id: ButtonId }> = [
  { key: 'recheck', id: 'recheck' }, { key: 'reevaluateReview', id: 'reevaluate-review' }, { key: 'recover', id: 'recover' }, { key: 'retryProvision', id: 'retry-provision' },
  { key: 'unblock', id: 'unblock' }, { key: 'raiseLimit', id: 'raise-limit' }, { key: 'closeOrphan', id: 'close-orphan' },
  { key: 'allowPath', id: 'allow-path' }, { key: 'allowSharedKnowledgeFile', id: 'allow-shared-knowledge-file' },
  { key: 'externalAccess', id: 'external-access' }, { key: 'resetExternal', id: 'reset-external' },
  { key: 'void', id: 'void' }, { key: 'unlock', id: 'unlock' }, { key: 'cancel', id: 'cancel' }, { key: 'abandon', id: 'abandon' }
];

/**
 * دکمه‌های بخش «اکشن‌ها»ی کارت، به ترتیب. `rebaseConflict` فقط شکل نمایش `unblock` را عوض می‌کند
 * (کارت rebase-conflict: «دوباره امتحان کن» = unblock + run) و هیچ‌وقت چیزی را مجاز یا ممنوع نمی‌کند.
 */
export function opsButtons(
  task: Pick<Task, 'actions'> | null | undefined,
  opts: { rebaseConflict?: boolean; /** false = Manager قدیمی (actionsVersion < 2): دکمه‌ی raise-limit پنهان. پیش‌فرض true. */ raiseLimitSupported?: boolean } = {}
): CardButton[] {
  const out: CardButton[] = [];
  for (const { key, id } of OPS_ORDER) {
    if (key === 'closeOrphan') {
      for (const attempt of allowed(task, 'closeOrphan')) out.push({ id, action: key, target: attempt });
    } else if (key === 'retryProvision') {
      if (canRetryProvision(task)) out.push({ id, action: key });
    } else if (key === 'raiseLimit') {
      if (opts.raiseLimitSupported !== false && raiseLimitFields(task).length) out.push({ id, action: key });
    } else if (key === 'externalAccess' || key === 'resetExternal') {
      if (allowed(task, key).length) out.push({ id, action: key });
    } else if (can(task, key as BooleanAction)) {
      out.push({ id: key === 'unblock' && opts.rebaseConflict ? 'retry-rebase' : id, action: key });
    }
  }
  return out;
}

/** هر کلید actions که الان «چیزی برای نشان دادن دارد» (true یا آرایه‌ی غیرخالی). */
export function activeActionKeys(task: Pick<Task, 'actions'> | null | undefined): string[] {
  const a = task?.actions as Record<string, unknown> | undefined;
  if (!a) return [];
  return Object.keys(a).filter(k => a[k] === true || (Array.isArray(a[k]) && (a[k] as unknown[]).length > 0));
}

/** کلیدهای فعالی که این کانبان نمی‌شناسد (Manager تازه‌تر) — UI باید گزارششان کند. */
export function unknownActionKeys(task: Pick<Task, 'actions'> | null | undefined): string[] {
  return activeActionKeys(task).filter(k => !KNOWN_ACTION_KEYS.includes(k));
}

/** کدام کلیدهای فعال در کدام بخش (ops/gate/tools) دکمه دارند — برای تست «هیچ کلید فعالی بی‌دکمه نمی‌ماند». */
export function renderedActionKeys(task: Pick<Task, 'actions'> | null | undefined, opts: { rebaseConflict?: boolean; raiseLimitSupported?: boolean } = {}): string[] {
  const ops = opsButtons(task, opts).map(b => b.action as string);
  const others = activeActionKeys(task).filter(k => ['gate', 'tools', 'runtime', 'run'].includes((ACTION_PLACEMENT as Record<string, string>)[k]));
  return [...new Set([...ops, ...others])];
}

/**
 * resume ِ خودکار: بعد از کدام اکشن‌های کارت، کانبان خودش `run` می‌زند (وقتی run.autoResumeAfterAnswer روشن است).
 * فقط سه تصمیم گیت. بقیه (unblock، raiseLimit، allowPath، externalAccess، resetExternal، note، ...) هرگز، چون انسان
 * معمولاً چند تا را پشت‌سرهم می‌زند و بعد خودش اجرا می‌کند. تنها استثنا «دوباره امتحان کن» ِ rebase-conflict است که
 * اسمش و پنجره‌ی تأییدش صریحاً می‌گوید unblock + run.
 */
export const AUTO_RESUME_ACTIONS: readonly string[] = ['approve', 'reject', 'clarify', 'approveDependencies', 'rejectDependencies'];

/**
 * اکشن‌هایی که **خودشان** unblock + run هستند (فرمان ِ ثبت‌شده‌ی Manager): «دوباره امتحان کن» ِ rebase-conflict و ِ provisioning.
 * اسم و پنجره‌ی تأییدشان صریحاً می‌گوید اجرا هم می‌شود.
 */
export const SELF_RESUMING_ACTIONS: readonly string[] = ['retry-rebase', 'retry-provision'];
