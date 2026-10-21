// `barsa` — CLI ِ کنترل از راه دور برای کانبان (Claude Remote Control).
//
// این فقط یک **کلاینت HTTP** برای سرور در حال اجرای کانبان است: هرگز manager.js را مستقیم صدا نمی‌زند و هیچ
// مسیر دومی برای انجام کارها ندارد؛ همه‌چیز از endpointهای خود کانبان می‌گذرد (فهرست بسته‌ی فرمان‌ها، دفتر ممیزی،
// registry ِ فرآیندها، ادامه‌ی خودکار بعد از جواب، و actions ِ Manager). توکن از یک فایل خوانده می‌شود، هیچ‌وقت
// در argv/لاگ/خروجی نمی‌آید.
//
// نام فایل remote-cli.js است چون server/src/cli.js از قبل کمک‌کننده‌ی spawn ِ Manager برای خود سرور است.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROOT, defaultDataDir, parseConfigYaml } from './config.js';
import { environmentSecrets, redact } from './security.js';
import {
  ANSWER_MODES, DEFAULT_TOKEN_NAME, DEFAULT_URL, EXIT, NOT_REMOTE_ANSWER_FLAGS, NOT_REMOTE_COMMANDS, NOT_REMOTE_MESSAGE,
  READ_COMMANDS, WRITE_COMMANDS
} from './remote-cli-spec.js';

const MAX_TEXT_BYTES = 1_000_000;
const FINISHED = ['integrated', 'cancelled', 'abandoned'];
// کنترل‌کاراکتر/ANSI از متن بیرونی (لاگ agent، عنوان issue) به خروجی نرسد.
// eslint-disable-next-line no-control-regex
const CONTROL = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

class CliError extends Error {
  constructor(code, message, extra = {}) { super(message); this.exitCode = code; this.extra = extra; }
}
const usage = message => new CliError(EXIT.USAGE, message);

// --- راهنما ----------------------------------------------------------------------------------------------

export const HELP = `barsa — کنترل کانبان از راه دور (فقط همین فرمان‌ها)

خواندنی:
  barsa health                              سلامت محیط: اجرا، sync، claude
  barsa issues [--all]                      issueها (پیش‌فرض: فقط بدون تسک)
  barsa tasks [--waiting|--running|--blocked|--all]   فهرست کوتاه تسک‌ها
  barsa task <id>                           جزئیات یک تسک
  barsa log <id> [--tail N]                 انتهای لاگ آخرین اجرا (پیش‌فرض ۴۰ خط)
  barsa waiting [--since <ISO>]             تسک‌های منتظر تصمیم تو از آن زمان

نوشتنی (روی گوشی تأیید می‌خواهند):
  barsa create-from-issue <externalId> [--run]
  barsa create-task --title <عنوان> (--text-file <f> | --stdin)
  barsa run <id>
  barsa stop <id>
  barsa answer <id> --approve [--text-file <f> | --stdin]
  barsa answer <id> --reject [--route implementer|architect] (--text-file <f> | --stdin)
  barsa answer <id> --clarify (--text-file <f> | --stdin)
  barsa answer <id> --note (--text-file <f> | --stdin)
  barsa answer <id> --raise-limit <field>=<n> (--text-file <f> | --stdin)
  barsa answer <id> --unblock (--text-file <f> | --stdin)

گزینه‌های مشترک: --json  --repo <id>  --token-file <f>  --url <loopback-url>
exit code: 0 موفق · 2 آرگومان بد · 3 اکشن مجاز نیست · 4 سرور در دسترس نیست · 5 احراز هویت · 6 Manager/سرور رد کرد · 41 اجرا خاموش است
`;

