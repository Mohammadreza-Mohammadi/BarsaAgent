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
