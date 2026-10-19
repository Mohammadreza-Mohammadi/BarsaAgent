import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { authedFetch, startAuthedServer } from './helpers.js';
import { makeFakeManagerRepo, initGitRepo, g } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';
import { detectPowerShell, parseWorktrees, BRANCH_PATTERN } from '../src/git-ops.js';

const post = (base, p, body) => authedFetch(`${base}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const get = (base, p) => authedFetch(`${base}${p}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PROVE_SCRIPT = `param([string]$Fix, [string]$Main, [string]$WebIII, [string]$Shadow)
Write-Host "[INFO] fix=$Fix main=$Main"
if ($env:FAKE_PROVE_FAIL -eq '1') { Write-Host "[RESULT] NOT PROVEN - do not merge."; exit 1 }
Write-Host "[RESULT] PROVEN. Evidence: $Fix"
exit 0
`;

async function setup(t, { gitOptions, config = {} } = {}) {
  const fake = makeFakeManagerRepo(t);
  initGitRepo(fake.root, { files: { 'README.md': '# t\n', 'scripts/prove-isolation.ps1': PROVE_SCRIPT, ...(gitOptions?.files || {}) } });
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-tools-wt-'));
  t.after(() => fs.rmSync(worktreesDir, { recursive: true, force: true }));
  fake.repo.tooling = { worktreesDir };
  const { base, config: cfg } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, ...config });
  const audit = () => new AuditLog({ dir: cfg.dataDir });
  const waitExec = async execId => {
    const text = await (await get(base, `/api/execs/${execId}/stream`)).text();
    const end = /event: end\ndata: (\{.*\})/.exec(text);
    return { text, code: end ? JSON.parse(end[1]).code : null };
  };
  const run = async (name, body, expectStatus = 202) => {
    const response = await post(base, `/api/repos/fake/git/${name}`, body);
    assert.equal(response.status, expectStatus, `${name} ${JSON.stringify(body)} → ${response.status}`);
    const json = await response.json();
    return expectStatus === 202 ? { ...json, ...(await waitExec(json.execId)) } : json;
  };
  const writeProof = (branch, commit, proven = true) => {
    const file = path.join(cfg.dataDir, 'isolation-proofs.json');
    const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    all[`fake|${branch}`] = { branch, commit, proven, at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify(all));
  };
  return { fake, base, cfg, audit, run, writeProof, worktreesDir, repoPath: fake.root };
}

function commitInWorktree(dir, name = 'feature.txt') {
  fs.writeFileSync(path.join(dir, name), 'x\n');
  g(dir, 'add', name);
  g(dir, 'commit', '-m', 'work');
  return g(dir, 'rev-parse', 'HEAD');
}

test('الگوی شاخه و parseWorktrees', () => {
  for (const ok of ['fix/a', 'feat/a-b-1', 'chore/x']) assert.match(ok, BRANCH_PATTERN);
  for (const bad of ['main', 'feature/x', 'fix/A', 'fix/a b', 'fix/../x', 'fix/x;y', 'fix/', 'fix/a/b', '-D', 'fix/x\n']) assert.doesNotMatch(bad, BRANCH_PATTERN, bad);
  const items = parseWorktrees('worktree C:/a\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/b\nHEAD def\ndetached\n');
  assert.deepEqual(items.map(i => [i.path, i.branch, i.detached]), [['C:/a', 'main', false], ['C:/b', null, true]]);
});

