import { describe, expect, it } from 'vitest';
import { LM } from '../body/landmarks';
import { NEUTRAL } from '../body/pose';
import { PlayerTracker } from '../player/playerTracker';
import { FrameRecorder, parseRecording } from './recorder';
import { ReplayPoseSource } from './replaySource';
import { SimPoseSource } from './simSource';
import type { RawFrame } from './types';

function record(frames: number): { original: RawFrame[]; rec: ReturnType<FrameRecorder['stop']> } {
  const sim = new SimPoseSource({ seed: 9 });
  const recorder = new FrameRecorder();
  const original: RawFrame[] = [];
  sim.onFrame((f) => original.push(f));
  recorder.start(sim);
  for (let i = 0; i < frames; i++) sim.step(33);
  return { original, rec: recorder.stop() };
}

describe('FrameRecorder', () => {
  it('captures every frame while recording and nothing after', () => {
    const sim = new SimPoseSource();
    const recorder = new FrameRecorder();
    expect(recorder.recording).toBe(false);
    sim.step(33);
    recorder.start(sim);
    expect(recorder.recording).toBe(true);
    for (let i = 0; i < 5; i++) sim.step(33);
    const rec = recorder.stop();
    sim.step(33);
    expect(recorder.recording).toBe(false);
    expect(rec.version).toBe(1);
    expect(rec.frames).toHaveLength(5);
    expect(rec.aspect).toBeCloseTo(16 / 9);
  });

  it('stores landmark numbers only, compactly', () => {
    const { rec } = record(3);
    const pose = rec.frames[0].poses[0];
    expect(pose).toHaveLength(33 * 4 + 33 * 3);
    for (const n of pose) expect(Number.isFinite(n)).toBe(true);
    expect(JSON.stringify(rec).length).toBeLessThan(3 * 2600);
  });

  it('records frames with nobody in them', () => {
    const sim = new SimPoseSource();
    const recorder = new FrameRecorder();
    recorder.start(sim);
    sim.setPresent(false);
    sim.step(33);
    expect(recorder.stop().frames[0].poses).toEqual([]);
  });
});

