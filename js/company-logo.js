/* Shared ISIN-keyed logo renderer for the stock list and stock details page. */
(function (global) {
  'use strict';

  const manifest = global.COMPANY_LOGO_MANIFEST || Object.create(null);
  const failedIsins = new Set();
  const FAILURE_KEY = 'machii-logo-failures-v1';
  const LEGAL_SUFFIXES = new Set(['ltd', 'limited', 'pvt', 'private', 'public', 'plc', 'llp', 'inc', 'incorporated', 'company', 'co']);

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function readFailures() {
    try {
      const stored = JSON.parse(global.sessionStorage.getItem(FAILURE_KEY) || '[]');
      if (Array.isArray(stored)) stored.forEach(isin => failedIsins.add(String(isin).toUpperCase()));
    } catch (_) { /* Storage can be disabled in private browsing or embedded contexts. */ }
  }

  function rememberFailure(isin) {
    if (!isin) return;
    failedIsins.add(String(isin).toUpperCase());
    try {
      global.sessionStorage.setItem(FAILURE_KEY, JSON.stringify(Array.from(failedIsins).slice(-512)));
    } catch (_) { /* In-memory failures still prevent repeated requests until navigation. */ }
  }

  function initials(companyName) {
    const words = String(companyName || '').normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/)
      .filter(word => word && !LEGAL_SUFFIXES.has(word.toLowerCase().replace(/\.$/, '')));
    if (!words.length) return '??';
    if (words.length === 1) return Array.from(words[0]).slice(0, 2).join('').toUpperCase();
    return `${Array.from(words[0])[0]}${Array.from(words[1])[0]}`.toUpperCase();
  }

  function fallbackMarkup(name, size, label, isin) {
    const isLarge = size === 'lg';
    const dims = isLarge
      ? 'w-[48px] h-[48px] min-w-[48px] min-h-[48px] text-[14px]'
      : 'w-[32px] h-[32px] min-w-[32px] min-h-[32px] text-[11px]';
    return `<span class="stock-logo-wrap company-logo-fallback ${label} relative inline-flex ${dims} shrink-0 items-center justify-center overflow-hidden rounded-full border border-ink-rule bg-ink-inset font-ui font-semibold uppercase leading-none tracking-[0.01em] text-ink-muted select-none" data-company-logo="${escapeHtml(isin || '')}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
  }

  function render(options) {
    const settings = options || {};
    const isin = String(settings.isin || '').trim().toUpperCase();
    const name = String(settings.companyName || '').trim();
    const size = settings.size === 'lg' ? 'lg' : 'sm';
    const label = `company-logo-fallback${size === 'lg' ? ' company-logo-fallback-lg' : ''}`;
    const auditedRecord = manifest[isin];
    const suppliedRecord = settings.logoData;
    const record = Array.isArray(suppliedRecord) && auditedRecord && suppliedRecord[1] === auditedRecord[1]
      ? suppliedRecord
      : auditedRecord;
    const url = record && record[0] > 0 ? record[1] : '';
    if (!url || failedIsins.has(isin)) return fallbackMarkup(name, size, label, isin);

    const dims = size === 'lg'
      ? 'w-[48px] h-[48px] min-w-[48px] min-h-[48px]'
      : 'w-[32px] h-[32px] min-w-[32px] min-h-[32px]';
    const alt = escapeHtml(name ? `${name} logo` : 'Company logo');
    const imgSize = size === 'lg' ? 48 : 32;

    return `<span class="stock-logo-wrap relative inline-flex ${dims} shrink-0 items-center justify-center overflow-hidden rounded-full border border-ink-rule bg-ink-inset" data-company-logo="${escapeHtml(isin)}"><img class="company-logo-image block size-full object-cover rounded-full" src="${escapeHtml(url)}" alt="${alt}" data-logo-isin="${escapeHtml(isin)}" loading="${size === 'lg' ? 'eager' : 'lazy'}" decoding="async" width="${imgSize}" height="${imgSize}" onload="var f=this.nextElementSibling;if(f){f.remove();}" onerror="if(window.CompanyLogo&&window.CompanyLogo.handleFailure){window.CompanyLogo.handleFailure({target:this});}"><span class="${label} hidden absolute inset-0 flex size-full items-center justify-center rounded-full bg-ink-inset font-ui ${size === 'lg' ? 'text-[14px]' : 'text-[11px]'} font-semibold uppercase leading-none tracking-[0.01em] text-ink-muted select-none" aria-hidden="true">${escapeHtml(initials(name))}</span></span>`;
  }

  function handleFailure(event) {
    const image = event && event.target;
    if (!image || !image.matches || !image.matches('img[data-logo-isin]')) return;
    const isin = image.getAttribute('data-logo-isin');
    rememberFailure(isin);
    const parent = image.parentElement;
    image.remove();
    if (parent) {
      parent.classList.remove('bg-white');
      let fallback = parent.querySelector('.company-logo-fallback');
      if (!fallback) {
        const name = image.getAttribute('alt') || '';
        fallback = document.createElement('span');
        fallback.className = 'company-logo-fallback flex size-full items-center justify-center rounded-full bg-ink-inset font-ui text-[11px] font-semibold uppercase leading-none tracking-[0.01em] text-ink-muted select-none';
        fallback.textContent = initials(name);
        parent.appendChild(fallback);
      }
      fallback.classList.remove('hidden');
      fallback.style.display = '';
    }
  }

  readFailures();
  if (global.document) global.document.addEventListener('error', handleFailure, true);
  global.CompanyLogo = Object.freeze({ render, initials, handleFailure, rememberFailure, verifiedCount: Object.keys(manifest).length });
})(typeof window !== 'undefined' ? window : globalThis);
