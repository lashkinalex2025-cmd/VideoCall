import { MeshCall, getMediaSafe } from './webrtc.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function isSecureEnough() {
  return window.isSecureContext === true;
}

function showSecureBannerIfNeeded() {
  const banner = $('#secureBanner');
  if (!banner) return;
  const insecure = !isSecureEnough();
  banner.classList.toggle('hidden', !insecure);
  if (insecure) {
    console.warn('Insecure context: camera/mic blocked on mobile browsers');
  }
}

async function showPhoneHint() {
  const box = $('#phoneHint');
  const links = $('#phoneHintLinks');
  if (!box || !links) return;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || '');
  if (mobile) {
    box.classList.add('hidden');
    return;
  }
  try {
    const info = await fetch('/api/info').then((r) => r.json());
    if (!info?.lanHttps?.length) {
      box.classList.add('hidden');
      return;
    }
    links.innerHTML = info.lanHttps
      .map((url) => `<div><a href="${url}" target="_blank" rel="noopener">${url}</a></div>`)
      .join('');
    box.classList.remove('hidden');
  } catch (_) {
    box.classList.add('hidden');
  }
}

const state = {
  socket: null,
  call: null,
  self: null,
  room: null,
  peers: new Map(),
  streams: new Map(),
  peerStates: new Map(),
  audioEnabled: true,
  videoEnabled: true,
  screenSharing: false,
  handRaised: false,
  recording: false,
  mediaRecorder: null,
  recordedChunks: [],
  transcriptOn: false,
  recognition: null,
  transcript: [],
  meetingStartedAt: null,
  deferredInstall: null,
};

function toast(msg, ms = 2800) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function showView(id) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === id));
}

function canModerate() {
  return state.self && (state.self.role === 'host' || state.self.role === 'cohost');
}

function isHost() {
  return state.self?.role === 'host';
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function saveLobbyName(name) {
  localStorage.setItem('vc_name', name);
}

function loadLobbyName() {
  return localStorage.getItem('vc_name') || '';
}

function initLobby() {
  const saved = loadLobbyName();
  if (saved) {
    $('#createName').value = saved;
    $('#joinName').value = saved;
  }

  $('#createUsePassword').addEventListener('change', (e) => {
    $('#createPasswordWrap').classList.toggle('hidden', !e.target.checked);
  });

  $('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#createName').value.trim();
    const roomName = $('#createRoomName').value.trim() || 'Конференция';
    const roomId = $('#createRoomId').value.trim();
    const usePassword = $('#createUsePassword').checked;
    const password = usePassword ? $('#createPassword').value : '';
    if (usePassword && !password) return toast('Укажите пароль или снимите галочку');
    saveLobbyName(name);

    // Важно: камера/мик на iOS только из жеста пользователя — запрашиваем СРАЗУ
    const localStream = await acquireMediaInGesture();

    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roomName, roomId: roomId || undefined, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      localStream?.getTracks().forEach((t) => t.stop());
      return toast(data.error || 'Ошибка создания');
    }
    await enterRoom({ roomId: data.id, name, password, localStream });
  });

  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    const roomId = $('#joinRoomId').value.trim();
    const password = $('#joinPassword').value;
    saveLobbyName(name);
    const localStream = await acquireMediaInGesture();
    await enterRoom({ roomId, name, password, localStream });
  });

  const params = new URLSearchParams(location.search);
  const qRoom = params.get('room');
  if (qRoom) {
    $('#joinRoomId').value = qRoom;
    showView('lobby');
    const joinCard = $('#joinForm');
    if (joinCard) {
      joinCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Нажмите «Присоединиться» и разрешите камеру/микрофон');
    }
  }
}

/**
 * getUserMedia должен вызываться сразу из клика/submit — иначе iOS/Android блокируют.
 */
async function acquireMediaInGesture() {
  if (!isSecureEnough()) {
    showSecureBannerIfNeeded();
    toast('Откройте приложение по HTTPS');
    return null;
  }
  try {
    const stream = await getMediaSafe({ audio: true, video: true });
    state.audioEnabled = true;
    state.videoEnabled = Boolean(stream.getVideoTracks().length);
    return stream;
  } catch (err) {
    console.warn('media gesture failed', err);
    try {
      const audioOnly = await getMediaSafe({ audio: true, video: false });
      state.audioEnabled = true;
      state.videoEnabled = false;
      toast('Камера недоступна — только микрофон');
      return audioOnly;
    } catch (err2) {
      state.audioEnabled = false;
      state.videoEnabled = false;
      if (err?.code === 'INSECURE_CONTEXT') {
        toast('Нужен HTTPS для камеры на телефоне');
      } else {
        toast('Нет доступа к камере/микрофону — зайдите и нажмите 🎤/📷');
      }
      return new MediaStream();
    }
  }
}

