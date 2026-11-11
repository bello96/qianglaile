import type { ComponentType, LazyExoticComponent } from 'react';
import type { Flags } from '../app/router';
import type { Settings } from '../app/settings';
import type { Engine } from '../app/useEngine';

/**
 * 一个游戏对外的全部接口。想加新游戏：
 *   1. 在 src/games/<名字>/ 下写一个 React 组件，接收 GameProps；
 *   2. 在 src/games/index.ts 的 GAMES 里登记一行。
 * 组件拿到的 engine 里有玩家追踪器（engine.tracker）：每帧读 tracker.state 就是玩家的身体和动作，
 * 完全不用碰摄像头和识别库。最简单的例子见 src/games/bubbles/。
 */
export interface GameProps {
  engine: Engine;
  settings: Settings;
  /** 地址栏里的开发开关（模拟玩家、固定种子等） */
  flags: Flags;
  /** 玩家要回首页 */
  onExit(): void;
  /** 打开设置面板（面板本身由外壳提供，游戏只管在合适的地方放个按钮，并在打开前把自己暂停） */
  onSettings(): void;
}

export interface GameModule {
  /** 地址里用的名字：#/play/<id> */
  id: string;
  name: string;
  blurb: string;
  Component: LazyExoticComponent<ComponentType<GameProps>>;
}
