import { expect } from 'chai';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadFileSync, loadFile, ModuleRef } from '../../src/cooper.js';
import { load, loadAsync, loadError } from '../support/harness.js';

/**
 * `!module("Name")` (CASC.md §7.5). A module name is written the same way
 * for every Cooper implementation -- dot-separated PascalCase -- and each
 * translates it into its own host's module. A Node module is a location,
 * not a name, so there is nothing to translate into: every name comes from
 * the application's `modules` load option, by the name exactly as written.
 */

class StripeClient {}

describe('!module: a name the mapping holds (CASC.md §7.5)', () => {
  it('a mapped PascalCase name is a ModuleRef keeping the name as written', () => {
    const { m } = load('m = !module("Acme.Payments.StripeClient")', { modules: { 'Acme.Payments.StripeClient': 'node:crypto' } });
    expect(m).to.be.instanceOf(ModuleRef);
    expect(m.name).to.equal('Acme.Payments.StripeClient');
    expect(m.specifier).to.equal('node:crypto');
  });

  it('every dot-separated PascalCase shape is accepted, runs of capitals and digits included', () => {
    for (const name of ['Cooper', 'Foo.Bar', 'ASCO.HTTPClient', 'V2.Api2', 'A.B.C']) {
      const { m } = load(`m = !module("${name}")`, { modules: { [name]: 'node:fs' } });
      expect(m.name, name).to.equal(name);
    }
  });

  it('surrounding whitespace is ignored, and the mapping is asked by the trimmed name', () => {
    const { m } = load('m = !module("  Foo.Bar  ")', { modules: { 'Foo.Bar': 'node:fs' } });
    expect(m.name).to.equal('Foo.Bar');
  });

  it('the mapping is asked by the name exactly as written, case included', () => {
    const err = loadError('m = !module("Crypto")', { modules: { CRYPTO: 'node:crypto', crypto: 'node:crypto' } }, 'resolve');
    expect(err.message).to.contain('"Crypto"');
    expect(err.message).to.contain('modules');
  });

  it('the mapping may be a Map as well as an object', () => {
    const { m } = load('m = !module("Fs")', { modules: new Map([['Fs', 'node:fs']]) });
    expect(m.specifier).to.equal('node:fs');
  });

  it('a name may come from an environment variable', () => {
    const modules = { 'Foo.Bar': 'node:fs' };
    expect(load('m = !module("${WHICH_MODULE}")', { env: { WHICH_MODULE: 'Foo.Bar' }, modules }).m.name).to.equal('Foo.Bar');
    expect(load('m = !module(${WHICH_MODULE})', { env: { WHICH_MODULE: 'Foo.Bar' }, modules }).m.name).to.equal('Foo.Bar');
  });

  it('a module sits inside a list like any other value', () => {
    const { m } = load('m = [!module("Fs"), !module("Os")]', { modules: { Fs: 'node:fs', Os: 'node:os' } });
    expect(m.map((/** @type {ModuleRef} */ r) => r.name)).to.deep.equal(['Fs', 'Os']);
  });

  it('the async API takes the mapping too', async () => {
    const { m } = await loadAsync('m = !module("Fs")', { modules: { Fs: 'node:fs' } });
    expect(m.specifier).to.equal('node:fs');
  });

  it('displays as the name as written', () => {
    const { m } = load('m = !module("Foo.Bar")', { modules: { 'Foo.Bar': 'node:path' } });
    expect(String(m)).to.equal('Foo.Bar');
    expect(JSON.stringify(m)).to.equal('"Foo.Bar"');
  });
});

