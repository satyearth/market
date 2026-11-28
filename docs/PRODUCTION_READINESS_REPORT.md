# Machii Bazzar v2.0.0 — Production Readiness Report

**Assessment Date:** 2026-11-28  
**Target Version:** Machii Bazzar v2.0.0  
**Scope:** Local codebase, static analysis, automated backend/frontend/pipeline/browser test verification, security controls, and external dependency boundary disclosure.

---

## 1. Overall Readiness Verdict

- **Local Engineering, Functional & Security Readiness:** **PASS WITH KNOWN DATA-COVERAGE CAVEAT & CLOUD ITEMS UNVERIFIED**
  - All P0 release blockers (`RM-001`, `RM-002`), P1 security controls (`SEC-001..SEC-004`, Supabase lock fail-closed hardening), P1 functional bug fixes (`BUG-001..BUG-007`), and P1 performance/P2 data provenance improvements are implemented and locally verified after the final edit.
  - **2027 Exchange Calendar Status:** Structured support for 2027 (`EXCHANGE_CALENDAR_BY_YEAR[2027]`) is implemented with explicit `verified: false` and warning flags because NSE & BSE have not published official 2027 trading holiday circulars as of `2026-11-28`. Official circulars must be added once published in December 2026.
  - **Cloud Runtime Verification:** Vercel production edge WAF/headers, live Supabase Storage bucket publishing/locking, and live GitHub Actions scheduled workflows are **NOT VERIFIED** from this local workspace due to absent production credentials.

---

## 2. Post-Final-Edit Test & Verification Matrix

All checks below ran cleanly after the final code edit (`src/query/stock-query-service.js` and `scripts/qa-frontend-audit.js`):

| Command | Scope Covered | Result | Exact Outcome / Notes |
| :--- | :--- | :---: | :--- |
| `npm run lint` | ESLint across entire repository | **PASS** | `0 errors, 0 warnings` |
| `node tests/run-all.js` | `ingestion`, `normalization`, `enrichment`, `validation`, `storage-retention`, `api-and-query`, `security-and-ci`, `audit-regression` | **PASS** | `8 suite(s) passed, 0 suite(s) failed` |
| `node scripts/verify-dataset.js` | `2026-11-27` `js/stocks-data.js` (`5,465` equities) consistency & schema | **PASS** | Exit code `0` (`5,465 === 5,465`, India VIX `16.55`, 90 sessions) |
| `node scripts/qa-frontend-audit.js` | Search, filters, duplicate ticker ISIN disambiguation, cards, logos (`5,196`/`242`/`114`), sub-5ms search latency | **PASS** | Exit code `0` |
| `node scripts/missing-stock-audit.js` | Canonical NSE/BSE BhavCopy master reconciliation & entity battery | **PASS** | Exit code `0` (`0` missing, `0` extra) |
| `node scripts/test-new-listing-discovery.js` | IPO discovery, dual-listing expansion, idempotency, safety rollback | **PASS** | Exit code `0` |
| `node scripts/test-auto-refresh.js` | Exchange calendar, IST timing, `/api/market/*`, auto-refresh UI | **PASS** | Exit code `0` |
| `node scripts/test-pipeline.js` | End-to-end atomic publish, mock Supabase storage, 90-session retention | **PASS** | `33 PASSED, 0 FAILED` (Supabase isolated/mocked) |
| `npm run test:browser` (`scripts/test-infinite-scroll.js`) | Headless Chromium Playwright E2E across all `5,465` equities (`110` batches) | **PASS** | Exit code `0` |
| Custom Live HTTP + Playwright CSP/UI Smoke | Live local server headers, 400/404 validation, `jlr -> TMPV`, Card 4 `NSE 52W · 2026-11-27`, `Export loaded rows`, `stock.html` provenance | **PASS** | `cspErrors: 0`, `pageErrors: 0` |
| `npm run test:mcap` (`scripts/test-market-cap-coverage.js`) | Full-universe market-cap coverage & ISIN safeguards | **18 PASSED, 1 FAILED** | Live `2026-11-27` coverage is `98.92%` (`5,406 / 5,465`) vs hardcoded `>= 99%` assertion because 6 newly active `2026-11-27` listings/PP/RE (`FRATELLIPP`, `INDRAYANIPP`, `PRAXIS-RE3`, `MAHACOAL`, `HEGRAPHITE`, `WATRANA`) and collision-guarded tickers have no verified source market cap and were kept honestly `null` without relaxing assertions (prior `2026-11-26` session measured `99.03%`). |

---

## 3. Measured Benchmarks (After Final Edit)

| Benchmark Metric | Baseline / Unoptimized | Current Optimized | Improvement |
| :--- | :---: | :---: | :---: |
| `MARKET_STATS` extraction from `js/stocks-data.js` (`23,115,807 B`, avg of 15 runs) | `81.714 ms` (full `readFileSync`) | `4.16 ms` (64 KB head read) | **`~19.6x` faster** |
| `/api/stocks?limit=50&offset=0` JSON array payload size | `225,904 B` (with `historical_prices`) | `60,889 B` (list-projected) | **`3.71x` smaller** |
| Watchlist 200-ISIN query across `5,465` equities (avg of 30 runs) | — | `2.847 ms` | Sub-3 ms response |
| Cold full `loadDataset()` parse + normalize (`5,465` rows) | — | `242.38 ms` | Cached by mtime/size |

---

## 4. Operational Readiness & Manual Production Checklist (`NOT VERIFIED`)

The following items require validation in the target production environment by operators with credentials:

1. **2027 Holiday Circular Ingestion (`RM-002`):** Once NSE and BSE publish official 2027 equity trading holiday circulars (expected December 2026), populate `EXCHANGE_HOLIDAYS_2027` and `SPECIAL_TRADING_SESSIONS_2027`, and set `EXCHANGE_CALENDAR_BY_YEAR[2027].verified = true` in [`src/calendar/exchange-calendar.js`](../src/calendar/exchange-calendar.js).
2. **Vercel Edge Rate Limiting & Deployment Headers (`SEC-002`, `SEC-004`):** After deploying updated [`vercel.json`](../vercel.json) and API functions, verify response headers (`Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`) against production URLs and enable Vercel Firewall Edge Rate Limiting rules for `/api/stocks` and `/api/market/*` (**NOT VERIFIED**).
3. **Supabase Storage & Reference Sync (`storage:publish-with-ref`):** With `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_STORAGE_BUCKET` set in GitHub Actions / deployment secrets, run `npm run storage:publish-with-ref` so the `2026-11-27` dataset and metadata fields (`market_cap_as_of_date`, `fundamentals_as_of_date`, `description`) are published to external object storage (**NOT VERIFIED**).
4. **GitHub Actions Scheduled Sync:** Confirm the scheduled `.github/workflows/refresh-stock-data.yml` run executes cleanly against Supabase Storage using hardened [`src/ingestion/http-client.js`](../src/ingestion/http-client.js) and fail-closed [`src/storage/supabase-storage.js`](../src/storage/supabase-storage.js) locks (**NOT VERIFIED**).
