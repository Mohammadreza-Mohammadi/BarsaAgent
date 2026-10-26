import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { RemoteTokenStore } from '../src/remote-tokens.js';
import { run as barsa, HELP } from '../src/remote-cli.js';
import { EXIT, READ_COMMANDS, WRITE_COMMANDS, COMMAND_ENDPOINTS, REMOTE_ENDPOINTS } from '../src/remote-cli-spec.js';
import { evaluate } from '../../docs/remote-control/guard.mjs';
import { answerRuntimeArgs, createRuntimeFlags, structuredFailure } from '../src/runtime-args.js';
import { syncInfoFromStatus } from '../src/manager-update.js';

const ROOT = new URL('../../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, ROOT), 'utf8');

// --- fixtureها --------------------------------------------------------------------------------------------------------

const eff = (provider, model, effort, source = 'default') => ({ provider, model, requestedModel: model, effort, source, fieldSources: { provider: source, model: source, effort: source } });
const DEFAULTS = {
  intake: eff('claude', 'claude-sonnet-5-5', 'medium'), architect: eff('claude', 'claude-opus-5-5', 'high'),
  implementer: eff('claude', 'claude-sonnet-5-5', 'high'), reviewer: eff('claude', 'claude-opus-5-5', 'high')
};
const NO_ACTIONS = {
  approve: false, reject: false, clarify: false, note: false, unblock: false, raiseLimit: [], closeOrphan: [], allowPath: false,
  allowSharedKnowledgeFile: false, externalAccess: [], resetExternal: [], cancel: false, abandon: false, void: false, unlock: false,
  recover: false, retryProvision: false, retryInstall: false, setRuntime: false
};
const runtime = (extra = {}) => ({ stored: { preset: null, roles: {} }, effective: DEFAULTS, summary: null, pending: [], effectiveAfterPending: null, error: null, ...extra });
const attemptRuntime = { provider: 'claude', model: 'sonnet', requestedModel: 'claude-sonnet-5-5', actualModels: ['claude-sonnet-5-5'], outerModel: null, requestedEffort: 'high', effectiveEffort: 'high', source: 'default', preset: null };
const TAIL = Array.from({ length: 45 }, (_, i) => `build-line-${i + 1}`);

const STATUS = {
  schemaVersion: 1, generatedAt: '2026-10-25T09:00:00Z', repo: { head: 'f'.repeat(40) },
  repository: {
    health: { managerLock: null, unownedDirtyFiles: [], acceptsOperations: true }, execution: { enabled: true, source: 'default', reason: null },
    localConfig: { path: 'x', present: false, applied: false, keys: [] }, sync: { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, lastFetchAt: '2026-10-25T08:00:00Z' }
  },
  tasks: [
    {
      id: '7', title: 'تسک زنده', state: 'implementing', stateSince: '2026-10-25T08:10:00Z', awaitingHuman: null, blocker: null, dir: '.agent-work/tasks/0007-x',
      roles: { current: 'implementer', next: 'reviewer' },
      actions: { ...NO_ACTIONS, setRuntime: true, note: true },
      runtime: runtime({
        stored: { preset: 'heavy', roles: { implementer: { effort: 'max' } } }, summary: 'preset heavy · implementer effort=max',
        effective: { ...DEFAULTS, implementer: eff('claude', 'claude-sonnet-5-5', 'max', 'task-role') },
        pending: [{ decision: 3, queuedAt: '2026-10-25T08:30:00Z', reason: 'second try', state: 'implementing', change: { roles: { implementer: { effort: 'xhigh' } } } }],
        effectiveAfterPending: { ...DEFAULTS, implementer: eff('claude', 'claude-sonnet-5-5', 'xhigh', 'task-role') }
      }),
      attempts: [
        { n: 1, id: '001', role: 'intake', outcome: 'completed', at: 't', runtime: null },
        { n: 2, id: '002', role: 'implementer', outcome: null, at: 't', runtime: { ...attemptRuntime, requestedEffort: 'max', effectiveEffort: 'high' } }
      ],
      lastAttempt: { n: 2, role: 'implementer', outcome: null, at: 't', runtime: attemptRuntime }
    },
    {
      id: '8', title: 'شکست build', state: 'blocked', previousState: 'ready', stateSince: '2026-10-25T07:00:00Z', awaitingHuman: null, dir: '.agent-work/tasks/0008-x',
      blocker: { kind: 'environment', stage: 'build', step: 'npx ng build barsa-echarts', log: '.agent-work/tasks/0008-x/baseline.log', outputTail: TAIL, detail: 'build شکست خورد' },
      actions: { ...NO_ACTIONS, retryProvision: true, retryInstall: true, setRuntime: true, recover: true },
      health: {
        transitionLock: null, dirtyPaths: ['a.txt'], stuck: true, stuckReasons: ['dirty-worktree'],
        recovery: { suggested: 'recover', reason: 'commit شکست خورد', commands: ['recover'], mode: 'discard-residue', attempt: null,
          commitFailure: { at: '2026-10-25T06:00:00Z', message: 'commit hook failed', leftover: ['.agent-work/tasks/0008-x/new.md'], recoverCommand: 'node scripts/manager.js recover 8 --discard-residue --reason "…"' } }
      },
      runtime: runtime(), attempts: [], lastAttempt: null
    },
    { id: '9', title: 'فقط alias', state: 'blocked', previousState: 'ready', blocker: { kind: 'environment', stage: 'install' }, actions: { ...NO_ACTIONS, retryInstall: true }, runtime: runtime(), attempts: [] },
    { id: '10', title: 'تمام', state: 'integrated', stateSince: '2026-10-20T00:00:00Z', actions: { ...NO_ACTIONS }, runtime: runtime(), attempts: [] },
    { id: '11', title: 'بدون runtime', state: 'ready', actions: { ...NO_ACTIONS }, attempts: [] }
  ]
};

async function boot(t, { status = STATUS, run, deps = {}, config = {} } = {}) {
  const fake = makeFakeManagerRepo(t, { status, run });
  const { base, config: cfg } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, run: { proxy: '' }, ...config }, { remoteAddress: () => '127.0.0.1', issueFetcher: async () => [{ externalId: '4201', title: 'Issue', body: 'متن' }], ...deps });
  const store = new RemoteTokenStore(cfg.dataDir);
  store.create('remote-phone');
  const tokenFile = path.join(cfg.dataDir, 'tokens', 'remote-phone.token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const post = (p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const get = p => authedFetch(`${base}${p}`);
  const cli = async (args, { stdin = '' } = {}) => {
    let out = ''; let err = '';
    const code = await barsa(args, {
      env: { BARSA_REMOTE_URL: base, BARSA_REMOTE_TOKEN_FILE: tokenFile }, stdout: x => { out += x; }, stderr: x => { err += x; }, stdin: Readable.from([Buffer.from(stdin, 'utf8')])
    });
    assert.ok(!out.includes(token) && !err.includes(token));
    return { code, out, err, json: () => JSON.parse(out) };
  };
  const waitIdle = async () => {
    for (let i = 0; i < 100; i += 1) {
      const running = await (await get('/api/repos/fake/running')).json();
      if (running.every(r => !r.running && !r.queued)) return;
      await new Promise(r => setTimeout(r, 50));
    }
  };
  return { fake, base, cfg, token, post, get, cli, waitIdle };
}
const answers = fake => fake.mutations().filter(c => c.args[0] === 'answer').map(c => c.args.map((a, i) => (c.args[i - 1] === '--reason-file' ? '<file>' : a)));

