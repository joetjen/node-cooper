import { expect } from 'chai';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import diagnostics from 'node:diagnostics_channel';
import { loadFile, loadFileSync, Cache } from '../src/cooper.js';
import { HEADER, throwsCooper } from './support/harness.js';

/**
 * `loadFile`'s cache (`src/cache.cjs`): the pre-resolve tree is reused while
 * every contributing file keeps its mtime; `${...}` is re-resolved on every
 * call; diagnostics channels report reloads and watched env changes.
 *
 * Every write pins an explicit mtime (`fs.utimesSync`) so two writes in one
 * test can never collide on the filesystem's mtime resolution.
 */

describe('Cache (loadFile caching)', () => {
  /** @type {string} */
  let dir;
  /** @type {Array<() => void>} */
  let cleanups;
  /** @type {Map<string, string | undefined>} */
  const savedEnv = new Map();

  beforeEach(() => {
    Cache.clear();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-cache-'));
    cleanups = [];
  });

  afterEach(() => {
    Cache.clear();
    Cache.configure({ pollInterval: 5000 });
    for (const cleanup of cleanups.splice(0)) cleanup();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * @param {string} name
   * @param {string | undefined} value
   */
  function setEnv(name, value) {
    if (!savedEnv.has(name)) savedEnv.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  /**
   * Writes `content` to `dir/name` with the given mtime (seconds; a base far
   * in the future so a real-clock write can never coincide with it).
   * @param {string} name
   * @param {number} mtime
   * @param {string} content
   */
  function write(name, mtime, content) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    const t = 4_000_000_000 + mtime;
    fs.utimesSync(file, t, t);
    return file;
  }

  /**
   * Collects messages published on a diagnostics channel until the test ends.
   * @param {string} name
   * @returns {any[]}
   */
  function listen(name) {
    /** @type {any[]} */
    const messages = [];
    const handler = (/** @type {any} */ message) => messages.push(message);
    diagnostics.subscribe(name, handler);
    cleanups.push(() => diagnostics.unsubscribe(name, handler));
    return messages;
  }

  /**
   * Polls `predicate` until true or `timeout` ms pass.
   * @param {() => boolean} predicate
   * @param {number} [timeout]
   */
  async function eventually(predicate, timeout = 2000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  }

  const opts = (/** @type {object} */ extra = {}) => ({ dotenv: false, env: {}, ...extra });

  describe('a hit reuses the parsed tree', () => {
    it('an edit with the mtime pinned back to the same value is not observed', () => {
      const file = write('hit.casc', 1000, `${HEADER}name = "first"\n`);
      expect(loadFileSync(file, opts())).to.deep.equal({ name: 'first' });
      write('hit.casc', 1000, `${HEADER}name = "second"\n`);
      expect(loadFileSync(file, opts())).to.deep.equal({ name: 'first' });
      expect(Cache.size()).to.equal(1);
    });

    it('sync and async loads share the same cache', async () => {
      const file = write('shared.casc', 1000, `${HEADER}name = "first"\n`);
      expect(await loadFile(file, opts())).to.deep.equal({ name: 'first' });
      write('shared.casc', 1000, `${HEADER}name = "second"\n`);
      expect(loadFileSync(file, opts())).to.deep.equal({ name: 'first' });
    });

    it('each call returns a fresh result object (mutating one does not affect the next)', () => {
      const file = write('fresh.casc', 1000, `${HEADER}a { b = [1] }\n`);
      const first = loadFileSync(file, opts());
      first.a.b.push(2);
      first.a.c = 1;
      expect(loadFileSync(file, opts())).to.deep.equal({ a: { b: [1] } });
    });
  });

  describe('${...} resolution is always fresh, hit or miss', () => {
    it('a changed env option is reflected on a cache hit', () => {
      const file = write('env.casc', 2000, `${HEADER}value = \${COOPER_CACHE_TEST_VAR:"default"}\n`);
      expect(loadFileSync(file, opts({ watchEnv: false }))).to.deep.equal({ value: 'default' });
      write('env.casc', 2000, `${HEADER}value = "edited"\n`); // proves the next calls are hits
      expect(loadFileSync(file, opts({ watchEnv: false, env: { COOPER_CACHE_TEST_VAR: 'live' } }))).to.deep.equal({ value: 'live' });
    });

    it('a changed process.env value is reflected on a cache hit', () => {
      setEnv('COOPER_CACHE_TEST_VAR', undefined);
      const file = write('env2.casc', 2000, `${HEADER}value = \${COOPER_CACHE_TEST_VAR:"default"}\n`);
      expect(loadFileSync(file, opts({ watchEnv: false }))).to.deep.equal({ value: 'default' });
      setEnv('COOPER_CACHE_TEST_VAR', 'live');
      expect(loadFileSync(file, opts({ watchEnv: false }))).to.deep.equal({ value: 'live' });
    });

    it('resolvers run again on every hit', () => {
      let calls = 0;
      const resolvers = { count: () => ++calls };
      const file = write('resolver.casc', 2000, `${HEADER}n = !{count:x}\n`);
      expect(loadFileSync(file, opts({ resolvers }))).to.deep.equal({ n: 1 });
      expect(loadFileSync(file, opts({ resolvers }))).to.deep.equal({ n: 2 });
    });
  });

  describe('invalidation by mtime', () => {
    it("a file's own mtime change invalidates its entry", () => {
      const file = write('miss.casc', 3000, `${HEADER}name = "before"\n`);
      expect(loadFileSync(file, opts())).to.deep.equal({ name: 'before' });
      write('miss.casc', 3001, `${HEADER}name = "after"\n`);
      expect(loadFileSync(file, opts())).to.deep.equal({ name: 'after' });
    });

    it("changing only an imported file busts the importer's entry", async () => {
      write('base.casc', 4000, `${HEADER}shared = "base-v1"\n`);
      const importer = write('importer.casc', 4000, `${HEADER}import "base.casc"\n`);
      expect(await loadFile(importer, opts())).to.deep.equal({ shared: 'base-v1' });
      write('base.casc', 4001, `${HEADER}shared = "base-v2"\n`);
      expect(await loadFile(importer, opts())).to.deep.equal({ shared: 'base-v2' });
    });

    it('a transitively imported file is fingerprinted too', () => {
      write('deep.casc', 4000, `${HEADER}v = 1\n`);
      write('mid.casc', 4000, `${HEADER}import "deep.casc"\n`);
      const top = write('top.casc', 4000, `${HEADER}import "mid.casc"\n`);
      expect(loadFileSync(top, opts())).to.deep.equal({ v: 1 });
      write('deep.casc', 4001, `${HEADER}v = 2\n`);
      expect(loadFileSync(top, opts())).to.deep.equal({ v: 2 });
    });

    it('deleting an imported file surfaces the ordinary read error, not a stale hit', () => {
      const base = write('base.casc', 4100, `${HEADER}shared = "v1"\n`);
      const importer = write('importer.casc', 4100, `${HEADER}import "base.casc"\n`);
      expect(loadFileSync(importer, opts())).to.deep.equal({ shared: 'v1' });
      fs.rmSync(base);
      throwsCooper(() => loadFileSync(importer, opts()), 'import');
    });

    it('property: every distinct-mtime write is observed on the very next load', () => {
      fc.assert(
        fc.property(fc.array(fc.string({ unit: fc.constantFrom('a', 'b', 'c', 'x'), minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 8 }), (names) => {
          Cache.clear();
          names.forEach((name, i) => {
            const file = write('prop.casc', 5000 + i, `${HEADER}name = "${name}"\n`);
            expect(loadFileSync(file, opts())).to.deep.equal({ name });
          });
        }),
        { numRuns: 25 }
      );
    });
  });

  describe('a glob import', () => {
    // The fingerprint once held only the files a load read, so a file added
    // where `import "parts/*.casc"` looks was never noticed: the cached tree
    // kept loading without it.
    /** @type {string} */
    let app;
    beforeEach(() => {
      fs.mkdirSync(path.join(dir, 'parts'));
      app = write('app.casc', 9500, `${HEADER}import "parts/*.casc"\n`);
      write('parts/a.casc', 9500, `${HEADER}a = 1\n`);
    });

    it('a file added where it looks is read on the next load', () => {
      expect(loadFileSync(app, opts())).to.deep.equal({ a: 1 });
      write('parts/b.casc', 9500, `${HEADER}b = 2\n`);
      expect(loadFileSync(app, opts())).to.deep.equal({ a: 1, b: 2 });
    });

    it('a file deleted from where it looks is gone on the next load', () => {
      const b = write('parts/b.casc', 9500, `${HEADER}b = 2\n`);
      expect(loadFileSync(app, opts())).to.deep.equal({ a: 1, b: 2 });
      fs.rmSync(b);
      expect(loadFileSync(app, opts())).to.deep.equal({ a: 1 });
    });

    it('a file the pattern does not match leaves the entry cached', () => {
      loadFileSync(app, opts());
      const messages = listen(Cache.CHANNEL_FILE_CHANGED);
      write('parts/notes.txt', 9500, 'not casc');
      loadFileSync(app, opts());
      expect(messages).to.have.length(0);
    });

    it('the change names the file added', async () => {
      await loadFile(app, opts());
      const messages = listen(Cache.CHANNEL_FILE_CHANGED);
      const added = write('parts/b.casc', 9500, `${HEADER}b = 2\n`);
      await loadFile(app, opts());
      expect(messages).to.have.length(1);
      expect(messages[0].changedFiles).to.deep.equal([added]);
    });

    it('a brace pattern is expanded again the same way', () => {
      const braced = write('braced.casc', 9500, `${HEADER}import "parts/{a,b}.casc"\n`);
      expect(loadFileSync(braced, opts())).to.deep.equal({ a: 1 });
      write('parts/b.casc', 9500, `${HEADER}b = 2\n`);
      expect(loadFileSync(braced, opts())).to.deep.equal({ a: 1, b: 2 });
    });
  });

  describe('cache: false', () => {
    it('bypasses the cache entirely -- never reads or populates an entry', () => {
      const file = write('bypass.casc', 5000, `${HEADER}name = "one"\n`);
      expect(loadFileSync(file, opts({ cache: false }))).to.deep.equal({ name: 'one' });
      expect(Cache.size()).to.equal(0);
      loadFileSync(file, opts()); // populate
      write('bypass.casc', 5000, `${HEADER}name = "two"\n`);
      expect(loadFileSync(file, opts({ cache: false }))).to.deep.equal({ name: 'two' });
      expect(loadFileSync(file, opts())).to.deep.equal({ name: 'one' });
    });
  });

  describe('Cache.invalidate / clear / size', () => {
    it('invalidate removes only the given path, leaving others untouched', () => {
      const a = write('inv_a.casc', 6000, `${HEADER}name = "a"\n`);
      const b = write('inv_b.casc', 6000, `${HEADER}name = "b"\n`);
      loadFileSync(a, opts());
      loadFileSync(b, opts());
      expect(Cache.size()).to.equal(2);
      Cache.invalidate(a);
      expect(Cache.size()).to.equal(1);
      write('inv_a.casc', 6000, `${HEADER}name = "a2"\n`);
      write('inv_b.casc', 6000, `${HEADER}name = "b2"\n`);
      expect(loadFileSync(a, opts())).to.deep.equal({ name: 'a2' });
      expect(loadFileSync(b, opts())).to.deep.equal({ name: 'b' });
    });

    it('invalidate accepts a relative path', () => {
      const file = write('rel.casc', 6000, `${HEADER}name = "x"\n`);
      loadFileSync(file, opts());
      Cache.invalidate(path.relative(process.cwd(), file));
      expect(Cache.size()).to.equal(0);
    });

    it('clear removes every entry', () => {
      loadFileSync(write('c1.casc', 7000, `${HEADER}x = 1\n`), opts());
      loadFileSync(write('c2.casc', 7000, `${HEADER}x = 2\n`), opts());
      expect(Cache.size()).to.equal(2);
      Cache.clear();
      expect(Cache.size()).to.equal(0);
    });

    it('configure rejects a non-positive poll interval', () => {
      expect(() => Cache.configure({ pollInterval: 0 })).to.throw(RangeError);
      expect(() => Cache.configure({ pollInterval: -5 })).to.throw(RangeError);
    });
  });

  describe('concurrent async misses', () => {
    it('coalesce into exactly one load', async () => {
      let calls = 0;
      const importSchemes = {
        slow: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 30));
          return `${HEADER}stub = true\n`;
        },
      };
      const file = write('concurrent.casc', 8000, `${HEADER}import "slow://x"\n`);
      const results = await Promise.all(Array.from({ length: 10 }, () => loadFile(file, opts({ importSchemes }))));
      for (const result of results) expect(result).to.deep.equal({ stub: true });
      expect(calls).to.equal(1);
    });

    it('a failed coalesced load rejects every waiter and is not cached', async () => {
      let calls = 0;
      const importSchemes = {
        bad: async () => {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          throw new Error('nope');
        },
      };
      const file = write('fail.casc', 8000, `${HEADER}import "bad://x"\n`);
      const settled = await Promise.allSettled([loadFile(file, opts({ importSchemes })), loadFile(file, opts({ importSchemes }))]);
      expect(settled.map((s) => s.status)).to.deep.equal(['rejected', 'rejected']);
      expect(calls).to.equal(1);
      expect(Cache.size()).to.equal(0);
    });
  });

  describe(`diagnostics channel ${Cache.CHANNEL_FILE_CHANGED}`, () => {
    it('is named cooper:cache:file_changed', () => {
      expect(Cache.CHANNEL_FILE_CHANGED).to.equal('cooper:cache:file_changed');
    });

    it('publishes on a real reload, never on first population', () => {
      const messages = listen(Cache.CHANNEL_FILE_CHANGED);
      const file = write('telem.casc', 9000, `${HEADER}name = "first"\n`);
      loadFileSync(file, opts());
      expect(messages).to.have.length(0);
      loadFileSync(file, opts()); // a hit publishes nothing either
      expect(messages).to.have.length(0);
      write('telem.casc', 9001, `${HEADER}name = "second"\n`);
      loadFileSync(file, opts());
      expect(messages).to.have.length(1);
      expect(messages[0].path).to.equal(file);
      expect(messages[0].root).to.equal(dir);
      expect(messages[0].changedFiles).to.deep.equal([file]);
      expect(messages[0].systemTime).to.be.a('number');
    });

    it('names a transitively imported file when only it changes', async () => {
      const base = write('base.casc', 9100, `${HEADER}shared = "v1"\n`);
      const importer = write('importer.casc', 9100, `${HEADER}import "base.casc"\n`);
      const messages = listen(Cache.CHANNEL_FILE_CHANGED);
      await loadFile(importer, opts());
      write('base.casc', 9101, `${HEADER}shared = "v2"\n`);
      await loadFile(importer, opts());
      expect(messages).to.have.length(1);
      expect(messages[0].changedFiles).to.deep.equal([base]);
    });
  });

  describe(`diagnostics channel ${Cache.CHANNEL_ENV_CHANGED} (watchEnv)`, () => {
    beforeEach(() => Cache.configure({ pollInterval: 20 }));

    it('is named cooper:cache:env_changed', () => {
      expect(Cache.CHANNEL_ENV_CHANGED).to.equal('cooper:cache:env_changed');
    });

    it('publishes when a watched process.env name changes, and invalidates the entry', async () => {
      setEnv('COOPER_TELEM_ENV_VAR', undefined);
      const file = write('telem_env.casc', 9200, `${HEADER}value = \${COOPER_TELEM_ENV_VAR:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      loadFileSync(file, opts({ watchEnv: true }));
      expect(Cache.size()).to.equal(1);
      setEnv('COOPER_TELEM_ENV_VAR', 'live');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_TELEM_ENV_VAR']);
      expect(messages[0].path).to.equal(file);
      expect(Cache.size()).to.equal(0);
    });

    it('sees COOPER_ENV change when the NODE_ENV it falls back to changes', async () => {
      // The watcher recomputes the same env map a load resolves against, so
      // the COOPER_ENV fallback is what it compares, not the raw variable.
      setEnv('COOPER_ENV', undefined);
      setEnv('NODE_ENV', 'test');
      const file = write('telem_cooper_env.casc', 9300, `${HEADER}value = \${COOPER_ENV}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      expect(loadFileSync(file, opts({ watchEnv: true }))).to.deep.equal({ value: 'test' });
      setEnv('NODE_ENV', 'production');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_ENV']);
      // `production` falls back as `prod`, the name every Cooper uses.
      expect(loadFileSync(file, opts())).to.deep.equal({ value: 'prod' });
    });

    it('is on by default for a file that reads the environment', async () => {
      setEnv('COOPER_TELEM_DEFAULT_VAR', undefined);
      const file = write('telem_default.casc', 9400, `${HEADER}value = \${COOPER_TELEM_DEFAULT_VAR:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      loadFileSync(file, opts());
      setEnv('COOPER_TELEM_DEFAULT_VAR', 'live');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_TELEM_DEFAULT_VAR']);
    });

    it('fires on a .env file edit -- same mechanism as a real env var', async () => {
      const cwd = process.cwd();
      process.chdir(dir);
      cleanups.push(() => process.chdir(cwd));
      setEnv('COOPER_TELEM_DOTENV_VAR', undefined);
      const file = write('app.casc', 9300, `${HEADER}value = \${COOPER_TELEM_DOTENV_VAR:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      expect(loadFileSync(file, { env: {}, dotenvEnv: null, watchEnv: true })).to.deep.equal({ value: 'default' });
      fs.writeFileSync(path.join(dir, '.env'), 'COOPER_TELEM_DOTENV_VAR=from-dotenv\n');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_TELEM_DOTENV_VAR']);
    });

    it('re-reads .env from the dotenvDir the load used, wherever the process has moved since', async () => {
      // The poll must compare against the same layering the load used:
      // the same directory, and the same dotenvOverride order.
      const envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-cache-env-'));
      cleanups.push(() => fs.rmSync(envDir, { recursive: true, force: true }));
      setEnv('COOPER_TELEM_DIR_VAR', undefined);
      const file = write('dir.casc', 9310, `${HEADER}value = \${COOPER_TELEM_DIR_VAR:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      expect(loadFileSync(file, { env: {}, dotenvEnv: null, dotenvDir: envDir, watchEnv: true })).to.deep.equal({ value: 'default' });
      fs.writeFileSync(path.join(envDir, '.env'), 'COOPER_TELEM_DIR_VAR=from-dotenv\n');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_TELEM_DIR_VAR']);
    });

    it('keeps the default dotenvDir the load resolved, not the one the working directory gives later', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-cache-root-'));
      cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
      fs.writeFileSync(path.join(root, 'package.json'), '{}');
      const cwd = process.cwd();
      process.chdir(root);
      cleanups.push(() => process.chdir(cwd));
      setEnv('COOPER_TELEM_ROOT_VAR', undefined);
      const file = write('root.casc', 9320, `${HEADER}value = \${COOPER_TELEM_ROOT_VAR:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      expect(loadFileSync(file, { env: {}, dotenvEnv: null, watchEnv: true })).to.deep.equal({ value: 'default' });
      process.chdir(dir);
      fs.writeFileSync(path.join(root, '.env'), 'COOPER_TELEM_ROOT_VAR=from-root\n');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_TELEM_ROOT_VAR']);
    });

    it('watchEnv: false disables it, even for a file that reads the environment', async () => {
      setEnv('COOPER_TELEM_OFF_VAR', undefined);
      const file = write('telem_off.casc', 9401, `${HEADER}value = \${COOPER_TELEM_OFF_VAR:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      loadFileSync(file, opts({ watchEnv: false }));
      setEnv('COOPER_TELEM_OFF_VAR', 'live');
      expect(await eventually(() => messages.length > 0, 200)).to.equal(false);
      expect(Cache.size()).to.equal(1);
    });

    it('never fires for an unrelated name -- only names the config reads', async () => {
      setEnv('COOPER_TELEM_TRACKED', undefined);
      setEnv('COOPER_TELEM_UNRELATED', undefined);
      const file = write('telem_sel.casc', 9500, `${HEADER}value = \${COOPER_TELEM_TRACKED:"default"}\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      loadFileSync(file, opts({ watchEnv: true }));
      setEnv('COOPER_TELEM_UNRELATED', 'irrelevant');
      expect(await eventually(() => messages.length > 0, 200)).to.equal(false);
    });

    it('watches a guard-only name, and the next load re-parses against the new environment', async () => {
      setEnv('COOPER_TELEM_GUARD_ONLY_VAR', undefined);
      const file = write('telem_guard.casc', 9600, `${HEADER}\${?COOPER_TELEM_GUARD_ONLY_VAR} guarded = true\nkept = 1\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      expect(loadFileSync(file, opts({ watchEnv: true }))).to.deep.equal({ kept: 1 });
      setEnv('COOPER_TELEM_GUARD_ONLY_VAR', '1');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(messages[0].changedNames).to.deep.equal(['COOPER_TELEM_GUARD_ONLY_VAR']);
      expect(Cache.size()).to.equal(0);
      expect(loadFileSync(file, opts())).to.deep.equal({ guarded: true, kept: 1 });
    });

    it('watches a name used only in an import path', async () => {
      setEnv('COOPER_TELEM_IMPORT_VAR', undefined);
      write('a.casc', 9700, `${HEADER}which = "a"\n`);
      write('b.casc', 9700, `${HEADER}which = "b"\n`);
      const file = write('sel.casc', 9700, `${HEADER}import "\${COOPER_TELEM_IMPORT_VAR:a}.casc"\n`);
      const messages = listen(Cache.CHANNEL_ENV_CHANGED);
      expect(loadFileSync(file, opts())).to.deep.equal({ which: 'a' });
      setEnv('COOPER_TELEM_IMPORT_VAR', 'b');
      expect(await eventually(() => messages.length > 0)).to.equal(true);
      expect(loadFileSync(file, opts())).to.deep.equal({ which: 'b' });
    });
  });
});
