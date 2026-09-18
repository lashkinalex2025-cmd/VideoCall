const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_PATH = path.join(DATA_DIR, 'users.json');

const BOOTSTRAP_USER = process.env.ADMIN_USER || 'admin';
const BOOTSTRAP_PASSWORD = process.env.ADMIN_PASSWORD || 'VideoCall2026';
const BOOTSTRAP_EMAIL = process.env.ADMIN_EMAIL || 'admin@videocall.local';

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USERS_PATH)) {
    fs.writeFileSync(USERS_PATH, JSON.stringify({ users: [] }, null, 2));
  }
}

function read() {
  ensureFile();
  try {
    const data = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
    if (!Array.isArray(data.users)) data.users = [];
    return data;
  } catch (_) {
    return { users: [] };
  }
}

function write(data) {
  ensureFile();
  fs.writeFileSync(USERS_PATH, JSON.stringify(data, null, 2));
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    name: u.name || '',
    role: u.role,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
    createdBy: u.createdBy || 'self',
  };
}

function listUsers() {
  return read().users.map(publicUser);
}

function findByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  return read().users.find((u) => u.email === normalized || u.username === normalized) || null;
}

function findById(id) {
  return read().users.find((u) => u.id === id) || null;
}

function findByLogin(login) {
  const value = String(login || '').trim().toLowerCase();
  return (
    read().users.find(
      (u) => u.email === value || u.username === value || (u.username && u.username.toLowerCase() === value)
    ) || null
  );
}

async function ensureBootstrapAdmin() {
  const data = read();
  let admin = data.users.find((u) => u.role === 'superadmin' || u.username === BOOTSTRAP_USER);
  if (!admin) {
    admin = {
      id: uuidv4(),
      email: BOOTSTRAP_EMAIL.toLowerCase(),
      username: BOOTSTRAP_USER,
      name: 'Главный администратор',
      passwordHash: await bcrypt.hash(BOOTSTRAP_PASSWORD, 10),
      role: 'superadmin',
      createdAt: Date.now(),
      lastLoginAt: null,
      createdBy: 'system',
    };
    data.users.push(admin);
    write(data);
  }
  return publicUser(admin);
}

async function register({ email, password, name }) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return { ok: false, error: 'Некорректный email' };
  }
  if (!password || String(password).length < 6) {
    return { ok: false, error: 'Пароль должен быть не короче 6 символов' };
  }
  const data = read();
  if (data.users.some((u) => u.email === normalized)) {
    return { ok: false, error: 'Пользователь с таким email уже зарегистрирован' };
  }
  const user = {
    id: uuidv4(),
    email: normalized,
    username: normalized,
    name: String(name || normalized.split('@')[0]).trim().slice(0, 60),
    passwordHash: await bcrypt.hash(String(password), 10),
    role: 'user',
    createdAt: Date.now(),
    lastLoginAt: null,
    createdBy: 'self',
  };
  data.users.push(user);
  write(data);
  return { ok: true, user: publicUser(user) };
}

async function createUser({ email, password, name, role = 'user', createdBy = 'admin' }) {
  const allowed = ['user', 'admin', 'superadmin'];
  if (!allowed.includes(role)) return { ok: false, error: 'Некорректная роль' };
  const normalized = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) && role === 'user') {
    // allow username-like for admin-created accounts if email-shaped fails? Prefer real email.
    if (!normalized.includes('@')) {
      // treat as local username@videocall.local
    }
  }
  const emailFinal = normalized.includes('@')
    ? normalized
    : `${normalized.replace(/[^a-z0-9._-]/g, '')}@videocall.local`;
  if (!password || String(password).length < 6) {
    return { ok: false, error: 'Пароль должен быть не короче 6 символов' };
  }
  const data = read();
  if (data.users.some((u) => u.email === emailFinal || u.username === normalized)) {
    return { ok: false, error: 'Такой пользователь уже существует' };
  }
  const user = {
    id: uuidv4(),
    email: emailFinal,
    username: normalized.includes('@') ? emailFinal : normalized,
    name: String(name || emailFinal.split('@')[0]).trim().slice(0, 60),
    passwordHash: await bcrypt.hash(String(password), 10),
    role,
    createdAt: Date.now(),
    lastLoginAt: null,
    createdBy,
  };
  data.users.push(user);
  write(data);
  return { ok: true, user: publicUser(user) };
}

async function authenticate(login, password) {
  await ensureBootstrapAdmin();
  const user = findByLogin(login);
  if (!user) return { ok: false, error: 'Неверный логин или пароль' };
  const valid = await bcrypt.compare(String(password || ''), user.passwordHash);
  if (!valid) return { ok: false, error: 'Неверный логин или пароль' };
  const data = read();
  const idx = data.users.findIndex((u) => u.id === user.id);
  if (idx >= 0) {
    data.users[idx].lastLoginAt = Date.now();
    write(data);
  }
  return { ok: true, user: publicUser({ ...user, lastLoginAt: Date.now() }) };
}

function deleteUser(id, actor) {
  const data = read();
  const target = data.users.find((u) => u.id === id);
  if (!target) return { ok: false, error: 'Пользователь не найден' };
  if (target.role === 'superadmin' && actor?.role !== 'superadmin') {
    return { ok: false, error: 'Нельзя удалить главного администратора' };
  }
  if (actor?.id && target.id === actor.id) {
    return { ok: false, error: 'Нельзя удалить самого себя' };
  }
  // Keep at least one superadmin
  if (target.role === 'superadmin') {
    const supers = data.users.filter((u) => u.role === 'superadmin');
    if (supers.length <= 1) return { ok: false, error: 'Должен остаться хотя бы один главный администратор' };
  }
  data.users = data.users.filter((u) => u.id !== id);
  write(data);
  return { ok: true, id };
}

function isAdminRole(role) {
  return role === 'admin' || role === 'superadmin';
}

module.exports = {
  listUsers,
  findByEmail,
  findById,
  findByLogin,
  publicUser,
  ensureBootstrapAdmin,
  register,
  createUser,
  authenticate,
  deleteUser,
  isAdminRole,
};
