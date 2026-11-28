# Machii Bazzar — Market Capitalization Coverage & Synchronization Report

**Report Generated:** Saturday, 28 November 2026 at 10:39:44 pm  
**Exchange Session Date:** 2026-11-27  
**Primary Identifier:** International Securities Identification Number (ISIN)

---

## 1. Executive Summary

| Metric | Count / Value | % of Total Universe | Status |
| :--- | :--- | :--- | :--- |
| **Total Eligible Instruments** | **5,465** | 100.0% | Complete EOD Universe |
| **Total NSE Listed Equities** | **3,203** | 58.6% | Verified |
| **Total BSE Listed Equities** | **4,777** | 87.4% | Verified |
| **Dual-Listed Equities** | **2,515** | 46.0% | ISIN-Deduplicated |
| **Instruments with Verified Market Cap** | **5,413** | **99.05%** | Verified Instrument Coverage |
| **Eligible Share-Capital Equities (Excl. RE/PP/CCPS)** | **5,413 / 5,439** | **99.52%** | Company Share-Class Denominator (26 non-common excluded) |
| **Instruments with Missing Market Cap** | **52** | **0.95%** | Documented & Unpriced / Non-Common |
| **Aggregate Verified Market Cap** | **₹5,16,27,827 Cr** | — | Real EOD Capitalization |

---

## 2. Multi-Source Ingestion Breakdown

| Source Priority | Source Description | Securities Resolved | Quality / Verification Level |
| :---: | :--- | :---: | :--- |
| **Priority 1** | NSE Official Daily Market Cap Archive (`mcap*.csv`) | 3188 | Exchange-reported EOD Market Cap & Issue Size |
| **Priority 2** | Price × Verified Outstanding Shares | 1857 | Calculated from verified share counts |
| **Priority 3** | Benchmark Blue-Chip Cache (`benchmark_stocks_verified.json`) | 0 | Verified benchmark equities |
| **Priority 4** | BSE Security Master (`bse_list_securities_verified.json`) | 0 | Exchange equity master |
| **Priority 5** | India Listed Company Catalog (`api.dharun.dev/v1/companies` via ISIN) | 223 | ISIN-matched market capitalization |
| **Priority 6** | Indian Equities Dataset (`screener_market_caps.json`) | 145 | Symbol/scrip-matched capitalization |
| **Priority 7** | India Listed Company Catalog (Ticker match fallback) | 0 | Ticker lookup fallback |
| **Priority 8** | Stale-While-Revalidate Session Cache | 0 | Zero-regression carryover |
| **Total Verified** | **All Institutional Sources** | **5,413** | **99.05% Coverage** |

---

## 3. Verified Ranking Segments Distribution

| Segment Key | Ranking Tier Label | Equities Count | Description |
| :--- | :--- | :---: | :--- |
| `top100` | **Top 100 Verified** | 100 | Top 100 market-cap mainboard equities |
| `rank101_250` | **Rank 101–250 Verified** | 150 | Next 150 large/mid mainboard equities |
| `remainingVerified` | **Remaining Verified** | 4,104 | Remaining verified mainboard equities |
| `smePlatform` | **SME Platform** | 1,073 | NSE Emerge & BSE SME equities |
| `unranked` | **Unranked / Unverified** | 38 | Unpriced, partly paid, or dormant equities |
| **Mathematical Sum** | **Complete Stock Universe** | **5,465** | **Equals 5,465** |

---

## 4. Companies with Missing Market Cap & Financial Reasons

A total of **52** securities out of 5,465 (0.95%) remain `null`:

