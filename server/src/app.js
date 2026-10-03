import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { collect, collectJson, validateAgentWork } from './cli.js';
import { fetchIssues } from './issues.js';
import { ProcessRegistry } from './process-registry.js';

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
    const { server, registry } = activeShutdownTarget;
    const active = registry.activeCount();
    if (active > 0 && !shuttingDown) {
      shuttingDown = true;
      console.warn(
        `⚠️  ${active} اجرا در حال انجام است — منتظر پایانش می‌مانم (Ctrl+C دوباره برای خروج فوری و کشتن اجرای در جریان).`
      );
      const interval = setInterval(() => {
        if (registry.activeCount() === 0) {
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
  return { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra };
}
function send(res, status, value, type = JSON_TYPE, extraHeaders = {}) {
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
function validArtifactPath(value) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = String(value).replace(/\\/g, '/');
  return !normalized.split('/').includes('..') && !normalized.includes('\0');
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
  const registry = deps.registry ?? new ProcessRegistry({ maxConcurrent: runConfig.maxConcurrent, maxLines: 2000 });
  const issueFetcher = deps.issueFetcher ?? fetchIssues;
  const spawnEditor = deps.spawnEditor ?? spawn;
  const repos = new Map(config.repos.map(x => [x.id, x]));
  let issueCache = { at: 0, data: [] };
  const healthCache = new Map();
  const root = staticRoot(config);

  const repoFor = id => {
    const repo = repos.get(id);
    if (!repo) throw Object.assign(new Error('مخزن پیدا نشد.'), { status: 404 });
    return repo;
  };
  const boardFor = async repo => {
    const board = await collectJson(repo, ['status', '--json']);
    board.repo = { ...(board.repo || {}), id: repo.id, path: repo.path };
    return board;
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
  const collectAction = async (repo, args) => {
    try {
      return await collect(repo, args);
    } catch (error) {
      if (typeof error.code === 'number') error.status = 422;
      throw error;
    }
  };
  const runReasoned = async (repo, verb, taskId, reason, extraArgs = []) => {
    // متن آزاد هرگز argv نمی‌شود — همان دلیل بند A1.
    const tmp = path.join(os.tmpdir(), `barsa-${verb}-${process.pid}-${randomUUID()}.txt`);
    try {
      fs.writeFileSync(tmp, String(reason), { encoding: 'utf8', mode: 0o600 });
      return await collectAction(repo, [verb, taskId, '--reason-file', tmp, ...extraArgs]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };
  const queueTask = (repo, taskId) => {
    const run = registry.enqueue(repo, taskId);
    return run ? { queued: run.queued, started: !run.queued } : { duplicate: true, queued: false, started: false };
  };
  const createOne = async (draft, startOverride) => {
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

    const tmp = path.join(os.tmpdir(), `barsa-task-${process.pid}-${randomUUID()}.json`);
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 });
      const output = await collectAction(repo, ['import-issue', '--file', tmp]);
      const taskId = parseTaskId(output.stdout);
      const shouldStart = startOverride ?? runConfig.autoStartOnCreate;
      const queue = shouldStart ? queueTask(repo, taskId) : { queued: false, started: false };
      return { ok: true, taskId, repoId: repo.id, slug, ...queue };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/repos') {
        return send(res, 200, config.repos.map(({ id, path: repoPath }) => ({
          id, path: repoPath, manager: config.managerInfo?.[id] || null,
          run: runConfig
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
        const run = registry.enqueue(repo, p.id);
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
          await collectAction(repo, args);
        } finally {
          if (tmp) fs.rmSync(tmp, { force: true });
          if (reasonTmp) fs.rmSync(reasonTmp, { force: true });
          if (releaseNoteTmp) fs.rmSync(releaseNoteTmp, { force: true });
        }
        const resumed = runConfig.autoResumeAfterAnswer ? queueTask(repo, p.id) : { queued: false, started: false };
        return send(res, 200, { ok: true, autoResumed: runConfig.autoResumeAfterAnswer, ...resumed });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/void', pathname))) {
        const input = await readBody(req);
        if (!input.reason?.trim()) return send(res, 400, { error: 'دلیل الزامی است.' });
        await runReasoned(repoFor(p.repo), 'void', p.id, input.reason);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/cancel', pathname))) {
        const input = await readBody(req);
        if (!input.reason?.trim()) return send(res, 400, { error: 'دلیل الزامی است.' });
        await runReasoned(repoFor(p.repo), 'cancel', p.id, input.reason);
        return send(res, 200, { ok: true });
      }
      // دریچه‌ی اضطراری بازیابی — فقط manager.js unlock را صدا می‌زند (هیچ فایل/
      // gitای مستقیم لمس نمی‌شود، طبق همان قاعده‌ی void/cancel بالا). --force
      // فقط وقتی لازم است که transitionLock.alive === null باشد (بخش «بازیابی
      // از داخل ابزار»، بند ۱) — Manager خودش این را رد/قبول می‌کند، UI فقط پاس می‌دهد.
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/unlock', pathname))) {
        const input = await readBody(req);
        if (!input.reason?.trim()) return send(res, 400, { error: 'دلیل الزامی است.' });
        await runReasoned(repoFor(p.repo), 'unlock', p.id, input.reason, input.force ? ['--force'] : []);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/rebase', pathname))) {
        await collectAction(repoFor(p.repo), ['rebase', p.id]);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && (p = route('/api/repos/:repo/tasks/:id/stream', pathname))) {
        const repo = repoFor(p.repo);
        res.writeHead(200, baseHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        }));
        res.write(': connected\n\n');
        const run = registry.get(repo, p.id);
        if (!run) {
          res.write(`data: ${JSON.stringify({ text: 'فرایند فعالی یا سابقهٔ اجرای محلی وجود ندارد.', stream: 'system', at: new Date().toISOString() })}\n\n`);
          res.write(`event: end\ndata: ${JSON.stringify({ code: null })}\n\n`);
          return res.end();
        }
        for (const line of run.lines) res.write(`data: ${JSON.stringify(line)}\n\n`);
        if (run.finished) {
          res.write(`event: end\ndata: ${JSON.stringify({ code: run.exitCode, at: run.finishedAt })}\n\n`);
          return res.end();
        }
        const onLine = line => res.write(`data: ${JSON.stringify(line)}\n\n`);
        const onEnd = payload => { res.write(`event: end\ndata: ${JSON.stringify(payload)}\n\n`); res.end(); };
        run.events.on('line', onLine);
        run.events.once('end', onEnd);
        const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(ping);
          run.events.off('line', onLine);
          run.events.off('end', onEnd);
        });
        return;
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
        const results = [];
        for (let index = 0; index < items.length; index += 1) {
          const draft = items[index];
          const key = draft.source?.externalId != null ? String(draft.source.externalId) : `manual-${index + 1}`;
          try {
            const result = await createOne(draft, input.start == null ? undefined : !!input.start);
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
        const sourceIssues = await refreshIssues(false);
        const byId = new Map(sourceIssues.map(issue => [String(issue.externalId), issue]));
        const results = [];
        for (const id of ids) {
          const issue = byId.get(id);
          if (!issue) { results.push({ id, ok: false, message: 'issue در آخرین fetch پیدا نشد.' }); continue; }
          try {
            const result = await createOne({
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
      console.error('[BarsaAgent][Server]', req.method, req.url, 'failed:', error?.message || error);
      if (error?.stack) console.error(error.stack);
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
  activeShutdownTarget = { server, registry };
  registerShutdownOnce();

  return server;
}
