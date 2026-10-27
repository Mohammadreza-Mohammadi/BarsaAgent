// فهرست ِ مجاز ِ پسوند و سقف ِ اندازه‌ی پیوست — **از خود ِ Manager** (TOOLING-050 د)، نه فهرست ِ سخت‌کدشده در کانبان.
//
// Manager این policy را در `scripts/lib/attachments.js` دارد (پیش‌فرض + `attachments.kinds` در repository.yaml/local) و هیچ‌کدام از
// `status` / `capabilities` / `config --effective` آن را نمی‌دهند. پس همان تابع ِ فقط‌خواندنی ِ Manager را (`loadAttachmentsConfig`) در یک
// فرآیند ِ node با اسکریپت ِ ثابت اجرا می‌کنیم و فقط policy و فهرست ِ ممنوع را برمی‌گردانیم (نه `root`، نه هیچ مسیری). هیچ‌چیز نمی‌نویسد.
// اگر خواندن نشد (Manager قدیمی‌تر از ۰۵۰): null — پیش‌سنجی ِ سمت ِ ما فقط سقف ِ اندازه‌ی سرور است و تصمیم ِ نهایی با Manager.
import { execFile } from 'node:child_process';
import path from 'node:path';

const SCRIPT = `
const path = require('node:path');
const lib = require(path.join(process.cwd(), 'scripts', 'lib', 'attachments.js'));
const cfg = lib.loadAttachmentsConfig(path.join(process.cwd(), '.agent-work', 'config', 'repository.yaml'));
process.stdout.write(JSON.stringify({ configured: !!cfg.root, policy: cfg.policy, forbidden: lib.FORBIDDEN_EXTENSIONS }));
`;

const TTL_MS = 60_000;
const MB = 1024 * 1024;

function runScript(repo) {
  return new Promise(resolve => {
    const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    execFile(process.execPath, ['-e', SCRIPT], { cwd: path.resolve(repo.path), env, timeout: 15_000, windowsHide: true, maxBuffer: 256 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed && parsed.policy?.kinds && Array.isArray(parsed.forbidden) ? parsed : null);
      } catch { resolve(null); }
    });
  });
}

/** @returns {(repo) => Promise<{configured, policy, forbidden} | null>} با کش ِ کوتاه. */
export function createPolicyReader({ run = runScript, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async repo => {
    const hit = cache.get(repo.id);
    if (hit && now() - hit.at < TTL_MS) return hit.value;
    const value = await run(repo);
    cache.set(repo.id, { at: now(), value });
    return value;
  };
}

const humanMb = bytes => `${(bytes / MB).toFixed(bytes >= 10 * MB ? 0 : 1)}MB`;

/**
 * پیش‌سنجی ِ یک فایل (نام + اندازه‌ی اعلام‌شده). منطق ِ نهایی با Manager است؛ این فقط زود و روشن رد می‌کند.
 * @returns {{ ok: true, kind: string|null, cap: number } | { ok: false, message: string }}
 */
export function checkUpload({ name, size }, info, { maxUploadBytes }) {
  if (!info) return size > maxUploadBytes ? { ok: false, message: `اندازه‌ی فایل (${humanMb(size)}) از سقف ِ سرور (${humanMb(maxUploadBytes)}) بیشتر است.` } : { ok: true, kind: null, cap: maxUploadBytes };
  const lowered = String(name ?? '').toLowerCase();
  const parts = lowered.split('.').slice(1).map(part => `.${part}`);
  const bad = parts.find(part => info.forbidden.includes(part));
  if (bad) return { ok: false, message: `پسوند ِ ${bad} ممنوع است (فایل ِ اجرایی/اسکریپت/قابل‌اجرا در مرورگر پیوست نمی‌شود).` };
  const ext = path.extname(lowered);
  const kind = Object.entries(info.policy.kinds).find(([, rule]) => rule.extensions.includes(ext))?.[0] ?? null;
  if (!kind) {
    const allowed = Object.values(info.policy.kinds).flatMap(rule => rule.extensions).join(' ');
    return { ok: false, message: `پسوند ِ «${ext || 'بدون پسوند'}» مجاز نیست. مجاز: ${allowed}` };
  }
  const cap = Math.min(info.policy.kinds[kind].maxBytes, maxUploadBytes);
  if (Number.isFinite(size) && size > cap) return { ok: false, message: `اندازه‌ی فایل (${humanMb(size)}) از سقف ِ نوع ِ ${kind} (${humanMb(cap)}) بیشتر است.` };
  return { ok: true, kind, cap };
}

/** شکل ِ برگشتی ِ GET /api/attachments/policy برای UI. */
export function policyView(info, { maxUploadBytes, maxFiles }) {
  return {
    available: !!info,
    configured: info?.configured ?? null,
    kinds: info ? Object.fromEntries(Object.entries(info.policy.kinds).map(([kind, rule]) => [kind, { extensions: rule.extensions, maxBytes: Math.min(rule.maxBytes, maxUploadBytes) }])) : null,
    forbidden: info?.forbidden ?? null,
    maxUploadBytes, maxFiles
  };
}
