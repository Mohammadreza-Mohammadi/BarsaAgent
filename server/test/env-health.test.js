import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { runHealthChecks, probeUrl } from '../src/env-health.js';
import { ManagerHelp } from '../src/manager-help.js';

const GB = 1024 ** 3;
const node = process.execPath;
const okClaude = { command: node, versionArgs: ['-e', "console.log('2.1.0 (Claude Code)')"], authArgs: ['-e', "console.log('Logged in as test@example.com')"] };

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-health-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const byId = (report, id) => report.checks.find(c => c.id === id);

async function run(t, { repoExtra = {}, health = {}, deps = {}, users = { count: () => 1 }, updater } = {}) {
  const fake = makeFakeManagerRepo(t);
  const repo = { ...fake.repo, ...repoExtra };
  const config = { repos: [repo], run: { proxy: 'http://127.0.0.1:10808' }, health: { claude: okClaude, ...health } };
  const report = await runHealthChecks({
    config, repos: [repo], dataDir: tmpDir(t), managerInfo: { fake: { managerVersion: '1.2.3' } }, help: new ManagerHelp(), users, updater,
    deps: { probeUrl: async () => 200, statfs: async () => ({ bavail: 100 * GB, bsize: 1 }), powershell: 'pwsh', ...deps }
  });
  return { report, repo };
}

test('محیط سالم: همه‌ی بررسی‌ها ok (به‌جز مواردی که config تعریف نکرده → warn)', async t => {
  const { report } = await run(t);
  assert.equal(report.ok, true);
  for (const id of ['node', 'git', 'claude', 'claude-auth', 'proxy', 'powershell', 'repo-fake', 'help-fake', 'disk-fake', 'disk-data', 'users']) {
    assert.equal(byId(report, id)?.status, 'ok', `${id}: ${JSON.stringify(byId(report, id))}`);
  }
  assert.match(byId(report, 'repo-fake').detail, /Manager 1\.2\.3/);
  assert.match(byId(report, 'claude').detail, /2\.1\.0/);
  assert.equal(byId(report, 'shadowPath-fake').status, 'warn');
  assert.equal(byId(report, 'webiiiPath-fake').status, 'warn');
});

test('هر چیزی که کم است همان‌جا گفته می‌شود: claude، احراز هویت، پروکسی، مسیرها، pwsh، دیسک، حساب', async t => {
  const missing = path.join(os.tmpdir(), 'barsa-does-not-exist-xyz');
  const { report } = await run(t, {
    repoExtra: { tooling: { shadowPath: missing, webiiiPath: missing } },
    health: { claude: { command: 'definitely-not-a-real-command-xyz', versionArgs: ['--version'], authArgs: ['auth', 'status'] } },
    deps: {
      probeUrl: async () => { throw new Error('ECONNREFUSED'); },
      statfs: async () => ({ bavail: 500, bsize: 1024 * 1024 }), // ~۵۰۰ مگابایت
      powershell: null
    },
    users: { count: () => 0 }
  });
  assert.equal(report.ok, false);
  assert.equal(byId(report, 'claude').status, 'fail');
  assert.match(byId(report, 'claude').hint, /claude\.exe|health\.claude\.command/);
  assert.equal(byId(report, 'claude-auth').status, 'fail');
  assert.equal(byId(report, 'proxy').status, 'fail');
  assert.match(byId(report, 'proxy').detail, /ECONNREFUSED/);
  assert.match(byId(report, 'proxy').hint, /run\.proxy/);
  assert.equal(byId(report, 'shadowPath-fake').status, 'fail');
  assert.equal(byId(report, 'webiiiPath-fake').status, 'fail');
  assert.equal(byId(report, 'powershell').status, 'warn');
  assert.match(byId(report, 'powershell').hint, /آزمون جداسازی/);
  assert.equal(byId(report, 'disk-fake').status, 'fail');
  assert.equal(byId(report, 'users').status, 'fail');
});

test('احراز هویت claude: خروجی «وارد نشده» یا exit غیرصفر = fail با راهنمای login', async t => {
  const notLogged = { ...okClaude, authArgs: ['-e', "console.log('Not logged in')"] };
  let { report } = await run(t, { health: { claude: notLogged } });
  assert.equal(byId(report, 'claude-auth').status, 'fail');
  assert.match(byId(report, 'claude-auth').hint, /claude auth login/);
  const exits = { ...okClaude, authArgs: ['-e', 'process.exit(1)'] };
  ({ report } = await run(t, { health: { claude: exits } }));
  assert.equal(byId(report, 'claude-auth').status, 'fail');
});

