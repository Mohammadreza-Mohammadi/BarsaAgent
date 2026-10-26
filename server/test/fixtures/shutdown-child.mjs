// فرآیند ِ جدا برای تست ِ shutdown ِ واقعی: سرور کامل (createApp) با config ِ دریافتی، **بدون** exit/log ِ تزریقی؛ یعنی دقیقاً
// مسیر ِ production (process.exit ِ واقعی، لاگ روی stdout). با خط ِ "go" روی stdin، همان listener ِ سیگنال را که
// `process.on('SIGINT')` ثبت کرده صدا می‌زنیم (ویندوز اجازه‌ی فرستادن ِ SIGINT ِ واقعی به فرآیند ِ دیگر را نمی‌دهد).
// استفاده: node shutdown-child.mjs <config.json>
import fs from 'node:fs';
import { once } from 'node:events';
import { createApp } from '../../src/app.js';
import { UserStore } from '../../src/auth.js';
import { TEST_USER, TEST_PASSWORD } from '../helpers.js';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
await new UserStore(config.dataDir).add(TEST_USER, TEST_PASSWORD);
const server = createApp(config);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
console.log(`PORT ${server.address().port}`);

process.stdin.setEncoding('utf8');
process.stdin.once('data', () => {
  // stdin خودش یک handle است؛ پیش از شروع ِ shutdown می‌بندیمش تا فهرست ِ handleهای باز فقط مال ِ خود ِ سرور باشد.
  process.stdin.destroy();
  console.log('SIGNAL SIGINT');
  process.emit('SIGINT', 'SIGINT');
});
