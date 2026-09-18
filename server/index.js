const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PARTICIPANTS = 100;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 5e6,
});

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

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

app.get('/api/rooms/:id', (req, res) => {
  const room = rooms.get(req.params.id);
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

    if (rooms.has(roomId)) {
      return res.status(409).json({ error: 'Комната с таким ID уже существует' });
    }

    const passwordHash = password ? await bcrypt.hash(password, 10) : null;
    /** @type {Room} */
    const room = {
      id: roomId,
      name,
      passwordHash,
      hostId: '',
      participants: new Map(),
      permissions: defaultPermissions(),
      createdAt: Date.now(),
      chatHistory: [],
      transcriptSegments: [],
    };
    rooms.set(roomId, room);
    res.json({ id: roomId, name, hasPassword: Boolean(passwordHash) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Не удалось создать комнату' });
  }
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
  if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('room:join', async (payload, ack) => {
    try {
      const roomId = String(payload?.roomId || '').trim();
      const name = String(payload?.name || 'Гость').trim().slice(0, 40) || 'Гость';
      const password = payload?.password ? String(payload.password) : '';
      const room = rooms.get(roomId);

      if (!room) {
        return ack?.({ ok: false, error: 'Комната не найдена. Создайте её на главной странице.' });
      }
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
    io.to(room.id).emit('room:meta', { hasPassword: Boolean(room.passwordHash) });
    ack?.({ ok: true, hasPassword: Boolean(room.passwordHash) });
  });

  socket.on('disconnect', () => {
    const ctx = findParticipantBySocket(socket.id);
    if (!ctx) return;
    const { room, participant } = ctx;
    room.participants.delete(participant.id);
    socket.to(room.id).emit('participant:left', { id: participant.id });

    if (participant.role === 'host' && room.participants.size > 0) {
      const next = [...room.participants.values()][0];
      next.role = 'host';
      room.hostId = next.id;
      io.to(room.id).emit('participant:updated', publicParticipant(next));
      io.to(room.id).emit('room:host-changed', { hostId: next.id });
    }

    if (room.participants.size === 0) {
      setTimeout(() => {
        const current = rooms.get(room.id);
        if (current && current.participants.size === 0) rooms.delete(room.id);
      }, 1000 * 60 * 30);
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`VideoCall running at http://localhost:${PORT}`);
});
