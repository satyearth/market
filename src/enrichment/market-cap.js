'use strict';

/**
 * Multi-Source Market Capitalization Pipeline & Ranking Engine
 *
 * Resolution waterfall (strict ISIN-first priority, zero fabricated caps):
 *   0. Non-common equity exclusions (Rights Entitlements -RE, Partly-Paid PP, Preference CCPS -> strictly null)
 *   1. NSE Official Daily Market Cap Archive (`mcap<ddmmyyyy>.csv` from `PR<ddmmyy>.zip` by NSE Symbol+Series)
 *   2. Price * Verified Screener Share Count (split-checked)
 *   3. Benchmark verified blue-chip cache
 *   4. BSE official Security Master (by ISIN)
 *   5. India Listed Companies Catalog (`api.dharun.dev/v1/companies`) by ISIN
 *   6. Screener Indian Equities dataset by Symbol / NSE symbol / BSE scrip code
 *   7. India Listed Companies Catalog by Ticker
 *   8. Share Price * Total Outstanding Shares fallback (when verified share count exists)
 *   9. Previous session verified market cap carryover (zero regression)
 *
 * Supports automatic cold-runner hydration from Supabase Storage `reference/`
 * objects whenever local `downloads/*.json` files are absent.
 */

const fs = require('fs');
const path = require('path');
const { DOWNLOADS_DIR, REPORTS_DIR } = require('../config/constants');
const { fetchJsonWithRetry, defaultSleep } = require('../ingestion/http-client');
const { parseCSVContent } = require('../processing/csv-parser');
const { getNseMcapFilename } = require('../ingestion/bhavcopy-downloader');

const API_BASE_URL = 'https://api.dharun.dev/v1/companies';
const CATALOG_PATH = path.join(DOWNLOADS_DIR, 'api-companies-catalog.json');
const SCREENER_PATH = path.join(DOWNLOADS_DIR, 'screener_market_caps.json');
const BENCHMARK_PATH = path.join(DOWNLOADS_DIR, 'benchmark_stocks_verified.json');
const BSE_SECURITIES_PATH = path.join(DOWNLOADS_DIR, 'bse_list_securities_verified.json');

async function loadJsonWithReferenceFallback(filePath, refName, storageClient = null) {
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed != null) return { data: parsed, source: 'local' };
    } catch (_) {}
  }

  if (storageClient && typeof storageClient.isReadConfigured === 'function' && storageClient.isReadConfigured() &&
      typeof storageClient.downloadReferenceJson === 'function') {
    const res = await storageClient.downloadReferenceJson(refName);
    if (res.ok && res.data != null) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        const tmp = `${filePath}.tmp.${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(res.data), 'utf8');
        fs.renameSync(tmp, filePath);
      } catch (_) {}
      return { data: res.data, source: 'supabase_reference' };
    }
  }
  return { data: null, source: 'missing' };
}

async function fetchOrLoadApiCatalog(options = {}) {
  const {
    forceRefresh = false,
    pageSize = 100,
    maxPages = 100,
    catalogPath = CATALOG_PATH,
    storageClient = null,
    skipNetwork = false
  } = options;

  let cached = null;
  if (!forceRefresh) {
    const fallbackRes = await loadJsonWithReferenceFallback(catalogPath, 'api-companies-catalog.json', storageClient);
    if (Array.isArray(fallbackRes.data) && fallbackRes.data.length > 5000) {
      return { data: fallbackRes.data, source: fallbackRes.source === 'supabase_reference' ? 'supabase_reference' : 'cache', total: fallbackRes.data.length };
    }
    if (Array.isArray(fallbackRes.data) && fallbackRes.data.length > 0) {
      cached = fallbackRes.data;
    }
  }

  if (skipNetwork) {
    return { data: cached || [], source: cached ? 'cache_fallback' : 'empty', total: cached ? cached.length : 0 };
  }

  try {
    const firstPage = await fetchJsonWithRetry(`${API_BASE_URL}?limit=${pageSize}&offset=0`, { timeoutMs: 10000, maxAttempts: 3, baseDelayMs: 500 });
    const totalCount = firstPage?.meta?.total || 0;
    const allCompanies = [...(firstPage?.data || [])];

    if (totalCount > pageSize) {
      let offset = pageSize;
      let pagesFetched = 1;
      while (offset < totalCount && pagesFetched < maxPages) {
        const page = await fetchJsonWithRetry(`${API_BASE_URL}?limit=${pageSize}&offset=${offset}`, { timeoutMs: 10000, maxAttempts: 3, baseDelayMs: 800 });
        if (page?.data && Array.isArray(page.data)) {
          allCompanies.push(...page.data);
        } else {
          break;
        }
        offset += pageSize;
        pagesFetched++;
        await defaultSleep(60);
      }
    }

    if (allCompanies.length > 0) {
      fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
      const tmpCatalog = `${catalogPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpCatalog, JSON.stringify(allCompanies, null, 2), 'utf8');
      fs.renameSync(tmpCatalog, catalogPath);
      return { data: allCompanies, source: 'live_api', total: allCompanies.length };
    }
  } catch (_) {
    if (Array.isArray(cached) && cached.length > 0) {
      return { data: cached, source: 'cache_fallback', total: cached.length };
    }
  }

  return { data: cached || [], source: 'empty', total: cached ? cached.length : 0 };
}

