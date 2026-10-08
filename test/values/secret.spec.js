import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { Secret } from '../../src/cooper.js';
import { load } from '../support/load.js';

const MARKER = '[~~REDACTED~~]';

/**
 * Every way a value commonly reaches a log line or a wire format.
 * @param {unknown} value
 * @returns {string[]}
 */
function renderings(value) {
  return [
    String(value),
    `${value}`,
    // eslint-disable-next-line prefer-template
    /** @type {any} */ (value) + '',
    JSON.stringify(value),
    JSON.stringify({ nested: value }),
    JSON.stringify([value]),
    util.inspect(value),
    util.inspect({ nested: [value] }, { depth: Infinity }),
    util.inspect(value, { showHidden: true }),
    util.format('%s %o %O %j', value, value, value, value),
  ];
}

describe('Secret: a whole-value secret (redacted defaults to null -- the blanket marker)', () => {
  it('exposes the marker as Secret.REDACTED', () => {
    expect(Secret.REDACTED).to.equal(MARKER);
  });

  it('inspect renders the bare, unquoted marker', () => {
    expect(util.inspect(new Secret('hunter2'))).to.equal(MARKER);
  });

  it('String() and template literals render the same marker', () => {
    const secret = new Secret('hunter2');
    expect(String(secret)).to.equal(MARKER);
    expect(`${secret}`).to.equal(MARKER);
  });

  it('JSON.stringify renders the marker as a string', () => {
    expect(JSON.stringify({ password: new Secret('hunter2') })).to.equal(`{"password":"${MARKER}"}`);
  });

  it('no rendering ever contains the real value', () => {
    for (const text of renderings(new Secret('hunter2'))) expect(text).not.to.include('hunter2');
  });

  it('reveal() gives back the real value regardless of type', () => {
    expect(new Secret('hunter2').reveal()).to.equal('hunter2');
    expect(new Secret(42).reveal()).to.equal(42);
    expect(new Secret({ a: 1 }).reveal()).to.deep.equal({ a: 1 });
    expect(new Secret('hunter2').value).to.equal('hunter2');
  });

  it('Secret.reveal() unwraps a Secret and passes anything else through', () => {
    expect(Secret.reveal(new Secret('x'))).to.equal('x');
    expect(Secret.reveal('plain')).to.equal('plain');
    expect(Secret.reveal(null)).to.equal(null);
  });

  it('keeps value non-enumerable, so spread and Object.keys never copy it out', () => {
    const secret = new Secret('hunter2');
    expect(Object.keys(secret)).not.to.include('value');
    expect(/** @type {any} */ ({ ...secret }).value).to.equal(undefined);
    expect(JSON.stringify(Object.assign({}, secret))).not.to.include('hunter2');
  });

  it('is immutable', () => {
    const secret = new Secret('hunter2');
    expect(Object.isFrozen(secret)).to.equal(true);
    expect(() => {
      /** @type {any} */ (secret).value = 'other';
    }).to.throw(TypeError);
  });
});

describe('Secret: a partially redacted secret (a secret embedded in a larger string)', () => {
  const secret = () => new Secret('conn=hunter2', 'conn=[~~REDACTED~~]');

  it('String() renders the precomputed redacted text, not the blanket marker', () => {
    expect(String(secret())).to.equal('conn=[~~REDACTED~~]');
  });

  it('inspect renders it quoted, like an ordinary string', () => {
    expect(util.inspect(secret())).to.equal(util.inspect('conn=[~~REDACTED~~]'));
  });

  it('JSON.stringify renders the redacted text', () => {
    expect(JSON.stringify(secret())).to.equal('"conn=[~~REDACTED~~]"');
  });

  it('reveal() still gives back the fully unmasked real value', () => {
    expect(secret().reveal()).to.equal('conn=hunter2');
  });
});

describe('Secret properties', () => {
  it('a whole-value secret renders exactly the marker for any wrapped value', () => {
    fc.assert(
      fc.property(fc.anything(), (wrapped) => {
        const secret = new Secret(wrapped);
        expect(String(secret)).to.equal(MARKER);
        expect(JSON.stringify(secret)).to.equal(JSON.stringify(MARKER));
        expect(util.inspect(secret)).to.equal(MARKER);
        expect(util.inspect(secret, { showHidden: true })).to.equal(MARKER);
        expect(Object.is(secret.reveal(), wrapped)).to.equal(true);
      })
    );
  });

  it('a sentinel wrapped anywhere inside a value never appears in any rendering', () => {
    // Lowercase/digits only: no such character occurs in the marker itself.
    const sentinel = fc.stringMatching(/^[a-z0-9]{8,16}$/);
    const container = (/** @type {string} */ s) =>
      fc.oneof(
        fc.constant(s),
        fc.constant({ password: s }),
        fc.constant([s, s]),
        fc.constant(new Map([[s, s]])),
        fc.constant({ deep: { deeper: [{ s }] } })
      );
    fc.assert(
      fc.property(sentinel.chain((s) => fc.tuple(fc.constant(s), container(s))), ([s, wrapped]) => {
        for (const text of renderings(new Secret(wrapped))) expect(text).not.to.include(s);
      })
    );
  });

  it('a partially redacted secret renders exactly its redacted text for any value', () => {
    fc.assert(
      fc.property(fc.anything(), fc.string(), (wrapped, redacted) => {
        const secret = new Secret(wrapped, redacted);
        expect(String(secret)).to.equal(redacted);
        expect(JSON.stringify(secret)).to.equal(JSON.stringify(redacted));
        expect(util.inspect(secret)).to.equal(util.inspect(redacted));
      })
    );
  });
});

describe('Secret keys at load time (CASC.md §4.3)', () => {
  it('a leading secret prefix on a single-segment key', () => {
    const { password } = load('*password = "hunter2"');
    expect(password).to.be.instanceOf(Secret);
    expect(password.reveal()).to.equal('hunter2');
  });

  it('a secret prefix on a non-leading path segment', () => {
    const { db } = load('db.*password = "hunter2"');
    expect(db.password).to.be.instanceOf(Secret);
    expect(db.password.reveal()).to.equal('hunter2');
  });

  it('a secret prefix on the whole path', () => {
    const { db } = load('*db.password = "hunter2"');
    expect(db.password).to.be.instanceOf(Secret);
    expect(db.password.reveal()).to.equal('hunter2');
  });

  it('a secret block marks every leaf inside it, keeping the map itself plain', () => {
    const { creds } = load('*creds { user = "u", pass = "p" }');
    expect(Object.getPrototypeOf(creds)).to.equal(Object.prototype);
    expect(creds.user).to.be.instanceOf(Secret);
    expect(creds.pass.reveal()).to.equal('p');
  });

  it('wraps non-string values too', () => {
    const { n } = load('*n = 42');
    expect(n).to.be.instanceOf(Secret);
    expect(n.reveal()).to.equal(42);
  });

  it('a secret interpolated into a larger string is partially redacted', () => {
    const { conn } = load('db.*password = "hunter2"\nconn = "u:%{db.password}@h"');
    expect(conn).to.be.instanceOf(Secret);
    expect(String(conn)).to.equal('u:[~~REDACTED~~]@h');
    expect(conn.reveal()).to.equal('u:hunter2@h');
  });

  it('a loaded result never prints a secret through JSON.stringify or util.inspect', () => {
    const result = load('db.*password = "hunter2"\nconn = "u:%{db.password}@h"');
    expect(JSON.stringify(result)).not.to.include('hunter2');
    expect(util.inspect(result, { depth: Infinity })).not.to.include('hunter2');
  });
});
