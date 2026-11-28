'use strict';

const crypto = require('crypto');

/**
 * Shared HTTP Security Headers, Sliding-Window Rate Limiter & Error Sanitizer
 *
 * Provides one source of truth for CSP, security headers, client IP extraction,
 * sliding-window rate limiting, and sanitized JSON errors across both local
 * development server and Vercel serverless API handlers.
 */

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https://api.dharun.dev",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'"
].join('; ');

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
});

function applySecurityHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function getClientIp(req) {
  const xff = req?.headers?.['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim();
  }
  if (Array.isArray(xff) && xff.length > 0 && xff[0]) {
    return String(xff[0]).split(',')[0].trim();
  }
  const realIp = req?.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }
  return String(req?.socket?.remoteAddress || '127.0.0.1');
}

class SlidingWindowRateLimiter {
  constructor(options = {}) {
    this.windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
      ? options.windowMs
      : 10000;
    this.maxRequests = Number.isFinite(options.maxRequests) && options.maxRequests > 0
      ? options.maxRequests
      : 240;
    this.maxTrackedKeys = Number.isFinite(options.maxTrackedKeys) && options.maxTrackedKeys > 0
      ? options.maxTrackedKeys
      : 5000;
    this.buckets = new Map();
  }

  check(key, now = Date.now()) {
    const bucketKey = String(key || 'anonymous');
    const windowStart = now - this.windowMs;
    let timestamps = this.buckets.get(bucketKey);

    if (timestamps) {
      let firstValid = 0;
      while (firstValid < timestamps.length && timestamps[firstValid] <= windowStart) {
        firstValid++;
      }
      if (firstValid > 0) {
        timestamps = timestamps.slice(firstValid);
      }
    } else {
      timestamps = [];
    }

    if (timestamps.length >= this.maxRequests) {
      this.buckets.set(bucketKey, timestamps);
      const oldest = timestamps[0] || now;
      const resetMs = Math.max(100, (oldest + this.windowMs) - now);
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetMs,
        retryAfterSec: Math.max(1, Math.ceil(resetMs / 1000))
      };
    }

    timestamps.push(now);
    this.buckets.set(bucketKey, timestamps);
    if (this.buckets.size > this.maxTrackedKeys) {
      this.prune(now);
    }

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: Math.max(0, this.maxRequests - timestamps.length),
      resetMs: this.windowMs,
      retryAfterSec: 0
    };
  }

  prune(now = Date.now()) {
    const windowStart = now - this.windowMs;
    for (const [k, ts] of this.buckets.entries()) {
      if (!ts.length || ts[ts.length - 1] <= windowStart) {
        this.buckets.delete(k);
      }
    }
    while (this.buckets.size > this.maxTrackedKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }

  reset() {
    this.buckets.clear();
  }
}

const sharedStocksRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 10 * 1000,
  maxRequests: 240
});

const sharedRefreshRateLimiter = new SlidingWindowRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10
});

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

function timingSafeSecretEqual(provided, expected) {
  if (!provided || !expected) return false;
  const hA = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const hB = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(hA, hB);
}

function authorizeRefreshRequest(req, options = {}) {
  const origin = req?.headers?.origin;
  if (origin && !LOCAL_ORIGIN_RE.test(String(origin).trim())) {
    if (!options.allowCustomOrigin) {
      return { ok: false, statusCode: 403, error: 'Cross-origin refresh requests are forbidden.' };
    }
  }

  const configuredSecret = String(
    options.refreshSecret !== undefined
      ? (options.refreshSecret || '')
      : (process.env.REFRESH_API_SECRET || '')
  ).trim();

  if (!configuredSecret) {
    if (options.requireSecret) {
      return {
        ok: false,
        statusCode: 503,
        error: 'Refresh authorization secret is not configured.'
      };
    }
    return { ok: true };
  }

  const authHeader = String(req?.headers?.authorization || '').trim();
  const bearer = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const customHeader = String(req?.headers?.['x-refresh-secret'] || '').trim();
  const candidate = bearer || customHeader;
  if (!candidate || !timingSafeSecretEqual(candidate, configuredSecret)) {
    return { ok: false, statusCode: 401, error: 'Unauthorized refresh request.' };
  }

  return { ok: true };
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  applySecurityHeaders,
  getClientIp,
  SlidingWindowRateLimiter,
  sharedStocksRateLimiter,
  sharedRefreshRateLimiter,
  LOCAL_ORIGIN_RE,
  authorizeRefreshRequest
};
