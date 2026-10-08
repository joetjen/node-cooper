import { expect } from 'chai';
import fc from 'fast-check';
import { load, loadError } from '../support/harness.js';

/**
 * `| filter` clauses (CASC.md §7.2 "Filters"), shared by `@{}`/`${}`/`%{}`,
 * plus the whole-value normalizing tags `!trim`/`!downcase`/`!upcase`
 * (§7.5). Most cases are asserted in both the bare and the in-string
 * spelling, since the two take different parse paths.
 */

describe('filters: parameterless (CASC.md §7.2)', () => {
  it('trim, downcase and upcase apply to an env reference', () => {
    const env = { PADDED: '  x  ', MIXED: 'AbC' };
    expect(load('a = ${PADDED | trim}\nb = ${MIXED | downcase}\nc = ${MIXED | upcase}', { env })).to.deep.equal({
      a: 'x',
      b: 'abc',
      c: 'ABC',
    });
  });

  it('an argument on a parameterless filter is a resolve error', () => {
    expect(loadError('a = ${X | trim: "y"}', { env: { X: 'v' } }, 'resolve').message).to.contain('takes no argument');
  });
});

describe('filters: parameterized (CASC.md §7.2)', () => {
  it('trim_suffix strips the given suffix', () => {
    expect(load('a = ${SCHEME | trim_suffix: "://"}', { env: { SCHEME: 'https://' } })).to.deep.equal({ a: 'https' });
  });

  it('trim_prefix strips the given prefix', () => {
    expect(load('a = ${P | trim_prefix: "/api"}', { env: { P: '/api/v1' } })).to.deep.equal({ a: '/v1' });
  });

  it('an affix that is not present leaves the value alone', () => {
    expect(load('a = ${SCHEME | trim_suffix: "://"}', { env: { SCHEME: 'https' } })).to.deep.equal({ a: 'https' });
  });

  it('strips the affix only once', () => {
    expect(load('a = ${S | trim_suffix: "/"}', { env: { S: 'x//' } })).to.deep.equal({ a: 'x/' });
  });

  it('a missing argument is a resolve error', () => {
    expect(loadError('a = ${X | trim_suffix}', { env: { X: 'v' } }, 'resolve').message).to.contain('requires an argument');
  });

  it('single- and double-quoted arguments are equivalent', () => {
    const env = { SCHEME: 'https://' };
    expect(load("a = ${SCHEME | trim_suffix: '://'}", { env })).to.deep.equal(load('a = ${SCHEME | trim_suffix: "://"}', { env }));
  });
});

describe('filters: chaining and ordering', () => {
  it('filters apply left to right', () => {
    expect(load('a = ${S | trim_suffix: "://" | upcase}', { env: { S: 'https://' } })).to.deep.equal({ a: 'HTTPS' });
    // The reverse order cannot strip a lower-case suffix any more.
    expect(load('a = ${S | upcase | trim_suffix: "s://"}', { env: { S: 'https://' } })).to.deep.equal({ a: 'HTTPS://' });
  });

  it('a filter applies after a default has been substituted', () => {
    expect(load('a = ${COOPER_TEST_UNSET_F:"  padded  " | trim}')).to.deep.equal({ a: 'padded' });
  });

  it('a filter applies to the value when the reference is set', () => {
    expect(load('a = ${S:"unused" | trim}', { env: { S: '  set  ' } })).to.deep.equal({ a: 'set' });
  });

  it('property: a chain equals applying each filter in sequence, bare and in-string alike', () => {
    const text = fc.stringOf(fc.constantFrom('a', 'B', 'c', ' ', '/', ':', '-'), { minLength: 1, maxLength: 12 });
    const affix = fc.stringOf(fc.constantFrom('a', 'B', '/', ':', '-'), { minLength: 1, maxLength: 3 });
    const filter = fc.oneof(
      fc.constantFrom('trim', 'downcase', 'upcase').map((name) => ({ name, arg: null })),
      fc.record({ name: fc.constantFrom('trim_prefix', 'trim_suffix'), arg: affix })
    );
    /** @type {Record<string, (v: string, a: string) => string>} */
    const model = {
      trim: (v) => v.trim(),
      downcase: (v) => v.toLowerCase(),
      upcase: (v) => v.toUpperCase(),
      trim_prefix: (v, a) => (v.startsWith(a) ? v.slice(a.length) : v),
      trim_suffix: (v, a) => (v.endsWith(a) ? v.slice(0, v.length - a.length) : v),
    };
    fc.assert(
      fc.property(text, fc.array(filter, { minLength: 1, maxLength: 5 }), (value, chain) => {
        const clauses = chain.map(({ name, arg }) => (arg === null ? ` | ${name}` : ` | ${name}: '${arg}'`)).join('');
        const expected = chain.reduce((v, { name, arg }) => model[name](v, arg ?? ''), value);
        const env = { S: value };
        expect(load(`a = \${S${clauses}}`, { env })).to.deep.equal({ a: expected });
        expect(load(`a = "\${S${clauses}}"`, { env })).to.deep.equal({ a: expected });
      }),
      { numRuns: 150 }
    );
  });
});

