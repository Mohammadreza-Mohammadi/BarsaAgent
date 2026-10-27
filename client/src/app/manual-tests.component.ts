import { Component, computed, effect, input, signal } from '@angular/core';
import { Task } from './models';
import { atMergeGate, checklistStorageKey, manualChecklist, testsProblemsWarning } from './task-extras';

/**
 * چک‌لیست ِ تست‌های دستی بالای دکمه‌ی تأیید ِ دروازه‌ی merge (TOOLING-050 ب). `tests.manualCases` را Manager می‌دهد؛ تیک‌ها **فقط در مرورگر ِ
 * همین کاربر** می‌مانند (localStorage) و یادآوری‌اند، نه شرط ِ approve — تصمیم‌گیرنده Manager است و این کامپوننت هیچ چیز را غیرفعال نمی‌کند.
 */
@Component({
  selector: 'ba-manual-tests',
  standalone: true,
  template: `
    @if (visible()) {
      <section class="manual-tests">
        <header><b>☑ تست‌های دستی پیش از تأیید</b>
          @if (checklist(); as c) { <small>{{ doneCount() }} از {{ c.items.length }} تیک خورده — یادآوری است، approve را شرطی نمی‌کند</small> }</header>
        @if (warning(); as w) { <div class="disabled-gate-warning" title="tests.problems">⚠ tests.md: {{ w }}</div> }
        @if (checklist(); as c) {
          <ul>
            @for (item of c.items; track item.id) {
              <li><label>
                <input type="checkbox" [checked]="isChecked(item.id)" (change)="toggle(item.id, $any($event.target).checked)">
                <code dir="ltr">{{ item.id }}</code>
                @if (item.section) { <small class="mt-section">{{ item.section }}</small> }
                <span>{{ item.summary }}</span>
              </label></li>
            }
          </ul>
        }
      </section>
    }
  `
})
export class ManualTestsComponent {
  readonly repoId = input.required<string>();
  readonly task = input.required<Task>();
  private readonly checked = signal<ReadonlySet<string>>(new Set());

  readonly checklist = computed(() => manualChecklist(this.task()));
  readonly warning = computed(() => (atMergeGate(this.task()) ? testsProblemsWarning(this.task()) : null));
  readonly visible = computed(() => !!this.checklist() || !!this.warning());
  readonly doneCount = computed(() => (this.checklist()?.items ?? []).filter(item => this.checked().has(item.id)).length);

  constructor() {
    // کلید شامل ِ headCommit است: بعد از تغییر ِ کد چک‌لیست دوباره از صفر شروع می‌شود.
    effect(() => {
      const key = checklistStorageKey(this.repoId(), this.task());
      let loaded: string[] = [];
      try { loaded = JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; } catch { /* ذخیره اختیاری است */ }
      this.checked.set(new Set(Array.isArray(loaded) ? loaded.filter(x => typeof x === 'string') : []));
    });
  }

  isChecked(id: string): boolean { return this.checked().has(id); }

  toggle(id: string, value: boolean): void {
    const next = new Set(this.checked());
    if (value) next.add(id); else next.delete(id);
    this.checked.set(next);
    try { localStorage.setItem(checklistStorageKey(this.repoId(), this.task()), JSON.stringify([...next])); } catch { /* ذخیره اختیاری است */ }
  }
}