const REFERENCE_SNAPSHOT_DATES = Object.freeze({
  BENCHMARK_VERIFIED: '2026-11-04',
  BSE_SECURITY_MASTER: '2026-11-04',
  SCREENER_DATASET: '2026-11-04',
  INDIA_API_ISIN: '2026-11-25',
  INDIA_API_TICKER: '2026-11-25'
});

function hasPostRefSplitDiscontinuity(pricesObjOrMap, refDate = '2026-11-04') {
  if (!pricesObjOrMap || typeof pricesObjOrMap !== 'object') return false;
  const rawEntries = typeof pricesObjOrMap.entries === 'function'
    ? [...pricesObjOrMap.entries()]
    : Object.entries(pricesObjOrMap);
  const entries = rawEntries
    .map(([dt, h]) => [dt, Number(typeof h === 'object' && h !== null ? h.close : h)])
    .filter(([dt, close]) => dt >= refDate && Number.isFinite(close) && close > 0)
    .sort((a, b) => a[0].localeCompare(b[0]));
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1][1];
    const curr = entries[i][1];
    if (prev > 0 && ((curr - prev) / prev) <= -0.35) {
      return true;
    }
  }
  return false;
}

function classifyEquityInstrumentType(stock) {
  const isin = String(stock?.isin || '').trim().toUpperCase();
  const sym = String(stock?.symbol || '').trim().toUpperCase();
  if (
    sym.includes('-RE') ||
    /-RE\d*$/i.test(sym) ||
    (isin.startsWith('INE') && isin.length === 12 && isin.slice(7, 9) === '20')
  ) {
    return 'RIGHTS_ENTITLEMENT';
  }
  if (isin.startsWith('IN9')) {
    if (isin.slice(7, 9) === '03' || /CCPS$/i.test(sym)) {
      return 'PREFERENCE_SHARES';
    }
    if (!/DVR/i.test(sym)) {
      return 'PARTLY_PAID';
    }
    return 'DVR_EQUITY';
  }
  return 'COMMON_EQUITY';
}

function loadNseOfficialMcapArchive(downloadsDir, targetDate) {
  const empty = { loaded: false, fileName: null, targetDate: targetDate || null, rowCount: 0, bySymbol: new Map(), bySymbolSeries: new Map() };
  if (!downloadsDir || !targetDate) return empty;
  const fileName = getNseMcapFilename(targetDate);
  const filePath = path.join(downloadsDir, fileName);
  if (!fs.existsSync(filePath)) return { ...empty, fileName };

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const rows = parseCSVContent(content);
    const bySymbol = new Map();
    const bySymbolSeries = new Map();
    let rowCount = 0;

    for (const row of rows) {
      const sym = String(row['Symbol'] || '').trim().toUpperCase();
      const series = String(row['Series'] || '').trim().toUpperCase();
      const category = String(row['Category'] || '').trim();
      if (!sym || !series || !category) continue;
      const mcapRs = parseFloat(String(row['Market Cap(Rs.)'] || '').replace(/,/g, '').trim());
      const issueSizeRaw = parseFloat(String(row['Issue Size'] || '').replace(/,/g, '').trim());
      if (!Number.isFinite(mcapRs) || mcapRs <= 0 || !Number.isFinite(issueSizeRaw) || issueSizeRaw <= 0) continue;
      const closeRaw = parseFloat(String(row['Close Price/Paid up value(Rs.)'] || '').replace(/,/g, '').trim());
      const entry = {
        symbol: sym,
        series,
        category,
        capCr: parseFloat((mcapRs / 1e7).toFixed(2)),
        issueSize: Number.isFinite(issueSizeRaw) && issueSizeRaw > 0 ? Math.round(issueSizeRaw) : null,
        closePrice: Number.isFinite(closeRaw) && closeRaw > 0 ? closeRaw : null,
        asOfDate: targetDate
      };
      bySymbol.set(sym, entry);
      if (series) {
        bySymbolSeries.set(`${sym}:${series}`, entry);
      }
      rowCount++;
    }

    return { loaded: rowCount > 0, fileName, targetDate, rowCount, bySymbol, bySymbolSeries };
  } catch (_) {
    return { ...empty, fileName };
  }
}

