'use strict';

/**
 * @fileoverview Walks a parsed file's AST in source order and produces the
 * flat entry list the rest of the pipeline works on -- the port of
 * `Cooper.Actions` (plus `Cooper.Grammar`'s per-file driver):
 *
 * - every leaf value converted to its native form (numbers, durations,
 *   dates, ...) or to an unresolved reference node (`nodes.cjs`);
 * - every statement flattened to `op`/`var`/`clear` entries, dotted paths
 *   and nested blocks already folded into each op's `path`;
 * - `for` loops expanded (`loop.cjs`) and imports spliced in
 *   (`loader.cjs`) *inline*, at the point they're reached, so that the
 *   variables an import brings in are visible to what follows it.
 *
 * Assembling the entries into a tree is a separate step (`merge.cjs`), so
 * an imported file's entries can be spliced into the importer's list
 * instead of un-folding an already-assembled map.
 */

const path = require('node:path');
const CooperError = require('../error.cjs');
const Tuple = require('../values/tuple.cjs');
const Duration = require('../values/duration.cjs');
const ByteSize = require('../values/byte-size.cjs');
const IPv4 = require('../values/ipv4.cjs');
const IPv6 = require('../values/ipv6.cjs');
const literals = require('../grammar/literals.cjs');
const { parse } = require('../grammar/parser.cjs');
const { parseInterpolated, buildResolverRef } = require('../grammar/interp.cjs');
const { Block, VarRef, EnvRef, ConfigRef, TaggedRef, InterpText } = require('./nodes.cjs');
const { expandLoop } = require('./loop.cjs');

/** @typedef {import('../grammar/parser.cjs').ValueNode} ValueNode */
/** @typedef {import('../grammar/parser.cjs').StatementNode} StatementNode */
/** @typedef {import('../grammar/parser.cjs').KeySegmentNode} KeySegmentNode */
/** @typedef {import('./nodes.cjs').Entry} Entry */
/** @typedef {import('./nodes.cjs').Sigil} Sigil */
/** @template T @typedef {import('./effects.cjs').Pipeline<T>} Pipeline */

/**
 * Per-file evaluation state. A freshly imported file gets its own
 * (`loader.cjs`), sharing only what must cross file boundaries.
 *
 * @typedef {object} Context
 * @property {string} scope -- this file's identity (`scopeId`)
 * @property {string | undefined} file
 * @property {string} root -- directory a bare import resolves against
 * @property {Record<string, (rest: string) => unknown>} importSchemes
 * @property {string[]} importing -- the chain of files being loaded, for cycle detection
 * @property {Set<string>} loadedFiles -- every real file the load read, for cache fingerprinting
 * @property {Glob[]} loadedGlobs -- every filesystem import's expansion, for cache fingerprinting
 * @property {Record<string, string>} env
 * @property {Set<string>} parseEnvNames -- `${NAME}`s read while parsing (guards, import paths)
 * @property {Map<string, unknown>} publicVars -- the shared `@name` environment
 * @property {Map<string, unknown>} privateVars -- this file's own `@*name` declarations
 * @property {Map<string, Map<string, unknown>>} privateByScope -- every file's privates, by scope
 */

/**
 * One filesystem import's expansion: the `pattern` (braces and wildcards,
 * after `${NAME}` interpolation) expanded under `root` into `files`.
 * @typedef {object} Glob
 * @property {string} root
 * @property {string} pattern
 * @property {string[]} files -- absolute, sorted, as `expandImport` returned them
 */

/** The scope of a source loaded without a file. */
const ANONYMOUS_SCOPE = '(source)';

/**
 * @param {string | undefined} file
 * @returns {string}
 */
function scopeId(file) {
  return file === undefined ? ANONYMOUS_SCOPE : path.resolve(file);
}

/** @type {Record<string, string>} */
const ESCAPES = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

/**
 * Double-quoted string escapes (CASC.md §6.5). An unknown escape keeps
 * its character and drops the backslash.
 * @param {string} text
 * @returns {string}
 */
function unescape(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escaped) =>
    escaped.length === 5 ? String.fromCharCode(parseInt(escaped.slice(1), 16)) : (ESCAPES[escaped] ?? escaped)
  );
}

/**
 * Triple-quoted strings (CASC.md §6.5): the newline right after the
 * opening quotes is dropped, and the smallest common leading whitespace
 * across non-blank lines is stripped from every line.
 * @param {string} content
 * @returns {string}
 */