async function loadIceConfig() {
  try {
    const cfg = await fetch('/api/ice', { cache: 'no-store' }).then((r) => r.json());
    if (cfg?.iceServers?.length) {
      return {
        iceServers: cfg.iceServers,
        iceTransportPolicy: cfg.iceTransportPolicy || 'all',
        iceCandidatePoolSize: cfg.iceCandidatePoolSize || 8,
        bundlePolicy: cfg.bundlePolicy || 'max-bundle',
        rtcpMuxPolicy: cfg.rtcpMuxPolicy || 'require',
      };
    }
  } catch (err) {
    console.warn('ICE fetch failed', err);
  }
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    iceCandidatePoolSize: 8,
  };
}

async function enterRoom({ roomId, name, password, localStream = null }) {
  if (!isSecureEnough()) {
    showSecureBannerIfNeeded();
    toast('Откройте приложение по HTTPS (см. баннер сверху)');
    return;
  }

  toast('Подключение…');

  // Если медиа ещё не взяли (редкий путь) — пробуем сейчас
  if (!localStream) {
    localStream = await acquireMediaInGesture();
  }

  if (!state.socket) {
    state.socket = io({
      transports: ['websocket', 'polling'],
      upgrade: true,
      rememberUpgrade: true,
      forceNew: false,
    });
    wireSocket();
  }

  if (!state.socket.connected) {
    try {
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('Нет связи с сервером')), 12000);
        state.socket.once('connect', () => {
          clearTimeout(t);
          resolve();
        });
        state.socket.once('connect_error', (err) => {
          clearTimeout(t);
          reject(err);
        });
        if (state.socket.disconnected) state.socket.connect();
      });
    } catch (err) {
      toast(err.message || 'Сервер недоступен');
      return;
    }
  }

  const iceConfig = await loadIceConfig();

  state.socket.emit('room:join', { roomId, name, password }, async (res) => {
    if (!res?.ok) {
      toast(res?.error || 'Не удалось войти');
      return;
    }

    state.self = res.self;
    state.room = res.room;
    state.meetingStartedAt = Date.now();
    state.transcript = (res.transcriptSegments || []).map((s) => ({
      fromName: s.fromName,
      text: s.text,
      at: s.at,
    }));
    state.peers.clear();
    state.streams.clear();
    state.peerStates.clear();
    for (const p of res.peers || []) state.peers.set(p.id, p);
    for (const p of res.room.participants || []) {
      if (p.id !== state.self.id) state.peers.set(p.id, p);
    }

    showView('room');
    updateRoomHeader();
    renderPeople();
    renderChatHistory(res.chatHistory || []);
    renderTranscript();
    syncPermissionForm();
    updateSettingsAccess();

    try {
      state.call?.destroy();
      state.call = new MeshCall({
        socket: state.socket,
        selfId: state.self.id,
        iceConfig,
        onRemoteStream: (peerId, stream) => {
          state.streams.set(peerId, stream);
          renderVideos();
        },
        onPeerLeft: (peerId) => {
          state.streams.delete(peerId);
          state.peerStates.delete(peerId);
          renderVideos();
        },
        onPeerState: (peerId, connState) => {
          state.peerStates.set(peerId, connState);
          renderVideos();
        },
        onError: (m) => console.warn(m),
      });

      state.call.setLocalStream(localStream || new MediaStream());
      state.audioEnabled = Boolean(localStream?.getAudioTracks().some((t) => t.enabled !== false && t.readyState !== 'ended'));
      state.videoEnabled = Boolean(localStream?.getVideoTracks().some((t) => t.enabled !== false && t.readyState !== 'ended'));

      $('#micBtn').classList.toggle('off', !state.audioEnabled);
      $('#camBtn').classList.toggle('off', !state.videoEnabled);

      renderVideos();

      // Только НОВЫЙ участник инициирует WebRTC к уже сидящим.
      // Старые участники ждут offer и отвечают answer — иначе glare и нет чужого видео.
      for (const peer of state.peers.values()) {
        await state.call.connectToPeer(peer.id, { initiator: true });
      }

      emitMediaState();
      history.replaceState({}, '', `/?room=${encodeURIComponent(state.room.id)}`);
      toast(`Вы в комнате «${state.room.name}»`);
    } catch (err) {
      console.error(err);
      toast(err.message || 'Ошибка медиа');
    }
  });
}

