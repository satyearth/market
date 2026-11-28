'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AUDIT_PATH = path.join(ROOT, 'docs', 'reports', 'logo-verification-audit-2026-11-05.json');
const SUPPLEMENTAL_AUDIT_PATH = path.join(ROOT, 'docs', 'reports', 'logo-supplemental-audit-2026-11-28.json');
const OUTPUT_PATH = path.join(ROOT, 'js', 'company-logo-manifest.js');
const BASE_EXPECTED = { official_logo: 5096, monogram: 239, not_found: 54 };

const audit = JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8'));
if (audit.stocks.length !== 5389) throw new Error(`Expected 5,389 audit records, found ${audit.stocks.length}`);

const manifest = Object.create(null);
const counts = { official_logo: 0, monogram: 0, not_found: 0 };
for (const stock of audit.stocks) {
  const isin = String(stock.isin || '').trim().toUpperCase();
  const request = stock.primaryRequest;
  if (!/^[A-Z0-9]{12}$/.test(isin) || Object.prototype.hasOwnProperty.call(manifest, isin)) {
    throw new Error(`Invalid or duplicate ISIN in audit: ${isin || '(empty)'}`);
  }
  const kind = request?.classification;
  if (!Object.prototype.hasOwnProperty.call(BASE_EXPECTED, kind)) {
    throw new Error(`Unexpected primary logo classification for ${isin}: ${kind}`);
  }
  if (kind === 'not_found') {
    if (request.finalStatus !== 404 || stock.isinFallback?.finalStatus !== 404) {
      throw new Error(`Missing-logo result is not confirmed for ${isin}`);
    }
    manifest[isin] = [0, ''];
  } else {
    const expectedKind = kind === 'official_logo' ? 'official_logo' : 'monogram';
    if (request.finalStatus !== 200 || !/^https:\/\/api\.dharun\.dev\/v1\/logos\//.test(request.url || '')) {
      throw new Error(`Unverified logo URL for ${isin}`);
    }
    manifest[isin] = [expectedKind === 'official_logo' ? 1 : 2, request.url];
  }
  counts[kind]++;
}
for (const [kind, expected] of Object.entries(BASE_EXPECTED)) {
  if (counts[kind] !== expected) throw new Error(`${kind}: expected ${expected}, got ${counts[kind]}`);
}

if (fs.existsSync(SUPPLEMENTAL_AUDIT_PATH)) {
  const sup = JSON.parse(fs.readFileSync(SUPPLEMENTAL_AUDIT_PATH, 'utf8'));
  const entries = Array.isArray(sup.entries) ? sup.entries : [];
  for (const entry of entries) {
    const isin = String(entry.isin || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{12}$/.test(isin) || Object.prototype.hasOwnProperty.call(manifest, isin)) {
      throw new Error(`Invalid or duplicate supplemental ISIN in audit: ${isin || '(empty)'}`);
    }
    if (entry.type === 1) {
      if (entry.httpStatus !== 200 || !/^https:\/\/api\.dharun\.dev\/v1\/logos\//.test(entry.url || '')) {
        throw new Error(`Unverified supplemental official logo URL for ${isin}`);
      }
      manifest[isin] = [1, entry.url];
      counts.official_logo++;
    } else if (entry.type === 2) {
      if (entry.httpStatus !== 200 || !/^https:\/\/api\.dharun\.dev\/v1\/logos\//.test(entry.url || '')) {
        throw new Error(`Unverified supplemental monogram URL for ${isin}`);
      }
      manifest[isin] = [2, entry.url];
      counts.monogram++;
    } else {
      manifest[isin] = [0, ''];
      counts.not_found++;
    }
  }
}

const output = `/* Generated from the verified per-stock logo audit. Do not edit URLs by hand. */\nwindow.COMPANY_LOGO_MANIFEST=${JSON.stringify(manifest)};\n`;
fs.writeFileSync(OUTPUT_PATH, output, 'utf8');
console.log(`Wrote ${OUTPUT_PATH}: ${counts.official_logo} official logos, ${counts.monogram} API monograms, ${counts.not_found} confirmed missing.`);
