'use strict';

/**
 * Hardened Local Development & E2E API Server
 *
 * Implements:
 * - Allowlisted static asset serving (HTML, CSS, client JS only; blocks traversal, scripts, env, downloads)
 * - Strict HTTP method guards matching Vercel serverless endpoints (405 JSON)
 * - GET /api/health, GET /api/stocks, GET /api/market/status, GET /api/market/dataset
 * - Concurrency-locked POST /api/market/refresh spawning scripts/refresh.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ROOT_DIR, TARGET_DATA_PATH } = require('../config/constants');
const { checkSessionFreshness, getLatestExpectedTradingDate } = require('../calendar/exchange-calendar');
const { inspectStoredSessions } = require('../ingestion/bhavcopy-downloader');
const {
  queryStocksAsync,
  loadMarketStatsAsync,
  queryStockHistoryAsync,
  readLocalStatsSafe
} = require('../query/stock-query-service');
const storage = require('../storage/supabase-storage');
const {
  applySecurityHeaders,
  getClientIp,
  sharedStocksRateLimiter,
  sharedRefreshRateLimiter,
  authorizeRefreshRequest,
  LOCAL_ORIGIN_RE
} = require('./security-utils');

const PORT = process.env.PORT || 8080;

let isSyncing = false;
let syncStartedAt = null;
let lastSyncResult = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const ALLOWED_STATIC_PATHS = new Set([
  '/index.html',
  '/stock.html',
  '/css/style.css',
  '/css/page-layout.css',
  '/css/stock-details.css',
  '/js/app.js',
  '/js/stock-details.js',
  '/js/company-logo.js',
  '/js/company-logo-manifest.js',
  '/js/stocks-data.js'
]);

function readMarketStatsFromDataset() {
  return readLocalStatsSafe(TARGET_DATA_PATH);
}

function triggerSyncJob(customDate = null) {
  return new Promise((resolve) => {
    if (isSyncing) {
      return resolve({
        ok: true,
        status: 'in_progress',
        message: 'Sync job is already in progress',
        startedAt: syncStartedAt
      });
    }

    isSyncing = true;
    syncStartedAt = new Date().toISOString();

    const refreshScript = path.join(ROOT_DIR, 'scripts', 'refresh.js');
    const spawnArgs = [refreshScript, '--latest'];
    if (customDate && /^\d{4}-\d{2}-\d{2}$/.test(customDate)) {
      spawnArgs[1] = `--date=${customDate}`;
    }

    const child = spawn(process.execPath, spawnArgs, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (code) => {
      isSyncing = false;
      const completedAt = new Date().toISOString();
      if (code === 0) {
        const freshStats = readMarketStatsFromDataset();
        lastSyncResult = {
          ok: true,
          status: 'updated',
          tradingDate: freshStats?.tradingDate,
          istDisplayTime: freshStats?.istDisplayTime,
          completedAt
        };
        resolve(lastSyncResult);
      } else {
        const currentStats = readMarketStatsFromDataset();
        lastSyncResult = {
          ok: false,
          status: 'failed',
          error: stderr.slice(-300) || `Process exited with code ${code}`,
          showingPrevious: true,
          tradingDate: currentStats?.tradingDate,
          istDisplayTime: currentStats?.istDisplayTime,
          completedAt
        };
        resolve(lastSyncResult);
      }
    });

    child.on('error', (err) => {
      isSyncing = false;
      const currentStats = readMarketStatsFromDataset();
      lastSyncResult = {
        ok: false,
        status: 'failed',
        error: err.message,
        showingPrevious: true,
        tradingDate: currentStats?.tradingDate,
        istDisplayTime: currentStats?.istDisplayTime
      };
      resolve(lastSyncResult);
    });
  });
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  applySecurityHeaders(res);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload, null, 2));
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Refresh-Secret');
}

async function handleRequest(req, res) {
  applySecurityHeaders(res);

  let parsedUrl;
  try {
    parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: 'Malformed request URL.' });
  }

  let pathname = parsedUrl.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return res.end('Bad Request');
  }

  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (pathname === '/api/health') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    try {
      const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync();
      const tradingDate = stats?.tradingDate || null;
      const freshness = checkSessionFreshness(tradingDate);
      return sendJson(res, stats ? 200 : 503, {
        ok: Boolean(stats),
        status: stats ? (freshness.isFresh ? 'healthy' : freshness.freshnessStatus) : 'degraded',
        tradingDate,
        stockCount: stats?.stockCount || stats?.totalStocks || null,
        isUpToDate: freshness.isFresh,
        freshnessStatus: freshness.freshnessStatus,
        storageSource,
        storageVersionId,
        storageConfigured: {
          read: storage.isReadConfigured(),
          write: storage.isWriteConfigured()
        },
        timestampUtc: new Date().toISOString()
      });
    } catch (err) {
      console.error('Local /api/health error:', err);
      return sendJson(res, 500, { ok: false, status: 'error', error: 'Unable to determine server health.' });
    }
  }

  if (pathname === '/api/stocks') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    const rate = sharedStocksRateLimiter.check(getClientIp(req));
    const rateHeaders = {
      'X-RateLimit-Limit': String(rate.limit),
      'X-RateLimit-Remaining': String(rate.remaining)
    };
    if (!rate.allowed) {
      return sendJson(
        res,
        429,
        { ok: false, error: 'Too many requests. Please slow down and try again shortly.' },
        { ...rateHeaders, 'Retry-After': String(rate.retryAfterSec) }
      );
    }
    try {
      const payload = await queryStocksAsync(Object.fromEntries(parsedUrl.searchParams.entries()));
      if (!payload.ok) {
        return sendJson(res, payload.statusCode || 400, { ok: false, error: payload.error || 'Invalid query parameters.' }, rateHeaders);
      }
      return sendJson(res, 200, payload, rateHeaders);
    } catch (err) {
      console.error('Stock page query failed:', err);
      return sendJson(res, 500, { ok: false, error: 'Unable to load stocks right now.' }, rateHeaders);
    }
  }

  if (pathname === '/api/market/status') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    try {
      const { stats, manifest, storageSource, storageVersionId } = await loadMarketStatsAsync();
      const currentTradingDate = stats?.tradingDate || null;
      const freshness = checkSessionFreshness(currentTradingDate);
      const stored = inspectStoredSessions();

      return sendJson(res, 200, {
        ok: true,
        canTriggerSync: true,
        isSyncing,
        syncStartedAt,
        lastSyncResult,
        tradingDate: currentTradingDate,
        istDisplayTime: stats?.istDisplayTime || null,
        refreshedAtUtc: stats?.refreshedAtUtc || null,
        nseSourceDate: stats?.nseSourceDate || currentTradingDate,
        bseSourceDate: stats?.bseSourceDate || currentTradingDate,
        stockCount: stats?.stockCount || stats?.totalStocks || null,
        pipelineVersion: stats?.pipelineVersion || null,
        storageSource,
        storageVersionId,
        historicalDataset: manifest?.historicalDataset || stats?.historicalDataset || null,
        isUpToDate: freshness.isFresh,
        needsSync: freshness.needsSync,
        freshnessStatus: freshness.freshnessStatus,
        isDelayed: freshness.isDelayed,
        isStale: freshness.isStale,
        missingSessionsCount: freshness.missingSessionsCount,
        latestExpectedDate: freshness.latestExpectedDate,
        latestDownloadedDate: stored.latestCompleteDate || stats?.pipelineDates?.latestDownloadedDate || currentTradingDate,
        latestProcessedDate: stats?.pipelineDates?.latestProcessedDate || currentTradingDate,
        latestPublishedDate: currentTradingDate,
        reason: freshness.reason,
        calendarVerified: freshness.calendarVerified,
        calendarWarning: freshness.calendarWarning,
        marketCalendar: getLatestExpectedTradingDate(),
        changeLogSummary: stats?.changeLogSummary || null
      });
    } catch (err) {
      console.error('Local /api/market/status error:', err);
      return sendJson(res, 500, { ok: false, error: 'Unable to check market status.' });
    }
  }

  if (pathname === '/api/market/refresh') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, status: 'method_not_allowed', error: 'Method not allowed.' }, { Allow: 'POST' });
    }
    const auth = authorizeRefreshRequest(req, {
      requireSecret: process.env.NODE_ENV === 'production'
    });
    if (!auth.ok) {
      const statusLabel = auth.statusCode === 503
        ? 'misconfigured'
        : (auth.statusCode === 401 ? 'unauthorized' : 'forbidden');
      return sendJson(res, auth.statusCode, {
        ok: false,
        status: statusLabel,
        error: auth.error
      });
    }
    const rate = sharedRefreshRateLimiter.check(getClientIp(req));
    const rateHeaders = {
      'X-RateLimit-Limit': String(rate.limit),
      'X-RateLimit-Remaining': String(rate.remaining)
    };
    if (!rate.allowed) {
      return sendJson(
        res,
        429,
        { ok: false, status: 'rate_limited', error: 'Too many refresh requests. Please try again shortly.' },
        { ...rateHeaders, 'Retry-After': String(rate.retryAfterSec) }
      );
    }

    try {
      if (isSyncing) {
        const { stats } = await loadMarketStatsAsync();
        return sendJson(res, 202, {
          ok: true,
          status: 'in_progress',
          message: 'Synchronization is already running in background.',
          tradingDate: stats?.tradingDate || null,
          startedAt: syncStartedAt
        }, rateHeaders);
      }

      const { stats } = await loadMarketStatsAsync({ force: true });
      const currentTradingDate = stats?.tradingDate || null;
      const freshness = checkSessionFreshness(currentTradingDate);

      if (freshness.isFresh) {
        return sendJson(res, 200, {
          ok: true,
          status: 'up_to_date',
          message: freshness.reason,
          tradingDate: currentTradingDate,
          istDisplayTime: stats?.istDisplayTime || null
        }, rateHeaders);
      }

      const requestedDate = parsedUrl.searchParams.get('date');
      if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return sendJson(res, 400, { ok: false, status: 'invalid_date', error: 'Parameter "date" must be in YYYY-MM-DD format.' }, rateHeaders);
      }

      triggerSyncJob(requestedDate).catch((syncErr) => {
        console.error('Background sync job error:', syncErr);
      });

      return sendJson(res, 202, {
        ok: true,
        status: 'accepted',
        message: 'Market synchronization accepted and running in background.',
        tradingDate: currentTradingDate,
        istDisplayTime: stats?.istDisplayTime || null,
        startedAt: syncStartedAt
      }, rateHeaders);
    } catch (err) {
      console.error('Local /api/market/refresh error:', err);
      return sendJson(res, 500, { ok: false, status: 'error', error: 'Unable to trigger market synchronization.' }, rateHeaders);
    }
  }

  if (pathname === '/api/market/dataset') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    try {
      const { stats, manifest, storageSource, storageVersionId } = await loadMarketStatsAsync();
      if (!stats) {
        return sendJson(res, 404, { ok: false, error: 'Dataset not found' });
      }
      return sendJson(res, 200, {
        ok: true,
        stats,
        freshness: checkSessionFreshness(stats.tradingDate || null),
        storageSource,
        storageVersionId,
        historicalDataset: manifest?.historicalDataset || stats?.historicalDataset || null,
        isSyncing
      });
    } catch (err) {
      console.error('Local /api/market/dataset error:', err);
      return sendJson(res, 500, { ok: false, error: 'Unable to load market dataset metadata.' });
    }
  }

  if (pathname === '/api/market/history') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    try {
      const payload = await queryStockHistoryAsync(Object.fromEntries(parsedUrl.searchParams.entries()));
      if (!payload.ok) {
        return sendJson(res, payload.statusCode || 400, { ok: false, error: payload.error });
      }
      return sendJson(res, 200, payload);
    } catch (err) {
      console.error('Local /api/market/history error:', err);
      return sendJson(res, 500, { ok: false, error: 'Unable to load historical price data.' });
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { ok: false, error: 'API endpoint not found' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
    return res.end('Method Not Allowed');
  }

  const normalizedStatic = pathname === '/' ? '/index.html' : pathname;
  if (!ALLOWED_STATIC_PATHS.has(normalizedStatic)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  const rootWithSep = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : ROOT_DIR + path.sep;
  const resolvedPath = path.resolve(ROOT_DIR, `.${normalizedStatic}`);
  if (!resolvedPath.startsWith(rootWithSep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  if (!fs.existsSync(resolvedPath) || fs.statSync(resolvedPath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(resolvedPath, (err, content) => {
    if (err) {
      console.error('Static asset read error:', err);
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end('Internal Server Error');
    }
    res.setHeader(
      'Cache-Control',
      normalizedStatic.includes('stocks-data.js') ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600'
    );
    res.writeHead(200, { 'Content-Type': contentType });
    if (req.method === 'HEAD') {
      return res.end();
    }
    res.end(content);
  });
}

function createAppServer() {
  return http.createServer((req, res) => {
    Promise.resolve(handleRequest(req, res)).catch((err) => {
      console.error('Unhandled request error:', err);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'Internal server error.' });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}

function startBackgroundScheduler() {
  return setInterval(async () => {
    try {
      const { stats } = await loadMarketStatsAsync();
      const currentTradingDate = stats?.tradingDate || null;
      const freshness = checkSessionFreshness(currentTradingDate);
      if (freshness.needsSync && !isSyncing) {
        console.log('[Auto-Sync Scheduler] New exchange session detected. Triggering automated EOD sync...');
        triggerSyncJob();
      }
    } catch (err) {
      console.warn('[Auto-Sync Scheduler] Session freshness check notice:', err.message);
    }
  }, 10 * 60 * 1000);
}

module.exports = {
  PORT,
  ALLOWED_STATIC_PATHS,
  createAppServer,
  handleRequest,
  readMarketStatsFromDataset,
  triggerSyncJob,
  startBackgroundScheduler,
  getSyncState: () => ({ isSyncing, syncStartedAt, lastSyncResult })
};
