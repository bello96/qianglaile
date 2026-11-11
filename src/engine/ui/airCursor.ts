import type { Body } from '../body/bodyModel';
import type { BodyProfile } from '../body/profile';
import { clamp, clamp01, damp } from '../util/math';

/**
 * 举手悬停：人站在两三米外，够不着鼠标。举起一只手，屏幕上就出现一个跟着手走的光标；
 * 光标在按钮上停一会儿，就算点了（"悬停点击"，dwell click）。
 *
 * 这里是两块纯逻辑：AirCursor 把手的位置换算成光标位置，DwellClicker 负责"停够了就点"。
 * 画光标、找光标底下是哪个按钮，在界面层（AirCursorLayer）做。
 */
export interface CursorState {
  active: boolean;
  /** 光标在屏幕上的位置，0～1（左上角是 0,0） */
  x: number;
  y: number;
  hand: 'L' | 'R' | null;
}

/** 手腕高出同侧肩膀这么多米，才算"举手" */
const RAISE = 0.05;
/**
 * 手的活动范围映射到整个屏幕。范围按这个人自己的臂长（肩到手心）来定，大人小孩都够得着：
 *   竖直：手心从"肩上 5 厘米"到"肩上 0.9 个臂长"（差不多举过头顶）→ 屏幕底边到顶边；
 *   水平：以举起那只手的肩膀为中心，左右各 0.8 个臂长 → 屏幕左边到右边。
 * 两头都留了一点余量，不用把胳膊伸到最直就能碰到屏幕的每条边。
 */
const REACH_UP = 0.9;
const REACH_SIDE = 0.8;
/** 手放下后光标再留这么久（毫秒）：手抖一下不至于让光标消失 */
const RELEASE_MS = 300;
/** 光标追手的速度（1/秒）：越大越跟手，也越抖 */
const FOLLOW = 14;

export class AirCursor {
  private hand: 'L' | 'R' | null = null;
  private x = 0.5;
  private y = 0.5;
  private lastT: number | null = null;
  private downSince: number | null = null;

  update(body: Body | null, profile: BodyProfile): CursorState {
    if (!body) {
      this.reset();
      return this.state();
    }
    const sk = body.skeleton;
    const raised = (side: 'L' | 'R'): boolean => {
      const wrist = side === 'L' ? 'wristL' : 'wristR';
      const shoulder = side === 'L' ? 'shoulderL' : 'shoulderR';
      return body.ok[wrist] && body.ok[shoulder] && sk[wrist].y > sk[shoulder].y + RAISE;
    };

    const wasActive = this.hand !== null;
    if (this.hand && raised(this.hand)) {
      this.downSince = null; // 当前这只手还举着：不换手
    } else {
      const candidates = (['L', 'R'] as const).filter(raised);
      if (candidates.length) {
        // 两只手都举着就用举得高的那只
        this.hand = candidates.sort((a, b) => sk[b === 'L' ? 'wristL' : 'wristR'].y - sk[a === 'L' ? 'wristL' : 'wristR'].y)[0];
        this.downSince = null;
      } else if (this.hand) {
        this.downSince ??= body.t;
        if (body.t - this.downSince >= RELEASE_MS) this.hand = null;
      }
    }

    if (this.hand && this.downSince === null) {
      const palm = sk[this.hand === 'L' ? 'handL' : 'handR'];
      const shoulder = sk[this.hand === 'L' ? 'shoulderL' : 'shoulderR'];
      const arm = profile.upperArm + profile.forearm + profile.hand;
      const tx = clamp01(0.5 + (palm.x - shoulder.x) / (2 * REACH_SIDE * arm));
      const ty = clamp01(1 - (palm.y - shoulder.y - RAISE) / (REACH_UP * arm - RAISE));
      if (!wasActive || this.lastT === null) {
        // 刚举起来：直接出现在手的位置，而不是从屏幕中间滑过去
        this.x = tx;
        this.y = ty;
      } else {
        const dt = clamp((body.t - this.lastT) / 1000, 0, 0.1);
        this.x = damp(this.x, tx, FOLLOW, dt);
        this.y = damp(this.y, ty, FOLLOW, dt);
      }
    }
    this.lastT = body.t;
    return this.state();
  }

  reset(): void {
    this.hand = null;
    this.lastT = this.downSince = null;
  }

  private state(): CursorState {
    return { active: this.hand !== null, x: this.x, y: this.y, hand: this.hand };
  }
}

/**
 * 悬停点击：光标在同一个目标上连续停够 dwellMs 就触发一次。
 * 触发之后要先离开、再回来，才能触发下一次——否则手停在"再来一次"上会一直重开。
 */
export class DwellClicker {
  private target: string | null = null;
  private since = 0;
  private fired = false;

  constructor(private readonly dwellMs = 1100) {}

  /** targetId：光标现在停在哪个目标上（没有就是 null）。 */
  update(targetId: string | null, nowMs: number): { progress: number; fire: string | null } {
    if (targetId !== this.target) {
      this.target = targetId;
      this.since = nowMs;
      this.fired = false;
      return { progress: 0, fire: null };
    }
    if (targetId === null) return { progress: 0, fire: null };
    if (this.fired) return { progress: 1, fire: null };
    const progress = clamp01((nowMs - this.since) / this.dwellMs);
    if (progress >= 1) {
      this.fired = true;
      return { progress: 1, fire: targetId };
    }
    return { progress, fire: null };
  }
}

/**
 * 现在该不该让"举手悬停"的光标出来。
 *
 * 只有真的摄像头才算数。模拟玩家和录制回放里"举着的手"不是谁想点按钮——
 * 让它们也能点的话，演示或者回放到某个举着手的姿势，暂停面板上的"回首页"就自己被点下去了。
 *
 * modalOpen：有对话框（比如设置面板）开着。它底下还压着能悬停点击的按钮，不能隔着面板把它们点了。
 * hasTargets：页面上有可以悬停点击的按钮。没有的时候（比如正在闯关）不显示光标，免得举手摆姿势时冒出来。
 */
export function airCursorWanted(o: { ready: boolean; kind: 'camera' | 'sim' | 'replay'; modalOpen: boolean; hasTargets: boolean }): boolean {
  return o.ready && o.kind === 'camera' && !o.modalOpen && o.hasTargets;
}
