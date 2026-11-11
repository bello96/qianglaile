import { afterEach, describe, expect, it } from 'vitest';
import type { Recording } from '../engine/input/recorder';
import { getReplayOverride, setReplayOverride, subscribeReplayOverride } from './replayOverride';

const take = (): Recording => ({ version: 1, aspect: 16 / 9, frames: [] });

describe('replay override', () => {
  afterEach(() => setReplayOverride(null));

  it('is off to begin with', () => {
    expect(getReplayOverride()).toBeNull();
  });

  it('remembers the recording that should stand in for the camera, until it is cleared', () => {
    const rec = take();
    setReplayOverride(rec);
    expect(getReplayOverride()).toBe(rec);
    setReplayOverride(null);
    expect(getReplayOverride()).toBeNull();
  });

  it('tells subscribers when it changes, and only then', () => {
    let calls = 0;
    const off = subscribeReplayOverride(() => calls++);
    const rec = take();
    setReplayOverride(rec);
    expect(calls).toBe(1);
    setReplayOverride(rec); // 没变
    expect(calls).toBe(1);
    setReplayOverride(take());
    expect(calls).toBe(2);
    setReplayOverride(null);
    expect(calls).toBe(3);

    off();
    setReplayOverride(take());
    expect(calls).toBe(3);
  });
});
