import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { LocalDate, LocalTime, LocalDateTime, DateTime } from '../../src/cooper.js';
import { value, valueError } from '../support/load.js';

const isLeap = (/** @type {number} */ y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (/** @type {number} */ y, /** @type {number} */ m) =>
  [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

const validDate = fc
  .record({ year: fc.integer({ min: 0, max: 9999 }), month: fc.integer({ min: 1, max: 12 }), day: fc.integer({ min: 1, max: 31 }) })
  .map(({ year, month, day }) => ({ year, month, day: Math.min(day, daysIn(year, month)) }));

const validTime = fc.record({
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
  second: fc.integer({ min: 0, max: 59 }),
  digits: fc.stringMatching(/^\d{0,6}$/),
});

const pad = (/** @type {number} */ n, /** @type {number} */ w) => String(n).padStart(w, '0');
const dateText = (/** @type {{year: number, month: number, day: number}} */ d) => `${pad(d.year, 4)}-${pad(d.month, 2)}-${pad(d.day, 2)}`;
const timeText = (/** @type {{hour: number, minute: number, second: number, digits: string}} */ t) =>
  `${pad(t.hour, 2)}:${pad(t.minute, 2)}:${pad(t.second, 2)}${t.digits ? `.${t.digits}` : ''}`;

describe('LocalDate (CASC.md §6.6)', () => {
  it('holds year, 1-based month, and day', () => {
    const d = new LocalDate(1979, 5, 27);
    expect([d.year, d.month, d.day]).to.deep.equal([1979, 5, 27]);
    expect(Object.isFrozen(d)).to.equal(true);
  });

  it('validates the calendar, leap years included', () => {
    expect(() => new LocalDate(2024, 2, 29)).not.to.throw();
    expect(() => new LocalDate(2000, 2, 29)).not.to.throw();
    expect(() => new LocalDate(1900, 2, 29)).to.throw(RangeError, /does not exist/);
    expect(() => new LocalDate(2023, 4, 31)).to.throw(RangeError, /does not exist/);
    expect(() => new LocalDate(2023, 13, 1)).to.throw(RangeError, /invalid month/);
    expect(() => new LocalDate(2023, 0, 1)).to.throw(RangeError, /invalid month/);
    expect(() => new LocalDate(10000, 1, 1)).to.throw(RangeError, /invalid year/);
  });

  it('parses and renders YYYY-MM-DD, zero-padded', () => {
    expect(LocalDate.parse('1979-05-27').equals(new LocalDate(1979, 5, 27))).to.equal(true);
    expect(String(new LocalDate(5, 1, 2))).to.equal('0005-01-02');
    expect(() => LocalDate.parse('1979-5-27')).to.throw(SyntaxError);
  });

  it('converts to local midnight and back, even for two-digit years', () => {
    const date = new LocalDate(1979, 5, 27).toDate();
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes()]).to.deep.equal([1979, 4, 27, 0, 0]);
    expect(new LocalDate(5, 3, 1).toDate().getFullYear()).to.equal(5);
    expect(LocalDate.fromDate(new Date(2020, 0, 31, 23, 59)).toString()).to.equal('2020-01-31');
  });

  it('toDate() keeps 0000-02-29 (year 0 is a proleptic-Gregorian leap year)', () => {
    const date = new LocalDate(0, 2, 29).toDate();
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate()]).to.deep.equal([0, 2, 29]);
  });

  it('serializes to JSON as its text and inspects as LocalDate(<text>)', () => {
    const d = new LocalDate(1979, 5, 27);
    expect(JSON.stringify(d)).to.equal('"1979-05-27"');
    expect(util.inspect(d)).to.equal('LocalDate(1979-05-27)');
  });

  it('parse(toString()) round-trips every valid date, and the bare literal loads it', () => {
    fc.assert(
      fc.property(validDate, ({ year, month, day }) => {
        const d = new LocalDate(year, month, day);
        expect(d.toString()).to.equal(dateText({ year, month, day }));
        expect(LocalDate.parse(d.toString()).equals(d)).to.equal(true);
        expect(LocalDate.fromDate(d.toDate()).equals(d)).to.equal(true);
      })
    );
    fc.assert(
      fc.property(validDate, (d) => {
        const loaded = value(dateText(d));
        expect(loaded).to.be.instanceOf(LocalDate);
        expect(loaded.toString()).to.equal(dateText(d));
      }),
      { numRuns: 50 }
    );
  });
});

