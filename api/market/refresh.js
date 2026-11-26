'use strict';

const { loadMarketStatsAsync } = require('../../src/query/stock-query-service');
const { checkSessionFreshness } = require('../../src/calendar/exchange-calendar');

module.exports = async function marketRefreshApi(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, status: 'method_not_allowed', error: 'Method not allowed.' });
  }

  const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync({ force: true });
  const currentTradingDate = stats?.tradingDate || null;
  const freshness = checkSessionFreshness(currentTradingDate);

  res.setHeader('Cache-Control', 'no-store');
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
};
