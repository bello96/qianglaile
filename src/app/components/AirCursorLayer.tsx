import { useEffect, useRef } from 'react';
import { AirCursor, airCursorWanted, DwellClicker } from '../../engine/ui/airCursor';
import { sfx } from '../audio';
import { STALE_MS, type Engine } from '../useEngine';

const RING = 2 * Math.PI * 30;

/**
 * 举手悬停光标的界面部分。
 * 页面上只要有带 data-air 属性的按钮，举起手就会出现光标；光标在按钮上停满一圈，就替你点下去。
 * 没有这类按钮时（比如正在闯关）不显示光标，免得举手摆姿势时冒出来。
 */
export function AirCursorLayer({ engine }: { engine: Engine }) {
  const elRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const cursor = new AirCursor();
    const dwell = new DwellClicker();
    let hovered: Element | null = null;
    let raf = 0;

    const hover = (el: Element | null): void => {
      if (el === hovered) return;
      hovered?.removeAttribute('data-air-hover');
      el?.setAttribute('data-air-hover', '');
      if (el) sfx.play('hover');
      hovered = el;
    };

    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      const el = elRef.current;
      if (!el) return;
      const now = performance.now();
      const player = engine.tracker.state;
      // 什么时候该有光标，规矩在 airCursorWanted 里（只认真摄像头；有对话框开着、没有可点的按钮时都不要）
      const wanted = airCursorWanted({
        ready: engine.status === 'ready',
        kind: engine.kind,
        modalOpen: document.querySelector('[aria-modal="true"]') !== null,
        hasTargets: document.querySelector('[data-air]') !== null,
      });
      // 识别结果太旧（摄像头卡住了）就当作没人：不然光标会冻在按钮上，自己把它"点"下去
      const seen = player.present && engine.sinceFrame(now) < STALE_MS;
      const state = wanted ? cursor.update(seen ? player.body : null, player.profile) : null;
      if (!state?.active) {
        if (!wanted) cursor.reset();
        el.style.display = 'none';
        hover(null);
        dwell.update(null, now);
        return;
      }

      const x = state.x * window.innerWidth;
      const y = state.y * window.innerHeight;
      el.style.display = 'block';
      el.style.transform = `translate(${x}px, ${y}px)`;

      const target = document.elementsFromPoint(x, y).find((e) => e.hasAttribute('data-air')) ?? null;
      hover(target);
      const { progress, fire } = dwell.update(target?.getAttribute('data-air') ?? null, now);
      if (ringRef.current) ringRef.current.style.strokeDasharray = `${RING * progress} ${RING}`;
      if (fire && target instanceof HTMLElement) target.click();
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      hover(null);
    };
  }, [engine]);

  return (
    <div ref={elRef} className="air-cursor" style={{ display: 'none', left: 0, top: 0 }} aria-hidden="true">
      <svg viewBox="0 0 76 76">
        <circle cx="38" cy="38" r="30" fill="rgb(255 255 255 / 0.35)" stroke="#14213d" strokeWidth="4" />
        <circle ref={ringRef} cx="38" cy="38" r="30" fill="none" stroke="#ffc531" strokeWidth="9" strokeLinecap="round" transform="rotate(-90 38 38)" strokeDasharray={`0 ${RING}`} />
        <circle cx="38" cy="38" r="7" fill="#14213d" />
      </svg>
    </div>
  );
}
