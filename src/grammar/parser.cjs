'use strict';

/**
 * @fileoverview The CASC parser: a hand-written PEG over `lexer.cjs`'s
 * token stream, porting the rule section of the Elixir implementation's
 * `priv/grammar/casc.aether` rule for rule -- same ordered choices, same
 * greedy non-backtracking `?`/`*` -- and producing a plain AST that
 * `pipeline/evaluate.cjs` walks (the Elixir side folds that walk into
 * `Cooper.Actions`, run over Ichor's captures).
 *
 * Parsing is pure: no literal is converted and nothing is resolved here,
 * so a statement skipped by a `${?NAME}` guard can never fail just
 * because something inside it would.
 *
 * The contextual keywords
 * (`import`, `for`, `in`, `from`, `as`, CASC.md §4.1) are checked *while
 * parsing*, so a statement that merely looks like one falls through to the
 * next alternative. The reference matches any identifier there and
 * rejects it afterwards, which makes `foo "bar"` -- CASC.md §5.3's own
 * example of the optional `=` -- fail as a malformed import. (The
 * reference has since adopted the same reading.)
 *
 * Statements are not newline-terminated: newlines are trivia like any
 * other whitespace. The one ambiguity that creates -- a bare `-key.path`
 * whose next statement could be read as its remove value -- is settled by
 * CASC.md §5.7's rule, as `followed_delete` below.
 */

const CooperError = require('../error.cjs');
const { tokenize, position } = require('./lexer.cjs');

/** @typedef {import('./lexer.cjs').Token} Token */

/**
 * @typedef {{kind: 'token', token: Token}
 *   | {kind: 'atom', text: string}
 *   | {kind: 'list', items: ElementNode[]}
 *   | {kind: 'tuple', items: ElementNode[]}
 *   | {kind: 'atRef', name: ValueNode, index: Token | null, suffix: SuffixNode | null, filters: FilterNode[]}
 *   | {kind: 'envRef', name: ValueNode, bracket: {index: Token | null} | null, suffix: SuffixNode | null, filters: FilterNode[]}
 *   | {kind: 'configRef', path: KeySegmentNode[], index: Token | null, suffix: SuffixNode | null, filters: FilterNode[]}
 *   | {kind: 'tagged', name: string, arg: ValueNode}} ValueNode
 *
 * A list or tuple element: a value, or a block -- a map (CASC.md §6.10).
 * @typedef {ValueNode | {kind: 'block', statements: StatementNode[]}} ElementNode
 *
 * @typedef {{kind: 'required', message: Token} | {kind: 'substitute', value: ValueNode} | {kind: 'default', value: ValueNode}} SuffixNode
 * @typedef {{name: string, arg: Token | null}} FilterNode
 * @typedef {{secret: boolean, seg: Token}} KeySegmentNode
 * @typedef {{name: string, iterable: ValueNode | null}} BindingNode
 *
 * @typedef {{kind: 'disabled', statement: StatementNode, offset: number}
 *   | {kind: 'guarded', name: string, statement: StatementNode, offset: number}
 *   | {kind: 'varDecl', private: boolean, name: string, value: ValueNode, offset: number}
 *   | {kind: 'for', bindings: BindingNode[], template: KeySegmentNode[] | null, dest: KeySegmentNode[], body: StatementNode[], offset: number}
 *   | {kind: 'import', path: Token, offset: number}
 *   | {kind: 'assign', sigil: '~' | '+' | '-' | null, path: KeySegmentNode[], rhs: {kind: 'block', statements: StatementNode[]} | ValueNode, offset: number}
 *   | {kind: 'delete', path: KeySegmentNode[], offset: number}} StatementNode
 *
 * @typedef {{versionKeyword: Token, version: string, statements: StatementNode[]}} FileNode
 */

/** Token types that are a complete value on their own (`value`'s scalar alternatives). */
const SCALAR_TOKENS = new Set([
  'NIL_KW', 'TRUE_KW', 'FALSE_KW', 'INF_KW',
  'DATETIME', 'DATE', 'TIME', 'IPV6', 'IPV4', 'DURATION', 'BYTES',
  'FLOAT', 'INTEGER',
  'TRIPLE_STRING', 'DQ_STRING', 'SQ_STRING',
  'RESOLVER_REF_RAW',
]);

/** Human-readable names for the "expected ..." part of a parse error. */
/** @type {Record<string, string>} */
const DESCRIPTIONS = {
  IDENT: 'an identifier',
  DQ_STRING: 'a double-quoted string',
  SQ_STRING: 'a single-quoted string',
  INTEGER: 'an integer',
  FLOAT: 'a number',
  value: 'a value',
};

