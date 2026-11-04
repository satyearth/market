# Machli Bazzar · Indian Market Intelligence Platform

A high-performance stock screening and intelligence platform tracking 4,800+ NSE & BSE listed companies ranked by market capitalisation.

## Features

- **Ranked Universe**: Real-time ranking of Indian equities by market cap, sector, returns, and valuation.
- **Market Pulse**: Real-time India VIX, Market Breadth (Advancers vs Decliners), Near 52W High stats, and Market Cap segment breakdown.
- **Stock Filters**: Focused filters for All Stocks, Top Gainers, Top Losers, and Near 52W High.
- **Live Search**: Instant client-side search across ticker symbols, company names, sectors, and industries (Press `/` to focus).
- **Dynamic Multi-Column Sorting**: Sort across Rank, Stock, Price, Change %, Market Cap, 1W, 1M, 3M returns, and Volume.
- **Mini 7D Sparklines**: Vector SVG sparklines displaying 7-day trendlines.
- **AI Stock Intelligence (✦)**: Interactive insights modal with valuation multiples, return breakdown, and automated commentary.
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
│   ├── stocks-data.js    # Stock market dataset & snapshot metrics
│   └── app.js            # Core interactive application logic
└── assets/
    └── logos/            # High-resolution stock brand logos
```
