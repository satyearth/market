# Machii Bazzar v2.0.0 — Production Verification & Security Report

**Verification Date:** 2026-11-28 (IST)  
**Target Dataset Session:** 2026-11-27  
**Environment Scope:** Local Node.js v24.19.0 + Chromium Playwright (Cloud Secrets Unavailable Locally)

---

## 1. Production Infrastructure Verification Matrix (Phase 6)

No cloud credentials (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `REFRESH_API_SECRET`, `VERCEL_TOKEN`, `GITHUB_TOKEN`, or `.env`) exist in the audit workspace. Every live external-service check is therefore marked **`NOT VERIFIED`** and deferred to [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md).

| Infrastructure Area | Static / Mock Verification | Live Production Status | Notes & Evidence |
| :--- | :--- | :--- | :--- |
| **Vercel Security Headers (`vercel.json`)** | **VERIFIED** (`audit-regression.test.js`) | **NOT VERIFIED** | `vercel.json` defines CSP (`script-src 'self'`), `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`. Live deployed response headers not checked. |
| **Vercel Serverless Functions (`api/**/*.js`)** | **VERIFIED** (`audit-regression.test.js`, `api-and-query.test.js`) | **NOT VERIFIED** | Handlers verified with mock HTTP `req`/`res` objects and `localServer`. Live Vercel Edge routing & `maxDuration: 60` cold starts not tested. |
| **Supabase Storage R/W & Permissions** | **VERIFIED (Mocked HTTP)** (`storage-retention.test.js`, `test-pipeline.js`) | **NOT VERIFIED** | Code paths for `datasets/`, `history/`, `reference/`, `locks/refresh.lock.json`, and `latest.json` tested via mock storage HTTP transport (`bucket: 'test-bucket'`). |
| **Concurrent Publishing & Expired Lock Recovery** | **VERIFIED (Mocked HTTP)** (`audit-regression.test.js`) | **NOT VERIFIED** | Verified fail-closed HTTP 500 handling, expired lock takeover with `lockTakeoverSettleMs`, and pre-commit `verifyLockOwnership` abort (`phase: 'verify_lock_fence'`) blocking `latest.json` swap. |
| **Dataset Checksum & Atomic Pointer Swap** | **VERIFIED (Mocked HTTP)** (`storage-retention.test.js`, `test-pipeline.js`) | **NOT VERIFIED** | Verified SHA-256 read-back verification, count verification, and zero `latest.json` update on checksum mismatch. |
| **GitHub Actions Scheduled Execution** | **VERIFIED (Static Config)** (`test-pipeline.js`) | **NOT VERIFIED** | `.github/workflows/refresh-stock-data.yml` schedules 7 weekday IST post-close windows (`16:52`–`20:53` IST), Mon–Sat overnight recovery (`08:07` IST), Sun Muhurat (`20:07` IST), `concurrency: stock-data-refresh`, `contents: read`, zero git commits. |
| **Market-Close & Delayed Archive Recovery** | **VERIFIED (Local Archives + Mock Poll)** (`ingestion.test.js`, `test-pipeline.js`) | **NOT VERIFIED** | Verified `404`/`503`/`429` retry & `PR271126.zip` live HTTPS fetch against `nsearchives.nseindia.com` (`2026-11-27`). |

---

## 2. Production Security Audit (Phase 4)

### 2.1 SSRF, DNS Resolution & Redirect Validation (`src/ingestion/http-client.js`)

