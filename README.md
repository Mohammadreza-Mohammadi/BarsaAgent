# BarsaAgent UI 1.1

کنسول وب محلی برای کنترل و مشاهده‌ی **Agent Protocol** با Angular + Node و مرز مالکیت مشخص بین UI و orchestration.

> **وضعیت فعلی:** تغییرات **BarsaAgent Manager Contract v1** روی پروژه‌ی Agent Protocol اعمال شده‌اند. از این مرحله به بعد BarsaAgent فقط به `manager.js` واقعی همان پروژه متصل می‌شود و هیچ فایل اسکریپتی را patch یا overwrite نمی‌کند.

---

## معماری نهایی

```text
BarsaAgent
│
├── Angular UI
│       │ HTTP / SSE
│       ▼
└── Node Server
        │
        │ BarsaAgent Manager Contract v1
        ▼
Agent Protocol Repository
        │
        └── scripts/manager.js
                │
                ├── run-agent.js
                ├── verify.js
                ├── git / worktree
                └── .agent-work
```

اصل اصلی این معماری:

- **BarsaAgent فقط Client برای `manager.js` است.**
- BarsaAgent هیچ‌وقت `.agent-work` را مستقیم نمی‌خواند یا نمی‌نویسد.
- BarsaAgent هیچ دستور `git` اجرا نمی‌کند.
- BarsaAgent مستقیماً `run-agent.js` یا `verify.js` را اجرا نمی‌کند.
- orchestration، state machine، worktree، verification و schema داخلی manifest متعلق به Agent Protocol هستند.
- ارتباط بین دو پروژه فقط از طریق **Manager Contract v1** انجام می‌شود.

مرجع قرارداد:

```text
docs/manager-api-contract.md
```

راهنمای integration سمت Agent Protocol:

```text
docs/agent-protocol-integration.md
```

---

## وضعیت تغییرات Manager

سمت Agent Protocol باید اکنون commandهای زیر در `manager.js` فعال باشند:

```text
manager.js capabilities --json
manager.js status --json
manager.js status --json --task <id>
manager.js events <id> --json
manager.js artifact <id> --path <relative-path>
manager.js import-issue --file <path.json>
manager.js run <id>
manager.js answer <id> --approve
manager.js answer <id> --reject --reason "..."
manager.js answer <id> --clarify --text "..."
```

`run-agent.js` و `verify.js` جزو Contract عمومی BarsaAgent نیستند. `manager.js` در داخل Agent Protocol هر زمان لازم باشد آن‌ها را اجرا می‌کند.

---

## Capability handshake

قبل از استفاده از یک repo، BarsaAgent سازگاری `manager.js` را با این فرمان بررسی می‌کند:

```powershell
node scripts/manager.js capabilities --json
```

نمونه‌ی پاسخ معتبر:

```json
{
  "contract": "barsa-agent-manager",
  "contractVersion": 1,
  "managerVersion": "2.4.0",
  "protocolVersion": "4",
  "capabilities": {
    "status": true,
    "taskStatus": true,
    "events": true,
    "artifact": true,
    "run": true,
    "answer": {
      "approve": true,
      "reject": true,
      "clarify": true
    },
    "importIssue": true
  }
}
```

اگر Contract version یا یکی از قابلیت‌های ضروری ناسازگار باشد، BarsaAgent به‌صورت **fail-fast** بالا نمی‌آید و capability ناقص را گزارش می‌کند.

---

## ساختار پروژه

```text
BarsaAgent/
│
├── client/                         Angular 22 standalone UI
│   └── src/
│
├── server/                         Node bridge
│   ├── src/
│   │   ├── app.js                  HTTP API
│   │   ├── cli.js                  اجرای manager.js بیرونی
│   │   ├── process-registry.js     مدیریت runهای فعال
│   │   ├── protocol-contract.js    handshake و validation
│   │   ├── issues.js               issue source adapter
│   │   └── security.js             log/token protection
│   │
│   ├── test/
│   └── check-manager.js
│
├── docs/
│   ├── manager-api-contract.md
│   └── agent-protocol-integration.md
│
├── barsa-agent.config.yml
├── package.json
└── README.md
```

در این نسخه **عمداً وجود ندارند**:

```text
protocol-patch/
install-protocol-patch.ps1
نسخه‌ی کپی‌شده‌ی manager.js
نسخه‌ی کپی‌شده‌ی run-agent.js
نسخه‌ی کپی‌شده‌ی verify.js
```

بنابراین توسعه‌ی Agent Protocol و BarsaAgent می‌تواند کاملاً مستقل ادامه پیدا کند.

---

# راه‌اندازی

## 1. پیش‌نیاز Node

```text
Node ^22.22.3 || ^24.15.0 || >=26.0.0
```

پیشنهاد:

```text
Node 24.15 یا جدیدتر
```

بررسی نسخه:

```powershell
node --version
npm --version
```

---

## 2. تنظیم repo اصلی Agent Protocol

فایل:

```text
barsa-agent.config.yml
```

نمونه:

