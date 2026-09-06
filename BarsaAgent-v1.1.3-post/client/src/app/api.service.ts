import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { AgentEvent, Board, ImportResult, Issue, Repo, RunningTask, Task } from './models';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  repos = () => this.http.get<Repo[]>('/api/repos');
  board = (repo: string) => this.http.get<Board>(`/api/repos/${encodeURIComponent(repo)}/board`);
  task = (repo: string, id: string) => this.http.get<Task>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}`);
  running = (repo: string) => this.http.get<RunningTask[]>(`/api/repos/${encodeURIComponent(repo)}/running`);
  events = (repo: string, id: string) => this.http.get<AgentEvent[]>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/events`);
  artifact = (repo: string, id: string, path: string) => this.http.get(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/artifact`,
    { params: { path }, responseType: 'text' }
  );
  run = (repo: string, id: string) => this.http.post<{ started: boolean }>(`/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/run`, {});
  answer = (repo: string, id: string, body: { mode: string; reason?: string; text?: string }) => this.http.post(
    `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/answer`, body
  );
  issues = (refresh = false) => this.http.get<Issue[]>('/api/issues', { params: refresh ? new HttpParams().set('refresh', '1') : undefined });
  importIssues = (ids: string[], repo: string) => this.http.post<{ results: ImportResult[] }>('/api/issues/import', { ids, repo });
  streamUrl(repo: string, id: string) { return `/api/repos/${encodeURIComponent(repo)}/tasks/${encodeURIComponent(id)}/stream`; }
}