- **Transport & Allowlist**: Strictly enforces `https:`, default port `443` only, blocks embedded `username:password` URLs, caps redirects at `5` hops, and re-validates every `Location` target against `DEFAULT_ALLOWED_HOST_SUFFIXES` (`nseindia.com`, `bseindia.com`, `dharun.dev`, `supabase.co`).
- **Pre-Connection Host Checks**: `isDisallowedIpOrInternalHost` rejects raw IPs, localhost/internal suffixes (`.local`, `.localhost`, `.internal`, `.localdomain`), and integer/hex/octal IP representations (`2130706433`, `0x7f000001`).
- **DNS Resolution Guard**: `createSafeDnsLookup` wraps `dns.lookup(..., { all: true })` on every HTTPS socket connection and rejects connections if any resolved A/AAAA record falls in private, loopback, CGNAT, link-local / IMDS (`169.254.0.0/16`), multicast/reserved IPv4, IPv6 (`::`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `100::`), or `::ffff:` IPv4-mapped private space.
- **Limitation Noted**: DNS rebinding occurring in the sub-millisecond window between Node `dns.lookup` and kernel `connect()` is minimized because outbound hosts are already restricted to 4 allowlisted trusted suffixes.

### 2.2 Refresh Endpoint Access Controls (`src/server/local-server.js`, `api/market/refresh.js`, `src/server/security-utils.js`)

- **`authorizeRefreshRequest(req, options)`**:
  - Rejects cross-origin `POST /api/market/refresh` requests on local server with **HTTP `403`** (`LOCAL_ORIGIN_RE`: `localhost` / `127.0.0.1` only).
  - When `REFRESH_API_SECRET` is configured in environment variables, enforces timing-safe SHA-256 digest comparison (`crypto.timingSafeEqual`) via `Authorization: Bearer <token>` or `X-Refresh-Secret`, rejecting missing or invalid tokens with **HTTP `401`**.
  - On Vercel (`api/market/refresh.js`), triggers read-only freshness diagnostics unless authenticated, because serverless mode does not execute synchronous scrape/write pipelines (`canTriggerSync: false`).
- **Recommended Deployment Setting**: Set `REFRESH_API_SECRET` in Vercel Project Environment Variables if external callers must be authenticated; leave unset only if `/api/market/refresh` intentionally serves read-only public status diagnostics.

### 2.3 Serverless Rate-Limiting Architecture Boundary

- `sharedStocksRateLimiter` (`240 req / 10s`) and `sharedRefreshRateLimiter` (`10 req / 60s`) use `SlidingWindowRateLimiter` (`Map`-backed, bounded to `5,000` keys) in `src/server/security-utils.js`.
- **CRITICAL ARCHITECTURAL BOUNDARY**: In serverless deployments (Vercel), each warm container maintains isolated process memory. **In-memory rate limiting does NOT enforce global cross-instance quotas across concurrent serverless instances or cold starts.** Production deployments **MUST** configure Vercel Firewall / Edge WAF rate-limiting rules (and/or external Redis/Upstash backing if global per-IP fairness in app code is required).

### 2.4 Public API Abuse Resistance (`api/stocks.js`, `src/query/stock-query-service.js`)

- Bounded `isins` parameter to max **200** entries; validated `limit`, `offset`, `segment`, `filter`, `sort`, and `q` (control chars rejected, excessive lengths rejected).
- `readLocalStatsSafe` (`64 KB` bounded head reader) prevents parsing the full `23.27 MB` `js/stocks-data.js` just to serve `/api/health`, `/api/market/status`, or `/api/market/dataset`.
- Standardized sanitized `500` error JSON responses across all handlers (`no stack traces`, `no filesystem paths`, `no secret values`).

### 2.5 CSP & Frontend XSS Controls

- Verified CSP in both `vercel.json` and `SECURITY_HEADERS`:
  - `script-src 'self'` (zero `'unsafe-inline'`, zero `eval` — note inline scripts removed from HTML/JS, event delegation + DOM properties used).
  - `company-logo.js` uses `addEventListener('error')` with cache map instead of inline `onerror=` attributes.
  - `app.js` sanitizes rendered strings via `escapeHtml()` and routes via canonical `ISIN`.
  - Playwright verification (`test:browser`) confirmed **0 console CSP violations** across homepage list and stock details flows.

### 2.6 Secret Handling, Concurrent Locking & Recovery

