// ابزار مشترک تست‌ها: سرور با حساب واقعی (ورود اجباری است) و fetch ِ لاگین‌شده.
// هیچ bypass ای در کد production نیست؛ تست‌ها دقیقاً از همان مسیر ورود/CSRF می‌گذرند.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { UserStore } from '../src/auth.js';

export const TEST_USER = 'operator';
export const TEST_PASSWORD = 'correct-horse-battery';

const sessions = new Map(); // origin → { cookie, csrf }
const rawFetch = globalThis.fetch;

export async function login(base, { username = TEST_USER, password = TEST_PASSWORD } = {}) {
  const response = await rawFetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password })
  });
  if (!response.ok) throw new Error(`login failed ${response.status}`);
  const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const body = await response.json();
  const session = { cookie, csrf: body.csrf };
  sessions.set(base, session);
  return session;
}

/** fetch ی که اول یک بار لاگین می‌کند و Cookie + X-CSRF-Token را خودش می‌گذارد. */
export async function authedFetch(input, init = {}) {
  const url = new URL(String(input));
  const base = url.origin;
  const session = sessions.get(base) || await login(base);
  const headers = new Headers(init.headers || {});
  headers.set('Cookie', session.cookie);
  if ((init.method || 'GET').toUpperCase() !== 'GET') headers.set('X-CSRF-Token', session.csrf);
  return rawFetch(input, { ...init, headers });
}

export function withDataDir(t, config) {
  if (!config.dataDir) {
    config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-data-'));
    t.after(() => fs.rmSync(config.dataDir, { recursive: true, force: true }));
  }
  return config;
}

export async function seedUser(config) {
  await new UserStore(config.dataDir).add(TEST_USER, TEST_PASSWORD);
}

export async function startAuthedServer(t, config, deps) {
  withDataDir(t, config);
  await seedUser(config);
  const server = createApp(config, deps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, config };
}
