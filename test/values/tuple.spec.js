import util from 'node:util';
import { expect } from 'chai';
import fc from 'fast-check';
import { Tuple } from '../../src/cooper.js';
import { value, load } from '../support/load.js';

describe('Tuple (CASC.md §6.11)', () => {
  it('holds its items in order, with a fixed length', () => {
    const t = new Tuple([1, 'a', null]);
    expect(t.items).to.deep.equal([1, 'a', null]);
    expect(t.length).to.equal(3);
  });

  it('is not an Array', () => {
    expect(Array.isArray(new Tuple([1, 2]))).to.equal(false);
  });

  it('is immutable, items included', () => {
    const t = Tuple.of(1, 2);
    expect(Object.isFrozen(t)).to.equal(true);
    expect(Object.isFrozen(t.items)).to.equal(true);
  });

  it('copies its source iterable rather than aliasing it', () => {
    const source = [1, 2];
    const t = Tuple.fromArray(source);
    source.push(3);
    expect(t.length).to.equal(2);
  });

  it('at() indexes like Array#at, negative counting from the end', () => {
    const t = Tuple.of('a', 'b', 'c');
    expect(t.at(0)).to.equal('a');
    expect(t.at(-1)).to.equal('c');
    expect(t.at(5)).to.equal(undefined);
  });

  it('toArray() returns a fresh, mutable copy', () => {
    const t = Tuple.of(1, 2);
    const arr = t.toArray();
    arr.push(3);
    expect(t.length).to.equal(2);
    expect(Object.isFrozen(arr)).to.equal(false);
  });

  it('is iterable and spreads into its items', () => {
    expect([...Tuple.of(1, 2, 3)]).to.deep.equal([1, 2, 3]);
  });

  it('serializes to JSON as an array', () => {
    expect(JSON.stringify({ t: Tuple.of(1, 'x') })).to.equal('{"t":[1,"x"]}');
  });

  it('inspects with its arity', () => {
    expect(util.inspect(Tuple.of(1, 2))).to.equal('Tuple(2) [ 1, 2 ]');
  });

  it('fromArray(arr).toArray() round-trips any array', () => {
    fc.assert(
      fc.property(fc.array(fc.anything()), (arr) => {
        const back = Tuple.fromArray(arr).toArray();
        expect(back.length).to.equal(arr.length);
        back.forEach((x, i) => expect(Object.is(x, arr[i])).to.equal(true));
      })
    );
  });
});

describe('tuples at load time (CASC.md §6.11)', () => {
  it('become real Tuples, not arrays', () => {
    const v = value('(52.5200, 13.4050)');
    expect(v).to.be.instanceOf(Tuple);
    expect(v.toArray()).to.deep.equal([52.52, 13.405]);
  });

  it('accept comma, newline, or whitespace separators, like lists', () => {
    expect(value('(1 2 3)').toArray()).to.deep.equal([1, 2, 3]);
    expect(value('(\n  1\n  2\n)').toArray()).to.deep.equal([1, 2]);
  });

  it('can be empty, nested, and hold mixed values', () => {
    expect(value('()').length).to.equal(0);
    const v = value('(1, (2, 3), [4], "s", nil)');
    expect(v.at(1)).to.be.instanceOf(Tuple);
    expect(v.at(1).toArray()).to.deep.equal([2, 3]);
    expect(v.at(2)).to.deep.equal([4]);
    expect(v.at(4)).to.equal(null);
  });

  it('inside a list stay tuples', () => {
    const v = value('[(1, 2), (3, 4)]');
    expect(v.every((/** @type {unknown} */ t) => t instanceof Tuple)).to.equal(true);
  });

  it('a later tuple replaces an earlier one wholesale (CASC.md §8.3)', () => {
    expect(load('t = (1, 2, 3)\nt = (9)').t.toArray()).to.deep.equal([9]);
  });
});
