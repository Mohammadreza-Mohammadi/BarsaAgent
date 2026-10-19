// Manager ساختگی برای تست‌ها: هیچ فرمانی روی مخزن واقعی اجرا نمی‌شود.
// هر فراخوانی (argv کامل + env انتخابی) در calls.jsonl ثبت می‌شود تا تست بتواند
// «manager اصلاً صدا زده نشد» را اثبات کند.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HELP_FIXTURE = fs.readFileSync(new URL('./fixtures/manager-help.txt', import.meta.url), 'utf8');

export function makeFakeManagerRepo(t, { status, run, extra = '', statusDelayMs = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-fake-mgr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'help.txt'), HELP_FIXTURE, 'utf8');
  fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(status || { schemaVersion: 1, repo: {}, tasks: [] }), 'utf8');
  fs.writeFileSync(path.join(root, 'manager.cjs'), String.raw`
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const dir = __dirname;
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify({ args, token: process.env.CLAUDE_CODE_OAUTH_TOKEN || null, proxy: process.env.HTTPS_PROXY || null, local: process.env.BARSA_TEST_LOCAL_SECRET || null }) + '\n');
const cmd = args[0];
const fileArg = flag => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
if (cmd === '--help' || cmd === '-h' || !cmd) { process.stdout.write(fs.readFileSync(path.join(dir, 'help.txt'), 'utf8')); }
else if (cmd === 'status') {
  const board = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  const only = fileArg('--task');
  if (only !== null) board.tasks = (board.tasks || []).filter(t => String(t.id) === String(only));
  setTimeout(() => process.stdout.write(JSON.stringify(board)), ${statusDelayMs});
}
else if (cmd === 'events') { process.stdout.write('[]'); }
else if (cmd === 'artifact') { process.stdout.write('# artifact'); }
else if (cmd === 'capabilities') { process.stdout.write(JSON.stringify({contract:'barsa-agent-manager',contractVersion:1,managerVersion:'fake',capabilities:{status:true,taskStatus:true,events:true,artifact:true,run:true,answer:{approve:true,reject:true,clarify:true},importIssue:true}})); }
else if (cmd === 'run') {
  ${run || "console.log('run-ok'); console.log('token=' + (process.env.CLAUDE_CODE_OAUTH_TOKEN || 'none'));"}
}
else if (cmd === 'import-issue') {
  const f = fileArg('--file');
  const issue = JSON.parse(fs.readFileSync(f, 'utf8'));
  process.stdout.write(JSON.stringify({ ok: true, taskId: String(issue.source?.externalId || '9001') }));
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
    mutations: () => read('calls.jsonl').filter(c => !['--help', 'status', 'capabilities', 'events', 'artifact'].includes(c.args[0])),
    files: () => read('files.jsonl'),
    setStatus: value => fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify(value), 'utf8')
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
  fs.appendFileSync(path.join(dir, '.git', 'info', 'exclude'), 'calls.jsonl\nfiles.jsonl\nhelp.txt\nstatus.json\nmanager.cjs\ngrandchild-*.pid\n');
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
