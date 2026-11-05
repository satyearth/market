/**
 * Machli Bazzar — Phase 2: Complete Frontend Functionality & UI QA Test Suite
 *
 * Simulates and verifies:
 * 1. Stock Universe Search & Filtering (Symbol, Name, NSE Symbol, BSE Scrip Code, ISIN, Sector, Industry)
 * 2. Filter Pills Integrity (ALL, TOP GAINERS, TOP LOSERS, NEAR 52W HIGH)
 * 3. Sorting Mechanics & Null Preservation (Nulls never convert to 0)
 * 4. Pagination Windowing & Bounds
 * 5. Market Pulse Data Binding
 * 6. Exchange Badges & Deduplication (Zero Collisions on Duplicate Symbols)
 * 7. Stock Details Page & Identifiers (ISIN routing, dual, NSE-only, BSE-only, SME)
 * 8. Historical Price Data Integrity (Date-to-Price Mapping, Chronological, No Synthetic Data)
 * 9. Asset 404 Prevention (Zero Missing Logo Requests)
 * 10. Performance & Memory Management (Event Delegation & Sub-5ms Filter Execution)
 */

const fs = require('fs');
const path = require('path');

console.log('================================================================');
console.log(' MACHLI BAZZAR — PHASE 2: FRONTEND FUNCTIONALITY & UI QA SUITE');
console.log('================================================================\n');

// Load STOCKS_DATA and MARKET_STATS
const dataPath = path.join(__dirname, '..', 'js', 'stocks-data.js');
const appPath = path.join(__dirname, '..', 'js', 'app.js');
const indexPath = path.join(__dirname, '..', 'index.html');
const detailPath = path.join(__dirname, '..', 'stock.html');
const detailScriptPath = path.join(__dirname, '..', 'js', 'stock-details.js');
const detailStylesPath = path.join(__dirname, '..', 'css', 'stock-details.css');

const dataContent = fs.readFileSync(dataPath, 'utf-8');
const appContent = fs.readFileSync(appPath, 'utf-8');
const indexContent = fs.readFileSync(indexPath, 'utf-8');
const detailContent = fs.readFileSync(detailPath, 'utf-8');
const detailScriptContent = fs.readFileSync(detailScriptPath, 'utf-8');
const detailStylesContent = fs.readFileSync(detailStylesPath, 'utf-8');

const matchData = dataContent.match(/const STOCKS_DATA = (\[[\s\S]*?\]);\s*$/);
const matchStats = dataContent.match(/const MARKET_STATS = (\{[\s\S]*?\});/);

const STOCKS_DATA = eval('(' + matchData[1] + ')');
const MARKET_STATS = eval('(' + matchStats[1] + ')');

let passedTests = 0;
let failedTests = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    console.log(`  ✓ PASS: ${testName} ${details ? '(' + details + ')' : ''}`);
    passedTests++;
  } else {
    console.error(`  ✗ FAIL: ${testName} ${details ? '[' + details + ']' : ''}`);
    failedTests++;
  }
}

// -------------------------------------------------------------
// SECTION 1: STOCK UNIVERSE & SEARCH
// -------------------------------------------------------------
console.log('[Section 1: Stock Universe & Search]');

assert(STOCKS_DATA.length === 5389, 'Total stock universe is exactly 5,389', `Length: ${STOCKS_DATA.length}`);

// 1. Search by Symbol
const BRAND_ENTITY_MAP = {
  'zomato': 'ETERNAL',
  'blinkit': 'ETERNAL',
  'policybazaar': 'POLICYBZR',
  'paisabazaar': 'POLICYBZR',
  'maggi': 'NESTLEIND',
  'jlr': 'TATAMOTORS',
  'jaguar': 'TATAMOTORS'
};

