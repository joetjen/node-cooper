'use strict';

/**
 * @fileoverview Shared bitwise CIDR math for `IPv4`/`IPv6` -- both address
 * families need the identical operations, differing only in bit width
 * (32 vs 128) and part width (8-bit octets vs 16-bit hextets). Mirrors
 * `Cooper.CIDR`; not part of the public API. All math is `bigint`, so the
 * 128-bit IPv6 case needs nothing special.
 */

/**
 * @param {number | null} prefix
 * @param {number} max
 */
function validatePrefix(prefix, max) {
  if (prefix === null) return;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) {
    throw new RangeError(`invalid CIDR prefix ${prefix} (must be 0..${max})`);
  }
}

/**
 * @param {ReadonlyArray<number>} parts
 * @param {number} partBits
 * @returns {bigint}
 */
function toInt(parts, partBits) {
  return parts.reduce((acc, part) => (acc << BigInt(partBits)) + BigInt(part), 0n);
}

/**
 * @param {bigint} int
 * @param {number} bits
 * @param {number} partBits
 * @returns {number[]}
 */
function fromInt(int, bits, partBits) {
  const partMask = (1n << BigInt(partBits)) - 1n;
  const count = bits / partBits;
  const parts = [];
  for (let i = count - 1; i >= 0; i--) parts.push(Number((int >> BigInt(i * partBits)) & partMask));
  return parts;
}

/**
 * `null` (no CIDR suffix) means "this one address": a full host mask.
 * @param {number | null} prefix
 * @param {number} bits
 * @returns {bigint}
 */
function mask(prefix, bits) {
  const p = prefix ?? bits;
  const full = (1n << BigInt(bits)) - 1n;
  return (full << BigInt(bits - p)) & full;
}

/**
 * @param {ReadonlyArray<number>} parts
 * @param {number | null} prefix
 * @param {number} bits
 * @param {number} partBits
 * @returns {bigint}
 */
function networkInt(parts, prefix, bits, partBits) {
  return toInt(parts, partBits) & mask(prefix, bits);
}

/**
 * @param {ReadonlyArray<number>} parts
 * @param {number | null} prefix
 * @param {number} bits
 * @param {number} partBits
 * @returns {bigint}
 */
function broadcastInt(parts, prefix, bits, partBits) {
  const full = (1n << BigInt(bits)) - 1n;
  return networkInt(parts, prefix, bits, partBits) | (full ^ mask(prefix, bits));
}

/**
 * A block with two or fewer addresses (/31, /32 for v4; /127, /128 for v6)
 * reserves no network/broadcast id -- every address is a usable host
 * (RFC 3021 for the v4 /31 case).
 * @param {ReadonlyArray<number>} parts
 * @param {number | null} prefix
 * @param {number} bits
 * @param {number} partBits
 * @returns {[bigint, bigint]}
 */
function hostRange(parts, prefix, bits, partBits) {
  const network = networkInt(parts, prefix, bits, partBits);
  const broadcast = broadcastInt(parts, prefix, bits, partBits);
  return (prefix ?? bits) >= bits - 1 ? [network, broadcast] : [network + 1n, broadcast - 1n];
}

/**
 * @param {ReadonlyArray<number>} cidrParts
 * @param {number | null} cidrPrefix
 * @param {ReadonlyArray<number>} otherParts
 * @param {number} bits
 * @param {number} partBits
 * @returns {boolean}
 */
function contains(cidrParts, cidrPrefix, otherParts, bits, partBits) {
  const m = mask(cidrPrefix, bits);
  return (toInt(cidrParts, partBits) & m) === (toInt(otherParts, partBits) & m);
}

module.exports = { validatePrefix, toInt, fromInt, mask, networkInt, broadcastInt, hostRange, contains };
