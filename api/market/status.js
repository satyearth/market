'use strict';

const fs = require('fs');
const path = require('path');
const { checkSessionFreshness, getLatestExpectedTradingDate, getIstTime } = require('../../scripts/exchange-calendar');

const STOCKS_DATA_PATH = path.join(process.cwd(), 'js', 'stocks-data.js');

function readMarketStatsFromDataset() {
  try {
    if (!fs.existsSync(STOCKS_DATA_PATH)) return null;
    const content = fs.readFileSync(STOCKS_DATA_PATH, 'utf-8');
    const match = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch (err) {
    console.error('Error reading MARKET_STATS from dataset:', err.message);
    return null;
  }
}

module.exports = function marketStatusApi(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const stats = readMarketStatsFromDataset();
    const currentTradingDate = stats?.tradingDate || '2026-11-04';
    const freshness = checkSessionFreshness(currentTradingDate);

    const payload = {
      ok: true,
      isSyncing: false,
      tradingDate: currentTradingDate,
      istDisplayTime: stats?.istDisplayTime,
      refreshedAtUtc: stats?.refreshedAtUtc,
      stockCount: stats?.stockCount || 5389,
      isUpToDate: freshness.isFresh,
      needsSync: freshness.needsSync,
      reason: freshness.reason,
      marketCalendar: getLatestExpectedTradingDate(),
      changeLogSummary: stats?.changeLogSummary || null
    };

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Market status API error:', err.message);
    return res.status(500).json({ ok: false, error: 'Unable to check market status' });
  }
};
