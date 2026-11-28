# Machii Bazzar v2.0.0 — Financial Data Accuracy & Coverage Audit Report

**Audit Date:** 2026-11-28 (IST)  
**Target EOD Trading Session:** `2026-11-27`  
**Primary Deduplication Key:** 12-character ISIN (`^IN[E9][A-Z0-9]{9}$`)

---

## 1. Universe Reconciliation & Market Cap Denominators (Phase 2)

During prior verification (`2026-11-27`), the dataset held `5,465` instruments with `5,406` market capitalizations (`98.92%`) and `59` missing entries, failing the `>= 99.0%` coverage gate without authoritative exchange share-capital integration and failing to exclude non-common/partly-paid/CCPS pollution.

By integrating official NSE daily archive `PR271126.zip -> mcap27112026.csv` (fetched over verified HTTPS from `nsearchives.nseindia.com`, containing `3,250` raw rows / `3,247` equity/security rows after filtering `Listed`/`Permitted`/`Total` CSV footer summary rows) and enforcing strict instrument-type & cross-ISIN ticker-collision controls, verified dataset accuracy is now:

| Metric | Value | % of Total Instruments (`5,465`) | % of Eligible Share-Capital Equities (`5,439`) | Verification Status |
| :--- | :---: | :---: | :---: | :--- |
| **Total Listed Instruments** | **5,465** | `100.00%` | — | Exact match to NSE (`3,203`) + BSE (`4,777`) − Dual (`2,515`) |
| **Excluded Non-Common Instruments** | **26** | `0.48%` | Excluded from equity share-class denominator | `13` Rights Entitlements (`-RE`) + `12` Partly-Paid (`PP`) + `1` Preference/CCPS (`QDLCCPS`) |
| **Eligible Share-Capital Equities** | **5,439** | `99.52%` | `100.00%` | `5,437` Ordinary Common (`COMMON_EQUITY`) + `2` DVR (`DVR_EQUITY`) |
| **Verified Market Caps** | **5,413** | **`99.05%`** | **`99.52%`** | Passes `>= 99.0%` instrument assertion without lowering threshold |
| **Legitimate `null` Market Caps** | **52** | `0.95%` | `26` unverified common (`0.48%`) + `26` excluded non-common | Strictly `null` (`0` fabricated zeros, `0` `-RE`/`PP`/`CCPS` pollutions) |
| **Aggregate Verified Market Cap** | **₹5,16,27,827 Cr** | — | — | Reflects live `2026-11-27` NSE EOD capitalization on `3,188` NSE equities |

---

## 2. Full Resolution of Original 59 Missing & Newly Scrubbed Entries

### 2.1 Resolved from Official NSE Daily Archive (`14` Newly Verified Equities)

All `14` active NSE-listed common equities missing from stale snapshots resolved cleanly from `mcap27112026.csv` (`Category: Listed`, `2026-11-27`):

| Symbol | Segment / Series | NSE Issue Size (Shares) | Close (INR) | Official Market Cap (INR Cr) |
| :--- | :--- | :---: | :---: | :---: |
| `MAHACOAL` | Mainboard / `EQ` | `6,618,363,000` | `132.50` | **₹87,693.31 Cr** |
| `HEGRAPHITE` | Mainboard / `BE` | `192,977,530` | `557.65` | **₹10,761.39 Cr** |
| `IGLSPIRITS` | Mainboard / `EQ` | `67,026,765` | `733.15` | **₹4,914.07 Cr** |
| `CRYSTALCP` | Mainboard / `EQ` | `163,177,583` | `263.40` | **₹4,298.10 Cr** |
| `JKSHAH` | Mainboard / `BE` | `96,506,610` | `177.10` | **₹1,708.94 Cr** |
| `BCSSL` | Mainboard / `EQ` | `62,824,211` | `81.15` | **₹509.94 Cr** |
| `WATRANA` | SME / `ST` | `16,340,500` | `251.00` | **₹410.15 Cr** |
| `ENNATURE` | Mainboard / `EQ` | `22,342,255` | `163.40` | **₹365.07 Cr** |
| `GRETEX` | SME / `SM` | `15,506,060` | `221.85` | **₹344.00 Cr** |
| `MAXENGS` | SME / `SM` | `13,698,275` | `250.65` | **₹343.35 Cr** |
| `HGSINDIALT` | SME / `SM` | `10,858,713` | `185.00` | **₹200.89 Cr** |
| `MELSTAR` | Mainboard / `BE` | `2,793,661` | `439.95` | **₹122.91 Cr** |
| `VPFL` | SME / `SM` | `20,151,614` | `41.25` | **₹83.13 Cr** |
| `DKEGL` | SME / `SM` | `7,508,000` | `70.00` | **₹52.56 Cr** |

