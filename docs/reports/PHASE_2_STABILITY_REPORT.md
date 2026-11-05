# Machli Bazzar — Phase 2 Stability Report & Final Freeze Checkpoint

**Date:** 04-Nov-2026  
**Status:** Frozen & Verified (Phase 2, Phase 2.1, and Phase 2.2 Complete)  
**Total Automated Tests:** 207 / 207 Passed (100%)  
**Workspace:** `C:\Users\Satya\Stocks`

---

## 1. Project Architecture

Machli Bazzar is an end-of-day equity intelligence platform covering the entire exchange-traded Indian equity market. It operates as a fast, dependency-free static web application with an automated exchange data ingestion pipeline.

```
Stocks/
├── index.html                      # Semantic HTML5 frontend with dark theme & accessible controls
├── css/style.css                   # Custom theme tokens & design system (Tailwind compatible)
├── js/
│   ├── app.js                      # Reactive frontend controller (search, filters, modal, sparklines)
│   └── stocks-data.js              # Exchange-verified production dataset (4,965 stocks + MARKET_STATS)
├── scripts/
│   ├── sync-stock-universe.js      # Core exchange Bhavcopy & MCP ingestion and compilation script
│   ├── verify-dataset.js           # 74 invariant tests for data integrity & math consistency
│   ├── qa-frontend-audit.js        # 82 frontend DOM, XSS, and UI behavior tests
│   └── browser-test.js             # 51 real Playwright headless Chromium tests & screenshots
├── test-results/screenshots/       # Browser automation screenshots (Desktop, Tablet, Mobile)
├── downloads/                      # Official NSE & BSE CM Unified Bhavcopy CSV archives
├── assets/logos/                   # 49 verified corporate PNG logos
├── .agents/mcp_config.json         # Workspace MCP configuration for official NSE & BSE servers
├── .github/workflows/              # Automated daily update workflow definition
├── package.json                    # Minimal project manifest (Playwright in devDependencies only)
└── README.md                       # High-level project documentation
```

---

## 2. Exchange Data Sources & Universe Reconciliation

### Source Archives
- **NSE Unified Bhavcopy:** `downloads/BhavCopy_NSE_CM_0_0_0_20261104_F_0000.csv` (3,085 equities)
- **BSE Unified Bhavcopy:** `downloads/BhavCopy_BSE_CM_0_0_0_20261104_F_0000.CSV` (4,310 equities)
- **Historical Sessions (6 Days):** 2026-10-28, 2026-10-29, 2026-10-30, 2026-11-02, 2026-11-03, 2026-11-04

### 10-Point Reconciled Mathematical Identities
1. **Total Unique Equities:** **4,965** deduplicated by ISIN (Indian national ISIN prefixes: `INE` / `IN9`).
2. **Exchange Distribution:**
   - Dual-Listed: **2,430**
   - NSE-Only: **655**
   - BSE-Only: **1,880**
   - *Identity:* $2,430 + 655 + 1,880 = 4,965$ (Exact match)
3. **Platform Classification:**
   - Mainboard Equities: **4,101**
   - SME Platform Equities: **864** (NSE Emerge: 472, BSE SME: 392, Dual-listed SME: 0)
   - *Identity:* $4,101 + 864 = 4,965$ (Exact match)
4. **Market Breadth:**
   - Advances: **3,228**
   - Declines: **1,539**
   - Unchanged: **196**
   - Unpriced (New Listings): **2**
   - *Identity:* $3,228 + 1,539 + 196 + 2 = 4,965$ (Exact match)
   - Advance/Decline Ratio: **2.10**

---

## 3. MCP Integration Status

Configured in `.agents/mcp_config.json`:
- **`nse-bhavcopy`**: `https://mcp.nseindia.in/bhavcopy/cm/mcp`
- **`nse-cm-market`**: `https://mcp.nseindia.in/cmmkt/mcp`
- **`bse-mcp`**: `http://localhost:3000/mcp` / local runner

### Integrated Exchange Metrics
1. **Dynamic India VIX:** Ingested from `nse_vix_historical` MCP endpoint. Current value: **15.19** (-3.39% change, date: 04-NOV-2026). Old hardcoded values completely purged.
2. **52-Week High Proximity:** Ingested from `bse_near_52week` MCP endpoint for BSE Groups A & B. Count: **36 verified equities** within 8% of 52W high.
3. **Verified Market Capitalisation:** Ingested from `bse_list_securities` MCP tool for Top 343 equities (BSE Groups A & B). Total verified cap: **₹298.0L Cr** (₹2,97,96,109 Cr).
4. **Timestamp & Timezone Semantics:**
   - Trading Date: `2026-11-04` (Isolated trading session date).
   - MCP `dt_tm` (`2026-11-04T16:00:00`): BSE local post-close calculation snapshot (16:00 IST), kept distinct from runtime fetch time.
   - Compilation Fetch Timestamp: `2026-11-04T14:52:23.619Z` (ISO UTC) and `04 Nov 2026, 20:22:23 IST`.

