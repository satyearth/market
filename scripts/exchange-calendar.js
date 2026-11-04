/**
 * Machli Bazzar — Indian Stock Exchange (NSE & BSE) Calendar & Session Freshness
 *
 * Implements:
 * 1. Asia/Kolkata (IST) time calculations.
 * 2. Weekend identification (Saturday & Sunday).
 * 3. Official 2026 Indian Stock Exchange holiday calendar (NSE & BSE).
 * 4. Bhavcopy publication cutoff logic (16:30 IST on trading days).
 * 5. Session freshness evaluation comparing active dataset against expected trading session.
 */

// Official NSE & BSE Trading Holidays for Calendar Year 2026
const EXCHANGE_HOLIDAYS_2026 = new Set([
  '2026-01-26', // Republic Day
  '2026-03-03', // Holi
  '2026-03-20', // Id-Ul-Fitr (Ramzan Id)
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Baba Saheb Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-05-27', // Bakri Id
  '2026-08-15', // Independence Day
  '2026-08-26', // Milad-un-Nabi
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-10', // Diwali Laxmi Pujan (Muhurat trading session only)
  '2026-11-24', // Guru Nanak Jayanti
  '2026-12-25'  // Christmas
]);

/**
 * Returns the current date and time converted to Indian Standard Time (IST, UTC+5:30)
 * @param {Date} [dateObj] Optional custom Date object (defaults to new Date())
 * @returns {object} { year, month, day, hours, minutes, dateString, istDate }
 */
function getIstTime(dateObj = new Date()) {
  // Use Intl.DateTimeFormat with Asia/Kolkata timezone
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
  parts.forEach(p => partMap[p.type] = p.value);

  const year = parseInt(partMap.year, 10);
  const month = parseInt(partMap.month, 10);
  const day = parseInt(partMap.day, 10);
  const hours = parseInt(partMap.hour, 10);
  const minutes = parseInt(partMap.minute, 10);
  const dateString = `${partMap.year}-${partMap.month}-${partMap.day}`;

  // Construct a Date object representing the IST calendar day
  const istDate = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  const dayOfWeek = istDate.getUTCDay(); // 0 = Sunday, 6 = Saturday

  return {
    year,
    month,
    day,
    hours,
    minutes,
    dateString,
    dayOfWeek, // 0 = Sun, 1 = Mon, ..., 6 = Sat
    isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
    isHoliday: EXCHANGE_HOLIDAYS_2026.has(dateString)
  };
}

/**
 * Checks if a given YYYY-MM-DD date is a trading day
 */
function isTradingDay(dateString) {
  if (EXCHANGE_HOLIDAYS_2026.has(dateString)) return false;
  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  return dow !== 0 && dow !== 6;
}

/**
 * Steps backward from a given YYYY-MM-DD string to find the previous valid trading day
 */
function getPreviousTradingDay(dateString) {
  const [y, m, d] = dateString.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));

  while (true) {
    dt.setUTCDate(dt.getUTCDate() - 1);
    const yr = dt.getUTCFullYear();
    const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const da = String(dt.getUTCDate()).padStart(2, '0');
    const candidate = `${yr}-${mo}-${da}`;
    if (isTradingDay(candidate)) {
      return candidate;
    }
  }
}

/**
 * Computes the latest expected finalized EOD trading date based on current IST time.
 * EOD Bhavcopy publication rule:
 * - On a trading day:
 *   - If current IST time is BEFORE 16:30 IST: EOD Bhavcopy is not yet published. The latest available EOD is the previous trading day.
 *   - If current IST time is AFTER 16:30 IST: Today's EOD Bhavcopy is published and expected.
 * - On a weekend or holiday:
 *   - Latest available EOD is the previous trading day.
 *
 * @param {Date} [now]
 * @returns {object} { latestExpectedDate, isMarketOpenNow, isEodPublishedToday, reason }
 */
