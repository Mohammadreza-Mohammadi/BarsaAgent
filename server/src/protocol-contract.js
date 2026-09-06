import fs from 'node:fs';
import path from 'node:path';
import { collectJson } from './cli.js';

export const MANAGER_CONTRACT_NAME = 'barsa-agent-manager';
export const MANAGER_CONTRACT_VERSION = 1;

const REQUIRED = [
  'status',
  'taskStatus',
  'events',
  'artifact',
  'run',
  'answer.approve',
  'answer.reject',
  'answer.clarify',
  'importIssue'
];

function capability(payload, dotted) {
  let value = payload?.capabilities;
  for (const part of dotted.split('.')) value = value?.[part];
  return value === true;
}

export function validateCapabilities(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') errors.push('پاسخ capabilities یک object معتبر نیست.');
  if (payload?.contract !== MANAGER_CONTRACT_NAME) errors.push(`contract باید ${MANAGER_CONTRACT_NAME} باشد.`);
  if (Number(payload?.contractVersion) !== MANAGER_CONTRACT_VERSION) errors.push(`contractVersion باید ${MANAGER_CONTRACT_VERSION} باشد.`);
  const missing = REQUIRED.filter(name => !capability(payload, name));
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
