// hook ِ PreToolUse برای ابزار Bash در گفت‌وگوی Remote Control.
//
// چرا لازم است: قاعده‌های settings.json به ترتیب deny ← ask ← allow ارزیابی می‌شوند و اولین تطبیق برنده است، پس
// نمی‌شود «هر Bash ِ دیگری» را با یک deny بست و فقط `./barsa …` را باز گذاشت (deny همه‌چیز را می‌بندد). این hook
// «پیش‌فرض: رد» را می‌سازد: فقط یک فراخوانی ساده‌ی `./barsa <فرمان> …` (با heredoc ِ تک‌کوتیشن برای متن) رد نمی‌شود.
// بقیه‌ی Bash — از جمله `ls`، `git status`، `;`، `&&`، `|`، `$(…)`، redirect — رد می‌شود. تصمیم تأیید روی گوشی همچنان با
// قاعده‌های ask/allow است؛ این hook فقط چیزی را مجاز نمی‌کند، فقط رد می‌کند.
//
// فهرست فرمان‌ها باید با server/src/remote-cli-spec.js (READ_COMMANDS/WRITE_COMMANDS) یکی باشد؛ تست مطابقت را می‌سنجد.
const COMMANDS = ['health', 'issues', 'tasks', 'task', 'log', 'waiting', 'artifact', 'diag', 'bundle', 'runtime', 'runtime-options', 'create-from-issue', 'create-task', 'run', 'stop', 'answer', 'recover', 'recheck', 'retry-provision', 'retry-install', 'sync', 'kill-stuck-install', 'set-runtime', 'drain'];
// شکل ِ آرگومان‌های runtime (TOOLING-046). اعتبارسنجی ِ **معنایی** (کدام provider/مدل/effort مجاز است) کار ِ Manager است؛
// این‌جا فقط نویسه‌ها و جایگاه‌ها: نقش هر نامِ [a-z-]+ ، و <provider>:<model>:<effort> فقط حرف/عدد/نقطه/خط (قطعه‌ی خالی مجاز).
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLE = /^[a-z][a-z-]{0,31}$/;
const SEGMENTS = /^[A-Za-z0-9._-]{0,64}:[A-Za-z0-9._-]{0,64}:[A-Za-z0-9._-]{0,64}$/;
const ROLE_SPEC = /^[a-z][a-z-]{0,31}=[A-Za-z0-9._-]{0,64}:[A-Za-z0-9._-]{0,64}:[A-Za-z0-9._-]{0,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMON_FLAGS = new Set(['--json']);

/** flagهای تکی/مقداردار ِ هر فرمان ِ runtime؛ هر چیز دیگر رد می‌شود. */
const RUNTIME_SHAPES = {
  runtime: { value: new Set(['--repo']), bool: new Set(), positional: [ID] },
  'runtime-options': { value: new Set(['--repo']), bool: new Set(), positional: [] },
  'retry-provision': { value: new Set(['--repo']), bool: new Set(), positional: [ID] },
  recheck: { value: new Set(['--repo']), bool: new Set(), positional: [ID] },
  // drain: بدون آرگومان ِ مکانی؛ فقط --status یا --off (نه هر دو)
  drain: { value: new Set(), bool: new Set(['--status', '--off']), positional: [], exclusive: ['--status', '--off'] }
};

function runtimeShapeError(name, args) {
  const shape = RUNTIME_SHAPES[name];
  if (!shape) return null;
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (COMMON_FLAGS.has(arg) || shape.bool.has(arg)) continue;
    if (shape.value.has(arg)) { if (!ID.test(args[i + 1] ?? '')) return `${arg} مقدار نامعتبر دارد.`; i += 1; continue; }
    if (arg.startsWith('-')) return `گزینه‌ی ${arg} برای ${name} مجاز نیست.`;
    positional.push(arg);
  }
  if (shape.exclusive && shape.exclusive.every(flag => args.includes(flag))) return `${shape.exclusive.join(' و ')} با هم معنا ندارند.`;
  if (positional.length !== shape.positional.length || positional.some((p, i) => !shape.positional[i].test(p))) return `آرگومان‌های ${name} نامعتبر است.`;
  return null;
}

