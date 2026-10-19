import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authedFetch, startAuthedServer, login, TEST_USER, TEST_PASSWORD } from './helpers.js';
import { makeFakeManagerRepo } from './fake-manager.js';
import { AuditLog } from '../src/audit.js';

const post = (base, path, body) => authedFetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
const get = (base, path) => authedFetch(`${base}${path}`);

async function boot(t, fake, extraConfig = {}) {
  const { base, config } = await startAuthedServer(t, { repos: [fake.repo], server: {}, issueSource: {}, ...extraConfig });
  return { base, config, audit: () => new AuditLog({ dir: config.dataDir }) };
}

async function finishExec(base, execId) {
  const text = await (await get(base, `/api/execs/${execId}/stream`)).text();
  return text;
}

async function waitRun(base, taskId) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const run = (await (await get(base, '/api/repos/fake/running')).json()).find(r => r.taskId === String(taskId));
    if (run && !run.running && !run.queued) return run;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('run تمام نشد');
}

test('endpoint اجرایی و خواندنی بدون ورود → 401 و manager هیچ‌وقت صدا زده نمی‌شود؛ هر POST ردشده در ممیزی است', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const attempts = [
    ['POST', '/api/console/exec', { repo: 'fake', line: 'abandon 1 --reason x' }],
    ['POST', '/api/console/parse', { repo: 'fake', line: 'status' }],
    ['POST', '/api/repos/fake/tasks/1/run', {}],
    ['POST', '/api/repos/fake/tasks/1/stop', {}],
    ['POST', '/api/repos/fake/tasks/1/abandon', { reason: 'x' }],
    ['POST', '/api/repos/fake/tasks/1/answer', { mode: 'approve' }],
    ['POST', '/api/repos/fake/git/merge', { branch: 'fix/x' }],
    ['POST', '/api/repos/fake/manager/update', {}],
    ['POST', '/api/tasks/create', { items: [{ requestText: 'x' }] }],
    ['POST', '/api/execs/abc/stop', {}],
    ['GET', '/api/repos/fake/board'],
    ['GET', '/api/repos/fake/tasks/1/zip'],
    ['GET', '/api/env-health'],
    ['GET', '/api/audit']
  ];
  for (const [method, path, body] of attempts) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal(response.status, 401, `${method} ${path}`);
  }
  assert.deepEqual(fake.calls(), [], 'manager.js نباید صدا زده شده باشد');
  const rejected = audit().readAll().filter(r => r.phase === 'rejected');
  assert.equal(rejected.length, attempts.filter(a => a[0] === 'POST').length);
  assert.ok(rejected.every(r => r.user === null && /\/api\//.test(r.action)));
});

test('ورود: گذرواژه‌ی غلط رد و ممیزی؛ بعد از ۵ شکست قفل می‌شود؛ ورود درست نشست می‌دهد', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const attempt = password => fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: TEST_USER, password }) });
  assert.equal((await attempt('wrong-password-1')).status, 401);
  assert.equal((await attempt('wrong-password-2')).status, 401);
  const ok = await attempt(TEST_PASSWORD);
  assert.equal(ok.status, 200);
  const cookie = ok.headers.getSetCookie().join(';');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  for (let i = 0; i < 5; i += 1) await attempt(`bad-${i}-password`);
  assert.equal((await attempt(TEST_PASSWORD)).status, 429, 'بعد از قفل، حتی گذرواژه‌ی درست هم رد می‌شود');
  const records = audit().readAll().filter(r => r.action === 'auth.login');
  assert.ok(records.some(r => r.phase === 'rejected'));
  assert.ok(records.some(r => r.phase === 'event' && r.user === TEST_USER));
  // کاربر ناموجود هم 401 (نه 500) و Content-Type غیر JSON رد می‌شود
  const ghost = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'ghost', password: 'whatever-long-1' }) });
  assert.equal(ghost.status, 401);
  const form = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ username: TEST_USER, password: TEST_PASSWORD }) });
  assert.equal(form.status, 415);
});

