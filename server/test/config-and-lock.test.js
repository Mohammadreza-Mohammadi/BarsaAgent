import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseConfigYaml, validateConfig, loadConfig, envLocalCandidates, APP_ROOT } from '../src/config.js';
import { buildAgentEnv } from '../src/agent-env.js';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';

const parse = text => validateConfig(parseConfigYaml(text));

// --- هـ: پارسر config ---------------------------------------------------------------------------------

test('پارسر config: توضیح بعد از مقدار جدا می‌شود (شاهد واقعی سرور)', () => {
  assert.equal(parse('run:\n  proxy: ""   # x\n').run.proxy, '', 'proxy: "" # x یعنی رشته‌ی خالی، نه `"" # x`');
  assert.equal(parse('run:\n  autoStartOnCreate: false   # x\n').run.autoStartOnCreate, false);
  assert.equal(parse("run:\n  proxy: 'http://127.0.0.1:1'   # توضیح فارسی\n").run.proxy, 'http://127.0.0.1:1');
  assert.equal(parse('run:\n  maxConcurrent: 3   # سه\n').run.maxConcurrent, 3);
  // `#` داخل گیومه توضیح نیست؛ بدون فاصله‌ی قبلش هم بخشی از مقدار است
  assert.equal(parse('editor:\n  command: "C:/a # b/Code.exe"\n').editor.command, 'C:/a # b/Code.exe');
});

test('پارسر config: نتیجه‌ی proxy خالی واقعاً «بدون پروکسی» است (HTTP(S)_PROXY به agent نمی‌رسد)', () => {
  const config = parse('run:\n  proxy: ""   # x\n');
  const env = buildAgentEnv(config, { HTTPS_PROXY: 'http://old:1', HTTP_PROXY: 'http://old:1' });
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.HTTP_PROXY, undefined);
});

test('کلیدهای بولی و عددی تایپ‌شان سنجیده می‌شود: رشته در جای بولی = خطای config، نه «درست»', () => {
  assert.throws(() => parse('run:\n  autoStartOnCreate: "no"\n'), /run\.autoStartOnCreate.*رشته‌ی "no".*true یا false/s);
  assert.throws(() => parse('run:\n  autoResumeAfterAnswer: "false"\n'), /autoResumeAfterAnswer/);
  assert.throws(() => parse('auth:\n  secureCookie: "true"\n'), /auth\.secureCookie/);
  assert.throws(() => parse('server:\n  port: "4310"\n'), /server\.port/);
  assert.throws(() => parse('run:\n  maxConcurrent: 0\n'), /run\.maxConcurrent/);
  assert.throws(() => parse('run:\n  maxConcurrent: 2.5\n'), /run\.maxConcurrent/);
  assert.throws(() => parse('board:\n  doneDays: "3"\n'), /board\.doneDays/);
  assert.throws(() => parse('run:\n  proxy: 5\n'), /run\.proxy/);
  // YAML 1.2: no/yes رشته‌اند، نه بولی
  assert.throws(() => parse('run:\n  autoStartOnCreate: no\n'), /autoStartOnCreate/);
  // مقدار درست و کلید ناشناخته دست‌نخورده
  assert.deepEqual(parse('run:\n  autoStartOnCreate: true\n  maxConcurrent: 4\nfuture:\n  x: "y"\n'), { run: { autoStartOnCreate: true, maxConcurrent: 4 }, future: { x: 'y' } });
  // همه‌ی خطاها یک‌جا گزارش می‌شوند
  assert.throws(() => parse('run:\n  autoStartOnCreate: "no"\n  maxConcurrent: "2"\n'), /maxConcurrent/);
});

