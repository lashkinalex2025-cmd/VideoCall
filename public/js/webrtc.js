const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    // Public TURN — нужен для многих мобильных сетей (NAT)
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 4,
};

function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
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
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
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

export class MeshCall {
  /**
   * @param {object} opts
   * @param {any} opts.socket
   * @param {string} opts.selfId
   * @param {(peerId: string, stream: MediaStream) => void} opts.onRemoteStream
   * @param {(peerId: string) => void} opts.onPeerLeft
   * @param {(msg: string) => void} [opts.onError]
   */
  constructor({ socket, selfId, onRemoteStream, onPeerLeft, onError }) {
    this.socket = socket;
    this.selfId = selfId;
    this.onRemoteStream = onRemoteStream;
    this.onPeerLeft = onPeerLeft;
    this.onError = onError || (() => {});
    /** @type {Map<string, RTCPeerConnection>} */
    this.pcs = new Map();
    /** @type {MediaStream | null} */
    this.localStream = null;
    /** @type {MediaStream | null} */
    this.screenStream = null;
    this.makingOffer = new Set();
    this.ignoreOffer = new Set();
    this.polite = (peerId) => this.selfId > peerId;
  }

  async initLocal({ audio = true, video = true } = {}) {
    this.localStream = await getMediaSafe({ audio, video });
    return this.localStream;
  }

  async connectToPeer(peerId) {
    if (peerId === this.selfId || this.pcs.has(peerId)) return;
    const pc = this.createPeerConnection(peerId);
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    } else {
      // Ensure transceiver exists so remote media can still arrive
      pc.addTransceiver('audio', { direction: 'recvonly' });
      pc.addTransceiver('video', { direction: 'recvonly' });
    }
    await this.safeOffer(peerId);
  }

  createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    this.pcs.set(peerId, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('signal', {
          to: peerId,
          data: { type: 'ice', candidate: event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      let stream = event.streams && event.streams[0];
      if (!stream) {
        stream = new MediaStream([event.track]);
      }
      this.onRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        pc.restartIce?.();
        this.safeOffer(peerId).catch(() => {});
      }
    };

    pc.onnegotiationneeded = async () => {
      try {
        await this.safeOffer(peerId);
      } catch (err) {
        this.onError(err.message || 'negotiation error');
      }
    };

    return pc;
  }

  async safeOffer(peerId) {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    try {
      this.makingOffer.add(peerId);
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });
      if (pc.signalingState !== 'stable' && pc.signalingState !== 'have-local-offer') {
        return;
      }
      await pc.setLocalDescription(offer);
      this.socket.emit('signal', {
        to: peerId,
        data: { type: 'sdp', sdp: pc.localDescription },
      });
    } finally {
      this.makingOffer.delete(peerId);
    }
  }

  async handleSignal(from, data) {
    let pc = this.pcs.get(from);
    if (!pc) {
      pc = this.createPeerConnection(from);
      if (this.localStream) {
        for (const track of this.localStream.getTracks()) {
          pc.addTrack(track, this.localStream);
        }
      }
    }

    try {
      if (data.type === 'sdp') {
        const description = data.sdp;
        const offerCollision =
          description.type === 'offer' &&
          (this.makingOffer.has(from) || pc.signalingState !== 'stable');

        const ignore = !this.polite(from) && offerCollision;
        if (ignore) return;

        await pc.setRemoteDescription(description);
        if (description.type === 'offer') {
          await pc.setLocalDescription(await pc.createAnswer());
          this.socket.emit('signal', {
            to: from,
            data: { type: 'sdp', sdp: pc.localDescription },
          });
        }
      } else if (data.type === 'ice' && data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          if (!this.ignoreOffer.has(from)) throw err;
        }
      }
    } catch (err) {
      console.error('signal error', err);
      this.onError(err.message || 'Ошибка WebRTC сигнала');
    }
  }

  async replaceVideoTrack(track) {
    for (const pc of this.pcs.values()) {
      const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      else if (track) pc.addTrack(track, this.localStream || new MediaStream([track]));
    }
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