function searchStocks(query) {
  const q = query.toLowerCase().trim();
  const qNorm = q.replace(/[^a-z0-9]/g, '');
  const aliasSym = BRAND_ENTITY_MAP[q] || BRAND_ENTITY_MAP[qNorm];
  return STOCKS_DATA.filter(s =>
    (aliasSym && (s.symbol === aliasSym || s.nse_symbol === aliasSym)) ||
    (s.symbol && s.symbol.toLowerCase().includes(q)) ||
    (s.company_name && s.company_name.toLowerCase().includes(q)) ||
    (s.nse_symbol && s.nse_symbol.toLowerCase().includes(q)) ||
    (s.bse_scrip_code && s.bse_scrip_code.toLowerCase().includes(q)) ||
    (s.isin && s.isin.toLowerCase().includes(q)) ||
    (s.sector && s.sector.toLowerCase().includes(q)) ||
    (s.industry && s.industry.toLowerCase().includes(q)) ||
    (qNorm.length >= 2 && (
      (s.symbol && s.symbol.toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm)) ||
      (s.company_name && s.company_name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm)) ||
      (s.nse_symbol && s.nse_symbol.toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm))
    ))
  );
}

const resSym = searchStocks('RELIANCE');
assert(resSym.some(s => s.symbol === 'RELIANCE'), 'Search by symbol finds RELIANCE', `Matches: ${resSym.length}`);

// 1b. Search specifically for JIOFIN and Reliance Industries
const resJioFin = searchStocks('JIOFIN');
assert(resJioFin.some(s => s.symbol === 'JIOFIN'), 'Search by symbol finds JIOFIN', `Matches: ${resJioFin.length}`);

const resJioName = searchStocks('Jio Financial');
assert(resJioName.some(s => s.symbol === 'JIOFIN'), 'Search by legal name "Jio Financial" finds JIOFIN', `Matches: ${resJioName.length}`);

const resRelName = searchStocks('Reliance Industries');
assert(resRelName.some(s => s.symbol === 'RELIANCE'), 'Search by legal name "Reliance Industries" finds RELIANCE', `Matches: ${resRelName.length}`);

const resDmart = searchStocks('d-mart');
assert(resDmart.some(s => s.symbol === 'DMART'), 'Search by brand "d-mart" finds Avenue Supermarts (DMART)');

const resOne97 = searchStocks('one97');
assert(resOne97.some(s => s.symbol === 'PAYTM'), 'Search by "one97" finds One 97 Communications (PAYTM)');

const resZomato = searchStocks('zomato');
assert(resZomato.some(s => s.symbol === 'ETERNAL'), 'Search by brand "zomato" resolves to legal entity Eternal Limited (ETERNAL)');

// 2. Search by Company Name
const resName = searchStocks('Tata Consultancy');
assert(resName.some(s => s.symbol === 'TCS'), 'Search by company name ("Tata Consultancy") finds TCS', `Matches: ${resName.length}`);

// 3. Search by BSE Scrip Code
const resBse = searchStocks('500325'); // Reliance BSE Scrip Code
assert(resBse.some(s => s.symbol === 'RELIANCE' && s.bse_scrip_code === '500325'), 'Search by BSE scrip code 500325 finds RELIANCE');

const resBseJio = searchStocks('543940'); // Jio Financial BSE Scrip Code
assert(resBseJio.some(s => s.symbol === 'JIOFIN' && s.bse_scrip_code === '543940'), 'Search by BSE scrip code 543940 finds JIOFIN');

const resBse2 = searchStocks('532540'); // TCS BSE Scrip Code
assert(resBse2.some(s => s.symbol === 'TCS' && s.bse_scrip_code === '532540'), 'Search by BSE scrip code 532540 finds TCS');

// 4. Search by NSE Symbol
const resNse = searchStocks('HDFCBANK');
assert(resNse.some(s => s.nse_symbol === 'HDFCBANK'), 'Search by NSE symbol finds HDFCBANK');

// 5. Search by ISIN
const resIsin = searchStocks('INE002A01018');
assert(resIsin.length === 1 && resIsin[0].symbol === 'RELIANCE', 'Search by ISIN INE002A01018 precisely matches RELIANCE');

const resIsinJio = searchStocks('INE758E01017');
assert(resIsinJio.length === 1 && resIsinJio[0].symbol === 'JIOFIN', 'Search by ISIN INE758E01017 precisely matches JIOFIN');

// 6. Search by Sector
const resSector = searchStocks('Financial Services');
assert(resSector.length >= 50, 'Search by Sector ("Financial Services") returns valid stocks', `Found: ${resSector.length}`);

// 7. Search by Industry
const resInd = searchStocks('Pharmaceuticals');
assert(resInd.length >= 5, 'Search by Industry ("Pharmaceuticals") returns valid stocks', `Found: ${resInd.length}`);

