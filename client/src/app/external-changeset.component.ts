import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { Task } from './models';
import { ExternalChangesetRow, externalChangesets, parseChangesetInput } from './task-extras';

/**
 * changeset ِ مؤثر ِ منبع ِ بیرونی (TOOLING-051 و). `declaredChangesets` را Manager می‌دهد (`[]` = ثبت نشده)؛ اگر تسک integrated است و ثبت نشده هشدار.
 * وقتی `externalSources[].actions.canDeclareChangeset` درست است فرم ِ «ثبت changeset»: شماره(ها)، reason ِ اجباری (انگلیسی)، و «جایگزینی»
 * (\`--replace\`) که فقط با مقدار ِ قبلی فعال است و تأیید ِ دوم می‌خواهد. مجاز بودن و تاریخچه‌ی TFVC را Manager می‌سنجد؛ خطایش عیناً می‌آید.
 */
@Component({
  selector: 'ba-external-changeset',
  standalone: true,
  imports: [FormsModule],
  template: `
    @if (rows().length) {
      <section class="detail-section external-changeset">
        <div class="section-head"><div><h3>changeset ِ منبع ِ بیرونی</h3><p>شماره‌ی ِ check-in در TFS؛ Manager آن را با تاریخچه‌ی TFVC می‌سنجد.</p></div></div>
        @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
        @if (info()) { <div class="notice info"><span>{{ info() }}</span><button (click)="info.set('')">×</button></div> }
        @for (r of rows(); track r.id) {
          <div class="cs-row">
            <b dir="ltr">{{ r.id }}</b>
            @if (r.declared.length) { <span class="cs-values" dir="ltr">{{ r.declared.join('، ') }}</span> }
            @else { <span class="cs-none">ثبت نشده</span> }
            @if (r.checkedIn.length && r.checkedIn.join() !== r.declared.join()) { <small>check-in ِ آخر: <span dir="ltr">{{ r.checkedIn.join('، ') }}</span></small> }
            @if (r.missing) { <div class="disabled-gate-warning">⚠ changeset ثبت نشده؛ تسک integrated شده ولی شماره‌ی check-in اعلام نشده است.</div> }
            @if (r.canDeclare) {
              <button class="secondary" [disabled]="busy() || disabled()" (click)="open(r)">ثبت changeset…</button>
            }
          </div>
        }
        @if (form(); as f) {
          <div class="confirm-box">
            <b>ثبت changeset برای «{{ f.id }}»</b>
            <label><span>شماره‌ی changeset (یک یا چند؛ با کاما یا فاصله)</span><input dir="ltr" name="csList" [(ngModel)]="list" placeholder="17800 یا C17800,C17803"></label>
            @if (list.trim() && !parsed()) { <small class="bad">فقط شماره (با C اختیاری)، حداکثر ۲۰ تا.</small> }
            <label><span>دلیل (اجباری؛ <b>به انگلیسی</b>)</span><textarea dir="ltr" name="csReason" [(ngModel)]="reason" placeholder="e.g. Checked in as C17800 after review"></textarea></label>
            <label class="force-check"><input type="checkbox" name="csReplace" [(ngModel)]="replace" [disabled]="!f.declared.length">
              جایگزینی (<code>--replace</code>)@if (!f.declared.length) { <small> — مقدار ِ قبلی نیست</small> }</label>
            @if (replace && f.declared.length) {
              <label class="force-check"><input type="checkbox" name="csConfirm" [(ngModel)]="confirmReplace"> مطمئنم؛ مقدار ِ قبلی (<span dir="ltr">{{ f.declared.join('، ') }}</span>) عوض می‌شود.</label>
            }
            <small>فرمان: <code class="final-command" dir="ltr">{{ command(f) }}</code></small>
            <div class="danger-confirm-actions">
              <button class="secondary" (click)="form.set(null)">انصراف</button>
              <button class="primary" [disabled]="busy() || !valid(f)" (click)="submit(f)">ثبت</button>
            </div>
          </div>
        }
      </section>
    }
  `
})
export class ExternalChangesetComponent {
  private readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly task = input.required<Task>();
  readonly disabled = input(false);
  readonly changed = output<void>();

  readonly rows = computed(() => externalChangesets(this.task()));
  readonly form = signal<ExternalChangesetRow | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  list = '';
  reason = '';
  replace = false;
  confirmReplace = false;

  parsed(): string | null { return parseChangesetInput(this.list); }

  open(row: ExternalChangesetRow): void {
    this.list = ''; this.reason = ''; this.replace = false; this.confirmReplace = false;
    this.error.set(''); this.info.set('');
    this.form.set(row);
  }

  valid(row: ExternalChangesetRow): boolean {
    return !!this.parsed() && !!this.reason.trim() && (!this.replace || (row.declared.length > 0 && this.confirmReplace));
  }

  command(row: ExternalChangesetRow): string {
    return `node scripts/manager.js answer ${this.task().id} --external-changeset ${row.id} ${this.parsed() ?? '‹C…›'} --reason-file ‹متن دلیل›${this.replace ? ' --replace' : ''}`;
  }

  async submit(row: ExternalChangesetRow): Promise<void> {
    const changesets = this.parsed();
    if (!changesets || !this.valid(row)) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await firstValueFrom(this.api.declareChangeset(this.repoId(), this.task().id, { sourceId: row.id, changesets, reason: this.reason.trim(), replace: this.replace }));
      this.form.set(null);
      this.info.set(`changeset ِ «${row.id}» ثبت شد: ${changesets.split(',').join('، ')}.`);
      this.changed.emit();
    } catch (e) {
      this.error.set(e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e));
    } finally { this.busy.set(false); }
  }
}
