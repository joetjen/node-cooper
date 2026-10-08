'use strict';

/**
 * @fileoverview Shared validation/formatting helpers for `LocalDate`,
 * `LocalTime`, and `LocalDateTime` -- not part of the public API.
 */

/**
 * @param {number} year
 * @returns {boolean}
 */
function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * @param {number} year
 * @param {number} month
 * @returns {number}
 */
function daysInMonth(year, month) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

/**
 * @param {number} n
 * @param {number} width
 * @returns {string}
 */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * @param {number} year
 * @param {number} month
 * @param {number} day
 */
function validateDate(year, month, day) {
  if (!Number.isInteger(year) || year < 0 || year > 9999) throw new RangeError(`invalid year: ${year}`);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError(`invalid month: ${month}`);
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`invalid day: ${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)} does not exist`);
  }
}

/**
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {number} microsecond
 * @param {number} precision
 */
function validateTime(hour, minute, second, microsecond, precision) {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new RangeError(`invalid hour: ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new RangeError(`invalid minute: ${minute}`);
  if (!Number.isInteger(second) || second < 0 || second > 59) throw new RangeError(`invalid second: ${second}`);
  if (!Number.isInteger(microsecond) || microsecond < 0 || microsecond > 999999) {
    throw new RangeError(`invalid microsecond: ${microsecond}`);
  }
  if (!Number.isInteger(precision) || precision < 0 || precision > 6) throw new RangeError(`invalid precision: ${precision}`);
}

/**
 * `HH:MM:SS[.ffffff]`, the fraction shown to `precision` digits --
 * Elixir's `Time.to_iso8601/1` shape.
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {number} microsecond
 * @param {number} precision
 * @returns {string}
 */
function formatTime(hour, minute, second, microsecond, precision) {
  const base = `${pad(hour, 2)}:${pad(minute, 2)}:${pad(second, 2)}`;
  return precision > 0 ? `${base}.${pad(microsecond, 6).slice(0, precision)}` : base;
}

/**
 * Splits an ISO fractional-seconds digit run into microseconds plus the
 * precision it was written with, truncating past six digits.
 * @param {string | undefined} digits
 * @returns {{microsecond: number, precision: number}}
 */
function parseFraction(digits) {
  if (!digits) return { microsecond: 0, precision: 0 };
  const kept = digits.slice(0, 6);
  return { microsecond: Number(kept.padEnd(6, '0')), precision: kept.length };
}

module.exports = { isLeapYear, daysInMonth, pad, validateDate, validateTime, formatTime, parseFraction };
