import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as esm from '../src/cooper.js';
import esmDefault from '../src/cooper.js';
import { canon } from './support/canon.js';
import { FIXTURES, HEADER, throwsCooper, rejectsCooper } from './support/harness.js';

const { loadString, loadStringSync, loadFile, loadFileSync, Tuple, Secret, CooperError, Cache } = esm;
const require = createRequire(import.meta.url);
const cjs = require('../src/cooper.cjs');

const opts = (/** @type {object} */ extra = {}) => ({ dotenv: false, env: {}, ...extra });

describe('public API: entry points', () => {
  const NAMES = [
    'version', 'loadFile', 'loadFileSync', 'loadString', 'loadStringSync', 'CooperError', 'Cache', 'Dotenv',
    'Secret', 'Tuple', 'Duration', 'ByteSize', 'LocalDate', 'LocalTime', 'LocalDateTime', 'IPv4', 'IPv6', 'ModuleRef',
  ];

  it('the ESM named exports, the ESM default export and the CJS module expose the same objects', () => {
    for (const name of NAMES) {
      expect(/** @type {any} */ (esm)[name], `esm ${name}`).to.exist;
      expect(/** @type {any} */ (esm)[name], `esm ${name} === cjs`).to.equal(cjs[name]);
      expect(/** @type {any} */ (esmDefault)[name], `default ${name}`).to.equal(cjs[name]);
    }
  });

  it('exposes a semver version string', () => {
    expect(esm.version).to.be.a('string').and.match(/^\d+\.\d+\.\d+/);
  });

  it('ESM and CJS loads agree on the same source', async () => {
    const source = `${HEADER}a.b = 1\n*s = "x"\nt = (1, 2)\nl = [1, :x]\nd = 5s`;
    const viaEsm = canon(loadStringSync(source, opts()));
    expect(canon(cjs.loadStringSync(source, opts()))).to.deep.equal(viaEsm);
    expect(canon(await cjs.loadString(source, opts()))).to.deep.equal(viaEsm);
  });

  it('an error from the CJS entry point is the same CooperError class', () => {
    throwsCooper(() => cjs.loadStringSync('not casc', opts()));
    try {
      cjs.loadStringSync('not casc', opts());
    } catch (err) {
      expect(err).to.be.instanceOf(cjs.CooperError);
    }
  });
});

describe('public API: loadString / loadStringSync, end to end', () => {
  it("CASC.md §5.4's dotted-path / nested-block equivalence", () => {
    for (const form of ['foo { bar { baz = "dronf" } }', 'foo { bar.baz "dronf" }', 'foo = { bar = { baz = "dronf" } }', 'foo.bar.baz "dronf"']) {
      expect(loadStringSync(HEADER + form, opts()), form).to.deep.equal({ foo: { bar: { baz: 'dronf' } } });
    }
  });

  it('the async and sync variants return the same result', async () => {
    const source = `${HEADER}@x = 1\na = @{x}\nb = "%{a}"\nc = \${COOPER_TEST_UNSET_API:"d"}`;
    const sync = loadStringSync(source, opts());
    expect(sync).to.deep.equal({ a: 1, b: '1', c: 'd' });
    expect(await loadString(source, opts())).to.deep.equal(sync);
  });

  it('loadString returns a Promise even for an invalid document, rejecting with CooperError', async () => {
    const pending = loadString('not casc', opts());
    expect(pending).to.be.instanceOf(Promise);
    await rejectsCooper(pending);
  });

  it('the options argument is optional', () => {
    expect(loadStringSync(`${HEADER}a = 1`)).to.deep.equal({ a: 1 });
  });

  it('a missing version header is an error; an empty document is an error', () => {
    throwsCooper(() => loadStringSync('', opts()));
    throwsCooper(() => loadStringSync('foo = 1\n#@version = 1.0\n', opts()));
  });

  it('a header-only document loads to an empty object', () => {
    expect(loadStringSync('#@version = 1.0\n', opts())).to.deep.equal({});
  });
});

describe('public API: tuples come back as real Tuples, never arrays (CASC.md §6.11)', () => {
  it('a bare tuple literal', () => {
    const { office_location: loc } = loadStringSync(`${HEADER}office_location = (52.5200, 13.4050)`, opts());
    expect(loc).to.be.instanceOf(Tuple);
    expect(Array.isArray(loc)).to.equal(false);
    expect(loc.items).to.deep.equal([52.52, 13.405]);
  });

  it('a tuple survives resolution untouched by list handling', () => {
    const { loc } = loadStringSync(`${HEADER}@x = 1\nloc = (@{x}, 2)`, opts());
    expect(loc).to.be.instanceOf(Tuple);
    expect(loc.items).to.deep.equal([1, 2]);
  });
});

