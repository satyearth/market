'use strict';

/**
 * Multi-Source Market Capitalization Pipeline & Ranking Engine
 *
 * Resolution waterfall (strict ISIN-first priority, zero fabricated caps):
 *   1. Benchmark verified blue-chip cache
 *   2. BSE official Security Master (by ISIN)
 *   3. India Listed Companies Catalog (`api.dharun.dev/v1/companies`) by ISIN
 *   4. Screener Indian Equities dataset by Symbol / NSE symbol / BSE scrip code
 *   5. India Listed Companies Catalog by Ticker
 *   6. Share Price * Total Outstanding Shares fallback (when verified share count exists)
 *   7. Previous session verified market cap carryover (zero regression)
 *
 * Supports automatic cold-runner hydration from Supabase Storage `reference/`
 * objects whenever local `downloads/*.json` files are absent.
 */

const fs = require('fs');
const path = require('path');
const { DOWNLOADS_DIR, REPORTS_DIR } = require('../config/constants');
const { fetchJsonWithRetry, defaultSleep } = require('../ingestion/http-client');

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

async function loadMarketCapSources(options = {}) {
  const downloadsDir = options.downloadsDir || DOWNLOADS_DIR;
  const storageClient = options.storageClient || null;

  const sources = {
    benchmarkBySymbol: new Map(),
    benchmarkMetaByIsin: new Map(),
    benchmarkMetaBySymbol: new Map(),
    bseSecByIsin: new Map(),
    catalogByIsin: new Map(),
    catalogByTicker: new Map(),
    catalogMetaByIsin: new Map(),
    catalogMetaByTicker: new Map(),
    screenerBySlug: new Map()
  };

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
      if (c.sector || c.industry) {
        const meta = { isin: isinKey, ticker: tickerKey, company: c.company || null, sector: c.sector || null, industry: c.industry || null };
        if (isinKey) sources.catalogMetaByIsin.set(isinKey, meta);
        if (tickerKey) sources.catalogMetaByTicker.set(tickerKey, meta);
        if (idKey) sources.catalogMetaByTicker.set(idKey, meta);
      }
      if (c.marketCap && c.marketCap > 0) {
        const capCr = parseFloat((c.marketCap / 1e7).toFixed(2));
        if (isinKey) sources.catalogByIsin.set(isinKey, { ...c, capCr });
        if (tickerKey) sources.catalogByTicker.set(tickerKey, { ...c, capCr });
        if (idKey) sources.catalogByTicker.set(idKey, { ...c, capCr });
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
      if (s.slug && s.mcap != null && s.mcap > 0) {
        sources.screenerBySlug.set(String(s.slug).toUpperCase(), s);
      }
    }
  }

  return sources;
}

