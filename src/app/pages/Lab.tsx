import { useEffect, useMemo, useState } from 'react';
import type { PoseSpec } from '../../engine/body/pose';
import type { Recording } from '../../engine/input/recorder';
import { loadCustomPosesReport, mergePoses } from '../../games/wall/customPoses';
import { Button } from '../components/Button';
import { LivePanel } from '../components/LivePanel';
import { PoseGallery } from '../components/PoseGallery';
import { RecorderPanel } from '../components/RecorderPanel';
import { ReplayNotice } from '../components/ReplayNotice';
import { ErrorCard, LoadingCard } from '../components/StatusCards';
import { currentFlags, navigate } from '../router';
import { useSettings } from '../settings';
import '../styles/lab.css';
import { useEngine } from '../useEngine';

type Tab = 'live' | 'gallery' | 'record';
const TABS: [Tab, string][] = [
  ['live', '实时'],
  ['gallery', '图鉴'],
  ['record', '录制'],
];

/**
 * 姿势实验室：把"摄像头 → 骨架 → 数字 → 墙"这条线上的每一步摊开来看。
 *   实时：摄像头和骨架、每段肢体的角度、动作特征，以及把当前姿势存成一面新墙
 *   图鉴：全部的墙长什么样（内置的 + 自己存的）
 *   录制：把一段动作的关键点数据录下来、存成文件、再回放
 */
export function Lab() {
  const flags = useMemo(currentFlags, []);
  const [settings] = useSettings();
  const engine = useEngine({
    sim: flags.sim,
    seed: flags.seed,
    model: settings.model,
    cameraId: settings.cameraId,
    people: settings.twoPeople ? 2 : 1,
    expose: flags.e2e || import.meta.env.DEV,
    worker: flags.worker,
  });
  const [tab, setTab] = useState<Tab>('live');
  const [custom, setCustom] = useState<PoseSpec[]>([]);
  /** 项目里存墙的文件在、却读不懂：图鉴里要说一声，不然里面的墙就像凭空没了 */
  const [fileBroken, setFileBroken] = useState(false);
  /**
   * 刚录好、还没下载的那一段。放在这里而不是"录制"页自己手里：引擎一重启（比如点了"用这段代替摄像头"），
   * "录制"页会被换成加载卡片再换回来，它自己记的东西就没了——而这一段只存在内存里，丢了就是真丢了。
   */
  const [take, setTake] = useState<Recording | null>(null);

  useEffect(() => {
    let alive = true;
    void loadCustomPosesReport().then((report) => {
      if (!alive) return;
      // 读文件的工夫里可能已经存了新的：合在一起，别把它盖掉
      setCustom((now) => mergePoses(report.list, now));
      setFileBroken(report.fileBroken);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 图鉴不需要摄像头：摄像头打不开时它照样能看
  const needsCamera = tab !== 'gallery';

  return (
    <div className="page lab">
      <header className="lab__head">
        <Button icon onClick={() => navigate({ page: 'home' })}>
          返回
        </Button>
        <h1 className="plate lab__title">姿势实验室</h1>
        <div className="seg" role="group" aria-label="实验室的三个页面">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={tab === id} data-tab={id} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
        <ReplayNotice />
      </header>

      {needsCamera && engine.status === 'loading' && <LoadingCard engine={engine} />}
      {needsCamera && engine.status === 'error' && <ErrorCard engine={engine} />}
      {tab === 'live' && engine.status === 'ready' && <LivePanel engine={engine} onSaved={(pose) => setCustom((now) => mergePoses(now, [pose]))} onGallery={() => setTab('gallery')} />}
      {tab === 'gallery' && <PoseGallery custom={custom} onChange={setCustom} fileBroken={fileBroken} />}
      {tab === 'record' && engine.status === 'ready' && <RecorderPanel engine={engine} take={take} onTake={setTake} />}
    </div>
  );
}
