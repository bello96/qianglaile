import { useEffect, useRef, useState } from 'react';
import { limbJoints, LIMBS, measureLimbs, type LimbId } from '../../engine/body/pose';
import type { Motion, MotionEvent } from '../../engine/motion/features';
import { STALE_MS, type Engine } from '../useEngine';

const LIMB_NAMES: Record<LimbId, string> = {
  upperArmL: '左上臂', forearmL: '左前臂', upperArmR: '右上臂', forearmR: '右前臂',
  thighL: '左大腿', shinL: '左小腿', thighR: '右大腿', shinR: '右小腿', spine: '脊柱',
};

/** 每个特征怎么显示：名字、是不是有正负。 */
const FEATURES: { key: keyof Motion; name: string; signed?: boolean; max?: number }[] = [
  { key: 'energy', name: '活动量' },
  { key: 'lean', name: '侧倾', signed: true },
  { key: 'armLiftL', name: '左举臂', signed: true },
  { key: 'armLiftR', name: '右举臂', signed: true },
  { key: 'squat', name: '下蹲' },
  { key: 'feetApart', name: '脚间距', max: 3 },
  { key: 'kneeLiftL', name: '左抬膝' },
  { key: 'kneeLiftR', name: '右抬膝' },
];

const EVENTS: [MotionEvent, string][] = [
  ['jump', '跳'],
  ['squatDown', '蹲下'],
  ['squatUp', '起身'],
  ['handUpL', '举左手'],
  ['handUpR', '举右手'],
];

interface Snapshot {
  limbs: { id: LimbId; angle: number; scale: number; ok: boolean }[];
  motion: Motion;
  lit: Set<MotionEvent>;
}

/**
 * 把流水线中间的数据摊开给人看：每段肢体的朝向角、动作特征的强度、刚刚发生的事件。
 * 想知道"为什么判我没摆对"，或者想给新游戏挑一个合适的特征，看这里。
 */
export function FeatureMeters({ engine }: { engine: Engine }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const firedAt = useRef(new Map<MotionEvent, number>());

  // 事件只在发生的那一帧出现，所以要订阅每一帧，而不是定时去看
  useEffect(
    () =>
      engine.source?.onFrame(() => {
        for (const e of engine.tracker.state.events) firedAt.current.set(e, performance.now());
      }),
    [engine.source, engine.tracker],
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const p = engine.tracker.state;
      if (!p.body || engine.sinceFrame() > STALE_MS) return setSnap(null);
      const measured = measureLimbs(p.body.skeleton, p.profile);
      const now = performance.now();
      setSnap({
        limbs: LIMBS.map((id) => {
          const [a, b] = limbJoints(id);
          return { id, angle: measured[id].angle, scale: measured[id].scale, ok: p.body!.ok[a] && p.body!.ok[b] };
        }),
        motion: p.motion,
        lit: new Set(EVENTS.map(([e]) => e).filter((e) => now - (firedAt.current.get(e) ?? -1e9) < 700)),
      });
    }, 150);
    return () => clearInterval(timer);
  }, [engine]);

  if (!snap) {
    return (
      <div className="plate box">
        <h3>还没看到人</h3>
        <p>站到摄像头前面，这里就会显示你每段肢体的角度和动作特征。</p>
      </div>
    );
  }

  return (
    <>
      <div className="plate box">
        <h3>关节角</h3>
        <table className="angles">
          <thead>
            <tr>
              <th>肢体</th>
              <th>朝向</th>
              <th>正面长度</th>
            </tr>
          </thead>
          <tbody>
            {snap.limbs.map((l) => (
              <tr key={l.id} data-off={l.ok ? undefined : ''}>
                <td>{LIMB_NAMES[l.id]}</td>
                <td>{l.angle.toFixed(0)}°</td>
                <td>{Math.round(l.scale * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">朝向：0° 朝下，90° 水平朝外，180° 朝上。灰色的是摄像头看不清的。</p>
      </div>

      <div className="plate box">
        <h3>动作特征</h3>
        <div className="meters">
          {FEATURES.map((f) => {
            const v = snap.motion[f.key];
            const share = Math.min(1, Math.abs(v) / (f.max ?? 1));
            const style = f.signed ? { left: v < 0 ? `${50 - share * 50}%` : '50%', width: `${share * 50}%` } : { width: `${share * 100}%` };
            return (
              <div key={f.key} style={{ display: 'contents' }}>
                <span>{f.name}</span>
                <span className={f.signed ? 'bar bar--signed' : 'bar'}>
                  <i style={style} />
                </span>
                <span>{v.toFixed(2)}</span>
              </div>
            );
          })}
        </div>
        <div className="chips">
          {EVENTS.map(([e, name]) => (
            <span key={e} className="chip" data-lit={snap.lit.has(e) ? '' : undefined}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </>
  );
}
