/**
 * 采集层：打开摄像头，拿到一个不显示的 <video> 元素。后面的识别和画面叠加都从它取帧。
 * 摄像头画面只在这个页面里用，不会进入任何网络请求。
 */

/** 给人看的摄像头错误：一句是什么问题，一句怎么办。 */
export class CameraError extends Error {
  constructor(
    readonly title: string,
    readonly hint: string,
    readonly code: 'denied' | 'notfound' | 'busy' | 'unsupported' | 'unknown',
  ) {
    super(title);
    this.name = 'CameraError';
  }
}

/** 把浏览器抛出的各种异常翻译成 CameraError。 */
export function mapCameraError(err: unknown): CameraError {
  if (err instanceof CameraError) return err;
  const name = typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError('摄像头没有获得许可', '点地址栏左边的图标，把摄像头改成"允许"，然后点"再试一次"。', 'denied');
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError('没有找到摄像头', '接上摄像头后点"再试一次"；手边没有摄像头的话，可以先用演示模式看看。', 'notfound');
    case 'NotReadableError':
    case 'AbortError':
      return new CameraError('摄像头正被别的程序占用', '关掉正在用摄像头的程序（视频会议、别的浏览器标签页），再点"再试一次"。', 'busy');
    default:
      return new CameraError('摄像头打不开', err instanceof Error ? err.message : String(err), 'unknown');
  }
}

/**
 * 打开摄像头。理想 1280×720、30 帧、前置。
 * 指定了设备却找不到（比如换了电脑、摄像头拔了）时，自动退回默认摄像头。
 */
export async function openCamera(opts: { deviceId?: string } = {}): Promise<HTMLVideoElement> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('这个浏览器用不了摄像头', '请用最新版的 Chrome 或 Edge，并且通过 localhost 或 https 打开。', 'unsupported');
  }
  const base: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: opts.deviceId ? { ...base, deviceId: { exact: opts.deviceId } } : { ...base, facingMode: 'user' },
    });
  } catch (err) {
    const mapped = mapCameraError(err);
    if (opts.deviceId && mapped.code === 'notfound') return openCamera();
    throw mapped;
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try {
    await video.play();
    if (!video.videoWidth) await firstPicture(video);
  } catch (err) {
    // 走到这里摄像头已经打开了（指示灯亮了），只是画面没出来：得把它关掉，不然灯会一直亮着
    closeCamera(video);
    if (err instanceof CameraError) throw err;
    throw new CameraError('摄像头的画面出不来', `关掉别的正在用摄像头的程序，然后点"再试一次"。（${err instanceof Error ? err.message : String(err)}）`, 'busy');
  }
  return video;
}

/** 摄像头打开之后，最多等这么久出第一帧画面 */
const FIRST_PICTURE_TIMEOUT_MS = 8000;

function firstPicture(video: HTMLVideoElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onData = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      video.removeEventListener('loadeddata', onData);
      reject(new CameraError('摄像头一直没有画面', '看看摄像头的盖子是不是合着、是不是被别的程序占用了，然后点"再试一次"。', 'busy'));
    }, FIRST_PICTURE_TIMEOUT_MS);
    video.addEventListener('loadeddata', onData, { once: true });
  });
}

export function closeCamera(video: HTMLVideoElement | null): void {
  if (!video) return;
  (video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}

/**
 * 看门狗：摄像头被拔掉、电脑休眠、被别的程序抢走时，画面会停住而不报错。
 * 定时看 currentTime 有没有前进，停了太久就通知外面。返回取消监视的函数。
 */
export function watchCamera(video: HTMLVideoElement, onProblem: (kind: 'ended' | 'frozen') => void, frozenMs = 4000): () => void {
  const track = (video.srcObject as MediaStream | null)?.getVideoTracks()[0];
  let reported = false;
  const report = (kind: 'ended' | 'frozen'): void => {
    if (reported) return;
    reported = true;
    onProblem(kind);
  };
  const onEnded = (): void => report('ended');
  track?.addEventListener('ended', onEnded);

  let lastTime = video.currentTime;
  let lastMoved = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    if (document.hidden) {
      lastMoved = now; // 标签页在后台时浏览器会暂停视频，不算卡死
    } else if (track?.readyState === 'ended') {
      report('ended');
    } else if (video.currentTime !== lastTime) {
      lastTime = video.currentTime;
      lastMoved = now;
    } else if (now - lastMoved > frozenMs) {
      report('frozen');
    }
  }, 700);

  return () => {
    track?.removeEventListener('ended', onEnded);
    clearInterval(timer);
  };
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  } catch {
    return [];
  }
}
