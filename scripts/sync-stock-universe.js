'use strict';

const publisher = require('../src/publishing/publisher');
const { validateMergedDataset } = require('../src/validation/dataset-validator');
const { loadIndiaVixFromArchive, loadNse52WeekArchive } = require('../src/enrichment/fundamentals');

if (require.main === module) {
  publisher.syncUniverse().catch(err => {
    console.error('Synchronization failed:', err.message);
    process.exit(1);
  });
}

module.exports = {
  PIPELINE_VERSION: publisher.PIPELINE_VERSION,
  resolveTargetTradingDate: publisher.resolveTargetTradingDate,
  parseCsv: publisher.parseCsv,
  cleanCompanyName: publisher.cleanCompanyName,
  normalizeSourceDate: publisher.normalizeSourceDate,
  readExistingDataset: publisher.readExistingDataset,
  loadIndiaVixFromArchive,
  loadNse52WeekArchive,
  validateMergedDataset,
  syncUniverse: publisher.syncUniverse
};
