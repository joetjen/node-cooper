import { expect } from 'chai';
import fc from 'fast-check';
import { Tuple, Secret } from '../../src/cooper.js';
import { load, loadError } from '../support/harness.js';

/** CASC.md §8 merge model and the §5.7 merge-control sigils. */

describe('merge: blocks and maps deep-merge by default (CASC.md §8.1)', () => {
  it('two statements at different sub-paths merge rather than overwrite', () => {
    expect(load('a { b = 1 }\na { c = 2 }')).to.deep.equal({ a: { b: 1, c: 2 } });
  });

  it('deep-merges at 3+ levels regardless of which surface form wrote which layer', () => {
    expect(load('a.b.c.d = 1\na { b { c { e = 2 } } }\na.b.f = 3')).to.deep.equal({ a: { b: { c: { d: 1, e: 2 }, f: 3 } } });
  });

  it('an explicit `= { ... }` map merges like a block', () => {
    expect(load('a = { b = 1 }\na = { c = 2 }')).to.deep.equal({ a: { b: 1, c: 2 } });
  });

  it('a later scalar replaces a map, and a later map replaces a scalar', () => {
    expect(load('a { x = 1 }\na = 5')).to.deep.equal({ a: 5 });
    expect(load('a = 5\na { x = 1 }')).to.deep.equal({ a: { x: 1 } });
  });

  it('property: any sequence of plain dotted assignments equals building the tree directly (last write wins)', () => {
    const segment = fc.constantFrom('a', 'b', 'c', 'd');
    const write = fc.record({
      path: fc.array(segment, { minLength: 1, maxLength: 4 }),
      value: fc.oneof(fc.integer({ min: -1000, max: 1000 }), fc.stringOf(fc.constantFrom('x', 'y', 'z'), { maxLength: 3 })),
    });
    fc.assert(
      fc.property(fc.array(write, { minLength: 1, maxLength: 15 }), (writes) => {
        /** @type {Record<string, any>} */
        const expected = {};
        for (const { path, value } of writes) {
          let node = expected;
          for (const key of path.slice(0, -1)) {
            if (node[key] === null || typeof node[key] !== 'object') node[key] = {};
            node = node[key];
          }
          node[path[path.length - 1]] = value;
        }
        const source = writes.map(({ path, value }) => `${path.join('.')} = ${JSON.stringify(value)}`).join('\n');
        expect(load(source)).to.deep.equal(expected);
      }),
      { numRuns: 200 }
    );
  });

  it('property: dotted paths and nested blocks produce the identical tree (CASC.md §5.4)', () => {
    const segment = fc.constantFrom('p', 'q', 'r');
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 5 }), fc.integer(), (path, value) => {
        const dotted = load(`${path.join('.')} = ${value}`);
        const nested = load(path.slice(0, -1).reduceRight((inner, key) => `${key} { ${inner} }`, `${path[path.length - 1]} = ${value}`));
        expect(nested).to.deep.equal(dotted);
      })
    );
  });
});

describe('merge: lists replace wholesale by default (CASC.md §8.2)', () => {
  it('a later plain assignment replaces the whole list', () => {
    expect(load('tags = ["a", "b"]\ntags = ["c"]')).to.deep.equal({ tags: ['c'] });
  });
});

describe("merge: §8.4's worked example", () => {
  it('produces exactly the documented result', () => {
    const source = [
      'server { host = "0.0.0.0", port = 8080 }',
      'tags = ["a", "b", "c"]',
      'feature.legacy_mode = true',
      '',
      '~server { port = 9090 }',
      '+tags = ["d"]',
      '-tags = ["b"]',
      '-feature.legacy_mode',
    ].join('\n');
    expect(load(source)).to.deep.equal({ server: { port: 9090 }, tags: ['a', 'c', 'd'], feature: {} });
  });
});

