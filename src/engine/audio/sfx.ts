/**
 * 音效：全部用 Web Audio 当场合成，项目里没有一个音频文件。
 *
 * 两种"乐器"就够了：
 *   - tone  振荡器 + 音量包络（可以带滑音）→ 滴答、叮、和弦、闷响
 *   - noise 白噪声 + 带通滤波（可以扫频）→ 风声、水花、撞击
 *
 * 浏览器规定：必须在用户点过页面之后才能出声，所以要先调用 resume()。
 */
export type SfxName = 'tick' | 'go' | 'spawn' | 'pass' | 'perfect' | 'hit' | 'splash' | 'levelup' | 'over' | 'click' | 'hover';

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  /** 滑到这个频率 */
  to?: number;
  /** 延后多少秒开始 */
  at?: number;
}

interface NoiseOpts {
  gain?: number;
  /** 滤波器中心频率，可以从 freq 扫到 to */
  freq?: number;
  to?: number;
  q?: number;
  at?: number;
}

const NOTE = { A3: 220, C4: 261.63, E4: 329.63, G4: 392, C5: 523.25, E5: 659.25, G5: 783.99, C6: 1046.5, E6: 1318.5 };

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private enabled = true;
  private wind: { src: AudioBufferSourceNode; filter: BiquadFilterNode; gain: GainNode } | null = null;

  /** 在点击、按键之类的用户操作里调用一次，之后才有声音。 */
  resume(): void {
    if (typeof AudioContext === 'undefined') return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.enabled ? 0.6 : 0;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(on ? 0.6 : 0, this.ctx.currentTime, 0.02);
  }

  play(name: SfxName, opts: { pitch?: number } = {}): void {
    if (!this.ctx || !this.enabled) return;
    const p = opts.pitch ?? 1;
    switch (name) {
      case 'tick':
        this.tone(880 * p, 0.07, { type: 'square', gain: 0.12 });
        break;
      case 'go':
        this.tone(660, 0.1, { type: 'square', gain: 0.14 });
        this.tone(990, 0.22, { type: 'square', gain: 0.14, at: 0.1 });
        break;
      case 'spawn':
        this.noise(0.45, { freq: 300, to: 1400, q: 1.2, gain: 0.22 });
        break;
      case 'pass':
        [NOTE.C5, NOTE.E5, NOTE.G5].forEach((f, i) => this.tone(f * p, 0.16, { type: 'triangle', gain: 0.22, at: i * 0.07 }));
        break;
      case 'perfect':
        [NOTE.C5, NOTE.E5, NOTE.G5, NOTE.C6, NOTE.E6].forEach((f, i) => this.tone(f * p, 0.22, { type: 'triangle', gain: 0.22, at: i * 0.06 }));
        this.noise(0.5, { freq: 6000, to: 9000, q: 3, gain: 0.05, at: 0.2 });
        break;
      case 'hit':
        this.tone(130, 0.28, { type: 'sine', gain: 0.55, to: 45 });
        this.noise(0.14, { freq: 500, q: 0.7, gain: 0.4 });
        break;
      case 'splash':
        this.noise(0.7, { freq: 1800, to: 350, q: 0.8, gain: 0.45 });
        this.noise(0.9, { freq: 5000, to: 2500, q: 2, gain: 0.12, at: 0.08 });
        break;
      case 'levelup':
        [NOTE.G4, NOTE.C5, NOTE.E5, NOTE.G5].forEach((f, i) => this.tone(f, i === 3 ? 0.5 : 0.14, { type: 'square', gain: 0.13, at: i * 0.12 }));
        break;
      case 'over':
        [NOTE.E4, NOTE.C4, NOTE.A3].forEach((f, i) => this.tone(f, 0.35, { type: 'triangle', gain: 0.25, at: i * 0.25 }));
        break;
      case 'click':
        this.tone(620, 0.05, { type: 'square', gain: 0.1 });
        break;
      case 'hover':
        this.tone(900, 0.03, { type: 'sine', gain: 0.06 });
        break;
    }
  }

  /**
   * 墙驶来的风声：progress 从 0 到 1，声音越来越响、越来越尖。传 null 停掉。
   */
  setApproach(progress: number | null): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (progress === null || !this.enabled) {
      if (this.wind) {
        const { src, gain } = this.wind;
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        src.stop(ctx.currentTime + 0.3);
        this.wind = null;
      }
      return;
    }
    if (!this.wind) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseOf(ctx);
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.Q.value = 0.9;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.master);
      src.start();
      this.wind = { src, filter, gain };
    }
    const k = Math.min(1, Math.max(0, progress));
    this.wind.filter.frequency.setTargetAtTime(180 + 900 * k * k, ctx.currentTime, 0.05);
    this.wind.gain.gain.setTargetAtTime(0.02 + 0.2 * k * k, ctx.currentTime, 0.05);
  }

  dispose(): void {
    this.setApproach(null);
    void this.ctx?.close();
    this.ctx = this.master = null;
  }

  private tone(freq: number, dur: number, o: ToneOpts = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(freq, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    const g = ctx.createGain();
    // 很短的起音，然后指数衰减：听起来像"敲了一下"而不是"咔哒"
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, o: NoiseOpts = {}): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseOf(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = o.q ?? 1;
    filter.frequency.setValueAtTime(o.freq ?? 1000, t0);
    if (o.to) filter.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.gain ?? 0.2, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(filter).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  }

  /** 两秒白噪声，循环用。 */
  private noiseOf(ctx: AudioContext): AudioBuffer {
    if (!this.noiseBuffer) {
      this.noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    return this.noiseBuffer;
  }
}
