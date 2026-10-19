import { Component, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { ConsoleHistoryItem, ConsoleParse } from './models';
import { LiveOutputComponent } from './live-output.component';

const ATTACHMENT_LABELS: Record<string, string> = {
  '--file': 'متن (فایل UTF-8 موقت — --file)',
  '--reason-file': 'متن دلیل (--reason-file)',
  '--release-note-file': 'متن release-note (--release-note-file)'
};

/**
 * کنسول Manager (کانبان فاز ۱، بند الف). خطی را paste کن که مشاور داده؛ کانبان آن را
 * بدون هیچ گسترش شل tokenize می‌کند، زیرفرمان را با `manager.js --help` می‌سنجد و
 * فقط `node scripts/manager.js …` را اجرا می‌کند. فرمان‌های تغییردهنده پنجره‌ی
 * تأیید با فرمان نهایی دارند.
 */
@Component({
  selector: 'ba-console',
  standalone: true,
  imports: [FormsModule, LiveOutputComponent],
  template: `
    <section class="ops-page">
      <div class="section-head">
        <div><h2>کنسول Manager</h2><p>یک خط، دقیقاً همان که مشاور می‌دهد. پیشوند <code>node scripts/manager.js</code> اختیاری است.</p></div>
      </div>

      <form class="console-line" (ngSubmit)="check()">
        <input name="line" dir="ltr" autocomplete="off" spellcheck="false" [(ngModel)]="line"
               placeholder='answer 10013 --external-access webiii=write --reason "Q6.1 option 1"'>
        <button class="primary" type="submit" [disabled]="busy() || !line.trim()">بررسی و اجرا</button>
      </form>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }

      @if (pending(); as p) {
        <div class="confirm-box">
          <b>{{ p.readOnly ? 'فرمان فقط‌خواندنی' : 'تأیید فرمان تغییردهنده' }}</b>
          <small>این دقیقاً چیزی است که اجرا می‌شود:</small>
          <code class="final-command" dir="ltr">{{ p.display }}</code>
          @for (flag of p.attachments; track flag) {
            <label class="attachment">
              <span>{{ label(flag) }}</span>
              <textarea [ngModel]="attachmentText[flag] || ''" (ngModelChange)="attachmentText[flag] = $event" [name]="flag" placeholder="متن اینجا نوشته می‌شود؛ مسیر فایل لازم نیست."></textarea>
            </label>
          }
          <div class="danger-confirm-actions">
            <button class="secondary" (click)="pending.set(null)">انصراف</button>
            <button class="primary" [disabled]="busy() || missingAttachment(p)" (click)="execute(p)">تأیید نهایی — اجرا کن</button>
          </div>
        </div>
      }

      @if (streamUrl()) {
        <div class="detail-section">
          <div class="section-head"><div><h3>خروجی زنده</h3></div>
            @if (execId() && !finished()) { <button class="danger-outline" (click)="stop()">⏹ توقف</button> }
          </div>
          <ba-live-output [url]="streamUrl()" (ended)="onEnded()" />
        </div>
      }

      <div class="detail-section">
        <div class="section-head"><div><h3>تاریخچه</h3><p>برای اجرای دوباره روی خط کلیک کن (باز هم تأیید می‌خواهد).</p></div></div>
        @for (h of history(); track h.at + h.line) {
          <button class="history-row" dir="ltr" (click)="line = h.line">
            <code>{{ h.line }}</code><em [class.bad]="h.exitCode !== null && h.exitCode !== 0 && h.exitCode !== 10 && h.exitCode !== 40">{{ h.status || '—' }}{{ h.exitCode !== null ? ' · ' + h.exitCode : '' }}</em>
          </button>
        } @empty { <small>هنوز چیزی اجرا نشده.</small> }
      </div>

      <div class="detail-section">
        <div class="section-head"><div><h3>زیرفرمان‌های مجاز</h3><p>خوانده‌شده از <code>manager.js --help</code> — فهرست دستی نیست.</p></div></div>
        @if (subError()) { <div class="disabled-gate-warning">{{ subError() }}</div> }
        <div class="chips">@for (s of subcommands(); track s) { <button (click)="line = s + ' '">{{ s }}</button> }</div>
      </div>
    </section>
  `
})
export class ConsoleComponent implements OnInit {
  private readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  line = '';
  attachmentText: Record<string, string> = {};
  readonly pending = signal<ConsoleParse | null>(null);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly streamUrl = signal<string | null>(null);
  readonly execId = signal<string | null>(null);
  readonly finished = signal(false);
  readonly history = signal<ConsoleHistoryItem[]>([]);
  readonly subcommands = signal<string[]>([]);
  readonly subError = signal('');

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadHistory(), this.loadSubcommands()]);
  }

  label(flag: string): string { return ATTACHMENT_LABELS[flag] ?? flag; }

  missingAttachment(p: ConsoleParse): boolean { return p.attachments.some(flag => !(this.attachmentText[flag] || '').trim()); }

  private message(e: unknown): string {
    return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e);
  }

  async loadHistory(): Promise<void> {
    try { this.history.set(await firstValueFrom(this.api.consoleHistory())); } catch { /* تاریخچه اختیاری است */ }
  }

  async loadSubcommands(): Promise<void> {
    try {
      const info = await firstValueFrom(this.api.consoleSubcommands(this.repoId()));
      this.subcommands.set(info.subcommands);
      this.subError.set(info.error ? `فهرست خوانده نشد: ${info.error} — کنسول تا آن موقع همه‌چیز را رد می‌کند.` : '');
    } catch (e) { this.subError.set(this.message(e)); }
  }

  async check(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    this.pending.set(null);
    try {
      const parsed = await firstValueFrom(this.api.consoleParse(this.repoId(), this.line));
      this.attachmentText = {};
      if (parsed.readOnly && !parsed.attachments.length) await this.execute(parsed);
      else this.pending.set(parsed);
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }

  async execute(p: ConsoleParse): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await firstValueFrom(this.api.consoleExec(this.repoId(), this.line, p.display, this.attachmentText));
      this.pending.set(null);
      this.finished.set(false);
      if (result.kind === 'run') {
        this.execId.set(null);
        this.streamUrl.set(this.api.streamUrl(result.repoId, result.taskId));
      } else {
        this.execId.set(result.execId);
        this.streamUrl.set(this.api.execStreamUrl(result.execId));
      }
    } catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }

  async stop(): Promise<void> {
    const id = this.execId();
    if (!id) return;
    try { await firstValueFrom(this.api.stopExec(id)); } catch (e) { this.error.set(this.message(e)); }
  }

  onEnded(): void {
    this.finished.set(true);
    void this.loadHistory();
  }
}
