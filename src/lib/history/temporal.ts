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
  const isInterval = /\b(since|from|between|after|in the last|past)\b/i.test(message);

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
    };
  }

  return {
    hasDate: false,
    startDate: null,
    endDate: null,
    rawExpression: null,
    resolvedDisplay: null,
    confidence: 'none',
    timezone: tz,
  };
}
