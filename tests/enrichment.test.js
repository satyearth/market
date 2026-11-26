'use strict';

const assert = require('assert');
const { resolveStockMarketCap, rankStocksAndCategorize } = require('../src/enrichment/market-cap');
const { enrichFundamentalsForStock } = require('../src/enrichment/fundamentals');

async function run() {
  const sources = {
    benchmarkBySymbol: new Map([['RELIANCE', { market_cap_cr: 1850000, pe_ratio: 29.1, sector: 'Energy' }]]),
    bseSecByIsin: new Map([['INE009A01021', { mktcap: 750000, industry: 'IT Consulting' }]]),
    catalogByIsin: new Map([['INE467B01029', { capCr: 1400000 }]]),
    catalogByTicker: new Map(),
    screenerBySlug: new Map()
  };

  // Tier priority & zero regression
  const cap1 = resolveStockMarketCap({ isin: 'INE002A01018', symbol: 'RELIANCE' }, sources);
  assert.strictEqual(cap1.market_cap_cr, 1850000);
  assert.strictEqual(cap1.market_cap_source, 'BENCHMARK_VERIFIED');

  const cap2 = resolveStockMarketCap({ isin: 'INE009A01021', symbol: 'INFY' }, sources);
  assert.strictEqual(cap2.market_cap_source, 'BSE_SECURITY_MASTER');

  // Missing stays null, never 0
  const capMissing = resolveStockMarketCap({ isin: 'INE999Z01099', symbol: 'DORMANT' }, sources);
  assert.strictEqual(capMissing.market_cap_cr, null);
  assert.strictEqual(capMissing.market_cap_source, null);

  // SME exclusion from Mainboard rank numbers
  const stocks = [
    { symbol: 'MAIN1', segment: 'Mainboard', market_cap_cr: 50000 },
    { symbol: 'SME1', segment: 'SME', market_cap_cr: 60000 },
    { symbol: 'UNR1', segment: 'Mainboard', market_cap_cr: null }
  ];
  const ranked = rankStocksAndCategorize(stocks);
  assert.strictEqual(ranked.segments.top100, 1);
  assert.strictEqual(ranked.segments.smePlatform, 1);
  assert.strictEqual(ranked.segments.unranked, 1);
  assert.strictEqual(stocks.find(s => s.symbol === 'SME1').rank, null);
  assert.strictEqual(stocks.find(s => s.symbol === 'MAIN1').rank, 1);

  // Cold-runner fundamental carryover + sector override
  const fund = enrichFundamentalsForStock({
    isin: 'INE982J01020', // PAYTM override
    symbol: 'PAYTM',
    nseSymbol: 'PAYTM',
    currentPrice: 800,
    prevStock: { pe_ratio: 12.3, roce: 18.4, sector: 'GENERAL' }
  });
  assert.strictEqual(fund.sector, 'Financial Services');
  assert.strictEqual(fund.pe_ratio, 12.3);
  assert.strictEqual(fund.roce, 18.4);

  // Corrupt benchmark placeholder ("General | Diversified" or "Specialized Sector") is bypassed cleanly via ISIN catalog
  const fundPower = enrichFundamentalsForStock({
    isin: 'INE245A01021',
    symbol: 'TATAPOWER',
    nseSymbol: 'TATAPOWER',
    currentPrice: 400,
    benchmark: { sector: 'Financial Services', industry: 'Specialized Sector' },
    catalogEntry: { sector: 'Utilities', industry: 'Electric Utilities' },
    prevStock: { sector: 'Financial Services', industry: 'Specialized Sector' }
  });
  assert.strictEqual(fundPower.sector, 'Power', 'Corrupted Specialized Sector benchmark must fall back to ISIN catalog Power');
  assert.strictEqual(fundPower.industry, 'Electric Utilities');

  const fundPharma = enrichFundamentalsForStock({
    isin: 'INE168P01015',
    symbol: 'EMCURE',
    nseSymbol: 'EMCURE',
    currentPrice: 1400,
    benchmark: { sector: 'General', industry: 'Diversified' },
    catalogEntry: { sector: 'Health Technology', industry: 'Pharmaceuticals: Major' },
    prevStock: { sector: 'Unclassified', industry: 'Diversified' }
  });
  assert.strictEqual(fundPharma.sector, 'Healthcare', 'General/Unclassified benchmark must resolve via ISIN catalog');
  assert.strictEqual(fundPharma.industry, 'Pharmaceuticals: Major');

  // Ambiguous or unmapped metadata stays Unclassified (zero guessing)
  const fundUnknown = enrichFundamentalsForStock({
    isin: 'INE000Z99999',
    symbol: 'UNKTEST',
    currentPrice: 50,
    catalogEntry: { sector: 'Miscellaneous', industry: 'Miscellaneous' }
  });
  assert.strictEqual(fundUnknown.sector, 'Unclassified');
}

module.exports = { name: 'enrichment.test.js', run };
