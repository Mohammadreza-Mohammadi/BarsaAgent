// bundle ِ تشخیصی (`barsa bundle <id>`): یک zip ِ **پوشانده‌شده** از پوشه‌ی تسک + diag + لاگ آخرین اجرا، در
// `<dataDir>/bundles/<id>-<زمان>.zip`. برای فرستادن به مشاور/پشتیبان است نه برای بازگرداندن. هر فایل متنی از redactor
// می‌گذرد (راز محیط، توکن، شناسه‌ی کاربر پورتال)؛ فایل دودویی و فایل خیلی بزرگ وارد نمی‌شود و در MANIFEST.txt ثبت می‌شود.
import fs from 'node:fs';
import path from 'node:path';
import { environmentSecrets, redact } from './security.js';
import { listFiles, zipEntries } from './zip.js';

export const BUNDLE_LIMITS = Object.freeze({ perFileBytes: 1024 * 1024, totalBytes: 40 * 1024 * 1024, maxFiles: 2000 });
const BUNDLE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.zip$/;

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');

export class BundleStore {
  constructor(dataDir) {
    this.dir = path.join(path.resolve(dataDir), 'bundles');
  }

  /** فقط نام ساده‌ی `.zip`؛ جداکننده‌ی مسیر، `..`، مسیر مطلق، و همه‌چیز خارج از پوشه‌ی bundles رد می‌شود. */
  resolve(rawName) {
    const name = String(rawName ?? '');
    if (!BUNDLE_NAME.test(name) || name.includes('..')) return null;
    const file = path.resolve(this.dir, name);
    const rel = path.relative(this.dir, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel !== name) return null;
    try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
  }

  list() {
    let names;
    try { names = fs.readdirSync(this.dir); } catch { return []; }
    return names.filter(name => BUNDLE_NAME.test(name)).map(name => {
      const stat = fs.statSync(path.join(this.dir, name));
      return { name, bytes: stat.size, createdAt: stat.mtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /**
   * @param input { taskId, taskDir (مسیر مطلق و اعتبارسنجی‌شده)، diagText، runLogText، runId }
   * @returns {{ name, file, bytes, files, skipped }}
   */
  create({ taskId, taskDir, diagText, runLogText, runId, now = new Date() }) {
    const secrets = environmentSecrets();
    const entries = [];
    const skipped = [];
    let total = 0;
    const add = (name, text, mtime = now) => {
      const data = Buffer.from(redact(text, secrets), 'utf8');
      total += data.length;
      entries.push({ name, data, mtime });
    };

    let files = [];
    try { files = listFiles(taskDir); } catch (error) { skipped.push(`پوشه‌ی تسک خوانده نشد: ${error.message}`); }
    for (const file of files) {
      if (entries.length >= BUNDLE_LIMITS.maxFiles || total >= BUNDLE_LIMITS.totalBytes) { skipped.push(`${file.name}: سقف bundle پر شد`); continue; }
      let data = fs.readFileSync(file.full);
      if (data.includes(0)) { skipped.push(`${file.name}: دودویی (${file.size} بایت)`); continue; }
      let note = '';
      if (data.length > BUNDLE_LIMITS.perFileBytes) {
        note = `[bundle: فقط ${BUNDLE_LIMITS.perFileBytes} بایت ِ آخر از ${data.length} بایت نگه داشته شد]\n`;
        data = data.subarray(data.length - BUNDLE_LIMITS.perFileBytes);
      }
      add(`task/${file.name}`, note + data.toString('utf8'), fs.statSync(file.full).mtime);
    }
    add('diag.txt', diagText);
    add(`run-${runId || 'none'}.log`, runLogText || '(لاگ اجرایی نیست)');
    add('MANIFEST.txt', [
      `bundle تشخیصی تسک #${taskId} · ${now.toISOString()}`,
      'محتوا: task/ (پوشه‌ی تسک، پوشانده‌شده)، diag.txt، لاگ آخرین اجرا.',
      'همه‌ی متن‌ها از redactor گذشته‌اند (راز محیط، توکن، شناسه‌ی کاربر پورتال).',
      `فایل‌ها: ${entries.length}`,
      ...(skipped.length ? ['ردشده:', ...skipped.map(line => `  - ${redact(line, secrets)}`)] : [])
    ].join('\n'));

    const { buffer } = zipEntries(entries);
    fs.mkdirSync(this.dir, { recursive: true });
    const name = `${String(taskId).replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp(now)}.zip`;
    const file = path.join(this.dir, name);
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return { name, file, bytes: buffer.length, files: entries.length, skipped };
  }
}
