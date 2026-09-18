const base = process.env.VIDEOCALL_URL || 'http://127.0.0.1:3022';

async function main() {
  const health = await fetch(base + '/api/health').then((r) => r.json());
  console.log('health', health);

  const bad = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  });
  console.log('badLogin', bad.status);

  const login = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'VideoCall2026' }),
  }).then((r) => r.json());
  if (!login.token) throw new Error('no token');
  console.log('login ok', login.username);

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${login.token}`,
  };

  const created = await fetch(base + '/api/admin/conferences', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Admin Link', roomId: 'adm' + Date.now().toString(36), password: 'secret' }),
  }).then((r) => r.json());
  console.log('created', created.id, created.hasPassword);

  const list1 = await fetch(base + '/api/admin/conferences', { headers }).then((r) => r.json());
  console.log('listCount', list1.total);

  const patched = await fetch(base + '/api/admin/conferences/' + created.id, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ password: '' }),
  }).then((r) => r.json());
  console.log('passwordCleared', patched.hasPassword === false);

  // Create an old unused conference by writing via cleanup path:
  // make another and delete it individually
  const doomed = await fetch(base + '/api/admin/conferences', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Doomed', roomId: 'doom' + Date.now().toString(36) }),
  }).then((r) => r.json());

  const del = await fetch(base + '/api/admin/conferences/' + doomed.id, {
    method: 'DELETE',
    headers,
  }).then((r) => r.json());
  console.log('deleted', del.ok, del.id);

  const cleanup = await fetch(base + '/api/admin/conferences/cleanup', {
    method: 'POST',
    headers,
    body: JSON.stringify({ maxAgeHours: 0.0001 }),
  }).then((r) => r.json());
  console.log('cleanup', cleanup.removedCount, 'remaining', cleanup.remaining);

  const html = await fetch(base + '/').then((r) => r.text());
  console.log('ui_adminOpen', html.includes('adminOpenBtn'));
  console.log('ui_cabinet', html.includes('adminCabinet'));
  console.log('ui_adminJs', (await fetch(base + '/js/admin.js')).ok);

  console.log('ADMIN_VERIFY_OK');
}

main().catch((e) => {
  console.error('ADMIN_VERIFY_FAIL', e);
  process.exit(1);
});
