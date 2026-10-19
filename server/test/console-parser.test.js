import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, ConsoleSyntaxError } from '../src/tokenizer.js';
import {
  parseConsoleLine, parseHelpSubcommands, displayCommand, resolveArgs, INTERNAL_SUBCOMMANDS, READ_ONLY_SUBCOMMANDS
} from '../src/console-parser.js';
import { HELP_FIXTURE } from './fake-manager.js';

const ALLOWED = parseHelpSubcommands(HELP_FIXTURE);
const parse = line => parseConsoleLine(line, { allowed: ALLOWED, repo: { managerScript: 'scripts/manager.js' } });

test('tokenizer: کوتیشن دوتایی و تکی، متن فارسی، فاصله‌ی داخل کوتیشن', () => {
  assert.deepEqual(tokenize('answer 10013 --reason "دلیل فارسی با فاصله" --x \'یک دو\''), ['answer', '10013', '--reason', 'دلیل فارسی با فاصله', '--x', 'یک دو']);
  assert.deepEqual(tokenize('  a   b  '), ['a', 'b']);
  assert.deepEqual(tokenize('a "" b'), ['a', '', 'b']);
  assert.deepEqual(tokenize('a"b c"d'), ['ab cd']);
});

test('tokenizer: backslash مسیر ویندوز دست‌نخورده می‌ماند', () => {
  assert.deepEqual(tokenize('artifact 1 --path C:\\dir\\sub\\file.md'), ['artifact', '1', '--path', 'C:\\dir\\sub\\file.md']);
  assert.deepEqual(tokenize('x "C:\\dir\\file name.md"'), ['x', 'C:\\dir\\file name.md']);
  assert.deepEqual(tokenize('x "say \\"hi\\""'), ['x', 'say "hi"']);
});

test('tokenizer: هیچ گسترشی انجام نمی‌شود — $ و * داخل کوتیشن و * بیرون لفظی می‌مانند', () => {
  assert.deepEqual(tokenize('x "$HOME $(whoami) `id`" \'$X\' *.js'), ['x', '$HOME $(whoami) `id`', '$X', '*.js']);
});

for (const [name, line] of [
  ['semicolon', 'status --json ; calc'],
  ['pipe', 'status --json | more'],
  ['&&', 'status && calc'],
  ['& تکی', 'status & calc'],
  ['redirect >', 'status > out.txt'],
  ['redirect <', 'status < in.txt'],
  ['$()', 'status $(whoami)'],
  ['$VAR', 'status $HOME'],
  ['backtick', 'status `id`'],
  ['newline', 'status\ncalc']
]) {
  test(`tokenizer: ${name} بیرون از کوتیشن رد می‌شود`, () => {
    assert.throws(() => tokenize(line), ConsoleSyntaxError);
  });
}

test('tokenizer: کوتیشن بسته‌نشده و NUL رد می‌شود', () => {
  assert.throws(() => tokenize('a "b'), /بسته نشده/);
  assert.throws(() => tokenize('a \'b'), /بسته نشده/);
  assert.throws(() => tokenize('a\0b'), /NUL/);
  // backslash پایانی قبل از کوتیشن بستن: " را escape می‌کند و کوتیشن باز می‌ماند
  assert.throws(() => tokenize('x "C:\\dir\\"'), /بسته نشده/);
});

test('فهرست زیرفرمان‌ها از همان قالب ِ واقعی manager.js --help ساخته می‌شود (fixture = خروجی واقعی)', () => {
  assert.deepEqual(ALLOWED.sort(), [
    'abandon', 'answer', 'artifact', 'cancel', 'capabilities', 'events', 'external-init',
    'import-issue', 'rebase', 'run', 'status', 'unlock', 'void'
  ]);
});

test('parseHelpSubcommands: خط‌های ادامه، خط خالی بعد از بخش، و ورودی خالی', () => {
  const text = 'استفاده: ...\n\nزیرفرمان‌ها:\n  one <id>   توضیح\n                  ادامه‌ی توضیح\n  two-x\n\nهر زیرفرمان\n  three\n';
  assert.deepEqual(parseHelpSubcommands(text), ['one', 'two-x']);
  assert.deepEqual(parseHelpSubcommands(''), []);
  assert.deepEqual(parseHelpSubcommands(undefined), []);
});

test('هر زیرفرمانی که دکمه‌های کانبان صدا می‌زنند در --help واقعی هست (drift = شکست تست)', () => {
  const missing = INTERNAL_SUBCOMMANDS.filter(name => !ALLOWED.includes(name));
  assert.deepEqual(missing, []);
  for (const name of READ_ONLY_SUBCOMMANDS) assert.ok(ALLOWED.includes(name), `${name} باید در --help باشد`);
});

