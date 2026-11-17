import { describe, expect, it } from 'vitest';
import { parseRoute, readFlags, routeHref, type Route } from './router';

describe('parseRoute', () => {
  it('understands the three pages', () => {
    expect(parseRoute('#/')).toEqual({ page: 'home' });
    expect(parseRoute('')).toEqual({ page: 'home' });
    expect(parseRoute('#/play/wall')).toEqual({ page: 'play', game: 'wall' });
    expect(parseRoute('#/play/bubbles')).toEqual({ page: 'play', game: 'bubbles' });
    expect(parseRoute('#/lab')).toEqual({ page: 'lab' });
  });

  it('ignores a query string or trailing slash after the path', () => {
    expect(parseRoute('#/play/wall?sim=auto')).toEqual({ page: 'play', game: 'wall' });
    expect(parseRoute('#/lab/')).toEqual({ page: 'lab' });
  });

  it('sends anything unknown home', () => {
    expect(parseRoute('#/nope')).toEqual({ page: 'home' });
    expect(parseRoute('#/play')).toEqual({ page: 'home' });
    expect(parseRoute('#/play/')).toEqual({ page: 'home' });
  });
});

describe('routeHref', () => {
  it('round-trips with parseRoute', () => {
    const routes: Route[] = [{ page: 'home' }, { page: 'play', game: 'wall' }, { page: 'lab' }];
    for (const r of routes) expect(parseRoute(routeHref(r))).toEqual(r);
    expect(routeHref({ page: 'play', game: 'wall' })).toBe('#/play/wall');
  });

  it('can carry switches along', () => {
    const href = routeHref({ page: 'play', game: 'wall' }, { only: 'my-1' });
    expect(href).toBe('#/play/wall?only=my-1');
    expect(parseRoute(href)).toEqual({ page: 'play', game: 'wall' });
    expect(readFlags(href).only).toBe('my-1');
    expect(routeHref({ page: 'lab' }, {})).toBe('#/lab');
  });
});

describe('readFlags', () => {
  it('defaults to a normal run', () => {
    expect(readFlags('')).toEqual({ sim: 'off', seed: null, debug: false, e2e: false, fast: false, worker: true, only: null, level: null, players: 1 });
  });

  it('reads the development switches', () => {
    expect(readFlags('?sim=auto&seed=7&e2e=1')).toEqual({ sim: 'auto', seed: 7, debug: false, e2e: true, fast: false, worker: true, only: null, level: null, players: 1 });
    expect(readFlags('?sim=wrong&fast=1&debug=1')).toMatchObject({ sim: 'wrong', fast: true, debug: true });
    expect(readFlags('?sim=manual').sim).toBe('manual');
  });

  it('treats sim=1 as auto and rejects nonsense', () => {
    expect(readFlags('?sim=1').sim).toBe('auto');
    expect(readFlags('?sim=banana').sim).toBe('off');
    expect(readFlags('?seed=abc').seed).toBeNull();
    expect(readFlags('?seed=').seed).toBeNull();
    expect(readFlags('?seed=12.9').seed).toBe(12);
    expect(readFlags('?e2e=0').e2e).toBe(false);
  });

  it('lets you force recognition onto the main thread', () => {
    expect(readFlags('?worker=0').worker).toBe(false);
    expect(readFlags('?worker=1').worker).toBe(true);
  });

  it('reads which single wall to practise, and only accepts something shaped like a wall id', () => {
    expect(readFlags('?only=my-abc1').only).toBe('my-abc1');
    expect(readFlags('?only=low-door').only).toBe('low-door');
    expect(readFlags('?only=').only).toBeNull();
    expect(readFlags('?only=../x').only).toBeNull();
    expect(readFlags('?only=<b>').only).toBeNull();
    expect(readFlags('?only=' + 'a'.repeat(60)).only).toBeNull();
  });

  it('reads which level to start at, and ignores anything that is not a whole number from 1 to 15', () => {
    expect(readFlags('?level=15').level).toBe(15);
    expect(readFlags('?level=1').level).toBe(1);
    for (const bad of ['0', '16', 'abc', '3.5', '-2', '', '1e1']) expect(readFlags('?level=' + bad).level, bad).toBeNull();
    expect(readFlags('').level).toBeNull();
  });

  it('reads the number of players: two only when it says exactly 2', () => {
    expect(readFlags('?players=2').players).toBe(2);
    for (const other of ['1', '3', '0', 'abc', '', '2.0', '02']) expect(readFlags('?players=' + other).players, other).toBe(1);
    expect(readFlags('#/play/wall?players=2&sim=auto')).toMatchObject({ players: 2, sim: 'auto' });
  });

  it('finds flags that sit after the hash, where a hash router puts them', () => {
    expect(readFlags('#/play/wall?sim=auto&seed=3')).toMatchObject({ sim: 'auto', seed: 3 });
  });
});
