/**
 * 「别撞墙！」所有可调的数值都在这个文件里。想让游戏更松 / 更紧 / 更快，只改这里。
 *
 * 有两样东西不在这里，因为它们是"内容"而不是"手感"：
 *   - 姿势库（poses.ts）和几何洞的形状尺寸（shapes.ts）；
 *   - 每一关出哪几层的造型、从第几关开始出几何洞和偏置洞——那张表在 levels.ts 的 levelPlan 里。
 *
 * 角度容差 40° / 32° / 25° 不是拍脑袋定的：这是同类游戏按真实孩子的成绩调出来的数。
 * 摄像头识别的抖动、延迟，加上人对自己姿势的控制精度，合起来确实需要这么大的余量。
 */
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface Tuning {
  /** 第 1 关的角度容差（度）。目标姿势用到的腿和脊柱再乘 COMMON.legSpineTol */
  angleTol: number;
  /** 随关卡收紧，但不低于这个值 */
  angleTolFloor: number;
  /** 站位容差：人要站在洞的左右多少米以内 */
  posTol: number;
  /** 人形洞比身体轮廓大出的一圈（米）。只影响洞看起来多"合身"，不参与判定 */
  holeMargin: number;
  /** 几何洞的"泡沫弹性"：陷进墙体不超过这么深不算撞（米） */
  shapeSlack: number;
  /** 第 1 关一面墙驶来要多少秒 */
  approach: number;
  /** 随关卡加快，但不短于这个值 */
  approachFloor: number;
  /** 是否显示落位轮廓 */
  ghost: boolean;
}

export const TUNING: Record<Difficulty, Tuning> = {
  easy: { angleTol: 40, angleTolFloor: 32, posTol: 0.3, holeMargin: 0.12, shapeSlack: 0.06, approach: 7.5, approachFloor: 4.5, ghost: true },
  normal: { angleTol: 32, angleTolFloor: 25, posTol: 0.26, holeMargin: 0.1, shapeSlack: 0.05, approach: 6.5, approachFloor: 3.6, ghost: true },
  hard: { angleTol: 25, angleTolFloor: 20, posTol: 0.22, holeMargin: 0.08, shapeSlack: 0.04, approach: 5.5, approachFloor: 3.0, ghost: false },
};

/** 与难度档位无关的数值。 */
export const COMMON = {
  lives: 3,
  /** 墙到达时，取最近这么久的判定结果投票（毫秒） */
  judgeWindowMs: 250,
  /** 几何洞：一个部位有这么大比例陷进墙体才算撞 */
  hitFrac: 0.2,
  /** 过关吸附：最后这么多秒内，姿势正确的话小人会被吸向洞的正中姿势 */
  assistSec: 0.35,
  /** 过关之后，小人保持在正中姿势多久，再用多久放回真实动作（秒） */
  assistHoldSec: 0.35,
  assistFadeSec: 0.3,

  // ---- 人形洞判定的细节 ----
  /**
   * 目标姿势**用到了**腿或脊柱时（双脚分开、侧弯、下蹲……），这些部位的容差是手臂的几倍。
   * 腿和脊柱的活动范围小："双脚分开 22°"和"站直"只差十几度，要是也给足 32°，腿怎么放都算对。
   * 只动手的墙不受影响：那时腿和脊柱只要大致站着就行，用完整的容差。
   */
  legSpineTol: 0.5,
  /** 目标角度离"自然站立"不到这么多度（而且没有缩短）的腿 / 脊柱，算作这面墙"没用到"它 */
  neutralBandDeg: 8,
  /** 目标比例低于它的肢体是朝向镜头的（深蹲的大腿、抬起的膝盖）：正面角度不稳定，改比缩短比例 */
  shortTarget: 0.6,
  /** 目标是伸直的，玩家这段却短成这样：说明他把手脚伸向镜头了，不算摆对 */
  shortActual: 0.45,
  /** 缩短比例差 1，相当于多少度的角度误差 */
  scaleAsDeg: 80,
  /** 人形洞至少要有这么多段肢体看得清才判；不够就当作"看不清人"，不判撞 */
  minJudgedLimbs: 2,
  /** 契合度到多少给三星、两星（不到两星线的过关是一星） */
  threeStars: 0.8,
  twoStars: 0.6,

  // ---- 计分 ----
  /** 每颗星多少分 */
  starScore: 100,
  /** 每连过一面，得分多这么多（比例），最多算到连过 comboCap 面 */
  comboBonus: 0.1,
  comboCap: 10,
  /** 升关奖励 = 这个数 × 新的关数 */
  levelBonus: 500,

  // ---- 关卡节奏（哪一关出哪些造型见 levels.ts） ----
  /** 每关的墙数 = wallsBase + 关数，最多 wallsMax */
  wallsBase: 4,
  wallsMax: 8,
  /** 每升一关，角度容差收紧多少度、墙少用多少秒（各自有难度档的下限） */
  tolStepPerLevel: 1.5,
  approachStepPerLevel: 0.4,
  /** 出墙时，目标姿势的关节要离可见范围的边缘至少这么远（米） */
  viewMargin: 0.05,

  // ---- 开局前的站位引导 ----
  framing: {
    /** 摄像头在玩家所在的平面能看到的高度（米）：低于下限说明离得太近，高于上限说明太远、人在画面里太小 */
    minViewHeight: 1.1,
    maxViewHeight: 5,
    /** 偏离画面中心超过这么多米，就请他往回挪 */
    maxOffCentre: 0.6,
    /** 活动量低于它才算"站着没动" */
    stillEnergy: 0.12,
    /** 站位合适时，站着不动这么久就开局（毫秒） */
    holdMs: 1200,
    /** 站位不理想（太近、太远、偏了）时只是提醒；提醒过了人还是站着不动，等这么久也开局 */
    adviseHoldMs: 3500,
  },

  /** 连续这么久看不到人就自动暂停（毫秒） */
  lostPauseMs: 1000,
  /** 人回来后连续这么久才恢复（毫秒） */
  resumeMs: 500,
  /** 暂停之后恢复时，墙至少还要这么多秒才到：离得太近就退回去一段，给人重新摆好的时间 */
  resumeLeadSec: 1.5,
  /** 同一面墙最多因为"看不到人"暂停这么多次；再有一次就换一面墙（不扣命）。免得某个姿势恰好让识别跟丢时卡死在这面墙上 */
  maxPausesPerWall: 1,
  /** 墙到达时，判定依据至少要覆盖这么长的时间（毫秒）才下结论；不够就让墙在面前等一等 */
  judgeMinSpanMs: 150,
  countdownSec: 3,
  /** 判定之后的演出时间：过关 / 撞墙落水 / 升关 */
  resolvePassSec: 1.1,
  resolveHitSec: 2.6,
  levelUpSec: 1.8,
  /** 单帧最多推进这么多秒：标签页切到后台再回来时，不让墙"瞬移"到面前 */
  maxDtSec: 0.1,
  /** 墙出现的位置（米，舞台 z） */
  spawnZ: -26,
  /** 从第 4 关起，洞可能开在玩家旁边这么远 */
  offsetX: 0.45,
  /** 洞最远离舞台中心多少米 */
  maxHoleX: 0.9,
  /** 出几何洞的概率（开放几何洞的关卡） */
  shapeChance: 0.3,
  /** 人形洞偏到旁边的概率（开放偏置的关卡） */
  offsetChance: 0.35,
} as const;
