'use strict';

const Tuple = require('./tuple.cjs');
const Secret = require('./secret.cjs');

/**
 * Whether `value` is a plain key/value map -- a CASC block -- as opposed
 * to an array, `null`, or an instance of one of the value classes.
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Structural equality over loaded values -- what `-key = [...]` (CASC.md
 * §8.4) removes list elements by. Mirrors Elixir's exact term equality:
 * `1` and `"1"` differ, as do an atom (`Symbol.for('a')`) and a string.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function valueEquals(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => valueEquals(x, b[i]));
  }
  if (a instanceof Tuple || b instanceof Tuple) {
    return a instanceof Tuple && b instanceof Tuple && valueEquals(a.items, b.items);
  }
  if (a instanceof Secret || b instanceof Secret) {
    return a instanceof Secret && b instanceof Secret && valueEquals(a.value, b.value);
  }
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && valueEquals(a[k], b[k]));
  }
  const eq = /** @type {{equals?: (o: unknown) => boolean}} */ (a).equals;
  return typeof eq === 'function' ? eq.call(a, b) : false;
}

module.exports = { isPlainObject, valueEquals };
