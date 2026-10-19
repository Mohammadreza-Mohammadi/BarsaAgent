// کانبان فاز ۱، الحاقیه‌ی «ح»: به‌روزرسانی Manager روی سرور.
//
// روی سرور کسی کد Manager را توسعه نمی‌دهد؛ فقط باید آخرین نسخه‌ی origin را بگیرد.
// پیش‌شرط‌ها (همه قبل از اولین فرمان): بیکار بودن، درخت تمیز، روی main بودن.
// merge فقط fast-forward است؛ اگر نشد git خودش کاری نمی‌کند و پیامش نمایش داده می‌شود.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv, GitOpError } from './git-ops.js';
import { buildAgentEnv } from './agent-env.js';

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, shell: false, windowsHide: true, env: gitEnv(), timeout: 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(new Error((stderr || error.message).trim()), { stdout, stderr }));
      resolve(stdout);
    });
  });
}

/** npm را بدون shell اجرا می‌کنیم: node <npm-cli.js> (npm.cmd با shell:false روی ویندوز خراب است). */
export function findNpmCli(execPath = process.execPath) {
  const candidates = [
    path.join(path.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  ];
  return candidates.find(file => fs.existsSync(file)) || null;
}

export class ManagerUpdater {
  constructor({ runner, audit, idleCheck, help, config, npmCli }) {
    this.runner = runner;
    this.audit = audit;
    this.idleCheck = idleCheck;
    this.help = help;
    this.config = config;
    this.npmCli = npmCli === undefined ? findNpmCli() : npmCli;
  }

  /** commit فعلی و فاصله با origin/main — فقط از ref های محلی (بدون شبکه). */
  async info(repo) {
    const out = {};
    out.head = (await git(repo.path, ['rev-parse', 'HEAD'])).trim();
    out.branch = (await git(repo.path, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => '')).trim() || null;
    out.subject = (await git(repo.path, ['log', '-1', '--format=%s'])).trim();
    out.clean = (await git(repo.path, ['status', '--short'])).trim() === '';
    try {
      const counts = (await git(repo.path, ['rev-list', '--left-right', '--count', 'HEAD...origin/main'])).trim().split(/\s+/).map(Number);
      out.ahead = counts[0];
      out.behind = counts[1];
    } catch {
      out.ahead = null;
      out.behind = null;
      out.remoteError = 'origin/main پیدا نشد (هنوز fetch نشده یا remote تعریف نشده).';
    }
    return out;
  }

  /** فقط `git fetch origin` — برای تازه کردن عدد «چند commit عقب‌تر». */
  check(repo, ctx) {
    return this.runner.start({
      user: ctx.user, action: 'manager.fetch', repoId: repo.id, cwd: repo.path,
      program: 'git', args: ['fetch', 'origin'], env: { ...gitEnv(buildAgentEnv(this.config)) }
    });
  }

  async start(repo, ctx) {
    const reject = message => {
      this.audit.reject({ user: ctx.user, action: 'manager.update', repoId: repo.id, cwd: repo.path }, message);
      throw Object.assign(new GitOpError(message, 409), { audited: true });
    };
    const busy = await this.idleCheck(repo);
    if (busy) reject(busy);
    const info = await this.info(repo).catch(error => reject(`وضعیت git خوانده نشد: ${error.message}`));
    if (!info.clean) reject('git status تمیز نیست؛ به‌روزرسانی فقط روی درخت تمیز.');
    if (info.branch !== 'main') reject(`مخزن روی "${info.branch || 'detached HEAD'}" است؛ به‌روزرسانی فقط روی main.`);

    const env = gitEnv(buildAgentEnv(this.config));
    const before = info.head;
    const lockChanged = async () => {
      const changed = await git(repo.path, ['diff', '--name-only', before, 'HEAD', '--', 'package-lock.json']);
      return changed.trim() !== '';
    };
    const steps = [
      { label: 'git fetch origin', program: 'git', args: ['fetch', 'origin'], env },
      { label: 'git merge --ff-only origin/main', program: 'git', args: ['merge', '--ff-only', 'origin/main'], env }
    ];
    if (this.npmCli) {
      steps.push({ label: 'npm ci (فقط اگر package-lock.json عوض شده)', program: process.execPath, args: [this.npmCli, 'ci'], env, when: lockChanged });
    } else {
      steps.push({
        label: 'npm ci (فقط اگر package-lock.json عوض شده)',
        run: async push => {
          if (await lockChanged()) throw new Error('package-lock.json عوض شده ولی npm-cli.js کنار node پیدا نشد؛ npm ci را دستی/از راه دیگر اجرا کن.');
          push('system', 'package-lock.json عوض نشده؛ npm ci لازم نیست.');
        }
      });
    }
    steps.push({
      label: 'manager.js --help (تازه‌سازی فهرست زیرفرمان‌های کنسول)',
      run: async push => {
        const result = await this.help.refresh(repo);
        if (result.error) throw new Error(`manager.js --help بعد از به‌روزرسانی خوانده نشد: ${result.error}`);
        push('system', `زیرفرمان‌های مجاز: ${result.subcommands.join('، ')}`);
      }
    });
    return this.runner.sequence({
      user: ctx.user, action: 'manager.update', repoId: repo.id, cwd: repo.path, steps,
      display: 'به‌روزرسانی Manager از origin'
    });
  }
}
