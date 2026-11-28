'use strict';

const { loadMarketStatsAsync } = require('../src/query/stock-query-service');
const { checkSessionFreshness } = require('../src/calendar/exchange-calendar');
const storage = require('../src/storage/supabase-storage');
const { applySecurityHeaders } = require('../src/server/security-utils');

module.exports = async function healthApi(req, res) {
  applySecurityHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync();
    const tradingDate = stats?.tradingDate || null;
    const freshness = checkSessionFreshness(tradingDate);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(stats ? 200 : 503).json({
      ok: Boolean(stats),
      status: stats ? (freshness.isFresh ? 'healthy' : freshness.freshnessStatus) : 'degraded',
      tradingDate,
      stockCount: stats?.stockCount || stats?.totalStocks || null,
      isUpToDate: freshness.isFresh,
      freshnessStatus: freshness.freshnessStatus,
      storageSource,
      storageVersionId,
      storageConfigured: {
        read: storage.isReadConfigured(),
        write: storage.isWriteConfigured()
      },
      timestampUtc: new Date().toISOString()
    });
  } catch (err) {
    console.error('Health API error:', err);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ok: false, status: 'error', error: 'Unable to determine health status.' });
  }
};
