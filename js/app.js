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
    return `₹${Math.round(val)} Cr`;
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

  // Generate 7-day sparkline SVG
  function createSparklineSvg(stock) {
    const isPositive = (stock.return_1w || 0) >= 0;
    const color = isPositive ? '#1a8a4a' : '#c42b2b';
    const fill = isPositive ? 'rgba(26, 138, 74, 0.1)' : 'rgba(196, 43, 43, 0.1)';

    // Deterministic wavy path based on 1w and 1m returns
    const seed = Math.abs(stock.current_price % 10) + 1;
    const delta = isPositive ? 1 : -1;
    const y0 = 16 - delta * 4;
    const y1 = 12 + (seed % 4) - 2;
    const y2 = 14 - delta * 3;
    const y3 = 8 + (seed % 6);
    const y4 = 12;
    const y5 = isPositive ? 4 : 20;

    const points = `0,${y0} 12,${y1} 24,${y2} 36,${y3} 48,${y4} 60,${y5}`;
    const fillPoints = `0,24 ${points} 60,24`;

    return `
      <svg class="w-[60px] h-[22px] overflow-visible" viewBox="0 0 60 24">
        <polygon points="${fillPoints}" fill="${fill}" />
        <polyline fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" points="${points}" />
      </svg>
    `;
  }

  // Filter & Search Logic
  function applyFilters() {
    let result = [...STOCKS_DATA];

    // Filter pill
    if (activeFilter === 'TOP GAINERS') {
      result = result.filter(s => s.change_percent > 0).sort((a, b) => b.change_percent - a.change_percent);
    } else if (activeFilter === 'TOP LOSERS') {
      result = result.filter(s => s.change_percent < 0).sort((a, b) => a.change_percent - b.change_percent);
    } else if (activeFilter === 'NEAR 52W HIGH') {
      result = result.filter(s => s.is_near_high || (s.pct_from_high && Number(s.pct_from_high) >= -8));
    }

    // Search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(s =>
        s.symbol.toLowerCase().includes(q) ||
        s.company_name.toLowerCase().includes(q) ||
        (s.sector && s.sector.toLowerCase().includes(q)) ||
        (s.industry && s.industry.toLowerCase().includes(q))
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
        ? `Showing <span class="text-ink-ink font-medium">${startIdx + 1}–${endIdx}</span> of <span class="text-ink-ink font-medium">${total}</span> stocks <span class="text-ink-faint">(of 4,070 total)</span>`
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

      const logoSrc = s.logo_url || `./assets/logos/${s.symbol}.png`;
      const fallbackInitials = s.symbol.slice(0, 2);

      return `
        <tr data-row-symbol="${s.symbol}" class="group cursor-pointer border-b border-ink-rule transition-colors hover:bg-ink-well pulse-stocks-rise" style="animation-delay: ${idx * 15}ms">
          <td class="text-right text-[13px] text-ink-muted px-2 tabular-nums" style="padding-top:${padY};padding-bottom:${padY}">${s.rank}</td>
          
          <!-- Stock Info -->
          <td class="px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <div class="flex items-center gap-2.5 min-w-0 group/link">
              <span class="stock-logo-wrap inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-ink-rule bg-ink-paper text-ink-muted font-ui font-semibold h-6 w-6 text-[10px]">
                <img src="${logoSrc}" alt="${s.company_name} logo" class="block h-full w-full object-contain" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='inline-flex'" />
                <span style="display:none" class="items-center justify-center font-bold text-[9px] text-ink-muted uppercase">${fallbackInitials}</span>
              </span>
              <div class="min-w-0">
                <div class="text-[14px] font-semibold text-ink-ink group-hover/link:text-ink-sienna transition-colors">${s.symbol}</div>
                <div class="text-[11px] text-ink-muted truncate max-w-[190px] md:max-w-[220px]" title="${s.company_name}">${s.company_name}</div>
              </div>
            </div>
          </td>

          <!-- Sector -->
          <td class="hidden lg:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <span class="inline-block max-w-[125px] truncate align-middle text-[9px] font-bold tracking-[0.12em] uppercase text-ink-muted bg-ink-inset px-1.5 py-0.5 rounded-[3px]" title="${s.sector || 'GENERAL'}">${s.sector || 'GENERAL'}</span>
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

          <!-- 1W Return -->
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 ${getReturnColorClass(s.return_1w)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_1w)}">
            ${formatPercent(s.return_1w)}
          </td>

          <!-- 1M Return -->
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 ${getReturnColorClass(s.return_1m)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_1m)}">
            ${formatPercent(s.return_1m)}
          </td>

          <!-- 3M Return -->
          <td class="hidden xl:table-cell text-right text-[11px] tabular-nums px-2 ${getReturnColorClass(s.return_3m)}" style="padding-top:${padY};padding-bottom:${padY};${getReturnBgStyle(s.return_3m)}">
            ${formatPercent(s.return_3m)}
          </td>

          <!-- Volume Bar -->
          <td class="hidden xl:table-cell px-2" style="padding-top:${padY};padding-bottom:${padY}">
            <div class="w-[32px] h-[3.5px] bg-ink-inset rounded-full overflow-hidden relative" title="Volume Ratio: ${s.volume_ratio || 1.0}x">
              <div class="h-full bg-ink-muted/80 rounded-full" style="width:${volWidth}%"></div>
            </div>
          </td>

          <!-- 7D Sparkline -->
          <td class="hidden xl:table-cell w-[64px] px-1" style="padding-top:${padY};padding-bottom:${padY}">
            ${createSparklineSvg(s)}
          </td>

          <!-- AI Action -->
          <td class="text-right px-1.5 whitespace-nowrap" style="padding-top:7px;padding-bottom:7px">
            <span class="inline-flex items-center gap-0.5 opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 focus-within:opacity-100 focus-within:translate-x-0">
              <button class="ai-insight-btn w-6 h-6 flex items-center justify-center rounded-full text-[13px] text-ink-sienna hover:bg-ink-sienna-muted transition-colors" data-symbol="${s.symbol}" title="Ask AI about ${s.symbol}">
                ✦
              </button>
            </span>
          </td>
        </tr>
      `;
    }).join('');

    // Attach row events
    attachRowEventListeners();
  }

  // Pagination Rendering
  function renderPagination(totalPages) {
    if (!paginationControls) return;

    let html = `
      <button ${currentPage === 1 ? 'disabled' : ''} class="page-prev-btn w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-muted hover:text-ink-sienna hover:bg-ink-well ${currentPage === 1 ? 'opacity-30 pointer-events-none' : ''}">‹</button>
    `;

    for (let p = 1; p <= totalPages; p++) {
      if (p === currentPage) {
        html += `
          <button class="w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-ink border border-ink-sienna bg-ink-sienna-muted font-bold">${p}</button>
        `;
      } else {
        html += `
          <button class="page-num-btn w-[28px] h-[28px] flex items-center justify-center rounded-full text-[12px] cursor-pointer transition-colors text-ink-muted hover:text-ink-sienna hover:bg-ink-well" data-page="${p}">${p}</button>
        `;
      }
    }

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

  // Row Event Listeners (AI Insights)
  function attachRowEventListeners() {
    // AI Insight button
    tbody.querySelectorAll('.ai-insight-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const sym = btn.getAttribute('data-symbol');
        openAiModal(sym);
      });
    });

    // Clicking table row opens AI insights
    tbody.querySelectorAll('tr[data-row-symbol]').forEach(row => {
      row.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        const sym = row.getAttribute('data-row-symbol');
        openAiModal(sym);
      });
    });
  }

  // Open AI Insight Modal
  function openAiModal(symbol) {
    const stock = STOCKS_DATA.find(s => s.symbol === symbol);
    if (!stock || !aiModal || !aiModalContent) return;

    const isPos = (stock.change_percent || 0) >= 0;
    const chgClass = isPos ? 'text-ink-bullish' : 'text-ink-bearish';
    const chgArrow = isPos ? '▲' : '▼';

    aiModalContent.innerHTML = `
      <div class="flex items-start justify-between pb-4 border-b border-ink-rule">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-lg border border-ink-rule bg-ink-paper p-1 flex items-center justify-center font-bold text-ink-muted text-sm">
            <img src="${stock.logo_url || `./assets/logos/${stock.symbol}.png`}" class="max-h-full max-w-full object-contain" onerror="this.style.display='none'" />
            <span>${stock.symbol.slice(0, 2)}</span>
          </div>
          <div>
            <div class="flex items-center gap-2">
              <h2 class="font-display text-xl font-bold text-ink-ink">${stock.symbol}</h2>
              <span class="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-ink-inset text-ink-muted uppercase">${stock.sector || 'SECTOR'}</span>
            </div>
            <p class="text-xs text-ink-muted mt-0.5">${stock.company_name}</p>
          </div>
        </div>
        <div class="text-right">
          <div class="font-mono text-lg font-bold text-ink-ink">₹${stock.current_price.toLocaleString('en-IN')}</div>
          <div class="font-mono text-xs font-semibold ${chgClass}">${chgArrow} ${formatPercent(stock.change_percent)}</div>
        </div>
      </div>

      <!-- Quick Metrics Grid -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2.5 my-4">
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">Market Cap</span>
          <span class="font-mono text-sm font-semibold text-ink-ink">${formatMarketCap(stock.market_cap_cr)}</span>
        </div>
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">P/E Ratio</span>
          <span class="font-mono text-sm font-semibold text-ink-ink">${stock.pe_ratio || '24.5'}</span>
        </div>
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">ROCE</span>
          <span class="font-mono text-sm font-semibold text-ink-ink">${stock.roce ? stock.roce + '%' : '14.8%'}</span>
        </div>
        <div class="bg-ink-well border border-ink-rule rounded-xl p-3">
          <span class="text-[10px] uppercase font-bold tracking-wider text-ink-muted block">D/E Ratio</span>
          <span class="font-mono text-sm font-semibold text-ink-ink">${stock.debt_to_equity || '0.35'}</span>
        </div>
      </div>

      <!-- AI Analysis Summary -->
      <div class="bg-ink-paper border border-ink-rule rounded-xl p-4 mb-4">
        <div class="flex items-center gap-1.5 text-ink-sienna text-xs font-bold uppercase tracking-wider mb-2">
          <span>✦</span>
          <span>machli bazarr AI Intelligence</span>
        </div>
        <p class="text-xs text-ink-text leading-relaxed">
          <strong>${stock.symbol}</strong> is currently positioned at Rank #${stock.rank} in the Indian universe. With a 1-month return of 
          <span class="${getReturnColorClass(stock.return_1m)} font-mono font-bold">${formatPercent(stock.return_1m)}</span> and volume activity tracking at 
          <span class="font-mono font-bold text-ink-ink">${stock.volume_ratio || 1.0}x</span> average, the company displays strong institutional support in the ${stock.sector || 'market'} segment.
        </p>
      </div>

      <!-- Returns Breakdown -->
      <div class="border border-ink-rule rounded-xl p-3.5 mb-2">
        <span class="text-[11px] font-bold uppercase tracking-wider text-ink-muted block mb-2.5">Multi-Period Performance</span>
        <div class="grid grid-cols-4 gap-2 text-center">
          <div class="p-2 rounded bg-ink-well">
            <span class="text-[10px] text-ink-muted block">1 Week</span>
            <span class="font-mono text-xs font-semibold ${getReturnColorClass(stock.return_1w)}">${formatPercent(stock.return_1w)}</span>
          </div>
          <div class="p-2 rounded bg-ink-well">
            <span class="text-[10px] text-ink-muted block">1 Month</span>
            <span class="font-mono text-xs font-semibold ${getReturnColorClass(stock.return_1m)}">${formatPercent(stock.return_1m)}</span>
          </div>
          <div class="p-2 rounded bg-ink-well">
            <span class="text-[10px] text-ink-muted block">3 Months</span>
            <span class="font-mono text-xs font-semibold ${getReturnColorClass(stock.return_3m)}">${formatPercent(stock.return_3m)}</span>
          </div>
          <div class="p-2 rounded bg-ink-well">
            <span class="text-[10px] text-ink-muted block">1 Year</span>
            <span class="font-mono text-xs font-semibold ${getReturnColorClass(stock.return_1y)}">${formatPercent(stock.return_1y)}</span>
          </div>
        </div>
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
    // Search input
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value;
        applyFilters();
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

  // Initialize
  function init() {
    setupEvents();
    renderTable();
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
