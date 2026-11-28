# Machii Bazzar v2.0.0 — Final Release Audit & CTO Sign-Off

**Audit Date:** 2026-11-28 (IST)  
**Target Dataset Session:** 2026-11-27 (EOD Finalized Exchange Session)  
**Pipeline Version:** `2.0.0`  
**Release Decision:** **CONDITIONAL GO** (Local / Staging Release Candidate Verified; Production Go-Live Conditioned on Live Cloud & Secret Gates)

---

## 1. Executive Release Decision

Machii Bazzar v2.0.0 has completed independent regression verification, authoritative exchange market-capitalization integration (`NSE PR271126.zip / mcap27112026.csv`), instrument-level vs. share-capital denominator reconciliation, DNS-level SSRF & refresh access hardening, distributed lock pre-commit fencing, and full automated test + Chromium Playwright verification.

All automated local test suites pass with **exit code 0** and **zero relaxed assertions** after the final code edit:

| Gate | Command | Result | Scope / Conditions |
| :--- | :--- | :--- | :--- |
| Static Analysis | `npm run lint` | **PASS (Exit 0)** | Full workspace ESLint check (`eslint .`) |
| Unit & Regression Suites | `npm test` (`tests/run-all.js`) | **PASS (8/8 Suites, 0 Failed)** | Includes expanded `tests/audit-regression.test.js` |
| Dataset Integrity | `scripts/verify-dataset.js` | **PASS (67/67 Checks, 0 Failed)** | Verified against `2026-11-27` `js/stocks-data.js` (`23,266,485` bytes) |
| Frontend & UI QA | `scripts/qa-frontend-audit.js` | **PASS (104/104 Checks, 0 Failed)** | Includes 0.81 ms average search latency & logo manifest audit |
| Exchange Master Reconciliation | `scripts/missing-stock-audit.js` | **PASS (39/39 Checks, 0 Failed)** | Zero missing and zero phantom ISINs vs NSE/BSE BhavCopy (`5,465 === 5,465`) |
| New Listing & History Pipeline | `scripts/test-new-listing-discovery.js` | **PASS (32/32 Checks, 0 Failed)** | Verified ISIN disambiguation (`GSTL`), changelog & 90-session history |
| Auto-Refresh & Endpoints | `scripts/test-auto-refresh.js` | **PASS (22/22 Checks, 0 Failed)** | Calendar, `/api/market/status`, `/api/market/refresh`, `/api/market/dataset` |
| Pipeline & Storage Retention | `scripts/test-pipeline.js` | **PASS (33/33 Checks, 0 Failed)** | Backfill, checksum verification, mocked Supabase retention & CI isolation |
| Market Cap Coverage (`>= 99%`) | `scripts/test-market-cap-coverage.js` | **PASS (19/19 Checks, 0 Failed)** | `99.05%` all-instrument / `99.52%` share-class coverage |
| Browser E2E (Playwright) | `npm run test:browser` (`scripts/test-infinite-scroll.js`) | **PASS (Exit 0)** | `5,465` unique ISINs over 110 API batches, retry, logos, search/sort/filter, scroll, mobile |
| Live Cloud Infrastructure | Vercel / Supabase / GitHub Actions | **NOT VERIFIED** | Zero cloud credentials (`SUPABASE_*`, `VERCEL_TOKEN`, `REFRESH_API_SECRET`, `GITHUB_TOKEN`) present locally |

### Why Decision Is CONDITIONAL GO (Not Unconditional GO)

1. **Unverified Live Cloud Environments (`NOT VERIFIED`)**: Production Vercel deployment headers, live Supabase Storage bucket read/write/lock behavior, `REFRESH_API_SECRET` runtime enforcement, and scheduled `.github/workflows/refresh-stock-data.yml` execution cannot be executed from this workspace because no production secrets are present locally.
2. **In-Memory Rate Limiter Boundary on Serverless**: `SlidingWindowRateLimiter` in `src/server/security-utils.js` provides per-instance protection only; distributed cross-container throttling across Vercel serverless cold starts requires Vercel Firewall / WAF rules configured outside application code.
3. **2027 Exchange Calendar Pending Official Exchange Circulars**: Official 2027 NSE/BSE equity holiday circulars are not yet published (`verified: false`). Safe weekend fallback and explicit `calendarVerified` / `calendarWarning` API metadata are active, requiring calendar update once exchanges publish official circulars.

---

## 2. Phase 1 — Independent Regression Audit

Review of modified files, test assertions, and regenerated outputs confirmed that prior P0–P2 fixes were genuinely implemented without weakening acceptance thresholds:

- **RM-001 (Canonical Series & BSE Groups)**: `src/config/constants.js` is shared identically by `src/processing/universe-merger.js` and `scripts/missing-stock-audit.js`. Legitimate NSE `SZ` (`1` row) and BSE groups `IF`, `R`, `TS`, `ZP`, `SS`, `IT`, `E` remain included while debt/debenture series remain excluded. `missing-stock-audit.js` passes `39/39` with `Missing: 0, Extra: 0`.
- **RM-002 (2027 Exchange Calendar Safety)**: `src/calendar/exchange-calendar.js` marks `2027` with `verified: false` and explicit warning string rather than fabricating holiday dates. `/api/market/status` (`api/market/status.js` and `src/server/local-server.js`) now exposes `calendarVerified` and `calendarWarning` on every response.
- **SEC-001..SEC-004 (Security Controls Preserved & Extended)**:
  - `src/ingestion/http-client.js` enforces HTTPS, port `443`, credential stripping, allowlisted suffixes (`nseindia.com`, `bseindia.com`, `dharun.dev`, `supabase.co`), private hostname/integer-IP rejection, bounded 5-hop redirect validation, AND now enforces DNS-resolution private/reserved IP blocking (`createSafeDnsLookup` + `isPrivateOrReservedIp` covering IPv4 RFC1918/loopback/CGNAT/link-local `169.254.169.254`, IPv6 `::1`/`fc00::/7`/`fe80::/10`, and `::ffff:` IPv4-mapped addresses).
  - `api/stocks.js` & `src/query/stock-query-service.js` bound `isins` to max `200`, reject control/oversized parameters, and strip inline history/payload bloat (`64 KB` head reader).
  - `src/server/local-server.js` & `api/market/refresh.js` enforce `authorizeRefreshRequest` (`403` cross-origin local requests, `401` timing-safe Bearer / `X-Refresh-Secret` check when `REFRESH_API_SECRET` is configured).
  - `vercel.json` and `src/server/security-utils.js` drop `unsafe-inline` from `script-src` while keeping all 5 security headers (`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`).
- **QA & Threshold Integrity Check (`>= 99%` Preserved)**:
  - Verified `scripts/test-market-cap-coverage.js` line `91` still strictly asserts `assert(pct >= 99.0)`.
  - Verified `scripts/qa-frontend-audit.js` only updated `TATAMOTORS -> TMPV`, `pct_from_high === 0`, audited logo manifest counts (`5,196` official, `242` monogram, `114` verified fallback), and average search speed assertion (`< 5ms`, observed `0.81ms / query` across `5,389` records). No assertions were diluted.

---

## 3. Summary of Changes Completed in Final Release Verification

| Component | File(s) | Improvement Implemented |
| :--- | :--- | :--- |
| Daily NSE Archive Ingestion | `src/ingestion/bhavcopy-downloader.js` | Added `PR<ddmmyy>.zip` URL builder, multi-entry PKZIP extractor `extractEntryFromZipBuffer`, `mcap<ddmmyyyy>.csv` & `bc<ddmmyyyy>.csv` extraction/validation (`validateNseMcapCsvContent` checking `27 NOV 2026` row dates) |
| Market Cap Waterfall & Classification | `src/enrichment/market-cap.js`, `src/processing/universe-merger.js` | Integrated Priority 1 `NSE_OFFICIAL_MCAP` (`mcap*.csv`, skipping `Listed`/`Permitted`/`Total` CSV summary rows); added `classifyEquityInstrumentType` forcing `null` on `RIGHTS_ENTITLEMENT`, `PARTLY_PAID` (`PP`), and `PREFERENCE_SHARES` (`CCPS`) while preserving `DVR_EQUITY`; blocked cross-ISIN `INDIA_API_TICKER` collisions and stale ticker carryover; computed `commonEquityCoverage` |
| Reporting & Metadata | `src/publishing/publisher.js`, `docs/reports/MARKET_CAP_COVERAGE_REPORT.md` | Attached `NSE_MCAP` archive metadata to `marketStats.sourceFiles`, published dual coverage denominators (`99.05%` total / `99.52%` share-class) |
| SSRF DNS Protection | `src/ingestion/http-client.js` | Added `isPrivateOrReservedIp` and `createSafeDnsLookup` on all outbound HTTPS connections |
| Refresh Auth & Calendar Telemetry | `src/server/security-utils.js`, `src/server/local-server.js`, `api/market/refresh.js`, `api/market/status.js` | Added `authorizeRefreshRequest` (`Origin` + `REFRESH_API_SECRET`) and exposed `calendarVerified` + `calendarWarning` |
| Distributed Lock Fencing | `src/storage/supabase-storage.js` | Added configurable `lockTakeoverSettleMs` (`25 ms`) and `verifyLockOwnership` pre-commit fence immediately prior to `latest.json` pointer swap |
| Regression Test Expansion | `tests/audit-regression.test.js` | Added automated tests covering DNS SSRF IP blocking, refresh `403`/`401` enforcement, expired lock takeover & `verify_lock_fence` abort, multi-file PKZIP extraction + `TOTAL` summary footer exclusion, RE/PP/CCPS `null` safeguards, cross-ISIN ticker rejection, and `/api/market/status` calendar telemetry |

---

## 4. Accompanying Release Documentation

- [PRODUCTION_VERIFICATION_REPORT.md](PRODUCTION_VERIFICATION_REPORT.md) — Security controls, calendar status, test execution results, and `NOT VERIFIED` cloud gates
- [FINANCIAL_DATA_ACCURACY_REPORT.md](FINANCIAL_DATA_ACCURACY_REPORT.md) — Full 59-missing audit, share-capital & corporate-action corrections, PE/ROCE staleness, dual-ISIN & exchange reconciliation
- [RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) — Operational go-live checklist and post-deploy verification steps