---

## 4. Test Suites & Verification Results

Three automated verification suites cover dataset invariants, frontend DOM security, and end-to-end browser interactions:

| Test Suite | Command | Tests Run | Result | Execution Time |
| :--- | :--- | :---: | :---: | :---: |
| **Dataset Invariants** | `node scripts/verify-dataset.js` | 74 | **74 PASS / 0 FAIL** | ~0.7s |
| **Frontend QA Audit** | `node scripts/qa-frontend-audit.js` | 82 | **82 PASS / 0 FAIL** | ~0.8s |
| **Playwright Real Browser** | `node scripts/browser-test.js` | 51 | **51 PASS / 0 FAIL** | ~4.5s |
| **All Test Suites** | `npm test` | **207** | **207 PASS / 0 FAIL** | **~6.0s** |

### Browser Automation Coverage Highlights
- **Engine:** Headless Chromium v1248 (`Chrome for Testing 156.0.8078.4`).
- **Initial Load:** Table renders 50 rows per page; branded title; status badge indicates 4,965 listed companies.
- **Search:** Real-time debounced (120ms) search by symbol, company name, BSE scrip code, and ISIN.
- **Filter Pills:** ALL (4,965), TOP GAINERS (3,228), TOP LOSERS (1,539), NEAR 52W HIGH (36).
- **Pagination:** Next, Prev, and direct page jumping tested across page boundaries.
- **Stock Detail Modal:** Opens on click; displays genuine 6-session SVG chart; returns grid displays `—` for multi-month unverified periods; closes via Close Button, Escape key, and backdrop click.
- **Keyboard Shortcuts:** `/` key instantly focuses search input.
- **Viewports Tested:** Desktop ($1440 \times 900$), Tablet ($768 \times 1024$), Mobile ($390 \times 844$) with zero horizontal overflow.
- **Clean Execution:** **0 console errors**, **0 asset/logo 404 errors**, and **0 failed local requests**.

---

## 5. Captured Visual Evidence

Screenshots generated during browser automation are saved at:
- **Desktop Viewport:** `test-results/screenshots/desktop-1440x900.png`
- **Tablet Viewport:** `test-results/screenshots/tablet-768x1024.png`
- **Mobile Viewport:** `test-results/screenshots/mobile-390x844.png`

---

## 6. Documented Limitations (Zero Synthetic Data Policy)

1. **Multi-Month Historical Returns (1M, 3M, 1Y):**
   - In accordance with strict exchange data integrity, these fields remain `null` and display em-dash (`—`) with `"Archive unavail."` in the modal.
   - Only 6 daily consecutive trading sessions (2026-10-28 to 2026-11-04) exist in local storage. Multi-month returns are not fabricated or approximated.
2. **Partial Market Capitalization:**
   - Covers the Top 343 verified equities (BSE Groups A & B). The remaining 4,622 scrips display em-dash (`—`).
   - Clearly labeled in the UI as *"Verified Market Cap: Top 343 Equities (NSE + BSE)"*. Not an official SEBI cap categorization.
3. **52-Week High Proximity:**
   - Covers BSE Groups A & B (40 matched scrips, 36 within 8%). Subtitle explicitly reads *"36 verified BSE Group A/B equities"*. NSE-only and lower BSE groups are not surveyed.
4. **Cloud Runner Limitation:**
   - Official NSE and BSE portals enforce Indian IP geofencing and anti-bot verification. Cloud automation via GitHub Actions requires an Indian self-hosted runner or authenticated proxy.

---

## 7. How to Run the Website Locally

### Option A: Direct File Open (Zero Server Dependencies)
Open `index.html` directly in any modern browser:
```bash
# Windows PowerShell
Start-Process "c:\Users\Satya\Stocks\index.html"
```

### Option B: Local HTTP Server
Run any local static server from the project directory:
```bash
# Using npx serve
npx -y serve . -p 8080

# Or using Python
python -m http.server 8080
```
Then navigate to `http://localhost:8080`.

---

## 8. How to Run the Stock Universe Synchronization

To re-ingest fresh Bhavcopy files or update the stock universe:
```bash
# Ensure fresh Bhavcopy CSVs are placed in the downloads/ folder
# Run synchronization script:
node scripts/sync-stock-universe.js
# Or:
npm run sync
```

To run all automated verification suites:
```bash
npm test
```

---

## 9. Final Freeze Confirmation

- **Git Status:** Clean local working tree. No files staged (`git add` was not run). No commits made. No pushes or deployments.
- **Dependencies:** `playwright` remains strictly under `devDependencies`. Zero runtime dependencies added.
- **Integrity:** Theme, layout, branding, colors, typography, and working features fully preserved.

