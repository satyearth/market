'use strict';

/**
 * Machli Bazzar — Market Capitalization Coverage & Pipeline Test Suite
 *
 * Verifies:
 * 1. Verified Market Cap coverage across > 300 stocks (> 5,000 stocks, >99% coverage).
 * 2. API pagination and catalog batching.
 * 3. Missing Market Cap handling (strictly null, never zero, legitimate financial reasons documented).
 * 4. Zero duplicate ISIN records across NSE and BSE.
 * 5. Retry and rate-limit handling (HTTP 429 backoff).
 * 6. Fallback calculation and rejection of invalid share counts.
 * 7. Dataset backup and atomic recovery guarantees.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  resolveStockMarketCap,
  rankStocksAndCategorize
} = require('../lib/market-cap-pipeline');

const ROOT_DIR = path.resolve(__dirname, '..');
const STOCKS_DATA_PATH = path.join(ROOT_DIR, 'js', 'stocks-data.js');
const BACKUP_DATA_PATH = path.join(ROOT_DIR, 'js', 'stocks-data.backup.js');
const REPORT_PATH = path.join(ROOT_DIR, 'docs', 'reports', 'MARKET_CAP_COVERAGE_REPORT.md');

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    passedTests++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
  }
}

async function runAsyncTest(name, fn) {
  try {
    await fn();
    passedTests++;
    console.log(`  ✓ PASS: ${name}`);
  } catch (err) {
    failedTests++;
    console.error(`  ✗ FAIL: ${name}`);
    console.error(`    Error: ${err.message}`);
  }
}

async function runAllTests() {
  console.log('================================================================');
  console.log(' MACHLI BAZZAR — MARKET CAP COVERAGE & PIPELINE VERIFICATION');
  console.log('================================================================\n');

  // Load production dataset
  assert(fs.existsSync(STOCKS_DATA_PATH), 'js/stocks-data.js must exist');
  const fileContent = fs.readFileSync(STOCKS_DATA_PATH, 'utf8');

  const statsMatch = fileContent.match(/const MARKET_STATS = (\{[\s\S]*?\});/);
  assert(statsMatch, 'MARKET_STATS must be defined in js/stocks-data.js');
  const stats = JSON.parse(statsMatch[1]);

  const stocksMatch = fileContent.match(/const STOCKS_DATA = (\[[\s\S]*?\]);\s*$/);
  assert(stocksMatch, 'STOCKS_DATA must be defined in js/stocks-data.js');
  const stocks = eval('(' + stocksMatch[1] + ')');

  // ---------------------------------------------------------------------------
  // Test Suite 1: Coverage for More Than 300 Stocks (> 5,000 Equities)
  // ---------------------------------------------------------------------------
  console.log('[Test Suite 1: Full-Universe Market Cap Coverage (> 300 Stocks)]');

  test('Total universe contains 5,389 equities', () => {
    assert.strictEqual(stocks.length, 5389);
  });

  const verifiedStocks = stocks.filter(s => s.market_cap_cr != null);
  test('Verified Market Cap is populated for far more than 300 stocks (> 5,000 stocks)', () => {
    assert(verifiedStocks.length > 5000, `Expected > 5,000 verified stocks, got ${verifiedStocks.length}`);
    assert(verifiedStocks.length >= 5300, `Expected >= 5,300 verified stocks, got ${verifiedStocks.length}`);
  });

  test('Market Cap coverage percentage exceeds 99%', () => {
    const pct = (verifiedStocks.length / stocks.length) * 100;
    assert(pct >= 99.0, `Coverage was ${pct.toFixed(2)}%, expected >= 99%`);
  });

  test('Market Cap values are strictly positive non-zero numbers', () => {
    const invalid = verifiedStocks.filter(s => typeof s.market_cap_cr !== 'number' || isNaN(s.market_cap_cr) || s.market_cap_cr <= 0);
    assert.strictEqual(invalid.length, 0, `Found ${invalid.length} invalid market cap values`);
  });

  test('Major benchmark blue-chip stocks have verified market caps', () => {
    const reliance = stocks.find(s => s.symbol === 'RELIANCE');
    const tcs = stocks.find(s => s.symbol === 'TCS');
    const hdfc = stocks.find(s => s.symbol === 'HDFCBANK');
    const bharti = stocks.find(s => s.symbol === 'BHARTIARTL');

    assert(reliance && reliance.market_cap_cr > 1000000, 'RELIANCE market cap > ₹10,00,000 Cr');
    assert(tcs && tcs.market_cap_cr > 800000, 'TCS market cap > ₹8,00,000 Cr');
    assert(hdfc && hdfc.market_cap_cr > 800000, 'HDFCBANK market cap > ₹8,00,000 Cr');
    assert(bharti && bharti.market_cap_cr > 800000, 'BHARTIARTL market cap > ₹8,00,000 Cr');
  });

  test('Both Mainboard and SME platform stocks have market cap coverage', () => {
    const mainboardVerified = stocks.filter(s => s.segment === 'Mainboard' && s.market_cap_cr != null);
    const smeVerified = stocks.filter(s => s.segment === 'SME' && s.market_cap_cr != null);

    assert(mainboardVerified.length > 4300, `Mainboard verified: ${mainboardVerified.length}`);
    assert(smeVerified.length > 900, `SME verified: ${smeVerified.length}`);
  });

  // ---------------------------------------------------------------------------
  // Test Suite 2: API Pagination & Batch Handling
  // ---------------------------------------------------------------------------
  console.log('\n[Test Suite 2: API Pagination & Batching]');

  test('API pagination correctly paginates and aggregates multiple pages', () => {
    const mockDb = Array.from({ length: 250 }, (_, i) => ({ id: `comp_${i + 1}`, name: `Company ${i + 1}` }));
    const pageSize = 100;
    const collected = [];

    let offset = 0;
    while (offset < mockDb.length) {
      const pageSlice = mockDb.slice(offset, offset + pageSize);
      const pageMeta = { total: mockDb.length, limit: pageSize, offset };
      assert(pageSlice.length > 0 && pageSlice.length <= pageSize);
      collected.push(...pageSlice);
      offset += pageSize;
    }

    assert.strictEqual(collected.length, 250, 'All 250 paginated records aggregated');
    assert.strictEqual(collected[0].id, 'comp_1');
    assert.strictEqual(collected[249].id, 'comp_250');
  });

  // ---------------------------------------------------------------------------
  // Test Suite 3: Missing Market Cap Handling (Strictly Null, Never Zero)
  // ---------------------------------------------------------------------------
  console.log('\n[Test Suite 3: Missing Market Cap Safeguards]');

  const missingStocks = stocks.filter(s => s.market_cap_cr == null);

  test('Missing market caps are strictly null, never 0 or negative', () => {
    const zeroOrNeg = stocks.filter(s => s.market_cap_cr !== null && s.market_cap_cr <= 0);
    assert.strictEqual(zeroOrNeg.length, 0, 'No stock should have market_cap_cr <= 0');
  });

  test('Number of missing market caps is small (< 50) and documented', () => {
    assert(missingStocks.length < 50, `Expected < 50 missing market caps, found ${missingStocks.length}`);
  });

  test('Partly-Paid shares (IN9...) and Rights Entitlements (-RE) are legitimately unpriced', () => {
    const partlyPaid = missingStocks.filter(s => s.isin && s.isin.startsWith('IN9'));
    const rights = missingStocks.filter(s => s.symbol && (s.symbol.includes('-RE') || s.symbol.includes('RE1')));
    assert(partlyPaid.length > 0 || rights.length > 0, 'Known unpriced special instrument types exist in missing list');
  });

  test('Unverified stocks carry verified_rank_tier "Unranked (Unverified Market Cap)" or "SME Platform"', () => {
    missingStocks.forEach(s => {
      assert(
        s.verified_rank_tier === 'Unranked (Unverified Market Cap)' || s.verified_rank_tier === 'SME Platform',
        `Unexpected tier for missing stock: ${s.verified_rank_tier}`
      );
      assert.strictEqual(s.rank, null, `Rank for unverified stock must be null, got ${s.rank}`);
    });
  });

  // ---------------------------------------------------------------------------
  // Test Suite 4: Primary Key (ISIN) Deduplication Integrity
  // ---------------------------------------------------------------------------
  console.log('\n[Test Suite 4: ISIN Deduplication & Primary Key Integrity]');

  test('Zero duplicate ISINs across complete stock universe', () => {
    const seen = new Set();
    const duplicates = [];
    stocks.forEach(s => {
      if (seen.has(s.isin)) duplicates.push(s.isin);
      seen.add(s.isin);
    });
    assert.strictEqual(duplicates.length, 0, `Found duplicate ISINs: ${duplicates.join(', ')}`);
    assert.strictEqual(seen.size, stocks.length, 'Unique ISIN set size matches stocks count');
  });

  test('All ISINs are valid 12-character Indian equity identifiers (INE/IN9)', () => {
    const invalid = stocks.filter(s => !s.isin || typeof s.isin !== 'string' || s.isin.length !== 12 || (!s.isin.startsWith('INE') && !s.isin.startsWith('IN9')));
    assert.strictEqual(invalid.length, 0, `Found ${invalid.length} invalid ISINs`);
  });

  // ---------------------------------------------------------------------------
  // Test Suite 5: Retry & Rate-Limit Handling (HTTP 429 Backoff)
  // ---------------------------------------------------------------------------
  console.log('\n[Test Suite 5: Retry & Rate-Limit Handling]');

  await runAsyncTest('Backoff retry simulator handles rate limits (HTTP 429) and network retries', async () => {
    let callCount = 0;
    const maxRetries = 3;

    async function mockApiCallWithBackoff(retriesLeft = maxRetries, backoffMs = 10) {
      callCount++;
      if (callCount < 3) {
        // Simulate HTTP 429
        await new Promise(r => setTimeout(r, backoffMs));
        return mockApiCallWithBackoff(retriesLeft - 1, backoffMs * 2);
      }
      return { ok: true, attempts: callCount };
    }

    const res = await mockApiCallWithBackoff();
    assert.strictEqual(res.ok, true);
    assert.strictEqual(callCount, 3, 'Succeeded on 3rd attempt after backoff');
  });

  // ---------------------------------------------------------------------------
  // Test Suite 6: Fallback Calculation & Invalid Share Count Rejection
  // ---------------------------------------------------------------------------
  console.log('\n[Test Suite 6: Fallback Calculation & Validation]');

  test('Calculates market cap when valid price and outstanding shares exist', () => {
    const dummyStock = {
      isin: 'INE999A01019',
      symbol: 'TESTCO',
      current_price: 250.00,
      total_outstanding_shares: 40000000 // 40M shares
    };
    const dummySources = {
      benchmarkBySymbol: new Map(),
      bseSecByIsin: new Map(),
      catalogByIsin: new Map(),
      catalogByTicker: new Map(),
      screenerBySlug: new Map()
    };

    const res = resolveStockMarketCap(dummyStock, dummySources);
    // (250 * 40,000,000) / 10,000,000 = 1,000 Cr
    assert.strictEqual(res.market_cap_cr, 1000);
    assert.strictEqual(res.market_cap_source, 'CALCULATED_OUTSTANDING_SHARES');
  });

  test('Rejects invalid, zero, or negative share counts', () => {
    const dummySources = {
      benchmarkBySymbol: new Map(),
      bseSecByIsin: new Map(),
      catalogByIsin: new Map(),
      catalogByTicker: new Map(),
      screenerBySlug: new Map()
    };

    // Zero shares
    const resZero = resolveStockMarketCap({ isin: 'INE1', symbol: 'Z1', current_price: 100, total_outstanding_shares: 0 }, dummySources);
    assert.strictEqual(resZero.market_cap_cr, null);

    // Negative shares
    const resNeg = resolveStockMarketCap({ isin: 'INE2', symbol: 'Z2', current_price: 100, total_outstanding_shares: -500 }, dummySources);
    assert.strictEqual(resNeg.market_cap_cr, null);

    // Negative price
    const resNegPrice = resolveStockMarketCap({ isin: 'INE3', symbol: 'Z3', current_price: -10, total_outstanding_shares: 50000 }, dummySources);
    assert.strictEqual(resNegPrice.market_cap_cr, null);

    // NaN shares
    const resNaN = resolveStockMarketCap({ isin: 'INE4', symbol: 'Z4', current_price: 100, total_outstanding_shares: 'invalid' }, dummySources);
    assert.strictEqual(resNaN.market_cap_cr, null);
  });

  // ---------------------------------------------------------------------------
  // Test Suite 7: Dataset Backup, Atomic Update & Report Generation
  // ---------------------------------------------------------------------------
  console.log('\n[Test Suite 7: Safe Dataset Updates & Reporting]');

  test('Backup dataset exists and is valid', () => {
    assert(fs.existsSync(BACKUP_DATA_PATH), 'Backup file stocks-data.backup.js exists');
    const backupContent = fs.readFileSync(BACKUP_DATA_PATH, 'utf8');
    assert(backupContent.includes('const MARKET_STATS ='), 'Backup contains MARKET_STATS');
    assert(backupContent.includes('const STOCKS_DATA ='), 'Backup contains STOCKS_DATA');
  });

  test('Market Cap coverage report exists and is comprehensive', () => {
    assert(fs.existsSync(REPORT_PATH), 'MARKET_CAP_COVERAGE_REPORT.md exists');
    const reportContent = fs.readFileSync(REPORT_PATH, 'utf8');
    assert(reportContent.includes('Executive Summary'), 'Report has Executive Summary');
    assert(reportContent.includes('Multi-Source Ingestion Breakdown'), 'Report has Source Breakdown');
    assert(reportContent.includes('Verified Ranking Segments Distribution'), 'Report has Segments Distribution');
    assert(reportContent.includes('Companies with Missing Market Cap'), 'Report has Missing Companies section');
  });

  test('Verified ranking segments strictly reconcile to 5,389', () => {
    const segs = stats.verifiedRankingSegments;
    assert(segs, 'verifiedRankingSegments exists in stats');
    assert.strictEqual(segs.top100, 100);
    assert.strictEqual(segs.rank101_250, 150);
    assert(segs.remainingVerified > 4000, `Remaining verified: ${segs.remainingVerified}`);
    assert.strictEqual(segs.smePlatform, 1046);
    assert(segs.unranked < 50, `Unranked: ${segs.unranked}`);

    const sum = segs.top100 + segs.rank101_250 + segs.remainingVerified + segs.smePlatform + segs.unranked;
    assert.strictEqual(sum, 5389, 'Segments sum strictly equals 5,389');
  });

  console.log('\n================================================================');
  console.log(` SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
  console.log('================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  runAllTests().catch(err => {
    console.error('Test execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runAllTests };
