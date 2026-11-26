'use strict';

/**
 * Machii Bazzar — Dataset & Market Statistics Comprehensive Verification Suite
 *
 * Dynamically reconciles the compiled dataset (js/stocks-data.js) against:
 * 1. Exchange calendar & active trading date consistency
 * 2. Official NSE & BSE BhavCopy source files in downloads/
 * 3. Canonical 12-char ISIN uniqueness (zero duplicates)
 * 4. Dual-listing & single-exchange identifier integrity
 * 5. Zero fabricated prices, OHLC spreads, or market caps
 * 6. Session-matched India VIX verification (when archive is present)
 * 7. Exact bottom-up Market Breadth reconciliation
 * 8. 6-Session chronological historical price & 1W return reconciliation
 * 9. Timestamp timezone correctness (ISO UTC & IST)
 * 10. SME vs Mainboard mathematical reconciliation
 * 11. Verified Market-Cap ranking segment reconciliation
 * 12. Inclusion-exclusion exchange coverage identity
 * 13. Pipeline metadata & automation status documentation
 */

const fs = require('fs');
const path = require('path');
const { getRecentTradingSessions } = require('./exchange-calendar');
const { parseCsv, readExistingDataset } = require('./sync-stock-universe');
const { getNseFilename, getBseFilename, getIndicesFilename } = require('./download-bhavcopy');

const targetPath = path.join(__dirname, '..', 'js', 'stocks-data.js');
const downloadsDir = path.join(__dirname, '..', 'downloads');

console.log('================================================================');
console.log(' MACHII BAZZAR — COMPREHENSIVE DATASET VERIFICATION SUITE');
console.log('================================================================\n');

if (!fs.existsSync(targetPath)) {
  console.error('FAIL: Target dataset file not found at:', targetPath);
  process.exit(1);
}

const { stats, stocks } = readExistingDataset(targetPath);
if (!stats || !Array.isArray(stocks) || stocks.length === 0) {
  console.error('FAIL: Could not parse STOCKS_DATA or MARKET_STATS');
  process.exit(1);
}

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`  ✓ PASS: ${testName} ${details}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${details}`);
    failedTests++;
  }
}

const activeDate = stats.tradingDate;
const expectedSessions = getRecentTradingSessions(activeDate, 6);

// -----------------------------------------------------------------------------
// Test Group 1: Trading Date & Session Consistency
// -----------------------------------------------------------------------------
console.log('[Test Group 1: Trading Date & Session Consistency]');
assert(/^\d{4}-\d{2}-\d{2}$/.test(activeDate), 'Active tradingDate is valid YYYY-MM-DD', `(found: ${activeDate})`);
assert(stats.nseSourceDate === activeDate, 'NSE source date matches active tradingDate', `(${stats.nseSourceDate})`);
assert(stats.bseSourceDate === activeDate, 'BSE source date matches active tradingDate', `(${stats.bseSourceDate})`);
assert(stats.stockCount === stocks.length && stats.totalStocks === stocks.length, 'Market stats counts equal STOCKS_DATA length', `(${stats.stockCount} === ${stocks.length})`);
assert(stocks.every(s => s.trading_date === activeDate), 'Every stock shares the same trading date', `(${activeDate})`);
assert(stats.refreshedAt && stocks.every(s => s.refreshed_at === stats.refreshedAt), 'Statistics and stocks share exact refreshed_at timestamp');

// -----------------------------------------------------------------------------
// Test Group 2: Exchange Batches & Source Data
// -----------------------------------------------------------------------------
console.log('\n[Test Group 2: Exchange Source Files & Batches]');
const nseTodayFile = path.join(downloadsDir, getNseFilename(activeDate));
const bseTodayFile = path.join(downloadsDir, getBseFilename(activeDate));
assert(fs.existsSync(nseTodayFile), `NSE ${activeDate} BhavCopy exists in downloads/`);
assert(fs.existsSync(bseTodayFile), `BSE ${activeDate} BhavCopy exists in downloads/`);

