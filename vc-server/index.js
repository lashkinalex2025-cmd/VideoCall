/**
 * VideoConf API mounted under /vc on the existing VideoCall Render service.
 * Socket.IO path: /vc-socket.io
 */
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const {
  ensureDataDir,
  getDb,
  saveDb,
  generateJoinCode,
  findRoom,
  publicRoom,
} = require('./store');

const JWT_SECRET = process.env.VC_JWT_SECRET || process.env.JWT_SECRET || 'videoconf-prod-secret-change-me';
const TOKEN_EXPIRES = '7d';

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

function requireAuth(optionalGuest = false) {
  return (req, res, next) => {
    const header = req.headers.authorization;
    const token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (!token) {
      if (optionalGuest) return next();
      return res.status(401).json({ error: 'Authorization required' });
    }
    try {
      const payload = verifyToken(token);
      req.auth = payload;
      if (payload.kind === 'user') {
        req.user = getDb().users.find((u) => u.id === payload.sub);
      }
      next();
    } catch {
      if (optionalGuest) return next();
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function resolveRole(room, authUserId) {
  if (authUserId && room.ownerId === authUserId) return 'host';
  return 'guest';
}

/**
 * @param {import('http').Server} httpServer
 */
function attachVideoConf(httpServer, app) {
  ensureDataDir();

  const router = express.Router();
  const roomParticipants = new Map();
  const recordingFlags = new Map();

  function getRoomMap(roomId) {
    let m = roomParticipants.get(roomId);
    if (!m) {
      m = new Map();
      roomParticipants.set(roomId, m);
    }
    return m;
  }

  function participantsList(roomId) {
    return Array.from(getRoomMap(roomId).values()).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      audio: p.audio,
      video: p.video,
    }));
  }

  const io = new Server(httpServer, {
    path: '/vc-socket.io',
    cors: { origin: '*', methods: ['GET', 'POST'] },
  });

  function broadcastRoomState(roomId) {
    io.to(roomId).emit('room-state', {
      participants: participantsList(roomId),
      recording: recordingFlags.get(roomId) || false,
    });
  }

  router.get('/healthz', (_req, res) => {
    res.json({ ok: true, livekit: false, service: 'videoconf-vc' });
  });

  router.get('/config', (_req, res) => {
    res.json({ livekitConfigured: false });
  });

  router.post('/auth/register', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const displayName = String(req.body?.displayName || '').trim();
      if (!email || password.length < 6 || !displayName) {
        return res.status(400).json({ error: 'Invalid email, password (min 6) or displayName' });
      }
      const db = getDb();
      if (db.users.some((u) => u.email === email)) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      const user = {
        id: uuidv4(),
        email,
        passwordHash: await bcrypt.hash(password, 10),
        displayName,
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      saveDb(db);
      const token = signToken({
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        kind: 'user',
      });
      res.status(201).json({
        token,
        user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/auth/login', async (req, res) => {
    try {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const password = String(req.body?.password || '');
      const db = getDb();
      const user = db.users.find((u) => u.email === email);
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      const token = signToken({
        sub: user.id,
        email: user.email,
        displayName: user.displayName,
        kind: 'user',
      });
      res.json({
        token,
        user: { id: user.id, email: user.email, displayName: user.displayName, createdAt: user.createdAt },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/rooms', requireAuth(false), async (req, res) => {
    try {
      if (!req.auth || req.auth.kind !== 'user' || !req.user) {
        return res.status(401).json({ error: 'Registered user required' });
      }
      const title = String(req.body?.title || '').trim();
      if (!title) return res.status(400).json({ error: 'title is required' });
      const db = getDb();
      let joinCode = generateJoinCode();
      while (db.rooms.some((r) => r.joinCode === joinCode)) joinCode = generateJoinCode();
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const room = {
        id: uuidv4(),
        title,
        description: typeof req.body?.description === 'string' ? req.body.description.trim() : '',
        ownerId: req.user.id,
        joinCode,
        passwordHash: password ? await bcrypt.hash(password, 10) : null,
        waitingRoom: Boolean(req.body?.waitingRoom),
        endedAt: null,
        createdAt: new Date().toISOString(),
      };
      db.rooms.push(room);
      saveDb(db);
      res.status(201).json(publicRoom(room));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/rooms/:idOrCode', (req, res) => {
    const room = findRoom(getDb(), req.params.idOrCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json(publicRoom(room));
  });

  router.post('/rooms/:idOrCode/join', requireAuth(true), async (req, res) => {
    try {
      const db = getDb();
      const room = findRoom(db, req.params.idOrCode);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      if (room.endedAt) return res.status(410).json({ error: 'Room has ended' });
      const name =
        (typeof req.body?.name === 'string' && req.body.name.trim()) ||
        req.auth?.displayName ||
        'Guest';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (room.passwordHash) {
        const ok = await bcrypt.compare(password, room.passwordHash);
        if (!ok) return res.status(403).json({ error: 'Invalid room password' });
      }
      const role = resolveRole(room, req.auth?.kind === 'user' ? req.auth.sub : undefined);
      const participantId = req.auth?.kind === 'user' ? req.auth.sub : uuidv4();
      const participantToken = signToken({
        sub: participantId,
        displayName: name,
        kind: 'participant',
        roomId: room.id,
        role,
      });
      res.json({
        room: publicRoom(room),
        role,
        participantId,
        participantToken,
        displayName: name,
        mode: 'mesh',
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/rooms/:idOrCode/end', requireAuth(false), (req, res) => {
    try {
      if (!req.auth || req.auth.kind !== 'user') {
        return res.status(401).json({ error: 'Registered user required' });
      }
      const db = getDb();
      const room = findRoom(db, req.params.idOrCode);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      if (room.ownerId !== req.auth.sub) return res.status(403).json({ error: 'Only owner can end' });
      room.endedAt = new Date().toISOString();
      saveDb(db);
      io.to(room.id).emit('room-ended', { roomId: room.id, endedAt: room.endedAt });
      res.json({ ok: true, room: publicRoom(room) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/rooms/:idOrCode/messages', (req, res) => {
    const room = findRoom(getDb(), req.params.idOrCode);
    if (!room) return res.status(404).json({ error: 'Room not found' });
    const messages = getDb()
      .messages.filter((m) => m.roomId === room.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    res.json(messages);
  });

  router.post('/rooms/:idOrCode/messages', requireAuth(true), (req, res) => {
    try {
      const db = getDb();
      const room = findRoom(db, req.params.idOrCode);
      if (!room) return res.status(404).json({ error: 'Room not found' });
      const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
      if (!body) return res.status(400).json({ error: 'body is required' });
      const message = {
        id: uuidv4(),
        roomId: room.id,
        senderId: req.auth?.sub || null,
        guestName: req.body?.guestName || req.auth?.displayName || 'Guest',
        body,
        createdAt: new Date().toISOString(),
      };
      db.messages.push(message);
      saveDb(db);
      io.to(room.id).emit('chat-message', message);
      res.status(201).json(message);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Static UI under /vc/
  const webDir = path.join(__dirname, '..', 'public', 'vc');
  router.use(express.static(webDir));
  router.get(['/', '/r/:code', '/room/:code', '/login'], (_req, res) => {
    res.sendFile(path.join(webDir, 'index.html'));
  });

  app.use('/vc', router);

  io.on('connection', (socket) => {
    const data = socket.data;

    socket.on('join-room', (payload = {}) => {
      try {
        const idOrCode = payload.roomId || payload.joinCode;
        if (!idOrCode) return socket.emit('error', { message: 'roomId or joinCode required' });
        const room = findRoom(getDb(), idOrCode);
        if (!room) return socket.emit('error', { message: 'Room not found' });
        if (room.endedAt) return socket.emit('error', { message: 'Room has ended' });

        let name = (payload.name || 'Guest').trim();
        let role = payload.role || 'guest';
        let participantId = payload.participantId || uuidv4();
        const token = payload.token || socket.handshake.auth?.token;
        if (token) {
          try {
            const auth = verifyToken(token);
            participantId = auth.sub;
            name = auth.displayName || name;
            if (auth.roomId === room.id && auth.role) role = auth.role;
            else if (auth.kind === 'user') role = resolveRole(room, auth.sub);
          } catch {
            /* keep */
          }
        }

        if (data.roomId && data.participantId) {
          getRoomMap(data.roomId).delete(data.participantId);
          socket.leave(data.roomId);
          socket.to(data.roomId).emit('peer-left', { id: data.participantId });
          broadcastRoomState(data.roomId);
        }

        data.roomId = room.id;
        data.participantId = participantId;
        data.name = name;
        data.role = role;
        getRoomMap(room.id).set(participantId, {
          id: participantId,
          socketId: socket.id,
          name,
          role,
          audio: payload.audio ?? true,
          video: payload.video ?? true,
        });
        socket.join(room.id);
        socket.emit('joined-room', {
          room: publicRoom(room),
          participantId,
          role,
          participants: participantsList(room.id),
          recording: recordingFlags.get(room.id) || false,
        });
        socket.to(room.id).emit('peer-joined', { id: participantId, name, role });
        broadcastRoomState(room.id);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('leave-room', () => leave(socket));
    socket.on('mesh-ready', () => {
      if (!data.roomId || !data.participantId) return;
      socket.emit(
        'peers',
        participantsList(data.roomId).filter((p) => p.id !== data.participantId),
      );
    });

    socket.on('chat-message', (payload = {}) => {
      if (!data.roomId || !data.participantId) return;
      const body = typeof payload.body === 'string' ? payload.body.trim() : '';
      if (!body) return;
      const db = getDb();
      const room = findRoom(db, data.roomId);
      if (!room || room.endedAt) return;
      const message = {
        id: uuidv4(),
        roomId: room.id,
        senderId: data.participantId,
        guestName: payload.guestName || data.name || 'Guest',
        body,
        createdAt: new Date().toISOString(),
      };
      db.messages.push(message);
      saveDb(db);
      io.to(room.id).emit('chat-message', message);
    });

    socket.on('signal', (payload = {}) => {
      if (!data.roomId || !payload.to) return;
      const target = getRoomMap(data.roomId).get(payload.to);
      if (!target) return;
      io.to(target.socketId).emit('signal', {
        type: payload.type,
        to: payload.to,
        from: payload.from || data.participantId,
        name: data.name,
        role: data.role,
        payload: payload.payload,
      });
    });

    socket.on('recording-flag', (payload = {}) => {
      if (!data.roomId || !data.participantId) return;
      const self = getRoomMap(data.roomId).get(data.participantId);
      if (!self || (self.role !== 'host' && self.role !== 'moderator')) return;
      const next = Boolean(payload.active);
      recordingFlags.set(data.roomId, next);
      io.to(data.roomId).emit('recording-flag', { active: next, recording: next });
      broadcastRoomState(data.roomId);
    });

    socket.on('disconnect', () => leave(socket));
  });

  function leave(socket) {
    const data = socket.data;
    if (!data.roomId || !data.participantId) return;
    const roomId = data.roomId;
    const participantId = data.participantId;
    getRoomMap(roomId).delete(participantId);
    socket.leave(roomId);
    socket.to(roomId).emit('peer-left', { id: participantId });
    broadcastRoomState(roomId);
    data.roomId = undefined;
    data.participantId = undefined;
  }

  console.log('VideoConf mounted at /vc (socket path /vc-socket.io)');
  return { io, router };
}

module.exports = { attachVideoConf };