function dedent(content) {
  const body = content.startsWith('\n') ? content.slice(1) : content;
  const lines = body.split('\n');
  const indents = lines.filter((line) => line.trim() !== '').map((line) => /** @type {RegExpExecArray} */ (/^[ \t]*/.exec(line))[0].length);
  const indent = indents.length === 0 ? 0 : Math.min(...indents);
  return lines.map((line) => line.slice(indent)).join('\n');
}

/**
 * @param {string} message
 * @param {import('../grammar/lexer.cjs').Token} token
 * @returns {CooperError}
 */
function actionError(message, token) {
  return new CooperError(message, { stage: 'action', offset: token.offset });
}

/**
 * Converts one scalar token to its value.
 * @param {import('../grammar/lexer.cjs').Token} token
 * @param {string} scope
 * @param {string} root
 * @returns {unknown}
 */
function tokenValue(token, scope, root) {
  const { type, text } = token;
  /** @param {unknown} result */
  const check = (result) => {
    if (typeof result === 'string') throw actionError(result, token);
    return result;
  };
  switch (type) {
    case 'NIL_KW':
      return null;
    case 'TRUE_KW':
      return true;
    case 'FALSE_KW':
      return false;
    case 'INF_KW':
      return text.startsWith('-') ? -Infinity : Infinity;
    case 'INTEGER':
      return literals.parseInteger(text);
    case 'FLOAT':
      return literals.parseFloatLiteral(text);
    case 'DATE':
      return check(literals.parseDate(text));
    case 'TIME':
      return check(literals.parseTime(text));
    case 'DATETIME':
      return check(literals.parseDateTime(text));
    case 'IPV4':
    case 'IPV6':
      try {
        return type === 'IPV4' ? IPv4.parse(text) : IPv6.parse(text);
      } catch (err) {
        throw actionError(/** @type {Error} */ (err).message, token);
      }
    case 'DURATION':
      return new Duration(/** @type {bigint} */ (check(literals.parseDuration(text))));
    case 'BYTES':
      return new ByteSize(/** @type {bigint} */ (check(literals.parseBytes(text))));
    case 'DQ_STRING':
      return interpolatedString(text.slice(1, -1), scope);
    case 'SQ_STRING':
      return text.slice(1, -1);
    case 'TRIPLE_STRING':
      return dedent(text.slice(3, -3));
    case 'RESOLVER_REF_RAW':
      return buildResolverRef(text);
    default:
      return text;
  }
}

/**
 * A double-quoted string's content: a plain string when it references
 * nothing, an `InterpText` otherwise. `root` is unused here; references
 * inside a string never need it.
 * @param {string} content -- between the quotes, still escaped
 * @param {string} scope
 * @returns {string | InterpText}
 */
function interpolatedString(content, scope) {
  const segments = parseInterpolated(unescape(content), scope);
  if (segments.length === 0) return '';
  if (segments.length === 1 && typeof segments[0] === 'string') return segments[0];
  return new InterpText(segments);
}

/**
 * Converts a value node to a value, references left unresolved. A
 * generator, threading `ctx`, because a list or tuple element may be a
 * block (CASC.md §6.10) whose statements are evaluated like any other --
 * variables declared, loops expanded, imports spliced in.
 * @param {ValueNode} node
 * @param {Context} ctx
 * @returns {Pipeline<unknown>}
 */
function* evalValue(node, ctx) {
  const { scope, root } = ctx;
  switch (node.kind) {
    case 'token':
      return tokenValue(node.token, scope, root);
    case 'atom':
      return atomValue(node.text);
    case 'list':
      return yield* evalElements(node.items, ctx);
    case 'tuple':
      return new Tuple(yield* evalElements(node.items, ctx));
    case 'atRef':
      return new VarRef({
        name: yield* evalValue(node.name, ctx),
        index: node.index ? Number(literals.parseInteger(node.index.text)) : null,
        suffix: yield* evalSuffix(node.suffix, ctx),
        filters: evalFilters(node.filters, scope),
        scope,
      });
    case 'envRef':
      return new EnvRef({
        name: yield* evalValue(node.name, ctx),
        index: node.bracket?.index ? Number(literals.parseInteger(node.bracket.index.text)) : null,
        list: node.bracket !== null && node.bracket.index === null,
        suffix: yield* evalSuffix(node.suffix, ctx),
        filters: evalFilters(node.filters, scope),
      });
    case 'configRef':
      return new ConfigRef({
        path: evalKeyPath(node.path, scope).segments,
        index: node.index ? Number(literals.parseInteger(node.index.text)) : null,
        suffix: yield* evalSuffix(node.suffix, ctx),
        filters: evalFilters(node.filters, scope),
      });
    case 'tagged':
      return new TaggedRef(node.name, yield* evalValue(node.arg, ctx));
  }
}

