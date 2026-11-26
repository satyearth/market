'use strict';

/**
 * Strict Financial & Structural Integrity Validator
 *
 * Enforces:
 * - Date alignment between marketStats, NSE source, BSE source, and every stock row
 * - Minimum universe size and shrinkage protection (>10% drop rejected unless forced)
 * - Valid ISIN format and zero duplicate ISINs
 * - Positive finite OHLC/close/prev_close prices, high >= low bounds
 * - Non-negative integer volume and valid market cap (>0 when present)
 * - Strictly chronological historical_prices arrays
 * - Exact market breadth & exchange coverage arithmetic identities
 */

function validateMergedDataset(mergedStocks, marketStats, options = {}) {
  const errors = [];
  const warnings = [];
  const targetDate = marketStats?.tradingDate;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(targetDate || ''))) {
    errors.push(`Invalid marketStats.tradingDate: ${targetDate}`);
  }
  if (marketStats?.nseSourceDate !== targetDate) {
    errors.push(`NSE source date mismatch: expected ${targetDate}, got ${marketStats?.nseSourceDate}`);
  }
  if (marketStats?.bseSourceDate !== targetDate) {
    errors.push(`BSE source date mismatch: expected ${targetDate}, got ${marketStats?.bseSourceDate}`);
  }

  const minUniverseSize = options.minUniverseSize ?? 1000;
  if (!Array.isArray(mergedStocks) || mergedStocks.length < minUniverseSize) {
    errors.push(`Universe count too small: ${mergedStocks?.length || 0} (min: ${minUniverseSize})`);
  }

  const prevCount = options.previousCount || 0;
  if (prevCount >= 1000 && !options.force && Array.isArray(mergedStocks) && mergedStocks.length < Math.floor(prevCount * 0.9)) {
    errors.push(
      `Unexpected record-count drop: ${mergedStocks.length} stocks vs previous ${prevCount} (>10% decrease). Pass --force to override.`
    );
  }

  const seenIsin = new Set();
  const symbolsByExchange = new Map();

  let invalidIsinCount = 0;
  let duplicateIsinCount = 0;
  let missingSymbolCount = 0;
  let invalidPriceCount = 0;
  let invalidSpreadCount = 0;
  let invalidVolumeCount = 0;
  let invalidMcapCount = 0;
  let dateMismatchCount = 0;
  let invalidHistoryCount = 0;

  for (const s of mergedStocks || []) {
    if (!s.isin || typeof s.isin !== 'string' || !/^IN[E9][A-Z0-9]{9}$/.test(s.isin)) {
      invalidIsinCount++;
    } else if (seenIsin.has(s.isin)) {
      duplicateIsinCount++;
    } else {
      seenIsin.add(s.isin);
    }

    if (!s.symbol || !s.company_name) missingSymbolCount++;
    if (s.trading_date !== targetDate) dateMismatchCount++;

    for (const field of ['current_price', 'close_price', 'open_price', 'high_price', 'low_price', 'prev_close']) {
      if (s[field] != null && (!Number.isFinite(s[field]) || s[field] <= 0)) {
        invalidPriceCount++;
      }
    }
    if (s.high_price != null && s.low_price != null && s.high_price < s.low_price) {
      invalidSpreadCount++;
    }
    if (!Number.isInteger(s.volume) || s.volume < 0) {
      invalidVolumeCount++;
    }
    if (s.market_cap_cr != null && (!Number.isFinite(s.market_cap_cr) || s.market_cap_cr <= 0)) {
      invalidMcapCount++;
    }

    if (s.historical_prices != null) {
      if (!Array.isArray(s.historical_prices)) {
        invalidHistoryCount++;
      } else {
        for (let i = 0; i < s.historical_prices.length; i++) {
          const h = s.historical_prices[i];
          if (!h || !/^\d{4}-\d{2}-\d{2}$/.test(h.date) || !Number.isFinite(h.close) || h.close <= 0) {
            invalidHistoryCount++;
            break;
          }
          if (i > 0 && h.date <= s.historical_prices[i - 1].date) {
            invalidHistoryCount++;
            break;
          }
        }
      }
    }

    if (s.nse_symbol) {
      const k = `NSE:${s.nse_symbol}`;
      if (!symbolsByExchange.has(k)) symbolsByExchange.set(k, []);
      symbolsByExchange.get(k).push(s.isin);
    }
    if (s.bse_scrip_code) {
      const k = `BSE:${s.bse_scrip_code}`;
      if (!symbolsByExchange.has(k)) symbolsByExchange.set(k, []);
      symbolsByExchange.get(k).push(s.isin);
    }
  }

  if (invalidIsinCount > 0) errors.push(`Invalid ISIN identifiers: ${invalidIsinCount}`);
  if (duplicateIsinCount > 0) errors.push(`Duplicate ISIN records detected: ${duplicateIsinCount}`);
  if (missingSymbolCount > 0) errors.push(`Missing symbol or company_name records: ${missingSymbolCount}`);
  if (dateMismatchCount > 0) errors.push(`Stocks with mismatched trading_date: ${dateMismatchCount}`);
  if (invalidPriceCount > 0) errors.push(`Zero/negative/NaN price fields detected: ${invalidPriceCount}`);
  if (invalidSpreadCount > 0) errors.push(`High < Low price spread anomalies: ${invalidSpreadCount}`);
  if (invalidVolumeCount > 0) errors.push(`Invalid negative/non-integer volume records: ${invalidVolumeCount}`);
  if (invalidMcapCount > 0) errors.push(`Invalid zero/negative/NaN market_cap_cr records: ${invalidMcapCount}`);
  if (invalidHistoryCount > 0) errors.push(`Corrupted or non-chronological historical_prices arrays: ${invalidHistoryCount}`);

  const duplicateExchangeKeys = [];
  for (const [k, isins] of symbolsByExchange.entries()) {
    if (isins.length > 1) duplicateExchangeKeys.push(`${k}(${isins.join(',')})`);
  }
  if (duplicateExchangeKeys.length > 0) {
    warnings.push(`Exchange identifier shared across multiple ISINs: ${duplicateExchangeKeys.slice(0, 10).join('; ')}`);
  }

  if (marketStats?.marketBreadth) {
    const { advances, declines, unchanged, unpriced } = marketStats.marketBreadth;
    if (advances + declines + unchanged + unpriced !== mergedStocks.length) {
      errors.push(
        `Breadth arithmetic identity mismatch: ${advances}+${declines}+${unchanged}+${unpriced} !== ${mergedStocks.length}`
      );
    }
  }

  if (marketStats?.exchangeCoverage) {
    const { dualListed, nseOnly, bseOnly } = marketStats.exchangeCoverage;
    if (dualListed + nseOnly + bseOnly !== mergedStocks.length) {
      errors.push(
        `Exchange coverage identity mismatch: ${dualListed}+${nseOnly}+${bseOnly} !== ${mergedStocks.length}`
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    duplicateExchangeKeys
  };
}

module.exports = {
  validateMergedDataset
};
