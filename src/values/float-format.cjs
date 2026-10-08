'use strict';

/**
 * @fileoverview How CASC writes a float -- not part of the public API.
 * Shared by `CooperFloat#toString` and the pipeline's display, which
 * also formats a fractional plain `number` a consumer returned.
 */

/**
 * Formats a float the way Elixir's `Float.to_string/1` does, which is how
 * CASC writes one (CASC.md §7): the shortest digits that read back as the
 * same float, as a plain decimal or with an exponent, whichever is shorter
 * (the decimal on a tie), always with a fraction -- `1.0`, `100.0`,
 * `1.0e3`, `0.0001`, `1.0e-5`.
 * @param {number} n -- finite
 * @returns {string}
 */
function formatFloat(n) {
  const sign = n < 0 || Object.is(n, -0) ? '-' : '';
  // `toExponential()` with no argument gives the shortest round-trip
  // digits, the same digits Erlang's `short` float formatting picks.
  const [mantissa, exp] = Math.abs(n).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const exponent = Number(exp);

  const scientific = `${digits[0]}.${digits.slice(1) || '0'}e${exponent}`;
  let decimal;
  if (exponent < 0) {
    decimal = `0.${'0'.repeat(-exponent - 1)}${digits}`;
  } else {
    const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
    decimal = `${whole}.${digits.slice(exponent + 1) || '0'}`;
  }
  return sign + (scientific.length < decimal.length ? scientific : decimal);
}

module.exports = { formatFloat };