test('CSRF: بدون X-CSRF-Token یا با Origin بیگانه → 403 و manager صدا زده نمی‌شود', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const session = await login(base);
  const send = headers => fetch(`${base}/api/repos/fake/tasks/1/abandon`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: session.cookie, ...headers }, body: JSON.stringify({ reason: 'x' })
  });
  assert.equal((await send({})).status, 403, 'بدون توکن CSRF');
  assert.equal((await send({ 'X-CSRF-Token': 'wrong' })).status, 403, 'توکن غلط');
  assert.equal((await send({ 'X-CSRF-Token': session.csrf, Origin: 'https://evil.example' })).status, 403, 'Origin بیگانه');
  assert.equal((await send({ 'X-CSRF-Token': session.csrf, 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'cross-site');
  assert.deepEqual(fake.mutations(), []);
  assert.equal(audit().readAll().filter(r => r.phase === 'rejected' && r.status === 403).length, 4);
  // و با توکن و Origin درست کار می‌کند
  const okRes = await send({ 'X-CSRF-Token': session.csrf, Origin: base });
  assert.equal(okRes.status, 200);
  assert.equal(fake.mutations().length, 1);
});

test('کنسول: زیرفرمان غیرمجاز و متاکاراکتر رد می‌شود، manager صدا زده نمی‌شود، رد در ممیزی است', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const lines = [
    'git status',
    'node scripts/manager.js rm-everything 1',
    'status --json ; calc',
    'answer 1 --approve && calc',
    'node evil.js status',
    'answer 1 --clarify --file=C:\\secret.txt'
  ];
  for (const line of lines) {
    const response = await post(base, '/api/console/exec', { repo: 'fake', line, confirmedCommand: 'x' });
    assert.equal(response.status, 400, line);
  }
  assert.deepEqual(fake.mutations(), []);
  const rejected = audit().readAll().filter(r => r.phase === 'rejected' && r.action === 'console');
  assert.equal(rejected.length, lines.length);
  assert.deepEqual(rejected.map(r => r.line), lines);
  assert.ok(rejected.every(r => r.user === TEST_USER && r.reason));
});

test('کنسول: فرمان تغییردهنده پنجره‌ی تأیید (confirmedCommand) می‌خواهد و فرمان تأییدشده باید با فرمان نهایی بخواند', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const line = 'node scripts/manager.js answer 10013 --external-access webiii=write --reason "Q6.1 option 1"';
  const parsed = await (await post(base, '/api/console/parse', { repo: 'fake', line })).json();
  assert.equal(parsed.readOnly, false);
  assert.equal(parsed.display, 'node scripts/manager.js answer 10013 --external-access webiii=write --reason "Q6.1 option 1"');

  assert.equal((await post(base, '/api/console/exec', { repo: 'fake', line })).status, 409, 'بدون تأیید');
  assert.equal((await post(base, '/api/console/exec', { repo: 'fake', line, confirmedCommand: 'something else' })).status, 409);
  assert.deepEqual(fake.mutations(), []);

  const response = await post(base, '/api/console/exec', { repo: 'fake', line, confirmedCommand: parsed.display });
  assert.equal(response.status, 202);
  const { execId } = await response.json();
  const stream = await finishExec(base, execId);
  assert.match(stream, /event: end/);
  assert.deepEqual(fake.mutations().map(c => c.args), [['answer', '10013', '--external-access', 'webiii=write', '--reason', 'Q6.1 option 1']]);

  const record = audit().summaries({ action: 'console' }).find(r => r.id === execId);
  assert.equal(record.user, TEST_USER);
  assert.equal(record.exitCode, 0);
  assert.equal(record.status, 'ok');
  assert.equal(record.cwd, fake.repo.path);
  assert.deepEqual(record.argv.slice(1), [`${fake.repo.path}\\manager.cjs`.replace(/\\/g, process.platform === 'win32' ? '\\' : '/'), 'answer', '10013', '--external-access', 'webiii=write', '--reason', 'Q6.1 option 1']);
  assert.ok(record.durationMs >= 0);
  assert.ok(fs.existsSync(record.outputFile), 'فایل خروجی کامل');
  assert.match(fs.readFileSync(record.outputFile, 'utf8'), /"ok":true/);
  assert.equal(record.line, line);
  assert.ok(record.phases.includes('start') && record.phases.includes('end'));
});

