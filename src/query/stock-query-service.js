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
const path = require('path');
const {
  TARGET_DATA_PATH,
  DOWNLOADS_DIR,
  POINTER_CACHE_TTL_MS,
  SECTOR_OVERRIDES,
  MAX_HISTORICAL_SESSIONS,
  RETURN_WINDOW_1W_SESSIONS,
  RETURN_WINDOW_1M_SESSIONS,
  RETURN_WINDOW_3M_SESSIONS
} = require('../config/constants');
const defaultStorage = require('../storage/supabase-storage');
const { expandHistoricalPricesForIsin } = require('../storage/historical-store');
const { mapCatalogToCanonicalSector } = require('../enrichment/fundamentals');
const { computePeriodReturn } = require('../processing/universe-merger');

const DATA_PATH = TARGET_DATA_PATH;

let cachedLocal = null;
let cachedRemote = null; // { versionId, checkedAt, data, manifest, historicalDatasetMeta }
let cachedManifestOnly = null; // { checkedAt, stats, manifest, versionId }
let cachedHistoricalRemote = null; // { versionId, sha256, checkedAt, history, meta }
let cachedCatalogSectorMap = null;

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

function getLocalCatalogSectorMap() {
  if (cachedCatalogSectorMap !== null) return cachedCatalogSectorMap;
  const map = new Map();
  try {
    const catalogPath = path.join(DOWNLOADS_DIR, 'api-companies-catalog.json');
    if (fs.existsSync(catalogPath)) {
      const list = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      if (Array.isArray(list)) {
        for (const c of list) {
          if (!c.isin) continue;
          const mapped = mapCatalogToCanonicalSector(c.sector, c.industry);
          if (mapped || c.industry) {
            map.set(String(c.isin).trim().toUpperCase(), { sector: mapped, industry: c.industry || null });
          }
        }
      }
    }
  } catch (_) {}
  cachedCatalogSectorMap = map;
  return cachedCatalogSectorMap;
}

function isPlaceholderSectorVal(sector, industry) {
  const s = String(sector || '').trim().toUpperCase();
  if (!s || s === 'GENERAL' || s === 'UNCLASSIFIED' || s === 'N/A' || s === 'UNKNOWN') return true;
  if (String(industry || '').trim().toUpperCase() === 'SPECIALIZED SECTOR') return true;
  return false;
}

function normalizeDataset(stats, rawStocks) {
  const seen = new Set();
  const stocks = [];
  const catalogSectors = getLocalCatalogSectorMap();
  for (const raw of rawStocks || []) {
    const isin = String(raw.isin || '').trim().toUpperCase();
    if (!isin || seen.has(isin)) continue;
    seen.add(isin);
    const stock = { ...raw, isin };
    if (SECTOR_OVERRIDES[isin]) {
      stock.sector = SECTOR_OVERRIDES[isin].sector;
      stock.industry = SECTOR_OVERRIDES[isin].industry;
    } else if (isPlaceholderSectorVal(stock.sector, stock.industry)) {
      const catMeta = catalogSectors.get(isin);
      stock.sector = catMeta?.sector || 'Unclassified';
      if ((!stock.industry || isPlaceholderSectorVal('x', stock.industry) || String(stock.industry).toUpperCase() === 'DIVERSIFIED') && catMeta?.industry) {
        stock.industry = catMeta.industry;
      }
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
        storageVersionId: cachedRemote.versionId,
        historicalDatasetMeta: cachedRemote.historicalDatasetMeta || null
      };
    }

    try {
      const remote = await storage.fetchLatestDataset({
        knownVersionId: options.force ? null : cachedRemote?.versionId
      });

      if (remote.ok && remote.unchanged && cachedRemote) {
        cachedRemote.checkedAt = now;
        if (remote.manifest) {
          cachedRemote.manifest = remote.manifest;
          cachedRemote.historicalDatasetMeta = remote.manifest.historicalDataset || remote.manifest.stats?.historicalDataset || cachedRemote.historicalDatasetMeta || null;
        }
        return {
          ...cachedRemote.data,
          storageSource: 'supabase_storage',
          storageVersionId: cachedRemote.versionId,
          historicalDatasetMeta: cachedRemote.historicalDatasetMeta || null
        };
      }

      if (remote.ok && remote.stats && Array.isArray(remote.stocks)) {
        const normalized = normalizeDataset(remote.stats, remote.stocks);
        const versionId = remote.manifest?.versionId || remote.stats.storageVersionId || remote.stats.refreshedAtUtc;
        const histMeta = remote.historicalDatasetMeta || remote.manifest?.historicalDataset || remote.stats?.historicalDataset || null;
        cachedRemote = {
          versionId,
          checkedAt: now,
          manifest: remote.manifest,
          data: normalized,
          historicalDatasetMeta: histMeta
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
          storageVersionId: versionId,
          historicalDatasetMeta: histMeta
        };
      }
    } catch (_) {}

    if (cachedRemote?.data) {
      return {
        ...cachedRemote.data,
        storageSource: 'supabase_storage_cached',
        storageVersionId: cachedRemote.versionId,
        historicalDatasetMeta: cachedRemote.historicalDatasetMeta || null
      };
    }

    const localData = loadDataset(dataPath);
    return {
      ...localData,
      storageSource: 'local_fallback',
      storageVersionId: localData.stats?.storageVersionId || null,
      historicalDatasetMeta: localData.stats?.historicalDataset || null
    };
  }

  const localData = loadDataset(dataPath);
  return {
    ...localData,
    storageSource: 'local_file',
    storageVersionId: localData.stats?.storageVersionId || null,
    historicalDatasetMeta: localData.stats?.historicalDataset || null
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
  cachedHistoricalRemote = null;
  cachedCatalogSectorMap = null;
}

