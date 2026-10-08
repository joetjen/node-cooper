import { expect } from 'chai';
import path from 'node:path';
import { loadFileSync, loadFile } from '../../src/cooper.js';
import { load, loadAsync, loadError, throwsCooper, rejectsCooper, FIXTURES, HEADER } from '../support/harness.js';

/** CASC.md §5.1 imports and §5.2 variable visibility, against `test/fixtures`. */

const fixture = (/** @type {string[]} */ ...parts) => path.join(FIXTURES, ...parts);
const loadFixture = (/** @type {string} */ file, opts = {}) => loadFileSync(file, { dotenv: false, env: {}, cache: false, ...opts });

describe('imports: a bare (no scheme://) import (CASC.md §5.1)', () => {
  it('resolves relative to the importing file, and later statements override the import', () => {
    expect(loadFixture(fixture('imports', 'main.casc'))).to.deep.equal({
      server: { host: '0.0.0.0', port: 9090 },
      app: { name: 'shared' },
    });
  });

  it('with loadString, a bare import resolves against the `root` option', () => {
    expect(load('import "base.casc"\nv = "@{shared_name}"', { root: fixture('imports') })).to.deep.equal({
      server: { host: '0.0.0.0', port: 8080 },
      v: 'shared',
    });
  });

  it('later imports override earlier ones for the same path', () => {
    expect(loadFixture(fixture('import_order', 'main.casc'))).to.deep.equal({ value: 'second' });
  });

  it('public variables are visible transitively, across import-of-import', () => {
    expect(loadFixture(fixture('transitive_imports', 'top.casc'))).to.deep.equal({ value: 'from-deepest' });
  });
});

describe('imports: variable visibility, resolved (CASC.md §5.2)', () => {
  /** @type {Record<string, any>} */
  let result;
  before(() => {
    result = loadFixture(fixture('visibility', 'main.casc'));
  });

  it('a private variable is usable inside its own file', () => {
    expect(result.entry.own_private).to.equal('entry-private');
  });

  it('an imported file can use its own private variable', () => {
    expect(result.shared.own_private).to.equal('shared-private');
  });

  it("the importer's private variable is not visible to an imported file", () => {
    expect(result.shared.from_importer_private).to.equal('MISSING');
  });

  it("an imported file's private variable is not visible to the importer", () => {
    expect(result.entry.imported_private).to.equal('MISSING');
  });

  it('a public variable travels up, from the imported file to the importer', () => {
    expect(result.entry.imported_public).to.equal('shared-public');
  });

  it('a public variable travels down, from the importer to the imported file', () => {
    expect(result.shared.from_importer_public).to.equal('entry-public');
  });

  it("two files' identically named private variables stay independent", () => {
    expect(result.shared.own_private).to.equal('shared-private');
    expect(result.other.own_private).to.equal('other-private');
  });

  it("the imported file's private variable never leaks to the importer (fixture imports/base.casc)", () => {
    expect(load('import "base.casc"\nv = @{local_only:"absent"}', { root: fixture('imports') }).v).to.equal('absent');
  });
});

describe('imports: brace and glob expansion (CASC.md §5.1)', () => {
  it('expands {a,b} and ** against the filesystem, loading matches in lexicographic order', () => {
    expect(loadFixture(fixture('imports', 'glob_main.casc'))).to.deep.equal({ val: 'dev-z', order_marker: 'last' });
  });
});

describe('imports: the environment reaches imported files', () => {
  it('a ${?FLAG} guard inside an imported file sees the load env, unset', () => {
    expect(loadFixture(fixture('import_env_guard', 'main.casc'), { env: { FLAG: '' } })).to.deep.equal({ name: 'base' });
  });

  it('a ${?FLAG} guard inside an imported file sees the load env, set', () => {
    expect(loadFixture(fixture('import_env_guard', 'main.casc'), { env: { FLAG: '1' } })).to.deep.equal({ name: 'base', enabled: true });
  });
});

describe('imports: cycle detection', () => {
  it('a cycle back to the entry file is caught on the first repeat, naming the chain', () => {
    const { message } = throwsCooper(() => loadFixture(fixture('imports', 'cycle_a.casc')), 'import');
    expect(message).to.contain('cycle_a.casc').and.contain('cycle_b.casc');
    expect(message).not.to.match(/cycle_b\.casc -> \S*cycle_b\.casc/);
  });

  it('a scheme import cycle is detected too', () => {
    const importSchemes = { mem: () => `${HEADER}import "mem://self"\n` };
    expect(loadError('import "mem://self"', { importSchemes }, 'import').message).to.contain('cycle');
  });
});

describe('imports: scheme:// imports (CASC.md §5.1, §9.3)', () => {
  it('dispatches everything after scheme:// to the registered loader', () => {
    /** @type {string[]} */
    const seen = [];
    const importSchemes = {
      mem: (/** @type {string} */ rest) => {
        seen.push(rest);
        return `${HEADER}from_mem = "${rest}"\n@mem_var = 1\n`;
      },
    };
    expect(load('import "mem://some/key?x=1"\nv = @{mem_var}', { importSchemes })).to.deep.equal({ from_mem: 'some/key?x=1', v: 1 });
    expect(seen).to.deep.equal(['some/key?x=1']);
  });

  it('later statements override a scheme import like any other', () => {
    const importSchemes = { mem: () => `${HEADER}a = 1\nb = 1\n` };
    expect(load('import "mem://x"\nb = 2', { importSchemes })).to.deep.equal({ a: 1, b: 2 });
  });

  it('a loader may be async with the async API', async () => {
    const importSchemes = { mem: async () => `${HEADER}a = 1\n` };
    expect(await loadAsync('import "mem://x"', { importSchemes })).to.deep.equal({ a: 1 });
  });

  it('an unregistered scheme is an import error naming it', () => {
    expect(loadError('import "myscheme://foo"', {}, 'import').message).to.contain('myscheme');
  });

  it('a loader that throws is an import error', () => {
    const importSchemes = { mem: () => { throw new Error('enoent'); } };
    expect(loadError('import "mem://x"', { importSchemes }, 'import').message).to.contain('enoent');
  });

  it('a loader returning text that does not parse fails the load', () => {
    throwsCooper(() => load('import "mem://x"', { importSchemes: { mem: () => 'not casc at all {' } }));
  });
});

describe('imports: failure cases', () => {
  it('a pattern matching no files is an import error', () => {
    loadError('import "does/not/exist/*.casc"', { root: fixture('imports') }, 'import');
  });

  it('a missing plain file is an import error', () => {
    loadError('import "nope.casc"', { root: fixture('imports') }, 'import');
  });

  it('an import path interpolating @{...} is an import error', () => {
    loadError('import "@{some_var}"', { root: fixture('imports') }, 'import');
  });

  it('loadFile of a nonexistent file is an import error, sync and async', async () => {
    throwsCooper(() => loadFileSync('/does/not/exist/nope.casc'), 'import');
    await rejectsCooper(loadFile('/does/not/exist/nope.casc'), 'import');
  });
});