- Verified `.env` absent locally and zero hardcoded credentials or service-role keys across `src/`, `api/`, `js/`, `tests/`, `.github/`.
- `src/storage/supabase-storage.js` locking protocol:
  - Active acquire uses conditional create (`x-upsert: 'false'`).
  - Expired lock recovery requires `expiresAtMs <= Date.now()`, writes with `x-upsert: 'true'`, waits `lockTakeoverSettleMs` (`25 ms` default), then re-reads to confirm ownership.
  - Before swapping `latest.json`, `publishDatasetToStorage` runs `verifyLockOwnership(ownerId)` (`phase: 'verify_lock_fence'`). If ownership expired or shifted, pointer swap aborts immediately while previously published `latest.json` remains intact.
  - **Advisory Note**: Because Supabase Storage REST exposes `upsert` rather than object generation/ETag preconditions (`if-match`), the `25 ms` settle + read-back verification narrows — rather than mathematically eliminating to zero — sub-25 ms dual-runner races during expired-lock recovery; GitHub Actions `concurrency: { group: stock-data-refresh, cancel-in-progress: false }` acts as the primary single-writer serializer in CI.

---

## 3. Exchange Calendar Verification (Phase 3)

- **Official Verification Performed**: Queried official `nseindia.com` and `bseindia.com` sources via web search on `2026-11-28`. Official **2027** NSE/BSE equity trading holiday circulars have **not yet been published** (only unofficial tentative calendars appear on third-party sites).
- **Safe Implementation**:
  - `src/calendar/exchange-calendar.js` intentionally retains `verified: false` for year `2027` with explicit warning copy rather than fabricating unverified holiday dates.
  - Weekends (`Sat`/`Sun`) are rejected safely (`isTradingDay` = `false`); unverified 2027 weekdays carry `calendarVerified: false` and explicit `calendarWarning` on both `api/market/status.js` and `src/server/local-server.js`.
  - When BhavCopy files return HTTP 404 on an unexpected unscheduled exchange holiday, `bhavcopy-downloader.js` fails safely without corrupting prior session datasets.

---

## 4. Complete Verification Execution Log (Phase 7 — Final Edit Run)

All commands executed sequentially after the final code/test edit (`2026-11-28T22:39+05:30`):

| Command | Result Summary | Exit Code |
| :--- | :--- | :---: |
| `node scripts/refresh.js --sync-only --force --skip-storage --date=2026-11-27` | Published `5,465` stocks locally (`99.05%` total / `99.52%` share-class mcap coverage) | `0` |
| `npm run lint` (`eslint .`) | Clean pass, zero warnings/errors | `0` |
| `npm test` — `node tests/run-all.js` | **8 suites passed, 0 failed** (`ingestion`, `normalization`, `enrichment`, `validation`, `storage-retention`, `api-and-query`, `security-and-ci`, `audit-regression`) | `0` |
| `npm test` — `node scripts/verify-dataset.js` | **67 passed, 0 failed** | `0` |
| `npm test` — `node scripts/qa-frontend-audit.js` | **104 passed, 0 failed** (`0.81ms / query` avg search) | `0` |
| `npm test` — `node scripts/missing-stock-audit.js` | **39 passed, 0 failed** (`0` missing, `0` extra vs BhavCopy) | `0` |
| `npm test` — `node scripts/test-new-listing-discovery.js` | **32 passed, 0 failed** | `0` |
| `npm test` — `node scripts/test-auto-refresh.js` | **22 passed, 0 failed** | `0` |
| `npm test` — `node scripts/test-pipeline.js` | **33 passed, 0 failed** | `0` |
| `npm run test:mcap` | **19 passed, 0 failed** (`>= 99%` mcap threshold passed cleanly) | `0` |
| `npm run test:browser` | **PASS** (`5,465` unique ISINs in `110` batches, retry, logos, search/sort/filter, scroll, mobile layout, zero CSP violations) | `0` |
