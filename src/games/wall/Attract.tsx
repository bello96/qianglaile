import { useEffect, useRef } from 'react';
import { startFrameLoop } from '../../app/frameLoop';
import { defaultProfile } from '../../engine/body/profile';
import { SimPoseSource } from '../../engine/input/simSource';
import { PlayerTracker } from '../../engine/player/playerTracker';
import { IDLE_STATE } from './game';
import { POSES } from './poses';
import { WallSceneView } from './scene/view';
import { WallSession, type SessionEngine } from './session';
import { SHAPES } from './shapes';

/** 演示打到第几关就从头再来：越往后墙越快，当背景不需要那么紧张 */
const RESTART_AT_LEVEL = 4;
/** 模拟玩家每秒出多少帧"识别结果" */
const SIM_STEP_MS = 1000 / 30;

/**
 * 首页的自动演示：一个模拟出来的玩家在背景里自己闯关。不开摄像头，不出声。
 *
 * 它用的就是游戏本身的那几样东西——模拟玩家（SimPoseSource）→ 玩家追踪器 → 一局游戏（WallSession）→ 3D 场景，
 * 只是没有界面。所以它也是一个"最小接法"的例子：想知道这几块怎么拼起来，看这个文件比看游戏页清楚。
 *
 * quality：画质。expose：把场景挂到 window.__mw.attract 上（自动化检查用）。
 */
export default function Attract({ quality, expose = false }: { quality: 'low' | 'high'; expose?: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // 模拟玩家产出的每一帧都交给追踪器；会话通过下面这个"引擎"读它
    const sim = new SimPoseSource({ noise: 0.006, seed: 11 });
    const tracker = new PlayerTracker();
    sim.onFrame((f) => tracker.ingest(f));
    const engine: SessionEngine = { status: 'ready', source: sim, kind: 'sim', tracker, sinceFrame: () => 0 };

    const session = new WallSession({ seed: null, sim: 'auto', difficulty: () => 'easy' });
    session.setPool({ poses: POSES, shapes: SHAPES });

    const scene = new WallSceneView(host, { quality, profile: defaultProfile(), ghost: true });
    const fit = (): void => scene.resize(host.clientWidth, host.clientHeight);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    if (expose) {
      const w = window as unknown as { __mw?: Record<string, unknown> };
      w.__mw = { ...w.__mw, attract: scene, attractSession: session };
    }

    let last = performance.now();
    let owed = 0;
    const frame = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;

      owed += dt * 1000;
      while (owed >= SIM_STEP_MS) {
        sim.step(SIM_STEP_MS);
        owed -= SIM_STEP_MS;
      }

      for (const e of session.update(now, dt, engine)) {
        if (e.type === 'begin') scene.setProfile(e.ctx.profile);
        else scene.handle(e);
        // 没命了，或者打到后面太快了：从头再来
        if (e.type === 'over' || (e.type === 'levelup' && e.level >= RESTART_AT_LEVEL)) session.again();
      }
      const game = session.game;
      scene.frame(dt, game?.state ?? IDLE_STATE, tracker.sample(now), game?.assist() ?? null);
    };
    // 这只是首页的背景：万一出了错，停在那一帧就行，不值得把整个首页换成出错卡片
    const stop = startFrameLoop(frame, (err) => console.error('[attract] 首页的演示停了：', err));

    return () => {
      stop();
      observer.disconnect();
      scene.dispose();
    };
  }, [quality, expose]);

  return <div ref={hostRef} className="stage-layer" aria-hidden="true" />;
}
