// hook ِ PreToolUse برای ابزار Bash در گفت‌وگوی Remote Control.
//
// چرا لازم است: قاعده‌های settings.json به ترتیب deny ← ask ← allow ارزیابی می‌شوند و اولین تطبیق برنده است، پس
// نمی‌شود «هر Bash ِ دیگری» را با یک deny بست و فقط `./barsa …` را باز گذاشت (deny همه‌چیز را می‌بندد). این hook
// «پیش‌فرض: رد» را می‌سازد: فقط یک فراخوانی ساده‌ی `./barsa <فرمان> …` (با heredoc ِ تک‌کوتیشن برای متن) رد نمی‌شود.
// بقیه‌ی Bash — از جمله `ls`، `git status`، `;`، `&&`، `|`، `$(…)`، redirect — رد می‌شود. تصمیم تأیید روی گوشی همچنان با
// قاعده‌های ask/allow است؛ این hook فقط چیزی را مجاز نمی‌کند، فقط رد می‌کند.
//
// فهرست فرمان‌ها باید با server/src/remote-cli-spec.js (READ_COMMANDS/WRITE_COMMANDS) یکی باشد؛ تست مطابقت را می‌سنجد.
const COMMANDS = ['health', 'issues', 'tasks', 'task', 'log', 'waiting', 'create-from-issue', 'create-task', 'run', 'stop', 'answer'];
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

  const [name] = args;
  if (name !== undefined && !COMMANDS.includes(name) && !['--help', '-h', 'help'].includes(name)) return { ok: false, reason: `«${name}» فرمان مجاز barsa نیست.` };
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
