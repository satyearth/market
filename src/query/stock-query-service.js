'use strict';

/**
 * Stock Query & Remote Dataset Caching Service
 *
 * Reads validated datasets from Supabase Storage (with 15s manifest pointer
 * cache + versionId deduplication) and gracefully falls back to local
 * js/stocks-data.js. Applies sector/industry overrides and executes fast
 * filtering, searching, sorting, and bounded pagination.
 */

const fs = require('fs');
const {
  TARGET_DATA_PATH,
  POINTER_CACHE_TTL_MS,
  SECTOR_OVERRIDES
} = require('../config/constants');
const defaultStorage = require('../storage/supabase-storage');

const DATA_PATH = TARGET_DATA_PATH;

let cachedLocal = null;
let cachedRemote = null; // { versionId, checkedAt, data, manifest }
let cachedManifestOnly = null; // { checkedAt, stats, manifest, versionId }

const ALIASES = {
  zomato: 'ETERNAL',
  blinkit: 'ETERNAL',
  policybazaar: 'POLICYBZR',
  paisabazaar: 'POLICYBZR',
  maggi: 'NESTLEIND',
  jlr: 'TATAMOTORS',
  jaguar: 'TATAMOTORS'
};

const SORTABLE = new Set([
  'rank', 'symbol', 'current_price', 'change_percent', 'market_cap_cr',
  'return_1w', 'return_1m', 'return_3m', 'volume_ratio', 'volume'
]);

function normalizeDataset(stats, rawStocks) {
  const seen = new Set();
  const stocks = [];
  for (const raw of rawStocks || []) {
    const isin = String(raw.isin || '').trim().toUpperCase();
    if (!isin || seen.has(isin)) continue;
    seen.add(isin);
    const stock = { ...raw, isin };
    if (SECTOR_OVERRIDES[isin]) {
      stock.sector = SECTOR_OVERRIDES[isin].sector;
      stock.industry = SECTOR_OVERRIDES[isin].industry;
    } else if (!stock.sector || String(stock.sector).toUpperCase() === 'GENERAL') {
      stock.sector = 'Unclassified';
    }
    stocks.push(stock);
  }
  return { stats, stocks };
}

function loadDataset(dataPath = DATA_PATH) {
  const stat = fs.statSync(dataPath);
  if (dataPath === DATA_PATH && cachedLocal && cachedLocal.mtimeMs === stat.mtimeMs && cachedLocal.size === stat.size) {
    return cachedLocal.data;
  }
  const source = fs.readFileSync(dataPath, 'utf8');
  const statsMatch = source.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
  const stocksMatch = source.match(/const STOCKS_DATA = (\[[\s\S]*\]);\s*$/);
  if (!statsMatch || !stocksMatch) throw new Error('Stock dataset format is invalid');
  const data = normalizeDataset(JSON.parse(statsMatch[1]), JSON.parse(stocksMatch[1]));
  if (dataPath === DATA_PATH) {
    cachedLocal = { mtimeMs: stat.mtimeMs, size: stat.size, data };
  }
  return data;
}

function readLocalStatsSafe(dataPath = DATA_PATH) {
  try {
    if (!fs.existsSync(dataPath)) return null;
    const content = fs.readFileSync(dataPath, 'utf8');
    const match = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
    return match ? JSON.parse(match[1]) : null;
  } catch (_) {
    return null;
  }
}

