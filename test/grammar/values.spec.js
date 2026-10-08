import { expect } from 'chai';
import fc from 'fast-check';
import { loadStringSync, loadString, CooperError, Secret, Tuple, Duration, ByteSize, IPv4 } from '../../src/cooper.js';
import { isolated, load, value, valueError, cooperError } from '../support/load.js';

describe('end to end: nil and booleans (CASC.md §6.1-6.2)', () => {
  it('nil', () => {
    expect(value('nil')).to.equal(null);
  });

  it('booleans', () => {
    expect(value('true')).to.equal(true);
    expect(value('false')).to.equal(false);
  });
});

describe('end to end: numbers (CASC.md §6.3)', () => {
  it('integers', () => {
    expect(value('-17')).to.equal(-17);
    expect(value('0')).to.equal(0);
    expect(value('+99')).to.equal(99);
  });

  it('hex, octal, binary', () => {
    expect(value('0xDEAD_BEEF')).to.equal(0xdeadbeef);
    expect(value('0o755')).to.equal(0o755);
    expect(value('0b11010110')).to.equal(0b11010110);
  });

  it('floats', () => {
    expect(value('3.1415')).to.equal(3.1415);
    expect(value('-0.01')).to.equal(-0.01);
  });

  it('exponents', () => {
    expect(value('5e+22')).to.equal(5e22);
    expect(value('-2E-2')).to.equal(-0.02);
  });

  it('digit separators', () => {
    expect(value('1_000_000')).to.equal(1_000_000);
  });

  it('infinity', () => {
    expect(value('inf')).to.equal(Infinity);
    expect(value('+inf')).to.equal(Infinity);
    expect(value('-inf')).to.equal(-Infinity);
  });

  it('a float with no fractional part still loads as a plain number', () => {
    expect(value('1.0')).to.equal(1);
    expect(value('-2.0e3')).to.equal(-2000);
  });

  it('a float nested in a list, a tuple or a secret loads as a plain number too', () => {
    const result = load('l = [1.5, 2.0]\nt = (3.0, "x")\n*s = 4.0');
    expect(result.l).to.deep.equal([1.5, 2]);
    expect(result.t).to.be.instanceOf(Tuple);
    expect(result.t.items).to.deep.equal([3, 'x']);
    expect(result.s).to.be.instanceOf(Secret);
    expect(result.s.reveal()).to.equal(4);
  });

  it('integers beyond the safe range load as exact bigints', () => {
    expect(value('9007199254740993')).to.equal(9007199254740993n);
    expect(value('9007199254740991')).to.equal(9007199254740991);
  });
});

describe('end to end: atoms (CASC.md §6.4)', () => {
  it('reserved words take precedence over the atom rule', () => {
    expect(value('nil')).to.equal(null);
    expect(value('true')).to.equal(true);
    expect(value('false')).to.equal(false);
    expect(value('inf')).to.equal(Infinity);
  });

  it('a bare identifier is an atom (a registered Symbol)', () => {
    expect(value('info')).to.equal(Symbol.for('info'));
  });

  it('an optional leading colon', () => {
    expect(value(':info')).to.equal(Symbol.for('info'));
  });

  it('`:nil`, `:true` and `:false` are the values, while `:inf` is the atom inf', () => {
    expect(value(':true')).to.equal(true);
    expect(value(':false')).to.equal(false);
    expect(value(':nil')).to.equal(null);
    expect(value(':inf')).to.equal(Symbol.for('inf'));
  });

  it('any identifier-rule name loads as the atom of that name', () => {
    const values = new Set(['nil', 'true', 'false']);
    fc.assert(
      fc.property(fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_+-]{0,10}[?!]?$/), fc.boolean(), (name, colon) => {
        // `:nil`/`:true`/`:false` are values, and a bare `inf` is infinity.
        fc.pre(!values.has(name) && (name !== 'inf' || colon));
        // A name shaped like a duration/byte unit never starts with a letter, so no ambiguity here.
        expect(value(`${colon ? ':' : ''}${name}`)).to.equal(Symbol.for(name));
      }),
      { numRuns: 100 }
    );
  });
});

