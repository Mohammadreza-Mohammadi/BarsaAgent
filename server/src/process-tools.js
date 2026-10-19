import { execFile } from 'node:child_process';

/** خطوط کامل را از chunkهای stream جدا می‌کند؛ مرز کاراکتر چندبایتی با setEncoding رعایت شده. */
export function lineSplitter(onLine) {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? '';
      for (const line of parts) onLine(line);
    },
    flush() {
      if (pending) { onLine(pending); pending = ''; }
    }
  };
}

export function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { shell: false, windowsHide: true }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
  });
}

/**
 * بستن **درخت** یک فرآیند که خود کانبان راه انداخته (کانبان فقط pid ِ فرزندهای
 * خودش را می‌شناسد؛ این تابع هرگز pid دلخواه نمی‌گیرد — caller باید از registry
 * بیاید).
 *
 * ویندوز: اول `taskkill /T /PID` (درخواست مؤدبانه)، و اگر بعد از `graceMs` هنوز
 * زنده بود `taskkill /T /F /PID`. فرآیند node بی‌پنجره معمولاً به درخواست
 * مؤدبانه جواب نمی‌دهد، پس عملاً مرحله‌ی دوم است که می‌بندد؛ مرحله‌ی اول فرصتی
 * است برای فرآیندی که واقعاً می‌شنود.
 * posix: SIGTERM به گروه فرآیند (فرزند با detached:true ساخته شده) و بعد SIGKILL.
 */
export async function killProcessTree(pid, { graceMs = 5000, platform = process.platform, exec = run, alive = isPidAlive } = {}) {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error('pid نامعتبر.');
  const steps = [];
  if (platform === 'win32') {
    steps.push(await exec('taskkill', ['/T', '/PID', String(pid)]));
    const deadline = Date.now() + graceMs;
    while (alive(pid) && Date.now() < deadline) await sleep(100);
    if (alive(pid)) steps.push(await exec('taskkill', ['/T', '/F', '/PID', String(pid)]));
  } else {
    try { process.kill(-pid, 'SIGTERM'); } catch { /* گروه وجود ندارد */ }
    const deadline = Date.now() + graceMs;
    while (alive(pid) && Date.now() < deadline) await sleep(100);
    if (alive(pid)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ } }
  }
  return { stillAlive: alive(pid), steps: steps.length };
}