describe('LocalTime (CASC.md §6.6)', () => {
  it('holds hour/minute/second/microsecond and the precision it was written with', () => {
    const t = LocalTime.parse('07:32:00.5');
    expect([t.hour, t.minute, t.second, t.microsecond, t.precision]).to.deep.equal([7, 32, 0, 500_000, 1]);
    expect(String(t)).to.equal('07:32:00.5');
  });

  it('truncates fractional digits past microseconds', () => {
    const t = LocalTime.parse('23:59:59.1234567');
    expect(t.microsecond).to.equal(123_456);
    expect(String(t)).to.equal('23:59:59.123456');
  });

  it('defaults precision to 6 digits for a non-zero microsecond, 0 otherwise', () => {
    expect(String(new LocalTime(1, 2, 3))).to.equal('01:02:03');
    expect(String(new LocalTime(1, 2, 3, 5))).to.equal('01:02:03.000005');
  });

  it('validates every field', () => {
    expect(() => new LocalTime(24, 0, 0)).to.throw(RangeError, /hour/);
    expect(() => new LocalTime(0, 60, 0)).to.throw(RangeError, /minute/);
    expect(() => new LocalTime(0, 0, 60)).to.throw(RangeError, /second/);
    expect(() => new LocalTime(0, 0, 0, 1_000_000)).to.throw(RangeError, /microsecond/);
    expect(() => new LocalTime(0, 0, 0, 1, 7)).to.throw(RangeError, /precision/);
  });

  it('equals only the same time written to the same precision, as the reference compares (conformance case 172)', () => {
    expect(LocalTime.parse('07:32:00.5').equals(LocalTime.parse('07:32:00.5'))).to.equal(true);
    expect(LocalTime.parse('07:32:00.5').equals(LocalTime.parse('07:32:00.500'))).to.equal(false);
    expect(LocalTime.parse('07:32:00.5').equals(LocalTime.parse('07:32:00.6'))).to.equal(false);
  });

  it('serializes to JSON as its text and inspects as LocalTime(<text>)', () => {
    expect(JSON.stringify(LocalTime.parse('07:32:00'))).to.equal('"07:32:00"');
    expect(util.inspect(LocalTime.parse('07:32:00'))).to.equal('LocalTime(07:32:00)');
  });

  it('parse(toString()) round-trips every valid time with up to six fractional digits', () => {
    fc.assert(
      fc.property(validTime, (t) => {
        const text = timeText(t);
        expect(LocalTime.parse(text).toString()).to.equal(text);
      })
    );
  });
});

describe('LocalDateTime (CASC.md §6.6)', () => {
  it('parses, renders, and validates both halves', () => {
    const dt = LocalDateTime.parse('1979-05-27T07:32:00.123456');
    expect([dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, dt.microsecond]).to.deep.equal([1979, 5, 27, 7, 32, 0, 123_456]);
    expect(String(dt)).to.equal('1979-05-27T07:32:00.123456');
    expect(() => LocalDateTime.parse('2023-02-30T00:00:00')).to.throw(RangeError);
    expect(() => LocalDateTime.parse('2023-02-28T24:00:00')).to.throw(RangeError);
    expect(() => LocalDateTime.parse('2023-02-28 00:00:00')).to.throw(SyntaxError);
  });

  it('converts to a local-time Date and back at millisecond resolution', () => {
    const dt = LocalDateTime.parse('1979-05-27T07:32:00.123456');
    const date = dt.toDate();
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getMilliseconds()]).to.deep.equal([1979, 4, 27, 7, 32, 123]);
    expect(String(LocalDateTime.fromDate(date))).to.equal('1979-05-27T07:32:00.123');
  });

  it('toDate() keeps 0000-02-29 (year 0 is a proleptic-Gregorian leap year)', () => {
    const date = LocalDateTime.parse('0000-02-29T12:00:00').toDate();
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()]).to.deep.equal([0, 2, 29, 12]);
  });

  it('equals only the same datetime written to the same precision, as the reference compares (conformance case 172)', () => {
    expect(LocalDateTime.parse('1979-05-27T07:32:00').equals(LocalDateTime.parse('1979-05-27T07:32:00'))).to.equal(true);
    expect(LocalDateTime.parse('1979-05-27T07:32:00').equals(LocalDateTime.parse('1979-05-27T07:32:00.000'))).to.equal(false);
    expect(LocalDateTime.parse('1979-05-27T07:32:00').equals(LocalDate.parse('1979-05-27'))).to.equal(false);
  });

  it('serializes to JSON as its text and inspects as LocalDateTime(<text>)', () => {
    const dt = LocalDateTime.parse('1979-05-27T07:32:00');
    expect(JSON.stringify(dt)).to.equal('"1979-05-27T07:32:00"');
    expect(util.inspect(dt)).to.equal('LocalDateTime(1979-05-27T07:32:00)');
  });

  it('parse(toString()) round-trips, and the bare literal loads it', () => {
    fc.assert(
      fc.property(validDate, validTime, (d, t) => {
        const text = `${dateText(d)}T${timeText(t)}`;
        expect(LocalDateTime.parse(text).toString()).to.equal(text);
      })
    );
    fc.assert(
      fc.property(validDate, validTime, (d, t) => {
        const text = `${dateText(d)}T${timeText(t)}`;
        const loaded = value(text);
        expect(loaded).to.be.instanceOf(LocalDateTime);
        expect(loaded.toString()).to.equal(text);
      }),
      { numRuns: 50 }
    );
  });
});

