import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { AuditLog, statusForExit } from '../src/audit.js';
import { buildZip, listFiles } from '../src/zip.js';
import { resolveTaskDir } from '../src/routes-ops.js';
import { resolveDataDir } from '../src/config.js';

const get = (base, p) => authedFetch(`${base}${p}`);
const post = (base, p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

/** خواننده‌ی مستقل ZIP (از central directory) تا درستی نویسنده را بسنجیم، نه خودش را. */
function readZip(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, 'EOCD');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50);
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const crc = buffer.readUInt32LE(offset + 16);
    const csize = buffer.readUInt32LE(offset + 20);
    const usize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');
    assert.ok(flags & 0x0800, 'نام UTF-8');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    assert.equal(data.length, usize);
    assert.equal(zlib.crc32(data), crc, `CRC ${name}`);
    out[name] = data.toString('utf8');
    offset += 46 + nameLen + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return out;
}

function tmpDir(t, prefix = 'barsa-ev-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('zip: نام فارسی، پوشه‌ی تودرتو، فایل بزرگ فشرده و خالی؛ CRC و محتوا با خواننده‌ی مستقل می‌خوانند', t => {
  const root = tmpDir(t);
  fs.mkdirSync(path.join(root, 'attempts', '001'), { recursive: true });
  fs.writeFileSync(path.join(root, 'request.md'), 'درخواست فارسی\n');
  fs.writeFileSync(path.join(root, 'attempts', '001', 'result.yaml'), 'a: 1\n');
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(100_000));
  fs.writeFileSync(path.join(root, 'empty.txt'), '');
  const { buffer, fileCount } = buildZip(root);
  assert.equal(fileCount, 4);
  const files = readZip(buffer);
  assert.deepEqual(Object.keys(files).sort(), ['attempts/001/result.yaml', 'big.txt', 'empty.txt', 'request.md']);
  assert.equal(files['request.md'], 'درخواست فارسی\n');
  assert.equal(files['big.txt'].length, 100_000);
  assert.ok(buffer.length < 10_000, 'deflate شده');
});

test('zip: symlink دنبال نمی‌شود و سقف تعداد/حجم اعمال می‌شود', t => {
  const root = tmpDir(t);
  const outside = tmpDir(t, 'barsa-outside-');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  try { fs.symlinkSync(outside, path.join(root, 'link'), 'junction'); } catch { /* مجوز symlink نیست */ }
  assert.deepEqual(listFiles(root).map(f => f.name), ['a.txt']);
  assert.throws(() => listFiles(root, { maxFiles: 0, maxTotalBytes: 100 }), /بیش از حد بزرگ/);
  assert.throws(() => listFiles(root, { maxFiles: 10, maxTotalBytes: 0 }), /بیش از حد بزرگ/);
});

test('resolveTaskDir: traversal، شناسه‌ی مخرب و مسیر اعلام‌شده‌ی بیرون از .agent-work/tasks رد می‌شود', t => {
  const repoRoot = tmpDir(t);
  const repo = { id: 'r', path: repoRoot };
  fs.mkdirSync(path.join(repoRoot, '.agent-work', 'tasks', '10'), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, 'elsewhere'), { recursive: true });

  const ok = resolveTaskDir(repo, { id: '10' });
  assert.equal(ok.source, 'convention');
  assert.equal(path.basename(ok.dir), '10');
  assert.equal(resolveTaskDir(repo, { id: '10', dir: '.agent-work/tasks/10' }).source, 'status');

  for (const task of [
    { id: '10', dir: '../../etc' },
    { id: '10', dir: 'elsewhere' },
    { id: '10', dir: '.agent-work/tasks' },
    { id: '10', taskDir: path.join(repoRoot, '..') },
    { id: '../10' },
    { id: '10/../../x' },
    { id: '' },
    {}
  ]) {
    assert.throws(() => resolveTaskDir(repo, task), e => [400, 404].includes(e.status), JSON.stringify(task));
  }
  assert.throws(() => resolveTaskDir(repo, { id: '99' }), e => e.status === 404);
});

test('دانلود zip پوشه‌ی task: فقط خواندنی، با ممیزی؛ task ناشناس 404؛ مسیر اعلام‌شده‌ی مخرب 400', async t => {
  const fake = makeFakeManagerRepo(t, {
    status: { schemaVersion: 1, repo: {}, tasks: [{ id: '10', state: 'review' }, { id: '11', state: 'review', dir: '../../outside' }] }
  });
  const dir = path.join(fake.root, '.agent-work', 'tasks', '10');
  fs.mkdirSync(path.join(dir, 'attempts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.yaml'), 'id: 10\n');
  fs.writeFileSync(path.join(dir, 'attempts', 'log.txt'), 'متن لاگ');
  const { base, config } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {} });

  const response = await get(base, '/api/repos/fake/tasks/10/zip');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');
  assert.match(response.headers.get('content-disposition'), /task-10\.zip/);
  const files = readZip(Buffer.from(await response.arrayBuffer()));
  assert.deepEqual(Object.keys(files).sort(), ['attempts/log.txt', 'manifest.yaml']);
  assert.equal(files['attempts/log.txt'], 'متن لاگ');

  assert.equal((await get(base, '/api/repos/fake/tasks/404/zip')).status, 404);
  assert.equal((await get(base, '/api/repos/fake/tasks/11/zip')).status, 400);
  const downloads = new AuditLog({ dir: config.dataDir }).readAll().filter(r => r.action === 'zip.download');
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].files, 2);
  assert.equal(downloads[0].user, 'operator');
  assert.deepEqual(fake.mutations(), [], 'zip هیچ فرمان Manager ای را اجرا نمی‌کند');
});

