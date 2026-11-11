import { useEffect, useRef, useState, type ReactNode } from 'react';
import { poseToSkeleton, type JointName, type PoseSpec, type Skeleton } from '../../engine/body/pose';
import { defaultProfile } from '../../engine/body/profile';
import type { Sdf } from '../../engine/util/sdf';
import { skeletonCapsules } from '../../games/wall/bodyShape';
import { wallOutlines } from '../../games/wall/contour';
import { deleteCustomPose, isPoseEnabled, isPoseNameOk, loadCustomPoses, mergePoses, poseToCode, saveCustomPose, setPoseEnabled } from '../../games/wall/customPoses';
import { formatFile, parsePoseFile } from '../../games/wall/customPosesFile';
import { buildField, capsulesHole, WALL_BOUNDS } from '../../games/wall/field';
import { POSES } from '../../games/wall/poses';
import { SHAPES, type ShapeSpec } from '../../games/wall/shapes';
import { TUNING } from '../../games/wall/tuning';
import { navigate } from '../router';

const PROFILE = defaultProfile();
const WALL_TINTS = ['#ff5d4a', '#ffc531', '#3ddc97', '#8f6cff', '#ff7ab8', '#ff9a3c'];
/** 缩略图里显示墙的哪一块（米） */
const VIEW = { x0: -1.25, x1: 1.25, y0: -0.05, y1: 2.25 };
const BONES: [JointName, JointName][] = [
  ['hipC', 'neck'], ['neck', 'head'], ['shoulderL', 'shoulderR'], ['hipL', 'hipR'],
  ['shoulderL', 'elbowL'], ['elbowL', 'wristL'], ['shoulderR', 'elbowR'], ['elbowR', 'wristR'],
  ['hipL', 'kneeL'], ['kneeL', 'ankleL'], ['hipR', 'kneeR'], ['kneeR', 'ankleR'],
];
const TIERS = [1, 2, 3, 4] as const;
/** 导入的文件最大读多大（200 面墙也就几十 KB） */
const MAX_IMPORT_BYTES = 1024 * 1024;

/** 画一面墙的缩略图：墙体（带洞）+ 该摆的姿势。用的就是游戏里造墙的那套函数，只是网格粗一点。 */
function drawWall(canvas: HTMLCanvasElement, target: Skeleton, hole: Sdf, tint: string): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  const { width: w, height: h } = canvas;
  const sx = (x: number): number => ((x - VIEW.x0) / (VIEW.x1 - VIEW.x0)) * w;
  const sy = (y: number): number => h - ((y - VIEW.y0) / (VIEW.y1 - VIEW.y0)) * h;

  g.fillStyle = '#bfeef5';
  g.fillRect(0, 0, w, h);

  g.beginPath();
  for (const outline of wallOutlines(buildField(hole, WALL_BOUNDS, 0.04), 0.012)) {
    for (const loop of [outline.outer, ...outline.holes]) {
      loop.forEach((p, i) => (i ? g.lineTo(sx(p.x), sy(p.y)) : g.moveTo(sx(p.x), sy(p.y))));
      g.closePath();
    }
  }
  g.fillStyle = tint;
  g.fill('evenodd');
  g.lineJoin = 'round';
  g.lineWidth = 3;
  g.strokeStyle = '#14213d';
  g.stroke();

  g.lineCap = 'round';
  g.lineWidth = 5;
  for (const [a, b] of BONES) {
    g.beginPath();
    g.moveTo(sx(target[a].x), sy(target[a].y));
    g.lineTo(sx(target[b].x), sy(target[b].y));
    g.stroke();
  }
  g.beginPath();
  g.arc(sx(target.head.x), sy(target.head.y), (PROFILE.headR / (VIEW.x1 - VIEW.x0)) * w, 0, Math.PI * 2);
  g.fillStyle = '#14213d';
  g.fill();
}

