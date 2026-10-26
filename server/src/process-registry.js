import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { managerCommand } from './cli.js';
import { buildAgentEnv } from './agent-env.js';
import { environmentSecrets, redact } from './security.js';
import { lineSplitter, killProcessTree } from './process-tools.js';

export class ProcessRegistry {
  #runs = new Map();
  #queue = [];
  #draining = false;
  #closing = false; // shutdown: هیچ run ِ تازه‌ای شروع نمی‌شود (برخلاف draining ذخیره نمی‌شود)
  #drainInfo = { since: null, by: null };
  /** callback ِ تغییر ِ صف/حالت ِ تخلیه (کانبان آن را در drain.json ذخیره می‌کند). */
  onChange = null;

  constructor(options = {}) {
    if (typeof options === 'number') options = { maxLines: options };
    this.maxLines = Number(options.maxLines ?? 2000);
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent ?? 2));
    // کانبان-الحاقیه-۱، بند الف: config کامل سرور (برای config.run.proxy) —
    // اگر داده نشود (مثلاً تست‌های قدیمی‌تر)، buildAgentEnv با {} هم پیش‌فرض
    // DEFAULT_PROXY را می‌دهد و CLAUDE_CODE_OAUTH_TOKEN را همیشه حذف می‌کند؛
    // محافظت هرگز opt-in نیست.
    this.config = options.config || {};
    // کانبان فاز ۱: دفتر ممیزی (اختیاری تا تست‌های قدیمی‌تر بدون آن کار کنند) و
    // بستن درخت فرآیند. کانبان فقط فرزندانی را می‌بندد که همین registry ساخته.
    this.audit = options.audit || null;
    this.killTree = options.killTree || killProcessTree;
    this.graceMs = Number(options.graceMs ?? 5000);
  }

  key(repo, task) { return `${repo.id}:${task}`; }

  // --- حالت ِ تخلیه (drain) ---------------------------------------------------------------------------------
  // run ِ تازه (دستی، خودکار بعد از ساخت/جواب، retry) پذیرفته می‌شود ولی **شروع نمی‌شود**؛ در صف می‌ماند. run های در جریان
  // ادامه می‌دهند. خاموش شدن صف را می‌اندازد.
  get draining() { return this.#draining; }

  /** shutdown شروع شده: صف دیگر پمپ نمی‌شود (run ِ تازه‌ای که هنوز به فرآیند نرسیده هرگز شروع نمی‌شود). */
  beginShutdown() { this.#closing = true; }
  get drainInfo() { return { ...this.#drainInfo }; }

  setDraining(on, { by = null, since = null } = {}) {
    const next = on === true;
    if (next === this.#draining) return false;
    this.#draining = next;
    this.#drainInfo = next ? { since: since ?? new Date().toISOString(), by } : { since: null, by: null };
    this.#notify();
    if (!next) this.#pump();
    return true;
  }

  #notify() {
    // خاموش شدن: stopAll صف را خالی می‌کند ولی drain.json نباید با آن بازنویسی شود؛ صف ِ ذخیره‌شده باید بعد از restart برگردد.
    if (this.#closing) return;
    try { this.onChange?.(); } catch { /* ذخیره‌ی حالت نباید اجرا را بشکند */ }
  }

  /** run های در حال اجرا (فرآیند ساخته شده، تمام نشده). */
  liveSnapshot() {
    return [...this.#runs.values()].filter(x => !x.finished && !!x.startedAt).map(x => ({
      repoId: x.repo, taskId: x.taskId, runId: x.runId ?? null, user: x.user ?? null, startedAt: x.startedAt
    }));
  }

  /** run های در صف (به ترتیب ِ صف). */
  queuedSnapshot() {
    return this.#queue.map(key => this.#runs.get(key)).filter(x => x && !x.finished && x.queued).map(x => ({
      repoId: x.repo, taskId: x.taskId, user: x.user ?? null, queuedAt: x.queuedAt
    }));
  }

  /** بعد از restart: صف ِ ذخیره‌شده‌ی تخلیه را بدون شروع برمی‌گرداند (باید draining روشن باشد). */
  restoreQueued(items, repoOf) {
    let restored = 0;
    for (const item of items) {
      const repo = repoOf(item.repoId);
      if (!repo) continue;
      if (this.enqueue(repo, item.taskId, { user: item.user ?? null, queuedAt: item.queuedAt, restored: true })) restored += 1;
    }
    return restored;
  }

  /**
   * shutdown: همه‌ی run های زنده را (با مهلت ِ graceMs) می‌بندد و صف را خالی می‌کند. خروجی: فهرست ِ آنچه بسته شد.
   * فقط run هایی که همین registry ساخته؛ pid ِ دلخواه نیست.
   */
  async stopAll() {
    const live = this.liveSnapshot();
    const queued = this.queuedSnapshot();
    const repos = new Map([...this.#runs.values()].map(x => [x.repo, x.repoConfig]));
    await Promise.all([...live, ...queued].map(item => this.stop(repos.get(item.repoId) ?? { id: item.repoId }, item.taskId).catch(() => null)));
    return { live, queued };
  }

  activeCount() {
    return [...this.#runs.values()].filter(x => !x.finished && !!x.startedAt).length;
  }

  list(repo) {
    return [...this.#runs.values()]
      .filter(x => x.repo === repo.id)
      .map(x => ({
        taskId: x.taskId,
        runId: x.runId ?? null,
        user: x.user ?? null,
        queuedAt: x.queuedAt ?? null,
        startedAt: x.startedAt ?? null,
        finishedAt: x.finishedAt ?? null,
        queued: x.queued === true,
        held: x.queued === true && this.#draining,
        queuePosition: x.queued ? this.#queue.indexOf(this.key(repo, x.taskId)) + 1 : null,
        running: !x.finished && !!x.startedAt,
        stopped: x.stopped === true,
        exitCode: x.exitCode
      }));
  }

  get(repo, task) { return this.#runs.get(this.key(repo, task)); }

  start(repo, task, context) { return this.enqueue(repo, task, context); }

  enqueue(repo, task, context = {}) {
    const key = this.key(repo, task);
    const existing = this.#runs.get(key);
    if (existing && !existing.finished) return null;

    const run = {
      repo: repo.id,
      repoConfig: repo,
      taskId: String(task),
      user: context.user ?? null,
      runId: null,
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      queued: true,
      finished: false,
      stopped: false,
      exitCode: null,
      lines: [],
      events: new EventEmitter(),
      child: null,
      outputFile: null
    };

    this.#runs.set(key, run);
    this.#queue.push(key);
    if (context.queuedAt) run.queuedAt = context.queuedAt;
    this.#push(run, 'system', this.#draining ? 'در صف نگه داشته شد: حالت تخلیه است و run ِ تازه شروع نمی‌شود (با drain --off شروع می‌شود).' : 'در صف اجرا قرار گرفت.');
    if (!context.restored) this.#notify();
    this.#pump();
    return run;
  }

  /**
   * بند «ز»: توقف یک اجرا. فقط run هایی که همین registry ساخته (در Map است)؛
   * هیچ pid دلخواهی از بیرون پذیرفته نمی‌شود. اجرای هنوز-در-صف فقط از صف حذف
   * می‌شود (فرآیندی نیست که بسته شود).
   */
  async stop(repo, task) {
    const key = this.key(repo, task);
    const run = this.#runs.get(key);
    if (!run || run.finished) return { stopped: false, reason: 'no-active-run' };
    if (run.queued) {
      const index = this.#queue.indexOf(key);
      if (index >= 0) this.#queue.splice(index, 1);
      run.queued = false;
      run.stopped = true;
      this.#finish(run, null, 'از صف حذف شد (توقف).');
      this.#notify();
      return { stopped: true, wasQueued: true };
    }
    if (!run.child?.pid) return { stopped: false, reason: 'no-process' };
    run.stopped = true;
    this.#push(run, 'system', 'درخواست توقف: بستن درخت فرآیند این اجرا…');
    const result = await this.killTree(run.child.pid, { graceMs: this.graceMs });
    return { stopped: true, wasQueued: false, stillAlive: result.stillAlive };
  }

  #pump() {
    if (this.#draining || this.#closing) return; // تخلیه / shutdown: هیچ run ِ تازه‌ای شروع نمی‌شود
    while (this.activeCount() < this.maxConcurrent && this.#queue.length) {
      const key = this.#queue.shift();
      const run = this.#runs.get(key);
      if (!run || run.finished || !run.queued) continue;
      this.#launch(run);
    }
  }

  #push(run, stream, raw) {
    const secrets = environmentSecrets();
    const text = redact(raw, secrets);
    const item = { text, stream, at: new Date().toISOString() };
    run.lines.push(item);
    if (run.lines.length > this.maxLines) run.lines.splice(0, run.lines.length - this.maxLines);
    if (run.outputFile) {
      try { fs.appendFileSync(run.outputFile, `${item.at} [${stream}] ${item.text}\n`, 'utf8'); } catch { /* stream زنده ادامه دارد */ }
    }
    run.events.emit('line', item);
  }

  #finish(run, code, systemNote) {
    if (run.finished) return;
    if (systemNote) this.#push(run, 'system', systemNote);
    run.finished = true;
    run.exitCode = Number.isInteger(code) ? code : (run.stopped ? null : 1);
    run.finishedAt = new Date().toISOString();
    run.auditHandle?.finish({ exitCode: run.exitCode, status: run.stopped ? 'stopped' : undefined });
    run.events.emit('end', { code: run.exitCode, at: run.finishedAt, ...(run.stopped ? { stopped: true } : {}) });
    this.#pump();
  }

  #launch(run) {
    run.queued = false;
    run.startedAt = new Date().toISOString();

    // بند الف: env ِ همین فرآیند — manager.js «run» خودش بعداً run-agent.js را
    // با `{...process.env}` صدا می‌زند (TOOLING-023/manager.js:9064)، پس هر
    // چیزی که اینجا حذف/ست شود تا پایین زنجیره‌ی spawn هم می‌رسد.
    const args = ['run', run.taskId];
    if (this.audit) {
      run.auditHandle = this.audit.begin({
        user: run.user, action: 'run', repoId: run.repo, taskId: run.taskId,
        cwd: run.repoConfig.path, argv: [process.execPath, run.repoConfig.managerScript, ...args]
      });
      run.runId = run.auditHandle.id;
      run.outputFile = run.auditHandle.outputFile;
    }
    this.#push(run, 'system', 'اجرا از صف شروع شد.');

    const child = managerCommand(run.repoConfig, args, {
      env: buildAgentEnv(this.config),
      detached: process.platform !== 'win32'
    });
    run.child = child;
    // همان دلیل cli.js#collectChild: بدون setEncoding، یک کاراکتر فارسی روی
    // مرز chunk لاگ زنده را می‌شکند.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const stdout = lineSplitter(line => this.#push(run, 'stdout', line));
    const stderr = lineSplitter(line => this.#push(run, 'stderr', line));
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => this.#push(run, 'stderr', error.message));
    child.on('close', code => {
      stdout.flush();
      stderr.flush();
      this.#finish(run, code);
    });
  }
}
