# Machii Bazzar v2.0.0 — Security Audit & Hardening Report

**Audit Date:** 2026-11-28  
**Target Version:** Machii Bazzar v2.0.0  
**Primary Audit Sources:** `MASTER_PROJECT_BLUEPRINT.md` and direct repository source inspection (`Pasted text(3).txt` was not present in the workspace).

---

## 1. Executive Security Summary

All confirmed **SEC-001 through SEC-004** security hardening requirements and Supabase distributed lock fail-closed guarantees have been implemented, regression-tested in [`tests/audit-regression.test.js`](../tests/audit-regression.test.js), and verified locally against `npm run lint`, `npm test`, and headless Chromium Playwright execution with zero CSP violations.

| ID | Area | Finding Classification | Status | Primary Files Modified |
| :--- | :--- | :--- | :--- | :--- |
| **SEC-001** | HTTP/Redirect SSRF & Downgrade Protection | Confirmed Vulnerability / Hardened | Implemented & Verified | [`src/ingestion/http-client.js`](../src/ingestion/http-client.js) |
| **SEC-002** | Public API Input Validation, Abuse Limits & Data Exposure | Confirmed Vulnerability / Hardened | Implemented & Verified | [`api/stocks.js`](../api/stocks.js), [`src/query/stock-query-service.js`](../src/query/stock-query-service.js), [`src/server/security-utils.js`](../src/server/security-utils.js), [`src/server/local-server.js`](../src/server/local-server.js) |
| **SEC-003** | Unhandled Async Rejections, Blocking Local Sync & Raw Error Leaks | Confirmed Defect / Hardened | Implemented & Verified | [`api/market/refresh.js`](../api/market/refresh.js), [`api/health.js`](../api/health.js), [`api/market/dataset.js`](../api/market/dataset.js), [`src/server/local-server.js`](../src/server/local-server.js) |
| **SEC-004** | HTTP Security Headers, Strict CSP & Inline Event Elimination | Confirmed Hardening Gap / Fixed | Implemented & Verified | [`vercel.json`](../vercel.json), [`src/server/security-utils.js`](../src/server/security-utils.js), [`src/server/local-server.js`](../src/server/local-server.js), [`js/company-logo.js`](../js/company-logo.js) |
| **LOCK-001** | Supabase Distributed Lock Fail-Open & Release Race | Confirmed Concurrency Risk / Hardened | Implemented & Verified (Mocked HTTP) | [`src/storage/supabase-storage.js`](../src/storage/supabase-storage.js) |

---

## 2. Detailed Control Verification

### SEC-001 — Ingestion HTTPS & Redirect Allowlist Enforcement
- **Previous Gap:** `httpGetBuffer()` in `src/ingestion/http-client.js` accepted `http:` schemes, arbitrary ports, IP literals/private addresses, and blindly followed HTTP `301`/`302`/`303`/`307`/`308` redirects using only a hop decrement (`maxRedirects <= 0`).
- **Fix Implemented:**
  - Enforced strict HTTPS (`parsed.protocol === 'https:'`) in `validateRequestUrl()`.
  - Defined explicit trusted host allowlist (`DEFAULT_ALLOWED_HOST_SUFFIXES`: `nseindia.com`, `bseindia.com`, `dharun.dev`, `supabase.co`).
  - Blocked embedded URL credentials, non-443 ports, `localhost`/`.local`/`.internal`/`.localdomain`, IPv4/IPv6 literals (`net.isIP`), and hex/octal/integer IPv4 forms in `isDisallowedIpOrInternalHost()`.
  - Re-validated every redirect hop before dispatching the follow-up request and tracked canonical URLs via `_visitedUrls` (`Set`) to abort redirect loops immediately.
  - Preserved `shouldUseInsecureHttpParser()` scoped strictly to `bseindia.com` subdomains for official BSE BhavCopy responses.
- **Verification:** `tests/audit-regression.test.js` verifies rejections for `http://`, `127.0.0.1`, port `8443`, `evil.example.com`, 302 redirects to `169.254.169.254` and `attacker.com`, and `A -> B -> A` loops, plus success for valid `nsearchives.nseindia.com` -> `www.nseindia.com` HTTPS redirects.

### SEC-002 — Public `/api/stocks` Validation, 200-ISIN Cap, Rate Limiting & List Projection
- **Previous Gap:** `executeStockQuery()` coerced invalid numbers/filters silently, allowed unbounded comma-separated `isins`, rebuilt `new Set(...)` inside every filter iteration, returned inline 90-session `historical_prices` in local file mode, and had no request rate limiting.
- **Fix Implemented:**
  - Added `validateAndNormalizeStockQuery(params)` in `src/query/stock-query-service.js`:
    - Rejects malformed/array/object parameters, control characters, >20 parameters, `search > 200` chars, invalid `limit`/`offset`, unknown `filter`/`exchange`/`sort`/`direction`, invalid boolean flags, and invalid 12-character ISIN formats with HTTP `400`.
    - Caps `isins` to at most `200` valid ISIN entries (`MAX_WATCHLIST_ISINS = 200`) and validates every entry cleanly.
    - Clamps numeric valid `limit` (`1..1000`) to max `50` page size (`test-infinite-scroll.js` & `api-and-query.test.js` compatibility preserved).
  - Hoisted `watchlistIsinSet` outside `stocks.filter(...)`.
  - Added `stripHeavyFieldsForList()` so paginated queries (`!exactIsin && !includeHistory`) omit 90-session `historical_prices` and `description`, reducing 50-row page payload bytes from `225,904 B` to `60,889 B` (`3.71x` reduction).
  - Added `SlidingWindowRateLimiter` (`src/server/security-utils.js`) enforced on both `api/stocks.js` & local `/api/stocks` (`240 req / 10s` per client IP) and `POST /api/market/refresh` (`10 req / 60s` per client IP), returning HTTP `429` with `Retry-After`, `X-RateLimit-Limit`, and `X-RateLimit-Remaining`.
