import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';
import { RemoteTokenStore } from '../src/remote-tokens.js';
import { run as barsa, parseArgs, HELP } from '../src/remote-cli.js';
import {
  READ_COMMANDS, WRITE_COMMANDS, READ_FORMS, NOT_REMOTE_COMMANDS, NOT_REMOTE_ANSWER_FLAGS, REMOTE_ENDPOINTS, COMMAND_ENDPOINTS, EXIT, isRemoteAllowed, matchRoute
} from '../src/remote-cli-spec.js';
import { evaluate } from '../../docs/remote-control/guard.mjs';

const ROOT = new URL('../../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');

// --- داده‌ی نمونه ------------------------------------------------------------------------------------------

const NO_ACTIONS = {
  approve: false, reject: false, clarify: false, note: false, unblock: false, raiseLimit: [], closeOrphan: [], allowPath: false,
  allowSharedKnowledgeFile: false, externalAccess: [], resetExternal: [], cancel: false, abandon: false, void: false, unlock: false
};
const STATUS = {
  schemaVersion: 1, generatedAt: '2026-10-21T09:00:00Z', repo: { head: 'e'.repeat(40) },
  repository: {
    health: { managerLock: null, unownedDirtyFiles: [], acceptsOperations: true },
    execution: { enabled: true, source: 'default', reason: null },
    localConfig: { path: '.agent-work/config/repository.local.yaml', present: false, applied: false, keys: [] },
    sync: { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, lastFetchAt: '2026-10-21T08:00:00Z' }
  },
  tasks: [
    {
      id: '7', title: 'تسک منتظر تأیید', state: 'spec-review', stateSince: '2026-10-21T08:10:00Z',
      awaitingHuman: { kind: 'spec-approval', since: '2026-10-21T08:10:00Z' }, blocker: null,
      actions: { ...NO_ACTIONS, approve: true, reject: true, clarify: true, note: true },
      review: { decision: 'approved', evidenceStatus: 'ok', problems: [], evidence: { acceptance: [{ ac: 'AC-1', verdict: 'pass', basis: 'x' }, { ac: 'AC-2', verdict: 'fail', basis: 'y' }], testCoverage: [], additionalChecks: [] } },
      releaseNote: { userVisible: true, headline: 'تیتر release', body: 'بدنه\nدو خطی', approvedByHuman: false },
      diff: { headCommit: 'abc', files: [{ path: 'a/b.ts', added: 10, deleted: 2, status: 'modified', inScope: true }, { path: 'c.ts', added: 1, deleted: 0, status: 'added', inScope: false }] },
      externalSources: [{ id: 'webiii', access: 'write', delivery: 'apply', staged: { sha: '1234567890abcdef', at: null, mode: 'apply', bundle: null }, checkedIn: null, actions: { canStageExternal: true, canMarkCheckedIn: false } }],
      budget: { implementerRuns: { used: 1, max: 3 } }
    },
    {
      id: '8', title: 'تسک blocked', state: 'blocked', stateSince: '2026-10-21T07:00:00Z', awaitingHuman: null,
      blocker: { kind: 'budget-exhausted', field: 'implementerRuns', detail: 'سقف implementerRuns پر شد.' },
      actions: { ...NO_ACTIONS, unblock: true, note: true, raiseLimit: ['implementerRuns', 'maxAttempts'] },
      budget: { implementerRuns: { used: 3, max: 3 } }
    },
    { id: '9', title: 'تسک در حال کار', state: 'implementing', stateSince: '2026-10-21T06:00:00Z', awaitingHuman: null, blocker: null, source: { externalId: '3953' }, actions: { ...NO_ACTIONS } },
    { id: '10', title: 'تسک تمام', state: 'integrated', stateSince: '2026-10-20T06:00:00Z', awaitingHuman: null, blocker: null, actions: { ...NO_ACTIONS } }
  ]
};
const ISSUES = [
  { externalId: '3952', title: 'Issue A', body: 'متن', status: 'open', labels: ['x'] },
  { externalId: '3953', title: 'Issue B', body: 'متن', status: 'open' }
];
const OK_CLAUDE = { command: process.execPath, versionArgs: ['--version'], authArgs: ['--version'] };

