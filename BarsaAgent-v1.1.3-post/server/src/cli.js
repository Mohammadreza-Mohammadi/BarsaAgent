import { spawn } from 'node:child_process';
import path from 'node:path';
import { environmentSecrets, redact } from './security.js';

export function managerCommand(repo, args, options = {}) {
  const script = path.resolve(repo.path, repo.managerScript);
  return spawn(process.execPath, [script, ...args.map(String)], {
    cwd: repo.path,
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

export function collect(repo, args) {
  return new Promise((resolve, reject) => {
    const child = managerCommand(repo, args);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve({ stdout, stderr: redact(stderr) });
      const secrets = environmentSecrets();
      const message = redact(stderr.trim() || stdout.trim() || `manager با کد ${code} متوقف شد`, secrets);
      reject(Object.assign(new Error(message), { code }));
    });
  });
}

export async function collectJson(repo, args) {
  const { stdout } = await collect(repo, args);
  try { return JSON.parse(stdout.trim()); }
  catch { throw new Error('خروجی JSON مدیر معتبر نیست.'); }
}
