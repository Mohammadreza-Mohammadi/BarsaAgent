import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { AuthService } from './auth.service';

@Component({
  selector: 'ba-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <form class="login-card" (ngSubmit)="submit()">
      <div class="brand login-brand"><span class="mark">B</span><div><strong>BarsaAgent</strong><small>ورود لازم است</small></div></div>
      <label><span>نام کاربری</span><input name="username" autocomplete="username" [(ngModel)]="username" required autofocus></label>
      <label><span>گذرواژه</span><input name="password" type="password" autocomplete="current-password" [(ngModel)]="password" required></label>
      @if (error()) { <div class="notice error"><span>{{ error() }}</span></div> }
      <button class="primary" type="submit" [disabled]="busy() || !username || !password">{{ busy() ? 'در حال ورود…' : 'ورود' }}</button>
      <small class="login-note">این کنسول فرمان اجرا می‌کند؛ هر اکشن با نام تو در دفتر ممیزی ثبت می‌شود.</small>
    </form>
  `
})
export class LoginComponent {
  private readonly auth = inject(AuthService);
  username = '';
  password = '';
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set('');
    try {
      await this.auth.login(this.username, this.password);
      this.password = '';
    } catch (e) {
      this.error.set(e instanceof HttpErrorResponse ? (e.error?.error ?? 'ورود ناموفق بود.') : 'ورود ناموفق بود.');
    } finally {
      this.busy.set(false);
    }
  }
}
