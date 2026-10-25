// endpointهای سبک و فقط‌خواندنی که CLI ِ `barsa` لازم دارد و دکمه‌های رابط کاربری معادل مستقیم ندارند:
//   GET /api/remote/tasks?filter=…       فهرست کوتاه taskها (از board ِ مشترک، بدون status ِ تازه برای هر درخواست)
//   GET /api/remote/waiting?since=ISO    taskهایی که از آن زمان منتظر انسان شده‌اند (از کش ِ status)
//   GET /api/repos/:repo/tasks/:id/log   انتهای لاگ آخرین اجرای task
// همه پشت همان احراز هویت‌اند (کوکی یا توکن remote) و چیزی نمی‌نویسند. هیچ منطق «مجاز است؟»ی این‌جا نیست.
import fs from 'node:fs';
import { environmentSecrets, redact } from './security.js';

export const FINISHED_STATES = Object.freeze(['integrated', 'cancelled', 'abandoned']);
export const TASK_FILTERS = Object.freeze(['active', 'waiting', 'running', 'blocked', 'all']);
const WAITING_CACHE_MS = 60_000;
const TAIL_MAX = 500;
const TAIL_BYTES = 256 * 1024;

const clip = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** کلیدهای actions که الان چیزی برای نشان دادن دارند (true یا آرایه‌ی غیرخالی) — فقط برای خلاصه. */
export function activeActionKeys(task) {
  const actions = task?.actions;
  if (!actions || typeof actions !== 'object') return [];
  return Object.keys(actions).filter(key => actions[key] === true || (Array.isArray(actions[key]) && actions[key].length > 0));
}

export function summarizeTask(task, run) {
  return {
    id: String(task.id),
    title: clip(task.title ?? task.slug ?? '', 160),
    state: task.state ?? null,
    stateSince: task.stateSince ?? null,
    gate: task.awaitingHuman ? { kind: task.awaitingHuman.kind ?? null, since: task.awaitingHuman.since ?? null } : null,
    blocker: task.blocker ? { kind: task.blocker.kind ?? null, detail: clip(task.blocker.detail ?? task.blocker.reason ?? '', 200) } : null,
    running: run?.running === true,
    queued: run?.queued === true,
    actions: activeActionKeys(task),
    ...(task.error ? { error: clip(task.error, 200) } : {})
  };
}

export function matchesFilter(summary, filter) {
  switch (filter) {
    case 'waiting': return summary.gate !== null;
    case 'running': return summary.running || summary.queued;
    case 'blocked': return summary.state === 'blocked';
    case 'all': return true;
    default: return !FINISHED_STATES.includes(summary.state);
  }
}

function tailLines(file, count) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    let lines = buffer.toString('utf8').split(/\r?\n/);
    if (stat.size > length) lines = lines.slice(1); // خط اول احتمالاً ناقص است
    lines = lines.filter(line => line !== '');
    return { lines: lines.slice(-count), truncated: stat.size > length || lines.length > count };
  } finally { fs.closeSync(fd); }
}

// فایل خروجی هر خط را «<iso> [stream] متن» می‌نویسد (process-registry.js / action-runner.js).
const LINE_PREFIX = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[(?:stdout|stderr|system)\] /;

/** انتهای لاگ آخرین اجرای یک تسک: اول registry ِ زنده، وگرنه فایل خروجی در دفتر ممیزی. همیشه از redactor می‌گذرد. */
export function runLogOf({ registry, audit, repo, taskId, tail }) {
  const secrets = environmentSecrets();
  const live = registry.get(repo, taskId);
  if (live) {
    const lines = live.lines.map(item => redact(item.text, secrets));
    return {
      taskId: String(taskId), runId: live.runId ?? null, running: !live.finished && !!live.startedAt, queued: live.queued === true,
      startedAt: live.startedAt ?? null, finishedAt: live.finishedAt ?? null, exitCode: live.exitCode ?? null,
      truncated: lines.length > tail, lines: lines.slice(-tail)
    };
  }
  const latest = audit.summaries({ action: 'run', repoId: repo.id, taskId, limit: 1 })[0];
  if (!latest) return { taskId: String(taskId), runId: null, running: false, queued: false, startedAt: null, finishedAt: null, exitCode: null, truncated: false, lines: [] };
  let lines = [];
  let truncated = false;
  if (latest.outputFile && fs.existsSync(latest.outputFile)) {
    const result = tailLines(latest.outputFile, tail);
    lines = result.lines.map(line => redact(line.replace(LINE_PREFIX, ''), secrets));
    truncated = result.truncated;
  }
  return {
    taskId: String(taskId), runId: latest.id, running: !latest.phases?.includes('end'), queued: false, startedAt: latest.startedAt ?? null,
    finishedAt: latest.phases?.includes('end') ? latest.at : null, exitCode: latest.exitCode ?? null, truncated, lines
  };
}

export function createRemoteRoutes({ registry, audit, repoFor, config, send, route, boardCached }) {
  const defaultRepo = () => config.repos[0];
  const repoOf = url => repoFor(url.searchParams.get('repo') || defaultRepo().id);

  return async function handle(req, res, url, pathname) {
    let p;
    if (req.method === 'GET' && pathname === '/api/remote/tasks') {
      const repo = repoOf(url);
      const filter = url.searchParams.get('filter') || 'active';
      if (!TASK_FILTERS.includes(filter)) return send(res, 400, { error: `filter باید یکی از ${TASK_FILTERS.join('، ')} باشد.` }), true;
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 30));
      const board = await boardCached(repo, 5_000);
      const runs = new Map(registry.list(repo).map(run => [String(run.taskId), run]));
      const all = (board.tasks || []).map(task => summarizeTask(task, runs.get(String(task.id)))).filter(item => matchesFilter(item, filter));
      all.sort((a, b) => String(b.stateSince ?? '').localeCompare(String(a.stateSince ?? '')));
      return send(res, 200, {
        repo: repo.id, filter, generatedAt: board.generatedAt ?? null, total: all.length, truncated: all.length > limit,
        execution: board.repository?.execution ?? null, tasks: all.slice(0, limit)
      }), true;
    }

    if (req.method === 'GET' && pathname === '/api/remote/waiting') {
      const repo = repoOf(url);
      const since = url.searchParams.get('since');
      const sinceMs = since ? Date.parse(since) : Number.NEGATIVE_INFINITY;
      if (since && Number.isNaN(sinceMs)) return send(res, 400, { error: 'since باید یک زمان ISO معتبر باشد (مثلاً 2026-10-21T08:00:00Z).' }), true;
      // از کش ِ status (تا ۶۰ ثانیه)، نه یک status --json ِ کامل در هر بار. generatedAt را CLI برای دفعه‌ی بعد نگه می‌دارد.
      const board = await boardCached(repo, WAITING_CACHE_MS);
      const tasks = (board.tasks || [])
        .filter(task => task.awaitingHuman && (!task.awaitingHuman.since || Date.parse(task.awaitingHuman.since) >= sinceMs))
        .map(task => summarizeTask(task, undefined));
      return send(res, 200, { repo: repo.id, since: since || null, generatedAt: board.generatedAt ?? null, tasks }), true;
    }

    if ((p = route('/api/repos/:repo/tasks/:id/log', pathname)) && req.method === 'GET') {
      const repo = repoFor(p.repo);
      const tail = Math.min(TAIL_MAX, Math.max(1, Number(url.searchParams.get('tail')) || 40));
      return send(res, 200, runLogOf({ registry, audit, repo, taskId: p.id, tail })), true;
    }
    return false;
  };
}
