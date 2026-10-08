import path from 'node:path';
import util from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect } from 'chai';
import { ModuleRef, loadStringSync } from '../../src/cooper.js';
import { isolated, cooperError } from '../support/load.js';

const supportDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'support');

describe('ModuleRef (CASC.md §7.5 !module)', () => {
  it('accepts a dot-separated PascalCase name', () => {
    for (const name of ['Cooper', 'Foo.Bar', 'Acme.Payments.StripeClient', 'ASCO.HTTPClient', 'V2']) {
      expect(ModuleRef.validate(name), name).to.equal(null);
      expect(new ModuleRef(name, 'node:fs').name).to.equal(name);
    }
  });

  it('rejects a name that is not dot-separated PascalCase, Node specifiers included', () => {
    for (const name of ['', 'crypto', 'Foo.bar', 'Foo_Bar', 'Foo..Bar', 'Foo Bar', './x.js', 'node:fs', '@scope/pkg', 'lodash']) {
      expect(ModuleRef.validate(name), JSON.stringify(name)).to.match(/not a dot-separated PascalCase module name/);
      expect(() => new ModuleRef(name, 'node:fs'), JSON.stringify(name)).to.throw(TypeError);
    }
  });

  it('rejects a non-string and an over-long name', () => {
    expect(ModuleRef.validate(42)).to.match(/not a string/);
    expect(ModuleRef.validate(`A${'b'.repeat(512)}`)).to.match(/longer than 512 bytes/);
    expect(ModuleRef.validate(`A${'b'.repeat(511)}`)).to.equal(null);
  });

  it('resolves a relative specifier against the base (process.cwd() by default), leaving every other form as written', () => {
    expect(new ModuleRef('X', './h/x.js', '/srv/app').specifier).to.equal(path.resolve('/srv/app', './h/x.js'));
    expect(new ModuleRef('X', '../x.js', '/srv/app').specifier).to.equal(path.resolve('/srv', 'x.js'));
    expect(new ModuleRef('X', './x.js').specifier).to.equal(path.resolve(process.cwd(), 'x.js'));
    expect(new ModuleRef('X', 'node:fs', '/srv/app').specifier).to.equal('node:fs');
    expect(new ModuleRef('X', '/abs/x.js', '/srv/app').specifier).to.equal('/abs/x.js');
    expect(new ModuleRef('X', '@acme/pkg', '/srv/app').specifier).to.equal('@acme/pkg');
  });

  it('holds a non-string target as its value, with no specifier', () => {
    const target = { hello: 'world' };
    const ref = new ModuleRef('Hello', target);
    expect(ref.value).to.equal(target);
    expect(ref.specifier).to.equal(undefined);
  });

  it('equals by name and target', () => {
    const target = {};
    expect(new ModuleRef('X', './x.js', '/a').equals(new ModuleRef('X', '../x.js', '/a/b'))).to.equal(true);
    expect(new ModuleRef('X', './x.js', '/a').equals(new ModuleRef('X', './x.js', '/b'))).to.equal(false);
    expect(new ModuleRef('X', 'node:fs').equals(new ModuleRef('Y', 'node:fs'))).to.equal(false);
    expect(new ModuleRef('X', target).equals(new ModuleRef('X', target))).to.equal(true);
    expect(new ModuleRef('X', target).equals(new ModuleRef('X', {}))).to.equal(false);
  });

  it('renders as the name as written', () => {
    const ref = new ModuleRef('Acme.Thing', './x.js', '/a');
    expect(String(ref)).to.equal('Acme.Thing');
    expect(JSON.stringify(ref)).to.equal('"Acme.Thing"');
    expect(util.inspect(ref)).to.equal('ModuleRef(Acme.Thing)');
    expect(Object.isFrozen(ref)).to.equal(true);
  });

  it('load() imports a builtin', async () => {
    const mod = await new ModuleRef('Path', 'node:path').load();
    expect(mod.join).to.equal(path.join);
  });

  it('load() imports a relative file against the base', async () => {
    const mod = await new ModuleRef('Canon', './canon.js', supportDir).load();
    expect(mod.canon).to.be.a('function');
  });

  it('load() hands back a provided value without importing it', async () => {
    const target = { provided: true };
    expect(await new ModuleRef('Provided', target).load()).to.equal(target);
  });
});

describe('!module at load time (CASC.md §7.5)', () => {
  it('records the mapped target without importing anything', () => {
    const r = loadStringSync('#@version = 1.0\nm = !module("Handlers.Thing")\nn = !module("Fs")', {
      ...isolated(),
      modules: { 'Handlers.Thing': './no/such/thing.js', Fs: 'node:fs' },
    });
    expect(r.m).to.be.instanceOf(ModuleRef);
    expect(r.m.name).to.equal('Handlers.Thing');
    expect(r.m.specifier).to.equal(path.resolve(process.cwd(), 'no/such/thing.js'));
    expect(r.n.specifier).to.equal('node:fs');
  });

  it('a name that is not PascalCase is a resolve-stage error', () => {
    const err = cooperError(() => loadStringSync('#@version = 1.0\nm = !module("node:fs")', { ...isolated(), modules: { 'node:fs': 'node:fs' } }));
    expect(err.stage).to.equal('resolve');
    expect(err.message).to.match(/not a dot-separated PascalCase module name/);
  });

  it('an unmapped name is a resolve-stage error', () => {
    const err = cooperError(() => loadStringSync('#@version = 1.0\nm = !module("Foo.Bar")', isolated()));
    expect(err.stage).to.equal('resolve');
    expect(err.message).to.match(/modules/);
  });
});
