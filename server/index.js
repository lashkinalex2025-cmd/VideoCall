const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const { ensureCerts, listLocalIPs } = require('./https');
const { getIceServers } = require('./ice');
const store = require('./store');
const users = require('./users');
const auth = require('./auth');
const mail = require('./mail');

const PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PARTICIPANTS = 100;
const IS_CLOUD =
  process.env.RENDER === 'true' ||
  Boolean(process.env.RENDER_EXTERNAL_URL) ||
  Boolean(process.env.RAILWAY_ENVIRONMENT) ||
  Boolean(process.env.FLY_APP_NAME) ||
  process.env.VIDEOCALL_CLOUD === '1';
const ENABLE_LOCAL_HTTPS =
  process.env.VIDEOCALL_LOCAL_HTTPS === '1' ||
  (!IS_CLOUD && process.env.VIDEOCALL_LOCAL_HTTPS !== '0');
const ENABLE_TUNNEL =
  process.env.VIDEOCALL_TUNNEL === '1' ||
  (!IS_CLOUD && process.env.VIDEOCALL_TUNNEL !== '0');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    }
  },
}));

const io = new Server({
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6,
});

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {Object} Participant
 * @property {string} id
 * @property {string} name
 * @property {string} socketId
 * @property {'host'|'cohost'|'participant'|'guest'} role
 * @property {boolean} audioEnabled
 * @property {boolean} videoEnabled
 * @property {boolean} screenSharing
 * @property {boolean} handRaised
 * @property {number} joinedAt
 */

/**
 * @typedef {Object} RoomPermissions
 * @property {boolean} allowChat
 * @property {boolean} allowPrivateChat
 * @property {boolean} allowScreenShare
 * @property {boolean} allowUnmute
 * @property {boolean} allowVideo
 * @property {boolean} waitingRoom
 * @property {boolean} lockRoom
 */

/**
 * @typedef {Object} Room
 * @property {string} id
 * @property {string} name
 * @property {string|null} passwordHash
 * @property {string} hostId
 * @property {Map<string, Participant>} participants
 * @property {RoomPermissions} permissions
 * @property {number} createdAt
 * @property {Array<object>} chatHistory
 * @property {Array<object>} transcriptSegments
 */

function defaultPermissions() {
  return {
    allowChat: true,
    allowPrivateChat: true,
    allowScreenShare: true,
    allowUnmute: true,
    allowVideo: true,
    waitingRoom: false,
    lockRoom: false,
  };
}

function persistRoom(room, createdBy = 'system', ownerId = null) {
  const existing = store.getConference(room.id);
  store.upsertConference({
    id: room.id,
    name: room.name,
    passwordHash: room.passwordHash,
    permissions: { ...room.permissions },
    createdAt: existing?.createdAt || room.createdAt || Date.now(),
    updatedAt: Date.now(),
    lastActivityAt: Date.now(),
    createdBy: existing?.createdBy || createdBy,
    ownerId: ownerId || existing?.ownerId || null,
  });
}

function createRuntimeRoom({ id, name, passwordHash, permissions, createdAt }) {
  /** @type {Room} */
  const room = {
    id,
    name: name || 'Конференция',
    passwordHash: passwordHash || null,
    hostId: '',
    participants: new Map(),
    permissions: { ...defaultPermissions(), ...(permissions || {}) },
    createdAt: createdAt || Date.now(),
    chatHistory: [],
    transcriptSegments: [],
  };
  rooms.set(id, room);
  return room;
}

function ensureRuntimeRoom(roomId) {
  let room = rooms.get(roomId);
  if (room) return room;
  const stored = store.getConference(roomId);
  if (!stored) return null;
  return createRuntimeRoom(stored);
}

function conferenceListItem(conf) {
  const live = rooms.get(conf.id);
  const participantCount = live ? live.participants.size : 0;
  const onlineParticipants = live
    ? [...live.participants.values()].map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        joinedAt: p.joinedAt,
      }))
    : [];
  return {
    id: conf.id,
    name: conf.name,
    hasPassword: Boolean(conf.passwordHash),
    permissions: conf.permissions || defaultPermissions(),
    createdAt: conf.createdAt,
    updatedAt: conf.updatedAt,
    lastActivityAt: conf.lastActivityAt,
    createdBy: conf.createdBy || 'system',
    ownerId: conf.ownerId || null,
    participantCount,
    onlineParticipants,
    active: participantCount > 0,
    link: `/?room=${encodeURIComponent(conf.id)}`,
  };
}

