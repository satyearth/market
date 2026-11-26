'use strict';

/**
 * Indian Stock Exchange (NSE & BSE) Calendar & Session Freshness Evaluator
 *
 * Uses Asia/Kolkata (IST) wall-clock conversions, weekend identification,
 * special Muhurat trading session overrides, official 2026 weekday exchange
 * holidays, and EOD BhavCopy publication cutoff windows (16:30 IST regular,
 * 19:30 IST special Muhurat).
 */

const EXCHANGE_HOLIDAYS_2026 = new Set([
  '2026-01-15', // Municipal Corporation Election - Maharashtra
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-26', // Shri Ram Navami
  '2026-03-31', // Shri Mahavir Jayanti
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-28', // Bakri Id
  '2026-06-26', // Muharram
  '2026-09-14', // Ganesh Chaturthi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali-Balipratipada
  '2026-11-24', // Prakash Gurpurb Sri Guru Nanak Dev
  '2026-12-25'  // Christmas
]);

const SPECIAL_TRADING_SESSIONS_2026 = new Set([
  '2026-11-08' // Sunday Diwali Laxmi Pujan Muhurat Trading Session
]);

/**
 * Converts a Date object into Asia/Kolkata (IST) calendar fields.
 */
function getIstTime(dateObj = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(dateObj);
  const partMap = {};
  for (const part of parts) {
    partMap[part.type] = part.value;
  }

  const year = parseInt(partMap.year, 10);
  const month = parseInt(partMap.month, 10);
  const day = parseInt(partMap.day, 10);
  const hours = parseInt(partMap.hour, 10) % 24;
  const minutes = parseInt(partMap.minute, 10);
  const dateString = `${partMap.year}-${partMap.month}-${partMap.day}`;

  const istDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  const dayOfWeek = istDate.getUTCDay();
  const isSpecialSession = SPECIAL_TRADING_SESSIONS_2026.has(dateString);

  return {
    year,
    month,
    day,
    hours,
    minutes,
    dateString,
    dayOfWeek,
    isWeekend: (dayOfWeek === 0 || dayOfWeek === 6) && !isSpecialSession,
    isRawWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    isHoliday: EXCHANGE_HOLIDAYS_2026.has(dateString),
    isSpecialSession
  };
}

/**
 * Returns true if the given YYYY-MM-DD date is a valid exchange trading day.
 */
function isTradingDay(dateString) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateString || ''))) return false;
  if (SPECIAL_TRADING_SESSIONS_2026.has(dateString)) return true;
  if (EXCHANGE_HOLIDAYS_2026.has(dateString)) return false;

  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (Number.isNaN(dt.getTime())) return false;
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== m || dt.getUTCDate() !== d) return false;
  const dow = dt.getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * Steps backward from a YYYY-MM-DD string to find the previous valid trading session.
 */
function getPreviousTradingDay(dateString) {
  const [y, m, d] = String(dateString || '').split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));

  for (let guard = 0; guard < 30; guard++) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const yr = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const da = String(dt.getUTCDate()).padStart(2, '0');
    const candidate = `${yr}-${mo}-${da}`;
    if (isTradingDay(candidate)) return candidate;
  }
  throw new Error(`Could not find previous trading day before ${dateString}`);
}

/**
 * Returns chronological trading sessions in (startDate, endDate] or [startDate, endDate].
 */
function getTradingDaysInRange(startDate, endDate, inclusiveStart = false) {
  if (!startDate || !endDate || endDate < startDate) return [];
  const days = [];
  let curr = endDate;
  while (curr > startDate || (inclusiveStart && curr === startDate)) {
    if (isTradingDay(curr)) days.push(curr);
    if (curr <= startDate) break;
    curr = getPreviousTradingDay(curr);
  }
  return days.reverse();
}

/**
 * Returns the last N valid trading sessions ending at targetDate (inclusive if trading day).
 */
function getRecentTradingSessions(targetDate, count = 6) {
  const sessions = [];
  let curr = isTradingDay(targetDate) ? targetDate : getPreviousTradingDay(targetDate);
  while (sessions.length < count) {
    sessions.unshift(curr);
    curr = getPreviousTradingDay(curr);
  }
  return sessions;
}

/**
 * Determines the latest expected finalized EOD BhavCopy trading date at `now`.
 */
