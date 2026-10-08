import { expect } from 'chai';
import { load, loadError } from '../support/harness.js';

/** CASC.md §5.5 for-loops, end to end. */

describe('loops: parallel (zipped) iteration (CASC.md §5.5)', () => {
  it("produces the spec's documented endpoints map", () => {
    const source = [
      '@domains = ["us-east.example.com", "eu-west.example.com"]',
      '@ports = [8443, 8444]',
      '',
      'for @idx, @domain in @{domains}, @port in @{ports} as endpoints."domain-@{idx}" {',
      '  url = "https://@{domain}:@{port}"',
      '}',
    ].join('\n');
    expect(load(source)).to.deep.equal({
      endpoints: {
        'domain-0': { url: 'https://us-east.example.com:8443' },
        'domain-1': { url: 'https://eu-west.example.com:8444' },
      },
    });
  });

  it('a length mismatch between bound lists is a loop error naming both lists and lengths', () => {
    const source = [
      '@domains = ["us-east.example.com", "eu-west.example.com"]',
      '@ports = [8443]',
      'for @domain in @{domains}, @port in @{ports} as endpoints."@{domain}" {',
      '  url = "@{port}"',
      '}',
    ].join('\n');
    const { message } = loadError(source, {}, 'loop');
    expect(message).to.contain('domain').and.contain('2').and.contain('port').and.contain('1');
  });

  it('an index-only loop is a loop error', () => {
    loadError('for @idx as dest."@{idx}" {\n  k = 1\n}', {}, 'loop');
  });

  it('an index binding after an element binding is not mistaken for the trailing `as`', () => {
    const source = '@names = ["a", "b"]\nfor @name in @{names}, @idx as dest."@{name}" {\n  position = "@{idx}"\n}';
    expect(load(source)).to.deep.equal({ dest: { a: { position: '0' }, b: { position: '1' } } });
  });

  it('a bare index binding keeps its integer type', () => {
    expect(load('for @i, @x in ["a", "b"] as d."@{x}" { n = @{i} }')).to.deep.equal({ d: { a: { n: 0 }, b: { n: 1 } } });
  });

  it('an empty iterable generates nothing', () => {
    expect(load('@none = []\nfor @x in @{none} as d."@{x}" { k = 1 }\nkept = 1')).to.deep.equal({ kept: 1 });
  });
});

describe('loops: `from <template>` (CASC.md §5.5)', () => {
  it('each destination starts as a copy of the template with the body layered on top', () => {
    const source = [
      'defaults.replica {',
      '  cpu = 1',
      '  memory_mb = 512',
      '}',
      '@instances = ["a", "b", "c"]',
      'for @instance in @{instances} from defaults.replica as replicas."@{instance}" {',
      '  cpu = 2',
      '}',
    ].join('\n');
    expect(load(source).replicas).to.deep.equal({
      a: { cpu: 2, memory_mb: 512 },
      b: { cpu: 2, memory_mb: 512 },
      c: { cpu: 2, memory_mb: 512 },
    });
  });

  it('the template resolves lazily against the final tree, after later overrides', () => {
    const source = [
      'defaults { cpu = 1 }',
      'for @x in ["a"] from defaults as out."@{x}" { name = @{x} }',
      'defaults.memory = 256',
    ].join('\n');
    expect(load(source).out).to.deep.equal({ a: { cpu: 1, memory: 256, name: 'a' } });
  });

  it('a `+key` in the body appends to the list copied from the template, independently per copy', () => {
    const result = load('t { list = [1] }\nfor @x in ["a", "b"] from t as out."@{x}" { +list = [@{x}] }');
    expect(result).to.deep.equal({ t: { list: [1] }, out: { a: { list: [1, 'a'] }, b: { list: [1, 'b'] } } });
  });
});

