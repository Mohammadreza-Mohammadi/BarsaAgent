// عکس لحظه‌ای از فرآیندهای سیستم (فقط خواندنی) برای `barsa diag` و شناسایی درخت یک `npm ci`.
//
// ویندوز: `Get-CimInstance Win32_Process` (همان چیزی که انسان روی RDP می‌زد) با یک اسکریپت **ثابت** — هیچ بخشی از آن
// از ورودی کاربر ساخته نمی‌شود. posix: `ps`. برنامه‌ای اجرا نمی‌شود و چیزی کشته نمی‌شود؛ بستن فقط در
// kill-stuck-install و فقط با pid ِ درخت ِ رجیستری (process-tools.killProcessTree).
import { execFile } from 'node:child_process';
import path from 'node:path';

const PS_SCRIPT = [
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
  "$ErrorActionPreference = 'SilentlyContinue';",
  'Get-CimInstance Win32_Process | ForEach-Object {',
  '  [pscustomobject]@{',
  '    pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine;',
  "    start = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null });",
  '    cpu = [math]::Round((([double]$_.UserModeTime) + ([double]$_.KernelModeTime)) / 10000000, 1)',
  '  }',
  '} | ConvertTo-Json -Compress'
].join(' ');

function run(file, args, timeoutMs = 25_000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout));
    });
  });
}

/** @returns {{pid:number, ppid:number, name:string, cmd:string, startedAt:number|null, cpuSeconds:number|null}[]} */
export function parseWindowsProcesses(json) {
  const text = String(json ?? '').trim();
  if (!text) return [];
  let value;
  try { value = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(value) ? value : [value];
  return rows.filter(row => row && Number.isInteger(row.pid)).map(row => ({
    pid: row.pid,
    ppid: Number.isInteger(row.ppid) ? row.ppid : 0,
    name: String(row.name ?? ''),
    cmd: String(row.cmd ?? ''),
    startedAt: row.start ? Date.parse(row.start) || null : null,
    cpuSeconds: Number.isFinite(Number(row.cpu)) ? Number(row.cpu) : null
  }));
}

/** خروجی `ps -eww -o pid=,ppid=,etimes=,times=,args=` */
export function parsePsProcesses(text, now = Date.now()) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const cmd = match[5];
    out.push({
      pid: Number(match[1]), ppid: Number(match[2]), name: path.basename(cmd.split(/\s+/)[0] || ''), cmd,
      startedAt: now - Number(match[3]) * 1000, cpuSeconds: Number(match[4])
    });
  }
  return out;
}

export async function listProcesses({ platform = process.platform, exec = run, now = Date.now } = {}) {
  if (platform === 'win32') {
    // مسیر مطلق ِ Windows PowerShell اول: سرویس NSSM یا یک shell بدون System32 در PATH، `powershell.exe` را پیدا نمی‌کند.
    const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
    const candidates = [path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), 'powershell.exe', 'pwsh'];
    const errors = [];
    for (const exe of candidates) {
      try { return parseWindowsProcesses(await exec(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT])); }
      catch (error) { errors.push(`${path.basename(exe)}: ${error?.code || error?.message}`); }
    }
    throw new Error(`فهرست فرآیندها خوانده نشد (${errors.join('؛ ')})`);
  }
  return parsePsProcesses(await exec('ps', ['-eww', '-o', 'pid=,ppid=,etimes=,times=,args=']), now());
}

/** نگاشت pid → فرزندان مستقیم. */
export function childrenIndex(processes) {
  const map = new Map();
  for (const proc of processes) {
    if (!map.has(proc.ppid)) map.set(proc.ppid, []);
    map.get(proc.ppid).push(proc);
  }
  return map;
}

