export interface HumanGate {
  kind: 'spec-approval' | 'clarification' | 'merge-approval' | 'dependency-approval' | string;
  artifact?: string | null;
  since?: string | null;
}

// --- TOOLING-050: tests / پیوست / تأیید ِ وابستگی -----------------------------------------------------------

/** Case ِ دستی از tests.md (چک‌لیست ِ انسانی در دروازه‌ی merge؛ هرگز attempt را نمی‌بندد). */
export interface ManualCase { id: string; section: string | null; summary: string; typeSource?: string | null }
/** null = tests.md نیست. autoCases فقط شناسه‌اند. problems: آنچه parser نفهمید. */
export interface TestsInfo { format: 'canonical' | 'legacy' | 'mixed' | 'none' | string; autoCases: string[]; manualCases: ManualCase[]; problems: string[] }

export interface AttachmentItem {
  id: string; name: string; file: string; kind: 'image' | 'pdf' | 'text' | 'video' | string; ext: string; size: number; sha256: string; addedAt: string;
  stage: string | null; source: string; reason: string; humanOnly: boolean; derivedFrom: string | null;
  /** مسیر ِ مطلق روی ماشین ِ Manager؛ null اگر attachments.root تنظیم نیست. */
  path: string | null;
  /** false = فایل از دیسک رفته (پشتیبان را برگردان). */
  exists: boolean;
}
export interface TaskAttachments { root: string | null; items: AttachmentItem[] }

export interface DependencyPeerInfo { name: string; range: string; installed: string | null; satisfied: boolean | null; optional: boolean }
export interface DependencyInfo {
  known: boolean; error: string | null; version: string | null; license: string | null; hasInstallScript: boolean | null;
  peerDependencies: Record<string, string>; peers: DependencyPeerInfo[]; peersOk: boolean | null;
}
export interface DependencyApprovalItem { name: string; version: string; dev: boolean; reason: string; info: DependencyInfo }
/** فقط وقتی awaitingHuman.kind = dependency-approval؛ وگرنه null. */
export interface DependencyApproval { version: number; attempt: string; requestedAt: string; peersOk: boolean | null; dependencies: DependencyApprovalItem[] }
export interface ApprovedDependency { name: string; version: string; dev: boolean; reason: string }

/** سیاست ِ پیوست از Manager (GET /api/attachments/policy). available=false: Manager قدیمی‌تر؛ فقط سقف ِ سرور اعمال می‌شود. */
export interface AttachmentPolicy {
  available: boolean; configured: boolean | null;
  kinds: Record<string, { extensions: string[]; maxBytes: number }> | null; forbidden: string[] | null;
  maxUploadBytes: number; maxFiles: number;
}
export interface StagedUpload { id: string; name: string; size: number; ext: string; kind: string | null }

export interface BudgetItem { used: number; max: number }

/** runtime ِ یک attempt (TOOLING-046): آنچه درخواست شد و آنچه واقعاً اجرا شد. attempt ِ قدیمی: null/غایب. */
export interface AttemptRuntime {
  provider?: string | null;
  model?: string | null;
  requestedModel?: string | null;
  actualModels?: string[] | null;
  /** TOOLING-049: main-agent (agent ِ اصلی ِ session) | subagent-relay (attempt ِ قدیمی ِ Claude؛ فقط این‌ها outerModel دارند). */
  runMode?: 'main-agent' | 'subagent-relay' | null;
  outerModel?: string | null;
  requestedEffort?: string | null;
  effectiveEffort?: string | null;
  source?: string | null;
  preset?: string | null;
}

export interface Attempt {
  n: number;
  id: string;
  role?: string | null;
  runtime?: AttemptRuntime | null;
  outcome?: string | null;
  requestedTransition?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  artifacts: string[];
}

export interface SourceRef {
  system?: string | null;
  externalId?: string | null;
  url?: string | null;
  fetchedAt?: string | null;
}

export interface EvidenceRow {
  ac?: string | null;
  case?: string | null;
  check?: string | null;
  verdict?: string | null;
  basis?: string | null;
  test?: string | null;
}

export interface VerifyStatus {
  build: string[];
  test: string[];
  lint: string[];
  disabled: { gate: string; reason: string | null }[];
}

