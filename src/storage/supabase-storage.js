'use strict';

/**
 * Persistent Supabase Storage Client
 *
 * Implements:
 * 1. Atomic three-phase dataset publishing:
 *      - Upload immutable payload to datasets/<date>/stocks-dataset-<versionId>.json
 *      - Read-back SHA-256 checksum & stock count verification
 *      - Atomic swap of pointer manifest at latest.json (preserving previousVersion)
 * 2. Distributed lockfile lease (locks/refresh.lock.json) preventing concurrent updates.
 * 3. Downgrade guard refusing to overwrite newer trading dates with older dates.
 * 4. Safe 90-trading-session retention (pruneOldDatasets) protecting latest, previousVersion,
 *    latest.json, locks/, and reference/ objects.
 * 5. Reference enrichment artifact read/write helpers under reference/<file>.json so
 *    ephemeral CI runners remain completely deterministic.
 */

const crypto = require('crypto');
const http = require('http');
const https = require('https');
const {
  DEFAULT_BUCKET,
  LATEST_POINTER_PATH,
  LOCK_OBJECT_PATH,
  REFERENCE_PREFIX,
  HISTORY_PREFIX,
  DEFAULT_RETAIN_TRADING_SESSIONS,
  DEFAULT_RETAIN_HISTORY_SESSIONS,
  MAX_HISTORICAL_SESSIONS
} = require('../config/constants');
const { isTradingDay: defaultIsTradingDay } = require('../calendar/exchange-calendar');
const {
  DAILY_ENVELOPE_FORMAT,
  HISTORY_ENVELOPE_FORMAT,
  sha256Hex: storeSha256Hex,
  encodeCompressedJson,
  decodeCompressedJson,
  stripInlineHistoricalPrices,
  buildCompactHistoryPayload,
  extractCompactHistoryFromStocks,
  validateCompactHistoryPayload
} = require('./historical-store');

const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_DELETE_BATCH_SIZE = 100;
const MAX_TRACKED_PUBLISHED_SESSIONS = 180;

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256Hex(content) {
  return storeSha256Hex(content);
}

function encodeObjectPath(objectPath) {
  return String(objectPath || '')
    .split('/')
    .filter(Boolean)
    .map(seg => encodeURIComponent(seg))
    .join('/');
}