function wireSocket() {
  const s = state.socket;

  s.on('participant:joined', (p) => {
    state.peers.set(p.id, p);
    renderPeople();
    updateChatTargets();
    toast(`${p.name} присоединился(ась)`);
    // Не трогаем WebRTC здесь: оффер шлёт только новый участник.
    // Иначе glare / одностороннее видео (хост ↔ планшет).
    renderVideos();
  });

  s.on('participant:left', (payload) => {
    state.peers.delete(payload.id);
    state.call?.removePeer(payload.id);
    renderPeople();
    updateChatTargets();
    renderVideos();
  });

  s.on('participant:updated', (p) => {
    if (p.id === state.self?.id) state.self = { ...state.self, ...p };
    else if (state.peers.has(p.id)) state.peers.set(p.id, { ...state.peers.get(p.id), ...p });
    if (p.id === state.room?.hostId || p.role === 'host') {
      state.room.hostId = p.id;
    }
    renderPeople();
    updateSettingsAccess();
  });

  s.on('room:host-changed', ({ hostId }) => {
    if (state.room) state.room.hostId = hostId;
    if (state.self?.id === hostId) {
      state.self.role = 'host';
      toast('Вы стали хостом');
    }
    renderPeople();
    updateSettingsAccess();
  });

  s.on('signal', async ({ from, data }) => {
    await state.call?.handleSignal(from, data);
  });

  s.on('media:state', (payload) => {
    const p = state.peers.get(payload.id);
    if (p) {
      Object.assign(p, payload);
      state.peers.set(payload.id, p);
      renderPeople();
      renderVideos();
    }
  });

  s.on('chat:message', (msg) => {
    appendChat(msg);
  });

  s.on('chat:cleared', (payload) => {
    $('#chatMessages').innerHTML = '';
    toast(`Чат очищен${payload?.byName ? ` (${payload.byName})` : ''}`);
  });

  s.on('transcript:segment', (seg) => {
    state.transcript.push({ fromName: seg.fromName, text: seg.text, at: seg.at });
    renderTranscript();
  });

  s.on('room:permissions', (perms) => {
    if (state.room) state.room.permissions = perms;
    syncPermissionForm();
    toast('Права комнаты обновлены');
  });

  s.on('room:meta', (meta) => {
    if (state.room) Object.assign(state.room, meta);
    updateRoomHeader();
  });

  s.on('moderation:force-mute', async ({ audio, video }) => {
    if (audio) {
      state.audioEnabled = false;
      await state.call?.setAudioEnabled(false);
      $('#micBtn').classList.add('off');
    }
    if (video) {
      state.videoEnabled = false;
      await state.call?.setVideoEnabled(false);
      $('#camBtn').classList.add('off');
    }
    emitMediaState();
    toast('Хост отключил ваши медиа');
  });

  s.on('moderation:kicked', ({ reason }) => {
    toast(reason || 'Вас исключили');
    leaveRoom(false);
  });
}

function emitMediaState() {
  state.socket?.emit('media:state', {
    audioEnabled: state.audioEnabled,
    videoEnabled: state.videoEnabled,
    screenSharing: state.screenSharing,
    handRaised: state.handRaised,
  });
}

async function applyFreshLocalStream(stream) {
  if (!state.call) return;
  await state.call.replaceLocalTracks(stream);
}

function updateRoomHeader() {
  if (!state.room) return;
  $('#roomNameLabel').textContent = state.room.name;
  const count = 1 + state.peers.size;
  $('#roomMeta').textContent = `ID: ${state.room.id} · ${count}/${state.room.maxParticipants || 100}` +
    (state.room.hasPassword ? ' · 🔒' : '');
}

/**
 * Safari/iPad/Android часто блокируют autoplay чужого видео со звуком.
 * Для remote: сначала muted → play → unmute. Для local: всегда muted.
 */
function ensureVideoPlaying(video, { remote = false } = {}) {
  const tryPlay = () => {
    if (remote && !video.muted) {
      // Сначала гарантируем старт без звука (политика autoplay)
      video.muted = true;
    }
    const p = video.play();
    if (!p || !p.then) {
      if (remote) unmuteRemoteSoon(video);
      return;
    }
    p.then(() => {
      if (remote) unmuteRemoteSoon(video);
    }).catch(() => {
      if (!remote) return;
      video.muted = true;
      video.play()
        .then(() => unmuteRemoteSoon(video))
        .catch(() => {});
    });
  };
  tryPlay();
  video.addEventListener('loadedmetadata', tryPlay, { once: true });
  video.addEventListener('canplay', tryPlay, { once: true });
}