test('ورودی نامعتبر شاخه/مسیر رد می‌شود، هیچ تغییری در مخزن نمی‌افتد، رد در ممیزی است', async t => {
  const s = await setup(t);
  const before = g(s.repoPath, 'worktree', 'list') + g(s.repoPath, 'branch', '--list');
  for (const branch of ['main', 'feature/x', 'fix/Bad', 'fix/a b', 'fix/../x', 'fix/x;calc', '-D']) {
    await s.run('worktree-add', { branch }, 422);
    await s.run('merge', { branch }, 422);
    await s.run('branch-delete', { branch }, 422);
  }
  for (const dir of ['../escape', '..', 'a/b', 'C:\\x', 'A B', '']) {
    await s.run('worktree-add', { branch: 'fix/ok', dir: dir || undefined, ...(dir === '' ? { dir: '..' } : {}) }, 422);
  }
  await s.run('worktree-remove', { dir: '../x' }, 422);
  await s.run('worktree-remove', { dir: 'never-registered' }, 422);
  await s.run('prove', { dir: 'never-registered' }, 422);
  assert.equal(g(s.repoPath, 'worktree', 'list') + g(s.repoPath, 'branch', '--list'), before);
  const rejected = s.audit().readAll().filter(r => r.phase === 'rejected' && r.action.startsWith('git.'));
  assert.ok(rejected.length >= 21);
  assert.ok(rejected.every(r => r.user === 'operator' && r.reason));
});

test('worktree-add: git worktree add <dir> -b <branch> main زیر worktreesDir', async t => {
  const s = await setup(t);
  const result = await s.run('worktree-add', { branch: 'fix/one' });
  assert.equal(result.code, 0, result.text);
  const dir = path.join(s.worktreesDir, 'fix-one');
  assert.ok(fs.existsSync(path.join(dir, 'README.md')));
  assert.equal(g(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/one');
  const record = s.audit().summaries({ action: 'git.worktree-add' })[0];
  assert.deepEqual(record.argv, ['git', 'worktree', 'add', dir, '-b', 'fix/one', 'main']);
  // مسیر تکراری رد می‌شود
  await s.run('worktree-add', { branch: 'fix/two', dir: 'fix-one' }, 422);
  const inventory = await (await get(s.base, '/api/repos/fake/git/inventory')).json();
  assert.ok(inventory.worktrees.some(w => w.branch === 'fix/one' && w.managed));
});

test('status: سه فرمان خواندنی را برمی‌گرداند', async t => {
  const s = await setup(t);
  const status = await (await get(s.base, '/api/repos/fake/git/status')).json();
  assert.equal(status.clean, true);
  assert.match(status.log, /init/);
  assert.match(status.worktrees, /main/);
});

test('merge: بدون PROVEN، با اثبات کهنه، با NOT PROVEN، با درخت کثیف، یا خارج از main رد می‌شود', async t => {
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'fix/m1' });
  const dir = path.join(s.worktreesDir, 'fix-m1');
  const tip = commitInWorktree(dir);
  const mainBefore = g(s.repoPath, 'rev-parse', 'main');

  let result = await s.run('merge', { branch: 'fix/m1' }, 422);
  assert.match(result.error, /PROVEN/);

  s.writeProof('fix/m1', 'f'.repeat(40));
  result = await s.run('merge', { branch: 'fix/m1' }, 422);
  assert.match(result.error, /دوباره اجرا کن/, 'اثبات برای commit دیگری است');

  s.writeProof('fix/m1', tip, false);
  result = await s.run('merge', { branch: 'fix/m1' }, 422);
  assert.match(result.error, /PROVEN/);

  s.writeProof('fix/m1', tip, true);
  fs.writeFileSync(path.join(s.repoPath, 'dirty.txt'), 'x');
  result = await s.run('merge', { branch: 'fix/m1' }, 422);
  assert.match(result.error, /خالی نیست/);
  fs.rmSync(path.join(s.repoPath, 'dirty.txt'));

  g(s.repoPath, 'checkout', '-b', 'other');
  result = await s.run('merge', { branch: 'fix/m1' }, 422);
  assert.match(result.error, /روی main/);
  g(s.repoPath, 'checkout', 'main');

  assert.equal(g(s.repoPath, 'rev-parse', 'main'), mainBefore, 'هیچ merge ای انجام نشده');
  assert.equal(s.audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'git.merge').length, 5);
});

