# Machii Bazzar

> **End-of-Day (EOD) Indian Equities Intelligence & Screener (NSE + BSE)**  
> Full NSE & BSE Mainboard and SME equity coverage deduplicated by canonical 12-character ISIN, backed by automated Supabase Storage snapshots and zero-framework static HTML/CSS/JS frontend UI.

---

## Key Capabilities

- **ISIN-Unified Screener ([index.html](file:///c:/Users/Satya/Stocks/index.html))**: Infinite-scroll virtualized table served via `GET /api/stocks` (50 rows/batch), instant multi-key search (ticker, company name, ISIN, BSE scrip code, aliases), sector pills, watchlist (`localStorage`), comparison tray, CSV export, and Market Pulse cards.
- **Stock Profile Pages ([stock.html](file:///c:/Users/Satya/Stocks/stock.html))**: Fetches single-stock data via `GET /api/stocks?isin=...` (with lazy fallback to `./js/stocks-data.js` in offline `file://` mode), showing EOD OHLC, 52-week range indicator, fundamentals (when verified), and 6-session historical closes.
- **Automated Daily EOD Pipeline ([.github/workflows/refresh-stock-data.yml](file:///c:/Users/Satya/Stocks/.github/workflows/refresh-stock-data.yml))**: Runs Mon–Fri post-close (`16:45–20:00 IST`) + Sun Muhurat checks, downloads official NSE & BSE BhavCopy archives, validates integrity, and atomically publishes to Supabase Storage (`machii-bazzar-datasets`) with 30-trading-session retention and **zero Git commits**.

---

## API Endpoints

- `GET /api/health` — Readiness, dataset trading date, freshness status, and storage status.
- `GET /api/stocks` — Paginated (`limit <= 50`), searchable, sortable, filterable query endpoint and exact `?isin=` lookup.
- `GET /api/market/status` — IST calendar session evaluation and active dataset metadata.
- `GET /api/market/dataset` — Lightweight dataset statistics and freshness metadata.
- `POST /api/market/refresh` — Triggers local sync in `server.js`; returns storage status (`200` if fresh / `503` if stale) in read-only serverless mode.

---

## Local Development

```bash
npm ci
npm start                  # Starts hardened local server on http://localhost:8080
npm run lint               # Runs ESLint
npm test                   # Runs tests/run-all.js + dataset, QA, audit & pipeline suites
```

---

## Documentation

- [Architecture & Data Pipeline](file:///c:/Users/Satya/Stocks/docs/ARCHITECTURE.md)
- [Supabase Storage, GitHub Actions & Vercel Setup](file:///c:/Users/Satya/Stocks/docs/EXTERNAL_STORAGE_SETUP.md)
- [Market Cap Coverage Report](file:///c:/Users/Satya/Stocks/docs/reports/MARKET_CAP_COVERAGE_REPORT.md)
