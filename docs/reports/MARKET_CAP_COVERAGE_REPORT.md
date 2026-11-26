# Machii Bazzar — Market Capitalization Coverage & Synchronization Report

**Report Generated:** Thursday, 26 November 2026 at 9:39:08 pm  
**Exchange Session Date:** 2026-11-26  
**Primary Identifier:** International Securities Identification Number (ISIN)

---

## 1. Executive Summary

| Metric | Count / Value | % of Total Universe | Status |
| :--- | :--- | :--- | :--- |
| **Total Eligible Equities** | **5,453** | 100.0% | Complete EOD Universe |
| **Total NSE Listed Equities** | **3,200** | 58.7% | Verified |
| **Total BSE Listed Equities** | **4,766** | 87.4% | Verified |
| **Dual-Listed Equities** | **2,513** | 46.1% | ISIN-Deduplicated |
| **Equities with Verified Market Cap** | **5,400** | **99.03%** | Verified Coverage |
| **Equities with Missing Market Cap** | **53** | **0.97%** | Documented & Unpriced |
| **Aggregate Verified Market Cap** | **₹5,00,67,060 Cr** | — | Real EOD Capitalization |

---

## 2. Multi-Source Ingestion Breakdown

| Source Priority | Source Description | Securities Resolved | Quality / Verification Level |
| :---: | :--- | :---: | :--- |
| **Priority 1** | Benchmark Blue-Chip Cache (`benchmark_stocks_verified.json`) | 343 | Verified benchmark equities |
| **Priority 2** | BSE Security Master (`bse_list_securities_verified.json`) | 148 | Exchange equity master |
| **Priority 3** | India Listed Company Catalog (`api.dharun.dev/v1/companies` via ISIN) | 4292 | ISIN-matched market capitalization |
| **Priority 4** | Indian Equities Dataset (`screener_market_caps.json`) | 617 | Symbol/scrip-matched capitalization |
| **Priority 5** | India Listed Company Catalog (Ticker match fallback) | 0 | Ticker lookup fallback |
| **Priority 6** | Share Count Fallback (`Price × Outstanding Shares`) | 0 | Calculated from verified shares |
| **Priority 7** | Stale-While-Revalidate Session Cache | 0 | Zero-regression carryover |
| **Total Verified** | **All Institutional Sources** | **5,400** | **99.03% Coverage** |

---

## 3. Verified Ranking Segments Distribution

| Segment Key | Ranking Tier Label | Equities Count | Description |
| :--- | :--- | :---: | :--- |
| `top100` | **Top 100 Verified** | 100 | Top 100 market-cap mainboard equities |
| `rank101_250` | **Rank 101–250 Verified** | 150 | Next 150 large/mid mainboard equities |
| `remainingVerified` | **Remaining Verified** | 4,098 | Remaining verified mainboard equities |
| `smePlatform` | **SME Platform** | 1,071 | NSE Emerge & BSE SME equities |
| `unranked` | **Unranked / Unverified** | 34 | Unpriced, partly paid, or dormant equities |
| **Mathematical Sum** | **Complete Stock Universe** | **5,453** | **Equals 5,453** |

---

## 4. Companies with Missing Market Cap & Financial Reasons

A total of **53** securities out of 5,453 (0.97%) remain `null`:

