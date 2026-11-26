'use strict';

const { loadMarketStatsAsync } = require('../../src/query/stock-query-service');
const { checkSessionFreshness } = require('../../src/calendar/exchange-calendar');

module.exports = async function marketDatasetApi(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { stats, storageSource, storageVersionId } = await loadMarketStatsAsync();
    if (!stats) {
      return res.status(404).json({ ok: false, error: 'Dataset not found' });
    }
    const freshness = checkSessionFreshness(stats.tradingDate || null);
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    return res.status(200).json({
      ok: true,
      stats,
      freshness,
      storageSource,
      storageVersionId,
      isSyncing: false
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