function getLatestExpectedTradingDate(now = new Date()) {
  const ist = getIstTime(now);

  // Check if today is a trading day
  const isTodayTradingDay = !ist.isWeekend && !ist.isHoliday;

  // Market hours: 09:15 to 15:30 IST
  const currentMinutesFromMidnight = ist.hours * 60 + ist.minutes;
  const marketOpenMinutes = 9 * 60 + 15;  // 09:15 IST
  const marketCloseMinutes = 15 * 60 + 30; // 15:30 IST
  const eodPublishMinutes = 16 * 60 + 30;  // 16:30 IST (Bhavcopy publication window begins)

  const isMarketOpenNow = isTodayTradingDay &&
    currentMinutesFromMidnight >= marketOpenMinutes &&
    currentMinutesFromMidnight < marketCloseMinutes;

  if (ist.isWeekend) {
    const prevTradingDay = getPreviousTradingDay(ist.dateString);
    return {
      latestExpectedDate: prevTradingDay,
      isMarketOpenNow: false,
      isEodPublishedToday: false,
      isWeekend: true,
      isHoliday: false,
      reason: `Weekend (${ist.dayOfWeek === 6 ? 'Saturday' : 'Sunday'}) — Exchanges closed. Latest session: ${prevTradingDay}`
    };
  }

  if (ist.isHoliday) {
    const prevTradingDay = getPreviousTradingDay(ist.dateString);
    return {
      latestExpectedDate: prevTradingDay,
      isMarketOpenNow: false,
      isEodPublishedToday: false,
      isWeekend: false,
      isHoliday: true,
      reason: `Exchange Holiday (${ist.dateString}) — Exchanges closed. Latest session: ${prevTradingDay}`
    };
  }

  // Today is a regular weekday trading day
  if (currentMinutesFromMidnight < eodPublishMinutes) {
    // Bhavcopy for today not yet published by NSE/BSE
    const prevTradingDay = getPreviousTradingDay(ist.dateString);
    return {
      latestExpectedDate: prevTradingDay,
      isMarketOpenNow,
      isEodPublishedToday: false,
      isWeekend: false,
      isHoliday: false,
      reason: isMarketOpenNow
        ? `Market is currently open (09:15–15:30 IST). Today's EOD Bhavcopy publishes after 16:30 IST. Latest EOD session: ${prevTradingDay}`
        : `Pre-market / session in progress. Today's EOD Bhavcopy publishes after 16:30 IST. Latest EOD session: ${prevTradingDay}`
    };
  }

  // After 16:30 IST on a trading day: today's Bhavcopy is expected
  return {
    latestExpectedDate: ist.dateString,
    isMarketOpenNow: false,
    isEodPublishedToday: true,
    isWeekend: false,
    isHoliday: false,
    reason: `Trading session closed and EOD Bhavcopy published for ${ist.dateString}`
  };
}

/**
 * Checks if the current dataset trading date is fresh or if a newer session is expected
 * @param {string} datasetTradingDate e.g. "2026-11-04"
 * @param {Date} [now]
 * @returns {object} { isFresh, latestExpectedDate, reason, needsSync }
 */
function checkSessionFreshness(datasetTradingDate, now = new Date()) {
  const { latestExpectedDate, reason, isMarketOpenNow, isWeekend, isHoliday } = getLatestExpectedTradingDate(now);

  if (!datasetTradingDate) {
    return {
      isFresh: false,
      needsSync: true,
      latestExpectedDate,
      reason: 'No trading date found in active dataset.'
    };
  }

  if (datasetTradingDate === latestExpectedDate) {
    return {
      isFresh: true,
      needsSync: false,
      latestExpectedDate,
      reason: `Dataset is up-to-date with latest finalized exchange session (${latestExpectedDate}). ${reason}`
    };
  }

  if (datasetTradingDate > latestExpectedDate) {
    // Current dataset is already equal or ahead of expected (e.g. forward date test)
    return {
      isFresh: true,
      needsSync: false,
      latestExpectedDate,
      reason: `Dataset date (${datasetTradingDate}) is current.`
    };
  }

  // datasetTradingDate < latestExpectedDate: Newer session is available!
  return {
    isFresh: false,
    needsSync: true,
    latestExpectedDate,
    reason: `Newer exchange session (${latestExpectedDate}) is available (current dataset: ${datasetTradingDate}). Sync required.`
  };
}

module.exports = {
  EXCHANGE_HOLIDAYS_2026,
  getIstTime,
  isTradingDay,
  getPreviousTradingDay,
  getLatestExpectedTradingDate,
  checkSessionFreshness
};

