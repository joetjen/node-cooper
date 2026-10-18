import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  Secret, Tuple, Duration, ByteSize, LocalDate, LocalTime, LocalDateTime, DateTime, IPv4, IPv6, ModuleRef,
} = require('../../src/cooper.cjs');

/**
 * Renders a loaded value in one plain JSON shape, so two loads (through
 * the ESM and CJS entries, or the sync and async drivers) can be compared
 * structurally.
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
  // By the name as written: what the name maps to is the consumer's own
  // host value, not part of what was loaded.
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
