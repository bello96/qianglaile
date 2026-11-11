import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { poseToSkeleton } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import {
  capturePose,
  deleteCustomPose,
  estimateTier,
  isPoseEnabled,
  isPoseNameOk,
  isUpperOk,
  loadCustomPoses,
  loadCustomPosesReport,
  mergePoses,
  poseToCode,
  saveCustomPose,
  setPoseEnabled,
  usablePoses,
  validatePose,
  wallPool,
} from './customPoses';
import { WallSequence } from './levels';
import { SHAPES } from './shapes';
import { getPose, POSES } from './poses';

const profile = defaultProfile();
const T = getPose('t')!;

describe('validatePose', () => {
  it('accepts a well-formed pose and returns a clean copy', () => {
    const clean = validatePose(JSON.parse(JSON.stringify(T)));
    expect(clean).toEqual(T);
    expect(clean).not.toBe(T);
  });

  it('accepts every built-in pose', () => {
    for (const p of POSES) expect(validatePose(JSON.parse(JSON.stringify(p))), p.id).toEqual(p);
  });

  it('drops fields it does not know', () => {
    const clean = validatePose({ ...T, hax: true, armL: [{ a: 90, evil: 1 }, { a: 90 }] });
    expect(clean).toEqual(T);
  });

  it('rejects anything malformed', () => {
    const bad: unknown[] = [
      null,
      'pose',
      [],
      { ...T, armL: undefined },
      { ...T, armL: [{ a: 90 }] },
      { ...T, armR: [{ a: 'ninety' }, { a: 90 }] },
      { ...T, legL: [{ a: 4, s: 0 }, { a: 0 }] },
      { ...T, legL: [{ a: 4, s: 1.5 }, { a: 0 }] },
      { ...T, armL: [{ a: 9999 }, { a: 90 }] },
      { ...T, armL: [{ a: NaN }, { a: 90 }] },
      { ...T, tier: 7 },
      { ...T, name: '' },
      { ...T, name: '   ' },
      { ...T, name: 'x'.repeat(40) },
      { ...T, id: '' },
      { ...T, id: '../etc/passwd' },
      { ...T, id: 'has space' },
      { ...T, spine: { a: 170 } },
      { ...T, head: 'left' },
      { ...T, upperOk: 'yes' },
    ];
    for (const b of bad) expect(validatePose(b), JSON.stringify(b)?.slice(0, 80)).toBeNull();
  });

  it('does not let a stored wall use the "~" that marks mirrored copies', () => {
    // 出墙时左右镜像的版本会在 id 后面加 "~m"；自己存的墙要是也叫这种名字，两者就分不清了
    expect(validatePose({ ...T, id: 'my-1~m' })).toBeNull();
    expect(validatePose({ ...T, id: 'a~b' })).toBeNull();
    expect(validatePose({ ...T, id: 'my-1' })?.id).toBe('my-1');
  });

  it('refuses the names this project must not use', () => {
    expect(validatePose({ ...T, name: '墙来了' })).toBeNull();
    expect(validatePose({ ...T, name: '动动乐园一号' })).toBeNull();
    expect(validatePose({ ...T, say: '墙来了！摆好' })).toBeNull();
  });

  it('refuses a spoken hint that is too long, not text, or contains control characters', () => {
    expect(validatePose({ ...T, say: 'x'.repeat(41) })).toBeNull();
    expect(validatePose({ ...T, say: 42 })).toBeNull();
    expect(validatePose({ ...T, say: '第一行\n第二行' })).toBeNull();
    expect(validatePose({ ...T, say: '举起双手' })?.say).toBe('举起双手');
  });

  it('keeps optional parts when they are valid', () => {
    const bend = getPose('side-bend')!;
    expect(validatePose(JSON.parse(JSON.stringify(bend)))).toEqual(bend);
  });
});

describe('isPoseNameOk', () => {
  it('accepts short ordinary names', () => {
    expect(isPoseNameOk('我的T')).toBe(true);
    expect(isPoseNameOk('a')).toBe(true);
    expect(isPoseNameOk('x'.repeat(20))).toBe(true);
  });

  it('rejects empty, too long and banned names — exactly what validatePose rejects', () => {
    // 最后三个：换行、退格这类控制字符，以及编码弄坏时冒出来的替换符（比如在 Windows 的命令行里用 curl 发中文）
    for (const name of ['', '   ', 'x'.repeat(21), '墙来了', '动动乐园一号', '两\n行', 'a\u0008b', '\ufffd\ufffd存的']) {
      expect(isPoseNameOk(name), name).toBe(false);
      expect(validatePose({ ...T, name }), name).toBeNull();
    }
  });
});