function WallCard({ pose, shape, index, title, meta, children }: { pose?: PoseSpec; shape?: ShapeSpec; index: number; title?: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const item = (pose ?? shape)!;

  useEffect(() => {
    if (!ref.current) return;
    const target = poseToSkeleton(pose ?? shape!.demo, PROFILE);
    const hole = shape ? shape.build(PROFILE, { x: 0 }) : capsulesHole(skeletonCapsules(target, PROFILE), TUNING.normal.holeMargin);
    drawWall(ref.current, target, hole, WALL_TINTS[index % WALL_TINTS.length]);
  }, [pose, shape, index]);

  return (
    <div className="plate card" data-wall={item.id}>
      <canvas ref={ref} width={300} height={276} aria-label={`${item.name}的样子`} />
      <div className="card__body">
        <div className="card__name">{title ?? item.name}</div>
        <div className="card__meta">
          {meta ?? `第 ${item.tier} 层`}
          {item.upperOk ? '，坐着也能做' : ''}
        </div>
        {children}
      </div>
    </div>
  );
}

/** 一面自己存的墙：除了看，还能改名、改难度层、开关"加入闯关"、试玩、复制成代码、删除。 */
function CustomCard({ pose, index, onEdit, onDelete }: { pose: PoseSpec; index: number; onEdit: (next: PoseSpec) => void; onDelete: () => void }) {
  const [enabled, setEnabled] = useState(() => isPoseEnabled(pose.id));
  const [renaming, setRenaming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const rename = (): void => {
    const name = (renaming ?? '').trim();
    setRenaming(null);
    if (!isPoseNameOk(name) || name === pose.name) return;
    // 语音提示要是当初自动生成的那句，跟着名字一起改
    onEdit({ ...pose, name, say: pose.say === `摆出${pose.name}` ? `摆出${name}` : pose.say });
  };

  const copy = (): void => {
    void navigator.clipboard?.writeText(poseToCode(pose)).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  };

  const title =
    renaming === null ? (
      <>
        {pose.name}{' '}
        <button type="button" className="mini" onClick={() => setRenaming(pose.name)}>
          改名
        </button>
      </>
    ) : (
      <input
        className="card__rename"
        value={renaming}
        maxLength={20}
        autoFocus
        aria-label="新名字"
        onChange={(e) => setRenaming(e.target.value)}
        onBlur={rename}
        onKeyDown={(e) => {
          if (e.key === 'Enter') rename();
          if (e.key === 'Escape') setRenaming(null);
        }}
      />
    );

  const meta = (
    <label>
      第{' '}
      <select value={pose.tier} aria-label="难度层" onChange={(e) => onEdit({ ...pose, tier: Number(e.target.value) as PoseSpec['tier'] })}>
        {TIERS.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>{' '}
      层
    </label>
  );

  return (
    <WallCard pose={pose} index={index} title={title} meta={meta}>
      <div className="card__actions">
        <button
          type="button"
          className="mini"
          aria-pressed={enabled}
          onClick={() => {
            setPoseEnabled(pose.id, !enabled);
            setEnabled(!enabled);
          }}
        >
          {enabled ? '已加入闯关' : '没加入闯关'}
        </button>
        <button type="button" className="mini" onClick={() => navigate({ page: 'play', game: 'wall' }, { only: pose.id })}>
          试试这面墙
        </button>
        <button type="button" className="mini" onClick={copy}>
          {copied ? '已复制' : '复制成代码'}
        </button>
        {confirming ? (
          <button type="button" className="mini mini--danger" autoFocus onClick={onDelete} onBlur={() => setConfirming(false)}>
            真的删掉
          </button>
        ) : (
          <button type="button" className="mini" onClick={() => setConfirming(true)}>
            删除
          </button>
        )}
      </div>
    </WallCard>
  );
}

/**
 * 图鉴：所有的墙长什么样。内置的人形姿势、几何洞，以及你自己存的。
 * 调姿势库的角度时，改完看这里像不像样。
 *
 * custom 是全部自定义的墙；改了、删了之后通过 onChange 把新的列表交回去。
 */
export function PoseGallery({ custom, onChange, fileBroken = false }: { custom: PoseSpec[]; onChange: (next: PoseSpec[]) => void; fileBroken?: boolean }) {
  const edit = (next: PoseSpec): void => {
    onChange(custom.map((p) => (p.id === next.id ? next : p)));
    void saveCustomPose(next).then(({ where, refused }) => {
      if (where === 'failed') setMessage('这次改动没存上（浏览器不让存东西），关掉页面就没了。');
      else if (refused) setMessage(`这次改动没能写进项目文件：${refused} 它先存在这个浏览器里了。`);
    });
  };
  const remove = (id: string): void => {
    onChange(custom.filter((p) => p.id !== id));
    void deleteCustomPose(id).then(async ({ refused }) => {
      if (!refused) return;
      // 文件里的那份没删成：把原因说出来，并且重新读一遍——图鉴里显示的要和实际还在的一致
      setMessage(`项目文件里的那一份没删掉：${refused}`);
      onChange(await loadCustomPoses());
    });
  };

  // ---- 导出 / 导入：文件的格式和 public/custom-poses.json 一样，可以在浏览器之间搬，也可以直接放进项目 ----
  const fileInput = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState('');
  const exportAll = (): void => {
    const url = URL.createObjectURL(new Blob([formatFile(custom)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'custom-poses.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const list = file.size <= MAX_IMPORT_BYTES ? parsePoseFile(await file.text()) : null;
    if (!list || list.length === 0) {
      setMessage('这个文件里没有能用的墙。');
      return;
    }
    let lost = 0;
    let refused: string | undefined;
    for (const pose of list) {
      const r = await saveCustomPose(pose);
      if (r.where === 'failed') lost++;
      refused ??= r.refused;
    }
    onChange(mergePoses(custom, list));
    if (lost) setMessage(`导入了 ${list.length} 面墙，但浏览器不让存东西，关掉页面就没了。`);
    else if (refused) setMessage(`导入了 ${list.length} 面墙，存在这个浏览器里；没能写进项目文件：${refused}`);
    else setMessage(`导入了 ${list.length} 面墙。`);
  };

  return (
    <div>
      {fileBroken && (
        <p className="plate box note gallery__broken" data-bad="" role="alert">
          项目文件 public/custom-poses.json 读不懂（多半是手改时写错了格式，比如多了一个逗号），里面的墙这次没读出来。把它修好再刷新页面；修好之前，新存的墙只会存在这个浏览器里。
        </p>
      )}
      <h2 className="plate section-title">我存的墙</h2>
      <div className="gallery__tools">
        <button type="button" className="mini" disabled={custom.length === 0} onClick={exportAll}>
          导出成文件
        </button>
        <button type="button" className="mini" onClick={() => fileInput.current?.click()}>
          从文件导入
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          hidden
          aria-label="选择导出的墙文件"
          onChange={(e) => {
            void importFile(e.target.files?.[0]);
            e.target.value = ''; // 清掉，下次选同一个文件也会触发
          }}
        />
        {message && (
          <span className="gallery__message" role="status">
            {message}
          </span>
        )}
      </div>
      {custom.length === 0 ? (
        <p className="plate box lab__empty">还没有。到"实时"页摆个姿势、起个名字、点按钮，它就会出现在这里，也会出现在闯关里。</p>
      ) : (
        <div className="cards">
          {custom.map((p, i) => (
            <CustomCard key={p.id} pose={p} index={i} onEdit={edit} onDelete={() => remove(p.id)} />
          ))}
        </div>
      )}

      <h2 className="plate section-title">人形洞</h2>
      <div className="cards">
        {POSES.map((p, i) => (
          <WallCard key={p.id} pose={p} index={i} />
        ))}
      </div>

      <h2 className="plate section-title">几何洞</h2>
      <div className="cards">
        {SHAPES.map((s, i) => (
          <WallCard key={s.id} shape={s} index={i + 2} />
        ))}
      </div>
    </div>
  );
}
