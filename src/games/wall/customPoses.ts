import { angleDiff, DEFAULT_LEG, poseFromSkeleton, poseToSkeleton, type Limb, type PoseSpec, type Skeleton } from '../../engine/body/pose';
import { defaultProfile, type BodyProfile } from '../../engine/body/profile';
import { POSES } from './poses';
import { SHAPES, type ShapeSpec } from './shapes';

/**
 * 自定义的墙：在姿势实验室里摆个姿势、点"存成新墙"，就多了一面墙。
 *
 * 存在哪：
 *   - 用 npm run dev 运行时，开发服务器有个只在开发模式存在的接口（见 vite.config.ts），
 *     把姿势写进项目里的 public/custom-poses.json —— 它是项目的一个文件，换浏览器也在。
 *   - 没有那个接口时（比如部署成静态站点），存进浏览器的本地存储。
 * 这个文件前半部分是纯函数（校验、估难度、导出代码），后半部分才碰网络和本地存储。
 */

const BANNED = /墙来了|动动乐园/;
/** 存下来的墙的 id：字母数字和连字符。不许有 "~"——出墙时的左右镜像版会在 id 后面加 "~m"，不能撞上 */
const ID_OK = /^[a-z0-9][a-z0-9-]{0,39}$/i;
type Parts = Pick<PoseSpec, 'armL' | 'armR' | 'legL' | 'legR' | 'spine'>;

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanLimb(v: unknown, maxAngle: number): Limb | null {
  if (!isObj(v) || !isNum(v.a, -maxAngle, maxAngle)) return null;
  if (v.s === undefined) return { a: v.a };
  return isNum(v.s, 0, 1) && v.s > 0 ? { a: v.a, s: v.s } : null;
}

function cleanPair(v: unknown): [Limb, Limb] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = cleanLimb(v[0], 360);
  const b = cleanLimb(v[1], 360);
  return a && b ? [a, b] : null;
}

/** 换行、退格这类控制字符，以及文字编码弄坏时冒出来的替换符：名字和提示语里都不该有 */
const UNPRINTABLE = /[\u0000-\u001f\u007f\ufffd]/;
const isText = (v: unknown, maxLength: number): v is string => typeof v === 'string' && v.length <= maxLength && !UNPRINTABLE.test(v) && !BANNED.test(v);

/** 名字能不能用：不能是空的，最多 20 个字。 */
export function isPoseNameOk(name: unknown): name is string {
  return isText(name, 20) && name.trim().length > 0;
}

/**
 * 检查一份来历不明的数据是不是合法的姿势（它可能来自文件、本地存储，或者别人发来的请求），
 * 合法就返回一份只含已知字段的干净副本，否则返回 null。
 */
export function validatePose(input: unknown): PoseSpec | null {
  if (!isObj(input)) return null;
  const { id, name, say, tier, upperOk, spine, head } = input;
  if (typeof id !== 'string' || !ID_OK.test(id)) return null;
  if (!isPoseNameOk(name)) return null;
  if (say !== undefined && !isText(say, 40)) return null;

  const armL = cleanPair(input.armL);
  const armR = cleanPair(input.armR);
  const legL = cleanPair(input.legL);
  const legR = cleanPair(input.legR);
  if (!armL || !armR || !legL || !legR) return null;

  const parts: Parts = { armL, armR, legL, legR };
  if (spine !== undefined) {
    const s = cleanLimb(spine, 60);
    if (!s) return null;
    parts.spine = s;
  }
  if (head !== undefined && !isNum(head, -60, 60)) return null;
  if (tier !== undefined && tier !== 1 && tier !== 2 && tier !== 3 && tier !== 4) return null;
  if (upperOk !== undefined && typeof upperOk !== 'boolean') return null;

  return {
    id,
    name,
    tier: tier ?? estimateTier(parts),
    upperOk: upperOk ?? isUpperOk(parts),
    ...(say ? { say } : {}),
    ...parts,
    ...(head !== undefined ? { head } : {}),
  };
}

const scaleOf = (l: Limb): number => l.s ?? 1;
const BLANK = { id: 'x', name: 'x', tier: 1 as const, upperOk: true };

/**
 * 自动估一个姿势有多难（和内置姿势库的分层标准一致）：
 *   4 单脚（两只脚不在一个高度）· 3 侧倾或下蹲 · 2 左右不对称或双脚分开 · 1 其余
 */
export function estimateTier(spec: Parts): 1 | 2 | 3 | 4 {
  const sk = poseToSkeleton({ ...BLANK, ...spec }, defaultProfile());
  if (Math.abs(sk.ankleL.y - sk.ankleR.y) > 0.15) return 4;

  const thighs = [spec.legL[0], spec.legR[0]];
  if (Math.abs(spec.spine?.a ?? 0) > 10 || thighs.some((t) => scaleOf(t) < 0.85 || Math.abs(t.a) > 45)) return 3;

  const armsDiffer = angleDiff(spec.armL[0].a, spec.armR[0].a) > 20 || angleDiff(spec.armL[1].a, spec.armR[1].a) > 20;
  if (armsDiffer || thighs.some((t) => Math.abs(t.a) > 14)) return 2;
  return 1;
}

