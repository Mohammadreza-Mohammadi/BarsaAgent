// منطق ِ خالص ِ TOOLING-050 در کانبان: چک‌لیست ِ تست‌های دستی ِ دروازه‌ی merge، پیوست‌ها، دروازه‌ی تأیید ِ وابستگی، و متن ِ رویدادهای تازه.
// بدون Angular تا با `node --test` هم تست شود. نسخه‌ی JS برای CLI: server/src/task-extras-view.js (تست ِ هم‌ارزی دارد).
//
// منبع ِ حقیقت ِ همه‌ی مقدارها: Manager (`status --json`، schema ِ مخزن ِ Angular). این‌جا هیچ تصمیمی نیست؛ مجاز بودن ِ اکشن‌ها از
// `actions` می‌آید و approve ِ merge را هیچ چیزی از این‌جا شرطی نمی‌کند (چک‌لیست یادآور است، نه گیت).
import type { AgentEvent, AttachmentItem, AttachmentPolicy, ManualCase, Task } from './models';

// --- اندازه --------------------------------------------------------------------------------------------------

export function humanSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

// --- الف: چک‌لیست ِ تست‌های دستی -----------------------------------------------------------------------------

export interface ManualChecklist { items: ManualCase[]; problems: string[] }

/** دروازه‌ی merge است؟ (awaitingHuman.kind = merge-approval) */
export function atMergeGate(task: Pick<Task, 'awaitingHuman'> | null | undefined): boolean {
  return task?.awaitingHuman?.kind === 'merge-approval';
}

/** فقط وقتی تسک پشت ِ دروازه‌ی merge است و tests.manualCases خالی نیست؛ وگرنه null. problems جدا (هشدار ِ کوتاه). */
export function manualChecklist(task: Pick<Task, 'awaitingHuman' | 'tests'> | null | undefined): ManualChecklist | null {
  if (!task || !atMergeGate(task)) return null;
  const items = (task.tests?.manualCases ?? []).filter(item => item && typeof item.id === 'string');
  if (!items.length) return null;
  return { items, problems: (task.tests?.problems ?? []).filter(text => typeof text === 'string' && text) };
}

/** هشدار ِ کوتاه برای tests.problems (خالی ← null). متن ِ اول + شمار ِ بقیه. */
export function testsProblemsWarning(task: Pick<Task, 'tests'> | null | undefined): string | null {
  const problems = (task?.tests?.problems ?? []).filter(text => typeof text === 'string' && text);
  if (!problems.length) return null;
  const first = problems[0].length > 140 ? `${problems[0].slice(0, 139)}…` : problems[0];
  return problems.length === 1 ? first : `${first} (و ${problems.length - 1} مورد دیگر)`;
}

/** کلید ِ ماندگار ِ تیک‌ها در مرورگر (فقط یادآوری): هر تسک و هر Case جدا؛ شامل commit تا بعد از تغییر ِ کد دوباره از صفر شروع شود. */
export function checklistStorageKey(repoId: string, task: Pick<Task, 'id' | 'git'>): string {
  return `ba.manual-tests.${repoId}.${task.id}.${task.git?.headCommit ?? 'no-head'}`;
}

// --- ب: پیوست‌ها ---------------------------------------------------------------------------------------------

export interface AttachmentGroup { item: AttachmentItem; frames: AttachmentItem[] }

/** پیوست‌های اصلی؛ فریم‌های استخراج‌شده (derivedFrom) زیر همان ویدیو. فریمی که والدش نیست خودش اصلی نشان داده می‌شود. */
export function attachmentGroups(items: readonly AttachmentItem[] | null | undefined): AttachmentGroup[] {
  const list = items ?? [];
  const ids = new Set(list.map(item => item.id));
  const frames = new Map<string, AttachmentItem[]>();
  for (const item of list) {
    if (item.derivedFrom && ids.has(item.derivedFrom)) frames.set(item.derivedFrom, [...(frames.get(item.derivedFrom) ?? []), item]);
  }
  return list.filter(item => !(item.derivedFrom && ids.has(item.derivedFrom))).map(item => ({ item, frames: frames.get(item.id) ?? [] }));
}

