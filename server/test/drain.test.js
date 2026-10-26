import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { authedFetch, startAuthedServer } from './helpers.js';
import { HELD_RUN, makeFakeManagerRepo, releaseHeldRun } from './fake-manager.js';
import { closeServer, waitUntil } from './cleanup.js';
import { RemoteTokenStore } from '../src/remote-tokens.js';
import { run as barsa } from '../src/remote-cli.js';
import { DrainStore } from '../src/drain.js';

// حالت ِ تخلیه (drain): run ِ تازه (دستی/خودکار) شروع نمی‌شود، in-flight ها تمام می‌شوند، صف می‌ماند (و بعد از restart هم)،
// و با «--off» صف شروع می‌شود. برای به‌روزرسانی ِ کانبان بدون قطع ِ run های زنده.

const OK_CLAUDE = { command: process.execPath, versionArgs: ['--version'], authArgs: ['--version'] };
const task = id => ({ id, title: `تسک ${id}`, state: 'implementing', actions: { run: true } });
const STATUS = { schemaVersion: 1, generatedAt: '2026-10-26T09:00:00Z', repo: { head: 'e'.repeat(40) }, tasks: [task('7'), task('8')] };

const started = (fake, id) => fs.existsSync(path.join(fake.root, `started-${id}`));
const get = async (base, p) => (await authedFetch(`${base}${p}`)).json();
const post = (base, p, body = {}) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const runItem = async (base, id) => (await get(base, '/api/repos/fake/running')).find(x => x.taskId === String(id));

async function boot(t, { config = {} } = {}) {
  const fake = makeFakeManagerRepo(t, { run: HELD_RUN, status: STATUS });
  const cfg = { repos: [fake.repo], server: {}, issueSource: {}, run: { proxy: '', stopGraceMs: 300 }, health: { claude: OK_CLAUDE, proxyTestUrl: 'http://127.0.0.1:9/' }, ...config };
  const exits = [];
  const server = await startAuthedServer(t, cfg, { exit: code => exits.push(code), shutdownLog: { info() {}, warn() {} } });
  return { fake, cfg, exits, ...server };
}

