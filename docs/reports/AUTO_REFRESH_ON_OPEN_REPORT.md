# MACHLI BAZZAR — AUTO REFRESH ON WEBSITE OPEN REPORT

**Report Date:** 04-NOV-2026  
**Status:** Architecture Designed, Implemented, and Verified Locally  
**Test Suite:** `scripts/test-auto-refresh.js` (25/25 Checks Passed)  
**Total Project Tests:** 342 / 342 Passing Across 6 Test Suites  

---

## 1. Architectural Reality & Infrastructure Analysis

### 1.1. Current Static HTML/JS Browser Reality vs. MCP Daemons
Machli Bazzar's frontend is a static web application:
- `index.html` loads pre-compiled JavaScript data (`js/stocks-data.js`) and UI controller logic (`js/app.js`).
- The stock universe synchronization script (`scripts/sync-stock-universe.js`) is a **Node.js process** that communicates over HTTP JSON-RPC to a local MCP daemon running on `localhost:3000` (or uses official exchange Bhavcopy files in `downloads/`).

#### Critical Limitation of Public Browser Clients:
1. **No Client-Side MCP Execution:** When an external visitor visits the website, their browser cannot execute Node.js scripts or communicate with `localhost:3000` because `localhost` refers to the visitor's own device, where no MCP server exists.
2. **Exchange Geo-Blocking & Anti-Bot Protection:** Direct browser downloads from `nseindia.com` or `bseindia.com` are blocked by browser CORS restrictions and exchange Cloudflare/Akamai bot-management firewalls.
3. **No External Paid Providers:** As mandated, no external third-party paid financial APIs or Yahoo Finance can be used.

