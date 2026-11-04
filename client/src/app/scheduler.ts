// زمان‌بند ِ مرکزی ِ polling: «یک timer، نه چندتا».
//  • همه‌ی polling ها (بورد، drain، health، نگهداری، …) از همین‌جا می‌آیند؛ فقط یک setInterval برای کل ِ برنامه است.
//  • tab پنهان یا minimize ⇒ timer کاملاً خاموش (صفر درخواست)؛ با برگشتن، همه یک بار فوراً اجرا می‌شوند و timer دوباره روشن می‌شود.
//  • کار ِ در حال ِ اجرا دوباره شروع نمی‌شود (پاسخ ِ کند، درخواست روی هم نمی‌انباشت).
//  • با برداشتن ِ آخرین کار (یا dispose) timer پاک می‌شود. همه‌ی وابستگی‌ها تزریق می‌شوند تا بدون مرورگر تست شود.

export interface SchedulerEnv {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  now(): number;
  isHidden(): boolean;
  /** برای تغییر ِ visibility؛ تابع ِ لغو برمی‌گرداند. */
  onVisibilityChange(callback: () => void): () => void;
}

export interface PollTask {
  name: string;
  /** هر چند میلی‌ثانیه؛ Infinity = فقط hookهای hide/show (مثل stream ِ لاگ). */
  everyMs: number;
  run?: () => unknown;
  /** tab پنهان شد (مثلاً بستن ِ EventSource). */
  onHide?: () => void;
  /** tab دوباره نمایان شد، پیش از اجرای فوری. */
  onShow?: () => void;
}

interface Entry { task: PollTask; last: number; busy: boolean }

export class Scheduler {
  private readonly entries = new Map<string, Entry>();
  private timer: unknown = null;
  private readonly unsubscribe: () => void;
  private disposed = false;
  private readonly env: SchedulerEnv;
  private readonly tickMs: number;

  constructor(env: SchedulerEnv, tickMs = 1000) {
    this.env = env;
    this.tickMs = tickMs;
    this.unsubscribe = env.onVisibilityChange(() => this.visibilityChanged());
  }

  /** timer ِ فعال (۰ یا ۱) — برای تست و عیب‌یابی. */
  get activeTimers(): number { return this.timer === null ? 0 : 1; }
  get names(): string[] { return [...this.entries.keys()]; }

  /** کاری را ثبت می‌کند؛ تابع ِ برداشتن را برمی‌گرداند. نام ِ تکراری جای قبلی را می‌گیرد. */
  add(task: PollTask): () => void {
    if (this.disposed) return () => undefined;
    this.entries.set(task.name, { task, last: this.env.now(), busy: false });
    this.ensureTimer();
    return () => this.remove(task.name, task);
  }

  private remove(name: string, task: PollTask): void {
    if (this.entries.get(name)?.task !== task) return;
    this.entries.delete(name);
    if (!this.entries.size) this.stopTimer();
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.stopTimer();
    this.unsubscribe();
  }

  /** یک گام: کارهای ِ سررسیده را (اگر درحال ِ اجرا نیستند) اجرا می‌کند. */
  tick(): void {
    if (this.env.isHidden()) return;
    const now = this.env.now();
    for (const entry of this.entries.values()) {
      if (!entry.task.run || !Number.isFinite(entry.task.everyMs) || entry.busy || now - entry.last < entry.task.everyMs) continue;
      this.start(entry, now);
    }
  }

  private start(entry: Entry, now: number): void {
    entry.last = now;
    entry.busy = true;
    const done = () => { entry.busy = false; };
    try {
      const result = entry.task.run?.();
      if (result && typeof (result as Promise<unknown>).then === 'function') (result as Promise<unknown>).then(done, done);
      else done();
    } catch { done(); }
  }

  private visibilityChanged(): void {
    if (this.disposed) return;
    if (this.env.isHidden()) {
      this.stopTimer();
      for (const { task } of this.entries.values()) { try { task.onHide?.(); } catch { /* hook نباید بقیه را بشکند */ } }
      return;
    }
    const now = this.env.now();
    for (const { task } of this.entries.values()) { try { task.onShow?.(); } catch { /* هم‌چنین */ } }
    for (const entry of this.entries.values()) if (entry.task.run && Number.isFinite(entry.task.everyMs) && !entry.busy) this.start(entry, now);
    this.ensureTimer();
  }

  private ensureTimer(): void {
    if (this.timer !== null || this.disposed || !this.entries.size || this.env.isHidden()) return;
    this.timer = this.env.setInterval(() => this.tick(), this.tickMs);
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    this.env.clearInterval(this.timer);
    this.timer = null;
  }
}

/** محیط ِ واقعی ِ مرورگر (Page Visibility API). */
export function browserEnv(win: Window = window, doc: Document = document): SchedulerEnv {
  return {
    setInterval: (fn, ms) => win.setInterval(fn, ms),
    clearInterval: id => win.clearInterval(id as number),
    now: () => Date.now(),
    isHidden: () => doc.visibilityState === 'hidden' || doc.hidden === true,
    onVisibilityChange: callback => { doc.addEventListener('visibilitychange', callback); return () => doc.removeEventListener('visibilitychange', callback); }
  };
}
