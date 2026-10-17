import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentEnv } from '../src/agent-env.js';

// کانبان-الحاقیه-۱، بند الف: env ِ فرزندی که manager.js «run» (و از آن طریق
// run-agent.js) را اجرا می‌کند — همیشه بدون CLAUDE_CODE_OAUTH_TOKEN، و با
// همان پروکسی که انسان قبل از run دستی در ترمینال ست می‌کرد.

test('buildAgentEnv: بدون config.run.proxy، پیش‌فرض 127.0.0.1:10808 ست می‌شود و token حذف می‌شود', () => {
  const baseEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'secret-token-value', PATH: '/usr/bin' };
  const env = buildAgentEnv({}, baseEnv);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:10808');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:10808');
  assert.equal(env.PATH, '/usr/bin', 'باقی env دست‌نخورده می‌ماند');
});

test('buildAgentEnv: config.run.proxy صریح، همان مقدار را ست می‌کند', () => {
  const env = buildAgentEnv({ run: { proxy: 'http://10.0.0.1:9999' } }, {});
  assert.equal(env.HTTP_PROXY, 'http://10.0.0.1:9999');
  assert.equal(env.HTTPS_PROXY, 'http://10.0.0.1:9999');
});

test('buildAgentEnv: config.run.proxy خالی (رشته‌ی خالی) → پروکسی حذف می‌شود، حتی اگر در baseEnv باشد', () => {
  const baseEnv = { HTTP_PROXY: 'http://leftover-from-server:1', HTTPS_PROXY: 'http://leftover-from-server:1' };
  const env = buildAgentEnv({ run: { proxy: '' } }, baseEnv);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
});

test('buildAgentEnv: config.run.proxy برابر null هم مثل خالی رفتار می‌کند', () => {
  const env = buildAgentEnv({ run: { proxy: null } }, { HTTP_PROXY: 'http://x' });
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
});

test('buildAgentEnv: token همیشه حذف می‌شود، حتی اگر در baseEnv باشد و config چیزی نگوید', () => {
  const env = buildAgentEnv(undefined, { CLAUDE_CODE_OAUTH_TOKEN: 'x' });
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test('buildAgentEnv: baseEnv اصلی تغییر نمی‌کند (کپی، نه mutate)', () => {
  const baseEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'secret' };
  buildAgentEnv({}, baseEnv);
  assert.equal(baseEnv.CLAUDE_CODE_OAUTH_TOKEN, 'secret', 'شیء ورودی دست‌نخورده بماند');
});