function unmuteRemoteSoon(video) {
  setTimeout(() => {
    if (!video.isConnected) return;
    // Не включаем звук своему превью
    if (video.closest('.tile.self')) return;
    video.muted = false;
    video.play().catch(() => {
      video.muted = true;
    });
  }, 250);
}

function streamHasLiveVideo(stream) {
  return Boolean(
    stream &&
      stream.getVideoTracks().some((t) => t.readyState === 'live' && t.enabled !== false)
  );
}

function peerStatusLabel(entry) {
  if (entry.self) {
    if (!streamHasLiveVideo(entry.stream) && !entry.videoEnabled) return 'Камера выкл';
    if (!streamHasLiveVideo(entry.stream)) return 'Нет видео';
    return '';
  }
  const conn = entry.connState || 'new';
  const hasVideo = streamHasLiveVideo(entry.stream);
  const hasAudio = Boolean(
    entry.stream && entry.stream.getAudioTracks().some((t) => t.readyState === 'live')
  );
  if (hasVideo) return '';
  if (conn === 'failed' || conn === 'disconnected') return 'Нет связи';
  if (conn === 'connected' || conn === 'completed') {
    if (hasAudio) return entry.videoEnabled === false ? 'Камера выкл' : 'Нет видео';
    return 'Нет медиа';
  }
  if (conn === 'connecting' || conn === 'checking' || conn === 'new') return 'Подключение…';
  return 'Подключение…';
}