async function loadMarketCapSources(options = {}) {
  const downloadsDir = options.downloadsDir || DOWNLOADS_DIR;
  const storageClient = options.storageClient || null;
  const targetDate = options.targetDate || null;

  const sources = {
    sourceDates: { ...REFERENCE_SNAPSHOT_DATES },
    nseOfficialBySymbol: new Map(),
    nseOfficialBySymbolSeries: new Map(),
    nseOfficialMeta: { loaded: false, fileName: null, targetDate, rowCount: 0 },
    benchmarkBySymbol: new Map(),
    benchmarkMetaByIsin: new Map(),
    benchmarkMetaBySymbol: new Map(),
    bseSecByIsin: new Map(),
    catalogByIsin: new Map(),
    catalogByTicker: new Map(),
    catalogMetaByIsin: new Map(),
    catalogMetaByTicker: new Map(),
    screenerBySlug: new Map(),
    screenerMetaBySlug: new Map()
  };

  const nseOfficial = loadNseOfficialMcapArchive(downloadsDir, targetDate);
  if (nseOfficial.loaded) {
    sources.nseOfficialBySymbol = nseOfficial.bySymbol;
    sources.nseOfficialBySymbolSeries = nseOfficial.bySymbolSeries;
    sources.nseOfficialMeta = {
      loaded: true,
      fileName: nseOfficial.fileName,
      targetDate: nseOfficial.targetDate,
      rowCount: nseOfficial.rowCount
    };
    sources.sourceDates.NSE_OFFICIAL_MCAP = targetDate;
  }

  const bmRes = await loadJsonWithReferenceFallback(
    path.join(downloadsDir, 'benchmark_stocks_verified.json'),
    'benchmark_stocks_verified.json',
    storageClient
  );
  if (Array.isArray(bmRes.data)) {
    for (const s of bmRes.data) {
      if (s.isin) {
        sources.benchmarkMetaByIsin.set(String(s.isin).trim().toUpperCase(), s);
      }
      if (s.symbol) {
        sources.benchmarkMetaBySymbol.set(String(s.symbol).trim().toUpperCase(), s);
      }
      if (s.symbol && s.market_cap_cr != null && s.market_cap_cr > 0) {
        sources.benchmarkBySymbol.set(String(s.symbol).toUpperCase(), s);
      }
    }
  }

  const bseRes = await loadJsonWithReferenceFallback(
    path.join(downloadsDir, 'bse_list_securities_verified.json'),
    'bse_list_securities_verified.json',
    storageClient
  );
  if (Array.isArray(bseRes.data)) {
    for (const item of bseRes.data) {
      if (!item.ISIN_NUMBER) continue;
      const isinKey = String(item.ISIN_NUMBER).trim().toUpperCase();
      const cap = item.Mktcap != null ? parseFloat(item.Mktcap) : NaN;
      const hasValidCap = !Number.isNaN(cap) && cap > 0;
      if (hasValidCap || item.INDUSTRY || item.SECTOR) {
        sources.bseSecByIsin.set(isinKey, {
          mktcap: hasValidCap ? cap : null,
          industry: item.INDUSTRY || null,
          sector: item.SECTOR || null
        });
      }
    }
  }

  const catalogResult = await fetchOrLoadApiCatalog({
    ...options,
    catalogPath: path.join(downloadsDir, 'api-companies-catalog.json')
  });
  if (Array.isArray(catalogResult.data)) {
    for (const c of catalogResult.data) {
      const isinKey = c.isin ? String(c.isin).trim().toUpperCase() : null;
      const tickerKey = c.ticker ? String(c.ticker).trim().toUpperCase() : null;
      const idKey = c.id && String(c.id).includes(':') ? String(c.id).trim().toUpperCase() : null;
      if (c.sector || c.industry || c.oneLine) {
        const meta = {
          isin: isinKey,
          ticker: tickerKey,
          company: c.company || null,
          sector: c.sector || null,
          industry: c.industry || null,
          oneLine: c.oneLine ? String(c.oneLine).trim() : null,
          updatedAt: c.updatedAt ? String(c.updatedAt).slice(0, 10) : REFERENCE_SNAPSHOT_DATES.INDIA_API_ISIN
        };
        if (isinKey) sources.catalogMetaByIsin.set(isinKey, meta);
        if (tickerKey) sources.catalogMetaByTicker.set(tickerKey, meta);
        if (idKey) sources.catalogMetaByTicker.set(idKey, meta);
      }
      if (c.marketCap && c.marketCap > 0) {
        const capCr = parseFloat((c.marketCap / 1e7).toFixed(2));
        const asOf = c.updatedAt ? String(c.updatedAt).slice(0, 10) : REFERENCE_SNAPSHOT_DATES.INDIA_API_ISIN;
        if (isinKey) sources.catalogByIsin.set(isinKey, { ...c, capCr, asOfDate: asOf });
        if (tickerKey) sources.catalogByTicker.set(tickerKey, { ...c, capCr, asOfDate: asOf });
        if (idKey) sources.catalogByTicker.set(idKey, { ...c, capCr, asOfDate: asOf });
      }
    }
  }

  const scrRes = await loadJsonWithReferenceFallback(
    path.join(downloadsDir, 'screener_market_caps.json'),
    'screener_market_caps.json',
    storageClient
  );
  if (Array.isArray(scrRes.data)) {
    for (const s of scrRes.data) {
      if (!s.slug) continue;
      const slugKey = String(s.slug).toUpperCase();
      sources.screenerMetaBySlug.set(slugKey, s);
      if (s.mcap != null && s.mcap > 0) {
        sources.screenerBySlug.set(slugKey, s);
      }
    }
  }

  return sources;
}

