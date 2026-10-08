'use strict';

/**
 * @fileoverview Parses a double-quoted string's (already escape-processed)
 * content into literal runs and reference nodes -- the port of the Elixir
 * implementation's `casc_interp.aether` plus `Cooper.InterpActions`.
 *
 * Every reference form is recognized as one whole raw token, its prefix
 * through the closing delimiter (`@{...}` ends at the *first* `}`), and
 * then taken apart with plain string logic. That is also why the
 * `:default` value grammar here is deliberately reduced compared to a
 * bare reference's (nil/booleans/integers/floats/strings/atoms/lists
 * only) -- the same scope trim the reference implementation has, which
 * keeps both implementations reading the same strings the same way.
 */

const CooperError = require('../error.cjs');
const { normalizeInteger, parseFloatLiteral } = require('./literals.cjs');
const { VarRef, EnvRef, ConfigRef, ResolverRef, TaggedRef } = require('../pipeline/nodes.cjs');

/** @typedef {import('../pipeline/nodes.cjs').Suffix} Suffix */
/** @typedef {import('../pipeline/nodes.cjs').Filter} Filter */

const BANG_TAG = /!([a-zA-Z][a-zA-Z0-9_+-]*[?!]?)\(/y;

/** @type {Record<string, string>} */
const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * `!{name:payload}` -> a `ResolverRef`; the *first* `:` splits name from
 * payload (CASC.md §7.4). Shared with the main evaluator.
 * @param {string} raw -- the whole span, `!{` and `}` included
 * @returns {InstanceType<typeof import('../pipeline/nodes.cjs').ResolverRef>}
 */
function buildResolverRef(raw) {
  const inner = raw.slice(2, -1);
  const colon = inner.indexOf(':');
  if (colon < 0) {
    throw new CooperError(`resolver reference missing ':' separator: ${JSON.stringify(raw)}`, { stage: 'action' });
  }
  return new ResolverRef(inner.slice(0, colon), inner.slice(colon + 1));
}

/**
 * End of a `!{...}` span with balanced braces, or -1.
 * @param {string} text
 * @param {number} i
 * @returns {number}
 */
function resolverEnd(text, i) {
  let depth = 1;
  for (let k = i + 2; k < text.length; k++) {
    if (text[k] === '{') depth++;
    else if (text[k] === '}' && --depth === 0) return k + 1;
  }
  return -1;
}

/**
 * Whether a reference token (or a `!Name(` tag start) begins at `i`.
 * @param {string} text
 * @param {number} i
 * @returns {boolean}
 */
function startsReference(text, i) {
  const two = text.slice(i, i + 2);
  if (two === '@{' || two === '${' || two === '%{' || two === '!{') return true;
  BANG_TAG.lastIndex = i;
  return BANG_TAG.test(text);
}

/**
 * @param {string} text
 * @returns {string}
 */
function unescapeSimple(text) {
  return text.replace(/\\([\s\S])/g, (_, c) => SIMPLE_ESCAPES[c] ?? c);
}

/**
 * A double-quoted default/message: unquoted and unescaped; anything else
 * comes back unchanged, quotes and all.
 * @param {string} text
 * @returns {string}
 */
function stripQuotes(text) {
  const m = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(text);
  return m ? unescapeSimple(m[1]) : text;
}

/**
 * The reduced default-value grammar (see the file overview).
 * @param {string} raw
 * @returns {unknown}
 */
function parseDefaultValue(raw) {
  const text = raw.trim();
  if (text === 'nil') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^[+-]?\d+$/.test(text)) return normalizeInteger(BigInt(text.replace(/^\+/, '')));
  if (/^[+-]?\d+\.\d+$/.test(text)) return parseFloatLiteral(text);
  if (text.startsWith('"')) return stripQuotes(text);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith('[') && text.endsWith(']')) {
    const items = text.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^,]+/g) ?? [];
    return items.map((item) => item.trim()).filter((item) => item !== '').map(parseDefaultValue);
  }
  return Symbol.for(text);
}

/**
 * @param {string} text -- everything after the first `:`
 * @returns {Suffix}
 */
function parseSuffix(text) {
  if (text.startsWith('?')) return { kind: 'required', message: stripQuotes(text.slice(1).trim()) };
  if (text.startsWith('+')) return { kind: 'substitute', value: parseDefaultValue(text.slice(1)) };
  return { kind: 'default', value: parseDefaultValue(text) };
}