export const ATTACHMENT_KIND_LABELS: Readonly<Record<string, string>> = { image: 'تصویر', pdf: 'PDF', text: 'متن', video: 'ویدیو' };
export const ATTACHMENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  attach: 'افزوده‌شده', 'import-issue': 'همراه issue', 'new-task': 'همراه ساخت', 'answer-note': 'همراه یادداشت', 'answer-clarify': 'همراه پاسخ', derived: 'استخراج‌شده'
};

export function kindLabel(kind: string | null | undefined): string { return (kind && ATTACHMENT_KIND_LABELS[kind]) || kind || '—'; }

/** فقط تصویر پیش‌نمایش دارد؛ بقیه دانلود. */
export function previewable(item: Pick<AttachmentItem, 'kind' | 'exists'>): boolean { return item.kind === 'image' && item.exists === true; }

/** پیش‌سنجی ِ فایل با سیاست ِ **خود ِ Manager** (GET /api/attachments/policy)؛ تصمیم ِ نهایی با Manager. null = ایرادی نیست. */
export function checkFileAgainstPolicy(name: string, size: number, policy: AttachmentPolicy | null): string | null {
  if (size === 0) return 'فایل خالی است.';
  if (!policy) return null;
  if (size > policy.maxUploadBytes) return `اندازه‌ی فایل (${humanSize(size)}) از سقف ِ سرور (${humanSize(policy.maxUploadBytes)}) بیشتر است.`;
  if (!policy.available || !policy.kinds || !policy.forbidden) return null;
  const lowered = String(name).toLowerCase();
  const parts = lowered.split('.').slice(1).map(part => `.${part}`);
  const bad = parts.find(part => policy.forbidden!.includes(part));
  if (bad) return `پسوند ِ ${bad} ممنوع است (فایل ِ اجرایی/اسکریپت/قابل‌اجرا در مرورگر پیوست نمی‌شود).`;
  const ext = parts.length ? parts[parts.length - 1] : '';
  const found = Object.entries(policy.kinds).find(([, rule]) => rule.extensions.includes(ext));
  if (!found) return `پسوند ِ «${ext || 'بدون پسوند'}» مجاز نیست. مجاز: ${Object.values(policy.kinds).flatMap(rule => rule.extensions).join(' ')}`;
  if (size > found[1].maxBytes) return `اندازه‌ی فایل (${humanSize(size)}) از سقف ِ نوع ِ ${kindLabel(found[0])} (${humanSize(found[1].maxBytes)}) بیشتر است.`;
  return null;
}

/** راهنمای کوتاه زیر ِ picker: نوع‌های مجاز و سقف‌ها (از Manager)؛ بدون policy ← فقط سقف ِ سرور. */
export function policyHint(policy: AttachmentPolicy | null): string | null {
  if (!policy) return null;
  if (!policy.available || !policy.kinds) return `سقف ِ هر فایل ${humanSize(policy.maxUploadBytes)}؛ نوع و اندازه‌ی مجاز را Manager می‌سنجد.`;
  return Object.entries(policy.kinds).map(([kind, rule]) => `${kindLabel(kind)}: ${rule.extensions.join(' ')} (تا ${humanSize(rule.maxBytes)})`).join(' · ');
}

// --- ج: دروازه‌ی تأیید ِ وابستگی -----------------------------------------------------------------------------

export type PeerStatus = 'ok' | 'bad' | 'unknown';
export function peerStatus(peer: { satisfied?: boolean | null }): PeerStatus {
  return peer.satisfied === true ? 'ok' : peer.satisfied === false ? 'bad' : 'unknown';
}

export interface DependencyRow {
  name: string; version: string; dev: boolean; reason: string;
  known: boolean; error: string | null; license: string | null; hasInstallScript: boolean | null;
  peers: Array<{ name: string; range: string; installed: string | null; satisfied: boolean | null; optional: boolean; status: PeerStatus }>;
  peersOk: boolean | null;
}
export interface DependencyView { attempt: string; requestedAt: string; peersOk: boolean | null; dependencies: DependencyRow[] }

