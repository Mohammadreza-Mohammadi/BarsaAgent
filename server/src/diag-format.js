// قالب‌بندی متنی ِ diag — «یک بلوک منسجم با سرتیترهای کوتاه» که روی گوشی کپی‌شدنی باشد (≈۱۵۰ خط).
// هم CLI (barsa diag) و هم bundle (diag.txt داخل zip) از همین استفاده می‌کنند تا دو شکل ِ متفاوت از یک چیز نباشد.
import { failedWritesLines, lockStatus, moreLine } from './task-health-view.js';

const yes = value => (value === true ? 'بله' : value === false ? 'خیر' : '؟');
const when = iso => (iso ? String(iso).replace('T', ' ').slice(0, 19) : '—');
const err = section => (section && section.error ? `  ⚠ خطا: ${section.error}` : null);

function fmtDuration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

function processLines(processes, max) {
  if (!Array.isArray(processes)) return [err(processes) || '  —'];
  if (!processes.length) return ['  (فرآیندی نیست)'];
  const rows = processes.slice(0, max).map(p =>
    `  ${String(p.pid).padStart(6)} ←${String(p.ppid).padStart(6)} ${String(p.name).slice(0, 14).padEnd(14)} شروع ${when(p.startedAt)} سن ${fmtDuration(p.ageSec).padStart(5)} CPU ${p.cpuSeconds ?? '؟'}s  ${p.cmd}`);
  if (processes.length > max) rows.push(`  … و ${processes.length - max} فرآیند دیگر`);
  return rows;
}

