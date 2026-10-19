import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { tap } from 'rxjs/operators';

interface SessionInfo { authenticated: boolean; user?: string; csrf?: string }

/**
 * کانبان فاز ۱: ورود اجباری. نشست در کوکی HttpOnly است (JS آن را نمی‌بیند)؛
 * فقط توکن CSRF در حافظه می‌ماند و روی هر درخواست تغییردهنده می‌رود.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  readonly ready = signal(false);
  readonly user = signal<string | null>(null);
  csrf: string | null = null;

  async init(): Promise<void> {
    try {
      this.apply(await firstValueFrom(this.http.get<SessionInfo>('/api/auth/session')));
    } catch {
      this.apply({ authenticated: false });
    } finally {
      this.ready.set(true);
    }
  }

  async login(username: string, password: string): Promise<void> {
    this.apply(await firstValueFrom(this.http.post<SessionInfo>('/api/auth/login', { username, password })));
  }

  async logout(): Promise<void> {
    try { await firstValueFrom(this.http.post('/api/auth/logout', {})); } catch { /* نشست از قبل منقضی است */ }
    this.apply({ authenticated: false });
  }

  /** از interceptor: سرور 401 داد = نشست تمام شده. */
  expired(): void {
    this.apply({ authenticated: false });
  }

  private apply(info: SessionInfo): void {
    this.user.set(info.authenticated ? info.user ?? null : null);
    this.csrf = info.authenticated ? info.csrf ?? null : null;
  }
}

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  const request = mutating && auth.csrf ? req.clone({ setHeaders: { 'X-CSRF-Token': auth.csrf } }) : req;
  return next(request).pipe(
    tap({
      error: error => {
        if (error instanceof HttpErrorResponse && error.status === 401 && !req.url.startsWith('/api/auth/')) auth.expired();
      }
    })
  );
};
