import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { collect, collectJson, validateAgentWork } from './cli.js';
import { fetchIssues } from './issues.js';
import { ProcessRegistry } from './process-registry.js';
import { resolveDataDir } from './config.js';
import { AuditLog } from './audit.js';
import { createAuth } from './auth.js';
import { stripLocalEnv } from './agent-env.js';
import { ActionRunner } from './action-runner.js';
import { GitOps } from './git-ops.js';
import { ManagerUpdater } from './manager-update.js';
import { ManagerHelp } from './manager-help.js';
import { idleReason } from './repo-idle.js';
import { createOpsRoutes } from './routes-ops.js';
import { validArtifactPath } from './security.js';

// علت ریشه‌ای «بازیابی از داخل ابزار» بند ۴ — یک شنونده‌ی SIGINT/SIGTERM
// سراسری در سطح ماژول (نه داخل createApp)، چون createApp در تست‌ها بارها در
// همین یک process فراخوانی می‌شود؛ اگر شنونده داخل createApp ثبت می‌شد، هر
// فراخوانی یکی اضافه می‌کرد (نشتِ listener، هشدار MaxListenersExceeded).
// همیشه فقط آخرین سرور/registry ثبت‌شده را می‌بندد.
let activeShutdownTarget = null;
let shutdownListenersRegistered = false;
function registerShutdownOnce() {
  if (shutdownListenersRegistered) return;
  shutdownListenersRegistered = true;
  let shuttingDown = false;
  const shutdown = signal => {
    if (!activeShutdownTarget) return;
    const { server, registry, runner } = activeShutdownTarget;
    const active = registry.activeCount() + (runner?.activeCount() ?? 0);
    if (active > 0 && !shuttingDown) {
      shuttingDown = true;
      console.warn(
        `⚠️  ${active} اجرا در حال انجام است — منتظر پایانش می‌مانم (Ctrl+C دوباره برای خروج فوری و کشتن اجرای در جریان).`
      );
      const interval = setInterval(() => {
        if (registry.activeCount() + (runner?.activeCount() ?? 0) === 0) {
          clearInterval(interval);
          server.close(() => process.exit(0));
        }
      }, 500);
      process.once(signal, () => {
        clearInterval(interval);
        console.warn('⚠️  خروج فوری — اجرای در جریان manager.js کشته می‌شود (احتمال قفل جامانده).');
        process.exit(1);
      });
      return;
    }
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

const JSON_TYPE = 'application/json; charset=utf-8';
const MIME = new Map([
  ['.html','text/html; charset=utf-8'], ['.js','text/javascript; charset=utf-8'], ['.css','text/css; charset=utf-8'],
  ['.json','application/json; charset=utf-8'], ['.svg','image/svg+xml'], ['.ico','image/x-icon'], ['.png','image/png'],
  ['.jpg','image/jpeg'], ['.jpeg','image/jpeg'], ['.woff2','font/woff2']
]);

function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    // کانبان ابزار اجراست؛ داخل iframe سایت دیگر (clickjacking) نباید باز شود.
    'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'",
    ...extra
  };
}
function send(res, status, value, type = JSON_TYPE, extraHeaders = {}) {
  // برای ممیزی مرکزی درخواست‌های ردشده (finish handler در createApp)
  if (status >= 400 && value && typeof value === 'object' && value.error) res.errorMessage = value.error;
  const body = type.startsWith('application/json') ? JSON.stringify(value) : String(value);
  res.writeHead(status, baseHeaders({ 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extraHeaders }));
  res.end(body);
}
async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 2_000_000) throw Object.assign(new Error('درخواست بیش از حد بزرگ است.'), { status: 413 });
  }
  if (!data) return {};
  try { return JSON.parse(data); }
  catch { throw Object.assign(new Error('بدنهٔ JSON معتبر نیست.'), { status: 400 }); }
}
function route(pattern, pathname) {
  const a = pattern.split('/'); const b = pathname.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}
function staticRoot(config) {
  const candidates = [
    config.server?.staticDir && path.resolve(config.server.staticDir),
    path.resolve('dist/client/browser'),
    path.resolve('dist/client')
  ].filter(Boolean);
  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'index.html'))) || null;
}
function serveStatic(req, res, root, pathname) {
  if (!root || req.method !== 'GET') return false;
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
  let file = target;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) file = path.join(root, 'index.html');
  if (!fs.existsSync(file)) return false;
  const type = MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
  const data = fs.readFileSync(file);
  res.writeHead(200, baseHeaders({
    'Content-Type': type,
    'Content-Length': data.length,
    'Cache-Control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable'
  }));
  res.end(data);
  return true;
}
function slugify(value, fallback = 'task') {
  const slug = String(value || '').normalize('NFKC').toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug || fallback;
}
function parseTaskId(stdout) {
  // strict: بازبینی فاز ۲ — یک fallback با regex یعنی قراردادی که شکستنِ خودش
  // را تحمل می‌کند، و دیگر کسی متوجه شکستنش نمی‌شود. اگر manager.js روی
  // import-issue خروجی JSON معتبر ندهد، خطای صریح بده، حدس نزن.
  const text = String(stdout || '').trim();
  if (!text) throw Object.assign(new Error('manager.js import-issue خروجی خالی داد — انتظار JSON با taskId بود.'), { status: 502 });
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`manager.js import-issue خروجی JSON معتبر نداد: ${text.slice(0, 300)}`), { status: 502 });
  }
  if (payload?.taskId == null) {
    throw Object.assign(new Error('manager.js import-issue پاسخ JSON داد ولی فیلد taskId ندارد.'), { status: 502 });
  }
  return String(payload.taskId);
}

