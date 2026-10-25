// جمع‌آوری تشخیص (diag) برای `barsa diag` — فقط خواندنی.
//
// هر بخش مستقل است: خرابی یک بخش (مثلاً git) فقط همان بخش را `{ error }` می‌کند و بقیه می‌آیند. هیچ مسیر/فرمان
// دلخواهی از ورودی کاربر ساخته نمی‌شود: مسیرها فقط از `status --json` ِ Manager (task.dir / task.worktree / task.git.branch)
// می‌آیند و پیش از استفاده اعتبارسنجی می‌شوند؛ فرمان‌ها (git، powershell) ثابت‌اند.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gitEnv } from './git-ops.js';
import { environmentSecrets, redact } from './security.js';
import { ageMs, interestingProcesses, ownHelperPids, relatedToTask } from './process-list.js';
import { APP_ROOT } from './config.js';

const GB = 1024 ** 3;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

export const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** هر متن بیرونی که به خروجی می‌رود از redactor مشترک می‌گذرد (راز محیط + الگوهای توکن + شناسه‌ی کاربر پورتال). */
export const safe = (value, max) => {
  const text = redact(String(value ?? ''), environmentSecrets());
  return max ? clip(text, max) : text;
};

export function runGit(cwd, args, { timeoutMs = 20_000 } = {}) {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks', ...args], { cwd, env: gitEnv(), shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '').trim() });
    });
  });
}

const lines = text => String(text || '').split(/\r?\n/).map(l => l.trimEnd()).filter(Boolean);

async function guard(fn) {
  try { return await fn(); } catch (error) { return { error: safe(error?.message || error, 300) }; }
}

/** مسیر تعریف‌شده توسط Manager نسبت به ریشه‌ی مخزن؛ هرگز مسیر ورودی کاربر. */
function resolveFromManager(repo, declared) {
  const text = typeof declared === 'string' ? declared.trim() : '';
  if (!text || /[\0\r\n]/.test(text)) return null;
  return path.resolve(repo.path, text);
}

export function summarizeProcess(proc, now, max = 120) {
  const age = ageMs(proc, now);
  return {
    pid: proc.pid, ppid: proc.ppid, name: proc.name,
    startedAt: proc.startedAt ? new Date(proc.startedAt).toISOString() : null,
    ageSec: age === null ? null : Math.round(age / 1000),
    cpuSeconds: proc.cpuSeconds,
    cmd: safe(proc.cmd, max)
  };
}

function eventLine(event) {
  if (event?.error) return safe(event.error, 150);
  const at = String(event?.at ?? event?.ts ?? event?.time ?? '').replace('T', ' ').slice(5, 19);
  const move = event?.from || event?.to ? ` ${event.from ?? '?'}→${event.to ?? '?'}` : '';
  const extra = event?.reason || event?.kind || event?.detail || event?.message || '';
  return safe(`${at} ${event?.event ?? '?'}${move}${extra ? ` · ${extra}` : ''}`, 150);
}

/**
 * @param ctx { repo, task, registry, audit, listProcesses, readEvents, now, runLog }
 */