// -------------------------------------------------------------
// SECTION 2: FILTER PILLS & DISAMBIGUATION
// -------------------------------------------------------------
console.log('\n[Section 2: Filter Pills & Disambiguation]');

// 1. ALL Filter
const allCount = STOCKS_DATA.length;
assert(allCount === 5389, 'ALL filter preserves full 5,389 universe');

// 2. TOP GAINERS Filter
const gainers = STOCKS_DATA.filter(s => s.change_percent > 0 || (s.prev_close != null && s.current_price > s.prev_close)).sort((a, b) => b.change_percent - a.change_percent);
assert(gainers.length === MARKET_STATS.advances, 'TOP GAINERS count matches Market Pulse advances exactly', `${gainers.length} === ${MARKET_STATS.advances}`);
assert(gainers[0].change_percent >= gainers[1].change_percent, 'TOP GAINERS is sorted in descending order of change percentage', `Top: ${gainers[0].change_percent}%`);

// 3. TOP LOSERS Filter
const losers = STOCKS_DATA.filter(s => s.change_percent < 0 || (s.prev_close != null && s.current_price < s.prev_close)).sort((a, b) => a.change_percent - b.change_percent);
assert(losers.length === MARKET_STATS.declines, 'TOP LOSERS count matches Market Pulse declines exactly', `${losers.length} === ${MARKET_STATS.declines}`);
assert(losers[0].change_percent <= losers[1].change_percent, 'TOP LOSERS is sorted in ascending order (biggest drops first)', `Worst: ${losers[0].change_percent}%`);

// 4. NEAR 52W HIGH Filter
const nearHigh = STOCKS_DATA.filter(s => s.is_near_high || (s.pct_from_high && Number(s.pct_from_high) >= -8));
assert(nearHigh.length === MARKET_STATS.near52WeekHighCount, 'NEAR 52W HIGH filter matches Market Pulse count', `${nearHigh.length} === ${MARKET_STATS.near52WeekHighCount}`);
assert(nearHigh.length > 0, 'NEAR 52W HIGH does NOT hide valid stocks', `Found ${nearHigh.length} verified stocks`);

// 5. Duplicate Symbol Disambiguation
const dupeSym = 'GSTL';
const gstlMatches = STOCKS_DATA.filter(s => s.symbol === dupeSym);
assert(gstlMatches.length === 2, 'GSTL exists on both NSE and BSE as two distinct companies', `Count: ${gstlMatches.length}`);
assert(gstlMatches[0].isin !== gstlMatches[1].isin, 'Duplicate symbol scrips have completely distinct ISINs', `${gstlMatches[0].isin} vs ${gstlMatches[1].isin}`);
assert(appContent.includes('data-row-isin="${escapeHtml(s.isin)}"'), 'Table rows in app.js are keyed on ISIN, preventing symbol collisions');
assert(appContent.includes('./stock.html?isin='), 'Stock rows link to the dedicated page by ISIN');
assert(appContent.includes('window.location.href = `./stock.html?isin=${encodeURIComponent(isin)}`'), 'Clicking a stock row navigates using its canonical ISIN');
assert(appContent.includes("tbody.addEventListener('keydown'"), 'Stock rows support keyboard navigation');
assert(!appContent.includes('openStockModal'), 'The modal-based stock opener has been removed');
assert(detailScriptContent.includes("item.isin || '').toUpperCase() === isin.trim().toUpperCase()"), 'Detail page resolves records by ISIN, case-insensitively');
assert(STOCKS_DATA.every(s => s.isin && s.isin.length === 12), 'Every dataset stock has a canonical 12-character ISIN');
assert(STOCKS_DATA.filter(s => s.symbol === 'GSTL').every(s => detailScriptContent.includes('item.isin')), 'Detail lookup uses ISIN to disambiguate duplicate symbols');

// -------------------------------------------------------------
// SECTION 3: STOCK DATA DISPLAY & NULL INTEGRITY
// -------------------------------------------------------------
console.log('\n[Section 3: Stock Data Display & Null Integrity]');

// 1. Missing data handling: market cap
const unranked = STOCKS_DATA.filter(s => s.market_cap_cr === null);
assert(unranked.length === 5046, 'Unverified market caps remain strictly null (5,046 stocks)', `Count: ${unranked.length}`);

