'use strict';

const { queryStockHistoryAsync } = require('../../src/query/stock-query-service');

module.exports = async function marketHistoryApi(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const payload = await queryStockHistoryAsync(req.query || {});
    if (!payload.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(payload.statusCode || 400).json({ ok: false, error: payload.error });
    }
    res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Market history API error:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ok: false, error: 'Unable to load historical price data.' });
  }
};
