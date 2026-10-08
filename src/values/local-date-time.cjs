'use strict';

const { pad, validateDate, validateTime, formatTime, parseFraction } = require('./temporal-util.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A date and wall-clock time with no zone or offset -- CASC.md §6.6's
 * local datetime (`1979-05-27T07:32:00`). Mirrors Elixir's
 * `NaiveDateTime`, at microsecond resolution.
 *
 * An *offset* datetime (`1979-05-27T07:32:00Z`) is a real instant and
 * loads as a `DateTime` instead -- see the README's value table.
 *
 * The closest native fit is a `Date` read in the process's local time
 * zone: `toDate()` / `LocalDateTime.fromDate()` (both use local calendar
 * fields, the same as `new Date(y, m, d, h, mi, s)` does). Sub-millisecond
 * digits don't survive the trip, since `Date` has none.
 */
class LocalDateTime {
  /**
   * @param {number} year
   * @param {number} month -- 1-based
   * @param {number} day
   * @param {number} hour
   * @param {number} minute
   * @param {number} second
   * @param {number} [microsecond]
   * @param {number} [precision] -- fractional digits to display, 0..6
   */
  constructor(year, month, day, hour, minute, second, microsecond = 0, precision = microsecond === 0 ? 0 : 6) {
    validateDate(year, month, day);
    validateTime(hour, minute, second, microsecond, precision);
    /** @type {number} */
    this.year = year;
    /** @type {number} 1-based */
    this.month = month;
    /** @type {number} */
    this.day = day;
    /** @type {number} */
    this.hour = hour;
    /** @type {number} */
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
   * @param {string} text -- `YYYY-MM-DDTHH:MM:SS[.fraction]`
   * @returns {LocalDateTime}
   */
  static parse(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);
    if (!m) throw new SyntaxError(`cannot parse ${JSON.stringify(text)} as a local datetime`);
    const { microsecond, precision } = parseFraction(m[7]);
    return new LocalDateTime(
      Number(m[1]), Number(m[2]), Number(m[3]),
      Number(m[4]), Number(m[5]), Number(m[6]),
      microsecond, precision
    );
  }

  /**
   * @param {Date} date
   * @returns {LocalDateTime}
   */
  static fromDate(date) {
    const ms = date.getMilliseconds();
    return new LocalDateTime(
      date.getFullYear(), date.getMonth() + 1, date.getDate(),
      date.getHours(), date.getMinutes(), date.getSeconds(),
      ms * 1000, ms === 0 ? 0 : 3
    );
  }

  /** @returns {Date} this wall-clock time, read in the local time zone */
  toDate() {
    // `setFullYear`, not the constructor: see `LocalDate#toDate`.
    const date = new Date(2000, 0, 1);
    date.setFullYear(this.year, this.month - 1, this.day);
    date.setHours(this.hour, this.minute, this.second, Math.floor(this.microsecond / 1000));
    return date;
  }

  /**
   * The reference's equality, which `-key = [...]` removes by: the same
   * datetime written to the same precision (`07:32:00.5` is not
   * `07:32:00.500`, as an Elixir `NaiveDateTime` with a different `microsecond`
   * precision is not). It once ignored the precision, and `-key` removed
   * entries the reference keeps.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return (
      other instanceof LocalDateTime &&
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

  /** @returns {string} `YYYY-MM-DDTHH:MM:SS[.fraction]` */
  toString() {
    const date = `${pad(this.year, 4)}-${pad(this.month, 2)}-${pad(this.day, 2)}`;
    return `${date}T${formatTime(this.hour, this.minute, this.second, this.microsecond, this.precision)}`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `LocalDateTime(${this.toString()})`;
  }
}

module.exports = LocalDateTime;
