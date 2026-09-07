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

function collectChild(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', d => { stdout += d; });
    child.stderr?.on('data', d => { stderr += d; });
    child.on('error', reject);
    child.on('close', code => {
      const secrets = environmentSecrets();
      const safeOut = redact(stdout, secrets);
      const safeErr = redact(stderr, secrets);
      if (code === 0) return resolve({ stdout: safeOut, stderr: safeErr, code: 0 });
      const message = safeErr.trim() || safeOut.trim() || `فرآیند با کد ${code} متوقف شد`;
      reject(Object.assign(new Error(message), { code, stdout: safeOut, stderr: safeErr }));
    });
  });
}

export function collect(repo, args) {
  return collectChild(managerCommand(repo, args));
}

export async function collectJson(repo, args) {
  const { stdout } = await collect(repo, args);
  try { return JSON.parse(stdout.trim()); }
  catch { throw new Error('خروجی JSON مدیر معتبر نیست.'); }
}

export function validateAgentWork(repo) {
  // Health must behave exactly like the protocol validator itself, especially on Windows.
  // Spawning npm.cmd with shell:false is unreliable on Windows and can make a healthy
  // repository look unhealthy. Run the validator script directly with the current Node.
  const script = path.resolve(
    repo.path,
    repo.validateScript || 'scripts/validate-agent-work.js'
  );
  const child = spawn(process.execPath, [script], {
    cwd: repo.path,
    shell: false,
    windowsHide: true,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return collectChild(child);
}
