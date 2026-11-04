/* machli bazarr - Client Application Logic */

(function () {
  'use strict';

  // State
  let currentStocks = [...STOCKS_DATA];
  let filteredStocks = [...STOCKS_DATA];
  let currentPage = 1;
  const pageSize = 50;
  let activeFilter = 'ALL';
  let sortColumn = 'market_cap_cr';
  let sortDirection = 'desc'; // 'asc' or 'desc'
  let searchQuery = '';
  let isDense = false;
  let searchDebounceTimer = null;

  // Verified known logos present in assets/logos/ to prevent 404 network requests
  const KNOWN_LOGOS = new Set([
    'ADANIENT', 'ADANIGREEN', 'ADANIPORTS', 'ADANIPOWER', 'ASIANPAINT',
    'AXISBANK', 'BAJAJ-AUTO', 'BAJAJFINSV', 'BAJFINANCE', 'BEL',
    'BHARTIARTL', 'COALINDIA', 'DIVISLAB', 'DMART', 'EICHERMOT',
    'ETERNAL', 'GRASIM', 'HAL', 'HCLTECH', 'HDFCBANK',
    'HINDALCO', 'HINDUNILVR', 'HINDZINC', 'ICICIBANK', 'INDIGO',
    'INFY', 'IOC', 'ITC', 'JSWSTEEL', 'KOTAKBANK',
    'LICI', 'LT', 'M&M', 'MARUTI', 'NESTLEIND',
    'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBIN',
    'SHRIRAMFIN', 'SOLARINDS', 'SUNPHARMA', 'TATASTEEL', 'TCS',
    'TITAN', 'TVSMOTOR', 'ULTRACEMCO', 'WIPRO'
  ]);

  // DOM Elements
  const tbody = document.getElementById('stocks-tbody');
  const searchInput = document.querySelector('input[data-stocks-search="true"]');
  const showingText = document.getElementById('showing-status');
  const paginationControls = document.getElementById('pagination-controls');
  const filterButtons = document.querySelectorAll('.filter-pill-btn');
  const densityToggleBtn = document.getElementById('density-toggle-btn');
  const aiModal = document.getElementById('ai-modal');
  const aiModalContent = document.getElementById('ai-modal-content');
  const aiModalClose = document.getElementById('ai-modal-close');

  // Security Helper: HTML Entity Escaping against XSS
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Formatters
  function formatCurrency(val) {
    if (val == null) return '—';
    const num = Number(val);
    const parts = num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).split('.');
    return `₹${parts[0]}<span class="opacity-45 font-[inherit]">.${parts[1]}</span>`;
  }

  function formatMarketCap(cr) {
    if (!cr) return '—';
    const val = Number(cr);
    if (val >= 100000) {
      return `₹${(val / 100000).toFixed(1)}L Cr`;
    } else if (val >= 1000) {
      return `₹${(val / 1000).toFixed(1)}k Cr`;
    }
    return `₹${Math.round(val).toLocaleString('en-IN')} Cr`;
  }

  function formatPercent(pct, showPlus = true) {
    if (pct == null) return '—';
    const num = Number(pct);
    const prefix = num > 0 ? (showPlus ? '+' : '') : '';
    return `${prefix}${num.toFixed(2)}%`;
  }

  function getReturnColorClass(pct) {
    if (pct == null || pct === 0) return 'text-ink-muted';
    return pct > 0 ? 'text-ink-bullish' : 'text-ink-bearish';
  }

  function getReturnBgStyle(pct) {
    if (pct == null || pct === 0) return '';
    const abs = Math.min(Math.abs(pct), 20);
    const opacity = (abs / 20) * 0.12 + 0.04;
    return pct > 0
      ? `background-color: rgba(26, 138, 74, ${opacity.toFixed(3)});`
      : `background-color: rgba(196, 43, 43, ${opacity.toFixed(3)});`;
  }

  // Logo rendering with zero 404 network errors
  function getLogoHtml(stock, size = 'sm') {
    const symbol = stock.symbol || '';
    const hasImage = Boolean(stock.symbol && KNOWN_LOGOS.has(stock.symbol));
    const logoSrc = `./assets/logos/${escapeHtml(symbol)}.png`;
    const initials = escapeHtml((symbol || 'ST').slice(0, 2).toUpperCase());

    if (size === 'lg') {
      if (hasImage) {
        return `
          <div class="w-11 h-11 rounded-lg border border-ink-rule bg-ink-paper p-1 flex items-center justify-center flex-shrink-0">
            <img src="${logoSrc}" alt="${escapeHtml(stock.company_name)} logo" class="max-h-full max-w-full object-contain" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'" />
            <span style="display:none" class="items-center justify-center font-bold text-xs text-ink-muted uppercase">${initials}</span>
          </div>`;
      }
      return `
        <div class="w-11 h-11 rounded-lg border border-ink-rule bg-ink-paper p-1 flex items-center justify-center font-bold text-ink-muted text-xs uppercase flex-shrink-0">
          ${initials}
        </div>`;
    }

    if (hasImage) {
      return `
        <span class="stock-logo-wrap inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-rule bg-ink-paper text-ink-muted font-ui font-semibold h-6 w-6 text-[10px]">
          <img src="${logoSrc}" alt="${escapeHtml(stock.company_name)} logo" class="block h-full w-full object-contain" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'" />
          <span style="display:none" class="items-center justify-center font-bold text-[9px] text-ink-muted uppercase">${initials}</span>
        </span>`;
    }
    return `
      <span class="stock-logo-wrap inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-rule bg-ink-inset text-ink-muted font-ui font-semibold h-6 w-6 text-[9px] uppercase">
        ${initials}
      </span>`;
  }

  // Exchange badges helper for NSE, BSE and SME
  function getExchangeBadgesHtml(stock, isModal = false) {
    const badges = [];
    const exchanges = stock.exchanges || [];
    const isDual = exchanges.includes('NSE') && exchanges.includes('BSE');
    const isNseOnly = exchanges.includes('NSE') && !exchanges.includes('BSE');
    const isBseOnly = exchanges.includes('BSE') && !exchanges.includes('NSE');
    const isSme = stock.segment === 'SME';

    const pillClass = isModal
      ? 'px-1.5 py-0.5 rounded text-[10px] font-mono font-bold leading-none'
      : 'px-1 py-0.5 rounded text-[8.5px] font-mono font-medium leading-none';

    if (isDual) {
      badges.push(`<span class="${pillClass} bg-ink-inset text-ink-muted border border-ink-rule" title="Listed on NSE and BSE">NSE</span>`);
      badges.push(`<span class="${pillClass} bg-ink-inset text-ink-muted border border-ink-rule" title="Listed on NSE and BSE">BSE</span>`);
    } else if (isNseOnly) {
      badges.push(`<span class="${pillClass} bg-ink-inset text-ink-muted border border-ink-rule" title="NSE Listed Only">NSE</span>`);
    } else if (isBseOnly) {
      badges.push(`<span class="${pillClass} bg-ink-inset text-ink-muted border border-ink-rule" title="BSE Listed Only (Scrip: ${escapeHtml(stock.bse_scrip_code || '—')})">BSE</span>`);
    }

    if (isSme) {
      badges.push(`<span class="${pillClass} bg-ink-sienna-muted text-ink-sienna border border-ink-sienna/30" title="SME Platform Security">SME</span>`);
    }

    return `<div class="inline-flex items-center gap-1">${badges.join('')}</div>`;
  }

  // Dynamic Market Pulse Cards Rendering
  function renderMarketPulse() {
    if (typeof MARKET_STATS === 'undefined' || !MARKET_STATS) return;

    // Header Market Status Badge
    const badge = document.getElementById('market-status-badge');
    if (badge && MARKET_STATS.stockCount) {
      const dt = MARKET_STATS.tradingDate || '2026-11-04';
      const istInfo = MARKET_STATS.istDisplayTime ? ` · <span class="text-ink-muted text-[11px] font-normal">Refreshed ${escapeHtml(MARKET_STATS.istDisplayTime)}</span>` : '';
      badge.innerHTML = `Market closed · EOD (${dt})${istInfo} · <span class="tabular-nums text-ink-text font-bold">${MARKET_STATS.stockCount.toLocaleString('en-IN')}</span> listed companies (NSE + BSE)`;
    }

    // Card 1: Verified Market Cap (Explicit partial coverage note)
    const mcapEl = document.getElementById('card-total-mcap');
    const mcapSub = document.getElementById('card-mcap-sub');
    if (mcapEl) {
      if (MARKET_STATS.verifiedMarketCapCr) {
        mcapEl.innerHTML = formatMarketCap(MARKET_STATS.verifiedMarketCapCr);
        if (mcapSub) {
          mcapSub.innerText = MARKET_STATS.marketCapCoverageNote || 'Top 343 Equities (NSE + BSE)';
        }
      } else {
        mcapEl.innerText = '—';
      }
    }

    // Card 2: India VIX
    const vixVal = document.getElementById('card-vix-val');
    const vixChg = document.getElementById('card-vix-chg');
    const vixSub = document.getElementById('card-vix-sub');
    if (vixVal) {
      if (MARKET_STATS.vix != null) {
        vixVal.innerText = Number(MARKET_STATS.vix).toFixed(2);
        if (vixChg && MARKET_STATS.vixChangePct != null) {
          const isPos = MARKET_STATS.vixChangePct > 0;
          vixChg.className = `font-mono text-[12px] font-semibold tabular-nums ${isPos ? 'text-ink-bearish' : 'text-ink-bullish'}`;
          vixChg.innerText = formatPercent(MARKET_STATS.vixChangePct);
        }
        if (vixSub && MARKET_STATS.vixDate) {
          vixSub.innerText = `Volatility index · ${MARKET_STATS.vixDate}`;
        }
      } else {
        vixVal.innerText = '—';
        if (vixChg) vixChg.innerText = '—';
      }
    }

    // Card 3: Market Breadth
    const breadthBar = document.getElementById('card-breadth-bar');
    const breadthFill = document.getElementById('card-breadth-fill');
    const breadthInd = document.getElementById('card-breadth-indicator');
    const breadthAdv = document.getElementById('card-breadth-adv');
    const breadthDec = document.getElementById('card-breadth-dec');
    const breadthSub = document.getElementById('card-breadth-sub');
    if (MARKET_STATS.advances != null && MARKET_STATS.declines != null) {
      const adv = MARKET_STATS.advances;
      const dec = MARKET_STATS.declines;
      const unc = MARKET_STATS.unchanged || 0;
      const unp = (MARKET_STATS.marketBreadth && MARKET_STATS.marketBreadth.unpriced) || 0;
      const total = adv + dec + unc;
      const pct = total > 0 ? (adv / total) * 100 : 50;

      if (breadthAdv) breadthAdv.innerText = `${adv.toLocaleString('en-IN')} ▴`;
      if (breadthDec) breadthDec.innerText = `${dec.toLocaleString('en-IN')} ▾`;
      if (breadthFill) breadthFill.style.width = `${pct.toFixed(1)}%`;
      if (breadthInd) breadthInd.style.left = `${pct.toFixed(1)}%`;
      if (breadthBar) breadthBar.setAttribute('aria-label', `${adv} advancing, ${dec} declining, ${unc} unchanged`);
      if (breadthSub) {
        const adRatio = MARKET_STATS.adRatio || (dec > 0 ? (adv / dec).toFixed(2) : '—');
        breadthSub.innerText = `A/D: ${adRatio} · ${unc} Unch · ${unp} Unpriced`;
      }
    }

    // Card 4: Near 52W High (Guarded with session verification and accurate coverage labeling)
    const nearPct = document.getElementById('card-near52-pct');
    const nearSub = document.getElementById('card-near52-sub');
    if (nearPct) {
      if (MARKET_STATS.near52WeekHighCount != null) {
        nearPct.innerText = String(MARKET_STATS.near52WeekHighCount);
        if (nearSub) {
          const tradingDate = MARKET_STATS.tradingDate || '2026-11-04';
          nearSub.innerHTML = `${MARKET_STATS.near52WeekHighCount.toLocaleString('en-IN')} verified BSE Group A/B equities<span class="block text-[10px] text-ink-faint">BSE MCP (${tradingDate})</span>`;
          nearSub.title = `Surveyed BSE Groups A & B (40 matched equities, ${MARKET_STATS.near52WeekHighCount} within 8% of 52W high). NSE-only and other BSE groups not included.`;
        }
      } else {
        nearPct.innerText = '—';
        if (nearSub) {
          nearSub.innerHTML = 'Session data unavailable<span class="block text-[10px] text-ink-faint">BSE MCP offline</span>';
          nearSub.title = '52-week high data unavailable from BSE MCP for this session.';
        }
      }
    }

    // Card 5: Verified Cap Ranks
    if (MARKET_STATS.verifiedRankingSegments || MARKET_STATS.capSegments) {
      const segs = MARKET_STATS.verifiedRankingSegments || {};
      const t100 = segs.top100 != null ? segs.top100 : (MARKET_STATS.capSegments ? MARKET_STATS.capSegments.large || 0 : 0);
      const r101_250 = segs.rank101_250 != null ? segs.rank101_250 : (MARKET_STATS.capSegments ? MARKET_STATS.capSegments.mid || 0 : 0);
      const rem = segs.remainingVerified != null ? segs.remainingVerified : (MARKET_STATS.capSegments ? MARKET_STATS.capSegments.small || 0 : 0);
      const unranked = segs.unranked != null ? segs.unranked : 3758;
      const sme = segs.smePlatform != null ? segs.smePlatform : (MARKET_STATS.capSegments ? MARKET_STATS.capSegments.sme || 0 : 0);
      const maxVal = Math.max(t100, r101_250, rem, unranked, sme, 1);

      const setSeg = (key, val) => {
        const cntEl = document.getElementById(`card-seg-cnt-${key}`);
        const barEl = document.getElementById(`card-seg-bar-${key}`);
        if (cntEl) cntEl.innerText = val > 0 ? val.toLocaleString('en-IN') : '—';
        if (barEl) barEl.style.height = `${Math.min(100, Math.max(6, (val / maxVal) * 100)).toFixed(0)}%`;
      };

      setSeg('lrg', t100);
      setSeg('mid', r101_250);
      setSeg('sml', rem);
      setSeg('mic', unranked);
      setSeg('sme', sme);
    }
  }

  // Generate genuine 7-day sparkline SVG from actual chronological historical prices
  function createSparklineSvg(stock) {
    let prices = stock.sparkline_7d;
    if ((!prices || !Array.isArray(prices) || prices.length < 2) && stock.historical_prices && Array.isArray(stock.historical_prices)) {
      prices = stock.historical_prices.map(p => typeof p === 'object' && p !== null ? p.close : p);
    }
    if (!prices || !Array.isArray(prices) || prices.length < 2) {
      return `<span class="text-ink-muted text-[11px] flex justify-center">—</span>`;
    }

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const isPositive = last >= first;
    const color = isPositive ? '#1a8a4a' : '#c42b2b';
    const fill = isPositive ? 'rgba(26, 138, 74, 0.1)' : 'rgba(196, 43, 43, 0.1)';

    const w = 60;
    const h = 24;
    const padTop = 3;
    const padBottom = 3;
    const drawH = h - padTop - padBottom;

    const points = prices.map((p, i) => {
      const x = ((i / (prices.length - 1)) * w).toFixed(1);
      const y = max === min
        ? (h / 2).toFixed(1)
        : (h - padBottom - ((p - min) / (max - min)) * drawH).toFixed(1);
      return `${x},${y}`;
    }).join(' ');

    const fillPoints = `0,${h} ${points} ${w},${h}`;

    return `
      <svg class="w-[60px] h-[22px] overflow-visible" viewBox="0 0 60 24" title="1W: ₹${first} → ₹${last}">
        <polygon points="${fillPoints}" fill="${fill}" />
        <polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
      </svg>
    `;
  }

  // Generate genuine 6-session chronological price chart for Stock Details Modal
  function createModalHistoricalChart(stock) {
    const history = stock.historical_prices;
    if (!history || !Array.isArray(history) || history.length < 2) {
      return `
        <div class="border border-ink-rule rounded-xl p-4 mb-3.5 bg-ink-paper">
          <div class="flex items-center justify-between mb-2">
            <span class="text-[11px] font-bold uppercase tracking-wider text-ink-muted">Historical Daily Trend</span>
            <span class="text-[10px] font-mono text-ink-faint">6 Consecutive Sessions</span>
          </div>
          <div class="py-6 text-center text-xs text-ink-muted">
            Historical daily session closes are not available for this newly listed or inactive security.
          </div>
        </div>
      `;
    }

    const prices = history.map(h => typeof h === 'object' && h !== null ? h.close : h);
    const dates = history.map(h => typeof h === 'object' && h !== null ? h.date : '');
    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const isPositive = last >= first;
    const strokeColor = isPositive ? '#1a8a4a' : '#c42b2b';
    const fillColor = isPositive ? 'rgba(26, 138, 74, 0.12)' : 'rgba(196, 43, 43, 0.12)';

    const w = 460;
    const h = 110;
    const padTop = 18;
    const padBottom = 22;
    const padLeft = 24;
    const padRight = 24;
    const drawW = w - padLeft - padRight;
    const drawH = h - padTop - padBottom;

    const coords = prices.map((p, i) => {
      const x = (padLeft + (i / (prices.length - 1)) * drawW).toFixed(1);
      const y = max === min
        ? (h / 2).toFixed(1)
        : (padTop + ((max - p) / (max - min)) * drawH).toFixed(1);
      return { x, y, price: p, date: dates[i] };
    });

    const pointsStr = coords.map(c => `${c.x},${c.y}`).join(' ');
    const fillStr = `${coords[0].x},${h - padBottom} ${pointsStr} ${coords[coords.length - 1].x},${h - padBottom}`;

    // SVG Points and Labels
    const markers = coords.map((c, i) => {
      const displayDt = c.date ? c.date.slice(5) : `S${i + 1}`;
      const showPriceLabel = i === 0 || i === coords.length - 1 || c.price === max || c.price === min;
      const labelY = Number(c.y) < 32 ? Number(c.y) + 12 : Number(c.y) - 6;
      return `
        <g class="chart-point-group">
          <circle cx="${c.x}" cy="${c.y}" r="3.5" fill="${strokeColor}" stroke="#171614" stroke-width="1.5" />
          ${showPriceLabel ? `<text x="${c.x}" y="${labelY}" fill="#d1cfc7" font-size="9" font-family="monospace" text-anchor="middle" font-weight="600">₹${c.price.toLocaleString('en-IN')}</text>` : ''}
          <text x="${c.x}" y="${h - 4}" fill="#78756d" font-size="8.5" font-family="monospace" text-anchor="middle">${displayDt}</text>
        </g>
      `;
    }).join('');

    const ret1wStr = stock.return_1w != null
      ? `${stock.return_1w > 0 ? '+' : ''}${stock.return_1w.toFixed(2)}%`
      : '—';

    return `
      <div class="border border-ink-rule rounded-xl p-3.5 mb-3.5 bg-ink-paper">
        <div class="flex items-center justify-between mb-1.5">
          <div>
            <span class="text-[11px] font-bold uppercase tracking-wider text-ink-muted">Historical Daily Trend (${history.length} Sessions)</span>
            <span class="text-[10px] text-ink-faint block mt-0.5">${dates[0]} → ${dates[dates.length - 1]}</span>
          </div>
          <div class="text-right">
            <span class="font-mono text-xs font-semibold ${isPositive ? 'text-ink-bullish' : 'text-ink-bearish'}">${ret1wStr}</span>
            <span class="text-[10px] text-ink-muted block">1W Session Return</span>
          </div>
        </div>
        <div class="w-full overflow-hidden flex justify-center pt-1">
          <svg class="w-full max-w-[480px] h-[110px] overflow-visible" viewBox="0 0 460 110">
            <!-- Grid baseline -->
            <line x1="${padLeft}" y1="${h - padBottom}" x2="${w - padRight}" y2="${h - padBottom}" stroke="rgba(255,255,255,0.06)" stroke-width="1" />
            <!-- Area fill -->
            <polygon points="${fillStr}" fill="${fillColor}" />
            <!-- Line path -->
            <polyline fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pointsStr}" />
            <!-- Data markers and date labels -->
            ${markers}
          </svg>
        </div>
      </div>
    `;
  }

  // Filter & Search Logic
  function applyFilters() {
    let result = [...STOCKS_DATA];

    // Filter pill (Reconciled with Advances / Declines breadth)
    if (activeFilter === 'TOP GAINERS') {
      result = result.filter(s => s.change_percent > 0 || (s.prev_close != null && s.current_price > s.prev_close)).sort((a, b) => b.change_percent - a.change_percent);
    } else if (activeFilter === 'TOP LOSERS') {
      result = result.filter(s => s.change_percent < 0 || (s.prev_close != null && s.current_price < s.prev_close)).sort((a, b) => a.change_percent - b.change_percent);
    } else if (activeFilter === 'NEAR 52W HIGH') {
      result = result.filter(s => s.is_near_high || (s.pct_from_high && Number(s.pct_from_high) >= -8));
    }

    // Known Brand-to-Listed Entity resolution map (maps popular consumer brands to their official exchange-listed parent entities without inventing fake tickers)
    const BRAND_ENTITY_MAP = {
      'zomato': 'ETERNAL',
      'blinkit': 'ETERNAL',
      'policybazaar': 'POLICYBZR',
      'paisabazaar': 'POLICYBZR',
      'maggi': 'NESTLEIND',
      'jlr': 'TATAMOTORS',
      'jaguar': 'TATAMOTORS'
    };

    // Search query (legal company name, trading symbol, NSE symbol, BSE scrip code, ISIN, sector, industry)
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      const qNorm = q.replace(/[^a-z0-9]/g, '');
      const aliasSym = BRAND_ENTITY_MAP[q] || BRAND_ENTITY_MAP[qNorm];
      result = result.filter(s =>
        (aliasSym && (s.symbol === aliasSym || s.nse_symbol === aliasSym)) ||
        (s.symbol && s.symbol.toLowerCase().includes(q)) ||
        (s.company_name && s.company_name.toLowerCase().includes(q)) ||
        (s.nse_symbol && s.nse_symbol.toLowerCase().includes(q)) ||
        (s.bse_scrip_code && s.bse_scrip_code.toLowerCase().includes(q)) ||
        (s.isin && s.isin.toLowerCase().includes(q)) ||
        (s.sector && s.sector.toLowerCase().includes(q)) ||
        (s.industry && s.industry.toLowerCase().includes(q)) ||
        (qNorm.length >= 2 && (
          (s.symbol && s.symbol.toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm)) ||
          (s.company_name && s.company_name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm)) ||
          (s.nse_symbol && s.nse_symbol.toLowerCase().replace(/[^a-z0-9]/g, '').includes(qNorm))
        ))
      );
    }

    // Sorting (if not overridden by filter)
    if (activeFilter === 'ALL' || activeFilter === 'NEAR 52W HIGH') {
      result.sort((a, b) => {
        let valA = a[sortColumn];
        let valB = b[sortColumn];

        if (valA == null) return 1;
        if (valB == null) return -1;

        if (typeof valA === 'string') {
          return sortDirection === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
        }
        return sortDirection === 'asc' ? valA - valB : valB - valA;
      });
    }

    filteredStocks = result;
    currentPage = 1;
    renderTable();
  }

  // Render Table
  function renderTable() {
    if (!tbody) return;

    const total = filteredStocks.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (currentPage > totalPages) currentPage = totalPages;

    const startIdx = (currentPage - 1) * pageSize;
    const endIdx = Math.min(startIdx + pageSize, total);
    const pageRows = filteredStocks.slice(startIdx, endIdx);

    // Update Showing text
    if (showingText) {
      showingText.innerHTML = total > 0
        ? `Showing <span class="text-ink-ink font-medium">${startIdx + 1}–${endIdx}</span> of <span class="text-ink-ink font-medium">${total.toLocaleString('en-IN')}</span> stocks <span class="text-ink-faint">(of ${STOCKS_DATA.length.toLocaleString('en-IN')} total)</span>`
        : `No matching stocks found`;
    }

    // Render Pagination Controls
    renderPagination(totalPages);

    if (pageRows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="12" class="text-center py-12 text-ink-muted">
            <div class="font-display text-lg text-ink-ink mb-1">No stocks found</div>
            <p class="text-sm">Try searching for a different company or reset the filter.</p>
          </td>
        </tr>
      `;
      return;
    }

    const padY = isDense ? '4px' : '9px';

    tbody.innerHTML = pageRows.map((s, idx) => {
      const isChgPositive = (s.change_percent || 0) >= 0;
      const chgColor = isChgPositive ? 'text-ink-bullish' : 'text-ink-bearish';
      const chgArrow = isChgPositive ? '▴' : '▾';
      const volWidth = Math.min(100, Math.max(10, ((s.volume_ratio || 1) / 2.5) * 100));

      return `
        <tr data-row-isin="${escapeHtml(s.isin)}" class="group cursor-pointer border-b border-ink-rule transition-colors hover:bg-ink-well pulse-stocks-rise" style="animation-delay: ${idx * 15}ms">
          <td class="text-right text-[13px] text-ink-muted px-2 tabular-nums" style="padding-top:${padY};padding-bottom:${padY}">${s.rank != null ? s.rank : '—'}</td>
          
          <!-- Stock Info -->
          <td class="px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <div class="flex items-center gap-2.5 min-w-0 group/link">
              ${getLogoHtml(s, 'sm')}
              <div class="min-w-0">
                <div class="flex items-center gap-1.5 flex-wrap">
                  <span class="text-[14px] font-semibold text-ink-ink group-hover/link:text-ink-sienna transition-colors">${escapeHtml(s.symbol)}</span>
                  ${getExchangeBadgesHtml(s, false)}
                </div>
                <div class="text-[11px] text-ink-muted truncate max-w-[190px] md:max-w-[220px]" title="${escapeHtml(s.company_name)}">${escapeHtml(s.company_name)}</div>
              </div>
            </div>
          </td>

          <!-- Sector -->
          <td class="hidden lg:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <span class="inline-block max-w-[125px] truncate align-middle text-[9px] font-bold tracking-[0.12em] uppercase text-ink-muted bg-ink-inset px-1.5 py-0.5 rounded-[3px]" title="${escapeHtml(s.sector || 'GENERAL')}">${escapeHtml(s.sector || '—')}</span>
          </td>

          <!-- Price -->
          <td class="text-right text-[14px] text-ink-ink px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <span class="font-mono tabular-nums [letter-spacing:-0.02em]">${formatCurrency(s.current_price)}</span>
          </td>

          <!-- Change % -->
          <td class="text-right text-[12px] font-medium px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <span class="inline-flex items-baseline gap-1 font-mono tabular-nums [letter-spacing:-0.02em] ${chgColor} justify-end text-[12px]">
              <span aria-hidden="true">${chgArrow}</span>${formatPercent(s.change_percent)}
            </span>
          </td>

          <!-- Market Cap -->
          <td class="text-right text-[12px] text-ink-text tabular-nums px-2" style="padding-top:${padY};padding-bottom:${padY}">
            ${formatMarketCap(s.market_cap_cr)}
          </td>

          <!-- 1W Return (6 Sessions) -->
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 ${getReturnColorClass(s.return_1w)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_1w)}">
            ${formatPercent(s.return_1w)}
          </td>

          <!-- 1M Return (Em-dash: Multi-month archive unavailable) -->
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 text-ink-muted" style="padding-top:${padY};padding-bottom:${padY}">
            ${formatPercent(s.return_1m)}
          </td>

          <!-- 3M Return (Em-dash: Multi-month archive unavailable) -->
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 text-ink-muted" style="padding-top:${padY};padding-bottom:${padY}">
            ${formatPercent(s.return_3m)}
          </td>

          <!-- Volume Bar -->
          <td class="hidden xl:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <div class="w-[32px] h-[3.5px] bg-ink-inset rounded-full overflow-hidden relative" title="Volume: ${s.volume != null ? s.volume.toLocaleString('en-IN') : '—'} (${s.volume_ratio || 1.0}x avg)">
              <div class="h-full bg-ink-muted/80 rounded-full" style="width:${volWidth}%"></div>
            </div>
          </td>

          <!-- 7D Sparkline -->
          <td class="hidden xl:table-cell w-[64px] px-1" style="padding-top:${padY};padding-bottom:${padY}">
            ${createSparklineSvg(s)}
          </td>

          <!-- Action Button -->
          <td class="text-right px-1.5 whitespace-nowrap" style="padding-top:7px;padding-bottom:7px">
            <span class="inline-flex items-center gap-0.5 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 focus-within:opacity-100 focus-within:translate-x-0">
              <button class="ai-insight-btn w-6 h-6 flex items-center justify-center rounded-full text-[13px] text-ink-sienna hover:bg-ink-sienna-muted transition-colors" data-isin="${escapeHtml(s.isin)}" title="View intelligence and details for ${escapeHtml(s.symbol)}">
                ✦
              </button>
            </span>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Pagination Rendering
  function renderPagination(totalPages) {
    if (!paginationControls) return;

    let html = `
      <button ${currentPage === 1 ? 'disabled' : ''} class="page-prev-btn w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-muted hover:text-ink-sienna hover:bg-ink-well ${currentPage === 1 ? 'opacity-30 pointer-events-none' : ''}">‹</button>
    `;

    // Windowed pagination
    const getPageList = () => {
      if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, i) => i + 1);
      }
      const list = [1];
      let left = Math.max(2, currentPage - 1);
      let right = Math.min(totalPages - 1, currentPage + 1);

      if (currentPage <= 3) {
        left = 2;
        right = 4;
      } else if (currentPage >= totalPages - 2) {
        left = totalPages - 3;
        right = totalPages - 1;
      }

      if (left > 2) list.push('...');
      for (let p = left; p <= right; p++) {
        list.push(p);
      }
      if (right < totalPages - 1) list.push('...');
      list.push(totalPages);
      return list;
    };

    const pages = getPageList();
    pages.forEach(p => {
      if (p === '...') {
        html += `<span class="w-[24px] h-[28px] flex items-center justify-center text-[11px] text-ink-muted select-none">…</span>`;
      } else if (p === currentPage) {
        html += `
          <button class="w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-ink border border-ink-sienna bg-ink-sienna-muted font-bold">${p}</button>
        `;
      } else {
        html += `
          <button class="page-num-btn w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-muted hover:text-ink-sienna hover:bg-ink-well" data-page="${p}">${p}</button>
        `;
      }
    });

    html += `
      <button ${currentPage === totalPages ? 'disabled' : ''} class="page-next-btn w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-muted hover:text-ink-sienna hover:bg-ink-well ${currentPage === totalPages ? 'opacity-30 pointer-events-none' : ''}">›</button>
    `;

    paginationControls.innerHTML = html;

    // Attach pagination listeners
    paginationControls.querySelectorAll('.page-num-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage = Number(btn.getAttribute('data-page'));
        renderTable();
        window.scrollTo({ top: 380, behavior: 'smooth' });
      });
    });

    const prev = paginationControls.querySelector('.page-prev-btn');
    if (prev && currentPage > 1) {
      prev.addEventListener('click', () => {
        currentPage--;
        renderTable();
        window.scrollTo({ top: 380, behavior: 'smooth' });
      });
    }

    const next = paginationControls.querySelector('.page-next-btn');
    if (next && currentPage < totalPages) {
      next.addEventListener('click', () => {
        currentPage++;
        renderTable();
        window.scrollTo({ top: 380, behavior: 'smooth' });
      });
    }
  }

  // Open Stock Intelligence Modal (Keyed on ISIN to prevent collisions across duplicate symbols)
  function openStockModal(isin) {
    const stock = STOCKS_DATA.find(s => s.isin === isin);
    if (!stock || !aiModal || !aiModalContent) return;

    const isPos = (stock.change_percent || 0) >= 0;
    const chgClass = isPos ? 'text-ink-bullish' : 'text-ink-bearish';
    const chgArrow = isPos ? '▲' : '▼';

    aiModalContent.innerHTML = `
      <!-- Modal Header -->
      <div class="flex items-start justify-between pb-3.5 border-b border-ink-rule pr-8">
        <div class="flex items-center gap-3">
          ${getLogoHtml(stock, 'lg')}
          <div>
            <div class="flex items-center gap-2 flex-wrap">
              <h2 class="font-display text-xl font-bold text-ink-ink">${escapeHtml(stock.symbol)}</h2>
              ${getExchangeBadgesHtml(stock, true)}
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-ink-inset text-ink-muted uppercase">${escapeHtml(stock.sector || 'GENERAL')}</span>
            </div>
            <p class="text-xs text-ink-muted mt-0.5 max-w-[340px] truncate" title="${escapeHtml(stock.company_name)}">${escapeHtml(stock.company_name)}</p>
          </div>
        </div>
        <div class="text-right flex-shrink-0">
          <div class="font-mono text-lg font-bold text-ink-ink">${formatCurrency(stock.current_price)}</div>
          <div class="font-mono text-xs font-semibold ${chgClass}">${chgArrow} ${formatPercent(stock.change_percent)}</div>
          <div class="font-mono text-[10px] text-ink-muted mt-0.5">Prev: ${stock.prev_close != null ? '₹' + Number(stock.prev_close).toFixed(2) : '—'}</div>
        </div>
      </div>

      <!-- Security Identifiers Strip -->
      <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 py-2.5 px-3 my-3 bg-ink-inset rounded-lg border border-ink-rule/60 text-[11px] font-mono">
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">ISIN</span>
          <span class="text-ink-ink select-all font-semibold">${escapeHtml(stock.isin)}</span>
        </div>
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">BSE Scrip Code</span>
          <span class="text-ink-ink select-all font-semibold">${escapeHtml(stock.bse_scrip_code || '—')}</span>
        </div>
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">NSE Symbol</span>
          <span class="text-ink-ink select-all font-semibold">${escapeHtml(stock.nse_symbol || '—')}</span>
        </div>
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">Segment / Series</span>
          <span class="text-ink-ink font-semibold">${escapeHtml(stock.series ? stock.series + ' · ' : '')}${escapeHtml(stock.segment || 'Mainboard')}</span>
        </div>
      </div>

      <!-- Day EOD Range Strip -->
      <div class="grid grid-cols-3 gap-2 py-2 px-3 my-2.5 bg-ink-paper rounded-lg border border-ink-rule/50 text-[11px] font-mono">
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">Day Open</span>
          <span class="text-ink-ink font-semibold">${stock.open_price != null ? '₹' + Number(stock.open_price).toLocaleString('en-IN') : '—'}</span>
        </div>
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">Day High</span>
          <span class="text-ink-bullish font-semibold">${stock.high_price != null ? '₹' + Number(stock.high_price).toLocaleString('en-IN') : '—'}</span>
        </div>
        <div>
          <span class="text-[9px] uppercase tracking-wider text-ink-muted block">Day Low</span>
          <span class="text-ink-bearish font-semibold">${stock.low_price != null ? '₹' + Number(stock.low_price).toLocaleString('en-IN') : '—'}</span>
        </div>
      </div>

      <!-- Quick Metrics Grid -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 my-3">
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">Market Cap</span>
          <span class="font-mono text-sm font-semibold text-ink-ink block">${formatMarketCap(stock.market_cap_cr)}</span>
          <span class="text-[10px] text-ink-muted truncate block mt-0.5" title="${escapeHtml(stock.verified_rank_tier || 'Unranked')}">${stock.rank != null ? '#' + stock.rank + ' · ' + escapeHtml(stock.verified_rank_tier) : escapeHtml(stock.verified_rank_tier || 'Unranked')}</span>
        </div>
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">Traded Volume</span>
          <span class="font-mono text-sm font-semibold text-ink-ink block">${stock.volume != null ? stock.volume.toLocaleString('en-IN') : '—'}</span>
          <span class="text-[10px] text-ink-muted block mt-0.5">Ratio: ${stock.volume_ratio != null ? stock.volume_ratio + 'x avg' : '—'}</span>
        </div>
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">52W High / Low</span>
          <span class="font-mono text-xs font-semibold text-ink-ink block truncate">${stock.week52_high != null ? 'H: ₹' + stock.week52_high.toLocaleString('en-IN') : '—'}</span>
          <span class="font-mono text-[10px] text-ink-muted block truncate mt-0.5">${stock.week52_low != null ? 'L: ₹' + stock.week52_low.toLocaleString('en-IN') : '—'}</span>
        </div>
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">P/E Ratio</span>
          <span class="font-mono text-sm font-semibold text-ink-ink block">${stock.pe_ratio != null ? stock.pe_ratio : '—'}</span>
          <span class="text-[10px] text-ink-muted block mt-0.5">ROCE: ${stock.roce != null ? stock.roce + '%' : '—'}</span>
        </div>
      </div>

      <!-- Historical Price Chart (Section 5) -->
      ${createModalHistoricalChart(stock)}

      <!-- Multi-Period Performance Returns -->
      <div class="border border-ink-rule rounded-xl p-3 mb-3 bg-ink-well">
        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-bold uppercase tracking-wider text-ink-muted block">Multi-Period Performance Returns</span>
          <span class="text-[9px] font-mono text-ink-faint">EOD Bhavcopy Verified</span>
        </div>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="p-2 rounded bg-ink-paper border border-ink-rule/50">
            <span class="text-[9.5px] text-ink-muted block font-medium">1 Week (6D)</span>
            <span class="font-mono text-xs font-semibold ${getReturnColorClass(stock.return_1w)}">${formatPercent(stock.return_1w)}</span>
            <span class="text-[8px] text-ink-faint block mt-0.5">${stock.return_1w_session_start ? stock.return_1w_session_start.slice(5) + ' → ' + stock.return_1w_session_end.slice(5) : 'Verified'}</span>
          </div>
          <div class="p-2 rounded bg-ink-paper border border-ink-rule/50">
            <span class="text-[9.5px] text-ink-muted block font-medium">1 Month</span>
            <span class="font-mono text-xs font-semibold text-ink-muted">—</span>
            <span class="text-[8px] text-ink-faint block mt-0.5">Archive unavail.</span>
          </div>
          <div class="p-2 rounded bg-ink-paper border border-ink-rule/50">
            <span class="text-[9.5px] text-ink-muted block font-medium">3 Months</span>
            <span class="font-mono text-xs font-semibold text-ink-muted">—</span>
            <span class="text-[8px] text-ink-faint block mt-0.5">Archive unavail.</span>
          </div>
          <div class="p-2 rounded bg-ink-paper border border-ink-rule/50">
            <span class="text-[9.5px] text-ink-muted block font-medium">1 Year</span>
            <span class="font-mono text-xs font-semibold text-ink-muted">—</span>
            <span class="text-[8px] text-ink-faint block mt-0.5">Archive unavail.</span>
          </div>
        </div>
      </div>

      <!-- AI Analysis Summary -->
      <div class="bg-ink-paper border border-ink-rule rounded-xl p-3.5">
        <div class="flex items-center gap-1.5 text-ink-sienna text-xs font-bold uppercase tracking-wider mb-1.5">
          <span>✦</span>
          <span>machli bazarr Market Intelligence</span>
        </div>
        <p class="text-xs text-ink-text leading-relaxed">
          <strong>${escapeHtml(stock.symbol)}</strong> (${escapeHtml(stock.company_name)}) is currently positioned at 
          ${stock.rank != null ? `Rank #${stock.rank} (${escapeHtml(stock.verified_rank_tier)})` : escapeHtml(stock.verified_rank_tier || 'Unranked')} 
          in the Indian equity universe. Traded at <span class="font-mono font-bold text-ink-ink">${formatCurrency(stock.current_price)}</span> 
          with a 1-week return of <span class="${getReturnColorClass(stock.return_1w)} font-mono font-bold">${formatPercent(stock.return_1w)}</span> 
          and volume tracking at <span class="font-mono font-bold text-ink-ink">${stock.volume_ratio != null ? stock.volume_ratio + 'x' : '—'}</span> 
          average. The security is listed on <strong>${escapeHtml(stock.exchanges ? stock.exchanges.join(' and ') : 'NSE/BSE')}</strong> 
          under the <strong>${escapeHtml(stock.sector || stock.segment || 'General')}</strong> sector.
        </p>
      </div>
    `;

    aiModal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeAiModal() {
    if (!aiModal) return;
    aiModal.classList.add('hidden');
    document.body.style.overflow = '';
  }

  // Setup Event Listeners
  function setupEvents() {
    // Search input with debounce
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        const val = e.target.value;
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          searchQuery = val;
          applyFilters();
        }, 120);
      });
    }

    // Keyboard shortcut '/' to search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      } else if (e.key === 'Escape') {
        closeAiModal();
      }
    });

    // Filter pills
    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        filterButtons.forEach(b => {
          b.className = 'filter-pill-btn inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-[11px] py-[5px] font-ui text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150 border-ink-rule bg-ink-well text-ink-muted hover:-translate-y-px hover:border-ink-sienna hover:text-ink-sienna';
        });
        btn.className = 'filter-pill-btn inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-[11px] py-[5px] font-ui text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150 border-ink-sienna bg-ink-sienna-muted text-ink-sienna shadow-soft';

        activeFilter = btn.innerText.trim();
        applyFilters();
      });
    });

    // Density toggle
    if (densityToggleBtn) {
      densityToggleBtn.addEventListener('click', () => {
        isDense = !isDense;
        document.body.classList.toggle('dense-mode', isDense);
        densityToggleBtn.classList.toggle('border-ink-sienna', isDense);
        densityToggleBtn.classList.toggle('text-ink-sienna', isDense);
        renderTable();
      });
    }

    // Table Header Sorting
    const thMap = {
      '#': 'rank',
      'Stock': 'symbol',
      'Price': 'current_price',
      'Chg %': 'change_percent',
      'MCap': 'market_cap_cr',
      'MCap ▼': 'market_cap_cr',
      'MCap ▲': 'market_cap_cr',
      '1W': 'return_1w',
      '1M': 'return_1m',
      '3M': 'return_3m',
      'Vol': 'volume_ratio'
    };

    document.querySelectorAll('th[data-sortable="true"]').forEach(th => {
      th.addEventListener('click', () => {
        const headerText = th.getAttribute('data-col') || th.innerText.replace(/[▲▼]/g, '').trim();
        const colField = thMap[headerText] || headerText;

        if (sortColumn === colField) {
          sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
          sortColumn = colField;
          sortDirection = colField === 'symbol' || colField === 'rank' ? 'asc' : 'desc';
        }

        // Update indicators on all th
        document.querySelectorAll('th[data-sortable="true"]').forEach(h => {
          const baseName = h.getAttribute('data-col');
          h.innerHTML = baseName + ' ';
        });

        const arrow = sortDirection === 'asc' ? '▲' : '▼';
        const baseName = th.getAttribute('data-col');
        th.innerHTML = `${baseName} <span class="text-ink-sienna text-[9px]">${arrow}</span>`;

        applyFilters();
      });
    });

    // Event delegation on tbody for row clicks and AI insight button
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const btn = e.target.closest('.ai-insight-btn');
        if (btn) {
          e.stopPropagation();
          const isin = btn.getAttribute('data-isin');
          if (isin) openStockModal(isin);
          return;
        }

        const row = e.target.closest('tr[data-row-isin]');
        if (row) {
          if (e.target.closest('button') || e.target.closest('a')) return;
          const isin = row.getAttribute('data-row-isin');
          if (isin) openStockModal(isin);
        }
      });
    }

    // Modal Close
    if (aiModalClose) {
      aiModalClose.addEventListener('click', closeAiModal);
    }
    if (aiModal) {
      aiModal.addEventListener('click', (e) => {
        if (e.target === aiModal) closeAiModal();
      });
    }
  }

  // EOD Auto-Refresh Status Indicator & Lifecycle Management
  function updateSyncIndicator(state, message, timeText) {
    const indicator = document.getElementById('eod-sync-indicator');
    const dot = document.getElementById('eod-sync-dot');
    const textEl = document.getElementById('eod-sync-text');
    const timeEl = document.getElementById('eod-sync-time');

    if (!indicator || !dot || !textEl) return;

    // Reset animation classes
    dot.className = 'relative inline-block size-[7px] shrink-0 rounded-full';

    const defaultTime = (typeof MARKET_STATS !== 'undefined' && MARKET_STATS && MARKET_STATS.istDisplayTime)
      ? MARKET_STATS.istDisplayTime
      : '04 Nov 2026, 22:33 IST';

    switch (state) {
      case 'updating':
        dot.classList.add('bg-ink-sienna', 'animate-pulse');
        textEl.textContent = message || 'Updating market data...';
        if (timeEl) timeEl.textContent = '';
        break;

      case 'failed':
        dot.classList.add('bg-amber-500');
        textEl.textContent = message || 'Update failed — showing previous data';
        if (timeEl) timeEl.textContent = ` · ${timeText || defaultTime}`;
        break;

      case 'closed':
        dot.classList.add('bg-ink-muted');
        textEl.textContent = message || 'Market closed';
        if (timeEl) timeEl.textContent = ` · ${timeText || defaultTime}`;
        break;

      case 'latest':
      default:
        dot.classList.add('bg-emerald-500');
        textEl.textContent = message || 'Latest EOD data';
        if (timeEl) timeEl.textContent = ` · ${timeText || defaultTime}`;
        break;
    }
  }

  // Automatic EOD Data Refresh on Website Open
  async function checkEodAutoRefresh() {
    // Stale-while-revalidate initial display
    updateSyncIndicator('latest');

    // In static file mode (e.g. file:///), no backend HTTP server is available
    if (typeof window !== 'undefined' && (window.location.protocol === 'file:' || !window.location.host)) {
      return;
    }

    // Client-side cache: prevent repeated requests within 5 minutes
    const CACHE_KEY = 'mb_last_sync_check';
    const CACHE_TTL_MS = 5 * 60 * 1000;
    try {
      const lastCheck = Number(sessionStorage.getItem(CACHE_KEY) || 0);
      if (Date.now() - lastCheck < CACHE_TTL_MS) {
        return; // Cache valid, keep showing latest verified EOD data
      }
    } catch (_) {
      // Ignore storage access errors in restricted iframe/browser modes
    }

    // Attempt to query the backend EOD status API
    try {
      const res = await fetch('/api/market/status', {
        headers: { 'Accept': 'application/json' },
        cache: 'no-cache'
      });

      if (!res.ok) return; // Non-200 response: static hosting fallback
      const data = await res.json();

      if (!data || !data.ok) return;

      const displayTime = data.istDisplayTime || (MARKET_STATS && MARKET_STATS.istDisplayTime);

      if (data.isSyncing) {
        // Sync is actively running in background
        updateSyncIndicator('updating', 'Updating market data...');
        pollSyncCompletion();
        return;
      }

      if (data.needsSync) {
        // Newer exchange session is available; trigger background sync
        updateSyncIndicator('updating', 'Updating market data...');
        try {
          const refreshRes = await fetch('/api/market/refresh', {
            method: 'POST',
            headers: { 'Accept': 'application/json' }
          });
          const refreshData = await refreshRes.json();

          if (refreshData.ok && refreshData.status === 'updated') {
            // Hot-reload fresh dataset without full page reload
            await reloadDatasetHot();
            updateSyncIndicator('latest', 'Latest EOD data', refreshData.istDisplayTime || displayTime);
            try { sessionStorage.setItem(CACHE_KEY, String(Date.now())); } catch (_) {}
          } else if (refreshData.status === 'in_progress') {
            pollSyncCompletion();
          } else {
            // Update failed: keep displaying previous valid dataset
            updateSyncIndicator('failed', 'Update failed — showing previous data', displayTime);
          }
        } catch (err) {
          updateSyncIndicator('failed', 'Update failed — showing previous data', displayTime);
        }
        return;
      }

      // Already up-to-date
      if (data.marketCalendar && (data.marketCalendar.isWeekend || data.marketCalendar.isHoliday)) {
        updateSyncIndicator('latest', 'Latest EOD data (Market closed)', displayTime);
      } else {
        updateSyncIndicator('latest', 'Latest EOD data', displayTime);
      }
      try { sessionStorage.setItem(CACHE_KEY, String(Date.now())); } catch (_) {}

    } catch (err) {
      // In static deployment (e.g. GitHub Pages or file:///), /api/market/status will fail
      // Stale-while-revalidate guarantees the loaded EOD dataset remains active and clean
      updateSyncIndicator('latest');
    }
  }

  // Polls backend status until background sync job concludes
  function pollSyncCompletion() {
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/market/status');
        if (!res.ok) {
          clearInterval(pollInterval);
          return;
        }
        const data = await res.json();
        if (!data.isSyncing) {
          clearInterval(pollInterval);
          if (data.isUpToDate) {
            await reloadDatasetHot();
            updateSyncIndicator('latest', 'Latest EOD data', data.istDisplayTime);
            try { sessionStorage.setItem('mb_last_sync_check', String(Date.now())); } catch (_) {}
          } else {
            updateSyncIndicator('failed', 'Update failed — showing previous data', data.istDisplayTime);
          }
        }
      } catch (_) {
        clearInterval(pollInterval);
        updateSyncIndicator('failed', 'Update failed — showing previous data');
      }
    }, 3000);
  }

  // Dynamically reloads fresh dataset script without breaking UI state
  async function reloadDatasetHot() {
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = `./js/stocks-data.js?t=${Date.now()}`;
      script.onload = () => {
        if (typeof STOCKS_DATA !== 'undefined' && Array.isArray(STOCKS_DATA)) {
          currentStocks = [...STOCKS_DATA];
          filteredStocks = [...STOCKS_DATA];
          if (activeFilter !== 'ALL') {
            applyFilter(activeFilter);
          } else if (searchQuery) {
            handleSearch(searchQuery);
          } else {
            renderTable();
          }
          renderMarketPulse();
        }
        resolve();
      };
      script.onerror = () => resolve();
      document.body.appendChild(script);
    });
  }

  // Expose methods for E2E tests and lifecycle management
  if (typeof window !== 'undefined') {
    window.checkEodAutoRefresh = checkEodAutoRefresh;
    window.updateSyncIndicator = updateSyncIndicator;
  }

  // Initialize
  function init() {
    setupEvents();
    renderMarketPulse();
    renderTable();
    checkEodAutoRefresh();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