export interface ReviewStatus {
  attempt: string;
  decision: string | null;
  evidence: { acceptance: EvidenceRow[]; testCoverage: EvidenceRow[]; additionalChecks: EvidenceRow[] };
  inconsistentWithReviewMd: boolean;
  // 'missing': evidence: در result.yaml اصلاً نیست (Task قدیمی‌تر از قرارداد؛
  // بی‌خطر، نباید قرمز نشان داده شود). 'malformed': هست ولی خراب/ناقص است.
  evidenceStatus: 'ok' | 'missing' | 'malformed';
  malformed: boolean;
  problems: string[];
}

/** TOOLING-048: چرا `alive` این مقدار است (health.transitionLock.liveness و repository.health.managerLock.liveness). */
export type LockLiveness = 'dead' | 'pid-reused' | 'alive' | 'alive-unverified' | 'other-host' | 'no-pid';

export interface HealthStatus {
  /** liveness (TOOLING-048): چرا alive این مقدار است؛ اختیاری (قفل ِ ساخته‌شده با Manager ِ قدیمی‌تر ندارد). */
  transitionLock: { pid: number | null; alive: boolean | null; fromState: string | null; startedAt: string | null; liveness?: LockLiveness | null } | null;
  dirtyPaths: string[];
  stuck: boolean;
  // «no-progress» هرگز از status --json نمی‌آید — کد خروج ۳۰ از run است،
  // BarsaAgent از EXIT_LABELS[30] می‌خواندش (بازبینی فاز ۲، بند ۳).
  stuckReasons: ('stale-lock' | 'dirty-worktree' | string)[];
  // Manager حسابش می‌کند (computeRecovery در manager.js)، نه UI — تا منطق
  // بازیابی دو نسخه‌ی drift-کننده نداشته باشد. «reset» عمداً در enum نیست:
  // رد شد (0004: run خودش قفل کهنه‌ی pid-مرده را بی‌کمک انسان پس می‌گیرد).
  recovery: {
    suggested: 'unlock' | 'run' | 'recover' | 'recheck' | 'unblock' | null; reason: string | null; commands: ('unlock' | 'run' | 'recover' | 'recheck' | 'unblock')[];
    /** TOOLING-044: recover ِ process-attempt یا discard-residue. */
    mode?: 'process-attempt' | 'discard-residue' | null; attempt?: string | null;
    /** TOOLING-044: commit شکست خورد و چیزی کثیف ماند: چه چیزی، و فرمان ِ دقیق ِ بازیابی. */
    commitFailure?: { at: string | null; message: string | null; leftover: string[]; recoverCommand: string | null };
  } | null;
  /** TOOLING-043: نصب ِ وابستگی در جریان (npm ci). */
  install?: { phase: string | null; startedAt: string | null; pid: number | null; alive: boolean | null; command?: string | null; deadlineAt?: string | null } | null;
}

// release-note-at-merge.md، بند د/ه: متن کاربرپسندِ جدا از ai-context/changelog/<id>.md
// (آن یکی برای توسعه‌دهنده است). null یعنی release-note.md نیست (تسک قدیمی‌تر
// از این قرارداد) — نه {}، فرق «نیست» با «هست ولی خالی» باید از نوع معلوم باشد.
export interface ReleaseNoteStatus {
  userVisible: boolean | null;
  headline?: string | null;
  body?: string | null;
  approvedByHuman: boolean;
  artifactPath?: string | null;
  malformed?: boolean;
  problems?: string[];
}

// TOOLING-032 — status-json.schema.json#/definitions/externalSource. دو شکل:
// منبع پیدا نشد/repository.yaml خراب (فقط id+error، مثل errorTask)، یا شکل
// کامل access/staged/checkedIn/actions. actions همان شرط‌هایی است که answer
// خودش قبل از --stage-external/--external-checked-in می‌سنجد — کانبان هیچ
// شرط دیگری رویش نمی‌سازد.
export interface ExternalSource {
  id: string;
  error?: string;
  access?: string | null;
  delivery?: string | null;
  staged?: { sha: string; at: string | null } | null;
  checkedIn?: { changesets: string[]; at: string | null } | null;
  actions?: { canStageExternal: boolean; canMarkCheckedIn: boolean };
}

/**
 * TOOLING-037/038: «این اکشن الان مجاز است؟» از خود Manager (status.schema.json، taskActions).
 * `raiseLimit` از `actionsVersion: 2` یک **فهرست** از نام فیلدهای قابل بالا بردن است (فیلد سدکننده اول)؛ در
 * `actionsVersion: 1` یک boolean بود. `[]` یعنی مجاز نیست.
 */