function getVerifiedScreenerEntry(stock, sources) {
  if (!sources?.screenerBySlug && !sources?.screenerMetaBySlug) return null;
  const sym = String(stock.symbol || '').toUpperCase();
  const nseSym = String(stock.nse_symbol || '').toUpperCase();
  const bseCode = String(stock.bse_scrip_code || '').toUpperCase();
  const map = sources.screenerMetaBySlug || sources.screenerBySlug;
  const entry = (sym && map.get(sym)) ||
    (nseSym && map.get(nseSym)) ||
    (bseCode && map.get(bseCode)) ||
    null;
  if (!entry) return null;

  const refClose = stock.screener_ref_close;
  if (refClose != null && Number(refClose) > 0 && entry.cmp != null && Number(entry.cmp) > 0) {
    const ratio = Number(refClose) / Number(entry.cmp);
    if (ratio < 0.90 || ratio > 1.10) {
      return null;
    }
  }
  return entry;
}

function resolveStockMarketCap(stock, sources, prevStock = null) {
  const instrumentType = stock?.instrument_type || classifyEquityInstrumentType(stock);
  if (
    instrumentType === 'RIGHTS_ENTITLEMENT' ||
    instrumentType === 'PARTLY_PAID' ||
    instrumentType === 'PREFERENCE_SHARES'
  ) {
    return {
      market_cap_cr: null,
      market_cap_source: null,
      market_cap_as_of_date: null,
      total_outstanding_shares: null
    };
  }

  const isin = String(stock.isin || '').toUpperCase();
  const sym = String(stock.symbol || '').toUpperCase();
  const nseSym = String(stock.nse_symbol || '').toUpperCase();
  const bseCode = String(stock.bse_scrip_code || '').toUpperCase();
  const series = String(stock.series || '').trim().toUpperCase();
  const isNseListed = Array.isArray(stock.exchanges)
    ? stock.exchanges.includes('NSE')
    : Boolean(nseSym);
  const livePrice = stock.current_price != null ? Number(stock.current_price) : Number(stock.close_price);
  const hasLivePrice = Number.isFinite(livePrice) && livePrice > 0;
  const sourceDates = sources?.sourceDates || REFERENCE_SNAPSHOT_DATES;

  let resolvedCap = null;
  let source = null;
  let asOfDate = null;
  let totalOutstandingShares = Number.isFinite(Number(stock.total_outstanding_shares)) && Number(stock.total_outstanding_shares) > 0
    ? Number(stock.total_outstanding_shares)
    : null;

  // Priority 1: NSE Official Daily Market Cap Archive (`mcap<ddmmyyyy>.csv`)
  if (isNseListed && nseSym && (sources?.nseOfficialBySymbolSeries?.size || sources?.nseOfficialBySymbol?.size)) {
    const official = (series && sources.nseOfficialBySymbolSeries?.get(`${nseSym}:${series}`)) ||
      sources.nseOfficialBySymbol?.get(nseSym) ||
      null;
    if (official && official.capCr != null && official.capCr > 0) {
      resolvedCap = official.capCr;
      source = 'NSE_OFFICIAL_MCAP';
      asOfDate = official.asOfDate || sourceDates.NSE_OFFICIAL_MCAP || stock.trading_date || null;
      if (official.issueSize != null && official.issueSize > 0) {
        totalOutstandingShares = official.issueSize;
      }
    }
  }

  // Priority 2: Compute split-safe verified share count from Screener (2026-11-04) + live EOD close when safe
  const verifiedScr = getVerifiedScreenerEntry(stock, sources);
  let scaledFromScreener = false;
  if (
    resolvedCap == null &&
    verifiedScr &&
    verifiedScr.cmp != null && Number(verifiedScr.cmp) > 0 &&
    verifiedScr.mcap != null && Number(verifiedScr.mcap) > 0 &&
    !stock.has_split_after_ref &&
    (stock.screener_ref_close != null || sources.benchmarkBySymbol?.has(sym))
  ) {
    const impliedShares = Math.round((Number(verifiedScr.mcap) * 1e7) / Number(verifiedScr.cmp));
    if (impliedShares > 0 && hasLivePrice) {
      const liveRatio = livePrice / Number(verifiedScr.cmp);
      if (liveRatio >= 0.45 && liveRatio <= 2.25) {
        totalOutstandingShares = totalOutstandingShares || impliedShares;
        resolvedCap = parseFloat(((livePrice * totalOutstandingShares) / 1e7).toFixed(2));
        source = 'CALCULATED_OUTSTANDING_SHARES';
        asOfDate = stock.trading_date || prevStock?.trading_date || null;
        scaledFromScreener = true;
      }
    }
  }

  if (resolvedCap == null && sources.benchmarkBySymbol.has(sym)) {
    const bm = sources.benchmarkBySymbol.get(sym);
    if (bm.market_cap_cr != null && bm.market_cap_cr > 0) {
      resolvedCap = bm.market_cap_cr;
      source = 'BENCHMARK_VERIFIED';
      asOfDate = sourceDates.BENCHMARK_VERIFIED || REFERENCE_SNAPSHOT_DATES.BENCHMARK_VERIFIED;
    }
  }

  if (resolvedCap == null && sources.bseSecByIsin.has(isin)) {
    const bse = sources.bseSecByIsin.get(isin);
    if (bse.mktcap != null && bse.mktcap > 0) {
      resolvedCap = bse.mktcap;
      source = 'BSE_SECURITY_MASTER';
      asOfDate = sourceDates.BSE_SECURITY_MASTER || REFERENCE_SNAPSHOT_DATES.BSE_SECURITY_MASTER;
    }
  }

  if (resolvedCap == null && sources.catalogByIsin.has(isin)) {
    const cat = sources.catalogByIsin.get(isin);
    if (cat.capCr != null && cat.capCr > 0) {
      resolvedCap = cat.capCr;
      source = 'INDIA_API_ISIN';
      asOfDate = cat.asOfDate || sourceDates.INDIA_API_ISIN || REFERENCE_SNAPSHOT_DATES.INDIA_API_ISIN;
    }
  }

  if (resolvedCap == null && !scaledFromScreener && verifiedScr && verifiedScr.mcap != null && verifiedScr.mcap > 0) {
    resolvedCap = verifiedScr.mcap;
    source = 'SCREENER_DATASET';
    asOfDate = sourceDates.SCREENER_DATASET || REFERENCE_SNAPSHOT_DATES.SCREENER_DATASET;
  }

  if (resolvedCap == null && (sources.catalogByTicker.has(sym) || (nseSym && sources.catalogByTicker.has(nseSym)))) {
    const cat = sources.catalogByTicker.get(sym) || sources.catalogByTicker.get(nseSym);
    const catIsin = cat?.isin ? String(cat.isin).trim().toUpperCase() : null;
    if (cat && cat.capCr != null && cat.capCr > 0 && (!catIsin || !isin || catIsin === isin)) {
      resolvedCap = cat.capCr;
      source = 'INDIA_API_TICKER';
      asOfDate = cat.asOfDate || sourceDates.INDIA_API_TICKER || REFERENCE_SNAPSHOT_DATES.INDIA_API_TICKER;
    }
  }

  if (resolvedCap == null) {
    const shares = totalOutstandingShares || (prevStock && prevStock.total_outstanding_shares);
    if (hasLivePrice && shares != null && !Number.isNaN(shares) && shares > 0) {
      totalOutstandingShares = Number(shares);
      resolvedCap = parseFloat(((livePrice * totalOutstandingShares) / 1e7).toFixed(2));
      source = 'CALCULATED_OUTSTANDING_SHARES';
      asOfDate = stock.trading_date || prevStock?.trading_date || null;
    }
  }

  if (resolvedCap == null && prevStock && prevStock.market_cap_cr != null && prevStock.market_cap_cr > 0 && prevStock.market_cap_source !== 'INDIA_API_TICKER') {
    resolvedCap = prevStock.market_cap_cr;
    source = prevStock.market_cap_source || 'PREVIOUS_SESSION_VERIFIED';
    asOfDate = prevStock.market_cap_as_of_date || prevStock.trading_date || null;
  }

  if (resolvedCap == null || Number.isNaN(resolvedCap) || resolvedCap <= 0) {
    return {
      market_cap_cr: null,
      market_cap_source: null,
      market_cap_as_of_date: null,
      total_outstanding_shares: totalOutstandingShares
    };
  }

  return {
    market_cap_cr: parseFloat(Number(resolvedCap).toFixed(2)),
    market_cap_source: source,
    market_cap_as_of_date: asOfDate,
    total_outstanding_shares: totalOutstandingShares
  };
}