test('merge: با PROVEN همان commit و status تمیز → git merge --no-ff --no-edit، hookها اجرا می‌شوند (بدون --no-verify)', async t => {
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'feat/m2' });
  const dir = path.join(s.worktreesDir, 'feat-m2');
  const tip = commitInWorktree(dir);
  s.writeProof('feat/m2', tip);
  const marker = path.join(s.repoPath, '..', `hook-marker-${process.pid}-${Date.now()}`);
  t.after(() => fs.rmSync(marker, { force: true }));
  const hook = path.join(s.repoPath, '.git', 'hooks', 'pre-merge-commit');
  fs.writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\nexit 0\n`, { mode: 0o755 });

  const result = await s.run('merge', { branch: 'feat/m2' });
  assert.equal(result.code, 0, result.text);
  assert.equal(g(s.repoPath, 'log', '-1', '--format=%P').split(' ').length, 2, 'commit ادغام دو والد دارد (--no-ff)');
  assert.match(g(s.repoPath, 'log', '-1', '--format=%s'), /Merge branch 'feat\/m2'/);
  assert.ok(fs.existsSync(marker), 'hook ِ pre-merge-commit باید اجرا شده باشد');
  const record = s.audit().summaries({ action: 'git.merge' })[0];
  assert.deepEqual(record.argv, ['git', 'merge', '--no-ff', '--no-edit', 'feat/m2']);
  assert.equal(record.exitCode, 0);
});

test('merge: وقتی اجرای task در جریان است رد می‌شود', async t => {
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'fix/busy' });
  const dir = path.join(s.worktreesDir, 'fix-busy');
  s.writeProof('fix/busy', commitInWorktree(dir));
  // manager ساختگی در فرایند بماند: status لاک زنده می‌دهد
  s.fake.setStatus({ schemaVersion: 1, repo: {}, tasks: [{ id: '1', state: 'implementing', health: { transitionLock: { pid: 1, alive: true } } }] });
  const result = await s.run('merge', { branch: 'fix/busy' }, 409);
  assert.match(result.error, /قفل transition/);
  // قفل کهنه (alive:false) مانع نیست
  s.fake.setStatus({ schemaVersion: 1, repo: {}, tasks: [{ id: '1', state: 'implementing', health: { transitionLock: { pid: 1, alive: false } } }] });
  assert.equal((await s.run('merge', { branch: 'fix/busy' })).code, 0);
});

test('پاک کردن: worktree remove بدون force، branch -d بدون -D (شاخه‌ی ادغام‌نشده می‌ماند)', async t => {
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'fix/gone' });
  const dir = path.join(s.worktreesDir, 'fix-gone');
  commitInWorktree(dir);

  // worktree تغییر commit‌نشده دارد → git remove رد می‌کند و --force هم نیست
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'u');
  let result = await s.run('worktree-remove', { dir: 'fix-gone' });
  assert.notEqual(result.code, 0);
  assert.ok(fs.existsSync(dir), 'worktree کثیف پاک نشد');
  fs.rmSync(path.join(dir, 'untracked.txt'));

  result = await s.run('worktree-remove', { dir: 'fix-gone' });
  assert.equal(result.code, 0, result.text);
  assert.ok(!fs.existsSync(dir));

  // شاخه ادغام نشده است → -d رد می‌کند
  result = await s.run('branch-delete', { branch: 'fix/gone' });
  assert.notEqual(result.code, 0);
  assert.match(g(s.repoPath, 'branch', '--list', 'fix/gone'), /fix\/gone/);

  g(s.repoPath, 'merge', '--no-ff', '--no-edit', 'fix/gone');
  result = await s.run('branch-delete', { branch: 'fix/gone' });
  assert.equal(result.code, 0, result.text);
  assert.equal(g(s.repoPath, 'branch', '--list', 'fix/gone'), '');
  assert.deepEqual(s.audit().summaries({ action: 'git.branch-delete' })[0].argv, ['git', 'branch', '-d', 'fix/gone']);
});

test('هیچ مسیری در git-ops --force، -D، --no-verify یا shell:true ندارد', () => {
  const source = fs.readFileSync(new URL('../src/git-ops.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/manager-update.js', import.meta.url), 'utf8')
    + fs.readFileSync(new URL('../src/action-runner.js', import.meta.url), 'utf8');
  const code = source.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /['"]--force['"]|['"]-f['"]|['"]-D['"]|--no-verify|shell:\s*true/);
});

const powershell = await detectPowerShell();

test('prove-isolation: PROVEN به commit همین شاخه بسته می‌شود و merge را باز می‌کند؛ NOT PROVEN نه', { skip: powershell ? false : 'pwsh/powershell در دسترس نیست' }, async t => {
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'fix/pi' });
  const dir = path.join(s.worktreesDir, 'fix-pi');
  const tip = commitInWorktree(dir);

  // درخت کثیف → اثبات ممکن نیست
  fs.writeFileSync(path.join(dir, 'dirty.txt'), 'x');
  const dirty = await s.run('prove', { dir: 'fix-pi' }, 422);
  assert.match(dirty.error, /commit/);
  fs.rmSync(path.join(dir, 'dirty.txt'));

  const proved = await s.run('prove', { dir: 'fix-pi' });
  assert.equal(proved.code, 0, proved.text);
  assert.match(proved.text, /RESULT\] PROVEN/);
  await sleep(300); // نوشتن proof بعد از پایان exec
  const inventory = await (await get(s.base, '/api/repos/fake/git/inventory')).json();
  const wt = inventory.worktrees.find(w => w.branch === 'fix/pi');
  assert.equal(wt.proof.proven, true);
  assert.equal(wt.proof.commit, tip);
  const record = s.audit().summaries({ action: 'git.prove-isolation' })[0];
  assert.equal(record.argv.at(-4), '-Fix');
  assert.equal(record.argv.at(-3).toLowerCase(), dir.toLowerCase());
  assert.equal((await s.run('merge', { branch: 'fix/pi' })).code, 0);
});

test('prove-isolation: commit جدید اثبات قبلی را بی‌اعتبار می‌کند', { skip: powershell ? false : 'pwsh/powershell در دسترس نیست' }, async t => {
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'fix/pj' });
  const dir = path.join(s.worktreesDir, 'fix-pj');
  commitInWorktree(dir);
  assert.equal((await s.run('prove', { dir: 'fix-pj' })).code, 0);
  await sleep(300);
  commitInWorktree(dir, 'second.txt');
  const result = await s.run('merge', { branch: 'fix/pj' }, 422);
  assert.match(result.error, /دوباره اجرا کن/);
});

test('prove-isolation: اگر powershell نباشد دکمه غیرفعال می‌شود و دلیل می‌دهد (inventory.powershell=null)', async t => {
  const fake = makeFakeManagerRepo(t);
  initGitRepo(fake.root);
  const worktreesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-tools-wt-'));
  t.after(() => fs.rmSync(worktreesDir, { recursive: true, force: true }));
  fake.repo.tooling = { worktreesDir };
  const { base } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {} }, { powershell: null });
  assert.equal((await (await get(base, '/api/repos/fake/git/inventory')).json()).powershell, null);
  await post(base, '/api/repos/fake/git/worktree-add', { branch: 'fix/np' });
  await sleep(1500);
  const response = await post(base, '/api/repos/fake/git/prove', { dir: 'fix-np' });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /pwsh یا powershell/);
});

test('prove-isolation: خروجی NOT PROVEN (exit 1) اثبات منفی ثبت می‌کند و merge رد می‌شود', { skip: powershell ? false : 'pwsh/powershell در دسترس نیست' }, async t => {
  process.env.FAKE_PROVE_FAIL = '1';
  t.after(() => { delete process.env.FAKE_PROVE_FAIL; });
  const s = await setup(t);
  await s.run('worktree-add', { branch: 'fix/np2' });
  commitInWorktree(path.join(s.worktreesDir, 'fix-np2'));
  const proved = await s.run('prove', { dir: 'fix-np2' });
  assert.equal(proved.code, 1);
  await sleep(300);
  const inventory = await (await get(s.base, '/api/repos/fake/git/inventory')).json();
  assert.equal(inventory.worktrees.find(w => w.branch === 'fix/np2').proof.proven, false);
  assert.match((await s.run('merge', { branch: 'fix/np2' }, 422)).error, /PROVEN/);
});
