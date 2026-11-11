import { Sfx } from '../engine/audio/sfx';

/** 全站共用一个音效实例。 */
export const sfx = new Sfx();

/** 浏览器要求用户先操作过页面才能出声：第一次点击或按键时把音频唤醒。 */
export function armAudio(): void {
  const wake = (): void => {
    sfx.resume();
    window.removeEventListener('pointerdown', wake);
    window.removeEventListener('keydown', wake);
  };
  window.addEventListener('pointerdown', wake);
  window.addEventListener('keydown', wake);
  // 端到端测试里浏览器允许自动播放，直接试一次也无妨
  sfx.resume();
}
