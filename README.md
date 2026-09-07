# BarsaAgent v1.2

کنسول محلی Angular + Node برای اداره Agent Protocol از طریق `manager.js` خارجی.

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

BarsaAgent مستقیم `.agent-work` را نمی‌خواند/نمی‌نویسد و git اجرا نمی‌کند.

## امکانات v1.2

- Kanban با polling سه‌ثانیه‌ای
- نوار «منتظر تو» برای gateهای انسانی
- ساخت task از Issue با stepper و ویرایش `requestText`
- task دستی بدون Issue
- import ترتیبی؛ شکست یک مورد بقیه را متوقف نمی‌کند
- Queue اجرای Manager با `maxConcurrent`
- `autoStartOnCreate`
- `autoResumeAfterAnswer`
- clarification از فایل موقت (`--clarify --file`)، نه argv
- merge rejection با دو route مستقل: implementer / architect
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
    UserId: "20b785b0-db71-4507-9757-b5280460b0cb"
  itemsPath: "data.items"
  mapping:
    externalId: "externalId"
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

نمایش `request.md` کنار `proposed-task.md`:

```text
answer <id> --approve
answer <id> --reject --reason "..."
```

### clarification

نمایش `questions.md` + `request.md` + `task.md`. پاسخ در فایل موقت UTF-8:

```text
answer <id> --clarify --file <tmp.txt>
```

### merge-approval

نمایش `review.md`، verification، diff در صورت وجود و scope:

```text
answer <id> --approve
answer <id> --reject --reason "..." --route implementer
answer <id> --reject --reason "..." --route architect
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

{"UserId":"20b785b0-db71-4507-9757-b5280460b0cb"}
```

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
