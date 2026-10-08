'use strict';

/**
 * @fileoverview Literal-text parsing shared by the lexer/evaluator (bare
 * literals like `500ms`, `0xFF`, `1979-05-27`) and the resolver (the
 * equivalent `!duration("5m")`/`!bytes("512MiB")` tagged values, CASC.md
 * §7.5) -- same rules, same errors, one implementation. Mirrors
 * `Cooper.Literals` plus the number/date handling from `Cooper.Actions`.
 *
 * Every function here reports a malformed literal by *returning* its
 * message (a `string`) rather than throwing, so each caller can wrap it in
 * a `CooperError` of its own stage.
 */

const LocalDate = require('../values/local-date.cjs');
const LocalTime = require('../values/local-time.cjs');
const LocalDateTime = require('../values/local-date-time.cjs');
const DateTime = require('../values/date-time.cjs');
const { CooperFloat } = require('../values/float.cjs');

/**
 * The integer representation every loaded integer uses: a plain `number`
 * whenever it is exactly representable (`Number.isSafeInteger`), a
 * `bigint` only beyond that. Elixir integers are arbitrary-precision, so
 * this keeps every CASC integer exact without making the overwhelmingly
 * common case (`port = 8080`) awkward to use.
 * @param {bigint} value
 * @returns {number | bigint}
 */
