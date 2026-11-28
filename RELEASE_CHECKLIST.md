# Machii Bazzar v2.0.0 — Production Release & Operational Checklist

**Release Candidate:** `machii-bazzar@2.0.0` (Dataset Session `2026-11-27`)  
**Status:** **CONDITIONAL GO** — Local/CI code & dataset checks green; complete Section 2 & 3 on target cloud environment before production traffic cutover.

---

## 1. Pre-Release Engineering & QA Gates (Completed Locally)

- [x] `npm run lint` passes with exit code `0` after final code edit.
- [x] `tests/run-all.js` passes **8/8 suites** (`0` failed), including expanded `audit-regression.test.js` (DNS SSRF blocking, Refresh `403`/`401` access control, expired lock recovery & `verify_lock_fence` abort, multi-file PKZIP extraction, `TOTAL` CSV footer exclusion, `RE`/`PP`/`CCPS` null guards, cross-ISIN ticker rejection, `/api/market/status` calendar telemetry).
- [x] `scripts/verify-dataset.js` passes **67/67 checks** on `2026-11-27` dataset (`5,465` equities).
- [x] `scripts/qa-frontend-audit.js` passes **104/104 checks** (`0.81ms` avg search latency, `5,196`/`242`/`114` logo manifest reconciled).
- [x] `scripts/missing-stock-audit.js` passes **39/39 checks** (`0` missing, `0` extra vs NSE/BSE BhavCopy).
- [x] `scripts/test-new-listing-discovery.js` passes **32/32 checks** (`GSTL` ISIN disambiguation, 90-session history, changelog).
- [x] `scripts/test-auto-refresh.js` passes **22/22 checks**.
- [x] `scripts/test-pipeline.js` passes **33/33 checks** (retry, backoff, rollback, retention, CI isolation).
- [x] `scripts/test-market-cap-coverage.js` passes **19/19 checks** (`99.05%` total instruments / `99.52%` share-class coverage, `>= 99.0%` assertion preserved).
- [x] `npm run test:browser` (`scripts/test-infinite-scroll.js`) passes in Chromium Playwright across desktop & mobile with zero CSP console violations.
- [x] Official NSE daily `PR271126.zip -> mcap27112026.csv` & `bc27112026.csv` downloaded and verified; zero `-RE`, `PP`, or `CCPS` market cap pollutions; zero `INDIA_API_TICKER` collisions.

---

## 2. Mandatory Cloud Production Cutover Gates (`NOT VERIFIED` Locally)

Because cloud secrets are intentionally absent from the local development environment, an authorized release operator **MUST** verify every item below in the target production environment before signing off full production availability:

- [ ] **GitHub Actions Secrets & Variables (`refresh-stock-data.yml`)**:
  - Confirm `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` exist in repository Secrets and `SUPABASE_STORAGE_BUCKET` matches the live bucket.
  - Trigger `workflow_dispatch` with `dry_run=true` first, verify precheck logs, then run live sync (`backfill=false, force=false`) and confirm `Verify remote Supabase manifest freshness` succeeds with `totalStocks >= 5465` and `0` git commits.
- [ ] **Supabase Storage Live Verification**:
  - Confirm `latest.json`, `datasets/2026-11-27/...`, `history/...`, `reference/...`, and lock creation/release (`locks/refresh.lock.json`) work end-to-end against live Supabase Storage (and clean up any stale test locks if needed).
- [ ] **Vercel Environment Variables & Edge Security**:
  - Configure `SUPABASE_URL`, `SUPABASE_ANON_KEY` (or read-only storage access), and **`REFRESH_API_SECRET`** in Vercel Production environment variables.
  - Configure **Vercel Firewall / WAF global rate-limiting rules** on `/api/stocks` and `/api/market/refresh` (mandatory because in-memory `SlidingWindowRateLimiter` is per-serverless-instance only).
- [ ] **Live Production Smoke Test (Post-Deploy)**:
  - `GET https://<prod-domain>/api/health` -> HTTP `200` (`ok: true`) + CSP (`script-src 'self'`), `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`.
  - `GET https://<prod-domain>/api/market/status` -> HTTP `200` with `tradingDate`, `calendarVerified`, `calendarWarning` (or `null` after 2027 update).
  - `GET https://<prod-domain>/api/stocks?limit=50&offset=0` -> HTTP `200` stripped payload without inline `historical_prices`.
  - `POST https://<prod-domain>/api/market/refresh` without secret -> HTTP **`401`** when `REFRESH_API_SECRET` is configured.

---

## 3. Ongoing Operational Follow-Ups (Post-Release Backlog)

- [ ] **Update `2027` Exchange Calendar Before Jan 2027**: Fetch official 2027 NSE and BSE equity trading holiday circulars once published, add verified dates to `src/calendar/exchange-calendar.js`, switch `2027` metadata to `verified: true` with source URL references, and update unit tests.
- [ ] **Quarterly Fundamentals (`pe_ratio`, `roce`) Refresh**: Refresh `downloads/screener_market_caps.json` & Supabase `reference/screener_market_caps.json` quarterly (or integrate an authorized fundamentals feed) so `fundamentals_as_of_date` advances beyond `2026-11-04`.
- [ ] **Dual-ISIN Corporate Action Tie-Breaker (`VGL`)**: Add a guard in `src/enrichment/market-cap.js` / `universe-merger.js` preventing superseded zero-volume ISINs (`volume === 0`) from copying `NSE_OFFICIAL_MCAP` when another active ISIN shares the same `(nse_symbol, series)`.
