// بخش «منتظر تو» در `barsa task <id>`: برای هر نوع گیت دقیقاً همان چیزی که انسان برای تصمیم لازم دارد.
//   clarification  ← متن **کامل** سؤال‌ها (questions.md)، خلاصه‌اش نمی‌کند
//   spec-approval  ← عنوان/هدف + خلاصه‌ی AC + سؤال‌های باز (proposed-task.md)
//   merge-approval ← تصمیم Reviewer، release note، آمار diff (و diff ِ منبع بیرونی مثل WebIII)
//   orphan-attempt ← شماره‌ی attempt و نشانی خواندن result.yaml
// توابع این فایل خالص‌اند (متن/JSON ورودی ← ساختار) تا بدون سرور تست شوند.

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

const HEADING = /^#{1,6}\s+(.*)$/;
const AC_HEADING = /^#{2,5}\s*(AC[-\s]?\d+)\b[:.\s—-]*(.*)$/i;
const AC_ITEM = /^\s*(?:[-*]\s*)?(?:\*\*)?(AC[-\s]?\d+)(?:\*\*)?[:.\s—-]+(.+)$/i;

/** خلاصه‌ی proposed-task.md: عنوان، هدف، AC ها، سؤال‌های باز. */
export function summarizeProposal(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let title = null;
  for (const line of lines) {
    const m = /^#\s+(.*)$/.exec(line);
    if (m) { title = m[1].replace(/^Proposed Task\s*[—-]\s*/i, '').trim(); break; }
  }
  const section = predicate => {
    const out = [];
    let on = false;
    for (const line of lines) {
      const h = HEADING.exec(line);
      if (h && /^#{1,2}\s/.test(line)) { on = predicate(h[1]); continue; }
      if (on) out.push(line);
    }
    return out;
  };
  const goal = clip(section(name => /^goal\b|^هدف/i.test(name.trim())).join(' '), 400) || null;

  const acceptanceCriteria = [];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = AC_HEADING.exec(lines[i]);
    if (heading) {
      let body = heading[2].trim();
      if (!body) {
        const next = [];
        for (let j = i + 1; j < lines.length && !HEADING.test(lines[j]); j += 1) if (lines[j].trim()) next.push(lines[j].trim());
        body = next.join(' ');
      }
      acceptanceCriteria.push({ id: heading[1].toUpperCase().replace(/\s+/, '-'), text: clip(body, 220) });
      continue;
    }
    const item = AC_ITEM.exec(lines[i]);
    if (item && !HEADING.test(lines[i])) acceptanceCriteria.push({ id: item[1].toUpperCase().replace(/\s+/, '-'), text: clip(item[2], 220) });
  }

  const openQuestions = section(name => /ambigu|open question|سؤال|ابهام/i.test(name))
    .filter(line => /^\s*[-*]\s+/.test(line))
    .map(line => clip(line.replace(/^\s*[-*]\s+/, ''), 220))
    .slice(0, 12);
  return { title, goal, acceptanceCriteria, openQuestions };
}

const sum = (files, key) => files.reduce((acc, f) => acc + (f[key] ?? 0), 0);

function diffStats(files) {
  const list = (files || []).map(f => ({ path: f.path, added: f.added ?? 0, deleted: f.deleted ?? 0, status: f.status ?? null, inScope: f.inScope ?? null }));
  return { files: list, count: list.length, added: sum(list, 'added'), deleted: sum(list, 'deleted') };
}

/**
 * @param task    پاسخ `status --json --task` (خام، قبل از خلاصه‌سازی)
 * @param fetchArtifact  async (name) => متن | null  (از endpoint ِ artifact)
 * @returns {Promise<object|null>}
 */
export async function buildWaiting(task, fetchArtifact) {
  const gate = task.awaitingHuman;
  if (!gate) return null;
  const out = { kind: gate.kind ?? null, since: gate.since ?? null, artifact: gate.artifact ?? null, hint: null };
  const safeFetch = async name => { try { return await fetchArtifact(name); } catch (error) { out.fetchError = clip(error?.message, 200); return null; } };

  if (gate.kind === 'clarification') {
    out.questions = await safeFetch('questions.md');
    out.hint = `متن کامل: barsa artifact ${task.id} questions.md`;
  } else if (gate.kind === 'spec-approval') {
    const text = await safeFetch('proposed-task.md');
    out.proposal = text ? summarizeProposal(text) : null;
    out.hint = `متن کامل: barsa artifact ${task.id} proposed-task.md`;
  } else if (gate.kind === 'merge-approval') {
    const review = task.review || {};
    const evidence = review.evidence || {};
    out.review = {
      decision: review.decision ?? null, evidenceStatus: review.evidenceStatus ?? null,
      acceptance: (evidence.acceptance || []).map(r => ({ ac: r.ac ?? null, verdict: r.verdict ?? null })),
      problems: (review.problems || []).map(p => clip(p, 300))
    };
    out.releaseNote = task.releaseNote
      ? { userVisible: task.releaseNote.userVisible ?? null, headline: clip(task.releaseNote.headline, 300), body: String(task.releaseNote.body ?? '').trim().slice(0, 3000), approvedByHuman: task.releaseNote.approvedByHuman ?? null }
      : null;
    out.diff = task.diff ? diffStats(task.diff.files) : null;
    out.external = (task.externalSources || []).map(source => (source.error
      ? { id: source.id, error: clip(source.error, 200) }
      : { id: source.id, access: source.access ?? null, delivery: source.delivery ?? null, ...(source.diff ? { diff: { ...diffStats(source.diff.files), path: source.diff.path ?? null } } : { diff: null }) }));
    out.hint = `متن کامل: barsa artifact ${task.id} review.md  ·  barsa artifact ${task.id} release-note.md`;
  } else if (gate.kind === 'orphan-attempt') {
    const m = /(\d{1,3})\/?$/.exec(String(gate.artifact ?? ''));
    out.attempt = m ? m[1] : null;
    out.hint = out.attempt ? `barsa artifact ${task.id} result.yaml --attempt ${Number(out.attempt)}` : `barsa diag ${task.id}`;
  }
  return out;
}