/** فقط وقتی دروازه باز است (`dependencyApproval` غیر null)؛ وگرنه null. info.known=false ← peers خالی و error همان دلیل. */
export function dependencyView(task: Pick<Task, 'dependencyApproval'> | null | undefined): DependencyView | null {
  const approval = task?.dependencyApproval;
  if (!approval) return null;
  return {
    attempt: approval.attempt, requestedAt: approval.requestedAt, peersOk: approval.peersOk ?? null,
    dependencies: (approval.dependencies ?? []).map(dep => {
      const info = dep.info;
      const known = info?.known === true;
      return {
        name: dep.name, version: dep.version, dev: dep.dev === true, reason: dep.reason,
        known, error: known ? null : (info?.error ?? 'اطلاعات این بسته گرفته نشد'),
        license: info?.license ?? null, hasInstallScript: info?.hasInstallScript ?? null,
        peers: known ? (info.peers ?? []).map(peer => ({ ...peer, status: peerStatus(peer) })) : [],
        peersOk: info?.peersOk ?? null
      };
    })
  };
}

/** peer ِ ناسازگار هست؟ (دکمه‌ی تأیید تأیید ِ دوم می‌خواهد.) `peersOk: false` یا هر peer با satisfied=false. */
export function hasPeerProblem(task: Pick<Task, 'dependencyApproval'> | null | undefined): boolean {
  const view = dependencyView(task);
  if (!view) return false;
  return view.peersOk === false || view.dependencies.some(dep => dep.peersOk === false || dep.peers.some(peer => peer.status === 'bad' && !peer.optional));
}

export function dependencyLabel(dep: { name: string; version: string; dev?: boolean }): string {
  return `${dep.name}@${dep.version}${dep.dev ? ' (dev)' : ''}`;
}

// --- د: رویدادهای تازه ---------------------------------------------------------------------------------------

/** `localEdits` از ۰۵۰ true | false | null است؛ null = «نامعلوم» (نه «بله»). */
export function localEditsText(value: unknown): string {
  return value === true ? 'بله' : value === false ? 'خیر' : 'نامعلوم';
}

