'use strict';

const CIDR = require('./cidr.cjs');

const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const BITS = 128;
const PART_BITS = 16;

/**
 * Parses the textual hextet form (with at most one `::`, and an optional
 * trailing dotted IPv4 part) into eight 16-bit groups, or `null`.
 * @param {string} text
 * @returns {number[] | null}
 */
function parseGroups(text) {
  let tail4 = /** @type {number[]} */ ([]);
  let body = text;
  const v4 = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const octets = [v4[2], v4[3], v4[4], v4[5]].map(Number);
    if (!octets.every((o) => o <= 255)) return null;
    tail4 = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    body = v4[1].endsWith('::') ? v4[1] : v4[1].slice(0, -1);
  }
  const halves = body.split('::');
  if (halves.length > 2) return null;
  /** @param {string} s */
  const groups = (s) => (s === '' ? [] : s.split(':'));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  if (![...head, ...rest].every((g) => /^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  const known = head.length + rest.length + tail4.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const zeros = halves.length === 2 ? new Array(8 - known).fill(0) : [];
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail4];
}

/**
 * Erlang's `:inet.ntoa/1` rendering, so an address displays the same as
 * in the Elixir implementation: lowercase hex, the longest run of two or
 * more zero groups (the first, on a tie) collapsed to `::`, and the
 * IPv4-compatible (`::a.b.c.d`) and IPv4-mapped (`::ffff:a.b.c.d`) forms
 * written with a dotted tail.
 * @param {ReadonlyArray<number>} g
 * @returns {string}
 */
function formatGroups(g) {
  const dotted = () => `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  const leadingZeros = g.slice(0, 5).every((x) => x === 0);
  if (leadingZeros && g[5] === 0xffff) return `::ffff:${dotted()}`;
  if (leadingZeros && g[5] === 0 && (g[6] !== 0 || g[7] > 1)) return `::${dotted()}`;
  let bestStart = -1;
  let bestLength = 1;
  for (let i = 0; i < 8; ) {
    if (g[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLength) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  /** @param {ReadonlyArray<number>} xs */
  const hex = (xs) => xs.map((x) => x.toString(16)).join(':');
  if (bestStart < 0) return hex(g);
  return `${hex(g.slice(0, bestStart))}::${hex(g.slice(bestStart + bestLength))}`;
}

/**
 * A parsed IPv6 address with an optional CIDR prefix -- CASC.md §6.7's
 * `::1` / `fe80::/10`. Mirrors `Cooper.IPv6`, including its rendering
 * (see `toString()`).
 *
 * Unlike `IPv4` there's no `broadcast()`: IPv6 has no broadcast address,
 * and faking one would be misleading.
 */
class IPv6 {
  /**
   * @param {ReadonlyArray<number>} address -- eight 16-bit groups
   * @param {number | null} [prefix] -- 0..128, or `null` for a plain address
   */
  constructor(address, prefix = null) {
    if (!Array.isArray(address) || address.length !== 8 || !address.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)) {
      throw new RangeError(`invalid IPv6 address: ${JSON.stringify(address)}`);
    }
    CIDR.validatePrefix(prefix, BITS);
    /** @type {ReadonlyArray<number>} */
    this.address = Object.freeze([...address]);
    /** @type {number | null} */
    this.prefix = prefix;
    Object.freeze(this);
  }

  /**
   * @param {string} text -- e.g. `::1`, `fe80::1/64`, `::ffff:10.0.0.1`
   * @returns {IPv6}
   */
  static parse(text) {
    const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(text);
    const groups = m ? parseGroups(m[1]) : null;
    if (!m || !groups) throw new SyntaxError(`invalid IP address: ${JSON.stringify(text.split('/')[0])}`);
    return new IPv6(groups, m[2] === undefined ? null : Number(m[2]));
  }

  /**
   * Whether `other`'s address falls within this block.
   * @param {IPv6} other
   * @returns {boolean}
   */
  contains(other) {
    return CIDR.contains(this.address, this.prefix, other.address, BITS, PART_BITS);
  }

  /** @returns {IPv6} the block's network address (prefix carried through) */
  network() {
    return new IPv6(CIDR.fromInt(CIDR.networkInt(this.address, this.prefix, BITS, PART_BITS), BITS, PART_BITS), this.prefix);
  }

  /** @returns {IPv6} the netmask implied by the prefix, as a bare address */
  netmask() {
    return new IPv6(CIDR.fromInt(CIDR.mask(this.prefix, BITS), BITS, PART_BITS));
  }

  /** @returns {IPv6} the first usable host (the network address itself for a /127 or /128) */
  firstHost() {
    return new IPv6(CIDR.fromInt(CIDR.hostRange(this.address, this.prefix, BITS, PART_BITS)[0], BITS, PART_BITS));
  }

  /** @returns {IPv6} the last usable host (the highest address in the block for a /127 or /128) */
  lastHost() {
    return new IPv6(CIDR.fromInt(CIDR.hostRange(this.address, this.prefix, BITS, PART_BITS)[1], BITS, PART_BITS));
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof IPv6 && other.toString() === this.toString();
  }

  /** @returns {string} compressed form, plus `/prefix` when present */
  toString() {
    const address = formatGroups(this.address);
    return this.prefix === null ? address : `${address}/${this.prefix}`;
  }

  /** @returns {string} */
  toJSON() {
    return this.toString();
  }

  /** @returns {string} */
  [INSPECT]() {
    return `IPv6(${this.toString()})`;
  }
}

module.exports = IPv6;
