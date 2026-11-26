# Machii Bazzar — Market Capitalization Coverage & Synchronization Report

**Report Generated:** Wednesday, 25 November 2026 at 8:38:23 pm  
**Exchange Session Date:** 2026-11-25  
**Primary Identifier:** International Securities Identification Number (ISIN)

---

## 1. Executive Summary

| Metric | Count / Value | % of Total Universe | Status |
| :--- | :--- | :--- | :--- |
| **Total Eligible Equities** | **5,405** | 100.0% | Complete EOD Universe |
| **Total NSE Listed Equities** | **3,195** | 59.1% | Verified |
| **Total BSE Listed Equities** | **4,722** | 87.4% | Verified |
| **Dual-Listed Equities** | **2,512** | 46.5% | ISIN-Deduplicated |
| **Equities with Verified Market Cap** | **5,369** | **99.33%** | **Target Achieved (>99%)** |
| **Equities with Missing Market Cap** | **36** | **0.67%** | Documented & Unpriced |
| **Aggregate Verified Market Cap** | **₹4,96,72,038 Cr** | — | Real EOD Capitalization |

---

## 2. Multi-Source Ingestion Breakdown

The market cap collection pipeline resolves values across verified institutional sources using an ISIN-first priority waterfall:

| Source Priority | Source Description | Securities Resolved | Quality / Verification Level |
| :---: | :--- | :---: | :--- |
| **Priority 1** | Benchmark Blue-Chip Cache (`benchmark_stocks_verified.json`) | 343 | Official verified BSE Group A equities with audited financials |
| **Priority 2** | BSE Security Master (`bse_list_securities_verified.json`) | 148 | Official BSE exchange equity master MktCap |
| **Priority 3** | India Listed Company Catalog (`api.dharun.dev/v1/companies` via ISIN) | 4267 | Primary ISIN-matched verified market capitalization |
| **Priority 4** | Indian Equities Dataset (`screener_market_caps.json`) | 611 | Secondary symbol & scrip-code verified capitalization |
| **Priority 5** | India Listed Company Catalog (Ticker match fallback) | 0 | Cross-verified exchange ticker lookup |
| **Priority 6** | Share Count Fallback (`Price × Outstanding Shares`) | 0 | Calculated only when verified share count is available |
| **Priority 7** | Stale-While-Revalidate Session Cache | 0 | Zero regression guarantee |
| **Total Verified** | **All Institutional Sources** | **5,369** | **99.33% Coverage** |

---

## 3. Verified Ranking Segments Distribution

| Segment Key | Ranking Tier Label | Equities Count | Description |
| :--- | :--- | :---: | :--- |
| `top100` | **Top 100 Verified** | 100 | Top 100 market-cap mainboard equities |
| `rank101_250` | **Rank 101–250 Verified** | 150 | Next 150 large/mid mainboard equities |
| `remainingVerified` | **Remaining Verified** | 4,076 | All remaining verified mainboard equities |
| `smePlatform` | **SME Platform** | 1,060 | NSE Emerge & BSE SME platform equities |
| `unranked` | **Unranked / Unverified** | 19 | Unpriced, partly paid, or dormant equities |
| **Mathematical Sum** | **Complete Stock Universe** | **5,405** | **Strictly equals 5,405** |

---

## 4. Companies with Missing Market Cap & Legitimate Financial Reasons

A total of **36** securities out of 5,405 (0.67%) have no published market capitalization. In compliance with strict financial integrity standards, these records are marked as `null` and render as an em-dash (`—`) rather than fabricated values or zero:

| Symbol | Company Name | ISIN | Exchange | Segment | Legitimate Financial Reason |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **AARCON** | Aarcon Facilities Limited | `INE056J01015` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ABHIINFRA** | Abhishek Infraventures Limited | `INE281P01016` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ACESEPP** | Ace Software Exports ltd. | `IN9849B01034` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **AIRLTD** | Avishkar Infra Realty Limited | `INE433O01024` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ANIRITPP** | Anirit Ventures Limited | `IN9161F01019` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **ANTALA** | Antala Industries Limited | `INE15Z101013` | BSE | SME | SME equity without recent valuation or quotes |
| **ARTEMISADR** | Artemis ADR Marketplace Limite | `INE0D9X01018` | BSE | SME | SME equity without recent valuation or quotes |
| **AVENIQUE** | Avenique Limited | `INE089E01033` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **BCSSL** | Bombay Coated And Special Stee | `INE0XFY01011` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **CENTEXTPP** | Century Extrusions Ltd. | `IN9281A01016` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **DKEGL** | D K Enterprises Global L | `INE0GN101014` | NSE | SME | SME equity without recent valuation or quotes |
| **ENNATURE** | Ennature Bio Pharma Limited | `INE2WCT01016` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **GRETEX** | Gretex Industries Ltd | `INE985P01012` | NSE | SME | SME equity without recent valuation or quotes |
| **GSAILPP** | G.S. Auto International Ltd. | `IN9736H01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **HGSINDIALT** | Hgs (india) Limited | `INE813R01012` | NSE | SME | SME equity without recent valuation or quotes |
| **IEML-RE1** | Indian Emulsifiers Ltd | `INE0RRU20024` | NSE | SME | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **IGLSPIRITS** | Igl Spirits Limited | `INE2W6901017` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **JETKNIT** | Jet Knitwears Ltd | `INE564T01017` | NSE | SME | SME equity without recent valuation or quotes |
| **JKSHAH** | J.K. Shah Commerce Education L | `INE2OD001016` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **JOHNSONCAB** | Johnsoncab Electricals Limited | `INE1ZSR01011` | BSE | SME | SME equity without recent valuation or quotes |
| **KMSMEDI** | KMS Medisurgi Limited | `INE870V01014` | BSE | SME | SME equity without recent valuation or quotes |
| **MAXENGS** | Maxwell Engineering Sol L | `INE1W3F01014` | NSE | SME | SME equity without recent valuation or quotes |
| **MELSTAR** | Melstar Information Technologi | `INE817A01050` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **MPFSL** | MPF Systems Limited | `INE095E01022` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **NAVIGANT** | Navigant Corporate Advisors Li | `INE364T01012` | BSE | SME | SME equity without recent valuation or quotes |
| **OLAPP** | Ola Electric Mobility Limited | `IN90LXG01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **POLYMAC** | Polymac Thermoformers Ltd | `INE826P01018` | BSE | SME | SME equity without recent valuation or quotes |
| **RANJEET** | Ranjeet Mechatronics Limited | `INE01A501027` | BSE | SME | SME equity without recent valuation or quotes |
| **RITHWIKFMS** | Rithwik Facility Management Se | `INE819Y01015` | BSE | SME | SME equity without recent valuation or quotes |
| **SAENTER** | South Asian Enterprises Ltd | `INE118B01010` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **SILVERPRL** | Silver Pearl Hospitality & Lux | `INE0KXN01014` | BSE | SME | SME equity without recent valuation or quotes |
| **SML** | Soni Medicare Limited | `INE848R01018` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **VECTRAS** | Vectras Enprocon Limited | `INE1FD201014` | BSE | SME | SME equity without recent valuation or quotes |
| **VERTEXPP** | Vertex Securities Ltd. | `IN9316D01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **VPFL** | Vedant Poly Fabs Limited | `INE2RWX01016` | NSE | SME | SME equity without recent valuation or quotes |
| **WARDHEALTH** | Wardwizard Healthcare Limited | `INE048E01013` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |

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
