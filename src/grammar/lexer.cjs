'use strict';

/**
 * @fileoverview The CASC tokenizer. A hand-written port of the token
 * section of the Elixir implementation's `priv/grammar/casc.aether`
 * (compiled there by Ichor), keeping its semantics rather than its
 * machinery:
 *
 * - **Maximal munch, ties by declaration order.** At each position every
 *   token pattern is tried; the longest match wins, and on a tie the
 *   earlier-declared pattern wins (`TOKENS` below is in the grammar's own
 *   order). That is what makes the reserved words (`nil`, `true`, `false`,
 *   `inf`) out-rank `IDENT` on equal length while `info` stays an `IDENT`,
 *   and `1979-05-27` a `DATE` rather than `INTEGER` + `-` + ...
 * - **Punctuation** (`=`, `{`, `@{`, `${?`, ...) are literal tokens ranked
 *   after every named one, so a named token only loses to a strictly
 *   longer literal.
 * - **Trivia** (whitespace and `# comments`) is skipped between tokens.
 *   `#` starts a comment only when *not* directly followed by a letter,
 *   `@`, or `*` -- those are the version header and disabled-statement
 *   forms (CASC.md §3.2), lexed as a literal `#`.
 *
 * A signed `+inf`/`-inf` is only a reserved word when no identifier
 * character follows it, so `+infra = [...]` (append to the list `infra`)
 * lexes as `+` `infra` rather than `+inf` `ra` (conformance case 905).
 *
 * Newlines are trivia here; the one place they matter (CASC.md §3.1,
 * "newlines end statements") is enforced by the parser, using each
 * token's `line`.
 */

const CooperError = require('../error.cjs');

/**
 * @typedef {object} Token
 * @property {string} type -- a named token type (`IDENT`, `DQ_STRING`, ...) or the literal text of a punctuation token
 * @property {string} text
 * @property {number} offset
 * @property {number} line -- 1-based line the token starts on
 */

/**
 * @param {RegExp} re -- must be sticky (`y`)
 * @returns {(src: string, i: number) => number}
 */
function sticky(re) {
  return (src, i) => {
    re.lastIndex = i;
    const m = re.exec(src);
    return m ? i + m[0].length : -1;
  };
}

/** @param {string | undefined} c */
const isHex = (c) => c !== undefined && /[0-9a-fA-F]/.test(c);
/** @param {string | undefined} c */
const isDigit = (c) => c !== undefined && c >= '0' && c <= '9';

/**
 * `HEX{1,4}`, greedy.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function hexGroup(src, i) {
  let j = i;
  while (j - i < 4 && isHex(src[j])) j++;
  return j > i ? j : -1;
}

/**
 * `(":" HEX_GROUP)*`, PEG-style: each repetition commits only when both
 * parts match.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function colonGroups(src, i) {
  let k = i;
  while (src[k] === ':') {
    const end = hexGroup(src, k + 1);
    if (end < 0) break;
    k = end;
  }
  return k;
}

/**
 * `IPV6`: either the full eight-group form or a form containing a literal
 * `::` -- deliberately never a bare `(HEX | ":")+`, which would steal the
 * `:` atom sigil from `:false` and friends. Hand-written rather than a
 * regex so it keeps PEG's greedy, non-backtracking repetition.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function scanIPv6(src, i) {
  let end = -1;
  const first = hexGroup(src, i);
  if (first >= 0) {
    let k = first;
    let n = 0;
    while (n < 7 && src[k] === ':') {
      const next = hexGroup(src, k + 1);
      if (next < 0) break;
      k = next;
      n++;
    }
    if (n === 7) end = k;
  }
  if (end < 0) {
    let k = first >= 0 ? colonGroups(src, first) : i;
    if (!src.startsWith('::', k)) return -1;
    k += 2;
    const tail = hexGroup(src, k);
    end = tail >= 0 ? colonGroups(src, tail) : k;
  }
  if (src[end] === '/' && isDigit(src[end + 1])) {
    let k = end + 1;
    while (k < end + 4 && isDigit(src[k])) k++;
    end = k;
  }
  return end;
}

/**
 * `!{name:payload}` with genuinely unbounded brace nesting in the payload
 * (CASC.md §7.4: "brace-balanced"), tracking depth as it goes -- the
 * Elixir implementation's `Cooper.Native.ResolverRef`.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function scanResolverRef(src, i) {
  if (!src.startsWith('!{', i)) return -1;
  let depth = 1;
  for (let k = i + 2; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}' && --depth === 0) return k + 1;
  }
  return -1;
}

const DURATION_UNIT = '(?:ns|us|µs|ms|d|h|m|s)';
const BYTE_UNIT = '(?:pib|tib|gib|mib|kib|pb|tb|gb|mb|kb|b)';

/**
 * Named tokens, in the grammar's declaration order (the tie-break order).
 * @type {Array<[string, (src: string, i: number) => number]>}
 */
