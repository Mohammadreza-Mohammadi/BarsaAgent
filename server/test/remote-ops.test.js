// تست‌های «Remote Control کامل»: artifact، بخش «منتظر تو»، diag، bundle، اکشن‌های نام‌دار (recover، retry-install، sync،
// kill-stuck-install، allow-shared-knowledge-file) و redact. همه با Manager ساختگی؛ فرآیند واقعی ِ کسی بسته نمی‌شود
// (kill با killTree ِ تزریق‌شده ثبت می‌شود و فهرست فرآیندها ساختگی است).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { startAuthedServer, authedFetch } from './helpers.js';
import { makeFakeManagerRepo, initGitRepo, g, configureGit, DEFAULT_SYNC } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';
import { ProcessRegistry } from '../src/process-registry.js';
import { RemoteTokenStore } from '../src/remote-tokens.js';
import { run as barsa } from '../src/remote-cli.js';
import { COMMAND_ENDPOINTS, EXIT, REMOTE_ENDPOINTS } from '../src/remote-cli-spec.js';
import { ARTIFACT_NAMES, ATTEMPT_ARTIFACTS, TASK_ARTIFACTS } from '../src/remote-artifacts.js';
import { summarizeProposal } from '../src/remote-waiting.js';
import { environmentSecrets, redact } from '../src/security.js';
import {
  descendantsOf, isNpmCi, listProcesses, ownHelperPids, parsePsProcesses, parseWindowsProcesses, relatedToTask
} from '../src/process-list.js';
import { whichOnPath } from '../src/diag.js';
import { removeDirOnCleanup } from './cleanup.js';

// --- داده‌ی نمونه ---------------------------------------------------------------------------------------------------

const NO_ACTIONS = {
  approve: false, reject: false, clarify: false, note: false, unblock: false, raiseLimit: [], closeOrphan: [], allowPath: false,
  allowSharedKnowledgeFile: false, externalAccess: [], resetExternal: [], cancel: false, abandon: false, void: false, unlock: false,
  recover: false, retryInstall: false
};
const HEALTH_OK = {
  transitionLock: null, dirtyPaths: [], stuck: false, stuckReasons: [],
  recovery: { suggested: null, reason: null, commands: [], mode: null, attempt: null }, install: null
};
const mk = (id, extra = {}) => ({
  id: String(id), title: `تسک ${id}`, state: 'implementing', stateSince: '2026-10-21T08:00:00Z', awaitingHuman: null, blocker: null,
  dir: `.agent-work/tasks/${id}-x`, worktree: { status: null, path: null }, git: { base: 'main', branch: null },
  attempts: [{ n: 1, role: 'intake', outcome: 'proposed' }, { n: 2, role: 'architect', outcome: 'ok' }],
  lastAttempt: { n: 2, role: 'architect', outcome: 'ok' },
  artifacts: ['request.md', 'task.md', 'handoff.md', 'questions.md', 'prompt.md'],
  actions: { ...NO_ACTIONS }, health: { ...HEALTH_OK, recovery: { ...HEALTH_OK.recovery } }, ...extra
});
const board = tasks => ({
  schemaVersion: 1, generatedAt: '2026-10-21T09:00:00Z', repo: { head: 'e'.repeat(40) },
  repository: {
    health: { managerLock: null, unownedDirtyFiles: [], acceptsOperations: true },
    execution: { enabled: true, source: 'default', reason: null },
    localConfig: { path: '.agent-work/config/repository.local.yaml', present: false, applied: false, keys: [] },
    sync: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, lastFetchAt: '2026-10-21T08:00:00Z' }
  },
  tasks
});
const OK_CLAUDE = { command: process.execPath, versionArgs: ['--version'], authArgs: ['--version'] };
const proc = (pid, ppid, name, cmd, ageMin = 1, cpu = 0) => ({ pid, ppid, name, cmd, startedAt: Date.now() - ageMin * 60_000, cpuSeconds: cpu });
const bearer = token => ({ Authorization: `Bearer ${token}` });

