import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { LoginComponent } from './login.component';
import { ConsoleComponent } from './console.component';
import { MaintenanceComponent } from './maintenance.component';
import { BundlesComponent } from './bundles.component';
import { AuditComponent, EnvHealthComponent } from './env-health.component';
import { TaskOpsComponent } from './task-ops.component';
import { TaskRuntimeComponent } from './task-runtime.component';
import { RuntimePickerComponent } from './runtime-picker.component';
import { attemptModelCell, createRuntimePayload, duplicateText, runtimeEventText, runtimeInvalidText } from './runtime';
import { ArchiveComponent } from './archive.component';
import { actionsVersionOf, allowed, can, canAnswerGate } from './task-actions';
import { BOARD_DONE_STATES, archiveTasks, isFinished, isRecentlyDone, normalizeDoneDays } from './task-archive';
import { AgentEvent, Attempt, Board, CreateTaskDraft, CreateTaskResult, DrainStatus, ExternalSource, HealthResult, Issue, Repo, RunningTask, RuntimeOptions, StructuredFailure, Task } from './models';

const LANES = [
  { title: 'ورودی', states: ['new'] },
  { title: 'طراحی', states: ['architecture', 'needs-clarification', 'needs-investigation', 'failed'] },
  { title: 'آماده', states: ['ready'] },
  { title: 'پیاده‌سازی', states: ['implementing', 'rejected'] },
  { title: 'بازبینی', states: ['review'] },
  { title: 'تأییدشده', states: ['approved', 'integrating', 'conflict'] },
  { title: 'منتظر ثبت در تی‌اف‌اس', states: ['awaiting-external-checkin'] },
  { title: 'تمام', states: ['integrated'] }
] as const;

const TERMINAL_STATES = ['blocked', 'cancelled', 'abandoned'] as const;

// منبع واقعی: TASK_TRANSITIONS در manager.js (AGENT-WORKFLOW.md بخش ۳ خودش
// می‌گوید «منبع: TASK_TRANSITIONS»، ولی فهرست دستی همان سند awaiting-external-
// checkin را که خودِ TASK_TRANSITIONS به‌عنوان مقصد integrating دارد، جا انداخته
// — هر وقت این دو نخوانند، کد برنده است، نه نثر سند). هر state ای که اینجا
// نباشد باید در ستون «ناشناخته» دیده شود، نه پنهان.
const KNOWN_STATES = new Set<string>([
  ...LANES.flatMap(lane => [...lane.states]),
  ...TERMINAL_STATES
]);

const EXIT_LABELS: Record<number, string> = {
  0: 'تمام شد — integrated',
  10: 'منتظر توست',
  20: 'متوقف',
  30: 'بدون پیشرفت — احتمالاً باگ',
  40: 'منتظر آزاد شدن scope (خطا نیست)',
  41: 'اجرای تسک روی این دستگاه خاموش است (execution.enabled=false) — خطای ناشناخته نیست',
  42: 'ردِ تکراری — بررسی دستی لازم است',
  1: 'خطای اجرایی'
};

const DIFF_RENDER_LIMIT = 2000;

const BLOCKER_LABELS: Record<string, { label: string; hint: string }> = {
  'budget-exhausted': { label: 'بودجه تمام شد', hint: 'باید budget این نقش را در manifest دستی افزایش دهی یا task را ببندی.' },
  'environment': { label: 'مشکل محیط', hint: 'خطای ابزار/محیط اجرا — لاگ اجرای آخر را ببین، نه spec یا کد.' },
  'unsatisfiable-gate': { label: 'گیت غیرقابل‌عبور', hint: 'شرط verification با تنظیمات فعلی repository.yaml قابل برآورده‌شدن نیست.' },
  'rebase-conflict': { label: 'تداخل rebase', hint: 'rebase خودکار conflict داد — نیاز به rebase دستی یا بررسی انسانی دارد.' },
  'spec-churn': { label: 'نوسان spec', hint: 'چرخه‌ی respec زیاد تکرار شده — spec را مستقیم بررسی کن.' },
  'attempts-exhausted': { label: 'سقف تلاش‌ها', hint: 'شمارنده‌ی سراسری attempts پر شده — task را ببند یا بودجه را دستی زیاد کن.' }
};

const VIEW_STORAGE_KEY = 'ba.view';

/** آخرین تب انتخاب‌شده‌ی «برد یا آرشیو» (فقط این دو ذخیره می‌شوند؛ صفحه‌های عملیاتی نه). */
function readStoredView(): 'board' | 'archive' {
  try { return localStorage.getItem(VIEW_STORAGE_KEY) === 'archive' ? 'archive' : 'board'; }
  catch { return 'board'; } // localStorage بسته است (حالت خصوصی/سیاست)
}

type Panel = 'task' | 'action' | 'issues' | 'create' | 'recovery' | 'checkin' | 'note' | 'stage' | null;

