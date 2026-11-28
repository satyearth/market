'use strict';

/**
 * Official NSE + BSE BhavCopy & Daily Market Archive Downloader
 *
 * - Downloads NSE CM Unified BhavCopy (.csv.zip / .csv) and extracts PKZIP via pure Node zlib.
 * - Downloads BSE CM Unified BhavCopy (.CSV) using host-scoped non-strict HTTP parsing.
 * - Downloads optional supplementary NSE archives (ind_close_all, CM_52_wk_High_low).
 * - Rejects HTML error pages even on HTTP 200 OK, validates headers/rows/TradDt,
 *   writes atomically via .tmp rename, and supports session backfill + polling.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DOWNLOADS_DIR } = require('../config/constants');
const { parseCSVContent } = require('../processing/csv-parser');
const {
  getLatestExpectedTradingDate,
  getPreviousTradingDay,
  getTradingDaysInRange,
  isTradingDay
} = require('../calendar/exchange-calendar');
const { httpGetBuffer, defaultSleep } = require('./http-client');

const DEFAULT_DOWNLOADS_DIR = DOWNLOADS_DIR;
const DEFAULT_MIN_NSE_ROWS = 1000;
const DEFAULT_MIN_BSE_ROWS = 1000;
const DEFAULT_MIN_BYTES = 50000;
const DEFAULT_TIMEOUT_MS = 25000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_DELAY_MS = 1500;
const DEFAULT_RATE_LIMIT_MS = 350;

const REQUIRED_BHAVCOPY_COLS = [
  'TradDt',
  'ISIN',
  'TckrSymb',
  'SctySrs',
  'ClsPric',
  'PrvsClsgPric',
  'TtlTradgVol'
];

function toCompactDate(dateStr) {
  return String(dateStr || '').replace(/-/g, '');
}

function toDdMmYyyy(dateStr) {
  const [yyyy, mm, dd] = String(dateStr || '').split('-');
  return `${dd}${mm}${yyyy}`;
}

function toDdMmYy(dateStr) {
  const [yyyy, mm, dd] = String(dateStr || '').split('-');
  return `${dd}${mm}${String(yyyy || '').slice(-2)}`;
}

function getNseFilename(dateStr) {
  return `BhavCopy_NSE_CM_0_0_0_${toCompactDate(dateStr)}_F_0000.csv`;
}

function getBseFilename(dateStr) {
  return `BhavCopy_BSE_CM_0_0_0_${toCompactDate(dateStr)}_F_0000.CSV`;
}

function getIndicesFilename(dateStr) {
  return `ind_close_all_${toDdMmYyyy(dateStr)}.csv`;
}

function get52WeekFilename(dateStr) {
  return `CM_52_wk_High_low_${toDdMmYyyy(dateStr)}.csv`;
}

function getNsePrFilename(dateStr) {
  return `PR${toDdMmYy(dateStr)}.zip`;
}

function getNseMcapFilename(dateStr) {
  return `mcap${toDdMmYyyy(dateStr)}.csv`;
}

function getNseCorpActionsFilename(dateStr) {
  return `bc${toDdMmYyyy(dateStr)}.csv`;
}

function buildExchangeUrls(dateStr) {
  const compact = toCompactDate(dateStr);
  const ddmmyyyy = toDdMmYyyy(dateStr);
  const ddmmyy = toDdMmYy(dateStr);
  return {
    nseZip: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${compact}_F_0000.csv.zip`,
    nseCsv: `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${compact}_F_0000.csv`,
    bseCsv: `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${compact}_F_0000.CSV`,
    nseIndices: `https://nsearchives.nseindia.com/content/indices/ind_close_all_${ddmmyyyy}.csv`,
    nse52Week: `https://nsearchives.nseindia.com/content/CM_52_wk_High_low_${ddmmyyyy}.csv`,
    nsePrZip: `https://nsearchives.nseindia.com/archives/equities/bhavcopy/pr/PR${ddmmyy}.zip`
  };
}

/**
 * Extracts a matching entry (or the first entry) from a PKZIP Buffer using pure Node zlib.
 */
