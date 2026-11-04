// بافر ِ سقف‌دار ِ لاگ ِ زنده: هیچ‌وقت کل ِ لاگ در حافظه یا DOM نمی‌آید؛ فقط `cap` خط ِ آخر. خط‌های ِ قدیمی‌تر که کنار گذاشته شدند شمرده
// می‌شوند تا UI بگوید «N خط ِ قدیمی‌تر» و «نمایش بیشتر» را فقط با درخواست ِ صریح ِ کاربر بدهد.

export const LOG_TAIL_DEFAULT = 500;
export const LOG_TAIL_STEP = 500;
/** سقف ِ بافر ِ سمت ِ سرور (process-registry maxLines)؛ بیشتر از این چیزی برای ِ نمایش نیست. */
export const LOG_TAIL_MAX = 2000;

export class LogBuffer {
  private items: string[] = [];
  private droppedCount = 0;
  private skippedByServer = 0;
  private cap: number;

  constructor(cap = LOG_TAIL_DEFAULT) { this.cap = cap; }

  get limit(): number { return this.cap; }
  /** خط‌های ِ کنارگذاشته (سمت ِ کلاینت) + خط‌هایی که سرور اصلاً replay نکرد (tail). */
  get olderLines(): number { return this.droppedCount + this.skippedByServer; }
  get size(): number { return this.items.length; }

  /** سرور گفت N خط ِ قدیمی را در replay نفرستاد. */
  noteSkipped(count: number): void { this.skippedByServer = Math.max(0, count | 0); }

  setLimit(cap: number): void { this.cap = Math.max(1, cap | 0); this.trim(); }

  push(line: string): void {
    this.items.push(line);
    // O(1) سرشکن: تا دو برابر ِ سقف جمع می‌شود و یک‌جا بریده می‌شود (نه splice به‌ازای هر خط)
    if (this.items.length > this.cap * 2) this.trim();
  }

  /** نمای ِ فعلی (کپی؛ حداکثر `cap` خط). */
  snapshot(): string[] {
    this.trim();
    return this.items.slice();
  }

  reset(): void { this.items = []; this.droppedCount = 0; this.skippedByServer = 0; }

  private trim(): void {
    if (this.items.length <= this.cap) return;
    const extra = this.items.length - this.cap;
    this.droppedCount += extra;
    this.items.splice(0, extra);
  }
}

/** متن ِ طولانی (artifact) را به حداکثر `maxLines` خط می‌برد (پشتوانه‌ی سمت ِ کلاینت؛ سرور هم `?lines=` را می‌بُرد). */
export function clipText(text: string, maxLines: number, from: 'head' | 'tail' = 'head'): { text: string; clipped: boolean; totalLines: number } {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return { text, clipped: false, totalLines: lines.length };
  return { text: (from === 'tail' ? lines.slice(-maxLines) : lines.slice(0, maxLines)).join('\n'), clipped: true, totalLines: lines.length };
}