export interface TaskActions {
  approve: boolean; reject: boolean; clarify: boolean; note: boolean; unblock: boolean; raiseLimit: string[];
  closeOrphan: string[]; allowPath: boolean; allowSharedKnowledgeFile: boolean; externalAccess: string[]; resetExternal: string[];
  cancel: boolean; abandon: boolean; void: boolean; unlock: boolean;
  /** TOOLING-044: recover (process-attempt | discard-residue؛ mode از health.recovery.mode). */
  recover?: boolean;
  /** TOOLING-045: شکست ِ provisioning (install | build | worktree-baseline) ← unblock + run. */
  retryProvision?: boolean;
  /** alias ِ نام ِ قبلی ِ retryProvision (یک نسخه)؛ همیشه هم‌مقدار. */
  retryInstall?: boolean;
  /** TOOLING-046: تغییر ِ runtime (در همه‌ی stateهای غیرپایانی؛ وسط ِ attempt ِ زنده در صف می‌نشیند). */
  setRuntime?: boolean;
  /** TOOLING-048: سنجش ِ دوباره‌ی attempt ِ ردشده با گارد ِ Manager (یا خطای ابزار ِ نوشتن)؛ بدون agent و بدون مصرف ِ budget. */
  recheck?: boolean;
  /** TOOLING-050 هـ: دروازه‌ی تأیید ِ وابستگی (answer --approve-dependencies / --reject-dependencies، با reason). */
  approveDependencies?: boolean;
  rejectDependencies?: boolean;
}

// --- TOOLING-046: provider / مدل / effort برای هر نقش ---------------------------------------------------

export type RuntimeSource = 'cli' | 'task-role' | 'task-preset' | 'env' | 'default';

export interface RuntimeSelection { provider?: string; model?: string; effort?: string }

/** runtime ِ مؤثر ِ یک نقش، یا `{error, code}` اگر resolve نشد. */
export interface EffectiveRoleRuntime {
  provider?: string;
  model?: string | null;
  requestedModel?: string | null;
  effort?: string;
  source?: RuntimeSource | string;
  fieldSources?: { provider?: string; model?: string; effort?: string };
  error?: string;
  code?: string;
}

/** یک تغییر ِ در صف (وسط ِ attempt ِ زنده ثبت شده، هنوز اعمال نشده). `change.reset` و `change.roles` و `change.preset` از Manager. */
export interface QueuedRuntimeChange {
  decision: number;
  queuedAt?: string | null;
  reason?: string | null;
  state?: string | null;
  change?: { roles?: Record<string, RuntimeSelection>; preset?: string | null; reset?: string[] };
}

export interface TaskRuntime {
  stored: { preset: string | null; roles: Record<string, RuntimeSelection> };
  effective: Record<string, EffectiveRoleRuntime> | null;
  /** یک خط، یا null وقتی با پیش‌فرض فرقی ندارد. */
  summary: string | null;
  pending: QueuedRuntimeChange[];
  effectiveAfterPending: Record<string, EffectiveRoleRuntime> | null;
  error: string | null;
}

/** `runtime --options --json` (فقط‌خواندنی): تنها منبع ِ گزینه‌های dialog و فرم ساخت. */
export interface RuntimeModelOption { id: string; aliases: string[]; efforts: string[] }
export interface RuntimeProviderReady { checked?: boolean; installed?: boolean; version?: string | null; authenticated?: boolean | null; detail?: string | null; via?: string | null }
export interface RuntimeProviderOption { enabled: boolean; roles: string[]; efforts: string[]; models: RuntimeModelOption[]; ready?: RuntimeProviderReady }
export interface RuntimeOptions {
  version: number;
  defaultProvider: string;
  roles: string[];
  providers: Record<string, RuntimeProviderOption>;
  defaults: Record<string, { provider: string; model: string; effort: string }>;
  presets: Record<string, { roles: Record<string, RuntimeSelection> }>;
}

/** رد ِ ساختاریافته‌ی Manager هنگام ساخت: import ِ تکراری (exit 44) یا runtime ِ نامعتبر (exit 45). */
export type StructuredFailure =
  | { kind: 'duplicate'; taskId: string | null; state: string | null; externalId: string | null; message: string; hint: string | null }
  | { kind: 'runtime-invalid'; code: string; role: string | null; message: string; details: Record<string, unknown>; explanation: string | null };

