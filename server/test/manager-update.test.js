import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo, initGitRepo, configureGit, g } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';

const post = (base, p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const get = (base, p) => authedFetch(`${base}${p}`);

// مخزن موقت با remote موقت: «سرور» = clone ِ origin؛ «توسعه» = clone ِ دوم که روی origin push می‌کند.
async function setup(t, { run } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-upd-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const origin = path.join(tmp, 'origin.git');
  fs.mkdirSync(origin);
  g(origin, 'init', '--bare', '-b', 'main');

  const fake = makeFakeManagerRepo(t, { run });
  initGitRepo(fake.root, { files: { 'README.md': 'v1\n', 'package-lock.json': '{"v":1}\n' } });
  g(fake.root, 'remote', 'add', 'origin', origin);
  g(fake.root, 'push', '-u', 'origin', 'main');

  const dev = path.join(tmp, 'dev');
  g(tmp, 'clone', '-c', 'core.autocrlf=false', origin, dev);
  configureGit(dev);
  const push = (file, content) => {
    fs.writeFileSync(path.join(dev, file), content);
    g(dev, 'add', '-A');
    g(dev, 'commit', '-m', `edit ${file}`);
    g(dev, 'push', 'origin', 'main');
    return g(dev, 'rev-parse', 'HEAD');
  };

  const npmCli = path.join(tmp, 'fake-npm-cli.js');
  const npmLog = path.join(tmp, 'npm-calls.log');
  fs.writeFileSync(npmCli, `require('node:fs').appendFileSync(${JSON.stringify(npmLog)}, process.argv.slice(2).join(' ') + '\\n' + process.cwd() + '\\n');`);

  const { base, config } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {} }, { npmCli });
  const audit = () => new AuditLog({ dir: config.dataDir });
  const exec = async (path_, expect = 202) => {
    const response = await post(base, path_);
    assert.equal(response.status, expect, await response.clone().text());
    if (expect !== 202) return response.json();
    const { execId } = await response.json();
    const text = await (await get(base, `/api/execs/${execId}/stream`)).text();
    return { text, code: JSON.parse(/event: end\ndata: (\{.*\})/.exec(text)[1]).code, execId };
  };
  return { fake, base, push, exec, audit, npmLog, head: () => g(fake.root, 'rev-parse', 'HEAD'), root: fake.root, dev };
}

test('به‌روزرسانی موفق: fetch + merge --ff-only؛ package-lock عوض شده → npm ci؛ --help دوباره خوانده می‌شود', async t => {
  const s = await setup(t);
  const target = s.push('package-lock.json', '{"v":2}\n');
  const helpCallsBefore = s.fake.calls().filter(c => c.args[0] === '--help').length;

  const result = await s.exec('/api/repos/fake/manager/update');
  assert.equal(result.code, 0, result.text);
  assert.equal(s.head(), target);
  assert.ok(fs.existsSync(s.npmLog), 'npm ci باید اجرا شده باشد');
  const [args, cwd] = fs.readFileSync(s.npmLog, 'utf8').trim().split('\n');
  assert.equal(args, 'ci');
  assert.equal(path.resolve(cwd).toLowerCase(), path.resolve(s.root).toLowerCase());
  assert.ok(s.fake.calls().filter(c => c.args[0] === '--help').length > helpCallsBefore, 'فهرست زیرفرمان‌ها تازه شد');
  assert.match(result.text, /زیرفرمان‌های مجاز:.*answer/);

  const records = s.audit().summaries();
  const update = records.find(r => r.action === 'manager.update');
  assert.equal(update.exitCode, 0);
  assert.equal(update.user, 'operator');
  const steps = records.filter(r => r.action === 'manager.update.step').map(r => r.argv.slice(1).join(' '));
  assert.ok(steps.some(a => a === 'fetch origin'));
  assert.ok(steps.some(a => a === 'merge --ff-only origin/main'));
});

test('به‌روزرسانی بدون تغییر package-lock.json → npm ci اجرا نمی‌شود', async t => {
  const s = await setup(t);
  const target = s.push('README.md', 'v2\n');
  const result = await s.exec('/api/repos/fake/manager/update');
  assert.equal(result.code, 0, result.text);
  assert.equal(s.head(), target);
  assert.ok(!fs.existsSync(s.npmLog), `${result.text}\n---\n${fs.existsSync(s.npmLog) ? fs.readFileSync(s.npmLog, 'utf8') : ''}`);
  assert.match(result.text, /رد شد: npm ci/);
});

