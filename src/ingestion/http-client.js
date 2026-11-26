'use strict';

/**
 * Shared zero-dependency HTTP/HTTPS client for exchange downloads, market cap
 * catalog requests, and retries.
 *
 * Security / robustness properties:
 * - Bounded timeouts (no hung sockets)
 * - Redirect loop cap (max 5 hops)
 * - Non-strict HTTP parser scoped strictly to www.bseindia.com / bseindia.com
 * - Exponential backoff honoring HTTP 429 Retry-After headers
 */

const http = require('http');
const https = require('https');

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/csv,application/zip,application/octet-stream,*/*',
  'Accept-Language': 'en-US,en;q=0.9'
};

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerVal) {
  if (!headerVal) return null;
  const seconds = Number(headerVal);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 30000);
  }
  const dateMs = Date.parse(headerVal);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, Math.min(dateMs - Date.now(), 30000));
  }
  return null;
}

function shouldUseInsecureHttpParser(parsedUrl) {
  const host = String(parsedUrl.hostname || '').toLowerCase();
  return host === 'bseindia.com' || host.endsWith('.bseindia.com');
}

function httpGetBuffer(url, options = {}) {
  const timeoutMs = options.timeoutMs || 25000;
  const maxRedirects = options.maxRedirects ?? 5;
  const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(new Error(`Invalid URL: ${url} (${err.message})`));
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'http:' ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      insecureHTTPParser: shouldUseInsecureHttpParser(parsed)
    };

    const req = client.request(reqOptions, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, url).toString();
        httpGetBuffer(nextUrl, { ...options, maxRedirects: maxRedirects - 1 })
          .then(resolve, reject);
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: status,
          headers: res.headers,
          body: Buffer.concat(chunks)
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout (${timeoutMs}ms) for ${url}`));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

async function fetchWithRetry(url, options = {}) {
  const maxAttempts = options.maxAttempts || 4;
  const baseDelayMs = options.baseDelayMs || 1500;
  const sleep = options.sleep || defaultSleep;
  const httpGet = options.httpGet || httpGetBuffer;
  const retryStatuses = new Set([403, 408, 429, 500, 502, 503, 504]);

  let lastError = null;
  let lastStatus = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await httpGet(url, options);
      lastStatus = res.statusCode;

      if (res.statusCode >= 200 && res.statusCode < 300) {
        return {
          ok: true,
          statusCode: res.statusCode,
          headers: res.headers,
          body: res.body,
          attempts: attempt
        };
      }

      if (res.statusCode === 404 || res.statusCode === 410) {
        return {
          ok: false,
          statusCode: res.statusCode,
          retryable: false,
          attempts: attempt,
          error: `HTTP ${res.statusCode} Not Found`
        };
      }

      if (!retryStatuses.has(res.statusCode) || attempt === maxAttempts) {
        return {
          ok: false,
          statusCode: res.statusCode,
          retryable: retryStatuses.has(res.statusCode),
          attempts: attempt,
          error: `HTTP ${res.statusCode}`
        };
      }

      const retryAfter = parseRetryAfterMs(res.headers['retry-after']);
      const backoff = retryAfter != null ? retryAfter : Math.round(baseDelayMs * Math.pow(2, attempt - 1));
      await sleep(backoff);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) {
        return {
          ok: false,
          statusCode: lastStatus,
          retryable: true,
          attempts: attempt,
          error: err.message
        };
      }
      const backoff = Math.round(baseDelayMs * Math.pow(2, attempt - 1));
      await sleep(backoff);
    }
  }

  return {
    ok: false,
    statusCode: lastStatus,
    retryable: true,
    attempts: maxAttempts,
    error: lastError ? lastError.message : 'Download failed'
  };
}

async function fetchJsonWithRetry(url, options = {}) {
  const res = await fetchWithRetry(url, {
    timeoutMs: options.timeoutMs || 15000,
    maxAttempts: options.maxAttempts || 4,
    baseDelayMs: options.baseDelayMs || 1000,
    headers: { Accept: 'application/json', ...(options.headers || {}) },
    httpGet: options.httpGet,
    sleep: options.sleep
  });
  if (!res.ok) {
    throw new Error(`${res.error || 'Request failed'} for ${url}`);
  }
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${url}: ${err.message}`, { cause: err });
  }
}

module.exports = {
  BROWSER_HEADERS,
  defaultSleep,
  parseRetryAfterMs,
  shouldUseInsecureHttpParser,
  httpGetBuffer,
  fetchWithRetry,
  fetchJsonWithRetry
};
