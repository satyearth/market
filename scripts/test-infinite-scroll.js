'use strict';

const assert = require('assert');
const server = require('../server');
const { chromium } = require('playwright');
const stocksFunction = require('../api/stocks');

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const first = await (await fetch(`${origin}/api/stocks?limit=50&offset=0`)).json();
    assert.equal(first.stocks.length, 50);
    assert.equal(first.total, 5389);
    assert(first.hasMore);
    const capped = await (await fetch(`${origin}/api/stocks?limit=500&offset=0`)).json();
    assert.equal(capped.stocks.length, 50, 'endpoint caps every response at 50 items');
    const ids = new Set(first.stocks.map(stock => stock.isin));
    const second = await (await fetch(`${origin}/api/stocks?limit=50&offset=50`)).json();
    assert.equal(second.stocks.length, 50);
    assert(second.stocks.every(stock => !ids.has(stock.isin)));
    assert.equal((await (await fetch(`${origin}/api/stocks?search=INE002A01018`)).json()).stocks[0].symbol, 'RELIANCE');
    assert.equal((await (await fetch(`${origin}/api/stocks?search=Tata%20Consultancy`)).json()).stocks[0].symbol, 'TCS');
    assert.equal((await (await fetch(`${origin}/api/stocks?filter=TOP%20GAINERS`)).json()).stocks[0].change_percent > 0, true);
    assert.equal((await (await fetch(`${origin}/api/stocks?exchange=NSE`)).json()).total, 3191);
    assert.equal((await (await fetch(`${origin}/api/stocks?exchange=BSE`)).json()).total, 4702);
    const sorted = await (await fetch(`${origin}/api/stocks?sort=symbol&direction=asc`)).json();
    assert.equal(sorted.stocks[0].symbol, '1STCUS');
    const empty = await (await fetch(`${origin}/api/stocks?search=this-company-should-not-exist`)).json();
    assert.equal(empty.stocks.length, 0);
    assert.equal(empty.hasMore, false);
    let serverlessPayload, serverlessStatus;
    stocksFunction({ method: 'GET', query: { limit: '50', offset: '0' } }, {
      setHeader() {}, status(code) { serverlessStatus = code; return this; }, json(payload) { serverlessPayload = payload; }
    });
    assert.equal(serverlessStatus, 200);
    assert.equal(serverlessPayload.stocks.length, 50);

    const all = new Set();
    let offset = 0, batches = 0, ended = false;
    while (!ended) {
      const response = await (await fetch(`${origin}/api/stocks?limit=50&offset=${offset}`)).json();
      batches++;
      response.stocks.forEach(stock => {
        assert(stock.isin);
        assert(!all.has(stock.isin), `duplicate ISIN ${stock.isin}`);
        all.add(stock.isin);
      });
      offset = response.nextOffset;
      ended = !response.hasMore;
    }
    assert.equal(all.size, 5389);
    assert.equal(batches, 108);
    assert.equal(offset, 5389);
    console.log(`PASS: API returned all ${all.size} unique ISINs in ${batches} batches; NSE/BSE totals and filters match.`);

    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    page.on('pageerror', error => console.error('Browser page error:', error.message));
    page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
    await page.route('**/api/market/status', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, needsSync: false, isSyncing: false, isUpToDate: true, tradingDate: '2026-11-04' }) }));
    let failFirstRequest = true;
    await page.route('**/api/stocks*', async route => {
      if (failFirstRequest) { failFirstRequest = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"ok":false}' }); }
      return route.continue();
    });
    await page.goto(origin);
    await page.waitForSelector('#infinite-retry');
    await page.locator('#infinite-retry').click();
    await page.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length >= 50);
    assert.equal(await page.locator('#stocks-tbody tr[data-row-isin]').count(), 50);
    assert.equal(await page.locator('#pagination-controls, .page-prev-btn, .page-next-btn').count(), 0);
    assert.equal(await page.locator('#stocks-tbody tr[data-row-isin]').first().getAttribute('data-row-isin'), 'INE002A01018');

    await page.locator('input[data-stocks-search="true"]').fill('Tata Consultancy');
    await page.waitForFunction(() => document.querySelector('#stocks-tbody tr[data-row-isin]')?.innerText.includes('Tata Consultancy Services'));
    assert.equal(await page.locator('#stocks-tbody tr[data-row-isin]').count(), 1);
    await page.locator('input[data-stocks-search="true"]').fill('');
    await page.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length === 50);
    await page.locator('.filter-pill-btn').nth(1).click();
    await page.waitForFunction(() => document.querySelector('#stocks-tbody tr[data-row-isin]'));
    assert((await page.locator('#stocks-tbody tr[data-row-isin]').first().innerText()).includes('+'), 'gainers filter sorts positive movers first');
    await page.locator('.filter-pill-btn').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length === 50);
    const sortResponse = page.waitForResponse(response => response.url().includes('/api/stocks?') && response.url().includes('sort=symbol'));
    await page.locator('th[data-col="Stock"]').click();
    const sortedResponse = await sortResponse;
    const sortedPage = await sortedResponse.json();
    assert.equal(sortedPage.stocks[0].symbol, '1STCUS');
    await page.waitForFunction(isin => document.querySelector('#stocks-tbody tr[data-row-isin]')?.getAttribute('data-row-isin') === isin, sortedPage.stocks[0].isin, { timeout: 10000 });
    await page.locator('#infinite-sentinel').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length > 50, { timeout: 10000 });
    assert(await page.locator('#stocks-tbody tr[data-row-isin]').count() > 50, 'intersection observer loads next batch');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'mobile viewport has no horizontal overflow');

    console.log(`PASS: first/next 50, search, category filters, exchange coverage, ${all.size} unique ISINs in ${batches} batches, retry, automatic scrolling, mobile layout, no pagination controls.`);
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
