// توکن‌های نام‌دار برای CLI ِ کنترل از راه دور (Claude Remote Control).
//
// - توکن: ۳۲ بایت تصادفی (base64url). **فقط hash ِ SHA-256** اش در `<dataDir>/remote-tokens.json` می‌ماند (کنار
//   users.json). SHA-256 برای توکن پرانتروپی کافی است (گذرواژه‌ی انسانی نیست که scrypt لازم داشته باشد).
// - خود توکن فقط یک بار، در `<dataDir>/tokens/<name>.token` با دسترسی فقط-مالک نوشته می‌شود؛ هرگز چاپ نمی‌شود.
// - باطل کردن فوری است: سرور هر درخواست فایل را (با کش بر اساس mtime) دوباره می‌خواند، پس ری‌استارت لازم نیست.
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TOKEN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const TOKEN_BYTES = 32;
export const REMOTE_ACTOR_PREFIX = 'remote:';

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/** آدرس‌های loopback (IPv4، IPv6 و IPv4-mapped). */
export function isLoopbackAddress(address) {
  const value = String(address ?? '').trim().toLowerCase();
  return value === '::1' || value === '::ffff:127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(value);
}

/** دسترسی فقط-مالک: روی POSIX chmod 600؛ روی ویندوز ACL ِ ارث‌بری‌نشده فقط برای کاربر فعلی. @returns {string|null} هشدار */
export function restrictToOwner(file) {
  try { fs.chmodSync(file, 0o600); } catch { /* ویندوز */ }
  if (process.platform !== 'win32') return null;
  try {
    const who = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${who}:(R,W,D)`], { windowsHide: true, stdio: 'ignore' });
    return null;
  } catch (error) {
    return `نتوانستم دسترسی فایل توکن را فقط-مالک کنم (${error.message.split('\n')[0]}) — با icacls دستی محدودش کن.`;
  }
}

export class RemoteTokenStore {
  #cache = null;

  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    this.file = path.join(this.dir, 'remote-tokens.json');
    this.tokensDir = path.join(this.dir, 'tokens');
  }

  tokenFile(name) { return path.join(this.tokensDir, `${name}.token`); }

  /** { name: { hash, createdAt, revokedAt? } } — با کش بر اساس mtime/size تا باطل‌سازی فوری باشد. */
  #read() {
    let stat;
    try { stat = fs.statSync(this.file); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    const key = `${stat.mtimeMs}:${stat.size}`;
    if (this.#cache?.key === key) return this.#cache.tokens;
    const tokens = JSON.parse(fs.readFileSync(this.file, 'utf8')).tokens || {};
    this.#cache = { key, tokens };
    return tokens;
  }

  #write(tokens) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tokens }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.#cache = null;
  }

  list() {
    return Object.entries(this.#read()).map(([name, record]) => ({
      name, createdAt: record.createdAt, revokedAt: record.revokedAt ?? null, active: !record.revokedAt
    }));
  }

  /**
   * @param name        نام توکن (و نام فایل)
   * @param outFile     مسیر فایل توکن؛ پیش‌فرض `<dataDir>/tokens/<name>.token`
   * @returns {{ name, file, warning }} — خود توکن فقط در فایل است، نه در مقدار برگشتی.
   */
  create(name, { outFile } = {}) {
    if (!TOKEN_NAME.test(String(name))) throw new Error('نام توکن فقط حرف/عدد/نقطه/خط‌تیره/زیرخط، تا ۳۲ نویسه.');
    const tokens = this.#read();
    if (tokens[name] && !tokens[name].revokedAt) throw new Error(`توکن «${name}» از قبل فعال است؛ اول باطلش کن (token:revoke).`);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const file = path.resolve(outFile || this.tokenFile(name));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // فایل را پیش از نوشتن توکن بساز و محدود کن؛ توکن هیچ لحظه‌ای در فایلی با دسترسی باز نمی‌ماند.
    fs.writeFileSync(file, '', { mode: 0o600 });
    const warning = restrictToOwner(file);
    fs.writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
    this.#write({ ...tokens, [name]: { hash: sha256(token), createdAt: new Date().toISOString() } });
    return { name, file, warning };
  }

  /** باطل می‌کند (hash می‌ماند با revokedAt برای ممیزی) و فایل توکن را اگر هست پاک می‌کند. */
  revoke(name) {
    const tokens = this.#read();
    if (!tokens[name]) return { revoked: false, reason: 'وجود ندارد' };
    if (tokens[name].revokedAt) return { revoked: false, reason: 'از قبل باطل شده' };
    this.#write({ ...tokens, [name]: { ...tokens[name], revokedAt: new Date().toISOString() } });
    fs.rmSync(this.tokenFile(name), { force: true });
    return { revoked: true };
  }

  /** @returns {{ name } | { rejected: 'unknown'|'revoked' }} */
  verify(token) {
    const digest = Buffer.from(sha256(String(token ?? '')), 'hex');
    let found = null;
    for (const [name, record] of Object.entries(this.#read())) {
      const expected = Buffer.from(String(record.hash || ''), 'hex');
      if (expected.length === digest.length && timingSafeEqual(expected, digest)) found = { name, record };
    }
    if (!found) return { rejected: 'unknown' };
    if (found.record.revokedAt) return { rejected: 'revoked' };
    return { name: found.name };
  }
}

/** `Authorization: Bearer <token>` → رشته‌ی توکن؛ هدر نبود → null؛ هدر ناقص/غیر-Bearer → '' (رد). */
export function bearerOf(req) {
  const header = req.headers.authorization;
  if (header === undefined) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header));
  return match ? match[1] : '';
}

/** هدرهایی که نشان می‌دهند درخواست از یک proxy گذشته (loopback بودنِ socket دیگر معنای «محلی» نمی‌دهد). */
export function proxiedHeaders(req) {
  return ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'].filter(name => req.headers[name] !== undefined);
}
