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
`barsa task <id>` (با بخش «⏳ منتظر تو»: متن کامل سؤال‌ها / خلاصه‌ی AC / تصمیم Reviewer + release note + diff) ·
`barsa log <id> [--tail N]` · `barsa waiting --since <ISO>` · `barsa runtime <id>` · `barsa runtime-options` · `barsa deps <id>` · `barsa attachments <id>` ·
`barsa artifact <id> [name] [--attempt N] [--tail N]` ·
`barsa diag <id>` · `barsa diag --system` · `barsa bundle <id>` · `barsa sync --dry-run` · `barsa sync --status <execId>` · `barsa drain --status`

نوشتنی (روی گوشی تأیید می‌خواهند): `barsa create-from-issue <externalId> [--run] [--runtime-preset <name>] [--runtime <role>=<p>:<m>:<e> ...] [--allow-duplicate (--reason "…"|--stdin)]` ·
`barsa create-task --title <t> (--text-file <f>|--stdin) [--runtime-preset <name>] [--runtime <role>=<p>:<m>:<e> ...]` · `barsa run <id>` · `barsa stop <id>` ·
`barsa set-runtime <id> <role> <provider>:<model>:<effort> --reason "…"` · `barsa set-runtime <id> --preset <name> --reason "…"` ·
`barsa set-runtime <id> <role|preset|all> --reset --reason "…"` · `barsa retry-provision <id>` (و alias ِ `barsa retry-install <id>`) ·
`barsa answer <id> --approve | --reject [--route implementer|architect] | --clarify [--respec] | --note | --raise-limit <field>=<n> | --unblock | --allow-shared-knowledge-file <path>`
(متن از `--text-file <f>` یا `--stdin`) · `barsa recover <id> [--discard-residue]` · `barsa recheck <id>` · `barsa approve-deps <id> --reason "…"` · `barsa reject-deps <id> --reason "…"` · `barsa sync` ·
`barsa drain` · `barsa drain --off` · `barsa kill-stuck-install <id> [--minutes N]`.

### «بدون RDP»: دیدن، تشخیص، رفع گیر

اصل ثابت: Claude ِ Remote Control **شل ِ آزاد ندارد**؛ هر توان تازه یک فرمان **نام‌دار** `barsa` است با endpoint ِ خودش در فهرست بسته‌ی
`REMOTE_ENDPOINTS` و یک ردیف ممیزی با actor ِ `remote:<name>`.

