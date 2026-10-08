import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  Secret, Tuple, Duration, ByteSize, LocalDate, LocalTime, LocalDateTime, DateTime, IPv4, IPv6, ModuleRef,
} = require('../../src/cooper.cjs');

/**
 * Renders a loaded value in the implementation-neutral JSON shape
 * `scripts/oracle.exs` writes for the Elixir reference, so the two can be
 * compared structurally.
 * @param {unknown} value
 * @returns {unknown}
 */
export function canon(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return { int: value.toString() };
  if (typeof value === 'number') {
    if (value === Infinity) return { float: 'inf' };
    if (value === -Infinity) return { float: '-inf' };
    return Number.isSafeInteger(value) ? { int: String(value) } : { float: value };
  }
  if (typeof value === 'symbol') return { atom: value.description };
  if (Array.isArray(value)) return value.map(canon);
  if (value instanceof Secret) return { secret: canon(value.value), redacted: value.redacted };
  if (value instanceof Tuple) return { tuple: value.items.map(canon) };
  if (value instanceof Duration) return { duration: value.nanoseconds.toString() };
  if (value instanceof ByteSize) return { bytes: value.bytes.toString() };
  if (value instanceof IPv4) return { ipv4: value.toString() };
  if (value instanceof IPv6) return { ipv6: value.toString() };
  if (value instanceof LocalDate) return { date: value.toString() };
  if (value instanceof LocalTime) return { time: value.toString() };
  if (value instanceof LocalDateTime) return { localDateTime: value.toString() };
  if (value instanceof DateTime) return { dateTime: value.toString() };
  // By the name as written, as the oracle canonicalizes a module: each
  // implementation's own host value for it differs.
  if (value instanceof ModuleRef) return { module: value.name };
  if (typeof value === 'object') {
    return {
      map: Object.keys(value)
        .sort()
        .map((k) => [k, canon(/** @type {Record<string, unknown>} */ (value)[k])]),
    };
  }
  throw new Error(`no canonical form for ${String(value)}`);
}

/**
 * Normalizes an oracle (or canon) document for comparison: a float the
 * reference wrote that is integral compares equal to an integer (JS has
 * one number type, and a loaded float reaches the caller as a plain
 * `number`). Everything else, an offset datetime included, compares
 * exactly.
 * @param {unknown} doc
 * @returns {unknown}
 */
export function normalize(doc) {
  if (Array.isArray(doc)) return doc.map(normalize);
  if (doc === null || typeof doc !== 'object') return doc;
  const obj = /** @type {Record<string, unknown>} */ (doc);
  if ('float' in obj && typeof obj.float === 'number' && Number.isSafeInteger(obj.float)) return { int: String(obj.float) };
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = normalize(v);
  if (Array.isArray(out.map)) out.map = [...out.map].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}
