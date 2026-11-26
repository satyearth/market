'use strict';

const assert = require('assert');
const {
  executeStockQuery,
  loadMarketStatsAsync,
  queryStocksAsync,
  queryStockHistoryAsync,
  resetCacheForTests
} = require('../src/query/stock-query-service');
const { buildCompactHistoryPayload } = require('../src/storage/historical-store');
const healthApi = require('../api/health');
const stocksApi = require('../api/stocks');
const statusApi = require('../api/market/status');
const datasetApi = require('../api/market/dataset');
const historyApi = require('../api/market/history');
const refreshApi = require('../api/market/refresh');

function createMockRes() {
  const out = { statusCode: 200, headers: {}, body: null };
  return {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    status(code) { out.statusCode = code; return this; },
    json(payload) { out.body = payload; return this; },
    getResult: () => out
  };
}

async function run() {
  resetCacheForTests();

  // 1. Query engine filters, search aliases, cap limit <= 50
  const dataset = {
    stats: { tradingDate: '2026-11-25', stockCount: 3 },
    stocks: Array.from({ length: 60 }, (_, idx) => ({
      isin: `INE000A${String(10000 + idx).slice(0, 5)}`,
      symbol: idx === 0 ? 'ETERNAL' : `SYM${idx}`,
      company_name: idx === 0 ? 'Eternal Limited' : `Sample ${idx} Limited`,
      exchanges: idx % 2 === 0 ? ['NSE', 'BSE'] : ['NSE'],
      market_cap_cr: 10000 - idx * 10,
      current_price: 100 + idx,
      prev_close: 100,
      change_percent: idx,
      volume_ratio: idx === 1 ? 2.5 : 1.0,
      sector: 'Financial Services'
    }))
  };

  const page1 = executeStockQuery(dataset, { limit: '200' });
  assert.strictEqual(page1.stocks.length, 50, 'Page limit must be bounded to <= 50');
  assert.strictEqual(page1.hasMore, true);

  const aliasHit = executeStockQuery(dataset, { search: 'zomato' });
  assert.strictEqual(aliasHit.total, 1);
  assert.strictEqual(aliasHit.stocks[0].symbol, 'ETERNAL');

  const highVol = executeStockQuery(dataset, { filter: 'HIGH VOLUME' });
  assert.strictEqual(highVol.total, 1);

  // 2. loadMarketStatsAsync pointer cache hit test
  let manifestFetches = 0;
  const mockStorage = {
    isReadConfigured: () => true,
    fetchLatestManifest: async () => {
      manifestFetches++;
      return {
        ok: true,
        manifest: {
          versionId: 'v-cache-test',
          tradingDate: '2026-11-25',
          totalStocks: 5405,
          stats: { tradingDate: '2026-11-25', totalStocks: 5405, stockCount: 5405 }
        }
      };
    }
  };
  await loadMarketStatsAsync({ storageClient: mockStorage });
  await loadMarketStatsAsync({ storageClient: mockStorage });
  assert.strictEqual(manifestFetches, 1, 'Manifest pointer cache should serve second call within 15s TTL');

  // 3. Method enforcement on Vercel API handlers
  const resHealthPost = createMockRes();
  await healthApi({ method: 'POST' }, resHealthPost);
  assert.strictEqual(resHealthPost.getResult().statusCode, 405);

  const resDatasetPost = createMockRes();
  await datasetApi({ method: 'POST' }, resDatasetPost);
  assert.strictEqual(resDatasetPost.getResult().statusCode, 405);

  const resStocksPost = createMockRes();
  await stocksApi({ method: 'POST' }, resStocksPost);
  assert.strictEqual(resStocksPost.getResult().statusCode, 405);

  const resStatusPost = createMockRes();
  await statusApi({ method: 'POST' }, resStatusPost);
  assert.strictEqual(resStatusPost.getResult().statusCode, 405);

  const resRefreshGet = createMockRes();
  await refreshApi({ method: 'GET' }, resRefreshGet);
  assert.strictEqual(resRefreshGet.getResult().statusCode, 405);

  // 4. Live Vercel handler happy paths (local dataset fallback)
  const resHealthGet = createMockRes();
  await healthApi({ method: 'GET' }, resHealthGet);
  assert.strictEqual(resHealthGet.getResult().statusCode, 200);
  assert.strictEqual(resHealthGet.getResult().body.ok, true);

  const resStatusGet = createMockRes();
  await statusApi({ method: 'GET' }, resStatusGet);
  assert.strictEqual(resStatusGet.getResult().statusCode, 200);
  assert.strictEqual(resStatusGet.getResult().body.canTriggerSync, false);

  const resSingle = createMockRes();
  await stocksApi({ method: 'GET', query: { isin: 'INE002A01018', limit: '1' } }, resSingle);
  assert.strictEqual(resSingle.getResult().statusCode, 200);
  assert.strictEqual(resSingle.getResult().body.ok, true);

  const resHistoryPost = createMockRes();
  await historyApi({ method: 'POST' }, resHistoryPost);
  assert.strictEqual(resHistoryPost.getResult().statusCode, 405);

  const resHistoryBadIsin = createMockRes();
  await historyApi({ method: 'GET', query: { isin: 'BAD' } }, resHistoryBadIsin);
  assert.strictEqual(resHistoryBadIsin.getResult().statusCode, 400);

  const resHistorySingle = createMockRes();
  await historyApi({ method: 'GET', query: { isin: 'INE002A01018' } }, resHistorySingle);
  assert.strictEqual(resHistorySingle.getResult().statusCode, 200);
  assert.strictEqual(resHistorySingle.getResult().body.isin, 'INE002A01018');
  assert.ok(Array.isArray(resHistorySingle.getResult().body.historical_prices));

  // 5. Separated compressed remote storage: listing stays light, stock detail & /api/market/history hydrate from history/
  resetCacheForTests();
  let datasetFetches = 0;
  let historyFetches = 0;
  const compactRemoteHistory = buildCompactHistoryPayload({
    sessions: ['2026-11-24', '2026-11-25'],
    priceHistoryByIsin: new Map([['INE002A01018', { '2026-11-24': 1351, '2026-11-25': 1373.9 }]]),
    versionId: '2026-11-25-hist-v2',
    tradingDate: '2026-11-25'
  });
  const separatedStorageMock = {
    isReadConfigured: () => true,
    fetchLatestManifest: async () => ({
      ok: true,
      manifest: {
        versionId: 'v-sep-1',
        tradingDate: '2026-11-25',
        totalStocks: 2,
        historicalDataset: {
          versionId: '2026-11-25-hist-v2',
          datasetPath: 'history/2026-11-25/historical-prices-2026-11-25-hist-v2.json',
          startDate: '2026-11-24',
          endDate: '2026-11-25',
          sessionCount: 2,
          maxSessions: 90
        },
        stats: { tradingDate: '2026-11-25', totalStocks: 2, stockCount: 2 }
      }
    }),
    fetchLatestDataset: async ({ knownVersionId } = {}) => {
      if (knownVersionId === 'v-sep-1') {
        return { ok: true, unchanged: true };
      }
      datasetFetches++;
      return {
        ok: true,
        unchanged: false,
        manifest: {
          versionId: 'v-sep-1',
          tradingDate: '2026-11-25',
          historicalDataset: {
            versionId: '2026-11-25-hist-v2',
            datasetPath: 'history/2026-11-25/historical-prices-2026-11-25-hist-v2.json',
            startDate: '2026-11-24',
            endDate: '2026-11-25',
            sessionCount: 2,
            maxSessions: 90
          }
        },
        stats: { tradingDate: '2026-11-25', totalStocks: 2, stockCount: 2 },
        stocks: [
          { isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance', current_price: 1373.9, exchanges: ['NSE', 'BSE'], sparkline_7d: [1351, 1373.9], return_1w: 1.69, return_1m: null, return_3m: null },
          { isin: 'INE467B01029', symbol: 'TCS', company_name: 'TCS', current_price: 4100, exchanges: ['NSE', 'BSE'], sparkline_7d: [4050, 4100] }
        ],
        historicalDatasetMeta: {
          versionId: '2026-11-25-hist-v2',
          datasetPath: 'history/2026-11-25/historical-prices-2026-11-25-hist-v2.json',
          startDate: '2026-11-24',
          endDate: '2026-11-25',
          sessionCount: 2,
          maxSessions: 90
        }
      };
    },
    fetchHistoricalDataset: async (meta, { knownVersionId } = {}) => {
      if (knownVersionId === '2026-11-25-hist-v2') {
        return { ok: true, unchanged: true, meta };
      }
      historyFetches++;
      return { ok: true, unchanged: false, meta, history: compactRemoteHistory };
    }
  };

  const listQuery = await queryStocksAsync({ limit: '50' }, { storageClient: separatedStorageMock });
  assert.strictEqual(datasetFetches, 1);
  assert.strictEqual(historyFetches, 0, 'Homepage list query must NOT download separated historical dataset');
  assert.strictEqual(listQuery.stocks[0].historical_prices, undefined);

  const detailQuery = await queryStocksAsync({ isin: 'INE002A01018', limit: '1' }, { storageClient: separatedStorageMock });
  assert.strictEqual(historyFetches, 1, 'Stock detail ISIN query hydrates from separated historical dataset');
  assert.strictEqual(detailQuery.stocks[0].historical_prices.length, 2);
  assert.strictEqual(detailQuery.stocks[0].historical_prices[1].close, 1373.9);

  const histQuery = await queryStockHistoryAsync({ isin: 'INE002A01018' }, { storageClient: separatedStorageMock });
  assert.strictEqual(histQuery.ok, true);
  assert.strictEqual(historyFetches, 1, 'Second history lookup reuses in-memory history cache');
  assert.strictEqual(histQuery.historical_prices.length, 2);

  const missingHistQuery = await queryStockHistoryAsync({ isin: 'INE999Z99999' }, { storageClient: separatedStorageMock });
  assert.strictEqual(missingHistQuery.ok, false);
  assert.strictEqual(missingHistQuery.statusCode, 404);

  // 6. /api/market/history derives 1W (6), 1M (22), and 3M (66) returns when omitted from daily snapshot & keeps null when insufficient
  resetCacheForTests();
  const { getRecentTradingSessions } = require('../src/calendar/exchange-calendar');
  const sess66 = getRecentTradingSessions('2026-11-26', 66);
  const relMap66 = {};
  const newIpoMap = {};
  sess66.forEach((d, idx) => {
    let px = 150 + idx;
    if (idx === 0) px = 100;   // 66th session -> +100%
    if (idx === 44) px = 160;  // 22nd session -> +25%
    if (idx === 60) px = 190;  // 6th session  -> +5.26%
    if (idx === 65) px = 200;  // latest session
    relMap66[d] = px;
    if (idx >= 56) newIpoMap[d] = 100 + (idx - 56);
  });
  const compact66 = buildCompactHistoryPayload({
    sessions: sess66,
    priceHistoryByIsin: new Map([
      ['INE002A01018', relMap66],
      ['INE000A00055', newIpoMap]
    ]),
    versionId: 'hist-66-test',
    tradingDate: sess66[65]
  });
  const storage66Mock = {
    isReadConfigured: () => true,
    fetchLatestManifest: async () => ({
      ok: true,
      manifest: {
        versionId: 'v-66-daily',
        tradingDate: sess66[65],
        totalStocks: 2,
        historicalDataset: { versionId: 'hist-66-test', datasetPath: 'history/2026-11-26/h66.json', sessionCount: 66, maxSessions: 90 },
        stats: { tradingDate: sess66[65], totalStocks: 2, stockCount: 2 }
      }
    }),
    fetchLatestDataset: async () => ({
      ok: true,
      unchanged: false,
      manifest: {
        versionId: 'v-66-daily',
        tradingDate: sess66[65],
        historicalDataset: { versionId: 'hist-66-test', datasetPath: 'history/2026-11-26/h66.json', sessionCount: 66, maxSessions: 90 }
      },
      stats: { tradingDate: sess66[65], totalStocks: 2, stockCount: 2 },
      stocks: [
        { isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance', current_price: 200, exchanges: ['NSE', 'BSE'], return_1w: null, return_1m: null, return_3m: null },
        { isin: 'INE000A00055', symbol: 'NEWIPO', company_name: 'New IPO', current_price: 109, exchanges: ['NSE'], return_1w: null, return_1m: null, return_3m: null }
      ],
      historicalDatasetMeta: { versionId: 'hist-66-test', datasetPath: 'history/2026-11-26/h66.json', sessionCount: 66, maxSessions: 90 }
    }),
    fetchHistoricalDataset: async (meta) => ({ ok: true, unchanged: false, meta, history: compact66 })
  };

  const rel66Hist = await queryStockHistoryAsync({ isin: 'INE002A01018' }, { storageClient: storage66Mock });
  assert.strictEqual(rel66Hist.return_1w, 5.26, '6-session return (200 / 190 - 1) * 100 = 5.26%');
  assert.strictEqual(rel66Hist.return_1m, 25, '22-session return (200 / 160 - 1) * 100 = 25%');
  assert.strictEqual(rel66Hist.return_3m, 100, '66-session return (200 / 100 - 1) * 100 = 100%');

  const ipoHist = await queryStockHistoryAsync({ isin: 'INE000A00055' }, { storageClient: storage66Mock });
  assert.strictEqual(ipoHist.return_1m, null, '10-session IPO must keep return_1m strictly null');
  assert.strictEqual(ipoHist.return_3m, null, '10-session IPO must keep return_3m strictly null');
  resetCacheForTests();
}

module.exports = { name: 'api-and-query.test.js', run };
