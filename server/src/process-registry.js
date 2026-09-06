import { EventEmitter } from 'node:events';
import { managerCommand } from './cli.js';
import { environmentSecrets, redact } from './security.js';

export class ProcessRegistry {
  #runs = new Map();
  constructor(maxLines = 2000) { this.maxLines = maxLines; }
  key(repo, task) { return `${repo.id}:${task}`; }
  list(repo) {
    return [...this.#runs.values()]
      .filter(x => x.repo === repo.id)
      .map(x => ({
        taskId: x.taskId,
        startedAt: x.startedAt,
        finishedAt: x.finishedAt ?? null,
        running: !x.finished,
        exitCode: x.exitCode
      }));
  }
  get(repo, task) { return this.#runs.get(this.key(repo, task)); }
  start(repo, task) {
    const key = this.key(repo, task);
    const existing = this.#runs.get(key);
    if (existing && !existing.finished) return null;

    const run = {
      repo: repo.id,
      taskId: String(task),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      finished: false,
      exitCode: null,
      lines: [],
      events: new EventEmitter(),
      child: null
    };
    this.#runs.set(key, run);
    const child = managerCommand(repo, ['run', String(task)]);
    run.child = child;
    const secrets = environmentSecrets();

    const push = (stream, raw) => {
      const text = redact(raw, secrets);
      const item = { text, stream, at: new Date().toISOString() };
      run.lines.push(item);
      if (run.lines.length > this.maxLines) run.lines.splice(0, run.lines.length - this.maxLines);
      run.events.emit('line', item);
    };

    const capture = stream => {
      let pending = '';
      const onData = chunk => {
        pending += chunk.toString();
        const parts = pending.split(/\r?\n/);
        pending = parts.pop() ?? '';
        for (const line of parts) push(stream, line);
      };
      onData.flush = () => { if (pending) { push(stream, pending); pending = ''; } };
      return onData;
    };
    const stdout = capture('stdout');
    const stderr = capture('stderr');
    child.stdout.on('data', stdout);
    child.stderr.on('data', stderr);
    child.on('error', error => push('stderr', error.message));
    child.on('close', code => {
      stdout.flush(); stderr.flush();
      run.finished = true;
      run.exitCode = Number.isInteger(code) ? code : 1;
      run.finishedAt = new Date().toISOString();
      run.events.emit('end', { code: run.exitCode, at: run.finishedAt });
    });
    return run;
  }
}
