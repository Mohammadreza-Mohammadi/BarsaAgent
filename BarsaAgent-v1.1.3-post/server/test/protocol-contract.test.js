import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectManager, validateCapabilities } from '../src/protocol-contract.js';

const goodPayload = {
  contract: 'barsa-agent-manager',
  contractVersion: 1,
  managerVersion: '2.4.0',
  protocolVersion: '4',
  capabilities: {
    status: true,
    taskStatus: true,
    events: true,
    artifact: true,
    run: true,
    answer: { approve: true, reject: true, clarify: true },
    importIssue: true
  }
};

test('Contract v1 همه capabilityهای اجباری را می‌پذیرد', () => {
  const result = validateCapabilities(goodPayload);
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test('Contract ناسازگار capability کم‌شده را دقیق گزارش می‌دهد', () => {
  const payload = structuredClone(goodPayload);
  payload.capabilities.answer.clarify = false;
  const result = validateCapabilities(payload);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ['answer.clarify']);
  assert.match(result.errors.join('\n'), /answer\.clarify/);
});

test('inspectManager فقط از capabilities --json روی manager خارجی استفاده می‌کند', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-manager-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manager = path.join(root, 'manager.cjs');
  fs.writeFileSync(manager, `
const args = process.argv.slice(2);
if (args[0] === 'capabilities' && args[1] === '--json') {
  process.stdout.write(${JSON.stringify(JSON.stringify(goodPayload))});
} else process.exit(2);
`, 'utf8');
  const result = await inspectManager({ id: 'fake', path: root, managerScript: 'manager.cjs' });
  assert.equal(result.ok, true);
  assert.equal(result.managerVersion, '2.4.0');
  assert.equal(result.contractVersion, 1);
});
