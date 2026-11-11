import { describe, expect, it } from 'vitest';
import { decodeChoice, encodeChoice, MAX_DETECT_MS, pickModel, REMEMBER_DAYS, SAMPLE_FRAMES, typicalDetectMs, WARMUP_FRAMES } from './autoModel';

const steady = (ms: number, n = WARMUP_FRAMES + SAMPLE_FRAMES): number[] => Array<number>(n).fill(ms);

describe('typicalDetectMs', () => {
  it('reports how long one detection usually takes', () => {
    expect(typicalDetectMs(steady(32))).toBe(32);
    expect(typicalDetectMs(steady(80))).toBe(80);
  });

  it('ignores the slow first detections while the GPU warms up', () => {
    expect(typicalDetectMs([...Array<number>(WARMUP_FRAMES).fill(900), ...Array<number>(SAMPLE_FRAMES).fill(30)])).toBe(30);
  });

  it('is not thrown off by one hiccup', () => {
    const times = steady(30);
    times[WARMUP_FRAMES + 5] = 700;
    expect(typicalDetectMs(times)).toBe(30);
  });

  it('says it cannot tell when there are too few detections', () => {
    expect(typicalDetectMs([])).toBeNull();
    expect(typicalDetectMs(steady(30, WARMUP_FRAMES + 2))).toBeNull();
  });

  it('works with fewer detections than the full sample, once past the warm-up', () => {
    expect(typicalDetectMs(steady(45, WARMUP_FRAMES + 8))).toBe(45);
  });

  it('skips readings that are not real timings', () => {
    expect(typicalDetectMs([...steady(30), 0, Number.NaN])).toBe(30);
    expect(typicalDetectMs(steady(0))).toBeNull();
  });
});

describe('pickModel', () => {
  it('keeps the standard model when one detection is quick enough', () => {
    expect(pickModel(20)).toBe('full');
    expect(pickModel(MAX_DETECT_MS)).toBe('full');
  });

  it('drops to the light model when it is too slow', () => {
    expect(pickModel(MAX_DETECT_MS + 1)).toBe('lite');
    expect(pickModel(140)).toBe('lite');
  });

  it('decides nothing when it could not be measured', () => {
    // 量不出来（标签页在后台、摄像头迟迟不出画面……）不等于电脑慢：不能就此认定要用轻量模型
    expect(pickModel(null)).toBeNull();
  });

  it('does not depend on how fast the camera delivers frames', () => {
    // 光线暗时摄像头可能只有每秒 15 帧。每帧识别只花 25 毫秒的电脑并不慢
    expect(pickModel(typicalDetectMs(steady(25)))).toBe('full');
  });
});

describe('remembering the choice', () => {
  const NOW = Date.UTC(2026, 10, 11);
  const DAY = 24 * 3600 * 1000;

  it('round-trips', () => {
    expect(decodeChoice(encodeChoice('lite', NOW), NOW + 1000)).toBe('lite');
    expect(decodeChoice(encodeChoice('full', NOW), NOW + 3 * DAY)).toBe('full');
  });

  it('expires, so one unlucky measurement is not forever', () => {
    expect(decodeChoice(encodeChoice('lite', NOW), NOW + (REMEMBER_DAYS + 1) * DAY)).toBeNull();
  });

  it('ignores anything it does not recognise, including the old plain format', () => {
    for (const raw of [null, '', 'lite', 'full', '{}', '{"model":"huge","at":1}', '{"model":"lite"}', '{"model":"lite","at":"yesterday"}', 'not json', '[1,2]']) {
      expect(decodeChoice(raw, NOW), String(raw)).toBeNull();
    }
  });

  it('does not trust a timestamp from the future', () => {
    expect(decodeChoice(encodeChoice('lite', NOW + 5 * DAY), NOW)).toBeNull();
  });
});
