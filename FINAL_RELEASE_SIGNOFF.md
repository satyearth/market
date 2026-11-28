# Machii Bazzar v2.0.0 — Final Release Sign-Off

**Release Version:** `machii-bazzar@2.0.0`  
**Sign-Off Date:** 2026-11-28 (IST)  
**Target Dataset Session:** `2026-11-27` (`5,465` ISINs; `99.05%` total / `99.52%` share-class market cap coverage)  
**Certification Decision:** **`CONDITIONAL GO`**

---

## 1. Decision Rationale

Machii Bazzar v2.0.0 **PASSES all local engineering, financial accuracy, security hardening, browser E2E, and automated regression gates** (`npm run lint`, `npm test` 7 stages, `npm run test:mcap`, `npm run test:browser`, and non-destructive desktop/mobile + serverless fail-closed smoke verification — all exit code `0` with zero relaxed assertions).

However, per mandatory production certification rules (*never claim cloud verification without actual execution*), an unconditional **`GO`** cannot be issued until the target cloud environments (`Vercel`, live `Supabase Storage`, and `GitHub Actions`) are verified with actual production secrets in place:

| Release Pillar | Certified Status | Gate Summary |
| :--- | :---: | :--- |
| **Application Code & Fail-Closed Auth** | **PASS** | All lint (`0`), 8 unit/regression suites (`0` failed), DNS SSRF blocking, and HTTP `503` fail-closed production refresh auth verified |
| **Financial Data Integrity & Coverage** | **PASS** | `5,465` unique ISINs (`0` missing/extra vs NSE+BSE BhavCopy), `5,413` verified caps (`99.05%` total / `99.52%` share-class), official NSE `mcap27112026.csv` & `bc27112026.csv` integrated, `26` non-common RE/PP/CCPS strictly `null`, cross-ISIN ticker collisions (`RAJPUTANA`, `SEL`) eliminated |
| **Frontend UI, Watchlist, Compare & CSV** | **PASS** | `qa-frontend-audit` (`104/104`), `test:browser` (`5,465` ISINs / `110` batches), plus Chromium desktop/mobile smoke verification (`0` console/page/CSP errors) |
| **Storage Reliability & Fencing** | **PASS (Mocked)** / **NOT VERIFIED (Live)** | Checksums, rollback, 90-session retention, expired lock recovery, and pre-commit `verify_lock_fence` verified in isolated tests; live Supabase bucket R/W requires production secrets |
| **Cloud Infra, WAF & Scheduled Cron** | **NOT VERIFIED** | Live Vercel deployment, Vercel Firewall/WAF rate-limiting rules, `REFRESH_API_SECRET` env setup, and live GitHub Actions `workflow_dispatch` execution cannot run without cloud credentials |

---

## 2. Mandatory Conditions to Upgrade from `CONDITIONAL GO` to Live Production (`GO`)

An authorized operator must complete and sign off all 5 conditions below using [DEPLOYMENT_CONFIGURATION_CHECKLIST.md](DEPLOYMENT_CONFIGURATION_CHECKLIST.md):

1. **Create Release Commit Cleanly**: Stage intended files (resolving untracked artifact disposition such as `docs/reports/logo-supplemental-audit-2026-11-28.json`) and push authorized commit.
2. **Configure Production Secrets**: Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` in GitHub Secrets; set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_STORAGE_BUCKET`, and **`REFRESH_API_SECRET`** in Vercel Environment Variables.
3. **Configure Edge Distributed Rate Limiting**: Enable Vercel Firewall / Edge WAF rate-limiting rules for `/api/stocks` and `/api/market/refresh` (application-level in-memory limiters do not coordinate across serverless instances).
4. **Verify Live Scheduled Ingestion & Storage**: Execute `workflow_dispatch` (`dry_run=true`, then live) in `.github/workflows/refresh-stock-data.yml`, confirming `latest.json` updates atomically with `totalStocks >= 5465` and zero git commits.
5. **Run Post-Deploy Live Smoke Verification**: Confirm `GET /api/health` (`200`), `GET /api/market/status` (`200`, `calendarVerified: false`), `GET /api/stocks?limit=5&offset=0` (`200`), all 5 security headers, and `POST /api/market/refresh` rejecting unauthenticated callers (`401`/`503`).

---

## 3. Scheduled Post-Release Operational Obligation

- **2027 Exchange Calendar**: Official NSE and BSE 2027 holiday circulars were verified unpublished as of `2026-11-28`. `src/calendar/exchange-calendar.js` preserves `calendarVerified: false` and warning telemetry until official circulars are published and added before `2027-01-01`.

**Signed Off By:** DevOps / Cloud Security / SRE / Financial Data Release Audit  
**Certification State:** **CONDITIONAL GO** (Ready for authorized production cutover execution)
