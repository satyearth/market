'use strict';

/**
 * Machii Bazzar — Comprehensive Pipeline Automated Test Suite (scripts/test-pipeline.js)
 *
 * Uses mocked HTTP transports, synthetic PKZIP/CSV fixtures, and isolated temp
 * directories (zero dependency on live NSE/BSE endpoints; never mutates prod data).
 *
 * Covers all required scenarios:
 *  1. Normal successful NSE (ZIP) + BSE (CSV) downloads
 *  2. Missing NSE file (404)
 *  3. Missing BSE file (404 AND deceptive HTTP 200 HTML error page)
 *  4. Exchange holiday handling (2026-11-10, 2026-11-24) + special Muhurat Sunday (2026-11-08)
 *  5. Weekend handling (Saturday & regular Sunday)
 *  6. Delayed BhavCopy publication (bounded polling retries & recovery)
 *  7. HTTP 403 and HTTP 429 (exponential backoff & Retry-After)
 *  8. Network timeout recovery
 *  9. Corrupted CSV & corrupted ZIP rejection
 * 10. Empty CSV rejection
 * 11. Invalid trading date & internal CSV date mismatch rejection
 * 12. Duplicate symbols (multi-ISIN disambiguation vs same-exchange diagnostic) & duplicate ISIN guard
 * 13. Partial pipeline failure (retains previous valid dataset untouched)
 * 14. Historical backfill across missing sessions (respects holidays/weekends, 6-session sparklines)
 * 15. Atomic publishing (temp write -> validate -> rename; failure cleans temp & preserves target)
 * 16. Older data attempting to overwrite newer data (refused)
 * 17. Recovery after interrupted execution (cleans .tmp files & resumes backfill idempotently)
 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// Guarantee the automated pipeline test suite never picks up real production
// Supabase credentials from the host shell when loading default singletons.
const ORIGINAL_SUPABASE_ENV = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET
};
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_STORAGE_BUCKET;

const cal = require('../src/calendar/exchange-calendar');
const {
  createDownloader,
  validateBhavcopyCsvContent,
  getNseFilename,
  getBseFilename,
  getIndicesFilename,
  get52WeekFilename
} = require('./download-bhavcopy');
const {
  syncUniverse,
  validateMergedDataset
} = require('./sync-stock-universe');
const { runRefresh } = require('./refresh');
const { createStorageClient, isSafeDatasetPrunePath } = require('../src/storage/supabase-storage');
const { expandHistoricalPricesForIsin } = require('../src/storage/historical-store');
const {
  loadDatasetAsync,
  loadMarketStatsAsync,
  queryStocksAsync,
  queryStockHistoryAsync,
  resetCacheForTests
} = require('../src/query/stock-query-service');

let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    ${err.stack || err.message}`);
  }
}

function makeTempWorkspace(prefix = 'mb-test-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const downloadsDir = path.join(root, 'downloads');
  const jsDir = path.join(root, 'js');
  fs.mkdirSync(downloadsDir, { recursive: true });
  fs.mkdirSync(jsDir, { recursive: true });
  return {
    root,
    downloadsDir,
    targetPath: path.join(jsDir, 'stocks-data.js'),
    backupPath: path.join(jsDir, 'stocks-data.backup.js'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

/**
 * Builds a minimal valid PKZIP Buffer containing a single deflated file (handles standard extractCsvFromZipBuffer).
 */
function buildZipBuffer(filename, contentStr) {
  const data = Buffer.from(contentStr, 'utf8');
  const compressed = zlib.deflateRawSync(data);
  const fnBuf = Buffer.from(filename, 'utf8');

  // Local file header (30 bytes + filename)
  const localHeader = Buffer.alloc(30 + fnBuf.length);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8); // deflate
  localHeader.writeUInt32LE(0, 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(data.length, 22);
  localHeader.writeUInt16LE(fnBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);
  fnBuf.copy(localHeader, 30);

  const cdOffset = localHeader.length + compressed.length;

  // Central directory header (46 bytes + filename)
  const cdHeader = Buffer.alloc(46 + fnBuf.length);
  cdHeader.writeUInt32LE(0x02014b50, 0);
  cdHeader.writeUInt16LE(20, 4);
  cdHeader.writeUInt16LE(20, 6);
  cdHeader.writeUInt16LE(0, 8);
  cdHeader.writeUInt16LE(8, 10);
  cdHeader.writeUInt32LE(compressed.length, 20);
  cdHeader.writeUInt32LE(data.length, 24);
  cdHeader.writeUInt16LE(fnBuf.length, 28);
  cdHeader.writeUInt32LE(0, 42); // local header offset = 0
  fnBuf.copy(cdHeader, 46);

  // End of Central Directory (22 bytes)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdHeader.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([localHeader, compressed, cdHeader, eocd]);
}

function buildBhavcopyCsv(exchange, dateStr, extraRows = [], padRows = 12) {
  const header = 'TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4';
  const series = exchange === 'NSE' ? 'EQ' : 'A';
  const baseRows = [
    `${dateStr},${dateStr},CM,${exchange},STK,1001,INE002A01018,RELIANCE,${series},,,,,RELIANCE INDUSTRIES LTD,1300.00,1325.00,1295.00,1320.00,1320.00,1310.00,,1320.00,,,1500000,1980000000,20000,F1,1,,,,,`,
    `${dateStr},${dateStr},CM,${exchange},STK,1002,INE467B01029,TCS,${series},,,,,TATA CONSULTANCY SERVICES LTD,4100.00,4150.00,4080.00,4140.00,4140.00,4110.00,,4140.00,,,500000,2070000000,8000,F1,1,,,,,`,
    // Two distinct ISINs sharing ticker GSTL (real-world scenario)
    `${dateStr},${dateStr},CM,${exchange},STK,1003,INE632W01016,GSTL,${series},,,,,GLOBALSPACE TECHNOLOGIES LTD,25.00,26.00,24.50,25.50,25.50,25.00,,25.50,,,10000,255000,50,F1,1,,,,,`
  ];
  if (exchange === 'BSE') {
    baseRows.push(`${dateStr},${dateStr},CM,BSE,STK,543001,INE00WS01056,GSTL,B,,,,,GLOBE SECURE TECHNOLOGIES LTD,40.00,42.00,39.00,41.00,41.00,40.00,,41.00,,,12000,492000,40,F1,1,,,,,`);
  }
  for (let i = 0; i < padRows; i++) {
    const code = String(2000 + i);
    const isin = `INE${String(900 + i).padStart(3, '0')}A0101${i % 10}`;
    baseRows.push(`${dateStr},${dateStr},CM,${exchange},STK,${code},${isin},TEST${i},${series},,,,,TEST COMPANY ${i} LTD,100.00,105.00,99.00,102.00,102.00,100.00,,102.00,,,1000,102000,10,F1,1,,,,,`);
  }
  return [header, ...baseRows, ...extraRows].join('\n') + '\n';
}

function buildIndicesCsv(dateStr, vix = 17.67, chgPct = -0.16) {
  const [y, m, d] = dateStr.split('-');
  const ddmmyyyy = `${d}-${m}-${y}`;
  return [
    'Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield',
    `Nifty 50,${ddmmyyyy},25658.35,25951.65,25619.00,25819.25,469.60,1.85,1000,1000,21,3,1`,
    `India VIX,${ddmmyyyy},17.70,18.24,16.43,${vix},-0.03,${chgPct},-,-,-,-,-`
  ].join('\n') + '\n';
}

function build52WeekCsv(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const eff = `${String(d).padStart(2, '0')}-${months[m - 1]}-${y}`;
  return [
    '"Disclaimer - Adjusted 52W High/Low"',
    `"Effective for ${eff}"`,
    '"SYMBOL","SERIES","Adjusted_52_Week_High","52_Week_High_Date","Adjusted_52_Week_Low","52_Week_Low_DT"',
    '"RELIANCE","EQ","1360.00","01-NOV-2026","1100.00","01-FEB-2026"',
    '"TCS","EQ","4500.00","15-OCT-2026","3600.00","05-MAR-2026"'
  ].join('\n') + '\n';
}

const emptyMcapSources = {
  benchmarkBySymbol: new Map(),
  bseSecByIsin: new Map(),
  catalogByIsin: new Map([
    ['INE002A01018', { capCr: 1800000 }],
    ['INE467B01029', { capCr: 1400000 }]
  ]),
  catalogByTicker: new Map(),
  screenerBySlug: new Map()
};

const silentLogger = { log: () => {}, warn: () => {}, error: () => {} };