describe('usablePoses', () => {
  const a = { ...T, id: 'my-1', name: '甲' };
  const b = { ...T, id: 'my-2', name: '乙' };

  it('keeps the built-in poses and appends the custom ones that are switched on', () => {
    const pool = usablePoses([a, b], (id) => id !== 'my-2');
    expect(pool.slice(0, POSES.length)).toEqual(POSES);
    expect(pool.slice(POSES.length).map((p) => p.id)).toEqual(['my-1']);
  });

  it('never lets a custom pose replace a built-in one', () => {
    const impostor = { ...T, name: '冒牌' };
    const pool = usablePoses([impostor], () => true);
    expect(pool).toHaveLength(POSES.length);
    expect(pool.find((p) => p.id === 't')!.name).toBe(T.name);
  });
});

describe('wallPool', () => {
  const a = { ...T, id: 'my-1', name: '甲' };
  const b = { ...getPose('crane')!, id: 'my-2', name: '乙' };
  const everything = () => true;

  it('normal play: built-in poses, the custom ones that are switched on, and every shape', () => {
    const pool = wallPool([a, b], null, (id) => id !== 'my-2');
    expect(pool.poses.map((p) => p.id)).toEqual([...POSES.map((p) => p.id), 'my-1']);
    expect(pool.shapes).toEqual(SHAPES);
  });

  it('practising one wall: just that pose and no shapes', () => {
    expect(wallPool([a, b], 'my-2', everything)).toEqual({ poses: [b], shapes: [] });
    expect(wallPool([a, b], 'star', everything)).toEqual({ poses: [getPose('star')!], shapes: [] });
  });

  it('practising works even for a wall that is switched off for normal play', () => {
    expect(wallPool([a], 'my-1', () => false).poses).toEqual([a]);
  });

  it('falls back to normal play when nothing has that id', () => {
    const pool = wallPool([a], 'no-such-wall', everything);
    expect(pool.poses).toHaveLength(POSES.length + 1);
    expect(pool.shapes).toEqual(SHAPES);
  });

  it('a one-wall pool really does produce that wall every time, at every level', () => {
    const seq = new WallSequence(7, 'normal', wallPool([a, b], 'my-2', everything));
    const ctx = { mode: 'full' as const, view: null, profile, playerX: 0 };
    for (let i = 0; i < 40; i++) {
      const spec = seq.next(ctx);
      expect(spec.kind).toBe('pose');
      expect(spec.pose!.id.replace(/~m$/, ''), `wall ${i + 1}`).toBe('my-2');
    }
    expect(seq.level).toBeGreaterThan(4);
  });
});

describe('estimateTier / isUpperOk', () => {
  it('rates the examples the way a person would', () => {
    expect(estimateTier(getPose('t')!)).toBe(1);
    expect(estimateTier(getPose('disco')!)).toBe(2);
    expect(estimateTier(getPose('star')!)).toBe(2);
    expect(estimateTier(getPose('side-bend')!)).toBe(3);
    expect(estimateTier(getPose('squat')!)).toBe(3);
    expect(estimateTier(getPose('crane')!)).toBe(4);
  });

  it('agrees with the hand-assigned tier of every built-in pose', () => {
    for (const p of POSES) expect(estimateTier(p), p.id).toBe(p.tier);
  });

  it('knows which poses can be done sitting down', () => {
    expect(isUpperOk(getPose('t')!)).toBe(true);
    expect(isUpperOk(getPose('star')!)).toBe(false);
    for (const p of POSES) expect(isUpperOk(p), p.id).toBe(p.upperOk);
  });
});

describe('capturePose', () => {
  it('reads a pose off a skeleton and labels it', () => {
    const spec = capturePose(poseToSkeleton(T, profile), profile, '我的T');
    expect(spec.name).toBe('我的T');
    expect(spec.id).toMatch(/^my-[a-z0-9]+$/);
    expect(spec.armL[0].a).toBeGreaterThanOrEqual(89);
    expect(spec.armL[0].a).toBeLessThanOrEqual(91);
    expect(spec.armR[1].a).toBeGreaterThanOrEqual(89);
    expect(spec.tier).toBe(1);
    expect(spec.upperOk).toBe(true);
    expect(validatePose(spec)).toEqual(spec);
  });

  it('gives each capture its own id', () => {
    const sk = poseToSkeleton(T, profile);
    expect(capturePose(sk, profile, 'a').id).not.toBe(capturePose(sk, profile, 'b').id);
  });

  it('rates a captured squat as harder and not doable sitting', () => {
    const spec = capturePose(poseToSkeleton(getPose('low')!, profile), profile, '蹲');
    expect(spec.tier).toBe(3);
    expect(spec.upperOk).toBe(false);
  });

  it('a captured pose reproduces the body it was taken from', () => {
    for (const id of ['disco', 'star', 'side-bend', 'tree']) {
      const original = poseToSkeleton(getPose(id)!, profile);
      const again = poseToSkeleton(capturePose(original, profile, id), profile);
      for (const j of ['wristL', 'wristR', 'ankleL', 'ankleR', 'head'] as const) {
        expect(Math.hypot(again[j].x - original[j].x, again[j].y - original[j].y), `${id} ${j}`).toBeLessThan(0.03);
      }
    }
  });
});

