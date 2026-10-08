import { createRequire } from 'node:module';
import { expect } from 'chai';
import fc from 'fast-check';
import { CooperError } from '../../src/cooper.js';

const require = createRequire(import.meta.url);
const { tokenize, position } = require('../../src/grammar/lexer.cjs');

/** @param {string} src */
const types = (src) => tokenize(src).map((/** @type {{type: string}} */ t) => t.type);
/** @param {string} src */
const texts = (src) => tokenize(src).map((/** @type {{text: string}} */ t) => t.text);
/** @param {string} src */
const single = (src) => {
  const tokens = tokenize(src);
  expect(tokens, JSON.stringify(src)).to.have.length(1);
  return tokens[0].type;
};

/** Characters CASC actually uses, so random input hits real token boundaries. */
const cascChars = fc.constantFrom(...'#@{}$%!()[]:=,.+-*~?|"\'\\ \n\tabcdefinlrstuxo0123456789_eEµTZ/'.split(''));
const cascLike = fc.oneof(fc.string({ maxLength: 60 }), fc.stringOf(cascChars, { maxLength: 60 }), fc.fullUnicodeString({ maxLength: 30 }));

describe('lexer: scalar token types', () => {
  it('reserved words', () => {
    expect(single('nil')).to.equal('NIL_KW');
    expect(single('true')).to.equal('TRUE_KW');
    expect(single('false')).to.equal('FALSE_KW');
    for (const inf of ['inf', '+inf', '-inf']) expect(single(inf), inf).to.equal('INF_KW');
  });

  it('numbers (CASC.md §6.3)', () => {
    for (const int of ['0', '-17', '+99', '1_000_000', '0xDEAD_BEEF', '0o755', '0b11010110']) expect(single(int), int).to.equal('INTEGER');
    for (const float of ['3.1415', '-0.01', '5e+22', '-2E-2', '1_000.5', '1e3']) expect(single(float), float).to.equal('FLOAT');
  });

  it('dates and times (CASC.md §6.6)', () => {
    expect(single('1979-05-27')).to.equal('DATE');
    expect(single('07:32:00')).to.equal('TIME');
    expect(single('07:32:00.999')).to.equal('TIME');
    for (const dt of ['1979-05-27T07:32:00', '1979-05-27T07:32:00Z', '1979-05-27T07:32:00.5+02:00', '1979-05-27T07:32:00-07:00']) {
      expect(single(dt), dt).to.equal('DATETIME');
    }
  });

  it('IP addresses (CASC.md §6.7)', () => {
    for (const v4 of ['127.0.0.1', '10.0.0.0/8', '999.999.999.999']) expect(single(v4), v4).to.equal('IPV4');
    for (const v6 of ['::1', '::', '::1/128', 'fe80::', '2001:db8::1', '1:2:3:4:5:6:7:8', 'FE80::ABCD/10']) expect(single(v6), v6).to.equal('IPV6');
  });

  it('durations, any unit, compound or fractional (CASC.md §6.8)', () => {
    for (const d of ['500ms', '1ns', '1us', '1µs', '1s', '1m', '1h', '1d', '1h30m', '1.5h', '1_000ms', '30m1h']) expect(single(d), d).to.equal('DURATION');
  });

  it('byte sizes, case-insensitively (CASC.md §6.9)', () => {
    for (const b of ['512MiB', '10GB', '10gb', '10Gb', '1.5GiB', '1B', '1kB', '1KIB', '3PiB']) expect(single(b), b).to.equal('BYTES');
  });

  it('strings (CASC.md §6.5)', () => {
    expect(single('"a \\"quoted\\" word"')).to.equal('DQ_STRING');
    expect(single("'single'")).to.equal('SQ_STRING');
    expect(single('"""\n  multi\n  line\n  """')).to.equal('TRIPLE_STRING');
  });

  it('a whole !{name:payload} resolver reference, with arbitrarily nested braces (CASC.md §7.4)', () => {
    expect(single('!{vault:secret/db}')).to.equal('RESOLVER_REF_RAW');
    expect(texts('!{vault:{a:{b:{c:1}}}} x')).to.deep.equal(['!{vault:{a:{b:{c:1}}}}', 'x']);
  });

  it('identifiers (CASC.md §4.1)', () => {
    for (const id of ['logger', 'handleOtpReports', 'handle-otp-reports', 'enabled?', 'ready!', 'MyApp', 'a+b', 'x_1']) expect(single(id), id).to.equal('IDENT');
  });
});

