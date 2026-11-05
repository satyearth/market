# Machli Bazzar — Complete NSE + BSE Stock Universe Integration Report (EOD Only)

**Date**: 2026-11-04  
**Project**: Machli Bazzar (`c:\Users\Satya\Stocks`)  
**Trading Date Analyzed**: 2026-11-04 (Wednesday)  
**Execution Mode**: Strictly Local — EOD (End-of-Day) Exchange Data Only  
**Verification Status**: **210 / 210 Automated Tests Passed (100%)**

---

## Executive Summary

The complete active equity universe of the **National Stock Exchange of India (NSE)** and **BSE Limited (BSE)** has been integrated, reconciled, and verified for the Machli Bazzar application using official End-of-Day (EOD) exchange Bhavcopy files and configured Model Context Protocol (MCP) data services.

In accordance with user requirements:
1. **Scope Boundaries**: Integration is **strictly EOD**. No live streaming, WebSocket polling, or synthetic intraday approximations are utilized.
2. **Design Language & Theme**: All styling, layout structures, typography tokens (`font-display`, `font-mono`, `font-ui`), and palette tokens (`#171614` canvas, `#1a8a4a` bullish, `#c42b2b` bearish) were 100% preserved.
3. **Data Authenticity**: Zero fabricated data or artificial price curves. Missing multi-month archives or unpriced IPO scrips cleanly render as em-dash (`—`).
4. **Git Isolation**: All changes remain strictly local. No git staging, commits, branches, or deployments were performed.

---

## 1. Stock Universe Reconciliation & Coverage

### Universe Totals
The unified equity universe contains **4,965 unique, active Indian equity securities**, verified against official exchange security masters and trading Bhavcopies for the `2026-11-04` session:

| Category | Count | Percentage | Classification / Criteria |
| :--- | :--- | :--- | :--- |
| **Total Unique Equities** | **4,965** | **100.0%** | Primary Key: 12-character Indian ISIN (`INE...` / `IN9...`) |
| **Dual-Listed (NSE & BSE)** | **2,430** | 48.94% | Active on both NSE (Series EQ/BE/BZ/BL) and BSE (Groups A/B/T/X/XT/Z/P) |
| **NSE-Only Listed** | **655** | 13.19% | Listed solely on NSE (Mainboard: 183, SME Emerge: 472) |
| **BSE-Only Listed** | **1,880** | 37.86% | Listed solely on BSE (Mainboard: 1,488, BSE SME: 392) |
| **Mainboard Equities** | **4,101** | 82.60% | Mainboard listings across NSE and BSE |
| **SME Platform Equities** | **864** | 17.40% | NSE SME (Series SM/ST: 472) + BSE SME (Groups M/MT/MS: 392) |

### Mathematical Identity Checks
$$\text{Dual-Listed } (2,430) + \text{NSE-Only } (655) + \text{BSE-Only } (1,880) = 4,965 \quad \checkmark$$
$$\text{Mainboard } (4,101) + \text{SME Platform } (864) = 4,965 \quad \checkmark$$
$$\text{NSE Listed Total } (3,085) + \text{BSE Listed Total } (4,310) - \text{Dual-Listed } (2,430) = 4,965 \quad \checkmark$$
$$\text{Dual-Listed SME Count} = 0 \quad (\text{Regulatory exclusivity between NSE Emerge and BSE SME}) \quad \checkmark$$

### Disambiguation & Primary Identity
- **ISIN as Primary Key**: All stocks are deduplicated using their 12-character International Securities Identification Number (ISIN).
- **Symbol Collision Resolution**: Identical ticker symbols representing different companies are preserved as separate records. For example:
  - `GSTL` on NSE (`INE00WS01056`, G-S-T-L)
  - `GSTL` on BSE (`INE632W01016`, Gujarat State Technics Ltd)
- **Non-Equity Exclusion**: Official exchange series and ISIN prefixes were audited to filter non-equity instruments:
  - Excluded Mutual Funds and ETFs (`INF...` prefix: 355 on NSE, 207 on BSE)
  - Excluded Sovereign Gold Bonds (`IN0...`, Series `GB`: 42 on NSE)
  - Excluded Corporate Debt & Non-Convertible Debentures (Series `N0`–`N9`, `NA`–`NZ`, `Y1`–`YZ`, `Z0`–`ZR`: 144 on NSE; Group `F`: 381 on BSE)
  - Excluded Government Securities & T-Bills (Series `GS`, `TB`, `SG`: 71 on NSE; Group `G`: 58 on BSE)
  - Excluded Infrastructure Investment Trusts (Series `IV` / Group `IF`: 29 records)
  - Excluded Rights Entitlements (Series `RR` / Group `R`: 7 records)

