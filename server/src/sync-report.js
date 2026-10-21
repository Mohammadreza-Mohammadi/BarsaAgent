// خروجی `manager.js sync --json` (TOOLING-040) و exit codeهای Manager به متن فارسی روشن.
//
// کانبان منطق git/npm ِ مخزن Manager را ندارد؛ فقط این‌جا خروجی Manager را «نمایش می‌دهد».
// شکل JSON و کدها از `capabilities.sync.exitCodes` و runner-sync.js در Manager است.

export const SYNC_EXIT = Object.freeze({
  OK: 0, PRECONDITION: 50, FETCH_FAILED: 51, MERGE_CONFLICT: 52, PUSH_REJECTED: 53,
  PUSH_FAILED: 54, NPM_CI_FAILED: 55, NPM_CI_TIMEOUT: 56, MERGE_FAILED: 57
});

/** execution.enabled=false (TOOLING-040): همه‌ی فرمان‌های نوشتنی Manager با این کد رد می‌شوند. */
export const EXECUTION_DISABLED_EXIT = 41;

const EXIT_MESSAGES = new Map([
  [SYNC_EXIT.PRECONDITION, 'پیش‌شرط sync برقرار نیست — هیچ کاری انجام نشد (باید روی main با upstream، درخت تمیز و بدون اجرای زنده/قفل باشد).'],
  [SYNC_EXIT.FETCH_FAILED, 'fetch از origin شکست خورد (شبکه، پروکسی یا دسترسی) — هیچ تغییری در main ایجاد نشد.'],
  [SYNC_EXIT.MERGE_CONFLICT, 'برخورد (conflict) در merge با origin/main — merge abort شد و push ای انجام نشد؛ فایل‌های درگیر پایین آمده است. حل دستی لازم است.'],
  [SYNC_EXIT.PUSH_REJECTED, 'push رد شد (همزمان کسی دیگر روی origin push کرده و بعد از یک تلاش دوباره هم رد شد) — چند لحظه بعد دوباره sync کن.'],
  [SYNC_EXIT.PUSH_FAILED, 'push شکست خورد (شبکه، دسترسی یا hook ِ pre-push ِ مخزن: ng lint / ng build تا ۳۰ دقیقه مهلت دارد).'],
  [SYNC_EXIT.NPM_CI_FAILED, 'npm ci شکست خورد — package-lock.json عوض شده بود ولی نصب انجام نشد؛ بعد از رفع، دوباره sync بزن.'],
  [SYNC_EXIT.NPM_CI_TIMEOUT, 'npm ci بعد از مهلت (پیش‌فرض ۲۰ دقیقه) قطع شد — دوباره sync بزن.'],
  [SYNC_EXIT.MERGE_FAILED, 'merge شکست خورد بدون برخورد (مثلاً hook ِ commit یا تغییر HEAD) — جزئیات پایین است.'],
  [EXECUTION_DISABLED_EXIT, 'اجرای تسک روی این دستگاه خاموش است (execution.enabled=false) — این فرمان رد شد.']
]);

/** پیام فارسی یک exit code ِ Manager؛ برای کد ناشناخته null. */
export function exitMessage(code) {
  return EXIT_MESSAGES.get(code) ?? null;
}

/** JSON ِ نهایی sync از stdout. stderr (پیشرفت زنده) این‌جا نیست. null اگر JSON معتبر نبود. */
export function parseSyncJson(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const ACTION_LABELS = {
  none: 'هیچ — main با origin برابر است',
  'fast-forward': 'fast-forward (فقط عقب بود)',
  push: 'push (فقط جلو بود)',
  merge: 'merge ِ واقعی (--no-ff؛ هر دو سو commit داشتند)'
};

const yesNo = value => (value ? 'بله' : 'خیر');

function npmCiLine(npmCi, dryRun) {
  if (!npmCi || !npmCi.required) return 'npm ci: لازم نیست (package-lock.json عوض نشده)';
  if (npmCi.ran) return `npm ci: ${npmCi.ok ? 'موفق' : npmCi.timedOut ? 'قطع شد (timeout)' : `شکست${npmCi.exitCode != null ? ` (exit ${npmCi.exitCode})` : ''}`}`;
  return `npm ci: ${dryRun ? 'لازم خواهد بود' : 'لازم بود ولی اجرا نشد'}`;
}

/** خلاصه‌ی خوانا از JSON ِ sync (برای لاگ اجرا): action، ahead/behind، merged، pushed، conflicts، npmCi. */
export function formatSyncReport(result, code) {
  const lines = [];
  if (!result) {
    lines.push('خروجی --json ِ sync خوانده نشد (JSON معتبر نبود).');
    return lines;
  }
  const prefix = result.dryRun ? 'پیش‌نمایش (--dry-run)' : 'نتیجه‌ی sync';
  lines.push(`${prefix}:`);
  if (result.failure?.kind === 'precondition' && Array.isArray(result.failure.problems)) {
    for (const problem of result.failure.problems) lines.push(`  • ${problem.message ?? problem}`);
  } else {
    lines.push(`  action: ${ACTION_LABELS[result.action] ?? result.action ?? '—'}`);
    lines.push(`  قبل از sync: ${result.aheadBefore ?? '؟'} commit جلوتر، ${result.behindBefore ?? '؟'} commit عقب‌تر از ${result.upstream ?? 'origin/main'}`);
    lines.push(`  merge شد: ${yesNo(result.merged)}${result.mergeCommit ? ` (${String(result.mergeCommit).slice(0, 10)})` : ''} · push شد: ${yesNo(result.pushed)}${result.retried ? ' (بعد از یک تلاش دوباره)' : ''}`);
    if (result.dryRun && result.wouldConflict != null) lines.push(`  برخورد پیش‌بینی‌شده: ${yesNo(result.wouldConflict)}`);
    if (Array.isArray(result.conflicts) && result.conflicts.length) {
      lines.push(`  فایل‌های درگیر (${result.dryRun ? 'پیش‌بینی' : 'merge abort شد'}) — ${result.conflicts.length} فایل:`);
      for (const file of result.conflicts) lines.push(`    - ${file}`);
    }
    lines.push(`  ${npmCiLine(result.npmCi, result.dryRun)}`);
  }
  if (result.failure?.detail) lines.push(`  جزئیات: ${result.failure.detail}`);
  for (const lock of result.staleLocks || []) lines.push(`  هشدار: قفل مرده (مانع نبود): ${lock.path ?? ''}${lock.task ? ` task=${lock.task}` : ''}${lock.pid != null ? ` pid=${lock.pid}` : ''}`);
  if (code !== 0 && code != null && result.failure?.message) lines.push(`  Manager: ${result.failure.message}`);
  return lines;
}