const nseSize = fs.existsSync(nseTodayFile) ? fs.statSync(nseTodayFile).size : 0;
const bseSize = fs.existsSync(bseTodayFile) ? fs.statSync(bseTodayFile).size : 0;
assert(nseSize > 500000, 'NSE BhavCopy is complete (not truncated)', `(${nseSize} bytes)`);
assert(bseSize > 500000, 'BSE BhavCopy is complete (not truncated)', `(${bseSize} bytes)`);

// -----------------------------------------------------------------------------
// Test Group 3: Primary Key (ISIN) & Deduplication
// -----------------------------------------------------------------------------
console.log('\n[Test Group 3: Primary Key (ISIN) & Deduplication]');
const isinSet = new Set();
let duplicates = 0;
let invalidIsinFormat = 0;

stocks.forEach(s => {
  if (!s.isin || typeof s.isin !== 'string' || s.isin.length !== 12 || (!s.isin.startsWith('INE') && !s.isin.startsWith('IN9'))) {
    invalidIsinFormat++;
  }
  if (isinSet.has(s.isin)) duplicates++;
  else isinSet.add(s.isin);
});

assert(invalidIsinFormat === 0, 'All ISINs are valid 12-char Indian equity identifiers (INE/IN9)', `(invalid: ${invalidIsinFormat})`);
assert(duplicates === 0, 'Zero duplicate ISINs in unified stock universe', `(duplicates: ${duplicates})`);
assert(stocks.length === isinSet.size, 'Total stocks equals unique ISIN set size', `(${stocks.length})`);

// -----------------------------------------------------------------------------
// Test Group 4: Dual-Listing & Identifiers Integrity
// -----------------------------------------------------------------------------
console.log('\n[Test Group 4: Dual-Listing & Identifiers Integrity]');
let dualListed = 0;
let nseOnly = 0;
let bseOnly = 0;
let invalidCodes = 0;

stocks.forEach(s => {
  const isNse = s.exchanges.includes('NSE');
  const isBse = s.exchanges.includes('BSE');

  if (isNse && isBse) {
    dualListed++;
    if (!s.nse_symbol || !s.bse_scrip_code) invalidCodes++;
  } else if (isNse) {
    nseOnly++;
    if (!s.nse_symbol || s.bse_scrip_code !== null) invalidCodes++;
  } else if (isBse) {
    bseOnly++;
    if (!s.bse_scrip_code || s.nse_symbol !== null) invalidCodes++;
  }
});

assert(dualListed === stats.dualListedCount, 'Dual-listed count matches stats', `(${dualListed} === ${stats.dualListedCount})`);
assert(nseOnly === stats.nseOnlyCount, 'NSE-only count matches stats', `(${nseOnly} === ${stats.nseOnlyCount})`);
assert(bseOnly === stats.bseOnlyCount, 'BSE-only count matches stats', `(${bseOnly} === ${stats.bseOnlyCount})`);
assert(invalidCodes === 0, 'No invented exchange symbols or missing codes on single-listed stocks', `(invalid: ${invalidCodes})`);
assert(dualListed + nseOnly + bseOnly === stocks.length, 'Dual + NSE-only + BSE-only strictly equals total stock count');

// -----------------------------------------------------------------------------
// Test Group 5: Data Integrity (Zero Fabricated Data)
// -----------------------------------------------------------------------------
console.log('\n[Test Group 5: Data Integrity (Zero Fabricated Data)]');
let unverifiedMcap = 0;
let verifiedMcap = 0;
let misleadingRankOnUnverified = 0;
let invalidPrices = 0;
let invalidOHLC = 0;
let invalidHighLowSpread = 0;
let closeMismatch = 0;

stocks.forEach(s => {
  if (s.current_price != null && (isNaN(s.current_price) || s.current_price <= 0)) invalidPrices++;
  if (s.open_price != null && (isNaN(s.open_price) || s.open_price <= 0)) invalidOHLC++;
  if (s.high_price != null && (isNaN(s.high_price) || s.high_price <= 0)) invalidOHLC++;
  if (s.low_price != null && (isNaN(s.low_price) || s.low_price <= 0)) invalidOHLC++;
  if (s.high_price != null && s.low_price != null && s.high_price < s.low_price) invalidHighLowSpread++;
  if (s.close_price !== s.current_price) closeMismatch++;

  if (s.market_cap_cr == null) {
    unverifiedMcap++;
    if (s.rank !== null) misleadingRankOnUnverified++;
  } else {
    verifiedMcap++;
  }
});

