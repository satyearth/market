# Machii Bazzar v2.0.0 — Operations & Incident Response Runbook

**Service Scope:** Daily NSE/BSE EOD Pipeline (GitHub Actions) -> Immutable Snapshot Storage (Supabase Storage) -> Read-Only API & UI (Vercel)  
**Primary Timezone:** `Asia/Kolkata` (`IST`, UTC+05:30)

---

## 1. Normal Daily Schedule & Operational Cadence

1. **Market Close & Exchange Publication**: Indian cash equities close at `15:30 IST`. NSE/BSE Unified CM BhavCopy (`BhavCopy_NSE_CM_...zip`, `BhavCopy_BSE_CM_...CSV`), NSE `ind_close_all_*.csv`, `CM_52_wk_High_low_*.csv`, and `PR<ddmmyy>.zip` (`mcap<ddmmyyyy>.csv`, `bc<ddmmyyyy>.csv`) typically appear between `16:30` and `19:30 IST`.
2. **Automated GitHub Actions Cron Windows** (`.github/workflows/refresh-stock-data.yml`):
   - **Mon–Fri EOD Windows (IST):** `16:52`, `17:37`, `18:12`, `18:48`, `19:38`, `20:17`, `20:53`.
   - **Mon–Sat Overnight Recovery:** `08:07 IST`.
   - **Sunday Special Session Check (Muhurat):** `20:07 IST`.
   - Scheduled runs skip cleanly via `precheck` if `latest.json` already matches `latestExpectedDate`.

---

## 2. Observability & Monitoring Targets (Phase 7)

| Failure Signal | Where to Inspect | Threshold / Alert Trigger | Immediate Verification Query |
| :--- | :--- | :--- | :--- |
| **Failed Daily Refresh** | GitHub Actions `refresh-stock-data.yml` run logs & step summary | Consecutive failures after `20:53 IST` window or precheck failure | Review GitHub Actions logs; check `GET /api/market/status` (`needsSync`, `isStale`) |
| **Stale / Delayed Dataset** | `GET /api/market/status` & `GET /api/health` | `isStale: true` or `missingSessionsCount >= 2` | Verify NSE/BSE holiday announcement vs BhavCopy 404/HTML response |
| **API Errors (`500`/`503`/`429`)** | Vercel Function Logs & Firewall metrics | Sustained `5xx` rate `> 1%` or missing `503 misconfigured` on `/api/market/refresh` | `GET /api/health` -> verify `ok: true` and `storageConfigured.read: true` |
| **Storage Write / Read Failure** | GitHub Actions `refresh` logs (`[Supabase]`) | `401/403/5xx` from Supabase REST or `verify_lock_fence` abort | Check Supabase Storage status, bucket quota, and `locks/refresh.lock.json` expiry |
| **Market Cap Coverage Drop** | `docs/reports/MARKET_CAP_COVERAGE_REPORT.md` / `npm run test:mcap` / pipeline summary | `marketCapCoveragePct < 99.0%` or missing `mcap*.csv` | Inspect `sourceFiles` in `GET /api/market/dataset` for missing `NSE_MCAP` |
| **Checksum Mismatch** | GitHub Actions upload verification (`verify_checksum` / `verify_history_checksum`) | Any SHA-256 mismatch error | Aborts automatically without updating `latest.json`; inspect network logs & re-run |
| **Lock Contention / Stale Lock** | Supabase Storage object `locks/refresh.lock.json` | Repeated `Concurrent storage refresh in progress` past `15m` lock TTL | Check active GitHub Actions runs (`concurrency: stock-data-refresh`); inspect `expiresAtUtc` |
| **Exchange Calendar Warning** | `GET /api/market/status` (`calendarVerified`, `calendarWarning`) | `calendarVerified === false` approaching `2027-01-01` | Fetch official 2027 NSE/BSE circulars and update `src/calendar/exchange-calendar.js` |

---

## 3. Incident Response Playbooks

### Incident A — Delayed / Missing Exchange BhavCopy After `20:53 IST`
1. Confirm whether NSE or BSE declared an unscheduled holiday or trading halt.
2. Notice the previous valid `latest.json` remains served cleanly with zero downtime (`503` sync unavailable only if stale threshold breached without breaking reads).
3. If published late by the exchanges, trigger `.github/workflows/refresh-stock-data.yml` manually via `workflow_dispatch` (`backfill: true` if >1 session missed).

### Incident B — Lock Contention (`locks/refresh.lock.json`)
1. Confirm no other GitHub Actions `stock-data-refresh` job or local `refresh.js` write run is currently executing.
2. Locks carry a `15-minute` TTL (`DEFAULT_LOCK_TTL_MS`). Wait until `expiresAtUtc` passes — the next runner automatically recovers expired locks with a `25 ms` settle and pre-commit `verifyLockOwnership` fence.
3. Only delete `locks/refresh.lock.json` manually in Supabase Dashboard if an aborted writer holds an unexpired lock AND zero jobs are running.

### Incident C — Unexpected Market Cap Coverage Drop (`< 99%`)
1. Check `GET /api/market/dataset` (`stats.sourceFiles`) to verify whether `NSE_MCAP` (`mcap<ddmmyyyy>.csv`) or `PR<ddmmyy>.zip` download failed during ingestion.
2. Verify `reference/*.json` files exist in Supabase Storage (`reference/benchmark_stocks_verified.json`, `reference/bse_list_securities_verified.json`, `reference/api-companies-catalog.json`, `reference/screener_market_caps.json`) for BSE-only fallbacks.
3. Re-run `node scripts/refresh.js --sync-only --date=<YYYY-MM-DD>` in `dry_run` first, confirm `marketCapCoveragePct >= 99.0`, then publish.

### Incident D — Suspected Secret Exposure or Refresh Endpoint Abuse
1. Immediately rotate `REFRESH_API_SECRET` in Vercel and/or `SUPABASE_SERVICE_ROLE_KEY` in Supabase & GitHub Secrets.
2. Verify Vercel WAF rate-limiting logs for `/api/market/refresh` and `/api/stocks`.
3. Note: clearing `REFRESH_API_SECRET` temporarily puts production `POST /api/market/refresh` into safe fail-closed HTTP `503` mode while read-only screener APIs remain operational.

### Incident E — 2027 Exchange Calendar Transition (Before Jan 2027)
1. Monitor official NSE (`nseindia.com/resources/exchange-communication-holidays`) and BSE holiday circulars.
2. Add verified 2027 holidays & special sessions into `src/calendar/exchange-calendar.js`, set `verified: true` for `2027`, add unit tests in `tests/audit-regression.test.js`, and deploy.