test('دیسک: بین ۱ و ۵ گیگابایت warn؛ مخزن/managerScript ناموجود fail', async t => {
  let { report } = await run(t, { deps: { statfs: async () => ({ bavail: 3, bsize: GB }) } });
  assert.equal(byId(report, 'disk-fake').status, 'warn');
  assert.equal(report.ok, true, 'warn شکست حساب نمی‌شود');
  ({ report } = await run(t, { repoExtra: { path: path.join(os.tmpdir(), 'no-such-repo-xyz') } }));
  assert.equal(byId(report, 'repo-fake').status, 'fail');
  const fake = makeFakeManagerRepo(t);
  ({ report } = await run(t, { repoExtra: { path: fake.root, managerScript: 'nope.js' } }));
  assert.match(byId(report, 'repo-fake').hint, /managerScript/);
});

test('زیرفرمان‌های دکمه‌ها در --help نباشند → warn با نام زیرفرمان', async t => {
  const fake = makeFakeManagerRepo(t);
  fs.writeFileSync(path.join(fake.root, 'help.txt'), 'استفاده\n\nزیرفرمان‌ها:\n  status\n  run <id>\n');
  const report = await runHealthChecks({
    config: { repos: [fake.repo], health: { claude: okClaude } }, repos: [fake.repo], dataDir: tmpDir(t), help: new ManagerHelp(), users: { count: () => 1 },
    deps: { probeUrl: async () => 200, statfs: async () => ({ bavail: 100 * GB, bsize: 1 }), powershell: 'pwsh' }
  });
  assert.equal(byId(report, 'help-fake').status, 'warn');
  assert.match(byId(report, 'help-fake').detail, /answer/);
});

test('probeUrl: مستقیم و از طریق پروکسی HTTP (CONNECT) پاسخ HTTP را برمی‌گرداند؛ پروکسی بسته → خطا', async t => {
  const target = http.createServer((req, res) => { res.writeHead(204); res.end(); });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  t.after(() => target.close());
  const targetUrl = `http://127.0.0.1:${target.address().port}/`;
  assert.equal(await probeUrl(targetUrl, null), 204);

  const seen = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, clientSocket, head) => {
    seen.push(req.url);
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  t.after(() => proxy.close());
  assert.equal(await probeUrl(targetUrl, `http://127.0.0.1:${proxy.address().port}`), 204);
  assert.deepEqual(seen, [`127.0.0.1:${target.address().port}`], 'درخواست واقعاً از CONNECT پروکسی گذشت');

  const closed = net.createServer();
  closed.listen(0, '127.0.0.1');
  await once(closed, 'listening');
  const closedPort = closed.address().port;
  closed.close();
  await once(closed, 'close');
  await assert.rejects(() => probeUrl(targetUrl, `http://127.0.0.1:${closedPort}`, 2000));
});

test('نسخه‌ی Manager: commit فعلی و تعداد commit عقب‌تر از origin/main در گزارش سلامت می‌آید', async t => {
  const make = info => ({ info: async () => info });
  const head = 'a'.repeat(40);
  let { report } = await run(t, { updater: make({ head, branch: 'main', behind: 3, ahead: 0 }) });
  assert.equal(byId(report, 'manager-version-fake').status, 'warn');
  assert.match(byId(report, 'manager-version-fake').detail, /aaaaaaaaaa.*3 commit عقب‌تر/);
  ({ report } = await run(t, { updater: make({ head, branch: 'main', behind: 0, ahead: 0 }) }));
  assert.equal(byId(report, 'manager-version-fake').status, 'ok');
  ({ report } = await run(t, { updater: make({ head, branch: 'main', behind: null, ahead: null, remoteError: 'origin/main پیدا نشد' }) }));
  assert.equal(byId(report, 'manager-version-fake').status, 'warn');
  ({ report } = await run(t, { updater: { info: async () => { throw new Error('not a git repo'); } } }));
  assert.match(byId(report, 'manager-version-fake').detail, /not a git repo/);
});

test('API /api/env-health پشت ورود است و گزارش ساختاریافته می‌دهد', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, run: { proxy: '' }, health: { claude: okClaude, proxyTestUrl: 'http://127.0.0.1:9/' } });
  assert.equal((await fetch(`${base}/api/env-health`)).status, 401);
  const report = await (await authedFetch(`${base}/api/env-health`)).json();
  assert.ok(Array.isArray(report.checks) && report.checks.length > 8);
  assert.ok(report.checks.every(c => ['ok', 'warn', 'fail'].includes(c.status) && c.id && c.label));
  assert.equal(byId(report, 'proxy').status, 'fail'); // پورت 9 بسته است
  assert.match(byId(report, 'proxy').label, /بدون پروکسی/);
});
