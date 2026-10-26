import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// smoke test ِ **خود فایل** guard.mjs، همان‌طور که Claude Code اجرایش می‌کند: یک فرآیند node، JSON ِ hook روی stdin
// (`{"tool_name":"Bash","tool_input":{"command":…}}`)، و سنجیدن exit code و stdout. تست‌های دیگر فقط تابع ِ evaluate را import
// می‌کنند؛ خطای نحوی/اجرایی در خود ِ اسکریپت (مثل یک `const` ِ تکراری) آن‌ها را نمی‌شکند ولی hook را بی‌صدا از کار می‌اندازد
// (خرابی ِ hook مانع نیست و فقط deny/ask می‌ماند). این تست همین را می‌گیرد.

const GUARD = new URL('../../docs/remote-control/guard.mjs', import.meta.url);

function guardPath(t) {
  // مثل سرور: فایل کپی‌شده در پوشه‌ای دیگر (D:\agent-remote) و cwd ِ دیگر؛ هیچ وابستگی به مخزن نباید باشد.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'barsa-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'guard.mjs');
  fs.copyFileSync(GUARD, file);
  return file;
}

/** @returns {{ code, stdout, stderr, decision }} decision: 'allow' (بدون خروجی) | 'deny' | 'garbage' */
function runGuard(file, command, input) {
  const stdin = input ?? JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
  const result = spawnSync(process.execPath, [file], { input: stdin, encoding: 'utf8', cwd: os.tmpdir(), timeout: 15_000 });
  let decision = 'allow';
  let reason = null;
  if (result.stdout.trim()) {
    try {
      const out = JSON.parse(result.stdout);
      decision = out?.hookSpecificOutput?.hookEventName === 'PreToolUse' && out.hookSpecificOutput.permissionDecision === 'deny' ? 'deny' : 'garbage';
      reason = out?.hookSpecificOutput?.permissionDecisionReason ?? null;
    } catch { decision = 'garbage'; }
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, decision, reason };
}

const expectAllow = (r, label) => assert.deepEqual({ code: r.code, stderr: r.stderr, decision: r.decision, stdout: r.stdout }, { code: 0, stderr: '', decision: 'allow', stdout: '' }, label);
const expectDeny = (r, label) => {
  assert.equal(r.code, 0, `${label}: exit code (stderr: ${r.stderr.slice(0, 200)})`);
  assert.equal(r.stderr, '', `${label}: stderr خالی است`);
  assert.equal(r.decision, 'deny', `${label}: باید deny باشد (stdout: ${r.stdout.slice(0, 200)})`);
  assert.match(r.reason, /./, label);
};

test('guard.mjs به‌صورت فرآیند: فرمان ِ مجاز ← اجازه (بدون خروجی، exit 0)', t => {
  const file = guardPath(t);
  for (const command of [
    './barsa runtime-options', './barsa runtime 10013', './barsa tasks --waiting', './barsa task 10013 --json',
    './barsa set-runtime 10013 implementer ::high --reason "bump effort"',
    './barsa recheck 10023', './barsa recheck 10023 --json', './barsa recheck 10023 --repo main',
    './barsa drain', './barsa drain --status', './barsa drain --off', './barsa sync --status 20261026101500-0a1b2c3d',
    './barsa answer 5 --note --stdin <<\'EOF\'\nمتن با $HOME و ; داخل heredoc\nEOF'
  ]) expectAllow(runGuard(file, command), command);
});

