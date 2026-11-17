import { describe, expect, it } from 'vitest';
import { NEUTRAL, poseToSkeleton } from '../body/pose';
import { defaultProfile } from '../body/profile';
import { jointsToRawPose, skeletonToJoints33 } from '../input/simSource';
import type { RawFrame, RawPose } from '../input/types';
import { inLane, LaneSplit } from './lanes';

const profile = defaultProfile();
const ASPECT = 16 / 9;

/** 造一个站在舞台 x 处的人；s 越大表示离镜头越近（在画面里越大）。 */
function person(x: number, s = 0.42): RawPose {
  const { joints, vis } = skeletonToJoints33(poseToSkeleton(NEUTRAL, profile, { x }), profile);
  return jointsToRawPose(joints, vis, { aspect: ASPECT, s, groundV: 0.95 });
}
const frame = (t: number, ...poses: RawPose[]): RawFrame => ({ t, aspect: ASPECT, poses });
/** 舞台 x 处的人，在没镜像的画面里的横向位置（0～1）。舞台的右边在画面的左边。 */
const rawX = (x: number, s = 0.42): number => (ASPECT / 2 - x * s) / ASPECT;
const watch = (split: LaneSplit, n: number, ...poses: RawPose[]): void => {
  for (let i = 0; i < n; i++) split.observe(frame(i * 33, ...poses));
};

describe('LaneSplit', () => {
  it('starts down the middle of the picture', () => {
    expect(new LaneSplit().value).toBe(0.5);
  });

  it('moves to half-way between the two players, wherever they stand', () => {
    const split = new LaneSplit();
    watch(split, 40, person(-0.9), person(0.3));
    expect(split.value).toBeCloseTo((rawX(-0.9) + rawX(0.3)) / 2, 2);
  });

  it('stays put while only one person is in view', () => {
    const split = new LaneSplit();
    watch(split, 40, person(0.8));
    expect(split.value).toBe(0.5);
  });

  it('is not fooled when the model reports the same person twice', () => {
    const split = new LaneSplit();
    watch(split, 40, person(0.6), person(0.62));
    expect(split.value).toBe(0.5);
  });

  it('goes by the two biggest people when someone else is in the background', () => {
    const split = new LaneSplit();
    watch(split, 40, person(-0.7), person(0.7), person(3.4, 0.2));
    expect(split.value).toBeCloseTo((rawX(-0.7) + rawX(0.7)) / 2, 2);
  });

  it('stops moving once frozen (calibration), until it is reset', () => {
    const split = new LaneSplit();
    watch(split, 40, person(-0.9), person(0.3));
    const at = split.value;
    split.freeze();
    expect(split.frozen).toBe(true);
    watch(split, 40, person(-0.2), person(1.2));
    expect(split.value).toBe(at);
    split.reset();
    expect([split.value, split.frozen]).toEqual([0.5, false]);
  });
});

describe('inLane', () => {
  it('the left lane is the left of the screen, which is the right of the unmirrored picture', () => {
    const split = new LaneSplit();
    expect(inLane({ side: 'left', split }, 0.7)).toBe(true);
    expect(inLane({ side: 'left', split }, 0.3)).toBe(false);
    expect(inLane({ side: 'right', split }, 0.3)).toBe(true);
    expect(inLane({ side: 'right', split }, 0.7)).toBe(false);
    // 舞台上站在左边（x 为负）的人，就在左边那条泳道里
    expect(inLane({ side: 'left', split }, rawX(-0.75))).toBe(true);
    expect(inLane({ side: 'right', split }, rawX(0.75))).toBe(true);
  });
});
