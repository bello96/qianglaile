// 准备运行所需、但不入库的资源：
//   1. 把 MediaPipe 的 wasm 运行时从 node_modules 复制到 public/mediapipe/wasm/
//   2. 下载官方 Pose Landmarker 模型到 public/models/
//   3. 下载一张公开的测试照片到 tests/fixtures/photos/（端到端检查用的"假摄像头"素材）
// 已存在且大小正确的文件会跳过。用法：npm run setup
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_BASE = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker';

/** @type {{ url: string, to: string, size: number }[]} */
const DOWNLOADS = [
  { url: `${MODEL_BASE}/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task`, to: 'public/models/pose_landmarker_lite.task', size: 5777746 },
  { url: `${MODEL_BASE}/pose_landmarker_full/float16/latest/pose_landmarker_full.task`, to: 'public/models/pose_landmarker_full.task', size: 9398198 },
  { url: 'https://storage.googleapis.com/mediapipe-assets/pose.jpg', to: 'tests/fixtures/photos/pose.jpg', size: 44100 },
];

let failed = 0;
const sizeOf = (file) => (existsSync(file) ? statSync(file).size : -1);

function copyWasm() {
  const from = path.join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
  const to = path.join(root, 'public/mediapipe/wasm');
  if (!existsSync(from)) {
    console.error('FAIL  wasm: 找不到 node_modules/@mediapipe/tasks-vision/wasm，请先 npm install');
    failed++;
    return;
  }
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    if (sizeOf(dst) === statSync(src).size) {
      console.log(`skip  public/mediapipe/wasm/${name}`);
      continue;
    }
    copyFileSync(src, dst);
    console.log(`ok    public/mediapipe/wasm/${name}`);
  }
}

function download({ url, to, size }) {
  const file = path.join(root, to);
  if (sizeOf(file) === size) {
    console.log(`skip  ${to}`);
    return;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    // curl 会读取 HTTP(S)_PROXY 环境变量；Node 自带的 fetch 默认不会，所以这里用 curl
    execFileSync('curl', ['-L', '--fail', '--silent', '--show-error', '--max-time', '300', '-o', file, url], { stdio: ['ignore', 'ignore', 'inherit'] });
  } catch {
    console.error(`FAIL  ${to}: 下载失败（${url}）`);
    if (existsSync(file)) unlinkSync(file);
    failed++;
    return;
  }
  const got = sizeOf(file);
  if (got !== size) {
    console.error(`FAIL  ${to}: 大小不对，期望 ${size} 字节，实际 ${got} 字节`);
    failed++;
    return;
  }
  console.log(`ok    ${to}`);
}

copyWasm();
for (const d of DOWNLOADS) download(d);

if (failed) {
  console.error(`\n有 ${failed} 项没准备好。检查网络后重新运行 npm run setup。`);
  process.exit(1);
}
console.log('\n资源就绪。');
