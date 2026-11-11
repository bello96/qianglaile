import { useEffect, useState } from 'react';
import type { Engine } from '../useEngine';

/** 右下角的调试信息：识别帧率、单次识别耗时、用的是 GPU 还是 CPU。地址里加 debug=1 显示。 */
export function DebugOverlay({ engine, extra }: { engine: Engine; extra?: () => string }) {
  const [text, setText] = useState('');

  useEffect(() => {
    const timer = setInterval(() => {
      const s = engine.source?.stats();
      const p = engine.tracker.state;
      const lines = [
        s ? `识别 ${s.fps.toFixed(0)} 帧/秒  ${s.detectMs.toFixed(1)} 毫秒  ${s.delegate}/${s.model}${s.thread ? `  ${s.thread === 'worker' ? 'Worker' : '主线程'}` : ''}${(s.people ?? 1) > 1 ? `  找 ${s.people} 个人` : ''}` : '识别未启动',
        `玩家 ${p.present ? '在' : '不在'}  模式 ${p.body?.mode ?? '-'}  活动量 ${p.motion.energy.toFixed(2)}`,
      ];
      const more = extra?.();
      if (more) lines.push(more);
      setText(lines.join('\n'));
    }, 250);
    return () => clearInterval(timer);
  }, [engine, extra]);

  return <div className="debug">{text}</div>;
}