| فرمان | endpoint | کار |
|---|---|---|
| `artifact` | `GET /api/remote/tasks/:id/artifact` | از راه `manager.js artifact/events` (نه خواندن مستقیم فایل). بدون نام: فهرست. نام‌های بسته: questions.md، proposed-task.md، task.md، handoff.md، review.md، release-note.md، implementation-report.md، previous-rejection.md (+ request/risks/tests/…)، و داخل attempt: result.yaml، run-meta.yaml، agent-transcript.log (فقط انتها)؛ events (انتها). سقف ۱۲۰٬۰۰۰ نویسه و `--tail N` (≤۵۰۰) |
| `diag <id>` | `GET /api/remote/tasks/:id/diag` | `status --summary` + health کامل (قفل زنده/مرده، dirtyPaths، recovery، install)، ۳۰ رویداد آخر، ۶۰ خط آخر لاگ آخرین اجرا (+ run id)، فرآیندهای مرتبط با تسک (PID، پدر، شروع، سن، CPU، ۱۲۰ نویسه argv)، `git status --short` پوشه‌ی تسک، وضعیت worktree (وجود، git status، شاخه: merge شده؟ commit ِ خودش؟، `node_modules\.bin`)، وضعیت صف (در حال اجرا/در صف/هیچ‌کدام؛ slotهای `maxConcurrent`) |
| `diag --system` | `GET /api/remote/diag/system` | زمان شروع سرویس، فرآیندهای node/npm/claude/git با سن و CPU، قفل‌ها و slotها، `repository.sync` و `execution`، `git status --short` و `git worktree list` مخزن Manager، دیسک، ۳۰ خط آخر `kanban.err.log` (`logs.errFile` در config؛ پیش‌فرض `<APP_ROOT>-logs\kanban.err.log`)، **جایی که** node/npm/git/claude/TF.exe روی PATH ِ سرویس پیدا می‌شوند (خود PATH چاپ نمی‌شود)، و تعداد issue برگشتی از پورتال (فقط تعداد) |
| `bundle <id>` | `POST /api/remote/tasks/:id/bundle` | zip ِ **پوشانده‌شده** از پوشه‌ی تسک + `diag.txt` + لاگ آخرین اجرا در `<dataDir>\bundles\<id>-<زمان>.zip`؛ مسیر و حجم چاپ می‌شود. در رابط کاربری: «bundleهای تشخیصی» (دانلود با نام ساده؛ `..`/مسیر مطلق رد می‌شود) |
| `recover <id>` | `POST /api/remote/tasks/:id/recover` | `manager.js recover` (attempt ِ کامل ولی تفسیرنشده را پردازش می‌کند). `--discard-residue` با دلیل: کثیفی بدون قفل را با نسخه‌ی پشتیبان برمی‌گرداند. پیش‌سنجی از `actions.recover` |
| `retry-provision <id>` | `POST /api/remote/tasks/:id/retry-provision` | `--unblock` و بعد `run` (idempotent) برای شکست ِ provisioning: `blocker.stage` = install (`npm ci` از نو) · build (buildDependencies + کتابخانه‌های بی‌dist + Baseline) · worktree-baseline (کتابخانه‌های بی‌dist + verify.build/lint). پیش‌سنجی از `actions.retryProvision` (یا alias ِ `retryInstall`) |
| `deps <id>` | `GET /api/repos/:repo/tasks/:id` | **allow.** دروازه‌ی تأیید ِ وابستگی: نام/نسخه/dev/دلیل/license، جدول ِ peerها، `hasInstallScript`، و وابستگی‌های تأییدشده؛ `info.known=false` ← دلیل |
| `attachments <id>` | `GET /api/repos/:repo/tasks/:id` | **allow.** فهرست ِ پیوست‌ها (نام، نوع، اندازه، زمان؛ فریم‌ها زیر ویدیو؛ «فقط برای انسان»؛ «فایل روی دیسک نیست»). آپلود از راه دور **نیست** |
| `approve-deps <id>` / `reject-deps <id>` | `POST /api/repos/:repo/tasks/:id/approve-dependencies` / `…/reject-dependencies` | **ask.** `answer --approve-dependencies\|--reject-dependencies --reason` (reason اجباری، از فایل ِ موقت؛ پیش‌سنجی از `actions.approveDependencies/rejectDependencies`). بعد از تصمیم مثل بقیه‌ی گیت‌ها اگر `run.autoResumeAfterAnswer` روشن است run می‌زند |
| `recheck <id>` | `POST /api/remote/tasks/:id/recheck` | **ask.** `manager.js recheck <id>` (TOOLING-048): attempt ِ ردشده با گارد ِ Manager (یا خطای ابزار ِ نوشتن، TOOLING-049) دوباره سنجیده می‌شود، **بدون agent، بدون attempt ِ تازه، بدون مصرف ِ budget**. پیش‌سنجی از `actions.recheck`؛ نتیجه از رویداد ِ `attempt.rechecked` (`accepted` · `rejected` · `blocked` · `routed`) |
| `retry-install <id>` | `POST /api/remote/tasks/:id/retry-install` | alias ِ یک نسخه‌ی `retry-provision` (همیشه هم‌مقدار) |
| `runtime <id>` | `GET /api/repos/:repo/tasks/:id` + `GET …/running` | جدول ِ مؤثر ِ هر نقش (از کلیدهای `runtime.effective`) با منبع، نقش ِ جاری (attempt ِ زنده، وگرنه lastAttempt)، attempt ِ زنده، و تغییرهای در صف («در انتظار اعمال») |
| `runtime-options` | `GET /api/repos/:repo/runtime-options` | `manager.js runtime --options --json`: providerها (آماده بودن)، مدل‌ها + effort ِ مجاز ِ هر مدل، پیش‌فرض‌ها و presetها |
| `set-runtime` | `POST /api/repos/:repo/tasks/:id/runtime` | `answer --runtime` / `--runtime-preset` / `--runtime-reset` با `--reason-file`؛ فقط attemptهای بعدی (با attempt ِ زنده در صف می‌نشیند). پیش‌سنجی از `actions.setRuntime`؛ اعتبارسنجی ِ معنایی با Manager |
| `create-* --runtime…` | `POST /api/tasks/create` · `POST /api/issues/import` | flagهای `import-issue` ِ Manager: `--runtime-preset`، `--runtime <role>=<p>:<m>:<e>`، و `--allow-duplicate --reason` (exit 44 ← «این issue قبلاً تسک #N دارد»؛ exit 45 ← runtime نامعتبر، تسکی ساخته نمی‌شود) |
| `sync` / `sync --dry-run` | `POST /api/remote/sync` + `GET /api/remote/execs/:id` | همان `manager.js sync` ِ کانبان (ff/push/merge، هرگز rebase) با پیام روشن برای exit code ۵۰ تا ۵۷؛ تا ~۱۰۰ ثانیه صبر می‌کند وگرنه `sync --status <execId>` |
| `drain` | `POST /api/drain` | **ask.** تخلیه روشن: run ِ تازه (دستی و خودکار) شروع نمی‌شود، in-flight ها ادامه می‌دهند، تسک‌های ِ «می‌خواستند شروع شوند» در صف می‌مانند (در `drain.json` ذخیره می‌شود و بعد از restart هم می‌ماند) |
| `drain --status` | `GET /api/drain` | **allow.** «خالی» یا فهرست ِ run های زنده با state و مدت |
| `drain --off` | `POST /api/drain/off` | **ask.** برگشت به حالت عادی و شروع ِ صف |
| `kill-stuck-install <id>` | `POST /api/remote/tasks/:id/kill-stuck-install` | فقط فرزندان مستقیم ِ یک `npm ci` (lifecycle scriptها) در **درخت ِ فرآیند ِ ثبت‌شده در registry ِ کانبان** برای همین تسک، که بیش از N دقیقه (پیش‌فرض ۵) عمر دارند. هیچ جست‌وجوی متنی روی کل سیستم، هیچ pid ِ دلخواه، هیچ ری‌استارت سرویس |
| `answer --allow-shared-knowledge-file <path>` | `POST /api/repos/:repo/tasks/:id/allow-shared-knowledge-file` | همان endpoint ِ دکمه‌ی رابط کاربری؛ پیش‌سنجی از `actions.allowSharedKnowledgeFile` |

امنیت `diag`/`bundle`/`artifact`: فقط خواندنی؛ هر متن از redactor ِ مشترک می‌گذرد (راز محیط، توکن، `Authorization`، کلید PEM/AWS،
`user:pass@` در URL، و `BARSA_ISSUE_USER_ID`)؛ argv ِ فرآیندها پیش از نمایش پوشانده می‌شود؛ هیچ مسیر/فرمان دلخواهی از ورودی کاربر ساخته نمی‌شود
(مسیرها از `status` ِ Manager، نام artifact از فهرست بسته).

**عمداً بیرون از CLI** (ثابت `NOT_REMOTE_COMMANDS` و `NOT_REMOTE_ANSWER_FLAGS` در `server/src/remote-cli-spec.js`؛ CLI می‌گوید
«این تصمیم را از رابط کاربری کانبان بگیر»): `abandon`، `void`، `unlock`، `cancel`، `--external-access`، `--reset-external`،
`--stage-external`، `--external-checked-in`، (و `--allow-path`، `--close-orphan`)، کنسول ِ آزاد. عبارت «از رابط کاربری» فقط برای همین‌ها گفته می‌شود.
سرور هم برای توکن remote فقط endpointهای `REMOTE_ENDPOINTS` را باز می‌گذارد؛ حتی با توکن لو رفته abandon/console ممکن نیست.

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
| `health` | `ok, checkedAt, execution{enabled,status,detail}, sync{status,ahead,behind,lastFetchAt,detail}, claude{installed,auth}, drain{draining,live,queued}, problems[{id,status,label,detail,hint}]` |
| `issues` | `issues[{externalId,title,status,labels,importedTaskId,importedRepoId}], hiddenImported` |
| `tasks` | `repo, filter, generatedAt, total, truncated, execution, tasks[{id,title,state,stateSince,gate{kind,since}\|null,blocker{kind,detail}\|null,running,queued,actions[]}]` |
| `task` | `id, title, state, stateSince, gate, running{running,queued,exitCode}, actions, blocker, health{stuck,reasons,lock,recovery,install}, review{…}, releaseNote, diff{headCommit,files[]}, externalSources[], budget, waiting{kind,since,artifact,questions\|proposal\|review+releaseNote+diff+external,hint}` |
| `artifact` | بدون نام: `taskId, artifacts[], attempts[], perAttempt[], extra[], lastAttempt` — با نام: `taskId, name, attempt, path, bytes, totalLines, shownLines, truncated, tail, text` |
| `diag <id>` | `taskId, repo, generatedAt, state, gate, blocker, health, actions[], summary, events[], log{runId,…,lines[]}, processes[{pid,ppid,name,startedAt,ageSec,cpuSeconds,cmd}], taskDirGit, worktree{path,exists,branch,merged,ownCommits,nodeModulesBin,dirty[]}, queue{state,position,slotsUsed,slotsMax}` |
| `diag --system` | `service, processes[], locks, slots, repository{sync,execution}, git{status[],worktrees[]}, disk[], errLog{file,lines[]}, tools{node,npm,git,claude,tf}, issues{count}` |
| `bundle` | `ok, taskId, name, path, bytes, files, skipped` |
| `deps` | `id, gate{attempt,requestedAt,peersOk,dependencies[{name,version,dev,reason,known,error,license,hasInstallScript,peers[{name,range,installed,satisfied,optional,status}],peersOk}]}\|null, peerProblem, approved[], actions{approveDependencies,rejectDependencies}` |
| `attachments` | `id, available, items[{id,name,file,kind,ext,size,sha256,addedAt,stage,source,reason,humanOnly,derivedFrom,exists}]` (بدون `path`) |
| `recheck` | `ok, taskId, result, event{attempt,previousGuard,result,budgetConsumed,at}\|null, output[]` |
| `drain` | `changed?, draining, since, by, empty, live[{repoId,taskId,runId,user,startedAt,state,durationMs,durationText}], queued[{repoId,taskId,user,queuedAt}], execs[]` |
| `recover` / `retry-install` / `kill-stuck-install` / `sync` | `ok, taskId, mode, output[]` / `ok, queued, started, duplicate` / `ok, killed[{pid,name,ageMin,cmd}], remaining[], note` / `ok, execId, finished, exitCode, lines[]` |
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
