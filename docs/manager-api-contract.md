# BarsaAgent Manager Contract v1 — Workflow Integration

این سند مرز رسمی بین BarsaAgent و Agent Protocol است. BarsaAgent مالک `manager.js`، `run-agent.js`، `verify.js` یا `.agent-work` نیست.

## مرز مالکیت

```text
Angular UI -> BarsaAgent Node -> manager.js -> run-agent.js / verify.js / git / .agent-work
```

BarsaAgent فقط CLI عمومی Manager را صدا می‌زند. هیچ write مستقیمی در `.agent-work` و هیچ اجرای git ندارد.

## Capability handshake

```bash
node scripts/manager.js capabilities --json
```

حداقل:

```json
{
  "contract": "barsa-agent-manager",
  "contractVersion": 1,
  "managerVersion": "1.0.0",
  "capabilities": {
    "status": { "base": true, "verify": true, "review": true, "health": true },
    "taskStatus": true,
    "events": true,
    "artifact": true,
    "run": true,
    "answer": { "approve": true, "reject": true, "clarify": true, "respec": true },
    "importIssue": true,
    "cancel": true,
    "abandon": true,
    "void": true,
    "rebase": true
  }
}
```

`status` می‌تواند شکل قدیمی‌تر (بولین `true`) هم باشد — `status.base` همان معنا را می‌دهد و فقط این شکل additive است. `status.verify`/`status.review`/`status.health` می‌گویند کدام‌یک از سه فیلد additive فاز ۲ (پایین‌تر) واقعاً پر می‌شوند؛ UI باید غیابشان را از «این Task شواهدی ندارد» تشخیص بدهد، نه با سکوت یکسان رفتار کند.

## Status

```bash
node scripts/manager.js status --json
node scripts/manager.js status --json --task <id>
```

`awaitingHuman` field است، نه state. یک task خراب باید با `error` در خروجی دیده شود و کل board را نشکند.

`repo.mergedBy` مقدار `"manager" | "human"` دارد. پنل `merge-approval` باید متن، فرمان دستی، checkbox و دکمهٔ تأیید را فقط از همین مقدار شاخه‌بندی کند؛ فرض hardcode‌شده مجاز نیست.

`task.source` (`{ system, externalId, url, fetchedAt } | null`) وابستگی ضمنی‌ای دارد که باید اینجا صریح باشد: `GET /api/issues` در BarsaAgent برای تشخیص این‌که کدام Issueهای صندوق ورودی قبلاً import شده‌اند، `board.tasks[].source.externalId` را با `issue.externalId` مقایسه می‌کند (`server/src/app.js`). اگر `source` غایب/نادرست باشد، یک Issue می‌تواند دوباره import شود بدون این‌که UI متوجه شود قبلاً ساخته شده.

### افزوده‌های additive فاز ۲ (اختیاری، backward-compatible)

سه فیلد زیر بخشی از Contract v1 اصلی نبودند؛ مصرف‌کننده‌ای که نمی‌شناسدشان باید نادیده‌شان بگیرد و contractVersion عوض نشده. منبع رسمی شکل دقیق‌شان دیگر این توضیح دستی نیست — **JSON Schema + fixture واقعی + تست drift** در مخزن پروتکل:

```text
docs/agents/shared/status-json.schema.json     — JSON Schema رسمی (task/errorTask/epic/verify/review/health)
docs/agents/shared/status-json.fixture.json    — task 0003 واقعی + سه Task ساختگی که چهار شاخه‌ی evidence-کامل/malformed/گیت-غیرفعال/قفل-pid:null را می‌پوشانند
scripts/manager.status-json-schema.test.js     — خروجی زنده‌ی status --json را با همان schema می‌سنجد
```

خلاصه (برای مرجع سریع؛ برای شکل دقیق همیشه schema بالا را باور کن، نه اینجا):

