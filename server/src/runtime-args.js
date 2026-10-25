// runtime ِ هر مرحله (TOOLING-046): سنجش شکل ورودی، ساخت flagهای Manager، و تبدیل خطای ساختاریافته‌ی Manager
// (exit 44 تکراری، exit 45 runtime نامعتبر) به پیام فارسی روشن.
//
// این‌جا **فقط شکل** سنجیده می‌شود (نه فهرست مجاز provider/مدل/effort): اعتبارسنجی معنایی کار Manager است، و کانبان
// گزینه‌های مجاز را از `runtime --options --json` می‌گیرد، نه از فهرست سخت‌کدشده.

const ROLE = /^[a-z][a-z-]{0,31}$/;
const SEGMENT = /^[A-Za-z0-9._-]{0,64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const bad = message => Object.assign(new Error(message), { status: 400 });

export const isRole = value => typeof value === 'string' && ROLE.test(value);

/** `<provider>:<model>:<effort>` — قطعه‌ی خالی یعنی «پیش‌فرض». */
export function runtimeSpec(entry, role) {
  const parts = ['provider', 'model', 'effort'].map(key => String(entry?.[key] ?? ''));
  if (!parts.every(part => SEGMENT.test(part))) throw bad(`مقدار runtime ِ نقش «${role}» نویسه‌ی نامجاز دارد.`);
  if (parts.every(part => part === '')) throw bad(`برای نقش «${role}» دست‌کم یکی از provider، مدل یا effort را بده.`);
  return parts.join(':');
}

/**
 * `{ preset?, roles?: { <role>: { provider, model, effort } } }` ← flagهای ساخت (`import-issue`).
 * فقط ردیف‌هایی که انسان عوض کرده می‌آیند؛ `default` به‌عنوان preset فرستاده نمی‌شود (بدون override).
 */
export function createRuntimeFlags(runtime) {
  if (runtime == null) return [];
  if (typeof runtime !== 'object' || Array.isArray(runtime)) throw bad('runtime باید یک object باشد.');
  const flags = [];
  const preset = runtime.preset == null || runtime.preset === '' ? null : String(runtime.preset);
  if (preset !== null) {
    if (!NAME.test(preset)) throw bad('نام preset نامعتبر است.');
    if (preset !== 'default') flags.push('--runtime-preset', preset);
  }
  const roles = runtime.roles && typeof runtime.roles === 'object' ? runtime.roles : {};
  for (const [role, entry] of Object.entries(roles)) {
    if (!isRole(role)) throw bad(`نام نقش نامعتبر است: ${role}`);
    if (entry == null) continue;
    flags.push('--runtime', `${role}=${runtimeSpec(entry, role)}`);
  }
  return flags;
}

/**
 * بدنه‌ی `POST …/runtime` ← آرگومان‌های `answer`:
 *   { mode:'set', role, provider, model, effort } → --runtime role=p:m:e
 *   { mode:'preset', preset }                      → --runtime-preset name
 *   { mode:'reset', target }                       → --runtime-reset role|preset|all
 */
export function answerRuntimeArgs(input) {
  const mode = input?.mode;
  if (mode === 'set') {
    if (!isRole(input.role)) throw bad('نام نقش نامعتبر است.');
    return ['--runtime', `${input.role}=${runtimeSpec(input, input.role)}`];
  }
  if (mode === 'preset') {
    const preset = String(input.preset ?? '');
    if (!NAME.test(preset)) throw bad('نام preset نامعتبر است.');
    return ['--runtime-preset', preset];
  }
  if (mode === 'reset') {
    const target = String(input.target ?? '');
    if (!(isRole(target) || target === 'preset' || target === 'all')) throw bad('هدف reset باید یک نقش، preset یا all باشد.');
    return ['--runtime-reset', target];
  }
  throw bad('mode باید set، preset یا reset باشد.');
}

const RUNTIME_CODE_MESSAGES = {
  'unknown-provider': 'provider ناشناخته است',
  'unknown-model': 'مدل برای این provider مجاز نیست',
  'unknown-effort': 'effort برای این مدل مجاز نیست',
  'unknown-preset': 'preset ناشناخته است',
  'unsupported-role': 'این نقش برای این provider پشتیبانی نمی‌شود',
  'invalid-spec': 'قالب باید <role>=<provider>:<model>:<effort> باشد',
  'invalid-reset': 'هدف reset نامعتبر است',
  'invalid-value': 'مقدار نامعتبر است',
  'invalid-runtime': 'runtime نامعتبر است',
  'invalid-entry': 'ردیف runtime نامعتبر است',
  'unknown-key': 'کلید ناشناخته'
};

export function describeRuntimeCode(code) {
  return RUNTIME_CODE_MESSAGES[code] ?? null;
}

function parseJsonObject(text) {
  try {
    const value = JSON.parse(String(text ?? '').trim());
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * خطای ساختاریافته‌ی Manager (JSON روی stdout) از یک خطای collectAction:
 *   - exit 44 `duplicate-external-id` → { kind:'duplicate', taskId, state, externalId, message, hint }
 *   - exit 45 `runtime-invalid`       → { kind:'runtime-invalid', code, role?, message, details, explanation }
 * هر چیز دیگر null.
 */
export function structuredFailure(error) {
  const json = parseJsonObject(error?.stdout) ?? parseJsonObject(error?.message);
  if (!json || json.ok !== false) return null;
  if (json.error === 'duplicate-external-id' || error?.code === 44) {
    return {
      kind: 'duplicate', taskId: json.taskId != null ? String(json.taskId) : null, state: json.state ?? null,
      externalId: json.externalId ?? null, message: String(json.message ?? 'این issue قبلاً تسک دارد.'), hint: json.hint ?? null
    };
  }
  if (json.error === 'runtime-invalid' || error?.code === 45) {
    const details = json.details && typeof json.details === 'object' ? json.details : {};
    const role = typeof details.role === 'string' ? details.role : typeof details.field === 'string' ? details.field : null;
    return {
      kind: 'runtime-invalid', code: String(json.code ?? 'invalid'), role, message: String(json.message ?? ''), details,
      explanation: describeRuntimeCode(json.code)
    };
  }
  return null;
}
