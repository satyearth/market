'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCSVContent, cleanCompanyName } = require('../src/processing/csv-parser');
const { mergeExchangeUniverse, computePeriodReturn, compileHistoricalMatrix } = require('../src/processing/universe-merger');
const { getRecentTradingSessions } = require('../src/calendar/exchange-calendar');
const { getNseFilename, getBseFilename } = require('../src/ingestion/bhavcopy-downloader');
const {
  buildCompactHistoryPayload,
  expandHistoricalPricesForIsin,
  encodeCompressedJson,
  decodeCompressedJson
} = require('../src/storage/historical-store');

async function run() {
  // 1. RFC-4180 CSV quoted commas & company name normalization
  const csv = 'ColA,ColB\n"TCS, Limited",100';
  const parsed = parseCSVContent(csv);
  assert.strictEqual(parsed[0].ColA, 'TCS, Limited');
  assert.strictEqual(cleanCompanyName('RELIANCE INDS LTD.'), 'Reliance Industries Limited');

  // 2. ISIN deduplication & dual-listed volume sum + carry-forward + 6-session 1W return
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-norm-'));
  try {
    const dates = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-23', '2026-11-25'];
    for (let i = 0; i < dates.length; i++) {
      const dt = dates[i];
      const close = 100 + i * 2;
      fs.writeFileSync(
        path.join(tmpDir, getNseFilename(dt)),
        `TradDt,ISIN,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol\n${dt},INE002A01018,RELIANCE,EQ,RELIANCE INDUSTRIES LTD,${close - 1},${close + 2},${close - 2},${close},${close - 1},1000\n`
      );
      fs.writeFileSync(
        path.join(tmpDir, getBseFilename(dt)),
        `TradDt,ISIN,FinInstrmId,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol\n${dt},INE002A01018,500325,RELIANCE,A,RELIANCE INDUSTRIES LIMITED,${close - 1},${close + 3},${close - 1},${close},${close - 1},500\n`
      );
    }

    const nseRaw = parseCSVContent(fs.readFileSync(path.join(tmpDir, getNseFilename('2026-11-25')), 'utf8'));
    const bseRaw = parseCSVContent(fs.readFileSync(path.join(tmpDir, getBseFilename('2026-11-25')), 'utf8'));

    const emptyMcap = {
      benchmarkBySymbol: new Map(),
      bseSecByIsin: new Map(),
      catalogByIsin: new Map(),
      catalogByTicker: new Map(),
      screenerBySlug: new Map()
    };

    const { mergedStocks, counts } = mergeExchangeUniverse({
      targetDate: '2026-11-25',
      nseRaw,
      bseRaw,
      downloadsDir: tmpDir,
      historicalDates: dates,
      marketCapSources: emptyMcap,
      previousUniverseByIsin: new Map([['INE002A01018', { isin: 'INE002A01018', market_cap_cr: 1800000, pe_ratio: 28.5 }]]),
      nse52Week: { loaded: false },
      bse52Week: { loaded: false, near52WeekScripCodes: new Set(), week52HighMap: new Map() },
      fetchStartTime: new Date('2026-11-25T11:30:00Z')
    });

    assert.strictEqual(mergedStocks.length, 1);
    assert.strictEqual(counts.dualListedCount, 1);
    const rel = mergedStocks[0];
    assert.strictEqual(rel.isin, 'INE002A01018');
    assert.deepStrictEqual(rel.exchanges, ['NSE', 'BSE']);
    assert.strictEqual(rel.volume, 1500, 'Dual-listed volume should aggregate NSE+BSE');
    assert.strictEqual(rel.high_price, 113, 'High should take max(NSE, BSE)');
    assert.strictEqual(rel.historical_prices.length, 6);
    assert.strictEqual(rel.return_1w, 10, '100 -> 110 over 6 sessions = +10%');
    assert.strictEqual(rel.market_cap_cr, 1800000, 'Should carry over previous market_cap_cr');
    assert.strictEqual(rel.pe_ratio, 28.5, 'Should carry over previous pe_ratio when benchmark file missing');
    assert.strictEqual(rel.return_1m, null, '1M return must stay null when only 6 sessions exist');
    assert.strictEqual(rel.return_3m, null, '3M return must stay null when only 6 sessions exist');

    // 3. 90-session history capping, cold-runner carryover, gap preservation, 5-day carry-forward bound, and 1W/1M/3M returns
    const tmp90 = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-norm90-'));
    try {
      const dates95 = getRecentTradingSessions('2026-12-24', 95);
      const dates90 = dates95.slice(-90);
      const target90 = dates90[dates90.length - 1];

      // Seed prior snapshot with 94 historical closes (dates95[0..93]) for RELIANCE,
      // recent 10 closes for IPO_NEW, a gap (no middle sessions) for GAP_STOCK,
      // and a stale dormant stock that did not trade in prior 5 sessions.
      const relPrevHistory = dates95.slice(0, 94).map((dt, idx) => {
        // Assign deterministic closes so 66th-from-end = 200, 22nd-from-end = 250, 6th-from-end = 280
        const posFromEnd = 94 - idx; // 94 down to 1 before today
        let close = 150 + idx;
        if (posFromEnd === 65) close = 200; // win3m[0] (66th session including today)
        if (posFromEnd === 21) close = 250; // win1m[0] (22nd session including today)
        if (posFromEnd === 5) close = 280;  // win1w[0] (6th session including today)
        return { date: dt, close };
      });
      const prevMap = new Map([
        ['INE002A01018', { isin: 'INE002A01018', market_cap_cr: 1850000, historical_prices: relPrevHistory }],
        ['INE000A00001', { isin: 'INE000A00001', market_cap_cr: 500, historical_prices: dates95.slice(84, 94).map((d, i) => ({ date: d, close: 100 + i })) }],
        ['INE000A00002', { isin: 'INE000A00002', market_cap_cr: 200, historical_prices: [{ date: dates95[20], close: 50 }, { date: dates95[92], close: 60 }] }]
      ]);

      // Write only target day CSV + one 10-day-old CSV with DORMANT_OLD (must NOT be resurrected beyond 5 prior sessions!)
      const tenDaysBack = dates90[dates90.length - 11];
      fs.writeFileSync(
        path.join(tmp90, getNseFilename(tenDaysBack)),
        `TradDt,ISIN,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol\n` +
        `${tenDaysBack},INE999Z01999,DORMANT_OLD,EQ,DORMANT OLD LTD,40,41,39,40,40,10\n`
      );
      fs.writeFileSync(
        path.join(tmp90, getNseFilename(target90)),
        `TradDt,ISIN,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol\n` +
        `${target90},INE002A01018,RELIANCE,EQ,RELIANCE IND,300,310,298,308,302,10000\n` +
        `${target90},INE000A00001,IPO_NEW,EQ,IPO NEW LTD,110,115,109,110,109,5000\n` +
        `${target90},INE000A00002,GAP_STOCK,EQ,GAP STOCK LTD,60,65,59,63,60,100\n`
      );

      const nse90Raw = parseCSVContent(fs.readFileSync(path.join(tmp90, getNseFilename(target90)), 'utf8'));
      const res90 = mergeExchangeUniverse({
        targetDate: target90,
        nseRaw: nse90Raw,
        bseRaw: [],
        downloadsDir: tmp90,
        historicalDates: dates90,
        marketCapSources: emptyMcap,
        previousUniverseByIsin: prevMap,
        nse52Week: { loaded: false },
        bse52Week: { loaded: false, near52WeekScripCodes: new Set(), week52HighMap: new Map() },
        fetchStartTime: new Date('2026-12-24T12:00:00Z')
      });

      assert(!res90.mergedStocks.some(s => s.isin === 'INE999Z01999'), 'Stock last traded 10 sessions ago must NOT be carried forward past 5-session limit');

      const rel90 = res90.mergedStocks.find(s => s.isin === 'INE002A01018');
      assert.strictEqual(rel90.historical_prices.length, 90, 'History length must cap strictly at 90 sessions');
      assert.strictEqual(rel90.historical_prices[0].date, dates90[0], 'Oldest 5 dates from 95-day carryover must be pruned');
      assert.strictEqual(rel90.historical_prices[89].date, target90);
      assert.strictEqual(rel90.sparkline_7d.length, 6, 'sparkline_7d must stay bounded to 6 recent sessions');
      assert.strictEqual(rel90.return_1w, 10, '280 -> 308 over 6 sessions = +10%');
      assert.strictEqual(rel90.return_1m, 23.2, '250 -> 308 over 22 sessions = +23.2%');
      assert.strictEqual(rel90.return_3m, 54, '200 -> 308 over 66 sessions = +54%');

      const ipo90 = res90.mergedStocks.find(s => s.isin === 'INE000A00001');
      assert.strictEqual(ipo90.historical_prices.length, 11);
      assert.strictEqual(ipo90.return_1m, null, '11-session IPO must keep return_1m null');
      assert.strictEqual(ipo90.return_3m, null, '11-session IPO must keep return_3m null');

      const gap90 = res90.mergedStocks.find(s => s.isin === 'INE000A00002');
      assert.strictEqual(gap90.historical_prices.length, 3, 'Missing sessions must NOT be fabricated/interpolated');
      assert.strictEqual(gap90.return_1m, null, 'Stock missing 1M baseline must keep return_1m null');
      assert.strictEqual(gap90.return_3m, null, 'Stock missing 3M baseline must keep return_3m null');

      // Direct unit check on insufficient dataset sessions (< 22)
      const insRes = computePeriodReturn({
        validDates: dates90.slice(-20),
        histObj: Object.fromEntries(dates90.slice(-20).map((d, i) => [d, 100 + i])),
        currentPrice: 119,
        historicalDates: dates90.slice(-20),
        populatedDateSet: new Set(dates90.slice(-20)),
        targetSessions: 22,
        maxStartLag: 2,
        requireFullDatasetWindow: true
      });
      assert.strictEqual(insRes.value, null, 'Dataset with only 20 sessions must return null for 1M');

      // Compact history build, null-gap preservation, gzip+base64 roundtrip & cold hydration
      const compactHist = buildCompactHistoryPayload({
        sessions: [...dates95, dates95[10]], // includes out-of-window oldest + duplicate date
        priceHistoryByIsin: res90.priceHistoryByIsin,
        tradingDate: target90,
        maxSessions: 90
      });
      assert.strictEqual(compactHist.sessionCount, 90, 'Compact history deduplicates dates and caps to 90 sessions');
      assert.deepStrictEqual(compactHist.closesByIsin['INE000A00001'][0], 79, 'IPO entry starts without leading null padding');
      assert.strictEqual(compactHist.closesByIsin['INE000A00001'][1].length, 11);
      assert.ok(compactHist.closesByIsin['INE000A00002'][1].includes(null), 'Missing mid-window session must stay null without fabrication');

      const encoded = encodeCompressedJson(compactHist);
      const decoded = decodeCompressedJson(encoded.text);
      assert.strictEqual(decoded.compressed, true);
      const relExpanded = expandHistoricalPricesForIsin(decoded.data, 'INE002A01018');
      assert.strictEqual(relExpanded.length, 90);
      assert.strictEqual(relExpanded[89].close, 308);

      // Verify compileHistoricalMatrix hydrates directly from previousHistoryDataset even with empty previousUniverse
      const recoveredMap = compileHistoricalMatrix(tmp90, dates90, new Map(), decoded.data);
      assert.strictEqual(Object.keys(recoveredMap.get('INE002A01018')).length, 90, 'Cold hydration recovers all 90 sessions from compact history');
    } finally {
      fs.rmSync(tmp90, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { name: 'normalization.test.js', run };
