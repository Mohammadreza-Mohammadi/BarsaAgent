// پیوست ِ فایل (TOOLING-050 د). endpointها (فقط نشست ِ مرورگر؛ توکن ِ remote به هیچ‌کدام راه ندارد، پس آپلود از گوشی نیست):
//   GET    /api/attachments/policy                                 فهرست ِ مجاز ِ Manager + سقف‌های سرور
//   POST   /api/uploads?name=<نام>&repo=<id>                       آپلود ِ موقت (بدنه‌ی خام، سقف در جریان)
//   DELETE /api/uploads/:id                                        حذف ِ آپلود ِ مصرف‌نشده
//   POST   /api/repos/:repo/tasks/:id/attach   { uploads: [id…] }   به تسک ِ موجود (manager.js attach)
//   GET    /api/repos/:repo/tasks/:id/attachments/:attId/file       پیش‌نمایش (تصویر) / دانلود؛ فقط داخل attachments.root/<taskId>/
//
// کانبان هیچ‌وقت در attachments.root نمی‌نویسد: فایل ِ موقت را به Manager می‌دهد (`attach --file`)، بعد پاکش می‌کند. خواندن (پیش‌نمایش /
// دانلود) فقط از مسیری است که Manager در status داده و بعد از realpath باید زیر `root/<taskId>/` باشد.
import fs from 'node:fs';
import path from 'node:path';
import { checkUpload, policyView } from './attachment-policy.js';
import { safeUploadName } from './uploads.js';

const MB = 1024 * 1024;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ATT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// دلیل ِ ثابت و ASCII: متن آزاد هرگز argv نمی‌شود (قاعده‌ی کانبان)؛ `attach` فقط `--reason` ِ inline دارد.
export const ATTACH_REASON = 'added from Kanban console';
// فقط تصویر inline نشان داده می‌شود؛ بقیه دانلود. نوع از پسوند ِ مجاز (نه از ادعای فایل).
const INLINE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' };
const bad = (message, status = 400) => Object.assign(new Error(message), { status });

/** سقف‌های سرور از config.attachments (پیش‌فرض: ۲۰۰MB برای هر فایل، ۲۰ فایل در هر درخواست). */
export function limitsOf(config) {
  const block = config.attachments ?? {};
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
  return { maxUploadBytes: positive(block.maxUploadBytes) ? Number(block.maxUploadBytes) : 200 * MB, maxFiles: positive(block.maxFiles) ? Number(block.maxFiles) : 20 };
}

