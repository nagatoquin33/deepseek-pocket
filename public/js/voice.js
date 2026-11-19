/* =========================================================================
 * voice.js —— 录音（16kHz 单声道 WAV，供 /v1/tools/asr）与朗读（/v1/tools/tts）
 *
 * ASR 只接受 16-bit PCM WAV 或 Ogg Opus。浏览器 MediaRecorder 在 iOS 上
 * 只能给出 mp4/aac，因此这里统一用 WebAudio 采集后自行降采样并编码 WAV，
 * 保证 Android / iOS / 桌面一致可用。
 * ========================================================================= */

/* ------------------------------- WAV 编码 -------------------------------- */

/** Float32 [-1,1] → 16-bit PCM WAV Blob（单声道） */
export function encodeWav(float32, sampleRate) {
  const len = float32.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const buffer = new ArrayBuffer(44 + len * bytesPerSample);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i += 1) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * bytesPerSample, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);          // fmt chunk size
  view.setUint16(20, 1, true);           // PCM
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);          // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, len * bytesPerSample, true);

  let offset = 44;
  for (let i = 0; i < len; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/** 线性插值降采样到目标采样率 */
export function resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

/** 多段 Float32 合并 */
function concatFloat32(chunks, totalLen) {
  const out = new Float32Array(totalLen);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

/* -------------------------------- 录音器 --------------------------------- */

export class Recorder {
  constructor({ onLevel, onTick, maxSeconds = 110 } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.maxSeconds = maxSeconds;
    this.state = 'idle';        // idle | starting | recording | stopping
    this.stream = null;
    this.ctx = null;
    this.source = null;
    this.processor = null;
    this.analyser = null;
    this.chunks = [];
    this.total = 0;
    this.startedAt = 0;
    this.timer = null;
    this.levels = 0;
  }

  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext));
  }

  async start() {
    if (this.state !== 'idle') throw new Error('录音已在进行');
    this.state = 'starting';
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (e) {
      this.state = 'idle';
      const err = new Error(
        e?.name === 'NotAllowedError' ? '未获得麦克风权限，请在浏览器设置中允许。'
          : e?.name === 'NotFoundError' ? '没有检测到麦克风。'
            : location.protocol !== 'https:' && location.hostname !== 'localhost'
              ? '麦克风需要 HTTPS 安全上下文，请用 https 地址访问。'
              : '无法打开麦克风。',
      );
      err.cause = e;
      throw err;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);

    const bufSize = 4096;
    this.processor = this.ctx.createScriptProcessor(bufSize, 1, 1);
    this.chunks = [];
    this.total = 0;
    this.processor.onaudioprocess = (ev) => {
      if (this.state !== 'recording') return;
      const data = ev.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(data));
      this.total += data.length;
      // 简单 RMS 电平
      let sum = 0;
      for (let i = 0; i < data.length; i += 16) sum += data[i] * data[i];
      const rms = Math.sqrt(sum / (data.length / 16));
      this.levels = Math.min(1, rms * 6);
      this.onLevel?.(this.levels);
    };
    // 需要接到 destination 才会持续触发（用 0 增益避免回声）
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.processor.connect(mute);
    mute.connect(this.ctx.destination);
    this.source.connect(this.processor);

    this.state = 'recording';
    this.startedAt = Date.now();
    this.timer = setInterval(() => {
      const sec = (Date.now() - this.startedAt) / 1000;
      this.onTick?.(sec);
      if (sec >= this.maxSeconds) this.stop().catch(() => {});
    }, 100);
  }

  /** 停止并返回 WAV Blob（16kHz 单声道） */
  async stop() {
    if (this.state !== 'recording') return null;
    this.state = 'stopping';
    clearInterval(this.timer);
    const durationMs = Date.now() - this.startedAt;
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.analyser?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      const rate = this.ctx?.sampleRate || 48000;
      const merged = concatFloat32(this.chunks, this.total);
      await this.ctx?.close();
      const pcm16k = resampleLinear(merged, rate, 16000);
      const blob = encodeWav(pcm16k, 16000);
      return { blob, durationMs, samples: pcm16k.length };
    } finally {
      this.ctx = null;
      this.stream = null;
      this.source = null;
      this.processor = null;
      this.analyser = null;
      this.chunks = [];
      this.total = 0;
      this.state = 'idle';
      this.onLevel?.(0);
    }
  }

  /** 取消录音，丢弃数据 */
  async cancel() {
    if (this.state !== 'recording' && this.state !== 'starting') return;
    this.state = 'stopping';
    clearInterval(this.timer);
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch { /* ignore */ }
    this.ctx = null; this.stream = null; this.processor = null; this.source = null;
    this.chunks = []; this.total = 0; this.state = 'idle';
    this.onLevel?.(0);
  }
}