/**
 * Splits a reference body into its part before any filter and the filter
 * chain. Quote-aware, since a default may contain a pipe (`${N:"a|b"}`),
 * and must run before the `:` split, since a filter carries its own `:`.
 * @param {string} inner
 * @returns {{body: string, filters: Filter[]}}
 */
function splitFilters(inner) {
  /** @type {string[]} */
  const parts = [];
  let current = '';
  /** @type {string | null} */
  let quote = null;
  for (const c of inner) {
    if (quote === null && (c === '"' || c === "'")) quote = c;
    else if (quote === c) quote = null;
    else if (c === '|' && quote === null) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  if (parts.length === 1) return { body: inner, filters: [] };
  const filters = parts.slice(1).map((part) => {
    const trimmed = part.trim();
    const colon = trimmed.indexOf(':');
    if (colon < 0) return { name: trimmed, arg: null };
    const arg = trimmed.slice(colon + 1).trim();
    const single = arg.length >= 2 && arg.startsWith("'") && arg.endsWith("'");
    return { name: trimmed.slice(0, colon).trim(), arg: single ? arg.slice(1, -1) : stripQuotes(arg) };
  });
  return { body: parts[0].trimEnd(), filters };
}

/**
 * `name[idx]:suffix` -> its parts; the first `:` always separates the
 * suffix, since a name never contains one.
 * @param {string} body
 * @param {boolean} allowEmptyIndex -- `${NAME[]}`'s list marker
 * @returns {{name: string, bracket: {index: number | null} | null, suffix: Suffix | null}}
 */
function parseRefBody(body, allowEmptyIndex) {
  const colon = body.indexOf(':');
  const head = colon < 0 ? body : body.slice(0, colon);
  const suffix = colon < 0 ? null : parseSuffix(body.slice(colon + 1));
  const m = (allowEmptyIndex ? /^([^[]+)\[(\d*)\]$/ : /^([^[]+)\[(\d+)\]$/).exec(head);
  if (!m) return { name: head, bracket: null, suffix };
  return { name: m[1], bracket: { index: m[2] === '' ? null : Number(m[2]) }, suffix };
}

/**
 * Parses interpolated string content into segments.
 * @param {string} text -- already escape-processed
 * @param {string | null} scope -- stamped onto every `VarRef` (see `VarRef#scope`)
 * @returns {unknown[]} literal strings and reference nodes, in order
 * @throws {CooperError} stage `lexer`, for an unterminated reference
 */
function parseInterpolated(text, scope) {
  /** @type {unknown[]} */
  const segments = [];
  let i = 0;
  while (i < text.length) {
    if (!startsReference(text, i)) {
      let j = i + 1;
      while (j < text.length && !startsReference(text, j)) j++;
      segments.push(text.slice(i, j));
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    let end;
    if (two === '!{') end = resolverEnd(text, i);
    else if (two === '@{' || two === '${' || two === '%{') {
      const close = text.indexOf('}', i + 2);
      end = close < 0 ? -1 : close + 1;
    } else {
      const close = text.indexOf(')', i);
      end = close < 0 ? -1 : close + 1;
    }
    if (end < 0) {
      throw new CooperError(`no token matches here: unterminated reference in string ${JSON.stringify(text)}`, {
        stage: 'lexer',
      });
    }
    segments.push(buildReference(text.slice(i, end), scope));
    i = end;
  }
  return segments;
}

/**
 * @param {string} raw -- one whole reference token
 * @param {string | null} scope
 * @returns {unknown}
 */
function buildReference(raw, scope) {
  const opener = raw.slice(0, 2);
  if (opener === '!{') return buildResolverRef(raw);
  if (opener === '@{' || opener === '${' || opener === '%{') {
    const { body, filters } = splitFilters(raw.slice(2, -1));
    if (opener === '${') {
      const { name, bracket, suffix } = parseRefBody(body, true);
      const list = bracket !== null && bracket.index === null;
      return new EnvRef({ name, index: bracket?.index ?? null, list, suffix, filters });
    }
    const { name, bracket, suffix } = parseRefBody(body, false);
    if (opener === '%{') return new ConfigRef({ path: name.split('.'), index: bracket?.index ?? null, suffix, filters });
    return new VarRef({ name, index: bracket?.index ?? null, suffix, filters, scope });
  }
  const m = /^!([a-zA-Z][a-zA-Z0-9_+\-?!]*)\(([\s\S]*)\)$/.exec(raw);
  const [, name, arg] = /** @type {RegExpExecArray} */ (m);
  return new TaggedRef(name, parseDefaultValue(arg));
}

module.exports = { parseInterpolated, buildResolverRef };
