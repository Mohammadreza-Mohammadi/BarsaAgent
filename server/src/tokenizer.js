// کانبان فاز ۱، بند الف: tokenizer ِ خط فرمان کنسول Manager.
//
// شبیه شل کوتیشن را می‌فهمد ("..." و '...') ولی **هیچ گسترشی** انجام نمی‌دهد:
// نه $، نه glob، نه backtick. خروجی فقط یک آرایه‌ی رشته است که مستقیم به
// execFile/spawn (shell:false) می‌رسد. هر نویسه‌ی کنترلی شل بیرون از کوتیشن
// (; | & > < $ ` و خط جدید) یعنی کسی دنبال اجرای چیزی غیر از manager.js است و
// خطا می‌دهد، نه اینکه سکوت یا escape شود.
//
// backslash همیشه خودش است (مسیر ویندوز C:\dir\file)، به‌جز داخل "..." که
// `\"` یک " لفظی می‌دهد. پس "C:\dir\" (backslash پایانی قبل از کوتیشن بستن) باز
// می‌ماند و خطا می‌دهد؛ پیام خطا همین را می‌گوید.

export class ConsoleSyntaxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConsoleSyntaxError';
    this.status = 400;
  }
}

const FORBIDDEN_OUTSIDE_QUOTES = new Map([
  [';', '";" (چند فرمان پشت‌سرهم)'],
  ['|', '"|" (pipe)'],
  ['&', '"&" یا "&&"'],
  ['>', '">" (ریدایرکت خروجی)'],
  ['<', '"<" (ریدایرکت ورودی)'],
  ['$', '"$" (گسترش متغیر/دستور)'],
  ['`', '"`" (گسترش دستور)']
]);

export function tokenize(line) {
  const input = String(line ?? '');
  if (input.includes('\0')) throw new ConsoleSyntaxError('نویسه‌ی NUL در خط فرمان مجاز نیست.');
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (quote === '"' && ch === '\\' && input[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }
    if (FORBIDDEN_OUTSIDE_QUOTES.has(ch)) {
      throw new ConsoleSyntaxError(
        `نویسه‌ی ${FORBIDDEN_OUTSIDE_QUOTES.get(ch)} بیرون از کوتیشن مجاز نیست — کنسول فقط یک فرمان manager.js را اجرا می‌کند و هیچ گسترش شل ندارد.`
      );
    }
    if (ch === '\n' || ch === '\r') {
      throw new ConsoleSyntaxError('خط جدید بیرون از کوتیشن مجاز نیست — هر بار فقط یک فرمان در یک خط.');
    }
    if (/\s/.test(ch)) {
      if (inToken) { tokens.push(current); current = ''; inToken = false; }
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (quote) {
    throw new ConsoleSyntaxError(
      `کوتیشن ${quote} بسته نشده است. (داخل "..." دنباله‌ی \\" یک " است؛ برای مسیر ویندوز که با backslash تمام می‌شود، backslash پایانی را حذف کن.)`
    );
  }
  if (inToken) tokens.push(current);
  return tokens;
}