function renderVideos() {
  const grid = $('#videoGrid');
  if (!state.self) return;

  const entries = [];
  entries.push({
    id: state.self.id,
    name: `${state.self.name} (вы)`,
    stream: state.call?.localStream,
    self: true,
    audioEnabled: state.audioEnabled,
    videoEnabled: state.videoEnabled,
    screenSharing: state.screenSharing,
    handRaised: state.handRaised,
    role: state.self.role,
    connState: 'connected',
  });

  for (const p of state.peers.values()) {
    entries.push({
      id: p.id,
      name: p.name,
      stream: state.streams.get(p.id),
      self: false,
      audioEnabled: p.audioEnabled !== false,
      videoEnabled: p.videoEnabled !== false,
      screenSharing: p.screenSharing,
      handRaised: p.handRaised,
      role: p.role,
      connState: state.peerStates.get(p.id) || state.call?.getPeerConnectionState?.(p.id) || 'new',
    });
  }

  grid.classList.toggle('solo', entries.length === 1);
  const keep = new Set(entries.map((e) => e.id));

  // Удаляем плитки ушедших
  [...grid.querySelectorAll('.tile')].forEach((tile) => {
    if (!keep.has(tile.dataset.id)) tile.remove();
  });

  for (const e of entries) {
    let tile = [...grid.querySelectorAll('.tile')].find((t) => t.dataset.id === e.id);
    let video;
    let placeholder;
    if (!tile) {
      tile = document.createElement('div');
      tile.dataset.id = e.id;
      video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      video.setAttribute('playsinline', 'true');
      video.setAttribute('webkit-playsinline', 'true');
      video.setAttribute('autoplay', 'true');
      placeholder = document.createElement('div');
      placeholder.className = 'tile-placeholder';
      const meta = document.createElement('div');
      meta.className = 'tile-meta';
      tile.appendChild(video);
      tile.appendChild(placeholder);
      tile.appendChild(meta);
      grid.appendChild(tile);
    } else {
      video = tile.querySelector('video');
      placeholder = tile.querySelector('.tile-placeholder');
      if (!placeholder) {
        placeholder = document.createElement('div');
        placeholder.className = 'tile-placeholder';
        tile.insertBefore(placeholder, tile.querySelector('.tile-meta'));
      }
    }

    tile.className = 'tile' + (e.self ? ' self' : '') + (e.screenSharing ? ' screen-share' : '');
    // Своё — всегда muted (без эха).
    if (e.self) {
      video.muted = true;
      video.setAttribute('muted', 'true');
    }

    if (e.stream && video.srcObject !== e.stream) {
      video.srcObject = e.stream;
      ensureVideoPlaying(video, { remote: !e.self });
    } else if (e.stream) {
      ensureVideoPlaying(video, { remote: !e.self });
    }

    const status = peerStatusLabel(e);
    const showPlaceholder = Boolean(status);
    tile.classList.toggle('no-media', showPlaceholder);
    placeholder.textContent = status;
    placeholder.classList.toggle('hidden', !showPlaceholder);

    const meta = tile.querySelector('.tile-meta');
    meta.innerHTML = `
      <span>${escapeHtml(e.name)}${e.role === 'host' ? ' · хост' : e.role === 'cohost' ? ' · со-хост' : ''}</span>
      <div class="tile-badges">
        ${e.handRaised ? '<span class="badge live">✋</span>' : ''}
        ${e.screenSharing ? '<span class="badge live">экран</span>' : ''}
        <span class="badge ${e.audioEnabled ? '' : 'off'}">${e.audioEnabled ? 'mic' : 'mic off'}</span>
        <span class="badge ${e.videoEnabled || e.screenSharing ? '' : 'off'}">${e.videoEnabled || e.screenSharing ? 'cam' : 'cam off'}</span>
      </div>`;
  }
  updateRoomHeader();
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderPeople() {
  const list = $('#peopleList');
  list.innerHTML = '';
  const all = [state.self, ...state.peers.values()].filter(Boolean);
  for (const p of all) {
    const li = document.createElement('li');
    li.className = 'person';
    const isSelf = p.id === state.self?.id;
    li.innerHTML = `
      <div>
        <div class="name">${escapeHtml(p.name)}${isSelf ? ' (вы)' : ''}</div>
        <div class="role">${roleLabel(p.role)} · ${p.audioEnabled ? '🎤' : '🔇'} ${p.videoEnabled ? '📷' : '🚫'}${p.handRaised ? ' ✋' : ''}</div>
      </div>
      <div class="person-actions"></div>`;
    const actions = li.querySelector('.person-actions');
    if (!isSelf && canModerate()) {
      if (isHost() && p.role !== 'host') {
        const promote = btn(p.role === 'cohost' ? 'Убрать со-хоста' : 'Со-хост', () => {
          state.socket.emit('moderation:set-role', {
            id: p.id,
            role: p.role === 'cohost' ? 'participant' : 'cohost',
          }, (r) => { if (!r?.ok) toast(r?.error || 'Ошибка'); });
        });
        actions.appendChild(promote);
      }
      actions.appendChild(btn('Mute', () => {
        state.socket.emit('moderation:mute', { id: p.id }, (r) => {
          if (!r?.ok) toast(r?.error || 'Ошибка');
        });
      }));
      if (p.role !== 'host') {
        actions.appendChild(btn('Кик', () => {
          state.socket.emit('moderation:kick', { id: p.id }, (r) => {
            if (!r?.ok) toast(r?.error || 'Ошибка');
          });
        }));
      }
    }
    list.appendChild(li);
  }
  updateChatTargets();
}

function roleLabel(role) {
  return ({ host: 'Хост', cohost: 'Со-хост', participant: 'Участник', guest: 'Гость' })[role] || role;
}

function btn(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function updateChatTargets() {
  const select = $('#chatTarget');
  const current = select.value;
  select.innerHTML = '<option value="">Всем участникам</option>';
  for (const p of state.peers.values()) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `Лично: ${p.name}`;
    select.appendChild(opt);
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
}

function renderChatHistory(items) {
  $('#chatMessages').innerHTML = '';
  for (const msg of items) appendChat(msg, false);
}

function appendChat(msg, scroll = true) {
  const box = $('#chatMessages');
  const el = document.createElement('div');
  el.className = 'chat-item' + (msg.private ? ' private' : '');
  const who = msg.private
    ? `${msg.fromName} → ${msg.toName || 'вы'} (личное)`
    : msg.fromName;
  el.innerHTML = `
    <div class="meta"><span>${escapeHtml(who)}</span><span>${formatTime(msg.at)}</span></div>
    <div>${escapeHtml(msg.text)}</div>`;
  box.appendChild(el);
  if (scroll) box.scrollTop = box.scrollHeight;
}

function renderTranscript() {
  const view = $('#transcriptView');
  view.innerHTML = state.transcript.map((t) => `
    <div class="transcript-item">
      <div class="meta"><span>${escapeHtml(t.fromName)}</span><span>${formatTime(t.at)}</span></div>
      <div>${escapeHtml(t.text)}</div>
    </div>`).join('') || '<p class="hint">Транскрипция пока пуста. Включите её кнопкой выше (нужен Chrome/Edge и разрешение микрофона).</p>';
  view.scrollTop = view.scrollHeight;
}

function syncPermissionForm() {
  const perms = state.room?.permissions || {};
  $$('#tab-settings [data-perm]').forEach((input) => {
    input.checked = Boolean(perms[input.dataset.perm]);
  });
}

function updateSettingsAccess() {
  const allowed = canModerate();
  $('#hostOnlySettings').style.opacity = allowed ? '1' : '0.55';
  $('#hostOnlySettings').querySelectorAll('input,button').forEach((el) => {
    el.disabled = !allowed;
  });
  $('#settingsHint').textContent = allowed
    ? 'Изменения применяются сразу ко всем участникам.'
    : 'Настройки доступны только хосту и со-хостам.';
}

function initRoomControls() {
  $('#micBtn').addEventListener('click', async () => {
    if (!state.room?.permissions?.allowUnmute && !state.audioEnabled && !canModerate()) {
      return toast('Хост запретил включать микрофон');
    }
    try {
      const hasAudio = state.call?.localStream?.getAudioTracks()?.some((t) => t.readyState === 'live');
      if (!state.audioEnabled && !hasAudio) {
        const stream = await getMediaSafe({ audio: true, video: state.videoEnabled });
        await applyFreshLocalStream(stream);
        state.audioEnabled = true;
        state.videoEnabled = Boolean(stream.getVideoTracks().length);
      } else {
        state.audioEnabled = !state.audioEnabled;
        await state.call?.setAudioEnabled(state.audioEnabled);
      }
      $('#micBtn').classList.toggle('off', !state.audioEnabled);
      $('#camBtn').classList.toggle('off', !state.videoEnabled);
      emitMediaState();
      renderVideos();
    } catch (err) {
      toast('Не удалось включить микрофон');
    }
  });

  $('#camBtn').addEventListener('click', async () => {
    if (state.screenSharing) return toast('Сначала остановите демонстрацию экрана');
    if (!state.room?.permissions?.allowVideo && !state.videoEnabled && !canModerate()) {
      return toast('Хост запретил включать камеру');
    }
    try {
      const hasVideo = state.call?.localStream?.getVideoTracks()?.some((t) => t.readyState === 'live');
      if (!state.videoEnabled && !hasVideo) {
        const stream = await getMediaSafe({ audio: true, video: true });
        await applyFreshLocalStream(stream);
        state.audioEnabled = true;
        state.videoEnabled = true;
      } else {
        state.videoEnabled = !state.videoEnabled;
        await state.call?.setVideoEnabled(state.videoEnabled);
      }
      $('#micBtn').classList.toggle('off', !state.audioEnabled);
      $('#camBtn').classList.toggle('off', !state.videoEnabled);
      emitMediaState();
      renderVideos();
    } catch (err) {
      toast('Не удалось включить камеру — разрешите доступ в настройках браузера');
    }
  });

  if (!navigator.mediaDevices?.getDisplayMedia) {
    $('#screenBtn').classList.add('hidden');
  }

  $('#screenBtn').addEventListener('click', async () => {
    try {
      if (state.screenSharing) {
        await state.call.stopScreenShare();
        state.screenSharing = false;
        $('#screenBtn').classList.remove('active');
        emitMediaState();
        renderVideos();
        return;
      }
      if (!state.room?.permissions?.allowScreenShare && !canModerate()) {
        return toast('Демонстрация экрана запрещена');
      }
      if (!navigator.mediaDevices?.getDisplayMedia) {
        return toast('На iPhone/iPad демонстрация экрана в браузере недоступна');
      }
      await state.call.startScreenShare();
      state.screenSharing = true;
      $('#screenBtn').classList.add('active');
      emitMediaState();
      renderVideos();
      toast('Демонстрация экрана начата');
    } catch (err) {
      console.error(err);
      toast(err.message || 'Не удалось начать демонстрацию экрана');
    }
  });

  $('#handBtn').addEventListener('click', () => {
    state.handRaised = !state.handRaised;
    $('#handBtn').classList.toggle('active', state.handRaised);
    emitMediaState();
    renderVideos();
    renderPeople();
  });

  $('#recordBtn').addEventListener('click', async () => {
    if (state.recording) {
      stopRecording();
      return;
    }
    await startRecording();
  });

  $('#hangupBtn').addEventListener('click', () => leaveRoom(true));
  $('#leaveBtn').addEventListener('click', () => leaveRoom(true));

  $('#copyLinkBtn').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${encodeURIComponent(state.room.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Ссылка скопирована');
    } catch {
      prompt('Скопируйте ссылку:', url);
    }
  });

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${tab.dataset.tab}`));
      $('#sidePanel').classList.add('open');
      $('#sidePanel').classList.remove('collapsed');
    });
  });

  const openTab = (name) => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === `tab-${name}`));
    $('#sidePanel').classList.add('open');
    $('#sidePanel').classList.remove('collapsed');
  };

  const closeSidePanel = () => {
    $('#sidePanel').classList.remove('open');
    $('#sidePanel').classList.add('collapsed');
  };

  $('#backToConferenceBtn')?.addEventListener('click', () => {
    closeSidePanel();
    toast('Вы вернулись к конференции');
  });

  $('#toggleChatBtn').addEventListener('click', () => {
    const panel = $('#sidePanel');
    if (panel.classList.contains('open') && $('#tab-chat').classList.contains('active')) {
      closeSidePanel();
      return;
    }
    openTab('chat');
  });
  $('#toggleParticipantsBtn').addEventListener('click', () => openTab('people'));
  $('#toggleSettingsBtn').addEventListener('click', () => openTab('settings'));

  $('#clearChatBtn')?.addEventListener('click', () => {
    if (!confirm('Очистить чат для всех участников?')) return;
    state.socket?.emit('chat:clear', {}, (res) => {
      if (!res?.ok) toast(res?.error || 'Не удалось очистить чат');
    });
  });

  $('#chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    const to = $('#chatTarget').value || null;
    state.socket.emit('chat:message', { text, to }, (res) => {
      if (!res?.ok) toast(res?.error || 'Не отправлено');
      else $('#chatInput').value = '';
    });
  });

  $$('#tab-settings [data-perm]').forEach((input) => {
    input.addEventListener('change', () => {
      if (!canModerate()) return;
      const permissions = {};
      $$('#tab-settings [data-perm]').forEach((el) => {
        permissions[el.dataset.perm] = el.checked;
      });
      state.socket.emit('room:permissions', permissions, (res) => {
        if (!res?.ok) toast(res?.error || 'Ошибка');
      });
    });
  });

  $('#savePasswordBtn').addEventListener('click', () => {
    const password = $('#newRoomPassword').value;
    state.socket.emit('room:password', { password }, (res) => {
      if (!res?.ok) return toast(res?.error || 'Ошибка');
      toast(res.hasPassword ? 'Пароль установлен' : 'Пароль снят');
      $('#newRoomPassword').value = '';
      if (state.room) state.room.hasPassword = res.hasPassword;
      updateRoomHeader();
    });
  });

  $('#toggleTranscriptBtn').addEventListener('click', () => {
    if (state.transcriptOn) stopTranscription();
    else startTranscription();
  });

  $('#downloadReportBtn').addEventListener('click', () => downloadReport());
}

async function startRecording() {
  try {
    const mixed = await buildRecordingStream();
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : MediaRecorder.isTypeSupported('video/webm')
        ? 'video/webm'
        : '';
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(mixed, mime ? { mimeType: mime } : undefined);
    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = () => {
      mixed.getTracks().forEach((t) => {
        if (t !== state.call?.localStream?.getAudioTracks()[0] &&
            t !== state.call?.localStream?.getVideoTracks()[0]) {
          // stop canvas/capture tracks only
        }
      });
      // Stop only synthetic tracks from canvas/audio context destinations carefully
      mixed.getTracks().forEach((t) => t.stop());
      const blob = new Blob(state.recordedChunks, { type: mime || 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `VideoCall-${state.room?.id || 'meeting'}-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      toast('Запись сохранена на компьютер');
    };
    state.mediaRecorder.start(1000);
    state.recording = true;
    $('#recordBtn').classList.add('active');
    toast('Запись начата');
  } catch (err) {
    console.error(err);
    toast('Не удалось начать запись: ' + (err.message || ''));
  }
}