test('کنسول: --file از textarea می‌آید، فایل UTF-8 موقت ساخته و بعد پاک می‌شود، مسیر تایپ‌شده نادیده است', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const text = 'پاسخ شفاف‌سازی\nخط دوم — «نقل‌قول» ✓';
  const line = 'answer 10013 --clarify --file C:\\Windows\\win.ini --respec';
  const parsed = await (await post(base, '/api/console/parse', { repo: 'fake', line })).json();
  assert.deepEqual(parsed.attachments, ['--file']);

  const missing = await post(base, '/api/console/exec', { repo: 'fake', line, confirmedCommand: parsed.display, attachments: {} });
  assert.equal(missing.status, 400);
  const extra = await post(base, '/api/console/exec', { repo: 'fake', line, confirmedCommand: parsed.display, attachments: { '--file': 'x', '--reason-file': 'y' } });
  assert.equal(extra.status, 400);
  assert.deepEqual(fake.mutations(), []);

  const response = await post(base, '/api/console/exec', { repo: 'fake', line, confirmedCommand: parsed.display, attachments: { '--file': text } });
  const { execId } = await response.json();
  await finishExec(base, execId);
  assert.deepEqual(fake.files(), [{ flag: '--file', text }]);
  const args = fake.mutations()[0].args;
  const tmpPath = args[args.indexOf('--file') + 1];
  assert.ok(!tmpPath.includes('win.ini'));
  assert.ok(!fs.existsSync(tmpPath), 'فایل موقت باید پاک شده باشد');
  assert.equal(args.at(-1), '--respec');
  const record = audit().summaries({ action: 'console' }).find(r => r.id === execId);
  assert.equal(record.attachments[0].flag, '--file');
  assert.equal(record.attachments[0].bytes, Buffer.byteLength(text));
  assert.ok(!JSON.stringify(record).includes('شفاف‌سازی'), 'متن آزاد در دفتر ممیزی نمی‌ماند، فقط اندازه و hash');
});

test('کنسول: run از همان صف/ثبت کانبان می‌گذرد، env ِ buildAgentEnv (بدون token، با پروکسی) و ممیزی دارد', async t => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-for-test-1234567890';
  t.after(() => { if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous; });
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const response = await post(base, '/api/console/exec', { repo: 'fake', line: 'run 10013', confirmedCommand: 'node scripts/manager.js run 10013' });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).kind, 'run');
  await waitRun(base, '10013');
  const call = fake.calls().find(c => c.args[0] === 'run');
  assert.deepEqual(call.args, ['run', '10013']);
  assert.equal(call.token, null, 'CLAUDE_CODE_OAUTH_TOKEN باید حذف شده باشد');
  assert.equal(call.proxy, 'http://127.0.0.1:10808');
  const record = audit().summaries({ action: 'run' })[0];
  assert.equal(record.user, TEST_USER);
  assert.equal(record.taskId, '10013');
  assert.equal(record.exitCode, 0);
});

test('.env.local: کلیدهای آن از env ِ run، اکشن تایپ‌شده و کنسول (فرزندان manager) حذف می‌شوند', async t => {
  process.env.BARSA_TEST_LOCAL_SECRET = 'local-secret-value';
  t.after(() => { delete process.env.BARSA_TEST_LOCAL_SECRET; });
  const fake = makeFakeManagerRepo(t);
  const { base } = await boot(t, fake, { localEnvKeys: ['BARSA_TEST_LOCAL_SECRET'] });

  await post(base, '/api/repos/fake/tasks/8/run');
  await waitRun(base, '8');
  assert.equal((await post(base, '/api/repos/fake/tasks/8/abandon', { reason: 'x' })).status, 200);
  const { execId } = await (await post(base, '/api/console/exec', { repo: 'fake', line: 'answer 8 --unblock --reason x', confirmedCommand: 'node scripts/manager.js answer 8 --unblock --reason x' })).json();
  await finishExec(base, execId);

  const calls = fake.calls().filter(c => ['run', 'abandon', 'answer'].includes(c.args[0]));
  assert.equal(calls.length, 3);
  for (const call of calls) assert.equal(call.local, null, call.args.join(' '));
});

test('تاریخچه‌ی کنسول: خط‌های قبلی (بدون تکرار، تازه‌ترین اول) برای ورود مجدد می‌ماند', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base } = await boot(t, fake);
  for (const line of ['status --json', 'events 1 --json', 'status --json']) {
    const { execId } = await (await post(base, '/api/console/exec', { repo: 'fake', line })).json();
    await finishExec(base, execId);
  }
  const history = await (await get(base, '/api/console/history')).json();
  assert.deepEqual(history.map(h => h.line), ['status --json', 'events 1 --json']);
});

test('subcommands: از manager.js --help می‌آید و منبعش گزارش می‌شود', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base } = await boot(t, fake);
  const info = await (await get(base, '/api/console/subcommands?repo=fake')).json();
  assert.equal(info.source, 'manager.js --help');
  assert.ok(info.subcommands.includes('answer') && info.subcommands.includes('abandon'));
  assert.ok(fake.calls().some(c => c.args[0] === '--help'));
});