export interface Task {
  id: string;
  /** مسیر پوشه‌ی task نسبت به ریشه‌ی مخزن (TOOLING-037)؛ zip فقط از همین ساخته می‌شود. */
  dir?: string;
  /** غایب = Manager قدیمی‌تر از TOOLING-037 → هیچ دکمه‌ای. */
  actions?: TaskActions;
  slug?: string;
  title?: string;
  type?: string;
  state: string;
  stateSince?: string | null;
  previousState?: string | null;
  awaitingHuman?: HumanGate | null;
  // فیلدهای اضافه از blocker ِ واقعی Manager (کلید به کلید، بدون تفسیر): base/source برای
  // rebase-conflict، field/role برای budget-exhausted، maxAttempts/maxSpecRevisions برای attempts-exhausted/spec-churn.
  blocker?: {
    kind?: string | null; reason?: string | null; base?: string | null; source?: string | null; field?: string | null; role?: string | null; maxAttempts?: number | null; maxSpecRevisions?: number | null; conflictFiles?: string[] | null;
    /** TOOLING-043/045: کدام stage شکست خورد (install | build | worktree-baseline | …) و جزئیاتش. */
    stage?: string | null; detail?: string | null; recoverable?: 'retryable' | 'needs-fix' | null; retryAfter?: string | null;
    step?: string | null; log?: string | null; outputTail?: string[] | null;
    /** TOOLING-049 (kind=tooling، stage=tool-write-failed): نقش، attempt و هر Write/Edit ِ ناموفق؛ failedWrites: null = رویداد ِ قدیمی. */
    attempt?: string | null;
    failedWrites?: Array<{ tool?: string | null; path?: string | null; relPath?: string | null; error?: string | null; kind?: string | null }> | null;
    [key: string]: unknown
  } | null;
  source?: SourceRef | null;
  budget?: Record<string, BudgetItem>;
  scope?: { allow?: string[]; deny?: string[]; exception?: unknown };
  scopeException?: unknown;
  diff?: {
    headCommit?: string | null;
    baseCommit?: string | null;
    files?: Array<{ path?: string; added?: number; deleted?: number; status?: 'added' | 'modified' | 'deleted' | 'renamed' | string; inScope?: boolean }>;
    artifactPath?: string | null;
  } | null;
  worktree?: { status?: string | null; path?: string | null } | null;
  git?: { base?: string | null; baseCommit?: string | null; headCommit?: string | null; mergeCommit?: string | null; branch?: string | null } | null;
  lastAttempt?: { n?: number; role?: string | null; outcome?: string | null; at?: string | null; runtime?: AttemptRuntime | null } | null;
  /** TOOLING-048: نقش ِ جاری و بعدی (از manifest)، در سطح ِ تسک؛ مقدار ِ خالی null. غایب = Manager قدیمی‌تر از ۰۴۸ (هیچ برجسته‌سازی). */
  roles?: { current: string | null; next: string | null } | null;
  /** TOOLING-050 ب: Caseهای tests.md (دستی/خودکار) و مشکلات ِ parser؛ null = tests.md نیست؛ غایب = Manager قدیمی‌تر. */
  tests?: TestsInfo | null;
  /** TOOLING-050 د: پیوست‌ها (فایل‌ها بیرون از git، زیر attachments.root ِ Manager). */
  attachments?: TaskAttachments | null;
  /** TOOLING-050 هـ: فقط وقتی دروازه باز است؛ وگرنه null. */
  dependencyApproval?: DependencyApproval | null;
  /** وابستگی‌های ِ تأییدشده (manifest.dependencies.add). */
  dependencies?: ApprovedDependency[];
  /** TOOLING-046: runtime ِ ذخیره‌شده، مؤثر (با منبع)، تغییرهای در صف. غایب = Manager قدیمی‌تر از ۰۴۶. */
  runtime?: TaskRuntime | null;
  attempts?: Attempt[];
  artifacts?: string[];
  error?: string;
  verify?: VerifyStatus | null;
  review?: ReviewStatus | null;
  health?: HealthStatus | null;
  releaseNote?: ReleaseNoteStatus | null;
  // additive (Manager قدیمی‌تر از TOOLING-032 اصلاً این کلید را ندارد — غایب
  // یعنی «این Manager چیزی نمی‌داند»، نه «صفر منبع بیرونی»؛ هر دو حالت در UI
  // به‌صورت «هیچ دکمه‌ای نیست» دیده می‌شوند، فرقشان فقط برای دیباگ است).
  externalSources?: ExternalSource[];
}

