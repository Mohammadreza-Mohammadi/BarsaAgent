import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CreateRuntimeDraft, presetBaseline, providerChoices, modelsFor, effortsFor, reconcileSelection, Selection } from './runtime';
import { RuntimeOptions } from './models';

/**
 * انتخاب ِ preset و (در بخش جمع‌شده‌ی «پیشرفته») provider / مدل / effort ِ هر مرحله هنگام ساخت ِ تسک (TOOLING-046).
 * گزینه‌ها فقط از `runtime --options --json`. فقط ردیف‌هایی که انسان عوض کرده به Manager می‌رود (createRuntimePayload)؛
 * اعتبارسنجی ِ نهایی با Manager است و خطا کنار همان ردیف نشان داده می‌شود.
 */
@Component({
  selector: 'ba-runtime-picker',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="runtime-picker">
      @if (!options()) {
        <small class="hint">گزینه‌های مدل از Manager خوانده نشد؛ تسک با پیش‌فرض ساخته می‌شود.</small>
      } @else {
        <label class="runtime-preset"><span>preset ِ مدل‌ها</span>
          <select dir="ltr" name="rtCreatePreset" [ngModel]="preset()" (ngModelChange)="setPreset($event)">
            @for (p of presetNames(); track p) { <option [value]="p">{{ p }}</option> }
          </select></label>
        @if (presetError()) { <small class="bad">{{ presetError() }}</small> }
        <details class="runtime-advanced" [open]="hasChanges() || hasErrors()">
          <summary>پیشرفته: provider، مدل و effort ِ هر مرحله{{ hasChanges() ? ' (عوض‌شده)' : '' }}</summary>
          <table class="runtime-table">
            <thead><tr><th>نقش</th><th>provider</th><th>مدل</th><th>effort</th><th></th></tr></thead>
            <tbody>
              @for (r of rows(); track r.role) {
                <tr [class.changed]="r.changed" [class.has-error]="!!errors()[r.role]">
                  <td><b>{{ r.role }}</b></td>
                  <td><select dir="ltr" [name]="'rtp-' + r.role" [ngModel]="r.sel.provider" (ngModelChange)="set(r.role, 'provider', $event)">
                    @for (c of r.providers; track c.id) { <option [value]="c.id" [disabled]="c.disabled" [attr.title]="c.reason">{{ c.id }}{{ c.reason ? ' — ' + c.reason : '' }}</option> }
                  </select></td>
                  <td><select dir="ltr" [name]="'rtm-' + r.role" [ngModel]="r.sel.model" (ngModelChange)="set(r.role, 'model', $event)">
                    @for (m of r.models; track m.id) { <option [value]="m.id">{{ m.id }}</option> }
                  </select></td>
                  <td><select dir="ltr" [name]="'rte-' + r.role" [ngModel]="r.sel.effort" (ngModelChange)="set(r.role, 'effort', $event)">
                    @for (e of r.efforts; track e) { <option [value]="e">{{ e }}</option> }
                  </select></td>
                  <td>@if (r.changed) { <button type="button" class="secondary" (click)="clear(r.role)">پیش‌فرض</button> }</td>
                </tr>
                @if (errors()[r.role]; as err) { <tr class="runtime-error-row"><td colspan="5" class="bad">{{ err }}</td></tr> }
              }
            </tbody>
          </table>
          <small class="hint">فقط ردیف‌هایی که عوض کنی به Manager فرستاده می‌شود؛ بقیه از preset و پیش‌فرض می‌آید. رد شدن ِ Manager یعنی هیچ تسکی ساخته نشده.</small>
        </details>
      }
    </section>
  `
})
export class RuntimePickerComponent {
  readonly options = input<RuntimeOptions | null>(null);
  readonly value = input<CreateRuntimeDraft | undefined>(undefined);
  /** خطای اعتبارسنجی ِ Manager به‌تفکیک نقش. */
  readonly errors = input<Record<string, string>>({});
  readonly presetError = input<string>('');
  readonly valueChange = output<CreateRuntimeDraft>();

  readonly preset = computed(() => this.value()?.preset ?? 'default');
  readonly presetNames = computed(() => Object.keys(this.options()?.presets ?? { default: {} }));
  readonly baseline = computed(() => presetBaseline(this.options(), this.preset()));

  readonly rows = computed(() => {
    const options = this.options();
    const base = this.baseline();
    const touched = this.value()?.roles ?? {};
    return (options?.roles ?? []).map(role => {
      const b = base[role] ?? { provider: '', model: '', effort: '' };
      const t = touched[role];
      const sel: Selection = { provider: t?.provider ?? b.provider, model: t?.model ?? b.model, effort: t?.effort ?? b.effort };
      return {
        role, sel, changed: !!t,
        providers: providerChoices(options, role), models: modelsFor(options, sel.provider), efforts: effortsFor(options, sel.provider, sel.model)
      };
    });
  });

  hasChanges(): boolean { return Object.keys(this.value()?.roles ?? {}).length > 0; }
  hasErrors(): boolean { return Object.keys(this.errors()).length > 0 || !!this.presetError(); }

  setPreset(preset: string): void {
    // با عوض شدن ِ preset ردیف‌های دستی می‌مانند (انسان صریحاً عوض‌شان کرده)؛ فقط baseline عوض می‌شود.
    this.valueChange.emit({ preset, roles: { ...(this.value()?.roles ?? {}) } });
  }

  set(role: string, field: 'provider' | 'model' | 'effort', raw: string): void {
    const row = this.rows().find(r => r.role === role);
    if (!row) return;
    const next = field === 'effort' ? { ...row.sel, effort: raw } : reconcileSelection(this.options(), { ...row.sel, [field]: raw });
    const b = this.baseline()[role];
    const roles = { ...(this.value()?.roles ?? {}) };
    if (b && next.provider === b.provider && next.model === b.model && next.effort === b.effort) delete roles[role];
    else roles[role] = next;
    this.valueChange.emit({ preset: this.preset(), roles });
  }

  clear(role: string): void {
    const roles = { ...(this.value()?.roles ?? {}) };
    delete roles[role];
    this.valueChange.emit({ preset: this.preset(), roles });
  }
}
