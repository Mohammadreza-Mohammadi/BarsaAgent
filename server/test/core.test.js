import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchIssues, normalizeIssues } from '../src/issues.js';
import { redact } from '../src/security.js';
import { parseConfigYaml, loadConfig } from '../src/config.js';
import { collect } from '../src/cli.js';

test('Portal code is used as externalId when both fields are present', () => {
  const source = parseConfigYaml(fs.readFileSync(new URL('../../barsa-agent.config.yml', import.meta.url), 'utf8')).issueSource;
  const result = normalizeIssues({ data: { items: [
    { externalId: '1100402940000004672', code: '3952', title: 'Issue A' },
    { externalId: '1100402940000004733', title: 'Issue without code' }
  ] } }, source);

  assert.equal(result.length, 1);
  assert.equal(result[0].externalId, '3952');
});

test('loadConfig reads .env.local next to the config file', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-local-env-'));
  const key = 'BARSA_TEST_LOCAL_ENV_USER_ID';
  const previous = process.env[key];
  t.after(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  delete process.env[key];
  const file = path.join(root, 'cfg.yml');
  fs.writeFileSync(file, `repos:\n  - id: fake\n    path: "."\nissueSource:\n  body:\n    UserId: "\${${key}}"\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.env.local'), `${key}=local-user-id\n`, 'utf8');

  assert.equal(loadConfig(file).issueSource.body.UserId, 'local-user-id');
});

test('mapping مسیر نقطه‌ای و itemsPath را اعمال می‌کند', () => {
  const source = { itemsPath: 'data.items', mapping: { externalId: 'key', title: 'fields.subject', body: 'fields.description', labels: 'tags' } };
  const result = normalizeIssues({ data: { items: [{ key: 42, fields: { subject: 'نمونه', description: 'متن' }, tags: ['bug'] }] } }, source)[0];
  assert.equal(result.externalId, '42');
  assert.equal(result.title, 'نمونه');
  assert.equal(result.body, 'متن');
  assert.deepEqual(result.labels, ['bug']);
});

test('collect: کاراکتر چندبایتی فارسی روی مرز chunk نمی‌شکند', async t => {
  // "س" دو بایت UTF-8 است (0xD8 0xB3). بافر را دقیقاً وسط یکی از این
  // کاراکترها به دو نوشتن جدا با یک تیک فاصله می‌شکنیم تا مطمئن شویم دو
  // 'data' event جدا به parent می‌رسد، نه یک chunk یکجا.
  const payload = JSON.stringify({ title: 'تست '.repeat(2000) + 'س'.repeat(50000) });
  const buf = Buffer.from(payload, 'utf8');
  const splitAt = buf.length - 50000 * 2 + 1; // یک بایت داخل یکی از جفت‌بایت‌های تکرارشونده‌ی "س"

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-utf8-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = path.join(root, 'manager.cjs');
  fs.writeFileSync(
    manager,
    String.raw`
const payload = ${JSON.stringify(payload)};
const buf = Buffer.from(payload, 'utf8');
const splitAt = ${splitAt};
process.stdout.write(buf.subarray(0, splitAt));
setTimeout(() => { process.stdout.write(buf.subarray(splitAt)); }, 20);
`,
    'utf8'
  );

  const result = await collect({ id: 'fake', path: root, managerScript: 'manager.cjs' }, []);
  assert.equal(result.stdout, payload);
  assert.doesNotMatch(result.stdout, /�/, 'باید بدون replacement character (mojibake) باشد');
});

test('توکن‌ها در لاگ ماسک می‌شوند', () => {
  assert.equal(redact('token=secret-value-123456', ['secret-value-123456']), '[MASKED]');
  assert.equal(redact('sk-abcdefghijklmnop'), '[MASKED]');
});

test('کانفیگ چند مخزنی و mapping تو در تو parse می‌شود', () => {
  const x = parseConfigYaml('repos:\n  - id: one\n    path: "C:/one"\n  - id: two\n    path: "C:/two"\nserver:\n  port: 4310\nissueSource:\n  query:\n    status: "open"\n  mapping:\n    title: "subject"\n');
  assert.equal(x.repos.length, 2);
  assert.equal(x.server.port, 4310);
  assert.equal(x.issueSource.query.status, 'open');
  assert.equal(x.issueSource.mapping.title, 'subject');
  const inline = parseConfigYaml('issueSource:\n  query: { status: \"open\", take: 50 }\n');
  assert.deepEqual(inline.issueSource.query, { status: 'open', take: 50 });
});

test('loadConfig: "${VAR}" در کانفیگ از process.env جایگزین می‌شود، مقدار خام در فایل نمی‌ماند', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'cfg.yml');
  fs.writeFileSync(file, 'repos:\n  - id: fake\n    path: "."\nissueSource:\n  body:\n    UserId: "${TEST_USER_ID}"\n', 'utf8');
  const config = loadConfig(file, { TEST_USER_ID: 'abc-123' });
  assert.equal(config.issueSource.body.UserId, 'abc-123');
});

test('loadConfig: "${VAR}" بدون env متناظر → خطای صریح، نه مقدار خالی بی‌صدا', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'cfg.yml');
  fs.writeFileSync(file, 'repos:\n  - id: fake\n    path: "."\nissueSource:\n  body:\n    UserId: "${TEST_USER_ID_MISSING}"\n', 'utf8');
  assert.throws(() => loadConfig(file, {}), /TEST_USER_ID_MISSING/);
});


test('fetch issue در حالت POST پارامتر UserId را در JSON body ارسال می‌کند', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestedOptions = null;
  globalThis.fetch = async (url, options) => {
    requestedUrl = String(url);
    requestedOptions = options;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get(name) { return name.toLowerCase() === 'content-type' ? 'application/json' : null; } },
      async text() { return JSON.stringify({ data: { items: [] } }); }
    };
  };

  try {
    await fetchIssues({
      baseUrl: 'https://example.test',
      listPath: '/api/issues',
      method: 'POST',
      bodyFormat: 'json',
      body: { UserId: '20b785b0-db71-4507-9757-b5280460b0cb' },
      itemsPath: 'data.items',
      mapping: {}
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('UserId'), null);
  assert.equal(requestedOptions.method, 'POST');
  assert.equal(requestedOptions.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(requestedOptions.body), { UserId: '20b785b0-db71-4507-9757-b5280460b0cb' });
});

test('fetch issue از POST form-urlencoded هم پشتیبانی می‌کند', async () => {
  const originalFetch = globalThis.fetch;
  let requestedOptions = null;
  globalThis.fetch = async (_url, options) => {
    requestedOptions = options;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get() { return 'application/json'; } },
      async text() { return JSON.stringify({ data: { items: [] } }); }
    };
  };

  try {
    await fetchIssues({
      baseUrl: 'https://example.test',
      listPath: '/api/issues',
      method: 'POST',
      bodyFormat: 'form',
      body: { UserId: 'abc' },
      itemsPath: 'data.items',
      mapping: {}
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestedOptions.method, 'POST');
  assert.match(requestedOptions.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.equal(new URLSearchParams(requestedOptions.body).get('UserId'), 'abc');
});

test('fetch issue پاسخ JSON دوبار serialize شدهٔ BarsaWebService را باز می‌کند', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get() { return 'application/json'; } },
    async text() {
      return JSON.stringify(JSON.stringify({ data: { items: [{ externalId: '1', title: 'نمونه', status: 'در حال انجام', labels: [] }] } }));
    }
  });
  try {
    const result = await fetchIssues({
      baseUrl: 'https://example.test', listPath: '/issues', method: 'POST', body: {},
      itemsPath: 'data.items', mapping: { externalId: 'externalId', title: 'title', status: 'status', labels: 'labels' }
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].externalId, '1');
    assert.equal(result[0].title, 'نمونه');
  } finally { globalThis.fetch = originalFetch; }
});

test('loadConfig: فهرست کلیدها را از خود فایل .env.local می‌خواند (کامنت، کوتیشن، export) و در config.localEnvKeys می‌گذارد', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-local-env-keys-'));
  const keys = ['BARSA_TEST_KEYS_A', 'BARSA_TEST_KEYS_B', 'BARSA_TEST_KEYS_C'];
  const previous = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => {
    for (const k of keys) { if (previous[k] === undefined) delete process.env[k]; else process.env[k] = previous[k]; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const k of keys) delete process.env[k];
  const file = path.join(root, 'cfg.yml');
  fs.writeFileSync(file, `repos:\n  - id: fake\n    path: "."\nissueSource:\n  body:\n    UserId: "\${BARSA_TEST_KEYS_A}"\n`, 'utf8');
  fs.writeFileSync(path.join(root, '.env.local'), `# comment\n\nBARSA_TEST_KEYS_A=uid\nexport BARSA_TEST_KEYS_B="two words"\nBARSA_TEST_KEYS_C='x'\n`, 'utf8');

  const config = loadConfig(file);
  assert.deepEqual([...config.localEnvKeys].sort(), keys);
  assert.equal(config.issueSource.body.UserId, 'uid');
});

test('loadConfig: بدون .env.local (یا با env سفارشی) localEnvKeys خالی است', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-no-local-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'cfg.yml');
  fs.writeFileSync(file, 'repos:\n  - id: fake\n    path: "."\n', 'utf8');
  assert.deepEqual(loadConfig(file).localEnvKeys, []);
  fs.writeFileSync(path.join(root, '.env.local'), 'BARSA_TEST_IGNORED=1\n', 'utf8');
  assert.deepEqual(loadConfig(file, {}).localEnvKeys, [], 'با env سفارشی فایل خوانده نمی‌شود');
});
