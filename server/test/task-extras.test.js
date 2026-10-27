import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ts from '../../client/src/app/task-extras.ts';
import * as view from '../src/task-extras-view.js';
import { opsButtons, unknownActionKeys, canAnswerGate, KNOWN_ACTION_KEYS, ACTION_PLACEMENT } from '../../client/src/app/task-actions.ts';

// منطق ِ TOOLING-050 (چک‌لیست ِ تست‌های دستی، پیوست، دروازه‌ی وابستگی، رویدادها): دو نسخه (UI: task-extras.ts، CLI/diag: task-extras-view.js)
// باید یکی باشند. شکل ِ fixtureها از status-json.schema.json ِ Manager (و status --json ِ واقعی روی main) است.

const read = rel => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

const MANUAL = [
  { id: 'TC-R1', section: 'Runtime دستی (اجرا: انسان)', summary: 'AC-1 — ضبط ۱۰ ثانیه، ارسال فرم', typeSource: 'legacy-heading' },
  { id: 'TC-R2', section: 'Runtime دستی (اجرا: انسان)', summary: 'AC-2 — لغو ضبط', typeSource: 'legacy-heading' }
];
const tests = (extra = {}) => ({ format: 'canonical', autoCases: ['M1', 'M2'], manualCases: MANUAL, problems: [], ...extra });
const gate = kind => ({ kind, since: '2026-10-27T08:00:00Z' });

test('چک‌لیست ِ تست‌های دستی: فقط پشت ِ دروازه‌ی merge و وقتی manualCases خالی نیست؛ problems هشدار ِ کوتاه', () => {
  const t = { awaitingHuman: gate('merge-approval'), tests: tests() };
  const checklist = ts.manualChecklist(t);
  assert.deepEqual(checklist.items.map(item => item.id), ['TC-R1', 'TC-R2']);
  assert.equal(checklist.items[0].section, 'Runtime دستی (اجرا: انسان)');
  assert.deepEqual(checklist.problems, []);
  assert.deepEqual(view.manualChecklist(t), checklist);

  for (const none of [
    { awaitingHuman: gate('spec-approval'), tests: tests() }, // دروازه‌ی دیگر
    { awaitingHuman: null, tests: tests() },
    { awaitingHuman: gate('merge-approval'), tests: tests({ manualCases: [] }) }, // Case ِ دستی نیست
    { awaitingHuman: gate('merge-approval'), tests: null }, // tests.md نیست
    { awaitingHuman: gate('merge-approval') }, // Manager قدیمی
    null
  ]) {
    assert.equal(ts.manualChecklist(none), null);
    assert.equal(view.manualChecklist(none), null);
  }

  assert.equal(ts.testsProblemsWarning({ tests: tests() }), null);
  const one = ts.testsProblemsWarning({ tests: tests({ problems: ['شناسه‌ی تکراری ِ TC-1'] }) });
  assert.equal(one, 'شناسه‌ی تکراری ِ TC-1');
  const many = ts.testsProblemsWarning({ tests: tests({ problems: ['الف '.repeat(80), 'ب', 'ج'] }) });
  assert.match(many, /…\s\(و 2 مورد دیگر\)$/);
  assert.equal(view.testsProblemsWarning({ tests: tests({ problems: ['الف '.repeat(80), 'ب', 'ج'] }) }), many);
  assert.equal(ts.testsProblemsWarning(null), null);

  const key = ts.checklistStorageKey('main', { id: '10024', git: { headCommit: 'abc123' } });
  assert.equal(key, 'ba.manual-tests.main.10024.abc123');
  assert.notEqual(key, ts.checklistStorageKey('main', { id: '10024', git: { headCommit: 'def456' } }), 'بعد از تغییر ِ کد چک‌لیست از صفر');
});

const ITEM = (id, patch = {}) => ({
  id, name: `${id}.png`, file: `${id}.png`, kind: 'image', ext: '.png', size: 2048, sha256: 'a'.repeat(64), addedAt: '2026-10-27T08:00:00Z', stage: null,
  source: 'attach', reason: 'added from Kanban console', humanOnly: false, derivedFrom: null, path: `D:/att/10024/${id}.png`, exists: true, ...patch
});

