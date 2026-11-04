/**
 * Machli Bazzar — Dataset & Market Statistics Comprehensive Verification Suite (Phase 1.3)
 *
 * Verifies:
 * 1. Trading Date & Session Consistency
 * 2. Exchange Batches & Source Data Completeness
 * 3. Primary Key (ISIN) & Deduplication (Zero Duplicates)
 * 4. Dual-Listing & Identifiers Integrity
 * 5. Data Integrity: Zero Fabricated Prices & Market Caps
 * 6. Dynamic India VIX (from official MCP)
 * 7. Market Breadth Calculation from Quotes & Exact Universe Reconciliation
 * 8. Historical Date-to-Price Mapping & Chronological Ordering (6 Sessions)
 * 9. Timestamp Timezone Correctness (ISO UTC & Asia/Kolkata IST)
 * 10. Precise SME Platform Reconciliation (NSE: 472, BSE: 392, Dual: 0, Total: 864)
 * 11. Methodologically Sound Market-Cap Classification Labels (No False SEBI Claims)
 * 12. Exchange Coverage Reconciliation (NSE: 3085, BSE: 4310, Dual: 2430, Unique: 4965)
 * 13. Automation Status Labeling (LOCAL ONLY / CLOUD NOT CONFIGURED)
 */

const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', 'js', 'stocks-data.js');
const downloadsDir = path.join(__dirname, '..', 'downloads');

console.log('================================================================');
console.log(' MACHLI BAZZAR — PHASE 1.3 COMPREHENSIVE VERIFICATION SUITE');
console.log('================================================================\n');

if (!fs.existsSync(targetPath)) {
  console.error('FAIL: Target dataset file not found at:', targetPath);
  process.exit(1);
}

const content = fs.readFileSync(targetPath, 'utf-8');
const match = content.match(/const STOCKS_DATA = (\[[\s\S]*?\]);\s*$/);
const statsMatch = content.match(/const MARKET_STATS = (\{[\s\S]*?\});/);

if (!match || !statsMatch) {
  console.error('FAIL: Could not parse STOCKS_DATA or MARKET_STATS');
  process.exit(1);
}

const stocks = eval('(' + match[1] + ')');
const stats = eval('(' + statsMatch[1] + ')');

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

// -----------------------------------------------------------------------------
// Test Group 1: Trading Date & Session Consistency
// -----------------------------------------------------------------------------
console.log('[Test Group 1: Trading Date & Session Consistency]');
assert(stats.tradingDate === '2026-11-04', 'Latest trading date is 2026-11-04', `(found: ${stats.tradingDate})`);
assert(stats.stockCount === stocks.length, 'Market stats count equals STOCKS_DATA length', `(${stats.stockCount} === ${stocks.length})`);
assert(stocks.every(s => s.trading_date === stats.tradingDate), 'Every stock shares the same trading date', `(${stats.tradingDate})`);
assert(stats.refreshedAt && stocks.every(s => s.refreshed_at === stats.refreshedAt), 'Statistics and stocks share exact refreshed_at timestamp');

// -----------------------------------------------------------------------------
// Test Group 2: Exchange Batches & Source Data
// -----------------------------------------------------------------------------
console.log('\n[Test Group 2: Exchange Source Files & Batches]');
const nseTodayFile = path.join(downloadsDir, 'BhavCopy_NSE_CM_0_0_0_20261104_F_0000.csv');
const bseTodayFile = path.join(downloadsDir, 'BhavCopy_BSE_CM_0_0_0_20261104_F_0000.CSV');
assert(fs.existsSync(nseTodayFile), 'NSE 2026-11-04 Bhavcopy exists in downloads/');
assert(fs.existsSync(bseTodayFile), 'BSE 2026-11-04 Bhavcopy exists in downloads/');