function rankStocksAndCategorize(stocks) {
  stocks.sort((a, b) => {
    if (a.market_cap_cr != null && b.market_cap_cr != null) {
      return b.market_cap_cr - a.market_cap_cr;
    }
    if (a.market_cap_cr != null) return -1;
    if (b.market_cap_cr != null) return 1;
    return String(a.symbol || '').localeCompare(String(b.symbol || ''));
  });

  let currentRank = 1;
  let totalVerifiedCap = 0;
  let verifiedCapCount = 0;

  let top100Count = 0;
  let rank101_250Count = 0;
  let remainingVerifiedCount = 0;
  let smeCount = 0;
  let unrankedCount = 0;

  let rightsEntitlementCount = 0;
  let partlyPaidCount = 0;
  let preferenceShareCount = 0;
  let dvrEquityCount = 0;
  let commonEquityCount = 0;
  let eligibleEquityVerifiedCount = 0;

  for (const s of stocks) {
    const instType = s.instrument_type || classifyEquityInstrumentType(s);
    const isExcludedInstrument =
      instType === 'RIGHTS_ENTITLEMENT' ||
      instType === 'PARTLY_PAID' ||
      instType === 'PREFERENCE_SHARES';

    if (instType === 'RIGHTS_ENTITLEMENT') rightsEntitlementCount++;
    else if (instType === 'PARTLY_PAID') partlyPaidCount++;
    else if (instType === 'PREFERENCE_SHARES') preferenceShareCount++;
    else if (instType === 'DVR_EQUITY') dvrEquityCount++;
    else commonEquityCount++;

    if (!isExcludedInstrument && s.market_cap_cr != null) {
      eligibleEquityVerifiedCount++;
    }

    if (s.market_cap_cr != null) {
      totalVerifiedCap += s.market_cap_cr;
      verifiedCapCount++;

      if (s.segment === 'SME') {
        s.rank = null;
        s.verified_rank_tier = 'SME Platform';
        smeCount++;
      } else {
        s.rank = currentRank++;
        if (s.rank <= 100) {
          s.verified_rank_tier = 'Top 100 Verified';
          top100Count++;
        } else if (s.rank <= 250) {
          s.verified_rank_tier = 'Rank 101–250 Verified';
          rank101_250Count++;
        } else {
          s.verified_rank_tier = 'Remaining Verified';
          remainingVerifiedCount++;
        }
      }
    } else {
      s.rank = null;
      if (s.segment === 'SME') {
        s.verified_rank_tier = 'SME Platform';
        smeCount++;
      } else {
        s.verified_rank_tier = 'Unranked (Unverified Market Cap)';
        unrankedCount++;
      }
    }
  }

  const coveragePct = stocks.length > 0
    ? parseFloat(((verifiedCapCount / stocks.length) * 100).toFixed(2))
    : 0;
  const excludedNonCommonCount = rightsEntitlementCount + partlyPaidCount + preferenceShareCount;
  const eligibleEquityCount = stocks.length - excludedNonCommonCount;
  const commonEquityCoveragePct = eligibleEquityCount > 0
    ? parseFloat(((eligibleEquityVerifiedCount / eligibleEquityCount) * 100).toFixed(2))
    : 0;

  return {
    rankedStocks: stocks,
    totalVerifiedCap: Math.round(totalVerifiedCap),
    verifiedCapCount,
    coveragePct,
    commonEquityCoverage: {
      totalInstruments: stocks.length,
      eligibleEquityCount,
      excludedNonCommonCount,
      verifiedCount: eligibleEquityVerifiedCount,
      coveragePct: commonEquityCoveragePct,
      exclusions: {
        rightsEntitlements: rightsEntitlementCount,
        partlyPaid: partlyPaidCount,
        preferenceShares: preferenceShareCount
      },
      dvrEquityCount,
      commonEquityCount
    },
    segments: {
      top100: top100Count,
      rank101_250: rank101_250Count,
      remainingVerified: remainingVerifiedCount,
      smePlatform: smeCount,
      unranked: unrankedCount
    }
  };
}