- **Note on Deployment/Edge Rate Limiting:** Serverless handler-level rate limiting operates per warm function instance; distributed edge WAF rate limiting on Vercel (`vercel.json` does not configure Vercel Firewall WAF rules declaratively) remains an operational dashboard setting (**NOT VERIFIED** live on Vercel).

### SEC-003 — Async Error Handling & Non-Blocking Local Sync
- **Previous Gap:** `api/market/refresh.js` lacked `try/catch`; `local-server.js` `/api/market/status` and `/api/market/dataset` lacked `try/catch`; `local-server.js` `/api/market/refresh` awaited `triggerSyncJob()` synchronously on the HTTP request thread; `api/health.js`, `api/market/dataset.js`, and `local-server.js` static error handler echoed raw `err.message`.
- **Fix Implemented:**
  - Wrapped `api/market/refresh.js` and all `local-server.js` async route handlers + top-level server dispatcher in structured `try/catch` / `.catch(...)`, logging technical error objects only on the server (`console.error`) and returning sanitized JSON errors.
  - Changed `local-server.js` `POST /api/market/refresh` when stale to launch `triggerSyncJob(requestedDate)` asynchronously with `.catch(...)` and respond immediately with **HTTP `202 Accepted`** (`status: 'accepted'`; and `202` `status: 'in_progress'` when already syncing). Updated `js/app.js` to poll completion for both `in_progress` and `accepted`.

### SEC-004 — HTTP Security Headers & Strict CSP (`script-src 'self'`)
- **Previous Gap:** Neither `vercel.json` nor `local-server.js` emitted `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, or frame protection headers; `js/company-logo.js` emitted inline `onload="..."` and `onerror="..."` DOM attributes blocking strict CSP `script-src 'self'`; `local-server.js` also allowlisted `/js/logo-aliases.js`.
- **Fix Implemented:**
  - Configured canonical security headers in [`src/server/security-utils.js`](../src/server/security-utils.js), [`src/server/local-server.js`](../src/server/local-server.js), API serverless handlers, and [`vercel.json`](../vercel.json):
    - `Content-Security-Policy`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://api.dharun.dev; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`
    - `X-Content-Type-Options: nosniff`
    - `Referrer-Policy: strict-origin-when-cross-origin`
    - `X-Frame-Options: DENY`
    - `Permissions-Policy: camera=(), microphone=(), geolocation=()`
  - Refactored `js/company-logo.js` to replace inline `onload`/`onerror` HTML attributes with capturing DOM event listeners (`document.addEventListener('load', handleLoad, true)` + `'error'`).
  - Removed `/js/logo-aliases.js` from `local-server.js` `ALLOWED_STATIC_PATHS`.
  - Verified live Chromium Playwright page load of `/` and `/stock.html?isin=INE002A01018` under live `Content-Security-Policy` headers with `cspErrors: 0` and `pageErrors: 0`.

### Distributed Storage Lock Hardening (`src/storage/supabase-storage.js`)
- `acquireStorageLock()` now fails closed on non-404 read errors or malformed remote lock JSON and uses `{ upsert: false }` conditional object creation when the lock does not exist, reserving `{ upsert: true }` strictly for expired lock takeover followed by ownership verification.
- `releaseStorageLock()` returns `{ ok: true, alreadyReleased: true }` only on `404`, fails closed on transient read errors or corrupt lock JSON, and refuses deletion unless `lockObj.ownerId === ownerId`.

---

## 3. Environment & Verification Boundaries

| Scope | Verification Status | Notes |
| :--- | :--- | :--- |
| Static security lint (`eslint .`) | **VERIFIED (0 errors)** | Includes `preserve-caught-error` & `no-control-regex` compliance |
| Unit & regression suites (`tests/run-all.js`) | **VERIFIED (8/8 suites)** | Tested isolated from Supabase env vars |
| Live local server headers & CSP Playwright check | **VERIFIED (0 violations)** | Tested against `127.0.0.1` local HTTP server |
| Live Vercel Edge headers & Vercel Firewall WAF | **NOT VERIFIED** | No deployment / Vercel edge runtime available locally |
| Live Supabase Storage lock contention against prod bucket | **NOT VERIFIED** | No production Supabase credentials in workspace (`mock` HTTP tested) |
