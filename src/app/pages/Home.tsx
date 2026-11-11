import { lazy, Suspense, useMemo } from 'react';
import { BRAND } from '../../brand';
import { GAMES } from '../../games';
import { AutoQuality } from '../../games/wall/scene/quality';
import { Button } from '../components/Button';
import { ReplayNotice } from '../components/ReplayNotice';
import { currentFlags, navigate } from '../router';
import { useSettings } from '../settings';

// 背景里的自动演示要用到整套 3D 代码，体积不小：等首页先显示出来再去加载它
const Attract = lazy(() => import('../../games/wall/Attract'));

export function Home({ onSettings }: { onSettings: () => void }) {
  const [settings] = useSettings();
  const flags = useMemo(currentFlags, []);
  // 系统设置里要求"减少动态效果"的人，不给他放一直在动的背景
  const calm = useMemo(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  // 画质"自动"：首页没开摄像头，没法现看这台电脑强不强，用上次在游戏里得出的结论（没玩过就先用高）
  const quality = useMemo(() => new AutoQuality().pick(settings.quality, null), [settings.quality]);

  return (
    <div className="screen">
      {!calm && (
        <Suspense fallback={null}>
          <Attract quality={quality} expose={flags.e2e || import.meta.env.DEV} />
        </Suspense>
      )}
      <div className="ui-layer">
        <header className="home__top">
          <div className="home__brand">
            <div className="plate brand">{BRAND.studio}</div>
            <ReplayNotice />
          </div>
          <nav className="home__nav">
            <Button icon onClick={() => navigate({ page: 'lab' })}>
              姿势实验室
            </Button>
            <Button icon onClick={onSettings}>
              设置
            </Button>
          </nav>
        </header>

        <main className="home__hero">
          <h1 className="title-plate">{BRAND.wallGame}</h1>
          <div>
            <p className="plate home__lead">
              墙来之前摆好姿势，从洞里穿过去。
              <br />
              摆错了，就下水。
            </p>
          </div>
          <div className="home__actions">
            <Button go xl onClick={() => navigate({ page: 'play', game: 'wall' })}>
              开始闯关
            </Button>
            {/* 其余登记过的游戏：在 src/games/index.ts 里加一行，这里就多一个按钮 */}
            {GAMES.filter((g) => g.id !== 'wall').map((g) => (
              <Button key={g.id} title={g.blurb} onClick={() => navigate({ page: 'play', game: g.id })}>
                {g.name}
              </Button>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