test('پیوست‌ها: فریم‌های استخراج‌شده زیر همان ویدیو؛ فریم ِ بی‌والد خودش اصلی؛ اندازه و برچسب‌ها', () => {
  const items = [ITEM('A-1'), ITEM('V-1', { kind: 'video', name: 'demo.mp4', ext: '.mp4', humanOnly: false }), ITEM('F-1', { derivedFrom: 'V-1', source: 'derived' }), ITEM('F-2', { derivedFrom: 'V-1', source: 'derived' }), ITEM('O-1', { derivedFrom: 'GONE' })];
  const groups = ts.attachmentGroups(items);
  assert.deepEqual(groups.map(g => [g.item.id, g.frames.map(f => f.id)]), [['A-1', []], ['V-1', ['F-1', 'F-2']], ['O-1', []]]);
  assert.deepEqual(view.attachmentGroups(items).map(g => [g.item.id, g.frames.map(f => f.id)]), groups.map(g => [g.item.id, g.frames.map(f => f.id)]));
  assert.deepEqual(ts.attachmentGroups(undefined), []);
  assert.deepEqual([ts.humanSize(0), ts.humanSize(900), ts.humanSize(1536), ts.humanSize(5 * 1024 * 1024), ts.humanSize(null), ts.humanSize(-1)], ['0B', '900B', '1.5KB', '5.0MB', '—', '—']);
  for (const n of [0, 900, 1536, 5 * 1024 * 1024, 3 * 1024 ** 3, null]) assert.equal(view.humanSize(n), ts.humanSize(n));
  assert.equal(ts.kindLabel('video'), 'ویدیو');
  assert.equal(ts.previewable({ kind: 'image', exists: true }), true);
  assert.equal(ts.previewable({ kind: 'image', exists: false }), false, 'فایل نیست ← بدون پیش‌نمایش');
  assert.equal(ts.previewable({ kind: 'pdf', exists: true }), false, 'فقط تصویر پیش‌نمایش دارد');

  const lines = view.attachmentLines({ root: 'D:/att', items });
  assert.match(lines[0], /پیوست‌ها \(5\):/);
  assert.match(lines.join('\n'), / {6}↳ F-1 · F-1\.png/);
  assert.match(view.attachmentLines({ root: null, items: [ITEM('X', { humanOnly: true, exists: false })] }).join('\n'), /فقط برای انسان.*⚠ فایل روی دیسک نیست/);
  assert.deepEqual(view.attachmentLines({ root: null, items: [] }), ['پیوستی ندارد.']);
});

const peer = (name, satisfied, extra = {}) => ({ name, range: '^18.0.0', installed: satisfied === null ? null : '17.0.2', satisfied, optional: false, ...extra });
const dep = (name, info, extra = {}) => ({ name, version: '1.2.3', dev: false, reason: 'برای نمودار', info, ...extra });
const known = (peers, extra = {}) => ({ known: true, error: null, version: '1.2.3', license: 'MIT', hasInstallScript: false, peerDependencies: {}, peers, peersOk: peers.every(p => p.satisfied !== false), ...extra });
const approval = (dependencies, peersOk = true) => ({ version: 1, attempt: '003', requestedAt: '2026-10-27T08:00:00Z', peersOk, dependencies });

