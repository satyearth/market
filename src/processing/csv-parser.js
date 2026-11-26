'use strict';

/**
 * RFC-4180 CSV parser and normalization utilities for exchange BhavCopy data.
 */

const fs = require('fs');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSVFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCSVContent(content);
}

function parseCSVContent(content) {
  const lines = String(content || '').split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i]);
    if (vals.length === 0) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = (vals[j] || '').replace(/^"|"$/g, '').trim();
    }
    rows.push(obj);
  }
  return rows;
}

function cleanCompanyName(raw) {
  if (!raw) return '';
  let name = String(raw).trim();
  if (name === name.toUpperCase() || name.length > 5) {
    name = name
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase())
      .replace(/\bLtd\.?$/i, 'Limited')
      .replace(/\bPvt\b/gi, 'Private')
      .replace(/\bInds\.?\b/gi, 'Industries')
      .replace(/\bFin\.?\b/gi, 'Finance')
      .replace(/\bInfra\.?\b/gi, 'Infrastructure')
      .replace(/\bCorp\.?\b/gi, 'Corporation')
      .replace(/\bPharm\.?\b/gi, 'Pharmaceuticals')
      .replace(/\bTech\.?\b/gi, 'Technologies')
      .replace(/\bMfg\.?\b/gi, 'Manufacturing')
      .replace(/\bEngg\.?\b/gi, 'Engineering')
      .replace(/\bHldg\.?\b/gi, 'Holdings')
      .replace(/\bChem\.?\b/gi, 'Chemicals')
      .replace(/\bEnterp\.?\b/gi, 'Enterprises')
      .replace(/\bEnt\.?\b/gi, 'Enterprises')
      .replace(/\bLab\.?\b/gi, 'Laboratories')
      .replace(/\bLabs\b/gi, 'Laboratories')
      .replace(/\bInt\.?\b/gi, 'International')
      .replace(/\bIntl\.?\b/gi, 'International')
      .replace(/\bTele\.\b/gi, 'Telecom')
      .replace(/\bCo\.$/i, 'Company')
      .replace(/\b&\b/g, '&')
      .replace(/\s*\$\s*$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return name;
}

function parseNum(val) {
  if (val === undefined || val === null || val === '' || val === '-') return null;
  const n = Number(String(val).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseDateStr(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const dmyNum = str.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (dmyNum) {
    return `${dmyNum[3]}-${dmyNum[2]}-${dmyNum[1]}`;
  }
  const m = str.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (m) {
    const months = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
    };
    const mm = months[m[2].toLowerCase()];
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

module.exports = {
  parseCSVLine,
  parseCSVContent,
  parseCSVFile,
  cleanCompanyName,
  parseNum,
  parseDateStr
};
