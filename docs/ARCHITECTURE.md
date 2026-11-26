# Machii Bazzar — Architecture, Data Pipeline & Operations Guide

## 1. System Overview

**Machii Bazzar** is a zero-runtime-dependency Node.js + vanilla web application for End-of-Day (EOD) Indian equity market screening and stock detail inspection across **NSE and BSE** (Mainboard and SME segments).

- **Frontend**: Static HTML/CSS/JS ([index.html](file:///c:/Users/Satya/Stocks/index.html), [stock.html](file:///c:/Users/Satya/Stocks/stock.html)) using editorial Dark Ink styling (`css/`) and ISIN-keyed logos/monograms (`js/company-logo*.js`).
- **Serverless Read Layer**: Vercel Functions (`api/`) reading versioned snapshots from **Supabase Storage** (`latest.json` -> `datasets/<tradingDate>/...json`) with automatic in-memory caching and fallback to `js/stocks-data.js`.
- **Automated Daily Refresh**: GitHub Actions (`TZ=Asia/Kolkata`) downloads official exchange BhavCopy archives, validates data invariants, and publishes atomically to Supabase Storage with zero Git commits.

---

## 2. Modular Directory Layout

```text
api/
  health.js                     # GET /api/health — readiness & freshness probe
  stocks.js                     # GET /api/stocks — paginated/filtered/sorted universe & ISIN lookup
  market/status.js              # GET /api/market/status — IST calendar & storage version metadata
  market/dataset.js             # GET /api/market/dataset — lightweight stats + freshness payload
  market/refresh.js             # POST /api/market/refresh — serverless read-only check (503 if stale)
src/
  config/constants.js           # Exchange series/group rules, Supabase defaults, sector overrides
  calendar/exchange-calendar.js # IST calendar, 2026 holidays, special Muhurat sessions, 16:30/19:30 cutoffs
  ingestion/
    http-client.js              # Retry/timeout HTTP(S) client (insecureHTTPParser scoped to bseindia.com)
    bhavcopy-downloader.js      # Official NSE (.csv.zip/.csv) & BSE (.CSV) BhavCopy + VIX/52W downloaders
  processing/
    csv-parser.js               # RFC-4180 CSV parser, name cleaner, date normalizer
    universe-merger.js          # ISIN deduplication, 5-session carry-forward, 6-session history matrix
  enrichment/
    market-cap.js               # 7-tier market-cap resolution waterfall & Supabase reference hydration
    fundamentals.js             # Sector overrides, PE/PB/ROCE carryover, VIX & 52W High/Low enrichment
  validation/
    dataset-validator.js        # Schema, ISIN format, OHLC bounds, shrinkage & breadth arithmetic checks
  storage/
    supabase-storage.js         # Locking, 3-phase atomic upload/verify/swap, 30-session retention, reference/
  publishing/
    publisher.js                # Unified orchestrator (syncUniverse, runRefresh, --dry-run, --sync-reference)
  query/
    stock-query-service.js      # Query filtering, sorting, 15s manifest pointer cache & local fallback
  server/
    local-server.js             # Hardened local HTTP server (static allowlist, 405 guards, local sync trigger)
tests/
  run-all.js                    # Isolated modular backend test runner (scrubs SUPABASE_* env)
  *.test.js                     # Unit & integration tests (ingestion, normalization, enrichment, validation, storage, API, security)
scripts/
  verify-dataset.js             # 63-point dataset & BhavCopy reconciliation audit
  qa-frontend-audit.js          # 104-point UI/functional contract audit
  missing-stock-audit.js        # 39-point exchange master reconciliation & entity resolution audit
  test-*.js                     # Specialized regression, pipeline, auto-refresh, listing & Playwright browser suites
```

Compatibility wrappers under `lib/*.js`, top-level `scripts/*.js` CLIs, and `server.js` preserve existing npm scripts and test entrypoints while delegating to `src/`.

---

## 3. Data Pipeline & Integrity Rules

1. **Exchange Ingestion**: Downloads NSE CM Unified BhavCopy (`.csv.zip`), BSE CM Unified BhavCopy (`.CSV`), optional NSE Index Close (`ind_close_all_DDMMYYYY.csv` for India VIX), and NSE 52-Week High/Low (`CM_52_wk_High_low_DDMMYYYY.csv`). HTML error pages, date mismatches, and truncated archives are rejected before saving.
2. **ISIN Primary Key & Deduplication**: Eligible Indian equities (`INE*`, `IN9*`) are merged by ISIN across NSE and BSE. Dual-listed records aggregate traded volume and bound OHLC cleanly.
3. **Zero Fabricated Metrics**: Missing prices, market caps, and ratios remain `null` and render as `—`. Market caps resolve across benchmark, BSE master, India API catalog (`reference/api-companies-catalog.json` or live API), screener cache, share count math, and previous-session carryover.
4. **Atomic Publish & 30-Session Retention**:
   - Uploads immutable snapshot `datasets/<date>/stocks-dataset-<versionId>.json`.
   - Verifies SHA-256 checksum & stock count before swapping `latest.json`.
   - Prunes datasets older than 30 distinct valid trading sessions while strictly protecting `latest`, `previousVersion`, `latest.json`, `locks/`, and `reference/`.

---

## 4. Environment Variables & Setup

See [EXTERNAL_STORAGE_SETUP.md](file:///c:/Users/Satya/Stocks/docs/EXTERNAL_STORAGE_SETUP.md) for Supabase Storage, GitHub Actions, and Vercel setup.

- **Vercel (Read-only APIs)**:
  - `SUPABASE_URL` (required for reading external datasets)
  - `SUPABASE_STORAGE_BUCKET` (optional; defaults to `machii-bazzar-datasets`)
  - `SUPABASE_ANON_KEY` (required only if bucket is private; optional for public read bucket)
- **GitHub Actions (Scheduled Daily Refresh)**:
  - Secrets: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (scoped strictly to `precheck`, `refresh`, and `summary` steps; never exposed to tests)
  - Variable: `SUPABASE_STORAGE_BUCKET` (optional; defaults to `machii-bazzar-datasets`)

---

## 5. Verification Commands

```bash
npm run lint                       # ESLint across repository
npm run test:unit                  # Isolated modular tests under tests/ (zero live network/Supabase calls)
npm test                           # Full backend + dataset + QA + missing-stock + discovery + refresh + pipeline suite
npm run test:mcap                  # Multi-source market-cap coverage checks
npm run test:browser               # Playwright Chromium screener & details verification
npm run storage:publish-with-ref   # Local seed of latest complete BhavCopy session + reference/*.json to Supabase
```
