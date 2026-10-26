import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import {
  AgentEvent, AuditItem, Board, BundleItem, BundleResult, ConsoleExecResult, ConsoleHistoryItem, ConsoleParse, CreateTaskDraft, CreateTasksResponse, DrainStatus, EnvHealthReport,
  ExecInfo, GitInventory, GitStatus, HealthResult, Issue, ManagerInfoView, Repo, RunRecord, RunningTask, RuntimeOptions, StopResult, Task
} from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  repos = () => this.http.get<Repo[]>('/api/repos');
  board = (repo: string) => this.http.get<Board>(`/api/repos/${encodeURIComponent(repo)}/board`);
  task = (repo: string, id: string) => this.http.get<Task>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}`);
  running = (repo: string) => this.http.get<RunningTask[]>(`/api/repos/${encodeURIComponent(repo)}/running`);
  health = (repo: string, refresh = false) => this.http.get<HealthResult>(
    `/api/repos/${encodeURIComponent(repo)}/health`,
    { params: refresh ? new HttpParams().set('refresh', '1') : undefined }
  );
  events = (repo: string, id: string) => this.http.get<AgentEvent[]>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/events`);
  artifact = (repo: string, id: string, path: string) => this.http.get(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/artifact`,
    { params: { path }, responseType: 'text' }
  );
  openEditor = (repo: string, id: string) => this.http.post<{ ok: boolean; worktreePath: string }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/open-editor`, {}
  );
  run = (repo: string, id: string) => this.http.post<{ accepted: boolean; queued?: boolean; queuePosition?: number | null }>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/run`, {});
  answer = (repo: string, id: string, body: { mode: string; reason?: string; text?: string; route?: 'implementer' | 'architect'; respec?: boolean; releaseNoteText?: string; noReleaseNote?: boolean; externalAccess?: { sourceId: string; access: 'read' | 'write' } }) => this.http.post<{ ok: boolean; autoResumed?: boolean; queued?: boolean; started?: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/answer`, body
  );
  // الحاقیه‌ی ۱، بند ب: فقط وقتی actions.canStageExternal === true (از
  // status --json، TOOLING-032) — کانبان خودش هیچ شرطی نمی‌سازد.
  stageExternal = (repo: string, id: string, body: { sourceId: string }) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/stage-external`, body
  );
  // TOOLING-023 (manager.js، بند «ز-۴»): --external-checked-in فقط برای
  // state="awaiting-external-checkin" معنا دارد؛ changesets اختیاری است.
  externalCheckedIn = (repo: string, id: string, body: { sourceId: string; changesets: string[] }) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/external-checked-in`, body
  );
  note = (repo: string, id: string, text: string) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/note`, { text }
  );
  voidTask = (repo: string, id: string, reason: string) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/void`, { reason }
  );
  cancelTask = (repo: string, id: string, reason: string) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/cancel`, { reason }
  );
  rebaseTask = (repo: string, id: string) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/rebase`, {}
  );
  // دریچه‌ی اضطراری بازیابی — فقط manager.js unlock را صدا می‌زند. force فقط
  // وقتی لازم است که transitionLock.alive === null باشد (Manager خودش رد/قبول
  // می‌کند؛ اینجا فقط پاس داده می‌شود، حدس زده نمی‌شود).
  unlockTask = (repo: string, id: string, reason: string, force = false) => this.http.post<{ ok: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/unlock`, { reason, force }
  );
  issues = (refresh = false) => this.http.get<Issue[]>('/api/issues', { params: refresh ? new HttpParams().set('refresh', '1') : undefined });
  createTasks = (items: CreateTaskDraft[], start?: boolean) => this.http.post<CreateTasksResponse>('/api/tasks/create', { items, start });
  // --- کانبان فاز ۱ ---------------------------------------------------------------
  private repoPath = (repo: string) => `/api/repos/${encodeURIComponent(repo)}`;
  private taskPath = (repo: string, id: string) => `${this.repoPath(repo)}/tasks/${encodeURIComponent(id)}`;

  consoleSubcommands = (repo: string) => this.http.get<{ subcommands: string[]; source: string; at: string; error: string | null }>('/api/console/subcommands', { params: { repo } });
  consoleParse = (repo: string, line: string) => this.http.post<ConsoleParse>('/api/console/parse', { repo, line });
  consoleExec = (repo: string, line: string, confirmedCommand: string, attachments: Record<string, string>) =>
    this.http.post<ConsoleExecResult>('/api/console/exec', { repo, line, confirmedCommand, attachments });
  consoleHistory = () => this.http.get<ConsoleHistoryItem[]>('/api/console/history');
  execs = () => this.http.get<ExecInfo[]>('/api/execs');
  execStreamUrl = (id: string) => `/api/execs/${encodeURIComponent(id)}/stream`;
  stopExec = (id: string) => this.http.post<{ ok: boolean }>(`/api/execs/${encodeURIComponent(id)}/stop`, {});
  logUrl = (id: string) => `/api/logs/${encodeURIComponent(id)}`;
  zipUrl = (repo: string, id: string) => `${this.taskPath(repo, id)}/zip`;

  stopTask = (repo: string, id: string) => this.http.post<StopResult>(`${this.taskPath(repo, id)}/stop`, {});
  taskRuns = (repo: string, id: string) => this.http.get<RunRecord[]>(`${this.taskPath(repo, id)}/runs`);
  abandonTask = (repo: string, id: string, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/abandon`, { reason });
  unblockTask = (repo: string, id: string, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/unblock`, { reason });
  raiseLimit = (repo: string, id: string, field: string, value: number, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/raise-limit`, { field, value, reason });
  closeOrphan = (repo: string, id: string, attempt: string, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/close-orphan`, { attempt, reason });
  allowPath = (repo: string, id: string, path: string, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/allow-path`, { path, reason });
  allowSharedKnowledgeFile = (repo: string, id: string, path: string, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/allow-shared-knowledge-file`, { path, reason });
  externalAccess = (repo: string, id: string, sourceId: string, access: 'read' | 'write', reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/external-access`, { sourceId, access, reason });
  resetExternal = (repo: string, id: string, sourceId: string, to: string | null, reason: string) => this.http.post<{ ok: boolean }>(`${this.taskPath(repo, id)}/reset-external`, { sourceId, to, reason });
  // --- TOOLING-044/045/046 ----------------------------------------------------------------------------
  /** `runtime --options --json` (فقط‌خواندنی): تنها منبع ِ گزینه‌های dialog و فرم ساخت. */
  runtimeOptions = (repo: string, refresh = false) => this.http.get<RuntimeOptions>(`${this.repoPath(repo)}/runtime-options`, { params: refresh ? new HttpParams().set('refresh', '1') : undefined });
  /** `answer <id> --runtime|--runtime-preset|--runtime-reset … --reason-file` (فقط attemptهای بعدی؛ وسط ِ attempt ِ زنده در صف می‌نشیند). */
  setRuntime = (repo: string, id: string, body: Record<string, unknown>) => this.http.post<{ ok: boolean; queued: boolean; output: string[] }>(`${this.taskPath(repo, id)}/runtime`, body);
  /** retryProvision (= answer --unblock + run، idempotent) برای stageهای install | build | worktree-baseline. */
  retryProvision = (repo: string, id: string, reason?: string) => this.http.post<{ ok: boolean; queued?: boolean; started?: boolean; duplicate?: boolean }>(`/api/remote/tasks/${encodeURIComponent(id)}/retry-provision`, { reason }, { params: new HttpParams().set('repo', repo) });
  /** recover (process-attempt | discard-residue؛ مورد ِ دوم دلیل می‌خواهد). */
  recoverTask = (repo: string, id: string, body: { discardResidue?: boolean; reason?: string }) => this.http.post<{ ok: boolean; mode: string; output: string[] }>(`/api/remote/tasks/${encodeURIComponent(id)}/recover`, body, { params: new HttpParams().set('repo', repo) });
  retryRebase = (repo: string, id: string, reason?: string) => this.http.post<{ ok: boolean; queued?: boolean; started?: boolean; duplicate?: boolean }>(`${this.taskPath(repo, id)}/retry-rebase`, { reason });

  gitStatus = (repo: string) => this.http.get<GitStatus>(`${this.repoPath(repo)}/git/status`);
  gitInventory = (repo: string) => this.http.get<GitInventory>(`${this.repoPath(repo)}/git/inventory`);
  gitAction = (repo: string, name: 'worktree-add' | 'prove' | 'merge' | 'worktree-remove' | 'branch-delete', body: Record<string, string>) =>
    this.http.post<{ execId: string }>(`${this.repoPath(repo)}/git/${name}`, body);
  managerInfo = (repo: string) => this.http.get<ManagerInfoView>(`${this.repoPath(repo)}/manager/info`);
  /** `manager.js sync --dry-run --json` — فقط می‌سنجد. */
  managerSyncPreview = (repo: string) => this.http.post<{ execId: string }>(`${this.repoPath(repo)}/manager/sync-preview`, {});
  /** `manager.js sync --json` — ff / push / merge ِ واقعی + npm ci ِ مشروط (منطقش در Manager است). */
  managerUpdate = (repo: string) => this.http.post<{ execId: string }>(`${this.repoPath(repo)}/manager/update`, {});
  drain = () => this.http.get<DrainStatus>('/api/drain');
  drainOn = () => this.http.post<DrainStatus>('/api/drain', {});
  drainOff = () => this.http.post<DrainStatus>('/api/drain/off', {});
  envHealth = () => this.http.get<EnvHealthReport>('/api/env-health');
  bundles = () => this.http.get<BundleItem[]>('/api/bundles');
  bundleUrl = (name: string) => `/api/bundles/${encodeURIComponent(name)}`;
  createBundle = (repo: string, id: string) => this.http.post<BundleResult>(`/api/remote/tasks/${encodeURIComponent(id)}/bundle`, {}, { params: { repo } });
  audit = (limit = 100) => this.http.get<AuditItem[]>('/api/audit', { params: { limit } });

  streamUrl(repo: string, id: string) { return `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/stream`; }
}
