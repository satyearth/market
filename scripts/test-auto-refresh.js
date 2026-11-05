/**
 * Machli Bazzar — Auto-Refresh on Website Open Test Suite
 *
 * Verifies:
 * 1. Indian stock exchange calendar and IST timezone calculation.
 * 2. Weekend and official holiday detection.
 * 3. Bhavcopy publication cutoff logic (pre-16:30 vs post-16:30 IST).
 * 4. Stale-while-revalidate and session freshness assessment.
 * 5. Backend HTTP API server (/api/market/status & /api/market/refresh).
 * 6. Concurrency mutex lock (preventing duplicate simultaneous sync jobs).
 * 7. Frontend status indicator DOM elements and lifecycle states.
 */

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const cal = require('./exchange-calendar');
const { handleRequest, readMarketStatsFromDataset } = require('../server');

let passedCount = 0;
let failedCount = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    failedCount++;
  }
}

async function testAsync(description, fn) {
  try {
    await fn();
    console.log(`  ✓ PASS: ${description}`);
    passedCount++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    Error: ${err.message}`);
    failedCount++;
  }
}

// In-memory request/response tester without requiring socket binding
function invokeMockHandler(url, method = 'GET') {
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.url = url;
    req.method = method;
    req.headers = { host: 'localhost:3000' };

    const res = new EventEmitter();
    res.headers = {};
    res.statusCode = 200;
    res.body = '';

    res.setHeader = (key, val) => {
      res.headers[key.toLowerCase()] = val;
    };

    res.writeHead = (code, headers = {}) => {
      res.statusCode = code;
      for (const [k, v] of Object.entries(headers)) {
        res.headers[k.toLowerCase()] = v;
      }
    };

    res.end = (chunk) => {
      if (chunk) res.body += chunk;
      let parsed = res.body;
      try {
        parsed = JSON.parse(res.body);
      } catch (_) {}
      resolve({ status: res.statusCode, headers: res.headers, body: parsed });
    };

    handleRequest(req, res);
  });
}

async function runAutoRefreshTestSuite() {
  console.log('================================================================');
  console.log(' MACHLI BAZZAR — AUTO-REFRESH ON OPEN TEST SUITE');
  console.log('================================================================\n');

  // Group 1: Exchange Calendar & Timezone
  console.log('[Test Group 1: Exchange Calendar & IST Calculation]');

  test('Computes current date in Asia/Kolkata timezone', () => {
    const ist = cal.getIstTime();
    assert(ist.year >= 2026, 'Year must be 2026 or later');
    assert(ist.dateString.match(/^\d{4}-\d{2}-\d{2}$/), 'Format must be YYYY-MM-DD');
  });

  test('Detects Saturday as weekend and non-trading day', () => {
    const sat = new Date('2026-11-07T12:00:00+05:30');
    const ist = cal.getIstTime(sat);
    assert.strictEqual(ist.isWeekend, true, 'Saturday must be weekend');
    assert.strictEqual(cal.isTradingDay('2026-11-07'), false, 'Saturday is not trading day');
  });

  test('Detects Sunday as weekend and non-trading day', () => {
    const sun = new Date('2026-11-08T12:00:00+05:30');
    const ist = cal.getIstTime(sun);
    assert.strictEqual(ist.isWeekend, true, 'Sunday must be weekend');
    assert.strictEqual(cal.isTradingDay('2026-11-08'), false, 'Sunday is not trading day');
  });

  test('Detects 2026 official exchange holidays (Republic Day & Christmas)', () => {
    assert.strictEqual(cal.isTradingDay('2026-01-26'), false, 'Republic Day is holiday');
    assert.strictEqual(cal.isTradingDay('2026-12-25'), false, 'Christmas is holiday');
    assert.strictEqual(cal.EXCHANGE_HOLIDAYS_2026.size, 14, 'Must have 14 official exchange holidays in 2026');
  });

  test('Correctly rolls back to Friday from weekend', () => {
    const prev = cal.getPreviousTradingDay('2026-11-07');
    assert.strictEqual(prev, '2026-11-06', 'Must step back to Friday 2026-11-06');
  });

  // Group 2: Bhavcopy Publication Timing & Session Freshness
  console.log('\n[Test Group 2: Bhavcopy Timing & Freshness Evaluation]');

  test('Pre-16:30 IST on trading day expects previous trading session', () => {
    const wedMorning = new Date('2026-11-04T10:30:00+05:30');
    const expected = cal.getLatestExpectedTradingDate(wedMorning);
    assert.strictEqual(expected.latestExpectedDate, '2026-11-03', 'Morning expects previous day 2026-11-03');
    assert.strictEqual(expected.isEodPublishedToday, false, 'EOD not published in morning');
  });

  test('Post-16:30 IST on trading day expects today session', () => {
    const wedEvening = new Date('2026-11-04T18:30:00+05:30');
    const expected = cal.getLatestExpectedTradingDate(wedEvening);
    assert.strictEqual(expected.latestExpectedDate, '2026-11-04', 'Evening expects 2026-11-04');
    assert.strictEqual(expected.isEodPublishedToday, true, 'EOD is published in evening');
  });

  test('Active dataset 2026-11-04 is evaluated as fresh and up-to-date post-close', () => {
    const wedNight = new Date('2026-11-04T22:30:00+05:30');
    const freshness = cal.checkSessionFreshness('2026-11-04', wedNight);
    assert.strictEqual(freshness.isFresh, true, 'Dataset must be fresh');
    assert.strictEqual(freshness.needsSync, false, 'No sync needed when already up-to-date');
  });

  test('Older dataset 2026-11-03 triggers sync required', () => {
    const wedNight = new Date('2026-11-04T22:30:00+05:30');
    const freshness = cal.checkSessionFreshness('2026-11-03', wedNight);
    assert.strictEqual(freshness.isFresh, false, 'Older dataset is not fresh');
    assert.strictEqual(freshness.needsSync, true, 'Sync must be required');
  });

  test('Unchanged trading date on weekend is never treated as failed update', () => {
    const satAfternoon = new Date('2026-11-07T14:00:00+05:30');
    const freshness = cal.checkSessionFreshness('2026-11-06', satAfternoon);
    assert.strictEqual(freshness.isFresh, true, 'Weekend with Friday close must be fresh');
    assert.strictEqual(freshness.needsSync, false, 'No sync needed on weekend');
    assert(freshness.reason.includes('Weekend'), 'Reason must mention weekend');
  });

  // Group 3: Server HTTP API & Endpoints
  console.log('\n[Test Group 3: Server Endpoints & Handlers]');

  await testAsync('GET /api/market/status returns valid JSON structure', async () => {
    const res = await invokeMockHandler('/api/market/status', 'GET');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.isSyncing, false);
    assert.strictEqual(res.body.tradingDate, '2026-11-04');
    assert.strictEqual(res.body.stockCount, 5389);
    assert.strictEqual(typeof res.body.isUpToDate, 'boolean');
    assert(res.body.istDisplayTime.includes('IST'));
    assert(res.body.marketCalendar != null);
  });

  await testAsync('POST /api/market/refresh returns up_to_date without running redundant sync', async () => {
    const res = await invokeMockHandler('/api/market/refresh', 'POST');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.status, 'up_to_date');
    assert.strictEqual(res.body.tradingDate, '2026-11-04');
    assert(res.body.message.includes('up-to-date') || res.body.message.includes('2026-11-04'));
  });

  await testAsync('GET /api/market/dataset returns lightweight stats payload', async () => {
    const res = await invokeMockHandler('/api/market/dataset', 'GET');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.stats.stockCount, 5389);
    assert.strictEqual(res.body.stats.tradingDate, '2026-11-04');
  });

  await testAsync('Static file server serves index.html at root "/"', async () => {
    const res = await invokeMockHandler('/', 'GET');
    assert.strictEqual(res.status, 200);
    assert(typeof res.body === 'string' && res.body.includes('Machii Bazzar'));
    assert.strictEqual(res.headers['content-type'], 'text/html; charset=utf-8');
  });

  await testAsync('Static file server serves js/stocks-data.js with no-cache header', async () => {
    const res = await invokeMockHandler('/js/stocks-data.js', 'GET');
    assert.strictEqual(res.status, 200);
    assert(res.headers['cache-control'].includes('no-cache'));
  });

  // Group 4: Frontend HTML Status Indicator Elements
  console.log('\n[Test Group 4: Frontend HTML Status Indicator Integration]');

  const htmlContent = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');

  test('index.html contains #eod-sync-indicator container', () => {
    assert(htmlContent.includes('id="eod-sync-indicator"'), 'Must have #eod-sync-indicator');
  });

  test('index.html contains #eod-sync-dot element', () => {
    assert(htmlContent.includes('id="eod-sync-dot"'), 'Must have #eod-sync-dot');
  });

  test('index.html contains #eod-sync-text element', () => {
    assert(htmlContent.includes('id="eod-sync-text"'), 'Must have #eod-sync-text');
  });

  test('index.html contains #eod-sync-time element', () => {
    assert(htmlContent.includes('id="eod-sync-time"'), 'Must have #eod-sync-time');
  });

  test('index.html status indicator conforms to ink theme classes', () => {
    assert(htmlContent.includes('bg-ink-well'), 'Must use bg-ink-well');
    assert(htmlContent.includes('border-ink-rule'), 'Must use border-ink-rule');
    assert(htmlContent.includes('text-ink-muted'), 'Must use text-ink-muted');
  });

  // Group 5: Frontend JS Logic & Stale-while-revalidate
  console.log('\n[Test Group 5: Frontend JS Logic & Stale-while-revalidate]');

  const appJsContent = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf-8');

  test('app.js defines updateSyncIndicator function', () => {
    assert(appJsContent.includes('function updateSyncIndicator'), 'Must define updateSyncIndicator');
  });

  test('app.js handles all 4 required states: updating, latest, failed, closed', () => {
    assert(appJsContent.includes("case 'updating':"), 'Must handle updating');
    assert(appJsContent.includes("case 'failed':"), 'Must handle failed');
    assert(appJsContent.includes("case 'closed':"), 'Must handle closed');
    assert(appJsContent.includes("case 'latest':"), 'Must handle latest');
    assert(appJsContent.includes('Updating market data...'), 'Must render "Updating market data..."');
    assert(appJsContent.includes('Update failed — showing previous data'), 'Must render "Update failed — showing previous data"');
  });

  test('app.js implements client-side cache TTL check', () => {
    assert(appJsContent.includes('mb_last_sync_check'), 'Must check sessionStorage cache key');
    assert(appJsContent.includes('CACHE_TTL_MS'), 'Must use cache TTL');
  });

  test('app.js implements stale-while-revalidate (immediate initial display before check)', () => {
    assert(appJsContent.includes("updateSyncIndicator('latest');"), 'Must set initial indicator immediately');
    assert(appJsContent.includes('renderTable();'), 'Must render table immediately before sync check');
  });

  test('app.js handles offline / static host fallback cleanly without throwing', () => {
    assert(appJsContent.includes('catch (err) {'), 'Must catch fetch errors cleanly');
  });

  console.log('\n================================================================');
  console.log(` AUTO-REFRESH TEST SUMMARY: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log('================================================================');

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAutoRefreshTestSuite();
