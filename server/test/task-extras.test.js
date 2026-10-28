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

// --- TOOLING-051 ------------------------------------------------------------------------------------------------------

test('actions.run: تنها منبع ِ «می‌شود اجرا کرد»؛ reason ِ Manager؛ Manager ِ قدیمی (بدون کلید) ← null؛ هر دو نسخه یکی', () => {
  const blocked = { actions: { run: false }, runBlocked: { code: 'awaiting-human', reason: 'منتظر ِ تصمیم ِ انسان است — اول جواب بده.' } };
  const fixtures = [
    { actions: { run: true } }, blocked, { actions: { run: false } },
    { actions: { approve: true } }, // Manager ِ قدیمی: کلید ِ run نیست
    {}, null, { actions: null }
  ];
  for (const t of fixtures) {
    assert.deepEqual(view.runInfo(t), ts.runInfo(t));
    assert.equal(view.runLine(t), ts.runLine(t));
  }
  assert.deepEqual(ts.runInfo({ actions: { run: true } }), { allowed: true, code: null, reason: null });
  assert.deepEqual(ts.runInfo(blocked), { allowed: false, code: 'awaiting-human', reason: 'منتظر ِ تصمیم ِ انسان است — اول جواب بده.' });
  assert.equal(ts.runInfo({ actions: { run: false } }).reason, 'Manager دلیلی برای ِ ممکن‌نبودن ِ اجرا نداد', 'بدون runBlocked هم بی‌خطا');
  assert.equal(ts.runInfo({ actions: { approve: true } }), null, 'Manager ِ قدیمی ← رفتار ِ قبلی');
  assert.equal(ts.runLine({ actions: { run: true } }), 'اجرا: ممکن');
  assert.equal(ts.runLine(blocked), 'اجرا: ممکن نیست — منتظر ِ تصمیم ِ انسان است — اول جواب بده.');
  assert.equal(ts.runLine({}), null);
});

test('story ِ SPDD، changeset ِ مؤثر (با پیشوند C و ورودی ِ کاربر)، و هشدار ِ «ثبت نشده»', () => {
  const task = { spdd: [{ project: 'barsa-sap-ui', code: 'BSUI-026', number: 26, slug: 'feature-x', dir: 'ai-context/spdd/barsa-sap-ui/BSUI-026-feature-x' }, { code: 7 }] };
  assert.deepEqual(view.spddStories(task), ts.spddStories(task));
  assert.equal(ts.spddStories(task).length, 1, 'ورودی ِ ناقص نادیده');
  assert.equal(ts.spddText(ts.spddStories(task)[0]), 'story: BSUI-026 (feature-x)');
  assert.deepEqual(ts.spddStories({}), []);

  assert.deepEqual(['17792', 'c17792', 'C17792', ' 17792 ', '', null].map(ts.changesetLabel), ['C17792', 'C17792', 'C17792', 'C17792', '', '']);
  for (const v of ['17792', 'C1', null, '']) assert.equal(view.changesetLabel(v), ts.changesetLabel(v));
  assert.equal(ts.parseChangesetInput('17800'), 'C17800');
  assert.equal(ts.parseChangesetInput('C17800, 17803 17800'), 'C17800,C17803');
  assert.equal(ts.parseChangesetInput('17800،C17803'), 'C17800,C17803', 'کامای فارسی هم');
  for (const bad of ['', 'abc', '17800;ls', '1'.repeat(10), '$(id)', null, Array.from({ length: 21 }, (_, i) => String(i + 1)).join(',')]) {
    assert.equal(ts.parseChangesetInput(bad), null, String(bad));
    assert.equal(view.parseChangesetInput(bad), null);
  }
  assert.equal(view.parseChangesetInput('C17800, 17803'), ts.parseChangesetInput('C17800, 17803'));

  const src = (id, patch = {}) => ({ id, access: 'write', delivery: 'apply', staged: null, checkedIn: null, declaredChangesets: [], actions: { canStageExternal: false, canMarkCheckedIn: false, canDeclareChangeset: true }, ...patch });
  const integrated = { state: 'integrated', externalSources: [src('webiii', { declaredChangesets: ['17792', '17794'], checkedIn: { changesets: ['C17792', 'C17794'], at: 't' } }), src('other'), src('ro', { access: 'read', actions: { canDeclareChangeset: false } }), { id: 'broken', error: 'x' }] };
  assert.deepEqual(view.externalChangesets(integrated), ts.externalChangesets(integrated));
  const rows = ts.externalChangesets(integrated);
  assert.deepEqual(rows.map(r => [r.id, r.declared, r.canDeclare, r.missing]), [['webiii', ['C17792', 'C17794'], true, false], ['other', [], true, true], ['ro', [], false, false]]);
  assert.deepEqual(rows[0].checkedIn, ['C17792', 'C17794']);
  assert.equal(ts.externalChangesets({ state: 'implementing', externalSources: [src('x')] })[0].missing, false, 'فقط integrated هشدار می‌دهد');
  assert.deepEqual(ts.externalChangesets({}), []);
});

