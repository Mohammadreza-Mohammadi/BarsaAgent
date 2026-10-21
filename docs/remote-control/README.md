# کنترل کانبان از گوشی: Claude Remote Control + CLI ِ `barsa`

روی سرور یک گفت‌وگوی Claude Code با **Remote Control** باز است و انسان از اپ Claude روی گوشی با آن حرف می‌زند. Remote Control
فقط اتصال بیرون‌رونده دارد؛ هیچ پورتی روی اینترنت باز نمی‌شود. آن گفت‌وگو **شل ِ آزاد ندارد**: تنها ابزارش `./barsa` است، یک
کلاینت HTTP برای همین سرور ِ در حال اجرای کانبان (`127.0.0.1:4310`). هر کار از مسیرهای خود کانبان می‌گذرد: فهرست بسته‌ی فرمان‌ها،
دفتر ممیزی (actor = `remote:<name>`)، registry ِ فرآیندها و دکمه‌ی توقف، ادامه‌ی خودکار بعد از جواب، و `actions` ِ Manager.

```
گوشی ← اپ Claude ← (Remote Control) ← claude روی سرور ← ./barsa ← http://127.0.0.1:4310 (توکن) ← کانبان ← Manager
```

## فرمان‌ها

خواندنی (بدون تأیید): `barsa health` · `barsa issues [--all]` · `barsa tasks [--waiting|--running|--blocked|--all]` ·
`barsa task <id>` · `barsa log <id> [--tail N]` · `barsa waiting --since <ISO>`

نوشتنی (روی گوشی تأیید می‌خواهند): `barsa create-from-issue <externalId> [--run]` ·
`barsa create-task --title <t> (--text-file <f>|--stdin)` · `barsa run <id>` · `barsa stop <id>` ·
`barsa answer <id> --approve | --reject [--route implementer|architect] | --clarify | --note | --raise-limit <field>=<n> | --unblock`
(متن از `--text-file <f>` یا `--stdin`).

**عمداً بیرون از CLI** (ثابت `NOT_REMOTE_COMMANDS` و `NOT_REMOTE_ANSWER_FLAGS` در `server/src/remote-cli-spec.js`؛ CLI می‌گوید
«این تصمیم را از رابط کاربری کانبان بگیر»): `abandon`، `void`، `unlock`، `cancel`، `--external-access`، `--allow-path`،
`--allow-shared-knowledge-file`، `--reset-external`، `--stage-external`، `--external-checked-in`، `sync` ِ اجرایی، کنسول ِ آزاد و
هر چیز دیگر. سرور هم برای توکن remote فقط همین endpointها را باز می‌گذارد (`REMOTE_ENDPOINTS`)؛ حتی با توکن لو رفته abandon/console ممکن نیست.

exit code: `0` موفق · `2` آرگومان بد · `3` اکشن مجاز نیست (پیش‌سنجی از `actions`، بدون هیچ درخواستی) · `4` سرور کانبان در دسترس نیست ·
`5` احراز هویت · `6` Manager/سرور رد کرد (پیام عیناً) · `41` اجرا روی این دستگاه خاموش است (کد Manager).

خروجی پیش‌فرض متن کوتاه فارسی است؛ `--json` شکل ثابت دارد (پایین). هیچ فرمانی منتظر پایان کار طولانی نمی‌ماند: `run` و
`create-from-issue --run` فوراً برمی‌گردند و می‌گویند «با `barsa log <id>` ببین».

## راه‌اندازی روی سرور

همه با همان حساب ویندوزی که سرویس کانبان و Claude Code را اجرا می‌کند (`client01`).

1. **ساخت توکن** (در `D:\BarsaAgent`):

   ```powershell
   $env:BARSA_AGENT_CONFIG = 'D:\barsa-agent-data\barsa-agent.config.yml'
   npm run token:create -- remote-phone
   ```

   توکن (۳۲ بایت تصادفی) **چاپ نمی‌شود**؛ فقط در `D:\barsa-agent-data\tokens\remote-phone.token` با دسترسی فقط-مالک نوشته می‌شود.
   فقط hash ِ SHA-256 اش در `D:\barsa-agent-data\remote-tokens.json` (کنار `users.json`) می‌ماند. فهرست: `npm run token:list`.
   سرویس را ری‌استارت نکن؛ همین الان معتبر است.

