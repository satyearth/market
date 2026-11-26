'use strict';

/**
 * Compact Columnar 90-Session Historical Price Store & Compression Helpers
 *
 * Separates heavy up-to-90-session per-ISIN closing-price history from daily
 * immutable stock snapshots so Supabase Storage stays well within the Free
 * Plan 1 GB quota while keeping SHA-256 verification, incremental updates,
 * non-fabricated nulls, and full API compatibility.
 */

const crypto = require('crypto');
const zlib = require('zlib');
const { MAX_HISTORICAL_SESSIONS } = require('../config/constants');

const ENCODING_GZIP_BASE64 = 'gzip+base64';
const DAILY_ENVELOPE_FORMAT = 'machii-bazzar-daily-v2';
const HISTORY_ENVELOPE_FORMAT = 'machii-bazzar-history-v2';

function sha256Hex(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function isValidIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function isEligibleEquityIsin(isin) {
  return Boolean(isin && typeof isin === 'string' && /^IN[E9][A-Z0-9]{9}$/.test(isin));
}

/**
 * Wraps any JSON-serializable object into a UTF-8 JSON envelope with level-9
 * gzip+base64 compression. Remains 100% compatible with `application/json`.
 */
function encodeCompressedJson(innerObject, meta = {}) {
  const rawJson = JSON.stringify(innerObject);
  const rawBytes = Buffer.byteLength(rawJson, 'utf8');
  const uncompressedSha256 = sha256Hex(rawJson);
  const compressed = zlib.gzipSync(Buffer.from(rawJson, 'utf8'), { level: 9 });
  const envelope = {
    schemaVersion: 2,
    encoding: ENCODING_GZIP_BASE64,
    ...meta,
    uncompressedBytes: rawBytes,
    uncompressedSha256,
    payload: compressed.toString('base64')
  };
  const encodedText = JSON.stringify(envelope);
  return {
    text: encodedText,
    bytes: Buffer.byteLength(encodedText, 'utf8'),
    rawBytes,
    sha256: sha256Hex(encodedText),
    uncompressedSha256
  };
}

/**
 * Decodes either a gzip+base64 JSON envelope (schema v2) or plain JSON (schema v1).
 */
function decodeCompressedJson(rawText) {
  const parsed = JSON.parse(rawText);
  if (parsed && parsed.encoding === ENCODING_GZIP_BASE64 && typeof parsed.payload === 'string') {
    const rawBuffer = zlib.gunzipSync(Buffer.from(parsed.payload, 'base64'));
    const innerText = rawBuffer.toString('utf8');
    if (parsed.uncompressedSha256 && sha256Hex(innerText) !== parsed.uncompressedSha256) {
      throw new Error('Decompressed payload SHA-256 mismatch');
    }
    return {
      envelope: parsed,
      data: JSON.parse(innerText),
      rawBytes: Buffer.byteLength(innerText, 'utf8'),
      compressed: true
    };
  }
  return {
    envelope: null,
    data: parsed,
    rawBytes: Buffer.byteLength(rawText, 'utf8'),
    compressed: false
  };
}

/**
 * Returns a copy of stocks without inline `historical_prices` arrays
 * for lean daily stock snapshots. Preserves `sparkline_7d` and returns.
 */
function stripInlineHistoricalPrices(stocks = []) {
  return (stocks || []).map(stock => {
    if (!stock || !Object.prototype.hasOwnProperty.call(stock, 'historical_prices')) {
      return stock;
    }
    const { historical_prices: _omitted, ...dailyOnly } = stock;
    return dailyOnly;
  });
}

/**
 * Builds a deduplicated, chronologically ordered compact columnar historical
 * payload storing `[startOffset, trimmedClosesSlice]` per ISIN.
 */
function buildCompactHistoryPayload({
  sessions = [],
  priceHistoryByIsin,
  versionId = null,
  tradingDate = null,
  refreshedAtUtc = null,
  maxSessions = MAX_HISTORICAL_SESSIONS
}) {
  const cleanDates = [...new Set(
    (sessions || [])
      .map(d => String(d || '').trim())
      .filter(d => isValidIsoDate(d) && (!tradingDate || d <= tradingDate))
  )].sort().slice(-maxSessions);

  const closesByIsin = {};
  const isins = priceHistoryByIsin && typeof priceHistoryByIsin.keys === 'function'
    ? [...priceHistoryByIsin.keys()].sort()
    : [];

  for (const isin of isins) {
    if (!isEligibleEquityIsin(isin)) continue;
    const histMap = priceHistoryByIsin.get(isin);
    if (!histMap || typeof histMap !== 'object') continue;

    let firstIdx = -1;
    let lastIdx = -1;
    for (let i = 0; i < cleanDates.length; i++) {
      const p = Number(histMap[cleanDates[i]]);
      if (Number.isFinite(p) && p > 0) {
        if (firstIdx === -1) firstIdx = i;
        lastIdx = i;
      }
    }
    if (firstIdx === -1) continue;

    const slice = [];
    for (let i = firstIdx; i <= lastIdx; i++) {
      const p = Number(histMap[cleanDates[i]]);
      slice.push(Number.isFinite(p) && p > 0 ? p : null);
    }
    closesByIsin[isin] = [firstIdx, slice];
  }

  const canonicalContent = JSON.stringify({ sessions: cleanDates, closesByIsin });
  const contentSha256 = sha256Hex(canonicalContent);
  const resolvedTradingDate = tradingDate || cleanDates[cleanDates.length - 1] || null;

  return {
    schemaVersion: 2,
    format: HISTORY_ENVELOPE_FORMAT,
    versionId: versionId || (resolvedTradingDate ? `${resolvedTradingDate}-hist` : 'hist'),
    tradingDate: resolvedTradingDate,
    refreshedAtUtc: refreshedAtUtc || null,
    startDate: cleanDates[0] || null,
    endDate: cleanDates[cleanDates.length - 1] || null,
    maxSessions,
    sessionCount: cleanDates.length,
    isinCount: Object.keys(closesByIsin).length,
    contentSha256,
    sessions: cleanDates,
    closesByIsin
  };
}

/**
 * Extracts a compact historical payload from stocks carrying inline `historical_prices`
 * (used when migrating legacy datasets or direct storage tests).
 */
function extractCompactHistoryFromStocks(stocks = [], tradingDate = null, maxSessions = MAX_HISTORICAL_SESSIONS) {
  const dateSet = new Set();
  const priceHistoryByIsin = new Map();

  for (const stock of stocks || []) {
    const isin = String(stock?.isin || '').trim().toUpperCase();
    if (!isEligibleEquityIsin(isin) || !Array.isArray(stock?.historical_prices) || stock.historical_prices.length === 0) {
      continue;
    }
    const histMap = {};
    for (const entry of stock.historical_prices) {
      if (!entry || !isValidIsoDate(entry.date)) continue;
      if (tradingDate && entry.date > tradingDate) continue;
      const p = Number(entry.close);
      if (Number.isFinite(p) && p > 0) {
        histMap[entry.date] = p;
        dateSet.add(entry.date);
      }
    }
    if (Object.keys(histMap).length > 0) {
      priceHistoryByIsin.set(isin, histMap);
    }
  }

  if (dateSet.size === 0 || priceHistoryByIsin.size === 0) {
    return null;
  }

  return buildCompactHistoryPayload({
    sessions: [...dateSet],
    priceHistoryByIsin,
    tradingDate: tradingDate || [...dateSet].sort().pop(),
    maxSessions
  });
}

/**
 * Unpacks `[startOffset, values]` or legacy array entries cleanly.
 */
function unpackSeriesEntry(entry) {
  if (Array.isArray(entry) && entry.length === 2 && Number.isInteger(entry[0]) && Array.isArray(entry[1])) {
    return { startIdx: entry[0], values: entry[1] };
  }
  if (Array.isArray(entry)) {
    return { startIdx: 0, values: entry };
  }
  return null;
}

/**
 * Normalizes a `closesByIsin[isin]` entry (supporting tuple `[startIdx, slice]`
 * or full array) into a chronological array of `{ date, close }` objects.
 */
function expandHistoricalPricesForIsin(historyPayload, isin) {
  if (!historyPayload || !Array.isArray(historyPayload.sessions) || !historyPayload.closesByIsin) {
    return null;
  }
  const cleanIsin = String(isin || '').trim().toUpperCase();
  const unpacked = unpackSeriesEntry(historyPayload.closesByIsin[cleanIsin]);
  if (!unpacked) return null;

  const { startIdx, values } = unpacked;
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const dt = historyPayload.sessions[startIdx + i];
    const p = values[i] == null ? NaN : Number(values[i]);
    if (isValidIsoDate(dt) && Number.isFinite(p) && p > 0) {
      out.push({ date: dt, close: p });
    }
  }
  return out.length >= 2 ? out : null;
}

