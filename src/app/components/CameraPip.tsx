import { useEffect, useRef } from 'react';
import { LM } from '../../engine/body/landmarks';
import type { Engine } from '../useEngine';

/** 画骨架时连哪些点。 */
const BONES: [number, number][] = [
  [LM.leftShoulder, LM.rightShoulder],
  [LM.leftShoulder, LM.leftElbow], [LM.leftElbow, LM.leftWrist],
  [LM.rightShoulder, LM.rightElbow], [LM.rightElbow, LM.rightWrist],
  [LM.leftShoulder, LM.leftHip], [LM.rightShoulder, LM.rightHip], [LM.leftHip, LM.rightHip],
  [LM.leftHip, LM.leftKnee], [LM.leftKnee, LM.leftAnkle],
  [LM.rightHip, LM.rightKnee], [LM.rightKnee, LM.rightAnkle],
];

/** 把镜像后的画面和（可选的）骨架画到一张画布上。给小窗用，也给实验室的大画面用。 */
export function drawCamera(g: CanvasRenderingContext2D, w: number, h: number, engine: Engine, skeleton: boolean): void {
  const video = engine.video;
  if (video && video.readyState >= 2) {
    // 镜像：像照镜子一样，你举右手，画面里右边的手举起来
    g.save();
    g.translate(w, 0);
    g.scale(-1, 1);
    g.drawImage(video, 0, 0, w, h);
    g.restore();
  } else {
    g.fillStyle = '#14213d';
    g.fillRect(0, 0, w, h);
  }

  const body = engine.tracker.state.body;
  // 模拟玩家没有画面，只能看骨架，所以总是画
  if (!body || !(skeleton || !video)) return;
  const pts = body.image;
  const at = (i: number): [number, number] => [pts[i].x * w, pts[i].y * h];
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, w / 110);
  g.strokeStyle = '#3ddc97';
  for (const [a, b] of BONES) {
    if (pts[a].v < 0.5 || pts[b].v < 0.5) continue;
    g.beginPath();
    g.moveTo(...at(a));
    g.lineTo(...at(b));
    g.stroke();
  }
  // 头：一个圈
  if (pts[LM.nose].v >= 0.5) {
    const [x, y] = at(LM.nose);
    const r = Math.hypot(pts[LM.leftEar].x - pts[LM.rightEar].x, pts[LM.leftEar].y - pts[LM.rightEar].y) * w * 0.8 || w / 30;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.stroke();
  }
}

/** 左下角的摄像头小窗：让玩家确认自己在不在画面里。 */
export function CameraPip({ engine, skeleton }: { engine: Engine; skeleton: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    let raf = 0;
    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      drawCamera(g, canvas.width, canvas.height, engine, skeleton);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [engine, skeleton]);

  return (
    <div className="plate pip">
      <canvas ref={ref} width={320} height={180} aria-label="摄像头画面" />
    </div>
  );
}
