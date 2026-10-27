import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { removeDirOnCleanup, waitUntil } from './cleanup.js';
import { UploadStore, safeUploadName } from '../src/uploads.js';
import { checkUpload, createPolicyReader, policyView } from '../src/attachment-policy.js';
import { RemoteTokenStore } from '../src/remote-tokens.js';
import { isRemoteAllowed, REMOTE_ENDPOINTS } from '../src/remote-cli-spec.js';

// پیوست ِ فایل (TOOLING-050 د): آپلود ِ موقت در dataDir، فراخوانی ِ Manager با attach / --attach، پاک‌سازی، سقف‌ها، و خواندن ِ ایمن. کانبان
// هیچ‌وقت در attachments.root نمی‌نویسد.

const body = (size, fill = 0x41) => Buffer.alloc(size, fill);
const upload = (headers = {}, ...chunks) => Object.assign(Readable.from(chunks.map(c => Buffer.from(c))), { headers });
const tmpDir = (t, prefix) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); removeDirOnCleanup(t, dir); return dir; };

// --- UploadStore ----------------------------------------------------------------------------------------------------

test('UploadStore: نام ِ امن، دریافت با سقف ِ جریانی، مالکیت، سقف ِ تعداد، مهلت و پاک‌سازی', async t => {
  assert.equal(safeUploadName('..\\..\\evil/name.png'), 'name.png');
  assert.equal(safeUploadName('C:\\x\\y\\تصویر صفحه.png'), 'تصویر صفحه.png');
  assert.equal(safeUploadName('تصویر ِ صفحه.png'), 'تصویر _ صفحه.png', 'نشانه‌ی ترکیبی مثل Manager به _ بدل می‌شود (Manager دوباره می‌سنجد)');
  assert.equal(safeUploadName('a<b>:c|d?.txt'), 'a_b__c_d_.txt');
  assert.equal(safeUploadName('   ...'), 'attachment');
  assert.equal(safeUploadName('con.txt'), '_con.txt', 'نام ِ رزروشده‌ی ویندوز');
  assert.ok(safeUploadName(`${'x'.repeat(300)}.png`).length <= 100 && safeUploadName(`${'x'.repeat(300)}.png`).endsWith('.png'));

  const dir = tmpDir(t, 'barsa-uploads-');
  let clock = Date.now();
  const store = new UploadStore(dir, { ttlMs: 60_000, maxPerUser: 2, now: () => clock });
  const files = () => fs.readdirSync(store.root);

  const meta = await store.receive(upload({ 'content-length': '5' }, 'hello'), { user: 'ali', name: 'a.txt', maxBytes: 100 });
  assert.deepEqual({ name: meta.name, size: meta.size, ext: meta.ext }, { name: 'a.txt', size: 5, ext: '.txt' });
  assert.equal(fs.readFileSync(store.take(meta.id, 'ali').file, 'utf8'), 'hello');
  assert.throws(() => store.take(meta.id, 'reza'), /مال کاربر دیگری/);
  assert.throws(() => store.take('../../etc/passwd', 'ali'), /شناسه‌ی آپلود نامعتبر/);
  assert.throws(() => store.take('00000000-0000-4000-8000-000000000000', 'ali'), /پیدا نشد|منقضی/);

  // سقف: اعلام‌شده (بدون خواندن ِ بدنه) و در جریان (بدون content-length)؛ هیچ بقایایی نمی‌ماند
  const before = files().length;
  await assert.rejects(store.receive(upload({ 'content-length': '999' }, 'x'), { user: 'ali', name: 'b.txt', maxBytes: 100 }), error => error.status === 413);
  await assert.rejects(store.receive(upload({}, 'x'.repeat(60), 'y'.repeat(60)), { user: 'ali', name: 'b.txt', maxBytes: 100 }), error => error.status === 413);
  await assert.rejects(store.receive(upload({}, ''), { user: 'ali', name: 'e.txt', maxBytes: 100 }), error => error.status === 400);
  assert.equal(files().length, before, 'آپلود ِ ردشده چیزی جا نمی‌گذارد');

  await store.receive(upload({}, 'two'), { user: 'ali', name: 'c.txt', maxBytes: 100 });
  await assert.rejects(store.receive(upload({}, 'three'), { user: 'ali', name: 'd.txt', maxBytes: 100 }), error => error.status === 429);
  await store.receive(upload({}, 'other'), { user: 'reza', name: 'd.txt', maxBytes: 100 }); // سقف ِ هر کاربر جدا

  // مهلت: بعد از TTL پاک می‌شود
  assert.ok(files().length > 0);
  clock += 120_000;
  fs.utimesSync(store.root, new Date(clock - 200_000), new Date(clock - 200_000));
  for (const name of files()) fs.utimesSync(path.join(store.root, name), new Date(clock - 200_000), new Date(clock - 200_000));
  store.sweep();
  assert.deepEqual(files(), [], 'sweep فایل‌های قدیمی را پاک کرد');

  const again = await store.receive(upload({}, 'zzz'), { user: 'ali', name: 'z.txt', maxBytes: 100 });
  assert.equal(store.discard(again.id), true);
  assert.throws(() => store.take(again.id, 'ali'), /پیدا نشد/);
});

