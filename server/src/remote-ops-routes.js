// endpointهای «عملیات از راه دور» برای CLI ِ `barsa` — هر کدام یک کار **نام‌دار** و بسته (نه شل):
//   خواندنی:  GET  /api/remote/tasks/:id/artifact · GET /api/remote/tasks/:id/diag · GET /api/remote/diag/system · GET /api/remote/execs/:id
//   نوشتنی:   POST /api/remote/tasks/:id/{bundle,recover,retry-install,kill-stuck-install} · POST /api/remote/sync
// همه در REMOTE_ENDPOINTS (remote-cli-spec.js) هستند و هرکدام که چیزی را تغییر می‌دهد یک ردیف ممیزی با actor
// `remote:<name>` می‌گذارد. هیچ مسیر/فرمان/pid ِ دلخواهی از ورودی نمی‌آید: مسیرها از status ِ Manager، pidها از رجیستری
// کانبان، و فرمان‌ها ثابت‌اند. UI (نشست کوکی) همان bundle را می‌سازد و از /api/bundles می‌گیرد.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BundleStore } from './bundles.js';
import { collectSystemDiag, collectTaskDiag, safe } from './diag.js';
import { formatTaskDiag } from './diag-format.js';
import { listProcesses as defaultListProcesses, descendantsOf, isNpmCi, ageMs } from './process-list.js';
import { killProcessTree } from './process-tools.js';
import { environmentSecrets, redact } from './security.js';
import { DEFAULT_MAX_CHARS, DEFAULT_TAIL, EVENTS_NAME, MAX_TAIL, TAIL_ONLY, TASK_ARTIFACTS, ATTEMPT_ARTIFACTS, limitText, pad3, relPathFor, validateName } from './remote-artifacts.js';
import { runLogOf } from './remote-routes.js';
import { exitMessage } from './sync-report.js';
import { resolveTaskDir } from './routes-ops.js';

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const EXEC_ID = /^[0-9]{14}-[0-9a-f]{8}$/;
export const KILL_MINUTES_DEFAULT = 5;
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

