'use strict';

const { pad, validateDate } = require('./temporal-util.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A calendar date with no time or zone -- CASC.md §6.6's local date
 * (`1979-05-27`). Mirrors Elixir's `Date`.
 *
 * The closest native fit is a `Date` at local midnight: `toDate()` /
 * `LocalDate.fromDate()` (both read and write *local* calendar fields,
 * the same as `new Date(year, monthIndex, day)` does).
 */
class LocalDate {
  /**
   * @param {number} year
   * @param {number} month -- 1-based
   * @param {number} day
   */
  constructor(year, month, day) {
    validateDate(year, month, day);
    /** @type {number} */
    this.year = year;
    /** @type {number} 1-based */
    this.month = month;
    /** @type {number} */
    this.day = day;
    Object.freeze(this);
  }

  /**
   * @param {string} text -- `YYYY-MM-DD`
   * @returns {LocalDate}
   */
  static parse(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (!m) throw new SyntaxError(`cannot parse ${JSON.stringify(text)} as a date`);
    return new LocalDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  /**
   * @param {Date} date
   * @returns {LocalDate}
   */
  static fromDate(date) {
    return new LocalDate(date.getFullYear(), date.getMonth() + 1, date.getDate());
  }

  /** @returns {Date} local midnight on this date */
  toDate() {
    // `setFullYear`, not the constructor: `new Date(y, ...)` reads years
    // 0-99 as 1900-1999, which would also shift 0000-02-29 to March 1.
    const date = new Date(2000, 0, 1);
    date.setFullYear(this.year, this.month - 1, this.day);
    return date;
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof LocalDate && other.toString() === this.toString();
  }

  /** @returns {string} `YYYY-MM-DD` */
  toString() {
    return `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `LocalDate(${this.toString()})`;
  }
}

module.exports = LocalDate;
