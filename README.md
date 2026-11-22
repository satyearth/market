# Machii Bazzar 📈

> **High-Performance End-of-Day (EOD) Indian Equities Intelligence & Market Screener**  
> Covering **5,389 verified NSE and BSE listed companies** across Mainboard and SME platforms with zero data fabrication, sub-second search, and an editorial dark ink design system.

[![Status](https://img.shields.io/badge/status-active-success.svg?style=flat-square)](#)
[![Deployment](https://img.shields.io/badge/deployment-vercel-black.svg?style=flat-square&logo=vercel)](#)
[![Coverage](https://img.shields.io/badge/coverage-5%2C389%20Securities-sienna.svg?style=flat-square)](#)
[![Exchanges](https://img.shields.io/badge/exchanges-NSE%20%7C%20BSE-1a8a4a.svg?style=flat-square)](#)
[![Market%20Cap%20Coverage](https://img.shields.io/badge/market%20cap-99.7%25%20verified-blue.svg?style=flat-square)](#)

---

## 🏛️ Overview

**Machii Bazzar** is a modern, privacy-focused financial web application providing institutional-grade end-of-day equity data for the complete Indian stock market. Built with performance and typographic craftsmanship at its core, it eliminates bloated JavaScript frameworks in favor of ultra-lean vanilla web technologies, serving lightning-fast market insights with a distinctive editorial financial aesthetic.

---

## ✨ Key Capabilities

### 🔍 Instant Multi-Key Search & Screener
- **Zero-Latency Filtering:** Search instantaneously across **Ticker Symbol**, **Company Legal Name**, **12-character ISIN**, and **BSE Security Code**.
- **Infinite Virtualized Scroll:** Smooth, lag-free browsing through all 5,300+ equities with automatic infinite batching.
- **Dynamic Sorting:** Instant client-side and serverless sorting by Market Capitalization, Current Price, 24h Change (%), Volume, and Alphabetical Order.

### 🏷️ 12 Sector Filter Pills & High Volume Screener
- **Sector Filtering:** One-click segmentation across 12 primary sectors:
  - Financials, Information Technology, Healthcare, Automobile, FMCG, Capital Goods, Power, Metals & Mining, Chemicals, Realty, Telecom, and Oil & Gas.
- **Volume Spike Detection:** Dedicated `HIGH VOLUME` pill highlights institutional activity (`volume_ratio >= 1.8x` relative to 10-day averages).
- **Exchange Isolation:** Instant toggle between NSE-listed, BSE-listed, and Dual-listed universes.

### 📑 Comprehensive Stock Profile Pages (`stock.html?isin=...`)
- **Today's Trading Card:** Live visual representation of **Open**, **High**, **Low**, and **Close (OHLC)** metrics with an intraday price bar and traded volume tracking.
- **Fundamental Ratios:** Key enterprise metrics including **P/E Ratio**, **P/B Ratio**, **ROCE**, and **Debt-to-Equity** (dynamically hidden when metrics are unverified to prevent misleading data).
- **52-Week Range Visualizer:** Visual pinned marker showcasing where the current price stands relative to 52-week highs and lows.
- **Historical Price Archive:** Multi-session historical price table with percentage change calculations across the last 6 trading sessions.
- **Dual-Exchange Mapping:** Complete ticker resolution, series tags (EQ, BE, SM, ST), and exchange routing links.

### ⭐ Local Watchlist & Personalization
- **Client-Side Persistence:** Add/remove securities to your personal watchlist with 1-click star icons, saved locally via `localStorage` with zero server tracking or sign-up walls.
- **Watchlist Quick Filter:** Instant `WATCHLIST` pill to filter the entire screener to your monitored stocks in real time.

### ⚡ Analyst Productivity
- **One-Click CSV Export:** Export currently active filtered, searched, and sorted datasets directly into CSV for spreadsheet modeling.
- **Density Toggle:** Switch between a comfortable editorial layout and a compact high-density spreadsheet view.
- **Power Keyboard Shortcuts:**
  - <kbd>/</kbd> — Focus universal search bar
  - <kbd>Esc</kbd> — Clear search and reset focus
  - <kbd>Alt</kbd> + <kbd>D</kbd> — Toggle table row density
  - <kbd>Alt</kbd> + <kbd>E</kbd> — Export visible dataset to CSV
  - <kbd>Alt</kbd> + <kbd>W</kbd> — Jump to Watchlist filter

---

## 📊 Market Universe & Mathematical Reconciliation

Machii Bazzar guarantees **100% mathematical reconciliation** against official exchange Bhavcopies:

| Metric | Classification | Count | Verification Rule |
|---|---|---|---|
| **Total Universe** | Unique ISINs | **5,389** | Zero duplicate ISINs across universe |
| **Dual-Listed** | NSE + BSE | **2,504** | Synchronized across both exchange books |
| **NSE Exclusive** | NSE Only | **687** | Official NSE CM Unified Bhavcopy |
| **BSE Exclusive** | BSE Only | **2,198** | Official BSE CM Unified Bhavcopy |
| **Mainboard** | Standard Equities | **4,343** | Large, Mid, and Small Cap Mainboard |
| **SME Platform** | NSE Emerge / BSE SME | **1,046** | High-growth SME enterprise equities |
| **Market Cap Coverage** | Verified Cap Ranks | **5,375** (99.7%) | Only verified figures shown; unverified render as em-dash |

---

## 🎨 Editorial Design System

Machii Bazzar uses a bespoke **Dark Ink** design system engineered specifically for financial legibility and extended reading sessions:

```
Canvas Background   : #171614   (Deep warm black / dark ink well)
Card Surface        : #1c1b18   (Subtle raised slate card)
Primary Accent      : #c84b31   (Warm terracotta sienna)
Bullish / Gainers   : #1a8a4a   (Deep emerald green)
Bearish / Losers    : #c42b2b   (Crisp carmine red)
Typography          : Fraunces (Editorial Display Serif) + Instrument Sans (Technical UI)
```

- **Zero SVG Rendering Overhead:** Clean, pure HTML/CSS UI components ensure lightning-fast rendering without memory spikes.
- **Smart Monograms & Fallbacks:** High-resolution company monograms paired with an algorithmic multi-tier logo manifest.

---

## ⚡ Technical Architecture

- **Hosted on Vercel:** Distributed globally via Vercel's high-speed Edge CDN.
- **Serverless API Endpoints:**
  - `GET /api/stocks` — Dynamic paginated, filtered, sorted, and searched stock queries with caching headers.
  - `GET /api/market/status` — Live session freshness, IST timestamps, and trading calendar synchronization.
  - `POST /api/market/refresh` — Concurrency-guarded stale-while-revalidate data refresh.
- **Zero Frontend Bundle:** Zero React/Vue/Angular dependencies. Sub-millisecond initial page hydration directly from vanilla HTML5 and ES6 modules.
- **Data Integrity Guarantee:** Zero synthetic or fabricated prices. If exchange data is missing or pending, it is faithfully displayed as an em-dash (`—`) rather than deceptive placeholder values.

---

<div align="center">
  <sub>Crafted for precision, speed, and analytical clarity. Machii Bazzar © 2026.</sub>
</div>