export async function collectTaskDiag(ctx) {
  const { repo, task, registry, listProcesses, readEvents, readSummary, runLog } = ctx;
  const now = ctx.now ?? Date.now();
  const taskId = String(task.id);
  const worktreePath = resolveFromManager(repo, task.worktree?.path);
  const taskDirPath = resolveFromManager(repo, task.dir);
  const runs = registry.list(repo);
  const mine = runs.find(run => String(run.taskId) === taskId) ?? null;
  const live = registry.get(repo, taskId);
  const rootPids = live && !live.finished && live.child?.pid ? [live.child.pid] : [];

  const [summary, events, log, processes, taskDirGit, worktree] = await Promise.all([
    guard(async () => safe(await readSummary(taskId))),
    guard(async () => (await readEvents(taskId)).slice(-30).map(eventLine)),
    guard(async () => runLog(taskId, 60)),
    guard(async () => {
      const all = await listProcesses();
      const helpers = ownHelperPids(all, { rootPids });
      return relatedToTask(all, { taskId, worktreePath, taskDir: taskDirPath, rootPids }).filter(proc => !helpers.has(proc.pid)).map(proc => summarizeProcess(proc, now));
    }),
    guard(async () => {
      if (!taskDirPath) return { note: 'Manager مسیر پوشه‌ی تسک را نداد.' };
      const rel = path.relative(repo.path, taskDirPath).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { note: 'مسیر پوشه‌ی تسک بیرون از مخزن است؛ بررسی نشد.' };
      const result = await runGit(repo.path, ['status', '--short', '--', rel]);
      return result.ok ? { path: rel, lines: lines(result.stdout).map(l => safe(l, 200)) } : { error: safe(result.stderr, 200) };
    }),
    guard(async () => {
      const exists = worktreePath ? fs.existsSync(worktreePath) : false;
      const out = {
        path: worktreePath ? safe(worktreePath, 200) : null, managerStatus: task.worktree?.status ?? null, exists,
        branch: task.git?.branch ?? null, base: task.git?.base ?? null, nodeModulesBin: null, dirty: null, merged: null, ownCommits: null, branchExists: null
      };
      if (worktreePath && exists) {
        const bin = path.join(worktreePath, 'node_modules', '.bin');
        out.nodeModulesBin = fs.existsSync(bin);
        const status = await runGit(worktreePath, ['status', '--short']);
        out.dirty = status.ok ? lines(status.stdout).slice(0, 15).map(l => safe(l, 160)) : [`خطا: ${safe(status.stderr, 120)}`];
      }
      const branch = typeof out.branch === 'string' ? out.branch : '';
      const base = typeof out.base === 'string' && BRANCH.test(out.base) ? out.base : 'main';
      if (BRANCH.test(branch)) {
        const verify = await runGit(repo.path, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
        out.branchExists = verify.ok;
        if (verify.ok) {
          out.merged = (await runGit(repo.path, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`])).ok;
          const count = await runGit(repo.path, ['rev-list', '--count', `refs/heads/${base}..refs/heads/${branch}`]);
          out.ownCommits = count.ok ? Number(count.stdout.trim()) : null;
        }
      }
      return out;
    })
  ]);

  const queued = runs.filter(run => run.queued).sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const queue = {
    state: mine?.running ? 'running' : mine?.queued ? 'queued' : 'none',
    position: mine?.queuePosition ?? null,
    slotsUsed: registry.activeCount(), slotsMax: registry.maxConcurrent,
    waitingAhead: mine?.queued ? queued.filter(run => (run.queuePosition ?? 0) < (mine.queuePosition ?? 0)).map(run => String(run.taskId)) : [],
    runningNow: runs.filter(run => run.running).map(run => String(run.taskId))
  };

  return {
    taskId, repo: repo.id, generatedAt: new Date(now).toISOString(),
    state: task.state ?? null, stateSince: task.stateSince ?? null,
    gate: task.awaitingHuman ? { kind: task.awaitingHuman.kind ?? null, since: task.awaitingHuman.since ?? null } : null,
    blocker: task.blocker ? { kind: task.blocker.kind ?? null, detail: safe(task.blocker.detail ?? task.blocker.reason ?? '', 300) } : null,
    waitingFor: task.waitingFor ?? null,
    health: task.health ?? null,
    actions: Object.keys(task.actions || {}).filter(key => task.actions[key] === true || (Array.isArray(task.actions[key]) && task.actions[key].length)),
    summary, events, log, processes, taskDirGit, worktree, queue
  };
}

// --- سیستم ---------------------------------------------------------------------------------------------------

/** مسیر کامل یک برنامه روی PATH ِ **همین فرآیند** (سرویس)؛ خود PATH هرگز چاپ نمی‌شود. */
export function whichOnPath(name, env = process.env, platform = process.platform) {
  if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;
  const dirs = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' && !path.extname(name) ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      try { if (fs.statSync(candidate).isFile()) return candidate; } catch { /* نیست */ }
    }
  }
  return null;
}

function tailFile(file, count, maxBytes = 256 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    let text = buffer.toString('utf8');
    // لاگ NSSM گاهی UTF-16 است؛ بایت‌های صفر را بردار.
    if (text.includes('\u0000')) text = text.replace(/\u0000/g, '');
    let all = text.split(/\r?\n/);
    if (stat.size > length) all = all.slice(1);
    return all.filter(l => l !== '').slice(-count);
  } finally { fs.closeSync(fd); }
}

export function defaultErrLog(config) {
  const configured = config.logs?.errFile;
  if (typeof configured === 'string' && configured.trim()) return path.resolve(configured);
  return path.join(`${APP_ROOT}-logs`, 'kanban.err.log');
}

/**
 * @param ctx { config, repo, dataDir, registry, boardFor, listProcesses, issuesCount, statfs, env, now, startedAtMs }
 */
export async function collectSystemDiag(ctx) {
  const { config, repo, dataDir, registry, boardFor, listProcesses, issuesCount } = ctx;
  const now = ctx.now ?? Date.now();
  const env = ctx.env ?? process.env;
  const statfs = ctx.statfs ?? fs.promises.statfs;
  const claudeCommand = config.health?.claude?.command || 'claude';

  const [processes, board, git, disk, errLog, issues] = await Promise.all([
    guard(async () => {
      const all = await listProcesses();
      const rootPids = registry.list(repo).filter(run => run.running).map(run => registry.get(repo, run.taskId)?.child?.pid).filter(Number.isInteger);
      const helpers = ownHelperPids(all, { rootPids });
      return interestingProcesses(all).filter(proc => !helpers.has(proc.pid)).map(proc => summarizeProcess(proc, now));
    }),
    guard(() => boardFor(repo)),
    guard(async () => {
      const status = await runGit(repo.path, ['status', '--short']);
      const worktrees = await runGit(repo.path, ['worktree', 'list']);
      return {
        status: status.ok ? lines(status.stdout).slice(0, 40).map(l => safe(l, 200)) : [`خطا: ${safe(status.stderr, 150)}`],
        worktrees: worktrees.ok ? lines(worktrees.stdout).slice(0, 40).map(l => safe(l, 200)) : [`خطا: ${safe(worktrees.stderr, 150)}`]
      };
    }),
    guard(async () => {
      const targets = [[`مخزن ${repo.id}`, repo.path], ['داده‌ی کانبان', dataDir]];
      if (repo.tooling?.worktreesDir) targets.push(['worktreeها', repo.tooling.worktreesDir]);
      const out = [];
      for (const [label, dir] of targets) {
        try { const s = await statfs(dir); out.push({ label, path: safe(dir, 160), freeGB: Number(((Number(s.bavail) * Number(s.bsize)) / GB).toFixed(1)) }); }
        catch (error) { out.push({ label, path: safe(dir, 160), error: safe(error.message, 120) }); }
      }
      return out;
    }),
    guard(async () => {
      const file = defaultErrLog(config);
      if (!fs.existsSync(file)) return { file: safe(file, 200), lines: [], note: 'فایل پیدا نشد (logs.errFile در config را بگذار).' };
      return { file: safe(file, 200), lines: tailFile(file, 30).map(l => safe(l, 300)) };
    }),
    guard(async () => ({ count: await issuesCount() }))
  ]);

  const tasks = board?.tasks || [];
  const locks = board?.error ? { error: board.error } : {
    manager: board.repository?.health?.managerLock ?? null,
    tasks: tasks.filter(t => t.health?.transitionLock).map(t => ({ id: String(t.id), state: t.state, ...t.health.transitionLock })),
    stuck: tasks.filter(t => t.health?.stuck).map(t => ({ id: String(t.id), reasons: t.health.stuckReasons || [] }))
  };
  const runs = registry.list(repo);
  const claudeResolved = whichOnPath(claudeCommand, env);
  return {
    generatedAt: new Date(now).toISOString(),
    service: {
      pid: process.pid, startedAt: new Date(ctx.startedAtMs ?? now - process.uptime() * 1000).toISOString(),
      uptimeSec: Math.round((now - (ctx.startedAtMs ?? now - process.uptime() * 1000)) / 1000),
      node: process.version, platform: process.platform, dataDir: safe(dataDir, 160)
    },
    processes, locks,
    slots: { used: registry.activeCount(), max: registry.maxConcurrent, running: runs.filter(r => r.running).map(r => String(r.taskId)), queued: runs.filter(r => r.queued).map(r => String(r.taskId)) },
    repository: board?.error ? { error: board.error } : { sync: board.repository?.sync ?? null, execution: board.repository?.execution ?? null, acceptsOperations: board.repository?.health?.acceptsOperations ?? null, unownedDirty: (board.repository?.health?.unownedDirtyFiles || []).slice(0, 10).map(f => safe(f, 160)) },
    git, disk, errLog,
    tools: {
      node: whichOnPath('node', env), npm: whichOnPath('npm', env), git: whichOnPath('git', env),
      claude: claudeResolved, tf: whichOnPath('TF.exe', env), claudeCommand: safe(claudeCommand, 120)
    },
    issues
  };
}