/** set-runtime <id> (<role> <provider>:<model>:<effort> | --preset <name> | <role|preset|all> --reset) (--reason "…" | --stdin | --text-file <f>) */
function setRuntimeShapeError(args) {
  const positional = [];
  let preset = null; let reset = false; let reasons = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--stdin') { if (arg === '--stdin') reasons += 1; continue; }
    if (arg === '--reset') { reset = true; continue; }
    if (arg === '--preset') { preset = args[i + 1] ?? ''; if (!NAME.test(preset)) return 'نام preset نامعتبر است.'; i += 1; continue; }
    if (arg === '--reason' || arg === '--text-file') { if (!(args[i + 1] ?? '').length) return `${arg} مقدار می‌خواهد.`; reasons += 1; i += 1; continue; }
    if (arg === '--repo') { if (!ID.test(args[i + 1] ?? '')) return '--repo نامعتبر است.'; i += 1; continue; }
    if (arg.startsWith('-')) return `گزینه‌ی ${arg} برای set-runtime مجاز نیست.`;
    positional.push(arg);
  }
  if (reasons !== 1) return 'دقیقاً یکی از --reason / --stdin / --text-file لازم است.';
  if (!ID.test(positional[0] ?? '')) return 'شناسه‌ی تسک نامعتبر است.';
  if (preset !== null) return positional.length === 1 && !reset ? null : 'با --preset فقط شناسه‌ی تسک می‌آید.';
  if (reset) return positional.length === 2 && ROLE.test(positional[1]) ? null : 'با --reset: <id> <role|preset|all>';
  return positional.length === 3 && ROLE.test(positional[1]) && SEGMENTS.test(positional[2]) ? null : 'قالب: <id> <role> <provider>:<model>:<effort>';
}

/** flagهای runtime روی هر فرمان (create-*): مقدار بعد از --runtime / --runtime-preset باید شکل ِ مجاز داشته باشد. */
function runtimeFlagError(args) {
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--runtime' && !ROLE_SPEC.test(args[i + 1] ?? '')) return '--runtime باید <role>=<provider>:<model>:<effort> باشد (فقط حرف/عدد/نقطه/خط).';
    if (args[i] === '--runtime-preset' && !NAME.test(args[i + 1] ?? '')) return '--runtime-preset نامعتبر است.';
  }
  return null;
}

const ARG_CHAR = /^[A-Za-z0-9_\-./:=@,+؀-ۿ‌‍]+$/;

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function evaluate(command) {
  const text = String(command ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  let first = lines[0];
  let rest = lines.slice(1);

  const heredoc = /\s<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s*$/.exec(first);
  if (heredoc) {
    first = first.slice(0, heredoc.index);
    const end = rest.indexOf(heredoc[2]);
    if (end < 0) return { ok: false, reason: 'heredoc بسته نشده است.' };
    if (rest.slice(end + 1).some(line => line.trim() !== '')) return { ok: false, reason: 'بعد از heredoc چیزی مجاز نیست.' };
    rest = [];
  }
  if (rest.some(line => line.trim() !== '')) return { ok: false, reason: 'فرمان چندخطی (جز heredoc ِ تک‌کوتیشن) مجاز نیست.' };

  const prefix = /^\.\/barsa(?:\s+|$)/.exec(first);
  if (!prefix) return { ok: false, reason: 'فقط «./barsa <فرمان>» مجاز است.' };

  const args = [];
  let current = '';
  let quote = null;
  let started = false;
  for (const ch of first.slice(prefix[0].length)) {
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && /[$`\\!]/.test(ch)) return { ok: false, reason: `نویسه‌ی ${ch} داخل کوتیشن مجاز نیست.` };
      current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) args.push(current);
      current = '';
      started = false;
    } else {
      if (!ARG_CHAR.test(ch)) return { ok: false, reason: `نویسه‌ی ${JSON.stringify(ch)} بیرون از کوتیشن مجاز نیست (فقط یک فراخوانی ساده).` };
      current += ch;
    }
  }
  if (quote) return { ok: false, reason: 'کوتیشن بسته نشده است.' };
  if (started || current) args.push(current);

  const [name, ...commandArgs] = args;
  if (name !== undefined && !COMMANDS.includes(name) && !['--help', '-h', 'help'].includes(name)) return { ok: false, reason: `«${name}» فرمان مجاز barsa نیست.` };
  const shape = name === 'set-runtime' ? setRuntimeShapeError(commandArgs) : (runtimeShapeError(name, commandArgs) ?? runtimeFlagError(commandArgs));
  if (shape) return { ok: false, reason: shape };
  return { ok: true };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  let command = '';
  try { command = JSON.parse(input)?.tool_input?.command ?? ''; } catch { /* ورودی خراب = رد */ }
  const verdict = evaluate(command);
  if (verdict.ok) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `${verdict.reason} تنها ابزار این گفت‌وگو «./barsa» است؛ اگر کاری با آن شدنی نیست، بگو «از رابط کاربری کانبان انجامش بده».`
    }
  }));
}

if (process.argv[1] && /guard\.mjs$/i.test(process.argv[1])) await main();
