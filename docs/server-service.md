# اجرای کانبان به‌صورت سرویس روی سرور ویندوزی

> این سند **پیشنهاد و قدم‌ها** است. کانبان خودش هیچ سرویسی نصب نمی‌کند و هیچ‌جای کد چنین کاری نیست؛
> قدم‌ها را یک بار مدیر سرور (با دسترسی Administrator) اجرا می‌کند.

هدف: بعد از reboot خودکار بالا بیاید، لاگ بگیرد، و با **یک حساب مشخص** اجرا شود که همان حساب `tf` و `claude` را هم
اجرا می‌کند.

> **تصمیم‌های واقعی این سرور (مالک سیستم)** — نمونه‌های پایین با همین‌ها نوشته شده‌اند:
>
> | موضوع | تصمیم |
> |---|---|
> | حساب سرویس | کاربر ویندوزی موجود **`client01`** (نه حساب جدا) |
> | مسیر کانبان | `D:\BarsaAgent` |
> | config | **بیرون از مخزن**: `D:\barsa-agent-data\barsa-agent.config.yml`، با `BARSA_AGENT_CONFIG` |
> | `dataDir` | `D:\barsa-agent-data` |
> | پروکسی | **بدون پروکسی: `run.proxy: ""`** (پایین را ببین) |
> | `BARSA_ISSUE_USER_ID` | در `AppEnvironmentExtra` ِ NSSM |
> | به‌روزرسانی Manager | فقط با اکشن **`sync`** ِ کانبان |
>
> ⚠ **`run.proxy: ""` را حتماً بگذار.** نبودن کلید `run.proxy` یعنی پیش‌فرض `http://127.0.0.1:10808` (پروکسی سیستم توسعه)
> که روی سرور وجود ندارد و **همه‌ی agentها را خراب می‌کند**. فقط رشته‌ی خالی صریح یعنی «بدون پروکسی»
> (`HTTP_PROXY`/`HTTPS_PROXY` را حتی اگر در env ِ سرور باشند حذف می‌کند).
>
> ```yaml
> run:
>   proxy: ""   # بدون پروکسی؛ توضیح بعد از مقدار اشکالی ندارد (پارسر YAML واقعی است)
> dataDir: "D:/barsa-agent-data"
> ```

## ۱. چرا یک حساب مشخص (و چرا همان حساب برای `tf` و `claude`)

سه چیز به‌جای سیستم، به **پروفایل کاربر** وصل‌اند:

| چیز | کجا نگه‌داری می‌شود |
|---|---|
| ورود `claude` (`claude auth login`) | پروفایل همان کاربر (`%USERPROFILE%\.claude`) |
| workspace و اعتبار `tf` (TFVC، فاصله‌ی WebIII) | پروفایل و workspace همان کاربر |
| کلید/credential ِ git و پروکسی کاربر | پروفایل همان کاربر |

اگر سرویس با `LocalSystem` اجرا شود هیچ‌کدام را نمی‌بیند و Manager/agentها بدون هشدار شکست می‌خورند. پس:

> **تصمیم این سرور:** حساب سرویس همان کاربر ویندوزی موجود `client01` است (تصمیم صاحب سیستم). هشدار این بخش درباره‌ی
> **حساب جدا و بدون دسترسی اضافه** سر جایش می‌ماند — اگر `client01` Administrator است، سرویس هم با آن سطح دسترسی اجرا
> می‌شود (کانبان فرمان اجرا می‌کند). بقیه‌ی قدم‌ها با `client01` همان است.

1. یک حساب اختصاصی بساز، مثلاً `SRV\svc-barsa-agent` (محلی یا دامنه‌ای؛ **نه** Administrator) — *روی این سرور: `client01` موجود.*
2. حق «Log on as a service» (`secpol.msc` ← Local Policies ← User Rights Assignment) به او بده.
3. دسترسی NTFS (Modify) فقط به این مسیرها: مخزن Manager، پوشه‌ی worktreeهای ابزار (`tooling.worktreesDir`)، مخزن
   shadow، WebIII، پوشه‌ی `dataDir` کانبان، و پوشه‌ی لاگ سرویس.
