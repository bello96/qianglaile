// 端到端检查：把应用构建出来，起一个本地服务器，用无头 Chrome 把主要流程真的走一遍。
// 不需要真摄像头，也不需要真人：用模拟玩家，或者把一张照片当作"假摄像头"喂给 Chrome。
//
//   npm run e2e                  全部场景
//   npm run e2e -- lab bubbles   只跑名字里含这些词的场景
//   npm run e2e -- --no-build    不重新构建，直接用现有的 dist/
//
// 每个场景的截图存到 e2e-out/<场景名>.png。任何一个场景没过，退出码就不是 0。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';
import { makeFakeCam } from './make-fake-cam.mjs';
import { backupFile, restoreFile } from './fileBackup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'e2e-out');
const PHOTO = path.join(ROOT, 'tests/fixtures/photos/pose.jpg');
const FAKE_CAM = path.join(OUT, 'pose.mjpeg');
const WALLS_FILE = path.join(ROOT, 'public/custom-poses.json');
/** dev-save 场景会改上面这个文件；改之前把它原样存到这里（见 tools/fileBackup.mjs） */
const WALLS_BACKUP = path.join(OUT, 'custom-poses.before-e2e');

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const only = args.filter((a) => !a.startsWith('--'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 条件不成立就让这个场景失败。 */
function expect(ok, message) {
  if (!ok) throw new Error(message);
}

/** 页面上按钮的文字（用来判断"出现了某个按钮"）和点击它。 */
const BUTTON = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
const GAME = 'window.__mw?.game?.state';
const ANGLES = `Object.fromEntries([...document.querySelectorAll('.angles tbody tr')].map((tr) => [tr.children[0].textContent, parseFloat(tr.children[1].textContent)]))`;
/** 像真人那样往输入框里填字（React 监听的是 input 事件）。 */
const FILL = (selector, value) =>
  `(() => { const el = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

/** 设置面板里某一项的某个选项按钮。 */
const SETTING = (label, option) =>
  `[...([...document.querySelectorAll('[role="dialog"] .field')].find((f) => f.firstElementChild?.textContent === ${JSON.stringify(label)})?.querySelectorAll('.seg button') ?? [])].find((b) => b.textContent.trim() === ${JSON.stringify(option)})`;
/** 一个 3D 场景（挂在 window.__mw 上的名字）是不是还活着、还在一帧帧地画。 */
const DRAWING = (name) => `(() => { const s = window.__mw.${name}; const a = s.frames; return new Promise((done) => setTimeout(() => done({ alive: s.alive, drew: s.frames - a }), 500)); })()`;

/**
 * 每个页面一打开就先装上：数一数页面向浏览器要了几次摄像头。
 * "这一页不该开摄像头"只能这么查——看页面自己挂出来的对象是查不出来的（它没开摄像头时那个对象本来就不存在）。
 */
const COUNT_CAMERA_REQUESTS = `(() => {
  window.__cameraRequests = 0;
  const devices = navigator.mediaDevices;
  if (!devices?.getUserMedia) return;
  const real = devices.getUserMedia.bind(devices);
  devices.getUserMedia = (...args) => { window.__cameraRequests++; return real(...args); };
})()`;
/** 截住页面要"下载"的内容，放到 window.__downloaded（文件本身不落盘，见 cdp.mjs）。 */
const CAPTURE_DOWNLOADS = `(() => { window.__downloaded = null; const make = URL.createObjectURL; URL.createObjectURL = (blob) => { blob.text().then((t) => (window.__downloaded = t)); return make.call(URL, blob); }; })()`;

/** 控制台里算"出错"的输出。识别库自己会打几行警告，那些不算。 */
const consoleErrors = (page) => page.logs.filter((l) => l.level === 'error' || l.level === 'exception').map((l) => l.text);

/**
 * 场景表。每个场景拿到 base（服务器地址）和 open（打开一个浏览器页面，用完自动关）。
 * chrome：这个场景需要的浏览器设置——fakeVideo 用照片当摄像头，denyCamera 拒绝摄像头授权。
 */
const SCENARIOS = [
  {
    name: 'home',
    about: '首页能打开',
    async run({ base, page }) {
      await page.goto(`${base}/?e2e=1#/`);
      expect(await page.waitFor(`document.title.includes('体感工坊') && ${BUTTON('开始闯关')}`, 15000), '首页没有出现标题或"开始闯关"按钮');
      expect(await page.evaluate(`!!${BUTTON('戳泡泡')} && !!${BUTTON('姿势实验室')}`), '首页缺少"戳泡泡"或"姿势实验室"的入口');

      // 背景里的自动演示：模拟玩家自己在闯关（不开摄像头）
      expect(await page.waitFor(`window.__mw?.attractSession?.game?.state.wallIndex >= 1`, 25000), '首页背景的自动演示没有跑起来');
      const demo = await page.evaluate(DRAWING('attract'));
      expect(demo.alive && demo.drew > 5, `首页的演示场景没在画：${JSON.stringify(demo)}`);
      expect((await page.evaluate(`window.__cameraRequests`)) === 0, '首页不该打开摄像头');
      await page.waitFor(`window.__mw.attractSession.game.state.progress > 0.6`, 15000);
      await page.screenshot(path.join(OUT, 'home-demo.png'));

      // 地址里写了一个不存在的游戏：说清楚，而且不要为它打开摄像头
      await page.goto(`${base}/#/play/no-such-game?e2e=1`);
      expect(await page.waitFor(`document.body.textContent.includes('没有这个游戏')`, 10000), '不存在的游戏没有给出说明');
      await sleep(2500);
      expect((await page.evaluate(`window.__cameraRequests`)) === 0, '为一个不存在的游戏打开了摄像头');
    },
  },
  {
    name: 'sim-pass',
    about: '模拟玩家照着墙摆，连过六面墙不掉命',
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?sim=auto&seed=7&fast=1&e2e=1`);
      expect(await page.waitFor(`${GAME}?.wallIndex >= 6`, 60000), `60 秒内没有到第 6 面墙：${JSON.stringify(await page.evaluate(`(({ phase, wallIndex, lives }) => ({ phase, wallIndex, lives }))(${GAME} ?? {})`))}`);
      const lives = await page.evaluate(`${GAME}.lives`);
      expect(lives === 3, `摆对了却掉了命：还剩 ${lives} 条`);
    },
  },
  {
    name: 'sim-fail',
    about: '模拟玩家一直站着，撞三次后结算',
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?sim=wrong&fast=1&e2e=1`);
      expect(await page.waitFor(`${GAME}?.phase === 'over' && ${BUTTON('再来一次')}`, 60000), '60 秒内没有出现结算和"再来一次"');
      expect((await page.evaluate(`${GAME}.lives`)) === 0, '结算时命数不是 0');
    },
  },
  {
    name: 'lab-cam',
    about: '假摄像头（一张平举双臂的照片）→ 实验室量出的上臂角度接近 90°',
    chrome: { fakeVideo: FAKE_CAM },
    async run({ base, page }) {
      await page.goto(`${base}/#/lab?e2e=1`);
      expect(await page.waitFor(`window.__mw?.tracker?.state.present && document.querySelector('.angles')`, 60000), '60 秒内没有识别到照片里的人');
      await sleep(1500);
      const a = await page.evaluate(ANGLES);
      expect(Math.abs(a['左上臂'] - 90) <= 25 && Math.abs(a['右上臂'] - 90) <= 25, `上臂角度不在 90±25：${JSON.stringify(a)}`);
      const status = await page.evaluate(`document.querySelector('.debug')?.textContent ?? ''`);
      expect(status.includes('Worker'), `识别没有跑在 Worker 里：${status.replace(/\s+/g, ' ')}`);
      // 首页那条"没开摄像头"靠的是这个计数；在真开了摄像头的页面上它得是正数，才说明它数得出来
      const asked = await page.evaluate(`window.__cameraRequests`);
      expect(asked >= 1, `实验室开了摄像头，计数却是 ${asked}：数摄像头请求的办法失灵了`);
    },
  },
  {
    name: 'lab-walls',
    about: '实验室：图鉴画出全部的墙；存一面新墙（静态站点存进浏览器）、刷新后还在、试玩、删除',
    async run({ base, page }) {
      await page.goto(`${base}/#/lab?sim=auto&e2e=1`);
      expect(await page.waitFor(`window.__mw?.tracker?.state.present && document.querySelector('.save-row input')`, 20000), '实验室的实时页没有就绪');
      await page.evaluate(FILL('.save-row input', '自动检查的墙'));
      await mouseClick(page, BUTTON('5 秒后存'), '"5 秒后存"按钮');
      expect(await page.waitFor(`document.querySelector('.note')?.textContent.includes('存在这个浏览器里')`, 12000), `没有提示存好了：${await page.evaluate(`document.querySelector('.note')?.textContent`)}`);

      // 刷新后从浏览器存储里读回来
      await page.goto(`${base}/#/lab?sim=auto&e2e=1`);
      await page.waitFor(`document.querySelector('[data-tab="gallery"]')`, 10000);
      await mouseClick(page, `document.querySelector('[data-tab="gallery"]')`, '"gallery"页签');
      expect(await page.waitFor(`document.querySelectorAll('.card').length === 30`, 10000), `图鉴应有 30 面墙（1 + 24 + 5），实际 ${await page.evaluate(`document.querySelectorAll('.card').length`)}`);
      const painted = await page.evaluate(`[...document.querySelectorAll('.card canvas')].filter((c) => c.getContext('2d').getImageData(150, 20, 1, 1).data[3] === 255).length`);
      expect(painted === 30, `只有 ${painted} 张缩略图画出来了`);
      const id = await page.evaluate(`document.querySelector('.card[data-wall^="my-"]')?.dataset.wall`);
      expect(id, '图鉴里没有刚存的那面墙');
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 2500, deviceScaleFactor: 1, mobile: false });
      await sleep(300);
      await page.screenshot(path.join(OUT, 'lab-gallery.png'));
      await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

      // 试玩：只出这一面墙
      await page.goto(`${base}/#/play/wall?only=${id}&sim=auto&fast=1&seed=3&e2e=1`);
      expect(await page.waitFor(`${GAME}?.wallIndex >= 3`, 40000), '试玩没有开局');
      const wall = await page.evaluate(`${GAME}.wall?.spec.pose?.id ?? ''`);
      expect(wall.replace(/~m$/, '') === id, `试玩时出的不是这面墙，而是 ${wall}`);

      // 删除（要点两下）
      await page.goto(`${base}/#/lab?sim=auto&e2e=1`);
      await page.waitFor(`document.querySelector('[data-tab="gallery"]')`, 10000);
      await mouseClick(page, `document.querySelector('[data-tab="gallery"]')`, '"gallery"页签');
      await page.waitFor(`document.querySelector('[data-wall="${id}"]')`, 10000);
      const inCard = (text) => `[...document.querySelector('[data-wall="${id}"]').querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
      await mouseClick(page, inCard('删除'), '卡片上的"删除"按钮');
      await sleep(200);
      await mouseClick(page, inCard('真的删掉'), '卡片上的"真的删掉"按钮');
      expect(await page.waitFor(`!document.querySelector('[data-wall="${id}"]') && localStorage.getItem('mw.customPoses') === '[]'`, 5000), '删除后这面墙还在');
    },
  },
  {
    name: 'bubbles',
    about: '示例小游戏能跑起来，挥手的模拟玩家戳得到泡泡',
    async run({ base, page }) {
      await page.goto(`${base}/#/play/bubbles?sim=auto&seed=5&e2e=1`);
      expect(await page.waitFor(`window.__mw?.bubbles?.state.bubbles.length >= 3`, 20000), '20 秒内没有冒出泡泡');
      const c = await page.evaluate(`(() => { const c = document.querySelector('canvas'); return { w: c.width, h: c.height }; })()`);
      expect(c.w > 300 && Math.abs(c.w / c.h - 16 / 9) < 0.02, `画布尺寸不对：${JSON.stringify(c)}`);
      expect(await page.waitFor(`window.__mw.bubbles.state.score >= 1`, 30000), '30 秒里一个泡泡也没戳破');
    },
  },
  {
    name: 'lab-tools',
    about: '实验室：录一段动作再回放；把墙导出成文件、再导入回来',
    async run({ base, page }) {
      await page.goto(`${base}/#/lab?sim=auto&e2e=1`);
      expect(await page.waitFor(`window.__mw?.tracker?.state.present && document.querySelector('[data-tab="record"]')`, 20000), '实验室没有就绪');

      // ---- 录制与回放 ----
      await mouseClick(page, `document.querySelector('[data-tab="record"]')`, '"record"页签');
      await page.waitFor(BUTTON('开始录制'), 5000);
      await mouseClick(page, BUTTON('开始录制'), '"开始录制"按钮');
      await sleep(1500);
      await mouseClick(page, BUTTON('停止'), '"停止"按钮');
      await sleep(300);
      const frames = await page.evaluate(`Number(document.querySelector('[data-frames]').dataset.frames)`);
      expect(frames > 20, `1.5 秒只录到 ${frames} 帧`);
      await mouseClick(page, BUTTON('回放这一段'), '"回放这一段"按钮');
      await sleep(900);
      expect(await page.evaluate(`document.querySelector('.lab__tag')?.textContent.includes('正在回放')`), '回放时画面上没有"正在回放"的标签');
      // 回放的骨架是黄色的：数一数画面里有多少黄色像素
      const yellow = await page.evaluate(`(() => { const c = document.querySelector('.lab__view canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 160 && d[i + 2] < 90) n++; return n; })()`);
      expect(yellow > 500, `回放没有画出骨架（只有 ${yellow} 个黄色像素）`);

      // ---- 导入与导出 ----
      const wall = (id, name, a) => ({ id, name, armL: [{ a }, { a }], armR: [{ a: 30 }, { a: 20 }], legL: [{ a: 4 }, { a: 0 }], legR: [{ a: 4 }, { a: 0 }] });
      const fileText = JSON.stringify([wall('my-io1', '导入一号', 100), { junk: true }, wall('my-io2', '导入二号', 150)]);
      await mouseClick(page, `document.querySelector('[data-tab="gallery"]')`, '"gallery"页签');
      await page.waitFor(`document.querySelector('input[aria-label="选择导出的墙文件"]')`, 5000);
      expect(await page.evaluate(`${BUTTON('导出成文件')}.disabled`), '一面自己的墙都没有时，"导出成文件"应该是灰的');
      // 像真人选文件那样，把一个文件交给那个（看不见的）文件选择框
      await page.evaluate(`(() => {
        const input = document.querySelector('input[aria-label="选择导出的墙文件"]');
        const dt = new DataTransfer();
        dt.items.add(new File([${JSON.stringify(fileText)}], 'custom-poses.json', { type: 'application/json' }));
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      expect(await page.waitFor(`document.querySelector('.gallery__message')?.textContent.includes('导入了 2 面墙')`, 6000), `导入后的提示不对：${await page.evaluate(`document.querySelector('.gallery__message')?.textContent`)}`);
      expect(await page.waitFor(`document.querySelectorAll('.card[data-wall^="my-io"]').length === 2`, 4000), '导入的两面墙没有出现在图鉴里');
      // 导出：截住浏览器要下载的那份内容，看它能不能原样读回来
      await page.evaluate(CAPTURE_DOWNLOADS);
      await mouseClick(page, BUTTON('导出成文件'), '"导出成文件"按钮');
      expect(await page.waitFor('window.__downloaded', 4000), '点了导出却没有生成文件');
      const exported = JSON.parse(await page.evaluate('window.__downloaded'));
      expect(exported.length === 2 && exported[0].name === '导入一号' && exported[1].id === 'my-io2', `导出的内容不对：${JSON.stringify(exported).slice(0, 200)}`);
    },
  },
  {
    name: 'denied',
    about: '拒绝摄像头授权 → 出现说明和出路 → 点"用演示模式看看"能玩',
    chrome: { denyCamera: true },
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?e2e=1`);
      expect(await page.waitFor(`document.querySelector('[role="alert"]') && ${BUTTON('用演示模式看看')}`, 30000), '没有出现错误说明和"用演示模式看看"按钮');
      const title = await page.evaluate(`document.querySelector('[role="alert"] h2').textContent`);
      expect(/摄像头/.test(title), `错误说明没有提到摄像头：${title}`);
      await page.screenshot(path.join(OUT, 'denied-card.png'));
      await mouseClick(page, BUTTON('用演示模式看看'), '"用演示模式看看"按钮');
      expect(await page.waitFor(`${GAME}?.wallIndex >= 1`, 30000), '点了演示模式之后游戏没有开始');
    },
  },
  {
    name: 'scene-churn',
    about: '反复进出游戏 20 次：显卡上下文不堆积，最后一次的 3D 画面照常在画',
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?sim=auto&fast=1&e2e=1`);
      expect(await page.waitFor(`${GAME}?.wallIndex >= 1`, 30000), '游戏没有开始');

      // 离开游戏页：刚才那个场景的 3D 上下文应该马上还给浏览器，而不是等垃圾回收哪天想起来
      await page.evaluate(`void (window.__old = window.__mw.scene, location.hash = '/')`);
      await sleep(400);
      expect((await page.evaluate(`window.__old.alive`)) === false, '离开游戏页之后，旧场景的 3D 上下文还占着');
      await page.evaluate(`void (location.hash = '/play/wall?sim=auto&fast=1&e2e=1')`);
      await sleep(400);

      for (let i = 0; i < 20; i++) {
        await page.evaluate(`void (location.hash = '/')`);
        await sleep(300);
        await page.evaluate(`void (location.hash = '/play/wall?sim=auto&fast=1&e2e=1')`);
        await sleep(400);
      }
      const start = await page.evaluate(`${GAME}?.wallIndex ?? 0`);
      expect(await page.waitFor(`${GAME}?.wallIndex > ${start}`, 30000), '反复进出之后游戏不再往下走');
      // 浏览器同时能开的 3D 上下文有限（Chrome 是 16 个），超了它会把最早的那个作废，并在控制台里说一声
      const complaints = page.logs.filter((l) => /too many active webgl contexts|context lost/i.test(l.text));
      expect(complaints.length === 0, `浏览器抱怨 3D 上下文太多：${complaints[0]?.text}`);
      const scene = await page.evaluate(DRAWING('scene'));
      expect(scene.alive && scene.drew > 5, `最后这个场景没在画：${JSON.stringify(scene)}`);
    },
  },
  {
    name: 'crash',
    about: '每帧循环里的代码出了错：页面换成出错卡片、旧场景收掉，而不是画面僵住、同一个错每秒抛六十次',
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?sim=auto&fast=1&e2e=1`);
      expect(await page.waitFor(`${GAME}?.wallIndex >= 1`, 30000), '游戏没有开始');
      // 故意把游戏规则的"每帧更新"弄坏
      await page.evaluate(`void (window.__old = window.__mw.scene, window.__mw.game.update = () => { throw new Error('故意弄坏的'); })`);
      expect(await page.waitFor(`document.querySelector('[role="alert"] h2')?.textContent.includes('页面出错了')`, 5000), '循环里出了错，页面没有换成出错卡片');
      expect(await page.evaluate(`document.querySelector('[role="alert"]').textContent.includes('故意弄坏的')`), '出错卡片上没有写是什么错');
      expect((await page.evaluate(`window.__old.alive`)) === false, '出错之后，旧的 3D 场景没有收掉');
      await sleep(1000);
      const thrown = page.logs.filter((l) => l.text.includes('故意弄坏的')).length;
      expect(thrown <= 4, `同一个错在控制台里出现了 ${thrown} 次：循环没有停下来`);
      page.logs.length = 0; // 上面这些报错是这个场景故意弄出来的，不算毛病
    },
  },
  {
    name: 'settings',
    about: '游戏中打开设置、换识别模型：引擎重启 → 关掉设置后停在暂停面板 → 点"继续"重新站位 → 同一局接着玩（命还在）；Esc 只关面板；开"同时识别两个人"也一样生效',
    chrome: { fakeVideo: FAKE_CAM },
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?e2e=1`);
      expect(await page.waitFor(`${GAME}?.wallIndex >= 1 && ${BUTTON('设置')}`, 60000), '游戏没有开始，或者界面上没有"设置"按钮');
      const before = await page.evaluate(`(() => { const g = window.__mw.game; g.__mark = 'same round'; return { lives: g.state.lives, wall: g.state.wallIndex, model: window.__mw.source.stats().model }; })()`);

      await mouseClick(page, BUTTON('设置'), '"设置"按钮');
      expect(await page.waitFor(`document.querySelector('[role="dialog"]')`, 3000), '用鼠标点"设置"没有出现设置面板');
      // 屏幕矮、选项多的时候面板要滚动；"好了"得一直看得见，不用滚到底才找得到
      const done = await page.evaluate(`(() => { const r = ${BUTTON('好了')}.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
      expect(done, '设置面板一打开，"好了"按钮不在看得见的地方');
      await page.screenshot(path.join(OUT, 'settings-dialog.png'));
      const frozenAt = await page.evaluate(`${GAME}.progress`);
      await sleep(800);
      expect((await page.evaluate(`${GAME}.progress`)) === frozenAt, '设置面板开着的时候，墙还在往前走');

      // 换一个识别模型：引擎要重启
      const [label, want] = before.model === 'lite' ? ['标准', 'full'] : ['轻量', 'lite'];
      await mouseClick(page, SETTING('识别模型', label), `识别模型的"${label}"选项`);
      expect(await page.waitFor(`window.__mw.source?.stats().model === '${want}' && window.__mw.tracker.state.present`, 60000), '换了识别模型之后，引擎没有用新模型重新就绪');

      // 面板还开着：人在电脑前调设置，不在他的站位上。这时不能因为"画面里有个人站着没动"就自己重新标定了——
      // 照片里的人一直站着不动，等上比站位引导要的时间更久，看它有没有偷偷标定
      await sleep(3000);
      expect(!(await page.evaluate(`!!document.querySelector('.framing')`)), '设置面板还开着，底下就已经在做站位引导了');
      await mouseClick(page, BUTTON('好了'), '"好了"按钮');

      // 关掉面板：停在暂停面板上，等人点"继续"
      expect(await page.waitFor(BUTTON('继续'), 5000), '关掉设置之后没有停在暂停面板上');
      expect(await page.evaluate(`document.querySelector('.panel').textContent.includes('重新启动')`), '暂停面板上没有说明：识别重新启动过，点"继续"后要重新站位');
      await page.screenshot(path.join(OUT, 'settings-resumed.png'));
      await mouseClick(page, BUTTON('继续'), '"继续"按钮');
      // 点了"继续"才重新站位（引擎重启过，原来的标定作废了），过了之后接着同一局
      expect(await page.waitFor(`document.querySelector('.framing')`, 5000), '引擎重启之后点"继续"，没有重新做站位引导');
      expect(await page.waitFor(`${GAME}.wallIndex > ${before.wall}`, 40000), '重新站位之后没有接着出墙');
      const after = await page.evaluate(`({ mark: window.__mw.game.__mark, lives: window.__mw.game.state.lives })`);
      expect(after.mark === 'same round', '换模型之后变成了新的一局，原来那局丢了');
      expect(after.lives === before.lives, `命数变了：${before.lives} → ${after.lives}`);

      // 设置面板开着时按 Esc：只关面板。游戏是为了开设置才停下的，不能被同一下按键又放开
      await mouseClick(page, BUTTON('设置'), '"设置"按钮');
      expect(await page.waitFor(`document.querySelector('[role="dialog"]')`, 3000), '游戏中点"设置"没有出现设置面板');
      await page.key('Escape');
      expect(await page.waitFor(`!document.querySelector('[role="dialog"]')`, 3000), '按 Esc 没有关掉设置面板');
      await sleep(300);
      const held = await page.evaluate(`${GAME}.progress`);
      await sleep(700);
      expect(await page.evaluate(`!!${BUTTON('继续')}`), '按 Esc 关设置面板时，游戏也跟着取消了暂停');
      expect((await page.evaluate(`${GAME}.progress`)) === held, '按 Esc 关掉设置面板之后，墙又开始往前走了');
      // 面板关了之后，Esc 才是"暂停 / 继续"
      await page.key('Escape');
      expect(await page.waitFor(`!${BUTTON('继续')}`, 3000), '没有面板挡着的时候，按 Esc 应当继续游戏');

      // 再从暂停面板进设置，打开"同时识别两个人"
      await mouseClick(page, BUTTON('暂停'), '"暂停"按钮');
      expect(await page.waitFor(BUTTON('继续'), 3000), '用鼠标点"暂停"没有反应');
      const inPanel = `[...document.querySelectorAll('.panel button')].find((b) => b.textContent.trim() === '设置')`;
      expect(await page.evaluate(`!!${inPanel}`), '暂停面板上没有"设置"按钮');
      await mouseClick(page, inPanel, '暂停面板上的"设置"按钮');
      expect(await page.waitFor(`document.querySelector('[role="dialog"]')`, 3000), '暂停面板上的"设置"点了没反应');
      await mouseClick(page, SETTING('同时识别两个人', '开'), '"同时识别两个人"的开关');
      expect(await page.waitFor(`window.__mw.source?.stats().people === 2 && window.__mw.tracker.state.present`, 60000), '打开"同时识别两个人"之后，引擎没有按两个人重新就绪');
    },
  },
  {
    name: 'lab-replay',
    about: '用一段录制代替摄像头：引擎改吃录制（摄像头关掉），实验室照常出角度；再换回摄像头',
    chrome: { fakeVideo: FAKE_CAM },
    async run({ base, page }) {
      await page.goto(`${base}/#/lab?e2e=1`);
      expect(await page.waitFor(`window.__mw?.tracker?.state.present && document.querySelector('[data-tab="record"]')`, 60000), '实验室没有就绪');
      await mouseClick(page, `document.querySelector('[data-tab="record"]')`, '"record"页签');
      await page.waitFor(BUTTON('开始录制'), 5000);
      await mouseClick(page, BUTTON('开始录制'), '"开始录制"按钮');
      await sleep(1500);
      await mouseClick(page, BUTTON('停止'), '"停止"按钮');
      await page.waitFor(BUTTON('用这段代替摄像头'), 3000);

      // 记下摄像头的那条视频轨道：等会儿要看它是不是真的被关掉了（灯灭了）
      expect((await page.evaluate(`(window.__camTrack = window.__mw.source.video.srcObject.getVideoTracks()[0]).readyState`)) === 'live', '摄像头的视频轨道一开始就不是开着的');
      const recorded = await page.evaluate(`Number(document.querySelector('[data-frames]').dataset.frames)`);

      await mouseClick(page, BUTTON('用这段代替摄像头'), '"用这段代替摄像头"按钮');
      expect(await page.waitFor(`window.__mw.source?.kind === 'replay' && window.__mw.tracker.state.present`, 15000), '点了之后引擎没有改用这段录制');
      expect((await page.evaluate(`window.__camTrack.readyState`)) === 'ended', '改用录制之后摄像头应该关掉');
      expect(await page.evaluate(`!!document.querySelector('.replay-notice')`), '页面上没有"正在用录制代替摄像头"的提示');

      // 刚录的这一段还没下载过，只在内存里。引擎重启不能把它弄丢：还得下载得了，内容还是那一段
      expect(await page.waitFor(BUTTON('下载 JSON'), 5000), '改用录制之后，刚录的那一段没法下载了');
      await page.evaluate(CAPTURE_DOWNLOADS);
      await mouseClick(page, BUTTON('下载 JSON'), '"下载 JSON"按钮');
      expect(await page.waitFor('window.__downloaded', 4000), '点了"下载 JSON"却没有生成文件');
      const kept = JSON.parse(await page.evaluate('window.__downloaded'));
      expect(kept.frames?.length === recorded && recorded > 20, `下载到的不是刚录的那一段：录了 ${recorded} 帧，文件里有 ${kept.frames?.length} 帧`);
      // 正在顶替摄像头的那一段，在提示框里也能直接下载
      await page.evaluate(CAPTURE_DOWNLOADS);
      await mouseClick(page, BUTTON('下载这段录制'), '"下载这段录制"按钮');
      expect(await page.waitFor('window.__downloaded', 4000), '点了"下载这段录制"却没有生成文件');
      expect(JSON.parse(await page.evaluate('window.__downloaded')).frames?.length === recorded, '"下载这段录制"给的不是正在用的那一段');

      // "实时"页：角度是从录制里算出来的，应当和照片里的姿势一致（双臂平举）
      await mouseClick(page, `document.querySelector('[data-tab="live"]')`, '"live"页签');
      expect(await page.waitFor(`document.querySelector('.angles')`, 8000), '用录制时"实时"页没有出角度表');
      await sleep(800);
      const a = await page.evaluate(ANGLES);
      expect(Math.abs(a['左上臂'] - 90) <= 25 && Math.abs(a['右上臂'] - 90) <= 25, `录制里的上臂角度不对：${JSON.stringify(a)}`);

      await mouseClick(page, `document.querySelector('.replay-notice__off')`, '提示条上的"换回摄像头"');
      expect(await page.waitFor(`window.__mw.source?.kind === 'camera' && window.__mw.tracker.state.present`, 60000), '换回之后引擎没有回到摄像头');
      expect(await page.evaluate(`!document.querySelector('.replay-notice')`), '换回之后提示还在');
    },
  },
  {
    name: 'dev-cam',
    about: '开发服务器（npm run dev）下，识别同样跑在 Worker 里',
    // 开发服务器对 public/ 下的文件另有一套规矩，识别库的文件就放在那儿——这里出过只在开发模式下才有的问题
    server: 'dev',
    chrome: { fakeVideo: FAKE_CAM },
    async run({ base, page }) {
      await page.goto(`${base}/#/lab?e2e=1`);
      expect(await page.waitFor(`window.__mw?.tracker?.state.present && document.querySelector('.debug')`, 90000), '90 秒内没有识别到照片里的人');
      await sleep(1500);
      const status = await page.evaluate(`document.querySelector('.debug')?.textContent ?? ''`);
      expect(status.includes('Worker'), `识别没有跑在 Worker 里：${status.replace(/\s+/g, ' ')}`);
    },
  },
  {
    name: 'dev-play',
    about: '开发服务器下游戏照常能玩（开发模式下 React 会把每个组件挂载两遍，3D 场景得经得起）',
    server: 'dev',
    async run({ base, page }) {
      await page.goto(`${base}/#/play/wall?sim=auto&fast=1&e2e=1`);
      expect(await page.waitFor(`${GAME}?.wallIndex >= 3`, 90000), '开发服务器下游戏没有跑起来');
      const scene = await page.evaluate(DRAWING('scene'));
      expect(scene.alive && scene.drew > 5, `3D 场景没在画：${JSON.stringify(scene)}`);
      expect((await page.evaluate(`${GAME}.lives`)) === 3, '模拟玩家掉了命');
    },
  },
  {
    name: 'dev-save',
    about: '开发服务器下：存的墙写进 public/custom-poses.json，改名、删除跟着变；别的网站发来的、文件读不懂时的写入一律拒绝',
    server: 'dev',
    async run({ base, page }) {
      // 这个场景会真的改项目文件——里面可能有你自己存的墙。所以先原样备份**到磁盘上**，结束时（不管成不成）恢复；
      // 脚本要是中途被掐掉、来不及恢复，下次运行一开头会接着恢复（见 main 和 tools/fileBackup.mjs）
      const original = existsSync(WALLS_FILE);
      backupFile(WALLS_FILE, WALLS_BACKUP);
      const read = () => JSON.parse(readFileSync(WALLS_FILE, 'utf8'));
      const send = (url, method, body, headers = {}) => fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
      const ready = `window.__mw?.tracker?.state.present && document.querySelector('.save-row input')`;
      try {
        const before = original ? read().length : 0;
        await page.goto(`${base}/#/lab?sim=auto&e2e=1`);
        expect(await page.waitFor(ready, 60000), '实验室的实时页没有就绪');
        await settled(page); // 开发服务器头一回打开页面时可能会自己刷新一次，等它稳定下来
        expect(await page.waitFor(ready, 30000), '实验室的实时页没有就绪');

        await page.evaluate(FILL('.save-row input', '自动检查的墙'));
        await mouseClick(page, BUTTON('5 秒后存'), '"5 秒后存"按钮');
        expect(await page.waitFor(`document.querySelector('.note')?.textContent.includes('写进了项目文件')`, 15000), `没有提示写进了项目文件：${await page.evaluate(`document.querySelector('.note')?.textContent`)}`);
        const saved = read().find((p) => p.name === '自动检查的墙');
        expect(saved && read().length === before + 1, '项目文件里没有多出这面墙');

        // 改名（在图鉴里）。能找到"去图鉴看看"也说明：写文件没有让页面自己刷新
        await mouseClick(page, BUTTON('去图鉴看看'), '"去图鉴看看"按钮');
        const card = `document.querySelector('[data-wall="${saved.id}"]')`;
        expect(await page.waitFor(card, 5000), '图鉴里没有刚存的墙');
        const inCard = (text) => `[...${card}.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})`;
        await mouseClick(page, inCard('改名'), '卡片上的"改名"按钮');
        await sleep(200);
        await page.evaluate(FILL(`[data-wall="${saved.id}"] .card__rename`, '改过名的墙'));
        await page.evaluate(`${card}.querySelector('.card__rename').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
        expect(await until(() => read().find((p) => p.id === saved.id)?.name === '改过名的墙', 4000), '改名没有写回文件');

        // 别的网站发来的写入：拒绝，文件不变
        const hostile = await send('/__poses', 'POST', { ...saved, name: '不该写进来' }, { origin: 'https://example.org' });
        expect(hostile.status === 403 && read().find((p) => p.id === saved.id).name === '改过名的墙', `别的网站的写入没有被拒绝（状态 ${hostile.status}）`);

        // 文件被手改坏了（多了个逗号）：拒绝写入也拒绝删除，原样留着——不能当成空文件一把盖掉
        const intact = readFileSync(WALLS_FILE, 'utf8');
        const broken = intact.replace(/\]\s*$/, ',]');
        writeFileSync(WALLS_FILE, broken);
        const refused = await send('/__poses', 'POST', { ...saved, id: 'my-e2e-x', name: '坏文件时存的' });
        expect(refused.status === 409 && readFileSync(WALLS_FILE, 'utf8') === broken, `文件读不懂时没有拒绝写入（状态 ${refused.status}）`);
        const refusedDelete = await send(`/__poses/${saved.id}`, 'DELETE');
        expect(refusedDelete.status === 409 && readFileSync(WALLS_FILE, 'utf8') === broken, `文件读不懂时没有拒绝删除（状态 ${refusedDelete.status}）`);
        writeFileSync(WALLS_FILE, intact);

        // 两个存墙请求前后脚到：两面墙都得在。接口要是先读文件、再等请求体，后写的那个会把先写的盖掉
        const [first, second] = await Promise.all([
          slowPost(base, '/__poses', { ...saved, id: 'my-e2e-a', name: '同时存的甲' }, 400),
          slowPost(base, '/__poses', { ...saved, id: 'my-e2e-b', name: '同时存的乙' }, 400),
        ]);
        expect(first === 200 && second === 200, `同时发的两个存墙请求没有都成功（状态 ${first}、${second}）`);
        const ids = read().map((p) => p.id);
        expect(ids.includes('my-e2e-a') && ids.includes('my-e2e-b'), `两个存墙请求同时到，文件里只留下了一个：${ids.join('、')}`);
        await send('/__poses/my-e2e-a', 'DELETE');
        await send('/__poses/my-e2e-b', 'DELETE');

        // 删除（要点两下）
        await mouseClick(page, inCard('删除'), '卡片上的"删除"按钮');
        await sleep(200);
        await mouseClick(page, inCard('真的删掉'), '卡片上的"真的删掉"按钮');
        expect(await until(() => !read().some((p) => p.id === saved.id), 4000), '删除后文件里还有这面墙');

        // 文件读不懂的时候，人在页面上也得看得出来——不然墙像是凭空没了，新存的也不知去了哪
        const damaged = readFileSync(WALLS_FILE, 'utf8').replace(/\]\s*$/, ',]');
        writeFileSync(WALLS_FILE, damaged);
        await page.goto(`${base}/#/lab?sim=auto&e2e=1`);
        expect(await page.waitFor(ready, 60000), '实验室的实时页没有就绪');
        await mouseClick(page, `document.querySelector('[data-tab="gallery"]')`, '"gallery"页签');
        expect(await page.waitFor(`document.querySelector('.gallery__broken')`, 5000), '项目文件读不懂时，图鉴里没有说明');
        await page.screenshot(path.join(OUT, 'dev-save-broken-file.png'));
        await mouseClick(page, `document.querySelector('[data-tab="live"]')`, '"live"页签');
        expect(await page.waitFor(ready, 10000), '回到实时页之后没有就绪');
        await page.evaluate(FILL('.save-row input', '坏文件时存的墙'));
        await mouseClick(page, BUTTON('5 秒后存'), '"5 秒后存"按钮');
        expect(await page.waitFor(`document.querySelector('.note')?.textContent.includes('没能写进项目文件')`, 15000), `文件读不懂时存墙，页面上没有说它没进文件：${await page.evaluate(`document.querySelector('.note')?.textContent`)}`);
        const told = await page.evaluate(`document.querySelector('.note').textContent`);
        expect(told.includes('读不懂') && told.includes('存在这个浏览器里'), `没有说清楚原因和这面墙的去向：${told}`);
        expect(readFileSync(WALLS_FILE, 'utf8') === damaged, '文件读不懂时在页面上存墙，文件还是被动了');
        expect(await page.evaluate(`JSON.parse(localStorage.getItem('mw.customPoses') ?? '[]').some((p) => p.name === '坏文件时存的墙')`), '没能进文件的那面墙也没有存进浏览器');
        // 浏览器会把"服务器回了 409"记成一条报错；那是这一步故意要来的，不算毛病
        page.logs.splice(0, page.logs.length, ...page.logs.filter((l) => !/409/.test(l.text)));
      } finally {
        restoreFile(WALLS_FILE, WALLS_BACKUP);
        rmSync(`${WALLS_FILE}.tmp`, { force: true });
      }
    },
  },
];

/**
 * 像真人那样用鼠标点一个按钮：找到它在屏幕上的位置，发真实的鼠标按下 / 抬起。
 * 按钮被别的东西盖住、或者样式让鼠标点不到它时，这样点是没反应的——脚本里直接调 .click() 会把这种毛病盖过去。
 * selector 是一段能在页面里求出那个按钮的表达式（比如 BUTTON('设置')）。
 */
async function mouseClick(page, selector, what) {
  // 先把它滚到看得见的地方（人也是这么做的），再看它到底在不在最上面
  const at = await page.evaluate(`(() => {
    const b = ${selector};
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    const x = r.x + r.width / 2;
    const y = r.y + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return { x, y, reachable: top === b || b.contains(top) };
  })()`);
  expect(at, `页面上没有${what}`);
  expect(at.reachable, `${what}被别的东西挡住了，或者样式让鼠标点不到它`);
  await page.click(at.x, at.y);
}

/**
 * 发一个 POST，但请求头先到、请求体过一会儿才到——用来让两个请求在服务器里"撞车"。返回状态码。
 * （不带 Origin，算命令行工具发的请求，接口认。）
 */
function slowPost(base, urlPath, body, delayMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${base}${urlPath}`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.flushHeaders();
    setTimeout(() => req.end(data), delayMs);
  });
}

/** 等 fn 变成真；超时返回 false。（在这个脚本里查，不是在页面里查。） */
async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (fn()) return true;
    } catch {
      /* 文件正写到一半之类 */
    }
    await sleep(100);
  }
  return false;
}

/** 等页面稳定下来：连续 1.5 秒没有重新加载。 */
async function settled(page) {
  let origin = await page.evaluate('performance.timeOrigin').catch(() => 0);
  for (let i = 0; i < 20; i++) {
    await sleep(1500);
    const now = await page.evaluate('performance.timeOrigin').catch(() => 0);
    if (now === origin && now !== 0) return;
    origin = now;
  }
}

// ---------------------------------------------------------------- 准备：构建、服务器、假摄像头

function freePort(from) {
  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > from + 50) return reject(new Error('找不到空闲端口'));
      const probe = net.createServer();
      probe.once('error', () => tryPort(port + 1));
      probe.once('listening', () => probe.close(() => resolve(port)));
      probe.listen(port, '127.0.0.1');
    };
    tryPort(from);
  });
}

/** kind：'preview' 把 dist/ 当静态站点跑；'dev' 是开发服务器（只有它有写文件的接口）。 */
async function startServer(kind) {
  const port = await freePort(kind === 'dev' ? 5290 : 5190);
  // 直接用 node 运行 vite（不经过 npm / shell），结束时才能干净地关掉它
  const command = kind === 'dev' ? [] : ['preview'];
  const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), ...command, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base)).ok) return { base, stop: () => proc.kill() };
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error('本地服务器没有起来');
}

async function main() {
  for (const needed of ['public/models/pose_landmarker_full.task', 'public/mediapipe/wasm', 'tests/fixtures/photos/pose.jpg']) {
    if (!existsSync(path.join(ROOT, needed))) {
      console.error(`缺少 ${needed}。先运行 npm run setup 把识别模型和测试照片准备好。`);
      process.exit(2);
    }
  }
  // 上一次运行要是在 dev-save 场景中途被掐掉，存墙的文件还是被它改过的样子：先恢复
  const leftover = restoreFile(WALLS_FILE, WALLS_BACKUP, path.join(OUT, 'custom-poses.found-instead.json'));
  if (leftover.restored) {
    console.log('上一次检查没跑完就中断了：public/custom-poses.json 已经恢复成那次检查开始之前的样子。');
    if (leftover.setAside) console.log(`  中断之后这个文件里的内容另存在 ${path.relative(ROOT, leftover.setAside)}，万一里面有你后来存的墙。`);
  }
  const scenarios = SCENARIOS.filter((s) => only.length === 0 || only.some((word) => s.name.includes(word)));
  if (scenarios.length === 0) {
    console.error(`没有名字里含 ${only.join(' / ')} 的场景。有这些：${SCENARIOS.map((s) => s.name).join('、')}`);
    process.exit(2);
  }

  if (!noBuild) {
    console.log('构建中……');
    const built = spawnSync('npm run build', { cwd: ROOT, shell: true, stdio: ['ignore', 'ignore', 'inherit'] });
    if (built.status !== 0) {
      console.error('构建失败，先把上面的错误修好。');
      process.exit(1);
    }
  }
  expect(existsSync(path.join(ROOT, 'dist/index.html')), '没有 dist/：去掉 --no-build 再跑一次');

  mkdirSync(OUT, { recursive: true });
  if (scenarios.some((s) => s.chrome?.fakeVideo) && !existsSync(FAKE_CAM)) await makeFakeCam(PHOTO, FAKE_CAM);

  // 服务器用到哪种才起哪种
  const servers = {};
  const serverFor = async (kind) => (servers[kind] ??= await startServer(kind));
  let failed = 0;
  // 按了 Ctrl+C：正常的收尾代码不会跑，所以在这里把存墙的文件恢复、把服务器关掉
  process.once('SIGINT', () => {
    restoreFile(WALLS_FILE, WALLS_BACKUP);
    for (const server of Object.values(servers)) server.stop();
    process.exit(130);
  });
  try {
    for (const s of scenarios) {
      const t0 = Date.now();
      const server = await serverFor(s.server ?? 'preview');
      const page = await launchChrome({ w: 1280, h: 800, ...s.chrome });
      expect(page.downloadsDenied, '没能让这个 Chrome 拒绝下载：不往下跑了，免得检查脚本把文件存进你的"下载"文件夹');
      await page.send('Page.addScriptToEvaluateOnNewDocument', { source: COUNT_CAMERA_REQUESTS });
      let problem = '';
      try {
        await s.run({ base: server.base, page });
        const errors = consoleErrors(page);
        if (errors.length) problem = `控制台有报错：${errors.slice(0, 3).join(' | ').slice(0, 500)}`;
      } catch (err) {
        problem = err instanceof Error ? err.message : String(err);
      }
      try {
        await page.screenshot(path.join(OUT, `${s.name}.png`));
      } catch {
        /* 截不了图不影响结论 */
      }
      await page.close();
      if (problem) failed++;
      console.log(`${problem ? 'FAIL' : 'PASS'}  ${s.name.padEnd(10)} ${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} 秒  ${s.about}${problem ? `\n      ${problem}` : ''}`);
    }
  } finally {
    for (const server of Object.values(servers)) server.stop();
  }
  console.log(failed ? `\n${failed} 个场景没过。截图在 e2e-out/。` : `\n${scenarios.length} 个场景全部通过。截图在 e2e-out/。`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
