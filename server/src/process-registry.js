import { EventEmitter } from 'node:events';
import { managerCommand } from './cli.js';
import { environmentSecrets, redact } from './security.js';

export class ProcessRegistry {
  #runs = new Map();
  #queue = [];

  constructor(options = {}) {
    if (typeof options === 'number') options = { maxLines: options };
    this.maxLines = Number(options.maxLines ?? 2000);
    this.maxConcurrent = Math.max(1, Number(options.maxConcurrent ?? 2));
  }

  key(repo, task) { return `${repo.id}:${task}`; }

  activeCount() {
    return [...this.#runs.values()].filter(x => !x.finished && !!x.startedAt).length;
  }

  list(repo) {
    return [...this.#runs.values()]
      .filter(x => x.repo === repo.id)
      .map(x => ({
        taskId: x.taskId,
        queuedAt: x.queuedAt ?? null,
        startedAt: x.startedAt ?? null,
        finishedAt: x.finishedAt ?? null,
        queued: x.queued === true,
        queuePosition: x.queued ? this.#queue.indexOf(this.key(repo, x.taskId)) + 1 : null,
        running: !x.finished && !!x.startedAt,
        exitCode: x.exitCode
      }));
  }

  get(repo, task) { return this.#runs.get(this.key(repo, task)); }

  start(repo, task) { return this.enqueue(repo, task); }

  enqueue(repo, task) {
    const key = this.key(repo, task);
    const existing = this.#runs.get(key);
    if (existing && !existing.finished) return null;

    const run = {
      repo: repo.id,
      repoConfig: repo,
      taskId: String(task),
      queuedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      queued: true,
      finished: false,
      exitCode: null,
      lines: [],
      events: new EventEmitter(),
      child: null
    };

    this.#runs.set(key, run);
    this.#queue.push(key);
    this.#push(run, 'system', 'در صف اجرا قرار گرفت.');
    this.#pump();
    return run;
  }

  #pump() {
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
    run.events.emit('line', item);
  }

  #launch(run) {
    run.queued = false;
    run.startedAt = new Date().toISOString();
    this.#push(run, 'system', 'اجرا از صف شروع شد.');

    const child = managerCommand(run.repoConfig, ['run', run.taskId]);
    run.child = child;
    // همان دلیل cli.js#collectChild: بدون setEncoding، یک کاراکتر فارسی روی
    // مرز chunk لاگ زنده را می‌شکند.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');

    const capture = stream => {
      let pending = '';
      const onData = chunk => {
        pending += chunk;
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        for (const line of parts) this.#push(run, stream, line);
      };
      onData.flush = () => {
        if (pending) {
          this.#push(run, stream, pending);
          pending = '';
        }
      };
      return onData;
    };

    const stdout = capture('stdout');
    const stderr = capture('stderr');
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.on('error', error => this.#push(run, 'stderr', error.message));
    child.on('close', code => {
      stdout.flush();
      stderr.flush();
      run.finished = true;
      run.exitCode = Number.isInteger(code) ? code : 1;
      run.finishedAt = new Date().toISOString();
      run.events.emit('end', { code: run.exitCode, at: run.finishedAt });
      this.#pump();
    });
  }
}
