import path from 'node:path';
const TOKEN_PATTERNS = [
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9.]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{8,})?\b/g,
  // «Authorization: Bearer <x>» (مقدار بعد از فاصله) — باید پیش از الگوی بعدی بیاید، وگرنه «Bearer» پوشانده می‌شود و خود توکن می‌ماند.
  /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(?:bearer|authorization|api[-_ ]?key|oauth[-_ ]?token|access[-_ ]?token|token)\s*[:=]\s*[^\s,;]+/gi,
  // پرچم‌های خط فرمان (--password x / --token=x)، کلید PEM، کلید AWS، و کاربر:گذرواژه داخل URL — چیزهایی که در argv
  // فرآیندها و لاگ‌ها می‌آیند (diag/bundle).
  /--?(?:password|passwd|pwd|token|secret|api-?key|auth|credential)s?(?:=|\s+)[^\s"']+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g
];

// نام متغیرهایی که مقدارشان راز یا شناسه‌ی حساب است. BARSA_ISSUE_USER_ID راز نیست ولی هویت کاربر پورتال است و
// خروجی را به خود او وصل می‌کند؛ پس در خروجی diag/لاگ هم مثل راز پوشانده می‌شود.
const SECRET_NAME = /(TOKEN|API[_-]?KEY|SECRET|PASSWORD|PASSWD|OAUTH|CREDENTIAL|AUTHORIZATION|COOKIE|PRIVATE[_-]?KEY|USER[_-]?ID)/i;

export function environmentSecrets(env = process.env) {
  const names = Object.keys(env).filter(name => SECRET_NAME.test(name));
  return names.map(name => env[name]).filter(value => typeof value === 'string' && value.length >= 6);
}

export function redact(value, secrets = environmentSecrets()) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join('[MASKED]');
  }
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, '[MASKED]');
  return text;
}

// مسیر نسبی artifact: بدون absolute، بدون "..". (منبع قبلی: app.js)
export function validArtifactPath(value) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = String(value).replace(/\\/g, '/');
  return !normalized.split('/').includes('..') && !normalized.includes('\0');
}
