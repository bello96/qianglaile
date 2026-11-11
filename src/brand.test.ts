import { expect, it } from 'vitest';
import { BRAND } from './brand';

it('uses the agreed names and none of the banned ones', () => {
  expect(BRAND.wallGame).toBe('别撞墙！');
  expect(BRAND.studio).toBe('体感工坊');
  expect(JSON.stringify(BRAND)).not.toMatch(/墙来了|动动乐园/);
});
