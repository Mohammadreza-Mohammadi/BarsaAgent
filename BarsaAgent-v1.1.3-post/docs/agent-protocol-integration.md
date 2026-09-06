# کار لازم در پروژه Agent Protocol برای اتصال به BarsaAgent UI

این فایل را می‌توان مستقیماً به Agent/Developer مسئول `manager.js` داد.

## هدف

پروژه Agent Protocol مستقل باقی بماند. BarsaAgent UI نباید هیچ فایل آن را patch کند. فقط `manager.js` باید **BarsaAgent Manager Contract v1** را به‌صورت backward-compatible ارائه کند.

مرجع کامل: `manager-api-contract.md`.

## تغییر اجباری اول: handshake

این فرمان را اضافه/حفظ کن:

```bash
node scripts/manager.js capabilities --json
```

خروجی stdout فقط JSON:

```json
{
  "contract": "barsa-agent-manager",
  "contractVersion": 1,
  "managerVersion": "<VERSION>",
  "protocolVersion": "<OPTIONAL_VERSION>",
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

فقط capabilityای را `true` اعلام کن که واقعاً کار می‌کند.

## Interface لازم

```text
manager.js capabilities --json
manager.js status --json
manager.js status --json --task <id>
manager.js events <id> --json
manager.js artifact <id> --path <relative-path>
manager.js run <id>
manager.js answer <id> --approve
manager.js answer <id> --reject --reason <text>
manager.js answer <id> --clarify --text <text>
manager.js import-issue --file <json-file>
```

## محدودیت مهم

- معماری داخلی Manager را برای UI بازطراحی نکن.
- BarsaAgent نباید `run-agent.js` یا `verify.js` را بشناسد.
- orchestration داخلی آن‌ها همچنان در اختیار Manager است.
- schema داخلی `.agent-work` می‌تواند تکامل پیدا کند؛ خروجی Contract باید stable بماند.
- JSON commandها روی stdout فقط JSON بدهند و diagnosticها stderr باشند.
- `run` برای log زنده stdout/stderr عادی دارد.

## Done criteria

در repo Agent Protocol این فرمان‌ها موفق باشند:

```powershell
node scripts/manager.js capabilities --json
node scripts/manager.js status --json
node scripts/manager.js status --json --task <REAL_TASK_ID>
node scripts/manager.js events <REAL_TASK_ID> --json
```

و بعد در پروژه BarsaAgent:

```powershell
npm run check:manager
```

باید `OK` بدهد.
