import { URL } from 'node:url';

const LOG_PREFIX = '[BarsaAgent][Issues]';

function log(...args) {
  console.log(LOG_PREFIX, ...args);
}

function logError(...args) {
  console.error(LOG_PREFIX, ...args);
}

export function getPath(value, dotted) {
  if (!dotted) return value;
  return dotted.split('.').reduce((v, key) => v == null ? undefined : v[key], value);
}

export function normalizeIssues(payload, source) {
  const items = getPath(payload, source.itemsPath || '') || payload;

  if (!Array.isArray(items)) {
    const actualType =
      items === null
        ? 'null'
        : Array.isArray(items)
          ? 'array'
          : typeof items;

    throw new Error(
      `مسیر itemsPath به آرایه منتهی نمی‌شود. itemsPath=${source.itemsPath || '<root>'}, actualType=${actualType}`
    );
  }

  const normalized = items
    .map(raw => {
      const m = source.mapping || {};
      const labels = getPath(raw, m.labels);

      return {
        externalId: String(getPath(raw, m.externalId) ?? ''),
        title: String(getPath(raw, m.title) ?? ''),
        body: String(getPath(raw, m.body) ?? ''),
        url: getPath(raw, m.url) || '',
        status: String(getPath(raw, m.status) ?? ''),
        labels: Array.isArray(labels)
          ? labels.map(String)
          : labels
            ? [String(labels)]
            : [],
        fetchedAt: new Date().toISOString(),
        system: source.system || 'internal'
      };
    })
    .filter(x => x.externalId && x.title);

  log(`Normalized ${normalized.length}/${items.length} issue(s).`);

  return normalized;
}

function buildRequestBody(source, headers) {
  const body = source.body || {};
  const bodyFormat = String(source.bodyFormat || 'json').toLowerCase();

  if (
    bodyFormat === 'form' ||
    bodyFormat === 'x-www-form-urlencoded'
  ) {
    headers['Content-Type'] =
      'application/x-www-form-urlencoded;charset=UTF-8';

    return new URLSearchParams(
      Object.entries(body).map(([key, value]) => [
        key,
        value == null ? '' : String(value)
      ])
    ).toString();
  }

  if (bodyFormat !== 'json') {
    throw new Error(
      `bodyFormat پشتیبانی نمی‌شود: ${source.bodyFormat}`
    );
  }

  headers['Content-Type'] = 'application/json';

  return JSON.stringify(body);
}

export async function fetchIssues(source) {
  if (!source?.baseUrl) {
    log('Issue source غیرفعال است چون baseUrl خالی است.');
    return [];
  }

  const method = String(
    source.method || 'GET'
  ).toUpperCase();

  if (!['GET', 'POST'].includes(method)) {
    throw new Error(
      `method پشتیبانی نمی‌شود: ${method}`
    );
  }

  let url;

  try {
    url = new URL(
      source.listPath || '',
      source.baseUrl
    );

    for (const [key, value] of Object.entries(
      source.query || {}
    )) {
      url.searchParams.set(key, value);
    }
  } catch (error) {
    logError(
      'ساخت URL وب‌سرویس ناموفق بود.'
    );

    logError(
      'baseUrl =',
      source.baseUrl
    );

    logError(
      'listPath =',
      source.listPath || ''
    );

    logError(
      'query =',
      source.query || {}
    );

    logError(
      error?.stack || error
    );

    throw error;
  }

  const apiKey =
    process.env[
      source.apiKeyEnv ||
      'BARSA_ISSUE_API_KEY'
    ];

  const headers = {};

  if (apiKey) {
    headers[
      source.apiKeyHeader ||
      'X-Api-Key'
    ] = apiKey;
  }

  const options = {
    method,
    headers,
    signal: AbortSignal.timeout(15000)
  };

  if (method === 'POST') {
    options.body = buildRequestBody(
      source,
      headers
    );
  }

  log(
    method,
    url.toString()
  );

  log(
    'itemsPath =',
    source.itemsPath || '<root>'
  );

  log(
    'mapping =',
    source.mapping || {}
  );

  log(
    'API key =',
    apiKey
      ? `set via ${
          source.apiKeyEnv ||
          'BARSA_ISSUE_API_KEY'
        } (${
          source.apiKeyHeader ||
          'X-Api-Key'
        } header)`
      : 'not set'
  );

  if (method === 'POST') {
    log(
      'bodyFormat =',
      source.bodyFormat || 'json'
    );

    log(
      'Request body:'
    );

    console.log(
      options.body || '<empty>'
    );
  }

  let response;

  try {
    response = await fetch(
      url,
      options
    );
  } catch (error) {
    logError(
      'HTTP request failed:',
      error?.message || error
    );

    if (error?.cause) {
      logError(
        'cause:',
        error.cause
      );
    }

    logError(
      error?.stack || ''
    );

    throw error;
  }

  log(
    `HTTP ${response.status} ${response.statusText}`
  );

  log(
    'content-type =',
    response.headers.get('content-type') ||
    '<none>'
  );

  const rawBody =
    await response.text();

  log(
    'Raw response body:'
  );

  console.log(
    rawBody || '<empty>'
  );

  if (!response.ok) {
    throw new Error(
      `وب‌سرویس issue با کد ${response.status} پاسخ داد. Body: ${rawBody.slice(0, 2000)}`
    );
  }

  let payload;

  try {
    payload =
      rawBody
        ? JSON.parse(rawBody)
        : null;
  } catch (error) {
    logError(
      'Response JSON parse failed:',
      error?.message || error
    );

    throw new Error(
      `پاسخ وب‌سرویس issue JSON معتبر نیست: ${error.message}`
    );
  }

  try {
    return normalizeIssues(
      payload,
      source
    );
  } catch (error) {
    logError(
      'Issue normalization failed:',
      error?.message || error
    );

    logError(
      'Parsed payload:',
      payload
    );

    throw error;
  }
}