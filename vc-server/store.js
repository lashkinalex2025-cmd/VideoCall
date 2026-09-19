const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');
const DB_TMP = path.join(DATA_DIR, 'db.json.tmp');

function emptyDb() {
  return { users: [], rooms: [], messages: [], recordings: [] };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDb() {
  ensureDataDir();
  if (!fs.existsSync(DB_PATH)) {
    const db = emptyDb();
    saveDb(db);
    return db;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, 'utf8') || '{}');
    return {
      users: parsed.users || [],
      rooms: parsed.rooms || [],
      messages: parsed.messages || [],
      recordings: parsed.recordings || [],
    };
  } catch {
    return emptyDb();
  }
}

function saveDb(db) {
  ensureDataDir();
  fs.writeFileSync(DB_TMP, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(DB_TMP, DB_PATH);
}

function generateJoinCode(length = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function findRoom(db, idOrCode) {
  const key = String(idOrCode || '').trim();
  return db.rooms.find((r) => r.id === key || String(r.joinCode).toLowerCase() === key.toLowerCase());
}

function publicRoom(room) {
  return {
    id: room.id,
    title: room.title,
    description: room.description || '',
    ownerId: room.ownerId,
    joinCode: room.joinCode,
    hasPassword: Boolean(room.passwordHash),
    waitingRoom: Boolean(room.waitingRoom),
    endedAt: room.endedAt || null,
    createdAt: room.createdAt,
  };
}

module.exports = {
  ensureDataDir,
  getDb,
  saveDb,
  generateJoinCode,
  findRoom,
  publicRoom,
};