async function loadDatasetAsync(options = {}) {
  const storage = options.storageClient || defaultStorage;
  const dataPath = options.dataPath || DATA_PATH;

  if (storage.isReadConfigured()) {
    const now = Date.now();
    if (!options.force && cachedRemote && (now - cachedRemote.checkedAt < POINTER_CACHE_TTL_MS)) {
      return {
        ...cachedRemote.data,
        storageSource: 'supabase_storage',
        storageVersionId: cachedRemote.versionId
      };
    }

    try {
      const remote = await storage.fetchLatestDataset({
        knownVersionId: options.force ? null : cachedRemote?.versionId
      });

      if (remote.ok && remote.unchanged && cachedRemote) {
        cachedRemote.checkedAt = now;
        return {
          ...cachedRemote.data,
          storageSource: 'supabase_storage',
          storageVersionId: cachedRemote.versionId
        };
      }

      if (remote.ok && remote.stats && Array.isArray(remote.stocks)) {
        const normalized = normalizeDataset(remote.stats, remote.stocks);
        const versionId = remote.manifest?.versionId || remote.stats.storageVersionId || remote.stats.refreshedAtUtc;
        cachedRemote = {
          versionId,
          checkedAt: now,
          manifest: remote.manifest,
          data: normalized
        };
        cachedManifestOnly = {
          checkedAt: now,
          stats: remote.manifest?.stats || remote.stats,
          manifest: remote.manifest,
          versionId
        };
        return {
          ...normalized,
          storageSource: 'supabase_storage',
          storageVersionId: versionId
        };
      }
    } catch (_) {}

    if (cachedRemote?.data) {
      return {
        ...cachedRemote.data,
        storageSource: 'supabase_storage_cached',
        storageVersionId: cachedRemote.versionId
      };
    }

    const localData = loadDataset(dataPath);
    return {
      ...localData,
      storageSource: 'local_fallback',
      storageVersionId: localData.stats?.storageVersionId || null
    };
  }

  const localData = loadDataset(dataPath);
  return {
    ...localData,
    storageSource: 'local_file',
    storageVersionId: localData.stats?.storageVersionId || null
  };
}

async function loadMarketStatsAsync(options = {}) {
  const storage = options.storageClient || defaultStorage;
  const dataPath = options.dataPath || DATA_PATH;

  if (storage.isReadConfigured()) {
    const now = Date.now();
    if (!options.force && cachedRemote && (now - cachedRemote.checkedAt < POINTER_CACHE_TTL_MS)) {
      return {
        stats: cachedRemote.manifest?.stats || cachedRemote.data.stats,
        manifest: cachedRemote.manifest,
        storageSource: 'supabase_storage',
        storageVersionId: cachedRemote.versionId
      };
    }
    if (!options.force && cachedManifestOnly && (now - cachedManifestOnly.checkedAt < POINTER_CACHE_TTL_MS)) {
      return {
        stats: cachedManifestOnly.stats,
        manifest: cachedManifestOnly.manifest,
        storageSource: 'supabase_storage',
        storageVersionId: cachedManifestOnly.versionId
      };
    }

    try {
      const res = await storage.fetchLatestManifest();
      if (res.ok && res.manifest) {
        const stats = res.manifest.stats || {
          tradingDate: res.manifest.tradingDate,
          nseSourceDate: res.manifest.nseSourceDate,
          bseSourceDate: res.manifest.bseSourceDate,
          refreshedAtUtc: res.manifest.refreshedAtUtc,
          istDisplayTime: res.manifest.istDisplayTime,
          totalStocks: res.manifest.totalStocks,
          stockCount: res.manifest.totalStocks,
          pipelineVersion: res.manifest.pipelineVersion,
          storageVersionId: res.manifest.versionId
        };
        cachedManifestOnly = {
          checkedAt: now,
          stats,
          manifest: res.manifest,
          versionId: res.manifest.versionId
        };
        return {
          stats,
          manifest: res.manifest,
          storageSource: 'supabase_storage',
          storageVersionId: res.manifest.versionId
        };
      }
    } catch (_) {}

    if (cachedRemote?.data?.stats) {
      return {
        stats: cachedRemote.data.stats,
        manifest: cachedRemote.manifest,
        storageSource: 'supabase_storage_cached',
        storageVersionId: cachedRemote.versionId
      };
    }
    if (cachedManifestOnly?.stats) {
      return {
        stats: cachedManifestOnly.stats,
        manifest: cachedManifestOnly.manifest,
        storageSource: 'supabase_storage_cached',
        storageVersionId: cachedManifestOnly.versionId
      };
    }
  }

  const localStats = readLocalStatsSafe(dataPath);
  return {
    stats: localStats,
    manifest: null,
    storageSource: storage.isReadConfigured() ? 'local_fallback' : 'local_file',
    storageVersionId: localStats?.storageVersionId || null
  };
}

function resetCacheForTests() {
  cachedLocal = null;
  cachedRemote = null;
  cachedManifestOnly = null;
}

