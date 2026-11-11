/**
 * 语音播报：用浏览器自带的语音合成（Web Speech API）。
 * 不识字的小朋友、站在三米外看不清字的人，听一句"双手举高"就知道该干什么。
 */
let enabled = true;
let voice: SpeechSynthesisVoice | null | undefined;

const synth = (): SpeechSynthesis | null => (typeof speechSynthesis === 'undefined' ? null : speechSynthesis);

/** 挑一个中文语音；系统里没有就用默认的。语音列表是异步加载的，所以每次都现查。 */
function pickVoice(s: SpeechSynthesis): SpeechSynthesisVoice | null {
  if (voice) return voice;
  const voices = s.getVoices();
  voice = voices.find((v) => /^zh[-_]CN/i.test(v.lang)) ?? voices.find((v) => /^zh/i.test(v.lang)) ?? null;
  return voice;
}

export function setVoiceEnabled(on: boolean): void {
  enabled = on;
  if (!on) synth()?.cancel();
}

/** 说一句话。interrupt：打断正在说的（默认打断——新的墙一出现，上一面的话就不用说完了）。 */
export function speak(text: string, opts: { interrupt?: boolean } = {}): void {
  const s = synth();
  if (!s || !enabled || !text) return;
  if (opts.interrupt ?? true) s.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice(s);
  if (v) u.voice = v;
  u.lang = 'zh-CN';
  u.rate = 1.1;
  s.speak(u);
}