test('blocker ِ needs-human: reviewer-clarification (متن ِ سؤال از رویداد) و rejection-loop (AC/Case ِ تکراری)؛ هر دو منتظر ِ انسان', () => {
  const clarification = { blocker: { kind: 'needs-human', stage: 'reviewer-clarification', detail: 'سؤال ِ خلاصه‌شده' } };
  const loop = { blocker: { kind: 'needs-human', stage: 'rejection-loop', detail: 'Reviewer دو بار پشت‌سرهم با ِ همان مشکل رد کرد (AC-1، TC-R2).' } };
  const events = [{ event: 'review.needs-clarification', attempt: '004', question: 'آیا TC-R1 را باید انسان بسنجد؟' }, { event: 'review.rejection-loop', failures: ['AC-1', 'TC-R2'], attempt: '006', previousAttempt: '005' }];
  for (const [t, ev] of [[clarification, null], [clarification, events], [loop, events], [loop, null], [{ blocker: { kind: 'needs-human', stage: 'other' } }, null], [{ blocker: { kind: 'environment' } }, null], [{}, null]]) {
    assert.deepEqual(view.needsHumanInfo(t, ev), ts.needsHumanInfo(t, ev));
  }
  assert.equal(ts.needsHuman(clarification), true);
  assert.equal(ts.needsHuman({ blocker: { kind: 'environment' } }), false);
  assert.equal(ts.needsHumanInfo({ blocker: { kind: 'environment' } }), null);

  const c = ts.needsHumanInfo(clarification, events);
  assert.equal(c.title, 'Reviewer سؤال دارد');
  assert.equal(c.text, 'آیا TC-R1 را باید انسان بسنجد؟', 'متن ِ کامل از رویداد');
  assert.match(c.guide, /یادداشت بنویس \(note\) و بعد unblock/);
  assert.equal(ts.needsHumanInfo(clarification, null).text, 'سؤال ِ خلاصه‌شده', 'بدون رویداد: detail ِ blocker');
  const l = ts.needsHumanInfo(loop, events);
  assert.match(l.title, /دو بار پشت‌سرهم با همان مشکل رد کرد/);
  assert.deepEqual(l.failures, ['AC-1', 'TC-R2']);
  assert.equal(ts.needsHumanInfo(loop, null).failures, null);

  const lines = view.needsHumanLines(view.needsHumanInfo(loop, events), '10024', { reevaluate: true }).join('\n');
  assert.match(lines, /منتظر ِ انسان، نه خطای فنی/);
  assert.match(lines, /AC\/Case ِ تکراری: AC-1، TC-R2/);
  assert.match(lines, /barsa reevaluate-review 10024 --reason/);
  assert.match(lines, /barsa answer 10024 --note --stdin · بازگشایی: barsa answer 10024 --unblock/);
  assert.doesNotMatch(view.needsHumanLines(view.needsHumanInfo(loop, null), '10024').join('\n'), /reevaluate-review/, 'بدون actions.reevaluateReview پیشنهاد نمی‌شود');
  assert.match(view.needsHumanLines(view.needsHumanInfo(clarification, null), '5').join('\n'), /جواب: barsa answer 5 --note --stdin {2}← بعد: barsa answer 5 --unblock/);
  assert.deepEqual(view.needsHumanLines(null, '5'), []);
});

