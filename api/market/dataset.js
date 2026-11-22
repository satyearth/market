'use strict';

const fs = require('fs');
const path = require('path');
const STOCKS_DATA_PATH = path.join(process.cwd(), 'js', 'stocks-data.js');

module.exports = function marketDatasetApi(req, res) {
  try {
    if (!fs.existsSync(STOCKS_DATA_PATH)) {
      return res.status(404).json({ ok: false, error: 'Dataset not found' });
    }
    const content = fs.readFileSync(STOCKS_DATA_PATH, 'utf-8');
    const match = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
    const stats = match ? JSON.parse(match[1]) : null;
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ ok: true, stats, isSyncing: false });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
