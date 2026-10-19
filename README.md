# BarsaAgent v1.2

کنسول محلی Angular + Node برای اداره Agent Protocol از طریق `manager.js` خارجی.

## کانبان فاز ۱: همه‌ی کارهای انسان بدون شل

انسان همه‌ی کارهایی را که قبلاً در PowerShell می‌کرد از همین کنسول انجام می‌دهد (سرور ممکن است شل نداشته باشد).

**اصل امنیتی: کانبان شل وب نیست.** هیچ ورودی کاربر به shell نمی‌رسد؛ فقط `spawn`/`execFile` با آرایه‌ی آرگومان.
برنامه‌های مجاز: `node scripts/manager.js` و فهرست بسته‌ی git (و برای آزمون جداسازی، `pwsh`/`powershell` با آرگومان
ثابت؛ برای سلامت محیط، `claude`؛ برای به‌روزرسانی `node npm-cli.js ci`).

- **ورود اجباری** (حساب محلی + کوکی HttpOnly/SameSite=Strict + توکن CSRF). هر endpoint زیر `/api/` بدون ورود 401 می‌دهد.
  سرور پیش‌فرض فقط روی `127.0.0.1` گوش می‌دهد. حساب بساز: `npm run user:add -- <نام>`.
- **دفتر ممیزی** append-only (JSON lines) بیرون از مخزن‌ها: کاربر، زمان، argv، cwd، exit code، مدت، مسیر خروجی کامل؛
  اکشن ردشده هم رکورد `rejected` دارد. صفحه‌ی «ممیزی» فقط‌خواندنی است.
- **کنسول Manager:** یک خط paste می‌شود؛ tokenizer کوتیشن را می‌فهمد ولی `$`، `;`، `|`، `&`، `>`، `<` و backtick بیرون از
  کوتیشن را رد می‌کند. زیرفرمان از `manager.js --help` می‌آید. `--file/--reason-file/--release-note-file` از textarea
  پر می‌شوند (فایل UTF-8 موقت). فرمان تغییردهنده پنجره‌ی تأیید با فرمان نهایی دارد؛ `run` از صف و env ِ `buildAgentEnv` می‌گذرد.
- **کارت task:** توقف (فقط درخت فرآیند اجرای خود کانبان)، لاگ هر اجرا + دانلود، zip ِ پوشه‌ی task، abandon، unblock،
  raise-limit، close-orphan، و برای `rebase-conflict` فقط «دوباره امتحان کن» و «کنار بگذار».
- **نگهداری مخزن ابزار:** ساخت worktree، آزمون جداسازی، ادغام (فقط با PROVEN ِ همان commit و درخت تمیز)، حذف worktree و
  شاخه (`-d`)؛ به‌روزرسانی Manager از origin (`--ff-only`، با پیش‌شرط بیکار بودن).
- **سلامت محیط:** node، git، claude و احراز هویتش، پروکسی (با درخواست آزمایشی)، pwsh، مسیرها، دیسک، حساب‌ها.

پیکربندی نمونه (بخش‌های تازه؛ همه اختیاری‌اند):

```yaml
server:
  port: 4310
  host: 127.0.0.1            # پیش‌فرض؛ فقط با TLS proxy عوض کن
dataDir: "D:/barsa-agent-data"   # بیرون از هر مخزن
auth:
  sessionTtlMinutes: 480
  secureCookie: false        # پشت HTTPS: true
  allowedOrigins: []
run:
  stopGraceMs: 5000          # مهلت بین taskkill /T و taskkill /T /F
health:
  proxyTestUrl: "https://api.anthropic.com/"
  claude: { command: "claude" }   # اگر فقط claude.cmd هست: مسیر claude.exe
repos:
  - id: barsa-novin-ray
    path: "C:/ng-web-systemsaz-1"
    managerScript: "scripts/manager.js"
    tooling:
      worktreesDir: "C:/ng-web-tools"
      shadowPath: "C:/agent-shadow"
      webiiiPath: "C:/BarsaTFS/Framework/Releases/Release-4.01/Source/Meta/WebIII"
```

