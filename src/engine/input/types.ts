/** 一个关键点。v 是可见度（0～1）。 */
export interface Lm {
  x: number;
  y: number;
  z: number;
  v: number;
}

/**
 * 识别模型对一个人的原始输出，两套坐标：
 * - image：归一化图像坐标（x、y ∈ 0～1，原点在画面左上，**未镜像**）。位置准，但人离镜头远近会缩放。
 * - world：以两髋中点为原点的"世界坐标"，单位约为米。x 与图像同向、y 向下为正、z 朝镜头为负。与远近无关。
 */
export interface RawPose {
  image: Lm[];
  world: Lm[];
}

/** 一帧识别结果。t 是单调递增的毫秒时间戳；aspect = 视频宽 / 高。 */
export interface RawFrame {
  t: number;
  aspect: number;
  poses: RawPose[];
}

/**
 * 超过这么久（毫秒）没有新的识别结果，手上的"玩家状态"就是旧的了——摄像头卡住时不能拿它当真，
 * 应当当作"没看到人"。用玩家状态的地方（游戏、光标、实验室）都拿这同一个数来比。
 */
export const STALE_MS = 600;

export interface SourceStats {
  /** 每秒识别多少帧 */
  fps: number;
  /** 单次识别耗时（毫秒），平滑过的，给人看 */
  detectMs: number;
  /** 最近这一次识别的耗时（毫秒），没平滑过，给测速用 */
  lastMs?: number;
  delegate: string;
  model: string;
  /** 识别跑在哪个线程（只有摄像头来源有） */
  thread?: 'worker' | 'main';
  /** 模型最多同时找几个人（只有摄像头来源有） */
  people?: number;
}

/**
 * 姿态来源。摄像头、模拟玩家、录制回放都实现这个接口，
 * 所以后面的整条流水线（以及游戏）不关心数据是真人还是假人。
 */
export interface PoseSource {
  readonly kind: 'camera' | 'sim' | 'replay';
  /** 摄像头来源才有画面 */
  readonly video: HTMLVideoElement | null;
  start(): Promise<void>;
  stop(): void;
  /** 订阅识别帧；返回取消订阅的函数 */
  onFrame(cb: (f: RawFrame) => void): () => void;
  stats(): SourceStats;
}
