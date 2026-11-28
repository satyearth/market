'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const constants = require('../src/config/constants');
const universeMerger = require('../src/processing/universe-merger');
const calendar = require('../src/calendar/exchange-calendar');
const httpClient = require('../src/ingestion/http-client');
const bhavcopyDownloader = require('../src/ingestion/bhavcopy-downloader');
const queryService = require('../src/query/stock-query-service');
const fundamentals = require('../src/enrichment/fundamentals');
const marketCap = require('../src/enrichment/market-cap');
const stocksApi = require('../api/stocks');
const refreshApi = require('../api/market/refresh');
const statusApi = require('../api/market/status');
const { SlidingWindowRateLimiter, authorizeRefreshRequest } = require('../src/server/security-utils');
const localServer = require('../src/server/local-server');
const { createStorageClient } = require('../src/storage/supabase-storage');

const ROOT = path.resolve(__dirname, '..');

function makeMockRes() {
  const headers = {};
  let statusCode = 200;
  let body = null;
  let ended = false;
  return {
    headersSent: false,
    writableEnded: false,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    writeHead(code, extra = {}) {
      statusCode = code;
      this.headersSent = true;
      for (const [k, v] of Object.entries(extra)) {
        headers[k.toLowerCase()] = v;
      }
    },
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; ended = true; this.writableEnded = true; return this; },
    end(chunk) {
      if (chunk != null) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        try { body = JSON.parse(text); } catch (_) { body = text; }
      }
      ended = true;
      this.writableEnded = true;
      return this;
    },
    getResult: () => ({ statusCode, headers, body, ended })
  };
}

function makeHttpsRequestMock(routes) {
  return (reqOptions, callback) => {
    const req = new EventEmitter();
    req.destroy = (err) => { if (err) req.emit('error', err); };
    req.end = () => {
      const target = `https://${reqOptions.hostname}${reqOptions.path}`;
      const handler = routes[target];
      const spec = typeof handler === 'function' ? handler(reqOptions) : handler;
      const res = new EventEmitter();
      res.statusCode = spec ? spec.statusCode : 404;
      res.headers = (spec && spec.headers) || {};
      res.resume = () => {};
      callback(res);
      if (spec && spec.body != null) {
        res.emit('data', Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(String(spec.body)));
      }
      res.emit('end');
    };
    return req;
  };
}

