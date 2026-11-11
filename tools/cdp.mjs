// 零依赖的 Chrome 驱动：通过 DevTools 协议（CDP）控制本机已安装的 Chrome。
// 需要 Node 22+（自带 WebSocket 和 fetch）。端到端检查（tools/e2e.mjs）和造假摄像头素材都用它。
//
// 也可以直接当命令行用：
//   node tools/cdp.mjs --url <地址> [--until "<js 表达式>"] [--wait 毫秒] [--eval "<js>"] [--shot out.png]
//                      [--fake-video x.mjpeg] [--w 1280] [--h 800] [--timeout 30000] [--headed]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => p && existsSync(p));
  if (!found) throw new Error('找不到 Chrome。请安装 Chrome，或用环境变量 CHROME_PATH 指明路径。');
  return found;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把控制台参数变成一行文字。 */
const describeArg = (a) => {
  if (a.type === 'string') return a.value;
  if (a.value !== undefined) return String(a.value);
  if (a.preview?.properties) {
    const body = a.preview.properties.map((p) => (a.preview.subtype === 'array' ? p.value : `${p.name}: ${p.value}`)).join(', ');
    return a.preview.subtype === 'array' ? `[${body}]` : `{${body}}`;
  }
  return a.description ?? a.type;
};

/**
 * 启动一个 Chrome 并连上它的第一个页面。
 * @param {{ fakeVideo?: string, denyCamera?: boolean, headed?: boolean, w?: number, h?: number, port?: number, flags?: string[] }} opts
 */
export async function launchChrome(opts = {}) {
  const port = opts.port ?? 9400 + Math.floor(Math.random() * 400);
  const w = opts.w ?? 1280;
  const h = opts.h ?? 800;
  const profile = mkdtempSync(path.join(tmpdir(), 'mw-chrome-'));
  const flags = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${w},${h}`,
    '--hide-scrollbars',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    ...(opts.flags ?? []),
  ];
  if (!opts.headed) flags.push('--headless=new');
  if (opts.denyCamera) {
    flags.push('--deny-permission-prompts');
  } else {
    // 假摄像头：不弹授权框；给了视频文件就播它，否则是 Chrome 自带的测试图案
    flags.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream');
    if (opts.fakeVideo) flags.push(`--use-file-for-fake-video-capture=${opts.fakeVideo}`);
  }
  flags.push('about:blank');

  const proc = spawn(findChrome(), flags, { stdio: 'ignore' });
  let wsUrl;
  for (let i = 0; i < 150 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) {
    proc.kill();
    throw new Error('Chrome 的调试端口没有起来');
  }

  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('连不上 Chrome 的调试端口')), { once: true });
  });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  /** 页面的控制台输出、未捕获异常、网络错误 */
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject, method } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
    } else if (msg.method) {
      for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject, method });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (event, fn) => listeners.set(event, [...(listeners.get(event) ?? []), fn]);

  on('Runtime.consoleAPICalled', (p) => logs.push({ level: p.type, text: p.args.map(describeArg).join(' ') }));
  on('Runtime.exceptionThrown', (p) => logs.push({ level: 'exception', text: p.exceptionDetails.exception?.description ?? p.exceptionDetails.text }));
  on('Log.entryAdded', (p) => logs.push({ level: p.entry.level, text: `${p.entry.text}${p.entry.url ? ` @ ${p.entry.url}` : ''}` }));
  /** 正在等"页面加载完成"的那次 goto */
  let onLoad = null;
  on('Page.loadEventFired', () => onLoad?.());
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  // 页面触发的"下载"一律不落盘。不拦的话，无头 Chrome 会把文件真的存进你系统的"下载"文件夹——
  // 检查脚本跑一遍就往那里丢一个文件。要看下载的内容，在页面里截住它（见 e2e.mjs 里的 CAPTURE_DOWNLOADS）。
  const downloadsDenied = await send('Page.setDownloadBehavior', { behavior: 'deny' }).then(
    () => true,
    () => false,
  );

  const page = {
    /** 页面触发的下载是不是已经拦住了（拦不住时，会改到别人文件夹的检查应当自己跳过）。 */
    downloadsDenied,
    logs,
    send,
    /** 全新打开一个地址，等它加载完。 */
    async goto(url, timeout = 30000) {
      const load = async (target, ms) => {
        const loaded = new Promise((resolve) => (onLoad = resolve));
        await send('Page.navigate', { url: target });
        await Promise.race([loaded, sleep(ms)]);
        onLoad = null;
      };
      // 先退到空白页再去目标地址。不这样的话，新旧地址只差 # 后面的部分时浏览器不会重新加载页面
      // （单页应用换页面就是这种情况），拿到的就不是一个"全新打开"的页面。
      if ((await page.evaluate('location.href')) !== 'about:blank') await load('about:blank', 3000);
      await load(url, timeout);
    },
    /** 在页面里求值（表达式可以是 Promise），返回可序列化的结果。 */
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    /** 等到表达式为真；超时返回 false。 */
    async waitFor(expression, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        try {
          if (await page.evaluate(`!!(${expression})`)) return true;
        } catch {
          /* 页面可能还在启动 */
        }
        await sleep(200);
      }
      return false;
    },
    async screenshot(file) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(data, 'base64'));
    },
    /** 在页面上按坐标点一下（真实的鼠标事件）。 */
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    },
    /** 按一下键盘上的键（真实的按键事件，页面上谁在听就谁收到）。只认用得到的这几个。 */
    async key(name) {
      const code = { Escape: 27, Enter: 13 }[name];
      if (!code) throw new Error(`cdp.key：不认识的键 ${name}`);
      for (const type of ['rawKeyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
    },
    sleep,
    async close() {
      try {
        ws.close();
      } catch {
        /* 已经断了 */
      }
      proc.kill();
      await sleep(400);
      try {
        rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* 临时目录偶尔还被占着，留给系统清理 */
      }
    },
  };
  return page;
}

// ---------------------------------------------------------------- 命令行
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const takesValue = !['headed'].includes(key);
    out[key] = takesValue ? argv[++i] : true;
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url) {
    console.error('用法：node tools/cdp.mjs --url <地址> [--until expr] [--wait ms] [--eval expr] [--shot file.png] [--fake-video file.mjpeg]');
    process.exit(2);
  }
  const page = await launchChrome({ fakeVideo: args['fake-video'], headed: args.headed, w: Number(args.w) || 1280, h: Number(args.h) || 800 });
  let code = 0;
  try {
    await page.goto(args.url);
    if (args.until && !(await page.waitFor(args.until, Number(args.timeout) || 30000))) {
      console.log('until: 超时');
      code = 1;
    }
    if (args.wait) await sleep(Number(args.wait));
    if (args.eval) console.log('eval:', JSON.stringify(await page.evaluate(args.eval)));
    if (args.shot) {
      await page.screenshot(args.shot);
      console.log('screenshot:', args.shot);
    }
  } catch (err) {
    console.error(err.message);
    code = 1;
  } finally {
    for (const l of page.logs.slice(0, 80)) console.log(`[${l.level}] ${l.text}`);
    await page.close();
  }
  process.exit(code);
}