function extractEntryFromZipBuffer(zipBuf, filenameMatcher = null) {
  if (!Buffer.isBuffer(zipBuf) || zipBuf.length < 30) {
    throw new Error('ZIP buffer is empty or truncated');
  }
  const localSig = zipBuf.readUInt32LE(0);
  if (localSig !== 0x04034b50) {
    throw new Error('Response is not a valid PKZIP archive');
  }

  let method = null;
  let compressedSize = null;
  let localHeaderOffset = 0;

  const eocdOffset = zipBuf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocdOffset >= 0 && eocdOffset + 22 <= zipBuf.length) {
    const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
    const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
    if (filenameMatcher) {
      let pos = cdOffset;
      for (let i = 0; i < totalEntries && pos + 46 <= eocdOffset; i++) {
        if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
        const eMethod = zipBuf.readUInt16LE(pos + 10);
        const eCompSize = zipBuf.readUInt32LE(pos + 20);
        const fnLen = zipBuf.readUInt16LE(pos + 28);
        const exLen = zipBuf.readUInt16LE(pos + 30);
        const commentLen = zipBuf.readUInt16LE(pos + 32);
        const lOffset = zipBuf.readUInt32LE(pos + 42);
        const entryName = zipBuf.toString('utf8', pos + 46, pos + 46 + fnLen);
        pos += 46 + fnLen + exLen + commentLen;
        if (!filenameMatcher(entryName)) continue;
        if (lOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(lOffset) !== 0x04034b50) {
          throw new Error(`Invalid local header for ZIP entry ${entryName}`);
        }
        const lFnLen = zipBuf.readUInt16LE(lOffset + 26);
        const lExLen = zipBuf.readUInt16LE(lOffset + 28);
        const dStart = lOffset + 30 + lFnLen + lExLen;
        if (eCompSize === 0) return '';
        if (dStart + eCompSize > zipBuf.length) {
          throw new Error(`Truncated payload for ZIP entry ${entryName}`);
        }
        const payload = zipBuf.subarray(dStart, dStart + eCompSize);
        if (eMethod === 8) return zlib.inflateRawSync(payload).toString('utf8');
        if (eMethod === 0) return payload.toString('utf8');
        throw new Error(`Unsupported ZIP compression method: ${eMethod}`);
      }
      throw new Error('Requested entry not found inside PKZIP archive');
    }

    if (cdOffset + 46 <= zipBuf.length && zipBuf.readUInt32LE(cdOffset) === 0x02014b50) {
      method = zipBuf.readUInt16LE(cdOffset + 10);
      compressedSize = zipBuf.readUInt32LE(cdOffset + 20);
      localHeaderOffset = zipBuf.readUInt32LE(cdOffset + 42);
    }
  } else if (filenameMatcher) {
    throw new Error('Missing ZIP central directory for entry lookup');
  }

  if (localHeaderOffset + 30 > zipBuf.length || zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
    throw new Error('Invalid ZIP local file header');
  }

  if (method === null) {
    method = zipBuf.readUInt16LE(localHeaderOffset + 8);
    compressedSize = zipBuf.readUInt32LE(localHeaderOffset + 18);
  }

  const fnLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
  const exLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + fnLen + exLen;

  if (!compressedSize || dataStart + compressedSize > zipBuf.length) {
    const cdStart = zipBuf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
    if (cdStart > dataStart) {
      compressedSize = cdStart - dataStart;
    } else {
      throw new Error('Corrupted or truncated ZIP entry payload');
    }
  }

  const compressedPayload = zipBuf.subarray(dataStart, dataStart + compressedSize);
  let outBuf;
  if (method === 8) {
    outBuf = zlib.inflateRawSync(compressedPayload);
  } else if (method === 0) {
    outBuf = compressedPayload;
  } else {
    throw new Error(`Unsupported ZIP compression method: ${method}`);
  }

  return outBuf.toString('utf8');
}

function extractCsvFromZipBuffer(zipBuf) {
  return extractEntryFromZipBuffer(zipBuf, null);
}

function looksLikeHtml(text) {
  const sample = String(text || '').trimStart().slice(0, 600).toLowerCase();
  return (
    sample.startsWith('<') ||
    sample.includes('<!doctype') ||
    sample.includes('<html') ||
    sample.includes('<head') ||
    sample.includes('<body') ||
    sample.includes('access denied')
  );
}

