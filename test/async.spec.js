import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFile, loadFileSync, Cache, Secret } from '../src/cooper.js';
import { HEADER, load, loadAsync, throwsCooper, rejectsCooper } from './support/harness.js';

/**
 * Async extension points (resolvers, tags, import-scheme loaders) with the
 * Promise-returning API, and the `*Sync` variants' refusal of them.
 */

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('async: callbacks returning Promises with loadString/loadFile', () => {
  it('async resolvers, tags and import schemes all work together', async () => {
    const result = await loadAsync('import "mem://m"\na = !{vault:x}\nb = !shout("q")\nc = "pre-%{a}"', {
      resolvers: { vault: async (/** @type {string} */ p) => (await tick(), `R${p}`) },
      tags: { shout: async (/** @type {string} */ s) => (await tick(), s.toUpperCase()) },
      importSchemes: { mem: async (/** @type {string} */ rest) => (await tick(), `${HEADER}m = "${rest}"\n`) },
    });
    expect(result).to.deep.equal({ m: 'm', a: 'Rx', b: 'Q', c: 'pre-Rx' });
  });

  it('sync callbacks still work with the async API', async () => {
    expect(await loadAsync('a = !{echo:x}', { resolvers: { echo: (/** @type {string} */ p) => p } })).to.deep.equal({ a: 'x' });
  });

  it('a resolver result under a *key is wrapped as a secret', async () => {
    const { pw } = await loadAsync('*pw = !{vault:x}', { resolvers: { vault: async () => 'hunter2' } });
    expect(pw).to.be.instanceOf(Secret);
    expect(pw.reveal()).to.equal('hunter2');
  });

  it('an async tag receives an argument resolved by an async resolver', async () => {
    const result = await loadAsync('a = !wrap(!{vault:x})', {
      resolvers: { vault: async () => 'inner' },
      tags: { wrap: async (/** @type {string} */ s) => `[${s}]` },
    });
    expect(result).to.deep.equal({ a: '[inner]' });
  });

  it('loadFile works with an async import scheme', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-async-'));
    try {
      const file = path.join(dir, 'app.casc');
      fs.writeFileSync(file, `${HEADER}import "mem://x"\nlocal = 1\n`);
      const importSchemes = { mem: async () => `${HEADER}remote = 2\n` };
      expect(await loadFile(file, { dotenv: false, env: {}, cache: false, importSchemes })).to.deep.equal({ remote: 2, local: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      Cache.clear();
    }
  });
});

describe('async: the *Sync variants refuse a callback returning a Promise', () => {
  /** @type {unknown[]} */
  let unhandled;
  const onUnhandled = (/** @type {unknown} */ reason) => unhandled.push(reason);

  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
  });

  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
  });

  const cases = /** @type {Array<[string, string, object, string, string]>} */ ([
    ['resolver', 'a = !{vault:x}', { resolvers: { vault: async () => 1 } }, 'resolve', 'resolver "vault"'],
    ['tag', 'a = !later(1)', { tags: { later: async () => 1 } }, 'resolve', '!later'],
    ['import scheme', 'import "mem://x"', { importSchemes: { mem: async () => HEADER } }, 'import', 'import scheme "mem"'],
  ]);

  for (const [kind, source, opts, stage, name] of cases) {
    it(`a ${kind} returning a Promise is a CooperError naming it (stage ${stage})`, () => {
      const err = throwsCooper(() => load(source, opts), stage);
      expect(err.message).to.contain(name);
      expect(err.message).to.contain('Promise');
    });
  }

  it('a rejected Promise is never left as an unhandled rejection', async () => {
    throwsCooper(() => load('a = !{vault:x}', { resolvers: { vault: () => Promise.reject(new Error('rejected')) } }), 'resolve');
    throwsCooper(() => load('import "mem://x"', { importSchemes: { mem: () => Promise.reject(new Error('rejected')) } }), 'import');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(unhandled).to.deep.equal([]);
  });

  it('loadFileSync refuses an async import scheme too', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-async-'));
    try {
      const file = path.join(dir, 'app.casc');
      fs.writeFileSync(file, `${HEADER}import "mem://x"\n`);
      throwsCooper(() => loadFileSync(file, { dotenv: false, env: {}, importSchemes: { mem: async () => HEADER } }), 'import');
      expect(Cache.size()).to.equal(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      Cache.clear();
    }
  });

  it('a callback inside a skipped (${?NAME}-guarded) statement is never called', () => {
    let called = false;
    const resolvers = { vault: () => ((called = true), Promise.resolve(1)) };
    expect(load('${?COOPER_TEST_UNSET_GUARD}\na = !{vault:x}\nb = 1', { resolvers })).to.deep.equal({ b: 1 });
    expect(called).to.equal(false);
  });
});