@Component({
  selector: 'ba-root',
  standalone: true,
  imports: [CommonModule, FormsModule, LoginComponent, ConsoleComponent, MaintenanceComponent, BundlesComponent, EnvHealthComponent, AuditComponent, TaskOpsComponent, TaskRuntimeComponent, RuntimePickerComponent, ArchiveComponent],
  templateUrl: './app.component.html'
})
export class AppComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService);
  readonly auth = inject(AuthService);
  // کانبان فاز ۱: صفحه‌های کنسول/نگهداری/سلامت/ممیزی کنار برد
  readonly view = signal<'board' | 'archive' | 'console' | 'maintenance' | 'bundles' | 'health' | 'audit'>(readStoredView());
  private started = false;
  private poll?: number;
  private source?: EventSource;

  readonly repos = signal<Repo[]>([]);
  readonly repoId = signal('');
  readonly board = signal<Board | null>(null);
  readonly running = signal<Record<string, RunningTask>>({});
  readonly health = signal<HealthResult | null>(null);
  /** حالت ِ تخلیه (drain) از /api/drain؛ نوار ِ بالای همه‌ی نماها. */
  readonly drain = signal<DrainStatus | null>(null);
  readonly healthLoading = signal(false);
  readonly healthError = signal('');
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
  readonly diffText = signal('');
  readonly diffHeadCommit = signal<string | null>(null);
  readonly diffSelectedFile = signal<string | null>(null);
  readonly diffLoaded = signal(false);
  readonly taskTab = signal<'overview' | 'diff'>('overview');

  readonly issues = signal<Issue[]>([]);
  readonly createDrafts = signal<CreateTaskDraft[]>([]);
  readonly createIndex = signal(0);
  readonly createResults = signal<CreateTaskResult[]>([]);
  /** گزینه‌های `runtime --options` برای فرم ساخت (فقط از Manager). */
  readonly runtimeOptions = signal<RuntimeOptions | null>(null);
  /** دلیل ِ «ساخت تسک تکراری» به‌تفکیک ِ کلید ِ نتیجه. */
  readonly dupReasons = signal<Record<string, string>>({});
  readonly busy = signal(false);
  readonly lanes = LANES;
  readonly issueSelection = new Set<string>();
  readonly notificationPermission = signal<NotificationPermission | 'unsupported'>(typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
  private readonly knownHumanTasks = new Set<string>();
  private humanSnapshotReady = false;

  reason = '';
  answerText = '';
  respec = false;
  // release-note-at-merge.md، بند ه: پیش‌فرض پذیرشِ متن Intake بدون دست‌زدن
  // است — این فیلدها فقط وقتی واقعاً استفاده می‌شوند که کاربر صریحاً «ویرایش
  // متن» را باز کند، یا task.releaseNote===null باشد (تسک قدیمی‌تر از قرارداد،
  // جایی که یکی از دو مسیر اجباری است).
  readonly releaseNoteEditing = signal(false);
  releaseNoteHeadline = '';
  releaseNoteBody = '';
  releaseNoteNoNote = false;
  releaseNoteReason = '';
  createStart = true;
  dangerReason = '';
  dangerForce = false;
  readonly dangerOpen = signal<'void' | 'cancel' | 'unlock' | null>(null);
  readonly mergeAck = signal(false);
  private readonly openedHeadCommit = signal<string | null | undefined>(undefined);

  // clarify + --external-access اختیاری (فقط وقتی actions.externalAccess غیرخالی است)
  clarifyAccessSource = '';
  clarifyAccessLevel: 'read' | 'write' = 'write';
  checkinSourceId = '';
  checkinChangesets = '';
  noteText = '';
  stageSourceId = '';

  constructor() {
    // ورود اجباری است: داده‌ها فقط بعد از ورود خوانده می‌شوند و با پایان نشست پاک می‌شوند.
    effect(() => {
      const user = this.auth.user();
      untracked(() => { if (user) void this.start(); else this.stop(); });
    });
  }

  async ngOnInit(): Promise<void> {
    await this.auth.init();
  }

  async logout(): Promise<void> { await this.auth.logout(); }

  private stop(): void {
    this.started = false;
    if (this.poll) window.clearInterval(this.poll);
    this.poll = undefined;
    this.closeStream();
    this.board.set(null);
    this.selected.set(null);
    this.panel.set(null);
    this.view.set(readStoredView());
    this.loading.set(true);
  }

  private async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
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
    void this.refreshDrain();
    this.poll = window.setInterval(() => {
      if (this.auth.user()) void this.refreshDrain();
      if (this.panel() === 'task' || this.panel() === 'action' || !this.auth.user() || (this.view() !== 'board' && this.view() !== 'archive')) return;
      void this.refresh(true);
    }, 3000);
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

  // status --json در اولین اجرا (cache سرد Manager) تا ~۱۵ ثانیه طول می‌کشد؛ poll ِ بعدی تا تمام شدن
  // این یکی شروع نمی‌شود (وگرنه چند فرآیند Manager روی هم انباشته می‌شود).
  private refreshInFlight = false;

  async refresh(silent = false): Promise<void> {
    if (!this.repoId()) return;
    if (silent) {
      if (this.refreshInFlight) return;
    }
    this.refreshInFlight = true;
    try { await this.refreshOnce(silent); }
    finally { this.refreshInFlight = false; }
  }

  private async refreshOnce(silent: boolean): Promise<void> {

    // Health مستقل از board/running بارگذاری می‌شود. خرابی یا تأخیر یکی نباید
    // وضعیت دیگری را مبهم کند یا Health را به‌اشتباه «ناسالم» نشان دهد.
    const healthPromise = this.refreshHealth(false, true);

    try {
      const [board, running] = await Promise.all([
        firstValueFrom(this.api.board(this.repoId())),
        firstValueFrom(this.api.running(this.repoId()))
      ]);
      this.board.set(board);
      this.running.set(Object.fromEntries(running.map(x => [x.taskId, x])));
      this.notifyNewHumanTasks(board.tasks);
      const selected = this.selected();
      if (selected) {
        const fresh = board.tasks.find(x => x.id === selected.id);
        if (fresh) {
          if (this.panel() === 'task') {
            const detailBody = document.querySelector<HTMLElement>('.task-detail');
            const scrollTop = detailBody?.scrollTop;
            this.selected.set(fresh);
            if (detailBody && scrollTop !== undefined) {
              requestAnimationFrame(() => {
                if (detailBody.isConnected) detailBody.scrollTop = scrollTop;
              });
            }
          } else {
            this.selected.set(fresh);
          }
          const watched = this.openedHeadCommit();
          if (
            this.panel() === 'action' && watched !== undefined &&
            this.gateKind(fresh) === 'merge-approval' && (fresh.git?.headCommit ?? null) !== watched
          ) {
            this.info.set('headCommit تغییر کرد (مثلاً rebase خودکار) — گیت merge دوباره تازه شد؛ تأیید قبلی باطل است.');
            await this.openTask(fresh, true);
          }
        }
      }
      if (!silent) this.error.set('');
    } catch (e) {
      if (!silent) this.fail(e);
    }

    await healthPromise;
  }

  async refreshDrain(): Promise<void> {
    try { this.drain.set(await firstValueFrom(this.api.drain())); } catch { /* نوار ِ تخلیه اختیاری است؛ خطای شبکه را board نشان می‌دهد */ }
  }

  draining(): boolean { return this.drain()?.draining === true; }

  async drainOff(): Promise<void> {
    try { this.drain.set(await firstValueFrom(this.api.drainOff())); await this.refresh(true); } catch (e) { this.fail(e); }
  }

  async refreshHealth(force = true, silent = false): Promise<void> {
    if (!this.repoId()) return;
    this.healthLoading.set(true);
    this.healthError.set('');
    try {
      const health = await firstValueFrom(this.api.health(this.repoId(), force));
      this.health.set(health);
    } catch (e) {
      this.health.set(null);
      this.healthError.set(this.errorText(e));
      if (!silent) this.fail(e);
    } finally {
      this.healthLoading.set(false);
    }
  }

  showView(view: 'board' | 'archive' | 'console' | 'maintenance' | 'bundles' | 'health' | 'audit'): void {
    this.view.set(view);
    if (view === 'board' || view === 'archive') {
      try { localStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* ذخیره اختیاری است */ }
    }
  }

  doneDays(): number { return normalizeDoneDays(this.currentRepo()?.board?.doneDays); }
  /** پایان‌یافته‌ها فقط در ستون «تمام» و فقط در N روز اخیر؛ بقیه در تب آرشیو. */
  tasksFor(states: readonly string[]): Task[] {
    const now = new Date();
    return (this.board()?.tasks ?? []).filter(t => states.includes(t.state) && !t.error && (!isFinished(t) || isRecentlyDone(t, this.doneDays(), now)));
  }
  laneIsDone(lane: { states: readonly string[] }): boolean { return lane.states.some(s => BOARD_DONE_STATES.includes(s)); }
  archiveCount(): number { return archiveTasks(this.board()?.tasks ?? []).length; }
  finished(t: Task): boolean { return isFinished(t); }
  /** بخش جدای برد: فقط blocked (تصمیم انسان لازم است). cancelled/abandoned فقط در آرشیواند. */
  terminalTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => t.state === 'blocked' && !t.error); }
  errorTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => !!t.error || t.state === '__error__'); }
  // بند الف کانبان-اکشن‌های-وب‌تری: هر state ای که نه در lanes، نه در
  // TERMINAL_STATES باشد — یعنی چیزی که این UI هنوز نمی‌شناسد — باید دیده
  // شود، نه پنهان شود.
  unknownStateTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => !t.error && !KNOWN_STATES.has(t.state)); }
  humanTasks(): Task[] { return (this.board()?.tasks ?? []).filter(t => !!t.awaitingHuman && !t.error); }
  queuedTasks(): RunningTask[] { return Object.values(this.running()).filter(x => x.queued); }
  gateKind(t: Task | null): string { return t?.awaitingHuman?.kind ?? ''; }
  gateLabel(t: Task): string {
    return ({ 'spec-approval': 'تأیید spec', clarification: 'پاسخ به سؤال', 'merge-approval': 'تأیید merge' } as Record<string, string>)[this.gateKind(t)] ?? 'اقدام انسانی';
  }

  // حادثه‌ی ۲۶ سپتامبر، بند «د»: قفل سراسری/کثیفی بی‌صاحب مسائل سطح مخزن‌اند،
  // نه یک task خاص — قبلاً هیچ‌جای UI دیده نمی‌شدند. یک نوار بالای برد،
  // مشتق از همان health که Manager در status --json حساب کرده (نه منطق تازه‌ی UI).
  repositoryHealthProblem(): boolean {
    const h = this.board()?.repository?.health;
    if (!h) return false;
    return (h.managerLock !== null && h.managerLock.alive !== false) || h.unownedDirtyFiles.length > 0 || !h.acceptsOperations;
  }
  repositoryHealthLabel(): string {
    const h = this.board()?.repository?.health;
    if (!h) return '';
    const parts: string[] = [];
    if (h.managerLock) {
      const lock = h.managerLock;
      const alive = lock.alive === true ? 'زنده' : lock.alive === false ? 'مرده' : 'نامشخص';
      parts.push(`قفل سراسری (task ${lock.task || '؟'}، pid ${lock.pid ?? '؟'}، ${alive})`);
    }
    if (h.unownedDirtyFiles.length) parts.push(`${h.unownedDirtyFiles.length} فایل کثیفِ بی‌صاحب`);
    if (!h.acceptsOperations) parts.push('مخزن الان پذیرای عملیات تازه نیست');
    return parts.join(' · ');
  }

  mergeBranch(t: Task): string | null { return t.git?.branch || null; }
  managerMerges(): boolean { return this.board()?.repo?.mergedBy === 'manager'; }
  mergeCommand(t: Task): string | null { const b = this.mergeBranch(t); return b ? `git merge --no-ff ${b}` : null; }
  async copyMergeCommand(t: Task): Promise<void> {
    const command = this.mergeCommand(t);
    if (!command) return;
    try { await navigator.clipboard.writeText(command); this.info.set('دستور merge کپی شد.'); }
    catch { this.error.set('کپی خودکار ممکن نشد؛ دستور را دستی انتخاب کن.'); }
  }
  blockerLabel(t: Task): string { const kind = t.blocker?.kind || ''; return BLOCKER_LABELS[kind]?.label ?? kind ?? '—'; }
  blockerHint(t: Task): string { const kind = t.blocker?.kind || ''; return BLOCKER_LABELS[kind]?.hint ?? ''; }
  disabledGatesTitle(t: Task): string { return (t.verify?.disabled ?? []).map(d => d.gate).join('، '); }
  stuckReasonsLabel(t: Task): string {
    // «بدون پیشرفت» اینجا نیست عمداً — آن از exitCodeFor(t)===30 می‌آید (EXIT_LABELS)، نه health.stuckReasons.
    const labels: Record<string, string> = { 'stale-lock': 'قفل جامانده', 'dirty-worktree': 'تغییرات commit‌نشده' };
    return (t.health?.stuckReasons ?? []).map(r => labels[r] ?? r).join(' · ') || 'نامشخص';
  }
  stuckReasonsTitle(t: Task): string {
    const lock = t.health?.transitionLock;
    const lockPart = lock ? `state=${lock.fromState || '—'}، شروع ${this.formatDate(lock.startedAt)}` : '';
    const dirtyPart = (t.health?.dirtyPaths?.length ?? 0) > 0 ? `${t.health?.dirtyPaths?.length} مسیر commit‌نشده` : '';
    return [lockPart, dirtyPart].filter(Boolean).join(' · ');
  }
  // کانبان-اکشن‌های-وب‌تری، بند هـ — دقیقاً همان رویدادی که تسک ۱۰۰۰۹ را جا
  // گذاشت: manifest ِ commit‌نشده state را عوض نشان می‌دهد ولی transition
  // شکست خورده. health.transitionLock هر مقدار غیر-null باشد (حتی اگر alive
  // باشد، یعنی یک transition دیگر همین الان در جریان است) هم باید قفل‌کننده
  // باشد — نه فقط stuck=true — چون Manager خودش assertNoTransitionLock را
  // بدون قید «آیا stale است» رد می‌کند.
  taskLocked(t: Task | null): boolean {
    if (!t) return true;
    return t.health?.stuck === true || t.health?.transitionLock != null;
  }
  // «مجاز است؟» فقط از actions ِ status --json (task-actions.ts)؛ هیچ تصمیمی از روی state/blocker/awaitingHuman نیست.
  can(t: Task | null, action: Parameters<typeof can>[1]): boolean { return can(t, action); }
  canAnswerGate(t: Task | null): boolean { return canAnswerGate(t); }
  externalAccessChoices(t: Task | null): string[] { return allowed(t, 'externalAccess'); }
  /** بعد از approve/reject/clarify (فقط همین سه) کانبان خودش run می‌زند — وقتی run.autoResumeAfterAnswer روشن است. */
  autoResume(): boolean { return this.currentRepo()?.run?.autoResumeAfterAnswer !== false; }

  // الحاقیه‌ی ۱، بند ب: externalSources از status --json (TOOLING-032) —
  // actions همان شرط‌هایی است که answer خودش می‌سنجد؛ کانبان شرط دیگری
  // رویش نمی‌سازد، نه از access/state/غیره.
  externalSourcesOf(t: Task | null): ExternalSource[] { return (t?.externalSources ?? []).filter(s => !s.error); }
  stageableSources(t: Task | null): ExternalSource[] { return this.externalSourcesOf(t).filter(s => s.actions?.canStageExternal === true); }
  checkinableSources(t: Task | null): ExternalSource[] { return this.externalSourcesOf(t).filter(s => s.actions?.canMarkCheckedIn === true); }
  shortSha(sha?: string | null): string { return sha ? sha.slice(0, 8) : '—'; }

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

  // --- قفل اجرا (TOOLING-040): فقط از repository.execution ِ status --json؛ غایب (Manager قدیمی) = روشن ---------
  readonly executionOffTitle = 'اجرای تسک روی این دستگاه خاموش است (execution.enabled=false)';
  executionDisabled(): boolean { return this.board()?.repository?.execution?.enabled === false; }
  executionDetail(): string {
    const execution = this.board()?.repository?.execution;
    return [execution?.reason, execution?.source ? `منبع: ${execution.source}` : ''].filter(Boolean).join(' — ');
  }
  /** capabilities.status.actionsVersion ِ Manager مخزن فعلی (null = نامشخص/قدیمی). */
  actionsVersion(): number | null { return actionsVersionOf(this.currentRepo()?.manager?.capabilities); }
  hasStatusCapability(key: 'verify' | 'review' | 'health'): boolean { return this.currentRepo()?.manager?.statusFields?.[key] === true; }
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
  healthLabel(): string {
    if (this.healthLoading() && !this.health()) return 'در حال بررسی Agent-work…';
    if (this.healthError()) return 'بررسی Agent-work انجام نشد';
    const health = this.health();
    if (!health) return 'وضعیت Agent-work هنوز بررسی نشده';
    return health.ok ? 'Agent-work سالم' : 'Agent-work نیاز به بررسی دارد';
  }

  healthDetails(): string {
    if (this.healthError()) return this.healthError();
    return this.health()?.output || '';
  }

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
      if (action) {
        await this.loadActionArtifacts(fresh);
        if (this.gateKind(fresh) === 'merge-approval') {
          this.openedHeadCommit.set(fresh.git?.headCommit ?? null);
          await this.loadDiff(fresh);
        }
      } else {
        await this.loadInitialTaskArtifact(fresh);
      }
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

  worktreeLive(t: Task): boolean { return t.worktree?.status === 'active' && !!t.worktree?.path; }
  editorTitle(t: Task): string { return this.worktreeLive(t) ? 'باز کردن worktree در editor' : 'worktree این task زنده نیست'; }
  async openEditor(t: Task, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.busy.set(true); this.error.set('');
    try {
      const result = await firstValueFrom(this.api.openEditor(this.repoId(), t.id));
      this.info.set(`editor برای ${result.worktreePath} باز شد.`);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  async answer(mode: 'approve' | 'reject' | 'clarify', route?: 'implementer' | 'architect'): Promise<void> {
    const t = this.selected();
    if (!t) return;
    if (mode === 'reject' && !this.reason.trim()) { this.error.set('برای رد کردن، دلیل الزامی است.'); return; }
    if (mode === 'clarify' && !this.answerText.trim()) { this.error.set('متن پاسخ را وارد کنید.'); return; }
    if (mode === 'approve' && this.releaseNoteBlocksApprove(t)) { this.error.set('قبل از تأیید، متن کاربرپسند (یا دلیل نبودش) را کامل کن.'); return; }
    this.busy.set(true); this.error.set('');
    // release-note-at-merge.md، بند ه: فقط وقتی override واقعاً خواسته شده
    // (edit باز است، یا تسک قدیمی release-note ندارد) فیلدهای تازه می‌روند —
    // در غیر این صورت پیش‌فرض Manager (پذیرش بدون دست‌زدن) دست نمی‌خورد.
    let releaseNoteText: string | undefined;
    let noReleaseNote: boolean | undefined;
    let releaseNoteReasonToSend: string | undefined;
    if (mode === 'approve' && (this.gateKind(t) === 'spec-approval' || this.gateKind(t) === 'merge-approval')) {
      const mustOverride = t.releaseNote == null || this.releaseNoteEditing();
      if (mustOverride) {
        if (t.releaseNote == null && this.releaseNoteNoNote) {
          noReleaseNote = true;
          releaseNoteReasonToSend = this.releaseNoteReason.trim();
        } else {
          releaseNoteText = this.buildReleaseNoteOverrideText(this.releaseNoteHeadline.trim(), this.releaseNoteBody.trim());
        }
      }
    }
    try {
      const result = await firstValueFrom(this.api.answer(this.repoId(), t.id, {
        mode,
        reason: mode === 'reject' ? (this.reason.trim() || undefined) : releaseNoteReasonToSend,
        text: this.answerText.trim() || undefined,
        route,
        respec: mode === 'clarify' ? this.respec : undefined,
        externalAccess: mode === 'clarify' && this.clarifyAccessSource ? { sourceId: this.clarifyAccessSource, access: this.clarifyAccessLevel } : undefined,
        releaseNoteText,
        noReleaseNote
      }));
      this.info.set(result.autoResumed ? 'تصمیم ثبت شد؛ task به‌صورت خودکار برای ادامه در صف اجرا قرار گرفت.' : 'تصمیم ثبت شد.');
      this.panel.set(null);
      await this.refresh();
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  // --- release-note-at-merge.md، بند ه ---

  releaseNoteBlocksApprove(t: Task): boolean {
    const kind = this.gateKind(t);
    if (kind !== 'spec-approval' && kind !== 'merge-approval') return false;
    if (t.releaseNote == null) {
      if (this.releaseNoteNoNote) return !this.releaseNoteReason.trim();
      return !this.releaseNoteHeadline.trim() || !this.releaseNoteBody.trim();
    }
    if (this.releaseNoteEditing()) return !this.releaseNoteHeadline.trim() || !this.releaseNoteBody.trim();
    return false;
  }

  startReleaseNoteEdit(t: Task): void {
    this.releaseNoteHeadline = t.releaseNote?.userVisible ? (t.releaseNote.headline || '') : '';
    this.releaseNoteBody = t.releaseNote?.userVisible ? (t.releaseNote.body || '') : '';
    this.releaseNoteEditing.set(true);
  }
  cancelReleaseNoteEdit(): void { this.releaseNoteEditing.set(false); }

  private buildReleaseNoteOverrideText(headline: string, body: string): string {
    const escaped = headline.replace(/"/g, '\\"');
    return `---\nuserVisible: true\nheadline: "${escaped}"\n---\n\n${body}\n`;
  }

  async copyReleaseNote(t: Task): Promise<void> {
    const text = t.releaseNote?.userVisible ? (t.releaseNote.body || '') : '';
    if (!text) return;
    try { await navigator.clipboard.writeText(text); this.info.set('متن کپی شد.'); }
    catch { this.error.set('کپی خودکار ممکن نشد؛ متن را دستی انتخاب کن.'); }
  }

  openDanger(kind: 'void' | 'cancel' | 'unlock'): void { this.dangerOpen.set(kind); this.dangerReason = ''; this.dangerForce = false; }
  closeDanger(): void { this.dangerOpen.set(null); this.dangerReason = ''; this.dangerForce = false; this.clarifyAccessSource = ''; this.clarifyAccessLevel = 'write'; }

  // نشان قرمز کارت — «بازیابی از داخل ابزار» بند ۳: پنل جدا، جدا از جزئیات
  // معمولی task، تا کاربر مجبور نباشد اول تب Diff/جزئیات را رد کند تا به
  // چیزی که واقعاً خراب است برسد.
  openRecovery(t: Task, event?: Event): void {
    event?.stopPropagation();
    this.selected.set(t);
    this.panel.set('recovery');
  }

  // الحاقیه‌ی ۱، بند ب — «ثبت شد در تی‌اف‌اس» حالا از actions.canMarkCheckedIn
  // پیروی می‌کند، نه از مقایسه‌ی state. انتخاب منبع هم از externalSources
  // می‌آید؛ اگر یکی باشد خودکار پر می‌شود، اگر چند تا باشد انسان انتخاب می‌کند.
  openCheckin(t: Task, event?: Event): void {
    event?.stopPropagation();
    this.resetPanelState();
    this.selected.set(t);
    const sources = this.checkinableSources(t);
    this.checkinSourceId = sources.length === 1 ? sources[0].id : '';
    this.checkinChangesets = '';
    this.panel.set('checkin');
  }
  // چند مقدار را با کاما یا خط تازه جدا می‌کند — فیلد باید چند شماره‌ی ثبت
  // بپذیرد (بند ج).
  checkinChangesetList(): string[] {
    return this.checkinChangesets.split(/[\n,]+/).map(x => x.trim()).filter(Boolean);
  }
  // «عدد خالی را هم با افزودن C بپذیر» (بند ج) — هر مقدار یا از اول C دارد،
  // یا فقط عدد است (که در ارسال نهایی C می‌گیرد).
  checkinChangesetsValid(): boolean {
    return this.checkinChangesetList().every(v => /^c?\d+$/i.test(v));
  }
  checkinValid(t: Task | null): boolean {
    if (!t) return false;
    if (!this.checkinableSources(t).some(s => s.id === this.checkinSourceId)) return false;
    return this.checkinChangesetsValid();
  }
  async confirmCheckin(): Promise<void> {
    const t = this.selected();
    if (!t || !this.checkinValid(t)) return;
    this.busy.set(true); this.error.set('');
    try {
      const changesets = this.checkinChangesetList().map(v => /^\d+$/.test(v) ? `C${v}` : v);
      await firstValueFrom(this.api.externalCheckedIn(this.repoId(), t.id, { sourceId: this.checkinSourceId, changesets }));
      this.info.set('ثبت در تی‌اف‌اس اعلام شد.');
      this.panel.set(null);
      await this.refresh();
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  // الحاقیه‌ی ۱، بند ب — «انتقال به وب‌تری واقعی». فقط وقتی دیده/فعال است که
  // actions.canStageExternal === true باشد (status --json واقعی، نه حدس
  // کانبان). خودِ --stage-external فایل‌های WebIII واقعی را عوض می‌کند —
  // پنل یک تأیید صریح است، نه کلیک مستقیم از روی کارت.
  openStage(t: Task, event?: Event): void {
    event?.stopPropagation();
    this.resetPanelState();
    this.selected.set(t);
    const sources = this.stageableSources(t);
    this.stageSourceId = sources.length === 1 ? sources[0].id : '';
    this.panel.set('stage');
  }
  stageValid(t: Task | null): boolean {
    return !!t && this.stageableSources(t).some(s => s.id === this.stageSourceId);
  }
  async confirmStage(): Promise<void> {
    const t = this.selected();
    if (!t || !this.stageValid(t)) return;
    this.busy.set(true); this.error.set('');
    try {
      await firstValueFrom(this.api.stageExternal(this.repoId(), t.id, { sourceId: this.stageSourceId }));
      this.info.set('منبع بیرونی stage شد — فایل‌های واقعی وب‌تری عوض شدند.');
      this.panel.set(null);
      await this.refresh();
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  // کانبان-اکشن‌های-وب‌تری، بند د — یادداشت برای اجرای بعدی. state-محور است
  // (manager.js#handleNoteDecision)، نه awaitingHuman — در هر state غیرپایانی
  // (actions.note) قابل ارسال است.
  openNote(t: Task, event?: Event): void {
    event?.stopPropagation();
    this.resetPanelState();
    this.selected.set(t);
    this.noteText = '';
    this.panel.set('note');
  }
  async submitNote(): Promise<void> {
    const t = this.selected();
    if (!t || !this.noteText.trim()) return;
    this.busy.set(true); this.error.set('');
    try {
      await firstValueFrom(this.api.note(this.repoId(), t.id, this.noteText));
      this.info.set('یادداشت ثبت شد؛ اجرای بعدی آن را می‌خواند.');
      this.panel.set(null);
      await this.refresh();
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  async confirmDanger(): Promise<void> {
    const t = this.selected();
    const kind = this.dangerOpen();
    if (!t || !kind) return;
    if (!this.dangerReason.trim()) { this.error.set('برای این عمل، دلیل الزامی است.'); return; }
    this.busy.set(true); this.error.set('');
    try {
      const reason = this.dangerReason.trim();
      const call =
        kind === 'void' ? this.api.voidTask(this.repoId(), t.id, reason) :
        kind === 'cancel' ? this.api.cancelTask(this.repoId(), t.id, reason) :
        this.api.unlockTask(this.repoId(), t.id, reason, this.dangerForce);
      await firstValueFrom(call);
      this.info.set(kind === 'void' ? 'transition باطل شد.' : kind === 'cancel' ? 'task بسته شد.' : 'قفل آزاد شد.');
      this.closeDanger();
      this.panel.set(null);
      await this.refresh();
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  async rebaseTask(): Promise<void> {
    const t = this.selected();
    if (!t) return;
    this.busy.set(true); this.error.set('');
    try {
      await firstValueFrom(this.api.rebaseTask(this.repoId(), t.id));
      this.info.set('rebase انجام شد.');
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
  // فقط تغییرات زیر src/ برای بررسی مرتبط‌اند — چیزهایی مثل ai-context دفترداری‌اند، نه کد.
  diffFiles(t: Task): Array<{ path?: string; added?: number; deleted?: number; status?: string; inScope?: boolean }> {
    return (t.diff?.files ?? []).filter(f => this.isSourceFile(f.path));
  }
  private isSourceFile(path?: string | null): boolean {
    if (!path) return false;
    const p = path.replace(/\\/g, '/');
    return p === 'src' || p.startsWith('src/') || p.includes('/src/');
  }
  verifyText(t: Task): string { try { return JSON.stringify(t.verify ?? {}, null, 2); } catch { return String(t.verify ?? ''); } }
  // خروجی فیلترشده‌ی هم‌ارز diffText — فقط بخش‌های src/؛ اگر مرزبندی per-file
  // قابل تشخیص نبود (مثلاً artifact خالی)، بدون فیلتر برمی‌گردد تا چیزی از دست نرود.
  private sourceDiffText(): string {
    const full = this.diffText();
    if (!full) return '';
    const segments = this.diffSegments(full);
    if (!segments.size) return full;
    return [...segments.entries()].filter(([path]) => this.isSourceFile(path)).map(([, seg]) => seg).join('\n');
  }
  diffLineCount(): number { const text = this.sourceDiffText(); return text ? text.split(/\r?\n/).length : 0; }
  diffPreview(): string { return this.sourceDiffText().split(/\r?\n/).slice(0, DIFF_RENDER_LIMIT).join('\n'); }
  diffTruncated(): boolean { return this.diffLineCount() > DIFF_RENDER_LIMIT; }
  diffLimit(): number { return DIFF_RENDER_LIMIT; }
  // headCommit این diff دقیقاً همان بلوک artifact است که تولید شده؛ اگر با
  // git.headCommit تازهٔ task نمی‌خواند یعنی rebase/تغییری بعد از تولید diff
  // رخ داده — تأیید باید به همان commit تعلق داشته باشد که دیده شده.
  diffStale(t: Task): boolean {
    const diffHead = t.diff?.headCommit;
    const gitHead = t.git?.headCommit;
    return !!diffHead && !!gitHead && diffHead !== gitHead;
  }
  selectDiffFile(path: string | null): void { this.diffSelectedFile.set(path); }
  diffDisplayText(): string {
    const sel = this.diffSelectedFile();
    if (!sel) return this.diffPreview();
    const segment = this.diffSegments(this.diffText()).get(sel);
    return segment ? segment.split(/\r?\n/).slice(0, DIFF_RENDER_LIMIT).join('\n') : 'hunk این فایل در artifact پیدا نشد.';
  }
  diffDisplayTruncated(): boolean {
    const sel = this.diffSelectedFile();
    if (!sel) return this.diffTruncated();
    const segment = this.diffSegments(this.diffText()).get(sel) ?? '';
    return segment.split(/\r?\n/).length > DIFF_RENDER_LIMIT;
  }
  diffColorize(text: string): string {
    return text.split(/\r?\n/).map(line => {
      const esc = this.escapeHtml(line);
      if (/^(\+\+\+|---) /.test(line)) return `<span class="diff-file-line">${esc}</span>`;
      if (line.startsWith('+')) return `<span class="diff-add">${esc}</span>`;
      if (line.startsWith('-')) return `<span class="diff-del">${esc}</span>`;
      if (line.startsWith('@@')) return `<span class="diff-hunk">${esc}</span>`;
      return `<span>${esc || ' '}</span>`;
    }).join('\n');
  }
  // پچ خام یک رشته‌ی تخت است؛ تقسیم به فایل روی مرز «diff --git» و مسیر از
  // اولین خط --- a/ یا +++ b/ همان بخش گرفته می‌شود تا با path در diff.files بخواند.
  private diffSegments(text: string): Map<string, string> {
    const map = new Map<string, string>();
    if (!text) return map;
    let current: string[] = [];
    let currentPath: string | null = null;
    const flush = () => { if (currentPath && current.length) map.set(currentPath, current.join('\n')); };
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('diff --git ')) { flush(); current = [line]; currentPath = null; continue; }
      current.push(line);
      if (currentPath === null) {
        const m = /^\+\+\+ b\/(.+)$/.exec(line) || /^--- a\/(.+)$/.exec(line);
        if (m) currentPath = m[1];
      }
    }
    flush();
    return map;
  }
  openDiffTab(): void {
    this.taskTab.set('diff');
    const t = this.selected();
    if (t && !this.diffLoaded()) void this.loadDiff(t);
  }

  eventLabel(e: AgentEvent): string {
    if (e.error) return 'رویداد خراب';
    const runtime = runtimeEventText(e);
    if (runtime) return runtime.label;
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
    const runtime = runtimeEventText(e);
    if (runtime) return runtime.details;
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
    this.dupReasons.set({});
    this.panel.set('create');
    void this.loadRuntimeOptions();
  }

  /** گزینه‌های مدل از Manager (cache در سرور)؛ خطا فقط یعنی picker نیست و تسک با پیش‌فرض ساخته می‌شود. */
  private async loadRuntimeOptions(): Promise<void> {
    try { this.runtimeOptions.set(await firstValueFrom(this.api.runtimeOptions(this.repoId()))); }
    catch { this.runtimeOptions.set(null); }
  }

  currentDraft(): CreateTaskDraft | null { return this.createDrafts()[this.createIndex()] ?? null; }
  createActiveCount(): number { return this.createDrafts().filter(x => !x.skipped).length; }
  createStepLabel(): string { return `${this.createIndex() + 1} از ${this.createDrafts().length}`; }
  createFolderPreview(d: CreateTaskDraft): string { return `${d.source?.externalId || '<auto>'}-${d.slug || '<slug>'}`; }
  setExternalAccess(sourceId: string, access: 'read' | 'write'): void {
    this.updateDraft('externalAccess', sourceId.trim() ? [{ sourceId: sourceId.trim(), access }] : []);
  }
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
      // فقط ردیف‌های runtime ِ عوض‌شده (تفاوت با preset) به Manager می‌رود؛ اعتبارسنجی ِ نهایی با Manager است.
      const payload = items.map(item => ({ ...item, runtime: createRuntimePayload(this.runtimeOptions(), item.runtime) }));
      const response = await firstValueFrom(this.api.createTasks(payload, this.createStart));
      this.createResults.set(response.results);
      // پیش‌نویس‌هایی که ساخته شدند دوباره فرستاده نشوند (فرم برای اصلاح ِ بقیه باز می‌ماند).
      const done = new Set(items.filter((_, i) => response.results[i]?.ok));
      this.createDrafts.update(list => list.map(d => (done.has(d) ? { ...d, skipped: true } : d)));
      const failed = response.failed;
      this.info.set(failed ? `${response.succeeded} task ساخته شد؛ ${failed} مورد ناموفق بود.` : `${response.succeeded} task ساخته شد${this.createStart ? ' و وارد صف اجرا شد' : ''}.`);
      this.issueSelection.clear();
      this.issues.set(await firstValueFrom(this.api.issues(true)));
      await this.refresh(true);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  // --- نتیجه‌ی ساخت: import ِ تکراری (exit 44) و runtime ِ نامعتبر (exit 45) -------------------------------
  /** کلید ِ نتیجه برای یک پیش‌نویس: شناسه‌ی issue، یا manual-N (N = جایگاه بین پیش‌نویس‌های فعال). */
  draftKeyOf(d: CreateTaskDraft): string {
    if (d.source?.externalId != null) return String(d.source.externalId);
    return `manual-${this.createDrafts().filter(x => !x.skipped || x === d).indexOf(d) + 1}`;
  }
  private failureOf(d: CreateTaskDraft): StructuredFailure | null {
    return this.createResults().find(r => !r.ok && r.key === this.draftKeyOf(d))?.structured ?? null;
  }
  /** خطای Manager کنار همان ردیف ِ نقش (کلید = نام نقش). */
  runtimeErrorsFor(d: CreateTaskDraft): Record<string, string> {
    const failure = this.failureOf(d);
    const text = runtimeInvalidText(failure);
    return text?.role ? { [text.role]: text.text } : {};
  }
  presetErrorFor(d: CreateTaskDraft): string {
    const text = runtimeInvalidText(this.failureOf(d));
    return text && !text.role ? text.text : '';
  }
  dup(r: CreateTaskResult): Extract<StructuredFailure, { kind: 'duplicate' }> | null { return r.structured?.kind === 'duplicate' ? r.structured : null; }
  duplicateText = duplicateText;
  failText(r: CreateTaskResult): string { return runtimeInvalidText(r.structured)?.text ?? (r.message || 'ناموفق'); }
  attemptCell = attemptModelCell;
  setDupReason(key: string, value: string): void { this.dupReasons.update(m => ({ ...m, [key]: value })); }

  async openTaskById(id: string | null): Promise<void> {
    if (!id) return;
    const known = this.board()?.tasks.find(t => t.id === id);
    try { await this.openTask(known ?? await firstValueFrom(this.api.task(this.repoId(), id))); }
    catch (e) { this.fail(e); }
  }

  /** «ساخت تسک تکراری»: صریح، با reason ِ اجباری (--allow-duplicate --reason). */
  async createDuplicate(r: CreateTaskResult): Promise<void> {
    const reason = (this.dupReasons()[r.key] ?? '').trim();
    const draft = this.createDrafts().find(d => !d.skipped && this.draftKeyOf(d) === r.key);
    if (!draft || !reason) return;
    this.busy.set(true); this.error.set('');
    try {
      const payload = [{ ...draft, runtime: createRuntimePayload(this.runtimeOptions(), draft.runtime), allowDuplicate: { reason } }];
      const response = await firstValueFrom(this.api.createTasks(payload, this.createStart));
      const result = response.results[0];
      this.createResults.update(list => list.map(x => (x.key === r.key ? { ...result, key: r.key } : x)));
      if (result?.ok) this.createDrafts.update(list => list.map(d => (d === draft ? { ...d, skipped: true } : d)));
      await this.refresh(true);
    } catch (e) { this.fail(e); }
    finally { this.busy.set(false); }
  }

  /** بعد از تغییر ِ runtime: وضعیت و Timeline (رویداد runtime.changed) تازه شود. */
  async onRuntimeChanged(): Promise<void> {
    await this.refresh(true);
    const t = this.selected();
    if (!t) return;
    try { this.events.set(await firstValueFrom(this.api.events(this.repoId(), t.id))); } catch { /* Timeline اختیاری است */ }
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
        const useful = ['verification/summary.yaml', 'verification/build.log', 'verification/test.log', 'verification/lint.log'];
        paths.push(...useful.filter(x => latest.artifacts.includes(x)).map(x => `attempts/${latest.id}/${x}`));
      }
    } else if (t.awaitingHuman?.artifact) paths = [t.awaitingHuman.artifact];
    const values = await Promise.all(paths.map(async p => [p, await this.tryArtifact(t.id, p)] as const));
    this.actionArtifacts.set(Object.fromEntries(values.filter((entry): entry is readonly [string, string] => entry[1] !== null)));
  }
  async loadDiff(t: Task): Promise<void> {
    this.diffSelectedFile.set(null);
    // مسیر artifact خام diff همیشه از خود task می‌آید (t.diff.artifactPath) —
    // UI هرگز نباید حدس بزند کدام attempt آن را دارد (همان اشتباهی که با
    // نام ثابت changes.diff در ریشه‌ی task ساخته شده بود).
    const artifactPath = t.diff?.artifactPath;
    if (!artifactPath) {
      this.diffText.set('');
      this.diffHeadCommit.set(null);
      this.diffLoaded.set(true);
      return;
    }
    const value = await this.tryArtifact(t.id, artifactPath);
    this.diffText.set(value ?? '');
    this.diffHeadCommit.set(value === null ? null : (t.diff?.headCommit ?? null));
    this.diffLoaded.set(true);
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
    this.closeStream(); this.error.set(''); this.reason = ''; this.answerText = ''; this.respec = false; this.dangerOpen.set(null); this.dangerReason = ''; this.dangerForce = false; this.mergeAck.set(false); this.openedHeadCommit.set(undefined);
    this.checkinSourceId = ''; this.checkinChangesets = ''; this.noteText = ''; this.stageSourceId = '';
    this.releaseNoteEditing.set(false); this.releaseNoteHeadline = ''; this.releaseNoteBody = ''; this.releaseNoteNoNote = false; this.releaseNoteReason = '';
    this.events.set([]); this.logs.set([]); this.streamEnded.set(undefined); this.rootArtifactName.set(''); this.rootArtifact.set('');
    this.actionArtifacts.set({}); this.selectedAttempt.set(null); this.attemptArtifacts.set({});
    this.diffText.set(''); this.diffHeadCommit.set(null); this.diffSelectedFile.set(null); this.diffLoaded.set(false);
    this.taskTab.set('overview');
  }
  private slugify(value: string, fallback: string): string {
    const slug = String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_]+/g, '-').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return slug || fallback;
  }
  private compact(value: unknown): string { if (value == null) return '—'; if (typeof value === 'string') return value; try { return JSON.stringify(value); } catch { return String(value); } }
  private escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
  private inlineMarkdown(value: string): string { return value.replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>'); }
  private errorText(e: unknown): string {
    const candidate = e as { error?: { error?: string } | string; message?: string };
    const nested = typeof candidate?.error === 'object' ? candidate.error?.error : candidate?.error;
    return nested || candidate?.message || 'خطای ناشناخته';
  }
  private fail(e: unknown): void {
    this.error.set(this.errorText(e));
  }
}
