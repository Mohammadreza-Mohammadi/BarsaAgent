import fs from 'node:fs';
import path from 'node:path';
import { collectJson } from './cli.js';

export const MANAGER_CONTRACT_NAME = 'barsa-agent-manager';
export const MANAGER_CONTRACT_VERSION = 1;

const REQUIRED = [
  'taskStatus',
  'events',
  'artifact',
  'run',
  'answer.approve',
  'answer.reject',
  'answer.clarify',
  'importIssue'
];

// افزوده‌های additive فاز ۲ (verify/review/health) که فقط با capability هم بیایند
// معنا دارند — غایب بودن آنها خطای startup نیست، فقط یعنی UI باید صریح بگوید
// «این Manager هنوز نمی‌دهد» به‌جای سکوت (بازبینی فاز ۲، بند ب-۱).
const OPTIONAL_STATUS_FIELDS = ['verify', 'review', 'health'];

function capability(payload, dotted) {
  let value = payload?.capabilities;
  for (const part of dotted.split('.')) value = value?.[part];
  return value === true;
}

/**
 * `status` قبلاً یک بولین تخت بود؛ از فاز ۲ می‌تواند `{ base, verify, review, health }`
 * هم باشد. هر دو شکل باید «base پشتیبانی می‌شود» را true بدهند — این یعنی
 * تغییر شکل additive واقعاً additive ماند، نه شکستن هر Manager قدیمی‌تر.
 */
function hasStatusBase(payload) {
  const status = payload?.capabilities?.status;
  return status === true || status?.base === true;
}

/** کدام‌یک از فیلدهای additive فاز ۲ را این Manager در status --json می‌دهد. */
export function statusFieldCapabilities(payload) {
  const status = payload?.capabilities?.status;
  const flat = status && typeof status === 'object' ? status : {};
  return Object.fromEntries(OPTIONAL_STATUS_FIELDS.map(name => [name, flat[name] === true]));
}

export function validateCapabilities(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') errors.push('پاسخ capabilities یک object معتبر نیست.');
  if (payload?.contract !== MANAGER_CONTRACT_NAME) errors.push(`contract باید ${MANAGER_CONTRACT_NAME} باشد.`);
  if (Number(payload?.contractVersion) !== MANAGER_CONTRACT_VERSION) errors.push(`contractVersion باید ${MANAGER_CONTRACT_VERSION} باشد.`);
  const missing = REQUIRED.filter(name => !capability(payload, name));
  if (!hasStatusBase(payload)) missing.push('status');
  if (missing.length) errors.push(`قابلیت‌های اجباری موجود نیستند: ${missing.join(', ')}`);
  return { ok: errors.length === 0, errors, missing };
}

export async function inspectManager(repo) {
  const script = path.resolve(repo.path, repo.managerScript);
  if (!fs.existsSync(repo.path)) {
    return { ok: false, repoId: repo.id, errors: [`مسیر repo وجود ندارد: ${repo.path}`] };
  }
  if (!fs.existsSync(script)) {
    return { ok: false, repoId: repo.id, errors: [`managerScript پیدا نشد: ${script}`] };
  }
  try {
    const payload = await collectJson(repo, ['capabilities', '--json']);
    const validation = validateCapabilities(payload);
    return {
      ok: validation.ok,
      repoId: repo.id,
      contract: payload.contract,
      contractVersion: Number(payload.contractVersion),
      managerVersion: payload.managerVersion ?? payload.version ?? null,
      protocolVersion: payload.protocolVersion ?? null,
      capabilities: payload.capabilities ?? {},
      statusFields: statusFieldCapabilities(payload),
      errors: validation.errors
    };
  } catch (error) {
    return {
      ok: false,
      repoId: repo.id,
      errors: [
        `اجرای manager.js capabilities --json شکست خورد: ${error.message}`,
        'نسخهٔ Manager باید قرارداد BarsaAgent Manager Contract v1 را پیاده کند.'
      ]
    };
  }
}

export async function inspectManagers(config) {
  return Promise.all(config.repos.map(inspectManager));
}

export async function assertManagersCompatible(config) {
  const results = await inspectManagers(config);
  const failed = results.filter(x => !x.ok);
  if (failed.length) {
    const lines = failed.flatMap(item => [
      `Repo ${item.repoId}:`,
      ...item.errors.map(error => `  - ${error}`)
    ]);
    const error = new Error(`BarsaAgent به دلیل ناسازگاری Manager شروع نشد.\n${lines.join('\n')}`);
    error.results = results;
    throw error;
  }
  return results;
}
