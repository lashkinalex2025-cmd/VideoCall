const crypto = require('crypto');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'VideoCall2026';
const TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS) || 12 * 60 * 60 * 1000;

/** @type {Map<string, { username: string, expiresAt: number }>} */
const sessions = new Map();

function login(username, password) {
  if (username !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return { ok: false, error: 'Неверный логин или пароль' };
  }
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return {
    ok: true,
    token,
    username,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
}

function logout(token) {
  if (token) sessions.delete(token);
  return { ok: true };
}

function verifyToken(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-admin-token'];
  const session = verifyToken(token);
  if (!session) {
    return res.status(401).json({ error: 'Требуется вход администратора' });
  }
  req.admin = session;
  next();
}

function getAdminInfo() {
  return {
    username: ADMIN_USER,
    // never expose password
    defaultHint: !process.env.ADMIN_PASSWORD,
  };
}

module.exports = {
  login,
  logout,
  verifyToken,
  authMiddleware,
  getAdminInfo,
  ADMIN_USER,
};
