/**
 * Machli Bazzar — Lightweight EOD Sync & API Server (server.js)
 *
 * Implements:
 * 1. Minimal zero-dependency Node.js HTTP server.
 * 2. Static asset serving (index.html, js, css, assets, downloads).
 * 3. GET /api/market/status: Dataset status, trading session, and market calendar info.
 * 4. POST /api/market/refresh: Concurrency-locked EOD sync trigger with holiday/weekend awareness.
 * 5. GET /api/market/dataset: Latest dataset payload for hot-reloading.
 * 6. Stale-while-revalidate guarantees: Previous valid dataset is always served.
 * 7. Mutex lock preventing duplicate simultaneous sync jobs across multiple visitors.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { checkSessionFreshness, getLatestExpectedTradingDate, getIstTime } = require('./scripts/exchange-calendar');

const PORT = process.env.PORT || 8080;
const ROOT_DIR = __dirname;
const STOCKS_DATA_PATH = path.join(ROOT_DIR, 'js', 'stocks-data.js');

// Mutex lock for sync execution
let isSyncing = false;
let syncStartedAt = null;
let lastSyncResult = null;

// MIME type map for static asset serving
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8'
};

/**
 * Extracts MARKET_STATS from js/stocks-data.js without loading the entire 5,389 array into VM
 */
function readMarketStatsFromDataset() {
  try {
    if (!fs.existsSync(STOCKS_DATA_PATH)) return null;
    const content = fs.readFileSync(STOCKS_DATA_PATH, 'utf-8');
    const match = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
    if (!match) return null;
    // Safely parse the stats JSON object directly without eval
    return JSON.parse(match[1]);
  } catch (err) {
    console.error('Error reading MARKET_STATS from dataset:', err.message);
    return null;
  }
}

/**
 * Executes scripts/sync-stock-universe.js with mutex lock protection
 */
function triggerSyncJob() {
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
    console.log(`[Auto-Refresh Engine] Sync job triggered at ${syncStartedAt}...`);

    const syncScript = path.join(ROOT_DIR, 'scripts', 'sync-stock-universe.js');
    const child = spawn(process.execPath, [syncScript], {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);

    child.on('close', (code) => {
      isSyncing = false;
      const completedAt = new Date().toISOString();

      if (code === 0) {
        console.log(`[Auto-Refresh Engine] Sync job completed successfully at ${completedAt}`);
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
        console.error(`[Auto-Refresh Engine] Sync job failed (code ${code}):`, stderr.slice(-300));
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
      console.error('[Auto-Refresh Engine] Failed to spawn sync job:', err.message);
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

/**
 * HTTP Request Handler
 */
async function handleRequest(req, res) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Set CORS headers for local/cross-origin development
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 1. API: GET /api/market/status
  if (pathname === '/api/market/status' && req.method === 'GET') {
    const stats = readMarketStatsFromDataset();
    const currentTradingDate = stats?.tradingDate || '2026-11-04';
    const freshness = checkSessionFreshness(currentTradingDate);

    const payload = {
      ok: true,
      isSyncing,
      syncStartedAt,
      tradingDate: currentTradingDate,
      istDisplayTime: stats?.istDisplayTime,
      refreshedAtUtc: stats?.refreshedAtUtc,
      stockCount: stats?.stockCount || 5389,
      isUpToDate: freshness.isFresh,
      needsSync: freshness.needsSync,
      reason: freshness.reason,
      marketCalendar: getLatestExpectedTradingDate(),
      changeLogSummary: stats?.changeLogSummary || null
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(payload, null, 2));
  }

  // 2. API: POST or GET /api/market/refresh
  if (pathname === '/api/market/refresh' && (req.method === 'POST' || req.method === 'GET')) {
    // Check if sync already running (Requirement 8: prevent multiple visitors triggering simultaneous jobs)
    if (isSyncing) {
      const stats = readMarketStatsFromDataset();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        status: 'in_progress',
        message: 'Synchronization is already running in background',
        tradingDate: stats?.tradingDate,
        startedAt: syncStartedAt
      }));
    }

    // Check session freshness
    const stats = readMarketStatsFromDataset();
    const currentTradingDate = stats?.tradingDate || '2026-11-04';
    const freshness = checkSessionFreshness(currentTradingDate);

    // If up-to-date, avoid redundant sync (Requirement 2 & 10)
    if (freshness.isFresh) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        status: 'up_to_date',
        message: freshness.reason,
        tradingDate: currentTradingDate,
        istDisplayTime: stats?.istDisplayTime
      }));
    }

    // A newer exchange session is expected: trigger sync engine
    const syncOutcome = await triggerSyncJob();
    res.writeHead(syncOutcome.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(syncOutcome));
  }

  // 3. API: GET /api/market/dataset (Returns lightweight stats & timestamp)
  if (pathname === '/api/market/dataset' && req.method === 'GET') {
    const stats = readMarketStatsFromDataset();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      stats,
      isSyncing
    }));
  }

  // 4. Static File Serving
  let filePath = path.join(ROOT_DIR, pathname === '/' ? 'index.html' : pathname);

  // Security: Prevent directory traversal outside ROOT_DIR
  if (!filePath.startsWith(ROOT_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  // Check if file exists
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(ROOT_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      return res.end(`Server Error: ${err.message}`);
    }

    // Cache-Control headers: scripts and data no-cache for freshness check
    if (pathname.includes('stocks-data.js') || pathname.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

const server = http.createServer(handleRequest);

// Start listening if run directly
if (require.main === module) {
  server.listen(PORT, () => {
    console.log('================================================================');
    console.log(` MACHLI BAZZAR — SERVER READY ON http://localhost:${PORT}`);
    console.log(' - EOD Auto-Refresh API : http://localhost:' + PORT + '/api/market/status');
    console.log(' - Refresh Endpoint     : http://localhost:' + PORT + '/api/market/refresh');
    console.log('================================================================');
  });
}

module.exports = server;
module.exports.server = server;
module.exports.handleRequest = handleRequest;
module.exports.readMarketStatsFromDataset = readMarketStatsFromDataset;
module.exports.triggerSyncJob = triggerSyncJob;
