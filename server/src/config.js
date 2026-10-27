import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import YAML from 'yaml';

// خواندن config با یک پارسر YAML واقعی (کتابخانه‌ی `yaml`). پارسر دست‌ساز قبلی توضیح بعد از مقدار را جدا
// نمی‌کرد: `proxy: ""   # x` به‌صورت رشته‌ی `"" # x` خوانده می‌شد و به‌عنوان HTTPS_PROXY به claude می‌رسید، و
// `autoStartOnCreate: false   # x` یک رشته‌ی غیرخالی یعنی «روشن» می‌شد.
export function parseConfigYaml(text) {
  const doc = YAML.parseDocument(String(text), { uniqueKeys: true, prettyErrors: true });
  if (doc.errors.length) {
    const first = doc.errors[0];
    const where = first.linePos?.[0] ? ` (خط ${first.linePos[0].line}، ستون ${first.linePos[0].col})` : '';
    throw new Error(`کانفیگ YAML نامعتبر است${where}: ${first.message.split(/\r?\n/)[0]}`);
  }
  const value = doc.toJS();
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('کانفیگ باید یک map (کلید: مقدار) باشد.');
  return value;
}

// نوع کلیدهای شناخته‌شده. «رشته در جای بولی» یا «رشته در جای عدد» خطای config است، نه «درست»:
// `autoStartOnCreate: "no"` نباید بی‌صدا روشن بماند. کلیدهای ناشناخته دست‌نخورده می‌مانند.
const bool = value => typeof value === 'boolean';
const num = (min, max = Infinity) => value => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const int = (min, max = Infinity) => value => Number.isInteger(value) && value >= min && value <= max;
const str = value => typeof value === 'string';
const nonEmptyStr = value => typeof value === 'string' && value.trim() !== '';
const strOrNull = value => value === null || typeof value === 'string';
const strList = value => Array.isArray(value) && value.every(str);
const oneOf = (...allowed) => value => allowed.includes(value);

const SCHEMA = [
  ['server.port', int(1, 65535), 'عدد صحیح بین ۱ تا ۶۵۵۳۵'],
  ['server.host', nonEmptyStr, 'رشته‌ی غیرخالی'],
  ['server.staticDir', nonEmptyStr, 'رشته‌ی غیرخالی'],
  ['run.maxConcurrent', int(1), 'عدد صحیح ≥ ۱'],
  ['run.autoStartOnCreate', bool, 'true یا false (بدون گیومه)'],
  ['run.autoResumeAfterAnswer', bool, 'true یا false (بدون گیومه)'],
  ['run.proxy', strOrNull, 'رشته (آدرس پروکسی) یا "" برای «بدون پروکسی»'],
  ['run.stopGraceMs', num(0), 'عدد ≥ ۰ (میلی‌ثانیه)'],
  ['board.doneDays', num(0), 'عدد ≥ ۰'],
  ['auth.secureCookie', bool, 'true یا false (بدون گیومه)'],
  ['auth.sessionTtlMinutes', num(1), 'عدد > ۰ (دقیقه)'],
  ['auth.allowedOrigins', strList, 'فهرستی از رشته‌ها'],
  ['dataDir', nonEmptyStr, 'رشته‌ی غیرخالی (مسیر)'],
  ['editor.command', str, 'رشته (مسیر executable)'],
  ['logs.errFile', nonEmptyStr, 'رشته‌ی غیرخالی (مسیر kanban.err.log برای barsa diag --system)'],
  ['health.proxyTestUrl', nonEmptyStr, 'رشته‌ی غیرخالی (URL)'],
  ['attachments.maxUploadBytes', int(1024), 'عدد صحیح ≥ ۱۰۲۴ (بایت؛ پیش‌فرض ۲۰۰MB = سقف ِ ویدیو در Manager)'],
  ['attachments.maxFiles', int(1), 'عدد صحیح ≥ ۱ (حداکثر پیوست در یک درخواست؛ پیش‌فرض ۲۰)'],
  ['shutdown.timeoutMs', int(1000), 'عدد صحیح ≥ ۱۰۰۰ (میلی‌ثانیه؛ پیش‌فرض ۱۰۰۰۰)'],
  ['shutdown.runWaitMs', int(0), 'عدد صحیح ≥ ۰ (میلی‌ثانیه؛ پیش‌فرض ۰ = برای run های زنده صبر نکن)'],
  ['shutdown.liveRuns', oneOf('terminate', 'leave'), '"terminate" یا "leave"']
];

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'آرایه';
  if (typeof value === 'string') return `رشته‌ی ${JSON.stringify(value)}`;
  return `${typeof value === 'number' ? 'عدد' : typeof value} ${String(value)}`;
}

export function validateConfig(config) {
  const problems = [];
  for (const [dotted, ok, expected] of SCHEMA) {
    let value = config;
    for (const part of dotted.split('.')) value = value != null && typeof value === 'object' ? value[part] : undefined;
    if (value === undefined) continue;
    if (!ok(value)) problems.push(`  - ${dotted}: مقدار ${describe(value)} است؛ باید ${expected} باشد.`);
  }
  repos: for (const [index, repo] of (Array.isArray(config.repos) ? config.repos : []).entries()) {
    if (repo == null || typeof repo !== 'object') { problems.push(`  - repos[${index}]: باید یک map باشد.`); continue repos; }
    for (const key of ['id', 'path']) if (!nonEmptyStr(repo[key])) problems.push(`  - repos[${index}].${key}: رشته‌ی غیرخالی لازم است.`);
    if (repo.managerScript !== undefined && !nonEmptyStr(repo.managerScript)) problems.push(`  - repos[${index}].managerScript: رشته‌ی غیرخالی لازم است.`);
  }
  if (problems.length) throw new Error(`خطای config — نوع مقدار این کلیدها درست نیست:\n${problems.join('\n')}`);
  return config;
}

