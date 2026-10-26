// Manager ساختگی برای تست‌ها: هیچ فرمانی روی مخزن واقعی اجرا نمی‌شود.
// هر فراخوانی (argv کامل + env انتخابی) در calls.jsonl ثبت می‌شود تا تست بتواند
// «manager اصلاً صدا زده نشد» را اثبات کند.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeDirOnCleanup } from './cleanup.js';

export const HELP_FIXTURE = fs.readFileSync(new URL('./fixtures/manager-help.txt', import.meta.url), 'utf8');

/** خروجی --json ِ sync وقتی main برابر origin است (شکل واقعی: runner-sync.js ِ Manager). */
export const DEFAULT_SYNC = {
  code: 0,
  stderr: [],
  result: {
    ok: true, command: 'sync', dryRun: false, action: 'none', branch: 'main', upstream: 'origin/main', aheadBefore: 0, behindBefore: 0,
    merged: false, mergeCommit: null, pushed: false, retried: false, conflicts: [], wouldConflict: null,
    npmCi: { required: false, ran: false, ok: null, timedOut: false }, staleLocks: [], failure: null, exitCode: 0
  }
};

export function makeFakeManagerRepo(t, { status, run, extra = '', statusDelayMs = 0, sync } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-fake-mgr-'));
  removeDirOnCleanup(t, root);
  fs.writeFileSync(path.join(root, 'help.txt'), HELP_FIXTURE, 'utf8');
  fs.writeFileSync(path.join(root, 'runtime-options.json'), fs.readFileSync(new URL('./fixtures/runtime-options.json', import.meta.url), 'utf8'), 'utf8');
  fs.writeFileSync(path.join(root, 'sync.json'), JSON.stringify(sync || DEFAULT_SYNC), 'utf8');
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(status || { schemaVersion: 1, repo: {}, tasks: [] }), 'utf8');
  fs.writeFileSync(path.join(root, 'manager.cjs'), String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = __dirname;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, proxy: process.env.HTTPS_PROXY || null, local: process.env.BARSA_TEST_LOCAL_SECRET || null }) + '\n');