export function createAttachmentRoutes(ctx) {
  const { config, repoFor, send, route, collectJson, collectAction, assertExecution, audit, uploads, readPolicy } = ctx;
  const limits = limitsOf(config);
  const { resolveUploads } = attachmentHelpers(ctx);
  const defaultRepo = () => config.repos[0];
  const repoOf = url => repoFor(url.searchParams.get('repo') || defaultRepo().id);

  async function attach(session, repo, id, input) {
    if (session.remote) throw bad('پیوست از راه دور مجاز نیست.', 403);
    if (!TASK_ID.test(String(id))) throw bad('شناسه‌ی تسک نامعتبر است.');
    const files = resolveUploads(session, input?.uploads);
    if (!files.length) throw bad('حداقل یک فایل ِ آپلودشده لازم است.');
    try {
      await assertExecution(repo);
      const added = [];
      const failed = [];
      for (const file of files) {
        try {
          await collectAction(session, repo, ['attach', String(id), '--file', file.file, '--name', file.name, '--reason', ATTACH_REASON], { action: 'attach', taskId: String(id) });
          added.push(file.name);
        } catch (error) {
          // ردِ Manager (پسوند/اندازه/محتوای اجرایی/…): متن ِ خودش، با نام ِ فایل؛ بقیه‌ی فایل‌ها ادامه می‌یابند.
          failed.push({ name: file.name, error: String(error?.message ?? error).trim().slice(0, 600) });
          if (failed.length === 1 && added.length === 0 && files.length === 1) throw error;
        }
      }
      return { ok: failed.length === 0, added, failed };
    } finally {
      uploads.discardMany(files.map(file => file.id));
    }
  }

  async function readFile(res, req, repo, id, attId, download) {
    if (!TASK_ID.test(String(id)) || !ATT_ID.test(String(attId))) throw bad('شناسه نامعتبر است.');
    const board = await collectJson(repo, ['status', '--json', '--task', String(id)]);
    const task = board.tasks?.[0];
    if (!task || task.error) throw bad('task پیدا نشد.', 404);
    const item = task.attachments?.items?.find(entry => entry.id === attId);
    if (!item) throw bad('پیوست پیدا نشد.', 404);
    const root = task.attachments?.root;
    if (!root || !item.path || item.exists !== true) throw bad('فایل ِ پیوست روی دیسک نیست (پشتیبان را برگردان).', 404);
    // فقط زیر <root>/<taskId>/ (بعد از realpath: لینک ِ نمادین هم نباید بیرون ببرد)
    const base = path.resolve(root, String(task.id));
    let real;
    try { real = fs.realpathSync(path.resolve(item.path)); } catch { throw bad('فایل ِ پیوست روی دیسک نیست.', 404); }
    let realBase;
    try { realBase = fs.realpathSync(base); } catch { throw bad('پوشه‌ی پیوست‌های تسک پیدا نشد.', 404); }
    const inside = real === realBase || real.toLowerCase().startsWith(`${realBase.toLowerCase()}${path.sep}`);
    if (!inside) throw bad('مسیر ِ پیوست بیرون از پوشه‌ی پیوست‌های تسک است؛ رد شد.', 403);
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw bad('پیوست فایل ِ معمولی نیست.', 404);
    const ext = path.extname(String(item.file || item.name || '')).toLowerCase();
    const inlineType = !download && item.kind === 'image' ? INLINE_TYPES[ext] : null;
    const filename = safeUploadName(item.name || item.file);
    res.writeHead(200, {
      'Content-Type': inlineType ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': `${inlineType ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(real).on('error', () => res.destroy()).pipe(res);
  }

  return async function handle(req, res, url, pathname, session) {
    let p;
    if (req.method === 'GET' && pathname === '/api/attachments/policy') {
      return send(res, 200, policyView(await readPolicy(repoOf(url)), limits)), true;
    }
    if (req.method === 'POST' && pathname === '/api/uploads') {
      if (session.remote) throw bad('آپلود از راه دور مجاز نیست.', 403);
      const repo = repoOf(url);
      const name = String(url.searchParams.get('name') ?? '');
      if (!name.trim()) throw bad('نام ِ فایل لازم است (?name=).');
      const info = await readPolicy(repo);
      const declared = Number(req.headers['content-length']);
      const checked = checkUpload({ name: safeUploadName(name), size: Number.isFinite(declared) ? declared : 0 }, info, limits);
      if (!checked.ok) { res.setHeader('Connection', 'close'); throw bad(checked.message, checked.message.includes('اندازه') ? 413 : 400); }
      try {
        const meta = await uploads.receive(req, { user: session.user, name, maxBytes: checked.cap });
        audit.note({ user: session.user, action: 'upload.staged', repoId: repo.id, file: meta.name, bytes: meta.size });
        return send(res, 201, { ...meta, kind: checked.kind }), true;
      } catch (error) {
        res.setHeader('Connection', 'close');
        throw error;
      }
    }
    if (req.method === 'DELETE' && (p = route('/api/uploads/:id', pathname))) {
      uploads.take(p.id, session.user);
      uploads.discard(p.id);
      return send(res, 200, { ok: true }), true;
    }
    if (req.method === 'POST' && (p = route('/api/repos/:repo/tasks/:id/attach', pathname))) {
      const body = await ctx.readBody(req);
      const result = await attach(session, repoFor(p.repo), p.id, body);
      return send(res, result.ok ? 200 : 207, result), true;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (p = route('/api/repos/:repo/tasks/:id/attachments/:attId/file', pathname))) {
      await readFile(res, req, repoFor(p.repo), p.id, p.attId, url.searchParams.get('download') === '1');
      return true;
    }
    return false;
  };
}

/** شناسه‌های آپلود ← [{ id, name, size, file }] برای همین کاربر (سقف ِ تعداد، بدون تکرار)، و `--attach <path>` تکرارشونده برای import-issue / answer --note / --clarify. */
export function attachmentHelpers(ctx) {
  const { maxFiles } = limitsOf(ctx.config);
  return {
    resolveUploads(session, ids) {
      if (ids === undefined || ids === null) return [];
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw bad('فهرست ِ آپلودها نامعتبر است.');
      const unique = [...new Set(ids)];
      if (unique.length > maxFiles) throw bad(`حداکثر ${maxFiles} پیوست در یک درخواست.`);
      return unique.map(id => ctx.uploads.take(id, session.user));
    },
    attachArgs: files => files.flatMap(file => ['--attach', file.file])
  };
}