test('YAML خراب یا کلید تکراری: خطای روشن با شماره‌ی خط', () => {
  assert.throws(() => parseConfigYaml('run: [\n'), /کانفیگ YAML نامعتبر است \(خط/);
  assert.throws(() => parseConfigYaml('run:\n  a: 1\nrun:\n  b: 2\n'), /کانفیگ YAML نامعتبر/);
  assert.deepEqual(parseConfigYaml(''), {});
});

test('فایل config واقعی (همه‌ی کامنت‌های فارسی) درست خوانده می‌شود و تایپ‌هایش معتبر است', () => {
  const text = fs.readFileSync(new URL('../../barsa-agent.config.yml', import.meta.url), 'utf8');
  const config = parse(text);
  assert.equal(config.server.port, 4310);
  assert.equal(config.board.doneDays, 3);
  assert.equal(config.run.maxConcurrent, 2);
  assert.equal(config.run.autoStartOnCreate, true);
  assert.equal(config.run.autoResumeAfterAnswer, true);
  assert.equal(typeof config.board.doneDays, 'number');
  assert.equal(config.repos[0].id, 'barsa-novin-ray');
  assert.equal(config.issueSource.body.UserId, '${BARSA_ISSUE_USER_ID}');
  assert.equal(config.issueSource.mapping.externalId, 'code');
  // هیچ مقداری نباید توضیح انتهای خط را با خود داشته باشد
  const strings = [];
  (function walk(v) { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); })(config);
  assert.deepEqual(strings.filter(s => /\s#\s/.test(s) && !s.includes('Code.exe')), []);
  // نسخه‌ی کامنت‌دار با توضیح فارسی کنار هر کلید
  const annotated = text.replace(/^(\s+)(maxConcurrent|autoStartOnCreate|autoResumeAfterAnswer|doneDays|port): (.+)$/gm, '$1$2: $3   # توضیح فارسی: چرا؟');
  assert.notEqual(annotated, text);
  assert.deepEqual(parse(annotated).run, config.run);
  assert.equal(parse(annotated).board.doneDays, 3);
});

// --- و: .env.local ---------------------------------------------------------------------------------------

test('.env.local: هم کنار فایل config و هم کنار برنامه جستجو می‌شود (config بیرون از مخزن)، کنار config مقدم است', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-envlocal-'));
  try {
    const candidates = envLocalCandidates(path.join(dir, 'barsa-agent.config.yml'));
    assert.deepEqual(candidates.map(c => path.resolve(c)), [path.join(dir, '.env.local'), path.join(APP_ROOT, '.env.local')].map(c => path.resolve(c)));
    // وقتی config کنار برنامه است، یک بار می‌آید
    assert.equal(envLocalCandidates(path.join(APP_ROOT, 'barsa-agent.config.yml')).length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.env.local: متغیر محیطی از پیش تنظیم‌شده (NSSM) بر فایل مقدم است و کلیدهای فایل از env ِ فرزندان حذف می‌شوند', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-envlocal-'));
  const keys = ['BARSA_T_FROM_FILE', 'BARSA_T_FROM_ENV'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  delete process.env.BARSA_T_FROM_FILE;
  process.env.BARSA_T_FROM_ENV = 'from-nssm';
  const file = path.join(root, 'cfg.yml');
  fs.writeFileSync(file, 'repos:\n  - id: fake\n    path: "."\nissueSource:\n  body:\n    A: "${BARSA_T_FROM_FILE}"\n    B: "${BARSA_T_FROM_ENV}"\n', 'utf8');
  fs.writeFileSync(path.join(root, '.env.local'), 'BARSA_T_FROM_FILE=from-file\nBARSA_T_FROM_ENV=from-file-should-lose\n', 'utf8');
  const config = loadConfig(file);
  assert.equal(config.issueSource.body.A, 'from-file');
  assert.equal(config.issueSource.body.B, 'from-nssm', 'env از پیش تنظیم‌شده مقدم است');
  assert.deepEqual(config.localEnvFiles.map(f => path.resolve(f)), [path.resolve(root, '.env.local')]);
  assert.deepEqual([...config.localEnvKeys].sort(), keys.sort());
  const child = buildAgentEnv(config, { BARSA_T_FROM_FILE: 'x', OTHER: 'y' });
  assert.equal(child.BARSA_T_FROM_FILE, undefined);
  assert.equal(child.OTHER, 'y');
});

test('users-cli: با config بیرون از مخزن و ${BARSA_ISSUE_USER_ID} تنظیم‌نشده هم حساب می‌سازد/فهرست می‌کند (به issueSource نیازی ندارد)', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-usercli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const cfg = path.join(root, 'barsa-agent.config.yml');
  fs.writeFileSync(cfg, `repos:\n  - id: fake\n    path: "${root.replace(/\\/g, '/')}/repo"\ndataDir: "${data.replace(/\\/g, '/')}"\nissueSource:\n  body:\n    UserId: "\${BARSA_ISSUE_USER_ID}"\n`, 'utf8');
  const env = { ...process.env, BARSA_AGENT_CONFIG: cfg, BARSA_AGENT_PASSWORD: 'correct-horse-battery' };
  delete env.BARSA_ISSUE_USER_ID;
  const cli = path.join(APP_ROOT, 'server', 'src', 'users-cli.js');
  const add = spawnSync(process.execPath, [cli, 'add', 'ali'], { env, encoding: 'utf8', cwd: root });
  assert.equal(add.status, 0, add.stderr);
  const list = spawnSync(process.execPath, [cli, 'list'], { env, encoding: 'utf8', cwd: root });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /ali/);
});

// --- ج: قفل اجرا ---------------------------------------------------------------------------------------

