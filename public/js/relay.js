/**
 * Чужое видео/звук через Socket.IO.
 * Видео = JPEG-кадры → <img> (так надёжнее, чем canvas.captureStream на телефонах).
 */

const VIDEO_W = 320;
const VIDEO_H = 240;
const VIDEO_FPS = 6;
const VIDEO_QUALITY = 0.5;
const AUDIO_FRAME = 4096;
const AUDIO_RATE = 16000;

function downsampleToInt16(float32, outRate, inRate) {
  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(float32.length / ratio));
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)] || 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function toArrayBuffer(data) {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return null;
}

export class SocketMediaRelay {
  /**
   * @param {{
   *  socket: any,
   *  selfId: string,
   *  onRemoteFrame: (peerId: string, objectUrl: string) => void,
   *  onError?: (msg: string) => void
   * }} opts
   */
  constructor({ socket, selfId, onRemoteFrame, onError }) {
    this.socket = socket;
    this.selfId = selfId;
    this.onRemoteFrame = onRemoteFrame;
    this.onError = onError || (() => {});
    this.localStream = null;
    this.sending = false;
    this.timer = null;
    this.busyFrame = false;
    this.audioCtx = null;
    this.processor = null;
    this.audioSource = null;
    this.silentGain = null;
    this.captureVideo = null;
    this.captureCanvas = null;
    this.peerAudio = new Map(); // peerId -> { ctx, dest, nextTime }
    this.peerUrls = new Map(); // peerId -> objectUrl
    this._onVideo = this._onVideo.bind(this);
    this._onAudio = this._onAudio.bind(this);
    this.socket.on('relay:video', this._onVideo);
    this.socket.on('relay:audio', this._onAudio);
  }

  setLocalStream(stream) {
    this.localStream = stream || null;
    if (this.captureVideo && stream) {
      this.captureVideo.srcObject = stream;
      this.captureVideo.play().catch(() => {});
    }
  }

  start() {
    if (this.sending) return;
    this.sending = true;
    this._ensureCaptureEl();
    this._startVideoLoop();
    this._startAudioLoop().catch((err) => this.onError(err.message || 'relay audio'));
  }

  async resumeAudio() {
    try {
      if (this.audioCtx?.state === 'suspended') await this.audioCtx.resume();
    } catch (_) {}
    for (const p of this.peerAudio.values()) {
      try {
        if (p.ctx?.state === 'suspended') await p.ctx.resume();
      } catch (_) {}
    }
  }

  ensurePeer(peerId) {
    // кадр появится при первом JPEG; аудио-граф можно подготовить заранее
    if (!peerId || peerId === this.selfId) return;
    this._ensureAudioPeer(peerId);
  }

  removePeer(peerId) {
    const a = this.peerAudio.get(peerId);
    if (a) {
      try {
        a.ctx.close();
      } catch (_) {}
      this.peerAudio.delete(peerId);
    }
    const url = this.peerUrls.get(peerId);
    if (url) {
      URL.revokeObjectURL(url);
      this.peerUrls.delete(peerId);
    }
  }

  stop() {
    this.sending = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      this.processor?.disconnect();
      this.audioSource?.disconnect();
      this.silentGain?.disconnect();
      this.audioCtx?.close();
    } catch (_) {}
    this.processor = null;
    this.audioSource = null;
    this.silentGain = null;
    this.audioCtx = null;
    this.busyFrame = false;

    if (this.captureVideo) {
      try {
        this.captureVideo.srcObject = null;
        this.captureVideo.remove();
      } catch (_) {}
      this.captureVideo = null;
    }
    if (this.captureCanvas) {
      try {
        this.captureCanvas.remove();
      } catch (_) {}
      this.captureCanvas = null;
    }

