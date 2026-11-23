/**
 * Machli Bazzar — Local Exchange File-Cache MCP Stub (scripts/mcp-server.js)
 *
 * Implements:
 * 1. JSON-RPC 2.0 Protocol on http://127.0.0.1:3000/mcp
 * 2. Exchange file tools only check whether an explicitly dated Bhavcopy
 *    already exists in downloads/. This stub does not fetch exchange files.
 * 3. VIX and 52-week tools stay unavailable until backed by live, dated data.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const MCP_PORT = 3000;
const DOWNLOADS_DIR = path.resolve(__dirname, '..', 'downloads');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  if (req.url === '/health' || req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, status: 'running', service: 'local-exchange-mcp', port: MCP_PORT }));
  }

  if (req.url === '/mcp' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const { id, method, params } = payload;

        if (method !== 'tools/call') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ jsonrpc: '2.0', id, result: { status: 'ok' } }));
        }

        const toolName = params?.name;
        const toolArgs = params?.arguments || {};
        let result = {};

        switch (toolName) {
          case 'nse_download_equity_bhavcopy': {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(toolArgs.date || ''))) {
              result = { status: 'invalid_date', error: 'Pass an explicit trading date (YYYY-MM-DD).' };
              break;
            }
            const dtCompact = toolArgs.date.replace(/-/g, '');
            const targetFile = path.join(DOWNLOADS_DIR, `BhavCopy_NSE_CM_0_0_0_${dtCompact}_F_0000.csv`);
            const exists = fs.existsSync(targetFile);
            result = {
              status: exists ? 'success' : 'not_found',
              date: toolArgs.date,
              file: targetFile,
              sizeBytes: exists ? fs.statSync(targetFile).size : 0
            };
            break;
          }

          case 'bse_download_bhavcopy': {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(toolArgs.date || ''))) {
              result = { status: 'invalid_date', error: 'Pass an explicit trading date (YYYY-MM-DD).' };
              break;
            }
            const dtCompact = toolArgs.date.replace(/-/g, '');
            const targetFile = path.join(DOWNLOADS_DIR, `BhavCopy_BSE_CM_0_0_0_${dtCompact}_F_0000.CSV`);
            const exists = fs.existsSync(targetFile);
            result = {
              status: exists ? 'success' : 'not_found',
              date: toolArgs.date,
              file: targetFile,
              sizeBytes: exists ? fs.statSync(targetFile).size : 0
            };
            break;
          }

          case 'nse_vix_historical': {
            result = { status: 'not_configured', error: 'This local file-cache MCP stub does not fetch India VIX data.' };
            break;
          }

          case 'bse_near_52week': {
            result = { status: 'not_configured', error: 'This local file-cache MCP stub does not fetch BSE 52-week data.' };
            break;
          }

          default:
            result = { status: 'acknowledged', tool: toolName, args: toolArgs };
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

if (require.main === module) {
  server.listen(MCP_PORT, '127.0.0.1', () => {
    console.log(`[Local Exchange MCP] Daemon listening on http://127.0.0.1:${MCP_PORT}/mcp`);
  });
}

module.exports = server;

