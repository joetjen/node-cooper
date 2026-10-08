'use strict';

const { pad, daysInMonth, validateTime, formatTime, parseFraction } = require('./temporal-util.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * An offset datetime -- CASC.md §6.6's `1979-05-27T07:32:00Z` or
 * `1979-05-27T07:32:00.120+05:30`: a real instant. Mirrors Elixir's
 * `DateTime` as the reference loads one (`DateTime.from_iso8601/1`):
 * normalized to UTC, at microsecond resolution, remembering how many
 * fractional digits were written (`precision`), so `.120` stays `.120`
 * and `.0` stays `.0`. Digits past the sixth are truncated, as the
 * reference truncates them.
 *
 * It once loaded as a native `Date`, which holds milliseconds only: `.123456`
 * lost its microseconds, and `.120`, `.12` and `.1200` all read back as the
 * same `.120`. `toDate()` still gives that `Date` to a caller who wants one.
 *
 * The fields are the UTC calendar fields. Applying an offset can carry
 * the instant out of the four-digit years a literal can be written with
 * (`0000-01-01T00:00:00+00:01` is in year -1), so `year` is any integer
 * here, unlike `LocalDateTime`'s.
 */
class DateTime {
  /**
   * @param {number} year -- UTC
   * @param {number} month -- UTC, 1-based
   * @param {number} day -- UTC
   * @param {number} hour -- UTC
   * @param {number} minute -- UTC
   * @param {number} second
   * @param {number} [microsecond]
   * @param {number} [precision] -- fractional digits to display, 0..6
   */
  constructor(year, month, day, hour, minute, second, microsecond = 0, precision = microsecond === 0 ? 0 : 6) {
    if (!Number.isSafeInteger(year)) throw new RangeError(`invalid year: ${year}`);
    if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`invalid month: ${month}`);
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
      throw new RangeError(`invalid day: ${formatYear(year)}-${pad(month, 2)}-${pad(day, 2)} does not exist`);
    }
    validateTime(hour, minute, second, microsecond, precision);
    /** @type {number} UTC */
    this.year = year;
    /** @type {number} UTC, 1-based */
    this.month = month;
    /** @type {number} UTC */
    this.day = day;
    /** @type {number} UTC */
    this.hour = hour;
    /** @type {number} UTC */
    this.minute = minute;
    /** @type {number} */
    this.second = second;
    /** @type {number} */
    this.microsecond = microsecond;
    /** @type {number} */
    this.precision = precision;
    Object.freeze(this);
  }

  /**
   * Parses an RFC 3339 datetime with a `Z` or `±HH:MM` offset and
   * normalizes it to UTC.
   * @param {string} text -- `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)`
   * @returns {DateTime}
   * @throws {SyntaxError} for any other shape, a missing offset included
   * @throws {RangeError} for an impossible date, time, or offset
   */
  static parse(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text);
    if (!m) throw new SyntaxError(`cannot parse ${JSON.stringify(text)} as an offset datetime`);
    const { microsecond, precision } = parseFraction(m[7]);
    // Validate the wall-clock fields as written, before the offset moves
    // them: `2023-02-29T23:00:00-01:00` is no more real than without it.
    const local = new DateTime(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), microsecond, precision);
    const offset = offsetMinutes(m[8]);
    if (offset === 0) return local;
    // An offset is whole minutes, so shifting by it is millisecond
    // arithmetic on a `Date` and leaves the microsecond alone.
    const shifted = new Date(local.toDate().getTime() - offset * 60_000);
    return new DateTime(
      shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(),
      shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds(),
      microsecond, precision
    );
  }

  /**
   * The same instant, with the millisecond as its fraction (three
   * digits), or none when the millisecond is zero.
   * @param {Date} date
   * @returns {DateTime}
   */
  static fromDate(date) {
    const ms = date.getUTCMilliseconds();
    return new DateTime(
      date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
      date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
      ms * 1000, ms === 0 ? 0 : 3
    );
  }

  /** @returns {Date} this instant, truncated to the millisecond a `Date` holds */
  toDate() {
    // `setUTCFullYear`, not `Date.UTC`: that reads a year 0..99 as 1900..1999.
    const date = new Date(0);
    date.setUTCFullYear(this.year, this.month - 1, this.day);
    date.setUTCHours(this.hour, this.minute, this.second, Math.floor(this.microsecond / 1000));
    return date;
  }

  /**
   * The reference's equality, which `-key = [...]` removes by: the same
   * instant written to the same precision. `07:32:00Z` and
   * `08:32:00+01:00` are equal; `07:32:00Z` and `07:32:00.0Z` are not.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return (
      other instanceof DateTime &&
      other.year === this.year &&
      other.month === this.month &&
      other.day === this.day &&
      other.hour === this.hour &&
      other.minute === this.minute &&
      other.second === this.second &&
      other.microsecond === this.microsecond &&
      other.precision === this.precision
    );
  }

  /** @returns {string} `YYYY-MM-DDTHH:MM:SS[.fraction]Z`, Elixir's `DateTime.to_iso8601/1` of a UTC datetime */
  toString() {
    const date = `${formatYear(this.year)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
    return `${date}T${formatTime(this.hour, this.minute, this.second, this.microsecond, this.precision)}Z`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `DateTime(${this.toString()})`;
  }
}

/**
 * A year as Elixir's ISO calendar writes it: at least four digits, and a
 * minus sign before the padding (`-0001`, `10000`).
 * @param {number} year
 * @returns {string}
 */
function formatYear(year) {
  return year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
}

/**
 * @param {string} offset -- `Z` or `±HH:MM`
 * @returns {number} minutes east of UTC
 * @throws {RangeError} for an hour past 23, a minute past 59, or `-00:00`,
 *   which RFC 3339 reserves for "offset unknown" and the reference refuses
 */
function offsetMinutes(offset) {
  if (offset === 'Z') return 0;
  if (offset === '-00:00') throw new RangeError('invalid offset -00:00: RFC 3339 reserves it for an unknown offset');
  const [hh, mm] = offset.slice(1).split(':').map(Number);
  if (hh > 23 || mm > 59) throw new RangeError(`invalid offset ${offset}`);
  return (offset.startsWith('-') ? -1 : 1) * (hh * 60 + mm);
}

module.exports = DateTime;
