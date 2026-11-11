import { useCallback, useEffect, useRef, useState } from 'react';
import { sfx } from '../../app/audio';
import { AirCursorLayer } from '../../app/components/AirCursorLayer';
import { Button } from '../../app/components/Button';
import { CameraPip } from '../../app/components/CameraPip';
import { DebugOverlay } from '../../app/components/DebugOverlay';
import { ErrorCard, LoadingCard } from '../../app/components/StatusCards';
import { startFrameLoop, useCrash } from '../../app/frameLoop';
import { speak } from '../../engine/audio/speech';
import { SimPoseSource } from '../../engine/input/simSource';
import type { GameProps } from '../types';
import { loadCustomPoses, wallPool } from './customPoses';
import { IDLE_STATE, type Summary } from './game';
import { Hud, IDLE_SNAP, toSnap, type BannerData, type HudSnap } from './hud/Hud';
import './hud/hud.css';
import { FramingGuide, PauseOverlay, ResultPanel } from './hud/Panels';
import { STAND } from './poses';
import { AutoQuality } from './scene/quality';
import { WallSceneView } from './scene/view';
import { WallSession, type FramingView, type SessionEvent, type SessionStage } from './session';
import { TUNING } from './tuning';

const STARS = ['', '★', '★★', '★★★'];
/** 界面每秒只刷新十来次，不跟着 60 帧走 */
const UI_EVERY_MS = 90;

/**
 * 「别撞墙！」的游戏页。这一局怎么进行（站位、标定、出墙、判定、暂停、重新标定）都在 WallSession 里；
 * 这里只负责把它"演"出来：3D 场景、界面、声音，以及把按钮和按键接到它身上。
 *
 * 每一帧：session.update() → 把它返回的事件交给场景、界面、声音 → 画一帧。
 */