describe('filters: shared across reference forms', () => {
  it('a variable reference filters', () => {
    expect(load('@padded = "  v  "\na = @{padded | trim}')).to.deep.equal({ a: 'v' });
  });

  it('a config reference filters, leaving its source untouched', () => {
    expect(load('raw = "  v  "\na = %{raw | trim}')).to.deep.equal({ raw: '  v  ', a: 'v' });
  });

  it('a config reference with a default filters the default', () => {
    expect(load('a = %{nope:"  D  " | trim | downcase}')).to.deep.equal({ a: 'd' });
  });
});

describe('filters: parse-path parity (bare vs in-string)', () => {
  it('a bare reference and the same reference in a string agree', () => {
    const env = { SCHEME: 'https://' };
    const bare = load("a = ${SCHEME | trim_suffix: '://'}", { env });
    expect(bare).to.deep.equal({ a: 'https' });
    expect(load("a = \"${SCHEME | trim_suffix: '://'}\"", { env })).to.deep.equal(bare);
  });

  it('chained filters agree across both paths', () => {
    const env = { SCHEME: 'https://' };
    expect(load("a = ${SCHEME | trim_suffix: '://' | upcase}", { env })).to.deep.equal(
      load("a = \"${SCHEME | trim_suffix: '://' | upcase}\"", { env })
    );
  });

  it('a pipe inside a quoted default is not a filter', () => {
    expect(load('a = ${COOPER_TEST_UNSET_F:"a|b"}')).to.deep.equal({ a: 'a|b' });
  });

  it('a filtered reference composes with surrounding text in a string (§7.2 example)', () => {
    expect(load("host = \"api\"\nendpoint = \"${SCHEME | trim_suffix: '://'}://%{host}\"", { env: { SCHEME: 'https://' } })).to.deep.equal({
      host: 'api',
      endpoint: 'https://api',
    });
  });
});

describe('filters: an interpolated argument (CASC.md §7.2)', () => {
  it('a double-quoted argument interpolates like any double-quoted string', () => {
    expect(load('@suffix = "://"\ns = ${SCHEME | trim_suffix: "@{suffix}"}', { env: { SCHEME: 'HTTPS://' } })).to.deep.equal({
      s: 'HTTPS',
    });
  });

  it('a single-quoted argument stays literal', () => {
    expect(load("s = ${X | trim_suffix: '@{y}'}", { env: { X: 'a@{y}' } })).to.deep.equal({ s: 'a' });
  });
});

describe('filters: errors', () => {
  it('an unknown filter is an error naming the known ones', () => {
    const { message } = loadError('a = ${X | nope}', { env: { X: 'v' } }, 'resolve');
    expect(message).to.contain('unknown filter');
    expect(message).to.contain('nope');
    expect(message).to.contain('trim_suffix');
  });

  it('filtering a non-string is an error rather than a coercion', () => {
    expect(loadError('n = 42\na = %{n | trim}', {}, 'resolve').message).to.contain('not a string');
  });
});

describe('normalizing tags !trim/!downcase/!upcase (CASC.md §7.5)', () => {
  it('cover a whole value', () => {
    expect(load('a = !trim("  x  ")\nb = !downcase("AbC")\nc = !upcase("dEf")')).to.deep.equal({ a: 'x', b: 'abc', c: 'DEF' });
  });

  it('applied to a non-string is a resolve error', () => {
    expect(loadError('a = !trim(42)', {}, 'resolve').message).to.contain('not a string');
  });
});
