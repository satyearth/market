# Machli Bazzar — Phase 2.3: Final Data Integrity & Metadata Audit Report

**Date:** 04-Nov-2026  
**Status:** Complete & Verified  
**Total Automated Tests:** 207 / 207 Passed (100% Pass Rate across 3 test suites)  
**Workspace:** `C:\Users\Satya\Stocks`

---

## 1. Extreme Price Movement Verification

An audit was performed to trace the reported extreme price outliers in the unified dataset (`STOCKS_DATA`):
- **Top Gainer:** `MELSTAR` (`+3365.00%`)
- **Top Loser:** `ENNATURE` (`-62.15%`)
- **Notable Demerger Outlier:** `IGLSPIRITS` (`+315.59%`)

### A. Investigation of `MELSTAR` (+3365.00%)
- **Symbol:** `MELSTAR` | **Company:** Melstar Information Technologies Limited | **ISIN:** `INE817A01050`
- **Exchange & Series:** Dual-listed on NSE (Series `BE` — Trade-to-Trade) and BSE (Group `T`, Scrip `532307`).
- **Tracing to Raw Exchange Bhavcopy Records:**
  - **NSE Unified Bhavcopy** (`downloads/BhavCopy_NSE_CM_0_0_0_20261104_F_0000.csv:2075`):
    ```csv
    2026-11-04,2026-11-04,CM,NSE,STK,7575,INE817A01050,MELSTAR,BE,,,,,MELSTAR INFO TEC LTD,330.00,346.50,330.00,346.50,346.50,10.00,,346.50,,,6256,2164338.00,73,F1,1,,,,,
    ```
    - Closing Price (`ClsPric`): **₹346.50**
    - Previous Close (`PrvsClsgPric`): **₹10.00**
    - Traded Volume (`TtlTradgVol`): **6,256 shares** across 73 trades (Value: ₹21.64 Lakh).
    - Exchange Computed Change: $\frac{346.50 - 10.00}{10.00} \times 100 = \mathbf{+3365.00\%}$.
  - **BSE Unified Bhavcopy** (`downloads/BhavCopy_BSE_CM_0_0_0_20261104_F_0000.CSV:2047`):
    ```csv
    2026-11-04,2026-11-04,CM,BSE,STK,532307,INE817A01050,MELSTAR,T,,,,,MELSTAR INFORMATION TECHNOLOGI,329.99,346.48,329.99,346.48,346.48,4.32,,346.50,,,41,14172.00,14,F1,1,,,,,
    ```
    - Closing Price: **₹346.48** | Previous Close: **₹4.32** (BSE historical last traded price).
- **Corporate Action & Market Mechanics:**
  - Melstar was suspended under CIRP / IBC proceedings and re-admitted to trading on `2026-11-04` under trade-to-trade series without standard 5%/20% circuit bands.
  - The exchange assigned a nominal face-value reference price of ₹10.00 on NSE for the resumption session. Free price discovery resulted in market trades between ₹329.99 and ₹346.50.
- **Verdict:** **VALID EXCHANGE DATA**. The $+3365.00\%$ is an official exchange-reported metric stemming from the official exchange reference baseline. It has been preserved as genuine exchange data.

---

### B. Investigation of `ENNATURE` (-62.15%) and `IGLSPIRITS` (+315.59%)
- **Symbol:** `ENNATURE` | **Company:** Ennature Bio Pharma Limited | **ISIN:** `INE2WCT01016`
- **Exchange & Series:** Dual-listed on NSE (Series `BE`) and BSE (Group `T`, Scrip `545012`).
- **Tracing to Raw Exchange Bhavcopy Records:**
  - **NSE Unified Bhavcopy** (`downloads/BhavCopy_NSE_CM_0_0_0_20261104_F_0000.csv:1002`):
    ```csv
    2026-11-04,2026-11-04,CM,NSE,STK,766934,INE2WCT01016,ENNATURE,BE,,,,,ENNATURE BIO PHARMA LTD,264.90,264.90,251.70,251.70,251.70,665.05,,252.03,,,54233,13755872.70,563,F1,1,,,,,
    ```
    - Closing Price (`ClsPric`): **₹251.70**
    - Previous Close (`PrvsClsgPric`): **₹665.05** (Pre-listing allocated cost basis).
    - Traded Volume: **54,233 shares** across 563 trades (Value: ₹1.38 Cr).
    - Exchange Computed Change: $\frac{251.70 - 665.05}{665.05} \times 100 = \mathbf{-62.15\%}$.
  - **BSE Unified Bhavcopy** (`downloads/BhavCopy_BSE_CM_0_0_0_20261104_F_0000.CSV:4520`):
    ```csv
    2026-11-04,2026-11-04,CM,BSE,STK,545012,INE2WCT01016,ENNATURE,T,,,,,Ennature Bio Pharma Limited,275.00,275.00,261.25,261.25,261.25,0.00,,252.03,,,1247,327978.00,71,F1,1,,,,,
    ```