4. **یک بار با همان حساب** وارد شو (`runas /user:SRV\svc-barsa-agent cmd` یا Remote Desktop) و این‌ها را انجام بده:
   - `claude auth login` (و تأیید با `claude auth status`)
   - ساخت/اتصال workspace ِ `tf` و یک `tf` تست
   - `git config --global user.name/user.email` (merge ِ ابزار commit می‌سازد)
5. در همان نشست `npm ci` و `npm run build` را در پوشه‌ی کانبان (`D:\BarsaAgent`) اجرا کن، و یک حساب ورود بساز:

```powershell
cd D:\BarsaAgent
npx ng analytics disable --global     # یک بار؛ وگرنه اولین build ِ angular.json را کثیف می‌کند (cli.analytics)
npm ci
npm run build
$env:BARSA_AGENT_CONFIG = 'D:\barsa-agent-data\barsa-agent.config.yml'
npm run user:add -- <نام-کاربری>      # گذرواژه‌ی مخفی می‌پرسد؛ حداقل ۱۰ نویسه
```

`user:add` به `BARSA_ISSUE_USER_ID` نیازی ندارد. `.env.local` (اگر استفاده می‌کنی) از کنار config یا کنار برنامه
(`D:\BarsaAgent\.env.local`) خوانده می‌شود؛ متغیر محیطی ِ از پیش تنظیم‌شده (NSSM) بر فایل مقدم است.

## ۲. ابزار پیشنهادی: NSSM