async function boot(t, { status = STATUS, run, deps = {}, config = {} } = {}) {
  const fake = makeFakeManagerRepo(t, { status, run });
  const addr = { value: '127.0.0.1' };
  const { base, config: cfg } = await startAuthedServer(
    t,
    { repos: [fake.repo], server: {}, issueSource: {}, run: { proxy: '' }, health: { claude: OK_CLAUDE, proxyTestUrl: 'http://127.0.0.1:9/' }, ...config },
    { remoteAddress: () => addr.value, issueFetcher: async () => ISSUES, ...deps }
  );
  const store = new RemoteTokenStore(cfg.dataDir);
  store.create('remote-phone');
  const tokenFile = path.join(cfg.dataDir, 'tokens', 'remote-phone.token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const audit = () => new AuditLog({ dir: cfg.dataDir });
  const outputs = [];
  const cli = async (args, { stdin = '', env = {} } = {}) => {
    let out = '';
    let err = '';
    const code = await barsa(args, {
      env: { BARSA_REMOTE_URL: base, BARSA_REMOTE_TOKEN_FILE: tokenFile, ...env },
      stdout: text => { out += text; }, stderr: text => { err += text; }, stdin: Readable.from([Buffer.from(stdin, 'utf8')])
    });
    outputs.push(out, err);
    assert.ok(!out.includes(token) && !err.includes(token), 'توکن هرگز در خروجی CLI نمی‌آید');
    return { code, out, err, json: () => JSON.parse(out) };
  };
  const waitIdle = async () => {
    for (let i = 0; i < 100; i += 1) {
      const running = await (await fetch(`${base}/api/repos/fake/running`, { headers: { Authorization: `Bearer ${token}` } })).json();
      if (running.every(r => !r.running && !r.queued)) return;
      await new Promise(r => setTimeout(r, 50));
    }
  };
  // نکته: t.after به ترتیب ثبت اجرا می‌شود (پاک‌سازی پوشه و بستن سرور پیش از آن)، پس تست‌هایی که اجرا شروع می‌کنند خودشان
  // در آخر `await s.waitIdle()` می‌زنند تا فرآیند فرزند روی ویندوز پوشه‌ی موقت را قفل نگه ندارد.
  return { fake, base, cfg, store, token, tokenFile, addr, audit, cli, waitIdle, outputs };
}

const bearer = token => ({ Authorization: `Bearer ${token}` });
const jsonPost = (base, p, token, body) => fetch(`${base}${p}`, { method: 'POST', headers: { ...bearer(token), 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

// --- الف: توکن -------------------------------------------------------------------------------------------------

test('توکن: ۳۲ بایت تصادفی، فقط hash روی دیسک، خود توکن فقط در فایل (چاپ نمی‌شود)، باطل‌سازی', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-tokens-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new RemoteTokenStore(dir);
  const created = store.create('remote-phone');
  assert.equal(created.file, path.join(dir, 'tokens', 'remote-phone.token'));
  const token = fs.readFileSync(created.file, 'utf8').trim();
  assert.ok(Buffer.from(token, 'base64url').length >= 32, 'دست‌کم ۳۲ بایت');
  assert.equal(Object.keys(created).includes('token'), false, 'مقدار برگشتی توکن ندارد');
  const disk = fs.readFileSync(path.join(dir, 'remote-tokens.json'), 'utf8');
  assert.ok(!disk.includes(token), 'توکن خام روی دیسک (جز فایل توکن) نیست');
  assert.match(JSON.parse(disk).tokens['remote-phone'].hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(store.verify(token), { name: 'remote-phone' });
  assert.deepEqual(store.verify(`${token}x`), { rejected: 'unknown' });
  assert.deepEqual(store.verify(''), { rejected: 'unknown' });
  assert.throws(() => store.create('remote-phone'), /از قبل فعال/);
  assert.throws(() => store.create('../x'), /نام توکن/);
  assert.equal(store.list()[0].active, true);

  assert.equal(store.revoke('remote-phone').revoked, true);
  assert.deepEqual(store.verify(token), { rejected: 'revoked' });
  assert.equal(fs.existsSync(created.file), false, 'فایل توکن پاک می‌شود');
  assert.equal(store.revoke('remote-phone').revoked, false);
  assert.equal(store.revoke('nope').revoked, false);
  assert.equal(store.list()[0].active, false);
  // بعد از باطل شدن می‌شود دوباره ساخت (توکن تازه، hash ِ تازه)
  store.create('remote-phone');
  assert.equal(store.list().find(x => x.name === 'remote-phone').active, true);
});

test('token:create / list / revoke از خط فرمان: توکن چاپ نمی‌شود', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-tokencli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cfg = path.join(root, 'barsa-agent.config.yml');
  const data = path.join(root, 'data');
  fs.writeFileSync(cfg, `repos:\n  - id: fake\n    path: "${root.replace(/\\/g, '/')}/repo"\ndataDir: "${data.replace(/\\/g, '/')}"\nissueSource:\n  body:\n    UserId: "\${BARSA_ISSUE_USER_ID}"\n`, 'utf8');
  const env = { ...process.env, BARSA_AGENT_CONFIG: cfg };
  delete env.BARSA_ISSUE_USER_ID;
  const cli = new URL('../src/tokens-cli.js', import.meta.url);
  const exec = (...args) => spawnSync(process.execPath, [cli.pathname.replace(/^\/([A-Za-z]:)/, '$1'), ...args], { env, encoding: 'utf8', cwd: root });
  const created = exec('create', 'remote-phone');
  assert.equal(created.status, 0, created.stderr);
  const file = path.join(data, 'tokens', 'remote-phone.token');
  assert.ok(fs.existsSync(file));
  const token = fs.readFileSync(file, 'utf8').trim();
  assert.ok(!created.stdout.includes(token) && !created.stderr.includes(token));
  assert.match(created.stdout, /remote-phone\.token/);
  assert.match(exec('list').stdout, /remote-phone\tفعال/);
  assert.equal(exec('create', 'remote-phone').status, 1, 'ساخت دوباره‌ی فعال = خطا');
  const revoked = exec('revoke', 'remote-phone');
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(exec('list').stdout, /باطل‌شده/);
  assert.equal(exec('revoke', 'remote-phone').status, 1);
});

// --- الف: سرور ---------------------------------------------------------------------------------------------------

test('سرور: توکن از loopback پذیرفته می‌شود، بدون CSRF؛ actor = remote:<name> در نشست و دفتر ممیزی', async t => {
  const s = await boot(t);
  const session = await (await fetch(`${s.base}/api/auth/session`, { headers: bearer(s.token) })).json();
  assert.deepEqual(session, { authenticated: true, user: 'remote:remote-phone', csrf: null, remote: true });
  const response = await jsonPost(s.base, '/api/repos/fake/tasks/7/note', s.token, { text: 'یادداشت' });
  assert.equal(response.status, 200, await response.clone().text());
  const note = s.audit().summaries({ action: 'note' })[0];
  assert.equal(note.user, 'remote:remote-phone');
  assert.equal(note.status, 'ok');
  assert.deepEqual(s.fake.mutations().map(c => c.args.slice(0, 3)), [['answer', '7', '--note']]);
  assert.ok(!fs.readFileSync(path.join(s.cfg.dataDir, 'audit.jsonl'), 'utf8').includes(s.token), 'توکن در دفتر ممیزی نیست');
});

test('سرور: از آدرس غیر-loopback (حتی با توکن درست) و از پشت proxy رد می‌شود، با ردیف ممیزی', async t => {
  const s = await boot(t);
  s.addr.value = '203.0.113.5';
  const remote = await fetch(`${s.base}/api/auth/session`, { headers: bearer(s.token) });
  assert.equal(remote.status, 403);
  s.addr.value = '::ffff:203.0.113.5';
  assert.equal((await fetch(`${s.base}/api/repos`, { headers: bearer(s.token) })).status, 403);
  s.addr.value = '::ffff:127.0.0.1';
  assert.equal((await fetch(`${s.base}/api/repos`, { headers: bearer(s.token) })).status, 200, 'IPv4-mapped loopback');
  s.addr.value = '::1';
  assert.equal((await fetch(`${s.base}/api/repos`, { headers: bearer(s.token) })).status, 200);
  s.addr.value = '127.0.0.1';
  const proxied = await fetch(`${s.base}/api/repos`, { headers: { ...bearer(s.token), 'X-Forwarded-For': '198.51.100.7' } });
  assert.equal(proxied.status, 403, 'درخواستی که از proxy گذشته loopback حساب نمی‌شود');
  const rows = s.audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'auth.token');
  assert.equal(rows.length, 3);
  assert.match(rows[0].reason, /غیر-loopback/);
  assert.equal(rows[0].ip, '203.0.113.5');
  assert.match(rows[2].reason, /proxy/);
});

test('سرور: توکن ناشناخته/باطل‌شده/خراب = 401 + ردیف ممیزی؛ باطل‌سازی بدون ری‌استارت فوری است', async t => {
  const s = await boot(t);
  for (const headers of [bearer('x'.repeat(43)), { Authorization: 'Basic abc' }, { Authorization: 'Bearer' }, bearer('')]) {
    const response = await fetch(`${s.base}/api/repos`, { headers });
    assert.equal(response.status, 401, JSON.stringify(headers));
  }
  const rejected = s.audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'auth.token');
  assert.equal(rejected.length, 4);
  assert.ok(rejected.every(r => /توکن remote رد شد/.test(r.reason)));

  s.store.create('temp');
  const temp = fs.readFileSync(s.store.tokenFile('temp'), 'utf8').trim();
  assert.equal((await fetch(`${s.base}/api/repos`, { headers: bearer(temp) })).status, 200);
  s.store.revoke('temp'); // فرآیند جدا/CLI: همین سرور در حال اجرا است
  assert.equal((await fetch(`${s.base}/api/repos`, { headers: bearer(temp) })).status, 401);
  const last = s.audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'auth.token').at(-1);
  assert.match(last.reason, /revoked/);
  assert.equal((await fetch(`${s.base}/api/repos`, { headers: bearer(s.token) })).status, 200, 'توکن دیگر دست‌نخورده');
});

