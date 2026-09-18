function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''));
}

function preferMobileConstraints(audio = true, video = true) {
  const mobile = isMobile();
  return {
    audio: audio
      ? {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      : false,
    video: video
      ? mobile
        ? {
            facingMode: { ideal: 'user' },
            width: { ideal: 640 },
            height: { ideal: 360 },
            frameRate: { ideal: 24, max: 30 },
          }
        : {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          }
      : false,
  };
}

export async function getMediaSafe({ audio = true, video = true } = {}) {
  if (!window.isSecureContext) {
    const err = new Error('INSECURE_CONTEXT');
    err.code = 'INSECURE_CONTEXT';
    throw err;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    const err = new Error('MEDIA_UNAVAILABLE');
    err.code = 'MEDIA_UNAVAILABLE';
    throw err;
  }

  const attempts = [
    preferMobileConstraints(audio, video),
    { audio: !!audio, video: video ? { facingMode: 'user' } : false },
    { audio: !!audio, video: !!video },
    { audio: true, video: false },
  ];

  let lastError;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('getUserMedia failed');
}

const DEFAULT_ICE = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceCandidatePoolSize: 8,
};

export class MeshCall {
  /**
   * @param {object} opts
   * @param {any} opts.socket
   * @param {string} opts.selfId
   * @param {RTCConfiguration} [opts.iceConfig]
   * @param {(peerId: string, stream: MediaStream) => void} opts.onRemoteStream
   * @param {(peerId: string) => void} opts.onPeerLeft
   * @param {(msg: string) => void} [opts.onError]
   */
  constructor({ socket, selfId, iceConfig, onRemoteStream, onPeerLeft, onError }) {
    this.socket = socket;
    this.selfId = selfId;
    this.iceConfig = iceConfig || DEFAULT_ICE;
    this.onRemoteStream = onRemoteStream;
    this.onPeerLeft = onPeerLeft;
    this.onError = onError || (() => {});
    /** @type {Map<string, RTCPeerConnection>} */
    this.pcs = new Map();
    /** @type {Map<string, RTCIceCandidateInit[]>} */
    this.pendingIce = new Map();
    /** @type {Map<string, MediaStream>} */
    this.remoteStreams = new Map();
    /** @type {MediaStream | null} */
    this.localStream = null;
    /** @type {MediaStream | null} */
    this.screenStream = null;
    this.makingOffer = new Set();
    /** @type {Record<string, boolean>} */
    this.ignoreOffer = Object.create(null);
    this.isSettingRemote = new Set();
  }

  async initLocal({ audio = true, video = true } = {}) {
    this.localStream = await getMediaSafe({ audio, video });
    return this.localStream;
  }

  setLocalStream(stream) {
    this.localStream = stream || new MediaStream();
  }

  /**
   * Только инициатор (обычно новый участник) создаёт offer.
   * Существующие пиры ждут входящий offer и отвечают answer.
   */
  async connectToPeer(peerId, { initiator = true } = {}) {
    if (peerId === this.selfId || this.pcs.has(peerId)) return;
    const pc = this.createPeerConnection(peerId);
    this.addLocalTracks(pc);
    if (initiator) {
      await this.safeOffer(peerId);
    }
  }

  addLocalTracks(pc) {
    const stream = this.localStream;
    if (stream && stream.getTracks().length) {
      for (const track of stream.getTracks()) {
        const already = pc.getSenders().some((s) => s.track === track);
        if (!already) pc.addTrack(track, stream);
      }
    } else {
      // recvonly, чтобы всё равно принимать чужое медиа
      if (!pc.getTransceivers().some((t) => t.receiver?.track?.kind === 'audio')) {
        pc.addTransceiver('audio', { direction: 'recvonly' });
      }
      if (!pc.getTransceivers().some((t) => t.receiver?.track?.kind === 'video')) {
        pc.addTransceiver('video', { direction: 'recvonly' });
      }
    }
  }

  createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(this.iceConfig);
    this.pcs.set(peerId, pc);
    this.pendingIce.set(peerId, []);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          to: peerId,
          data: { type: 'ice', candidate: event.candidate.toJSON?.() || event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      let stream = this.remoteStreams.get(peerId);
      if (!stream) {
        stream = event.streams?.[0] ? new MediaStream(event.streams[0].getTracks()) : new MediaStream();
        this.remoteStreams.set(peerId, stream);
      }
      if (!stream.getTracks().includes(event.track)) {
        stream.addTrack(event.track);
      }
      event.track.onended = () => {
        try { stream.removeTrack(event.track); } catch (_) { /* ignore */ }
        this.onRemoteStream(peerId, stream);
      };
      this.onRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'failed') {
        try {
          pc.restartIce();
        } catch (_) {
          /* ignore */
        }
        // Повторный offer только если мы «младший» id (стабильный инициатор)
        if (this.selfId > peerId) {
          this.safeOffer(peerId).catch(() => {});
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch (_) { /* ignore */ }
      }
    };

