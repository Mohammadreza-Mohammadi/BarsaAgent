import { Component, effect, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { HealthStatus, RecheckResult, RunRecord, RunningTask, Task } from './models';
import { failedWrites, lockNeedsForce, suggestedRecovery } from './task-health';
import { CardButton, allowed, can, conflictFiles, hasActions, opsButtons, provisionStageText, raiseLimitFields, supportsRaiseLimitList, unknownActionKeys } from './task-actions';

type Pending =
  | 'abandon' | 'cancel' | 'void' | 'unlock' | 'unblock' | 'retry-rebase' | 'raise-limit' | 'close-orphan'
  | 'allow-path' | 'allow-shared-knowledge-file' | 'external-access' | 'reset-external' | 'recover' | 'recheck' | 'retry-provision';

const BUTTON_LABELS: Record<string, string> = {
  unblock: '🔓 رفع blocker (unblock)', 'retry-rebase': '🔁 دوباره امتحان کن (main عوض شده)', 'raise-limit': '⬆ بالا بردن سقف',
  'allow-path': '➕ افزودن مسیر به scope', 'allow-shared-knowledge-file': '➕ فایل دانش مشترک', 'external-access': '🔑 دسترسی منبع بیرونی',
  'reset-external': '♻ بازنشانی worktree سایه', void: '↩ باطل کردن آخرین transition', unlock: '🔓 آزاد کردن قفل',
  cancel: 'بستن task (cancel)', abandon: 'کنار گذاشتن (abandon)',
  recover: '🛟 بازیابی (recover)', recheck: '♻ سنجش دوباره (بدون اجرای agent)', 'retry-provision': '🔁 دوباره امتحان کن (نصب / build / baseline)'
};

const DANGEROUS = new Set<Pending>(['abandon', 'cancel', 'void', 'unlock', 'reset-external']);

const TITLES: Record<Pending, string> = {
  abandon: 'کنار گذاشتن task (abandon)', cancel: 'بستن task (cancel)', void: 'باطل کردن آخرین transition (void)',
  unlock: 'آزاد کردن قفل transition (unlock)', unblock: 'رفع blocker (unblock)', 'retry-rebase': 'دوباره امتحان کن (rebase)',
  'raise-limit': 'بالا بردن سقف (raise-limit)', 'close-orphan': 'بستن attempt یتیم (close-orphan)',
  'allow-path': 'افزودن مسیر به scope.allow (allow-path)', 'allow-shared-knowledge-file': 'استثنای فایل دانش مشترک',
  'external-access': 'تغییر دسترسی منبع بیرونی', 'reset-external': 'بازنشانی worktree سایه (reset-external)',
  recover: 'بازیابی ِ تسک (recover)', recheck: 'سنجش دوباره (recheck)', 'retry-provision': 'دوباره امتحان کن (provisioning)'
};

const RECHECK_RESULT: Record<string, string> = {
  accepted: 'پذیرفته شد — تسک به مرحله‌ی بعد رفت', rejected: 'باز هم رد شد', blocked: 'مسدود شد', routed: 'به نقش ِ دیگری هدایت شد'
};

const HINTS: Partial<Record<Pending, string>> = {
  recheck: 'همان خروجی ِ موجود دوباره سنجیده می‌شود. budget مصرف نمی‌شود؛ agent اجرا نمی‌شود و attempt ِ تازه‌ای ساخته نمی‌شود.',
  abandon: 'task را برای همیشه کنار می‌گذارد؛ برنمی‌گردد.',
  cancel: 'task را می‌بندد؛ برنمی‌گردد.',
  void: 'آخرین transition (بدون اثر بیرونی) را برمی‌گرداند.',
  unlock: 'فقط .transition.lock همین task را آزاد می‌کند؛ manifest، worktree و تاریخچه دست‌نخورده می‌مانند.',
  'reset-external': 'worktree سایه‌ی این task را به یک commit برمی‌گرداند (پیش‌فرض Manager: merge-base)؛ تغییرات وب‌تری در آن worktree از دست می‌رود.'
};

/**
 * اکشن‌های کارت task. **هیچ شرط «مجاز است؟»ی در کانبان نیست**: هر دکمه فقط وقتی دیده می‌شود که
 * `status --json` در `actions` اجازه داده باشد (task-actions.ts). منبع/attempt هم از همان آرایه‌ها
 * می‌آیند. فقط توقف (فرآیند خود کانبان) و zip (فیلد `dir`) از جای دیگری هستند.
 */
@Component({
  selector: 'ba-task-ops',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="detail-section task-ops">
      <div class="section-head"><div><h3>اجراها و اکشن‌ها</h3><p>هر اکشن با نام تو در دفتر ممیزی ثبت می‌شود؛ مجاز بودنش را خود Manager می‌گوید.</p></div></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
      @if (info()) { <div class="notice info"><span>{{ info() }}</span><button (click)="info.set('')">×</button></div> }
      @if (recheckResult(); as rr) {
        <div class="notice info recheck-result">
          <span>♻ نتیجه‌ی سنجش دوباره (<code>attempt.rechecked</code>): <b>{{ recheckText(rr) }}</b>
            @if (rr.event) { · attempt {{ rr.event.attempt ?? '؟' }} · guard ِ قبلی: <code dir="ltr">{{ rr.event.previousGuard ?? '—' }}</code> · budget مصرف نشد }
            @if (!rr.event) { · رویداد ِ attempt.rechecked پیدا نشد؛ خروجی ِ Manager: {{ rr.output.join(' / ') }} }
          </span>
          <button (click)="recheckResult.set(null)">×</button>
        </div>
      }
      @if (failedWritesView(); as fw) {
        <div class="conflict-card blocker-card failed-writes-card">
          <b>⛔ خطای نوشتن ِ ابزار (<code>tool-write-failed</code>)@if (fw.role) { — نقش {{ fw.role }} }@if (fw.attempt) { · attempt {{ fw.attempt }} }</b>
          @if (fw.detail) { <p>{{ fw.detail }}</p> }
          @if (fw.legacy) {
            <div class="disabled-gate-warning">فهرست ِ نوشتن‌های ناموفق ثبت نشده (<code>failedWrites: null</code>) — رویداد ِ قدیمی‌تر از TOOLING-049.</div>
          } @else if (!fw.rows.length) {
            <div class="disabled-gate-warning">فهرست ِ نوشتن‌های ناموفق خالی است.</div>
          } @else {
            <table class="fw-table">
              <thead><tr><th>ابزار</th><th>مسیر نسبی</th><th>خطا</th></tr></thead>
              <tbody>@for (w of fw.rows; track $index) { <tr><td dir="ltr">{{ w.tool }}</td><td dir="ltr"><code>{{ w.path }}</code></td><td>{{ w.error }}@if (w.kind) { <i dir="ltr"> [{{ w.kind }}]</i> }</td></tr> }</tbody>
            </table>
          }
          @if (suggested(); as s) { <small>پیشنهاد ِ Manager (<code>health.recovery</code>): <b>{{ s === 'recheck' ? 'سنجش دوباره (recheck)' : 'رفع blocker (unblock)' }}</b>@if (task().health?.recovery?.reason) { — {{ task().health!.recovery!.reason }} }</small> }
        </div>
      }

      <div class="danger-actions wrap">
        @if (active()) { <button class="danger" [disabled]="busy()" (click)="stop()">⏹ توقف این اجرا</button> }
        @if (task().dir) {
          <a class="secondary link-btn" [href]="api.zipUrl(repoId(), task().id)" download>⬇ zip پوشه‌ی task (بازبینی بیرونی)</a>
        } @else {
          <span class="secondary link-btn disabled" title="Manager فیلد dir را نداد (قدیمی‌تر از TOOLING-037)">⬇ zip پوشه‌ی task (dir نیست)</span>
        }
      </div>
      @if (afterStop(); as h) {
        <div class="disabled-gate-warning">
          @if (h.stuck) { پس از توقف قفل جامانده است ({{ (h.stuckReasons || []).join('، ') }}). اجرای بعدی Manager خودش قفل مرده را پس می‌گیرد.
            @if (h.recovery?.reason) { <br>{{ h.recovery!.reason }} }
          } @else { پس از توقف قفلی نمانده؛ Manager اخطاری ندارد. }
        </div>
      }

      @if (!raiseLimitSupported()) {
        <div class="disabled-gate-warning">Manager قدیمی است (<code>actionsVersion</code> کمتر از ۲ یا نامشخص): دکمه‌ی «بالا بردن سقف» پنهان است، چون در این نسخه <code>actions.raiseLimit</code> فهرست فیلدها نیست. Manager را از «نگهداری مخزن ابزار ← sync» به‌روز کن، یا از «کنسول» انجام بده.</div>
      }

      @if (!hasActions()) {
        <div class="disabled-gate-warning">این Manager بلوک <code>actions</code> را در <code>status --json</code> نمی‌دهد (قدیمی‌تر از TOOLING-037)؛ هیچ دکمه‌ی اکشنی نمایش داده نمی‌شود — از «کنسول» انجام بده.</div>
      }

      @if (rebaseConflict()) {
        <div class="conflict-card">
          <b>⚠ تداخل rebase</b>
          <p>rebase خودکار روی <code dir="ltr">{{ task().blocker?.base || 'main' }}</code>@if (task().blocker?.source) { (منبع بیرونی <code dir="ltr">{{ task().blocker?.source }}</code>) } تعارض داد و abort شد؛ worktree همان‌جایی است که قبل از rebase بود.</p>
          @if (conflicts(); as files) {
            @if (files.length) {
              <small>فایل‌های درگیر ({{ files.length }}) — از <code>blocker.conflictFiles</code>:</small>
              <ul class="conflict-files" dir="ltr">@for (f of files; track f) { <li><code>{{ f }}</code></li> }</ul>
            } @else { <div class="disabled-gate-warning">git هیچ فایل درگیری گزارش نکرد (<code>conflictFiles: []</code>).</div> }
          } @else {
            <div class="disabled-gate-warning">فهرست فایل‌ها ثبت نشده (<code>conflictFiles: null</code>) — رویداد <code>rebase.conflict</code> قدیمی‌تر از این قابلیت است.</div>
          }
          <small>ویرایشگر حل تعارض در این فاز نیست؛ حل با git در worktree یا «دوباره امتحان کن» وقتی main عوض شد.</small>
        </div>
      }

      @if (provisionBlocker(); as b) {
        <div class="conflict-card blocker-card">
          <b>⛔ مسدود: {{ b.stage || b.kind }}@if (b.step) { — گام: <code dir="ltr">{{ b.step }}</code> }</b>
          @if (b.detail) { <p>{{ b.detail }}</p> }
          @if (b.stage) { <small>«دوباره امتحان کن» در این stage: {{ stageText() }}</small> }
          @if (b.log) {
            <small>لاگ کامل: <code dir="ltr">{{ b.log }}</code>
              @if (logArtifact(); as rel) { <button class="link-button" (click)="loadLog(rel)">نمایش</button> }</small>
          }
          @if (b.outputTail?.length) {
            <div class="tail-head"><small>۴۰ خط ِ آخر ِ خروجی (<code>blocker.outputTail</code>):</small>
              <button class="secondary" type="button" (click)="copyTail()">کپی</button></div>
            <pre class="logs tail-block" dir="ltr">{{ tailText() }}</pre>
          }
          @if (logText()) { <pre class="logs tail-block" dir="ltr">{{ logText() }}</pre> }
        </div>
      }

      @if (commitFailure(); as cf) {
        <div class="conflict-card commit-failure-card">
          <b>⚠ commit شکست خورد و چیزی کثیف مانده</b>
          @if (cf.message) { <p>{{ cf.message }}</p> }
          @if (cf.at) { <small>زمان: {{ cf.at }}</small> }
          @if (cf.leftover.length) {
            <small>کثیف‌مانده ({{ cf.leftover.length }}):</small>
            <ul class="conflict-files" dir="ltr">@for (f of cf.leftover; track f) { <li><code>{{ f }}</code></li> }</ul>
          }
          @if (cf.recoverCommand) { <small>فرمان ِ بازیابی ِ Manager: <code class="final-command" dir="ltr">{{ cf.recoverCommand }}</code></small> }
        </div>
      }

      <!-- هر کلید فعال actions دقیقاً یک دکمه (opsButtons در task-actions.ts)؛ هیچ شرط دستی دیگری نیست -->
      <div class="danger-actions wrap">
        @for (b of buttons(); track b.id + (b.target ?? '')) {
          <button [class]="dangerous(b.id) ? 'danger-outline' : 'secondary'" [class.recovery-suggested]="b.id === suggested()" [disabled]="busy() || active()" (click)="open(b.id, b.target)">{{ label(b) }}@if (b.id === suggested()) { <em> — پیشنهاد Manager</em> }</button>
        }
      </div>
      @if (can('recheck')) {
        <small class="recheck-note">♻ «سنجش دوباره»: همان خروجی ِ موجود دوباره سنجیده می‌شود. budget مصرف نمی‌شود.</small>
      }
      @if (unknownKeys().length) {
        <!-- اکشن ِ تازه‌ی Manager هرگز نامرئی نمی‌ماند: دکمه‌ی غیرفعال با نام خودش -->
        <div class="danger-actions wrap unknown-actions">
          @for (k of unknownKeys(); track k) {
            <button class="secondary" type="button" disabled title="Manager این اکشن را مجاز کرده ولی در کانبان پشتیبانی نمی‌شود — از «کنسول» انجام بده.">
              <code dir="ltr">{{ k }}</code> — در کانبان پشتیبانی نمی‌شود
            </button>
          }
        </div>
      }

      @if (pending(); as p) {
        <div class="confirm-box">
          <b>{{ title(p) }}</b>
          @if (hint(p)) { <small>{{ hint(p) }}</small> }
          <small class="resume-note">{{ resumeNote(p) }}</small>

          @if (p === 'raise-limit') {
            <label><span>فیلد سقف (فیلد سدکننده اول است)</span><select dir="ltr" name="limitField" [ngModel]="limitField" (ngModelChange)="pickLimitField($event)">@for (f of limitFields(); track f) { <option [value]="f">{{ f }}</option> }</select></label>
            <small class="limit-facts">مصرف‌شده: <b>{{ usedLimit() ?? '؟' }}</b> · سقف فعلی: <b>{{ currentLimit() ?? '؟' }}</b></small>
            <label><span>سقف تازه (کل) — نه مقدار افزوده</span><input type="number" min="1" name="limitValue" [(ngModel)]="limitValue"></label>
            @if (limitTooLow()) { <small class="bad">سقف تازه باید از سقف فعلی ({{ currentLimit() }}) بزرگ‌تر باشد.</small> }
          }
          @if (p === 'allow-path' || p === 'allow-shared-knowledge-file') {
            <label><span>مسیر یا الگو (نسبت به ریشه‌ی مخزن)</span><input dir="ltr" name="path" [(ngModel)]="path" placeholder="projects/…/file.ts"></label>
          }
          @if (p === 'external-access' || p === 'reset-external') {
            <label><span>منبع بیرونی</span>
              <select name="sourceId" [(ngModel)]="sourceId">@for (s of (p === 'reset-external' ? resetSources() : externalAccessSources()); track s) { <option [value]="s">{{ s }}</option> }</select></label>
          }
          @if (p === 'external-access') {
            <label><span>سطح دسترسی</span><select name="access" [(ngModel)]="access"><option value="read">read</option><option value="write">write</option></select></label>
          }
          @if (p === 'reset-external') {
            <label><span>--to (اختیاری — sha ِ commit؛ خالی = پیش‌فرض Manager)</span><input dir="ltr" name="to" [(ngModel)]="toSha" placeholder="مثلاً a1b2c3d"></label>
          }
          @if (p === 'recover' && recoverMode() === 'discard-residue') {
            <div class="disabled-gate-warning">پوشه‌ی کاملاً untracked ِ این تسک (هرگز commit نشده) با پشتیبان کنار گذاشته می‌شود؛ <code>BOARD.md</code> به HEAD برمی‌گردد و رویداد در <code>logs/residue-discarded.jsonl</code> ثبت می‌شود. دلیل اجباری است.</div>
          }
          @if (p === 'unlock' && lockUnknown()) {
            <label class="force-check"><input type="checkbox" name="force" [(ngModel)]="force"> مطمئنم — با <code>--force</code> اجرا کن (Manager نمی‌تواند زنده/مرده بودن این قفل را اثبات کند)</label>
          }

          <textarea name="reason" [(ngModel)]="reason" [placeholder]="reasonOptional(p) ? 'دلیل (اختیاری)' : 'دلیل (اجباری)…'"></textarea>
          <small>فرمان نهایی:</small>
          <code class="final-command" dir="ltr">{{ command(p) }}</code>
          <div class="danger-confirm-actions">
            <button class="secondary" (click)="pending.set(null)">انصراف</button>
            <button [class]="dangerous(p) ? 'danger' : 'primary'" [disabled]="busy() || !valid(p)" (click)="confirm(p)">تأیید نهایی</button>
          </div>
        </div>
      }

      <div class="section-head runs-head"><div><h3>اجراهای این task</h3><p>لاگ کامل هر اجرا با زمان نگه داشته می‌شود.</p></div></div>
      <div class="runs-list">
        @for (r of runs(); track r.runId) {
          <div class="run-row" [class.bad]="r.exitCode !== null && r.exitCode !== 0 && r.exitCode !== 10 && r.exitCode !== 40">
            <span dir="ltr">{{ r.startedAt.slice(0, 19).replace('T', ' ') }}</span>
            <span>{{ r.user || '—' }}@if (r.user?.startsWith('remote:')) { <span class="remote-badge" title="از راه دور، با CLI ِ barsa و توکن">remote</span> }</span>
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
  /** `capabilities.status.actionsVersion` ِ Manager همین مخزن؛ نبودن = قدیمی (raise-limit پنهان). */
  readonly actionsVersion = input<number | null>(null);

  readonly runs = signal<RunRecord[]>([]);
  readonly pending = signal<Pending | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly afterStop = signal<HealthStatus | null>(null);
  /** نتیجه‌ی آخرین recheck (رویداد attempt.rechecked)؛ بعد از اجرا نشان داده می‌شود. */
  readonly recheckResult = signal<RecheckResult | null>(null);
  reason = '';
  limitField = '';
  limitValue = 1;
  path = '';
  sourceId = '';
  access: 'read' | 'write' = 'write';
  toSha = '';
  attempt = '';
  force = false;

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

  // --- فقط از actions ---------------------------------------------------------------
  buttons(): CardButton[] { return opsButtons(this.task(), { rebaseConflict: this.rebaseConflict(), raiseLimitSupported: this.raiseLimitSupported() }); }
  raiseLimitSupported(): boolean { return supportsRaiseLimitList(this.actionsVersion()); }
  /** فهرست فیلدهای raise-limit از `actions.raiseLimit` (فیلد سدکننده اول). */
  limitFields(): string[] { return raiseLimitFields(this.task()); }
  unknownKeys(): string[] { return unknownActionKeys(this.task()); }
  label(b: CardButton): string {
    return b.id === 'close-orphan' ? `📁 بستن attempt یتیم ${b.target}` : (BUTTON_LABELS[b.id] ?? b.id);
  }
  /** resume ِ خودکار فقط بعد از approve/reject/clarify (پنل گیت)؛ این‌جا فقط اکشن‌هایی که خودشان unblock + run هستند. */
  resumeNote(p: Pending): string {
    if (p === 'recheck') return 'agent اجرا نمی‌شود، attempt ِ تازه‌ای ساخته نمی‌شود و budget مصرف نمی‌شود؛ ممکن است تا چند دقیقه طول بکشد (verify و commit ِ transition).';
    return p === 'retry-rebase' || p === 'retry-provision'
      ? 'بعد از رفع blocker، کانبان خودش run می‌زند (unblock + run).'
      : 'این اکشن run را خودکار نمی‌زند؛ بعد از آن (و بعد از اکشن‌های پشت‌سرهم) خودت «▶ اجرا / ادامه» را بزن.';
  }
  can(action: Parameters<typeof can>[1]): boolean { return can(this.task(), action); }
  hasActions(): boolean { return hasActions(this.task()); }
  orphans(): string[] { return allowed(this.task(), 'closeOrphan'); }
  externalAccessSources(): string[] { return allowed(this.task(), 'externalAccess'); }
  resetSources(): string[] { return allowed(this.task(), 'resetExternal'); }

  // --- فقط نمایش (نه اجازه) ---------------------------------------------------------
  /** blocker ای که step/log/outputTail/stage دارد (شکست ِ provisioning و baseline، ۰۴۳–۰۴۵). */
  provisionBlocker() {
    const b = this.task().blocker;
    return b && (b.step || b.log || b.outputTail?.length || b.stage) ? b : null;
  }
  stageText(): string { return provisionStageText(this.task().blocker?.stage); }
  /** `blocker.log` وقتی زیر پوشه‌ی خود ِ تسک است از راه artifact خوانده می‌شود؛ وگرنه فقط مسیر نشان داده می‌شود. */
  logArtifact(): string | null {
    const log = this.task().blocker?.log?.replace(/\\/g, '/');
    const dir = this.task().dir?.replace(/\\/g, '/').replace(/\/$/, '');
    return log && dir && log.startsWith(`${dir}/`) ? log.slice(dir.length + 1) : null;
  }
  readonly logText = signal('');
  async loadLog(rel: string): Promise<void> {
    try {
      const text = await firstValueFrom(this.api.artifact(this.repoId(), this.task().id, rel));
      this.logText.set(text.split(/\r?\n/).slice(-200).join('\n'));
    } catch (e) { this.error.set(this.message(e)); }
  }
  tailText(): string { return (this.task().blocker?.outputTail ?? []).join('\n'); }
  async copyTail(): Promise<void> {
    const text = this.tailText();
    try { await navigator.clipboard.writeText(text); this.info.set('خروجی کپی شد.'); } catch { this.error.set('کپی نشد؛ متن را دستی انتخاب کن.'); }
  }
  commitFailure() {
    const cf = this.task().health?.recovery?.commitFailure;
    return cf ? { ...cf, leftover: cf.leftover ?? [] } : null;
  }
  recoverMode(): 'process-attempt' | 'discard-residue' | null { return this.task().health?.recovery?.mode ?? null; }
  /** دلیل برای این اکشن اختیاری است؟ (rebase/provisioning و recover ِ process-attempt) */
  reasonOptional(p: Pending): boolean {
    return p === 'retry-rebase' || p === 'retry-provision' || p === 'recheck' || (p === 'recover' && this.recoverMode() !== 'discard-residue');
  }
  rebaseConflict(): boolean { return this.task().blocker?.kind === 'rebase-conflict'; }
  conflicts(): string[] | null { return conflictFiles(this.task()); }
  lockUnknown(): boolean { return lockNeedsForce(this.task().health?.transitionLock); }
  /** جدول ِ failedWrites ِ blocker ِ tooling/tool-write-failed (TOOLING-049)؛ دیگر blockerها ← null. */
  failedWritesView() { return failedWrites(this.task().blocker); }
  /** پیشنهاد ِ Manager (health.recovery.suggested) فقط وقتی recheck یا unblock است. */
  suggested(): 'recheck' | 'unblock' | null { return suggestedRecovery(this.task()); }
  recheckText(r: RecheckResult): string { return (r.result && RECHECK_RESULT[r.result]) || (r.result ? `نتیجه: ${r.result}` : 'نتیجه نامعلوم'); }
  title(p: Pending): string { return TITLES[p]; }
  hint(p: Pending): string {
    if (p === 'retry-provision') return this.stageText();
    if (p === 'recover') return this.recoverMode() === 'discard-residue' ? 'پوشه‌ی untracked با پشتیبان کنار گذاشته می‌شود (discard-residue).' : 'attempt ِ نیمه‌تمام را پردازش می‌کند (process-attempt).';
    return HINTS[p] ?? '';
  }
  dangerous(p: string): boolean { return DANGEROUS.has(p as Pending) || (p === 'recover' && this.recoverMode() === 'discard-residue'); }

  /**
   * سقف فعلی فیلد انتخاب‌شده برای نمایش و سنجش فرم: `budget[field].max` ِ status (فیلدهای *Runs)، یا مقدار همان فیلد
   * در blocker (maxAttempts/maxSpecRevisions). مجاز بودن raise-limit از actions آمده؛ این‌ها فقط نمایش‌اند.
   */
  currentLimit(): number | null {
    const t = this.task();
    const budget = t.budget?.[this.limitField]?.max;
    if (typeof budget === 'number') return budget;
    const fromBlocker = (t.blocker as Record<string, unknown> | null | undefined)?.[this.limitField];
    return typeof fromBlocker === 'number' ? fromBlocker : null;
  }
  usedLimit(): number | null {
    const used = this.task().budget?.[this.limitField]?.used;
    return typeof used === 'number' ? used : null;
  }
  /** `<n>` سقف تازه‌ی **کل** است و باید از سقف فعلی بزرگ‌تر باشد (Manager هم همین را می‌سنجد و پیامش عیناً نشان داده می‌شود). */
  limitTooLow(): boolean {
    const current = this.currentLimit();
    const value = Number(this.limitValue);
    return current !== null && Number.isInteger(value) && value <= current;
  }
  pickLimitField(field: string): void { this.limitField = field; this.limitValue = (this.currentLimit() ?? 0) + 5; }

  open(p: Pending, attempt = ''): void {
    this.reason = '';
    this.error.set('');
    this.path = '';
    this.toSha = '';
    this.force = false;
    this.attempt = attempt;
    this.access = 'write';
    this.sourceId = (p === 'reset-external' ? this.resetSources() : this.externalAccessSources())[0] ?? '';
    if (p === 'raise-limit') this.pickLimitField(this.limitFields()[0] ?? ''); // Manager فیلد سدکننده را اول می‌گذارد
    this.pending.set(p);
  }

  // --- فرم ---------------------------------------------------------------------------
  valid(p: Pending): boolean {
    if (!this.reasonOptional(p) && !this.reason.trim()) return false;
    switch (p) {
      case 'raise-limit': return !!this.limitField && Number.isInteger(Number(this.limitValue)) && Number(this.limitValue) >= 1 && !this.limitTooLow();
      case 'allow-path': case 'allow-shared-knowledge-file': return !!this.path.trim();
      case 'external-access': return !!this.sourceId;
      case 'reset-external': return !!this.sourceId && (!this.toSha.trim() || /^[0-9a-f]{7,40}$/i.test(this.toSha.trim()));
      case 'close-orphan': return !!this.attempt;
      default: return true;
    }
  }

  command(p: Pending): string {
    const id = this.task().id;
    const why = '--reason-file ‹متن دلیل›';
    switch (p) {
      case 'abandon': return `node scripts/manager.js abandon ${id} ${why}`;
      case 'cancel': return `node scripts/manager.js cancel ${id} ${why}`;
      case 'void': return `node scripts/manager.js void ${id} ${why}`;
      case 'unlock': return `node scripts/manager.js unlock ${id} ${why}${this.force ? ' --force' : ''}`;
      case 'unblock': return `node scripts/manager.js answer ${id} --unblock ${why}`;
      case 'retry-rebase': return `node scripts/manager.js answer ${id} --unblock ${why}  ←  سپس  node scripts/manager.js run ${id}`;
      case 'retry-provision': return `node scripts/manager.js answer ${id} --unblock ${why}  ←  سپس  node scripts/manager.js run ${id}`;
      case 'recheck': return `node scripts/manager.js recheck ${id}`;
      case 'recover': return `node scripts/manager.js recover ${id}${this.recoverMode() === 'discard-residue' ? ` --discard-residue --reason-file ‹متن دلیل›` : ''}`;
      case 'raise-limit': return `node scripts/manager.js answer ${id} --raise-limit ${this.limitField}=${this.limitValue} ${why}`;
      case 'close-orphan': return `node scripts/manager.js answer ${id} --close-orphan ${this.attempt} ${why}`;
      case 'allow-path': return `node scripts/manager.js answer ${id} --allow-path ${this.path.trim() || '‹مسیر›'} ${why}`;
      case 'allow-shared-knowledge-file': return `node scripts/manager.js answer ${id} --allow-shared-knowledge-file ${this.path.trim() || '‹مسیر›'} ${why}`;
      case 'external-access': return `node scripts/manager.js answer ${id} --external-access ${this.sourceId}=${this.access} ${why}`;
      case 'reset-external': return `node scripts/manager.js answer ${id} --reset-external ${this.sourceId}${this.toSha.trim() ? ' --to ' + this.toSha.trim() : ''} ${why}`;
    }
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
      this.afterStop.set(result.health ?? ({ stuck: false } as HealthStatus));
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
        case 'cancel': await firstValueFrom(this.api.cancelTask(repo, id, reason)); break;
        case 'void': await firstValueFrom(this.api.voidTask(repo, id, reason)); break;
        case 'unlock': await firstValueFrom(this.api.unlockTask(repo, id, reason, this.force)); break;
        case 'unblock': await firstValueFrom(this.api.unblockTask(repo, id, reason)); break;
        case 'retry-rebase': await firstValueFrom(this.api.retryRebase(repo, id, reason || undefined)); break;
        case 'retry-provision': await firstValueFrom(this.api.retryProvision(repo, id, reason || undefined)); break;
        case 'recheck': this.recheckResult.set(await firstValueFrom(this.api.recheckTask(repo, id))); break;
        case 'recover': await firstValueFrom(this.api.recoverTask(repo, id, this.recoverMode() === 'discard-residue' ? { discardResidue: true, reason } : {})); break;
        case 'raise-limit': await firstValueFrom(this.api.raiseLimit(repo, id, this.limitField, Number(this.limitValue), reason)); break;
        case 'close-orphan': await firstValueFrom(this.api.closeOrphan(repo, id, this.attempt, reason)); break;
        case 'allow-path': await firstValueFrom(this.api.allowPath(repo, id, this.path.trim(), reason)); break;
        case 'allow-shared-knowledge-file': await firstValueFrom(this.api.allowSharedKnowledgeFile(repo, id, this.path.trim(), reason)); break;
        case 'external-access': await firstValueFrom(this.api.externalAccess(repo, id, this.sourceId, this.access, reason)); break;
        case 'reset-external': await firstValueFrom(this.api.resetExternal(repo, id, this.sourceId, this.toSha.trim() || null, reason)); break;
      }
      this.pending.set(null);
      this.info.set('انجام شد.');
      this.changed.emit();
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }
}
