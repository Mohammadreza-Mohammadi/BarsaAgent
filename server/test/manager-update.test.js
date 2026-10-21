import test from 'node:test';
import assert from 'node:assert/strict';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo, DEFAULT_SYNC } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';
import { SYNC_EXIT, exitMessage, formatSyncReport, parseSyncJson } from '../src/sync-report.js';

// «به‌روزرسانی از origin» حالا فقط `manager.js sync --json` است (TOOLING-040). Manager ساختگی برای هر exit code
// یک خروجی --json ِ نمونه می‌دهد (شکل واقعی از runner-sync.js ِ Manager)؛ هیچ git/npm ای در کانبان نیست.

const post = (base, p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const get = (base, p) => authedFetch(`${base}${p}`);

const STATUS_WITH_SYNC = {
  schemaVersion: 1, repo: { head: 'c'.repeat(40) }, tasks: [],
  repository: {
    sync: { branch: 'main', upstream: 'origin/main', ahead: 2, behind: 5, lastFetchAt: '2026-10-20T16:54:42.276Z' },
    execution: { enabled: true, source: 'default', reason: null },
    localConfig: { path: '.agent-work/config/repository.local.yaml', present: false, applied: false, keys: [] }
  }
};

async function setup(t, { sync, status = STATUS_WITH_SYNC, managerInfo, run } = {}) {
  const fake = makeFakeManagerRepo(t, { sync, status, run });
  const { base, config } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, ...(managerInfo ? { managerInfo } : {}) });
  const audit = () => new AuditLog({ dir: config.dataDir });
  const exec = async (path_, expect = 202) => {
    const response = await post(base, path_);
    assert.equal(response.status, expect, await response.clone().text());
    if (expect !== 202) return response.json();
    const { execId } = await response.json();
    const text = await (await get(base, `/api/execs/${execId}/stream`)).text();
    return { text, code: JSON.parse(/event: end\ndata: (\{.*\})/.exec(text)[1]).code, execId };
  };
  const syncCalls = () => fake.calls().filter(c => c.args[0] === 'sync').map(c => c.args.slice(1));
  return { fake, base, config, audit, exec, syncCalls };
}

const sync = (patch, code = 0, stderr = []) => ({ code, stderr, result: { ...DEFAULT_SYNC.result, ...patch, exitCode: code, ok: code === 0 } });

test('sync موفق: فقط `sync --json` صدا زده می‌شود؛ خلاصه‌ی فارسی، stderr ِ زنده، و --help/capabilities دوباره خوانده می‌شود', async t => {
  const s = await setup(t, {
    sync: sync({ action: 'merge', aheadBefore: 2, behindBefore: 5, merged: true, mergeCommit: 'abcdef1234567890', pushed: true,
      npmCi: { required: true, ran: true, ok: true, timedOut: false } }, 0, ['[sync] fetch origin (تلاش 1)…', 'added 1204 packages'])
  });
  const helpBefore = s.fake.calls().filter(c => c.args[0] === '--help').length;
  const capsBefore = s.fake.calls().filter(c => c.args[0] === 'capabilities').length;
  const r = await s.exec('/api/repos/fake/manager/update');
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(s.syncCalls(), [['--json']]);
  // stderr ِ زنده قبل از خلاصه می‌آید
  assert.ok(r.text.indexOf('added 1204 packages') > 0 && r.text.indexOf('added 1204 packages') < r.text.indexOf('نتیجه‌ی sync'), r.text);
  assert.match(r.text, /merge ِ واقعی/);
  assert.match(r.text, /2 commit جلوتر، 5 commit عقب‌تر/);
  assert.match(r.text, /merge شد: بله \(abcdef1234\) · push شد: بله/);
  assert.match(r.text, /npm ci: موفق/);
  assert.match(r.text, /زیرفرمان‌های مجاز:.*answer/);
  assert.ok(s.fake.calls().filter(c => c.args[0] === '--help').length > helpBefore, 'فهرست زیرفرمان‌ها تازه شد');
  assert.ok(s.fake.calls().filter(c => c.args[0] === 'capabilities').length > capsBefore, 'capabilities تازه شد');
  assert.ok(s.config.managerInfo.fake, 'managerInfo بعد از sync به‌روز می‌شود');
  // کد قدیمی (fetch / merge --ff-only / npm ci ِ کانبان) دیگر وجود ندارد: هیچ گام غیر از sync ثبت نشده
  const steps = s.audit().summaries().filter(x => x.action === 'manager.update.step').map(x => x.argv.slice(1).join(' '));
  assert.equal(steps.length, 1);
  assert.match(steps[0], /manager\.cjs sync --json$/);
  assert.ok(!s.audit().summaries().some(x => /git|npm/.test((x.argv || [])[0] || '') && /manager\./.test(x.action)), 'git/npm ِ کانبان صدا زده نشده');
  assert.equal(s.audit().summaries().find(x => x.action === 'manager.update').exitCode, 0);
});

