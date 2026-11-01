// به‌روزرسانی ِ زنده بدون دست‌زدن به جای کاربر (کانبان: پرش ِ اسکرول).
//
// دو قاعده:
//  ۱) داده عوض نشده ⇒ همان reference ِ قبلی (signal هیچ چیزی را دوباره render نمی‌کند). داده عوض شده ⇒ فقط شاخه‌ی ِ عوض‌شده
//     reference ِ تازه می‌گیرد؛ بقیه همان قبلی می‌ماند (structural sharing) و Angular فقط همان بخش را به‌روز می‌کند.
//  ۲) کاربر در حال ِ تایپ یا انتخاب ِ متن است ⇒ به‌روزرسانی به تعویق می‌افتد (نشانگر ِ «تغییرات تازه»)، نه اینکه زیر دستش عوض شود.

/** اگر `next` از نظر ِ مقدار با `prev` یکی است همان `prev` را برمی‌گرداند؛ وگرنه شاخه‌های ِ یکسان را از `prev` می‌گیرد. */
export function reuse<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return next;
  if (Array.isArray(next)) {
    if (!Array.isArray(prev)) return next;
    const merged = next.map((item, i) => reuse(prev[i], item));
    return (merged.length === prev.length && merged.every((item, i) => Object.is(item, prev[i])) ? prev : merged) as T;
  }
  if (isPlain(next)) {
    if (!isPlain(prev)) return next;
    const keys = Object.keys(next);
    const merged: Record<string, unknown> = {};
    for (const key of keys) merged[key] = reuse(prev[key], next[key]);
    const same = keys.length === Object.keys(prev).length && keys.every(key => Object.prototype.hasOwnProperty.call(prev, key) && Object.is(merged[key], prev[key]));
    return (same ? prev : merged) as T;
  }
  return next;
}

/** مقایسه‌ی ِ مقداری (برای ِ داده‌ی ِ JSON). */
export function sameData(a: unknown, b: unknown): boolean { return Object.is(reuse(a, b), a); }

/**
 * مثل `reuse`، ولی کلیدهای ِ «ناپایدار» (مثل `generatedAt` که هر پاسخ عوضش می‌کند) در مقایسه نمی‌آیند:
 * اگر فقط همان‌ها فرق دارند همان `prev` برمی‌گردد (یعنی «داده عوض نشده»).
 */
export function reuseIgnoring<T extends object>(prev: T | null | undefined, next: T, volatileKeys: readonly string[]): T {
  if (!prev) return next;
  const strip = (value: object): Record<string, unknown> => Object.fromEntries(Object.entries(value).filter(([key]) => !volatileKeys.includes(key)));
  return sameData(strip(prev), strip(next)) ? prev : reuse(prev, next);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** trackBy ی ِ `*ngFor`: شناسه‌ی ِ تسک (DOM ِ کارت با عوض‌شدن ِ داده دوباره ساخته نمی‌شود). */
export function trackById(_index: number, item: { id: string }): string { return item.id; }
/** trackBy ی ِ فهرست‌های ِ `[نام، مقدار]` (artifact ها). */
export function trackByKey(_index: number, entry: readonly [string, unknown]): string { return entry[0]; }
export function trackByPath(_index: number, item: { path?: string | null }): string { return item.path ?? String(_index); }

/** آنچه از DOM لازم است تا بدانیم کاربر وسط ِ کار است (تا تست‌پذیر بماند، جدا از خود ِ DOM). */
export interface UiProbe {
  /** تگ ِ عنصر ِ فوکوس‌دار (بزرگ‌حرف)، یا ''. */
  activeTag: string;
  activeType?: string;
  activeEditable?: boolean;
  /** متنی انتخاب شده (selection غیر ِ collapsed) داخل ِ برنامه. */
  selectionActive: boolean;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'datetime-local', 'time']);

/** وسط ِ تایپ (فیلد ِ متنی/textarea/contenteditable فوکوس دارد) یا متن انتخاب شده ⇒ render ِ داده‌ی ِ تازه به تعویق بیفتد. */
export function shouldDeferRender(p: UiProbe): boolean {
  if (p.selectionActive) return true;
  if (p.activeEditable) return true;
  if (p.activeTag === 'TEXTAREA') return true;
  if (p.activeTag === 'INPUT') return TEXT_INPUT_TYPES.has((p.activeType ?? '').toLowerCase());
  return false;
}

/** وضعیت ِ واقعی ِ صفحه را می‌خواند. `root` ظرف ِ برنامه است تا انتخاب ِ متن در جای دیگر (مثلاً devtools) حساب نشود. */
export function probeUi(doc: Document, root: Element | null): UiProbe {
  const active = doc.activeElement as HTMLElement | null;
  const selection = doc.getSelection?.() ?? null;
  const anchor = selection?.anchorNode ?? null;
  const selectionActive = !!selection && !selection.isCollapsed && !!anchor && (!root || root.contains(anchor.nodeType === 1 ? anchor : anchor.parentNode));
  return {
    activeTag: active?.tagName ?? '',
    activeType: active instanceof HTMLInputElement ? active.type : undefined,
    activeEditable: !!active?.isContentEditable,
    selectionActive
  };
}
