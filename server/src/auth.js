// کانبان فاز ۱: احراز هویت اجباری + محافظت CSRF.
//
// انتخاب: حساب محلی (نام کاربری + گذرواژه‌ی scrypt در users.json بیرون از مخزن)
// + کوکی نشست HttpOnly/SameSite=Strict + توکن CSRF جدا برای هر نشست.
// چرا نه توکن ثابت (Bearer) در config: انسان از مرورگر وارد می‌شود، نه از اسکریپت؛
// توکن ثابت باید در localStorage یا فرم نگه‌داری شود (XSS آن را برمی‌دارد) و
// «چه کسی» را در دفتر ممیزی نمی‌گوید — با حساب‌های جدا هر رکورد ممیزی نام یک
// آدم دارد. چرا نه OAuth/SSO: سرور داخلی است و هیچ IdP ای فرض نشده؛ این لایه
// بعداً پشت reverse proxy با SSO هم قابل جایگزینی است (نشست همین‌جا می‌ماند).
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
export const MIN_PASSWORD_LENGTH = 10;
export const SESSION_COOKIE = 'ba_session';

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    scrypt(String(password), salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: 128 * params.N * params.r * 2 }, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export class UserStore {
  constructor(dir) {
    this.file = path.join(path.resolve(dir), 'users.json');
  }

  #read() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')).users || {}; }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  }

  #write(users) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ users }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list() { return Object.keys(this.#read()); }
  count() { return this.list().length; }

  async add(name, password) {
    if (!NAME.test(String(name))) throw new Error('نام کاربری فقط حرف/عدد/نقطه/خط‌تیره/زیرخط، تا ۳۲ نویسه.');
    if (String(password).length < MIN_PASSWORD_LENGTH) throw new Error(`گذرواژه حداقل ${MIN_PASSWORD_LENGTH} نویسه باشد.`);
    const users = this.#read();
    const salt = randomBytes(16);
    const key = await derive(password, salt, SCRYPT);
    users[name] = { salt: salt.toString('hex'), hash: key.toString('hex'), ...SCRYPT, createdAt: new Date().toISOString() };
    this.#write(users);
  }

  remove(name) {
    const users = this.#read();
    if (!(name in users)) return false;
    delete users[name];
    this.#write(users);
    return true;
  }

  /** زمان پاسخ برای کاربر ناموجود و گذرواژه‌ی غلط یکسان است (scrypt همیشه اجرا می‌شود). */
  async verify(name, password) {
    const record = this.#read()[String(name)];
    const params = record || SCRYPT;
    const salt = record ? Buffer.from(record.salt, 'hex') : Buffer.alloc(16);
    const key = await derive(password, salt, params);
    if (!record) return false;
    const expected = Buffer.from(record.hash, 'hex');
    return expected.length === key.length && timingSafeEqual(expected, key);
  }
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export class Auth {
  #sessions = new Map();
  #failures = new Map();

  constructor({ users, sessionTtlMinutes = 480, idleMinutes = 120, secureCookie = false, allowedOrigins = [], maxFailures = 5, lockoutMinutes = 15, now = () => Date.now() } = {}) {
    this.users = users;
    this.ttlMs = sessionTtlMinutes * 60_000;
    this.idleMs = idleMinutes * 60_000;
    this.secureCookie = secureCookie;
    this.allowedOrigins = new Set(allowedOrigins);
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMinutes * 60_000;
    this.now = now;
  }

  async login(username, password, ip = '') {
    const key = `${ip}|${String(username).toLowerCase()}`;
    const failure = this.#failures.get(key);
    if (failure?.lockedUntil > this.now()) {
      return { ok: false, status: 429, error: 'تلاش‌های ناموفق زیاد بود؛ چند دقیقه بعد دوباره امتحان کن.' };
    }
    const valid = typeof username === 'string' && typeof password === 'string' && await this.users.verify(username, password);
    if (!valid) {
      const count = (failure && failure.lockedUntil == null ? failure.count : 0) + 1;
      this.#failures.set(key, count >= this.maxFailures ? { count: 0, lockedUntil: this.now() + this.lockoutMs } : { count });
      return { ok: false, status: 401, error: 'نام کاربری یا گذرواژه درست نیست.' };
    }
    this.#failures.delete(key);
    const token = randomBytes(32).toString('base64url');
    const session = { user: username, csrf: randomBytes(24).toString('base64url'), createdAt: this.now(), lastSeen: this.now() };
    this.#sessions.set(token, session);
    return { ok: true, token, session };
  }

  logout(token) { this.#sessions.delete(token); }

  tokenOf(req) { return parseCookies(req.headers.cookie)[SESSION_COOKIE] || null; }

  session(req) {
    const token = this.tokenOf(req);
    const session = token && this.#sessions.get(token);
    if (!session) return null;
    const now = this.now();
    if (now - session.createdAt > this.ttlMs || now - session.lastSeen > this.idleMs) {
      this.#sessions.delete(token);
      return null;
    }
    session.lastSeen = now;
    return session;
  }

  cookie(token) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(this.ttlMs / 1000)}${this.secureCookie ? '; Secure' : ''}`;
  }

  clearCookie() {
    return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${this.secureCookie ? '; Secure' : ''}`;
  }

  /** Origin باید هم‌میزبان باشد (یا در allowedOrigins)؛ cross-site صریحاً رد می‌شود. */
  checkOrigin(req) {
    if (req.headers['sec-fetch-site'] === 'cross-site') return 'درخواست cross-site پذیرفته نمی‌شود.';
    const origin = req.headers.origin;
    if (!origin) return null;
    if (this.allowedOrigins.has(origin)) return null;
    let host;
    try { host = new URL(origin).host; } catch { return 'Origin نامعتبر است.'; }
    return host === req.headers.host ? null : 'Origin با میزبان سرور نمی‌خواند.';
  }

  /** برای درخواست‌های تغییردهنده (غیر GET/HEAD): هدر X-CSRF-Token + Origin. */
  checkCsrf(req, session) {
    const originProblem = this.checkOrigin(req);
    if (originProblem) return originProblem;
    const sent = req.headers['x-csrf-token'];
    if (!sent || !safeEqual(sent, session.csrf)) return 'توکن CSRF نامعتبر یا غایب است.';
    return null;
  }
}

export function createAuth(config, dataDir) {
  const users = new UserStore(dataDir);
  const settings = config.auth || {};
  return new Auth({
    users,
    sessionTtlMinutes: Number(settings.sessionTtlMinutes ?? 480),
    idleMinutes: Number(settings.idleMinutes ?? 120),
    secureCookie: settings.secureCookie === true,
    allowedOrigins: Array.isArray(settings.allowedOrigins) ? settings.allowedOrigins : []
  });
}