const CASES = [
  [SYNC_EXIT.PRECONDITION, 'precondition', /پیش‌شرط sync برقرار نیست/, { failure: { kind: 'precondition', message: 'x', problems: [{ message: 'درخت تمیز نیست' }] } }],
  [SYNC_EXIT.FETCH_FAILED, 'fetch', /fetch از origin شکست خورد/, { failure: { kind: 'fetch', message: 'fetch شکست', detail: 'unable to access' } }],
  [SYNC_EXIT.MERGE_CONFLICT, 'conflict', /برخورد.*abort شد/, { action: 'merge', conflicts: ['a/b.ts', 'c.json'], failure: { kind: 'conflict', message: 'برخورد' } }],
  [SYNC_EXIT.PUSH_REJECTED, 'push-rejected', /push رد شد/, { action: 'push', retried: true, failure: { kind: 'push-rejected', message: 'رد' } }],
  [SYNC_EXIT.PUSH_FAILED, 'push-failed', /push شکست خورد.*pre-push/, { action: 'push', failure: { kind: 'push-failed', message: 'hook' } }],
  [SYNC_EXIT.NPM_CI_FAILED, 'npm-ci-failed', /npm ci شکست خورد/, { action: 'fast-forward', merged: true, npmCi: { required: true, ran: true, ok: false, timedOut: false, exitCode: 1 }, failure: { kind: 'npm-ci-failed', message: 'npm' } }],
  [SYNC_EXIT.NPM_CI_TIMEOUT, 'npm-ci-timeout', /npm ci بعد از مهلت.*قطع شد/, { action: 'fast-forward', merged: true, npmCi: { required: true, ran: true, ok: false, timedOut: true }, failure: { kind: 'npm-ci-timeout', message: 'timeout' } }],
  [SYNC_EXIT.MERGE_FAILED, 'merge-failed', /merge شکست خورد بدون برخورد/, { action: 'merge', failure: { kind: 'merge-failed', message: 'hook', detail: 'commitlint' } }],
  [41, 'execution', /اجرای تسک روی این دستگاه خاموش است \(execution\.enabled=false\)/, null]
];

for (const [code, name, message, patch] of CASES) {
  test(`sync با exit ${code} (${name}): پیام فارسی روشن، exit code حفظ می‌شود، ردیف ممیزی failed، و ff-only ِ قدیمی صدا زده نمی‌شود`, async t => {
    const s = await setup(t, { sync: patch ? sync(patch, code, ['stderr-live-line']) : { code, stderr: ['اجرا خاموش است'], result: null } });
    const r = await s.exec('/api/repos/fake/manager/update');
    assert.equal(r.code, code, r.text);
    assert.match(r.text, message);
    assert.match(r.text, new RegExp(`\\[exit ${code}\\]`));
    assert.match(r.text, /stderr-live-line|اجرا خاموش است/);
    assert.deepEqual(s.syncCalls(), [['--json']]);
    assert.equal(s.fake.calls().filter(c => c.args[0] === '--help' || c.args[0] === 'capabilities').length, 0, 'بعد از شکست، --help و capabilities دوباره خوانده نمی‌شوند');
    const record = s.audit().summaries().find(x => x.action === 'manager.update');
    assert.equal(record.exitCode, code);
    assert.equal(record.status, 'failed');
    if (patch?.conflicts) {
      assert.match(r.text, /فایل‌های درگیر \(merge abort شد\) — 2 فایل/);
      assert.match(r.text, /- a\/b\.ts/);
    }
    if (patch?.failure?.detail) assert.match(r.text, new RegExp(`جزئیات: ${patch.failure.detail}`));
    if (patch?.failure?.problems) assert.match(r.text, /درخت تمیز نیست/);
  });
}

test('کد ناشناخته‌ی sync هم «خطای ناشناخته» نیست: کد در پیام می‌آید و برای کل اجرا حفظ می‌شود', async t => {
  const s = await setup(t, { sync: sync({}, 99) });
  const r = await s.exec('/api/repos/fake/manager/update');
  assert.equal(r.code, 99);
  assert.match(r.text, /exit code 99/);
});

