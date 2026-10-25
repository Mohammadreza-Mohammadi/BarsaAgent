# BarsaAgent v1.2 — Implementation Notes

## Source baseline

Built from BarsaAgent v1.1.3 and integrated with `docs/reference/create-task-flow.md`.

## Major changes

- No protocol patch files; Manager remains external.
- New `/api/tasks/create` accepts confirmed task drafts.
- Import payload: `repo/type/slug/requestText/source?`.
- Manual task creation supported by omitting `source`.
- Sequential imports; one failure does not stop later items.
- Global run queue with configurable `maxConcurrent`.
- `autoStartOnCreate` and `autoResumeAfterAnswer`.
- Clarification answer uses temp UTF-8 file and `--clarify --file`.
- Merge rejection supports `--route implementer|architect`.
- Health endpoint invokes `npm run validate-agent-work --silent` and returns persistent status to UI.
- Issue adapter supports POST JSON/form, current UserId, and double-serialized JSON response.
- Issue mapping updated to `externalId/title/body/url/status/labels` with fallback mapping.
- UI has issue stepper/create draft, manual task, queued badge, merge evidence, health status.

## Test status

`node --test server/test/*.test.js`: 16 passed, 0 failed.

Coverage includes:
- CLI-only board/task/events
- artifact traversal rejection
- duplicate run rejection
- SSE replay/token masking
- POST issue JSON/form
- double-serialized issue response
- create + auto-start
- clarification file + auto-resume
- import failure isolation
- maxConcurrent queue
- Manager Contract handshake

## Build note

The execution container has Node 22.16.0 while Angular 22 package metadata in this project requires Node `^22.22.3 || ^24.15.0 || >=26`. Server tests are valid; perform the final Angular build on a supported Node version.


## v1.2.1 — Health UI fix

- Health null/loading دیگر به‌عنوان failure نمایش داده نمی‌شود.
- Health fetch از board/running مستقل شد.
- معیار سالم بودن validator فقط exit code است؛ warningهای stdout سبز را قرمز نمی‌کنند.
- خطای خود endpoint سلامت از failure واقعی Agent-work جدا نمایش داده می‌شود.

## Phase 1 — Kanban as the human's only interface (no shell)

New server modules: `tokenizer.js`, `console-parser.js`, `audit.js`, `auth.js`, `action-runner.js`, `process-tools.js`,
`git-ops.js`, `manager-update.js`, `manager-help.js`, `repo-idle.js`, `env-health.js`, `zip.js`, `routes-ops.js`.
Existing typed endpoints now run through the audited runner. Item «ی» (export bundle, TOOLING-035) was NOT started: it is
gated on the user confirming TOOLING-035 is merged into Manager. See README «کانبان فاز ۱» and `docs/server-service.md`.

## 1.2.2 — Windows health fix
- Health validator با `node scripts/validate-agent-work.js` اجرا می‌شود، نه `npm.cmd`.
- warning/known-exception با exit code صفر سالم محسوب می‌شود.
- تست integration برای warning روی stdout/stderr با exit code 0 اضافه شد.

## Remote Control کامل (بدون RDP): دیدن، تشخیص، رفع گیر

اصل ثابت: Claude ِ Remote Control شل ِ آزاد ندارد؛ هر توان تازه یک فرمان **نام‌دار** `barsa` است با endpoint ِ خودش در فهرست بسته‌ی
`REMOTE_ENDPOINTS` (remote-cli-spec.js) و یک ردیف ممیزی با actor ِ `remote:<name>`. جزئیات و جدول endpointها: docs/remote-control/README.md.

- ماژول‌های تازه: `remote-ops-routes.js` (همه‌ی endpointهای تازه)، `diag.js` + `diag-format.js` (جمع‌آوری و قالب ِ متنی ِ `barsa diag`)،
  `process-list.js` (عکس فرآیندها: Win32_Process / ps، درخت، تشخیص `npm ci`)، `remote-artifacts.js` (فهرست بسته‌ی نام artifact)،
  `remote-waiting.js` (بخش «منتظر تو» در `barsa task`)، `bundles.js` (zip ِ پوشانده‌شده در <dataDir>/bundles).
- artifact از راه `manager.js artifact`/`events` خوانده می‌شود، نه فایل مستقیم؛ نام از فهرست بسته، مسیر هرگز از کاربر نمی‌آید.
- `kill-stuck-install`: ریشه‌ی درخت **فقط** pid ِ ثبت‌شده در registry ِ کانبان برای همان تسک است؛ هدف = فرزندان مستقیم ِ یک `npm ci` ِ داخل
  همان درخت که بیش از N دقیقه عمر دارند؛ درست پیش از بستن یک عکس ِ تازه می‌گیرد (pid + زمان شروع باید برابر باشد). بستن با `killProcessTree` ِ موجود.
- redactor: الگوهای تازه (Bearer با فاصله، `--password x`، PEM، AKIA، `user:pass@`) و نام متغیرهای تازه (`USER_ID`، `CREDENTIAL`، `COOKIE`، …)؛ در
  diag اول redact و بعد clip می‌شود تا راز با بریدن فرار نکند.
- `sync` در settings.json: ask بر allow می‌چربد (deny ← ask ← allow)؛ پس ask فقط `Bash(./barsa sync)` ِ دقیق است و allow فقط
  `sync --dry-run` و `sync --status` (ثابت `READ_FORMS`).
- config ِ اختیاری: `logs.errFile` (مسیر kanban.err.log برای `diag --system`؛ پیش‌فرض `<پوشه‌ی برنامه>-logs/kanban.err.log`).
