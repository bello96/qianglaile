import { useEffect, useRef, useState } from 'react';
import { LM } from '../../engine/body/landmarks';
import { FrameRecorder, parseRecording, type Recording } from '../../engine/input/recorder';
import { ReplayPoseSource } from '../../engine/input/replaySource';
import { setReplayOverride, useReplayOverride } from '../replayOverride';
import type { Engine } from '../useEngine';
import { Button } from './Button';
import { drawCamera } from './CameraPip';
import { DebugOverlay } from './DebugOverlay';

const BONES: [number, number][] = [
  [LM.leftShoulder, LM.rightShoulder], [LM.leftHip, LM.rightHip], [LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip],
  [LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist], [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist],
  [LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle], [LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle],
];

/** 录制文件最大读多大。一分钟的录制大约 1.5 MB，再大多半是选错了文件 */
const MAX_FILE_BYTES = 40 * 1024 * 1024;

/**
 * 录制与回放。录下来的只有关键点的数字，没有任何画面。
 * 用途：把一段真实的动作存成文件，以后调判定、调滤波时反复回放同一段数据；也可以放进 tests/fixtures/recordings/ 当测试夹具。
 * "用这段代替摄像头"会让整个应用（实验室、游戏）改吃这段录制，直到换回来。
 *
 * take / onTake：刚录好的那一段由实验室页保管（见 Lab.tsx）。这个面板在引擎重启时会被卸掉再装上，
 * 自己记着的话，一点"用这段代替摄像头"，还没下载的录制就没了。
 */
