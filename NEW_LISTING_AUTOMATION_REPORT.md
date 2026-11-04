# MACHLI BAZZAR — AUTOMATIC NEW LISTED STOCK DISCOVERY REPORT

**Report Date:** 04-NOV-2026  
**Implementation Status:** Fully Implemented, Verified, and Tested  
**Verification Suite:** `scripts/test-new-listing-discovery.js` (33/33 Checks Passed)  
**Total Verification Tests:** 317 / 317 Passing Across 5 Test Suites  

---

## 1. Executive Summary

Machli Bazzar now features a robust, fully automated **New Listed Stock Discovery Engine** integrated directly into the daily EOD sync workflow (`scripts/sync-stock-universe.js`).

During each daily synchronization cycle, the system:
1. Automatically retrieves the official NSE and BSE security masters and EOD Bhavcopies via configured MCP tools.
2. Compares the incoming security master records against the previously saved stock universe (`js/stocks-data.js`) using the 12-character International Securities Identification Number (**ISIN**) as the immutable primary key.
3. Automatically classifies and registers:
   - **Newly Listed Companies** (Mainboard and SME IPO debuts).
   - **New Exchange Listings** (dual-listing expansion, e.g., an existing BSE stock listing on NSE or vice-versa).
   - **Symbol / Ticker Changes** (corporate rebrandings or ticker updates).
   - **Series / Segment Changes** (e.g., transfers from EQ to BE/BZ, or SME migrations).
   - **Delisted / Suspended Securities** (untraced or archived ISINs).
4. Preserves 100% of existing historical data (`historical_prices`, `sparkline_7d`, and verified benchmark metadata).
5. Gracefully handles pre-trading / unpriced listings by setting missing values to `null` and rendering them as em-dashes (`—`), strictly prohibiting synthetic zeros.
6. Emits an immutable, dated audit log to `downloads/universe-changes-YYYY-MM-DD.json` and embeds a high-level summary inside `MARKET_STATS`.
7. Enforces idempotency and download failure safety (aborting sync without touching the universe if incoming files are missing or truncated below 1,000 records).

---

## 2. Architecture & Data Flow

```
                               ┌──────────────────────────────────────────────┐
                               │       Daily Sync Trigger: sync-stock-        │
                               │                 universe.js                  │
                               └──────────────────────┬───────────────────────┘
                                                      │
                       ┌──────────────────────────────┴──────────────────────────────┐
                       │                                                             │
                       ▼                                                             ▼
       ┌───────────────────────────────┐                             ┌───────────────────────────────┐
       │   Previous Universe Loader    │                             │      MCP Master Downloads     │
       │   - Reads js/stocks-data.js   │                             │   - NSE Unified Bhavcopy CSV  │
       │   - Maps by ISIN              │                             │   - BSE Unified Bhavcopy CSV  │
       │   - Preserves 6-day history   │                             │   - Min 1,000 rows threshold  │
       └───────────────┬───────────────┘                             └───────────────┬───────────────┘
                       │                                                             │
                       └──────────────────────────────┬──────────────────────────────┘
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │   ISIN Diff & Discovery     │
                                       │          Engine             │
                                       └──────────────┬──────────────┘
                                                      │
                       ┌──────────────────────────────┼──────────────────────────────┐
                       │                              │                              │
                       ▼                              ▼                              ▼
        ┌──────────────────────────────┐┌──────────────────────────────┐┌──────────────────────────────┐
        │       New Listings           ││     Exchange Expansions      ││     Symbol/Series Changes    │
        │ - Brand new ISIN             ││ - Known ISIN added to NSE/BSE││ - Track symbol renames       │
        │ - Mainboard or SME tagged    ││ - Dual-listing status active ││ - Track settlement changes   │
        └──────────────┬───────────────┘└──────────────┬───────────────┘└──────────────┬───────────────┘
                       │                              │                              │
                       └──────────────────────────────┼──────────────────────────────┘
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │    EOD Pricing & Pricing    │
                                       │         Null-Safety         │
                                       │ - Verified Bhavcopy OHLCV   │
                                       │ - Pre-trading? Price = null │
                                       └──────────────┬──────────────┘
                                                      │
                       ┌──────────────────────────────┴──────────────────────────────┐
                       │                                                             │
                       ▼                                                             ▼
        ┌──────────────────────────────┐                             ┌──────────────────────────────┐
        │     Dated Change Log File    │                             │   Updated js/stocks-data.js  │
        │ universe-changes-YYYY-MM-DD  │                             │  - 4,965 Unique Equities     │
        │ - Detailed delta audit trail │                             │  - MARKET_STATS Change Stat  │
        └──────────────────────────────┘                             └──────────────────────────────┘
```

---

## 3. Core Engine Components

### 3.1. Previous Universe Loader & Historical Preservation
Before processing incoming files, the sync engine loads the active universe:
- Parses `js/stocks-data.js` via Node.js VM context.
- Indexes each existing stock by its unique `isin` in a Map: `previousUniverseByIsin`.
- Preserves existing arrays:
  - `historical_prices`: Retains the 6 verified session closes (`2026-10-28` through `2026-11-04`).
  - `sparkline_7d`: Retains 7-point visual trend arrays.
  - `market_cap` and `mcap_rank`: Preserves verified capitalizations (e.g. 343 verified Group A/B equities).

### 3.2. Diff & Detection Classification Rules

