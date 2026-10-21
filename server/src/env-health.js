// کانبان فاز ۱، بند هـ: صفحه‌ی «سلامت محیط».
//
// روی سرور بدون شل، انسان راه دیگری برای فهمیدن «چرا run کار نمی‌کند» ندارد؛
// هر چیزی که کم است باید همین‌جا بگوید چه چیزی و چه کنم.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { buildAgentEnv } from './agent-env.js';
import { gitEnv, detectPowerShell } from './git-ops.js';
import { INTERNAL_SUBCOMMANDS } from './console-parser.js';

const GB = 1024 ** 3;

function runProgram(program, args, { env, timeoutMs = 20_000 } = {}) {
  return new Promise(resolve => {
    execFile(program, args, { shell: false, windowsHide: true, env, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error?.code ?? 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error });
    });
  });
}

/** یک درخواست HEAD، مستقیم یا از طریق پروکسی HTTP (CONNECT). هر پاسخ HTTP یعنی مسیر باز است. */
export function probeUrl(target, proxy, timeoutMs = 10_000) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const finish = (fn, value) => { clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => reject(new Error(`پاسخی در ${timeoutMs / 1000} ثانیه نیامد.`)), timeoutMs);
    const request = socket => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        host: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname || '/', method: 'HEAD',
        ...(socket ? { createConnection: () => socket, agent: false } : {}), servername: url.hostname, timeout: timeoutMs
      }, res => { res.resume(); finish(resolve, res.statusCode); });
      req.on('error', error => finish(reject, error));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.end();
    };
    if (!proxy) return request(null);
    const proxyUrl = new URL(proxy);
    const connect = http.request({ host: proxyUrl.hostname, port: proxyUrl.port || 80, method: 'CONNECT', path: `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`, timeout: timeoutMs });
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return finish(reject, new Error(`پروکسی CONNECT را با ${res.statusCode} رد کرد.`)); }
      if (url.protocol === 'https:') {
        // TLS روی تونل: https.request با createConnection ِ socket خام TLS نمی‌سازد؛ خودمان می‌سازیم.
        import('node:tls').then(tls => request(tls.connect({ socket, servername: url.hostname }))).catch(error => finish(reject, error));
      } else request(socket);
    });
    connect.on('error', error => finish(reject, error));
    connect.on('timeout', () => connect.destroy(new Error('timeout پروکسی')));
    connect.end();
  });
}

function check(id, group, label, status, detail, hint) {
  return { id, group, label, status, detail: detail ?? '', hint: hint ?? '' };
}

async function safe(id, group, label, fn) {
  try { return await fn(); }
  catch (error) { return check(id, group, label, 'fail', error.message); }
}

function freeSpace(dir, statfs = fs.promises.statfs) {
  return statfs(dir).then(s => Number(s.bavail) * Number(s.bsize));
}