describe('DateTime (CASC.md §6.6)', () => {
  it('holds UTC fields, the microsecond, and the precision it was written with', () => {
    const dt = DateTime.parse('1979-05-27T07:32:00.120+05:30');
    expect([dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second, dt.microsecond, dt.precision]).to.deep.equal([1979, 5, 27, 2, 2, 0, 120_000, 3]);
    expect(Object.isFrozen(dt)).to.equal(true);
  });

  it('renders as the reference does: UTC, Z, and the fraction to its precision', () => {
    expect(String(DateTime.parse('1979-05-27T07:32:00Z'))).to.equal('1979-05-27T07:32:00Z');
    expect(String(DateTime.parse('1979-05-27T07:32:00.0Z'))).to.equal('1979-05-27T07:32:00.0Z');
    expect(String(DateTime.parse('1979-05-27T00:32:00.5-05:30'))).to.equal('1979-05-27T06:02:00.5Z');
  });

  it('truncates fractional digits past microseconds, keeping six', () => {
    const dt = DateTime.parse('1979-05-27T07:32:00.1234567Z');
    expect([dt.microsecond, dt.precision]).to.deep.equal([123_456, 6]);
    expect(String(dt)).to.equal('1979-05-27T07:32:00.123456Z');
  });

  it('an offset may carry the instant into year -1 or 10000, written as the reference writes them', () => {
    expect(String(DateTime.parse('0000-01-01T00:00:00+00:01'))).to.equal('-0001-12-31T23:59:00Z');
    expect(String(DateTime.parse('9999-12-31T23:30:00-05:00'))).to.equal('10000-01-01T04:30:00Z');
  });

  it('refuses a calendar-invalid date, an out-of-range time or offset, a -00:00 offset, and a missing offset', () => {
    expect(() => DateTime.parse('2023-02-30T00:00:00Z')).to.throw(RangeError);
    expect(() => DateTime.parse('2023-02-28T24:00:00Z')).to.throw(RangeError);
    expect(() => DateTime.parse('2023-02-28T00:00:00+24:00')).to.throw(RangeError, /offset/);
    expect(() => DateTime.parse('2023-02-28T00:00:00-00:00')).to.throw(RangeError, /offset/);
    expect(() => DateTime.parse('2023-02-28T00:00:00')).to.throw(SyntaxError);
  });

  it('validates every field of the constructor, which takes UTC fields', () => {
    expect(String(new DateTime(1979, 5, 27, 7, 32, 0, 5))).to.equal('1979-05-27T07:32:00.000005Z');
    expect(() => new DateTime(2023, 2, 29, 0, 0, 0)).to.throw(RangeError, /does not exist/);
    expect(() => new DateTime(2023, 1, 1, 0, 0, 0, 1, 7)).to.throw(RangeError, /precision/);
    expect(() => new DateTime(1.5, 1, 1, 0, 0, 0)).to.throw(RangeError, /year/);
  });

  it('converts to a Date (milliseconds) and back', () => {
    const dt = DateTime.parse('1979-05-27T07:32:00.123456Z');
    expect(dt.toDate().toISOString()).to.equal('1979-05-27T07:32:00.123Z');
    expect(String(DateTime.fromDate(new Date('1979-05-27T07:32:00.120Z')))).to.equal('1979-05-27T07:32:00.120Z');
    expect(String(DateTime.fromDate(new Date('1979-05-27T07:32:00Z')))).to.equal('1979-05-27T07:32:00Z');
    expect(DateTime.parse('0000-02-29T12:00:00Z').toDate().getUTCDate()).to.equal(29);
  });

  it('equals the same instant written to the same precision, as the reference compares (conformance case 172)', () => {
    const a = DateTime.parse('1979-05-27T07:32:00Z');
    expect(a.equals(DateTime.parse('1979-05-27T08:32:00+01:00'))).to.equal(true);
    expect(a.equals(DateTime.parse('1979-05-27T07:32:00.0Z'))).to.equal(false);
    expect(a.equals(DateTime.parse('1979-05-27T07:32:01Z'))).to.equal(false);
    expect(a.equals(LocalDateTime.parse('1979-05-27T07:32:00'))).to.equal(false);
  });

  it('serializes to JSON as its text and inspects as DateTime(<text>)', () => {
    const dt = DateTime.parse('1979-05-27T07:32:00.5Z');
    expect(JSON.stringify(dt)).to.equal('"1979-05-27T07:32:00.5Z"');
    expect(util.inspect(dt)).to.equal('DateTime(1979-05-27T07:32:00.5Z)');
  });

  it('parse(toString()) round-trips every UTC datetime with up to six fractional digits', () => {
    fc.assert(
      fc.property(validDate, validTime, (d, t) => {
        const text = `${dateText(d)}T${timeText(t)}Z`;
        expect(DateTime.parse(text).toString()).to.equal(text);
      })
    );
  });

  it('an offset shifts the instant by exactly that many minutes and never touches the fraction', () => {
    fc.assert(
      fc.property(
        validDate,
        validTime,
        fc.integer({ min: -23 * 60 - 59, max: 23 * 60 + 59 }).filter((m) => m !== 0),
        (d, t, minutes) => {
          const sign = minutes < 0 ? '-' : '+';
          const offset = `${sign}${pad(Math.floor(Math.abs(minutes) / 60), 2)}:${pad(Math.abs(minutes) % 60, 2)}`;
          const utc = DateTime.parse(`${dateText(d)}T${timeText(t)}Z`);
          const shifted = DateTime.parse(`${dateText(d)}T${timeText(t)}${offset}`);
          expect(utc.toDate().getTime() - shifted.toDate().getTime()).to.equal(minutes * 60_000);
          expect([shifted.microsecond, shifted.precision]).to.deep.equal([utc.microsecond, utc.precision]);
        }
      )
    );
  });
});

