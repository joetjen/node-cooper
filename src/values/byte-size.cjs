'use strict';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A CASC byte size (CASC.md §6.9) -- `512MiB`, `10GB`, `!bytes("1.5GiB")`.
 * Mirrors the Elixir implementation's `{:bytes, count}`, with the count
 * held as a `bigint` so that every literal the spec allows (up to `PiB`/
 * `PB`, with any numeral) is represented exactly.
 *
 * The closest native JS fit is a plain number: `toNumber()` (exact up to
 * `Number.MAX_SAFE_INTEGER`, about 8 PiB) and `ByteSize.fromNumber()`.
 */
class ByteSize {
  /** @param {bigint} bytes */
  constructor(bytes) {
    if (typeof bytes !== 'bigint') throw new TypeError('ByteSize expects a bigint number of bytes');
    /** @type {bigint} */
    this.bytes = bytes;
    Object.freeze(this);
  }

  /**
   * Parses byte-size literal text (`"512MiB"`), with the same rules and
   * errors as a bare literal in a CASC file.
   * @param {string} text
   * @returns {ByteSize}
   */
  static parse(text) {
    const { parseBytes } = require('../grammar/literals.cjs');
    const result = parseBytes(text);
    if (typeof result === 'string') throw new SyntaxError(result);
    return new ByteSize(result);
  }

  /**
   * @param {number} bytes -- must be a non-negative safe integer
   * @returns {ByteSize}
   */
  static fromNumber(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`not a byte count: ${bytes}`);
    return new ByteSize(BigInt(bytes));
  }

  /** @returns {number} the byte count as a plain number */
  toNumber() {
    return Number(this.bytes);
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof ByteSize && other.bytes === this.bytes;
  }

  /** @returns {string} the base-unit form, e.g. `"536870912B"` -- valid CASC if fed back in */
  toString() {
    return `${this.bytes}B`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `ByteSize(${this.toString()})`;
  }
}

module.exports = ByteSize;
