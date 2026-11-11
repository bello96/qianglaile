import { useEffect, useRef, useState } from 'react';
import { sfx } from '../../app/audio';
import { AirCursorLayer } from '../../app/components/AirCursorLayer';
import { Button } from '../../app/components/Button';
import { drawCamera } from '../../app/components/CameraPip';
import { ErrorCard, LoadingCard } from '../../app/components/StatusCards';
import { startFrameLoop, useCrash } from '../../app/frameLoop';
import { LM } from '../../engine/body/landmarks';
import { NEUTRAL, type Limb } from '../../engine/body/pose';
import { SimPoseSource } from '../../engine/input/simSource';
import { STALE_MS } from '../../engine/input/types';
import type { GameProps } from '../types';
import { BubbleGame, type Hand } from './logic';

const HAND_R = 0.05;
const FONT = '"ZCOOL QingKe HuangYou", "Microsoft YaHei", sans-serif';

/**
 * 「戳泡泡」——最小的示例游戏，也是照着写新游戏的模板。一个游戏要做的事只有四件：
 *   1. 每一帧从 engine.tracker.state 读玩家。这里只用两只手腕在画面里的位置；
 *      要用"米"为单位的身体就读 body.skeleton，要现成的动作信号就读 state.motion / state.events
 *   2. 把它喂给自己的规则（logic.ts：不碰画面，所以能直接测）
 *   3. 把规则算出来的状态画出来
 *   4. 结束时给"再来一次 / 回首页"
 * 写完在 src/games/index.ts 里登记一行，首页就会多出一个按钮。摄像头、识别、选人、滤波都不用管。
 */
export default function BubblesPlay({ engine, flags, onExit }: GameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [round, setRound] = useState(0);
  const [final, setFinal] = useState<number | null>(null);
  /** 每帧循环里出的错从这里报给页面的出错兜底 */
  const crash = useCrash();

  // engine 每次渲染都是新对象，循环里要读最新的那个
  const live = useRef(engine);
  live.current = engine;

  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    let game: BubbleGame | null = null;
    let last = performance.now();
    let lastWave = 0;
    setFinal(null);

    const frame = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      const eng = live.current;
      if (eng.status !== 'ready') return; // 摄像头还没好：不开始计时

      // 画布保持和摄像头一样的宽高比，在窗口里尽量放大
      const video = eng.video;
      const aspect = video && video.videoWidth > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
      const h = Math.round(Math.min(window.innerHeight, window.innerWidth / aspect));
      const w = Math.round(h * aspect);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      if (!game) {
        game = new BubbleGame(flags.seed ?? Math.floor(Math.random() * 1e6), 45, aspect);
        // 开发和自动化检查时，把游戏对象挂到 window.__mw 上，方便在控制台里看
        if (flags.e2e || import.meta.env.DEV) {
          const win = window as unknown as { __mw?: Record<string, unknown> };
          win.__mw = { ...win.__mw, bubbles: game };
        }
      }

      // 演示模式（没有摄像头）：让模拟玩家隔一会儿随便挥挥手，不然它只会站着
      if (eng.source instanceof SimPoseSource && flags.sim !== 'manual' && now - lastWave > 1100) {
        lastWave = now;
        const arm = (): [Limb, Limb] => {
          const a = 20 + Math.random() * 150;
          return [{ a }, { a: a + (Math.random() - 0.5) * 60 }];
        };
        eng.source.setPose({ ...NEUTRAL, armL: arm(), armR: arm() }, {}, 0.7);
      }

      // 1. 读玩家：看得清的手腕。body.image 是镜像后的画面坐标，和屏幕上看到的一致
      // sinceFrame：离上一次识别结果过了多久。太久说明摄像头卡住了，手上的是旧数据，当作没看到人
      const body = eng.sinceFrame(now) < STALE_MS ? eng.tracker.state.body : null;
      const hands: Hand[] = body ? [LM.leftWrist, LM.rightWrist].filter((i) => body.image[i].v > 0.5).map((i) => ({ x: body.image[i].x, y: body.image[i].y, r: HAND_R })) : [];

      // 2. 规则
      const { popped } = game.update(dt, hands);
      if (popped.length) sfx.play('pass');
      const s = game.state;
      if (s.over) setFinal(s.score);

      // 3. 画：摄像头画面（没有摄像头时是骨架）→ 泡泡 → 手 → 分数和时间
      drawCamera(g, w, h, eng, video === null);
      g.lineWidth = Math.max(3, h / 180);
      for (const b of s.bubbles) {
        g.beginPath();
        g.arc(b.x * w, b.y * h, b.r * h, 0, Math.PI * 2);
        g.fillStyle = `hsl(${b.hue} 90% 70% / 0.55)`;
        g.strokeStyle = '#14213d';
        g.fill();
        g.stroke();
        g.beginPath(); // 高光
        g.arc((b.x - b.r * 0.35 / aspect) * w, (b.y - b.r * 0.35) * h, b.r * h * 0.22, 0, Math.PI * 2);
        g.fillStyle = 'rgb(255 255 255 / 0.8)';
        g.fill();
      }
      g.strokeStyle = '#ffc531';
      for (const hand of hands) {
        g.beginPath();
        g.arc(hand.x * w, hand.y * h, hand.r * h, 0, Math.PI * 2);
        g.stroke();
      }
      g.font = `${Math.round(h / 11)}px ${FONT}`;
      g.textBaseline = 'top';
      g.lineJoin = 'round';
      g.lineWidth = h / 70;
      g.strokeStyle = '#14213d';
      g.fillStyle = '#fff';
      const label = (text: string, x: number, align: CanvasTextAlign): void => {
        g.textAlign = align;
        g.strokeText(text, x, h * 0.04);
        g.fillText(text, x, h * 0.04);
      };
      label(`${s.score} 个`, w * 0.5, 'center');
      label(`${Math.ceil(s.timeLeft)} 秒`, w * 0.96, 'right');
    };
    // 用 startFrameLoop 而不是自己排下一帧：循环里抛了错就停下、报给页面，不会每秒抛六十次
    return startFrameLoop(frame, crash);
  }, [round, flags.seed, flags.sim, flags.e2e, crash]);

  return (
    <div className="screen" style={{ display: 'grid', placeItems: 'center', background: '#14213d' }}>
      <canvas ref={canvasRef} aria-label="戳泡泡的画面" style={{ display: 'block', maxWidth: '100%', maxHeight: '100%' }} />
      <div className="ui-layer">
        {engine.status === 'loading' && <LoadingCard engine={engine} />}
        {engine.status === 'error' && <ErrorCard engine={engine} />}
        {final === null && (
          <div style={{ position: 'absolute', left: 20, top: 16 }}>
            <Button icon onClick={onExit}>
              回首页
            </Button>
          </div>
        )}
        {final !== null && (
          <div className="plate center-card" role="status">
            <h2>时间到！戳破了 {final} 个</h2>
            {engine.kind === 'camera' && <p>举起手，把光标停在按钮上，就能点它。</p>}
            <div className="center-card__actions">
              <Button go xl air="again" onClick={() => setRound((n) => n + 1)}>
                再来一次
              </Button>
              <Button xl air="home" onClick={onExit}>
                回首页
              </Button>
            </div>
          </div>
        )}
      </div>
      <AirCursorLayer engine={engine} />
    </div>
  );
}
