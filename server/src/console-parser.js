// کانبان فاز ۱، بند الف: از «یک خط متن» به «argv ِ امن برای manager.js».
//
// فهرست زیرفرمان‌های مجاز **دستی نوشته نمی‌شود** — از خروجی
// `manager.js --help` ساخته می‌شود (parseHelpSubcommands) تا هر زیرفرمان تازه‌ی
// Manager خودکار در کنسول بیاید و هر زیرفرمان حذف‌شده خودکار رد شود.
import path from 'node:path';
import { tokenize, ConsoleSyntaxError } from './tokenizer.js';
import { validArtifactPath } from './security.js';

// این flagها مقدار «مسیر فایل» می‌گیرند. روی سرور بدون شل انسان به فایل‌سیستم
// دسترسی ندارد، پس مقدارشان **همیشه** از یک textarea می‌آید و کانبان خودش فایل
// موقت UTF-8 می‌سازد. مسیری که کاربر تایپ کرده نادیده/جایگزین می‌شود — اگر
// پذیرفته می‌شد، کنسول می‌توانست هر فایل سیستم را به Manager بدهد (مثلاً به
// عنوان متن clarify) و در artifactهای task بنویسد.
export const PATH_VALUE_FLAGS = Object.freeze(['--file', '--reason-file', '--release-note-file']);

// زیرفرمان‌هایی که چیزی را تغییر نمی‌دهند. هر چیز دیگر (و هر زیرفرمان تازه‌ای
// که در این فهرست نیست) «تغییردهنده» حساب می‌شود و پنجره‌ی تأیید می‌گیرد.
export const READ_ONLY_SUBCOMMANDS = Object.freeze(['capabilities', 'status', 'events', 'artifact']);

// زیرفرمان‌هایی که خود کانبان (اکشن‌های تایپ‌شده، صف run، import) صدا می‌زند.
// تست می‌سنجد که زیرمجموعه‌ی `manager.js --help` باشند — اگر Manager یکی را
// حذف/تغییر نام داد، همان لحظه معلوم می‌شود، نه وقتی کاربر دکمه را بزند.
export const INTERNAL_SUBCOMMANDS = Object.freeze([
  'answer', 'run', 'cancel', 'abandon', 'rebase', 'void', 'unlock',
  'import-issue', 'external-init', 'status', 'events', 'artifact', 'capabilities'
]);

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TASK_ID_SUBCOMMANDS = new Set([
  'answer', 'run', 'cancel', 'abandon', 'rebase', 'void', 'unlock', 'events', 'artifact'
]);

/**
 * `manager.js --help` زیر «زیرفرمان‌ها:» هر زیرفرمان را با دو فاصله در ابتدای
 * خط می‌آورد؛ خط‌های ادامه با فاصله‌ی بیشتر شروع می‌شوند.
 */
export function parseHelpSubcommands(helpText) {
  const names = [];
  let inSection = false;
  for (const raw of String(helpText || '').split(/\r?\n/)) {
    if (!inSection) {
      if (/^زیرفرمان‌ها\s*:/.test(raw.trim())) inSection = true;
      continue;
    }
    if (!raw.trim()) break;
    const match = /^ {2}([a-z][a-z0-9-]*)(?=\s|$)/.exec(raw);
    if (match && !names.includes(match[1])) names.push(match[1]);
  }
  return names;
}

