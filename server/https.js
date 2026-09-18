const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');

const CERT_DIR = path.join(__dirname, '..', 'certs');
const KEY_PATH = path.join(CERT_DIR, 'key.pem');
const CERT_PATH = path.join(CERT_DIR, 'cert.pem');
const META_PATH = path.join(CERT_DIR, 'meta.json');

function listLocalIPs() {
  const ips = new Set(['127.0.0.1']);
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) ips.add(item.address);
    }
  }
  return [...ips];
}

async function ensureCerts() {
  const ips = listLocalIPs();
  const meta = { ips: ips.sort().join(',') };
  const metaOk =
    fs.existsSync(KEY_PATH) &&
    fs.existsSync(CERT_PATH) &&
    fs.existsSync(META_PATH) &&
    fs.readFileSync(META_PATH, 'utf8').trim() === JSON.stringify(meta);

  if (metaOk) {
    return {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH),
      ips,
    };
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const altNames = [
    { type: 2, value: 'localhost' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];

  const pems = await selfsigned.generate([{ name: 'commonName', value: 'VideoCall Local' }], {
    keySize: 2048,
    days: 365,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'subjectAltName', altNames },
    ],
  });

  const key = pems.private || pems.privateKey;
  const cert = pems.cert || pems.certificate;
  if (!key || !cert) {
    throw new Error('selfsigned: unexpected generate() result: ' + Object.keys(pems).join(','));
  }

  fs.writeFileSync(KEY_PATH, key);
  fs.writeFileSync(CERT_PATH, cert);
  fs.writeFileSync(META_PATH, JSON.stringify(meta));
  return { key, cert, ips };
}

module.exports = { ensureCerts, CERT_DIR, listLocalIPs };
