'use strict';

// Enforce strict isolation from any live Supabase credentials during automated tests
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
delete process.env.SUPABASE_ANON_KEY;
delete process.env.SUPABASE_STORAGE_BUCKET;

const suites = [
  require('./ingestion.test'),
  require('./normalization.test'),
  require('./enrichment.test'),
  require('./validation.test'),
  require('./storage-retention.test'),
  require('./api-and-query.test'),
  require('./security-and-ci.test')
];

(async () => {
  console.log('================================================================');
  console.log(' MACHII BAZZAR — ISOLATED MODULAR BACKEND TEST SUITE');
  console.log('================================================================');

  let passed = 0;
  let failed = 0;

  for (const suite of suites) {
    try {
      await suite.run();
      passed++;
      console.log(`  PASS  ${suite.name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL  ${suite.name}: ${err.stack || err.message}`);
    }
  }

  console.log('----------------------------------------------------------------');
  console.log(` Results: ${passed} suite(s) passed, ${failed} suite(s) failed`);
  console.log('================================================================');

  if (failed > 0) process.exit(1);
})();