```yaml
server:
  port: 4310

repos:
  - id: barsa-novin-ray
    path: "F:/BarsaNovinRay"
    managerScript: "scripts/manager.js"

issueSource:
  baseUrl: "https://your-internal-service"
  apiKeyHeader: "X-Api-Key"
  apiKeyEnv: "BARSA_ISSUE_API_KEY"
  listPath: "/api/issues"
  itemsPath: "data.items"
  query:
    UserId: "20b785b0-db71-4507-9757-b5280460b0cb"
  mapping:
    externalId: "id"
    title: "subject"
    body: "description"
    url: "permalink"
    status: "state"
    labels: "tags"
```

پارامتر `UserId` بالا در هر بار Fetch شدن Issueها به‌صورت Query String به وب‌سرویس ارسال می‌شود؛ یعنی درخواست نهایی شامل `?UserId=20b785b0-db71-4507-9757-b5280460b0cb` خواهد بود.

`path` باید مسیر واقعی repoای باشد که Agent Protocol و اسکریپت‌های اصلی در آن توسعه پیدا می‌کنند.

BarsaAgent هیچ فایل اسکریپتی را از این repo کپی نمی‌کند.

---

## 3. ابتدا Manager را مستقیم تست کن

از داخل repo اصلی Agent Protocol:

```powershell
cd F:\BarsaNovinRay

node scripts/manager.js capabilities --json
node scripts/manager.js status --json
```

برای یک Task واقعی نیز:

```powershell
node scripts/manager.js status --json --task 1832
node scripts/manager.js events 1832 --json
```

اگر این commandها JSON معتبر بدهند، Manager از نظر اولیه آماده‌ی اتصال است.

---

## 4. نصب BarsaAgent

از پوشه‌ی BarsaAgent:

```powershell
npm ci
```

---

## 5. تست Contract از سمت BarsaAgent

```powershell
npm run check:manager
```

خروجی مورد انتظار:

```text
OK   barsa-novin-ray · manager 2.4.0 · contract v1
```

اگر این مرحله پاس شود یعنی اتصال زیر برقرار است:

```text
BarsaAgent Server
      │
      ▼
manager.js واقعی Agent Protocol
```

و دیگر نیازی به copy، patch یا sync کردن `manager.js` بین دو پروژه نیست.

---

## 6. Environment Variables

توکن‌ها و کلیدها را داخل source یا YAML قرار نده.

PowerShell:

```powershell
$env:CLAUDE_CODE_OAUTH_TOKEN = "..."
$env:BARSA_ISSUE_API_KEY = "..."
```

`CLAUDE_CODE_OAUTH_TOKEN` از طریق environment به processهای Agent Protocol منتقل می‌شود.

---

## 7. اجرای تست‌ها

```powershell
npm test
```

تست‌های Server شامل موارد مهمی مثل این‌ها هستند:

- Contract handshake
- capability validation
- manifest/task خراب بدون شکستن کل board
- جلوگیری از double-run یک task
- SSE replay
- token masking
- artifact path traversal protection

---

# اجرای Development

Terminal اول:

```powershell
npm run dev:server
```

Terminal دوم:

```powershell
npm run dev:client
```

سپس UI را از آدرس development مربوط به Angular باز کن.

Server API روی:

```text
127.0.0.1:4310
```

در دسترس است.

---

# اجرای Production محلی

```powershell
npm run build
npm start
```

آدرس:

```text
http://127.0.0.1:4310
```

Server عمداً فقط روی:

```text
127.0.0.1
```

bind می‌شود و نباید روی `0.0.0.0` expose شود، چون Server قابلیت اجرای Manager process را دارد.

---

# جریان اجرای واقعی

## خواندن Board

Angular:

```text
GET /api/repos/:repo/board
```

Server:

```text
manager.js status --json
```

Manager وضعیت را از source of truth خودش استخراج می‌کند و JSON به BarsaAgent می‌دهد.

---

## اجرای Task

کاربر در UI روی **اجرا** می‌زند:

```text
Angular
   │
   ▼
POST /api/repos/:repo/tasks/:id/run
   │
   ▼
Node Server
   │
   ▼
manager.js run <id>
```

از اینجا به بعد orchestration کاملاً داخل Agent Protocol است:

```text
manager.js
   │
   ├── run-agent.js
   ├── verify.js
   ├── state transitions
   ├── worktree / git
   └── artifacts
```

BarsaAgent فقط stdout/stderr را برای Live Log دریافت می‌کند.

---

## Run exit codes

| Code | معنی در UI |
|---:|---|
| 0 | تمام شد — integrated |
| 10 | منتظر اقدام انسان |
| 20 | متوقف / blocked |
| 30 | بدون پیشرفت — احتمالاً guard یا bug |
| 1 / سایر | خطای اجرایی |

---

## Human Gate

اگر Task به تصمیم انسان برسد، `status --json` چیزی شبیه این برمی‌گرداند:

```json
{
  "awaitingHuman": {
    "kind": "spec-approval",
    "artifact": "proposed-task.md"
  }
}
```

