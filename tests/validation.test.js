'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateMergedDataset } = require('../src/validation/dataset-validator');
const { validateCompactHistoryPayload } = require('../src/storage/historical-store');
const { runRefresh } = require('../src/publishing/publisher');
const { getNseFilename, getBseFilename } = require('../src/ingestion/bhavcopy-downloader');

function makeValidStock(idx) {
  return {
    isin: `INE000A${String(10000 + idx).slice(0, 5)}`,
    symbol: `SYM${idx}`,
    company_name: `Company ${idx} Limited`,
    trading_date: '2026-11-25',
    current_price: 100,
    close_price: 100,
    open_price: 99,
    high_price: 102,
    low_price: 98,
    prev_close: 95,
    volume: 1000,
    market_cap_cr: 500,
    historical_prices: [
      { date: '2026-11-23', close: 95 },
      { date: '2026-11-25', close: 100 }
    ]
  };
}

async function run() {
  const validStocks = [makeValidStock(1), makeValidStock(2)];
  const validStats = {
    tradingDate: '2026-11-25',
    nseSourceDate: '2026-11-25',
    bseSourceDate: '2026-11-25',
    marketBreadth: { advances: 2, declines: 0, unchanged: 0, unpriced: 0 },
    exchangeCoverage: { dualListed: 2, nseOnly: 0, bseOnly: 0 }
  };

  assert.strictEqual(validateMergedDataset(validStocks, validStats, { minUniverseSize: 2 }).ok, true);

  // Duplicate ISIN must fail
  const dupRes = validateMergedDataset([makeValidStock(1), makeValidStock(1)], validStats, { minUniverseSize: 2 });
  assert.strictEqual(dupRes.ok, false);
  assert.ok(dupRes.errors.some(e => e.includes('Duplicate ISIN')));

  // Bad breadth identity must fail
  const badBreadth = { ...validStats, marketBreadth: { advances: 1, declines: 0, unchanged: 0, unpriced: 0 } };
  const breadthRes = validateMergedDataset(validStocks, badBreadth, { minUniverseSize: 2 });
  assert.strictEqual(breadthRes.ok, false);
  assert.ok(breadthRes.errors.some(e => e.includes('Breadth arithmetic identity mismatch')));

  // High < Low must fail
  const badSpread = [makeValidStock(1), { ...makeValidStock(2), high_price: 90, low_price: 98 }];
  const spreadRes = validateMergedDataset(badSpread, validStats, { minUniverseSize: 2 });
  assert.strictEqual(spreadRes.ok, false);
  assert.ok(spreadRes.errors.some(e => e.includes('High < Low')));

  // Shrinkage > 10% must fail unless forced
  const shrinkRes = validateMergedDataset(validStocks, validStats, { minUniverseSize: 2, previousCount: 1500 });
  assert.strictEqual(shrinkRes.ok, false);
  assert.ok(shrinkRes.errors.some(e => e.includes('Unexpected record-count drop')));

  // 90-session history length and valid 1W/1M/3M returns pass; >90 or future dates or NaN returns fail
  const { getRecentTradingSessions } = require('../src/calendar/exchange-calendar');
  const dates91 = getRecentTradingSessions('2026-11-25', 91);
  const dates90 = dates91.slice(-90);
  const stock90 = {
    ...makeValidStock(1),
    historical_prices: dates90.map((d, i) => ({ date: d, close: 100 + i })),
    return_1w: 4.5,
    return_1m: 12.25,
    return_3m: 28.4
  };
  assert.strictEqual(
    validateMergedDataset([stock90, makeValidStock(2)], {
      ...validStats,
      historicalSessions: { maxSessions: 90, sessionCount: 90, sessions: dates90 }
    }, { minUniverseSize: 2 }).ok,
    true,
    '90-session historical_prices with finite 1W/1M/3M returns must pass validation'
  );

  const oversized91 = {
    ...makeValidStock(1),
    historical_prices: dates91.map((d, i) => ({ date: d, close: 100 + i }))
  };
  assert.strictEqual(validateMergedDataset([oversized91, makeValidStock(2)], validStats, { minUniverseSize: 2 }).ok, false);

  const futureHist = {
    ...makeValidStock(1),
    historical_prices: [{ date: '2026-11-25', close: 100 }, { date: '2026-11-26', close: 101 }]
  };
  assert.strictEqual(validateMergedDataset([futureHist, makeValidStock(2)], validStats, { minUniverseSize: 2 }).ok, false);

  const nonFiniteRet = { ...makeValidStock(1), return_1m: Number.NaN };
  assert.strictEqual(validateMergedDataset([nonFiniteRet, makeValidStock(2)], validStats, { minUniverseSize: 2 }).ok, false);

  // Compact historical payload structural validation
  const compactValid = {
    tradingDate: dates90[89],
    sessions: dates90,
    sessionCount: 90,
    isinCount: 1,
    closesByIsin: { INE002A01018: [0, dates90.map((_, i) => 100 + i)] }
  };
  assert.strictEqual(validateCompactHistoryPayload(compactValid, { maxSessions: 90 }).ok, true);
  assert.strictEqual(
    validateCompactHistoryPayload({
      tradingDate: dates91[90],
      sessions: dates91,
      sessionCount: 91,
      closesByIsin: { INE002A01018: [0, dates91.map((_, i) => 100 + i)] }
    }, { maxSessions: 90 }).ok,
    false,
    'Compact history exceeding 90 sessions must fail'
  );
  assert.strictEqual(
    validateCompactHistoryPayload({
      tradingDate: '2026-11-25',
      sessions: ['2026-11-24', '2026-11-26'],
      closesByIsin: { INE002A01018: [0, [100, 102]] }
    }).ok,
    false,
    'Compact history with future date > tradingDate must fail'
  );
  assert.strictEqual(
    validateCompactHistoryPayload({
      tradingDate: '2026-11-25',
      sessions: ['2026-11-24', '2026-11-25'],
      closesByIsin: { INE002A01018: [0, [100, -5]] }
    }).ok,
    false,
    'Compact history with negative close must fail'
  );

  // syncOnly without --date uses stored.latestCompleteDate even after 16:30 IST
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-synconly-'));
  try {
    const dt = '2026-11-25';
    fs.writeFileSync(
      path.join(tmpDir, getNseFilename(dt)),
      `TradDt,ISIN,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol\n${dt},INE002A01018,RELIANCE,EQ,RELIANCE IND,100,105,99,102,100,5000\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, getBseFilename(dt)),
      `TradDt,ISIN,FinInstrmId,TckrSymb,SctySrs,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,PrvsClsgPric,TtlTradgVol\n${dt},INE002A01018,500325,RELIANCE,A,RELIANCE IND,100,105,99,102,100,2000\n`
    );
    const out = await runRefresh({
      syncOnly: true,
      force: true,
      dryRun: true,
      skipStorage: true,
      skipReport: true,
      minRows: 1,
      minSourceRows: 1,
      minUniverseSize: 1,
      minBytes: 50,
      downloadsDir: tmpDir,
      targetPath: path.join(tmpDir, 'stocks-data.js'),
      backupPath: path.join(tmpDir, 'stocks-data.backup.js'),
      marketCapSources: {
        benchmarkBySymbol: new Map(),
        bseSecByIsin: new Map(),
        catalogByIsin: new Map(),
        catalogByTicker: new Map(),
        screenerBySlug: new Map()
      },
      now: new Date('2026-11-26T20:00:00+05:30'),
      logger: { log() {}, warn() {} }
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.tradingDate, '2026-11-25');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { name: 'validation.test.js', run };
