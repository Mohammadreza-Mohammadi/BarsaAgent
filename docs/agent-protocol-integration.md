# اتصال Agent Protocol به BarsaAgent v1.2

BarsaAgent هیچ patchی از Manager نگه نمی‌دارد. repo اصلی Agent Protocol در `barsa-agent.config.yml` معرفی می‌شود و تنها قرارداد CLI زیر مصرف می‌شود:

```text
capabilities --json
status --json [--task <id>]
events <id> --json
artifact <id> --path <path>
import-issue --file <tmp.json>
run <id>
answer <id> --approve
answer <id> --reject --reason <text> [--route implementer|architect]
answer <id> --clarify --file <tmp.txt>
```

برای flow ساخت task، `import-issue` باید payload `repo/type/slug/requestText/source?` را بپذیرد و `taskId` را در JSON stdout برگرداند. `requestText` بدون template یا AC اضافه عیناً `request.md` می‌شود.

BarsaAgent queue، `maxConcurrent`، auto-start و auto-resume را مدیریت می‌کند. Manager مالک state machine، agent invocation، verification، worktree، git و `.agent-work` باقی می‌ماند.

تست اتصال:

```powershell
node scripts/manager.js capabilities --json
node scripts/manager.js status --json
npm run validate-agent-work
```

و از BarsaAgent:

```powershell
npm run check:manager
npm test
```