function stopRecording() {
  if (!state.mediaRecorder) return;
  state.mediaRecorder.stop();
  state.mediaRecorder = null;
  state.recording = false;
  $('#recordBtn').classList.remove('active');
}

async function buildRecordingStream() {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  const videos = () => [...document.querySelectorAll('#videoGrid video')];

  const draw = () => {
    if (!state.recording) return;
    ctx.fillStyle = '#0b1220';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const vids = videos().filter((v) => v.srcObject);
    const n = Math.max(vids.length, 1);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const tw = canvas.width / cols;
    const th = canvas.height / rows;
    vids.forEach((v, i) => {
      const x = (i % cols) * tw;
      const y = Math.floor(i / cols) * th;
      try {
        ctx.drawImage(v, x, y, tw - 4, th - 4);
      } catch (_) {
        /* ignore */
      }
    });
    requestAnimationFrame(draw);
  };
  draw();

  const canvasStream = canvas.captureStream(15);
  const audioCtx = new AudioContext();
  const dest = audioCtx.createMediaStreamDestination();
  const addAudio = (stream) => {
    if (!stream) return;
    stream.getAudioTracks().forEach(() => {
      try {
        const src = audioCtx.createMediaStreamSource(stream);
        src.connect(dest);
      } catch (_) {
        /* already connected / no audio */
      }
    });
  };
  addAudio(state.call?.localStream);
  for (const s of state.streams.values()) addAudio(s);

  const out = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ]);
  // Keep references so GC doesn't kill drawing
  out._canvas = canvas;
  out._audioCtx = audioCtx;
  return out;
}