describe('!module: what a mapping value means', () => {
  it('a specifier string is kept for load() to import, not imported at load', () => {
    const { m } = load('m = !module("Missing")', { modules: { Missing: './no/such/module.js' } });
    expect(m.specifier).to.equal(path.resolve(process.cwd(), 'no/such/module.js'));
  });

  it('a relative specifier resolves against process.cwd(), not against the config file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-module-'));
    try {
      const file = path.join(dir, 'app.casc');
      fs.writeFileSync(file, '#@version = 1.0\nm = !module("Thing")\n');
      const r = loadFileSync(file, { dotenv: false, env: {}, cache: false, modules: { Thing: './lib/thing.js' } });
      expect(r.m.specifier).to.equal(path.resolve(process.cwd(), 'lib/thing.js'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builtin, bare, scoped, absolute and file: URL specifiers are kept as written', () => {
    for (const specifier of ['node:crypto', 'lodash', '@acme/pkg/sub', '/abs/x.js', 'file:///tmp/x.js']) {
      const { m } = load('m = !module("Thing")', { modules: { Thing: specifier } });
      expect(m.specifier, specifier).to.equal(specifier);
    }
  });

  it('a non-string value is handed back by load() without importing anything', async () => {
    const { m } = load('m = !module("Acme.Payments.StripeClient")', { modules: { 'Acme.Payments.StripeClient': StripeClient } });
    expect(m.specifier).to.equal(undefined);
    expect(m.value).to.equal(StripeClient);
    expect(await m.load()).to.equal(StripeClient);
  });

  it('load() imports a specifier lazily', async () => {
    const { m } = load('m = !module("Path")', { modules: { Path: 'node:path' } });
    expect((await m.load()).join).to.equal(path.join);
  });

  it('load() imports a cwd-relative file', async () => {
    const dir = fs.mkdtempSync(path.join(process.cwd(), 'tmp-cooper-module-'));
    try {
      fs.writeFileSync(path.join(dir, 'answer.mjs'), 'export const answer = 42;\n');
      const relative = `./${path.relative(process.cwd(), path.join(dir, 'answer.mjs'))}`;
      const { m } = load('m = !module("Answer")', { modules: { Answer: relative } });
      expect((await m.load()).answer).to.equal(42);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('load() imports a file: URL', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-module-'));
    try {
      const file = path.join(dir, 'answer.mjs');
      fs.writeFileSync(file, 'export const answer = 7;\n');
      const { m } = load('m = !module("Answer")', { modules: { Answer: pathToFileURL(file).href } });
      expect((await m.load()).answer).to.equal(7);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadFile and the cached loadFileSync take the mapping on every call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cooper-module-'));
    try {
      const file = path.join(dir, 'app.casc');
      fs.writeFileSync(file, '#@version = 1.0\nm = !module("Thing")\n');
      const base = { dotenv: false, env: {}, watchEnv: false };
      expect(loadFileSync(file, { ...base, modules: { Thing: 'node:fs' } }).m.specifier).to.equal('node:fs');
      expect(loadFileSync(file, { ...base, modules: { Thing: 'node:os' } }).m.specifier).to.equal('node:os');
      expect((await loadFile(file, { ...base, modules: { Thing: 'node:path' } })).m.specifier).to.equal('node:path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('!module: rejecting what is not a module name', () => {
  it('a name the mapping does not hold, naming the module and the modules option', () => {
    const err = loadError('m = !module("Acme.Payments")', {}, 'resolve');
    expect(err.message).to.contain('"Acme.Payments"');
    expect(err.message).to.contain('`modules` load option');
  });

  it('a name that is not dot-separated PascalCase, even one the mapping holds', () => {
    for (const name of ['crypto', 'Foo.bar', 'Foo_Bar', 'foo-bar', './x.js', 'node:fs', '@scope/pkg', 'Foo..Bar', 'Foo.', '.Foo', '1Foo', 'Foo Bar']) {
      const err = loadError(`m = !module("${name}")`, { modules: { [name]: 'node:fs' } }, 'resolve');
      expect(err.message, name).to.contain('not a dot-separated PascalCase module name');
    }
  });

  it('an empty name', () => {
    expect(loadError('m = !module("")', {}, 'resolve').message).to.contain('not a dot-separated PascalCase module name');
  });

  it('a non-string argument', () => {
    expect(loadError('m = !module(42)', {}, 'resolve').message).to.contain('not a string');
  });

  it('a name longer than 512 bytes', () => {
    expect(loadError(`m = !module("${'A'.repeat(513)}")`, {}, 'resolve').message).to.contain('longer than 512 bytes');
  });

  it('exactly 512 bytes is still accepted', () => {
    const name = 'A'.repeat(512);
    expect(load(`m = !module("${name}")`, { modules: { [name]: 'node:fs' } }).m).to.be.instanceOf(ModuleRef);
  });

  it('the byte limit counts UTF-8 bytes, not characters', () => {
    // 'é' is 2 bytes: 257 of them is 514 bytes but only 257 characters.
    expect(loadError(`m = !module("A${'é'.repeat(257)}")`, {}, 'resolve').message).to.contain('longer than 512 bytes');
  });
});
