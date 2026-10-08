import { createRequire } from 'node:module';
import { expect } from 'chai';
import fc from 'fast-check';
import { LocalDate, LocalTime, LocalDateTime, DateTime } from '../../src/cooper.js';
import { value } from '../support/load.js';

const require = createRequire(import.meta.url);
const literals = require('../../src/grammar/literals.cjs');
const { normalizeInteger, parseInteger, parseFloatLiteral, parseDuration, parseBytes, parseDate, parseTime, parseDateTime } = literals;
const { CooperFloat, formatFloat } = require('../../src/values/float.cjs');

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Inserts `_` separators at random positions *between* digits.
 * @param {string} digits
 * @returns {fc.Arbitrary<string>}
 */
const withSeparators = (digits) =>
  fc
    .array(fc.nat({ max: 2 }), { minLength: digits.length, maxLength: digits.length })
    .map((counts) => [...digits].map((d, i) => (i < digits.length - 1 ? d + '_'.repeat(counts[i]) : d)).join(''));

/** An integer literal in any base, with separators and sign, plus the value it denotes. */
const integerLiteral = fc
  .tuple(
    fc.oneof(fc.bigInt({ min: -(2n ** 80n), max: 2n ** 80n }), fc.bigInt({ min: -MAX_SAFE - 3n, max: -MAX_SAFE + 3n }), fc.bigInt({ min: MAX_SAFE - 3n, max: MAX_SAFE + 3n })),
    fc.constantFrom(/** @type {const} */ (['', 10]), ['0x', 16], ['0o', 8], ['0b', 2]),
    fc.boolean(),
    fc.boolean()
  )
  .chain(([n, [prefix, radix], upper, plus]) => {
    const abs = n < 0n ? -n : n;
    let digits = abs.toString(radix);
    if (upper) digits = digits.toUpperCase();
    const sign = n < 0n ? '-' : plus ? '+' : '';
    return withSeparators(digits).map((body) => ({ text: `${sign}${prefix}${body}`, n }));
  });

describe('literals: normalizeInteger', () => {
  it('a safe integer becomes a number, anything beyond a bigint', () => {
    expect(normalizeInteger(42n)).to.equal(42);
    expect(normalizeInteger(MAX_SAFE)).to.equal(Number.MAX_SAFE_INTEGER);
    expect(normalizeInteger(-MAX_SAFE)).to.equal(-Number.MAX_SAFE_INTEGER);
    expect(normalizeInteger(MAX_SAFE + 1n)).to.equal(MAX_SAFE + 1n);
    expect(normalizeInteger(-MAX_SAFE - 1n)).to.equal(-MAX_SAFE - 1n);
  });
});

describe('literals: integers (CASC.md §6.3)', () => {
  it('decimal with sign', () => {
    expect(parseInteger('-17')).to.equal(-17);
    expect(parseInteger('0')).to.equal(0);
    expect(parseInteger('+99')).to.equal(99);
  });

  it('hex, octal, binary', () => {
    expect(parseInteger('0xDEAD_BEEF')).to.equal(0xdeadbeef);
    expect(parseInteger('0o755')).to.equal(0o755);
    expect(parseInteger('0b11010110')).to.equal(0b11010110);
    expect(parseInteger('-0x10')).to.equal(-16);
  });

  it('digit separators', () => {
    expect(parseInteger('1_000_000')).to.equal(1_000_000);
  });

  it('-0 is plain zero', () => {
    expect(Object.is(parseInteger('-0'), 0)).to.equal(true);
  });

  it('beyond the safe range stays exact as a bigint', () => {
    expect(parseInteger('9007199254740993')).to.equal(9007199254740993n);
    expect(parseInteger('-0xFFFF_FFFF_FFFF_FFFF_FFFF')).to.equal(-0xffffffffffffffffffffn);
  });

  it('any base, sign, and separator placement parses to the value it denotes', () => {
    fc.assert(
      fc.property(integerLiteral, ({ text, n }) => {
        expect(parseInteger(text), text).to.equal(normalizeInteger(n));
      }),
      { numRuns: 1000 }
    );
  });

  it('the same literal loads end to end, as a number when safe and a bigint otherwise', () => {
    fc.assert(
      fc.property(integerLiteral, ({ text, n }) => {
        const v = value(text);
        expect(v, text).to.equal(normalizeInteger(n));
        expect(typeof v).to.equal(n >= -MAX_SAFE && n <= MAX_SAFE ? 'number' : 'bigint');
      }),
      { numRuns: 200 }
    );
  });
});

