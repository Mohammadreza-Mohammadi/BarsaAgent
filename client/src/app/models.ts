export interface HumanGate {
  kind: 'spec-approval' | 'clarification' | 'merge-approval' | string;
  artifact?: string | null;
  since?: string | null;
}

export interface BudgetItem { used: number; max: number }

export interface Attempt {
  n: number;
  id: string;
  role?: string | null;
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

export interface HealthStatus {
  transitionLock: { pid: number | null; alive: boolean | null; fromState: string | null; startedAt: string | null } | null;
  dirtyPaths: string[];
  stuck: boolean;
  // «no-progress» هرگز از status --json نمی‌آید — کد خروج ۳۰ از run است،
  // BarsaAgent از EXIT_LABELS[30] می‌خواندش (بازبینی فاز ۲، بند ۳).
  stuckReasons: ('stale-lock' | 'dirty-worktree' | string)[];
  // Manager حسابش می‌کند (computeRecovery در manager.js)، نه UI — تا منطق
  // بازیابی دو نسخه‌ی drift-کننده نداشته باشد. «reset» عمداً در enum نیست:
  // رد شد (0004: run خودش قفل کهنه‌ی pid-مرده را بی‌کمک انسان پس می‌گیرد).
  recovery: { suggested: 'unlock' | 'run' | null; reason: string | null; commands: ('unlock' | 'run')[] } | null;
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
  staged?: { sha: string; at: string | null } | null;
  checkedIn?: { changesets: string[]; at: string | null } | null;
  actions?: { canStageExternal: boolean; canMarkCheckedIn: boolean };
}

export interface Task {
  id: string;
  slug?: string;
  title?: string;
  type?: string;
  state: string;
  stateSince?: string | null;
  previousState?: string | null;
  awaitingHuman?: HumanGate | null;
  blocker?: { kind?: string | null; reason?: string | null } | null;
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
  lastAttempt?: { n?: number; role?: string | null; outcome?: string | null; at?: string | null } | null;
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
      managerLock: { pid: number | null; alive: boolean | null; task: string | null; startedAt: string | null } | null;
      unownedDirtyFiles: string[];
      acceptsOperations: boolean;
    };
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

export interface Repo { id: string; path: string; manager?: ManagerInfo | null; run?: RunSettings }

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
  source?: SourceRef;
  displayId?: string;
  skipped?: boolean;
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
