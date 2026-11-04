import test from 'node:test';
import assert from 'node:assert/strict';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { etagMatches, etagOf } from '../src/app.js';
import { waitUntil } from './cleanup.js';

// هزینه‌ی poll (مصرف ِ CPU/حافظه‌ی مرورگر و سرور): ETag/304، اشتراک ِ اجرای status بین چند کلاینت، tail ِ stream، بریدن ِ artifact.
const fetch = authedFetch;

const STATUS = (extra = {}) => ({
  schemaVersion: 1, generatedAt: '2026-11-04T10:00:00Z', repo: { head: 'a'.repeat(40) },
  repository: { health: { managerLock: null, unownedDirtyFiles: [], acceptsOperations: true }, execution: { enabled: true, source: 'default', reason: null } },
  tasks: [{ id: '3', title: 'نمونه', state: 'review', actions: {}, attempts: [], ...extra }]
});
const boardStatusCalls = fake => fake.calls().filter(c => c.args[0] === 'status' && !c.args.includes('--task')).length;

async function boot(t, { status = STATUS(), run, statusDelayMs = 0, server = {} } = {}) {
  const fake = makeFakeManagerRepo(t, { status, run, statusDelayMs });
  const { base } = await startAuthedServer(t, { repos: [fake.repo], server, issueSource: {}, run: { proxy: '' } }, { remoteAddress: () => '127.0.0.1' });
  return { fake, base, get: (p, headers = {}) => fetch(`${base}${p}`, { headers }), post: (p, body = {}) => fetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) };
}

test('etagOf / etagMatches: کلید ِ ناپایدار در هش نیست؛ مقایسه‌ی ضعیف و فهرست و *', () => {
  const a = { generatedAt: '1', tasks: [{ id: '1' }] };
  const b = { generatedAt: '2', tasks: [{ id: '1' }] };
  const c = { generatedAt: '1', tasks: [{ id: '2' }] };
  assert.equal(etagOf(a, ['generatedAt']), etagOf(b, ['generatedAt']));
  assert.notEqual(etagOf(a, ['generatedAt']), etagOf(c, ['generatedAt']));
  assert.notEqual(etagOf(a), etagOf(b)); // بدون کلید ِ ناپایدار هر دو فرق دارند
  const tag = etagOf(a, ['generatedAt']);
  assert.equal(etagMatches(tag, tag), true);
  assert.equal(etagMatches(`"x", ${tag}`, tag), true);
  assert.equal(etagMatches(tag.replace('W/', ''), tag), true);
  assert.equal(etagMatches('*', tag), true);
  assert.equal(etagMatches('W/"other"', tag), false);
  assert.equal(etagMatches(undefined, tag), false);
});

test('board: ETag؛ If-None-Match ⇒ 304 بدون بدنه؛ فقط generatedAt عوض شود ⇒ باز 304؛ داده عوض شود ⇒ 200 با ETag ِ تازه', async t => {
  const { fake, get } = await boot(t);
  const first = await get('/api/repos/fake/board');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^W\/"/);
  assert.equal((await first.json()).tasks.length, 1);

  const same = await get('/api/repos/fake/board', { 'If-None-Match': etag });
  assert.equal(same.status, 304);
  assert.equal(await same.text(), '');
  assert.equal(same.headers.get('etag'), etag);

  fake.setStatus({ ...STATUS(), generatedAt: '2026-11-04T10:00:03Z' }); // فقط زمان ِ تولید
  assert.equal((await get('/api/repos/fake/board', { 'If-None-Match': etag })).status, 304);

  fake.setStatus(STATUS({ state: 'approved' })); // داده‌ی واقعی
  const changed = await get('/api/repos/fake/board', { 'If-None-Match': etag });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.get('etag'), etag);
  assert.equal((await changed.json()).tasks[0].state, 'approved');
});

test('running و health و events هم ETag/304 دارند؛ بدون If-None-Match همان رفتار ِ قبلی (200 کامل)', async t => {
  const { fake, get } = await boot(t);
  fake.setEvents([{ event: 'state.changed', at: '2026-11-04T10:00:00Z' }]);
  for (const p of ['/api/repos/fake/running', '/api/repos/fake/health', '/api/repos/fake/tasks/3/events']) {
    const first = await get(p);
    assert.equal(first.status, 200, p);
    const etag = first.headers.get('etag');
    assert.ok(etag, `${p} ETag دارد`);
    await first.text();
    const again = await get(p, { 'If-None-Match': etag });
    assert.equal(again.status, 304, p);
  }
});