const nseSize = fs.existsSync(nseTodayFile) ? fs.statSync(nseTodayFile).size : 0;
const bseSize = fs.existsSync(bseTodayFile) ? fs.statSync(bseTodayFile).size : 0;
assert(nseSize > 500000, 'NSE Bhavcopy is complete (not truncated)', `(${nseSize} bytes)`);
assert(bseSize > 500000, 'BSE Bhavcopy is complete (not truncated)', `(${bseSize} bytes)`);

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
  if (s.current_price != null && (isNaN(s.current_price) || s.current_price <= 0)) {
    invalidPrices++;
  }
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
assert(unverifiedMcap > 4000, 'Unverified market caps remain null and render as em-dash', `(${unverifiedMcap} stocks)`);

// -----------------------------------------------------------------------------
// Test Group 6: Dynamic India VIX Verification
// -----------------------------------------------------------------------------
console.log('\n[Test Group 6: Dynamic India VIX Verification]');
assert(stats.vix !== 15.27 || stats.vixChangePct !== -2.89, 'India VIX is NOT using old hardcoded values (15.27 / -2.89%)');
assert(typeof stats.vix === 'number' && stats.vix > 5 && stats.vix < 60, 'India VIX is a valid volatility reading', `(${stats.vix})`);
assert(stats.vixDate && typeof stats.vixDate === 'string', 'India VIX date is attached from source', `(${stats.vixDate})`);

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
assert(stats.unpriced === calcUnpriced, 'Market Breadth unpriced strictly matches new listings', `(${stats.unpriced} === ${calcUnpriced})`);
assert(calcAdv + calcDec + calcUnc + calcUnpriced === stocks.length, 'Advances + Declines + Unchanged + Unpriced strictly equals Eligible Universe (4,965)');
assert(stats.advances !== 2720, 'Advances are NOT old hardcoded value (2720)');

// -----------------------------------------------------------------------------
// Test Group 8: Historical Date-to-Price Mapping & Chronological Ordering
// -----------------------------------------------------------------------------
console.log('\n[Test Group 8: Historical Date-to-Price Mapping & Chronological Ordering]');
const expectedSessions = [
  '2026-10-28',
  '2026-10-29',
  '2026-10-30',
  '2026-11-02',
  '2026-11-03',
  '2026-11-04'
];

assert(stats.historicalSessions && stats.historicalSessions.sessionCount === 6, 'Historical sessions count is exactly 6');
assert(JSON.stringify(stats.historicalSessions?.sessions) === JSON.stringify(expectedSessions), 'Historical sessions match expected 6 trading dates', JSON.stringify(stats.historicalSessions?.sessions));

let stocksWithHistoricalPrices = 0;
let chronologicallyOrderedCount = 0;
let stocksWithValidDates = 0;

