/**
 * Запасной путь для чужого видео/звука через Socket.IO (тот же канал, что и чат).
 * Нужен, когда WebRTC P2P/TURN между разными сетями не поднимается.
 * Отдаёт MediaStream на peer — совместимо с существующей сеткой плиток.
 */

const VIDEO_W = 480;
const VIDEO_H = 360;
const VIDEO_FPS = 8;
const VIDEO_QUALITY = 0.58;
const AUDIO_FRAME = 4096;

function downsampleToInt16(float32, outRate, inRate) {
  const ratio = inRate / outRate;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)] || 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
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
    this.audioCtx = null;
    this.processor = null;
    this.audioSource = null;
    this.silentGain = null;
    this.peers = new Map(); // peerId -> { canvas, ctx, stream, audioCtx, audioDest, nextTime }
    this._onVideo = this._onVideo.bind(this);
    this._onAudio = this._onAudio.bind(this);
    this.socket.on('relay:video', this._onVideo);
    this.socket.on('relay:audio', this._onAudio);
  }

  setLocalStream(stream) {
    this.localStream = stream || null;
  }

  start() {
    if (this.sending) return;
    this.sending = true;
    this._startVideoLoop();
    this._startAudioLoop().catch((err) => this.onError(err.message || 'relay audio'));
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

    for (const peerId of [...this.peers.keys()]) this.removePeer(peerId);
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
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioDest = audioCtx.createMediaStreamDestination();
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
      nextTime: audioCtx.currentTime + 0.15,
      img: new Image(),
    };
    this.peers.set(peerId, p);
    this.onRemoteStream(peerId, stream);
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

    const attach = () => {
      if (!this.localStream) return;
      if (video.srcObject !== this.localStream) {
        video.srcObject = this.localStream;
        video.play().catch(() => {});
      }
    };
    attach();

    this.timer = setInterval(() => {
      if (!this.sending) return;
      attach();
      if (!video.videoWidth) return;
      ctx.drawImage(video, 0, 0, VIDEO_W, VIDEO_H);
      canvas.toBlob(
        (blob) => {
          if (!blob || !this.sending) return;
          blob.arrayBuffer().then((buf) => {
            this.socket.emit('relay:video', buf);
          });
        },
        'image/jpeg',
        VIDEO_QUALITY
      );
    }, Math.round(1000 / VIDEO_FPS));
  }

  async _startAudioLoop() {
    if (!this.localStream?.getAudioTracks().length) return;
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

    const outRate = 16000;
    this.processor.onaudioprocess = (ev) => {
      if (!this.sending) return;
      const input = ev.inputBuffer.getChannelData(0);
      const pcm = downsampleToInt16(input, outRate, this.audioCtx.sampleRate);
      this.socket.emit(
        'relay:audio',
        pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)
      );
    };
  }

  _onVideo({ from, data }) {
    if (!from || from === this.selfId || !data) return;
    const p = this._ensurePeer(from);
    const bytes = data instanceof ArrayBuffer ? data : data.buffer || data;
    const blob = new Blob([bytes], { type: 'image/jpeg' });
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

  _onAudio({ from, data }) {
    if (!from || from === this.selfId || !data) return;
    const p = this._ensurePeer(from);
    let u8;
    if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (ArrayBuffer.isView(data)) u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    else return;
    if (u8.byteLength < 2) return;
    const int16 = new Int16Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 2));
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }
    const sampleRate = 16000;
    const buf = p.audioCtx.createBuffer(1, float32.length, sampleRate);
    buf.copyToChannel(float32, 0);
    const src = p.audioCtx.createBufferSource();
    src.buffer = buf;
    src.connect(p.audioDest);
    const now = p.audioCtx.currentTime;
    if (p.nextTime < now + 0.05) p.nextTime = now + 0.05;
    src.start(p.nextTime);
    p.nextTime += buf.duration;
  }
}
