'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { ROOT_DIR } = require('../src/config/constants');
const { createAppServer } = require('../src/server/local-server');

function httpRequest(port, reqPath, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: reqPath,
      method
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        text: Buffer.concat(chunks).toString('utf8')
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function run() {
  // 1. Verify zero production credentials leak into unit test env
  assert.strictEqual(process.env.SUPABASE_SERVICE_ROLE_KEY || '', '', 'SUPABASE_SERVICE_ROLE_KEY must not be exposed to tests');

  // 2. Hardened local server security checks
  const srv = createAppServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();

  try {
    // Public allowlisted HTML & APIs work
    const idx = await httpRequest(port, '/');
    assert.strictEqual(idx.statusCode, 200);
    assert.ok(idx.text.includes('Machii Bazzar') || idx.text.includes('stocks-tbody'));

    const health = await httpRequest(port, '/api/health');
    assert.strictEqual(health.statusCode, 200);

    // Directory traversal & non-allowlisted internal files must NEVER be exposed
    const trav = await httpRequest(port, '/../package.json');
    assert.ok([403, 404].includes(trav.statusCode));

    const pkg = await httpRequest(port, '/package.json');
    assert.strictEqual(pkg.statusCode, 404, 'package.json must not be served statically');

    const srvJs = await httpRequest(port, '/server.js');
    assert.strictEqual(srvJs.statusCode, 404, 'server.js must not be served statically');

    const dl = await httpRequest(port, '/downloads/benchmark_stocks_verified.json');
    assert.strictEqual(dl.statusCode, 404, 'downloads/ must not be served statically');

    const layoutCss = await httpRequest(port, '/css/page-layout.css');
    assert.strictEqual(layoutCss.statusCode, 200, 'page-layout.css must be served');

    const detailsCss = await httpRequest(port, '/css/stock-details.css');
    assert.strictEqual(detailsCss.statusCode, 200, 'stock-details.css must be served');

    // Method discipline
    const postStocks = await httpRequest(port, '/api/stocks', 'POST');
    assert.strictEqual(postStocks.statusCode, 405);

    const histMeta = await httpRequest(port, '/api/market/history', 'GET');
    assert.strictEqual(histMeta.statusCode, 200);
    const postHist = await httpRequest(port, '/api/market/history', 'POST');
    assert.strictEqual(postHist.statusCode, 405);

    const getRefresh = await httpRequest(port, '/api/market/refresh', 'GET');
    assert.strictEqual(getRefresh.statusCode, 405);
  } finally {
    await new Promise(resolve => srv.close(resolve));
  }

  // 3. Frontend preservation + non-blocking detail page script loading
  const stockHtml = fs.readFileSync(path.join(ROOT_DIR, 'stock.html'), 'utf8');
  assert.ok(!stockHtml.includes('src="./js/stocks-data.js"'), 'stock.html must not synchronously download 9.26 MB stocks-data.js');

  const stockDetailsJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'stock-details.js'), 'utf8');
  assert.ok(stockDetailsJs.includes('loadStaticFallbackScript'), 'stock-details.js must lazy-load fallback only when API unavailable');

  const appJs = fs.readFileSync(path.join(ROOT_DIR, 'js', 'app.js'), 'utf8');
  assert.ok(appJs.includes('data.canTriggerSync === false'), 'app.js must skip POST /api/market/refresh on read-only Vercel API');

  // 4. CI workflow least-privilege credential check
  const workflow = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'refresh-stock-data.yml'), 'utf8');
  assert.ok(!workflow.includes('git push'), 'Workflow must never git push');
  assert.ok(workflow.includes('tests/run-all.js'), 'Workflow must execute isolated backend suite');
}

module.exports = { name: 'security-and-ci.test.js', run };