async function runAll() {
  console.log('================================================================');
  console.log(' MACHII BAZZAR — COMPREHENSIVE PIPELINE TEST SUITE');
  console.log('================================================================\n');

  // 1. Normal successful NSE (ZIP) + BSE (CSV) downloads
  await runTest('1. Normal successful NSE (ZIP) + BSE (CSV) downloads + supplementary archives', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const nseCsv = buildBhavcopyCsv('NSE', dateStr);
      const bseCsv = buildBhavcopyCsv('BSE', dateStr);
      const nseZip = buildZipBuffer(getNseFilename(dateStr), nseCsv);

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: nseZip };
          }
          if (url.includes('BhavCopy_BSE_CM')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(bseCsv) };
          }
          if (url.includes('ind_close_all')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'text/csv' }, buffer: Buffer.from(buildIndicesCsv(dateStr)) };
          }
          if (url.includes('CM_52_wk_High_low')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'text/csv' }, buffer: Buffer.from(build52WeekCsv(dateStr)) };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const res = await downloader.downloadSession(dateStr);
      assert.strictEqual(res.bothOk, true);
      assert.strictEqual(res.nse.source, 'https-nse-zip');
      assert.strictEqual(res.bse.source, 'https-bse-csv');
      assert(fs.existsSync(path.join(ws.downloadsDir, getNseFilename(dateStr))));
      assert(fs.existsSync(path.join(ws.downloadsDir, getBseFilename(dateStr))));
      assert(fs.existsSync(path.join(ws.downloadsDir, getIndicesFilename(dateStr))));
      assert(fs.existsSync(path.join(ws.downloadsDir, get52WeekFilename(dateStr))));

      // Second call skips cached validated files
      const res2 = await downloader.downloadSession(dateStr);
      assert.strictEqual(res2.nse.skipped, true);
      assert.strictEqual(res2.bse.skipped, true);
    } finally {
      ws.cleanup();
    }
  });

  // 2. Missing NSE file (404)
  await runTest('2. Missing NSE file (HTTP 404) returns pendingPublication without corrupting disk', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const bseCsv = buildBhavcopyCsv('BSE', dateStr);
      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_BSE_CM')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(bseCsv) };
          }
          return { ok: false, statusCode: 404, headers: { 'content-type': 'text/html' }, buffer: Buffer.from('Not Found') };
        }
      });

      const res = await downloader.downloadSession(dateStr);
      assert.strictEqual(res.bothOk, false);
      assert.strictEqual(res.nse.ok, false);
      assert.strictEqual(res.nse.notPublished, true);
      assert.strictEqual(res.pendingPublication, true);
      assert(!fs.existsSync(path.join(ws.downloadsDir, getNseFilename(dateStr))));
    } finally {
      ws.cleanup();
    }
  });

  // 3. Missing BSE file (404 and HTTP 200 HTML error page)
  await runTest('3. Missing BSE file (HTTP 200 HTML error page) is rejected and never saved as CSV', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const nseZip = buildZipBuffer(getNseFilename(dateStr), buildBhavcopyCsv('NSE', dateStr));
      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: nseZip };
          }
          if (url.includes('BhavCopy_BSE_CM')) {
            return {
              ok: true,
              statusCode: 200,
              headers: { 'content-type': 'text/html' },
              buffer: Buffer.from('<!DOCTYPE html><html><body>File not found</body></html>'.repeat(20))
            };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const res = await downloader.downloadSession(dateStr);
      assert.strictEqual(res.bothOk, false);
      assert.strictEqual(res.bse.ok, false);
      assert.strictEqual(res.bse.notPublished, true);
      assert(!fs.existsSync(path.join(ws.downloadsDir, getBseFilename(dateStr))));
    } finally {
      ws.cleanup();
    }
  });

  // 4. Exchange holidays & special Muhurat session
  await runTest('4. Exchange calendar identifies 2026 holidays (Nov 10, Nov 24) and Muhurat session (Nov 8)', async () => {
    assert.strictEqual(cal.isTradingDay('2026-11-10'), false, 'Nov 10 Diwali Balipratipada is holiday');
    assert.strictEqual(cal.isTradingDay('2026-11-24'), false, 'Nov 24 Guru Nanak Jayanti is holiday');
    assert.strictEqual(cal.isTradingDay('2026-11-08'), true, 'Nov 8 Sunday Muhurat session is trading day');

    const nov10 = cal.getLatestExpectedTradingDate(new Date('2026-11-10T18:00:00+05:30'));
    assert.strictEqual(nov10.isHoliday, true);
    assert.strictEqual(nov10.latestExpectedDate, '2026-11-09');

    const nov24 = cal.getLatestExpectedTradingDate(new Date('2026-11-24T18:00:00+05:30'));
    assert.strictEqual(nov24.isHoliday, true);
    assert.strictEqual(nov24.latestExpectedDate, '2026-11-23');
  });

  // 5. Weekend handling
  await runTest('5. Weekend rolls back to Friday and marks Friday dataset fresh', async () => {
    const sat = new Date('2026-11-21T15:00:00+05:30');
    const expected = cal.getLatestExpectedTradingDate(sat);
    assert.strictEqual(expected.isWeekend, true);
    assert.strictEqual(expected.latestExpectedDate, '2026-11-20');

    const freshness = cal.checkSessionFreshness('2026-11-20', sat);
    assert.strictEqual(freshness.isFresh, true);
    assert.strictEqual(freshness.freshnessStatus, 'current');
  });

  // 6. Delayed BhavCopy publication (bounded polling)
  await runTest('6. Delayed BhavCopy publication recovers via bounded polling and distinguishes delayed vs stale', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const nseZip = buildZipBuffer(getNseFilename(dateStr), buildBhavcopyCsv('NSE', dateStr));
      const bseCsv = buildBhavcopyCsv('BSE', dateStr);
      let bseCalls = 0;

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: nseZip };
          }
          if (url.includes('BhavCopy_BSE_CM')) {
            bseCalls++;
            if (bseCalls < 2) {
              return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
            }
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(bseCsv) };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const pollRes = await downloader.waitForSessionPublication(dateStr, { maxWaitMs: 5000, pollIntervalMs: 1 });
      assert.strictEqual(pollRes.bothOk, true);
      assert.strictEqual(pollRes.pollAttempts, 2);

      // Freshness check: 2026-11-23 when 2026-11-25 expected (and 2026-11-24 was holiday) -> delayed!
      const nov25Evening = new Date('2026-11-25T17:00:00+05:30');
      const delayed = cal.checkSessionFreshness('2026-11-23', nov25Evening);
      assert.strictEqual(delayed.isDelayed, true);
      assert.strictEqual(delayed.freshnessStatus, 'delayed');

      const stale = cal.checkSessionFreshness('2026-11-04', nov25Evening);
      assert.strictEqual(stale.isStale, true);
      assert.strictEqual(stale.freshnessStatus, 'stale');
      assert(stale.missingSessionsCount > 5);
    } finally {
      ws.cleanup();
    }
  });

  // 7. HTTP 403 and 429 retry with exponential backoff & Retry-After
  await runTest('7. HTTP 403 and 429 trigger exponential backoff / Retry-After and recover', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const nseZip = buildZipBuffer(getNseFilename(dateStr), buildBhavcopyCsv('NSE', dateStr));
      const bseCsv = buildBhavcopyCsv('BSE', dateStr);
      const sleepDelays = [];
      let nseCalls = 0;
      let bseCalls = 0;

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        baseDelayMs: 50,
        maxAttempts: 4,
        sleep: async (ms) => { sleepDelays.push(ms); },
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            nseCalls++;
            if (nseCalls === 1) return { ok: false, statusCode: 429, headers: { 'retry-after': '1' }, buffer: Buffer.alloc(0) };
            if (nseCalls === 2) return { ok: false, statusCode: 403, headers: {}, buffer: Buffer.from('Forbidden') };
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: nseZip };
          }
          if (url.includes('BhavCopy_BSE_CM')) {
            bseCalls++;
            if (bseCalls === 1) return { ok: false, statusCode: 503, headers: {}, buffer: Buffer.alloc(0) };
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(bseCsv) };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const res = await downloader.downloadSession(dateStr, { includeSupplementary: false });
      assert.strictEqual(res.bothOk, true);
      assert.strictEqual(nseCalls, 3);
      assert.strictEqual(bseCalls, 2);
      assert(sleepDelays.includes(1000), 'Respected Retry-After: 1 (1000ms)');
      assert(sleepDelays.includes(100), 'Applied exponential backoff (100ms on attempt 2)');
    } finally {
      ws.cleanup();
    }
  });

  // 8. Network timeout recovery
  await runTest('8. Network timeout retries and recovers on subsequent attempt', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const nseZip = buildZipBuffer(getNseFilename(dateStr), buildBhavcopyCsv('NSE', dateStr));
      const bseCsv = buildBhavcopyCsv('BSE', dateStr);
      let nseCalls = 0;

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        baseDelayMs: 5,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            nseCalls++;
            if (nseCalls === 1) {
              return { ok: false, statusCode: 0, headers: {}, buffer: Buffer.alloc(0), error: 'Request timed out', errorCode: 'ETIMEDOUT' };
            }
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: nseZip };
          }
          if (url.includes('BhavCopy_BSE_CM')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(bseCsv) };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const res = await downloader.downloadSession(dateStr, { includeSupplementary: false });
      assert.strictEqual(res.bothOk, true);
      assert.strictEqual(nseCalls, 2);
    } finally {
      ws.cleanup();
    }
  });

  // 9. Corrupted CSV & corrupted ZIP rejection
  await runTest('9. Corrupted ZIP and invalid-schema CSV are rejected without saving', async () => {
    const ws = makeTempWorkspace();
    try {
      const dateStr = '2026-11-25';
      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        maxAttempts: 1,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: Buffer.from('NOT_A_VALID_ZIP_PAYLOAD_CORRUPT_BYTES') };
          }
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.csv')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'text/csv' }, buffer: Buffer.from('FOO,BAR,BAZ\n1,2,3\n'.repeat(20)) };
          }
          return { ok: true, statusCode: 200, headers: { 'content-type': 'text/csv' }, buffer: Buffer.from('BAD,HEADER\n1,2\n'.repeat(30)) };
        }
      });

      const res = await downloader.downloadSession(dateStr);
      assert.strictEqual(res.bothOk, false);
      assert.strictEqual(res.nse.ok, false);
      assert.strictEqual(res.bse.ok, false);
      assert(!fs.existsSync(path.join(ws.downloadsDir, getNseFilename(dateStr))));
      assert(!fs.existsSync(path.join(ws.downloadsDir, getBseFilename(dateStr))));
    } finally {
      ws.cleanup();
    }
  });

  // 10. Empty CSV rejection
  await runTest('10. Empty / header-only CSV fails validation', async () => {
    const emptyCheck = validateBhavcopyCsvContent('', '2026-11-25', { minRows: 5, minBytes: 50 });
    assert.strictEqual(emptyCheck.ok, false);
    const headerOnly = validateBhavcopyCsvContent(
      'TradDt,ISIN,TckrSymb,SctySrs,ClsPric,PrvsClsgPric,TtlTradgVol\n',
      '2026-11-25',
      { minRows: 1, minBytes: 20 }
    );
    assert.strictEqual(headerOnly.ok, false);
    assert.strictEqual(headerOnly.code, 'EMPTY_CSV');
  });

  // 11. Invalid trading date & internal TradDt mismatch
  await runTest('11. Invalid trading date & CSV internal TradDt mismatch are rejected', async () => {
    const ws = makeTempWorkspace();
    try {
      const targetDate = '2026-11-25';
      const staleCsv = buildBhavcopyCsv('NSE', '2026-11-04'); // wrong internal TradDt!
      const staleZip = buildZipBuffer(getNseFilename(targetDate), staleCsv);
      const bseCsv = buildBhavcopyCsv('BSE', targetDate);

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        maxAttempts: 1,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: staleZip };
          }
          if (url.includes('BhavCopy_BSE_CM')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(bseCsv) };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const res = await downloader.downloadSession(targetDate);
      assert.strictEqual(res.bothOk, false);
      assert.strictEqual(res.nse.ok, false);
      assert(res.nse.error.includes('DATE_MISMATCH') || res.nse.error.includes('Trading date mismatch'));

      const badDateRefresh = await runRefresh({
        date: '2026-11-24', // holiday
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        skipStorage: true,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });
      assert.strictEqual(badDateRefresh.ok, false);
      assert.strictEqual(badDateRefresh.status, 'invalid_date');
    } finally {
      ws.cleanup();
    }
  });

  // 12. Duplicate symbols & duplicate ISIN guard
  await runTest('12. Duplicate ticker symbols disambiguated by ISIN while duplicate ISINs are rejected', async () => {
    const validStocks = [
      {
        symbol: 'GSTL', company_name: 'Globalspace Ltd', isin: 'INE632W01016',
        nse_symbol: 'GSTL', bse_scrip_code: null, exchanges: ['NSE'],
        current_price: 25.5, close_price: 25.5, open_price: 25, high_price: 26, low_price: 24.5, prev_close: 25,
        volume: 10000, market_cap_cr: 100, historical_prices: null, trading_date: '2026-11-25'
      },
      {
        symbol: 'GSTL', company_name: 'Globe Secure Ltd', isin: 'INE00WS01056',
        nse_symbol: null, bse_scrip_code: '543001', exchanges: ['BSE'],
        current_price: 41, close_price: 41, open_price: 40, high_price: 42, low_price: 39, prev_close: 40,
        volume: 12000, market_cap_cr: 120, historical_prices: null, trading_date: '2026-11-25'
      }
    ];
    const stats = {
      tradingDate: '2026-11-25', nseSourceDate: '2026-11-25', bseSourceDate: '2026-11-25',
      advances: 2, declines: 0, unchanged: 0, unpriced: 0,
      dualListedCount: 0, nseOnlyCount: 1, bseOnlyCount: 1
    };

    const okCheck = validateMergedDataset(validStocks, stats, { minUniverseSize: 2 });
    assert.strictEqual(okCheck.ok, true, 'Distinct ISINs sharing symbol pass validation');

    const dupIsinStocks = [...validStocks, { ...validStocks[0] }];
    const badCheck = validateMergedDataset(dupIsinStocks, { ...stats, advances: 3, nseOnlyCount: 2 }, { minUniverseSize: 2 });
    assert.strictEqual(badCheck.ok, false, 'Duplicate ISIN must fail validation');
    assert(badCheck.errors.some(e => e.includes('Duplicate ISIN')));
  });

  // 13. Partial pipeline failure retains previous valid dataset
  await runTest('13. Partial pipeline failure retains previous valid dataset untouched', async () => {
    const ws = makeTempWorkspace();
    try {
      const priorSentinel = '/* valid prior dataset */\nconst MARKET_STATS = {"tradingDate":"2026-11-23","stockCount":10,"refreshedAtUtc":"2026-11-23T12:00:00.000Z"};\nconst STOCKS_DATA = [];\n';
      fs.writeFileSync(ws.targetPath, priorSentinel, 'utf8');

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        maxAttempts: 1,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: buildZipBuffer(getNseFilename('2026-11-25'), buildBhavcopyCsv('NSE', '2026-11-25')) };
          }
          // BSE fails
          return { ok: false, statusCode: 500, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const outcome = await runRefresh({
        date: '2026-11-25',
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        downloader,
        minRows: 10,
        minBytes: 200,
        skipStorage: true,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });

      assert.strictEqual(outcome.ok, false);
      assert.strictEqual(fs.readFileSync(ws.targetPath, 'utf8'), priorSentinel, 'Previous valid dataset must remain byte-for-byte identical');
    } finally {
      ws.cleanup();
    }
  });

  // 14 & 15. Historical backfill & atomic publishing with 6-session sparklines
  await runTest('14 & 15. Historical backfill skips holidays/weekends, preserves history, builds 6-session sparklines & atomically publishes', async () => {
    const ws = makeTempWorkspace();
    try {
      // Seed Nov 17 session already on disk
      const seedDate = '2026-11-17';
      fs.writeFileSync(path.join(ws.downloadsDir, getNseFilename(seedDate)), buildBhavcopyCsv('NSE', seedDate), 'utf8');
      fs.writeFileSync(path.join(ws.downloadsDir, getBseFilename(seedDate)), buildBhavcopyCsv('BSE', seedDate), 'utf8');

      // Expected trading days after 2026-11-17 up to 2026-11-25:
      // 2026-11-18, 2026-11-19, 2026-11-20, (skip 21-22 weekend), 2026-11-23, (skip 24 holiday), 2026-11-25
      const requestedDates = new Set();

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          const m = url.match(/202611(\d{2})/);
          if (m) {
            const dt = `2026-11-${m[1]}`;
            requestedDates.add(dt);
            if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: buildZipBuffer(getNseFilename(dt), buildBhavcopyCsv('NSE', dt)) };
            }
            if (url.includes('BhavCopy_BSE_CM')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(buildBhavcopyCsv('BSE', dt)) };
            }
          }
          if (url.includes('ind_close_all_25112026')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'text/csv' }, buffer: Buffer.from(buildIndicesCsv('2026-11-25', 17.67, -0.16)) };
          }
          if (url.includes('CM_52_wk_High_low_25112026')) {
            return { ok: true, statusCode: 200, headers: { 'content-type': 'text/csv' }, buffer: Buffer.from(build52WeekCsv('2026-11-25')) };
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const outcome = await runRefresh({
        backfill: true,
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        downloader,
        minRows: 10,
        minBytes: 200,
        minSourceRows: 10,
        minUniverseSize: 10,
        skipMcp: true,
        skipReport: true,
        skipStorage: true,
        marketCapSources: emptyMcapSources,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });

      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(outcome.tradingDate, '2026-11-25');
      assert(!requestedDates.has('2026-11-17'), 'Already-valid 2026-11-17 must be skipped');
      assert(!requestedDates.has('2026-11-21') && !requestedDates.has('2026-11-22'), 'Weekends must be skipped');
      assert(!requestedDates.has('2026-11-24'), 'Guru Nanak Jayanti holiday must be skipped');
      assert(requestedDates.has('2026-11-25'));

      assert.strictEqual(outcome.marketStats.nseSourceDate, '2026-11-25');
      assert.strictEqual(outcome.marketStats.bseSourceDate, '2026-11-25');
      assert.strictEqual(outcome.marketStats.vix, 17.67);
      assert.strictEqual(outcome.marketStats.pipelineVersion, '2.0.0');
      assert.strictEqual(outcome.marketStats.historicalSessions.sessionCount, 6);
      assert.deepStrictEqual(outcome.marketStats.historicalSessions.sessions, [
        '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-23', '2026-11-25'
      ]);

      const published = fs.readFileSync(ws.targetPath, 'utf8');
      const relMatch = published.match(/"isin":\s*"INE002A01018"[\s\S]*?"historical_prices":\s*(\[[\s\S]*?\])/);
      assert(relMatch, 'RELIANCE historical prices serialized');
      const hist = JSON.parse(relMatch[1]);
      assert.strictEqual(hist.length, 6, 'RELIANCE must have all 6 historical sessions');
    } finally {
      ws.cleanup();
    }
  });

  // 16. Older data attempting to overwrite newer data
  await runTest('16. Refuses to overwrite newer published dataset with older trading date', async () => {
    const ws = makeTempWorkspace();
    try {
      const newerDataset = 'const MARKET_STATS = {"tradingDate":"2026-11-25","stockCount":10};\nconst STOCKS_DATA = [];\n';
      fs.writeFileSync(ws.targetPath, newerDataset, 'utf8');
      fs.writeFileSync(path.join(ws.downloadsDir, getNseFilename('2026-11-20')), buildBhavcopyCsv('NSE', '2026-11-20'), 'utf8');
      fs.writeFileSync(path.join(ws.downloadsDir, getBseFilename('2026-11-20')), buildBhavcopyCsv('BSE', '2026-11-20'), 'utf8');

      await assert.rejects(
        () => syncUniverse({
          targetDate: '2026-11-20',
          downloadsDir: ws.downloadsDir,
          targetPath: ws.targetPath,
          backupPath: ws.backupPath,
          minSourceRows: 10,
          minUniverseSize: 10,
          minBytes: 200,
          skipMcp: true,
          skipReport: true,
          skipStorage: true,
          marketCapSources: emptyMcapSources,
          now: new Date('2026-11-25T20:00:00+05:30')
        }),
        /Refusing to overwrite newer valid dataset/
      );

      const refreshOut = await runRefresh({
        date: '2026-11-20',
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        minRows: 10,
        minBytes: 200,
        skipStorage: true,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });
      assert.strictEqual(refreshOut.ok, false);
      assert.strictEqual(refreshOut.status, 'downgrade_refused');
      assert.strictEqual(fs.readFileSync(ws.targetPath, 'utf8'), newerDataset);
    } finally {
      ws.cleanup();
    }
  });

  // 17. Recovery after interrupted execution (stale .tmp + partial backfill)
  await runTest('17. Recovers cleanly after interrupted run (cleans stale .tmp files and stale lock, resumes backfill)', async () => {
    const ws = makeTempWorkspace();
    try {
      // Simulate leftover partial temp files and dead-PID lockfile from crash
      const staleTmp = path.join(ws.downloadsDir, `${getNseFilename('2026-11-25')}.tmp.999999.123`);
      fs.writeFileSync(staleTmp, 'PARTIAL_CORRUPT_DATA', 'utf8');
      const lockPath = path.join(ws.downloadsDir, '.refresh.lock');
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: '2026-11-25T10:00:00Z', startedAtMs: Date.now() }), 'utf8');

      // Also leave one valid historical day already completed
      fs.writeFileSync(path.join(ws.downloadsDir, getNseFilename('2026-11-23')), buildBhavcopyCsv('NSE', '2026-11-23'), 'utf8');
      fs.writeFileSync(path.join(ws.downloadsDir, getBseFilename('2026-11-23')), buildBhavcopyCsv('BSE', '2026-11-23'), 'utf8');

      let downloadedDates = [];
      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          const m = url.match(/202611(\d{2})/);
          if (m) {
            const dt = `2026-11-${m[1]}`;
            downloadedDates.push(dt);
            if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: buildZipBuffer(getNseFilename(dt), buildBhavcopyCsv('NSE', dt)) };
            }
            if (url.includes('BhavCopy_BSE_CM')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(buildBhavcopyCsv('BSE', dt)) };
            }
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const outcome = await runRefresh({
        backfill: true,
        fromDate: '2026-11-23',
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        lockPath,
        downloader,
        minRows: 10,
        minBytes: 200,
        minSourceRows: 10,
        minUniverseSize: 10,
        skipMcp: true,
        skipReport: true,
        skipStorage: true,
        marketCapSources: emptyMcapSources,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });

      assert.strictEqual(outcome.ok, true);
      assert.strictEqual(fs.existsSync(staleTmp), false, 'Orphaned .tmp file must be cleaned');
      assert.strictEqual(fs.existsSync(lockPath), false, 'Lock file must be released');
      assert(!downloadedDates.includes('2026-11-23'), 'Valid 2026-11-23 must not be re-downloaded');
      assert(downloadedDates.includes('2026-11-25'), 'Missing 2026-11-25 must be downloaded');
      assert.strictEqual(outcome.tradingDate, '2026-11-25');
    } finally {
      ws.cleanup();
    }
  });

  // Helper: in-memory mock Supabase Storage server transport
  function makeMockSupabaseHttp(options = {}) {
    const store = new Map();
    const listCalls = [];
    const batchDeleteCalls = [];
    const singleDeleteCalls = [];

    return {
      store,
      listCalls,
      batchDeleteCalls,
      singleDeleteCalls,
      httpRequest: async (url, reqOpts = {}) => {
        const parsed = new URL(url);
        const method = reqOpts.method || 'GET';
        const authPrefix = '/storage/v1/object/authenticated/test-bucket/';
        const pubPrefix = '/storage/v1/object/public/test-bucket/';
        const writePrefix = '/storage/v1/object/test-bucket/';
        const listPath = '/storage/v1/object/list/test-bucket';
        const batchDeletePath = '/storage/v1/object/test-bucket';

        if (method === 'GET') {
          let objPath = null;
          if (parsed.pathname.startsWith(authPrefix)) objPath = decodeURIComponent(parsed.pathname.slice(authPrefix.length));
          else if (parsed.pathname.startsWith(pubPrefix)) objPath = decodeURIComponent(parsed.pathname.slice(pubPrefix.length));
          if (options.onGet) {
            const override = options.onGet(objPath, store);
            if (override) return override;
          }
          if (!objPath || !store.has(objPath)) {
            return { ok: false, statusCode: 404, headers: {}, body: Buffer.from('Not found') };
          }
          return { ok: true, statusCode: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(store.get(objPath)) };
        }

        if (method === 'POST' && parsed.pathname === listPath) {
          const reqBody = JSON.parse(reqOpts.body ? reqOpts.body.toString('utf8') : '{}');
          listCalls.push(reqBody);
          if (options.onList) {
            const override = options.onList(reqBody, store);
            if (override) return override;
          }
          const prefix = String(reqBody.prefix || '').replace(/^\/+|\/+$/g, '');
          const limit = Number(reqBody.limit) || 100;
          const offset = Number(reqBody.offset) || 0;
          const order = reqBody.sortBy?.order === 'desc' ? -1 : 1;

          const entriesMap = new Map();
          for (const [rawKey, val] of store.entries()) {
            const normKey = String(rawKey).replace(/^\/+|\/+$/g, '');
            let rel = normKey;
            if (prefix) {
              if (!normKey.startsWith(`${prefix}/`)) continue;
              rel = normKey.slice(prefix.length + 1);
            }
            if (!rel) continue;
            const parts = rel.split('/');
            const name = parts[0];
            if (parts.length > 1) {
              if (!entriesMap.has(name)) {
                entriesMap.set(name, {
                  name,
                  id: null,
                  created_at: null,
                  updated_at: null,
                  last_accessed_at: null,
                  metadata: null
                });
              }
            } else {
              entriesMap.set(name, {
                name,
                id: `mock-id-${normKey}`,
                created_at: '2026-11-25T15:00:00.000Z',
                updated_at: '2026-11-25T15:00:00.000Z',
                last_accessed_at: '2026-11-25T15:00:00.000Z',
                metadata: { size: Buffer.byteLength(String(val), 'utf8') }
              });
            }
          }

          const items = [...entriesMap.values()].sort((a, b) => a.name.localeCompare(b.name) * order);
          const page = items.slice(offset, offset + limit);
          return {
            ok: true,
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(page))
          };
        }

        if (method === 'POST' && parsed.pathname.startsWith(writePrefix)) {
          const objPath = decodeURIComponent(parsed.pathname.slice(writePrefix.length));
          if (options.onPost) {
            const override = options.onPost(objPath, reqOpts.body, store);
            if (override) return override;
          }
          store.set(objPath, reqOpts.body.toString('utf8'));
          return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{"Key":"ok"}') };
        }

        if (method === 'DELETE' && parsed.pathname === batchDeletePath) {
          const reqBody = JSON.parse(reqOpts.body ? reqOpts.body.toString('utf8') : '{}');
          const prefixes = Array.isArray(reqBody.prefixes) ? reqBody.prefixes : [];
          batchDeleteCalls.push(prefixes);
          if (options.onBatchDelete) {
            const override = options.onBatchDelete(prefixes, store);
            if (override) return override;
          }
          for (const p of prefixes) {
            store.delete(p);
          }
          return {
            ok: true,
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: Buffer.from(JSON.stringify(prefixes.map(p => ({ name: p }))))
          };
        }

        if (method === 'DELETE' && parsed.pathname.startsWith(writePrefix)) {
          const objPath = decodeURIComponent(parsed.pathname.slice(writePrefix.length));
          singleDeleteCalls.push(objPath);
          if (options.onDelete) {
            const override = options.onDelete(objPath, store);
            if (override) return override;
          }
          store.delete(objPath);
          return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
        }

        return { ok: false, statusCode: 400, headers: {}, body: Buffer.alloc(0) };
      }
    };
  }

  // 18. Storage upload, checksum verification & atomic pointer swap
  await runTest('18. External storage upload verifies checksum & atomically swaps latest.json', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    const stats1 = { tradingDate: '2026-11-23', nseSourceDate: '2026-11-23', bseSourceDate: '2026-11-23', refreshedAtUtc: '2026-11-23T12:00:00.000Z', istDisplayTime: '23 Nov 2026, 17:30:00 IST', stockCount: 1 };
    const stocks1 = [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1300, exchanges: ['NSE', 'BSE'], trading_date: '2026-11-23' }];
    const pub1 = await storage.publishDatasetToStorage(stats1, stocks1);
    assert.strictEqual(pub1.ok, true);
    assert(mock.store.has('latest.json'));
    assert(mock.store.has(pub1.datasetPath));
    assert.strictEqual(mock.store.has('locks/refresh.lock.json'), false, 'Lock released after publish');

    const stats2 = { tradingDate: '2026-11-25', nseSourceDate: '2026-11-25', bseSourceDate: '2026-11-25', refreshedAtUtc: '2026-11-25T14:53:38.557Z', istDisplayTime: '25 Nov 2026, 20:23:38 IST', stockCount: 1 };
    const stocks2 = [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1373.9, exchanges: ['NSE', 'BSE'], trading_date: '2026-11-25' }];
    const pub2 = await storage.publishDatasetToStorage(stats2, stocks2);
    assert.strictEqual(pub2.ok, true);

    const fetched = await storage.fetchLatestDataset();
    assert.strictEqual(fetched.ok, true);
    assert.strictEqual(fetched.manifest.tradingDate, '2026-11-25');
    assert.strictEqual(fetched.manifest.previousVersion.versionId, pub1.versionId);
    assert.strictEqual(fetched.stocks[0].current_price, 1373.9);
  });

  // 19. Failed storage upload / checksum corruption preserves previous valid dataset
  await runTest('19. Failed storage upload & checksum mismatch preserve previous latest.json untouched', async () => {
    let corruptReadBack = false;
    const mock = makeMockSupabaseHttp({
      onGet: (objPath, store) => {
        if (corruptReadBack && objPath && objPath.startsWith('datasets/2026-11-25/')) {
          return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{"corrupted":true}') };
        }
        return null;
      }
    });
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {},
      maxRetries: 1
    });

    const stats1 = { tradingDate: '2026-11-23', refreshedAtUtc: '2026-11-23T12:00:00.000Z', stockCount: 1 };
    const stocks1 = [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1300 }];
    const pub1 = await storage.publishDatasetToStorage(stats1, stocks1);
    assert.strictEqual(pub1.ok, true);
    const snapshotBefore = mock.store.get('latest.json');

    corruptReadBack = true;
    const stats2 = { tradingDate: '2026-11-25', refreshedAtUtc: '2026-11-25T15:00:00.000Z', stockCount: 1 };
    const stocks2 = [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1373.9 }];
    const pub2 = await storage.publishDatasetToStorage(stats2, stocks2);
    assert.strictEqual(pub2.ok, false);
    assert.strictEqual(pub2.phase, 'verify_checksum');
    assert.strictEqual(mock.store.get('latest.json'), snapshotBefore, 'latest.json must remain byte-for-byte identical');
  });

  // 20. Storage lock contention & downgrade protection
  await runTest('20. Storage concurrency lock blocks overlapping updates and refuses downgrade', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    const lock1 = await storage.acquireStorageLock('runner-1');
    assert.strictEqual(lock1.acquired, true);

    const concurrentPublish = await storage.publishDatasetToStorage(
      { tradingDate: '2026-11-25', refreshedAtUtc: '2026-11-25T15:00:00.000Z', stockCount: 1 },
      [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1373.9 }],
      { ownerId: 'runner-2' }
    );
    assert.strictEqual(concurrentPublish.ok, false);
    assert.strictEqual(concurrentPublish.locked, true);

    await storage.releaseStorageLock('runner-1');
    const pubNewer = await storage.publishDatasetToStorage(
      { tradingDate: '2026-11-25', refreshedAtUtc: '2026-11-25T15:00:00.000Z', stockCount: 1 },
      [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1373.9 }]
    );
    assert.strictEqual(pubNewer.ok, true);

    const downgrade = await storage.publishDatasetToStorage(
      { tradingDate: '2026-11-20', refreshedAtUtc: '2026-11-20T15:00:00.000Z', stockCount: 1 },
      [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1200 }]
    );
    assert.strictEqual(downgrade.ok, false);
    assert.strictEqual(downgrade.downgradeRefused, true);
  });

  // 21. Vercel query & stats loaders serve latest stored dataset without redeploy
  await runTest('21. Dynamic dataset & stats loaders serve latest stored dataset and fall back safely', async () => {
    const ws = makeTempWorkspace();
    try {
      const staleFile = 'const MARKET_STATS = {"tradingDate":"2026-11-04","stockCount":1};\nconst STOCKS_DATA = [{"isin":"INE002A01018","symbol":"RELIANCE","company_name":"Reliance Industries Ltd","current_price":1311,"exchanges":["NSE"]}];\n';
      fs.writeFileSync(ws.targetPath, staleFile, 'utf8');

      const mock = makeMockSupabaseHttp();
      const storage = createStorageClient({
        url: 'https://mock.supabase.co',
        serviceKey: 'mock-service-key',
        bucket: 'test-bucket',
        httpRequest: mock.httpRequest,
        sleep: async () => {}
      });

      await storage.publishDatasetToStorage(
        { tradingDate: '2026-11-25', nseSourceDate: '2026-11-25', bseSourceDate: '2026-11-25', refreshedAtUtc: '2026-11-25T14:53:38.557Z', istDisplayTime: '25 Nov 2026, 20:23:38 IST', stockCount: 2 },
        [
          { isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', current_price: 1373.9, exchanges: ['NSE', 'BSE'], market_cap_cr: 1850000 },
          { isin: 'INE999Z01011', symbol: 'NEWLIST', company_name: 'New Listed Co Ltd', current_price: 510, exchanges: ['NSE'], market_cap_cr: 2500 }
        ]
      );

      resetCacheForTests();
      const statsRes = await loadMarketStatsAsync({ storageClient: storage, dataPath: ws.targetPath, force: true });
      assert.strictEqual(statsRes.storageSource, 'supabase_storage');
      assert.strictEqual(statsRes.stats.tradingDate, '2026-11-25');

      const queryRes = await queryStocksAsync({ isin: 'INE999Z01011' }, { storageClient: storage, dataPath: ws.targetPath, force: true });
      assert.strictEqual(queryRes.storageSource, 'supabase_storage');
      assert.strictEqual(queryRes.total, 1);
      assert.strictEqual(queryRes.stocks[0].symbol, 'NEWLIST');
      assert.strictEqual(queryRes.stocks[0].current_price, 510);

      // Simulate storage outage: falls back cleanly to in-memory cached dataset
      const brokenStorage = createStorageClient({
        url: 'https://mock.supabase.co',
        anonKey: 'bad',
        bucket: 'test-bucket',
        httpRequest: async () => ({ ok: false, statusCode: 503, headers: {}, body: Buffer.alloc(0) }),
        sleep: async () => {},
        maxRetries: 1
      });
      const cachedFallback = await loadDatasetAsync({ storageClient: brokenStorage, dataPath: ws.targetPath, force: true });
      assert.strictEqual(cachedFallback.storageSource, 'supabase_storage_cached');
      assert.strictEqual(cachedFallback.stats.tradingDate, '2026-11-25');

      // Cold outage without memory cache: falls back to local file
      resetCacheForTests();
      const diskFallback = await loadDatasetAsync({ storageClient: brokenStorage, dataPath: ws.targetPath, force: true });
      assert.strictEqual(diskFallback.storageSource, 'local_fallback');
      assert.strictEqual(diskFallback.stats.tradingDate, '2026-11-04');
      resetCacheForTests();
    } finally {
      ws.cleanup();
    }
  });

  // 22. End-to-end runRefresh on ephemeral runner publishes to storage and stays idempotent
  await runTest('22. Ephemeral runner runRefresh publishes to external storage and skips duplicate runs', async () => {
    const ws = makeTempWorkspace();
    try {
      const mock = makeMockSupabaseHttp();
      const storage = createStorageClient({
        url: 'https://mock.supabase.co',
        serviceKey: 'mock-service-key',
        bucket: 'test-bucket',
        httpRequest: mock.httpRequest,
        sleep: async () => {}
      });

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          const m = url.match(/202611(\d{2})/);
          if (m) {
            const dt = `2026-11-${m[1]}`;
            if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: buildZipBuffer(getNseFilename(dt), buildBhavcopyCsv('NSE', dt)) };
            }
            if (url.includes('BhavCopy_BSE_CM')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(buildBhavcopyCsv('BSE', dt)) };
            }
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const firstRun = await runRefresh({
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        downloader,
        storageClient: storage,
        minRows: 10,
        minBytes: 200,
        minSourceRows: 10,
        minUniverseSize: 10,
        skipMcp: true,
        skipReport: true,
        marketCapSources: emptyMcapSources,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });

      assert.strictEqual(firstRun.ok, true);
      assert.strictEqual(firstRun.status, 'updated');
      assert.strictEqual(firstRun.storageResult.ok, true);

      // Simulate fresh ephemeral runner with empty local js/ directory but storage already at 2026-11-25
      fs.unlinkSync(ws.targetPath);
      const secondRun = await runRefresh({
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        downloader,
        storageClient: storage,
        minRows: 10,
        minBytes: 200,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });
      assert.strictEqual(secondRun.ok, true);
      assert.strictEqual(secondRun.status, 'up_to_date', 'Fresh ephemeral runner detects remote storage is current');
    } finally {
      ws.cleanup();
    }
  });

  // 23. Zero automatic git commits / pushes in GitHub Actions or npm scripts
  await runTest('23. GitHub Actions workflow & package.json contain zero automatic git commit or push operations', async () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'refresh-stock-data.yml'), 'utf8');
    assert(!/\bgit\s+(add|commit|push)\b/i.test(workflow), 'Workflow must not execute git add/commit/push');
    assert(!/github-push-action/i.test(workflow), 'Workflow must not use github-push-action');
    assert(/permissions:\s*\r?\n\s*contents:\s*read\b/.test(workflow), 'Workflow permissions must be read-only (contents: read)');
    assert(workflow.includes('SUPABASE_URL') && workflow.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Workflow passes Supabase storage secrets');

    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    assert(!/\bgit\s+(add|commit|push)\b/i.test(pkg.scripts.deploy || ''), 'package.json deploy script must not run git push');

    const stockDetails = fs.readFileSync(path.join(__dirname, '..', 'js', 'stock-details.js'), 'utf8');
    assert(stockDetails.includes('/api/stocks?isin='), 'stock-details.js dynamically fetches latest stock data from /api/stocks');
  });

  // 24. Regression: CI test isolation & guarantee that tests cannot write to production Supabase storage
  await runTest('24. Regression: CI workflow & test suite are strictly isolated from production Supabase storage', async () => {
    const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'refresh-stock-data.yml'), 'utf8');

    // Job-level env must NOT inject production Supabase URL/service key across all steps
    const jobToSteps = workflow.split(/^\s*steps:/m)[0];
    assert(!jobToSteps.includes('SUPABASE_URL'), 'Job-level env must NOT contain SUPABASE_URL');
    assert(!jobToSteps.includes('SUPABASE_SERVICE_ROLE_KEY'), 'Job-level env must NOT contain SUPABASE_SERVICE_ROLE_KEY');

    // Only precheck, refresh, and summary steps may receive Supabase credentials; verification/test step must not
    const stepBlocks = workflow.split(/\n\s*- name:/).slice(1);
    const precheckStep = stepBlocks.find(b => b.includes('id: precheck'));
    const refreshStep = stepBlocks.find(b => b.includes('id: refresh'));
    const verifyStep = stepBlocks.find(b => b.includes('node scripts/test-pipeline.js'));
    assert(precheckStep && precheckStep.includes('secrets.SUPABASE_URL') && precheckStep.includes('secrets.SUPABASE_SERVICE_ROLE_KEY'), 'precheck step must receive Supabase credentials');
    assert(refreshStep && refreshStep.includes('secrets.SUPABASE_URL') && refreshStep.includes('secrets.SUPABASE_SERVICE_ROLE_KEY'), 'refresh step must receive Supabase credentials');
    assert(verifyStep && !verifyStep.includes('SUPABASE_URL') && !verifyStep.includes('SUPABASE_SERVICE_ROLE_KEY'), 'verify/test step must NEVER receive Supabase credentials');

    // Static check: every runRefresh(...) and syncUniverse(...) call inside this test suite must isolate storage
    const selfSource = fs.readFileSync(__filename, 'utf8');
    function assertEveryCallIsolated(fnName) {
      const token = `${fnName}({`;
      let idx = 0;
      let count = 0;
      while ((idx = selfSource.indexOf(token, idx)) !== -1) {
        const linePrefix = selfSource.slice(Math.max(0, idx - 30), idx);
        if (!linePrefix.includes('function ')) {
          let depth = 0;
          let end = idx + fnName.length + 1;
          for (; end < selfSource.length; end++) {
            const ch = selfSource[end];
            if (ch === '{') depth++;
            else if (ch === '}') {
              depth--;
              if (depth === 0) break;
            }
          }
          const callBody = selfSource.slice(idx, end + 1);
          assert(
            callBody.includes('skipStorage: true') || callBody.includes('storageClient:'),
            `${fnName} call at char ${idx} must set skipStorage: true or storageClient mock`
          );
          count++;
        }
        idx += token.length;
      }
      assert(count > 0, `Expected at least one ${fnName} call in test suite`);
    }
    assertEveryCallIsolated('runRefresh');
    assertEveryCallIsolated('syncUniverse');
    assertEveryCallIsolated('freshRunRefresh');
    assertEveryCallIsolated('freshSyncUniverse');

    // Runtime regression proof: even if host shell has SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY set,
    // isolated pipeline runs make zero real HTTP/HTTPS requests.
    assert.strictEqual(typeof ORIGINAL_SUPABASE_ENV, 'object');
    const ws = makeTempWorkspace('mb-iso-');
    const origHttpReq = http.request;
    const origHttpsReq = https.request;
    const modIds = [
      require.resolve('../src/storage/supabase-storage'),
      require.resolve('./sync-stock-universe'),
      require.resolve('./refresh')
    ];
    const savedCache = new Map(modIds.map(id => [id, require.cache[id]]));
    let networkAttempts = 0;

    try {
      http.request = function forbiddenHttpRequest() {
        networkAttempts++;
        throw new Error('FORBIDDEN_REAL_HTTP_REQUEST');
      };
      https.request = function forbiddenHttpsRequest() {
        networkAttempts++;
        throw new Error('FORBIDDEN_REAL_HTTPS_REQUEST');
      };

      process.env.SUPABASE_URL = 'https://prod-guard.invalid';
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'forbidden-dummy-service-key';
      process.env.SUPABASE_STORAGE_BUCKET = 'machii-bazzar-datasets';

      for (const id of modIds) delete require.cache[id];
      const freshStorage = require('../src/storage/supabase-storage');
      const { syncUniverse: freshSyncUniverse } = require('./sync-stock-universe');
      const { runRefresh: freshRunRefresh } = require('./refresh');

      assert.strictEqual(freshStorage.isWriteConfigured(), true, 'Simulated production env makes defaultStorage write-configured');

      const dt = '2026-11-25';
      fs.writeFileSync(path.join(ws.downloadsDir, getNseFilename(dt)), buildBhavcopyCsv('NSE', dt), 'utf8');
      fs.writeFileSync(path.join(ws.downloadsDir, getBseFilename(dt)), buildBhavcopyCsv('BSE', dt), 'utf8');

      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async () => ({ ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) })
      });

      const refreshOut = await freshRunRefresh({
        date: dt,
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        downloader,
        minRows: 10,
        minBytes: 200,
        minSourceRows: 10,
        minUniverseSize: 10,
        skipMcp: true,
        skipReport: true,
        skipStorage: true,
        marketCapSources: emptyMcapSources,
        now: new Date('2026-11-25T20:00:00+05:30'),
        logger: silentLogger
      });
      assert.strictEqual(refreshOut.ok, true);
      assert.strictEqual(refreshOut.storageResult, null, 'Isolated runRefresh must not publish to storage');

      const syncOut = await freshSyncUniverse({
        targetDate: dt,
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        minSourceRows: 10,
        minUniverseSize: 10,
        minBytes: 200,
        skipMcp: true,
        skipReport: true,
        skipStorage: true,
        force: true,
        marketCapSources: emptyMcapSources,
        now: new Date('2026-11-25T20:00:00+05:30')
      });
      assert.strictEqual(syncOut.storageResult, null, 'Isolated syncUniverse must not publish to storage');
      assert.strictEqual(networkAttempts, 0, 'Zero real network requests may escape when skipStorage: true is set');
    } finally {
      http.request = origHttpReq;
      https.request = origHttpsReq;
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.SUPABASE_STORAGE_BUCKET;
      for (const id of modIds) {
        if (savedCache.get(id)) require.cache[id] = savedCache.get(id);
        else delete require.cache[id];
      }
      ws.cleanup();
    }
  });

  // Helper: creates sample stats/stocks & builds consecutive valid 2026 trading dates
  function makeSamplePublishData(tradingDate, price = 1350, suffixHour = '15-00-00-000Z') {
    const isoUtc = `${tradingDate}T${suffixHour.replace(/-/g, ':').slice(0, 8)}.000Z`;
    return {
      stats: {
        tradingDate,
        nseSourceDate: tradingDate,
        bseSourceDate: tradingDate,
        refreshedAtUtc: isoUtc,
        istDisplayTime: `${tradingDate} 20:30:00 IST`,
        stockCount: 1,
        totalStocks: 1,
        pipelineVersion: '2.0.0'
      },
      stocks: [
        {
          isin: 'INE002A01018',
          symbol: 'RELIANCE',
          company_name: 'Reliance Industries Ltd',
          current_price: price,
          exchanges: ['NSE', 'BSE'],
          trading_date: tradingDate
        }
      ]
    };
  }

  function listStoreDatasetDates(store) {
    const dates = new Set();
    for (const k of store.keys()) {
      const m = k.match(/^datasets\/(\d{4}-\d{2}-\d{2})\//);
      if (m) dates.add(m[1]);
    }
    return [...dates].sort();
  }

  function listStoreDatasetPathsForDate(store, dateStr) {
    return [...store.keys()].filter(k => k.startsWith(`datasets/${dateStr}/`)).sort();
  }

  const consecutiveSessions92 = cal.getRecentTradingSessions('2026-12-24', 92);

  // 25. Retention: exactly 90 distinct trading sessions retained with zero deletions
  await runTest('25. Retention: 90 distinct trading sessions retained without deletions', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    const first90 = consecutiveSessions92.slice(0, 90);
    let lastRes = null;
    for (let i = 0; i < first90.length; i++) {
      const { stats, stocks } = makeSamplePublishData(first90[i], 1300 + i);
      lastRes = await storage.publishDatasetToStorage(stats, stocks);
      assert.strictEqual(lastRes.ok, true);
    }

    assert.strictEqual(mock.batchDeleteCalls.length, 0, '90 sessions must never trigger deletions');
    assert.strictEqual(lastRes.retention.ok, true);
    assert.strictEqual(lastRes.retention.retainSessions, 90);
    assert.strictEqual(lastRes.retention.deletedCount, 0);
    assert.strictEqual(lastRes.retention.retainedTradingDates.length, 90);
    assert.deepStrictEqual(listStoreDatasetDates(mock.store), first90);
  });

  // 26. Retention: 91st session removes only the oldest session
  await runTest('26. Retention: 91st trading session prunes oldest session and retains latest 90', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    mock.store.set('reference/benchmark_stocks_verified.json', '{"seed":true}');

    const sessions91 = consecutiveSessions92.slice(0, 91);
    let lastRes = null;
    for (let i = 0; i < sessions91.length; i++) {
      const { stats, stocks } = makeSamplePublishData(sessions91[i], 1300 + i);
      lastRes = await storage.publishDatasetToStorage(stats, stocks);
      assert.strictEqual(lastRes.ok, true);
    }

    assert.strictEqual(lastRes.retention.ok, true);
    assert.deepStrictEqual(lastRes.retention.expiredTradingDates, [sessions91[0]]);
    assert.strictEqual(lastRes.retention.deletedCount, 1);
    assert.strictEqual(lastRes.retention.retainedTradingDates.length, 90);
    assert.deepStrictEqual(listStoreDatasetDates(mock.store), sessions91.slice(1));
    assert(mock.store.has('latest.json'), 'latest.json must never be deleted');
    assert(mock.store.has('reference/benchmark_stocks_verified.json'), 'reference/ objects must never be deleted');
  });

  // 27. Retention: multiple versions on one trading date count as 1 session and all obsolete versions prune together
  await runTest('27. Retention: multiple versions of same trading date count as 1 session and prune together', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    // Publish session 0 three separate times (3 versions on day 1), then sessions 1..89 (total 90 distinct sessions)
    const d0 = consecutiveSessions92[0];
    for (const h of ['12-00-00-000Z', '13-00-00-000Z', '14-00-00-000Z']) {
      const { stats, stocks } = makeSamplePublishData(d0, 1300, h);
      const res = await storage.publishDatasetToStorage(stats, stocks);
      assert.strictEqual(res.ok, true);
    }
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, d0).length, 3);

    for (let i = 1; i < 90; i++) {
      const { stats, stocks } = makeSamplePublishData(consecutiveSessions92[i], 1300 + i);
      const res = await storage.publishDatasetToStorage(stats, stocks);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.retention.deletedCount, 0, 'Duplicate versions on day 0 must still count as only 90 distinct sessions');
    }
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, d0).length, 3, 'All 3 versions kept while within 90 distinct trading dates');

    // Now publish 91st distinct session -> all 3 obsolete versions belonging to d0 must be removed
    const { stats, stocks } = makeSamplePublishData(consecutiveSessions92[90], 1400);
    const res91 = await storage.publishDatasetToStorage(stats, stocks);
    assert.strictEqual(res91.ok, true);
    assert.strictEqual(res91.retention.ok, true);
    assert.strictEqual(res91.retention.deletedCount, 3, 'All 3 obsolete versions of expired session d0 must be pruned');
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, d0).length, 0);
    assert.strictEqual(listStoreDatasetDates(mock.store).length, 90);
  });

  // 28. Retention: failed publication triggers zero deletions and failed refreshes never count as retained sessions
  await runTest('28. Retention: failed publication triggers zero deletions & failed refreshes do not count as sessions', async () => {
    let failOnUpload = false;
    let corruptChecksumOn = null;
    const mock = makeMockSupabaseHttp({
      onGet: (objPath) => {
        if (corruptChecksumOn && objPath && objPath.includes(corruptChecksumOn)) {
          return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{"corrupt":true}') };
        }
        return null;
      },
      onPost: (objPath) => {
        if (failOnUpload && objPath === 'latest.json') {
          return { ok: false, statusCode: 500, headers: {}, body: Buffer.from('Pointer error') };
        }
        return null;
      }
    });
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {},
      maxRetries: 1
    });

    // Publish 89 sessions cleanly, attempt 1 failed session (checksum mismatch on session index 89), then publish session index 90
    for (let i = 0; i < 89; i++) {
      const { stats, stocks } = makeSamplePublishData(consecutiveSessions92[i], 1300 + i);
      assert.strictEqual((await storage.publishDatasetToStorage(stats, stocks)).ok, true);
    }

    // Attempt failed checksum publish on consecutiveSessions92[89] -> Phase 1 uploaded file, Phase 2 failed
    corruptChecksumOn = consecutiveSessions92[89];
    const failedChecksumRes = await storage.publishDatasetToStorage(
      makeSamplePublishData(consecutiveSessions92[89], 1350).stats,
      makeSamplePublishData(consecutiveSessions92[89], 1350).stocks
    );
    assert.strictEqual(failedChecksumRes.ok, false);
    assert.strictEqual(failedChecksumRes.phase, 'verify_checksum');
    assert.strictEqual(mock.batchDeleteCalls.length, 0, 'Failed publication must perform zero deletions');
    corruptChecksumOn = null;

    // Publish 90th actual session on consecutiveSessions92[90] -> total distinct successful sessions = 90
    // (failed consecutiveSessions92[89] orphan still sits under datasets/ but MUST NOT count toward the 90!)
    const ok90 = await storage.publishDatasetToStorage(
      makeSamplePublishData(consecutiveSessions92[90], 1360).stats,
      makeSamplePublishData(consecutiveSessions92[90], 1360).stocks
    );
    assert.strictEqual(ok90.ok, true);
    assert.strictEqual(ok90.retention.deletedCount, 0, 'Failed refresh artifact must not steal a slot or trigger pruning');
    assert(ok90.retention.ignoredUnpublishedOrFailedDates.includes(consecutiveSessions92[89]));
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, consecutiveSessions92[0]).length, 1);

    // Even with 90 successful sessions + 1 future failed pointer swap on consecutiveSessions92[91], zero deletions occur
    failOnUpload = true;
    const latestSnapshotBefore = mock.store.get('latest.json');
    const batchesBefore = mock.batchDeleteCalls.length;
    const failedSwapRes = await storage.publishDatasetToStorage(
      makeSamplePublishData(consecutiveSessions92[91], 1370).stats,
      makeSamplePublishData(consecutiveSessions92[91], 1370).stocks
    );
    assert.strictEqual(failedSwapRes.ok, false);
    assert.strictEqual(failedSwapRes.phase, 'swap_pointer');
    assert.strictEqual(mock.batchDeleteCalls.length, batchesBefore, 'Failed pointer swap must cause zero deletions');
    assert.strictEqual(mock.store.get('latest.json'), latestSnapshotBefore);
  });

  // 29. Retention: current latest, previousVersion, latest.json, locks/, reference/ are always protected
  await runTest('29. Retention: current latest, previousVersion, latest.json, locks/, and reference/ are protected', async () => {
    assert.strictEqual(isSafeDatasetPrunePath('latest.json'), false);
    assert.strictEqual(isSafeDatasetPrunePath('locks/refresh.lock.json'), false);
    assert.strictEqual(isSafeDatasetPrunePath('reference/benchmark.json'), false);
    assert.strictEqual(isSafeDatasetPrunePath('datasets/../latest.json'), false);
    assert.strictEqual(isSafeDatasetPrunePath('datasets/2026-11-25/stocks-dataset-2026-11-25-1.json'), true);

    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    mock.store.set('locks/manual.lock.json', '{"ownerId":"x"}');
    mock.store.set('reference/seed.json', '{"ok":true}');

    // Publish 91 sessions so sessions[0] would normally expire once session[90] arrives
    for (let i = 0; i < 91; i++) {
      const { stats, stocks } = makeSamplePublishData(consecutiveSessions92[i], 1300 + i);
      await storage.publishDatasetToStorage(stats, stocks, { skipRetention: true });
    }

    // Add a duplicate obsolete file on sessions[0], then manipulate latest.json so previousVersion points inside expired sessions[0]
    const oldestDate = consecutiveSessions92[0];
    const latestManifest = JSON.parse(mock.store.get('latest.json'));
    const oldestProtectedPath = listStoreDatasetPathsForDate(mock.store, oldestDate)[0];
    const oldestExtraObsolete = `datasets/${oldestDate}/stocks-dataset-${oldestDate}-obsolete-extra.json`;
    mock.store.set(oldestExtraObsolete, '{"extra":true}');

    latestManifest.previousVersion = {
      versionId: `${oldestDate}-protected`,
      tradingDate: oldestDate,
      datasetPath: oldestProtectedPath
    };
    mock.store.set('latest.json', JSON.stringify(latestManifest));

    const pruneRes = await storage.pruneOldDatasets();
    assert.strictEqual(pruneRes.ok, true);
    assert(mock.store.has(latestManifest.datasetPath), 'Current latest dataset must stay intact');
    assert(mock.store.has(oldestProtectedPath), 'previousVersion referenced by latest.json must NEVER be deleted even if older than 90 sessions');
    assert(!mock.store.has(oldestExtraObsolete), 'Unprotected extra file in expired session IS deleted');
    assert(mock.store.has('latest.json'));
    assert(mock.store.has('locks/manual.lock.json'));
    assert(mock.store.has('reference/seed.json'));
  });

  // 30. Retention: weekends and exchange holidays do not count as trading sessions
  await runTest('30. Retention: weekends and exchange holidays do not count toward 90 trading sessions', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    // Inject non-trading weekend & 2026 holiday folders into storage alongside 90 real trading sessions
    // (Include Muhurat Sunday 2026-11-08 which IS a trading session, inside 90 real sessions!)
    const first90WithMuhurat = cal.getRecentTradingSessions('2026-12-10', 90);
    assert(first90WithMuhurat.includes('2026-11-08'), 'Sanity check: 90-session slice includes Nov 8 Muhurat trading session');

    for (let i = 0; i < first90WithMuhurat.length; i++) {
      const dt = first90WithMuhurat[i];
      const { stats, stocks } = makeSamplePublishData(dt, 1300 + i);
      const res = await storage.publishDatasetToStorage(stats, stocks, { skipRetention: true });
      assert.strictEqual(res.ok, true);
    }

    // Plant weekend & holiday files (Sat 2026-11-21, Sun 2026-11-22, Guru Nanak Jayanti 2026-11-24, Diwali Balipratipada 2026-11-10)
    mock.store.set('datasets/2026-11-10/stocks-dataset-2026-11-10-12-00-00.json', '{"holiday":true}');
    mock.store.set('datasets/2026-11-21/stocks-dataset-2026-11-21-12-00-00.json', '{"weekend":true}');
    mock.store.set('datasets/2026-11-22/stocks-dataset-2026-11-22-12-00-00.json', '{"weekend":true}');
    mock.store.set('datasets/2026-11-24/stocks-dataset-2026-11-24-12-00-00.json', '{"holiday":true}');

    const prune90 = await storage.pruneOldDatasets();
    assert.strictEqual(prune90.ok, true);
    assert.strictEqual(prune90.totalSuccessfulSessions, 90, 'Only 90 real trading dates count (Muhurat Sun included; holidays/regular weekends excluded)');
    assert.strictEqual(prune90.deletedCount, 0, 'Holidays/weekends must NOT push the 90th trading session out');
    assert(prune90.ignoredNonTradingDates.includes('2026-11-10'));
    assert(prune90.ignoredNonTradingDates.includes('2026-11-21'));
    assert(prune90.ignoredNonTradingDates.includes('2026-11-24'));
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, first90WithMuhurat[0]).length, 1);

    // Publish 91st valid trading session -> oldest real trading session IS deleted while 90 valid sessions stay
    const nextSession = '2026-12-11';
    const { stats, stocks } = makeSamplePublishData(nextSession, 1400);
    const res91 = await storage.publishDatasetToStorage(stats, stocks);
    assert.strictEqual(res91.ok, true);
    assert.strictEqual(res91.retention.deletedCount, 1);
    assert.deepStrictEqual(res91.retention.expiredTradingDates, [first90WithMuhurat[0]]);
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, first90WithMuhurat[0]).length, 0);
  });

  // 31. Retention: failed cleanup preserves newly published latest dataset and can be safely retried idempotently
  await runTest('31. Retention: failed cleanup preserves newly published latest.json and retries idempotently', async () => {
    let failDeletes = false;
    const mock = makeMockSupabaseHttp({
      onBatchDelete: () => {
        if (failDeletes) {
          return { ok: false, statusCode: 500, headers: {}, body: Buffer.from('Storage delete unavailable') };
        }
        return null;
      }
    });
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {},
      maxRetries: 1
    });

    for (let i = 0; i < 90; i++) {
      const { stats, stocks } = makeSamplePublishData(consecutiveSessions92[i], 1300 + i);
      assert.strictEqual((await storage.publishDatasetToStorage(stats, stocks)).ok, true);
    }

    failDeletes = true;
    const day91 = consecutiveSessions92[90];
    const pub91 = await storage.publishDatasetToStorage(
      makeSamplePublishData(day91, 1555).stats,
      makeSamplePublishData(day91, 1555).stocks
    );

    // Publish must STILL succeed and expose latest dataset, while reporting retention failure separately
    assert.strictEqual(pub91.ok, true, 'Cleanup error must NOT fail the already-swapped publish');
    assert.strictEqual(pub91.retention.ok, false, 'Retention failure must be reported clearly');
    assert(pub91.retention.error.includes('500'));
    const liveLatest = await storage.fetchLatestDataset();
    assert.strictEqual(liveLatest.ok, true);
    assert.strictEqual(liveLatest.manifest.tradingDate, day91);
    assert.strictEqual(liveLatest.stocks[0].current_price, 1555);
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, consecutiveSessions92[0]).length, 1);

    // Clear storage fault & retry cleanup -> completes deletion and second retry is idempotent no-op
    failDeletes = false;
    const retry1 = await storage.pruneOldDatasets();
    assert.strictEqual(retry1.ok, true);
    assert.strictEqual(retry1.deletedCount, 1);
    assert.strictEqual(listStoreDatasetPathsForDate(mock.store, consecutiveSessions92[0]).length, 0);

    const retry2 = await storage.pruneOldDatasets();
    assert.strictEqual(retry2.ok, true);
    assert.strictEqual(retry2.deletedCount, 0, 'Idempotent retry after cleanup must perform 0 deletions');
  });

  // 32. Retention: dry-run mode reports exact planned deletions without deleting anything
  await runTest('32. Retention: dry-run reports exact planned deletions without modifying storage', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    for (let i = 0; i < 92; i++) {
      const { stats, stocks } = makeSamplePublishData(consecutiveSessions92[i], 1300 + i);
      assert.strictEqual((await storage.publishDatasetToStorage(stats, stocks, { skipRetention: true })).ok, true);
    }
    assert.strictEqual(listStoreDatasetDates(mock.store).length, 92);

    const dry = await storage.pruneOldDatasets({ dryRun: true });
    assert.strictEqual(dry.ok, true);
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(dry.deletedCount, 0);
    assert.deepStrictEqual(dry.expiredTradingDates, [consecutiveSessions92[0], consecutiveSessions92[1]]);
    assert.strictEqual(dry.plannedDeletions.length, 2);
    assert.strictEqual(mock.batchDeleteCalls.length, 0, 'Dry-run must send zero DELETE requests');
    assert.strictEqual(listStoreDatasetDates(mock.store).length, 92, 'All 92 dates must remain untouched after dry-run');

    const actual = await storage.pruneOldDatasets({ dryRun: false });
    assert.strictEqual(actual.ok, true);
    assert.strictEqual(actual.deletedCount, 2);
    assert.deepStrictEqual(actual.deletedPaths, dry.plannedDeletions);
    assert.strictEqual(listStoreDatasetDates(mock.store).length, 90);
  });

  // 33. Cold runner accumulates up to 90-session per-stock history via Supabase carryover & computes 1W/1M/3M returns
  await runTest('33. Cold runner preserves 90-session per-stock history via Supabase carryover & computes 1W/1M/3M returns', async () => {
    const ws = makeTempWorkspace('mb-90hist-');
    try {
      const mock = makeMockSupabaseHttp();
      const storage = createStorageClient({
        url: 'https://mock.supabase.co',
        serviceKey: 'mock-service-key',
        bucket: 'test-bucket',
        httpRequest: mock.httpRequest,
        sleep: async () => {}
      });

      const sessions90 = consecutiveSessions92.slice(0, 90);
      const day89 = sessions90[88];
      const day90 = sessions90[89];

      // Build 89-session prior dataset in Supabase with deterministic closes:
      // pos 65 from end (index 24) = 200, pos 21 from end (index 68) = 250, pos 5 from end (index 84) = 300
      const baseStocks = Array.from({ length: 10 }, (_, idx) => {
        const isin = idx === 0 ? 'INE002A01018' : `INE000A000${String(idx).padStart(2, '0')}`;
        const sym = idx === 0 ? 'RELIANCE' : `SYM${idx}`;
        const hist = sessions90.slice(0, 89).map((dt, j) => {
          let close = 150 + idx;
          if (idx === 0) {
            if (j === 24) close = 200;
            else if (j === 68) close = 250;
            else if (j === 84) close = 300;
            else close = 180 + (j % 10);
          }
          return { date: dt, close };
        });
        return {
          isin,
          symbol: sym,
          company_name: `${sym} Limited`,
          exchanges: ['NSE', 'BSE'],
          segment: 'Mainboard',
          series: 'EQ',
          current_price: hist[hist.length - 1].close,
          close_price: hist[hist.length - 1].close,
          prev_close: hist[hist.length - 2].close,
          volume: 1000,
          market_cap_cr: 10000 - idx * 100,
          trading_date: day89,
          historical_prices: hist
        };
      });

      const seedStats = {
        tradingDate: day89,
        nseSourceDate: day89,
        bseSourceDate: day89,
        refreshedAtUtc: `${day89}T12:00:00.000Z`,
        istDisplayTime: `${day89} IST`,
        stockCount: baseStocks.length,
        totalStocks: baseStocks.length
      };
      const firstPub = await storage.publishDatasetToStorage(seedStats, baseStocks, { skipRetention: true });
      assert.strictEqual(firstPub.ok, true);

      // Cold runner only downloads trailing 6 sessions (indices 84..89) for day90
      const downloader = createDownloader({
        downloadsDir: ws.downloadsDir,
        minNseRows: 10,
        minBseRows: 10,
        minBytes: 200,
        rateLimitMs: 0,
        sleep: async () => {},
        logger: silentLogger,
        httpGet: async (url) => {
          const matchedDate = sessions90.slice(-6).find(d => url.includes(d.replace(/-/g, '')));
          if (matchedDate) {
            const jIdx = sessions90.indexOf(matchedDate);
            const relPrice = matchedDate === day90 ? 330 : (jIdx === 84 ? 300 : 305);
            const buildWithCustomRel = (ex) => {
              const csv = buildBhavcopyCsv(ex, matchedDate);
              return csv.replace(
                /1300\.00,1325\.00,1295\.00,1320\.00,1320\.00,1310\.00,,1320\.00/,
                `${relPrice},${relPrice + 5},${relPrice - 5},${relPrice},${relPrice},${relPrice - 2},,${relPrice}`
              );
            };
            if (url.includes('BhavCopy_NSE_CM') && url.endsWith('.zip')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: buildZipBuffer(getNseFilename(matchedDate), buildWithCustomRel('NSE')) };
            }
            if (url.includes('BhavCopy_BSE_CM')) {
              return { ok: true, statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, buffer: Buffer.from(buildWithCustomRel('BSE')) };
            }
          }
          return { ok: false, statusCode: 404, headers: {}, buffer: Buffer.alloc(0) };
        }
      });

      const refreshOut = await runRefresh({
        downloadsDir: ws.downloadsDir,
        targetPath: ws.targetPath,
        backupPath: ws.backupPath,
        downloader,
        storageClient: storage,
        minRows: 10,
        minBytes: 200,
        minSourceRows: 10,
        minUniverseSize: 10,
        skipReport: true,
        marketCapSources: emptyMcapSources,
        now: new Date(`${day90}T20:00:00+05:30`),
        logger: silentLogger
      });

      assert.strictEqual(refreshOut.ok, true);
      assert.strictEqual(refreshOut.tradingDate, day90);
      assert.strictEqual(refreshOut.marketStats.historicalSessions.sessionCount, 90);
      assert.strictEqual(refreshOut.marketStats.historicalSessions.maxSessions, 90);

      const latestAfter = await storage.fetchLatestDataset();
      assert.strictEqual(latestAfter.ok, true);
      const relDaily = latestAfter.stocks.find(s => s.isin === 'INE002A01018');
      assert.strictEqual(relDaily.historical_prices, undefined, 'Daily snapshot in storage must NOT duplicate 90-session historical_prices');
      assert.strictEqual(relDaily.sparkline_7d.length, 6);
      assert.strictEqual(relDaily.return_1w, 10, '300 -> 330 over 6 sessions = +10%');
      assert.strictEqual(relDaily.return_1m, 32, '250 -> 330 over 22 sessions = +32%');
      assert.strictEqual(relDaily.return_3m, 65, '200 -> 330 over 66 sessions = +65%');

      const histAfter = await storage.fetchHistoricalDataset(latestAfter.manifest);
      assert.strictEqual(histAfter.ok, true);
      const relExpanded = expandHistoricalPricesForIsin(histAfter.history, 'INE002A01018');
      assert.strictEqual(relExpanded.length, 90);
      assert.strictEqual(relExpanded[0].date, sessions90[0]);
      assert.strictEqual(relExpanded[89].date, day90);
      assert.strictEqual(relExpanded[89].close, 330);

      // Verify read-only query layer hydrates historical_prices cleanly for stock details & /api/market/history
      resetCacheForTests();
      const apiDetail = await queryStocksAsync({ isin: 'INE002A01018', limit: '1' }, { storageClient: storage });
      assert.strictEqual(apiDetail.ok, true);
      assert.strictEqual(apiDetail.stocks[0].historical_prices.length, 90);
      const apiHistory = await queryStockHistoryAsync({ isin: 'INE002A01018' }, { storageClient: storage });
      assert.strictEqual(apiHistory.ok, true);
      assert.strictEqual(apiHistory.sessionCount, 90);
      assert.strictEqual(apiHistory.historical_prices[89].close, 330);
      resetCacheForTests();
    } finally {
      ws.cleanup();
    }
  });

  // 34. Incremental daily history updates, duplicate prevention, rolling history cleanup & illiquid gaps
  await runTest('34. Incremental history updates, duplicate reuse, illiquid null preservation & failure-safe cleanup', async () => {
    const mock = makeMockSupabaseHttp();
    const storage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      bucket: 'test-bucket',
      httpRequest: mock.httpRequest,
      sleep: async () => {}
    });

    const sess4 = consecutiveSessions92.slice(0, 4);
    for (let idx = 0; idx < 3; idx++) {
      const dt = sess4[idx];
      const histRel = sess4.slice(0, idx + 1).map((d, j) => ({ date: d, close: 100 + j }));
      const stocks = [
        {
          isin: 'INE002A01018',
          symbol: 'RELIANCE',
          company_name: 'Reliance Industries Ltd',
          current_price: 100 + idx,
          exchanges: ['NSE', 'BSE'],
          trading_date: dt,
          historical_prices: histRel
        },
        {
          // Illiquid equity skipped sess4[1] intentionally (gap preserved, never fabricated)
          isin: 'INE000A00099',
          symbol: 'ILLIQ',
          company_name: 'Illiquid Co Ltd',
          current_price: 50,
          exchanges: ['BSE'],
          trading_date: dt,
          historical_prices: idx === 0
            ? [{ date: sess4[0], close: 50 }]
            : [{ date: sess4[0], close: 50 }, { date: sess4[idx], close: 50 }]
        }
      ];
      const stats = {
        tradingDate: dt,
        nseSourceDate: dt,
        bseSourceDate: dt,
        refreshedAtUtc: `${dt}T15:00:00.000Z`,
        istDisplayTime: `${dt} 20:30:00 IST`,
        stockCount: 2,
        totalStocks: 2
      };
      const pub = await storage.publishDatasetToStorage(stats, stocks, {
        retainSessions: 90,
        retainHistorySessions: 2
      });
      assert.strictEqual(pub.ok, true);
    }

    // Only 2 history versions remain after 3 publishes with retainHistorySessions: 2, while all 3 daily datasets remain
    const historyKeys = [...mock.store.keys()].filter(k => k.startsWith('history/'));
    const datasetKeys = [...mock.store.keys()].filter(k => k.startsWith('datasets/'));
    assert.strictEqual(datasetKeys.length, 3, 'All 3 daily snapshots stay within 90-session limit');
    assert.strictEqual(historyKeys.length, 2, 'Oldest history snapshot pruned while keeping active + previousVersion');
    assert.ok(!historyKeys.some(k => k.includes(sess4[0])));

    const latestHist = await storage.fetchHistoricalDataset();
    assert.strictEqual(latestHist.ok, true);
    const illiqPrices = expandHistoricalPricesForIsin(latestHist.history, 'INE000A00099');
    assert.strictEqual(illiqPrices.length, 2, 'Missing middle day must remain null and never be fabricated');
  });

  console.log('\n================================================================');
  console.log(` PIPELINE TEST SUITE SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log('================================================================\n');

  if (failed > 0) process.exit(1);
}

runAll().catch(err => {
  console.error('Pipeline test suite crashed:', err);
  process.exit(1);
});
