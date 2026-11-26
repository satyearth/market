'use strict';

/**
 * Dataset Compiler, Atomic Local/Remote Publisher & Pipeline Orchestrator
 *
 * Replaces monolithic scripts/sync-stock-universe.js & scripts/refresh.js orchestration:
 * - Resolves expected trading session & trailing historical window (up to 90 sessions)
 * - Validates NSE & BSE BhavCopy archives cleanly before compiling
 * - Hydrates cold runners from Supabase Storage (`reference/`) when local JSON caches are absent
 * - Merges NSE + BSE universe on ISIN, resolves market caps, fundamentals & 1W/1M/3M returns, validates invariants
 * - Atomically writes js/stocks-data.js (via temp file + read-back verification + backup)
 * - Atomically publishes versioned snapshot + latest.json pointer to Supabase Storage
 * - Supports --dry-run, --retention-dry-run, and --sync-reference flags cleanly
 */

const fs = require('fs');
const path = require('path');
const {
  DOWNLOADS_DIR,
  TARGET_DATA_PATH,
  BACKUP_DATA_PATH,
  REFERENCE_FILES,
  MAX_HISTORICAL_SESSIONS,
  DOWNLOAD_WINDOW_SESSIONS,
  RETURN_WINDOW_1W_SESSIONS,
  RETURN_WINDOW_1M_SESSIONS,
  RETURN_WINDOW_3M_SESSIONS
} = require('../config/constants');
const {
  getLatestExpectedTradingDate,
  getRecentTradingSessions,
  checkSessionFreshness,
  isTradingDay
} = require('../calendar/exchange-calendar');
const { parseCSVContent, cleanCompanyName, parseDateStr } = require('../processing/csv-parser');
const {
  createDownloader,
  validateBhavcopyCsvContent,
  getNseFilename,
  getBseFilename,
  getIndicesFilename
} = require('../ingestion/bhavcopy-downloader');
const { loadMarketCapSources, generateCoverageReport } = require('../enrichment/market-cap');
const {
  loadIndiaVixFromArchive,
  loadNse52WeekArchive,
  loadBse52WeekFallback
} = require('../enrichment/fundamentals');
const { mergeExchangeUniverse, buildUniverseDiff } = require('../processing/universe-merger');
const { validateMergedDataset } = require('../validation/dataset-validator');
const { buildCompactHistoryPayload } = require('../storage/historical-store');
const defaultStorage = require('../storage/supabase-storage');

const PIPELINE_VERSION = '2.0.0';

function readExistingDataset(filePath = TARGET_DATA_PATH) {
  if (!fs.existsSync(filePath)) return { stats: null, stocks: [] };
  const content = fs.readFileSync(filePath, 'utf8');
  const statsMatch = content.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*(?:window\.MARKET_STATS|const STOCKS_DATA)/);
  const stocksMatch = content.match(/const STOCKS_DATA = (\[[\s\S]*\]);\s*$/);
  const stats = statsMatch ? JSON.parse(statsMatch[1]) : null;
  const stocks = stocksMatch ? JSON.parse(stocksMatch[1]) : [];
  return { stats, stocks };
}

function readPublishedTradingDate(targetPath = TARGET_DATA_PATH) {
  try {
    const existing = readExistingDataset(targetPath);
    return existing.stats?.tradingDate || null;
  } catch (_) {
    return null;
  }
}

function validatePublishedDataset(targetPath = TARGET_DATA_PATH, expectedDate = null) {
  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: `Dataset file missing: ${targetPath}` };
  }
  try {
    const { stats, stocks } = readExistingDataset(targetPath);
    if (!stats || !Array.isArray(stocks)) {
      return { ok: false, error: 'Dataset missing MARKET_STATS or STOCKS_DATA' };
    }
    if (expectedDate && stats.tradingDate !== expectedDate) {
      return { ok: false, error: `Expected tradingDate ${expectedDate}, got ${stats.tradingDate}` };
    }
    if (stats.stockCount !== stocks.length) {
      return { ok: false, error: `stockCount mismatch: stats=${stats.stockCount}, rows=${stocks.length}` };
    }
    return {
      ok: true,
      tradingDate: stats.tradingDate,
      stockCount: stocks.length,
      refreshedAtUtc: stats.refreshedAtUtc,
      pipelineVersion: stats.pipelineVersion
    };
  } catch (err) {
    return { ok: false, error: `Dataset validation parse error: ${err.message}` };
  }
}

function resolveTargetTradingDate(options = {}) {
  const downloadsDir = options.downloadsDir || DOWNLOADS_DIR;
  const targetPath = options.targetPath || TARGET_DATA_PATH;
  const argv = options.argv || process.argv;
  const now = options.now || new Date();
  const minRows = options.minRowCount ?? 1000;
  const minBytes = options.minBytes ?? 50000;

  const calendar = getLatestExpectedTradingDate(now);
  const latestExpectedDate = calendar.latestExpectedDate;

  const downloader = createDownloader({
    downloadsDir,
    minNseRows: minRows,
    minBseRows: minRows,
    minBytes
  });
  const stored = downloader.inspectStoredSessions();
  const latestDownloadedDate = stored.latestCompleteDate;

  const latestPublishedDate = readPublishedTradingDate(targetPath);

  const cliDate = options.targetDate ||
    argv.find(a => a.startsWith('--date='))?.split('=')[1] ||
    argv.slice(2).find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) ||
    null;

  let targetDate;
  let selectionMode;
  if (cliDate && /^\d{4}-\d{2}-\d{2}$/.test(cliDate)) {
    targetDate = cliDate;
    selectionMode = 'explicit';
  } else if (argv.includes('--latest') || cliDate === 'latest') {
    targetDate = latestExpectedDate;
    selectionMode = 'latest';
  } else {
    targetDate = latestExpectedDate;
    selectionMode = 'auto_expected';
  }

  return {
    targetDate,
    selectionMode,
    latestExpectedDate,
    latestDownloadedDate,
    latestPublishedDate,
    calendar
  };
}