// --- پارس آرگومان --------------------------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--tail', '--since', '--repo', '--token-file', '--url', '--title', '--text-file', '--route', '--raise-limit']);
const BOOL_FLAGS = new Set([
  '--json', '--all', '--waiting', '--running', '--blocked', '--run', '--stdin', '--help', '-h',
  '--approve', '--reject', '--clarify', '--note', '--unblock'
]);

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (NOT_REMOTE_ANSWER_FLAGS.includes(arg.split('=')[0])) throw usage(`${arg}: ${NOT_REMOTE_MESSAGE}`);
    if (arg.startsWith('--') && arg.includes('=') && VALUE_FLAGS.has(arg.split('=')[0]) && arg.split('=')[0] !== '--raise-limit') {
      const [name, ...rest] = arg.split('=');
      flags[name] = rest.join('=');
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith('--') && arg !== '--raise-limit')) throw usage(`${arg} مقدار می‌خواهد.`);
      flags[arg] = value;
      i += 1;
    } else if (BOOL_FLAGS.has(arg)) {
      flags[arg] = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      throw usage(`گزینه‌ی ناشناخته: ${arg}\n(برای راهنما: barsa --help)`);
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

// --- پیکربندی: URL و توکن ---------------------------------------------------------------------------------------

function resolveUrl(flags, env) {
  const raw = flags['--url'] || env.BARSA_REMOTE_URL || DEFAULT_URL;
  let url;
  try { url = new URL(raw); } catch { throw usage(`URL نامعتبر است: ${raw}`); }
  // توکن فقط به سرور محلی فرستاده می‌شود؛ جلوی نشتِ توکن به یک میزبان دیگر با یک --url اشتباه.
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:') {
    throw usage('--url/BARSA_REMOTE_URL باید http روی loopback باشد (127.0.0.1 یا localhost)؛ توکن به جای دیگری فرستاده نمی‌شود.');
  }
  return url.origin;
}

export function resolveTokenFile(flags, env) {
  const explicit = flags['--token-file'] || env.BARSA_REMOTE_TOKEN_FILE;
  if (explicit) return path.resolve(explicit);
  const configFile = env.BARSA_AGENT_CONFIG || path.join(APP_ROOT, 'barsa-agent.config.yml');
  let dataDir = defaultDataDir();
  try {
    const config = parseConfigYaml(fs.readFileSync(configFile, 'utf8'));
    if (config.dataDir) dataDir = config.dataDir;
  } catch { /* config نیست: dataDir پیش‌فرض */ }
  return path.join(path.resolve(dataDir), 'tokens', `${env.BARSA_REMOTE_TOKEN_NAME || DEFAULT_TOKEN_NAME}.token`);
}

function readToken(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').trim(); }
  catch { throw new CliError(EXIT.AUTH, `فایل توکن خوانده نشد: ${file}\n(روی سرور توکن بساز؛ راهنما: docs/remote-control/README.md. یا BARSA_REMOTE_TOKEN_FILE / --token-file را درست بگذار.)`); }
  if (!text) throw new CliError(EXIT.AUTH, `فایل توکن خالی است: ${file}`);
  return text;
}

// --- HTTP -------------------------------------------------------------------------------------------------------

function makeClient({ base, token, timeoutMs }) {
  async function call(method, pathname, { query, body } = {}) {
    const url = new URL(pathname, base);
    for (const [key, value] of Object.entries(query || {})) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
      throw new CliError(EXIT.UNREACHABLE, timedOut ? `سرور کانبان در ${Math.round(timeoutMs / 1000)} ثانیه پاسخ نداد (${base}).` : `سرور کانبان در دسترس نیست (${base}). سرویس بالا است؟`);
    }
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* پاسخ غیر JSON */ }
    return { status: response.status, ok: response.ok, data, text };
  }
  return { call };
}

/** پاسخ ناموفق ← CliError با exit code درست؛ پیام سرور/Manager عیناً. */
function failFrom(response) {
  const message = response.data?.error || response.text.slice(0, 500) || `HTTP ${response.status}`;
  const managerExit = response.data?.managerExit;
  if (managerExit === EXIT.EXECUTION_OFF) return new CliError(EXIT.EXECUTION_OFF, message);
  if (response.status === 401 || response.status === 403) return new CliError(EXIT.AUTH, message);
  return new CliError(EXIT.REJECTED, message, managerExit !== undefined ? { managerExit } : {});
}

async function need(client, method, pathname, options) {
  const response = await client.call(method, pathname, options);
  if (!response.ok) throw failFrom(response);
  return response;
}