class Parser {
  /**
   * @param {string} src
   * @param {Token[]} tokens
   * @param {string | undefined} file
   */
  constructor(src, tokens, file) {
    this.src = src;
    this.tokens = tokens;
    this.fileName = file;
    this.pos = 0;
    /** Furthest token index any alternative failed at, and what it wanted there. */
    this.failPos = -1;
    /** @type {Set<string>} */
    this.failExpected = new Set();
  }

  /** @returns {Token | undefined} */
  peek() {
    return this.tokens[this.pos];
  }


  /** @param {string} what */
  fail(what) {
    if (this.pos > this.failPos) {
      this.failPos = this.pos;
      this.failExpected = new Set([what]);
    } else if (this.pos === this.failPos) {
      this.failExpected.add(what);
    }
    return null;
  }

  /**
   * Consumes a token of `type`, or records the failure.
   * @param {string} type
   * @returns {Token | null}
   */
  accept(type) {
    const token = this.tokens[this.pos];
    if (token && token.type === type) {
      this.pos++;
      return token;
    }
    return this.fail(DESCRIPTIONS[type] ?? JSON.stringify(type));
  }

  /**
   * Consumes an `IDENT` whose text is exactly `keyword` -- a contextual
   * keyword (CASC.md §4.1).
   * @param {string} keyword
   * @returns {Token | null}
   */
  keyword(keyword) {
    const token = this.tokens[this.pos];
    if (token && token.type === 'IDENT' && token.text === keyword) {
      this.pos++;
      return token;
    }
    return this.fail(JSON.stringify(keyword));
  }

  /**
   * Runs `rule`; on failure rewinds to where it started (PEG ordered-choice
   * backtracking).
   * @template T
   * @param {() => T | null} rule
   * @returns {T | null}
   */
  attempt(rule) {
    const start = this.pos;
    const result = rule();
    if (result === null) this.pos = start;
    return result;
  }

  /**
   * Tries `rules` in order, returning the first success.
   * @template T
   * @param {Array<() => T | null>} rules
   * @returns {T | null}
   */
  choice(rules) {
    for (const rule of rules) {
      const result = this.attempt(rule);
      if (result !== null) return result;
    }
    return null;
  }

  // ---- file := version_header statement* --------------------------------

  /** @returns {FileNode} */
  file() {
    const header = this.attempt(() => this.versionHeader());
    if (header === null) this.raise();
    /** @type {StatementNode[]} */
    const statements = [];
    for (;;) {
      const statement = this.attempt(() => this.statement());
      if (statement === null) break;
      statements.push(statement);
    }
    if (this.pos < this.tokens.length) {
      this.fail('a statement');
      this.raise();
    }
    return { versionKeyword: header.keyword, version: header.version, statements };
  }

  /**
   * `"#" "@" IDENT "="? version_number`. The identifier is checked against
   * `version` by the evaluator, not here, so that a misspelled header gets
   * a precise message.
   * @returns {{keyword: Token, version: string} | null}
   */
  versionHeader() {
    if (!this.accept('#') || !this.accept('@')) return null;
    const keyword = this.accept('IDENT');
    if (!keyword) return null;
    this.attempt(() => this.accept('='));
    // The lexer folds "1.0" of "1.0.0" into one FLOAT, so the head is
    // either token and the rest are `"." INTEGER` pairs, joined back up.
    const head = this.choice([() => this.accept('FLOAT'), () => this.accept('INTEGER')]);
    if (!head) return null;
    let version = head.text;
    for (;;) {
      const part = this.attempt(() => (this.accept('.') ? this.accept('INTEGER') : null));
      if (!part) break;
      version += `.${part.text}`;
    }
    return { keyword, version };
  }

  // ---- statements ---------------------------------------------------------

  /** @returns {StatementNode | null} */
  statement() {
    const offset = this.peek()?.offset ?? this.src.length;
    return this.choice([
      () => {
        if (!this.accept('#')) return null;
        const statement = this.realStatement();
        return statement && { kind: 'disabled', statement, offset };
      },
      () => {
        if (!this.accept('${?')) return null;
        const name = this.accept('IDENT');
        if (!name || !this.accept('}')) return null;
        const statement = this.realStatement();
        return statement && { kind: 'guarded', name: name.text, statement, offset };
      },
      () => this.realStatement(),
    ]);
  }

  /** @returns {StatementNode | null} */
  realStatement() {
    return this.choice([
      () => this.varDecl(),
      () => this.forStatement(),
      () => this.importStatement(),
      () => this.followedDelete(),
      () => this.sigilKvStatement(),
      () => this.deleteStatement(),
    ]);
  }