const asList = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** برچسب و متن ِ کوتاه ِ فارسی برای رویدادهای ۰۵۰؛ null = رویداد ِ این گروه نیست. */
export function extrasEventText(e: AgentEvent | Record<string, unknown>): { label: string; details: string } | null {
  switch (e['event']) {
    case 'external.changed-by-sync': {
      const sources = asList(e['sources']);
      const parts = sources.map(src => {
        const mutations = asList(src['mutations']);
        const via = mutations.length ? mutations.map(m => `${String(m['kind'] ?? 'sync')}${m['task'] ? ` (تسک ${String(m['task'])})` : ''}`).join('، ') : null;
        const head = `منبع بیرونی «${String(src['id'] ?? '؟')}» در طول attempt ${String(e['attempt'] ?? '؟')}`;
        return src['reason'] === 'recorded-sync' || via
          ? `${head} با sync ِ ${via ?? 'ثبت‌شده'} عوض شد — به حساب agent گذاشته نشد`
          : `${head} عوض شد ولی کار ِ agent نبود (نقش ${String(e['role'] ?? '؟')} دسترسی ِ نوشتن نداشت) — به حساب agent گذاشته نشد`;
      });
      return { label: 'منبع بیرونی با sync عوض شد (به حساب agent نیست)', details: parts.join(' · ') || 'منبع بیرونی در طول attempt با sync عوض شد — به حساب agent گذاشته نشد' };
    }
    case 'external.sync-deferred':
      return { label: 'sync ِ منبع بیرونی به تعویق افتاد', details: clip(`«${String(e['source'] ?? '؟')}»${e['when'] ? ` (${String(e['when'])})` : ''} — ${String(e['note'] ?? e['reason'] ?? 'workspace وسط ِ کار عوض نمی‌شود')}`, 260) };
    case 'attachment.added': {
      const derived = Array.isArray(e['derived']) ? e['derived'].length : 0;
      return {
        label: 'پیوست اضافه شد',
        details: `«${String(e['name'] ?? '؟')}» (${kindLabel(typeof e['kind'] === 'string' ? e['kind'] : null)}، ${humanSize(typeof e['size'] === 'number' ? e['size'] : null)})${e['humanOnly'] === true ? ' · فقط برای انسان' : ''}${derived ? ` · ${derived} فریم ِ استخراج‌شده` : ''}`
      };
    }
    case 'dependency-approval.requested': {
      const deps = asList(e['dependencies']).map(d => dependencyLabel({ name: String(d['name'] ?? '؟'), version: String(d['version'] ?? '؟'), dev: d['dev'] === true }));
      return { label: 'تأیید ِ وابستگی لازم است', details: `${deps.join('، ') || '—'}${e['peersOk'] === false ? ' · ⚠ peer ِ ناسازگار' : ''}` };
    }
    case 'dependency-approval.approved': return { label: 'وابستگی تأیید شد', details: e['reason'] ? clip(String(e['reason']), 200) : '' };
    case 'dependency-approval.rejected': return { label: 'وابستگی رد شد (برگشت به Architect)', details: e['reason'] ? clip(String(e['reason']), 200) : '' };
    case 'dependency.installed': {
      const deps = asList(e['dependencies']).map(d => dependencyLabel({ name: String(d['name'] ?? '؟'), version: String(d['version'] ?? '؟'), dev: d['dev'] === true }));
      return { label: 'وابستگی نصب شد', details: `${deps.join('، ') || '—'}${e['commit'] ? ` · commit ${String(e['commit']).slice(0, 8)}` : ''}` };
    }
    case 'dependency.install-failed': {
      const deps = Array.isArray(e['dependencies']) ? e['dependencies'].map(String) : [];
      return { label: 'نصب ِ وابستگی شکست خورد', details: clip(`${String(e['reason'] ?? 'نامعلوم')}${deps.length ? ` · ${deps.join('، ')}` : ''}`, 260) };
    }

    case 'baseline.lint-debt-in-scope': {
      const files = Array.isArray(e['files']) ? e['files'].length : 0;
      return { label: 'بدهی ِ lint ِ داخل scope به Implementer داده شد', details: `خطاهای lint ِ از قبل موجود در فایل‌های داخل scope به کار ِ Implementer اضافه شد (${String(e['totalErrors'] ?? '؟')} خطا در ${files} فایل)` };
    }
    case 'base.refreshed':
      return { label: 'worktree به base ِ تازه رفت', details: `worktree به base ِ تازه رفت: ${shortSha(e['oldBase'])} → ${shortSha(e['newBase'])}${e['installInputsChanged'] === true ? ' · نصب ِ وابستگی‌ها دوباره انجام می‌شود' : ''}` };
    case 'base.refresh-skipped':
      return { label: 'به‌روزرسانی ِ base انجام نشد', details: clip(`base ِ worktree جلو نرفت: ${String(e['reason'] ?? 'علت ثبت نشده')}`, 240) };
    case 'external.changeset-declared': {
      const list = Array.isArray(e['changesets']) ? e['changesets'].map(c => changesetLabel(String(c))) : [];
      const previous = Array.isArray(e['previous']) ? e['previous'].map(c => changesetLabel(String(c))) : [];
      return { label: 'changeset اعلام شد', details: `«${String(e['source'] ?? '؟')}»: ${list.join('، ') || '—'}${e['replaced'] === true ? ` (جایگزین ِ ${previous.join('، ') || 'قبلی'})` : ''}${e['reason'] ? ` · ${clip(String(e['reason']), 120)}` : ''}` };
    }
    case 'review.needs-clarification':
      return { label: 'Reviewer سؤال دارد (منتظر انسان)', details: clip(`attempt ${String(e['attempt'] ?? '؟')} · budget مصرف نشد · ${String(e['question'] ?? '')}`, 300) };
    case 'review.rejection-loop': {
      const failures = Array.isArray(e['failures']) ? e['failures'].map(String) : [];
      return { label: 'Reviewer دو بار با همان مشکل رد کرد (منتظر انسان)', details: `attempt ${String(e['previousAttempt'] ?? '؟')} و ${String(e['attempt'] ?? '؟')} · ${failures.join('، ') || '—'} · budget مصرف نشد` };
    }
    case 'review.outcome-inconsistent':
      return { label: 'خروجی ِ Reviewer ناسازگار بود', details: clip(`outcome=${String(e['outcome'] ?? '؟')} با requestedTransition=${String(e['requestedTransition'] ?? '؟')} نمی‌خواند؛ دوباره سنجیده می‌شود${Array.isArray(e['problems']) && e['problems'].length ? ` · ${clip(String(e['problems'][0]), 140)}` : ''}`, 260) };
    case 'review.manual-case-by-reviewer': {
      const cases = Array.isArray(e['cases']) ? e['cases'].map(String) : [];
      return { label: 'Reviewer Case را «برای انسان» علامت زد', details: `${cases.join('، ') || '—'} — رد حساب نشد؛ در دروازه‌ی merge انسان می‌سنجد` };
    }
    case 'budget.refunded':
      return { label: 'budget ِ سوخته برگشت', details: `${String(e['field'] ?? 'budget')}: ${String(e['from'] ?? '؟')} → ${String(e['to'] ?? '؟')} (${String(e['amount'] ?? '؟')} برگشت)` };
    case 'review.re-evaluated': {
      const cases = Array.isArray(e['manualCases']) ? e['manualCases'].map(String) : [];
      return { label: 'review بدون اجرای Implementer دوباره سنجیده شد', details: `attempt ${String(e['attempt'] ?? '؟')} · Implementer اجرا نشد${cases.length ? ` · Case ِ دستی: ${cases.join('، ')}` : ''}${e['reason'] ? ` · ${clip(String(e['reason']), 120)}` : ''}` };
    }
    case 'external.snapshot': {
      if (!('localEdits' in e) && !('diskChanged' in e) && !('cause' in e)) return null;
      const parts = [`ویرایش ِ دستی ِ محلی: ${localEditsText(e['localEdits'])}`];
      if ('diskChanged' in e) parts.push(`دیسک عوض شده: ${e['diskChanged'] === true ? 'بله' : e['diskChanged'] === false ? 'خیر' : 'نامعلوم'}`);
      if (e['cause']) parts.push(`علت: ${String(e['cause'])}`);
      return { label: 'snapshot ِ منبع بیرونی', details: parts.join(' · ') };
    }
    default: return null;
  }
}

