/**
 * «هیچ task ای در حال اجرا نیست؟» — از دو منبع: صف/اجراهای خود کانبان
 * (process-registry) و قفل‌های `status --json` (کار انسان در شل، یا Manager ای که
 * کانبان راه نینداخته). قفل کهنه (alive === false) مانع نیست؛ Manager خودش پس
 * می‌گیرد (TOOLING-030). قفل نامشخص (alive === null) محافظه‌کارانه مانع است.
 * @returns {Promise<string|null>} دلیل مشغول بودن، یا null اگر بیکار است
 */
export async function idleReason(repo, { registry, readStatus }) {
  const active = registry.list(repo).filter(run => run.queued || run.running);
  if (active.length) return `اجرا در جریان/صف است: ${active.map(r => `#${r.taskId}`).join('، ')}`;
  let board;
  try { board = await readStatus(repo); }
  catch (error) { return `وضعیت Manager خوانده نشد (${error.message}) — بدون اطمینان از بیکاری ادامه نمی‌دهم.`; }
  const locked = (board.tasks || []).filter(task => task?.health?.transitionLock && task.health.transitionLock.alive !== false);
  if (locked.length) return `قفل transition فعال است: ${locked.map(t => `#${t.id}`).join('، ')}`;
  const managerLock = board.repository?.health?.managerLock;
  if (managerLock && managerLock.alive !== false) return `قفل سراسری Manager فعال است (task ${managerLock.task ?? '؟'}).`;
  return null;
}