/**
 * Hydrates verified prior closes `< targetDate` into `priceHistoryByIsin`
 * from an existing compact historical dataset payload.
 */
function hydrateHistoryMapFromPayload(historyPayload, allowedDatesSet, targetDate, priceHistoryByIsin) {
  if (!historyPayload || !Array.isArray(historyPayload.sessions) || !historyPayload.closesByIsin) {
    return priceHistoryByIsin;
  }
  const sessions = historyPayload.sessions;
  for (const [rawIsin, entry] of Object.entries(historyPayload.closesByIsin)) {
    const isin = String(rawIsin || '').trim().toUpperCase();
    if (!isEligibleEquityIsin(isin)) continue;

    const unpacked = unpackSeriesEntry(entry);
    if (!unpacked) continue;
    const { startIdx, values } = unpacked;

    for (let i = 0; i < values.length; i++) {
      const dt = sessions[startIdx + i];
      if (!isValidIsoDate(dt)) continue;
      if (allowedDatesSet && !allowedDatesSet.has(dt)) continue;
      if (targetDate && dt >= targetDate) continue;
      const p = values[i] == null ? NaN : Number(values[i]);
      if (Number.isFinite(p) && p > 0) {
        if (!priceHistoryByIsin.has(isin)) priceHistoryByIsin.set(isin, {});
        priceHistoryByIsin.get(isin)[dt] = p;
      }
    }
  }
  return priceHistoryByIsin;
}

