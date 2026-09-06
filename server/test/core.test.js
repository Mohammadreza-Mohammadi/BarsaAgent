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


test('fetch issue پارامتر UserId تنظیم‌شده را به وب‌سرویس ارسال می‌کند', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  globalThis.fetch = async (url) => {
    requestedUrl = String(url);
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
      itemsPath: 'data.items',
      query: { UserId: '20b785b0-db71-4507-9757-b5280460b0cb' },
      mapping: {}
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get('UserId'), '20b785b0-db71-4507-9757-b5280460b0cb');
});
