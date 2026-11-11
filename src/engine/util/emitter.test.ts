import { expect, it } from 'vitest';
import { Emitter } from './emitter';

it('delivers values to subscribers until they unsubscribe', () => {
  const e = new Emitter<number>();
  const got: number[] = [];
  const off = e.on((v) => got.push(v));
  e.emit(1);
  e.emit(2);
  off();
  e.emit(3);
  expect(got).toEqual([1, 2]);
});

it('supports several subscribers and clear()', () => {
  const e = new Emitter<string>();
  const a: string[] = [];
  const b: string[] = [];
  e.on((v) => a.push(v));
  e.on((v) => b.push(v));
  e.emit('x');
  e.clear();
  e.emit('y');
  expect(a).toEqual(['x']);
  expect(b).toEqual(['x']);
});

it('a subscriber may unsubscribe itself while being called', () => {
  const e = new Emitter<number>();
  const got: number[] = [];
  const off = e.on((v) => {
    got.push(v);
    off();
  });
  e.on((v) => got.push(v * 10));
  e.emit(1);
  e.emit(2);
  expect(got).toEqual([1, 10, 20]);
});
