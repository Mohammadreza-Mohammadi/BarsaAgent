// حالت «تخلیه» (drain): run ِ تازه شروع نمی‌شود (نه دستی، نه خودکار)، run های در جریان ادامه می‌دهند، و تسک‌هایی که
// می‌خواستند شروع شوند در صف می‌مانند. برای به‌روزرسانی ِ کانبان/Manager: drain ← صبر تا خالی ← به‌روزرسانی ← drain off.
//
// حالت (و صف ِ نگه‌داشته‌شده) در `<dataDir>/drain.json` ذخیره می‌شود و **بعد از restart هم می‌ماند**: وسط ِ به‌روزرسانی
// سرویس بالا و پایین می‌شود و تسک ِ صف‌شده نباید پیش از تمام شدن ِ کار راه بیفتد (و صف ِ حافظه هم گم نشود).
import fs from 'node:fs';
import path from 'node:path';

export class DrainStore {
  constructor(dataDir) {
    this.file = path.join(path.resolve(dataDir), 'drain.json');
  }

  /** @returns {{ draining: boolean, since: string|null, by: string|null, queued: Array }} فایل ِ نبود/خراب = تخلیه نیست. */
  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value?.draining !== true) return { draining: false, since: null, by: null, queued: [] };
      const queued = Array.isArray(value.queued)
        ? value.queued.filter(item => item && typeof item.repoId === 'string' && typeof item.taskId === 'string')
        : [];
      return { draining: true, since: value.since ?? null, by: value.by ?? null, queued };
    } catch {
      return { draining: false, since: null, by: null, queued: [] };
    }
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** خاموش: فایل پاک می‌شود (حالت ِ پیش‌فرض). */
  clear() {
    fs.rmSync(this.file, { force: true });
  }
}

/** یک خط ِ مدت ِ اجرا (برای status/لاگ): «۵ دقیقه»، «۱ ساعت و ۲ دقیقه». */
export function durationText(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} ثانیه`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} دقیقه`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ساعت${minutes % 60 ? ` و ${minutes % 60} دقیقه` : ''}`;
}