test('لاگ هر run: در فهرست اجراهای task می‌ماند، زمان‌دار و قابل دانلود است، و بعد از restart سرور هم هست', async t => {
  const fake = makeFakeManagerRepo(t);
  const config = { repos: [fake.repo], server: {}, issueSource: {} };
  const first = await startAuthedServer(t, config);
  await post(first.base, '/api/repos/fake/tasks/42/run');
  for (let i = 0; i < 100; i += 1) {
    const run = (await (await get(first.base, '/api/repos/fake/running')).json())[0];
    if (run && !run.running && !run.queued) break;
    await new Promise(r => setTimeout(r, 50));
  }
  first.server.close();

  // «restart»: سرور تازه روی همان dataDir
  const restarted = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, dataDir: first.config.dataDir });
  const runs = await (await get(restarted.base, '/api/repos/fake/tasks/42/runs')).json();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].exitCode, 0);
  assert.equal(runs[0].user, 'operator');
  assert.equal(runs[0].hasLog, true);
  assert.ok(runs[0].startedAt && runs[0].endedAt && runs[0].durationMs >= 0);
  assert.deepEqual(await (await get(restarted.base, '/api/repos/fake/tasks/43/runs')).json(), []);

  const log = await get(restarted.base, `/api/logs/${runs[0].runId}`);
  assert.equal(log.status, 200);
  assert.match(log.headers.get('content-disposition'), /attachment/);
  const text = await log.text();
  assert.match(text, /\d{4}-\d\d-\d\dT[\d:.]+Z \[stdout\] run-ok/);

  assert.equal((await get(restarted.base, '/api/logs/..%2F..%2Fpasswd')).status, 400);
  assert.equal((await get(restarted.base, '/api/logs/20260101000000-deadbeef')).status, 404);
  const audit = new AuditLog({ dir: first.config.dataDir });
  assert.equal(audit.readAll().filter(r => r.action === 'log.download').length, 1);
});

test('دفتر ممیزی: append-only، start/end/rejected، mask توکن در argv، تحمل خط ناقص', t => {
  const dir = tmpDir(t);
  const audit = new AuditLog({ dir });
  const handle = audit.begin({ user: 'ali', action: 'console', repoId: 'r', taskId: '1', argv: ['node', 'm.js', '--reason', 'token=abcdef123456789'], cwd: '/x' });
  handle.finish({ exitCode: 0 });
  handle.finish({ exitCode: 9 }); // دوباره finish نوشته نمی‌شود
  audit.reject({ user: 'ali', action: 'console', line: 'bad ; line' }, 'نویسه‌ی ممنوع');
  audit.note({ user: 'ali', action: 'zip.download' });
  fs.appendFileSync(audit.file, '{"id":"half"'); // کرش وسط نوشتن
  const records = audit.readAll();
  assert.deepEqual(records.map(r => r.phase), ['start', 'end', 'rejected', 'event']);
  assert.ok(!JSON.stringify(records).includes('abcdef123456789'));
  assert.equal(records[1].exitCode, 0);
  assert.equal(records[1].status, 'ok');
  assert.equal(records[0].id, records[1].id);
  assert.match(records[0].outputFile, /outputs[\\/].+\.log$/);
  assert.equal(audit.summaries({ user: 'ali' }).length, 3);
  // خروجی کامل در فایل جدا
  fs.writeFileSync(handle.outputFile, 'full');
  assert.equal(fs.readFileSync(audit.outputFile(handle.id), 'utf8'), 'full');
  assert.throws(() => audit.outputFile('../../x'), /نامعتبر/);
  assert.equal(typeof audit.delete, 'undefined');
  assert.equal(typeof audit.update, 'undefined');
});

test('کد خروج 10 (منتظر انسان) و 40 (منتظر scope) خطا نیستند؛ فقط 0 ok است', () => {
  assert.equal(statusForExit(0), 'ok');
  assert.equal(statusForExit(10), 'waiting');
  assert.equal(statusForExit(40), 'waiting');
  for (const code of [1, 3, 20, 30, 42, null]) assert.equal(statusForExit(code), 'failed', String(code));
});

test('dataDir نباید داخل مخزن باشد (دفتر ممیزی با git clean پاک نشود)', t => {
  const repoRoot = tmpDir(t);
  assert.throws(() => resolveDataDir({ dataDir: path.join(repoRoot, 'data'), repos: [{ id: 'r', path: repoRoot }] }), /داخل مخزن/);
  assert.throws(() => resolveDataDir({ dataDir: repoRoot, repos: [{ id: 'r', path: repoRoot }] }), /داخل مخزن/);
  const outside = tmpDir(t);
  assert.equal(resolveDataDir({ dataDir: outside, repos: [{ id: 'r', path: repoRoot }] }), path.resolve(outside));
});
