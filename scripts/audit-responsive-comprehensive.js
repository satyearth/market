'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { queryStocks } = require('../lib/stocks-query');

const ROOT_DIR = path.resolve(__dirname, '..');
const INDEX_FILE_URL = 'file:///' + path.join(ROOT_DIR, 'index.html').replace(/\\/g, '/');
const STOCK_FILE_URL = 'file:///' + path.join(ROOT_DIR, 'stock.html').replace(/\\/g, '/');

const VIEWPORTS = [
  { name: 'mobile-320', width: 320, height: 600 },
  { name: 'mobile-375', width: 375, height: 667 },
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-414', width: 414, height: 896 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'laptop-1024', width: 1024, height: 768 },
  { name: 'desktop-1440', width: 1440, height: 900 },
  { name: 'desktop-1920', width: 1920, height: 1080 },
];

function handleApiStocksRoute(route, request) {
  try {
    const url = new URL(request.url(), 'http://localhost');
    const query = Object.fromEntries(url.searchParams.entries());
    const result = queryStocks(query);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(result)
    });
  } catch (err) {
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: err.message })
    });
  }
}

async function runAudit() {
  console.log('Starting Comprehensive Responsive Audit across 8 Viewports...');

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--allow-file-access-from-files'
    ]
  });

  const outDir = path.join(__dirname, '..', 'test-results', 'responsive-audit');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const results = {};
  let totalErrors = 0;

  try {
    for (const vp of VIEWPORTS) {
      console.log(`\n================ Checking Viewport: ${vp.name} (${vp.width}x${vp.height}) ================`);
      results[vp.name] = { index: {}, stock: {}, mobileNav: {} };

      const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
      const page = await context.newPage();

      // Intercept APIs
      await page.route('**/api/market/status', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          needsSync: false,
          isSyncing: false,
          isUpToDate: true,
          tradingDate: '2026-11-04'
        })
      }));

      await page.route('**/api/stocks*', (route, req) => handleApiStocksRoute(route, req));

      // 1. Check index.html
      await page.goto(INDEX_FILE_URL, { waitUntil: 'load' });
      await page.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length >= 50, { timeout: 10000 });
      await page.waitForTimeout(300);

      const indexMetrics = await page.evaluate(() => {
        const docW = document.documentElement.scrollWidth;
        const bodyW = document.body.scrollWidth;
        const winW = window.innerWidth;
        const hasHScroll = docW > winW || bodyW > winW;

        // Find visible elements that overflow window width
        const overflowing = [];
        document.querySelectorAll('body *').forEach(el => {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
          const r = el.getBoundingClientRect();
          if (r.right > winW + 1.5 && r.width > 0) {
            overflowing.push({
              tag: el.tagName,
              id: el.id,
              className: el.className ? String(el.className).slice(0, 50) : '',
              right: Math.round(r.right),
              width: Math.round(r.width),
              winW
            });
          }
        });

        // Check touch target sizes of interactive elements
        const smallTouchTargets = [];
        document.querySelectorAll('button, a, input, select, [role="button"]').forEach(el => {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
          if (el.classList.contains('sr-only')) return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40)) {
            smallTouchTargets.push({
              tag: el.tagName,
              text: el.textContent ? el.textContent.trim().slice(0, 30) : '',
              id: el.id,
              className: el.className ? String(el.className).slice(0, 40) : '',
              w: Math.round(r.width),
              h: Math.round(r.height)
            });
          }
        });

        const headerHeight = document.querySelector('header')?.getBoundingClientRect().height;
        const brandRect = document.querySelector('header a')?.getBoundingClientRect();

        return {
          winW,
          docW,
          bodyW,
          hasHScroll,
          headerHeight: Math.round(headerHeight || 0),
          brandWidth: Math.round(brandRect?.width || 0),
          brandHeight: Math.round(brandRect?.height || 0),
          overflowingCount: overflowing.length,
          sampleOverflowing: overflowing.slice(0, 5),
          smallTouchTargetCount: smallTouchTargets.length,
          sampleSmallTouchTargets: smallTouchTargets.slice(0, 8)
        };
      });

      results[vp.name].index = indexMetrics;
      await page.screenshot({ path: path.join(outDir, `${vp.name}-index.png`), fullPage: false });

      if (indexMetrics.hasHScroll) {
        console.error(`  ERROR: ${vp.name} index has horizontal scroll! docW=${indexMetrics.docW}, winW=${indexMetrics.winW}`);
        totalErrors++;
      }
      if (indexMetrics.overflowingCount > 0) {
        console.error(`  ERROR: ${vp.name} index has ${indexMetrics.overflowingCount} overflowing elements:`, indexMetrics.sampleOverflowing);
        totalErrors++;
      }

      // Test mobile menu interaction if on mobile/tablet (<1024px)
      if (vp.width < 1024) {
        const menuBtn = page.locator('#mobile-menu-btn');
        if (await menuBtn.isVisible()) {
          await menuBtn.click();
          await page.waitForTimeout(200);
          const menuVisible = await page.locator('#mobile-nav-menu').isVisible();
          const menuAriaExpanded = await menuBtn.getAttribute('aria-expanded');
          results[vp.name].mobileNav = { openSuccess: menuVisible && menuAriaExpanded === 'true' };
          await page.screenshot({ path: path.join(outDir, `${vp.name}-menu-open.png`), fullPage: false });

          // Close with close button
          const closeBtn = page.locator('#mobile-menu-close-btn');
          await closeBtn.click();
          await page.waitForTimeout(200);
          const menuClosed = !(await page.locator('#mobile-nav-menu').isVisible()) || (await page.locator('#mobile-nav-menu').getAttribute('aria-hidden') === 'true');
          results[vp.name].mobileNav.closeSuccess = menuClosed;
        }
      }

      // 2. Check stock.html
      const stockPage = await context.newPage();
      await stockPage.goto(`${STOCK_FILE_URL}?isin=INE002A01018`, { waitUntil: 'load' });
      await stockPage.waitForSelector('#stock-detail:not(.hidden)', { timeout: 10000 });
      await stockPage.waitForTimeout(300);

      const stockMetrics = await stockPage.evaluate(() => {
        const docW = document.documentElement.scrollWidth;
        const bodyW = document.body.scrollWidth;
        const winW = window.innerWidth;
        const hasHScroll = docW > winW || bodyW > winW;

        const overflowing = [];
        document.querySelectorAll('body *').forEach(el => {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
          const r = el.getBoundingClientRect();
          if (r.right > winW + 1.5 && r.width > 0) {
            overflowing.push({
              tag: el.tagName,
              id: el.id,
              className: el.className ? String(el.className).slice(0, 50) : '',
              right: Math.round(r.right),
              width: Math.round(r.width)
            });
          }
        });

        const smallTouchTargets = [];
        document.querySelectorAll('button, a, input, select, [role="button"]').forEach(el => {
          const cs = window.getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return;
          if (el.classList.contains('sr-only')) return;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && (r.width < 40 || r.height < 40)) {
            smallTouchTargets.push({
              tag: el.tagName,
              text: el.textContent ? el.textContent.trim().slice(0, 30) : '',
              id: el.id,
              className: el.className ? String(el.className).slice(0, 40) : '',
              w: Math.round(r.width),
              h: Math.round(r.height)
            });
          }
        });

        return {
          winW,
          docW,
          hasHScroll,
          overflowingCount: overflowing.length,
          sampleOverflowing: overflowing.slice(0, 5),
          smallTouchTargetCount: smallTouchTargets.length,
          sampleSmallTouchTargets: smallTouchTargets.slice(0, 8)
        };
      });

      results[vp.name].stock = stockMetrics;
      await stockPage.screenshot({ path: path.join(outDir, `${vp.name}-stock.png`), fullPage: false });

      if (stockMetrics.hasHScroll) {
        console.error(`  ERROR: ${vp.name} stock has horizontal scroll! docW=${stockMetrics.docW}, winW=${stockMetrics.winW}`);
        totalErrors++;
      }
      if (stockMetrics.overflowingCount > 0) {
        console.error(`  ERROR: ${vp.name} stock has ${stockMetrics.overflowingCount} overflowing elements:`, stockMetrics.sampleOverflowing);
        totalErrors++;
      }

      await context.close();

      console.log(`Index (${vp.width}px): scrollWidth=${indexMetrics.docW}, winW=${indexMetrics.winW}, hasHScroll=${indexMetrics.hasHScroll}, overflowEls=${indexMetrics.overflowingCount}, smallTouchTargets=${indexMetrics.smallTouchTargetCount}`);
      console.log(`Stock (${vp.width}px): scrollWidth=${stockMetrics.docW}, winW=${stockMetrics.winW}, hasHScroll=${stockMetrics.hasHScroll}, overflowEls=${stockMetrics.overflowingCount}, smallTouchTargets=${stockMetrics.smallTouchTargetCount}`);
    }

    fs.writeFileSync(path.join(outDir, 'audit-results.json'), JSON.stringify(results, null, 2));
    console.log(`\nAudit complete! Total errors: ${totalErrors}`);
    if (totalErrors > 0) {
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
}

runAudit().catch(err => {
  console.error('Audit failed:', err);
  process.exit(1);
});
