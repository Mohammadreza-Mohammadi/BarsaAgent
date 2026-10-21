// کانبان فاز ۱، الحاقیه‌ی «ح»: به‌روزرسانی Manager روی سرور — با `manager.js sync` (TOOLING-040).
//
// کانبان هیچ منطق git یا `npm ci` ِ مخزن Manager را نگه نمی‌دارد: همه‌چیز (پیش‌شرط‌ها، fetch، ff/push/merge ِ
// واقعی، هرگز rebase، `npm ci` فقط با تغییر package-lock) در خود Manager است. این‌جا فقط:
//   - `sync [--dry-run] --json` را اجرا می‌کند (stderr ِ زنده‌ی git/npm مستقیم در لاگ اجرا)،
//   - JSON ِ نهایی و exit code را به متن فارسی روشن تبدیل می‌کند (sync-report.js)،
//   - بعد از sync ِ موفق `--help` و capabilities را دوباره می‌خواند،
//   - وضعیت ahead/behind را از `repository.sync` ِ `status --json` می‌خواند (نه از محاسبه‌ی خودش).
import path from 'node:path';
import { gitEnv, GitOpError } from './git-ops.js';
import { buildAgentEnv } from './agent-env.js';
import { inspectManager } from './protocol-contract.js';
import { exitMessage, formatSyncReport, parseSyncJson } from './sync-report.js';

/** نمای «سلامت sync» از بدنه‌ی `status --json`: فقط همان فیلدهایی که Manager داده. */
export function syncInfoFromStatus(board) {
  const sync = board?.repository?.sync ?? null;
  const out = {
    head: board?.repo?.head ?? null,
    branch: sync?.branch ?? null,
    upstream: sync?.upstream ?? null,
    ahead: Number.isInteger(sync?.ahead) ? sync.ahead : null,
    behind: Number.isInteger(sync?.behind) ? sync.behind : null,
    lastFetchAt: sync?.lastFetchAt ?? null,
    execution: board?.repository?.execution ?? null,
    localConfig: board?.repository?.localConfig ?? null
  };
  if (!sync) out.remoteError = 'این Manager repository.sync را در status --json نمی‌دهد (قدیمی‌تر از TOOLING-040) — با «sync» نمی‌توان به‌روزش کرد.';
  else if (out.ahead === null || out.behind === null) out.remoteError = 'ahead/behind در status --json خالی است (upstream تعریف نشده یا هنوز fetch نشده).';
  return out;
}

export class ManagerUpdater {
  constructor({ runner, audit, registry, help, config, readStatus, inspect }) {
    this.runner = runner;
    this.audit = audit;
    this.registry = registry;
    this.help = help;
    this.config = config;
    this.readStatus = readStatus;
    this.inspect = inspect ?? inspectManager;
  }

  /** وضعیت sync از `status --json` ِ Manager (بدون git و بدون شبکه). */
  async info(repo) {
    return syncInfoFromStatus(await this.readStatus(repo));
  }

  /** `sync --dry-run --json`: فقط می‌سنجد (fetch می‌کند، چیزی عوض نمی‌شود). */
  preview(repo, ctx) {
    return this.#run(repo, ctx, { dryRun: true });
  }

  /** `sync --json`: اجرای واقعی. */
  start(repo, ctx) {
    return this.#run(repo, ctx, { dryRun: false });
  }

