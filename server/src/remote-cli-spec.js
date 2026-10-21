// قرارداد CLI ِ کنترل از راه دور (`barsa`): تنها منبع «چه فرمان‌هایی وجود دارند، کدام‌ها نوشتنی‌اند، چه چیزهایی عمداً
// بیرون‌اند، exit codeها، و کدام endpointها را توکن remote می‌تواند صدا بزند».
//
// سه مصرف‌کننده از همین فایل می‌خوانند تا از هم جدا نیفتند: خود CLI (remote-cli.js)، سرور (فهرست مجاز endpoint برای
// نشست‌های `remote:*`، app.js) و تست‌ها (قالب settings.json، «بیرون از فهرست وجود ندارد»).

/** فرمان‌های خواندنی: بدون تأیید روی گوشی. */
export const READ_COMMANDS = Object.freeze(['health', 'issues', 'tasks', 'task', 'log', 'waiting']);

/** فرمان‌های نوشتنی: هر کدام روی گوشی تأیید می‌خواهد (`ask` در settings.json). */
export const WRITE_COMMANDS = Object.freeze(['create-from-issue', 'create-task', 'run', 'stop', 'answer']);

/** حالت‌های `barsa answer <id> --…` (دقیقاً همین‌ها؛ هیچ اکشن دیگری از راه دور نیست). */
export const ANSWER_MODES = Object.freeze(['approve', 'reject', 'clarify', 'note', 'raise-limit', 'unblock']);

/**
 * عمداً بیرون از CLI: این تصمیم‌ها را باید از رابط کاربری کانبان گرفت. اگر کاربر یکی را خواست، CLI فقط همین را می‌گوید.
 * (نام فرمان‌ها و نام flagهای `answer`.)
 */
export const NOT_REMOTE_COMMANDS = Object.freeze([
  'abandon', 'void', 'unlock', 'cancel', 'sync', 'console', 'exec', 'rebase', 'external-init', 'import-issue', 'update', 'delete', 'remove'
]);
export const NOT_REMOTE_ANSWER_FLAGS = Object.freeze([
  '--external-access', '--allow-path', '--allow-shared-knowledge-file', '--reset-external', '--stage-external',
  '--external-checked-in', '--close-orphan', '--respec', '--release-note-file', '--no-release-note', '--changeset', '--route-file'
]);

export const NOT_REMOTE_MESSAGE = 'این تصمیم از راه دور مجاز نیست؛ آن را از رابط کاربری کانبان بگیر.';

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  NOT_ALLOWED: 3,
  UNREACHABLE: 4,
  AUTH: 5,
  REJECTED: 6,
  /** همان کد Manager: execution.enabled=false */
  EXECUTION_OFF: 41
});

export const DEFAULT_URL = 'http://127.0.0.1:4310';
export const DEFAULT_TOKEN_NAME = 'remote-phone';

/**
 * endpointهایی که یک توکن remote می‌تواند صدا بزند — **فقط** همین‌ها (هر چیز دیگر 403). اگر توکن لو برود هم کسی نمی‌تواند
 * با آن abandon/void/unlock/sync/کنسول بزند. الگوها با `:name` پارامتر دارند (مثل route() در app.js).
 */
export const REMOTE_ENDPOINTS = Object.freeze([
  ['GET', '/api/auth/session'],
  ['GET', '/api/repos'],
  ['GET', '/api/env-health'],
  ['GET', '/api/issues'],
  ['GET', '/api/remote/tasks'],
  ['GET', '/api/remote/waiting'],
  ['GET', '/api/repos/:repo/running'],
  ['GET', '/api/repos/:repo/tasks/:id'],
  ['GET', '/api/repos/:repo/tasks/:id/log'],
  ['POST', '/api/issues/import'],
  ['POST', '/api/tasks/create'],
  ['POST', '/api/repos/:repo/tasks/:id/run'],
  ['POST', '/api/repos/:repo/tasks/:id/stop'],
  ['POST', '/api/repos/:repo/tasks/:id/answer'],
  ['POST', '/api/repos/:repo/tasks/:id/note'],
  ['POST', '/api/repos/:repo/tasks/:id/raise-limit'],
  ['POST', '/api/repos/:repo/tasks/:id/unblock']
]);

/** فرمان CLI ← endpointهایی که صدا می‌زند (برای مستند و تست). */
export const COMMAND_ENDPOINTS = Object.freeze({
  health: [['GET', '/api/env-health']],
  issues: [['GET', '/api/issues']],
  tasks: [['GET', '/api/remote/tasks']],
  task: [['GET', '/api/repos/:repo/tasks/:id'], ['GET', '/api/repos/:repo/running']],
  log: [['GET', '/api/repos/:repo/tasks/:id/log']],
  waiting: [['GET', '/api/remote/waiting']],
  'create-from-issue': [['POST', '/api/issues/import']],
  'create-task': [['POST', '/api/tasks/create']],
  run: [['GET', '/api/repos/:repo/tasks/:id'], ['POST', '/api/repos/:repo/tasks/:id/run']],
  stop: [['POST', '/api/repos/:repo/tasks/:id/stop']],
  'answer --approve|--reject|--clarify': [['GET', '/api/repos/:repo/tasks/:id'], ['POST', '/api/repos/:repo/tasks/:id/answer']],
  'answer --note': [['GET', '/api/repos/:repo/tasks/:id'], ['POST', '/api/repos/:repo/tasks/:id/note']],
  'answer --raise-limit': [['GET', '/api/repos/:repo/tasks/:id'], ['POST', '/api/repos/:repo/tasks/:id/raise-limit']],
  'answer --unblock': [['GET', '/api/repos/:repo/tasks/:id'], ['POST', '/api/repos/:repo/tasks/:id/unblock']]
});

/** هم‌خوانی یک مسیر با الگو (`:name` = یک بخش). */
export function matchRoute(pattern, pathname) {
  const a = pattern.split('/');
  const b = pathname.split('/');
  if (a.length !== b.length) return false;
  return a.every((part, i) => (part.startsWith(':') ? b[i].length > 0 : part === b[i]));
}

export function isRemoteAllowed(method, pathname) {
  return REMOTE_ENDPOINTS.some(([m, pattern]) => m === method && matchRoute(pattern, pathname));
}
