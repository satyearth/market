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

  function field(label, value) {
    return `<div class="stock-detail-field"><dt class="stock-detail-label">${escapeHtml(label)}</dt><dd class="stock-detail-value">${escapeHtml(valueOrNA(value))}</dd></div>`;
  }

  function listingRow(label, value) {
    return `<div class="stock-listing-row"><dt class="stock-listing-label">${escapeHtml(label)}</dt><dd class="stock-listing-value">${escapeHtml(valueOrNA(value))}</dd></div>`;
  }

  function renderStock(stock) {
    const latestPrice = asNumber(stock.current_price ?? stock.close_price);
    const previousClose = asNumber(stock.prev_close);
    const change = latestPrice != null && previousClose != null ? latestPrice - previousClose : null;
    const percent = asNumber(stock.change_percent);
    const tradeDate = stock.trading_date || stock.trade_date || (typeof MARKET_STATS !== 'undefined' && MARKET_STATS.tradingDate);
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

    document.getElementById('company-info-grid').innerHTML = [
      field('Market capitalization', stock.market_cap_cr == null ? null : formatMarketCap(stock.market_cap_cr)),
      field('Sector', stock.sector),
      field('Industry', stock.industry),
      field('52-week high', stock.week52_high == null ? null : formatPrice(stock.week52_high)),
      field('52-week low', stock.week52_low == null ? null : formatPrice(stock.week52_low)),
      field('Segment', stock.segment),
      field('Series / group', stock.series),
      field('Company description', null)
    ].join('');

    const listingMarkup = [];
    if (exchanges.includes('NSE')) {
      listingMarkup.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('Exchange', 'NSE')}${listingRow('Trading symbol', stock.nse_symbol)}</dl></div>`);
    }
    if (exchanges.includes('BSE')) {
      listingMarkup.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('Exchange', 'BSE')}${listingRow('Scrip code', stock.bse_scrip_code)}</dl></div>`);
    }
    if (!listingMarkup.length) {
      listingMarkup.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('Exchange', null)}${listingRow('Trading symbol', symbol)}</dl></div>`);
    }
    listingMarkup.push(`<div class="rounded-lg border border-ink-rule bg-ink-well px-3.5"><dl>${listingRow('ISIN', stock.isin)}${listingRow('Listing status', stock.listing_status)}</dl></div>`);
    document.getElementById('exchange-listings').innerHTML = `<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">${listingMarkup.join('')}</div>`;

    loading.classList.add('hidden');
    detail.classList.remove('hidden');
    updateMarketStatus(dateLabel);
  }

  async function updateMarketStatus(dateLabel) {
    const status = document.getElementById('market-data-status');
    const snapshotLabel = `Showing the latest available end-of-day snapshot${dateLabel === 'N/A' ? '' : ` dated ${dateLabel}`}. Live prices are not connected.`;
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

      if (data.isSyncing) {
        status.textContent = `${snapshotLabel} An EOD refresh is currently in progress.`;
      } else if (data.needsSync) {
        status.textContent = `${snapshotLabel} The market status service reports that a newer session may be available.`;
      } else if (data.marketCalendar && (data.marketCalendar.isWeekend || data.marketCalendar.isHoliday)) {
        status.textContent = `${snapshotLabel} The exchange is closed today.`;
      }
    } catch (_) {
      // Static hosting does not provide the local market-status API; the bundled EOD data remains usable.
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function init() {
    const isin = new URLSearchParams(window.location.search).get('isin');
    if (!isin || !/^[A-Z0-9]{12}$/i.test(isin.trim())) {
      setError('A valid stock ISIN was not provided in the page URL.');
      return;
    }

    if (typeof STOCKS_DATA === 'undefined' || !Array.isArray(STOCKS_DATA)) {
      setError('Stock data could not be loaded. Please return to the stock list and try again.');
      return;
    }

    const stock = STOCKS_DATA.find(item => String(item.isin || '').toUpperCase() === isin.trim().toUpperCase());
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
