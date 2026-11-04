import { Injectable, OnDestroy } from '@angular/core';
import { PollTask, Scheduler, browserEnv } from './scheduler';

/** زمان‌بند ِ مرکزی ِ برنامه (یک timer). component ها با `add` ثبت می‌کنند و در ngOnDestroy تابع ِ برگشتی را صدا می‌زنند. */
@Injectable({ providedIn: 'root' })
export class PollerService implements OnDestroy {
  private readonly scheduler = new Scheduler(browserEnv());
  add(task: PollTask): () => void { return this.scheduler.add(task); }
  ngOnDestroy(): void { this.scheduler.dispose(); }
}