// --- سرور: runtime-options و تغییر --------------------------------------------------------------------------------------

test('runtime-options: عین خروجی ِ Manager (فقط‌خواندنی)، با cache ی کوتاه و ?refresh=1', async t => {
  const s = await boot(t);
  const first = await (await s.get('/api/repos/fake/runtime-options')).json();
  assert.deepEqual(first, JSON.parse(read('server/test/fixtures/runtime-options.json')));
  assert.deepEqual(Object.keys(first.providers), ['claude', 'codex']);
  const calls = () => s.fake.calls().filter(c => c.args[0] === 'runtime').length;
  assert.equal(calls(), 1);
  await s.get('/api/repos/fake/runtime-options');
  assert.equal(calls(), 1, 'cache');
  await s.get('/api/repos/fake/runtime-options?refresh=1');
  assert.equal(calls(), 2);
  assert.deepEqual(s.fake.calls().find(c => c.args[0] === 'runtime').args, ['runtime', '--options', '--json']);
  assert.equal(s.fake.mutations().length, 0, 'هیچ فرمان ِ نوشتنی');
});

test('تغییر runtime: آرگومان ِ دقیق ِ answer (--runtime / --runtime-preset / --runtime-reset) و ممیزی', async t => {
  const s = await boot(t);
  const reason = 'Need stronger model for a heavy refactor ✓';
  assert.equal((await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'set', role: 'implementer', provider: '', model: 'claude-opus-5-5', effort: 'xhigh', reason })).status, 200);
  assert.equal((await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'set', role: 'reviewer', provider: 'codex', model: 'gpt-6-sol', effort: 'high', reason })).status, 200);
  assert.equal((await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'preset', preset: 'heavy', reason })).status, 200);
  assert.equal((await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'reset', target: 'implementer', reason })).status, 200);
  assert.equal((await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'reset', target: 'all', reason })).status, 200);
  assert.deepEqual(answers(s.fake), [
    ['answer', '7', '--runtime', 'implementer=:claude-opus-5-5:xhigh', '--reason-file', '<file>'],
    ['answer', '7', '--runtime', 'reviewer=codex:gpt-6-sol:high', '--reason-file', '<file>'],
    ['answer', '7', '--runtime-preset', 'heavy', '--reason-file', '<file>'],
    ['answer', '7', '--runtime-reset', 'implementer', '--reason-file', '<file>'],
    ['answer', '7', '--runtime-reset', 'all', '--reason-file', '<file>']
  ]);
  assert.deepEqual(s.fake.files().map(f => f.text), Array(5).fill(reason), 'reason همیشه از فایل UTF-8');
  const audit = (await (await s.get('/api/audit?limit=50')).json()).filter(r => r.action === 'runtime' && r.status === 'ok');
  assert.equal(audit.length, 5);
});

