'use strict';

const INSPECT = Symbol.for('nodejs.util.inspect.custom');

/**
 * A CASC tuple (CASC.md §6.11) -- `(52.52, 13.405)`. Fixed-arity, frozen,
 * and deliberately *not* an `Array`: the spec requires an implementation
 * to carry a real tuple type through parsing, merging, and the final
 * result, since a tuple is never merged element-wise or appended to, only
 * replaced wholesale (§8.3). Mirrors the Elixir implementation returning a
 * real Elixir tuple.
 *
 * JS has no native tuple, so the two-way conversion helpers target the
 * closest fit, a plain array: `toArray()` / `Tuple.fromArray()`.
 * `JSON.stringify` renders a tuple as an array.
 */
class Tuple {
  /** @param {Iterable<unknown>} items */
  constructor(items) {
    /** @type {ReadonlyArray<unknown>} */
    this.items = Object.freeze([...items]);
    Object.freeze(this);
  }

  /**
   * @param {...unknown} items
   * @returns {Tuple}
   */
  static of(...items) {
    return new Tuple(items);
  }

  /**
   * @param {ReadonlyArray<unknown>} array
   * @returns {Tuple}
   */
  static fromArray(array) {
    return new Tuple(array);
  }

  /** @returns {number} the tuple's arity */
  get length() {
    return this.items.length;
  }

  /**
   * @param {number} index -- negative counts from the end, like `Array#at`
   * @returns {unknown}
   */
  at(index) {
    return this.items.at(index);
  }

  /** @returns {unknown[]} a fresh, mutable copy of the elements */
  toArray() {
    return [...this.items];
  }

  /** @returns {Iterator<unknown>} */
  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }

  /** @returns {unknown[]} */
  toJSON() {
    return this.toArray();
  }

  /**
   * @param {number} _depth
   * @param {object} options
   * @param {(value: unknown, options: object) => string} inspect
   * @returns {string}
   */
  [INSPECT](_depth, options, inspect) {
    return `Tuple(${this.items.length}) ${inspect([...this.items], options)}`;
  }
}

module.exports = Tuple;
