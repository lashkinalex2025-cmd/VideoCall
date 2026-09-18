const { io } = require('socket.io-client');

async function main() {
  const health = await fetch('http://127.0.0.1:3000/api/health').then((r) => r.json());
  console.log('health', health);

  const indexRes = await fetch('http://127.0.0.1:3000/');
  const indexText = await indexRes.text();
  console.log('index', indexRes.status, indexText.length);

  const room = await fetch('http://127.0.0.1:3000/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Meet', password: 'secret', roomId: 'testroom1' }),
  }).then((r) => r.json());
  console.log('create', room);

  const info = await fetch('http://127.0.0.1:3000/api/rooms/testroom1').then((r) => r.json());
  console.log('info', info);

  const sock = io('http://127.0.0.1:3000', { transports: ['websocket'] });
  await new Promise((res, rej) => {
    sock.on('connect', res);
    sock.on('connect_error', rej);
    setTimeout(() => rej(new Error('timeout')), 5000);
  });

  const join = await new Promise((res) =>
    sock.emit('room:join', { roomId: 'testroom1', name: 'Alice', password: 'secret' }, res)
  );
  console.log('join', join.ok, join.self && join.self.role, join.room && join.room.participantCount);

  const bad = await new Promise((res) =>
    sock.emit('room:join', { roomId: 'testroom1', name: 'Bob', password: 'wrong' }, res)
  );
  console.log('badpass', bad.ok, bad.error);

  // Re-join Alice after failed attempt path is separate socket; keep Alice in room
  const sock2 = io('http://127.0.0.1:3000', { transports: ['websocket'] });
  await new Promise((res, rej) => {
    sock2.on('connect', res);
    sock2.on('connect_error', rej);
  });
  const join2 = await new Promise((res) =>
    sock2.emit('room:join', { roomId: 'testroom1', name: 'Bob', password: 'secret' }, res)
  );
  console.log('join2', join2.ok, join2.self && join2.self.role);

  const chat = await new Promise((res) => sock.emit('chat:message', { text: 'Hello all' }, res));
  console.log('chat', chat.ok);

  const priv = await new Promise((res) =>
    sock.emit('chat:message', { text: 'Private hi', to: join2.self.id }, res)
  );
  console.log('private', priv.ok, priv.message && priv.message.private);

  const report = await fetch('http://127.0.0.1:3000/api/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomName: 'Test Meet',
      transcript: 'We discussed the release plan and deadlines. Decided to launch on Friday.',
      participants: ['Alice', 'Bob'],
      durationMs: 3600000,
      startedAt: Date.now() - 3600000,
    }),
  }).then((r) => r.json());
  console.log('report_len', report.report && report.report.length);

  const assets = [
    '/css/styles.css',
    '/js/app.js',
    '/js/webrtc.js',
    '/manifest.json',
    '/sw.js',
    '/icons/icon.svg',
    '/icons/icon-192.png',
  ];
  for (const a of assets) {
    const r = await fetch('http://127.0.0.1:3000' + a);
    console.log(a, r.status);
  }

  sock.close();
  sock2.close();
  console.log('ALL_OK');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