function getOnlineSnapshot() {
  const result = [];
  for (const room of rooms.values()) {
    if (!room.participants.size) continue;
    for (const p of room.participants.values()) {
      result.push({
        roomId: room.id,
        roomName: room.name,
        participantId: p.id,
        name: p.name,
        role: p.role,
        joinedAt: p.joinedAt,
      });
    }
  }
  return result;
}

// bootstrap admin user on startup
users.ensureBootstrapAdmin().catch((err) => console.error('bootstrap admin', err));

function publicParticipant(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    audioEnabled: p.audioEnabled,
    videoEnabled: p.videoEnabled,
    screenSharing: p.screenSharing,
    handRaised: p.handRaised,
    joinedAt: p.joinedAt,
  };
}

function roomPublicState(room) {
  return {
    id: room.id,
    name: room.name,
    hasPassword: Boolean(room.passwordHash),
    hostId: room.hostId,
    permissions: room.permissions,
    createdAt: room.createdAt,
    participantCount: room.participants.size,
    maxParticipants: MAX_PARTICIPANTS,
    participants: [...room.participants.values()].map(publicParticipant),
  };
}

function findParticipantBySocket(socketId) {
  for (const room of rooms.values()) {
    for (const p of room.participants.values()) {
      if (p.socketId === socketId) {
        return { room, participant: p };
      }
    }
  }
  return null;
}

function canModerate(participant) {
  return participant && (participant.role === 'host' || participant.role === 'cohost');
}

function isHost(participant) {
  return participant && participant.role === 'host';
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'VideoCall', rooms: rooms.size });
});

app.get('/api/ice', async (_req, res) => {
  try {
    const cfg = await getIceServers();
    res.json(cfg);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'ICE config unavailable' });
  }
});

app.get('/api/info', (_req, res) => {
  const ips = listLocalIPs().filter((ip) => ip !== '127.0.0.1');
  res.json({
    ok: true,
    httpPort: PORT,
    httpsPort: HTTPS_PORT,
    lanHttps: IS_CLOUD ? [] : ips.map((ip) => `https://${ip}:${HTTPS_PORT}`),
    publicUrl: process.env.RENDER_EXTERNAL_URL || process.env.VIDEOCALL_PUBLIC_URL || '',
    tip: 'На iPhone/Android открывайте HTTPS-ссылку, не HTTP.',
  });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = ensureRuntimeRoom(req.params.id);
  if (!room) return res.status(404).json({ error: 'Комната не найдена' });
  res.json({
    id: room.id,
    name: room.name,
    hasPassword: Boolean(room.passwordHash),
    participantCount: room.participants.size,
    maxParticipants: MAX_PARTICIPANTS,
    locked: room.permissions.lockRoom,
  });
});

