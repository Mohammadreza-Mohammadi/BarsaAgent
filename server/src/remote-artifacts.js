// `barsa artifact` — خواندن فقط‌خواندنی ِ artifactهای یک تسک از راه **Manager** (`manager.js artifact` / `events`)،
// هرگز خواندن مستقیم فایل. فهرست نام‌ها بسته است: چیزی بیرون از آن (prompt.md، agent-stream.jsonl، human/، مسیر دلخواه)
// از راه دور خوانده نمی‌شود؛ مسیر نسبی را کاربر نمی‌دهد، فقط «نام» + شماره‌ی attempt.

/** artifactهای سطح تسک (یا attempt) که از گوشی خوانده می‌شوند. */
export const TASK_ARTIFACTS = Object.freeze([
  'questions.md', 'proposed-task.md', 'task.md', 'handoff.md', 'review.md', 'release-note.md', 'implementation-report.md',
  'previous-rejection.md', 'request.md', 'risks.md', 'tests.md', 'implementation-plan.md', 'affected-areas.md', 'baseline-check.md', 'changes.diff'
]);
/** فقط داخل attempts/NNN/ . */
export const ATTEMPT_ARTIFACTS = Object.freeze(['result.yaml', 'run-meta.yaml', 'agent-transcript.log']);
/** فقط «انتها» نشان داده می‌شود (حجیم‌اند). */
export const TAIL_ONLY = Object.freeze(['agent-transcript.log', 'events.jsonl']);
export const EVENTS_NAME = 'events.jsonl';

export const ARTIFACT_NAMES = Object.freeze([...TASK_ARTIFACTS, ...ATTEMPT_ARTIFACTS, EVENTS_NAME]);

export const DEFAULT_MAX_CHARS = 120_000;
export const DEFAULT_TAIL = 80;
export const MAX_TAIL = 500;

export const pad3 = n => String(n).padStart(3, '0');

/** @returns {{ok:true, name:string}|{ok:false, error:string}} */
export function validateName(raw) {
  const name = String(raw ?? '').trim();
  if (name === 'events') return { ok: true, name: EVENTS_NAME };
  if (ARTIFACT_NAMES.includes(name)) return { ok: true, name };
  return { ok: false, error: `نام artifact مجاز نیست: «${name.slice(0, 60)}». نام‌های مجاز: ${ARTIFACT_NAMES.join('، ')}` };
}

/** آخرین N خط + سقف نویسه؛ `truncated` اگر چیزی بریده شد. */
export function limitText(text, { tail, maxChars = DEFAULT_MAX_CHARS }) {
  const all = String(text).split(/\r?\n/);
  const totalLines = all.length - (all.at(-1) === '' ? 1 : 0);
  let shown = all.slice(0, totalLines);
  let truncated = false;
  if (tail && shown.length > tail) { shown = shown.slice(-tail); truncated = true; }
  let out = shown.join('\n');
  if (out.length > maxChars) {
    out = `${out.slice(0, maxChars)}\n… [بریده شد: بیش از ${maxChars} نویسه — از --tail N برای انتها استفاده کن]`;
    truncated = true;
  }
  return { text: out, totalLines, shownLines: shown.length, truncated };
}

/**
 * مسیر نسبی (از ریشه‌ی پوشه‌ی تسک) برای یک نام و attempt. هیچ ورودی کاربر مستقیم مسیر نمی‌شود: نام از فهرست بسته،
 * attempt فقط رقم است.
 */
export function relPathFor(name, attempt) {
  if (attempt !== null && attempt !== undefined) return `attempts/${pad3(attempt)}/${name}`;
  return name;
}
