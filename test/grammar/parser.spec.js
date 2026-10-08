import { createRequire } from 'node:module';
import { expect } from 'chai';
import fc from 'fast-check';
import { CooperError } from '../../src/cooper.js';

const require = createRequire(import.meta.url);
const { parse } = require('../../src/grammar/parser.cjs');

/**
 * The AST without source positions, so tests compare structure only.
 * @param {unknown} node
 * @returns {any}
 */
function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (node === null || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([k]) => k !== 'offset' && k !== 'line')
      .map(([k, v]) => [k, strip(v)])
  );
}

/** @param {string} body */
const statements = (body) => strip(parse(`#@version = 1.0\n${body}`).statements);
/** @param {string} literal */
const rhs = (literal) => statements(`v = ${literal}`)[0].rhs;

/** @param {string} src */
function parseError(src) {
  try {
    parse(src);
  } catch (err) {
    if (err instanceof CooperError) return err;
    throw err;
  }
  throw new Error(`expected ${JSON.stringify(src)} to fail to parse`);
}

const tok = (/** @type {string} */ type, /** @type {string} */ text) => ({ kind: 'token', token: { type, text } });
const seg = (/** @type {string} */ text, secret = false, type = 'IDENT') => ({ secret, seg: { type, text } });

describe('parser: version header (CASC.md §2)', () => {
  it('the minimal valid file has no statements (CASC.md §10)', () => {
    const ast = strip(parse('#@version = 1.0'));
    expect(ast).to.deep.equal({ versionKeyword: { type: 'IDENT', text: 'version' }, version: '1.0', statements: [] });
  });

  it('accepts the operator-optional form', () => {
    expect(parse('#@version 1.0').version).to.equal('1.0');
  });

  it('accepts bare, dotted, and triple-dotted versions', () => {
    for (const v of ['1', '1.0', '2.1.3']) expect(parse(`#@version = ${v}`).version, v).to.equal(v);
  });

  it('leaves the header keyword to the evaluator, so a misspelling still parses', () => {
    expect(parse('#@versio = 1.0').versionKeyword.text).to.equal('versio');
  });

  it('an empty source is a parse error at line 1, column 1', () => {
    expect(parseError('')).to.include({ stage: 'parser', line: 1, column: 1 });
  });

  it('a first statement that is not the header is a parse error', () => {
    expect(parseError('foo = 1\n#@version = 1.0\n')).to.include({ stage: 'parser', line: 1, column: 1 });
  });

  it('a comment may precede the header (conformance case 916)', () => {
    expect(parse('# leading comment\n\n#@version = 1.0\nkey = 1').statements).to.have.length(1);
  });
});

describe('parser: assignments (CASC.md §5.3)', () => {
  it('with and without the optional =', () => {
    const expected = [{ kind: 'assign', sigil: null, path: [seg('foo')], rhs: tok('DQ_STRING', '"bar"') }];
    expect(statements('foo = "bar"')).to.deep.equal(expected);
    expect(statements('foo "bar"'), 'conformance case 900').to.deep.equal(expected);
  });

  it('without =, the value may start on the next line -- statements are not newline-terminated', () => {
    expect(statements('foo\n"bar"')[0]).to.include({ kind: 'assign' });
  });

  it('a block may open on the next line', () => {
    expect(statements('server\n{ port = 1 }')[0].rhs.kind).to.equal('block');
  });

  it('for/in/from/as/import are ordinary keys outside their statements (CASC.md §4.1)', () => {
    const parsed = statements('for = 1\nin = 2\nfrom = 3\nas = 4\nimport = 5');
    expect(parsed.map((/** @type {any} */ s) => [s.kind, s.path[0].seg.text])).to.deep.equal([
      ['assign', 'for'],
      ['assign', 'in'],
      ['assign', 'from'],
      ['assign', 'as'],
      ['assign', 'import'],
    ]);
  });
});

describe('parser: key paths and blocks (CASC.md §4.2, §5.4)', () => {
  it('a dotted path keeps one segment per part', () => {
    expect(statements('foo.bar.baz "dronf"')[0].path).to.deep.equal([seg('foo'), seg('bar'), seg('baz')]);
  });

  it('quoted segments, double and single', () => {
    expect(statements(`foo."bar baz".'q' = 1`)[0].path).to.deep.equal([
      seg('foo'),
      seg('"bar baz"', false, 'DQ_STRING'),
      seg("'q'", false, 'SQ_STRING'),
    ]);
  });

  it('a nested block, with an explicit = and with trailing commas', () => {
    const [stmt] = statements('foo = { bar = 1, baz = 2, }');
    expect(stmt.rhs.kind).to.equal('block');
    expect(stmt.rhs.statements.map((/** @type {any} */ s) => s.path[0].seg.text)).to.deep.equal(['bar', 'baz']);
  });

  it('an unclosed block is a parse error', () => {
    expect(parseError('#@version = 1.0\nfoo { bar = 1').stage).to.equal('parser');
  });
});

