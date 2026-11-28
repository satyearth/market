# Machii Bazzar v2.0.0 — UI/UX Refinement & Responsive Layout Report

**Branch:** `release/v2.0.0` (`44c851e` base, changes kept local for review)  
**Scope:** Frontend UI/UX, responsive layout, readability, and accessibility refinement across [index.html](./index.html), [css/page-layout.css](./css/page-layout.css), [js/app.js](./js/app.js), [stock.html](./stock.html), [css/stock-details.css](./css/stock-details.css), [js/stock-details.js](./js/stock-details.js), and regression assertions in [tests/audit-regression.test.js](./tests/audit-regression.test.js).

---

## 1. Root Causes Identified

1. **Cluttered Homepage Filter Toolbar**: Previously, screening filters (`All stocks`, `Top gainers`, etc.) and sector filter pills wrapped across multiple rows alongside a redundant mobile sector toggle button (`#mobile-sector-toggle`) whose CSS specificity overrode Tailwind utility classes on desktop.
2. **Asymmetric Desktop Grid Void on Stock Details**: Placing all cards into a shared 2-column grid caused `Recent price history` (tall right-hand column) to stretch row height and leave a large empty dark void underneath `Trading session data` on desktop viewports.
3. **Unbounded 90-Session History Table & Misleading Range Defaults**: Rendering all 90 price history rows on initial load pushed `Company information` and `Exchange listings` far down the page; meanwhile, `stock.html` initialized 52-week and day range indicators with `50%` inline styles that risked persisting when range data was flat or unavailable.
4. **Cramped Company Information Borders & Description Placement**: An uneven `stock-detail-grid` cell border rule broke across responsive column counts and squeezed company descriptions into a narrow monospace table cell. Furthermore, raw backend market-cap source keys (e.g., `NSE_OFFICIAL_MCAP`, `INDIA_API_ISIN`) appeared verbatim in the UI.
5. **Visual Discrepancy vs. Production Screenshot**: The live site (`machiibazzar.vercel.app`) served older `main` without company descriptions populated, whereas the verified local `release/v2.0.0` dataset already supplies descriptions for 5,356 of 5,465 equities. Moving `About the company` into a full-width paragraph block surfaces those descriptions cleanly.

---

## 2. Implemented Changes

### Homepage ([index.html](./index.html), [css/page-layout.css](./css/page-layout.css), [js/app.js](./js/app.js))
- **Two-Group Toolbar (`.filter-dashboard-bar`)**:
  - **Group A (`.filter-group-screening`)**: Dedicated screening pills (`All stocks`, `Top gainers`, `Top losers`, `Near 52W high`, `★ Watchlist`, `High volume`).
  - **Visual Separator (`.filter-group-divider`)**: Subtle desktop vertical hairline separating screening actions from sector selection.
  - **Group B (`#sector-picker`)**: Compact accessible sector dropdown (`#sector-dropdown-btn` + `#sector-dropdown-menu` listbox + `#sector-clear-btn`) covering all 18 unique dataset sectors cleanly without multi-row pill clutter.
  - **Keyboard & Interaction Handling (`js/app.js`)**: Full `ArrowDown`, `ArrowUp`, `Home`, `End`, `Enter`/`Space`, `Escape`, and outside-click dismissal, synchronized with Group A active states.

### Stock Detail Page ([stock.html](./stock.html), [css/stock-details.css](./css/stock-details.css), [js/stock-details.js](./js/stock-details.js))
- **Independent Two-Column Desktop Stacking (`>= 900px`)**:
  - **Left Column (`.stock-detail-col-left`)**: `#trading-session-card` (OHLC grid + Day range + Volume + Valuation ratios) stacked directly above `#company-info-card`.
  - **Right Column (`.stock-detail-col-right`)**: `#stock-history-section` stacked above `#exchange-listings-card`.
  - **Mobile & Tablet Stack (`< 900px`)**: Uses `display: contents` on column wrappers with explicit flex ordering (Overview -> Trading session & Valuation -> Recent price history -> Company information -> Exchange listings).
- **Compact Expandable Price History (`DEFAULT_HISTORY_ROWS = 10`)**:
  - Displays the latest 10 trading sessions by default.
  - Adds accessible `#stock-history-toggle` (`aria-expanded`, `aria-controls="stock-history-table"`) inside `#stock-history-actions` (hidden when `<= 10` sessions exist) toggling a bounded scrollable table container (`.stock-history-table-wrap.is-expanded`, `max-height: 380px`) with a sticky header (`.stock-history-thead th`).
- **Safe Range Visualizers & Responsive OHLC**:
  - Initialized `#stock-52w-fill`, `#stock-52w-pin`, and `#stock-ohlc-range-fill` at `0%` width/offset and reset them explicitly on flat (`high === low`) or unavailable ranges with clear status labels.
  - Responsive `.ohlc-grid` (`2x2` narrow, `4x1` wide, fluid `.ohlc-val`) prevents 6-digit price clipping (e.g., `MRF`).
- **Crisp 8-Field Company Grid & Full-Width Description**:
  - Rendered 8 structured fields in hairline `.stock-detail-grid` (`2x4` default, `4x2` `>= 1400px`, `1x8` `<= 520px`) plus dedicated `#company-description-block` (`About the company`) below the grid.
