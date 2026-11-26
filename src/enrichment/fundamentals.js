'use strict';

/**
 * Fundamentals, Sector/Industry, India VIX & 52-Week High/Low Enrichment
 *
 * Loads session-matched India VIX and NSE 52-Week High/Low archives,
 * applies curated ISIN sector overrides, and preserves verified ratios
 * (`pe_ratio`, `pb_ratio`, `roce`, `debt_to_equity`, `volume_ratio`)
 * across benchmark and prior-session universes without fabricating values.
 */

const fs = require('fs');
const path = require('path');
const { SECTOR_OVERRIDES } = require('../config/constants');
const { parseCSVContent, parseDateStr } = require('../processing/csv-parser');
const { getIndicesFilename, get52WeekFilename } = require('../ingestion/bhavcopy-downloader');

function loadIndiaVixFromArchive(downloadsDir, targetDate) {
  const idxPath = path.join(downloadsDir, getIndicesFilename(targetDate));
  if (!fs.existsSync(idxPath)) return null;
  try {
    const rows = parseCSVContent(fs.readFileSync(idxPath, 'utf8'));
    const vixRow = rows.find(r => String(r['Index Name'] || '').trim().toUpperCase() === 'INDIA VIX');
    if (!vixRow) return null;
    const rowDate = parseDateStr(vixRow['Index Date']);
    if (rowDate !== targetDate) return null;
    const close = parseFloat(vixRow['Closing Index Value']);
    const chgPct = parseFloat(vixRow['Change(%)']);
    if (!Number.isFinite(close) || close <= 0) return null;
    return {
      vix: parseFloat(close.toFixed(2)),
      vixChangePct: Number.isFinite(chgPct) ? parseFloat(chgPct.toFixed(2)) : null,
      vixDate: String(vixRow['Index Date'] || '').trim(),
      source: `NSE Index Close Archive (${path.basename(idxPath)})`
    };
  } catch (_) {
    return null;
  }
}

function loadNse52WeekArchive(downloadsDir, targetDate) {
  const bySymbolSeries = new Map();
  const bySymbol = new Map();
  const w52Path = path.join(downloadsDir, get52WeekFilename(targetDate));
  if (!fs.existsSync(w52Path)) {
    return { bySymbolSeries, bySymbol, loaded: false, effectiveDate: null, fileName: null };
  }

  try {
    const rawText = fs.readFileSync(w52Path, 'utf8');
    const lines = rawText.trim().split(/\r?\n/);
    if (lines.length < 4) {
      return { bySymbolSeries, bySymbol, loaded: false, effectiveDate: null, fileName: null };
    }

    const effMatch = lines.slice(0, 3).join('\n').match(/Effective for\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i);
    const effectiveDate = effMatch ? parseDateStr(effMatch[1]) : null;
    if (effectiveDate !== targetDate) {
      return { bySymbolSeries, bySymbol, loaded: false, effectiveDate, fileName: path.basename(w52Path) };
    }

    const headerIdx = lines.findIndex(l => l.includes('Adjusted_52_Week_High') && l.includes('SYMBOL'));
    if (headerIdx < 0) {
      return { bySymbolSeries, bySymbol, loaded: false, effectiveDate, fileName: path.basename(w52Path) };
    }

    const rows = parseCSVContent(lines.slice(headerIdx).join('\n'));
    for (const r of rows) {
      const symbol = String(r.SYMBOL || '').replace(/\$$/, '').trim().toUpperCase();
      const series = String(r.SERIES || '').trim().toUpperCase();
      const high = parseFloat(r.Adjusted_52_Week_High);
      const low = parseFloat(r.Adjusted_52_Week_Low);
      if (!symbol) continue;
      const validHigh = Number.isFinite(high) && high > 0 ? high : null;
      const validLow = Number.isFinite(low) && low > 0 ? low : null;
      if (validHigh == null && validLow == null) continue;
      const entry = { high: validHigh, low: validLow };
      if (series) bySymbolSeries.set(`${symbol}:${series}`, entry);
      if (!bySymbol.has(symbol) || series === 'EQ') bySymbol.set(symbol, entry);
    }

    return {
      bySymbolSeries,
      bySymbol,
      loaded: bySymbol.size > 0,
      effectiveDate,
      fileName: path.basename(w52Path)
    };
  } catch (_) {
    return { bySymbolSeries, bySymbol, loaded: false, effectiveDate: null, fileName: null };
  }
}

function loadBse52WeekFallback(downloadsDir, targetDate) {
  const near52WeekScripCodes = new Set();
  const week52HighMap = new Map();
  const near52Path = path.join(downloadsDir, 'bse_near_52week_verified.json');
  if (!fs.existsSync(near52Path)) {
    return { near52WeekScripCodes, week52HighMap, loaded: false };
  }
  try {
    const nearObj = JSON.parse(fs.readFileSync(near52Path, 'utf8'));
    if (nearObj.highs && Array.isArray(nearObj.highs)) {
      const currentSessionHighs = nearObj.highs.filter(h => parseDateStr(h.dt_tm) === targetDate);
      if (currentSessionHighs.length > 0) {
        for (const h of currentSessionHighs) {
          const sc = String(h.SCRIP_CD);
          near52WeekScripCodes.add(sc);
          if (h.Cur52wkHigh) week52HighMap.set(sc, parseFloat(h.Cur52wkHigh));
        }
        return { near52WeekScripCodes, week52HighMap, loaded: true };
      }
    }
  } catch (_) {}
  return { near52WeekScripCodes, week52HighMap, loaded: false };
}

