import { Component, DestroyRef, OnDestroy, OnInit, computed, effect, inject, input, model, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AttachmentPolicy, StagedUpload } from './models';
import { checkFileAgainstPolicy, humanSize, policyHint } from './task-extras';

interface Row { key: number; name: string; size: number; progress: number; state: 'uploading' | 'done' | 'error'; error?: string; upload?: StagedUpload }

// «فعال‌ترین» picker برای paste: اگر چند picker هم‌زمان در صفحه باشند (فرم ساخت + یادداشت)، فقط آخری Ctrl+V را می‌گیرد.
const active: AttachmentPickerComponent[] = [];
const MIME_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };

/**
 * انتخاب ِ فایل (چندتایی)، کشیدن و رها کردن، و paste ِ مستقیم ِ تصویر (Ctrl+V). هر فایل بلافاصله به سرور ِ کانبان آپلود ِ موقت می‌شود
 * (POST /api/uploads، بدنه‌ی خام)؛ `staged` فهرست ِ آپلودهای موفق است و پدر شناسه‌هایشان را به ساخت/یادداشت/پاسخ/attach می‌دهد.
 * پیش‌سنجی با **سیاست ِ خود ِ Manager** (GET /api/attachments/policy)؛ تصمیم ِ نهایی با Manager و خطایش عیناً نشان داده می‌شود.
 */
@Component({
  selector: 'ba-attachment-picker',
  standalone: true,
  template: `
    <div class="att-picker" [class.dragging]="dragging()" [class.disabled]="disabled()"
         (dragover)="onDragOver($event)" (dragleave)="dragging.set(false)" (drop)="onDrop($event)">
      <div class="att-drop">
        <button type="button" class="secondary" [disabled]="disabled() || full()" (click)="fileInput.click()">📎 انتخاب فایل…</button>
        <input #fileInput type="file" multiple hidden (change)="onPick($event)">
        <small>یا فایل را اینجا بکش و رها کن · یا تصویر را با <kbd>Ctrl</kbd>+<kbd>V</kbd> بچسبان</small>
      </div>
      @if (hint(); as h) { <small class="att-hint">{{ h }}</small> }
      @for (r of rows(); track r.key) {
        <div class="att-row" [class.err]="r.state === 'error'">
          <span class="att-name" dir="ltr">{{ r.name }}</span>
          <small>{{ size(r.size) }}</small>
          @if (r.state === 'uploading') { <progress max="100" [value]="r.progress"></progress> }
          @if (r.state === 'done') { <span class="att-ok" title="آپلود شد؛ با ساخت/ثبت به Manager داده می‌شود">✓</span> }
          @if (r.state === 'error') { <span class="att-error">{{ r.error }}</span> }
          <button type="button" class="link-button" [disabled]="disabled()" (click)="remove(r)">{{ r.state === 'error' ? 'حذف از فهرست' : '×' }}</button>
        </div>
      }
    </div>
  `
})
export class AttachmentPickerComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);
  readonly repoId = input.required<string>();
  readonly disabled = input(false);
  /** آپلودهای موفق (دوطرفه): پدر بعد از مصرف ِ موفق آن را خالی می‌کند. */
  readonly staged = model<StagedUpload[]>([]);

  readonly rows = signal<Row[]>([]);
  readonly dragging = signal(false);
  readonly policy = signal<AttachmentPolicy | null>(null);
  readonly hint = computed(() => policyHint(this.policy()));
  readonly full = computed(() => this.policy() !== null && this.rows().filter(r => r.state !== 'error').length >= this.policy()!.maxFiles);
  private counter = 0;

  constructor() {
    // پدر staged را خالی کرد (ساخت/ثبت موفق) ← ردیف‌های «انجام‌شده» هم پاک شوند.
    effect(() => { if (this.staged().length === 0) this.rows.update(list => list.filter(r => r.state !== 'done')); });
  }

  ngOnInit(): void {
    this.rows.set(this.staged().map(upload => ({ key: ++this.counter, name: upload.name, size: upload.size, progress: 100, state: 'done' as const, upload })));
    active.push(this);
    document.addEventListener('paste', this.onPaste);
    firstValueFrom(this.api.attachmentPolicy(this.repoId())).then(p => this.policy.set(p)).catch(() => this.policy.set(null));
  }

  ngOnDestroy(): void {
    document.removeEventListener('paste', this.onPaste);
    const at = active.indexOf(this);
    if (at >= 0) active.splice(at, 1);
  }

  size(bytes: number): string { return humanSize(bytes); }

  private readonly onPaste = (event: ClipboardEvent): void => {
    if (this.disabled() || active.at(-1) !== this) return;
    const files = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/'));
    if (!files.length) return; // متن ِ معمولی: رفتار ِ عادی ِ مرورگر
    event.preventDefault();
    this.addFiles(files.map(file => this.named(file)));
  };

  /** تصویر ِ clipboard معمولاً image.png است؛ نام ِ یکتا با زمان. */
  private named(file: File): File {
    if (file.name && !/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(file.name)) return file;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    return new File([file], `paste-${stamp}-${++this.counter}${MIME_EXT[file.type] ?? '.png'}`, { type: file.type });
  }

  onPick(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.addFiles(Array.from(input.files ?? []));
    input.value = '';
  }

  onDragOver(event: DragEvent): void {
    if (this.disabled() || !event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    this.dragging.set(true);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging.set(false);
    if (this.disabled()) return;
    this.addFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  private addFiles(files: File[]): void {
    for (const file of files) {
      const row: Row = { key: ++this.counter, name: file.name, size: file.size, progress: 0, state: 'uploading' };
      const policy = this.policy();
      const problem = checkFileAgainstPolicy(file.name, file.size, policy)
        ?? (policy && this.rows().filter(r => r.state !== 'error').length >= policy.maxFiles ? `حداکثر ${policy.maxFiles} فایل در هر بار.` : null);
      if (problem) { this.rows.update(list => [...list, { ...row, state: 'error', error: problem }]); continue; }
      this.rows.update(list => [...list, row]);
      this.api.uploadFile(this.repoId(), file, file.name).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: ev => {
          if (ev.type === HttpEventType.UploadProgress && ev.total) this.patch(row.key, { progress: Math.round((100 * ev.loaded) / ev.total) });
          else if (ev.type === HttpEventType.Response && ev.body) {
            this.patch(row.key, { state: 'done', progress: 100, upload: ev.body });
            this.staged.update(list => [...list, ev.body!]);
          }
        },
        error: (error: unknown) => this.patch(row.key, { state: 'error', error: error instanceof HttpErrorResponse ? (error.error?.error ?? error.message) : String(error) })
      });
    }
  }

  private patch(key: number, change: Partial<Row>): void { this.rows.update(list => list.map(r => (r.key === key ? { ...r, ...change } : r))); }

  remove(row: Row): void {
    if (row.upload) {
      const id = row.upload.id;
      this.staged.update(list => list.filter(item => item.id !== id));
      this.api.discardUpload(id).subscribe({ error: () => { /* منقضی/پاک‌شده؛ مهم نیست */ } });
    }
    this.rows.update(list => list.filter(r => r.key !== row.key));
  }
}
