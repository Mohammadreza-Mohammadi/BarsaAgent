import { Component, OnInit, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuditItem, EnvHealthReport, HealthCheckItem } from './models';

/** سلامت محیط (بند هـ): هر چیزی که کم است همان‌جا می‌گوید چیست و چه کنم. */
@Component({
  selector: 'ba-env-health',
  standalone: true,
  template: `
    <section class="ops-page">
      <div class="section-head"><div><h2>سلامت محیط</h2>
        <p>{{ report() ? 'آخرین بررسی: ' + report()!.checkedAt : 'در حال بررسی…' }}</p></div>
        <button class="secondary" [disabled]="loading()" (click)="load()">{{ loading() ? 'در حال بررسی…' : 'بررسی دوباره' }}</button></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span></div> }
      @if (report(); as r) {
        <div class="health-strip" [class.bad]="!r.ok"><div><b>{{ r.ok ? 'محیط آماده است' : 'محیط ایراد دارد' }}</b>
          <span>{{ count(r, 'fail') }} خطا · {{ count(r, 'warn') }} هشدار</span></div></div>
        @for (group of groups(r); track group) {
          <div class="detail-section">
            <div class="section-head"><div><h3>{{ group }}</h3></div></div>
            @for (c of itemsOf(r, group); track c.id) {
              <div class="check-row" [class.fail]="c.status === 'fail'" [class.warn]="c.status === 'warn'">
                <span class="check-badge">{{ c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗' }}</span>
                <div><b>{{ c.label }}</b>
                  @if (c.detail) { <small dir="ltr">{{ c.detail }}</small> }
                  @if (c.hint) { <small class="hint">{{ c.hint }}</small> }
                </div>
              </div>
            }
          </div>
        }
      }
    </section>
  `
})
export class EnvHealthComponent implements OnInit {
  private readonly api = inject(ApiService);
  readonly report = signal<EnvHealthReport | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');

  async ngOnInit(): Promise<void> { await this.load(); }

  async load(): Promise<void> {
    this.loading.set(true);
    this.error.set('');
    try { this.report.set(await firstValueFrom(this.api.envHealth())); }
    catch (e) { this.error.set(e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e)); }
    finally { this.loading.set(false); }
  }

  count(r: EnvHealthReport, status: HealthCheckItem['status']): number { return r.checks.filter(c => c.status === status).length; }
  groups(r: EnvHealthReport): string[] { return [...new Set(r.checks.map(c => c.group))]; }
  itemsOf(r: EnvHealthReport, group: string): HealthCheckItem[] { return r.checks.filter(c => c.group === group); }
}

/** نمای فقط‌خواندنی دفتر ممیزی (خود فایل append-only است و از اینجا قابل تغییر نیست). */
@Component({
  selector: 'ba-audit',
  standalone: true,
  template: `
    <section class="ops-page">
      <div class="section-head"><div><h2>دفتر ممیزی</h2><p>آخرین {{ items().length }} اکشن — فایل append-only بیرون از مخزن‌ها.</p></div>
        <button class="secondary" (click)="load()">↻</button></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span></div> }
      <table class="wt-table audit-table">
        <thead><tr><th>زمان</th><th>کاربر</th><th>اکشن</th><th>task</th><th>نتیجه</th><th>مدت</th><th></th></tr></thead>
        <tbody>
          @for (a of items(); track a.id) {
            <tr [class.rejected]="a.status === 'rejected'">
              <td dir="ltr">{{ a.startedAt.slice(11, 19) }} <small>{{ a.startedAt.slice(0, 10) }}</small></td>
              <td dir="ltr">{{ a.user || '—' }}@if (a.user?.startsWith('remote:')) { <span class="remote-badge" title="از راه دور، با CLI ِ barsa و توکن">remote</span> }</td>
              <td dir="ltr"><code>{{ a.action }}</code>@if (a.line) { <small>{{ a.line }}</small> }@if (a.reason) { <small>{{ a.reason }}</small> }</td>
              <td dir="ltr">{{ a.taskId || '' }}</td>
              <td>{{ a.status || '…' }}{{ a.exitCode !== null && a.exitCode !== undefined ? ' · ' + a.exitCode : '' }}</td>
              <td dir="ltr">{{ a.durationMs !== null && a.durationMs !== undefined ? a.durationMs + 'ms' : '' }}</td>
              <td>@if (a.outputFile) { <a [href]="api.logUrl(a.id)" download>لاگ</a> }</td>
            </tr>
          }
        </tbody>
      </table>
    </section>
  `
})
export class AuditComponent implements OnInit {
  readonly api = inject(ApiService);
  readonly items = signal<AuditItem[]>([]);
  readonly error = signal('');

  async ngOnInit(): Promise<void> { await this.load(); }

  async load(): Promise<void> {
    try { this.items.set(await firstValueFrom(this.api.audit(150))); }
    catch (e) { this.error.set(e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e)); }
  }
}
