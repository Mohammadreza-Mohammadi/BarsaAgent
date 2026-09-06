# BarsaAgent Manager Contract v1

این سند تنها قرارداد بین **BarsaAgent UI/Server** و پروژه‌ی مستقل **Agent Protocol** است.

## مرز مالکیت

BarsaAgent مالک این فایل‌ها نیست و نباید آن‌ها را patch، کپی یا overwrite کند:

```text
scripts/manager.js
scripts/run-agent.js
scripts/verify.js
.agent-work/**
```

BarsaAgent فقط `manager.js` را به‌عنوان API خط فرمان صدا می‌زند. نحوه‌ی داخلی orchestration، اجرای `run-agent.js`، اجرای `verify.js`، git/worktree و schema داخلی manifest کاملاً متعلق به پروژه‌ی Agent Protocol است.

```text
BarsaAgent Angular
      │ HTTP
      ▼
BarsaAgent Node Server
      │ CLI contract v1
      ▼
<repo>/scripts/manager.js
      │
      ├── run-agent.js      ← داخلی Agent Protocol
      ├── verify.js         ← داخلی Agent Protocol
      ├── git/worktree      ← داخلی Agent Protocol
      └── .agent-work       ← source of truth
```

## 1. Capability handshake — اجباری

BarsaAgent در startup برای هر repo این دستور را اجرا می‌کند:

```bash
node scripts/manager.js capabilities --json
```

stdout باید فقط JSON معتبر باشد و exit code صفر باشد.

حداقل پاسخ Contract v1:

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

اگر contract/version یا یکی از قابلیت‌های اجباری موجود نباشد، BarsaAgent عمداً startup را متوقف می‌کند.

## 2. Status board

```bash
node scripts/manager.js status --json
```

stdout:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-06T08:30:00.000Z",
  "repo": {
    "id": "barsa-novin-ray",
    "path": "F:/BarsaNovinRay",
    "head": "abc123"
  },
  "tasks": []
}
```

قواعد:

- stdout فقط JSON معتبر.
- diagnostic فقط stderr.
- خرابی یک task نباید کل board را خراب کند؛ همان task با `error` برگردد.
- وجود task خراب به‌تنهایی exit code را non-zero نمی‌کند.

## 3. Status یک task

```bash
node scripts/manager.js status --json --task 1832
```

خروجی همان envelope فرمان status است ولی `tasks` حداکثر یک عضو دارد.

نمونه task:

```json
{
  "id": "1832",
  "slug": "fix-daily-movement",
  "title": "اصلاح محاسبه تعداد جابجایی روزانه",
  "type": "task",
  "state": "implementing",
  "stateSince": "2026-09-06T08:00:00.000Z",
  "previousState": "ready",
  "awaitingHuman": null,
  "blocker": null,
  "source": {
    "system": "internal",
    "externalId": "1832",
    "url": "https://...",
    "fetchedAt": "2026-09-06T07:00:00.000Z"
  },
  "budget": {
    "attempts": { "used": 2, "max": 8 },
    "implementerRuns": { "used": 1, "max": 3 }
  },
  "scope": {
    "allow": ["src/app/**"],
    "deny": ["src/legacy/**"]
  },
  "worktree": { "status": "active", "path": "F:/agent-work/1832" },
  "git": {
    "base": "main",
    "baseCommit": "...",
    "headCommit": "...",
    "mergeCommit": null
  },
  "lastAttempt": {
    "n": 2,
    "role": "implementer",
    "outcome": "ok",
    "at": "2026-09-06T08:10:00.000Z"
  },
  "artifacts": ["request.md", "task.md", "handoff.md"],
  "attempts": []
}
```

`awaitingHuman` یک field است، نه state.

## 4. Events

```bash
node scripts/manager.js events 1832 --json
```

stdout یک JSON array از eventهاست.

## 5. Artifact read

```bash
node scripts/manager.js artifact 1832 --path review.md
```

stdout متن خام artifact است. Manager خودش باید مسیر را به پوشه‌ی همان task محدود کند. Server هم یک لایه‌ی دفاعی جدا برای رد path traversal دارد.

## 6. Run

```bash
node scripts/manager.js run 1832
```

این فرمان long-running است و برای log زنده stdout/stderr تولید می‌کند. `--json` ندارد.

کدهای خروج مورد انتظار:

| Exit code | معنی |
|---:|---|
| 0 | integrated / workflow کامل شد |
| 10 | منتظر اقدام انسان |
| 20 | متوقف / blocked |
| 30 | بدون پیشرفت / guard فعال شد |
| 1 یا سایر | خطای اجرایی |

BarsaAgent برای هر `(repo, task)` حداکثر یک process فعال نگه می‌دارد.

## 7. Answer

Approve:

```bash
node scripts/manager.js answer 1832 --approve
```

Reject:

```bash
node scripts/manager.js answer 1832 --reject --reason "دلیل"
```

Clarification:

```bash
node scripts/manager.js answer 1832 --clarify --text "پاسخ"
```

تمام mutationها باید داخل Manager اعمال شوند. UI هیچ artifact پروتکل را نمی‌نویسد.

## 8. Import issue

```bash
node scripts/manager.js import-issue --file C:/Temp/issue.json
```

ورودی نمونه:

```json
{
  "externalId": "1832",
  "title": "...",
  "body": "...",
  "url": "...",
  "status": "open",
  "labels": ["bug"]
}
```

پیشنهاد خروجی:

```json
{
  "ok": true,
  "taskId": "1832"
}
```

Import تکراری همان `source.externalId` باید رد شود.

## 9. Security/runtime requirements

- Manager فقط از طریق آرگومان‌های array و با `shell: false` اجرا می‌شود.
- secrets در CLI argument قرار نگیرند؛ فقط env.
- BarsaAgent فقط روی `127.0.0.1` bind می‌شود.
- stdout JSON commands نباید log انسانی داشته باشد.
- BarsaAgent مستقیم git اجرا نمی‌کند.
- BarsaAgent مستقیم `.agent-work` را نمی‌خواند یا نمی‌نویسد.

## 10. تست اتصال

از پوشه‌ی repo اصلی Agent Protocol:

```powershell
node scripts/manager.js capabilities --json
node scripts/manager.js status --json
node scripts/manager.js status --json --task 1832
node scripts/manager.js events 1832 --json
```

سپس از پوشه‌ی BarsaAgent:

```powershell
npm run check:manager
```

اگر همه‌چیز درست باشد:

```text
OK   barsa-novin-ray · manager 2.4.0 · contract v1
```
