function isMobile() {
  return (
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '') ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform || ''))
  );
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
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

export class MeshCall {
  constructor({ socket, selfId, iceConfig, onRemoteStream, onPeerLeft, onError, onPeerState }) {
    this.socket = socket;
    this.selfId = selfId;
    this.iceConfig = iceConfig || DEFAULT_ICE;
    this.onRemoteStream = onRemoteStream;
    this.onPeerLeft = onPeerLeft;
    this.onError = onError || (() => {});
    this.onPeerState = onPeerState || (() => {});
    this.pcs = new Map();
    this.pendingIce = new Map();
    this.remoteStreams = new Map();
    this.makingOffer = new Set();
    this.ignoreOffer = Object.create(null);
    this.localStream = null;
    this.screenStream = null;
    this.retryTimers = new Map();
  }

  setLocalStream(stream) {
    this.localStream = stream || new MediaStream();
  }

  async initLocal({ audio = true, video = true } = {}) {
    this.localStream = await getMediaSafe({ audio, video });
    return this.localStream;
  }

  // Only the joining client should call this with initiator:true.
  // Existing peers must wait for the inbound offer and answer it.
  async connectToPeer(peerId, { initiator = true } = {}) {
    if (peerId === this.selfId) return;
    if (!initiator) return;

    if (this.pcs.has(peerId)) {
      await this.safeOffer(peerId);
      return;
    }

    const pc = this.createPeerConnection(peerId);
    this.attachLocalMedia(pc);
    await this.safeOffer(peerId);
    this.scheduleRetry(peerId);
  }

  attachLocalMedia(pc) {
    const stream = this.localStream || new MediaStream();
    const audio =
      stream.getAudioTracks().find((t) => t.readyState === 'live') ||
      stream.getAudioTracks()[0] ||
      null;
    const video =
      stream.getVideoTracks().find((t) => t.readyState === 'live') ||
      stream.getVideoTracks()[0] ||
      null;

    const ensureKind = (kind, track) => {
      const existingSender = pc.getSenders().find((s) => s.track && s.track.kind === kind);
      if (existingSender) {
        if (track && existingSender.track !== track) {
          existingSender.replaceTrack(track);
        }
        return;
      }

      // After a remote offer, a sender may exist with null track for this kind.
      const transceiver = pc
        .getTransceivers()
        .find((t) => t.receiver.track && t.receiver.track.kind === kind && !t.sender.track);

      if (track) {
        if (transceiver) {
          transceiver.sender.replaceTrack(track);
          try {
            transceiver.direction = 'sendrecv';
          } catch (_) {
            /* ignore */
          }
        } else {
          pc.addTrack(track, stream);
        }
      } else if (!pc.getTransceivers().some((t) => t.receiver.track && t.receiver.track.kind === kind)) {
        pc.addTransceiver(kind, { direction: 'recvonly' });
      }
    };

    ensureKind('audio', audio);
    ensureKind('video', video);
  }

  createPeerConnection(peerId) {
    const pc = new RTCPeerConnection(this.iceConfig);
    this.pcs.set(peerId, pc);
    if (!this.pendingIce.has(peerId)) this.pendingIce.set(peerId, []);

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.socket.emit('signal', {
        to: peerId,
        data: {
          type: 'ice',
          candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
        },
      });
    };

    pc.ontrack = (event) => {
      let stream;
      if (event.streams && event.streams[0]) {
        stream = event.streams[0];
      } else {
        stream = this.remoteStreams.get(peerId) || new MediaStream();
        if (!stream.getTracks().includes(event.track)) {
          stream.addTrack(event.track);
        }
      }
      this.remoteStreams.set(peerId, stream);
      event.track.onunmute = () => this.onRemoteStream(peerId, stream);
      this.onRemoteStream(peerId, stream);
      this.clearRetry(peerId);
    };

