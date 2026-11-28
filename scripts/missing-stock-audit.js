'use strict';

/**
 * MACHLI BAZZAR — MISSING STOCK AUDIT & ENTITY RESOLUTION SUITE
 *
 * Dynamically reconciles 100% of eligible NSE & BSE equities from the active
 * 6-session BhavCopy window against js/stocks-data.js, and verifies canonical
 * entity resolution & brand vs unlisted subsidiary safeguards.
 */

const fs = require('fs');
const path = require('path');
const {
  NSE_EQUITY_SERIES,
  BSE_EQUITY_GROUPS,
  isEligibleIsin
} = require('../src/config/constants');
const { getRecentTradingSessions } = require('../src/calendar/exchange-calendar');
const { parseCsv, readExistingDataset } = require('./sync-stock-universe');
const { getNseFilename, getBseFilename } = require('./download-bhavcopy');

const ROOT_DIR = path.resolve(__dirname, '..');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const DATASET_PATH = path.join(ROOT_DIR, 'js', 'stocks-data.js');

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

async function runMissingStockAudit() {
  const { stats: MARKET_STATS, stocks: STOCKS_DATA } = readExistingDataset(DATASET_PATH);
  if (!MARKET_STATS || !Array.isArray(STOCKS_DATA)) {
    throw new Error('Failed to parse stocks-data.js. Aborting.');
  }

  const TARGET_DATE = MARKET_STATS.tradingDate;
  const HISTORICAL_DATES = MARKET_STATS.historicalSessions?.activeWindowSessions || getRecentTradingSessions(TARGET_DATE, 6);

  console.log('================================================================');
  console.log(' MACHLI BAZZAR — MISSING STOCK AUDIT & ENTITY RESOLUTION SUITE');
  console.log(` Target Session Date : ${TARGET_DATE}`);
  console.log('================================================================\n');

  console.log('[1/5] Loading compiled application dataset (js/stocks-data.js)...');
  assert(Array.isArray(STOCKS_DATA) && STOCKS_DATA.length === MARKET_STATS.stockCount, 'Dataset loaded with reconciled equity count', `Count: ${STOCKS_DATA.length}`);

  const stockByIsin = new Map();
  const stockBySymbol = new Map();
  const stockByNseSymbol = new Map();
  const stockByBseCode = new Map();

  STOCKS_DATA.forEach(s => {
    stockByIsin.set(s.isin, s);
    if (s.symbol) stockBySymbol.set(s.symbol.toUpperCase(), s);
    if (s.nse_symbol) stockByNseSymbol.set(s.nse_symbol.toUpperCase(), s);
    if (s.bse_scrip_code) stockByBseCode.set(String(s.bse_scrip_code), s);
  });

  const BRAND_ENTITY_MAP = {
    'zomato': 'ETERNAL',
    'blinkit': 'ETERNAL',
    'policybazaar': 'POLICYBZR',
    'paisabazaar': 'POLICYBZR',
    'maggi': 'NESTLEIND',
    'jlr': 'TMPV',
    'jaguar': 'TMPV'
  };

  function searchDataset(query) {
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

  console.log('\n[2/5] Reconciling against official NSE & BSE BhavCopy Security Masters...');

  const nseEligibleIsins = new Set();
  const bseEligibleIsins = new Set();

  for (const dt of HISTORICAL_DATES) {
    const nFile = path.join(DOWNLOADS_DIR, getNseFilename(dt));
    const bFile = path.join(DOWNLOADS_DIR, getBseFilename(dt));
    const nRaw = fs.existsSync(nFile) ? parseCsv(fs.readFileSync(nFile, 'utf-8')) : [];
    const bRaw = fs.existsSync(bFile) ? parseCsv(fs.readFileSync(bFile, 'utf-8')) : [];

    nRaw.forEach(r => {
      const isin = r.ISIN ? r.ISIN.trim() : '';
      const series = r.SctySrs ? r.SctySrs.trim() : '';
      if (NSE_EQUITY_SERIES.has(series) && isEligibleIsin(isin)) {
        nseEligibleIsins.add(isin);
      }
    });

    bRaw.forEach(r => {
      const isin = r.ISIN ? r.ISIN.trim() : '';
      const group = r.SctySrs ? r.SctySrs.trim() : '';
      if (BSE_EQUITY_GROUPS.has(group) && isEligibleIsin(isin)) {
        bseEligibleIsins.add(isin);
      }
    });
  }

  const masterAllIsins = new Set([...nseEligibleIsins, ...bseEligibleIsins]);
  const missingFromDataset = [...masterAllIsins].filter(isin => !stockByIsin.has(isin));
  const extraInDataset = [...stockByIsin.keys()].filter(isin => !masterAllIsins.has(isin));

  assert(missingFromDataset.length === 0, 'Zero listed equities missing from exchange masters', `Missing: ${missingFromDataset.length}`);
  assert(extraInDataset.length === 0, 'Zero phantom/invented securities outside exchange masters', `Extra: ${extraInDataset.length}`);
  assert(STOCKS_DATA.length === masterAllIsins.size, 'Total dataset count strictly equals exchange master count', `${STOCKS_DATA.length} === ${masterAllIsins.size}`);

  console.log('\n[3/5] Verifying RELIANCE, JIOFIN, and JPL...');
  const relBySym = stockBySymbol.get('RELIANCE');
  const relByIsin = stockByIsin.get('INE002A01018');
  assert(relBySym != null && relBySym === relByIsin, 'RELIANCE identified by Symbol and ISIN (INE002A01018)');
  assert(relBySym.nse_symbol === 'RELIANCE' && relBySym.bse_scrip_code === '500325', 'RELIANCE NSE + BSE identifiers verified');
  assert(relBySym.exchanges.includes('NSE') && relBySym.exchanges.includes('BSE'), 'RELIANCE is dual-listed');
  assert(relBySym.rank === 1 && relBySym.verified_rank_tier === 'Top 100 Verified', 'RELIANCE ranks #1');

  const jioByIsin = stockByIsin.get('INE758E01017');
  assert(jioByIsin != null && jioByIsin.nse_symbol === 'JIOFIN' && jioByIsin.bse_scrip_code === '543940', 'JIOFIN verified by ISIN, NSE symbol, and BSE code');

  const jplByIsin = stockByIsin.get('INE0BJO01010');
  if (jplByIsin) {
    assert(jplByIsin.nse_symbol === 'JPL' && jplByIsin.bse_scrip_code === '545004', 'JPL dual-listed identifiers verified');
  }

  console.log('\n[4/5] Running Entity Resolution & Unlisted Brand Battery...');
  const testBattery = [
    { query: 'RELIANCE', expectedType: 'LISTED', expectedSymbol: 'RELIANCE', isin: 'INE002A01018' },
    { query: 'TCS', expectedType: 'LISTED', expectedSymbol: 'TCS', isin: 'INE467B01029' },
    { query: 'HDFCBANK', expectedType: 'LISTED', expectedSymbol: 'HDFCBANK', isin: 'INE040A01034' },
    { query: 'INFY', expectedType: 'LISTED', expectedSymbol: 'INFY', isin: 'INE009A01021' },
    { query: 'ICICIBANK', expectedType: 'LISTED', expectedSymbol: 'ICICIBANK', isin: 'INE090A01021' },
    { query: 'SBIN', expectedType: 'LISTED', expectedSymbol: 'SBIN', isin: 'INE062A01020' },
    { query: 'BHARTIARTL', expectedType: 'LISTED', expectedSymbol: 'BHARTIARTL', isin: 'INE397D01024' },
    { query: 'ITC', expectedType: 'LISTED', expectedSymbol: 'ITC', isin: 'INE154A01025' },
    { query: 'LT', expectedType: 'LISTED', expectedSymbol: 'LT', isin: 'INE018A01030' },
    { query: 'WIPRO', expectedType: 'LISTED', expectedSymbol: 'WIPRO', isin: 'INE075A01022' },
    { query: 'MARUTI', expectedType: 'LISTED', expectedSymbol: 'MARUTI', isin: 'INE585B01010' },
    { query: 'SUNPHARMA', expectedType: 'LISTED', expectedSymbol: 'SUNPHARMA', isin: 'INE044A01036' },
    { query: 'BSE', expectedType: 'LISTED', expectedSymbol: 'BSE', isin: 'INE118H01025' },
    { query: 'Jio Financial', expectedType: 'LISTED', expectedSymbol: 'JIOFIN', isin: 'INE758E01017' },
    { query: 'd-mart', expectedType: 'LISTED', expectedSymbol: 'DMART', isin: 'INE192R01011' },
    { query: 'paytm', expectedType: 'LISTED', expectedSymbol: 'PAYTM', isin: 'INE982J01020' },
    { query: 'zomato', expectedType: 'LISTED', expectedSymbol: 'ETERNAL', isin: 'INE758T01015' },
    { query: 'nykaa', expectedType: 'LISTED', expectedSymbol: 'NYKAA', isin: 'INE388Y01029' },
    { query: 'policybazaar', expectedType: 'LISTED', expectedSymbol: 'POLICYBZR', isin: 'INE417T01026' },
    { query: 'nestle', expectedType: 'LISTED', expectedSymbol: 'NESTLEIND', isin: 'INE239A01024' },
    { query: 'hindustan unilever', expectedType: 'LISTED', expectedSymbol: 'HINDUNILVR', isin: 'INE030A01027' },
    { query: 'irctc', expectedType: 'LISTED', expectedSymbol: 'IRCTC', isin: 'INE335Y01020' },
    { query: '20MICRONS', expectedType: 'LISTED', expectedSymbol: '20MICRONS', isin: 'INE144J01027' },
    { query: 'Blinkit', expectedType: 'UNLISTED' },
    { query: 'Maggi', expectedType: 'UNLISTED' },
    { query: 'Parle-G', expectedType: 'UNLISTED' },
    { query: 'Amul', expectedType: 'UNLISTED' },
    { query: 'Zerodha', expectedType: 'UNLISTED' },
    { query: 'Flipkart', expectedType: 'UNLISTED' }
  ];

  for (const item of testBattery) {
    if (item.expectedType === 'LISTED') {
      const results = searchDataset(item.query);
      const matched = results.some(s => s.symbol === item.expectedSymbol || s.isin === item.isin);
      assert(matched, `[Battery] Query "${item.query}" resolves ${item.expectedSymbol}`);
    } else {
      assert(!stockBySymbol.has(item.query.toUpperCase()), `[Battery] Unlisted brand "${item.query}" not invented as ticker`);
    }
  }

  console.log('\n================================================================');
  console.log(` MISSING-STOCK AUDIT RESULT: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    throw new Error(`Missing stock audit failed with ${failCount} errors.`);
  }

  return {
    tradingDate: TARGET_DATE,
    masterCount: masterAllIsins.size,
    datasetCount: STOCKS_DATA.length,
    missingListedCount: missingFromDataset.length,
    extraSecuritiesCount: extraInDataset.length,
    passCount,
    failCount
  };
}

if (require.main === module) {
  runMissingStockAudit().catch(err => {
    console.error('Missing Stock Audit FAILED:', err.message);
    process.exit(1);
  });
}

module.exports = { runMissingStockAudit };
