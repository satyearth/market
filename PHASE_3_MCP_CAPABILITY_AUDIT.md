# Machli Bazzar — Phase 3.0: NSE/BSE MCP Integration Capability Audit

**Date:** 04-Nov-2026  
**Status:** Audit Complete  
**Scope:** Strict capability assessment of `.agents/mcp_config.json`, `scripts/sync-stock-universe.js`, exchange endpoints, protocol boundaries, and deployment architectures.  
**Constraint Enforced:** No application code or configuration modified.

---

## 1. Configured MCP Servers Inspection

Inspection of [`.agents/mcp_config.json`](file:///c:/Users/Satya/Stocks/.agents/mcp_config.json):

```json
{
  "mcpServers": {
    "nse-bhavcopy": {
      "serverUrl": "https://mcp.nseindia.in/bhavcopy/cm/mcp"
    },
    "nse-cm-market": {
      "serverUrl": "https://mcp.nseindia.in/cmmkt/mcp"
    },
    "bse-mcp": {
      "serverUrl": "http://localhost:3000/mcp",
      "timeoutSeconds": 120
    }
  }
}
```

### Server Overview
1. **`nse-bhavcopy` (`https://mcp.nseindia.in/bhavcopy/cm/mcp`)**: Remote HTTPS endpoint registered under official NSE domain.
2. **`nse-cm-market` (`https://mcp.nseindia.in/cmmkt/mcp`)**: Remote HTTPS endpoint registered under official NSE domain for cash market data.
3. **`bse-mcp` (`http://localhost:3000/mcp`)**: Local loopback JSON-RPC endpoint powered by the community package `nse-bse-mcp`. Despite its name (`bse-mcp`), it exposes tools for **both BSE and NSE**.

---

## 2. Sync Engine Invocations (`scripts/sync-stock-universe.js`)

Inspection of the data ingestion pipeline reveals the exact MCP tools invoked during synchronization:

| Ingestion Step | Tool Invoked | Target Endpoint | Arguments | Purpose & Result |
| :--- | :--- | :--- | :--- | :--- |
| **Ping & Validation** | `nse_download_equity_bhavcopy` | `http://localhost:3000/mcp` | `{ date: "2026-11-04" }` | Pings local MCP server; downloads current NSE CM Bhavcopy CSV. |
| **BSE Bhavcopy Fetch** | `bse_download_bhavcopy` | `http://localhost:3000/mcp` | `{ date: "2026-11-04" }` | Downloads current BSE CM Bhavcopy CSV. |
| **Historical Ingestion** | `nse_download_equity_bhavcopy` & `bse_download_bhavcopy` | `http://localhost:3000/mcp` | `{ date: dt }` for 5 historical dates | Downloads 5 prior daily Bhavcopies for genuine sparkline mapping. |
| **India VIX** | `nse_vix_historical` | `http://localhost:3000/mcp` | `{}` | Ingests closing India VIX level (`15.19`) and percentage change (`-3.39%`). |
| **52-Week High Proximity** | `bse_near_52week` | `http://localhost:3000/mcp` | `{ by: 'group', name: 'A' }` & `{ by: 'group', name: 'B' }` | Ingests 41 near-52W-high scrips for BSE Groups A & B (36 meet $\ge -8\%$ threshold). |
| **Security Master & Cap** | `bse_list_securities` | `http://localhost:3000/mcp` | `{ status: "Active", group: "A"/"B" }` | Ingests verified market capitalization for Top 343 equities. |

**Key Finding:** The sync script routes **100% of its MCP calls to the local server (`http://localhost:3000/mcp`)**. It does not invoke `https://mcp.nseindia.in` directly.

---

## 3. Server Verification: Status, Discovery, Invocation & Data Provenance

```
+---------------------------------------------------------------------------------------------------+
| SERVER VERIFICATION MATRIX                                                                        |
+-------------------+-------------------+--------------------+------------------+-------------------+
| Server Name       | Connection Status | Tool Discovery     | Tool Invocation  | Data Provenance   |
+-------------------+-------------------+--------------------+------------------+-------------------+
| nse-bhavcopy      | REACHABLE (400)   | 21 tools cataloged | FRAGILE          | Official Exchange |
|                   | Akamai edge       | in Antigravity     | Session timeout  | (Bhavcopy cache)  |
+-------------------+-------------------+--------------------+------------------+-------------------+
| nse-cm-market     | REACHABLE (400)   | 16 tools cataloged | PARTIAL          | Official Exchange |
|                   | Akamai edge       | in Antigravity     | Session timeout  | (5-min crawler)   |
+-------------------+-------------------+--------------------+------------------+-------------------+
| bse-mcp           | LOCAL RUNNER      | 51 tools cataloged | RELIABLE         | Community Wrapper |
| (nse-bse-mcp)     | Port 3000         | locally            | when daemon runs | (Scrapes official)|
+-------------------+-------------------+--------------------+------------------+-------------------+
```

### Detailed Breakdown

#### 1. `nse-bhavcopy` (`https://mcp.nseindia.in/bhavcopy/cm/mcp`)
- **Connection Status:** Hosted on Apache behind an Akamai Edge CDN (`akamai-grn: 0.97d70b17...`). Standard HTTP GET requests receive HTTP 400 Bad Request (as MCP requires a valid JSON-RPC POST payload).
- **Tool Discovery:** 21 tools discovered in the Antigravity catalog (`get_top_by_volume`, `get_top_movers`, `nse_lookup_symbol`, `get_market_mood`, `get_index_valuation`, `get_market_breadth`, `get_stock_history`, `get_52_week_high_low`, etc.).
- **Invocation Reliability:** High failure rate via remote MCP client due to edge session termination (`session not found` on subsequent calls).
- **Data Provenance:** Official exchange EOD Bhavcopy cache stored in JVM memory / Redis.

#### 2. `nse-cm-market` (`https://mcp.nseindia.in/cmmkt/mcp`)
- **Connection Status:** Hosted behind the same Akamai CDN infrastructure.
- **Tool Discovery:** 16 tools discovered (`cm_get_live_market_data`, `cm_get_equity_stocks`, `cm_get_live_gainers`, `cm_get_live_losers`, `cm_get_data_status`, `cm_get_stock_quote`, `cm_get_index_quote`, etc.).
- **Actual Invocation:** Successfully invoked `cm_get_data_status`, returning:
  ```json
  {
    "indices": {
      "gainers": { "available": true, "lastCrawled": "2026-11-04T16:23:17.241163086Z" },
      "loosers": { "available": true, "lastCrawled": "2026-11-04T16:23:17.922633617Z" }
    },
    "crawlIntervalMinutes": 5,
    "redisTtlMinutes": 15
  }
  ```
- **Data Provenance:** Official NSE cash market crawler. Note: Data is delayed by 5 minutes (`crawlIntervalMinutes: 5`) with a 15-minute cache TTL.

#### 3. `bse-mcp` (`http://localhost:3000/mcp`)
- **Connection Status:** Local Node.js service launched via `npx -y nse-bse-mcp`.
- **Tool Discovery:** 51 tools covering both NSE and BSE.
- **Invocation Reliability:** 100% reliable when the local daemon is running.
- **Data Provenance:** Community-maintained MCP wrapper package. It fetches data by issuing HTTPS requests to public exchange endpoints (`nseindia.com` and `bseindia.com`), parsing exchange JSON/CSV into MCP responses.

---

## 4. Market Data Capability Matrix

| Data Dimension | Best Supporting MCP Tool | Source Server | Data Granularity & Scope | Complete Universe? |
| :--- | :--- | :--- | :--- | :---: |
| **Full NSE Stock Universe** | `nse_download_equity_bhavcopy` | `bse-mcp` (local) | 3,085 unique active equities with ISINs | **YES (100%)** |
| **Full BSE Stock Universe** | `bse_download_bhavcopy` | `bse-mcp` (local) | 4,310 unique active equities across all groups | **YES (100%)** |
| **Current Day Closing Prices** | `nse_download_equity_bhavcopy` / `bse_download_bhavcopy` | `bse-mcp` (local) | EOD Open, High, Low, Close, Prev Close, Traded Volume | **YES (4,965 scrips)** |
| **Historical Price Series** | `get_stock_history` / `downloads/` CSVs | `nse-bhavcopy` / local | 6 daily sessions in local archive; multi-year on remote | Partial local (6D) |
| **Market Breadth** | Bottom-up computation from Bhavcopies | Built-in | 3,228 Adv / 1,539 Dec / 196 Unch / 2 Unp | **YES (100%)** |
| **India VIX** | `nse_vix_historical` | `bse-mcp` (local) | Level (15.19), Change (-3.39%), Date (04-NOV-2026) | **YES** |
| **Market Capitalization** | `bse_list_securities` | `bse-mcp` (local) | BSE Groups A & B only (Top 343 verified scrips) | **NO (Partial 6.9%)** |
| **52-Week High / Low** | `bse_near_52week` | `bse-mcp` (local) | BSE Groups A & B only (40 scrips, 36 near high) | **NO (Partial)** |
| **Corporate Actions** | `bse_corporate_actions` / `get_corporate_actions` | `bse-mcp` / `nse-bhavcopy` | Dividends, bonuses, splits, rights, AGM dates | Available per scrip |
| **Sector & Index Data** | `cm_get_live_indices` / `bse_all_indices_by_date` | `nse-cm-market` / `bse-mcp` | Broad, sectoral, thematic index levels | Available |

---

## 5. Latency & Delivery Model Disambiguation

| Category | Definition | MCP Support Status | Actual Implementation in Machli Bazzar |
| :--- | :--- | :---: | :--- |
| **Real-Time Streaming** | Sub-second tick-by-tick broadcast push via WebSocket / FIX / multicast. | **UNSUPPORTED** | **None.** No MCP tool provides WebSocket or push streams. |
| **Delayed Market Data** | Intraday snapshot polled with 1- to 15-minute lag during trading hours. | **SUPPORTED** | `nse-cm-market` crawler (5-min crawl interval). Not used in EOD production dataset. |
| **End-of-Day (EOD) Bhavcopy** | Official daily closing report published after market close (17:00–19:00 IST). | **SUPPORTED** | **Core Dataset.** All 4,965 equities derive from verified NSE & BSE EOD Bhavcopy CSVs. |
| **Historical Data** | Prior daily closing sessions for multi-day analysis and charting. | **SUPPORTED** | **6 Verified Daily Sessions** (2026-10-28 to 2026-11-04) power sparklines and 1W returns. |

---

## 6. Live Quotes & Streaming Subscriptions Reality Check

- **Myth:** Because MCP tools include names like `bse_quote`, `nse_equity_quote`, `cm_get_live_gainers`, or `cm_get_live_market_data`, the server provides live streaming prices.
- **Fact:** Every tool in all three MCP configurations is a **unary request-response RPC**. There are **no pub/sub channels, no streaming SSE topics, and no WebSocket listeners**.
- **Scalability Limitation:** To obtain intraday prices for the full 4,965 universe using quote tools would require 4,965 sequential HTTP requests. This would take 15–30 minutes per cycle, immediately triggering Akamai WAF rate limits and HTTP 403 blocks.
- **Staleness Outside Market Hours:** Delayed quote tools only update during NSE/BSE trading hours (09:15–15:30 IST, Monday–Friday). At all other times, they return static post-market values.

---

## 7. Client Execution Boundary: App vs. Sync Script

```
+------------------------------------------------------------------------------------+
| EXECUTION BOUNDARY                                                                 |
|                                                                                    |
| [ Client Browser ]                                                                 |
| index.html <--- loads <--- js/stocks-data.js (Static, pre-compiled JSON)           |
| js/app.js                                                                          |
| (Zero MCP calls, zero backend dependencies, zero network requests to localhost)    |
|                                                                                    |
| ============================ BUILD-TIME BOUNDARY ================================= |
|                                                                                    |
| [ Local CLI / Sync Script ]                                                        |
| scripts/sync-stock-universe.js ---> POST http://localhost:3000/mcp (JSON-RPC)      |
|                                ---> Downloads official exchange CSVs               |
|                                ---> Compiles js/stocks-data.js                      |
+------------------------------------------------------------------------------------+
```

### Can the Browser Call Local MCP Tools Directly?
**No.** Direct invocation from the browser is blocked by:
1. **CORS Restrictions:** `localhost:3000` does not serve open CORS headers for arbitrary browser origins.
2. **Mixed-Content Blocking:** A web app hosted on HTTPS (e.g. GitHub Pages) is blocked by modern browsers from making insecure HTTP calls to `http://localhost:3000`.
3. **Host Isolation:** Website visitors do not run an MCP daemon on port 3000 on their personal devices.
4. **Conclusion:** MCP serves strictly as a **build-time ingestion pipeline**, compiling static exchange data into `js/stocks-data.js`.

---

## 8. GitHub Actions Cloud Execution Blocker & Viable Architectures

### Root Cause of Cloud Failure
1. **Host Isolation:** GitHub Actions runners execute inside Azure/AWS virtual machines. `http://localhost:3000` on a runner refers to that runner VM, not the developer's workstation.
2. **Exchange IP Geofencing & Anti-Bot Filtering:** When a GitHub Actions runner attempts to download files or invoke exchange endpoints:
   - Akamai Bot Manager detects the runner's Microsoft Azure / AWS IP range.
   - The request is immediately rejected with **HTTP 403 Forbidden** or anti-bot verification challenges.

### Technically Viable Architectures

```
+------------------------------------------------------------------------------------+
| 4 VIABLE DEPLOYMENT ARCHITECTURES                                                  |
+------------------------------------------------------------------------------------+
| Architecture A: Build-Time Ingestion (Current)                                     |
| Developer machine runs sync script -> Commits js/stocks-data.js -> Pushes to Git.  |
| Pros: Zero server cost, zero cloud blocking, verified static delivery.             |
| Cons: Requires manual/local scheduled trigger.                                     |
+------------------------------------------------------------------------------------+
| Architecture B: Self-Hosted Indian Runner                                          |
| GitHub Actions runs on a self-hosted Indian VPS/workstation with domestic IP.      |
| Pros: Fully automated scheduled sync, bypasses cloud geofencing cleanly.           |
| Cons: Requires maintaining an always-on host machine in India.                     |
+------------------------------------------------------------------------------------+
| Architecture C: Indian Authenticated Proxy / VPN                                   |
| Cloud GitHub runner routes exchange requests through an Indian proxy.              |
| Pros: Uses standard GitHub Actions runners.                                        |
| Cons: Requires maintaining proxy egress IP and credential secrets.                 |
+------------------------------------------------------------------------------------+
| Architecture D: Dedicated Market API Gateway (Future Intraday Expansion)           |
| Dedicated backend service in India queries exchange/MCP, stores snapshots in Redis |
| and serves a public REST / SSE API (/api/v1/quotes) to the frontend.              |
| Pros: Enables live intraday polling without bundling full universe in JS.          |
| Cons: Requires production server hosting, Redis database, and operational monitoring|
+------------------------------------------------------------------------------------+
```

---

## 9. Audit Summary & Recommendations

1. **Current Pipeline is Solid for EOD:** The existing approach—compiling official EOD Bhavcopy CSVs (4,965 stocks) plus targeted MCP metrics (VIX, 52W high, verified cap) into `js/stocks-data.js`—is the most reliable, zero-cost, and robust architecture for an end-of-day intelligence platform.
2. **Do Not Attempt Client-Side MCP:** The frontend should remain a pure static application reading compiled datasets.
3. **Automation Path Forward:** To automate the daily Bhavcopy update without geofencing blocks, configure a self-hosted Indian GitHub runner (Architecture B).

*End of Phase 3.0 Audit Report.*