async function run() {
  // 1. RM-001: Canonical series/group constants shared across merger & audit
  assert.strictEqual(universeMerger.NSE_EQUITY_SERIES, constants.NSE_EQUITY_SERIES);
  assert.strictEqual(universeMerger.BSE_EQUITY_GROUPS, constants.BSE_EQUITY_GROUPS);
  assert.strictEqual(constants.NSE_EQUITY_SERIES.has('SZ'), true, 'NSE SZ series must be eligible');
  for (const grp of ['IF', 'R', 'TS', 'ZP', 'SS', 'IT', 'E']) {
    assert.strictEqual(constants.BSE_EQUITY_GROUPS.has(grp), true, `BSE group ${grp} must be eligible`);
  }
  assert.strictEqual(constants.BSE_EQUITY_GROUPS.has('F'), false, 'BSE debt group F must remain excluded');
  const auditSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'missing-stock-audit.js'), 'utf8');
  assert.ok(auditSrc.includes("require('../src/config/constants')"), 'missing-stock-audit.js must import canonical constants');
  assert.ok(!auditSrc.includes("new Set(['EQ', 'BE', 'BZ', 'BL'"), 'missing-stock-audit.js must not hardcode stale series set');

  // 2. RM-002: 2027 calendar coverage & unverified future holiday guard + IST timezone
  const cov2026 = calendar.getCalendarCoverageForYear(2026);
  const cov2027 = calendar.getCalendarCoverageForYear(2027);
  const cov2028 = calendar.getCalendarCoverageForYear(2028);
  assert.strictEqual(cov2026.supported, true);
  assert.strictEqual(cov2026.verified, true);
  assert.strictEqual(cov2027.supported, true);
  assert.strictEqual(cov2027.verified, false, '2027 must NOT be falsely marked verified before official circulars');
  assert.ok(cov2027.warning && cov2027.warning.toLowerCase().includes('unverified'));
  assert.strictEqual(cov2028.supported, false);
  assert.strictEqual(cov2028.verified, false);

  const jan2Sat2027 = calendar.classifyTradingSession('2027-01-02');
  const jan3Sun2027 = calendar.classifyTradingSession('2027-01-03');
  const jan4Mon2027 = calendar.classifyTradingSession('2027-01-04');
  const republic2027 = calendar.classifyTradingSession('2027-01-26');
  assert.strictEqual(jan2Sat2027.isWeekend, true);
  assert.strictEqual(jan2Sat2027.isTradingDay, false);
  assert.strictEqual(jan3Sun2027.isWeekend, true);
  assert.strictEqual(jan3Sun2027.isTradingDay, false);
  assert.strictEqual(jan4Mon2027.isTradingDay, true);
  assert.strictEqual(jan4Mon2027.calendarVerified, false);
  assert.strictEqual(republic2027.calendarVerified, false, 'Unknown 2027 holidays must carry calendarVerified=false');
  assert.strictEqual(calendar.getPreviousTradingDay('2027-01-01'), '2026-12-31');
  assert.strictEqual(calendar.isTradingDay('2026-11-08'), true, '2026 Diwali Muhurat special session preserved');
  assert.strictEqual(calendar.isTradingDay('2026-12-25'), false, '2026 Christmas holiday preserved');
  // 2027-01-01 18:35 UTC = 2027-01-02 00:05 IST (Saturday)
  const utcEveningJan1 = new Date('2027-01-01T18:35:00Z');
  const istBoundary = calendar.getLatestExpectedTradingDate(utcEveningJan1);
  assert.strictEqual(istBoundary.currentIstDate, '2027-01-02');
  assert.strictEqual(istBoundary.isWeekend, true);
  assert.strictEqual(istBoundary.latestExpectedDate, '2027-01-01');
  assert.strictEqual(istBoundary.calendarVerified, false);

  // 3. SEC-001: HTTPS + allowlist + redirect loop/SSRF blocking
  await assert.rejects(
    () => httpClient.httpGetBuffer('http://www.nseindia.com/test.csv'),
    /HTTPS is required/i
  );
  await assert.rejects(
    () => httpClient.httpGetBuffer('https://127.0.0.1/test.csv'),
    /private\/internal|IP/i
  );
  await assert.rejects(
    () => httpClient.httpGetBuffer('https://www.nseindia.com:8443/test.csv'),
    /unexpected port/i
  );
  await assert.rejects(
    () => httpClient.httpGetBuffer('https://evil.example.com/payload'),
    /allowlist/i
  );
  // Malicious redirect to evil host or loopback
  await assert.rejects(
    () => httpClient.httpGetBuffer('https://nsearchives.nseindia.com/ok', {
      httpsRequest: makeHttpsRequestMock({
        'https://nsearchives.nseindia.com/ok': {
          statusCode: 302,
          headers: { location: 'https://169.254.169.254/latest/meta-data' }
        }
      })
    }),
    /Blocked unsafe redirect/i
  );
  await assert.rejects(
    () => httpClient.httpGetBuffer('https://nsearchives.nseindia.com/start', {
      httpsRequest: makeHttpsRequestMock({
        'https://nsearchives.nseindia.com/start': {
          statusCode: 302,
          headers: { location: 'https://attacker.com/steal' }
        }
      })
    }),
    /Blocked unsafe redirect/i
  );
  // Redirect loop A -> B -> A rejected immediately
  await assert.rejects(
    () => httpClient.httpGetBuffer('https://nsearchives.nseindia.com/a', {
      httpsRequest: makeHttpsRequestMock({
        'https://nsearchives.nseindia.com/a': { statusCode: 302, headers: { location: 'https://www.nseindia.com/b' } },
        'https://www.nseindia.com/b': { statusCode: 302, headers: { location: 'https://nsearchives.nseindia.com/a' } }
      })
    }),
    /Redirect loop detected/i
  );
  // Legitimate NSE HTTPS redirect succeeds
  const validRedirect = await httpClient.httpGetBuffer('https://nsearchives.nseindia.com/archive.csv', {
    httpsRequest: makeHttpsRequestMock({
      'https://nsearchives.nseindia.com/archive.csv': { statusCode: 302, headers: { location: 'https://www.nseindia.com/cdn/archive.csv' } },
      'https://www.nseindia.com/cdn/archive.csv': { statusCode: 200, body: 'SYMBOL,SERIES\nRELIANCE,EQ' }
    })
  });
  assert.strictEqual(validRedirect.statusCode, 200);
  assert.ok(validRedirect.body.toString('utf8').includes('RELIANCE'));

  // 4. SEC-002 + BUG-001 + BUG-002: Validation, 200-ISIN cap, 429 limit, zero handling, JLR alias, list stripping
  const tooManyIsins = Array.from({ length: 201 }, (_, i) => `INE${String(i).padStart(8, '0')}1`).join(',');
  const resTooMany = makeMockRes();
  await stocksApi({ method: 'GET', url: '/api/stocks', query: { filter: 'WATCHLIST', isins: tooManyIsins }, headers: {}, socket: { remoteAddress: '10.0.0.1' } }, resTooMany, {
    rateLimiter: new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 10 })
  });
  assert.strictEqual(resTooMany.getResult().statusCode, 400);

  const resBadFilter = makeMockRes();
  await stocksApi({ method: 'GET', url: '/api/stocks', query: { filter: 'DROP TABLE' }, headers: {}, socket: { remoteAddress: '10.0.0.2' } }, resBadFilter, {
    rateLimiter: new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 10 })
  });
  assert.strictEqual(resBadFilter.getResult().statusCode, 400);

  const resLongSearch = makeMockRes();
  await stocksApi({ method: 'GET', url: '/api/stocks', query: { search: 'A'.repeat(201) }, headers: {}, socket: { remoteAddress: '10.0.0.3' } }, resLongSearch, {
    rateLimiter: new SlidingWindowRateLimiter({ windowMs: 10000, maxRequests: 10 })
  });
  assert.strictEqual(resLongSearch.getResult().statusCode, 400);

  // Rate limiting 429
  const strictLimiter = new SlidingWindowRateLimiter({ windowMs: 60000, maxRequests: 2 });
  for (let i = 0; i < 2; i++) {
    const r = makeMockRes();
    await stocksApi({ method: 'GET', url: '/api/stocks', query: { limit: '1' }, headers: {}, socket: { remoteAddress: '203.0.113.55' } }, r, { rateLimiter: strictLimiter });
    assert.strictEqual(r.getResult().statusCode, 200);
  }
  const rLimited = makeMockRes();
  await stocksApi({ method: 'GET', url: '/api/stocks', query: { limit: '1' }, headers: {}, socket: { remoteAddress: '203.0.113.55' } }, rLimited, { rateLimiter: strictLimiter });
  assert.strictEqual(rLimited.getResult().statusCode, 429);
  assert.ok(rLimited.getResult().headers['retry-after']);

  // BUG-001 (JLR/Jaguar -> TMPV), BUG-002 (pct_from_high === 0), SEC-002 list strip vs detail retain
  const syntheticDataset = {
    stats: { tradingDate: '2026-11-26', stockCount: 3 },
    stocks: [
      {
        isin: 'INE155A01022',
        symbol: 'TMPV',
        nse_symbol: 'TMPV',
        company_name: 'Tata Motors Passenger Vehicles Limited',
        current_price: 263.45,
        prev_close: 260,
        pct_from_high: -5.2,
        is_near_high: true,
        market_cap_cr: 96739.12,
        description: 'Automotive manufacturer owning Jaguar Land Rover.',
        historical_prices: [{ date: '2026-11-25', close: 260 }, { date: '2026-11-26', close: 263.45 }]
      },
      {
        isin: 'INE00C501018',
        symbol: 'AMBANIORGO',
        nse_symbol: 'AMBANIORGO',
        company_name: 'Ambani Orgochem Limited',
        current_price: 150,
        prev_close: 145,
        pct_from_high: 0,
        is_near_high: false, // Even without boolean flag, 0 >= -8 MUST match!
        market_cap_cr: 120,
        description: 'Chemical company',
        historical_prices: [{ date: '2026-11-25', close: 145 }, { date: '2026-11-26', close: 150 }]
      },
      {
        isin: 'INE000A00099',
        symbol: 'NULLPCT',
        nse_symbol: 'NULLPCT',
        company_name: 'Null Pct High Ltd',
        current_price: 50,
        prev_close: 50,
        pct_from_high: null, // Must NOT coerce null -> 0 >= -8
        is_near_high: false,
        market_cap_cr: 50,
        historical_prices: [{ date: '2026-11-25', close: 50 }, { date: '2026-11-26', close: 50 }]
      }
    ]
  };
  const jlrHit = queryService.executeStockQuery(syntheticDataset, { search: 'jlr' });
  const jagHit = queryService.executeStockQuery(syntheticDataset, { search: 'jaguar' });
  assert.strictEqual(jlrHit.stocks.length, 1);
  assert.strictEqual(jlrHit.stocks[0].isin, 'INE155A01022');
  assert.strictEqual(jagHit.stocks[0].symbol, 'TMPV');
  assert.strictEqual(jlrHit.stocks[0].historical_prices, undefined, 'Paginated list query must omit 90-session historical_prices');
  assert.strictEqual(jlrHit.stocks[0].description, undefined, 'Paginated list query must omit heavy descriptions');

  const detailHit = queryService.executeStockQuery(syntheticDataset, { isin: 'INE155A01022', limit: '1' });
  assert.strictEqual(detailHit.stocks[0].historical_prices.length, 2, 'Detail query preserves historical_prices');
  assert.ok(detailHit.stocks[0].description.includes('Jaguar Land Rover'), 'Detail query preserves description');

  const zeroNear = queryService.executeStockQuery(syntheticDataset, { filter: 'NEAR 52W HIGH' });
  assert.ok(zeroNear.stocks.some(s => s.symbol === 'AMBANIORGO'), 'pct_from_high === 0 must be included in NEAR 52W HIGH');
  assert.ok(!zeroNear.stocks.some(s => s.symbol === 'NULLPCT'), 'pct_from_high === null must NOT coerce to 0 in NEAR 52W HIGH');

  // Verify fast 64KB head reader works on real js/stocks-data.js
  const fastStats = queryService.readLocalStatsSafe();
  assert.ok(fastStats && fastStats.tradingDate && fastStats.stockCount >= 5000);

  // 5. SEC-003 & SEC-004: Async sanitized errors & security headers & CSP compliance
  const errRefreshRes = makeMockRes();
  await refreshApi(
    { method: 'POST', headers: {}, socket: { remoteAddress: '198.51.100.9' } },
    errRefreshRes,
    {
      rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60000, maxRequests: 10 }),
      loadMarketStatsAsync: async () => { throw new Error('SENSITIVE_DB_PATH C:\\secret\\token'); }
    }
  );
  const refreshErrOut = errRefreshRes.getResult();
  assert.strictEqual(refreshErrOut.statusCode, 500);
  assert.strictEqual(refreshErrOut.body.ok, false);
  assert.ok(!String(refreshErrOut.body.error).includes('SENSITIVE_DB_PATH'), 'Error JSON must be sanitized');
  assert.ok(refreshErrOut.headers['content-security-policy'].includes("script-src 'self'"));
  assert.strictEqual(refreshErrOut.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(refreshErrOut.headers['x-frame-options'], 'DENY');

  // Check local server blocks dead /js/logo-aliases.js, sends security headers, handles bad URL, and enforces refresh rate limits
  assert.strictEqual(localServer.ALLOWED_STATIC_PATHS.has('/js/logo-aliases.js'), false);
  const aliasReq = { method: 'GET', url: '/js/logo-aliases.js', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  const aliasRes = makeMockRes();
  await localServer.handleRequest(aliasReq, aliasRes);
  assert.strictEqual(aliasRes.getResult().statusCode, 404);
  assert.ok(aliasRes.getResult().headers['content-security-policy'].includes("frame-ancestors 'none'"));

  const badUrlReq = { method: 'GET', url: '/%E0%A4%A', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
  const badUrlRes = makeMockRes();
  await localServer.handleRequest(badUrlReq, badUrlRes);
  assert.strictEqual(badUrlRes.getResult().statusCode, 400);

  // Verify local-server refresh source enforces non-blocking 202 and sanitized errors
  const localServerSrc = fs.readFileSync(path.join(ROOT, 'src', 'server', 'local-server.js'), 'utf8');
  assert.ok(localServerSrc.includes("return sendJson(res, 202"), 'local-server must return HTTP 202 when triggering async background refresh');
  assert.ok(localServerSrc.includes("status: 'accepted'"), 'local-server async refresh must return status accepted');
  assert.ok(!localServerSrc.includes('Server Error: ${err.message}'), 'local-server must not expose raw err.message in 500 responses');

  const vercelCfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const secHeaderNames = new Set((vercelCfg.headers?.[0]?.headers || []).map(h => h.key));
  for (const h of ['Content-Security-Policy', 'X-Content-Type-Options', 'Referrer-Policy', 'X-Frame-Options']) {
    assert.ok(secHeaderNames.has(h), `vercel.json must configure ${h}`);
  }

  // 6. BUG-003..007: Frontend markup/JS checks & fundamentals dead-logo prevention
  const logoJs = fs.readFileSync(path.join(ROOT, 'js', 'company-logo.js'), 'utf8');
  assert.ok(!logoJs.includes('onload='), 'company-logo.js must not emit inline onload handlers');
  assert.ok(!logoJs.includes('onerror='), 'company-logo.js must not emit inline onerror handlers');

  const appJs = fs.readFileSync(path.join(ROOT, 'js', 'app.js'), 'utf8');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(appJs.includes('near52WeekHighSource') && appJs.includes('near52WeekHighSurveyedUniverse'), 'app.js must label Card 4 from active 52W source');
  assert.ok(appJs.includes('computeChangeInr') && appJs.includes('prev_close'), 'app.js must compute Change (INR) for CSV');
  assert.ok(indexHtml.includes('Export loaded rows'), 'index.html export button must indicate loaded rows');
  assert.ok(!appJs.includes('3758'), 'app.js must not retain stale 3758 unranked fallback');

  const fundResult = fundamentals.enrichFundamentalsForStock({
    isin: 'INE999A01099',
    symbol: 'TESTCO',
    nseSymbol: 'TESTCO',
    series: 'EQ',
    currentPrice: 120,
    benchmark: { logo_url: '/stock-logos/TESTCO.png', pe_ratio: 15.5 },
    catalogEntry: { sector: 'Technology', industry: 'IT', oneLine: 'Software services firm.' },
    screenerEntry: { pe: 18.0, roce: 21.4 }
  });
  assert.strictEqual(fundResult.logo_url, null, 'BUG-007: dead /stock-logos/ URLs must never be generated');
  assert.strictEqual(fundResult.description, 'Software services firm.', 'BUG-005: catalog oneLine attached cleanly');
  assert.strictEqual(fundResult.fundamentals_as_of_date, '2026-11-04');

  // Market cap Screener collision rejection
  const mismatchedScr = marketCap.resolveStockMarketCap(
    { isin: 'INE751R01014', symbol: 'RAJPUTANA', current_price: 27, screener_ref_close: 28, trading_date: '2026-11-26' },
    {
      sourceDates: { SCREENER_DATASET: '2026-11-04' },
      benchmarkBySymbol: new Map(),
      bseSecByIsin: new Map(),
      catalogByIsin: new Map(),
      catalogByTicker: new Map([['RAJPUTANA', { isin: 'INE0VHU01019', capCr: 145.76 }]]),
      screenerBySlug: new Map([['RAJPUTANA', { slug: 'RAJPUTANA', cmp: 190, mcap: 133.64 }]]),
      screenerMetaBySlug: new Map([['RAJPUTANA', { slug: 'RAJPUTANA', cmp: 190, mcap: 133.64 }]])
    },
    { market_cap_cr: 145.76, market_cap_source: 'INDIA_API_TICKER' }
  );
  assert.strictEqual(mismatchedScr.market_cap_cr, null, 'Mismatched slug/ISIN/stale-ticker carryover must stay null');

  // 7. Distributed lock fail-closed checks
  const storageClient = createStorageClient({
    url: 'https://mock.supabase.co',
    serviceKey: 'mock-service-key',
    httpRequest: async (url, opts) => {
      if (url.includes('locks/refresh.lock.json') && opts.method === 'GET') {
        return { ok: false, statusCode: 500, body: Buffer.from('Internal failure'), error: 'HTTP 500' };
      }
      throw new Error('Unexpected write on transient 500 lock state');
    }
  });
  const failClosedAcquire = await storageClient.acquireStorageLock('owner-a');
  assert.strictEqual(failClosedAcquire.acquired, false, 'Lock acquisition must fail closed on HTTP 500');
  const failClosedRelease = await storageClient.releaseStorageLock('owner-a');
  assert.strictEqual(failClosedRelease.ok, false, 'Lock release must fail closed on HTTP 500');

  // 8. DNS-resolution SSRF protection checks
  for (const blockedIp of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.10',
    '::1',
    '::ffff:192.168.1.10',
    'fc00::1',
    'fe80::1'
  ]) {
    assert.strictEqual(httpClient.isPrivateOrReservedIp(blockedIp), true, `Must classify ${blockedIp} as private/reserved`);
  }
  for (const publicIp of ['1.1.1.1', '23.45.67.89', '2606:4700:4700::1111']) {
    assert.strictEqual(httpClient.isPrivateOrReservedIp(publicIp), false, `Must allow public IP ${publicIp}`);
  }

  await new Promise((resolve, reject) => {
    const safeLookup = httpClient.createSafeDnsLookup((host, opts, cb) => {
      cb(null, [{ address: '169.254.169.254', family: 4 }]);
    });
    safeLookup('nsearchives.nseindia.com', {}, (err) => {
      try {
        assert.ok(err && /private\/reserved/i.test(err.message), 'Safe DNS lookup must block metadata IP');
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  await new Promise((resolve, reject) => {
    const safeLookup = httpClient.createSafeDnsLookup((host, opts, cb) => {
      cb(null, [{ address: '::ffff:127.0.0.1', family: 6 }]);
    });
    safeLookup('nsearchives.nseindia.com', { all: true }, (err) => {
      try {
        assert.ok(err && /private\/reserved/i.test(err.message), 'Safe DNS lookup must block IPv6-mapped IPv4 loopback');
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  await new Promise((resolve, reject) => {
    const safeLookup = httpClient.createSafeDnsLookup((host, opts, cb) => {
      cb(null, [{ address: '23.45.67.89', family: 4 }]);
    });
    safeLookup('nsearchives.nseindia.com', {}, (err, addr, family) => {
      try {
        assert.ifError(err);
        assert.strictEqual(addr, '23.45.67.89');
        assert.strictEqual(family, 4);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });

  // 9. Refresh endpoint access control (Origin + timing-safe REFRESH_API_SECRET)
  assert.strictEqual(
    authorizeRefreshRequest({ headers: { origin: 'https://evil.example.com' } }).statusCode,
    403,
    'Cross-origin local refresh request must be rejected with 403'
  );
  assert.strictEqual(
    authorizeRefreshRequest({ headers: { origin: 'http://localhost:3000' } }, { refreshSecret: '' }).ok,
    true,
    'Localhost Origin without configured secret must be permitted'
  );
  assert.strictEqual(
    authorizeRefreshRequest({ headers: {} }, { refreshSecret: 'super-secret-value' }).statusCode,
    401,
    'Missing refresh secret must be rejected with 401 when configured'
  );
  assert.strictEqual(
    authorizeRefreshRequest({ headers: { authorization: 'Bearer wrong-secret' } }, { refreshSecret: 'super-secret-value' }).statusCode,
    401
  );
  assert.strictEqual(
    authorizeRefreshRequest({ headers: { authorization: 'Bearer super-secret-value' } }, { refreshSecret: 'super-secret-value' }).ok,
    true
  );
  assert.strictEqual(
    authorizeRefreshRequest({ headers: { 'x-refresh-secret': 'super-secret-value' } }, { refreshSecret: 'super-secret-value' }).ok,
    true
  );

  const evilRefreshReq = {
    method: 'POST',
    url: '/api/market/refresh',
    headers: { host: '127.0.0.1', origin: 'https://evil.example.com' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  const evilRefreshRes = makeMockRes();
  await localServer.handleRequest(evilRefreshReq, evilRefreshRes);
  assert.strictEqual(evilRefreshRes.getResult().statusCode, 403);
  assert.strictEqual(evilRefreshRes.getResult().body.ok, false);

  const prevEnvSecret = process.env.REFRESH_API_SECRET;
  process.env.REFRESH_API_SECRET = 'ci-refresh-secret-test';
  try {
    const unauthApiRes = makeMockRes();
    await refreshApi(
      { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.77' } },
      unauthApiRes,
      { rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60000, maxRequests: 10 }) }
    );
    assert.strictEqual(unauthApiRes.getResult().statusCode, 401, 'api/market/refresh must require secret when env is set');
  } finally {
    if (prevEnvSecret === undefined) delete process.env.REFRESH_API_SECRET;
    else process.env.REFRESH_API_SECRET = prevEnvSecret;
  }

  // 10. Expired lock takeover settle + pre-commit lock fence abort before latest.json swap
  {
    const objects = new Map();
    const putPaths = [];
    let datasetUploaded = false;
    const pastIso = new Date(Date.now() - 120000).toISOString();
    const futureIso = new Date(Date.now() + 120000).toISOString();
    objects.set('locks/refresh.lock.json', Buffer.from(JSON.stringify({
      ownerId: 'crashed-runner',
      acquiredAtUtc: pastIso,
      expiresAtUtc: pastIso
    })));

    const fencedStorage = createStorageClient({
      url: 'https://mock.supabase.co',
      serviceKey: 'mock-service-key',
      lockTakeoverSettleMs: 0,
      httpRequest: async (url, opts) => {
        const objPath = decodeURIComponent(String(url).split('/machii-bazzar-datasets/')[1] || '');
        if (opts.method === 'GET') {
          if (objPath === 'locks/refresh.lock.json' && datasetUploaded) {
            // Simulate competing runner stealing lock right before latest.json swap
            objects.set(objPath, Buffer.from(JSON.stringify({
              ownerId: 'stealer-runner',
              acquiredAtUtc: new Date().toISOString(),
              expiresAtUtc: futureIso
            })));
          }
          if (!objects.has(objPath)) {
            return { ok: false, notFound: true, statusCode: 404, body: Buffer.from('Not found'), error: 'HTTP 404' };
          }
          return { ok: true, statusCode: 200, body: objects.get(objPath), headers: {} };
        }
        if (opts.method === 'POST' || opts.method === 'PUT') {
          putPaths.push(objPath);
          if (objPath.startsWith('datasets/')) datasetUploaded = true;
          objects.set(objPath, Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body || '')));
          return { ok: true, statusCode: 200, body: Buffer.from('{"Key":"ok"}'), headers: {} };
        }
        if (opts.method === 'DELETE') {
          objects.delete(objPath);
          return { ok: true, statusCode: 200, body: Buffer.from('{}'), headers: {} };
        }
        return { ok: false, statusCode: 405, body: Buffer.alloc(0), error: 'Method not allowed' };
      }
    });

    const lockAcq = await fencedStorage.acquireStorageLock('runner-a');
    assert.strictEqual(lockAcq.acquired, true, 'Expired lock must be recoverable by healthy runner');

    const fenceAbort = await fencedStorage.publishDatasetToStorage(
      {
        tradingDate: '2026-11-27',
        nseSourceDate: '2026-11-27',
        bseSourceDate: '2026-11-27',
        refreshedAtUtc: '2026-11-27T11:30:00.000Z',
        istDisplayTime: '27 Nov 2026, 17:00:00 IST',
        totalStocks: 1,
        pipelineVersion: '2.0.0'
      },
      [{ isin: 'INE002A01018', symbol: 'RELIANCE', company_name: 'Reliance Industries Limited', current_price: 1382.6 }],
      { ownerId: 'runner-a' }
    );
    assert.strictEqual(fenceAbort.ok, false, 'Publish must abort when lock ownership is lost before pointer swap');
    assert.strictEqual(fenceAbort.phase, 'verify_lock_fence');
    assert.strictEqual(putPaths.some(p => p.includes('latest.json')), false, 'latest.json must NOT be swapped after lock fence loss');
  }

  // 11. Multi-file PKZIP extraction & non-common equity guards (RE/PP/CCPS vs Common/DVR)
  {
    const createSingleOrMultiZip = (entries) => {
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf8');
        const rawBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
        const compBuf = zlib.deflateRawSync(rawBuf);

        const lfh = Buffer.alloc(30 + nameBuf.length);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(0, 6);
        lfh.writeUInt16LE(8, 8);
        lfh.writeUInt32LE(compBuf.length, 18);
        lfh.writeUInt32LE(rawBuf.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        nameBuf.copy(lfh, 30);

        const cdh = Buffer.alloc(46 + nameBuf.length);
        cdh.writeUInt32LE(0x02014b50, 0);
        cdh.writeUInt16LE(20, 4);
        cdh.writeUInt16LE(20, 6);
        cdh.writeUInt16LE(8, 10);
        cdh.writeUInt32LE(compBuf.length, 20);
        cdh.writeUInt32LE(rawBuf.length, 24);
        cdh.writeUInt16LE(nameBuf.length, 28);
        cdh.writeUInt32LE(offset, 42);
        nameBuf.copy(cdh, 46);

        localParts.push(lfh, compBuf);
        centralParts.push(cdh);
        offset += lfh.length + compBuf.length;
      }
      const cdBuf = Buffer.concat(centralParts);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(entries.length, 8);
      eocd.writeUInt16LE(entries.length, 10);
      eocd.writeUInt32LE(cdBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);
      return Buffer.concat([...localParts, cdBuf, eocd]);
    };

    const sampleMcapCsv = [
      'Trade Date,Symbol,Series,Security Name,Category,Last Trade Date,Face Value(Rs.),Issue Size,Close Price/Paid up value(Rs.),Market Cap(Rs.)',
      '27 NOV 2026,MAHACOAL,EQ,Mahanadi Coalfields Ltd,Listed,27 NOV 2026,10.00,6618363000,132.50,876933100000.00',
      '27 NOV 2026,TOTAL,BE,Total Transport Systems Limited,Listed,27 NOV 2026,10.00,16097920,81.70,1315200064.00',
      '27 NOV 2026,Total     ,  ,                         ,          ,           ,               0.00,                 0,              0.00,507360723073184.00'
    ].join('\n') + '\n';
    const zipBuf = createSingleOrMultiZip([
      { name: 'an27112026.txt', content: 'unrelated announcement' },
      { name: 'mcap27112026.csv', content: sampleMcapCsv },
      { name: 'bc27112026.csv', content: 'SERIES,SYMBOL\n' }
    ]);
    const extracted = bhavcopyDownloader.extractEntryFromZipBuffer(zipBuf, n => n.toLowerCase().endsWith('mcap27112026.csv'));
    assert.strictEqual(extracted, sampleMcapCsv, 'extractEntryFromZipBuffer must extract non-first matching entry cleanly');
    assert.strictEqual(bhavcopyDownloader.validateNseMcapCsvContent(extracted, '2026-11-27').ok, true);
    assert.strictEqual(bhavcopyDownloader.validateNseMcapCsvContent(extracted, '2026-11-26').ok, false);

    const tmpMcapDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mb-mcap-test-'));
    try {
      fs.writeFileSync(path.join(tmpMcapDir, 'mcap27112026.csv'), sampleMcapCsv, 'utf8');
      const parsedArchive = marketCap.loadNseOfficialMcapArchive(tmpMcapDir, '2026-11-27');
      assert.strictEqual(parsedArchive.loaded, true);
      assert.strictEqual(parsedArchive.rowCount, 2, 'Summary footer row "Total" must be ignored while company TOTAL stays');
      assert.strictEqual(parsedArchive.bySymbol.get('TOTAL')?.capCr, 131.52);
    } finally {
      fs.rmSync(tmpMcapDir, { recursive: true, force: true });
    }

    assert.strictEqual(marketCap.classifyEquityInstrumentType({ isin: 'INE546Y20048', symbol: 'PRAXIS-RE3' }), 'RIGHTS_ENTITLEMENT');
    assert.strictEqual(marketCap.classifyEquityInstrumentType({ isin: 'IN9903A01015', symbol: 'JAYKAYPP' }), 'PARTLY_PAID');
    assert.strictEqual(marketCap.classifyEquityInstrumentType({ isin: 'IN9641R03011', symbol: 'QDLCCPS' }), 'PREFERENCE_SHARES');
    assert.strictEqual(marketCap.classifyEquityInstrumentType({ isin: 'IN9175A01010', symbol: 'JISLDVREQS' }), 'DVR_EQUITY');
    assert.strictEqual(marketCap.classifyEquityInstrumentType({ isin: 'INE002A01018', symbol: 'RELIANCE' }), 'COMMON_EQUITY');

    const mockSourcesWithOfficial = {
      sourceDates: { NSE_OFFICIAL_MCAP: '2026-11-27', INDIA_API_ISIN: '2026-11-25' },
      nseOfficialBySymbol: new Map([
        ['PRAXIS-RE3', { symbol: 'PRAXIS-RE3', series: 'BE', capCr: 0.21, issueSize: 1000, asOfDate: '2026-11-27' }],
        ['MAHACOAL', { symbol: 'MAHACOAL', series: 'EQ', capCr: 87693.31, issueSize: 6618363000, asOfDate: '2026-11-27' }]
      ]),
      nseOfficialBySymbolSeries: new Map([
        ['PRAXIS-RE3:BE', { symbol: 'PRAXIS-RE3', series: 'BE', capCr: 0.21, issueSize: 1000, asOfDate: '2026-11-27' }],
        ['MAHACOAL:EQ', { symbol: 'MAHACOAL', series: 'EQ', capCr: 87693.31, issueSize: 6618363000, asOfDate: '2026-11-27' }]
      ]),
      benchmarkBySymbol: new Map(),
      bseSecByIsin: new Map(),
      catalogByIsin: new Map([['IN9903A01015', { capCr: 3379.99, asOfDate: '2026-11-25' }]]),
      catalogByTicker: new Map(),
      screenerBySlug: new Map(),
      screenerMetaBySlug: new Map()
    };

    const reResolved = marketCap.resolveStockMarketCap(
      { isin: 'INE546Y20048', symbol: 'PRAXIS-RE3', nse_symbol: 'PRAXIS-RE3', exchanges: ['NSE', 'BSE'], series: 'BE', current_price: 2.0 },
      mockSourcesWithOfficial,
      { market_cap_cr: 99, total_outstanding_shares: 1000 }
    );
    assert.strictEqual(reResolved.market_cap_cr, null, 'Rights Entitlement must stay strictly null even if present in mcap archive');

    const ppResolved = marketCap.resolveStockMarketCap(
      { isin: 'IN9903A01015', symbol: 'JAYKAYPP', bse_scrip_code: '890123', exchanges: ['BSE'], series: 'B', current_price: 100 },
      mockSourcesWithOfficial,
      { market_cap_cr: 3379.99, total_outstanding_shares: 1000 }
    );
    assert.strictEqual(ppResolved.market_cap_cr, null, 'Partly-paid share must stay null and reject stale parent ISIN cap');

    const mahaResolved = marketCap.resolveStockMarketCap(
      { isin: 'INE000A01011', symbol: 'MAHACOAL', nse_symbol: 'MAHACOAL', exchanges: ['NSE'], series: 'EQ', current_price: 132.5, trading_date: '2026-11-27' },
      mockSourcesWithOfficial
    );
    assert.strictEqual(mahaResolved.market_cap_cr, 87693.31);
    assert.strictEqual(mahaResolved.market_cap_source, 'NSE_OFFICIAL_MCAP');
    assert.strictEqual(mahaResolved.total_outstanding_shares, 6618363000);
  }

  // 12. Status API surfaces calendarVerified and calendarWarning cleanly
  {
    const statusReq = { method: 'GET', url: '/api/market/status', headers: { host: '127.0.0.1' }, socket: { remoteAddress: '127.0.0.1' } };
    const statusRes = makeMockRes();
    await localServer.handleRequest(statusReq, statusRes);
    const statusOut = statusRes.getResult();
    assert.strictEqual(statusOut.statusCode, 200);
    assert.strictEqual(typeof statusOut.body.calendarVerified, 'boolean');
    assert.ok(statusOut.body.calendarWarning === null || typeof statusOut.body.calendarWarning === 'string');

    const vercelStatusRes = makeMockRes();
    await statusApi({ method: 'GET', headers: {} }, vercelStatusRes);
    const vercelOut = vercelStatusRes.getResult();
    assert.strictEqual(vercelOut.statusCode, 200);
    assert.strictEqual(vercelOut.body.calendarVerified, statusOut.body.calendarVerified);
  }

  // 13. Production refresh authorization fails closed when REFRESH_API_SECRET is missing
  {
    const failClosedAuth = authorizeRefreshRequest(
      { headers: { origin: 'https://machii-bazzar.vercel.app' } },
      { allowCustomOrigin: true, requireSecret: true, refreshSecret: '' }
    );
    assert.strictEqual(failClosedAuth.ok, false);
    assert.strictEqual(failClosedAuth.statusCode, 503);

    const prevVercel = process.env.VERCEL;
    const prevRefreshSecret = process.env.REFRESH_API_SECRET;
    process.env.VERCEL = '1';
    delete process.env.REFRESH_API_SECRET;
    try {
      const prodMisconfigRes = makeMockRes();
      await refreshApi(
        { method: 'POST', headers: { 'x-forwarded-for': '198.51.100.88' } },
        prodMisconfigRes,
        { rateLimiter: new SlidingWindowRateLimiter({ windowMs: 60000, maxRequests: 10 }) }
      );
      const out = prodMisconfigRes.getResult();
      assert.strictEqual(out.statusCode, 503, 'Production refresh must fail closed (503) when REFRESH_API_SECRET is missing');
      assert.strictEqual(out.body.ok, false);
      assert.strictEqual(out.body.status, 'misconfigured');
    } finally {
      if (prevVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = prevVercel;
      if (prevRefreshSecret === undefined) delete process.env.REFRESH_API_SECRET;
      else process.env.REFRESH_API_SECRET = prevRefreshSecret;
    }
  }

  // 14. Frontend UI/UX Layout, Sector Dropdown Coverage, Human-Readable Labels & CSP Safety
  {
    const indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const stockHtml = fs.readFileSync(path.join(ROOT, 'stock.html'), 'utf8');
    const pageCss = fs.readFileSync(path.join(ROOT, 'css', 'page-layout.css'), 'utf8');
    const stockCss = fs.readFileSync(path.join(ROOT, 'css', 'stock-details.css'), 'utf8');
    const stockDetailsJs = fs.readFileSync(path.join(ROOT, 'js', 'stock-details.js'), 'utf8');

    // Group A (screening) & Group B (sector selector) structure
    assert.ok(indexHtml.includes('class="filter-group filter-group-screening"'), 'index.html must separate Group A screening filters');
    assert.ok(indexHtml.includes('id="sector-picker"'), 'index.html must include Group B sector dropdown picker');
    assert.ok(indexHtml.includes('id="sector-dropdown-menu"'), 'index.html must include sector listbox menu');
    assert.ok(pageCss.includes('.sector-dropdown-menu'), 'page-layout.css must style sector dropdown menu');

    // Every unique dataset sector must appear in the sector selector menu
    const dataset = queryService.loadDataset();
    const datasetSectors = [...new Set(dataset.stocks.map(s => s.sector).filter(Boolean))];
    assert.strictEqual(datasetSectors.length, 18, `Expected 18 unique dataset sectors, got ${datasetSectors.length}`);
    for (const sector of datasetSectors) {
      const encoded = sector.replace(/&/g, '&amp;');
      assert.ok(
        indexHtml.includes(`data-sector="${sector}"`) || indexHtml.includes(`data-sector="${encoded}"`),
        `index.html sector dropdown is missing dataset sector: ${sector}`
      );
    }

    // Stock detail independent 2-column desktop + mobile stack order + no misleading 50% range bar
    assert.ok(stockHtml.includes('class="stock-detail-col-left"'), 'stock.html must include independent left column');
    assert.ok(stockHtml.includes('class="stock-detail-col-right"'), 'stock.html must include independent right column');
    assert.ok(stockHtml.includes('id="company-description-block"'), 'stock.html must render full-width company description block');
    assert.ok(stockHtml.includes('id="stock-history-toggle"'), 'stock.html must render expandable price history toggle');
    assert.ok(!stockHtml.includes('width: 50%'), 'stock.html must not hardcode misleading 50% fill width');
    assert.ok(!stockHtml.includes('left: 50%'), 'stock.html must not hardcode misleading 50% pin offset');
    assert.ok(!/<svg\b/i.test(stockHtml), 'stock.html must remain SVG-free');
    assert.ok(!/<svg\b/i.test(stockDetailsJs), 'js/stock-details.js must remain SVG-free');

    // CSS rules for desktop 2-col, mobile stacking order, sticky history & hairline 8-cell grid
    assert.ok(stockCss.includes('@media (max-width: 899px)'), 'stock-details.css must define <900px responsive stack');
    assert.ok(stockCss.includes('.stock-history-table-wrap.is-expanded'), 'stock-details.css must bound expanded history height');
    assert.ok(stockCss.includes('position: sticky'), 'stock-details.css must keep expanded history header sticky');
    assert.ok(stockCss.includes('.exchange-cards-row.is-dual'), 'stock-details.css must support balanced dual exchange grid');
    assert.ok(stockCss.includes('@media (max-width: 520px)'), 'stock-details.css must retain small-screen breakpoint');

    // JS source mapping, 10-row default & dual/single exchange balance classes
    for (const rawKey of [
      'NSE_OFFICIAL_MCAP',
      'BSE_SECURITY_MASTER',
      'CALCULATED_OUTSTANDING_SHARES',
      'INDIA_API_ISIN',
      'INDIA_API_TICKER',
      'SCREENER_DATASET',
      'BENCHMARK_VERIFIED',
      'PREVIOUS_SESSION_VERIFIED'
    ]) {
      assert.ok(stockDetailsJs.includes(rawKey), `js/stock-details.js must explicitly map internal key ${rawKey} to readable text`);
    }
    assert.ok(stockDetailsJs.includes("cleanKey.includes('_') ? 'Verified Financial Reference'"), 'js/stock-details.js must sanitize unmapped underscore source keys');
    assert.ok(stockDetailsJs.includes('DEFAULT_HISTORY_ROWS = 10'), 'js/stock-details.js must default recent price history to 10 rows');
    assert.ok(stockDetailsJs.includes("' is-dual' : ' is-single'"), 'js/stock-details.js must apply balanced dual/single exchange classes');
  }
}

module.exports = {
  name: 'audit-regression.test.js',
  run
};