describe('parser: secret markers (CASC.md §4.3)', () => {
  it('a plain key is not secret', () => {
    expect(statements('foo = 1')[0].path).to.deep.equal([seg('foo')]);
  });

  it('a *-prefixed key is secret', () => {
    expect(statements('*bar = 2')[0].path).to.deep.equal([seg('bar', true)]);
  });

  it('the marker sits on the segment it prefixes', () => {
    expect(statements('db.*password = "x"')[0].path).to.deep.equal([seg('db'), seg('password', true)]);
    expect(statements('*db.password = "x"')[0].path).to.deep.equal([seg('db', true), seg('password')]);
  });
});

describe('parser: variable declarations (CASC.md §5.2)', () => {
  it('a plain declaration is public, with or without =', () => {
    const expected = [{ kind: 'varDecl', private: false, name: 'x', value: tok('INTEGER', '1') }];
    expect(statements('@x = 1')).to.deep.equal(expected);
    expect(statements('@x 1')).to.deep.equal(expected);
  });

  it('a @*-prefixed declaration is private', () => {
    expect(statements('@*x = 1')).to.deep.equal([{ kind: 'varDecl', private: true, name: 'x', value: tok('INTEGER', '1') }]);
  });
});

describe('parser: merge control sigils (CASC.md §5.7)', () => {
  it('no sigil', () => {
    expect(statements('port = 9090')[0].sigil).to.equal(null);
  });

  it('~ replace, on a block', () => {
    const [stmt] = statements('~server { host = "0.0.0.0", port = 9090 }');
    expect(stmt).to.include({ kind: 'assign', sigil: '~' });
    expect(stmt.rhs.statements).to.have.length(2);
  });

  it('+ append and - remove, with a value', () => {
    expect(statements('+tags = ["d"]')[0]).to.include({ kind: 'assign', sigil: '+' });
    expect(statements('-tags = ["b"]')[0]).to.include({ kind: 'assign', sigil: '-' });
  });

  it('- with no value is a delete', () => {
    expect(statements('-feature.legacy_mode')).to.deep.equal([{ kind: 'delete', path: [seg('feature'), seg('legacy_mode')] }]);
  });

  it('a bare delete followed by a complete statement stays a delete (CASC.md §5.7)', () => {
    expect(statements('-a.b\nc = 1').map((/** @type {any} */ s) => s.kind)).to.deep.equal(['delete', 'assign']);
  });

  it('a bare - whose next word is not a statement takes it as the remove value (CASC.md §5.7)', () => {
    expect(statements('-tags\nb')[0]).to.include({ kind: 'assign', sigil: '-' });
  });

  it('-tags b followed by a statement reads as a delete, then `b c` (the documented ambiguity)', () => {
    expect(statements('-tags b c').map((/** @type {any} */ s) => s.kind)).to.deep.equal(['delete', 'assign']);
  });

  it('~* combined: replace AND secret, in the fixed order', () => {
    const [stmt] = statements('~*database { host = "db.internal" }');
    expect(stmt.sigil).to.equal('~');
    expect(stmt.path).to.deep.equal([seg('database', true)]);
  });

  it('the full §8.4 worked example parses to one statement per line', () => {
    const parsed = statements('~server { port = 9090 }\n+tags = ["d"]\n-tags = ["b"]\n-feature.legacy_mode');
    expect(parsed.map((/** @type {any} */ s) => [s.kind, s.sigil ?? null])).to.deep.equal([
      ['assign', '~'],
      ['assign', '+'],
      ['assign', '-'],
      ['delete', null],
    ]);
  });
});

