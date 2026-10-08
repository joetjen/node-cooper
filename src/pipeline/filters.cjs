'use strict';

/**
 * @fileoverview Reference filters (`| trim`, `| trim_suffix: "://"`,
 * CASC.md §7.2) -- one closed vocabulary shared by `@{}`, `${}`, and `%{}`,
 * the port of the filter half of `Cooper.RefCommon`.
 *
 * The set is deliberately closed: an open one would oblige every
 * conformant reader, in every language, to implement an unbounded
 * vocabulary, and turn a config format into an expression language.
 */

const { CooperFloat } = require('../values/float.cjs');

/** @type {Record<string, {takesArgument: boolean, run: (value: string, arg: string) => string}>} */
const FILTERS = {
  trim: { takesArgument: false, run: (v) => v.trim() },
  downcase: { takesArgument: false, run: (v) => v.toLowerCase() },
  upcase: { takesArgument: false, run: (v) => v.toUpperCase() },
  trim_prefix: { takesArgument: true, run: (v, a) => (a !== '' && v.startsWith(a) ? v.slice(a.length) : v) },
  trim_suffix: { takesArgument: true, run: (v, a) => (a !== '' && v.endsWith(a) ? v.slice(0, v.length - a.length) : v) },
};

/**
 * Applies a filter chain left to right. A non-string value is an error
 * rather than a coercion: filters normalize, they do not convert.
 * @param {unknown} value
 * @param {Array<{name: string, arg: string | null}>} filters -- arguments already settled to strings
 * @returns {{ok: true, value: unknown} | {ok: false, message: string}}
 */
function applyFilters(value, filters) {
  let current = value;
  for (const { name, arg } of filters) {
    const filter = Object.hasOwn(FILTERS, name) ? FILTERS[name] : undefined;
    if (!filter) {
      return { ok: false, message: `unknown filter ${JSON.stringify(name)}; known filters: ${Object.keys(FILTERS).sort().join(', ')}` };
    }
    if (!filter.takesArgument && arg !== null) return { ok: false, message: `filter ${JSON.stringify(name)} takes no argument` };
    if (filter.takesArgument && arg === null) {
      return { ok: false, message: `filter ${JSON.stringify(name)} requires an argument, as in |${name}: "..."` };
    }
    if (typeof current !== 'string') {
      return { ok: false, message: `cannot apply filter ${JSON.stringify(name)} to ${describe(current)}: not a string` };
    }
    current = filter.run(current, arg ?? '');
  }
  return { ok: true, value: current };
}

/**
 * A short rendering of a value for an error message.
 * @param {unknown} value
 * @returns {string}
 */
function describe(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'symbol') return `:${value.description}`;
  if (typeof value === 'bigint') return `${value}`;
  if (Array.isArray(value)) return `[${value.map(describe).join(', ')}]`;
  if (value === null) return 'nil';
  if (value instanceof CooperFloat) return value.toString();
  return String(value);
}

module.exports = { applyFilters, describe, FILTER_NAMES: Object.keys(FILTERS) };