test('رویدادهای ۰۵۱: متن ِ کوتاه ِ فارسی (lint، base، changeset، review، budget)؛ هر دو نسخه یکی', () => {
  const events = [
    { event: 'baseline.lint-debt-in-scope', totalErrors: 7, commands: ['ng lint x'], files: [{ file: 'a.ts', errors: [] }, { file: 'b.ts', errors: [] }], budgetConsumed: 'none' },
    { event: 'base.refreshed', branch: 'agent/7', oldBase: 'aaaaaaaa11112222', newBase: 'bbbbbbbb33334444', reason: 'retry-at-worktree-baseline', installInputsChanged: true },
    { event: 'base.refreshed', oldBase: 'aaaaaaaa11112222', newBase: 'bbbbbbbb33334444', installInputsChanged: false },
    { event: 'base.refresh-skipped', branch: 'agent/7', oldBase: 'a', currentBase: 'b', reason: 'شاخه commit ِ منحصربه‌فرد دارد' },
    { event: 'external.changeset-declared', source: 'webiii', changesets: ['C17800', 'C17803'], previous: ['C17792'], replaced: true, reason: 'checked in later' },
    { event: 'external.changeset-declared', source: 'webiii', changesets: ['17800'], previous: null, replaced: false },
    { event: 'review.needs-clarification', attempt: '004', question: 'آیا TC-R1 دستی است؟', budgetConsumed: 'none' },
    { event: 'review.rejection-loop', attempt: '006', previousAttempt: '005', failures: ['AC-1', 'TC-R2'], route: 'implementer', budgetConsumed: 'none' },
    { event: 'review.outcome-inconsistent', attempt: '004', outcome: 'approved', requestedTransition: 'rejected', budgetConsumed: 'reviewerRuns', problems: ['خروجی ناسازگار'] },
    { event: 'review.manual-case-by-reviewer', attempt: '004', cases: ['TC-R1', 'TC-R2'] },
    { event: 'budget.refunded', field: 'implementerRuns', amount: 2, from: 0, to: 2, attempts: ['003', '004'] },
    { event: 'review.re-evaluated', attempt: '004', decision: 'approved', refundedAttempts: ['003'], manualCases: ['TC-R1'], implementerRan: false, reason: 'tool-only rejections' }
  ];
  for (const e of events) assert.deepEqual(view.extrasEventText(e), ts.extrasEventText(e), e.event);
  const [lint, refreshed, refreshedPlain, skipped, declared, declaredNew, clarification, loop, inconsistent, manual, refunded, reevaluated] = events.map(e => ts.extrasEventText(e));
  assert.match(lint.details, /^خطاهای lint ِ از قبل موجود در فایل‌های داخل scope به کار ِ Implementer اضافه شد \(7 خطا در 2 فایل\)$/);
  assert.equal(refreshed.details, 'worktree به base ِ تازه رفت: aaaaaaaa → bbbbbbbb · نصب ِ وابستگی‌ها دوباره انجام می‌شود');
  assert.equal(refreshedPlain.details, 'worktree به base ِ تازه رفت: aaaaaaaa → bbbbbbbb');
  assert.match(skipped.details, /base ِ worktree جلو نرفت: شاخه commit ِ منحصربه‌فرد دارد/);
  assert.equal(declared.details, '«webiii»: C17800، C17803 (جایگزین ِ C17792) · checked in later');
  assert.equal(declaredNew.details, '«webiii»: C17800');
  assert.match(clarification.details, /attempt 004 · budget مصرف نشد · آیا TC-R1 دستی است؟/);
  assert.equal(loop.details, 'attempt 005 و 006 · AC-1، TC-R2 · budget مصرف نشد');
  assert.match(inconsistent.details, /outcome=approved با requestedTransition=rejected نمی‌خواند؛ دوباره سنجیده می‌شود · خروجی ناسازگار/);
  assert.match(manual.details, /^TC-R1، TC-R2 — رد حساب نشد/);
  assert.equal(refunded.details, 'implementerRuns: 0 → 2 (2 برگشت)');
  assert.match(reevaluated.details, /^attempt 004 · Implementer اجرا نشد · Case ِ دستی: TC-R1 · tool-only rejections$/);
  assert.match(reevaluated.label, /بدون اجرای Implementer/);
  // typeSource ِ تازه‌ی Caseهای دستی فقط رشته‌اند؛ چک‌لیست رفتار ِ قبلی را دارد
  const legacy = { awaitingHuman: { kind: 'merge-approval' }, tests: { format: 'legacy', autoCases: [], manualCases: [{ id: 'TC-R1', section: null, summary: 'x', typeSource: 'legacy-alias' }, { id: 'TC-R2', section: null, summary: 'y', typeSource: 'override' }, { id: 'TC-R3', section: null, summary: 'z', typeSource: 'legacy-row' }], problems: [] } };
  assert.equal(ts.manualChecklist(legacy).items.length, 3);
});