export function createApp(config, deps = {}) {
  const runConfig = {
    maxConcurrent: Math.max(1, Number(config.run?.maxConcurrent ?? 2)),
    autoStartOnCreate: config.run?.autoStartOnCreate !== false,
    autoResumeAfterAnswer: config.run?.autoResumeAfterAnswer !== false
  };
  // آرشیو: ستون «تمام»ِ برد فقط taskهای پایان‌یافته در این چند روز اخیر را نشان می‌دهد.
  const doneDaysRaw = Number(config.board?.doneDays);
  const boardConfig = { doneDays: Number.isFinite(doneDaysRaw) && doneDaysRaw > 0 ? doneDaysRaw : 3 };
  // کانبان فاز ۱: داده‌ها بیرون از مخزن‌ها (دفتر ممیزی، خروجی اجراها، کاربران).
  const dataDir = deps.dataDir ?? resolveDataDir(config);
  const audit = deps.audit ?? new AuditLog({ dir: dataDir });
  const auth = deps.auth ?? createAuth(config, dataDir);
  const stopGraceMs = Number(config.run?.stopGraceMs ?? 5000);
  const registry = deps.registry ?? new ProcessRegistry({ maxConcurrent: runConfig.maxConcurrent, maxLines: 2000, config, audit, graceMs: stopGraceMs });
  const runner = deps.runner ?? new ActionRunner({ audit, graceMs: stopGraceMs });
  const help = deps.help ?? new ManagerHelp();
  const issueFetcher = deps.issueFetcher ?? fetchIssues;
  const spawnEditor = deps.spawnEditor ?? spawn;
  const repos = new Map(config.repos.map(x => [x.id, x]));
  let issueCache = { at: 0, data: [] };
  const healthCache = new Map();
  const root = staticRoot(config);
  const readStatus = repo => collectJson(repo, ['status', '--json']);
  const idleCheck = repo => idleReason(repo, { registry, readStatus });
  const gitOps = deps.gitOps ?? new GitOps({ runner, audit, registry, dataDir, config, idleCheck, powershell: deps.powershell });
  // وضعیت sync از status ِ Manager (repository.sync)، نه از git ِ خود کانبان؛ با board مشترک (یک اجرای در جریان).
  const updater = deps.updater ?? new ManagerUpdater({ runner, audit, registry, help, config, readStatus: repo => boardFor(repo), inspect: deps.inspectManager });

  const repoFor = id => {
    const repo = repos.get(id);
    if (!repo) throw Object.assign(new Error('مخزن پیدا نشد.'), { status: 404 });
    return repo;
  };
  // status --json در اولین اجرا (cache سرد Manager) حدود ۱۵ ثانیه طول می‌کشد. تا تمام نشده هر درخواست
  // دیگر (poll ِ تب دیگر، /api/issues) همان اجرا را می‌گیرد، نه یک فرآیند Manager تازه.
  const boardInflight = new Map();
  const lastBoard = new Map();
  const boardFor = repo => {
    const running = boardInflight.get(repo.id);
    if (running) return running;
    const promise = (async () => {
      const board = await collectJson(repo, ['status', '--json']);
      board.repo = { ...(board.repo || {}), id: repo.id, path: repo.path };
      lastBoard.set(repo.id, { at: Date.now(), board });
      return board;
    })().finally(() => boardInflight.delete(repo.id));
    boardInflight.set(repo.id, promise);
    return promise;
  };
  // قفل اجرا (TOOLING-040، repository.execution): با enabled=false هر مسیر کانبان که task می‌سازد یا اجرا می‌کند
  // پیش از هر کاری با پیام خود Manager رد می‌شود (Manager هم همین‌ها را با exit 41 رد می‌کند؛ این فقط زودتر و بدون
  // صف/فایل ناقص است). نخواندنِ status (خطا) هرگز مانع نیست: تصمیم نهایی با خود Manager است.
  const executionOf = async repo => {
    const cached = lastBoard.get(repo.id);
    let board = cached && Date.now() - cached.at < 5_000 ? cached.board : null;
    if (!board) {
      try { board = await boardFor(repo); } catch { return null; }
    }
    return board?.repository?.execution ?? null;
  };
  const assertExecution = async repo => {
    const execution = await executionOf(repo);
    if (execution?.enabled === false) {
      throw Object.assign(new Error(execution.reason || 'اجرای تسک روی این دستگاه خاموش است (execution.enabled=false).'), { status: 409 });
    }
  };
  const refreshIssues = async force => {
    if (force || Date.now() - issueCache.at > 15_000) {
      issueCache = { at: Date.now(), data: await issueFetcher(config.issueSource) };
    }
    return issueCache.data;
  };
  // manager.js وقتی صریح رد می‌کند (exit code غیرصفر روی answer/void/cancel/
  // rebase/import-issue) این یک شکست کسب‌وکاری است («اثبات merge پاس نشد»،
  // «externalId تکراری»، ...)، نه خرابی سرور — بازبینی فاز ۲. بدون این، همه‌ی
  // این‌ها به 500 عمومی می‌افتند و UI فرقی بین «Manager رد کرد» و «سرور شکست»
  // نمی‌بیند. پیام خام (stdout/stderr واقعی manager.js) دست‌نخورده می‌ماند.
  //
  // کانبان فاز ۱: هر اکشن از runner می‌گذرد (فقط node + manager.js با آرایه‌ی
  // آرگومان) تا دفتر ممیزی رکورد start/end و فایل خروجی کامل داشته باشد.
  const collectAction = async (session, repo, args, meta = {}) => {
    const script = path.resolve(repo.path, repo.managerScript);
    const exec = runner.start({
      user: session.user, action: meta.action || String(args[0]), repoId: repo.id, taskId: meta.taskId ?? null,
      program: process.execPath, args: [script, ...args.map(String)], cwd: repo.path,
      env: stripLocalEnv(config, { ...process.env })
    });
    const { code } = await exec.done;
    const part = stream => exec.lines.filter(line => line.stream === stream).map(line => line.text).join('\n');
    const stdout = part('stdout');
    const stderr = part('stderr');
    if (code === 0) return { stdout, stderr, code: 0 };
    throw Object.assign(new Error(stderr.trim() || stdout.trim() || `فرآیند با کد ${code} متوقف شد`), { code, stdout, stderr, status: 422, audited: true });
  };
  const runReasoned = async (session, repo, verb, taskId, reason, extraArgs = []) => {
    // متن آزاد هرگز argv نمی‌شود — همان دلیل بند A1.
    const tmp = path.join(os.tmpdir(), `barsa-${verb}-${process.pid}-${randomUUID()}.txt`);
    try {
      fs.writeFileSync(tmp, String(reason), { encoding: 'utf8', mode: 0o600 });
      return await collectAction(session, repo, [verb, taskId, '--reason-file', tmp, ...extraArgs], { action: verb, taskId });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  const queueTask = (session, repo, taskId) => {
    const run = registry.enqueue(repo, taskId, { user: session.user });
    return run ? { queued: run.queued, started: !run.queued } : { duplicate: true, queued: false, started: false };
  };
  const createOne = async (session, draft, startOverride) => {
    const repo = repoFor(draft.repo || config.repos[0].id);
    const type = draft.type === 'spike' ? 'spike' : 'task';
    const requestText = String(draft.requestText || '');
    const slug = slugify(draft.slug, draft.source?.externalId ? `task-${draft.source.externalId}` : 'manual-task');
    if (!requestText.trim()) throw Object.assign(new Error('متن request الزامی است.'), { status: 400 });
    if (!slug.trim()) throw Object.assign(new Error('slug الزامی است.'), { status: 400 });

    const payload = { repo: repo.id, type, slug, requestText };
    if (draft.source?.externalId != null && String(draft.source.externalId).trim()) {
      payload.source = {
        system: draft.source.system || 'internal',
        externalId: String(draft.source.externalId),
        url: draft.source.url || '',
        fetchedAt: draft.source.fetchedAt || new Date().toISOString()
      };
    }

    const importArgs = ['import-issue', '--file'];
    // بند ب: دسترسی بیرونی هنگام ساخت (فرم import-issue). فقط یک منبع، همان قالب
    // <sourceId>=read|write که manager.js می‌سنجد؛ اینجا فقط شکل را رد می‌کنیم.
    const access = Array.isArray(draft.externalAccess) ? draft.externalAccess.filter(x => x && x.sourceId) : [];
    if (access.length > 1) throw Object.assign(new Error('import-issue فقط یک --external-access می‌پذیرد.'), { status: 400 });
    for (const entry of access) {
      if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(entry.sourceId)) || !['read', 'write'].includes(entry.access)) {
        throw Object.assign(new Error('external-access باید <sourceId> و read|write باشد.'), { status: 400 });
      }
    }
    const tmp = path.join(os.tmpdir(), `barsa-task-${process.pid}-${randomUUID()}.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      importArgs.push(tmp);
      for (const entry of access) importArgs.push('--external-access', `${entry.sourceId}=${entry.access}`);
      const output = await collectAction(session, repo, importArgs, { action: 'import-issue' });
      const taskId = parseTaskId(output.stdout);
      const shouldStart = startOverride ?? runConfig.autoStartOnCreate;
      const queue = shouldStart ? queueTask(session, repo, taskId) : { queued: false, started: false };
      return { ok: true, taskId, repoId: repo.id, slug, ...queue };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };

  // SSE مشترک برای اجرای task (registry) و اجرای کنسول/git/update (runner):
  // هر دو lines/events/finished/exitCode/finishedAt دارند.
  const pipeStream = (req, res, source) => {
    res.writeHead(200, baseHeaders({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    }));
    res.write(': connected\n\n');
    const endPayload = () => ({ code: source.exitCode, at: source.finishedAt, ...(source.stopped ? { stopped: true } : {}) });
    for (const line of source.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
    if (source.finished) {
      res.write(`event: end\ndata: ${JSON.stringify(endPayload())}\n\n`);
      return res.end();
    }
    const onLine = line => res.write(`data: ${JSON.stringify(line)}\n\n`);
    const onEnd = payload => { res.write(`event: end\ndata: ${JSON.stringify(payload)}\n\n`); res.end(); };
    source.events.on('line', onLine);
    source.events.once('end', onEnd);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(ping);
      source.events.off('line', onLine);
      source.events.off('end', onEnd);
    });
  };

  const opsRoutes = createOpsRoutes({
    audit, runner, registry, help, gitOps, updater, config, dataDir, route, send, readBody, repoFor,
    managerAudited: collectAction, pipeStream, users: auth.users, assertExecution
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const mutating = req.method !== 'GET' && req.method !== 'HEAD';
    let session = null;
    // ممیزی مرکزی: هر درخواست تغییردهنده‌ای که رد شد (اعتبارسنجی، 401/403، پیش‌شرط)
    // و هنوز جای دیگری ثبت نشده، یک رکورد rejected می‌گیرد.
    res.on('finish', () => {
      if (!mutating || res.statusCode < 400 || res.audited) return;
      try {
        audit.reject({ user: session?.user ?? null, action: `http ${req.method} ${pathname}`, status: res.statusCode, ip: req.socket.remoteAddress }, res.errorMessage || `HTTP ${res.statusCode}`);
      } catch { /* ممیزی نباید پاسخ را بشکند */ }
    });
    try {
      // --- احراز هویت: هر چیزی زیر /api/ جز ورود/وضعیت نشست پشت نشست است ---------------
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/auth/session' && req.method === 'GET') {
          const current = auth.session(req);
          return send(res, 200, current ? { authenticated: true, user: current.user, csrf: current.csrf } : { authenticated: false });
        }
        if (pathname === '/api/auth/login' && req.method === 'POST') {
          const originProblem = auth.checkOrigin(req);
          if (originProblem) return send(res, 403, { error: originProblem });
          if (!/^application\/json/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'Content-Type باید application/json باشد.' });
          const input = await readBody(req);
          const result = await auth.login(input.username, input.password, req.socket.remoteAddress);
          if (!result.ok) {
            audit.reject({ user: String(input.username ?? '').slice(0, 64), action: 'auth.login', ip: req.socket.remoteAddress }, result.error);
            res.audited = true;
            return send(res, result.status, { error: result.error });
          }
          audit.note({ user: input.username, action: 'auth.login', ip: req.socket.remoteAddress });
          return send(res, 200, { authenticated: true, user: result.session.user, csrf: result.session.csrf }, JSON_TYPE, { 'Set-Cookie': auth.cookie(result.token) });
        }
        session = auth.session(req);
        if (!session) return send(res, 401, { error: 'ورود لازم است.' });
        if (mutating) {
          const problem = auth.checkCsrf(req, session);
          if (problem) return send(res, 403, { error: problem });
        }
        if (pathname === '/api/auth/logout' && req.method === 'POST') {
          auth.logout(auth.tokenOf(req));
          audit.note({ user: session.user, action: 'auth.logout' });
          return send(res, 200, { ok: true }, JSON_TYPE, { 'Set-Cookie': auth.clearCookie() });
        }
        if (await opsRoutes(req, res, url, pathname, session)) return;
      }
      if (req.method === 'GET' && pathname === '/api/repos') {
        return send(res, 200, config.repos.map(({ id, path: repoPath }) => ({
          id, path: repoPath, manager: config.managerInfo?.[id] || null,
          run: runConfig, board: boardConfig
        })));
      }

      let p;
      if (req.method === 'GET' && (p = route('/api/repos/:repo/board', pathname))) {
        return send(res, 200, await boardFor(repoFor(p.repo)));
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/tasks/:id', pathname))) {
        const repo = repoFor(p.repo);
        const board = await collectJson(repo, ['status', '--json', '--task', p.id]);
        const task = board.tasks?.[0];
        if (!task) return send(res, 404, { error: 'task پیدا نشد.' });
        return send(res, 200, task);
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/tasks/:id/events', pathname))) {
        return send(res, 200, await collectJson(repoFor(p.repo), ['events', p.id, '--json']));
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/tasks/:id/artifact', pathname))) {
        const artifact = url.searchParams.get('path');
        if (!validArtifactPath(artifact)) return send(res, 400, { error: 'مسیر artifact نامعتبر است.' });
        const result = await collect(repoFor(p.repo), ['artifact', p.id, '--path', artifact]);
        return send(res, 200, result.stdout, 'text/plain; charset=utf-8');
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/open-editor', pathname))) {
        const repo = repoFor(p.repo);
        // وضعیت باید در لحظهٔ کلیک از Manager خوانده شود؛ board سه‌ثانیه‌ای ممکن است
        // به worktree حذف‌شده اشاره کند و UI نیز حق بازسازی مسیر را ندارد.
        const status = await collectJson(repo, ['status', '--json', '--task', p.id]);
        const task = status.tasks?.[0];
        if (!task) return send(res, 404, { error: 'task پیدا نشد.' });
        const worktreeRawPath = task.worktree?.path ? String(task.worktree.path) : '';
        if (task.worktree?.status !== 'active' || !worktreeRawPath) {
          return send(res, 409, { error: 'worktree این task زنده نیست.', worktreePath: worktreeRawPath || null });
        }
        // manager.js مسیر worktree را نسبت به ریشهٔ repo (worktreeRelPath) در manifest می‌نویسد،
        // نه نسبت به cwd این سرور — باید نسبت به repo.path resolve شود.
        const worktreePath = path.isAbsolute(worktreeRawPath) ? worktreeRawPath : path.resolve(repo.path, worktreeRawPath);
        if (!fs.existsSync(worktreePath)) {
          return send(res, 409, { error: `مسیر worktree پیدا نشد: ${worktreePath}`, worktreePath });
        }
        const editorCommand = String(config.editor?.command || '').trim();
        if (!editorCommand) {
          return send(res, 409, { error: `editor.command تنظیم نشده است. مسیر worktree: ${worktreePath}`, worktreePath });
        }
        try {
          const child = spawnEditor(editorCommand, [worktreePath], {
            detached: true, stdio: 'ignore', shell: false, windowsHide: true
          });
          await new Promise((resolve, reject) => {
            child.once('spawn', resolve);
            child.once('error', reject);
          });
          child.unref();
        } catch (error) {
          return send(res, 500, {
            error: `باز کردن editor شکست خورد: ${error?.message || String(error)}. مسیر worktree: ${worktreePath}`,
            worktreePath
          });
        }
        return send(res, 200, { ok: true, worktreePath });
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/running', pathname))) {
        return send(res, 200, registry.list(repoFor(p.repo)));
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/run', pathname))) {
        const repo = repoFor(p.repo);
        await assertExecution(repo);
        const run = registry.enqueue(repo, p.id, { user: session.user });
        if (!run) return send(res, 409, { error: 'این task هم‌اکنون در حال اجرا یا در صف است.' });
        const current = registry.list(repo).find(x => x.taskId === String(p.id));
        return send(res, 202, {
          accepted: true,
          taskId: p.id,
          queued: current?.queued === true,
          queuePosition: current?.queuePosition ?? null,
          startedAt: current?.startedAt ?? null
        });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/answer', pathname))) {
        const input = await readBody(req);
        if (!['approve', 'reject', 'clarify'].includes(input.mode)) return send(res, 400, { error: 'mode نامعتبر است.' });
        if (input.mode === 'reject' && !input.reason?.trim()) return send(res, 400, { error: 'دلیل رد الزامی است.' });
        if (input.mode === 'clarify' && !input.text?.trim()) return send(res, 400, { error: 'متن پاسخ الزامی است.' });
        if (input.route && !['implementer', 'architect'].includes(input.route)) return send(res, 400, { error: 'route نامعتبر است.' });
        // answer --clarify --external-access <sourceId>=read|write (اختیاری؛ فقط کنار clarify). «مجاز است؟» با Manager
        // (actions.externalAccess غیرخالی) و رد/قبول با خود فرمان؛ این‌جا فقط شکل.
        let externalAccessArg = null;
        if (input.externalAccess) {
          const { sourceId, access } = input.externalAccess;
          if (input.mode !== 'clarify') return send(res, 400, { error: 'external-access فقط کنار clarify معنا دارد.' });
          if (!/^[a-z0-9][a-z0-9-]*$/i.test(String(sourceId || '')) || !['read', 'write'].includes(access)) return send(res, 400, { error: 'external-access باید <sourceId> و read|write باشد.' });
          externalAccessArg = `${sourceId}=${access}`;
        }
        // release-note-at-merge.md، بند ه: همان دو مسیر answer سمت manager.js
        // (--release-note-file / --no-release-note) — هیچ endpoint تازه.
        if (input.releaseNoteText && input.noReleaseNote) return send(res, 400, { error: 'releaseNoteText و noReleaseNote با هم معنا ندارند.' });
        if (input.noReleaseNote && !input.reason?.trim()) return send(res, 400, { error: 'برای "برای کاربر دیده نمی‌شود"، دلیل الزامی است.' });

        const repo = repoFor(p.repo);
        const args = ['answer', p.id, `--${input.mode}`];
        let tmp = null;
        let reasonTmp = null;
        let releaseNoteTmp = null;
        try {
          if (input.mode === 'clarify') {
            tmp = path.join(os.tmpdir(), `barsa-clarification-${process.pid}-${randomUUID()}.txt`);
            fs.writeFileSync(tmp, String(input.text), { encoding: 'utf8', mode: 0o600 });
            args.push('--file', tmp);
            if (input.respec) args.push('--respec');
            if (externalAccessArg) args.push('--external-access', externalAccessArg);
          }
          if (input.reason) {
            // متن آزاد هرگز argv نمی‌شود — کنسول ویندوز فارسی را به ??? می‌شکند.
            reasonTmp = path.join(os.tmpdir(), `barsa-reason-${process.pid}-${randomUUID()}.txt`);
            fs.writeFileSync(reasonTmp, String(input.reason), { encoding: 'utf8', mode: 0o600 });
            args.push('--reason-file', reasonTmp);
          }
          if (input.route) args.push('--route', String(input.route));
          if (input.releaseNoteText) {
            releaseNoteTmp = path.join(os.tmpdir(), `barsa-release-note-${process.pid}-${randomUUID()}.md`);
            fs.writeFileSync(releaseNoteTmp, String(input.releaseNoteText), { encoding: 'utf8', mode: 0o600 });
            args.push('--release-note-file', releaseNoteTmp);
          }
          if (input.noReleaseNote) args.push('--no-release-note');
          await collectAction(session, repo, args, { action: 'answer', taskId: p.id });
        } finally {
          if (tmp) fs.rmSync(tmp, { force: true });
          if (reasonTmp) fs.rmSync(reasonTmp, { force: true });
          if (releaseNoteTmp) fs.rmSync(releaseNoteTmp, { force: true });
        }
        const resumed = runConfig.autoResumeAfterAnswer ? queueTask(session, repo, p.id) : { queued: false, started: false };
        return send(res, 200, { ok: true, autoResumed: runConfig.autoResumeAfterAnswer, ...resumed });
      }
      // الحاقیه‌ی ۱، بند ب: --stage-external واقعاً فایل‌های WebIII را عوض
      // می‌کند (merge روی مخزن سایه). کانبان هیچ شرطی برای نمایش/رد این دکمه
      // نمی‌سازد — فقط actions.canStageExternal از status --json (TOOLING-032)
      // را نشان می‌دهد؛ تصمیم همیشه مال همان چیزی است که answer خودش می‌سنجد.
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/stage-external', pathname))) {
        const input = await readBody(req);
        const sourceId = String(input.sourceId || '').trim();
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(sourceId)) return send(res, 400, { error: 'شناسه‌ی منبع بیرونی نامعتبر است.' });
        await collectAction(session, repoFor(p.repo), ['answer', p.id, '--stage-external', sourceId], { action: 'stage-external', taskId: p.id });
        return send(res, 200, { ok: true });
      }
      // TOOLING-023 (manager.js، بند «ز-۴»): --external-checked-in گیت‌محور
      // نیست، فقط state="awaiting-external-checkin" را می‌خواهد؛ شماره‌ی ثبت
      // اختیاری است. فرمت "C<عدد>" قرارداد خودِ BarsaAgent است (manager.js
      // خودش فرمتش را نمی‌سنجد)، برای همین اینجا سمت سرور هم دوباره اعتبارسنجی
      // می‌شود، نه فقط سمت کلاینت.
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/external-checked-in', pathname))) {
        const input = await readBody(req);
        const sourceId = String(input.sourceId || '').trim();
        if (!/^[a-z0-9][a-z0-9-]*$/i.test(sourceId)) return send(res, 400, { error: 'شناسه‌ی منبع بیرونی نامعتبر است.' });
        const rawChangesets = Array.isArray(input.changesets) ? input.changesets : [];
        const changesets = [];
        for (const raw of rawChangesets) {
          const value = String(raw || '').trim();
          if (!value) continue;
          const normalized = /^\d+$/.test(value) ? `C${value}` : value;
          if (!/^C\d+$/i.test(normalized)) return send(res, 400, { error: `شماره‌ی ثبت نامعتبر است: "${raw}" — باید به شکل حرف C و بعد عدد باشد.` });
          changesets.push(normalized);
        }
        const args = ['answer', p.id, '--external-checked-in', sourceId];
        if (changesets.length) args.push('--changeset', changesets.join(','));
        await collectAction(session, repoFor(p.repo), args, { action: 'external-checked-in', taskId: p.id });
        return send(res, 200, { ok: true });
      }
      // state-محور است، نه awaitingHuman (manager.js، parseAnswerArgs/--note) —
      // در هر state غیرپایانی (برای یادداشت) قابل ارسال است. متن همیشه از فایل
      // موقت UTF-8 می‌رود، هرگز argv خام (همان دلیل --reason-file بالا).
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/note', pathname))) {
        const input = await readBody(req);
        if (!input.text?.trim()) return send(res, 400, { error: 'متن یادداشت الزامی است.' });
        const repo = repoFor(p.repo);
        const tmp = path.join(os.tmpdir(), `barsa-note-${process.pid}-${randomUUID()}.txt`);
        try {
          fs.writeFileSync(tmp, String(input.text), { encoding: 'utf8', mode: 0o600 });
          await collectAction(session, repo, ['answer', p.id, '--note', '--file', tmp], { action: 'note', taskId: p.id });
        } finally {
          fs.rmSync(tmp, { force: true });
        }
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/void', pathname))) {
        const input = await readBody(req);
        if (!input.reason?.trim()) return send(res, 400, { error: 'دلیل الزامی است.' });
        await runReasoned(session, repoFor(p.repo), 'void', p.id, input.reason);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/cancel', pathname))) {
        const input = await readBody(req);
        if (!input.reason?.trim()) return send(res, 400, { error: 'دلیل الزامی است.' });
        await runReasoned(session, repoFor(p.repo), 'cancel', p.id, input.reason);
        return send(res, 200, { ok: true });
      }
      // دریچه‌ی اضطراری بازیابی — فقط manager.js unlock را صدا می‌زند (هیچ فایل/
      // gitای مستقیم لمس نمی‌شود، طبق همان قاعده‌ی void/cancel بالا). --force
      // فقط وقتی لازم است که transitionLock.alive === null باشد (بخش «بازیابی
      // از داخل ابزار»، بند ۱) — Manager خودش این را رد/قبول می‌کند، UI فقط پاس می‌دهد.
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/unlock', pathname))) {
        const input = await readBody(req);
        if (!input.reason?.trim()) return send(res, 400, { error: 'دلیل الزامی است.' });
        await runReasoned(session, repoFor(p.repo), 'unlock', p.id, input.reason, input.force ? ['--force'] : []);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/rebase', pathname))) {
        await collectAction(session, repoFor(p.repo), ['rebase', p.id], { action: 'rebase', taskId: p.id });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/tasks/:id/stream', pathname))) {
        const repo = repoFor(p.repo);
        const run = registry.get(repo, p.id);
        if (!run) {
          res.writeHead(200, baseHeaders({
            'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'
          }));
          res.write(': connected\n\n');
          res.write(`data: ${JSON.stringify({ text: 'فرایند فعالی یا سابقهٔ اجرای محلی وجود ندارد.', stream: 'system', at: new Date().toISOString() })}\n\n`);
          res.write(`event: end\ndata: ${JSON.stringify({ code: null })}\n\n`);
          return res.end();
        }
        return pipeStream(req, res, run);
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/health', pathname))) {
        const repo = repoFor(p.repo);
        const cached = healthCache.get(repo.id);
        if (cached && Date.now() - cached.at < 20_000 && url.searchParams.get('refresh') !== '1') return send(res, 200, cached.value);
        let value;
        try {
          const result = await validateAgentWork(repo);
          value = { ok: true, checkedAt: new Date().toISOString(), code: 0, output: [result.stdout, result.stderr].filter(Boolean).join('\n').trim() };
        } catch (error) {
          value = { ok: false, checkedAt: new Date().toISOString(), code: error.code ?? 1, output: [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim() };
        }
        healthCache.set(repo.id, { at: Date.now(), value });
        return send(res, 200, value);
      }

      if (req.method === 'GET' && pathname === '/api/issues') {
        const issues = await refreshIssues(url.searchParams.get('refresh') === '1');
        const boards = await Promise.all(config.repos.map(async repo => {
          try { return { repo: repo.id, board: await boardFor(repo) }; }
          catch { return { repo: repo.id, board: { tasks: [] } }; }
        }));
        const imported = new Map();
        for (const { repo, board } of boards) {
          for (const task of board.tasks || []) {
            if (task.source?.externalId != null) imported.set(String(task.source.externalId), { taskId: task.id, repoId: repo });
          }
        }
        return send(res, 200, issues.map(issue => {
          const match = imported.get(String(issue.externalId));
          return { ...issue, importedTaskId: match?.taskId, importedRepoId: match?.repoId };
        }));
      }

      if (req.method === 'POST' && pathname === '/api/tasks/create') {
        const input = await readBody(req);
        const items = Array.isArray(input.items) ? input.items : [];
        if (!items.length) return send(res, 400, { error: 'حداقل یک draft برای ساخت لازم است.' });
        for (const repoId of new Set(items.map(item => item?.repo || config.repos[0].id))) await assertExecution(repoFor(repoId));
        const results = [];
        for (let index = 0; index < items.length; index += 1) {
          const draft = items[index];
          const key = draft.source?.externalId != null ? String(draft.source.externalId) : `manual-${index + 1}`;
          try {
            const result = await createOne(session, draft, input.start == null ? undefined : !!input.start);
            results.push({ key, ...result });
          } catch (error) {
            results.push({ key, ok: false, message: error.message || 'ساخت task شکست خورد.' });
          }
        }
        const succeeded = results.filter(x => x.ok).length;
        return send(res, succeeded === results.length ? 200 : 207, { succeeded, failed: results.length - succeeded, results });
      }

      // سازگاری با نسخهٔ قبلی UI؛ مسیر جدید /api/tasks/create است.
      if (req.method === 'POST' && pathname === '/api/issues/import') {
        const input = await readBody(req);
        const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
        if (!ids.length) return send(res, 400, { error: 'حداقل یک issue انتخاب کنید.' });
        await assertExecution(repoFor(input.repo || config.repos[0].id));
        const sourceIssues = await refreshIssues(false);
        const byId = new Map(sourceIssues.map(issue => [String(issue.externalId), issue]));
        const results = [];
        for (const id of ids) {
          const issue = byId.get(id);
          if (!issue) { results.push({ id, ok: false, message: 'issue در آخرین fetch پیدا نشد.' }); continue; }
          try {
            const result = await createOne(session, {
              repo: input.repo || config.repos[0].id,
              type: 'task',
              slug: slugify(issue.title, `task-${id}`),
              requestText: [issue.title, issue.body].filter(Boolean).join('\n\n'),
              source: { system: issue.system || 'internal', externalId: issue.externalId, url: issue.url || '', fetchedAt: issue.fetchedAt }
            });
            results.push({ id, ...result });
          } catch (error) {
            results.push({ id, ok: false, message: error.message || 'import شکست خورد.' });
          }
        }
        return send(res, 207, { results });
      }

      if (pathname.startsWith('/api/')) return send(res, 404, { error: 'مسیر API پیدا نشد.' });
      if (serveStatic(req, res, root, pathname)) return;
      return send(res, 404, { error: 'UI build پیدا نشد. ابتدا npm run build را اجرا کنید.' });
    } catch (error) {
      if (error?.audited) res.audited = true;
      // رد شدن به‌خاطر ورودی/پیش‌شرط (4xx) خطای سرور نیست: یک خط، بدون stack.
      if ((error.status || 500) >= 500) {
        console.error('[BarsaAgent][Server]', req.method, req.url, 'failed:', error?.message || error);
        if (error?.stack) console.error(error.stack);
      } else {
        console.warn('[BarsaAgent][Server]', req.method, pathname, '→', error.status || 500, error?.message || error);
      }
      return send(res, error.status || 500, { error: error.message || 'خطای داخلی' });
    }
  });

  // علت ریشه‌ای «بازیابی از داخل ابزار» بند ۴ (گزینه‌ی «ب» — حداقلِ قابل‌قبول،
  // نه detach کامل): بستن/ری‌استارت این سرور بدون این هشدار، فرزندِ در جریانِ
  // manager.js (اگر task ای همین الان run می‌شود) را وسط یک transition می‌کشد —
  // دقیقاً همان چیزی که باعث شد یک قفل جامانده بدون هیچ رد پایی در events.jsonl
  // بماند (رفع شد در manager.js#reclaimStaleTransitionLock: run.abandoned).
  // این کاملاً علامت را حل نمی‌کند (force-kill/کرش هنوز خطرناک است) ولی مسیر
  // عادی close/restart را ایمن می‌کند: اگر اجرایی در جریان است صبر می‌کند، نه
  // این‌که بی‌سروصدا بکشدش.
  activeShutdownTarget = { server, registry, runner };
  registerShutdownOnce();

  return server;
}