اجرا به‌صورت سرویس ویندوز: `docs/server-service.md`.

## دکمه‌های کارت: فقط از `actions` (TOOLING-037)

«این اکشن الان مجاز است؟» را خود Manager می‌گوید (`status --json` ← `task.actions`، همان تابعی که handlerها پیش از اجرا می‌پرسند).
کانبان هیچ نسخه‌ی دومی از این منطق ندارد: نه از روی state، نه `blocker`، نه `awaitingHuman`. منطق خالص در
`client/src/app/task-actions.ts` است (`can`، `allowed`). دکمه‌ها: approve/reject/clarify، note، unblock، raise-limit (هفت فیلد)،
close-orphan (از آرایه)، allow-path، allow-shared-knowledge-file، external-access و reset-external (منبع از آرایه؛ `--to` اختیاری)،
void، unlock، cancel، abandon. کنار `--clarify` اگر `actions.externalAccess` غیرخالی باشد یک انتخاب اختیاری `--external-access` هست.
`actions` غایب (Manager قدیمی) = هیچ دکمه‌ای. کارت `rebase-conflict` فایل‌ها را از `blocker.conflictFiles` نشان می‌دهد و zip ِ پوشه‌ی task
فقط از `task.dir` ساخته می‌شود (حدس از id/slug نیست). `status --json` در اولین اجرا تا ~۱۵ ثانیه طول می‌کشد: poll ِ بعدی تا تمام
شدن قبلی شروع نمی‌شود و سرور درخواست‌های هم‌زمان را به یک اجرای Manager تبدیل می‌کند.

## برد و آرشیو

taskهای `integrated`، `cancelled` و `abandoned` از ستون‌های برد بیرون‌اند. ستون «تمام» فقط taskهای `integrated` را که در
`board.doneDays` روز اخیر (پیش‌فرض ۳، از `stateSince`) پایان یافته‌اند نشان می‌دهد و زیرش پیوند «همه (n) در آرشیو» است. `blocked` در
بخش جدای خودش روی برد می‌ماند. تب «آرشیو» جدول فشرده با جست‌وجو (عنوان/شماره)، فیلتر state و بازه‌ی تاریخ، مرتب‌سازی (پیش‌فرض
جدیدترین بالا) و صفحه‌بندی است؛ کلیک روی ردیف کشوی جزئیات (رویدادها، شواهد، zip) را باز می‌کند و برای task پایان‌یافته هیچ دکمه‌ی
اکشنی ندارد. «پایان‌یافته» فقط از یک فهرست (`FINISHED_STATES` در `client/src/app/task-archive.ts`) می‌آید. آخرین تب (برد/آرشیو) در
`localStorage` می‌ماند.

```yaml
board:
  doneDays: 3
```

## Health status

نوار سلامت Agent-work سه حالت مستقل دارد:

- `در حال بررسی Agent-work…` — هنوز نتیجهٔ validator دریافت نشده است.
- `Agent-work سالم` — فرمان `npm run validate-agent-work` با exit code صفر تمام شده است؛ پیام‌های `ℹ️` و `⚠️` داخل stdout به‌تنهایی خطا محسوب نمی‌شوند.
- `Agent-work نیاز به بررسی دارد` — validator با exit code غیرصفر تمام شده است و خروجی خام در نوار نمایش داده می‌شود.

اگر خود endpoint سلامت قابل دسترس نباشد، UI به‌جای ناسالم اعلام کردن Agent-work، `بررسی Agent-work انجام نشد` را نمایش می‌دهد.


## معماری

```text
Angular UI
   │ HTTP/SSE
   ▼
BarsaAgent Node (127.0.0.1)
   │ Manager Contract v1
   ▼
C:/ng-web-systemsaz-1/scripts/manager.js
   │
   ├─ run-agent.js
   ├─ verify.js
   ├─ git/worktree
   └─ .agent-work   ← source of truth
```