export interface NeedsHumanInfo { stage: string | null; title: string; text: string; failures: string[] | null; guide: string }
export interface ExternalChangesetRow { id: string; access: string | null; declared: string[]; checkedIn: string[]; canDeclare: boolean; missing: boolean }

// --- TOOLING-051 ------------------------------------------------------------------------------------------------

const shortSha = (value: unknown): string => (typeof value === 'string' && value ? value.slice(0, 8) : '؟');

/** «C17792» از «17792» یا «c17792»؛ مقدار ِ خالی/غیررشته ← ''. */
export function changesetLabel(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^c/i.test(text) ? `C${text.slice(1)}` : `C${text}`;
}

/** تسک ِ Manager ِ قدیمی (بدون actions.run) ← null (رفتار ِ قبلی)؛ وگرنه { allowed, code, reason }. */
export function runInfo(task: Pick<Task, 'actions' | 'runBlocked'> | null | undefined): { allowed: boolean; code: string | null; reason: string | null } | null {
  const actions = task?.actions;
  if (!actions || typeof actions !== 'object' || !('run' in actions)) return null;
  if (actions.run === true) return { allowed: true, code: null, reason: null };
  return { allowed: false, code: task.runBlocked?.code ?? null, reason: task.runBlocked?.reason ?? 'Manager دلیلی برای ِ ممکن‌نبودن ِ اجرا نداد' };
}

/** «اجرا: ممکن» / «اجرا: ممکن نیست — <reason>» / null (Manager قدیمی). */
export function runLine(task: Pick<Task, 'actions' | 'runBlocked'> | null | undefined): string | null {
  const info = runInfo(task);
  if (!info) return null;
  return info.allowed ? 'اجرا: ممکن' : `اجرا: ممکن نیست — ${info.reason}`;
}

/** story ِ SPDD ِ رزروشده (tasks[].spdd). */
export function spddStories(task: Pick<Task, 'spdd'> | null | undefined): Array<{ project: string | null; code: string; number: number | null; slug: string; dir: string | null }> {
  return (Array.isArray(task?.spdd) ? task.spdd : []).filter(s => s && typeof s.code === 'string').map(s => ({ project: s.project ?? null, code: s.code, number: s.number ?? null, slug: s.slug ?? '', dir: s.dir ?? null }));
}
export const spddText = (story: { code: string; slug: string }): string => `story: ${story.code} (${story.slug})`;

/** blocker ِ needs-human: منتظر ِ انسان است، نه خطای فنی. */
export const needsHuman = (task: Pick<Task, 'blocker'> | null | undefined): boolean => task?.blocker?.kind === 'needs-human';

