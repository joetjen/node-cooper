import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { IPv4 } from '../../src/cooper.js';
import { value, valueError } from '../support/load.js';

const octet = fc.integer({ min: 0, max: 255 });
const address = fc.tuple(octet, octet, octet, octet);
const prefix = fc.option(fc.integer({ min: 0, max: 32 }), { nil: null });

describe('IPv4 construction and validation (CASC.md §6.7)', () => {
  it('accepts a well-formed address with no prefix', () => {
    const ip = new IPv4([127, 0, 0, 1]);
    expect(ip.address).to.deep.equal([127, 0, 0, 1]);
    expect(ip.prefix).to.equal(null);
  });

  it('accepts a well-formed address with a valid prefix', () => {
    const ip = new IPv4([10, 0, 0, 0], 8);
    expect(ip.address).to.deep.equal([10, 0, 0, 0]);
    expect(ip.prefix).to.equal(8);
  });

  it('rejects an out-of-range octet', () => {
    expect(() => new IPv4([256, 0, 0, 1])).to.throw(RangeError, /invalid IPv4 address/);
  });

  it('rejects the wrong number of octets and non-integer octets', () => {
    expect(() => new IPv4([1, 2, 3])).to.throw(RangeError, /invalid IPv4 address/);
    expect(() => new IPv4([1, 2, 3, 4, 5])).to.throw(RangeError, /invalid IPv4 address/);
    expect(() => new IPv4([1, 2, 3, 4.5])).to.throw(RangeError, /invalid IPv4 address/);
    expect(() => new IPv4([1, 2, 3, -1])).to.throw(RangeError, /invalid IPv4 address/);
  });

  it('rejects an out-of-range prefix', () => {
    expect(() => new IPv4([10, 0, 0, 0], 33)).to.throw(RangeError, 'invalid CIDR prefix 33 (must be 0..32)');
  });

  it('rejects a negative prefix', () => {
    expect(() => new IPv4([10, 0, 0, 0], -1)).to.throw(RangeError, 'invalid CIDR prefix -1 (must be 0..32)');
  });

  it('is immutable', () => {
    const ip = new IPv4([10, 0, 0, 1], 8);
    expect(Object.isFrozen(ip)).to.equal(true);
    expect(Object.isFrozen(ip.address)).to.equal(true);
  });

  it('copies the address array rather than aliasing it', () => {
    const parts = [10, 0, 0, 1];
    const ip = new IPv4(parts);
    parts[0] = 99;
    expect(ip.address[0]).to.equal(10);
  });
});

describe('IPv4.parse', () => {
  it('parses a plain address and a CIDR block', () => {
    expect(IPv4.parse('192.168.1.1').address).to.deep.equal([192, 168, 1, 1]);
    const block = IPv4.parse('10.0.0.0/8');
    expect(block.address).to.deep.equal([10, 0, 0, 0]);
    expect(block.prefix).to.equal(8);
  });

  it('rejects an out-of-range octet with an "invalid IP address" message', () => {
    expect(() => IPv4.parse('999.0.0.1')).to.throw(/invalid IP address/);
  });

  it('rejects malformed text', () => {
    for (const text of ['1.2.3', '1.2.3.4.5', 'a.b.c.d', '1.2.3.4/', '', ' 1.2.3.4']) {
      expect(() => IPv4.parse(text), text).to.throw(/invalid IP address/);
    }
  });

  it('rejects an out-of-range prefix', () => {
    expect(() => IPv4.parse('10.0.0.0/33')).to.throw('invalid CIDR prefix 33 (must be 0..32)');
  });
});

describe('IPv4 display', () => {
  it('renders without a prefix', () => {
    expect(String(new IPv4([127, 0, 0, 1]))).to.equal('127.0.0.1');
  });

  it('renders with a prefix', () => {
    expect(String(new IPv4([127, 0, 0, 1], 32))).to.equal('127.0.0.1/32');
  });

  it('serializes to JSON as its text form', () => {
    expect(JSON.stringify({ ip: new IPv4([10, 0, 0, 0], 8) })).to.equal('{"ip":"10.0.0.0/8"}');
  });

  it('inspects as IPv4(<text>)', () => {
    expect(util.inspect(new IPv4([10, 0, 0, 1]))).to.equal('IPv4(10.0.0.1)');
  });
});

