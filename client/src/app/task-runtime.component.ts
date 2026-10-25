import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AgentEvent, RuntimeOptions, RunningTask, StructuredFailure, Task } from './models';
import { can } from './task-actions';
import {
  RuntimeRow, Selection, attemptModelCell, buildSetRuntime, effectNote, effortsFor, liveAttempt, modelsFor, providerChoices,
  queuedRejections, reconcileSelection, runtimeInvalidText, runtimeRows
} from './runtime';

type Mode = 'set' | 'preset' | 'reset-role' | 'reset-all';

/**
 * بخش «مدل‌ها» در جزئیات کارت (TOOLING-046): provider / مدل / effort ِ **مؤثر** ِ هر نقش با منبع، تغییرهای در صف، runtime ِ
 * attempt ِ زنده، و dialog ِ تغییر. گزینه‌ها فقط از `runtime --options --json`. «مجاز است؟» فقط از `actions.setRuntime`.
 * تغییر از راه `answer <id> --runtime|--runtime-preset|--runtime-reset` (سرور) انجام می‌شود؛ کانبان فایل ِ .agent-work نمی‌نویسد.
 */
@Component({
  selector: 'ba-task-runtime',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="detail-section runtime-section">
      <div class="section-head"><div><h3>مدل‌ها</h3><p>provider، مدل و effort ِ مؤثر ِ هر مرحله — از Manager</p></div>
        @if (preset()) { <span class="count" title="preset ِ ذخیره‌شده در manifest">preset: {{ preset() }}</span> }</div>

      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
      @if (info()) { <div class="notice info"><span>{{ info() }}</span><button (click)="info.set('')">×</button></div> }

      @if (!task().runtime) {
        <div class="disabled-gate-warning">این Manager بلوک <code>runtime</code> را در <code>status --json</code> نمی‌دهد (قدیمی‌تر از TOOLING-046)؛ مدل‌ها نمایش داده نمی‌شوند.</div>
      } @else if (task().runtime!.error || !rows().length) {
        <div class="disabled-gate-warning">runtime این تسک resolve نشد: {{ task().runtime!.error || 'effective خالی است' }}</div>
      } @else {
        @for (w of warnings(); track w.decision) {
          <div class="disabled-gate-warning runtime-rejected">⚠ تغییر ِ runtime ِ در صف هنگام اعمال رد شد (تصمیم {{ w.decision ?? '؟' }}): {{ w.error }}@if (w.code) { <code>{{ w.code }}</code> }@if (w.reason) { · reason: {{ w.reason }} }</div>
        }
        @if (live(); as a) {
          <div class="runtime-live">attempt ِ زنده <b>#{{ a.id }}</b> ({{ a.role || '—' }}) با
            <code dir="ltr">{{ cell(a).model }}</code> · <code dir="ltr">{{ cell(a).effort }}</code> اجرا می‌شود.</div>
        }
        <table class="runtime-table">
          <thead><tr><th>نقش</th><th>provider</th><th>مدل</th><th>effort</th><th>منبع</th><th></th></tr></thead>
          <tbody>
            @for (r of rows(); track r.role) {
              <tr [class.current]="r.isCurrent" [class.has-error]="!!r.error">
                <td><b>{{ r.role }}</b>@if (r.isCurrent) { <span class="runtime-badge" title="نقش attempt ِ زنده / آخرین attempt">جاری</span> }</td>
                @if (r.error) {
                  <td colspan="4" class="bad">{{ r.error }}</td>
                } @else {
                  <td dir="ltr">{{ r.provider || '—' }}</td>
                  <td dir="ltr">{{ r.model || '—' }}</td>
                  <td dir="ltr">{{ r.effort || '—' }}</td>
                  <td><span class="runtime-source" [attr.title]="r.sourceTitle">{{ r.sourceText }}@if (r.sourceTitle) { <i>*</i> }</span></td>
                }
                <td class="runtime-actions">
                  <button class="secondary" [disabled]="!canSet() || busy() || !!r.error" [attr.title]="setTitle()" (click)="openSet(r)">تغییر</button>
                  @if (r.source === 'task-role' || r.source === 'task-preset') {
                    <button class="secondary" [disabled]="!canSet() || busy()" [attr.title]="setTitle()" (click)="openReset(r.role)">برگشت به پیش‌فرض</button>
                  }
                </td>
              </tr>
              @if (r.pending; as p) {
                <tr class="runtime-pending-row"><td colspan="6">
                  <span class="pending-badge">در انتظار اعمال →</span>
                  <code dir="ltr">{{ p.provider || '—' }}:{{ p.model || '—' }}:{{ p.effort || '—' }}</code>
                  @if (p.queuedAt) { <small>· {{ date(p.queuedAt) }}</small> }
                  @if (p.reason) { <small>· reason: {{ p.reason }}</small> }
                  <small>(فقط آخرین تغییر ِ در صف ِ هر نقش برنده است)</small>
                </td></tr>
              }
              @if (r.liveDiffers; as d) {
                <tr class="runtime-live-row"><td colspan="6"><small>attempt ِ زنده با runtime ِ دیگری شروع شد: <code dir="ltr">{{ d.provider }}:{{ d.requestedModel }}:{{ d.requestedEffort }}</code> (مؤثر ِ تازه از attempt ِ بعدی)</small></td></tr>
              }
            }
          </tbody>
        </table>
        <div class="danger-actions wrap">
          <button class="secondary" [disabled]="!canSet() || busy()" [attr.title]="setTitle()" (click)="openPreset()">تغییر preset ِ تسک</button>
          @if (hasOverrides()) { <button class="secondary" [disabled]="!canSet() || busy()" [attr.title]="setTitle()" (click)="openReset('all')">برگشت ِ همه به پیش‌فرض</button> }
        </div>
        @if (!canSet()) { <small class="hint">تغییر ِ runtime الان مجاز نیست (<code>actions.setRuntime = false</code>؛ تسک پایان‌یافته است یا اجرا روی این دستگاه خاموش است).</small> }
      }

      @if (mode(); as m) {
        <div class="confirm-box runtime-dialog">
          <b>{{ title() }}</b>
          @if (optionsError()) { <div class="disabled-gate-warning">{{ optionsError() }}</div> }
          @if (m === 'set') {
            <label><span>provider</span>
              <select name="rtProvider" dir="ltr" [ngModel]="sel().provider" (ngModelChange)="pickProvider($event)">
                @for (c of providers(); track c.id) { <option [value]="c.id" [disabled]="c.disabled" [attr.title]="c.reason">{{ c.id }}{{ c.reason ? ' — ' + c.reason : '' }}</option> }
              </select></label>
            <label><span>مدل</span>
              <select name="rtModel" dir="ltr" [ngModel]="sel().model" (ngModelChange)="pickModel($event)">
                @for (mo of models(); track mo.id) { <option [value]="mo.id">{{ mo.id }}{{ mo.aliases.length ? ' (' + mo.aliases.join('، ') + ')' : '' }}</option> }
              </select></label>
            <label><span>effort (مجاز برای همین مدل)</span>
              <select name="rtEffort" dir="ltr" [ngModel]="sel().effort" (ngModelChange)="pickEffort($event)">
                @for (e of efforts(); track e) { <option [value]="e">{{ e }}</option> }
              </select></label>
          }
          @if (m === 'preset') {
            <label><span>preset</span>
              <select name="rtPreset" dir="ltr" [(ngModel)]="presetPick">
                @for (p of presetNames(); track p) { <option [value]="p">{{ p }}</option> }
              </select></label>
          }
          @if (m === 'reset-role') { <small>نقش «{{ resetTarget }}» به پیش‌فرض برمی‌گردد (override ِ همین تسک پاک می‌شود).</small> }
          @if (m === 'reset-all') { <small>همه‌ی override ها و preset ِ این تسک پاک می‌شود و runtime به پیش‌فرض برمی‌گردد.</small> }
          <small class="resume-note">{{ note() }}</small>
          <textarea name="rtReason" [(ngModel)]="reason" placeholder="reason (اجباری) — به انگلیسی بنویس…"></textarea>
          <small>فرمان نهایی:</small>
          <code class="final-command" dir="ltr">{{ command() }}</code>
          <div class="danger-confirm-actions">
            <button class="secondary" (click)="close()">انصراف</button>
            <button class="primary" [disabled]="busy() || !!invalid()" [attr.title]="invalid()" (click)="confirm()">تأیید نهایی</button>
          </div>
        </div>
      }
    </section>
  `
})
export class TaskRuntimeComponent {
  private readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly task = input.required<Task>();
  readonly running = input<RunningTask | undefined>(undefined);
  readonly events = input<AgentEvent[]>([]);
  readonly changed = output<void>();

  readonly options = signal<RuntimeOptions | null>(null);
  readonly optionsError = signal('');
  readonly mode = signal<Mode | null>(null);
  readonly sel = signal<Selection>({ provider: '', model: '', effort: '' });
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');
  reason = '';
  presetPick = 'default';
  resetTarget = '';
  private readonly role = signal('');

  readonly rows = computed<RuntimeRow[]>(() => runtimeRows(this.task(), this.options()?.roles));
  readonly warnings = computed(() => queuedRejections(this.events() as ReadonlyArray<Record<string, unknown>>));
  readonly live = computed(() => liveAttempt(this.task()));
  readonly preset = computed(() => this.task().runtime?.stored?.preset ?? null);
  readonly hasOverrides = computed(() => !!this.preset() || Object.keys(this.task().runtime?.stored?.roles ?? {}).length > 0);
  readonly providers = computed(() => providerChoices(this.options(), this.role()));
  readonly models = computed(() => modelsFor(this.options(), this.sel().provider));
  readonly efforts = computed(() => effortsFor(this.options(), this.sel().provider, this.sel().model));
  readonly presetNames = computed(() => Object.keys(this.options()?.presets ?? { default: {} }));

  canSet(): boolean { return can(this.task(), 'setRuntime'); }
  setTitle(): string | null { return this.canSet() ? null : 'actions.setRuntime = false'; }
  cell = attemptModelCell;
  date(value: string): string { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('fa-IR') : value; }

  note(): string { return effectNote(this.task(), this.running()?.running === true); }
  title(): string {
    switch (this.mode()) {
      case 'set': return `تغییر ِ runtime ِ نقش «${this.role()}»`;
      case 'preset': return 'تغییر ِ preset ِ تسک';
      case 'reset-role': return `برگشت ِ نقش «${this.resetTarget}» به پیش‌فرض`;
      default: return 'برگشت ِ همه به پیش‌فرض';
    }
  }

  private current() { return this.task().runtime?.effective?.[this.role()]; }

  private async ensureOptions(): Promise<void> {
    if (this.options()) return;
    this.optionsError.set('');
    try { this.options.set(await firstValueFrom(this.api.runtimeOptions(this.repoId()))); }
    catch (e) { this.optionsError.set(`گزینه‌ها از Manager خوانده نشد (runtime --options): ${this.message(e)}`); }
  }

  async openSet(row: RuntimeRow): Promise<void> {
    this.reset();
    this.role.set(row.role);
    this.mode.set('set');
    await this.ensureOptions();
    this.sel.set(reconcileSelection(this.options(), { provider: row.provider ?? '', model: row.requestedModel ?? row.model ?? '', effort: row.effort ?? '' }));
  }
  async openPreset(): Promise<void> {
    this.reset();
    this.mode.set('preset');
    this.presetPick = this.preset() ?? 'default';
    await this.ensureOptions();
  }
  openReset(target: string): void {
    this.reset();
    this.resetTarget = target;
    this.mode.set(target === 'all' ? 'reset-all' : 'reset-role');
  }
  close(): void { this.mode.set(null); }
  private reset(): void { this.reason = ''; this.error.set(''); this.info.set(''); this.optionsError.set(''); }

  pickProvider(provider: string): void { this.sel.set(reconcileSelection(this.options(), { ...this.sel(), provider })); }
  pickModel(model: string): void { this.sel.set(reconcileSelection(this.options(), { ...this.sel(), model })); }
  pickEffort(effort: string): void { this.sel.set({ ...this.sel(), effort }); }

  /** دلیل ِ غیرفعال بودن ِ «تأیید» (null = معتبر). reason ِ خالی رد می‌شود. */
  invalid(): string | null {
    if (!this.reason.trim()) return 'reason الزامی است';
    if (this.mode() === 'set') {
      const built = buildSetRuntime(this.role(), this.current(), this.sel(), this.reason);
      return built.ok ? null : built.error;
    }
    if (this.mode() === 'preset' && !this.presetPick) return 'preset را انتخاب کن';
    return null;
  }

  command(): string {
    const id = this.task().id;
    const why = '--reason-file ‹reason›';
    switch (this.mode()) {
      case 'set': {
        const built = buildSetRuntime(this.role(), this.current(), this.sel(), this.reason || 'x');
        return built.ok ? `node scripts/manager.js answer ${id} --runtime ${built.body.role}=${built.body.provider}:${built.body.model}:${built.body.effort} ${why}` : '—';
      }
      case 'preset': return `node scripts/manager.js answer ${id} --runtime-preset ${this.presetPick} ${why}`;
      case 'reset-role': return `node scripts/manager.js answer ${id} --runtime-reset ${this.resetTarget} ${why}`;
      default: return `node scripts/manager.js answer ${id} --runtime-reset all ${why}`;
    }
  }

  private message(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const structured = e.error?.structured as StructuredFailure | undefined;
      const invalid = runtimeInvalidText(structured);
      return invalid ? invalid.text : (e.error?.error ?? e.message);
    }
    return String(e);
  }

  async confirm(): Promise<void> {
    const mode = this.mode();
    if (!mode || this.invalid()) return;
    const repo = this.repoId();
    const id = this.task().id;
    const reason = this.reason.trim();
    let body: Record<string, unknown>;
    if (mode === 'set') {
      const built = buildSetRuntime(this.role(), this.current(), this.sel(), this.reason);
      if (!built.ok) return;
      body = { ...built.body };
    } else if (mode === 'preset') body = { mode: 'preset', preset: this.presetPick, reason };
    else body = { mode: 'reset', target: mode === 'reset-all' ? 'all' : this.resetTarget, reason };
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await firstValueFrom(this.api.setRuntime(repo, id, body));
      this.mode.set(null);
      this.info.set(result.queued
        ? 'تغییر در صف نشست؛ در شروع ِ attempt ِ بعدی اعمال می‌شود (رویداد runtime.changed با appliedAtAttempt).'
        : 'runtime عوض شد؛ از attempt ِ بعدی اعمال می‌شود (رویداد runtime.changed).');
      this.changed.emit();
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }
}
