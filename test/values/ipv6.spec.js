import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { IPv6 } from '../../src/cooper.js';
import { value, valueError } from '../support/load.js';

const hextet = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 0xffff }));
const address = fc.array(hextet, { minLength: 8, maxLength: 8 });
const prefix = fc.option(fc.integer({ min: 0, max: 128 }), { nil: null });

/** @param {IPv6} ip */
const toBigInt = (ip) => ip.address.reduce((acc, g) => (acc << 16n) + BigInt(g), 0n);

describe('IPv6 construction and validation (CASC.md §6.7)', () => {
  it('accepts a well-formed address with no prefix', () => {
    const ip = new IPv6([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ip.address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(ip.prefix).to.equal(null);
  });

  it('accepts a well-formed address with a valid prefix', () => {
    const ip = new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32);
    expect(ip.address).to.deep.equal([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(ip.prefix).to.equal(32);
  });

  it('rejects an out-of-range hextet', () => {
    expect(() => new IPv6([0x10000, 0, 0, 0, 0, 0, 0, 1])).to.throw(RangeError, /invalid IPv6 address/);
  });

  it('rejects the wrong number of hextets', () => {
    expect(() => new IPv6([0, 0, 0, 1])).to.throw(RangeError, /invalid IPv6 address/);
  });

  it('rejects an out-of-range prefix', () => {
    expect(() => new IPv6([0, 0, 0, 0, 0, 0, 0, 1], 129)).to.throw(RangeError, 'invalid CIDR prefix 129 (must be 0..128)');
  });

  it('is immutable', () => {
    const ip = new IPv6([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(Object.isFrozen(ip)).to.equal(true);
    expect(Object.isFrozen(ip.address)).to.equal(true);
  });

  it('has no broadcast() -- IPv6 has no broadcast address', () => {
    expect(/** @type {any} */ (new IPv6([0, 0, 0, 0, 0, 0, 0, 1])).broadcast).to.equal(undefined);
  });
});

describe('IPv6.parse', () => {
  it('parses compressed, full, and CIDR forms', () => {
    expect(IPv6.parse('::1').address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(IPv6.parse('::').address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(IPv6.parse('fe80::').address).to.deep.equal([0xfe80, 0, 0, 0, 0, 0, 0, 0]);
    expect(IPv6.parse('1:2:3:4:5:6:7:8').address).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8]);
    const block = IPv6.parse('2001:DB8::/32');
    expect(block.address).to.deep.equal([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(block.prefix).to.equal(32);
  });

  it('parses an IPv4-mapped dotted tail', () => {
    expect(IPv6.parse('::ffff:10.0.0.1').address).to.deep.equal([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
  });

  it('rejects malformed text', () => {
    for (const text of ['1::2::3', '12345::', '1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', 'g::1', '::ffff:256.0.0.1', '', ':::']) {
      expect(() => IPv6.parse(text), text).to.throw(/invalid IP address/);
    }
  });

  it('rejects an out-of-range prefix', () => {
    expect(() => IPv6.parse('::1/129')).to.throw('invalid CIDR prefix 129 (must be 0..128)');
  });
});

describe('IPv6 display (Erlang :inet.ntoa/1 compatible)', () => {
  it('renders without a prefix', () => {
    expect(String(new IPv6([0, 0, 0, 0, 0, 0, 0, 1]))).to.equal('::1');
  });

  it('renders with a prefix', () => {
    expect(String(new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32))).to.equal('2001:db8::/32');
  });

  it('collapses the longest zero run, the first one on a tie, and never a single zero group', () => {
    expect(String(new IPv6([1, 0, 0, 2, 0, 0, 0, 3]))).to.equal('1:0:0:2::3');
    expect(String(new IPv6([1, 0, 0, 2, 0, 0, 3, 4]))).to.equal('1::2:0:0:3:4');
    expect(String(new IPv6([1, 0, 2, 3, 4, 5, 6, 7]))).to.equal('1:0:2:3:4:5:6:7');
    expect(String(new IPv6([0, 0, 0, 0, 0, 0, 0, 0]))).to.equal('::');
    expect(String(new IPv6([1, 0, 0, 0, 0, 0, 0, 0]))).to.equal('1::');
  });

  it('uses lowercase hex', () => {
    expect(String(IPv6.parse('FE80::ABCD'))).to.equal('fe80::abcd');
  });

  it('writes IPv4-mapped and IPv4-compatible addresses with a dotted tail', () => {
    expect(String(new IPv6([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1]))).to.equal('::ffff:10.0.0.1');
    expect(String(new IPv6([0, 0, 0, 0, 0, 0, 0, 2]))).to.equal('::0.0.0.2');
  });

  it('serializes to JSON as its text form and inspects as IPv6(<text>)', () => {
    const ip = new IPv6([0, 0, 0, 0, 0, 0, 0, 1], 128);
    expect(JSON.stringify(ip)).to.equal('"::1/128"');
    expect(util.inspect(ip)).to.equal('IPv6(::1/128)');
  });
});

describe('IPv6 network/netmask/host-range math', () => {
  it('an ordinary /32 block', () => {
    const cidr = new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32);
    expect(cidr.network().equals(new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32))).to.equal(true);
    expect(cidr.netmask().equals(new IPv6([0xffff, 0xffff, 0, 0, 0, 0, 0, 0]))).to.equal(true);
    expect(cidr.firstHost().equals(new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]))).to.equal(true);
    expect(
      cidr.lastHost().equals(new IPv6([0x2001, 0xdb8, 0xffff, 0xffff, 0xffff, 0xffff, 0xffff, 0xfffe]))
    ).to.equal(true);
  });

  it('a /128 has no separate network -- every field is the address itself', () => {
    const cidr = new IPv6([0, 0, 0, 0, 0, 0, 0, 1], 128);
    for (const derived of [cidr.network(), cidr.firstHost(), cidr.lastHost()]) {
      expect(derived.address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
    }
  });

  it('a /127 (point-to-point) has both addresses usable', () => {
    const cidr = new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 127);
    expect(cidr.firstHost().address).to.deep.equal([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0]);
    expect(cidr.lastHost().address).to.deep.equal([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  it('no prefix at all behaves like /128', () => {
    const cidr = new IPv6([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(cidr.network().address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(cidr.netmask().address).to.deep.equal(new Array(8).fill(0xffff));
  });

  it('/0 covers the entire address space', () => {
    const cidr = new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], 0);
    expect(cidr.network().address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(cidr.netmask().address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('IPv6#contains', () => {
  it('an address inside the block', () => {
    const cidr = new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32);
    expect(cidr.contains(new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]))).to.equal(true);
  });

  it('an address outside the block', () => {
    const cidr = new IPv6([0x2001, 0xdb8, 0, 0, 0, 0, 0, 0], 32);
    expect(cidr.contains(new IPv6([0x2001, 0xdb9, 0, 0, 0, 0, 0, 1]))).to.equal(false);
  });
});

describe('IPv6 properties', () => {
  it('parse(toString()) round-trips every address/prefix, including dotted-tail renderings', () => {
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const ip = new IPv6(parts, p);
        const again = IPv6.parse(ip.toString());
        expect(again.address).to.deep.equal(ip.address);
        expect(again.prefix).to.equal(ip.prefix);
        expect(again.toString()).to.equal(ip.toString());
      }),
      { numRuns: 500 }
    );
  });

  it('a block contains its own address, network, and host range', () => {
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const cidr = new IPv6(parts, p);
        for (const member of [cidr, cidr.network(), cidr.firstHost(), cidr.lastHost()]) {
          expect(cidr.contains(member)).to.equal(true);
        }
        const [n, f, l] = [cidr.network(), cidr.firstHost(), cidr.lastHost()].map(toBigInt);
        expect(n <= f && f <= l).to.equal(true);
      })
    );
  });

  it('a bare literal loads to the same address its text names (non-dotted renderings)', () => {
    fc.assert(
      fc.property(address, prefix, (parts, p) => {
        const ip = new IPv6(parts, p);
        fc.pre(!ip.toString().includes('.'));
        const loaded = value(ip.toString());
        expect(loaded).to.be.instanceOf(IPv6);
        expect(loaded.equals(ip)).to.equal(true);
      }),
      { numRuns: 50 }
    );
  });
});

describe('IPv6 load-time validation (CASC.md §6.7)', () => {
  it('a valid bare literal resolves to an IPv6', () => {
    const v = value('::1/128');
    expect(v).to.be.instanceOf(IPv6);
    expect(v.address).to.deep.equal([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(v.prefix).to.equal(128);
  });

  it('accepts uppercase hex and the full eight-group form', () => {
    expect(value('2001:DB8::1').toString()).to.equal('2001:db8::1');
    expect(value('1:2:3:4:5:6:7:8/64').toString()).to.equal('1:2:3:4:5:6:7:8/64');
  });

  it('an out-of-range CIDR prefix is an action-stage error with the exact message', () => {
    const err = valueError('::1/129');
    expect(err.stage).to.equal('action');
    expect(err.message).to.equal('invalid CIDR prefix 129 (must be 0..128)');
  });
});