describe('parser: disabled statements and comments (CASC.md §3.2, §5.6)', () => {
  it('#key = 1 is a disabled assignment', () => {
    expect(statements('#ignored = 1')).to.deep.equal([
      { kind: 'disabled', statement: { kind: 'assign', sigil: null, path: [seg('ignored')], rhs: tok('INTEGER', '1') } },
    ]);
  });

  it('#*key { ... } is a disabled secret block statement', () => {
    const [stmt] = statements('#*sub { remove = yes }');
    expect(stmt.kind).to.equal('disabled');
    expect(stmt.statement.path).to.deep.equal([seg('sub', true)]);
  });

  it('#@name = 1 is a disabled variable declaration', () => {
    expect(statements('#@x = 1')[0]).to.deep.include({ kind: 'disabled' });
    expect(statements('#@x = 1')[0].statement.kind).to.equal('varDecl');
  });

  it('a comment with a following space is ignored', () => {
    expect(statements('# a comment\nfoo = 1')).to.have.length(1);
  });

  it('#TODO fix this is a disabled-statement attempt that fails to parse', () => {
    expect(parseError('#@version = 1.0\n#TODO fix this\n').stage).to.equal('parser');
  });
});

describe('parser: guards, imports, loops', () => {
  it('${?NAME} guards exactly the next statement (CASC.md §7.2)', () => {
    const parsed = statements('${?FEATURE_FLAG}\nenabled = true\nkept = 1');
    expect(parsed).to.have.length(2);
    expect(parsed[0]).to.deep.include({ kind: 'guarded', name: 'FEATURE_FLAG' });
    expect(parsed[0].statement.path).to.deep.equal([seg('enabled')]);
  });

  it('import takes a double- or single-quoted path (CASC.md §5.1)', () => {
    expect(statements('import "a.casc"')).to.deep.equal([{ kind: 'import', path: { type: 'DQ_STRING', text: '"a.casc"' } }]);
    expect(statements("import 'a.casc'")[0].kind).to.equal('import');
  });

  it('for with index and element bindings, template, and destination (CASC.md §5.5)', () => {
    const [stmt] = statements('for @i, @x in [1] from t as out { a = 1 }');
    expect(stmt.kind).to.equal('for');
    expect(stmt.bindings.map((/** @type {any} */ b) => [b.name, b.iterable === null])).to.deep.equal([
      ['i', true],
      ['x', false],
    ]);
    expect(stmt.template).to.deep.equal([seg('t')]);
    expect(stmt.dest).to.deep.equal([seg('out')]);
    expect(stmt.body).to.have.length(1);
  });
});