/** 只看得到上半身时能不能做：两条腿都接近自然站立，而且没有弯腰缩身。 */
export function isUpperOk(spec: Pick<PoseSpec, 'legL' | 'legR' | 'spine'>): boolean {
  const standing = (leg: [Limb, Limb]): boolean => leg.every((limb, i) => angleDiff(limb.a, DEFAULT_LEG[i].a) <= 12 && scaleOf(limb) >= 0.85);
  return standing(spec.legL) && standing(spec.legR) && (spec.spine?.s ?? 1) >= 0.85;
}

let captureCount = 0;

/** 把一副骨架（玩家现在的样子）存成一个姿势。 */
export function capturePose(sk: Skeleton, profile: BodyProfile, name: string): PoseSpec {
  const parts = poseFromSkeleton(sk, profile);
  return {
    id: `my-${Date.now().toString(36)}${(captureCount++).toString(36)}`,
    name,
    tier: estimateTier(parts),
    upperOk: isUpperOk(parts),
    say: `摆出${name}`,
    ...parts,
  };
}

/** 导出成可以直接贴进 poses.ts 的代码。 */
export function poseToCode(spec: PoseSpec): string {
  const str = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const limb = (l: Limb): string => (l.s === undefined ? `{ a: ${l.a} }` : `{ a: ${l.a}, s: ${l.s} }`);
  const pair = (p: [Limb, Limb]): string => `[${limb(p[0])}, ${limb(p[1])}]`;
  const fields = [
    `id: ${str(spec.id)}`,
    `name: ${str(spec.name)}`,
    `tier: ${spec.tier}`,
    `upperOk: ${spec.upperOk}`,
    ...(spec.say ? [`say: ${str(spec.say)}`] : []),
    `armL: ${pair(spec.armL)}`,
    `armR: ${pair(spec.armR)}`,
    `legL: ${pair(spec.legL)}`,
    `legR: ${pair(spec.legR)}`,
    ...(spec.spine ? [`spine: ${limb(spec.spine)}`] : []),
    ...(spec.head !== undefined ? [`head: ${spec.head}`] : []),
  ];
  return `{ ${fields.join(', ')} }`;
}

/** 合并几份姿势列表；id 相同时后面的覆盖前面的，位置保持第一次出现的地方。 */
export function mergePoses(...lists: PoseSpec[][]): PoseSpec[] {
  const byId = new Map<string, PoseSpec>();
  for (const list of lists) for (const p of list) byId.set(p.id, p);
  return [...byId.values()];
}

/**
 * 闯关时用的姿势池：内置的全部，加上开着"加入闯关"的自定义姿势。
 * 自定义姿势不能顶替内置的（id 相同的会被丢掉），所以内置姿势库永远完整。
 */
export function usablePoses(custom: PoseSpec[], enabled: (id: string) => boolean = isPoseEnabled): PoseSpec[] {
  const builtIn = new Set(POSES.map((p) => p.id));
  // 镜像出来的姿势 id 带 '~m' 后缀，去掉它再比
  return [...POSES, ...custom.filter((p) => enabled(p.id) && !builtIn.has(p.id.replace(/~m$/, '')))];
}

/**
 * 这一局从哪些造型里出墙。
 *   正常闯关：usablePoses + 全部几何洞。
 *   only 给了一个姿势的 id（内置的或自定义的都行）：只出它，反复练——刚存的新墙就是这样试的。
 *   没有哪个姿势叫这个 id 时按正常闯关处理。
 */
export function wallPool(custom: PoseSpec[], only: string | null, enabled: (id: string) => boolean = isPoseEnabled): { poses: PoseSpec[]; shapes: ShapeSpec[] } {
  const chosen = only ? (POSES.find((p) => p.id === only) ?? custom.find((p) => p.id === only)) : undefined;
  if (chosen) return { poses: [chosen], shapes: [] };
  return { poses: usablePoses(custom, enabled), shapes: SHAPES };
}

// ---------------------------------------------------------------- 存取（网络和本地存储）

const FILE_URL = '/custom-poses.json';
const API = '/__poses';
const LOCAL_KEY = 'mw.customPoses';
const DISABLED_KEY = 'mw.customDisabled';
/** 写文件的接口只存在于开发服务器（npm run dev）上；打包后的站点里没有，去试只会在控制台留一条 404 */
const HAS_API: boolean = import.meta.env.DEV;

const parseList = (raw: unknown): PoseSpec[] => (Array.isArray(raw) ? raw.map(validatePose).filter((p): p is PoseSpec => p !== null) : []);

