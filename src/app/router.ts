import { useSyncExternalStore } from 'react';

/** 只有三四个页面，用地址栏的 # 部分做路由就够了，不需要路由库。 */
export type Route = { page: 'home' } | { page: 'play'; game: string } | { page: 'lab' };

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#/, '').split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'play' && parts[1]) return { page: 'play', game: parts[1] };
  if (parts[0] === 'lab' && parts.length === 1) return { page: 'lab' };
  return { page: 'home' };
}

/** 页面的地址。query 是要一起带过去的开关（见下面的 Flags），比如 { only: 'my-abc' }。 */
export function routeHref(r: Route, query: Record<string, string> = {}): string {
  const path = r.page === 'play' ? `#/play/${r.game}` : r.page === 'lab' ? '#/lab' : '#/';
  const q = new URLSearchParams(query).toString();
  return q ? `${path}?${q}` : path;
}

export function navigate(r: Route, query?: Record<string, string>): void {
  window.location.hash = routeHref(r, query).slice(1);
}

const subscribeHash = (cb: () => void): (() => void) => {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
};

export function useRoute(): Route {
  // 用字符串当快照，路由对象现算，避免每次渲染都产生新对象引发死循环
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  return parseRoute(hash);
}

/**
 * 开发和测试用的开关，写在地址里：
 *   sim=auto   模拟玩家自动照着墙摆（演示 / 端到端测试）
 *   sim=wrong  模拟玩家一直站着（用来看撞墙和结算）
 *   sim=manual 模拟玩家站着不动，由页面上的按钮切换姿势
 *   seed=7     固定出墙顺序
 *   fast=1     墙速加快（测试不用干等）
 *   debug=1    显示调试信息
 *   e2e=1      把内部状态挂到 window.__mw 供测试脚本读取
 *   worker=0   识别不放进 Worker，留在主线程（对比性能、排查问题用）
 *   only=<id>  只出这一面墙，反复练（姿势实验室的"试试这面墙"用的就是它）
 */
export interface Flags {
  sim: 'off' | 'auto' | 'wrong' | 'manual';
  seed: number | null;
  debug: boolean;
  e2e: boolean;
  fast: boolean;
  worker: boolean;
  /** 只出这一面墙（一个人形姿势的 id，内置的或自己存的；几何洞不行）；null 表示正常闯关 */
  only: string | null;
}

/** 墙的 id 长什么样：字母数字开头，后面可以有连字符和 ~，最多 40 个字符 */
const WALL_ID = /^[a-z0-9][a-z0-9~-]{0,39}$/i;

/** 传入 location.search，或者带查询串的 hash（'#/play/wall?sim=auto'）。 */
export function readFlags(input: string): Flags {
  const q = new URLSearchParams(input.includes('?') ? input.slice(input.indexOf('?') + 1) : '');
  const on = (key: string): boolean => q.get(key) === '1' || q.get(key) === 'true';
  const sim = q.get('sim');
  const seed = Number.parseInt(q.get('seed') ?? '', 10);
  const only = q.get('only') ?? '';
  return {
    sim: sim === 'auto' || sim === '1' ? 'auto' : sim === 'wrong' || sim === 'manual' ? sim : 'off',
    seed: Number.isFinite(seed) ? seed : null,
    debug: on('debug'),
    e2e: on('e2e'),
    fast: on('fast'),
    worker: q.get('worker') !== '0' && q.get('worker') !== 'false',
    only: WALL_ID.test(only) ? only : null,
  };
}

/** 当前地址里的开关：查询串可以在 # 前面，也可以在 # 后面。 */
export function currentFlags(): Flags {
  const { search, hash } = window.location;
  const fromHash = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  return readFlags(`?${[search.replace(/^\?/, ''), fromHash].filter(Boolean).join('&')}`);
}