// مقادیر حساس/شناسه‌ی حساب (مثل UserId) نباید عدد خام در فایل کانفیگِ داخل
// مخزن باشند — همان قاعده‌ای که توکن‌ها از قبل رعایتش می‌کنند (بازبینی فاز ۲).
// مقدار `"${NAME}"` در YAML از `process.env.NAME` جایگزین می‌شود؛ اگر تنظیم
// نشده باشد صریح fail می‌کند — سکوت (مقدار خالی رفتن به یک وب‌سرویس) بدتر از
// خطای startup است.
const ENV_REF = /^\$\{([A-Z][A-Z0-9_]*)\}$/;
function resolveEnvRefs(value, env, pathLabel) {
  if (typeof value === 'string') {
    const m = ENV_REF.exec(value);
    if (!m) return value;
    const resolved = env[m[1]];
    if (resolved == null || resolved === '') throw new Error(`کانفیگ "${pathLabel}" به "\${${m[1]}}" اشاره می‌کند ولی متغیر محیطی ${m[1]} تنظیم نشده.`);
    return resolved;
  }
  if (Array.isArray(value)) return value.map((item, i) => resolveEnvRefs(item, env, `${pathLabel}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveEnvRefs(v, env, `${pathLabel}.${k}`)]));
  }
  return value;
}

// `.env.local` (رازهای محلی مثل BARSA_ISSUE_USER_ID؛ gitignored) از **دو جا** خوانده می‌شود، به این ترتیب اولویت:
//   ۱) متغیر محیطی از پیش تنظیم‌شده (مثلاً AppEnvironmentExtra ِ NSSM) — هیچ فایلی آن را عوض نمی‌کند
//   ۲) `.env.local` کنار فایل config
//   ۳) `.env.local` کنار برنامه (ریشه‌ی کانبان، کنار package.json)
// (۳) لازم است چون روی سرور config عمداً بیرون از مخزن است (BARSA_AGENT_CONFIG=D:arsa-agent-data\...) و فقط
// (۲) فایل کنار برنامه را هیچ‌وقت نمی‌دید. سرور (`index.js`) و `users-cli.js` هر دو از همین `loadConfig` می‌گذرند.
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function envLocalCandidates(configFile) {
  const files = [path.join(path.dirname(path.resolve(configFile)), '.env.local'), path.join(APP_ROOT, '.env.local')];
  const seen = new Set();
  return files.filter(file => { const key = path.resolve(file).toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
}

/**
 * @param options.strictEnvRefs  false → `"${NAME}"` ِ تنظیم‌نشده خطا نمی‌دهد و همان‌طور می‌ماند (برای
 *   `users-cli.js` که فقط dataDir لازم دارد و نباید برای ساختن یک حساب به BARSA_ISSUE_USER_ID نیاز داشته باشد).
 */
export function loadConfig(file = process.env.BARSA_AGENT_CONFIG || path.resolve('barsa-agent.config.yml'), env = process.env, options = {}) {
  // کلیدهایی که از .env.local آمده‌اند را نگه می‌داریم تا buildAgentEnv آن‌ها را از env ِ
  // فرزندان (agent/Manager) حذف کند: این‌ها رازهای محلی خود کانبان‌اند (مثل BARSA_ISSUE_USER_ID).
  const localEnvKeys = new Set();
  const localEnvFiles = [];
  if (env === process.env) {
    for (const localEnvFile of envLocalCandidates(file)) {
      if (!fs.existsSync(localEnvFile)) continue;
      for (const key of Object.keys(parseEnv(fs.readFileSync(localEnvFile, 'utf8')))) localEnvKeys.add(key);
      process.loadEnvFile(localEnvFile); // متغیرِ از پیش تنظیم‌شده را عوض نمی‌کند (محیط بر فایل مقدم است)
      localEnvFiles.push(localEnvFile);
    }
  }
  const parsed = validateConfig(parseConfigYaml(fs.readFileSync(file, 'utf8')));
  const config = options.strictEnvRefs === false ? parsed : resolveEnvRefs(parsed, env, 'config');
  config.localEnvKeys = [...localEnvKeys];
  config.localEnvFiles = localEnvFiles;
  if (!Array.isArray(config.repos) || !config.repos.length) throw new Error('حداقل یک repo در کانفیگ لازم است.');
  for (const repo of config.repos) {
    repo.path = path.resolve(repo.path); repo.managerScript = repo.managerScript || 'scripts/manager.js';
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(repo.id)) throw new Error(`شناسهٔ repo نامعتبر است: ${repo.id}`);
  }
  return config;
}

// داده‌های کانبان (دفتر ممیزی، خروجی اجراها، کاربران، اثبات‌های جداسازی) باید
// **بیرون از هر مخزن** باشند — مخزن‌ها را git و Manager می‌خوانند/می‌نویسند و
// یک اکشن کانبان نباید بتواند دفتر ممیزی خودش را با یک git clean پاک کند.
export function defaultDataDir() {
  return path.join(os.homedir(), '.barsa-agent');
}

export function resolveDataDir(config) {
  const dir = path.resolve(config?.dataDir || defaultDataDir());
  for (const repo of config?.repos || []) {
    const rel = path.relative(path.resolve(repo.path), dir);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      throw new Error(`dataDir (${dir}) نباید داخل مخزن "${repo.id}" باشد.`);
    }
  }
  return dir;
}
