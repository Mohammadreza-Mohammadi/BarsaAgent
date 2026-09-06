import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { collect, collectJson } from './cli.js';
import { fetchIssues } from './issues.js';
import { ProcessRegistry } from './process-registry.js';

const JSON_TYPE = 'application/json; charset=utf-8';
const MIME = new Map([
  ['.html','text/html; charset=utf-8'], ['.js','text/javascript; charset=utf-8'], ['.css','text/css; charset=utf-8'],
  ['.json','application/json; charset=utf-8'], ['.svg','image/svg+xml'], ['.ico','image/x-icon'], ['.png','image/png'],
  ['.jpg','image/jpeg'], ['.jpeg','image/jpeg'], ['.woff2','font/woff2']
]);

function baseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...extra
  };
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
    if (data.length > 1_000_000) throw Object.assign(new Error('درخواست بیش از حد بزرگ است.'), { status: 413 });
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

export function createApp(config, { registry = new ProcessRegistry(), issueFetcher = fetchIssues } = {}) {
  const repos = new Map(config.repos.map(x => [x.id, x]));
  let issueCache = { at: 0, data: [] };
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

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/repos') {
        return send(res, 200, config.repos.map(({ id, path: repoPath }) => ({
          id,
          path: repoPath,
          manager: config.managerInfo?.[id] || null
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
      if (req.method === 'GET' && (p = route('/api/repos/:repo/running', pathname))) {
        return send(res, 200, registry.list(repoFor(p.repo)));
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/run', pathname))) {
        const repo = repoFor(p.repo);
        const run = registry.start(repo, p.id);
        return run
          ? send(res, 202, { started: true, taskId: p.id, startedAt: run.startedAt })
          : send(res, 409, { error: 'این task هم‌اکنون در حال اجراست.' });
      }
      if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/answer', pathname))) {
        const input = await readBody(req);
        if (!['approve', 'reject', 'clarify'].includes(input.mode)) return send(res, 400, { error: 'mode نامعتبر است.' });
        if (input.mode === 'reject' && !input.reason?.trim()) return send(res, 400, { error: 'دلیل رد الزامی است.' });
        if (input.mode === 'clarify' && !input.text?.trim()) return send(res, 400, { error: 'متن پاسخ الزامی است.' });
        const args = ['answer', p.id, `--${input.mode}`];
        if (input.reason) args.push('--reason', String(input.reason));
        if (input.text) args.push('--text', String(input.text));
        await collect(repoFor(p.repo), args);
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
      if (req.method === 'POST' && pathname === '/api/issues/import') {
        const input = await readBody(req);
        const ids = Array.isArray(input.ids) ? input.ids.map(String) : [];
        if (!ids.length) return send(res, 400, { error: 'حداقل یک issue انتخاب کنید.' });
        const repo = repoFor(input.repo || config.repos[0].id);
        const sourceIssues = await refreshIssues(false);
        const byId = new Map(sourceIssues.map(issue => [String(issue.externalId), issue]));
        const results = [];
        for (const id of ids) {
          const issue = byId.get(id);
          if (!issue) { results.push({ id, ok: false, message: 'issue در آخرین fetch پیدا نشد.' }); continue; }
          const tmp = path.join(os.tmpdir(), `barsa-issue-${process.pid}-${randomUUID()}.json`);
          try {
            fs.writeFileSync(tmp, JSON.stringify(issue), { encoding: 'utf8', mode: 0o600 });
            const output = await collect(repo, ['import-issue', '--file', tmp]);
            let taskId;
            try { taskId = JSON.parse(output.stdout).taskId; } catch { /* manager may be older */ }
            results.push({ id, ok: true, taskId });
          } catch (error) {
            results.push({ id, ok: false, message: error.message || 'import شکست خورد.' });
          } finally {
            fs.rmSync(tmp, { force: true });
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
}