2. **کپی قالب‌ها** به `D:\agent-remote`:

   ```powershell
   New-Item -ItemType Directory -Force D:\agent-remote\.claude, D:\agent-remote\inbox | Out-Null
   Copy-Item D:\BarsaAgent\docs\remote-control\CLAUDE.md  D:\agent-remote\
   Copy-Item D:\BarsaAgent\docs\remote-control\guard.mjs  D:\agent-remote\
   Copy-Item D:\BarsaAgent\docs\remote-control\settings.json D:\agent-remote\.claude\
   Copy-Item D:\BarsaAgent\docs\remote-control\bin\barsa, D:\BarsaAgent\docs\remote-control\bin\barsa.cmd D:\agent-remote\
   ```

   shim ها (`barsa` برای Git Bash، `barsa.cmd` برای cmd) به‌جای مسیر نسبی، `BARSA_APP_DIR` یا پیش‌فرض `D:/BarsaAgent` را می‌خوانند؛ پس
   کنار `D:\agent-remote` کپی شده هم کار می‌کنند و با `./barsa …` اجرا می‌شوند. فایل `barsa` باید **LF** بماند (`.gitattributes` این را تضمین
   می‌کند؛ اگر با ویرایشگر باز و ذخیره شد، CRLF نشود).

3. **مسیر توکن** (یک بار، برای همان حساب): `setx BARSA_REMOTE_TOKEN_FILE D:\barsa-agent-data\tokens\remote-phone.token`
   (یا `BARSA_REMOTE_TOKEN_NAME`/`BARSA_AGENT_CONFIG` ؛ پیش‌فرض `<dataDir>/tokens/remote-phone.token`). نشانی سرور پیش‌فرض
   `http://127.0.0.1:4310` است (`BARSA_REMOTE_URL`، فقط loopback؛ هر نشانی دیگری رد می‌شود تا توکن جایی نرود).

4. **اجرای گفت‌وگو** از `D:\agent-remote`:

   ```powershell
   cd D:\agent-remote
   claude remote-control --name barsa-server --permission-mode default
   ```

5. در همان گفت‌وگو `/config` را باز کن و **«Push when actions required»** و **«Push when Claude decides»** را روشن کن تا تأییدها و
   اعلان‌ها روی گوشی بیایند.

6. از اپ Claude روی گوشی به `barsa-server` وصل شو. تست: «چه چیزی منتظر من است؟» ← `./barsa tasks --waiting`.

### حفاظ‌ها (لایه‌به‌لایه)

- `settings.json`: خواندنی‌ها `allow`، نوشتنی‌ها `ask` (روی گوشی تأیید می‌خواهند)؛ `deny` برای Edit/Write/NotebookEdit/WebFetch/WebSearch،
  خواندن `D:/barsa-agent-data/**`، `D:/BarsaAgent/.env.local`، `~/.claude`، `~/.ssh` و خانواده‌ی فرمان‌های خطرناک. `defaultMode` همان پیش‌فرض
  (نه `bypassPermissions` و نه `acceptEdits`).
- **ترتیب ارزیابی Claude Code: deny ← ask ← allow؛ اولین تطبیق برنده است.** پس نمی‌شود «هر Bash ِ دیگری» را با یک `deny: ["Bash"]` بست
  (همه‌چیز، از جمله `./barsa`، را می‌بست). برای «پیش‌فرض: رد» یک hook ِ `PreToolUse` (`guard.mjs`) هست: هر Bash ای که یک فراخوانی ساده‌ی
  `./barsa <فرمان> …` نباشد (از جمله `ls`، `git status`، `;`، `&&`، `|`، `$(…)`، redirect) با پیام روشن رد می‌شود. متن آزاد فقط با heredoc ِ
  تک‌کوتیشن می‌آید. اگر hook اجرا نشود (مثلاً `node` در PATH نباشد)، همان deny/ask ها می‌مانند.
- سرور: توکن فقط از loopback (و بدون هدر proxy) پذیرفته می‌شود، فقط endpointهای فهرست مجاز، بدون CSRF ِ کوکی (فقط برای همین حالت).

