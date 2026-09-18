const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'conferences.json');

/**
 * @typedef {Object} StoredConference
 * @property {string} id
 * @property {string} name
 * @property {string|null} passwordHash
 * @property {object} permissions
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} lastActivityAt
 * @property {string} createdBy
 */

function ensureStoreFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(STORE_PATH, JSON.stringify({ conferences: [] }, null, 2));
  }
}

function readStore() {
  ensureStoreFile();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.conferences)) data.conferences = [];
    return data;
  } catch (_) {
    return { conferences: [] };
  }
}

function writeStore(data) {
  ensureStoreFile();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function listConferences() {
  return readStore().conferences.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

function getConference(id) {
  return readStore().conferences.find((c) => c.id === id) || null;
}

function upsertConference(conf) {
  const data = readStore();
  const idx = data.conferences.findIndex((c) => c.id === conf.id);
  if (idx >= 0) data.conferences[idx] = conf;
  else data.conferences.push(conf);
  writeStore(data);
  return conf;
}

function deleteConference(id) {
  const data = readStore();
  const before = data.conferences.length;
  data.conferences = data.conferences.filter((c) => c.id !== id);
  writeStore(data);
  return data.conferences.length < before;
}

function touchConference(id) {
  const conf = getConference(id);
  if (!conf) return null;
  conf.lastActivityAt = Date.now();
  conf.updatedAt = Date.now();
  return upsertConference(conf);
}

/**
 * Delete unused conferences: 0 active participants and older than maxAgeMs since last activity.
 */
function cleanupUnused({ maxAgeMs = 24 * 60 * 60 * 1000, activeIds = new Set() } = {}) {
  const data = readStore();
  const now = Date.now();
  const kept = [];
  const removed = [];
  for (const conf of data.conferences) {
    const active = activeIds.has(conf.id);
    const idleFor = now - (conf.lastActivityAt || conf.createdAt || 0);
    if (!active && idleFor >= maxAgeMs) removed.push(conf.id);
    else kept.push(conf);
  }
  data.conferences = kept;
  writeStore(data);
  return { removed, kept: kept.length };
}

module.exports = {
  listConferences,
  getConference,
  upsertConference,
  deleteConference,
  touchConference,
  cleanupUnused,
  STORE_PATH,
};