  /** @returns {StatementNode | null} */
  varDecl() {
    const offset = this.peek()?.offset ?? 0;
    if (!this.accept('@')) return null;
    const isPrivate = this.attempt(() => this.accept('*')) !== null;
    const name = this.accept('IDENT');
    if (!name) return null;
    this.attempt(() => this.accept('='));
    const value = this.value();
    return value && { kind: 'varDecl', private: isPrivate, name: name.text, value, offset };
  }

  /**
   * `for <binding>[, <binding>]* [from <template>] as <dest> { <body> }`
   * (CASC.md §5.5). The `from` form is tried whole before the plain one,
   * as an ordered choice of two complete alternatives.
   * @returns {StatementNode | null}
   */
  forStatement() {
    const offset = this.peek()?.offset ?? 0;
    if (!this.keyword('for')) return null;
    const first = this.binding();
    if (!first) return null;
    const bindings = [first];
    for (;;) {
      const next = this.attempt(() => (this.accept(',') ? this.binding() : null));
      if (!next) break;
      bindings.push(next);
    }
    /** @typedef {{template: KeySegmentNode[] | null, dest: KeySegmentNode[]}} LoopClause */
    const clause = this.choice(/** @type {Array<() => LoopClause | null>} */ ([
      () => {
        if (!this.keyword('from')) return null;
        const template = this.keyPath();
        if (!template || !this.keyword('as')) return null;
        const dest = this.keyPath();
        return dest && { template, dest };
      },
      () => {
        if (!this.keyword('as')) return null;
        const dest = this.keyPath();
        return dest && { template: null, dest };
      },
    ]));
    if (!clause) return null;
    const body = this.block();
    return body && { kind: 'for', bindings, template: clause.template, dest: clause.dest, body, offset };
  }

  /**
   * `@name` (index) or `@name in <iterable>` (element). The iterable
   * excludes bare atoms, exactly as in the reference grammar.
   * @returns {BindingNode | null}
   */
  binding() {
    if (!this.accept('@')) return null;
    const name = this.accept('IDENT');
    if (!name) return null;
    const iterable = this.attempt(() => (this.keyword('in') ? this.value({ allowAtom: false }) : null));
    return { name: name.text, iterable };
  }

  /** @returns {StatementNode | null} */
  importStatement() {
    const offset = this.peek()?.offset ?? 0;
    if (!this.keyword('import')) return null;
    const path = this.choice([() => this.accept('DQ_STRING'), () => this.accept('SQ_STRING')]);
    return path && { kind: 'import', path, offset };
  }

  /** @returns {StatementNode | null} */
  sigilKvStatement() {
    const offset = this.peek()?.offset ?? 0;
    const sigilToken = this.choice([() => this.accept('~'), () => this.accept('+'), () => this.accept('-')]);
    const sigil = /** @type {'~' | '+' | '-' | null} */ (sigilToken ? sigilToken.type : null);
    const path = this.keyPath();
    if (!path) return null;
    this.attempt(() => this.accept('='));
    /** @typedef {{kind: 'block', statements: StatementNode[]} | ValueNode} Rhs */
    const rhs = this.choice(/** @type {Array<() => Rhs | null>} */ ([
      () => {
        const statements = this.block();
        return statements && { kind: 'block', statements };
      },
      () => this.value(),
    ]));
    return rhs && { kind: 'assign', sigil, path, rhs, offset };
  }

  /**
   * `followed_delete := delete_statement &statement` -- CASC.md §5.7: a bare
   * `-key.path` followed by another complete statement is always the
   * delete, never the remove `-key.path = <that statement's key>`. Tried
   * before the sigil form; anything else (`-tags = [...]`, `-tags ["b"]`, a
   * trailing `-a.b` before `}` or end of input) falls through as before.
   * @returns {StatementNode | null}
   */
  followedDelete() {
    const statement = this.deleteStatement();
    if (!statement) return null;
    const after = this.pos;
    const next = this.attempt(() => this.statement());
    this.pos = after;
    return next ? statement : null;
  }

  /** @returns {StatementNode | null} */
  deleteStatement() {
    const offset = this.peek()?.offset ?? 0;
    if (!this.accept('-')) return null;
    const path = this.keyPath();
    return path && { kind: 'delete', path, offset };
  }

