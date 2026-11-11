import type { Engine } from '../useEngine';
import { Button } from './Button';

const mb = (bytes: number): string => (bytes / 1048576).toFixed(1);

/** 正在打开摄像头、下载识别模型。 */
export function LoadingCard({ engine }: { engine: Engine }) {
  const p = engine.progress;
  const done = p && p.total > 0 ? Math.min(1, p.loaded / p.total) : 0;
  return (
    <div className="plate center-card" role="status">
      <h2>{engine.kind === 'sim' ? '正在准备演示' : engine.kind === 'replay' ? '正在准备回放' : '正在打开摄像头'}</h2>
      {engine.kind === 'camera' && (
        <>
          <p>
            {engine.step === 'measure'
              ? '正在测这台电脑的识别速度，马上就好'
              : p && done < 1
                ? `正在下载识别模型：${mb(p.loaded)} / ${mb(p.total)} MB`
                : p
                  ? '模型下好了，正在启动识别引擎'
                  : '浏览器问"能不能用摄像头"时，请点"允许"。'}
          </p>
          <div className="lane" aria-hidden="true">
            <div className="lane__fill" style={{ width: `${done * 100}%` }} />
          </div>
          <p>画面只在这台电脑上识别，不会上传。</p>
        </>
      )}
    </div>
  );
}

/** 摄像头或识别模型没起来：说清楚怎么回事、怎么办，并给一条不用摄像头的出路。 */
export function ErrorCard({ engine }: { engine: Engine }) {
  return (
    <div className="plate center-card" role="alert">
      <h2>{engine.error?.title ?? '出了点问题'}</h2>
      <p>{engine.error?.hint}</p>
      <div className="center-card__actions">
        <Button go onClick={engine.retry}>
          再试一次
        </Button>
        <Button onClick={engine.useDemo}>用演示模式看看</Button>
      </div>
    </div>
  );
}