describe('public API: extensibility options (CASC.md §9.4)', () => {
  it('an unregistered !Name(...) tag fails, naming it', () => {
    expect(throwsCooper(() => loadStringSync(`${HEADER}v = !uuid("x")`, opts()), 'resolve').message).to.contain('uuid');
  });

  it('a registered tag, resolver and import scheme all work together', () => {
    const result = loadStringSync(`${HEADER}import "mem://x"\na = !shout("hi")\nb = !{echo:hello}`, opts({
      tags: { shout: (/** @type {string} */ s) => s.toUpperCase() },
      resolvers: { echo: (/** @type {string} */ p) => p },
      importSchemes: { mem: () => `${HEADER}m = 1\n` },
    }));
    expect(result).to.deep.equal({ m: 1, a: 'HI', b: 'hello' });
  });

  it('tags may be passed as a Map', () => {
    const tags = new Map([['twice', (/** @type {number} */ n) => n * 2]]);
    expect(loadStringSync(`${HEADER}v = !twice(21)`, opts({ tags }))).to.deep.equal({ v: 42 });
  });
});

describe('public API: the `file` and `root` options (loadString)', () => {
  it('`root` is where bare imports resolve from', () => {
    expect(loadStringSync(`${HEADER}import "a.casc"`, opts({ root: path.join(FIXTURES, 'import_order') }))).to.deep.equal({ value: 'first' });
  });

  it('`root` defaults to process.cwd()', () => {
    const cwd = process.cwd();
    process.chdir(path.join(FIXTURES, 'import_order'));
    try {
      expect(loadStringSync(`${HEADER}import "b.casc"`, opts())).to.deep.equal({ value: 'second' });
    } finally {
      process.chdir(cwd);
    }
  });

  it('`file` takes part in import-cycle detection', () => {
    const file = path.join(FIXTURES, 'imports', 'cycle_a.casc');
    const err = throwsCooper(
      () => loadStringSync(`${HEADER}import "cycle_b.casc"\n`, opts({ root: path.dirname(file), file })),
      'import'
    );
    expect(err.message).to.contain('cycle');
  });
});

describe('public API: loadFile / loadFileSync', () => {
  it('loads a real file, with imports resolving relative to it', async () => {
    const file = path.join(FIXTURES, 'imports', 'main.casc');
    const expected = { server: { host: '0.0.0.0', port: 9090 }, app: { name: 'shared' } };
    expect(loadFileSync(file, opts({ cache: false }))).to.deep.equal(expected);
    expect(await loadFile(file, opts({ cache: false }))).to.deep.equal(expected);
  });

  it('accepts a path relative to process.cwd()', () => {
    const relative = path.relative(process.cwd(), path.join(FIXTURES, 'import_order', 'main.casc'));
    expect(loadFileSync(relative, opts({ cache: false }))).to.deep.equal({ value: 'second' });
  });

  it('a nonexistent file is an import error naming it', async () => {
    expect(throwsCooper(() => loadFileSync('/does/not/exist/nope.casc', opts()), 'import').message).to.contain('nope.casc');
    await rejectsCooper(loadFile('/does/not/exist/nope.casc', opts()), 'import');
  });

  it('an explicit `root` overrides the file directory for bare imports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-api-'));
    try {
      const file = path.join(dir, 'entry.casc');
      fs.writeFileSync(file, `${HEADER}import "a.casc"\n`);
      expect(loadFileSync(file, opts({ cache: false, root: path.join(FIXTURES, 'import_order') }))).to.deep.equal({ value: 'first' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  after(() => Cache.clear());
});

describe('public API: errors carry a pipeline stage', () => {
  const cases = /** @type {Array<[string, string, object?]>} */ ([
    ['parser', 'a = = ='],
    ['loop', 'for @i as x { k = 1 }'],
    ['import', 'import "nope://x"'],
    ['merge', 't = (1, 2)\n+t = [1]'],
    ['resolve', 'a = @{undefined_variable}'],
  ]);

  for (const [stage, body] of cases) {
    it(`${stage}: ${JSON.stringify(body)}`, () => {
      const err = throwsCooper(() => loadStringSync(HEADER + body, opts()), stage);
      expect(err).to.be.instanceOf(Error);
      expect(err.name).to.equal('CooperError');
    });
  }

  it('a lexer/parser error carries a line and column', () => {
    const err = throwsCooper(() => loadStringSync(`${HEADER}a = = =`, opts()));
    expect(err.line).to.equal(2);
    expect(err.column).to.be.a('number');
  });

  it('CooperError.wrap passes a CooperError through and wraps anything else', () => {
    const original = new CooperError('x', { stage: 'merge' });
    expect(CooperError.wrap(original, 'resolve')).to.equal(original);
    const wrapped = CooperError.wrap(new Error('boom'), 'resolve');
    expect(wrapped).to.be.instanceOf(CooperError);
    expect(wrapped.stage).to.equal('resolve');
    expect(wrapped.message).to.equal('boom');
  });
});

describe('public API: secrets in results (CASC.md §4.3)', () => {
  it('a %{...} copy embedded in a string is partially redacted', () => {
    const { connection_string: conn } = loadStringSync(
      `${HEADER}database { *password = "hunter2", host = "db.internal" }\nconnection_string = "postgres://%{database.host}?pw=%{database.password}"`,
      opts()
    );
    expect(conn).to.be.instanceOf(Secret);
    expect(String(conn)).to.equal('postgres://db.internal?pw=[~~REDACTED~~]');
    expect(conn.reveal()).to.equal('postgres://db.internal?pw=hunter2');
  });
});