`awaitingHuman` یک **field** است، نه state مستقل.

UI بر اساس `kind` پنل مناسب را نمایش می‌دهد و پاسخ فقط از طریق Manager ارسال می‌شود:

```text
manager.js answer <id> --approve
manager.js answer <id> --reject --reason "..."
manager.js answer <id> --clarify --text "..."
```

---

# امکانات UI

- Kanban هفت‌ستونه
- lane جدا برای `blocked` / `cancelled` / `abandoned`
- نوار ثابت **منتظر تو**
- نمایش `awaitingHuman` روی کارت Task
- Spec Approval
- Clarification
- Merge Approval
- Task Timeline
- Attempt browser
- Artifact viewer فقط‌خواندنی
- Scope allow/deny
- Live log با SSE
- replay buffer تا ۲۰۰۰ خط
- جلوگیری از double-run یک Task
- Issue Inbox
- issue mapping قابل تنظیم
- Desktop notification برای gate جدید
- هشدار overlap تقریبی `scope.allow`
- نمایش Manager version و Contract version
- poll برد هر ۳ ثانیه

---

# چند Repo

از ابتدا چند repo پشتیبانی می‌شود:

```yaml
repos:
  - id: barsa-novin-ray
    path: "F:/BarsaNovinRay"
    managerScript: "scripts/manager.js"

  - id: another-project
    path: "F:/AnotherProject"
    managerScript: "scripts/manager.js"
```

هر repo:

- Manager مستقل دارد.
- جداگانه handshake می‌شود.
- Board و Taskهای خودش را دارد.
- Process registry مستقل بر اساس `(repo, task)` دارد.

اگر Manager یک repo با Contract v1 ناسازگار باشد، startup fail می‌شود تا UI وضعیت اشتباه نمایش ندهد.

---

# مرز مسئولیت دو پروژه

## Agent Protocol

مالک این بخش‌هاست:

```text
manager.js
run-agent.js
verify.js
.agent-work
manifest schema
state machine
agent execution
git/worktree
verification
integration
```

## BarsaAgent

مالک این بخش‌هاست:

```text
Angular UI
Node HTTP bridge
SSE
Process Registry
Issue Adapter
Manager Contract validation
Kanban
Task Details
Human Gate UI
```

این مرز را حفظ کن؛ هیچ feature جدید UI نباید باعث شود BarsaAgent مستقیماً وارد implementation داخلی Agent Protocol شود.

---

# بررسی سریع بعد از هر تغییر Manager

هر بار که Agent Protocol تغییر می‌کند، این ترتیب را اجرا کن:

```powershell
# Agent Protocol repo
node scripts/manager.js capabilities --json
node scripts/manager.js status --json

# BarsaAgent repo
npm run check:manager
npm test
```

اگر همه پاس باشند، تغییرات Manager از نظر Contract با BarsaAgent سازگارند.

---

# اسناد مرجع

- `docs/manager-api-contract.md` — قرارداد رسمی و versioned بین دو پروژه
- `docs/agent-protocol-integration.md` — راهنمای توسعه‌دهنده‌ی Agent Protocol
- `IMPLEMENTATION-NOTES.md` — تصمیمات و تغییرات معماری BarsaAgent v1.1

---

## خلاصه

بعد از اعمال تغییرات Manager، معماری نهایی این است:

```text
BarsaAgent UI/Server
        │
        │ stable Contract v1
        ▼
manager.js واقعی پروژه Agent Protocol
        │
        ├── run-agent.js
        ├── verify.js
        └── سایر orchestration
```

**هیچ فایل اسکریپتی بین دو پروژه کپی یا patch نمی‌شود.**

تا زمانی که `Manager Contract v1` حفظ شود، UI و Agent Protocol می‌توانند مستقل از هم توسعه پیدا کنند.

## Debug کردن Issue Web Service

از نسخه `1.1.2`، فراخوانی Issue Source در کنسول Node لاگ کامل تشخیصی تولید می‌کند.

با اجرای:

```powershell
npm run dev:server
```

و سپس باز کردن:

```text
http://localhost:4200/api/issues?refresh=1
```

در ترمینال Server این موارد دیده می‌شوند:

- URL نهایی شامل query string
- `itemsPath` و mapping فعال
- اینکه API key تنظیم شده یا نه (خود مقدار key چاپ نمی‌شود)
- HTTP status و content-type
- body خام پاسخ وب‌سرویس
- خطای fetch، timeout، JSON parse یا normalization همراه stack trace

نمونه:

```text
[BarsaAgent][Issues] GET https://example/api/GetIssues?UserId=...
[BarsaAgent][Issues] HTTP 200 OK
[BarsaAgent][Issues] Raw response body:
{"data":{"items":[...]}}
[BarsaAgent][Issues] Normalized 3/3 issue(s).
```

> توجه: body خام وب‌سرویس در حالت debug روی کنسول چاپ می‌شود؛ در محیط production اگر پاسخ شامل داده حساس است این logging را غیرفعال یا محدود کنید.
