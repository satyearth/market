'use strict';

const { loadMarketStatsAsync } = require('../../src/query/stock-query-service');
const { checkSessionFreshness } = require('../../src/calendar/exchange-calendar');
const {
  applySecurityHeaders,
  getClientIp,
  sharedRefreshRateLimiter,
  authorizeRefreshRequest
} = require('../../src/server/security-utils');

module.exports = async function marketRefreshApi(req, res, options = {}) {
  applySecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, status: 'method_not_allowed', error: 'Method not allowed.' });
  }

  const isProductionRuntime = Boolean(process.env.VERCEL || process.env.NODE_ENV === 'production');
  const auth = authorizeRefreshRequest(req, {
    ...options,
    allowCustomOrigin: true,
    requireSecret: options.requireSecret ?? isProductionRuntime
  });
  if (!auth.ok) {
    const statusLabel = auth.statusCode === 503
      ? 'misconfigured'
      : (auth.statusCode === 401 ? 'unauthorized' : 'forbidden');
    return res.status(auth.statusCode).json({ ok: false, status: statusLabel, error: auth.error });
  }

  const limiter = options.rateLimiter || sharedRefreshRateLimiter;
  const rate = limiter.check(getClientIp(req));
  res.setHeader('X-RateLimit-Limit', String(rate.limit));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    return res.status(429).json({ ok: false, status: 'rate_limited', error: 'Too many refresh requests. Please try again shortly.' });
  }

  try {
    const loadStats = options.loadMarketStatsAsync || loadMarketStatsAsync;
    const { stats, storageSource, storageVersionId } = await loadStats({ force: true });
    const currentTradingDate = stats?.tradingDate || null;
    const freshness = checkSessionFreshness(currentTradingDate);

    if (!freshness.isFresh) {
      return res.status(503).json({
        ok: false,
        status: 'sync_unavailable',
        message: 'This serverless endpoint reads from external storage; automated daily updates are published by GitHub Actions without requiring a Vercel redeployment.',
        tradingDate: currentTradingDate,
        latestExpectedDate: freshness.latestExpectedDate,
        freshnessStatus: freshness.freshnessStatus,
        isDelayed: freshness.isDelayed,
        isStale: freshness.isStale,
        refreshedAtUtc: stats?.refreshedAtUtc || null,
        istDisplayTime: stats?.istDisplayTime || null,
        storageSource,
        storageVersionId
      });
    }

    return res.status(200).json({
      ok: true,
      status: 'up_to_date',
      message: freshness.reason,
      tradingDate: currentTradingDate,
      istDisplayTime: stats?.istDisplayTime || null,
      refreshedAtUtc: stats?.refreshedAtUtc || null,
      freshnessStatus: freshness.freshnessStatus,
      latestExpectedDate: freshness.latestExpectedDate,
      storageSource,
      storageVersionId
    });
  } catch (err) {
    console.error('Market refresh API error:', err);
    return res.status(500).json({
      ok: false,
      status: 'error',
      error: 'Unable to check market refresh status right now.'
    });
  }
};
