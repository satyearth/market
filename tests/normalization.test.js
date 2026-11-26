'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCSVContent, cleanCompanyName } = require('../src/processing/csv-parser');
const { mergeExchangeUniverse } = require('../src/processing/universe-merger');
const { getNseFilename, getBseFilename } = require('../src/ingestion/bhavcopy-downloader');

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
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { name: 'normalization.test.js', run };
