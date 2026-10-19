import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Task } from './models';
import { ArchiveSortKey, FINISHED_STATES, archiveTasks, finishedAt, queryArchive } from './task-archive';

const PAGE_SIZE = 25;

/**
 * تب «آرشیو»: taskهای پایان‌یافته (integrated / cancelled / abandoned) در یک جدول فشرده.
 * فهرست «پایان‌یافته» و منطق جست‌وجو/فیلتر/مرتب‌سازی از task-archive.ts می‌آید؛ اینجا فقط نمایش.
 * کلیک روی ردیف همان کشوی جزئیات task را باز می‌کند (رویدادها، شواهد، zip).
 */
@Component({
  selector: 'ba-archive',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="ops-page archive-page">
      <div class="section-head"><div><h2>آرشیو</h2><p>{{ all().length }} task پایان‌یافته · {{ result().total }} مورد مطابق فیلتر</p></div></div>

      <div class="archive-filters">
        <label class="grow"><span>جست‌وجو (عنوان یا شماره)</span><input type="search" name="search" [ngModel]="search()" (ngModelChange)="setSearch($event)" placeholder="مثلاً 10013 یا بخشی از عنوان"></label>
        <label><span>state</span>
          <select name="state" [ngModel]="state()" (ngModelChange)="setState($event)">
            <option value="">همه</option>
            @for (s of states; track s) { <option [value]="s">{{ s }}</option> }
          </select></label>
        <label><span>از تاریخ</span><input type="date" name="from" [ngModel]="from()" (ngModelChange)="setFrom($event)"></label>
        <label><span>تا تاریخ</span><input type="date" name="to" [ngModel]="to()" (ngModelChange)="setTo($event)"></label>
        @if (filtered()) { <button class="secondary" (click)="reset()">پاک کردن فیلترها</button> }
      </div>

      <table class="wt-table archive-table">
        <thead>
          <tr>
            <th><button class="sort" (click)="sortBy('id')">شماره{{ arrow('id') }}</button></th>
            <th><button class="sort" (click)="sortBy('title')">عنوان{{ arrow('title') }}</button></th>
            <th><button class="sort" (click)="sortBy('state')">state{{ arrow('state') }}</button></th>
            <th><button class="sort" (click)="sortBy('finishedAt')">تاریخ پایان{{ arrow('finishedAt') }}</button></th>
            <th><button class="sort" (click)="sortBy('externalId')">ایشو بیرونی{{ arrow('externalId') }}</button></th>
            <th>commit ادغام</th>
          </tr>
        </thead>
        <tbody>
          @for (t of result().rows; track t.id) {
            <tr class="archive-row" tabindex="0" (click)="open.emit(t)" (keydown.enter)="open.emit(t)">
              <td dir="ltr"><code>#{{ t.id }}</code></td>
              <td>{{ t.releaseNote?.headline || t.title || t.slug || '—' }}</td>
              <td><span class="badge" [class.ok]="t.state === 'integrated'" [class.bad]="t.state === 'abandoned'">{{ t.state }}</span></td>
              <td dir="ltr">{{ dateLabel(t) }}</td>
              <td dir="ltr">{{ t.source?.externalId || '—' }}</td>
              <td dir="ltr"><code>{{ t.git?.mergeCommit ? t.git!.mergeCommit!.slice(0, 8) : '—' }}</code></td>
            </tr>
          } @empty {
            <tr><td colspan="6" class="archive-empty">{{ all().length ? 'هیچ موردی با این فیلتر نیست.' : 'هنوز taskی پایان نیافته.' }}</td></tr>
          }
        </tbody>
      </table>

      <div class="archive-pager">
        <button class="secondary" [disabled]="result().page <= 1" (click)="goto(result().page - 1)">قبلی</button>
        <span>صفحه {{ result().page }} از {{ result().pages }}</span>
        <button class="secondary" [disabled]="result().page >= result().pages" (click)="goto(result().page + 1)">بعدی</button>
      </div>
    </section>
  `
})
export class ArchiveComponent {
  readonly tasks = input.required<Task[]>();
  readonly open = output<Task>();
  readonly states = FINISHED_STATES;

  readonly search = signal('');
  readonly state = signal('');
  readonly from = signal('');
  readonly to = signal('');
  readonly sortKey = signal<ArchiveSortKey>('finishedAt');
  readonly sortDir = signal<'asc' | 'desc'>('desc'); // پیش‌فرض: جدیدترین بالا
  readonly page = signal(1);

  readonly all = computed(() => archiveTasks(this.tasks()));
  readonly result = computed(() => queryArchive(this.tasks(), {
    search: this.search(), states: this.state() ? [this.state()] : [], from: this.from(), to: this.to(),
    sortKey: this.sortKey(), sortDir: this.sortDir(), page: this.page(), pageSize: PAGE_SIZE
  }));

  filtered(): boolean { return !!(this.search() || this.state() || this.from() || this.to()); }

  // هر تغییر فیلتر به صفحه‌ی اول برمی‌گردد
  setSearch(v: string): void { this.search.set(v); this.page.set(1); }
  setState(v: string): void { this.state.set(v); this.page.set(1); }
  setFrom(v: string): void { this.from.set(v); this.page.set(1); }
  setTo(v: string): void { this.to.set(v); this.page.set(1); }
  reset(): void { this.search.set(''); this.state.set(''); this.from.set(''); this.to.set(''); this.page.set(1); }
  goto(page: number): void { this.page.set(page); }

  sortBy(key: ArchiveSortKey): void {
    if (this.sortKey() === key) this.sortDir.update(d => (d === 'asc' ? 'desc' : 'asc'));
    else { this.sortKey.set(key); this.sortDir.set(key === 'finishedAt' || key === 'id' ? 'desc' : 'asc'); }
    this.page.set(1);
  }

  arrow(key: ArchiveSortKey): string { return this.sortKey() === key ? (this.sortDir() === 'asc' ? ' ▲' : ' ▼') : ''; }

  dateLabel(t: Task): string {
    const d = finishedAt(t);
    return d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '—';
  }
}