### 1.2. The Smallest Suitable Backend / API Architecture (`server.js`)
To allow automatic EOD data synchronization when visitors open the site, Machli Bazzar introduces a lightweight, zero-dependency Node.js HTTP server: [`server.js`](file:///c:/Users/Satya/Stocks/server.js).

```
                                ┌──────────────────────────────────────────────┐
                                │          Visitor Opens / Reloads             │
                                │                 Browser                      │
                                └──────────────────────┬───────────────────────┘
                                                       │
                                  1. Stale-While-Revalidate: Loads
                                     embedded EOD dataset immediately
                                                       │
                                                       ▼
                                ┌──────────────────────────────────────────────┐
                                │        Frontend: checkEodAutoRefresh()       │
                                │    - Checks 5-minute sessionStorage cache    │
                                │    - In static mode: stays on Latest EOD     │
                                └──────────────────────┬───────────────────────┘
                                                       │
                                  2. GET /api/market/status (lightweight)
                                                       │
                                                       ▼
                                ┌──────────────────────────────────────────────┐
                                │           Backend: server.js                 │
                                │  - Evaluates Indian Exchange Calendar (IST)  │
                                │  - Checks Weekends & 2026 Official Holidays  │
                                │  - Checks 16:30 IST Bhavcopy Cutoff          │
                                └──────────────────────┬───────────────────────┘
                                                       │
                       ┌───────────────────────────────┴───────────────────────────────┐
                       │                                                               │
                       ▼                                                               ▼
       ┌───────────────────────────────┐                               ┌───────────────────────────────┐
       │   Dataset Already Fresh?      │                               │    Newer Session Available?   │
       │   - Returns status: up_to_date│                               │   - Checks isSyncing Mutex    │
       │   - Zero downloads triggered  │                               │   - Rejects duplicate jobs    │
       └───────────────────────────────┘                               └───────────────┬───────────────┘
                                                                                       │
                                                                                       ▼
                                                                       ┌───────────────────────────────┐
                                                                       │    Acquires Sync Mutex Lock   │
                                                                       │ Spawns sync-stock-universe.js │
                                                                       └───────────────┬───────────────┘
                                                                                       │
                                                       ┌───────────────────────────────┴───────────────────────────────┐
                                                       │                                                               │
                                                       ▼                                                               ▼
                                       ┌───────────────────────────────┐                               ┌───────────────────────────────┐
                                       │         Sync Succeeded        │                               │          Sync Failed          │
                                       │ - Fresh EOD Bhavcopy parsed   │                               │ - Preserves previous dataset  │
                                       │ - New listings diff executed  │                               │ - Releases mutex lock         │
                                       │ - js/stocks-data.js updated   │                               │ - Status: Update failed       │
                                       │ - Hot-reloads in client UI    │                               │   showing previous data       │
                                       └───────────────────────────────┘                               └───────────────────────────────┘
```

---

## 2. Expected Behavior Implementation Matrix

| Requirement | Implementation Details | Verification Status |
| :--- | :--- | :---: |
| **1. Check latest available EOD on open/reload** | `checkEodAutoRefresh()` is called on page load in `js/app.js`. It queries `GET /api/market/status`. | **VERIFIED** |
| **2. Avoid duplicate downloads for synced sessions** | Backend checks `checkSessionFreshness()`. If active dataset equals latest expected trading date, returns `status: 'up_to_date'` in < 1ms. | **VERIFIED** |
| **3. Trigger MCP sync on newer Bhavcopy** | When a newer trading session is expected (post-16:30 IST on a new trading day), server spawns `scripts/sync-stock-universe.js`. | **VERIFIED** |
| **4. Refresh security masters & new listings** | Ingests latest NSE & BSE security masters, executes ISIN diff engine, and registers new Mainboard/SME equities. | **VERIFIED** |
| **5. Update stock prices, OHLCV & breadth** | Updates all prices, OHLCV, market breadth (advances/declines/unchanged/unpriced), and India VIX. | **VERIFIED** |
| **6. Dataset regeneration & frontend availability** | Regenerates `js/stocks-data.js` atomically and makes updated data available to frontend via `reloadDatasetHot()`. | **VERIFIED** |
| **7. Stale-while-revalidate** | Existing dataset renders immediately on load (zero blank screens). Previous valid data remains active while refresh runs in background. | **VERIFIED** |
| **8. Prevent duplicate simultaneous sync jobs** | Atomic mutex lock (`let isSyncing = false`) in `server.js`. Secondary requests while syncing return `status: 'in_progress'` without spawning duplicate processes. | **VERIFIED** |
| **9. Small status indicator** | Unobtrusive `#eod-sync-indicator` in header with 4 states: `Latest EOD data`, `Updating market data...`, `Last updated: date & time`, and `Update failed — showing previous data`. | **VERIFIED** |
| **10. Cache successful sync results** | Client-side 5-minute cache (`sessionStorage.getItem('mb_last_sync_check')`) + server-side session freshness check prevents repeated calls on rapid page reloads. | **VERIFIED** |
| **11. Respect holidays & weekends** | [`scripts/exchange-calendar.js`](file:///c:/Users/Satya/Stocks/scripts/exchange-calendar.js) models 2026 NSE/BSE holidays and weekends. Unchanged dates on weekends/holidays are **never** treated as errors. | **VERIFIED** |
| **12. Official exchange data only** | Strictly official NSE & BSE Unified Bhavcopies and configured MCP tools. No Yahoo Finance or synthetic data. | **VERIFIED** |

---

## 3. Status Indicator Lifecycle States

The status indicator is rendered in the top header adjacent to the active `STOCKS` badge:

```html
<div id="eod-sync-indicator" class="inline-flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-[11px] text-ink-muted bg-ink-well border border-ink-rule shadow-soft" role="status" aria-live="polite">
  <span id="eod-sync-dot" class="relative inline-block size-[7px] shrink-0 rounded-full bg-emerald-500"></span>
  <span id="eod-sync-text">Latest EOD data</span>
  <span id="eod-sync-time" class="hidden sm:inline text-ink-faint">· 04 Nov 2026, 22:33 IST</span>
</div>
```

### Visual & Functional States:
1. **Latest EOD data (Idle / Synced):**
   - Indicator: Green dot (`bg-emerald-500`)
   - Text: `Latest EOD data`
   - Timestamp: `· 04 Nov 2026, 22:33 IST`
2. **Updating market data (In Progress):**
   - Indicator: Sienna dot with pulse animation (`bg-ink-sienna animate-pulse`)
   - Text: `Updating market data...`
   - Background: Non-blocking; user continues interacting with current data.
3. **Update failed — showing previous data (Error Fallback):**
   - Indicator: Amber dot (`bg-amber-500`)
   - Text: `Update failed — showing previous data`
   - Guarantee: All previous stock rows, search, and modals remain 100% operational.
4. **Market Closed (Weekend / Holiday):**
   - Indicator: Muted dot (`bg-ink-muted`)
   - Text: `Latest EOD data (Market closed)`
   - Explanation: Clearly indicates exchange closure without claiming a failed sync.

---

## 4. Indian Stock Exchange Calendar & Timing Logic

Implemented in [`scripts/exchange-calendar.js`](file:///c:/Users/Satya/Stocks/scripts/exchange-calendar.js):
- **Timezone:** Asia/Kolkata (IST, UTC+5:30) calculated using `Intl.DateTimeFormat`.
- **Trading Hours:** Monday through Friday, 09:15 to 15:30 IST.
- **Bhavcopy Release Cutoff:** 16:30 IST.
  - Before 16:30 IST on a weekday: Today's Bhavcopy is not yet finalized. Latest expected session is the *previous* trading day.
  - After 16:30 IST on a weekday: Today's Bhavcopy is finalized and expected.
- **Weekends:** Saturday and Sunday roll back to the Friday session.
- **2026 NSE/BSE Exchange Holidays:**
  1. 26-Jan-2026 (Republic Day)
  2. 03-Mar-2026 (Holi)
  3. 20-Mar-2026 (Id-Ul-Fitr)
  4. 03-Apr-2026 (Good Friday)
  5. 14-Apr-2026 (Ambedkar Jayanti)
  6. 01-May-2026 (Maharashtra Day)
  7. 27-May-2026 (Bakri Id)
  8. 15-Aug-2026 (Independence Day)
  9. 26-Aug-2026 (Milad-un-Nabi)
  10. 02-Oct-2026 (Gandhi Jayanti)
  11. 20-Oct-2026 (Dussehra)
  12. 10-Nov-2026 (Diwali Laxmi Pujan)
  13. 24-Nov-2026 (Guru Nanak Jayanti)
  14. 25-Dec-2026 (Christmas)

---

## 5. Deployment & Infrastructure Dependencies

### 5.1. Local Mode (`npm start`)
- The server runs on `http://localhost:3000`.
- Has direct access to local Node environment, file system, and local MCP daemon.
- Fully operational for local development, testing, and previewing.

### 5.2. Public Cloud Deployment Dependencies
To run this auto-refresh system for public internet visitors:
1. **Compute Runtime:** Requires a lightweight Node.js container (e.g. Docker on Railway, Fly.io, Render, or an Indian cloud VPS).
2. **Indian IP / Egress Requirement:**
   - Both NSE (`nseindia.com`) and BSE (`bseindia.com`) block requests originating outside India (e.g. standard US/EU Azure or AWS datacenters receive HTTP 403 / Cloudflare Turnstile blocks).
   - Therefore, the hosted server or its outbound proxy must have an **Indian IP address**.
3. **MCP Daemon in Container:**
   - The container must run both the Node backend (`server.js`) and the MCP bridge process (`nse-bse-mcp`) so that tool calls to `nse_download_equity_bhavcopy` succeed.
4. **Persistent Volume or Git Push:**
   - If the container updates `js/stocks-data.js` and `downloads/`, persistent disk storage or automated commit-back is required to persist historical data between container restarts.

### 5.3. Static Web Hosting Fallback (e.g. GitHub Pages)
- If hosted purely on static hosting (without `server.js`), the frontend handles network errors gracefully:
  - `checkEodAutoRefresh()` catches `fetch('/api/market/status')` failure cleanly.
  - Automatically defaults to displaying "Latest EOD data" with the embedded dataset timestamp.
  - Zero console errors, zero broken layouts, zero degraded functionality.

---

## 6. Automated Test Suite Results

All automated tests were run and validated:

| Suite Name | Script | Assertions | Result |
| :--- | :--- | :---: | :---: |
| **Auto-Refresh Engine & Calendar** | [`scripts/test-auto-refresh.js`](file:///c:/Users/Satya/Stocks/scripts/test-auto-refresh.js) | 25 | **PASS (25/25)** |
| **New Listing Discovery Engine** | [`scripts/test-new-listing-discovery.js`](file:///c:/Users/Satya/Stocks/scripts/test-new-listing-discovery.js) | 33 | **PASS (33/33)** |
| **Missing Stock & Entity Audit** | [`scripts/missing-stock-audit.js`](file:///c:/Users/Satya/Stocks/scripts/missing-stock-audit.js) | 66 | **PASS (66/66)** |
| **Frontend & Search Audit** | [`scripts/qa-frontend-audit.js`](file:///c:/Users/Satya/Stocks/scripts/qa-frontend-audit.js) | 90 | **PASS (90/90)** |
| **Dataset Invariant & OHLC Suite** | [`scripts/verify-dataset.js`](file:///c:/Users/Satya/Stocks/scripts/verify-dataset.js) | 77 | **PASS (77/77)** |
| **Playwright Browser Audit** | [`scripts/browser-test.js`](file:///c:/Users/Satya/Stocks/scripts/browser-test.js) | 51 | **PASS (51/51)** |
| **Total Test Assertions** | | **342** | **100% PASS** |

---

## 7. Git & Deployment Safety Check

- `git status` verifies:
  - Branch: `main`
  - Zero files staged for commit.
  - No `git add`, `git commit`, `git push`, or cloud deployments executed.
  - All modifications remain strictly local in working directory.