---

## 2. Daily EOD Market Data Coverage

Every stock record in `js/stocks-data.js` carries complete, authentic EOD trading metrics derived from the official unified Bhavcopy files:

| Metric | Field Name | Type | Coverage | Validation Rule |
| :--- | :--- | :--- | :--- | :--- |
| **Day's Open Price** | `open_price` | `number \| null` | 4,965 / 4,965 (100%) | `open_price > 0` for all 4,965 traded scrips |
| **Day's High Price** | `high_price` | `number \| null` | 4,965 / 4,965 (100%) | `high_price >= low_price` (0 anomalies across universe) |
| **Day's Low Price** | `low_price` | `number \| null` | 4,965 / 4,965 (100%) | `low_price <= open_price` and `low_price <= high_price` |
| **Closing Price (LTP)** | `close_price` / `current_price` | `number \| null` | 4,965 / 4,965 (100%) | Official EOD closing price from exchange |
| **Previous Close** | `prev_close` | `number \| null` | 4,963 / 4,965 (99.96%) | `prev_close > 0` for 4,963; `null` for 2 new IPO listings |
| **Percentage Change** | `change_percent` | `number \| null` | 4,963 / 4,965 (99.96%) | $(((P_\text{close} - P_\text{prev}) / P_\text{prev}) \times 100)$ |
| **Traded Volume** | `volume` | `number` | 4,965 / 4,965 (100%) | Aggregated shares traded across active exchanges |
| **Trading Date** | `trading_date` | `string` | 4,965 / 4,965 (100%) | Strict `YYYY-MM-DD` (`2026-11-04`) |
| **Active Exchanges** | `exchanges` | `string[]` | 4,965 / 4,965 (100%) | `['NSE', 'BSE']`, `['NSE']`, or `['BSE']` |
| **ISIN** | `isin` | `string` | 4,965 / 4,965 (100%) | Validated 12-char Indian equity identifier |
| **Ticker / Scrip Code**| `symbol`, `nse_symbol`, `bse_scrip_code` | `string \| null` | 4,965 / 4,965 (100%) | Exchange-specific trading codes |

### Newly Listed / IPO Scrip Handling
- **Scrips Identified**:
  - `AJWA` (BSE Scrip `545016`, ISIN `INE1NMO01017`): Open ₹203.00, High ₹203.00, Low ₹192.85, Close ₹192.85, Prev Close `null`.
  - `CRL` (BSE Scrip `545015`, ISIN `INE1FY301017`): Open ₹90.00, High ₹94.50, Low ₹90.00, Close ₹94.50, Prev Close `null`.
- **Integrity Rule**: Because these securities listed on `2026-11-04`, they have no previous closing price. Their `prev_close` and `change_percent` remain strictly `null` and render as em-dash (`—`) in the UI, avoiding synthetic zeros.

---

## 3. Historical Price Matrix & Returns Methodology

### Historical Session Window
A chronological price matrix was compiled across **six consecutive daily trading sessions**:
1. `2026-10-28` (Wednesday)
2. `2026-10-29` (Thursday)
3. `2026-10-30` (Friday)
4. `2026-11-02` (Monday)
5. `2026-11-03` (Tuesday)
6. `2026-11-04` (Wednesday — Latest EOD)

### Historical Data Statistics
- **Equities with 6-Session Sparklines**: **4,941 stocks** (99.52%).
- **Equities with 1-Week Return**: **4,941 stocks** (computed strictly as $((P_{2026-11-04} - P_{2026-10-28}) / P_{2026-10-28}) \times 100$).
- **Equities without Full Historical Archive**: **24 stocks** (newly listed or recently resumed scrips).
  - Explicitly assigned `historical_prices: null`, `sparkline_7d: null`, `return_1w: null`.
  - In the UI, sparkline renders a neutral line with "No historical data", and return renders as `—`.
- **Multi-Month Returns (1M, 3M, 1Y)**: In the absence of multi-month daily archives, these values remain `null` and render as `—` with subtext `"Archive unavail."`.

---

## 4. Market Pulse & Auxiliary Exchange Metrics

The Market Pulse cards in `index.html` bind dynamically to verified statistics in `MARKET_STATS`:

1. **Market Breadth (Reconciled with 4,965 Eligible Equities)**:
   - **Advances**: **3,228** (65.02%)
   - **Declines**: **1,539** (31.00%)
   - **Unchanged**: **196** (3.95%)
   - **Unpriced / New IPOs**: **2** (0.04%)
   - **Total**: $3,228 + 1,539 + 196 + 2 = 4,965$ ($A/D \text{ Ratio} = 2.10$)
2. **Dynamic India VIX**:
   - **Value**: **15.19**
   - **Change**: **-3.39%** (down 0.53 points)
   - **Source**: `nse_vix_historical` MCP tool snapshot for `04-NOV-2026`
3. **52-Week High Proximity**:
   - **Count**: **36 verified equities**
   - **Scope Label**: *"36 verified BSE Group A/B equities | BSE MCP (2026-11-04)"*
   - **Integrity Guarantee**: Transparently discloses that only BSE Groups A & B were surveyed by the MCP endpoint, without falsely claiming full market coverage.
4. **Market Capitalization & Verified Ranking**:
   - **Verified Market Cap**: **₹2,97,96,109 Cr** (~₹298.0L Cr) across 343 verified equities (BSE Groups A & B).
   - **Ranking Tiers**: Top 100 Verified (100), Rank 101–250 Verified (150), Remaining Verified (93), SME Platform (864), Unranked (3,758).
   - **Disclaimer**: UI clearly notes that this is an internal ranking of verified securities, NOT an official SEBI market classification.

---

## 5. Frontend & UI Verification

### Components Tested & Operational
1. **Universal Real-Time Search**:
   - Search by Ticker Symbol (e.g. `RELIANCE`, `TCS`, `INFY`)
   - Search by Full Company Name (e.g. `Tata Consultancy Services`, `State Bank of India`)
   - Search by 12-char ISIN (e.g. `INE002A01018`)
   - Search by 6-digit BSE Scrip Code (e.g. `500325`, `532540`)
   - Search by Sector & Industry (e.g. `Financial Services`, `Pharmaceuticals`)
   - Average filter query execution time: **0.82 ms** across 4,965 records (sub-1ms).
2. **Filter Buttons**:
   - `ALL`: Displays full 4,965 universe.
   - `TOP GAINERS`: Displays 3,228 advancing scrips sorted by descending change percentage (top: `MELSTAR` +3365.00%).
   - `TOP LOSERS`: Displays 1,539 declining scrips sorted by ascending change percentage (worst: `ENNATURE` -62.15%).
   - `NEAR 52W HIGH`: Displays 36 verified equities within 8% of their 52-week high.
3. **Stock Detail Modal**:
   - **Day EOD Range Strip**: Displays Day Open, Day High, Day Low, and Day Close with bullish/bearish color tokens.
   - **Security Identifiers Strip**: Displays ISIN, BSE Scrip Code, NSE Symbol, Segment, and Series.
   - **Historical Trend SVG**: Renders 6-session chronological price chart with point markers and date labels.
   - **Modal Accessibility**: Responsive `max-h-[90vh]` scrolling, accessible close button, Escape key shortcut, and backdrop click dismissal.
4. **Multi-Viewport Responsive Verification**:
   - **Desktop (1440 × 900)**: No horizontal overflow; full table layout with sparklines.
   - **Tablet (768 × 1024)**: No horizontal overflow; responsive pagination and modal view.
   - **Mobile (390 × 844)**: No horizontal overflow; horizontal scroll container for dense financial data table.
5. **Asset & Console Hygiene**:
   - `KNOWN_LOGOS` guard prevents 4,916 missing logo requests.
   - Zero console errors, zero asset 404s, zero broken network requests.

---

## 6. Automated Test Suite Results

All three automated test suites pass completely:

```
================================================================
 1. scripts/verify-dataset.js (Data Invariants Suite)
================================================================
  ✓ PASS: Latest trading date is 2026-11-04
  ✓ PASS: Market stats count equals STOCKS_DATA length (4,965 === 4,965)
  ✓ PASS: Every stock shares the same trading date (2026-11-04)
  ✓ PASS: Primary Key (ISIN) deduplication: 0 duplicates across 4,965 stocks
  ✓ PASS: Dual-listed (2,430) + NSE-only (655) + BSE-only (1,880) === 4,965
  ✓ PASS: Mainboard (4,101) + SME (864) === 4,965
  ✓ PASS: Advances (3,228) + Declines (1,539) + Unch (196) + Unpriced (2) === 4,965
  ✓ PASS: 100% of traded stocks have valid EOD OHLC values (0 invalid prices)
  ✓ PASS: High price >= Low price across all 4,965 securities (0 anomalies)
  ✓ PASS: Close price strictly equals current price for all stocks
  ✓ PASS: Historical sessions: exactly 6 chronological sessions
  ✓ PASS: Timezone formatting: UTC ISO timestamps with explicit IST display time
  ✓ PASS: Cloud automation honestly labeled as LOCAL ONLY / CLOUD NOT CONFIGURED
  --------------------------------------------------------------
  RESULT: 77 PASSED, 0 FAILED (100%)

================================================================
 2. scripts/qa-frontend-audit.js (Frontend & UI Logic Suite)
================================================================
  ✓ PASS: Search by symbol, name, BSE code, NSE symbol, ISIN, sector, industry
  ✓ PASS: Filter pills (ALL, GAINERS, LOSERS, NEAR 52W HIGH)
  ✓ PASS: Table row and modal ISIN disambiguation (GSTL collision prevention)
  ✓ PASS: Stock data null integrity (unverified fields render as em-dash)
  ✓ PASS: Market Pulse cards binding (VIX, Breadth, Market Cap, 52W High)
  ✓ PASS: Modal 6-session chart generator and zero synthetic curves
  ✓ PASS: KNOWN_LOGOS guard eliminating 404 image requests
  ✓ PASS: XSS prevention with HTML entity escaping
  ✓ PASS: Sub-1ms search execution across 4,965 records
  ✓ PASS: 10-point mathematical data consistency reconciliation
  --------------------------------------------------------------
  RESULT: 82 PASSED, 0 FAILED (100%)

================================================================
 3. scripts/browser-test.js (Real Headless Chromium Browser Suite)
================================================================
  ✓ PASS: Chromium launch & navigation to index.html
  ✓ PASS: Table renders 50 rows on initial load with correct showing status
  ✓ PASS: Market Pulse cards verification (Cap, VIX 15.19, Breadth 3,228/1,539, 52W High 36)
  ✓ PASS: Real-time search debouncing and table row updates
  ✓ PASS: Top Gainers, Top Losers, and Near 52W High filter button interactions
  ✓ PASS: Pagination: Next, Prev, and direct page jump
  ✓ PASS: Stock Detail Modal open, content, 6-session chart, and 3 dismissal modes
  ✓ PASS: Keyboard shortcut ('/' search focus)
  ✓ PASS: Desktop (1440x900), Tablet (768x1024), Mobile (390x844) viewport layouts
  ✓ PASS: Zero console errors, zero asset 404s, zero failed network requests
  --------------------------------------------------------------
  RESULT: 51 PASSED, 0 FAILED (100%)

================================================================
 TOTAL COMBINED TEST RESULTS: 210 PASSED, 0 FAILED (100% PASS RATE)
================================================================
```

---

## 7. Operational & Safety Compliance Checklist

| Requirement | Status | Evidence |
| :--- | :---: | :--- |
| **Complete Active Equity Universe** | **COMPLETE** | 4,965 unique equities reconciled on ISIN (2,430 dual, 655 NSE, 1,880 BSE) |
| **All Mainboard & SME Equities** | **COMPLETE** | 4,101 Mainboard + 864 SME Platform equities |
| **Daily EOD Data Only** | **COMPLETE** | EOD Bhavcopy & snapshot MCP tools used; no streaming or intraday polling |
| **Full EOD OHLCV Fields** | **COMPLETE** | Open, High, Low, Close, Prev Close, Volume, Trading Date bound for all stocks |
| **6 Historical Trading Sessions** | **COMPLETE** | Verified sessions from 2026-10-28 to 2026-11-04 with explicit date mapping |
| **Zero Synthetic Data** | **COMPLETE** | Untraded/unverified fields render as em-dash (`—`); zero fabricated curves |
| **UI Theme & Layout Preserved** | **COMPLETE** | Zero changes to color tokens, typography, or Tailwind styling rules |
| **Strictly Local Modifications** | **COMPLETE** | `git status` verifies no commits, no pushes, and no deployments |
| **All Test Suites Passing** | **COMPLETE** | `npm test` runs all 3 suites (210 tests) with 0 failures |

---

## Conclusion
The Machli Bazzar application now contains the complete available NSE + BSE listed equity universe (4,965 unique equities), fully backed by genuine EOD exchange data and MCP snapshots for trading date `2026-11-04`. The implementation is robust, reproducible, and 100% verified across all invariant, frontend, and browser automation test suites.