// --- سیاست ِ Manager ---------------------------------------------------------------------------------------------------

const INFO = {
  configured: true, forbidden: ['.exe', '.js', '.svg', '.html'],
  policy: { kinds: { image: { extensions: ['.png', '.jpg'], maxBytes: 4096 }, text: { extensions: ['.txt'], maxBytes: 2048 } } }
};
const LIMITS = { maxUploadBytes: 100_000, maxFiles: 20 };

test('checkUpload: پسوند ِ ممنوع (هر بخش ِ نقطه‌دار)، نامجاز، سقف ِ نوع ∧ سقف ِ سرور؛ بدون policy فقط سقف ِ سرور', () => {
  assert.deepEqual(checkUpload({ name: 'a.png', size: 100 }, INFO, LIMITS), { ok: true, kind: 'image', cap: 4096 });
  assert.match(checkUpload({ name: 'run.exe', size: 1 }, INFO, LIMITS).message, /\.exe ممنوع/);
  assert.match(checkUpload({ name: 'evil.exe.png', size: 1 }, INFO, LIMITS).message, /\.exe ممنوع/);
  assert.match(checkUpload({ name: 'x.docx', size: 1 }, INFO, LIMITS).message, /«\.docx» مجاز نیست\. مجاز: \.png \.jpg \.txt/);
  assert.match(checkUpload({ name: 'a.png', size: 5000 }, INFO, LIMITS).message, /از سقف ِ نوع ِ image/);
  assert.deepEqual(checkUpload({ name: 'a.png', size: 100 }, INFO, { maxUploadBytes: 1000, maxFiles: 5 }), { ok: true, kind: 'image', cap: 1000 }, 'سقف ِ سرور کوچک‌تر برنده است');
  assert.deepEqual(checkUpload({ name: 'a.exe', size: 100 }, null, LIMITS), { ok: true, kind: null, cap: 100_000 }, 'Manager قدیمی: تصمیم با Manager');
  assert.match(checkUpload({ name: 'a.png', size: 200_000 }, null, LIMITS).message, /سقف ِ سرور/);
  const view = policyView(INFO, LIMITS);
  assert.deepEqual([view.available, view.configured, view.kinds.image.maxBytes, view.forbidden.includes('.exe'), view.maxFiles], [true, true, 4096, true, 20]);
  assert.deepEqual(policyView(null, LIMITS), { available: false, configured: null, kinds: null, forbidden: null, maxUploadBytes: 100_000, maxFiles: 20 });
});