export function RecorderPanel({ engine, take, onTake }: { engine: Engine; take: Recording | null; onTake: (rec: Recording | null) => void }) {
  const recorder = useRef(new FrameRecorder());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [recording, setRecording] = useState(false);
  const [frames, setFrames] = useState(take?.frames.length ?? 0);
  const [replay, setReplay] = useState<{ rec: Recording; label: string } | null>(null);
  const [message, setMessage] = useState('');
  /** 现在是不是正拿一段录制顶替摄像头 */
  const standIn = useReplayOverride();
  /** 用这段录制顶替摄像头：之后实验室和游戏里的引擎吃的都是它 */
  const standInWith = (rec: Recording): void => {
    setReplay(null); // 左边的画面让给引擎（它现在放的就是这段录制）
    setReplayOverride(rec);
  };

  const live = useRef(engine);
  live.current = engine;
  const keep = useRef(onTake);
  keep.current = onTake;

  // 离开这一页（或者引擎重启、这个面板被卸掉）时还在录：停掉，免得录制器一直挂在姿态来源上。
  // 已经录到的那些交出去保管，不白录
  useEffect(() => {
    const rec = recorder.current;
    return () => {
      if (rec.recording) keep.current(rec.stop());
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => {
      setFrames(recorder.current.frameCount);
      // 录满了（默认五分钟）：自动停下
      if (recorder.current.full) {
        stopRef.current();
        setMessage('录满了（最长五分钟），已经自动停下。');
      }
    }, 200);
    return () => clearInterval(timer);
  }, [recording]);

  // 左边的画面：平时是摄像头和实时骨架；回放时换成录下来的骨架
  useEffect(() => {
    const canvas = canvasRef.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;

    if (!replay) {
      let raf = 0;
      const draw = (): void => {
        raf = requestAnimationFrame(draw);
        drawCamera(g, canvas.width, canvas.height, live.current, true);
      };
      draw();
      return () => cancelAnimationFrame(raf);
    }

    // 把录制当作一个姿态来源，按原来的节奏循环播放
    const source = new ReplayPoseSource(replay.rec, { loop: true });
    const off = source.onFrame((f) => {
      const { width: w, height: h } = canvas;
      g.fillStyle = '#14213d';
      g.fillRect(0, 0, w, h);
      g.strokeStyle = '#ffc531';
      g.lineWidth = 4;
      g.lineCap = 'round';
      for (const pose of f.poses) {
        // 镜像显示，和别处一致
        const at = (i: number): [number, number] => [(1 - pose.image[i].x) * w, pose.image[i].y * h];
        for (const [a, b] of BONES) {
          if (pose.image[a].v < 0.5 || pose.image[b].v < 0.5) continue;
          g.beginPath();
          g.moveTo(...at(a));
          g.lineTo(...at(b));
          g.stroke();
        }
        const [nx, ny] = at(LM.nose);
        g.beginPath();
        g.arc(nx, ny, w / 40, 0, Math.PI * 2);
        g.stroke();
      }
    });
    void source.start();
    return () => {
      off();
      source.stop();
    };
  }, [replay]);

  const start = (): void => {
    if (!engine.source) return;
    recorder.current.start(engine.source);
    setFrames(0);
    onTake(null);
    setReplay(null);
    setMessage('');
    setRecording(true);
  };
  const stop = (): void => {
    const rec = recorder.current.stop();
    setRecording(false);
    setFrames(rec.frames.length);
    onTake(rec);
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const download = (rec: Recording): void => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(rec)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const load = (file: File | undefined): void => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setMessage('这个文件太大了，不像是这里录出来的动作数据。');
      return;
    }
    void file.text().then((text) => {
      let rec: Recording | null = null;
      try {
        rec = parseRecording(JSON.parse(text));
      } catch {
        /* 不是 JSON */
      }
      if (!rec || rec.frames.length === 0) {
        setMessage('这个文件不是这里录出来的动作数据。');
        return;
      }
      setMessage('');
      setReplay({ rec, label: `${file.name}（${rec.frames.length} 帧）` });
    });
  };

  return (
    <div className="lab__grid">
      <div className="lab__main">
        <div className="plate lab__view">
          <canvas ref={canvasRef} width={960} height={540} aria-label={replay ? '回放的骨架' : '摄像头画面和识别出来的骨架'} />
          {replay && <div className="lab__tag">正在回放：{replay.label}</div>}
        </div>
        <DebugOverlay engine={engine} />
      </div>
      <div className="lab__side">
        {standIn && (
          <div className="plate box">
            <h3>现在用录制代替摄像头</h3>
            <p>
              "实时"页里的角度和特征、游戏里的判定，吃的都是这段录下来的动作（循环播放），不是摄像头。它只在内存里：刷新页面就换回摄像头，这段录制也就没了——
              还想再用的话先下载，以后在下面"回放"里选这个文件就能再用。
            </p>
            <div className="rec-row">
              <Button icon onClick={() => setReplayOverride(null)}>
                换回摄像头
              </Button>
              <Button icon onClick={() => download(standIn)}>
                下载这段录制
              </Button>
            </div>
          </div>
        )}
        <div className="plate box">
          <h3>录一段</h3>
          <p>只记录关键点的数字，不记录画面。</p>
          <div className="rec-row">
            {recording ? (
              <Button go icon onClick={stop}>
                停止
              </Button>
            ) : (
              <Button go icon onClick={start} disabled={engine.status !== 'ready'}>
                开始录制
              </Button>
            )}
            <span data-frames={frames}>{frames} 帧</span>
          </div>
          {take && take.frames.length > 0 && (
            <div className="rec-row">
              <Button icon onClick={() => download(take)}>
                下载 JSON
              </Button>
              <Button icon onClick={() => setReplay({ rec: take, label: `刚录的这段（${take.frames.length} 帧）` })}>
                回放这一段
              </Button>
              <Button icon onClick={() => standInWith(take)}>
                用这段代替摄像头
              </Button>
            </div>
          )}
        </div>
        <div className="plate box">
          <h3>回放</h3>
          <p>选一个之前下载的录制文件，骨架会在左边循环播放。</p>
          <div className="rec-row">
            <input type="file" accept="application/json,.json" aria-label="选择录制文件" onChange={(e) => load(e.target.files?.[0])} />
          </div>
          {message && (
            <p className="note" data-bad="" role="status">
              {message}
            </p>
          )}
          {replay && (
            <div className="rec-row">
              <Button icon onClick={() => setReplay(null)}>
                停止回放
              </Button>
              <Button icon onClick={() => standInWith(replay.rec)}>
                用这段代替摄像头
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
