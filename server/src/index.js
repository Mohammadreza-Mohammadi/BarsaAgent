import { loadConfig, resolveDataDir } from './config.js';
import { createApp } from './app.js';
import { assertManagersCompatible } from './protocol-contract.js';
import { UserStore } from './auth.js';

const config = loadConfig();
if (config.localEnvFiles.length) console.log(`.env.local: ${config.localEnvFiles.join('، ')} (فقط نام کلیدها: ${config.localEnvKeys.join(', ') || '—'}؛ متغیر محیطی از پیش تنظیم‌شده مقدم است)`);
const port = Number(config.server?.port || 4310);
// کانبان فاز ۱: پیش‌فرض فقط localhost. دسترسی از شبکه فقط وقتی config صریحاً
// server.host بدهد؛ در آن حالت حتماً پشت TLS (reverse proxy) و با auth.secureCookie.
const host = String(config.server?.host || '127.0.0.1');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

try {
  const dataDir = resolveDataDir(config);
  if (new UserStore(dataDir).count() === 0) {
    throw new Error(`هیچ حساب ورودی تعریف نشده (${dataDir}). ورود اجباری است؛ یک حساب بساز:\n  npm run user:add -- <نام-کاربری>`);
  }
  const managerInfo = await assertManagersCompatible(config);
  config.managerInfo = Object.fromEntries(managerInfo.map(info => [info.repoId, info]));
  createApp(config).listen(port, host, () => {
    console.log(`BarsaAgent: http://${host}:${port}`);
    console.log(`داده‌ها (ممیزی، خروجی اجراها، کاربران): ${dataDir}`);
    if (!LOOPBACK.has(host)) {
      console.warn(`⚠️  سرور روی ${host} گوش می‌دهد (نه localhost). پشت TLS بگذارش و auth.secureCookie: true را در config بگذار — این سرویس فرمان اجرا می‌کند.`);
      if (config.auth?.secureCookie !== true) console.warn('⚠️  auth.secureCookie غیرفعال است: کوکی نشست روی HTTP ساده هم فرستاده می‌شود.');
    }
    for (const info of managerInfo) {
      console.log(`Manager ${info.repoId}: ${info.managerVersion || 'unknown'} · Contract v${info.contractVersion}`);
    }
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
