import { useEffect, useState, type ReactNode } from 'react';
import { listCameras } from '../../engine/camera/camera';
import { useSettings, type Settings } from '../settings';
import { Button } from './Button';

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={v === value} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

const onOff: [string, string][] = [
  ['on', '开'],
  ['off', '关'],
];

function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <div className="field">
      <span>{label}</span>
      {children}
      {note && <small>{note}</small>}
    </div>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [s, update] = useSettings();
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);

  useEffect(() => {
    void listCameras().then(setCameras);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      // 面板开着的时候，Esc 只归它。底下的页面也在听 Esc（游戏里是"暂停 / 继续"）——
      // 让这一下传过去的话，为了开设置才暂停的游戏会跟着面板一起"关掉暂停"，墙就飞过来了。
      e.stopPropagation();
      onClose();
    };
    // 第三个参数 true：赶在页面上别的监听之前收到（它们收不到被拦下的这一下）
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const toggle = (key: keyof Pick<Settings, 'sound' | 'voice' | 'pip' | 'skeleton' | 'twoPeople'>) => (
    <Segmented value={s[key] ? 'on' : 'off'} options={onOff} onChange={(v) => update({ [key]: v === 'on' })} />
  );

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="plate dialog" role="dialog" aria-modal="true" aria-label="设置">
        <h2>设置</h2>

        <Field label="难度" note="越难，姿势要摆得越准，墙也来得越快。挑战档不显示落位轮廓。游戏进行中改的话，下一局生效。">
          <Segmented
            value={s.difficulty}
            options={[
              ['easy', '轻松'],
              ['normal', '标准'],
              ['hard', '挑战'],
            ]}
            onChange={(difficulty) => update({ difficulty })}
          />
        </Field>

        <Field label="音效">{toggle('sound')}</Field>
        <Field label="语音提示" note="墙出现时念出姿势的名字。">
          {toggle('voice')}
        </Field>
        <Field label="摄像头小窗">{toggle('pip')}</Field>
        <Field label="小窗里画骨架">{toggle('skeleton')}</Field>

        <Field label="识别模型" note="自动：先用标准模型，电脑跑不动就换轻量的。">
          <Segmented
            value={s.model}
            options={[
              ['auto', '自动'],
              ['full', '标准'],
              ['lite', '轻量'],
            ]}
            onChange={(model) => update({ model })}
          />
        </Field>

        <Field label="同时识别两个人" note="家里人多、常有人从镜头前走过时打开：旁人在场也能一直跟住你。每帧多花十来毫秒。">
          {toggle('twoPeople')}
        </Field>

        <Field label="画质" note="自动：识别只能用轻量模型或者只能靠 CPU 的电脑，画面也用低画质。">
          <Segmented
            value={s.quality}
            options={[
              ['auto', '自动'],
              ['high', '高'],
              ['low', '低'],
            ]}
            onChange={(quality) => update({ quality })}
          />
        </Field>

        {cameras.length > 1 && (
          <Field label="摄像头">
            <select value={s.cameraId} onChange={(e) => update({ cameraId: e.target.value })}>
              <option value="">默认</option>
              {cameras.map((c, i) => (
                <option key={c.deviceId} value={c.deviceId}>
                  {c.label || `摄像头 ${i + 1}`}
                </option>
              ))}
            </select>
          </Field>
        )}

        <div className="dialog__footer">
          <Button go onClick={onClose}>
            好了
          </Button>
        </div>
      </div>
    </div>
  );
}
