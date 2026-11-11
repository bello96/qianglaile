import { useEffect, useRef, useState } from 'react';
import type { JointName, PoseSpec } from '../../engine/body/pose';
import { SimPoseSource } from '../../engine/input/simSource';
import { capturePose, isPoseNameOk, saveCustomPose } from '../../games/wall/customPoses';
import { POSES, STAND } from '../../games/wall/poses';
import { sfx } from '../audio';
import { navigate } from '../router';
import { STALE_MS, type Engine } from '../useEngine';
import { Button } from './Button';
import { drawCamera } from './CameraPip';
import { DebugOverlay } from './DebugOverlay';
import { FeatureMeters } from './FeatureMeters';

/** 按下"存"之后留几秒：你得从电脑前走回去、把姿势摆好 */
const SAVE_DELAY_SEC = 5;

/** 存墙时这些关节必须看得清——看不清的关节，量出来的角度是猜的 */
const UPPER_NEEDED: JointName[] = ['shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'hipL', 'hipR'];
const LEGS_NEEDED: JointName[] = ['kneeL', 'kneeR', 'ankleL', 'ankleR'];

interface Note {
  ok: boolean;
  text: string;
  /** 刚存好的那面墙（可以马上去试） */
  saved?: PoseSpec;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 实验室的"实时"页：左边是摄像头画面和识别出来的骨架，右边是从骨架里算出来的数字，
 * 以及"把我现在的姿势存成一面新墙"。
 */
export function LivePanel({ engine, onSaved, onGallery }: { engine: Engine; onSaved: (pose: PoseSpec) => void; onGallery: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [name, setName] = useState('');
  const [left, setLeft] = useState<number | null>(null);
  const [note, setNote] = useState<Note | null>(null);

  // engine 每次渲染都是新对象；循环和倒计时里要读"最新的那个"
  const live = useRef(engine);
  live.current = engine;
  /** 倒计时的"班次"：取消或离开页面时加一，正在数的那一轮发现班次变了就停 */
  const run = useRef(0);
  useEffect(() => () => void run.current++, []);

  // ---- 画面：摄像头（镜像）+ 骨架 ----
  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    let raf = 0;
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      // 画布的宽高比跟着摄像头走（有的摄像头是 4:3）
      const video = live.current.video;
      if (video && video.videoWidth > 0) {
        const h = Math.round((canvas.width * video.videoHeight) / video.videoWidth);
        if (Math.abs(canvas.height - h) > 1) canvas.height = h;
      }
      drawCamera(g, canvas.width, canvas.height, live.current, true);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, []);

  /** 把此刻的姿势存下来。 */
  const capture = async (wallName: string): Promise<void> => {
    const player = live.current.tracker.state;
    const body = player.present && live.current.sinceFrame() < STALE_MS ? player.body : null;
    if (!body) {
      setNote({ ok: false, text: '这一下没看到人，没存。站到摄像头前面再试一次。' });
      return;
    }
    const needed = body.mode === 'full' ? [...UPPER_NEEDED, ...LEGS_NEEDED] : UPPER_NEEDED;
    if (needed.some((j) => !body.ok[j])) {
      setNote({ ok: false, text: '有的关节摄像头没看清（手或脚可能伸到画面外了），没存。站远一点再试。' });
      return;
    }

    const pose = capturePose(body.skeleton, player.profile, wallName);
    const { where, refused } = await saveCustomPose(pose);
    sfx.play('pass');
    onSaved(pose);
    setName('');
    const legs = body.mode === 'upper' ? '只看到了上半身，所以这面墙的腿是站直的。' : '';
    if (where === 'file') setNote({ ok: true, saved: pose, text: `「${wallName}」存好了，写进了项目文件 public/custom-poses.json。${legs}` });
    // 存墙接口明说了不行（比如项目文件被改坏了）：墙没丢，但人得知道它没进文件、为什么
    else if (where === 'local' && refused) setNote({ ok: false, saved: pose, text: `「${wallName}」没能写进项目文件：${refused} 它先存在这个浏览器里了。${legs}` });
    else if (where === 'local') setNote({ ok: true, saved: pose, text: `「${wallName}」存好了，存在这个浏览器里。${legs}` });
    else setNote({ ok: false, text: `这个浏览器不让存东西（可能开着无痕模式），「${wallName}」只能留到你关掉这个页面。想留住它，到图鉴里点"复制成代码"。` });
  };

  const start = async (): Promise<void> => {
    const wallName = name.trim();
    if (!isPoseNameOk(wallName)) {
      setNote({ ok: false, text: '先给这面墙起个名字（最多 20 个字）。' });
      return;
    }
    const mine = ++run.current;
    setNote(null);
    for (let n = SAVE_DELAY_SEC; n > 0; n--) {
      setLeft(n);
      sfx.play('tick', { pitch: n === 1 ? 1.3 : 1 });
      await sleep(1000);
      if (run.current !== mine) return;
    }
    setLeft(null);
    await capture(wallName);
  };

  const cancel = (): void => {
    run.current++;
    setLeft(null);
  };

  const sim = engine.source instanceof SimPoseSource ? engine.source : null;

  return (
    <div className="lab__grid">
      <div className="lab__main">
        <div className="plate lab__view">
          <canvas ref={canvasRef} width={960} height={540} aria-label="摄像头画面和识别出来的骨架" />
          {left !== null && (
            <div className="lab__count" aria-live="assertive">
              {left}
            </div>
          )}
        </div>
        <DebugOverlay engine={engine} />
      </div>

      <div className="lab__side">
        <div className="plate box">
          <h3>存成新墙</h3>
          <p>起个名字，点按钮，然后有 {SAVE_DELAY_SEC} 秒走回去摆好姿势。数到 0 的那一下，你的姿势就是一面新墙。</p>
          <form
            className="save-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (left === null) void start();
            }}
          >
            <input value={name} maxLength={20} placeholder="给墙起个名字" aria-label="新墙的名字" disabled={left !== null} onChange={(e) => setName(e.target.value)} />
            {left === null ? (
              <Button go icon type="submit">
                {SAVE_DELAY_SEC} 秒后存
              </Button>
            ) : (
              <Button icon onClick={cancel}>
                取消
              </Button>
            )}
          </form>
          {note && (
            <p className="note" data-bad={note.ok ? undefined : ''} role="status">
              {note.text}
            </p>
          )}
          {note?.saved && (
            <div className="rec-row">
              <Button icon onClick={() => navigate({ page: 'play', game: 'wall' }, { only: note.saved!.id })}>
                试试这面墙
              </Button>
              <Button icon onClick={onGallery}>
                去图鉴看看
              </Button>
            </div>
          )}
        </div>

        {sim && (
          <div className="plate box">
            <h3>模拟玩家</h3>
            <p>现在没有用摄像头，画面里是一个模拟出来的人。让它摆：</p>
            <select aria-label="模拟玩家摆的姿势" defaultValue={STAND.id} onChange={(e) => sim.setPose(POSES.find((p) => p.id === e.target.value) ?? STAND, {}, 0.4)}>
              <option value={STAND.id}>{STAND.name}</option>
              {POSES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <FeatureMeters engine={engine} />
      </div>
    </div>
  );
}
