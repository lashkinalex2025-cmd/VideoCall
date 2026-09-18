const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || 'lashkinalex2025@gmail.com';
const DATA_DIR = path.join(__dirname, '..', 'data');
const LOG_PATH = path.join(DATA_DIR, 'mail-log.json');

function appendMailLog(entry) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
    if (!Array.isArray(list)) list = [];
  } catch (_) {
    list = [];
  }
  list.unshift(entry);
  fs.writeFileSync(LOG_PATH, JSON.stringify(list.slice(0, 200), null, 2));
}

function createTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === '1',
    auth: { user, pass },
  });
}

async function sendNewUserNotification(user) {
  const subject = `VideoCall: новый пользователь ${user.email}`;
  const text = [
    'Зарегистрирован новый пользователь VideoCall.',
    '',
    `Email: ${user.email}`,
    `Имя: ${user.name || '—'}`,
    `Роль: ${user.role}`,
    `ID: ${user.id}`,
    `Время: ${new Date(user.createdAt || Date.now()).toLocaleString('ru-RU')}`,
    '',
    'Письмо отправлено автоматически сервисом VideoCall.',
  ].join('\n');

  const entry = {
    at: Date.now(),
    to: NOTIFY_EMAIL,
    subject,
    userId: user.id,
    email: user.email,
    sent: false,
    error: null,
  };

  const transport = createTransport();
  if (!transport) {
    entry.error = 'SMTP не настроен (SMTP_HOST/SMTP_USER/SMTP_PASS). Уведомление сохранено в mail-log.json';
    appendMailLog(entry);
    console.warn('[mail]', entry.error, '→', NOTIFY_EMAIL, user.email);
    return { ok: false, queued: true, ...entry };
  }

  try {
    await transport.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: NOTIFY_EMAIL,
      subject,
      text,
    });
    entry.sent = true;
    appendMailLog(entry);
    return { ok: true, ...entry };
  } catch (err) {
    entry.error = err.message;
    appendMailLog(entry);
    console.error('[mail] send failed', err.message);
    return { ok: false, ...entry };
  }
}

module.exports = {
  sendNewUserNotification,
  NOTIFY_EMAIL,
};
