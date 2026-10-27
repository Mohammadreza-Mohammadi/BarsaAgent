import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { Task } from './models';
import { can } from './task-actions';
import { dependencyLabel, dependencyView, hasPeerProblem } from './task-extras';

/**
 * دروازه‌ی تأیید ِ وابستگی (TOOLING-050 هـ). وقتی `awaitingHuman.kind = dependency-approval`: برای هر وابستگی نام/نسخه/dev/دلیل/license،
 * جدول ِ peerها (قرمز اگر نمی‌خواند)، `hasInstallScript`، یا اگر `info.known=false` دلیل. دکمه‌های تأیید/رد با reason ِ اجباری (انگلیسی)؛
 * با `peersOk: false` تأیید یک تأیید ِ دوم می‌خواهد. مجاز بودن فقط از `actions.approveDependencies/rejectDependencies`.
 * بیرون از دروازه، وابستگی‌های ِ تأییدشده (`task.dependencies`) فقط‌خواندنی نشان داده می‌شوند.
 */
@Component({
  selector: 'ba-task-dependencies',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (view(); as v) {
      <section class="detail-section dep-gate">
        <div class="section-head"><div><h3>تأیید ِ وابستگی</h3>
          <p>Architect بسته‌ی npm پیشنهاد داده؛ Manager اطلاعاتش را از registry گرفته. attempt {{ v.attempt }} · {{ date(v.requestedAt) }}</p></div></div>
        @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
        @if (info()) { <div class="notice info"><span>{{ info() }}</span><button (click)="info.set('')">×</button></div> }
        @if (peerProblem()) {
          <div class="disabled-gate-warning dep-peer-warning">⚠ حداقل یک peer با نسخه‌ی نصب‌شده نمی‌خواند؛ نصب ممکن است با <code>ERESOLVE</code> بشکند.</div>
        }
        @for (d of v.dependencies; track d.name) {
          <div class="dep-card">
            <div class="dep-head"><b dir="ltr">{{ label(d) }}</b>@if (d.dev) { <span class="att-badge">dev</span> }
              @if (d.hasInstallScript === true) { <span class="att-badge warn" title="postinstall/install دارد؛ Manager با --ignore-scripts نصب می‌کند">hasInstallScript</span> }</div>
            <p class="dep-reason">دلیل ِ Architect: {{ d.reason }}</p>
            @if (!d.known) {
              <div class="disabled-gate-warning">اطلاعات ِ registry گرفته نشد: {{ d.error }}</div>
            } @else {
              <small>license: <b dir="ltr">{{ d.license || '—' }}</b> · hasInstallScript: <b>{{ d.hasInstallScript === true ? 'بله' : d.hasInstallScript === false ? 'خیر' : 'نامعلوم' }}</b></small>
              @if (d.peers.length) {
                <table class="dep-peers">
                  <thead><tr><th>peer</th><th>بازه</th><th>نسخه‌ی نصب‌شده</th><th>وضعیت</th></tr></thead>
                  <tbody>
                    @for (p of d.peers; track p.name) {
                      <tr [class.bad]="p.status === 'bad'">
                        <td dir="ltr">{{ p.name }}@if (p.optional) { <i> (اختیاری)</i> }</td><td dir="ltr">{{ p.range }}</td><td dir="ltr">{{ p.installed || '—' }}</td>
                        <td>{{ p.status === 'ok' ? '✓ می‌خواند' : p.status === 'bad' ? '✗ نمی‌خواند' : '؟ سنجیده نشد' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else { <small>peerDependencies ندارد.</small> }
            }
          </div>
        }

        <label class="answer-box"><span>دلیل (اجباری؛ <b>به انگلیسی</b> بنویس)</span>
          <textarea dir="ltr" [(ngModel)]="reason" placeholder="e.g. Needed for X; license MIT; peers OK."></textarea></label>
        @if (confirmPeers()) {
          <div class="confirm-box"><b>peer ِ ناسازگار هست — مطمئنی؟</b>
            <small>با این حال تأیید یعنی Manager نصب را امتحان می‌کند و ممکن است با ERESOLVE بشکند (تسک مسدود می‌شود، budget مصرف نمی‌شود).</small>
            <div class="danger-confirm-actions">
              <button class="secondary" (click)="confirmPeers.set(false)">انصراف</button>
              <button class="danger" [disabled]="busy() || !reasonOk()" (click)="decide('approve')">بله، با وجود peer ِ ناسازگار تأیید کن</button>
            </div>
          </div>
        }
        <div class="danger-actions">
          <button class="danger" [disabled]="busy() || !reasonOk() || !canReject()" [title]="canReject() ? '' : 'actions.rejectDependencies = false'" (click)="decide('reject')">رد (برگشت به Architect)</button>
          <button class="primary" [disabled]="busy() || !reasonOk() || !canApprove()" [title]="canApprove() ? '' : 'actions.approveDependencies = false'" (click)="approve()">تأیید ِ وابستگی</button>
        </div>
      </section>
    } @else if (approved().length) {
      <section class="detail-section dep-approved">
        <div class="section-head"><div><h3>وابستگی‌های ِ تأییدشده</h3><p>Manager در provisioning بعد از npm ci نصبشان می‌کند.</p></div><span class="count">{{ approved().length }}</span></div>
        <ul>@for (d of approved(); track d.name) { <li><b dir="ltr">{{ label(d) }}</b> — {{ d.reason }}</li> }</ul>
      </section>
    }
  `
})
export class TaskDependenciesComponent {
  private readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly task = input.required<Task>();
  readonly changed = output<void>();

  reason = '';
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  readonly confirmPeers = signal(false);

  readonly view = computed(() => dependencyView(this.task()));
  readonly approved = computed(() => this.task().dependencies ?? []);
  readonly peerProblem = computed(() => hasPeerProblem(this.task()));

  label = dependencyLabel;
  date(value: string): string { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('fa-IR') : value; }
  reasonOk(): boolean { return this.reason.trim().length > 0; }
  canApprove(): boolean { return can(this.task(), 'approveDependencies'); }
  canReject(): boolean { return can(this.task(), 'rejectDependencies'); }

  /** با peer ِ ناسازگار اول تأیید ِ دوم؛ وگرنه مستقیم. */
  approve(): void {
    if (this.peerProblem()) { this.confirmPeers.set(true); return; }
    void this.decide('approve');
  }

  async decide(mode: 'approve' | 'reject'): Promise<void> {
    const reason = this.reason.trim();
    if (!reason) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const call = mode === 'approve' ? this.api.approveDependencies : this.api.rejectDependencies;
      const result = await firstValueFrom(call(this.repoId(), this.task().id, reason));
      this.confirmPeers.set(false);
      this.reason = '';
      this.info.set(`${mode === 'approve' ? 'وابستگی‌ها تأیید شد' : 'وابستگی‌ها رد شد (برگشت به Architect)'}${result.autoResumed ? '؛ کانبان خودش run می‌زند' : ''}.`);
      this.changed.emit();
    } catch (e) {
      this.error.set(e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e));
    } finally { this.busy.set(false); }
  }
}