function getLatestExpectedTradingDate(now = new Date()) {
  const ist = getIstTime(now);
  const isTodayTradingDay = !ist.isWeekend && !ist.isHoliday;

  const currentMinutes = ist.hours * 60 + ist.minutes;
  const marketOpenMinutes = 9 * 60 + 15;
  const marketCloseMinutes = 15 * 60 + 30;
  const eodPublishMinutes = ist.isSpecialSession ? (19 * 60 + 30) : (16 * 60 + 30);

  const isMarketOpenNow = isTodayTradingDay && !ist.isSpecialSession &&
    currentMinutes >= marketOpenMinutes &&
    currentMinutes < marketCloseMinutes;

  if (ist.isWeekend) {
    const prevTradingDay = getPreviousTradingDay(ist.dateString);
    return {
      latestExpectedDate: prevTradingDay,
      currentIstDate: ist.dateString,
      isMarketOpenNow: false,
      isEodPublishedToday: false,
      isWeekend: true,
      isHoliday: false,
      isSpecialSession: false,
      reason: `Weekend (${ist.dayOfWeek === 6 ? 'Saturday' : 'Sunday'}) — Exchanges closed. Latest session: ${prevTradingDay}`
    };
  }

  if (ist.isHoliday) {
    const prevTradingDay = getPreviousTradingDay(ist.dateString);
    return {
      latestExpectedDate: prevTradingDay,
      currentIstDate: ist.dateString,
      isMarketOpenNow: false,
      isEodPublishedToday: false,
      isWeekend: false,
      isHoliday: true,
      isSpecialSession: false,
      reason: `Exchange Holiday (${ist.dateString}) — Exchanges closed. Latest session: ${prevTradingDay}`
    };
  }

  if (currentMinutes < eodPublishMinutes) {
    const prevTradingDay = getPreviousTradingDay(ist.dateString);
    return {
      latestExpectedDate: prevTradingDay,
      currentIstDate: ist.dateString,
      isMarketOpenNow,
      isEodPublishedToday: false,
      isWeekend: false,
      isHoliday: false,
      isSpecialSession: ist.isSpecialSession,
      reason: isMarketOpenNow
        ? `Market is currently open (09:15–15:30 IST). Today's EOD Bhavcopy publishes after 16:30 IST. Latest EOD session: ${prevTradingDay}`
        : `Pre-market / session pending EOD publication. Latest finalized EOD session: ${prevTradingDay}`
    };
  }

  return {
    latestExpectedDate: ist.dateString,
    currentIstDate: ist.dateString,
    isMarketOpenNow: false,
    isEodPublishedToday: true,
    isWeekend: false,
    isHoliday: false,
    isSpecialSession: ist.isSpecialSession,
    reason: `Trading session closed and EOD Bhavcopy expected for ${ist.dateString}`
  };
}

/**
 * Evaluates dataset trading date freshness against expected session rules.
 */
function checkSessionFreshness(datasetTradingDate, now = new Date()) {
  const calendar = getLatestExpectedTradingDate(now);
  const { latestExpectedDate, reason } = calendar;

  if (!datasetTradingDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(datasetTradingDate))) {
    return {
      isFresh: false,
      needsSync: true,
      freshnessStatus: 'unknown',
      isDelayed: false,
      isStale: true,
      missingSessionsCount: null,
      latestExpectedDate,
      reason: 'No valid trading date found in active dataset.'
    };
  }

  if (datasetTradingDate >= latestExpectedDate) {
    return {
      isFresh: true,
      needsSync: false,
      freshnessStatus: 'current',
      isDelayed: false,
      isStale: false,
      missingSessionsCount: 0,
      latestExpectedDate,
      reason: datasetTradingDate === latestExpectedDate
        ? `Dataset is up-to-date with latest finalized exchange session (${latestExpectedDate}). ${reason}`
        : `Dataset date (${datasetTradingDate}) is current.`
    };
  }

  const missingSessions = getTradingDaysInRange(datasetTradingDate, latestExpectedDate, false);
  const missingSessionsCount = missingSessions.length;
  const prevExpected = getPreviousTradingDay(latestExpectedDate);
  const isDelayed = missingSessionsCount === 1 &&
    latestExpectedDate === calendar.currentIstDate &&
    datasetTradingDate === prevExpected;

  return {
    isFresh: false,
    needsSync: true,
    freshnessStatus: isDelayed ? 'delayed' : 'stale',
    isDelayed,
    isStale: !isDelayed,
    missingSessionsCount,
    missingSessions,
    latestExpectedDate,
    reason: isDelayed
      ? `Today's session (${latestExpectedDate}) BhavCopy is pending or delayed; showing previous valid session (${datasetTradingDate}).`
      : `Dataset is behind by ${missingSessionsCount} trading session${missingSessionsCount === 1 ? '' : 's'} (active: ${datasetTradingDate}, latest expected: ${latestExpectedDate}). Sync required.`
  };
}

module.exports = {
  EXCHANGE_HOLIDAYS_2026,
  SPECIAL_TRADING_SESSIONS_2026,
  getIstTime,
  isTradingDay,
  getPreviousTradingDay,
  getTradingDaysInRange,
  getRecentTradingSessions,
  getLatestExpectedTradingDate,
  checkSessionFreshness
};
