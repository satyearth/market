'use strict';

const fs = require('fs');
const downloader = require('../src/ingestion/bhavcopy-downloader');
const { getLatestExpectedTradingDate } = require('../src/calendar/exchange-calendar');

async function main() {
  if (!fs.existsSync(downloader.DEFAULT_DOWNLOADS_DIR)) {
    fs.mkdirSync(downloader.DEFAULT_DOWNLOADS_DIR, { recursive: true });
  }

  const args = process.argv.slice(2);
  const isBackfill = args.includes('--backfill');
  const force = args.includes('--force');
  const wait = args.includes('--wait');
  const dateArg = (args.find(a => a.startsWith('--date=')) || '').split('=')[1] ||
    args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const fromArg = (args.find(a => a.startsWith('--from=')) || '').split('=')[1] || null;

  const calendar = getLatestExpectedTradingDate();
  const targetDate = dateArg || calendar.latestExpectedDate;

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(' MACHII BAZZAR — OFFICIAL EXCHANGE BHAVCOPY DOWNLOADER');
  console.log(`   Latest Expected Session : ${calendar.latestExpectedDate}`);
  console.log(`   Target Session          : ${targetDate}`);
  console.log(`   Calendar Reason         : ${calendar.reason}`);
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (isBackfill) {
    const res = await downloader.backfillSessions(targetDate, { fromDate: fromArg, force });
    console.log(`\n[Backfill] Done: ${res.downloaded.length}/${res.totalMissing} succeeded, ${res.failed.length} failed.`);
    if (!res.ok) process.exitCode = 1;
    return res;
  }

  if (targetDate > calendar.latestExpectedDate) {
    console.error(`[Download] ${targetDate} is ahead of latest expected trading date (${calendar.latestExpectedDate}).`);
    process.exitCode = 1;
    return { ok: false, error: 'Future trading date requested' };
  }

  const res = wait
    ? await downloader.waitForSessionPublication(targetDate, { force })
    : await downloader.downloadSession(targetDate, { force });

  if (!res.bothOk) {
    process.exitCode = 1;
  }
  return res;
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Download] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = downloader;
