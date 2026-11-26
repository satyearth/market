'use strict';

const { loadMarketStatsAsync } = require('../../src/query/stock-query-service');
const { checkSessionFreshness, getLatestExpectedTradingDate } = require('../../src/calendar/exchange-calendar');

module.exports = async function marketStatusApi(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync();
    const currentTradingDate = stats?.tradingDate || null;
    const freshness = checkSessionFreshness(currentTradingDate);
    const marketCalendar = getLatestExpectedTradingDate();

    const payload = {
      ok: true,
      canTriggerSync: false,
      isSyncing: false,
      tradingDate: currentTradingDate,
      istDisplayTime: stats?.istDisplayTime || null,
      refreshedAtUtc: stats?.refreshedAtUtc || null,
      nseSourceDate: stats?.nseSourceDate || currentTradingDate,
      bseSourceDate: stats?.bseSourceDate || currentTradingDate,
      stockCount: stats?.stockCount || stats?.totalStocks || null,
      pipelineVersion: stats?.pipelineVersion || null,
      storageSource,
      storageVersionId,
      isUpToDate: freshness.isFresh,
      needsSync: freshness.needsSync,
      freshnessStatus: freshness.freshnessStatus,
      isDelayed: freshness.isDelayed,
      isStale: freshness.isStale,
      missingSessionsCount: freshness.missingSessionsCount,
      latestExpectedDate: freshness.latestExpectedDate,
      latestDownloadedDate: stats?.pipelineDates?.latestDownloadedDate || currentTradingDate,
      latestProcessedDate: stats?.pipelineDates?.latestProcessedDate || currentTradingDate,
      latestPublishedDate: currentTradingDate,
      reason: freshness.reason,
      marketCalendar,
      changeLogSummary: stats?.changeLogSummary || null
    };

    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Market status API error:', err.message);
    return res.status(500).json({ ok: false, error: 'Unable to check market status' });
  }
};
