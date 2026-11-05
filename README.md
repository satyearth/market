# Machii Bazzar

An EOD stock directory for NSE and BSE listed companies, with search, filters, sorting, pagination, and dedicated stock detail pages.

## Run locally

Install dependencies once, then start the app server:

```bash
npm install
npm start
```

Open `http://localhost:8080`. The stock list and detail pages can also be served as static files, but automatic data refresh requires the Node server.

## Data refresh

The site displays the latest available end-of-day exchange data; it does not provide live prices. When a newer trading session is expected, the server can run `scripts/sync-stock-universe.js`. That script uses the local MCP service at `127.0.0.1:3000` for exchange files and supported market metrics, validates inputs, then updates `js/stocks-data.js`. If fresh verified files are unavailable, it preserves the previous dataset.

## Project structure

```text
index.html                 Main stock listing page
stock.html                 Stock details page (ISIN URL parameter)
css/                       Shared theme and page layout styles
js/app.js                  Listing interactions and refresh flow
js/stock-details.js        Stock details page rendering
js/stocks-data.js          Current generated EOD stock dataset
js/stocks-data.backup.js   Previous dataset backup for sync recovery
scripts/                   MCP sync, validation, audits, and browser checks
downloads/                 Exchange source files and sync inputs/outputs
docs/reports/              Project audit and data coverage reports
test-results/screenshots/  Browser test screenshot outputs
server.js                  Static server and EOD refresh API
```

Run checks with the scripts listed in `package.json`, for example `npm run test:verify` and `npm run test:browser`.
