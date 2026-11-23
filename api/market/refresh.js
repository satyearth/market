'use strict';

const fs = require('fs');
const path = require('path');
const { checkSessionFreshness } = require('../../scripts/exchange-calendar');

const STOCKS_DATA_PATH = path.join(process.cwd(), 'js', 'stocks-data.js');

function readMarketStatsFromDataset() {
  try {
    if (!fs.existsSync(STOCKS_DATA_PATH)) return null;
    const content = fs.readFileSync(STOCKS_DATA_PATH, 'utf-8');
    const match = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
    if (!match) return null;
    return JSON.parse(match[1]);
  } catch (err) {
    return null;
  }
}

module.exports = function marketRefreshApi(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, status: 'method_not_allowed', error: 'Method not allowed.' });
  }
  const stats = readMarketStatsFromDataset();
  const currentTradingDate = stats?.tradingDate || null;
  const freshness = checkSessionFreshness(currentTradingDate);

  res.setHeader('Cache-Control', 'no-store');
  if (!freshness.isFresh) {
    return res.status(503).json({
      ok: false,
      status: 'sync_unavailable',
      message: 'This Vercel endpoint cannot rebuild the stock dataset. The last verified EOD dataset is still being shown.',
      tradingDate: currentTradingDate,
      latestExpectedDate: freshness.latestExpectedDate,
      istDisplayTime: stats?.istDisplayTime
    });
  }
  return res.status(200).json({
    ok: true,
    status: 'up_to_date',
    message: freshness.reason,
    tradingDate: currentTradingDate,
    istDisplayTime: stats?.istDisplayTime,
    latestExpectedDate: freshness.latestExpectedDate
  });
};