function validateBhavcopyCsvContent(content, expectedDate, options = {}) {
  const minRows = options.minRows ?? DEFAULT_MIN_NSE_ROWS;
  const minBytes = options.minBytes ?? DEFAULT_MIN_BYTES;

  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') < minBytes) {
    return {
      ok: false,
      code: 'TOO_SMALL',
      error: `CSV content too small (${Buffer.byteLength(String(content || ''), 'utf8')} bytes < ${minBytes} min)`
    };
  }

  if (looksLikeHtml(content)) {
    return {
      ok: false,
      code: 'HTML_RESPONSE',
      error: 'Received HTML page instead of CSV (exchange likely returned error or holiday page)'
    };
  }

  const lines = content.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, code: 'EMPTY_CSV', error: 'CSV contains no data rows' };
  }

  const header = lines[0].split(',').map(h => h.trim());
  const missingCols = REQUIRED_BHAVCOPY_COLS.filter(c => !header.includes(c));
  if (missingCols.length > 0) {
    return {
      ok: false,
      code: 'INVALID_SCHEMA',
      error: `CSV missing required BhavCopy columns: ${missingCols.join(', ')}`
    };
  }

  const rowCount = lines.length - 1;
  if (rowCount < minRows) {
    return {
      ok: false,
      code: 'TRUNCATED_CSV',
      error: `CSV has only ${rowCount} rows (expected at least ${minRows})`
    };
  }

  const tradDtIdx = header.indexOf('TradDt');
  const firstRowCols = lines[1].split(',');
  const csvDate = (firstRowCols[tradDtIdx] || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(csvDate)) {
    return {
      ok: false,
      code: 'INVALID_DATE_VALUE',
      error: `Invalid TradDt value in CSV: "${csvDate}"`
    };
  }

  if (expectedDate && csvDate !== expectedDate) {
    return {
      ok: false,
      code: 'DATE_MISMATCH',
      error: `Trading date mismatch in CSV: expected ${expectedDate}, got ${csvDate}`,
      csvDate
    };
  }

  return { ok: true, rowCount, tradingDate: csvDate };
}

function validateBhavcopyFile(filePath, expectedDate, options = {}) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, code: 'NOT_FOUND', error: 'File does not exist' };
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      return { ok: false, code: 'EMPTY_FILE', error: 'File is empty' };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return validateBhavcopyCsvContent(content, expectedDate, options);
  } catch (err) {
    return { ok: false, code: 'READ_ERROR', error: err.message };
  }
}

function validateIndicesCsvContent(content, expectedDate) {
  if (typeof content !== 'string' || content.trim().length < 100) {
    return { ok: false, error: 'Indices CSV is empty or too short' };
  }
  if (looksLikeHtml(content)) {
    return { ok: false, error: 'Indices response is HTML' };
  }
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 3 || !lines[0].includes('Index Name') || !lines[0].includes('Closing Index Value')) {
    return { ok: false, error: 'Indices CSV missing expected headers' };
  }
  if (expectedDate) {
    const expectedDdMmYyyy = toDdMmYyyy(expectedDate);
    const expectedDash = `${expectedDdMmYyyy.slice(0, 2)}-${expectedDdMmYyyy.slice(2, 4)}-${expectedDdMmYyyy.slice(4, 8)}`;
    const hasMatchingRow = lines.slice(1).some(l => l.includes(expectedDash));
    if (!hasMatchingRow) {
      return { ok: false, error: `Indices CSV does not contain date ${expectedDash}` };
    }
  }
  return { ok: true };
}

function validate52WeekCsvContent(content, expectedDate) {
  if (typeof content !== 'string' || content.trim().length < 80) {
    return { ok: false, error: '52W High/Low CSV is empty or too short' };
  }
  if (looksLikeHtml(content)) {
    return { ok: false, error: '52W High/Low response is HTML' };
  }
  const lines = content.trim().split(/\r?\n/);
  if (lines.length < 4 || !content.includes('Adjusted_52_Week_High') || !content.includes('Adjusted_52_Week_Low')) {
    return { ok: false, error: '52W High/Low CSV missing expected columns or data rows' };
  }
  if (expectedDate) {
    const [y, m, d] = expectedDate.split('-').map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const expectedTag = `${String(d).padStart(2, '0')}-${months[m - 1]}-${y}`;
    if (!content.slice(0, 500).includes(expectedTag)) {
      return { ok: false, error: `52W High/Low effective date mismatch (expected ${expectedTag})` };
    }
  }
  return { ok: true };
}

