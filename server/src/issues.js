import { URL } from 'node:url';

const LOG_PREFIX = '[BarsaAgent][Issues]';
function log(...args) { console.log(LOG_PREFIX, ...args); }
function logError(...args) { console.error(LOG_PREFIX, ...args); }

export function getPath(value, dotted) {
  if (!dotted) return value;
  return dotted.split('.').reduce((v, key) => v == null ? undefined : v[key], value);
}

function getMappedValue(raw, mappingPath, fallbackField) {
  const mapped = mappingPath ? getPath(raw, mappingPath) : undefined;
  return mapped !== undefined && mapped !== null ? mapped : raw?.[fallbackField];
}

export function normalizeIssues(payload, source) {
  const items = getPath(payload, source.itemsPath || '') ?? payload;
  if (!Array.isArray(items)) {
    const actualType = items === null ? 'null' : Array.isArray(items) ? 'array' : typeof items;
    throw new Error(`مسیر itemsPath به آرایه منتهی نمی‌شود. itemsPath=${source.itemsPath || '<root>'}, actualType=${actualType}`);
  }
  const m = source.mapping || {};
  const normalized = items.map(raw => {
    const labels = getMappedValue(raw, m.labels, 'labels');
    const externalId = getMappedValue(raw, m.externalId, 'externalId');
    const title = getMappedValue(raw, m.title, 'title');
    const body = getMappedValue(raw, m.body, 'body');
    const url = getMappedValue(raw, m.url, 'url');
    const status = getMappedValue(raw, m.status, 'status');
    return {
      externalId: externalId == null ? '' : String(externalId),
      title: title == null ? '' : String(title),
      body: body == null ? '' : String(body),
      url: url == null ? '' : String(url),
      status: status == null ? '' : String(status),
      labels: Array.isArray(labels) ? labels.map(String) : labels ? [String(labels)] : [],
      fetchedAt: new Date().toISOString(),
      system: source.system || 'internal'
    };
  }).filter(x => x.externalId && x.title);
  log(`Normalized ${normalized.length}/${items.length} issue(s).`);
  return normalized;
}

function buildRequestBody(source, headers) {
  const body = source.body || {};
  const bodyFormat = String(source.bodyFormat || 'json').toLowerCase();
  if (bodyFormat === 'form' || bodyFormat === 'x-www-form-urlencoded') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    return new URLSearchParams(Object.entries(body).map(([k, v]) => [k, v == null ? '' : String(v)])).toString();
  }
  if (bodyFormat !== 'json') throw new Error(`bodyFormat پشتیبانی نمی‌شود: ${source.bodyFormat}`);
  headers['Content-Type'] = 'application/json';
  return JSON.stringify(body);
}

function parseResponseBody(rawBody) {
  if (!rawBody) return null;
  let payload = JSON.parse(rawBody);
  let depth = 0;
  while (typeof payload === 'string' && depth < 3) {
    const value = payload.trim();
    if (!value.startsWith('{') && !value.startsWith('[')) break;
    log(`Response payload is serialized JSON string; parsing inner JSON (level ${depth + 1})...`);
    payload = JSON.parse(value);
    depth += 1;
  }
  return payload;
}

export async function fetchIssues(source) {
  if (!source?.baseUrl) { log('Issue source غیرفعال است چون baseUrl خالی است.'); return []; }
  const method = String(source.method || 'GET').toUpperCase();
  if (!['GET', 'POST'].includes(method)) throw new Error(`method پشتیبانی نمی‌شود: ${method}`);

  let url;
  try {
    url = new URL(source.listPath || '', source.baseUrl);
    for (const [key, value] of Object.entries(source.query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  } catch (error) {
    logError('ساخت URL وب‌سرویس ناموفق بود.', source.baseUrl, source.listPath, error?.stack || error);
    throw error;
  }

  const apiKey = process.env[source.apiKeyEnv || 'BARSA_ISSUE_API_KEY'];
  const headers = {};
  if (apiKey) headers[source.apiKeyHeader || 'X-Api-Key'] = apiKey;
  const options = { method, headers, signal: AbortSignal.timeout(15000) };
  if (method === 'POST') options.body = buildRequestBody(source, headers);

  log(method, url.toString());
  log('itemsPath =', source.itemsPath || '<root>');
  log('mapping =', source.mapping || {});
  log('API key =', apiKey ? 'set' : 'not set');
  if (method === 'POST') {
    log('bodyFormat =', source.bodyFormat || 'json');
    log('Request body:');
    console.log(options.body || '<empty>');
  }

  let response;
  try { response = await fetch(url, options); }
  catch (error) {
    logError('HTTP request failed:', error?.message || error);
    if (error?.cause) logError('cause:', error.cause);
    throw error;
  }

  log(`HTTP ${response.status} ${response.statusText}`);
  log('content-type =', response.headers.get('content-type') || '<none>');
  const rawBody = await response.text();
  log('Raw response body:');
  console.log(rawBody || '<empty>');
  if (!response.ok) throw new Error(`وب‌سرویس issue با کد ${response.status} پاسخ داد. Body: ${rawBody.slice(0, 2000)}`);

  let payload;
  try { payload = parseResponseBody(rawBody); }
  catch (error) {
    logError('Response JSON parse failed:', error?.message || error);
    throw new Error(`پاسخ وب‌سرویس issue JSON معتبر نیست: ${error.message}`);
  }
  log('Parsed response type =', Array.isArray(payload) ? 'array' : payload === null ? 'null' : typeof payload);
  return normalizeIssues(payload, source);
}
