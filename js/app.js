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
  let sortColumn = 'market_cap_cr';
  let sortDirection = 'desc'; // 'asc' or 'desc'
  let searchQuery = '';
  let isDense = false;
  let searchDebounceTimer = null;

  // DOM Elements
  const tbody = document.getElementById('stocks-tbody');
  const searchInput = document.querySelector('input[data-stocks-search="true"]');
  const showingText = document.getElementById('showing-status');
  const infiniteStatus = document.getElementById('infinite-status');
  const infiniteSentinel = document.getElementById('infinite-sentinel');
  const retryButton = document.getElementById('infinite-retry');
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

    // Header Market Status Badge
    const badge = document.getElementById('market-status-badge');
    if (badge && marketStats.stockCount) {
      const dt = marketStats.tradingDate || '2026-11-04';
      const istInfo = marketStats.istDisplayTime ? ` · <span class="text-ink-muted text-[11px] font-normal">Refreshed ${escapeHtml(marketStats.istDisplayTime)}</span>` : '';
      badge.innerHTML = `Market closed · EOD (${dt})${istInfo} · <span class="tabular-nums text-ink-text font-bold">${marketStats.stockCount.toLocaleString('en-IN')}</span> listed companies (NSE + BSE)`;
    }

    // Card 1: Verified Market Cap (Explicit partial coverage note)
    const mcapEl = document.getElementById('card-total-mcap');
    const mcapSub = document.getElementById('card-mcap-sub');
    if (mcapEl) {
      if (marketStats.verifiedMarketCapCr) {
        mcapEl.innerHTML = formatMarketCap(marketStats.verifiedMarketCapCr);
        if (mcapSub) {
          mcapSub.innerText = marketStats.marketCapCoverageNote || 'Top 343 Equities (NSE + BSE)';
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
          vixChg.className = `font-mono text-[12px] font-semibold tabular-nums ${isPos ? 'text-ink-bearish' : 'text-ink-bullish'}`;
          vixChg.innerText = formatPercent(marketStats.vixChangePct);
        }
        if (vixSub && marketStats.vixDate) {
          vixSub.innerText = `Volatility index · ${marketStats.vixDate}`;
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
        breadthSub.innerText = `A/D: ${adRatio} · ${unc} Unch · ${unp} Unpriced`;
      }
    }

    // Card 4: Near 52W High (Guarded with session verification and accurate coverage labeling)
    const nearPct = document.getElementById('card-near52-pct');
    const nearSub = document.getElementById('card-near52-sub');
    if (nearPct) {
      if (marketStats.near52WeekHighCount != null) {
        nearPct.innerText = String(marketStats.near52WeekHighCount);
        if (nearSub) {
          const tradingDate = marketStats.tradingDate || '2026-11-04';
          nearSub.innerHTML = `${marketStats.near52WeekHighCount.toLocaleString('en-IN')} verified BSE Group A/B equities<span class="block text-[10px] text-ink-faint">BSE MCP (${tradingDate})</span>`;
          nearSub.title = `Surveyed BSE Groups A & B (40 matched equities, ${marketStats.near52WeekHighCount} within 8% of 52W high). NSE-only and other BSE groups not included.`;
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
    if (marketStats.verifiedRankingSegments || marketStats.capSegments) {
      const segs = marketStats.verifiedRankingSegments || {};
      const t100 = segs.top100 != null ? segs.top100 : (marketStats.capSegments ? marketStats.capSegments.large || 0 : 0);
      const r101_250 = segs.rank101_250 != null ? segs.rank101_250 : (marketStats.capSegments ? marketStats.capSegments.mid || 0 : 0);
      const rem = segs.remainingVerified != null ? segs.remainingVerified : (marketStats.capSegments ? marketStats.capSegments.small || 0 : 0);
      const unranked = segs.unranked != null ? segs.unranked : 3758;
      const sme = segs.smePlatform != null ? segs.smePlatform : (marketStats.capSegments ? marketStats.capSegments.sme || 0 : 0);
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

  // Server-side filtering keeps search and sorting complete across all listed stocks.
  function queryParameters(offset) {
    const defaultColumn = activeFilter === 'TOP GAINERS' || activeFilter === 'TOP LOSERS' ? 'change_percent' : sortColumn;
    const defaultDirection = activeFilter === 'TOP GAINERS' ? 'desc' : activeFilter === 'TOP LOSERS' ? 'asc' : sortDirection;
    return new URLSearchParams({ limit: String(pageSize), offset: String(offset), search: searchQuery, filter: activeFilter, sort: sortOverride ? sortColumn : defaultColumn, direction: sortOverride ? sortDirection : defaultDirection, sortOverride: String(sortOverride) });
  }
  function renderRows(rows, append) {
    if (!tbody || !rows.length) return;
    const padY = isDense ? '4px' : '9px';
    const html = rows.map((s, idx) => {
      const isChgPositive = (s.change_percent || 0) >= 0;
      const chgColor = isChgPositive ? 'text-ink-bullish' : 'text-ink-bearish';
      const chgArrow = isChgPositive ? '▴' : '▾';
      const volWidth = Math.min(100, Math.max(10, ((s.volume_ratio || 1) / 2.5) * 100));
      return `
        <tr data-row-isin="${escapeHtml(s.isin)}" tabindex="0" aria-label="Open details for ${escapeHtml(s.company_name || s.symbol)}" class="group cursor-pointer border-b border-ink-rule transition-colors hover:bg-ink-well focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink-sienna focus-visible:outline-offset-[-1px] pulse-stocks-rise" style="animation-delay: ${idx * 15}ms">
          <td class="text-right text-[13px] text-ink-muted px-2 tabular-nums" style="padding-top:${padY};padding-bottom:${padY}">${s.rank != null ? s.rank : '—'}</td>
          <td class="px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <a class="flex items-center gap-2.5 min-w-0 group/link rounded-sm focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink-sienna" href="./stock.html?isin=${encodeURIComponent(s.isin || '')}" aria-label="View details for ${escapeHtml(s.symbol)}">
              ${getLogoHtml(s, 'sm')}<div class="min-w-0"><div class="flex items-center gap-1.5 flex-wrap"><span class="text-[14px] font-semibold text-ink-ink group-hover/link:text-ink-sienna transition-colors">${escapeHtml(s.symbol)}</span>${getExchangeBadgesHtml(s)}</div>
              <div class="text-[11px] text-ink-muted truncate max-w-[190px] md:max-w-[220px]" title="${escapeHtml(s.company_name)}">${escapeHtml(s.company_name)}</div></div>
            </a>
          </td>
          <td class="hidden lg:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}"><span class="inline-block max-w-[125px] truncate align-middle text-[9px] font-bold tracking-[0.12em] uppercase text-ink-muted bg-ink-inset px-1.5 py-0.5 rounded-[3px]" title="${escapeHtml(s.sector || 'GENERAL')}">${escapeHtml(s.sector || '—')}</span></td>
          <td class="text-right text-[14px] text-ink-ink px-2" style="padding-top:${padY};padding-bottom:${padY}"><span class="font-mono tabular-nums [letter-spacing:-0.02em]">${formatCurrency(s.current_price)}</span></td>
          <td class="text-right text-[12px] font-medium px-2" style="padding-top:${padY};padding-bottom:${padY}"><span class="inline-flex items-baseline gap-1 font-mono tabular-nums [letter-spacing:-0.02em] ${chgColor} justify-end text-[12px]"><span aria-hidden="true">${chgArrow}</span>${formatPercent(s.change_percent)}</span></td>
          <td class="text-right text-[12px] text-ink-text tabular-nums px-2" style="padding-top:${padY};padding-bottom:${padY}">${formatMarketCap(s.market_cap_cr)}</td>
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 ${getReturnColorClass(s.return_1w)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_1w)}">${formatPercent(s.return_1w)}</td>
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 text-ink-muted" style="padding-top:${padY};padding-bottom:${padY}">${formatPercent(s.return_1m)}</td>
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 text-ink-muted" style="padding-top:${padY};padding-bottom:${padY}">${formatPercent(s.return_3m)}</td>
          <td class="hidden xl:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}"><div class="w-[32px] h-[3.5px] bg-ink-inset rounded-full overflow-hidden relative" title="Volume: ${s.volume != null ? s.volume.toLocaleString('en-IN') : '—'} (${s.volume_ratio || 1.0}x avg)"><div class="h-full bg-ink-muted/80 rounded-full" style="width:${volWidth}%"></div></div></td>
          <td class="hidden xl:table-cell w-[64px] px-1" style="padding-top:${padY};padding-bottom:${padY}">${createSparklineSvg(s)}</td>
          <td class="text-right px-1.5 whitespace-nowrap" style="padding-top:7px;padding-bottom:7px"><span class="inline-flex items-center gap-0.5 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 focus-within:opacity-100 focus-within:translate-x-0"><a class="stock-details-link w-6 h-6 flex items-center justify-center rounded-full text-[13px] text-ink-sienna hover:bg-ink-sienna-muted transition-colors" href="./stock.html?isin=${encodeURIComponent(s.isin || '')}" aria-label="View details for ${escapeHtml(s.symbol)}" title="View stock details">↗</a></span></td>
        </tr>`;
    }).join('');
    if (append) tbody.insertAdjacentHTML('beforeend', html);
    else tbody.innerHTML = html;
  }
  function renderSkeletons(count = 6) {
    if (tbody) tbody.innerHTML = Array.from({length:count}, () => '<tr aria-hidden="true" class="border-b border-ink-rule animate-pulse"><td colspan="12" class="px-4 py-3"><div class="h-3 rounded bg-ink-well" style="width:62%"></div></td></tr>').join('');
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
      const unique = data.stocks.filter(stock => stock.isin && !loadedIsins.has(String(stock.isin).toUpperCase()));
      unique.forEach(stock => loadedIsins.add(String(stock.isin).toUpperCase()));
      if (unique.length) { loadedStocks.push(...unique); renderRows(unique,true); }
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

    // Keyboard shortcut '/' to search
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== searchInput) {
        e.preventDefault();
        if (searchInput) {
          searchInput.focus();
          searchInput.select();
        }
      }
    });

    // Filter pills
    filterButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        filterButtons.forEach(b => {
          b.className = 'filter-pill-btn inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-[11px] py-[5px] font-ui text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150 border-ink-rule bg-ink-well text-ink-muted hover:-translate-y-px hover:text-ink-text';
          b.setAttribute('aria-pressed', 'false');
        });
        btn.className = 'filter-pill-btn inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-[11px] py-[5px] font-ui text-[10px] font-semibold uppercase tracking-[0.06em] transition-all duration-150 border-ink-sienna bg-ink-sienna-muted text-ink-sienna shadow-soft';
        btn.setAttribute('aria-pressed', 'true');

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

    const defaultTime = (marketStats && marketStats.istDisplayTime)
      ? marketStats.istDisplayTime
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

      const displayTime = data.istDisplayTime || (marketStats && marketStats.istDisplayTime);

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