function deriveReturnsFromHistory(stock, sessions, prices) {
  const safePrices = Array.isArray(prices) ? prices : [];
  if (safePrices.length < 2) {
    return {
      return_1w: stock?.return_1w ?? null,
      return_1m: stock?.return_1m ?? null,
      return_3m: stock?.return_3m ?? null
    };
  }
  const histObj = {};
  for (const entry of safePrices) {
    if (entry && typeof entry.date === 'string' && Number.isFinite(Number(entry.close)) && Number(entry.close) > 0) {
      histObj[entry.date] = Number(entry.close);
    }
  }
  const validDates = Object.keys(histObj).sort();
  if (validDates.length < 2) {
    return {
      return_1w: stock?.return_1w ?? null,
      return_1m: stock?.return_1m ?? null,
      return_3m: stock?.return_3m ?? null
    };
  }
  const historicalDates = Array.isArray(sessions) && sessions.length >= validDates.length ? sessions : validDates;
  const populatedDateSet = new Set(historicalDates);
  const currentPrice = stock?.current_price != null ? Number(stock.current_price) : null;

  const ret1w = stock?.return_1w != null
    ? stock.return_1w
    : computePeriodReturn({
      validDates,
      histObj,
      currentPrice,
      historicalDates,
      populatedDateSet,
      targetSessions: RETURN_WINDOW_1W_SESSIONS,
      maxStartLag: 0,
      requireFullDatasetWindow: false
    }).value;

  const ret1m = stock?.return_1m != null
    ? stock.return_1m
    : computePeriodReturn({
      validDates,
      histObj,
      currentPrice,
      historicalDates,
      populatedDateSet,
      targetSessions: RETURN_WINDOW_1M_SESSIONS,
      maxStartLag: 2,
      requireFullDatasetWindow: true
    }).value;

  const ret3m = stock?.return_3m != null
    ? stock.return_3m
    : computePeriodReturn({
      validDates,
      histObj,
      currentPrice,
      historicalDates,
      populatedDateSet,
      targetSessions: RETURN_WINDOW_3M_SESSIONS,
      maxStartLag: 4,
      requireFullDatasetWindow: true
    }).value;

  return {
    return_1w: ret1w ?? null,
    return_1m: ret1m ?? null,
    return_3m: ret3m ?? null
  };
}

