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
  run = (repo: string, id: string) => this.http.post<{ accepted: boolean; queued?: boolean; queuePosition?: number | null }>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/run`, {});
  answer = (repo: string, id: string, body: { mode: string; reason?: string; text?: string; route?: 'implementer' | 'architect' }) => this.http.post<{ ok: boolean; autoResumed?: boolean; queued?: boolean; started?: boolean }>(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/answer`, body
  );
  issues = (refresh = false) => this.http.get<Issue[]>('/api/issues', { params: refresh ? new HttpParams().set('refresh', '1') : undefined });
  createTasks = (items: CreateTaskDraft[], start?: boolean) => this.http.post<CreateTasksResponse>('/api/tasks/create', { items, start });
  streamUrl(repo: string, id: string) { return `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/stream`; }
}