test('اکشن‌های تایپ‌شده: abandon/unblock/raise-limit/close-orphan آرگومان دقیق می‌سازند و ممیزی می‌شوند', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const reason = 'دلیل فارسی: قفل «مرده» ✓';
  assert.equal((await post(base, '/api/repos/fake/tasks/7/abandon', { reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/unblock', { reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/raise-limit', { field: 'maxAttempts', value: 30, reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/raise-limit', { field: 'implementerRuns', value: 4, reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/close-orphan', { attempt: '013', reason })).status, 200);
  const calls = fake.mutations().map(c => c.args);
  const tmpOf = args => args[args.indexOf('--reason-file') + 1];
  const shape = args => args.map(a => (a === tmpOf(args) ? '<file>' : a));
  assert.deepEqual(shape(calls[0]), ['abandon', '7', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[1]), ['answer', '7', '--unblock', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[2]), ['answer', '7', '--raise-limit', 'maxAttempts=30', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[3]), ['answer', '7', '--raise-limit', 'implementerRuns=4', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[4]), ['answer', '7', '--close-orphan', '013', '--reason-file', '<file>']);
  assert.deepEqual(fake.files().map(f => f.text), Array(5).fill(reason), 'متن آزاد همیشه از فایل UTF-8 می‌رود، نه argv');
  assert.ok(calls.every(args => !fs.existsSync(tmpOf(args))), 'فایل‌های موقت پاک شده‌اند');
  assert.deepEqual(audit().summaries().filter(r => r.phases.includes('end')).map(r => r.action).sort(), ['abandon', 'close-orphan', 'raise-limit', 'raise-limit', 'unblock']);

  // اعتبارسنجی: رد و ممیزی، بدون صدا زدن manager
  const before = fake.mutations().length;
  assert.equal((await post(base, '/api/repos/fake/tasks/7/abandon', { reason: '  ' })).status, 400);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/raise-limit', { field: 'noSuchLimit', value: 3, reason })).status, 400);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/raise-limit', { field: 'maxAttempts', value: 0, reason })).status, 400);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/close-orphan', { attempt: '../x', reason })).status, 400);
  assert.equal(fake.mutations().length, before);
  assert.equal(audit().readAll().filter(r => r.phase === 'rejected').length, 4);
});

test('import-issue: دسترسی بیرونی فقط با قالب sourceId=read|write به manager می‌رود', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base } = await boot(t, fake);
  const draft = { repo: 'fake', type: 'task', slug: 'a-b', requestText: 'متن', source: { externalId: '77' } };
  const ok = await post(base, '/api/tasks/create', { start: false, items: [{ ...draft, externalAccess: [{ sourceId: 'webiii', access: 'write' }] }] });
  assert.equal(ok.status, 200);
  const args = fake.mutations()[0].args;
  assert.equal(args[0], 'import-issue');
  assert.deepEqual(args.slice(-2), ['--external-access', 'webiii=write']);
  const bad = await post(base, '/api/tasks/create', { start: false, items: [{ ...draft, externalAccess: [{ sourceId: 'web iii; calc', access: 'write' }] }] });
  const body = await bad.json();
  assert.equal(body.failed, 1);
  assert.equal(fake.mutations().length, 1);
});

test('ط: retry-rebase کانبان خودش «مجاز است؟» نمی‌سنجد: unblock (با reason-file) و بعد run؛ رد Manager = 422 و run هرگز نمی‌رسد', async t => {
  const fake = makeFakeManagerRepo(t, { status: { schemaVersion: 1, repo: {}, tasks: [{ id: '5', state: 'blocked', blocker: { kind: 'rebase-conflict', base: 'main', conflictFiles: ['a.ts'] } }] } });
  const { base } = await boot(t, fake);
  const response = await post(base, '/api/repos/fake/tasks/5/retry-rebase', {});
  assert.equal(response.status, 200);
  await waitRun(base, '5');
  const calls = fake.mutations().map(c => c.args);
  assert.deepEqual(calls[0].slice(0, 3), ['answer', '5', '--unblock']);
  assert.equal(calls[0][3], '--reason-file');
  assert.deepEqual(calls[1], ['run', '5']);
  assert.match(fake.files()[0].text, /تلاش دوباره/);
});

