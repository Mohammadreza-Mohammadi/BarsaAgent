import test from 'node:test';
import assert from 'node:assert/strict';
// منطق خالص آرشیو (TypeScript با سینتکس قابل‌حذف) مستقیم با node بارگذاری می‌شود.
import {
  FINISHED_STATES, BOARD_DONE_STATES, DEFAULT_DONE_DAYS, isFinished, finishedAt, isRecentlyDone, archiveTasks, queryArchive, normalizeDoneDays
} from '../../client/src/app/task-archive.ts';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';

const NOW = new Date('2026-10-19T12:00:00');
const daysAgo = days => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const task = (id, state, since, extra = {}) => ({ id: String(id), state, stateSince: since, title: `تسک ${id}`, ...extra });

const TASKS = [
  task(1, 'integrated', daysAgo(1), { title: 'ادغام تازه', source: { externalId: '3952' }, git: { mergeCommit: 'abcdef1234567890' } }),
  task(2, 'integrated', daysAgo(10), { title: 'ادغام قدیمی', source: { externalId: '3800' } }),
  task(3, 'cancelled', daysAgo(1), { title: 'لغو تازه' }),
  task(4, 'abandoned', daysAgo(30), { title: 'کنار گذاشته' }),
  task(5, 'blocked', daysAgo(40), { title: 'بلاک‌شده‌ی خیلی قدیمی' }),
  task(6, 'implementing', daysAgo(50), { title: 'در حال کار' }),
  task(7, 'integrated', undefined, { title: 'بدون تاریخ' }),
  task(8, 'integrated', 'نامعتبر', { title: 'تاریخ خراب' }),
  { id: '9', state: 'integrated', stateSince: daysAgo(2), error: 'manifest خراب' }
];

test('دسته‌بندی «پایان‌یافته» از یک فهرست واحد می‌آید و blocked در آن نیست', () => {
  assert.deepEqual([...FINISHED_STATES], ['integrated', 'cancelled', 'abandoned']);
  assert.ok(BOARD_DONE_STATES.every(s => FINISHED_STATES.includes(s)));
  for (const s of FINISHED_STATES) assert.equal(isFinished({ state: s }), true, s);
  for (const s of ['blocked', 'implementing', 'review', 'new', 'awaiting-external-checkin']) assert.equal(isFinished({ state: s }), false, s);
});

test('finishedAt از stateSince: معتبر، غایب و خراب', () => {
  assert.equal(finishedAt({ stateSince: '2026-10-01T10:00:00Z' }).toISOString(), '2026-10-01T10:00:00.000Z');
  assert.equal(finishedAt({}), null);
  assert.equal(finishedAt({ stateSince: 'نامعتبر' }), null);
});

test('برد: integrated قدیمی‌تر از N روز در ستون «تمام» نیست و در آرشیو هست؛ تازه‌ها در برد می‌مانند', () => {
  const byId = id => TASKS.find(t => t.id === String(id));
  assert.equal(isRecentlyDone(byId(1), 3, NOW), true, 'یک روز پیش، N=3');
  assert.equal(isRecentlyDone(byId(2), 3, NOW), false, 'ده روز پیش، N=3');
  assert.equal(isRecentlyDone(byId(2), 30, NOW), true, 'با N بزرگ‌تر برمی‌گردد');
  assert.equal(archiveTasks(TASKS).some(t => t.id === '2'), true, 'ولی همیشه در آرشیو است');
  // N از config: پیش‌فرض ۳ و مقدار نامعتبر به پیش‌فرض برمی‌گردد
  assert.equal(DEFAULT_DONE_DAYS, 3);
  for (const bad of [undefined, null, 0, -2, 'abc', NaN]) assert.equal(normalizeDoneDays(bad), 3, String(bad));
  assert.equal(normalizeDoneDays(7), 7);
  assert.equal(normalizeDoneDays('5'), 5);
});

test('cancelled/abandoned هیچ‌وقت در ستون‌های برد نیستند (حتی تازه)، ولی در آرشیواند', () => {
  const cancelledFresh = TASKS.find(t => t.id === '3');
  assert.equal(isRecentlyDone(cancelledFresh, 3, NOW), false);
  assert.deepEqual(archiveTasks(TASKS).map(t => t.id).sort(), ['1', '2', '3', '4', '7', '8']);
});

test('blocked همیشه روی برد است: در آرشیو نمی‌آید و «پایان‌یافته» نیست، هر قدر قدیمی باشد', () => {
  const blocked = TASKS.find(t => t.state === 'blocked');
  assert.equal(isFinished(blocked), false);
  assert.equal(isRecentlyDone(blocked, 3, NOW), false);
  assert.equal(archiveTasks(TASKS).includes(blocked), false);
  assert.equal(queryArchive(TASKS, { states: ['blocked'] }).total, 0);
});

test('taskهای بدون/با تاریخ خراب و خطادار: در برد نمی‌آیند؛ خطادار در آرشیو نیست', () => {
  assert.equal(isRecentlyDone(TASKS.find(t => t.id === '7'), 3, NOW), false);
  assert.equal(isRecentlyDone(TASKS.find(t => t.id === '8'), 3, NOW), false);
  assert.equal(archiveTasks(TASKS).some(t => t.id === '9'), false);
});

test('جست‌وجو: عنوان (بدون حساسیت به حروف)، شماره، و #شماره', () => {
  const ids = q => queryArchive(TASKS, { search: q }).rows.map(t => t.id).sort();
  assert.deepEqual(ids('ادغام'), ['1', '2']);
  assert.deepEqual(ids('قدیمی'), ['2']);
  assert.deepEqual(ids('#4'), ['4']);
  assert.deepEqual(ids('3'), ['3']);
  assert.deepEqual(ids('  لغو  '), ['3']);
  assert.deepEqual(ids('هیچی'), []);
  assert.equal(queryArchive([task(10, 'integrated', daysAgo(1), { title: 'Fix Login BUG' })], { search: 'login bug' }).total, 1);
});

