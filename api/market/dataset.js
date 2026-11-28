'use strict';

const { loadMarketStatsAsync } = require('../../src/query/stock-query-service');
const { checkSessionFreshness } = require('../../src/calendar/exchange-calendar');
const { applySecurityHeaders } = require('../../src/server/security-utils');

module.exports = async function marketDatasetApi(req, res) {
  applySecurityHeaders(res);
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const { stats, manifest, storageSource, storageVersionId } = await loadMarketStatsAsync();
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
      historicalDataset: manifest?.historicalDataset || stats?.historicalDataset || null,
      isSyncing: false
    });
  } catch (err) {
    console.error('Market dataset API error:', err);
    return res.status(500).json({ ok: false, error: 'Unable to load market dataset metadata.' });
  }
};