describe('async: thrown errors become CooperErrors', () => {
  const cases = /** @type {Array<[string, string, object, string]>} */ ([
    ['resolver', 'a = !{vault:x}', { resolvers: { vault: () => { throw new Error('boom-resolver'); } } }, 'resolve'],
    ['tag', 'a = !t(1)', { tags: { t: () => { throw new Error('boom-tag'); } } }, 'resolve'],
    ['import scheme', 'import "mem://x"', { importSchemes: { mem: () => { throw new Error('boom-scheme'); } } }, 'import'],
  ]);

  for (const [kind, source, opts, stage] of cases) {
    it(`a ${kind} that throws fails with stage ${stage}, sync and async, keeping the cause`, async () => {
      const syncErr = throwsCooper(() => load(source, opts), stage);
      expect(syncErr.message).to.contain('boom-');
      const asyncErr = await rejectsCooper(loadAsync(source, opts), stage);
      expect(asyncErr.message).to.equal(syncErr.message);
    });
  }

  it('an async resolver that rejects fails with stage resolve', async () => {
    const err = await rejectsCooper(loadAsync('a = !{vault:x}', { resolvers: { vault: async () => { throw new Error('later'); } } }), 'resolve');
    expect(err.message).to.contain('later');
  });

  it('a thrown non-Error value is still wrapped', async () => {
    await rejectsCooper(loadAsync('a = !{vault:x}', { resolvers: { vault: () => { throw 'a string'; } } }), 'resolve');
  });
});

describe('async: each !{...} occurrence is resolved exactly once', () => {
  it('even when referenced via %{...} from several places', async () => {
    for (const run of [(/** @type {any} */ o) => Promise.resolve(load('a = !{count:x}\nb = %{a}\nc = "pre-%{a}"\nd = [%{a}, %{b}]', o)),
      (/** @type {any} */ o) => loadAsync('a = !{count:x}\nb = %{a}\nc = "pre-%{a}"\nd = [%{a}, %{b}]', o)]) {
      /** @type {string[]} */
      const calls = [];
      const result = await run({ resolvers: { count: (/** @type {string} */ p) => (calls.push(p), calls.length) } });
      expect(result).to.deep.equal({ a: 1, b: 1, c: 'pre-1', d: [1, 1] });
      expect(calls).to.deep.equal(['x']);
    }
  });

  it('two separate occurrences are two calls', async () => {
    let calls = 0;
    const result = await loadAsync('a = !{count:x}\nb = !{count:x}', { resolvers: { count: async () => ++calls } });
    expect(calls).to.equal(2);
    expect([result.a, result.b].sort()).to.deep.equal([1, 2]);
  });

  it('a !{...} inside a variable is resolved once however many times the variable is used', () => {
    let calls = 0;
    const result = load('@v = !{count:x}\na = @{v}\nb = @{v}\nc = "@{v}"', { resolvers: { count: () => ++calls } });
    expect(result).to.deep.equal({ a: 1, b: 1, c: '1' });
    expect(calls).to.equal(1);
  });
});