function validateNseMcapCsvContent(content, expectedDate) {
  if (typeof content !== 'string' || content.trim().length < 50) {
    return { ok: false, error: 'NSE Market Cap CSV is empty or too short' };
  }
  if (looksLikeHtml(content)) {
    return { ok: false, error: 'NSE Market Cap response is HTML' };
  }
  const normalized = content.replace(/^\uFEFF/, '').trim();
  const lines = normalized.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    return { ok: false, error: 'NSE Market Cap CSV missing data rows' };
  }
  const hasRequiredCols = normalized.includes('Symbol')
    && normalized.includes('Issue Size')
    && normalized.includes('Market Cap');
  if (!hasRequiredCols) {
    return { ok: false, error: 'NSE Market Cap CSV missing required columns (Symbol, Issue Size, Market Cap)' };
  }
  if (expectedDate) {
    const [y, m, d] = expectedDate.split('-').map(Number);
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const ddMmmYyyySpace = `${String(d).padStart(2, '0')} ${months[m - 1]} ${y}`;
    const ddMmmYyyyDash = `${String(d).padStart(2, '0')}-${months[m - 1]}-${y}`;
    const ddMmYyyySlash = `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
    const firstDataCols = lines[1].split(',');
    const tradeDateCell = (firstDataCols[0] || '').trim().toUpperCase();
    const headerUpper = lines[0].toUpperCase();
    const matchesDataRow = tradeDateCell.includes(ddMmmYyyySpace)
      || tradeDateCell.includes(ddMmmYyyyDash)
      || tradeDateCell.includes(ddMmYyyySlash)
      || tradeDateCell.includes(expectedDate);
    if (headerUpper.startsWith('TRADE DATE') && !matchesDataRow) {
      return { ok: false, error: `NSE Market Cap CSV trade date mismatch (expected ${ddMmmYyyySpace}, got "${tradeDateCell}")` };
    }
  }
  return { ok: true };
}

async function defaultHttpGet(url, options = {}) {
  try {
    const res = await httpGetBuffer(url, options);
    return {
      ok: res.statusCode >= 200 && res.statusCode < 300,
      statusCode: res.statusCode,
      headers: res.headers || {},
      buffer: res.body,
      url
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: 0,
      headers: {},
      buffer: Buffer.alloc(0),
      error: err.message,
      errorCode: err.code || 'NETWORK_ERROR'
    };
  }
}

function atomicWriteFile(destPath, content) {
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    const stat = fs.statSync(tmpPath);
    if (stat.size === 0) {
      throw new Error('Refusing to commit 0-byte file');
    }
    fs.renameSync(tmpPath, destPath);
    return stat.size;
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw err;
  }
}

function cleanupTempFiles(downloadsDir = DEFAULT_DOWNLOADS_DIR) {
  if (!fs.existsSync(downloadsDir)) return [];
  const removed = [];
  for (const name of fs.readdirSync(downloadsDir)) {
    if (/\.tmp(\.\d+)*$/i.test(name) || /\.csv\.tmp/i.test(name)) {
      const fullPath = path.join(downloadsDir, name);
      try {
        fs.unlinkSync(fullPath);
        removed.push(name);
      } catch (_) {}
    }
  }
  return removed;
}

function createDownloader(config = {}) {
  const downloadsDir = config.downloadsDir || DEFAULT_DOWNLOADS_DIR;
  const httpGet = config.httpGet || defaultHttpGet;
  const sleep = config.sleep || defaultSleep;
  const minNseRows = config.minNseRows ?? DEFAULT_MIN_NSE_ROWS;
  const minBseRows = config.minBseRows ?? DEFAULT_MIN_BSE_ROWS;
  const minBytes = config.minBytes ?? DEFAULT_MIN_BYTES;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const rateLimitMs = config.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const urlBuilder = config.urlBuilder || buildExchangeUrls;
  const logger = config.logger || console;

  let lastRequestAt = 0;

  async function paceRequest() {
    if (rateLimitMs <= 0) return;
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < rateLimitMs) {
      await sleep(rateLimitMs - elapsed);
    }
    lastRequestAt = Date.now();
  }

  function computeRetryDelay(attempt, res) {
    const retryAfter = res?.headers?.['retry-after'] || res?.headers?.['Retry-After'];
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds > 0) {
        return Math.min(seconds * 1000, 60000);
      }
    }
    return Math.min(baseDelayMs * Math.pow(2, attempt - 1), 30000);
  }

  function isRetryableFailure(res) {
    if (!res) return true;
    if (res.statusCode === 404 || res.statusCode === 410) return false;
    if (res.statusCode === 403 || res.statusCode === 408 || res.statusCode === 429 || res.statusCode >= 500) return true;
    if (res.statusCode === 0) return true;
    return false;
  }

  async function fetchWithRetry(label, url, headers = {}) {
    let lastRes = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await paceRequest();
      const res = await httpGet(url, { timeoutMs, headers });
      lastRes = res;

      if (res.ok) return { ...res, attempts: attempt };

      const retryable = isRetryableFailure(res);
      const reason = res.error || `HTTP ${res.statusCode}`;
      if (!retryable || attempt >= maxAttempts) {
        return {
          ...res,
          ok: false,
          attempts: attempt,
          error: `${label} failed (${reason})`
        };
      }

      const delay = computeRetryDelay(attempt, res);
      logger.warn(`    [${label}] Attempt ${attempt}/${maxAttempts} failed (${reason}). Backing off ${delay}ms...`);
      await sleep(delay);
    }
    return { ...(lastRes || {}), ok: false, error: `${label} exhausted retries` };
  }

  async function downloadNseBhavcopy(dateStr, opts = {}) {
    const fileName = getNseFilename(dateStr);
    const filePath = path.join(downloadsDir, fileName);

    if (!opts.force) {
      const existing = validateBhavcopyFile(filePath, dateStr, { minRows: minNseRows, minBytes });
      if (existing.ok) {
        return {
          ok: true,
          exchange: 'NSE',
          date: dateStr,
          filePath,
          fileName,
          source: 'cached',
          skipped: true,
          rowCount: existing.rowCount
        };
      }
      if (fs.existsSync(filePath)) {
        logger.warn(`    [NSE ${dateStr}] Existing cached file failed validation (${existing.error}); re-downloading safely.`);
      }
    }

    const urls = urlBuilder(dateStr);
    const candidates = [
      { url: urls.nseZip, kind: 'zip', headers: { Referer: 'https://www.nseindia.com/' } },
      { url: urls.nseCsv, kind: 'csv', headers: { Referer: 'https://www.nseindia.com/' } }
    ];

    let lastFailure = null;
    for (const candidate of candidates) {
      if (!candidate.url) continue;
      const res = await fetchWithRetry(`NSE-${dateStr}`, candidate.url, candidate.headers);

      if (!res.ok) {
        lastFailure = {
          ok: false,
          exchange: 'NSE',
          date: dateStr,
          statusCode: res.statusCode,
          notPublished: res.statusCode === 404,
          error: res.error,
          filePath
        };
        if (res.statusCode === 403 || res.statusCode === 429) {
          break;
        }
        continue;
      }

      const contentType = String(res.headers['content-type'] || '').toLowerCase();
      if (contentType.includes('text/html')) {
        lastFailure = {
          ok: false,
          exchange: 'NSE',
          date: dateStr,
          statusCode: res.statusCode,
          notPublished: true,
          error: `NSE returned HTML content-type (${contentType}) instead of BhavCopy`,
          filePath
        };
        continue;
      }

      let csvContent;
      try {
        if (candidate.kind === 'zip') {
          if (looksLikeHtml(res.buffer.toString('utf8', 0, 500))) {
            throw new Error('ZIP URL returned HTML error page');
          }
          csvContent = extractCsvFromZipBuffer(res.buffer);
        } else {
          csvContent = res.buffer.toString('utf8');
        }
      } catch (err) {
        lastFailure = {
          ok: false,
          exchange: 'NSE',
          date: dateStr,
          statusCode: res.statusCode,
          error: `Failed to unpack NSE ${candidate.kind}: ${err.message}`,
          filePath
        };
        continue;
      }

      const validation = validateBhavcopyCsvContent(csvContent, dateStr, { minRows: minNseRows, minBytes });
      if (!validation.ok) {
        lastFailure = {
          ok: false,
          exchange: 'NSE',
          date: dateStr,
          statusCode: res.statusCode,
          notPublished: validation.code === 'HTML_RESPONSE',
          error: `NSE validation failed (${validation.code}): ${validation.error}`,
          filePath
        };
        if (validation.code === 'DATE_MISMATCH') {
          break;
        }
        continue;
      }

      const bytes = atomicWriteFile(filePath, csvContent);
      return {
        ok: true,
        exchange: 'NSE',
        date: dateStr,
        filePath,
        fileName,
        bytes,
        rowCount: validation.rowCount,
        source: `https-nse-${candidate.kind}`,
        skipped: false
      };
    }

    return lastFailure || {
      ok: false,
      exchange: 'NSE',
      date: dateStr,
      error: `NSE BhavCopy unavailable for ${dateStr}`,
      filePath
    };
  }

  async function downloadBseBhavcopy(dateStr, opts = {}) {
    const fileName = getBseFilename(dateStr);
    const filePath = path.join(downloadsDir, fileName);

    if (!opts.force) {
      const existing = validateBhavcopyFile(filePath, dateStr, { minRows: minBseRows, minBytes });
      if (existing.ok) {
        return {
          ok: true,
          exchange: 'BSE',
          date: dateStr,
          filePath,
          fileName,
          source: 'cached',
          skipped: true,
          rowCount: existing.rowCount
        };
      }
      if (fs.existsSync(filePath)) {
        logger.warn(`    [BSE ${dateStr}] Existing cached file failed validation (${existing.error}); re-downloading safely.`);
      }
    }

    const urls = urlBuilder(dateStr);
    const res = await fetchWithRetry(`BSE-${dateStr}`, urls.bseCsv, {
      Referer: 'https://www.bseindia.com/markets/MarketInfo/BhavCopy.aspx'
    });

    if (!res.ok) {
      return {
        ok: false,
        exchange: 'BSE',
        date: dateStr,
        statusCode: res.statusCode,
        notPublished: res.statusCode === 404,
        error: res.error,
        filePath
      };
    }

    const contentType = String(res.headers['content-type'] || '').toLowerCase();
    const csvContent = res.buffer.toString('utf8');
    if (contentType.includes('text/html') || looksLikeHtml(csvContent)) {
      return {
        ok: false,
        exchange: 'BSE',
        date: dateStr,
        statusCode: res.statusCode,
        notPublished: true,
        error: `BSE returned HTML error page instead of CSV (status ${res.statusCode})`,
        filePath
      };
    }

    const validation = validateBhavcopyCsvContent(csvContent, dateStr, { minRows: minBseRows, minBytes });
    if (!validation.ok) {
      return {
        ok: false,
        exchange: 'BSE',
        date: dateStr,
        statusCode: res.statusCode,
        error: `BSE validation failed: ${validation.error}`,
        filePath
      };
    }

    const bytes = atomicWriteFile(filePath, csvContent);
    return {
      ok: true,
      exchange: 'BSE',
      date: dateStr,
      filePath,
      fileName,
      bytes,
      rowCount: validation.rowCount,
      source: 'https-bse-csv',
      skipped: false
    };
  }

  async function downloadSupplementaryData(dateStr, opts = {}) {
    const urls = urlBuilder(dateStr);
    const outcomes = { indices: null, week52: null, mcap: null, corpActions: null };

    if (urls.nseIndices) {
      const idxPath = path.join(downloadsDir, getIndicesFilename(dateStr));
      if (!opts.force && fs.existsSync(idxPath) && validateIndicesCsvContent(fs.readFileSync(idxPath, 'utf8'), dateStr).ok) {
        outcomes.indices = { ok: true, filePath: idxPath, source: 'cached' };
      } else {
        const res = await fetchWithRetry(`NSE-IND-${dateStr}`, urls.nseIndices, { Referer: 'https://www.nseindia.com/' });
        if (res.ok) {
          const text = res.buffer.toString('utf8');
          if (validateIndicesCsvContent(text, dateStr).ok) {
            atomicWriteFile(idxPath, text);
            outcomes.indices = { ok: true, filePath: idxPath, source: 'https-nse-indices' };
          }
        }
      }
    }

    if (urls.nse52Week) {
      const w52Path = path.join(downloadsDir, get52WeekFilename(dateStr));
      if (!opts.force && fs.existsSync(w52Path) && validate52WeekCsvContent(fs.readFileSync(w52Path, 'utf8'), dateStr).ok) {
        outcomes.week52 = { ok: true, filePath: w52Path, source: 'cached' };
      } else {
        const res = await fetchWithRetry(`NSE-52W-${dateStr}`, urls.nse52Week, { Referer: 'https://www.nseindia.com/' });
        if (res.ok) {
          const text = res.buffer.toString('utf8');
          if (validate52WeekCsvContent(text, dateStr).ok) {
            atomicWriteFile(w52Path, text);
            outcomes.week52 = { ok: true, filePath: w52Path, source: 'https-nse-52week' };
          }
        }
      }
    }

    if (urls.nsePrZip) {
      const mcapName = getNseMcapFilename(dateStr);
      const mcapPath = path.join(downloadsDir, mcapName);
      const bcName = getNseCorpActionsFilename(dateStr);
      const bcPath = path.join(downloadsDir, bcName);
      if (!opts.force && fs.existsSync(mcapPath) && validateNseMcapCsvContent(fs.readFileSync(mcapPath, 'utf8'), dateStr).ok) {
        outcomes.mcap = { ok: true, filePath: mcapPath, source: 'cached' };
      } else {
        const res = await fetchWithRetry(`NSE-PR-${dateStr}`, urls.nsePrZip, { Referer: 'https://www.nseindia.com/' });
        if (res.ok && !looksLikeHtml(res.buffer.toString('utf8', 0, 500))) {
          try {
            const mcapCsv = extractEntryFromZipBuffer(
              res.buffer,
              name => name.toLowerCase() === mcapName.toLowerCase()
            );
            if (validateNseMcapCsvContent(mcapCsv, dateStr).ok) {
              atomicWriteFile(mcapPath, mcapCsv);
              outcomes.mcap = { ok: true, filePath: mcapPath, source: 'https-nse-pr-mcap' };
            }
          } catch (_) {}
          try {
            const bcCsv = extractEntryFromZipBuffer(
              res.buffer,
              name => name.toLowerCase() === bcName.toLowerCase()
            );
            if (bcCsv && !looksLikeHtml(bcCsv) && bcCsv.toUpperCase().includes('SYMBOL')) {
              atomicWriteFile(bcPath, bcCsv);
              outcomes.corpActions = { ok: true, filePath: bcPath, source: 'https-nse-pr-bc' };
            }
          } catch (_) {}
        }
      }
    }

    return outcomes;
  }

  async function downloadSession(dateStr, opts = {}) {
    cleanupTempFiles(downloadsDir);

    if (!isTradingDay(dateStr) && !opts.allowNonTradingDay) {
      return {
        date: dateStr,
        bothOk: false,
        skippedNonTradingDay: true,
        error: `${dateStr} is not a trading day (weekend or exchange holiday)`,
        nse: { ok: false, error: 'Non-trading day' },
        bse: { ok: false, error: 'Non-trading day' }
      };
    }

    logger.log(`  Checking/downloading session ${dateStr}...`);
    const [nse, bse] = await Promise.all([
      downloadNseBhavcopy(dateStr, opts),
      downloadBseBhavcopy(dateStr, opts)
    ]);

    let supplementary = null;
    if (opts.includeSupplementary !== false && nse.ok && bse.ok) {
      supplementary = await downloadSupplementaryData(dateStr, opts);
    }

    const bothOk = Boolean(nse.ok && bse.ok);
    const pendingPublication = Boolean((!nse.ok && nse.notPublished) || (!bse.ok && bse.notPublished));

    if (bothOk) {
      logger.log(`  Session ${dateStr} ready (NSE: ${nse.source}, BSE: ${bse.source})`);
    } else {
      const errs = [!nse.ok ? `NSE=${nse.error}` : null, !bse.ok ? `BSE=${bse.error}` : null].filter(Boolean).join(' | ');
      logger.warn(`  Session ${dateStr} incomplete: ${errs}`);
    }

    return { date: dateStr, nse, bse, bothOk, pendingPublication, supplementary };
  }

  function isRecoverableSessionResult(res) {
    if (!res || res.bothOk) return false;
    if (res.skippedNonTradingDay) return false;
    if (res.pendingPublication) return true;
    for (const ex of [res.nse, res.bse]) {
      if (!ex || ex.ok) continue;
      if (ex.notPublished) return true;
      if (ex.statusCode === 0 || ex.statusCode === 403 || ex.statusCode === 404 || ex.statusCode === 408 || ex.statusCode === 429 || ex.statusCode >= 500) {
        return true;
      }
    }
    return false;
  }

  async function waitForSessionPublication(dateStr, opts = {}) {
    const maxWaitMs = opts.maxWaitMs ?? 120000;
    const basePollMs = opts.pollIntervalMs ?? 15000;
    const maxPollMs = opts.maxPollIntervalMs ?? Math.max(basePollMs, 120000);
    const backoffFactor = opts.backoffFactor ?? 1.5;
    const start = Date.now();
    let attempt = 0;

    while (true) {
      attempt++;
      const res = await downloadSession(dateStr, opts);
      if (res.bothOk) return { ...res, pollAttempts: attempt };

      const elapsed = Date.now() - start;
      const remainingMs = maxWaitMs - elapsed;
      const recoverable = isRecoverableSessionResult(res);
      if (!recoverable || remainingMs <= 0 || basePollMs <= 0) {
        return { ...res, pollAttempts: attempt, timedOutWaiting: recoverable };
      }

      const nextDelayMs = Math.min(
        Math.round(basePollMs * Math.pow(backoffFactor, attempt - 1)),
        maxPollMs,
        remainingMs
      );
      if (nextDelayMs <= 0) {
        return { ...res, pollAttempts: attempt, timedOutWaiting: recoverable };
      }

      logger.log(`  Delayed/transient BhavCopy for ${dateStr} (poll ${attempt}). Waiting ${Math.round(nextDelayMs / 1000)}s before retry...`);
      await sleep(nextDelayMs);
    }
  }

  function inspectStoredSessions() {
    if (!fs.existsSync(downloadsDir)) {
      return {
        nseDates: [],
        bseDates: [],
        completeDates: [],
        latestNseDate: null,
        latestBseDate: null,
        latestCompleteDate: null
      };
    }

    const files = fs.readdirSync(downloadsDir);
    const nseDates = [];
    const bseDates = [];

    for (const file of files) {
      const nMatch = file.match(/^BhavCopy_NSE_CM_0_0_0_(\d{8})_F_0000\.csv$/);
      if (nMatch) {
        const d = `${nMatch[1].slice(0, 4)}-${nMatch[1].slice(4, 6)}-${nMatch[1].slice(6, 8)}`;
        if (validateBhavcopyFile(path.join(downloadsDir, file), d, { minRows: minNseRows, minBytes }).ok) {
          nseDates.push(d);
        }
      }
      const bMatch = file.match(/^BhavCopy_BSE_CM_0_0_0_(\d{8})_F_0000\.CSV$/);
      if (bMatch) {
        const d = `${bMatch[1].slice(0, 4)}-${bMatch[1].slice(4, 6)}-${bMatch[1].slice(6, 8)}`;
        if (validateBhavcopyFile(path.join(downloadsDir, file), d, { minRows: minBseRows, minBytes }).ok) {
          bseDates.push(d);
        }
      }
    }

    nseDates.sort();
    bseDates.sort();
    const bseSet = new Set(bseDates);
    const completeDates = nseDates.filter(d => bseSet.has(d));

    return {
      nseDates,
      bseDates,
      completeDates,
      latestNseDate: nseDates[nseDates.length - 1] || null,
      latestBseDate: bseDates[bseDates.length - 1] || null,
      latestCompleteDate: completeDates[completeDates.length - 1] || null
    };
  }

  function findMissingSessions(expectedDate, fromDate = null) {
    const stored = inspectStoredSessions();
    const completeSet = new Set(stored.completeDates);

    let startDate = fromDate || stored.latestCompleteDate;
    if (!startDate) {
      const d = new Date(`${expectedDate}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() - 14);
      startDate = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }

    const sixDaysCheckStart = (() => {
      let c = expectedDate;
      for (let i = 0; i < 6; i++) c = getPreviousTradingDay(c);
      return c;
    })();
    if (sixDaysCheckStart < startDate) {
      startDate = sixDaysCheckStart;
    }

    const candidates = getTradingDaysInRange(startDate, expectedDate, !fromDate && !stored.latestCompleteDate);
    return candidates
      .filter(dt => !completeSet.has(dt))
      .map(dt => {
        const nsePath = path.join(downloadsDir, getNseFilename(dt));
        const bsePath = path.join(downloadsDir, getBseFilename(dt));
        return {
          date: dt,
          missingNse: !validateBhavcopyFile(nsePath, dt, { minRows: minNseRows, minBytes }).ok,
          missingBse: !validateBhavcopyFile(bsePath, dt, { minRows: minBseRows, minBytes }).ok
        };
      });
  }

  async function backfillSessions(expectedDate, opts = {}) {
    const missing = findMissingSessions(expectedDate, opts.fromDate || null);
    if (missing.length === 0) {
      logger.log('[Backfill] All trading sessions in range are already downloaded and validated.');
      return { ok: true, totalMissing: 0, downloaded: [], failed: [] };
    }

    logger.log(`[Backfill] Found ${missing.length} missing session(s): ${missing.map(m => m.date).join(', ')}`);
    const downloaded = [];
    const failed = [];

    for (const entry of missing) {
      const res = await downloadSession(entry.date, opts);
      if (res.bothOk) downloaded.push(res);
      else failed.push(res);
    }

    return {
      ok: failed.length === 0,
      totalMissing: missing.length,
      downloaded,
      failed
    };
  }

  return {
    downloadNseBhavcopy,
    downloadBseBhavcopy,
    downloadSupplementaryData,
    downloadSession,
    waitForSessionPublication,
    inspectStoredSessions,
    findMissingSessions,
    backfillSessions,
    cleanupTempFiles
  };
}

const defaultDownloader = createDownloader();

module.exports = {
  DEFAULT_DOWNLOADS_DIR,
  REQUIRED_BHAVCOPY_COLS,
  createDownloader,
  extractEntryFromZipBuffer,
  extractCsvFromZipBuffer,
  validateBhavcopyCsvContent,
  validateBhavcopyFile,
  validateIndicesCsvContent,
  validate52WeekCsvContent,
  validateNseMcapCsvContent,
  atomicWriteFile,
  cleanupTempFiles,
  buildExchangeUrls,
  getNseFilename,
  getBseFilename,
  getIndicesFilename,
  get52WeekFilename,
  getNsePrFilename,
  getNseMcapFilename,
  getNseCorpActionsFilename,
  looksLikeHtml,
  ...defaultDownloader
};
