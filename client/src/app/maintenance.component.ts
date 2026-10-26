import { Component, OnDestroy, OnInit, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { DrainStatus, GitInventory, GitStatus, GitWorktree, ManagerInfoView } from './models';
import { LiveOutputComponent } from './live-output.component';

type GitAction = 'worktree-add' | 'prove' | 'merge' | 'worktree-remove' | 'branch-delete';
interface Confirm { title: string; command: string; run: () => Promise<{ execId: string }> }

const BRANCH_PATTERN = /^(fix|feat|chore)\/[a-z0-9-]+$/;

/**
 * نگهداری مخزن ابزار (git، بند د) و به‌روزرسانی Manager (الحاقیه‌ی ح).
 * فقط فرم‌های یک فهرست بسته؛ هر فرم قبل از اجرا فرمان نهایی را نشان می‌دهد.
 * پیش‌شرط‌ها (PROVEN، status خالی، بیکار بودن) را سرور می‌سنجد؛ UI فقط دکمه‌ای را
 * غیرفعال می‌کند که دلیلش از خود سرور آمده (powershell نیست، اثبات نیست).
 */
@Component({
  selector: 'ba-maintenance',
  standalone: true,
  imports: [FormsModule, LiveOutputComponent],
  template: `
    <section class="ops-page">
      <div class="section-head"><div><h2>نگهداری مخزن ابزار و Manager</h2><p>هیچ <code>--force</code>، <code>-D</code> یا <code>--no-verify</code> وجود ندارد؛ hookهای git همان‌طور که هستند اجرا می‌شوند.</p></div>
        <button class="secondary" (click)="reload()">↻ تازه‌سازی</button></div>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span><button (click)="error.set('')">×</button></div> }

      @if (confirm(); as c) {
        <div class="confirm-box">
          <b>{{ c.title }}</b>
          <small>فرمان نهایی:</small>
          <code class="final-command" dir="ltr">{{ c.command }}</code>
          <div class="danger-confirm-actions">
            <button class="secondary" (click)="confirm.set(null)">انصراف</button>
            <button class="primary" [disabled]="busy()" (click)="runConfirmed(c)">تأیید نهایی</button>
          </div>
        </div>
      }

      <div class="detail-section drain-panel">
        <div class="section-head"><div><h3>تخلیه (drain) — پیش از به‌روزرسانی ِ کانبان یا sync</h3>
          <p>با تخلیه روشن، run ِ تازه (دستی و خودکار) شروع نمی‌شود و در صف می‌ماند؛ run های در جریان تا پایان/نقطه‌ی انتظار ادامه می‌دهند. حالت در <code>dataDir</code> ذخیره می‌شود و بعد از restart هم می‌ماند.</p></div></div>
        @if (drain(); as d) {
          <div class="facts">
            <div><small>حالت</small><b>{{ d.draining ? 'روشن — run ِ تازه شروع نمی‌شود' : 'خاموش (عادی)' }}</b></div>
            <div><small>run ِ زنده</small><b>{{ d.live.length }}</b></div>
            <div><small>در صف</small><b>{{ d.queued.length }}</b></div>
          </div>
          @if (d.live.length) {
            <table class="drain-table"><thead><tr><th>تسک</th><th>state</th><th>مدت</th></tr></thead><tbody>
              @for (x of d.live; track x.taskId) { <tr><td dir="ltr">#{{ x.taskId }}</td><td dir="ltr">{{ x.state || '—' }}</td><td>{{ x.durationText }}</td></tr> }
            </tbody></table>
          } @else if (d.draining) { <div class="drain-empty">✅ خالی — هیچ run ِ زنده‌ای نیست؛ می‌توانی sync / به‌روزرسانی کنی.</div> }
          @if (d.queued.length) { <small class="sync-note">در صف{{ d.draining ? ' (نگه‌داشته‌شده)' : '' }}: {{ queuedText(d) }}</small> }
        }
        <div class="danger-actions">
          @if (drain()?.draining) {
            <button class="primary" [disabled]="busy()" (click)="setDrain(false)">خاموش کردن تخلیه و شروع ِ صف</button>
          } @else {
            <button class="secondary" [disabled]="busy()" (click)="setDrain(true)">روشن کردن تخلیه</button>
          }
          <button class="secondary" [disabled]="busy()" (click)="refreshDrain()">↻ وضعیت</button>
        </div>
        <small class="sync-note">routine ِ به‌روزرسانی: تخلیه ← صبر تا «خالی» ← stop سرویس ← pull/build/start (یا sync) ← خاموش کردن تخلیه. جزئیات: docs/server-service.md</small>
      </div>

      <div class="detail-section">
        <div class="section-head"><div><h3>همگام‌سازی Manager با origin (sync)</h3>
          <p>منطقش در خود Manager است: ff / push / merge ِ واقعی (هرگز rebase) و <code>npm ci</code> فقط با تغییر package-lock. با اجرا خاموش هم کار می‌کند.</p></div></div>
        @if (managerInfo(); as m) {
          <div class="facts sync-facts">
            <div><small>commit فعلی</small><b dir="ltr">{{ m.head ? m.head.slice(0, 10) : '—' }}</b></div>
            <div><small>شاخه ← upstream</small><b dir="ltr">{{ m.branch || '—' }} ← {{ m.upstream || '—' }}</b></div>
            <div><small>جلوتر / عقب‌تر از origin</small><b dir="ltr">{{ m.ahead ?? '—' }} / {{ m.behind ?? '—' }}</b></div>
            <div><small>آخرین fetch</small><b dir="ltr">{{ m.lastFetchAt ? m.lastFetchAt.slice(0, 19).replace('T', ' ') : 'هنوز نشده' }}</b></div>
          </div>
          <small class="sync-note">این اعداد از <code>repository.sync</code> ِ status --json ِ Manager و از آخرین fetch‌اند؛ برای تازه شدن «پیش‌نمایش» را بزن.</small>
          @if (m.remoteError) { <div class="disabled-gate-warning">{{ m.remoteError }}</div> }
        }
        <div class="danger-actions">
          <button class="secondary" [disabled]="busy() || syncRunning()" (click)="askPreview()">پیش‌نمایش (sync --dry-run)</button>
          <button class="primary" [disabled]="busy() || syncRunning()" (click)="askUpdate()">همگام‌سازی با origin (sync)</button>
        </div>
        @if (syncHint(); as hint) {
          <div class="disabled-gate-warning">{{ hint }}
            @if (!drain()?.draining) { <button class="primary" [disabled]="busy()" (click)="setDrain(true)">روشن کردن تخلیه</button> }
          </div>
        }
        <small class="sync-note">⏱ <code>npm ci</code> تا ۲۰ دقیقه و hook ِ <code>pre-push</code> ِ سنگین (<code>ng lint</code> و <code>ng build</code>) روی push ِ main تا ۳۰ دقیقه طول می‌کشد؛ خروجی زنده‌ی فرمان پایین صفحه نمایش داده می‌شود. بستن این صفحه اجرا را قطع نمی‌کند.</small>
      </div>

      <div class="detail-section">
        <div class="section-head"><div><h3>وضعیت git</h3></div></div>
        @if (gitStatus(); as s) {
          <div class="git-status">
            <div><small>git status --short</small><pre class="logs">{{ s.status || '(تمیز)' }}</pre></div>
            <div><small>git worktree list</small><pre class="logs">{{ s.worktrees }}</pre></div>
            <div><small>git log --oneline -5</small><pre class="logs">{{ s.log }}</pre></div>
          </div>
        }
      </div>

      <div class="detail-section">
        <div class="section-head"><div><h3>ساخت worktree برای کدر ابزار</h3>
          <p>@if (inventory(); as i) { زیر <code dir="ltr">{{ i.worktreesDir || 'tooling.worktreesDir تعریف نشده' }}</code> }</p></div></div>
        <form class="inline-form" (ngSubmit)="askAdd()">
          <label><span>شاخه</span><input name="branch" dir="ltr" [(ngModel)]="newBranch" placeholder="fix/some-thing"></label>
          <label><span>نام پوشه (اختیاری)</span><input name="dir" dir="ltr" [(ngModel)]="newDir" placeholder="fix-some-thing"></label>
          <button class="primary" type="submit" [disabled]="busy() || !branchValid(newBranch) || !inventory()?.worktreesDir">ساخت</button>
        </form>
        @if (newBranch && !branchValid(newBranch)) { <small class="bad">الگو: fix/… ، feat/… یا chore/… با حروف کوچک، عدد و خط‌تیره.</small> }
      </div>

      <div class="detail-section">
        <div class="section-head"><div><h3>worktreeها</h3>
          <p>@if (inventory(); as i) { آزمون جداسازی با: <code dir="ltr">{{ i.powershell || '— (pwsh/powershell پیدا نشد)' }}</code> }</p></div></div>
        @if (inventory(); as i) {
          @if (!i.powershell) { <div class="disabled-gate-warning">pwsh یا powershell روی این سیستم پیدا نشد؛ «آزمون جداسازی» و در نتیجه «ادغام» غیرفعال است.</div> }
          <table class="wt-table">
            <thead><tr><th>پوشه</th><th>شاخه</th><th>اثبات</th><th></th></tr></thead>
            <tbody>
              @for (w of i.worktrees; track w.path) {
                <tr>
                  <td dir="ltr"><code>{{ w.path }}</code></td>
                  <td dir="ltr">{{ w.branch || '—' }}</td>
                  <td>@if (w.proof) { <span class="badge" [class.ok]="w.proof.proven" [class.bad]="!w.proof.proven">{{ w.proof.proven ? 'PROVEN' : 'NOT PROVEN' }}</span> <small dir="ltr">{{ w.proof.commit.slice(0, 8) }}</small> } @else { — }</td>
                  <td class="wt-actions">
                    @if (w.managed && w.branch) {
                      <button class="secondary" [disabled]="busy() || !i.powershell" [title]="i.powershell ? '' : 'pwsh/powershell پیدا نشد'" (click)="askProve(w)">آزمون جداسازی</button>
                      <button class="secondary" [disabled]="busy() || !w.proof?.proven" [title]="w.proof?.proven ? '' : 'اول آزمون جداسازی باید PROVEN شود'" (click)="askMerge(w.branch)">ادغام</button>
                      <button class="danger-outline" [disabled]="busy()" (click)="askRemove(w)">حذف worktree</button>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
        <form class="inline-form" (ngSubmit)="askMerge(manualBranch)">
          <label><span>شاخه‌ی دستی</span><input name="manual" dir="ltr" [(ngModel)]="manualBranch" placeholder="fix/some-thing"></label>
          <button class="secondary" type="submit" [disabled]="busy() || !branchValid(manualBranch)">ادغام</button>
          <button class="danger-outline" type="button" [disabled]="busy() || !branchValid(manualBranch)" (click)="askDeleteBranch(manualBranch)">حذف شاخه (-d)</button>
        </form>
      </div>

      @if (streamUrl()) {
        <div class="detail-section">
          <div class="section-head"><div><h3>خروجی زنده</h3></div></div>
          <ba-live-output [url]="streamUrl()" (ended)="onEnded()" />
        </div>
      }
    </section>
  `
})
export class MaintenanceComponent implements OnInit, OnDestroy {
  readonly api = inject(ApiService);
  readonly repoId = input.required<string>();
  readonly gitStatus = signal<GitStatus | null>(null);
  readonly inventory = signal<GitInventory | null>(null);
  readonly managerInfo = signal<ManagerInfoView | null>(null);
  readonly confirm = signal<Confirm | null>(null);
  readonly busy = signal(false);
  /** تا پایان خروجی زنده‌ی sync (ممکن است دقایق طول بکشد) دکمه‌های sync غیرفعال می‌مانند. */
  readonly syncRunning = signal(false);
  readonly error = signal('');
  readonly drain = signal<DrainStatus | null>(null);
  /** وقتی run ِ زنده هست و کاربر sync را زد: به‌جای رد شدن ِ بی‌توضیح، تخلیه را پیشنهاد می‌دهیم. */
  readonly syncHint = signal('');
  private drainTimer?: number;
  readonly streamUrl = signal<string | null>(null);
  newBranch = '';
  newDir = '';
  manualBranch = '';

  async ngOnInit(): Promise<void> {
    await this.reload();
    this.drainTimer = window.setInterval(() => void this.refreshDrain(), 5000);
  }

  ngOnDestroy(): void { if (this.drainTimer) window.clearInterval(this.drainTimer); }

  queuedText(d: DrainStatus): string { return d.queued.map(x => '#' + x.taskId).join('، '); }

  async refreshDrain(): Promise<void> {
    try {
      this.drain.set(await firstValueFrom(this.api.drain()));
      if (this.syncHint() && (this.drain()?.live.length ?? 0) === 0) this.syncHint.set('');
    } catch (e) { this.error.set(this.message(e)); }
  }

  async setDrain(on: boolean): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try { this.drain.set(await firstValueFrom(on ? this.api.drainOn() : this.api.drainOff())); }
    catch (e) { this.error.set(this.message(e)); }
    finally { this.busy.set(false); }
  }

  branchValid(value: string): boolean { return BRANCH_PATTERN.test(value || ''); }

  private message(e: unknown): string { return e instanceof HttpErrorResponse ? (e.error?.error ?? e.message) : String(e); }

  async reload(): Promise<void> {
    const repo = this.repoId();
    const [status, inventory, info] = await Promise.allSettled([
      firstValueFrom(this.api.gitStatus(repo)), firstValueFrom(this.api.gitInventory(repo)), firstValueFrom(this.api.managerInfo(repo))
    ]);
    if (status.status === 'fulfilled') this.gitStatus.set(status.value); else this.error.set(this.message(status.reason));
    if (inventory.status === 'fulfilled') this.inventory.set(inventory.value); else this.error.set(this.message(inventory.reason));
    if (info.status === 'fulfilled') this.managerInfo.set(info.value);
    await this.refreshDrain();
  }

  ask(c: Confirm): void { this.error.set(''); this.confirm.set(c); }

  private git(name: GitAction, body: Record<string, string>): Confirm['run'] { return () => firstValueFrom(this.api.gitAction(this.repoId(), name, body)); }

  askPreview(): void {
    this.ask({
      title: 'پیش‌نمایش sync (چیزی تغییر نمی‌کند)', command: 'node scripts/manager.js sync --dry-run --json',
      run: () => this.sync(this.api.managerSyncPreview(this.repoId()))
    });
  }

  async askUpdate(): Promise<void> {
    // run ِ زنده sync را رد می‌کند (سرور هم می‌سنجد)؛ اینجا پیش از رد شدن راهِ درست را نشان می‌دهیم.
    await this.refreshDrain();
    const live = this.drain()?.live ?? [];
    if (live.length) {
      const who = live.map(x => '#' + x.taskId).join('، ');
      this.syncHint.set(this.drain()?.draining
        ? `تخلیه روشن است ولی هنوز ${live.length} run ِ زنده هست (${who}). صبر کن تا «خالی» شود، بعد دوباره sync را بزن.`
        : `${live.length} run ِ زنده هست (${who}) و sync رد می‌شود. اول تخلیه را روشن کن، صبر کن تا خالی شود، بعد sync کن و آخرش تخلیه را خاموش کن.`);
      return;
    }
    this.syncHint.set('');
    this.ask({
      title: 'همگام‌سازی Manager با origin',
      command: 'node scripts/manager.js sync --json  →  (بعد از موفقیت) manager.js --help و capabilities دوباره خوانده می‌شود',
      run: () => this.sync(this.api.managerUpdate(this.repoId()))
    });
  }

  private async sync(request: ReturnType<ApiService['managerUpdate']>): Promise<{ execId: string }> {
    const started = await firstValueFrom(request);
    this.syncRunning.set(true);
    return started;
  }

  askAdd(): void {
    if (!this.branchValid(this.newBranch)) return;
    const dir = this.newDir.trim();
    this.ask({
      title: 'ساخت worktree', command: `git worktree add <worktreesDir>/${dir || this.newBranch.replace('/', '-')} -b ${this.newBranch} main`,
      run: this.git('worktree-add', dir ? { branch: this.newBranch, dir } : { branch: this.newBranch })
    });
  }

  askProve(w: GitWorktree): void {
    const name = w.path.split(/[\\/]/).pop() || '';
    this.ask({ title: 'آزمون جداسازی', command: `powershell -File prove-isolation.ps1 -Fix ${w.path}`, run: this.git('prove', { dir: name }) });
  }

  askMerge(branch: string | null): void {
    if (!branch || !this.branchValid(branch)) return;
    this.ask({ title: `ادغام ${branch} در main`, command: `git merge --no-ff --no-edit ${branch}`, run: this.git('merge', { branch }) });
  }

  askRemove(w: GitWorktree): void {
    const name = w.path.split(/[\\/]/).pop() || '';
    this.ask({ title: 'حذف worktree', command: `git worktree remove ${w.path}`, run: this.git('worktree-remove', { dir: name }) });
  }

  askDeleteBranch(branch: string): void {
    this.ask({ title: `حذف شاخه ${branch}`, command: `git branch -d ${branch}`, run: this.git('branch-delete', { branch }) });
  }

  async runConfirmed(c: Confirm): Promise<void> {
    this.busy.set(true);
    try {
      const { execId } = await c.run();
      this.confirm.set(null);
      this.streamUrl.set(this.api.execStreamUrl(execId));
    } catch (e) {
      this.confirm.set(null);
      this.error.set(this.message(e));
    } finally { this.busy.set(false); }
  }

  onEnded(): void {
    this.syncRunning.set(false);
    setTimeout(() => void this.reload(), 800);
  }
}