describe('parseRecording', () => {
  it('accepts what the recorder produced, after a trip through a file', () => {
    const { rec } = record(4);
    expect(parseRecording(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
    expect(parseRecording({ version: 1, aspect: 4 / 3, frames: [] })).toEqual({ version: 1, aspect: 4 / 3, frames: [] });
  });

  it('accepts frames with nobody in them', () => {
    expect(parseRecording({ version: 1, aspect: 1.5, frames: [{ t: 0, poses: [] }] })).not.toBeNull();
  });

  it('rejects files that are something else', () => {
    const { rec } = record(2);
    const good = JSON.parse(JSON.stringify(rec));
    const pose = good.frames[0].poses[0];
    const bad: unknown[] = [
      null,
      'recording',
      [],
      {},
      { ...good, version: 2 },
      { ...good, aspect: 0 },
      { ...good, aspect: 'wide' },
      { ...good, aspect: Infinity },
      { ...good, frames: 'many' },
      { ...good, frames: [null] },
      { ...good, frames: [{ t: 'now', poses: [] }] },
      { ...good, frames: [{ t: 0 }] },
      { ...good, frames: [{ t: 0, poses: [pose.slice(0, 50)] }] },
      { ...good, frames: [{ t: 0, poses: [[...pose.slice(0, -1), 'x']] }] },
      { ...good, frames: [{ t: 0, poses: [[...pose.slice(0, -1), null]] }] },
      { ...good, frames: [{ t: 0, poses: ['flat'] }] },
    ];
    for (const b of bad) expect(parseRecording(b), JSON.stringify(b)?.slice(0, 70)).toBeNull();
  });
});

describe('recordings that could misbehave', () => {
  it('rejects timestamps that do not move forward — replaying those on a loop would never get anywhere', () => {
    const { rec } = record(4);
    const good = JSON.parse(JSON.stringify(rec)) as typeof rec;
    expect(parseRecording({ ...good, frames: good.frames.map((f) => ({ ...f, t: 5 })) })).toBeNull();
    expect(parseRecording({ ...good, frames: [...good.frames].reverse() })).toBeNull();
    expect(parseRecording({ ...good, frames: [good.frames[0], good.frames[0]] })).toBeNull();
    expect(parseRecording({ ...good, frames: [good.frames[0]] })).not.toBeNull();
  });

  it('the recorder stops by itself at its length limit instead of growing for ever', () => {
    const sim = new SimPoseSource();
    const recorder = new FrameRecorder({ maxFrames: 10 });
    recorder.start(sim);
    expect(recorder.full).toBe(false);
    for (let i = 0; i < 25; i++) sim.step(33);
    expect(recorder.frameCount).toBe(10);
    expect(recorder.full).toBe(true);
    expect(recorder.stop().frames).toHaveLength(10);
    // 再录一次从头开始
    recorder.start(sim);
    expect(recorder.full).toBe(false);
    sim.step(33);
    expect(recorder.frameCount).toBe(1);
  });

  it('by default records about five minutes', () => {
    expect(new FrameRecorder().maxFrames).toBe(9000);
  });
});

describe('ReplayPoseSource', () => {
  it('plays a recording back with the original timing and coordinates', () => {
    const { original, rec } = record(20);
    const replay = new ReplayPoseSource(JSON.parse(JSON.stringify(rec)));
    const got: RawFrame[] = [];
    replay.onFrame((f) => got.push(f));
    for (let i = 0; i < 40; i++) replay.step(33);

    expect(got).toHaveLength(20);
    for (let i = 1; i < got.length; i++) {
      expect(got[i].t - got[i - 1].t).toBeCloseTo(original[i].t - original[i - 1].t, 6);
    }
    for (const i of [0, 7, 19]) {
      for (const lm of [LM.nose, LM.leftWrist, LM.rightAnkle]) {
        expect(got[i].poses[0].image[lm].x).toBeCloseTo(original[i].poses[0].image[lm].x, 3);
        expect(got[i].poses[0].image[lm].v).toBeCloseTo(original[i].poses[0].image[lm].v, 3);
        expect(got[i].poses[0].world[lm].y).toBeCloseTo(original[i].poses[0].world[lm].y, 3);
      }
    }
    expect(replay.kind).toBe('replay');
  });

  it('can stand in for the camera: the rest of the pipeline gives the same answer from a recording as it did live', () => {
    // 这就是录制的用途：录一段，之后改了滤波或判定的参数，拿同一段数据再跑一遍，看结果变了多少
    const sim = new SimPoseSource({ seed: 4 });
    const live = new PlayerTracker();
    const recorder = new FrameRecorder();
    sim.onFrame((f) => live.ingest(f));
    recorder.start(sim);
    sim.setPose({ ...NEUTRAL, armL: [{ a: 90 }, { a: 90 }], armR: [{ a: 150 }, { a: 170 }] }, {}, 0.5);
    for (let i = 0; i < 60; i++) sim.step(33);
    const rec = JSON.parse(JSON.stringify(recorder.stop())) as ReturnType<FrameRecorder['stop']>;

    const again = new PlayerTracker();
    const replay = new ReplayPoseSource(rec);
    replay.onFrame((f) => again.ingest(f));
    while (!replay.done) replay.step(33);

    const a = live.state.body!.skeleton;
    const b = again.state.body!.skeleton;
    for (const j of ['wristL', 'wristR', 'head', 'ankleL'] as const) {
      expect(Math.hypot(a[j].x - b[j].x, a[j].y - b[j].y), j).toBeLessThan(0.002);
    }
    expect(again.state.profile.upperArm).toBeCloseTo(live.state.profile.upperArm, 3);
  });

  it('returns null from step once it has run out', () => {
    const { rec } = record(3);
    const replay = new ReplayPoseSource(rec);
    let last: RawFrame | null = null;
    for (let i = 0; i < 10; i++) last = replay.step(33);
    expect(last).toBeNull();
    expect(replay.done).toBe(true);
  });

  it('loops with timestamps that keep increasing', () => {
    const { rec } = record(5);
    const replay = new ReplayPoseSource(rec, { loop: true });
    const times: number[] = [];
    replay.onFrame((f) => times.push(f.t));
    for (let i = 0; i < 30; i++) replay.step(33);
    expect(times.length).toBeGreaterThan(12);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    expect(replay.done).toBe(false);
  });

  it('handles an empty recording', () => {
    const replay = new ReplayPoseSource({ version: 1, aspect: 1.5, frames: [] });
    expect(replay.step(33)).toBeNull();
    expect(replay.done).toBe(true);
  });
});