describe('loops: iterable validation', () => {
  it('a literal list works directly, with no outer variable', () => {
    expect(load('for @x in ["p", "q"] as dest."@{x}" {\n  k = 1\n}')).to.deep.equal({ dest: { p: { k: 1 }, q: { k: 1 } } });
  });

  it('an undefined variable as iterable is a loop error naming it', () => {
    expect(loadError('for @x in @{missing} as dest."@{x}" {\n  k = 1\n}', {}, 'loop').message).to.contain('missing');
  });

  it('a %{...} config reference as iterable is refused (it cannot resolve before merge)', () => {
    loadError('for @x in %{some.path} as dest."@{x}" {\n  k = 1\n}', {}, 'loop');
  });
});

describe('loops: scope of bindings (CASC.md §5.5, §7.1)', () => {
  it('a binding shadows an outer variable inside the body only', () => {
    expect(load('@x = "outer"\nfor @x in ["p"] as d."@{x}" { v = @{x} }\nafter = @{x}')).to.deep.equal({
      d: { p: { v: 'p' } },
      after: 'outer',
    });
  });

  it('a binding ceases to exist once the loop ends', () => {
    expect(load('for @y in ["p"] as d."@{y}" { v = 1 }\nafter = @{y:"gone"}').after).to.equal('gone');
  });

  it('a binding keeps its index, filters and suffix inside the body (conformance case 911)', () => {
    const source = 'for @x in [["a", "b"]] as out { first = @{x[0] | upcase}\n second = "@{x[1]:z}" }';
    expect(load(source)).to.deep.equal({ out: { first: 'A', second: 'b' } });
    expect(load('for @x in ["a", "b"] as out."@{x}" { up = @{x | upcase} }')).to.deep.equal({ out: { a: { up: 'A' }, b: { up: 'B' } } });
  });
});

describe('loops: what a binding reaches (CASC.md §5.5)', () => {
  it('a binding reaches a filter argument', () => {
    expect(load('for @x in ["://"] as out { s = ${SCHEME | trim_suffix: "@{x}"} }', { env: { SCHEME: 'HTTPS://' } })).to.deep.equal({
      out: { s: 'HTTPS' },
    });
  });

  it('a binding reaches the message of :?"..."', () => {
    expect(loadError('for @x in ["X"] as out { s = ${COOPER_TEST_UNSET_S:?"need @{x}"} }', {}, 'resolve').message).to.equal('need X');
  });
});

describe('loops: keys built from a binding (CASC.md §4.2, §5.5)', () => {
  it('a destination segment may not resolve to a string with a dot in it', () => {
    expect(loadError('for @x in ["a.b"] as out."@{x}" { v = 1 }', {}, 'resolve').message).to.contain('more than one path segment');
  });

  it('a destination segment may not resolve to an empty string', () => {
    expect(loadError('for @x in [""] as out."@{x}" { v = 1 }', {}, 'resolve').message).to.contain('empty string');
  });

  it('a body key may not resolve to a string with a dot in it', () => {
    loadError('for @x in ["a"] as out { "k-@{x}.z" = 1 }', {}, 'resolve');
  });

  it('a float binding reads with its fraction, so it cannot name a key', () => {
    loadError('for @x in [1.0] as out."k@{x}" { v = 1 }', {}, 'resolve');
  });
});

describe('loops: merge sigils in the body (conformance case 915)', () => {
  it('`~key {}` in a body clears under the destination, not at the top level', () => {
    expect(load('inner.keep = 1\nfor @x in ["a"] as out."@{x}" { ~inner { v = 1 } }')).to.deep.equal({
      inner: { keep: 1 },
      out: { a: { inner: { v: 1 } } },
    });
  });

  it('`-key` in a body deletes under the destination', () => {
    expect(load('out.k { a = 1, b = 2 }\nfor @x in ["k"] as out."@{x}" { -a }')).to.deep.equal({ out: { k: { b: 2 } } });
  });

  it('`-key` in a `from` body deletes a key copied from the template', () => {
    expect(load('t { a = 1, b = 2 }\nfor @x in ["k"] from t as out."@{x}" { -a }')).to.deep.equal({
      t: { a: 1, b: 2 },
      out: { k: { b: 2 } },
    });
  });
});
