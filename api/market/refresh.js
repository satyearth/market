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
  const stats = readMarketStatsFromDataset();
  const currentTradingDate = stats?.tradingDate || '2026-11-04';
  const freshness = checkSessionFreshness(currentTradingDate);

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    status: freshness.isFresh ? 'up_to_date' : 'updated',
    message: freshness.reason,
    tradingDate: currentTradingDate,
    istDisplayTime: stats?.istDisplayTime
  });
};
