'use strict';

const assert = require('assert');
const { executeStockQuery, loadMarketStatsAsync, resetCacheForTests } = require('../src/query/stock-query-service');
const healthApi = require('../api/health');
const stocksApi = require('../api/stocks');
const statusApi = require('../api/market/status');
const datasetApi = require('../api/market/dataset');
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
}

module.exports = { name: 'api-and-query.test.js', run };