app.post('/api/rooms', async (req, res) => {
  try {
    const name = String(req.body.name || 'Конференция').trim().slice(0, 80);
    const password = req.body.password ? String(req.body.password) : '';
    const roomId = (req.body.roomId ? String(req.body.roomId) : uuidv4().slice(0, 8))
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32) || uuidv4().slice(0, 8);

    if (rooms.has(roomId) || store.getConference(roomId)) {
      return res.status(409).json({ error: 'Комната с таким ID уже существует' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const room = createRuntimeRoom({
      id: roomId,
      name,
      passwordHash,
      permissions: defaultPermissions(),
      createdAt: Date.now(),
    });
    persistRoom(room, 'user');
    res.json({ id: roomId, name, hasPassword: Boolean(passwordHash) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать комнату' });
  }
});

// ---------- Auth / Registration ----------
app.post('/api/auth/register', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const passwordConfirm = String(req.body?.passwordConfirm || '');
    const name = String(req.body?.name || '').trim();
    if (password !== passwordConfirm) {
      return res.status(400).json({ error: 'Пароли не совпадают' });
    }
    const result = await users.register({ email, password, name });
    if (!result.ok) return res.status(400).json(result);
    mail.sendNewUserNotification(result.user).catch(() => {});
    const session = auth.issueToken(result.user);
    res.json({ ...session, mailNotifyTo: mail.NOTIFY_EMAIL });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось зарегистрироваться' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const login = String(req.body?.email || req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const result = await auth.login(login, password);
  if (!result.ok) return res.status(401).json(result);
  res.json(result);
});

app.post('/api/auth/logout', auth.authRequired, (req, res) => {
  res.json(auth.logout(auth.getBearer(req)));
});

app.get('/api/auth/me', auth.authRequired, (req, res) => {
  const user = users.findById(req.auth.userId);
  res.json({ user: users.publicUser(user) });
});

// ---------- User cabinet API ----------
app.get('/api/user/conferences', auth.authRequired, (req, res) => {
  const list = store
    .listConferences()
    .filter((c) => c.ownerId === req.auth.userId || c.createdBy === req.auth.email)
    .map(conferenceListItem);
  res.json({ conferences: list, total: list.length });
});

app.post('/api/user/conferences', auth.authRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || 'Конференция').trim().slice(0, 80);
    const password = req.body?.password ? String(req.body.password) : '';
    const roomId = (req.body?.roomId ? String(req.body.roomId) : uuidv4().slice(0, 8))
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32) || uuidv4().slice(0, 8);
    if (rooms.has(roomId) || store.getConference(roomId)) {
      return res.status(409).json({ error: 'Ссылка с таким ID уже существует' });
    }
    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const room = createRuntimeRoom({
      id: roomId,
      name,
      passwordHash,
      permissions: defaultPermissions(),
      createdAt: Date.now(),
    });
    persistRoom(room, req.auth.email, req.auth.userId);
    res.json(conferenceListItem(store.getConference(roomId)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать конференцию' });
  }
});

app.patch('/api/user/conferences/:id', auth.authRequired, async (req, res) => {
  try {
    const conf = store.getConference(req.params.id);
    if (!conf) return res.status(404).json({ error: 'Конференция не найдена' });
    if (conf.ownerId !== req.auth.userId && !users.isAdminRole(req.auth.role)) {
      return res.status(403).json({ error: 'Нет доступа к этой конференции' });
    }
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      conf.name = req.body.name.trim().slice(0, 80);
    }
    if (req.body?.password !== undefined) {
      const password = String(req.body.password || '');
      conf.passwordHash = password ? await bcrypt.hash(password, 10) : null;
    }
    if (req.body?.permissions && typeof req.body.permissions === 'object') {
      conf.permissions = { ...defaultPermissions(), ...conf.permissions, ...req.body.permissions };
    }
    conf.updatedAt = Date.now();
    store.upsertConference(conf);
    const live = rooms.get(conf.id);
    if (live) {
      live.name = conf.name;
      live.passwordHash = conf.passwordHash;
      live.permissions = { ...conf.permissions };
      io.to(live.id).emit('room:permissions', live.permissions);
      io.to(live.id).emit('room:meta', { hasPassword: Boolean(live.passwordHash), name: live.name });
    }
    res.json(conferenceListItem(conf));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось обновить конференцию' });
  }
});

app.delete('/api/user/conferences/:id', auth.authRequired, (req, res) => {
  const conf = store.getConference(req.params.id);
  if (!conf) return res.status(404).json({ error: 'Конференция не найдена' });
  if (conf.ownerId !== req.auth.userId && !users.isAdminRole(req.auth.role)) {
    return res.status(403).json({ error: 'Нет доступа' });
  }
  const live = rooms.get(conf.id);
  if (live) {
    for (const p of live.participants.values()) {
      io.to(p.socketId).emit('moderation:kicked', { reason: 'Конференция удалена владельцем' });
    }
    rooms.delete(conf.id);
  }
  store.deleteConference(conf.id);
  res.json({ ok: true, id: conf.id });
});

// ---------- Admin API ----------
app.get('/api/admin/info', (_req, res) => {
  res.json({
    username: process.env.ADMIN_USER || 'admin',
    notifyEmail: mail.NOTIFY_EMAIL,
    defaultHint: !process.env.ADMIN_PASSWORD,
  });
});

app.post('/api/admin/login', async (req, res) => {
  const username = String(req.body?.username || req.body?.email || '').trim();
  const password = String(req.body?.password || '');
  const result = await auth.login(username, password);
  if (!result.ok) return res.status(401).json(result);
  if (!users.isAdminRole(result.user.role)) {
    return res.status(403).json({ error: 'Нет прав администратора' });
  }
  res.json({
    ok: true,
    token: result.token,
    username: result.user.email || result.user.name,
    user: result.user,
    expiresAt: result.expiresAt,
  });
});

