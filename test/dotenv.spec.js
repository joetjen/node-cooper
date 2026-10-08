import { expect } from 'chai';
import fc from 'fast-check';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Dotenv, loadString, loadStringSync, CooperError } from '../src/cooper.js';
import { FIXTURES, HEADER, throwsCooper } from './support/harness.js';

/**
 * The environment `${...}` reads from: `.env` < `.env.<env>` < `.env.local`
 * < `process.env` < the `env` option (see `src/dotenv.cjs`), and the
 * built-in `.env` parser.
 *
 * These tests `chdir` into a fixture or temp directory and read the `.env`
 * files there through `dotenvHere`/`loadHere`, which pass that directory
 * as `dotenvDir` -- the default is the project root (the nearest
 * `package.json`), which for a fixture is this repository, not the
 * fixture. The working directory and every `process.env` name a test
 * touches are restored afterwards.
 */

const DOTENV = path.join(FIXTURES, 'dotenv');
const originalCwd = process.cwd();
/** @type {Map<string, string | undefined>} */
const touchedEnv = new Map();
/** @type {string[]} */
const tempDirs = [];

/** @param {string} dir */
function enter(dir) {
  process.chdir(dir);
}

/**
 * Sets (or with `undefined`, deletes) a real environment variable,
 * remembering the original for `afterEach`.
 * @param {string} name
 * @param {string | undefined} value
 */
function setEnv(name, value) {
  if (!touchedEnv.has(name)) touchedEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/**
 * A fresh temp directory holding the given files.
 * @param {Record<string, string>} files
 */
function tempDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-dotenv-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  return dir;
}

/**
 * @param {Record<string, string>} env
 * @param {string[]} names
 */
const pick = (env, names) => Object.fromEntries(names.filter((n) => Object.hasOwn(env, n)).map((n) => [n, env[n]]));

/**
 * `Dotenv.env`, reading the `.env` files in the working directory.
 * @param {import('../src/dotenv.cjs').DotenvOptions} [opts]
 */
const dotenvHere = (opts = {}) => Dotenv.env({ dotenvDir: process.cwd(), ...opts });

/**
 * `loadString`/`loadStringSync`, reading the `.env` files in the working directory.
 * @param {string} source
 * @param {object} [opts]
 */
const loadHere = (source, opts = {}) => loadString(source, { dotenvDir: process.cwd(), ...opts });
/**
 * @param {string} source
 * @param {object} [opts]
 */
const loadHereSync = (source, opts = {}) => loadStringSync(source, { dotenvDir: process.cwd(), ...opts });