describe('IPv4 network/broadcast/netmask/host-range math', () => {
  it('an ordinary /24 block', () => {
    const cidr = new IPv4([192, 168, 1, 200], 24);
    expect(cidr.network().equals(new IPv4([192, 168, 1, 0], 24))).to.equal(true);
    expect(cidr.broadcast().equals(new IPv4([192, 168, 1, 255], 24))).to.equal(true);
    expect(cidr.netmask().equals(new IPv4([255, 255, 255, 0]))).to.equal(true);
    expect(cidr.firstHost().equals(new IPv4([192, 168, 1, 1]))).to.equal(true);
    expect(cidr.lastHost().equals(new IPv4([192, 168, 1, 254]))).to.equal(true);
  });

  it('a /32 has no separate network/broadcast -- every field is the address itself', () => {
    const cidr = new IPv4([10, 0, 0, 5], 32);
    for (const derived of [cidr.network(), cidr.broadcast(), cidr.firstHost(), cidr.lastHost()]) {
      expect(derived.address).to.deep.equal([10, 0, 0, 5]);
    }
  });

  it('a /31 (RFC 3021 point-to-point) has both addresses usable, no reserved network/broadcast', () => {
    const cidr = new IPv4([10, 0, 0, 0], 31);
    expect(cidr.network().address).to.deep.equal([10, 0, 0, 0]);
    expect(cidr.broadcast().address).to.deep.equal([10, 0, 0, 1]);
    expect(cidr.firstHost().address).to.deep.equal([10, 0, 0, 0]);
    expect(cidr.lastHost().address).to.deep.equal([10, 0, 0, 1]);
  });

  it('no prefix at all behaves like /32', () => {
    const cidr = new IPv4([10, 0, 0, 5]);
    expect(cidr.network().address).to.deep.equal([10, 0, 0, 5]);
    expect(cidr.netmask().address).to.deep.equal([255, 255, 255, 255]);
  });

  it('/0 covers the entire address space', () => {
    const cidr = new IPv4([1, 2, 3, 4], 0);
    expect(cidr.network().address).to.deep.equal([0, 0, 0, 0]);
    expect(cidr.broadcast().address).to.deep.equal([255, 255, 255, 255]);
    expect(cidr.netmask().address).to.deep.equal([0, 0, 0, 0]);
  });
});

describe('IPv4#contains', () => {
  it('an address inside the block', () => {
    expect(new IPv4([192, 168, 1, 0], 24).contains(new IPv4([192, 168, 1, 200]))).to.equal(true);
  });

  it('an address outside the block', () => {
    expect(new IPv4([192, 168, 1, 0], 24).contains(new IPv4([192, 168, 2, 1]))).to.equal(false);
  });

  it('a prefix-less address only contains its own exact address', () => {
    const cidr = new IPv4([127, 0, 0, 1]);
    expect(cidr.contains(new IPv4([127, 0, 0, 1]))).to.equal(true);
    expect(cidr.contains(new IPv4([127, 0, 0, 2]))).to.equal(false);
  });
});

describe('IPv4#equals', () => {
  it('compares address and prefix', () => {
    expect(new IPv4([1, 2, 3, 4], 8).equals(new IPv4([1, 2, 3, 4], 8))).to.equal(true);
    expect(new IPv4([1, 2, 3, 4], 8).equals(new IPv4([1, 2, 3, 4]))).to.equal(false);
    expect(new IPv4([1, 2, 3, 4]).equals('1.2.3.4')).to.equal(false);
  });
});

describe('IPv4 properties', () => {
  it('parse(toString()) round-trips every address/prefix', () => {
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const ip = new IPv4(parts, p);
        const again = IPv4.parse(ip.toString());
        expect(again.equals(ip)).to.equal(true);
        expect(again.toString()).to.equal(ip.toString());
      })
    );
  });

  it('a block contains its own address, network, broadcast, and host range', () => {
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const cidr = new IPv4(parts, p);
        for (const member of [cidr, cidr.network(), cidr.broadcast(), cidr.firstHost(), cidr.lastHost()]) {
          expect(cidr.contains(member)).to.equal(true);
        }
      })
    );
  });

  it('network <= firstHost <= lastHost <= broadcast, and network is idempotent', () => {
    const toInt = (/** @type {IPv4} */ ip) => ip.address.reduce((acc, o) => acc * 256 + o, 0);
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const cidr = new IPv4(parts, p);
        const [n, f, l, b] = [cidr.network(), cidr.firstHost(), cidr.lastHost(), cidr.broadcast()].map(toInt);
        expect(n <= f && f <= l && l <= b).to.equal(true);
        expect(cidr.network().network().equals(cidr.network())).to.equal(true);
        expect(b - n + 1).to.equal(2 ** (32 - (p ?? 32)));
      })
    );
  });

  it('a bare literal loads to the same address its text names', () => {
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const ip = new IPv4(parts, p);
        const loaded = value(ip.toString());
        expect(loaded).to.be.instanceOf(IPv4);
        expect(loaded.equals(ip)).to.equal(true);
      }),
      { numRuns: 50 }
    );
  });
});

describe('IPv4 load-time validation (CASC.md §6.7)', () => {
  it('a valid bare literal resolves to an IPv4', () => {
    const v = value('127.0.0.1/32');
    expect(v).to.be.instanceOf(IPv4);
    expect(v.address).to.deep.equal([127, 0, 0, 1]);
    expect(v.prefix).to.equal(32);
  });

  it('an out-of-range octet is an action-stage error, not a crash', () => {
    const err = valueError('999.999.999.999');
    expect(err.stage).to.equal('action');
    expect(err.message).to.match(/invalid IP address/);
  });

  it('an out-of-range CIDR prefix is an action-stage error with the exact message', () => {
    const err = valueError('127.0.0.1/33');
    expect(err.stage).to.equal('action');
    expect(err.message).to.equal('invalid CIDR prefix 33 (must be 0..32)');
  });
});
