// مدیریت توکن‌های remote (روی خود سرور، با همان حسابی که کانبان/CLI را اجرا می‌کند):
//   npm run token:create -- <name> [--out <file>]   (توکن فقط در فایل با دسترسی فقط-مالک؛ چاپ نمی‌شود)
//   npm run token:list
//   npm run token:revoke -- <name>
import { loadConfig, resolveDataDir } from './config.js';
import { RemoteTokenStore } from './remote-tokens.js';

const [command, name, ...rest] = process.argv.slice(2);

try {
  // فقط dataDir لازم است: «${BARSA_ISSUE_USER_ID}» ِ تنظیم‌نشده جلوی ساختن توکن را نمی‌گیرد.
  const store = new RemoteTokenStore(resolveDataDir(loadConfig(undefined, process.env, { strictEnvRefs: false })));
  if (command === 'create') {
    if (!name) throw new Error('استفاده: token:create -- <name> [--out <file>]');
    const outIndex = rest.indexOf('--out');
    const outFile = outIndex >= 0 ? rest[outIndex + 1] : undefined;
    if (outIndex >= 0 && !outFile) throw new Error('--out مسیر فایل می‌خواهد.');
    const { file, warning } = store.create(name, { outFile });
    console.log(`توکن «${name}» ساخته شد. خود توکن چاپ نمی‌شود؛ فقط در این فایل (دسترسی فقط-مالک) است:\n  ${file}`);
    console.log('فقط hash ِ آن در remote-tokens.json می‌ماند؛ اگر فایل گم شد، توکن را باطل و دوباره بساز.');
    if (warning) console.warn(`هشدار: ${warning}`);
  } else if (command === 'list') {
    const items = store.list();
    console.log(items.length ? items.map(t => `${t.name}\t${t.active ? 'فعال' : `باطل‌شده ${t.revokedAt}`}\tساخته‌شده ${t.createdAt}`).join('\n') : '(هیچ توکنی نیست)');
  } else if (command === 'revoke') {
    if (!name) throw new Error('استفاده: token:revoke -- <name>');
    const result = store.revoke(name);
    console.log(result.revoked ? `توکن «${name}» باطل شد و فوراً بی‌اثر است (ری‌استارت لازم نیست).` : `کاری انجام نشد: توکن «${name}» ${result.reason}.`);
    if (!result.revoked) process.exitCode = 1;
  } else {
    throw new Error('استفاده: tokens-cli.js create|list|revoke [name]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
