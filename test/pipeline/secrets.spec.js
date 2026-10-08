import { expect } from 'chai';
import util from 'node:util';
import { Secret } from '../../src/cooper.js';
import { load, loadError } from '../support/harness.js';

/**
 * Secrecy (CASC.md §4.3) as it travels through the pipeline: copied by
 * `%{...}`, a loop's `from` template, a tag, or indexing -- and partial
 * redaction when a secret is interpolated into a larger string (§7).
 */

const REDACTED = '[~~REDACTED~~]';

/**
 * @param {unknown} value
 * @param {unknown} expected -- the revealed value
 */
function expectSecret(value, expected) {
  expect(value).to.be.instanceOf(Secret);
  expect(/** @type {Secret} */ (value).reveal()).to.deep.equal(expected);
}

describe('secrets: marking (CASC.md §4.3)', () => {
  it('a secret leaf is wrapped and reveals the real value', () => {
    expectSecret(load('*password = "hunter2"').password, 'hunter2');
  });

  it('secrecy applies from any of the three prefix positions', () => {
    expectSecret(load('*password = "x"').password, 'x');
    expectSecret(load('db.*password = "x"').db.password, 'x');
    expectSecret(load('*db.password = "x"').db.password, 'x');
  });

  it('a non-secret sibling under the same block is not wrapped', () => {
    const { db } = load('db { *password = "x", host = "localhost" }');
    expectSecret(db.password, 'x');
    expect(db.host).to.equal('localhost');
  });

  it('a secret whose value is a resolver result is wrapped too', () => {
    expectSecret(load('*password = !{vault:db}', { resolvers: { vault: () => 's3cret' } }).password, 's3cret');
  });

  it('never leaks the real value through String, JSON, or util.inspect', () => {
    const result = load('*password = "hunter2"\nnested { *token = ["a", "b"] }');
    expect(String(result.password)).to.equal(REDACTED);
    expect(`${result.password}`).to.equal(REDACTED);
    expect(JSON.stringify(result)).to.equal(`{"password":"${REDACTED}","nested":{"token":"${REDACTED}"}}`);
    expect(util.inspect(result, { depth: 10 })).not.to.contain('hunter2');
    expect(Object.keys(result.password)).not.to.include('value');
    expect({ ...result.password }).not.to.have.property('value');
  });
});

describe('secrets: secrecy travels with a copied value, not just its original path', () => {
  it('a %{...} reference to a secret path is itself wrapped', () => {
    const result = load('database { *password = "hunter2", host = "db.internal" }\ncopy = %{database.password}');
    expectSecret(result.copy, 'hunter2');
    expect(result.copy.redacted).to.equal(null);
  });

  it('a %{...} reference to a block containing a secret keeps that leaf wrapped', () => {
    const result = load('database { *password = "hunter2", host = "db.internal" }\ncopy = %{database}');
    expectSecret(result.copy.password, 'hunter2');
    expect(result.copy.host).to.equal('db.internal');
  });

  it('a @{...} variable holding a secret reference stays wrapped', () => {
    expectSecret(load('*pw = "hunter2"\n@v = %{pw}\ncopy = @{v}').copy, 'hunter2');
  });

  it('a for...from template copying a secret subtree wraps every generated copy', () => {
    const result = load('defaults.creds { *token = "topsecret" }\n@ids = ["a", "b"]\nfor @id in @{ids} from defaults.creds as replicas."@{id}" {}');
    expectSecret(result.replicas.a.token, 'topsecret');
    expectSecret(result.replicas.b.token, 'topsecret');
  });

  it('a tag applied to a secret-sourced argument re-wraps the result', () => {
    expectSecret(load('*port_secret = "8443"\ntagged = !int(%{port_secret})').tagged, 8443);
  });

  it('a filter applied to a secret-sourced reference keeps it wrapped', () => {
    expectSecret(load('*pw = "  hunter2  "\ntrimmed = %{pw | trim}').trimmed, 'hunter2');
  });

  it('indexing into a secret-wrapped list re-wraps the element', () => {
    expectSecret(load('*items = ["a", "b", "c"]\nindexed = %{items[1]}').indexed, 'b');
  });

  it('a %{...} default used for a missing path is not a secret', () => {
    expect(load('*pw = "x"\ncopy = %{nope:"plain"}').copy).to.equal('plain');
  });
});

describe('secrets: partial redaction of a secret embedded in a larger string (CASC.md §7)', () => {
  it('only the secret portion is redacted, not the whole string', () => {
    const { url } = load('database { *password = "hunter2", host = "db.internal" }\nurl = "postgres://user:%{database.password}@%{database.host}/app"');
    expect(url).to.be.instanceOf(Secret);
    expect(String(url)).to.equal('postgres://user:[~~REDACTED~~]@db.internal/app');
    expect(url.redacted).to.equal('postgres://user:[~~REDACTED~~]@db.internal/app');
    expect(JSON.stringify(url)).to.equal('"postgres://user:[~~REDACTED~~]@db.internal/app"');
    expect(util.inspect(url)).to.equal("'postgres://user:[~~REDACTED~~]@db.internal/app'");
    expect(url.reveal()).to.equal('postgres://user:hunter2@db.internal/app');
  });

  it('multiple secrets in the same string each redact independently', () => {
    const { conn } = load('*user = "admin"\n*pass = "hunter2"\nconn = "user=%{user};pass=%{pass};host=localhost"');
    expect(String(conn)).to.equal('user=[~~REDACTED~~];pass=[~~REDACTED~~];host=localhost');
    expect(Secret.reveal(conn)).to.equal('user=admin;pass=hunter2;host=localhost');
  });

  it('a secret string interpolated via a variable is still partially redacted', () => {
    const { s } = load('*pw = "hunter2"\n@v = %{pw}\ns = "pw=@{v}"');
    expect(String(s)).to.equal('pw=[~~REDACTED~~]');
    expect(s.reveal()).to.equal('pw=hunter2');
  });

  it('a plain string with no secret at all is unaffected (no wrapping)', () => {
    expect(load('@name = "world"\nv = "hello @{name}"').v).to.equal('hello world');
  });

  it('a *key whose string interpolates a plain value is wholly redacted', () => {
    const { s } = load('@x = "a"\n*s = "x-@{x}"');
    expect(String(s)).to.equal(REDACTED);
    expect(s.reveal()).to.equal('x-a');
  });

  it('a later plain write over a secret path is no longer secret', () => {
    expect(load('*password = "x"\npassword = "y"').password).to.equal('y');
  });

  it('Secret.reveal passes a non-secret through unchanged', () => {
    expect(Secret.reveal('plain')).to.equal('plain');
  });
});

describe('secrets: never appear in error messages', () => {
  it('a name built from a secret is refused without echoing it', () => {
    expect(loadError('*t = "s3cret"\nx = ${"A_%{t}"}', {}, 'resolve').message).not.to.contain('s3cret');
  });
});
