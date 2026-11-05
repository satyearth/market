# Machli Bazzar — Company Logo Coverage Audit

**Date:** 2026-11-04  
**Provider:** India Company Logo API ([api.dharun.dev](https://api.dharun.dev/docs/logos))  
**Catalog Size:** 5575 listed companies  
**Stock Universe Checked:** 5389 active Indian equities  

---

## 1. Executive Summary

| Metric | Count | Percentage of Universe |
| :--- | :---: | :---: |
| **Total Unique Stocks Checked** | **5389** | **100.00%** |
| **NSE Listed Equities Checked** | 3191 | 59.21% |
| **BSE Listed Equities Checked** | 4702 | 87.25% |
| **BSE-Only Equities Checked** | 2198 | 40.79% |
| **NSE-Only Equities Checked** | 687 | 12.75% |
| **Dual-Listed Equities Checked** | 2504 | 46.47% |
| **Real Published Company Logos Available** | **5088** | **94.41%** |
| **API Monogram Fallback Only (`hasLogo: false`)** | 239 | 4.43% |
| **Missing from API Catalog (404)** | 62 | 1.15% |
| **Total In-Catalog Coverage (Real + Monogram)** | **5327** | **98.85%** |

---

## 2. API Catalog & Resolution Methodology

1. **Primary Identifier — ISIN**:
   Every stock in Machli Bazzar contains an official 12-character ISIN (`INE...` / `IN9...`).
   The India API indexes companies natively by ISIN. ISIN lookup prevents any ticker collision between renamed or delisted companies.
2. **Secondary Identifier — Official NSE Symbol**:
   For dual-listed and NSE-only equities, the official NSE trading symbol is resolved.
3. **Tertiary Identifier — BSE Scrip / Symbol**:
   For BSE-only companies, the official BSE trading symbol is resolved (e.g. `PUNJCOMMU`).
4. **Verified Alias Map (`LOGO_ALIASES`)**:
   32 verified mappings bridge ISINs, legacy tickers, reformatted symbols, and partly-paid shares directly to the API's published vector logo.
5. **Initials Fallback Badge**:
   For the 301 securities without an official published logo, Machli Bazzar's inline `onerror` fallback automatically hides the missing image and displays the company's 2-letter uppercase initials tile without layout shifts or console errors.

---

## 3. Sample of Verified Real Logos (5088 total)

| Rank / Symbol | Company Name | ISIN | API Ticker | Status | Format |
| :--- | :--- | :--- | :--- | :---: | :---: |
| `RELIANCE` | Reliance Industries Ltd | `INE002A01018` | `RELIANCE` | `200 OK` | SVG |
| `BHARTIARTL` | Bharti Airtel Limited | `INE397D01024` | `BHARTIARTL` | `200 OK` | SVG |
| `HDFCBANK` | Hdfc Bank Ltd | `INE040A01034` | `HDFCBANK` | `200 OK` | SVG |
| `ICICIBANK` | Icici Bank Ltd | `INE090A01021` | `ICICIBANK` | `200 OK` | SVG |
| `SBIN` | State Bank Of India | `INE062A01020` | `SBIN` | `200 OK` | SVG |
| `TCS` | Tata Consultancy Services Ltd | `INE467B01029` | `TCS` | `200 OK` | SVG |
| `BAJFINANCE` | Bajaj Finance Limited | `INE296A01032` | `BAJFINANCE` | `200 OK` | SVG |
| `LT` | Larsen & Toubro Ltd | `INE018A01030` | `LT` | `200 OK` | SVG |
| `LICI` | Life Insurance Corporation Of | `INE0J1Y01017` | `LICI` | `200 OK` | SVG |
| `HINDUNILVR` | Hindustan Unilever Ltd | `INE030A01027` | `HINDUNILVR` | `200 OK` | SVG |
| `INFY` | Infosys Limited | `INE009A01021` | `INFY` | `200 OK` | SVG |
| `KOTAKBANK` | Kotak Mahindra Bank Ltd | `INE237A01036` | `KOTAKBANK` | `200 OK` | SVG |
| `ADANIPORTS` | Adani Ports And Special Econom | `INE742F01042` | `ADANIPORTS` | `200 OK` | SVG |
| `SUNPHARMA` | Sun Pharmaceutical Industries | `INE044A01036` | `SUNPHARMA` | `200 OK` | SVG |
| `TITAN` | Titan Company Limited | `INE280A01028` | `TITAN` | `200 OK` | SVG |
| `ADANIPOWER` | Adani Power Ltd | `INE814H01029` | `ADANIPOWER` | `200 OK` | SVG |
| `AXISBANK` | Axis Bank Limited | `INE238A01034` | `AXISBANK` | `200 OK` | SVG |
| `HCLTECH` | Hcl Technologies Ltd | `INE860A01027` | `HCLTECH` | `200 OK` | SVG |
| `MARUTI` | Maruti Suzuki India Ltd | `INE585B01010` | `MARUTI` | `200 OK` | SVG |
| `M&M` | Mahindra & Mahindra Ltd | `INE101A01026` | `M&M` | `200 OK` | SVG |
| `ADANIENT` | Adani Enterprises Limited | `INE423A01024` | `ADANIENT` | `200 OK` | SVG |
| `ITC` | Itc Ltd | `INE154A01025` | `ITC` | `200 OK` | SVG |
| `ULTRACEMCO` | Ultratech Cement Limited | `INE481G01011` | `ULTRACEMCO` | `200 OK` | SVG |
| `HAL` | Hindustan Aeronautics Limited | `INE066F01020` | `HAL` | `200 OK` | SVG |
| `ETERNAL` | Eternal Limited | `INE758T01015` | `ETERNAL` | `200 OK` | SVG |
| ... | *and 5063 more companies* | ... | ... | ... | ... |

---

## 4. Stocks with API Monogram Fallback Only (`hasLogo: false`)

These 239 companies are indexed in the India API catalogue but do not currently possess an approved vector trademark. The API provides a generic monogram SVG with header `X-Logo-Fallback: monogram`. Machli Bazzar renders its native ink-styled 2-letter badge for consistent typography.

| Symbol | Company Name | ISIN | Exchange | Reason |
| :--- | :--- | :--- | :---: | :--- |
| `NSE` | National Stock Exchange of Ind | `INE721I01024` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `VAML` | Vedanta Aluminium Metal Limite | `INE1CDF01017` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `SBIFUNDS` | SBI Funds Management Limited | `INE640G01020` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `MANIPALHOS` | Manipal Health Enterprises Lim | `INE459N01021` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `INDOMIM` | Indo-Mim Limited | `INE084101034` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `DHOOTTRANS` | Dhoot Transmission Limited | `INE01NH01023` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `MILKYMIST` | Milky Mist Dairy Food Limited | `INE00IT01020` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `AASTHA` | Aastha Spintex Limited | `INE2FMX01012` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `ABH` | Abh Healthcare Limited | `INE1R2M01019` | NSE | Marked `hasLogo: false` in upstream catalogue |
| `ACEVECTOR` | Acevector Limited | `INE580P01029` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `ACMERAIL` | Acme India Industries Limited | `INE162701010` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `ACMEUNIV` | Acme Universal Safezone 9 Limi | `INE1KUL01020` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `ADON` | Adon Agro Commodities Limited | `INE1SME01017` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `ADROITIND` | Adroit Industries (India) Limi | `INE505M01015` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| `ADTYFRG` | Aditya Forge Ltd | `INE281H01013` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `ADVANCETL` | Advance Technoforge Limited | `INE13ZJ01010` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `ADVMULT` | Advance Multitech Ltd | `INE875S01019` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `AEGEUS` | Aegeus Technologies Limited | `INE0WR901013` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `AFLTD` | Autofurnish Limited | `INE18HI01019` | BSE | Marked `hasLogo: false` in upstream catalogue |
| `AGL` | Allcargo Global Limited | `INE1YPB01014` | NSE/BSE | Marked `hasLogo: false` in upstream catalogue |
| ... | *and 219 more companies* | ... | ... | ... |

---

## 5. Stocks Missing from API Catalog Entirely (404)

These 62 securities (predominantly SME listings, debt instruments, or microcap BSE scrips) do not exist in the upstream India API database. They cleanly display the 2-letter initials tile:

| Symbol | Company Name | ISIN | Exchange | Segment |
| :--- | :--- | :--- | :---: | :---: |
| `JPL` | Jio Platforms Limited | `INE0BJO01010` | NSE | Mainboard |
| `ZETWERK` | Zetwerk Manufacturing Business | `INE09PO01019` | NSE | Mainboard |
| `AARSHYAM` | Aar Shyam India Investment Com | `INE512R01010` | BSE | Mainboard |
| `ACCORD` | Accord Synergy Limited | `INE113X01015` | NSE | SME |
| `AJWA` | Ajwa Projects Limited | `INE1NMO01017` | BSE | SME |
| `ANGEL` | Angel Fibers Limited | `INE339Z01011` | BSE | SME |
| `ATMAIND` | Atma Industries Limited | `INE805R01018` | BSE | Mainboard |
| `AVIVA` | Aviva Industries Ltd | `INE461H01011` | BSE | Mainboard |
| `BLSPOLY` | Bls Polymers Limited | `INE0ZCQ01019` | NSE | Mainboard |
| `BMAL` | Bothra Metals & Alloys Ltd | `INE583M01012` | BSE | SME |
| `BONFIG` | Bonfiglioli Transmissions Limi | `INE28SO01013` | NSE | Mainboard |
| `CALLISTA` | Callista Industries Limited | `INE714Q01014` | BSE | Mainboard |
| `CHAMUNDA` | Chamunda Electrical Ltd | `INE11HG01018` | NSE | SME |
| `CORE4` | Core4 Engineers Limited | `INE1RY601016` | BSE | SME |
| `CRL` | Carver Roboweld Limited | `INE1FY301017` | BSE | SME |
| `DESHRAK` | Desh Rakshak Aushdhalaya Ltd | `INE971E01016` | BSE | Mainboard |
| `DHARNI` | Dharni Capital Services Limite | `INE0M9Q01011` | BSE | SME |
| `DIKSAT` | Diksat Transworld Limited | `INE942P01013` | BSE | SME |
| `EDELALTS` | EAAA India Alternatives Limite | `INE528L01027` | NSE | Mainboard |
| `ENNATURE` | Ennature Bio Pharma Limited | `INE2WCT01016` | NSE | Mainboard |
| `FOCE` | Foce India Limited | `INE0I7D01019` | NSE | SME |
| `FUSIONCX` | Fusion Cx Limited | `INE0N2201019` | NSE | Mainboard |
| `GHUSHINE` | Ghushine Fintrrade Ocean Limit | `INE009U01011` | BSE | SME |
| `GOGIACAPGL` | Gogia Capital Growth Limited | `INE832C01014` | BSE | Mainboard |
| `HDFIRE` | Hd Fire Protect Limited | `INE18AK01028` | NSE | Mainboard |
| ... | *and 37 more securities* | ... | ... | ... |

---

## 6. Manual Mapping Candidate Review

Of the missing securities, none have verified official SVG logos in the upstream provider under alternative names. Adding guessed or unverified brand graphics is strictly forbidden by project integrity rules. Genuinely unavailable logos are safely preserved with initials fallback.

---

## 7. Performance & Safety Verification

- **Lazy Loading**: Active on all table rows (`loading="lazy"`).
- **Asynchronous Decoding**: Active on all logos (`decoding="async"`).
- **Network Concurrency**: Maximum 50 rows per page view; zero simultaneous multi-thousand bulk requests.
- **Error Handling**: `onerror` gracefully falls back to `<span class="stock-logo-wrap">` initials tile.
- **Broken Image Icons**: 0 across the entire application.
