const crypto = require('crypto');

/**
 * Open Relay (Metered) static-auth TURN — работает между разными сетями / мобильным интернетом.
 * Формат coturn REST: username = expiry, credential = base64(hmac_sha1(secret, username))
 * Docs: https://www.metered.ca/tools/openrelay/
 */
const OPENRELAY_SECRET =
  process.env.TURN_SECRET || process.env.OPENRELAY_SECRET || 'openrelayprojectsecret';
const TURN_TTL_SEC = Number(process.env.TURN_TTL_SEC) || 60 * 60 * 6; // 6 hours

function turnCredential(username) {
  return crypto.createHmac('sha1', OPENRELAY_SECRET).update(username).digest('base64');
}

function buildOpenRelayIceServers() {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SEC;
  // coturn REST: username = "<expiry>:<id>", password = HMAC-SHA1(secret, username)
  const username = `${expiry}:videocall`;
  const credential = turnCredential(username);
  const auth = { username, credential };

  // Также короткий формат username = expiry (некоторые конфиги Open Relay)
  const usernameShort = String(expiry);
  const authShort = { username: usernameShort, credential: turnCredential(usernameShort) };

  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' },
    { urls: 'turn:staticauth.openrelay.metered.ca:80', ...auth },
    { urls: 'turn:staticauth.openrelay.metered.ca:80?transport=tcp', ...auth },
    { urls: 'turn:staticauth.openrelay.metered.ca:443', ...auth },
    { urls: 'turns:staticauth.openrelay.metered.ca:443?transport=tcp', ...auth },
    { urls: 'turn:staticauth.openrelay.metered.ca:80', ...authShort },
    { urls: 'turn:staticauth.openrelay.metered.ca:443?transport=tcp', ...authShort },
  ];
}

async function fetchMeteredIceServers() {
  const apiKey = process.env.METERED_TURN_API_KEY;
  const appName = process.env.METERED_APP_NAME;
  if (!apiKey || !appName) return null;
  const url = `https://${appName}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Metered TURN HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.iceServers || null;
}

async function getIceServers() {
  try {
    const metered = await fetchMeteredIceServers();
    if (metered?.length) {
      return {
        iceServers: metered,
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 8,
        source: 'metered-api',
      };
    }
  } catch (err) {
    console.warn('Metered TURN fetch failed:', err.message);
  }

  return {
    iceServers: buildOpenRelayIceServers(),
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 8,
    source: 'openrelay-staticauth',
  };
}

module.exports = { getIceServers, buildOpenRelayIceServers };