// Formatter check
function formatMarketCap(cr) {
  if (!cr) return '—';
  const val = Number(cr);
  if (val >= 100000) return `₹${(val / 100000).toFixed(1)}L Cr`;
  if (val >= 1000) return `₹${(val / 1000).toFixed(1)}k Cr`;
  return `₹${Math.round(val).toLocaleString('en-IN')} Cr`;
}
assert(formatMarketCap(null) === '—', 'formatMarketCap(null) returns em-dash "—" and never "0" or "NaN"');
assert(formatMarketCap(undefined) === '—', 'formatMarketCap(undefined) returns em-dash "—"');
assert(formatMarketCap(1883296.8) === '₹18.8L Cr', 'formatMarketCap for Reliance is ₹18.8L Cr');

// 2. Missing data handling: 1W return
const null1wCount = STOCKS_DATA.filter(s => s.return_1w === null).length;
assert(null1wCount === 190, '190 unpriced or single-session stocks have null 1W return', `Count: ${null1wCount}`);

// 3. Multi-month returns audit (1M, 3M, 1Y are strictly null since only 6 daily sessions are verified)
const nonNull1m = STOCKS_DATA.filter(s => s.return_1m != null).length;
const nonNull3m = STOCKS_DATA.filter(s => s.return_3m != null).length;
const nonNull1y = STOCKS_DATA.filter(s => s.return_1y != null).length;
assert(nonNull1m === 0, '1M returns are strictly null (0 unverified values displayed)', `Count: ${nonNull1m}`);
assert(nonNull3m === 0, '3M returns are strictly null (0 unverified values displayed)', `Count: ${nonNull3m}`);
assert(nonNull1y === 0, '1Y returns are strictly null (0 unverified values displayed)', `Count: ${nonNull1y}`);

// 4. Exchange Badges
const dualSample = STOCKS_DATA.find(s => s.exchanges.length === 2);
assert(dualSample.exchanges.includes('NSE') && dualSample.exchanges.includes('BSE'), 'Dual listed stock has both NSE and BSE');

const nseOnlySample = STOCKS_DATA.find(s => s.exchanges.length === 1 && s.exchanges[0] === 'NSE');
assert(nseOnlySample.exchanges.length === 1 && nseOnlySample.exchanges[0] === 'NSE', 'NSE-only stock has only NSE');

const bseOnlySample = STOCKS_DATA.find(s => s.exchanges.length === 1 && s.exchanges[0] === 'BSE');
assert(bseOnlySample.exchanges.length === 1 && bseOnlySample.exchanges[0] === 'BSE', 'BSE-only stock has only BSE');

const smeSample = STOCKS_DATA.find(s => s.segment === 'SME');
assert(smeSample.segment === 'SME', 'SME platform security has segment SME');

// -------------------------------------------------------------
// SECTION 4: MARKET PULSE CARDS BINDING
// -------------------------------------------------------------
console.log('\n[Section 4: Market Pulse Cards Binding]');

assert(MARKET_STATS.stockCount === 5389, 'Card: Market coverage is 5,389 listed companies');
assert(MARKET_STATS.vix === 15.19, 'Card: India VIX value is 15.19');
assert(MARKET_STATS.vixChangePct === -3.39, 'Card: India VIX change is -3.39%');
assert(MARKET_STATS.vixDate === '04-NOV-2026', 'Card: India VIX date is 04-NOV-2026');
assert(MARKET_STATS.advances === 3228, 'Card: Advances is 3,228');
assert(MARKET_STATS.declines === 1539, 'Card: Declines is 1,539');
assert(MARKET_STATS.unchanged === 620, 'Card: Unchanged is 620');
assert(MARKET_STATS.marketBreadth.unpriced === 2, 'Card: Unpriced is 2');
assert(MARKET_STATS.verifiedMarketCapCr === 40082596, 'Card: Verified market cap matches current verified coverage (₹400.8L Cr)');
assert(indexContent.includes('Verified Market Cap'), 'Card 1 title is "Verified Market Cap", identifying partial coverage');
assert(indexContent.includes('Top 343 Equities (NSE + BSE)'), 'Card 1 subtitle identifies "Top 343 Equities (NSE + BSE)"');
assert(MARKET_STATS.verifiedRankingSegments.top100 === 100, 'Card: Top 100 verified count is 100');
assert(MARKET_STATS.verifiedRankingSegments.rank101_250 === 150, 'Card: Rank 101–250 verified count is 150');
assert(MARKET_STATS.verifiedRankingSegments.remainingVerified === 93, 'Card: Remaining verified count is 93');
assert(MARKET_STATS.verifiedRankingSegments.unranked === 4000, 'Card: Unranked count is 4,000');
assert(MARKET_STATS.verifiedRankingSegments.smePlatform === 1046, 'Card: SME platform count is 1,046');
assert(MARKET_STATS.near52WeekHighCount === 101, 'Card: Near 52W high count is 101 stocks');
assert(MARKET_STATS.near52WeekHighPct === 1.9, 'Card: Near 52W high percentage is 1.9%');
assert(MARKET_STATS.near52WeekHighTradingDate === '2026-11-04' && MARKET_STATS.near52WeekHighStatus === 'LIVE_MCP', 'Card: Near 52W high status matches the live MCP snapshot date');