test('answer --clarify می‌تواند --external-access را هم بفرستد؛ کنار approve/reject یا با شکل بد رد می‌شود', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base } = await boot(t, fake, { run: { autoResumeAfterAnswer: false } });
  const ok = await post(base, '/api/repos/fake/tasks/9/answer', { mode: 'clarify', text: 'پاسخ', respec: true, externalAccess: { sourceId: 'webiii', access: 'write' } });
  assert.equal(ok.status, 200);
  const args = fake.mutations()[0].args;
  assert.deepEqual([args[0], args[1], args[2]], ['answer', '9', '--clarify']);
  assert.ok(args.includes('--respec'));
  assert.deepEqual(args.slice(args.indexOf('--external-access'), args.indexOf('--external-access') + 2), ['--external-access', 'webiii=write']);

  const before = fake.mutations().length;
  assert.equal((await post(base, '/api/repos/fake/tasks/9/answer', { mode: 'approve', externalAccess: { sourceId: 'webiii', access: 'write' } })).status, 400);
  assert.equal((await post(base, '/api/repos/fake/tasks/9/answer', { mode: 'clarify', text: 'x', externalAccess: { sourceId: 'web iii', access: 'write' } })).status, 400);
  assert.equal((await post(base, '/api/repos/fake/tasks/9/answer', { mode: 'clarify', text: 'x', externalAccess: { sourceId: 'webiii', access: 'admin' } })).status, 400);
  assert.equal(fake.mutations().length, before);
  // بدون externalAccess هیچ --external-access ای نمی‌رود
  await post(base, '/api/repos/fake/tasks/9/answer', { mode: 'clarify', text: 'ساده' });
  assert.ok(!fake.mutations().at(-1).args.includes('--external-access'));
});

test('اکشن‌های تازه: allow-path / allow-shared-knowledge-file / external-access / reset-external با --reason-file و اعتبارسنجی شکل', async t => {
  const fake = makeFakeManagerRepo(t);
  const { base, audit } = await boot(t, fake);
  const reason = 'دلیل «فارسی»';
  assert.equal((await post(base, '/api/repos/fake/tasks/7/allow-path', { path: 'projects/x/src/a.ts', reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/allow-shared-knowledge-file', { path: 'ai-context/shared/y.md', reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/external-access', { sourceId: 'webiii', access: 'read', reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/reset-external', { sourceId: 'webiii', reason })).status, 200);
  assert.equal((await post(base, '/api/repos/fake/tasks/7/reset-external', { sourceId: 'webiii', to: 'a1b2c3d', reason })).status, 200);
  const calls = fake.mutations().map(c => c.args);
  const shape = args => args.map(a => (a === args[args.indexOf('--reason-file') + 1] ? '<file>' : a));
  assert.deepEqual(shape(calls[0]), ['answer', '7', '--allow-path', 'projects/x/src/a.ts', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[1]), ['answer', '7', '--allow-shared-knowledge-file', 'ai-context/shared/y.md', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[2]), ['answer', '7', '--external-access', 'webiii=read', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[3]), ['answer', '7', '--reset-external', 'webiii', '--reason-file', '<file>']);
  assert.deepEqual(shape(calls[4]), ['answer', '7', '--reset-external', 'webiii', '--to', 'a1b2c3d', '--reason-file', '<file>']);
  assert.deepEqual(fake.files().map(f => f.text), Array(5).fill(reason));

  const before = fake.mutations().length;
  for (const [kind, body] of [
    ['allow-path', { path: '', reason }], ['allow-path', { path: '--force', reason }], ['allow-path', { path: 'a\nb', reason }], ['allow-path', { path: 'a.ts' }],
    ['allow-shared-knowledge-file', { path: '-x', reason }],
    ['external-access', { sourceId: 'bad id', access: 'read', reason }], ['external-access', { sourceId: 'webiii', access: 'root', reason }],
    ['reset-external', { sourceId: 'webiii', to: 'not-a-sha', reason }], ['reset-external', { sourceId: ';rm', reason }]
  ]) {
    assert.equal((await post(base, `/api/repos/fake/tasks/7/${kind}`, body)).status, 400, `${kind} ${JSON.stringify(body)}`);
  }
  assert.equal(fake.mutations().length, before, 'ورودی بد هرگز به Manager نمی‌رسد');
  assert.ok(audit().readAll().filter(r => r.phase === 'rejected').length >= 9);
});

test('status --json با cache سرد کند است: درخواست‌های هم‌زمان board یک فرآیند Manager می‌گیرند (single-flight)', async t => {
  const fake = makeFakeManagerRepo(t, { statusDelayMs: 700 });
  const { base } = await boot(t, fake);
  const statusCalls = () => fake.calls().filter(c => c.args[0] === 'status').length;
  const responses = await Promise.all([get(base, '/api/repos/fake/board'), get(base, '/api/repos/fake/board'), get(base, '/api/repos/fake/board')]);
  assert.deepEqual(responses.map(r => r.status), [200, 200, 200]);
  assert.equal(statusCalls(), 1, 'سه درخواست هم‌زمان = یک اجرای Manager');
  await get(base, '/api/repos/fake/board');
  assert.equal(statusCalls(), 2, 'بعد از تمام شدن، درخواست بعدی دوباره می‌خواند');
});