describe('literals: floats (CASC.md §6.3)', () => {
  it('plain, signed, exponent, and separated forms', () => {
    expect(parseFloatLiteral('3.1415').value).to.equal(3.1415);
    expect(parseFloatLiteral('-0.01').value).to.equal(-0.01);
    expect(parseFloatLiteral('5e+22').value).to.equal(5e22);
    expect(parseFloatLiteral('-2E-2').value).to.equal(-0.02);
    expect(parseFloatLiteral('1_000.000_1').value).to.equal(1000.0001);
  });

  it('a float stays a float inside the pipeline, even with no fractional part', () => {
    expect(parseFloatLiteral('1.0')).to.be.instanceOf(CooperFloat);
    expect(parseFloatLiteral('1.0').equals(parseFloatLiteral('1.00'))).to.equal(true);
    expect(parseFloatLiteral('1.0').equals(1)).to.equal(false);
    expect(parseFloatLiteral('0.0').equals(parseFloatLiteral('-0.0'))).to.equal(false);
  });

  it('matches Number() for any finite double written in exponent form', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (d) => {
        const text = d.toExponential();
        expect(parseFloatLiteral(text).value).to.equal(Number(text));
      })
    );
  });

  it('formats any finite double so it reads back as itself, always with a fraction', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (d) => {
        const text = formatFloat(d);
        expect(Object.is(Number(text), d), text).to.equal(true);
        expect(text).to.match(/^-?\d+\.\d+(e-?\d+)?$/);
      })
    );
  });

  it('formats a float as a decimal or with an exponent, whichever is shorter, the decimal on a tie', () => {
    expect(formatFloat(100)).to.equal('100.0');
    expect(formatFloat(1000)).to.equal('1.0e3');
    expect(formatFloat(0.0001)).to.equal('0.0001');
    expect(formatFloat(0.00001)).to.equal('1.0e-5');
  });
});

describe('literals: durations (CASC.md §6.8)', () => {
  it('the unit table', () => {
    const table = { ns: 1n, us: 1_000n, 'µs': 1_000n, ms: 1_000_000n, s: 1_000_000_000n, m: 60_000_000_000n, h: 3_600_000_000_000n, d: 86_400_000_000_000n };
    for (const [unit, ns] of Object.entries(table)) expect(parseDuration(`1${unit}`), unit).to.equal(ns);
  });

  it('compound, fractional, and separated literals', () => {
    expect(parseDuration('1h30m')).to.equal(5_400_000_000_000n);
    expect(parseDuration('1.5h')).to.equal(5_400_000_000_000n);
    expect(parseDuration('1_000ms')).to.equal(1_000_000_000n);
    expect(parseDuration('1d2h3m4s5ms6us7ns')).to.equal(93_784_005_006_007n);
  });

  it('returns an error message, never throws, for each rule violation', () => {
    expect(parseDuration('1.5h30m')).to.be.a('string').and.match(/integer components/);
    expect(parseDuration('30m1h')).to.be.a('string').and.match(/strictly descending/);
    expect(parseDuration('1h1h')).to.be.a('string').and.match(/repeated/);
    expect(parseDuration('5msXYZ9s')).to.be.a('string').and.match(/invalid duration/);
    expect(parseDuration('')).to.be.a('string').and.match(/invalid duration/);
    expect(parseDuration('5')).to.be.a('string').and.match(/invalid duration/);
    expect(parseDuration('5 m')).to.be.a('string').and.match(/invalid duration/);
  });

  it('a fractional single unit with an exact decimal value is exact', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000_000 }), fc.integer({ min: 0, max: 9 }), (whole, tenth) => {
        expect(parseDuration(`${whole}.${tenth}s`)).to.equal(BigInt(whole) * 1_000_000_000n + BigInt(tenth) * 100_000_000n);
      })
    );
  });

  it('a fractional single unit is computed exactly at any size, never through a float', () => {
    expect(parseDuration('9223372036854775807ns')).to.equal(9_223_372_036_854_775_807n);
    expect(parseDuration('100000000000000000000.5ns')).to.equal(100_000_000_000_000_000_001n);
    expect(parseDuration('12345678901234567.123456789s')).to.equal(12_345_678_901_234_567_123_456_789n);
    expect(parseDuration(`${'9'.repeat(400)}ns`)).to.equal(10n ** 400n - 1n);
    expect(parseDuration(`${'9'.repeat(400)}.5ns`)).to.equal(10n ** 400n);
  });

  it('a fraction of the smallest unit rounds half away from zero, as the reference does', () => {
    expect(parseDuration('0.5ns')).to.equal(1n);
    expect(parseDuration('0.49ns')).to.equal(0n);
    expect(parseDuration('2.5ns')).to.equal(3n);
    expect(parseDuration('1.0000005ms')).to.equal(1_000_001n);
  });

  it('a fractional single unit is (digits × factor) / 10^fraction-digits, rounded half up', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 80n - 1n }), fc.stringMatching(/^\d{1,12}$/), fc.constantFrom('ns', 'us', 'ms', 's', 'm', 'h', 'd'), (whole, fraction, unit) => {
        const factor = { ns: 1n, us: 1000n, ms: 10n ** 6n, s: 10n ** 9n, m: 60n * 10n ** 9n, h: 3600n * 10n ** 9n, d: 86400n * 10n ** 9n }[unit];
        const num = BigInt(`${whole}${fraction}`) * factor;
        const den = 10n ** BigInt(fraction.length);
        expect(parseDuration(`${whole}.${fraction}${unit}`)).to.equal((2n * num + den) / (2n * den));
      })
    );
  });

  it('never throws on arbitrary text -- a bigint or a message', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (text) => {
        const result = parseDuration(text);
        expect(['bigint', 'string']).to.include(typeof result);
      })
    );
  });
});