app.post('/api/admin/logout', auth.adminRequired, (req, res) => {
  res.json(auth.logout(auth.getBearer(req)));
});

app.get('/api/admin/conferences', auth.adminRequired, (_req, res) => {
  const list = store.listConferences().map(conferenceListItem);
  res.json({ conferences: list, total: list.length });
});

app.post('/api/admin/conferences', auth.adminRequired, async (req, res) => {
  try {
    const name = String(req.body?.name || 'Конференция').trim().slice(0, 80);
    const password = req.body?.password ? String(req.body.password) : '';
    const roomId = (req.body?.roomId ? String(req.body.roomId) : uuidv4().slice(0, 8))
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 32) || uuidv4().slice(0, 8);

    if (rooms.has(roomId) || store.getConference(roomId)) {
      return res.status(409).json({ error: 'Ссылка с таким ID уже существует' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    const room = createRuntimeRoom({
      id: roomId,
      name,
      passwordHash,
      permissions: defaultPermissions(),
      createdAt: Date.now(),
    });
    persistRoom(room, req.auth.email || req.admin.email, req.auth.userId);
    res.json(conferenceListItem(store.getConference(roomId)));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать ссылку' });
  }
});

app.patch('/api/admin/conferences/:id', auth.adminRequired, async (req, res) => {
  try {
    const conf = store.getConference(req.params.id);
    if (!conf) return res.status(404).json({ error: 'Ссылка не найдена' });

    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      conf.name = req.body.name.trim().slice(0, 80);
    }
    if (req.body?.password !== undefined) {
      const password = String(req.body.password || '');
      conf.passwordHash = password ? await bcrypt.hash(password, 10) : null;
    }
    if (req.body?.permissions && typeof req.body.permissions === 'object') {
      conf.permissions = { ...defaultPermissions(), ...conf.permissions, ...req.body.permissions };
    }
    conf.updatedAt = Date.now();
    store.upsertConference(conf);

    const live = rooms.get(conf.id);
    if (live) {
      live.name = conf.name;
      live.passwordHash = conf.passwordHash;
      live.permissions = { ...conf.permissions };
      io.to(live.id).emit('room:permissions', live.permissions);
      io.to(live.id).emit('room:meta', { hasPassword: Boolean(live.passwordHash), name: live.name });
    }

    res.json(conferenceListItem(conf));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось обновить ссылку' });
  }
});

app.delete('/api/admin/conferences/:id', auth.adminRequired, (req, res) => {
  const id = req.params.id;
  const live = rooms.get(id);
  if (live) {
    for (const p of live.participants.values()) {
      io.to(p.socketId).emit('moderation:kicked', { reason: 'Конференция удалена администратором' });
      const sock = io.sockets.sockets.get(p.socketId);
      if (sock) {
        sock.leave(id);
        sock.data.roomId = null;
        sock.data.participantId = null;
      }
    }
    rooms.delete(id);
  }
  const ok = store.deleteConference(id);
  if (!ok) return res.status(404).json({ error: 'Ссылка не найдена' });
  res.json({ ok: true, id });
});

app.post('/api/admin/conferences/cleanup', auth.adminRequired, (req, res) => {
  const maxAgeHours = Number(req.body?.maxAgeHours);
  const maxAgeMs = Number.isFinite(maxAgeHours) && maxAgeHours > 0
    ? maxAgeHours * 60 * 60 * 1000
    : 24 * 60 * 60 * 1000;

  const activeIds = new Set(
    [...rooms.values()].filter((r) => r.participants.size > 0).map((r) => r.id)
  );
  const result = store.cleanupUnused({ maxAgeMs, activeIds });

  for (const id of result.removed) {
    rooms.delete(id);
  }

  res.json({
    ok: true,
    removed: result.removed,
    removedCount: result.removed.length,
    remaining: result.kept,
    maxAgeHours: maxAgeMs / (60 * 60 * 1000),
  });
});

app.get('/api/admin/users', auth.adminRequired, (_req, res) => {
  res.json({ users: users.listUsers() });
});

app.post('/api/admin/users', auth.adminRequired, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim();
    const password = String(req.body?.password || '');
    const name = String(req.body?.name || '').trim();
    let role = String(req.body?.role || 'user');
    if (role === 'superadmin' && req.auth.role !== 'superadmin') {
      return res.status(403).json({ error: 'Только главный администратор может создавать superadmin' });
    }
    // "admin with main admin rights" -> admin role (same panel access)
    if (role === 'main_admin') role = 'admin';
    const result = await users.createUser({
      email,
      password,
      name,
      role,
      createdBy: req.auth.email,
    });
    if (!result.ok) return res.status(400).json(result);
    if (role === 'user') {
      mail.sendNewUserNotification(result.user).catch(() => {});
    }
    res.json({ ok: true, user: result.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать пользователя' });
  }
});

app.delete('/api/admin/users/:id', auth.adminRequired, (req, res) => {
  const result = users.deleteUser(req.params.id, {
    id: req.auth.userId,
    role: req.auth.role,
  });
  if (!result.ok) return res.status(400).json(result);
  res.json(result);
});

app.get('/api/admin/online', auth.adminRequired, (_req, res) => {
  const online = getOnlineSnapshot();
  res.json({ online, total: online.length, roomsActive: new Set(online.map((o) => o.roomId)).size });
});

app.post('/api/report', async (req, res) => {
  try {
    const { roomName, transcript, participants, durationMs, startedAt } = req.body || {};
    const text = String(transcript || '').trim();
    const lines = [
      '========================================',
      '  VideoCall — отчёт о конференции',
      '========================================',
      '',
      `Комната: ${roomName || '—'}`,
      `Начало: ${startedAt ? new Date(startedAt).toLocaleString('ru-RU') : '—'}`,
      `Длительность: ${formatDuration(Number(durationMs) || 0)}`,
      `Участники: ${(participants || []).join(', ') || '—'}`,
      '',
      '---------- Транскрипция ----------',
      text || '(транскрипция пуста)',
      '',
    ];

    let aiSummary = '';
    const apiKey = process.env.XAI_API_KEY;
    if (apiKey && text.length > 40) {
      try {
        aiSummary = await summarizeWithSpaceXAI(apiKey, text, roomName);
      } catch (e) {
        console.warn('AI summary failed:', e.message);
      }
    }

    if (aiSummary) {
      lines.splice(9, 0, '---------- Краткое резюме (AI) ----------', aiSummary, '');
    } else if (text) {
      const auto = buildLocalSummary(text, participants || []);
      lines.splice(9, 0, '---------- Краткое резюме ----------', auto, '');
    }

    res.json({ report: lines.join('\n'), ai: Boolean(aiSummary) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось сформировать отчёт' });
  }
});

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function buildLocalSummary(transcript, participants) {
  const words = transcript.split(/\s+/).filter(Boolean).length;
  const sentences = transcript.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20);
  const highlights = sentences.slice(0, 8).map((s) => `• ${s}`).join('\n');
  return [
    `Участников упомянуто/в списке: ${participants.length}`,
    `Слов в транскрипции: ${words}`,
    'Ключевые фрагменты:',
    highlights || '• Недостаточно текста для выделения ключевых моментов',
  ].join('\n');
}

async function summarizeWithSpaceXAI(apiKey, transcript, roomName) {
  const truncated = transcript.slice(0, 120000);
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'grok-4.5',
      messages: [
        {
          role: 'system',
          content:
            'Ты помощник для составления отчётов о видеоконференциях. Отвечай на русском. Дай краткое резюме, решения, action items и открытые вопросы.',
        },
        {
          role: 'user',
          content: `Составь отчёт по встрече «${roomName || 'Конференция'}» на основе транскрипции:\n\n${truncated}`,
        },
      ],
      temperature: 0.3,
    }),
  });
  if (!response.ok) {
    throw new Error(`xAI HTTP ${response.status}`);
  }
  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/socket.io') ||
    req.path.startsWith('/vc') ||
    req.path.startsWith('/vc-socket.io')
  ) {
    return next();
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('room:join', async (payload, ack) => {
    try {
      const roomId = String(payload?.roomId || '').trim();
      const name = String(payload?.name || 'Гость').trim().slice(0, 40) || 'Гость';
      const password = payload?.password ? String(payload.password) : '';
      const room = ensureRuntimeRoom(roomId);

      if (!room) {
        return ack?.({ ok: false, error: 'Комната не найдена. Создайте её на главной или в кабинете администратора.' });
      }
      store.touchConference(roomId);
      if (room.permissions.lockRoom && room.participants.size > 0) {
        return ack?.({ ok: false, error: 'Комната заблокирована хостом' });
      }
      if (room.participants.size >= MAX_PARTICIPANTS) {
        return ack?.({ ok: false, error: `Достигнут лимит ${MAX_PARTICIPANTS} участников` });
      }
      if (room.passwordHash) {
        const valid = await bcrypt.compare(password, room.passwordHash);
        if (!valid) return ack?.({ ok: false, error: 'Неверный пароль' });
      }

      const existing = findParticipantBySocket(socket.id);
      if (existing) {
        existing.room.participants.delete(existing.participant.id);
        socket.leave(existing.room.id);
        io.to(existing.room.id).emit('participant:left', { id: existing.participant.id });
      }

      const isFirst = room.participants.size === 0;
      const participant = {
        id: uuidv4(),
        name,
        socketId: socket.id,
        role: isFirst ? 'host' : 'participant',
        audioEnabled: true,
        videoEnabled: true,
        screenSharing: false,
        handRaised: false,
        joinedAt: Date.now(),
      };

      if (isFirst) room.hostId = participant.id;
      room.participants.set(participant.id, participant);
      socket.join(roomId);
      socket.data.roomId = roomId;
      socket.data.participantId = participant.id;

      const others = [...room.participants.values()]
        .filter((p) => p.id !== participant.id)
        .map(publicParticipant);

      socket.to(roomId).emit('participant:joined', publicParticipant(participant));
      ack?.({
        ok: true,
        self: publicParticipant(participant),
        room: roomPublicState(room),
        peers: others,
        chatHistory: room.chatHistory.slice(-200),
        transcriptSegments: room.transcriptSegments.slice(-500),
      });
    } catch (err) {
      console.error(err);
      ack?.({ ok: false, error: 'Ошибка входа в комнату' });
    }
  });

  socket.on('signal', (payload) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return;
    const { room, participant } = ctx;
    const target = [...room.participants.values()].find((p) => p.id === payload?.to);
    if (!target) return;
    io.to(target.socketId).emit('signal', {
      from: participant.id,
      data: payload.data,
    });
  });

  socket.on('media:state', (state) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return;
    const { room, participant } = ctx;
    if (typeof state?.audioEnabled === 'boolean') participant.audioEnabled = state.audioEnabled;
    if (typeof state?.videoEnabled === 'boolean') participant.videoEnabled = state.videoEnabled;
    if (typeof state?.screenSharing === 'boolean') participant.screenSharing = state.screenSharing;
    if (typeof state?.handRaised === 'boolean') participant.handRaised = state.handRaised;
    socket.to(room.id).emit('media:state', {
      id: participant.id,
      audioEnabled: participant.audioEnabled,
      videoEnabled: participant.videoEnabled,
      screenSharing: participant.screenSharing,
      handRaised: participant.handRaised,
    });
  });

  socket.on('chat:clear', (payload, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false, error: 'Не в комнате' });
    const { room, participant } = ctx;
    room.chatHistory = [];
    io.to(room.id).emit('chat:cleared', {
      by: participant.id,
      byName: participant.name,
      at: Date.now(),
    });
    ack?.({ ok: true });
  });

  socket.on('chat:message', (payload, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false, error: 'Не в комнате' });
    const { room, participant } = ctx;

    const text = String(payload?.text || '').trim().slice(0, 4000);
    if (!text) return ack?.({ ok: false, error: 'Пустое сообщение' });

    const toId = payload?.to ? String(payload.to) : null;
    const isPrivate = Boolean(toId);

    if (!room.permissions.allowChat) {
      return ack?.({ ok: false, error: 'Чат отключён хостом' });
    }
    if (isPrivate && !room.permissions.allowPrivateChat) {
      return ack?.({ ok: false, error: 'Личные сообщения отключены' });
    }

    const message = {
      id: uuidv4(),
      from: participant.id,
      fromName: participant.name,
      to: toId,
      toName: null,
      text,
      private: isPrivate,
      at: Date.now(),
    };

    if (isPrivate) {
      const target = room.participants.get(toId);
      if (!target) return ack?.({ ok: false, error: 'Пользователь не найден' });
      message.toName = target.name;
      io.to(target.socketId).emit('chat:message', message);
      socket.emit('chat:message', message);
    } else {
      room.chatHistory.push(message);
      if (room.chatHistory.length > 1000) room.chatHistory.shift();
      io.to(room.id).emit('chat:message', message);
    }
    ack?.({ ok: true, message });
  });

  socket.on('transcript:segment', (payload) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return;
    const { room, participant } = ctx;
    const text = String(payload?.text || '').trim();
    if (!text) return;
    const segment = {
      id: uuidv4(),
      from: participant.id,
      fromName: participant.name,
      text: text.slice(0, 2000),
      at: Date.now(),
    };
    room.transcriptSegments.push(segment);
    if (room.transcriptSegments.length > 5000) {
      room.transcriptSegments.splice(0, room.transcriptSegments.length - 5000);
    }
    socket.to(room.id).emit('transcript:segment', segment);
  });

  socket.on('room:permissions', (nextPerms, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false, error: 'Не в комнате' });
    const { room, participant } = ctx;
    if (!canModerate(participant)) return ack?.({ ok: false, error: 'Недостаточно прав' });

    const allowed = [
      'allowChat',
      'allowPrivateChat',
      'allowScreenShare',
      'allowUnmute',
      'allowVideo',
      'waitingRoom',
      'lockRoom',
    ];
    for (const key of allowed) {
      if (typeof nextPerms?.[key] === 'boolean') room.permissions[key] = nextPerms[key];
    }
    persistRoom(room, 'host');
    io.to(room.id).emit('room:permissions', room.permissions);
    ack?.({ ok: true, permissions: room.permissions });
  });

  socket.on('moderation:set-role', (payload, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false });
    const { room, participant } = ctx;
    if (!isHost(participant)) return ack?.({ ok: false, error: 'Только хост' });
    const target = room.participants.get(payload?.id);
    if (!target || target.id === participant.id) return ack?.({ ok: false, error: 'Нельзя' });
    const role = payload?.role;
    if (!['cohost', 'participant', 'guest'].includes(role)) return ack?.({ ok: false });
    target.role = role;
    io.to(room.id).emit('participant:updated', publicParticipant(target));
    ack?.({ ok: true });
  });

  socket.on('moderation:kick', (payload, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false });
    const { room, participant } = ctx;
    if (!canModerate(participant)) return ack?.({ ok: false, error: 'Недостаточно прав' });
    const target = room.participants.get(payload?.id);
    if (!target || target.role === 'host') return ack?.({ ok: false, error: 'Нельзя исключить' });
    io.to(target.socketId).emit('moderation:kicked', { reason: payload?.reason || 'Исключён хостом' });
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.leave(room.id);
      targetSocket.data.roomId = null;
      targetSocket.data.participantId = null;
    }
    room.participants.delete(target.id);
    io.to(room.id).emit('participant:left', { id: target.id });
    ack?.({ ok: true });
  });

  socket.on('moderation:mute', (payload, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false });
    const { room, participant } = ctx;
    if (!canModerate(participant)) return ack?.({ ok: false, error: 'Недостаточно прав' });
    const target = room.participants.get(payload?.id);
    if (!target) return ack?.({ ok: false });
    target.audioEnabled = false;
    io.to(target.socketId).emit('moderation:force-mute', { audio: true, video: Boolean(payload?.video) });
    io.to(room.id).emit('media:state', {
      id: target.id,
      audioEnabled: false,
      videoEnabled: payload?.video ? false : target.videoEnabled,
      screenSharing: target.screenSharing,
      handRaised: target.handRaised,
    });
    if (payload?.video) target.videoEnabled = false;
    ack?.({ ok: true });
  });

  socket.on('room:password', async (payload, ack) => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return ack?.({ ok: false });
    const { room, participant } = ctx;
    if (!isHost(participant)) return ack?.({ ok: false, error: 'Только хост' });
    const password = payload?.password ? String(payload.password) : '';
    room.passwordHash = password ? await bcrypt.hash(password, 10) : null;
    persistRoom(room, 'host');
    io.to(room.id).emit('room:meta', { hasPassword: Boolean(room.passwordHash) });
    ack?.({ ok: true, hasPassword: Boolean(room.passwordHash) });
  });

  socket.on('disconnect', () => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return;
    const { room, participant } = ctx;
    room.participants.delete(participant.id);
    socket.to(room.id).emit('participant:left', { id: participant.id });
    store.touchConference(room.id);

    if (participant.role === 'host' && room.participants.size > 0) {
      const next = [...room.participants.values()][0];
      next.role = 'host';
      room.hostId = next.id;
      io.to(room.id).emit('participant:updated', publicParticipant(next));
      io.to(room.id).emit('room:host-changed', { hostId: next.id });
    }

    // Unload empty runtime room from memory, but keep persistent link in store
    if (room.participants.size === 0) {
      setTimeout(() => {
        const current = rooms.get(room.id);
        if (current && current.participants.size === 0) {
          persistRoom(current, 'system');
          rooms.delete(room.id);
        }
      }, 1000 * 60 * 30);
    }
  });
});

