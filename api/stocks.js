'use strict';

const { queryStocksAsync } = require('../src/query/stock-query-service');
const {
  applySecurityHeaders,
  getClientIp,
  sharedStocksRateLimiter
} = require('../src/server/security-utils');

module.exports = async function stocksApi(req, res, options = {}) {
  applySecurityHeaders(res);

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    res.setHeader('Cache-Control', 'no-store');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  const limiter = options.rateLimiter || sharedStocksRateLimiter;
  const rate = limiter.check(getClientIp(req));
  res.setHeader('X-RateLimit-Limit', String(rate.limit));
  res.setHeader('X-RateLimit-Remaining', String(rate.remaining));
  if (!rate.allowed) {
    res.setHeader('Retry-After', String(rate.retryAfterSec));
    res.setHeader('Cache-Control', 'no-store');
    res.status(429).json({ ok: false, error: 'Too many requests. Please slow down and try again shortly.' });
    return;
  }

  try {
    const payload = await queryStocksAsync(req.query || {}, options);
    res.setHeader('Cache-Control', 'no-store');
    if (!payload.ok) {
      res.status(payload.statusCode || 400).json({ ok: false, error: payload.error || 'Invalid query parameters.' });
      return;
    }
    res.status(200).json(payload);
  } catch (err) {
    console.error('Stock page query failed:', err.message);
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({ ok: false, error: 'Unable to load stocks right now.' });
  }
};