async function loadHistoricalDatasetAsync(metaOrManifest = null, options = {}) {
  const storage = options.storageClient || defaultStorage;
  if (!storage || typeof storage.isReadConfigured !== 'function' || !storage.isReadConfigured()) {
    return { ok: false, notConfigured: true, history: null, meta: null, storageSource: 'local_file' };
  }

  let meta = metaOrManifest?.datasetPath
    ? metaOrManifest
    : (metaOrManifest?.historicalDataset || null);

  if (!meta) {
    const manifestState = await loadMarketStatsAsync(options);
    meta = manifestState.manifest?.historicalDataset || manifestState.stats?.historicalDataset || null;
  }

  if (!meta || !meta.datasetPath || typeof storage.fetchHistoricalDataset !== 'function') {
    return { ok: false, notFound: true, history: null, meta: null, storageSource: 'supabase_storage' };
  }

  const now = Date.now();
  if (
    !options.force &&
    cachedHistoricalRemote &&
    cachedHistoricalRemote.versionId === meta.versionId &&
    (!meta.sha256 || cachedHistoricalRemote.sha256 === meta.sha256)
  ) {
    cachedHistoricalRemote.checkedAt = now;
    return {
      ok: true,
      history: cachedHistoricalRemote.history,
      meta: cachedHistoricalRemote.meta || meta,
      storageSource: 'supabase_storage',
      historyVersionId: cachedHistoricalRemote.versionId
    };
  }

  try {
    const res = await storage.fetchHistoricalDataset(meta, {
      knownVersionId: options.force ? null : cachedHistoricalRemote?.versionId
    });
    if (res.ok && res.unchanged && cachedHistoricalRemote) {
      cachedHistoricalRemote.checkedAt = now;
      return {
        ok: true,
        history: cachedHistoricalRemote.history,
        meta: cachedHistoricalRemote.meta || meta,
        storageSource: 'supabase_storage',
        historyVersionId: cachedHistoricalRemote.versionId
      };
    }
    if (res.ok && res.history) {
      const histVersionId = meta.versionId || res.history.versionId;
      cachedHistoricalRemote = {
        versionId: histVersionId,
        sha256: meta.sha256 || null,
        checkedAt: now,
        history: res.history,
        meta
      };
      return {
        ok: true,
        history: res.history,
        meta,
        storageSource: 'supabase_storage',
        historyVersionId: histVersionId
      };
    }
  } catch (_) {}

  if (cachedHistoricalRemote?.history) {
    return {
      ok: true,
      history: cachedHistoricalRemote.history,
      meta: cachedHistoricalRemote.meta || meta,
      storageSource: 'supabase_storage_cached',
      historyVersionId: cachedHistoricalRemote.versionId
    };
  }

  return { ok: false, history: null, meta, storageSource: 'local_fallback' };
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
  const result = executeStockQuery(dataset, params);
  const includeHistory = Boolean(
    (params.isin && String(params.isin).trim()) ||
    String(params.includeHistory || '').toLowerCase() === 'true' ||
    params.includeHistory === '1'
  );

  if (
    includeHistory &&
    result.stocks.length > 0 &&
    result.stocks.some(s => !Array.isArray(s.historical_prices)) &&
    dataset.historicalDatasetMeta?.datasetPath
  ) {
    try {
      const histRes = await loadHistoricalDatasetAsync(dataset.historicalDatasetMeta, options);
      if (histRes.ok && histRes.history) {
        const sess = histRes.history.sessions || dataset.stats?.historicalSessions?.sessions || [];
        result.stocks = result.stocks.map(s => {
          const histPrices = Array.isArray(s.historical_prices)
            ? s.historical_prices
            : expandHistoricalPricesForIsin(histRes.history, s.isin);
          const derived = deriveReturnsFromHistory(s, sess, histPrices);
          return {
            ...s,
            historical_prices: histPrices,
            ...derived
          };
        });
      }
    } catch (_) {}
  }

  return result;
}