describe('end to end: strings (CASC.md §6.5)', () => {
  it('double-quoted strings process escapes', () => {
    expect(value('"line1\\nline2"')).to.equal('line1\nline2');
    expect(value('"a \\"quote\\""')).to.equal('a "quote"');
    expect(value('"tab\\there"')).to.equal('tab\there');
    expect(value('"cr\\r back\\\\slash"')).to.equal('cr\r back\\slash');
    expect(value('"\\u00e9\\u4e2d"')).to.equal('é中');
  });

  it('double-quoted strings with no references stay plain strings', () => {
    expect(value('"hello world"')).to.equal('hello world');
    expect(value('""')).to.equal('');
  });

  it('single-quoted strings are fully literal', () => {
    expect(value("'no \\n escapes here'")).to.equal('no \\n escapes here');
    expect(value("'@{x} ${Y}'")).to.equal('@{x} ${Y}');
  });

  it('triple-quoted strings strip the smallest common leading whitespace', () => {
    const r = load('motd = """\n    Welcome to the service.\n    Status: operational\n    """');
    expect(r.motd).to.equal('Welcome to the service.\nStatus: operational\n');
  });

  it('triple-quoted strings keep deeper indentation relative to the shallowest line', () => {
    expect(load('v = """\n  a\n    b\n  """').v).to.equal('a\n  b\n');
  });

  it('a double-quoted string round-trips any text written with CASC escapes', () => {
    const named = /** @type {Record<string, string>} */ ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' });
    const casc = (/** @type {string} */ s) =>
      `"${s.replace(/[\\"\n\r\t]|[\u0000-\u001f]|[\ud800-\udfff]/g, (c) => named[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`;
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 30 }), fc.string({ unit: 'binary', maxLength: 20 })), (s) => {
        // Reference openers are avoided, since they'd interpolate.
        fc.pre(!/[@$%!]\{|![a-zA-Z]/.test(s));
        expect(value(casc(s))).to.equal(s);
      }),
      { numRuns: 200 }
    );
  });
});

describe('end to end: lists (CASC.md §6.10)', () => {
  it('comma-separated', () => {
    expect(value('["a", "b", "c"]')).to.deep.equal(['a', 'b', 'c']);
  });

  it('newline-separated, no commas', () => {
    expect(value('[\n  "a"\n  "b"\n]')).to.deep.equal(['a', 'b']);
  });

  it('whitespace-separated', () => {
    expect(value('[1 2 3]')).to.deep.equal([1, 2, 3]);
  });

  it('mixed value types', () => {
    expect(value('[1, 2.5, true, nil, info]')).to.deep.equal([1, 2.5, true, null, Symbol.for('info')]);
  });

  it('nested lists, tuples, and typed literals', () => {
    const v = value('[[1], (2, 3), 5ms, 1KiB, 10.0.0.1]');
    expect(v[0]).to.deep.equal([1]);
    expect(v[1]).to.be.instanceOf(Tuple);
    expect(v[2]).to.be.instanceOf(Duration);
    expect(v[3]).to.be.instanceOf(ByteSize);
    expect(v[4]).to.be.instanceOf(IPv4);
  });

  it('empty', () => {
    expect(value('[]')).to.deep.equal([]);
  });
});

describe('end to end: tagged values (CASC.md §7.5)', () => {
  it('!duration and !bytes parse their string argument like the bare literal', () => {
    expect(value('!duration("5m")').equals(value('5m'))).to.equal(true);
    expect(value('!bytes("512MiB")').equals(value('512MiB'))).to.equal(true);
  });

  it('!int and !bool convert an env reference with a default', () => {
    expect(value('!int(${PORT:8080})')).to.equal(8080);
    expect(value('!int(${PORT:8080})', { PORT: '9090' })).to.equal(9090);
    expect(value('!bool(${DEBUG:false})')).to.equal(false);
  });
});