function defaultHttpRequest(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      return resolve({ ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0), error: err.message });
    }

    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      timeout: timeoutMs,
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          statusCode: res.statusCode,
          headers: res.headers || {},
          body
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error(`Storage request timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (err) => {
      resolve({ ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0), error: err.message });
    });

    if (options.body) req.write(options.body);
    req.end();
  });
}

function getStorageConfigFromEnv(env = process.env) {
  const url = (env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const serviceKey = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = (env.SUPABASE_ANON_KEY || '').trim();
  const bucket = (env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET).trim();
  return {
    url,
    serviceKey,
    anonKey,
    bucket,
    readConfigured: Boolean(url && bucket),
    writeConfigured: Boolean(url && bucket && serviceKey)
  };
}

function normalizeObjectPath(objectPath) {
  return String(objectPath || '').trim().replace(/^\/+|\/+$/g, '');
}

function isSafeDatasetPrunePath(objectPath) {
  const normalized = normalizeObjectPath(objectPath);
  if (!normalized) return false;
  if (normalized === LATEST_POINTER_PATH) return false;
  if (normalized.startsWith('locks/') || normalized === 'locks') return false;
  if (normalized.startsWith(`${REFERENCE_PREFIX}/`) || normalized === REFERENCE_PREFIX) return false;
  if (!normalized.startsWith('datasets/')) return false;
  if (normalized.split('/').some(seg => seg === '..' || seg === '.')) return false;
  return /^datasets\/\d{4}-\d{2}-\d{2}\/.+$/.test(normalized);
}

function isSafeHistoryPrunePath(objectPath) {
  const normalized = normalizeObjectPath(objectPath);
  if (!normalized) return false;
  if (normalized === LATEST_POINTER_PATH) return false;
  if (normalized.startsWith('locks/') || normalized === 'locks') return false;
  if (normalized.startsWith(`${REFERENCE_PREFIX}/`) || normalized === REFERENCE_PREFIX) return false;
  if (!normalized.startsWith(`${HISTORY_PREFIX}/`)) return false;
  if (normalized.split('/').some(seg => seg === '..' || seg === '.')) return false;
  return /^history\/\d{4}-\d{2}-\d{2}\/.+$/.test(normalized);
}

function isSafePrunePath(objectPath) {
  return isSafeDatasetPrunePath(objectPath) || isSafeHistoryPrunePath(objectPath);
}

/**
 * Returns true strictly when Supabase Storage indicates a missing object key
 * (HTTP 404 or HTTP 400 with NoSuchKey / object not found payload).
 * Auth, permissions, missing bucket, rate-limit, 5xx, and network errors return false.
 */
function isObjectNotFoundResponse(res) {
  if (!res || res.ok) return false;
  if (res.statusCode === 404) return true;
  if (res.statusCode !== 400) return false;

  const rawBody = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body || '');
  const lower = rawBody.toLowerCase();
  if (
    lower.includes('nosuchbucket') ||
    lower.includes('bucket not found') ||
    lower.includes('jwt') ||
    lower.includes('unauthorized') ||
    lower.includes('forbidden')
  ) {
    return false;
  }

  try {
    const parsed = JSON.parse(rawBody);
    const errStr = String(parsed?.error || '').toLowerCase();
    const codeStr = String(parsed?.statusCode || '').trim();
    const msgStr = String(parsed?.message || '').toLowerCase();
    return errStr === 'nosuchkey' || errStr === 'not_found' || codeStr === '404' || msgStr.includes('object not found');
  } catch (_) {
    return /\bnosuchkey\b/i.test(rawBody) || /\bobject not found\b/i.test(rawBody);
  }
}

function createStorageClient(config = {}) {
  const initialEnvCfg = getStorageConfigFromEnv();
  const dynamicEnv = Boolean(config.dynamicEnv);
  const fixedUrl = (config.url !== undefined ? config.url : initialEnvCfg.url).replace(/\/+$/, '');
  const fixedServiceKey = config.serviceKey !== undefined ? config.serviceKey : initialEnvCfg.serviceKey;
  const fixedAnonKey = config.anonKey !== undefined ? config.anonKey : initialEnvCfg.anonKey;
  const fixedBucket = config.bucket || initialEnvCfg.bucket || DEFAULT_BUCKET;

  function getCfg() {
    if (!dynamicEnv) {
      return { baseUrl: fixedUrl, serviceKey: fixedServiceKey, anonKey: fixedAnonKey, bucket: fixedBucket };
    }
    const envCfg = getStorageConfigFromEnv();
    return {
      baseUrl: (config.url !== undefined ? config.url : envCfg.url).replace(/\/+$/, ''),
      serviceKey: config.serviceKey !== undefined ? config.serviceKey : envCfg.serviceKey,
      anonKey: config.anonKey !== undefined ? config.anonKey : envCfg.anonKey,
      bucket: config.bucket || envCfg.bucket || DEFAULT_BUCKET
    };
  }

  const httpRequest = config.httpRequest || defaultHttpRequest;
  const sleep = config.sleep || defaultSleep;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const lockTtlMs = config.lockTtlMs ?? DEFAULT_LOCK_TTL_MS;

  const isReadConfigured = () => {
    const cfg = getCfg();
    return Boolean(cfg.baseUrl && cfg.bucket);
  };
  const isWriteConfigured = () => {
    const cfg = getCfg();
    return Boolean(cfg.baseUrl && cfg.bucket && cfg.serviceKey);
  };

  function buildReadUrl(objectPath) {
    const cfg = getCfg();
    const encoded = encodeObjectPath(objectPath);
    const authKey = cfg.serviceKey || cfg.anonKey;
    return authKey
      ? `${cfg.baseUrl}/storage/v1/object/authenticated/${encodeURIComponent(cfg.bucket)}/${encoded}`
      : `${cfg.baseUrl}/storage/v1/object/public/${encodeURIComponent(cfg.bucket)}/${encoded}`;
  }

  function buildWriteUrl(objectPath) {
    const cfg = getCfg();
    const encoded = encodeObjectPath(objectPath);
    return `${cfg.baseUrl}/storage/v1/object/${encodeURIComponent(cfg.bucket)}/${encoded}`;
  }

  function buildListUrl() {
    const cfg = getCfg();
    return `${cfg.baseUrl}/storage/v1/object/list/${encodeURIComponent(cfg.bucket)}`;
  }

  function buildBatchDeleteUrl() {
    const cfg = getCfg();
    return `${cfg.baseUrl}/storage/v1/object/${encodeURIComponent(cfg.bucket)}`;
  }

  function buildAuthHeaders(key, extra = {}) {
    const headers = { ...extra };
    if (key) {
      headers.Authorization = `Bearer ${key}`;
      headers.apikey = key;
    }
    return headers;
  }

  async function requestWithRetry(url, options = {}) {
    let lastRes = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const res = await httpRequest(url, { timeoutMs, ...options });
      lastRes = res;
      if (res.ok || res.statusCode === 404 || res.statusCode === 409) {
        return res;
      }
      const retryable = res.statusCode === 0 || res.statusCode === 429 || res.statusCode >= 500;
      if (!retryable || attempt >= maxRetries) {
        return res;
      }
      await sleep(Math.min(500 * Math.pow(2, attempt - 1), 8000));
    }
    return lastRes;
  }

  async function downloadObject(objectPath) {
    if (!isReadConfigured()) {
      return { ok: false, notConfigured: true, error: 'Supabase Storage URL is not configured' };
    }
    const cfg = getCfg();
    const authKey = cfg.serviceKey || cfg.anonKey;
    const url = buildReadUrl(objectPath);
    const res = await requestWithRetry(url, {
      method: 'GET',
      headers: buildAuthHeaders(authKey, { Accept: 'application/json' })
    });

    if (isObjectNotFoundResponse(res)) {
      return { ok: false, notFound: true, statusCode: res.statusCode, error: `Object not found: ${objectPath}` };
    }
    if (!res.ok) {
      return {
        ok: false,
        statusCode: res.statusCode,
        error: res.error || `Storage GET ${objectPath} failed with HTTP ${res.statusCode}: ${res.body.toString('utf8').slice(0, 200)}`
      };
    }

    return { ok: true, statusCode: res.statusCode, text: res.body.toString('utf8'), bytes: res.body.length };
  }

  async function uploadObject(objectPath, contentStr, options = {}) {
    if (!isWriteConfigured()) {
      return {
        ok: false,
        notConfigured: true,
        error: 'Supabase Storage write credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) are not configured'
      };
    }
    const cfg = getCfg();
    const body = Buffer.from(contentStr, 'utf8');
    const url = buildWriteUrl(objectPath);
    const headers = buildAuthHeaders(cfg.serviceKey, {
      'Content-Type': options.contentType || 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': options.cacheControl || '30'
    });
    if (options.upsert !== false) {
      headers['x-upsert'] = 'true';
    }

    const res = await requestWithRetry(url, {
      method: 'POST',
      headers,
      body
    });

    if (!res.ok) {
      return {
        ok: false,
        statusCode: res.statusCode,
        error: res.error || `Storage POST ${objectPath} failed with HTTP ${res.statusCode}: ${res.body.toString('utf8').slice(0, 200)}`
      };
    }
    return { ok: true, statusCode: res.statusCode, bytes: body.length };
  }

  async function deleteObject(objectPath) {
    if (!isWriteConfigured()) return { ok: false, notConfigured: true };
    const cfg = getCfg();
    const url = buildWriteUrl(objectPath);
    const res = await requestWithRetry(url, {
      method: 'DELETE',
      headers: buildAuthHeaders(cfg.serviceKey)
    });
    return { ok: res.ok || isObjectNotFoundResponse(res), statusCode: res.statusCode };
  }

  async function listObjects(prefix = '', options = {}) {
    if (!isReadConfigured()) {
      return { ok: false, notConfigured: true, error: 'Supabase Storage URL is not configured', items: [] };
    }
    const cfg = getCfg();
    const authKey = cfg.serviceKey || cfg.anonKey;
    const normalizedPrefix = normalizeObjectPath(prefix);
    const limit = Math.min(1000, Math.max(1, options.limit || DEFAULT_LIST_LIMIT));
    const maxPages = options.maxPages || 100;
    const url = buildListUrl();
    const allItems = [];
    let offset = 0;

    for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
      const payload = JSON.stringify({
        prefix: normalizedPrefix,
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' }
      });

      const res = await requestWithRetry(url, {
        method: 'POST',
        headers: buildAuthHeaders(authKey, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
          'Accept': 'application/json'
        }),
        body: Buffer.from(payload, 'utf8')
      });

      if (!res.ok) {
        return {
          ok: false,
          statusCode: res.statusCode,
          error: res.error || `Storage LIST prefix="${normalizedPrefix}" failed with HTTP ${res.statusCode}: ${res.body.toString('utf8').slice(0, 200)}`,
          items: []
        };
      }

      let pageItems;
      try {
        pageItems = JSON.parse(res.body.toString('utf8') || '[]');
      } catch (err) {
        return { ok: false, error: `Storage LIST JSON parse error: ${err.message}`, items: [] };
      }

      if (!Array.isArray(pageItems)) {
        return { ok: false, error: 'Storage LIST response is not an array', items: [] };
      }

      allItems.push(...pageItems);
      if (pageItems.length < limit) {
        return { ok: true, items: allItems };
      }
      offset += pageItems.length;
    }

    return { ok: false, error: `Storage LIST exceeded max pagination depth (${maxPages} pages) for prefix "${normalizedPrefix}"`, items: [] };
  }

  async function listPrefixedDateObjects(prefix, options = {}) {
    const cleanPrefix = normalizeObjectPath(prefix);
    const topRes = await listObjects(cleanPrefix, options);
    if (!topRes.ok) {
      return { ok: false, error: topRes.error, objects: [], dateFolders: [] };
    }

    const objects = [];
    const dateFolders = [];
    const seenDates = new Set();

    for (const entry of topRes.items) {
      const name = String(entry?.name || '').trim();
      if (!name || name === '.emptyFolderPlaceholder') continue;
      const isFolder = entry.id == null && entry.metadata == null;
      if (isFolder && /^\d{4}-\d{2}-\d{2}$/.test(name)) {
        if (!seenDates.has(name)) {
          seenDates.add(name);
          dateFolders.push(name);
        }
      }
    }

    dateFolders.sort();

    for (const dateStr of dateFolders) {
      const subPrefix = `${cleanPrefix}/${dateStr}`;
      const subRes = await listObjects(subPrefix, options);
      if (!subRes.ok) {
        return { ok: false, error: subRes.error, objects: [], dateFolders };
      }
      for (const item of subRes.items) {
        const name = String(item?.name || '').trim();
        if (!name || name === '.emptyFolderPlaceholder') continue;
        if (item.id == null && item.metadata == null) continue;
        const fullPath = `${subPrefix}/${name}`;
        const rawSize = item.metadata?.size ?? item.metadata?.contentLength ?? null;
        const size = rawSize != null && Number.isFinite(Number(rawSize)) ? Number(rawSize) : null;
        objects.push({
          path: fullPath,
          name,
          tradingDate: dateStr,
          id: item.id || null,
          size,
          createdAt: item.created_at || null,
          updatedAt: item.updated_at || null
        });
      }
    }

    return { ok: true, objects, dateFolders };
  }

  async function listDatasetObjects(options = {}) {
    return listPrefixedDateObjects('datasets', options);
  }

  async function listHistoryObjects(options = {}) {
    return listPrefixedDateObjects(HISTORY_PREFIX, options);
  }

  async function deleteObjects(objectPaths, options = {}) {
    if (!isWriteConfigured()) {
      return { ok: false, notConfigured: true, error: 'Supabase Storage write credentials are not configured', deletedPaths: [], failedPaths: [] };
    }
    const batchSize = Math.min(1000, Math.max(1, options.batchSize || DEFAULT_DELETE_BATCH_SIZE));
    const uniquePaths = [...new Set((objectPaths || []).map(normalizeObjectPath).filter(Boolean))];
    if (uniquePaths.length === 0) {
      return { ok: true, deletedPaths: [], failedPaths: [] };
    }

    for (const p of uniquePaths) {
      if (!isSafePrunePath(p)) {
        return {
          ok: false,
          error: `Refusing to delete protected or out-of-scope storage path: ${p}`,
          deletedPaths: [],
          failedPaths: uniquePaths
        };
      }
    }

    const cfg = getCfg();
    const url = buildBatchDeleteUrl();
    const deletedPaths = [];
    const failedPaths = [];
    let lastError = null;

    for (let i = 0; i < uniquePaths.length; i += batchSize) {
      const chunk = uniquePaths.slice(i, i + batchSize);
      const payload = JSON.stringify({ prefixes: chunk });
      const res = await requestWithRetry(url, {
        method: 'DELETE',
        headers: buildAuthHeaders(cfg.serviceKey, {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(payload, 'utf8')),
          'Accept': 'application/json'
        }),
        body: Buffer.from(payload, 'utf8')
      });

      if (res.ok || isObjectNotFoundResponse(res)) {
        deletedPaths.push(...chunk);
      } else {
        failedPaths.push(...chunk);
        lastError = res.error || `Storage batch DELETE failed with HTTP ${res.statusCode}: ${res.body.toString('utf8').slice(0, 200)}`;
      }
    }

    return {
      ok: failedPaths.length === 0,
      deletedPaths,
      failedPaths,
      error: lastError
    };
  }

  function isValidDatasetVersionFile(obj) {
    if (!obj || !obj.tradingDate || !obj.name) return false;
    if (obj.size != null && obj.size <= 0) return false;
    const expectedPrefix = `stocks-dataset-${obj.tradingDate}-`;
    return obj.name.startsWith(expectedPrefix) && obj.name.endsWith('.json');
  }

  function isValidHistoryVersionFile(obj) {
    if (!obj || !obj.tradingDate || !obj.name) return false;
    if (obj.size != null && obj.size <= 0) return false;
    const expectedPrefix = `historical-prices-${obj.tradingDate}-`;
    return obj.name.startsWith(expectedPrefix) && obj.name.endsWith('.json');
  }

  function planExpiredSessionDeletions({
    objects,
    latestTradingDate,
    retainCount,
    protectedPaths,
    isValidVersionFile,
    isSafePath,
    checkTradingDay,
    ledgerSet = null,
    ledgerComplete = false,
    oldestLedgerDate = null
  }) {
    const objectsByDate = new Map();
    for (const obj of objects || []) {
      if (!objectsByDate.has(obj.tradingDate)) {
        objectsByDate.set(obj.tradingDate, []);
      }
      objectsByDate.get(obj.tradingDate).push(obj);
    }

    const validPublishedDates = [];
    const ignoredNonTradingDates = [];
    const ignoredUnpublishedOrFailedDates = [];

    for (const [dateStr, objs] of objectsByDate.entries()) {
      if (!checkTradingDay(dateStr)) {
        ignoredNonTradingDates.push(dateStr);
        continue;
      }
      if (latestTradingDate && dateStr > latestTradingDate) {
        ignoredUnpublishedOrFailedDates.push(dateStr);
        continue;
      }
      const hasValidBlob = objs.some(o => isValidVersionFile(o) || protectedPaths.has(normalizeObjectPath(o.path)));
      if (!hasValidBlob) {
        ignoredUnpublishedOrFailedDates.push(dateStr);
        continue;
      }
      if (ledgerSet) {
        const isTracked = ledgerSet.has(dateStr);
        const isLegacyPreLedger = !ledgerComplete && oldestLedgerDate && dateStr < oldestLedgerDate;
        if (!isTracked && !isLegacyPreLedger) {
          ignoredUnpublishedOrFailedDates.push(dateStr);
          continue;
        }
      }
      validPublishedDates.push(dateStr);
    }

    validPublishedDates.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const retainedTradingDates = validPublishedDates.slice(0, retainCount);
    const cutoffDate = validPublishedDates.length > retainCount
      ? retainedTradingDates[retainedTradingDates.length - 1]
      : null;

    if (!cutoffDate) {
      return {
        totalSuccessfulSessions: validPublishedDates.length,
        cutoffDate: null,
        retainedTradingDates,
        expiredTradingDates: [],
        ignoredNonTradingDates: ignoredNonTradingDates.sort(),
        ignoredUnpublishedOrFailedDates: ignoredUnpublishedOrFailedDates.sort(),
        deleteCandidates: []
      };
    }

    const retainedSet = new Set(retainedTradingDates);
    const deleteCandidates = [];
    const expiredDateSet = new Set();

    for (const [dateStr, objs] of objectsByDate.entries()) {
      if (retainedSet.has(dateStr)) continue;
      if (dateStr >= cutoffDate) continue;
      for (const obj of objs) {
        const normPath = normalizeObjectPath(obj.path);
        if (!isSafePath(normPath)) continue;
        if (protectedPaths.has(normPath)) continue;
        deleteCandidates.push(normPath);
        expiredDateSet.add(dateStr);
      }
    }

    deleteCandidates.sort();
    return {
      totalSuccessfulSessions: validPublishedDates.length,
      cutoffDate,
      retainedTradingDates,
      expiredTradingDates: [...expiredDateSet].sort(),
      ignoredNonTradingDates: ignoredNonTradingDates.sort(),
      ignoredUnpublishedOrFailedDates: ignoredUnpublishedOrFailedDates.sort(),
      deleteCandidates
    };
  }

  async function pruneOldDatasets(options = {}) {
    const retainSessions = Number.isInteger(options.retainSessions) && options.retainSessions > 0
      ? options.retainSessions
      : DEFAULT_RETAIN_TRADING_SESSIONS;
    const retainHistorySessions = Number.isInteger(options.retainHistorySessions) && options.retainHistorySessions > 0
      ? options.retainHistorySessions
      : DEFAULT_RETAIN_HISTORY_SESSIONS;
    const dryRun = Boolean(options.dryRun);
    const checkTradingDay = options.isTradingDay || defaultIsTradingDay;

    if (!isReadConfigured()) {
      return { ok: false, notConfigured: true, dryRun, retainSessions, retainHistorySessions, error: 'Supabase Storage URL is not configured', deletedCount: 0, plannedDeletions: [] };
    }
    if (!dryRun && !isWriteConfigured()) {
      return { ok: false, notConfigured: true, dryRun, retainSessions, retainHistorySessions, error: 'Supabase Storage write credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) are required to delete expired objects', deletedCount: 0, plannedDeletions: [] };
    }

    let latestManifest = options.latestManifest || null;
    if (!latestManifest) {
      const mRes = await fetchLatestManifest();
      if (mRes.notFound) {
        return {
          ok: true,
          dryRun,
          retainSessions,
          retainHistorySessions,
          retainedTradingDates: [],
          expiredTradingDates: [],
          retainedHistoryDates: [],
          expiredHistoryDates: [],
          plannedDeletions: [],
          plannedHistoryDeletions: [],
          deletedPaths: [],
          deletedCount: 0,
          deletedDatasetCount: 0,
          deletedHistoryCount: 0,
          protectedPaths: []
        };
      }
      if (!mRes.ok) {
        return { ok: false, phase: 'read_manifest', dryRun, retainSessions, retainHistorySessions, error: `Cannot verify latest.json before pruning: ${mRes.error}`, deletedCount: 0, plannedDeletions: [] };
      }
      latestManifest = mRes.manifest;
    }

    const protectedPaths = new Set();
    const latestPath = normalizeObjectPath(latestManifest.datasetPath);
    const prevPath = normalizeObjectPath(latestManifest.previousVersion?.datasetPath);
    const latestHistPath = normalizeObjectPath(latestManifest.historicalDataset?.datasetPath);
    const prevHistPath = normalizeObjectPath(latestManifest.previousVersion?.historicalDataset?.datasetPath);
    if (latestPath) protectedPaths.add(latestPath);
    if (prevPath) protectedPaths.add(prevPath);
    if (latestHistPath) protectedPaths.add(latestHistPath);
    if (prevHistPath) protectedPaths.add(prevHistPath);

    const listRes = await listDatasetObjects(options);
    if (!listRes.ok) {
      return { ok: false, phase: 'list_objects', dryRun, retainSessions, retainHistorySessions, error: listRes.error, deletedCount: 0, plannedDeletions: [], protectedPaths: [...protectedPaths] };
    }

    const histListRes = await listHistoryObjects(options);
    if (!histListRes.ok) {
      return { ok: false, phase: 'list_history_objects', dryRun, retainSessions, retainHistorySessions, error: histListRes.error, deletedCount: 0, plannedDeletions: [], protectedPaths: [...protectedPaths] };
    }

    const hasLedger = Array.isArray(latestManifest.publishedSessions);
    const ledgerComplete = Boolean(latestManifest.publishedSessionsComplete);
    let ledgerSet = null;
    let oldestLedgerDate = null;

    if (hasLedger) {
      ledgerSet = new Set();
      for (const dt of latestManifest.publishedSessions) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(dt || '')) && checkTradingDay(dt)) {
          ledgerSet.add(dt);
          if (!oldestLedgerDate || dt < oldestLedgerDate) oldestLedgerDate = dt;
        }
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(latestManifest.tradingDate || '')) && checkTradingDay(latestManifest.tradingDate)) {
        ledgerSet.add(latestManifest.tradingDate);
        if (!oldestLedgerDate || latestManifest.tradingDate < oldestLedgerDate) oldestLedgerDate = latestManifest.tradingDate;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(latestManifest.previousVersion?.tradingDate || '')) && checkTradingDay(latestManifest.previousVersion.tradingDate)) {
        ledgerSet.add(latestManifest.previousVersion.tradingDate);
        if (!oldestLedgerDate || latestManifest.previousVersion.tradingDate < oldestLedgerDate) oldestLedgerDate = latestManifest.previousVersion.tradingDate;
      }
    }

    const datasetPlan = planExpiredSessionDeletions({
      objects: listRes.objects,
      latestTradingDate: latestManifest.tradingDate,
      retainCount: retainSessions,
      protectedPaths,
      isValidVersionFile: isValidDatasetVersionFile,
      isSafePath: isSafeDatasetPrunePath,
      checkTradingDay,
      ledgerSet,
      ledgerComplete,
      oldestLedgerDate
    });

    const historyPlan = planExpiredSessionDeletions({
      objects: histListRes.objects,
      latestTradingDate: latestManifest.tradingDate,
      retainCount: retainHistorySessions,
      protectedPaths,
      isValidVersionFile: isValidHistoryVersionFile,
      isSafePath: isSafeHistoryPrunePath,
      checkTradingDay
    });

    const deleteCandidates = [...datasetPlan.deleteCandidates, ...historyPlan.deleteCandidates];

    if (dryRun || deleteCandidates.length === 0) {
      return {
        ok: true,
        dryRun,
        retainSessions,
        retainHistorySessions,
        totalSuccessfulSessions: datasetPlan.totalSuccessfulSessions,
        cutoffDate: datasetPlan.cutoffDate,
        retainedTradingDates: datasetPlan.retainedTradingDates,
        expiredTradingDates: datasetPlan.expiredTradingDates,
        ignoredNonTradingDates: datasetPlan.ignoredNonTradingDates,
        ignoredUnpublishedOrFailedDates: datasetPlan.ignoredUnpublishedOrFailedDates,
        totalHistorySessions: historyPlan.totalSuccessfulSessions,
        historyCutoffDate: historyPlan.cutoffDate,
        retainedHistoryDates: historyPlan.retainedTradingDates,
        expiredHistoryDates: historyPlan.expiredTradingDates,
        plannedDeletions: deleteCandidates,
        plannedDatasetDeletions: datasetPlan.deleteCandidates,
        plannedHistoryDeletions: historyPlan.deleteCandidates,
        deletedPaths: [],
        deletedCount: 0,
        deletedDatasetCount: 0,
        deletedHistoryCount: 0,
        protectedPaths: [...protectedPaths]
      };
    }

    const delRes = await deleteObjects(deleteCandidates, options);
    const deletedSet = new Set(delRes.deletedPaths);
    return {
      ok: delRes.ok,
      dryRun: false,
      retainSessions,
      retainHistorySessions,
      totalSuccessfulSessions: datasetPlan.totalSuccessfulSessions,
      cutoffDate: datasetPlan.cutoffDate,
      retainedTradingDates: datasetPlan.retainedTradingDates,
      expiredTradingDates: datasetPlan.expiredTradingDates,
      ignoredNonTradingDates: datasetPlan.ignoredNonTradingDates,
      ignoredUnpublishedOrFailedDates: datasetPlan.ignoredUnpublishedOrFailedDates,
      totalHistorySessions: historyPlan.totalSuccessfulSessions,
      historyCutoffDate: historyPlan.cutoffDate,
      retainedHistoryDates: historyPlan.retainedTradingDates,
      expiredHistoryDates: historyPlan.expiredTradingDates,
      plannedDeletions: deleteCandidates,
      plannedDatasetDeletions: datasetPlan.deleteCandidates,
      plannedHistoryDeletions: historyPlan.deleteCandidates,
      deletedPaths: delRes.deletedPaths,
      failedPaths: delRes.failedPaths,
      deletedCount: delRes.deletedPaths.length,
      deletedDatasetCount: datasetPlan.deleteCandidates.filter(p => deletedSet.has(p)).length,
      deletedHistoryCount: historyPlan.deleteCandidates.filter(p => deletedSet.has(p)).length,
      failedCount: delRes.failedPaths.length,
      error: delRes.error || null,
      protectedPaths: [...protectedPaths]
    };
  }

  async function fetchLatestManifest() {
    const res = await downloadObject(LATEST_POINTER_PATH);
    if (!res.ok) return res;
    try {
      const manifest = JSON.parse(res.text);
      if (!manifest || !manifest.tradingDate || !manifest.datasetPath) {
        return { ok: false, parseError: true, error: 'latest.json manifest missing required fields (tradingDate, datasetPath)' };
      }
      return { ok: true, manifest };
    } catch (err) {
      return { ok: false, parseError: true, error: `latest.json JSON parse error: ${err.message}` };
    }
  }

  async function fetchLatestDataset(options = {}) {
    const manifestRes = await fetchLatestManifest();
    if (!manifestRes.ok) return manifestRes;
    const { manifest } = manifestRes;

    if (options.knownVersionId && manifest.versionId && options.knownVersionId === manifest.versionId) {
      return { ok: true, unchanged: true, manifest };
    }

    const dataRes = await downloadObject(manifest.datasetPath);
    if (!dataRes.ok) return dataRes;

    if (manifest.sha256) {
      const actualSha = sha256Hex(dataRes.text);
      if (actualSha !== manifest.sha256) {
        return {
          ok: false,
          error: `Dataset checksum mismatch for ${manifest.datasetPath}: expected ${manifest.sha256}, got ${actualSha}`
        };
      }
    }

    try {
      const decoded = decodeCompressedJson(dataRes.text);
      const parsed = decoded.data;
      if (!parsed || !parsed.stats || !Array.isArray(parsed.stocks)) {
        return { ok: false, error: 'Downloaded dataset JSON missing stats or stocks array' };
      }
      return {
        ok: true,
        unchanged: false,
        manifest,
        stats: parsed.stats,
        stocks: parsed.stocks,
        historicalDatasetMeta: manifest.historicalDataset || parsed.stats?.historicalDataset || null,
        bytes: dataRes.bytes,
        rawBytes: decoded.rawBytes
      };
    } catch (err) {
      return { ok: false, error: `Dataset JSON parse error: ${err.message}` };
    }
  }

  async function fetchHistoricalDataset(manifestOrMeta = null, options = {}) {
    let meta;
    if (manifestOrMeta && manifestOrMeta.historicalDataset) {
      meta = manifestOrMeta.historicalDataset;
    } else if (manifestOrMeta && manifestOrMeta.datasetPath && !Array.isArray(manifestOrMeta.publishedSessions)) {
      meta = manifestOrMeta;
    } else if (!manifestOrMeta) {
      const mRes = await fetchLatestManifest();
      if (!mRes.ok) return mRes;
      meta = mRes.manifest?.historicalDataset || null;
    } else {
      meta = null;
    }

    if (!meta || !meta.datasetPath) {
      return { ok: false, notFound: true, error: 'Manifest does not reference a separated historical dataset' };
    }

    if (options.knownVersionId && meta.versionId && options.knownVersionId === meta.versionId) {
      return { ok: true, unchanged: true, meta };
    }

    const res = await downloadObject(meta.datasetPath);
    if (!res.ok) return res;

    if (meta.sha256) {
      const actualSha = sha256Hex(res.text);
      if (actualSha !== meta.sha256) {
        return {
          ok: false,
          error: `Historical dataset checksum mismatch for ${meta.datasetPath}: expected ${meta.sha256}, got ${actualSha}`
        };
      }
    }

    try {
      const decoded = decodeCompressedJson(res.text);
      const historyObj = decoded.data;
      if (meta.contentSha256 && historyObj?.contentSha256 && historyObj.contentSha256 !== meta.contentSha256) {
        return {
          ok: false,
          error: `Historical dataset content checksum mismatch for ${meta.datasetPath}`
        };
      }
      const check = validateCompactHistoryPayload(historyObj, {
        tradingDate: meta.tradingDate || historyObj?.tradingDate,
        maxSessions: meta.maxSessions || MAX_HISTORICAL_SESSIONS
      });
      if (!check.ok) {
        return { ok: false, error: `Historical dataset validation failed: ${check.errors.join('; ')}` };
      }
      return {
        ok: true,
        unchanged: false,
        meta,
        history: historyObj,
        bytes: res.bytes,
        rawBytes: decoded.rawBytes
      };
    } catch (err) {
      return { ok: false, error: `Historical dataset JSON parse error: ${err.message}` };
    }
  }

  async function downloadReferenceJson(fileName) {
    const safeName = pathSafeName(fileName);
    if (!safeName) return { ok: false, error: 'Invalid reference filename' };
    const res = await downloadObject(`${REFERENCE_PREFIX}/${safeName}`);
    if (!res.ok) return res;
    try {
      const data = JSON.parse(res.text);
      return { ok: true, data, bytes: res.bytes };
    } catch (err) {
      return { ok: false, error: `Reference JSON parse error for ${safeName}: ${err.message}` };
    }
  }

  async function uploadReferenceJson(fileName, contentStr) {
    const safeName = pathSafeName(fileName);
    if (!safeName) return { ok: false, error: 'Invalid reference filename' };
    const payload = typeof contentStr === 'string' ? contentStr : JSON.stringify(contentStr);
    return uploadObject(`${REFERENCE_PREFIX}/${safeName}`, payload, {
      upsert: true,
      cacheControl: '3600'
    });
  }

  async function acquireStorageLock(ownerId) {
    if (!isWriteConfigured()) return { acquired: false, notConfigured: true };

    const existing = await downloadObject(LOCK_OBJECT_PATH);
    if (existing.ok) {
      try {
        const lockObj = JSON.parse(existing.text);
        const expiresAtMs = Date.parse(lockObj.expiresAtUtc || '');
        if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now() && lockObj.ownerId !== ownerId) {
          return {
            acquired: false,
            locked: true,
            holder: lockObj.ownerId,
            expiresAtUtc: lockObj.expiresAtUtc
          };
        }
      } catch (_) {}
    }

    const nowMs = Date.now();
    const lockPayload = JSON.stringify({
      ownerId,
      acquiredAtUtc: new Date(nowMs).toISOString(),
      expiresAtUtc: new Date(nowMs + lockTtlMs).toISOString()
    });

    const putRes = await uploadObject(LOCK_OBJECT_PATH, lockPayload, { upsert: true, cacheControl: '0' });
    if (!putRes.ok) return { acquired: false, error: putRes.error };

    const verify = await downloadObject(LOCK_OBJECT_PATH);
    if (!verify.ok) return { acquired: false, error: verify.error };
    try {
      const verifiedObj = JSON.parse(verify.text);
      if (verifiedObj.ownerId !== ownerId) {
        return { acquired: false, locked: true, holder: verifiedObj.ownerId };
      }
    } catch (err) {
      return { acquired: false, error: err.message };
    }

    return { acquired: true };
  }

  async function releaseStorageLock(ownerId) {
    const existing = await downloadObject(LOCK_OBJECT_PATH);
    if (existing.ok) {
      try {
        const lockObj = JSON.parse(existing.text);
        if (lockObj.ownerId && lockObj.ownerId !== ownerId) {
          return { ok: false, skipped: true };
        }
      } catch (_) {}
    }
    return deleteObject(LOCK_OBJECT_PATH);
  }

  async function publishDatasetToStorage(stats, stocks, options = {}) {
    if (!isWriteConfigured()) {
      return {
        ok: false,
        notConfigured: true,
        error: 'Supabase Storage credentials not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).'
      };
    }

    if (!stats || !stats.tradingDate || !Array.isArray(stocks) || stocks.length === 0) {
      return { ok: false, error: 'Refusing to publish empty or invalid dataset to storage' };
    }

    const ownerId = options.ownerId || `pid-${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const lock = await acquireStorageLock(ownerId);
    if (!lock.acquired) {
      return {
        ok: false,
        locked: Boolean(lock.locked),
        error: lock.locked
          ? `Concurrent storage refresh in progress (holder: ${lock.holder}, expires: ${lock.expiresAtUtc})`
          : `Failed to acquire storage lock: ${lock.error}`
      };
    }

    try {
      let previousManifest = null;
      const currentRes = await fetchLatestManifest();
      if (currentRes.ok) {
        previousManifest = currentRes.manifest;
        if (
          previousManifest.tradingDate &&
          stats.tradingDate < previousManifest.tradingDate &&
          !options.allowDowngrade
        ) {
          return {
            ok: false,
            downgradeRefused: true,
            error: `Refusing to overwrite newer storage dataset (${previousManifest.tradingDate}) with older date (${stats.tradingDate})`
          };
        }
      } else if (!currentRes.notFound && !(options.force && currentRes.parseError)) {
        return {
          ok: false,
          statusCode: currentRes.statusCode,
          error: `Cannot verify current latest.json state: ${currentRes.error}`
        };
      }

      const safeTimestamp = (stats.refreshedAtUtc || new Date().toISOString()).replace(/[:.]/g, '-');
      const versionId = `${stats.tradingDate}-${safeTimestamp}`;
      const datasetPath = `datasets/${stats.tradingDate}/stocks-dataset-${versionId}.json`;

      // Prepare separate compact 90-session historical dataset when available
      let compactHistory = null;
      if (options.historicalDataset) {
        compactHistory = {
          ...options.historicalDataset,
          versionId: options.historicalDataset.versionId || `${stats.tradingDate}-hist-${safeTimestamp}`,
          tradingDate: stats.tradingDate,
          refreshedAtUtc: stats.refreshedAtUtc
        };
      } else if (options.historicalMatrix && options.historicalMatrix.priceHistoryByIsin) {
        compactHistory = buildCompactHistoryPayload({
          sessions: options.historicalMatrix.sessions || [],
          priceHistoryByIsin: options.historicalMatrix.priceHistoryByIsin,
          versionId: `${stats.tradingDate}-hist-${safeTimestamp}`,
          tradingDate: stats.tradingDate,
          refreshedAtUtc: stats.refreshedAtUtc,
          maxSessions: options.maxHistoricalSessions || MAX_HISTORICAL_SESSIONS
        });
      } else {
        compactHistory = extractCompactHistoryFromStocks(
          stocks,
          stats.tradingDate,
          options.maxHistoricalSessions || MAX_HISTORICAL_SESSIONS
        );
        if (compactHistory) {
          compactHistory.versionId = `${stats.tradingDate}-hist-${safeTimestamp}`;
          compactHistory.refreshedAtUtc = stats.refreshedAtUtc;
        }
      }

      let historicalMeta = null;
      if (compactHistory) {
        const histValidation = validateCompactHistoryPayload(compactHistory, {
          tradingDate: stats.tradingDate,
          maxSessions: compactHistory.maxSessions || MAX_HISTORICAL_SESSIONS
        });
        if (!histValidation.ok) {
          return {
            ok: false,
            phase: 'validate_history',
            error: `Historical dataset validation failed: ${histValidation.errors.join('; ')}`
          };
        }

        const prevHistMeta = previousManifest?.historicalDataset || null;
        let reusedExistingHistory = false;
        if (
          !options.forceHistoryUpload &&
          prevHistMeta?.datasetPath &&
          prevHistMeta.contentSha256 &&
          prevHistMeta.contentSha256 === compactHistory.contentSha256
        ) {
          const checkPrevHist = await downloadObject(prevHistMeta.datasetPath);
          if (checkPrevHist.ok && (!prevHistMeta.sha256 || sha256Hex(checkPrevHist.text) === prevHistMeta.sha256)) {
            historicalMeta = prevHistMeta;
            reusedExistingHistory = true;
          }
        }

        if (!reusedExistingHistory) {
          const histVersionId = compactHistory.versionId || `${stats.tradingDate}-hist-${safeTimestamp}`;
          const historyPath = `${HISTORY_PREFIX}/${stats.tradingDate}/historical-prices-${histVersionId}.json`;
          const encodedHistory = encodeCompressedJson(compactHistory, {
            format: HISTORY_ENVELOPE_FORMAT,
            versionId: histVersionId,
            tradingDate: stats.tradingDate,
            startDate: compactHistory.startDate,
            endDate: compactHistory.endDate,
            sessionCount: compactHistory.sessionCount,
            maxSessions: compactHistory.maxSessions,
            isinCount: compactHistory.isinCount,
            contentSha256: compactHistory.contentSha256
          });

          // Phase 1A: Upload immutable separated compact historical dataset
          const histUploadRes = await uploadObject(historyPath, encodedHistory.text, {
            upsert: false,
            cacheControl: '31536000'
          });
          if (!histUploadRes.ok) {
            return { ok: false, phase: 'upload_history', error: histUploadRes.error };
          }

          // Phase 2A: Read-back SHA-256 & schema verification for historical dataset
          const histVerifyRes = await downloadObject(historyPath);
          if (!histVerifyRes.ok) {
            return { ok: false, phase: 'verify_history_upload', error: `Historical read-back verification failed: ${histVerifyRes.error}` };
          }
          const histReadBackSha = sha256Hex(histVerifyRes.text);
          if (histReadBackSha !== encodedHistory.sha256) {
            return {
              ok: false,
              phase: 'verify_history_checksum',
              error: `Uploaded historical dataset checksum mismatch (expected ${encodedHistory.sha256}, got ${histReadBackSha}); latest.json NOT updated`
            };
          }
          try {
            const histDecoded = decodeCompressedJson(histVerifyRes.text);
            const verifiedHist = histDecoded.data;
            const histCheck = validateCompactHistoryPayload(verifiedHist, {
              tradingDate: stats.tradingDate,
              maxSessions: compactHistory.maxSessions || MAX_HISTORICAL_SESSIONS
            });
            if (!histCheck.ok || verifiedHist.contentSha256 !== compactHistory.contentSha256) {
              return {
                ok: false,
                phase: 'verify_history_structure',
                error: 'Uploaded historical dataset structure or content digest mismatch; latest.json NOT updated'
              };
            }
          } catch (histErr) {
            return {
              ok: false,
              phase: 'verify_history_structure',
              error: `Uploaded historical dataset decode error: ${histErr.message}; latest.json NOT updated`
            };
          }

          historicalMeta = {
            schemaVersion: 2,
            versionId: histVersionId,
            tradingDate: stats.tradingDate,
            datasetPath: historyPath,
            encoding: 'gzip+base64',
            sha256: encodedHistory.sha256,
            contentSha256: compactHistory.contentSha256,
            bytes: encodedHistory.bytes,
            rawBytes: encodedHistory.rawBytes,
            startDate: compactHistory.startDate,
            endDate: compactHistory.endDate,
            sessionCount: compactHistory.sessionCount,
            maxSessions: compactHistory.maxSessions,
            isinCount: compactHistory.isinCount
          };
        }
      }

      // Daily snapshot stores latest stock info ONLY (no 90-session historical_prices matrix)
      const dailyStocks = stripInlineHistoricalPrices(stocks);

      const storageStats = {
        ...stats,
        storageProvider: 'supabase',
        storageBucket: getCfg().bucket,
        storageVersionId: versionId,
        ...(historicalMeta ? { historicalDataset: historicalMeta } : {})
      };

      const encodedDaily = encodeCompressedJson({
        schemaVersion: 2,
        versionId,
        tradingDate: stats.tradingDate,
        refreshedAtUtc: stats.refreshedAtUtc,
        stats: storageStats,
        stocks: dailyStocks
      }, {
        format: DAILY_ENVELOPE_FORMAT,
        versionId,
        tradingDate: stats.tradingDate,
        stockCount: dailyStocks.length,
        hasInlineHistory: false
      });

      // Phase 1B: Upload immutable versioned daily dataset
      const uploadRes = await uploadObject(datasetPath, encodedDaily.text, {
        upsert: false,
        cacheControl: '31536000'
      });
      if (!uploadRes.ok) {
        return { ok: false, phase: 'upload_dataset', error: uploadRes.error };
      }

      // Phase 2B: Read-back verification
      const verifyRes = await downloadObject(datasetPath);
      if (!verifyRes.ok) {
        return { ok: false, phase: 'verify_upload', error: `Read-back verification failed: ${verifyRes.error}` };
      }
      const readBackSha = sha256Hex(verifyRes.text);
      if (readBackSha !== encodedDaily.sha256) {
        return {
          ok: false,
          phase: 'verify_checksum',
          error: `Uploaded dataset checksum mismatch (expected ${encodedDaily.sha256}, got ${readBackSha}); latest.json NOT updated`
        };
      }
      const readBackDecoded = decodeCompressedJson(verifyRes.text);
      const readBackParsed = readBackDecoded.data;
      if (!Array.isArray(readBackParsed?.stocks) || readBackParsed.stocks.length !== dailyStocks.length) {
        return {
          ok: false,
          phase: 'verify_count',
          error: 'Uploaded dataset stock count mismatch; latest.json NOT updated'
        };
      }
      if (readBackParsed.stocks.some(s => Object.prototype.hasOwnProperty.call(s || {}, 'historical_prices'))) {
        return {
          ok: false,
          phase: 'verify_schema',
          error: 'Uploaded daily dataset unexpectedly contains inline historical_prices matrix'
        };
      }

      const checkTradingDay = options.isTradingDay || defaultIsTradingDay;
      const publishedSessionSet = new Set();
      if (Array.isArray(previousManifest?.publishedSessions)) {
        for (const dt of previousManifest.publishedSessions) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(String(dt || '')) && checkTradingDay(dt)) {
            publishedSessionSet.add(dt);
          }
        }
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(previousManifest?.previousVersion?.tradingDate || '')) && checkTradingDay(previousManifest.previousVersion.tradingDate)) {
        publishedSessionSet.add(previousManifest.previousVersion.tradingDate);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(previousManifest?.tradingDate || '')) && checkTradingDay(previousManifest.tradingDate)) {
        publishedSessionSet.add(previousManifest.tradingDate);
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(String(stats.tradingDate || '')) && checkTradingDay(stats.tradingDate)) {
        publishedSessionSet.add(stats.tradingDate);
      }
      const publishedSessions = [...publishedSessionSet].sort().slice(-MAX_TRACKED_PUBLISHED_SESSIONS);
      const publishedSessionsComplete = previousManifest
        ? Boolean(previousManifest.publishedSessionsComplete)
        : true;

      // Phase 3: Atomic pointer swap
      const manifestObj = {
        schemaVersion: 2,
        versionId,
        tradingDate: stats.tradingDate,
        nseSourceDate: stats.nseSourceDate || stats.tradingDate,
        bseSourceDate: stats.bseSourceDate || stats.tradingDate,
        refreshedAtUtc: stats.refreshedAtUtc,
        istDisplayTime: stats.istDisplayTime,
        totalStocks: dailyStocks.length,
        pipelineVersion: stats.pipelineVersion || '2.0.0',
        datasetPath,
        encoding: 'gzip+base64',
        sha256: encodedDaily.sha256,
        bytes: encodedDaily.bytes,
        rawBytes: encodedDaily.rawBytes,
        historicalDataset: historicalMeta,
        publishedSessions,
        publishedSessionsComplete,
        previousVersion: previousManifest ? {
          versionId: previousManifest.versionId,
          tradingDate: previousManifest.tradingDate,
          datasetPath: previousManifest.datasetPath,
          sha256: previousManifest.sha256 || null,
          historicalDataset: previousManifest.historicalDataset ? {
            versionId: previousManifest.historicalDataset.versionId || null,
            tradingDate: previousManifest.historicalDataset.tradingDate || previousManifest.tradingDate,
            datasetPath: previousManifest.historicalDataset.datasetPath,
            sha256: previousManifest.historicalDataset.sha256 || null
          } : null
        } : null,
        stats: storageStats
      };
      const manifestPayload = JSON.stringify(manifestObj, null, 2);

      const pointerRes = await uploadObject(LATEST_POINTER_PATH, manifestPayload, {
        upsert: true,
        cacheControl: '30'
      });
      if (!pointerRes.ok) {
        return { ok: false, phase: 'swap_pointer', error: pointerRes.error };
      }

      // Phase 4: Non-fatal retention cleanup (90 daily sessions, rolling history snapshots)
      let retention = null;
      if (!options.skipRetention) {
        try {
          retention = await pruneOldDatasets({
            latestManifest: manifestObj,
            retainSessions: options.retainSessions,
            retainHistorySessions: options.retainHistorySessions,
            dryRun: Boolean(options.retentionDryRun),
            isTradingDay: options.isTradingDay
          });
        } catch (retErr) {
          retention = {
            ok: false,
            phase: 'retention_exception',
            error: retErr.message,
            deletedCount: 0,
            plannedDeletions: []
          };
        }
      }

      return {
        ok: true,
        versionId,
        datasetPath,
        sha256: encodedDaily.sha256,
        bytes: encodedDaily.bytes,
        rawBytes: encodedDaily.rawBytes,
        historicalDataset: historicalMeta,
        previousVersionId: previousManifest?.versionId || null,
        retention
      };
    } finally {
      await releaseStorageLock(ownerId);
    }
  }

  return {
    get baseUrl() { return getCfg().baseUrl; },
    get bucket() { return getCfg().bucket; },
    isReadConfigured,
    isWriteConfigured,
    downloadObject,
    uploadObject,
    deleteObject,
    deleteObjects,
    listObjects,
    listDatasetObjects,
    listHistoryObjects,
    pruneOldDatasets,
    fetchLatestManifest,
    fetchLatestDataset,
    fetchHistoricalDataset,
    downloadReferenceJson,
    uploadReferenceJson,
    acquireStorageLock,
    releaseStorageLock,
    publishDatasetToStorage
  };
}

function pathSafeName(fileName) {
  const base = String(fileName || '').trim();
  if (!base || base.includes('/') || base.includes('\\') || base.includes('..')) return null;
  return base;
}

const defaultClient = createStorageClient({ dynamicEnv: true });

module.exports = {
  DEFAULT_BUCKET,
  LATEST_POINTER_PATH,
  LOCK_OBJECT_PATH,
  REFERENCE_PREFIX,
  HISTORY_PREFIX,
  DEFAULT_RETAIN_TRADING_SESSIONS,
  DEFAULT_RETAIN_HISTORY_SESSIONS,
  sha256Hex,
  isSafeDatasetPrunePath,
  isSafeHistoryPrunePath,
  isSafePrunePath,
  isObjectNotFoundResponse,
  getStorageConfigFromEnv,
  createStorageClient,
  ...defaultClient
};
