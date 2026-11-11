import * as chrono from 'chrono-node';
import type { TemporalResolution } from '@/types/chat';
import { normalizeTimezone } from '../validation';

/**
 * Converts a local date/time in a specific IANA timezone to a UTC Date object.
 */
export function getUtcDateFromZoned(
  year: number,
  month: number, // 1-12
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
  timeZone = 'UTC'
): Date {
  const normalizedTz = normalizeTimezone(timeZone);
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizedTz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(guess).map((p) => [p.type, p.value])
  );

  const formattedHour = parts.hour === '24' ? 0 : Number(parts.hour);

  const formattedAsZoned = new Date(
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      formattedHour,
      Number(parts.minute),
      Number(parts.second),
      millisecond
    )
  );

  const diff = guess.getTime() - formattedAsZoned.getTime();
  return new Date(guess.getTime() + diff);
}

/**
 * Gets the local year, month, day, weekday for a given Date in a specific timezone.
 */
export function getZonedParts(
  date: Date,
  timeZone = 'UTC'
): { year: number; month: number; day: number; weekday: string } {
  const normalizedTz = normalizeTimezone(timeZone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: normalizedTz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(date).map((p) => [p.type, p.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: parts.weekday,
  };
}

/**
 * Formats a Date in a specific timezone as human-readable (e.g. "Tuesday, 3 November 2026").
 */
export function formatZonedDate(date: Date, timeZone = 'UTC'): string {
  const normalizedTz = normalizeTimezone(timeZone);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: normalizedTz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function parseCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (WORD_NUMBERS[normalized]) return WORD_NUMBERS[normalized];
  const numeric = Number(normalized);
  return Number.isFinite(numeric) && numeric > 0 && numeric <= 120 ? numeric : null;
}

function addLocalCalendarDays(
  year: number,
  month: number,
  day: number,
  delta: number
): { year: number; month: number; day: number } {
  const shifted = new Date(Date.UTC(year, month - 1, day + delta, 12, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function subtractLocalMonths(date: Date, months: number, timeZone: string): Date {
  const parts = getZonedParts(date, timeZone);
  const absoluteMonth = parts.year * 12 + (parts.month - 1) - months;
  const year = Math.floor(absoluteMonth / 12);
  const month = (absoluteMonth % 12 + 12) % 12 + 1;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(parts.day, daysInMonth);
  return getUtcDateFromZoned(year, month, day, 0, 0, 0, 0, timeZone);
}

function subtractLocalYears(date: Date, years: number, timeZone: string): Date {
  const parts = getZonedParts(date, timeZone);
  const targetYear = parts.year - years;
  const daysInMonth = new Date(Date.UTC(targetYear, parts.month, 0)).getUTCDate();
  const day = Math.min(parts.day, daysInMonth);
  return getUtcDateFromZoned(targetYear, parts.month, day, 0, 0, 0, 0, timeZone);
}

function buildIntervalResult(options: {
  startDate: Date;
  endDate: Date;
  rawExpression: string;
  timeZone: string;
  hasDeltaQuery: boolean;
  confidence?: 'exact' | 'approximate';
  displayPrefix?: string;
}): TemporalResolution {
  const { startDate, endDate, rawExpression, timeZone, hasDeltaQuery } = options;
  const display = `${options.displayPrefix || 'Since'} ${formatZonedDate(
    startDate,
    timeZone
  )} to ${formatZonedDate(endDate, timeZone)}`;

  return {
    hasDate: true,
    startDate,
    endDate,
    rawExpression,
    resolvedDisplay: display,
    confidence: options.confidence || 'exact',
    timezone: timeZone,
    isInterval: true,
    hasDeltaQuery,
  };
}

/**
 * Resolves natural language date references in user message.
 */
export function resolveTemporalReference(
  message: string,
  userTimezone = 'UTC',
  referenceDate = new Date()
): TemporalResolution {
  const tz = normalizeTimezone(userTimezone);
  const nowZoned = getZonedParts(referenceDate, tz);

  const hasDeltaQuery = /\b(changed|changes|updated?|updates?|pricing|differs?|shipped|new since|since then|any of them .* since|anything .* since|since)\b/i.test(message);

  // Explicit rolling windows: "in the last two weeks", "last 3 days", "over the past month".
  // These are checked before calendar-relative phrases so "last two weeks" is not treated as a single day.
  const rollingWithCount =
    message.match(
      /\b(?:(?:in|over|during)\s+the\s+)?(?:last|past)\s+([a-z0-9]+)\s+(day|week|month|year)s?\b/i
    ) || null;
  if (rollingWithCount) {
    const count = parseCount(rollingWithCount[1]);
    const unit = rollingWithCount[2].toLowerCase();
    if (count) {
      let startDate: Date;
      if (unit === 'day') {
        startDate = new Date(referenceDate.getTime() - count * 86400000);
      } else if (unit === 'week') {
        startDate = new Date(referenceDate.getTime() - count * 7 * 86400000);
      } else if (unit === 'month') {
        startDate = subtractLocalMonths(referenceDate, count, tz);
      } else {
        startDate = subtractLocalYears(referenceDate, count, tz);
      }
      return buildIntervalResult({
        startDate,
        endDate: referenceDate,
        rawExpression: rollingWithCount[0],
        timeZone: tz,
        hasDeltaQuery,
      });
    }
  }

  // Rolling windows without a count: "in the past month", "over the last week".
  const rollingWithoutCount = message.match(
    /\b(?:(?:in|over|during)\s+the\s+)(?:last|past)\s+(day|week|month|year)\b/i
  ) || null;
  if (rollingWithoutCount) {
    const unit = rollingWithoutCount[1].toLowerCase();
    const startDate =
      unit === 'day'
        ? new Date(referenceDate.getTime() - 86400000)
        : unit === 'week'
        ? new Date(referenceDate.getTime() - 7 * 86400000)
        : unit === 'month'
        ? subtractLocalMonths(referenceDate, 1, tz)
        : subtractLocalYears(referenceDate, 1, tz);
    return buildIntervalResult({
      startDate,
      endDate: referenceDate,
      rawExpression: rollingWithoutCount[0],
      timeZone: tz,
      hasDeltaQuery,
    });
  }

  // Calendar-relative weeks/months/years: "last week" means the previous Monday-Sunday week.
  const calendarRelative = message.match(
    /\b(last|previous|this|current)\s+(week|month|year)\b/i
  );
  if (calendarRelative) {
    const modifier = calendarRelative[1].toLowerCase();
    const unit = calendarRelative[2].toLowerCase();
    const isCurrent = modifier === 'this' || modifier === 'current';

    if (unit === 'week') {
      const dayOfWeek = new Date(Date.UTC(nowZoned.year, nowZoned.month - 1, nowZoned.day)).getUTCDay();
      const mondayOffset = (dayOfWeek + 6) % 7;
      const monday = addLocalCalendarDays(nowZoned.year, nowZoned.month, nowZoned.day, -mondayOffset);
      const startMonday = isCurrent
        ? monday
        : addLocalCalendarDays(monday.year, monday.month, monday.day, -7);
      const startDate = getUtcDateFromZoned(startMonday.year, startMonday.month, startMonday.day, 0, 0, 0, 0, tz);

      if (isCurrent) {
        return buildIntervalResult({
          startDate,
          endDate: referenceDate,
          rawExpression: calendarRelative[0],
          timeZone: tz,
          hasDeltaQuery,
        });
      }

      const sunday = addLocalCalendarDays(startMonday.year, startMonday.month, startMonday.day, 6);
      const endDate = getUtcDateFromZoned(sunday.year, sunday.month, sunday.day, 23, 59, 59, 999, tz);
      return buildIntervalResult({
        startDate,
        endDate,
        rawExpression: calendarRelative[0],
        timeZone: tz,
        hasDeltaQuery,
        displayPrefix: 'From',
      });
    }

    if (unit === 'month') {
      const monthOffset = isCurrent ? 0 : -1;
      const absoluteMonth = nowZoned.year * 12 + (nowZoned.month - 1) + monthOffset;
      const year = Math.floor(absoluteMonth / 12);
      const month = (absoluteMonth % 12 + 12) % 12 + 1;
      const startDate = getUtcDateFromZoned(year, month, 1, 0, 0, 0, 0, tz);
      if (isCurrent) {
        return buildIntervalResult({
          startDate,
          endDate: referenceDate,
          rawExpression: calendarRelative[0],
          timeZone: tz,
          hasDeltaQuery,
        });
      }
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const endDate = getUtcDateFromZoned(year, month, lastDay, 23, 59, 59, 999, tz);
      return buildIntervalResult({
        startDate,
        endDate,
        rawExpression: calendarRelative[0],
        timeZone: tz,
        hasDeltaQuery,
        displayPrefix: 'From',
      });
    }

    const yearOffset = isCurrent ? 0 : -1;
    const targetYear = nowZoned.year + yearOffset;
    const startDate = getUtcDateFromZoned(targetYear, 1, 1, 0, 0, 0, 0, tz);
    if (isCurrent) {
      return buildIntervalResult({
        startDate,
        endDate: referenceDate,
        rawExpression: calendarRelative[0],
        timeZone: tz,
        hasDeltaQuery,
      });
    }
    const endDate = getUtcDateFromZoned(targetYear, 12, 31, 23, 59, 59, 999, tz);
    return buildIntervalResult({
      startDate,
      endDate,
      rawExpression: calendarRelative[0],
      timeZone: tz,
      hasDeltaQuery,
      displayPrefix: 'From',
    });
  }

  // Distinguish between:
  // 1) An explicit point anchor for an event (e.g. "On Monday we discussed X", "Last Tuesday we shortlisted CRM tools")
  // 2) A question asking about live web freshness/delta since that event ("Has anything changed since?", "pricing updates since?")
  // 3) A true historical interval range (e.g. "What did we discuss since Monday?", "All chats from Monday to Wednesday")
  const hasPointAnchorPrefix = /\b(on|at|during|for)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}|last\s+\w+|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(message);
  // A date interval for history retrieval should only be true when the query explicitly asks for a span of conversations,
  // NOT when anchoring an event on a day and asking if anything changed since on the live web.
  let isInterval = false;
  if (!hasPointAnchorPrefix) {
    isInterval = /\b(since\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|yesterday|\d{1,2}|last\s+\w+|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|from\s+.+\s+to\b|between\s+.+\s+and\b|in the (?:last|past)\s+\d+|over the (?:last|past))\b/i.test(message);
  }

  // Custom regex checks for common patterns like "3 November" or "November 3"
  const dayMonthRegex = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{4}))?\b/i;
  const monthDayRegex = /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{4}))?\b/i;

  const monthNames: Record<string, number> = {
    jan: 1, january: 1,
    feb: 2, february: 2,
    mar: 3, march: 3,
    apr: 4, april: 4,
    may: 5,
    jun: 6, june: 6,
    jul: 7, july: 7,
    aug: 8, august: 8,
    sep: 9, september: 9,
    oct: 10, october: 10,
    nov: 11, november: 11,
    dec: 12, december: 12,
  };

  const dmMatch = message.match(dayMonthRegex);
  const mdMatch = message.match(monthDayRegex);

  let targetYear: number | null = null;
  let targetMonth: number | null = null;
  let targetDay: number | null = null;
  let rawExpr: string | null = null;

  if (dmMatch) {
    targetDay = Number(dmMatch[1]);
    const mStr = dmMatch[2].toLowerCase();
    targetMonth = monthNames[mStr] || 1;
    targetYear = dmMatch[3] ? Number(dmMatch[3]) : nowZoned.year;
    rawExpr = dmMatch[0];

    // If month/day is in the future in current year and no year specified, assume previous year
    if (!dmMatch[3]) {
      const candidate = getUtcDateFromZoned(targetYear, targetMonth, targetDay, 12, 0, 0, 0, tz);
      if (candidate.getTime() > referenceDate.getTime()) {
        targetYear -= 1;
      }
    }
  } else if (mdMatch) {
    const mStr = mdMatch[1].toLowerCase();
    targetMonth = monthNames[mStr] || 1;
    targetDay = Number(mdMatch[2]);
    targetYear = mdMatch[3] ? Number(mdMatch[3]) : nowZoned.year;
    rawExpr = mdMatch[0];

    if (!mdMatch[3]) {
      const candidate = getUtcDateFromZoned(targetYear, targetMonth, targetDay, 12, 0, 0, 0, tz);
      if (candidate.getTime() > referenceDate.getTime()) {
        targetYear -= 1;
      }
    }
  }

  if (targetYear && targetMonth && targetDay) {
    const startUtc = getUtcDateFromZoned(targetYear, targetMonth, targetDay, 0, 0, 0, 0, tz);
    const endUtc = isInterval
      ? referenceDate
      : getUtcDateFromZoned(targetYear, targetMonth, targetDay, 23, 59, 59, 999, tz);

    const display = isInterval
      ? `Since ${formatZonedDate(startUtc, tz)} to present`
      : formatZonedDate(startUtc, tz);

    return {
      hasDate: true,
      startDate: startUtc,
      endDate: endUtc,
      rawExpression: rawExpr,
      resolvedDisplay: display,
      confidence: 'exact',
      timezone: tz,
      isInterval,
      hasDeltaQuery,
    };
  }

  // Next, use chrono-node
  const parsed = chrono.parse(message, referenceDate, { forwardDate: false });
  if (parsed.length > 0) {
    const res = parsed[0];
    const parsedDate = res.start.date();

    // Map into user's timezone day
    const parts = getZonedParts(parsedDate, tz);
    rawExpr = res.text;

    // If chrono parsed a date in the future relative to referenceDate in a history retrieval context,
    // step back by 7 days so it resolves to the past occurrence (e.g. past Monday, not upcoming Monday)
    if (parsedDate.getTime() > referenceDate.getTime()) {
      parsedDate.setTime(parsedDate.getTime() - 7 * 86400000);
    }

    // Check if weekday resolution needs "last [weekday]" logic
    const lastWeekdayMatch = message.match(/last\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
    if (lastWeekdayMatch) {
      // If chrono didn't go back at least 1 week when user said "last [weekday]" and today is that weekday,
      // ensure it refers to 7 days before
      const targetWeekday = lastWeekdayMatch[1].toLowerCase();
      if (nowZoned.weekday.toLowerCase() === targetWeekday && Math.abs(referenceDate.getTime() - parsedDate.getTime()) < 3 * 86400000) {
        // Adjust back 7 days
        parsedDate.setTime(parsedDate.getTime() - 7 * 86400000);
      }
    }

    const finalParts = getZonedParts(parsedDate, tz);
    const startUtc = getUtcDateFromZoned(finalParts.year, finalParts.month, finalParts.day, 0, 0, 0, 0, tz);
    const endUtc = isInterval
      ? referenceDate
      : getUtcDateFromZoned(finalParts.year, finalParts.month, finalParts.day, 23, 59, 59, 999, tz);

    const display = isInterval
      ? `Since ${formatZonedDate(startUtc, tz)} to present`
      : formatZonedDate(startUtc, tz);

    return {
      hasDate: true,
      startDate: startUtc,
      endDate: endUtc,
      rawExpression: rawExpr,
      resolvedDisplay: display,
      confidence: 'exact',
      timezone: tz,
      isInterval,
      hasDeltaQuery,
    };
  }

  // "Earlier" / "previously" without an explicit date gets a bounded recent-history window.
  // This keeps cross-conversation recall honest while giving the model useful evidence.
  const vagueRecent = message.match(/\b(earlier|previously|recently)\b/i);
  if (vagueRecent) {
    return buildIntervalResult({
      startDate: new Date(referenceDate.getTime() - 7 * 86400000),
      endDate: referenceDate,
      rawExpression: vagueRecent[0],
      timeZone: tz,
      hasDeltaQuery,
      confidence: 'approximate',
      displayPrefix: 'Since (approximate)',
    });
  }

  return {
    hasDate: false,
    startDate: null,
    endDate: null,
    rawExpression: null,
    resolvedDisplay: null,
    confidence: 'none',
    timezone: tz,
    isInterval: false,
    hasDeltaQuery,
  };
}