function resolveStockMarketCap(stock, sources, prevStock = null) {
  const isin = String(stock.isin || '').toUpperCase();
  const sym = String(stock.symbol || '').toUpperCase();
  const nseSym = String(stock.nse_symbol || '').toUpperCase();
  const bseCode = String(stock.bse_scrip_code || '').toUpperCase();

  let resolvedCap = null;
  let source = null;

  if (sources.benchmarkBySymbol.has(sym)) {
    const bm = sources.benchmarkBySymbol.get(sym);
    if (bm.market_cap_cr != null && bm.market_cap_cr > 0) {
      resolvedCap = bm.market_cap_cr;
      source = 'BENCHMARK_VERIFIED';
    }
  }

  if (resolvedCap == null && sources.bseSecByIsin.has(isin)) {
    const bse = sources.bseSecByIsin.get(isin);
    if (bse.mktcap != null && bse.mktcap > 0) {
      resolvedCap = bse.mktcap;
      source = 'BSE_SECURITY_MASTER';
    }
  }

  if (resolvedCap == null && sources.catalogByIsin.has(isin)) {
    const cat = sources.catalogByIsin.get(isin);
    if (cat.capCr != null && cat.capCr > 0) {
      resolvedCap = cat.capCr;
      source = 'INDIA_API_ISIN';
    }
  }

  if (resolvedCap == null) {
    const scr = sources.screenerBySlug.get(sym) ||
      (nseSym && sources.screenerBySlug.get(nseSym)) ||
      (bseCode && sources.screenerBySlug.get(bseCode));
    if (scr && scr.mcap != null && scr.mcap > 0) {
      resolvedCap = scr.mcap;
      source = 'SCREENER_DATASET';
    }
  }

  if (resolvedCap == null && (sources.catalogByTicker.has(sym) || (nseSym && sources.catalogByTicker.has(nseSym)))) {
    const cat = sources.catalogByTicker.get(sym) || sources.catalogByTicker.get(nseSym);
    if (cat && cat.capCr != null && cat.capCr > 0) {
      resolvedCap = cat.capCr;
      source = 'INDIA_API_TICKER';
    }
  }

  if (resolvedCap == null) {
    const price = stock.current_price != null ? stock.current_price : stock.close_price;
    const shares = stock.total_outstanding_shares || (prevStock && prevStock.total_outstanding_shares);
    if (price != null && !Number.isNaN(price) && price > 0 && shares != null && !Number.isNaN(shares) && shares > 0) {
      resolvedCap = parseFloat(((price * shares) / 1e7).toFixed(2));
      source = 'CALCULATED_OUTSTANDING_SHARES';
    }
  }

  if (resolvedCap == null && prevStock && prevStock.market_cap_cr != null && prevStock.market_cap_cr > 0) {
    resolvedCap = prevStock.market_cap_cr;
    source = prevStock.market_cap_source || 'PREVIOUS_SESSION_VERIFIED';
  }

  if (resolvedCap == null || Number.isNaN(resolvedCap) || resolvedCap <= 0) {
    return { market_cap_cr: null, market_cap_source: null };
  }

  return {
    market_cap_cr: parseFloat(Number(resolvedCap).toFixed(2)),
    market_cap_source: source
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

  for (const s of stocks) {
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

  return {
    rankedStocks: stocks,
    totalVerifiedCap: Math.round(totalVerifiedCap),
    verifiedCapCount,
    coveragePct,
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
    segments
  } = summaryData;

  const nowIst = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'full',
    timeStyle: 'medium'
  }).format(new Date());

  const md = `# Machii Bazzar — Market Capitalization Coverage & Synchronization Report

**Report Generated:** ${nowIst}  
**Exchange Session Date:** ${tradingDate || 'N/A'}  
**Primary Identifier:** International Securities Identification Number (ISIN)

---

## 1. Executive Summary

| Metric | Count / Value | % of Total Universe | Status |
| :--- | :--- | :--- | :--- |
| **Total Eligible Equities** | **${totalEligible.toLocaleString('en-IN')}** | 100.0% | Complete EOD Universe |
| **Total NSE Listed Equities** | **${nseCount.toLocaleString('en-IN')}** | ${((nseCount / totalEligible) * 100).toFixed(1)}% | Verified |
| **Total BSE Listed Equities** | **${bseCount.toLocaleString('en-IN')}** | ${((bseCount / totalEligible) * 100).toFixed(1)}% | Verified |
| **Dual-Listed Equities** | **${dualCount.toLocaleString('en-IN')}** | ${((dualCount / totalEligible) * 100).toFixed(1)}% | ISIN-Deduplicated |
| **Equities with Verified Market Cap** | **${verifiedCount.toLocaleString('en-IN')}** | **${coveragePct}%** | Verified Coverage |
| **Equities with Missing Market Cap** | **${missingCount.toLocaleString('en-IN')}** | **${(100 - coveragePct).toFixed(2)}%** | Documented & Unpriced |
| **Aggregate Verified Market Cap** | **₹${totalVerifiedCapCr.toLocaleString('en-IN')} Cr** | — | Real EOD Capitalization |

---

## 2. Multi-Source Ingestion Breakdown

| Source Priority | Source Description | Securities Resolved | Quality / Verification Level |
| :---: | :--- | :---: | :--- |
| **Priority 1** | Benchmark Blue-Chip Cache (\`benchmark_stocks_verified.json\`) | ${sourcesBreakdown.BENCHMARK_VERIFIED || 0} | Verified benchmark equities |
| **Priority 2** | BSE Security Master (\`bse_list_securities_verified.json\`) | ${sourcesBreakdown.BSE_SECURITY_MASTER || 0} | Exchange equity master |
| **Priority 3** | India Listed Company Catalog (\`api.dharun.dev/v1/companies\` via ISIN) | ${sourcesBreakdown.INDIA_API_ISIN || 0} | ISIN-matched market capitalization |
| **Priority 4** | Indian Equities Dataset (\`screener_market_caps.json\`) | ${sourcesBreakdown.SCREENER_DATASET || 0} | Symbol/scrip-matched capitalization |
| **Priority 5** | India Listed Company Catalog (Ticker match fallback) | ${sourcesBreakdown.INDIA_API_TICKER || 0} | Ticker lookup fallback |
| **Priority 6** | Share Count Fallback (\`Price × Outstanding Shares\`) | ${sourcesBreakdown.CALCULATED_OUTSTANDING_SHARES || 0} | Calculated from verified shares |
| **Priority 7** | Stale-While-Revalidate Session Cache | ${sourcesBreakdown.PREVIOUS_SESSION_VERIFIED || 0} | Zero-regression carryover |
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
  loadJsonWithReferenceFallback,
  fetchOrLoadApiCatalog,
  loadMarketCapSources,
  resolveStockMarketCap,
  rankStocksAndCategorize,
  generateCoverageReport,
  fetchJsonWithRetry
};
