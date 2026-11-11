import { setReplayOverride, useReplayOverride } from '../replayOverride';

/**
 * "正在用录制代替摄像头"的提示条。只在开着这个开关时出现，旁边带一个换回去的按钮——
 * 免得在实验室里打开之后忘了，回头纳闷游戏怎么不用摄像头了。
 */
export function ReplayNotice() {
  const standIn = useReplayOverride();
  if (!standIn) return null;
  return (
    <div className="plate replay-notice" role="status">
      正在用一段录制代替摄像头
      <button type="button" className="replay-notice__off" onClick={() => setReplayOverride(null)}>
        换回摄像头
      </button>
    </div>
  );
}