export function createRemoteOpsRoutes(ctx) {
  const { registry, runner, audit, repoFor, config, send, route, readBody, boardFor, collect, collectJson, collectAction, assertExecution, updater, dataDir, issuesCount } = ctx;
  const listProcesses = ctx.listProcesses ?? defaultListProcesses;
  const killTree = ctx.killTree ?? killProcessTree;
  const startedAtMs = ctx.startedAtMs ?? Date.now() - process.uptime() * 1000;
  const bundles = new BundleStore(dataDir);
  const defaultRepo = () => config.repos[0];
  const repoOf = url => repoFor(url.searchParams.get('repo') || defaultRepo().id);

  const taskOf = async (repo, id) => {
    if (!TASK_ID.test(String(id))) throw bad('شناسه‌ی تسک نامعتبر است.');
    const board = await collectJson(repo, ['status', '--json', '--task', id]);
    const task = board.tasks?.[0];
    if (!task) throw bad('task پیدا نشد.', 404);
    if (task.error) throw bad(`Manager برای این تسک خطا داد: ${safe(task.error, 200)}`, 409);
    return task;
  };

  const withTmpFile = async (prefix, text, fn) => {
    const tmp = path.join(os.tmpdir(), `barsa-${prefix}-${process.pid}-${randomUUID()}.txt`);
    try {
      fs.writeFileSync(tmp, String(text), { encoding: 'utf8', mode: 0o600 });
      return await fn(tmp);
    } finally { fs.rmSync(tmp, { force: true }); }
  };

  // --- artifact ---------------------------------------------------------------------------------------------------

  async function readArtifact(repo, task, url) {
    const name = url.searchParams.get('name');
    const attemptParam = url.searchParams.get('attempt');
    if (attemptParam !== null && !/^\d{1,3}$/.test(attemptParam)) throw bad('--attempt باید عدد (۱ تا ۳ رقم) باشد.');
    const attempts = (task.attempts || []).map(a => ({ n: a.n, role: a.role ?? null, outcome: a.outcome ?? null }));

    if (!name) {
      const present = new Set(task.artifacts || []);
      return {
        taskId: String(task.id), artifacts: TASK_ARTIFACTS.filter(item => present.has(item)), attempts,
        perAttempt: ATTEMPT_ARTIFACTS, extra: [EVENTS_NAME], lastAttempt: task.lastAttempt?.n ?? attempts.at(-1)?.n ?? null
      };
    }
    const checked = validateName(name);
    if (!checked.ok) throw bad(checked.error);
    const tailParam = url.searchParams.get('tail');
    let tail = null;
    if (tailParam !== null) {
      tail = Number(tailParam);
      if (!Number.isInteger(tail) || tail < 1 || tail > MAX_TAIL) throw bad(`--tail باید عدد صحیح ۱ تا ${MAX_TAIL} باشد.`);
    }
    if (TAIL_ONLY.includes(checked.name) && tail === null) tail = DEFAULT_TAIL;
    const secrets = environmentSecrets();

    if (checked.name === EVENTS_NAME) {
      const events = await collectJson(repo, ['events', String(task.id), '--json']);
      const rows = events.map(event => redact(JSON.stringify(event), secrets));
      const shown = rows.slice(-tail);
      return { taskId: String(task.id), name: EVENTS_NAME, attempt: null, path: EVENTS_NAME, totalLines: rows.length, shownLines: shown.length, truncated: rows.length > shown.length, text: shown.join('\n') };
    }

    const last = task.lastAttempt?.n ?? attempts.at(-1)?.n ?? null;
    let attempt = attemptParam === null ? null : Number(attemptParam);
    const attemptOnly = ATTEMPT_ARTIFACTS.includes(checked.name);
    if (attemptOnly && attempt === null) {
      if (last === null) throw bad('این تسک هنوز attempt ندارد.', 404);
      attempt = last;
    }
    // نام top-level که نبود: آخرین attemptها (reviewer/architect گاهی داخل attempts/NNN می‌نویسند) — حداکثر ۳ تا.
    const tries = attempt !== null ? [attempt] : [null, ...attempts.map(a => a.n).reverse().slice(0, 3)];
    let lastError = null;
    for (const candidate of tries) {
      const rel = relPathFor(checked.name, candidate);
      try {
        const result = await collect(repo, ['artifact', String(task.id), '--path', rel]);
        const limited = limitText(redact(result.stdout, secrets), { tail, maxChars: DEFAULT_MAX_CHARS });
        return {
          taskId: String(task.id), name: checked.name, attempt: candidate, path: rel, bytes: Buffer.byteLength(result.stdout),
          totalLines: limited.totalLines, shownLines: limited.shownLines, truncated: limited.truncated, tail, text: limited.text
        };
      } catch (error) { lastError = error; }
    }
    throw bad(`artifact «${checked.name}»${attempt !== null ? ` (attempt ${pad3(attempt)})` : ''} برای این تسک پیدا نشد${lastError?.message ? `: ${safe(lastError.message, 160)}` : ''}.`, 404);
  }

  // --- diag / bundle -----------------------------------------------------------------------------------------------

  const diagInput = (repo, task) => ({
    repo, task, registry, listProcesses,
    readSummary: async id => (await collect(repo, ['status', '--task', id, '--summary'])).stdout.trim(),
    readEvents: async id => collectJson(repo, ['events', id, '--json']),
    runLog: async (id, tail) => runLogOf({ registry, audit, repo, taskId: id, tail })
  });

  function fullRunLog(repo, taskId) {
    const secrets = environmentSecrets();
    const live = registry.get(repo, taskId);
    if (live) return { runId: live.runId ?? null, text: live.lines.map(item => `${item.at} [${item.stream}] ${redact(item.text, secrets)}`).join('\n') };
    const latest = audit.summaries({ action: 'run', repoId: repo.id, taskId, limit: 1 })[0];
    if (!latest?.outputFile || !fs.existsSync(latest.outputFile)) return { runId: latest?.id ?? null, text: '' };
    const size = fs.statSync(latest.outputFile).size;
    const keep = Math.min(size, 1024 * 1024);
    const fd = fs.openSync(latest.outputFile, 'r');
    try {
      const buffer = Buffer.alloc(keep);
      fs.readSync(fd, buffer, 0, keep, size - keep);
      return { runId: latest.id, text: `${size > keep ? `[فقط ${keep} بایت ِ آخر از ${size}]\n` : ''}${buffer.toString('utf8')}` };
    } finally { fs.closeSync(fd); }
  }

  async function createBundle(session, repo, task) {
    const { dir } = resolveTaskDir(repo, task);
    const diag = await collectTaskDiag(diagInput(repo, task));
    const { runId, text } = fullRunLog(repo, String(task.id));
    const result = bundles.create({ taskId: String(task.id), taskDir: dir, diagText: formatTaskDiag(diag), runLogText: text, runId });
    audit.note({ user: session.user, action: 'bundle.create', repoId: repo.id, taskId: String(task.id), file: result.name, bytes: result.bytes, files: result.files });
    return { ok: true, taskId: String(task.id), name: result.name, path: result.file, bytes: result.bytes, files: result.files, skipped: result.skipped.length };
  }

  // --- اکشن‌های نام‌دار ---------------------------------------------------------------------------------------------

  async function recover(session, repo, id, input) {
    await assertExecution(repo);
    const discard = input?.discardResidue === true;
    const reason = String(input?.reason ?? '').trim();
    if (discard && !reason) throw bad('--discard-residue دلیل می‌خواهد (--reason-… / متن).');
    if (!discard && reason) throw bad('دلیل فقط کنار --discard-residue معنا دارد.');
    const run = file => collectAction(session, repo, ['recover', id, ...(discard ? ['--discard-residue', '--reason-file', file] : [])], { action: 'recover', taskId: id });
    const out = discard ? await withTmpFile('recover-reason', reason, run) : await run();
    const output = redact(out.stdout, environmentSecrets()).split(/\r?\n/).filter(Boolean).slice(-12);
    return { ok: true, taskId: id, mode: discard ? 'discard-residue' : 'recover', output };
  }

  async function retryInstall(session, repo, id, input) {
    await assertExecution(repo);
    const task = await taskOf(repo, id);
    if (task.actions?.retryInstall !== true) throw bad('«دوباره نصب کن» برای این تسک الان مجاز نیست (actions.retryInstall = false؛ blocker از نوع شکست نصب نیست).', 409);
    const reason = String(input?.reason ?? '').trim() || 'تلاش دوباره‌ی نصب وابستگی‌ها (از راه دور)';
    await withTmpFile('reason', reason, file => collectAction(session, repo, ['answer', id, '--unblock', '--reason-file', file], { action: 'unblock', taskId: id }));
    const run = registry.enqueue(repo, id, { user: session.user });
    audit.note({ user: session.user, action: 'retry-install', repoId: repo.id, taskId: id, note: run ? (run.queued ? 'unblock + run در صف' : 'unblock + run شروع شد') : 'unblock؛ اجرا از قبل در جریان/صف' });
    return { ok: true, taskId: id, queued: !!run && run.queued, started: !!run && !run.queued, duplicate: !run };
  }

  async function killStuckInstall(session, repo, id, input) {
    const minutes = input?.minutes === undefined ? KILL_MINUTES_DEFAULT : Number(input.minutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw bad('--minutes باید عدد صحیح ۱ تا ۲۴۰ باشد.');
    // ریشه‌ی درخت **فقط** فرآیندی است که خود کانبان برای این تسک راه انداخته (رجیستری)؛ نه جست‌وجوی متنی در سیستم.
    const live = registry.get(repo, id);
    const rootPid = live && !live.finished ? live.child?.pid : null;
    const reject = message => {
      audit.reject({ user: session.user, action: 'kill-stuck-install', repoId: repo.id, taskId: id }, message);
      return Object.assign(bad(message, 409), { audited: true });
    };
    if (!rootPid) throw reject('این تسک الان از طرف کانبان اجرا نمی‌شود، پس درخت npm ci ِ آن شناخته‌شده نیست؛ چیزی بسته نشد.');
    const now = Date.now();
    const tree = descendantsOf(await listProcesses(), rootPid);
    const ciPids = new Set(tree.filter(isNpmCi).map(p => p.pid));
    if (!ciPids.size) throw reject('در درخت این تسک npm ci در حال اجرا نیست؛ چیزی بسته نشد.');
    // «lifecycle script» = فرزند مستقیم ِ یک npm ci که خودش npm ci نیست (postinstall/install/…، معمولاً cmd /c node …).
    const candidates = tree.filter(p => ciPids.has(p.ppid) && !ciPids.has(p.pid));
    const limitMs = minutes * 60_000;
    const old = candidates.filter(p => (ageMs(p, now) ?? 0) >= limitMs);
    const keep = candidates.filter(p => !old.includes(p));
    const describe = p => ({ pid: p.pid, name: p.name, ageMin: Math.round((ageMs(p, now) ?? 0) / 60_000), cmd: safe(p.cmd, 120) });
    if (!old.length) {
      audit.note({ user: session.user, action: 'kill-stuck-install', repoId: repo.id, taskId: id, status: 'ok', note: `هیچ lifecycle script ای بیش از ${minutes} دقیقه نیست (${candidates.length} فعال)` });
      return { ok: true, taskId: id, minutes, killed: [], remaining: keep.map(describe), note: `هیچ lifecycle script ای بیش از ${minutes} دقیقه نیست؛ چیزی بسته نشد.` };
    }
    // درست پیش از بستن، یک عکس تازه: pid باید هنوز در همین درخت و با همان زمان شروع باشد (جلوگیری از استفاده‌ی دوباره‌ی pid).
    const fresh = descendantsOf(await listProcesses(), rootPid);
    const targets = old.filter(p => fresh.some(q => q.pid === p.pid && q.startedAt === p.startedAt));
    const handle = audit.begin({ user: session.user, action: 'kill-stuck-install', repoId: repo.id, taskId: id, cwd: repo.path, argv: ['kill-stuck-install', id, `--minutes=${minutes}`, ...targets.map(p => `pid=${p.pid}`)], output: false });
    const killed = [];
    for (const target of targets) {
      const result = await killTree(target.pid, { graceMs: Number(config.run?.stopGraceMs ?? 5000) });
      killed.push({ ...describe(target), stillAlive: result.stillAlive });
    }
    handle.finish({ exitCode: 0, status: 'ok', note: `بسته شد: ${killed.map(k => `${k.pid}(${k.name})`).join(', ') || 'هیچ'}` });
    return { ok: true, taskId: id, minutes, killed, remaining: keep.map(describe), note: 'npm ci خودش بسته نشد؛ اگر شکست خورد blocker نصب می‌ماند و «barsa retry-install» دوباره امتحان می‌کند.' };
  }

  function execView(exec) {
    const secrets = environmentSecrets();
    const code = exec.finished ? exec.exitCode : null;
    return {
      execId: exec.id, action: exec.action, finished: exec.finished === true, exitCode: code, stopped: exec.stopped === true,
      startedAt: exec.startedAt ?? null, finishedAt: exec.finishedAt ?? null,
      message: code !== null && code !== 0 ? (exitMessage(code) ?? `sync با exit code ${code} تمام شد.`) : null,
      lines: exec.lines.slice(-60).map(item => redact(item.text, secrets))
    };
  }

  // -----------------------------------------------------------------------------------------------------------------

  return async function handle(req, res, url, pathname, session) {
    let p;
    const method = req.method;

    if (method === 'GET' && (p = route('/api/remote/tasks/:id/artifact', pathname))) {
      const repo = repoOf(url);
      return send(res, 200, await readArtifact(repo, await taskOf(repo, p.id), url)), true;
    }
    if (method === 'GET' && (p = route('/api/remote/tasks/:id/diag', pathname))) {
      const repo = repoOf(url);
      return send(res, 200, await collectTaskDiag(diagInput(repo, await taskOf(repo, p.id)))), true;
    }
    if (method === 'GET' && pathname === '/api/remote/diag/system') {
      const repo = repoOf(url);
      return send(res, 200, await collectSystemDiag({ config, repo, dataDir, registry, boardFor, listProcesses, issuesCount, startedAtMs })), true;
    }
    if (method === 'GET' && (p = route('/api/remote/execs/:id', pathname))) {
      const exec = EXEC_ID.test(p.id) ? runner.get(p.id) : null;
      // فقط اجرای sync ِ Manager (manager.update / manager.sync-preview)؛ اجرای کنسول و بقیه از این راه دیده نمی‌شود.
      if (!exec || !/^manager\.(update|sync-preview)$/.test(exec.action)) return send(res, 404, { error: 'اجرای sync با این شناسه پیدا نشد.' }), true;
      return send(res, 200, execView(exec)), true;
    }

    if (method === 'POST' && (p = route('/api/remote/tasks/:id/bundle', pathname))) {
      const repo = repoOf(url);
      return send(res, 200, await createBundle(session, repo, await taskOf(repo, p.id))), true;
    }
    if (method === 'POST' && (p = route('/api/remote/tasks/:id/recover', pathname))) {
      if (!TASK_ID.test(p.id)) throw bad('شناسه‌ی تسک نامعتبر است.');
      return send(res, 200, await recover(session, repoOf(url), p.id, await readBody(req))), true;
    }
    if (method === 'POST' && (p = route('/api/remote/tasks/:id/retry-install', pathname))) {
      if (!TASK_ID.test(p.id)) throw bad('شناسه‌ی تسک نامعتبر است.');
      return send(res, 200, await retryInstall(session, repoOf(url), p.id, await readBody(req))), true;
    }
    if (method === 'POST' && (p = route('/api/remote/tasks/:id/kill-stuck-install', pathname))) {
      if (!TASK_ID.test(p.id)) throw bad('شناسه‌ی تسک نامعتبر است.');
      return send(res, 200, await killStuckInstall(session, repoOf(url), p.id, await readBody(req))), true;
    }
    if (method === 'POST' && pathname === '/api/remote/sync') {
      const repo = repoOf(url);
      const input = await readBody(req);
      const dryRun = input?.dryRun === true;
      const exec = dryRun ? updater.preview(repo, { user: session.user }) : await updater.start(repo, { user: session.user });
      return send(res, 202, { execId: exec.id, dryRun }), true;
    }

    // --- فقط نشست کوکی (UI)؛ توکن remote این دو را نمی‌بیند (در REMOTE_ENDPOINTS نیستند) -------------------------------
    if (method === 'GET' && pathname === '/api/bundles') return send(res, 200, bundles.list()), true;
    if (method === 'GET' && (p = route('/api/bundles/:name', pathname))) {
      const file = bundles.resolve(p.name);
      if (!file) return send(res, 404, { error: 'bundle پیدا نشد (یا نام نامعتبر است).' }), true;
      const data = fs.readFileSync(file);
      audit.note({ user: session.user, action: 'bundle.download', file: path.basename(file), bytes: data.length });
      res.writeHead(200, {
        'Content-Type': 'application/zip', 'Content-Length': data.length, 'Content-Disposition': `attachment; filename="${path.basename(file)}"`,
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
      });
      res.end(data);
      return true;
    }
    return false;
  };
}