test('createPolicyReader: کش ِ کوتاه؛ و خواندن ِ واقعی از scripts/lib/attachments.js ِ Manager (بدون نوشتن؛ root را بیرون نمی‌دهد)', async t => {
  let calls = 0;
  let clock = 0;
  const reader = createPolicyReader({ run: async () => { calls += 1; return INFO; }, now: () => clock });
  const repo = { id: 'r', path: '/x' };
  await reader(repo); await reader(repo);
  assert.equal(calls, 1);
  clock += 61_000;
  await reader(repo);
  assert.equal(calls, 2);

  const fake = makeFakeManagerRepo(t);
  const real = createPolicyReader();
  assert.equal(await real(fake.repo), null, 'Manager ِ قدیمی (کتابخانه نیست) ← null، نه خطا');

  fs.mkdirSync(path.join(fake.root, 'scripts', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(fake.root, 'scripts', 'lib', 'attachments.js'), `
module.exports = {
  FORBIDDEN_EXTENSIONS: ['.exe', '.svg'],
  loadAttachmentsConfig() { return { root: 'D:/secret/attachments', ffmpeg: null, policy: { kinds: { image: { extensions: ['.png'], maxBytes: 1024 } }, videoFrames: 6, videoFrameIntervalSeconds: 5 } }; }
};`);
  const info = await createPolicyReader()(fake.repo);
  assert.deepEqual(info.forbidden, ['.exe', '.svg']);
  assert.deepEqual(info.policy.kinds.image, { extensions: ['.png'], maxBytes: 1024 });
  assert.equal(info.configured, true);
  assert.ok(!JSON.stringify(info).includes('secret'), 'مسیر ِ root بیرون داده نمی‌شود');
});

// --- HTTP ---------------------------------------------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const STUB_LIB = `
module.exports = {
  FORBIDDEN_EXTENSIONS: ['.exe', '.js', '.svg', '.html'],
  loadAttachmentsConfig() { return { root: 'x', ffmpeg: null, policy: { kinds: { image: { extensions: ['.png', '.jpg'], maxBytes: 4096 }, text: { extensions: ['.txt', '.md'], maxBytes: 2048 }, pdf: { extensions: ['.pdf'], maxBytes: 4096 } }, videoFrames: 6, videoFrameIntervalSeconds: 5 } }; }
};`;
// manager ِ ساختگی: محتوای هر فایل ِ داده‌شده به attach / --attach را (تا وقتی هنوز هست) ثبت می‌کند تا ثابت شود پیش از پاک‌سازی خوانده شد.
const EXTRA = `
{
  const seen = [];
  const f = fileArg('--file');
  if (cmd === 'attach' && f) seen.push({ via: 'attach', name: fileArg('--name'), reason: fileArg('--reason'), exists: fs.existsSync(f), text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8').slice(0, 40) : null });
  args.forEach((a, i) => { if (a === '--attach') { const p = args[i + 1]; seen.push({ via: '--attach', name: path.basename(p), exists: fs.existsSync(p), text: fs.existsSync(p) ? fs.readFileSync(p, 'utf8').slice(0, 40) : null }); } });
  if (seen.length) fs.appendFileSync(path.join(dir, 'attached.jsonl'), seen.map(x => JSON.stringify(x)).join('\\n') + '\\n');
}`;
const task = (id, extra = {}) => ({ id: String(id), title: `تسک ${id}`, state: 'implementing', stateSince: '2026-10-27T08:00:00Z', awaitingHuman: null, blocker: null, actions: {}, attempts: [], ...extra });
const status = (tasks = [task(7)]) => ({ schemaVersion: 1, generatedAt: '2026-10-27T08:00:00Z', repo: { head: 'e'.repeat(40) }, repository: { health: { managerLock: null, unownedDirtyFiles: [], acceptsOperations: true }, execution: { enabled: true, source: 'default', reason: null } }, tasks });
const OK_CLAUDE = { command: process.execPath, versionArgs: ['--version'], authArgs: ['--version'] };

async function boot(t, { tasks, config = {}, withLib = true } = {}) {
  const fake = makeFakeManagerRepo(t, { status: status(tasks), extra: EXTRA });
  if (withLib) {
    fs.mkdirSync(path.join(fake.root, 'scripts', 'lib'), { recursive: true });
    fs.writeFileSync(path.join(fake.root, 'scripts', 'lib', 'attachments.js'), STUB_LIB);
  }
  const cfg = { repos: [fake.repo], server: {}, issueSource: {}, run: { proxy: '', stopGraceMs: 300 }, health: { claude: OK_CLAUDE, proxyTestUrl: 'http://127.0.0.1:9/' }, ...config };
  const s = await startAuthedServer(t, cfg, { exit() {}, shutdownLog: { info() {}, warn() {} } });
  const uploadsDir = path.join(s.config.dataDir, 'uploads');
  const attached = () => { try { return fs.readFileSync(path.join(fake.root, 'attached.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
  const stage = async (name, data = PNG) => {
    const response = await authedFetch(`${s.base}/api/uploads?repo=fake&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: data });
    return { status: response.status, json: await response.json() };
  };
  const post = (p, payload) => authedFetch(`${s.base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}) });
  const staged = () => (fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).filter(n => !n.endsWith('.json')) : []);
  return { fake, ...s, uploadsDir, attached, stage, post, staged };
}

test('سیاست و آپلود: فهرست ِ Manager در GET /api/attachments/policy؛ آپلود ِ موفق؛ ممنوع/نامجاز/بزرگ/نام ِ خالی رد؛ بدون بقایا', async t => {
  const s = await boot(t);
  const policy = await (await authedFetch(`${s.base}/api/attachments/policy?repo=fake`)).json();
  assert.equal(policy.available, true);
  assert.deepEqual(policy.kinds.image, { extensions: ['.png', '.jpg'], maxBytes: 4096 });
  assert.ok(policy.forbidden.includes('.exe'));
  assert.deepEqual([policy.maxUploadBytes, policy.maxFiles], [200 * 1024 * 1024, 20], 'سقف ِ پیش‌فرض ِ سرور');

  const ok = await s.stage('shot.png', body(3000));
  assert.equal(ok.status, 201);
  assert.deepEqual({ name: ok.json.name, size: ok.json.size, kind: ok.json.kind, ext: ok.json.ext }, { name: 'shot.png', size: 3000, kind: 'image', ext: '.png' });
  assert.equal(fs.statSync(path.join(s.uploadsDir, ok.json.id, 'shot.png')).size, 3000, 'در پوشه‌ی موقت ِ dataDir');

  const before = fs.readdirSync(s.uploadsDir).length;
  assert.equal((await s.stage('run.exe')).status, 400);
  assert.equal((await s.stage('evil.exe.png')).status, 400);
  assert.equal((await s.stage('x.docx')).status, 400);
  const big = await s.stage('big.png', body(5000));
  assert.equal(big.status, 413);
  assert.match(big.json.error, /سقف/);
  const missingName = await authedFetch(`${s.base}/api/uploads?repo=fake`, { method: 'POST', body: PNG });
  assert.equal(missingName.status, 400);
  assert.equal(fs.readdirSync(s.uploadsDir).length, before, 'آپلود ِ ردشده چیزی نمی‌گذارد');

  // حذف
  const del = await authedFetch(`${s.base}/api/uploads/${ok.json.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal(fs.existsSync(path.join(s.uploadsDir, ok.json.id)), false);
  assert.equal((await authedFetch(`${s.base}/api/uploads/${ok.json.id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await authedFetch(`${s.base}/api/uploads/not-an-id`, { method: 'DELETE' })).status, 400);
});

test('سقف ِ سرور (config.attachments.maxUploadBytes) پیش از سقف ِ نوع؛ Manager ِ قدیمی (بدون policy) ← فقط سقف ِ سرور', async t => {
  const small = await boot(t, { config: { attachments: { maxUploadBytes: 2048 } } });
  assert.equal((await small.stage('a.png', body(3000))).status, 413, 'نوع ۴۰۹۶ می‌دهد ولی سرور ۲۰۴۸');
  assert.equal((await small.stage('a.png', body(2000))).status, 201);

  const old = await boot(t, { withLib: false, config: { attachments: { maxUploadBytes: 2048 } } });
  const policy = await (await authedFetch(`${old.base}/api/attachments/policy?repo=fake`)).json();
  assert.deepEqual([policy.available, policy.kinds], [false, null]);
  assert.equal((await old.stage('run.exe', body(100))).status, 201, 'پسوند را Manager می‌سنجد (policy در دسترس نیست)');
  assert.equal((await old.stage('a.png', body(3000))).status, 413);
});

test('attach به تسک ِ موجود: manager.js attach با --file/--name/--reason ِ ثابت؛ فایل پیش از پاک‌سازی خوانده شد؛ سپس موقت پاک', async t => {
  const s = await boot(t);
  const a = await s.stage('shot.png', body(100, 0x42));
  const b = await s.stage('notes.txt', Buffer.from('یادداشت فارسی'));
  const response = await s.post('/api/repos/fake/tasks/7/attach', { uploads: [a.json.id, b.json.id] });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, added: ['shot.png', 'notes.txt'], failed: [] });

  const calls = s.fake.calls().filter(c => c.args[0] === 'attach');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 2), ['attach', '7']);
  assert.deepEqual(calls[0].args.slice(4), ['--name', 'shot.png', '--reason', 'added from Kanban console']);
  const seen = s.attached();
  assert.deepEqual(seen.map(x => [x.via, x.name, x.exists]), [['attach', 'shot.png', true], ['attach', 'notes.txt', true]], 'Manager فایل را دید');
  assert.equal(seen[0].reason, 'added from Kanban console');
  assert.equal(seen[1].text, 'یادداشت فارسی');
  assert.deepEqual(s.staged(), [], 'فایل ِ موقت بعد از attach پاک شد');
});

test('attach: رد ِ Manager (پسوند/اندازه) پیام ِ خودش را می‌دهد و آپلود پاک می‌شود؛ بدون آپلود/شناسه‌ی بد/از راه دور رد', async t => {
  const s = await boot(t);
  const a = await s.stage('shot.png', body(100));
  s.fake.setFail({ attach: { code: 1, stderr: 'پسوند ِ .png در این مخزن ممنوع شده' } });
  const rejected = await s.post('/api/repos/fake/tasks/7/attach', { uploads: [a.json.id] });
  assert.ok(rejected.status >= 400 && rejected.status < 500);
  assert.match((await rejected.json()).error, /پسوند ِ \.png در این مخزن ممنوع/);
  assert.deepEqual(s.staged(), []);

  s.fake.setFail({});
  assert.equal((await s.post('/api/repos/fake/tasks/7/attach', { uploads: [] })).status, 400);
  assert.equal((await s.post('/api/repos/fake/tasks/7/attach', {})).status, 400);
  assert.equal((await s.post('/api/repos/fake/tasks/7/attach', { uploads: ['x'] })).status, 400);
  assert.equal((await s.post('/api/repos/fake/tasks/7/attach', { uploads: ['00000000-0000-4000-8000-000000000000'] })).status, 404);
  assert.equal((await s.post('/api/repos/fake/tasks/bad%20id/attach', { uploads: [] })).status === 400, true);

  // چند فایل و همه رد: 207 با فهرست ِ ردها
  const x = await s.stage('a.png');
  const y = await s.stage('b.png');
  s.fake.setFail({ attach: { code: 1, stderr: 'رد شد' } });
  const multi = await s.post('/api/repos/fake/tasks/7/attach', { uploads: [x.json.id, y.json.id] });
  assert.equal(multi.status, 207);
  const result = await multi.json();
  assert.deepEqual([result.ok, result.added, result.failed.map(f => f.name)], [false, [], ['a.png', 'b.png']]);
});

test('ساخت ِ تسک با پیوست: import-issue --attach (تکرارشونده)؛ فایل بعد از موفقیت پاک؛ با شکست می‌ماند تا دوباره امتحان شود؛ attachment-invalid پیام ِ Manager', async t => {
  const s = await boot(t);
  const a = await s.stage('shot.png', body(100, 0x43));
  const b = await s.stage('notes.md', Buffer.from('# n'));
  const draft = ids => ({ repo: 'fake', type: 'task', slug: 'with-files', requestText: 'متن', source: { system: 'internal', externalId: 'manual-1' }, attachments: ids });

  s.fake.setFail({ 'import-issue': { code: 1, stdout: JSON.stringify({ ok: false, error: 'attachment-invalid', exitCode: 1, message: 'پسوند ِ .png مجاز نیست' }), stderr: '' } });
  const failed = await (await s.post('/api/tasks/create', { items: [draft([a.json.id, b.json.id])], start: false })).json();
  assert.equal(failed.failed, 1);
  assert.equal(failed.results[0].structured.kind, 'attachment-invalid');
  assert.match(failed.results[0].message, /پسوند ِ \.png مجاز نیست/);
  assert.equal(s.staged().length, 2, 'با شکست آپلودها می‌مانند');

  s.fake.setFail({});
  const ok = await (await s.post('/api/tasks/create', { items: [draft([a.json.id, b.json.id])], start: false })).json();
  assert.equal(ok.succeeded, 1, JSON.stringify(ok));
  const call = s.fake.calls().filter(c => c.args[0] === 'import-issue').at(-1);
  assert.equal(call.args.filter(x => x === '--attach').length, 2);
  assert.deepEqual(s.attached().filter(x => x.via === '--attach').map(x => [x.name, x.exists]), [['shot.png', true], ['notes.md', true]]);
  assert.deepEqual(s.staged(), [], 'بعد از موفقیت پاک شد');

  // پیوست بدون تسک/شناسه‌ی بد: همان خطای آپلود
  const bad = await (await s.post('/api/tasks/create', { items: [draft(['00000000-0000-4000-8000-000000000000'])], start: false })).json();
  assert.equal(bad.failed, 1);
  assert.match(bad.results[0].message, /پیدا نشد|منقضی/);
});

test('clarify و یادداشت با پیوست: --attach کنار --clarify/--note؛ کنار approve/reject معنا ندارد (400)', async t => {
  const s = await boot(t, { tasks: [task(7, { state: 'needs-clarification', awaitingHuman: { kind: 'clarification', since: 't' }, actions: { clarify: true, approve: true, note: true } })] });
  const a = await s.stage('shot.png', body(100, 0x44));
  const clarify = await s.post('/api/repos/fake/tasks/7/answer', { mode: 'clarify', text: 'پاسخ', attachments: [a.json.id] });
  assert.equal(clarify.status, 200);
  const answer = s.fake.calls().filter(c => c.args[0] === 'answer').at(-1);
  assert.deepEqual(answer.args.slice(0, 3), ['answer', '7', '--clarify']);
  assert.equal(answer.args.filter(x => x === '--attach').length, 1);
  assert.deepEqual(s.attached().map(x => [x.via, x.name, x.exists]), [['--attach', 'shot.png', true]]);
  assert.deepEqual(s.staged(), []);

  const b = await s.stage('b.png', body(100, 0x45));
  const approve = await s.post('/api/repos/fake/tasks/7/answer', { mode: 'approve', attachments: [b.json.id] });
  assert.equal(approve.status, 400);
  assert.equal(s.staged().length, 1, 'رد ِ approve آپلود را مصرف نمی‌کند');

  const note = await s.post('/api/repos/fake/tasks/7/note', { text: 'یادداشت', attachments: [b.json.id] });
  assert.equal(note.status, 200);
  const noteCall = s.fake.calls().filter(c => c.args[0] === 'answer').at(-1);
  assert.deepEqual(noteCall.args.slice(0, 3), ['answer', '7', '--note']);
  assert.equal(noteCall.args.filter(x => x === '--attach').length, 1);
  assert.deepEqual(s.staged(), []);
});

test('توکن ِ remote به آپلود/پیوست راه ندارد (فهرست ِ بسته‌ی endpointها)؛ آپلود از گوشی در این brief نیست', async t => {
  assert.equal(isRemoteAllowed('POST', '/api/uploads'), false);
  assert.equal(isRemoteAllowed('DELETE', '/api/uploads/abc'), false);
  assert.equal(isRemoteAllowed('POST', '/api/repos/main/tasks/7/attach'), false);
  assert.equal(isRemoteAllowed('GET', '/api/repos/main/tasks/7/attachments/A-1/file'), false);
  assert.equal(isRemoteAllowed('GET', '/api/attachments/policy'), false);
  assert.ok(!REMOTE_ENDPOINTS.some(([, p]) => /upload|attach\b|attachments\/:/.test(p)));

  const s = await boot(t);
  new RemoteTokenStore(s.config.dataDir).create('remote-phone');
  const token = fs.readFileSync(path.join(s.config.dataDir, 'tokens', 'remote-phone.token'), 'utf8').trim();
  const headers = { Authorization: `Bearer ${token}` };
  for (const [method, p] of [['POST', '/api/uploads?name=a.png'], ['POST', '/api/repos/fake/tasks/7/attach'], ['GET', '/api/attachments/policy']]) {
    const response = await fetch(`${s.base}${p}`, { method, headers, body: method === 'POST' ? PNG : undefined });
    assert.equal(response.status, 403, `${method} ${p}`);
  }
  assert.deepEqual(s.staged(), []);
});

test('خواندن ِ پیوست (پیش‌نمایش/دانلود): فقط زیر root/<taskId>/؛ تصویر inline و بقیه attachment؛ بیرون از root و فایل ِ گم‌شده رد', async t => {
  const root = tmpDir(t, 'barsa-att-root-');
  const dir = path.join(root, '7');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'shot.png'), PNG);
  fs.writeFileSync(path.join(dir, 'doc.pdf'), '%PDF-1.4 x');
  fs.writeFileSync(path.join(dir, 'note.txt'), 'متن');
  const secret = path.join(root, 'secret.txt');
  fs.writeFileSync(secret, 'SECRET');
  const posix = p => p.split(path.sep).join('/');
  const item = (id, name, kind, file, extra = {}) => ({
    id, name, file: name, kind, ext: path.extname(name), size: 10, sha256: 'a'.repeat(64), addedAt: 't', stage: null, source: 'attach', reason: 'r', humanOnly: false, derivedFrom: null,
    path: posix(file), exists: true, ...extra
  });
  const s = await boot(t, {
    tasks: [task(7, {
      attachments: {
        root: posix(root),
        items: [
          item('A-1', 'shot.png', 'image', path.join(dir, 'shot.png')),
          item('P-1', 'doc.pdf', 'pdf', path.join(dir, 'doc.pdf')),
          item('T-1', 'note.txt', 'text', path.join(dir, 'note.txt')),
          item('E-1', 'evil.png', 'image', secret),                                       // مسیر بیرون از root/<taskId>
          item('E-2', 'trav.png', 'image', path.join(dir, '..', 'secret.txt')),           // traversal
          item('G-1', 'gone.png', 'image', path.join(dir, 'gone.png'), { exists: false }) // از دیسک رفته
        ]
      }
    })]
  });
  const get = (id, query = '', method = 'GET') => authedFetch(`${s.base}/api/repos/fake/tasks/7/attachments/${id}/file${query}`, { method });

  const image = await get('A-1');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.match(image.headers.get('content-disposition'), /^inline; filename\*=UTF-8''shot\.png$/);
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.match(image.headers.get('content-security-policy'), /sandbox/);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG);

  const download = await get('A-1', '?download=1');
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.match(download.headers.get('content-disposition'), /^attachment;/);
  await download.arrayBuffer();

  const pdf = await get('P-1');
  assert.equal(pdf.headers.get('content-type'), 'application/octet-stream', 'فقط تصویر inline است');
  assert.match(pdf.headers.get('content-disposition'), /^attachment;/);
  assert.equal(await pdf.text(), '%PDF-1.4 x');
  assert.equal(await (await get('T-1')).text(), 'متن');

  for (const id of ['E-1', 'E-2']) {
    const out = await get(id);
    assert.equal(out.status, 403, id);
    assert.ok(!(await out.text()).includes('SECRET'));
  }
  assert.equal((await get('G-1')).status, 404);
  assert.equal((await get('NOPE')).status, 404);
  assert.equal((await get('bad id')).status, 400);
  assert.equal((await get('A-1', '', 'HEAD')).status, 200);
  // کانبان چیزی در root ننوشت
  assert.deepEqual(fs.readdirSync(dir).sort(), ['doc.pdf', 'note.txt', 'shot.png']);
});

test('دروازه‌ی وابستگی: approve/reject → answer --approve-dependencies|--reject-dependencies --reason-file؛ reason اجباری؛ بعد از تصمیم run ِ خودکار', async t => {
  const s = await boot(t, { tasks: [task(7, { state: 'architecture', awaitingHuman: { kind: 'dependency-approval', since: 't' }, actions: { approveDependencies: true, rejectDependencies: true } })] });
  assert.equal((await s.post('/api/repos/fake/tasks/7/approve-dependencies', {})).status, 400);
  assert.equal((await s.post('/api/repos/fake/tasks/7/reject-dependencies', { reason: '   ' })).status, 400);
  assert.equal(s.fake.calls().filter(c => c.args[0] === 'answer').length, 0, 'بدون reason به Manager نمی‌رسد');

  const approve = await s.post('/api/repos/fake/tasks/7/approve-dependencies', { reason: 'Needed for charts; license MIT; peers OK' });
  assert.equal(approve.status, 200);
  const call = s.fake.calls().filter(c => c.args[0] === 'answer').at(-1);
  assert.deepEqual([call.args[0], call.args[1], call.args[2], call.args[3]], ['answer', '7', '--approve-dependencies', '--reason-file']);
  assert.equal(call.args.length, 5, 'متن ِ reason در argv نیست');
  assert.equal(s.fake.files().at(-1).text, 'Needed for charts; license MIT; peers OK');
  assert.equal((await approve.json()).autoResumed, true);
  await waitUntil(() => s.fake.calls().some(c => c.args[0] === 'run' && c.args[1] === '7'), { label: 'run ِ خودکار بعد از تأیید' });

  const reject = await s.post('/api/repos/fake/tasks/7/reject-dependencies', { reason: 'Use the existing chart library' });
  assert.equal(reject.status, 200);
  const rejectCall = s.fake.calls().filter(c => c.args[0] === 'answer').at(-1);
  assert.deepEqual(rejectCall.args.slice(0, 3), ['answer', '7', '--reject-dependencies']);
  assert.equal(s.fake.files().at(-1).text, 'Use the existing chart library');

  // رد ِ Manager (مثلاً گیت باز نیست) عیناً
  s.fake.setFail({ answer: { code: 1, stderr: 'گیت dependency-approval باز نیست.' } });
  const refused = await s.post('/api/repos/fake/tasks/7/approve-dependencies', { reason: 'x' });
  assert.ok(refused.status >= 400);
  assert.match((await refused.json()).error, /گیت dependency-approval باز نیست/);
  await waitUntil(async () => (await (await authedFetch(`${s.base}/api/repos/fake/running`)).json()).every(r => !r.running && !r.queued), { label: 'پایان ِ run ها' });
});