### 2.2 Scrubbed Erroneous & Double-Counted Capitalizations (`7` Scrubbed to `null`)

Deep ISIN audit uncovered **5** non-common instruments previously inheriting company-wide market caps from `INDIA_API_ISIN` (double-counting parent equity) and **2** cross-ISIN ticker collisions in `INDIA_API_TICKER`:

1. **`JAYKAYPP` (`IN9903A01015`)** — Partly-Paid share falsely carried `₹3,379.99 Cr` alongside `JAYKAY` (`INE903A01025`) -> scrubbed to **`null`**.
2. **`ATLPP` (`IN90NN701011`)** — Partly-Paid share falsely carried `₹787.73 Cr` alongside `ATL` (`INE0NN701020`) -> scrubbed to **`null`**.
3. **`SURAJINDPP` (`IN9170U01035`)** — Partly-Paid share falsely carried `₹279.80 Cr` alongside `SURJIND` (`INE170U01011`) -> scrubbed to **`null`**.
4. **`QDLCCPS` (`IN9641R03011`)** — Compulsorily Convertible Preference Share falsely carried `₹265.07 Cr` alongside `QUINT` (`INE641R01017`) -> scrubbed to **`null`**.
5. **`APLABPP` (`IN9273A01047`)** — Partly-Paid share falsely carried `₹174.09 Cr` alongside `APLAB` (`INE273A01015`) -> scrubbed to **`null`**.
6. **`RAJPUTANA` (`INE751R01014`, BSE)** — Rajputana Investment & Finance Ltd (`₹27.01` close) falsely matched NSE `RAJPUTANA` (`Rajputana Biodiesel Ltd`, `INE0VHU01019`, `₹145.76 Cr`) via `INDIA_API_TICKER` -> blocked & scrubbed to **`null`**.
7. **`SEL` (`INE367E01033`, BSE `509423`)** — Sanathnagar Enterprises Ltd (`₹36.22` close) falsely matched NSE `SEL` (`Sungarner Energies Ltd`, `INE0O3O01017`, `₹73.94 Cr`) via `INDIA_API_TICKER` -> blocked & scrubbed to **`null`**.

Note: **`JISLDVREQS`** (`IN9175A01010`, `₹36.54 Cr`) and **`FELDVR`** (`IN9623B01058`, `₹7.72 Cr`) are legitimate Differential Voting Rights (`DVR_EQUITY`) share classes with independent issued share counts verified directly in NSE `mcap27112026.csv` and are retained cleanly.

### 2.3 Remaining `52` Unverified / Excluded Instruments (`59 - 14 + 7 = 52`)