export interface ExecutionState { enabled: boolean; source?: string | null; reason?: string | null }
export interface LocalConfigState { path: string; present: boolean; applied: boolean; keys: string[] }
export interface SyncState { branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; lastFetchAt: string | null }

export interface Board {
  // schemaVersion عمداً اینجا نیست (بازبینی فاز ۲، بند ج): هیچ‌جای UI آن را
  // نمی‌خواند/نمی‌سنجد — سازگاری واقعی از capability handshake
  // (repo.manager.contractVersion، چک‌شده در assertManagersCompatible هنگام
  // startup) گرفته می‌شود. نگه‌داشتن یک فیلد تعریف‌شده‌ولی‌چک‌نشده یعنی دو
  // شماره‌ی نسخه که می‌توانند بی‌سروصدا از هم عقب بمانند.
  generatedAt: string;
  repo: { id: string; path: string; head?: string | null; mergedBy?: 'manager' | 'human' };
  // حادثه‌ی ۲۶ سپتامبر، بند «د»: قفل سراسری (.manager.lock) و فایل‌های کثیفِ
  // بی‌صاحب مسائل سطح مخزن‌اند، نه یک task خاص — قبلاً هیچ‌جای برد دیده
  // نمی‌شدند. Manager حسابش می‌کند (computeRepositoryHealth)، نه UI.
  repository?: {
    health: {
      managerLock: { pid: number | null; alive: boolean | null; task: string | null; startedAt: string | null; liveness?: LockLiveness | null } | null;
      unownedDirtyFiles: string[];
      acceptsOperations: boolean;
    };
    /** TOOLING-040: قفل اجرا. `enabled: false` ⇒ همه‌ی actions خاموش و فرمان‌های نوشتنی با exit 41 رد می‌شوند. */
    execution?: ExecutionState;
    /** TOOLING-040: `.agent-work/config/repository.local.yaml` (فقط محلی، git-ignored). */
    localConfig?: LocalConfigState;
    /** TOOLING-040: از آخرین fetch؛ status خودش به شبکه نمی‌رود. */
    sync?: SyncState;
  };
  tasks: Task[];
  error?: string;
}

export interface ManagerInfo {
  ok: boolean;
  contract?: string | null;
  contractVersion?: number | null;
  managerVersion?: string | null;
  protocolVersion?: string | null;
  capabilities?: Record<string, unknown>;
  statusFields?: { verify: boolean; review: boolean; health: boolean };
  errors?: string[];
}

export interface RunSettings {
  maxConcurrent: number;
  autoStartOnCreate: boolean;
  autoResumeAfterAnswer: boolean;
}

export interface Repo {
  id: string; path: string; manager?: ManagerInfo | null; run?: RunSettings; board?: { doneDays?: number } }

export interface RunningTask {
  taskId: string;
  queuedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  queued?: boolean;
  queuePosition?: number | null;
  running: boolean;
  exitCode?: number | null;
}

export interface Issue {
  externalId: string;
  title: string;
  body?: string;
  url?: string;
  status?: string;
  labels?: string[];
  fetchedAt?: string;
  system?: string;
  importedTaskId?: string | null;
  importedRepoId?: string | null;
}

export interface CreateTaskDraft {
  repo: string;
  type: 'task' | 'spike';
  slug: string;
  requestText: string;
  /** import-issue --external-access <sourceId>=read|write (فقط یک مورد) */
  externalAccess?: Array<{ sourceId: string; access: 'read' | 'write' }>;
  source?: SourceRef;
  displayId?: string;
  skipped?: boolean;
  /** TOOLING-046: preset و ردیف‌های عوض‌شده‌ی نقش‌ها. فقط تفاوت با preset به Manager می‌رود. */
  runtime?: { preset: string; roles: Record<string, RuntimeSelection> };
  /** TOOLING-044: import ِ تکراری ِ عمدی (دلیل اجباری). */
  allowDuplicate?: { reason: string };
  /** TOOLING-050: آپلودهای موقت؛ به سرور فقط شناسه‌ها می‌روند (import-issue --attach). */
  attachments?: StagedUpload[];
}