/**
 * A list's or tuple's elements. An element block (CASC.md §6.10) stays a
 * `Block` of its flattened entries and becomes a map in `resolver.cjs`,
 * once its keys -- which may interpolate -- can be resolved.
 * @param {import('../grammar/parser.cjs').ElementNode[]} items
 * @param {Context} ctx
 * @returns {Pipeline<unknown[]>}
 */
function* evalElements(items, ctx) {
  const values = [];
  for (const item of items) {
    values.push(item.kind === 'block' ? new Block(yield* evalStatements(item.statements, ctx)) : yield* evalValue(item, ctx));
  }
  return values;
}

/** @type {Record<string, null | boolean>} */
const VALUE_ATOMS = { nil: null, true: true, false: false };

/**
 * An atom, as the symbol of its name -- except `:nil`, `:true` and
 * `:false`, which are the values `null`, `true` and `false` (CASC.md
 * §6.4), so a document means one thing in every implementation. Keeping
 * them as atoms was tried and dropped; §6.4 says why. `:inf` is an
 * ordinary atom.
 * @param {string} text
 * @returns {unknown}
 */
function atomValue(text) {
  return Object.hasOwn(VALUE_ATOMS, text) ? VALUE_ATOMS[text] : Symbol.for(text);
}

/**
 * @param {import('../grammar/parser.cjs').SuffixNode | null} node
 * @param {Context} ctx
 * @returns {Pipeline<import('./nodes.cjs').Suffix | null>}
 */
function* evalSuffix(node, ctx) {
  if (node === null) return null;
  // The message is a double-quoted string like any other, so it may
  // interpolate (CASC.md §7.2); the resolver settles it only on failure.
  if (node.kind === 'required') return { kind: 'required', message: tokenValue(node.message, ctx.scope, ctx.root) };
  return { kind: node.kind, value: yield* evalValue(node.value, ctx) };
}

/**
 * A double-quoted filter argument is a double-quoted string like any
 * other, so it interpolates (an `InterpText` the resolver settles); a
 * single-quoted one is literal. Taking the double-quoted text verbatim, as
 * this once did, left a loop binding in `| trim_suffix: "@{x}"` unexpanded.
 * @param {import('../grammar/parser.cjs').FilterNode[]} nodes
 * @param {string} scope
 * @returns {import('./nodes.cjs').Filter[]}
 */
function evalFilters(nodes, scope) {
  return nodes.map(({ name, arg }) => ({
    name,
    arg: arg === null ? null : arg.type === 'DQ_STRING' ? interpolatedString(arg.text.slice(1, -1), scope) : arg.text.slice(1, -1),
  }));
}

/**
 * A key path's segments -- plain strings, or an `InterpText` for an
 * interpolated double-quoted segment -- and whether any segment carries
 * the secret marker (CASC.md §4.3).
 * @param {KeySegmentNode[]} nodes
 * @param {string} scope
 * @returns {{segments: unknown[], secret: boolean}}
 */
function evalKeyPath(nodes, scope) {
  return {
    segments: nodes.map(({ seg }) => (seg.type === 'IDENT' ? seg.text : tokenValue(seg, scope, ''))),
    secret: nodes.some((node) => node.secret),
  };
}

/** @type {Record<string, Sigil>} */
const SIGILS = { '~': 'replace', '+': 'append', '-': 'remove' };

/**
 * Evaluates statements in order, threading `ctx`.
 * @param {StatementNode[]} statements
 * @param {Context} ctx
 * @returns {Pipeline<Entry[]>}
 */
function* evalStatements(statements, ctx) {
  /** @type {Entry[]} */
  const entries = [];
  for (const statement of statements) entries.push(...(yield* evalStatement(statement, ctx)));
  return entries;
}

/**
 * @param {StatementNode} statement
 * @param {Context} ctx
 * @returns {Pipeline<Entry[]>}
 */