describe('end to end: version header (CASC.md §2)', () => {
  it('the minimal valid file loads to an empty object (CASC.md §10)', () => {
    expect(loadStringSync('#@version = 1.0', isolated())).to.deep.equal({});
  });

  it('accepts the operator-optional form and bare, dotted, triple-dotted versions', () => {
    for (const header of ['#@version 1.0', '#@version = 1', '#@version = 1.0', '#@version = 2.1.3']) {
      expect(loadStringSync(header, isolated()), header).to.deep.equal({});
    }
  });

  it('rejects a mismatched header keyword (action stage)', () => {
    const err = cooperError(() => loadStringSync('#@versio = 1.0', isolated()));
    expect(err.stage).to.equal('action');
    expect(err.message).to.match(/#@version/);
  });

  it('a completely empty file is a load-time error', () => {
    expect(cooperError(() => loadStringSync('', isolated())).stage).to.equal('parser');
  });

  it("a file whose first statement isn't the version header is a load-time error", () => {
    expect(cooperError(() => loadStringSync('foo = 1\n#@version = 1.0\n', isolated())).stage).to.equal('parser');
  });
});

describe('end to end: comments (CASC.md §3.2)', () => {
  it('a comment with a following space is a plain comment', () => {
    expect(load('# a comment\nfoo = 1 # trailing\n#\n')).to.deep.equal({ foo: 1 });
  });

  it("a comment with no following space, where the text isn't a valid statement, is a parse error", () => {
    expect(cooperError(() => load('#TODO fix this\n')).stage).to.equal('parser');
  });
});

describe('end to end: disabled statements (CASC.md §5.6)', () => {
  it('a disabled assignment produces nothing', () => {
    expect(load('section {\n  #ignored = 1\n  kept = true\n}')).to.deep.equal({ section: { kept: true } });
  });

  it('a disabled block statement produces nothing', () => {
    expect(load('section {\n  #*sub { remove = yes }\n  kept = true\n}')).to.deep.equal({ section: { kept: true } });
  });

  it('a disabled variable declaration declares nothing (conformance case 903)', () => {
    expect(load('#@x = 1\ny = @{x:"undeclared"}')).to.deep.equal({ y: 'undeclared' });
  });

  it("a disabled statement's content is never evaluated", () => {
    expect(load('#bad = 2023-02-30\nkept = 1')).to.deep.equal({ kept: 1 });
  });
});

describe('end to end: key paths and blocks (CASC.md §5.4)', () => {
  it('dotted paths, nested blocks, and explicit = { } all desugar identically', () => {
    for (const body of ['foo { bar { baz = "dronf" } }', 'foo { bar.baz "dronf" }', 'foo = { bar = { baz = "dronf" } }', 'foo.bar.baz "dronf"']) {
      expect(load(body), body).to.deep.equal({ foo: { bar: { baz: 'dronf' } } });
    }
  });

  it('two statements with different surface forms merge into one map', () => {
    expect(load('foo.bar.baz = 1\nfoo = { bar = { qux = 2 } }')).to.deep.equal({ foo: { bar: { baz: 1, qux: 2 } } });
  });

  it('quoted key segments (CASC.md §4.2)', () => {
    const r = load('headers = { "Content-Type" = "application/json" }\nfoo."bar baz".dronf = "fnord"\n\'single q\' = 1');
    expect(r).to.deep.equal({ headers: { 'Content-Type': 'application/json' }, foo: { 'bar baz': { dronf: 'fnord' } }, 'single q': 1 });
  });

  it('an interpolated double-quoted key segment (conformance case 906)', () => {
    expect(load('@x = "k"\n"@{x}" = 1\na."${REGION}".b = 2', { REGION: 'eu-west' })).to.deep.equal({ k: 1, a: { 'eu-west': { b: 2 } } });
  });

  it('the optional = with a single value (conformance case 900)', () => {
    expect(load('foo "bar"')).to.deep.equal({ foo: 'bar' });
  });

  it('for/in/from/as/import are usable as ordinary key names (CASC.md §4.1)', () => {
    expect(load('for = 1\nin = 2\nfrom = 3\nas = 4\nimport = 5')).to.deep.equal({ for: 1, in: 2, from: 3, as: 4, import: 5 });
  });

  it('identifier-rule keys with hyphens, plus signs, and trailing ?/! (CASC.md §4.1)', () => {
    expect(load('handle-otp-reports = 1\nenabled? = true\nready! = false\na+b = 2')).to.deep.equal({
      'handle-otp-reports': 1,
      'enabled?': true,
      'ready!': false,
      'a+b': 2,
    });
  });

  it('+infra on a list named infra is an append, not +inf (conformance case 905)', () => {
    expect(load('infra = ["a"]\n+infra = ["x"]')).to.deep.equal({ infra: ['a', 'x'] });
  });
});

describe('end to end: sigil ordering (CASC.md §5.7)', () => {
  it('~* combined: replace wholesale AND mark secret', () => {
    const r = load('database { host = "old.internal", password = "old-pw", port = 1 }\n~*database { host = "db.internal", password = "hunter2" }');
    expect(Object.keys(r.database).sort()).to.deep.equal(['host', 'password']);
    expect(r.database.host).to.be.instanceOf(Secret);
    expect(r.database.host.reveal()).to.equal('db.internal');
    expect(r.database.password.reveal()).to.equal('hunter2');
  });

  it('#~* combined: the disabled form of the same statement produces nothing at all', () => {
    expect(load('database { host = "old.internal" }\n#~*database { host = "db.internal", password = "hunter2" }')).to.deep.equal({
      database: { host: 'old.internal' },
    });
  });
});

describe('end to end: ${?NAME} conditional statement skip (CASC.md §7.2)', () => {
  it("the spec's own worked example, verbatim", () => {
    const body = 'region = ${REGION}\nmax_retries = !int(${MAX_RETRIES:3})\n${?FEATURE_FLAG}\nenabled = true\nallowed_hosts = ${ALLOWED_HOSTS[]:["localhost"]}';
    expect(load(body, { REGION: 'eu-west' })).to.deep.equal({ region: 'eu-west', max_retries: 3, allowed_hosts: ['localhost'] });
  });

  it('the guarded statement is evaluated when the var is set and non-empty', () => {
    expect(load('${?FEATURE_FLAG}\nenabled = true', { FEATURE_FLAG: '1' })).to.deep.equal({ enabled: true });
  });

  it('an empty value counts as unset', () => {
    expect(load('${?FEATURE_FLAG}\nenabled = true', { FEATURE_FLAG: '' })).to.deep.equal({});
  });

  it('only guards the one statement immediately after it', () => {
    expect(load('${?MISSING}\nskipped = true\nkept = 1')).to.deep.equal({ kept: 1 });
  });

  it("a skipped statement's own content is never evaluated", () => {
    expect(load('${?MISSING}\nv = !nonexistent_tag("x")\nkept = 1')).to.deep.equal({ kept: 1 });
    expect(load('${?MISSING}\nv = 2023-02-30\nkept = 1')).to.deep.equal({ kept: 1 });
  });
});

describe('end to end: load-time literal errors are clean CooperErrors', () => {
  it('each malformed literal reports the action stage', () => {
    for (const literal of ['999.999.999.999', '127.0.0.1/33', '::1/129', '1.5h30m', '30m1h', '2023-02-30', '24:00:00']) {
      const err = valueError(literal);
      expect(err, literal).to.be.instanceOf(CooperError);
      expect(err.stage, literal).to.equal('action');
    }
  });

  it('loading arbitrary statement text never throws anything but a CooperError', () => {
    const chars = fc.constantFrom(...'#@{}$%!()[]:=,.+-*~?|"\' \n\tabcfinortuxyz0123456789_'.split(''));
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 50 }), fc.string({ unit: chars, maxLength: 50 })), (body) => {
        try {
          load(body);
        } catch (err) {
          if (!(err instanceof CooperError)) throw err;
          expect(err.stage).to.be.oneOf(['lexer', 'parser', 'action', 'loop', 'import', 'merge', 'resolve']);
        }
      }),
      { numRuns: 1000 }
    );
  });
});

describe('end to end: sync and async APIs agree', () => {
  it('loadString resolves to the same value loadStringSync returns', async () => {
    const source = '#@version = 1.0\na = [1, (2, 3), 5ms]\n*s = "x"\nb = "@{v}"\n@v = :ok';
    const sync = loadStringSync(source, isolated());
    const asyncResult = await loadString(source, isolated());
    expect(asyncResult.a[0]).to.equal(sync.a[0]);
    expect(asyncResult.a[1].toArray()).to.deep.equal(sync.a[1].toArray());
    expect(asyncResult.a[2].equals(sync.a[2])).to.equal(true);
    expect(asyncResult.s.reveal()).to.equal('x');
    expect(asyncResult.b).to.equal(sync.b);
  });

  it('loadString rejects with the same CooperError stage', async () => {
    let err;
    try {
      await loadString('#@version = 1.0\nv = 2023-02-30', isolated());
    } catch (e) {
      err = e;
    }
    expect(err).to.be.instanceOf(CooperError);
    expect(err).to.have.property('stage', 'action');
  });
});