| Symbol | Company Name | ISIN | Exchange | Segment | Reason |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **AARCON** | Aarcon Facilities Limited | `INE056J01015` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ABHIINFRA** | Abhishek Infraventures Limited | `INE281P01016` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ACESEPP** | Ace Software Exports Limited | `IN9849B01034` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **AIRLTD** | Avishkar Infrastructure Realty Limited | `INE433O01024` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ANIRITPP** | Anirit Ventures Limited | `IN9161F01019` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **ANTALA** | Antala Industries Limited | `INE15Z101013` | BSE | SME | SME equity without recent valuation or quotes |
| **ARTEMISADR** | Artemis Adr Marketplace Limite | `INE0D9X01018` | BSE | SME | SME equity without recent valuation or quotes |
| **AVENIQUE** | Avenique Limited | `INE089E01033` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **BCSSL** | Bombay Coated And Special Stee | `INE0XFY01011` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **CENTEXTPP** | Century Extrusions Limited | `IN9281A01016` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **CRESCE-RE1** | Crescentis Capital Limited | `INE754C20028` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **CRYSTALCP** | Crystal Crop Protection Limite | `INE101P01016` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **DKEGL** | D K Enterprises Global L | `INE0GN101014` | NSE | SME | SME equity without recent valuation or quotes |
| **ENNATURE** | Ennature Bio Pharma Limited | `INE2WCT01016` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **EVONILE-RE** | Evonile Pharma Limited | `INE234A20017` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **FABINO** | Fabino Enterprises Limited | `INE0DRT01018` | BSE | SME | SME equity without recent valuation or quotes |
| **FRESITA-RE** | Fresita Proteins Limited | `INE995U20011` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **GRETEX** | Gretex Industries Limited | `INE985P01012` | NSE | SME | SME equity without recent valuation or quotes |
| **GSAILPP** | G.S. Auto International Limited | `IN9736H01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **HGSINDIALT** | Hgs (India) Limited | `INE813R01012` | NSE | SME | SME equity without recent valuation or quotes |
| **IEML-RE1** | Indian Emulsifiers Limited | `INE0RRU20024` | NSE | SME | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **IGLSPIRITS** | Igl Spirits Limited | `INE2W6901017` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **INTFIN-RE1** | Interactive Financial Services | `INE064T20026` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **IRONWO-RE** | Ironwood Education Limited | `INE791H20011` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **JETKNIT** | Jet Knitwears Limited | `INE564T01017` | NSE | SME | SME equity without recent valuation or quotes |
| **JINDCAP-RE** | Jindal Capital Limited | `INE356F20017` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **JKSHAH** | J.K. Shah Commerce Education L | `INE2OD001016` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **JOHNSONCAB** | Johnsoncab Electricals Limited | `INE1ZSR01011` | BSE | SME | SME equity without recent valuation or quotes |
| **KANE-RE** | Kanel Industries Limited | `INE252C20015` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **KDML** | Khemani Distributors & Marketi | `INE030U01025` | BSE | SME | SME equity without recent valuation or quotes |
| **KGES** | Kuberan Global Edu Solutions L | `INE04CO01018` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **KMSMEDI** | Kms Medisurgi Limited | `INE870V01014` | BSE | SME | SME equity without recent valuation or quotes |
| **MAGNUS-RE1** | Magnus Steel And Infrastructure Limited | `INE898E20029` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **MAXENGS** | Maxwell Engineering Sol L | `INE1W3F01014` | NSE | SME | SME equity without recent valuation or quotes |
| **MELSTAR** | Melstar Information Technologi | `INE817A01050` | NSE, BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **MIHIKA-RE** | Mihika Industries Limited | `INE779Q20017` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **MOUNT** | Mount Housing And Infrastructu | `INE444X01014` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **MPFSL** | Mpf Systems Limited | `INE095E01022` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **NAVIGANT** | Navigant Corporate Advisors Li | `INE364T01012` | BSE | SME | SME equity without recent valuation or quotes |
| **OLAPP** | Ola Electric Mobility Limited | `IN90LXG01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **POLYMAC** | Polymac Thermoformers Limited | `INE826P01018` | BSE | SME | SME equity without recent valuation or quotes |
| **RANJEET** | Ranjeet Mechatronics Limited | `INE01A501027` | BSE | SME | SME equity without recent valuation or quotes |
| **RITHWIKFMS** | Rithwik Facility Management Se | `INE819Y01015` | BSE | SME | SME equity without recent valuation or quotes |
| **SAENTER** | South Asian Enterprises Limited | `INE118B01010` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **SILVERPRL** | Silver Pearl Hospitality & Lux | `INE0KXN01014` | BSE | SME | SME equity without recent valuation or quotes |
| **SML** | Soni Medicare Limited | `INE848R01018` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **VECTRAS** | Vectras Enprocon Limited | `INE1FD201014` | BSE | SME | SME equity without recent valuation or quotes |
| **VEERG-RE** | Veer Global Infraconstruction | `INE244W20036` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **VERTEXPP** | Vertex Securities Limited | `IN9316D01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **VPFL** | Vedant Poly Fabs Limited | `INE2RWX01016` | NSE | SME | SME equity without recent valuation or quotes |
| **WARDHEALTH** | Wardwizard Healthcare Limited | `INE048E01013` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ZGAEKWAR** | Gaekwar Mills Limited | `INE837X01027` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ZODJRD-RE1** | Zodiac-Jrd-Mkj Limited | `INE077B20026` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