    // Не полагаемся на negotiationneeded для первичного коннекта —
    // им управляет connectToPeer(initiator), чтобы не было glare.
    pc.onnegotiationneeded = async () => {
      if (!this.pcs.has(peerId)) return;
      if (this.makingOffer.has(peerId) || this.isSettingRemote.has(peerId)) return;
      if (pc.signalingState !== 'stable') return;
      // После replaceTrack / screen share — только стабильный initiator
      if (this.selfId > peerId) {
        try {
          await this.safeOffer(peerId);
        } catch (err) {
          this.onError(err.message || 'negotiation error');
        }
      }
    };

    return pc;
  }

  async safeOffer(peerId) {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    if (this.makingOffer.has(peerId)) return;
    try {
      this.makingOffer.add(peerId);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      this.socket.emit('signal', {
        to: peerId,
        data: { type: 'sdp', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } },
      });
    } finally {
      this.makingOffer.delete(peerId);
    }
  }

  async flushIce(peerId) {
    const pc = this.pcs.get(peerId);
    const queued = this.pendingIce.get(peerId) || [];
    if (!pc || !pc.remoteDescription) return;
    this.pendingIce.set(peerId, []);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('flush ice', err);
      }
    }
  }

  async handleSignal(from, data) {
    let pc = this.pcs.get(from);
    if (!pc) {
      pc = this.createPeerConnection(from);
      this.addLocalTracks(pc);
    }

    try {
      if (data.type === 'sdp' && data.sdp) {
        const description = data.sdp;
        const offerCollision =
          description.type === 'offer' &&
          (this.makingOffer.has(from) || pc.signalingState !== 'stable');

        // Perfect negotiation: impolite peer ignores colliding offers
        const polite = this.selfId > from;
        const ignore = !polite && offerCollision;
        this.ignoreOffer[from] = ignore;
        if (ignore) return;

        this.isSettingRemote.add(from);
        await pc.setRemoteDescription(description);
        this.isSettingRemote.delete(from);
        await this.flushIce(from);

        if (description.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('signal', {
            to: from,
            data: {
              type: 'sdp',
              sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            },
          });
        }
      } else if (data.type === 'ice' && data.candidate) {
        if (!pc.remoteDescription) {
          const q = this.pendingIce.get(from) || [];
          q.push(data.candidate);
          this.pendingIce.set(from, q);
        } else {
          try {
            await pc.addIceCandidate(data.candidate);
          } catch (err) {
            if (!this.ignoreOffer[from]) console.warn('ice error', err);
          }
        }
      }
    } catch (err) {
      this.isSettingRemote.delete(from);
      console.error('signal error', err);
      this.onError(err.message || 'Ошибка WebRTC сигнала');
    }
  }

  async replaceVideoTrack(track) {
    for (const pc of this.pcs.values()) {
      const vs = pc.getSenders().find((s) => s.track?.kind === 'video');
      if (vs) await vs.replaceTrack(track);
      else if (track) pc.addTrack(track, this.localStream || new MediaStream([track]));
    }
  }

  async replaceLocalTracks(stream) {
    const old = this.localStream;
    this.localStream = stream || new MediaStream();
    const audioTrack = this.localStream.getAudioTracks()[0] || null;
    const videoTrack = this.localStream.getVideoTracks()[0] || null;

    for (const pc of this.pcs.values()) {
      const senders = pc.getSenders();
      const audioSender = senders.find((s) => s.track?.kind === 'audio');
      const videoSender = senders.find((s) => s.track?.kind === 'video');

      if (audioTrack) {
        if (audioSender) await audioSender.replaceTrack(audioTrack);
        else pc.addTrack(audioTrack, this.localStream);
      }
      if (videoTrack) {
        if (videoSender) await videoSender.replaceTrack(videoTrack);
        else pc.addTrack(videoTrack, this.localStream);
      }
    }

    old?.getTracks().forEach((t) => {
      if (!this.localStream.getTracks().includes(t) && t.readyState === 'live') t.stop();
    });
  }

  async setAudioEnabled(enabled) {
    this.localStream?.getAudioTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  async setVideoEnabled(enabled) {
    if (this.screenStream) return;
    this.localStream?.getVideoTracks().forEach((t) => {
      t.enabled = enabled;
    });
  }

  async startScreenShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('Демонстрация экрана не поддерживается на этом устройстве');
    }
    const screen = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    this.screenStream = screen;
    const track = screen.getVideoTracks()[0];
    await this.replaceVideoTrack(track);
    track.onended = () => {
      this.stopScreenShare();
    };
    return screen;
  }

  async stopScreenShare() {
    if (!this.screenStream) return null;
    this.screenStream.getTracks().forEach((t) => t.stop());
    this.screenStream = null;
    const camTrack = this.localStream?.getVideoTracks()[0] || null;
    if (camTrack) await this.replaceVideoTrack(camTrack);
    return camTrack;
  }

  removePeer(peerId) {
    const pc = this.pcs.get(peerId);
    if (pc) {
      pc.close();
      this.pcs.delete(peerId);
    }
    this.pendingIce.delete(peerId);
    this.remoteStreams.delete(peerId);
    this.onPeerLeft(peerId);
  }

  destroy() {
    for (const peerId of [...this.pcs.keys()]) this.removePeer(peerId);
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.screenStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    this.screenStream = null;
  }
}
