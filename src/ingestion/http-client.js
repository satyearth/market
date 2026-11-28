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

const https = require('https');
const net = require('net');
const dns = require('dns');

const DEFAULT_ALLOWED_HOST_SUFFIXES = Object.freeze([
  'nseindia.com',
  'bseindia.com',
  'dharun.dev',
  'supabase.co'
]);

const PRIVATE_HOSTNAME_RE = /^(?:localhost|.*\.local|.*\.localhost|.*\.internal|.*\.localdomain)$/i;

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

function isDisallowedIpOrInternalHost(hostname) {
  const cleanHost = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!cleanHost) return true;
  if (PRIVATE_HOSTNAME_RE.test(cleanHost)) return true;
  if (net.isIP(cleanHost) !== 0) return true;
  // Catch integer / hex / octal IPv4 encodings (e.g. 2130706433 or 0x7f000001)
  if (/^(?:\d+|0x[0-9a-f]+|0[0-7]+)$/i.test(cleanHost)) return true;
  return false;
}

function isPrivateOrReservedIpv4(ip) {
  const parts = String(ip || '').split('.').map(n => Number.parseInt(n, 10));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // Link-local / IMDS 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // Multicast & reserved
  return false;
}

function isPrivateOrReservedIp(ip) {
  const clean = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const ver = net.isIP(clean);
  if (ver === 4) return isPrivateOrReservedIpv4(clean);
  if (ver !== 6) return true;

  if (clean === '::' || clean === '::1') return true;
  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice(7);
    if (net.isIP(mapped) === 4) return isPrivateOrReservedIpv4(mapped);
    const hexMatch = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(mapped);
    if (hexMatch) {
      const hi = Number.parseInt(hexMatch[1], 16);
      const lo = Number.parseInt(hexMatch[2], 16);
      return isPrivateOrReservedIpv4(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    return true;
  }
  const firstHextet = Number.parseInt(clean.split(':')[0] || '0', 16);
  if (Number.isNaN(firstHextet)) return true;
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // Unique local fc00::/7
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // Link-local fe80::/10
  if ((firstHextet & 0xff00) === 0xff00) return true; // Multicast ff00::/8
  if (clean.startsWith('100::')) return true;
  return false;
}

function createSafeDnsLookup(dnsLookupImpl = dns.lookup) {
  return function safeDnsLookup(hostname, opts, cb) {
    let lookupOpts = opts;
    let callback = cb;
    if (typeof opts === 'function') {
      callback = opts;
      lookupOpts = {};
    }
    const wantAll = Boolean(lookupOpts && typeof lookupOpts === 'object' && lookupOpts.all);
    const innerOpts = { ...(typeof lookupOpts === 'object' && lookupOpts ? lookupOpts : {}), all: true };

    dnsLookupImpl(hostname, innerOpts, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const list = Array.isArray(addresses) ? addresses : (addresses ? [addresses] : []);
      if (list.length === 0) {
        callback(new Error(`DNS lookup returned no addresses for ${hostname}`));
        return;
      }
      for (const entry of list) {
        const addr = typeof entry === 'string' ? entry : entry?.address;
        if (!addr || isPrivateOrReservedIp(addr)) {
          callback(new Error(`Blocked resolved private/reserved IP (${addr || 'empty'}) for ${hostname}`));
          return;
        }
      }
      if (wantAll) {
        callback(null, list);
      } else {
        const first = list[0];
        callback(null, typeof first === 'string' ? first : first.address, typeof first === 'string' ? net.isIP(first) : first.family);
      }
    });
  };
}

function isHostnameAllowlisted(hostname, allowedHosts = DEFAULT_ALLOWED_HOST_SUFFIXES) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  if (!host) return false;
  const list = Array.isArray(allowedHosts) && allowedHosts.length > 0
    ? allowedHosts
    : DEFAULT_ALLOWED_HOST_SUFFIXES;
  return list.some((allowed) => {
    const clean = String(allowed || '').toLowerCase().trim().replace(/^\.+|\.+$/g, '');
    return Boolean(clean && (host === clean || host.endsWith(`.${clean}`)));
  });
}

function validateRequestUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid URL: ${rawUrl} (${err.message})`, { cause: err });
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`Blocked insecure protocol "${parsed.protocol}" for ${rawUrl}; HTTPS is required.`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`Blocked URL with embedded credentials: ${parsed.origin}${parsed.pathname}`);
  }
  if (parsed.port && parsed.port !== '443') {
    throw new Error(`Blocked unexpected port "${parsed.port}" for ${parsed.hostname}; only port 443 is permitted.`);
  }
  if (isDisallowedIpOrInternalHost(parsed.hostname)) {
    throw new Error(`Blocked private/internal or IP destination hostname: ${parsed.hostname}`);
  }
  if (!isHostnameAllowlisted(parsed.hostname, options.allowedHosts)) {
    throw new Error(`Blocked untrusted hostname outside allowlist: ${parsed.hostname}`);
  }

  return parsed;
}

function httpGetBuffer(url, options = {}) {
  const timeoutMs = options.timeoutMs || 25000;
  const maxRedirects = options.maxRedirects ?? 5;
  const headers = { ...BROWSER_HEADERS, ...(options.headers || {}) };
  const requestImpl = options.httpsRequest || https.request;

  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = validateRequestUrl(url, options);
    } catch (err) {
      reject(err);
      return;
    }

    const canonicalUrl = parsed.toString();
    const visitedUrls = options._visitedUrls instanceof Set
      ? options._visitedUrls
      : new Set();
    if (visitedUrls.has(canonicalUrl)) {
      reject(new Error(`Redirect loop detected for ${canonicalUrl}`));
      return;
    }
    const nextVisited = new Set(visitedUrls);
    nextVisited.add(canonicalUrl);

    const reqOptions = {
      hostname: parsed.hostname,
      port: 443,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET',
      headers,
      timeout: timeoutMs,
      lookup: createSafeDnsLookup(options.dnsLookup),
      insecureHTTPParser: shouldUseInsecureHttpParser(parsed)
    };

    const req = requestImpl(reqOptions, (res) => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers && res.headers.location) {
        if (typeof res.resume === 'function') res.resume();
        if (maxRedirects <= 0) {
          reject(new Error(`Too many redirects for ${url}`));
          return;
        }
        let nextUrl;
        try {
          const resolved = new URL(res.headers.location, canonicalUrl);
          validateRequestUrl(resolved.toString(), options);
          nextUrl = resolved.toString();
        } catch (err) {
          reject(new Error(`Blocked unsafe redirect from ${parsed.hostname}: ${err.message}`, { cause: err }));
          return;
        }
        if (nextVisited.has(nextUrl)) {
          reject(new Error(`Redirect loop detected to ${nextUrl}`));
          return;
        }
        httpGetBuffer(nextUrl, {
          ...options,
          maxRedirects: maxRedirects - 1,
          _visitedUrls: nextVisited
        }).then(resolve, reject);
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
  DEFAULT_ALLOWED_HOST_SUFFIXES,
  defaultSleep,
  parseRetryAfterMs,
  shouldUseInsecureHttpParser,
  isDisallowedIpOrInternalHost,
  isPrivateOrReservedIp,
  createSafeDnsLookup,
  isHostnameAllowlisted,
  validateRequestUrl,
  httpGetBuffer,
  fetchWithRetry,
  fetchJsonWithRetry
};