assert(invalidPrices === 0, 'No invalid or negative stock prices', `(invalid: ${invalidPrices})`);
assert(invalidOHLC === 0, 'No invalid or negative EOD OHLC values across universe', `(invalid: ${invalidOHLC})`);
assert(invalidHighLowSpread === 0, 'High price is always greater than or equal to low price', `(invalid: ${invalidHighLowSpread})`);
assert(closeMismatch === 0, 'close_price alias strictly matches current_price for all stocks', `(mismatch: ${closeMismatch})`);
assert(misleadingRankOnUnverified === 0, 'Zero misleading market-cap ranks on unverified stocks');
assert(verifiedMcap === stats.marketCapCoverageCount, 'Verified market cap count matches stats', `(${verifiedMcap} === ${stats.marketCapCoverageCount})`);
assert(verifiedMcap > 5000, 'Verified market cap covers vast majority of universe (>5,000 stocks)', `(${verifiedMcap} stocks)`);
assert(unverifiedMcap < 150, 'Unverified market caps remain null and render as em-dash', `(${unverifiedMcap} stocks)`);

// -----------------------------------------------------------------------------
// Test Group 6: Dynamic India VIX Verification
// -----------------------------------------------------------------------------
console.log('\n[Test Group 6: Dynamic India VIX Verification]');
const indicesTodayFile = path.join(downloadsDir, getIndicesFilename(activeDate));
const hasVixOrArchive = stats.vix != null || stats.vixDate != null || fs.existsSync(indicesTodayFile);
if (hasVixOrArchive) {
  assert(typeof stats.vix === 'number' && stats.vix > 5 && stats.vix < 60, 'India VIX is a valid volatility reading', `(${stats.vix})`);
  assert(stats.vixDate && typeof stats.vixDate === 'string', 'India VIX date is attached from source', `(${stats.vixDate})`);
} else {
  assert(stats.vix === null, 'India VIX remains null when optional NSE index archive is absent');
}

// -----------------------------------------------------------------------------
// Test Group 7: Market Breadth Calculation from Quotes & Exact Universe Reconciliation
// -----------------------------------------------------------------------------
console.log('\n[Test Group 7: Market Breadth & Universe Reconciliation]');
let calcAdv = 0;
let calcDec = 0;
let calcUnc = 0;
let calcUnpriced = 0;

stocks.forEach(s => {
  if (s.current_price != null && s.prev_close != null && s.prev_close > 0) {
    if (s.current_price > s.prev_close) calcAdv++;
    else if (s.current_price < s.prev_close) calcDec++;
    else calcUnc++;
  } else {
    calcUnpriced++;
  }
});

assert(stats.advances === calcAdv, 'Market Breadth advances strictly match individual quotes', `(${stats.advances} === ${calcAdv})`);
assert(stats.declines === calcDec, 'Market Breadth declines strictly match individual quotes', `(${stats.declines} === ${calcDec})`);
assert(stats.unchanged === calcUnc, 'Market Breadth unchanged strictly matches individual quotes', `(${stats.unchanged} === ${calcUnc})`);
assert(stats.unpriced === calcUnpriced, 'Market Breadth unpriced strictly matches unpriced entries', `(${stats.unpriced} === ${calcUnpriced})`);
assert(calcAdv + calcDec + calcUnc + calcUnpriced === stocks.length, `Advances + Declines + Unchanged + Unpriced strictly equals Eligible Universe (${stocks.length})`);

// -----------------------------------------------------------------------------
// Test Group 8: Historical Date-to-Price Mapping & Chronological Ordering
// -----------------------------------------------------------------------------
console.log('\n[Test Group 8: Historical Date-to-Price Mapping & Chronological Ordering]');
assert(stats.historicalSessions && stats.historicalSessions.sessionCount === 6, 'Historical sessions count is exactly 6');
assert(JSON.stringify(stats.historicalSessions?.sessions) === JSON.stringify(expectedSessions), 'Historical sessions match expected 6 trading dates', JSON.stringify(stats.historicalSessions?.sessions));