describe('lexer: maximal munch, ties by declaration order', () => {
  it('a reserved word wins a tie with IDENT, but a longer identifier stays an IDENT', () => {
    expect(single('inf')).to.equal('INF_KW');
    expect(single('info')).to.equal('IDENT');
    expect(single('nil?')).to.equal('IDENT');
    expect(single('trueish')).to.equal('IDENT');
  });

  it('a date is one DATE token, not INTEGER minus INTEGER', () => {
    expect(types('1979-05-27')).to.deep.equal(['DATE']);
  });

  it('a duration beats the integer it starts with', () => {
    expect(types('5m')).to.deep.equal(['DURATION']);
  });

  it('a byte size beats a duration sharing its prefix', () => {
    expect(types('5mb')).to.deep.equal(['BYTES']);
    expect(types('5ms')).to.deep.equal(['DURATION']);
  });

  it('an atom sigil before a reserved word is not swallowed into an IPv6 literal', () => {
    expect(types(':false')).to.deep.equal([':', 'FALSE_KW']);
    expect(types(':info')).to.deep.equal([':', 'IDENT']);
  });

  it('a signed +inf followed by identifier characters is + and an identifier (conformance case 905)', () => {
    expect(types('+infra')).to.deep.equal(['+', 'IDENT']);
    expect(texts('+infra')).to.deep.equal(['+', 'infra']);
    expect(types('-inf_x')).to.deep.equal(['-', 'IDENT']);
    expect(types('+inf ')).to.deep.equal(['INF_KW']);
  });

  it('punctuation prefers the longest literal', () => {
    expect(types('${?X}')).to.deep.equal(['${?', 'IDENT', '}']);
    expect(types('${X}')).to.deep.equal(['${', 'IDENT', '}']);
    expect(types('@{x}')).to.deep.equal(['@{', 'IDENT', '}']);
    expect(types('%{a.b}')).to.deep.equal(['%{', 'IDENT', '.', 'IDENT', '}']);
    expect(types('@x')).to.deep.equal(['@', 'IDENT']);
  });
});

describe('lexer: trivia and comments (CASC.md §3)', () => {
  it('skips whitespace of every kind', () => {
    expect(texts(' \t\r\n a \n\n b ')).to.deep.equal(['a', 'b']);
  });

  it('# followed by a space (or anything other than a letter, @, or *) is a comment', () => {
    expect(texts('a # a comment\nb')).to.deep.equal(['a', 'b']);
    expect(texts('#\nb')).to.deep.equal(['b']);
    expect(texts('#1 numbered\nb')).to.deep.equal(['b']);
    expect(texts('a#')).to.deep.equal(['a']);
  });

  it('# directly followed by a letter, @, or * is a literal # token (header / disabled statement)', () => {
    expect(types('#@version')).to.deep.equal(['#', '@', 'IDENT']);
    expect(types('#key')).to.deep.equal(['#', 'IDENT']);
    expect(types('#*key')).to.deep.equal(['#', '*', 'IDENT']);
    expect(texts('#TODO fix this')).to.deep.equal(['#', 'TODO', 'fix', 'this']);
  });

  it('skips a leading byte-order mark', () => {
    expect(tokenize('\uFEFFa')[0]).to.include({ type: 'IDENT', text: 'a', offset: 1 });
  });

  it('records each token 1-based start line', () => {
    expect(tokenize('a\n\n  b # c\nd').map((/** @type {{line: number}} */ t) => t.line)).to.deep.equal([1, 3, 4]);
  });

  it('records each token offset in UTF-16 code units', () => {
    expect(tokenize('a = "é"\nb').map((/** @type {{offset: number}} */ t) => t.offset)).to.deep.equal([0, 2, 4, 8]);
  });
});

describe('lexer: errors', () => {
  it('throws a lexer-stage CooperError with line, column, and offset where nothing matches', () => {
    let err;
    try {
      tokenize('a = 1\nb = ^');
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CooperError);
    expect(err).to.include({ stage: 'lexer', line: 2, column: 5, offset: 10 });
  });

  it('an unterminated string is a lexer error', () => {
    expect(() => tokenize('"abc')).to.throw(CooperError).with.property('stage', 'lexer');
    expect(() => tokenize("'abc")).to.throw(CooperError).with.property('stage', 'lexer');
  });

  it('an unbalanced resolver reference is not one token -- it falls apart into punctuation', () => {
    expect(types('!{vault:{x}')).to.deep.equal(['!', '{', 'IDENT', ':', '{', 'IDENT', '}']);
  });

  it('passes the file name through to the error', () => {
    expect(() => tokenize('^', { file: 'x.casc' })).to.throw(CooperError).with.property('file', 'x.casc');
  });
});

describe('lexer: position()', () => {
  it('maps an offset to a 1-based line and column', () => {
    expect(position('ab\ncd', 0)).to.deep.equal({ line: 1, column: 1 });
    expect(position('ab\ncd', 4)).to.deep.equal({ line: 2, column: 2 });
    expect(position('ab\n', 3)).to.deep.equal({ line: 2, column: 1 });
  });
});

describe('lexer properties', () => {
  it('never throws anything but a lexer-stage CooperError, whose position is consistent', () => {
    fc.assert(
      fc.property(cascLike, (src) => {
        try {
          tokenize(src);
        } catch (err) {
          if (!(err instanceof CooperError)) throw err;
          expect(err.stage).to.equal('lexer');
          const { line, column } = position(src, /** @type {number} */ (err.offset));
          expect({ line: err.line, column: err.column }).to.deep.equal({ line, column });
        }
      }),
      { numRuns: 2000 }
    );
  });

  it('every token is the exact source text at its offset, in strictly increasing order, with only trivia between', () => {
    fc.assert(
      fc.property(cascLike, (src) => {
        let tokens;
        try {
          tokens = tokenize(src);
        } catch (err) {
          if (err instanceof CooperError) return;
          throw err;
        }
        let cursor = 0;
        for (const { text, offset } of tokens) {
          expect(text.length).to.be.greaterThan(0);
          expect(offset).to.be.at.least(cursor);
          expect(src.slice(offset, offset + text.length)).to.equal(text);
          const gap = src.slice(cursor, offset).replace(/^\uFEFF/, '');
          expect(/^(?:[ \t\r\n]|#[^\n]*)*$/.test(gap), `gap ${JSON.stringify(gap)}`).to.equal(true);
          cursor = offset + text.length;
        }
      }),
      { numRuns: 2000 }
    );
  });
});
