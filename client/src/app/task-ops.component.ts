import { Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { HealthStatus, RunRecord, RunningTask, Task } from './models';

type Pending = 'abandon' | 'unblock' | 'raise-limit' | 'close-orphan' | 'retry-rebase';

const TERMINAL = new Set(['integrated', 'cancelled', 'abandoned']);

/**
 * اکشن‌های تایپ‌شده‌ی کارت task (بند ب) + توقف (ز) + شواهد (ج) + برخورد rebase (ط).
 *
 * قاعده: نمایش هر دکمه فقط از فیلدهای `status --json` تصمیم گرفته می‌شود. اگر
 * status برای مجاز بودن یک اکشن سیگنال نمی‌دهد (allow-path، external-access)
 * دکمه‌ای ساخته نشده و آن کار از «کنسول» انجام می‌شود؛ فیلد کم در گزارش آمده.
 */
@Component({
  selector: 'ba-task-ops',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="detail-section task-ops">
      <div class="section-head"><div><h3>اجراها و اکشن‌ها</h3><p>هر اکشن با نام تو در دفتر ممیزی ثبت می‌شود.</p></div></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
      @if (info()) { <div class="notice info"><span>{{ info() }}</span><button (click)="info.set('')">×</button></div> }

      <div class="danger-actions wrap">
        @if (active()) {
          <button class="danger" [disabled]="busy()" (click)="stop()">⏹ توقف این اجرا</button>
        }
        <a class="secondary link-btn" [href]="api.zipUrl(repoId(), task().id)" download>⬇ zip پوشه‌ی task (بازبینی بیرونی)</a>
      </div>
      @if (afterStop(); as h) {
        <div class="disabled-gate-warning">
          @if (h.stuck) { پس از توقف قفل جامانده است ({{ (h.stuckReasons || []).join('، ') }}). اجرای بعدی Manager خودش قفل مرده را پس می‌گیرد.
            @if (h.recovery?.reason) { <br>{{ h.recovery!.reason }} }
          } @else { پس از توقف قفلی نمانده؛ Manager اخطاری ندارد. }
        </div>
      }

      @if (rebaseConflict()) {
        <div class="conflict-card">
          <b>⚠ تداخل rebase</b>
          <p>rebase خودکار روی <code dir="ltr">{{ task().blocker?.base || 'main' }}</code>@if (task().blocker?.source) { (منبع بیرونی <code dir="ltr">{{ task().blocker?.source }}</code>) } تعارض داد و abort شد؛ worktree همان‌جایی است که قبل از rebase بود.</p>
          <div class="disabled-gate-warning">فایل‌های درگیر در <code>status --json</code> و رویداد <code>rebase.conflict</code> نیستند (فقط <code>base</code> و <code>oldBaseCommit</code>). فیلد کم در Manager گزارش شده؛ تا آن موقع فایل‌ها را در worktree ببین. ویرایشگر حل تعارض در این فاز نیست.</div>
        </div>
      }

      <div class="danger-actions wrap">
        @if (rebaseConflict()) {
          <button class="secondary" [disabled]="busy() || active()" (click)="open('retry-rebase')">🔁 دوباره امتحان کن (main عوض شده)</button>
        }
        @if (canUnblock()) {
          <button class="secondary" [disabled]="busy() || active()" (click)="open('unblock')">🔓 رفع blocker (unblock)</button>
        }
        @if (raiseField(); as f) {
          <button class="secondary" [disabled]="busy() || active()" (click)="open('raise-limit')">⬆ بالا بردن {{ f.field }}</button>
        }
        @if (orphanAttempt(); as a) {
          <button class="secondary" [disabled]="busy() || active()" (click)="open('close-orphan')">📁 بستن attempt یتیم {{ a }}</button>
        }
        @if (canAbandon()) {
          <button class="danger-outline" [disabled]="busy() || active()" (click)="open('abandon')">{{ rebaseConflict() ? 'کنار بگذار (abandon)' : 'کنار گذاشتن task (abandon)' }}</button>
        }
      </div>

      @if (pending(); as p) {
        <div class="confirm-box">
          <b>{{ title(p) }}</b>
          @if (p === 'raise-limit') {
            <label><span>{{ raiseField()?.field }} (فعلی: {{ raiseField()?.current ?? '؟' }})</span>
              <input type="number" min="1" max="1000" name="limit" [(ngModel)]="limitValue"></label>
          }
          <textarea name="reason" [(ngModel)]="reason" [placeholder]="p === 'retry-rebase' ? 'دلیل (اختیاری)' : 'دلیل (اجباری)…'"></textarea>
          <small>فرمان نهایی:</small>
          <code class="final-command" dir="ltr">{{ command(p) }}</code>
          <div class="danger-confirm-actions">
            <button class="secondary" (click)="pending.set(null)">انصراف</button>
            <button [class]="p === 'abandon' ? 'danger' : 'primary'" [disabled]="busy() || (p !== 'retry-rebase' && !reason.trim())" (click)="confirm(p)">تأیید نهایی</button>
          </div>
        </div>
      }

      <div class="section-head runs-head"><div><h3>اجراهای این task</h3><p>لاگ کامل هر اجرا با زمان نگه داشته می‌شود.</p></div></div>
      <div class="runs-list">
        @for (r of runs(); track r.runId) {
          <div class="run-row" [class.bad]="r.exitCode !== null && r.exitCode !== 0 && r.exitCode !== 10 && r.exitCode !== 40">
            <span dir="ltr">{{ r.startedAt.slice(0, 19).replace('T', ' ') }}</span>
            <span>{{ r.user || '—' }}</span>
            <span>{{ r.status }}{{ r.exitCode !== null ? ' · exit ' + r.exitCode : '' }}</span>
            <span dir="ltr">{{ r.durationMs !== null ? (r.durationMs / 1000).toFixed(1) + 's' : '…' }}</span>
            @if (r.hasLog) { <a [href]="api.logUrl(r.runId)" download>⬇ لاگ</a> } @else { <span></span> }
          </div>
        } @empty { <small>هنوز اجرایی از کانبان ثبت نشده.</small> }
      </div>
    </section>
  `
})
export class TaskOpsComponent {
  readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly task = input.required<Task>();
  readonly running = input<RunningTask | undefined>(undefined);
  readonly changed = output<void>();

  readonly runs = signal<RunRecord[]>([]);
  readonly pending = signal<Pending | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly afterStop = signal<HealthStatus | null>(null);
  reason = '';
  limitValue = 1;

  constructor() {
    // فهرست اجراها وقتی task عوض شد یا اجرا شروع/تمام شد دوباره خوانده می‌شود.
    effect(() => {
      this.repoId();
      this.task().id;
      const run = this.running();
      void run?.running; void run?.queued; void run?.finishedAt;
      void this.loadRuns();
    });
  }

  active(): boolean { const r = this.running(); return r?.running === true || r?.queued === true; }

  // --- نمایش فقط از status --json -------------------------------------------------
  rebaseConflict(): boolean { return this.task().state === 'blocked' && this.task().blocker?.kind === 'rebase-conflict'; }
  canUnblock(): boolean { return this.task().state === 'blocked' && !!this.task().blocker && !this.rebaseConflict(); }
  canAbandon(): boolean { return !TERMINAL.has(this.task().state) && !this.task().error; }
  raiseField(): { field: 'maxAttempts' | 'maxSpecRevisions'; current: number | null } | null {
    const b = this.task().blocker;
    if (this.task().state !== 'blocked' || !b) return null;
    if (typeof b.maxAttempts === 'number') return { field: 'maxAttempts', current: b.maxAttempts };
    if (typeof b.maxSpecRevisions === 'number') return { field: 'maxSpecRevisions', current: b.maxSpecRevisions };
    return null;
  }
  orphanAttempt(): string | null {
    const gate = this.task().awaitingHuman;
    if (gate?.kind !== 'orphan-attempt' || !gate.artifact) return null;
    const last = gate.artifact.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    return /^\d{1,6}$/.test(last) ? last : null;
  }

  title(p: Pending): string {
    return {
      abandon: 'کنار گذاشتن task', unblock: 'رفع blocker', 'raise-limit': 'بالا بردن سقف',
      'close-orphan': 'بستن attempt یتیم', 'retry-rebase': 'دوباره امتحان کن (rebase)'
    }[p];
  }

  command(p: Pending): string {
    const id = this.task().id;
    const why = this.reason.trim() ? JSON.stringify(this.reason.trim()) : '"…"';
    switch (p) {
      case 'abandon': return `node scripts/manager.js abandon ${id} --reason-file ‹متن دلیل›`;
      case 'unblock': return `node scripts/manager.js answer ${id} --unblock --reason ${why}`;
      case 'raise-limit': return `node scripts/manager.js answer ${id} --raise-limit ${this.raiseField()?.field}=${this.limitValue} --reason ${why}`;
      case 'close-orphan': return `node scripts/manager.js answer ${id} --close-orphan ${this.orphanAttempt()} --reason ${why}`;
      case 'retry-rebase': return `node scripts/manager.js answer ${id} --unblock --reason ${this.reason.trim() ? why : '"تلاش دوباره بعد از تغییر main"'}  ←  سپس  node scripts/manager.js run ${id}`;
    }
  }

  open(p: Pending): void {
    this.reason = '';
    this.error.set('');
    this.limitValue = (this.raiseField()?.current ?? 0) + 5;
    this.pending.set(p);
  }

  private message(e: unknown): string { return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e); }

  async loadRuns(): Promise<void> {
    try { this.runs.set(await firstValueFrom(this.api.taskRuns(this.repoId(), this.task().id))); } catch { /* فهرست اختیاری است */ }
  }

  async stop(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await firstValueFrom(this.api.stopTask(this.repoId(), this.task().id));
      this.afterStop.set(result.health ?? { stuck: false } as HealthStatus);
      this.info.set(result.wasQueued ? 'از صف حذف شد.' : 'درخت فرآیند این اجرا بسته شد.');
      this.changed.emit();
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }

  async confirm(p: Pending): Promise<void> {
    const repo = this.repoId();
    const id = this.task().id;
    const reason = this.reason.trim();
    this.busy.set(true);
    this.error.set('');
    try {
      switch (p) {
        case 'abandon': await firstValueFrom(this.api.abandonTask(repo, id, reason)); break;
        case 'unblock': await firstValueFrom(this.api.unblockTask(repo, id, reason)); break;
        case 'raise-limit': await firstValueFrom(this.api.raiseLimit(repo, id, this.raiseField()!.field, Number(this.limitValue), reason)); break;
        case 'close-orphan': await firstValueFrom(this.api.closeOrphan(repo, id, this.orphanAttempt()!, reason)); break;
        case 'retry-rebase': await firstValueFrom(this.api.retryRebase(repo, id, reason || undefined)); break;
      }
      this.pending.set(null);
      this.info.set('انجام شد.');
      this.changed.emit();
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }
}