describe('parser: values (CASC.md §6)', () => {
  it('scalars are single tokens', () => {
    expect(rhs('nil')).to.deep.equal(tok('NIL_KW', 'nil'));
    expect(rhs('-inf')).to.deep.equal(tok('INF_KW', '-inf'));
    expect(rhs('0xFF')).to.deep.equal(tok('INTEGER', '0xFF'));
    expect(rhs('1h30m')).to.deep.equal(tok('DURATION', '1h30m'));
    expect(rhs('!{vault:a:b}')).to.deep.equal(tok('RESOLVER_REF_RAW', '!{vault:a:b}'));
  });

  it('a bare identifier and a :-sigiled one are atoms, the colon reaching reserved words', () => {
    expect(rhs('info')).to.deep.equal({ kind: 'atom', text: 'info' });
    expect(rhs(':info')).to.deep.equal({ kind: 'atom', text: 'info' });
    for (const word of ['true', 'false', 'nil', 'inf']) expect(rhs(`:${word}`), word).to.deep.equal({ kind: 'atom', text: word });
  });

  it('lists and tuples, with comma, newline, or whitespace separators', () => {
    const items = [tok('INTEGER', '1'), tok('INTEGER', '2')];
    for (const literal of ['[1, 2]', '[1 2]', '[\n  1\n  2\n]', '[1, 2,]']) expect(rhs(literal), literal).to.deep.equal({ kind: 'list', items });
    expect(rhs('(1, 2)')).to.deep.equal({ kind: 'tuple', items });
    expect(rhs('()')).to.deep.equal({ kind: 'tuple', items: [] });
  });

  it('a variable reference with index and default (CASC.md §7.1)', () => {
    expect(rhs('@{name[2]:0}')).to.deep.equal({
      kind: 'atRef',
      name: tok('IDENT', 'name'),
      index: { type: 'INTEGER', text: '2' },
      suffix: { kind: 'default', value: tok('INTEGER', '0') },
      filters: [],
    });
  });

  it('suffix forms: required, substitute, default (CASC.md §7.2)', () => {
    expect(rhs('${T:?"missing token"}').suffix).to.deep.equal({ kind: 'required', message: { type: 'DQ_STRING', text: '"missing token"' } });
    expect(rhs('${F:+on}').suffix).to.deep.equal({ kind: 'substitute', value: { kind: 'atom', text: 'on' } });
    expect(rhs('${N:3}').suffix).to.deep.equal({ kind: 'default', value: tok('INTEGER', '3') });
    expect(rhs('${N:-5}').suffix).to.deep.equal({ kind: 'default', value: tok('INTEGER', '-5') });
  });

  it('a +-signed number after : is the substitute form, sign dropped (conformance case 910)', () => {
    expect(rhs('${PORT:+1}').suffix).to.deep.equal({ kind: 'substitute', value: tok('INTEGER', '1') });
  });

  it('an env reference in list form and indexed form', () => {
    expect(rhs('${ALLOWED_HOSTS[]:["localhost"]}')).to.deep.include({ kind: 'envRef', bracket: { index: null } });
    expect(rhs('${HOSTS[0]:default}').bracket).to.deep.equal({ index: { type: 'INTEGER', text: '0' } });
    expect(rhs('${REGION}').bracket).to.equal(null);
  });

  it('a config reference keeps its key path, quoted segments included, plus filters (CASC.md §7.3)', () => {
    const ref = rhs('%{a."b c".d | upcase | default: "x"}');
    expect(ref.kind).to.equal('configRef');
    expect(ref.path).to.deep.equal([seg('a'), seg('"b c"', false, 'DQ_STRING'), seg('d')]);
    expect(ref.filters).to.deep.equal([
      { name: 'upcase', arg: null },
      { name: 'default', arg: { type: 'DQ_STRING', text: '"x"' } },
    ]);
  });

  it('a tagged value wraps any value, references included (CASC.md §7.5)', () => {
    expect(rhs('!duration("5m")')).to.deep.equal({ kind: 'tagged', name: 'duration', arg: tok('DQ_STRING', '"5m"') });
    expect(rhs('!int(${PORT:8080})')).to.deep.include({ kind: 'tagged', name: 'int' });
    expect(rhs('!int(${PORT:8080})').arg.kind).to.equal('envRef');
  });

  it('a missing value is a parse error at the next token', () => {
    expect(parseError('#@version = 1.0\nfoo = \n= 1')).to.include({ stage: 'parser', line: 3, column: 1, offset: 23 });
  });

  it('a lexer failure surfaces as a lexer-stage error', () => {
    expect(parseError('#@version = 1.0\nv = ^').stage).to.equal('lexer');
  });

  it('the error message names what was found and where', () => {
    expect(parseError('#@version = 1.0\nfoo = ]').message).to.match(/unexpected "\]" at line 2, column 7/);
  });

  it('a value missing at the very end of the source is reported at end of input', () => {
    const src = '#@version = 1.0\nfoo = ';
    const err = parseError(src);
    expect(err.message).to.match(/unexpected end of input/);
    expect(err).to.include({ stage: 'parser', line: 2, column: 7, offset: src.length });
  });
});

describe('parser properties', () => {
  const cascChars = fc.constantFrom(...'#@{}$%!()[]:=,.+-*~?|"\' \n\tabcfinortu0123456789_'.split(''));
  const body = fc.oneof(fc.string({ maxLength: 60 }), fc.stringOf(cascChars, { maxLength: 60 }));

  it('never throws anything but a lexer- or parser-stage CooperError', () => {
    fc.assert(
      fc.property(body, (src) => {
        try {
          parse(`#@version = 1.0\n${src}`);
        } catch (err) {
          if (!(err instanceof CooperError)) throw err;
          expect(['lexer', 'parser']).to.include(err.stage);
          expect(err.line).to.be.a('number');
          expect(err.column).to.be.a('number');
          expect(err.offset).to.be.a('number');
        }
      }),
      { numRuns: 2000 }
    );
  });

  it('any key = integer statement list parses to that many assignments', () => {
    const key = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/).filter((k) => !['nil', 'true', 'false', 'inf', 'for', 'import'].includes(k));
    fc.assert(
      fc.property(fc.array(fc.tuple(key, fc.integer()), { maxLength: 10 }), (pairs) => {
        const parsed = statements(pairs.map(([k, n]) => `${k} = ${n}`).join('\n'));
        expect(parsed.map((/** @type {any} */ s) => [s.path[0].seg.text, Number(s.rhs.token.text)])).to.deep.equal(pairs);
      })
    );
  });
});