function searchMatches(stock, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const norm = q.replace(/[^a-z0-9]/g, '');
  const alias = ALIASES[q] || ALIASES[norm];
  if (alias && (stock.symbol === alias || stock.nse_symbol === alias)) return true;
  return ['symbol', 'company_name', 'nse_symbol', 'bse_scrip_code', 'isin', 'sector', 'industry']
    .some(key => String(stock[key] || '').toLowerCase().includes(q)) || (norm.length >= 2 &&
      ['symbol', 'company_name', 'nse_symbol'].some(key => String(stock[key] || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(norm)));
}

function executeStockQuery(dataset, params = {}) {
  const { stocks, stats } = dataset;
  const limit = Math.min(50, Math.max(1, Number.parseInt(params.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(params.offset, 10) || 0);
  const exactIsin = params.isin ? String(params.isin).trim().toUpperCase() : '';
  const search = String(params.search || '').slice(0, 120);
  const filter = String(params.filter || 'ALL').toUpperCase();
  const exchange = String(params.exchange || '').toUpperCase();
  const sort = SORTABLE.has(params.sort) ? params.sort : 'market_cap_cr';
  const direction = String(params.direction || 'desc').toLowerCase() === 'asc' ? 1 : -1;

  const results = stocks.filter(s => {
    if (exactIsin && String(s.isin || '').toUpperCase() !== exactIsin) return false;
    if (filter === 'WATCHLIST') {
      if (!params.isins) return false;
      const isinSet = new Set(String(params.isins).split(',').map(i => i.trim().toUpperCase()).filter(Boolean));
      if (!isinSet.size || !isinSet.has(String(s.isin || '').toUpperCase())) return false;
    }
    if (!searchMatches(s, search)) return false;
    if (exchange && !(Array.isArray(s.exchanges) && s.exchanges.includes(exchange))) return false;
    if (filter === 'TOP GAINERS' && !(Number(s.change_percent) > 0 || (s.prev_close != null && Number(s.current_price) > Number(s.prev_close)))) return false;
    if (filter === 'TOP LOSERS' && !(Number(s.change_percent) < 0 || (s.prev_close != null && Number(s.current_price) < Number(s.prev_close)))) return false;
    if (filter === 'NEAR 52W HIGH' && !(s.is_near_high || (s.pct_from_high && Number(s.pct_from_high) >= -8))) return false;
    if (filter === 'HIGH VOLUME' && !(Number(s.volume_ratio) >= 1.8)) return false;
    if (params.sector) {
      const sec = String(params.sector).toLowerCase();
      if (String(s.sector || '').toLowerCase() !== sec) return false;
    }
    return true;
  });

  const useCategoryOrder = (filter === 'TOP GAINERS' || filter === 'TOP LOSERS') && String(params.sortOverride).toLowerCase() !== 'true';
  if (!useCategoryOrder) {
    results.sort((a, b) => {
      const x = a[sort], y = b[sort];
      if (x == null && y != null) return 1;
      if (x != null && y == null) return -1;
      if (x == null && y == null) return String(a.isin).localeCompare(String(b.isin));
      const cmp = typeof x === 'string' ? String(x).localeCompare(String(y), undefined, { sensitivity: 'base' }) : Number(x) - Number(y);
      return (cmp || String(a.isin).localeCompare(String(b.isin))) * direction;
    });
  } else {
    results.sort((a, b) => (Number(a.change_percent || 0) - Number(b.change_percent || 0) || String(a.isin).localeCompare(String(b.isin))) * (filter === 'TOP GAINERS' ? -1 : 1));
  }

  return {
    ok: true,
    stocks: results.slice(offset, offset + limit),
    offset,
    nextOffset: Math.min(offset + limit, results.length),
    limit,
    total: results.length,
    hasMore: offset + limit < results.length,
    stats,
    storageSource: dataset.storageSource || 'local_file',
    storageVersionId: dataset.storageVersionId || null
  };
}

function queryStocks(params = {}) {
  return executeStockQuery(loadDataset(), params);
}

async function queryStocksAsync(params = {}, options = {}) {
  const dataset = await loadDatasetAsync(options);
  return executeStockQuery(dataset, params);
}

async function getStockByIsinAsync(isin, options = {}) {
  const cleanIsin = String(isin || '').trim().toUpperCase();
  if (!cleanIsin) return null;
  const dataset = await loadDatasetAsync(options);
  const match = dataset.stocks.find(s => String(s.isin || '').toUpperCase() === cleanIsin);
  return match ? { stock: match, stats: dataset.stats, storageSource: dataset.storageSource } : null;
}

module.exports = {
  SECTOR_OVERRIDES,
  loadDataset,
  loadDatasetAsync,
  loadMarketStatsAsync,
  executeStockQuery,
  queryStocks,
  queryStocksAsync,
  getStockByIsinAsync,
  normalizeDataset,
  resetCacheForTests
};
