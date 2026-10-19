// کانبان فاز ۱: دفتر ممیزی append-only (JSON lines) بیرون از مخزن‌ها.
//
// هر اکشن دو رکورد دارد: `start` (قبل از اجرا — اگر سرور وسط کار بمیرد حداقل
// معلوم است چه شروع شده بود) و `end` (exit code، مدت، مسیر خروجی کامل). اکشنی که
// اصلاً اجرا نشد (رد شد) فقط یک رکورد `rejected` با دلیل دارد. هیچ ویرایش یا
// حذفی در این ماژول نیست.
//
// خروجی کامل هر اجرا در فایل جدا `outputs/<id>.log` است؛ رکورد فقط مسیرش را نگه
// می‌دارد، تا دفتر کوچک و قابل grep بماند.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { environmentSecrets, redact } from './security.js';
import { defaultDataDir } from './config.js';

// کدهای خروج manager.js `run` که خطا نیستند: 10 = منتظر انسان (گیت)، 40 = منتظر آزاد شدن scope
// (SCOPE_WAIT_EXIT_CODE). فقط 0 «ok» است، این دو «waiting»، بقیه «failed».
const WAITING_EXIT_CODES = new Set([10, 40]);
export function statusForExit(code) {
  if (code === 0) return 'ok';
  return WAITING_EXIT_CODES.has(code) ? 'waiting' : 'failed';
}

export class AuditLog {
  constructor({ dir, now = () => new Date() } = {}) {
    this.dir = path.resolve(dir || defaultDataDir());
    this.now = now;
    this.file = path.join(this.dir, 'audit.jsonl');
    this.outputDir = path.join(this.dir, 'outputs');
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  newId() {
    const stamp = this.now().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    return `${stamp}-${randomUUID().slice(0, 8)}`;
  }

  outputFile(id) {
    if (!/^[0-9]{14}-[0-9a-f]{8}$/.test(id)) throw new Error('شناسه‌ی اجرا نامعتبر است.');
    return path.join(this.outputDir, `${id}.log`);
  }

  #append(record) {
    const secrets = environmentSecrets();
    // mask روی مقدارهای رشته‌ای، نه روی JSON کامل: الگوی token=… می‌تواند کوتیشن
    // و براکت بعد از خودش را هم ببلعد و خط را نامعتبر کند.
    const line = JSON.stringify(record, (_key, value) => (typeof value === 'string' ? redact(value, secrets) : value));
    fs.appendFileSync(this.file, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * @param fields {user, action, repoId?, taskId?, argv?, cwd?, line?, attachments?}
   * @returns {{ id, startedAt, outputFile, finish(result) }}
   */
  begin(fields) {
    const id = fields.id || this.newId();
    const startedAt = this.now();
    const outputFile = fields.output === false ? null : this.outputFile(id);
    const { output, ...rest } = fields;
    this.#append({ id, phase: 'start', at: startedAt.toISOString(), ...rest, outputFile });
    let finished = false;
    return {
      id,
      startedAt: startedAt.toISOString(),
      outputFile,
      finish: (result = {}) => {
        if (finished) return;
        finished = true;
        const end = this.now();
        this.#append({
          id,
          phase: 'end',
          at: end.toISOString(),
          user: fields.user,
          action: fields.action,
          exitCode: result.exitCode ?? null,
          status: result.status || statusForExit(result.exitCode),
          durationMs: end.getTime() - startedAt.getTime(),
          outputFile,
          ...(result.note ? { note: result.note } : {})
        });
      }
    };
  }

  /** اکشن رد‌شده (اعتبارسنجی، پیش‌شرط، احراز هویت): یک رکورد، بدون اجرا. */
  reject(fields, reason) {
    const id = fields.id || this.newId();
    this.#append({ id, phase: 'rejected', at: this.now().toISOString(), status: 'rejected', exitCode: null, ...fields, reason: String(reason) });
    return id;
  }

  /** اکشن‌های یک‌مرحله‌ای که اجرای فرآیند ندارند (دانلود، ورود/خروج). */
  note(fields) {
    const id = fields.id || this.newId();
    this.#append({ id, phase: 'event', at: this.now().toISOString(), status: 'ok', ...fields });
    return id;
  }

  /** همه‌ی رکوردها (قدیمی→جدید). فایل را کامل می‌خواند؛ برای حجم این برنامه کافی است. */
  readAll() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* خط ناقص (کرش وسط نوشتن) — رد شود */ }
    }
    return records;
  }

  /** start+end هر اجرا را در یک شیء جمع می‌کند. */
  summaries({ action, repoId, taskId, user, limit = 100 } = {}) {
    const byId = new Map();
    for (const record of this.readAll()) {
      const current = byId.get(record.id) || {};
      byId.set(record.id, { ...current, ...record, startedAt: current.startedAt || record.at, phases: [...(current.phases || []), record.phase] });
    }
    const items = [...byId.values()].filter(item =>
      (!action || item.action === action) &&
      (!repoId || item.repoId === repoId) &&
      (!taskId || String(item.taskId) === String(taskId)) &&
      (!user || item.user === user)
    );
    items.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return items.slice(0, limit);
  }
}
