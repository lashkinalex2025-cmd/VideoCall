const crypto = require('crypto');
const users = require('./users');

const TOKEN_TTL_MS = Number(process.env.ADMIN_TOKEN_TTL_MS) || 12 * 60 * 60 * 1000;

/** @type {Map<string, { userId: string, role: string, email: string, name: string, expiresAt: number }>} */
const sessions = new Map();

function issueToken(user) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    userId: user.id,
    role: user.role,
    email: user.email,
    name: user.name || '',
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return {
    ok: true,
    token,
    user,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  };
}

async function login(login, password) {
  const result = await users.authenticate(login, password);
  if (!result.ok) return result;
  return issueToken(result.user);
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

function getBearer(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  return req.headers['x-admin-token'] || req.headers['x-auth-token'] || '';
}

function authRequired(req, res, next) {
  const session = verifyToken(getBearer(req));
  if (!session) return res.status(401).json({ error: 'Требуется вход' });
  req.auth = session;
  next();
}

function adminRequired(req, res, next) {
  const session = verifyToken(getBearer(req));
  if (!session) return res.status(401).json({ error: 'Требуется вход администратора' });
  if (!users.isAdminRole(session.role)) {
    return res.status(403).json({ error: 'Недостаточно прав' });
  }
  req.auth = session;
  req.admin = session; // backward compatible
  next();
}

function superAdminRequired(req, res, next) {
  const session = verifyToken(getBearer(req));
  if (!session) return res.status(401).json({ error: 'Требуется вход' });
  if (session.role !== 'superadmin' && session.role !== 'admin') {
    // Both admin and superadmin can appoint admins per user request
    return res.status(403).json({ error: 'Недостаточно прав' });
  }
  req.auth = session;
  req.admin = session;
  next();
}

module.exports = {
  login,
  logout,
  verifyToken,
  issueToken,
  authRequired,
  adminRequired,
  superAdminRequired,
  getBearer,
};