function startTranscription() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    toast('Транскрипция поддерживается в Chrome / Edge');
    return;
  }
  const recognition = new SR();
  recognition.lang = 'ru-RU';
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalBuffer = '';
  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0].transcript.trim();
      if (event.results[i].isFinal) {
        finalBuffer += (finalBuffer ? ' ' : '') + text;
        const segment = {
          fromName: state.self.name,
          text,
          at: Date.now(),
        };
        state.transcript.push(segment);
        state.socket.emit('transcript:segment', { text });
        renderTranscript();
      } else {
        interim += text;
      }
    }
    if (interim) {
      // live hint only locally
    }
  };
  recognition.onerror = (e) => {
    console.warn(e);
    if (e.error !== 'no-speech') toast('Ошибка транскрипции: ' + e.error);
  };
  recognition.onend = () => {
    if (state.transcriptOn) {
      try { recognition.start(); } catch (_) { /* restart */ }
    }
  };

  recognition.start();
  state.recognition = recognition;
  state.transcriptOn = true;
  $('#toggleTranscriptBtn').textContent = 'Остановить транскрипцию';
  toast('Транскрипция включена');
}

function stopTranscription() {
  state.transcriptOn = false;
  try { state.recognition?.stop(); } catch (_) { /* ignore */ }
  state.recognition = null;
  $('#toggleTranscriptBtn').textContent = 'Включить транскрипцию';
}