// --- کمک‌کننده‌ها ---------------------------------------------------------------------------------------------------

const clip = (value, max) => {
  const text = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const short = iso => (iso ? String(iso).slice(0, 16).replace('T', ' ') : '—');
const enc = encodeURIComponent;

async function readStdin(io) {
  const stream = io.stdin;
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_TEXT_BYTES) throw usage('متن بیش از حد بزرگ است.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readText(flags, io, { required }) {
  if (flags['--text-file'] && flags['--stdin']) throw usage('--text-file و --stdin با هم معنا ندارند.');
  let text = null;
  if (flags['--text-file']) {
    try {
      const stat = fs.statSync(flags['--text-file']);
      if (stat.size > MAX_TEXT_BYTES) throw usage('فایل متن بیش از حد بزرگ است.');
      text = fs.readFileSync(flags['--text-file'], 'utf8');
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw usage(`فایل متن خوانده نشد: ${flags['--text-file']}`);
    }
  } else if (flags['--stdin']) {
    text = await readStdin(io);
  }
  if (text !== null) text = text.replace(/^﻿/, '').replace(/\s+$/, '');
  if (required && !text) throw usage('متن لازم است: --text-file <f> یا --stdin (و غیرخالی).');
  return text || null;
}

function activeActions(task) {
  const actions = task?.actions;
  if (!actions || typeof actions !== 'object') return [];
  const out = [];
  for (const [key, value] of Object.entries(actions)) {
    if (value === true) out.push(key);
    else if (Array.isArray(value) && value.length) out.push(`${key}[${value.join(',')}]`);
  }
  return out;
}

/** پیش‌سنجی از actions ِ Manager (کانبان هیچ نسخه‌ی دومی از «مجاز است؟» ندارد). */
function assertAllowed(task, key, label, { field } = {}) {
  const actions = task?.actions;
  let ok = false;
  if (actions && typeof actions === 'object') {
    ok = key === 'raiseLimit' ? Array.isArray(actions.raiseLimit) && actions.raiseLimit.includes(field) : actions[key] === true;
  }
  if (ok) return;
  const allowed = activeActions(task);
  const why = !actions ? 'این Manager بلوک actions را نمی‌دهد (قدیمی است).' : '';
  const raise = key === 'raiseLimit' && Array.isArray(actions?.raiseLimit) && actions.raiseLimit.length ? ` فیلدهای قابل بالا بردن: ${actions.raiseLimit.join('، ')}.` : '';
  throw new CliError(EXIT.NOT_ALLOWED, `اکشن «${label}» برای این تسک الان مجاز نیست.${why}${raise}\nاکشن‌های مجاز: ${allowed.length ? allowed.join('، ') : 'هیچ'}`, { allowed });
}

// --- فرمان‌ها -------------------------------------------------------------------------------------------------------

const commands = {
  async health({ client, json }) {
    const { data } = await need(client, 'GET', '/api/env-health');
    const checks = data.checks || [];
    const byPrefix = prefix => checks.find(c => c.id.startsWith(prefix));
    const exec = byPrefix('manager-execution-');
    const sync = byPrefix('manager-version-');
    const claude = checks.find(c => c.id === 'claude');
    const auth = checks.find(c => c.id === 'claude-auth');
    const problems = checks.filter(c => c.status !== 'ok').map(c => ({ id: c.id, status: c.status, label: c.label, detail: clip(c.detail, 200), hint: clip(c.hint, 200) }));
    const out = {
      ok: data.ok === true, checkedAt: data.checkedAt,
      execution: exec ? { enabled: exec.data?.enabled ?? null, status: exec.status, detail: clip(exec.detail, 200) } : null,
      sync: sync ? { status: sync.status, ahead: sync.data?.ahead ?? null, behind: sync.data?.behind ?? null, lastFetchAt: sync.data?.lastFetchAt ?? null, detail: clip(sync.detail, 240) } : null,
      claude: { installed: claude ? claude.status === 'ok' : null, auth: auth ? auth.status === 'ok' : null },
      problems
    };
    if (json) return out;
    const lines = [`${out.ok ? '✅ محیط آماده است' : '❌ محیط ایراد دارد'} (${problems.filter(p => p.status === 'fail').length} خطا · ${problems.filter(p => p.status === 'warn').length} هشدار)`];
    if (exec) lines.push(`اجرا: ${exec.data?.enabled === false ? '⛔ خاموش' : exec.data?.enabled === true ? 'روشن' : clip(exec.detail, 80)}`);
    if (sync) lines.push(`sync: ${sync.data ? `${sync.data.ahead ?? '؟'} جلوتر · ${sync.data.behind ?? '؟'} عقب‌تر · آخرین fetch ${short(sync.data.lastFetchAt)}` : clip(sync.detail, 120)}`);
    lines.push(`claude: ${claude ? (claude.status === 'ok' ? 'نصب ✓' : 'مشکل ✗') : '—'} · ورود: ${auth ? (auth.status === 'ok' ? '✓' : '✗') : '—'}`);
    for (const p of problems.slice(0, 8)) lines.push(`${p.status === 'fail' ? '✗' : '!'} ${clip(p.label, 60)}: ${clip(p.detail, 100)}${p.hint ? ` — ${clip(p.hint, 100)}` : ''}`);
    if (problems.length > 8) lines.push(`… و ${problems.length - 8} مورد دیگر`);
    return lines.join('\n');
  },

  async issues({ client, flags, json }) {
    const { data } = await need(client, 'GET', '/api/issues');
    const all = Array.isArray(data) ? data : [];
    const open = all.filter(i => !i.importedTaskId);
    const shown = flags['--all'] ? all : open;
    const hiddenImported = flags['--all'] ? 0 : all.length - open.length;
    const items = shown.map(i => ({ externalId: String(i.externalId), title: clip(i.title, 200), status: i.status ?? null, labels: i.labels ?? [], importedTaskId: i.importedTaskId ?? null, importedRepoId: i.importedRepoId ?? null }));
    if (json) return { issues: items, hiddenImported };
    if (!items.length) return `issue بدون تسک نیست.${hiddenImported ? ` (${hiddenImported} تای دیگر قبلاً تسک شده؛ --all)` : ''}`;
    const lines = [`${items.length} issue${flags['--all'] ? '' : ' بدون تسک'}:`];
    for (const i of items.slice(0, 30)) lines.push(`#${i.externalId} · ${clip(i.title, 70)}${i.status ? ` (${clip(i.status, 20)})` : ''}${i.importedTaskId ? ` → تسک #${i.importedTaskId}` : ''}`);
    if (items.length > 30) lines.push(`… و ${items.length - 30} مورد دیگر`);
    if (hiddenImported) lines.push(`(${hiddenImported} تای دیگر قبلاً تسک شده؛ --all)`);
    return lines.join('\n');
  },

  async tasks({ client, flags, repo, json }) {
    const filter = flags['--waiting'] ? 'waiting' : flags['--running'] ? 'running' : flags['--blocked'] ? 'blocked' : flags['--all'] ? 'all' : 'active';
    const { data } = await need(client, 'GET', '/api/remote/tasks', { query: { filter, repo } });
    if (json) return data;
    const lines = [];
    if (data.execution?.enabled === false) lines.push('⛔ اجرا روی این دستگاه خاموش است.');
    if (!data.tasks.length) return [...lines, 'تسکی نیست.'].join('\n');
    lines.push(`${data.total} تسک (${{ waiting: 'منتظر تصمیم', running: 'در حال اجرا', blocked: 'blocked', all: 'همه', active: 'جاری' }[filter]}):`);
    for (const t of data.tasks) {
      const what = t.gate ? `منتظر ${t.gate.kind}` : t.blocker ? `blocked: ${t.blocker.kind}` : t.running ? 'در حال اجرا' : t.queued ? 'در صف' : t.state;
      lines.push(`#${t.id} · ${what} · ${clip(t.title, 60)}`);
    }
    if (data.truncated) lines.push('… (فهرست کوتاه شد)');
    return lines.join('\n');
  },

  async task({ client, positional, repo, json }) {
    const id = needId(positional);
    const [{ data: t }, running] = await Promise.all([
      need(client, 'GET', `/api/repos/${enc(repo)}/tasks/${enc(id)}`),
      client.call('GET', `/api/repos/${enc(repo)}/running`)
    ]);
    const run = Array.isArray(running.data) ? running.data.find(r => String(r.taskId) === String(id)) : null;
    const evidence = t.review?.evidence || {};
    const out = {
      id: String(t.id), title: clip(t.title ?? t.slug, 200), state: t.state, stateSince: t.stateSince ?? null,
      gate: t.awaitingHuman ? { kind: t.awaitingHuman.kind ?? null, since: t.awaitingHuman.since ?? null } : null,
      running: { running: run?.running === true, queued: run?.queued === true, exitCode: run?.exitCode ?? null },
      actions: t.actions ?? null,
      blocker: t.blocker ? { kind: t.blocker.kind ?? null, detail: clip(t.blocker.detail ?? t.blocker.reason ?? '', 500) } : null,
      review: t.review ? {
        decision: t.review.decision ?? null, evidenceStatus: t.review.evidenceStatus ?? null,
        acceptance: (evidence.acceptance || []).map(r => ({ ac: r.ac ?? null, verdict: r.verdict ?? null })),
        problems: (t.review.problems || []).map(p => clip(p, 200))
      } : null,
      releaseNote: t.releaseNote ? { userVisible: t.releaseNote.userVisible ?? null, headline: clip(t.releaseNote.headline, 200), body: clip(t.releaseNote.body, 600), approvedByHuman: t.releaseNote.approvedByHuman ?? null } : null,
      diff: t.diff ? { headCommit: t.diff.headCommit ?? null, files: (t.diff.files || []).map(f => ({ path: f.path, added: f.added ?? 0, deleted: f.deleted ?? 0, status: f.status ?? null, inScope: f.inScope ?? null })) } : null,
      externalSources: (t.externalSources || []).map(s => (s.error ? { id: s.id, error: clip(s.error, 200) } : { id: s.id, access: s.access, delivery: s.delivery, staged: s.staged, checkedIn: s.checkedIn })),
      budget: t.budget ?? null
    };
    if (json) return out;
    const lines = [`#${out.id} · ${out.title}`, `وضعیت: ${out.state}${out.gate ? ` · منتظر ${out.gate.kind} (از ${short(out.gate.since)})` : ''}${out.running.running ? ' · در حال اجرا' : out.running.queued ? ' · در صف' : ''}`];
    const active = activeActions(t);
    lines.push(`اکشن‌های مجاز: ${active.length ? active.join('، ') : (t.actions ? 'هیچ' : 'نامشخص (Manager قدیمی)')}`);
    if (out.blocker) lines.push(`blocker: ${out.blocker.kind} — ${clip(out.blocker.detail, 240)}`);
    if (out.review) {
      const verdicts = out.review.acceptance.map(r => `${r.ac}:${r.verdict}`).join(' ');
      lines.push(`بازبینی: ${out.review.decision ?? '—'}${verdicts ? ` · ${verdicts}` : ''}${out.review.problems.length ? ` · مشکل: ${out.review.problems.join('؛ ')}` : ''}`);
    }
    if (out.releaseNote) lines.push(`release note${out.releaseNote.userVisible === false ? ' (برای کاربر دیده نمی‌شود)' : ''}: ${out.releaseNote.headline}${out.releaseNote.body ? `\n  ${clip(out.releaseNote.body, 320)}` : ''}`);
    if (out.diff?.files.length) {
      const sum = out.diff.files.reduce((acc, f) => ({ a: acc.a + f.added, d: acc.d + f.deleted }), { a: 0, d: 0 });
      lines.push(`diff: ${out.diff.files.length} فایل (+${sum.a} −${sum.d})`);
      for (const f of out.diff.files.slice(0, 12)) lines.push(`  ${f.status === 'added' ? '+' : f.status === 'deleted' ? '−' : '~'} ${clip(f.path, 80)} (+${f.added} −${f.deleted})${f.inScope === false ? ' ⚠ خارج scope' : ''}`);
      if (out.diff.files.length > 12) lines.push(`  … و ${out.diff.files.length - 12} فایل دیگر`);
    }
    for (const s of out.externalSources) {
      lines.push(s.error ? `منبع بیرونی ${s.id}: خطا — ${s.error}` : `منبع بیرونی ${s.id} (${s.access}/${s.delivery}): staged=${s.staged ? `${String(s.staged.sha).slice(0, 8)} ${s.staged.mode}` : '—'} · checked-in=${s.checkedIn ? s.checkedIn.changesets.join(',') : '—'}`);
    }
    if (out.budget) lines.push(`budget: ${Object.entries(out.budget).map(([k, v]) => `${k} ${v.used}/${v.max}`).join(' · ')}`);
    return lines.join('\n');
  },

  async log({ client, flags, positional, repo, json }) {
    const id = needId(positional);
    const tail = flags['--tail'] === undefined ? 40 : Number(flags['--tail']);
    if (!Number.isInteger(tail) || tail < 1 || tail > 500) throw usage('--tail باید عدد صحیح ۱ تا ۵۰۰ باشد.');
    const { data } = await need(client, 'GET', `/api/repos/${enc(repo)}/tasks/${enc(id)}/log`, { query: { tail } });
    if (json) return { ...data, lines: data.lines.map(l => clip(l, 2000)) };
    if (!data.runId) return `برای تسک #${id} هنوز اجرایی از کانبان ثبت نشده.`;
    const head = `اجرای ${data.runId} · ${data.running ? 'در حال اجرا' : data.queued ? 'در صف' : `تمام شد (exit ${data.exitCode ?? '؟'})`}${data.truncated ? ` · آخرین ${tail} خط` : ''}`;
    return [head, ...data.lines.map(l => String(l).replace(CONTROL, ' ').slice(0, 400))].join('\n');
  },

  async waiting({ client, flags, repo, json }) {
    if (flags['--since'] && Number.isNaN(Date.parse(flags['--since']))) throw usage('--since باید زمان ISO باشد (مثلاً 2026-10-21T08:00:00Z).');
    const { data } = await need(client, 'GET', '/api/remote/waiting', { query: { since: flags['--since'], repo } });
    if (json) return data;
    const lines = data.tasks.length ? [`${data.tasks.length} تسک منتظر تصمیم تو:`] : ['چیز تازه‌ای منتظر تو نیست.'];
    for (const t of data.tasks) lines.push(`#${t.id} · ${t.gate.kind} (از ${short(t.gate.since)}) · ${clip(t.title, 60)}`);
    lines.push(`برای بررسی بعدی --since ${data.generatedAt ?? '<همین لحظه>'}`);
    return lines.join('\n');
  },

  async 'create-from-issue'({ client, flags, positional, repo, json }) {
    const externalId = positional[0];
    if (!externalId || positional.length > 1) throw usage('استفاده: barsa create-from-issue <externalId> [--run]');
    const { data } = await need(client, 'POST', '/api/issues/import', { body: { ids: [externalId], repo, start: flags['--run'] === true } });
    return created(data.results?.[0], json, { hintId: true });
  },

  async 'create-task'({ client, flags, io, repo, json }) {
    const title = String(flags['--title'] ?? '').trim();
    if (!title) throw usage('استفاده: barsa create-task --title <عنوان> (--text-file <f> | --stdin)');
    const text = await readText(flags, io, { required: true });
    const { data } = await need(client, 'POST', '/api/tasks/create', { body: { items: [{ repo, type: 'task', slug: title, requestText: `${title}\n\n${text}` }], start: false } });
    return created(data.results?.[0], json, { hintId: true });
  },

  async run({ client, positional, repo, json }) {
    const id = needId(positional);
    const { data: task } = await need(client, 'GET', `/api/repos/${enc(repo)}/tasks/${enc(id)}`);
    if (FINISHED.includes(task.state)) throw new CliError(EXIT.NOT_ALLOWED, `تسک #${id} پایان‌یافته است (${task.state}) و اجرا نمی‌شود.`);
    if (task.error) throw new CliError(EXIT.NOT_ALLOWED, `تسک #${id} خطا دارد: ${clip(task.error, 200)}`);
    const { data } = await need(client, 'POST', `/api/repos/${enc(repo)}/tasks/${enc(id)}/run`);
    if (json) return { ok: true, taskId: String(id), queued: data.queued === true, queuePosition: data.queuePosition ?? null };
    return `${data.queued ? `تسک #${id} در صف اجرا رفت${data.queuePosition ? ` (جایگاه ${data.queuePosition})` : ''}` : `اجرای تسک #${id} شروع شد`}.\nبا «barsa log ${id}» ببین.`;
  },

  async stop({ client, positional, repo, json }) {
    const id = needId(positional);
    const { data } = await need(client, 'POST', `/api/repos/${enc(repo)}/tasks/${enc(id)}/stop`);
    if (json) return { ok: true, taskId: String(id), wasQueued: data.wasQueued === true, stillAlive: data.stillAlive === true, exitCode: data.exitCode ?? null };
    return data.wasQueued ? `تسک #${id} از صف حذف شد.` : `اجرای تسک #${id} متوقف شد${data.stillAlive ? ' (هشدار: فرآیند هنوز زنده است)' : ''}.`;
  },

  async answer({ client, flags, positional, io, repo, json }) {
    const id = needId(positional);
    const modes = [];
    for (const mode of ['approve', 'reject', 'clarify', 'note', 'unblock']) if (flags[`--${mode}`]) modes.push(mode);
    if (flags['--raise-limit'] !== undefined) modes.push('raise-limit');
    if (modes.length !== 1) throw usage(`دقیقاً یکی از این‌ها: ${ANSWER_MODES.map(m => `--${m}`).join(' ')}`);
    const mode = modes[0];
    if (flags['--route'] && mode !== 'reject') throw usage('--route فقط کنار --reject معنا دارد.');
    if (flags['--route'] && !['implementer', 'architect'].includes(flags['--route'])) throw usage('--route باید implementer یا architect باشد.');

    let field; let value;
    if (mode === 'raise-limit') {
      const match = /^([A-Za-z]+)=(\d+)$/.exec(String(flags['--raise-limit']));
      if (!match) throw usage('قالب: --raise-limit <field>=<n> (n = سقف تازه‌ی کل)');
      [, field, value] = match; value = Number(value);
    }
    const text = await readText(flags, io, { required: mode !== 'approve' });

    // پیش‌سنجی از actions ِ همین تسک؛ داور نهایی سرور و Manager است.
    const { data: task } = await need(client, 'GET', `/api/repos/${enc(repo)}/tasks/${enc(id)}`);
    const key = { approve: 'approve', reject: 'reject', clarify: 'clarify', note: 'note', unblock: 'unblock', 'raise-limit': 'raiseLimit' }[mode];
    assertAllowed(task, key, mode, { field });

    const base = `/api/repos/${enc(repo)}/tasks/${enc(id)}`;
    let response;
    if (mode === 'approve') response = await need(client, 'POST', `${base}/answer`, { body: { mode: 'approve', ...(text ? { releaseNoteText: text } : {}) } });
    else if (mode === 'reject') response = await need(client, 'POST', `${base}/answer`, { body: { mode: 'reject', reason: text, ...(flags['--route'] ? { route: flags['--route'] } : {}) } });
    else if (mode === 'clarify') response = await need(client, 'POST', `${base}/answer`, { body: { mode: 'clarify', text } });
    else if (mode === 'note') response = await need(client, 'POST', `${base}/note`, { body: { text } });
    else if (mode === 'raise-limit') response = await need(client, 'POST', `${base}/raise-limit`, { body: { field, value, reason: text } });
    else response = await need(client, 'POST', `${base}/unblock`, { body: { reason: text } });

    const data = response.data || {};
    const resumed = data.autoResumed === true && (data.queued || data.started);
    if (json) return { ok: true, taskId: String(id), mode, autoResumed: data.autoResumed === true, queued: data.queued === true, started: data.started === true };
    return `تسک #${id}: ${mode} انجام شد.${resumed ? `\nاجرا خودکار ادامه یافت (${data.queued ? 'در صف' : 'شروع شد'}). با «barsa log ${id}» ببین.` : ''}${mode === 'unblock' || mode === 'raise-limit' ? `\nاجرا خودکار نیست؛ اگر خواستی «barsa run ${id}».` : ''}`;
  }
};

function needId(positional) {
  const id = positional[0];
  if (!id || positional.length > 1) throw usage('شناسه‌ی تسک لازم است (دقیقاً یکی).');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw usage('شناسه‌ی تسک نامعتبر است.');
  return id;
}

function created(result, json, { hintId }) {
  if (!result) throw new CliError(EXIT.REJECTED, 'پاسخ سرور نتیجه‌ای نداشت.');
  if (!result.ok) {
    if (result.managerExit === EXIT.EXECUTION_OFF) throw new CliError(EXIT.EXECUTION_OFF, result.message);
    throw new CliError(EXIT.REJECTED, result.message || 'ساخت تسک شکست خورد.', result.managerExit !== undefined ? { managerExit: result.managerExit } : {});
  }
  if (json) return { ok: true, taskId: String(result.taskId), repoId: result.repoId ?? null, queued: result.queued === true, started: result.started === true };
  const running = result.started ? 'ساخته شد و اجرا شروع شد' : result.queued ? 'ساخته شد و در صف اجراست' : 'ساخته شد';
  return `تسک #${result.taskId} ${running}.${result.started || result.queued ? `\nبا «barsa log ${result.taskId}» ببین.` : hintId ? `\nبرای اجرا: barsa run ${result.taskId}` : ''}`;
}

// --- اجرا --------------------------------------------------------------------------------------------------------------

/**
 * @returns {Promise<number>} exit code
 * io: { stdout(text), stderr(text), stdin, env }
 */
export async function run(argv, io = {}) {
  const env = io.env ?? process.env;
  const out = io.stdout ?? (text => process.stdout.write(text));
  const err = io.stderr ?? (text => process.stderr.write(text));
  let json = false;
  let secrets = environmentSecrets(env);
  const print = (write, text) => write(`${redact(String(text), secrets)}\n`);
  try {
    const { flags, positional } = parseArgs(argv);
    json = flags['--json'] === true;
    const [command, ...rest] = positional;
    if (!command || flags['--help'] || flags['-h'] || command === 'help') { print(out, HELP.trimEnd()); return EXIT.OK; }
    if (NOT_REMOTE_COMMANDS.includes(command)) throw usage(`${command}: ${NOT_REMOTE_MESSAGE}`);
    if (!READ_COMMANDS.includes(command) && !WRITE_COMMANDS.includes(command)) throw usage(`فرمان ناشناخته: ${command}\n(برای راهنما: barsa --help)`);

    const base = resolveUrl(flags, env);
    const token = readToken(resolveTokenFile(flags, env));
    secrets = [...secrets, token];
    const client = makeClient({ base, token, timeoutMs: command === 'health' ? 120_000 : 40_000 });

    // مخزن پیش‌فرض: --repo یا اولین مخزن سرور
    let repo = flags['--repo'];
    if (!repo && !['health', 'issues'].includes(command)) {
      const repos = (await need(client, 'GET', '/api/repos')).data;
      repo = Array.isArray(repos) && repos[0]?.id;
      if (!repo) throw new CliError(EXIT.REJECTED, 'سرور هیچ مخزنی گزارش نکرد.');
    }

    const result = await commands[command]({ client, flags, positional: rest, io: { stdin: io.stdin ?? process.stdin }, repo, json });
    if (json) print(out, JSON.stringify(typeof result === 'string' ? { ok: true, message: result } : result));
    else print(out, result);
    return EXIT.OK;
  } catch (error) {
    if (!(error instanceof CliError)) {
      print(err, `خطای غیرمنتظره: ${error?.message || error}`);
      return EXIT.REJECTED;
    }
    if (json) print(out, JSON.stringify({ ok: false, exitCode: error.exitCode, error: error.message, ...error.extra }));
    else print(err, error.message);
    return error.exitCode;
  }
}

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const isMain = process.argv[1] && same(path.resolve(process.argv[1]), path.resolve(fileURLToPath(import.meta.url)));
if (isMain) {
  process.exitCode = await run(process.argv.slice(2));
}
