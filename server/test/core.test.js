import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIssues, normalizeIssues } from '../src/issues.js';
import { redact } from '../src/security.js';
import { parseConfigYaml } from '../src/config.js';

test('mapping مسیر نقطه‌ای و itemsPath را اعمال می‌کند', () => {
  const source = { itemsPath: 'data.items', mapping: { externalId: 'key', title: 'fields.subject', body: 'fields.description', labels: 'tags' } };
  const result = normalizeIssues({ data: { items: [{ key: 42, fields: { subject: 'نمونه', description: 'متن' }, tags: ['bug'] }] } }, source)[0];
  assert.equal(result.externalId, '42');
  assert.equal(result.title, 'نمونه');
  assert.equal(result.body, 'متن');
  assert.deepEqual(result.labels, ['bug']);
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
