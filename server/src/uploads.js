// پوشه‌ی «آپلودِ موقت» برای پیوست‌ها (TOOLING-050 د): مرورگر فایل را (بدنه‌ی خام، نه base64) به کانبان می‌فرستد؛ کانبان آن را در
// `<dataDir>/uploads/<id>/<نام>` نگه می‌دارد، Manager را با `attach` / `--attach` صدا می‌زند، و بعد فایل موقت را پاک می‌کند.
// کانبان **هرگز** در `attachments.root` نمی‌نویسد؛ آن مال Manager است (کپی، sha256، attachments.json، commit).
//
// ایمنی: سقف ِ اندازه هنگام ِ دریافت (شمارش ِ بایت‌ها در جریان، نه بعد از ذخیره)، نام ِ امن، مالکیت (فقط همان کاربر)، سقف ِ تعداد
// برای هر کاربر، و پاک‌سازی ِ خودکار پس از مهلت (و در شروع). هیچ مسیری از ورودی ساخته نمی‌شود: شناسه UUID است و مسیر را خود ِ فروشگاه می‌سازد.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_MAX_PER_USER = 20;
const err = (status, message) => Object.assign(new Error(message), { status });

/** نام ِ امن: فقط basename، بدون مسیر/نویسه‌ی کنترلی/نویسه‌ی نامجاز ویندوز، حداکثر ۱۰۰ نویسه (پسوند حفظ می‌شود). Manager دوباره می‌سنجد. */
export function safeUploadName(raw) {
  let name = String(raw ?? '').split(/[\\/]/).pop().normalize('NFC');
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[^\p{L}\p{N}._ -]/gu, '_');
  name = name.replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').replace(/^[. _-]+/, '').replace(/[. ]+$/, '');
  if (!name) return 'attachment';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(name)) name = `_${name}`;
  if (name.length > 100) {
    const ext = path.extname(name);
    name = name.slice(0, Math.max(1, 100 - ext.length)) + ext;
  }
  return name;
}

export class UploadStore {
  constructor(dataDir, { ttlMs = DEFAULT_TTL_MS, maxPerUser = DEFAULT_MAX_PER_USER, now = () => Date.now() } = {}) {
    this.root = path.join(dataDir, 'uploads');
    this.ttlMs = ttlMs;
    this.maxPerUser = maxPerUser;
    this.now = now;
    fs.mkdirSync(this.root, { recursive: true });
    this.sweep();
  }

  #metaFile(id) { return path.join(this.root, `${id}.json`); }
  #dir(id) { return path.join(this.root, id); }

  #metas() {
    const out = [];
    for (const name of fs.readdirSync(this.root)) {
      if (!name.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(this.root, name), 'utf8'))); } catch { /* خراب = نادیده؛ sweep پاکش می‌کند */ }
    }
    return out;
  }

  /** فایل‌ها/پوشه‌های قدیمی‌تر از مهلت (و بی‌متای یتیم) را پاک می‌کند. */
  sweep() {
    const cutoff = this.now() - this.ttlMs;
    for (const name of fs.readdirSync(this.root)) {
      const full = path.join(this.root, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch { /* همزمانی با پاک‌سازی ِ دیگر */ }
    }
  }

  count(user) { return this.#metas().filter(meta => meta.user === user).length; }

  /**
   * بدنه‌ی خام را با سقف ِ `maxBytes` در جریان می‌نویسد.
   * @returns {Promise<{id, name, size, ext}>}
   */
  async receive(req, { user, name, maxBytes }) {
    if (this.count(user) >= this.maxPerUser) throw err(429, `حداکثر ${this.maxPerUser} فایل ِ آپلودشده‌ی مصرف‌نشده می‌توان داشت؛ بعضی را حذف کن یا صبر کن تا ساخته شوند.`);
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) throw err(413, `اندازه‌ی فایل (${mb(declared)}) از سقف (${mb(maxBytes)}) بیشتر است.`);
    const id = randomUUID();
    const fileName = safeUploadName(name);
    const dir = this.#dir(id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, fileName);
    let size = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        size += chunk.length;
        if (size > maxBytes) return callback(err(413, `اندازه‌ی فایل از سقف (${mb(maxBytes)}) بیشتر است.`));
        callback(null, chunk);
      }
    });
    try {
      await pipeline(req, limiter, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      if (size === 0) throw err(400, 'فایل خالی است.');
      const meta = { id, user, name: fileName, size, ext: path.extname(fileName).toLowerCase(), createdAt: new Date(this.now()).toISOString() };
      fs.writeFileSync(this.#metaFile(id), JSON.stringify(meta), { encoding: 'utf8', mode: 0o600 });
      return { id, name: fileName, size, ext: meta.ext };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** فایل ِ آپلودشده‌ی همین کاربر؛ نامعتبر/ناموجود/مال ِ دیگری ← خطا. */
  take(id, user) {
    if (!ID.test(String(id))) throw err(400, 'شناسه‌ی آپلود نامعتبر است.');
    let meta;
    try { meta = JSON.parse(fs.readFileSync(this.#metaFile(id), 'utf8')); } catch { throw err(404, 'آپلود پیدا نشد یا منقضی شده است؛ دوباره فایل را بفرست.'); }
    if (meta.user !== user) throw err(403, 'این آپلود مال کاربر دیگری است.');
    const file = path.join(this.#dir(id), meta.name);
    if (!fs.existsSync(file)) throw err(404, 'فایل ِ آپلودشده پیدا نشد؛ دوباره بفرست.');
    return { id, name: meta.name, size: meta.size, file };
  }

  discard(id) {
    if (!ID.test(String(id))) return false;
    fs.rmSync(this.#dir(id), { recursive: true, force: true });
    fs.rmSync(this.#metaFile(id), { force: true });
    return true;
  }

  discardMany(ids) { for (const id of ids ?? []) this.discard(id); }
}

const mb = bytes => `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