- **Companion Demerger Stock (`IGLSPIRITS`):**
  - Symbol: `IGLSPIRITS` | ISIN: `INE2W6901017` | BSE Scrip: `545013`
  - Allocated Pre-listing Base: **₹221.68** | Discovered Close: **₹921.27** | Change: $\mathbf{+315.59\%}$.
- **Corporate Action & Market Mechanics:**
  - Both companies originated from the NCLT-approved composite Scheme of Arrangement demerging India Glycols Limited into `IGL Spirits Limited` and `Ennature Bio Pharma Limited`.
  - Both were newly listed on `2026-11-04` with sequential BSE codes `545012` and `545013`.
  - The exchange pre-opening price calculation allocated pre-demerger market value across the two entities. Price discovery caused Ennature to settle at ₹251.70 (-62.15%) and IGL Spirits at ₹921.27 (+315.59%).
- **Verdict:** **VALID EXCHANGE DATA**. Both movements reflect genuine price discovery following a major corporate restructuring. Neither movement is synthetic or corrupted.

---

## 2. SEO Metadata Accuracy Audit

### Changes Made to `index.html`
The metadata was revised to prevent falsely implying that all 4,965 stocks have verified market-cap rankings:

| Element | Previous Value | Corrected Value |
| :--- | :--- | :--- |
| `<title>` | `All Stocks \| 4,965 Indian Stocks Ranked by Market Cap \| Machli Bazzar` | **`NSE & BSE Listed Equities \| Machli Bazzar`** |
| `<meta name="description">` | `Browse 4,965 Indian stocks (NSE + BSE) ranked by market capitalisation. Current prices, multi-period returns, and sector filters.` | **`Browse 4,965 Indian equities listed on NSE & BSE. End-of-day closing prices, market breadth, and sector intelligence.`** |
| `<meta property="og:title">` | `All Stocks \| 4,965 Indian Stocks Ranked by Market Cap \| Machli Bazzar` | **`NSE & BSE Listed Equities \| Machli Bazzar`** |
| `<meta property="og:description">` | `India's stock market intelligence: real-time screening, multi-period performance, and valuation metrics.` | **`India's equity market intelligence: 4,965 listed companies across NSE & BSE, EOD closing prices, and sector screening.`** |

*Visible UI typography, theme tokens, and layout were kept strictly intact.*

---

## 3. Browser Test Reproducibility & Stability

The Playwright browser test suite was executed across multiple consecutive runs:
1. **Full Suite (`npm test`):** 207 / 207 Passed (Dataset: 74, QA: 82, Browser: 51).
2. **Consecutive Run 1 (`npm run test:browser`):** 51 / 51 Passed (0 failures).
3. **Consecutive Run 2 (`npm run test:browser`):** 51 / 51 Passed (0 failures).

### Findings on Flakiness
- **Flaky Tests:** **0**. All 51 assertions passed deterministically across consecutive runs.
- **Resource Management:** Headless Chromium v1248 launches and terminates cleanly.
- **Network Invariants:** **0 console errors**, **0 asset/logo 404 errors**, and **0 failed local requests**.
- **Visual Artifacts:** All three viewport screenshots are preserved in `test-results/screenshots/`:
  - `desktop-1440x900.png` (115.7 KB)
  - `tablet-768x1024.png` (114.6 KB)
  - `mobile-390x844.png` (50.6 KB)

---

## 4. Summary of Verification Status

| Suite | Status | Passed / Total |
| :--- | :---: | :---: |
| `scripts/verify-dataset.js` | **PASS** | 74 / 74 |
| `scripts/qa-frontend-audit.js` | **PASS** | 82 / 82 |
| `scripts/browser-test.js` | **PASS** | 51 / 51 |
| **Combined Total** | **PASS** | **207 / 207** |

---

## 5. Unresolved Methodological Limitations (Preserved by Design)

1. **Multi-Month Returns (1M, 3M, 1Y):**
   - Retained as `null` (displaying `—` with subtitle `"Archive unavail."` in the modal).
   - Only 6 daily Bhavcopy sessions exist in local storage. Synthesizing these metrics is strictly disallowed.
2. **Market Capitalization Coverage:**
   - 343 verified scrips from BSE Groups A & B (₹298.0L Cr total cap); remaining 4,622 scrips display em-dash (`—`).
   - Labeled as `"Verified Market Cap: Top 343 Equities (NSE + BSE)"`.
3. **52-Week High Survey Scope:**
   - Surveys BSE Groups A & B (40 matched scrips, 36 within 8%).
   - Labeled as `"36 verified BSE Group A/B equities"` with source tag `"BSE MCP (04-Nov-2026)"`.
4. **Cloud Execution Geofencing:**
   - Exchange Bhavcopy feeds block automated traffic from public cloud runner IP ranges. Automated execution via GitHub Actions requires an Indian self-hosted runner or proxy secret.

---

## 6. Git State Confirmation

- Staged changes: **0** (`git add` has not been run).
- Commits: **0**.
- Pushes: **0**.
- Deployments: **0**.
- All files remain strictly local.