  /**
   * `"{" (statement ","?)* "}"` -- a trailing comma after a statement is
   * tolerated (CASC.md §8.4's own example uses one).
   * @returns {StatementNode[] | null}
   */
  block() {
    if (!this.accept('{')) return null;
    /** @type {StatementNode[]} */
    const statements = [];
    for (;;) {
      const statement = this.attempt(() => this.statement());
      if (!statement) break;
      statements.push(statement);
      this.attempt(() => this.accept(','));
    }
    return this.accept('}') ? statements : null;
  }

  /** @returns {KeySegmentNode[] | null} */
  keyPath() {
    const first = this.keySegment();
    if (!first) return null;
    const segments = [first];
    for (;;) {
      const next = this.attempt(() => (this.accept('.') ? this.keySegment() : null));
      if (!next) break;
      segments.push(next);
    }
    return segments;
  }

  /** @returns {KeySegmentNode | null} */
  keySegment() {
    const secret = this.attempt(() => this.accept('*')) !== null;
    const seg = this.choice([() => this.accept('IDENT'), () => this.accept('DQ_STRING'), () => this.accept('SQ_STRING')]);
    return seg && { secret, seg };
  }

  // ---- values -------------------------------------------------------------

  /**
   * @param {{allowAtom?: boolean}} [opts]
   * @returns {ValueNode | null}
   */
  value(opts = {}) {
    const token = this.peek();
    if (token && SCALAR_TOKENS.has(token.type)) {
      this.pos++;
      return { kind: 'token', token };
    }
    const result = this.choice([
      () => this.sequence('[', ']', 'list'),
      () => this.sequence('(', ')', 'tuple'),
      () => this.atRef(),
      () => this.envRef(),
      () => this.configRef(),
      () => this.taggedRef(),
      ...(opts.allowAtom === false ? [] : [() => this.atomValue()]),
    ]);
    return result ?? this.fail('value');
  }

  /**
   * `list`/`tuple`: comma, newline, or bare whitespace separate elements.
   * @param {string} open
   * @param {string} close
   * @param {'list' | 'tuple'} kind
   * @returns {ValueNode | null}
   */
  sequence(open, close, kind) {
    if (!this.accept(open)) return null;
    /** @type {ElementNode[]} */
    const items = [];
    for (;;) {
      const item = this.attempt(() => this.element());
      if (!item) break;
      items.push(item);
      this.attempt(() => this.accept(','));
    }
    return this.accept(close) ? { kind, items } : null;
  }

  /**
   * `element := block | value` -- a list or tuple element may be a block,
   * which is a map (CASC.md §6.10). Only a value once was, so a list of
   * maps (`[{ path = "^/admin" }]`, the shape framework configuration is
   * full of) could not be written at all.
   * @returns {ElementNode | null}
   */
  element() {
    return this.choice(/** @type {Array<() => ElementNode | null>} */ ([
      () => {
        const statements = this.block();
        return statements && { kind: 'block', statements };
      },
      () => this.value(),
    ]));
  }

  /** `ref_name := IDENT | DQ_STRING` -- a name may be built by interpolation (CASC.md §7.2). */
  refName() {
    const token = this.choice([() => this.accept('IDENT'), () => this.accept('DQ_STRING')]);
    return token && /** @type {ValueNode} */ ({ kind: 'token', token });
  }

  /** @returns {ValueNode | null} */
  atRef() {
    if (!this.accept('@{')) return null;
    const name = this.refName();
    if (!name) return null;
    const index = this.attempt(() => this.indexSuffix());
    const suffix = this.attempt(() => this.refSuffix());
    const filters = this.attempt(() => this.filters()) ?? [];
    return this.accept('}') ? { kind: 'atRef', name, index, suffix, filters } : null;
  }

  /** @returns {ValueNode | null} */
  envRef() {
    if (!this.accept('${')) return null;
    const name = this.refName();
    if (!name) return null;
    const bracket = this.attempt(() => {
      if (!this.accept('[')) return null;
      const index = this.attempt(() => this.accept('INTEGER'));
      return this.accept(']') ? { index } : null;
    });
    const suffix = this.attempt(() => this.refSuffix());
    const filters = this.attempt(() => this.filters()) ?? [];
    return this.accept('}') ? { kind: 'envRef', name, bracket, suffix, filters } : null;
  }

  /** @returns {ValueNode | null} */
  configRef() {
    if (!this.accept('%{')) return null;
    const path = this.keyPath();
    if (!path) return null;
    const index = this.attempt(() => this.indexSuffix());
    const suffix = this.attempt(() => this.refSuffix());
    const filters = this.attempt(() => this.filters()) ?? [];
    return this.accept('}') ? { kind: 'configRef', path, index, suffix, filters } : null;
  }

