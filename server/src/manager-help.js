import { collect } from './cli.js';
import { parseHelpSubcommands } from './console-parser.js';

/**
 * فهرست زیرفرمان‌های مجاز هر repo، خوانده‌شده از `manager.js --help`.
 * فقط موفقیت cache می‌شود؛ اگر Manager در لحظه‌ای جواب نداد، دفعه‌ی بعد دوباره
 * امتحان می‌شود و تا آن موقع فهرست خالی است (کنسول همه‌چیز را رد می‌کند —
 * بسته‌بودن پیش‌فرض است، نه باز).
 */
export class ManagerHelp {
  #cache = new Map();

  constructor({ read = repo => collect(repo, ['--help']) } = {}) {
    this.read = read;
  }

  async refresh(repo) {
    try {
      const { stdout } = await this.read(repo);
      const value = { subcommands: parseHelpSubcommands(stdout), raw: stdout, at: new Date().toISOString(), error: null };
      if (!value.subcommands.length) {
        return { subcommands: [], raw: stdout, at: value.at, error: 'خروجی manager.js --help زیرفرمانی نداشت.' };
      }
      this.#cache.set(repo.id, value);
      return value;
    } catch (error) {
      this.#cache.delete(repo.id);
      return { subcommands: [], raw: '', at: new Date().toISOString(), error: error.message };
    }
  }

  async get(repo) {
    return this.#cache.get(repo.id) || this.refresh(repo);
  }

  invalidate(repo) { this.#cache.delete(repo.id); }
}