## شکل خروجی `--json`

| فرمان | کلیدها |
|---|---|
| `health` | `ok, checkedAt, execution{enabled,status,detail}, sync{status,ahead,behind,lastFetchAt,detail}, claude{installed,auth}, problems[{id,status,label,detail,hint}]` |
| `issues` | `issues[{externalId,title,status,labels,importedTaskId,importedRepoId}], hiddenImported` |
| `tasks` | `repo, filter, generatedAt, total, truncated, execution, tasks[{id,title,state,stateSince,gate{kind,since}\|null,blocker{kind,detail}\|null,running,queued,actions[]}]` |
| `task` | `id, title, state, stateSince, gate, running{running,queued,exitCode}, actions, blocker, review{decision,evidenceStatus,acceptance[{ac,verdict}],problems}, releaseNote, diff{headCommit,files[]}, externalSources[], budget` |
| `log` | `taskId, runId, running, queued, startedAt, finishedAt, exitCode, truncated, lines[]` |
| `waiting` | `repo, since, generatedAt, tasks[{id,title,state,gate,…}]` — `generatedAt` را برای `--since` ِ دفعه‌ی بعد نگه دار |
| `create-*` | `ok, taskId, repoId, queued, started` |
| `run` / `stop` / `answer` | `ok, taskId, …` (`queued, queuePosition` / `wasQueued, stillAlive, exitCode` / `mode, autoResumed, queued, started`) |
| هر خطا | `ok:false, exitCode, error` (+ `managerExit` اگر Manager کد داد) — روی stdout |

## باطل کردن توکن

```powershell
npm run token:revoke -- remote-phone
```

فوراً بی‌اثر است (ری‌استارت لازم نیست) و فایل توکن پاک می‌شود؛ درخواست بعدی `401` و یک ردیف `auth.token` در دفتر ممیزی می‌گیرد. برای
توکن تازه دوباره `token:create` بزن.

## در خرابی

| وضعیت | علامت | کار |
|---|---|---|
| کانبان پایین است | exit `4`، «سرور کانبان در دسترس نیست» | `nssm status BarsaAgent` / `nssm start BarsaAgent`؛ لاگ در `D:\BarsaAgent-logs`. هیچ فرمانی خودش تلاش مجدد نمی‌کند |
| توکن باطل/نامعتبر/فایل گم شده | exit `5` | `token:list`؛ `token:revoke` و `token:create` دوباره؛ مسیر `BARSA_REMOTE_TOKEN_FILE` را بسنج |
| اجرا خاموش است | exit `41`، «اجرای تسک روی این دستگاه خاموش است» | خواندن‌ها و `sync` کار می‌کنند؛ برای روشن کردن `execution.enabled` را در `repository.local.yaml` ِ Manager برگردان |
| اکشن مجاز نیست | exit `3` | `barsa task <id>` اکشن‌های مجاز را می‌گوید؛ Manager تصمیم می‌گیرد، نه CLI |
| Manager رد کرد | exit `6` | پیام Manager عیناً چاپ می‌شود |

دفتر ممیزی (رابط کاربری کانبان ← «ممیزی») کارهای `remote:*` را با برچسب کوچک `remote` نشان می‌دهد.

## صحت‌سنجی قاعده‌ها

قاعده‌های `settings.json` و hook با Claude Code ِ واقعی (2.1.303، حالت headless با `--settings`) سنجیده شده‌اند: `./barsa health|tasks|task` بدون پرسش
اجرا شد؛ `./barsa run|answer` تأیید خواست؛ `ls`، `git status`، `./barsa tasks; ls`، `./barsa health && ls`، `cat …` و `./barsa task-evil` رد شدند؛
Write و Read روی مسیر deny رد شد. **روی سرور هم یک بار بسنج** (مسیر `D:` و حساب `client01` را من نداشتم): در `D:\agent-remote` یک
گفت‌وگوی تازه باز کن و بخواه `./barsa health` (باید بی‌پرسش)، `./barsa run 1` (باید تأیید بخواهد) و `ls` (باید رد شود) را اجرا کند.