test('drain با run ِ زنده و تسک ِ صف: زنده تمام می‌شود، صف شروع نمی‌شود، بعد از restart می‌ماند، با --off شروع می‌شود', async t => {
  const s = await boot(t);
  assert.equal((await post(s.base, '/api/repos/fake/tasks/7/run')).status, 202);
  await waitUntil(() => started(s.fake, 7), { label: 'شروع ِ run ِ 7' });

  // --- تخلیه روشن ---
  const on = await (await post(s.base, '/api/drain')).json();
  assert.equal(on.draining, true);
  assert.equal(on.changed, true);
  assert.equal(on.empty, false);
  assert.equal(on.live.length, 1);
  assert.equal(on.live[0].taskId, '7');
  assert.equal(on.live[0].state, 'implementing', 'state از آخرین board ِ کش‌شده');
  assert.match(on.live[0].durationText, /\S/);
  assert.equal((await (await post(s.base, '/api/drain')).json()).changed, false, 'دوباره روشن کردن بی‌اثر است');

  // --- run ِ تازه پذیرفته می‌شود ولی شروع نمی‌شود ---
  assert.equal((await post(s.base, '/api/repos/fake/tasks/8/run')).status, 202);
  const held = await runItem(s.base, 8);
  assert.equal(held.queued, true);
  assert.equal(held.held, true);
  assert.equal(started(s.fake, 8), false);
  const mid = await get(s.base, '/api/drain');
  assert.deepEqual(mid.queued.map(x => x.taskId), ['8']);
  assert.deepEqual(mid.live.map(x => x.taskId), ['7']);

  // حالت (و صف) روی دیسک است
  const saved = new DrainStore(s.config.dataDir).load();
  assert.equal(saved.draining, true);
  assert.deepEqual(saved.queued.map(x => x.taskId), ['8']);

  // --- run ِ زنده تمام می‌شود؛ صف شروع نمی‌شود ---
  releaseHeldRun(s.fake.root, '7');
  await waitUntil(async () => (await runItem(s.base, 7)).running === false, { label: 'پایان ِ run ِ 7' });
  const after = await get(s.base, '/api/drain');
  assert.equal(after.empty, true, 'زنده‌ای نمانده: «خالی»');
  assert.equal((await runItem(s.base, 8)).queued, true, 'تسک ِ صف هنوز در صف است (گم نشده)');
  assert.equal(started(s.fake, 8), false, 'تسک ِ صف شروع نشد');

  // --- restart: سرور تازه روی همان dataDir ---
  await closeServer(s.server);
  const second = await startAuthedServer(t, { ...s.cfg, dataDir: s.config.dataDir }, { exit() {}, shutdownLog: { info() {}, warn() {} } });
  const restored = await get(second.base, '/api/drain');
  assert.equal(restored.draining, true, 'حالت ِ تخلیه بعد از restart برگشت');
  assert.equal(restored.since, on.since);
  assert.deepEqual(restored.queued.map(x => x.taskId), ['8'], 'صف ِ نگه‌داشته‌شده برگشت');
  assert.equal((await runItem(second.base, 8)).held, true);
  assert.equal(started(s.fake, 8), false, 'بعد از restart هم شروع نشد');

  // --- --off: صف شروع می‌شود و فایل ِ حالت پاک می‌شود ---
  const off = await (await post(second.base, '/api/drain/off')).json();
  assert.equal(off.draining, false);
  assert.equal(off.changed, true);
  await waitUntil(() => started(s.fake, 8), { label: 'شروع ِ تسک ِ صف بعد از --off' });
  assert.equal(new DrainStore(s.config.dataDir).load().draining, false);
  assert.equal(fs.existsSync(path.join(s.config.dataDir, 'drain.json')), false);
  releaseHeldRun(s.fake.root, '8');
  await waitUntil(async () => (await runItem(second.base, 8)).running === false, { label: 'پایان ِ run ِ 8' });
});

test('drain: stop روی تسک ِ صف‌شده آن را از صف و از drain.json حذف می‌کند؛ shutdown صف ِ ذخیره‌شده را بازنویسی نمی‌کند', async t => {
  const s = await boot(t);
  await post(s.base, '/api/drain');
  await post(s.base, '/api/repos/fake/tasks/7/run');
  await post(s.base, '/api/repos/fake/tasks/8/run');
  assert.deepEqual(new DrainStore(s.config.dataDir).load().queued.map(x => x.taskId), ['7', '8']);
  assert.equal((await post(s.base, '/api/repos/fake/tasks/7/stop')).status, 200);
  assert.deepEqual(new DrainStore(s.config.dataDir).load().queued.map(x => x.taskId), ['8']);

  // shutdown: stopAll صف را در حافظه خالی می‌کند، ولی آنچه روی دیسک است برای restart می‌ماند
  assert.equal(await s.server.barsa.shutdown('SIGTERM').catch(() => 0), 0);
  assert.deepEqual(new DrainStore(s.config.dataDir).load().queued.map(x => x.taskId), ['8']);
  assert.equal(started(s.fake, 8), false);
});

