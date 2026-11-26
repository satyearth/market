'use strict';

const {
  PORT,
  createAppServer,
  handleRequest,
  readMarketStatsFromDataset,
  triggerSyncJob,
  startBackgroundScheduler
} = require('./src/server/local-server');

const server = createAppServer();

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('================================================================');
    console.log(` MACHII BAZZAR — SERVER READY ON http://localhost:${PORT}`);
    console.log(` - Health API  : http://localhost:${PORT}/api/health`);
    console.log(` - Status API  : http://localhost:${PORT}/api/market/status`);
    console.log(` - Refresh API : http://localhost:${PORT}/api/market/refresh`);
    console.log('================================================================');
  });
  startBackgroundScheduler();
}

module.exports = server;
module.exports.server = server;
module.exports.handleRequest = handleRequest;
module.exports.readMarketStatsFromDataset = readMarketStatsFromDataset;
module.exports.triggerSyncJob = triggerSyncJob;
