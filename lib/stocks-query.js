'use strict';

const fs = require('fs');
const path = require('path');
const DATA_PATH = path.join(__dirname, '..', 'js', 'stocks-data.js');
let cached = null;

function loadDataset() {
  const stat = fs.statSync(DATA_PATH);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.data;
  const source = fs.readFileSync(DATA_PATH, 'utf8');
  const statsMatch = source.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*const STOCKS_DATA = /);
  const stocksMatch = source.match(/const STOCKS_DATA = (\[[\s\S]*\]);\s*$/);
  if (!statsMatch || !stocksMatch) throw new Error('Stock dataset format is invalid');
  const data = { stats: JSON.parse(statsMatch[1]), stocks: JSON.parse(stocksMatch[1]) };
  const seen = new Set();
  data.stocks = data.stocks.filter(stock => {
    const isin = String(stock.isin || '').trim().toUpperCase();
    if (!isin || seen.has(isin)) return false;
    seen.add(isin);
    stock.isin = isin;
    return true;
  });
  cached = { mtimeMs: stat.mtimeMs, size: stat.size, data };
  return data;
}

const aliases = {
  zomato: 'ETERNAL', blinkit: 'ETERNAL', policybazaar: 'POLICYBZR',
  paisabazaar: 'POLICYBZR', maggi: 'NESTLEIND', jlr: 'TATAMOTORS', jaguar: 'TATAMOTORS'
};
const sortable = new Set(['rank', 'symbol', 'current_price', 'change_percent', 'market_cap_cr', 'return_1w', 'return_1m', 'return_3m', 'volume_ratio']);

function searchMatches(stock, query) {
  if (!query) return true;
  const q = query.toLowerCase().trim();
  const norm = q.replace(/[^a-z0-9]/g, '');
  const alias = aliases[q] || aliases[norm];
  if (alias && (stock.symbol === alias || stock.nse_symbol === alias)) return true;
  return ['symbol', 'company_name', 'nse_symbol', 'bse_scrip_code', 'isin', 'sector', 'industry']
    .some(key => String(stock[key] || '').toLowerCase().includes(q)) || (norm.length >= 2 &&
      ['symbol', 'company_name', 'nse_symbol'].some(key => String(stock[key] || '').toLowerCase().replace(/[^a-z0-9]/g, '').includes(norm)));
}

function queryStocks(params = {}) {
  const { stocks, stats } = loadDataset();
  const limit = Math.min(50, Math.max(1, Number.parseInt(params.limit, 10) || 50));
  const offset = Math.max(0, Number.parseInt(params.offset, 10) || 0);
  const search = String(params.search || '').slice(0, 120);
  const filter = String(params.filter || 'ALL').toUpperCase();
  const exchange = String(params.exchange || '').toUpperCase();
  const sort = sortable.has(params.sort) ? params.sort : 'market_cap_cr';
  const direction = String(params.direction || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  let results = stocks.filter(s => {
    if (!searchMatches(s, search)) return false;
    if (exchange && !(Array.isArray(s.exchanges) && s.exchanges.includes(exchange))) return false;
    if (filter === 'TOP GAINERS' && !(Number(s.change_percent) > 0 || (s.prev_close != null && Number(s.current_price) > Number(s.prev_close)))) return false;
    if (filter === 'TOP LOSERS' && !(Number(s.change_percent) < 0 || (s.prev_close != null && Number(s.current_price) < Number(s.prev_close)))) return false;
    if (filter === 'NEAR 52W HIGH' && !(s.is_near_high || (s.pct_from_high && Number(s.pct_from_high) >= -8))) return false;
    return true;
  });
  const useCategoryOrder = (filter === 'TOP GAINERS' || filter === 'TOP LOSERS') && String(params.sortOverride).toLowerCase() !== 'true';
  if (!useCategoryOrder) {
    results.sort((a, b) => {
      const x = a[sort], y = b[sort];
      if (x == null && y != null) return 1;
      if (x != null && y == null) return -1;
      if (x == null && y == null) return String(a.isin).localeCompare(String(b.isin));
      const cmp = typeof x === 'string' ? String(x).localeCompare(String(y), undefined, { sensitivity: 'base' }) : Number(x) - Number(y);
      return (cmp || String(a.isin).localeCompare(String(b.isin))) * direction;
    });
  } else {
    results.sort((a, b) => (Number(a.change_percent || 0) - Number(b.change_percent || 0) || String(a.isin).localeCompare(String(b.isin))) * (filter === 'TOP GAINERS' ? -1 : 1));
  }
  return { ok: true, stocks: results.slice(offset, offset + limit), offset, nextOffset: Math.min(offset + limit, results.length), limit, total: results.length, hasMore: offset + limit < results.length, stats };
}

module.exports = { loadDataset, queryStocks };
