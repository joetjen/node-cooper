'use strict';

const { formatFloat } = require('./float-format.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A CASC float (CASC.md §6.3), as a consumer's own tag receives one.
 *
 * CASC tells `2.0` from `2`, and so does the reference: its tags are
 * handed an Elixir float, which `is_integer/1` refuses. A JS `number`
 * cannot carry that difference, so inside a load every float is a
 * `CooperFloat` -- which is what lets `"@{f}"` read `1.0`, `-key = [1.0]`
 * leave `1` alone, and `!int(2.0)` fail. A tag registered with `tags:` is
 * handed the argument exactly as the pipeline holds it, so a float
 * reaches it wrapped, nested ones included (in a list, a tuple, a map, or
 * a secret); an integer is a plain `number` (or a `bigint`). A tag may
 * return a `CooperFloat` too, and the value stays a float for the rest of
 * the load. Once a tag handed its argument plain numbers, and could not
 * tell `!twice(2.0)` from `!twice(2)`.
 *
 * The loaded tree never holds one: every float in the result is a plain
 * `number`, the host's single number type.
 *
 * `value`, `toNumber()` and `valueOf()` give the number, so arithmetic
 * (`f * 2`) works on it as it is; `toString()` writes it as CASC does,
 * always with a fraction (`2.0`, `1.0e3`, `inf`). Infinity is never
 * wrapped by the pipeline -- `inf` has no integer twin to be told apart
 * from -- but a consumer may wrap it.
 */
class CooperFloat {
  /** @param {number} value */
  constructor(value) {
    if (typeof value !== 'number') throw new TypeError(`a CooperFloat holds a number, not ${typeof value}`);
    /** @type {number} */
    this.value = value;
    Object.freeze(this);
  }

  /**
   * @param {number} value
   * @returns {CooperFloat}
   */
  static fromNumber(value) {
    return new CooperFloat(value);
  }

  /** @returns {number} */
  toNumber() {
    return this.value;
  }

  /** @returns {number} so `f * 2` and `f < 3` work on the number */
  valueOf() {
    return this.value;
  }

  /**
   * Strict float equality, which `-key` removes by: never equal to an
   * integer, and `0.0` is not `-0.0` (Erlang's `=:=` tells them apart, so
   * the reference's `-key` does too).
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof CooperFloat && Object.is(this.value, other.value);
  }

  /** @returns {string} the float as CASC writes it (CASC.md §7): `2.0`, `1.0e3`, `inf` */
  toString() {
    if (this.value === Infinity) return 'inf';
    if (this.value === -Infinity) return '-inf';
    return Number.isFinite(this.value) ? formatFloat(this.value) : String(this.value);
  }

  /** @returns {number} JSON has one number type too */
  toJSON() {
    return this.value;
  }

  /** @returns {string} */
  [INSPECT]() {
    return `CooperFloat(${this.toString()})`;
  }
}

module.exports = CooperFloat;
