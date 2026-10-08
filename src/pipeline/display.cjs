'use strict';

/**
 * @fileoverview Stringifies a resolved value for embedding into an
 * interpolated string (CASC.md §7) -- the port of `Cooper.Display`. Each
 * value type renders the way the Elixir implementation renders it where
 * that is meaningful, so an interpolated string reads the same in both.
 */

const CooperError = require('../error.cjs');
const Tuple = require('../values/tuple.cjs');
const LocalDateTime = require('../values/local-date-time.cjs');
const DateTime = require('../values/date-time.cjs');
const { isPlainObject } = require('../values/equality.cjs');
const { CooperFloat, formatFloat } = require('../values/float.cjs');

/**
 * A JS `Date` only reaches here from a consumer's resolver or tag (an
 * offset datetime literal is a `DateTime`); it reads like a `DateTime` of
 * the same instant.
 * @param {Date} date
 * @returns {string} Elixir's `to_string/1` of a UTC `DateTime`: `YYYY-MM-DD HH:MM:SS[.mmm]Z`
 */
function displayInstant(date) {
  return DateTime.fromDate(date).toString().replace('T', ' ');
}

/**
 * A value reads as CASC writes it (CASC.md §7): `nil`, `inf`/`-inf`, a
 * float with its fraction. `nil` once rendered as `""` and a float as JS's
 * `String(number)`, which can't tell `1.0` from `1` (`"1"`) and spells
 * `1.0e20` out in full.
 * @param {unknown} value -- already resolved, never a `Secret`
 * @returns {string}
 * @throws {CooperError} for a list, tuple, or map: there is no sensible
 *   string for one, and CASC fails loudly rather than guessing
 */
function display(value) {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'nil';
  if (value instanceof CooperFloat) return value.toString();
  if (typeof value === 'number') {
    if (value === Infinity) return 'inf';
    if (value === -Infinity) return '-inf';
    // An integral plain `number` is an integer; a fractional one can only
    // be a float (a consumer's tag or resolver returned it). NaN has no
    // CASC spelling and only a consumer can produce one.
    return Number.isInteger(value) || Number.isNaN(value) ? String(value) : formatFloat(value);
  }
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (typeof value === 'symbol') return value.description ?? '';
  // Elixir's `to_string/1` of a `DateTime`: its ISO text with a space for
  // the `T`, the fraction to the digits it was written with.
  if (value instanceof DateTime) return value.toString().replace('T', ' ');
  if (value instanceof Date) return displayInstant(value);
  if (value instanceof LocalDateTime) return value.toString().replace('T', ' ');
  if (Array.isArray(value) || value instanceof Tuple || isPlainObject(value)) {
    const what = Array.isArray(value) ? 'a list' : value instanceof Tuple ? 'a tuple' : 'a map';
    throw new CooperError(`cannot interpolate ${what} into a string`, { stage: 'resolve' });
  }
  return String(value);
}

module.exports = { display };