test('تغییر runtime: شکل ِ ورودی رد می‌شود (400) و Manager اصلاً صدا زده نمی‌شود؛ reason اجباری', async t => {
  const s = await boot(t);
  const reason = 'x';
  for (const body of [
    { mode: 'set', role: 'Implementer', provider: 'claude', model: 'm', effort: 'high', reason },
    { mode: 'set', role: 'implementer', provider: 'claude;rm', model: 'm', effort: 'high', reason },
    { mode: 'set', role: 'implementer', provider: '', model: '', effort: '', reason },
    { mode: 'set', role: 'implementer', provider: 'a', model: 'b c', effort: 'high', reason },
    { mode: 'preset', preset: '../x', reason },
    { mode: 'reset', target: 'two words', reason },
    { mode: 'wat', reason },
    { mode: 'set', role: 'implementer', provider: '', model: '', effort: 'high', reason: '   ' },
    { mode: 'set', role: 'implementer', provider: '', model: '', effort: 'high' }
  ]) {
    const response = await s.post('/api/repos/fake/tasks/7/runtime', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(s.fake.mutations().length, 0);
});

test('خطای Manager عیناً (422)، runtime ِ نامعتبر به‌صورت ساختاریافته، در صف نشستن، و اجرای خاموش (41)', async t => {
  const s = await boot(t);
  const body = { mode: 'set', role: 'implementer', provider: '', model: '', effort: 'ultra', reason: 'r' };
  s.fake.setFail({ answer: { code: 1, stderr: 'runtime نامعتبر است: effort "ultra" مجاز نیست' } });
  const plain = await s.post('/api/repos/fake/tasks/7/runtime', body);
  assert.equal(plain.status, 422);
  assert.match((await plain.json()).error, /effort "ultra" مجاز نیست/);

  s.fake.setFail({ answer: { code: 45, stdout: JSON.stringify({ ok: false, error: 'runtime-invalid', exitCode: 45, code: 'unknown-effort', message: 'effort "ultra" برای claude مجاز نیست', details: { role: 'implementer' } }) } });
  const structured = await (await s.post('/api/repos/fake/tasks/7/runtime', body)).json();
  assert.equal(structured.structured.kind, 'runtime-invalid');
  assert.equal(structured.structured.role, 'implementer');
  assert.match(structured.error, /effort برای این مدل مجاز نیست.*ultra/);
  assert.equal(structured.managerExit, 45);

  s.fake.setFail({ answer: { code: 0, stdout: 'تغییر ِ runtime ِ Task 7 در صف ثبت و commit شد (decision 004)' } });
  const queued = await (await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'preset', preset: 'heavy', reason: 'r' })).json();
  assert.equal(queued.queued, true);
  s.fake.setFail({});
  const direct = await (await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'preset', preset: 'heavy', reason: 'r' })).json();
  assert.equal(direct.queued, false);
});

test('اجرا خاموش: تغییر ِ runtime پیش از هر کاری 409 با managerExit 41', async t => {
  const off = { ...STATUS, repository: { ...STATUS.repository, execution: { enabled: false, source: 'local', reason: 'اجرا خاموش است' } } };
  const s = await boot(t, { status: off });
  const response = await s.post('/api/repos/fake/tasks/7/runtime', { mode: 'preset', preset: 'heavy', reason: 'r' });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).managerExit, 41);
  assert.equal(s.fake.mutations().length, 0);
});

// --- سرور: ساخت (runtime، تکراری ۴۴، نامعتبر ۴۵) ---------------------------------------------------------------------------

test('ساخت: --runtime-preset و --runtime به import-issue می‌رسد؛ فقط ردیف‌های داده‌شده؛ preset ِ default فرستاده نمی‌شود', async t => {
  const s = await boot(t);
  const item = (extra = {}) => ({ repo: 'fake', type: 'task', slug: 'x', requestText: 'متن', ...extra });
  const send = async items => (await (await s.post('/api/tasks/create', { items, start: false })).json());
  assert.equal((await send([item()])).succeeded, 1);
  assert.equal((await send([item({ runtime: { preset: 'default', roles: {} } })])).succeeded, 1);
  assert.equal((await send([item({ runtime: { preset: 'heavy', roles: { implementer: { provider: '', model: '', effort: 'max' }, reviewer: { provider: 'codex', model: 'gpt-6-sol', effort: 'high' } } } })])).succeeded, 1);
  const flags = s.fake.imports().map(i => i.args.filter(a => a !== '--file' && !a.endsWith('.json')).slice(1));
  assert.deepEqual(flags, [[], [], ['--runtime-preset', 'heavy', '--runtime', 'implementer=::max', '--runtime', 'reviewer=codex:gpt-6-sol:high']]);
  // شکل ِ نامعتبر ⇒ ردیف ِ ناموفق، تسکی ساخته نمی‌شود
  const bad = await send([item({ runtime: { preset: 'heavy', roles: { Implementer: { provider: 'a', model: 'b', effort: 'c' } } } })]);
  assert.equal(bad.failed, 1);
  assert.equal(s.fake.imports().length, 3);
  assert.deepEqual(createRuntimeFlags({ roles: { x: null } }), []);
  assert.throws(() => createRuntimeFlags('heavy'), /object/);
  assert.deepEqual(answerRuntimeArgs({ mode: 'preset', preset: 'light' }), ['--runtime-preset', 'light']);
});

