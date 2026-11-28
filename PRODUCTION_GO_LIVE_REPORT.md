# Machii Bazzar v2.0.0 — Production Go-Live Certification Report

**Certification Date:** 2026-11-28 (IST)  
**Target Release:** `machii-bazzar@2.0.0` (Base Git HEAD `0033d14` + verified working-tree release changes; `30` modified files, `11` prior untracked + `5` certification documents)  
**Target EOD Dataset:** `2026-11-27` (`5,465` unique ISINs; `99.05%` total / `99.52%` share-class market cap coverage)  
**Final Release Decision:** **CONDITIONAL GO** — All engineering, security, financial data accuracy, local/mock storage reliability, browser E2E, and non-destructive runtime smoke gates **PASS** locally; live cloud cutover gates remain **`NOT VERIFIED`** due to absent cloud credentials and unauthorized deployment targets in the local workspace.

---

## 1. Master Release Gate Matrix

| Gate ID | Gate Category | Status | Supporting Evidence | Remaining Action (If Applicable) |
| :--- | :--- | :---: | :--- | :--- |
| **G-01** | **Repository & Dependency Integrity** | **PASS** | `git status -u`, `git diff --stat`; zero `.env` or secret files; `.gitignore` and `.vercelignore` present; `npm ls --omit=dev` confirms 0 runtime dependencies (`package-lock.json` present) | Stage intended files cleanly (`docs/reports/logo-supplemental-audit-2026-11-28.json` and release docs review) before release commit |
| **G-02** | **Static Analysis (`npm run lint`)** | **PASS** | `eslint .` exited with code `0` after final code edit | None |
| **G-03** | **Unit & Regression Suites (`tests/run-all.js`)** | **PASS** | `8/8` suites passed (`ingestion`, `normalization`, `enrichment`, `validation`, `storage-retention`, `api-and-query`, `security-and-ci`, `audit-regression` — including #13 fail-closed 503 test) | None |
| **G-04** | **Dataset & Financial Accuracy (`verify-dataset`, `missing-stock-audit`, `test:mcap`)** | **PASS** | `67/67` dataset checks, `39/39` exchange master reconciliation (`5,465 === 5,465`), `19/19` mcap coverage (`99.05%` total / `99.52%` share-class; `>= 99%` preserved) | Refresh `2027` holiday calendar once NSE/BSE circulars publish; refresh quarterly fundamentals beyond `2026-11-04` |
| **G-05** | **UI QA, Discovery & Auto-Refresh (`npm test`)** | **PASS** | `qa-frontend-audit` (`104/104`, `0.81ms` search), `test-new-listing-discovery` (`32/32`), `test-auto-refresh` (`22/22`), `test-pipeline` (`33/33`), all exit `0` | None |
| **G-06** | **Full-Universe Browser E2E (`npm run test:browser`)** | **PASS** | Chromium Playwright verified `5,465` unique ISINs across `110` `/api/stocks` batches, retry, logos, search/sort/filter, scroll, details, mobile overflow (`0`), exit `0` | None |
| **G-07** | **Non-Destructive Runtime Smoke & Feature Parity** | **PASS** | Local HTTP + Playwright desktop (`1280x800`) & mobile (`390x844`) verified Watchlist (`2` ISINs), Compare dialog (`9` metrics), CSV export (`51` lines), History (`90` rows), freshness indicator, latency (`1.63–557.44 ms`), `consoleErrors: 0`, `pageErrors: 0` | Re-run smoke probe against live Vercel production URL post-deploy |
| **G-08** | **Fail-Closed Production Refresh Auth** | **PASS** | Fixed in `api/market/refresh.js` & `src/server/security-utils.js`; returns HTTP `503` (`status: 'misconfigured'`) when `VERCEL` or `NODE_ENV=production` lacks `REFRESH_API_SECRET`, and `401` on wrong/missing token | Configure `REFRESH_API_SECRET` in Vercel Production env |
| **G-09** | **Secret & Bundle Isolation** | **PASS** | Client bundle scan (`js/*.js`, `index.html`, `stock.html`) returned `0` occurrences of `SUPABASE_`, `REFRESH_API_SECRET`, `SERVICE_ROLE`, or `Bearer `; `supabase-storage.js` is server-only | Verify deployed Vercel bundle excludes docs/downloads via `.vercelignore` |
| **G-10** | **Isolated Storage Reliability & Fencing** | **PASS (Mock)** / **NOT VERIFIED (Live)** | Mocked Supabase HTTP verified SHA-256 read-back, checksum rollback, concurrent blocking, expired lock recovery (`25ms` settle), `verify_lock_fence` abort blocking `latest.json` swap, and 90-session retention | Execute `workflow_dispatch` dry-run & live write test against production Supabase Storage bucket |
| **G-11** | **Distributed Serverless Rate Limiting (Vercel WAF)** | **NOT VERIFIED** | App-level `SlidingWindowRateLimiter` in `src/server/security-utils.js` is per-instance memory only (`240/10s` stocks, `10/60s` refresh) and does not coordinate across serverless instances | Configure Vercel Firewall / WAF rate-limiting rules on `/api/stocks` and `/api/market/refresh` |
| **G-12** | **Live Vercel Production Deployment & Endpoints** | **NOT VERIFIED** | Zero `VERCEL_TOKEN`, `.vercel/` link, or `vercel` CLI present; live production TLS, Edge headers, cold starts, and domain smoke tests not run | Deploy authorized release commit to Vercel & run Section 5 smoke commands in [DEPLOYMENT_CONFIGURATION_CHECKLIST.md](DEPLOYMENT_CONFIGURATION_CHECKLIST.md) |
| **G-13** | **Live GitHub Actions Scheduled Ingestion** | **NOT VERIFIED** | `.github/workflows/refresh-stock-data.yml` statically verified & local `--dry-run` (`2026-11-27`) passed (`5,465` validated); zero `gh` CLI / `GITHUB_TOKEN` available to trigger remote runner | Configure repo Secrets (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`) and run `workflow_dispatch` (`dry_run=true`, then live) |

---

## 2. Phase-by-Phase Technical Certification Summary

### 2.1 Phase 1 — Repository & Artifact Integrity (`PASS`)
- Reviewed `git status -u` (`30` modified files, `11` prior untracked docs/reports/tests/utils, `5` new certification docs) and `git diff --stat` (`30 files changed, 7,465 insertions, 5,928 deletions`).
- Confirmed zero `.env*` files, zero `.bak`/`.tmp` artifacts, zero debug scripts inside the repository, and zero third-party runtime dependencies (`package.json` `dependencies` omitted; `npm ls --omit=dev` empty; `.vercelignore` excludes `.git`, `.github`, `.backup`, `.vscode`, `downloads`, `docs`, `tests`, `scripts`, `test-results`, `server.js`, `.env*`).
- Dataset consistency confirmed: `js/stocks-data.js` (`23,266,485` bytes) reconciles exactly with `docs/reports/MARKET_CAP_COVERAGE_REPORT.md` (`5,465` equities, `5,413` verified caps = `99.05%` total / `99.52%` share-class).

### 2.2 Phase 2 & Phase 3 — Production Configuration & Security (`PASS` locally; `NOT VERIFIED` in Cloud)
- Enumerated all 13 environment variables referenced in code via workspace scan (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `SUPABASE_STORAGE_BUCKET`, `REFRESH_API_SECRET`, `REFRESH_WAIT_MINUTES`, `REFRESH_POLL_SECONDS`, `VERCEL`, `NODE_ENV`, `GITHUB_ACTIONS`, `GITHUB_OUTPUT`, `PORT`, plus CI workflow step variables `EXPECTED_DATE`, `INPUT_DRY_RUN`, `JOB_STATUS`).
- Closed a fail-open production auth gap discovered during Phase 2 inspection: updated `src/server/security-utils.js`, `api/market/refresh.js`, and `src/server/local-server.js` so that when `VERCEL` or `NODE_ENV === 'production'` is set and `REFRESH_API_SECRET` is missing, `POST /api/market/refresh` strictly returns **HTTP `503`** (`status: 'misconfigured'`) instead of allowing unauthenticated access.
- Confirmed SSRF/DNS protections (`createSafeDnsLookup` + `isPrivateOrReservedIp`), CSP (`script-src 'self'`), all 5 HTTP security headers across static/API routes, bounded parameter validation (`isins <= 200`, `limit <= 50`), and server-only Supabase key scoping.
- Explicitly retained the architectural boundary note that in-memory `SlidingWindowRateLimiter` provides per-container protection only; global distributed rate limiting requires Vercel WAF / Firewall configuration.

### 2.3 Phase 4 — Storage & Publication Reliability (`PASS` in Mock/Isolated Env; `NOT VERIFIED` Live)
- Verified `src/storage/supabase-storage.js` upload/download, SHA-256 checksum & stock-count read-back validation, downgrade guard, `previousVersion` retention, expired-lock recovery (`25 ms` settle), pre-commit `verifyLockOwnership` lock fence (`phase: 'verify_lock_fence'`), and 90-session / 10-history pruning across `storage-retention.test.js`, `test-pipeline.js` (`33/33`), and `audit-regression.test.js`.
- **Atomicity Assessment**: Conditional `x-upsert: 'false'` lock creation provides atomic first-writer-wins acquisition under normal contention, while expired-lock takeover (`x-upsert: 'true'` + `25 ms` settle + read-back verification + pre-commit fence) combined with GitHub Actions `concurrency: { group: stock-data-refresh, cancel-in-progress: false }` provides sufficient practical coordination for a single scheduled CI writer. If future architecture permits concurrent external writers, upgrade expired-lock recovery and `latest.json` pointer swaps to a Postgres transactional lease RPC or conditional `If-Match` ETag header.

### 2.4 Phase 5 — Scheduled Ingestion (`PASS` Config & Dry-Run; `NOT VERIFIED` Live Runner)
- Verified `.github/workflows/refresh-stock-data.yml`: `TZ: Asia/Kolkata`, 7 Mon–Fri post-close UTC cron schedules (`16:52–20:53 IST`), Sat overnight catch-up (`08:07 IST`), Sun Muhurat (`20:07 IST`), `permissions: contents: read`, zero git commit/push steps, failure-safe preservation of `latest.json`.
- Confirmed `exchange-calendar.js` preserves `2027` `verified: false` warnings (`calendarVerified: false`, `calendarWarning` on `/api/market/status`) without fabricating unverified 2027 holiday dates.

### 2.5 Phase 6 — Local Runtime Non-Destructive Smoke Metrics (`PASS` Locally; `NOT VERIFIED` Deployed URL)

Measured directly against `createAppServer()` (`127.0.0.1`) + headless Chromium Playwright + Vercel handler modules:

| Endpoint / Flow | HTTP Status | Latency (ms) | Payload (Bytes) | Verified Assertions |
| :--- | :---: | :---: | :---: | :--- |
| `GET /api/health` | `200` | `56.78` | `321` | `ok: true`, `tradingDate: 2026-11-27`, all 5 security headers |
| `GET /api/market/status` | `200` | `557.44` | `1,619` | `calendarVerified: false`, non-null `calendarWarning`, freshness status |
| `GET /api/market/dataset` | `200` | `3.78` | `8,619` | Full `marketStats` + `historicalDataset` pointer |
| `GET /api/market/history?isin=INE002A01018` | `200` | `263.85` | `6,047` | `90` chronological RELIANCE closing sessions |
| `GET /api/stocks?limit=50&offset=0` | `200` | `11.77` | `93,809` | `50` stocks, zero inline `historical_prices`, all 5 headers |
| `GET /api/stocks` (`205` ISINs) | `400` | `3.41` | `81` | Rejects `> 200` ISIN abuse cleanly |
| `POST /api/stocks` | `405` | `1.63` | `51` | Enforces `Allow: GET` method discipline |
| `POST /api/market/refresh` (`VERCEL=1`, no secret) | `503` | `< 5` | JSON | Fails closed (`status: 'misconfigured'`) |
| Playwright Desktop (`1280x800`) + Mobile (`390x844`) | — | — | — | Freshness banner, Watchlist (`2`), Compare dialog (`9` rows), CSV Export (`51` lines), Details `90`-session history table, `0` console/page/CSP errors |