  #reject(repo, ctx, action, message) {
    this.audit.reject({ user: ctx.user, action, repoId: repo.id, cwd: repo.path }, message);
    throw Object.assign(new GitOpError(message, 409), { audited: true });
  }

  #run(repo, ctx, { dryRun }) {
    const action = dryRun ? 'manager.sync-preview' : 'manager.update';
    const caps = this.config.managerInfo?.[repo.id]?.capabilities;
    if (caps && !caps.sync) this.#reject(repo, ctx, action, 'Manager قدیمی است: زیرفرمان sync (TOOLING-040) را ندارد؛ یک بار دستی به‌روزش کن.');
    // صف خود کانبان را فقط خود کانبان می‌داند (Manager تا شروع واقعی run قفلی نمی‌بیند)؛ بقیه‌ی پیش‌شرط‌ها (main، درخت
    // تمیز، قفل زنده) را Manager می‌سنجد و با exit 50 رد می‌کند.
    if (!dryRun) {
      const active = this.registry.list(repo).filter(run => run.queued || run.running);
      if (active.length) this.#reject(repo, ctx, action, `اجرا در جریان/صف است: ${active.map(r => `#${r.taskId}`).join('، ')}`);
    }

    const script = path.resolve(repo.path, repo.managerScript);
    const args = [script, 'sync', ...(dryRun ? ['--dry-run'] : []), '--json'];
    const label = `node ${repo.managerScript} sync${dryRun ? ' --dry-run' : ''} --json`;
    // env ِ git/npm ِ داخل Manager همین است: پروکسی run.proxy برای fetch/push، و رازهای .env.local حذف.
    const env = gitEnv(buildAgentEnv(this.config));

    const syncStep = {
      label,
      run: async (push, adopt) => {
        const sub = this.runner.start({
          user: ctx.user, action: `${action}.step`, repoId: repo.id, cwd: repo.path,
          program: process.execPath, args, env, display: label
        });
        adopt?.(sub);
        // stdout = JSON ِ نهایی (فقط برای تحلیل)؛ stderr = پیشرفت زنده‌ی git/npm → مستقیم در لاگ اجرا (npm ci تا
        // ۲۰ دقیقه و hook ِ pre-push تا ۳۰ دقیقه).
        const stdout = [];
        const handle = item => (item.stream === 'stderr' ? push('stderr', item.text) : stdout.push(item.text));
        for (const item of sub.lines) handle(item); // خطوط همزمان (مثلاً خطای spawn) پیش از شنونده
        sub.events.on('line', handle);
        const { code } = await sub.done;
        sub.events.off('line', handle);
        const result = parseSyncJson(stdout.join('\n'));
        for (const line of formatSyncReport(result, code)) push('system', line);
        if (code !== 0) {
          const message = exitMessage(code) ?? `sync با exit code ${code} تمام شد (کد ناشناخته برای کانبان).`;
          throw Object.assign(new Error(`${message} [exit ${code}]`), { exitCode: code });
        }
        if (!result) throw new Error('sync موفق بود ولی خروجی --json ِ آن خوانده نشد.');
        push('system', dryRun ? 'پیش‌نمایش تمام شد؛ چیزی تغییر نکرد.' : 'sync موفق.');
      }
    };

    const steps = [syncStep];
    if (!dryRun) {
      steps.push({
        label: 'manager.js --help (تازه‌سازی فهرست زیرفرمان‌های کنسول)',
        run: async push => {
          const result = await this.help.refresh(repo);
          if (result.error) throw new Error(`manager.js --help بعد از به‌روزرسانی خوانده نشد: ${result.error}`);
          push('system', `زیرفرمان‌های مجاز: ${result.subcommands.join('، ')}`);
        }
      }, {
        label: 'manager.js capabilities (تازه‌سازی قابلیت‌ها و نسخه‌ی Manager)',
        run: async push => {
          const info = await this.inspect(repo);
          if (!this.config.managerInfo) this.config.managerInfo = {};
          this.config.managerInfo[repo.id] = info;
          if (!info.ok) throw new Error(`Manager بعد از به‌روزرسانی با کانبان سازگار نیست: ${(info.errors || []).join(' | ')}`);
          push('system', `Manager ${info.managerVersion || 'unknown'} · Contract v${info.contractVersion}`);
        }
      });
    }
    return this.runner.sequence({
      user: ctx.user, action, repoId: repo.id, cwd: repo.path, steps,
      display: dryRun ? 'پیش‌نمایش sync ِ Manager با origin' : 'همگام‌سازی Manager با origin (sync)'
    });
  }
}