[NSSM](https://nssm.cc) (Non-Sucking Service Manager). دلیل انتخاب: `node` یک برنامه‌ی کنسولی است و خودش سرویس ویندوز
نیست؛ NSSM آن را بدون تغییر کد می‌پیچد، با حساب مشخص اجرا می‌کند، stdout/stderr را به فایل می‌برد (با چرخش فایل)، و
بعد از خرابی دوباره بالا می‌آورد. جایگزین هم‌ارز: [WinSW](https://github.com/winsw/winsw) (همان کار با یک فایل XML کنار
exe). «Task Scheduler با trigger ِ At startup» هم کار می‌کند ولی restart بعد از خرابی و چرخش لاگ ندارد؛ فقط راه
اضطراری است.

### قدم‌ها (PowerShell با Administrator)

مسیرها همان تصمیم‌های بالاست: `D:\BarsaAgent` پوشه‌ی کانبان و `D:\barsa-agent-data` داده و config.

```powershell
$svc = 'BarsaAgent'
$app = 'D:\BarsaAgent'
$data = 'D:\barsa-agent-data'
$logs = 'D:\BarsaAgent-logs'
New-Item -ItemType Directory -Force $logs | Out-Null

nssm install $svc "C:\Program Files\nodejs\node.exe" "server\src\index.js"
nssm set $svc AppDirectory $app
nssm set $svc DisplayName "BarsaAgent Kanban"
nssm set $svc Description "Kanban console for Manager (BarsaAgent)"

# حساب مشخص (همان حساب tf و claude) — روی این سرور: کاربر موجود client01
nssm set $svc ObjectName ".\client01" "<گذرواژه>"

# بعد از reboot خودکار
nssm set $svc Start SERVICE_AUTO_START

# لاگ با چرخش (۱۰ مگابایت)
nssm set $svc AppStdout "$logs\kanban.out.log"
nssm set $svc AppStderr "$logs\kanban.err.log"
nssm set $svc AppRotateFiles 1
nssm set $svc AppRotateOnline 1
nssm set $svc AppRotateBytes 10485760

# config بیرون از مخزن و راز در متغیر محیطی (نه در فایل ثبت‌شده در git): BARSA_ISSUE_USER_ID فقط اینجا
nssm set $svc AppEnvironmentExtra "BARSA_AGENT_CONFIG=$data\barsa-agent.config.yml" "BARSA_ISSUE_USER_ID=<شناسه>"

# خرابی → ۵ ثانیه بعد دوباره بالا بیاید
nssm set $svc AppExit Default Restart
nssm set $svc AppRestartDelay 5000

# توقف: NSSM یک Ctrl+C به کنسول می‌فرستد (← SIGINT در node)؛ کانبان در حداکثر ۱۰ ثانیه خودش خارج می‌شود.
# مقدارها و دلیلشان: «توقف تمیز» پایین. (قبلاً ۶۰۰۰۰۰ بود؛ اشتباه بود: با SSE ِ باز هرگز زودتر تمام نمی‌شد.)
nssm set $svc AppStopMethodConsole 15000
nssm set $svc AppStopMethodWindow 0
nssm set $svc AppStopMethodThreads 0
nssm set $svc AppKillProcessTree 1

nssm start $svc
```

بعد از شروع:

1. در لاگ باید `BarsaAgent: http://127.0.0.1:4310` و `Manager <id>: … · Contract v1` ببینی (و اگر `.env.local` خوانده شد،
   مسیر فایل و **نام** کلیدها چاپ می‌شود، نه مقدارشان).
2. وارد شو و صفحه‌ی **«سلامت محیط»** را باز کن: `node`، `git`، `claude`، احراز هویت `claude`، پروکسی، `pwsh`،
   مسیرهای مخزن/shadow/WebIII و دیسک باید سبز باشند.
3. اگر `claude` قرمز بود چون فقط `claude.cmd` وجود دارد: مسیر `claude.exe` را در `health.claude.command` بگذار
   (کانبان بدون shell اجرا می‌کند و `.cmd` را بدون shell نمی‌تواند اجرا کند).

### توقف تمیز: NSSM، سیگنال و مقدارهای پیشنهادی

**شاهد ِ مشکل:** `nssm stop BarsaAgent` دو بار در `SERVICE_STOP_PENDING` ماند (یک بار حتی بدون هیچ run ِ زنده). علت ِ ریشه‌ای: کد ِ قبلی
`server.close(cb)` را صدا می‌زد و `process.exit` فقط در `cb` بود؛ `server.close` تا بسته شدن ِ **همه‌ی** اتصال‌ها صبر می‌کند و
اتصال ِ SSE ِ لاگ زنده (ping هر ۱۵ ثانیه) هیچ‌وقت نمی‌بندد؛ جدا از آن، با run ِ زنده بی‌پایان صبر می‌کرد.

**NSSM هنگام `stop` چه می‌کند** (`AppStopMethod*` به ترتیب، هر کدام مهلت ِ خودش؛ `0` = آن روش را رد کن):

| روش | کار | برای کانبان |
|---|---|---|
| `AppStopMethodConsole` | یک Ctrl+C (`CTRL_C_EVENT`) به کنسول ِ برنامه | **روش ِ اصلی.** node آن را `SIGINT` می‌بیند (`CTRL_BREAK` ← `SIGBREAK`، بستن کنسول/خاموشی ← `SIGHUP`)؛ کانبان هر چهار را می‌گیرد |
| `AppStopMethodWindow` | `WM_CLOSE` به پنجره‌های برنامه | node پنجره ندارد ← `0` |
| `AppStopMethodThreads` | `WM_QUIT` به threadها | node حلقه‌ی پیام ندارد ← `0` |
| (آخر) `TerminateProcess` | کشتن ِ فوری | وقتی سه روش بالا در مهلتشان نتیجه ندهند |
| `AppKillProcessTree` | کشتن ِ **درخت ِ فرآیند ِ فرزندان** (پیش‌فرض ۱) | طبق مستندات ِ NSSM هنگام ِ stop درخت ِ فرزندان ِ باقی‌مانده را هم می‌بندد (نه فقط node) |

**مقدارهای پیشنهادی و دلیل:**

| تنظیم | مقدار | دلیل |
|---|---|---|
| `AppStopMethodConsole` | `15000` | کانبان سقف ِ `shutdown.timeoutMs` (پیش‌فرض ۱۰۰۰۰) خودش را دارد؛ NSSM باید کمی بیشتر صبر کند تا کانبان آن سقف را خودش اعمال و **لاگ ِ handle ِ باز** را بنویسد، نه اینکه NSSM زودتر بکشد. ۶۰۰۰۰۰ (۱۰ دقیقه) غلط بود: صبر برای run ها کار ِ **drain** است (پایین)، نه کار ِ مهلت ِ stop؛ run ِ Manager گاهی ۳۰ دقیقه است. |
| `AppStopMethodWindow` / `Threads` | `0` | بی‌معنی برای node؛ فقط زمان ِ stop را بی‌دلیل زیاد می‌کنند |
| `AppKillProcessTree` | `1` (پیش‌فرض؛ **عمداً صریح**) | اگر فرزندی (`claude`، `git`، `npm ci` ِ run) بماند، worktree و پوشه‌ی موقت را قفل نگه می‌دارد (EPERM) و `start` ِ بعدی با اجرای یتیم قاطی می‌شود. با `0` ممکن است اجرای یتیم جلوی `git pull`/`npm ci` ِ به‌روزرسانی را بگیرد |
| `AppExit Default Restart` | همان قبلی | `nssm stop` را «خرابی» حساب نمی‌کند؛ restart فقط برای خروج ِ ناخواسته است |

```powershell
nssm set BarsaAgent AppStopMethodConsole 15000
nssm set BarsaAgent AppStopMethodWindow 0
nssm set BarsaAgent AppStopMethodThreads 0
nssm set BarsaAgent AppKillProcessTree 1
```

**رفتار ِ کانبان بعد از سیگنال** (`server/src/shutdown.js`، لاگ با پیشوند `[shutdown]`، سقف ِ کل ۱۰ ثانیه):

1. درخواست ِ تازه `503` می‌گیرد و هیچ run ِ تازه‌ای از صف شروع نمی‌شود؛
2. سرور ِ HTTP **همراه با** اتصال‌های باز (SSE، keep-alive) بسته می‌شود؛ timerها (ping ِ SSE و ...) می‌ایستند؛
3. **run های زنده**: اسم ِ هر کدام (`#id`، مخزن، مدت) و فرمان ِ بازیابی در لاگ می‌آید (`node scripts/manager.js run <id>` یا `barsa run <id>`)؛ سپس
   درخت ِ فرآیندشان بسته می‌شود و یک ردیف ِ ممیزی `shutdown.run-interrupted` می‌ماند. transition ِ نیمه‌کاره با قفل ِ مرده را
   Manager در `run` ِ بعدی خودش پس می‌گیرد (TOOLING-030)؛
4. اگر چیزی جلوی خروج را بگیرد، در مهلت **نام ِ handle ِ باز** (مثل `Timeout×2، TCPSocketWrap×1`) در لاگ می‌آید و خروج ِ اجباری (کد ۱) است؛
   سیگنال ِ دوم = خروج ِ فوری.

**چه رفتاری برای run ِ زنده پیشنهاد می‌شود؟** *نگذار stop با run ِ زنده روبه‌رو شود.* مسیر ِ عادی ِ به‌روزرسانی `drain` است (پایین): تا «خالی» نشده
stop نمی‌زنی. اگر با وجود این سرویس وسط ِ run کشته شد (برق، `nssm stop` ِ اضطراری)، پیش‌فرض `shutdown.liveRuns: terminate` درخت ِ run را **تمیز** می‌بندد و
اسمش را در لاگ می‌نویسد (بهتر از رها کردن ِ فرزند ِ بی‌پدر که تا آخر ِ `AppKillProcessTree` یا reboot می‌ماند). `leave` فقط برای وقتی است که
عمداً می‌خواهی NSSM (`AppKillProcessTree=1`) خودش درخت را ببندد. نگه‌داشتن ِ سرویس برای پایان ِ run ها (`shutdown.runWaitMs`، پیش‌فرض ۰) فقط تا
جایی معنی دارد که از (`AppStopMethodConsole` − ۵ ثانیه) کمتر باشد؛ برای مدت ِ طولانی از drain استفاده کن.

```yaml
# barsa-agent.config.yml (همه اختیاری)
shutdown:
  timeoutMs: 10000     # سقف ِ کل ِ خاموش شدن (≥ 1000)؛ باید از AppStopMethodConsole کمتر باشد
  runWaitMs: 0         # صبر برای پایان ِ طبیعی ِ run های زنده پیش از بستنشان
  liveRuns: terminate  # terminate | leave
```

### توقف، restart، حذف

```powershell
nssm stop BarsaAgent        # ≤ ۱۰ ثانیه؛ اگر run ِ زنده هست اول drain (پایین)
nssm restart BarsaAgent
nssm remove BarsaAgent confirm
```

قبل از stop/restart **تخلیه** کن (`barsa drain` یا دکمه‌ی «تخلیه» در «نگهداری») و صبر کن تا «خالی» شود. اگر مجبور شدی وسط
اجرا بکشی، همان قفل جامانده را صفحه‌ی task (بخش «بازیابی») نشان می‌دهد و اجرای بعدی Manager خودش پس می‌گیرد.

## ۳. شبکه و TLS

کانبان **پیش‌فرض فقط روی `127.0.0.1`** گوش می‌دهد. چون فرمان اجرا می‌کند، مستقیم روی شبکه باز نشود:

- روی همان سرور یک reverse proxy با TLS بگذار (IIS + ARR، Caddy یا nginx برای ویندوز) که به `http://127.0.0.1:4310`
  برود.
- در config:
  ```yaml
  auth:
    secureCookie: true                       # کوکی نشست فقط روی HTTPS
    allowedOrigins: ["https://agent.example.local"]   # Origin ِ مجاز برای CSRF
  ```
- برای SSE (لاگ زنده) در proxy، buffering را خاموش کن و timeout ِ پاسخ را بالا ببر (لاگ یک run می‌تواند ساعت‌ها
  باز بماند). هدر `X-Accel-Buffering: no` را خود کانبان می‌فرستد.
- فقط اگر واقعاً لازم است، `server.host` را صریحاً عوض کن؛ در آن حالت کانبان هنگام شروع هشدار می‌دهد.

## ۴. داده‌های کانبان

`dataDir` (پیش‌فرض `%USERPROFILE%\.barsa-agent` ِ حساب سرویس؛ بهتر است صریح در config بگذاری، مثلاً
`D:\barsa-agent-data`) **باید بیرون از هر مخزن** باشد (کانبان خودش اگر داخل مخزن باشد شروع نمی‌شود):

| فایل | محتوا |
|---|---|
| `audit.jsonl` | دفتر ممیزی append-only (JSON lines): کاربر، زمان، argv، cwd، exit code، مدت، مسیر خروجی |
| `outputs/<id>.log` | خروجی کامل هر اجرا (با زمان) |
| `users.json` | کاربران و hash ِ گذرواژه (scrypt) |
| `isolation-proofs.json` | آخرین نتیجه‌ی «آزمون جداسازی» هر شاخه و commit |
| `uploads\<uuid>\<نام>` + `uploads\<uuid>.json` | **آپلود ِ موقت ِ پیوست‌ها** (پایین)؛ بعد از `attach`/`--attach` پاک می‌شود، وگرنه بعد از ۲ ساعت (و هنگام ِ شروع) |

- از کل پوشه بک‌آپ بگیر. `audit.jsonl` را هرگز ویرایش نکن؛ برای آرشیو، سرویس را stop کن، فایل را به یک پوشه‌ی آرشیو
  منتقل کن و دوباره start کن.
- `outputs\` با گذشت زمان بزرگ می‌شود؛ فایل‌های قدیمی‌تر از مثلاً ۹۰ روز را می‌شود پاک کرد (رکورد ممیزی می‌ماند و
  فقط «لاگ» آن دیگر قابل دانلود نیست).

## ۵. به‌روزرسانی

- **Manager** (`scripts/manager.js` و …): **فقط** با اکشن «همگام‌سازی با origin (sync)» در صفحه‌ی «نگهداری مخزن ابزار» (فرمان
  `node scripts/manager.js sync --json`؛ «پیش‌نمایش» همان با `--dry-run`). کانبان خودش `git fetch/merge` یا `npm ci` ِ مخزن Manager را
  نمی‌زند و دستی هم نباید زد: سرور روی `main` ِ خودش commit می‌سازد (`chore(agent-work)`، merge ِ کد هر تسک) پس `merge --ff-only`
  بعد از اولین commit ِ سرور همیشه رد می‌شد. `sync` خودش تصمیم می‌گیرد: برابر ← هیچ؛ عقب ← ff؛ جلو ← push؛ واگرا ← merge ِ واقعی
  (هرگز rebase) + push؛ برخورد ← abort و فهرست فایل‌ها؛ `npm ci` فقط با تغییر `package-lock.json`.
  - **زمان:** `npm ci` تا ۲۰ دقیقه و hook ِ `pre-push` ِ سنگین (`ng lint` و `ng build`) روی push ِ main تا ۳۰ دقیقه؛ خروجی زنده در لاگ اجرا
    دیده می‌شود. سرویس را وسط sync stop نکن.
  - **کدها:** `50` پیش‌شرط (باید روی main، درخت تمیز، بدون اجرای زنده)، `51` fetch، `52` برخورد (فهرست فایل‌ها نمایش داده می‌شود،
    هیچ push ای نشده)، `53`/`54` push، `55`/`56` `npm ci`، `57` merge. با `execution.enabled=false` هم کار می‌کند.
- **خود کانبان**: از داخل کانبان قابل به‌روزرسانی نیست (عمداً). روال ِ کامل (در `D:\BarsaAgent`) با **تخلیه**:

  | # | قدم | فرمان |
  |---|---|---|
  | ۱ | تخلیه روشن (run ِ تازه، دستی و خودکار، شروع نمی‌شود؛ in-flight ها ادامه می‌دهند؛ تسک‌ها در صف می‌مانند) | دکمه‌ی «تخلیه» در «نگهداری» یا `./barsa drain` |
  | ۲ | صبر تا «خالی» (فهرست ِ run های زنده با state و مدت) | `./barsa drain --status` را تکرار کن؛ بنویسد «✅ خالی» |
  | ۳ | توقف | `nssm stop BarsaAgent` |
  | ۴ | کد | `git pull --ff-only` |
  | ۵ | وابستگی‌ها | `npm ci` |
  | ۶ | ساخت | `npm run build` |
  | ۷ | شروع | `nssm start BarsaAgent` |
  | ۸ | بعد از بالا آمدن: **حالت تخلیه از `drain.json` برمی‌گردد** (عمداً؛ تا restart ناخواسته صف را شروع نکند). بررسی کن، بعد برگرد به حالت عادی و صف شروع می‌شود | `./barsa health` ← `./barsa drain --off` |

  - حالت و صف ِ نگه‌داشته‌شده در `<dataDir>\drain.json` است و **از restart جان به در می‌برد**؛ `drain --off` فایل را پاک می‌کند.
  - اگر قدم ۲ زمان‌بر شد (run ِ ۳۰ دقیقه‌ای): صبر کن، یا از رابط کاربری `stop` ِ همان تسک را بزن و بعد `recover`/`run`.
  - `sync` ِ Manager هم با run ِ زنده رد می‌شود؛ همین دو قدم اول و آخر را بگذار (`drain` ← `sync` ← `drain --off`). با تخلیه روشن، تسک‌های **در صف** مانع ِ sync نیستند (شروع نمی‌شوند).
  - از گوشی (Remote Control): `barsa drain` ← `barsa drain --status` تا خالی ← `barsa sync` ← `barsa drain --off` (روتین در `docs/remote-control/CLAUDE.md`). به‌روزرسانی ِ **خود کانبان** (قدم ۳ تا ۷) همچنان فقط روی سرور است.

  **بار ِ اول (کانبان ِ فعلی هنوز drain ندارد):** نسخه‌ی در حال اجرا نه `drain` را می‌شناسد، نه خاموش شدن ِ تمیز دارد (با SSE ِ باز در STOP_PENDING می‌ماند). پس:
  1. در رابط کاربری مطمئن شو هیچ run ِ زنده/در صف نیست (نوار ِ «در صف/در حال اجرا»؛ لازم بود `stop` بزن) و همه‌ی تب‌های مرورگر ِ کانبان (SSE) را ببند؛
  2. **پیش از stop** مهلت را کم کن تا کانبان ِ قدیمی تا ۱۰ دقیقه آویزان نماند: `nssm set BarsaAgent AppStopMethodConsole 15000`، `AppStopMethodWindow 0`، `AppStopMethodThreads 0`، `AppKillProcessTree 1` (روی سرویس ِ در حال اجرا هم قابل تنظیم است و برای stop ِ بعدی اعمال می‌شود)؛
  3. `nssm stop BarsaAgent`؛ نسخه‌ی قدیمی در ۱۵ ثانیه خودش خارج نمی‌شود، NSSM می‌کشدش — چون run ِ زنده‌ای نبود اشکالی ندارد؛
  4. `git pull --ff-only` ← `npm ci` ← `npm run build` ← `nssm start BarsaAgent`؛
  5. بررسی: `./barsa drain --status` باید «تخلیه: خاموش» بدهد و در «سلامت محیط» ردیف ِ «حالت تخلیه» سبز باشد. از این به بعد روال ِ جدول ِ بالا کار می‌کند.

## ۶. فهرست بررسی امنیتی قبل از باز کردن به روی شبکه

- [ ] حساب سرویس: روی این سرور `client01` (تصمیم صاحب سیستم)؛ هشدار «حساب اختصاصی، نه Administrator و نه LocalSystem» را ببین و آگاهانه بپذیر
- [ ] `run.proxy: ""` در config (نبودنش = پروکسی `127.0.0.1:10808` که روی سرور نیست)
- [ ] `server.host` همان `127.0.0.1` است و proxy ِ TLS جلوی آن است
- [ ] `auth.secureCookie: true` و `auth.allowedOrigins` تنظیم شده
- [ ] `npm run user:list` فقط حساب‌های لازم را نشان می‌دهد
- [ ] `dataDir` بیرون از مخزن‌ها و فقط برای حساب سرویس قابل نوشتن است
- [ ] صفحه‌ی «سلامت محیط» کاملاً سبز است

### پیوست ِ فایل (TOOLING-050 د)

- **پیش‌نیاز در Manager:** `attachments.root` را **فقط** در `.agent-work/config/repository.local.yaml` ِ همین دستگاه بگذار (بیرون از git؛ پشتیبان بگیر)، مثلاً
  `attachments: { root: "D:/barsa-agent-data/attachments" }`. بدون آن `attach` / `--attach` با پیام ِ روشن رد می‌شود و پیش‌نمایش/دانلود هم نیست.
  فهرست ِ مجاز ِ پسوند و سقف ِ اندازه‌ی هر نوع (`attachments.kinds`) را خود ِ Manager دارد؛ کانبان همان را (فقط‌خواندنی) از
  `scripts/lib/attachments.js` می‌خواند و پیش از آپلود می‌سنجد. تصمیم ِ نهایی همیشه با Manager است.
- **مسیر ِ آپلود:** مرورگر فایل را با `POST /api/uploads` (بدنه‌ی خام، نه base64) می‌فرستد ← کانبان در `<dataDir>\uploads\<uuid>\` می‌گذارد ←
  Manager را با `attach <id> --file … --name … --reason "added from Kanban console"` (تسک ِ موجود) یا `--attach <مسیر>` (ساخت با `import-issue`،
  `answer --note`، `answer --clarify`) صدا می‌زند ← فایل ِ موقت پاک می‌شود. **کانبان هرگز در `attachments.root` نمی‌نویسد**؛ Manager صاحب ِ آن است
  (کپی، sha256، `attachments.json`، commit). پیش‌نمایش/دانلود فقط از مسیری است که Manager در `status` می‌دهد و بعد از `realpath` باید زیر
  `<root>\<taskId>\` باشد؛ فقط تصویر inline نشان داده می‌شود (`nosniff` + CSP ِ sandbox)، بقیه دانلود.
- **سقف‌ها:** (۱) هر فایل: کمینه‌ی «سقف ِ نوع در Manager» (پیش‌فرض: تصویر ۱۰MB، PDF ۲۵MB، متن ۲MB، ویدیو ۲۰۰MB) و `attachments.maxUploadBytes`
  ِ کانبان (پیش‌فرض ۲۰۰MB)؛ سقف هنگام ِ دریافت اعمال می‌شود (بایت‌شماری در جریان، نه بعد از ذخیره)؛ (۲) `attachments.maxFiles` (پیش‌فرض ۲۰) فایل در هر
  درخواست و هر کاربر ۲۰ آپلود ِ مصرف‌نشده؛ (۳) پسوندهای اجرایی/اسکریپت/`.svg`/`.html` را **هیچ config ای** مجاز نمی‌کند (فهرست ِ Manager).
  آپلود از گوشی (Remote Control) نیست؛ `barsa attachments <id>` فقط فهرست می‌دهد.

```yaml
# barsa-agent.config.yml (همه اختیاری)
attachments:
  maxUploadBytes: 209715200   # سقف ِ هر فایل در سرور (بایت)؛ سقف ِ نوع در Manager هم جدا اعمال می‌شود
  maxFiles: 20                # حداکثر پیوست در یک درخواست
```
