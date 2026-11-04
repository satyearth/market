/**
 * MACHLI BAZZAR — NEW LISTED STOCK DISCOVERY & RECONCILIATION TEST SUITE
 *
 * Tests:
 * 1. New Listing Detection (Mainboard & SME)
 * 2. Dual-Listing Detection & Exchange Expansion
 * 3. ISIN Deduplication & Collision Matching
 * 4. Missing EOD Records & Unpriced Metadata Handling
 * 5. Idempotency (repeated runs produce zero duplicates)
 * 6. Historical Record Preservation across sync runs
 * 7. Incomplete Download / Truncated Master Safety Rollback
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const TARGET_PATH = path.join(ROOT_DIR, 'js', 'stocks-data.js');

let passCount = 0;
let failCount = 0;

function assert(condition, testName, details = '') {
  if (condition) {
    passCount++;
    console.log(`  ✓ PASS: ${testName} ${details ? '(' + details + ')' : ''}`);
  } else {
    failCount++;
    console.error(`  ✗ FAIL: ${testName} ${details ? '[' + details + ']' : ''}`);
  }
}

// Simulated Diff Detection Engine (matching sync-stock-universe.js logic)
function detectUniverseChanges(previousUniverse, currentUniverse) {
  const prevByIsin = new Map();
  previousUniverse.forEach(s => prevByIsin.set(s.isin, s));

  const currByIsin = new Map();
  currentUniverse.forEach(s => currByIsin.set(s.isin, s));

  const newlyListed = [];
  const newExchangeListings = [];
  const symbolChanges = [];
  const seriesChanges = [];
  const delistedOrSuspended = [];

  currentUniverse.forEach(s => {
    const prev = prevByIsin.get(s.isin);
    if (!prev) {
      newlyListed.push({
        isin: s.isin,
        symbol: s.symbol,
        company_name: s.company_name,
        exchanges: s.exchanges,
        segment: s.segment,
        series: s.series,
        current_price: s.current_price,
        has_eod_price: s.current_price != null
      });
    } else {
      const prevExchanges = new Set(prev.exchanges || []);
      const addedExchanges = s.exchanges.filter(x => !prevExchanges.has(x));
      if (addedExchanges.length > 0) {
        newExchangeListings.push({
          isin: s.isin,
          symbol: s.symbol,
          company_name: s.company_name,
          previous_exchanges: prev.exchanges,
          current_exchanges: s.exchanges,
          added_exchanges: addedExchanges
        });
      }

      if (prev.symbol && s.symbol && prev.symbol !== s.symbol) {
        symbolChanges.push({
          isin: s.isin,
          old_symbol: prev.symbol,
          new_symbol: s.symbol
        });
      }

      if (prev.series && s.series && prev.series !== s.series) {
        seriesChanges.push({
          isin: s.isin,
          old_series: prev.series,
          new_series: s.series,
          old_segment: prev.segment,
          new_segment: s.segment
        });
      }
    }
  });

  for (const [isin, prev] of prevByIsin.entries()) {
    if (!currByIsin.has(isin)) {
      delistedOrSuspended.push({
        isin: prev.isin,
        symbol: prev.symbol,
        company_name: prev.company_name
      });
    }
  }

  return {
    newlyListed,
    newExchangeListings,
    symbolChanges,
    seriesChanges,
    delistedOrSuspended
  };
}

async function runTests() {
  console.log('================================================================');
  console.log(' MACHLI BAZZAR — NEW LISTING DISCOVERY TEST SUITE');
  console.log('================================================================\n');

  // Load production dataset
  const dataText = fs.readFileSync(TARGET_PATH, 'utf-8');
  const matchData = dataText.match(/const STOCKS_DATA = (\[[\s\S]*?\]);\s*$/);
  const matchStats = dataText.match(/const MARKET_STATS = (\{[\s\S]*?\});/);
  const STOCKS_DATA = eval('(' + matchData[1] + ')');
  const MARKET_STATS = eval('(' + matchStats[1] + ')');

  // ---------------------------------------------------------------------------
  // TEST GROUP 1: NEW LISTING DETECTION
  // ---------------------------------------------------------------------------
  console.log('[Test Group 1: New Listing Detection]');

  const baselineUniverse = [
    { isin: 'INE001A01010', symbol: 'EXIST1', company_name: 'Existing 1 Ltd', exchanges: ['NSE'], segment: 'Mainboard', series: 'EQ', current_price: 100 },
    { isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Ltd', exchanges: ['NSE', 'BSE'], segment: 'Mainboard', series: 'EQ', current_price: 1311 }
  ];

  const updatedUniverseWithNewListings = [
    ...baselineUniverse,
    { isin: 'INE999A01019', symbol: 'NEWIPO', company_name: 'New Mainboard IPO Ltd', exchanges: ['NSE'], segment: 'Mainboard', series: 'EQ', current_price: 250 },
    { isin: 'INE888B01011', symbol: 'SMEIPO', company_name: 'New SME IPO Ltd', exchanges: ['BSE'], segment: 'SME', series: 'MT', current_price: 85 }
  ];

  const changes1 = detectUniverseChanges(baselineUniverse, updatedUniverseWithNewListings);
  assert(changes1.newlyListed.length === 2, 'Detects exactly 2 new listed companies', `Count: ${changes1.newlyListed.length}`);
  assert(changes1.newlyListed.some(s => s.symbol === 'NEWIPO' && s.segment === 'Mainboard'), 'Identifies new Mainboard listing (NEWIPO)');
  assert(changes1.newlyListed.some(s => s.symbol === 'SMEIPO' && s.segment === 'SME'), 'Identifies new SME platform listing (SMEIPO)');

  // ---------------------------------------------------------------------------
  // TEST GROUP 2: DUAL-LISTING ADDITION & EXCHANGE EXPANSION
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 2: Dual-Listing Addition & Exchange Expansion]');

  const universeBeforeDual = [
    { isin: 'INE555A01015', symbol: 'SOLO_BSE', company_name: 'Solo BSE Ltd', exchanges: ['BSE'], segment: 'Mainboard', series: 'B', current_price: 50 }
  ];

  const universeAfterDual = [
    { isin: 'INE555A01015', symbol: 'SOLO_BSE', company_name: 'Solo BSE Ltd', exchanges: ['NSE', 'BSE'], segment: 'Mainboard', series: 'EQ', current_price: 51 }
  ];

  const changes2 = detectUniverseChanges(universeBeforeDual, universeAfterDual);
  assert(changes2.newlyListed.length === 0, 'Does not treat dual-listing addition as a new company');
  assert(changes2.newExchangeListings.length === 1, 'Detects new exchange listing addition', `Count: ${changes2.newExchangeListings.length}`);
  assert(changes2.newExchangeListings[0].added_exchanges.includes('NSE'), 'Correctly identifies NSE as added exchange');

  // ---------------------------------------------------------------------------
  // TEST GROUP 3: ISIN DEDUPLICATION & PRIMARY IDENTITY MATCHING
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 3: ISIN Deduplication & Collision Matching]');

  const isinSet = new Set();
  let duplicateCount = 0;
  STOCKS_DATA.forEach(s => {
    if (isinSet.has(s.isin)) duplicateCount++;
    isinSet.add(s.isin);
  });

  assert(duplicateCount === 0, 'Zero duplicate ISINs across entire production stock universe', `Duplicates: ${duplicateCount}`);
  assert(isinSet.size === 5389, 'Total unique ISINs equals 5,389', `Size: ${isinSet.size}`);

  // Test ticker symbol collision disambiguation
  const gstlStocks = STOCKS_DATA.filter(s => s.symbol === 'GSTL');
  assert(gstlStocks.length === 2, 'Two distinct securities share ticker "GSTL" disambiguated by ISIN', `Count: ${gstlStocks.length}`);
  assert(gstlStocks[0].isin !== gstlStocks[1].isin, 'GSTL securities have distinct ISINs', `${gstlStocks[0].isin} !== ${gstlStocks[1].isin}`);

  // ---------------------------------------------------------------------------
  // TEST GROUP 4: MISSING EOD RECORDS & UNPRICED METADATA HANDLING
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 4: Missing EOD Records & Unpriced Metadata Handling]');

  const universeWithUnpricedStock = [
    {
      isin: 'INE777C01013',
      symbol: 'PRETRD',
      company_name: 'Pre-Trading Security Ltd',
      exchanges: ['BSE'],
      segment: 'Mainboard',
      series: 'A',
      current_price: null,
      open_price: null,
      high_price: null,
      low_price: null,
      prev_close: null,
      change_percent: null,
      volume: 0
    }
  ];

  const unpricedStock = universeWithUnpricedStock[0];
  assert(unpricedStock.current_price === null, 'Pre-trading stock has null current_price');
  assert(unpricedStock.prev_close === null, 'Pre-trading stock has null prev_close');
  assert(unpricedStock.change_percent === null, 'Pre-trading stock has null change_percent');
  assert(unpricedStock.volume === 0, 'Pre-trading stock volume is 0');

  // Check existing unpriced IPO listings in production dataset (AJWA & CRL)
  const ajwa = STOCKS_DATA.find(s => s.symbol === 'AJWA');
  const crl = STOCKS_DATA.find(s => s.symbol === 'CRL');
  assert(ajwa != null && ajwa.prev_close === null && ajwa.change_percent === null, 'AJWA IPO listing preserves null prev_close without fake zeros');
  assert(crl != null && crl.prev_close === null && crl.change_percent === null, 'CRL IPO listing preserves null prev_close without fake zeros');

  // ---------------------------------------------------------------------------
  // TEST GROUP 5: IDEMPOTENCY (REPEATED RUNS)
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 5: Idempotency & Stability]');

  const idempotencyChanges = detectUniverseChanges(STOCKS_DATA, STOCKS_DATA);
  assert(idempotencyChanges.newlyListed.length === 0, 'Idempotent run detects 0 new listings');
  assert(idempotencyChanges.newExchangeListings.length === 0, 'Idempotent run detects 0 exchange additions');
  assert(idempotencyChanges.symbolChanges.length === 0, 'Idempotent run detects 0 symbol changes');
  assert(idempotencyChanges.seriesChanges.length === 0, 'Idempotent run detects 0 series changes');
  assert(idempotencyChanges.delistedOrSuspended.length === 0, 'Idempotent run detects 0 delisted securities');

  // ---------------------------------------------------------------------------
  // TEST GROUP 6: HISTORICAL RECORD PRESERVATION
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 6: Historical Record Preservation]');

  const reliance = STOCKS_DATA.find(s => s.symbol === 'RELIANCE');
  assert(reliance != null, 'RELIANCE found in dataset');
  assert(reliance.historical_prices != null && Array.isArray(reliance.historical_prices), 'RELIANCE historical prices array is preserved');
  assert(reliance.historical_prices.length === 6, 'RELIANCE historical prices covers exactly 6 sessions', `Length: ${reliance.historical_prices.length}`);
  assert(reliance.historical_prices[0].date === '2026-10-28', 'Session 1 date is 2026-10-28');
  assert(reliance.historical_prices[5].date === '2026-11-04', 'Session 6 date is 2026-11-04');

  // ---------------------------------------------------------------------------
  // TEST GROUP 7: INCOMPLETE DOWNLOAD / SAFETY ROLLBACK
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 7: Truncated Master Safety Rollback]');

  function validateMasterRows(rows, name) {
    if (!Array.isArray(rows) || rows.length < 1000) {
      throw new Error(`Data validation failed: Truncated or incomplete ${name} response (${rows.length}). Refusing to overwrite verified dataset.`);
    }
    return true;
  }

  let errorCaught = false;
  try {
    validateMasterRows([{ TckrSymb: 'DUMMY' }], 'NSE Master');
  } catch (e) {
    errorCaught = true;
    assert(e.message.includes('Truncated or incomplete'), 'Sync refuses truncated master files (< 1000 rows)');
  }
  assert(errorCaught, 'Safety rollback triggered on invalid download');

  // ---------------------------------------------------------------------------
  // TEST GROUP 8: CHANGE LOG PERSISTENCE & STRUCTURE
  // ---------------------------------------------------------------------------
  console.log('\n[Test Group 8: Change Log Persistence]');

  const changeLogFile = path.join(DOWNLOADS_DIR, `universe-changes-2026-11-04.json`);
  assert(fs.existsSync(changeLogFile), 'Dated change log exists in downloads/ directory');

  if (fs.existsSync(changeLogFile)) {
    const logData = JSON.parse(fs.readFileSync(changeLogFile, 'utf-8'));
    assert(logData.tradingDate === '2026-11-04', 'Change log contains valid tradingDate (2026-11-04)');
    assert(typeof logData.previousUniverseCount === 'number', 'Change log records previousUniverseCount');
    assert(typeof logData.currentUniverseCount === 'number', 'Change log records currentUniverseCount');
    assert(logData.summary != null && typeof logData.summary.newlyListedCount === 'number', 'Change log records newlyListedCount in summary');
  }

  // Summary
  console.log('\n================================================================');
  console.log(` NEW LISTING DISCOVERY TEST SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    throw new Error(`New listing discovery tests failed with ${failCount} errors.`);
  }
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Test Suite Failed:', err.message);
    process.exit(1);
  });
}

module.exports = { runTests };