export interface CreateTaskResult {
  key: string;
  ok: boolean;
  taskId?: string;
  repoId?: string;
  slug?: string;
  queued?: boolean;
  started?: boolean;
  duplicate?: boolean;
  message?: string;
  managerExit?: number;
  structured?: StructuredFailure;
}

export interface CreateTasksResponse {
  succeeded: number;
  failed: number;
  results: CreateTaskResult[];
}

export interface HealthResult {
  ok: boolean;
  checkedAt: string;
  code: number;
  output: string;
}

export interface AgentEvent extends Record<string, unknown> {
  at?: string;
  event?: string;
  from?: string;
  to?: string;
  reason?: string;
  role?: string;
  attempt?: string | number;
  error?: string;
}

// --- کانبان فاز ۱ ------------------------------------------------------------------

export interface ConsoleParse {
  ok: boolean;
  repo: string;
  subcommand: string;
  taskId: string | null;
  display: string;
  readOnly: boolean;
  /** flagهای مسیر-فایل که متنشان از textarea می‌آید (--file, --reason-file, --release-note-file) */
  attachments: string[];
}
export type ConsoleExecResult = { kind: 'exec'; execId: string } | { kind: 'run'; taskId: string; repoId: string };
export interface ConsoleHistoryItem { line: string; at: string; exitCode: number | null; status: string | null }
export interface ExecInfo { id: string; action: string; user: string; display: string; startedAt: string; finishedAt: string | null; exitCode: number | null; running: boolean; stopped: boolean }
export interface StreamLine { text: string; stream: string; at: string }
export interface RunRecord { runId: string; user: string | null; startedAt: string; endedAt: string | null; exitCode: number | null; status: string; durationMs: number | null; hasLog: boolean }
export interface StopResult { ok: boolean; stopped: boolean; wasQueued?: boolean; stillAlive?: boolean; exitCode: number | null; health: HealthStatus | null }
export interface GitStatus { status: string; worktrees: string; log: string; clean: boolean }
export interface GitWorktree {
  path: string; head: string | null; branch: string | null; detached: boolean; bare: boolean; managed: boolean;
  proof: { proven: boolean; commit: string; at: string; user?: string } | null;
}
export interface GitInventory { worktreesDir: string | null; proveIsolationScript: string; powershell: string | null; worktrees: GitWorktree[] }
/** وضعیت sync از `status --json` ِ Manager (repository.sync/execution/localConfig)، نه از محاسبه‌ی کانبان. */
export interface ManagerInfoView {
  head: string | null; branch: string | null; upstream: string | null; ahead: number | null; behind: number | null; lastFetchAt: string | null;
  execution: ExecutionState | null; localConfig: LocalConfigState | null; remoteError?: string;
}
export interface HealthCheckItem { id: string; group: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string; hint: string }
export interface EnvHealthReport { checkedAt: string; ok: boolean; checks: HealthCheckItem[] }
export interface DrainLiveRun { repoId: string; taskId: string; runId: string | null; user: string | null; startedAt: string; state: string | null; durationMs: number; durationText: string }
export interface DrainQueuedRun { repoId: string; taskId: string; user: string | null; queuedAt: string | null }
/** حالت ِ تخلیه (drain): run ِ تازه شروع نمی‌شود؛ in-flight ها ادامه می‌دهند؛ صف می‌ماند. */
export interface DrainStatus {
  changed?: boolean; draining: boolean; since: string | null; by: string | null; empty: boolean;
  live: DrainLiveRun[]; queued: DrainQueuedRun[]; execs: { id: string; action: string; display?: string }[];
}
/** نتیجه‌ی `recheck`: رویداد ِ attempt.rechecked (result: accepted | rejected | blocked | routed)؛ null اگر رویدادی پیدا نشد. */
export interface RecheckResult {
  ok: boolean; taskId: string; result: 'accepted' | 'rejected' | 'blocked' | 'routed' | string | null;
  event: { attempt?: string | null; previousGuard?: string | null; result?: string | null; budgetConsumed?: string | null; at?: string | null } | null;
  output: string[];
}
export interface BundleItem { name: string; bytes: number; createdAt: string; }
export interface BundleResult { ok: boolean; taskId: string; name: string; path: string; bytes: number; files: number; skipped: number; }

export interface AuditItem {
  id: string; user: string | null; action: string; status?: string; startedAt: string; exitCode?: number | null; durationMs?: number | null;
  repoId?: string; taskId?: string; line?: string; reason?: string; outputFile?: string | null;
}
