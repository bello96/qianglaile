/** 3D 场景的画质：高（阴影、抗锯齿、满分辨率）或低 */
export type Quality = 'low' | 'high';

/** 识别端现在的状态里，和"这台电脑强不强"有关的两项（见 SourceStats） */
export interface RecognitionStats {
  /** 用的哪个识别模型：'full' 标准，'lite' 轻量 */
  model: string;
  /** 识别跑在显卡（'GPU'）还是处理器（'CPU'）上；识别器还没建好时是别的字样 */
  delegate: string;
}

type Store = { getItem(key: string): string | null; setItem(key: string, value: string): void };

const KEY = 'mw.autoQuality';

function browserStorage(): Store | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // 隐私模式下连访问都可能抛错
  }
}

/**
 * 画质设成"自动"时，到底用高还是低。
 *
 * 依据是识别端的情况：识别只能用轻量模型、或者只能靠 CPU 的电脑，显卡多半也吃紧，那就用低画质。
 * 难处在于这个情况**不是随时都看得到**——引擎还在加载、正在重启、或者这一页根本没开摄像头（首页的演示）
 * 时都没有。那时候要是退回"高"，引擎每重启一次，3D 场景就白白重建两回（高 → 低）。
 * 所以这里把上一次的结论记住（也记进浏览器）：看不到的时候沿用它，看得到了再更新。
 */
export class AutoQuality {
  private last: Quality | null = null;

  constructor(private readonly storage: Store | null = browserStorage()) {
    try {
      const saved = storage?.getItem(KEY);
      if (saved === 'low' || saved === 'high') this.last = saved;
    } catch {
      /* 读不了就当没记过 */
    }
  }

  /**
   * setting：设置里选的画质。stats：摄像头识别正在跑时它的状态；拿不到就传 null。
   * 每次渲染都可以调：结论没变就什么也不写。
   */
  pick(setting: 'auto' | Quality, stats: RecognitionStats | null | undefined): Quality {
    const known = stats && (stats.delegate === 'GPU' || stats.delegate === 'CPU');
    if (known) {
      const now: Quality = stats.model === 'lite' || stats.delegate === 'CPU' ? 'low' : 'high';
      if (now !== this.last) {
        this.last = now;
        try {
          this.storage?.setItem(KEY, now);
        } catch {
          /* 存不上：这次打开页面期间照样记得 */
        }
      }
    }
    return setting === 'auto' ? (this.last ?? 'high') : setting;
  }
}