- `verify: { build: string[], test: string[], lint: string[], disabled: [{ gate, reason }] } | null` — همان `verify:` که Architect در manifest نوشته؛ آرایه‌ی خالی یک گیت یعنی برای این پروژه در `repository.yaml` غیرفعال است.
- `review: { attempt, decision, evidence, inconsistentWithReviewMd, evidenceStatus, malformed, problems } | null` — فقط وقتی آخرین attempt یک داوری reviewer با `result.yaml` دارد. `evidenceStatus` منبع اصلی است: `'missing'` یعنی Reviewer بلوک `evidence:` ساختاریافته اصلاً ننوشته (Task قدیمی‌تر از این قرارداد — بی‌خطر؛ Taskهای واقعی 0001..0003 دقیقاً همین حالت‌اند)؛ `'malformed'` یعنی `evidence:` هست ولی خراب/ناقص است (واقعاً نیاز به بررسی). این دو را قاطی نکن — `malformed` (بولین) فقط روی حالت دوم true است، وگرنه Taskهای قدیمی برای همیشه قرمز می‌مانند و چشم یاد می‌گیرد نشان را نادیده بگیرد.
- `health: { transitionLock, dirtyPaths: string[], stuck: boolean, stuckReasons: string[], recovery }` — **همیشه یک object است، هرگز `null` نیست** (نبود قفل به‌تنهایی به‌معنای سالم بودن نیست؛ `dirtyPaths`/`stuck` مستقل از وجود قفل محاسبه می‌شوند). کار هر Task در `../agent-worktrees/<id>-<slug>` است، **بیرون از REPO_ROOT**؛ `dirtyPaths` هم شامل تغییرات bookkeeping در `.agent-work/tasks/<id>/` می‌شود هم تغییرات واقعی worktree (پیشوند `worktree:` دارند) — یک `git status` دیگر، جدا، به‌ازای هر worktree *یکتا*ی زنده اجرا می‌شود (نه per-task). `transitionLock: { pid: number|null, alive: boolean|null, fromState, startedAt } | null` — `pid`/`alive` وقتی قفل pid ندارد یا روی host دیگری نوشته شده `null` می‌شوند («نمی‌دانم»، نه «زنده» و نه «مرده»). `stuckReasons` زیرمجموعه‌ای از `["stale-lock", "dirty-worktree"]` است؛ **هرگز از مدت‌زمان در state گرفته نمی‌شود** — یک task پشت گیت انسانی منتظر توست، گیر نکرده. `"no-progress"` عمداً در این لیست نیست: سیگنالش واقعی و قابل‌اعتماد است (کد خروج ۳۰ از `run`) ولی جایش `status --json` نیست — نتیجه‌ی یک اجرا است، نه بخشی از حالت manifest؛ BarsaAgent همین الان از `EXIT_LABELS[30]` می‌خواندش. این یک شکاف نیست، تصمیم است.
- `health.recovery: { suggested: "unlock" | "run" | null, reason: string | null, commands: string[] }` — «بازیابی از داخل ابزار»: Manager پیشنهاد قدم بعدی را حساب می‌کند، UI فقط نشان می‌دهد (اگر UI خودش از روی `stuckReasons` نتیجه‌گیری کند، یک نسخه‌ی دوم منطق بازیابی می‌شود که drift می‌کند). `"reset"` عمداً هیچ‌وقت اینجا نیست — رد شد (حادثه‌ی ۲۶ سپتامبر: `run` خودش قفل کهنه‌ی pid-مرده را بی‌کمک انسان پس می‌گیرد). برای stateهای نهایی (`cancelled`/`abandoned`/`integrated`) همیشه `suggested: null` است، حتی اگر قفل جامانده‌ای هم روی آن باشد — یک Task تمام‌شده هرگز نباید پیشنهاد `run` بگیرد.
- `repository: { health: { managerLock, unownedDirtyFiles: string[], acceptsOperations: boolean } }` — سطح **کل مخزن**، نه یک Task خاص (حادثه‌ی ۲۶ سپتامبر، بند «د»: `.manager.lock` و کثیفی بی‌صاحب `BOARD.md` قبلاً هیچ‌جا دیده نمی‌شدند). `managerLock: { pid, alive, task, startedAt } | null` — همان شکل `transitionLock` ولی برای قفل سراسری (`.agent-work/.manager.lock`)؛ `task` می‌گوید کدام Task را داشت می‌نوشت. `unownedDirtyFiles` مسیرهای کثیفی‌اند که زیر هیچ taskDir شناخته‌شده‌ای نیستند. `acceptsOperations: false` یعنی الان یک `run`/`answer`/... تازه رد می‌شود (قفل سراسری زنده یا نامشخص است).

Capability handshake متناظر (بخش پایین‌تر همین سند) می‌گوید کدام‌یک از این سه را این نسخه‌ی Manager واقعاً می‌دهد؛ غیابشان در `status --json` می‌تواند یعنی «این Task هنوز داده ندارد» یا «این Manager هنوز نمی‌دهد» — تشخیصش با capability است، نه با حدس زدن روی خودِ `null`.

## Events

```bash
node scripts/manager.js events <id> --json
```

## Artifact

```bash
node scripts/manager.js artifact <id> --path <relative-path>
```

stdout متن خام artifact. Manager و Server هر دو traversal را محدود می‌کنند.
در گیت `merge-approval`، مسیر `changes.diff` یک snapshot commit‌شده و متعلق به `git.headCommit` همان گیت است؛ UI نباید diff زنده بسازد. رندر UI به ۲۰۰۰ خط محدود می‌شود، اما خلاصهٔ فایل‌ها کامل می‌ماند.

## Import / Create task

BarsaAgent برای هر task یک فایل موقت UTF-8 می‌سازد و ترتیبی اجرا می‌کند:

```bash
node scripts/manager.js import-issue --file <tmp.json>
```

Issue-backed task:

```json
{
  "repo": "barsa-novin-ray",
  "type": "task",
  "slug": "hex-color-parsing",
  "requestText": "متن خامی که انسان تأیید کرده",
  "source": {
    "system": "internal",
    "externalId": "2041",
    "url": "https://...",
    "fetchedAt": "2026-09-06T09:12:00Z"
  }
}
```

Manual task همان payload است ولی `source` ندارد. Manager شناسه ترتیبی را اختصاص می‌دهد.

Manager باید stdout JSON بدهد:

```json
{ "ok": true, "taskId": "2041" }
```

`requestText` باید عیناً `request.md` شود. Import تکراری `source.externalId` باید رد شود.

## Run

```bash
node scripts/manager.js run <id>
```

long-running، بدون `--json` و با stdout/stderr زنده.

| code | معنی |
|---:|---|
| 0 | integrated |
| 10 | awaitingHuman |
| 20 | stopped/blocked |
| 30 | no progress / handler bug |
| 1 یا سایر | execution error |

سقف همزمانی و queue در BarsaAgent Node است؛ Manager همچنان باید اجرای همزمان نامعتبر همان task را نیز امن مدیریت کند.

## Answer — approve

```bash
node scripts/manager.js answer <id> --approve
```

برای spec approval و merge approval.

## Answer — reject

متن دلیل رد هرگز در argv قرار نمی‌گیرد — کنسول ویندوز فارسی paste‌شده را به `???` می‌شکند و Manager متنی با `??` که از فایل نیامده را رد می‌کند. BarsaAgent همیشه فایل موقت UTF-8 می‌سازد:

Spec rejection:

```bash
node scripts/manager.js answer <id> --reject --reason-file <tmp.txt>
```

Merge rejection به implementer (نقشه درست بود، اجرا نه؛ `implementerRuns` مصرف می‌شود):

```bash
node scripts/manager.js answer <id> --reject --reason-file <tmp.txt> --route implementer
```

Merge rejection به architect (نقشه غلط بود؛ budget پیاده‌سازی دست نمی‌خورد):

```bash
node scripts/manager.js answer <id> --reject --reason-file <tmp.txt> --route architect
```

## Answer — clarification

پاسخ clarification هم هرگز در argv قرار نمی‌گیرد. BarsaAgent فایل موقت UTF-8 می‌سازد:

```bash
node scripts/manager.js answer <id> --clarify --file <tmp.txt>
```

محتوای فایل همان پاسخ انسان است. این چرخه طبق protocol budget مصرف نمی‌کند.

اگر پاسخ خودِ spec را عوض می‌کند (نه فقط رفع ابهام)، `--respec` اضافه می‌شود؛ گیت `spec-approval` دوباره باز می‌شود چون Intake از نو اجرا شده:

```bash
node scripts/manager.js answer <id> --clarify --file <tmp.txt> --respec
```

## Void / Cancel / Rebase / Unlock

چهار فرمان synchronous دیگر، هم‌الگوی `answer` (نه از طریق صف اجرای long-running):

```bash
node scripts/manager.js void <id> --reason-file <tmp.txt>
node scripts/manager.js cancel <id> --reason-file <tmp.txt>
node scripts/manager.js rebase <id>
node scripts/manager.js unlock <id> --reason-file <tmp.txt> [--force]
```

`void` آخرین transition این task را برمی‌گرداند؛ `cancel` task را می‌بندد؛ هر دو دلیل اجباری دارند و از همان قاعده‌ی فایل موقت پیروی می‌کنند. `rebase` دلیل نمی‌خواهد — معمولاً لازم نیست چون حلقه خودش وقتی base جلو رفته صدایش می‌زند؛ دکمه‌اش در UI برای حالت‌های استثنایی است.

`unlock` («بازیابی از داخل ابزار») فقط `.transition.lock` همین Task را آزاد می‌کند — manifest، worktree، تاریخچه دست‌نخورده می‌مانند. دلیل اجباری است. رد می‌شود اگر pid روی همین ماشین زنده باشد؛ برای قفل کهنه‌ی معمولی (pid مرده) هم لازم نیست — `run` خودش پس می‌گیرد (`health.recovery.suggested` در این حالت `"unlock"` نیست، `"run"` است). `--force` فقط وقتی لازم است که `transitionLock.alive === null` باشد (pid/hostname نامعتبر) — تنها حالتی که Manager واقعاً نمی‌تواند خودش تصمیم بگیرد. `reset` عمداً وجود ندارد (رد شد در حادثه‌ی ۲۶ سپتامبر).

## Auto resume

بعد از answer موفق، BarsaAgent در صورت `run.autoResumeAfterAnswer: true` دوباره `run <id>` را enqueue می‌کند. Manager نباید نیازمند کلیک یا فرمان دیگری از UI باشد.

## Health

BarsaAgent برای status bar این اسکریپت read-only را مستقیم با همان Node فعلی اجرا می‌کند — نه از طریق `npm.cmd` (روی ویندوز با `shell:false` قابل‌اعتماد نیست):

```bash
node scripts/validate-agent-work.js
```

کد خروج و stdout/stderr در UI نمایش داده می‌شود. UI هیچ‌وقت مستقیم فایل قفل یا git را دست نمی‌زند — تنها راه آزادسازی یک قفل، فرمان `unlock` بالا از طریق Manager است (پنل بازیابی، «بازیابی از داخل ابزار»)، نه دکمه‌ای که فایل را پاک کند.

## JSON discipline

فرمان‌های `capabilities/status/events` روی stdout فقط JSON معتبر می‌دهند. diagnostic روی stderr. `run` استثناست و برای log زنده خروجی انسانی دارد.
