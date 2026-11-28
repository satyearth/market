/* Stock details page, keyed by the canonical ISIN. */
(function () {
  'use strict';

  const loading = document.getElementById('stock-loading');
  const errorSection = document.getElementById('stock-error');
  const errorMessage = document.getElementById('stock-error-message');
  const detail = document.getElementById('stock-detail');

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function valueOrNA(value) {
    return value == null || value === '' ? 'N/A' : String(value);
  }

  function asNumber(value) {
    if (value == null || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatPrice(value) {
    const number = asNumber(value);
    return number == null ? 'N/A' : `₹${number.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function formatMarketCap(crore) {
    const value = asNumber(crore);
    if (value == null) return 'N/A';
    if (value >= 100000) return `₹${(value / 100000).toFixed(1)}L Cr`;
    if (value >= 1000) return `₹${(value / 1000).toFixed(1)}k Cr`;
    return `₹${Math.round(value).toLocaleString('en-IN')} Cr`;
  }

  function formatDate(dateValue) {
    if (!dateValue) return 'N/A';
    const parts = String(dateValue).slice(0, 10).split('-').map(Number);
    if (parts.length !== 3 || parts.some(part => !part)) return escapeHtml(dateValue);
    return new Intl.DateTimeFormat('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'
    }).format(new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])));
  }

  function setError(message) {
    loading.classList.add('hidden');
    detail.classList.add('hidden');
    errorMessage.textContent = message;
    errorSection.classList.remove('hidden');
  }

  const MCAP_SOURCE_LABELS = {
    NSE_OFFICIAL_MCAP: 'Official NSE Daily Archive',
    BSE_SECURITY_MASTER: 'Official BSE Security Master',
    CALCULATED_OUTSTANDING_SHARES: 'Price-Adjusted Share Estimate',
    INDIA_API_ISIN: 'Reference Catalog (ISIN Match)',
    INDIA_API_TICKER: 'Reference Catalog (Symbol Match)',
    SCREENER_DATASET: 'Reference Snapshot (Screener)',
    BENCHMARK_VERIFIED: 'Verified Benchmark Reference',
    PREVIOUS_SESSION_VERIFIED: 'Prior Verified Session Snapshot'
  };

  function formatFinancialSource(sourceKey, asOfDate) {
    if (!sourceKey) return 'Unavailable';
    const cleanKey = String(sourceKey).trim();
    const mapped = MCAP_SOURCE_LABELS[cleanKey]
      || (cleanKey.includes('_') ? 'Verified Financial Reference' : cleanKey);
    const formattedDate = asOfDate ? formatDate(asOfDate) : null;
    return formattedDate && formattedDate !== 'N/A'
      ? `${mapped} (${formattedDate})`
      : mapped;
  }

  function field(label, value, isNumeric = false) {
    return `<div class="stock-detail-field"><dt class="stock-detail-label">${escapeHtml(label)}</dt><dd class="stock-detail-value${isNumeric ? ' is-numeric' : ''}">${escapeHtml(valueOrNA(value))}</dd></div>`;
  }

  function listingRow(label, value) {
    return `<div class="stock-listing-row"><dt class="stock-listing-label">${escapeHtml(label)}</dt><dd class="stock-listing-value">${escapeHtml(valueOrNA(value))}</dd></div>`;
  }

  function renderStock(stock, activeStats = null) {
    const statsMeta = activeStats || (typeof MARKET_STATS !== 'undefined' ? MARKET_STATS : null);
    const latestPrice = asNumber(stock.current_price ?? stock.close_price);
    const previousClose = asNumber(stock.prev_close);
    const change = latestPrice != null && previousClose != null ? latestPrice - previousClose : null;
    const percent = asNumber(stock.change_percent);
    const tradeDate = stock.trading_date || stock.trade_date || statsMeta?.tradingDate;
    const dateLabel = formatDate(tradeDate);
    const symbol = stock.nse_symbol || stock.symbol;

    document.title = `${valueOrNA(stock.company_name)} | Machii Bazzar`;
    document.getElementById('stock-company-logo').innerHTML = window.CompanyLogo.render({
      isin: stock.isin,
      companyName: stock.company_name,
      logoData: window.COMPANY_LOGO_MANIFEST?.[String(stock.isin || '').toUpperCase()],
      size: 'lg'
    });
    document.getElementById('stock-symbol').textContent = valueOrNA(symbol);
    document.getElementById('stock-name').textContent = valueOrNA(stock.company_name);
    document.getElementById('stock-price').textContent = formatPrice(latestPrice);
    document.getElementById('stock-price-date').textContent = `EOD close · ${dateLabel}`;

    const changeElement = document.getElementById('stock-change');
    if (change == null || percent == null) {
      changeElement.textContent = 'N/A';
      changeElement.className = 'mt-1 font-mono text-xs font-semibold tabular-nums text-ink-muted';
    } else {
      const positive = change >= 0;
      const sign = positive ? '+' : '−';
      changeElement.textContent = `${sign}${formatPrice(Math.abs(change))} (${sign}${Math.abs(percent).toFixed(2)}%)`;
      changeElement.className = `mt-1 font-mono text-xs font-semibold tabular-nums ${positive ? 'text-ink-bullish' : 'text-ink-bearish'}`;
    }

    const exchanges = Array.isArray(stock.exchanges) ? stock.exchanges : [];
    document.getElementById('stock-exchange-badges').innerHTML = exchanges.length
      ? exchanges.map(exchange => `<span class="rounded border border-ink-rule bg-ink-well px-2 py-1 text-[9px] font-bold uppercase tracking-[0.1em] text-ink-muted">${escapeHtml(exchange)}</span>`).join('')
      : '<span class="text-[10px] text-ink-muted">N/A</span>';
    document.getElementById('stock-listing-status').textContent = valueOrNA(stock.listing_status);

    const sectorVal = (!stock.sector || String(stock.sector).toUpperCase() === 'GENERAL') ? 'Unclassified' : stock.sector;
    const capDisplay = stock.market_cap_cr == null
      ? null
      : (stock.market_cap_as_of_date
        ? `${formatMarketCap(stock.market_cap_cr)} (${formatDate(stock.market_cap_as_of_date)})`
        : formatMarketCap(stock.market_cap_cr));
    const descriptionVal = stock.description && String(stock.description).trim()
      ? String(stock.description).trim()
      : null;
    const sourceDisplay = stock.market_cap_cr == null
      ? 'Unavailable'
      : formatFinancialSource(stock.market_cap_source, stock.market_cap_as_of_date);

    document.getElementById('company-info-grid').innerHTML = [
      field('Market capitalization', capDisplay, true),
      field('Sector', sectorVal),
      field('Industry', stock.industry),
      field('52-week high', stock.week52_high == null ? null : formatPrice(stock.week52_high), true),
      field('52-week low', stock.week52_low == null ? null : formatPrice(stock.week52_low), true),
      field('Segment', stock.segment),
      field('Series / group', stock.series, true),
      field('Financial data source', sourceDisplay)
    ].join('');

    const descTextEl = document.getElementById('company-description-text');
    if (descTextEl) {
      if (descriptionVal) {
        descTextEl.textContent = descriptionVal;
        descTextEl.classList.remove('is-unavailable');
      } else {
        descTextEl.textContent = 'Verified company description is currently unavailable.';
        descTextEl.classList.add('is-unavailable');
      }
    }

    const exchangeCards = [];
    if (exchanges.includes('NSE')) {
      exchangeCards.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('Exchange', 'NSE (India)')}${listingRow('Trading symbol', stock.nse_symbol)}</dl></div>`);
    }
    if (exchanges.includes('BSE')) {
      exchangeCards.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('Exchange', 'BSE Limited')}${listingRow('Scrip code', stock.bse_scrip_code)}</dl></div>`);
    }
    if (!exchangeCards.length) {
      exchangeCards.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('Exchange', null)}${listingRow('Trading symbol', symbol)}</dl></div>`);
    }
    const isDualListing = exchangeCards.length >= 2;
    const idCardHtml = `<div class="exchange-id-card rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('ISIN', stock.isin)}${listingRow('Listing status', stock.listing_status)}</dl></div>`;
    document.getElementById('exchange-listings').innerHTML = `<div class="exchange-listings-stack"><div class="exchange-cards-row${isDualListing ? ' is-dual' : ' is-single'}">${exchangeCards.join('')}</div>${idCardHtml}</div>`;

    // ── Latest session OHLC data ──
    const fmtOhlc = v => { const n = asNumber(v); return n == null ? '—' : `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; };
    const ohlcOpen  = document.getElementById('stock-ohlc-open');
    const ohlcHigh  = document.getElementById('stock-ohlc-high');
    const ohlcLow   = document.getElementById('stock-ohlc-low');
    const ohlcClose = document.getElementById('stock-ohlc-close');
    if (ohlcOpen) ohlcOpen.textContent   = fmtOhlc(stock.open_price);
    if (ohlcHigh) ohlcHigh.textContent   = fmtOhlc(stock.high_price);
    if (ohlcLow)  ohlcLow.textContent    = fmtOhlc(stock.low_price);
    if (ohlcClose) ohlcClose.textContent = fmtOhlc(stock.close_price ?? stock.current_price);

    // Day range fill bar (no misleading default fill when range unavailable or zero)
    const dayHigh  = asNumber(stock.high_price);
    const dayLow   = asNumber(stock.low_price);
    const dayClose = asNumber(stock.close_price ?? stock.current_price);
    const ohlcFill  = document.getElementById('stock-ohlc-range-fill');
    const ohlcLabel = document.getElementById('stock-ohlc-range-label');
    if (ohlcFill) { ohlcFill.style.left = '0%'; ohlcFill.style.width = '0%'; }
    if (dayHigh != null && dayLow != null && dayHigh > dayLow && dayClose != null) {
      const pctDay = Math.max(0, Math.min(100, ((dayClose - dayLow) / (dayHigh - dayLow)) * 100));
      if (ohlcFill) { ohlcFill.style.left = '0%'; ohlcFill.style.width = `${pctDay.toFixed(1)}%`; }
      if (ohlcLabel) ohlcLabel.textContent = `Close at ${pctDay.toFixed(0)}% of day range`;
    } else if (dayHigh != null && dayLow != null && dayHigh === dayLow && dayClose != null) {
      if (ohlcLabel) ohlcLabel.textContent = 'Flat session (day range zero)';
    } else {
      if (ohlcLabel) ohlcLabel.textContent = 'Day range unavailable';
    }

    // Volume
    const volEl = document.getElementById('stock-volume-val');
    const volRatioEl = document.getElementById('stock-volume-ratio');
    if (volEl) {
      if (stock.volume != null && Number.isFinite(Number(stock.volume))) {
        const vol = Number(stock.volume);
        volEl.textContent = vol >= 1e7 ? `${(vol / 1e7).toFixed(2)} Cr` : vol >= 1e5 ? `${(vol / 1e5).toFixed(2)} L` : vol.toLocaleString('en-IN');
      } else {
        volEl.textContent = '—';
      }
    }
    if (volRatioEl) {
      if (stock.volume_ratio != null && Number.isFinite(Number(stock.volume_ratio))) {
        const vr = Number(stock.volume_ratio);
        volRatioEl.textContent = `(${vr.toFixed(2)}x avg)`;
        volRatioEl.className = `ml-2 text-[10px] ${vr >= 2 ? 'text-ink-sienna font-semibold' : 'text-ink-muted'}`;
      } else {
        volRatioEl.textContent = '';
      }
    }

    // ── Fundamentals (PE, PB, ROCE, D/E) ──
    const fundSection = document.getElementById('stock-fundamentals-section');
    const fundFields = [
      { boxId: 'fund-pe-box',   valId: 'fund-pe-val',   val: stock.pe_ratio,       fmt: v => v.toFixed(1)+'x' },
      { boxId: 'fund-pb-box',   valId: 'fund-pb-val',   val: stock.pb_ratio,       fmt: v => v.toFixed(2)+'x' },
      { boxId: 'fund-roce-box', valId: 'fund-roce-val', val: stock.roce,            fmt: v => v.toFixed(2)+'%' },
      { boxId: 'fund-de-box',   valId: 'fund-de-val',   val: stock.debt_to_equity, fmt: v => v.toFixed(2)+'x' },
    ];
    let visibleFunds = 0;
    fundFields.forEach(({ boxId, valId, val, fmt }) => {
      const box = document.getElementById(boxId);
      const valEl = document.getElementById(valId);
      const n = asNumber(val);
      if (n != null && box && valEl) {
        valEl.textContent = fmt(n);
        box.classList.remove('hidden');
        visibleFunds++;
      } else if (box) {
        box.classList.add('hidden');
      }
    });
    if (fundSection) {
      fundSection.classList.toggle('hidden', visibleFunds === 0);
    }
    const fundNoteEl = document.getElementById('stock-fundamentals-source-note');
    if (fundNoteEl && (stock.fundamentals_source || stock.fundamentals_as_of_date)) {
      const parts = [];
      if (stock.fundamentals_source) parts.push(`Source: ${formatFinancialSource(stock.fundamentals_source)}`);
      if (stock.fundamentals_as_of_date) parts.push(`As of: ${formatDate(stock.fundamentals_as_of_date)}`);
      fundNoteEl.textContent = `Valuation disclosures (${parts.join(' · ')}). Unavailable fields remain N/A.`;
    }

    // ── Historical Price Table (latest 10 by default + expandable full view) ──
    const histSection = document.getElementById('stock-history-section');
    const histTableWrap = document.getElementById('stock-history-table');
    const histTbody = document.getElementById('stock-history-tbody');
    const histMeta = document.getElementById('stock-history-meta');
    const histEmpty = document.getElementById('stock-history-empty');
    const histActions = document.getElementById('stock-history-actions');
    const histToggleBtn = document.getElementById('stock-history-toggle');
    const DEFAULT_HISTORY_ROWS = 10;
    const histPrices = Array.isArray(stock.historical_prices) ? stock.historical_prices : [];

    if (histSection && histTbody) {
      histSection.classList.remove('hidden');
      const validRows = [...histPrices].filter(e => e && e.date && Number.isFinite(Number(e.close))).reverse();
      if (validRows.length === 0) {
        histTbody.innerHTML = '';
        histTableWrap?.classList.add('hidden');
        histTableWrap?.classList.remove('is-expanded');
        histEmpty?.classList.remove('hidden');
        histActions?.classList.add('hidden');
        histToggleBtn?.classList.add('hidden');
        if (histMeta) histMeta.textContent = '0 sessions available';
      } else {
        histTableWrap?.classList.remove('hidden');
        histEmpty?.classList.add('hidden');
        let isExpanded = false;

        const renderHistoryRows = () => {
          const visibleRows = isExpanded ? validRows : validRows.slice(0, DEFAULT_HISTORY_ROWS);
          histTbody.innerHTML = visibleRows.map((entry, i) => {
            const prev = validRows[i + 1];
            const closeVal = Number(entry.close);
            const prevVal = prev ? Number(prev.close) : null;
            const changeVal = prevVal != null ? closeVal - prevVal : null;
            const pctChange = prevVal ? ((closeVal - prevVal) / prevVal) * 100 : null;
            const isPos = changeVal == null || changeVal === 0 ? null : changeVal > 0;
            const chgClass = isPos === true ? 'text-ink-bullish' : isPos === false ? 'text-ink-bearish' : 'text-ink-muted';
            const chgText = pctChange != null
              ? `${pctChange > 0 ? '+' : ''}${pctChange.toFixed(2)}%`
              : '—';
            return `<tr class="border-b border-ink-rule/50 hover:bg-ink-well/40 transition-colors">
              <td class="py-2 pr-4 text-[12px] text-ink-muted font-ui whitespace-nowrap">${escapeHtml(formatDate(entry.date))}</td>
              <td class="py-2 px-4 text-right text-[12px] text-ink-ink whitespace-nowrap">₹${closeVal.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="py-2 pl-4 text-right text-[11px] whitespace-nowrap ${chgClass}">${chgText}</td>
            </tr>`;
          }).join('');

          if (histTableWrap) {
            histTableWrap.classList.toggle('is-expanded', isExpanded);
          }
          if (validRows.length > DEFAULT_HISTORY_ROWS) {
            if (histMeta) {
              histMeta.textContent = isExpanded
                ? `Showing all ${validRows.length} available sessions`
                : `Showing latest ${DEFAULT_HISTORY_ROWS} of ${validRows.length} available sessions`;
            }
            if (histActions) histActions.classList.remove('hidden');
            if (histToggleBtn) {
              histToggleBtn.classList.remove('hidden');
              histToggleBtn.textContent = isExpanded
                ? `Show latest ${DEFAULT_HISTORY_ROWS} sessions`
                : `View all ${validRows.length} available sessions`;
              histToggleBtn.setAttribute('aria-expanded', String(isExpanded));
            }
          } else {
            if (histMeta) {
              histMeta.textContent = `Showing all ${validRows.length} available session${validRows.length === 1 ? '' : 's'}`;
            }
            if (histActions) histActions.classList.add('hidden');
            if (histToggleBtn) histToggleBtn.classList.add('hidden');
          }
        };

        renderHistoryRows();
        if (histToggleBtn) {
          histToggleBtn.onclick = () => {
            isExpanded = !isExpanded;
            renderHistoryRows();
            if (!isExpanded && histTableWrap) histTableWrap.scrollTop = 0;
          };
        }
      }
    }

    // 52-Week Range Bar (no misleading 50% default on missing/zero-width ranges)
    const lowVal = document.getElementById('stock-52w-low-val');
    const highVal = document.getElementById('stock-52w-high-val');
    const pin = document.getElementById('stock-52w-pin');
    const fill = document.getElementById('stock-52w-fill');
    const posText = document.getElementById('stock-52w-position-text');

    const high52 = asNumber(stock.week52_high);
    const low52 = asNumber(stock.week52_low);
    const currPrice = asNumber(stock.current_price ?? stock.close_price);

    if (fill) fill.style.width = '0%';
    if (pin) {
      pin.classList.add('hidden');
      pin.style.left = '0%';
    }

    if (high52 != null && low52 != null && high52 > low52 && currPrice != null) {
      const pct = Math.max(0, Math.min(100, ((currPrice - low52) / (high52 - low52)) * 100));
      if (lowVal) lowVal.textContent = formatPrice(low52).replace('₹', '');
      if (highVal) highVal.textContent = formatPrice(high52).replace('₹', '');
      if (pin) {
        pin.classList.remove('hidden');
        pin.style.left = `${pct.toFixed(1)}%`;
      }
      if (fill) fill.style.width = `${pct.toFixed(1)}%`;
      if (posText) posText.textContent = `${pct.toFixed(0)}% of range (${pct >= 90 ? 'Near 52W High' : pct <= 10 ? 'Near 52W Low' : 'Mid range'})`;
    } else if (high52 != null && low52 != null && high52 === low52) {
      if (lowVal) lowVal.textContent = formatPrice(low52).replace('₹', '');
      if (highVal) highVal.textContent = formatPrice(high52).replace('₹', '');
      if (posText) posText.textContent = 'Flat 52W range (high equals low)';
    } else {
      if (lowVal) lowVal.textContent = low52 != null ? formatPrice(low52).replace('₹', '') : '—';
      if (highVal) highVal.textContent = high52 != null ? formatPrice(high52).replace('₹', '') : '—';
      if (posText) posText.textContent = '52-week range unavailable';
    }

    // Watchlist Toggle
    const watchlistBtn = document.getElementById('stock-watchlist-btn');
    const watchlistStar = document.getElementById('stock-watchlist-star');
    const watchlistLabel = document.getElementById('stock-watchlist-label');

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

    if (watchlistBtn && stock.isin) {
      const stockIsin = String(stock.isin).toUpperCase();
      const updateWatchlistUi = () => {
        const wl = getWatchlist();
        const isStarred = wl.has(stockIsin);
        if (watchlistStar) {
          watchlistStar.className = isStarred ? 'text-amber-400 font-bold' : 'text-ink-muted';
        }
        if (watchlistLabel) {
          watchlistLabel.textContent = isStarred ? 'In Watchlist' : 'Watchlist';
        }
        if (isStarred) {
          watchlistBtn.className = 'stock-watchlist-btn inline-flex items-center gap-1.5 rounded-full border border-amber-400/50 bg-amber-400/10 px-3 py-1.5 text-[11px] font-semibold text-amber-400 transition-colors shadow-soft';
        } else {
          watchlistBtn.className = 'stock-watchlist-btn inline-flex items-center gap-1.5 rounded-full border border-ink-rule bg-ink-well px-3 py-1.5 text-[11px] font-semibold text-ink-muted hover:text-amber-400 hover:border-amber-400/40 transition-colors shadow-soft';
        }
      };

      updateWatchlistUi();

      watchlistBtn.onclick = () => {
        const wl = getWatchlist();
        if (wl.has(stockIsin)) wl.delete(stockIsin);
        else wl.add(stockIsin);
        saveWatchlist(wl);
        updateWatchlistUi();
      };
    }

    loading.classList.add('hidden');
    detail.classList.remove('hidden');
    updateMarketStatus(dateLabel, statsMeta);
  }

  async function updateMarketStatus(dateLabel, statsMeta = null) {
    const status = document.getElementById('market-data-status');
    const resolvedMeta = statsMeta || (typeof MARKET_STATS !== 'undefined' ? MARKET_STATS : null);
    const refreshTime = resolvedMeta?.istDisplayTime ? ` (refreshed ${resolvedMeta.istDisplayTime})` : '';
    const snapshotLabel = `Showing end-of-day snapshot${dateLabel === 'N/A' ? '' : ` for trading session ${dateLabel}`}${refreshTime}. Live prices are not connected.`;
    status.textContent = snapshotLabel;

    if (window.location.protocol === 'file:') return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch('/api/market/status', {
        headers: { Accept: 'application/json' },
        cache: 'no-cache',
        signal: controller.signal
      });
      if (!response.ok) return;
      const data = await response.json();
      if (!data || !data.ok) return;

      const expectedLabel = data.latestExpectedDate ? formatDate(data.latestExpectedDate) : null;
      if (data.isSyncing) {
        status.textContent = `${snapshotLabel} An EOD refresh is currently in progress.`;
      } else if (data.isDelayed) {
        status.textContent = `${snapshotLabel} Status: Delayed — awaiting BhavCopy publication for ${expectedLabel || 'today'}.`;
      } else if (data.needsSync) {
        status.textContent = `${snapshotLabel} Status: Stale — latest expected exchange session is ${expectedLabel || 'newer'}.`;
      } else if (data.marketCalendar && (data.marketCalendar.isWeekend || data.marketCalendar.isHoliday)) {
        status.textContent = `${snapshotLabel} Status: Current (exchange closed today).`;
      } else {
        status.textContent = `${snapshotLabel} Status: Current.`;
      }
    } catch (_) {
      // Static hosting does not provide the local market-status API; the bundled EOD data remains usable.
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function fetchLiveStockByIsin(isin) {
    if (window.location.protocol === 'file:' || !window.location.host) return null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`/api/stocks?isin=${encodeURIComponent(isin)}&limit=1`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.stocks) || data.stocks.length === 0) return null;
      const match = data.stocks.find(item => String(item.isin || '').toUpperCase() === isin);
      return match ? { stock: match, stats: data.stats || null } : null;
    } catch (_) {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function loadStaticFallbackScript() {
    if (typeof STOCKS_DATA !== 'undefined' && Array.isArray(STOCKS_DATA)) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const script = document.createElement('script');
      script.src = './js/stocks-data.js';
      script.async = true;
      script.onload = () => resolve(typeof STOCKS_DATA !== 'undefined' && Array.isArray(STOCKS_DATA));
      script.onerror = () => resolve(false);
      document.body.appendChild(script);
    });
  }

  async function fetchLiveStockHistory(isin) {
    if (window.location.protocol === 'file:' || !window.location.host) return null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`/api/market/history?isin=${encodeURIComponent(isin)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal
      });
      if (!response.ok) return null;
      const data = await response.json();
      if (!data?.ok || !Array.isArray(data.historical_prices)) return null;
      return data;
    } catch (_) {
      return null;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function init() {
    const isin = new URLSearchParams(window.location.search).get('isin');
    if (!isin || !/^[A-Z0-9]{12}$/i.test(isin.trim())) {
      setError('A valid stock ISIN was not provided in the page URL.');
      return;
    }

    const normalizedIsin = isin.trim().toUpperCase();
    const live = await fetchLiveStockByIsin(normalizedIsin);
    if (live?.stock) {
      let resolvedStock = live.stock;
      if (!Array.isArray(resolvedStock.historical_prices) || resolvedStock.historical_prices.length < 2) {
        const histData = await fetchLiveStockHistory(normalizedIsin);
        if (histData && Array.isArray(histData.historical_prices) && histData.historical_prices.length > 0) {
          resolvedStock = {
            ...resolvedStock,
            historical_prices: histData.historical_prices,
            return_1w: resolvedStock.return_1w ?? histData.return_1w ?? null,
            return_1m: resolvedStock.return_1m ?? histData.return_1m ?? null,
            return_3m: resolvedStock.return_3m ?? histData.return_3m ?? null
          };
        }
      }
      try {
        renderStock(resolvedStock, live.stats);
        return;
      } catch (_) {}
    }

    await loadStaticFallbackScript();

    if (typeof STOCKS_DATA === 'undefined' || !Array.isArray(STOCKS_DATA)) {
      setError('Stock data could not be loaded. Please return to the stock list and try again.');
      return;
    }

    const stock = STOCKS_DATA.find(item => (item.isin || '').toUpperCase() === isin.trim().toUpperCase());
    if (!stock) {
      setError('No stock with that ISIN is available in the current dataset.');
      return;
    }

    try {
      renderStock(stock);
    } catch (_) {
      setError('Stock details could not be displayed. Please return to the stock list and try again.');
    }
  }

  init();
})();