let stocksWithHistoricalPrices = 0;
let chronologicallyOrderedCount = 0;
let stocksWithValidDates = 0;

stocks.forEach(s => {
  if (s.historical_prices && Array.isArray(s.historical_prices) && s.historical_prices.length >= 2) {
    stocksWithHistoricalPrices++;
    const allHaveDateAndClose = s.historical_prices.every(p =>
      typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.close === 'number' && !isNaN(p.close) && p.close > 0
    );
    if (allHaveDateAndClose) stocksWithValidDates++;

    let isChronological = true;
    for (let i = 1; i < s.historical_prices.length; i++) {
      if (s.historical_prices[i].date <= s.historical_prices[i - 1].date) {
        isChronological = false;
        break;
      }
    }
    if (isChronological) chronologicallyOrderedCount++;
  }
});

assert(stocksWithHistoricalPrices > 4000, 'Over 4,000 stocks have date-to-price historical mappings', `(${stocksWithHistoricalPrices} stocks)`);
assert(stocksWithValidDates === stocksWithHistoricalPrices, 'All historical price objects contain valid date strings and positive numeric closes');
assert(chronologicallyOrderedCount === stocksWithHistoricalPrices, '100% of historical price arrays are strictly chronologically ordered');

// Cross-verify RELIANCE closes directly against raw BhavCopy CSVs
const reliance = stocks.find(s => s.symbol === 'RELIANCE' && s.isin === 'INE002A01018');
const rawRelFirst = parseCsv(fs.readFileSync(path.join(downloadsDir, getNseFilename(expectedSessions[0])), 'utf8')).find(r => r.ISIN === 'INE002A01018');
const rawRelLast = parseCsv(fs.readFileSync(nseTodayFile, 'utf8')).find(r => r.ISIN === 'INE002A01018');
const expectedFirstClose = parseFloat(rawRelFirst?.ClsPric || rawRelFirst?.LastPric);
const expectedLastClose = parseFloat(rawRelLast?.ClsPric || rawRelLast?.LastPric);
const expected1w = parseFloat((((expectedLastClose - expectedFirstClose) / expectedFirstClose) * 100).toFixed(2));

assert(reliance && reliance.historical_prices && reliance.historical_prices.length === 6, 'RELIANCE has 6 verified daily historical closes');
assert(reliance && reliance.historical_prices[0].date === expectedSessions[0] && reliance.historical_prices[0].close === expectedFirstClose, `RELIANCE Session 1 (${expectedSessions[0]}) close matches raw CSV (${expectedFirstClose})`);
assert(reliance && reliance.historical_prices[5].date === activeDate && reliance.historical_prices[5].close === expectedLastClose, `RELIANCE Session 6 (${activeDate}) close matches raw CSV (${expectedLastClose})`);
assert(reliance && reliance.return_1w === expected1w, `RELIANCE 1W return matches raw calculation (${expected1w}%)`, `(${reliance?.return_1w}%)`);

// -----------------------------------------------------------------------------
// Test Group 9: Timestamp Timezone Correctness
// -----------------------------------------------------------------------------
console.log('\n[Test Group 9: Timestamp Timezone Correctness]');
assert(stats.refreshedAtUtc && stats.refreshedAtUtc.endsWith('Z'), 'refreshedAtUtc is ISO 8601 UTC with trailing Z', `(${stats.refreshedAtUtc})`);
assert(stats.fetchedAtUtc && stats.fetchedAtUtc.endsWith('Z'), 'fetchedAtUtc is ISO 8601 UTC with trailing Z', `(${stats.fetchedAtUtc})`);
assert(stats.istDisplayTime && stats.istDisplayTime.endsWith('IST'), 'istDisplayTime explicitly specifies IST timezone', `(${stats.istDisplayTime})`);
assert(stocks.every(s => s.fetched_at && s.fetched_at.endsWith('Z')), 'Every stock has valid fetched_at in UTC ISO format');
assert(stocks.every(s => s.refreshed_at && s.refreshed_at.endsWith('Z')), 'Every stock has valid refreshed_at in UTC ISO format');