const TOKENS = [
  ['NIL_KW', sticky(/nil/y)],
  ['TRUE_KW', sticky(/true/y)],
  ['FALSE_KW', sticky(/false/y)],
  ['INF_KW', sticky(/[+-]inf(?![A-Za-z0-9_+\-?!])|inf/y)],
  ['IDENT', sticky(/[a-zA-Z][a-zA-Z0-9_+-]*[?!]?/y)],
  ['DATE', sticky(/\d{4}-\d{2}-\d{2}/y)],
  ['TIME', sticky(/\d{2}:\d{2}:\d{2}(?:\.\d+)?/y)],
  ['DATETIME', sticky(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?/y)],
  ['IPV4', sticky(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?:\/\d{1,3})?/y)],
  ['IPV6', scanIPv6],
  ['DURATION', sticky(new RegExp(String.raw`\d[\d_]*(?:\.\d[\d_]*)?${DURATION_UNIT}(?:\d[\d_]*${DURATION_UNIT})*`, 'y'))],
  ['BYTES', sticky(new RegExp(String.raw`\d+(?:\.\d+)?${BYTE_UNIT}`, 'iy'))],
  ['INTEGER', sticky(/[+-]?(?:0x[0-9a-fA-F][0-9a-fA-F_]*|0o[0-7][0-7_]*|0b[01][01_]*|\d[\d_]*)/y)],
  ['FLOAT', sticky(/[+-]?\d[\d_]*(?:\.\d[\d_]*(?:[eE][+-]?\d+)?|[eE][+-]?\d+)/y)],
  ['TRIPLE_STRING', sticky(/"""[\s\S]*?"""/y)],
  ['DQ_STRING', sticky(/"(?:\\[\s\S]|[^"\\])*"/y)],
  ['SQ_STRING', sticky(/'[^']*'/y)],
  ['RESOLVER_REF_RAW', scanResolverRef],
];

/** Punctuation literals, longest first. */
const LITERALS = ['${?', '@{', '${', '%{', '#', '@', '=', '}', '*', ',', '~', '+', '-', '{', '.', '!', '(', ')', '[', ']', ':', '?', '|'];

/**
 * 1-based line and column of `offset` in `src`.
 * @param {string} src
 * @param {number} offset
 * @returns {{line: number, column: number}}
 */
function position(src, offset) {
  let line = 1;
  let lineStart = 0;
  for (let k = 0; k < offset && k < src.length; k++) {
    if (src[k] === '\n') {
      line++;
      lineStart = k + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Skips whitespace and comments starting at `i`.
 * @param {string} src
 * @param {number} i
 * @returns {number}
 */
function skipTrivia(src, i) {
  let k = i;
  for (;;) {
    const c = src[k];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      k++;
    } else if (c === '#' && !/[@*a-zA-Z]/.test(src[k + 1] ?? '')) {
      while (k < src.length && src[k] !== '\n') k++;
    } else {
      return k;
    }
  }
}

/**
 * Tokenizes a whole CASC source.
 * @param {string} src
 * @param {{file?: string}} [opts]
 * @returns {Token[]}
 * @throws {CooperError} stage `lexer`, when no token matches at some position
 */
function tokenize(src, opts = {}) {
  /** @type {Token[]} */
  const tokens = [];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let counted = 0;
  for (;;) {
    i = skipTrivia(src, i);
    if (i >= src.length) return tokens;
    for (; counted < i; counted++) if (src[counted] === '\n') line++;
    let bestType = '';
    let bestEnd = -1;
    for (const [type, scan] of TOKENS) {
      const end = scan(src, i);
      if (end > bestEnd) {
        bestType = type;
        bestEnd = end;
      }
    }
    for (const literal of LITERALS) {
      if (src.startsWith(literal, i)) {
        if (i + literal.length > bestEnd) {
          bestType = literal;
          bestEnd = i + literal.length;
        }
        break;
      }
    }
    if (bestEnd <= i) {
      const { line, column } = position(src, i);
      throw new CooperError(`no token matches here (line ${line}, column ${column})`, {
        stage: 'lexer',
        file: opts.file,
        line,
        column,
        offset: i,
      });
    }
    tokens.push({ type: bestType, text: src.slice(i, bestEnd), offset: i, line });
    i = bestEnd;
  }
}

module.exports = { tokenize, position };