const EXECUTION_OFF = {
  enabled: false, source: 'local',
  reason: 'اجرای تسک روی این دستگاه خاموش است: execution.enabled=false در repository.local.yaml'
};
const statusWith = execution => ({ schemaVersion: 1, repo: { head: 'd'.repeat(40) }, tasks: [], repository: { health: { managerLock: null, unownedDirtyFiles: [], acceptsOperations: true }, execution } });
const post = (base, p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

async function boot(t, execution) {
  const fake = makeFakeManagerRepo(t, { status: statusWith(execution) });
  const { base } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {} });
  return { fake, base, ran: () => fake.calls().some(c => ['run', 'import-issue', 'answer', 'rebase'].includes(c.args[0])) };
}

test('execution.enabled=false: run، ساخت task، import ِ issue، retry-rebase و run ِ کنسول با پیام Manager رد می‌شوند و هیچ فرمان نوشتنی صدا زده نمی‌شود', async t => {
  const s = await boot(t, EXECUTION_OFF);
  const display = (await (await post(s.base, '/api/console/parse', { repo: 'fake', line: 'run 5' })).json()).display;
  for (const [p, body] of [
    ['/api/repos/fake/tasks/5/run'],
    ['/api/tasks/create', { items: [{ repo: 'fake', type: 'task', slug: 'x', requestText: 'متن' }] }],
    ['/api/issues/import', { ids: ['1'] }],
    ['/api/repos/fake/tasks/5/retry-rebase', { reason: 'r' }],
    ['/api/console/exec', { repo: 'fake', line: 'run 5', confirmedCommand: display }]
  ]) {
    const response = await post(s.base, p, body);
    assert.equal(response.status, 409, `${p} → ${response.status}`);
    assert.match((await response.json()).error, /اجرای تسک روی این دستگاه خاموش است.*execution\.enabled=false/, p);
  }
  assert.equal(s.ran(), false, 'Manager حتی صدا زده نشد');
});

test('execution.enabled=false: board همان بلوک را به UI می‌دهد (نوار ثابت فقط از اینجا می‌آید)', async t => {
  const s = await boot(t, EXECUTION_OFF);
  const board = await (await authedFetch(`${s.base}/api/repos/fake/board`)).json();
  assert.equal(board.repository.execution.enabled, false);
  assert.match(board.repository.execution.reason, /خاموش است/);
});

test('execution روشن یا غایب (Manager قدیمی): هیچ قفلی از طرف کانبان نیست', async t => {
  for (const execution of [{ enabled: true, source: 'default', reason: null }, undefined]) {
    const s = await boot(t, execution);
    const response = await post(s.base, '/api/repos/fake/tasks/5/run');
    assert.equal(response.status, 202, await response.clone().text());
    // صبر تا اجرای ساختگی تمام شود (پاک‌سازی پوشه‌ی موقت روی ویندوز با فرآیند زنده EPERM می‌دهد)
    for (let i = 0; i < 100; i += 1) {
      const running = await (await authedFetch(`${s.base}/api/repos/fake/running`)).json();
      if (running.length && running.every(r => !r.running && !r.queued)) break;
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

test('client: نوار قفل، غیرفعال شدن دکمه‌های بیرون از actions، و sync که فعال می‌ماند', () => {
  const read = name => fs.readFileSync(new URL(`../../client/src/app/${name}`, import.meta.url), 'utf8');
  const html = read('app.component.html');
  assert.match(html, /class="execution-bar"[^>]*\*ngIf="executionDisabled\(\)"/);
  assert.match(html, /اجرای تسک روی این دستگاه خاموش است \(execution\.enabled=false\)/);
  // هر دکمه‌ای که task می‌سازد/اجرا می‌کند و از actions نیست
  for (const handler of ['openManualTask()', 'prepareSelectedIssues()', 'createTasks()', 'rebaseTask()', 'runTask()']) {
    const button = html.split('\n').find(line => line.includes(`(click)="${handler}"`) || line.includes(`(click)="cmd === 'run' ? runTask()`));
    assert.ok(button, handler);
    assert.match(button, /executionDisabled\(\)/, `${handler} باید با قفل غیرفعال شود`);
  }
  const ts = read('app.component.ts');
  assert.match(ts, /repository\?\.execution\?\.enabled === false/);
  assert.match(ts, /41: /, 'exit 41 برچسب فارسی دارد، نه «خطای اجرایی ناشناخته»');
  // sync به قفل وابسته نیست
  const maintenance = read('maintenance.component.ts');
  assert.doesNotMatch(maintenance, /executionDisabled|execution\.enabled/);
  assert.match(maintenance, /\[disabled\]="busy\(\) \|\| syncRunning\(\)" \(click\)="askUpdate\(\)"/);
});