    for (const id of [...this.peerAudio.keys()]) this.removePeer(id);
  }

  destroy() {
    this.stop();
    this.socket.off('relay:video', this._onVideo);
    this.socket.off('relay:audio', this._onAudio);
  }

  _ensureCaptureEl() {
    if (this.captureVideo) return;
    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.setAttribute('muted', 'true');
    video.autoplay = true;
    // ОБЯЗАТЕЛЬНО в DOM — иначе на Android/iOS часто videoWidth=0 и кадры не шлются
    video.style.cssText =
      'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-99px;top:-99px;';
    document.body.appendChild(video);
    this.captureVideo = video;

    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    canvas.style.display = 'none';
    document.body.appendChild(canvas);
    this.captureCanvas = canvas;

    if (this.localStream) {
      video.srcObject = this.localStream;
      video.play().catch(() => {});
    }
  }

  _startVideoLoop() {
    const video = this.captureVideo;
    const canvas = this.captureCanvas;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

    this.timer = setInterval(() => {
      if (!this.sending || this.busyFrame) return;
      if (!this.localStream) return;
      const track = this.localStream
        .getVideoTracks()
        .find((t) => t.readyState === 'live' && t.enabled !== false);
      if (!track) return;

      if (video.srcObject !== this.localStream) {
        video.srcObject = this.localStream;
        video.play().catch(() => {});
      }
      if (!video.videoWidth) {
        video.play().catch(() => {});
        return;
      }

      ctx.drawImage(video, 0, 0, VIDEO_W, VIDEO_H);
      this.busyFrame = true;
      canvas.toBlob(
        (blob) => {
          this.busyFrame = false;
          if (!blob || !this.sending) return;
          blob.arrayBuffer().then((buf) => {
            if (!this.sending) return;
            // обычный emit (не volatile) — иначе на слабой сети кадры все отбрасываются
            this.socket.emit('relay:video', buf);
          });
        },
        'image/jpeg',
        VIDEO_QUALITY
      );
    }, Math.round(1000 / VIDEO_FPS));
  }

  async _startAudioLoop() {
    const live = this.localStream?.getAudioTracks().some((t) => t.readyState === 'live');
    if (!live) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.audioCtx = new AudioCtx();
    if (this.audioCtx.state === 'suspended') {
      try {
        await this.audioCtx.resume();
      } catch (_) {}
    }
    this.audioSource = this.audioCtx.createMediaStreamSource(this.localStream);
    this.processor = this.audioCtx.createScriptProcessor(AUDIO_FRAME, 1, 1);
    this.silentGain = this.audioCtx.createGain();
    this.silentGain.gain.value = 0;
    this.audioSource.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.audioCtx.destination);

    this.processor.onaudioprocess = (ev) => {
      if (!this.sending) return;
      const micOn = this.localStream
        ?.getAudioTracks()
        .some((t) => t.readyState === 'live' && t.enabled !== false);
      if (!micOn) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = downsampleToInt16(input, AUDIO_RATE, this.audioCtx.sampleRate);
      const copy = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      this.socket.emit('relay:audio', copy);
    };
  }

  _ensureAudioPeer(peerId) {
    let p = this.peerAudio.get(peerId);
    if (p) return p;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 1;
    // Для слышимости подключаем к speakers напрямую
    const out = ctx.createGain();
    out.gain.value = 1;
    // Будем играть BufferSource → out → destination
    p = { ctx, dest, out, nextTime: ctx.currentTime + 0.1 };
    out.connect(ctx.destination);
    this.peerAudio.set(peerId, p);
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return p;
  }

  async _onVideo(payload) {
    const from = payload?.from;
    let data = payload?.data;
    if (!from || from === this.selfId || data == null) return;

    if (data instanceof Blob) {
      try {
        data = await data.arrayBuffer();
      } catch (_) {
        return;
      }
    }
    const buf = toArrayBuffer(data);
    if (!buf || buf.byteLength < 24) return;

    const blob = new Blob([buf], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const prev = this.peerUrls.get(from);
    this.peerUrls.set(from, url);
    if (prev) URL.revokeObjectURL(prev);
    this.onRemoteFrame(from, url);
  }

  async _onAudio(payload) {
    const from = payload?.from;
    let data = payload?.data;
    if (!from || from === this.selfId || data == null) return;

    if (data instanceof Blob) {
      try {
        data = await data.arrayBuffer();
      } catch (_) {
        return;
      }
    }
    const buf = toArrayBuffer(data);
    if (!buf || buf.byteLength < 2) return;

    const p = this._ensureAudioPeer(from);
    if (p.ctx.state === 'suspended') p.ctx.resume().catch(() => {});

    const int16 = new Int16Array(buf);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }
    const audioBuf = p.ctx.createBuffer(1, float32.length, AUDIO_RATE);
    audioBuf.copyToChannel(float32, 0);
    const src = p.ctx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(p.out);
    const now = p.ctx.currentTime;
    if (p.nextTime < now + 0.04) p.nextTime = now + 0.04;
    try {
      src.start(p.nextTime);
      p.nextTime += audioBuf.duration;
    } catch (_) {}
  }
}