    pc.onconnectionstatechange = () => {
      this.onPeerState(peerId, pc.connectionState);
      if (pc.connectionState === 'connected') this.clearRetry(peerId);
      if (pc.connectionState === 'failed') {
        try {
          pc.restartIce();
        } catch (_) {
          /* ignore */
        }
        this.scheduleRetry(peerId, 800);
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        this.clearRetry(peerId);
      }
      if (pc.iceConnectionState === 'failed') {
        try {
          pc.restartIce();
        } catch (_) {
          /* ignore */
        }
      }
    };

    // Disabled: auto-offers here caused glare and missing remote video.
    pc.onnegotiationneeded = () => {};

    return pc;
  }

  scheduleRetry(peerId, delay = 2500) {
    this.clearRetry(peerId);
    const timer = setTimeout(async () => {
      const pc = this.pcs.get(peerId);
      if (!pc) return;
      if (pc.connectionState === 'connected' && this.remoteStreams.get(peerId)) return;
      try {
        await this.safeOffer(peerId);
      } catch (_) {
        /* ignore */
      }
    }, delay);
    this.retryTimers.set(peerId, timer);
  }

  clearRetry(peerId) {
    const t = this.retryTimers.get(peerId);
    if (t) clearTimeout(t);
    this.retryTimers.delete(peerId);
  }

  async safeOffer(peerId) {
    const pc = this.pcs.get(peerId);
    if (!pc) return;
    if (this.makingOffer.has(peerId)) return;
    if (pc.signalingState !== 'stable') return;

    try {
      this.makingOffer.add(peerId);
      this.attachLocalMedia(pc);
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      this.socket.emit('signal', {
        to: peerId,
        data: {
          type: 'sdp',
          sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        },
      });
    } catch (err) {
      console.error('offer failed', err);
      this.onError(err.message || 'offer failed');
    } finally {
      this.makingOffer.delete(peerId);
    }
  }

  async flushIce(peerId) {
    const pc = this.pcs.get(peerId);
    const queued = this.pendingIce.get(peerId) || [];
    if (!pc?.remoteDescription) return;
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
    try {
      if (data.type === 'sdp' && data.sdp) {
        await this.handleSdp(from, data.sdp);
      } else if (data.type === 'ice' && data.candidate) {
        await this.handleIce(from, data.candidate);
      }
    } catch (err) {
      console.error('signal error', err);
      this.onError(err.message || 'Ошибка WebRTC сигнала');
    }
  }

  async handleSdp(from, description) {
    let pc = this.pcs.get(from);

    const offerCollision =
      description.type === 'offer' &&
      pc &&
      (this.makingOffer.has(from) || pc.signalingState !== 'stable');

    const weAreInitiator =
      this.makingOffer.has(from) || (pc && pc.signalingState === 'have-local-offer');
    if (offerCollision) {
      if (weAreInitiator) {
        this.ignoreOffer[from] = true;
        return;
      }
      try {
        await pc.setLocalDescription({ type: 'rollback' });
      } catch (_) {
        /* ignore */
      }
    }

    if (!pc) {
      pc = this.createPeerConnection(from);
    }

    this.ignoreOffer[from] = false;

    if (description.type === 'offer') {
      // Answerer path: remote offer first, then local tracks, then answer.
      await pc.setRemoteDescription(description);
      await this.flushIce(from);
      this.attachLocalMedia(pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.socket.emit('signal', {
        to: from,
        data: {
          type: 'sdp',
          sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
        },
      });
    } else {
      await pc.setRemoteDescription(description);
      await this.flushIce(from);
    }
  }

  async handleIce(from, candidate) {
    const pc = this.pcs.get(from);
    if (!pc || !pc.remoteDescription) {
      const q = this.pendingIce.get(from) || [];
      q.push(candidate);
      this.pendingIce.set(from, q);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch (err) {
      if (!this.ignoreOffer[from]) console.warn('ice error', err);
    }
  }

  async replaceVideoTrack(track) {
    for (const pc of this.pcs.values()) {
      const vs = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
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
      const audioSender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
      const videoSender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');

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
    this.clearRetry(peerId);
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
