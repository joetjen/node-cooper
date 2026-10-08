import { expect } from 'chai';
import { load, loadError, throwsCooper } from '../support/harness.js';

/**
 * CASC.md §7.2 "Built names": a reference's *name* may be built by
 * interpolation -- `${"TOKEN_@{id}"}` -- so a document can follow a
 * one-variable-per-tenant deployment convention.
 */

const env = {
  TOKEN_1: 'tok-one',
  TOKEN_2: 'tok-two',
  APP_HOST: 'example.test',
  APP_s3cret: 'should-never-be-read',
};

describe('built names: ${"..."} (CASC.md §7.2)', () => {
  it('reads the environment variable the name resolves to', () => {
    expect(load('@which = "HOST"\nhost = ${"APP_@{which}"}', { env })).to.deep.equal({ host: 'example.test' });
  });

  it('still honours a default when the built name is unset', () => {
    expect(load('@which = "COOPER_MISSING"\nhost = ${"APP_@{which}":"fallback"}', { env })).to.deep.equal({ host: 'fallback' });
  });

  it('may be built from another ${...}', () => {
    expect(load('host = ${"APP_${WHICH}"}', { env: { ...env, WHICH: 'HOST' } })).to.deep.equal({ host: 'example.test' });
  });
});

describe('built names: @{"..."} (CASC.md §7.2)', () => {
  it('reads the variable the name resolves to', () => {
    expect(load('@target = "indirect"\n@which = "target"\nvalue = @{"@{which}"}', { env })).to.deep.equal({ value: 'indirect' });
  });
});

describe('built names inside a for loop (the motivating case)', () => {
  it('reads one differently-named variable per iteration', () => {
    const source = '@ids = ["1", "2"]\n\nfor @id in @{ids} as tokens {\n  "@{id}" = ${"TOKEN_@{id}"}\n}';
    expect(load(source, { env })).to.deep.equal({ tokens: { 1: 'tok-one', 2: 'tok-two' } });
  });

  it('substitutes a loop binding into a body key, keeping every iteration (regression)', () => {
    const source = '@ids = ["a", "b"]\n\nfor @id in @{ids} as out {\n  "@{id}" = "value-@{id}"\n}';
    expect(load(source, { env })).to.deep.equal({ out: { a: 'value-a', b: 'value-b' } });
  });
});

describe('built names: guardrails', () => {
  it('rejects a name that is not identifier-shaped', () => {
    expect(loadError('@bad = "not an identifier"\nx = ${"APP_@{bad}"}', { env }, 'resolve').message).to.contain('not a valid name');
  });

  it('rejects a name built from a secret, which would appear unredacted in errors', () => {
    const { message } = loadError('*token = "s3cret"\nx = ${"APP_%{token}"}', { env }, 'resolve');
    expect(message).to.contain('may not be built from a secret value');
    expect(message).not.to.contain('s3cret');
  });

  it('rejects a built name that does not start like an identifier (a bare number)', () => {
    expect(loadError('@n = 42\nx = ${"@{n}"}', { env }, 'resolve').message).to.contain('not a valid name');
    expect(loadError('@n = 42\nx = @{"@{n}"}', { env }, 'resolve').message).to.contain('not a valid name');
  });

  it('a number interpolated into a longer name stringifies like anywhere else', () => {
    expect(load('@n = 1\nx = ${"TOKEN_@{n}"}', { env })).to.deep.equal({ x: 'tok-one' });
  });
});

describe('built names: a %{...} path segment', () => {
  it('resolves an interpolated segment', () => {
    const source = '@id = "1"\ntokens {\n  "supervisor-1" = "one"\n}\n\nprobe = %{tokens."supervisor-@{id}"}';
    expect(load(source, { env }).probe).to.equal('one');
  });

  it('allows a key that is not identifier-shaped, unlike a name', () => {
    const source = '@k = "with-hyphen"\nm {\n  "with-hyphen" = 1\n}\n\nprobe = %{m."@{k}"}';
    expect(load(source, { env }).probe).to.equal(1);
  });

  it('rejects a key that would split into more than one path segment', () => {
    const source = '@k = "a.b"\nm {\n  "x" = 1\n}\n\nprobe = %{m."@{k}"}';
    expect(loadError(source, { env }, 'resolve').message).to.contain('more than one path segment');
  });

  it('rejects a key built from a secret', () => {
    throwsCooper(() => load('*k = "x"\nm { x = 1 }\nprobe = %{m."%{k}"}', { env }));
  });
});

describe('built names: the bare form only', () => {
  it('a built name nested inside a larger string is a clean parse error', () => {
    throwsCooper(() => load('@w = "HOST"\nx = "url=${"APP_@{w}"}"', { env }), 'parser');
  });
});
