import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AgentEvent, Attempt, Board, CreateTaskDraft, CreateTaskResult, HealthResult, Issue, Repo, RunningTask, Task } from './models';

const LANES = [
  { title: 'ورودی', states: ['new'] },
  { title: 'طراحی', states: ['architecture', 'needs-clarification', 'needs-investigation', 'failed'] },
  { title: 'آماده', states: ['ready'] },
  { title: 'پیاده‌سازی', states: ['implementing', 'rejected'] },
  { title: 'بازبینی', states: ['review'] },
  { title: 'تأییدشده', states: ['approved', 'integrating', 'conflict'] },
  { title: 'تمام', states: ['integrated'] }
] as const;

const EXIT_LABELS: Record<number, string> = {
  0: 'تمام شد — integrated',
  10: 'منتظر توست',
  20: 'متوقف',
  30: 'بدون پیشرفت — احتمالاً باگ',
  1: 'خطای اجرایی'
};

type Panel = 'task' | 'action' | 'issues' | 'create' | null;

@Component({
  selector: 'ba-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService);
  private poll?: number;
  private source?: EventSource;

  readonly repos = signal<Repo[]>([]);
  readonly repoId = signal('');
  readonly board = signal<Board | null>(null);
  readonly running = signal<Record<string, RunningTask>>({});
  readonly health = signal<HealthResult | null>(null);
  readonly loading = signal(true);
  readonly error = signal('');
  readonly info = signal('');

  readonly selected = signal<Task | null>(null);
  readonly panel = signal<Panel>(null);
  readonly events = signal<AgentEvent[]>([]);
  readonly logs = signal<string[]>([]);
  readonly streamEnded = signal<number | null | undefined>(undefined);

  readonly rootArtifactName = signal('');
  readonly rootArtifact = signal('');
  readonly actionArtifacts = signal<Record<string, string>>({});
  readonly selectedAttempt = signal<Attempt | null>(null);
  readonly attemptArtifacts = signal<Record<string, string>>({});

  readonly issues = signal<Issue[]>([]);
  readonly createDrafts = signal<CreateTaskDraft[]>([]);
  readonly createIndex = signal(0);
  readonly createResults = signal<CreateTaskResult[]>([]);
  readonly busy = signal(false);
  readonly lanes = LANES;
  readonly issueSelection = new Set<string>();
  readonly notificationPermission = signal<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  private readonly knownHumanTasks = new Set<string>();
  private humanSnapshotReady = false;

  reason = '';
  answerText = '';
  createStart = true;

  async ngOnInit(): Promise<void> {
    try {
      const repos = await firstValueFrom(this.api.repos());
      this.repos.set(repos);
      if (repos[0]) {
        this.repoId.set(repos[0].id);
        this.createStart = repos[0].run?.autoStartOnCreate !== false;
        await this.refresh();
      }
    } catch (e) {
      this.fail(e);
    } finally {
      this.loading.set(false);
    }
    this.poll = window.setInterval(() => void this.refresh(true), 3000);
  }

  ngOnDestroy(): void {
    if (this.poll) window.clearInterval(this.poll);
    this.closeStream();
  }

  async chooseRepo(id: string): Promise<void> {
    this.repoId.set(id);
    this.selected.set(null);
    this.panel.set(null);
    this.issueSelection.clear();
    this.createStart = this.currentRepo()?.run?.autoStartOnCreate !== false;
    await this.refresh();
  }

  async refresh(silent = false): Promise<void> {
    if (!this.repoId()) return;
    try {
      const [board, running, health] = await Promise.all([
        firstValueFrom(this.api.board(this.repoId())),
        firstValueFrom(this.api.running(this.repoId())),
        firstValueFrom(this.api.health(this.repoId()))
      ]);
      this.board.set(board);
      this.running.set(Object.fromEntries(running.map(x => [x.taskId, x])));
      this.health.set(health);
      this.notifyNewHumanTasks(board.tasks);
      const selected = this.selected();
      if (selected) {
        const fresh = board.tasks.find(x => x.id === selected.id);
        if (fresh) this.selected.set(fresh);
      }
      if (!silent) this.error.set('');
    } catch (e) {
      if (!silent) this.fail(e);
    }
  }

  async refreshHealth(): Promise<void> {
    try { this.health.set(await firstValueFrom(this.api.health(this.repoId(), true))); }
    catch (e) { this.fail(e); }
  }

  tasksFor(states: readonly string[]): Task[] {
    return (this.board()?.tasks ?? []).filter(t => states.includes(t.state) && !t.error);
  }
  terminalTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => ['blocked', 'cancelled', 'abandoned'].includes(t.state) && !t.error); }
  errorTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => !!t.error || t.state === '__error__'); }
  humanTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => !!t.awaitingHuman && !t.error); }
  queuedTasks(): RunningTask[] { return Object.values(this.running()).filter(x => x.queued); }
  gateKind(t: Task | null): string { return t?.awaitingHuman?.kind ?? ''; }
  gateLabel(t: Task): string {
    return ({ 'spec-approval': 'تأیید spec', clarification: 'پاسخ به سؤال', 'merge-approval': 'تأیید merge' } as Record<string, string>)[this.gateKind(t)] ?? 'اقدام انسانی';
  }

  elapsed(iso?: string | null): string {
    if (!iso) return '—';
    const time = new Date(iso).getTime();
    if (!Number.isFinite(time)) return '—';
    const sec = Math.max(0, (Date.now() - time) / 1000);
    if (sec < 60) return 'کمتر از یک دقیقه';
    if (sec < 3600) return `${Math.floor(sec / 60)} دقیقه`;
    if (sec < 86400) return `${Math.floor(sec / 3600)} ساعت`;
    return `${Math.floor(sec / 86400)} روز`;
  }

  budget(t: Task) {
    const key = t.state === 'implementing' || t.state === 'rejected' ? 'implementerRuns'
      : t.state === 'review' ? 'reviewerRuns'
      : ['architecture', 'needs-clarification', 'needs-investigation'].includes(t.state) ? 'architectRuns'
      : 'attempts';
    return t.budget?.[key];
  }
  budgetLabel(t: Task): string {
    if (t.state === 'implementing' || t.state === 'rejected') return 'impl';
    if (t.state === 'review') return 'review';
    if (['architecture', 'needs-clarification', 'needs-investigation'].includes(t.state)) return 'arch';
    return 'run';
  }

  isRunning(t: Task): boolean { return this.running()[t.id]?.running === true; }
  isQueued(t: Task): boolean { return this.running()[t.id]?.queued === true; }
  queuePosition(t: Task): number | null { return this.running()[t.id]?.queuePosition ?? null; }

  conflictTasks(t: Task): Task[] {
    if (!this.isActiveTask(t)) return [];
    const own = t.scope?.allow ?? [];
    if (!own.length) return [];
    return (this.board()?.tasks ?? []).filter(other => other.id !== t.id && this.isActiveTask(other) && this.scopesOverlap(own, other.scope?.allow ?? []));
  }
  conflictPairs(): { left: Task; right: Task }[] {
    const active = (this.board()?.tasks ?? []).filter(t => this.isActiveTask(t));
    const pairs: { left: Task; right: Task }[] = [];
    for (let i = 0; i < active.length; i += 1) for (let j = i + 1; j < active.length; j += 1) {
      if (this.scopesOverlap(active[i].scope?.allow ?? [], active[j].scope?.allow ?? [])) pairs.push({ left: active[i], right: active[j] });
    }
    return pairs;
  }

  async enableNotifications(): Promise<void> {
    if (typeof Notification === 'undefined') { this.notificationPermission.set('unsupported'); return; }
    const permission = await Notification.requestPermission();
    this.notificationPermission.set(permission);
    if (permission === 'granted') this.info.set('اعلان دسکتاپ فعال شد؛ gateهای انسانی جدید اطلاع داده می‌شوند.');
  }

  currentRepo(): Repo | undefined { return this.repos().find(r => r.id === this.repoId()); }
  managerLabel(): string {
    const manager = this.currentRepo()?.manager;
    if (!manager) return 'Manager —';
    const version = manager.managerVersion || 'unknown';
    const contract = manager.contractVersion != null ? `Contract v${manager.contractVersion}` : 'Contract —';
    return `Manager ${version} · ${contract}`;
  }
  runSettingsLabel(): string {
    const run = this.currentRepo()?.run;
    return run ? `همزمان ${run.maxConcurrent} · auto-start ${run.autoStartOnCreate ? 'on' : 'off'} · auto-resume ${run.autoResumeAfterAnswer ? 'on' : 'off'}` : '—';
  }
  notificationLabel(): string {
    const p = this.notificationPermission();
    if (p === 'granted') return 'اعلان فعال';
    if (p === 'denied') return 'اعلان مسدود';
    if (p === 'unsupported') return 'اعلان ناموجود';
    return 'فعال‌کردن اعلان';
  }
  healthLabel(): string { return this.health()?.ok ? 'Agent-work سالم' : 'Agent-work نیاز به بررسی دارد'; }

  exitCodeFor(t: Task | null): number | null | undefined {
    if (!t) return undefined;
    if (this.selected()?.id === t.id && this.streamEnded() !== undefined) return this.streamEnded();
    return this.running()[t.id]?.exitCode;
  }
  exitLabel(code: number | null | undefined): string {
    if (code === undefined) return 'هنوز اجرا نشده';
    if (code === null) return 'وضعیت اجرای محلی نامشخص';
    return EXIT_LABELS[code] ?? `خطای اجرایی (کد ${code})`;
  }

  async openTask(t: Task, action = false): Promise<void> {
    this.resetPanelState();
    this.selected.set(t);
    this.panel.set(action ? 'action' : 'task');
    try {
      const [fresh, events] = await Promise.all([
        firstValueFrom(this.api.task(this.repoId(), t.id)),
        firstValueFrom(this.api.events(this.repoId(), t.id))
      ]);
      this.selected.set(fresh);
      this.events.set(events);
      if (action) await this.loadActionArtifacts(fresh); else await this.loadInitialTaskArtifact(fresh);
      this.connectStream(fresh.id);
    } catch (e) { this.fail(e); }
  }

  async openImportedIssue(issue: Issue): Promise<void> {
    if (!issue.importedTaskId) return;
    if (issue.importedRepoId && issue.importedRepoId !== this.repoId()) await this.chooseRepo(issue.importedRepoId);
    const task = this.board()?.tasks.find(t => t.id === issue.importedTaskId);
    if (task) return this.openTask(task);
    try { await this.openTask(await firstValueFrom(this.api.task(this.repoId(), issue.importedTaskId))); }
    catch (e) { this.fail(e); }
  }

  async runTask(): Promise<void> {
    const t = this.selected();
    if (!t) return;
    this.busy.set(true); this.error.set(''); this.streamEnded.set(undefined);
    try {
      const result = await firstValueFrom(this.api.run(this.repoId(), t.id));
      this.logs.set([result.queued ? `در صف اجرا قرار گرفت${result.queuePosition ? ` · جایگاه ${result.queuePosition}` : ''}` : 'اجرا آغاز شد…']);
      this.connectStream(t.id);
      await this.refresh(true);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  async answer(mode: 'approve' | 'reject' | 'clarify', route?: 'implementer' | 'architect'): Promise<void> {
    const t = this.selected();
    if (!t) return;
    if (mode === 'reject' && !this.reason.trim()) { this.error.set('برای رد کردن، دلیل الزامی است.'); return; }
    if (mode === 'clarify' && !this.answerText.trim()) { this.error.set('متن پاسخ را وارد کنید.'); return; }
    this.busy.set(true); this.error.set('');
    try {
      const result = await firstValueFrom(this.api.answer(this.repoId(), t.id, {
        mode,
        reason: this.reason.trim() || undefined,
        text: this.answerText.trim() || undefined,
        route
      }));
      this.info.set(result.autoResumed ? 'تصمیم ثبت شد؛ task به‌صورت خودکار برای ادامه در صف اجرا قرار گرفت.' : 'تصمیم ثبت شد.');
      this.panel.set(null);
      await this.refresh();
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  async loadRootArtifact(path: string): Promise<void> {
    const t = this.selected(); if (!t) return;
    this.rootArtifactName.set(path);
    try { this.rootArtifact.set(await firstValueFrom(this.api.artifact(this.repoId(), t.id, path))); }
    catch (e) { this.rootArtifact.set(''); this.fail(e); }
  }

  async chooseAttempt(attempt: Attempt): Promise<void> {
    const t = this.selected(); if (!t) return;
    this.selectedAttempt.set(attempt);
    const entries = await Promise.all(attempt.artifacts.map(async name => {
      const p = `attempts/${attempt.id}/${name}`;
      return [name, await this.tryArtifact(t.id, p) ?? 'در دسترس نیست'] as const;
    }));
    this.attemptArtifacts.set(Object.fromEntries(entries));
  }

  actionArtifactEntries(): [string, string][] { return Object.entries(this.actionArtifacts()); }
  attemptArtifactEntries(): [string, string][] { return Object.entries(this.attemptArtifacts()); }
  diffFiles(t: Task): Array<{ path?: string; added?: number; deleted?: number }> { return t.diff?.files ?? []; }
  verifyText(t: Task): string { try { return JSON.stringify(t.verify ?? {}, null, 2); } catch { return String(t.verify ?? ''); } }

  eventLabel(e: AgentEvent): string {
    if (e.error) return 'رویداد خراب';
    if (e.event === 'state.changed') return `${String(e.from ?? '—')} ← ${String(e.to ?? '—')}`;
    const labels: Record<string, string> = {
      'human.answered': 'پاسخ انسان ثبت شد', 'human.decision': 'تصمیم انسان ثبت شد',
      'verification.recorded': 'Verification ثبت شد', 'verification.failed': 'Verification شکست خورد',
      'agent.started': 'Agent شروع شد', 'agent.finished': 'Agent تمام شد', 'task.imported': 'Issue به task تبدیل شد',
      'outcome.overridden': 'نتیجه Agent توسط Manager override شد'
    };
    return labels[String(e.event ?? '')] ?? String(e.event ?? 'رویداد');
  }
  eventDetails(e: AgentEvent): string {
    const ignored = new Set(['event', 'at']);
    return Object.entries(e).filter(([key]) => !ignored.has(key)).map(([key, value]) => `${key}: ${this.compact(value)}`).join(' · ');
  }
  formatDate(value?: string | null): string {
    if (!value) return '—'; const d = new Date(value);
    return Number.isFinite(d.getTime()) ? d.toLocaleString('fa-IR') : value;
  }

  markdown(text: string): string {
    if (!text) return '<p class="md-empty">محتوایی برای نمایش وجود ندارد.</p>';
    const lines = text.replace(/\r/g, '').split('\n'); const out: string[] = [];
    let inCode = false; let code: string[] = []; let inList = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    for (const raw of lines) {
      if (raw.trim().startsWith('```')) { closeList(); if (!inCode) { inCode = true; code = []; } else { out.push(`<pre><code>${this.escapeHtml(code.join('\n'))}</code></pre>`); inCode = false; } continue; }
      if (inCode) { code.push(raw); continue; }
      const line = this.escapeHtml(raw); const heading = /^(#{1,4})\s+(.+)$/.exec(line);
      if (heading) { closeList(); const level = heading[1].length; out.push(`<h${level}>${this.inlineMarkdown(heading[2])}</h${level}>`); continue; }
      const item = /^\s*[-*]\s+(.+)$/.exec(line);
      if (item) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${this.inlineMarkdown(item[1])}</li>`); continue; }
      closeList(); if (!line.trim()) { out.push('<div class="md-gap"></div>'); continue; }
      if (/^\s*>\s?/.test(line)) { out.push(`<blockquote>${this.inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`); continue; }
      out.push(`<p>${this.inlineMarkdown(line)}</p>`);
    }
    closeList(); if (inCode) out.push(`<pre><code>${this.escapeHtml(code.join('\n'))}</code></pre>`);
    return out.join('');
  }

  async showIssues(forceRefresh = false): Promise<void> {
    this.panel.set('issues'); this.createResults.set([]);
    try { this.issues.set(await firstValueFrom(this.api.issues(forceRefresh))); }
    catch (e) { this.fail(e); }
  }
  toggleIssue(id: string): void { this.issueSelection.has(id) ? this.issueSelection.delete(id) : this.issueSelection.add(id); }

  prepareSelectedIssues(): void {
    const selected = this.issues().filter(i => this.issueSelection.has(i.externalId) && !i.importedTaskId);
    if (!selected.length) return;
    const drafts = selected.map(issue => ({
      repo: this.repoId(),
      type: 'task' as const,
      slug: this.slugify(issue.title, `task-${issue.externalId}`),
      requestText: [issue.title, issue.body].filter(Boolean).join('\n\n'),
      source: { system: issue.system || 'internal', externalId: issue.externalId, url: issue.url || '', fetchedAt: issue.fetchedAt || new Date().toISOString() },
      displayId: issue.externalId
    }));
    this.openCreate(drafts);
  }

  openManualTask(): void {
    this.openCreate([{ repo: this.repoId(), type: 'task', slug: 'manual-task', requestText: '', displayId: 'خودکار' }]);
  }

  private openCreate(drafts: CreateTaskDraft[]): void {
    this.resetPanelState();
    this.createDrafts.set(drafts);
    this.createIndex.set(0);
    this.createResults.set([]);
    this.createStart = this.currentRepo()?.run?.autoStartOnCreate !== false;
    this.panel.set('create');
  }

  currentDraft(): CreateTaskDraft | null { return this.createDrafts()[this.createIndex()] ?? null; }
  createActiveCount(): number { return this.createDrafts().filter(x => !x.skipped).length; }
  createStepLabel(): string { return `${this.createIndex() + 1} از ${this.createDrafts().length}`; }
  createFolderPreview(d: CreateTaskDraft): string { return `${d.source?.externalId || '<auto>'}-${d.slug || '<slug>'}`; }
  updateDraft(field: keyof CreateTaskDraft, value: unknown): void {
    const index = this.createIndex();
    this.createDrafts.update(items => items.map((item, i) => i === index ? ({ ...item, [field]: value } as CreateTaskDraft) : item));
  }
  nextDraft(): void { if (this.createIndex() < this.createDrafts().length - 1) this.createIndex.update(x => x + 1); }
  prevDraft(): void { if (this.createIndex() > 0) this.createIndex.update(x => x - 1); }
  skipDraft(): void {
    this.updateDraft('skipped', true);
    if (this.createIndex() < this.createDrafts().length - 1) this.nextDraft();
  }
  restoreDraft(): void { this.updateDraft('skipped', false); }

  async createTasks(): Promise<void> {
    const items = this.createDrafts().filter(x => !x.skipped);
    if (!items.length) { this.error.set('هیچ task فعالی برای ساخت باقی نمانده است.'); return; }
    const invalid = items.find(x => !x.slug.trim() || !x.requestText.trim());
    if (invalid) { this.error.set('برای همه taskها slug و متن request الزامی است.'); return; }
    this.busy.set(true); this.error.set('');
    try {
      const response = await firstValueFrom(this.api.createTasks(items, this.createStart));
      this.createResults.set(response.results);
      const failed = response.failed;
      this.info.set(failed ? `${response.succeeded} task ساخته شد؛ ${failed} مورد ناموفق بود.` : `${response.succeeded} task ساخته شد${this.createStart ? ' و وارد صف اجرا شد' : ''}.`);
      this.issueSelection.clear();
      this.issues.set(await firstValueFrom(this.api.issues(true)));
      await this.refresh(true);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  closePanel(): void { this.panel.set(null); this.closeStream(); }

  private notifyNewHumanTasks(tasks: Task[]): void {
    const current = tasks.filter(t => !!t.awaitingHuman).map(t => t.id);
    if (!this.humanSnapshotReady) { current.forEach(id => this.knownHumanTasks.add(id)); this.humanSnapshotReady = true; return; }
    for (const task of tasks.filter(t => !!t.awaitingHuman)) {
      if (!this.knownHumanTasks.has(task.id) && this.notificationPermission() === 'granted' && typeof Notification !== 'undefined') {
        new Notification(`BarsaAgent · Task #${task.id}`, { body: `${this.gateLabel(task)} — ${task.title || task.slug || ''}` });
      }
      this.knownHumanTasks.add(task.id);
    }
    for (const id of [...this.knownHumanTasks]) if (!current.includes(id)) this.knownHumanTasks.delete(id);
  }
  private isActiveTask(t: Task): boolean { return !t.error && !['integrated', 'blocked', 'cancelled', 'abandoned'].includes(t.state); }
  private scopesOverlap(left: string[], right: string[]): boolean {
    if (!left.length || !right.length) return false;
    const base = (pattern: string) => pattern.replace(/\\/g, '/').replace(/[?*].*$/, '').replace(/\/$/, '');
    return left.some(a => right.some(b => { const aa = base(a); const bb = base(b); return !!aa && !!bb && (aa === bb || aa.startsWith(`${bb}/`) || bb.startsWith(`${aa}/`)); }));
  }
  private async loadInitialTaskArtifact(t: Task): Promise<void> {
    const preferred = t.artifacts?.find(x => x === 'task.md') ?? t.artifacts?.find(x => x.endsWith('.md')) ?? t.artifacts?.[0];
    if (preferred) await this.loadRootArtifact(preferred);
    const latest = t.attempts?.at(-1); if (latest) await this.chooseAttempt(latest);
  }
  private async loadActionArtifacts(t: Task): Promise<void> {
    const kind = this.gateKind(t); let paths: string[] = [];
    if (kind === 'spec-approval') paths = ['request.md', 'proposed-task.md'];
    else if (kind === 'clarification') paths = ['questions.md', 'request.md', 'task.md'];
    else if (kind === 'merge-approval') {
      paths = ['review.md'];
      const latest = t.attempts?.at(-1);
      if (latest) {
        const useful = ['changes.diff', 'verification/summary.yaml', 'verification/build.log', 'verification/test.log', 'verification/lint.log'];
        paths.push(...useful.filter(x => latest.artifacts.includes(x)).map(x => `attempts/${latest.id}/${x}`));
      }
    } else if (t.awaitingHuman?.artifact) paths = [t.awaitingHuman.artifact];
    const values = await Promise.all(paths.map(async p => [p, await this.tryArtifact(t.id, p)] as const));
    this.actionArtifacts.set(Object.fromEntries(values.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
  }
  private async tryArtifact(taskId: string, path: string): Promise<string | null> {
    try { return await firstValueFrom(this.api.artifact(this.repoId(), taskId, path)); } catch { return null; }
  }
  private connectStream(taskId: string): void {
    this.closeStream(); this.source = new EventSource(this.api.streamUrl(this.repoId(), taskId));
    this.source.onmessage = event => {
      try {
        const parsed = JSON.parse(event.data) as { text?: string; stream?: string };
        const prefix = parsed.stream === 'stderr' ? '[stderr] ' : parsed.stream === 'system' ? '[system] ' : '';
        this.logs.update(lines => [...lines.slice(-1999), `${prefix}${parsed.text ?? event.data}`]);
      } catch { this.logs.update(lines => [...lines.slice(-1999), event.data]); }
    };
    this.source.addEventListener('end', event => {
      try { this.streamEnded.set((JSON.parse((event as MessageEvent<string>).data) as { code?: number | null }).code ?? null); }
      catch { this.streamEnded.set(null); }
      this.closeStream(); void this.refresh(true);
    });
  }
  private closeStream(): void { this.source?.close(); this.source = undefined; }
  private resetPanelState(): void {
    this.closeStream(); this.error.set(''); this.reason = ''; this.answerText = '';
    this.events.set([]); this.logs.set([]); this.streamEnded.set(undefined); this.rootArtifactName.set(''); this.rootArtifact.set('');
    this.actionArtifacts.set({}); this.selectedAttempt.set(null); this.attemptArtifacts.set({});
  }
  private slugify(value: string, fallback: string): string {
    const slug = String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return slug || fallback;
  }
  private compact(value: unknown): string { if (value == null) return '—'; if (typeof value === 'string') return value; try { return JSON.stringify(value); } catch { return String(value); } }
  private escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
  private inlineMarkdown(value: string): string { return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>'); }
  private fail(e: unknown): void {
    const candidate = e as { error?: { error?: string } | string; message?: string };
    const nested = typeof candidate?.error === 'object' ? candidate.error?.error : candidate?.error;
    this.error.set(nested || candidate?.message || 'خطای ناشناخته');
  }
}
