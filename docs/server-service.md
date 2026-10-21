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

# توقف تمیز: کانبان با Ctrl+C منتظر پایان اجراهای در جریان می‌ماند (app.js، registerShutdownOnce).
# به NSSM تا ۱۰ دقیقه مهلت بده؛ بعد از آن می‌کشد (ممکن است قفل جامانده بماند → TOOLING-030).
nssm set $svc AppStopMethodConsole 600000
nssm set $svc AppStopMethodWindow 0
nssm set $svc AppStopMethodThreads 0

nssm start $svc
```

بعد از شروع:

1. در لاگ باید `BarsaAgent: http://127.0.0.1:4310` و `Manager <id>: … · Contract v1` ببینی (و اگر `.env.local` خوانده شد،
   مسیر فایل و **نام** کلیدها چاپ می‌شود، نه مقدارشان).
2. وارد شو و صفحه‌ی **«سلامت محیط»** را باز کن: `node`، `git`، `claude`، احراز هویت `claude`، پروکسی، `pwsh`،
   مسیرهای مخزن/shadow/WebIII و دیسک باید سبز باشند.
3. اگر `claude` قرمز بود چون فقط `claude.cmd` وجود دارد: مسیر `claude.exe` را در `health.claude.command` بگذار
   (کانبان بدون shell اجرا می‌کند و `.cmd` را بدون shell نمی‌تواند اجرا کند).

### توقف، restart، حذف

```powershell
nssm stop BarsaAgent        # صبر می‌کند اجراهای در جریان تمام شوند (تا مهلت بالا)
nssm restart BarsaAgent
nssm remove BarsaAgent confirm
```

قبل از stop/restart بهتر است در کانبان هیچ task ای در حال اجرا نباشد (نوار «در صف/در حال اجرا»). اگر مجبور شدی وسط
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
- **خود کانبان**: از داخل کانبان قابل به‌روزرسانی نیست (عمداً). روی سرور، به همین ترتیب:
  `nssm stop BarsaAgent` ← `git pull --ff-only` ← `npm ci` ← `npm run build` ← `nssm start BarsaAgent`
  (در `D:\BarsaAgent`).

## ۶. فهرست بررسی امنیتی قبل از باز کردن به روی شبکه

- [ ] حساب سرویس: روی این سرور `client01` (تصمیم صاحب سیستم)؛ هشدار «حساب اختصاصی، نه Administrator و نه LocalSystem» را ببین و آگاهانه بپذیر
- [ ] `run.proxy: ""` در config (نبودنش = پروکسی `127.0.0.1:10808` که روی سرور نیست)
- [ ] `server.host` همان `127.0.0.1` است و proxy ِ TLS جلوی آن است
- [ ] `auth.secureCookie: true` و `auth.allowedOrigins` تنظیم شده
- [ ] `npm run user:list` فقط حساب‌های لازم را نشان می‌دهد
- [ ] `dataDir` بیرون از مخزن‌ها و فقط برای حساب سرویس قابل نوشتن است
- [ ] صفحه‌ی «سلامت محیط» کاملاً سبز است