test('guard.mjs به‌صورت فرآیند: whoami، جایگزینی دستور، نقش با حرف بزرگ، زنجیره ← deny با JSON ِ PreToolUse', t => {
  const file = guardPath(t);
  expectDeny(runGuard(file, 'whoami'), 'whoami');
  expectDeny(runGuard(file, './barsa runtime-options $(id)'), 'runtime-options $(id)');
  expectDeny(runGuard(file, './barsa set-runtime 5 Implementer claude:claude-opus-5-5:high --reason "x"'), 'نقش با حرف بزرگ');
  expectDeny(runGuard(file, './barsa runtime 5 --evil'), 'گزینه‌ی ناشناخته');
  expectDeny(runGuard(file, './barsa tasks; ls'), 'زنجیره با ;');
  expectDeny(runGuard(file, 'ls'), 'ls');
  expectDeny(runGuard(file, './barsa create-task --title x --runtime "bad;spec" --stdin'), 'spec ِ ناجور');
  expectDeny(runGuard(file, ''), 'فرمان ِ خالی');
  // recheck: فقط شناسه (بدون آرگومان ِ دیگر)، بدون زنجیره/جایگزینی
  expectDeny(runGuard(file, './barsa recheck'), 'recheck بدون شناسه');
  expectDeny(runGuard(file, './barsa recheck 5 --force'), 'recheck --force');
  expectDeny(runGuard(file, './barsa recheck 5 6'), 'recheck با دو شناسه');
  expectDeny(runGuard(file, './barsa recheck $(id)'), 'recheck $(id)');
  expectDeny(runGuard(file, './barsa recheck 5; ls'), 'recheck با زنجیره');
  // drain: --status و --off با هم، آرگومان ِ اضافه، زنجیره، گزینه‌ی ناشناخته
  expectDeny(runGuard(file, './barsa drain --status --off'), 'drain --status --off');
  expectDeny(runGuard(file, './barsa drain 5'), 'drain با آرگومان');
  expectDeny(runGuard(file, './barsa drain --off; ls'), 'drain با زنجیره');
  expectDeny(runGuard(file, './barsa drain --force'), 'drain --force');
  expectDeny(runGuard(file, './barsa drain $(id)'), 'drain $(id)');
});

test('guard.mjs به‌صورت فرآیند: ورودی ِ خراب (JSON نامعتبر، بدون tool_input) ← deny، نه کرش', t => {
  const file = guardPath(t);
  expectDeny(runGuard(file, null, 'not json at all'), 'JSON نامعتبر');
  expectDeny(runGuard(file, null, '{}'), 'بدون tool_input');
  expectDeny(runGuard(file, null, JSON.stringify({ tool_input: { command: 42 } })), 'command غیررشته');
  expectDeny(runGuard(file, null, ''), 'stdin خالی');
});

test('خود ِ فایل بی‌خطای نحوی است (node --check)، و خطای نحوی/اجرایی این smoke test را می‌شکند، نه اینکه بی‌صدا رد شود', t => {
  const file = guardPath(t);
  assert.equal(spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' }).status, 0);

  // meta-test: همان خطای واقعی (const ِ تکراری) ← runGuard باید خرابی را نشان بدهد
  const broken = path.join(path.dirname(file), 'broken-guard.mjs');
  fs.writeFileSync(broken, fs.readFileSync(file, 'utf8').replace('const [name, ...commandArgs] = args;', 'const [name, ...rest] = args; const commandArgs = rest;'));
  const bad = runGuard(broken, './barsa runtime 5');
  assert.notEqual(bad.code, 0, 'نسخه‌ی خراب باید exit ≠ 0 بدهد');
  assert.match(bad.stderr, /SyntaxError|already been declared/);
  assert.throws(() => expectAllow(bad, 'نسخه‌ی خراب'), 'expectAllow باید روی guard خراب بشکند');
  assert.throws(() => expectDeny(runGuard(broken, 'whoami'), 'نسخه‌ی خراب'), 'expectDeny هم');

  // خطای اجرایی (نه نحوی): guard که می‌میرد
  const crashing = path.join(path.dirname(file), 'crash-guard.mjs');
  fs.writeFileSync(crashing, `${fs.readFileSync(file, 'utf8')}\nthrow new Error('boom');\n`);
  assert.throws(() => expectAllow(runGuard(crashing, './barsa runtime 5'), 'کرش'), 'کرش اجرایی هم تشخیص داده می‌شود');
});