test('drain از CLI: ask/allow، health، sync ِ بدون تخلیه رد می‌شود و راه را می‌گوید، با تخلیه + فقط صف sync مجاز است', async t => {
  const s = await boot(t);
  const store = new RemoteTokenStore(s.config.dataDir);
  store.create('remote-phone');
  const tokenFile = path.join(s.config.dataDir, 'tokens', 'remote-phone.token');
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  const cli = async (args, env = {}) => {
    let out = '';
    let err = '';
    const code = await barsa(args, {
      env: { BARSA_REMOTE_URL: s.base, BARSA_REMOTE_TOKEN_FILE: tokenFile, BARSA_POLL_MS: '40', BARSA_SYNC_WAIT_MS: '20000', ...env },
      stdout: text => { out += text; }, stderr: text => { err += text; }, stdin: Readable.from([])
    });
    assert.ok(!out.includes(token) && !err.includes(token), 'توکن هرگز در خروجی نیست');
    return { code, out, err, json: () => JSON.parse(out) };
  };

  // خاموش: «هیچ run ِ زنده‌ای نیست»
  let r = await cli(['drain', '--status']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /تخلیه: خاموش/);
  assert.match(r.out, /هیچ run ِ زنده‌ای نیست/);

  await post(s.base, '/api/repos/fake/tasks/7/run');
  await waitUntil(() => started(s.fake, 7), { label: 'شروع ِ run' });

  // بدون تخلیه و با run ِ زنده: sync رد می‌شود و پیشنهاد ِ تخلیه می‌دهد
  r = await cli(['sync']);
  assert.notEqual(r.code, 0);
  assert.match(`${r.out}${r.err}`, /barsa drain/);
  assert.match(`${r.out}${r.err}`, /#7/);

  // درخواست ِ بد: هر دو با هم
  assert.equal((await cli(['drain', '--status', '--off'])).code, 2);
  assert.equal((await cli(['drain', '5'])).code, 2);

  // روشن (ask در settings.json)
  r = await cli(['drain']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /تخلیه روشن شد/);
  assert.match(r.out, /barsa drain --status/);

  r = await cli(['drain', '--status', '--json']);
  const status = r.json();
  assert.equal(status.draining, true);
  assert.equal(status.empty, false);
  assert.deepEqual(status.live.map(x => x.taskId), ['7']);
  assert.match((await cli(['drain', '--status'])).out, /#7 · .* · /, 'فهرست ِ run ِ زنده با state و مدت');

  // health: در متن و در --json
  r = await cli(['health']);
  assert.match(r.out, /در حال تخلیه — run ِ تازه شروع نمی‌شود/);
  r = await cli(['health', '--json']);
  assert.deepEqual({ draining: r.json().drain.draining, live: r.json().drain.live, queued: r.json().drain.queued }, { draining: true, live: 1, queued: 0 });

  // با تخلیه، تا وقتی run ِ زنده هست sync پیام ِ «صبر کن» می‌دهد
  r = await cli(['sync']);
  assert.notEqual(r.code, 0);
  assert.match(`${r.out}${r.err}`, /تخلیه روشن است/);

  // صف + خالی شدن ← sync مجاز (صف ِ نگه‌داشته‌شده مانع نیست)
  await post(s.base, '/api/repos/fake/tasks/8/run');
  releaseHeldRun(s.fake.root, '7');
  await waitUntil(async () => (await cli(['drain', '--status', '--json'])).json().empty, { label: 'خالی شدن' });
  assert.match((await cli(['drain', '--status'])).out, /✅ خالی/);
  r = await cli(['sync']);
  assert.equal(r.code, 0, `${r.out}${r.err}`);
  assert.equal(started(s.fake, 8), false);

  // --off: صف شروع می‌شود
  r = await cli(['drain', '--off']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /تخلیه خاموش شد/);
  await waitUntil(() => started(s.fake, 8), { label: 'شروع ِ صف' });
  assert.equal((await cli(['drain', '--off'])).out.includes('از قبل خاموش'), true);
  releaseHeldRun(s.fake.root, '8');
  await waitUntil(async () => (await cli(['drain', '--status', '--json'])).json().empty, { label: 'پایان ِ run ِ 8' });

  // ممیزی: actor = remote:<name>
  const audit = await get(s.base, '/api/audit?limit=200');
  const rows = audit.filter(x => String(x.action).startsWith('drain.'));
  assert.deepEqual(rows.map(x => x.action).sort(), ['drain.off', 'drain.on']);
  assert.ok(rows.every(x => x.user === 'remote:remote-phone'));
});
