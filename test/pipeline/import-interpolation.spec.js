import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadFileSync } from '../../src/cooper.js';
import { throwsCooper, atom } from '../support/harness.js';

/**
 * An import path may interpolate `${NAME}` / `${NAME:default}` (CASC.md
 * §5.1 item 4) -- and only that, since imports are resolved while parsing.
 */

describe('import paths interpolating ${...} (CASC.md §5.1)', () => {
  /** @type {string} */
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-import-'));
    fs.mkdirSync(path.join(dir, 'env'));
    fs.writeFileSync(path.join(dir, 'env', 'dev.casc'), '#@version = 1.0\ndemo { from = dev }\n');
    fs.writeFileSync(path.join(dir, 'env', 'test.casc'), '#@version = 1.0\ndemo { from = test }\n');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * @param {string} source
   * @param {Record<string, string>} env
   */
  const loadEntry = (source, env) => {
    const file = path.join(dir, 'entry.casc');
    fs.writeFileSync(file, source);
    return loadFileSync(file, { cache: false, dotenv: false, env });
  };

  describe('selecting an import by environment', () => {
    it('the variable selects the file', () => {
      expect(loadEntry('#@version = 1.0\nimport "env/${APP_ENV:dev}.casc"\n', { APP_ENV: 'test' })).to.deep.equal({ demo: { from: atom('test') } });
    });

    it('an unset variable falls back to the default', () => {
      expect(loadEntry('#@version = 1.0\nimport "env/${COOPER_TEST_UNSET_ENV:dev}.casc"\n', {})).to.deep.equal({ demo: { from: atom('dev') } });
    });

    it('an empty variable counts as unset, as everywhere else', () => {
      expect(loadEntry('#@version = 1.0\nimport "env/${APP_ENV:dev}.casc"\n', { APP_ENV: '' })).to.deep.equal({ demo: { from: atom('dev') } });
    });

    it('a plain literal path still works', () => {
      expect(loadEntry('#@version = 1.0\nimport "env/test.casc"\n', {})).to.deep.equal({ demo: { from: atom('test') } });
    });
  });

  describe('refusing what cannot be resolved while parsing', () => {
    it('an unset variable with no default is an error rather than a wrong path', () => {
      const err = throwsCooper(() => loadEntry('#@version = 1.0\nimport "env/${COOPER_TEST_UNSET_ENV}.casc"\n', {}), 'import');
      expect(err.message).to.contain('unset and has no default');
    });

    it('a config reference cannot be used, since the tree does not exist yet', () => {
      const err = throwsCooper(() => loadEntry('#@version = 1.0\nwhich = "test"\nimport "env/%{which}.casc"\n', {}), 'import');
      expect(err.message).to.contain('may interpolate only');
    });

    it('a missing selected file still reports a normal import failure', () => {
      const err = throwsCooper(() => loadEntry('#@version = 1.0\nimport "env/${APP_ENV:dev}.casc"\n', { APP_ENV: 'staging' }), 'import');
      expect(err.message).not.to.contain('may interpolate only');
    });
  });
});
