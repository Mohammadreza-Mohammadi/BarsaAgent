// کانبان فاز ۱، بند د: نگهداری مخزن ابزار با یک فهرست **بسته** از عملیات git.
//
// هر عملیات یک تابع start* دارد که ورودی را اعتبارسنجی می‌کند، پیش‌شرط‌ها را
// می‌سنجد و فقط آرایه‌ی آرگومان ثابت و ساخته‌شده توسط خود کد را اجرا می‌کند.
// هیچ رشته‌ی خامی از کاربر به git نمی‌رسد؛ نام شاخه با regex ِ سخت و مسیر
// worktree فقط زیر tooling.worktreesDir پذیرفته می‌شود.
//
// نه `--force`، نه `-D`، نه `--no-verify`: hookهای git (pre-commit، commit-msg)
// همان‌طور که هستند اجرا می‌شوند.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const BRANCH_PATTERN = /^(fix|feat|chore)\/[a-z0-9-]+$/;
const DIR_NAME = /^[a-z0-9][a-z0-9-]{0,60}$/;
const GIT_LEAK_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_PREFIX',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE'
];

export class GitOpError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'GitOpError';
    this.status = status;
  }
}

/** env ِ تمیز برای git/pwsh: prove-isolation.ps1 اگر این متغیرها باشند اصلاً شروع نمی‌کند. */
export function gitEnv(base = process.env) {
  const env = { ...base, GIT_TERMINAL_PROMPT: '0' };
  for (const name of GIT_LEAK_VARS) delete env[name];
  return env;
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, shell: false, windowsHide: true, env: gitEnv(), maxBuffer: 8 * 1024 * 1024, timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error((stderr || error.message).trim()), { stdout, stderr }));
      resolve(stdout);
    });
  });
}

export function parseWorktrees(porcelain) {
  const items = [];
  let current = null;
  for (const raw of String(porcelain || '').split(/\r?\n/)) {
    if (!raw.trim()) { if (current) items.push(current); current = null; continue; }
    const [key, ...rest] = raw.split(' ');
    const value = rest.join(' ');
    if (key === 'worktree') current = { path: value, head: null, branch: null, bare: false, detached: false };
    else if (!current) continue;
    else if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
  }
  if (current) items.push(current);
  return items;
}

