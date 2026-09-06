import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '../..');

test('status --json با یک manifest خراب کل برد را کور نمی‌کند', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-protocol-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agent-work', 'tasks', '0001-good'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agent-work', 'tasks', '0002-bad'), { recursive: true });
  fs.copyFileSync(path.join(project, 'protocol-patch', 'scripts', 'manager.js'), path.join(root, 'scripts', 'manager.js'));
  fs.copyFileSync(path.join(project, 'protocol-patch', 'scripts', 'lib', 'manifest.cjs'), path.join(root, 'scripts', 'lib', 'manifest.cjs'));
  fs.writeFileSync(path.join(root, '.agent-work', 'tasks', '0001-good', 'manifest.yaml'), 'id: "0001"\ntitle: "سالم"\ntype: task\nstate: new\nstateSince: "2026-09-06T00:00:00Z"\n');
  fs.writeFileSync(path.join(root, '.agent-work', 'tasks', '0002-bad', 'manifest.yaml'), 'id: "0002"\ntitle: "خراب"\n');
  const stdout = execFileSync(process.execPath, [path.join(root, 'scripts', 'manager.js'), 'status', '--json'], { cwd: root, encoding: 'utf8' });
  const board = JSON.parse(stdout);
  assert.equal(board.tasks.length, 2);
  assert.equal(board.tasks.find(x => x.id === '0001').state, 'new');
  assert.match(board.tasks.find(x => x.id === '0002').error, /state/);
});

test('status --json برای task ناموجود نیز stdout معتبر JSON می‌دهد', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-agent-status-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agent-work', 'tasks'), { recursive: true });
  fs.copyFileSync(path.join(project, 'protocol-patch', 'scripts', 'manager.js'), path.join(root, 'scripts', 'manager.js'));
  fs.copyFileSync(path.join(project, 'protocol-patch', 'scripts', 'lib', 'manifest.cjs'), path.join(root, 'scripts', 'lib', 'manifest.cjs'));
  let stdout = '';
  try { execFileSync(process.execPath, [path.join(root, 'scripts', 'manager.js'), 'status', '--json', '--task', '404'], { cwd: root, encoding: 'utf8' }); }
  catch (e) { stdout = e.stdout; }
  const payload = JSON.parse(stdout);
  assert.equal(payload.tasks.length, 0);
  assert.match(payload.error, /404/);
});