BarsaAgent `.agent-work` را فقط برای **خواندن** (دانلود zip ِ پوشه‌ی task) باز می‌کند و هرگز در آن نمی‌نویسد. git را فقط از
یک فهرست **بسته** از عملیات نگهداری مخزن ابزار اجرا می‌کند (بخش «کانبان فاز ۱»)؛ مسیر task/پروتکل همچنان فقط از
`manager.js` است.

## امکانات

- Kanban با polling سه‌ثانیه‌ای
- نوار «منتظر تو» برای gateهای انسانی
- ساخت task از Issue با stepper و ویرایش `requestText`
- task دستی بدون Issue
- import ترتیبی؛ شکست یک مورد بقیه را متوقف نمی‌کند
- Queue اجرای Manager با `maxConcurrent`
- `autoStartOnCreate`
- `autoResumeAfterAnswer` — بعد از هر answer موفق، run خودکار دوباره صف می‌شود
- **متن آزاد همیشه از فایل موقت UTF-8 می‌رود، هرگز argv** — clarify، دلیل رد (spec و merge)، دلیل void/cancel
- clarification با چک‌باکس `--respec`: تیک‌خورده یعنی spec عوض شده، گیت spec-approval دوباره باز می‌شود؛ تیک‌نخورده یعنی فقط رفع ابهام
- merge rejection با دو route مستقل: implementer / architect
- گیت merge-approval دو-مرحله‌ای: دستور `git merge --no-ff` آماده‌ی کپی + هشدار commitlint، بعد «merge کردم، ببند»؛ Manager هرگز خودش merge نمی‌کند
- evidence table داوری (`evidence.acceptance`/`testCoverage`/`additionalChecks`) و هشدار گیت‌های verification غیرفعال (مثل `lint: []`) در پنل merge
- headCommit اگر بعد از باز شدن گیت merge عوض شود (rebase خودکار)، پنل خودش را تازه می‌کند
- void/cancel/rebase دستی از UI، پشت تأیید دوم و دلیل اجباری
- نشان «گیرکرده» روی کارت وقتی `.transition.lock` جامانده باشد
- SSE + ring buffer لاگ
- mask کردن tokenها
- health bar از `npm run validate-agent-work`
- Issue WebService با POST و body JSON/form
- پشتیبانی از پاسخ double-serialized BarsaWebService
- جلوگیری از artifact path traversal
- Multi-repo

## تنظیم فعلی

```yaml
server:
  port: 4310

repos:
  - id: barsa-novin-ray
    path: "C:/ng-web-systemsaz-1"
    managerScript: "scripts/manager.js"

run:
  maxConcurrent: 2
  autoStartOnCreate: true
  autoResumeAfterAnswer: true

issueSource:
  baseUrl: "https://portal.barsasoft.com"
  listPath: "/api2/Issue/0.1/GetIssues"
  method: "POST"
  bodyFormat: "json"
  body:
    UserId: "${BARSA_ISSUE_USER_ID}"
  itemsPath: "data.items"
  mapping:
    externalId: "code"
    title: "title"
    body: "body"
    url: "url"
    status: "status"
    labels: "labels"
```

## جریان «ساخت task»

1. صندوق Issue → انتخاب یک یا چند مورد.
2. قبل از هر write، stepper باز می‌شود.
3. repo، slug، type و متن request قابل بررسی/ویرایش‌اند.
4. متن request عیناً به payload موقت می‌رود؛ UI AC یا template اضافه نمی‌کند.
5. Server برای هر draft، یکی‌یکی `manager.js import-issue --file <tmp>` را اجرا می‌کند.
6. اگر auto-start روشن باشد task موفق وارد queue می‌شود.
7. `run` تا اولین gate انسانی پیش می‌رود.
8. بعد از answer موفق، auto-resume task را دوباره enqueue می‌کند.

## Human gates

### spec-approval

نمایش `request.md` کنار `proposed-task.md`. دلیل رد هم از فایل موقت می‌رود:

```text
answer <id> --approve
answer <id> --reject --reason-file <tmp.txt>
```

### clarification

نمایش `questions.md` + `request.md` + `task.md`. پاسخ در فایل موقت UTF-8؛ چک‌باکس `--respec` کنار textarea:

```text
answer <id> --clarify --file <tmp.txt>
answer <id> --clarify --file <tmp.txt> --respec
```

### merge-approval

نمایش `review.md`، evidence table داوری (اگر Manager فیلد `review` را در status بدهد)، verification، diff در صورت وجود، scope، و هشدار هر گیت verification غیرفعال. تأیید دو-مرحله‌ای است: اول دستور `git merge --no-ff agent/<id>-<slug>` کپی می‌شود (merge کار انسان است، نه Manager)، بعد:

```text
answer <id> --approve
answer <id> --reject --reason-file <tmp.txt> --route implementer
answer <id> --reject --reason-file <tmp.txt> --route architect
```

اگر بعد از باز شدن گیت `headCommit` عوض شود (مثلاً rebase خودکار)، پنل خودش را تازه می‌کند و تأیید قبلی را باطل می‌داند.

### void / cancel / rebase

پشت یک تأیید دوم، دلیل اجباری برای دو تای اول:

```text
void <id> --reason-file <tmp.txt>
cancel <id> --reason-file <tmp.txt>
rebase <id>
```

## Queue

```yaml
run:
  maxConcurrent: 2
  autoStartOnCreate: true
  autoResumeAfterAnswer: true
```

Task اضافه با نشان «در صف» دیده می‌شود. هر task فقط یک run فعال/queued دارد. تلاش دوم 409 می‌گیرد.

## Issue WebService

درخواست فعلی:

```http
POST https://portal.barsasoft.com/api2/Issue/0.1/GetIssues
Content-Type: application/json

{"UserId":"<BARSA_ISSUE_USER_ID env>"}
```

`UserId` دیگر در `barsa-agent.config.yml` خام نیست — از `${BARSA_ISSUE_USER_ID}` جایگزین می‌شود (همان قاعده‌ی توکن‌ها، بازبینی فاز ۲):

مقدار در فایل محلی `.env.local` کنار `barsa-agent.config.yml` قرار دارد و هنگام خواندن تنظیمات خودکار بارگذاری می‌شود. این فایل در Git ثبت نمی‌شود. قالب آن:

```dotenv
BARSA_ISSUE_USER_ID=<your-user-id>
```

کلیدهای این فایل (فهرست از خود فایل خوانده می‌شود، در `config.localEnvKeys`) از env ِ فرزندان حذف می‌شوند: `buildAgentEnv` (run و به‌روزرسانی) و اجرای Manager از اکشن‌های کارت و کنسول. agent و Manager به آن‌ها نیازی ندارند.

اگر BarsaWebService یک string حاوی JSON را دوباره serialize کند، adapter inner JSON را خودکار parse می‌کند.

## اجرا

Node موردنیاز package فعلی:

```text
^22.22.3 || ^24.15.0 || >=26
```

سپس:

```powershell
npm ci
npm run check:manager
npm test
npm run dev:server
npm run dev:client
```

Server:

```text
http://127.0.0.1:4310
```

Angular dev server:

```text
http://localhost:4200
```

## تست

Server tests بدون Angular dependency قابل اجرا هستند:

```powershell
npm test
```

در نسخه تحویلی v1.2، 14 تست backend پاس شده‌اند؛ شامل POST Issue، double serialization، path traversal، double-run، SSE replay/masking، create+auto-start و clarification-file+auto-resume.

## فایل‌های مرجع

- `docs/manager-api-contract.md`
- `docs/agent-protocol-integration.md`
- `docs/reference/create-task-flow.md`

### Health روی Windows

از نسخه 1.2.2، Health Check دیگر `npm.cmd` را از child process اجرا نمی‌کند. Server مستقیماً `scripts/validate-agent-work.js` را با همان Node فعلی اجرا می‌کند. بنابراین اگر validator با exit code `0` تمام شود، وجود پیام‌های `ℹ️` یا `⚠️` در خروجی باعث ناسالم شدن Agent-work نمی‌شود.

برای بررسی مستقیم API:

```text
GET http://127.0.0.1:4310/api/repos/<repo-id>/health?refresh=1
```

خروجی سالم باید `"ok": true` و `"code": 0` داشته باشد.