function printBanner(tunnelUrl) {
  const ips = listLocalIPs().filter((ip) => ip !== '127.0.0.1');
  console.log('');
  console.log('========== VideoCall ==========');
  console.log(`ПК (HTTP):   http://localhost:${PORT}`);
  console.log(`ПК (HTTPS):  https://localhost:${HTTPS_PORT}`);
  for (const ip of ips) {
    console.log(`LAN HTTPS:   https://${ip}:${HTTPS_PORT}   ← для телефона в той же Wi‑Fi`);
  }
  if (tunnelUrl) {
    console.log(`Интернет:    ${tunnelUrl}   ← удобно для iPhone/Android (нормальный HTTPS)`);
  }
  console.log('');
  console.log('На телефоне камера/микрофон работают ТОЛЬКО по HTTPS.');
  console.log('Если браузер пишет «небезопасно» на LAN HTTPS — лучше откройте ссылку «Интернет».');
  console.log('================================');
}

async function startTunnel(port) {
  if (!ENABLE_TUNNEL) return null;

  // 1) localtunnel
  try {
    const localtunnel = require('localtunnel');
    const tunnelPromise = localtunnel({ port, local_host: '127.0.0.1' });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('localtunnel timeout')), 10000)
    );
    const tunnel = await Promise.race([tunnelPromise, timeoutPromise]);
    tunnel.on('error', (err) => console.warn('Tunnel error:', err.message));
    tunnel.on('close', () => console.warn('Tunnel closed'));
    if (tunnel?.url) return tunnel.url;
  } catch (err) {
    console.warn('localtunnel:', err.message);
  }

  // 2) cloudflared quick tunnel (if installed)
  try {
    const { spawn } = require('child_process');
    const url = await new Promise((resolve, reject) => {
      const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
        windowsHide: true,
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('cloudflared timeout'));
        }
      }, 15000);
      const onData = (buf) => {
        const text = buf.toString();
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          resolve(match[0]);
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });
      child.on('exit', (code) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('cloudflared exited ' + code));
        }
      });
    });
    return url;
  } catch (err) {
    console.warn('cloudflared:', err.message);
  }

  console.warn('HTTPS-туннель недоступен. Используйте LAN HTTPS на телефоне в той же Wi‑Fi.');
  return null;
}

