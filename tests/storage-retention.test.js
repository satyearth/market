'use strict';

const assert = require('assert');
const { createStorageClient, isSafeDatasetPrunePath, isObjectNotFoundResponse } = require('../src/storage/supabase-storage');
const { isTradingDay } = require('../src/calendar/exchange-calendar');

function createMockSupabase(initialObjects = {}) {
  const objects = new Map(Object.entries(initialObjects));
  const deletedPaths = [];
  let failNextLatestSwap = false;
  let corruptReadbackOnce = false;

  async function httpRequest(url, options = {}) {
    const parsed = new URL(url);
    const method = (options.method || 'GET').toUpperCase();
    const parts = parsed.pathname.split('/');
    // /storage/v1/object/list/<bucket>
    if (parts[4] === 'list' && method === 'POST') {
      const req = JSON.parse(Buffer.from(options.body || '{}').toString('utf8'));
      const prefix = req.prefix || '';
      const limit = req.limit || 100;
      const offset = req.offset || 0;
      const seenFolders = new Set();
      const items = [];

      for (const [k, v] of objects.entries()) {
        if (prefix && !k.startsWith(prefix + '/')) continue;
        const rest = prefix ? k.slice(prefix.length + 1) : k;
        if (!rest) continue;
        if (rest.includes('/')) {
          const folder = rest.split('/')[0];
          if (!seenFolders.has(folder)) {
            seenFolders.add(folder);
            items.push({ name: folder, id: null, metadata: null });
          }
        } else {
          items.push({ name: rest, id: `id-${rest}`, metadata: { size: Buffer.byteLength(v, 'utf8') } });
        }
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      return {
        ok: true,
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify(items.slice(offset, offset + limit)), 'utf8')
      };
    }

    // /storage/v1/object/<bucket> (batch DELETE)
    if (parts.length === 5 && parts[3] === 'object' && method === 'DELETE') {
      const req = JSON.parse(Buffer.from(options.body || '{}').toString('utf8'));
      for (const p of req.prefixes || []) {
        deletedPaths.push(p);
        objects.delete(p);
      }
      return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('[]') };
    }

    // Object path after bucket
    const isAuthGet = parts[4] === 'authenticated' || parts[4] === 'public';
    const objPath = decodeURIComponent(parts.slice(isAuthGet ? 6 : 5).join('/'));

    if (method === 'GET') {
      if (!objects.has(objPath)) {
        return { ok: false, statusCode: 404, headers: {}, body: Buffer.from('Not Found') };
      }
      let text = objects.get(objPath);
      if (corruptReadbackOnce && objPath.startsWith('datasets/')) {
        corruptReadbackOnce = false;
        text = text.replace('STOCK_A', 'CORRUPTED');
      }
      return { ok: true, statusCode: 200, headers: {}, body: Buffer.from(text, 'utf8') };
    }

    if (method === 'POST') {
      if (failNextLatestSwap && objPath === 'latest.json') {
        failNextLatestSwap = false;
        return { ok: false, statusCode: 500, headers: {}, body: Buffer.from('Swap failed') };
      }
      objects.set(objPath, Buffer.from(options.body || '').toString('utf8'));
      return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
    }

    if (method === 'DELETE') {
      objects.delete(objPath);
      return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
    }

    return { ok: false, statusCode: 400, headers: {}, body: Buffer.alloc(0) };
  }

  return {
    objects,
    deletedPaths,
    setCorruptReadbackOnce: () => { corruptReadbackOnce = true; },
    setFailNextLatestSwap: () => { failNextLatestSwap = true; },
    client: createStorageClient({
      url: 'https://mock-supabase.local',
      serviceKey: 'mock-service-role',
      bucket: 'mock-bucket',
      maxRetries: 1,
      httpRequest
    })
  };
}