// مسیر پیش‌فرض Windows PowerShell: حساب سرویس ویندوز گاهی PATH ِ کامل ندارد.
function defaultPowerShellCandidates() {
  if (process.platform !== 'win32') return ['pwsh'];
  const root = process.env.SystemRoot || 'C:\Windows';
  return ['pwsh', 'powershell', path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')];
}

export async function detectPowerShell({ candidates = defaultPowerShellCandidates(), probe } = {}) {
  const check = probe || (name => new Promise(resolve => {
    execFile(name, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { shell: false, windowsHide: true, timeout: 15_000 }, error => resolve(!error));
  }));
  for (const name of candidates) {
    if (await check(name)) return name;
  }
  return null;
}

export class GitOps {
  #busy = new Set();
  #powershell;

  constructor({ runner, audit, registry, dataDir, config, idleCheck, powershell }) {
    this.runner = runner;
    this.audit = audit;
    this.registry = registry;
    this.config = config;
    this.proofFile = path.join(dataDir, 'isolation-proofs.json');
    // idleCheck(repo) → رشته‌ی دلیل (اگر مشغول است) یا null؛ برای merge ِ روی main.
    this.idleCheck = idleCheck || (async () => null);
    this.#powershell = powershell;
  }

  tooling(repo) {
    const t = repo.tooling || {};
    return {
      worktreesDir: t.worktreesDir ? path.resolve(t.worktreesDir) : null,
      proveIsolationScript: path.resolve(repo.path, t.proveIsolationScript || 'scripts/prove-isolation.ps1'),
      webiiiPath: t.webiiiPath || null,
      shadowPath: t.shadowPath || null
    };
  }

  async powershell() {
    if (this.#powershell === undefined || this.#powershell === 'auto') this.#powershell = await detectPowerShell();
    return this.#powershell;
  }

  // --- اثبات‌های جداسازی (PROVEN) -----------------------------------------------

  #readProofs() {
    try { return JSON.parse(fs.readFileSync(this.proofFile, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  proofFor(repo, branch) { return this.#readProofs()[`${repo.id}|${branch}`] || null; }

  #writeProof(repo, branch, proof) {
    const all = this.#readProofs();
    all[`${repo.id}|${branch}`] = proof;
    fs.mkdirSync(path.dirname(this.proofFile), { recursive: true });
    fs.writeFileSync(this.proofFile, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
  }

  // --- خواندنی‌ها -----------------------------------------------------------------

  async status(repo, ctx) {
    const [short, worktrees, log] = await Promise.all([
      execGit(repo.path, ['status', '--short']),
      execGit(repo.path, ['worktree', 'list']),
      execGit(repo.path, ['log', '--oneline', '-5'])
    ]);
    this.audit.note({ user: ctx.user, action: 'git.status', repoId: repo.id, cwd: repo.path, argv: ['git', 'status --short', 'worktree list', 'log --oneline -5'] });
    return { status: short, worktrees, log, clean: short.trim() === '' };
  }

  /** worktreeهای ثبت‌شده (با شاخه، commit و آخرین اثبات) — برای فرم‌های UI. */
  async inventory(repo) {
    const tooling = this.tooling(repo);
    const items = parseWorktrees(await execGit(repo.path, ['worktree', 'list', '--porcelain']));
    const powershell = await this.powershell();
    return {
      worktreesDir: tooling.worktreesDir,
      proveIsolationScript: tooling.proveIsolationScript,
      powershell,
      worktrees: items.map(item => ({
        ...item,
        managed: !!tooling.worktreesDir && isInside(tooling.worktreesDir, item.path),
        proof: item.branch ? this.proofFor(repo, item.branch) : null
      }))
    };
  }

  // --- عملیات ----------------------------------------------------------------------

  async #guard(action, repo, ctx, input, body) {
    const key = `${repo.id}`;
    try {
      if (this.#busy.has(key)) throw new GitOpError('یک عملیات git دیگر روی این مخزن در جریان است.', 409);
      return await body(key);
    } catch (error) {
      this.audit.reject({ user: ctx.user, action, repoId: repo.id, cwd: repo.path, input }, error.message);
      error.audited = true;
      throw error;
    }
  }

  #launch(key, opts) {
    this.#busy.add(key);
    const exec = this.runner.start({ ...opts, env: gitEnv() });
    exec.done.finally(() => this.#busy.delete(key));
    return exec;
  }

  async #registered(repo, name) {
    const tooling = this.tooling(repo);
    if (!tooling.worktreesDir) throw new GitOpError('tooling.worktreesDir در config تعریف نشده؛ عملیات worktree غیرفعال است.');
    if (!DIR_NAME.test(String(name || ''))) throw new GitOpError('نام پوشه‌ی worktree نامعتبر است (حروف کوچک/عدد/خط‌تیره).');
    const dir = path.join(tooling.worktreesDir, name);
    if (!isInside(tooling.worktreesDir, dir)) throw new GitOpError('مسیر worktree باید زیر پوشه‌ی تعریف‌شده در config باشد.');
    const known = parseWorktrees(await execGit(repo.path, ['worktree', 'list', '--porcelain']));
    const item = known.find(x => samePath(x.path, dir));
    if (!item) throw new GitOpError(`این مسیر یک worktree ثبت‌شده‌ی git نیست: ${dir}`);
    return { dir, item };
  }

  startWorktreeAdd(repo, input, ctx) {
    return this.#guard('git.worktree-add', repo, ctx, input, async key => {
      const tooling = this.tooling(repo);
      if (!tooling.worktreesDir) throw new GitOpError('tooling.worktreesDir در config تعریف نشده؛ ساخت worktree غیرفعال است.');
      const branch = String(input?.branch || '');
      if (!BRANCH_PATTERN.test(branch)) throw new GitOpError('نام شاخه باید fix/…، feat/… یا chore/… با حروف کوچک، عدد و خط‌تیره باشد.');
      const name = String(input?.dir || branch.replace('/', '-'));
      if (!DIR_NAME.test(name)) throw new GitOpError('نام پوشه‌ی worktree نامعتبر است (حروف کوچک/عدد/خط‌تیره).');
      const dir = path.join(tooling.worktreesDir, name);
      if (!isInside(tooling.worktreesDir, dir)) throw new GitOpError('مسیر worktree باید زیر پوشه‌ی تعریف‌شده در config باشد.');
      if (fs.existsSync(dir)) throw new GitOpError(`مسیر از قبل وجود دارد: ${dir}`);
      fs.mkdirSync(tooling.worktreesDir, { recursive: true });
      return this.#launch(key, {
        user: ctx.user, action: 'git.worktree-add', repoId: repo.id, cwd: repo.path,
        program: 'git', args: ['worktree', 'add', dir, '-b', branch, 'main']
      });
    });
  }

  startProve(repo, input, ctx) {
    return this.#guard('git.prove-isolation', repo, ctx, input, async key => {
      const tooling = this.tooling(repo);
      const { dir, item } = await this.#registered(repo, input?.dir);
      if (!item.branch || !BRANCH_PATTERN.test(item.branch)) throw new GitOpError(`شاخه‌ی این worktree (${item.branch || 'detached'}) با الگوی مجاز نمی‌خواند.`);
      const shell = await this.powershell();
      if (!shell) throw new GitOpError('pwsh یا powershell روی این سیستم پیدا نشد؛ آزمون جداسازی اجرا نمی‌شود.');
      if (!fs.existsSync(tooling.proveIsolationScript)) throw new GitOpError(`اسکریپت آزمون جداسازی پیدا نشد: ${tooling.proveIsolationScript}`);
      const dirty = (await execGit(dir, ['status', '--porcelain'])).trim();
      if (dirty) throw new GitOpError('worktree تغییر commit‌نشده دارد؛ اثبات باید به یک commit مشخص بسته شود. اول commit کن.');
      const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tooling.proveIsolationScript, '-Fix', dir, '-Main', repo.path];
      if (tooling.webiiiPath) args.push('-WebIII', path.resolve(tooling.webiiiPath));
      if (tooling.shadowPath) args.push('-Shadow', path.resolve(tooling.shadowPath));
      const exec = this.#launch(key, {
        user: ctx.user, action: 'git.prove-isolation', repoId: repo.id, cwd: repo.path,
        program: shell, args
      });
      exec.done.then(async result => {
        try {
          const commit = (await execGit(dir, ['rev-parse', 'HEAD'])).trim();
          const output = exec.lines.map(l => l.text).join('\n');
          const proven = result.code === 0 && !result.stopped && /\[RESULT\]\s+PROVEN\b/.test(output);
          this.#writeProof(repo, item.branch, { branch: item.branch, commit, proven, exitCode: result.code, at: new Date().toISOString(), execId: exec.id, user: ctx.user });
        } catch { /* بدون اثبات ثبت‌شده، merge باز هم رد می‌شود */ }
      });
      return exec;
    });
  }

  startMerge(repo, input, ctx) {
    return this.#guard('git.merge', repo, ctx, input, async key => {
      const branch = String(input?.branch || '');
      if (!BRANCH_PATTERN.test(branch)) throw new GitOpError('نام شاخه باید fix/…، feat/… یا chore/… با حروف کوچک، عدد و خط‌تیره باشد.');
      const dirty = (await execGit(repo.path, ['status', '--short'])).trim();
      if (dirty) throw new GitOpError('git status مخزن خالی نیست؛ merge فقط روی درخت تمیز.');
      const head = (await execGit(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim();
      if (head !== 'main') throw new GitOpError(`مخزن روی "${head || 'detached HEAD'}" است؛ merge فقط روی main.`);
      let tip;
      try { tip = (await execGit(repo.path, ['rev-parse', '--verify', `refs/heads/${branch}`])).trim(); }
      catch { throw new GitOpError(`شاخه‌ی ${branch} وجود ندارد.`); }
      const tag = await execGit(repo.path, ['rev-parse', '--verify', '--quiet', `refs/tags/${branch}`]).then(() => true, () => false);
      if (tag) throw new GitOpError(`یک tag هم‌نام ${branch} هست؛ merge مبهم است.`);
      const proof = this.proofFor(repo, branch);
      if (!proof?.proven) throw new GitOpError(`آزمون جداسازی ${branch} هنوز PROVEN نشده (یا آخرین نتیجه NOT PROVEN است).`);
      if (proof.commit !== tip) throw new GitOpError(`اثبات PROVEN برای commit ${proof.commit.slice(0, 8)} است ولی نوک ${branch} الان ${tip.slice(0, 8)} است؛ آزمون را دوباره اجرا کن.`);
      const busy = await this.idleCheck(repo);
      if (busy) throw new GitOpError(busy, 409);
      return this.#launch(key, {
        user: ctx.user, action: 'git.merge', repoId: repo.id, cwd: repo.path,
        program: 'git', args: ['merge', '--no-ff', '--no-edit', branch]
      });
    });
  }

  startWorktreeRemove(repo, input, ctx) {
    return this.#guard('git.worktree-remove', repo, ctx, input, async key => {
      const { dir } = await this.#registered(repo, input?.dir);
      const busy = await this.idleCheck(repo);
      if (busy) throw new GitOpError(busy, 409);
      return this.#launch(key, {
        user: ctx.user, action: 'git.worktree-remove', repoId: repo.id, cwd: repo.path,
        program: 'git', args: ['worktree', 'remove', dir]
      });
    });
  }

  startBranchDelete(repo, input, ctx) {
    return this.#guard('git.branch-delete', repo, ctx, input, async key => {
      const branch = String(input?.branch || '');
      if (!BRANCH_PATTERN.test(branch)) throw new GitOpError('نام شاخه باید fix/…، feat/… یا chore/… با حروف کوچک، عدد و خط‌تیره باشد.');
      return this.#launch(key, {
        user: ctx.user, action: 'git.branch-delete', repoId: repo.id, cwd: repo.path,
        program: 'git', args: ['branch', '-d', branch]
      });
    });
  }
}