test('actions ِ تازه: run و reevaluateReview شناخته‌شده‌اند؛ دکمه‌ی reevaluate-review در ops؛ run در ops نیست (فوتر)', () => {
  assert.ok(KNOWN_ACTION_KEYS.includes('run') && KNOWN_ACTION_KEYS.includes('reevaluateReview'));
  assert.equal(ACTION_PLACEMENT.run, 'run');
  assert.equal(ACTION_PLACEMENT.reevaluateReview, 'ops');
  const t = { actions: { run: true, reevaluateReview: true, unblock: true } };
  assert.deepEqual(unknownActionKeys(t), [], 'run نباید «ناشناخته» حساب شود');
  assert.deepEqual(opsButtons(t).map(b => b.id), ['reevaluate-review', 'unblock']);
});

test('رابط کاربری ۰۵۱: دکمه‌ی اجرا فقط از actions.run؛ needs-human در «منتظر انسان»؛ سنجش ِ دوباره‌ی review؛ story؛ changeset', () => {
  const html = read('../../client/src/app/app.component.html');
  assert.match(html, /\|\| !runOk\(t\)" \[title\]="runTitle\(t\)" \(click\)="runTask\(\)"/);
  assert.match(html, /class="run-blocked"[^>]*>اجرا ممکن نیست — \{\{ runReason\(t\) \}\}/);
  assert.match(html, /openTask\(t, !isNeedsHuman\(t\)\)/);
  assert.match(html, /<ba-external-changeset /);
  const app = read('../../client/src/app/app.component.ts');
  assert.match(app, /filter\(t => \(!!t\.awaitingHuman \|\| needsHuman\(t\)\) && !t\.error\)/, 'human strip');
  assert.match(app, /t\.state === 'blocked' && !t\.error && !needsHuman\(t\)/, 'مسدود ِ فنی ِ بدون needs-human');
  assert.match(app, /runOk\(t: Task \| null\): boolean \{ return !t \|\| \(runInfo\(t\)\?\.allowed \?\? true\); \}/, 'Manager ِ قدیمی: رفتار ِ قبلی');
  const ops = read('../../client/src/app/task-ops.component.ts');
  assert.match(ops, /سنجش دوباره‌ی review \(بدون اجرای Implementer\)/);
  assert.match(ops, /اگر ردهای اخیر فقط به‌خاطر Case ِ دستی یا یک خطای ابزاری بوده، تسک بدون اجرای دوباره‌ی Implementer به review یا دروازه‌ی merge می‌رسد، و budget ِ سوخته برمی‌گردد\./);
  assert.match(ops, /spdd-line/);
  assert.match(ops, /منتظر ِ تو \(خطای فنی نیست\)/);
  const cs = read('../../client/src/app/external-changeset.component.ts');
  assert.match(cs, /--replace/);
  assert.match(cs, /\[disabled\]="!f\.declared\.length"/, 'جایگزینی فقط با مقدار ِ قبلی');
  assert.match(cs, /confirmReplace/, 'تأیید ِ دوم');
  assert.match(cs, /changeset ثبت نشده/);
});