test('رد: درخت کثیف، شاخه‌ی غیر main؛ مخزن دست‌نخورده می‌ماند', async t => {
  const s = await setup(t);
  s.push('README.md', 'v2\n');
  const before = s.head();

  fs.writeFileSync(path.join(s.root, 'dirty.txt'), 'x');
  let body = await s.exec('/api/repos/fake/manager/update', 409);
  assert.match(body.error, /تمیز نیست/);
  fs.rmSync(path.join(s.root, 'dirty.txt'));

  g(s.root, 'checkout', '-b', 'side');
  body = await s.exec('/api/repos/fake/manager/update', 409);
  assert.match(body.error, /فقط روی main/);
  g(s.root, 'checkout', 'main');

  assert.equal(s.head(), before);
  assert.equal(s.audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'manager.update').length, 2);
});

test('رد: اجرای در جریان (registry) یا قفل زنده در status --json؛ قفل کهنه مانع نیست', async t => {
  const s = await setup(t, { run: 'setInterval(() => {}, 1000);' });
  const target = s.push('README.md', 'v2\n');
  const before = s.head();

  await post(s.base, '/api/repos/fake/tasks/3/run');
  for (let i = 0; i < 100 && !s.fake.calls().some(c => c.args[0] === 'run'); i += 1) await new Promise(r => setTimeout(r, 50));
  let body = await s.exec('/api/repos/fake/manager/update', 409);
  assert.match(body.error, /اجرا در جریان\/صف است: #3/);
  await post(s.base, '/api/repos/fake/tasks/3/stop');

  s.fake.setStatus({ schemaVersion: 1, repo: {}, tasks: [{ id: '4', health: { transitionLock: { pid: 99, alive: true } } }] });
  body = await s.exec('/api/repos/fake/manager/update', 409);
  assert.match(body.error, /قفل transition/);
  s.fake.setStatus({ schemaVersion: 1, repo: {}, tasks: [{ id: '4', health: { transitionLock: { pid: 99, alive: null } } }] });
  assert.match((await s.exec('/api/repos/fake/manager/update', 409)).error, /قفل transition/, 'نامشخص = محافظه‌کارانه مانع');
  s.fake.setStatus({ schemaVersion: 1, repo: {}, repository: { health: { managerLock: { pid: 5, alive: true, task: '4' } } }, tasks: [] });
  assert.match((await s.exec('/api/repos/fake/manager/update', 409)).error, /قفل سراسری/);
  assert.equal(s.head(), before);

  s.fake.setStatus({ schemaVersion: 1, repo: {}, tasks: [{ id: '4', health: { transitionLock: { pid: 99, alive: false } } }] });
  const ok = await s.exec('/api/repos/fake/manager/update');
  assert.equal(ok.code, 0, ok.text);
  assert.equal(s.head(), target);
});

test('تاریخچه‌ی غیر fast-forward رد می‌شود: git کاری نمی‌کند، commit محلی و درخت دست‌نخورده می‌ماند', async t => {
  const s = await setup(t);
  fs.writeFileSync(path.join(s.root, 'local.txt'), 'local\n');
  g(s.root, 'add', 'local.txt');
  g(s.root, 'commit', '-m', 'local-only');
  const localHead = s.head();
  s.push('README.md', 'remote change\n');

  const result = await s.exec('/api/repos/fake/manager/update');
  assert.notEqual(result.code, 0);
  assert.match(result.text, /fast-forward|ff-only|diverg/i);
  assert.equal(s.head(), localHead);
  assert.equal(g(s.root, 'status', '--short'), '');
  assert.ok(!fs.existsSync(s.npmLog));
  assert.equal(s.audit().summaries({ action: 'manager.update' })[0].status, 'failed');
});

test('info: commit فعلی و تعداد commit عقب‌تر از origin/main (بعد از check)', async t => {
  const s = await setup(t);
  s.push('README.md', 'v2\n');
  s.push('README.md', 'v3\n');
  let info = await (await get(s.base, '/api/repos/fake/manager/info')).json();
  assert.equal(info.head, s.head());
  assert.equal(info.behind, 0, 'تا fetch نشده، origin/main قدیمی است');
  assert.equal(info.branch, 'main');
  assert.equal(info.clean, true);
  const check = await s.exec('/api/repos/fake/manager/check');
  assert.equal(check.code, 0, check.text);
  info = await (await get(s.base, '/api/repos/fake/manager/info')).json();
  assert.equal(info.behind, 2);
  assert.equal(info.ahead, 0);
});