export default function WallPlay({ engine, settings, flags, onExit, onSettings }: GameProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<WallSceneView | null>(null);
  const bannerKey = useRef(0);
  /** "试试这面墙"时为 true：这一局只有一面墙可出 */
  const practising = useRef(false);

  const [stage, setStage] = useState<SessionStage>('framing');
  const [snap, setSnap] = useState<HudSnap>(IDLE_SNAP);
  const [banner, setBanner] = useState<BannerData | null>(null);
  const [framing, setFraming] = useState<FramingView>({ text: '', progress: 0, mode: null, advisory: false });
  const [paused, setPaused] = useState(false);
  const [autoPaused, setAutoPaused] = useState(false);
  /** 引擎在暂停期间重启过（多半是在设置里换了模型或摄像头）：停在暂停面板上，等人点"继续"再重新站位 */
  const [awaiting, setAwaiting] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  /** 每帧循环里出的错从这里报给页面的出错兜底（否则画面僵住，页面却不知道） */
  const crash = useCrash();

  // 主循环只建一次，里面要读的"最新值"都放在 ref 里
  const live = useRef({ engine, settings, flags, paused });
  live.current = { engine, settings, flags, paused };

  const sessionRef = useRef<WallSession | null>(null);
  sessionRef.current ??= new WallSession({ seed: flags.seed, sim: flags.sim, difficulty: () => live.current.settings.difficulty });
  const session = sessionRef.current;

  // 模拟玩家的行为：auto 照着墙摆，wrong 一直站着，manual 等按键。摄像头打不开转成演示模式时也自动摆
  const policy = flags.sim !== 'off' ? flags.sim : engine.kind === 'sim' ? 'auto' : null;

  const showBanner = useCallback((kind: BannerData['kind'], text: string, sub?: string) => {
    setBanner({ key: ++bannerKey.current, kind, text, sub });
  }, []);

  const pause = useCallback(
    (on: boolean) => {
      session.setPaused(on);
      setPaused(on);
    },
    [session],
  );

  // ---- 读出自己存的墙，和内置的合成这一局的造型池（会话要等它才开局）----
  useEffect(() => {
    let alive = true;
    void loadCustomPoses().then((list) => {
      if (!alive) return;
      const pool = wallPool(list, flags.only);
      practising.current = flags.only !== null && pool.poses.length === 1;
      session.setPool(pool);
    });
    return () => {
      alive = false;
    };
  }, [session, flags.only]);

  // ---- 3D 场景 ----
  // 画质"自动"：识别都只能用轻量模型、或者只能靠 CPU 的电脑，显卡多半也吃紧，那就用低画质。
  // 引擎重启的那几秒看不到识别端的状态，这时沿用上一次的结论（见 AutoQuality）——不然场景会白白重建两回
  const autoQuality = useRef<AutoQuality | null>(null);
  autoQuality.current ??= new AutoQuality();
  const quality = autoQuality.current.pick(settings.quality, engine.status === 'ready' && engine.kind === 'camera' ? engine.source?.stats() : null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const scene = new WallSceneView(host, { quality, profile: session.ctx?.profile ?? live.current.engine.tracker.state.profile, ghost: TUNING[live.current.settings.difficulty].ghost });
    viewRef.current = scene;
    // 游戏进行到一半重建场景（比如在设置里改了画质）：把正在飞来的那面墙补回去
    const state = session.game?.state;
    if (state?.wall && (state.phase === 'approach' || state.phase === 'paused')) scene.handle({ type: 'wall', wall: state.wall });
    if (live.current.flags.e2e || import.meta.env.DEV) {
      const w = window as unknown as { __mw?: Record<string, unknown> };
      w.__mw = { ...w.__mw, scene };
    }

    const fit = (): void => scene.resize(host.clientWidth, host.clientHeight);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(host);
    return () => {
      observer.disconnect();
      scene.dispose();
      viewRef.current = null;
    };
  }, [quality, session]);

  // ---- 主循环 ----
  useEffect(() => {
    let last = performance.now();
    let lastUi = 0;
    let shownStage: SessionStage = 'framing';
    let shownAwaiting = false;

    const onEvent = (e: SessionEvent): void => {
      const scene = viewRef.current;
      if (e.type === 'begin') {
        // 开局了，或者中途重新标定完、接着玩
        scene?.setProfile(e.ctx.profile);
        if (scene) scene.showGhost = TUNING[live.current.settings.difficulty].ghost;
        if (live.current.flags.e2e || import.meta.env.DEV) {
          const w = window as unknown as { __mw?: Record<string, unknown> };
          w.__mw = { ...w.__mw, game: session.game, scene };
        }
        setAutoPaused(false);
        if (!e.resumed) {
          setSummary(null);
          pause(false);
        }
        return;
      }

      scene?.handle(e);
      switch (e.type) {
        case 'countdown':
          showBanner('count', String(e.n));
          sfx.play('tick', { pitch: e.n === 1 ? 1.3 : 1 });
          break;
        case 'wall': {
          sfx.play('spawn');
          speak(e.wall.say);
          // "试试这面墙"却出了别的墙：说明这面墙现在做不了（多半是它要用腿，而摄像头只看得到上半身）
          const got = (e.wall.spec.pose ?? e.wall.spec.shape)!.id.replace(/~m$/, '');
          if (practising.current && got !== live.current.flags.only && e.wall.spec.index === 1) {
            showBanner('level', '这面墙现在练不了', '它用到的部位摄像头看不全，先换成一字平举');
          }
          break;
        }
        case 'tick':
          sfx.play('tick', { pitch: 1 + (3 - e.n) * 0.12 });
          break;
        case 'outcome':
          if (e.outcome.kind === 'pass') {
            const perfect = e.outcome.stars === 3;
            showBanner(perfect ? 'perfect' : 'pass', perfect ? '完美！' : '过关！', `${STARS[e.outcome.stars]}　+${e.gained}`);
            // 连着过，音调一面比一面高
            const combo = session.game?.state.combo ?? 1;
            sfx.play(perfect ? 'perfect' : 'pass', { pitch: 1 + 0.06 * Math.min(8, Math.max(0, combo - 1)) });
          } else {
            showBanner('hit', '撞墙了！', e.outcome.reason);
            sfx.play('hit');
          }
          break;
        case 'skip':
          showBanner('level', '这面墙不算', '换一面');
          break;
        case 'levelup':
          showBanner('level', `第 ${e.level} 关`, '墙更快了，站稳');
          sfx.play('levelup');
          break;
        case 'pause':
          setAutoPaused(e.on);
          break;
        case 'over':
          setSummary(e.summary);
          sfx.play('over');
          speak('游戏结束');
          break;
        case 'life':
          break;
      }
    };

    const tick = (now: number): void => {
      const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      const scene = viewRef.current;
      if (!scene) return;
      const { engine: eng, flags: fl, paused: isPaused } = live.current;

      for (const e of session.update(now, dt, eng, fl.fast ? 3 : 1)) onEvent(e);
      if (session.stage !== shownStage) {
        shownStage = session.stage;
        setStage(shownStage);
      }
      if (session.awaitingResume !== shownAwaiting) {
        shownAwaiting = session.awaitingResume;
        setAwaiting(shownAwaiting);
      }

      // ---- 画面和声音 ----
      const game = session.game;
      const state = game?.state ?? IDLE_STATE;
      const { splashed } = scene.frame(dt, state, eng.status === 'ready' ? eng.tracker.sample(now) : null, game?.assist() ?? null);
      if (splashed) sfx.play('splash');
      sfx.setApproach(session.stage === 'playing' && state.phase === 'approach' && !isPaused ? state.progress : null);

      if (now - lastUi > UI_EVERY_MS) {
        lastUi = now;
        if (session.stage === 'framing') setFraming(session.framing);
        else if (game) setSnap(toSnap(state));
      }
    };
    // 循环里抛了错：停下，交给页面的出错兜底，而不是每秒抛六十次
    const stop = startFrameLoop(tick, crash);

    return () => {
      stop();
      sfx.setApproach(null);
    };
  }, [session, pause, showBanner, crash]);

  // ---- 暂停：按钮、Esc、标签页切到后台 ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Esc：暂停 / 继续。（设置面板开着的时候这里收不到 Esc——那一下归面板，见 SettingsDialog）
      if (e.key === 'Escape' && (session.stage === 'playing' || session.awaitingResume)) pause(!live.current.paused);
      // 手动模拟：P 摆出当前这面墙要的姿势，S 站好
      const source = live.current.engine.source;
      if (live.current.flags.sim === 'manual' && source instanceof SimPoseSource) {
        const wall = session.game?.state.wall;
        if (e.key === 'p' && wall) source.setPose(wall.spec.pose ?? wall.spec.shape!.demo, { x: wall.spec.holeX }, 0.4);
        if (e.key === 's') source.setPose(STAND, {}, 0.4);
      }
    };
    const onHide = (): void => {
      if (!document.hidden) return;
      // 标签页在后台时画面循环不跑，不会有人去关风声，所以这里关
      sfx.setApproach(null);
      if (session.stage === 'playing') pause(true);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [session, pause]);

  /** 打开设置：先把游戏停住。改了识别模型或摄像头的话引擎会重启，重新站位之后接着这一局。 */
  const openSettings = useCallback(() => {
    if (session.stage === 'playing') pause(true);
    onSettings();
  }, [session, pause, onSettings]);

  const ready = engine.status === 'ready';
  // 举手悬停点按钮只对真摄像头有效（见 airCursorWanted），提示语跟着走
  const handsFree = engine.kind === 'camera';
  return (
    <div className="screen">
      <div ref={hostRef} className="stage-layer" />
      <div className="ui-layer">
        {/* awaiting：暂停面板在最上面，底下的加载、出错、站位引导都等人点了"继续"再说 */}
        {engine.status === 'loading' && !awaiting && <LoadingCard engine={engine} />}
        {engine.status === 'error' && !awaiting && <ErrorCard engine={engine} />}

        {ready && stage === 'framing' && !policy && !awaiting && <FramingGuide {...framing} />}
        {stage === 'framing' && !awaiting && (
          <div style={{ position: 'absolute', left: 20, top: 16 }}>
            <Button icon onClick={onExit}>
              回首页
            </Button>
          </div>
        )}

        {stage === 'playing' && <Hud snap={snap} banner={banner} onPause={() => pause(true)} onSettings={openSettings} />}
        {((stage === 'playing' && (paused || autoPaused)) || awaiting) && <PauseOverlay auto={!paused && !awaiting} restarted={awaiting} handsFree={handsFree} onResume={() => pause(false)} onHome={onExit} onSettings={openSettings} />}
        {stage === 'over' && summary && <ResultPanel summary={summary} handsFree={handsFree} onAgain={() => session.again()} onHome={onExit} />}

        {ready && settings.pip && stage !== 'over' && <CameraPip engine={engine} skeleton={settings.skeleton} />}
        {flags.debug && <DebugOverlay engine={engine} />}
      </div>
      <AirCursorLayer engine={engine} />
    </div>
  );
}
