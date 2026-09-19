/**
 * Чужое видео/звук через Socket.IO (тот же канал, что чат).
 * Работает между разными сетями без внешнего TURN.
 */

const VIDEO_W = 480;
const VIDEO_H = 360;
const VIDEO_FPS = 8;
const VIDEO_QUALITY = 0.55;
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
  constructor({ socket, selfId, onRemoteStream, onError }) {
    this.socket = socket;
    this.selfId = selfId;
    this.onRemoteStream = onRemoteStream;
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
    this.peers = new Map();
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
    this._startVideoLoop();
    this._startAudioLoop().catch((err) => this.onError(err.message || 'relay audio'));
  }

  /** Вызывать из клика в комнате — иначе на телефоне звук может молчать. */
  async resumeAudio() {
    try {
      if (this.audioCtx?.state === 'suspended') await this.audioCtx.resume();
    } catch (_) {
      /* ignore */
    }
    for (const p of this.peers.values()) {
      try {
        if (p.audioCtx?.state === 'suspended') await p.audioCtx.resume();
      } catch (_) {
        /* ignore */
      }
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
    } catch (_) {
      /* ignore */
    }
    this.processor = null;
    this.audioSource = null;
    this.silentGain = null;
    this.audioCtx = null;
    this.captureVideo = null;
    this.busyFrame = false;

    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
  }

  /** Создать пустой поток заранее — плитка появляется сразу при входе участника. */
  ensurePeer(peerId) {
    if (!peerId || peerId === this.selfId) return null;
    return this._ensurePeer(peerId);
  }

  removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try {
      p.audioCtx?.close();
    } catch (_) {
      /* ignore */
    }
    this.peers.delete(peerId);
  }

  destroy() {
    this.stop();
    this.socket.off('relay:video', this._onVideo);
    this.socket.off('relay:audio', this._onAudio);
  }

  _ensurePeer(peerId) {
    let p = this.peers.get(peerId);
    if (p) return p;

    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);

    const videoStream = canvas.captureStream(VIDEO_FPS);
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const audioDest = audioCtx.createMediaStreamDestination();
    // Держим граф живым (нужно некоторым браузерам)
    const zero = audioCtx.createGain();
    zero.gain.value = 0;
    audioDest.connect(zero);
    zero.connect(audioCtx.destination);

    const stream = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDest.stream.getAudioTracks(),
    ]);

    p = {
      canvas,
      ctx,
      stream,
      audioCtx,
      audioDest,
      nextTime: audioCtx.currentTime + 0.12,
      img: new Image(),
    };
    this.peers.set(peerId, p);
    this.onRemoteStream(peerId, stream);
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return p;
  }

  _startVideoLoop() {
    const canvas = document.createElement('canvas');
    canvas.width = VIDEO_W;
    canvas.height = VIDEO_H;
    const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', 'true');
    video.autoplay = true;
    this.captureVideo = video;

    if (this.localStream) {
      video.srcObject = this.localStream;
      video.play().catch(() => {});
    }

    this.timer = setInterval(() => {
      if (!this.sending || this.busyFrame) return;
      const track = this.localStream
        ?.getVideoTracks()
        .find((t) => t.readyState === 'live' && t.enabled !== false);
      if (!track || !video.videoWidth) return;

      ctx.drawImage(video, 0, 0, VIDEO_W, VIDEO_H);
      this.busyFrame = true;
      canvas.toBlob(
        (blob) => {
          this.busyFrame = false;
          if (!blob || !this.sending) return;
          blob.arrayBuffer().then((buf) => {
            if (this.sending) this.socket.volatile?.emit
              ? this.socket.volatile.emit('relay:video', buf)
              : this.socket.emit('relay:video', buf);
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
      } catch (_) {
        /* ignore */
      }
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
      if (this.socket.volatile?.emit) this.socket.volatile.emit('relay:audio', copy);
      else this.socket.emit('relay:audio', copy);
    };
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

    const p = this._ensurePeer(from);
    const blob = new Blob([buf], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = p.img;
    img.onload = () => {
      try {
        p.ctx.drawImage(img, 0, 0, VIDEO_W, VIDEO_H);
      } catch (_) {
        /* ignore */
      }
      URL.revokeObjectURL(url);
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
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

    const p = this._ensurePeer(from);
    if (p.audioCtx.state === 'suspended') {
      p.audioCtx.resume().catch(() => {});
    }

    const int16 = new Int16Array(buf);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }
    const audioBuf = p.audioCtx.createBuffer(1, float32.length, AUDIO_RATE);
    audioBuf.copyToChannel(float32, 0);
    const src = p.audioCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(p.audioDest);
    const now = p.audioCtx.currentTime;
    if (p.nextTime < now + 0.04) p.nextTime = now + 0.04;
    try {
      src.start(p.nextTime);
      p.nextTime += audioBuf.duration;
    } catch (_) {
      /* ignore */
    }
  }
}