test('سرور: توکن remote فقط endpointهای فهرست مجاز را می‌زند؛ abandon/console/audit/login/external-access رد می‌شود', async t => {
  const s = await boot(t);
  const before = s.fake.mutations().length;
  for (const [method, p, body] of [
    ['POST', '/api/repos/fake/tasks/7/abandon', { reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/7/void', { reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/7/unlock', { reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/7/cancel', { reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/7/allow-path', { path: 'a', reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/7/external-access', { sourceId: 'webiii', access: 'write', reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/7/stage-external', { sourceId: 'webiii' }],
    ['POST', '/api/repos/fake/tasks/7/retry-rebase', {}],
    ['POST', '/api/repos/fake/manager/update', {}],
    ['POST', '/api/console/exec', { repo: 'fake', line: 'status', confirmedCommand: 'status' }],
    ['POST', '/api/auth/login', { username: 'a', password: 'b' }],
    ['GET', '/api/audit', undefined],
    ['GET', '/api/execs', undefined],
    ['GET', '/api/repos/fake/board', undefined]
  ]) {
    const response = await fetch(`${s.base}${p}`, { method, headers: { ...bearer(s.token), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 403, `${method} ${p}`);
  }
  assert.equal(s.fake.mutations().length, before, 'هیچ فرمان Manager صدا زده نشد');
  const denied = await jsonPost(s.base, '/api/repos/fake/tasks/7/answer', s.token, { mode: 'clarify', text: 'x', externalAccess: { sourceId: 'webiii', access: 'write' } });
  assert.equal(denied.status, 403);
  assert.match((await denied.json()).error, /external-access/);
  const created = await jsonPost(s.base, '/api/tasks/create', s.token, { items: [{ repo: 'fake', requestText: 'x', externalAccess: [{ sourceId: 'webiii', access: 'write' }] }] });
  assert.equal(created.status, 403);
  assert.equal(s.fake.mutations().length, before);
  assert.ok(s.audit().readAll().some(r => r.phase === 'rejected' && r.action === 'auth.token' && r.user === 'remote:remote-phone' && /مجاز نیست/.test(r.reason)));
});

test('فهرست مجاز endpoint: ثابت و مطابق COMMAND_ENDPOINTS؛ الگوها درست تطبیق می‌خورند', () => {
  for (const [command, endpoints] of Object.entries(COMMAND_ENDPOINTS)) {
    for (const [method, pattern] of endpoints) {
      assert.ok(REMOTE_ENDPOINTS.some(([m, p]) => m === method && p === pattern), `${command}: ${method} ${pattern}`);
    }
  }
  assert.equal(matchRoute('/api/repos/:repo/tasks/:id', '/api/repos/x/tasks/5'), true);
  assert.equal(matchRoute('/api/repos/:repo/tasks/:id', '/api/repos/x/tasks/5/run'), false);
  assert.equal(isRemoteAllowed('GET', '/api/repos/fake/tasks/5'), true);
  assert.equal(isRemoteAllowed('DELETE', '/api/repos/fake/tasks/5'), false);
  assert.equal(isRemoteAllowed('POST', '/api/repos/fake/tasks/5/abandon'), false);
  assert.equal(isRemoteAllowed('GET', '/api/repos/fake/board'), false);
});

// --- ب: فرمان‌های خواندنی ---------------------------------------------------------------------------------------------

test('health: اجرا، sync و claude؛ متن کوتاه و --json با شکل ثابت', async t => {
  const s = await boot(t);
  const text = await s.cli(['health']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /اجرا: روشن/);
  assert.match(text.out, /sync: 1 جلوتر · 2 عقب‌تر · آخرین fetch 2026-10-21 08:00/);
  assert.match(text.out, /claude: نصب ✓ · ورود: ✓/);
  const json = (await s.cli(['health', '--json'])).json();
  assert.deepEqual(Object.keys(json).sort(), ['checkedAt', 'claude', 'execution', 'ok', 'problems', 'sync']);
  assert.equal(json.execution.enabled, true);
  assert.deepEqual({ ahead: json.sync.ahead, behind: json.sync.behind }, { ahead: 1, behind: 2 });
  assert.deepEqual(json.claude, { installed: true, auth: true });

  s.fake.setStatus({ ...STATUS, repository: { ...STATUS.repository, execution: { enabled: false, source: 'local', reason: 'خاموش' } } });
  const off = await s.cli(['health']);
  assert.match(off.out, /اجرا: ⛔ خاموش/);
});

test('issues: پیش‌فرض فقط بدون تسک؛ --all همه با تسک متناظر؛ --json', async t => {
  const s = await boot(t);
  const text = await s.cli(['issues']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /#3952 · Issue A \(open\)/);
  assert.doesNotMatch(text.out, /#3953/);
  assert.match(text.out, /1 تای دیگر قبلاً تسک شده/);
  const all = await s.cli(['issues', '--all']);
  assert.match(all.out, /#3953 · Issue B.*→ تسک #9/);
  const json = (await s.cli(['issues', '--json'])).json();
  assert.deepEqual(json.issues.map(i => i.externalId), ['3952']);
  assert.equal(json.hiddenImported, 1);
  assert.deepEqual((await s.cli(['issues', '--all', '--json'])).json().issues.map(i => [i.externalId, i.importedTaskId]), [['3952', null], ['3953', '9']]);
});

test('tasks: فیلترهای waiting/blocked/running/all و پیش‌فرض جاری', async t => {
  const s = await boot(t);
  const active = (await s.cli(['tasks', '--json'])).json();
  assert.deepEqual(active.tasks.map(x => x.id).sort(), ['7', '8', '9'], 'پایان‌یافته در پیش‌فرض نیست');
  assert.equal(active.execution.enabled, true);
  assert.deepEqual((await s.cli(['tasks', '--waiting', '--json'])).json().tasks.map(x => x.id), ['7']);
  assert.deepEqual((await s.cli(['tasks', '--blocked', '--json'])).json().tasks.map(x => x.id), ['8']);
  assert.deepEqual((await s.cli(['tasks', '--running', '--json'])).json().tasks, []);
  assert.deepEqual((await s.cli(['tasks', '--all', '--json'])).json().tasks.map(x => x.id).sort(), ['10', '7', '8', '9']);
  const waiting = (await s.cli(['tasks', '--waiting'])).out;
  assert.match(waiting, /#7 · منتظر spec-approval · تسک منتظر تأیید/);
  const task7 = (await s.cli(['tasks', '--waiting', '--json'])).json().tasks[0];
  assert.deepEqual(task7.actions.sort(), ['approve', 'clarify', 'note', 'reject']);
  assert.equal((await s.cli(['tasks', '--bad'])).code, EXIT.USAGE);
});

test('task <id>: وضعیت، actions، blocker، بازبینی، release note، diff، منبع بیرونی، budget', async t => {
  const s = await boot(t);
  const text = await s.cli(['task', '7']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /#7 · تسک منتظر تأیید/);
  assert.match(text.out, /منتظر spec-approval/);
  assert.match(text.out, /اکشن‌های مجاز: approve، reject، clarify، note/);
  assert.match(text.out, /بازبینی: approved · AC-1:pass AC-2:fail/);
  assert.match(text.out, /release note: تیتر release/);
  assert.match(text.out, /diff: 2 فایل \(\+11 −2\)/);
  assert.match(text.out, /c\.ts.*خارج scope/);
  assert.match(text.out, /منبع بیرونی webiii \(write\/apply\): staged=12345678 apply/);
  assert.match(text.out, /budget: implementerRuns 1\/3/);
  const blocked = await s.cli(['task', '8']);
  assert.match(blocked.out, /blocker: budget-exhausted — سقف implementerRuns پر شد/);
  assert.match(blocked.out, /raiseLimit\[implementerRuns,maxAttempts\]/);
  const json = (await s.cli(['task', '7', '--json'])).json();
  assert.deepEqual(Object.keys(json), ['id', 'title', 'state', 'stateSince', 'gate', 'running', 'actions', 'blocker', 'health', 'review', 'releaseNote', 'diff', 'externalSources', 'budget', 'runtime', 'attempts', 'waiting']);
  assert.equal(json.actions.approve, true);
  assert.equal((await s.cli(['task', '999'])).code, EXIT.REJECTED, 'تسک ناموجود = رد');
  assert.equal((await s.cli(['task'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['task', '../x'])).code, EXIT.USAGE);
});

test('waiting --since: فقط گیت‌های تازه‌تر؛ generatedAt برای بررسی بعدی؛ از کش ِ status (یک status برای چند بار)', async t => {
  const s = await boot(t);
  const statusCalls = () => s.fake.calls().filter(c => c.args[0] === 'status').length;
  const none = await s.cli(['waiting', '--since', '2026-10-21T08:30:00Z']);
  assert.equal(none.code, 0, none.err);
  assert.match(none.out, /چیز تازه‌ای منتظر تو نیست/);
  assert.match(none.out, /--since 2026-10-21T09:00:00Z/);
  const some = (await s.cli(['waiting', '--since', '2026-10-21T07:00:00Z', '--json'])).json();
  assert.deepEqual(some.tasks.map(x => [x.id, x.gate.kind]), [['7', 'spec-approval']]);
  assert.equal(some.generatedAt, '2026-10-21T09:00:00Z');
  const before = statusCalls();
  for (let i = 0; i < 5; i += 1) await s.cli(['waiting', '--since', '2026-10-21T07:00:00Z']);
  assert.equal(statusCalls(), before, 'کش: بدون status ِ تازه در هر بار');
  assert.equal((await s.cli(['waiting', '--since', 'دیروز'])).code, EXIT.USAGE);
});

test('log: انتهای لاگ آخرین اجرا (--tail)، و برای تسک بدون اجرا پیام روشن', async t => {
  const s = await boot(t);
  assert.match((await s.cli(['log', '9'])).out, /هنوز اجرایی/);
  assert.equal((await s.cli(['run', '9'])).code, 0);
  await s.waitIdle();
  const full = await s.cli(['log', '9']);
  assert.equal(full.code, 0, full.err);
  assert.match(full.out, /اجرای .* · تمام شد \(exit 0\)/);
  assert.match(full.out, /run-ok/);
  const tail = (await s.cli(['log', '9', '--tail', '1', '--json'])).json();
  assert.equal(tail.lines.length, 1);
  assert.equal(tail.truncated, true);
  assert.equal((await s.cli(['log', '9', '--tail', '0'])).code, EXIT.USAGE);
  // بعد از دور ریخته شدن registry ِ زنده (سرور تازه) از فایل دفتر ممیزی خوانده می‌شود: همان مسیر فایل
  const fromFile = s.audit().summaries({ action: 'run', taskId: '9' })[0];
  assert.ok(fs.existsSync(fromFile.outputFile));
});

// --- ب: فرمان‌های نوشتنی --------------------------------------------------------------------------------------------------

test('اکشن غیرمجاز: exit 3، فهرست اکشن‌های مجاز، و هیچ درخواست نوشتنی فرستاده نمی‌شود', async t => {
  const s = await boot(t);
  const before = s.fake.mutations().length;
  const approve = await s.cli(['answer', '9', '--approve']);
  assert.equal(approve.code, EXIT.NOT_ALLOWED);
  assert.match(approve.err, /اکشن «approve» برای این تسک الان مجاز نیست/);
  assert.match(approve.err, /اکشن‌های مجاز: هیچ/);
  const unblock = await s.cli(['answer', '7', '--unblock', '--stdin'], { stdin: 'reason' });
  assert.equal(unblock.code, EXIT.NOT_ALLOWED);
  assert.match(unblock.err, /approve، reject، clarify، note/);
  const raise = await s.cli(['answer', '8', '--raise-limit', 'maxSpecRevisions=9', '--stdin'], { stdin: 'because' });
  assert.equal(raise.code, EXIT.NOT_ALLOWED);
  assert.match(raise.err, /فیلدهای قابل بالا بردن: implementerRuns، maxAttempts/);
  const json = await s.cli(['answer', '9', '--note', '--stdin', '--json'], { stdin: 'x' });
  assert.deepEqual({ ok: json.json().ok, exitCode: json.json().exitCode }, { ok: false, exitCode: 3 });
  const finished = await s.cli(['run', '10']);
  assert.equal(finished.code, EXIT.NOT_ALLOWED);
  assert.match(finished.err, /پایان‌یافته/);
  assert.equal(s.fake.mutations().length, before, 'هیچ فرمان Manager و هیچ درخواست نوشتنی نبود');
  assert.equal(s.audit().readAll().filter(r => r.phase === 'start' && r.user === 'remote:remote-phone').length, 0);
});

test('answer: هر حالت آرگومان دقیق Manager را می‌سازد و با actor remote ممیزی می‌شود', async t => {
  const s = await boot(t);
  const reason = 'English reason';
  assert.equal((await s.cli(['answer', '7', '--approve'])).code, 0);
  assert.equal((await s.cli(['answer', '7', '--reject', '--route', 'architect', '--stdin'], { stdin: reason })).code, 0);
  assert.equal((await s.cli(['answer', '7', '--clarify', '--stdin'], { stdin: 'پاسخ' })).code, 0);
  assert.equal((await s.cli(['answer', '7', '--note', '--stdin'], { stdin: 'یادداشت' })).code, 0);
  assert.equal((await s.cli(['answer', '8', '--raise-limit', 'implementerRuns=5', '--stdin'], { stdin: reason })).code, 0);
  assert.equal((await s.cli(['answer', '8', '--unblock', '--stdin'], { stdin: reason })).code, 0);
  await s.waitIdle();
  const shape = args => args.map((a, i) => (args[i - 1] && /^--(file|reason-file|release-note-file)$/.test(args[i - 1]) ? '<file>' : a));
  const answers = s.fake.mutations().map(c => shape(c.args)).filter(a => a[0] === 'answer');
  assert.deepEqual(answers, [
    ['answer', '7', '--approve'],
    ['answer', '7', '--reject', '--reason-file', '<file>', '--route', 'architect'],
    ['answer', '7', '--clarify', '--file', '<file>'],
    ['answer', '7', '--note', '--file', '<file>'],
    ['answer', '8', '--raise-limit', 'implementerRuns=5', '--reason-file', '<file>'],
    ['answer', '8', '--unblock', '--reason-file', '<file>']
  ]);
  const users = new Set(s.audit().summaries({ action: 'answer' }).map(x => x.user).concat(s.audit().summaries({ action: 'note' }).map(x => x.user)));
  assert.deepEqual([...users], ['remote:remote-phone']);
  // ادامه‌ی خودکار بعد از approve/reject/clarify (همان مسیر دکمه‌ها): run در registry
  assert.ok(s.fake.calls().filter(c => c.args[0] === 'run').length >= 1, 'autoResumeAfterAnswer');
  // raise-limit و unblock ادامه‌ی خودکار ندارند
  const out = await s.cli(['answer', '8', '--unblock', '--stdin'], { stdin: reason });
  assert.match(out.out, /اجرا خودکار نیست/);
});

test('متن فارسی چندخطی با backslash، کوتیشن و $ از --stdin و --text-file سالم می‌رسد (فایل UTF-8 ِ سرور)', async t => {
  const s = await boot(t);
  const text = 'سلام دنیا\nخط دوم با \\ backslash و "کوتیشن" و \'تک\' و $HOME و `tick` و $(x)\n\nخط آخر ✓';
  assert.equal((await s.cli(['answer', '7', '--note', '--stdin'], { stdin: `${text}\n\n` })).code, 0);
  const file = path.join(s.cfg.dataDir, 'in.txt');
  fs.writeFileSync(file, `\uFEFF${text}\r\n`.replace(/\n/g, '\r\n'), 'utf8');
  assert.equal((await s.cli(['answer', '7', '--clarify', '--text-file', file])).code, 0);
  await s.waitIdle();
  const stored = s.fake.files().map(f => f.text);
  assert.equal(stored[0], text);
  assert.equal(stored[1].replace(/\r\n/g, '\n'), text);
  assert.equal((await s.cli(['answer', '7', '--note', '--stdin'], { stdin: '   \n' })).code, EXIT.USAGE, 'متن خالی');
  assert.equal((await s.cli(['answer', '7', '--note'])).code, EXIT.USAGE, 'بدون متن');
  assert.equal((await s.cli(['answer', '7', '--note', '--stdin', '--text-file', file])).code, EXIT.USAGE);
});

test('خطای Manager عیناً با exit 6؛ کد 41 عبور داده می‌شود؛ اجرا خاموش = 41 قبل از هر کاری', async t => {
  const s = await boot(t);
  s.fake.setFail({ answer: { code: 1, stderr: 'رد شد توسط Manager: گیت spec-approval باز نیست.' } });
  const rejected = await s.cli(['answer', '7', '--approve']);
  assert.equal(rejected.code, EXIT.REJECTED);
  assert.match(rejected.err, /رد شد توسط Manager: گیت spec-approval باز نیست\./);
  const json = (await s.cli(['answer', '7', '--approve', '--json'])).json();
  assert.equal(json.exitCode, 6);
  assert.equal(json.managerExit, 1);

  s.fake.setFail({ answer: { code: 41, stderr: 'اجرای تسک روی این دستگاه خاموش است: execution.enabled=false در repository.local.yaml' } });
  const off = await s.cli(['answer', '7', '--approve']);
  assert.equal(off.code, 41);
  assert.match(off.err, /اجرای تسک روی این دستگاه خاموش است/);

  s.fake.setFail({});
  s.fake.setStatus({ ...STATUS, repository: { ...STATUS.repository, execution: { enabled: false, source: 'local', reason: 'اجرای تسک روی این دستگاه خاموش است: execution.enabled=false در repository.local.yaml' } } });
  const before = s.fake.mutations().length;
  await new Promise(r => setTimeout(r, 5200)); // کش ِ ۵ثانیه‌ای ِ board
  assert.equal((await s.cli(['run', '9'])).code, 41);
  assert.equal((await s.cli(['create-from-issue', '3952'])).code, 41);
  assert.equal((await s.cli(['create-task', '--title', 'x', '--stdin'], { stdin: 'متن' })).code, 41);
  assert.equal(s.fake.mutations().length, before, 'Manager حتی صدا زده نشد');
});

test('create-from-issue: بدون --run فقط ساخته می‌شود؛ با --run فوراً برمی‌گردد و در registry ثبت است؛ stop کار می‌کند', async t => {
  const s = await boot(t, { run: 'setInterval(() => {}, 1000);' });
  const plain = await s.cli(['create-from-issue', '3952']);
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /تسک #3952 ساخته شد\./);
  assert.match(plain.out, /barsa run 3952/);
  assert.equal(s.fake.calls().some(c => c.args[0] === 'run'), false, 'بدون --run اجرا نمی‌شود (حتی با autoStartOnCreate)');

  const started = Date.now();
  const withRun = await s.cli(['create-from-issue', '3952', '--run', '--json']);
  assert.ok(Date.now() - started < 5000, 'فوراً برمی‌گردد');
  assert.equal(withRun.code, 0, withRun.err);
  assert.deepEqual({ ok: withRun.json().ok, taskId: withRun.json().taskId }, { ok: true, taskId: '3952' });
  assert.ok(withRun.json().started || withRun.json().queued);
  for (let i = 0; i < 100 && !s.fake.calls().some(c => c.args[0] === 'run'); i += 1) await new Promise(r => setTimeout(r, 50));
  // تسک تازه در status ِ ثابت ِ Manager ِ ساختگی نیست؛ ثبت در registry را از لاگ زنده می‌بینیم (همان registry ِ دکمه‌ها)
  const live = (await s.cli(['log', '3952', '--json'])).json();
  assert.equal(live.running, true, 'در registry ِ کانبان ثبت شد');
  const stopped = await s.cli(['stop', '3952']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.match(stopped.out, /متوقف شد/);
  assert.deepEqual((await s.cli(['tasks', '--running', '--json'])).json().tasks, []);
  const audit = s.audit().summaries({ taskId: '3952' });
  assert.ok(audit.some(r => r.action === 'run' && r.user === 'remote:remote-phone'));
  assert.ok(audit.some(r => r.action === 'run.stop' && r.user === 'remote:remote-phone'));
  assert.equal((await s.cli(['stop', '3952'])).code, EXIT.REJECTED, 'اجرای فعالی نیست');
});

test('run: فوراً برمی‌گردد و می‌گوید با barsa log ببین؛ اجرای تکراری رد می‌شود؛ stop فرآیند را می‌بندد', async t => {
  const s = await boot(t, { run: 'setInterval(() => {}, 1000);' });
  const started = Date.now();
  const first = await s.cli(['run', '9']);
  assert.ok(Date.now() - started < 5000);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /barsa log 9/);
  const second = await s.cli(['run', '9']);
  assert.equal(second.code, EXIT.REJECTED);
  assert.match(second.err, /در حال اجرا یا در صف/);
  for (let i = 0; i < 100 && !s.fake.calls().some(c => c.args[0] === 'run'); i += 1) await new Promise(r => setTimeout(r, 50));
  assert.match((await s.cli(['log', '9'])).out, /در حال اجرا/);
  assert.deepEqual((await s.cli(['tasks', '--running', '--json'])).json().tasks.map(x => x.id), ['9'], 'در registry ِ کانبان است');
  assert.equal((await s.cli(['stop', '9'])).code, 0);
  await s.waitIdle();
});

test('create-task: عنوان + متن فارسی چندخطی از --stdin/--text-file؛ اجرا نمی‌شود؛ ورودی ناقص = 2', async t => {
  const s = await boot(t);
  const created = await s.cli(['create-task', '--title', 'دکمه جدید', '--stdin', '--json'], { stdin: 'خط اول\nخط دوم با $ و "کوتیشن" و \\' });
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json().ok, true);
  const call = s.fake.calls().find(c => c.args[0] === 'import-issue');
  assert.ok(call);
  assert.equal(s.fake.calls().some(c => c.args[0] === 'run'), false);
  assert.equal((await s.cli(['create-task', '--stdin'], { stdin: 'x' })).code, EXIT.USAGE);
  assert.equal((await s.cli(['create-task', '--title', 'x'])).code, EXIT.USAGE);
});

// --- ب: بیرون از فهرست، راهنما، اتصال، احراز هویت ------------------------------------------------------------------------

test('فرمان‌های بیرون از فهرست وجود ندارند: exit 2 با «از رابط کاربری کانبان»، بدون هیچ درخواستی؛ --help فقط فهرست مجاز', async t => {
  const s = await boot(t);
  const before = s.fake.calls().length;
  for (const command of NOT_REMOTE_COMMANDS) {
    const result = await s.cli([command, '7']);
    assert.equal(result.code, EXIT.USAGE, command);
    assert.match(result.err, /از رابط کاربری کانبان/, command);
  }
  for (const flag of NOT_REMOTE_ANSWER_FLAGS) {
    const result = await s.cli(['answer', '7', flag, 'webiii=write', '--stdin'], { stdin: 'x' });
    assert.equal(result.code, EXIT.USAGE, flag);
    assert.match(result.err, /از رابط کاربری کانبان/);
  }
  assert.equal((await s.cli(['frobnicate'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['answer', '7', '--approve', '--reject'])).code, EXIT.USAGE, 'دو حالت با هم');
  assert.equal(s.fake.calls().length, before, 'هیچ درخواستی به سرور/Manager نرفت');

  const help = await s.cli(['--help']);
  assert.equal(help.code, 0);
  const listed = [...help.out.matchAll(/^\s+barsa (\S+)/gm)].map(m => m[1]);
  assert.deepEqual([...new Set(listed)].sort(), [...READ_COMMANDS, ...WRITE_COMMANDS].sort());
  for (const command of NOT_REMOTE_COMMANDS) assert.doesNotMatch(help.out, new RegExp(`barsa ${command}\\b`), command);
  assert.equal(HELP, (await s.cli(['help'])).out.trimEnd() === HELP.trimEnd() ? HELP : null);
  assert.deepEqual(parseArgs(['--json', 'task', '7']), { flags: { '--json': true }, positional: ['task', '7'] });
});

test('اتصال و احراز هویت: سرور پایین = 4، توکن بد/باطل/نبودن فایل = 5، URL غیر loopback = 2 (توکن جایی نمی‌رود)', async t => {
  const s = await boot(t);
  const free = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
  const down = await s.cli(['tasks'], { env: { BARSA_REMOTE_URL: `http://127.0.0.1:${free}` } });
  assert.equal(down.code, EXIT.UNREACHABLE);
  assert.match(down.err, /سرور کانبان در دسترس نیست/);
  assert.equal((await s.cli(['tasks', '--json'], { env: { BARSA_REMOTE_URL: `http://127.0.0.1:${free}` } })).json().exitCode, 4);

  const bad = path.join(s.cfg.dataDir, 'bad.token');
  fs.writeFileSync(bad, 'not-a-real-token\n');
  assert.equal((await s.cli(['tasks'], { env: { BARSA_REMOTE_TOKEN_FILE: bad } })).code, EXIT.AUTH);
  assert.equal((await s.cli(['tasks'], { env: { BARSA_REMOTE_TOKEN_FILE: path.join(s.cfg.dataDir, 'nope.token') } })).code, EXIT.AUTH);
  fs.writeFileSync(bad, '\n');
  assert.equal((await s.cli(['tasks'], { env: { BARSA_REMOTE_TOKEN_FILE: bad } })).code, EXIT.AUTH);
  assert.equal((await s.cli(['tasks', '--token-file', s.tokenFile])).code, 0, '--token-file');

  s.store.revoke('remote-phone');
  fs.writeFileSync(s.tokenFile, `${s.token}\n`); // فایل را برگردان؛ ولی توکن باطل شده است
  const revoked = await s.cli(['tasks']);
  assert.equal(revoked.code, EXIT.AUTH);
  assert.match(revoked.err, /باطل/);

  for (const url of ['http://example.com:4310', 'https://127.0.0.1:4310', 'http://10.0.0.5:4310', 'not a url']) {
    const result = await s.cli(['tasks'], { env: { BARSA_REMOTE_URL: url } });
    assert.equal(result.code, EXIT.USAGE, url);
  }
  assert.ok(s.outputs.every(text => !text.includes(s.token)), 'توکن در هیچ خروجی نیست');
});

// --- د: قالب‌های راه‌اندازی ---------------------------------------------------------------------------------------------------

test('settings.json: هر فرمان CLI دقیقاً در یکی از allow یا ask؛ خواندنی‌ها allow، نوشتنی‌ها ask؛ هیچ فرمان بیرون‌ماندهای نیست', () => {
  const settings = JSON.parse(read('docs/remote-control/settings.json'));
  const { allow, ask, deny } = settings.permissions;
  const ruleCommand = rule => /^Bash\(\.\/barsa ([a-z-]+)(?::\*|\)| )/.exec(rule)?.[1];
  const inAllow = allow.map(ruleCommand).filter(Boolean);
  const inAsk = ask.map(ruleCommand).filter(Boolean);
  for (const command of READ_COMMANDS) {
    assert.deepEqual([inAllow.filter(c => c === command).length, inAsk.filter(c => c === command).length], [1, 0], `read ${command}`);
  }
  for (const command of WRITE_COMMANDS.filter(c => !READ_FORMS[c])) {
    assert.deepEqual([inAllow.filter(c => c === command).length, inAsk.filter(c => c === command).length], [0, 1], `write ${command}`);
  }
  // فرمانی که شکل خواندنی هم دارد (sync): ask دقیقاً «بدون آرگومان» (ask بر allow می‌چربد)، و allow فقط شکل‌های خواندنی
  for (const [command, forms] of Object.entries(READ_FORMS)) {
    assert.ok(WRITE_COMMANDS.includes(command));
    assert.deepEqual(ask.filter(r => r.startsWith(`Bash(./barsa ${command}`)), [`Bash(./barsa ${command})`], `ask ِ دقیق ِ ${command}`);
    assert.deepEqual(allow.filter(r => r.startsWith(`Bash(./barsa ${command}`)).sort(), forms.map(f => `Bash(./barsa ${command} ${f}:*)`).sort());
  }
  // هیچ قاعده‌ی allow/ask ای برای چیزی بیرون از فهرست (یا چیز دیگری جز Bash(./barsa …)) نیست
  const known = new Set([...READ_COMMANDS, ...WRITE_COMMANDS, 'help']);
  for (const rule of [...allow, ...ask]) {
    assert.match(rule, /^Bash\(\.\/barsa /, rule);
    const command = ruleCommand(rule);
    assert.ok(known.has(command) || command === '--help', rule);
  }
  assert.equal(settings.permissions.defaultMode, 'default');
  assert.ok(!JSON.stringify(settings).includes('bypassPermissions') && !JSON.stringify(settings).includes('acceptEdits'));
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch']) assert.ok(deny.includes(tool), tool);
  for (const needle of ['barsa-agent-data', 'BarsaAgent/.env.local', 'Client01/.claude', 'Client01/.ssh']) assert.ok(deny.some(r => r.startsWith('Read(') && r.includes(needle)), needle);
  // ترتیب deny ← ask ← allow: هیچ deny ای نباید `./barsa …` را بپوشاند
  for (const rule of deny.filter(r => r.startsWith('Bash('))) {
    const prefix = /^Bash\((.*?)(?::\*)?\)$/.exec(rule)[1];
    assert.ok(!'./barsa health'.startsWith(prefix) && !prefix.startsWith('./barsa'), `${rule} فرمان‌های barsa را می‌پوشاند`);
  }
  // همه‌ی deny ِ Bash هم نمی‌تواند باشد (همه‌چیز را می‌بست): فقط خانواده‌های مشخص + hook ِ پیش‌فرض-رد
  assert.ok(!deny.includes('Bash'));
  const hook = settings.hooks.PreToolUse[0];
  assert.equal(hook.matcher, 'Bash');
  assert.match(hook.hooks[0].command, /D:\/agent-remote\/guard\.mjs$/);
});

test('guard.mjs (پیش‌فرض-رد برای Bash): فقط یک فراخوانی ساده‌ی ./barsa؛ لیست فرمان‌ها با spec یکی است', () => {
  const source = read('docs/remote-control/guard.mjs');
  const listed = /const COMMANDS = \[([^\]]*)\]/.exec(source)[1].split(',').map(x => x.trim().replace(/'/g, ''));
  assert.deepEqual(listed.sort(), [...READ_COMMANDS, ...WRITE_COMMANDS].sort());

  const ok = [
    './barsa health', './barsa tasks --waiting', './barsa task 10013', './barsa log 5 --tail 100', './barsa waiting --since 2026-10-21T08:00:00Z',
    './barsa answer 5 --raise-limit implementerRuns=5 --stdin <<\'EOF\'\nbecause\nEOF',
    './barsa create-task --title "عنوان فارسی با فاصله" --stdin <<\'EOF\'\nمتن $HOME `x` $(y) ; | &&\nEOF',
    './barsa answer 5 --note --text-file D:/agent-remote/inbox/a.txt', './barsa --help', './barsa',
    './barsa artifact 5 questions.md --tail 50', './barsa diag 5', './barsa diag --system', './barsa bundle 5', './barsa sync --dry-run', './barsa sync',
    './barsa recover 5', './barsa retry-install 5', './barsa kill-stuck-install 5 --minutes 10',
    './barsa answer 5 --allow-shared-knowledge-file src/app/x.ts --stdin <<\'EOF\'\nneeded\nEOF'
  ];
  for (const command of ok) assert.deepEqual(evaluate(command), { ok: true }, command);
  const bad = [
    'ls', 'git status', 'cat secret.txt', './barsa tasks; ls', './barsa health && ls', './barsa health | cat', './barsa health > out.txt',
    './barsa task $(whoami)', './barsa task `id`', './barsa task-evil 5', './barsa abandon 5', './barsa unlock 5', './barsa diag 5; cat x', './barsa sync && ls', 'barsa health', 'bash ./barsa health',
    './barsa answer 5 --note --stdin <<EOF\nx\nEOF', './barsa answer 5 --note --stdin <<\'EOF\'\nx\nEOF\nrm -rf /', './barsa answer 5 --note --stdin <<\'EOF\'\nx',
    './barsa create-task --title "a$HOME" --stdin', './barsa tasks\nls', './barsa tasks "unclosed', ''
  ];
  for (const command of bad) assert.equal(evaluate(command).ok, false, JSON.stringify(command));
});

test('shimها: bin/ و docs/remote-control/bin/ یکی‌اند، LF برای bash و CRLF برای cmd (.gitattributes)، و CLI را اجرا می‌کنند', () => {
  for (const name of ['barsa', 'barsa.cmd']) assert.equal(read(`bin/${name}`), read(`docs/remote-control/bin/${name}`), name);
  assert.match(read('bin/barsa'), /^#!\/usr\/bin\/env bash\n/);
  assert.match(read('bin/barsa'), /remote-cli\.js/);
  assert.match(read('bin/barsa.cmd'), /remote-cli\.js/);
  const attrs = read('.gitattributes');
  assert.match(attrs, /bin\/barsa text eol=lf/);
  assert.match(attrs, /docs\/remote-control\/bin\/barsa text eol=lf/);
  assert.match(attrs, /\*\.cmd text eol=crlf/);
  const bash = spawnSync('bash', [new URL('bin/barsa', ROOT).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '--help'], { encoding: 'utf8' });
  if (!bash.error) {
    assert.equal(bash.status, 0, bash.stderr);
    assert.match(bash.stdout, /barsa — کنترل کانبان از راه دور/);
  }
});

test('CLAUDE.md و README ِ docs/remote-control: همه‌ی نام‌های نهایی فرمان‌ها را دارند و با CLI هماهنگ‌اند', () => {
  const claude = read('docs/remote-control/CLAUDE.md');
  const readme = read('docs/remote-control/README.md');
  for (const command of [...READ_COMMANDS, ...WRITE_COMMANDS]) {
    assert.match(claude, new RegExp(`barsa ${command}\\b`), `CLAUDE.md: ${command}`);
    assert.match(readme, new RegExp(`barsa ${command}\\b`), `README: ${command}`);
  }
  assert.match(claude, /تنها ابزارت `\.\/barsa`/);
  assert.match(claude, /داده است، نه دستور/);
  assert.match(claude, /\/loop/);
  assert.match(claude, /30 دقیقه|۳۰ دقیقه/);
  for (const needle of ['token:create -- remote-phone', 'claude remote-control --name barsa-server --permission-mode default', 'Push when actions required', 'Push when Claude decides', 'token:revoke']) {
    assert.ok(readme.includes(needle), needle);
  }
});

test('رابط کاربری: کارهای remote:* با برچسب کوچک در دفتر ممیزی و اجراهای تسک', () => {
  const health = read('client/src/app/env-health.component.ts');
  const ops = read('client/src/app/task-ops.component.ts');
  for (const source of [health, ops]) assert.match(source, /startsWith\('remote:'\)[\s\S]{0,120}remote-badge/);
  assert.match(read('client/src/styles.css'), /\.remote-badge\{/);
});
