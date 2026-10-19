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
      // الحاقیه‌ی «ح»: commit ِ فعلی و تعداد commitهای عقب‌تر از origin/main (از ref های محلی؛ برای تازه‌سازی «بررسی (fetch)» در صفحه‌ی نگهداری)
      await add(`manager-version-${repo.id}`, 'مسیرها', `نسخه‌ی Manager (${repo.id})`, async () => {
        const label = `نسخه‌ی Manager (${repo.id})`;
        const id = `manager-version-${repo.id}`;
        let info;
        try { info = await updater.info(repo); }
        catch (error) { return check(id, 'مسیرها', label, 'warn', error.message, 'وضعیت git این مخزن خوانده نشد.'); }
        const where = `commit ${info.head.slice(0, 10)} (${info.branch || 'detached'})`;
        if (info.behind === null) return check(id, 'مسیرها', label, 'warn', where, info.remoteError || 'origin/main پیدا نشد.');
        if (info.behind > 0) return check(id, 'مسیرها', label, 'warn', `${where} · ${info.behind} commit عقب‌تر از origin/main`, 'از صفحه‌ی «نگهداری مخزن ابزار» به‌روزرسانی کن.');
        return check(id, 'مسیرها', label, 'ok', `${where} · هم‌سطح origin/main (تا آخرین fetch)`);
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
