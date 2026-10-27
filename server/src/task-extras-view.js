// نمای ِ TOOLING-050 برای CLI ِ `barsa` و diag: چک‌لیست ِ تست‌های دستی، پیوست‌ها، تأیید ِ وابستگی و متن ِ رویدادهای تازه.
// همان محاسبه‌ی client/src/app/task-extras.ts است، به JS (CLI نباید به type-stripping برای فایل‌های client وابسته باشد)؛ تست ِ
// هم‌ارزی (task-extras.test.js) دو نسخه را روی همان fixtureها یکی نگه می‌دارد. هیچ تصمیمی این‌جا نیست؛ فقط نمایش.

export function humanSize(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export const atMergeGate = task => task?.awaitingHuman?.kind === 'merge-approval';

export function manualChecklist(task) {
  if (!task || !atMergeGate(task)) return null;
  const items = (task.tests?.manualCases ?? []).filter(item => item && typeof item.id === 'string');
  if (!items.length) return null;
  return { items, problems: (task.tests?.problems ?? []).filter(text => typeof text === 'string' && text) };
}

export function testsProblemsWarning(task) {
  const problems = (task?.tests?.problems ?? []).filter(text => typeof text === 'string' && text);
  if (!problems.length) return null;
  const first = problems[0].length > 140 ? `${problems[0].slice(0, 139)}…` : problems[0];
  return problems.length === 1 ? first : `${first} (و ${problems.length - 1} مورد دیگر)`;
}

export function attachmentGroups(items) {
  const list = items ?? [];
  const ids = new Set(list.map(item => item.id));
  const frames = new Map();
  for (const item of list) {
    if (item.derivedFrom && ids.has(item.derivedFrom)) frames.set(item.derivedFrom, [...(frames.get(item.derivedFrom) ?? []), item]);
  }
  return list.filter(item => !(item.derivedFrom && ids.has(item.derivedFrom))).map(item => ({ item, frames: frames.get(item.id) ?? [] }));
}

export const ATTACHMENT_KIND_LABELS = Object.freeze({ image: 'تصویر', pdf: 'PDF', text: 'متن', video: 'ویدیو' });
export const kindLabel = kind => (kind && ATTACHMENT_KIND_LABELS[kind]) || kind || '—';

export const peerStatus = peer => (peer.satisfied === true ? 'ok' : peer.satisfied === false ? 'bad' : 'unknown');

export function dependencyView(task) {
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

export function hasPeerProblem(task) {
  const view = dependencyView(task);
  if (!view) return false;
  return view.peersOk === false || view.dependencies.some(dep => dep.peersOk === false || dep.peers.some(peer => peer.status === 'bad' && !peer.optional));
}

export const dependencyLabel = dep => `${dep.name}@${dep.version}${dep.dev ? ' (dev)' : ''}`;

export const localEditsText = value => (value === true ? 'بله' : value === false ? 'خیر' : 'نامعلوم');

const asList = value => (Array.isArray(value) ? value.filter(x => !!x && typeof x === 'object') : []);
const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

export function extrasEventText(e) {
  switch (e?.event) {
    case 'external.changed-by-sync': {
      const sources = asList(e.sources);
      const parts = sources.map(src => {
        const mutations = asList(src.mutations);
        const via = mutations.length ? mutations.map(m => `${String(m.kind ?? 'sync')}${m.task ? ` (تسک ${String(m.task)})` : ''}`).join('، ') : null;
        const head = `منبع بیرونی «${String(src.id ?? '؟')}» در طول attempt ${String(e.attempt ?? '؟')}`;
        return src.reason === 'recorded-sync' || via
          ? `${head} با sync ِ ${via ?? 'ثبت‌شده'} عوض شد — به حساب agent گذاشته نشد`
          : `${head} عوض شد ولی کار ِ agent نبود (نقش ${String(e.role ?? '؟')} دسترسی ِ نوشتن نداشت) — به حساب agent گذاشته نشد`;
      });
      return { label: 'منبع بیرونی با sync عوض شد (به حساب agent نیست)', details: parts.join(' · ') || 'منبع بیرونی در طول attempt با sync عوض شد — به حساب agent گذاشته نشد' };
    }
    case 'external.sync-deferred':
      return { label: 'sync ِ منبع بیرونی به تعویق افتاد', details: clip(`«${String(e.source ?? '؟')}»${e.when ? ` (${String(e.when)})` : ''} — ${String(e.note ?? e.reason ?? 'workspace وسط ِ کار عوض نمی‌شود')}`, 260) };
    case 'attachment.added': {
      const derived = Array.isArray(e.derived) ? e.derived.length : 0;
      return {
        label: 'پیوست اضافه شد',
        details: `«${String(e.name ?? '؟')}» (${kindLabel(typeof e.kind === 'string' ? e.kind : null)}، ${humanSize(typeof e.size === 'number' ? e.size : null)})${e.humanOnly === true ? ' · فقط برای انسان' : ''}${derived ? ` · ${derived} فریم ِ استخراج‌شده` : ''}`
      };
    }
    case 'dependency-approval.requested': {
      const deps = asList(e.dependencies).map(d => dependencyLabel({ name: String(d.name ?? '؟'), version: String(d.version ?? '؟'), dev: d.dev === true }));
      return { label: 'تأیید ِ وابستگی لازم است', details: `${deps.join('، ') || '—'}${e.peersOk === false ? ' · ⚠ peer ِ ناسازگار' : ''}` };
    }
    case 'dependency-approval.approved': return { label: 'وابستگی تأیید شد', details: e.reason ? clip(String(e.reason), 200) : '' };
    case 'dependency-approval.rejected': return { label: 'وابستگی رد شد (برگشت به Architect)', details: e.reason ? clip(String(e.reason), 200) : '' };
    case 'dependency.installed': {
      const deps = asList(e.dependencies).map(d => dependencyLabel({ name: String(d.name ?? '؟'), version: String(d.version ?? '؟'), dev: d.dev === true }));
      return { label: 'وابستگی نصب شد', details: `${deps.join('، ') || '—'}${e.commit ? ` · commit ${String(e.commit).slice(0, 8)}` : ''}` };
    }
    case 'dependency.install-failed': {
      const deps = Array.isArray(e.dependencies) ? e.dependencies.map(String) : [];
      return { label: 'نصب ِ وابستگی شکست خورد', details: clip(`${String(e.reason ?? 'نامعلوم')}${deps.length ? ` · ${deps.join('، ')}` : ''}`, 260) };
    }
    case 'external.snapshot': {
      if (!('localEdits' in e) && !('diskChanged' in e) && !('cause' in e)) return null;
      const parts = [`ویرایش ِ دستی ِ محلی: ${localEditsText(e.localEdits)}`];
      if ('diskChanged' in e) parts.push(`دیسک عوض شده: ${e.diskChanged === true ? 'بله' : e.diskChanged === false ? 'خیر' : 'نامعلوم'}`);
      if (e.cause) parts.push(`علت: ${String(e.cause)}`);
      return { label: 'snapshot ِ منبع بیرونی', details: parts.join(' · ') };
    }
    default: return null;
  }
}

// --- متن ِ CLI --------------------------------------------------------------------------------------------------

/** فهرست ِ پیوست‌ها (فریم‌های مشتق زیر ویدیوی خودشان). */
export function attachmentLines(attachments) {
  const items = attachments?.items ?? [];
  if (!items.length) return ['پیوستی ندارد.'];
  const lines = [`پیوست‌ها (${items.length}):`];
  const row = (item, indent) => `${indent}${item.id} · ${item.name} · ${kindLabel(item.kind)} · ${humanSize(item.size)} · ${String(item.addedAt ?? '').replace('T', ' ').slice(0, 16) || '—'}${item.humanOnly ? ' · فقط برای انسان' : ''}${item.exists === false ? ' · ⚠ فایل روی دیسک نیست' : ''}`;
  for (const group of attachmentGroups(items)) {
    lines.push(row(group.item, '  '));
    for (const frame of group.frames) lines.push(row(frame, '      ↳ '));
  }
  return lines;
}

/** اطلاعات ِ دروازه‌ی وابستگی (همان چیزی که UI نشان می‌دهد). */
export function dependencyLines(task) {
  const view = dependencyView(task);
  if (!view) return [];
  const lines = [`دروازه‌ی تأیید ِ وابستگی (attempt ${view.attempt}، از ${String(view.requestedAt).replace('T', ' ').slice(0, 16)}):`];
  if (view.peersOk === false) lines.push('⚠ peer ِ ناسازگار: حداقل یک peer با ِ نسخه‌ی نصب‌شده نمی‌خواند (نصب ممکن است ERESOLVE بدهد).');
  for (const dep of view.dependencies) {
    lines.push(`  • ${dependencyLabel(dep)} — ${dep.reason}`);
    if (!dep.known) { lines.push(`      اطلاعات ِ registry نیست: ${dep.error}`); continue; }
    lines.push(`      license: ${dep.license ?? '—'} · hasInstallScript: ${dep.hasInstallScript === true ? 'بله ⚠' : dep.hasInstallScript === false ? 'خیر' : 'نامعلوم'}`);
    if (!dep.peers.length) lines.push('      peerها: ندارد');
    for (const peer of dep.peers) {
      lines.push(`      peer ${peer.name} ${peer.range} · نصب‌شده: ${peer.installed ?? '—'} · ${peer.status === 'ok' ? '✓ می‌خواند' : peer.status === 'bad' ? `✗ نمی‌خواند${peer.optional ? ' (اختیاری)' : ''}` : '؟ سنجیده نشد'}`);
    }
  }
  return lines;
}
