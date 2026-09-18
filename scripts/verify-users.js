const { io } = require('socket.io-client');

const base = process.env.VIDEOCALL_URL || 'http://127.0.0.1:3022';

async function json(path, options = {}) {
  const res = await fetch(base + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  const email = `user${Date.now()}@example.com`;
  const password = 'secret12';

  const badConfirm = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      passwordConfirm: 'other',
      name: 'Test',
    }),
  });
  console.log('badConfirm', badConfirm.status);

  const reg = await json('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      passwordConfirm: password,
      name: 'Test User',
    }),
  });
  console.log('register', reg.status, !!reg.data.token, reg.data.user?.role);

  const conf = await json('/api/user/conferences', {
    method: 'POST',
    headers: { Authorization: `Bearer ${reg.data.token}` },
    body: JSON.stringify({ name: 'My Meet', roomId: 'u' + Date.now().toString(36) }),
  });
  console.log('userCreateConf', conf.status, conf.data.id);

  const adminLogin = await json('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: 'VideoCall2026' }),
  });
  console.log('adminLogin', adminLogin.status, !!adminLogin.data.token);

  const usersList = await json('/api/admin/users', {
    headers: { Authorization: `Bearer ${adminLogin.data.token}` },
  });
  console.log('usersCount', (usersList.data.users || []).length);

  const createAdmin = await json('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminLogin.data.token}` },
    body: JSON.stringify({
      email: `adm${Date.now()}@example.com`,
      password: 'secret12',
      name: 'New Admin',
      role: 'admin',
    }),
  });
  console.log('createAdmin', createAdmin.status, createAdmin.data.user?.role);

  const createUser = await json('/api/admin/users', {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminLogin.data.token}` },
    body: JSON.stringify({
      email: `plain${Date.now()}@example.com`,
      password: 'secret12',
      name: 'Plain User',
      role: 'user',
    }),
  });
  console.log('createUser', createUser.status, createUser.data.user?.role);

  // Guest join existing room
  const sock = io(base, { transports: ['websocket'] });
  await new Promise((res, rej) => {
    sock.on('connect', res);
    sock.on('connect_error', rej);
    setTimeout(() => rej(new Error('timeout')), 10000);
  });
  const join = await new Promise((res) =>
    sock.emit('room:join', { roomId: conf.data.id, name: 'Guest' }, res)
  );
  console.log('guestJoin', join.ok);

  const online = await json('/api/admin/online', {
    headers: { Authorization: `Bearer ${adminLogin.data.token}` },
  });
  console.log('onlineTotal', online.data.total);

  const delUser = await json(`/api/admin/users/${createUser.data.user.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminLogin.data.token}` },
  });
  console.log('deleteUser', delUser.status, delUser.data.ok);

  sock.close();

  const html = await fetch(base + '/').then((r) => r.text());
  console.log('ui_register', html.includes('registerForm'));
  console.log('ui_userCabinet', html.includes('userCabinet'));
  console.log('ui_adminUsers', html.includes('adminUsersList'));
  console.log('ui_adminOnline', html.includes('adminOnlineList'));
  console.log('ui_cabinetJs', (await fetch(base + '/js/cabinet.js')).ok);

  const ok =
    reg.status === 200 &&
    conf.status === 200 &&
    adminLogin.status === 200 &&
    createAdmin.status === 200 &&
    createUser.status === 200 &&
    join.ok &&
    online.data.total >= 1 &&
    delUser.data.ok &&
    html.includes('registerForm');

  console.log(ok ? 'USERS_VERIFY_OK' : 'USERS_VERIFY_FAIL');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