test('دروازه‌ی وابستگی: جدول ِ peerها، peer ِ ناسازگار، info.known=false با دلیل، hasInstallScript؛ هر دو نسخه یکی', () => {
  const ok = { dependencyApproval: approval([dep('echarts', known([peer('zrender', true)]))]) };
  const bad = { dependencyApproval: approval([dep('react-charts', known([peer('react', false), peer('react-dom', true), peer('opt', false, { optional: true })], { hasInstallScript: true }), { dev: true }), dep('lodash', known([]))], false) };
  const unknown = { dependencyApproval: approval([dep('mystery', { known: false, error: 'registry در دسترس نبود', version: null, license: null, hasInstallScript: null, peerDependencies: {}, peers: [], peersOk: null })], null) };

  for (const t of [ok, bad, unknown, {}, { dependencyApproval: null }, null]) {
    assert.deepEqual(view.dependencyView(t), ts.dependencyView(t));
    assert.equal(view.hasPeerProblem(t), ts.hasPeerProblem(t));
  }
  assert.equal(ts.dependencyView({ dependencyApproval: null }), null, 'دروازه بسته ← null');
  assert.equal(ts.hasPeerProblem(ok), false);
  assert.equal(ts.hasPeerProblem(bad), true);
  assert.equal(ts.hasPeerProblem(unknown), false, 'سنجیده‌نشده ≠ ناسازگار');
  assert.equal(ts.hasPeerProblem({ dependencyApproval: approval([dep('x', known([peer('p', false, { optional: true })], { peersOk: true }))], true) }), false, 'peer ِ اختیاری ناسازگار مانع ِ تأیید ِ ساده نیست');

  const v = ts.dependencyView(bad);
  assert.deepEqual(v.dependencies[0].peers.map(p => [p.name, p.status]), [['react', 'bad'], ['react-dom', 'ok'], ['opt', 'bad']]);
  assert.equal(v.dependencies[0].hasInstallScript, true);
  assert.equal(v.dependencies[0].dev, true);
  const u = ts.dependencyView(unknown).dependencies[0];
  assert.deepEqual([u.known, u.error, u.peers], [false, 'registry در دسترس نبود', []], 'به‌جای جدول، دلیل');
  assert.equal(ts.peerStatus({ satisfied: null }), 'unknown');
  assert.equal(ts.dependencyLabel({ name: 'echarts', version: '5.5.0', dev: true }), 'echarts@5.5.0 (dev)');

  const text = view.dependencyLines(bad).join('\n');
  assert.match(text, /دروازه‌ی تأیید ِ وابستگی \(attempt 003/);
  assert.match(text, /⚠ peer ِ ناسازگار/);
  assert.match(text, /• react-charts@1\.2\.3 \(dev\) — برای نمودار/);
  assert.match(text, /hasInstallScript: بله ⚠/);
  assert.match(text, /peer react \^18\.0\.0 · نصب‌شده: 17\.0\.2 · ✗ نمی‌خواند/);
  assert.match(text, /peer opt .* ✗ نمی‌خواند \(اختیاری\)/);
  assert.match(view.dependencyLines(unknown).join('\n'), /اطلاعات ِ registry نیست: registry در دسترس نبود/);
  assert.deepEqual(view.dependencyLines({ dependencyApproval: null }), []);
});

test('رویدادهای تازه: متن ِ کوتاه ِ فارسی؛ localEdits=null «نامعلوم» است نه «بله»', () => {
  const events = [
    { event: 'external.changed-by-sync', attempt: '003', role: 'implementer', sources: [{ id: 'webiii', reason: 'recorded-sync', mutations: [{ kind: 'tf-get', task: '10020', startedAt: 't', at: 't' }] }], budgetConsumed: 'none' },
    { event: 'external.changed-by-sync', attempt: '004', role: 'reviewer', sources: [{ id: 'webiii', reason: 'role-no-write' }], budgetConsumed: 'none' },
    { event: 'external.sync-deferred', source: 'webiii', when: 'قبل از attempt', reason: 'writer-active', note: 'tf get به تعویق افتاد — نویسنده‌ی فعال' },
    { event: 'attachment.added', id: 'A-1', name: 'screen.png', kind: 'image', size: 2048, humanOnly: false, derived: [] },
    { event: 'attachment.added', id: 'V-1', name: 'demo.mp4', kind: 'video', size: 5 * 1024 * 1024, humanOnly: true, derived: ['F-1', 'F-2'] },
    { event: 'dependency-approval.requested', attempt: '003', dependencies: [{ name: 'echarts', version: '5.5.0', dev: false }, { name: 'vitest', version: '2.0.0', dev: true }], peersOk: false },
    { event: 'dependency-approval.approved', reason: 'needed' },
    { event: 'dependency-approval.rejected', reason: 'use existing lib' },
    { event: 'dependency.installed', dependencies: [{ name: 'echarts', version: '5.5.0', dev: false }], commit: 'abcdef1234567890', durationMs: 4000 },
    { event: 'dependency.install-failed', reason: 'ERESOLVE', dependencies: ['echarts@5.5.0'], tail: [] },
    { event: 'external.snapshot', source: 'webiii', localEdits: null, diskChanged: true, cause: 'sync' },
    { event: 'external.snapshot', source: 'webiii', localEdits: true },
    { event: 'external.snapshot', source: 'webiii' },
    { event: 'state.changed', from: 'a', to: 'b' }
  ];
  for (const e of events) assert.deepEqual(view.extrasEventText(e), ts.extrasEventText(e), e.event);

  const [synced, relay, deferred, att, video, requested, approved, rejected, installed, failed, snapNull, snapTrue, snapPlain, other] = events.map(e => ts.extrasEventText(e));
  assert.match(synced.details, /منبع بیرونی «webiii» در طول attempt 003 با sync ِ tf-get \(تسک 10020\) عوض شد — به حساب agent گذاشته نشد/);
  assert.match(relay.details, /کار ِ agent نبود \(نقش reviewer دسترسی ِ نوشتن نداشت\) — به حساب agent گذاشته نشد/);
  assert.match(deferred.label, /به تعویق افتاد/);
  assert.match(deferred.details, /«webiii» \(قبل از attempt\) — tf get به تعویق افتاد/);
  assert.equal(att.details, '«screen.png» (تصویر، 2.0KB)');
  assert.equal(video.details, '«demo.mp4» (ویدیو، 5.0MB) · فقط برای انسان · 2 فریم ِ استخراج‌شده');
  assert.equal(requested.details, 'echarts@5.5.0، vitest@2.0.0 (dev) · ⚠ peer ِ ناسازگار');
  assert.equal(approved.label, 'وابستگی تأیید شد');
  assert.match(rejected.label, /وابستگی رد شد/);
  assert.equal(installed.details, 'echarts@5.5.0 · commit abcdef12');
  assert.match(failed.details, /^ERESOLVE · echarts@5\.5\.0$/);
  assert.match(snapNull.details, /ویرایش ِ دستی ِ محلی: نامعلوم · دیسک عوض شده: بله · علت: sync/);
  assert.match(snapTrue.details, /ویرایش ِ دستی ِ محلی: بله/);
  assert.equal(snapPlain, null, 'snapshot ِ قدیمی (بدون فیلد ِ تازه) همان نمایش ِ عمومی');
  assert.equal(other, null);
  assert.deepEqual([ts.localEditsText(true), ts.localEditsText(false), ts.localEditsText(null), ts.localEditsText(undefined)], ['بله', 'خیر', 'نامعلوم', 'نامعلوم']);
});

const POLICY = {
  available: true, configured: true, maxUploadBytes: 200 * 1024 * 1024, maxFiles: 20,
  kinds: { image: { extensions: ['.png', '.jpg'], maxBytes: 10 * 1024 * 1024 }, text: { extensions: ['.txt', '.md'], maxBytes: 2 * 1024 * 1024 } },
  forbidden: ['.exe', '.js', '.svg', '.html']
};

test('پیش‌سنجی ِ فایل با سیاست ِ Manager (نه فهرست ِ سخت‌کدشده): ممنوع، نامجاز، اندازه، خالی؛ بدون policy فقط سقف ِ سرور', () => {
  assert.equal(ts.checkFileAgainstPolicy('a.png', 1000, POLICY), null);
  assert.match(ts.checkFileAgainstPolicy('run.exe', 1000, POLICY), /پسوند ِ \.exe ممنوع است/);
  assert.match(ts.checkFileAgainstPolicy('evil.exe.png', 1000, POLICY), /\.exe ممنوع/, 'هر بخش ِ نقطه‌دار سنجیده می‌شود');
  assert.match(ts.checkFileAgainstPolicy('x.svg', 1000, POLICY), /\.svg ممنوع/);
  assert.match(ts.checkFileAgainstPolicy('x.docx', 1000, POLICY), /«\.docx» مجاز نیست\. مجاز: \.png \.jpg \.txt \.md/);
  assert.match(ts.checkFileAgainstPolicy('noext', 1000, POLICY), /بدون پسوند/);
  assert.match(ts.checkFileAgainstPolicy('big.png', 11 * 1024 * 1024, POLICY), /از سقف ِ نوع ِ تصویر \(10\.0MB\)/);
  assert.match(ts.checkFileAgainstPolicy('huge.txt', 300 * 1024 * 1024, POLICY), /از سقف ِ سرور/);
  assert.equal(ts.checkFileAgainstPolicy('a.png', 0, POLICY), 'فایل خالی است.');
  // Manager قدیمی (policy در دسترس نیست): فقط سقف ِ سرور؛ تصمیم ِ نهایی با Manager
  const noPolicy = { ...POLICY, available: false, kinds: null, forbidden: null };
  assert.equal(ts.checkFileAgainstPolicy('run.exe', 1000, noPolicy), null);
  assert.match(ts.checkFileAgainstPolicy('x.png', 300 * 1024 * 1024, noPolicy), /سقف ِ سرور/);
  assert.equal(ts.checkFileAgainstPolicy('x.png', 10, null), null);
  assert.match(ts.policyHint(POLICY), /تصویر: \.png \.jpg \(تا 10\.0MB\) · متن: \.txt \.md \(تا 2\.0MB\)/);
  assert.match(ts.policyHint(noPolicy), /سقف ِ هر فایل 200\.0MB/);
  assert.equal(ts.policyHint(null), null);
});

test('actions ِ تازه: approveDependencies/rejectDependencies شناخته‌شده‌اند (gate)، و دروازه‌ی وابستگی دکمه‌ی «اقدام» روی کارت می‌گیرد', () => {
  for (const key of ['approveDependencies', 'rejectDependencies']) {
    assert.ok(KNOWN_ACTION_KEYS.includes(key));
    assert.equal(ACTION_PLACEMENT[key], 'gate');
  }
  const t = { actions: { approveDependencies: true, rejectDependencies: true } };
  assert.deepEqual(unknownActionKeys(t), []);
  assert.deepEqual(opsButtons(t).map(b => b.id), [], 'دکمه‌ی دروازه در ops نیست (در پنل ِ اقدام ِ gate)');
  assert.equal(canAnswerGate(t), true);
  assert.equal(canAnswerGate({ actions: { approveDependencies: false, rejectDependencies: false } }), false);
});

test('رابط کاربری: picker (انتخاب/کشیدن/Ctrl+V)، بخش پیوست‌ها، چک‌لیست، دروازه‌ی وابستگی، و اتصال در app.component', () => {
  const picker = read('../../client/src/app/attachment-picker.component.ts');
  assert.match(picker, /type="file" multiple/);
  assert.match(picker, /\(drop\)="onDrop\(\$event\)"/);
  assert.match(picker, /addEventListener\('paste'/);
  assert.match(picker, /clipboardData\?\.files/);
  assert.match(picker, /checkFileAgainstPolicy/);
  const attachments = read('../../client/src/app/task-attachments.component.ts');
  assert.match(attachments, /فقط برای انسان/);
  assert.match(attachments, /فایل روی دیسک نیست/);
  assert.match(attachments, /class="att-thumb"/);
  assert.match(attachments, /attachFiles\(/);
  const manual = read('../../client/src/app/manual-tests.component.ts');
  assert.match(manual, /localStorage/);
  assert.match(manual, /یادآوری است، approve را شرطی نمی‌کند/);
  assert.doesNotMatch(manual, /\[disabled\]/,'چک‌لیست هیچ چیز را غیرفعال نمی‌کند');
  const deps = read('../../client/src/app/task-dependencies.component.ts');
  assert.match(deps, /<b>به انگلیسی<\/b>/);
  assert.match(deps, /confirmPeers/);
  assert.match(deps, /actions\.approveDependencies = false/);
  const app = read('../../client/src/app/app.component.html');
  assert.match(app, /<ba-manual-tests /);
  assert.match(app, /<ba-task-dependencies \*ngIf="gateKind\(t\) === 'dependency-approval'"/);
  assert.match(app, /<ba-task-attachments /);
  assert.equal((app.match(/<ba-attachment-picker /g) ?? []).length, 3, 'ساخت، یادداشت، clarify');
  const appTs = read('../../client/src/app/app.component.ts');
  assert.match(appTs, /'dependency-approval': 'تأیید وابستگی'/);
  assert.match(appTs, /extrasEventText\(e\)/);
  assert.match(appTs, /attachments: item\.attachments\?\.map\(upload => upload\.id\)/, 'به سرور فقط شناسه‌ها می‌رود');
});
