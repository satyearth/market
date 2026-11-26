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

function enrichFundamentalsForStock({
  isin,
  symbol,
  nseSymbol,
  bseScripCode,
  series,
  currentPrice,
  benchmark,
  prevStock,
  bseMasterEntry,
  nse52Week,
  bse52Week
}) {
  let sector = benchmark?.sector || prevStock?.sector || null;
  let industry = benchmark?.industry || prevStock?.industry || bseMasterEntry?.industry || null;

  const override = SECTOR_OVERRIDES[isin];
  if (override) {
    sector = override.sector;
    industry = override.industry;
  } else if (sector && String(sector).toUpperCase() === 'GENERAL') {
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
  enrichFundamentalsForStock
};