test('پیش‌نمایش: `sync --dry-run --json` (مسیر جدا)، چیزی را به‌روز نمی‌کند و --help را دوباره نمی‌خواند', async t => {
  const s = await setup(t, { sync: sync({ dryRun: true, action: 'merge', aheadBefore: 1, behindBefore: 1, wouldConflict: true, conflicts: ['x.ts'], npmCi: { required: true, ran: false, ok: null, timedOut: false },
    failure: { kind: 'conflict', message: 'پیش‌بینی' } }, SYNC_EXIT.MERGE_CONFLICT) });
  const r = await s.exec('/api/repos/fake/manager/sync-preview');
  assert.equal(r.code, SYNC_EXIT.MERGE_CONFLICT);
  assert.deepEqual(s.syncCalls(), [['--dry-run', '--json']]);
  assert.match(r.text, /پیش‌نمایش \(--dry-run\)/);
  assert.match(r.text, /برخورد پیش‌بینی‌شده: بله/);
  assert.match(r.text, /فایل‌های درگیر \(پیش‌بینی\)/);
  assert.match(r.text, /npm ci: لازم خواهد بود/);
  assert.equal(s.audit().summaries().find(x => x.action === 'manager.sync-preview').exitCode, SYNC_EXIT.MERGE_CONFLICT);

  s.fake.setSync(sync({ dryRun: true, action: 'fast-forward', behindBefore: 3 }));
  const ok = await s.exec('/api/repos/fake/manager/sync-preview');
  assert.equal(ok.code, 0, ok.text);
  assert.match(ok.text, /پیش‌نمایش تمام شد؛ چیزی تغییر نکرد/);
  assert.equal(s.fake.calls().filter(c => c.args[0] === 'capabilities').length, 0);
});

test('رد: اجرای در جریان/صف خود کانبان (registry)؛ پیش‌نمایش مانع ندارد', async t => {
  const s = await setup(t, { run: 'setInterval(() => {}, 1000);' });
  await post(s.base, '/api/repos/fake/tasks/3/run');
  for (let i = 0; i < 100 && !s.fake.calls().some(c => c.args[0] === 'run'); i += 1) await new Promise(r => setTimeout(r, 50));
  const body = await s.exec('/api/repos/fake/manager/update', 409);
  assert.match(body.error, /اجرا در جریان\/صف است: #3/);
  assert.deepEqual(s.syncCalls(), []);
  assert.equal(s.audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'manager.update').length, 1);
  const preview = await s.exec('/api/repos/fake/manager/sync-preview');
  assert.equal(preview.code, 0, preview.text);
  await post(s.base, '/api/repos/fake/tasks/3/stop');
});

test('Manager قدیمی (capabilities بدون sync): 409 با پیام روشن و هیچ فرمانی اجرا نمی‌شود', async t => {
  const s = await setup(t, { managerInfo: { fake: { ok: true, capabilities: { status: { actionsVersion: 2 } } } } });
  const body = await s.exec('/api/repos/fake/manager/update', 409);
  assert.match(body.error, /Manager قدیمی است.*sync/);
  assert.deepEqual(s.syncCalls(), []);
});

test('info: ahead/behind و زمان آخرین fetch از repository.sync ِ status می‌آید، نه از git ِ کانبان', async t => {
  const s = await setup(t);
  const info = await (await get(s.base, '/api/repos/fake/manager/info')).json();
  assert.deepEqual({ head: info.head, branch: info.branch, upstream: info.upstream, ahead: info.ahead, behind: info.behind, lastFetchAt: info.lastFetchAt },
    { head: 'c'.repeat(40), branch: 'main', upstream: 'origin/main', ahead: 2, behind: 5, lastFetchAt: '2026-10-20T16:54:42.276Z' });
  assert.equal(info.execution.enabled, true);
  assert.equal(info.localConfig.present, false);
  assert.equal(info.remoteError, undefined);
  // مخزن fake اصلاً git نیست: اگر کانبان git می‌زد، info می‌شکست

  s.fake.setStatus({ schemaVersion: 1, repo: {}, tasks: [] });
  const old = await (await get(s.base, '/api/repos/fake/manager/info')).json();
  assert.equal(old.behind, null);
  assert.match(old.remoteError, /repository\.sync را در status --json نمی‌دهد/);
});

test('sync-report: گزارش، کدهای شناخته‌شده، و JSON خراب', () => {
  for (const code of Object.values(SYNC_EXIT).filter(Boolean)) assert.ok(exitMessage(code), `پیام برای ${code}`);
  assert.ok(exitMessage(41));
  assert.equal(exitMessage(77), null);
  assert.equal(parseSyncJson(''), null);
  assert.equal(parseSyncJson('not json'), null);
  assert.equal(parseSyncJson('"str"'), null);
  assert.deepEqual(parseSyncJson('{"a":1}'), { a: 1 });
  assert.match(formatSyncReport(null, 1)[0], /JSON معتبر نبود/);
  const lines = formatSyncReport({ ...DEFAULT_SYNC.result, staleLocks: [{ path: '.manager.lock', pid: 12, task: '5' }] }, 0).join('\n');
  assert.match(lines, /هیچ — main با origin برابر است/);
  assert.match(lines, /قفل مرده.*\.manager\.lock.*task=5.*pid=12/);
});