describe('dotenv (CASC.md §7.2 environment layering)', () => {
  afterEach(() => {
    process.chdir(originalCwd);
    for (const [name, value] of touchedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    touchedEnv.clear();
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('process.env outranks the files', () => {
    it('a real OS env var comes through when nothing else defines it', () => {
      setEnv('CDT_FLOOR', 'from-system');
      enter(path.join(DOTENV, 'empty'));
      expect(dotenvHere({ env: {} }).CDT_FLOOR).to.equal('from-system');
    });

    it('a real OS env var beats the same name in a .env file', () => {
      enter(tempDir({ '.env': 'CDT_PRECEDENCE=from-file\n' }));
      setEnv('CDT_PRECEDENCE', 'from-system');
      expect(dotenvHere({ env: {} }).CDT_PRECEDENCE).to.equal('from-system');
    });

    it('dotenvOverride: true puts the files back on top', () => {
      enter(tempDir({ '.env': 'CDT_PRECEDENCE=from-file\n' }));
      setEnv('CDT_PRECEDENCE', 'from-system');
      expect(dotenvHere({ env: {}, dotenvOverride: true }).CDT_PRECEDENCE).to.equal('from-file');
    });

    it('an explicit env option still outranks the real environment', () => {
      enter(tempDir({ '.env': 'CDT_PRECEDENCE=from-file\n' }));
      setEnv('CDT_PRECEDENCE', 'from-system');
      expect(dotenvHere({ env: { CDT_PRECEDENCE: 'from-override' } }).CDT_PRECEDENCE).to.equal('from-override');
    });
  });

  describe('which .env.<env> file is read (no explicit dotenvEnv)', () => {
    // The file is named by COOPER_ENV, the name documents select
    // `env/${COOPER_ENV}.casc` by, so `.env.dev`, `.env.staging`,
    // `.env.test` and `.env.prod` in every Cooper. COOPER_ENV and NODE_ENV
    // are real environment names; each test pins both so the developer's
    // own shell can't leak in.
    beforeEach(() => {
      setEnv('COOPER_ENV', undefined);
      setEnv('NODE_ENV', undefined);
    });

    it('is named by COOPER_ENV', () => {
      enter(tempDir({ '.env.staging': 'CDT_PICKED=staging\n' }));
      expect(dotenvHere({ env: { COOPER_ENV: 'staging' } }).CDT_PICKED).to.equal('staging');
    });

    it("by its shared name when it falls back to the host's variable", () => {
      enter(tempDir({ '.env.prod': 'CDT_PICKED=prod\n', '.env.production': 'CDT_PICKED=production\n' }));
      expect(dotenvHere({ env: { COOPER_ENV: '', NODE_ENV: 'production' } }).CDT_PICKED).to.equal('prod');
    });

    it('a COOPER_ENV set in the base .env file names it too', () => {
      enter(tempDir({ '.env': 'COOPER_ENV=staging\n', '.env.staging': 'CDT_PICKED=staging\n' }));
      expect(dotenvHere({ env: {} }).CDT_PICKED).to.equal('staging');
    });

    it('an explicit dotenvEnv still wins', () => {
      enter(tempDir({ '.env.qa': 'CDT_PICKED=qa\n' }));
      expect(dotenvHere({ env: { COOPER_ENV: 'prod' }, dotenvEnv: 'qa' }).CDT_PICKED).to.equal('qa');
    });

    it('falls back to NODE_ENV, from the real environment, to pick .env.<env>', () => {
      setEnv('NODE_ENV', 'test');
      enter(path.join(DOTENV, 'auto_env'));
      expect(dotenvHere({ env: {} }).ONLY_ENV_TEST).to.equal('from-env-test');
    });

    it('with neither COOPER_ENV nor NODE_ENV set, .env.dev is read', () => {
      enter(path.join(DOTENV, 'layering'));
      expect(dotenvHere({ env: {} }).ONLY_DEV).to.equal('from-dev');
    });

    it('a COOPER_ENV set in .env.local does not name it, being read after it', () => {
      enter(tempDir({ '.env.local': 'COOPER_ENV=staging\n', '.env.staging': 'CDT_PICKED=staging\n' }));
      expect(dotenvHere({ env: {} })).not.to.have.property('CDT_PICKED');
    });

    it('under dotenvOverride: true a COOPER_ENV in the base .env outranks the real one in naming it too', () => {
      setEnv('COOPER_ENV', 'prod');
      enter(tempDir({ '.env': 'COOPER_ENV=staging\n', '.env.staging': 'CDT_PICKED=staging\n' }));
      expect(dotenvHere({ env: {}, dotenvOverride: true }).CDT_PICKED).to.equal('staging');
    });
  });

  describe('COOPER_ENV, the one name every implementation reads the environment by (CASC.md §7.2)', () => {
    // NODE_ENV and COOPER_ENV are real environment names; each test pins
    // both (and the files) so the developer's own shell can't leak in.
    beforeEach(() => {
      setEnv('COOPER_ENV', undefined);
      setEnv('NODE_ENV', undefined);
      enter(tempDir());
    });

    it('a COOPER_ENV set in the env option wins over NODE_ENV', () => {
      setEnv('NODE_ENV', 'production');
      expect(dotenvHere({ env: { COOPER_ENV: 'staging' } }).COOPER_ENV).to.equal('staging');
    });

    it('a COOPER_ENV set in the real environment wins over NODE_ENV', () => {
      setEnv('COOPER_ENV', 'staging');
      setEnv('NODE_ENV', 'production');
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('staging');
    });

    it('a COOPER_ENV set in a .env file wins over NODE_ENV', () => {
      enter(tempDir({ '.env': 'COOPER_ENV=staging\nNODE_ENV=production\n' }));
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('staging');
    });

    it('an unset COOPER_ENV falls back to NODE_ENV from the real environment', () => {
      setEnv('NODE_ENV', 'test');
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('test');
    });

    it('an empty COOPER_ENV falls back to NODE_ENV', () => {
      expect(dotenvHere({ env: { COOPER_ENV: '', NODE_ENV: 'test' } }).COOPER_ENV).to.equal('test');
    });

    it('the NODE_ENV fallback is read from the same layers, a .env file included', () => {
      enter(tempDir({ '.env': 'NODE_ENV=test\n' }));
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('test');
    });

    it('with neither COOPER_ENV nor NODE_ENV, COOPER_ENV is dev', () => {
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('dev');
    });

    it('with both empty, COOPER_ENV is dev', () => {
      expect(dotenvHere({ env: { COOPER_ENV: '', NODE_ENV: '' } }).COOPER_ENV).to.equal('dev');
    });

    it('applies with dotenv: false too', () => {
      expect(dotenvHere({ dotenv: false, env: { NODE_ENV: 'test' } }).COOPER_ENV).to.equal('test');
    });

    // The environments are named dev, staging, test and prod in every
    // Cooper; the host's own spellings are mapped onto them through one
    // table, the same everywhere (CASC.md §7.2), so one `env/dev.casc`
    // serves every implementation.
    it('a NODE_ENV of development falls back as dev', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'development' } }).COOPER_ENV).to.equal('dev');
    });

    it('a NODE_ENV of local falls back as dev', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'local' } }).COOPER_ENV).to.equal('dev');
    });

    it('a NODE_ENV of testing falls back as test', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'testing' } }).COOPER_ENV).to.equal('test');
    });

    it('a NODE_ENV of production falls back as prod', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'production' } }).COOPER_ENV).to.equal('prod');
    });

    it('the shared names themselves fall back unchanged', () => {
      for (const name of ['dev', 'staging', 'test', 'prod']) {
        expect(dotenvHere({ env: { NODE_ENV: name } }).COOPER_ENV).to.equal(name);
      }
    });

    it('a NODE_ENV of development read from a .env file falls back as dev', () => {
      enter(tempDir({ '.env': 'NODE_ENV=development\n' }));
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('dev');
    });

    it('only the exact lowercase names are translated', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'Development' } }).COOPER_ENV).to.equal('Development');
      expect(dotenvHere({ env: { NODE_ENV: 'PRODUCTION' } }).COOPER_ENV).to.equal('PRODUCTION');
      expect(dotenvHere({ env: { NODE_ENV: 'development2' } }).COOPER_ENV).to.equal('development2');
    });

    it('any other NODE_ENV, such as qa, falls back unchanged', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'qa' } }).COOPER_ENV).to.equal('qa');
    });

    it('a real COOPER_ENV is never mapped', () => {
      expect(dotenvHere({ env: { COOPER_ENV: 'development' } }).COOPER_ENV).to.equal('development');
      expect(dotenvHere({ env: { COOPER_ENV: 'local' } }).COOPER_ENV).to.equal('local');
      expect(dotenvHere({ env: { COOPER_ENV: 'testing' } }).COOPER_ENV).to.equal('testing');
      setEnv('COOPER_ENV', 'production');
      expect(dotenvHere({ env: {} }).COOPER_ENV).to.equal('production');
    });

    it('the translation leaves NODE_ENV itself alone', () => {
      expect(dotenvHere({ env: { NODE_ENV: 'development' } }).NODE_ENV).to.equal('development');
    });

    it('any non-empty COOPER_ENV is passed through unchanged', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), fc.string(), (cooperEnv, nodeEnv) => {
          expect(dotenvHere({ dotenv: false, env: { COOPER_ENV: cooperEnv, NODE_ENV: nodeEnv } }).COOPER_ENV).to.equal(cooperEnv);
        }),
      );
    });

    it('any other non-empty NODE_ENV becomes COOPER_ENV unchanged when COOPER_ENV is unset', () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1 }).filter((s) => !['development', 'local', 'testing', 'production'].includes(s)),
          (nodeEnv) => {
            expect(dotenvHere({ dotenv: false, env: { NODE_ENV: nodeEnv } }).COOPER_ENV).to.equal(nodeEnv);
          },
        ),
      );
    });

    it('a document reads it as ${COOPER_ENV}', () => {
      expect(loadHereSync(`${HEADER}env = \${COOPER_ENV}`, { dotenv: false, env: { NODE_ENV: 'test' } })).to.deep.equal({ env: 'test' });
    });
  });

  describe('the full layer chain, later winning', () => {
    const NAMES = ['ONLY_BASE', 'SHARED', 'DEV_AND_LOCAL', 'ONLY_LOCAL', 'ONLY_DEV'];

    it('.env, .env.<dotenvEnv> and .env.local each override the layer below, process.env above all files', () => {
      setEnv('ONLY_BASE', 'from-system');
      enter(path.join(DOTENV, 'layering'));
      expect(pick(dotenvHere({ env: {}, dotenvEnv: 'dev' }), NAMES)).to.deep.equal({
        ONLY_BASE: 'from-system',
        SHARED: 'from-dev',
        DEV_AND_LOCAL: 'from-local',
        ONLY_LOCAL: 'from-local',
        ONLY_DEV: 'from-dev',
      });
    });

    it('under dotenvOverride: true the files outrank process.env again', () => {
      setEnv('ONLY_BASE', 'from-system');
      enter(path.join(DOTENV, 'layering'));
      expect(dotenvHere({ env: {}, dotenvEnv: 'dev', dotenvOverride: true }).ONLY_BASE).to.equal('from-base');
    });

    it('an explicit env entry always wins, over .env.local included; other names still fall through', () => {
      enter(path.join(DOTENV, 'layering'));
      const env = dotenvHere({ env: { SHARED: 'from-explicit-override' }, dotenvEnv: 'dev' });
      expect(env.SHARED).to.equal('from-explicit-override');
      expect(env.ONLY_DEV).to.equal('from-dev');
    });

    it('no per-env file is read when dotenvEnv is null', () => {
      enter(path.join(DOTENV, 'layering'));
      const env = dotenvHere({ env: {}, dotenvEnv: null });
      expect(pick(env, NAMES)).to.deep.equal({
        ONLY_BASE: 'from-base',
        SHARED: 'from-base',
        DEV_AND_LOCAL: 'from-local',
        ONLY_LOCAL: 'from-local',
      });
    });

    it("an unmatched environment's own file is simply absent, not an error", () => {
      enter(path.join(DOTENV, 'layering'));
      const env = dotenvHere({ env: {}, dotenvEnv: 'prod' });
      expect(env).not.to.have.property('ONLY_DEV');
      expect(env.SHARED).to.equal('from-base');
    });

    it('a directory with none of the files still yields the override and process.env', () => {
      setEnv('CDT_FLOOR', 'from-system');
      enter(path.join(DOTENV, 'empty'));
      const env = dotenvHere({ env: { KEPT: '1' }, dotenvEnv: 'dev' });
      expect(env.KEPT).to.equal('1');
      expect(env.CDT_FLOOR).to.equal('from-system');
    });

    it('a later .env layer can interpolate a name defined by an earlier layer', () => {
      enter(tempDir({ '.env': 'CDT_HOST=example.test\n', '.env.local': 'CDT_URL=https://${CDT_HOST}/x\n' }));
      expect(dotenvHere({ env: {}, dotenvEnv: null }).CDT_URL).to.equal('https://example.test/x');
    });

    it('property: precedence .env < .env.<env> < .env.local < process.env < env, for arbitrary layers', () => {
      const KEYS = ['CDT_A', 'CDT_B', 'CDT_C', 'CDT_D', 'CDT_E', 'CDT_F'];
      const layer = fc.dictionary(fc.constantFrom(...KEYS), fc.string({ unit: fc.constantFrom('a', 'b', 'c', 'x', 'y', 'z'), minLength: 1, maxLength: 6 }), {
        maxKeys: 3,
      });
      /** @param {Record<string, string>} map */
      const render = (map) => Object.entries(map).map(([k, v]) => `${k}=${v}\n`).join('');
      fc.assert(
        fc.property(layer, layer, layer, layer, layer, (dotenv, envFile, local, system, override) => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-dotenv-prop-'));
          try {
            fs.writeFileSync(path.join(dir, '.env'), render(dotenv));
            fs.writeFileSync(path.join(dir, '.env.proptest'), render(envFile));
            fs.writeFileSync(path.join(dir, '.env.local'), render(local));
            for (const key of KEYS) setEnv(key, system[key]);
            process.chdir(dir);
            const actual = dotenvHere({ env: override, dotenvEnv: 'proptest' });
            expect(pick(actual, KEYS)).to.deep.equal({ ...dotenv, ...envFile, ...local, ...system, ...override });
          } finally {
            process.chdir(originalCwd);
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }),
        { numRuns: 40 }
      );
    });
  });

  describe('dotenv: false disables just the file layers', () => {
    it('process.env and the env option still apply', () => {
      setEnv('CDT_FLOOR', 'from-system');
      enter(path.join(DOTENV, 'layering'));
      const env = dotenvHere({ dotenv: false, env: { OVERRIDE: 'value' } });
      expect(env.CDT_FLOOR).to.equal('from-system');
      expect(env.OVERRIDE).to.equal('value');
      expect(env).not.to.have.property('ONLY_BASE');
    });

    it('even a malformed .env is never read', () => {
      enter(path.join(DOTENV, 'malformed'));
      expect(() => dotenvHere({ dotenv: false, env: {} })).not.to.throw();
    });
  });

  describe('dotenvFiles replaces the default file list', () => {
    it('only the listed files are consulted', () => {
      enter(path.join(DOTENV, 'layering'));
      expect(pick(dotenvHere({ env: {}, dotenvFiles: ['.env.local'] }), ['DEV_AND_LOCAL', 'ONLY_LOCAL', 'ONLY_BASE'])).to.deep.equal({
        DEV_AND_LOCAL: 'from-local',
        ONLY_LOCAL: 'from-local',
      });
    });

    it('listed files layer in the given order, later winning', () => {
      enter(path.join(DOTENV, 'layering'));
      expect(dotenvHere({ env: {}, dotenvFiles: ['.env.dev', '.env'] }).SHARED).to.equal('from-base');
      expect(dotenvHere({ env: {}, dotenvFiles: ['.env', '.env.dev'] }).SHARED).to.equal('from-dev');
    });
  });

  describe('dotenvDir, where the .env files are read from', () => {
    // They were read from the working directory only, so an application
    // started from anywhere but its own root read none of them.
    it('defaults to the project root -- the nearest package.json above the working directory -- even from a subdirectory', () => {
      const root = tempDir({ 'package.json': '{}', '.env': 'CDT_DIR=from-root\n' });
      fs.mkdirSync(path.join(root, 'sub'));
      enter(path.join(root, 'sub'));
      expect(Dotenv.env({ env: {} }).CDT_DIR).to.equal('from-root');
    });

    it('defaults to the working directory when no package.json is above it', () => {
      // A temp directory has no package.json between it and the file
      // system root on any machine these tests run on.
      enter(tempDir({ '.env': 'CDT_DIR=from-cwd\n' }));
      expect(Dotenv.env({ env: {} }).CDT_DIR).to.equal('from-cwd');
    });

    it('is the project root Dotenv.projectRoot() reports', () => {
      const root = tempDir({ 'package.json': '{}' });
      fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      enter(path.join(root, 'a', 'b'));
      expect(Dotenv.projectRoot()).to.equal(fs.realpathSync(root));
    });

    it('overrides the default when given', () => {
      const elsewhere = tempDir({ '.env': 'CDT_DIR=from-cwd\n' });
      const dir = tempDir({ '.env': 'CDT_DIR=from-dir\n' });
      enter(elsewhere);
      expect(Dotenv.env({ env: {}, dotenvDir: dir }).CDT_DIR).to.equal('from-dir');
    });

    it('is the base a relative dotenvFiles entry resolves against; an absolute one is used as is', () => {
      const dir = tempDir({ 'custom.env': 'CDT_DIR=custom\n' });
      const other = tempDir({ 'abs.env': 'CDT_OTHER=absolute\n' });
      enter(tempDir());
      const env = Dotenv.env({ env: {}, dotenvDir: dir, dotenvFiles: ['custom.env', path.join(other, 'abs.env')] });
      expect(pick(env, ['CDT_DIR', 'CDT_OTHER'])).to.deep.equal({ CDT_DIR: 'custom', CDT_OTHER: 'absolute' });
    });

    it('is honoured by a load', () => {
      const dir = tempDir({ '.env': 'CDT_DIR=from-dir\n' });
      enter(tempDir());
      expect(loadStringSync(`${HEADER}v = \${CDT_DIR}\n`, { dotenvDir: dir })).to.deep.equal({ v: 'from-dir' });
    });
  });

  describe('a malformed .env file', () => {
    it('is a CooperError with stage dotenv naming the failure', () => {
      enter(path.join(DOTENV, 'malformed'));
      const err = throwsCooper(() => dotenvHere({ env: {} }), 'dotenv');
      expect(err.message).to.contain('dotenv loading failed');
      expect(err.message).to.contain('.env');
    });

    it('fails loadString and loadStringSync with stage dotenv', async () => {
      enter(path.join(DOTENV, 'malformed'));
      throwsCooper(() => loadHereSync(`${HEADER}a = 1`, { env: {} }), 'dotenv');
      let caught;
      try {
        await loadHere(`${HEADER}a = 1`, { env: {} });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(CooperError);
      expect(/** @type {CooperError} */ (caught).stage).to.equal('dotenv');
    });
  });

  describe('wired into loadString', () => {
    it('a ${...} reference resolves against a real .env file, dotenv on by default', () => {
      enter(path.join(DOTENV, 'layering'));
      expect(loadHereSync(`${HEADER}shared = \${SHARED}`, { dotenvEnv: 'dev' })).to.deep.equal({ shared: 'from-dev' });
    });

    it('an explicit env entry wins over a .env file value for the same name', () => {
      enter(path.join(DOTENV, 'layering'));
      expect(loadHereSync(`${HEADER}shared = \${SHARED}`, { env: { SHARED: 'explicit' }, dotenvEnv: 'dev' })).to.deep.equal({ shared: 'explicit' });
    });

    it('dotenv: false ignores the files during a load', () => {
      enter(path.join(DOTENV, 'layering'));
      expect(loadHereSync(`${HEADER}shared = \${SHARED:"none"}`, { dotenv: false, env: {} })).to.deep.equal({ shared: 'none' });
    });
  });

  describe('the .env parser (Dotenv.parse)', () => {
    it('reads KEY=value lines, trimming unquoted values', () => {
      expect(Dotenv.parse('A=1\nB = two \nE=')).to.deep.equal({ A: '1', B: 'two', E: '' });
    });

    it('starts from the given vars and lets the file override them', () => {
      expect(Dotenv.parse('A=new', { A: 'old', B: 'kept' })).to.deep.equal({ A: 'new', B: 'kept' });
    });

    it('does not mutate the vars argument', () => {
      const vars = { A: 'old' };
      Dotenv.parse('A=new\nB=1', vars);
      expect(vars).to.deep.equal({ A: 'old' });
    });

    it('accepts an `export ` prefix', () => {
      expect(Dotenv.parse('export A=1\n  export   B = 2  ')).to.deep.equal({ A: '1', B: '2' });
    });

    it('skips comment lines and blank lines, and ends an unquoted value at #', () => {
      expect(Dotenv.parse('# a comment\n\nA=x # trailing\nB=a#b\n   # indented comment\n')).to.deep.equal({ A: 'x', B: 'a' });
    });

    it('keeps # inside quotes', () => {
      expect(Dotenv.parse('A="a#b"\nB=\'c#d\'')).to.deep.equal({ A: 'a#b', B: 'c#d' });
    });

    it('a double-quoted value processes escapes', () => {
      expect(Dotenv.parse('A="a\\nb\\tc\\"q\\" \\u00e9 \\\\ \\r\\f\\b"').A).to.equal('a\nb\tc"q" é \\ \r\f\b');
    });

    it('a single-quoted value is literal: no escapes, no interpolation', () => {
      expect(Dotenv.parse("A='lit\\n ${X}'", { X: 'xv' }).A).to.equal('lit\\n ${X}');
    });

    it('a double-quoted value may span lines', () => {
      expect(Dotenv.parse('A="one\ntwo"\nB=3')).to.deep.equal({ A: 'one\ntwo', B: '3' });
    });

    it('interpolates ${VAR} from earlier in the file and from the given vars', () => {
      expect(Dotenv.parse('A=1\nB=${A}-x\nC="${A}${B}"\nD=${X}', { X: 'xv' })).to.deep.equal({ X: 'xv', A: '1', B: '1-x', C: '11-x', D: 'xv' });
    });

    it('interpolating an undefined variable is an error', () => {
      expect(() => Dotenv.parse('B=${NOPE}')).to.throw(/NOPE/);
    });

    it('a """ heredoc interpolates; a \'\'\' heredoc is literal', () => {
      expect(Dotenv.parse('A="""\nline1\nline2 ${X}\n"""\nB=\'\'\'\nraw ${X}\n\'\'\'\nC=after', { X: 'xv' })).to.deep.equal({
        X: 'xv',
        A: 'line1\nline2 xv\n',
        B: 'raw ${X}\n',
        C: 'after',
      });
    });

    it('keeps $(cmd) as literal text, never executing it', () => {
      expect(Dotenv.parse('A=$(echo hi)\nB="$(touch /tmp/cooper-should-not-exist)"')).to.deep.equal({
        A: '$(echo hi)',
        B: '$(touch /tmp/cooper-should-not-exist)',
      });
      expect(fs.existsSync('/tmp/cooper-should-not-exist')).to.equal(false);
    });

    it('accepts CRLF line endings', () => {
      expect(Dotenv.parse('A=x\r\nB="y"\r\n')).to.deep.equal({ A: 'x', B: 'y' });
    });

    it('rejects a line without an equals sign', () => {
      expect(() => Dotenv.parse('not a valid line')).to.throw();
      expect(() => Dotenv.parse('A=1\nnot valid\nB=2')).to.throw();
    });

    it('rejects an invalid variable name', () => {
      expect(() => Dotenv.parse('1A=x')).to.throw(/name/);
      expect(() => Dotenv.parse('A-B=x')).to.throw(/name/);
    });

    it('rejects an unterminated quote', () => {
      expect(() => Dotenv.parse('A="unterminated')).to.throw();
      expect(() => Dotenv.parse("A='unterminated")).to.throw();
    });

    it('rejects junk after a closing quote, but allows a trailing comment', () => {
      expect(() => Dotenv.parse('A="x" junk')).to.throw();
      expect(Dotenv.parse('A="x" # ok')).to.deep.equal({ A: 'x' });
    });

    it('rejects an invalid \\u escape', () => {
      expect(() => Dotenv.parse('A="\\uZZZZ"')).to.throw(/unicode/);
    });

    it('property: a double-quoted value with escaped specials round-trips', () => {
      const char = fc.constantFrom('a', 'Z', '0', ' ', '#', '"', '\\', '\n', '\t', "'", '=', '$');
      fc.assert(
        fc.property(fc.string({ unit: char, maxLength: 20 }), (value) => {
          const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\$/g, '\\$');
          expect(Dotenv.parse(`K="${escaped}"\n`)).to.deep.equal({ K: value });
        }),
        { numRuns: 200 }
      );
    });
  });
});
