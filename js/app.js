/* machii bazzar - Client Application Logic */

(function () {
  'use strict';

  // State
  let loadedStocks = [];
  let loadedIsins = new Set();
  let marketStats = null;
  let nextOffset = 0;
  let resultTotal = 0;
  let hasMore = true;
  let loading = false;
  let loadError = false;
  let queryVersion = 0;
  let activeController = null;
  let observer = null;
  let sortOverride = false;
  const pageSize = 50;
  let activeFilter = 'ALL';
  let activeSector = '';  // sector filter — empty means no sector filter
  let sortColumn = 'market_cap_cr';
  let sortDirection = 'desc'; // 'asc' or 'desc'
  let searchQuery = '';
  let isDense = false;
  let searchDebounceTimer = null;
  const comparisonStocks = new Map();
  const MAX_COMPARISON_STOCKS = 4;

  // DOM Elements
  const tbody = document.getElementById('stocks-tbody');
  const searchInput = document.querySelector('input[data-stocks-search="true"]');
  const showingText = document.getElementById('showing-status');
  const infiniteStatus = document.getElementById('infinite-status');
  const infiniteSentinel = document.getElementById('infinite-sentinel');
  const filterButtons = document.querySelectorAll('.filter-pill-btn');
  const densityToggleBtn = document.getElementById('density-toggle-btn');

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

  function formatVolume(val) {
    if (val == null || val === '') return '—';
    const num = Number(val);
    if (!Number.isFinite(num) || num <= 0) return '—';
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${Math.round(num / 1000)}K`;
    return String(Math.round(num));
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

  function getLogoHtml(stock, size = 'sm') {
    return window.CompanyLogo.render({
      isin: stock.isin,
      companyName: stock.company_name,
      logoData: window.COMPANY_LOGO_MANIFEST?.[String(stock.isin || '').toUpperCase()],
      size
    });
  }

  // Exchange badges helper for NSE, BSE and SME
  function getExchangeBadgesHtml(stock) {
    const badges = [];
    const exchanges = stock.exchanges || [];
    const isDual = exchanges.includes('NSE') && exchanges.includes('BSE');
    const isNseOnly = exchanges.includes('NSE') && !exchanges.includes('BSE');
    const isBseOnly = exchanges.includes('BSE') && !exchanges.includes('NSE');
    const isSme = stock.segment === 'SME';

    const pillClass = 'px-1 py-0.5 rounded text-[8.5px] font-mono font-medium leading-none';

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
    if (!marketStats) return;

    // Header Market Status Badge (concise single line, no duplicate timestamp clutter)
    const badge = document.getElementById('market-status-badge');
    if (badge && marketStats.stockCount) {
      const dt = marketStats.tradingDate || 'date unavailable';
      badge.innerHTML = `EOD <span class="text-ink-ink font-semibold">${escapeHtml(dt)}</span> · <span class="tabular-nums text-ink-text font-bold">${marketStats.stockCount.toLocaleString('en-IN')}</span> equities (NSE + BSE)`;
    }
    const gridTable = document.querySelector('table[role="grid"]');
    if (gridTable && marketStats.stockCount) {
      gridTable.setAttribute('aria-rowcount', String(marketStats.stockCount));
    }
    const histSessionCnt = Number(marketStats.historicalSessions?.sessionCount || 0);
    const th1m = document.querySelector('th[data-col="1M"]');
    const th3m = document.querySelector('th[data-col="3M"]');
    if (th1m) {
      th1m.setAttribute('title', histSessionCnt >= 22 ? '1-Month Return (22 trading sessions)' : 'Data not available yet (requires 22 trading sessions)');
    }
    if (th3m) {
      th3m.setAttribute('title', histSessionCnt >= 66 ? '3-Month Return (66 trading sessions)' : 'Data not available yet (requires 66 trading sessions)');
    }

    // Card 1: Verified Market Cap (Explicit partial coverage note)
    const mcapEl = document.getElementById('card-total-mcap');
    const mcapSub = document.getElementById('card-mcap-sub');
    if (mcapEl) {
      if (marketStats.verifiedMarketCapCr) {
        mcapEl.innerHTML = formatMarketCap(marketStats.verifiedMarketCapCr);
        if (mcapSub) {
          const cnt = marketStats.marketCapCoverageCount;
          const pct = marketStats.marketCapCoveragePct;
          mcapSub.innerText = cnt != null && pct != null
            ? `${cnt.toLocaleString('en-IN')} Verified Equities · ${pct}%`
            : (marketStats.marketCapCoverageNote || 'Verified Equities (NSE + BSE)');
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
      if (marketStats.vix != null) {
        vixVal.innerText = Number(marketStats.vix).toFixed(2);
        if (vixChg && marketStats.vixChangePct != null) {
          const isPos = marketStats.vixChangePct > 0;
          vixChg.className = `font-mono text-[11px] sm:text-[12px] font-semibold tabular-nums ${isPos ? 'text-ink-bearish' : 'text-ink-bullish'}`;
          vixChg.innerText = formatPercent(marketStats.vixChangePct);
        }
        if (vixSub && marketStats.vixDate) {
          vixSub.innerText = `VIX · ${marketStats.vixDate}`;
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
    if (marketStats.advances != null && marketStats.declines != null) {
      const adv = marketStats.advances;
      const dec = marketStats.declines;
      const unc = marketStats.unchanged || 0;
      const unp = (marketStats.marketBreadth && marketStats.marketBreadth.unpriced) || 0;
      const total = adv + dec + unc;
      const pct = total > 0 ? (adv / total) * 100 : 50;

      if (breadthAdv) breadthAdv.innerText = `${adv.toLocaleString('en-IN')} ▴`;
      if (breadthDec) breadthDec.innerText = `${dec.toLocaleString('en-IN')} ▾`;
      if (breadthFill) breadthFill.style.width = `${pct.toFixed(1)}%`;
      if (breadthInd) breadthInd.style.left = `${pct.toFixed(1)}%`;
      if (breadthBar) breadthBar.setAttribute('aria-label', `${adv} advancing, ${dec} declining, ${unc} unchanged`);
      if (breadthSub) {
        const adRatio = marketStats.adRatio || (dec > 0 ? (adv / dec).toFixed(2) : '—');
        breadthSub.innerText = unp > 0 ? `A/D ${adRatio} · ${unc} Unch · ${unp} Unp` : `A/D ${adRatio} · ${unc} Unch`;
      }
    }

    // Card 4: Near 52W High (Guarded with session verification and accurate coverage labeling)
    const nearLabel = document.getElementById('card-near52-label');
    const nearPct = document.getElementById('card-near52-pct');
    const nearSub = document.getElementById('card-near52-sub');
    if (nearPct) {
      if (marketStats.near52WeekHighCount != null) {
        nearPct.innerText = String(marketStats.near52WeekHighCount);
        const sourceText = String(marketStats.near52WeekHighSource || '');
        const universeText = String(marketStats.near52WeekHighSurveyedUniverse || '');
        const isNseScope = /\bNSE\b/i.test(sourceText) || /\bNSE\b/i.test(universeText);
        const isBseScope = /\bBSE\b/i.test(sourceText) || /\bBSE\b/i.test(universeText);
        const scopeShort = isNseScope && isBseScope
          ? 'NSE/BSE'
          : (isNseScope ? 'NSE 52W' : (isBseScope ? 'BSE A/B' : 'Verified'));
        const detailTitle = universeText
          ? `${universeText}${marketStats.near52WeekHighCoverage ? ` — ${marketStats.near52WeekHighCoverage}.` : ''}`
          : `${marketStats.near52WeekHighCount} equities within 8% of verified 52W high.`;
        if (nearLabel) nearLabel.title = detailTitle;
        if (nearSub) {
          const tradingDate = marketStats.tradingDate || 'date unavailable';
          nearSub.textContent = `${scopeShort} · ${marketStats.near52WeekHighTradingDate || tradingDate}`;
          nearSub.title = detailTitle;
        }
      } else {
        nearPct.innerText = '—';
        if (nearSub) {
          nearSub.textContent = 'No verified data';
          nearSub.title = '52-week high data was not verified for this trading session.';
        }
      }
    }

    // Card 5: Verified Cap Ranks
    if (marketStats.verifiedRankingSegments || marketStats.capSegments) {
      const segs = marketStats.verifiedRankingSegments || {};
      const t100 = segs.top100 != null ? segs.top100 : (marketStats.capSegments ? marketStats.capSegments.large || 0 : 0);
      const r101_250 = segs.rank101_250 != null ? segs.rank101_250 : (marketStats.capSegments ? marketStats.capSegments.mid || 0 : 0);
      const rem = segs.remainingVerified != null ? segs.remainingVerified : (marketStats.capSegments ? marketStats.capSegments.small || 0 : 0);
      const unranked = segs.unranked != null ? segs.unranked : (marketStats.capSegments ? marketStats.capSegments.micro || 0 : 0);
      const sme = segs.smePlatform != null ? segs.smePlatform : (marketStats.capSegments ? marketStats.capSegments.sme || 0 : 0);
      const maxVal = Math.max(t100, r101_250, rem, unranked, sme, 1);

      const segLabels = {
        lrg: 'Top 100 Verified',
        mid: 'Rank 101–250 Verified',
        sml: 'Remaining Verified',
        mic: 'Unranked / Unverified Equities',
        sme: 'SME Platform Equities'
      };

      const setSeg = (key, val) => {
        const cntEl = document.getElementById(`card-seg-cnt-${key}`);
        const barEl = document.getElementById(`card-seg-bar-${key}`);
        if (cntEl) cntEl.innerText = val > 0 ? val.toLocaleString('en-IN') : '—';
        if (barEl) {
          const logVal = val > 0 ? Math.log10(val) : 0;
          const logMax = Math.log10(maxVal);
          const ratio = logMax > 0 ? logVal / logMax : 0;
          const heightPct = val > 0 ? Math.min(100, Math.max(24, Math.round(ratio * 100))) : 0;
          barEl.style.height = `${heightPct}%`;
          const titleText = `${segLabels[key] || key}: ${val > 0 ? val.toLocaleString('en-IN') : '0'} stocks`;
          barEl.setAttribute('title', titleText);
          if (barEl.parentElement) barEl.parentElement.setAttribute('title', titleText);
        }
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

  const WATCHLIST_STORAGE_KEY = 'machii_watchlist';
  function getWatchlist() {
    try {
      const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
      if (!raw) return new Set();
      const arr = JSON.parse(raw);
      return new Set(Array.isArray(arr) ? arr.map(i => String(i).toUpperCase()) : []);
    } catch (_) {
      return new Set();
    }
  }
  function saveWatchlist(set) {
    try {
      localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(Array.from(set)));
    } catch (_) {}
  }
  function toggleWatchlist(isin) {
    if (!isin) return false;
    const norm = String(isin).toUpperCase();
    const set = getWatchlist();
    const added = !set.has(norm);
    if (added) set.add(norm);
    else set.delete(norm);
    saveWatchlist(set);
    return added;
  }

  function renderCompareTray() {
    const tray = document.getElementById('compare-tray');
    if (!tray) return;
    if (!comparisonStocks.size) {
      tray.hidden = true;
      tray.innerHTML = '';
      return;
    }
    const selected = Array.from(comparisonStocks.values());
    tray.hidden = false;
    tray.innerHTML = `<div class="compare-tray-inner"><div class="compare-tray-label"><span class="compare-tray-count">${selected.length}</span><span>${selected.length === 1 ? 'stock selected' : 'stocks selected'}</span><span class="compare-tray-hint">Choose up to ${MAX_COMPARISON_STOCKS}</span></div><div class="compare-tray-actions"><div class="compare-chips">${selected.map(stock => `<span class="compare-chip">${escapeHtml(stock.symbol || stock.company_name)}<button type="button" data-compare-remove="${escapeHtml(stock.isin)}" aria-label="Remove ${escapeHtml(stock.symbol)} from comparison">×</button></span>`).join('')}</div><button type="button" class="compare-open-btn" data-compare-open ${selected.length < 2 ? 'disabled' : ''}>Compare stocks <span aria-hidden="true">↗</span></button><button type="button" class="compare-clear-btn" data-compare-clear>Clear</button></div></div>`;
  }

  function renderComparison() {
    const content = document.getElementById('compare-content');
    if (!content) return;
    const stocks = Array.from(comparisonStocks.values());
    const metrics = [
      ['Price', stock => formatCurrency(stock.current_price)],
      ['Daily change', stock => `<span class="${getReturnColorClass(stock.change_percent)}">${formatPercent(stock.change_percent)}</span>`],
      ['Market cap', stock => formatMarketCap(stock.market_cap_cr)],
      ['1 week return', stock => `<span class="${getReturnColorClass(stock.return_1w)}">${formatPercent(stock.return_1w)}</span>`],
      ['1 month return', stock => `<span class="${getReturnColorClass(stock.return_1m)}">${formatPercent(stock.return_1m)}</span>`],
      ['3 month return', stock => `<span class="${getReturnColorClass(stock.return_3m)}">${formatPercent(stock.return_3m)}</span>`],
      ['Volume', stock => escapeHtml(formatVolume(stock.volume))],
      ['Sector', stock => escapeHtml((!stock.sector || String(stock.sector).toUpperCase() === 'GENERAL') ? 'Unclassified' : stock.sector)],
      ['Exchange', stock => escapeHtml((stock.exchanges || []).join(' + ') || '—')]
    ];
    content.innerHTML = `<div class="compare-table-wrap"><table class="compare-table"><thead><tr><th>Metric</th>${stocks.map(stock => `<th><span class="compare-symbol">${escapeHtml(stock.symbol || '—')}</span><span class="compare-company">${escapeHtml(stock.company_name || '')}</span></th>`).join('')}</tr></thead><tbody>${metrics.map(([label, value]) => `<tr><th scope="row">${label}</th>${stocks.map(stock => `<td>${value(stock)}</td>`).join('')}</tr>`).join('')}</tbody></table></div><p class="compare-data-note">End-of-day data · Missing values are shown as —</p>`;
  }

  function toggleComparison(stock) {
    const isin = String(stock?.isin || '').toUpperCase();
    if (!isin) return;
    if (comparisonStocks.has(isin)) comparisonStocks.delete(isin);
    else if (comparisonStocks.size < MAX_COMPARISON_STOCKS) comparisonStocks.set(isin, stock);
    renderCompareTray();
    renderTable();
  }

  // Server-side filtering keeps search and sorting complete across all listed stocks.
  function queryParameters(offset) {
    const defaultColumn = activeFilter === 'TOP GAINERS' || activeFilter === 'TOP LOSERS' ? 'change_percent' : sortColumn;
    const defaultDirection = activeFilter === 'TOP GAINERS' ? 'desc' : activeFilter === 'TOP LOSERS' ? 'asc' : sortDirection;
    const params = new URLSearchParams({ limit: String(pageSize), offset: String(offset), search: searchQuery, filter: activeFilter, sort: sortOverride ? sortColumn : defaultColumn, direction: sortOverride ? sortDirection : defaultDirection, sortOverride: String(sortOverride) });
    if (activeFilter === 'WATCHLIST') {
      params.set('isins', Array.from(getWatchlist()).join(','));
    }
    if (activeSector) {
      params.set('sector', activeSector);
    }
    return params;
  }
  function renderRows(rows, append) {
    if (!tbody || !rows.length) return;
    const padY = isDense ? '4px' : '9px';
    const watchlist = getWatchlist();
    const html = rows.map((s, idx) => {
      const isChgPositive = (s.change_percent || 0) >= 0;
      const chgColor = isChgPositive ? 'text-ink-bullish' : 'text-ink-bearish';
      const chgArrow = isChgPositive ? '▴' : '▾';
      const sectorText = (!s.sector || String(s.sector).toUpperCase() === 'GENERAL') ? 'Unclassified' : s.sector;
      const isStarred = s.isin && watchlist.has(String(s.isin).toUpperCase());
      const isCompared = s.isin && comparisonStocks.has(String(s.isin).toUpperCase());
      const mobileRankHtml = s.rank != null ? `<span class="mobile-inline-rank text-[10px] font-mono text-ink-muted mr-1 lg:hidden">#${s.rank}</span>` : '';
      return `
        <tr data-row-isin="${escapeHtml(s.isin)}" tabindex="0" aria-label="Open details for ${escapeHtml(s.company_name || s.symbol)}" class="group cursor-pointer border-b border-ink-rule transition-colors hover:bg-ink-well focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink-sienna focus-visible:outline-offset-[-1px] pulse-stocks-rise" style="animation-delay: ${idx * 15}ms">
          <td class="text-right font-mono tabular-nums text-[13px] text-ink-muted px-2" style="padding-top:${padY};padding-bottom:${padY}">${s.rank != null ? s.rank : '—'}</td>
          <td class="px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <a class="flex items-center gap-2.5 min-w-0 group/link rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink-sienna" href="./stock.html?isin=${encodeURIComponent(s.isin || '')}" aria-label="View details for ${escapeHtml(s.symbol)}">
              ${getLogoHtml(s, 'sm')}<div class="min-w-0"><div class="flex items-center gap-1.5 flex-wrap">${mobileRankHtml}<span class="text-[14px] font-semibold text-ink-ink group-hover/link:text-ink-sienna transition-colors">${escapeHtml(s.symbol)}</span>${getExchangeBadgesHtml(s)}</div>
              <div class="stock-company-name text-[11px] text-ink-muted truncate max-w-[190px] md:max-w-[220px]" title="${escapeHtml(s.company_name)}">${escapeHtml(s.company_name)}</div></div>
            </a>
          </td>
          <td class="hidden lg:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}"><span class="inline-block max-w-[125px] truncate align-middle text-[9px] font-bold tracking-[0.12em] uppercase text-ink-muted bg-ink-inset px-1.5 py-0.5 rounded-[3px]" title="${escapeHtml(sectorText)}">${escapeHtml(sectorText)}</span></td>
          <td class="text-right font-mono tabular-nums text-[14px] text-ink-ink px-2" style="padding-top:${padY};padding-bottom:${padY}"><span class="font-mono tabular-nums [letter-spacing:-0.02em]">${formatCurrency(s.current_price)}</span></td>
          <td class="text-right font-mono tabular-nums text-[12px] font-medium px-2" style="padding-top:${padY};padding-bottom:${padY}"><span class="inline-flex items-baseline gap-1 font-mono tabular-nums [letter-spacing:-0.02em] ${chgColor} justify-end text-[12px]"><span aria-hidden="true">${chgArrow}</span>${formatPercent(s.change_percent)}</span></td>
          <td class="text-right font-mono tabular-nums text-[12px] text-ink-text px-2" style="padding-top:${padY};padding-bottom:${padY}">${formatMarketCap(s.market_cap_cr)}</td>
          <td class="hidden xl:table-cell text-right font-mono tabular-nums text-[11px] px-2 ${getReturnColorClass(s.return_1w)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_1w)}">${formatPercent(s.return_1w)}</td>
          <td class="hidden xl:table-cell text-right font-mono tabular-nums text-[11px] px-2 ${getReturnColorClass(s.return_1m)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_1m)}"${s.return_1m == null ? ' title="Data not available yet"' : ''}>${formatPercent(s.return_1m)}</td>
          <td class="hidden xl:table-cell text-right font-mono tabular-nums text-[11px] px-2 ${getReturnColorClass(s.return_3m)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_3m)}"${s.return_3m == null ? ' title="Data not available yet"' : ''}>${formatPercent(s.return_3m)}</td>
          <td class="hidden xl:table-cell text-right font-mono tabular-nums text-[11px] text-ink-text px-2" style="padding-top:${padY};padding-bottom:${padY}" title="Volume: ${s.volume != null ? Number(s.volume).toLocaleString('en-IN') : '—'}">${formatVolume(s.volume)}</td>
          <td class="hidden xl:table-cell w-[64px] px-1" style="padding-top:${padY};padding-bottom:${padY}">${createSparklineSvg(s)}</td>
          <td class="row-actions-cell text-right px-2 whitespace-nowrap" style="padding-top:7px;padding-bottom:7px">
            <span class="row-actions-group inline-flex items-center justify-end gap-1 ${isStarred || isCompared ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'} transition-opacity duration-150">
              <button type="button" class="watchlist-toggle-btn w-7 h-7 flex items-center justify-center rounded-full text-[13px] transition-colors ${isStarred ? 'text-amber-400 bg-amber-400/10' : 'text-ink-muted/60 hover:text-amber-400 hover:bg-ink-inset'}" data-isin="${escapeHtml(s.isin)}" title="${isStarred ? 'Remove from Watchlist' : 'Add to Watchlist'}" aria-label="Toggle watchlist for ${escapeHtml(s.symbol)}">★</button>
              <button type="button" class="compare-toggle-btn w-7 h-7 flex items-center justify-center rounded-full text-[12px] transition-colors ${isCompared ? 'is-selected' : 'hover:bg-ink-inset'}" data-isin="${escapeHtml(s.isin)}" title="${isCompared ? 'Remove from comparison' : 'Add to comparison'}" aria-label="${isCompared ? 'Remove' : 'Compare'} ${escapeHtml(s.symbol)}">⇄</button>
              <a class="stock-details-link w-7 h-7 flex items-center justify-center rounded-full text-[13px] text-ink-sienna hover:bg-ink-sienna-muted transition-colors" href="./stock.html?isin=${encodeURIComponent(s.isin || '')}" aria-label="View details for ${escapeHtml(s.symbol)}" title="View stock details">↗</a>
            </span>
          </td>
        </tr>`;
    }).join('');
    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;
  }
  function renderSkeletons(count = 7) {
    if (!tbody) return;
    tbody.innerHTML = Array.from({length:count}, () => `
      <tr aria-hidden="true" class="border-b border-ink-rule animate-pulse h-[70px] min-h-[70px]">
        <td colspan="12" class="px-3 py-3 h-[70px]">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 min-w-[32px] rounded-full bg-ink-well shrink-0"></div>
            <div class="space-y-1.5 flex-1 max-w-[200px]">
              <div class="h-3.5 bg-ink-well rounded w-20"></div>
              <div class="h-2.5 bg-ink-well/60 rounded w-36"></div>
            </div>
            <div class="hidden lg:block w-20 h-4 bg-ink-well rounded"></div>
            <div class="ml-auto w-24 h-4 bg-ink-well rounded"></div>
            <div class="w-16 h-4 bg-ink-well rounded"></div>
            <div class="w-20 h-4 bg-ink-well rounded"></div>
            <div class="hidden xl:block w-14 h-4 bg-ink-well rounded"></div>
            <div class="hidden xl:block w-14 h-4 bg-ink-well rounded"></div>
            <div class="hidden xl:block w-14 h-4 bg-ink-well rounded"></div>
            <div class="hidden xl:block w-12 h-4 bg-ink-well rounded"></div>
          </div>
        </td>
      </tr>
    `).join('');
  }
  function updateInfiniteStatus() {
    if (!infiniteStatus) return;
    if (loading) infiniteStatus.innerHTML = loadedStocks.length ? '<span class="inline-flex items-center gap-2 text-[11px] text-ink-muted"><span class="size-3 rounded-full border border-ink-muted border-t-transparent animate-spin"></span>Loading more stocks…</span>' : '';
    else if (loadError) {
      infiniteStatus.innerHTML = '<span class="inline-flex items-center gap-2 text-[11px] text-ink-muted">Could not load stocks. <button id="infinite-retry" class="text-ink-sienna underline underline-offset-2">Retry</button></span>';
      document.getElementById('infinite-retry')?.addEventListener('click', () => fetchNextBatch(true));
    } else if (!hasMore && loadedStocks.length) infiniteStatus.innerHTML = '<span class="text-[11px] text-ink-muted">You\'ve reached the end</span>';
    else infiniteStatus.textContent = '';
    if (showingText) showingText.innerHTML = loadedStocks.length
      ? `Showing <span class="text-ink-ink font-medium">1–${loadedStocks.length.toLocaleString('en-IN')}</span> of <span class="text-ink-ink font-medium">${resultTotal.toLocaleString('en-IN')}</span> stocks <span class="text-ink-faint">(of ${(marketStats?.stockCount || resultTotal).toLocaleString('en-IN')} total)</span>`
      : (loading ? 'Loading stocks…' : 'No matching stocks found');
  }
  async function fetchNextBatch(retry = false) {
    if (loading || !hasMore || (loadError && !retry)) return;
    if (activeFilter === 'WATCHLIST' && getWatchlist().size === 0) {
      loading = false; hasMore = false; resultTotal = 0; loadedStocks = []; loadedIsins = new Set();
      if (tbody) tbody.innerHTML = '<tr><td colspan="12" class="text-center py-12 text-ink-muted"><div class="font-display text-lg text-ink-ink mb-1">Your Watchlist is empty</div><p class="text-sm">Click the <span class="text-amber-400">★</span> icon on any stock row to add it to your personal watchlist.</p></td></tr>';
      updateInfiniteStatus();
      return;
    }
    loading = true; loadError = false;
    const version = queryVersion, offset = nextOffset;
    updateInfiniteStatus(); if (!loadedStocks.length) renderSkeletons();
    const controller = new AbortController(); activeController = controller;
    try {
      const response = await fetch(`/api/stocks?${queryParameters(offset)}`, {headers:{Accept:'application/json'}, signal:controller.signal, cache:'no-store'});
      if (!response.ok) throw new Error(`Stock request failed (${response.status})`);
      const data = await response.json();
      if (version !== queryVersion) return;
      if (!data?.ok || !Array.isArray(data.stocks)) throw new Error('Invalid stock response');
      marketStats = data.stats || marketStats; resultTotal = Number(data.total)||0; hasMore = Boolean(data.hasMore);
      data.stocks.forEach(stock => {
        const isin = String(stock.isin || '').toUpperCase();
        if (comparisonStocks.has(isin)) comparisonStocks.set(isin, stock);
      });
      const unique = data.stocks.filter(stock => stock.isin && !loadedIsins.has(String(stock.isin).toUpperCase()));
      unique.forEach(stock => loadedIsins.add(String(stock.isin).toUpperCase()));
      const isFirstBatch = loadedStocks.length === 0;
      if (unique.length) { loadedStocks.push(...unique); renderRows(unique, !isFirstBatch); }
      else if (!loadedStocks.length && tbody) tbody.innerHTML = '<tr><td colspan="12" class="text-center py-12 text-ink-muted"><div class="font-display text-lg text-ink-ink mb-1">No stocks found</div><p class="text-sm">Try searching for a different company or reset the filter.</p></td></tr>';
      nextOffset = Number.isFinite(Number(data.nextOffset)) ? Number(data.nextOffset) : offset + data.stocks.length;
      if (!data.stocks.length || nextOffset <= offset) hasMore = false;
      renderMarketPulse();
    } catch (error) { if (error.name !== 'AbortError' && version === queryVersion) { loadError = true; if (!loadedStocks.length && tbody) tbody.innerHTML = ''; } }
    finally {
      if (version === queryVersion) { loading=false; updateInfiniteStatus(); }
      if (activeController === controller) activeController=null;
    }
  }
  function applyFilters() {
    queryVersion++; if (activeController) activeController.abort();
    loading=false; loadError=false; nextOffset=0; resultTotal=0; hasMore=true; loadedStocks=[]; loadedIsins=new Set();
    if (tbody) tbody.innerHTML=''; updateInfiniteStatus(); fetchNextBatch();
  }
  function renderTable() { if (tbody) { tbody.innerHTML=''; renderRows(loadedStocks,false); } }
  function setupInfiniteScroll() {
    if (!infiniteSentinel) return;
    if ('IntersectionObserver' in window) {
      observer=new IntersectionObserver(entries => { if(entries.some(e=>e.isIntersecting)) fetchNextBatch(); },{root:null,rootMargin:'700px 0px',threshold:0});
      observer.observe(infiniteSentinel);
    } else {
      const onScroll=()=>{ if(window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-700) fetchNextBatch(); };
      window.addEventListener('scroll',onScroll,{passive:true}); window.addEventListener('pagehide',()=>window.removeEventListener('scroll',onScroll),{once:true});
    }
    window.addEventListener('pagehide',()=>{if(observer)observer.disconnect();if(activeController)activeController.abort();},{once:true});
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

    // Keyboard shortcut '/' to search, 'Escape' to clear and blur
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== searchInput && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      } else if (e.key === 'Escape' && document.activeElement === searchInput) {
        if (searchInput.value) {
          searchInput.value = '';
          searchQuery = '';
          applyFilters();
        }
        searchInput.blur();
      }
    });

    // Export CSV
    const exportCsvBtn = document.getElementById('export-csv-btn');
    if (exportCsvBtn) {
      exportCsvBtn.addEventListener('click', () => {
        if (!loadedStocks || !loadedStocks.length) {
          return;
        }
        const headers = [
          'Rank',
          'Symbol',
          'Company Name',
          'ISIN',
          'Exchanges',
          'Segment',
          'Sector',
          'Price (INR)',
          'Change (INR)',
          'Change (%)',
          'Market Cap (Cr)',
          '1W Return (%)',
          '1M Return (%)',
          '3M Return (%)',
          'Volume',
          '52W High (INR)',
          '52W Low (INR)'
        ];

        const escapeCsv = (val) => {
          if (val == null) return '';
          const str = String(val);
          if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        };

        const computeChangeInr = (s) => {
          if (s.change != null && Number.isFinite(Number(s.change))) return Number(s.change);
          if (s.current_price != null && s.prev_close != null) {
            const curr = Number(s.current_price);
            const prev = Number(s.prev_close);
            if (Number.isFinite(curr) && Number.isFinite(prev)) {
              return Number((curr - prev).toFixed(2));
            }
          }
          return '';
        };

        const rows = loadedStocks.map(s => [
          escapeCsv(s.rank != null ? s.rank : ''),
          escapeCsv(s.symbol || ''),
          escapeCsv(s.company_name || ''),
          escapeCsv(s.isin || ''),
          escapeCsv(Array.isArray(s.exchanges) ? s.exchanges.join('/') : (s.exchanges || '')),
          escapeCsv(s.segment || 'MAINBOARD'),
          escapeCsv((!s.sector || String(s.sector).toUpperCase() === 'GENERAL') ? 'Unclassified' : s.sector),
          escapeCsv(s.current_price != null ? s.current_price : ''),
          escapeCsv(computeChangeInr(s)),
          escapeCsv(s.change_percent != null ? s.change_percent : ''),
          escapeCsv(s.market_cap_cr != null ? s.market_cap_cr : ''),
          escapeCsv(s.return_1w != null ? s.return_1w : ''),
          escapeCsv(s.return_1m != null ? s.return_1m : ''),
          escapeCsv(s.return_3m != null ? s.return_3m : ''),
          escapeCsv(s.volume != null ? s.volume : ''),
          escapeCsv(s.week52_high != null ? s.week52_high : ''),
          escapeCsv(s.week52_low != null ? s.week52_low : '')
        ].join(','));

        const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const tradingDate = marketStats?.tradingDate || new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `machii-bazzar-stocks-${tradingDate}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }

    // Filter pills & mobile sector collapse toggle
    const mobileSectorToggle = document.getElementById('mobile-sector-toggle');
    const sectorFilterGroup = document.getElementById('sector-filter-group');
    if (mobileSectorToggle && sectorFilterGroup) {
      mobileSectorToggle.addEventListener('click', () => {
        const isHidden = sectorFilterGroup.classList.toggle('hidden');
        mobileSectorToggle.setAttribute('aria-expanded', String(!isHidden));
        mobileSectorToggle.innerHTML = isHidden ? 'Sectors <span aria-hidden="true">▾</span>' : 'Sectors <span aria-hidden="true">▴</span>';
      });
    }

    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        // Visual reset — all pills to inactive state
        filterButtons.forEach(b => {
          const base = 'filter-pill-btn inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-[11px] py-[5px] font-ui text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150 border-ink-rule bg-ink-well text-ink-muted hover:-translate-y-px hover:text-ink-text';
          b.className = b.classList.contains('sector-pill') ? base + ' sector-pill' : base;
          b.setAttribute('aria-pressed', 'false');
        });
        // Activate clicked pill
        const activeBase = 'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-[11px] py-[5px] font-ui text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150 border-ink-sienna bg-ink-sienna-muted text-ink-sienna shadow-soft';
        btn.className = btn.classList.contains('sector-pill')
          ? 'filter-pill-btn sector-pill ' + activeBase
          : 'filter-pill-btn ' + activeBase;
        btn.setAttribute('aria-pressed', 'true');

        if (btn.classList.contains('sector-pill')) {
          // Sector filter: set sector param, reset standard filter to ALL
          activeSector = btn.getAttribute('data-sector') || '';
          activeFilter = 'ALL';
        } else {
          // Standard filter: clear sector
          activeSector = '';
          const rawText = btn.innerText.trim();
          activeFilter = rawText.includes('WATCHLIST') ? 'WATCHLIST' : rawText;
        }
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
      'Vol': 'volume'
    };

    document.querySelectorAll('th[data-sortable="true"]').forEach(th => {
      th.addEventListener('click', () => {
        const headerText = th.getAttribute('data-col') || th.innerText.replace(/[▲▼]/g, '').trim();
        const colField = thMap[headerText] || headerText;

        sortOverride = true;
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

    // Event delegation keeps stock navigation working as rows are re-rendered.
    if (tbody) {
      tbody.addEventListener('click', (e) => {
        const compareBtn = e.target.closest('.compare-toggle-btn');
        if (compareBtn) {
          e.stopPropagation();
          const isin = String(compareBtn.getAttribute('data-isin') || '').toUpperCase();
          const stock = loadedStocks.find(item => String(item.isin || '').toUpperCase() === isin);
          if (comparisonStocks.size >= MAX_COMPARISON_STOCKS && !comparisonStocks.has(isin)) {
            compareBtn.title = `Comparison is limited to ${MAX_COMPARISON_STOCKS} stocks`;
            return;
          }
          if (stock) toggleComparison(stock);
          return;
        }
        const starBtn = e.target.closest('.watchlist-toggle-btn');
        if (starBtn) {
          e.stopPropagation();
          const isin = String(starBtn.getAttribute('data-isin') || '').toUpperCase();
          const isNowStarred = toggleWatchlist(isin);
          starBtn.classList.toggle('text-amber-400', isNowStarred);
          starBtn.classList.toggle('bg-amber-400/10', isNowStarred);
          starBtn.classList.toggle('text-ink-muted/60', !isNowStarred);
          starBtn.classList.toggle('hover:text-amber-400', !isNowStarred);
          starBtn.classList.toggle('hover:bg-ink-inset', !isNowStarred);
          starBtn.setAttribute('title', isNowStarred ? 'Remove from Watchlist' : 'Add to Watchlist');
          const parentSpan = starBtn.closest('.row-actions-group');
          if (parentSpan) {
            const keepVisible = isNowStarred || comparisonStocks.has(isin);
            parentSpan.classList.toggle('opacity-100', keepVisible);
            parentSpan.classList.toggle('opacity-0', !keepVisible);
          }
          if (activeFilter === 'WATCHLIST' && !isNowStarred) {
            applyFilters();
          }
          return;
        }

        const row = e.target.closest('tr[data-row-isin]');
        if (row) {
          if (e.target.closest('button') || e.target.closest('a')) return;
          const isin = row.getAttribute('data-row-isin');
          if (isin) window.location.href = `./stock.html?isin=${encodeURIComponent(isin)}`;
        }
      });

      tbody.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('tr[data-row-isin]');
        if (!row || e.target.closest('button, a')) return;
        e.preventDefault();
        const isin = row.getAttribute('data-row-isin');
        if (isin) window.location.href = `./stock.html?isin=${encodeURIComponent(isin)}`;
      });
    }

    const tray = document.getElementById('compare-tray');
    if (tray) tray.addEventListener('click', e => {
      if (e.target.closest('[data-compare-clear]')) {
        comparisonStocks.clear(); renderCompareTray(); renderTable(); return;
      }
      const remove = e.target.closest('[data-compare-remove]');
      if (remove) {
        comparisonStocks.delete(String(remove.getAttribute('data-compare-remove')).toUpperCase());
        renderCompareTray(); renderTable(); return;
      }
      if (e.target.closest('[data-compare-open]')) {
        const dialog = document.getElementById('compare-dialog');
        renderComparison();
        if (dialog?.showModal) dialog.showModal();
      }
    });
    const dialog = document.getElementById('compare-dialog');
    dialog?.addEventListener('click', e => {
      if (e.target === dialog || e.target.closest('[data-compare-close]')) dialog.close();
    });
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

    const defaultTime = marketStats?.tradingDate
      ? `EOD ${marketStats.tradingDate}${marketStats.istDisplayTime ? ` · Refreshed ${marketStats.istDisplayTime}` : ''}`
      : '';

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

      case 'delayed':
        dot.classList.add('bg-amber-500');
        textEl.textContent = message || 'BhavCopy delayed — showing latest verified session';
        if (timeEl) timeEl.textContent = timeText ? ` · ${timeText}` : (defaultTime ? ` · ${defaultTime}` : '');
        break;

      case 'stale':
        dot.classList.add('bg-amber-500');
        textEl.textContent = message || 'Showing previous verified EOD data';
        if (timeEl) timeEl.textContent = timeText ? ` · ${timeText}` : (defaultTime ? ` · ${defaultTime}` : '');
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

  function formatStatusDetails(data) {
    const tradingDate = data?.tradingDate || marketStats?.tradingDate || '';
    const refreshTime = data?.istDisplayTime || marketStats?.istDisplayTime || '';
    const expectedDate = data?.latestExpectedDate || data?.marketCalendar?.latestExpectedDate;
    const base = refreshTime ? `Refreshed ${refreshTime}` : (tradingDate ? `EOD ${tradingDate}` : '');
    if (expectedDate && tradingDate && tradingDate !== expectedDate && data?.needsSync) {
      return base ? `${base} · Exp ${expectedDate}` : `Exp ${expectedDate}`;
    }
    return base;
  }

  // Automatic EOD Data Refresh on Website Open
  async function checkEodAutoRefresh() {
    // Do not claim freshness until the backend verifies the dataset date against the calendar.
    updateSyncIndicator('stale', 'Checking EOD data date...');

    // In static file mode (e.g. file:///), no backend HTTP server is available
    if (typeof window !== 'undefined' && (window.location.protocol === 'file:' || !window.location.host)) {
      updateSyncIndicator('stale', 'Showing bundled EOD dataset', formatStatusDetails({}));
      return;
    }

    // Client-side cache: preserve exact freshness state (never mask stale/delayed data as current)
    const CACHE_KEY = 'mb_last_sync_check';
    const CACHE_TTL_MS = 5 * 60 * 1000;
    try {
      const rawCache = sessionStorage.getItem(CACHE_KEY);
      if (rawCache) {
        const cached = JSON.parse(rawCache);
        if (cached && cached.checkedAt && (Date.now() - cached.checkedAt < CACHE_TTL_MS)) {
          updateSyncIndicator(cached.state || 'latest', cached.message, cached.timeText);
          return;
        }
      }
    } catch (_) {
      // Ignore storage access or legacy string cache errors
    }

    const saveStatusCache = (state, message, timeText) => {
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify({
          checkedAt: Date.now(),
          state,
          message,
          timeText
        }));
      } catch (_) {}
    };

    // Attempt to query the backend EOD status API
    try {
      const res = await fetch('/api/market/status', {
        headers: { 'Accept': 'application/json' },
        cache: 'no-cache'
      });

      if (!res.ok) {
        updateSyncIndicator('stale', 'EOD freshness could not be checked', formatStatusDetails({}));
        return;
      }
      const data = await res.json();

      if (!data || !data.ok) {
        updateSyncIndicator('stale', 'EOD freshness could not be checked', formatStatusDetails({}));
        return;
      }

      if (data.isSyncing) {
        updateSyncIndicator('updating', 'Updating market data...');
        pollSyncCompletion();
        return;
      }

      if (data.needsSync) {
        if (data.canTriggerSync === false) {
          const isDelayed = Boolean(data.isDelayed);
          const state = isDelayed ? 'delayed' : 'stale';
          const expectedDate = data.latestExpectedDate || data.marketCalendar?.latestExpectedDate;
          const msg = isDelayed
            ? `Delayed — awaiting ${expectedDate || 'today'} BhavCopy`
            : 'Stale EOD data — showing last verified session';
          const details = formatStatusDetails({
            tradingDate: data.tradingDate,
            istDisplayTime: data.istDisplayTime,
            latestExpectedDate: expectedDate,
            needsSync: true
          });
          updateSyncIndicator(state, msg, details);
          saveStatusCache(state, msg, details);
          return;
        }
        updateSyncIndicator('updating', 'Updating market data...');
        try {
          const refreshRes = await fetch('/api/market/refresh', {
            method: 'POST',
            headers: { 'Accept': 'application/json' }
          });
          const refreshData = await refreshRes.json();

          if (refreshData.ok && refreshData.status === 'updated') {
            await reloadDatasetHot();
            const msg = 'Latest EOD data';
            const details = `EOD ${refreshData.tradingDate || data.tradingDate}${refreshData.istDisplayTime ? ` · Refreshed ${refreshData.istDisplayTime}` : ''}`;
            updateSyncIndicator('latest', msg, details);
            saveStatusCache('latest', msg, details);
          } else if (refreshData.status === 'in_progress' || refreshData.status === 'accepted') {
            pollSyncCompletion();
          } else {
            const isDelayed = Boolean(refreshData.isDelayed ?? data.isDelayed);
            const state = isDelayed ? 'delayed' : 'stale';
            const expectedDate = refreshData.latestExpectedDate || data.latestExpectedDate || data.marketCalendar?.latestExpectedDate;
            const msg = isDelayed
              ? `Delayed — awaiting ${expectedDate || 'today'} BhavCopy`
              : 'Stale EOD data — showing last verified session';
            const details = formatStatusDetails({
              tradingDate: refreshData.tradingDate || data.tradingDate,
              istDisplayTime: refreshData.istDisplayTime || data.istDisplayTime,
              latestExpectedDate: expectedDate,
              needsSync: true
            });
            updateSyncIndicator(state, msg, details);
            saveStatusCache(state, msg, details);
          }
        } catch (err) {
          const state = data.isDelayed ? 'delayed' : 'stale';
          const msg = data.isDelayed ? 'Delayed — awaiting BhavCopy publication' : 'Showing previous verified EOD data';
          const details = formatStatusDetails(data);
          updateSyncIndicator(state, msg, details);
        }
        return;
      }

      const isClosed = Boolean(data.marketCalendar && (data.marketCalendar.isWeekend || data.marketCalendar.isHoliday));
      const msg = isClosed ? 'Latest EOD data (Market closed)' : 'Latest EOD data';
      const details = formatStatusDetails(data);
      const hasNewerRemote = Boolean(
        (data.tradingDate && marketStats?.tradingDate && data.tradingDate > marketStats.tradingDate) ||
        (data.storageVersionId && marketStats?.storageVersionId && data.storageVersionId !== marketStats.storageVersionId)
      );
      if (hasNewerRemote) {
        await reloadDatasetHot();
      }
      updateSyncIndicator('latest', msg, details);
      saveStatusCache('latest', msg, details);

    } catch (err) {
      updateSyncIndicator('stale', 'EOD freshness could not be checked', formatStatusDetails({}));
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
            const details = formatStatusDetails(data);
            updateSyncIndicator('latest', 'Latest EOD data', details);
            try {
              sessionStorage.setItem('mb_last_sync_check', JSON.stringify({
                checkedAt: Date.now(),
                state: 'latest',
                message: 'Latest EOD data',
                timeText: details
              }));
            } catch (_) {}
          } else {
            const state = data.isDelayed ? 'delayed' : 'stale';
            const msg = data.isDelayed ? 'Delayed — awaiting BhavCopy publication' : 'Showing previous verified EOD data';
            updateSyncIndicator(state, msg, formatStatusDetails(data));
          }
        }
      } catch (_) {
        clearInterval(pollInterval);
        updateSyncIndicator('stale', 'EOD freshness could not be checked');
      }
    }, 3000);
  }

  // Reload current query after the backend refreshes its EOD dataset.
  async function reloadDatasetHot() { applyFilters(); }

  // Expose methods for E2E tests and lifecycle management
  if (typeof window !== 'undefined') {
    window.checkEodAutoRefresh = checkEodAutoRefresh;
    window.updateSyncIndicator = updateSyncIndicator;
  }

  // Initialize
  function init() {
    setupEvents();
    setupInfiniteScroll();
    fetchNextBatch();
    checkEodAutoRefresh();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