function normalizeScript(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

function stripManagerPrefix(tokens, repo) {
  if (!tokens.length) return tokens;
  const first = path.basename(tokens[0]).toLowerCase();
  if (first !== 'node' && first !== 'node.exe') return tokens;
  const accepted = new Set(['scripts/manager.js', normalizeScript(repo?.managerScript)].filter(Boolean));
  if (tokens.length < 2 || !accepted.has(normalizeScript(tokens[1]))) {
    throw new ConsoleSyntaxError(
      'کنسول فقط فرمان manager.js را اجرا می‌کند: "node scripts/manager.js <زیرفرمان> …" (یا خود زیرفرمان).'
    );
  }
  return tokens.slice(2);
}

/**
 * @returns {{
 *   subcommand: string, taskId: string|null, readOnly: boolean,
 *   template: Array<string | { attach: string }>,
 *   attachments: string[]
 * }}
 * `template` همان argv ِ بعد از نام زیرفرمان است، با جای‌نگهدار برای فایل‌ها.
 */
export function parseConsoleLine(line, { allowed, repo } = {}) {
  const tokens = stripManagerPrefix(tokenize(line), repo);
  if (!tokens.length) throw new ConsoleSyntaxError('خط خالی است.');
  const [subcommand, ...rest] = tokens;
  if (subcommand.startsWith('-')) {
    throw new ConsoleSyntaxError(`"${subcommand}" یک زیرفرمان نیست. حالت قدیمی "--task" در کنسول مجاز نیست.`);
  }
  const allowedList = Array.isArray(allowed) ? allowed : [];
  if (!allowedList.includes(subcommand)) {
    const known = allowedList.length ? allowedList.join('، ') : '— (فهرست از manager.js --help خوانده نشد)';
    throw Object.assign(
      new ConsoleSyntaxError(`زیرفرمان "${subcommand}" مجاز نیست. زیرفرمان‌های مجاز (از manager.js --help): ${known}`),
      { code: 'subcommand-not-allowed' }
    );
  }

  const template = [];
  const attachments = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    const eq = token.indexOf('=');
    if (eq > 0 && PATH_VALUE_FLAGS.includes(token.slice(0, eq))) {
      throw new ConsoleSyntaxError(`شکل "${token.slice(0, eq)}=…" پذیرفته نمی‌شود؛ فقط "${token.slice(0, eq)}" تنها بنویس و متن را در کادر متن بگذار.`);
    }
    if (PATH_VALUE_FLAGS.includes(token)) {
      if (attachments.includes(token)) throw new ConsoleSyntaxError(`${token} بیش از یک بار آمده است.`);
      attachments.push(token);
      template.push(token, { attach: token });
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) i += 1; // مسیر تایپ‌شده دور ریخته می‌شود
      continue;
    }
    template.push(token);
  }

  let taskId = null;
  if (TASK_ID_SUBCOMMANDS.has(subcommand) && typeof template[0] === 'string' && !template[0].startsWith('--')) {
    taskId = template[0];
    if (!TASK_ID.test(taskId)) throw new ConsoleSyntaxError(`شناسه‌ی task نامعتبر است: "${taskId}"`);
  }
  if (subcommand === 'run') {
    if (template.length !== 1 || !taskId) {
      throw new ConsoleSyntaxError('کنسول فقط "run <شناسه>" را می‌پذیرد (بدون آرگومان اضافه)؛ run از صف و ثبت اجرای کانبان می‌گذرد.');
    }
  }
  if (subcommand === 'artifact') {
    const at = template.indexOf('--path');
    if (at >= 0 && !validArtifactPath(template[at + 1])) throw new ConsoleSyntaxError('مسیر artifact نامعتبر است.');
  }
  return {
    subcommand,
    taskId,
    readOnly: READ_ONLY_SUBCOMMANDS.includes(subcommand),
    template,
    attachments
  };
}

/** رشته‌ی نمایشی: همان چیزی که در پنجره‌ی تأیید و دفتر ممیزی می‌آید. */
export function displayCommand(parsed) {
  const quote = value => (/[\s"']/.test(value) || value === '' ? JSON.stringify(value) : value);
  const parts = parsed.template.map(item => (typeof item === 'string' ? quote(item) : `‹متن ${item.attach}›`));
  return ['node scripts/manager.js', parsed.subcommand, ...parts].join(' ');
}

/** argv ِ نهایی با مسیرهای فایل موقت. */
export function resolveArgs(parsed, tempPaths) {
  return [
    parsed.subcommand,
    ...parsed.template.map(item => {
      if (typeof item === 'string') return item;
      const file = tempPaths[item.attach];
      if (!file) throw new ConsoleSyntaxError(`برای ${item.attach} متنی داده نشده است.`);
      return file;
    })
  ];
}
