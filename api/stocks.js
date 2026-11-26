'use strict';

const { queryStocksAsync } = require('../src/query/stock-query-service');

module.exports = async function stocksApi(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  try {
    const payload = await queryStocksAsync(req.query || {});
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  } catch (err) {
    console.error('Stock page query failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ ok: false, error: 'Unable to load stocks right now.' });
  }
};
