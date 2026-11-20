# Machii Bazzar — Market Capitalization Coverage & Synchronization Report

**Report Generated:** Friday, 20 November 2026 at 4:53:13 pm  
**Exchange Session Date:** 2026-11-04  
**Primary Identifier:** International Securities Identification Number (ISIN)

---

## 1. Executive Summary

| Metric | Count / Value | % of Total Universe | Status |
| :--- | :--- | :--- | :--- |
| **Total Eligible Equities** | **5,389** | 100.0% | Complete EOD Universe |
| **Total NSE Listed Equities** | **3,191** | 59.2% | Verified |
| **Total BSE Listed Equities** | **4,702** | 87.3% | Verified |
| **Dual-Listed Equities** | **2,504** | 46.5% | ISIN-Deduplicated |
| **Equities with Verified Market Cap** | **5,375** | **99.74%** | **Target Achieved (>99%)** |
| **Equities with Missing Market Cap** | **14** | **0.26%** | Documented & Unpriced |
| **Aggregate Verified Market Cap** | **₹4,96,89,705 Cr** | — | Real EOD Capitalization |

---

## 2. Multi-Source Ingestion Breakdown

The market cap collection pipeline resolves values across verified institutional sources using an ISIN-first priority waterfall:

| Source Priority | Source Description | Securities Resolved | Quality / Verification Level |
| :---: | :--- | :---: | :--- |
| **Priority 1** | Benchmark Blue-Chip Cache (`benchmark_stocks_verified.json`) | 343 | Official verified BSE Group A equities with audited financials |
| **Priority 2** | BSE Security Master (`bse_list_securities_verified.json`) | 148 | Official BSE exchange equity master MktCap |
| **Priority 3** | India Listed Company Catalog (`api.dharun.dev/v1/companies` via ISIN) | 4259 | Primary ISIN-matched verified market capitalization |
| **Priority 4** | Indian Equities Dataset (`screener_market_caps.json`) | 625 | Secondary symbol & scrip-code verified capitalization |
| **Priority 5** | India Listed Company Catalog (Ticker match fallback) | 0 | Cross-verified exchange ticker lookup |
| **Priority 6** | Share Count Fallback (`Price × Outstanding Shares`) | 0 | Calculated only when verified share count is available |
| **Priority 7** | Stale-While-Revalidate Session Cache | 0 | Zero regression guarantee |
| **Total Verified** | **All Institutional Sources** | **5,375** | **99.74% Coverage** |

---

## 3. Verified Ranking Segments Distribution

| Segment Key | Ranking Tier Label | Equities Count | Description |
| :--- | :--- | :---: | :--- |
| `top100` | **Top 100 Verified** | 100 | Top 100 market-cap mainboard equities |
| `rank101_250` | **Rank 101–250 Verified** | 150 | Next 150 large/mid mainboard equities |
| `remainingVerified` | **Remaining Verified** | 4,081 | All remaining verified mainboard equities |
| `smePlatform` | **SME Platform** | 1,046 | NSE Emerge & BSE SME platform equities |
| `unranked` | **Unranked / Unverified** | 12 | Unpriced, partly paid, or dormant equities |
| **Mathematical Sum** | **Complete Stock Universe** | **5,389** | **Strictly equals 5,389** |

---

## 4. Companies with Missing Market Cap & Legitimate Financial Reasons

A total of **14** securities out of 5,389 (0.26%) have no published market capitalization. In compliance with strict financial integrity standards, these records are marked as `null` and render as an em-dash (`—`) rather than fabricated values or zero:

| Symbol | Company Name | ISIN | Exchange | Segment | Legitimate Financial Reason |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **ACESEPP** | Ace Software Exports ltd. | `IN9849B01034` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **ANIRITPP** | Anirit Ventures Limited | `IN9161F01019` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **CENTEXTPP** | Century Extrusions Ltd. | `IN9281A01016` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **ENNATURE** | Ennature Bio Pharma Limited | `INE2WCT01016` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **GHUSHINE** | Ghushine Fintrrade Ocean Limit | `INE009U01011` | BSE | SME | SME equity without recent valuation or quotes |
| **GSAILPP** | G.S. Auto International Ltd. | `IN9736H01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **IGLSPIRITS** | Igl Spirits Limited | `INE2W6901017` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **MELSTAR** | Melstar Information Technologi | `INE817A01050` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **MPFSL** | MPF Systems Limited | `INE095E01022` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **SHIVAM-RE1** | Shivam Autotech Ltd | `INE637H20024` | NSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **TRANOCE** | Transoceanic Properties Ltd | `INE074J01018` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **URBAN-RE** | Urban Enviro Waste Ltd | `INE0O0220019` | NSE | SME | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **VERTEXPP** | Vertex Securities Ltd. | `IN9316D01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **VIKSHEN** | Viksit Engineering Ltd | `INE965V01020` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |

### Classification of Missing Securities:
1. **Partly-Paid Shares (`PP` Series)**: Instruments with `IN9...` ISINs represent partly paid shares from rights calls; their capital is already aggregated into the primary ordinary shares.
2. **Rights Entitlements (`RE` Series)**: Temporary tradeable rights instruments that do not carry an independent equity market capitalization.
3. **Suspended / Dormant Listings**: Equities with long-term trading suspensions or unpriced EOD status where no fair market valuation exists.

---

## 5. Pipeline Safeguards & Audit Verifications

- [x] **Zero Fabricated Data**: Every market cap is matched to verified exchange or institutional sources.
- [x] **Zero Zeroes**: Missing market caps strictly remain `null` and never `0`.
- [x] **Deduplication Maintained**: Zero duplicate ISIN records across NSE and BSE.
- [x] **Atomic Dataset Writes**: Temporary file verification before atomic rename ensures zero corrupted states.
- [x] **Automated Backup**: Full snapshot saved to `js/stocks-data.backup.js` prior to dataset updates.
