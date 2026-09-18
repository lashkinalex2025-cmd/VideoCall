const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const out = Buffer.alloc(1 + size * 3);
    out[0] = 0;
    for (let x = 0; x < size; x++) {
      const inRect = x > size * 0.28 && x < size * 0.58 && y > size * 0.32 && y < size * 0.68;
      const triWidth = size * 0.23;
      const dx = x - size * 0.55;
      const inTri =
        x > size * 0.55 &&
        x < size * 0.78 &&
        Math.abs(y - size / 2) < size * 0.18 * (1 - dx / triWidth);
      let R = 11;
      let G = 18;
      let B = 32;
      if (x > size * 0.08 && y > size * 0.08 && x < size * 0.92 && y < size * 0.92) {
        R = 59;
        G = 130;
        B = 246;
      }
      if (inRect || inTri) {
        R = 11;
        G = 18;
        B = 32;
      }
      const i = 1 + x * 3;
      out[i] = R;
      out[i + 1] = G;
      out[i + 2] = B;
    }
    rows.push(out);
  }
  const raw = Buffer.concat(rows);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = path.join(__dirname, '..', 'public', 'icons');
fs.writeFileSync(path.join(dir, 'icon-192.png'), png(192));
fs.writeFileSync(path.join(dir, 'icon-512.png'), png(512));
console.log('icons ok');