const cmd = args[0];
// fail.json: { "<زیرفرمان>": { code, stderr } } — آن زیرفرمان با همین کد و پیام رد می‌شود (رد مشروع Manager).
try {
  const fail = JSON.parse(fs.readFileSync(path.join(dir, 'fail.json'), 'utf8'))[cmd];
  if (fail) { if (fail.stdout) process.stdout.write(fail.stdout); process.stderr.write(fail.stderr || ''); process.exit(fail.code); }
} catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
const fileArg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
if (cmd === '--help' || cmd === '-h' || !cmd) { process.stdout.write(fs.readFileSync(path.join(dir, 'help.txt'), 'utf8')); }
else if (cmd === 'status') {
  const board = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const only = fileArg('--task');
  if (only !== null) board.tasks = (board.tasks || []).filter(t => String(t.id) === String(only));
  if (args.includes('--summary')) {
    // status <id> --summary: خلاصه‌ی متنی مثل Manager واقعی (یک خط برای هر تسک)
    process.stdout.write((board.tasks || []).map(t => '- ' + t.id + ' [' + t.state + '] ' + (t.title || '')).join('\n') + '\n');
  } else setTimeout(() => process.stdout.write(JSON.stringify(board)), ${statusDelayMs});
}
else if (cmd === 'events') {
  // events.json (اختیاری): آرایه‌ی رویدادها؛ وگرنه []
  try { process.stdout.write(fs.readFileSync(path.join(dir, 'events.json'), 'utf8')); } catch { process.stdout.write('[]'); }
}
else if (cmd === 'artifact') {
  // artifacts.json (اختیاری): { "<مسیر نسبی>": "متن" } — کلید نبود = رد مثل Manager واقعی؛ فایل نبود = متن ثابت قدیمی
  let map = null;
  try { map = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts.json'), 'utf8')); } catch { map = null; }
  if (map === null) process.stdout.write('# artifact');
  else {
    const rel = fileArg('--path');
    if (!Object.prototype.hasOwnProperty.call(map, rel)) { process.stderr.write('artifact پیدا نشد: ' + rel); process.exit(1); }
    process.stdout.write(map[rel]);
  }
}
else if (cmd === 'capabilities') { process.stdout.write(JSON.stringify({contract:'barsa-agent-manager',contractVersion:1,managerVersion:'fake',capabilities:{status:true,taskStatus:true,events:true,artifact:true,run:true,answer:{approve:true,reject:true,clarify:true},importIssue:true}})); }
else if (cmd === 'run') {
  ${run || "console.log('run-ok'); console.log('token=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN || 'none'));"}
}
else if (cmd === 'import-issue') {
  const f = fileArg('--file');
  const issue = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.appendFileSync(path.join(dir, 'imports.jsonl'), JSON.stringify({ args, payload: issue, reasonFile: (() => { const i = args.indexOf('--reason-file'); return i >= 0 && fs.existsSync(args[i + 1]) ? fs.readFileSync(args[i + 1], 'utf8') : null; })() }) + '\n');
  process.stdout.write(JSON.stringify({ ok: true, taskId: String(issue.source?.externalId || '9001') }));
}
else if (cmd === 'runtime') { process.stdout.write(fs.readFileSync(path.join(dir, 'runtime-options.json'), 'utf8')); }
else if (cmd === 'sync') {
  // رفتار sync از sync.json (تست‌ها با setSync عوضش می‌کنند): stderr زنده، JSON روی stdout، exit code دلخواه.
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'sync.json'), 'utf8'));
  for (const line of cfg.stderr || []) process.stderr.write(line + '\n');
  process.stdout.write(JSON.stringify(cfg.result));
  process.exitCode = cfg.code;
}
else if (cmd === 'fail') { process.stderr.write('رد شد توسط manager'); process.exit(3); }
else {
  // answer/abandon/void/...: محتوای فایل‌های --file/--reason-file/... را برای تست ثبت می‌کند
  for (const flag of ['--file', '--reason-file', '--release-note-file']) {
    const f = fileArg(flag);
    if (f && fs.existsSync(f)) fs.appendFileSync(path.join(dir, 'files.jsonl'), JSON.stringify({ flag, text: fs.readFileSync(f, 'utf8') }) + '\n');
  }
  process.stdout.write(JSON.stringify({ ok: true }));
}
${extra}
`, 'utf8');
  const repo = { id: 'fake', path: root, managerScript: 'manager.cjs' };
  const read = file => {
    try { return fs.readFileSync(path.join(root, file), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); }
    catch { return []; }
  };
  return {
    repo,
    root,
    calls: () => read('calls.jsonl'),
    /** فراخوانی‌ها به‌جز --help/status/capabilities که خود کانبان پولینگ می‌کند. */
    mutations: () => read('calls.jsonl').filter(c => !['--help', 'status', 'capabilities', 'events', 'artifact', 'runtime'].includes(c.args[0])),
    files: () => read('files.jsonl'),
    setStatus: value => fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(value), 'utf8'),
    imports: () => read('imports.jsonl'),
    setFail: value => fs.writeFileSync(path.join(root, 'fail.json'), JSON.stringify(value), 'utf8'),
    setSync: value => fs.writeFileSync(path.join(root, 'sync.json'), JSON.stringify(value), 'utf8'),
    setArtifacts: value => fs.writeFileSync(path.join(root, 'artifacts.json'), JSON.stringify(value), 'utf8'),
    setEvents: value => fs.writeFileSync(path.join(root, 'events.json'), JSON.stringify(value), 'utf8')
  };
}

// --- git در تست‌ها: مخزن موقت واقعی (هیچ‌وقت مخزن واقعی) ----------------------------------
import { execFileSync } from 'node:child_process';

const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

export function g(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: { ...CLEAN_ENV, GIT_TERMINAL_PROMPT: '0' }, encoding: 'utf8', windowsHide: true }).trim();
}

export function configureGit(dir) {
  g(dir, 'config', 'user.name', 'Test');
  g(dir, 'config', 'user.email', 'test@example.com');
  g(dir, 'config', 'commit.gpgsign', 'false');
  g(dir, 'config', 'core.autocrlf', 'false');
}

/** فایل‌های ساختگی manager داخل .git/info/exclude تا git status تمیز بماند. */
export function excludeFakeManagerFiles(dir) {
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'calls.jsonl\nfiles.jsonl\nhelp.txt\nstatus.json\nsync.json\nfail.json\nimports.jsonl\nruntime-options.json\nmanager.cjs\nartifacts.json\nevents.json\ngrandchild-*.pid\n');
}

export function initGitRepo(root, { files = { 'README.md': '# test\n' } } = {}) {
  g(root, 'init', '-b', 'main');
  configureGit(root);
  excludeFakeManagerFiles(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  g(root, 'add', '-A');
  g(root, 'commit', '-m', 'init');
}

/**
 * بدنه‌ی `run` برای manager ِ ساختگی که **تا آزاد شدن** زنده می‌ماند (نه با زمان): وقتی فایل ِ `release-<taskId>` یا
 * `release-all` کنار manager.cjs ساخته شود با exit 10 تمام می‌شود. تست ِ «زمان ِ ثابت» (setTimeout(…, 220)) روی ماشین ِ
 * کند یا شلوغ پیش از بررسی ِ تست تمام می‌شد و flaky بود. سقف ِ عمر (۱۲۰ ثانیه) هم هست تا اگر هر چیزی در پاک‌سازی جا ماند، فرزند
 * ِ یتیم برای همیشه زنده نماند. شروع ِ run هم با فایل ِ `started-<taskId>` اعلام می‌شود تا تست روی حالت صبر کند.
 */
export const HELD_RUN = String.raw`
  fs.writeFileSync(path.join(dir, 'started-' + args[1]), String(process.pid));
  console.log('run ' + args[1]);
  const startedAt = Date.now();
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(dir, 'release-' + args[1])) || fs.existsSync(path.join(dir, 'release-all'))) { clearInterval(timer); process.exit(10); }
    if (Date.now() - startedAt > 120000) { console.error('fake run: سقف ِ عمر'); process.exit(11); }
  }, 20);
`;

/** آزاد کردن ِ run های HELD_RUN (taskId یا همه). */
export function releaseHeldRun(root, taskId = 'all') {
  fs.writeFileSync(path.join(root, `release-${taskId}`), '1');
}

export function heldRunStarted(root, taskId) {
  return fs.existsSync(path.join(root, `started-${taskId}`));
}