describe('merge: list sigils + and - (CASC.md §5.7, §8.4)', () => {
  it('`+key` on a missing key behaves like a plain assignment', () => {
    expect(load('+t = ["a"]')).to.deep.equal({ t: ['a'] });
  });

  it('`-key = [...]` on a missing key is a no-op', () => {
    expect(load('-t = ["a"]')).to.deep.equal({});
  });

  it('`-key` removes every matching element, and ignores elements not present', () => {
    expect(load('t = [1, 2, 2, 3]\n-t = [2, 9]')).to.deep.equal({ t: [1, 3] });
  });

  it('`-key` compares strictly, so 1 and 1.0 are different elements (CASC.md §8.4)', () => {
    expect(load('a = [1, 2.0, "x"]\n-a = [1.0, 2]')).to.deep.equal({ a: [1, 2, 'x'] });
    expect(load('a = [1.0, 2]\n-a = [1.0]')).to.deep.equal({ a: [2] });
  });

  it('`-key = nil` removes nil elements and `+key = nil` appends one', () => {
    expect(load('a = [1, nil, 2]\n-a = nil')).to.deep.equal({ a: [1, 2] });
    expect(load('a = [1]\n+a = nil')).to.deep.equal({ a: [1, null] });
  });

  it('`+`/`-` against a non-list value is a merge error', () => {
    loadError('t = 5\n+t = [1]', {}, 'merge');
    loadError('t = "s"\n-t = [1]', {}, 'merge');
  });

  it('`+key = @{ref}` appends the referenced list elements (conformance case 907)', () => {
    expect(load('tags = ["a"]\n+tags = @{more}\n@more = ["b", "c"]')).to.deep.equal({ tags: ['a', 'b', 'c'] });
  });

  it('`+key` on a key named like a keyword (`inf`) still appends (conformance case 905)', () => {
    expect(load('infra = ["a"]\n+infra = ["x"]')).to.deep.equal({ infra: ['a', 'x'] });
  });

  it('property: `+key` then `-key` with the same disjoint elements restores the original list', () => {
    const original = fc.array(fc.constantFrom('a', 'b', 'c', 'd'), { maxLength: 8 });
    const extra = fc.array(fc.constantFrom('x', 'y', 'z'), { minLength: 1, maxLength: 5 });
    fc.assert(
      fc.property(original, extra, (orig, more) => {
        const list = (/** @type {string[]} */ items) => `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
        const result = load(`t = ${list(orig)}\n+t = ${list(more)}\n-t = ${list(more)}`);
        expect(result).to.deep.equal({ t: orig });
      }),
      { numRuns: 150 }
    );
  });

  it('property: successive appends concatenate in order', () => {
    const items = fc.array(fc.integer({ min: 0, max: 99 }), { maxLength: 4 });
    fc.assert(
      fc.property(fc.array(items, { minLength: 1, maxLength: 5 }), (chunks) => {
        const source = chunks.map((chunk) => `+t = [${chunk.join(', ')}]`).join('\n');
        expect(load(source)).to.deep.equal({ t: chunks.flat() });
      })
    );
  });
});

describe('merge: replace (~) and delete (-key) (CASC.md §5.7)', () => {
  it('`~key { ... }` replaces a block wholesale', () => {
    expect(load('a { x = 1, y = 2 }\n~a { z = 3 }')).to.deep.equal({ a: { z: 3 } });
  });

  it('`~key { ... }` on a missing or scalar key just sets it', () => {
    expect(load('~a { x = 1 }')).to.deep.equal({ a: { x: 1 } });
    expect(load('a = 1\n~a { x = 1 }')).to.deep.equal({ a: { x: 1 } });
  });

  it('a later plain write after `~` merges into the replacement again', () => {
    expect(load('a { x = 1 }\n~a { y = 2 }\na.z = 3')).to.deep.equal({ a: { y: 2, z: 3 } });
  });

  it('bare `-key.path` removes the path entirely, regardless of value type', () => {
    expect(load('a.b = 1\na.c = 2\n-a.b')).to.deep.equal({ a: { c: 2 } });
    expect(load('a.b { deep = [1] }\n-a.b')).to.deep.equal({ a: {} });
  });

  it('bare `-key` on a missing path is a no-op', () => {
    expect(load('-nope.x\nkept = 1')).to.deep.equal({ kept: 1 });
  });

  it('`-key` inside a block deletes under that block (conformance case 902)', () => {
    expect(load('server { port = 1\n host = 2 }\nserver { -port }')).to.deep.equal({ server: { host: 2 } });
  });

  it('a path written after deletion is re-created', () => {
    expect(load('a.b = 1\n-a\na.c = 2')).to.deep.equal({ a: { c: 2 } });
  });
});

describe('merge: tuples never merge (CASC.md §8.3)', () => {
  it('a later plain assignment replaces a tuple wholesale', () => {
    const result = load('loc = (1, 2)\nloc = (3, 4)');
    expect(result.loc).to.be.instanceOf(Tuple);
    expect(result.loc.items).to.deep.equal([3, 4]);
  });

  it('`+` against a tuple is a merge error, not a silent no-op', () => {
    loadError('loc = (1, 2)\n+loc = [3]', {}, 'merge');
  });

  it('`-` against a tuple is a merge error', () => {
    loadError('loc = (1, 2)\n-loc = [1]', {}, 'merge');
  });

  it('`~` against a path holding a tuple is a merge error', () => {
    loadError('loc = (1, 2)\n~loc { x = 1 }', {}, 'merge');
  });

  it('bare delete of a tuple is allowed (any type)', () => {
    expect(load('loc = (1, 2)\n-loc')).to.deep.equal({});
  });
});

describe('merge: secret propagation (CASC.md §4.3)', () => {
  it('a later plain write over a secret path is no longer wrapped', () => {
    expect(load('*password = "x"\npassword = "y"')).to.deep.equal({ password: 'y' });
  });

  it('a later secret write over a plain path is wrapped', () => {
    const { password } = load('password = "x"\n*password = "y"');
    expect(password).to.be.instanceOf(Secret);
    expect(password.value).to.equal('y');
  });

  it('`~*key { ... }` replaces wholesale and marks every leaf secret', () => {
    const { database } = load('database { host = "old.internal", password = "old-pw" }\n~*database { host = "db.internal", password = "hunter2" }');
    expect(Object.keys(database)).to.have.members(['host', 'password']);
    expect(database.host).to.be.instanceOf(Secret);
    expect(database.host.value).to.equal('db.internal');
    expect(database.password.value).to.equal('hunter2');
  });

  it('`#~*key { ... }` -- the disabled form -- produces nothing at all', () => {
    expect(load('database { host = "old.internal" }\n#~*database { host = "db.internal", password = "hunter2" }')).to.deep.equal({
      database: { host: 'old.internal' },
    });
  });

  it('deleting a secret path and re-writing it plainly leaves it unwrapped', () => {
    expect(load('*a.b = "s"\n-a.b\na.b = "p"')).to.deep.equal({ a: { b: 'p' } });
  });
});

describe('merge: maps inside lists (CASC.md §6.10)', () => {
  it('a list element may be a block, which is a map', () => {
    expect(load('l = [{ a = 1 }, { b { c = 2 } }]')).to.deep.equal({ l: [{ a: 1 }, { b: { c: 2 } }] });
  });

  it('so may a tuple element', () => {
    const { t } = load('t = ({ x = 1 }, 2)');
    expect(t).to.be.instanceOf(Tuple);
    expect(t.items).to.deep.equal([{ x: 1 }, 2]);
  });

  it('+ and - append and remove whole maps, compared by value', () => {
    expect(load('l = [{ a = 1 }, { a = 2 }]\n+l = [{ a = 3 }]\n-l = [{ a = 1 }]')).to.deep.equal({ l: [{ a: 2 }, { a: 3 }] });
  });

  it("an element block's keys interpolate, and see the file's private variables", () => {
    expect(load('@*n = "k"\n@*v = 7\nl = [{ "@{n}-x" = @{v} }]')).to.deep.equal({ l: [{ 'k-x': 7 }] });
  });

  it('a loop binding reaches an element block', () => {
    expect(load('for @x in ["a"] as o { l = [{ "k-@{x}" = @{x} }] }')).to.deep.equal({ o: { l: [{ 'k-a': 'a' }] } });
  });

  it('a secret inside an element block stays secret', () => {
    const { l } = load('l = [{ *pw = "s" }]');
    expect(l[0].pw).to.be.instanceOf(Secret);
    expect(l[0].pw.value).to.equal('s');
  });

  it('an element block may not appear in an interpolated key, which is resolved before the tree', () => {
    loadError('@v = [{ a = 1 }]\n"@{v}" = 1', {}, 'resolve');
  });
});

describe('merge: an empty block (CASC.md §5.4)', () => {
  it('is an empty map', () => {
    expect(load('a {}\nb = {}\nc = [{}]')).to.deep.equal({ a: {}, b: {}, c: [{}] });
  });

  it('written over a map, leaves it as it is', () => {
    expect(load('w.x = 1\nw {}')).to.deep.equal({ w: { x: 1 } });
  });

  it('written over anything else, replaces it', () => {
    expect(load('w = 1\nw {}')).to.deep.equal({ w: {} });
  });

  it('~ empties a map', () => {
    expect(load('w.x = 1\n~w {}')).to.deep.equal({ w: {} });
  });
});
