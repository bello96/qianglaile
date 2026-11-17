import { Button } from '../../../app/components/Button';
import type { Phase, WallGameState } from '../game';
import { COMMON } from '../tuning';

/** HUD 每秒只刷新十来次（不跟着 60 帧走），所以把要显示的东西从游戏状态里抄一份出来。 */
export interface HudSnap {
  phase: Phase;
  level: number;
  wallInLevel: number;
  wallsInLevel: number;
  lives: number;
  score: number;
  combo: number;
  /** 这面墙的名字 */
  label: string;
  /** 哪里没摆对；摆对了是空串 */
  hint: string;
  /** 现在摆得对不对；null 表示这会儿没在判 */
  ok: boolean | null;
  accuracy: number;
  timeLeft: number;
  progress: number;
}

export const IDLE_SNAP: HudSnap = {
  phase: 'idle',
  level: 1,
  wallInLevel: 0,
  wallsInLevel: COMMON.levelSlots[0][0] + COMMON.levelSlots[0][1],
  lives: COMMON.lives,
  score: 0,
  combo: 0,
  label: '',
  hint: '',
  ok: null,
  accuracy: 0,
  timeLeft: 0,
  progress: 0,
};

export function toSnap(s: WallGameState): HudSnap {
  return {
    phase: s.phase,
    level: s.level,
    wallInLevel: s.wallInLevel,
    wallsInLevel: s.wallsInLevel,
    lives: s.lives,
    score: s.score,
    combo: s.combo,
    label: s.wall?.label ?? '',
    hint: s.live?.hint ?? '',
    ok: s.live ? s.live.ok : null,
    accuracy: s.live?.accuracy ?? 0,
    timeLeft: s.timeLeft,
    progress: s.progress,
  };
}

/**
 * 正中的大横幅。key 变了就重新播放入场动画。
 * kind：perfect / pass / hit 是一面墙的结果，count 是倒计时，level 是一般的通知（这面墙不算……），
 * clear 是过了一关，intro 是下一关的预告（字多，小一号），finale 是全部通关（停得久）。
 */
export interface BannerData {
  key: number;
  kind: 'perfect' | 'pass' | 'hit' | 'level' | 'count' | 'clear' | 'intro' | 'finale';
  text: string;
  sub?: string;
  /** 过墙：下面那行是几颗一颗一颗蹦出来的星星，后面跟着得分（给了它就不用 sub） */
  stars?: { count: number; gained: number };
  /** 屏幕边缘闪一下：good 绿，bad 红 */
  flash?: 'good' | 'bad';
}

function LifeRing({ lost }: { lost: boolean }) {
  // 救生圈：白底，四段珊瑚红
  return (
    <svg viewBox="0 0 48 48" className={lost ? 'life life--lost' : 'life'} aria-hidden="true">
      <circle cx="24" cy="24" r="15" fill="none" stroke="#14213d" strokeWidth="15" />
      <circle cx="24" cy="24" r="15" fill="none" stroke="#fff" strokeWidth="10" />
      <circle cx="24" cy="24" r="15" fill="none" stroke="#ff5d4a" strokeWidth="10" strokeDasharray="11.78 11.78" />
    </svg>
  );
}

function Banner({ data }: { data: BannerData }) {
  return (
    <div className={`banner banner--${data.kind}`} role="status">
      <div className="banner__text">{data.text}</div>
      {data.stars ? (
        <div className="plate banner__sub">
          {Array.from({ length: data.stars.count }, (_, i) => (
            // 一颗一颗蹦出来：每颗晚 0.17 秒（声音在 WallPlay 里按同样的间隔响）
            <span key={i} className="star-pop" style={{ animationDelay: `${STAR_FIRST_MS + i * STAR_EVERY_MS}ms` }}>
              ★
            </span>
          ))}
          　+{data.stars.gained}
        </div>
      ) : (
        data.sub && <div className="plate banner__sub">{data.sub}</div>
      )}
    </div>
  );
}

/** 过墙横幅上的星星：第一颗多久之后蹦出来，之后每隔多久一颗（毫秒）。"叮"的声音按同一个节奏响 */
export const STAR_FIRST_MS = 180;
export const STAR_EVERY_MS = 170;

const RING = 2 * Math.PI * 42;

export function Hud({ snap, banner, onPause, onSettings }: { snap: HudSnap; banner: BannerData | null; onPause: () => void; onSettings: () => void }) {
  const wallOnItsWay = snap.phase === 'approach' || snap.phase === 'paused';
  // 本关已经过完几面：正在驶来的这面不算
  const done = Math.max(0, snap.wallInLevel - (wallOnItsWay ? 1 : 0)) / Math.max(1, snap.wallsInLevel);

  return (
    <div className="hud">
      <div className="hud__top">
        <div className="hud__col">
          <div className="lives" role="img" aria-label={`还剩 ${snap.lives} 条命`}>
            {/* 一共几条命由 tuning.ts 的 COMMON.lives 定，这里跟着画 */}
            {Array.from({ length: COMMON.lives }, (_, i) => (
              <LifeRing key={i} lost={i >= snap.lives} />
            ))}
          </div>
          <div className="plate level">
            <span>第 {snap.level} 关</span>
            <div className="lane" aria-hidden="true">
              <div className="lane__fill" style={{ width: `${done * 100}%` }} />
            </div>
          </div>
        </div>
        <div className="hud__col hud__col--right">
          <div className="plate score">
            {snap.score}
            <small>分</small>
          </div>
          {snap.combo >= 2 && <div className="plate combo">连过 {snap.combo} 面</div>}
          <div className="hud__buttons">
            <Button icon onClick={onPause}>
              暂停
            </Button>
            <Button icon onClick={onSettings}>
              设置
            </Button>
          </div>
        </div>
      </div>

      {wallOnItsWay && (
        <>
          <div className="pose">
            {snap.hint ? <div className="plate pose__hint">{snap.hint}</div> : snap.ok ? <div className="plate pose__hint pose__hint--ok">就这样，保持住</div> : null}
            <div className="plate pose__name">{snap.label}</div>
            <div className="lane" aria-hidden="true">
              <div className="lane__fill" style={{ width: `${Math.min(1, snap.progress) * 100}%` }} />
            </div>
          </div>
          <div className="plate meter">
            <span className="plate meter__label">契合度 {Math.round(snap.accuracy * 100)}%</span>
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle cx="50" cy="50" r="42" fill="none" stroke="#d7eef3" strokeWidth="11" />
              <circle
                cx="50"
                cy="50"
                r="42"
                fill="none"
                stroke={snap.ok ? '#3ddc97' : '#ff5d4a'}
                strokeWidth="11"
                strokeLinecap="round"
                strokeDasharray={`${RING * snap.accuracy} ${RING}`}
              />
            </svg>
            <span className="meter__time">{snap.timeLeft.toFixed(1)}</span>
          </div>
        </>
      )}

      {banner?.flash && <div key={`flash-${banner.key}`} className={`edge-flash edge-flash--${banner.flash}`} aria-hidden="true" />}
      {banner && <Banner key={banner.key} data={banner} />}
    </div>
  );
}