| Symbol | Company Name | ISIN | Exchange | Segment | Reason |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **AARCON** | Aarcon Facilities Limited | `INE056J01015` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ABHIINFRA** | Abhishek Infraventures Limited | `INE281P01016` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ACESEPP** | Ace Software Exports Limited | `IN9849B01034` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **AIRLTD** | Avishkar Infrastructure Realty Limited | `INE433O01024` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ANIRITPP** | Anirit Ventures Limited | `IN9161F01019` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **ANTALA** | Antala Industries Limited | `INE15Z101013` | BSE | SME | SME equity without verified reference capitalization |
| **APLABPP** | Aplab Limited | `IN9273A01047` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **ARTEMISADR** | Artemis Adr Marketplace Limite | `INE0D9X01018` | BSE | SME | SME equity without verified reference capitalization |
| **ATLPP** | Allcargo Terminals Limited | `IN90NN701011` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **AVENIQUE** | Avenique Limited | `INE089E01033` | BSE | Mainboard | Actively traded Mainboard equity not yet covered in verified market-cap sources |
| **CENTEXTPP** | Century Extrusions Limited | `IN9281A01016` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **CRESCE-RE1** | Crescentis Capital Limited | `INE754C20028` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **EVONILE-RE** | Evonile Pharma Limited | `INE234A20017` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **FABINO** | Fabino Enterprises Limited | `INE0DRT01018` | BSE | SME | SME equity without verified reference capitalization |
| **FRATELLIPP** | Fratelli Vineyards Limited | `IN9401Z01017` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **FRESITA-RE** | Fresita Proteins Limited | `INE995U20011` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **GSAILPP** | G.S. Auto International Limited | `IN9736H01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **IEML-RE1** | Indian Emulsifiers Limited | `INE0RRU20024` | NSE | SME | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **INDRAYANIPP** | Indrayani Biotech Limited | `IN9007C01029` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **INTFIN-RE1** | Interactive Financial Services | `INE064T20026` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **IRONWO-RE** | Ironwood Education Limited | `INE791H20011` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **JAYKAYPP** | Jaykay Enterprises Limited | `IN9903A01015` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **JINDCAP-RE** | Jindal Capital Limited | `INE356F20017` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **JOHNSONCAB** | Johnsoncab Electricals Limited | `INE1ZSR01011` | BSE | SME | SME equity without verified reference capitalization |
| **KANE-RE** | Kanel Industries Limited | `INE252C20015` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **KDML** | Khemani Distributors & Marketi | `INE030U01025` | BSE | SME | SME equity without verified reference capitalization |
| **KGES** | Kuberan Global Edu Solutions L | `INE04CO01018` | BSE | Mainboard | Actively traded Mainboard equity not yet covered in verified market-cap sources |
| **KMSMEDI** | Kms Medisurgi Limited | `INE870V01014` | BSE | SME | SME equity without verified reference capitalization |
| **MAGNUS-RE1** | Magnus Steel And Infrastructure Limited | `INE898E20029` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **MIHIKA-RE** | Mihika Industries Limited | `INE779Q20017` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **MOUNT** | Mount Housing And Infrastructu | `INE444X01014` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **MPFSL** | Mpf Systems Limited | `INE095E01022` | BSE | Mainboard | Actively traded Mainboard equity not yet covered in verified market-cap sources |
| **NAVIGANT** | Navigant Corporate Advisors Li | `INE364T01012` | BSE | SME | SME equity without verified reference capitalization |
| **OLAPP** | Ola Electric Mobility Limited | `IN90LXG01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **POLYMAC** | Polymac Thermoformers Limited | `INE826P01018` | BSE | SME | SME equity without verified reference capitalization |
| **PRAXIS-RE3** | Praxis Home Retail Limited | `INE546Y20048` | NSE, BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **QDLCCPS** | Quint Digital Limited | `IN9641R03011` | BSE | Mainboard | Preference / CCPS shares; excluded from ordinary equity market capitalization |
| **RAFL** | Raghuvansh Agrofarms Limited | `INE865P01016` | BSE | SME | SME equity without verified reference capitalization |
| **RAJPUTANA** | Rajputana Investment And Finan | `INE751R01014` | BSE | Mainboard | Actively traded Mainboard equity not yet covered in verified market-cap sources |
| **RANJEET** | Ranjeet Mechatronics Limited | `INE01A501027` | BSE | SME | SME equity without verified reference capitalization |
| **RITHWIKFMS** | Rithwik Facility Management Se | `INE819Y01015` | BSE | SME | SME equity without verified reference capitalization |
| **SAENTER** | South Asian Enterprises Limited | `INE118B01010` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **SEL** | Sanathnagar Enterprises Limite | `INE367E01033` | BSE | Mainboard | Actively traded Mainboard equity not yet covered in verified market-cap sources |
| **SILVERPRL** | Silver Pearl Hospitality & Lux | `INE0KXN01014` | BSE | SME | SME equity without verified reference capitalization |
| **SML** | Soni Medicare Limited | `INE848R01018` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **SURAJINDPP** | Suraj Industries Limited. | `IN9170U01035` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **VECTRAS** | Vectras Enprocon Limited | `INE1FD201014` | BSE | SME | SME equity without verified reference capitalization |
| **VEERG-RE** | Veer Global Infraconstruction | `INE244W20036` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
| **VERTEXPP** | Vertex Securities Limited | `IN9316D01014` | BSE | Mainboard | Partly-Paid shares (PP series); equity capital represented in ordinary shares |
| **WARDHEALTH** | Wardwizard Healthcare Limited | `INE048E01013` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ZGAEKWAR** | Gaekwar Mills Limited | `INE837X01027` | BSE | Mainboard | Unpriced / Inactive listed equity with zero trading volume |
| **ZODJRD-RE1** | Zodiac-Jrd-Mkj Limited | `INE077B20026` | BSE | Mainboard | Rights Entitlement (RE series); temporary trading rights, not equity shares |