function generateCoverageReport(summaryData, options = {}) {
  const reportsDir = options.reportsDir || REPORTS_DIR;
  const {
    tradingDate,
    totalEligible,
    nseCount,
    bseCount,
    dualCount,
    verifiedCount,
    missingCount,
    coveragePct,
    totalVerifiedCapCr,
    sourcesBreakdown,
    missingList,
    segments,
    commonEquityCoverage
  } = summaryData;

  const nowIst = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'medium'
  }).format(new Date());

  const commonCoverageRow = commonEquityCoverage
    ? `| **Eligible Share-Capital Equities (Excl. RE/PP/CCPS)** | **${commonEquityCoverage.verifiedCount.toLocaleString('en-IN')} / ${commonEquityCoverage.eligibleEquityCount.toLocaleString('en-IN')}** | **${commonEquityCoverage.coveragePct}%** | Company Share-Class Denominator (${commonEquityCoverage.excludedNonCommonCount} non-common excluded) |\n`
    : '';

  const md = `# Machii Bazzar — Market Capitalization Coverage & Synchronization Report

**Report Generated:** ${nowIst}  
**Exchange Session Date:** ${tradingDate || 'N/A'}  
**Primary Identifier:** International Securities Identification Number (ISIN)

---

## 1. Executive Summary

| Metric | Count / Value | % of Total Universe | Status |
| :--- | :--- | :--- | :--- |
| **Total Eligible Instruments** | **${totalEligible.toLocaleString('en-IN')}** | 100.0% | Complete EOD Universe |
| **Total NSE Listed Equities** | **${nseCount.toLocaleString('en-IN')}** | ${((nseCount / totalEligible) * 100).toFixed(1)}% | Verified |
| **Total BSE Listed Equities** | **${bseCount.toLocaleString('en-IN')}** | ${((bseCount / totalEligible) * 100).toFixed(1)}% | Verified |
| **Dual-Listed Equities** | **${dualCount.toLocaleString('en-IN')}** | ${((dualCount / totalEligible) * 100).toFixed(1)}% | ISIN-Deduplicated |
| **Instruments with Verified Market Cap** | **${verifiedCount.toLocaleString('en-IN')}** | **${coveragePct}%** | Verified Instrument Coverage |
${commonCoverageRow}| **Instruments with Missing Market Cap** | **${missingCount.toLocaleString('en-IN')}** | **${(100 - coveragePct).toFixed(2)}%** | Documented & Unpriced / Non-Common |
| **Aggregate Verified Market Cap** | **₹${totalVerifiedCapCr.toLocaleString('en-IN')} Cr** | — | Real EOD Capitalization |

---

## 2. Multi-Source Ingestion Breakdown

| Source Priority | Source Description | Securities Resolved | Quality / Verification Level |
| :---: | :--- | :---: | :--- |
| **Priority 1** | NSE Official Daily Market Cap Archive (\`mcap*.csv\`) | ${sourcesBreakdown.NSE_OFFICIAL_MCAP || 0} | Exchange-reported EOD Market Cap & Issue Size |
| **Priority 2** | Price × Verified Outstanding Shares | ${sourcesBreakdown.CALCULATED_OUTSTANDING_SHARES || 0} | Calculated from verified share counts |
| **Priority 3** | Benchmark Blue-Chip Cache (\`benchmark_stocks_verified.json\`) | ${sourcesBreakdown.BENCHMARK_VERIFIED || 0} | Verified benchmark equities |
| **Priority 4** | BSE Security Master (\`bse_list_securities_verified.json\`) | ${sourcesBreakdown.BSE_SECURITY_MASTER || 0} | Exchange equity master |
| **Priority 5** | India Listed Company Catalog (\`api.dharun.dev/v1/companies\` via ISIN) | ${sourcesBreakdown.INDIA_API_ISIN || 0} | ISIN-matched market capitalization |
| **Priority 6** | Indian Equities Dataset (\`screener_market_caps.json\`) | ${sourcesBreakdown.SCREENER_DATASET || 0} | Symbol/scrip-matched capitalization |
| **Priority 7** | India Listed Company Catalog (Ticker match fallback) | ${sourcesBreakdown.INDIA_API_TICKER || 0} | Ticker lookup fallback |
| **Priority 8** | Stale-While-Revalidate Session Cache | ${sourcesBreakdown.PREVIOUS_SESSION_VERIFIED || 0} | Zero-regression carryover |
| **Total Verified** | **All Institutional Sources** | **${verifiedCount.toLocaleString('en-IN')}** | **${coveragePct}% Coverage** |

---

## 3. Verified Ranking Segments Distribution

| Segment Key | Ranking Tier Label | Equities Count | Description |
| :--- | :--- | :---: | :--- |
| \`top100\` | **Top 100 Verified** | ${segments.top100} | Top 100 market-cap mainboard equities |
| \`rank101_250\` | **Rank 101–250 Verified** | ${segments.rank101_250} | Next 150 large/mid mainboard equities |
| \`remainingVerified\` | **Remaining Verified** | ${segments.remainingVerified.toLocaleString('en-IN')} | Remaining verified mainboard equities |
| \`smePlatform\` | **SME Platform** | ${segments.smePlatform.toLocaleString('en-IN')} | NSE Emerge & BSE SME equities |
| \`unranked\` | **Unranked / Unverified** | ${segments.unranked} | Unpriced, partly paid, or dormant equities |
| **Mathematical Sum** | **Complete Stock Universe** | **${(segments.top100 + segments.rank101_250 + segments.remainingVerified + segments.smePlatform + segments.unranked).toLocaleString('en-IN')}** | **Equals ${totalEligible.toLocaleString('en-IN')}** |

---

## 4. Companies with Missing Market Cap & Financial Reasons

A total of **${missingCount}** securities out of ${totalEligible.toLocaleString('en-IN')} (${(100 - coveragePct).toFixed(2)}%) remain \`null\`:

| Symbol | Company Name | ISIN | Exchange | Segment | Reason |
| :--- | :--- | :--- | :---: | :---: | :--- |
${missingList.map(s => `| **${s.symbol}** | ${s.company_name} | \`${s.isin}\` | ${Array.isArray(s.exchanges) ? s.exchanges.join(', ') : s.exchanges} | ${s.segment} | ${s.reason} |`).join('\n')}
`;

  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, 'MARKET_CAP_COVERAGE_REPORT.md');
  fs.writeFileSync(reportPath, md, 'utf8');
  return reportPath;
}

module.exports = {
  API_BASE_URL,
  CATALOG_PATH,
  SCREENER_PATH,
  BENCHMARK_PATH,
  BSE_SECURITIES_PATH,
  REFERENCE_SNAPSHOT_DATES,
  hasPostRefSplitDiscontinuity,
  getVerifiedScreenerEntry,
  loadJsonWithReferenceFallback,
  fetchOrLoadApiCatalog,
  loadNseOfficialMcapArchive,
  loadMarketCapSources,
  classifyEquityInstrumentType,
  resolveStockMarketCap,
  rankStocksAndCategorize,
  generateCoverageReport,
  fetchJsonWithRetry
};
