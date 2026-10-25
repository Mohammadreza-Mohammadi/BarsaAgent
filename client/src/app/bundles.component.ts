import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { BundleItem } from './models';

/**
 * bundleهای تشخیصی: zip ِ پوشانده‌شده‌ی پوشه‌ی تسک + diag + لاگ آخرین اجرا (همان `barsa bundle <id>` ِ Remote Control).
 * دانلود فقط با نام ساده‌ی فایل از <dataDir>/bundles؛ سرور هر نام دیگری (مسیر، `..`) را رد می‌کند.
 */
@Component({
  selector: 'ba-bundles',
  standalone: true,
  imports: [FormsModule],
  template: `
    <section class="ops-page">
      <div class="section-head"><div><h2>bundleهای تشخیصی</h2>
        <p>zip ِ پوشانده‌شده (راز و توکن حذف می‌شود) برای فرستادن به مشاور. از گوشی هم با <code dir="ltr">barsa bundle &lt;id&gt;</code> ساخته می‌شود.</p></div>
        <button class="secondary" (click)="load()">↻ تازه‌سازی</button></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
      @if (notice()) { <div class="notice"><span>{{ notice() }}</span><button (click)="notice.set('')">×</button></div> }
      <form class="inline-form" (ngSubmit)="create()">
        <label><span>شناسه‌ی تسک</span><input name="taskId" dir="ltr" [(ngModel)]="taskId" placeholder="10013"></label>
        <button class="primary" type="submit" [disabled]="busy() || !validId(taskId)">{{ busy() ? 'در حال ساخت…' : 'ساخت bundle' }}</button>
      </form>
      <div class="detail-section">
        @if (!items().length) { <small>bundle ای نیست.</small> }
        @for (b of items(); track b.name) {
          <div class="check-row">
            <div><b dir="ltr">{{ b.name }}</b><small dir="ltr">{{ b.createdAt.slice(0, 19).replace('T', ' ') }} · {{ kb(b.bytes) }} KB</small></div>
            <a class="secondary" [href]="api.bundleUrl(b.name)" download>دانلود</a>
          </div>
        }
      </div>
    </section>
  `
})
export class BundlesComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly items = signal<BundleItem[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly notice = signal('');
  taskId = '';

  ngOnInit(): void { void this.load(); }

  validId = (value: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(value ?? '').trim());
  kb = (bytes: number) => (bytes / 1024).toFixed(1);

  async load(): Promise<void> {
    try { this.items.set(await firstValueFrom(this.api.bundles())); }
    catch (error) { this.error.set(this.message(error)); }
  }

  async create(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await firstValueFrom(this.api.createBundle(this.repoId(), this.taskId.trim()));
      this.notice.set(`ساخته شد: ${result.name} (${this.kb(result.bytes)} KB)`);
      await this.load();
    } catch (error) { this.error.set(this.message(error)); }
    finally { this.busy.set(false); }
  }

  private message(error: unknown): string {
    return error instanceof HttpErrorResponse ? (error.error?.error ?? error.message) : String(error);
  }
}
