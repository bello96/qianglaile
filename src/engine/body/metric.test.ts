import { describe, expect, it } from 'vitest';
import type { RawPose } from '../input/types';
import { toRawPose } from '../vision/convert';
import fixture from './__fixtures__/warrior-full.json';
import { CORE_LM, LM } from './landmarks';
import { fitSimilarity, toMetric } from './metric';

// 真实模型对一张真人照片的输出：战士二式，双臂平举，脸朝画面左侧
const pose = toRawPose(fixture.landmarks, fixture.world);
const aspect = fixture.w / fixture.h;

const withVisibility = (p: RawPose, visible: (i: number) => boolean): RawPose => ({
  image: p.image.map((l, i) => ({ ...l, v: visible(i) ? 1 : 0 })),
  world: p.world,
});

describe('toRawPose', () => {
  it('copies coordinates and maps visibility to v', () => {
    expect(pose.image).toHaveLength(33);
    expect(pose.world).toHaveLength(33);
    expect(pose.image[LM.nose].v).toBeCloseTo(fixture.landmarks[LM.nose].visibility);
    expect(pose.image[LM.nose].x).toBeCloseTo(fixture.landmarks[LM.nose].x);
    expect(pose.world[LM.leftWrist].x).toBeCloseTo(fixture.world[LM.leftWrist].x);
  });

  it('treats a missing visibility as fully visible', () => {
    const p = toRawPose([{ x: 0.1, y: 0.2, z: 0 }], [{ x: 0, y: 0, z: 0 }]);
    expect(p.image[0].v).toBe(1);
  });
});

describe('fitSimilarity on real model output', () => {
  const sim = fitSimilarity(pose, aspect)!;

  it('uses all 13 core landmarks and finds a plausible scale', () => {
    expect(sim.n).toBe(13);
    expect(sim.s).toBeGreaterThan(0.455);
    expect(sim.s).toBeLessThan(0.48);
  });

  it('returns null when nothing is visible', () => {
    expect(fitSimilarity(withVisibility(pose, () => false), aspect)).toBeNull();
  });

  it('returns null with fewer than four usable landmarks', () => {
    const three = new Set<number>([LM.nose, LM.leftShoulder, LM.rightShoulder]);
    expect(fitSimilarity(withVisibility(pose, (i) => three.has(i)), aspect)).toBeNull();
  });

  it('returns null when the visible landmarks collapse to one point', () => {
    const collapsed: RawPose = {
      image: pose.image.map((l) => ({ ...l, x: 0.5, y: 0.5 })),
      world: pose.world.map((l) => ({ ...l, x: 0, y: 0 })),
    };
    expect(fitSimilarity(collapsed, aspect)).toBeNull();
  });
});

describe('toMetric on real model output', () => {
  const sim = fitSimilarity(pose, aspect)!;
  const m = toMetric(pose, aspect, sim);

  it('puts the player\'s left hand on -x and right hand on +x (mirror view)', () => {
    expect(m.joints[LM.leftWrist].x).toBeLessThan(-0.58);
    expect(m.joints[LM.rightWrist].x).toBeGreaterThan(0.56);
  });

  it('has y pointing up, hips at the origin', () => {
    expect(m.joints[LM.nose].y).toBeGreaterThan(0.52);
    expect(m.joints[LM.leftAnkle].y).toBeLessThan(-0.38);
    const hipX = (m.joints[LM.leftHip].x + m.joints[LM.rightHip].x) / 2;
    const hipY = (m.joints[LM.leftHip].y + m.joints[LM.rightHip].y) / 2;
    expect(Math.hypot(hipX, hipY)).toBeLessThan(0.05);
  });

  it('faces -z (the nose is in front of the hips)', () => {
    expect(m.joints[LM.nose].z).toBeLessThan(0);
  });

  it('agrees with the model\'s own world landmarks to within a few centimetres', () => {
    let sum = 0;
    for (const i of CORE_LM) {
      sum += Math.hypot(m.joints[i].x - -pose.world[i].x, m.joints[i].y - -pose.world[i].y);
    }
    expect(sum / CORE_LM.length).toBeLessThan(0.03);
  });

  it('carries visibility through', () => {
    expect(m.vis).toHaveLength(33);
    expect(m.vis[LM.nose]).toBeCloseTo(pose.image[LM.nose].v);
  });
});
