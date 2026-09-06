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
    "status": true,
    "taskStatus": true,
    "events": true,
    "artifact": true,
    "run": true,
    "answer": { "approve": true, "reject": true, "clarify": true },
    "importIssue": true
  }
}
```

## Status

```bash
node scripts/manager.js status --json
node scripts/manager.js status --json --task <id>
```

`awaitingHuman` field است، نه state. یک task خراب باید با `error` در خروجی دیده شود و کل board را نشکند.

## Events

```bash
node scripts/manager.js events <id> --json
```

## Artifact

```bash
node scripts/manager.js artifact <id> --path <relative-path>
```

stdout متن خام artifact. Manager و Server هر دو traversal را محدود می‌کنند.

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

Spec rejection:

```bash
node scripts/manager.js answer <id> --reject --reason "..."
```

Merge rejection به implementer:

```bash
node scripts/manager.js answer <id> --reject --reason "..." --route implementer
```

Merge rejection به architect:

```bash
node scripts/manager.js answer <id> --reject --reason "..." --route architect
```

## Answer — clarification

پاسخ clarification هرگز در argv قرار نمی‌گیرد. BarsaAgent فایل موقت UTF-8 می‌سازد:

```bash
node scripts/manager.js answer <id> --clarify --file <tmp.txt>
```

محتوای فایل همان پاسخ انسان است. این چرخه طبق protocol budget مصرف نمی‌کند.

## Auto resume

بعد از answer موفق، BarsaAgent در صورت `run.autoResumeAfterAnswer: true` دوباره `run <id>` را enqueue می‌کند. Manager نباید نیازمند کلیک یا فرمان دیگری از UI باشد.

## Health

BarsaAgent برای status bar این فرمان read-only را در root repo اجرا می‌کند:

```bash
npm run validate-agent-work
```

کد خروج و stdout/stderr در UI نمایش داده می‌شود. UI دکمه پاک‌کردن lock ندارد.

## JSON discipline

فرمان‌های `capabilities/status/events` روی stdout فقط JSON معتبر می‌دهند. diagnostic روی stderr. `run` استثناست و برای log زنده خروجی انسانی دارد.