- **Human-Readable Financial Source Labels (`MCAP_SOURCE_LABELS` / `formatFinancialSource`)**:
  - Maps `NSE_OFFICIAL_MCAP`, `BSE_SECURITY_MASTER`, `CALCULATED_OUTSTANDING_SHARES`, `INDIA_API_ISIN`, `INDIA_API_TICKER`, `SCREENER_DATASET`, `BENCHMARK_VERIFIED`, `PREVIOUS_SESSION_VERIFIED`, and fallback underscore enums into readable labels while keeping backend API JSON intact.
- **Balanced Exchange Listings**:
  - Applies `.exchange-cards-row.is-dual` (2-column NSE + BSE side-by-side above full-width ISIN & status) for dual-listed securities, and `.exchange-cards-row.is-single` (full-width exchange card above ISIN & status) for single-exchange securities.
- **Security & CSP Preservation**:
  - Zero inline `<script>`, zero inline event handlers, zero inline `<svg>` in `stock.html` and `js/stock-details.js`, existing APIs unchanged.

---

## 3. Verification Results

All checks ran cleanly **after the final edit** with exit code `0`:

| Check / Suite | Command | Result |
| :--- | :--- | :--- |
| Linter | `npm run lint` | **PASS** (`EXIT=0`) |
| Unit + Regression + QA + Pipeline | `npm test` | **PASS** (`EXIT=0`): 8 modular backend suites passed (including Section 14 UI/UX assertions in `tests/audit-regression.test.js`), dataset verification `67 PASSED / 0 FAILED`, frontend QA `104 PASSED / 0 FAILED`, missing-stock audit `39 PASSED / 0 FAILED`, discovery, auto-refresh, and 90-day pipeline `33 PASSED / 0 FAILED` |
| Market Cap Coverage | `npm run test:mcap` | **PASS** (`EXIT=0`, `19 PASSED / 0 FAILED`) |
| End-to-End Browser & API | `npm run test:browser` | **PASS** (`EXIT=0`, 5,465 unique ISINs in 110 batches, search, sort, filters, logos, mobile check) |
| Responsive Comprehensive | `npm run test:responsive` | **PASS** (`EXIT=0`, `Total errors: 0` across 8 viewports) |
| Custom UI/UX Playwright Audit | Chromium Playwright across 10 widths & 14 representative ISINs | **PASS** (`EXIT=0`): `scrollWidth <= innerWidth` across `320, 360, 390, 414, 768, 1024, 1280, 1440, 1920, 2560px`; zero overlap; exact mobile/desktop order; `10`-row collapse & scrollable expand (`height <= 386px`); keyboard sector navigation, watchlist, compare dialog, CSV download; zero console/page/CSP errors |

### Representative Edge Cases Verified (`1280x800` & `390x844`)
- **Bluechips**: `INE002A01018` (`RELIANCE`), `INE040A01034` (`HDFCBANK`), `INE467B01029` (`TCS`), `INE009A01021` (`INFY`)
- **High Price Formatting**: `INE883A01011` (`MRF`) — zero OHLC clipping
- **Single-Exchange Balance**: `INE118H01025` (NSE-only `.is-single`), `INE721I01024` (BSE-only `.is-single` & missing 52W `0%` track + hidden pin)
- **SME Platform**: `INE0GXK01018`
- **History Edge Cases**: `INE0H7R23014` (`< 10` sessions — toggle hidden), `INE03K401026` (`0` sessions — unavailable notice shown)
- **Valuation & Cap Edge Cases**: `INE056J01015` (unverified market cap `—`), `INE646L01027` (unavailable P/E)
- **Long Copy Wrapping**: `INE0GK401011` (long company name), `IN9641R03011` (partly-paid + long description)

---

## 4. Before & After Screenshots

- **Before**:
  - [before-home-desktop.png](./docs/reports/ui-ux-screenshots/before-home-desktop.png)
  - [before-home-mobile.png](./docs/reports/ui-ux-screenshots/before-home-mobile.png)
  - [before-stock-desktop.png](./docs/reports/ui-ux-screenshots/before-stock-desktop.png)
  - [before-stock-gap.png](./docs/reports/ui-ux-screenshots/before-stock-gap.png)
  - [before-stock-mobile.png](./docs/reports/ui-ux-screenshots/before-stock-mobile.png)
- **After**:
  - [after-home-desktop.png](./docs/reports/ui-ux-screenshots/after-home-desktop.png)
  - [after-home-desktop-sector-open.png](./docs/reports/ui-ux-screenshots/after-home-desktop-sector-open.png)
  - [after-home-mobile.png](./docs/reports/ui-ux-screenshots/after-home-mobile.png)
  - [after-stock-desktop.png](./docs/reports/ui-ux-screenshots/after-stock-desktop.png)
  - [after-stock-desktop-company.png](./docs/reports/ui-ux-screenshots/after-stock-desktop-company.png)
  - [after-stock-mobile.png](./docs/reports/ui-ux-screenshots/after-stock-mobile.png)

---

## 5. Known Notes / Pending Authorization

- **Local-Only Changes**: Per instructions, no `git commit`, `git push`, branch merge, or live Vercel deployment has been performed. Changes await your visual inspection and commit/deploy authorization.
- **Unmapped Source Keys**: Future backend additions to `market_cap_source` containing underscores automatically render as `Verified Financial Reference` until explicitly added to `MCAP_SOURCE_LABELS` in [js/stock-details.js](./js/stock-details.js).
