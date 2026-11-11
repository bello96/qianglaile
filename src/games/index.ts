import { lazy } from 'react';
import { BRAND } from '../brand';
import type { GameModule } from './types';

/**
 * 游戏登记表。每个游戏的代码是按需加载的：进哪个游戏才下载哪个游戏的代码。
 * 加新游戏就在这里加一行（见 types.ts 里的说明）。
 */
export const GAMES: GameModule[] = [
  {
    id: 'wall',
    name: BRAND.wallGame,
    blurb: '墙来之前摆好姿势，从洞里穿过去。',
    Component: lazy(() => import('./wall/WallPlay')),
  },
  {
    id: 'bubbles',
    name: '戳泡泡',
    blurb: '泡泡往上飘，伸手戳破它。照着它就能写出自己的新游戏。',
    Component: lazy(() => import('./bubbles')),
  },
];

export const findGame = (id: string): GameModule | undefined => GAMES.find((g) => g.id === id);