async function downloadReport() {
  const transcript = state.transcript
    .map((t) => `[${formatTime(t.at)}] ${t.fromName}: ${t.text}`)
    .join('\n');
  const participants = [state.self?.name, ...[...state.peers.values()].map((p) => p.name)].filter(Boolean);
  const durationMs = Date.now() - (state.meetingStartedAt || Date.now());

  try {
    const res = await fetch('/api/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomName: state.room?.name,
        transcript,
        participants,
        durationMs,
        startedAt: state.meetingStartedAt,
      }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Ошибка отчёта');
    const blob = new Blob([data.report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `VideoCall-report-${state.room?.id || 'meeting'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast(data.ai ? 'Отчёт с AI-резюме скачан' : 'Отчёт скачан');
  } catch (err) {
    toast('Не удалось скачать отчёт');
  }
}

function leaveRoom(confirmLeave) {
  if (confirmLeave && !confirm('Покинуть конференцию?')) return;
  stopTranscription();
  if (state.recording) stopRecording();
  state.call?.destroy();
  state.call = null;
  state.peers.clear();
  state.streams.clear();
  state.peerStates.clear();
  state.room = null;
  state.self = null;
  state.socket?.disconnect();
  state.socket = null;
  showView('lobby');
  history.replaceState({}, '', '/');
  toast('Вы вышли из комнаты');
}

function initPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW', err));
  }
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    $('#installBtn').classList.remove('hidden');
  });
  $('#installBtn').addEventListener('click', async () => {
    if (!state.deferredInstall) return;
    state.deferredInstall.prompt();
    await state.deferredInstall.userChoice;
    state.deferredInstall = null;
    $('#installBtn').classList.add('hidden');
  });
}

window.VideoCallApp = {
  showView,
  toast,
  enterRoom,
  acquireMediaInGesture,
  saveLobbyName,
  loadLobbyName,
};

function boot() {
  showSecureBannerIfNeeded();
  showPhoneHint();
  initLobby();
  initRoomControls();
  initPWA();
  window.dispatchEvent(new Event('videocall:ready'));

  // iOS: unlock audio on first tap
  const unlock = () => {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ctx = new AC();
      if (ctx.state === 'suspended') ctx.resume();
      setTimeout(() => ctx.close().catch(() => {}), 500);
    } catch (_) {
      /* ignore */
    }
    document.removeEventListener('touchend', unlock);
    document.removeEventListener('click', unlock);
  };
  document.addEventListener('touchend', unlock, { once: true, passive: true });
  document.addEventListener('click', unlock, { once: true });
}

boot();