test('پیشوند node scripts/manager.js اختیاری است و حذف می‌شود', () => {
  const direct = parse('answer 10013 --external-access webiii=write --reason "Q6.1 option 1"');
  const prefixed = parse('node scripts/manager.js answer 10013 --external-access webiii=write --reason "Q6.1 option 1"');
  const winPrefixed = parse('node scripts\\manager.js answer 10013 --external-access webiii=write --reason "Q6.1 option 1"');
  assert.deepEqual(prefixed, direct);
  assert.deepEqual(winPrefixed, direct);
  assert.equal(direct.subcommand, 'answer');
  assert.equal(direct.taskId, '10013');
  assert.deepEqual(resolveArgs(direct, {}), ['answer', '10013', '--external-access', 'webiii=write', '--reason', 'Q6.1 option 1']);
});

test('برنامه‌ی غیر از manager.js رد می‌شود', () => {
  assert.throws(() => parse('node other.js status'), /manager\.js/);
  assert.throws(() => parse('node'), /manager\.js/);
  assert.throws(() => parse('git status'), /مجاز نیست/);
  assert.throws(() => parse('powershell -c calc'), /مجاز نیست/);
});

test('زیرفرمان غیرمجاز یا حالت قدیمی --task رد می‌شود', () => {
  assert.throws(() => parse('rm -rf /'), /مجاز نیست/);
  assert.throws(() => parse('--task 10013'), /زیرفرمان نیست/);
  assert.throws(() => parse(''), /خالی/);
  assert.throws(() => parseConsoleLine('status', { allowed: [], repo: {} }), /مجاز نیست/); // help خوانده نشده → همه چیز بسته
});

test('flagهای مسیر-فایل با جای‌نگهدار جایگزین می‌شوند، مسیر تایپ‌شده دور ریخته می‌شود', () => {
  const parsed = parse('answer 10013 --clarify --file C:\\Windows\\win.ini --respec');
  assert.deepEqual(parsed.attachments, ['--file']);
  assert.deepEqual(resolveArgs(parsed, { '--file': 'X:\\tmp\\a.txt' }), ['answer', '10013', '--clarify', '--file', 'X:\\tmp\\a.txt', '--respec']);
  assert.ok(!displayCommand(parsed).includes('win.ini'));
  assert.match(displayCommand(parsed), /‹متن --file›/);
  // بدون مقدار هم کار می‌کند (کاربر فقط flag را نوشته)
  assert.deepEqual(parse('answer 1 --note --file').attachments, ['--file']);
  assert.deepEqual(parse('answer 1 --reject --reason-file --route architect').attachments, ['--reason-file']);
  assert.deepEqual(parse('import-issue --file x.json').attachments, ['--file']);
});

test('شکل --file=مسیر و تکرار flag رد می‌شود (دور زدن جایگزینی)', () => {
  assert.throws(() => parse('answer 1 --clarify --file=C:\\secret.txt'), /پذیرفته نمی‌شود/);
  assert.throws(() => parse('answer 1 --reject --reason-file=/etc/passwd'), /پذیرفته نمی‌شود/);
  assert.throws(() => parse('answer 1 --clarify --file a --file b'), /بیش از یک بار/);
});

test('run فقط با یک شناسه؛ artifact با traversal رد می‌شود؛ شناسه‌ی مخرب رد می‌شود', () => {
  assert.equal(parse('run 10013').taskId, '10013');
  assert.throws(() => parse('run 10013 --force'), /فقط "run/);
  assert.throws(() => parse('run'), /فقط "run/);
  assert.throws(() => parse('artifact 1 --path ../../secret'), /artifact نامعتبر/);
  assert.throws(() => parse('artifact 1 --path C:\\x\\y'), /artifact نامعتبر/);
  assert.equal(parse('artifact 1 --path attempts/003/changes.diff').readOnly, true);
  assert.throws(() => parse('events ../x'), /شناسه‌ی task/);
});

test('readOnly: status/events/artifact/capabilities بله؛ answer/abandon/run خیر', () => {
  for (const line of ['status --json', 'events 1 --json', 'capabilities --json']) assert.equal(parse(line).readOnly, true, line);
  for (const line of ['answer 1 --approve', 'abandon 1 --reason x', 'run 1', 'unlock 1 --reason x']) assert.equal(parse(line).readOnly, false, line);
});