/**
 * Validates structural, chronological, deduplication, and numeric bounds invariants
 * of a compact historical dataset payload before publishing or serving.
 */
function validateCompactHistoryPayload(historyObj, options = {}) {
  const errors = [];
  const maxSessions = options.maxSessions ?? MAX_HISTORICAL_SESSIONS;
  const targetDate = options.tradingDate || historyObj?.tradingDate || null;

  if (!historyObj || typeof historyObj !== 'object') {
    return { ok: false, errors: ['Compact historical dataset payload is missing or invalid'] };
  }
  if (!Array.isArray(historyObj.sessions)) {
    errors.push('Compact historical dataset missing sessions array');
  } else {
    if (historyObj.sessions.length > maxSessions) {
      errors.push(`Compact historical sessions (${historyObj.sessions.length}) exceeds maximum (${maxSessions})`);
    }
    for (let i = 0; i < historyObj.sessions.length; i++) {
      const dt = historyObj.sessions[i];
      if (!isValidIsoDate(dt)) {
        errors.push(`Invalid session date in historical dataset: ${dt}`);
        break;
      }
      if (targetDate && isValidIsoDate(targetDate) && dt > targetDate) {
        errors.push(`Future session date ${dt} exceeds tradingDate ${targetDate}`);
        break;
      }
      if (i > 0 && dt <= historyObj.sessions[i - 1]) {
        errors.push(`Duplicate or non-chronological session date in historical dataset: ${dt}`);
        break;
      }
    }
    if (historyObj.sessionCount != null && historyObj.sessionCount !== historyObj.sessions.length) {
      errors.push(`sessionCount mismatch (${historyObj.sessionCount} !== ${historyObj.sessions.length})`);
    }
  }

  if (!historyObj.closesByIsin || typeof historyObj.closesByIsin !== 'object' || Array.isArray(historyObj.closesByIsin)) {
    errors.push('Compact historical dataset missing closesByIsin map');
  } else if (Array.isArray(historyObj.sessions)) {
    const sessLen = historyObj.sessions.length;
    const isinEntries = Object.entries(historyObj.closesByIsin);
    let invalidSeries = 0;
    for (const [isin, entry] of isinEntries) {
      if (!isEligibleEquityIsin(isin)) {
        invalidSeries++;
        break;
      }
      const unpacked = unpackSeriesEntry(entry);
      if (!unpacked) {
        invalidSeries++;
        break;
      }
      const { startIdx, values: vals } = unpacked;
      if (startIdx < 0 || startIdx + vals.length > sessLen || vals.length === 0) {
        invalidSeries++;
        break;
      }
      for (const v of vals) {
        if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) {
          invalidSeries++;
          break;
        }
      }
      if (invalidSeries > 0) break;
    }
    if (invalidSeries > 0) {
      errors.push('Invalid series entry or non-positive closing price in closesByIsin');
    }
    if (historyObj.isinCount != null && historyObj.isinCount !== isinEntries.length) {
      errors.push(`isinCount mismatch (${historyObj.isinCount} !== ${isinEntries.length})`);
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  ENCODING_GZIP_BASE64,
  DAILY_ENVELOPE_FORMAT,
  HISTORY_ENVELOPE_FORMAT,
  sha256Hex,
  encodeCompressedJson,
  decodeCompressedJson,
  stripInlineHistoricalPrices,
  buildCompactHistoryPayload,
  extractCompactHistoryFromStocks,
  expandHistoricalPricesForIsin,
  hydrateHistoryMapFromPayload,
  validateCompactHistoryPayload
};