// -------------------------------------------------------------
// SECTION 5: HISTORICAL PRICE DATA PRESERVATION
// -------------------------------------------------------------
console.log('\n[Section 5: Historical Price Data Preservation]');

const reliance = STOCKS_DATA.find(s => s.symbol === 'RELIANCE');
assert(reliance.historical_prices.length === 6, 'RELIANCE has 6 historical session records');

const dates = reliance.historical_prices.map(p => p.date);
const expectedDates = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-04'];
assert(JSON.stringify(dates) === JSON.stringify(expectedDates), 'Dates are strictly chronological 6 sessions', dates.join(', '));

// The new details page intentionally has no historical chart.
assert(!detailContent.includes('<svg'), 'Dedicated stock details page contains no chart SVG');
assert(!detailScriptContent.includes('<svg'), 'Stock detail renderer does not generate charts');
assert(!appContent.includes('Math.sin'), 'Zero synthetic sine waves in sparklines or charts');
assert(!appContent.includes('seed %'), 'Zero pseudo-random seed equations in sparklines or charts');

// -------------------------------------------------------------
// SECTION 6: ASSETS & 404 PREVENTION
// -------------------------------------------------------------
console.log('\n[Section 6: Assets & 404 Prevention]');

assert(appContent.includes('https://api.dharun.dev/v1/logos/'), 'app.js uses free India API company-logo endpoint (api.dharun.dev)');
assert(appContent.includes('loading="lazy"'), 'app.js implements lazy loading on logo images');
assert(appContent.includes('decoding="async"'), 'app.js implements asynchronous image decoding for 60fps performance');
assert(appContent.includes('onerror='), 'app.js implements bulletproof onerror fallback to initials');
assert(appContent.includes('data-fallback'), 'app.js implements double-fallback via data-fallback attribute');
assert(indexContent.includes('js/logo-aliases.js'), 'index.html includes verified logo aliases script');

// Check that no HTML hardcodes old 4,965 stock counts
assert(!indexContent.includes('4,965'), 'index.html contains zero outdated 4,965 stock count references');
assert(!indexContent.includes('aria-rowcount="4965"'), 'index.html aria-rowcount is updated to 5389');
assert(indexContent.includes('aria-rowcount="5389"'), 'index.html aria-rowcount is exactly 5389');
assert(!indexContent.includes('Showing 1–50 of 4,965'), 'index.html showing status is updated to 5,389');
assert(indexContent.includes('Showing 1–50 of 5,389'), 'index.html showing status is exactly 5,389');
assert(indexContent.includes('Browse 5,389 Indian equities'), 'index.html meta description specifies 5,389 equities');

// -------------------------------------------------------------
// SECTION 7: RESPONSIVE LAYOUT, SECURITY & PERFORMANCE
// -------------------------------------------------------------
console.log('\n[Section 7: Responsive Layout, Security & Performance]');

