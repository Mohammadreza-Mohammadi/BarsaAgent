// کانبان فاز ۱: مسیرهای تازه (کنسول، اجراها، توقف، شواهد، git، به‌روزرسانی، سلامت).
// app.js مالک احراز هویت/CSRF و مسیرهای قدیمی است؛ این‌جا فقط منطق مسیرهای تازه.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { collectJson } from './cli.js';
import { ConsoleSyntaxError } from './tokenizer.js';
import { parseConsoleLine, displayCommand, resolveArgs } from './console-parser.js';
import { buildZip } from './zip.js';
import { stripLocalEnv } from './agent-env.js';
import { runHealthChecks } from './env-health.js';
import { answerRuntimeArgs, structuredFailure } from './runtime-args.js';

const MAX_ATTACHMENT = 1_000_000;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * مسیر پوشه‌ی task در .agent-work — فقط برای خواندن (zip). فقط از `task.dir` ِ `status --json`
 * (TOOLING-037، نسبت به ریشه‌ی مخزن): کانبان هیچ‌وقت از id+slug حدس نمی‌زند. realpath باید
 * زیر `.agent-work/tasks` بماند.
 */
export function resolveTaskDir(repo, task) {
  if (!TASK_ID.test(String(task?.id || ''))) throw Object.assign(new Error('شناسه‌ی task نامعتبر است.'), { status: 400 });
  const base = path.join(repo.path, '.agent-work', 'tasks');
  const declared = typeof task.dir === 'string' && task.dir.trim() ? task.dir : null;
  if (!declared) throw Object.assign(new Error('Manager فیلد dir را در status --json نداد (نسخه‌ی Manager قدیمی‌تر از TOOLING-037)؛ مسیر پوشه حدس زده نمی‌شود.'), { status: 409 });
  const dir = path.resolve(repo.path, declared);
  // اول نحوی (قبل از دست‌زدن به دیسک): مسیر اعلام‌شده‌ی بیرون از tasks همیشه 400 است.
  if (!isInside(path.resolve(base), path.resolve(dir))) {
    throw Object.assign(new Error('مسیر پوشه‌ی task خارج از .agent-work/tasks است.'), { status: 400 });
  }
  let realBase;
  let realDir;
  try {
    realBase = fs.realpathSync(base);
    realDir = fs.realpathSync(dir);
  } catch {
    throw Object.assign(new Error('پوشه‌ی task روی دیسک پیدا نشد.'), { status: 404 });
  }
  if (!isInside(realBase, realDir) || !fs.statSync(realDir).isDirectory()) {
    throw Object.assign(new Error('مسیر پوشه‌ی task خارج از .agent-work/tasks است.'), { status: 400 });
  }
  return { dir: realDir, source: 'status' };
}