async function main() {
  const httpServer = http.createServer(app);
  io.attach(httpServer);
  try {
    const { attachVideoConf } = require('../vc-server');
    attachVideoConf(httpServer, app);
  } catch (err) {
    console.warn('VideoConf /vc mount failed:', err.message);
  }
  await new Promise((resolve) => httpServer.listen(PORT, HOST, resolve));

  // Render / Railway / Fly дают свой HTTPS — локальный сертификат не нужен
  if (IS_CLOUD || !ENABLE_LOCAL_HTTPS) {
    const publicUrl =
      process.env.RENDER_EXTERNAL_URL ||
      process.env.VIDEOCALL_PUBLIC_URL ||
      `http://localhost:${PORT}`;
    console.log('');
    console.log('========== VideoCall (cloud) ==========');
    console.log(`Listening on ${HOST}:${PORT}`);
    console.log(`Public URL: ${publicUrl}`);
    console.log('=======================================');
    return;
  }

  const certs = await ensureCerts();
  const httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
  io.attach(httpsServer);
  await new Promise((resolve) => httpsServer.listen(HTTPS_PORT, HOST, resolve));
  printBanner(null);

  if (ENABLE_TUNNEL) {
    const tunnelUrl = await startTunnel(PORT);
    if (tunnelUrl) {
      console.log(`Интернет:    ${tunnelUrl}   ← откройте ЭТУ ссылку на iPhone/Android`);
      console.log('================================');
    }
  }
}

main().catch((err) => {
  console.error('Failed to start VideoCall:', err);
  process.exit(1);
});