describe('literals: byte sizes (CASC.md §6.9)', () => {
  it('decimal and binary units, case-insensitively', () => {
    expect(parseBytes('1B')).to.equal(1n);
    expect(parseBytes('1kB')).to.equal(1000n);
    expect(parseBytes('1KB')).to.equal(1000n);
    expect(parseBytes('512MiB')).to.equal(536_870_912n);
    expect(parseBytes('10gb')).to.equal(10_000_000_000n);
    expect(parseBytes('1PiB')).to.equal(1024n ** 5n);
  });

  it('fractional numerals', () => {
    expect(parseBytes('1.5GiB')).to.equal(1_610_612_736n);
    expect(parseBytes('0.5KiB')).to.equal(512n);
  });

  it('a fractional amount is computed exactly at any size and rounds half away from zero (conformance case 162)', () => {
    expect(parseBytes('1.0005KB')).to.equal(1001n);
    expect(parseBytes('0.5B')).to.equal(1n);
    expect(parseBytes('0.0004KB')).to.equal(0n);
    expect(parseBytes('20000000.123456789PiB')).to.equal((20_000_000_123_456_789n * 1024n ** 5n * 2n + 10n ** 9n) / (2n * 10n ** 9n));
    expect(parseBytes(`${'9'.repeat(400)}B`)).to.equal(10n ** 400n - 1n);
  });

  it('returns an error message, never throws, for an unknown unit or malformed text', () => {
    expect(parseBytes('10XB')).to.be.a('string').and.match(/unit/);
    expect(parseBytes('10')).to.be.a('string').and.match(/invalid byte-size/);
    expect(parseBytes('GB')).to.be.a('string').and.match(/invalid byte-size/);
    expect(parseBytes('-1GB')).to.be.a('string');
  });

  it('never throws on arbitrary text -- a bigint or a message', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 30 }), (text) => {
        expect(['bigint', 'string']).to.include(typeof parseBytes(text));
      })
    );
  });
});

describe('literals: dates and times (CASC.md §6.6)', () => {
  it('parseDate returns a LocalDate, or a message for an impossible date', () => {
    expect(parseDate('1979-05-27')).to.be.instanceOf(LocalDate);
    expect(parseDate('2023-02-30')).to.be.a('string').and.match(/cannot parse "2023-02-30" as a date/);
  });

  it('parseTime returns a LocalTime, or a message for an impossible time', () => {
    expect(parseTime('07:32:00.5')).to.be.instanceOf(LocalTime);
    expect(parseTime('25:00:00')).to.be.a('string').and.match(/as a time/);
  });

  it('parseDateTime: no offset gives a LocalDateTime, an offset a DateTime at that instant in UTC', () => {
    expect(parseDateTime('1979-05-27T07:32:00')).to.be.instanceOf(LocalDateTime);
    const z = parseDateTime('1979-05-27T07:32:00Z');
    expect(z).to.be.instanceOf(DateTime);
    expect(String(z)).to.equal('1979-05-27T07:32:00Z');
    expect(String(parseDateTime('1979-05-27T00:00:00.120+02:00'))).to.equal('1979-05-26T22:00:00.120Z');
  });

  it('parseDateTime keeps years below 100 as written', () => {
    expect(String(parseDateTime('0005-01-01T00:00:00Z'))).to.equal('0005-01-01T00:00:00Z');
  });

  it('parseDateTime returns a message for an impossible date or offset', () => {
    expect(parseDateTime('2023-02-30T00:00:00Z')).to.be.a('string');
    expect(parseDateTime('1979-05-27T07:32:00+24:00')).to.be.a('string').and.match(/invalid offset/);
    expect(parseDateTime('1979-05-27T07:32:00+00:60')).to.be.a('string').and.match(/invalid offset/);
    expect(parseDateTime('1979-05-27T07:32:00-00:00')).to.be.a('string').and.match(/invalid offset/);
  });

  it('an offset datetime denotes the same instant Date.parse reads from the text', () => {
    const pad = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
    fc.assert(
      fc.property(
        fc.integer({ min: 1970, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 999 }),
        fc.oneof(
          fc.constant('Z'),
          fc
            .tuple(fc.constantFrom('+', '-'), fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }))
            .map(([s, h, m]) => `${s}${pad(h)}:${pad(m)}`)
            .filter((o) => o !== '-00:00')
        ),
        (y, mo, d, h, mi, s, ms, offset) => {
          const text = `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:${pad(s)}.${pad(ms, 3)}${offset}`;
          expect(/** @type {DateTime} */ (parseDateTime(text)).toDate().getTime(), text).to.equal(Date.parse(text));
        }
      )
    );
  });
});