test('فیلتر state و بازه‌ی تاریخ (دو سر شامل)', () => {
  const ids = q => queryArchive(TASKS, q).rows.map(t => t.id).sort();
  assert.deepEqual(ids({ states: ['cancelled'] }), ['3']);
  assert.deepEqual(ids({ states: ['cancelled', 'abandoned'] }), ['3', '4']);
  assert.deepEqual(ids({ states: [] }), ['1', '2', '3', '4', '7', '8'], 'خالی = همه‌ی پایان‌یافته‌ها');

  const day = n => { const d = new Date(NOW.getTime() - n * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  assert.deepEqual(ids({ from: day(2) }), ['1', '3'], 'از ۲ روز پیش');
  assert.deepEqual(ids({ to: day(5) }), ['2', '4'], 'تا ۵ روز پیش');
  assert.deepEqual(ids({ from: day(10), to: day(10) }), ['2'], 'یک روز کامل (هر دو سر شامل)');
  assert.deepEqual(ids({ from: day(40), to: day(20) }), ['4']);
  assert.deepEqual(ids({ from: '2999-01-01' }), [], 'بدون تاریخ‌ها هم وقتی فیلتر تاریخ هست حذف می‌شوند');
  assert.deepEqual(ids({ states: ['integrated'], from: day(2), search: 'تازه' }), ['1'], 'فیلترها ترکیب می‌شوند');
  assert.deepEqual(ids({ from: 'خراب', to: '' }), ['1', '2', '3', '4', '7', '8'], 'تاریخ نامعتبر نادیده گرفته می‌شود');
});

test('مرتب‌سازی: پیش‌فرض جدیدترین بالا؛ بدون تاریخ همیشه ته؛ جهت و کلیدها', () => {
  const ids = q => queryArchive(TASKS, q).rows.map(t => t.id);
  assert.deepEqual(ids({}), ['3', '1', '2', '4', '8', '7'], 'تاریخ نزولی (۱ و ۳ هم‌زمان‌اند → شماره‌ی بزرگ‌تر اول)؛ ۷ و ۸ بدون تاریخ‌اند و ته فهرست');
  assert.deepEqual(ids({ sortDir: 'asc' }), ['4', '2', '3', '1', '8', '7'], 'صعودی هم بدون تاریخ‌ها را ته می‌گذارد');
  assert.deepEqual(ids({ sortKey: 'id', sortDir: 'asc' }), ['1', '2', '3', '4', '7', '8']);
  assert.deepEqual(ids({ sortKey: 'id', sortDir: 'desc' }), ['8', '7', '4', '3', '2', '1']);
  assert.deepEqual(ids({ sortKey: 'state', sortDir: 'asc' }).slice(0, 2), ['4', '3'], 'abandoned < cancelled');
  assert.deepEqual(ids({ sortKey: 'externalId', sortDir: 'desc' }).slice(0, 2), ['1', '2'], 'عددی: 3952 > 3800');
  assert.equal(ids({ sortKey: 'title', sortDir: 'asc' }).length, 6);
  // شماره‌ها عددی مرتب می‌شوند نه رشته‌ای (۱۰ بعد از ۹)
  const many = [9, 10, 100].map(n => task(n, 'integrated', daysAgo(1)));
  assert.deepEqual(queryArchive(many, { sortKey: 'id', sortDir: 'asc' }).rows.map(t => t.id), ['9', '10', '100']);
});

test('صفحه‌بندی: اندازه، تعداد صفحه، clamp و ورودی خراب', () => {
  const many = Array.from({ length: 53 }, (_, i) => task(i + 1, 'integrated', daysAgo(1 + i / 100)));
  const first = queryArchive(many, { pageSize: 25 });
  assert.equal(first.total, 53);
  assert.equal(first.pages, 3);
  assert.equal(first.page, 1);
  assert.equal(first.rows.length, 25);
  assert.equal(queryArchive(many, { pageSize: 25, page: 3 }).rows.length, 3);
  assert.equal(queryArchive(many, { pageSize: 25, page: 99 }).page, 3, 'صفحه‌ی بیش از حد به آخر می‌رود');
  assert.equal(queryArchive(many, { pageSize: 25, page: -4 }).page, 1);
  const empty = queryArchive([], {});
  assert.deepEqual([empty.total, empty.pages, empty.page, empty.rows.length], [0, 1, 1, 0]);
  // صفحه‌ها هم‌پوشانی ندارند و همه‌ی ردیف‌ها را می‌پوشانند
  const seen = new Set();
  for (let p = 1; p <= 3; p += 1) for (const t of queryArchive(many, { pageSize: 25, page: p }).rows) seen.add(t.id);
  assert.equal(seen.size, 53);
});

test('سرور: board.doneDays از config به UI می‌رسد (پیش‌فرض ۳، نامعتبر → ۳)', async t => {
  const fake = makeFakeManagerRepo(t);
  const read = async config => {
    const { base } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, ...config });
    return (await (await authedFetch(`${base}/api/repos`)).json())[0].board;
  };
  assert.deepEqual(await read({}), { doneDays: 3 });
  assert.deepEqual(await read({ board: { doneDays: 7 } }), { doneDays: 7 });
  assert.deepEqual(await read({ board: { doneDays: 0 } }), { doneDays: 3 });
  assert.deepEqual(await read({ board: { doneDays: 'x' } }), { doneDays: 3 });
});