function* evalStatement(statement, ctx) {
  switch (statement.kind) {
    // CASC.md §5.6: syntactically valid, but produces nothing -- not even a
    // variable declaration or an import's side effects.
    case 'disabled':
      return [];

    // CASC.md §7.2's `${?NAME}`: guards exactly the one statement after it,
    // which is never even evaluated when NAME is unset or empty.
    case 'guarded': {
      ctx.parseEnvNames.add(statement.name);
      const value = ctx.env[statement.name];
      return Object.hasOwn(ctx.env, statement.name) && value !== '' ? yield* evalStatement(statement.statement, ctx) : [];
    }

    case 'varDecl': {
      const value = yield* evalValue(statement.value, ctx);
      (statement.private ? ctx.privateVars : ctx.publicVars).set(statement.name, value);
      return [{ kind: 'var', name: statement.name, value, public: !statement.private }];
    }

    case 'for': {
      /** @type {import('./loop.cjs').Binding[]} */
      const bindings = [];
      for (const b of statement.bindings) {
        bindings.push(
          b.iterable === null ? { kind: 'index', name: b.name } : { kind: 'element', name: b.name, iterable: yield* evalValue(b.iterable, ctx) }
        );
      }
      const template = statement.template ? evalKeyPath(statement.template, ctx.scope).segments : null;
      const dest = evalKeyPath(statement.dest, ctx.scope);
      const body = yield* evalStatements(statement.body, ctx);
      return expandLoop(bindings, template, dest.segments, dest.secret, body, (name) => lookupVar(ctx, name));
    }

    case 'import': {
      const { loadImport } = require('./loader.cjs');
      return yield* loadImport(tokenValue(statement.path, ctx.scope, ctx.root), ctx);
    }

    case 'assign': {
      const sigil = statement.sigil === null ? 'merge' : SIGILS[statement.sigil];
      const { segments, secret } = evalKeyPath(statement.path, ctx.scope);
      if (statement.rhs.kind !== 'block') {
        return [{ kind: 'op', path: segments, sigil, value: yield* evalValue(statement.rhs, ctx), secret }];
      }
      const nested = yield* evalStatements(statement.rhs.statements, ctx);
      if (nested.length === 0) {
        // An empty block is an empty map (CASC.md §5.4): it writes one,
        // which `merge.cjs` lets leave a map already there as it is.
        // Emitting nothing, as this once did, made `w {}` and `w = {}` no
        // key at all.
        /** @type {Entry} */
        const op = { kind: 'op', path: segments, sigil, value: {}, secret };
        return sigil === 'replace' ? [{ kind: 'clear', path: segments }, op] : [op];
      }
      /** @type {Entry[]} */
      const entries = nested.map((entry) => {
        if (entry.kind === 'op') {
          // A leaf's own sigil wins; a plain leaf inherits the block's.
          const leafSigil = entry.sigil === 'merge' ? sigil : entry.sigil;
          return { ...entry, path: [...segments, ...entry.path], secret: secret || entry.secret, sigil: leafSigil };
        }
        if (entry.kind === 'clear') return { ...entry, path: [...segments, ...entry.path] };
        return entry;
      });
      // `~key { ... }` replaces the *whole* subtree at `key`, not just the
      // paths the new block mentions (CASC.md §8.4: `~server { port = 9090 }`
      // drops `host` too) -- one `clear` at the statement's own path first.
      return sigil === 'replace' ? [{ kind: 'clear', path: segments }, ...entries] : entries;
    }

    case 'delete': {
      const { segments, secret } = evalKeyPath(statement.path, ctx.scope);
      return [{ kind: 'op', path: segments, sigil: 'delete', value: null, secret }];
    }
  }
}

/**
 * A variable as the current file sees it while parsing: its own private
 * declaration first, then the shared public environment.
 * @param {Context} ctx
 * @param {string} name
 * @returns {{found: true, value: unknown} | {found: false}}
 */
function lookupVar(ctx, name) {
  if (ctx.privateVars.has(name)) return { found: true, value: ctx.privateVars.get(name) };
  if (ctx.publicVars.has(name)) return { found: true, value: ctx.publicVars.get(name) };
  return { found: false };
}

/**
 * Parses and evaluates one complete CASC source (version header and all).
 * @param {string} source
 * @param {Context} ctx
 * @returns {Pipeline<Entry[]>}
 */
function* evaluateSource(source, ctx) {
  const ast = parse(source, { file: ctx.file });
  if (ast.versionKeyword.text !== 'version') {
    throw new CooperError(`expected "#@version", got "#${ast.versionKeyword.text}"`, {
      stage: 'action',
      file: ctx.file,
      offset: ast.versionKeyword.offset,
    });
  }
  const entries = yield* evalStatements(ast.statements, ctx);
  if (ctx.privateVars.size > 0) ctx.privateByScope.set(ctx.scope, ctx.privateVars);
  return entries;
}

module.exports = { evaluateSource, evalValue, scopeId, ANONYMOUS_SCOPE, lookupVar };