/** 读浏览器里存的东西。读不到、读不懂都返回 null——里面是什么由调用的人自己检查。 */
function readLocal(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

/** 存进浏览器；存不上（无痕模式、空间满了）返回 false。 */
function writeLocal(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const localPoses = (): PoseSpec[] => parseList(readLocal(LOCAL_KEY));

const isJson = (res: Response): boolean => (res.headers.get('content-type') ?? '').includes('json');

export interface LoadReport {
  list: PoseSpec[];
  /** 项目文件在，里面也有内容，却读不懂（多半是手改时写错了格式）：它里面的墙这次没读出来 */
  fileBroken: boolean;
}

/** 读出全部自定义姿势：项目文件里的 + 浏览器里的；顺带说明项目文件是不是坏了。 */
export async function loadCustomPosesReport(): Promise<LoadReport> {
  let fromFile: PoseSpec[] = [];
  let fileBroken = false;
  try {
    const res = await fetch(FILE_URL, { cache: 'no-store' });
    // 文件不存在时服务器会拿首页来顶（text/html），那不算
    if (res.ok && isJson(res)) {
      const text = (await res.text()).trim();
      if (text) {
        try {
          const parsed: unknown = JSON.parse(text);
          if (Array.isArray(parsed)) fromFile = parseList(parsed);
          else fileBroken = true;
        } catch {
          fileBroken = true;
        }
      }
    }
  } catch {
    /* 没有这个文件、连不上：都很正常 */
  }
  return { list: mergePoses(fromFile, localPoses()), fileBroken };
}

/** 读出全部自定义姿势：项目文件里的 + 浏览器里的。 */
export async function loadCustomPoses(): Promise<PoseSpec[]> {
  return (await loadCustomPosesReport()).list;
}

/**
 * 开发服务器的存墙接口有没有**明说不行**；说了就返回它给的理由，否则返回 undefined。
 * "明说"指它回了一段 JSON、状态码又不是成功。回一个网页的不算——那是这个服务器上根本没有这个接口。
 */
async function refusalOf(res: Response): Promise<string | undefined> {
  if (res.ok || !isJson(res)) return undefined;
  let reason: unknown;
  try {
    reason = ((await res.json()) as { error?: unknown } | null)?.error;
  } catch {
    /* 读不出理由，下面给一句通用的 */
  }
  return typeof reason === 'string' && reason ? reason : `开发服务器没有接受（状态 ${res.status}）`;
}

export interface SaveOutcome {
  /** 存到了哪：'file' 项目文件 · 'local' 这个浏览器 · 'failed' 哪儿都没存上 */
  where: 'file' | 'local' | 'failed';
  /** 存墙接口明说了不行时，它给的理由（比如项目文件读不懂）。这时墙退而存在浏览器里 */
  refused?: string;
}

/** 存一个姿势（id 已经存在就是修改）。 */
export async function saveCustomPose(spec: PoseSpec, useApi = HAS_API): Promise<SaveOutcome> {
  let refused: string | undefined;
  try {
    const res = useApi ? await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) }) : null;
    if (res?.ok && isJson(res)) {
      // 浏览器里要是还留着同一个姿势的旧版本，读的时候它会盖住文件里的新版本，所以顺手清掉
      const rest = localPoses().filter((p) => p.id !== spec.id);
      if (rest.length !== localPoses().length) writeLocal(LOCAL_KEY, rest);
      return { where: 'file' };
    }
    if (res) refused = await refusalOf(res);
  } catch {
    /* 没有开发服务器：退回浏览器存储 */
  }
  const where = writeLocal(LOCAL_KEY, mergePoses(localPoses(), [spec])) ? 'local' : 'failed';
  return refused ? { where, refused } : { where };
}

/**
 * 删一个姿势。浏览器里的那份一定删；项目文件里的那份要是接口明说了不让删，把理由放在 refused 里交回去
 * （这时文件里的还在，调用的人应当重新读一遍，以实际还在的为准）。
 */
export async function deleteCustomPose(id: string, useApi = HAS_API): Promise<{ refused?: string }> {
  let refused: string | undefined;
  try {
    if (useApi) refused = await refusalOf(await fetch(`${API}/${encodeURIComponent(id)}`, { method: 'DELETE' }));
  } catch {
    /* 同上 */
  }
  writeLocal(
    LOCAL_KEY,
    localPoses().filter((p) => p.id !== id),
  );
  return refused ? { refused } : {};
}

/** "加入闯关"开关：默认开着，这里记的是被关掉的那些。 */
function disabledIds(): string[] {
  const raw = readLocal(DISABLED_KEY);
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

export function isPoseEnabled(id: string): boolean {
  return !disabledIds().includes(id);
}

export function setPoseEnabled(id: string, on: boolean): void {
  const off = new Set(disabledIds());
  if (on) off.delete(id);
  else off.add(id);
  writeLocal(DISABLED_KEY, [...off]);
}
