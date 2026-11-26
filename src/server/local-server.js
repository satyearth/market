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
const { queryStocksAsync, loadMarketStatsAsync } = require('../query/stock-query-service');
const storage = require('../storage/supabase-storage');

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
  '/js/stocks-data.js',
  '/js/logo-aliases.js'
]);

function readMarketStatsFromDataset() {
  try {
    if (!fs.existsSync(TARGET_DATA_PATH)) return null;
    const content = fs.readFileSync(TARGET_DATA_PATH, 'utf8');
    const match = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
    return match ? JSON.parse(match[1]) : null;
  } catch (err) {
    console.error('Error reading MARKET_STATS from dataset:', err.message);
    return null;
  }
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
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload, null, 2));
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
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
      return sendJson(res, 500, { ok: false, status: 'error', error: err.message });
    }
  }

  if (pathname === '/api/stocks') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    try {
      const payload = await queryStocksAsync(Object.fromEntries(parsedUrl.searchParams.entries()));
      return sendJson(res, 200, payload);
    } catch (err) {
      console.error('Stock page query failed:', err.message);
      return sendJson(res, 500, { ok: false, error: 'Unable to load stocks right now.' });
    }
  }

  if (pathname === '/api/market/status') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync();
    const currentTradingDate = stats?.tradingDate || null;
    const freshness = checkSessionFreshness(currentTradingDate);
    const stored = inspectStoredSessions();

    return sendJson(res, 200, {
      ok: true,
      canTriggerSync: true,
      isSyncing,
      syncStartedAt,
      tradingDate: currentTradingDate,
      istDisplayTime: stats?.istDisplayTime || null,
      refreshedAtUtc: stats?.refreshedAtUtc || null,
      nseSourceDate: stats?.nseSourceDate || currentTradingDate,
      bseSourceDate: stats?.bseSourceDate || currentTradingDate,
      stockCount: stats?.stockCount || stats?.totalStocks || null,
      pipelineVersion: stats?.pipelineVersion || null,
      storageSource,
      storageVersionId,
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
      marketCalendar: getLatestExpectedTradingDate(),
      changeLogSummary: stats?.changeLogSummary || null
    });
  }

  if (pathname === '/api/market/refresh') {
    if (req.method !== 'POST') {
      return sendJson(res, 405, { ok: false, status: 'method_not_allowed', error: 'Method not allowed.' }, { Allow: 'POST' });
    }
    if (isSyncing) {
      const { stats } = await loadMarketStatsAsync();
      return sendJson(res, 200, {
        ok: true,
        status: 'in_progress',
        message: 'Synchronization is already running in background',
        tradingDate: stats?.tradingDate,
        startedAt: syncStartedAt
      });
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
        istDisplayTime: stats?.istDisplayTime
      });
    }

    const requestedDate = parsedUrl.searchParams.get('date');
    const syncOutcome = await triggerSyncJob(requestedDate);
    return sendJson(res, syncOutcome.ok ? 200 : 500, syncOutcome);
  }

  if (pathname === '/api/market/dataset') {
    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' }, { Allow: 'GET' });
    }
    const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync();
    if (!stats) {
      return sendJson(res, 404, { ok: false, error: 'Dataset not found' });
    }
    return sendJson(res, 200, {
      ok: true,
      stats,
      freshness: checkSessionFreshness(stats.tradingDate || null),
      storageSource,
      storageVersionId,
      isSyncing
    });
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
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end(`Server Error: ${err.message}`);
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
  return http.createServer(handleRequest);
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
