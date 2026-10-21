// مدیریت حساب‌های ورود کانبان (روی خود سرور، یک بار):
//   npm run user:add -- <نام>        (گذرواژه از prompt مخفی، یا از BARSA_AGENT_PASSWORD)
//   npm run user:remove -- <نام>
//   npm run user:list
import { loadConfig, resolveDataDir } from './config.js';
import { UserStore } from './auth.js';

function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = '';
      stdin.setEncoding('utf8');
      stdin.on('data', chunk => { data += chunk; });
      stdin.on('end', () => resolve(data.split(/\r?\n/)[0]));
      stdin.on('error', reject);
      return;
    }
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') { stdin.setRawMode(false); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

const [command, name] = process.argv.slice(2);
// فقط dataDir لازم است: «${BARSA_ISSUE_USER_ID}» ِ تنظیم‌نشده نباید جلوی ساختن حساب را بگیرد.
const store = new UserStore(resolveDataDir(loadConfig(undefined, process.env, { strictEnvRefs: false })));

try {
  if (command === 'add') {
    if (!name) throw new Error('استفاده: user:add -- <نام-کاربری>');
    const password = process.env.BARSA_AGENT_PASSWORD || await promptHidden('گذرواژه: ');
    await store.add(name, password);
    console.log(`حساب "${name}" ساخته/به‌روز شد.`);
  } else if (command === 'remove') {
    if (!name) throw new Error('استفاده: user:remove -- <نام-کاربری>');
    console.log(store.remove(name) ? `حساب "${name}" حذف شد.` : `حسابی با نام "${name}" نیست.`);
  } else if (command === 'list') {
    console.log(store.list().join('\n') || '(هیچ حسابی نیست)');
  } else {
    throw new Error('استفاده: users-cli.js add|remove|list [نام]');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
