'use strict';

/**
 * NSE + BSE ISIN Universe Merger & Historical Price Matrix Compiler
 *
 * Takes validated NSE and BSE CM Unified BhavCopy rows plus trailing session
 * archives, deduplicates strictly by ISIN, merges OHLC/volume/exchange metadata,
 * attaches market caps + fundamentals, and computes market breadth statistics.
 */

const fs = require('fs');
const path = require('path');
const { parseCSVContent, cleanCompanyName } = require('./csv-parser');
const { getNseFilename, getBseFilename } = require('../ingestion/bhavcopy-downloader');
const { resolveStockMarketCap, rankStocksAndCategorize } = require('../enrichment/market-cap');
const { enrichFundamentalsForStock } = require('../enrichment/fundamentals');

const NSE_MAINBOARD_SERIES = new Set(['EQ', 'BE', 'BZ']);
const NSE_SME_SERIES = new Set(['SM', 'ST', 'SZ']);
const NSE_EQUITY_SERIES = new Set([...NSE_MAINBOARD_SERIES, ...NSE_SME_SERIES]);

const BSE_MAINBOARD_GROUPS = new Set(['A', 'B', 'T', 'X', 'XT', 'Z', 'ZP', 'P', 'R', 'SS', 'TS', 'IF', 'IT', 'E']);
const BSE_SME_GROUPS = new Set(['M', 'MT', 'MS']);
const BSE_EQUITY_GROUPS = new Set([...BSE_MAINBOARD_GROUPS, ...BSE_SME_GROUPS]);

function isEligibleIsin(isin) {
  return Boolean(isin && (isin.startsWith('INE') || isin.startsWith('IN9')));
}

function compileHistoricalMatrix(downloadsDir, historicalDates) {
  const priceHistoryByIsin = new Map();
  for (const dt of historicalDates) {
    const nFile = path.join(downloadsDir, getNseFilename(dt));
    const bFile = path.join(downloadsDir, getBseFilename(dt));
    const dayNse = fs.existsSync(nFile) ? parseCSVContent(fs.readFileSync(nFile, 'utf8')) : [];
    const dayBse = fs.existsSync(bFile) ? parseCSVContent(fs.readFileSync(bFile, 'utf8')) : [];
    const dayMap = new Map();

    for (const r of dayNse) {
      if (r.TradDt && r.TradDt !== dt) continue;
      const isin = r.ISIN;
      if (NSE_EQUITY_SERIES.has(r.SctySrs) && isEligibleIsin(isin)) {
        const p = parseFloat(r.ClsPric) || parseFloat(r.LastPric);
        if (Number.isFinite(p) && p > 0) dayMap.set(isin, p);
      }
    }

    for (const r of dayBse) {
      if (r.TradDt && r.TradDt !== dt) continue;
      const isin = r.ISIN;
      if (BSE_EQUITY_GROUPS.has(r.SctySrs) && isEligibleIsin(isin)) {
        const p = parseFloat(r.ClsPric) || parseFloat(r.LastPric);
        if (Number.isFinite(p) && p > 0 && !dayMap.has(isin)) {
          dayMap.set(isin, p);
        }
      }
    }

    for (const [isin, p] of dayMap.entries()) {
      if (!priceHistoryByIsin.has(isin)) priceHistoryByIsin.set(isin, {});
      priceHistoryByIsin.get(isin)[dt] = p;
    }
  }
  return priceHistoryByIsin;
}

