import { createRequire } from 'node:module';
import { expect } from 'chai';
import version from '../src/version.js';

const require = createRequire(import.meta.url);
const versionCjs = require('../src/version.cjs');
const pkg = require('../package.json');

describe('version', () => {
  it('ESM entry point matches package.json', () => {
    expect(version).to.equal(pkg.version);
  });

  it('CJS entry point matches the ESM one (dual entry-point parity)', () => {
    expect(versionCjs).to.equal(version);
  });
});