/** خطوط متنی «منتظر تو» (برای barsa task). */
export function formatWaiting(waiting, id, controlStrip = text => text) {
  if (!waiting) return [];
  const lines = ['', `⏳ منتظر تو — ${waiting.kind}${waiting.since ? ` (از ${String(waiting.since).slice(0, 16).replace('T', ' ')})` : ''}`];
  if (waiting.kind === 'clarification') {
    lines.push(waiting.questions ? controlStrip(waiting.questions) : '(متن سؤال‌ها خوانده نشد)');
  } else if (waiting.kind === 'spec-approval') {
    const p = waiting.proposal;
    if (!p) lines.push('(proposed-task.md خوانده نشد)');
    else {
      if (p.title) lines.push(`عنوان: ${p.title}`);
      if (p.goal) lines.push(`هدف: ${p.goal}`);
      lines.push(`معیارهای پذیرش (${p.acceptanceCriteria.length}):`);
      for (const ac of p.acceptanceCriteria) lines.push(`  ${ac.id}: ${ac.text}`);
      if (p.openQuestions.length) {
        lines.push(`ابهام/سؤال باز (${p.openQuestions.length}):`);
        for (const q of p.openQuestions) lines.push(`  - ${q}`);
      }
    }
  } else if (waiting.kind === 'merge-approval') {
    const r = waiting.review;
    lines.push(`تصمیم Reviewer: ${r.decision ?? '—'}${r.evidenceStatus ? ` · شواهد: ${r.evidenceStatus}` : ''}${r.acceptance.length ? ` · ${r.acceptance.map(x => `${x.ac}:${x.verdict}`).join(' ')}` : ''}`);
    for (const problem of r.problems) lines.push(`  مشکل: ${problem}`);
    if (waiting.releaseNote) {
      lines.push(`release note${waiting.releaseNote.userVisible === false ? ' (برای کاربر دیده نمی‌شود)' : ''}: ${waiting.releaseNote.headline}`);
      if (waiting.releaseNote.body) lines.push(...waiting.releaseNote.body.split(/\r?\n/).map(l => `  ${l}`));
    } else lines.push('release note: —');
    if (waiting.diff) {
      lines.push(`diff: ${waiting.diff.count} فایل (+${waiting.diff.added} −${waiting.diff.deleted})`);
      for (const f of waiting.diff.files.slice(0, 15)) lines.push(`  ${f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '~'} ${clip(f.path, 90)} (+${f.added} −${f.deleted})${f.inScope === false ? ' ⚠ خارج scope' : ''}`);
      if (waiting.diff.count > 15) lines.push(`  … و ${waiting.diff.count - 15} فایل دیگر`);
    }
    for (const source of waiting.external) {
      if (source.error) { lines.push(`diff منبع بیرونی ${source.id}: خطا — ${source.error}`); continue; }
      if (!source.diff) { lines.push(`diff منبع بیرونی ${source.id} (${source.access}/${source.delivery}): ندارد`); continue; }
      lines.push(`diff منبع بیرونی ${source.id} (${source.access}/${source.delivery}): ${source.diff.count} فایل (+${source.diff.added} −${source.diff.deleted})`);
      for (const f of source.diff.files.slice(0, 15)) lines.push(`  ${f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '~'} ${clip(f.path, 90)} (+${f.added} −${f.deleted})`);
      if (source.diff.count > 15) lines.push(`  … و ${source.diff.count - 15} فایل دیگر`);
    }
    lines.push('یادآوری: تست دستی رابط کاربری از گوشی شدنی نیست؛ تصمیم merge با خود کاربر است.');
  } else if (waiting.kind === 'orphan-attempt') {
    lines.push(`attempt ${waiting.attempt ?? '؟'} نیمه‌کاره مانده است.`);
  }
  if (waiting.fetchError) lines.push(`(هشدار: ${waiting.fetchError})`);
  if (waiting.hint) lines.push(waiting.hint);
  return lines;
}
