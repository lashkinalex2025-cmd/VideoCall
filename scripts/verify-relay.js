const { io } = require('socket.io-client');

const base = process.env.VIDEOCALL_URL || 'http://127.0.0.1:3000';

async function main() {
  const health = await fetch(base + '/api/health').then((r) => r.json());
  console.log('health', JSON.stringify(health));

  const relayRes = await fetch(base + '/js/relay.js', { cache: 'no-store' });
  const relayText = await relayRes.text();
  console.log('relay_js', relayRes.status, relayText.includes('SocketMediaRelay'), relayText.includes('resumeAudio'));

  const appText = await fetch(base + '/js/app.js', { cache: 'no-store' }).then((r) => r.text());
  console.log('app_import', appText.includes("from './relay.js'") || appText.includes('from "./relay.js"'));
  console.log('app_starts_relay', appText.includes('state.relay.start()'));

  const swText = await fetch(base + '/sw.js', { cache: 'no-store' }).then((r) => r.text());
  console.log('sw', /videocall-v\d+/.exec(swText)?.[0] || 'none');

  const roomId = 'vr' + Date.now().toString(36);
  const created = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'RelayVerify', roomId }),
  }).then((r) => r.json());
  console.log('room', created.id || created.error);

  const a = io(base, { transports: ['websocket'] });
  const b = io(base, { transports: ['websocket'] });
  await Promise.all([
    new Promise((res, rej) => {
      a.on('connect', res);
      a.on('connect_error', rej);
      setTimeout(() => rej(new Error('a timeout')), 20000);
    }),
    new Promise((res, rej) => {
      b.on('connect', res);
      b.on('connect_error', rej);
      setTimeout(() => rej(new Error('b timeout')), 20000);
    }),
  ]);

  const joinA = await new Promise((res) => a.emit('room:join', { roomId, name: 'PC' }, res));
  const joinB = await new Promise((res) => b.emit('room:join', { roomId, name: 'Phone' }, res));
  console.log('join', joinA.ok, joinB.ok);

  // JPEG SOI/EOI minimal marker + padding so receiver accepts (>=24 bytes)
  const jpeg = Buffer.alloc(32, 0);
  jpeg[0] = 0xff;
  jpeg[1] = 0xd8;
  jpeg[2] = 0xff;
  jpeg[3] = 0xd9;

  const videoGot = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('video relay timeout')), 8000);
    b.on('relay:video', (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
    a.emit('relay:video', jpeg);
  });
  console.log('video_relay', videoGot.from === joinA.self.id, videoGot.data?.byteLength || videoGot.data?.length);

  const pcm = Buffer.alloc(640);
  const audioGot = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('audio relay timeout')), 8000);
    b.on('relay:audio', (payload) => {
      clearTimeout(t);
      resolve(payload);
    });
    a.emit('relay:audio', pcm);
  });
  console.log('audio_relay', audioGot.from === joinA.self.id, audioGot.data?.byteLength || audioGot.data?.length);

  a.close();
  b.close();

  const ok =
    health.ok &&
    relayRes.status === 200 &&
    relayText.includes('SocketMediaRelay') &&
    relayText.includes('resumeAudio') &&
    (appText.includes("from './relay.js'") || appText.includes('from "./relay.js"')) &&
    appText.includes('state.relay.start()') &&
    videoGot.from === joinA.self.id &&
    audioGot.from === joinA.self.id;

  console.log(ok ? 'VERIFY_RELAY_OK' : 'VERIFY_RELAY_FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