function buildUniverseDiff(mergedStocks, previousUniverseByIsin, targetDate, compileTime) {
  const newlyListed = [];
  const newExchangeListings = [];
  const symbolChanges = [];
  const seriesChanges = [];
  const delistedOrSuspended = [];
  const currentIsinSet = new Set(mergedStocks.map(s => s.isin));

  for (const s of mergedStocks) {
    const prev = previousUniverseByIsin.get(s.isin);
    if (!prev) {
      newlyListed.push({
        isin: s.isin,
        symbol: s.symbol,
        company_name: s.company_name,
        exchanges: s.exchanges,
        segment: s.segment,
        series: s.series,
        current_price: s.current_price,
        has_eod_price: s.current_price != null,
        detected_at: compileTime.toISOString()
      });
    } else {
      const prevExchanges = new Set(prev.exchanges || []);
      const addedExchanges = s.exchanges.filter(x => !prevExchanges.has(x));
      if (addedExchanges.length > 0) {
        newExchangeListings.push({
          isin: s.isin,
          symbol: s.symbol,
          company_name: s.company_name,
          previous_exchanges: prev.exchanges,
          current_exchanges: s.exchanges,
          added_exchanges: addedExchanges
        });
      }
      if (prev.symbol && s.symbol && prev.symbol !== s.symbol) {
        symbolChanges.push({ isin: s.isin, company_name: s.company_name, old_symbol: prev.symbol, new_symbol: s.symbol });
      }
      if (prev.series && s.series && prev.series !== s.series) {
        seriesChanges.push({
          isin: s.isin,
          symbol: s.symbol,
          company_name: s.company_name,
          old_series: prev.series,
          new_series: s.series,
          old_segment: prev.segment,
          new_segment: s.segment
        });
      }
    }
  }

  for (const [isin, prev] of previousUniverseByIsin.entries()) {
    if (!currentIsinSet.has(isin)) {
      delistedOrSuspended.push({
        isin: prev.isin,
        symbol: prev.symbol,
        company_name: prev.company_name,
        last_exchanges: prev.exchanges,
        last_series: prev.series
      });
    }
  }

  return {
    tradingDate: targetDate,
    detectedAt: compileTime.toISOString(),
    previousUniverseCount: previousUniverseByIsin.size,
    currentUniverseCount: mergedStocks.length,
    summary: {
      newlyListedCount: newlyListed.length,
      newSmeCount: newlyListed.filter(s => s.segment === 'SME').length,
      newMainboardCount: newlyListed.filter(s => s.segment === 'Mainboard').length,
      newExchangeListingsCount: newExchangeListings.length,
      symbolChangesCount: symbolChanges.length,
      seriesChangesCount: seriesChanges.length,
      delistedOrSuspendedCount: delistedOrSuspended.length
    },
    newlyListed,
    newExchangeListings,
    symbolChanges,
    seriesChanges,
    delistedOrSuspended
  };
}

