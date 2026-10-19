import { Component, ElementRef, OnDestroy, effect, input, output, signal, viewChild } from '@angular/core';
import { StreamLine } from './models';

/** خروجی زنده‌ی یک اجرا از SSE (/api/execs/:id/stream یا /api/repos/:repo/tasks/:id/stream). */
@Component({
  selector: 'ba-live-output',
  standalone: true,
  template: `
    <pre class="logs live-output" #box>{{ text() || (url() ? 'در انتظار خروجی…' : '') }}</pre>
    @if (end(); as e) {
      <div class="exec-end" [class.bad]="e.code !== 0 && e.code !== 10 && e.code !== 40">
        پایان — exit code {{ e.code ?? '—' }}@if (e.stopped) { · متوقف شد }@if (e.code === 40) { · منتظر آزاد شدن scope (خطا نیست) }@if (e.code === 10) { · منتظر تصمیم انسانی (خطا نیست) }
      </div>
    } @else if (url()) {
      <div class="exec-live"><i></i> در حال اجرا…</div>
    }
  `
})
export class LiveOutputComponent implements OnDestroy {
  readonly url = input<string | null>(null);
  readonly ended = output<{ code: number | null; stopped?: boolean }>();
  readonly text = signal('');
  readonly end = signal<{ code: number | null; stopped?: boolean } | null>(null);
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  private source?: EventSource;

  constructor() {
    effect(() => {
      const url = this.url();
      this.close();
      this.text.set('');
      this.end.set(null);
      if (!url) return;
      const source = new EventSource(url);
      this.source = source;
      source.onmessage = event => {
        const line = JSON.parse(event.data) as StreamLine;
        this.text.update(t => `${t}${t ? '\n' : ''}${line.text}`);
        const el = this.box()?.nativeElement;
        if (el) queueMicrotask(() => { el.scrollTop = el.scrollHeight; });
      };
      source.addEventListener('end', event => {
        const payload = JSON.parse((event as MessageEvent).data) as { code: number | null; stopped?: boolean };
        this.finish(payload);
      });
      // خطای اتصال بدون پیام end (مثلاً نشست تمام شد): پایان با کد نامعلوم، تلاش مجدد خودکار EventSource را قطع کن.
      source.onerror = () => { if (!this.end()) this.finish({ code: null }); };
    });
  }

  private finish(payload: { code: number | null; stopped?: boolean }): void {
    this.end.set(payload);
    this.close();
    this.ended.emit(payload);
  }

  private close(): void {
    this.source?.close();
    this.source = undefined;
  }

  ngOnDestroy(): void { this.close(); }
}
