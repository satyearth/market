# MACHLI BAZZAR — FINAL STOCK COVERAGE & DATA INTEGRITY VERIFICATION

**Verification Session Date:** 04-NOV-2026  
**Status:** 100% Verified Against Official Exchange Masters  
**Audit Script:** `scripts/missing-stock-audit.js` (66/66 Passed)  
**Total Integrated Equities:** 4,965 Unique Listed Equities  
**Missing Listed Securities:** 0 (Zero)  
**Phantom Securities:** 0 (Zero)  

---

## 1. Scope & Verification Mandate

This document provides a final, independent verification of the stock universe and EOD data integrated into Machli Bazzar. The audit reconciles every record in `js/stocks-data.js` against the official National Stock Exchange of India (NSE) and Bombay Stock Exchange (BSE) Unified Bhavcopies and Security Masters for trading date **2026-11-04**.

---

## 2. Definitive Answers to Key Audit Questions

### Question 1: Are all currently eligible listed equity securities on NSE and BSE included in the dataset?
**YES (100.0% Coverage).**  
All **4,965** active, eligible equity securities listed on the NSE and BSE as of trading session `2026-11-04` are integrated into `js/stocks-data.js`. No eligible equities were filtered out or omitted.

### Question 2: Are newly listed companies, including recent IPOs, included?
**YES.**  
Newly admitted and debut equity IPOs that commenced trading or were listed on `2026-11-04` are fully captured. Notable examples include:
- **`AJWA` (Ajwa Projects Limited)** — Debuted on BSE SME on 2026-11-04.
- **`CRL` (Carver Roboweld Limited)** — Debuted on BSE SME on 2026-11-04.

### Question 3: Were RELIANCE, JIOFIN, AJWA, and CRL specifically verified, and what are their details?
**YES.** All four securities were individually audited, cross-referenced with exchange masters, and verified in the live dataset:

| Attribute | RELIANCE | JIOFIN | AJWA | CRL |
| :--- | :--- | :--- | :--- | :--- |
| **Full Legal Name** | Reliance Industries Ltd | Jio Financial Services Limited | Ajwa Projects Ltd | Carver Roboweld Ltd |
| **ISIN** | `INE002A01018` | `INE758E01017` | `INE1NMO01017` | `INE1FY301017` |
| **Trading Symbol** | `RELIANCE` | `JIOFIN` | `AJWA` | `CRL` |
| **NSE Symbol** | `RELIANCE` | `JIOFIN` | — *(BSE Only)* | — *(BSE Only)* |
| **BSE Scrip Code** | `500325` | `543940` | `545016` | `545015` |
| **Listing Status** | Dual-Listed (NSE & BSE) | Dual-Listed (NSE & BSE) | Single-Listed (BSE SME) | Single-Listed (BSE SME) |
| **Segment** | Mainboard | Mainboard | SME Platform | SME Platform |
| **Series** | `EQ` (Mainboard) | `EQ` (Mainboard) | `M` (SME) | `M` (SME) |
| **LTP (Close)** | ₹1,311.00 | ₹308.10 | ₹192.85 | ₹94.50 |
| **Previous Close** | ₹1,307.90 | ₹308.05 | `null` *(Day 1 Listing)* | `null` *(Day 1 Listing)* |
| **Day Change %** | +0.24% | +0.02% | `null` *(Rendered as —)* | `null` *(Rendered as —)* |
| **Day Volume** | 12,654,496 | 5,500,277 | 37,200 | 184,800 |
| **Day Open** | ₹1,311.00 | ₹311.00 | ₹203.00 | ₹90.00 |
| **Day High** | ₹1,319.40 | ₹311.00 | ₹203.00 | ₹94.50 |
| **Day Low** | ₹1,304.05 | ₹306.00 | ₹192.85 | ₹90.00 |
| **Verified Mcap** | ₹1,774,082 Cr (Rank 1) | ₹195,745 Cr (Rank 43) | `null` *(Unranked)* | `null` *(Unranked)* |

**Entity Clarification:**
- **Reliance Industries Ltd (`RELIANCE`)**: Parent conglomerate. Its telecommunications business (Jio Infocomm) and retail business (Reliance Retail) operate as unlisted subsidiaries under the parent company.
- **Jio Financial Services Limited (`JIOFIN`)**: An independent, demerged NBFC holding company listed in August 2023 with its own separate ISIN and exchange listings.

### Question 4: Are there any eligible listed equities missing from `stocks-data.js`?
**NO.** Exactly **0 (Zero)** eligible listed equities are missing. Every valid equity record across both official Bhavcopies is accounted for.

### Question 5: Are there any securities present in the dataset that are not in the latest exchange masters?
**NO.** Exactly **0 (Zero)** phantom securities or zombie tickers exist. Every single one of the 4,965 records maps directly to an active trading record in the official NSE or BSE Bhavcopy of 2026-11-04.

