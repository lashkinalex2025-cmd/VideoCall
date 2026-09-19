const crypto = require('crypto');

/**
 * Open Relay (Metered) — бесплатный TURN для разных сетей / мобильного интернета.
 * Docs: https://www.metered.ca/tools/openrelay/
 *
 * 1) Static-auth (coturn REST): username = expiry[:id], credential = HMAC-SHA1(secret, username)
 * 2) Legacy shared user/pass (ещё встречается в старых клиентах)
 * 3) Опционально: METERED_TURN_API_KEY + METERED_APP_NAME → персональные creds
 */
const OPENRELAY_SECRET =
  process.env.TURN_SECRET || process.env.OPENRELAY_SECRET || 'openrelayprojectsecret';
const TURN_TTL_SEC = Number(process.env.TURN_TTL_SEC) || 60 * 60 * 6; // 6 hours

function turnCredential(username) {
  return crypto.createHmac('sha1', OPENRELAY_SECRET).update(username).digest('base64');
}

function buildOpenRelayIceServers() {
  const expiry = Math.floor(Date.now() / 1000) + TURN_TTL_SEC;
  const usernameLong = `${expiry}:videocall`;
  const authLong = { username: usernameLong, credential: turnCredential(usernameLong) };
  const usernameShort = String(expiry);
  const authShort = { username: usernameShort, credential: turnCredential(usernameShort) };
  const legacy = { username: 'openrelayproject', credential: 'openrelayproject' };

  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },

    // Static-auth Open Relay (основной путь для cross-NAT)
    { urls: 'turn:staticauth.openrelay.metered.ca:80', ...authLong },
    { urls: 'turn:staticauth.openrelay.metered.ca:80?transport=tcp', ...authLong },
    { urls: 'turn:staticauth.openrelay.metered.ca:443', ...authLong },
    { urls: 'turns:staticauth.openrelay.metered.ca:443?transport=tcp', ...authLong },
    { urls: 'turn:staticauth.openrelay.metered.ca:80', ...authShort },
    { urls: 'turn:staticauth.openrelay.metered.ca:443?transport=tcp', ...authShort },

    // Legacy shared credentials + hostname без staticauth
    { urls: 'turn:openrelay.metered.ca:80', ...legacy },
    { urls: 'turn:openrelay.metered.ca:443', ...legacy },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', ...legacy },
    { urls: 'turns:openrelay.metered.ca:443?transport=tcp', ...legacy },
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
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          ...metered,
        ],
        iceTransportPolicy: 'all',
        iceCandidatePoolSize: 4,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require',
        source: 'metered-api',
      };
    }
  } catch (err) {
    console.warn('Metered TURN fetch failed:', err.message);
  }

  return {
    iceServers: buildOpenRelayIceServers(),
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 4,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    source: 'openrelay-staticauth',
  };
}

module.exports = { getIceServers, buildOpenRelayIceServers };