All `52` remaining `null` instruments are itemized in [docs/reports/MARKET_CAP_COVERAGE_REPORT.md](docs/reports/MARKET_CAP_COVERAGE_REPORT.md):
- **13 Rights Entitlements (`-RE`)**: `CRESCE-RE1`, `EVONILE-RE`, `FRESITA-RE`, `IEML-RE1`, `INTFIN-RE1`, `IRONWO-RE`, `JINDCAP-RE`, `KANE-RE`, `MAGNUS-RE1`, `MIHIKA-RE`, `PRAXIS-RE3`, `VEERG-RE`, `ZODJRD-RE1` (note `IEML-RE1` & `PRAXIS-RE3` appear in `mcap27112026.csv` but are blocked by `classifyEquityInstrumentType`).
- **12 Partly-Paid Shares (`IN9...PP`)**: `ACESEPP`, `ANIRITPP`, `APLABPP`, `ATLPP`, `CENTEXTPP`, `FRATELLIPP`, `GSAILPP`, `INDRAYANIPP`, `JAYKAYPP`, `OLAPP`, `SURAJINDPP`, `VERTEXPP`.
- **1 Preference / CCPS (`IN9...03`)**: `QDLCCPS`.
- **13 BSE-only SME Equities** without verified share capital: `ANTALA`, `ARTEMISADR`, `FABINO`, `JOHNSONCAB`, `KDML`, `KMSMEDI`, `NAVIGANT`, `POLYMAC`, `RAFL`, `RANJEET`, `RITHWIKFMS`, `SILVERPRL`, `VECTRAS`.
- **8 Inactive Zero-Volume BSE Mainboard Equities**: `AARCON`, `ABHIINFRA`, `AIRLTD`, `MOUNT`, `SAENTER`, `SML`, `WARDHEALTH`, `ZGAEKWAR`.
- **5 Active BSE-only Mainboard Equities** lacking authoritative BSE exchange share capital: `AVENIQUE`, `KGES`, `MPFSL`, `RAJPUTANA` (`INE751R01014`), `SEL` (`INE367E01033`).

---

## 3. Financial Accuracy Audit Breakdown (Phase 5)

### 3.1 Market Capitalization Provenance (`5,465` Universe)

| Priority | Source Key | Equities Resolved | As-Of Date / Freshness | Provenance Characteristics |
| :---: | :--- | :---: | :--- | :--- |
| **1** | `NSE_OFFICIAL_MCAP` | **3,188** | `2026-11-27` (**Live EOD**) | Authoritative exchange-reported `Issue Size × Close` in `mcap27112026.csv` |
| **2** | `CALCULATED_OUTSTANDING_SHARES` | **1,857** | `2026-11-27` (**Derived EOD**) | `EOD Close × Implied Shares` (primarily BSE-only stocks; guarded for `0.45x–2.25x` range and post-Nov-4 split discontinuities) |
| **3–5** | `INDIA_API_ISIN` | **223** | `2026-11-25` (**2-Day Snapshot**) | ISIN-matched third-party catalog fallback for BSE-only / recent listings |
| **6** | `SCREENER_DATASET` | **145** | `2026-11-04` (**Static Snapshot**) | Used only when ref close within `±10%` of Nov-4 `cmp` |
| **7** | `INDIA_API_TICKER` | **0** | — | Cross-ISIN mismatches & carryover strictly blocked |
| **8** | `PREVIOUS_SESSION_VERIFIED` | **0** | — | Emergency carryover (none required) |
| **N/A** | `null` | **52** | — | Non-common (`26`) or unavailable authoritative share capital (`26`) |

### 3.2 Share Capital Changes, Corporate Actions & Split Corrections

- **QIP / Conversion / Split Correction**: Integrating `mcap27112026.csv` updated official share counts and caps across NSE stocks with post-`2026-11-04` corporate actions:
  - `KMEW`: old static Screener showed `₹8,487.03 Cr` (pre-split `₹3,329.90` price) -> official NSE **`₹8,758.30 Cr`** (`126,821,585` shares at `₹690.60`).
  - `PASHUPATI`: old static Screener showed `₹2,112.27 Cr` (`₹133.85`) -> official NSE **`₹1,301.00 Cr`** (`394,600,000` shares at `₹32.95` / close `₹32.97`).
  - `UEL`: old static Screener showed `₹2,481.13 Cr` -> official NSE **`₹5,619.42 Cr`**.
  - `ASHIKAG`: old static Screener showed `₹2,742.83 Cr` -> official NSE **`₹1,759.26 Cr`** (`Permitted` category).
  - `SEL` (NSE Sungarner Energies): `₹57.62 Cr` (`NSE_OFFICIAL_MCAP`) distinct from BSE Sanathnagar Enterprises (`null`).
