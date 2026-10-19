// کانبان-الحاقیه-۱، بند الف: env ِ فرزندی که یک agent واقعی را اجرا می‌کند.
//
// فقط دستور `run` به این نیاز دارد — بقیه‌ی زیرفرمان‌های manager.js
// (status/events/artifact/answer/void/cancel/rebase/unlock/import-issue) هیچ
// agent ای صدا نمی‌زنند؛ invokeAgentForTransition (منبع واقعی فراخوانی
// run-agent.js در manager.js) فقط از داخل حلقه‌ی `run` صدا زده می‌شود. انسان
// قبل از هر run دستی در ترمینال پروکسی را ست می‌کند و CLAUDE_CODE_OAUTH_TOKEN
// را حذف می‌کند — این تابع همان دو کار را بدون نیاز به ترمینال جدا انجام
// می‌دهد، تا env ِ دکمه‌ی run با env ِ دستی فرق نداشته باشد.
const DEFAULT_PROXY = 'http://127.0.0.1:10808';

/**
 * متغیرهایی که از `.env.local` آمده‌اند (config.localEnvKeys، خوانده‌شده از خود فایل در
 * loadConfig) رازهای محلی کانبان‌اند — مثلاً BARSA_ISSUE_USER_ID. agent و Manager به
 * آن‌ها نیازی ندارند، پس از env ِ فرزندان حذف می‌شوند. `env` را درجا تغییر می‌دهد و برمی‌گرداند.
 */
export function stripLocalEnv(config, env) {
  for (const key of config?.localEnvKeys ?? []) delete env[key];
  return env;
}

/**
 * `config.run.proxy`:
 *   - کلید غایب/`undefined` → پیش‌فرض DEFAULT_PROXY
 *   - `''`/`null` (صریحاً خالی) → بدون پروکسی؛ HTTP_PROXY/HTTPS_PROXY حتی اگر
 *     در baseEnv (env خودِ سرور) از قبل باشند هم حذف می‌شوند — نه اینکه با
 *     مقدار سرور جایگزین شوند
 *   - رشته‌ی غیرخالی → همان مقدار
 *
 * `baseEnv` پارامتر دوم (پیش‌فرض `process.env`) فقط برای تست‌پذیری بدون
 * دست‌کاری env واقعی پروسه است.
 */
export function buildAgentEnv(config, baseEnv = process.env) {
  const env = stripLocalEnv(config, { ...baseEnv });
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const configuredProxy = config?.run?.proxy;
  const proxy = configuredProxy === undefined ? DEFAULT_PROXY : configuredProxy;
  if (proxy) {
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
  } else {
    delete env.HTTP_PROXY;
    delete env.HTTPS_PROXY;
  }
  return env;
}