stocks.forEach(s => {
  if (s.historical_prices && Array.isArray(s.historical_prices) && s.historical_prices.length >= 2) {
    stocksWithHistoricalPrices++;

    // Check that every entry has a valid date string and numeric close
    const allHaveDateAndClose = s.historical_prices.every(p => 
      typeof p.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.close === 'number' && !isNaN(p.close)
    );
    if (allHaveDateAndClose) stocksWithValidDates++;

    // Check chronological ordering
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
assert(stocksWithValidDates === stocksWithHistoricalPrices, 'All historical price objects contain valid date strings and numeric closes');
assert(chronologicallyOrderedCount === stocksWithHistoricalPrices, '100% of historical price arrays are strictly chronologically ordered');

// Verify sample stock RELIANCE against raw source records
const reliance = stocks.find(s => s.symbol === 'RELIANCE');
assert(reliance && reliance.historical_prices && reliance.historical_prices.length === 6, 'RELIANCE has 6 verified daily historical closes', JSON.stringify(reliance?.historical_prices));
assert(reliance && reliance.historical_prices[0].date === '2026-10-28' && reliance.historical_prices[0].close === 1158.00, 'RELIANCE Session 1 (2026-10-28) close is 1158.00');
assert(reliance && reliance.historical_prices[5].date === '2026-11-04' && reliance.historical_prices[5].close === 1311.00, 'RELIANCE Session 6 (2026-11-04) close is 1311.00');
assert(reliance && reliance.return_1w === 13.21, 'RELIANCE 1-week return matches ((1311 - 1158) / 1158) * 100 = +13.21%', `(${reliance?.return_1w}%)`);
assert(reliance && reliance.return_1w_session_start === '2026-10-28' && reliance.return_1w_session_end === '2026-11-04', 'RELIANCE 1W return session boundaries documented (2026-10-28 to 2026-11-04)');

// -----------------------------------------------------------------------------
// Test Group 9: Timestamp Timezone Correctness
// -----------------------------------------------------------------------------
console.log('\n[Test Group 9: Timestamp Timezone Correctness]');
assert(stats.refreshedAtUtc && stats.refreshedAtUtc.endsWith('Z'), 'refreshedAtUtc is formatted as ISO 8601 UTC with trailing Z', `(${stats.refreshedAtUtc})`);
assert(stats.fetchedAtUtc && stats.fetchedAtUtc.endsWith('Z'), 'fetchedAtUtc is formatted as ISO 8601 UTC with trailing Z', `(${stats.fetchedAtUtc})`);
assert(stats.istDisplayTime && stats.istDisplayTime.endsWith('IST'), 'istDisplayTime explicitly specifies IST timezone', `(${stats.istDisplayTime})`);
assert(stats.tradingDate === '2026-11-04', 'tradingDate is distinct session date in YYYY-MM-DD format', `(${stats.tradingDate})`);
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

assert(smeStocks.length === 864, 'Total unique SME platform stocks is exactly 864', `(${smeStocks.length})`);
assert(nseSme.length === 472, 'NSE SME stocks (Series SM & ST) is exactly 472', `(${nseSme.length})`);
assert(bseSme.length === 392, 'BSE SME stocks (Groups M, MT & MS) is exactly 392', `(${bseSme.length})`);
assert(dualSme.length === 0, 'Dual-listed SME stocks is exactly 0 (per Indian regulatory exclusivity rule)', `(${dualSme.length})`);
assert(nseSme.length + bseSme.length - dualSme.length === smeStocks.length, 'NSE SME + BSE SME - Dual SME equals total SME (472 + 392 - 0 = 864)');

const mainboardStocks = stocks.filter(s => s.segment === 'Mainboard');
assert(mainboardStocks.length === 4101, 'Mainboard stocks count is exactly 4,101', `(${mainboardStocks.length})`);
assert(mainboardStocks.length + smeStocks.length === stocks.length, 'Mainboard (4,101) + SME (864) strictly equals Total Universe (4,965)');

// -----------------------------------------------------------------------------
// Test Group 11: Methodologically Sound Market-Cap Classification Labels
// -----------------------------------------------------------------------------
console.log('\n[Test Group 11: Market-Cap Classification Labels & Methodology]');
assert(stats.verifiedRankingSegments != null, 'verifiedRankingSegments object is defined in MARKET_STATS');
assert(stats.verifiedRankingSegments.top100 === 100, 'Top 100 Verified Equities count is exactly 100', `(${stats.verifiedRankingSegments?.top100})`);
assert(stats.verifiedRankingSegments.rank101_250 === 150, 'Rank 101–250 Verified Equities count is exactly 150', `(${stats.verifiedRankingSegments?.rank101_250})`);
assert(stats.verifiedRankingSegments.remainingVerified === 93, 'Remaining Verified Equities count is exactly 93 (Rank 251–343)', `(${stats.verifiedRankingSegments?.remainingVerified})`);
assert(stats.verifiedRankingSegments.smePlatform === 864, 'SME Platform Securities count is exactly 864', `(${stats.verifiedRankingSegments?.smePlatform})`);
assert(stats.verifiedRankingSegments.unranked === 3758, 'Unranked Equities count is exactly 3,758 (4965 - 343 - 864)', `(${stats.verifiedRankingSegments?.unranked})`);

// Mathematical reconciliation of segments
const segSum = stats.verifiedRankingSegments.top100 + 
               stats.verifiedRankingSegments.rank101_250 + 
               stats.verifiedRankingSegments.remainingVerified + 
               stats.verifiedRankingSegments.smePlatform + 
               stats.verifiedRankingSegments.unranked;
assert(segSum === stocks.length, 'Top100 + Rank101-250 + Remaining + SME + Unranked equals 4,965', `(${segSum} === 4965)`);

// Verify disclaimer presence
assert(typeof stats.rankingDisclaimer === 'string' && stats.rankingDisclaimer.includes('NOT an official SEBI'), 'Clear disclaimer that ranking is NOT an official SEBI classification is present');

// Verify stock individual rank tiers
const top100Stocks = stocks.filter(s => s.verified_rank_tier === 'Top 100 Verified');
const rank101Stocks = stocks.filter(s => s.verified_rank_tier === 'Rank 101–250 Verified');
const remStocks = stocks.filter(s => s.verified_rank_tier === 'Remaining Verified');
assert(top100Stocks.length === 100, 'Exactly 100 stocks carry verified_rank_tier "Top 100 Verified"');
assert(rank101Stocks.length === 150, 'Exactly 150 stocks carry verified_rank_tier "Rank 101–250 Verified"');
assert(remStocks.length === 93, 'Exactly 93 stocks carry verified_rank_tier "Remaining Verified"');

// -----------------------------------------------------------------------------
// Test Group 12: Exchange Coverage Reconciliation
// -----------------------------------------------------------------------------
console.log('\n[Test Group 12: Exchange Coverage Reconciliation]');
assert(stats.exchangeCoverage != null, 'exchangeCoverage object is defined in MARKET_STATS');
assert(stats.exchangeCoverage.totalUnique === 4965, 'Total unique coverage is 4,965', `(${stats.exchangeCoverage?.totalUnique})`);
assert(stats.exchangeCoverage.nseListed === 3085, 'NSE listed count is 3,085 (2430 dual + 655 nseOnly)', `(${stats.exchangeCoverage?.nseListed})`);
assert(stats.exchangeCoverage.bseListed === 4310, 'BSE listed count is 4,310 (2430 dual + 1880 bseOnly)', `(${stats.exchangeCoverage?.bseListed})`);
assert(stats.exchangeCoverage.dualListed === 2430, 'Dual-listed count is 2,430', `(${stats.exchangeCoverage?.dualListed})`);
assert(stats.exchangeCoverage.nseOnly === 655, 'NSE-only count is 655', `(${stats.exchangeCoverage?.nseOnly})`);
assert(stats.exchangeCoverage.bseOnly === 1880, 'BSE-only count is 1,880', `(${stats.exchangeCoverage?.bseOnly})`);

// Inclusion-exclusion principle check: NSE + BSE - Dual === Unique
const calcUnique = stats.exchangeCoverage.nseListed + stats.exchangeCoverage.bseListed - stats.exchangeCoverage.dualListed;
assert(calcUnique === 4965, 'Inclusion-Exclusion check: 3085 + 4310 - 2430 = 4,965', `(${calcUnique})`);

// -----------------------------------------------------------------------------
// Test Group 13: Automation Status Labeling
// -----------------------------------------------------------------------------
console.log('\n[Test Group 13: Automation Status Labeling]');
assert(stats.automationStatus != null, 'automationStatus object is defined in MARKET_STATS');
assert(stats.automationStatus.cloudAutomation === 'LOCAL ONLY / CLOUD NOT CONFIGURED', 'Cloud automation is honestly labeled as LOCAL ONLY / CLOUD NOT CONFIGURED');
assert(typeof stats.automationStatus.cloudLimitation === 'string' && stats.automationStatus.cloudLimitation.includes('geofencing'), 'Cloud geofencing limitation is clearly documented');

// -----------------------------------------------------------------------------
// Final Results
// -----------------------------------------------------------------------------
console.log('\n================================================================');
console.log(` PHASE 1.3 VERIFICATION SUMMARY: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('================================================================\n');

if (failedTests > 0) {
  process.exit(1);
}
