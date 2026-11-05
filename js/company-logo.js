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

  function fallbackMarkup(name, size, label) {
    const isLarge = size === 'lg';
    return `<span class="stock-logo-wrap ${label} inline-flex ${isLarge ? 'h-11 w-11 rounded-lg text-[13px]' : 'h-6 w-6 rounded-md text-[9px]'} shrink-0 items-center justify-center overflow-hidden border border-ink-rule bg-ink-inset font-ui font-semibold uppercase leading-none tracking-[0.01em] text-ink-muted" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
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
    if (!url || failedIsins.has(isin)) return fallbackMarkup(name, size, label);

    const box = size === 'lg'
      ? 'h-11 w-11 rounded-lg border-ink-rule bg-ink-paper'
      : 'h-6 w-6 rounded-md border-ink-rule bg-ink-paper';
    const alt = escapeHtml(name ? `${name} logo` : 'Company logo');
    return `<span class="stock-logo-wrap relative inline-flex ${box} shrink-0 items-center justify-center overflow-hidden border" data-company-logo="${escapeHtml(isin)}"><img class="company-logo-image block h-full w-full object-contain" src="${escapeHtml(url)}" alt="${alt}" data-logo-isin="${escapeHtml(isin)}" loading="${size === 'lg' ? 'eager' : 'lazy'}" decoding="async" width="${size === 'lg' ? 44 : 24}" height="${size === 'lg' ? 44 : 24}">${fallbackMarkup(name, size, `${label} hidden`)}</span>`;
  }

  function handleFailure(event) {
    const image = event.target;
    if (!image || !image.matches || !image.matches('img[data-logo-isin]')) return;
    const isin = image.getAttribute('data-logo-isin');
    rememberFailure(isin);
    image.hidden = true;
    const fallback = image.nextElementSibling;
    if (fallback) fallback.classList.remove('hidden');
  }

  readFailures();
  if (global.document) global.document.addEventListener('error', handleFailure, true);
  global.CompanyLogo = Object.freeze({ render, initials, handleFailure, verifiedCount: Object.keys(manifest).length });
})(typeof window !== 'undefined' ? window : globalThis);