async function boot(t, { tasks = [mk(7), mk(8), mk(9)], run, deps = {}, config = {}, maxConcurrent = 2, git = false, files = {} } = {}) {
  const fake = makeFakeManagerRepo(t, { status: board(tasks), run });
  if (git) initGitRepo(fake.root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(fake.root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-ops-data-'));
  removeDirOnCleanup(t, dataDir);
  const errFile = path.join(dataDir, 'kanban.err.log');
  const cfg = { repos: [fake.repo], server: {}, issueSource: {}, run: { proxy: '' }, dataDir, logs: { errFile }, health: { claude: OK_CLAUDE, proxyTestUrl: 'http://127.0.0.1:9/' }, ...config };
  const audit = new AuditLog({ dir: dataDir });
  const registry = new ProcessRegistry({ maxConcurrent, maxLines: 2000, config: cfg, audit, graceMs: 200 });
  const state = { procs: [], killed: [], issues: [{ externalId: '1', title: 'a' }, { externalId: '2', title: 'b' }] };
  const addr = { value: '127.0.0.1' };
  const { base } = await startAuthedServer(t, cfg, {
    registry, audit, remoteAddress: () => addr.value,
    issueFetcher: async () => state.issues,
    listProcesses: async () => state.procs.map(p => ({ ...p })),
    killTree: async pid => { state.killed.push(pid); return { stillAlive: false, steps: 1 }; },
    ...deps
  });
  new RemoteTokenStore(dataDir).create('remote-phone');
  const tokenFile = path.join(dataDir, 'tokens', 'remote-phone.token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const outputs = [];
  const cli = async (args, { stdin = '', env = {} } = {}) => {
    let out = '';
    let err = '';
    const code = await barsa(args, {
      env: { BARSA_REMOTE_URL: base, BARSA_REMOTE_TOKEN_FILE: tokenFile, BARSA_POLL_MS: '40', BARSA_SYNC_WAIT_MS: '20000', ...env },
      stdout: text => { out += text; }, stderr: text => { err += text; }, stdin: Readable.from([Buffer.from(stdin, 'utf8')])
    });
    outputs.push(out, err);
    assert.ok(!out.includes(token) && !err.includes(token), 'توکن هرگز در خروجی CLI نمی‌آید');
    return { code, out, err, json: () => JSON.parse(out) };
  };
  const waitFor = async (predicate, ms = 8000) => {
    for (let i = 0; i < ms / 40; i += 1) { if (await predicate()) return true; await new Promise(r => setTimeout(r, 40)); }
    return false;
  };
  const stopAll = async () => {
    for (const run of registry.list(fake.repo)) if (run.running || run.queued) await registry.stop(fake.repo, run.taskId);
    await waitFor(() => registry.activeCount() === 0);
  };
  return { fake, base, cfg, token, tokenFile, state, addr, audit: () => new AuditLog({ dir: dataDir }), registry, cli, waitFor, stopAll, dataDir, errFile, outputs };
}

function unzip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const size = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLen);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + size);
    out[name] = method === 8 ? zlib.inflateRawSync(body) : body;
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const withEnv = (t, vars) => {
  const old = {};
  for (const [key, value] of Object.entries(vars)) { old[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
};

const SECRET_ENV = 'envtoken-value-98765-zz';
const USER_ID = 'portal-user-424242-id';
const ARGV_SECRET = 'SEKRET-ARGV-VALUE-123';

// --- artifact ---------------------------------------------------------------------------------------------------------

test('artifact: بدون نام فهرست (فقط نام‌های مجاز، بدون prompt.md)؛ هر نام مجاز از راه manager.js artifact خوانده می‌شود، نه فایل مستقیم', async t => {
  const s = await boot(t);
  const map = {};
  for (const name of TASK_ARTIFACTS) map[name] = `محتوای ${name}\nخط دوم`;
  for (const name of ATTEMPT_ARTIFACTS) map[`attempts/002/${name}`] = `attempt ${name}\nx`;
  s.fake.setArtifacts(map);

  const list = await s.cli(['artifact', '7']);
  assert.equal(list.code, 0, list.err);
  assert.match(list.out, /سطح تسک: questions\.md، task\.md، handoff\.md، request\.md\n/);
  assert.doesNotMatch(list.out, /prompt\.md/);
  assert.match(list.out, /result\.yaml، run-meta\.yaml، agent-transcript\.log/);

  for (const name of TASK_ARTIFACTS) {
    const result = await s.cli(['artifact', '7', name]);
    assert.equal(result.code, 0, `${name}: ${result.err}`);
    assert.match(result.out, new RegExp(`محتوای ${name.replace('.', '\\.')}\\nخط دوم`), name);
  }
  for (const name of ATTEMPT_ARTIFACTS) {
    const result = await s.cli(['artifact', '7', name]); // پیش‌فرض: آخرین attempt (002)
    assert.equal(result.code, 0, `${name}: ${result.err}`);
    assert.match(result.out, new RegExp(`── ${name.replace('.', '\\.')} \\(attempt 002\\)`));
    assert.match(result.out, new RegExp(`attempt ${name.replace('.', '\\.')}`));
  }
  const calls = s.fake.calls().filter(c => c.args[0] === 'artifact').map(c => c.args.join(' '));
  assert.ok(calls.includes('artifact 7 --path questions.md'));
  assert.ok(calls.includes('artifact 7 --path attempts/002/result.yaml'));
  assert.ok(ARTIFACT_NAMES.length >= TASK_ARTIFACTS.length + ATTEMPT_ARTIFACTS.length + 1);
});

test('artifact: نام مجاز نیست / attempt بد / نبودن = رد؛ مسیر دلخواه ساخته نمی‌شود', async t => {
  const s = await boot(t);
  s.fake.setArtifacts({ 'questions.md': 'سؤال' });
  const before = s.fake.calls().filter(c => c.args[0] === 'artifact').length;
  for (const name of ['manifest.yaml', 'prompt.md', '../questions.md', 'attempts/001/result.yaml', 'human/x.md', 'agent-stream.jsonl', 'questions.md/../x']) {
    const result = await s.cli(['artifact', '7', name]);
    assert.equal(result.code, EXIT.REJECTED, name);
    assert.match(result.err, /نام artifact مجاز نیست/, name);
  }
  assert.equal(s.fake.calls().filter(c => c.args[0] === 'artifact').length, before, 'Manager برای نام غیرمجاز صدا زده نشد');
  assert.equal((await s.cli(['artifact', '7', 'questions.md', '--attempt', 'abc'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['artifact', '7', '--tail', '5'])).code, EXIT.USAGE, 'tail بدون نام');
  assert.equal((await s.cli(['artifact', '7', 'questions.md', '--tail', '501'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['artifact', '7', 'questions.md', '--tail', '0'])).code, EXIT.USAGE);
  const missing = await s.cli(['artifact', '7', 'review.md']);
  assert.equal(missing.code, EXIT.REJECTED);
  assert.match(missing.err, /پیدا نشد/);
  const wrongAttempt = await s.cli(['artifact', '7', 'result.yaml', '--attempt', '9']);
  assert.equal(wrongAttempt.code, EXIT.REJECTED);
});

test('artifact: --tail، تعداد خط، سقف اندازه، transcript فقط انتها، events، و fallback به attempt', async t => {
  const s = await boot(t);
  const transcript = Array.from({ length: 300 }, (_, i) => `خط ${i + 1}`).join('\n');
  const big = `${'x'.repeat(200)}\n`.repeat(2000);
  s.fake.setArtifacts({ 'task.md': Array.from({ length: 20 }, (_, i) => `t${i + 1}`).join('\n'), 'attempts/002/agent-transcript.log': transcript, 'handoff.md': big, 'attempts/002/review.md': 'review در attempt', 'attempts/001/result.yaml': 'role: intake' });
  s.fake.setEvents(Array.from({ length: 120 }, (_, i) => ({ at: '2026-10-21T08:00:00Z', event: `e${i + 1}` })));

  const tail = await s.cli(['artifact', '7', 'task.md', '--tail', '3']);
  assert.match(tail.out, /── task\.md · 3\/20 خط · بریده شد\nt18\nt19\nt20/);
  const full = await s.cli(['artifact', '7', 'task.md', '--json']);
  assert.deepEqual({ total: full.json().totalLines, shown: full.json().shownLines, truncated: full.json().truncated }, { total: 20, shown: 20, truncated: false });

  const log = (await s.cli(['artifact', '7', 'agent-transcript.log', '--json'])).json();
  assert.equal(log.shownLines, 80, 'پیش‌فرض ۸۰ خط ِ آخر');
  assert.ok(log.text.endsWith('خط 300') && !log.text.includes('خط 220\n'));
  assert.equal((await s.cli(['artifact', '7', 'agent-transcript.log', '--tail', '2', '--json'])).json().text, 'خط 299\nخط 300');
  assert.match((await s.cli(['artifact', '7', 'result.yaml', '--attempt', '1'])).out, /role: intake/);

  const capped = (await s.cli(['artifact', '7', 'handoff.md', '--json'])).json();
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.length < 125_000 && /بریده شد/.test(capped.text));

  const events = (await s.cli(['artifact', '7', 'events', '--json'])).json();
  assert.equal(events.shownLines, 80);
  assert.match(events.text, /"event":"e120"\}$/);
  assert.equal((await s.cli(['artifact', '7', 'events.jsonl', '--tail', '2', '--json'])).json().shownLines, 2);

  const viaAttempt = (await s.cli(['artifact', '7', 'review.md', '--json'])).json();
  assert.equal(viaAttempt.attempt, 2);
  assert.equal(viaAttempt.text, 'review در attempt');
});

test('artifact: متن از redactor می‌گذرد (راز محیط، توکن، شناسه‌ی کاربر پورتال)', async t => {
  withEnv(t, { BARSA_TEST_SECRET_TOKEN: SECRET_ENV, BARSA_ISSUE_USER_ID: USER_ID });
  const s = await boot(t);
  s.fake.setArtifacts({ 'task.md': `کلید ${SECRET_ENV} و ${USER_ID} و ghp_abcdefghijklmnop12345 و Authorization: Bearer abcdefghijklmnopqrstu` });
  const result = await s.cli(['artifact', '7', 'task.md']);
  for (const secret of [SECRET_ENV, USER_ID, 'ghp_abcdefghijklmnop12345', 'abcdefghijklmnopqrstu']) assert.ok(!result.out.includes(secret), secret);
  assert.match(result.out, /\[MASKED\]/);
});

// --- بخش «منتظر تو» -------------------------------------------------------------------------------------------------

const QUESTIONS = Array.from({ length: 12 }, (_, i) => `سؤال ${i + 1}: آیا باید رفتار شماره‌ی ${i + 1} را حفظ کنیم؟ این یک جمله‌ی بلند برای اطمینان از اینکه متن خلاصه نمی‌شود است.`).join('\n\n');
const PROPOSAL = `# Proposed Task — کامپوننت voice

## Goal

کاربر بتواند پیام صوتی بفرستد.

## Acceptance Criteria

### AC-1
ضبط صدا از میکروفون شروع و پایان می‌یابد.

### AC-2
کاربر می‌تواند ضبط را قبل از ارسال لغو کند.

## Ambiguities / Open Questions

-   سؤال 1: حداکثر طول ضبط چقدر است؟
-   فرض 2: فرمت صوتی با architect.
`;
const LONG_NOTE = Array.from({ length: 30 }, (_, i) => `خط ${i + 1} از release note که نباید بریده شود`).join('\n');

test('task <id>: بخش «منتظر تو» برای هر نوع گیت — clarification: متن کامل سؤال‌ها', async t => {
  const s = await boot(t, { tasks: [mk(21, { state: 'clarification', awaitingHuman: { kind: 'clarification', since: '2026-10-21T08:10:00Z', artifact: 'questions.md' }, actions: { ...NO_ACTIONS, clarify: true, note: true } })] });
  s.fake.setArtifacts({ 'questions.md': QUESTIONS });
  const result = await s.cli(['task', '21']);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /⏳ منتظر تو — clarification \(از 2026-10-21 08:10\)/);
  assert.ok(result.out.includes(QUESTIONS), 'متن کامل و دست‌نخورده');
  assert.match(result.out, /barsa artifact 21 questions\.md/);
  const json = (await s.cli(['task', '21', '--json'])).json();
  assert.equal(json.waiting.kind, 'clarification');
  assert.equal(json.waiting.questions, QUESTIONS);

  s.fake.setArtifacts({});
  const unreadable = await s.cli(['task', '21']);
  assert.equal(unreadable.code, 0, 'خطا در خواندن artifact کل task را خراب نمی‌کند');
  assert.match(unreadable.out, /متن سؤال‌ها خوانده نشد/);
});

test('task <id>: spec-approval خلاصه‌ی AC، merge-approval تصمیم Reviewer + release note کامل + diff (و diff ِ WebIII)، orphan-attempt', async t => {
  const merge = mk(23, {
    state: 'merge-approval', awaitingHuman: { kind: 'merge-approval', since: '2026-10-21T08:30:00Z', artifact: 'review.md' },
    actions: { ...NO_ACTIONS, approve: true, reject: true },
    review: { decision: 'approved', evidenceStatus: 'ok', problems: ['یک مشکل جزئی'], evidence: { acceptance: [{ ac: 'AC-1', verdict: 'pass' }, { ac: 'AC-2', verdict: 'fail' }] } },
    releaseNote: { userVisible: true, headline: 'تیتر release', body: LONG_NOTE, approvedByHuman: false },
    diff: { headCommit: 'abc', files: [{ path: 'src/a.ts', added: 10, deleted: 2, status: 'modified', inScope: true }, { path: 'src/b.ts', added: 1, deleted: 0, status: 'added', inScope: false }] },
    externalSources: [{ id: 'webiii', access: 'write', delivery: 'apply', staged: null, checkedIn: null, diff: { path: 'external/webiii.diff', files: [{ path: 'Web/X.cs', added: 7, deleted: 1, status: 'modified' }, { path: 'Web/Y.js', added: 3, deleted: 0, status: 'added' }] } }]
  });
  const s = await boot(t, {
    tasks: [
      mk(22, { state: 'spec-review', awaitingHuman: { kind: 'spec-approval', since: '2026-10-21T08:20:00Z', artifact: 'proposed-task.md' }, actions: { ...NO_ACTIONS, approve: true, reject: true, clarify: true } }),
      merge,
      mk(24, { state: 'blocked', awaitingHuman: { kind: 'orphan-attempt', since: '2026-10-21T08:40:00Z', artifact: '.agent-work/tasks/24-x/attempts/013' }, actions: { ...NO_ACTIONS, closeOrphan: ['013'] } })
    ]
  });
  s.fake.setArtifacts({ 'proposed-task.md': PROPOSAL });

  const spec = await s.cli(['task', '22']);
  assert.match(spec.out, /⏳ منتظر تو — spec-approval/);
  assert.match(spec.out, /عنوان: کامپوننت voice/);
  assert.match(spec.out, /هدف: کاربر بتواند پیام صوتی بفرستد\./);
  assert.match(spec.out, /AC-1: ضبط صدا از میکروفون شروع و پایان می‌یابد\./);
  assert.match(spec.out, /AC-2: کاربر می‌تواند ضبط را قبل از ارسال لغو کند\./);
  assert.match(spec.out, /ابهام\/سؤال باز \(2\)/);
  assert.match(spec.out, /barsa artifact 22 proposed-task\.md/);

  const mergeOut = await s.cli(['task', '23']);
  assert.match(mergeOut.out, /⏳ منتظر تو — merge-approval/);
  assert.match(mergeOut.out, /تصمیم Reviewer: approved · شواهد: ok · AC-1:pass AC-2:fail/);
  assert.match(mergeOut.out, /مشکل: یک مشکل جزئی/);
  assert.match(mergeOut.out, /release note: تیتر release/);
  for (let i = 1; i <= 30; i += 1) assert.ok(mergeOut.out.includes(`خط ${i} از release note که نباید بریده شود`), `خط ${i}`);
  assert.match(mergeOut.out, /diff: 2 فایل \(\+11 −2\)/);
  assert.match(mergeOut.out, /src\/b\.ts.*خارج scope/);
  assert.match(mergeOut.out, /diff منبع بیرونی webiii \(write\/apply\): 2 فایل \(\+10 −1\)/);
  assert.match(mergeOut.out, /Web\/X\.cs \(\+7 −1\)/);
  assert.match(mergeOut.out, /تست دستی رابط کاربری از گوشی شدنی نیست/);
  assert.equal((mergeOut.out.match(/release note:/g) || []).length, 1, 'تکرار نمی‌شود');
  const json = (await s.cli(['task', '23', '--json'])).json();
  assert.equal(json.waiting.external[0].diff.count, 2);
  assert.equal(json.waiting.releaseNote.body, LONG_NOTE);

  const orphan = await s.cli(['task', '24']);
  assert.match(orphan.out, /⏳ منتظر تو — orphan-attempt/);
  assert.match(orphan.out, /barsa artifact 24 result\.yaml --attempt 13/);
});

test('summarizeProposal: AC به‌صورت heading و فهرست، هدف، سؤال‌های باز', () => {
  const p = summarizeProposal(PROPOSAL);
  assert.equal(p.title, 'کامپوننت voice');
  assert.deepEqual(p.acceptanceCriteria.map(a => a.id), ['AC-1', 'AC-2']);
  assert.equal(p.openQuestions.length, 2);
  const listy = summarizeProposal('# T\n\n## Acceptance Criteria\n\n- AC-1: یک\n- **AC-2**: دو\n');
  assert.deepEqual(listy.acceptanceCriteria.map(a => [a.id, a.text]), [['AC-1', 'یک'], ['AC-2', 'دو']]);
  assert.deepEqual(summarizeProposal('').acceptanceCriteria, []);
});

// --- answer: حالت‌های تازه ----------------------------------------------------------------------------------------------

test('answer --allow-shared-knowledge-file و --clarify --respec: آرگومان دقیق Manager، پیش‌سنجی actions، مسیر خطرناک رد', async t => {
  const s = await boot(t, { tasks: [mk(7, { actions: { ...NO_ACTIONS, clarify: true, allowSharedKnowledgeFile: true } }), mk(8)] });
  const shape = args => args.map((a, i) => (args[i - 1] && /^--(file|reason-file)$/.test(args[i - 1]) ? '<file>' : a));
  const ok = await s.cli(['answer', '7', '--allow-shared-knowledge-file', 'src/app/shared.ts', '--stdin'], { stdin: 'needed by the feature' });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /اجرا خودکار نیست/);
  assert.equal((await s.cli(['answer', '7', '--clarify', '--respec', '--stdin'], { stdin: 'پاسخ' })).code, 0);
  await s.waitFor(() => s.fake.calls().some(c => c.args[0] === 'run'));
  const answers = s.fake.mutations().map(c => shape(c.args)).filter(a => a[0] === 'answer');
  assert.deepEqual(answers, [
    ['answer', '7', '--allow-shared-knowledge-file', 'src/app/shared.ts', '--reason-file', '<file>'],
    ['answer', '7', '--clarify', '--file', '<file>', '--respec']
  ]);
  assert.equal(s.fake.files()[0].text, 'needed by the feature');
  const rows = s.audit().summaries({ action: 'allow-shared-knowledge-file' });
  assert.equal(rows[0].user, 'remote:remote-phone');
  await s.stopAll();

  const before = s.fake.mutations().length;
  assert.equal((await s.cli(['answer', '8', '--allow-shared-knowledge-file', 'a.ts', '--stdin'], { stdin: 'x' })).code, EXIT.NOT_ALLOWED);
  for (const bad of ['/etc/passwd', 'C:/x.ts', '../x.ts', 'a/../../x', '-rf']) {
    const result = await s.cli(['answer', '7', `--allow-shared-knowledge-file=${bad}`, '--stdin'], { stdin: 'x' });
    assert.equal(result.code, EXIT.USAGE, bad);
  }
  assert.equal((await s.cli(['answer', '7', '--note', '--respec', '--stdin'], { stdin: 'x' })).code, EXIT.USAGE);
  assert.equal((await s.cli(['answer', '7', '--allow-shared-knowledge-file', 'a.ts'])).code, EXIT.USAGE, 'دلیل لازم است');
  assert.equal(s.fake.mutations().length, before);
});

// --- recover / retry-install ---------------------------------------------------------------------------------------------

test('recover: پیش‌سنجی actions.recover و mode، آرگومان دقیق، ردیف ممیزی remote:<name>', async t => {
  const recovery = mode => ({ suggested: 'recover', reason: 'attempt کامل ولی تفسیرنشده', commands: ['recover', 'run'], mode, attempt: '003' });
  const s = await boot(t, {
    tasks: [
      mk(7, { actions: { ...NO_ACTIONS, recover: true }, health: { ...HEALTH_OK, stuck: true, stuckReasons: ['dirty-worktree'], dirtyPaths: ['a'], recovery: recovery('process-attempt') } }),
      mk(8, { actions: { ...NO_ACTIONS, recover: true }, health: { ...HEALTH_OK, stuck: true, stuckReasons: ['dirty-worktree'], dirtyPaths: ['b'], recovery: recovery('discard-residue') } }),
      mk(9)
    ]
  });
  const shape = args => args.map((a, i) => (args[i - 1] === '--reason-file' ? '<file>' : a));
  const plain = await s.cli(['recover', '7']);
  assert.equal(plain.code, 0, plain.err);
  assert.match(plain.out, /تسک #7: recover انجام شد/);
  assert.match(plain.out, /barsa run 7/);

  const discard = await s.cli(['recover', '8', '--discard-residue', '--stdin'], { stdin: 'residue from rejected hook commit' });
  assert.equal(discard.code, 0, discard.err);
  assert.deepEqual(s.fake.mutations().map(c => shape(c.args)), [['recover', '7'], ['recover', '8', '--discard-residue', '--reason-file', '<file>']]);
  assert.equal(s.fake.files().at(-1).text, 'residue from rejected hook commit');

  // mode ِ ناسازگار و دلیل: هیچ درخواستی نمی‌رود
  const before = s.fake.mutations().length;
  assert.equal((await s.cli(['recover', '7', '--discard-residue', '--stdin'], { stdin: 'x' })).code, EXIT.NOT_ALLOWED, 'attempt قابل‌پردازش را نباید دور ریخت');
  assert.match((await s.cli(['recover', '8'])).err, /--discard-residue/);
  assert.equal((await s.cli(['recover', '8', '--discard-residue'])).code, EXIT.USAGE, 'دلیل لازم است');
  assert.equal((await s.cli(['recover', '7', '--stdin'], { stdin: 'x' })).code, EXIT.USAGE, 'دلیل بدون discard');
  assert.equal((await s.cli(['recover', '9'])).code, EXIT.NOT_ALLOWED);
  assert.equal(s.fake.mutations().length, before);

  const rows = s.audit().summaries({ action: 'recover' });
  assert.equal(rows.length, 2);
  assert.ok(rows.every(r => r.user === 'remote:remote-phone' && r.phases.includes('end')));

  // اجرا خاموش: پیش از هر کاری با 41
  s.fake.setStatus({ ...board([mk(7, { actions: { ...NO_ACTIONS, recover: true }, health: { ...HEALTH_OK, recovery: recovery('process-attempt') } })]), repository: { ...board([]).repository, execution: { enabled: false, source: 'local', reason: 'اجرای تسک روی این دستگاه خاموش است' } } });
  await new Promise(r => setTimeout(r, 5200));
  assert.equal((await s.cli(['recover', '7'])).code, EXIT.EXECUTION_OFF);
});

test('retry-install: فقط با actions.retryInstall؛ unblock و بعد run؛ دو ردیف ممیزی (unblock و retry-install)', async t => {
  const s = await boot(t, {
    tasks: [
      mk(8, { state: 'blocked', blocker: { kind: 'install-failed', stage: 'install', detail: 'npm ci timeout' }, actions: { ...NO_ACTIONS, unblock: true, retryInstall: true } }),
      mk(9, { state: 'blocked', blocker: { kind: 'budget-exhausted' }, actions: { ...NO_ACTIONS, unblock: true } })
    ]
  });
  const refused = await s.cli(['retry-install', '9']);
  assert.equal(refused.code, EXIT.NOT_ALLOWED);
  assert.deepEqual(s.fake.mutations(), []);
  const ok = await s.cli(['retry-install', '8']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /unblock شد و (اجرا شروع شد|در صف اجرا رفت)/);
  await s.waitFor(() => s.fake.calls().some(c => c.args[0] === 'run'));
  await s.waitFor(() => s.registry.activeCount() === 0);
  const names = s.fake.mutations().map(c => c.args.slice(0, 3).join(' '));
  assert.deepEqual(names.slice(0, 2), ['answer 8 --unblock', 'run 8']);
  const audit = s.audit();
  assert.equal(audit.summaries({ action: 'retry-install' })[0].user, 'remote:remote-phone');
  assert.equal(audit.summaries({ action: 'unblock' })[0].user, 'remote:remote-phone');
  assert.equal(audit.summaries({ action: 'run' })[0].user, 'remote:remote-phone');
  // سمت سرور هم مستقل از CLI: actions.retryInstall=false ⇒ 409 و هیچ فرمانی
  const direct = await fetch(`${s.base}/api/remote/tasks/9/retry-install?repo=fake`, { method: 'POST', headers: { ...bearer(s.token), 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(direct.status, 409);
  await s.stopAll();
});

// --- sync -----------------------------------------------------------------------------------------------------------------

test('sync --dry-run و sync: همان manager.js sync با پیام‌های کانبان؛ شکست با exit 6 و managerExit؛ --status', async t => {
  // بعد از sync ِ موفق کانبان capabilities را دوباره می‌خواند؛ Manager ساختگی ِ پیش‌فرض `sync` را اعلام نمی‌کند
  const inspectManager = async () => ({ ok: true, managerVersion: 'fake', contractVersion: 1, capabilities: { sync: true } });
  const s = await boot(t, { deps: { inspectManager } });
  const preview = await s.cli(['sync', '--dry-run']);
  assert.equal(preview.code, 0, preview.err);
  assert.match(preview.out, /پیش‌نمایش sync تمام شد \(exit 0\)/);
  assert.match(preview.out, /پیش‌نمایش تمام شد؛ چیزی تغییر نکرد/);
  assert.deepEqual(s.fake.calls().filter(c => c.args[0] === 'sync').map(c => c.args), [['sync', '--dry-run', '--json']]);

  const real = await s.cli(['sync', '--json']);
  assert.equal(real.code, 0, real.err);
  assert.equal(real.json().finished, true);
  assert.deepEqual(s.fake.calls().filter(c => c.args[0] === 'sync').map(c => c.args).at(-1), ['sync', '--json']);

  s.fake.setSync({ code: 52, stderr: ['CONFLICT in a.ts'], result: { ...DEFAULT_SYNC.result, ok: false, conflicts: ['a.ts'], failure: { kind: 'merge-conflict', message: 'conflict' }, exitCode: 52 } });
  const failed = await s.cli(['sync']);
  assert.equal(failed.code, EXIT.REJECTED);
  assert.match(failed.err, /برخورد \(conflict\) در merge با origin\/main/);
  assert.match(failed.err, /\[exit 52\]/);
  const failedJson = await s.cli(['sync', '--json']);
  assert.deepEqual({ exit: failedJson.json().exitCode, managerExit: failedJson.json().managerExit }, { exit: 6, managerExit: 52 });

  const rows = s.audit().summaries({});
  assert.ok(rows.some(r => r.action === 'manager.sync-preview' && r.user === 'remote:remote-phone'));
  assert.ok(rows.some(r => r.action === 'manager.update' && r.user === 'remote:remote-phone'));

  const execs = s.audit().summaries({ action: 'manager.update' });
  assert.match(execs[0].id, /^\d{14}-[0-9a-f]{8}$/);
  const status = await s.cli(['sync', '--status', execs[0].id]);
  assert.equal(status.code, EXIT.REJECTED, 'آخرین اجرا شکست خورده بود');
  assert.equal((await s.cli(['sync', '--status', 'x'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['sync', '--status', '20260101000000-00000000'])).code, EXIT.REJECTED);
  assert.equal((await s.cli(['sync', '--status', execs[0].id, '--dry-run'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['sync', 'extra'])).code, EXIT.USAGE);
});

test('sync: اجرای طولانی → چاپ execId و «barsa sync --status»؛ اجرای کنسول از /api/remote/execs دیده نمی‌شود', async t => {
  const s = await boot(t, { deps: {} });
  // sync کند: sleep در fake manager با sync.json پوشش داده نمی‌شود؛ پس سقف انتظار را صفر می‌کنیم
  const waiting = await s.cli(['sync', '--dry-run'], { env: { BARSA_SYNC_WAIT_MS: '1' } });
  assert.equal(waiting.code, 0, waiting.err);
  const match = /execId ([0-9]{14}-[0-9a-f]{8})|پیش‌نمایش sync تمام شد/.exec(waiting.out);
  assert.ok(match, waiting.out);
  // اجرایی که sync نیست (مثلاً کنسول/‌run) برای توکن remote دیده نمی‌شود
  assert.ok(await s.waitFor(() => s.audit().summaries({ action: 'manager.sync-preview.step' }).length > 0));
  const other = s.audit().summaries({ action: 'manager.sync-preview.step' })[0];
  assert.ok(await s.waitFor(() => s.audit().summaries({ action: 'manager.sync-preview' })[0]?.phases.includes('end')), 'پایان sync پیش از پاک‌سازی پوشه');
  const hidden = await fetch(`${s.base}/api/remote/execs/${other.id}`, { headers: bearer(s.token) });
  assert.equal(hidden.status, 404);
});

// --- diag ------------------------------------------------------------------------------------------------------------------

test('diag <id>: قفل مرده، dirty-worktree + recovery، بخش‌های خالی؛ ≤ ۱۵۰ خط', async t => {
  const dead = mk(7, {
    state: 'implementing',
    health: {
      ...HEALTH_OK, transitionLock: { pid: 99999, alive: false, fromState: 'implementing', startedAt: '2026-10-21T07:00:00Z' }, stuck: true, stuckReasons: ['stale-lock'],
      recovery: { suggested: 'run', reason: 'قفل با pid 99999 مرده است', commands: ['run'], mode: null, attempt: null }
    }
  });
  const dirty = mk(8, {
    health: {
      ...HEALTH_OK, dirtyPaths: ['.agent-work/tasks/8-x/attempts/003/result.yaml', 'worktree:src/a.ts'], stuck: true, stuckReasons: ['dirty-worktree'],
      recovery: { suggested: 'recover', reason: 'attempt 003 (intake) کامل است', commands: ['recover', 'run'], mode: 'process-attempt', attempt: '003' }
    },
    actions: { ...NO_ACTIONS, recover: true }
  });
  const s = await boot(t, { tasks: [dead, dirty, mk(9)], git: true, files: { '.agent-work/tasks/8-x/new.txt': 'x' } });
  s.fake.setEvents(Array.from({ length: 50 }, (_, i) => ({ at: `2026-10-21T08:${String(i).padStart(2, '0')}:00Z`, event: 'state.changed', from: 'a', to: 'b', reason: `r${i + 1}` })));

  const d7 = await s.cli(['diag', '7']);
  assert.equal(d7.code, 0, d7.err);
  assert.match(d7.out, /═══ diag تسک #7/);
  assert.match(d7.out, /قفل transition: pid 99999 مرده · از implementing/);
  assert.match(d7.out, /stuck: بله \(stale-lock\)/);
  assert.match(d7.out, /recovery: run — قفل با pid 99999 مرده است/);
  assert.match(d7.out, /install: در حال نصب نیست/);
  assert.match(d7.out, /این تسک: نه در حال اجرا و نه در صف/);
  assert.match(d7.out, /slot کامل: 0\/2 \(maxConcurrent\)/);
  assert.match(d7.out, /── 30 رویداد آخر/);
  assert.ok(d7.out.includes('r50') && !d7.out.includes('r20\n'), '۳۰ رویداد آخر');
  assert.match(d7.out, /\(اجرایی از کانبان ثبت نشده\)/);
  assert.match(d7.out, /- 7 \[implementing\]/, 'status --summary');
  assert.ok(d7.out.split('\n').length <= 150, `${d7.out.split('\n').length} خط`);

  const d8 = await s.cli(['diag', '8']);
  assert.match(d8.out, /dirtyPaths: 2 — \.agent-work\/tasks\/8-x\/attempts\/003\/result\.yaml \| worktree:src\/a\.ts/);
  assert.match(d8.out, /recovery: recover \[process-attempt #003\]/);
  assert.match(d8.out, /git status --short پوشه‌ی تسک[\s\S]*\?\? \.agent-work\/tasks\/8-x\//);
  const json = (await s.cli(['diag', '8', '--json'])).json();
  assert.equal(json.health.recovery.mode, 'process-attempt');
  assert.equal(json.queue.state, 'none');
  assert.ok(Array.isArray(json.taskDirGit.lines));
  assert.equal((await s.cli(['diag'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['diag', '7', '--system'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['diag', '999'])).code, EXIT.REJECTED);
});

test('diag <id>: worktree جامانده (وجود، git status، شاخه merge شده؟ commit ِ خودش؟، node_modules\\.bin)', async t => {
  const wt = path.join(os.tmpdir(), `barsa-ops-wt-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const s = await boot(t, { tasks: [mk(7)], git: true });
  g(s.fake.root, 'worktree', 'add', '-b', 'agent/7-x', wt);
  configureGit(wt);
  fs.writeFileSync(path.join(wt, 'feature.txt'), 'f');
  g(wt, 'add', '-A');
  g(wt, 'commit', '-m', 'own commit');
  fs.writeFileSync(path.join(wt, 'dirty.txt'), 'd');
  fs.mkdirSync(path.join(wt, 'node_modules', '.bin'), { recursive: true });
  s.fake.setStatus(board([mk(7, { worktree: { status: 'active', path: path.relative(s.fake.root, wt) }, git: { base: 'main', branch: 'agent/7-x' } })]));

  const out = (await s.cli(['diag', '7'])).out;
  assert.match(out, /وجود دارد: بله · وضعیت Manager: active/);
  assert.match(out, /شاخه: agent\/7-x \(base main\) · شاخه هست: بله · merge شده در base: خیر · commit ِ خودش: 1/);
  assert.match(out, /node_modules\\\.bin: بله/);
  assert.match(out, /\?\? dirty\.txt/);

  g(s.fake.root, 'merge', '--no-ff', 'agent/7-x', '-m', 'merge task');
  const merged = (await s.cli(['diag', '7'])).out;
  assert.match(merged, /merge شده در base: بله · commit ِ خودش: 0/);

  fs.rmSync(path.join(wt, 'node_modules'), { recursive: true, force: true });
  assert.match((await s.cli(['diag', '7'])).out, /node_modules\\\.bin: خیر/);
  // مسیر worktree ای که دیگر نیست
  g(s.fake.root, 'worktree', 'remove', '--force', wt);
  assert.match((await s.cli(['diag', '7'])).out, /وجود دارد: خیر/);
});

// باگ ِ تسک ۱۰۰۲۳: health.dirtyPaths ده مسیر می‌گفت ولی «git status» ِ worktree در diag فقط ۶ خط نشان می‌داد (پوشه‌ی untracked ِ تازه و
// یک فایل ِ دانش نبودند). علت: ۱) diag-format ِ `dirty.slice(0, 6)` بی‌صدا می‌برید؛ ۲) جمع‌آوری بدون --untracked-files=all بود پس پوشه‌ی تازه
// به یک خط ِ `?? dir/` فشرده می‌شد؛ ۳) سقف ِ ۱۵ ِ بی‌صدا در جمع‌آوری.
async function worktreeWithDirtyTree(t, { untracked }) {
  const wt = path.join(os.tmpdir(), `barsa-ops-wt-dirty-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(wt, { recursive: true, force: true }));
  const s = await boot(t, { tasks: [mk(7)], git: true });
  g(s.fake.root, 'worktree', 'add', '-b', 'agent/7-x', wt);
  configureGit(wt);
  for (const name of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
    fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
    fs.writeFileSync(path.join(wt, name), 'original');
  }
  g(wt, 'add', '-A');
  g(wt, 'commit', '-m', 'tracked files');
  for (const name of ['src/a.ts', 'src/b.ts', 'src/c.ts']) fs.writeFileSync(path.join(wt, name), 'modified');
  for (const name of untracked) {
    fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
    fs.writeFileSync(path.join(wt, name), 'new');
  }
  s.fake.setStatus(board([mk(7, { worktree: { status: 'active', path: path.relative(s.fake.root, wt) }, git: { base: 'main', branch: 'agent/7-x' } })]));
  return s;
}

test('diag <id>: worktree ِ کثیف — همه‌ی مسیرها (با پوشه‌ی untracked ِ تازه)، نه فقط ۶ خط ِ اول؛ ۱۰ مسیر = ۱۰ خط', async t => {
  const folder = 'ai-context/spdd/barsa-sap-ui/BSUI-026-feature';
  const untracked = [1, 2, 3, 4, 5, 6].map(i => `${folder}/doc${i}.md`).concat('ai-context/knowledge/shared-knowledge.md');
  const s = await worktreeWithDirtyTree(t, { untracked }); // ۳ tracked ِ تغییرکرده + ۷ untracked = ۱۰ مسیر
  const out = (await s.cli(['diag', '7'])).out;
  assert.match(out, /git status --short --untracked-files=all: 10 مسیر/);
  const section = out.slice(out.indexOf('git status --short --untracked-files=all'));
  for (const name of ['src/a.ts', 'src/b.ts', 'src/c.ts', ...untracked]) assert.ok(section.includes(name), `«${name}» در diag نیست`);
  assert.doesNotMatch(section, /و \d+ مسیر دیگر/, 'چیزی بریده نشده است');
  const json = (await s.cli(['diag', '7', '--json'])).json();
  assert.equal(json.worktree.dirtyTotal, 10);
  assert.equal(json.worktree.dirty.length, 10);
  assert.ok(json.worktree.dirty.some(line => line.includes('BSUI-026-feature/doc1.md')), 'مسیر ِ داخل ِ پوشه‌ی تازه، نه فقط «?? dir/»');
});

test('diag <id>: بیش از سقف (۴۰) — ۴۰ مسیر و «و N مسیر دیگر» با شمار ِ کل، نه بریدن ِ بی‌صدا', async t => {
  const untracked = Array.from({ length: 45 }, (_, i) => `gen/file${String(i + 1).padStart(2, '0')}.txt`);
  const s = await worktreeWithDirtyTree(t, { untracked }); // ۳ + ۴۵ = ۴۸
  const out = (await s.cli(['diag', '7'])).out;
  assert.match(out, /git status --short --untracked-files=all: 48 مسیر/);
  assert.match(out, /… و 8 مسیر دیگر/);
  const json = (await s.cli(['diag', '7', '--json'])).json();
  assert.deepEqual([json.worktree.dirty.length, json.worktree.dirtyTotal], [40, 48]);
});

test('diag <id>: صف (maxConcurrent) — queued در برابر running در برابر هیچ‌کدام', async t => {
  const s = await boot(t, { maxConcurrent: 1, run: 'setInterval(() => {}, 1000);' });
  assert.equal((await s.cli(['run', '9'])).code, 0);
  assert.equal((await s.cli(['run', '8'])).code, 0);
  assert.ok(await s.waitFor(() => s.fake.calls().some(c => c.args[0] === 'run')));
  const queued = (await s.cli(['diag', '8', '--json'])).json();
  assert.deepEqual({ state: queued.queue.state, position: queued.queue.position, used: queued.queue.slotsUsed, max: queued.queue.slotsMax, now: queued.queue.runningNow }, { state: 'queued', position: 1, used: 1, max: 1, now: ['9'] });
  assert.match((await s.cli(['diag', '8'])).out, /این تسک: در صف \(جایگاه 1\)\n.*slot کامل: 1\/1 \(maxConcurrent\) · در حال اجرا: 9/);
  assert.match((await s.cli(['diag', '9'])).out, /این تسک: در حال اجرا/);
  assert.match((await s.cli(['diag', '7'])).out, /نه در حال اجرا و نه در صف/);
  await s.stopAll();
});

test('diag <id>: نصب در جریان با فرآیند ِ ساختگی در درخت؛ فرآیند بی‌ربط نمی‌آید؛ راز در env و argv نمی‌آید', async t => {
  withEnv(t, { BARSA_TEST_SECRET_TOKEN: SECRET_ENV, BARSA_ISSUE_USER_ID: USER_ID });
  const s = await boot(t, {
    tasks: [mk(9, { health: { ...HEALTH_OK, install: { phase: 'npm-ci', startedAt: '2026-10-21T08:00:00Z', pid: 2002, alive: true, command: 'npm ci', deadlineAt: '2026-10-21T08:20:00Z' } } })],
    run: "console.log('token=' + process.env.BARSA_TEST_SECRET_TOKEN); console.log('start'); setInterval(() => {}, 1000);"
  });
  assert.equal((await s.cli(['run', '9'])).code, 0);
  assert.ok(await s.waitFor(() => s.registry.get(s.fake.repo, '9')?.child?.pid));
  const root = s.registry.get(s.fake.repo, '9').child.pid;
  s.state.procs = [
    proc(root, 4, 'node.exe', 'node manager.js run 9', 15, 3.5),
    proc(2001, root, 'cmd.exe', 'cmd.exe /d /s /c npm.cmd ci', 12),
    proc(2002, 2001, 'node.exe', `"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" ci --token=${ARGV_SECRET}`, 12, 20.2),
    proc(2003, 2002, 'cmd.exe', `cmd.exe /d /s /c node install.js --key ${SECRET_ENV}`, 9),
    proc(2004, 2003, 'node.exe', `node install.js --user ${USER_ID} Authorization: Bearer abcdefghijklmnopqrstu`, 9, 0.1),
    proc(3000, 4, 'node.exe', 'node unrelated-server.js', 50)
  ];
  const out = (await s.cli(['diag', '9'])).out;
  assert.match(out, /install: npm-ci · pid 2002 زنده/);
  assert.match(out, /── فرآیندهای مرتبط با تسک/);
  for (const pid of [root, 2001, 2002, 2003, 2004]) assert.match(out, new RegExp(`\\b${pid} ←`), `pid ${pid}`);
  assert.doesNotMatch(out, /unrelated-server/);
  assert.match(out, /سن\s+12m/);
  assert.match(out, /CPU 20\.2s/);
  assert.match(out, /در حال اجرا/);
  for (const secret of [ARGV_SECRET, SECRET_ENV, USER_ID, 'abcdefghijklmnopqrstu']) assert.ok(!out.includes(secret), `نباید بیاید: ${secret}`);
  const json = JSON.stringify((await s.cli(['diag', '9', '--json'])).json());
  for (const secret of [ARGV_SECRET, SECRET_ENV, USER_ID]) assert.ok(!json.includes(secret), `json: ${secret}`);
  for (const proc of (await s.cli(['diag', '9', '--json'])).json().processes) assert.ok(proc.cmd.length <= 120);
  await s.stopAll();
});

test('diag --system: سرویس، فرآیندها، قفل‌ها، sync/execution، git، دیسک، PATH ِ ابزارها (نه خود PATH)، issue، kanban.err.log (۳۰ خط)', async t => {
  withEnv(t, { BARSA_TEST_SECRET_TOKEN: SECRET_ENV, BARSA_ISSUE_USER_ID: USER_ID });
  const dead = mk(7, { health: { ...HEALTH_OK, transitionLock: { pid: 4321, alive: false, fromState: 'review', startedAt: '2026-10-21T07:00:00Z' }, stuck: true, stuckReasons: ['stale-lock'] } });
  const s = await boot(t, { tasks: [dead, mk(8)], git: true });
  fs.writeFileSync(s.errFile, `${Array.from({ length: 60 }, (_, i) => `err line ${i + 1}`).join('\n')}\nAuthorization: Bearer abcdefghijklmnopqrstu token ${SECRET_ENV}\n`);
  s.state.procs = [
    proc(100, 4, 'node.exe', 'node server/src/index.js', 600, 55),
    proc(101, 100, 'cmd.exe', 'cmd.exe /d /s /c npm.cmd ci', 7),
    proc(102, 4, 'claude.exe', `claude --resume --api-key ${ARGV_SECRET}`, 3),
    proc(103, 4, 'chrome.exe', 'chrome.exe --type=renderer', 100),
    proc(104, 4, 'cmd.exe', 'cmd.exe /k', 100)
  ];
  const result = await s.cli(['diag', '--system']);
  assert.equal(result.code, 0, result.err);
  const out = result.out;
  assert.match(out, /═══ diag سیستم/);
  assert.match(out, /سرویس کانبان: pid \d+ · شروع .* · node v/);
  assert.match(out, /── فرآیندهای node\/npm\/claude\/git \(3\)/);
  assert.match(out, /node\.exe[\s\S]*claude\.exe/);
  assert.doesNotMatch(out, /chrome\.exe|cmd\.exe \/k/);
  assert.match(out, /تسک #7 \[implementing\]: pid 4321 مرده · از review/);
  assert.match(out, /گیرکرده: #7\(stale-lock\)/);
  assert.match(out, /slotهای کانبان: 0\/2/);
  assert.match(out, /sync: main ↔ origin\/main · ahead 0 \/ behind 0/);
  assert.match(out, /execution: روشن/);
  assert.match(out, /git worktree list:\n\s+.*main/);
  assert.match(out, /گیگابایت آزاد/);
  assert.match(out, /node: \S/);
  assert.match(out, /تعداد issue برگشتی: 2/);
  assert.ok(out.includes('err line 60') && out.includes('err line 32') && !out.includes('err line 31\n'), '۳۰ خط آخر');
  assert.ok(!out.includes(process.env.PATH), 'خود PATH چاپ نمی‌شود');
  for (const secret of [ARGV_SECRET, SECRET_ENV, USER_ID, 'abcdefghijklmnopqrstu']) assert.ok(!out.includes(secret), `نباید بیاید: ${secret}`);
  const json = (await s.cli(['diag', '--system', '--json'])).json();
  assert.deepEqual(Object.keys(json).sort(), ['disk', 'errLog', 'generatedAt', 'git', 'issues', 'locks', 'processes', 'repository', 'service', 'slots', 'tools']);
  assert.equal(json.issues.count, 2);
  assert.equal(typeof json.tools.node, 'string');
  assert.equal(json.errLog.lines.length, 30);
  assert.equal((await s.cli(['diag', '--system', '7'])).code, EXIT.USAGE);

  // پورتال خراب: فقط همان بخش خطا می‌شود
  s.state.issues = null;
  const broken = await s.cli(['diag', '--system']);
  assert.equal(broken.code, 0);
});

// --- kill-stuck-install ------------------------------------------------------------------------------------------------

test('kill-stuck-install: فقط lifecycle scriptهای قدیمی ِ زیر npm ci ِ همین تسک؛ فرآیند بیرون از درخت (argv یکسان) دست‌نخورده', async t => {
  const s = await boot(t, { run: 'setInterval(() => {}, 1000);' });
  const refusedNoRun = await s.cli(['kill-stuck-install', '9']);
  assert.equal(refusedNoRun.code, EXIT.REJECTED);
  assert.match(refusedNoRun.err, /از طرف کانبان اجرا نمی‌شود/);
  assert.deepEqual(s.state.killed, []);

  assert.equal((await s.cli(['run', '9'])).code, 0);
  assert.ok(await s.waitFor(() => s.registry.get(s.fake.repo, '9')?.child?.pid));
  const root = s.registry.get(s.fake.repo, '9').child.pid;

  s.state.procs = [proc(root, 4, 'node.exe', 'node manager.js run 9', 15)];
  const noCi = await s.cli(['kill-stuck-install', '9']);
  assert.equal(noCi.code, EXIT.REJECTED);
  assert.match(noCi.err, /npm ci در حال اجرا نیست/);

  const lifecycleCmd = 'cmd.exe /d /s /c node install.js';
  s.state.procs = [
    proc(root, 4, 'node.exe', 'node manager.js run 9', 15),
    proc(2001, root, 'cmd.exe', 'cmd.exe /d /s /c npm.cmd ci', 12),
    proc(2002, 2001, 'node.exe', '"node.exe" "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" ci', 12),
    proc(2003, 2002, 'cmd.exe', lifecycleCmd, 9), // قدیمی: بسته می‌شود
    proc(2004, 2003, 'node.exe', 'node install.js', 9), // نوه: با taskkill /T همراه پدرش بسته می‌شود، جدا زده نمی‌شود
    proc(2005, 2002, 'cmd.exe', 'cmd.exe /d /s /c node other.js', 1), // جوان: می‌ماند
    proc(3001, 4, 'cmd.exe', lifecycleCmd, 30), // بیرون از درخت، argv یکسان: دست‌نخورده
    proc(3002, 3001, 'node.exe', 'node install.js', 30)
  ];
  const result = await s.cli(['kill-stuck-install', '9']);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(s.state.killed, [2003]);
  assert.match(result.out, /1 lifecycle script ِ گیرکرده \(بیش از 5 دقیقه\) بسته شد/);
  assert.match(result.out, /✗ pid 2003 cmd\.exe · 9m · cmd\.exe \/d \/s \/c node install\.js/);
  assert.match(result.out, /ماند \(جوان‌تر از 5 دقیقه\): pid 2005 1m/);
  assert.ok(!s.state.killed.includes(3001) && !s.state.killed.includes(2001) && !s.state.killed.includes(2002) && !s.state.killed.includes(root));
  const row = s.audit().summaries({ action: 'kill-stuck-install' })[0];
  assert.equal(row.user, 'remote:remote-phone');
  assert.equal(row.status, 'ok');
  assert.match(row.note, /2003/);

  // آستانه‌ی بزرگ‌تر: هیچ‌چیز بسته نمی‌شود
  s.state.killed.length = 0;
  const none = await s.cli(['kill-stuck-install', '9', '--minutes', '20', '--json']);
  assert.deepEqual(none.json().killed, []);
  assert.deepEqual(s.state.killed, []);
  // pid در عکس تازه نیست (مرد): بسته نمی‌شود
  const later = await s.cli(['kill-stuck-install', '9', '--minutes', '1']);
  assert.deepEqual([...s.state.killed].sort(), [2003, 2005].sort(), 'minutes=1: هر دو قدیمی‌تر از ۱ دقیقه ‌اند');
  assert.equal(later.code, 0);

  assert.equal((await s.cli(['kill-stuck-install', '9', '--minutes', '0'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['kill-stuck-install', '9', '--minutes', 'x'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['kill-stuck-install'])).code, EXIT.USAGE);
  assert.equal((await s.cli(['kill-stuck-install', '9', '1234'])).code, EXIT.USAGE, 'pid دلخواه پذیرفته نمی‌شود');
  await s.stopAll();
});

test('kill-stuck-install: ریشه فقط از registry ِ کانبان؛ تسک دیگری که در registry نیست ← رد حتی اگر npm ci با نام او در سیستم باشد', async t => {
  const s = await boot(t, { run: 'setInterval(() => {}, 1000);' });
  assert.equal((await s.cli(['run', '9'])).code, 0);
  assert.ok(await s.waitFor(() => s.registry.get(s.fake.repo, '9')?.child?.pid));
  s.state.procs = [
    proc(5001, 4, 'cmd.exe', 'cmd.exe /d /s /c npm.cmd ci   REM task 8', 30),
    proc(5002, 5001, 'node.exe', 'node npm-cli.js ci', 30),
    proc(5003, 5002, 'cmd.exe', 'cmd.exe /c node install.js', 25)
  ];
  const other = await s.cli(['kill-stuck-install', '8']);
  assert.equal(other.code, EXIT.REJECTED);
  const mine = await s.cli(['kill-stuck-install', '9']);
  assert.equal(mine.code, EXIT.REJECTED, 'درخت تسک ۹ این فرآیندها را ندارد');
  assert.deepEqual(s.state.killed, []);
  assert.ok(s.audit().readAll().some(r => r.phase === 'rejected' && r.action === 'kill-stuck-install'));
  await s.stopAll();
});

// --- bundle ----------------------------------------------------------------------------------------------------------------

test('bundle: zip ِ پوشانده‌شده (task/ + diag.txt + لاگ + MANIFEST)؛ دودویی رد؛ مسیر چاپ می‌شود؛ ممیزی؛ دانلود UI با رد ِ traversal', async t => {
  withEnv(t, { BARSA_TEST_SECRET_TOKEN: SECRET_ENV, BARSA_ISSUE_USER_ID: USER_ID });
  const files = {
    '.agent-work/tasks/7-x/request.md': `درخواست با توکن ghp_abcdefghijklmnop12345 و ${SECRET_ENV}`,
    '.agent-work/tasks/7-x/human/note.md': `شناسه ${USER_ID}`,
    '.agent-work/tasks/7-x/attempts/001/result.yaml': 'role: intake\n',
    '.agent-work/tasks/7-x/blob.bin': Buffer.from([1, 2, 0, 3, 4]).toString('latin1')
  };
  const s = await boot(t, { tasks: [mk(7)], files, run: "console.log('hello log ' + process.env.BARSA_TEST_SECRET_TOKEN);" });
  fs.writeFileSync(path.join(s.fake.root, '.agent-work/tasks/7-x/blob.bin'), Buffer.from([1, 2, 0, 3, 4]));
  assert.equal((await s.cli(['run', '7'])).code, 0);
  await s.waitFor(() => s.registry.activeCount() === 0 && s.registry.get(s.fake.repo, '7')?.finished);

  const result = await s.cli(['bundle', '7']);
  assert.equal(result.code, 0, result.err);
  const match = /bundle ساخته شد: (.+\.zip)\n/.exec(result.out);
  assert.ok(match, result.out);
  const file = match[1];
  assert.equal(path.dirname(file), path.join(s.dataDir, 'bundles'));
  assert.match(path.basename(file), /^7-\d{8}-\d{6}\.zip$/);
  assert.ok(fs.statSync(file).size > 100);
  const entries = unzip(fs.readFileSync(file));
  const names = Object.keys(entries).sort();
  assert.ok(names.includes('task/request.md') && names.includes('task/human/note.md') && names.includes('task/attempts/001/result.yaml'));
  assert.ok(names.includes('diag.txt') && names.includes('MANIFEST.txt'));
  assert.ok(names.some(n => /^run-\d{14}-[0-9a-f]{8}\.log$/.test(n)), names.join(','));
  assert.ok(!names.includes('task/blob.bin'));
  assert.match(entries['MANIFEST.txt'].toString('utf8'), /task\/blob\.bin|blob\.bin: دودویی/);
  assert.match(entries['diag.txt'].toString('utf8'), /═══ diag تسک #7/);
  const all = Object.values(entries).map(b => b.toString('utf8')).join('\n');
  for (const secret of [SECRET_ENV, USER_ID, 'ghp_abcdefghijklmnop12345']) assert.ok(!all.includes(secret), `در bundle نباید باشد: ${secret}`);
  assert.match(all, /\[MASKED\]/);
  assert.ok(!fs.readFileSync(file).includes(Buffer.from(SECRET_ENV)));

  const audit = s.audit().readAll().find(r => r.action === 'bundle.create');
  assert.equal(audit.user, 'remote:remote-phone');
  assert.equal(audit.file, path.basename(file));

  // رابط کاربری (نشست کوکی): فهرست و دانلود
  const list = await (await authedFetch(`${s.base}/api/bundles`)).json();
  assert.deepEqual(list.map(x => x.name), [path.basename(file)]);
  const download = await authedFetch(`${s.base}/api/bundles/${encodeURIComponent(path.basename(file))}`);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/zip');
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fs.readFileSync(file));
  assert.ok(s.audit().readAll().some(r => r.action === 'bundle.download'));

  // path traversal و نام نامعتبر
  fs.writeFileSync(path.join(s.dataDir, 'secret.zip'), 'zip-outside');
  for (const bad of ['..%2Fsecret.zip', '..%5Csecret.zip', '%2e%2e%2fsecret.zip', encodeURIComponent(path.join(s.dataDir, 'secret.zip')), 'audit.jsonl', '..', '.zip', `${encodeURIComponent(path.basename(file))}%00`, 'a..b.zip']) {
    const response = await authedFetch(`${s.base}/api/bundles/${bad}`);
    assert.equal(response.status, 404, bad);
    assert.ok(!(await response.text()).includes('zip-outside'));
  }
  // توکن remote به لیست/دانلود دسترسی ندارد (در REMOTE_ENDPOINTS نیست)
  assert.equal((await fetch(`${s.base}/api/bundles`, { headers: bearer(s.token) })).status, 403);
  assert.equal((await fetch(`${s.base}/api/bundles/${encodeURIComponent(path.basename(file))}`, { headers: bearer(s.token) })).status, 403);
});

test('bundle: پوشه‌ی تسک نبود / task نبود = رد روشن؛ پوشه‌ی خارج از .agent-work/tasks رد می‌شود', async t => {
  const s = await boot(t, { tasks: [mk(7), mk(8, { dir: '../outside' }), mk(9, { dir: undefined })] });
  assert.equal((await s.cli(['bundle', '7'])).code, EXIT.REJECTED, 'پوشه روی دیسک نیست');
  const outside = await s.cli(['bundle', '8']);
  assert.equal(outside.code, EXIT.REJECTED);
  assert.match(outside.err, /خارج از \.agent-work\/tasks|پیدا نشد/);
  assert.equal((await s.cli(['bundle', '999'])).code, EXIT.REJECTED);
  assert.equal((await s.cli(['bundle'])).code, EXIT.USAGE);
  assert.deepEqual(fs.existsSync(path.join(s.dataDir, 'bundles')) ? fs.readdirSync(path.join(s.dataDir, 'bundles')) : [], []);
});

// --- فهرست بسته و ممیزی ---------------------------------------------------------------------------------------------------

test('هر endpoint ِ تازه در REMOTE_ENDPOINTS است، هر endpoint ِ بازِ remote به یک فرمان نام‌دار می‌خورد، و هیچ endpoint ِ تازه‌ای باز نیست', () => {
  const used = new Set(Object.values(COMMAND_ENDPOINTS).flat().map(([m, p]) => `${m} ${p}`));
  const implicit = new Set(['GET /api/auth/session', 'GET /api/repos']);
  for (const [method, pattern] of REMOTE_ENDPOINTS) {
    assert.ok(used.has(`${method} ${pattern}`) || implicit.has(`${method} ${pattern}`), `endpoint بدون فرمان: ${method} ${pattern}`);
  }
  for (const needed of [
    'GET /api/remote/tasks/:id/artifact', 'GET /api/remote/tasks/:id/diag', 'GET /api/remote/diag/system', 'GET /api/remote/execs/:id',
    'POST /api/remote/tasks/:id/bundle', 'POST /api/remote/tasks/:id/recover', 'POST /api/remote/tasks/:id/retry-install',
    'POST /api/remote/tasks/:id/kill-stuck-install', 'POST /api/remote/sync', 'POST /api/repos/:repo/tasks/:id/allow-shared-knowledge-file'
  ]) assert.ok(REMOTE_ENDPOINTS.some(([m, p]) => `${m} ${p}` === needed), needed);
  // چیزهایی که باید بسته بمانند
  for (const closed of ['POST /api/repos/:repo/tasks/:id/abandon', 'POST /api/repos/:repo/tasks/:id/void', 'POST /api/repos/:repo/tasks/:id/unlock', 'POST /api/repos/:repo/tasks/:id/cancel', 'POST /api/console/exec', 'POST /api/repos/:repo/manager/update', 'GET /api/bundles', 'GET /api/bundles/:name']) {
    assert.ok(!REMOTE_ENDPOINTS.some(([m, p]) => `${m} ${p}` === closed), closed);
  }
});

test('هر اکشن ِ نوشتنی ِ تازه با توکن remote ردیف ممیزی با actor remote:<name> می‌گذارد؛ بدون توکن 401/ با آدرس غیر-loopback 403', async t => {
  const s = await boot(t, { tasks: [mk(7, { actions: { ...NO_ACTIONS, recover: true, retryInstall: true, unblock: true }, health: { ...HEALTH_OK, recovery: { suggested: 'recover', mode: 'process-attempt', reason: 'x', commands: [] } } })], files: { '.agent-work/tasks/7-x/a.md': 'a' } });
  const post = (p, body = {}) => fetch(`${s.base}${p}`, { method: 'POST', headers: { ...bearer(s.token), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/remote/tasks/7/bundle')).status, 200);
  assert.equal((await post('/api/remote/tasks/7/recover')).status, 200);
  assert.equal((await post('/api/remote/tasks/7/retry-install')).status, 200);
  assert.equal((await post('/api/remote/tasks/7/kill-stuck-install')).status, 409);
  assert.equal((await post('/api/remote/sync', { dryRun: true })).status, 202);
  await s.waitFor(() => s.registry.activeCount() === 0);
  assert.ok(await s.waitFor(() => s.audit().summaries({ action: 'manager.sync-preview' })[0]?.phases.includes('end')));
  const rows = s.audit().summaries({});
  for (const action of ['bundle.create', 'recover', 'retry-install', 'kill-stuck-install', 'manager.sync-preview']) {
    const row = rows.find(r => r.action === action);
    assert.ok(row, action);
    assert.equal(row.user, 'remote:remote-phone', action);
  }
  assert.equal((await fetch(`${s.base}/api/remote/tasks/7/diag`)).status, 401);
  assert.equal((await fetch(`${s.base}/api/remote/diag/system`)).status, 401);
  s.addr.value = '203.0.113.9';
  assert.equal((await fetch(`${s.base}/api/remote/tasks/7/diag`, { headers: bearer(s.token) })).status, 403);
  s.addr.value = '127.0.0.1';
  assert.equal((await post('/api/remote/tasks/bad%20id/recover')).status, 400);
  assert.equal((await fetch(`${s.base}/api/remote/tasks/7/artifact?name=questions.md&tail=abc`, { headers: bearer(s.token) })).status, 400);
  await s.stopAll();
});

// --- واحدها: لیست فرآیند، درخت، تشخیص npm ci، redact -----------------------------------------------------------------------

test('process-list: parseWindowsProcesses (آرایه/تک‌شیء/خراب)، parsePsProcesses، descendantsOf با محافظ استفاده‌ی دوباره‌ی pid', () => {
  const one = parseWindowsProcesses('{"pid":5,"ppid":1,"name":"node.exe","cmd":"node a.js","start":"2026-10-21T08:00:00.0000000Z","cpu":1.5}');
  assert.deepEqual(one.map(p => [p.pid, p.ppid, p.name, p.cmd, p.cpuSeconds]), [[5, 1, 'node.exe', 'node a.js', 1.5]]);
  assert.equal(one[0].startedAt, Date.parse('2026-10-21T08:00:00Z'));
  assert.equal(parseWindowsProcesses('[{"pid":1,"ppid":0,"name":"System","cmd":null,"start":null,"cpu":0},{"nope":1}]').length, 1);
  assert.deepEqual(parseWindowsProcesses('not json'), []);
  assert.deepEqual(parseWindowsProcesses(''), []);

  const ps = parsePsProcesses('  10     1   300   12 /usr/bin/node server.js --x\n garbage\n  11    10    20    0 npm ci\n', 1_000_000);
  assert.deepEqual(ps.map(p => [p.pid, p.ppid, p.name, p.cmd]), [[10, 1, 'node', '/usr/bin/node server.js --x'], [11, 10, 'npm', 'npm ci']]);
  assert.equal(ps[0].startedAt, 1_000_000 - 300_000);

  const now = Date.now();
  const list = [
    { pid: 1, ppid: 0, startedAt: now - 100_000 }, { pid: 2, ppid: 1, startedAt: now - 90_000 }, { pid: 3, ppid: 2, startedAt: now - 80_000 },
    { pid: 4, ppid: 1, startedAt: now - 500_000 } // قدیمی‌تر از پدر ⇒ pid ِ دوباره‌استفاده‌شده، فرزند او نیست
  ];
  assert.deepEqual(descendantsOf(list, 1).map(p => p.pid), [2, 3]);
  assert.deepEqual(descendantsOf(list, 99), []);
  assert.deepEqual(descendantsOf([{ pid: 1, ppid: 1 }], 1), [], 'حلقه');
});

test('process-list: isNpmCi فقط npm ci ِ واقعی؛ relatedToTask با بذر (worktree / پوشه‌ی تسک / manager.js <id>) و نوادگان', () => {
  const p = (name, cmd) => ({ pid: 1, ppid: 0, name, cmd });
  assert.equal(isNpmCi(p('cmd.exe', 'cmd.exe /d /s /c npm.cmd ci --omit=optional')), true);
  assert.equal(isNpmCi(p('node.exe', '"node.exe" "C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js" ci')), true);
  assert.equal(isNpmCi(p('npm', 'npm ci')), true);
  for (const [name, cmd] of [['node.exe', 'node app.js ci'], ['npm', 'npm run ci:lint'], ['npm', 'npm install'], ['node.exe', 'node npm-cli.js install --ci-x'], ['chrome.exe', 'npm ci'], ['node.exe', 'node C:\\ci\\x.js npm']]) {
    assert.equal(isNpmCi(p(name, cmd)), false, cmd);
  }
  const procs = [
    { pid: 10, ppid: 1, name: 'node.exe', cmd: 'node scripts/manager.js run 7' },
    { pid: 11, ppid: 10, name: 'cmd.exe', cmd: 'cmd /c whatever' },
    { pid: 20, ppid: 1, name: 'node.exe', cmd: 'node C:\\agent-worktrees\\7-x\\node_modules\\x\\install.js' },
    { pid: 21, ppid: 20, name: 'node.exe', cmd: 'node child.js' },
    { pid: 30, ppid: 1, name: 'node.exe', cmd: 'node scripts/manager.js run 70' },
    { pid: 40, ppid: 1, name: 'node.exe', cmd: 'node C:/repo/.agent-work/tasks/7-x/probe.js' },
    { pid: 50, ppid: 1, name: 'node.exe', cmd: 'node other.js' },
    { pid: 60, ppid: 1, name: 'node.exe', cmd: 'node reg-root.js' }
  ];
  const related = relatedToTask(procs, { taskId: '7', worktreePath: 'C:/agent-worktrees/7-x', taskDir: 'C:/repo/.agent-work/tasks/7-x', rootPids: [60] });
  assert.deepEqual(related.map(x => x.pid), [10, 11, 20, 21, 40, 60]);
});

test('ownHelperPids: فرزندان کمکی ِ خود سرویس (status/git/powershell ِ diag) پنهان می‌شوند، مگر زیر ریشه‌ی اجرای ثبت‌شده', () => {
  const self = 500;
  const procs = [
    { pid: self, ppid: 1 }, { pid: 501, ppid: self }, { pid: 502, ppid: 501 }, // کمکی (manager.js status ← git)
    { pid: 600, ppid: self }, { pid: 601, ppid: 600 }, // ریشه‌ی اجرای ثبت‌شده ← فرزند
    { pid: 700, ppid: 1 } // بی‌ربط
  ];
  assert.deepEqual([...ownHelperPids(procs, { selfPid: self, rootPids: [600] })].sort(), [501, 502]);
  assert.deepEqual([...ownHelperPids(procs, { selfPid: self })].sort(), [501, 502, 600, 601]);
});

test('listProcesses (واقعی): فرآیند جاری با pid، پدر و زمان شروع دیده می‌شود', async t => {
  let all;
  try { all = await listProcesses(); } catch (error) { t.skip(`لیست فرآیند در این محیط ممکن نیست: ${error.message}`); return; }
  const me = all.find(p => p.pid === process.pid);
  assert.ok(me, 'فرآیند جاری');
  assert.equal(me.ppid, process.ppid);
  assert.match(me.name, /node/i);
  assert.ok(me.startedAt && Math.abs(me.startedAt - (Date.now() - process.uptime() * 1000)) < 120_000);
  assert.ok(all.length > 5);
});

test('whichOnPath: فقط جایی که برنامه پیدا شد (با PATHEXT)، نه خود PATH؛ مطلق؛ نبود = null', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-which-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'faketool.cmd'), '@echo off');
  fs.writeFileSync(path.join(dir, 'plain'), '#!/bin/sh');
  assert.equal(whichOnPath('faketool', { PATH: `${path.join(dir, 'none')};${dir}`, PATHEXT: '.EXE;.cmd' }, 'win32'), path.join(dir, 'faketool.cmd'));
  assert.equal(whichOnPath('missing', { PATH: dir, PATHEXT: '.EXE' }, process.platform), null);
  assert.equal(whichOnPath(path.join(dir, 'plain'), { PATH: '' }, process.platform), path.join(dir, 'plain'));
  if (process.platform !== 'win32') assert.equal(whichOnPath('plain', { PATH: dir }, process.platform), path.join(dir, 'plain'));
});

test('redact: الگوهای تازه (Bearer با فاصله، --password x، PEM، AKIA، user:pass@) و نام متغیرهای تازه (USER_ID، CREDENTIAL، COOKIE)', t => {
  withEnv(t, { BARSA_ISSUE_USER_ID: USER_ID, SOME_CREDENTIAL_X: 'credential-value-xyz', MY_COOKIE_JAR: 'cookie-value-abc123' });
  const secrets = environmentSecrets();
  for (const value of [USER_ID, 'credential-value-xyz', 'cookie-value-abc123']) assert.ok(secrets.includes(value), value);
  const text = [
    'Authorization: Bearer abcdefghijklmnop', 'curl --password hunter2secret x', 'tool --token=abc123token456 y', 'AKIAABCDEFGHIJKLMNOP',
    'git clone https://user:pa55w0rd@example.com/r.git', '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf\n-----END RSA PRIVATE KEY-----', USER_ID
  ].join('\n');
  const out = redact(text, secrets);
  for (const leak of ['abcdefghijklmnop', 'hunter2secret', 'abc123token456', 'AKIAABCDEFGHIJKLMNOP', 'pa55w0rd', 'MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf', USER_ID]) assert.ok(!out.includes(leak), leak);
  assert.match(out, /https:\/\/\[MASKED\]@example\.com/);
  // متن عادی دست نمی‌خورد (sha، مسیر، --author)
  const plain = 'commit 0123456789abcdef0123456789abcdef01234567 --author=me C:/repo/src/app.ts --tail 40';
  assert.equal(redact(plain, secrets), plain);
});
