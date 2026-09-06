# Implementation Notes — v1.1

## تغییر معماری این نسخه

نسخه‌ی قبلی یک `protocol-patch` داخلی داشت. در v1.1 این coupling عمداً حذف شد.

### حذف شد

- `protocol-patch/scripts/manager.js`
- `protocol-patch/scripts/run-agent.js`
- `protocol-patch/scripts/verify.js`
- `protocol-patch/scripts/lib/manifest.cjs`
- `install-protocol-patch.ps1`

### اضافه شد

- `docs/manager-api-contract.md`
- `server/src/protocol-contract.js`
- `server/check-manager.js`
- `manager.js capabilities --json` به‌عنوان handshake رسمی
- fail-fast startup برای Contract ناسازگار
- نمایش Manager/Contract version در UI

## نتیجه

BarsaAgent از این نسخه به بعد هیچ تغییری در implementation پروژه‌ی Agent Protocol نمی‌دهد. تیم Agent Protocol می‌تواند `manager.js`، `run-agent.js` و `verify.js` را مستقل توسعه دهد؛ تا وقتی Manager Contract v1 ثابت بماند، UI نیاز به تغییر ندارد.

## مسئولیت Server

- فقط `manager.js` را spawn می‌کند.
- هیچ access مستقیم به `.agent-work` ندارد.
- هیچ git command ندارد.
- ProcessRegistry برای یک run فعال به‌ازای repo/task.
- SSE + ring buffer.
- token redaction.
- issue adapter و temporary JSON برای import.
- path traversal defense روی artifact endpoint.

## مسئولیت Angular

- Kanban و task details.
- awaitingHuman gates.
- timeline/attempt/artifact views.
- issue inbox.
- log SSE.
- notification و scope overlap warning.
- نمایش نسخه‌ی Manager و Contract متصل.