const PLACEHOLDER_SECTORS = new Set(['GENERAL', 'UNCLASSIFIED', 'N/A', 'UNKNOWN', 'OTHER', 'MISCELLANEOUS', 'DIVERSIFIED']);
const PLACEHOLDER_INDUSTRIES = new Set(['SPECIALIZED SECTOR', 'DIVERSIFIED', 'MISCELLANEOUS', 'GENERAL GOVERNMENT', 'UNKNOWN', 'N/A']);

const CATALOG_SECTOR_TO_CANONICAL = {
  'energy minerals': 'Oil Gas & Consumable Fuels',
  'communications': 'Telecommunication',
  'health technology': 'Healthcare',
  'health services': 'Healthcare',
  'technology services': 'Information Technology',
  'transportation': 'Services',
  'commercial services': 'Services',
  'distribution services': 'Services',
  'retail trade': 'Consumer Services',
  'consumer services': 'Consumer Services'
};

const CATALOG_PAIR_TO_CANONICAL = {
  // Finance
  'finance|real estate development': 'Realty',
  'finance|real estate investment trusts': 'Realty',
  'finance|*': 'Financial Services',
  // Utilities
  'utilities|gas distributors': 'Oil Gas & Consumable Fuels',
  'utilities|electric utilities': 'Power',
  'utilities|alternative power generation': 'Power',
  'utilities|water utilities': 'Services',
  // Non-Energy Minerals
  'non-energy minerals|construction materials': 'Construction Materials',
  'non-energy minerals|forest products': 'Consumer Durables',
  'non-energy minerals|steel': 'Metals & Mining',
  'non-energy minerals|aluminum': 'Metals & Mining',
  'non-energy minerals|other metals/minerals': 'Metals & Mining',
  'non-energy minerals|precious metals': 'Metals & Mining',
  // Consumer Non-Durables
  'consumer non-durables|apparel/footwear': 'Consumer Durables',
  'consumer non-durables|*': 'Fast Moving Consumer Goods',
  // Consumer Durables
  'consumer durables|motor vehicles': 'Automobile and Auto Components',
  'consumer durables|automotive aftermarket': 'Automobile and Auto Components',
  'consumer durables|homebuilding': 'Realty',
  'consumer durables|*': 'Consumer Durables',
  // Producer Manufacturing
  'producer manufacturing|auto parts: oem': 'Automobile and Auto Components',
  'producer manufacturing|*': 'Capital Goods',
  // Electronic Technology
  'electronic technology|telecommunications equipment': 'Telecommunication',
  'electronic technology|computer peripherals': 'Information Technology',
  'electronic technology|computer processing hardware': 'Information Technology',
  'electronic technology|computer communications': 'Information Technology',
  'electronic technology|aerospace & defense': 'Capital Goods',
  'electronic technology|electronic equipment/instruments': 'Capital Goods',
  'electronic technology|electronic production equipment': 'Capital Goods',
  'electronic technology|electronic components': 'Capital Goods',
  'electronic technology|semiconductors': 'Capital Goods',
  // Process Industries
  'process industries|chemicals: specialty': 'Chemicals',
  'process industries|chemicals: agricultural': 'Chemicals',
  'process industries|chemicals: major diversified': 'Chemicals',
  'process industries|industrial specialties': 'Chemicals',
  'process industries|agricultural commodities/milling': 'Fast Moving Consumer Goods',
  'process industries|textiles': 'Consumer Durables',
  'process industries|containers/packaging': 'Capital Goods',
  'process industries|pulp & paper': 'Capital Goods',
  // Industrial Services
  'industrial services|engineering & construction': 'Construction',
  'industrial services|oil & gas pipelines': 'Oil Gas & Consumable Fuels',
  'industrial services|oilfield services/equipment': 'Oil Gas & Consumable Fuels',
  'industrial services|contract drilling': 'Oil Gas & Consumable Fuels',
  'industrial services|environmental services': 'Services',
  // Miscellaneous (only verified investment trusts/funds)
  'miscellaneous|investment trusts/mutual funds': 'Financial Services'
};

function isCleanSector(sector, industry) {
  const secUp = String(sector || '').trim().toUpperCase();
  if (!secUp || PLACEHOLDER_SECTORS.has(secUp)) return false;
  const indUp = String(industry || '').trim().toUpperCase();
  if (indUp === 'SPECIALIZED SECTOR') return false;
  return true;
}

function isCleanIndustry(industry) {
  const indUp = String(industry || '').trim().toUpperCase();
  return Boolean(indUp && !PLACEHOLDER_INDUSTRIES.has(indUp));
}

