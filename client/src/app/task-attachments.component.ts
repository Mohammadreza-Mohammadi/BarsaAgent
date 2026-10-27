import { NgTemplateOutlet } from '@angular/common';
import { Component, inject, input, output, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AttachmentItem, StagedUpload, Task } from './models';
import { AttachmentPickerComponent } from './attachment-picker.component';
import { ATTACHMENT_SOURCE_LABELS, attachmentGroups, humanSize, kindLabel, previewable } from './task-extras';

/**
 * بخش «پیوست‌ها» در جزئیات ِ تسک (TOOLING-050 د). فایل‌ها بیرون از git و زیر `attachments.root` ِ Manager اند؛ کانبان فقط می‌خواند
 * (پیش‌نمایش ِ تصویر، دانلود برای بقیه) و **هرگز** در آن نمی‌نویسد: افزودن = آپلود ِ موقت + \`manager.js attach\`.
 */
@Component({
  selector: 'ba-task-attachments',
  standalone: true,
  imports: [AttachmentPickerComponent, NgTemplateOutlet],
  template: `
    <section class="detail-section task-attachments">
      <div class="section-head"><div><h3>پیوست‌ها</h3><p>فایل‌ها بیرون از git و در پوشه‌ی Manager نگه داشته می‌شوند؛ agentها فقط می‌خوانند.</p></div>
        <span class="count">{{ items().length }}</span></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }
      @if (info()) { <div class="notice info"><span>{{ info() }}</span><button (click)="info.set('')">×</button></div> }

      @if (task().attachments === undefined) {
        <div class="disabled-gate-warning">این Manager بلوک <code>attachments</code> را در <code>status --json</code> نمی‌دهد (قدیمی‌تر از TOOLING-050).</div>
      } @else {
        @if (items().length && !task().attachments?.root) {
          <div class="disabled-gate-warning"><code>attachments.root</code> در پیکربندی ِ محلی ِ Manager تنظیم نیست؛ پیش‌نمایش و دانلود ممکن نیست.</div>
        }
        <ul class="att-list">
          @for (g of groups(); track g.item.id) {
            <li>
              <ng-container *ngTemplateOutlet="row; context: { $implicit: g.item }"></ng-container>
              @if (g.frames.length) {
                <ul class="att-frames">
                  @for (f of g.frames; track f.id) { <li><ng-container *ngTemplateOutlet="row; context: { $implicit: f }"></ng-container></li> }
                </ul>
              }
            </li>
          } @empty { <small>پیوستی ندارد.</small> }
        </ul>
      }

      <div class="att-add">
        <b>افزودن پیوست به این تسک</b>
        <ba-attachment-picker [repoId]="repoId()" [disabled]="disabled() || busy()" [(staged)]="staged" />
        <div class="danger-actions">
          <button class="primary" [disabled]="disabled() || busy() || !staged().length" (click)="add()">افزودن {{ staged().length || '' }} پیوست به تسک</button>
        </div>
        @if (disabled()) { <small class="hint">اجرا روی این دستگاه خاموش است؛ افزودن پیوست (فرمان ِ نوشتنی ِ Manager) ممکن نیست.</small> }
      </div>
    </section>

    <ng-template #row let-item>
      <div class="att-item" [class.missing]="item.exists === false">
        @if (preview(item)) {
          <a [href]="url(item, false)" target="_blank" rel="noopener"><img class="att-thumb" [src]="url(item, false)" [alt]="item.name" loading="lazy"></a>
        }
        <div class="att-meta">
          <b dir="ltr">{{ item.name }}</b>
          <small>{{ kind(item.kind) }} · {{ size(item.size) }} · {{ date(item.addedAt) }} · {{ source(item.source) }}</small>
          @if (item.humanOnly) { <span class="att-badge" title="Claude این فایل را نمی‌بیند (مثلاً ویدیو بدون ffmpeg)">فقط برای انسان</span> }
          @if (item.exists === false) { <span class="att-warn">⚠ فایل روی دیسک نیست (از پشتیبان برگردان)</span> }
          @if (item.exists !== false && !preview(item)) { <a class="link-button" [href]="url(item, true)" download>⬇ دانلود</a> }
          @if (item.exists !== false && preview(item)) { <a class="link-button" [href]="url(item, true)" download>⬇</a> }
        </div>
      </div>
    </ng-template>
  `
})
export class TaskAttachmentsComponent {
  private readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly task = input.required<Task>();
  /** اجرا خاموش (execution.enabled=false) ← افزودن غیرفعال. */
  readonly disabled = input(false);
  readonly changed = output<void>();

  readonly staged = signal<StagedUpload[]>([]);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly info = signal('');

  items(): AttachmentItem[] { return this.task().attachments?.items ?? []; }
  groups() { return attachmentGroups(this.items()); }
  size = humanSize;
  kind = kindLabel;
  source(value: string): string { return ATTACHMENT_SOURCE_LABELS[value] ?? value; }
  preview(item: AttachmentItem): boolean { return previewable(item); }
  date(value: string): string { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('fa-IR') : value; }
  url(item: AttachmentItem, download: boolean): string { return this.api.attachmentUrl(this.repoId(), this.task().id, item.id, download); }

  async add(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.info.set('');
    try {
      const result = await firstValueFrom(this.api.attachFiles(this.repoId(), this.task().id, this.staged().map(item => item.id)));
      this.staged.set([]);
      this.info.set(`${result.added.length} پیوست افزوده شد.${result.failed.length ? ` ${result.failed.length} مورد رد شد: ${result.failed.map(f => `«${f.name}»: ${f.error}`).join(' | ')}` : ''}`);
      this.changed.emit();
    } catch (e) {
      this.error.set(e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e));
    } finally { this.busy.set(false); }
  }
}
