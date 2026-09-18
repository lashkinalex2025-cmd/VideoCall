const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

export class MeshCall {
  /**
   * @param {object} opts
   * @param {import('socket.io-client').Socket | any} opts.socket
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
    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: audio
        ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          }
        : false,
      video: video
        ? {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            facingMode: 'user',
          }
        : false,
    });
    return this.localStream;
  }

  async connectToPeer(peerId) {
    if (peerId === this.selfId || this.pcs.has(peerId)) return;
    const pc = this.createPeerConnection(peerId);
    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        pc.addTrack(track, this.localStream);
      }
    }
    // Initiator creates offer when we are the "impolite" side or always try
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
      const [stream] = event.streams;
      if (stream) this.onRemoteStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
        // keep for a bit; cleanup happens on participant:left
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
      await pc.setLocalDescription(await pc.createOffer());
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
    const screen = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
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
