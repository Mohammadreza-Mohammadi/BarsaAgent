// یک نویسنده‌ی ZIP کوچک (deflate، نام UTF-8) تا کانبان برای دانلود پوشه‌ی task به
// هیچ برنامه‌ی بیرونی (tar/Compress-Archive) و هیچ وابستگی تازه‌ای نیاز نداشته باشد.
// فقط فایل‌های معمولی: symlink دنبال نمی‌شود و نادیده گرفته می‌شود.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const ZIP_LIMITS = { maxFiles: 20_000, maxTotalBytes: 512 * 1024 * 1024 };

export function listFiles(root, limits = ZIP_LIMITS) {
  const out = [];
  let total = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      const size = fs.statSync(full).size;
      total += size;
      if (out.length + 1 > limits.maxFiles || total > limits.maxTotalBytes) {
        throw Object.assign(new Error('پوشه‌ی task برای zip شدن بیش از حد بزرگ است.'), { status: 413 });
      }
      out.push({ full, name: path.relative(root, full).split(path.sep).join('/'), size });
    }
  };
  walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function buildZip(root, limits = ZIP_LIMITS) {
  const files = listFiles(root, limits);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const data = fs.readFileSync(file.full);
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(file.name, 'utf8');
    const crc = zlib.crc32(data);
    const { time, day } = dosDateTime(fs.statSync(file.full).mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(useDeflate ? 8 : 0, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return { buffer: Buffer.concat([...chunks, centralBuf, end]), fileCount: files.length };
}
