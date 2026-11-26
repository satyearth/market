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
 * 4. Safe 30-trading-session retention (pruneOldDatasets) protecting latest, previousVersion,
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
  DEFAULT_RETAIN_TRADING_SESSIONS
} = require('../config/constants');
const { isTradingDay: defaultIsTradingDay } = require('../calendar/exchange-calendar');

const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_DELETE_BATCH_SIZE = 100;
const MAX_TRACKED_PUBLISHED_SESSIONS = 120;

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
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

    if (res.statusCode === 404) {
      return { ok: false, notFound: true, statusCode: 404, error: `Object not found: ${objectPath}` };
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
    return { ok: res.ok || res.statusCode === 404, statusCode: res.statusCode };
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

  async function listDatasetObjects(options = {}) {
    const topRes = await listObjects('datasets', options);
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
      const subPrefix = `datasets/${dateStr}`;
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
      if (!isSafeDatasetPrunePath(p)) {
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

      if (res.ok || res.statusCode === 404) {
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

  async function pruneOldDatasets(options = {}) {
    const retainSessions = Number.isInteger(options.retainSessions) && options.retainSessions > 0
      ? options.retainSessions
      : DEFAULT_RETAIN_TRADING_SESSIONS;
    const dryRun = Boolean(options.dryRun);
    const checkTradingDay = options.isTradingDay || defaultIsTradingDay;

    if (!isReadConfigured()) {
      return { ok: false, notConfigured: true, dryRun, retainSessions, error: 'Supabase Storage URL is not configured', deletedCount: 0, plannedDeletions: [] };
    }
    if (!dryRun && !isWriteConfigured()) {
      return { ok: false, notConfigured: true, dryRun, retainSessions, error: 'Supabase Storage write credentials (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY) are required to delete expired objects', deletedCount: 0, plannedDeletions: [] };
    }

    let latestManifest = options.latestManifest || null;
    if (!latestManifest) {
      const mRes = await fetchLatestManifest();
      if (mRes.notFound) {
        return {
          ok: true,
          dryRun,
          retainSessions,
          retainedTradingDates: [],
          expiredTradingDates: [],
          plannedDeletions: [],
          deletedPaths: [],
          deletedCount: 0,
          protectedPaths: []
        };
      }
      if (!mRes.ok) {
        return { ok: false, phase: 'read_manifest', dryRun, retainSessions, error: `Cannot verify latest.json before pruning: ${mRes.error}`, deletedCount: 0, plannedDeletions: [] };
      }
      latestManifest = mRes.manifest;
    }

    const protectedPaths = new Set();
    const latestPath = normalizeObjectPath(latestManifest.datasetPath);
    const prevPath = normalizeObjectPath(latestManifest.previousVersion?.datasetPath);
    if (latestPath) protectedPaths.add(latestPath);
    if (prevPath) protectedPaths.add(prevPath);

    const listRes = await listDatasetObjects(options);
    if (!listRes.ok) {
      return { ok: false, phase: 'list_objects', dryRun, retainSessions, error: listRes.error, deletedCount: 0, plannedDeletions: [], protectedPaths: [...protectedPaths] };
    }

    const objectsByDate = new Map();
    for (const obj of listRes.objects) {
      if (!objectsByDate.has(obj.tradingDate)) {
        objectsByDate.set(obj.tradingDate, []);
      }
      objectsByDate.get(obj.tradingDate).push(obj);
    }

    const hasLedger = Array.isArray(latestManifest.publishedSessions);
    const ledgerComplete = Boolean(latestManifest.publishedSessionsComplete);
    const ledgerSet = new Set();
    let oldestLedgerDate = null;

    if (hasLedger) {
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

    const validPublishedDates = [];
    const ignoredNonTradingDates = [];
    const ignoredUnpublishedOrFailedDates = [];

    for (const [dateStr, objs] of objectsByDate.entries()) {
      if (!checkTradingDay(dateStr)) {
        ignoredNonTradingDates.push(dateStr);
        continue;
      }
      if (latestManifest.tradingDate && dateStr > latestManifest.tradingDate) {
        ignoredUnpublishedOrFailedDates.push(dateStr);
        continue;
      }
      const hasValidBlob = objs.some(o => isValidDatasetVersionFile(o) || protectedPaths.has(normalizeObjectPath(o.path)));
      if (!hasValidBlob) {
        ignoredUnpublishedOrFailedDates.push(dateStr);
        continue;
      }
      if (hasLedger) {
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
    const retainedTradingDates = validPublishedDates.slice(0, retainSessions);
    const cutoffDate = validPublishedDates.length > retainSessions
      ? retainedTradingDates[retainedTradingDates.length - 1]
      : null;

    if (!cutoffDate) {
      return {
        ok: true,
        dryRun,
        retainSessions,
        totalSuccessfulSessions: validPublishedDates.length,
        retainedTradingDates,
        expiredTradingDates: [],
        ignoredNonTradingDates: ignoredNonTradingDates.sort(),
        ignoredUnpublishedOrFailedDates: ignoredUnpublishedOrFailedDates.sort(),
        plannedDeletions: [],
        deletedPaths: [],
        deletedCount: 0,
        protectedPaths: [...protectedPaths]
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
        if (!isSafeDatasetPrunePath(normPath)) continue;
        if (protectedPaths.has(normPath)) continue;
        deleteCandidates.push(normPath);
        expiredDateSet.add(dateStr);
      }
    }

    deleteCandidates.sort();
    const expiredTradingDates = [...expiredDateSet].sort();

    if (dryRun || deleteCandidates.length === 0) {
      return {
        ok: true,
        dryRun,
        retainSessions,
        totalSuccessfulSessions: validPublishedDates.length,
        cutoffDate,
        retainedTradingDates,
        expiredTradingDates,
        ignoredNonTradingDates: ignoredNonTradingDates.sort(),
        ignoredUnpublishedOrFailedDates: ignoredUnpublishedOrFailedDates.sort(),
        plannedDeletions: deleteCandidates,
        deletedPaths: [],
        deletedCount: 0,
        protectedPaths: [...protectedPaths]
      };
    }

    const delRes = await deleteObjects(deleteCandidates, options);
    return {
      ok: delRes.ok,
      dryRun: false,
      retainSessions,
      totalSuccessfulSessions: validPublishedDates.length,
      cutoffDate,
      retainedTradingDates,
      expiredTradingDates,
      ignoredNonTradingDates: ignoredNonTradingDates.sort(),
      ignoredUnpublishedOrFailedDates: ignoredUnpublishedOrFailedDates.sort(),
      plannedDeletions: deleteCandidates,
      deletedPaths: delRes.deletedPaths,
      failedPaths: delRes.failedPaths,
      deletedCount: delRes.deletedPaths.length,
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
        return { ok: false, error: 'latest.json manifest missing required fields (tradingDate, datasetPath)' };
      }
      return { ok: true, manifest };
    } catch (err) {
      return { ok: false, error: `latest.json JSON parse error: ${err.message}` };
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
      const parsed = JSON.parse(dataRes.text);
      if (!parsed || !parsed.stats || !Array.isArray(parsed.stocks)) {
        return { ok: false, error: 'Downloaded dataset JSON missing stats or stocks array' };
      }
      return {
        ok: true,
        unchanged: false,
        manifest,
        stats: parsed.stats,
        stocks: parsed.stocks
      };
    } catch (err) {
      return { ok: false, error: `Dataset JSON parse error: ${err.message}` };
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
      } else if (!currentRes.notFound && !options.force) {
        return { ok: false, error: `Cannot verify current latest.json state: ${currentRes.error}` };
      }

      const safeTimestamp = (stats.refreshedAtUtc || new Date().toISOString()).replace(/[:.]/g, '-');
      const versionId = `${stats.tradingDate}-${safeTimestamp}`;
      const datasetPath = `datasets/${stats.tradingDate}/stocks-dataset-${versionId}.json`;

      const storageStats = {
        ...stats,
        storageProvider: 'supabase',
        storageBucket: getCfg().bucket,
        storageVersionId: versionId
      };

      const datasetPayload = JSON.stringify({
        schemaVersion: 1,
        versionId,
        tradingDate: stats.tradingDate,
        refreshedAtUtc: stats.refreshedAtUtc,
        stats: storageStats,
        stocks
      });
      const checksum = sha256Hex(datasetPayload);

      // Phase 1: Upload immutable versioned dataset
      const uploadRes = await uploadObject(datasetPath, datasetPayload, {
        upsert: false,
        cacheControl: '31536000'
      });
      if (!uploadRes.ok) {
        return { ok: false, phase: 'upload_dataset', error: uploadRes.error };
      }

      // Phase 2: Read-back verification
      const verifyRes = await downloadObject(datasetPath);
      if (!verifyRes.ok) {
        return { ok: false, phase: 'verify_upload', error: `Read-back verification failed: ${verifyRes.error}` };
      }
      const readBackSha = sha256Hex(verifyRes.text);
      if (readBackSha !== checksum) {
        return {
          ok: false,
          phase: 'verify_checksum',
          error: `Uploaded dataset checksum mismatch (expected ${checksum}, got ${readBackSha}); latest.json NOT updated`
        };
      }
      const readBackParsed = JSON.parse(verifyRes.text);
      if (!Array.isArray(readBackParsed.stocks) || readBackParsed.stocks.length !== stocks.length) {
        return {
          ok: false,
          phase: 'verify_count',
          error: 'Uploaded dataset stock count mismatch; latest.json NOT updated'
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
        schemaVersion: 1,
        versionId,
        tradingDate: stats.tradingDate,
        nseSourceDate: stats.nseSourceDate || stats.tradingDate,
        bseSourceDate: stats.bseSourceDate || stats.tradingDate,
        refreshedAtUtc: stats.refreshedAtUtc,
        istDisplayTime: stats.istDisplayTime,
        totalStocks: stocks.length,
        pipelineVersion: stats.pipelineVersion || '2.0.0',
        datasetPath,
        sha256: checksum,
        bytes: Buffer.byteLength(datasetPayload, 'utf8'),
        publishedSessions,
        publishedSessionsComplete,
        previousVersion: previousManifest ? {
          versionId: previousManifest.versionId,
          tradingDate: previousManifest.tradingDate,
          datasetPath: previousManifest.datasetPath,
          sha256: previousManifest.sha256 || null
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

      // Phase 4: Non-fatal 30-trading-session retention cleanup
      let retention = null;
      if (!options.skipRetention) {
        try {
          retention = await pruneOldDatasets({
            latestManifest: manifestObj,
            retainSessions: options.retainSessions,
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
        sha256: checksum,
        bytes: Buffer.byteLength(datasetPayload, 'utf8'),
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
    pruneOldDatasets,
    fetchLatestManifest,
    fetchLatestDataset,
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
  DEFAULT_RETAIN_TRADING_SESSIONS,
  sha256Hex,
  isSafeDatasetPrunePath,
  getStorageConfigFromEnv,
  createStorageClient,
  ...defaultClient
};
