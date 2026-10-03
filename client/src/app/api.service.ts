import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { AgentEvent, Board, CreateTaskDraft, CreateTasksResponse, HealthResult, Issue, Repo, RunningTask, Task } from './models';

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
  answer = (repo: string, id: string, body: { mode: string; reason?: string; text?: string; route?: 'implementer' | 'architect'; respec?: boolean; releaseNoteText?: string; noReleaseNote?: boolean }) => this.http.post<{ ok: boolean; autoResumed?: boolean; queued?: boolean; started?: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/answer`, body
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
  streamUrl(repo: string, id: string) { return `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/stream`; }
}
