import { MeshCall } from './webrtc.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  socket: null,
  call: null,
  self: null,
  room: null,
  peers: new Map(),
  streams: new Map(),
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

    const res = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: roomName, roomId: roomId || undefined, password }),
    });
    const data = await res.json();
    if (!res.ok) return toast(data.error || 'Ошибка создания');
    await enterRoom({ roomId: data.id, name, password });
  });

  $('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#joinName').value.trim();
    const roomId = $('#joinRoomId').value.trim();
    const password = $('#joinPassword').value;
    saveLobbyName(name);
    await enterRoom({ roomId, name, password });
  });

  const params = new URLSearchParams(location.search);
  const qRoom = params.get('room');
  if (qRoom) {
    $('#joinRoomId').value = qRoom;
    showView('lobby');
  }
}

async function enterRoom({ roomId, name, password }) {
  try {
    toast('Подключение…');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn(err);
    toast('Нужен доступ к камере/микрофону (можно продолжить и включить позже)');
  }

  if (!state.socket) {
    state.socket = io({ transports: ['websocket', 'polling'] });
    wireSocket();
  }

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
      state.call = new MeshCall({
        socket: state.socket,
        selfId: state.self.id,
        onRemoteStream: (peerId, stream) => {
          state.streams.set(peerId, stream);
          renderVideos();
        },
        onPeerLeft: (peerId) => {
          state.streams.delete(peerId);
          renderVideos();
        },
        onError: (m) => toast(m),
      });

      try {
        await state.call.initLocal({ audio: true, video: true });
      } catch (err) {
        console.warn('media init failed', err);
        toast('Камера/микрофон недоступны — войдите без медиа или разрешите доступ');
        state.audioEnabled = false;
        state.videoEnabled = false;
        try {
          state.call.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          state.audioEnabled = true;
        } catch (_) {
          state.call.localStream = new MediaStream();
        }
      }

      renderVideos();
      for (const peer of state.peers.values()) {
        await state.call.connectToPeer(peer.id);
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

  s.on('participant:joined', async (p) => {
    state.peers.set(p.id, p);
    renderPeople();
    updateChatTargets();
    toast(`${p.name} присоединился(ась)`);
    if (state.call) await state.call.connectToPeer(p.id);
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

function updateRoomHeader() {
  if (!state.room) return;
  $('#roomNameLabel').textContent = state.room.name;
  const count = 1 + state.peers.size;
  $('#roomMeta').textContent = `ID: ${state.room.id} · ${count}/${state.room.maxParticipants || 100}` +
    (state.room.hasPassword ? ' · 🔒' : '');
}

function renderVideos() {
  const grid = $('#videoGrid');
  grid.innerHTML = '';
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
  });

  for (const p of state.peers.values()) {
    entries.push({
      id: p.id,
      name: p.name,
      stream: state.streams.get(p.id),
      self: false,
      audioEnabled: p.audioEnabled,
      videoEnabled: p.videoEnabled,
      screenSharing: p.screenSharing,
      handRaised: p.handRaised,
      role: p.role,
    });
  }

  grid.classList.toggle('solo', entries.length === 1);

  for (const e of entries) {
    const tile = document.createElement('div');
    tile.className = 'tile' + (e.self ? ' self' : '') + (e.screenSharing ? ' screen-share' : '');
    tile.dataset.id = e.id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = e.self;
    if (e.stream) video.srcObject = e.stream;

    const meta = document.createElement('div');
    meta.className = 'tile-meta';
    meta.innerHTML = `
      <span>${escapeHtml(e.name)}${e.role === 'host' ? ' · хост' : e.role === 'cohost' ? ' · со-хост' : ''}</span>
      <div class="tile-badges">
        ${e.handRaised ? '<span class="badge live">✋</span>' : ''}
        ${e.screenSharing ? '<span class="badge live">экран</span>' : ''}
        <span class="badge ${e.audioEnabled ? '' : 'off'}">${e.audioEnabled ? 'mic' : 'mic off'}</span>
        <span class="badge ${e.videoEnabled || e.screenSharing ? '' : 'off'}">${e.videoEnabled || e.screenSharing ? 'cam' : 'cam off'}</span>
      </div>`;

    tile.appendChild(video);
    tile.appendChild(meta);
    grid.appendChild(tile);
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
    state.audioEnabled = !state.audioEnabled;
    await state.call?.setAudioEnabled(state.audioEnabled);
    $('#micBtn').classList.toggle('off', !state.audioEnabled);
    emitMediaState();
    renderVideos();
  });

  $('#camBtn').addEventListener('click', async () => {
    if (state.screenSharing) return toast('Сначала остановите демонстрацию экрана');
    if (!state.room?.permissions?.allowVideo && !state.videoEnabled && !canModerate()) {
      return toast('Хост запретил включать камеру');
    }
    state.videoEnabled = !state.videoEnabled;
    await state.call?.setVideoEnabled(state.videoEnabled);
    $('#camBtn').classList.toggle('off', !state.videoEnabled);
    emitMediaState();
    renderVideos();
  });

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
      await state.call.startScreenShare();
      state.screenSharing = true;
      $('#screenBtn').classList.add('active');
      emitMediaState();
      renderVideos();
      toast('Демонстрация экрана начата');
    } catch (err) {
      console.error(err);
      toast('Не удалось начать демонстрацию экрана');
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

  $('#toggleChatBtn').addEventListener('click', () => openTab('chat'));
  $('#toggleParticipantsBtn').addEventListener('click', () => openTab('people'));
  $('#toggleSettingsBtn').addEventListener('click', () => openTab('settings'));

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

function boot() {
  initLobby();
  initRoomControls();
  initPWA();
}

boot();