function mergeExchangeUniverse({
  targetDate,
  nseRaw,
  bseRaw,
  downloadsDir,
  historicalDates,
  marketCapSources,
  previousUniverseByIsin,
  nse52Week,
  bse52Week,
  fetchStartTime
}) {
  const priceHistoryByIsin = compileHistoricalMatrix(downloadsDir, historicalDates);
  const nseByIsin = new Map();
  let nseMainboardCount = 0;
  let nseSmeCount = 0;

  for (const r of nseRaw) {
    const isin = r.ISIN ? r.ISIN.trim() : '';
    const series = r.SctySrs ? r.SctySrs.trim() : '';
    const symbol = r.TckrSymb ? r.TckrSymb.trim() : '';
    const name = r.FinInstrmNm ? r.FinInstrmNm.trim() : '';

    if (!NSE_EQUITY_SERIES.has(series) || !isEligibleIsin(isin)) continue;

    if (NSE_MAINBOARD_SERIES.has(series)) nseMainboardCount++;
    if (NSE_SME_SERIES.has(series)) nseSmeCount++;

    const openPrice = parseFloat(r.OpnPric) || null;
    const highPrice = parseFloat(r.HghPric) || null;
    const lowPrice = parseFloat(r.LwPric) || null;
    const closePrice = parseFloat(r.ClsPric) || parseFloat(r.LastPric) || null;
    const prevClose = parseFloat(r.PrvsClsgPric) || null;
    const changePct = (closePrice != null && prevClose != null && prevClose > 0)
      ? parseFloat((((closePrice - prevClose) / prevClose) * 100).toFixed(2))
      : null;

    const item = {
      isin,
      nse_symbol: symbol,
      company_name: cleanCompanyName(name),
      series,
      segment: NSE_SME_SERIES.has(series) ? 'SME' : 'Mainboard',
      open_price: openPrice && openPrice > 0 ? openPrice : null,
      high_price: highPrice && highPrice > 0 ? highPrice : null,
      low_price: lowPrice && lowPrice > 0 ? lowPrice : null,
      close_price: closePrice && closePrice > 0 ? closePrice : null,
      current_price: closePrice && closePrice > 0 ? closePrice : null,
      prev_close: prevClose && prevClose > 0 ? prevClose : null,
      change_percent: changePct,
      volume: Math.max(0, parseInt(r.TtlTradgVol, 10) || 0),
      listing_status: 'Active',
      trade_date: r.TradDt || targetDate,
      traded_on_target: true
    };

    if (nseByIsin.has(isin)) {
      const existing = nseByIsin.get(isin);
      if (existing.series !== 'EQ' && series === 'EQ') nseByIsin.set(isin, item);
    } else {
      nseByIsin.set(isin, item);
    }
  }

  const bseByIsin = new Map();
  let bseMainboardCount = 0;
  let bseSmeCount = 0;

  for (const r of bseRaw) {
    const isin = r.ISIN ? r.ISIN.trim() : '';
    const group = r.SctySrs ? r.SctySrs.trim() : '';
    const scripCode = r.FinInstrmId ? r.FinInstrmId.trim() : '';
    const ticker = r.TckrSymb ? r.TckrSymb.trim() : '';
    const name = r.FinInstrmNm ? r.FinInstrmNm.trim() : '';

    if (!BSE_EQUITY_GROUPS.has(group) || !isEligibleIsin(isin)) continue;

    if (BSE_MAINBOARD_GROUPS.has(group)) bseMainboardCount++;
    if (BSE_SME_GROUPS.has(group)) bseSmeCount++;

    const openPrice = parseFloat(r.OpnPric) || null;
    const highPrice = parseFloat(r.HghPric) || null;
    const lowPrice = parseFloat(r.LwPric) || null;
    const closePrice = parseFloat(r.ClsPric) || parseFloat(r.LastPric) || null;
    const prevClose = parseFloat(r.PrvsClsgPric) || null;
    const changePct = (closePrice != null && prevClose != null && prevClose > 0)
      ? parseFloat((((closePrice - prevClose) / prevClose) * 100).toFixed(2))
      : null;

    const item = {
      isin,
      bse_scrip_code: scripCode,
      bse_ticker: ticker,
      company_name: cleanCompanyName(name),
      group,
      segment: BSE_SME_GROUPS.has(group) ? 'SME' : 'Mainboard',
      open_price: openPrice && openPrice > 0 ? openPrice : null,
      high_price: highPrice && highPrice > 0 ? highPrice : null,
      low_price: lowPrice && lowPrice > 0 ? lowPrice : null,
      close_price: closePrice && closePrice > 0 ? closePrice : null,
      current_price: closePrice && closePrice > 0 ? closePrice : null,
      prev_close: prevClose && prevClose > 0 ? prevClose : null,
      change_percent: changePct,
      volume: Math.max(0, parseInt(r.TtlTradgVol, 10) || 0),
      listing_status: 'Active',
      trade_date: r.TradDt || targetDate,
      traded_on_target: true
    };

    if (bseByIsin.has(isin)) {
      const existing = bseByIsin.get(isin);
      if (existing.group !== 'A' && group === 'A') bseByIsin.set(isin, item);
    } else {
      bseByIsin.set(isin, item);
    }
  }

  // Carry forward securities absent on target session if traded within prior 5 sessions
  for (let idx = historicalDates.length - 2; idx >= 0; idx--) {
    const dt = historicalDates[idx];
    const nFile = path.join(downloadsDir, getNseFilename(dt));
    const bFile = path.join(downloadsDir, getBseFilename(dt));
    const dayNseRaw = fs.existsSync(nFile) ? parseCSVContent(fs.readFileSync(nFile, 'utf8')) : [];
    const dayBseRaw = fs.existsSync(bFile) ? parseCSVContent(fs.readFileSync(bFile, 'utf8')) : [];

    for (const r of dayNseRaw) {
      const isin = r.ISIN ? r.ISIN.trim() : '';
      const series = r.SctySrs ? r.SctySrs.trim() : '';
      const symbol = r.TckrSymb ? r.TckrSymb.trim() : '';
      const name = r.FinInstrmNm ? r.FinInstrmNm.trim() : '';
      if (!NSE_EQUITY_SERIES.has(series) || !isEligibleIsin(isin)) continue;

      if (!nseByIsin.has(isin)) {
        if (NSE_MAINBOARD_SERIES.has(series)) nseMainboardCount++;
        if (NSE_SME_SERIES.has(series)) nseSmeCount++;
        const lastClose = parseFloat(r.ClsPric) || parseFloat(r.LastPric) || null;
        const safeLast = lastClose && lastClose > 0 ? lastClose : null;
        nseByIsin.set(isin, {
          isin,
          nse_symbol: symbol,
          company_name: cleanCompanyName(name),
          series,
          segment: NSE_SME_SERIES.has(series) ? 'SME' : 'Mainboard',
          open_price: null,
          high_price: null,
          low_price: null,
          close_price: safeLast,
          current_price: safeLast,
          prev_close: safeLast,
          change_percent: 0.00,
          volume: 0,
          listing_status: 'Active',
          trade_date: targetDate,
          traded_on_target: false
        });
      }
    }

    for (const r of dayBseRaw) {
      const isin = r.ISIN ? r.ISIN.trim() : '';
      const group = r.SctySrs ? r.SctySrs.trim() : '';
      const scripCode = r.FinInstrmId ? r.FinInstrmId.trim() : '';
      const ticker = r.TckrSymb ? r.TckrSymb.trim() : '';
      const name = r.FinInstrmNm ? r.FinInstrmNm.trim() : '';
      if (!BSE_EQUITY_GROUPS.has(group) || !isEligibleIsin(isin)) continue;

      if (!bseByIsin.has(isin)) {
        if (BSE_MAINBOARD_GROUPS.has(group)) bseMainboardCount++;
        if (BSE_SME_GROUPS.has(group)) bseSmeCount++;
        const lastClose = parseFloat(r.ClsPric) || parseFloat(r.LastPric) || null;
        const safeLast = lastClose && lastClose > 0 ? lastClose : null;
        bseByIsin.set(isin, {
          isin,
          bse_scrip_code: scripCode,
          bse_ticker: ticker,
          company_name: cleanCompanyName(name),
          group,
          segment: BSE_SME_GROUPS.has(group) ? 'SME' : 'Mainboard',
          open_price: null,
          high_price: null,
          low_price: null,
          close_price: safeLast,
          current_price: safeLast,
          prev_close: safeLast,
          change_percent: 0.00,
          volume: 0,
          listing_status: 'Active',
          trade_date: targetDate,
          traded_on_target: false
        });
      }
    }
  }

  const allIsins = new Set([...nseByIsin.keys(), ...bseByIsin.keys()]);
  let dualListedCount = 0;
  let nseOnlyCount = 0;
  let bseOnlyCount = 0;
  let mergedStocks = [];

  for (const isin of allIsins) {
    const nse = nseByIsin.get(isin);
    const bse = bseByIsin.get(isin);

    let symbol = '';
    let nseSymbol = null;
    let bseScripCode = null;
    let exchanges = [];
    let segment = 'Mainboard';
    let series = null;
    let companyName = '';
    let openPrice = null;
    let highPrice = null;
    let lowPrice = null;
    let currentPrice = null;
    let prevClose = null;
    let changePercent = null;
    let volume = 0;

    if (nse && bse) {
      dualListedCount++;
      exchanges = ['NSE', 'BSE'];
      symbol = nse.nse_symbol || bse.bse_ticker || bse.bse_scrip_code;
      nseSymbol = nse.nse_symbol;
      bseScripCode = bse.bse_scrip_code;
      companyName = (bse.company_name && bse.company_name.length > (nse.company_name || '').length)
        ? bse.company_name
        : (nse.company_name || bse.company_name);
      segment = (nse.segment === 'SME' || bse.segment === 'SME') ? 'SME' : 'Mainboard';
      series = nse.series || bse.group;

      if (nse.traded_on_target && !bse.traded_on_target) {
        openPrice = nse.open_price;
        highPrice = nse.high_price;
        lowPrice = nse.low_price;
        currentPrice = nse.current_price;
        prevClose = nse.prev_close;
        changePercent = nse.change_percent;
        volume = nse.volume || 0;
      } else if (!nse.traded_on_target && bse.traded_on_target) {
        openPrice = bse.open_price;
        highPrice = bse.high_price;
        lowPrice = bse.low_price;
        currentPrice = bse.current_price;
        prevClose = bse.prev_close;
        changePercent = bse.change_percent;
        volume = bse.volume || 0;
      } else if (nse.traded_on_target && bse.traded_on_target) {
        openPrice = nse.open_price != null ? nse.open_price : bse.open_price;
        highPrice = (nse.high_price != null && bse.high_price != null)
          ? Math.max(nse.high_price, bse.high_price)
          : (nse.high_price != null ? nse.high_price : bse.high_price);
        lowPrice = (nse.low_price != null && bse.low_price != null)
          ? Math.min(nse.low_price, bse.low_price)
          : (nse.low_price != null ? nse.low_price : bse.low_price);
        currentPrice = nse.current_price != null ? nse.current_price : bse.current_price;
        prevClose = nse.prev_close != null ? nse.prev_close : bse.prev_close;
        changePercent = nse.change_percent != null ? nse.change_percent : bse.change_percent;
        volume = (nse.volume || 0) + (bse.volume || 0);
      } else {
        currentPrice = nse.current_price != null ? nse.current_price : bse.current_price;
        prevClose = currentPrice;
        changePercent = 0.00;
        volume = 0;
      }
    } else if (nse) {
      nseOnlyCount++;
      exchanges = ['NSE'];
      symbol = nse.nse_symbol;
      nseSymbol = nse.nse_symbol;
      companyName = nse.company_name;
      segment = nse.segment;
      series = nse.series;
      openPrice = nse.open_price;
      highPrice = nse.high_price;
      lowPrice = nse.low_price;
      currentPrice = nse.current_price;
      prevClose = nse.prev_close;
      changePercent = nse.change_percent;
      volume = nse.volume || 0;
    } else if (bse) {
      bseOnlyCount++;
      exchanges = ['BSE'];
      symbol = bse.bse_ticker || bse.bse_scrip_code;
      bseScripCode = bse.bse_scrip_code;
      companyName = bse.company_name;
      segment = bse.segment;
      series = bse.group;
      openPrice = bse.open_price;
      highPrice = bse.high_price;
      lowPrice = bse.low_price;
      currentPrice = bse.current_price;
      prevClose = bse.prev_close;
      changePercent = bse.change_percent;
      volume = bse.volume || 0;
    }

    const histObj = priceHistoryByIsin.get(isin) || {};
    const validDates = historicalDates.filter(d => histObj[d] != null);
    let historicalPrices = null;
    let sparkline7d = null;
    let return1w = null;
    let sessionStartDate = null;
    let sessionEndDate = null;

    if (validDates.length >= 2) {
      historicalPrices = validDates.map(d => ({ date: d, close: histObj[d] }));
      sparkline7d = historicalPrices.map(h => h.close);
      sessionStartDate = validDates[0];
      sessionEndDate = validDates[validDates.length - 1];
      const pFirst = histObj[sessionStartDate];
      const pLatest = currentPrice != null ? currentPrice : histObj[sessionEndDate];
      if (pFirst && pLatest && pFirst > 0) {
        return1w = parseFloat((((pLatest - pFirst) / pFirst) * 100).toFixed(2));
      }
    }

    const benchmark = marketCapSources.benchmarkBySymbol.get(String(symbol || '').toUpperCase());
    const prevStock = previousUniverseByIsin.get(isin);
    const bseMasterEntry = marketCapSources.bseSecByIsin.get(isin);

    const fund = enrichFundamentalsForStock({
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
    });

    const capRes = resolveStockMarketCap(
      { isin, symbol, nse_symbol: nseSymbol, bse_scrip_code: bseScripCode, current_price: currentPrice, close_price: currentPrice },
      marketCapSources,
      prevStock
    );

    let safeHigh = highPrice;
    let safeLow = lowPrice;
    if (safeHigh != null && safeLow != null && safeHigh < safeLow) {
      const tmp = safeHigh;
      safeHigh = safeLow;
      safeLow = tmp;
    }

    mergedStocks.push({
      symbol,
      company_name: companyName || symbol,
      isin,
      nse_symbol: nseSymbol,
      bse_scrip_code: bseScripCode,
      exchanges,
      segment,
      series,
      listing_status: 'Active',
      sector: fund.sector,
      industry: fund.industry,
      open_price: openPrice,
      high_price: safeHigh,
      low_price: safeLow,
      close_price: currentPrice,
      current_price: currentPrice,
      prev_close: prevClose,
      change_percent: changePercent,
      volume,
      volume_ratio: fund.volume_ratio,
      historical_prices: historicalPrices,
      sparkline_7d: sparkline7d,
      return_1w: return1w,
      return_1w_session_start: sessionStartDate,
      return_1w_session_end: sessionEndDate,
      return_1m: null,
      return_3m: null,
      week52_high: fund.week52_high,
      week52_low: fund.week52_low,
      pct_from_high: fund.pct_from_high,
      is_near_high: fund.is_near_high,
      pe_ratio: fund.pe_ratio,
      pb_ratio: fund.pb_ratio,
      roce: fund.roce,
      debt_to_equity: fund.debt_to_equity,
      logo_url: fund.logo_url,
      trading_date: targetDate,
      fetched_at: fetchStartTime.toISOString(),
      market_cap_cr: capRes.market_cap_cr,
      market_cap_source: capRes.market_cap_source || null
    });
  }

  const rankingResult = rankStocksAndCategorize(mergedStocks);
  mergedStocks = rankingResult.rankedStocks;

  return {
    mergedStocks,
    rankingResult,
    counts: {
      nseCount: nseByIsin.size,
      bseCount: bseByIsin.size,
      dualListedCount,
      nseOnlyCount,
      bseOnlyCount,
      nseMainboardCount,
      nseSmeCount,
      bseMainboardCount,
      bseSmeCount,
      dualListedSmeCount: [...nseByIsin.entries()].filter(([k, stock]) =>
        stock.segment === 'SME' && bseByIsin.get(k)?.segment === 'SME'
      ).length
    }
  };
}

module.exports = {
  NSE_MAINBOARD_SERIES,
  NSE_SME_SERIES,
  NSE_EQUITY_SERIES,
  BSE_MAINBOARD_GROUPS,
  BSE_SME_GROUPS,
  BSE_EQUITY_GROUPS,
  isEligibleIsin,
  compileHistoricalMatrix,
  buildUniverseDiff,
  mergeExchangeUniverse
};