async function getStockByIsinAsync(isin, options = {}) {
  const cleanIsin = String(isin || '').trim().toUpperCase();
  if (!cleanIsin) return null;
  const dataset = await loadDatasetAsync(options);
  let match = dataset.stocks.find(s => String(s.isin || '').toUpperCase() === cleanIsin);
  if (!match) return null;
  if (!Array.isArray(match.historical_prices) && dataset.historicalDatasetMeta?.datasetPath) {
    try {
      const histRes = await loadHistoricalDatasetAsync(dataset.historicalDatasetMeta, options);
      if (histRes.ok && histRes.history) {
        match = {
          ...match,
          historical_prices: expandHistoricalPricesForIsin(histRes.history, cleanIsin)
        };
      }
    } catch (_) {}
  }
  return { stock: match, stats: dataset.stats, storageSource: dataset.storageSource };
}

async function queryStockHistoryAsync(params = {}, options = {}) {
  const rawIsin = params.isin ? String(params.isin).trim().toUpperCase() : '';
  if (rawIsin && !/^[A-Z0-9]{12}$/.test(rawIsin)) {
    return { ok: false, statusCode: 400, error: 'A valid 12-character ISIN is required.' };
  }

  const dataset = await loadDatasetAsync(options);
  const histMeta = dataset.historicalDatasetMeta || dataset.stats?.historicalDataset || null;
  let histRes = { ok: false, history: null, meta: histMeta };
  if (histMeta?.datasetPath) {
    histRes = await loadHistoricalDatasetAsync(histMeta, options);
  }

  const historyObj = histRes.history || null;
  const sessions = historyObj?.sessions || dataset.stats?.historicalSessions?.sessions || [];
  const resolvedMeta = histRes.meta || histMeta || null;
  const historyVersionId = resolvedMeta?.versionId || historyObj?.versionId || null;

  if (!rawIsin) {
    return {
      ok: true,
      tradingDate: dataset.stats?.tradingDate || null,
      historyVersionId,
      historicalDataset: resolvedMeta,
      startDate: sessions[0] || resolvedMeta?.startDate || null,
      endDate: sessions[sessions.length - 1] || resolvedMeta?.endDate || null,
      sessionCount: sessions.length,
      maxSessions: historyObj?.maxSessions || resolvedMeta?.maxSessions || MAX_HISTORICAL_SESSIONS,
      sessions,
      storageSource: dataset.storageSource || 'local_file',
      storageVersionId: dataset.storageVersionId || null
    };
  }

  const stock = dataset.stocks.find(s => String(s.isin || '').toUpperCase() === rawIsin);
  if (!stock) {
    return { ok: false, statusCode: 404, error: `No equity found for ISIN ${rawIsin}.` };
  }

  const prices = Array.isArray(stock.historical_prices)
    ? stock.historical_prices
    : expandHistoricalPricesForIsin(historyObj, rawIsin);
  const derivedReturns = deriveReturnsFromHistory(stock, sessions, prices);

  return {
    ok: true,
    isin: rawIsin,
    symbol: stock.symbol,
    company_name: stock.company_name,
    tradingDate: dataset.stats?.tradingDate || stock.trading_date || null,
    historyVersionId,
    historicalDataset: resolvedMeta,
    startDate: prices?.[0]?.date || null,
    endDate: prices?.[prices.length - 1]?.date || null,
    sessionCount: Array.isArray(prices) ? prices.length : 0,
    maxSessions: historyObj?.maxSessions || resolvedMeta?.maxSessions || MAX_HISTORICAL_SESSIONS,
    historical_prices: prices || [],
    return_1w: derivedReturns.return_1w,
    return_1m: derivedReturns.return_1m,
    return_3m: derivedReturns.return_3m,
    storageSource: dataset.storageSource || 'local_file',
    storageVersionId: dataset.storageVersionId || null
  };
}

module.exports = {
  SECTOR_OVERRIDES,
  loadDataset,
  loadDatasetAsync,
  loadMarketStatsAsync,
  loadHistoricalDatasetAsync,
  executeStockQuery,
  queryStocks,
  queryStocksAsync,
  queryStockHistoryAsync,
  getStockByIsinAsync,
  normalizeDataset,
  resetCacheForTests
};
