import { Suspense, useMemo } from 'react';
import { findGame } from '../../games';
import type { GameModule } from '../../games/types';
import { Button } from '../components/Button';
import { currentFlags, navigate } from '../router';
import { useSettings } from '../settings';
import { useEngine } from '../useEngine';

const goHome = (): void => navigate({ page: 'home' });

/** 游戏页：先看地址里写的游戏存不存在；存在才去准备引擎（打开摄像头）。 */
export function Play({ game, onSettings }: { game: string; onSettings: () => void }) {
  const mod = findGame(game);
  if (mod) return <PlayGame mod={mod} onSettings={onSettings} />;

  return (
    <div className="screen">
      <div className="plate center-card">
        <h2>没有这个游戏</h2>
        <p>地址里写的是"{game}"，可这里没有叫这个名字的游戏。</p>
        <div className="center-card__actions">
          <Button go onClick={goHome}>
            回首页
          </Button>
        </div>
      </div>
    </div>
  );
}

/** 准备好引擎（摄像头或模拟玩家），然后把它交给选中的游戏。 */
function PlayGame({ mod, onSettings }: { mod: GameModule; onSettings: () => void }) {
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

  return (
    <Suspense fallback={null}>
      <mod.Component engine={engine} settings={settings} flags={flags} onExit={goHome} onSettings={onSettings} />
    </Suspense>
  );
}
