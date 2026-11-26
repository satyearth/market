'use strict';

const publisher = require('../src/publishing/publisher');

if (require.main === module) {
  const opts = publisher.parseCliArgs();
  publisher.runRefresh(opts).then((result) => {
    if (!result.ok) {
      console.error(`[Refresh] Finished with error (${result.status}): ${result.error}`);
      process.exit(1);
    }
    if (opts.dryRun) {
      console.log(`[Refresh] Dry run complete (${result.tradingDate}, ${result.stockCount} stocks validated).`);
    }
  }).catch((err) => {
    console.error('[Refresh] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = {
  runRefresh: publisher.runRefresh,
  parseCliArgs: publisher.parseCliArgs,
  readPublishedTradingDate: publisher.readPublishedTradingDate,
  validatePublishedDataset: publisher.validatePublishedDataset
};
