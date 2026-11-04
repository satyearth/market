const fs = require('fs');
const path = require('path');

const targetPath = path.join(__dirname, '..', 'js', 'stocks-data.js');
const content = fs.readFileSync(targetPath, 'utf-8');

const match = content.match(/const STOCKS_DATA = (\[[\s\S]*?\]);\s*$/);
const statsMatch = content.match(/const MARKET_STATS = (\{[\s\S]*?\});/);

if (!match || !statsMatch) {
  console.error('FAIL: Could not parse STOCKS_DATA or MARKET_STATS');
  process.exit(1);
}

const stocks = eval('(' + match[1] + ')');
const stats = eval('(' + statsMatch[1] + ')');

console.log('--- VERIFICATION SUITE ---');
console.log('Total stocks:', stocks.length);
console.log('Market stats stockCount:', stats.stockCount);

let validIsin = 0;
let dualListed = 0;
let nseOnly = 0;
let bseOnly = 0;
let smeCount = 0;
let mainboardCount = 0;
let nullMcap = 0;
let verifiedMcap = 0;
let inventedNseSymbolOnBseOnly = 0;
let inventedBseCodeOnNseOnly = 0;

stocks.forEach(s => {
  if (s.isin && (s.isin.startsWith('INE') || s.isin.startsWith('IN9')) && s.isin.length === 12) {
    validIsin++;
  }
  if (s.exchanges.includes('NSE') && s.exchanges.includes('BSE')) {
    dualListed++;
    if (!s.nse_symbol || !s.bse_scrip_code) {
      console.error('FAIL: Dual listed missing code:', s.symbol);
    }
  } else if (s.exchanges.includes('NSE')) {
    nseOnly++;
    if (s.bse_scrip_code !== null) inventedBseCodeOnNseOnly++;
  } else if (s.exchanges.includes('BSE')) {
    bseOnly++;
    if (s.nse_symbol !== null) inventedNseSymbolOnBseOnly++;
  }

  if (s.segment === 'SME') smeCount++;
  else mainboardCount++;

  if (s.market_cap_cr === null) {
    nullMcap++;
    if (s.rank !== null) {
      console.error('FAIL: Stock with null mcap has non-null rank:', s.symbol);
    }
  } else {
    verifiedMcap++;
  }
});

console.log('Valid Equity ISINs (12 chars INE/IN9):', validIsin, `(${validIsin === stocks.length ? 'PASS' : 'FAIL'})`);
console.log('Dual-listed count:', dualListed);
console.log('NSE-only count:', nseOnly);
console.log('BSE-only count:', bseOnly);
console.log('Mainboard count:', mainboardCount);
console.log('SME count:', smeCount);
console.log('Verified market cap count:', verifiedMcap);
console.log('Null market cap count (rendered as —):', nullMcap);
console.log('Invented NSE symbol on BSE-only:', inventedNseSymbolOnBseOnly, `(${inventedNseSymbolOnBseOnly === 0 ? 'PASS' : 'FAIL'})`);
console.log('Invented BSE code on NSE-only:', inventedBseCodeOnNseOnly, `(${inventedBseCodeOnNseOnly === 0 ? 'PASS' : 'FAIL'})`);

if (validIsin === stocks.length && inventedNseSymbolOnBseOnly === 0 && inventedBseCodeOnNseOnly === 0) {
  console.log('\nALL VERIFICATION CHECKS PASSED SUCCESSFULLY!');
} else {
  console.error('\nSOME VERIFICATION CHECKS FAILED!');
  process.exit(1);
}