const lastEvent = (events: unknown, name: string): Record<string, unknown> | null => ([...(Array.isArray(events) ? events : [])] as Array<Record<string, unknown>>).reverse().find(e => e && e['event'] === name) ?? null;

/** reviewer-clarification | rejection-loop | عمومی؛ events اختیاری (متن ِ کامل ِ سؤال / مجموعه‌ی شکست‌ها). */
export function needsHumanInfo(task: Pick<Task, 'blocker'> | null | undefined, events: unknown = null): NeedsHumanInfo | null {
  if (!needsHuman(task)) return null;
  const stage = task!.blocker!.stage ?? null;
  const detail = String(task!.blocker!.detail ?? task!.blocker!.reason ?? '');
  if (stage === 'reviewer-clarification') {
    const question = lastEvent(events, 'review.needs-clarification')?.['question'];
    return { stage, title: 'Reviewer سؤال دارد', text: typeof question === 'string' && question ? question : detail, failures: null, guide: 'جواب را به‌صورت یادداشت بنویس (note) و بعد unblock کن؛ Reviewer با یادداشت دوباره می‌سنجد.' };
  }
  if (stage === 'rejection-loop') {
    const failures = lastEvent(events, 'review.rejection-loop')?.['failures'];
    return { stage, title: 'Reviewer دو بار پشت‌سرهم با همان مشکل رد کرد', text: detail, failures: Array.isArray(failures) ? failures.map(String) : null, guide: 'یکی از این‌ها: سنجش دوباره‌ی review (اگر مجاز است)، یادداشت (note)، یا unblock.' };
  }
  return { stage, title: 'نیاز به تصمیم ِ انسان', text: detail, failures: null, guide: 'blocker را بررسی کن؛ بعد note و unblock.' };
}

/** خط‌های CLI برای blocker ِ needs-human. reevaluate: actions.reevaluateReview. */
export function needsHumanLines(info: NeedsHumanInfo | null, id: string, { reevaluate = false }: { reevaluate?: boolean } = {}): string[] {
  if (!info) return [];
  const lines: string[] = [`⏳ ${info.title} (منتظر ِ انسان، نه خطای فنی):`];
  if (info.text) lines.push(`  ${info.text}`);
  if (info.failures?.length) lines.push(`  AC/Case ِ تکراری: ${info.failures.join('، ')}`);
  if (info.stage === 'reviewer-clarification') lines.push(`  جواب: barsa answer ${id} --note --stdin  ← بعد: barsa answer ${id} --unblock --reason "…"`);
  else {
    if (reevaluate) lines.push(`  سنجش دوباره‌ی review (بدون Implementer): barsa reevaluate-review ${id} --reason "…"`);
    lines.push(`  یادداشت: barsa answer ${id} --note --stdin · بازگشایی: barsa answer ${id} --unblock --reason "…"`);
  }
  return lines;
}

/** منبع‌های بیرونی با changeset ِ مؤثر؛ هشدار وقتی integrated و ثبت‌نشده (منبع ِ write). */
export function externalChangesets(task: Pick<Task, 'externalSources' | 'state'> | null | undefined): ExternalChangesetRow[] {
  return (Array.isArray(task?.externalSources) ? task!.externalSources! : []).filter(s => s && !s.error).map(s => {
    const declared = (Array.isArray(s.declaredChangesets) ? s.declaredChangesets : []).map(changesetLabel).filter(Boolean);
    return {
      id: s.id, access: s.access ?? null, declared,
      checkedIn: (Array.isArray(s.checkedIn?.changesets) ? s.checkedIn.changesets : []).map(changesetLabel).filter(Boolean),
      canDeclare: s.actions?.canDeclareChangeset === true,
      missing: task!.state === 'integrated' && declared.length === 0 && s.access !== 'read'
    };
  });
}

/** شماره‌ی changeset ِ ورودی ← 'C1,C2' یا null اگر نامعتبر. فقط ارقام (با C اختیاری)، جداشده با کاما/فاصله. */
export function parseChangesetInput(text: unknown): string | null {
  const parts = String(text ?? '').split(/[\s,،]+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 20 || parts.some(p => !/^c?\d{1,9}$/i.test(p))) return null;
  return [...new Set(parts.map(changesetLabel))].join(',');
}