| Detection Type | Trigger Condition | Engine Action |
| :--- | :--- | :--- |
| **Newly Listed Company** | ISIN present in incoming masters but absent in `previousUniverseByIsin`. | Created as a new stock object; tagged with segment (`Mainboard` or `SME`); registered in change log. |
| **New Exchange Listing** | ISIN exists in previous universe as single-listed (e.g. BSE only) and now appears on both exchanges. | Updated to `is_dual_listed: true`; added `nse_symbol` or `bse_code`; registered as dual-listing expansion. |
| **Symbol Change** | Known ISIN has a different trading symbol in current master compared to previous universe. | Updated `symbol`, preserving previous symbol in audit log. |
| **Series Change** | Known ISIN has shifted series (e.g. `EQ` $\to$ `BE` / `BZ`, or SME migration). | Updated `series` and `series_desc`. |
| **Delisted / Suspended** | ISIN present in previous universe but absent from both official current masters. | Flagged in change log for archiving. |

### 3.3. Unpriced / Pre-Trading Stock Safety
When a new listing is admitted by the exchange (e.g., SME IPO debut or pre-trading security):
- If the stock has an EOD Bhavcopy trade, OHLCV and Close are ingested. If Previous Close is omitted by the exchange (as in day-1 listings), `prev_close` is set to `null` and `change_percent` is set to `null`.
- If no trade has executed yet, `current_price = null`, `prev_close = null`, `change_percent = null`, `volume = 0`, `open = null`, `high = null`, `low = null`.
- The frontend renders `—` for null metrics. **Zero fabricated zeros or artificial percentages are introduced.**

### 3.4. Dated Change Log & Market Stats Integration
Each sync writes an audit log to:
```
downloads/universe-changes-YYYY-MM-DD.json
```
**Schema:**
```json
{
  "tradingDate": "2026-11-04",
  "generatedAt": "2026-11-04T17:03:33.482Z",
  "previousUniverseCount": 4965,
  "currentUniverseCount": 4965,
  "summary": {
    "newlyListedCount": 0,
    "exchangeAdditionsCount": 0,
    "symbolChangesCount": 0,
    "seriesChangesCount": 0,
    "delistedCount": 0
  },
  "changes": {
    "newlyListed": [],
    "exchangeAdditions": [],
    "symbolChanges": [],
    "seriesChanges": [],
    "delisted": []
  }
}
```
In `MARKET_STATS`:
```javascript
changeLogSummary: {
  newlyListedCount: 0,
  exchangeAdditionsCount: 0,
  symbolChangesCount: 0,
  seriesChangesCount: 0,
  delistedCount: 0
},
changeLogFile: "downloads/universe-changes-2026-11-04.json"
```

### 3.5. Failure Safety & Rollback Protection
To prevent catastrophic universe loss due to network dropouts or partial downloads:
1. **File Size Check:** Rejects files smaller than 100 KB.
2. **Row Threshold Check:** Evaluates record counts; if either NSE or BSE master returns fewer than 1,000 eligible equity rows, the sync engine immediately throws an error and aborts execution.
3. **Atomic File Write:** `js/stocks-data.js` is only overwritten after complete validation of the unified dataset.

### 3.6. Idempotency Proof
Running the sync engine repeatedly on the same trading day produces:
- Identical stock universe length: **4,965**.
- Exactly **0 duplicate ISINs**.
- Delta summary: `newlyListedCount: 0`, `exchangeAdditionsCount: 0`, `symbolChangesCount: 0`, `seriesChangesCount: 0`, `delistedCount: 0`.

---

## 4. Test Suite Verification (`scripts/test-new-listing-discovery.js`)

A dedicated automated test suite was constructed and executed. All 33 checks passed:

| Test Group | Purpose | Result |
| :--- | :--- | :---: |
| **Group 1: New Listing Detection** | Ingestion of Mainboard (`NEWIPO`) and SME (`SMEIPO`) test candidates | **PASS (3/3)** |
| **Group 2: Dual-Listing Addition** | Addition of second exchange to existing single-listed security | **PASS (3/3)** |
| **Group 3: ISIN Deduplication** | Zero duplicate ISINs across 4,965 production stocks; disambiguation of same-ticker collisions (`GSTL`) | **PASS (4/4)** |
| **Group 4: Pre-Trading Null-Safety** | Verification of `null` prices for unpriced/IPO listings (`AJWA`, `CRL`) without fake zeros | **PASS (6/6)** |
| **Group 5: Idempotency & Stability** | Repeated sync simulation yields 0 deltas across all categories | **PASS (5/5)** |
| **Group 6: Historical Preservation** | Verified that `RELIANCE` and 4,941 stocks preserve 6-session history | **PASS (5/5)** |
| **Group 7: Truncated Master Safety** | Rejection of truncated incoming master (< 1,000 rows) with clean error | **PASS (2/2)** |
| **Group 8: Change Log Persistence** | Schema, dated file existence, and metric validation in `downloads/` | **PASS (5/5)** |
| **Total** | **All Automated Discovery Checks** | **33 / 33 PASS** |

---

## 5. Conclusion

The automatic new listing discovery system fulfills all production requirements:
- Automated detection and registration of Mainboard and SME equities.
- Strict ISIN primary key integrity.
- Historical data preservation.
- Honest handling of unpriced and IPO listings.
- Complete audit logging and idempotency.
- Robust failure rollback mechanisms.

