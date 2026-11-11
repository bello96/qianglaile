import type { PoseSpec } from '../../engine/body/pose';
import { mergePoses, validatePose } from './customPoses';

/**
 * public/custom-poses.json 的"写入规则"。
 *
 * 开发服务器上有个存墙的小接口（见 vite.config.ts），它该不该接受一个请求、文件该变成什么样，
 * 全部由这里的三个纯函数决定；接口自己只管收请求、读写文件。规则放在这里而不是配置文件里，是为了能测。
 *
 * 为什么一个只在自己电脑上跑的接口还要查"请求是谁发的"：
 *   你开着开发服务器的时候，浏览器里别的网页同样能向 http://localhost:5188 发请求。
 *   不查的话，随便哪个网站都能往你的项目文件里写东西。所以只认两种来源：
 *   这个页面自己（同源），和命令行工具（不带 Origin）。
 *   而且请求必须是从这台电脑上发出来的：用 vite --host 把服务器开到局域网上时，别的机器能看、不能写。
 */

/** 文件里最多存多少面墙：防止文件被无限写大 */
export const MAX_CUSTOM_POSES = 200;

export interface Refusal {
  status: number;
  error: string;
}

/** Node 给的请求头：同一个头出现多次时可能是数组 */
type Headers = Record<string, string | string[] | undefined>;
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

/** 是不是这台电脑自己的地址（回环地址）：127.x.x.x、::1，以及它们套在 IPv6 里的写法。 */
const isLoopback = (address: string): boolean => /^(::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(address) || address === '::1';

/**
 * 这个请求可不可以改文件。可以返回 null，不可以返回拒绝的理由。
 * remoteAddress：请求是从哪个地址连过来的（服务器从网络连接上读到的，伪造不了）。不传就不查这一项。
 */
export function checkWriteRequest(method: string | undefined, headers: Headers, remoteAddress?: string): Refusal | null {
  if (method !== 'POST' && method !== 'DELETE') return { status: 405, error: '只支持 POST 和 DELETE' };
  if (remoteAddress !== undefined && !isLoopback(remoteAddress)) return { status: 403, error: '只接受这台电脑自己发来的请求' };

  // 浏览器发出的请求都带 Sec-Fetch-Site，说明它和目标是什么关系；只放行"同源"。
  // same-site 也不行：那是这台电脑上另一个端口的网页。
  const site = first(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return { status: 403, error: '只接受这个页面自己发来的请求' };

  // Origin 是发请求的网页的地址。有的话，必须和被访问的地址（Host）是同一个
  const origin = first(headers.origin);
  if (origin !== undefined) {
    let from = '';
    try {
      from = new URL(origin).host;
    } catch {
      /* 读不懂的 Origin（比如 "null"）一律不认 */
    }
    if (!from || from !== first(headers.host)) return { status: 403, error: '只接受这个页面自己发来的请求' };
  }

  // 别的网站不经许可只能发"简单请求"（表单、纯文本）。要求 JSON，等于把它们挡在门外
  if (method === 'POST' && !/^application\/json\b/i.test(first(headers['content-type']) ?? '')) {
    return { status: 415, error: '请求体必须是 JSON（Content-Type: application/json）' };
  }
  return null;
}

const idOf = (v: unknown): unknown => (typeof v === 'object' && v !== null ? (v as { id?: unknown }).id : undefined);

export type ReadResult = { ok: true; list: unknown[] } | ({ ok: false } & Refusal);

/**
 * 把文件里的文字读成"一串墙"。text 是文件的全部内容；文件不存在时传 null。
 *
 * 文件不存在，或者是空的：当作一面墙都没有。
 * 文件有内容却读不懂（比如手改时多打了一个逗号）：**拒绝**，绝不能当成空的——
 * 接下来的写入会拿新内容盖掉整个文件，里面原有的墙就全没了。
 */
export function readWallsFile(text: string | null): ReadResult {
  // 有的编辑器存文件时会在最前面加一个看不见的标记（BOM），JSON.parse 不认它
  const body = (text ?? '').replace(/^\ufeff/, '').trim();
  if (!body) return { ok: true, list: [] };
  const broken: ReadResult = { ok: false, status: 409, error: 'public/custom-poses.json 读不懂（可能是手改时写错了格式）。为了不弄丢里面的墙，这次没有改它；先把它修好。' };
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed) ? { ok: true, list: parsed } : broken;
  } catch {
    return broken;
  }
}

export type UpsertResult = { ok: true; list: unknown[]; id: string } | ({ ok: false } & Refusal);

/**
 * 把一个姿势放进文件内容里：id 已经有了就原地替换，没有就加在最后。
 * list 是文件现在的内容（readWallsFile 读出来的）；input 是请求发来的东西，先校验、只存干净的副本。
 * 文件里看不懂的条目原样留着——可能是你正手写到一半的。
 */
export function upsertIntoFile(list: unknown[], input: unknown): UpsertResult {
  const pose = validatePose(input);
  if (!pose) return { ok: false, status: 400, error: '不是合法的姿势' };

  const at = list.findIndex((p) => idOf(p) === pose.id);
  if (at < 0 && list.length >= MAX_CUSTOM_POSES) {
    return { ok: false, status: 409, error: `存的墙太多了（最多 ${MAX_CUSTOM_POSES} 面），先删掉几面` };
  }
  return { ok: true, id: pose.id, list: at < 0 ? [...list, pose] : list.map((p, i) => (i === at ? pose : p)) };
}

/** 文件的写法：一面墙占一行。这样打开文件一眼能看全，进版本管理时改一面墙也只动一行。 */
export function formatFile(list: unknown[]): string {
  return list.length ? `[\n${list.map((p) => `  ${JSON.stringify(p)}`).join(',\n')}\n]\n` : '[]\n';
}

/**
 * 读一份导出的文件（图鉴里的"从文件导入"）。里面看得懂的墙留下，看不懂的丢掉，同一个 id 只留后面那个；
 * 整个文件根本不是"一串墙"时返回 null。
 */
export function parsePoseFile(text: string): PoseSpec[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  const valid = raw.map(validatePose).filter((p): p is PoseSpec => p !== null);
  return mergePoses(valid).slice(0, MAX_CUSTOM_POSES);
}

/** 从文件内容里删掉一个姿势。 */
export function removeFromFile(list: unknown[], id: string): unknown[] {
  return list.filter((p) => idOf(p) !== id);
}