export async function runHealthChecks({ config, repos, dataDir, managerInfo, help, users, updater, deps = {} }) {
  const probe = deps.probeUrl || probeUrl;
  const statfs = deps.statfs || fs.promises.statfs;
  const settings = config.health || {};
  const claude = { command: 'claude', versionArgs: ['--version'], authArgs: ['auth', 'status'], ...(settings.claude || {}) };
  const agentEnv = buildAgentEnv(config);
  const results = [];
  const add = async (id, group, label, fn) => results.push(await safe(id, group, label, fn));

  await Promise.all([
    add('node', 'ابزار', 'node', async () => {
      const engine = deps.nodeRange;
      return check('node', 'ابزار', 'node', 'ok', process.version, engine ? `نیاز: ${engine}` : '');
    }),
    add('git', 'ابزار', 'git', async () => {
      const r = await runProgram('git', ['--version'], { env: gitEnv() });
      return r.ok ? check('git', 'ابزار', 'git', 'ok', r.stdout) : check('git', 'ابزار', 'git', 'fail', r.error?.message, 'git باید در PATH حساب سرویس باشد.');
    }),
    add('claude', 'ابزار', 'claude CLI', async () => {
      const r = await runProgram(claude.command, claude.versionArgs, { env: agentEnv });
      if (r.ok) return check('claude', 'ابزار', 'claude CLI', 'ok', r.stdout);
      return check('claude', 'ابزار', 'claude CLI', 'fail', r.error?.message,
        'اگر با npm نصب شده، فقط claude.cmd وجود دارد و بدون shell اجرا نمی‌شود: مسیر claude.exe (یا node + cli.js) را در health.claude.command بگذار.');
    }),
    add('claude-auth', 'ابزار', 'احراز هویت claude', async () => {
      const r = await runProgram(claude.command, claude.authArgs, { env: agentEnv });
      const text = [r.stdout, r.stderr].filter(Boolean).join('\n');
      if (r.ok && !/not (logged|signed)|no (active )?(account|login)/i.test(text)) return check('claude-auth', 'ابزار', 'احراز هویت claude', 'ok', text.slice(0, 300));
      return check('claude-auth', 'ابزار', 'احراز هویت claude', 'fail', text.slice(0, 300) || r.error?.message,
        'با همان حسابی که سرویس کانبان اجرا می‌شود یک بار `claude auth login` بزن (توکن OAuth محیط عمداً حذف می‌شود).');
    }),
    add('proxy', 'شبکه', 'پروکسی', async () => {
      const proxy = agentEnv.HTTPS_PROXY || agentEnv.HTTP_PROXY || null;
      const target = settings.proxyTestUrl || 'https://api.anthropic.com/';
      try {
        const code = await probe(target, proxy);
        return check('proxy', 'شبکه', proxy ? `پروکسی ${proxy}` : 'اتصال مستقیم (بدون پروکسی)', 'ok', `${target} → HTTP ${code}`);
      } catch (error) {
        return check('proxy', 'شبکه', proxy ? `پروکسی ${proxy}` : 'اتصال مستقیم (بدون پروکسی)', 'fail', `${target}: ${error.message}`,
          proxy ? 'پروکسی بالا نیست یا آدرسش run.proxy در config درست نیست.' : 'اتصال مستقیم کار نمی‌کند؛ run.proxy را در config بگذار.');
      }
    }),
    add('powershell', 'ابزار', 'pwsh / powershell', async () => {
      const name = deps.powershell !== undefined ? deps.powershell : await detectPowerShell();
      return name
        ? check('powershell', 'ابزار', 'pwsh / powershell', 'ok', name)
        : check('powershell', 'ابزار', 'pwsh / powershell', 'warn', 'پیدا نشد', 'بدون آن «آزمون جداسازی» (و در نتیجه merge شاخه‌ی ابزار) غیرفعال است.');
    })
  ]);

  for (const repo of repos) {
    const label = `مخزن ${repo.id}`;
    await add(`repo-${repo.id}`, 'مسیرها', label, async () => {
      if (!fs.existsSync(repo.path)) return check(`repo-${repo.id}`, 'مسیرها', label, 'fail', repo.path, 'مسیر مخزن در config وجود ندارد.');
      const script = path.resolve(repo.path, repo.managerScript);
      if (!fs.existsSync(script)) return check(`repo-${repo.id}`, 'مسیرها', label, 'fail', script, 'managerScript پیدا نشد.');
      const info = managerInfo?.[repo.id];
      return check(`repo-${repo.id}`, 'مسیرها', label, 'ok', `${repo.path}${info?.managerVersion ? ` · Manager ${info.managerVersion}` : ''}`);
    });
    for (const [key, name] of [['shadowPath', 'مخزن shadow'], ['webiiiPath', 'WebIII']]) {
      const value = repo.tooling?.[key];
      await add(`${key}-${repo.id}`, 'مسیرها', `${name} (${repo.id})`, async () => {
        if (!value) return check(`${key}-${repo.id}`, 'مسیرها', `${name} (${repo.id})`, 'warn', 'در config (tooling.' + key + ') تعریف نشده');
        return fs.existsSync(value)
          ? check(`${key}-${repo.id}`, 'مسیرها', `${name} (${repo.id})`, 'ok', value)
          : check(`${key}-${repo.id}`, 'مسیرها', `${name} (${repo.id})`, 'fail', value, 'مسیر وجود ندارد.');
      });
    }
    if (help) {
      await add(`help-${repo.id}`, 'کنسول', `زیرفرمان‌های Manager (${repo.id})`, async () => {
        const h = await help.get(repo);
        if (h.error) return check(`help-${repo.id}`, 'کنسول', `زیرفرمان‌های Manager (${repo.id})`, 'fail', h.error, 'بدون این فهرست کنسول همه‌چیز را رد می‌کند.');
        const missing = INTERNAL_SUBCOMMANDS.filter(name => !h.subcommands.includes(name));
        return missing.length
          ? check(`help-${repo.id}`, 'کنسول', `زیرفرمان‌های Manager (${repo.id})`, 'warn', `این زیرفرمان‌ها که دکمه‌های کانبان صدا می‌زنند در --help نیستند: ${missing.join('، ')}`)
          : check(`help-${repo.id}`, 'کنسول', `زیرفرمان‌های Manager (${repo.id})`, 'ok', h.subcommands.join('، '));
      });
    }
    if (updater) {
      // ahead/behind و زمان آخرین fetch را خود Manager می‌گوید (status --json ← repository.sync، TOOLING-040)؛ کانبان
      // هیچ git ای برای این مخزن اجرا نمی‌کند. همان یک خواندن status سه ردیف می‌سازد: نسخه/sync، config ِ محلی، اجرا.
      const syncId = `manager-version-${repo.id}`;
      const syncLabel = `نسخه‌ی Manager و sync (${repo.id})`;
      let info = null;
      let infoError = null;
      try { info = await updater.info(repo); } catch (error) { infoError = error; }
      await add(syncId, 'مسیرها', syncLabel, async () => {
        if (infoError) return check(syncId, 'مسیرها', syncLabel, 'warn', infoError.message, 'status --json ِ Manager خوانده نشد.');
        const where = `commit ${(info.head || '؟').slice(0, 10)} (${info.branch || 'شاخه نامعلوم'})`;
        const fetched = info.lastFetchAt ? `آخرین fetch: ${info.lastFetchAt}` : 'هنوز fetch نشده';
        if (info.remoteError) return check(syncId, 'مسیرها', syncLabel, 'warn', `${where} · ${fetched}`, info.remoteError);
        const counts = `${info.ahead} commit جلوتر · ${info.behind} commit عقب‌تر از ${info.upstream || 'origin/main'}`;
        const detail = `${where} · ${counts} · ${fetched}`;
        if (info.behind > 0 || info.ahead > 0) {
          return check(syncId, 'مسیرها', syncLabel, 'warn', detail, 'از صفحه‌ی «نگهداری مخزن ابزار» اکشن «sync» را اجرا کن (ff / push / merge ِ واقعی؛ هرگز rebase).');
        }
        return check(syncId, 'مسیرها', syncLabel, info.lastFetchAt ? 'ok' : 'warn', detail, info.lastFetchAt ? '' : 'ahead/behind از آخرین fetch است؛ با «پیش‌نمایش sync» تازه می‌شود.');
      });

      const localId = `manager-localconfig-${repo.id}`;
      const localLabel = `config ِ محلی Manager (${repo.id})`;
      await add(localId, 'مسیرها', localLabel, async () => {
        if (infoError) return check(localId, 'مسیرها', localLabel, 'warn', infoError.message);
        const local = info.localConfig;
        if (!local) return check(localId, 'مسیرها', localLabel, 'warn', 'این Manager repository.localConfig را نمی‌دهد (قدیمی‌تر از TOOLING-040)');
        const keys = Array.isArray(local.keys) && local.keys.length ? local.keys.join('، ') : '—';
        if (!local.present) return check(localId, 'مسیرها', localLabel, 'ok', `وجود ندارد (${local.path}) — پیش‌فرض‌های repository.yaml`);
        if (!local.applied) return check(localId, 'مسیرها', localLabel, 'warn', `هست ولی اعمال نشده · ${local.path} · کلیدها: ${keys}`, 'Manager فایل را خوانده ولی نپذیرفته؛ خروجی «config --effective» را ببین.');
        return check(localId, 'مسیرها', localLabel, 'ok', `هست و اعمال شده · ${local.path} · کلیدها: ${keys}`);
      });

      const execId = `manager-execution-${repo.id}`;
      const execLabel = `اجرا (${repo.id})`;
      await add(execId, 'مسیرها', execLabel, async () => {
        if (infoError) return check(execId, 'مسیرها', execLabel, 'warn', infoError.message);
        const execution = info.execution;
        if (!execution) return check(execId, 'مسیرها', execLabel, 'warn', 'این Manager repository.execution را نمی‌دهد (قدیمی‌تر از TOOLING-040)');
        if (execution.enabled === false) {
          return check(execId, 'مسیرها', execLabel, 'warn', `خاموش — execution.enabled=false (منبع: ${execution.source || '؟'})`, `${execution.reason || ''} فقط sync کار می‌کند. روی سرور باید روشن باشد: execution.enabled را در repository.local.yaml برگردان.`.trim());
        }
        return check(execId, 'مسیرها', execLabel, 'ok', `روشن (منبع: ${execution.source || 'پیش‌فرض'})`);
      });

      const actionsId = `manager-actions-${repo.id}`;
      const actionsLabel = `قرارداد actions ِ Manager (${repo.id})`;
      await add(actionsId, 'مسیرها', actionsLabel, async () => {
        const version = managerInfo?.[repo.id]?.capabilities?.status?.actionsVersion;
        if (typeof version === 'number' && version >= 2) return check(actionsId, 'مسیرها', actionsLabel, 'ok', `actionsVersion ${version}`);
        return check(actionsId, 'مسیرها', actionsLabel, 'warn', `actionsVersion ${typeof version === 'number' ? version : 'نیست'} (کمتر از ۲)`, 'Manager قدیمی است: دکمه‌ی «بالا بردن سقف» پنهان می‌ماند. با sync ِ Manager را به‌روز کن.');
      });
    }
    for (const dir of [repo.path]) {
      await add(`disk-${repo.id}`, 'دیسک', `فضای خالی (${repo.id})`, async () => diskCheck(`disk-${repo.id}`, `فضای خالی (${repo.id})`, dir, statfs));
    }
  }
  await add('disk-data', 'دیسک', 'فضای خالی (داده‌های کانبان)', async () => diskCheck('disk-data', 'فضای خالی (داده‌های کانبان)', dataDir, statfs));
  await add('users', 'امنیت', 'حساب‌های ورود', async () => {
    const n = users?.count?.() ?? 0;
    return n > 0 ? check('users', 'امنیت', 'حساب‌های ورود', 'ok', `${n} حساب`) : check('users', 'امنیت', 'حساب‌های ورود', 'fail', 'هیچ حسابی نیست', 'npm run user:add -- <نام>');
  });

  return { checkedAt: new Date().toISOString(), ok: results.every(r => r.status !== 'fail'), checks: results };
}

async function diskCheck(id, label, dir, statfs) {
  const free = await freeSpace(dir, statfs);
  const text = `${(free / GB).toFixed(1)} گیگابایت آزاد (${dir})`;
  if (free < 1 * GB) return check(id, 'دیسک', label, 'fail', text, 'کمتر از ۱ گیگابایت؛ worktreeها و لاگ‌ها جا نمی‌شوند.');
  if (free < 5 * GB) return check(id, 'دیسک', label, 'warn', text, 'کمتر از ۵ گیگابایت.');
  return check(id, 'دیسک', label, 'ok', text);
}