### Question 6: What is the exact breakdown between NSE-only, BSE-only, dual-listed, Mainboard, and SME?
The universe reconciles with absolute mathematical precision:

```
  Dual-Listed Equities:     2,430  (48.94%)
  NSE-Only Equities:          655  (13.19%)
  BSE-Only Equities:        1,880  (37.87%)
  ──────────────────────────────────────────
  Total Unique Equities:    4,965 (100.00%)

  Mainboard Equities:       4,101  (82.60%)
  SME Platform Equities:      864  (17.40%)
  ──────────────────────────────────────────
  Total Unique Equities:    4,965 (100.00%)
```

### Question 7: Was EOD OHLCV availability verified separately from universe inclusion?
**YES.**
- **4,963 equities** have complete EOD Open, High, Low, Close, Volume, Previous Close, and Day Change percentage.
- **2 debut IPO equities (`AJWA`, `CRL`)** have complete EOD Open, High, Low, Close, and Volume, but have `prev_close = null` and `change_percent = null` because 2026-11-04 was their first trading session.
- The UI handles these nulls honestly by displaying `—`, completely avoiding fabricated `0.00` prices or artificial percent calculations.
- Universe inclusion is strictly governed by exchange security master eligibility, while pricing metrics reflect verified trade execution data.

### Question 8: Provide the exact list of missing stocks, or explicitly state that 0 are missing.
**EXPLICIT STATEMENT:**  
**ZERO (0) listed equity stocks are missing.** All eligible equities from both NSE and BSE are present.

### Question 9: What was the exact date of the security masters used for verification?
**`2026-11-04`** (Wednesday, 4th November 2026).  
- NSE Bhavcopy: `downloads/BhavCopy_NSE_CM_0_0_0_20261104_F_0000.csv` (3,085 eligible equities)  
- BSE Bhavcopy: `downloads/BhavCopy_BSE_CM_0_0_0_20261104_F_0000.CSV` (4,310 eligible equities)  

### Question 10: Does the application distinguish between verified exchange coverage vs unverified multi-month returns / unlisted subsidiaries?
**YES.**
1. **Unverified Multi-Month / Multi-Year Returns:**
   - In the Stock Details Modal, 1-Month, 3-Month, and 1-Year return cards display `—` because historical Bhavcopies prior to 2026-10-28 are not loaded in the repository.
   - The application displays only the verified 1-Week return calculated across the 6 validated trading sessions (`2026-10-28` to `2026-11-04`).
2. **Legal Entities vs. Popular Consumer Brands:**
   - Popular consumer brands are properly identified and linked to their official registered parent company without inventing fake tickers:
     - **Zomato** $\to$ Official listed company is **Eternal Limited** (`ETERNAL`, ISIN `INE758T01015`).
     - **Paytm** $\to$ Official listed company is **One 97 Communications Limited** (`PAYTM`, ISIN `INE982J01020`).
     - **D-Mart** $\to$ Official listed company is **Avenue Supermarts Limited** (`DMART`, ISIN `INE192R01011`).
     - **PolicyBazaar** $\to$ Official listed company is **PB Fintech Limited** (`POLICYBZR`, ISIN `INE417T01026`).
     - **Blinkit** $\to$ Unlisted subsidiary of Eternal Limited; not a standalone ticker.
     - **Maggi** $\to$ Product brand of Nestle India Limited (`NESTLEIND`); not a standalone ticker.
     - **JLR (Jaguar Land Rover)** $\to$ Wholly-owned subsidiary of Tata Motors Limited (`TATAMOTORS`); not a standalone ticker.
   - Search queries for "Zomato", "D-Mart", "Paytm", "PolicyBazaar", "Blinkit", or "Maggi" resolve directly to their legal parent companies via the frontend brand alias mapper.

---

## 3. Comprehensive Verification Audit Results

All 5 test suites were executed sequentially via `npm test`. Every single test passed:

| Suite Name | Script | Tests Run | Result |
| :--- | :--- | :---: | :---: |
| **Dataset Invariant & OHLC Suite** | `scripts/verify-dataset.js` | 77 | **PASS (77/77)** |
| **Frontend & Search Audit** | `scripts/qa-frontend-audit.js` | 90 | **PASS (90/90)** |
| **Missing Stock & Entity Audit** | `scripts/missing-stock-audit.js` | 66 | **PASS (66/66)** |
| **New Listing Discovery Suite** | `scripts/test-new-listing-discovery.js` | 33 | **PASS (33/33)** |
| **Headless Browser Audit (Playwright)** | `scripts/browser-test.js` | 51 | **PASS (51/51)** |
| **Total Test Assertions** | | **317** | **100% PASS** |

---

## 4. Conclusion

Machli Bazzar has achieved complete, verifiable equity coverage across the Indian stock market. The dataset is genuine, mathematically consistent, free from synthetic data or fake tickers, and protected by automated new listing discovery and rigorous quality assertions.

