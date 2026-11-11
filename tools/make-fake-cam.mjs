// 把一张照片做成 Chrome 的"假摄像头"素材：
//   照片 → 1280×720 的基线 JPEG（Chrome 的假摄像头不认渐进式 JPEG）→ 重复若干帧拼成 MJPEG 文件
// 用法：node tools/make-fake-cam.mjs <照片.jpg> <输出.mjpeg> [帧数=30]
// 之后用 --use-file-for-fake-video-capture=<输出.mjpeg> 启动 Chrome，页面打开摄像头看到的就是这张照片。
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { launchChrome } from './cdp.mjs';

/**
 * @param {string} photo 照片路径（JPEG / PNG 均可）
 * @param {string} out   输出的 .mjpeg 路径
 * @param {{ frames?: number, w?: number, h?: number }} opts
 */
export async function makeFakeCam(photo, out, opts = {}) {
  const { frames = 30, w = 1280, h = 720 } = opts;
  const dataUrl = `data:image/jpeg;base64,${readFileSync(photo).toString('base64')}`;
  const page = await launchChrome();
  try {
    // 借浏览器的画布重新编码：按"完整放进画面"的方式缩放，四周补灰
    const jpeg = await page.evaluate(`(async () => {
      const img = new Image();
      img.src = ${JSON.stringify(dataUrl)};
      await img.decode();
      const c = document.createElement('canvas');
      c.width = ${w}; c.height = ${h};
      const g = c.getContext('2d');
      g.fillStyle = '#7f8a93';
      g.fillRect(0, 0, c.width, c.height);
      const k = Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight);
      g.drawImage(img, (c.width - img.naturalWidth * k) / 2, (c.height - img.naturalHeight * k) / 2, img.naturalWidth * k, img.naturalHeight * k);
      return c.toDataURL('image/jpeg', 0.92);
    })()`);
    const frame = Buffer.from(jpeg.slice(jpeg.indexOf(',') + 1), 'base64');
    writeFileSync(out, Buffer.concat(Array.from({ length: frames }, () => frame)));
    return { bytes: frame.length * frames, frames };
  } finally {
    await page.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [photo, out, frames] = process.argv.slice(2);
  if (!photo || !out) {
    console.error('用法：node tools/make-fake-cam.mjs <照片.jpg> <输出.mjpeg> [帧数]');
    process.exit(2);
  }
  const r = await makeFakeCam(photo, out, { frames: Number(frames) || 30 });
  console.log(`已生成 ${out}：${r.frames} 帧，${r.bytes} 字节`);
}