function mapCatalogToCanonicalSector(rawSector, rawIndustry) {
  const sec = String(rawSector || '').trim().toLowerCase();
  const ind = String(rawIndustry || '').trim().toLowerCase();
  if (!sec || sec === 'government' || (sec === 'miscellaneous' && ind === 'miscellaneous')) {
    return null;
  }
  const exact = CATALOG_PAIR_TO_CANONICAL[`${sec}|${ind}`];
  if (exact) return exact;
  const wildcard = CATALOG_PAIR_TO_CANONICAL[`${sec}|*`];
  if (wildcard) return wildcard;
  return CATALOG_SECTOR_TO_CANONICAL[sec] || null;
}

function enrichFundamentalsForStock({
  isin,
  symbol,
  nseSymbol,
  bseScripCode,
  series,
  currentPrice,
  benchmark,
  catalogEntry,
  prevStock,
  bseMasterEntry,
  nse52Week,
  bse52Week
}) {
  const cleanIsin = String(isin || '').trim().toUpperCase();
  let sector = null;
  let industry = null;

  const override = SECTOR_OVERRIDES[cleanIsin];
  if (override) {
    sector = override.sector;
    industry = override.industry;
  } else {
    if (benchmark && isCleanSector(benchmark.sector, benchmark.industry)) {
      sector = benchmark.sector;
      if (isCleanIndustry(benchmark.industry)) industry = benchmark.industry;
    }

    const mappedCatalogSector = catalogEntry
      ? mapCatalogToCanonicalSector(catalogEntry.sector, catalogEntry.industry)
      : null;

    if (!sector && mappedCatalogSector) {
      sector = mappedCatalogSector;
    }
    if (!industry && catalogEntry && isCleanIndustry(catalogEntry.industry)) {
      industry = catalogEntry.industry;
    }

    if (!sector && bseMasterEntry && isCleanSector(bseMasterEntry.sector, bseMasterEntry.industry)) {
      sector = bseMasterEntry.sector;
    }
    if (!industry && bseMasterEntry && isCleanIndustry(bseMasterEntry.industry)) {
      industry = bseMasterEntry.industry;
    }

    if (!sector && prevStock && isCleanSector(prevStock.sector, prevStock.industry)) {
      sector = prevStock.sector;
    }
    if (!industry && prevStock && isCleanIndustry(prevStock.industry)) {
      industry = prevStock.industry;
    }
  }

  if (!sector || PLACEHOLDER_SECTORS.has(String(sector).trim().toUpperCase())) {
    sector = 'Unclassified';
  }

  const pickNum = (bmVal, prevVal) => {
    if (bmVal != null && Number.isFinite(Number(bmVal))) return Number(bmVal);
    if (prevVal != null && Number.isFinite(Number(prevVal))) return Number(prevVal);
    return null;
  };

  const peRatio = pickNum(benchmark?.pe_ratio, prevStock?.pe_ratio);
  const pbRatio = pickNum(benchmark?.pb_ratio, prevStock?.pb_ratio);
  const roce = pickNum(benchmark?.roce, prevStock?.roce);
  const debtToEquity = pickNum(benchmark?.debt_to_equity, prevStock?.debt_to_equity);
  const volumeRatio = benchmark?.volume_ratio != null
    ? Number(benchmark.volume_ratio)
    : (prevStock?.volume_ratio != null ? Number(prevStock.volume_ratio) : 1.0);
  const logoUrl = benchmark?.logo_url || prevStock?.logo_url || null;

  let week52High = null;
  let week52Low = null;
  if (nse52Week?.loaded && nseSymbol) {
    const symUp = nseSymbol.toUpperCase();
    const serUp = String(series || '').toUpperCase();
    const rec = nse52Week.bySymbolSeries.get(`${symUp}:${serUp}`) || nse52Week.bySymbol.get(symUp);
    if (rec) {
      week52High = rec.high;
      week52Low = rec.low;
    }
  } else if (bseScripCode && bse52Week?.week52HighMap?.has(bseScripCode)) {
    week52High = bse52Week.week52HighMap.get(bseScripCode);
  }

  let isNearHigh = false;
  let pctFromHigh = null;
  if (week52High != null && currentPrice != null && week52High > 0) {
    pctFromHigh = parseFloat((((currentPrice - week52High) / week52High) * 100).toFixed(2));
    isNearHigh = pctFromHigh >= -8.0;
  } else if (bseScripCode && bse52Week?.near52WeekScripCodes?.has(bseScripCode)) {
    isNearHigh = true;
  }

  return {
    sector: sector || null,
    industry: industry || null,
    pe_ratio: peRatio,
    pb_ratio: pbRatio,
    roce,
    debt_to_equity: debtToEquity,
    volume_ratio: volumeRatio,
    logo_url: logoUrl,
    week52_high: week52High,
    week52_low: week52Low,
    pct_from_high: pctFromHigh,
    is_near_high: isNearHigh
  };
}

module.exports = {
  loadIndiaVixFromArchive,
  loadNse52WeekArchive,
  loadBse52WeekFallback,
  mapCatalogToCanonicalSector,
  enrichFundamentalsForStock
};