function healthLines(health) {
  if (!health) return ['  health: (Manager نداد)'];
  const out = [];
  const lock = health.transitionLock;
  const lockInfo = lockStatus(lock, health.recovery);
  out.push(`  قفل transition: ${lock ? `pid ${lock.pid ?? '؟'} ${lockInfo.label} · از ${lock.fromState ?? '؟'} · ${when(lock.startedAt)}` : 'ندارد'}`);
  if (lockInfo?.detail) out.push(`    ↳ ${lockInfo.detail}`);
  out.push(`  stuck: ${yes(health.stuck)}${health.stuckReasons?.length ? ` (${health.stuckReasons.join('، ')})` : ''}`);
  const dirty = health.dirtyPaths || [];
  out.push(`  dirtyPaths: ${dirty.length}${dirty.length ? ` — ${dirty.slice(0, 4).join(' | ')}${dirty.length > 4 ? ' …' : ''}` : ''}`);
  const rec = health.recovery;
  out.push(`  recovery: ${rec?.suggested ? `${rec.suggested}${rec.mode ? ` [${rec.mode}${rec.attempt ? ` #${rec.attempt}` : ''}]` : ''} — ${String(rec.reason ?? '').slice(0, 160)}` : (rec?.reason ? `— ${String(rec.reason).slice(0, 160)}` : 'پیشنهادی نیست')}`);
  const inst = health.install;
  out.push(`  install: ${inst ? `${inst.phase ?? '؟'} · pid ${inst.pid ?? '؟'} ${inst.alive === true ? 'زنده' : inst.alive === false ? 'مرده' : ''} · از ${when(inst.startedAt)} · مهلت ${when(inst.deadlineAt)}` : 'در حال نصب نیست'}`);
  return out;
}

/** @param d خروجی collectTaskDiag */
export function formatTaskDiag(d) {
  const out = [];
  out.push(`═══ diag تسک #${d.taskId} · مخزن ${d.repo} · ${when(d.generatedAt)} ═══`);
  if (d.roles) out.push(`نقش: جاری ${d.roles.current ?? '—'} → بعدی ${d.roles.next ?? '—'}`);
  out.push(`وضعیت: ${d.state ?? '؟'} از ${when(d.stateSince)}${d.gate ? ` · منتظر ${d.gate.kind}` : ''}${d.blocker ? ` · blocker ${d.blocker.kind}: ${d.blocker.detail}` : ''}${d.waitingFor ? ` · منتظر تسک ${d.waitingFor.task ?? JSON.stringify(d.waitingFor)}` : ''}`);
  out.push(`اکشن‌های مجاز: ${d.actions?.length ? d.actions.join('، ') : 'هیچ'}`);
  if (d.runtime?.summary) out.push(`runtime: ${d.runtime.summary}${d.runtime.pending ? ` · ${d.runtime.pending} تغییر در انتظار اعمال` : ''}`);
  if (d.blocker?.failedWrites) out.push('', '── blocker: خطای نوشتن ِ ابزار (tool-write-failed)', ...failedWritesLines(d.blocker.failedWrites).map(line => `  ${line}`));
  if (d.blocker && (d.blocker.stage || d.blocker.step || d.blocker.log || d.blocker.outputTail?.length)) {
    out.push('', `── blocker: ${d.blocker.kind ?? '؟'}${d.blocker.stage ? ` · stage ${d.blocker.stage}` : ''}${d.blocker.step ? ` · گام ${d.blocker.step}` : ''}`);
    if (d.blocker.log) out.push(`  لاگ کامل: ${d.blocker.log}`);
    if (d.blocker.outputTail?.length) out.push(`  ۴۰ خط ِ آخر ِ خروجی (outputTail):`, ...d.blocker.outputTail.map(line => `    ${line}`));
  }
  if (d.commitFailure) {
    out.push('', `── commit شکست خورد و چیزی کثیف مانده (commitFailure) · ${when(d.commitFailure.at)}`);
    if (d.commitFailure.message) out.push(`  ${d.commitFailure.message}`);
    if (d.commitFailure.leftover.length) out.push(`  کثیف‌مانده (${d.commitFailure.leftover.length}):`, ...d.commitFailure.leftover.map(file => `    ${file}`));
    if (d.commitFailure.recoverCommand) out.push(`  فرمان ِ بازیابی: ${d.commitFailure.recoverCommand}`);
  }

  out.push('', '── خلاصه‌ی Manager (status --summary)');
  if (typeof d.summary === 'string') out.push(...d.summary.split(/\r?\n/).slice(0, 7).map(l => `  ${l}`)); else out.push(err(d.summary) || '  —');

  out.push('', '── سلامت (health)');
  out.push(...healthLines(d.health));

  out.push('', '── صف کانبان');
  out.push(`  این تسک: ${{ running: 'در حال اجرا', queued: `در صف${d.queue.position ? ` (جایگاه ${d.queue.position})` : ''}`, none: 'نه در حال اجرا و نه در صف' }[d.queue.state]}`);
  out.push(`  slot کامل: ${d.queue.slotsUsed}/${d.queue.slotsMax} (maxConcurrent) · در حال اجرا: ${d.queue.runningNow.join('، ') || '—'}${d.queue.waitingAhead.length ? ` · جلوتر در صف: ${d.queue.waitingAhead.join('، ')}` : ''}`);

  out.push('', `── ${Array.isArray(d.events) ? d.events.length : 0} رویداد آخر (events)`);
  out.push(...(Array.isArray(d.events) ? (d.events.length ? d.events.map(l => `  ${l}`) : ['  (رویدادی نیست)']) : [err(d.events) || '  —']));

  out.push('', `── لاگ آخرین اجرا${d.log?.runId ? ` · run ${d.log.runId} · ${d.log.running ? 'در حال اجرا' : d.log.queued ? 'در صف' : `تمام شد (exit ${d.log.exitCode ?? '؟'})`}` : ''}`);
  if (d.log?.error) out.push(err(d.log));
  else if (!d.log?.runId) out.push('  (اجرایی از کانبان ثبت نشده)');
  else out.push(...(d.log.lines.length ? d.log.lines.map(l => `  ${l}`) : ['  (خروجی خالی)']));

  out.push('', '── فرآیندهای مرتبط با تسک');
  out.push(...processLines(d.processes, 10));

  out.push('', '── git status --short پوشه‌ی تسک (مخزن اصلی)');
  const g = d.taskDirGit;
  if (g?.error) out.push(err(g));
  else if (g?.note) out.push(`  ${g.note}`);
  else out.push(...(g?.lines?.length ? [...g.lines.map(l => `  ${l}`), moreLine(g.total ?? g.lines.length, g.lines.length)].filter(Boolean).map(l => (l.startsWith('  ') ? l : `  ${l}`)) : ['  تمیز']));

  out.push('', '── worktree تسک');
  const w = d.worktree;
  if (w?.error) out.push(err(w));
  else {
    out.push(`  مسیر: ${w.path ?? '—'} · وجود دارد: ${yes(w.exists)} · وضعیت Manager: ${w.managerStatus ?? '—'}`);
    out.push(`  شاخه: ${w.branch ?? '—'} (base ${w.base ?? '—'}) · شاخه هست: ${yes(w.branchExists)} · merge شده در base: ${yes(w.merged)} · commit ِ خودش: ${w.ownCommits ?? '؟'}`);
    out.push(`  node_modules\\.bin: ${w.exists ? yes(w.nodeModulesBin) : '—'}`);
    if (w.dirty) {
      const total = w.dirtyTotal ?? w.dirty.length;
      out.push(`  git status --short --untracked-files=all: ${w.dirty.length ? `${total} مسیر` : 'تمیز'}`, ...w.dirty.map(l => `    ${l}`));
      const more = moreLine(total, w.dirty.length);
      if (more) out.push(`    ${more}`);
    }
  }
  return out.filter(line => line !== null).join('\n');
}

/** @param d خروجی collectSystemDiag */
export function formatSystemDiag(d) {
  const out = [];
  out.push(`═══ diag سیستم · ${when(d.generatedAt)} ═══`);
  out.push(`سرویس کانبان: pid ${d.service.pid} · شروع ${when(d.service.startedAt)} (${fmtDuration(d.service.uptimeSec)} پیش) · node ${d.service.node} · ${d.service.platform}`);

  out.push('', `── فرآیندهای node/npm/claude/git (${Array.isArray(d.processes) ? d.processes.length : 0})`);
  out.push(...processLines(d.processes, 25));

  out.push('', '── قفل‌ها و slotها');
  out.push(`  slotهای کانبان: ${d.slots.used}/${d.slots.max} · در حال اجرا: ${d.slots.running.join('، ') || '—'} · در صف: ${d.slots.queued.join('، ') || '—'}`);
  if (d.locks?.error) out.push(err(d.locks));
  else {
    const m = d.locks.manager;
    const managerInfo = lockStatus(m);
    out.push(`  قفل سراسری Manager: ${m ? `pid ${m.pid ?? '؟'} ${managerInfo.label} · task ${m.task ?? '—'} · ${when(m.startedAt)}` : 'ندارد'}`);
    if (!d.locks.tasks.length) out.push('  قفل transition ِ تسک: ندارد');
    for (const t of d.locks.tasks.slice(0, 12)) out.push(`  تسک #${t.id} [${t.state}]: pid ${t.pid ?? '؟'} ${lockStatus(t).label} · از ${t.fromState ?? '؟'} · ${when(t.startedAt)}`);
    if (d.locks.stuck.length) out.push(`  گیرکرده: ${d.locks.stuck.slice(0, 10).map(s => `#${s.id}(${s.reasons.join('+')})`).join('  ')}`);
  }

  out.push('', '── مخزن Manager');
  const r = d.repository;
  if (r?.error) out.push(err(r));
  else {
    const s = r.sync;
    out.push(`  sync: ${s ? `${s.branch ?? '؟'} ↔ ${s.upstream ?? '؟'} · ahead ${s.ahead ?? '؟'} / behind ${s.behind ?? '؟'} · آخرین fetch ${when(s.lastFetchAt)}` : '(Manager نداد)'}`);
    out.push(`  execution: ${r.execution ? `${r.execution.enabled === false ? '⛔ خاموش' : 'روشن'} (منبع ${r.execution.source ?? '؟'})` : '(Manager نداد)'} · acceptsOperations: ${yes(r.acceptsOperations)}`);
    if (r.unownedDirty?.length) out.push(`  فایل کثیف بی‌صاحب: ${r.unownedDirty.join(' | ')}`);
  }
  out.push('  git status --short:');
  if (d.git?.error) out.push(err(d.git));
  else out.push(...(d.git.status.length ? [...d.git.status.map(l => `    ${l}`), moreLine(d.git.statusTotal ?? d.git.status.length, d.git.status.length)].filter(Boolean).map(l => (l.startsWith('    ') ? l : `    ${l}`)) : ['    تمیز']));
  out.push('  git worktree list:');
  if (d.git?.error) out.push(err(d.git));
  else out.push(...[...d.git.worktrees.map(l => `    ${l}`), moreLine(d.git.worktreesTotal ?? d.git.worktrees.length, d.git.worktrees.length, 'worktree')].filter(Boolean).map(l => (l.startsWith('    ') ? l : `    ${l}`)));

  out.push('', '── دیسک');
  if (Array.isArray(d.disk)) for (const x of d.disk) out.push(`  ${x.label}: ${x.error ? `خطا ${x.error}` : `${x.freeGB} گیگابایت آزاد`} (${x.path})`);
  else out.push(err(d.disk));

  out.push('', '── ابزارها روی PATH ِ سرویس (فقط مسیر یافت‌شده)');
  const t = d.tools;
  for (const [name, value] of [['node', t.node], ['npm', t.npm], ['git', t.git], [`claude (${t.claudeCommand})`, t.claude], ['TF.exe', t.tf]]) out.push(`  ${name}: ${value ?? '✗ پیدا نشد'}`);

  out.push('', '── issue-portal');
  out.push(d.issues?.error ? err(d.issues) : `  تعداد issue برگشتی: ${d.issues.count}`);

  out.push('', `── ۳۰ خط آخر kanban.err.log${d.errLog?.file ? ` (${d.errLog.file})` : ''}`);
  if (d.errLog?.error) out.push(err(d.errLog));
  else if (d.errLog?.note) out.push(`  ${d.errLog.note}`);
  else out.push(...(d.errLog.lines.length ? d.errLog.lines.map(l => `  ${l}`) : ['  (خالی)']));
  return out.join('\n');
}
