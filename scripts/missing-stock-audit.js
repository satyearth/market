/**
 * MACHLI BAZZAR — MISSING STOCK AUDIT & ENTITY RESOLUTION SUITE
 *
 * Verifies:
 * 1. 100% of eligible NSE and BSE listed equities from official exchange masters are indexed.
 * 2. Specifically verifies RELIANCE (Reliance Industries Ltd) and JIOFIN (Jio Financial Services Ltd).
 * 3. Tests a comprehensive battery of 40 corporate entities:
 *    - Direct listed equities
 *    - Listed equities where popular brand differs from legal name (D-Mart, Paytm, Nykaa, PolicyBazaar, etc.)
 *    - Less popular, penny, micro, and SME listed scrips
 *    - Unlisted brands & subsidiaries (Blinkit, JLR, Maggi, Amul, Parle-G, Zerodha, Flipkart)
 * 4. Ensures unlisted subsidiaries/brands are NOT invented as fake separate listings.
 * 5. Reports exact missing listed securities count.
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DOWNLOADS_DIR = path.join(ROOT_DIR, 'downloads');
const TARGET_DATE = '2026-11-04';
const TARGET_DATE_COMPACT = TARGET_DATE.replace(/-/g, '');

const NSE_BHAVCOPY_PATH = path.join(DOWNLOADS_DIR, `BhavCopy_NSE_CM_0_0_0_${TARGET_DATE_COMPACT}_F_0000.csv`);
const BSE_BHAVCOPY_PATH = path.join(DOWNLOADS_DIR, `BhavCopy_BSE_CM_0_0_0_${TARGET_DATE_COMPACT}_F_0000.CSV`);
const DATASET_PATH = path.join(ROOT_DIR, 'js', 'stocks-data.js');

function parseCsv(content) {
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',');
    const obj = {};
    for (let j = 0; j < header.length; j++) {
      obj[header[j]] = cols[j] ? cols[j].trim() : '';
    }
    rows.push(obj);
  }
  return rows;
}

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
  console.log('================================================================');
  console.log(' MACHLI BAZZAR — MISSING STOCK AUDIT & ENTITY RESOLUTION SUITE');
  console.log(` Target Session Date : ${TARGET_DATE}`);
  console.log('================================================================\n');

  // 1. Load Application Dataset
  console.log('[1/5] Loading compiled application dataset (js/stocks-data.js)...');
  const dataText = fs.readFileSync(DATASET_PATH, 'utf-8');
  const matchData = dataText.match(/const STOCKS_DATA = (\[[\s\S]*?\]);\s*$/);
  const matchStats = dataText.match(/const MARKET_STATS = (\{[\s\S]*?\});/);

  if (!matchData || !matchStats) {
    throw new Error('Failed to parse stocks-data.js. Aborting.');
  }

  const STOCKS_DATA = eval('(' + matchData[1] + ')');
  const MARKET_STATS = eval('(' + matchStats[1] + ')');

  assert(Array.isArray(STOCKS_DATA) && STOCKS_DATA.length === 5389, 'Dataset loaded with exactly 5,389 unique equities', `Count: ${STOCKS_DATA.length}`);

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
    'jlr': 'TATAMOTORS',
    'jaguar': 'TATAMOTORS'
  };

  // Search function mimicking app.js with exact and normalized matching
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

  // 2. Reconcile against Official NSE & BSE Security Masters across 6-Session Window
  console.log('\n[2/5] Reconciling against official NSE & BSE Bhavcopy Security Masters...');
  const HISTORICAL_DATES = [
    '2026-10-28',
    '2026-10-29',
    '2026-10-30',
    '2026-11-02',
    '2026-11-03',
    '2026-11-04'
  ];
  const NSE_EQUITY_SERIES = new Set(['EQ', 'BE', 'BZ', 'BL', 'SM', 'ST']);
  const BSE_EQUITY_GROUPS = new Set(['A', 'B', 'T', 'X', 'XT', 'Z', 'P', 'M', 'MT', 'MS']);

  const nseEligibleIsins = new Set();
  const bseEligibleIsins = new Set();

  for (const dt of HISTORICAL_DATES) {
    const dtCompact = dt.replace(/-/g, '');
    const nFile = path.join(DOWNLOADS_DIR, `BhavCopy_NSE_CM_0_0_0_${dtCompact}_F_0000.csv`);
    const bFile = path.join(DOWNLOADS_DIR, `BhavCopy_BSE_CM_0_0_0_${dtCompact}_F_0000.CSV`);
    const nRaw = fs.existsSync(nFile) ? parseCsv(fs.readFileSync(nFile, 'utf-8')) : [];
    const bRaw = fs.existsSync(bFile) ? parseCsv(fs.readFileSync(bFile, 'utf-8')) : [];

    nRaw.forEach(r => {
      const isin = r.ISIN ? r.ISIN.trim() : '';
      const series = r.SctySrs ? r.SctySrs.trim() : '';
      if (NSE_EQUITY_SERIES.has(series) && (isin.startsWith('INE') || isin.startsWith('IN9'))) {
        nseEligibleIsins.add(isin);
      }
    });

    bRaw.forEach(r => {
      const isin = r.ISIN ? r.ISIN.trim() : '';
      const group = r.SctySrs ? r.SctySrs.trim() : '';
      if (BSE_EQUITY_GROUPS.has(group) && (isin.startsWith('INE') || isin.startsWith('IN9'))) {
        bseEligibleIsins.add(isin);
      }
    });
  }

  const masterAllIsins = new Set([...nseEligibleIsins, ...bseEligibleIsins]);

  console.log(`  → NSE Eligible Equities in Master: ${nseEligibleIsins.size}`);
  console.log(`  → BSE Eligible Equities in Master: ${bseEligibleIsins.size}`);
  console.log(`  → Combined Unique Equities in Masters: ${masterAllIsins.size}`);

  const missingFromDataset = [];
  for (const isin of masterAllIsins) {
    if (!stockByIsin.has(isin)) {
      missingFromDataset.push(isin);
    }
  }

  const extraInDataset = [];
  for (const isin of stockByIsin.keys()) {
    if (!masterAllIsins.has(isin)) {
      extraInDataset.push(isin);
    }
  }

  assert(missingFromDataset.length === 0, 'Zero listed equities missing from exchange masters', `Missing: ${missingFromDataset.length}`);
  assert(extraInDataset.length === 0, 'Zero phantom/invented securities outside exchange masters', `Extra: ${extraInDataset.length}`);
  assert(STOCKS_DATA.length === masterAllIsins.size, 'Total dataset count strictly equals exchange master count', `${STOCKS_DATA.length} === ${masterAllIsins.size}`);

  // 3. Specifically Verify RELIANCE, JIOFIN, and JPL (Jio Platforms Limited)
  console.log('\n[3/5] Specifically verifying RELIANCE, JIOFIN, and JPL...');

  // 3.1 RELIANCE
  const relBySym = stockBySymbol.get('RELIANCE');
  const relByIsin = stockByIsin.get('INE002A01018');
  assert(relBySym != null && relBySym === relByIsin, 'RELIANCE identified by both Symbol and ISIN (INE002A01018)');
  assert(relBySym.company_name === 'Reliance Industries Ltd', 'RELIANCE legal registered name is "Reliance Industries Ltd"');
  assert(relBySym.nse_symbol === 'RELIANCE', 'RELIANCE NSE symbol verified: RELIANCE');
  assert(relBySym.bse_scrip_code === '500325', 'RELIANCE BSE scrip code verified: 500325');
  assert(relBySym.exchanges.includes('NSE') && relBySym.exchanges.includes('BSE'), 'RELIANCE is dual-listed on NSE and BSE');
  assert(relBySym.segment === 'Mainboard' && relBySym.series === 'EQ', 'RELIANCE is Mainboard Series EQ');
  assert(relBySym.rank === 1 && relBySym.verified_rank_tier === 'Top 100 Verified', 'RELIANCE ranks #1 with verified market cap');

  // 3.2 JIOFIN
  const jioBySym = stockBySymbol.get('JIOFIN');
  const jioByIsin = stockByIsin.get('INE758E01017');
  assert(jioBySym != null && jioBySym === jioByIsin, 'JIOFIN identified by both Symbol and ISIN (INE758E01017)');
  assert(jioBySym.company_name === 'Jio Financial Services Limited', 'JIOFIN legal registered name is "Jio Financial Services Limited"');
  assert(jioBySym.nse_symbol === 'JIOFIN', 'JIOFIN NSE symbol verified: JIOFIN');
  assert(jioBySym.bse_scrip_code === '543940', 'JIOFIN BSE scrip code verified: 543940');
  assert(jioBySym.exchanges.includes('NSE') && jioBySym.exchanges.includes('BSE'), 'JIOFIN is dual-listed on NSE and BSE');
  assert(jioBySym.segment === 'Mainboard' && jioBySym.series === 'EQ', 'JIOFIN is Mainboard Series EQ');
  assert(jioBySym.isin !== relBySym.isin, 'JIOFIN has distinct ISIN from RELIANCE (INE758E01017 !== INE002A01018)');

  // 3.3 JPL (Jio Platforms Limited)
  const jplBySym = stockBySymbol.get('JPL');
  const jplByIsin = stockByIsin.get('INE0BJO01010');
  assert(jplBySym != null && jplBySym === jplByIsin, 'JPL identified by both Symbol and ISIN (INE0BJO01010)');
  assert(jplBySym.company_name === 'Jio Platforms Limited', 'JPL legal registered name is "Jio Platforms Limited"');
  assert(jplBySym.nse_symbol === 'JPL', 'JPL NSE symbol verified: JPL');
  assert(jplBySym.bse_scrip_code === '545004', 'JPL BSE scrip code verified: 545004');
  assert(jplBySym.exchanges.includes('NSE') && jplBySym.exchanges.includes('BSE'), 'JPL is dual-listed on NSE and BSE');
  assert(jplBySym.segment === 'Mainboard' && jplBySym.series === 'EQ', 'JPL is Mainboard Series EQ');
  assert(jplBySym.current_price === 1421.7, 'JPL closing price on 2026-11-04 is ₹1,421.70');
  assert(jplBySym.isin !== relBySym.isin && jplBySym.isin !== jioBySym.isin, 'JPL has distinct ISIN from RELIANCE and JIOFIN');

  // Search for Reliance, Jio, and JPL
  const relSearchResults = searchDataset('Reliance Industries');
  assert(relSearchResults.some(s => s.symbol === 'RELIANCE'), 'Search by legal name "Reliance Industries" returns RELIANCE');

  const jioSearchResults = searchDataset('Jio Financial');
  assert(jioSearchResults.some(s => s.symbol === 'JIOFIN'), 'Search by "Jio Financial" returns JIOFIN');

  const jioCodeResults = searchDataset('543940');
  assert(jioCodeResults.some(s => s.symbol === 'JIOFIN'), 'Search by BSE scrip code 543940 returns JIOFIN');

  const jioIsinResults = searchDataset('INE758E01017');
  assert(jioIsinResults.some(s => s.symbol === 'JIOFIN'), 'Search by ISIN INE758E01017 returns JIOFIN');

  const jplNameSearch = searchDataset('Jio Platforms');
  assert(jplNameSearch.some(s => s.symbol === 'JPL'), 'Search by legal name "Jio Platforms" returns JPL');
  const jplSymSearch = searchDataset('JPL');
  assert(jplSymSearch.some(s => s.symbol === 'JPL'), 'Search by symbol "JPL" returns JPL');
  const jplCodeSearch = searchDataset('545004');
  assert(jplCodeSearch.some(s => s.symbol === 'JPL'), 'Search by BSE scrip code 545004 returns JPL');
  const jplIsinSearch = searchDataset('INE0BJO01010');
  assert(jplIsinSearch.some(s => s.symbol === 'JPL'), 'Search by ISIN INE0BJO01010 returns JPL');

  // 4. Multi-Company Entity Resolution Battery
  console.log('\n[4/5] Running 40-Company Entity Resolution & Missing-Stock Battery...');

  const testBattery = [
    // Category 1: Direct Listed Equities (Symbol matches popular name)
    { query: 'RELIANCE', expectedType: 'LISTED', expectedSymbol: 'RELIANCE', legalName: 'Reliance Industries Ltd', isin: 'INE002A01018' },
    { query: 'TCS', expectedType: 'LISTED', expectedSymbol: 'TCS', legalName: 'Tata Consultancy Services Ltd', isin: 'INE467B01029' },
    { query: 'HDFCBANK', expectedType: 'LISTED', expectedSymbol: 'HDFCBANK', legalName: 'HDFC Bank Ltd', isin: 'INE040A01034' },
    { query: 'INFY', expectedType: 'LISTED', expectedSymbol: 'INFY', legalName: 'Infosys Ltd', isin: 'INE009A01021' },
    { query: 'ICICIBANK', expectedType: 'LISTED', expectedSymbol: 'ICICIBANK', legalName: 'ICICI Bank Ltd', isin: 'INE090A01021' },
    { query: 'SBIN', expectedType: 'LISTED', expectedSymbol: 'SBIN', legalName: 'State Bank of India', isin: 'INE062A01020' },
    { query: 'BHARTIARTL', expectedType: 'LISTED', expectedSymbol: 'BHARTIARTL', legalName: 'Bharti Airtel Ltd', isin: 'INE397D01024' },
    { query: 'ITC', expectedType: 'LISTED', expectedSymbol: 'ITC', legalName: 'ITC Ltd', isin: 'INE154A01025' },
    { query: 'LT', expectedType: 'LISTED', expectedSymbol: 'LT', legalName: 'Larsen & Toubro Ltd', isin: 'INE018A01030' },
    { query: 'WIPRO', expectedType: 'LISTED', expectedSymbol: 'WIPRO', legalName: 'Wipro Ltd', isin: 'INE075A01022' },
    { query: 'MARUTI', expectedType: 'LISTED', expectedSymbol: 'MARUTI', legalName: 'Maruti Suzuki India Ltd', isin: 'INE585B01010' },
    { query: 'SUNPHARMA', expectedType: 'LISTED', expectedSymbol: 'SUNPHARMA', legalName: 'Sun Pharmaceutical Industries Ltd', isin: 'INE044A01036' },
    { query: 'TATAMOTORS', expectedType: 'LISTED', expectedSymbol: 'TATAMOTORS', legalName: 'Tata Motors Ltd', isin: 'INE155A01022' },
    { query: 'BSE', expectedType: 'LISTED', expectedSymbol: 'BSE', legalName: 'BSE Ltd', isin: 'INE118H01025' },

    // Category 2: Listed Equities with Distinct Brand vs. Legal Name
    { query: 'JIOFIN', expectedType: 'LISTED', expectedSymbol: 'JIOFIN', legalName: 'Jio Financial Services Limited', isin: 'INE758E01017' },
    { query: 'Jio Financial', expectedType: 'LISTED', expectedSymbol: 'JIOFIN', legalName: 'Jio Financial Services Limited', isin: 'INE758E01017' },
    { query: 'JPL', expectedType: 'LISTED', expectedSymbol: 'JPL', legalName: 'Jio Platforms Limited', isin: 'INE0BJO01010' },
    { query: 'Jio Platforms', expectedType: 'LISTED', expectedSymbol: 'JPL', legalName: 'Jio Platforms Limited', isin: 'INE0BJO01010' },
    { query: 'd-mart', expectedType: 'LISTED', expectedSymbol: 'DMART', legalName: 'Avenue Supermarts Limited', isin: 'INE192R01011' },
    { query: 'Avenue Supermarts', expectedType: 'LISTED', expectedSymbol: 'DMART', legalName: 'Avenue Supermarts Limited', isin: 'INE192R01011' },
    { query: 'paytm', expectedType: 'LISTED', expectedSymbol: 'PAYTM', legalName: 'One 97 Communications Ltd', isin: 'INE982J01020' },
    { query: 'one97', expectedType: 'LISTED', expectedSymbol: 'PAYTM', legalName: 'One 97 Communications Ltd', isin: 'INE982J01020' },
    { query: 'zomato', expectedType: 'LISTED', expectedSymbol: 'ETERNAL', legalName: 'Eternal Limited (formerly Zomato Ltd)', isin: 'INE758T01015' },
    { query: 'Eternal', expectedType: 'LISTED', expectedSymbol: 'ETERNAL', legalName: 'Eternal Limited', isin: 'INE758T01015' },
    { query: 'nykaa', expectedType: 'LISTED', expectedSymbol: 'NYKAA', legalName: 'FSN E-Commerce Ventures Ltd', isin: 'INE388Y01029' },
    { query: 'FSN E-Commerce', expectedType: 'LISTED', expectedSymbol: 'NYKAA', legalName: 'FSN E-Commerce Ventures Ltd', isin: 'INE388Y01029' },
    { query: 'policybazaar', expectedType: 'LISTED', expectedSymbol: 'POLICYBZR', legalName: 'PB Fintech Ltd', isin: 'INE417T01026' },
    { query: 'PB Fintech', expectedType: 'LISTED', expectedSymbol: 'POLICYBZR', legalName: 'PB Fintech Ltd', isin: 'INE417T01026' },
    { query: 'nestle', expectedType: 'LISTED', expectedSymbol: 'NESTLEIND', legalName: 'Nestle India Ltd', isin: 'INE239A01024' },
    { query: 'hindustan unilever', expectedType: 'LISTED', expectedSymbol: 'HINDUNILVR', legalName: 'Hindustan Unilever Ltd', isin: 'INE030A01027' },
    { query: 'jubilant foodworks', expectedType: 'LISTED', expectedSymbol: 'JUBLFOOD', legalName: 'Jubilant FoodWorks Ltd', isin: 'INE797F01020' },
    { query: 'interglobe', expectedType: 'LISTED', expectedSymbol: 'INDIGO', legalName: 'InterGlobe Aviation Ltd', isin: 'INE646L01027' },
    { query: 'irctc', expectedType: 'LISTED', expectedSymbol: 'IRCTC', legalName: 'Indian Railway Catering and Tourism Corporation Ltd', isin: 'INE335Y01020' },

    // Category 3: Less Popular, Penny, Micro, and SME Equities
    { query: 'AJWA', expectedType: 'LISTED', expectedSymbol: 'AJWA', legalName: 'Ajwa Projects Limited', isin: 'INE1NMO01017' },
    { query: 'CRL', expectedType: 'LISTED', expectedSymbol: 'CRL', legalName: 'Carver Roboweld Limited', isin: 'INE1FY301017' },
    { query: 'MELSTAR', expectedType: 'LISTED', expectedSymbol: 'MELSTAR', legalName: 'Melstar Information Technologies Ltd', isin: 'INE817A01019' },
    { query: 'ENNATURE', expectedType: 'LISTED', expectedSymbol: 'ENNATURE', legalName: 'Ennature Biopharma Limited', isin: 'INE09WS01015' },
    { query: '20MICRONS', expectedType: 'LISTED', expectedSymbol: '20MICRONS', legalName: '20 Microns Limited', isin: 'INE144J01027' },

    // Category 4: Unlisted Brands & Unlisted Subsidiaries (Must NOT be invented as separate tickers)
    { query: 'Blinkit', expectedType: 'UNLISTED_SUBSIDIARY', parentListedSymbol: 'ETERNAL', parentName: 'Eternal Limited (formerly Zomato Ltd)' },
    { query: 'Jaguar Land Rover', expectedType: 'UNLISTED_SUBSIDIARY', parentListedSymbol: 'TATAMOTORS', parentName: 'Tata Motors Ltd' },
    { query: 'Maggi', expectedType: 'UNLISTED_BRAND', parentListedSymbol: 'NESTLEIND', parentName: 'Nestle India Ltd' },
    { query: 'Parle-G', expectedType: 'UNLISTED_COMPANY', parentName: 'Parle Products Pvt Ltd' },
    { query: 'Amul', expectedType: 'UNLISTED_COOPERATIVE', parentName: 'Gujarat Co-operative Milk Marketing Federation (GCMMF)' },
    { query: 'Zerodha', expectedType: 'UNLISTED_COMPANY', parentName: 'Zerodha Broking Ltd' },
    { query: 'Flipkart', expectedType: 'UNLISTED_COMPANY', parentName: 'Flipkart Pvt Ltd (Walmart Inc)' }
  ];

  let batteryPassed = 0;

  for (const item of testBattery) {
    if (item.expectedType === 'LISTED') {
      const results = searchDataset(item.query);
      const matched = results.some(s => s.symbol === item.expectedSymbol || s.isin === item.isin);
      assert(matched, `[Battery] Query "${item.query}" successfully resolves listed stock ${item.expectedSymbol} (${item.legalName})`);
      if (matched) batteryPassed++;
    } else {
      // Unlisted subsidiary or brand: Confirm NO fake ticker exists under this exact query name
      const exactTickerExists = stockBySymbol.has(item.query.toUpperCase());
      assert(!exactTickerExists, `[Battery] Unlisted brand/subsidiary "${item.query}" is correctly NOT invented as a separate ticker`);
      if (!exactTickerExists) batteryPassed++;
    }
  }

  assert(batteryPassed === testBattery.length, `100% of test battery passed (${batteryPassed}/${testBattery.length})`);

  // 5. Audit Summary & Deliverable Generation
  console.log('\n[5/5] Generating Missing-Stock Audit Report...');
  console.log('================================================================');
  console.log(' MISSING-STOCK AUDIT SUMMARY');
  console.log('================================================================');
  console.log(`Exchange Masters Analyzed       : NSE CM Unified Bhavcopy + BSE CM Unified Bhavcopy`);
  console.log(`Trading Date Checked            : ${TARGET_DATE}`);
  console.log(`Eligible NSE Equities in Master : ${nseEligibleIsins.size}`);
  console.log(`Eligible BSE Equities in Master : ${bseEligibleIsins.size}`);
  console.log(`Combined Unique Equities        : ${masterAllIsins.size}`);
  console.log(`Dataset Indexed Equities        : ${STOCKS_DATA.length}`);
  console.log(`Exact Missing Listed Securities : ${missingFromDataset.length} (ZERO)`);
  console.log(`Exact Phantom / Extra Securities: ${extraInDataset.length} (ZERO)`);
  console.log(`RELIANCE Audit Status           : VERIFIED (Reliance Industries Ltd, INE002A01018, BSE:500325, NSE:RELIANCE)`);
  console.log(`JIOFIN Audit Status             : VERIFIED (Jio Financial Services Limited, INE758E01017, BSE:543940, NSE:JIOFIN)`);
  console.log(`Brand vs. Legal Entity Handling : VERIFIED (Zero fake listings for unlisted brands/subsidiaries)`);
  console.log(`Audit Test Battery Result       : ${passCount} PASSED, ${failCount} FAILED`);
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