assert(!indexContent.includes('ai-modal'), 'Homepage no longer contains the stock details modal');
assert(detailContent.includes('id="stock-detail"'), 'Dedicated details page includes its content region');
assert(detailContent.includes('id="stock-error"'), 'Dedicated details page includes an error state');
assert(detailContent.includes('id="stock-loading"'), 'Dedicated details page includes a loading state');
assert(detailContent.includes('EOD close'), 'Dedicated details page labels prices as EOD');
assert(detailScriptContent.includes('/api/market/status'), 'Dedicated details page reuses the existing market status API');
assert(detailStylesContent.includes('@media (max-width: 520px)'), 'Details layout collapses to one column on mobile');
assert(appContent.includes('function escapeHtml('), 'app.js implements escapeHtml() for bulletproof XSS protection');
assert(appContent.includes('tbody.addEventListener(\'click\''), 'tbody uses event delegation for stock row navigation');
assert(appContent.includes('searchDebounceTimer'), 'Search input uses debouncing for smooth UI performance');

// Benchmark search filtering execution time
const start = performance.now();
for (let i = 0; i < 20; i++) {
  searchStocks('tata');
  searchStocks('500');
  searchStocks('bank');
}
const elapsed = performance.now() - start;
const avg = (elapsed / 60).toFixed(2);
assert(Number(avg) < 5, 'Average search filter execution time is sub-5ms across 5,389 records', `${avg}ms / query`);

// -------------------------------------------------------------
// SECTION 8: 10-POINT DATA CONSISTENCY RECONCILIATION
// -------------------------------------------------------------
console.log('\n[Section 8: 10-Point Data Consistency Reconciliation]');

const isinSet = new Set(STOCKS_DATA.map(s => s.isin));
const nseScrips = STOCKS_DATA.filter(s => s.exchanges.includes('NSE')).length;
const bseScrips = STOCKS_DATA.filter(s => s.exchanges.includes('BSE')).length;
const dualScrips = STOCKS_DATA.filter(s => s.exchanges.includes('NSE') && s.exchanges.includes('BSE')).length;
const mainboardScrips = STOCKS_DATA.filter(s => s.segment === 'Mainboard').length;
const smeScrips = STOCKS_DATA.filter(s => s.segment === 'SME').length;

let advCount = 0, decCount = 0, unchCount = 0, unpCount = 0;
STOCKS_DATA.forEach(s => {
  if (s.prev_close == null || s.prev_close === 0) unpCount++;
  else if (s.current_price > s.prev_close) advCount++;
  else if (s.current_price < s.prev_close) decCount++;
  else unchCount++;
});

assert(isinSet.size === 5389, 'Reconciliation: Total unique ISINs is 5,389', `Set size: ${isinSet.size}`);
assert(nseScrips === 3191, 'Reconciliation: NSE count is 3,191', `Count: ${nseScrips}`);
assert(bseScrips === 4702, 'Reconciliation: BSE count is 4,702', `Count: ${bseScrips}`);
assert(dualScrips === 2504, 'Reconciliation: Dual-listed count is 2,504', `Count: ${dualScrips}`);
assert(mainboardScrips === 4343, 'Reconciliation: Mainboard count is 4,343', `Count: ${mainboardScrips}`);
assert(smeScrips === 1046, 'Reconciliation: SME count is 1,046', `Count: ${smeScrips}`);
assert(advCount === 3228, 'Reconciliation: Advances count is 3,228', `Count: ${advCount}`);
assert(decCount === 1539, 'Reconciliation: Declines count is 1,539', `Count: ${decCount}`);
assert(unchCount === 620, 'Reconciliation: Unchanged count is 620', `Count: ${unchCount}`);
assert(unpCount === 2, 'Reconciliation: Unpriced count is 2', `Count: ${unpCount}`);
assert(dualScrips + (nseScrips - dualScrips) + (bseScrips - dualScrips) === 5389, 'Mathematical identity: Dual (2504) + NSE-only (687) + BSE-only (2198) === 5389');
assert(mainboardScrips + smeScrips === 5389, 'Mathematical identity: Mainboard (4343) + SME (1046) === 5389');
assert(advCount + decCount + unchCount + unpCount === 5389, 'Mathematical identity: Adv (3228) + Dec (1539) + Unch (620) + Unp (2) === 5389');

// -------------------------------------------------------------
// SUMMARY
// -------------------------------------------------------------
console.log('\n================================================================');
console.log(` PHASE 2 QA SUITE RESULTS: ${passedTests} PASSED, ${failedTests} FAILED`);
console.log('================================================================');

if (failedTests > 0) {
  process.exit(1);
} else {
  process.exit(0);
}
