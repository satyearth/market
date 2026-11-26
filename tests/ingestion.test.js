'use strict';

const assert = require('assert');
const zlib = require('zlib');
const {
  isTradingDay,
  getPreviousTradingDay,
  getRecentTradingSessions,
  checkSessionFreshness
} = require('../src/calendar/exchange-calendar');
const {
  extractCsvFromZipBuffer,
  validateBhavcopyCsvContent,
  validateIndicesCsvContent,
  validate52WeekCsvContent,
  createDownloader
} = require('../src/ingestion/bhavcopy-downloader');
const { shouldUseInsecureHttpParser } = require('../src/ingestion/http-client');

function buildMinimalZip(filename, textContent) {
  const payload = zlib.deflateRawSync(Buffer.from(textContent, 'utf8'));
  const nameBuf = Buffer.from(filename, 'utf8');
  const local = Buffer.alloc(30 + nameBuf.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(Buffer.byteLength(textContent), 22);
  local.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(local, 30);

  const cd = Buffer.alloc(46 + nameBuf.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(payload.length, 20);
  cd.writeUInt32LE(Buffer.byteLength(textContent), 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  nameBuf.copy(cd, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length + payload.length, 16);

  return Buffer.concat([local, payload, cd, eocd]);
}

async function run() {
  // 1. Exchange calendar tests
  assert.strictEqual(isTradingDay('2026-11-25'), true);
  assert.strictEqual(isTradingDay('2026-11-24'), false, 'Guru Nanak Jayanti holiday must be non-trading');
  assert.strictEqual(isTradingDay('2026-11-08'), true, 'Muhurat Sunday session must be trading day');
  assert.strictEqual(getPreviousTradingDay('2026-11-25'), '2026-11-23');
  const six = getRecentTradingSessions('2026-11-25', 6);
  assert.strictEqual(six.length, 6);
  assert.strictEqual(six[six.length - 1], '2026-11-25');

  const preCloseFresh = checkSessionFreshness('2026-11-23', new Date('2026-11-25T05:00:00Z')); // 10:30 IST
  assert.strictEqual(preCloseFresh.isFresh, true);

  // 2. Host-scoped insecureHTTPParser strictly for BSE
  assert.strictEqual(shouldUseInsecureHttpParser(new URL('https://www.bseindia.com/foo')), true);
  assert.strictEqual(shouldUseInsecureHttpParser(new URL('https://nsearchives.nseindia.com/foo')), false);

  // 3. ZIP extract + CSV validator (reject HTML / bad date / missing columns)
  const sampleCsv = [
    'TradDt,ISIN,TckrSymb,SctySrs,ClsPric,PrvsClsgPric,TtlTradgVol',
    '2026-11-25,INE002A01018,RELIANCE,EQ,1300.5,1290.0,1500000'
  ].join('\n');
  const zipBuf = buildMinimalZip('test.csv', sampleCsv);
  const extracted = extractCsvFromZipBuffer(zipBuf);
  assert.strictEqual(extracted, sampleCsv);

  assert.strictEqual(validateBhavcopyCsvContent('<html><body>Error</body></html>', '2026-11-25', { minRows: 1, minBytes: 10 }).code, 'HTML_RESPONSE');
  assert.strictEqual(validateBhavcopyCsvContent(sampleCsv.replace('2026-11-25', '2026-11-23'), '2026-11-25', { minRows: 1, minBytes: 10 }).code, 'DATE_MISMATCH');
  assert.strictEqual(validateBhavcopyCsvContent(sampleCsv, '2026-11-25', { minRows: 1, minBytes: 10 }).ok, true);

  // 4. Mocked HTTP 429 retry + non-trading skip
  let calls = 0;
  const downloader = createDownloader({
    minNseRows: 1,
    minBseRows: 1,
    minBytes: 10,
    rateLimitMs: 0,
    baseDelayMs: 1,
    sleep: async () => {},
    httpGet: async () => {
      calls++;
      if (calls === 1) return { ok: false, statusCode: 429, headers: { 'retry-after': '0' }, buffer: Buffer.alloc(0) };
      return { ok: true, statusCode: 200, headers: { 'content-type': 'application/zip' }, buffer: zipBuf };
    }
  });

  const nonTrading = await downloader.downloadSession('2026-11-24');
  assert.strictEqual(nonTrading.skippedNonTradingDay, true);

  // 5. Supplementary CSV validation
  assert.strictEqual(validateIndicesCsvContent('<html>blocked</html>', '2026-11-25').ok, false);
  assert.strictEqual(validate52WeekCsvContent('too short', '2026-11-25').ok, false);
}

module.exports = { name: 'ingestion.test.js', run };
