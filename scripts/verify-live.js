const { io } = require('socket.io-client');

const base = process.env.VIDEOCALL_URL || 'https://videocall-hfgy.onrender.com';

async function main() {
  const health = await fetch(base + '/api/health').then((r) => r.json());
  console.log('health', JSON.stringify(health));

  const html = await fetch(base + '/').then((r) => r.text());
  console.log('backBtn', html.includes('backToConferenceBtn'));
  console.log('clearBtn', html.includes('clearChatBtn'));
  console.log('backLabel', html.includes('К конференции'));
  console.log('clearLabel', html.includes('Очистить чат'));

  const app = await fetch(base + '/js/app.js').then((r) => r.text());
  console.log('app_backHandler', app.includes('backToConferenceBtn'));
  console.log('app_clearHandler', app.includes('clearChatBtn'));
  console.log('app_chatCleared', app.includes('chat:cleared'));
  console.log('app_chatClearEmit', app.includes('chat:clear'));

  const css = await fetch(base + '/css/styles.css').then((r) => r.text());
  console.log('css_sidePanelTop', css.includes('side-panel-top'));

  const room = await fetch(base + '/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Check Chat', roomId: 'chk' + Date.now().toString(36) }),
  }).then((r) => r.json());
  console.log('room', room.id);

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

  const joinA = await new Promise((res) => a.emit('room:join', { roomId: room.id, name: 'Host' }, res));
  const joinB = await new Promise((res) => b.emit('room:join', { roomId: room.id, name: 'Guest' }, res));
  console.log('joinA', joinA.ok, joinA.self && joinA.self.role);
  console.log('joinB', joinB.ok, joinB.self && joinB.self.role);

  const chat = await new Promise((res) => a.emit('chat:message', { text: 'hello check' }, res));
  console.log('chat', chat.ok);

  let clearedSeen = false;
  b.on('chat:cleared', () => {
    clearedSeen = true;
  });
  const clear = await new Promise((res) => a.emit('chat:clear', {}, res));
  console.log('clear', clear.ok);
  await new Promise((r) => setTimeout(r, 1000));
  console.log('clearedBroadcast', clearedSeen);

  const c = io(base, { transports: ['websocket'] });
  await new Promise((res, rej) => {
    c.on('connect', res);
    c.on('connect_error', rej);
  });
  const joinC = await new Promise((res) => c.emit('room:join', { roomId: room.id, name: 'Late' }, res));
  console.log('historyAfterClear', (joinC.chatHistory || []).length);

  a.close();
  b.close();
  c.close();

  const failed = !(
    health.ok &&
    html.includes('backToConferenceBtn') &&
    html.includes('clearChatBtn') &&
    app.includes('chat:clear') &&
    app.includes('chat:cleared') &&
    clear.ok &&
    clearedSeen &&
    (joinC.chatHistory || []).length === 0
  );

  console.log(failed ? 'VERIFY_FAILED' : 'VERIFY_OK');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