test('ساخت: exit 44 ← «این issue قبلاً تسک #N دارد» به‌صورت ساختاریافته؛ ساخت ِ عمدی فقط با reason', async t => {
  const s = await boot(t);
  const dupJson = JSON.stringify({ ok: false, error: 'duplicate-external-id', exitCode: 44, externalId: '4201', taskId: '10019', state: 'integrated', message: 'این issue قبلاً تسک 10019 دارد.', hint: 'h' });
  s.fake.setFail({ 'import-issue': { code: 44, stdout: dupJson } });
  const body = { ids: ['4201'], repo: 'fake', start: false };
  const first = (await (await s.post('/api/issues/import', body)).json()).results[0];
  assert.equal(first.ok, false);
  assert.equal(first.managerExit, 44);
  assert.deepEqual({ kind: first.structured.kind, taskId: first.structured.taskId, state: first.structured.state }, { kind: 'duplicate', taskId: '10019', state: 'integrated' });
  assert.equal(first.message, 'این issue قبلاً تسک 10019 دارد.', 'پیام تمیز است، نه JSON ِ خام');

  s.fake.setFail({});
  const noReason = (await (await s.post('/api/issues/import', { ...body, allowDuplicate: { reason: '  ' } })).json()).results[0];
  assert.equal(noReason.ok, false);
  assert.match(noReason.message, /دلیل/);
  assert.equal(s.fake.imports().length, 0, 'بدون reason Manager صدا زده نشد');
  const ok = (await (await s.post('/api/issues/import', { ...body, allowDuplicate: { reason: 'Intentional re-import after revert ✓' } })).json()).results[0];
  assert.equal(ok.ok, true);
  const call = s.fake.imports()[0];
  assert.ok(call.args.includes('--allow-duplicate'));
  assert.equal(call.reasonFile, 'Intentional re-import after revert ✓');
});

test('ساخت: exit 45 ← runtime ِ نامعتبر ساختاریافته (نقش، code)؛ تسکی ساخته نمی‌شود', async t => {
  const s = await boot(t);
  const json = JSON.stringify({ ok: false, error: 'runtime-invalid', exitCode: 45, code: 'unknown-model', message: 'مدل "zzz" مجاز نیست', details: { role: 'reviewer' } });
  s.fake.setFail({ 'import-issue': { code: 45, stdout: json } });
  const result = (await (await s.post('/api/tasks/create', { items: [{ repo: 'fake', requestText: 'x', slug: 'x', runtime: { preset: 'default', roles: { reviewer: { provider: '', model: 'zzz', effort: '' } } } }] })).json()).results[0];
  assert.equal(result.ok, false);
  assert.equal(result.managerExit, 45);
  assert.deepEqual({ kind: result.structured.kind, code: result.structured.code, role: result.structured.role }, { kind: 'runtime-invalid', code: 'unknown-model', role: 'reviewer' });
  assert.equal(structuredFailure({ message: 'plain error' }), null);
  assert.equal(structuredFailure({ stdout: '{"ok":true}' }), null);
});

// --- سرور: retry-provision ------------------------------------------------------------------------------------------------

test('retry-provision: unblock + run؛ alias ِ retryInstall هم کافی است؛ بدون هر دو 409؛ مسیر ِ retry-install alias', async t => {
  const s = await boot(t);
  const call = id => s.post(`/api/remote/tasks/${id}/retry-provision`, {});
  assert.equal((await call('8')).status, 200);
  assert.equal((await call('9')).status, 200, 'فقط retryInstall = true (alias)');
  const denied = await call('10');
  assert.equal(denied.status, 409);
  assert.match((await denied.json()).error, /actions\.retryProvision = false/);
  await s.waitIdle();
  assert.equal((await s.post('/api/remote/tasks/8/retry-install', {})).status, 200, 'نام ِ قبلی');
  await s.waitIdle();
  const unblocks = answers(s.fake).filter(a => a.includes('--unblock'));
  assert.equal(unblocks.length, 3);
  assert.ok(s.fake.calls().filter(c => c.args[0] === 'run').length >= 3, 'run هم زده می‌شود (unblock + run)');
  const notes = (await (await s.get('/api/audit?limit=50')).json()).map(r => r.action);
  assert.ok(notes.includes('retry-provision') && notes.includes('retry-install'));
});

// --- سرور: diag / artifact / tasks ---------------------------------------------------------------------------------------------

