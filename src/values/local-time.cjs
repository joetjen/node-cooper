'use strict';

const { validateTime, formatTime, parseFraction } = require('./temporal-util.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A wall-clock time with no date or zone -- CASC.md §6.6's local time
 * (`07:32:00`, `07:32:00.5`). Mirrors Elixir's `Time`: microsecond
 * resolution, remembering how many fractional digits were written
 * (`precision`) so `toString()` round-trips the literal.
 *
 * No conversion helpers: a time without a date has no close native JS
 * counterpart (`Date` is always a full instant).
 */
class LocalTime {
  /**
   * @param {number} hour
   * @param {number} minute
   * @param {number} second
   * @param {number} [microsecond]
   * @param {number} [precision] -- fractional digits to display, 0..6
   */
  constructor(hour, minute, second, microsecond = 0, precision = microsecond === 0 ? 0 : 6) {
    validateTime(hour, minute, second, microsecond, precision);
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
   * @param {string} text -- `HH:MM:SS[.fraction]`
   * @returns {LocalTime}
   */
  static parse(text) {
    const m = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(text);
    if (!m) throw new SyntaxError(`cannot parse ${JSON.stringify(text)} as a time`);
    const { microsecond, precision } = parseFraction(m[4]);
    return new LocalTime(Number(m[1]), Number(m[2]), Number(m[3]), microsecond, precision);
  }

  /**
   * The reference's equality, which `-key = [...]` removes by: the same
   * time written to the same precision (`07:32:00.5` is not
   * `07:32:00.500`, as an Elixir `Time` with a different `microsecond`
   * precision is not). It once ignored the precision, and `-key` removed
   * entries the reference keeps.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return (
      other instanceof LocalTime &&
      other.hour === this.hour &&
      other.minute === this.minute &&
      other.second === this.second &&
      other.microsecond === this.microsecond &&
      other.precision === this.precision
    );
  }

  /** @returns {string} `HH:MM:SS[.fraction]` */
  toString() {
    return formatTime(this.hour, this.minute, this.second, this.microsecond, this.precision);
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `LocalTime(${this.toString()})`;
  }
}

module.exports = LocalTime;