test('یک اجرای status برای چند کلاینت ِ هم‌زمان و poll های ِ پشت‌سرهم (در بازه‌ی cache)؛ تغییر یا گذشتن ِ مهلت ⇒ اجرای تازه', async t => {
  const { fake, get, post } = await boot(t, { statusDelayMs: 250, server: { boardCacheMs: 600 } });
  await get('/api/repos'); // ورود (POST) پیش از شمارش؛ وگرنه ورودهای ِ هم‌زمان cache را باطل می‌کنند
  // ۵ کلاینت ِ هم‌زمان (مثل ۵ tab) — یک اجرا
  const burst = await Promise.all(Array.from({ length: 5 }, () => get('/api/repos/fake/board')));
  assert.deepEqual(burst.map(r => r.status), [200, 200, 200, 200, 200]);
  assert.equal(boardStatusCalls(fake), 1, '۵ درخواست ِ هم‌زمان ⇒ یک اجرای status');
  // poll های ِ بعدی در بازه‌ی cache: باز هم همان یکی
  await get('/api/repos/fake/board'); await get('/api/repos/fake/board');
  assert.equal(boardStatusCalls(fake), 1, 'در بازه‌ی cache اجرای تازه نیست');
  // درخواست ِ تغییردهنده cache را باطل می‌کند
  await post('/api/drain');
  await get('/api/repos/fake/board');
  assert.equal(boardStatusCalls(fake), 2, 'بعد از تغییر ِ وضعیت، اجرای تازه');
  // گذشتن ِ مهلت
  await new Promise(r => setTimeout(r, 700));
  await get('/api/repos/fake/board');
  assert.equal(boardStatusCalls(fake), 3, 'بعد از مهلت، اجرای تازه');
});

test('boardCacheMs=0: هر درخواست اجرای تازه می‌گیرد (رفتار ِ قدیمی، برای تست)', async t => {
  const { fake, get } = await boot(t);
  await get('/api/repos/fake/board'); await get('/api/repos/fake/board');
  assert.equal(boardStatusCalls(fake), 2);
});

test('stream: ?tail=N فقط N خط ِ آخر را replay می‌کند و رویداد ِ replay تعداد ِ کنارگذاشته را می‌گوید', async t => {
  const run = "for (let i = 1; i <= 40; i += 1) console.log('line-' + i); process.exit(0);";
  const { get, post } = await boot(t, { run });
  assert.equal((await post('/api/repos/fake/tasks/3/run')).status, 202);
  await waitUntil(async () => (await (await get('/api/repos/fake/running')).json()).every(r => !r.running && !r.queued), 10_000);

  const text = await (await get('/api/repos/fake/tasks/3/stream?tail=5')).text();
  const lines = [...text.matchAll(/^data: (\{.*"text":"(line-\d+)".*)$/gm)].map(m => m[2]);
  assert.deepEqual(lines, ['line-36', 'line-37', 'line-38', 'line-39', 'line-40']);
  assert.match(text, /event: replay\ndata: \{"skipped":\d+,"total":\d+\}/);
  const skipped = Number(/"skipped":(\d+)/.exec(text)[1]);
  assert.ok(skipped >= 35, `skipped=${skipped}`);

  const full = await (await get('/api/repos/fake/tasks/3/stream')).text();
  assert.ok([...full.matchAll(/"text":"line-\d+"/g)].length === 40, 'بدون tail همه‌ی خط‌ها');
  assert.doesNotMatch(full, /event: replay/);
});

test('artifact: ?lines=N&from=head|tail می‌برد و هدرها می‌گویند؛ بدون lines همان قبلی', async t => {
  const { fake, get } = await boot(t);
  const body = Array.from({ length: 50 }, (_, i) => `row ${i + 1}`).join('\n');
  fake.setArtifacts({ 'build.log': body, 'small.txt': 'a\nb' });

  const tail = await get('/api/repos/fake/tasks/3/artifact?path=build.log&lines=3&from=tail');
  assert.equal(await tail.text(), 'row 48\nrow 49\nrow 50');
  assert.equal(tail.headers.get('x-artifact-clipped'), 'tail');
  assert.equal(tail.headers.get('x-artifact-total-lines'), '50');

  const head = await get('/api/repos/fake/tasks/3/artifact?path=build.log&lines=2');
  assert.equal(await head.text(), 'row 1\nrow 2');
  assert.equal(head.headers.get('x-artifact-clipped'), 'head');

  const small = await get('/api/repos/fake/tasks/3/artifact?path=small.txt&lines=100');
  assert.equal(await small.text(), 'a\nb');
  assert.equal(small.headers.get('x-artifact-clipped'), null);

  const whole = await get('/api/repos/fake/tasks/3/artifact?path=build.log');
  assert.equal((await whole.text()).split('\n').length, 50);
  assert.equal(whole.headers.get('x-artifact-total-lines'), null);
});