test('diag و artifact: outputTail ِ blocker و commitFailure نشان داده می‌شوند؛ tasks خلاصه‌ی runtime را می‌دهد', async t => {
  const s = await boot(t);
  const diag = await (await s.get('/api/remote/tasks/8/diag')).json();
  assert.equal(diag.blocker.stage, 'build');
  assert.equal(diag.blocker.step, 'npx ng build barsa-echarts');
  assert.equal(diag.blocker.outputTail.length, 40, 'فقط ۴۰ خط ِ آخر');
  assert.equal(diag.blocker.outputTail.at(-1), 'build-line-45');
  assert.deepEqual(diag.commitFailure.leftover, ['.agent-work/tasks/0008-x/new.md']);
  assert.match(diag.commitFailure.recoverCommand, /recover 8 --discard-residue/);
  const listing = await (await s.get('/api/remote/tasks/8/artifact')).json();
  assert.equal(listing.blocker.outputTail.at(-1), 'build-line-45');
  assert.equal(listing.commitFailure.message, 'commit hook failed');
  const tasks = (await (await s.get('/api/remote/tasks?filter=all')).json()).tasks;
  assert.equal(tasks.find(x => x.id === '7').runtime, 'preset heavy · implementer effort=max');
  assert.equal(tasks.find(x => x.id === '8').runtime, null);
});

// --- CLI -----------------------------------------------------------------------------------------------------------------------