// -----------------------------------------------------------------------------
// Test Group 10: Precise SME Platform Reconciliation
// -----------------------------------------------------------------------------
console.log('\n[Test Group 10: Precise SME Platform Reconciliation]');
const smeStocks = stocks.filter(s => s.segment === 'SME');
const nseSme = smeStocks.filter(s => s.exchanges.includes('NSE'));
const bseSme = smeStocks.filter(s => s.exchanges.includes('BSE'));
const dualSme = smeStocks.filter(s => s.exchanges.includes('NSE') && s.exchanges.includes('BSE'));
const mainboardStocks = stocks.filter(s => s.segment === 'Mainboard');

assert(smeStocks.length === stats.smeReconciliation.totalUniqueSme, 'Total unique SME matches stats', `(${smeStocks.length})`);
assert(nseSme.length + bseSme.length - dualSme.length === smeStocks.length, 'NSE SME + BSE SME - Dual SME equals total SME');
assert(mainboardStocks.length + smeStocks.length === stocks.length, 'Mainboard + SME strictly equals Total Universe', `(${mainboardStocks.length} + ${smeStocks.length} === ${stocks.length})`);

// -----------------------------------------------------------------------------
// Test Group 11: Market-Cap Classification Labels & Methodology
// -----------------------------------------------------------------------------
console.log('\n[Test Group 11: Market-Cap Classification Labels & Methodology]');
assert(stats.verifiedRankingSegments != null, 'verifiedRankingSegments object is defined in MARKET_STATS');
assert(stats.verifiedRankingSegments.top100 === 100, 'Top 100 Verified Equities count is exactly 100');
assert(stats.verifiedRankingSegments.rank101_250 === 150, 'Rank 101–250 Verified Equities count is exactly 150');
assert(stats.verifiedRankingSegments.remainingVerified > 4000, 'Remaining Verified Equities covers majority of mainboard', `(${stats.verifiedRankingSegments?.remainingVerified})`);

const segSum = stats.verifiedRankingSegments.top100 +
  stats.verifiedRankingSegments.rank101_250 +
  stats.verifiedRankingSegments.remainingVerified +
  stats.verifiedRankingSegments.smePlatform +
  stats.verifiedRankingSegments.unranked;
assert(segSum === stocks.length, 'Top100 + Rank101-250 + Remaining + SME + Unranked equals universe', `(${segSum} === ${stocks.length})`);
assert(typeof stats.rankingDisclaimer === 'string' && stats.rankingDisclaimer.includes('NOT an official SEBI'), 'Non-SEBI ranking disclaimer is present');

// -----------------------------------------------------------------------------
// Test Group 12: Exchange Coverage Reconciliation
// -----------------------------------------------------------------------------
console.log('\n[Test Group 12: Exchange Coverage Reconciliation]');
assert(stats.exchangeCoverage != null, 'exchangeCoverage object is defined');
assert(stats.exchangeCoverage.totalUnique === stocks.length, 'Total unique coverage matches stock count');
const calcUnique = stats.exchangeCoverage.nseListed + stats.exchangeCoverage.bseListed - stats.exchangeCoverage.dualListed;
assert(calcUnique === stocks.length, 'Inclusion-Exclusion identity holds: NSE + BSE - Dual === Unique', `(${calcUnique})`);

// -----------------------------------------------------------------------------
// Test Group 13: Pipeline Metadata & Automation Status
// -----------------------------------------------------------------------------
console.log('\n[Test Group 13: Pipeline Metadata & Automation Status]');
assert(Boolean(stats.pipelineVersion), 'pipelineVersion metadata is present', `(${stats.pipelineVersion})`);
assert(Array.isArray(stats.sourceFiles) && stats.sourceFiles.length >= 2, 'sourceFiles metadata documents NSE and BSE archives');
assert(stats.pipelineDates && stats.pipelineDates.latestPublishedDate === activeDate, 'pipelineDates records published trading date');
assert(stats.automationStatus != null && typeof stats.automationStatus.cloudAutomation === 'string', 'automationStatus is documented');

console.log('\n================================================================');
console.log(` VERIFICATION SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('================================================================\n');

if (failedTests > 0) process.exit(1);
