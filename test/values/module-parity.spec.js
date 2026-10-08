import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from 'chai';
import * as esmCooper from '../../src/cooper.js';
import * as esmValues from '../../src/values/index.js';

const require = createRequire(import.meta.url);
const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
const valuesDir = path.join(srcDir, 'values');

/** Every single-class ESM wrapper in src/values (the barrel is checked separately). */
const wrappers = fs
  .readdirSync(valuesDir)
  .filter((f) => f.endsWith('.js') && f !== 'index.js')
  .sort();

describe('dual CJS/ESM entry-point parity', () => {
  it('finds a value-class wrapper for every value class', () => {
    expect(wrappers.length).to.be.at.least(10);
  });

  for (const file of wrappers) {
    it(`src/values/${file} default-exports the same class as its .cjs`, async () => {
      const cjsFile = path.join(valuesDir, file.replace(/\.js$/, '.cjs'));
      expect(fs.existsSync(cjsFile), `${cjsFile} exists`).to.equal(true);
      const esm = await import(pathToFileURL(path.join(valuesDir, file)).href);
      expect(esm.default).to.be.a('function');
      expect(esm.default).to.equal(require(cjsFile));
    });
  }

  it('src/values/index.js exports the same names and classes as index.cjs', () => {
    const cjs = require('../../src/values/index.cjs');
    expect(Object.keys(esmValues).sort()).to.deep.equal(Object.keys(cjs).sort());
    for (const key of Object.keys(cjs)) expect(/** @type {any} */ (esmValues)[key], key).to.equal(cjs[key]);
  });

  it('src/error.js and src/version.js re-export their .cjs', async () => {
    expect((await import('../../src/error.js')).default).to.equal(require('../../src/error.cjs'));
    expect((await import('../../src/version.js')).default).to.equal(require('../../src/version.cjs'));
  });

  it('src/cooper.js exports the same names as src/cooper.cjs (plus a default)', () => {
    const cjs = require('../../src/cooper.cjs');
    const named = Object.keys(esmCooper).filter((k) => k !== 'default').sort();
    expect(named).to.deep.equal(Object.keys(cjs).sort());
  });

  it('src/cooper.js exports the very same values as src/cooper.cjs', () => {
    const cjs = require('../../src/cooper.cjs');
    for (const key of Object.keys(cjs)) expect(/** @type {any} */ (esmCooper)[key], key).to.equal(cjs[key]);
  });

  it("src/cooper.js's default export carries the same names and values", () => {
    const cjs = require('../../src/cooper.cjs');
    const def = /** @type {Record<string, unknown>} */ (esmCooper.default);
    expect(Object.keys(def).sort()).to.deep.equal(Object.keys(cjs).sort());
    for (const key of Object.keys(cjs)) expect(def[key], key).to.equal(cjs[key]);
  });

  it('version matches package.json', () => {
    expect(esmCooper.version).to.equal(require('../../package.json').version);
  });
});