- **`TOTAL` CSV Footer Trap Eliminated**: `mcap27112026.csv` appends 3 summary footer rows (`Symbol = Listed`, `Permitted`, `Total` with `Market Cap = 507,360,723,073,184 Rs`) at the end of the file, colliding in symbol name with listed equity **`TOTAL`** (`INE336X01012`, Series `BE`, `₹131.52 Cr`). `loadNseOfficialMcapArchive` now ignores rows lacking valid `Series`, `Category`, and positive `Issue Size`.
- **Exchange Corporate Actions File (`bc27112026.csv`)**: Now extracted automatically from `PR271126.zip` (`141` rows total; `10` equity-series announcements such as `FUSIONCX` dividend ex-`2026-11-27`, `INTERARCH` face-value split ex-`2026-11-30`, `SPAL` split ex-`2026-12-10`).

### 3.3 Remaining Known Financial Data Caveats (Transparently Stamped)

1. **`pe_ratio` and `roce` Freshness (`2026-11-04`)**:
   - Populated on `4,306` (`pe_ratio`) and `5,237` (`roce`) equities, stamped explicitly with `fundamentals_as_of_date = '2026-11-04'` (`5,301` rows) or `null` (`164` rows).
   - **Why PE cannot yet be refreshed live daily**: Direct BSE endpoints (`api.bseindia.com`, `www.bseindia.com/download/BhavCopy/Equity/PR...`) return HTTP 403 (Akamai challenge) / HTTP 404 HTML pages, and NSE `PR` archives supply Market Cap and Issue Size without trailing 12-month EPS/ROCE filings. UI surfaces `fundamentals_as_of_date` so stale PE/ROCE snapshots are never mistaken for live daily ratios.
2. **BSE-Only `CALCULATED_OUTSTANDING_SHARES` Share-Count Lag (`1,857` BSE Equities)**:
   - Because BSE direct corporate-action / daily mcap endpoints blocked automated HTTP access (`403`/`404`), BSE-only stocks without NSE listing still rely on `EOD Close × Screener Implied Shares (2026-11-04)`. Any BSE-only company completing a QIP/preferential issue or bonus after `2026-11-04` (without triggering the split discontinuity guard) retains `2026-11-04` share count until reference catalogs refresh.
3. **Dual-ISIN Corporate Action Carryover Anomaly (`VGL` / `514274`)**:
   - `publisher.js` emits `Warning: Exchange identifier shared across multiple ISINs: NSE:VGL(INE273D01035,INE273D01027); BSE:514274(INE273D01035,INE273D01027)`.
   - `INE273D01035` is the active post-action ISIN (`px=21.07`, `vol=188,570`, `mcap=271.43 Cr`), while `INE273D01027` is a carried-forward `vol=0` (`px=52.81`) older ISIN still associated with `VGL`. Because `mcap27112026.csv` indexes by `Symbol` + `Series` (no ISIN column), the carried-forward `vol=0` ISIN also resolved `₹271.43 Cr`. Recommended future enhancement: suppress `NSE_OFFICIAL_MCAP` on `vol === 0` superseded ISINs sharing `(nse_symbol, series)` with a higher-volume active ISIN.

### 3.4 Reconciliation Identities (`2026-11-27`)

- **ISIN Deduplication**: `dualListed (2,515) + nseOnly (688) + bseOnly (2,262) === 5,465`; `nseListed (3,203) + bseListed (4,777) - dualListed (2,515) === 5,465`; `0` duplicate ISINs.
- **SME Classification**: NSE Emerge (`SM`, `ST`, `SZ` = `556`) + BSE SME (`M`, `MT`, `MS` = `517`) − Dual (`0`) = **`1,073` SME**; `Mainboard (4,392) + SME (1,073) === 5,465`. All `1,073` SME rows correctly have `rank = null`.
- **Market Breadth & Volatility**: `advances (2,635) + declines (2,135) + unchanged (693) + unpriced (2) === 5,465` (A/D ratio `1.23`); India VIX **`16.55`** (`27-11-2026` from `ind_close_all_27112026.csv`); `284` stocks near 52-week high (`CM_52_wk_High_low_27112026.csv`).
- **Historical & Return Consistency**: `90` verified sessions (`2026-07-21` to `2026-11-27`), `5,256` 1W returns, `5,153` 1M returns, `5,188` 3M returns, `0` fabricated 1Y returns (`null`).
