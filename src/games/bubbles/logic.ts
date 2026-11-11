import { createRng, type Rng } from '../../engine/util/rng';

/**
 * 「戳泡泡」的规则。泡泡从画面底下冒出来往上飘，手碰到就破，45 秒里看能戳破多少。
 *
 * 这个文件不碰画面、不碰摄像头，只管"规则"：每一帧告诉它过了多久、手在哪，它更新泡泡和分数。
 * 所以它可以直接在测试里跑（见 logic.test.ts）。写新游戏时建议照这个分法：规则一个文件，画面一个文件。
 *
 * 坐标用"归一化画面坐标"：x、y 都在 0～1 之间，(0, 0) 是画面左上角，y 向下。
 * 半径和速度以画面高度为单位——画面是宽的，横向的 0.1 比纵向的 0.1 长，算距离时要乘上宽高比。
 */
export interface Bubble {
  id: number;
  x: number;
  y: number;
  r: number;
  /** 上浮速度：每秒飘过多少个画面高度 */
  vy: number;
  /** 颜色（色相，0～360） */
  hue: number;
}

export interface Hand {
  x: number;
  y: number;
  r: number;
}

export interface BubbleState {
  bubbles: Bubble[];
  score: number;
  timeLeft: number;
  over: boolean;
}

/** 每隔多少秒冒一个泡泡 */
const SPAWN_EVERY = 0.6;
/** 一帧最多按这么久算：标签页切到后台再回来时，两帧之间可能隔了很久，不能让游戏一下子快进过去 */
const MAX_DT = 0.1;

export class BubbleGame {
  readonly state: BubbleState;
  private readonly rng: Rng;
  private readonly aspect: number;
  private sinceSpawn = 0;
  private nextId = 1;

  /** seed：同一个种子，泡泡出现的位置和大小完全一样。aspect：画面的宽高比。 */
  constructor(seed: number, durationSec = 45, aspect = 16 / 9) {
    this.rng = createRng(seed);
    this.aspect = aspect;
    this.state = { bubbles: [], score: 0, timeLeft: durationSec, over: false };
  }

  /** 每帧调用一次。返回这一帧被戳破的泡泡（画面可以拿去放个小特效）。 */
  update(dtSec: number, hands: Hand[]): { popped: Bubble[] } {
    const s = this.state;
    if (s.over || !(dtSec > 0)) return { popped: [] };
    const dt = Math.min(dtSec, MAX_DT);
    s.timeLeft = Math.max(0, s.timeLeft - dt);

    this.sinceSpawn += dt;
    while (this.sinceSpawn >= SPAWN_EVERY) {
      this.sinceSpawn -= SPAWN_EVERY;
      s.bubbles.push(this.spawn());
    }

    const popped: Bubble[] = [];
    const kept: Bubble[] = [];
    for (const b of s.bubbles) {
      b.y -= b.vy * dt;
      const touched = hands.some((h) => Math.hypot((h.x - b.x) * this.aspect, h.y - b.y) < h.r + b.r);
      if (touched) popped.push(b);
      else if (b.y + b.r >= 0) kept.push(b); // 整个飘出顶边的就不要了
    }
    s.bubbles = kept;
    s.score += popped.length;
    if (s.timeLeft === 0) s.over = true;
    return { popped };
  }

  private spawn(): Bubble {
    const r = 0.05 + 0.04 * this.rng.next();
    return {
      id: this.nextId++,
      x: r + (1 - 2 * r) * this.rng.next(),
      y: 1 + r, // 刚好藏在底边下面
      r,
      vy: 0.16 + 0.1 * this.rng.next(),
      hue: Math.floor(this.rng.next() * 360),
    };
  }
}
