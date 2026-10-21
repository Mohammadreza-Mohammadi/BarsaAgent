// کانبان فاز ۱: اجرای یک برنامه‌ی **از پیش تعیین‌شده** (node/git/pwsh) با آرایه‌ی
// آرگومان، stream زنده، فایل خروجی کامل و رکورد ممیزی. هیچ shell ای نیست.
//
// این کلاس نمی‌داند «چه چیزی» مجاز است — caller (کنسول، git-ops، update) باید
// قبلاً فهرست بسته را اعمال کرده باشد.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { environmentSecrets, redact } from './security.js';
import { lineSplitter, killProcessTree } from './process-tools.js';

export class ActionRunner {
  #execs = new Map();

  constructor({ audit, killTree = killProcessTree, maxKeep = 100, maxLines = 5000, graceMs = 5000 } = {}) {
    this.audit = audit;
    this.killTree = killTree;
    this.maxKeep = maxKeep;
    this.maxLines = maxLines;
    this.graceMs = graceMs;
  }

  get(id) { return this.#execs.get(id); }

  list() {
    return [...this.#execs.values()].map(x => ({
      id: x.id, action: x.action, user: x.user, repoId: x.repoId ?? null, taskId: x.taskId ?? null,
      display: x.display, startedAt: x.startedAt, finishedAt: x.finishedAt, exitCode: x.exitCode,
      running: !x.finished, stopped: x.stopped
    }));
  }

  activeCount() { return [...this.#execs.values()].filter(x => !x.finished).length; }

  /**
   * @param opts.program   مسیر برنامه (process.execPath / 'git' / pwsh)
   * @param opts.args      آرایه‌ی آرگومان
   * @param opts.display   رشته‌ی نمایشی برای ممیزی (پیش‌فرض: program + args)
   * @param opts.auditArgv آرگومان‌هایی که در ممیزی می‌آید (پیش‌فرض: همان args)
   */
  start(opts) {
    const { user, action, repoId, taskId, program, args, cwd, env, display, auditArgv, line, attachments, detached } = opts;
    const handle = this.audit.begin({
      user, action, repoId, taskId, cwd,
      argv: [program, ...(auditArgv || args)],
      ...(line !== undefined ? { line } : {}),
      ...(attachments ? { attachments } : {})
    });
    const exec = {
      id: handle.id, action, user, repoId, taskId,
      display: display || [program, ...args].join(' '),
      startedAt: handle.startedAt, finishedAt: null, exitCode: null, finished: false, stopped: false,
      lines: [], events: new EventEmitter(), child: null, outputFile: handle.outputFile
    };
    exec.events.setMaxListeners(50);
    this.#execs.set(exec.id, exec);
    this.#trim();

    const push = (stream, raw) => {
      const item = { text: redact(raw, environmentSecrets()), stream, at: new Date().toISOString() };
      exec.lines.push(item);
      if (exec.lines.length > this.maxLines) exec.lines.splice(0, exec.lines.length - this.maxLines);
      try { fs.appendFileSync(exec.outputFile, `${item.at} [${stream}] ${item.text}\n`, 'utf8'); } catch { /* دیسک پر؛ stream زنده ادامه دارد */ }
      exec.events.emit('line', item);
    };

    const finish = (code, note) => {
      if (exec.finished) return;
      exec.finished = true;
      exec.exitCode = Number.isInteger(code) ? code : 1;
      exec.finishedAt = new Date().toISOString();
      handle.finish({ exitCode: exec.exitCode, status: exec.stopped ? 'stopped' : undefined, note });
      exec.events.emit('end', { code: exec.exitCode, at: exec.finishedAt, stopped: exec.stopped });
      exec.resolve({ code: exec.exitCode, stopped: exec.stopped });
    };
    exec.done = new Promise(resolve => { exec.resolve = resolve; });

    let child;
    try {
      child = spawn(program, args, {
        cwd, env: env || process.env, shell: false, windowsHide: true,
        detached: detached ?? process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      push('stderr', error.message);
      finish(127, error.message);
      return exec;
    }
    exec.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const out = lineSplitter(text => push('stdout', text));
    const err = lineSplitter(text => push('stderr', text));
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', error => { push('stderr', error.message); finish(127, error.message); });
    child.on('close', code => { out.flush(); err.flush(); finish(code); });
    return exec;
  }

  /**
   * چند گام پشت‌سرهم (مثلاً fetch → merge → npm ci) به‌عنوان یک اجرای واحد با
   * یک stream و یک رکورد ممیزی؛ هر گام هم جداگانه ممیزی می‌شود (action: "<action>.step").
   * هر گام: { label, program, args, env?, cwd?, when? } یا { label, run: async (push) => void }
   * (گام run هیچ فرآیندی نمی‌سازد؛ مثلاً خواندن دوباره‌ی manager.js --help)
   * اولین گام ناموفق، بقیه را متوقف می‌کند.
   */
  sequence({ user, action, repoId, taskId, cwd, steps, display }) {
    const handle = this.audit.begin({ user, action, repoId, taskId, cwd, argv: steps.map(s => s.label || s.program) });
    const exec = {
      id: handle.id, action, user, repoId, taskId, display: display || action,
      startedAt: handle.startedAt, finishedAt: null, exitCode: null, finished: false, stopped: false,
      lines: [], events: new EventEmitter(), child: null, currentStep: null, outputFile: handle.outputFile
    };
    exec.events.setMaxListeners(50);
    exec.done = new Promise(resolve => { exec.resolve = resolve; });
    this.#execs.set(exec.id, exec);
    this.#trim();
    const push = (stream, text) => {
      const item = { text, stream, at: new Date().toISOString() };
      exec.lines.push(item);
      if (exec.lines.length > this.maxLines) exec.lines.splice(0, exec.lines.length - this.maxLines);
      try { fs.appendFileSync(exec.outputFile, `${item.at} [${stream}] ${item.text}\n`, 'utf8'); } catch { /* ignore */ }
      exec.events.emit('line', item);
    };
    const finish = code => {
      exec.finished = true;
      exec.exitCode = code;
      exec.finishedAt = new Date().toISOString();
      handle.finish({ exitCode: code, status: exec.stopped ? 'stopped' : undefined });
      exec.events.emit('end', { code, at: exec.finishedAt, stopped: exec.stopped });
      exec.resolve({ code, stopped: exec.stopped });
    };
    (async () => {
      let code = 0;
      for (const step of steps) {
        if (exec.stopped) { code = 1; break; }
        try {
          if (step.when && !(await step.when())) { push('system', `— رد شد: ${step.label}`); continue; }
        } catch (error) { push('stderr', error.message); code = 1; break; }
        push('system', `$ ${step.label}`);
        if (step.run) {
          // گام run می‌تواند فرآیند فرزندش را با adopt(sub) به این اجرا بدهد (تا «توقف» آن را ببندد) و با throw ِ
          // Error ای که exitCode دارد، همان exit code را برای کل اجرا نگه دارد (مثلاً کدهای sync).
          try { await step.run(push, sub => { exec.currentStep = sub; }); }
          catch (error) {
            push('stderr', error.message);
            code = Number.isInteger(error.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
            exec.currentStep = null;
            break;
          }
          exec.currentStep = null;
          continue;
        }
        const sub = this.start({
          user, action: `${action}.step`, repoId, taskId, program: step.program, args: step.args,
          cwd: step.cwd || cwd, env: step.env
        });
        exec.currentStep = sub;
        sub.events.on('line', item => push(item.stream, item.text));
        const result = await sub.done;
        exec.currentStep = null;
        if (result.code !== 0) { code = result.code || 1; break; }
        try { await step.after?.(); } catch (error) { push('stderr', error.message); code = 1; break; }
      }
      finish(code);
    })();
    return exec;
  }

  /** فقط اجرایی که همین runner راه انداخته؛ id ناشناس → false. */
  async stop(id) {
    const exec = this.#execs.get(id);
    if (!exec || exec.finished) return false;
    const target = exec.currentStep || exec;
    if (!target.child?.pid) return false;
    exec.stopped = true;
    target.stopped = true;
    await this.killTree(target.child.pid, { graceMs: this.graceMs });
    return true;
  }

  #trim() {
    if (this.#execs.size <= this.maxKeep) return;
    for (const [id, exec] of this.#execs) {
      if (this.#execs.size <= this.maxKeep) break;
      if (exec.finished) this.#execs.delete(id);
    }
  }
}