describe('poseToCode', () => {
  it('produces source that evaluates back to the same pose', () => {
    for (const p of [T, getPose('side-bend')!, getPose('low')!]) {
      const code = poseToCode(p);
      expect(new Function(`return (${code})`)()).toEqual(p);
      expect(code).toContain(`id: '${p.id}'`);
    }
  });

  it('escapes quotes in names', () => {
    const p = { ...T, name: "it's" };
    expect(new Function(`return (${poseToCode(p)})`)()).toEqual(p);
  });
});

describe('saving and loading (dev endpoint + browser storage)', () => {
  const LOCAL = 'mw.customPoses';
  const a = { ...T, id: 'my-1', name: '甲' };
  const b = { ...T, id: 'my-2', name: '乙' };
  let store: Map<string, string>;

  const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  /** 没有那个文件 / 没有那个接口时，静态服务器会拿首页来顶 */
  const homePage = (): Response => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const stubFetch = (answer: () => Response | Promise<Response>) => {
    const mock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve().then(answer));
    vi.stubGlobal('fetch', mock);
    return mock;
  };
  const stored = (): unknown => JSON.parse(store.get(LOCAL) ?? '[]');

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('saves into the project file when the dev endpoint answers', async () => {
    const fetchMock = stubFetch(() => json({ ok: true, id: 'my-1' }));
    expect(await saveCustomPose(a)).toEqual({ where: 'file' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/__poses');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual(a);
    expect(stored()).toEqual([]);
  });

  it('falls back to this browser when there is no endpoint', async () => {
    stubFetch(homePage);
    expect(await saveCustomPose(a)).toEqual({ where: 'local' });
    expect(stored()).toEqual([a]);
  });

  it('does not even try the endpoint in a built site, where it cannot exist', async () => {
    // 打包后的静态站点没有那个接口；去试只会在控制台留下一条 404
    const fetchMock = stubFetch(homePage);
    expect(await saveCustomPose(a, false)).toEqual({ where: 'local' });
    expect(stored()).toEqual([a]);
    await deleteCustomPose('my-1', false);
    expect(stored()).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to this browser when the network call fails', async () => {
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await saveCustomPose(a)).toEqual({ where: 'local' });
    expect(stored()).toEqual([a]);
  });

  it('when the dev endpoint refuses, keeps the wall in this browser and passes on the reason', async () => {
    // 比如项目文件被手改坏了：接口不肯写。墙不能丢，人也得知道为什么没进文件
    stubFetch(() => json({ error: 'public/custom-poses.json 读不懂' }, 409));
    expect(await saveCustomPose(a)).toEqual({ where: 'local', refused: 'public/custom-poses.json 读不懂' });
    expect(stored()).toEqual([a]);
  });

  it('a refusal that gives no readable reason is still reported as one', async () => {
    stubFetch(() => json({ nope: true }, 403));
    const r = await saveCustomPose(a);
    expect(r.where).toBe('local');
    expect(r.refused).toMatch(/403/);
    stubFetch(() => new Response('{not json', { status: 500, headers: { 'content-type': 'application/json' } }));
    expect((await saveCustomPose(b)).refused).toMatch(/500/);
  });

  it('a server that simply has no such endpoint is not a refusal', async () => {
    // 静态服务器对不认识的地址回一个网页（404，或者拿首页来顶）：那是"没有接口"，不是"接口不同意"
    stubFetch(() => new Response('<!doctype html>Not found', { status: 404, headers: { 'content-type': 'text/html' } }));
    expect(await saveCustomPose(a)).toEqual({ where: 'local' });
    stubFetch(homePage);
    expect(await saveCustomPose(b)).toEqual({ where: 'local' });
  });

  it('a pose that reached the file does not leave a stale copy in the browser', async () => {
    store.set(LOCAL, JSON.stringify([a, b]));
    stubFetch(() => json({ ok: true, id: 'my-1' }));
    expect(await saveCustomPose({ ...a, name: '改名' })).toEqual({ where: 'file' });
    expect(stored()).toEqual([b]);
  });

  it('says so when it could not be saved anywhere (storage blocked, e.g. private browsing)', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('denied', 'SecurityError');
      },
    });
    stubFetch(homePage);
    expect(await saveCustomPose(a)).toEqual({ where: 'failed' });
  });

  it('loads file poses and browser poses together', async () => {
    store.set(LOCAL, JSON.stringify([b]));
    const fetchMock = stubFetch(() => json([a]));
    expect(await loadCustomPoses()).toEqual([a, b]);
    expect(fetchMock.mock.calls[0][0]).toBe('/custom-poses.json');
  });

  it('ignores a missing file and entries that are not poses', async () => {
    store.set(LOCAL, JSON.stringify([b, { id: 'junk' }, 'x', null]));
    stubFetch(homePage);
    expect(await loadCustomPoses()).toEqual([b]);
    stubFetch(() => json([a, { nope: 1 }]));
    expect(await loadCustomPoses()).toEqual([a, b]);
    stubFetch(() => json({ not: 'a list' }));
    expect(await loadCustomPoses()).toEqual([b]);
  });

  it('says so when the project file is there but cannot be read', async () => {
    // 手改文件时多打了个逗号：里面的墙读不出来。不能一声不吭地当成"一面墙都没有"
    store.set(LOCAL, JSON.stringify([b]));
    stubFetch(() => new Response('[{"id":"my-1",]', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await loadCustomPosesReport()).toEqual({ list: [b], fileBroken: true });
    stubFetch(() => json({ not: 'a list' }));
    expect(await loadCustomPosesReport()).toEqual({ list: [b], fileBroken: true });
  });

  it('a missing, empty or healthy project file is not reported as broken', async () => {
    store.set(LOCAL, JSON.stringify([b]));
    stubFetch(homePage);
    expect(await loadCustomPosesReport()).toEqual({ list: [b], fileBroken: false });
    stubFetch(() => new Response('', { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(await loadCustomPosesReport()).toEqual({ list: [b], fileBroken: false });
    stubFetch(() => json([a, { nope: 1 }]));
    expect(await loadCustomPosesReport()).toEqual({ list: [a, b], fileBroken: false });
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await loadCustomPosesReport()).toEqual({ list: [b], fileBroken: false });
  });

  it('survives corrupted browser storage and a dead network', async () => {
    store.set(LOCAL, '{not json');
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await loadCustomPoses()).toEqual([]);
    store.set(LOCAL, '"a string"');
    expect(await loadCustomPoses()).toEqual([]);
  });

  it('deleting removes it from the file and from the browser', async () => {
    store.set(LOCAL, JSON.stringify([a, b]));
    const fetchMock = stubFetch(() => json({ ok: true }));
    expect(await deleteCustomPose('my-1')).toEqual({});
    expect(fetchMock.mock.calls[0][0]).toBe('/__poses/my-1');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('DELETE');
    expect(stored()).toEqual([b]);
  });

  it('deleting still clears the browser copy when there is no endpoint', async () => {
    store.set(LOCAL, JSON.stringify([a, b]));
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await deleteCustomPose('my-2')).toEqual({});
    expect(stored()).toEqual([a]);
  });

  it('when the dev endpoint refuses a delete, says why — and still clears the copy in this browser', async () => {
    // 浏览器里的那份是这台设备自己的，接口同不同意都删得掉；文件里的那份还在，所以要把原因交出去
    store.set(LOCAL, JSON.stringify([a, b]));
    stubFetch(() => json({ error: '只接受这台电脑自己发来的请求' }, 403));
    expect(await deleteCustomPose('my-1')).toEqual({ refused: '只接受这台电脑自己发来的请求' });
    expect(stored()).toEqual([b]);
  });

  it('remembers which custom walls are switched off (on by default)', () => {
    expect(isPoseEnabled('my-1')).toBe(true);
    setPoseEnabled('my-1', false);
    expect(isPoseEnabled('my-1')).toBe(false);
    expect(isPoseEnabled('my-2')).toBe(true);
    setPoseEnabled('my-1', true);
    expect(isPoseEnabled('my-1')).toBe(true);
  });

  it('treats a damaged switch list as "everything on" instead of guessing', () => {
    store.set('mw.customDisabled', '"my-1 my-2"');
    expect(isPoseEnabled('my-1')).toBe(true);
    store.set('mw.customDisabled', '{"my-1":true}');
    expect(isPoseEnabled('my-1')).toBe(true);
    store.set('mw.customDisabled', '[1,null,"my-2"]');
    expect(isPoseEnabled('my-1')).toBe(true);
    expect(isPoseEnabled('my-2')).toBe(false);
    setPoseEnabled('my-3', false);
    expect(JSON.parse(store.get('mw.customDisabled')!)).toEqual(['my-2', 'my-3']);
  });
});

describe('mergePoses', () => {
  it('joins lists, later entries replacing earlier ones with the same id', () => {
    const a = { ...T, id: 'my-1', name: '甲' };
    const b = { ...T, id: 'my-2', name: '乙' };
    const a2 = { ...T, id: 'my-1', name: '甲改' };
    expect(mergePoses([a, b], [a2]).map((p) => p.name)).toEqual(['甲改', '乙']);
    expect(mergePoses([], [])).toEqual([]);
  });
});