async function run() {
  // 1. Safe path guard
  assert.strictEqual(isSafeDatasetPrunePath('latest.json'), false);
  assert.strictEqual(isSafeDatasetPrunePath('locks/refresh.lock.json'), false);
  assert.strictEqual(isSafeDatasetPrunePath('reference/benchmark_stocks_verified.json'), false);
  assert.strictEqual(isSafeDatasetPrunePath('datasets/2026-11-25/stocks-dataset-2026-11-25-v1.json'), true);

  // 2. Atomic publish, checksum failure rollback, downgrade guard, reference read
  const mock = createMockSupabase({
    'reference/benchmark_stocks_verified.json': JSON.stringify([{ symbol: 'TCS', market_cap_cr: 1400000 }])
  });

  const stats1 = { tradingDate: '2026-11-25', refreshedAtUtc: '2026-11-25T12:00:00.000Z', istDisplayTime: '25 Nov 2026, 17:30:00 IST' };
  const pub1 = await mock.client.publishDatasetToStorage(stats1, [{ isin: 'INE002A01018', symbol: 'STOCK_A' }], { skipRetention: true });
  assert.strictEqual(pub1.ok, true);

  // Checksum corruption leaves latest.json on previous valid version
  mock.setCorruptReadbackOnce();
  const statsBad = { tradingDate: '2026-11-26', refreshedAtUtc: '2026-11-26T12:00:00.000Z', istDisplayTime: '26 Nov 2026, 17:30:00 IST' };
  const badPub = await mock.client.publishDatasetToStorage(statsBad, [{ isin: 'INE002A01018', symbol: 'STOCK_A' }], { skipRetention: true });
  assert.strictEqual(badPub.ok, false);
  assert.strictEqual(badPub.phase, 'verify_checksum');
  const latestAfterBad = await mock.client.fetchLatestManifest();
  assert.strictEqual(latestAfterBad.manifest.tradingDate, '2026-11-25');

  // Downgrade guard
  const downPub = await mock.client.publishDatasetToStorage({ tradingDate: '2026-11-23', refreshedAtUtc: '2026-11-23T12:00:00.000Z' }, [{ isin: 'INE002A01018', symbol: 'STOCK_A' }], { skipRetention: true });
  assert.strictEqual(downPub.downgradeRefused, true);

  // Reference JSON read
  const refRes = await mock.client.downloadReferenceJson('benchmark_stocks_verified.json');
  assert.strictEqual(refRes.ok, true);
  assert.strictEqual(refRes.data[0].symbol, 'TCS');

  // 3. 30-session retention preserves latest 30 trading days + protected paths
  const seed = { 'locks/refresh.lock.json': '{}', 'reference/catalog.json': '[]' };
  const tradingDates = [];
  let cursor = '2026-10-01';
  while (tradingDates.length < 34) {
    if (isTradingDay(cursor)) tradingDates.push(cursor);
    const dt = new Date(`${cursor}T00:00:00Z`);
    dt.setUTCDate(dt.getUTCDate() + 1);
    cursor = dt.toISOString().slice(0, 10);
  }
  for (const dt of tradingDates) {
    seed[`datasets/${dt}/stocks-dataset-${dt}-v1.json`] = '{"stocks":[]}';
  }
  const latestDate = tradingDates[tradingDates.length - 1];
  const prevDate = tradingDates[tradingDates.length - 2];
  seed['latest.json'] = JSON.stringify({
    tradingDate: latestDate,
    versionId: `${latestDate}-v1`,
    datasetPath: `datasets/${latestDate}/stocks-dataset-${latestDate}-v1.json`,
    publishedSessions: tradingDates,
    publishedSessionsComplete: true,
    previousVersion: { tradingDate: prevDate, datasetPath: `datasets/${prevDate}/stocks-dataset-${prevDate}-v1.json` }
  });

  const retMock = createMockSupabase(seed);
  const dryRes = await retMock.client.pruneOldDatasets({ retainSessions: 30, dryRun: true });
  assert.strictEqual(dryRes.ok, true);
  assert.strictEqual(dryRes.expiredTradingDates.length, 4);
  assert.strictEqual(dryRes.plannedDeletions.length, 4);
  assert.strictEqual(retMock.deletedPaths.length, 0, 'Dry run must never delete objects');

  const liveRes = await retMock.client.pruneOldDatasets({ retainSessions: 30, dryRun: false });
  assert.strictEqual(liveRes.ok, true);
  assert.strictEqual(liveRes.deletedCount, 4);
  assert.ok(retMock.objects.has('reference/catalog.json'));
  assert.ok(retMock.objects.has('latest.json'));

  // 4. Missing-object vs real error classification + first-time publish on HTTP 400 NoSuchKey
  assert.strictEqual(isObjectNotFoundResponse({ ok: false, statusCode: 404, body: Buffer.from('') }), true);
  assert.strictEqual(isObjectNotFoundResponse({ ok: false, statusCode: 400, body: Buffer.from('NoSuchKey') }), true);
  assert.strictEqual(
    isObjectNotFoundResponse({ ok: false, statusCode: 400, body: Buffer.from('{"statusCode":"404","error":"not_found","message":"Object not found"}') }),
    true
  );
  assert.strictEqual(
    isObjectNotFoundResponse({ ok: false, statusCode: 400, body: Buffer.from('{"statusCode":"404","error":"Bucket not found"}') }),
    false,
    'Missing bucket must never look like missing object key'
  );
  assert.strictEqual(
    isObjectNotFoundResponse({ ok: false, statusCode: 400, body: Buffer.from('{"message":"Invalid JWT"}') }),
    false,
    'JWT error must never look like missing object key'
  );
  assert.strictEqual(isObjectNotFoundResponse({ ok: false, statusCode: 401, body: Buffer.from('NoSuchKey') }), false);
  assert.strictEqual(isObjectNotFoundResponse({ ok: false, statusCode: 403, body: Buffer.from('Forbidden') }), false);
  assert.strictEqual(isObjectNotFoundResponse({ ok: false, statusCode: 500, body: Buffer.from('Internal') }), false);

  // First-time publish succeeds when Supabase returns HTTP 400 NoSuchKey for missing latest.json & lock
  const noSuchKeyStore = new Map();
  const firstPubClient = createStorageClient({
    url: 'https://mock-supabase.local',
    serviceKey: 'mock-service-role',
    bucket: 'machii-bazzar-datasets',
    maxRetries: 1,
    httpRequest: async (url, opts = {}) => {
      const parsed = new URL(url);
      const method = (opts.method || 'GET').toUpperCase();
      const parts = parsed.pathname.split('/');
      if (parts[4] === 'list' && method === 'POST') {
        const prefix = JSON.parse(Buffer.from(opts.body || '{}').toString('utf8')).prefix || '';
        const seenFolders = new Set();
        const items = [];
        for (const [k, v] of noSuchKeyStore.entries()) {
          if (prefix && !k.startsWith(prefix + '/')) continue;
          const rest = prefix ? k.slice(prefix.length + 1) : k;
          if (!rest) continue;
          if (rest.includes('/')) {
            const folder = rest.split('/')[0];
            if (!seenFolders.has(folder)) {
              seenFolders.add(folder);
              items.push({ name: folder, id: null, metadata: null });
            }
          } else {
            items.push({ name: rest, id: `id-${rest}`, metadata: { size: Buffer.byteLength(v, 'utf8') } });
          }
        }
        return { ok: true, statusCode: 200, headers: {}, body: Buffer.from(JSON.stringify(items), 'utf8') };
      }
      const isAuthGet = parts[4] === 'authenticated' || parts[4] === 'public';
      const objPath = decodeURIComponent(parts.slice(isAuthGet ? 6 : 5).join('/'));
      if (method === 'GET') {
        if (!noSuchKeyStore.has(objPath)) {
          return { ok: false, statusCode: 400, headers: {}, body: Buffer.from('NoSuchKey') };
        }
        return { ok: true, statusCode: 200, headers: {}, body: Buffer.from(noSuchKeyStore.get(objPath), 'utf8') };
      }
      if (method === 'POST') {
        noSuchKeyStore.set(objPath, Buffer.from(opts.body || '').toString('utf8'));
        return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
      }
      if (method === 'DELETE') {
        noSuchKeyStore.delete(objPath);
        return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
      }
      return { ok: false, statusCode: 400, headers: {}, body: Buffer.alloc(0) };
    }
  });

  const firstPub = await firstPubClient.publishDatasetToStorage(
    { tradingDate: '2026-11-26', refreshedAtUtc: '2026-11-26T07:00:00.000Z', istDisplayTime: '26 Nov 2026, 12:30:00 IST' },
    [{ isin: 'INE002A01018', symbol: 'RELIANCE' }]
  );
  assert.strictEqual(firstPub.ok, true, 'First publish must succeed on HTTP 400 NoSuchKey');
  assert.strictEqual(firstPub.previousVersionId, null);
  assert.ok(noSuchKeyStore.has(firstPub.datasetPath));
  assert.ok(noSuchKeyStore.has('latest.json'));
  const createdLatest = JSON.parse(noSuchKeyStore.get('latest.json'));
  assert.strictEqual(createdLatest.tradingDate, '2026-11-26');
  assert.strictEqual(createdLatest.previousVersion, null);
  assert.deepStrictEqual(createdLatest.publishedSessions, ['2026-11-26']);

  // Genuine storage/auth/network errors on latest.json MUST fail closed (even with force: true) and never upload dataset
  for (const errCase of [
    { label: '403 Forbidden', res: { ok: false, statusCode: 403, headers: {}, body: Buffer.from('Forbidden') } },
    { label: '400 Bucket Not Found', res: { ok: false, statusCode: 400, headers: {}, body: Buffer.from('{"error":"Bucket not found"}') } },
    { label: '500 Internal Error', res: { ok: false, statusCode: 500, headers: {}, body: Buffer.from('Server Error') } },
    { label: 'Network Error', res: { ok: false, statusCode: 0, headers: {}, body: Buffer.alloc(0), error: 'ECONNRESET' } }
  ]) {
    const errStore = new Map();
    const errClient = createStorageClient({
      url: 'https://mock-supabase.local',
      serviceKey: 'mock-service-role',
      bucket: 'machii-bazzar-datasets',
      maxRetries: 1,
      httpRequest: async (url, opts = {}) => {
        const parsed = new URL(url);
        const method = (opts.method || 'GET').toUpperCase();
        const parts = parsed.pathname.split('/');
        const isAuthGet = parts[4] === 'authenticated' || parts[4] === 'public';
        const objPath = decodeURIComponent(parts.slice(isAuthGet ? 6 : 5).join('/'));
        if (method === 'GET' && objPath === 'latest.json') return errCase.res;
        if (method === 'GET') {
          return errStore.has(objPath)
            ? { ok: true, statusCode: 200, headers: {}, body: Buffer.from(errStore.get(objPath), 'utf8') }
            : { ok: false, statusCode: 404, headers: {}, body: Buffer.from('Not Found') };
        }
        if (method === 'POST') {
          errStore.set(objPath, Buffer.from(opts.body || '').toString('utf8'));
          return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
        }
        if (method === 'DELETE') {
          errStore.delete(objPath);
          return { ok: true, statusCode: 200, headers: {}, body: Buffer.from('{}') };
        }
        return { ok: false, statusCode: 400, headers: {}, body: Buffer.alloc(0) };
      }
    });

    const failOut = await errClient.publishDatasetToStorage(
      { tradingDate: '2026-11-26', refreshedAtUtc: '2026-11-26T07:05:00.000Z' },
      [{ isin: 'INE002A01018', symbol: 'RELIANCE' }],
      { force: true, skipRetention: true }
    );
    assert.strictEqual(failOut.ok, false, `${errCase.label} must fail closed even with force: true`);
    assert.ok(!errStore.has('latest.json'), `${errCase.label} must never create latest.json`);
    assert.ok(![...errStore.keys()].some(k => k.startsWith('datasets/')), `${errCase.label} must not upload dataset when manifest probe fails`);
  }
}

module.exports = { name: 'storage-retention.test.js', run };