test('barsa runtime: جدول ِ مؤثر ِ هر نقش با منبع، نقش ِ جاری، attempt ِ زنده و تغییر ِ در صف', async t => {
  const s = await boot(t);
  const text = await s.cli(['runtime', '7']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /مدل‌های تسک #7 \(preset: heavy\) · نقش جاری: implementer · بعدی: reviewer/);
  assert.match(text.out, /☆ reviewer — claude:claude-opus-5-5:high · پیش‌فرض/, 'نقش ِ بعدی با نشانه‌ی جدا');
  assert.match(text.out, /• intake — claude:claude-sonnet-5-5:medium · پیش‌فرض/);
  assert.match(text.out, /★ implementer — claude:claude-sonnet-5-5:max · تنظیم همین تسک \(جاری\)/);
  assert.match(text.out, /↳ در انتظار اعمال → claude:claude-sonnet-5-5:xhigh · reason: second try/);
  assert.match(text.out, /attempt ِ زنده #002 \(implementer\): claude:claude-sonnet-5-5 · max ← high/);
  assert.match(text.out, /تغییرهای در صف: 1/);
  assert.match(text.out, /set-runtime 7 <role>/);
  const json = (await s.cli(['runtime', '7', '--json'])).json();
  assert.deepEqual(Object.keys(json), ['id', 'preset', 'summary', 'canSet', 'current', 'next', 'rows', 'live', 'queued']);
  assert.deepEqual([json.current, json.next], ['implementer', 'reviewer']);
  assert.deepEqual(json.rows.filter(r => r.next).map(r => r.role), ['reviewer']);
  assert.equal(json.canSet, true);
  assert.deepEqual(json.rows.map(r => r.role), ['intake', 'architect', 'implementer', 'reviewer'], 'از کلیدهای effective، فقط چهار نقش');
  assert.equal(json.rows.find(r => r.role === 'implementer').pending.effort, 'xhigh');
  assert.deepEqual(json.queued, [{ decision: 3, queuedAt: '2026-10-25T08:30:00Z', reason: 'second try' }]);
  assert.equal((await s.cli(['runtime', '11'])).code, EXIT.REJECTED, 'Manager قدیمی (بدون runtime)');
  assert.equal((await s.cli(['runtime'])).code, EXIT.USAGE);
});

test('barsa runtime-options: providerها، آماده بودن، مدل‌ها و effort، پیش‌فرض‌ها و presetها', async t => {
  const s = await boot(t);
  const text = await s.cli(['runtime-options']);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /claude: آماده ✓ \(2\.1\.303/);
  assert.match(text.out, /codex: آماده ✓/);
  assert.match(text.out, /claude-opus-5-5 \(opus\)/);
  assert.match(text.out, /implementer: claude:claude-sonnet-5-5:high/);
  assert.match(text.out, /heavy: architect=claude:claude-opus-5-5:high/);
  assert.equal((await s.cli(['runtime-options', '--json'])).json().version, 2);
});

test('barsa set-runtime: سه شکل، پیش‌سنجی از actions.setRuntime (exit 3)، reason اجباری (2)، فارسی چندخطی از --stdin', async t => {
  const s = await boot(t);
  const ok = await s.cli(['set-runtime', '7', 'implementer', '::high', '--reason', 'bump effort']);
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /runtime \(implementer=::high\)/);
  assert.equal((await s.cli(['set-runtime', '7', '--preset', 'heavy', '--reason', 'heavy task'])).code, 0);
  assert.equal((await s.cli(['set-runtime', '7', 'implementer', '--reset', '--reason', 'back'])).code, 0);
  assert.equal((await s.cli(['set-runtime', '7', 'all', '--reset', '--reason', 'back'])).code, 0);
  const reason = 'Line one\nخط دوم با $HOME و "quote" و \\ backslash';
  assert.equal((await s.cli(['set-runtime', '7', 'reviewer', 'codex:gpt-6-sol:high', '--stdin'], { stdin: `${reason}\n` })).code, 0);
  assert.deepEqual(answers(s.fake), [
    ['answer', '7', '--runtime', 'implementer=::high', '--reason-file', '<file>'],
    ['answer', '7', '--runtime-preset', 'heavy', '--reason-file', '<file>'],
    ['answer', '7', '--runtime-reset', 'implementer', '--reason-file', '<file>'],
    ['answer', '7', '--runtime-reset', 'all', '--reason-file', '<file>'],
    ['answer', '7', '--runtime', 'reviewer=codex:gpt-6-sol:high', '--reason-file', '<file>']
  ]);
  assert.deepEqual(s.fake.files().map(f => f.text).at(-1), reason);
  assert.equal(s.fake.files()[0].text, 'bump effort');
  assert.ok(s.fake.mutations().every(c => c.args[0] === 'answer'));
  const audit = (await (await s.get('/api/audit?limit=50')).json()).filter(r => r.action === 'runtime').map(r => r.user);
  assert.ok(audit.length >= 5 && audit.every(u => u === 'remote:remote-phone'));

  const before = s.fake.mutations().length;
  const denied = await s.cli(['set-runtime', '10', 'implementer', '::high', '--reason', 'x']);
  assert.equal(denied.code, EXIT.NOT_ALLOWED, 'integrated: actions.setRuntime = false');
  assert.match(denied.err, /اکشن «set-runtime» برای این تسک الان مجاز نیست/);
  assert.equal(s.fake.mutations().length, before, 'هیچ درخواست ِ نوشتنی');
  for (const args of [
    ['set-runtime', '7', 'implementer', '::high'], // بدون reason
    ['set-runtime', '7', 'Implementer', '::high', '--reason', 'x'],
    ['set-runtime', '7', 'implementer', 'a;b:c:d', '--reason', 'x'],
    ['set-runtime', '7', 'implementer', '::', '--reason', 'x'],
    ['set-runtime', '7', 'implementer', '::high', '--reason', 'x', '--stdin'],
    ['set-runtime', '7', '--preset', 'heavy', 'implementer', '--reason', 'x'],
    ['set-runtime', '7', 'implementer', '--reset', 'extra', '--reason', 'x'],
    ['set-runtime', '7', '--reason', 'x'],
    ['set-runtime']
  ]) assert.equal((await s.cli(args)).code, EXIT.USAGE, args.join(' '));
  assert.equal(s.fake.mutations().length, before);

  s.fake.setFail({ answer: { code: 1, stderr: 'runtime نامعتبر است: effort "high" برای haiku مجاز نیست' } });
  const rejected = await s.cli(['set-runtime', '7', 'implementer', ':claude-haiku-5-5:high', '--reason', 'x']);
  assert.equal(rejected.code, EXIT.REJECTED);
  assert.match(rejected.err, /effort "high" برای haiku مجاز نیست/);
  await s.waitIdle();
});

test('barsa retry-provision / retry-install: پیش‌سنجی از actions (alias)، stage در پیام، exit 3 بدون درخواست', async t => {
  const s = await boot(t);
  const first = await s.cli(['retry-provision', '8']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /تسک #8 \(stage: build\): unblock شد/);
  const alias = await s.cli(['retry-install', '9']);
  assert.equal(alias.code, 0, alias.err);
  assert.equal((await s.cli(['retry-provision', '9', '--json'])).json().stage, 'install');
  await s.waitIdle();
  const before = s.fake.mutations().length;
  const denied = await s.cli(['retry-provision', '10']);
  assert.equal(denied.code, EXIT.NOT_ALLOWED);
  assert.equal(s.fake.mutations().length, before);
});

test('barsa create-*: --runtime-preset / --runtime / --allow-duplicate؛ تکراری (44) و نامعتبر (45) با پیام روشن', async t => {
  const s = await boot(t);
  const ok = await s.cli(['create-from-issue', '4201', '--runtime-preset', 'heavy', '--runtime', 'implementer=::max', '--runtime', 'reviewer=codex:gpt-6-sol:high']);
  assert.equal(ok.code, 0, ok.err);
  assert.deepEqual(s.fake.imports()[0].args.filter(a => a.startsWith('--runtime') || /=/.test(a) || a === 'heavy'), ['--runtime-preset', 'heavy', '--runtime', 'implementer=::max', '--runtime', 'reviewer=codex:gpt-6-sol:high']);
  const task = await s.cli(['create-task', '--title', 'عنوان', '--stdin', '--runtime', 'architect=:claude-opus-5-5:'], { stdin: 'متن' });
  assert.equal(task.code, 0, task.err);
  assert.ok(s.fake.imports()[1].args.includes('architect=:claude-opus-5-5:'));

  for (const args of [
    ['create-from-issue', '4201', '--runtime', 'bad;spec'], ['create-from-issue', '4201', '--runtime', 'implementer=::'],
    ['create-from-issue', '4201', '--runtime', 'implementer=::high', '--runtime', 'implementer=::low'], ['create-from-issue', '4201', '--runtime-preset', '../x'],
    ['create-from-issue', '4201', '--reason', 'x'], ['create-from-issue', '4201', '--allow-duplicate']
  ]) assert.equal((await s.cli(args)).code, EXIT.USAGE, args.join(' '));
  assert.equal(s.fake.imports().length, 2);

  const dupJson = JSON.stringify({ ok: false, error: 'duplicate-external-id', exitCode: 44, externalId: '4201', taskId: '10019', state: 'integrated', message: 'dup', hint: 'h' });
  s.fake.setFail({ 'import-issue': { code: 44, stdout: dupJson } });
  const dup = await s.cli(['create-from-issue', '4201']);
  assert.equal(dup.code, EXIT.REJECTED);
  assert.match(dup.err, /این issue قبلاً تسک #10019 دارد \(state: integrated\)/);
  assert.match(dup.err, /--allow-duplicate --stdin/);
  assert.equal((await s.cli(['create-from-issue', '4201', '--json'])).json().duplicateOf, '10019');

  s.fake.setFail({});
  const forced = await s.cli(['create-from-issue', '4201', '--allow-duplicate', '--reason', 'Intentional re-import']);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(s.fake.imports().at(-1).reasonFile, 'Intentional re-import');

  const bad = JSON.stringify({ ok: false, error: 'runtime-invalid', exitCode: 45, code: 'unknown-effort', message: 'effort "x" مجاز نیست', details: { role: 'implementer' } });
  s.fake.setFail({ 'import-issue': { code: 45, stdout: bad } });
  const invalid = await s.cli(['create-from-issue', '4201', '--runtime', 'implementer=::x']);
  assert.equal(invalid.code, EXIT.REJECTED);
  assert.match(invalid.err, /runtime نامعتبر است \(نقش implementer\).*effort برای این مدل مجاز نیست.*هیچ تسکی ساخته نشد/);
  await s.waitIdle();
});

test('barsa task / tasks: خط ِ runtime و ستون ِ «مدل / effort» ِ attemptها؛ diag و artifact outputTail و commitFailure', async t => {
  const s = await boot(t);
  const text = (await s.cli(['task', '7'])).out;
  assert.match(text, /runtime: preset heavy · implementer effort=max · 1 تغییر در انتظار اعمال/);
  assert.match(text, /attemptها \(مدل \/ effort\):/);
  assert.match(text, /#001 intake → completed · — · —/);
  assert.match(text, /#002 implementer → در جریان · claude:claude-sonnet-5-5 · max ← high/);
  const json = (await s.cli(['task', '7', '--json'])).json();
  assert.equal(json.runtime.summary, 'preset heavy · implementer effort=max');
  assert.deepEqual(json.attempts.map(a => [a.n, a.model === '—']), [[1, true], [2, false]]);
  assert.equal((await s.cli(['task', '10'])).out.includes('runtime:'), false, 'فقط اگر با پیش‌فرض فرق دارد');
  assert.match((await s.cli(['tasks'])).out, /#7 · .*🧠 preset heavy/);

  const diag = (await s.cli(['diag', '8'])).out;
  assert.match(diag, /── blocker: environment · stage build · گام npx ng build barsa-echarts/);
  assert.match(diag, /outputTail\):\n {4}build-line-6\n/);
  assert.match(diag, /build-line-45/);
  assert.doesNotMatch(diag, /build-line-5\n/);
  assert.match(diag, /── commit شکست خورد و چیزی کثیف مانده \(commitFailure\)/);
  assert.match(diag, /فرمان ِ بازیابی: node scripts\/manager\.js recover 8 --discard-residue/);
  const artifact = (await s.cli(['artifact', '8'])).out;
  assert.match(artifact, /blocker: environment · stage build · گام npx ng build/);
  assert.match(artifact, /outputTail \(۴۰ خط ِ آخر\):[\s\S]*build-line-45/);
  assert.match(artifact, /commitFailure: commit hook failed/);
  assert.match(artifact, /کثیف‌مانده: \.agent-work\/tasks\/0008-x\/new\.md/);
});

// --- فهرست‌ها، endpointها، guard، settings ---------------------------------------------------------------------------------

test('فرمان‌های تازه: در help، در REMOTE_ENDPOINTS و در COMMAND_ENDPOINTS؛ حالت allow/ask درست', () => {
  const listed = [...HELP.matchAll(/^\s+barsa (\S+)/gm)].map(m => m[1]);
  for (const command of ['runtime', 'runtime-options', 'set-runtime', 'retry-provision', 'retry-install']) assert.ok(listed.includes(command), command);
  assert.ok(READ_COMMANDS.includes('runtime') && READ_COMMANDS.includes('runtime-options'));
  assert.ok(WRITE_COMMANDS.includes('set-runtime') && WRITE_COMMANDS.includes('retry-provision') && WRITE_COMMANDS.includes('retry-install'));
  for (const command of ['runtime', 'runtime-options', 'set-runtime', 'retry-provision']) {
    for (const [method, pattern] of COMMAND_ENDPOINTS[command]) assert.ok(REMOTE_ENDPOINTS.some(([m, p]) => m === method && p === pattern), `${command}: ${method} ${pattern}`);
  }
  const settings = JSON.parse(read('docs/remote-control/settings.json'));
  const has = (list, c) => list.some(rule => rule.startsWith(`Bash(./barsa ${c}:`));
  assert.ok(has(settings.permissions.allow, 'runtime') && has(settings.permissions.allow, 'runtime-options'));
  assert.ok(has(settings.permissions.ask, 'set-runtime') && has(settings.permissions.ask, 'retry-provision') && has(settings.permissions.ask, 'retry-install'));
  assert.ok(!has(settings.permissions.allow, 'set-runtime') && !has(settings.permissions.ask, 'runtime'));
});

test('guard.mjs: شکل ِ آرگومان‌های runtime (نقش از [a-z-]+، spec فقط نویسه‌های مجاز، بدون نویسه‌ی شل)', () => {
  const ok = [
    './barsa runtime 10013', './barsa runtime 10013 --json', './barsa runtime-options', './barsa runtime-options --repo barsa-novin-ray',
    './barsa set-runtime 10013 implementer claude:claude-opus-5-5:high --reason "need depth"',
    './barsa set-runtime 10013 implementer ::high --reason "bump"', './barsa set-runtime 10013 reviewer :gpt-6-sol: --reason "x"',
    './barsa set-runtime 10013 --preset heavy --reason "heavy"', './barsa set-runtime 10013 implementer --reset --reason "back"',
    './barsa set-runtime 10013 all --reset --stdin <<\'EOF\'\nback to default\nEOF',
    './barsa retry-provision 10013', './barsa retry-install 10013',
    './barsa create-task --title "عنوان" --runtime implementer=::max --runtime-preset heavy --stdin <<\'EOF\'\nمتن\nEOF',
    './barsa create-from-issue 4201 --runtime reviewer=codex:gpt-6-sol:high --allow-duplicate --reason "re-import"',
    './barsa set-runtime 10013 future-role a.b:c_d:e-f --reason "future role names are fine"'
  ];
  for (const command of ok) assert.deepEqual(evaluate(command), { ok: true }, command);
  const bad = [
    './barsa runtime', './barsa runtime 5 6', './barsa runtime 5 --evil', './barsa runtime ../x', './barsa runtime-options 5', './barsa runtime-options --x',
    './barsa retry-provision', './barsa retry-provision 5 6', './barsa retry-provision 5 --reason x',
    './barsa set-runtime 5 Implementer claude:m:high --reason "x"', './barsa set-runtime 5 implementer claude:m --reason "x"',
    './barsa set-runtime 5 implementer a:b:c:d --reason "x"', './barsa set-runtime 5 implementer "a b:c:d" --reason "x"',
    './barsa set-runtime 5 implementer "a;b:c:d" --reason "x"', './barsa set-runtime 5 implementer a:b:c', './barsa set-runtime 5 implementer a:b:c --reason',
    './barsa set-runtime 5 implementer a:b:c --reason "x" --stdin', './barsa set-runtime 5 --preset "../x" --reason "x"', './barsa set-runtime 5 --preset heavy extra --reason "x"',
    './barsa set-runtime 5 implementer --reset extra --reason "x"', './barsa set-runtime 5 implementer a:b:c --reason "x" --force', './barsa set-runtime ../x implementer a:b:c --reason "x"',
    './barsa set-runtime 5 implementer a:b:c --reason "$(id)"', './barsa set-runtime 5 implementer a:b:c --reason "`id`"', './barsa set-runtime 5 implementer a:b:c --reason "x"; ls',
    './barsa set-runtime 5 implementer a:b:c --reason x | cat', './barsa set-runtime 5 implementer a:b:c --reason x > f', './barsa set-runtime 5 implementer a:b:c --reason x && ls',
    './barsa create-task --title x --runtime "bad;spec" --stdin', './barsa create-task --title x --runtime implementer=a:b --stdin', './barsa create-task --title x --runtime Implementer=a:b:c --stdin',
    './barsa create-task --title x --runtime-preset "../x" --stdin', './barsa create-from-issue 4201 --runtime'
  ];
  for (const command of bad) assert.equal(evaluate(command).ok, false, command);
});

test('نقش‌ها از داده: اعتبارسنجی ِ سمت ِ سرور و guard هیچ فهرست ِ ثابت ِ نقش ندارند', () => {
  for (const file of ['server/src/runtime-args.js', 'docs/remote-control/guard.mjs']) {
    assert.doesNotMatch(read(file), /\['intake',\s*'architect'|"intake",\s*"architect"|'rebase'|'analyst'/, file);
  }
  assert.deepEqual(answerRuntimeArgs({ mode: 'set', role: 'some-future-role', provider: 'claude', model: '', effort: '' }), ['--runtime', 'some-future-role=claude::']);
});

test('syncInfo قدیمی دست‌نخورده می‌ماند (رگرسیون: manager-update هنوز import می‌شود)', () => {
  assert.equal(syncInfoFromStatus({ repository: { sync: { branch: 'main', upstream: 'origin/main', ahead: 1, behind: 2, lastFetchAt: 't' } } }).behind, 2);
});
