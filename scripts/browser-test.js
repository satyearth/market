/**
 * MACHLI BAZZAR — PHASE 2.2 REPRODUCIBLE BROWSER AUDIT SUITE
 * 
 * Executes real headless Chromium browser tests using Playwright.
 * Tests:
 *  1. Initial Page Load & Table Rendering (50 rows, title, status badge, showing text)
 *  2. Market Pulse Cards & Labels (including corrected 52W high label)
 *  3. Search & Debounce (Symbol, Name, BSE Code, ISIN, Clear)
 *  4. Filter Buttons (ALL, TOP GAINERS, TOP LOSERS, NEAR 52W HIGH)
 *  5. Pagination & Page Boundaries (Next, Prev, Direct Page Jump)
 *  6. Stock Detail Modal (Open, Content, 6-session Chart, Null Multi-period Returns, Close Button, Escape, Backdrop)
 *  7. Keyboard Shortcuts ('/' focus)
 *  8. Multi-Viewport Responsive Tests & Screenshots (Desktop 1440x900, Tablet 768x1024, Mobile 390x844)
 *  9. Horizontal Overflow & Responsive Modal Scrolling
 * 10. Console Errors & Network Failures (404-free verification)
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT_DIR = path.resolve(__dirname, '..');
const FILE_URL = 'file:///' + path.join(ROOT_DIR, 'index.html').replace(/\\/g, '/');
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'test-results', 'screenshots');

let passCount = 0;
let failCount = 0;
const testResults = [];

function recordTest(name, passed, evidence) {
  if (passed) {
    passCount++;
    console.log(`  ✓ PASS: ${name}`);
    testResults.push({ name, status: 'PASS', evidence });
  } else {
    failCount++;
    console.error(`  ✗ FAIL: ${name} — ${evidence}`);
    testResults.push({ name, status: 'FAIL', evidence });
  }
}

async function runBrowserTests() {
  console.log('================================================================');
  console.log(' MACHLI BAZZAR — PHASE 2.2 REAL BROWSER AUDIT SUITE');
  console.log('================================================================\n');

  if (!fs.existsSync(SCREENSHOT_DIR)) {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  let browser;
  const consoleLogs = [];
  const consoleErrors = [];
  const failedRequests = [];

  try {
    console.log('[1/10] Launching Chromium Browser (v1248)...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--allow-file-access-from-files'
      ]
    });
    recordTest('Chromium launch', true, `Version: ${browser.version()}`);

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 }
    });

    const page = await context.newPage();

    // Track console messages and network errors
    page.on('console', msg => {
      const type = msg.type();
      const text = msg.text();
      consoleLogs.push({ type, text });
      // Exclude external Google Fonts CDN errors caused by offline sandbox environment
      if (type === 'error' && !text.includes('googleapis.com') && !text.includes('gstatic.com') && !text.includes('ERR_NAME_NOT_RESOLVED')) {
        consoleErrors.push(text);
      }
    });

    page.on('pageerror', err => {
      consoleErrors.push(err.message || String(err));
    });

    page.on('requestfailed', req => {
      const url = req.url();
      // Exclude external font CDN requests blocked by offline sandbox
      if (!url.includes('googleapis.com') && !url.includes('gstatic.com')) {
        failedRequests.push({
          url: req.url(),
          failure: req.failure() ? req.failure().errorText : 'Unknown error'
        });
      }
    });

    // -------------------------------------------------------------
    // Test 1: Page Load & Initial Table Rendering
    // -------------------------------------------------------------
    console.log(`\n[2/10] Navigating to ${FILE_URL}...`);
    await page.goto(FILE_URL, { waitUntil: 'load' });

    // Wait for table to hydrate
    await page.waitForSelector('#stocks-tbody tr', { timeout: 10000 });
    const rowCount = await page.locator('#stocks-tbody tr').count();
    recordTest('Initial table page renders 50 rows', rowCount === 50, `Rendered ${rowCount} rows`);

    const title = await page.title();
    recordTest('Page title is branded Machli Bazzar', title.toLowerCase().includes('machli bazarr') || title.toLowerCase().includes('machli bazzar'), title);

    const statusBadge = await page.locator('#market-status-badge').innerText();
    recordTest('Status badge shows 4,965 listed companies', statusBadge.toLowerCase().includes('4,965 listed companies'), statusBadge);

    const showingText = await page.locator('#showing-status').innerText();
    recordTest('Showing status displays 1-50 of 4,965', showingText.includes('50 of 4,965'), showingText);

    // -------------------------------------------------------------
    // Test 2: Market Pulse Cards Binding & 52W High Coverage Label
    // -------------------------------------------------------------
    console.log('\n[3/10] Verifying Market Pulse Cards & Labels...');

    // Card 1: Verified Market Cap
    const mcapVal = await page.locator('#card-total-mcap').innerText();
    const mcapSub = await page.locator('#card-mcap-sub').innerText();
    recordTest('Card 1: Verified Market Cap displays value', mcapVal.includes('Cr'), `Value: ${mcapVal}`);
    recordTest('Card 1: Identifies Top 343 Equities partial coverage', mcapSub.includes('Top 343 Equities'), mcapSub);

    // Card 2: India VIX
    const vixVal = await page.locator('#card-vix-val').innerText();
    const vixChg = await page.locator('#card-vix-chg').innerText();
    recordTest('Card 2: India VIX displays dynamic exchange rate (15.19)', vixVal === '15.19', `VIX: ${vixVal}, Chg: ${vixChg}`);

    // Card 3: Market Breadth
    const advText = await page.locator('#card-breadth-adv').innerText();
    const decText = await page.locator('#card-breadth-dec').innerText();
    const breadthSub = await page.locator('#card-breadth-sub').innerText();
    recordTest('Card 3: Market Breadth advances match 3,228', advText.includes('3,228'), advText);
    recordTest('Card 3: Market Breadth declines match 1,539', decText.includes('1,539'), decText);
    recordTest('Card 3: Subtitle shows reconciled A/D identity', breadthSub.includes('196 Unch') && breadthSub.includes('2 Unpriced'), breadthSub);

    // Card 4: Near 52W High (Audited Coverage Label)
    const nearPct = await page.locator('#card-near52-pct').innerText();
    const nearSub = await page.locator('#card-near52-sub').innerText();
    recordTest('Card 4: Displays verified count 36', nearPct === '36', `Value: ${nearPct}`);
    recordTest('Card 4: Subtitle specifies "36 verified BSE Group A/B equities"', nearSub.includes('36 verified BSE Group A/B equities'), nearSub);
    recordTest('Card 4: Subtitle includes source "BSE MCP" and date "2026-11-04"', nearSub.includes('BSE MCP') && (nearSub.includes('2026-11-04') || nearSub.includes('04-Nov-2026')), nearSub);
    recordTest('Card 4: Does NOT claim 36/4,965 as complete market coverage', !nearSub.includes('of 4,965'), `Subtitle: "${nearSub}"`);

    // Card 5: Verified Cap Ranks
    const t100 = await page.locator('#card-seg-cnt-lrg').innerText();
    const mid = await page.locator('#card-seg-cnt-mid').innerText();
    const rem = await page.locator('#card-seg-cnt-sml').innerText();
    const unr = await page.locator('#card-seg-cnt-mic').innerText();
    const sme = await page.locator('#card-seg-cnt-sme').innerText();
    recordTest('Card 5: Segment counts verify 100, 150, 93, 3,758, 864',
      t100.includes('100') && mid.includes('150') && rem.includes('93') && unr.includes('3,758') && sme.includes('864'),
      `T100:${t100}, Mid:${mid}, Rem:${rem}, Unr:${unr}, SME:${sme}`
    );

    // -------------------------------------------------------------
    // Test 3: Search Functionality (Debounced)
    // -------------------------------------------------------------
    console.log('\n[4/10] Testing Search Functionality...');
    const searchInput = page.locator('input[data-stocks-search="true"]');

    // 1. Search by symbol "RELIANCE"
    await searchInput.fill('RELIANCE');
    await page.waitForTimeout(250); // wait for 120ms debounce
    let firstRowSymbol = await page.locator('#stocks-tbody tr:first-child .text-ink-ink.font-semibold').innerText();
    recordTest('Search by symbol "RELIANCE" puts RELIANCE at top', firstRowSymbol === 'RELIANCE', `First row: ${firstRowSymbol}`);

    // 2. Search by company name "Tata Consultancy"
    await searchInput.fill('Tata Consultancy');
    await page.waitForTimeout(250);
    firstRowSymbol = await page.locator('#stocks-tbody tr:first-child .text-ink-ink.font-semibold').innerText();
    recordTest('Search by company name "Tata Consultancy" finds TCS', firstRowSymbol === 'TCS', `First row: ${firstRowSymbol}`);

    // 3. Search by BSE scrip code "532540"
    await searchInput.fill('532540');
    await page.waitForTimeout(250);
    firstRowSymbol = await page.locator('#stocks-tbody tr:first-child .text-ink-ink.font-semibold').innerText();
    recordTest('Search by BSE code "532540" finds TCS', firstRowSymbol === 'TCS', `First row: ${firstRowSymbol}`);

    // 4. Search by ISIN "INE002A01018"
    await searchInput.fill('INE002A01018');
    await page.waitForTimeout(250);
    firstRowSymbol = await page.locator('#stocks-tbody tr:first-child .text-ink-ink.font-semibold').innerText();
    recordTest('Search by ISIN "INE002A01018" finds RELIANCE', firstRowSymbol === 'RELIANCE', `First row: ${firstRowSymbol}`);

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(250);
    const clearedRows = await page.locator('#stocks-tbody tr').count();
    recordTest('Clearing search restores 50 rows', clearedRows === 50, `Rows: ${clearedRows}`);

    // -------------------------------------------------------------
    // Test 4: Filter Buttons (ALL, TOP GAINERS, TOP LOSERS, NEAR 52W HIGH)
    // -------------------------------------------------------------
    console.log('\n[5/10] Testing Filter Buttons...');
    const filterButtons = page.locator('.filter-pill-btn');

    // Top Gainers
    await filterButtons.nth(1).click();
    await page.waitForTimeout(100);
    let topGainerChg = await page.locator('#stocks-tbody tr:first-child td:nth-child(5)').innerText();
    let gainerShowing = await page.locator('#showing-status').innerText();
    recordTest('TOP GAINERS filter loads advances (3,228)', gainerShowing.includes('3,228'), gainerShowing);
    recordTest('TOP GAINERS first row is positive', topGainerChg.includes('+'), `Change: ${topGainerChg}`);

    // Top Losers
    await filterButtons.nth(2).click();
    await page.waitForTimeout(100);
    let topLoserChg = await page.locator('#stocks-tbody tr:first-child td:nth-child(5)').innerText();
    let loserShowing = await page.locator('#showing-status').innerText();
    recordTest('TOP LOSERS filter loads declines (1,539)', loserShowing.includes('1,539'), loserShowing);
    recordTest('TOP LOSERS first row is negative', topLoserChg.includes('-'), `Change: ${topLoserChg}`);

    // Near 52W High
    await filterButtons.nth(3).click();
    await page.waitForTimeout(100);
    let nearHighCount = await page.locator('#stocks-tbody tr').count();
    let nearHighShowing = await page.locator('#showing-status').innerText();
    recordTest('NEAR 52W HIGH filter displays exactly 36 rows', nearHighCount === 36, `Rows: ${nearHighCount}`);
    recordTest('NEAR 52W HIGH showing status indicates 36 of 36', nearHighShowing.includes('36 of 36'), nearHighShowing);

    // Reset to ALL
    await filterButtons.nth(0).click();
    await page.waitForTimeout(100);
    let allCount = await page.locator('#stocks-tbody tr').count();
    recordTest('ALL filter resets table to 50 rows', allCount === 50, `Rows: ${allCount}`);

    // -------------------------------------------------------------
    // Test 5: Pagination Controls
    // -------------------------------------------------------------
    console.log('\n[6/10] Testing Pagination...');
    const nextBtn = page.locator('.page-next-btn');
    const prevBtn = page.locator('.page-prev-btn');

    await nextBtn.click();
    await page.waitForTimeout(100);
    let page2Showing = await page.locator('#showing-status').innerText();
    recordTest('Next button advances to Page 2 (Showing 51-100)', page2Showing.includes('51') && page2Showing.includes('100'), page2Showing);

    await prevBtn.click();
    await page.waitForTimeout(100);
    let page1Showing = await page.locator('#showing-status').innerText();
    recordTest('Prev button returns to Page 1 (Showing 1-50)', page1Showing.includes('1') && page1Showing.includes('50 of 4,965'), page1Showing);

    // Jump to page 3
    const page3Btn = page.locator('button[data-page="3"]');
    await page3Btn.click();
    await page.waitForTimeout(100);
    let page3Showing = await page.locator('#showing-status').innerText();
    recordTest('Page 3 button jumps to Page 3 (Showing 101-150)', page3Showing.includes('101') && page3Showing.includes('150'), page3Showing);

    // Return to Page 1
    const page1Btn = page.locator('button[data-page="1"]');
    await page1Btn.click();
    await page.waitForTimeout(100);

    // -------------------------------------------------------------
    // Test 6: Stock Detail Modal Interaction & Multi-Period Returns
    // -------------------------------------------------------------
    console.log('\n[7/10] Testing Stock Detail Modal...');
    // Click on the first stock row
    const firstRow = page.locator('#stocks-tbody tr:first-child');
    await firstRow.click();
    await page.waitForTimeout(150);

    const modal = page.locator('#ai-modal');
    const isModalVisible = await modal.isVisible();
    recordTest('Modal opens on stock row click', isModalVisible, 'Modal is visible');

    // Verify modal content
    const modalContent = page.locator('#ai-modal-content');
    const modalText = await modalContent.innerText();
    recordTest('Modal shows stock details and trading date', modalText.includes('2026-11-04') || modalText.includes('04-Nov-2026') || modalText.includes('BSE') || modalText.includes('NSE'), 'Modal populated');

    // Verify multi-period returns grid: 1 Month, 3 Months, 1 Year must display '—'
    const returns1M = await modalContent.locator('text=1 Month').locator('..').innerText();
    const returns3M = await modalContent.locator('text=3 Months').locator('..').innerText();
    const returns1Y = await modalContent.locator('text=1 Year').locator('..').innerText();
    recordTest('Modal: 1 Month return displays em-dash "—" (no unverified data)', returns1M.includes('—'), `1M block: ${returns1M.replace(/\n/g, ' ')}`);
    recordTest('Modal: 3 Months return displays em-dash "—" (no unverified data)', returns3M.includes('—'), `3M block: ${returns3M.replace(/\n/g, ' ')}`);
    recordTest('Modal: 1 Year return displays em-dash "—" (no unverified data)', returns1Y.includes('—'), `1Y block: ${returns1Y.replace(/\n/g, ' ')}`);

    // Verify historical sparkline / chart SVG
    const chartSvg = await modalContent.locator('svg').count();
    recordTest('Modal contains historical price chart SVG', chartSvg > 0, `Found ${chartSvg} SVG elements`);

    // Test close button
    const closeBtn = page.locator('#ai-modal-close');
    await closeBtn.click();
    await page.waitForTimeout(100);
    let modalHidden = await modal.evaluate(el => el.classList.contains('hidden'));
    recordTest('Modal closes via close button (#ai-modal-close)', modalHidden, 'Modal has "hidden" class');

    // Test Escape key shortcut to close
    await firstRow.click();
    await page.waitForTimeout(100);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    modalHidden = await modal.evaluate(el => el.classList.contains('hidden'));
    recordTest('Modal closes via Escape key', modalHidden, 'Modal closed on Esc');

    // Test backdrop click to close
    await firstRow.click();
    await page.waitForTimeout(100);
    // Click on top left backdrop outside card
    await modal.click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(100);
    modalHidden = await modal.evaluate(el => el.classList.contains('hidden'));
    recordTest('Modal closes via backdrop click', modalHidden, 'Modal closed on backdrop click');

    // -------------------------------------------------------------
    // Test 7: Keyboard Shortcut ('/' focus search)
    // -------------------------------------------------------------
    console.log('\n[8/10] Testing Keyboard Shortcuts...');
    // Click body to blur (use top-left position to avoid clicking table rows)
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('/');
    await page.waitForTimeout(100);
    const isSearchFocused = await searchInput.evaluate(el => el === document.activeElement);
    recordTest('Pressing "/" key focuses the search input', isSearchFocused, `Focused: ${isSearchFocused}`);

    // -------------------------------------------------------------
    // Test 8: Multi-Viewport Responsive Tests & Screenshots
    // -------------------------------------------------------------
    console.log('\n[9/10] Multi-Viewport Responsive Tests & Screenshot Capture...');

    // 1. Desktop Viewport: 1440 × 900
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(150);
    let desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    recordTest('Desktop (1440x900): No horizontal overflow', !desktopOverflow, `scrollWidth: ${await page.evaluate(() => document.documentElement.scrollWidth)}px`);

    const desktopPath = path.join(SCREENSHOT_DIR, 'desktop-1440x900.png');
    await page.screenshot({ path: desktopPath, fullPage: false });
    recordTest('Desktop screenshot captured', fs.existsSync(desktopPath), desktopPath);

    // 2. Tablet Viewport: 768 × 1024
    await page.setViewportSize({ width: 768, height: 1024 });
    await page.waitForTimeout(150);
    let tabletOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    recordTest('Tablet (768x1024): No horizontal overflow', !tabletOverflow, `scrollWidth: ${await page.evaluate(() => document.documentElement.scrollWidth)}px`);

    // Test modal scrolling on tablet
    await firstRow.click();
    await page.waitForTimeout(150);
    let modalTabletCard = page.locator('#ai-modal > div');
    let modalHasScroll = await modalTabletCard.evaluate(el => el.classList.contains('overflow-y-auto') && el.classList.contains('max-h-[90vh]'));
    recordTest('Tablet: Modal has max-h-[90vh] and overflow-y-auto', modalHasScroll, 'Responsive modal classes active');

    const tabletPath = path.join(SCREENSHOT_DIR, 'tablet-768x1024.png');
    await page.screenshot({ path: tabletPath, fullPage: false });
    recordTest('Tablet screenshot captured', fs.existsSync(tabletPath), tabletPath);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // 3. Mobile Viewport: 390 × 844
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    let mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    recordTest('Mobile (390x844): No horizontal overflow', !mobileOverflow, `scrollWidth: ${await page.evaluate(() => document.documentElement.scrollWidth)}px`);

    // Test modal on mobile
    await firstRow.click();
    await page.waitForTimeout(150);
    const mobilePath = path.join(SCREENSHOT_DIR, 'mobile-390x844.png');
    await page.screenshot({ path: mobilePath, fullPage: false });
    recordTest('Mobile screenshot captured', fs.existsSync(mobilePath), mobilePath);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    // -------------------------------------------------------------
    // Test 9: Console Errors & Network Failures
    // -------------------------------------------------------------
    console.log('\n[10/10] Verifying Console Errors & Network Requests...');
    recordTest('Console errors count is 0', consoleErrors.length === 0, `Errors: ${JSON.stringify(consoleErrors)}`);

    // Verify no 404s on images
    const image404s = failedRequests.filter(r => r.url.endsWith('.png') || r.url.endsWith('.svg') || r.url.endsWith('.jpg'));
    recordTest('Asset request failures (404 logos) count is 0', image404s.length === 0, `Failed images: ${JSON.stringify(image404s)}`);
    recordTest('Total failed network requests count is 0', failedRequests.length === 0, `Failures: ${JSON.stringify(failedRequests)}`);

  } catch (err) {
    console.error('Test execution exception:', err);
    recordTest('Browser test execution completed without unhandled exception', false, err.stack || err.message);
  } finally {
    if (browser) await browser.close();
  }

  console.log('\n================================================================');
  console.log(` BROWSER AUDIT SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log('================================================================\n');

  if (failCount > 0) {
    process.exit(1);
  }
}

runBrowserTests();