describe('dates and times at load time (CASC.md §6.6)', () => {
  it('offset datetime (Z) loads as a DateTime', () => {
    const v = value('1979-05-27T07:32:00Z');
    expect(v).to.be.instanceOf(DateTime);
    expect(String(v)).to.equal('1979-05-27T07:32:00Z');
  });

  it('offset datetime with a numeric offset is normalized to the same instant in UTC', () => {
    expect(String(value('1979-05-27T07:32:00+02:00'))).to.equal('1979-05-27T05:32:00Z');
    expect(String(value('1979-05-27T07:32:00-00:30'))).to.equal('1979-05-27T08:02:00Z');
  });

  it('offset datetime keeps its fraction to the microsecond, with the digits it was written with', () => {
    expect(String(value('1979-05-27T07:32:00.999999Z'))).to.equal('1979-05-27T07:32:00.999999Z');
    expect(String(value('1979-05-27T07:32:00.120Z'))).to.equal('1979-05-27T07:32:00.120Z');
    expect(String(value('1979-05-27T07:32:00.0+05:30'))).to.equal('1979-05-27T02:02:00.0Z');
    expect(String(value('1979-05-27T07:32:00.123456789Z'))).to.equal('1979-05-27T07:32:00.123456Z');
  });

  it('the offset -00:00 (an unknown local offset in RFC 3339) is an action-stage error, as in the reference (conformance case 173)', () => {
    expect(valueError('1979-05-27T07:32:00-00:00').stage).to.equal('action');
    expect(String(value('1979-05-27T07:32:00+00:00'))).to.equal('1979-05-27T07:32:00Z');
  });

  it('local datetime', () => {
    const v = value('1979-05-27T07:32:00');
    expect(v).to.be.instanceOf(LocalDateTime);
    expect(String(v)).to.equal('1979-05-27T07:32:00');
  });

  it('local date', () => {
    const v = value('1979-05-27');
    expect(v).to.be.instanceOf(LocalDate);
    expect(String(v)).to.equal('1979-05-27');
  });

  it('local time, with optional fractional seconds', () => {
    expect(value('07:32:00')).to.be.instanceOf(LocalTime);
    expect(String(value('07:32:00'))).to.equal('07:32:00');
    expect(String(value('07:32:00.5'))).to.equal('07:32:00.5');
  });

  it('a calendar-invalid date is a clean action-stage error (conformance case 909)', () => {
    for (const literal of ['2023-02-30', '2023-02-29', '2023-04-31', '2023-13-01']) {
      const err = valueError(literal);
      expect(err.stage, literal).to.equal('action');
      expect(err.message, literal).to.match(/cannot parse/);
    }
  });

  it('an out-of-range time or offset is an action-stage error', () => {
    expect(valueError('24:00:00').stage).to.equal('action');
    expect(valueError('23:59:60').stage).to.equal('action');
    expect(valueError('1979-05-27T07:32:00+25:00').stage).to.equal('action');
  });
});
