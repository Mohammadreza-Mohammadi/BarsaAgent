export interface HumanGate {
  kind: 'spec-approval' | 'clarification' | 'merge-approval' | string;
  artifact?: string | null;
  since?: string | null;
  legacy?: boolean;
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
  scope?: { allow?: string[]; deny?: string[] };
  verify?: Record<string, unknown>;
  worktree?: { status?: string | null; path?: string | null } | null;
  git?: { base?: string | null; baseCommit?: string | null; headCommit?: string | null; mergeCommit?: string | null } | null;
  lastAttempt?: { n?: number; role?: string | null; outcome?: string | null; at?: string | null } | null;
  attempts?: Attempt[];
  artifacts?: string[];
  error?: string;
}

export interface Board {
  schemaVersion: number;
  generatedAt: string;
  repo: { id: string; path: string; head?: string | null };
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
  errors?: string[];
}

export interface Repo { id: string; path: string; manager?: ManagerInfo | null }

export interface RunningTask {
  taskId: string;
  startedAt?: string | null;
  finishedAt?: string | null;
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
  importedTaskId?: string | null;
  importedRepoId?: string | null;
}

export interface ImportResult {
  id: string;
  ok: boolean;
  taskId?: string;
  message?: string;
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
