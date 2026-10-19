// آرشیو تسک‌های پایان‌یافته: منطق خالص (بدون Angular) تا هم برد و هم تب آرشیو از یک
// منبع بخوانند و با `node --test` هم تست شود (فقط سینتکس قابل‌حذف TypeScript؛ import ِ type).
//
// «پایان‌یافته» فقط از همین فهرست می‌آید — هیچ شرط پراکنده‌ای در قالب یا کامپوننت نیست.
import type { Task } from './models';

/** stateهای پایانی: از ستون‌های برد بیرون می‌روند و در تب آرشیو می‌آیند. `blocked` عمداً نیست (تصمیم انسان لازم است). */
export const FINISHED_STATES: readonly string[] = ['integrated', 'cancelled', 'abandoned'];

/** از بین stateهای پایانی، کدام‌ها در ستون «تمام»ِ برد (در N روز اخیر) نشان داده شوند. */
export const BOARD_DONE_STATES: readonly string[] = ['integrated'];

export const DEFAULT_DONE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isFinished(task: Pick<Task, 'state'>): boolean {
  return FINISHED_STATES.includes(task.state);
}

/** تاریخ پایان از `stateSince` (زمانی که task وارد state ِ پایانی شده)؛ نامعتبر/غایب → null. */
export function finishedAt(task: Pick<Task, 'stateSince'>): Date | null {
  if (!task.stateSince) return null;
  const date = new Date(task.stateSince);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizeDoneDays(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DONE_DAYS;
}

/** آیا این task باید در ستون «تمام»ِ برد دیده شود؟ (پایان‌یافته از نوع BOARD_DONE_STATES و در N روز اخیر.) */
export function isRecentlyDone(task: Task, days: number, now: Date = new Date()): boolean {
  if (!BOARD_DONE_STATES.includes(task.state)) return false;
  const at = finishedAt(task);
  return !!at && now.getTime() - at.getTime() <= normalizeDoneDays(days) * DAY_MS;
}

/** فهرست تب آرشیو: همه‌ی taskهای پایان‌یافته (بدون خطادار). */
export function archiveTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(task => isFinished(task) && !task.error);
}

// --- جست‌وجو، فیلتر، مرتب‌سازی، صفحه‌بندی --------------------------------------------

export type ArchiveSortKey = 'id' | 'title' | 'state' | 'finishedAt' | 'externalId';

export interface ArchiveQuery {
  search?: string;
  /** خالی = همه‌ی stateهای پایانی */
  states?: readonly string[];
  /** YYYY-MM-DD (روز محلی)، هر دو سر بازه شامل‌اند */
  from?: string;
  to?: string;
  sortKey?: ArchiveSortKey;
  sortDir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export interface ArchiveResult { rows: Task[]; total: number; page: number; pages: number }

function dayStart(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : null;
}

function titleOf(task: Task): string {
  return task.releaseNote?.headline || task.title || task.slug || '';
}

function compare(a: Task, b: Task, key: ArchiveSortKey): number {
  switch (key) {
    case 'id': {
      const x = Number(a.id);
      const y = Number(b.id);
      return Number.isFinite(x) && Number.isFinite(y) ? x - y : String(a.id).localeCompare(String(b.id));
    }
    case 'title': return titleOf(a).localeCompare(titleOf(b), 'fa');
    case 'state': return a.state.localeCompare(b.state);
    case 'externalId': {
      const x = a.source?.externalId ?? '';
      const y = b.source?.externalId ?? '';
      const nx = Number(x);
      const ny = Number(y);
      return x !== '' && y !== '' && Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : String(x).localeCompare(String(y));
    }
    case 'finishedAt': return 0; // در queryArchive جدا مدیریت می‌شود (بدون تاریخ ته فهرست)
  }
}

export function queryArchive(tasks: readonly Task[], query: ArchiveQuery = {}): ArchiveResult {
  const needle = (query.search ?? '').trim().replace(/^#/, '').toLowerCase();
  const states = query.states?.length ? query.states : FINISHED_STATES;
  const from = query.from ? dayStart(query.from) : null;
  const toStart = query.to ? dayStart(query.to) : null;
  const to = toStart === null ? null : toStart + DAY_MS - 1;

  let rows = archiveTasks(tasks).filter(task => {
    if (!states.includes(task.state)) return false;
    if (needle && !titleOf(task).toLowerCase().includes(needle) && !String(task.id).toLowerCase().includes(needle)) return false;
    if (from !== null || to !== null) {
      const at = finishedAt(task)?.getTime();
      if (at === undefined) return false;
      if (from !== null && at < from) return false;
      if (to !== null && at > to) return false;
    }
    return true;
  });

  const key = query.sortKey ?? 'finishedAt';
  const dir = (query.sortDir ?? 'desc') === 'desc' ? -1 : 1;
  rows = [...rows].sort((a, b) => {
    if (key === 'finishedAt') {
      const x = finishedAt(a)?.getTime();
      const y = finishedAt(b)?.getTime();
      // بدون تاریخ همیشه ته فهرست، در هر دو جهت
      if (x === undefined && y !== undefined) return 1;
      if (y === undefined && x !== undefined) return -1;
      if (x !== undefined && y !== undefined && x !== y) return (x - y) * dir;
    } else {
      const result = compare(a, b, key) * dir;
      if (result) return result;
    }
    return compare(b, a, 'id'); // هم‌ارز: شماره‌ی بزرگ‌تر (تازه‌تر) بالاتر
  });

  const pageSize = Math.max(1, Math.floor(query.pageSize ?? 25));
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(Math.max(1, Math.floor(query.page ?? 1)), pages);
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pages };
}