function writeLocalDatasetAtomically(targetPath, backupPath, marketStats, mergedStocks, istFormattedString, compileTime) {
  const serializedStocks = mergedStocks.map(s => `  ${JSON.stringify(s)}`).join(',\n');
  const outputJs = `/* machli bazarr - Complete Stock Market Dataset (NSE + BSE) */
/* Trading Date: ${marketStats.tradingDate} | Compiled UTC: ${compileTime.toISOString()} | IST: ${istFormattedString} */
/* Data Status: End-of-day official exchange Bhavcopy (NSE + BSE) */

const MARKET_STATS = ${JSON.stringify(marketStats, null, 2)};

const STOCKS_DATA = [${serializedStocks ? `\n${serializedStocks}\n` : ''}];
`;

  const tmpPath = `${targetPath}.tmp.${process.pid}`;
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(tmpPath, outputJs, 'utf8');

  try {
    const written = fs.readFileSync(tmpPath, 'utf8');
    const parsedStatsMatch = written.match(/const MARKET_STATS = (\{[\s\S]*?\});\s*const STOCKS_DATA = /);
    const parsedStocksMatch = written.match(/const STOCKS_DATA = (\[[\s\S]*\]);\s*$/);
    if (!parsedStatsMatch || !parsedStocksMatch) {
      throw new Error('Generated dataset missing MARKET_STATS or STOCKS_DATA sections');
    }
    const checkStats = JSON.parse(parsedStatsMatch[1]);
    const checkStocks = JSON.parse(parsedStocksMatch[1]);
    if (checkStats.tradingDate !== marketStats.tradingDate || checkStocks.length !== mergedStocks.length) {
      throw new Error('Generated dataset verification mismatch');
    }

    if (fs.existsSync(targetPath) && backupPath) {
      const tmpBackup = `${backupPath}.tmp.${process.pid}`;
      fs.copyFileSync(targetPath, tmpBackup);
      fs.renameSync(tmpBackup, backupPath);
    }

    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
    throw new Error(`Failed to atomically publish dataset: ${err.message}`, { cause: err });
  }
}

async function uploadReferenceFilesToStorage(downloadsDir, storageClient, logger = console) {
  if (!storageClient || !storageClient.isWriteConfigured() || typeof storageClient.uploadReferenceJson !== 'function') {
    return { uploaded: [], skipped: REFERENCE_FILES };
  }
  const uploaded = [];
  const failed = [];
  for (const fileName of REFERENCE_FILES) {
    const fullPath = path.join(downloadsDir, fileName);
    if (!fs.existsSync(fullPath)) continue;
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      JSON.parse(content); // verify valid JSON before upload
      const res = await storageClient.uploadReferenceJson(fileName, content);
      if (res.ok) uploaded.push(fileName);
      else failed.push({ fileName, error: res.error });
    } catch (err) {
      failed.push({ fileName, error: err.message });
    }
  }
  if (uploaded.length > 0) {
    logger.log(`  Uploaded ${uploaded.length} reference file(s) to storage: ${uploaded.join(', ')}`);
  }
  return { uploaded, failed };
}