export function createOpsRoutes(ctx) {
  const { audit, runner, registry, help, gitOps, updater, config, dataDir, route, send, readBody, repoFor, managerAudited, pipeStream, users, managerInfo, assertExecution, drain } = ctx;

  const defaultRepo = () => config.repos[0];

  // --- کنسول ------------------------------------------------------------------------

  async function parseInput(input) {
    const repo = repoFor(input?.repo || defaultRepo().id);
    const known = await help.get(repo);
    let parsed;
    try {
      parsed = parseConsoleLine(String(input?.line ?? ''), { allowed: known.subcommands, repo });
    } catch (error) {
      if (error instanceof ConsoleSyntaxError) error.status = 400;
      throw error;
    }
    return { repo, parsed, display: displayCommand(parsed), known };
  }

  function writeAttachments(parsed, supplied) {
    const given = supplied && typeof supplied === 'object' ? supplied : {};
    for (const key of Object.keys(given)) {
      if (!parsed.attachments.includes(key)) throw Object.assign(new Error(`متن برای ${key} داده شده ولی در خط فرمان نیست.`), { status: 400 });
    }
    const files = {};
    const meta = [];
    try {
      for (const flag of parsed.attachments) {
        const text = given[flag];
        if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error(`متن ${flag} الزامی است (کادر متن را پر کن).`), { status: 400 });
        if (text.length > MAX_ATTACHMENT) throw Object.assign(new Error(`متن ${flag} بیش از حد بزرگ است.`), { status: 413 });
        const file = path.join(os.tmpdir(), `barsa-console-${process.pid}-${randomUUID()}.txt`);
        fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
        files[flag] = file;
        meta.push({ flag, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') });
      }
    } catch (error) {
      for (const file of Object.values(files)) fs.rmSync(file, { force: true });
      throw error;
    }
    return { files, meta };
  }

  async function consoleExec(req, res, session) {
    const input = await readBody(req);
    let ready;
    try { ready = await parseInput(input); }
    catch (error) {
      audit.reject({ user: session.user, action: 'console', repoId: input?.repo || null, line: String(input?.line ?? '').slice(0, 2000) }, error.message);
      error.audited = true;
      throw error;
    }
    const { repo, parsed, display } = ready;
    const reject = (status, message) => {
      audit.reject({ user: session.user, action: 'console', repoId: repo.id, taskId: parsed.taskId, line: String(input.line).slice(0, 2000), argv: [display] }, message);
      return Object.assign(new Error(message), { status, audited: true });
    };
    if (!parsed.readOnly && input.confirmedCommand !== display) {
      throw reject(409, 'فرمان تأییدشده با فرمان نهایی نمی‌خواند؛ دوباره «بررسی» بزن و تأیید کن.');
    }
    if (parsed.subcommand === 'run') {
      await assertExecution(repo).catch(error => { throw reject(error.status || 409, error.message); });
      const run = registry.enqueue(repo, parsed.taskId, { user: session.user });
      if (!run) throw reject(409, 'این task هم‌اکنون در حال اجرا یا در صف است.');
      // رکورد ممیزی خود run را registry می‌نویسد؛ این رکورد فقط خطِ تایپ‌شده را برای تاریخچه نگه می‌دارد.
      audit.note({ user: session.user, action: 'console', repoId: repo.id, taskId: parsed.taskId, line: input.line, argv: [display], note: 'run در صف گذاشته شد' });
      return send(res, 202, { kind: 'run', taskId: parsed.taskId, repoId: repo.id });
    }
    let attachments;
    try { attachments = writeAttachments(parsed, input.attachments); }
    catch (error) { throw reject(error.status || 400, error.message); }
    const script = path.resolve(repo.path, repo.managerScript);
    const placeholders = Object.fromEntries(parsed.attachments.map(flag => [flag, `<متن ${flag}>`]));
    const exec = runner.start({
      user: session.user, action: 'console', repoId: repo.id, taskId: parsed.taskId,
      program: process.execPath, args: [script, ...resolveArgs(parsed, attachments.files)],
      auditArgv: [script, ...resolveArgs(parsed, placeholders)],
      cwd: repo.path, display, line: input.line, attachments: attachments.meta,
      env: stripLocalEnv(config, { ...process.env })
    });
    exec.done.finally(() => { for (const file of Object.values(attachments.files)) fs.rmSync(file, { force: true }); });
    return send(res, 202, { kind: 'exec', execId: exec.id });
  }

  // --- توقف و شواهد -------------------------------------------------------------------

  async function stopTask(session, repo, taskId) {
    const handle = audit.begin({ user: session.user, action: 'run.stop', repoId: repo.id, taskId, cwd: repo.path, argv: ['stop', taskId], output: false });
    const run = registry.get(repo, taskId);
    const result = await registry.stop(repo, taskId);
    if (!result.stopped) {
      handle.finish({ exitCode: null, status: 'rejected', note: result.reason });
      return { status: 409, body: { error: 'اجرای فعالی برای توقف نیست.' } };
    }
    if (run && !run.finished) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 15_000);
        run.events.once('end', () => { clearTimeout(timer); resolve(); });
      });
    }
    handle.finish({ exitCode: 0, status: 'stopped', note: result.stillAlive ? 'فرآیند هنوز زنده است' : undefined });
    // بعد از توقف، وضعیت واقعی را از Manager بخوان: قفل مرده → همان اخطار health.stuck.
    let health = null;
    try { health = (await collectJson(repo, ['status', '--json', '--task', taskId])).tasks?.[0]?.health ?? null; }
    catch { /* وضعیت در دسترس نیست؛ توقف خودش انجام شده */ }
    return { status: 200, body: { ok: true, ...result, exitCode: run?.exitCode ?? null, health } };
  }

  function runHistory(repo, taskId) {
    return audit.summaries({ action: 'run', repoId: repo.id, taskId, limit: 50 }).map(item => ({
      runId: item.id,
      user: item.user ?? null,
      startedAt: item.startedAt,
      endedAt: item.phases?.includes('end') ? item.at : null,
      exitCode: item.exitCode ?? null,
      status: item.status ?? (item.phases?.includes('end') ? 'ok' : 'running'),
      durationMs: item.durationMs ?? null,
      hasLog: !!item.outputFile && fs.existsSync(item.outputFile)
    }));
  }

  function sendLog(res, id, session) {
    let file;
    try { file = audit.outputFile(id); } catch { return send(res, 400, { error: 'شناسه‌ی لاگ نامعتبر است.' }); }
    if (!fs.existsSync(file)) return send(res, 404, { error: 'لاگ پیدا نشد.' });
    const data = fs.readFileSync(file);
    audit.note({ user: session.user, action: 'log.download', targetId: id, bytes: data.length });
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': data.length,
      'Content-Disposition': `attachment; filename="${id}.log"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    res.end(data);
  }

  async function sendTaskZip(res, session, repo, taskId) {
    const status = await collectJson(repo, ['status', '--json', '--task', taskId]);
    const task = status.tasks?.[0];
    if (!task) return send(res, 404, { error: 'task پیدا نشد.' });
    const { dir, source } = resolveTaskDir(repo, task);
    const { buffer, fileCount } = buildZip(dir);
    audit.note({ user: session.user, action: 'zip.download', repoId: repo.id, taskId, files: fileCount, bytes: buffer.length, dirSource: source });
    res.writeHead(200, {
      'Content-Type': 'application/zip', 'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename="task-${String(task.id).replace(/[^A-Za-z0-9._-]/g, '_')}.zip"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
    });
    res.end(buffer);
  }

  // --- فرم‌های اکشن تایپ‌شده (کارت task) ----------------------------------------------

  const needReason = input => {
    const reason = String(input?.reason ?? '').trim();
    if (!reason) throw Object.assign(new Error('دلیل الزامی است.'), { status: 400 });
    return reason;
  };

  async function withReasonFile(reason, fn) {
    const tmp = path.join(os.tmpdir(), `barsa-reason-${process.pid}-${randomUUID()}.txt`);
    try {
      fs.writeFileSync(tmp, reason, { encoding: 'utf8', mode: 0o600 });
      return await fn(tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // «مجاز است؟» را خود Manager می‌گوید (status --json ← actions، همان تابعی که handler پیش از اجرا می‌پرسد)
  // و UI فقط از همان دکمه می‌سازد. این‌جا فقط شکل ورودی سنجیده می‌شود (نه اجازه)؛ اگر Manager
  // رد کند، پیام خام او با 422 برمی‌گردد. متن آزاد همیشه از فایل UTF-8 می‌رود، نه argv.
  const RAISE_LIMIT_FIELDS = ['maxAttempts', 'maxSpecRevisions', 'architectRuns', 'implementerRuns', 'intakeRuns', 'reviewerRuns', 'rebaseRuns'];
  const SOURCE_ID = /^[a-z0-9][a-z0-9-]*$/i;
  const bad = message => Object.assign(new Error(message), { status: 400 });

  const relativePathArg = (value, label) => {
    const text = String(value ?? '').trim();
    if (!text || text.length > 500 || /[\0\r\n]/.test(text)) throw bad(`${label} نامعتبر است.`);
    if (text.startsWith('-')) throw bad(`${label} نباید با "-" شروع شود.`);
    return text;
  };

  async function reasoned(session, repo, id, kind, argv, input) {
    const reason = needReason(input);
    await withReasonFile(reason, file => managerAudited(session, repo, ['answer', id, ...argv, '--reason-file', file], { action: kind, taskId: id }));
    return { ok: true };
  }

  async function taskAction(session, repo, id, input, kind) {
    switch (kind) {
      case 'abandon': {
        const reason = needReason(input);
        await withReasonFile(reason, file => managerAudited(session, repo, ['abandon', id, '--reason-file', file], { action: 'abandon', taskId: id }));
        return { ok: true };
      }
      case 'unblock': return reasoned(session, repo, id, kind, ['--unblock'], input);
      case 'close-orphan': {
        const attempt = String(input?.attempt ?? '');
        if (!/^\d{1,6}$/.test(attempt)) throw bad('شماره‌ی attempt نامعتبر است (مثلاً 013).');
        return reasoned(session, repo, id, kind, ['--close-orphan', attempt], input);
      }
      case 'raise-limit': {
        const field = String(input?.field ?? '');
        if (!RAISE_LIMIT_FIELDS.includes(field)) throw bad(`field باید یکی از ${RAISE_LIMIT_FIELDS.join('، ')} باشد.`);
        const value = Number(input?.value);
        // فقط شکل: <n> «سقف تازه‌ی کل» است؛ «از سقف فعلی بزرگ‌تر باشد» را خود Manager می‌سنجد و پیامش عیناً برمی‌گردد (422).
        if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw bad('مقدار باید عدد صحیح مثبت باشد.');
        return reasoned(session, repo, id, kind, ['--raise-limit', `${field}=${value}`], input);
      }
      case 'allow-path': return reasoned(session, repo, id, kind, ['--allow-path', relativePathArg(input?.path, 'مسیر')], input);
      case 'allow-shared-knowledge-file': return reasoned(session, repo, id, kind, ['--allow-shared-knowledge-file', relativePathArg(input?.path, 'مسیر')], input);
      case 'external-access': {
        const sourceId = String(input?.sourceId ?? '');
        if (!SOURCE_ID.test(sourceId)) throw bad('شناسه‌ی منبع بیرونی نامعتبر است.');
        if (!['read', 'write'].includes(input?.access)) throw bad('سطح دسترسی باید read یا write باشد.');
        return reasoned(session, repo, id, kind, ['--external-access', `${sourceId}=${input.access}`], input);
      }
      case 'reset-external': {
        const sourceId = String(input?.sourceId ?? '');
        if (!SOURCE_ID.test(sourceId)) throw bad('شناسه‌ی منبع بیرونی نامعتبر است.');
        const to = input?.to == null || input.to === '' ? null : String(input.to);
        if (to !== null && !/^[0-9a-f]{7,40}$/i.test(to)) throw bad('--to باید یک sha (۷ تا ۴۰ نویسه‌ی hex) باشد.');
        return reasoned(session, repo, id, kind, ['--reset-external', sourceId, ...(to ? ['--to', to] : [])], input);
      }
      default:
        throw Object.assign(new Error('اکشن ناشناخته.'), { status: 404 });
    }
  }

  // --- runtime ِ هر مرحله (TOOLING-046) ------------------------------------------------------------
  // گزینه‌ها **فقط** از `runtime --options --json` ِ Manager می‌آیند (نه فهرست ِ سخت‌کدشده). `ready` یک probe ِ گران است
  // (نصب/احراز هویت ِ provider)، پس چند ثانیه cache می‌شود؛ با ?refresh=1 تازه می‌شود.
  const optionsCache = new Map();
  async function runtimeOptions(repo, refresh) {
    const cached = optionsCache.get(repo.id);
    if (!refresh && cached && Date.now() - cached.at < 30_000) return cached.value;
    const value = await collectJson(repo, ['runtime', '--options', '--json']);
    optionsCache.set(repo.id, { at: Date.now(), value });
    return value;
  }

  /**
   * تغییر ِ runtime بعد از ساخت: `answer <id> --runtime|--runtime-preset|--runtime-reset … --reason-file`.
   * «مجاز است؟» با `actions.setRuntime` ِ status (UI/CLI پیش‌سنجی می‌کنند)؛ اعتبارسنجی ِ معنایی و صف‌شدن وسط ِ attempt ِ
   * زنده با Manager است. خروجی ِ Manager (آخرین خط‌ها) برمی‌گردد تا UI بگوید «در صف نشست» یا «اعمال شد».
   */
  async function setRuntime(session, repo, id, input) {
    const argv = answerRuntimeArgs(input);
    const reason = needReason(input);
    await assertExecution(repo);
    try {
      const out = await withReasonFile(reason, file => managerAudited(session, repo, ['answer', id, ...argv, '--reason-file', file], { action: 'runtime', taskId: id }));
      const output = String(out.stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(-6);
      return { ok: true, taskId: id, queued: output.some(line => line.includes('در صف')), output };
    } catch (error) {
      const structured = structuredFailure(error);
      if (structured) throw Object.assign(error, { structured, message: `runtime نامعتبر است${structured.explanation ? ` (${structured.explanation})` : ''}: ${structured.message}` });
      throw error;
    }
  }

  // ط: «دوباره امتحان کن» برای rebase-conflict. blocked اجرا نمی‌شود
  // (RUN_STOPPED_STATES در manager.js)، پس اول unblock (برمی‌گرداند به
  // previousState) و بعد run که خودش دوباره rebase را امتحان می‌کند.
  async function retryRebase(session, repo, id, input) {
    // «مجاز است؟» با خود Manager است (actions.unblock)؛ اگر مجاز نباشد unblock همان‌جا رد می‌شود و run هرگز نمی‌رسد.
    await assertExecution(repo); // اجرا خاموش است ⇒ unblock هم رد می‌شود؛ پیش از هر نوشتنی با پیام Manager
    const reason = String(input?.reason ?? '').trim() || 'تلاش دوباره بعد از تغییر main (از کانبان)';
    await withReasonFile(reason, file => managerAudited(session, repo, ['answer', id, '--unblock', '--reason-file', file], { action: 'unblock', taskId: id }));
    const run = registry.enqueue(repo, id, { user: session.user });
    return { ok: true, queued: !!run && run.queued, started: !!run && !run.queued, duplicate: !run };
  }

  // --- git / update / health ----------------------------------------------------------

  const execResponse = exec => ({ execId: exec.id });

  async function healthPayload() {
    return runHealthChecks({ config, repos: config.repos, dataDir, managerInfo: config.managerInfo, help, users, updater, drain });
  }

  // ---------------------------------------------------------------------------------------

  return async function handle(req, res, url, pathname, session) {
    let p;
    const method = req.method;

    if (method === 'GET' && pathname === '/api/console/subcommands') {
      const repo = repoFor(url.searchParams.get('repo') || defaultRepo().id);
      const known = await help.get(repo);
      return send(res, 200, { subcommands: known.subcommands, source: 'manager.js --help', at: known.at, error: known.error }), true;
    }
    if (method === 'POST' && pathname === '/api/console/parse') {
      let ready;
      try { ready = await parseInput(await readBody(req)); }
      catch (error) { error.audited = true; throw error; } // dry-run: اشتباه تایپی ممیزی نمی‌شود
      const { parsed, display, repo } = ready;
      return send(res, 200, { ok: true, repo: repo.id, subcommand: parsed.subcommand, taskId: parsed.taskId, display, readOnly: parsed.readOnly, attachments: parsed.attachments }), true;
    }
    if (method === 'POST' && pathname === '/api/console/exec') return await consoleExec(req, res, session), true;
    if (method === 'GET' && pathname === '/api/console/history') {
      const seen = new Set();
      const lines = [];
      for (const item of audit.summaries({ action: 'console', user: session.user, limit: 300 })) {
        if (!item.line || seen.has(item.line)) continue;
        seen.add(item.line);
        lines.push({ line: item.line, at: item.startedAt, exitCode: item.exitCode ?? null, status: item.status ?? null });
        if (lines.length >= 50) break;
      }
      return send(res, 200, lines), true;
    }

    if (method === 'GET' && pathname === '/api/execs') return send(res, 200, runner.list()), true;
    if ((p = route('/api/execs/:id/stream', pathname)) && method === 'GET') {
      const exec = runner.get(p.id);
      if (!exec) return send(res, 404, { error: 'اجرا پیدا نشد.' }), true;
      return pipeStream(req, res, exec), true;
    }
    if ((p = route('/api/execs/:id/stop', pathname)) && method === 'POST') {
      const handle = audit.begin({ user: session.user, action: 'exec.stop', targetId: p.id, argv: ['stop', p.id], output: false });
      const stopped = await runner.stop(p.id);
      handle.finish({ exitCode: stopped ? 0 : null, status: stopped ? 'stopped' : 'rejected' });
      return send(res, stopped ? 200 : 409, stopped ? { ok: true } : { error: 'اجرای فعالی با این شناسه نیست.' }), true;
    }
    if ((p = route('/api/logs/:id', pathname)) && method === 'GET') return sendLog(res, p.id, session), true;

    if ((p = route('/api/repos/:repo/tasks/:id/stop', pathname)) && method === 'POST') {
      const result = await stopTask(session, repoFor(p.repo), p.id);
      return send(res, result.status, result.body), true;
    }
    if ((p = route('/api/repos/:repo/tasks/:id/runs', pathname)) && method === 'GET') {
      return send(res, 200, runHistory(repoFor(p.repo), p.id)), true;
    }
    if ((p = route('/api/repos/:repo/tasks/:id/zip', pathname)) && method === 'GET') {
      return await sendTaskZip(res, session, repoFor(p.repo), p.id), true;
    }
    for (const kind of ['abandon', 'unblock', 'close-orphan', 'raise-limit', 'allow-path', 'allow-shared-knowledge-file', 'external-access', 'reset-external']) {
      if ((p = route(`/api/repos/:repo/tasks/:id/${kind}`, pathname)) && method === 'POST') {
        return send(res, 200, await taskAction(session, repoFor(p.repo), p.id, await readBody(req), kind)), true;
      }
    }
    if ((p = route('/api/repos/:repo/tasks/:id/retry-rebase', pathname)) && method === 'POST') {
      return send(res, 200, await retryRebase(session, repoFor(p.repo), p.id, await readBody(req))), true;
    }

    // --- تخلیه (drain): run ِ تازه شروع نشود، در جریان‌ها ادامه بدهند، صف بماند (و بعد از restart هم بماند) ---------------
    if (method === 'GET' && pathname === '/api/drain') return send(res, 200, drain.status()), true;
    if (method === 'POST' && pathname === '/api/drain') return send(res, 200, drain.enable(session)), true;
    if (method === 'POST' && pathname === '/api/drain/off') return send(res, 200, drain.disable(session)), true;

    if ((p = route('/api/repos/:repo/runtime-options', pathname)) && method === 'GET') {
      return send(res, 200, await runtimeOptions(repoFor(p.repo), url.searchParams.get('refresh') === '1')), true;
    }
    if ((p = route('/api/repos/:repo/tasks/:id/runtime', pathname)) && method === 'POST') {
      if (!TASK_ID.test(p.id)) throw bad('شناسه‌ی task نامعتبر است.');
      return send(res, 200, await setRuntime(session, repoFor(p.repo), p.id, await readBody(req))), true;
    }

    // git
    if ((p = route('/api/repos/:repo/git/status', pathname)) && method === 'GET') {
      return send(res, 200, await gitOps.status(repoFor(p.repo), { user: session.user })), true;
    }
    if ((p = route('/api/repos/:repo/git/inventory', pathname)) && method === 'GET') {
      return send(res, 200, await gitOps.inventory(repoFor(p.repo))), true;
    }
    const gitRoutes = {
      'worktree-add': 'startWorktreeAdd', prove: 'startProve', merge: 'startMerge',
      'worktree-remove': 'startWorktreeRemove', 'branch-delete': 'startBranchDelete'
    };
    for (const [name, fn] of Object.entries(gitRoutes)) {
      if ((p = route(`/api/repos/:repo/git/${name}`, pathname)) && method === 'POST') {
        const exec = await gitOps[fn](repoFor(p.repo), await readBody(req), { user: session.user });
        return send(res, 202, execResponse(exec)), true;
      }
    }

    // به‌روزرسانی Manager
    if ((p = route('/api/repos/:repo/manager/info', pathname)) && method === 'GET') {
      return send(res, 200, await updater.info(repoFor(p.repo))), true;
    }
    // sync = TOOLING-040: پیش‌نمایش (--dry-run) و اجرای واقعی؛ هر دو یک اجرای stream‌شونده‌اند.
    if ((p = route('/api/repos/:repo/manager/sync-preview', pathname)) && method === 'POST') {
      return send(res, 202, execResponse(updater.preview(repoFor(p.repo), { user: session.user }))), true;
    }
    if ((p = route('/api/repos/:repo/manager/update', pathname)) && method === 'POST') {
      return send(res, 202, execResponse(await updater.start(repoFor(p.repo), { user: session.user }))), true;
    }

    if (method === 'GET' && pathname === '/api/env-health') return send(res, 200, await healthPayload()), true;
    if (method === 'GET' && pathname === '/api/audit') {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      return send(res, 200, audit.summaries({ limit }).map(({ phases, ...rest }) => rest)), true;
    }
    return false;
  };
}
