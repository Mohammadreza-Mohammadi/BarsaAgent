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

    case 'baseline.lint-debt-in-scope': {
      const files = Array.isArray(e.files) ? e.files.length : 0;
      return { label: 'بدهی ِ lint ِ داخل scope به Implementer داده شد', details: `خطاهای lint ِ از قبل موجود در فایل‌های داخل scope به کار ِ Implementer اضافه شد (${String(e.totalErrors ?? '؟')} خطا در ${files} فایل)` };
    }
    case 'base.refreshed':
      return { label: 'worktree به base ِ تازه رفت', details: `worktree به base ِ تازه رفت: ${shortSha(e.oldBase)} → ${shortSha(e.newBase)}${e.installInputsChanged === true ? ' · نصب ِ وابستگی‌ها دوباره انجام می‌شود' : ''}` };
    case 'base.refresh-skipped':
      return { label: 'به‌روزرسانی ِ base انجام نشد', details: clip(`base ِ worktree جلو نرفت: ${String(e.reason ?? 'علت ثبت نشده')}`, 240) };
    case 'external.changeset-declared': {
      const list = Array.isArray(e.changesets) ? e.changesets.map(c => changesetLabel(String(c))) : [];
      const previous = Array.isArray(e.previous) ? e.previous.map(c => changesetLabel(String(c))) : [];
      return { label: 'changeset اعلام شد', details: `«${String(e.source ?? '؟')}»: ${list.join('، ') || '—'}${e.replaced === true ? ` (جایگزین ِ ${previous.join('، ') || 'قبلی'})` : ''}${e.reason ? ` · ${clip(String(e.reason), 120)}` : ''}` };
    }
    case 'review.needs-clarification':
      return { label: 'Reviewer سؤال دارد (منتظر انسان)', details: clip(`attempt ${String(e.attempt ?? '؟')} · budget مصرف نشد · ${String(e.question ?? '')}`, 300) };
    case 'review.rejection-loop': {
      const failures = Array.isArray(e.failures) ? e.failures.map(String) : [];
      return { label: 'Reviewer دو بار با همان مشکل رد کرد (منتظر انسان)', details: `attempt ${String(e.previousAttempt ?? '؟')} و ${String(e.attempt ?? '؟')} · ${failures.join('، ') || '—'} · budget مصرف نشد` };
    }
    case 'review.outcome-inconsistent':
      return { label: 'خروجی ِ Reviewer ناسازگار بود', details: clip(`outcome=${String(e.outcome ?? '؟')} با requestedTransition=${String(e.requestedTransition ?? '؟')} نمی‌خواند؛ دوباره سنجیده می‌شود${Array.isArray(e.problems) && e.problems.length ? ` · ${clip(String(e.problems[0]), 140)}` : ''}`, 260) };
    case 'review.manual-case-by-reviewer': {
      const cases = Array.isArray(e.cases) ? e.cases.map(String) : [];
      return { label: 'Reviewer Case را «برای انسان» علامت زد', details: `${cases.join('، ') || '—'} — رد حساب نشد؛ در دروازه‌ی merge انسان می‌سنجد` };
    }
    case 'budget.refunded':
      return { label: 'budget ِ سوخته برگشت', details: `${String(e.field ?? 'budget')}: ${String(e.from ?? '؟')} → ${String(e.to ?? '؟')} (${String(e.amount ?? '؟')} برگشت)` };
    case 'review.re-evaluated': {
      const cases = Array.isArray(e.manualCases) ? e.manualCases.map(String) : [];
      return { label: 'review بدون اجرای Implementer دوباره سنجیده شد', details: `attempt ${String(e.attempt ?? '؟')} · Implementer اجرا نشد${cases.length ? ` · Case ِ دستی: ${cases.join('، ')}` : ''}${e.reason ? ` · ${clip(String(e.reason), 120)}` : ''}` };
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

// --- TOOLING-051 ------------------------------------------------------------------------------------------------

const shortSha = value => (typeof value === 'string' && value ? value.slice(0, 8) : '؟');

/** «C17792» از «17792» یا «c17792»؛ مقدار ِ خالی/غیررشته ← ''. */
export function changesetLabel(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return /^c/i.test(text) ? `C${text.slice(1)}` : `C${text}`;
}

/** تسک ِ Manager ِ قدیمی (بدون actions.run) ← null (رفتار ِ قبلی)؛ وگرنه { allowed, code, reason }. */
export function runInfo(task) {
  const actions = task?.actions;
  if (!actions || typeof actions !== 'object' || !('run' in actions)) return null;
  if (actions.run === true) return { allowed: true, code: null, reason: null };
  return { allowed: false, code: task.runBlocked?.code ?? null, reason: task.runBlocked?.reason ?? 'Manager دلیلی برای ِ ممکن‌نبودن ِ اجرا نداد' };
}

/** «اجرا: ممکن» / «اجرا: ممکن نیست — <reason>» / null (Manager قدیمی). */
export function runLine(task) {
  const info = runInfo(task);
  if (!info) return null;
  return info.allowed ? 'اجرا: ممکن' : `اجرا: ممکن نیست — ${info.reason}`;
}

/** story ِ SPDD ِ رزروشده (tasks[].spdd). */
export function spddStories(task) {
  return (Array.isArray(task?.spdd) ? task.spdd : []).filter(s => s && typeof s.code === 'string').map(s => ({ project: s.project ?? null, code: s.code, number: s.number ?? null, slug: s.slug ?? '', dir: s.dir ?? null }));
}
export const spddText = story => `story: ${story.code} (${story.slug})`;

/** blocker ِ needs-human: منتظر ِ انسان است، نه خطای فنی. */
export const needsHuman = task => task?.blocker?.kind === 'needs-human';

const lastEvent = (events, name) => [...(Array.isArray(events) ? events : [])].reverse().find(e => e && e.event === name) ?? null;

/** reviewer-clarification | rejection-loop | عمومی؛ events اختیاری (متن ِ کامل ِ سؤال / مجموعه‌ی شکست‌ها). */
export function needsHumanInfo(task, events = null) {
  if (!needsHuman(task)) return null;
  const stage = task.blocker.stage ?? null;
  const detail = String(task.blocker.detail ?? task.blocker.reason ?? '');
  if (stage === 'reviewer-clarification') {
    const question = lastEvent(events, 'review.needs-clarification')?.question;
    return { stage, title: 'Reviewer سؤال دارد', text: typeof question === 'string' && question ? question : detail, failures: null, guide: 'جواب را به‌صورت یادداشت بنویس (note) و بعد unblock کن؛ Reviewer با یادداشت دوباره می‌سنجد.' };
  }
  if (stage === 'rejection-loop') {
    const failures = lastEvent(events, 'review.rejection-loop')?.failures;
    return { stage, title: 'Reviewer دو بار پشت‌سرهم با همان مشکل رد کرد', text: detail, failures: Array.isArray(failures) ? failures.map(String) : null, guide: 'یکی از این‌ها: سنجش دوباره‌ی review (اگر مجاز است)، یادداشت (note)، یا unblock.' };
  }
  return { stage, title: 'نیاز به تصمیم ِ انسان', text: detail, failures: null, guide: 'blocker را بررسی کن؛ بعد note و unblock.' };
}

/** خط‌های CLI برای blocker ِ needs-human. reevaluate: actions.reevaluateReview. */
export function needsHumanLines(info, id, { reevaluate = false } = {}) {
  if (!info) return [];
  const lines = [`⏳ ${info.title} (منتظر ِ انسان، نه خطای فنی):`];
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
export function externalChangesets(task) {
  return (Array.isArray(task?.externalSources) ? task.externalSources : []).filter(s => s && !s.error).map(s => {
    const declared = (Array.isArray(s.declaredChangesets) ? s.declaredChangesets : []).map(changesetLabel).filter(Boolean);
    return {
      id: s.id, access: s.access ?? null, declared,
      checkedIn: (Array.isArray(s.checkedIn?.changesets) ? s.checkedIn.changesets : []).map(changesetLabel).filter(Boolean),
      canDeclare: s.actions?.canDeclareChangeset === true,
      missing: task.state === 'integrated' && declared.length === 0 && s.access !== 'read'
    };
  });
}

/** شماره‌ی changeset ِ ورودی ← 'C1,C2' یا null اگر نامعتبر. فقط ارقام (با C اختیاری)، جداشده با کاما/فاصله. */
export function parseChangesetInput(text) {
  const parts = String(text ?? '').split(/[\s,،]+/).map(p => p.trim()).filter(Boolean);
  if (!parts.length || parts.length > 20 || parts.some(p => !/^c?\d{1,9}$/i.test(p))) return null;
  return [...new Set(parts.map(changesetLabel))].join(',');
}