/* ------------------------------- 朗读播放器 ------------------------------- */

/** 去掉不适合朗读的 Markdown 结构 */
export function speechText(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, '（代码块略）')
    .replace(/~~~[\s\S]*?~~~/g, '（代码块略）')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/[*_~`>]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 按句子切分，避免超过 TTS 单次 10k 字符上限 */
export function splitForTTS(text, max = 2400) {
  const clean = speechText(text);
  if (!clean) return [];
  const parts = [];
  let buf = '';
  const sentences = clean.split(/(?<=[。！？!?；;\n])/);
  for (const s of sentences) {
    if ((buf + s).length > max && buf) { parts.push(buf); buf = ''; }
    if (s.length > max) {
      for (let i = 0; i < s.length; i += max) parts.push(s.slice(i, i + max));
    } else {
      buf += s;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts.filter((p) => p.trim().length > 1);
}

export class TTSPlayer {
  constructor({ onState, onError } = {}) {
    this.onState = onState;
    this.onError = onError;
    this.queue = [];
    this.index = 0;
    this.audio = null;
    this.url = null;
    this.abort = null;
    this.state = 'idle'; // idle | loading | playing | paused
    this.text = '';
  }

  _emit(state, extra = {}) {
    this.state = state;
    this.onState?.(state, { ...extra, index: this.index, total: this.queue.length });
  }

  get busy() { return this.state !== 'idle'; }

  /** 开始朗读；text 为回答正文 */
  async speak(text, { fetchAudio, voiceId = 'stella', rate = 1 } = {}) {
    this.stop();
    this.queue = splitForTTS(text);
    this.index = 0;
    this.rate = rate;
    this.fetchAudio = fetchAudio;
    this.voiceId = voiceId;
    if (!this.queue.length) return;
    await this._playCurrent();
  }

  async _playCurrent() {
    const part = this.queue[this.index];
    if (!part) { this._finish(); return; }
    this.abort = new AbortController();
    this._emit('loading');
    try {
      const blob = await this.fetchAudio({ text: part, voiceId: this.voiceId }, { signal: this.abort.signal });
      if (!blob || this.state === 'idle') return;
      this.url = URL.createObjectURL(blob);
      const audio = new Audio(this.url);
      audio.playbackRate = this.rate || 1;
      this.audio = audio;
      audio.addEventListener('ended', () => {
        this._revoke();
        this.index += 1;
        if (this.index < this.queue.length) this._playCurrent();
        else this._finish();
      });
      audio.addEventListener('error', () => {
        // 主动停止/切换时浏览器会抛空 src 的 error，忽略
        if (this.state === 'idle' || this.stopping) return;
        this._revoke();
        this.onError?.(new Error('音频播放失败'));
        this._finish();
      });
      await audio.play();
      this._emit('playing');
    } catch (e) {
      if (e?.name === 'AbortError') return;
      this.onError?.(e);
      this._finish();
    }
  }

  pause() {
    if (this.audio && this.state === 'playing') { this.audio.pause(); this._emit('paused'); }
  }

  resume() {
    if (this.audio && this.state === 'paused') { this.audio.play().then(() => this._emit('playing')).catch(() => {}); }
  }

  toggle() {
    if (this.state === 'playing') this.pause();
    else if (this.state === 'paused') this.resume();
  }

  _revoke() {
    // 先摘掉事件监听，再释放 src：直接置空会触发 error 事件，导致"播放成功却报失败"
    if (this.audio) {
      try {
        this.audio.onended = null;
        this.audio.onerror = null;
        this.audio.pause();
        this.audio.removeAttribute('src');
        this.audio.load();
      } catch { /* ignore */ }
      this.audio = null;
    }
    if (this.url) { URL.revokeObjectURL(this.url); this.url = null; }
  }

  _finish() {
    this._revoke();
    this.queue = [];
    this.index = 0;
    this._emit('idle');
  }

  stop() {
    this.stopping = true;
    try { this.abort?.abort(); } catch { /* ignore */ }
    this.abort = null;
    this._revoke();
    this.queue = [];
    this.index = 0;
    if (this.state !== 'idle') this._emit('idle');
    this.state = 'idle';
    this.stopping = false;
  }
}
