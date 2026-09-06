import fs from 'node:fs';
import path from 'node:path';

function splitInline(value) {
  const parts = [];
  let quote = null; let depth = 0; let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) { if (ch === quote && value[i - 1] !== '\\') quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) { parts.push(value.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function scalar(value) {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) return splitInline(v.slice(1, -1)).map(scalar);
  if (v.startsWith('{') && v.endsWith('}')) {
    const result = {};
    for (const item of splitInline(v.slice(1, -1))) {
      const index = item.indexOf(':');
      if (index < 1) throw new Error(`inline map نامعتبر: ${v}`);
      const key = item.slice(0, index).trim().replace(/^['"]|['"]$/g, '');
      result[key] = scalar(item.slice(index + 1));
    }
    return result;
  }
  return v;
}

// Parser کوچک و محدود برای ساختار config خود برنامه؛ فایل دادهٔ عمومی YAML نیست.
export function parseConfigYaml(text) {
  const out = {}; const stack = [{ indent: -1, value: out }];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.match(/^ */)[0].length; const line = raw.trim();
    while (stack.at(-1).indent >= indent) stack.pop();
    const parent = stack.at(-1).value;
    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) throw new Error(`آرایهٔ نامعتبر در خط ${i + 1}`);
      const pair = line.slice(2).match(/^([^:]+):\s*(.*)$/); if (!pair) { parent.push(scalar(line.slice(2))); continue; }
      const obj = {}; obj[pair[1].trim()] = scalar(pair[2]); parent.push(obj); stack.push({ indent, value: obj }); continue;
    }
    const pair = line.match(/^([^:]+):\s*(.*)$/); if (!pair) throw new Error(`کانفیگ نامعتبر در خط ${i + 1}`);
    const key = pair[1].trim(); const value = pair[2];
    if (value) { parent[key] = scalar(value); continue; }
    const next = lines.slice(i + 1).find(x => x.trim() && !x.trimStart().startsWith('#'));
    parent[key] = next?.trimStart().startsWith('- ') ? [] : {};
    stack.push({ indent, value: parent[key] });
  }
  return out;
}

export function loadConfig(file = process.env.BARSA_AGENT_CONFIG || path.resolve('barsa-agent.config.yml')) {
  const config = parseConfigYaml(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(config.repos) || !config.repos.length) throw new Error('حداقل یک repo در کانفیگ لازم است.');
  for (const repo of config.repos) {
    repo.path = path.resolve(repo.path); repo.managerScript = repo.managerScript || 'scripts/manager.js';
    if (!/^[a-z0-9][a-z0-9-]*$/i.test(repo.id)) throw new Error(`شناسهٔ repo نامعتبر است: ${repo.id}`);
  }
  return config;
}