async function syncUniverse(options = {}) {
  const fetchStartTime = options.now || new Date();
  const downloadsDir = options.downloadsDir || DOWNLOADS_DIR;
  const targetPath = options.targetPath || TARGET_DATA_PATH;
  const backupPath = options.backupPath !== undefined ? options.backupPath : BACKUP_DATA_PATH;
  const minSourceRows = options.minSourceRows ?? 1000;
  const minBytes = options.minBytes ?? 50000;
  const force = Boolean(options.force || process.argv.includes('--force'));
  const allowDowngrade = Boolean(options.allowDowngrade || process.argv.includes('--allow-downgrade'));
  const skipStorage = Boolean(options.skipStorage || process.argv.includes('--skip-storage'));
  const dryRun = Boolean(options.dryRun || process.argv.includes('--dry-run'));
  const skipLocalWrite = Boolean(options.skipLocalWrite || dryRun);
  const storageClient = options.storageClient || defaultStorage;
  const logger = options.logger || console;

  const resolution = resolveTargetTradingDate({
    downloadsDir,
    targetPath,
    targetDate: options.targetDate,
    argv: options.argv || process.argv,
    now: fetchStartTime,
    minRowCount: minSourceRows,
    minBytes
  });

  const TARGET_TRADING_DATE = resolution.targetDate;

  let remoteDataset = null;
  let remoteHistoryDataset = null;
  if (!skipStorage && storageClient.isReadConfigured()) {
    const remoteRes = await storageClient.fetchLatestDataset();
    if (remoteRes.ok) {
      remoteDataset = remoteRes;
      if (remoteRes.historicalDatasetMeta?.datasetPath && typeof storageClient.fetchHistoricalDataset === 'function') {
        const histRes = await storageClient.fetchHistoricalDataset(remoteRes.manifest || remoteRes.historicalDatasetMeta);
        if (histRes.ok && histRes.history) {
          remoteHistoryDataset = histRes.history;
        } else if (!histRes.notFound) {
          throw new Error(`Failed to recover prior historical dataset (${remoteRes.historicalDatasetMeta.datasetPath}): ${histRes.error}`);
        }
      }
    }
  }

  const authoritativePublishedDate = remoteDataset?.manifest?.tradingDate || resolution.latestPublishedDate;

  if (!isTradingDay(TARGET_TRADING_DATE)) {
    throw new Error(`Target date ${TARGET_TRADING_DATE} is not a valid NSE/BSE trading day (weekend or exchange holiday).`);
  }
  if (TARGET_TRADING_DATE > resolution.latestExpectedDate) {
    throw new Error(
      `Refusing to compile future trading session ${TARGET_TRADING_DATE} (latest expected IST session is ${resolution.latestExpectedDate}).`
    );
  }
  if (authoritativePublishedDate && TARGET_TRADING_DATE < authoritativePublishedDate && !allowDowngrade) {
    throw new Error(
      `Refusing to overwrite newer valid dataset (${authoritativePublishedDate}) with older trading date (${TARGET_TRADING_DATE}). Pass --allow-downgrade to override.`
    );
  }

  const rawHistCount = Number.parseInt(options.historySessionCount, 10);
  const historySessionCount = Number.isInteger(rawHistCount) && rawHistCount > 0
    ? Math.min(rawHistCount, MAX_HISTORICAL_SESSIONS)
    : MAX_HISTORICAL_SESSIONS;
  const HISTORICAL_DATES = getRecentTradingSessions(TARGET_TRADING_DATE, historySessionCount);
  const ACTIVE_WINDOW_DATES = HISTORICAL_DATES.slice(-DOWNLOAD_WINDOW_SESSIONS);

  logger.log('================================================================');
  logger.log(` MACHII BAZZAR — STOCK UNIVERSE SYNCHRONIZATION (v${PIPELINE_VERSION})`);
  logger.log(` Target Trading Date : ${TARGET_TRADING_DATE}${dryRun ? ' [DRY RUN]' : ''}`);
  logger.log(` Latest Expected     : ${resolution.latestExpectedDate}`);
  logger.log(` Latest Published    : ${authoritativePublishedDate || 'none'}`);
  logger.log(` External Storage    : ${skipStorage ? 'Disabled (--skip-storage)' : (storageClient.isWriteConfigured() ? `Supabase (${storageClient.bucket})` : 'Read/Local only')}`);
  logger.log('================================================================\n');

  if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
  }

  const previousUniverseByIsin = new Map();
  let localPrev = { stats: null, stocks: [] };
  if (fs.existsSync(targetPath)) {
    try {
      localPrev = readExistingDataset(targetPath);
    } catch (_) {}
  }
  const useRemotePrev = Boolean(
    remoteDataset?.stocks?.length &&
    (!localPrev.stats?.tradingDate || remoteDataset.manifest.tradingDate >= localPrev.stats.tradingDate)
  );
  const prevStocksSource = useRemotePrev ? remoteDataset.stocks : localPrev.stocks;
  for (const s of prevStocksSource) {
    previousUniverseByIsin.set(s.isin, s);
  }

  const nseTodayFile = path.join(downloadsDir, getNseFilename(TARGET_TRADING_DATE));
  const bseTodayFile = path.join(downloadsDir, getBseFilename(TARGET_TRADING_DATE));

  if (!fs.existsSync(nseTodayFile) || !fs.existsSync(bseTodayFile)) {
    throw new Error(
      `Missing BhavCopy source files for ${TARGET_TRADING_DATE} (NSE exists: ${fs.existsSync(nseTodayFile)}, BSE exists: ${fs.existsSync(bseTodayFile)}).`
    );
  }

  const nseContent = fs.readFileSync(nseTodayFile, 'utf8');
  const bseContent = fs.readFileSync(bseTodayFile, 'utf8');

  const nseCheck = validateBhavcopyCsvContent(nseContent, TARGET_TRADING_DATE, { minRows: minSourceRows, minBytes });
  const bseCheck = validateBhavcopyCsvContent(bseContent, TARGET_TRADING_DATE, { minRows: minSourceRows, minBytes });
  if (!nseCheck.ok) throw new Error(`NSE BhavCopy validation failed: ${nseCheck.error}`);
  if (!bseCheck.ok) throw new Error(`BSE BhavCopy validation failed: ${bseCheck.error}`);

  const nseRaw = parseCSVContent(nseContent);
  const bseRaw = parseCSVContent(bseContent);

  const nseDateInFile = nseRaw[0]?.TradDt;
  const bseDateInFile = bseRaw[0]?.TradDt;
  if (nseDateInFile !== TARGET_TRADING_DATE || bseDateInFile !== TARGET_TRADING_DATE) {
    throw new Error(
      `Trading date mismatch: expected ${TARGET_TRADING_DATE}, got NSE=${nseDateInFile}, BSE=${bseDateInFile}.`
    );
  }

  const archiveVix = loadIndiaVixFromArchive(downloadsDir, TARGET_TRADING_DATE);
  const realVix = archiveVix ? archiveVix.vix : null;
  const realVixChangePct = archiveVix ? archiveVix.vixChangePct : null;
  const realVixDate = archiveVix ? archiveVix.vixDate : null;
  const vixSource = archiveVix ? archiveVix.source : null;

  const nse52Week = loadNse52WeekArchive(downloadsDir, TARGET_TRADING_DATE);
  const bse52Week = nse52Week.loaded ? { near52WeekScripCodes: new Set(), week52HighMap: new Map(), loaded: false } : loadBse52WeekFallback(downloadsDir, TARGET_TRADING_DATE);

  let near52SourceStatus = 'UNAVAILABLE';
  let near52SourceName = null;
  if (nse52Week.loaded) {
    near52SourceStatus = `NSE_ARCHIVE (${nse52Week.fileName})`;
    near52SourceName = `NSE 52-Week High/Low Archive (${nse52Week.fileName})`;
  } else if (bse52Week.loaded) {
    near52SourceStatus = `SESSION_CACHE (${TARGET_TRADING_DATE})`;
    near52SourceName = 'BSE 52W High/Low Cache';
  }

  const marketCapSources = options.marketCapSources || await loadMarketCapSources({
    downloadsDir,
    forceRefresh: Boolean(options.refreshCatalog),
    storageClient: skipStorage ? null : storageClient
  });

  const { mergedStocks, rankingResult, populatedHistoricalDates, priceHistoryByIsin, counts } = mergeExchangeUniverse({
    targetDate: TARGET_TRADING_DATE,
    nseRaw,
    bseRaw,
    downloadsDir,
    historicalDates: HISTORICAL_DATES,
    marketCapSources,
    previousUniverseByIsin,
    previousHistoryDataset: remoteHistoryDataset || null,
    nse52Week,
    bse52Week,
    fetchStartTime
  });

  const verifiedSegments = rankingResult.segments;
  const totalVerifiedCap = rankingResult.totalVerifiedCap;
  const verifiedCapCount = rankingResult.verifiedCapCount;
  const coveragePct = rankingResult.coveragePct;

  const compileTime = new Date();
  for (const s of mergedStocks) {
    s.refreshed_at = compileTime.toISOString();
  }

  const changeLog = buildUniverseDiff(mergedStocks, previousUniverseByIsin, TARGET_TRADING_DATE, compileTime);

  let advances = 0;
  let declines = 0;
  let unchanged = 0;
  let unpriced = 0;
  let breadthCount = 0;
  let near52Count = 0;

  for (const s of mergedStocks) {
    if (s.current_price != null && s.prev_close != null && s.prev_close > 0) {
      breadthCount++;
      if (s.current_price > s.prev_close) advances++;
      else if (s.current_price < s.prev_close) declines++;
      else unchanged++;
    } else {
      unpriced++;
    }
    if (s.is_near_high) near52Count++;
  }

  const smeCount = mergedStocks.filter(stock => stock.segment === 'SME').length;
  const adRatio = parseFloat((advances / (declines || 1)).toFixed(2));
  const near52SurveyedCount = nse52Week.loaded
    ? mergedStocks.filter(s => s.nse_symbol && nse52Week.bySymbol.has(s.nse_symbol.toUpperCase())).length
    : (bse52Week.near52WeekScripCodes.size > 0
      ? mergedStocks.filter(stock => bse52Week.near52WeekScripCodes.has(String(stock.bse_scrip_code || ''))).length
      : 0);
  const near52Pct = near52SurveyedCount > 0
    ? parseFloat(((near52Count / near52SurveyedCount) * 100).toFixed(1))
    : null;

  const istDisplayFormatter = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  const istFormattedString = `${istDisplayFormatter.format(compileTime)} IST`;

  const nseFileStat = fs.statSync(nseTodayFile);
  const bseFileStat = fs.statSync(bseTodayFile);

  const recordedHistorySessions = Array.isArray(populatedHistoricalDates) && populatedHistoricalDates.length > 0
    ? populatedHistoricalDates
    : [...ACTIVE_WINDOW_DATES];

  const compactHistoryDataset = buildCompactHistoryPayload({
    sessions: recordedHistorySessions,
    priceHistoryByIsin,
    tradingDate: TARGET_TRADING_DATE,
    refreshedAtUtc: compileTime.toISOString(),
    maxSessions: historySessionCount
  });

  const marketStats = {
    tradingDate: TARGET_TRADING_DATE,
    nseSourceDate: nseDateInFile,
    bseSourceDate: bseDateInFile,
    fetchedAtUtc: fetchStartTime.toISOString(),
    refreshedAtUtc: compileTime.toISOString(),
    refreshedAt: compileTime.toISOString(),
    istDisplayTime: istFormattedString,
    totalStocks: mergedStocks.length,
    stockCount: mergedStocks.length,
    dataStatus: 'End-of-day official exchange Bhavcopy (EOD)',
    pipelineVersion: PIPELINE_VERSION,
    pipelineDates: {
      latestExpectedDate: resolution.latestExpectedDate,
      latestDownloadedDate: resolution.latestDownloadedDate || TARGET_TRADING_DATE,
      latestProcessedDate: TARGET_TRADING_DATE,
      latestPublishedDate: TARGET_TRADING_DATE
    },
    sourceFiles: [
      { exchange: 'NSE', fileName: path.basename(nseTodayFile), tradingDate: nseDateInFile, rows: nseRaw.length, bytes: nseFileStat.size },
      { exchange: 'BSE', fileName: path.basename(bseTodayFile), tradingDate: bseDateInFile, rows: bseRaw.length, bytes: bseFileStat.size },
      ...(nse52Week.loaded ? [{ exchange: 'NSE_52W', fileName: nse52Week.fileName, tradingDate: TARGET_TRADING_DATE }] : []),
      ...(archiveVix ? [{ exchange: 'NSE_IND', fileName: getIndicesFilename(TARGET_TRADING_DATE), tradingDate: TARGET_TRADING_DATE }] : [])
    ],
    sources: [
      'NSE CM Unified Bhavcopy',
      'BSE CM Unified Bhavcopy',
      'India Listed Companies Catalog (api.dharun.dev)',
      'Screener Indian Equities Dataset',
      ...(vixSource ? [vixSource] : []),
      ...(near52SourceName ? [near52SourceName] : []),
      ...(marketCapSources?.bseSecByIsin?.size ? ['BSE Security Master'] : [])
    ],
    nseCount: counts.nseCount,
    bseCount: counts.bseCount,
    dualListedCount: counts.dualListedCount,
    nseOnlyCount: counts.nseOnlyCount,
    bseOnlyCount: counts.bseOnlyCount,
    exchangeCoverage: {
      totalUnique: mergedStocks.length,
      nseListed: counts.nseCount,
      bseListed: counts.bseCount,
      dualListed: counts.dualListedCount,
      nseOnly: counts.nseOnlyCount,
      bseOnly: counts.bseOnlyCount,
      mathematicalIdentity: `dualListed(${counts.dualListedCount}) + nseOnly(${counts.nseOnlyCount}) + bseOnly(${counts.bseOnlyCount}) === ${mergedStocks.length}`
    },
    smeReconciliation: {
      nseSmeCount: counts.nseSmeCount,
      bseSmeCount: counts.bseSmeCount,
      dualListedSmeCount: counts.dualListedSmeCount,
      totalUniqueSme: smeCount,
      mainboardCount: mergedStocks.length - smeCount,
      classificationRule: 'NSE Series SM & ST (NSE Emerge) + BSE Groups M, MT & MS (BSE SME Platform)'
    },
    verifiedMarketCapCr: Math.round(totalVerifiedCap),
    marketCapCoverageCount: verifiedCapCount,
    marketCapCoveragePct: coveragePct,
    marketCapCoverageNote: `Verified ${verifiedCapCount.toLocaleString('en-IN')} Equities (NSE + BSE) · ${coveragePct}% Universe`,
    isPartialCoverage: verifiedCapCount < mergedStocks.length,
    rankingDisclaimer: `Market capitalisation ranking covers ${verifiedCapCount.toLocaleString('en-IN')} verified equities (NSE + BSE). This is an internal ranking of verified securities, NOT an official SEBI Large/Mid/Small classification.`,
    verifiedRankingSegments: {
      top100: verifiedSegments.top100,
      rank101_250: verifiedSegments.rank101_250,
      remainingVerified: verifiedSegments.remainingVerified,
      smePlatform: smeCount,
      unranked: verifiedSegments.unranked
    },
    capSegments: {
      large: verifiedSegments.top100,
      mid: verifiedSegments.rank101_250,
      small: verifiedSegments.remainingVerified,
      micro: verifiedSegments.unranked,
      sme: smeCount
    },
    vix: realVix,
    vixChangePct: realVixChangePct,
    vixDate: realVixDate,
    advances,
    declines,
    unchanged,
    unpriced,
    breadthEligibleCount: breadthCount,
    adRatio,
    marketBreadth: {
      advances,
      declines,
      unchanged,
      unpriced,
      breadthEligible: breadthCount,
      totalUniverse: mergedStocks.length,
      adRatio,
      mathematicalIdentity: `advances(${advances}) + declines(${declines}) + unchanged(${unchanged}) + unpriced(${unpriced}) === ${mergedStocks.length}`
    },
    near52WeekHighCount: near52SurveyedCount > 0 ? near52Count : null,
    near52WeekHighPct: near52Pct,
    near52WeekHighSurveyedUniverse: near52SurveyedCount > 0
      ? (nse52Week.loaded
        ? `NSE Official 52-Week High/Low Archive (${near52SurveyedCount} matched equities)`
        : `BSE Groups A & B only (${near52SurveyedCount} matched equities)`)
      : 'No verified 52-week high records for this session',
    near52WeekHighCoverage: near52SurveyedCount > 0 ? `${near52Count} of ${near52SurveyedCount} equities within 8% of 52W High` : null,
    near52WeekHighSource: near52SourceName,
    near52WeekHighTradingDate: near52SurveyedCount > 0 ? TARGET_TRADING_DATE : null,
    near52WeekHighExchangeTimestamp: null,
    near52WeekHighStatus: near52SourceStatus,
    historicalSessions: (() => {
      const recordedSessions = Array.isArray(populatedHistoricalDates) && populatedHistoricalDates.length > 0
        ? populatedHistoricalDates
        : [...ACTIVE_WINDOW_DATES];
      return {
        maxSessions: historySessionCount,
        sessionCount: recordedSessions.length,
        startDate: recordedSessions[0],
        endDate: recordedSessions[recordedSessions.length - 1],
        sessions: recordedSessions,
        activeWindowSessions: [...ACTIVE_WINDOW_DATES],
        returnWindows: {
          oneWeek: RETURN_WINDOW_1W_SESSIONS,
          oneMonth: RETURN_WINDOW_1M_SESSIONS,
          threeMonth: RETURN_WINDOW_3M_SESSIONS
        },
        methodology: `Chronological EOD closing prices across up to ${historySessionCount} consecutive verified trading sessions (${recordedSessions[0]} to ${recordedSessions[recordedSessions.length - 1]}; ${recordedSessions.length} verified session(s) populated). 1W, ~1M, and ~3M returns use ${RETURN_WINDOW_1W_SESSIONS}, ${RETURN_WINDOW_1M_SESSIONS}, and ${RETURN_WINDOW_3M_SESSIONS} trading sessions when sufficient verified history is available.`
      };
    })(),
    changeLogSummary: changeLog.summary,
    changeLogFile: `downloads/universe-changes-${TARGET_TRADING_DATE}.json`,
    automationStatus: {
      pipelineMode: process.env.GITHUB_ACTIONS ? 'GITHUB_ACTIONS_STORAGE_SYNC' : 'LOCAL_AND_GITHUB_ACTIONS',
      localDownloader: 'Direct Official NSE/BSE HTTPS Archives (src/ingestion/bhavcopy-downloader.js)',
      cloudAutomation: 'GitHub Actions -> Persistent Supabase Storage (zero git commits)'
    }
  };

  const integrity = validateMergedDataset(mergedStocks, marketStats, {
    minUniverseSize: options.minUniverseSize ?? minSourceRows,
    previousCount: previousUniverseByIsin.size,
    maxHistoricalSessions: historySessionCount,
    historyDataset: compactHistoryDataset,
    force
  });

  if (integrity.warnings.length > 0) {
    integrity.warnings.forEach(w => logger.warn(`  Warning: ${w}`));
  }
  if (!integrity.ok) {
    throw new Error(`Dataset integrity validation FAILED:\n  - ${integrity.errors.join('\n  - ')}`);
  }

  if (!dryRun) {
    const changeLogFile = path.join(downloadsDir, `universe-changes-${TARGET_TRADING_DATE}.json`);
    const changeTmp = `${changeLogFile}.tmp.${process.pid}`;
    fs.writeFileSync(changeTmp, JSON.stringify(changeLog, null, 2), 'utf8');
    fs.renameSync(changeTmp, changeLogFile);
  }

  if (!skipLocalWrite) {
    writeLocalDatasetAtomically(targetPath, backupPath, marketStats, mergedStocks, istFormattedString, compileTime);
    logger.log(`  Published ${mergedStocks.length} verified stocks locally to ${targetPath}`);
  } else {
    logger.log(`  [Dry Run] Validated ${mergedStocks.length} stocks for ${TARGET_TRADING_DATE} (skipped local write).`);
  }

  let storageResult = null;
  if (!dryRun && !skipStorage && storageClient.isWriteConfigured()) {
    storageResult = await storageClient.publishDatasetToStorage(marketStats, mergedStocks, {
      allowDowngrade,
      force,
      historicalDataset: compactHistoryDataset,
      maxHistoricalSessions: historySessionCount,
      retentionDryRun: Boolean(options.retentionDryRun || process.argv.includes('--retention-dry-run')),
      skipRetention: Boolean(options.skipRetention)
    });
    if (!storageResult.ok) {
      throw new Error(`External storage publish failed: ${storageResult.error}`);
    }
    if (typeof storageClient.fetchLatestManifest === 'function') {
      const verifyManifest = await storageClient.fetchLatestManifest();
      if (!verifyManifest.ok || verifyManifest.manifest?.tradingDate !== TARGET_TRADING_DATE) {
        throw new Error(
          `Post-publish manifest verification failed: expected tradingDate=${TARGET_TRADING_DATE}, got ${verifyManifest.manifest?.tradingDate || verifyManifest.error || 'missing'}`
        );
      }
    }
    logger.log(`  Published immutable storage snapshot: ${storageResult.datasetPath} -> ${storageResult.versionId}`);
    if (options.syncReference || process.argv.includes('--sync-reference')) {
      await uploadReferenceFilesToStorage(downloadsDir, storageClient, logger);
    }
  }

  if (!dryRun && !options.skipReport) {
    const missingList = mergedStocks
      .filter(s => s.market_cap_cr == null)
      .map(s => {
        let reason = 'Unpriced / Inactive listed equity with zero trading volume';
        if (s.isin && s.isin.startsWith('IN9')) reason = 'Partly-Paid shares (PP series); equity capital represented in ordinary shares';
        else if (s.symbol && (s.symbol.includes('-RE') || s.symbol.includes('RE1'))) reason = 'Rights Entitlement (RE series); temporary trading rights, not equity shares';
        else if (s.segment === 'SME') reason = 'SME equity without recent valuation or quotes';
        return { symbol: s.symbol, company_name: s.company_name, isin: s.isin, exchanges: s.exchanges, segment: s.segment, reason };
      });

    const sourcesBreakdown = {};
    for (const s of mergedStocks) {
      if (s.market_cap_source) {
        sourcesBreakdown[s.market_cap_source] = (sourcesBreakdown[s.market_cap_source] || 0) + 1;
      }
    }

    generateCoverageReport({
      tradingDate: TARGET_TRADING_DATE,
      totalEligible: mergedStocks.length,
      nseCount: counts.nseCount,
      bseCount: counts.bseCount,
      dualCount: counts.dualListedCount,
      verifiedCount: verifiedCapCount,
      missingCount: mergedStocks.length - verifiedCapCount,
      coveragePct,
      totalVerifiedCapCr: totalVerifiedCap,
      sourcesBreakdown,
      missingList,
      segments: verifiedSegments
    });
  }

  return { marketStats, stocksCount: mergedStocks.length, changeLog, storageResult, dryRun };
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      const pid = Number(data.pid);
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch (_) {
          alive = false;
        }
      }
      const ageMs = Date.now() - (Number(data.startedAtMs) || 0);
      if (alive && ageMs < 30 * 60 * 1000) {
        return { acquired: false, holderPid: pid, startedAt: data.startedAt };
      }
      fs.unlinkSync(lockPath);
    } catch (_) {
      try { fs.unlinkSync(lockPath); } catch (__) {}
    }
  }
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), startedAtMs: Date.now() }), 'utf8');
  return { acquired: true };
}

