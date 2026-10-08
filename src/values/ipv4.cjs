'use strict';

const CIDR = require('./cidr.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const BITS = 32;
const PART_BITS = 8;

/**
 * A parsed IPv4 address with an optional CIDR prefix -- CASC.md §6.7's
 * `127.0.0.1` / `10.0.0.0/8`. Mirrors `Cooper.IPv4`: the constructor is
 * the same validation a bare literal gets at load time, so an
 * out-of-range octet or prefix is an error, never a silently accepted
 * value.
 *
 * Node has no native address object (`node:net` works with strings), so
 * the conversion helpers are `toString()` / `IPv4.parse()`.
 */
class IPv4 {
  /**
   * @param {ReadonlyArray<number>} address -- four octets, each 0..255
   * @param {number | null} [prefix] -- 0..32, or `null` for a plain address
   */
  constructor(address, prefix = null) {
    if (!Array.isArray(address) || address.length !== 4 || !address.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
      throw new RangeError(`invalid IPv4 address: ${JSON.stringify(address)}`);
    }
    CIDR.validatePrefix(prefix, BITS);
    /** @type {ReadonlyArray<number>} */
    this.address = Object.freeze([...address]);
    /** @type {number | null} */
    this.prefix = prefix;
    Object.freeze(this);
  }

  /**
   * @param {string} text -- `a.b.c.d` or `a.b.c.d/prefix`
   * @returns {IPv4}
   */
  static parse(text) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,3}))?$/.exec(text);
    if (!m) throw new SyntaxError(`invalid IP address: ${JSON.stringify(text)}`);
    const octets = [m[1], m[2], m[3], m[4]].map(Number);
    if (!octets.every((o) => o <= 255)) throw new RangeError(`invalid IP address: ${JSON.stringify(text.split('/')[0])}`);
    return new IPv4(octets, m[5] === undefined ? null : Number(m[5]));
  }

  /**
   * Whether `other`'s address falls within this block.
   * @param {IPv4} other
   * @returns {boolean}
   */
  contains(other) {
    return CIDR.contains(this.address, this.prefix, other.address, BITS, PART_BITS);
  }

  /** @returns {IPv4} the block's network address (prefix carried through) */
  network() {
    return new IPv4(CIDR.fromInt(CIDR.networkInt(this.address, this.prefix, BITS, PART_BITS), BITS, PART_BITS), this.prefix);
  }

  /** @returns {IPv4} the block's broadcast address (prefix carried through) */
  broadcast() {
    return new IPv4(CIDR.fromInt(CIDR.broadcastInt(this.address, this.prefix, BITS, PART_BITS), BITS, PART_BITS), this.prefix);
  }

  /** @returns {IPv4} the netmask implied by the prefix, as a bare address */
  netmask() {
    return new IPv4(CIDR.fromInt(CIDR.mask(this.prefix, BITS), BITS, PART_BITS));
  }

  /** @returns {IPv4} the first usable host (the network address itself for a /31 or /32) */
  firstHost() {
    return new IPv4(CIDR.fromInt(CIDR.hostRange(this.address, this.prefix, BITS, PART_BITS)[0], BITS, PART_BITS));
  }

  /** @returns {IPv4} the last usable host (the broadcast address itself for a /31 or /32) */
  lastHost() {
    return new IPv4(CIDR.fromInt(CIDR.hostRange(this.address, this.prefix, BITS, PART_BITS)[1], BITS, PART_BITS));
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof IPv4 && other.toString() === this.toString();
  }

  /** @returns {string} `a.b.c.d` or `a.b.c.d/prefix` */
  toString() {
    const address = this.address.join('.');
    return this.prefix === null ? address : `${address}/${this.prefix}`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `IPv4(${this.toString()})`;
  }
}

module.exports = IPv4;
