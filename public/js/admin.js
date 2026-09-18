const $ = (sel) => document.querySelector(sel);

const adminState = {
  token: localStorage.getItem('vc_admin_token') || '',
  username: localStorage.getItem('vc_admin_user') || '',
};

function refreshAdminSessionFromStorage() {
  adminState.token = localStorage.getItem('vc_admin_token') || '';
  adminState.username = localStorage.getItem('vc_admin_user') || '';
}

function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (adminState.token) headers.Authorization = `Bearer ${adminState.token}`;
  return fetch(path, { ...options, headers }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  });
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU');
}

function waitApp() {
  if (window.VideoCallApp) return Promise.resolve(window.VideoCallApp);
  return new Promise((resolve) => {
    window.addEventListener('videocall:ready', () => resolve(window.VideoCallApp), { once: true });
  });
}

async function renderConferenceList() {
  const box = $('#adminConferenceList');
  if (!box) return;
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const data = await api('/api/admin/conferences');
    const list = data.conferences || [];
    if (!list.length) {
      box.innerHTML = '<p class="hint">Пока нет сохранённых ссылок. Создайте первую выше.</p>';
      return;
    }
    box.innerHTML = list
      .map((c) => {
        const status = c.active
          ? `<span class="admin-badge live">онлайн · ${c.participantCount}</span>`
          : `<span class="admin-badge">пусто</span>`;
        const pass = c.hasPassword ? '🔒 пароль' : 'без пароля';
        const url = `${location.origin}/?room=${encodeURIComponent(c.id)}`;
        return `
          <article class="admin-conf-item" data-id="${c.id}">
            <div class="admin-conf-main">
              <div class="admin-conf-title">
                <strong>${escapeHtml(c.name)}</strong>
                ${status}
              </div>
              <div class="admin-conf-meta">
                ID: <code>${escapeHtml(c.id)}</code> · ${pass}<br/>
                Создана: ${formatDate(c.createdAt)} · Активность: ${formatDate(c.lastActivityAt)}
              </div>
              <div class="admin-conf-link"><code>${escapeHtml(url)}</code></div>
            </div>
            <div class="admin-conf-actions">
              <button type="button" class="btn secondary" data-action="copy">Копировать ссылку</button>
              <button type="button" class="btn primary" data-action="join">Подключиться</button>
              <button type="button" class="btn ghost" data-action="password">Пароль</button>
              <button type="button" class="btn ghost danger-text" data-action="delete">Удалить</button>
            </div>
          </article>`;
      })
      .join('');
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      window.VideoCallApp?.showView('adminLogin');
      window.VideoCallApp?.toast('Сессия истекла — войдите снова');
      return;
    }
    box.innerHTML = `<p class="hint">Ошибка: ${escapeHtml(err.message)}</p>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function clearSession() {
  adminState.token = '';
  adminState.username = '';
  localStorage.removeItem('vc_admin_token');
  localStorage.removeItem('vc_admin_user');
}

function setSession(token, username) {
  adminState.token = token;
  adminState.username = username;
  localStorage.setItem('vc_admin_token', token);
  localStorage.setItem('vc_admin_user', username);
}

async function renderUsersList() {
  const box = $('#adminUsersList');
  if (!box) return;
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const data = await api('/api/admin/users');
    const list = data.users || [];
    if (!list.length) {
      box.innerHTML = '<p class="hint">Пользователей пока нет.</p>';
      return;
    }
    box.innerHTML = list
      .map((u) => {
        const roleLabel =
          u.role === 'superadmin' ? 'главный admin' : u.role === 'admin' ? 'администратор' : 'пользователь';
        return `
          <article class="admin-conf-item" data-user-id="${u.id}">
            <div class="admin-conf-main">
              <div class="admin-conf-title">
                <strong>${escapeHtml(u.email)}</strong>
                <span class="admin-badge">${escapeHtml(roleLabel)}</span>
              </div>
              <div class="admin-conf-meta">
                Имя: ${escapeHtml(u.name || '—')}<br/>
                Создан: ${formatDate(u.createdAt)} · Вход: ${formatDate(u.lastLoginAt)}
              </div>
            </div>
            <div class="admin-conf-actions">
              <button type="button" class="btn ghost danger-text" data-action="delete-user">Удалить</button>
            </div>
          </article>`;
      })
      .join('');
  } catch (err) {
    box.innerHTML = `<p class="hint">Ошибка: ${escapeHtml(err.message)}</p>`;
  }
}

async function renderOnlineList() {
  const box = $('#adminOnlineList');
  if (!box) return;
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const data = await api('/api/admin/online');
    const list = data.online || [];
    if (!list.length) {
      box.innerHTML = '<p class="hint">Сейчас никто не в конференции.</p>';
      return;
    }
    box.innerHTML = list
      .map(
        (o) => `
        <article class="admin-conf-item">
          <div class="admin-conf-main">
            <div class="admin-conf-title">
              <strong>${escapeHtml(o.name)}</strong>
              <span class="admin-badge live">online</span>
            </div>
            <div class="admin-conf-meta">
              Комната: <code>${escapeHtml(o.roomId)}</code> (${escapeHtml(o.roomName || '')}) · роль: ${escapeHtml(o.role)}<br/>
              Вошёл: ${formatDate(o.joinedAt)}
            </div>
          </div>
        </article>`
      )
      .join('');
  } catch (err) {
    box.innerHTML = `<p class="hint">Ошибка: ${escapeHtml(err.message)}</p>`;
  }
}

async function openCabinet() {
  refreshAdminSessionFromStorage();
  const app = await waitApp();
  $('#adminUserLabel').textContent = adminState.username || 'admin';
  app.showView('adminCabinet');
  await Promise.all([renderConferenceList(), renderUsersList(), renderOnlineList()]);
}

function initAdmin() {
  $('#adminOpenBtn')?.addEventListener('click', async () => {
    const app = await waitApp();
    if (adminState.token) {
      try {
        await api('/api/admin/conferences');
        await openCabinet();
        return;
      } catch (_) {
        clearSession();
      }
    }
    app.showView('adminLogin');
  });

  $('#adminLoginBackBtn')?.addEventListener('click', async () => {
    const app = await waitApp();
    app.showView('lobby');
  });

  $('#adminLoginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = await waitApp();
    const username = $('#adminUser').value.trim();
    const password = $('#adminPass').value;
    try {
      const data = await api('/api/admin/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      });
      setSession(data.token, data.username);
      $('#adminPass').value = '';
      app.toast('Вход выполнен');
      await openCabinet();
    } catch (err) {
      app.toast(err.message || 'Ошибка входа');
    }
  });

  $('#adminLogoutBtn')?.addEventListener('click', async () => {
    const app = await waitApp();
    try {
      await api('/api/admin/logout', { method: 'POST', body: '{}' });
    } catch (_) {
      /* ignore */
    }
    clearSession();
    app.showView('lobby');
    app.toast('Вы вышли из кабинета');
  });

  $('#adminRefreshBtn')?.addEventListener('click', () => renderConferenceList());

  $('#adminCreateForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = await waitApp();
    try {
      const created = await api('/api/admin/conferences', {
        method: 'POST',
        body: JSON.stringify({
          name: $('#adminRoomName').value.trim() || 'Конференция',
          roomId: $('#adminRoomId').value.trim() || undefined,
          password: $('#adminRoomPassword').value || '',
        }),
      });
      $('#adminRoomName').value = '';
      $('#adminRoomId').value = '';
      $('#adminRoomPassword').value = '';
      $('#adminJoinRoomId').value = created.id;
      app.toast(`Ссылка создана: ${created.id}`);
      await renderConferenceList();
    } catch (err) {
      app.toast(err.message || 'Не удалось создать');
    }
  });

  $('#adminCleanupBtn')?.addEventListener('click', async () => {
    const app = await waitApp();
    if (!confirm('Удалить неиспользуемые ссылки старше 24 часов (без участников)?')) return;
    try {
      const result = await api('/api/admin/conferences/cleanup', {
        method: 'POST',
        body: JSON.stringify({ maxAgeHours: 24 }),
      });
      app.toast(`Удалено: ${result.removedCount}. Осталось: ${result.remaining}`);
      await renderConferenceList();
    } catch (err) {
      app.toast(err.message || 'Ошибка очистки');
    }
  });

  $('#adminConferenceList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    const item = e.target.closest('.admin-conf-item');
    if (!btn || !item) return;
    const id = item.dataset.id;
    const app = await waitApp();
    const action = btn.dataset.action;

    if (action === 'copy') {
      const url = `${location.origin}/?room=${encodeURIComponent(id)}`;
      try {
        await navigator.clipboard.writeText(url);
        app.toast('Ссылка скопирована');
      } catch {
        prompt('Скопируйте ссылку:', url);
      }
      return;
    }

    if (action === 'join') {
      $('#adminJoinRoomId').value = id;
      $('#adminJoinName').value = adminState.username || app.loadLobbyName() || 'Администратор';
      $('#adminJoinForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
      app.toast('Нажмите «Войти в конференцию»');
      return;
    }

    if (action === 'password') {
      const next = prompt('Новый пароль (пусто = без пароля):', '');
      if (next === null) return;
      try {
        await api(`/api/admin/conferences/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ password: next }),
        });
        app.toast(next ? 'Пароль установлен' : 'Пароль снят');
        await renderConferenceList();
      } catch (err) {
        app.toast(err.message || 'Ошибка');
      }
      return;
    }

    if (action === 'delete') {
      if (!confirm(`Удалить ссылку «${id}»? Активные участники будут отключены.`)) return;
      try {
        await api(`/api/admin/conferences/${encodeURIComponent(id)}`, { method: 'DELETE' });
        app.toast('Ссылка удалена');
        await renderConferenceList();
      } catch (err) {
        app.toast(err.message || 'Ошибка удаления');
      }
    }
  });

  $('#adminJoinForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = await waitApp();
    const name = $('#adminJoinName').value.trim();
    const roomId = $('#adminJoinRoomId').value.trim();
    const password = $('#adminJoinPassword').value;
    app.saveLobbyName(name);
    const localStream = await app.acquireMediaInGesture();
    await app.enterRoom({ roomId, name, password, localStream });
  });

  $('#adminUsersRefreshBtn')?.addEventListener('click', () => renderUsersList());
  $('#adminOnlineRefreshBtn')?.addEventListener('click', () => renderOnlineList());
  window.addEventListener('videocall:admin-refresh', () => {
    if (adminState.token) openCabinet();
  });

  $('#adminUsersList')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action="delete-user"]');
    const item = e.target.closest('[data-user-id]');
    if (!btn || !item) return;
    const id = item.dataset.userId;
    const app = await waitApp();
    if (!confirm('Удалить этого пользователя из приложения?')) return;
    try {
      await api(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
      app.toast('Пользователь удалён');
      await renderUsersList();
    } catch (err) {
      app.toast(err.message || 'Ошибка удаления');
    }
  });

  $('#adminCreateUserForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = await waitApp();
    try {
      const result = await api('/api/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          email: $('#adminNewUserEmail').value.trim(),
          name: $('#adminNewUserName').value.trim(),
          password: $('#adminNewUserPassword').value,
          role: $('#adminNewUserRole').value,
        }),
      });
      $('#adminNewUserEmail').value = '';
      $('#adminNewUserName').value = '';
      $('#adminNewUserPassword').value = '';
      app.toast(`Создан: ${result.user.email} (${result.user.role})`);
      await renderUsersList();
    } catch (err) {
      app.toast(err.message || 'Ошибка создания');
    }
  });
}

initAdmin();