/** همه‌ی نوادگان یک pid (خود pid نه). از حلقه‌ی ppid (استفاده‌ی دوباره از pid) محافظت شده. */
export function descendantsOf(processes, rootPid) {
  const index = childrenIndex(processes);
  const byPid = new Map(processes.map(p => [p.pid, p]));
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const pid = queue.shift();
    const parent = byPid.get(pid);
    for (const child of index.get(pid) || []) {
      if (seen.has(child.pid)) continue;
      // pid ِ استفاده‌شده‌ی دوباره: فرزندی که قدیمی‌تر از پدر است فرزند او نیست.
      if (parent?.startedAt && child.startedAt && child.startedAt < parent.startedAt - 2000) continue;
      seen.add(child.pid);
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

const norm = text => String(text ?? '').replace(/\\/g, '/').toLowerCase();

/**
 * فرآیندهای مرتبط با یک تسک: «بذر»ها (argv حاوی مسیر worktree/پوشه‌ی تسک، یا `manager.js … <id>`، یا ریشه‌ی درخت
 * رجیستری کانبان) + نوادگانشان. تطبیق متنی فقط **بذر** را پیدا می‌کند؛ هرچه زیر بذر است از روی درخت (ppid) می‌آید.
 */
export function relatedToTask(processes, { taskId, worktreePath, taskDir, rootPids = [] }) {
  const id = String(taskId);
  const wt = worktreePath ? norm(worktreePath).replace(/\/+$/, '') : null;
  const td = taskDir ? norm(taskDir).replace(/\/+$/, '') : null;
  const managerRe = new RegExp(`manager\\.js["']?\\s+(?:\\S+\\s+)*?(?:--task\\s+)?${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i');
  const seeds = processes.filter(proc => {
    if (rootPids.includes(proc.pid)) return true;
    const cmd = norm(proc.cmd);
    if (wt && cmd.includes(wt)) return true;
    if (td && cmd.includes(td)) return true;
    return managerRe.test(proc.cmd);
  });
  const found = new Map(seeds.map(p => [p.pid, p]));
  for (const seed of seeds) for (const child of descendantsOf(processes, seed.pid)) found.set(child.pid, child);
  return [...found.values()].sort((a, b) => a.pid - b.pid);
}

const INTERESTING = /^(node|npm|npx|claude|git|tf|dotnet|msbuild)(\.exe|\.cmd)?$/i;

/** برای diag --system: node/npm/claude/git/tf و cmd ی که پدرش یکی از آن‌هاست. */
export function interestingProcesses(processes) {
  // نویز: زیرفرآیندهای Electron ِ اپ دسکتاپ Claude (--type=renderer/gpu/…) و daemon ِ fsmonitor ِ git.
  const noise = /--type=(?:renderer|gpu-process|utility|crashpad-handler|zygote)|fsmonitor--daemon/i;
  const base = processes.filter(p => INTERESTING.test(p.name) && !noise.test(p.cmd));
  const pids = new Set(base.map(p => p.pid));
  const cmds = processes.filter(p => /^cmd(\.exe)?$/i.test(p.name) && pids.has(p.ppid));
  return [...base, ...cmds].sort((a, b) => a.pid - b.pid);
}

/** یک `npm ci` ِ واقعی (نه `npm run ci`، نه `npm install`): argv دارای توکن مستقل ِ `ci` بعد از npm. */
export function isNpmCi(proc) {
  if (!/^(node|npm)(\.exe|\.cmd)?$/i.test(proc.name) && !/^cmd(\.exe)?$/i.test(proc.name)) return false;
  const cmd = String(proc.cmd ?? '');
  if (!/npm/i.test(cmd)) return false;
  return /(?:^|[\s"'\\/])ci(?:["']|\s|$)/.test(cmd.replace(/npm-cli\.js/i, 'npm-cli.js '));
}

/**
 * فرآیندهای کمکی ِ **خود diag**: هر فرزند ِ سرویس کانبان که زیر ریشه‌ی یک اجرای ثبت‌شده در registry نیست (مثلاً
 * `manager.js status`، `git` و PowerShell ِ همین لیست‌گیری) — نباید در خروجی به‌عنوان «فرآیند ِ تسک» بیایند.
 */
export function ownHelperPids(processes, { selfPid = process.pid, rootPids = [] } = {}) {
  const helpers = new Set(descendantsOf(processes, selfPid).map(p => p.pid));
  for (const root of rootPids) {
    helpers.delete(root);
    for (const child of descendantsOf(processes, root)) helpers.delete(child.pid);
  }
  return helpers;
}

export function ageMs(proc, now = Date.now()) {
  return proc.startedAt ? Math.max(0, now - proc.startedAt) : null;
}