function releaseLock(lockPath) {
  if (fs.existsSync(lockPath)) {
    try { fs.unlinkSync(lockPath); } catch (_) {}
  }
}

async function runRefresh(options = {}) {
  const downloadsDir = options.downloadsDir || DOWNLOADS_DIR;
  const targetPath = options.targetPath || TARGET_DATA_PATH;
  const backupPath = options.backupPath !== undefined ? options.backupPath : BACKUP_DATA_PATH;
  const lockPath = options.lockPath || path.join(downloadsDir, '.refresh.lock');
  const now = options.now || new Date();
  const logger = options.logger || console;

  const modeBackfill = Boolean(options.backfill);
  const explicitDate = options.date || null;
  const downloadOnly = Boolean(options.downloadOnly);
  const syncOnly = Boolean(options.syncOnly);
  const force = Boolean(options.force);
  const dryRun = Boolean(options.dryRun);
  const allowDowngrade = Boolean(options.allowDowngrade);
  const wait = Boolean(options.wait);
  const envWait = Number(process.env.REFRESH_WAIT_MINUTES);
  const waitMinutes = options.waitMinutes !== undefined
    ? options.waitMinutes
    : (Number.isFinite(envWait) && envWait >= 0 ? envWait : 15);
  const envPoll = Number(process.env.REFRESH_POLL_SECONDS);
  const pollSeconds = options.pollSeconds !== undefined
    ? options.pollSeconds
    : (Number.isFinite(envPoll) && envPoll > 0 ? envPoll : 30);
  const minRows = options.minRows ?? 1000;
  const minBytes = options.minBytes ?? 50000;
  const skipStorage = Boolean(options.skipStorage);
  const storageClient = options.storageClient || defaultStorage;

  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    return {
      ok: false,
      status: 'locked',
      error: `Another refresh process (PID ${lock.holderPid}) is already running since ${lock.startedAt}.`
    };
  }

  try {
    const calendar = getLatestExpectedTradingDate(now);
    const latestExpectedDate = calendar.latestExpectedDate;
    const localPublishedDate = readPublishedTradingDate(targetPath);

    let remoteManifest = null;
    if (!skipStorage && storageClient.isReadConfigured()) {
      const mRes = await storageClient.fetchLatestManifest();
      if (mRes.ok) remoteManifest = mRes.manifest;
    }

    const latestPublishedDate = (!skipStorage && storageClient.isReadConfigured())
      ? (remoteManifest?.tradingDate || null)
      : localPublishedDate;

    const downloader = options.downloader || createDownloader({
      downloadsDir,
      minNseRows: minRows,
      minBseRows: minRows,
      minBytes,
      logger
    });
    const syncFn = options.syncFn || syncUniverse;

    downloader.cleanupTempFiles(downloadsDir);
    let stored = downloader.inspectStoredSessions();
    const freshness = checkSessionFreshness(latestPublishedDate, now);

    logger.log('═══════════════════════════════════════════════════════════════');
    logger.log(` MACHII BAZZAR — MARKET DATA REFRESH PIPELINE${dryRun ? ' [DRY RUN]' : ''}`);
    logger.log(`   Latest Expected Date   : ${latestExpectedDate}`);
    logger.log(`   Latest Downloaded Date : ${stored.latestCompleteDate || 'none'}`);
    logger.log(`   Latest Published Date  : ${latestPublishedDate || 'none'} (${storageClient.isReadConfigured() && !skipStorage ? 'external storage' : 'local'})`);
    logger.log(`   Freshness Status       : ${freshness.freshnessStatus.toUpperCase()} — ${freshness.reason}`);
    logger.log('═══════════════════════════════════════════════════════════════\n');

    if (explicitDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(explicitDate) || !isTradingDay(explicitDate)) {
        return {
          ok: false,
          status: 'invalid_date',
          error: `Requested date ${explicitDate} is not a valid exchange trading day.`,
          dates: { latestExpectedDate, latestDownloadedDate: stored.latestCompleteDate, latestPublishedDate, latestProcessedDate: null }
        };
      }
      if (explicitDate > latestExpectedDate) {
        return {
          ok: false,
          status: 'future_date',
          error: `Requested date ${explicitDate} is ahead of latest expected session ${latestExpectedDate}.`,
          dates: { latestExpectedDate, latestDownloadedDate: stored.latestCompleteDate, latestPublishedDate, latestProcessedDate: null }
        };
      }
      if (latestPublishedDate && explicitDate < latestPublishedDate && !allowDowngrade) {
        return {
          ok: false,
          status: 'downgrade_refused',
          error: `Refusing to downgrade published dataset (${latestPublishedDate}) to older date (${explicitDate}).`,
          dates: { latestExpectedDate, latestDownloadedDate: stored.latestCompleteDate, latestPublishedDate, latestProcessedDate: null }
        };
      }
    }

    if (!modeBackfill && !explicitDate && !force && !downloadOnly && !syncOnly && freshness.isFresh) {
      if (remoteManifest && !skipStorage && storageClient.isReadConfigured()) {
        return {
          ok: true,
          status: 'up_to_date',
          tradingDate: latestPublishedDate,
          stockCount: remoteManifest.totalStocks,
          storageVersionId: remoteManifest.versionId,
          dates: {
            latestExpectedDate,
            latestDownloadedDate: stored.latestCompleteDate,
            latestProcessedDate: latestPublishedDate,
            latestPublishedDate
          }
        };
      }
      const currentValidation = validatePublishedDataset(targetPath, latestPublishedDate);
      if (currentValidation.ok) {
        return {
          ok: true,
          status: 'up_to_date',
          tradingDate: latestPublishedDate,
          stockCount: currentValidation.stockCount,
          dates: {
            latestExpectedDate,
            latestDownloadedDate: stored.latestCompleteDate,
            latestProcessedDate: latestPublishedDate,
            latestPublishedDate
          }
        };
      }
    }

    const targetDate = explicitDate || latestExpectedDate;
    let backfillSummary = null;

    if (!syncOnly) {
      if (modeBackfill) {
        backfillSummary = await downloader.backfillSessions(targetDate, {
          fromDate: options.fromDate || null,
          force
        });
        stored = downloader.inspectStoredSessions();
      } else {
        const windowSessions = getRecentTradingSessions(targetDate, DOWNLOAD_WINDOW_SESSIONS);
        for (const histDate of windowSessions.slice(0, -1)) {
          await downloader.downloadSession(histDate, { includeSupplementary: false });
        }

        const primaryRes = wait
          ? await downloader.waitForSessionPublication(targetDate, {
              force,
              maxWaitMs: waitMinutes * 60 * 1000,
              pollIntervalMs: pollSeconds * 1000
            })
          : await downloader.downloadSession(targetDate, { force });

        stored = downloader.inspectStoredSessions();

        if (!primaryRes.bothOk) {
          const status = primaryRes.pendingPublication ? 'delayed_publication' : 'download_failed';
          return {
            ok: false,
            status,
            error: `NSE/BSE BhavCopy incomplete for ${targetDate}`,
            nse: primaryRes.nse,
            bse: primaryRes.bse,
            retainedTradingDate: latestPublishedDate,
            dates: {
              latestExpectedDate,
              latestDownloadedDate: stored.latestCompleteDate,
              latestProcessedDate: null,
              latestPublishedDate
            }
          };
        }
      }
    }

    if (downloadOnly) {
      return {
        ok: true,
        status: 'downloaded',
        backfillSummary,
        dates: {
          latestExpectedDate,
          latestDownloadedDate: stored.latestCompleteDate,
          latestProcessedDate: null,
          latestPublishedDate
        }
      };
    }

    let compileDate = targetDate;
    if ((modeBackfill || syncOnly) && !explicitDate) {
      if (!stored.latestCompleteDate) {
        return {
          ok: false,
          status: 'no_complete_session',
          error: syncOnly
            ? 'No complete NSE+BSE session found in downloads/ for --sync-only.'
            : 'No complete NSE+BSE session found in downloads/ after backfill.',
          backfillSummary,
          dates: { latestExpectedDate, latestDownloadedDate: null, latestProcessedDate: null, latestPublishedDate }
        };
      }
      compileDate = stored.latestCompleteDate;
      if (latestPublishedDate && compileDate < latestPublishedDate && !allowDowngrade) {
        return {
          ok: false,
          status: 'downgrade_refused',
          error: `${syncOnly ? 'Latest local downloaded' : 'Backfill latest downloaded'} (${compileDate}) is older than published (${latestPublishedDate}).`,
          backfillSummary,
          dates: { latestExpectedDate, latestDownloadedDate: stored.latestCompleteDate, latestPublishedDate, latestProcessedDate: null }
        };
      }
      if (latestPublishedDate && compileDate === latestPublishedDate && !force) {
        return {
          ok: true,
          status: 'up_to_date',
          tradingDate: latestPublishedDate,
          backfillSummary,
          dates: {
            latestExpectedDate,
            latestDownloadedDate: stored.latestCompleteDate,
            latestProcessedDate: latestPublishedDate,
            latestPublishedDate
          }
        };
      }
    }

    const syncResult = await syncFn({
      targetDate: compileDate,
      downloadsDir,
      targetPath,
      backupPath,
      force,
      dryRun,
      allowDowngrade,
      refreshCatalog: Boolean(options.refreshCatalog),
      skipReport: Boolean(options.skipReport),
      skipStorage,
      skipRetention: Boolean(options.skipRetention),
      retentionDryRun: Boolean(options.retentionDryRun),
      syncReference: Boolean(options.syncReference),
      storageClient,
      minSourceRows: options.minSourceRows,
      minUniverseSize: options.minUniverseSize,
      historySessionCount: options.historySessionCount,
      minBytes,
      marketCapSources: options.marketCapSources,
      now
    });

    if (dryRun) {
      return {
        ok: true,
        status: 'dry_run_validated',
        tradingDate: syncResult.marketStats.tradingDate,
        stockCount: syncResult.stocksCount,
        marketStats: syncResult.marketStats,
        dates: {
          latestExpectedDate,
          latestDownloadedDate: stored.latestCompleteDate,
          latestProcessedDate: syncResult.marketStats.tradingDate,
          latestPublishedDate
        }
      };
    }

    const validation = validatePublishedDataset(targetPath, compileDate);
    if (!validation.ok) {
      return {
        ok: false,
        status: 'validation_failed',
        error: validation.error,
        dates: {
          latestExpectedDate,
          latestDownloadedDate: stored.latestCompleteDate,
          latestProcessedDate: null,
          latestPublishedDate
        }
      };
    }

    return {
      ok: true,
      status: 'updated',
      tradingDate: validation.tradingDate,
      stockCount: validation.stockCount,
      marketStats: syncResult.marketStats,
      storageResult: syncResult.storageResult || null,
      backfillSummary,
      dates: {
        latestExpectedDate,
        latestDownloadedDate: stored.latestCompleteDate,
        latestProcessedDate: validation.tradingDate,
        latestPublishedDate: validation.tradingDate
      }
    };
  } finally {
    releaseLock(lockPath);
  }
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const dateArg = (argv.find(a => a.startsWith('--date=')) || '').split('=')[1] ||
    argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || null;
  const fromDate = (argv.find(a => a.startsWith('--from=')) || '').split('=')[1] || null;
  const rawWait = argv.find(a => a.startsWith('--wait-minutes='))?.split('=')[1];
  const parsedWait = rawWait !== undefined ? Number(rawWait) : Number(process.env.REFRESH_WAIT_MINUTES);
  const waitMinutes = Number.isFinite(parsedWait) && parsedWait >= 0 ? parsedWait : 15;

  const rawPoll = argv.find(a => a.startsWith('--poll-seconds='))?.split('=')[1];
  const parsedPoll = rawPoll !== undefined ? Number(rawPoll) : Number(process.env.REFRESH_POLL_SECONDS);
  const pollSeconds = Number.isFinite(parsedPoll) && parsedPoll > 0 ? parsedPoll : 30;

  return {
    backfill: argv.includes('--backfill'),
    latest: argv.includes('--latest'),
    downloadOnly: argv.includes('--download-only'),
    syncOnly: argv.includes('--sync-only'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run'),
    retentionDryRun: argv.includes('--retention-dry-run'),
    syncReference: argv.includes('--sync-reference'),
    allowDowngrade: argv.includes('--allow-downgrade'),
    refreshCatalog: argv.includes('--refresh-catalog'),
    skipStorage: argv.includes('--skip-storage'),
    wait: argv.includes('--wait'),
    waitMinutes,
    pollSeconds,
    date: dateArg,
    fromDate
  };
}

module.exports = {
  PIPELINE_VERSION,
  parseCsv: parseCSVContent,
  cleanCompanyName,
  normalizeSourceDate: parseDateStr,
  readExistingDataset,
  readPublishedTradingDate,
  validatePublishedDataset,
  resolveTargetTradingDate,
  uploadReferenceFilesToStorage,
  syncUniverse,
  runRefresh,
  parseCliArgs
};
