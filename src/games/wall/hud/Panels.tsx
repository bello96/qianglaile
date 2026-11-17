import { Button } from '../../../app/components/Button';
import type { Summary } from '../game';

/**
 * 开局前的站位引导：一句话 + 一条"站好别动"的进度。
 * advisory：这句话只是建议（太近、太远、偏了）。照做最好；做不到就站着别动，过几秒按现在的样子开始。
 */
export function FramingGuide({ text, progress, advisory }: { text: string; progress: number; mode: 'full' | 'upper' | null; advisory: boolean }) {
  return (
    <div className="plate framing" role="status">
      <div className="framing__text">{text || '站到摄像头前面来'}</div>
      {advisory && <div className="framing__note">地方不够、调不了也没关系：站着别动，过几秒就按现在的样子开始。</div>}
      <div className="lane" aria-hidden="true">
        <div className="lane__fill" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

/**
 * 暂停。
 * auto：是因为人走出了画面，回来就自动继续。
 * restarted：暂停期间识别重新启动过（在设置里换了模型或摄像头）——原来的标定作废了，点"继续"之后要先重新站位。
 * handsFree：现在能不能举手悬停来点按钮（只有真摄像头可以；演示和回放时不行，就不提这回事）。
 * duo：双人游戏（人走出画面时的说明换一句：要两位都回来）。
 */
export function PauseOverlay({
  auto,
  restarted = false,
  handsFree = true,
  duo = false,
  onResume,
  onHome,
  onSettings,
}: {
  auto: boolean;
  restarted?: boolean;
  handsFree?: boolean;
  duo?: boolean;
  onResume: () => void;
  onHome: () => void;
  onSettings: () => void;
}) {
  const note = auto
    ? duo
      ? '两位都回到刚才站的位置、让手脚都进画面，游戏就接着来。'
      : '回到刚才站的位置、让手脚都进画面，游戏就接着来。画面里要是还有别人，请他先让一让。'
    : restarted
      ? '识别刚刚重新启动过。点"继续"之后，先回到你的位置站好别动，重新校准完就接着这一局。'
      : handsFree
        ? '举起手，把光标停在按钮上，也能点。'
        : '';
  return (
    <div className="overlay">
      <div className="plate plate--bib panel">
        <h2>{auto ? '人呢？' : '暂停'}</h2>
        {note && <p className="panel__note">{note}</p>}
        <div className="panel__actions">
          {!auto && (
            <Button go xl air="resume" onClick={onResume}>
              继续
            </Button>
          )}
          <Button xl air="home" onClick={onHome}>
            回首页
          </Button>
        </div>
        {!auto && (
          <p className="panel__note">
            <Button icon onClick={onSettings}>
              设置
            </Button>
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 结算。两种：
 *   全部通关 —— 祝贺，"再来一次"；
 *   没命了 —— 鼓励一句，可以"再闯这一关"（接着这一局，回到这一关的开头），也可以"从头再来"。
 * handsFree：现在能不能举手悬停来点按钮（见 PauseOverlay）。
 */
export function ResultPanel({
  summary,
  handsFree = true,
  onAgain,
  onRetry,
  onHome,
}: {
  summary: Summary;
  handsFree?: boolean;
  /** 从第 1 关重新开一局 */
  onAgain: () => void;
  /** 再闯这一关 */
  onRetry: () => void;
  onHome: () => void;
}) {
  const [one, two, three] = summary.stars;
  return (
    <div className="overlay">
      <div className="plate plate--bib panel">
        <h2>{summary.cleared ? '全部通关！' : `闯到第 ${summary.level} 关`}</h2>
        <p className="panel__lead">{summary.cleared ? (summary.players === 2 ? '十五关全部拿下，你们的默契满分！' : '十五关全部拿下，你就是穿墙王者！') : '差一点点，再来一次肯定行！'}</p>
        <ul className="stats">
          <li>
            <b>{summary.walls}</b>
            <span>穿过的墙</span>
          </li>
          <li>
            <b>{summary.score}</b>
            <span>得分</span>
          </li>
          <li>
            <b>{summary.bestCombo}</b>
            <span>最多连过</span>
          </li>
        </ul>
        <p className="stars">
          <i>★★★</i> {three} 次　<i>★★</i> {two} 次　<i>★</i> {one} 次
        </p>
        {handsFree && <p className="panel__note">举起手，把光标停在按钮上，就能点。</p>}
        <div className="panel__actions">
          {summary.cleared ? (
            <Button go xl air="again" onClick={onAgain}>
              再来一次
            </Button>
          ) : (
            <>
              <Button go xl air="retry" onClick={onRetry}>
                再闯这一关
              </Button>
              <Button xl air="again" onClick={onAgain}>
                从头再来
              </Button>
            </>
          )}
          <Button xl air="home" onClick={onHome}>
            回首页
          </Button>
        </div>
      </div>
    </div>
  );
}
