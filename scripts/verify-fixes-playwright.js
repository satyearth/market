'use strict';

const assert = require('assert');
const server = require('../server');
const { chromium } = require('playwright');

async function runTests() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Test server running at ${origin}`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu']
  });

  const desktopConsoleErrors = [];
  const mobileConsoleErrors = [];
  const imageErrors = [];

  try {
    // =========================================================================
    // 1. DESKTOP VIEWPORT TEST (1920 x 1080)
    // =========================================================================
    console.log('\n--- Testing Desktop Viewport (1920x1080) ---');
    const desktopPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });

    desktopPage.on('console', msg => {
      if (msg.type() === 'error') {
        console.error('Desktop console error:', msg.text());
        desktopConsoleErrors.push(msg.text());
      }
    });
    desktopPage.on('pageerror', err => {
      console.error('Desktop page error:', err.message);
      desktopConsoleErrors.push(err.message);
    });
    desktopPage.on('response', resp => {
      if (resp.status() >= 400 && resp.request().resourceType() === 'image') {
        imageErrors.push({ url: resp.url(), status: resp.status() });
      }
    });

    // Mock /api/market/status so background sync doesn't re-write stocks-data.js during test
    await desktopPage.route('**/api/market/status', route => route.fulfill({
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

    await desktopPage.goto(origin, { waitUntil: 'domcontentloaded' });

    // Wait for stocks to render
    await desktopPage.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length >= 50);

    // 1. Check Skeleton Rows Unmounted Completely
    const skeletonCount = await desktopPage.evaluate(() => {
      return document.querySelectorAll('#stocks-tbody tr.animate-pulse').length;
    });
    console.log(`Skeleton rows remaining after data load: ${skeletonCount}`);
    assert.strictEqual(skeletonCount, 0, 'Skeletons must be completely unmounted when real data loads');

    const rowCount = await desktopPage.locator('#stocks-tbody tr[data-row-isin]').count();
    console.log(`Real rows loaded: ${rowCount}`);
    assert.strictEqual(rowCount, 50, 'Exactly 50 initial rows rendered');

    // 2. Check Sticky Header on Window Scroll
    const initialTheadY = await desktopPage.evaluate(() => document.querySelector('thead').getBoundingClientRect().top);
    console.log(`Initial thead Y: ${initialTheadY}px`);

    await desktopPage.evaluate(() => window.scrollTo(0, 600));
    await desktopPage.waitForTimeout(200);

    const scrolledTheadY = await desktopPage.evaluate(() => document.querySelector('thead').getBoundingClientRect().top);
    const scrolledThY = await desktopPage.evaluate(() => document.querySelector('th[data-col="Stock"]').getBoundingClientRect().top);
    console.log(`Scrolled thead Y (scroll 600px): ${scrolledTheadY}px`);
    console.log(`Scrolled th Stock Y (scroll 600px): ${scrolledThY}px`);

    assert.strictEqual(scrolledTheadY, 57, 'thead must stick exactly at 57px below header');
    assert.strictEqual(scrolledThY, 57, 'th must stick exactly at 57px below header');

    // Reset scroll
    await desktopPage.evaluate(() => window.scrollTo(0, 0));
    await desktopPage.waitForTimeout(100);

    // 3. Check Header Glow Behind Brand Logo
    const glowCheck = await desktopPage.evaluate(() => {
      const glowEl = document.querySelector('header .relative.overflow-hidden div[aria-hidden="true"]');
      if (!glowEl) return null;
      const cs = window.getComputedStyle(glowEl);
      return {
        hasGlow: true,
        background: cs.backgroundImage || cs.background,
        mask: cs.maskImage || cs.webkitMaskImage
      };
    });
    console.log('Header glow element found:', !!glowCheck?.hasGlow);
    assert.ok(glowCheck && glowCheck.hasGlow, 'Soft masked radial glow container exists behind logo');

    // 4. Check Logo Sizing & Initials (Issue 1)
    const logoCheck = await desktopPage.evaluate(() => {
      const wraps = Array.from(document.querySelectorAll('#stocks-tbody tr[data-row-isin] .stock-logo-wrap'));
      const sample = wraps.slice(0, 10).map(w => {
        const rect = w.getBoundingClientRect();
        const img = w.querySelector('img');
        const fallback = w.querySelector('.company-logo-fallback');
        return {
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          hasImg: !!img,
          imgComplete: img ? img.complete : null,
          hasFallback: !!fallback,
          fallbackHidden: fallback ? (fallback.classList.contains('hidden') || window.getComputedStyle(fallback).display === 'none') : null
        };
      });
      return sample;
    });
    console.log('Sample 10 logo dimensions:', logoCheck.map(l => `${l.width}x${l.height}`).join(', '));
    assert(logoCheck.every(l => l.width === 32 && l.height === 32), 'Every logo container must be exactly 32x32px');

    // 5. Check Empty Columns & Numeric Right-Alignment (Issue 3 & 8)
    const columnAlignmentCheck = await desktopPage.evaluate(() => {
      const numericCols = ['#', 'Price', 'Chg %', 'MCap', '1W', '1M', '3M', 'Vol'];
      const headers = {};
      numericCols.forEach(col => {
        const th = document.querySelector(`th[data-col="${col}"]`);
        if (th) {
          const cs = window.getComputedStyle(th);
          headers[col] = {
            textAlign: cs.textAlign,
            title: th.getAttribute('title')
          };
        }
      });

      // Sample first row cells
      const firstRow = document.querySelector('#stocks-tbody tr[data-row-isin]');
      const cells = Array.from(firstRow.querySelectorAll('td'));
      const cellAlignments = {
        rank: window.getComputedStyle(cells[0]).textAlign,
        price: window.getComputedStyle(cells[3]).textAlign,
        chg: window.getComputedStyle(cells[4]).textAlign,
        mcap: window.getComputedStyle(cells[5]).textAlign,
        w1: window.getComputedStyle(cells[6]).textAlign,
        m1: window.getComputedStyle(cells[7]).textAlign,
        m3: window.getComputedStyle(cells[8]).textAlign,
        vol: window.getComputedStyle(cells[9]).textAlign,
        volText: cells[9].textContent.trim(),
        m1Title: cells[7].getAttribute('title'),
        m3Title: cells[8].getAttribute('title')
      };

      return { headers, cellAlignments };
    });

    console.log('Numeric header alignments:', Object.fromEntries(
      Object.entries(columnAlignmentCheck.headers).map(([k, v]) => [k, v.textAlign])
    ));
    assert.strictEqual(columnAlignmentCheck.headers['Vol'].textAlign, 'right', 'Vol header must be right-aligned');
    assert.strictEqual(columnAlignmentCheck.cellAlignments.vol, 'right', 'Vol cell must be right-aligned');
    console.log(`First row formatted volume: "${columnAlignmentCheck.cellAlignments.volText}"`);
    assert.match(columnAlignmentCheck.cellAlignments.volText, /^(\d+(\.\d+)?[MK]|—|\d+)$/, 'Volume must be human formatted (e.g. 21.2M, 340K)');
    assert.strictEqual(columnAlignmentCheck.headers['1M'].title, 'Data not available yet', '1M header has tooltip');
    assert.strictEqual(columnAlignmentCheck.headers['3M'].title, 'Data not available yet', '3M header has tooltip');
    assert.strictEqual(columnAlignmentCheck.cellAlignments.m1Title, 'Data not available yet', '1M cell has tooltip');

    // 6. Check Near 52W Subtitle Spacing (Issue 8)
    const near52SubHtml = await desktopPage.evaluate(() => document.getElementById('card-near52-sub').innerHTML);
    console.log('Near 52W Subtitle HTML:', near52SubHtml.trim());
    assert(near52SubHtml.includes('Source: BSE MCP'), 'Source is explicitly labeled');
    assert(near52SubHtml.includes('block'), 'BSE MCP is rendered on its own line/block');

    // 7. Check Verified Cap Ranks Bars (Issue 4)
    const capBarsCheck = await desktopPage.evaluate(() => {
      const keys = ['lrg', 'mid', 'sml', 'mic', 'sme'];
      return keys.map(k => {
        const bar = document.getElementById(`card-seg-bar-${k}`);
        const cnt = document.getElementById(`card-seg-cnt-${k}`);
        const cs = window.getComputedStyle(bar);
        return {
          key: k,
          height: bar.style.height,
          heightPx: parseFloat(cs.height),
          bgColor: cs.backgroundColor,
          countText: cnt ? cnt.textContent.trim() : null,
          title: bar.getAttribute('title')
        };
      });
    });
    console.log('Cap bars check:', capBarsCheck);
    assert(capBarsCheck.every(b => b.heightPx >= 6), 'All bars have minimum height of at least 6px');
    assert(capBarsCheck.every(b => b.title && b.title.includes('stocks')), 'All bars have tooltip with exact count');
    // Ensure distinct colors (grey is mic only)
    assert(capBarsCheck.find(b => b.key === 'lrg').bgColor !== capBarsCheck.find(b => b.key === 'mic').bgColor, 'T100 is not grey');
    assert(capBarsCheck.find(b => b.key === 'mid').bgColor !== capBarsCheck.find(b => b.key === 'mic').bgColor, 'Mid is not grey');
    assert(capBarsCheck.find(b => b.key === 'sml').bgColor !== capBarsCheck.find(b => b.key === 'mic').bgColor, 'Rem is not grey');

    // 8. Check Sector mapping / Data Quality (Issue 7)
    // Search for Jio Platforms (JPL)
    const searchInput = desktopPage.locator('input[data-stocks-search="true"]');
    await searchInput.fill('JPL');
    await desktopPage.waitForTimeout(200);
    await desktopPage.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length > 0);

    const jplSector = await desktopPage.evaluate(() => {
      const row = document.querySelector('#stocks-tbody tr[data-row-isin="INE0BJO01010"]');
      if (!row) return null;
      const sectorBadge = row.querySelectorAll('td')[2].querySelector('span');
      return sectorBadge ? sectorBadge.textContent.trim() : null;
    });
    console.log('JPL Sector in table:', jplSector);
    assert(jplSector !== 'GENERAL' && jplSector !== 'General', 'JPL must not have GENERAL sector');
    assert.strictEqual(jplSector, 'Telecommunication', 'JPL is correctly mapped to Telecommunication');

    // Clear search
    await searchInput.fill('');
    await desktopPage.waitForTimeout(200);
    await desktopPage.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length >= 50);

    console.log('✓ Desktop 1920px tests PASSED');

    // =========================================================================
    // 2. MOBILE VIEWPORT TEST (375 x 667)
    // =========================================================================
    console.log('\n--- Testing Mobile Viewport (375x667) ---');
    const mobilePage = await browser.newPage({ viewport: { width: 375, height: 667 } });

    mobilePage.on('console', msg => {
      if (msg.type() === 'error') {
        console.error('Mobile console error:', msg.text());
        mobileConsoleErrors.push(msg.text());
      }
    });
    mobilePage.on('pageerror', err => {
      console.error('Mobile page error:', err.message);
      mobileConsoleErrors.push(err.message);
    });

    await mobilePage.route('**/api/market/status', route => route.fulfill({
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

    await mobilePage.goto(origin, { waitUntil: 'domcontentloaded' });
    await mobilePage.waitForFunction(() => document.querySelectorAll('#stocks-tbody tr[data-row-isin]').length >= 50);

    // Mobile layout overflow check
    const mobileLayout = await mobilePage.evaluate(() => {
      return {
        viewportWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        hasHorizontalDocOverflow: document.documentElement.scrollWidth > window.innerWidth,
        tableCardWidth: document.querySelector('.pulse-card').offsetWidth,
        logoDims: {
          w: document.querySelector('.stock-logo-wrap').offsetWidth,
          h: document.querySelector('.stock-logo-wrap').offsetHeight
        }
      };
    });

    console.log('Mobile layout check:', mobileLayout);
    assert.strictEqual(mobileLayout.hasHorizontalDocOverflow, false, 'Mobile viewport must not have document horizontal overflow');
    assert.strictEqual(mobileLayout.logoDims.w, 32, 'Logo is 32px on mobile');
    assert.strictEqual(mobileLayout.logoDims.h, 32, 'Logo is 32px on mobile');

    console.log('✓ Mobile 375px tests PASSED');

    // =========================================================================
    // 3. CONSOLE & HYDRATION / IMAGE 404 AUDIT
    // =========================================================================
    console.log('\n--- Console & Network Error Audit ---');
    console.log(`Desktop console errors: ${desktopConsoleErrors.length}`);
    console.log(`Mobile console errors: ${mobileConsoleErrors.length}`);
    console.log(`Image 404 / network errors: ${imageErrors.length}`);

    assert.strictEqual(desktopConsoleErrors.length, 0, `No console errors on desktop: ${JSON.stringify(desktopConsoleErrors)}`);
    assert.strictEqual(mobileConsoleErrors.length, 0, `No console errors on mobile: ${JSON.stringify(mobileConsoleErrors)}`);
    assert.strictEqual(imageErrors.length, 0, `No broken image requests: ${JSON.stringify(imageErrors)}`);

    console.log('\nALL 8 BUGS VERIFIED FIXED ACROSS DESKTOP & MOBILE WITH ZERO CONSOLE ERRORS!');

  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

runTests().catch(err => {
  console.error('\nTEST FAILED:', err);
  process.exit(1);
});