function normalizeInteger(value) {
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

/**
 * `INTEGER` token text: optional sign, then decimal or `0x`/`0o`/`0b`
 * digits, `_` separators allowed (CASC.md §6.3).
 * @param {string} text
 * @returns {number | bigint}
 */
function parseInteger(text) {
  let sign = 1n;
  let rest = text;
  if (rest.startsWith('+')) rest = rest.slice(1);
  else if (rest.startsWith('-')) {
    sign = -1n;
    rest = rest.slice(1);
  }
  return normalizeInteger(sign * BigInt(rest.replace(/_/g, '')));
}

/**
 * `FLOAT` token text, `_` separators allowed (CASC.md §6.3). Wrapped, so
 * `1.0` stays a float through the pipeline (see `values/float.cjs`).
 * @param {string} text
 * @returns {CooperFloat}
 */
function parseFloatLiteral(text) {
  return new CooperFloat(Number(text.replace(/_/g, '')));
}

/** @type {Record<string, bigint>} */
const DURATION_UNIT_NS = {
  ns: 1n,
  us: 1_000n,
  'µs': 1_000n,
  ms: 1_000_000n,
  s: 1_000_000_000n,
  m: 60n * 1_000_000_000n,
  h: 60n * 60n * 1_000_000_000n,
  d: 24n * 60n * 60n * 1_000_000_000n,
};

/**
 * `amount` (digits, maybe a fraction) times `factor`, exactly, rounded
 * half away from zero to a whole number -- the reference's `scaled/2`:
 * `(digits × factor) / 10^fraction-digits`, as integers. Computing it
 * through a float, as this once did, lost precision above 2^53
 * (`1.0005KB` came out `1000`, not `1001`) and could not read an amount
 * too large for a float at all.
 * @param {string} amount -- `\d+(\.\d+)?`, separators already dropped
 * @param {bigint} factor
 * @returns {bigint}
 */
function scaled(amount, factor) {
  const [whole, fraction = ''] = amount.split('.');
  const numerator = BigInt(whole + fraction) * factor;
  const denominator = 10n ** BigInt(fraction.length);
  // The amount is never negative, so half away from zero is half up.
  return (2n * numerator + denominator) / (2n * denominator);
}

/** @type {Record<string, number>} */
const DURATION_UNIT_RANK = { d: 7, h: 6, m: 5, s: 4, ms: 3, us: 2, 'µs': 2, ns: 1 };

/**
 * Parses a duration literal's text into total nanoseconds (CASC.md §6.8).
 * The lexer's token shape is deliberately permissive; this is where the
 * real rules are enforced -- a single-unit literal may be fractional
 * (scaled exactly at any size, `scaled`); a
 * compound literal's components must be plain integers, strictly
 * descending, no unit repeated.
 * @param {string} text
 * @returns {bigint | string} nanoseconds, or an error message
 */
function parseDuration(text) {
  const components = [...text.matchAll(/(\d[\d_]*(?:\.\d[\d_]*)?)(ns|us|µs|ms|d|h|m|s)/g)].map((m) => [m[1], m[2]]);

  // `matchAll` alone doesn't guarantee full coverage -- it happily returns
  // matches for "5msXYZ9s", skipping the garbage between them. Re-joining
  // every component and comparing back against the input rejects that.
  if (components.length === 0 || components.map((c) => c.join('')).join('') !== text) {
    return `invalid duration literal ${JSON.stringify(text)}`;
  }

  if (components.length === 1) {
    const [amount, unit] = components[0];
    return scaled(amount.replace(/_/g, ''), DURATION_UNIT_NS[unit]);
  }

  const ranks = components.map(([, unit]) => DURATION_UNIT_RANK[unit]);
  if (components.some(([amount]) => amount.includes('.'))) {
    return `duration ${JSON.stringify(text)}: compound literals must use integer components`;
  }
  if (new Set(ranks).size !== ranks.length) return `duration ${JSON.stringify(text)}: a unit is repeated`;
  if (ranks.some((rank, i) => i > 0 && rank > ranks[i - 1])) {
    return `duration ${JSON.stringify(text)}: units must be strictly descending`;
  }
  return components.reduce((acc, [amount, unit]) => acc + BigInt(amount.replace(/_/g, '')) * DURATION_UNIT_NS[unit], 0n);
}

/** @type {Record<string, bigint>} */
const BYTE_UNIT_MULTIPLIER = {
  b: 1n,
  kb: 1000n,
  mb: 1000n ** 2n,
  gb: 1000n ** 3n,
  tb: 1000n ** 4n,
  pb: 1000n ** 5n,
  kib: 1024n,
  mib: 1024n ** 2n,
  gib: 1024n ** 3n,
  tib: 1024n ** 4n,
  pib: 1024n ** 5n,
};

/**
 * Parses a byte-size literal's text into total bytes (CASC.md §6.9):
 * case-insensitive units, an `i` before `B` meaning binary (×1024),
 * decimal (×1000) otherwise; the numeral may be fractional, and is
 * scaled exactly at any size (`scaled`).
 * @param {string} text
 * @returns {bigint | string} bytes, or an error message
 */
function parseBytes(text) {
  const m = /^(\d+(?:\.\d+)?)([a-zA-Z]+)$/.exec(text);
  if (!m) return `invalid byte-size literal ${JSON.stringify(text)}`;
  const multiplier = BYTE_UNIT_MULTIPLIER[m[2].toLowerCase()];
  if (multiplier === undefined) return `invalid byte-size unit in ${JSON.stringify(text)}`;
  return scaled(m[1], multiplier);
}

/**
 * Runs a value-class parser, turning its exception into a returned
 * message.
 * @template T
 * @param {() => T} fn
 * @param {string} what
 * @param {string} text
 * @returns {T | string}
 */
function attempt(fn, what, text) {
  try {
    return fn();
  } catch (err) {
    return `cannot parse ${JSON.stringify(text)} as ${what}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * @param {string} text -- `DATE` token text
 * @returns {LocalDate | string}
 */
function parseDate(text) {
  return attempt(() => LocalDate.parse(text), 'a date', text);
}

/**
 * @param {string} text -- `TIME` token text
 * @returns {LocalTime | string}
 */
function parseTime(text) {
  return attempt(() => LocalTime.parse(text), 'a time', text);
}

/**
 * `DATETIME` token text. With a `Z` or `±HH:MM` offset it denotes a real
 * instant and becomes a `DateTime` (in UTC, at microsecond resolution,
 * like Elixir's `DateTime.from_iso8601/1`); without one it becomes a
 * `LocalDateTime`.
 * @param {string} text
 * @returns {DateTime | LocalDateTime | string}
 */
function parseDateTime(text) {
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return attempt(() => DateTime.parse(text), 'a datetime', text);
  return attempt(() => LocalDateTime.parse(text), 'a datetime', text);
}

module.exports = {
  normalizeInteger,
  parseInteger,
  parseFloatLiteral,
  parseDuration,
  parseBytes,
  parseDate,
  parseTime,
  parseDateTime,
};