  /** @returns {ValueNode | null} */
  taggedRef() {
    if (!this.accept('!')) return null;
    const name = this.accept('IDENT');
    if (!name || !this.accept('(')) return null;
    const arg = this.value();
    return arg && this.accept(')') ? { kind: 'tagged', name: name.text, arg } : null;
  }

  /** @returns {Token | null} */
  indexSuffix() {
    if (!this.accept('[')) return null;
    const index = this.accept('INTEGER');
    return index && this.accept(']') ? index : null;
  }

  /**
   * `(":" "?" DQ_STRING) | (":" "+" value) | (":" value)` -- shared by all
   * three reference forms (CASC.md §7.2). `?`/`+` are tried first, so a
   * default can't shadow them.
   * @returns {SuffixNode | null}
   */
  refSuffix() {
    return this.choice([
      () => {
        if (!this.accept(':') || !this.accept('?')) return null;
        const message = this.accept('DQ_STRING');
        return message && /** @type {SuffixNode} */ ({ kind: 'required', message });
      },
      () => {
        if (!this.accept(':') || !this.accept('+')) return null;
        const value = this.value();
        return value && /** @type {SuffixNode} */ ({ kind: 'substitute', value });
      },
      // The lexer folds `:+5` into `:` INTEGER("+5"), which would read as a
      // *default* of 5 -- the opposite of what `:+alt` means. A `+`-signed
      // number directly after `:` is the substitute form, with the sign
      // dropped, the same reading the interpolated-string form gets.
      () => {
        if (!this.accept(':')) return null;
        const token = this.peek();
        if (!token || !['INTEGER', 'FLOAT', 'INF_KW'].includes(token.type) || !token.text.startsWith('+')) {
          return this.fail('value');
        }
        this.pos++;
        const unsigned = { ...token, text: token.text.slice(1), offset: token.offset + 1 };
        return /** @type {SuffixNode} */ ({ kind: 'substitute', value: { kind: 'token', token: unsigned } });
      },
      () => {
        if (!this.accept(':')) return null;
        const value = this.value();
        return value && /** @type {SuffixNode} */ ({ kind: 'default', value });
      },
    ]);
  }

  /** @returns {FilterNode[] | null} */
  filters() {
    /** @type {FilterNode[]} */
    const filters = [];
    for (;;) {
      const filter = this.attempt(() => {
        if (!this.accept('|')) return null;
        const name = this.accept('IDENT');
        if (!name) return null;
        const arg = this.attempt(() =>
          this.accept(':') ? this.choice([() => this.accept('DQ_STRING'), () => this.accept('SQ_STRING')]) : null
        );
        return { name: name.text, arg };
      });
      if (!filter) break;
      filters.push(filter);
    }
    return filters.length > 0 ? filters : null;
  }

  /**
   * A bare identifier (`level = info`) or a `:`-sigiled one (`:info`, and
   * `:true`/`:nil`/`:inf` to reach an atom named after a reserved word,
   * CASC.md §6.4).
   * @returns {ValueNode | null}
   */
  atomValue() {
    return this.choice([
      () => {
        if (!this.accept(':')) return null;
        const word = this.choice(['IDENT', 'NIL_KW', 'TRUE_KW', 'FALSE_KW', 'INF_KW'].map((t) => () => this.accept(t)));
        return word && /** @type {ValueNode} */ ({ kind: 'atom', text: word.text });
      },
      () => {
        const ident = this.accept('IDENT');
        return ident && /** @type {ValueNode} */ ({ kind: 'atom', text: ident.text });
      },
    ]);
  }

  /** @returns {never} */
  raise() {
    // A failure past the last token is a failure at end of input.
    const at = this.failPos >= 0 ? this.failPos : this.pos;
    const token = this.tokens[at];
    const offset = token ? token.offset : this.src.length;
    const { line, column } = position(this.src, offset);
    const found = token ? JSON.stringify(token.text) : 'end of input';
    const expected = [...this.failExpected].sort().join(', ');
    throw new CooperError(
      `unexpected ${found} at line ${line}, column ${column}${expected ? ` -- expected ${expected}` : ''}`,
      { stage: 'parser', file: this.fileName, line, column, offset }
    );
  }
}

/**
 * Tokenizes and parses a whole CASC source into its AST.
 * @param {string} src
 * @param {{file?: string}} [opts]
 * @returns {FileNode}
 * @throws {CooperError} stage `lexer` or `parser`
 */
function parse(src, opts = {}) {
  const tokens = tokenize(src, opts);
  return new Parser(src, tokens, opts.file).file();
}

module.exports = { parse };
