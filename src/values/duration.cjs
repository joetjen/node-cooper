'use strict';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A CASC duration (CASC.md §6.8) -- `500ms`, `1h30m`, `!duration("5m")`.
 * Mirrors the Elixir implementation's `{:duration, nanoseconds}`:
 * nanoseconds are the base unit, held as a `bigint` so that every literal
 * the spec allows is represented exactly (a few hundred days already
 * exceeds `Number.MAX_SAFE_INTEGER` nanoseconds).
 *
 * JS has no native duration type (`Temporal` isn't broadly available), so
 * the conversion helpers target plain numbers: `toMilliseconds()` (what
 * `setTimeout` and most Node APIs take), `toSeconds()`, and the matching
 * `Duration.fromMilliseconds()`/`fromSeconds()` constructors.
 */
class Duration {
  /** @param {bigint} nanoseconds */
  constructor(nanoseconds) {
    if (typeof nanoseconds !== 'bigint') throw new TypeError('Duration expects a bigint number of nanoseconds');
    /** @type {bigint} */
    this.nanoseconds = nanoseconds;
    Object.freeze(this);
  }

  /**
   * Parses duration literal text (`"1h30m"`, `"1.5s"`), with the same rules
   * and errors as a bare literal in a CASC file.
   * @param {string} text
   * @returns {Duration}
   */
  static parse(text) {
    const { parseDuration } = require('../grammar/literals.cjs');
    const result = parseDuration(text);
    if (typeof result === 'string') throw new SyntaxError(result);
    return new Duration(result);
  }

  /**
   * @param {number} ms
   * @returns {Duration}
   */
  static fromMilliseconds(ms) {
    return new Duration(BigInt(Math.round(ms * 1e6)));
  }

  /**
   * @param {number} s
   * @returns {Duration}
   */
  static fromSeconds(s) {
    return new Duration(BigInt(Math.round(s * 1e9)));
  }

  /** @returns {number} milliseconds, possibly fractional */
  toMilliseconds() {
    return Number(this.nanoseconds) / 1e6;
  }

  /** @returns {number} seconds, possibly fractional */
  toSeconds() {
    return Number(this.nanoseconds) / 1e9;
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof Duration && other.nanoseconds === this.nanoseconds;
  }

  /** @returns {string} the base-unit form, e.g. `"500000000ns"` -- valid CASC if fed back in */
  toString() {
    return `${this.nanoseconds}ns`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `Duration(${this.toString()})`;
  }
}

module.exports = Duration;
