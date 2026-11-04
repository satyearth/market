# machli bazarr · Indian Market Intelligence Platform

A high-performance, real-time market screening and intelligence web application tracking 4,800+ NSE & BSE listed companies ranked by market capitalisation.

## Features

- **Ranked Universe**: Real-time ranking of Indian equities by market cap, sector, returns, and valuation.
- **Market Pulse**: Real-time India VIX, Market Breadth (Advancers vs Decliners), Near 52W High stats, and Market Cap segment breakdown.
- **Interactive Multi-Filter**: One-click filters for All Stocks, Top Gainers, Top Losers, Near 52W High, Volume Spikes, and New Listings.
- **Live Search**: Instant client-side search across ticker symbols, company names, sectors, and industries (Press `/` to focus).
- **Dynamic Sorting**: Multi-column sorting across Rank, Symbol, Price, Change %, Market Cap, 1W, 1M, 3M returns, and Volume.
- **Mini 7D Sparklines**: Dynamic vector SVG sparklines displaying 7-day trendlines.
- **AI Stock Intelligence (✦)**: Interactive insights modal with valuation multiples, return breakdown, and automated commentary.
- **Watchlist Integration**: Local storage powered bookmarking and watchlist management.
- **Dark Luxury Aesthetic**: Fine-tuned warm dark typography powered by Google Fonts *Fraunces* and *Instrument Sans*.

## Getting Started

Open `index.html` directly in any modern browser, or serve it with any local HTTP server:

```bash
# Using Python
python -m http.server 3000

# Using Node / npx
npx serve .
```

## Structure

```
├── index.html            # Main application interface
├── css/
│   └── style.css         # Complete design system & Tailwind styling
├── js/
│   ├── stocks-data.js    # Stock market dataset & real-time snapshot metrics
│   └── app.js            # Core interactive application logic
└── assets/
    └── logos/            # High-resolution stock brand logos
```
