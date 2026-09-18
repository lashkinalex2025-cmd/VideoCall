const $ = (sel) => document.querySelector(sel);

const userState = {
  token: localStorage.getItem('vc_user_token') || '',
  user: null,
};

try {
  userState.user = JSON.parse(localStorage.getItem('vc_user_profile') || 'null');
} catch (_) {
  userState.user = null;
}

function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };
  if (userState.token) headers.Authorization = `Bearer ${userState.token}`;
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

function waitApp() {
  if (window.VideoCallApp) return Promise.resolve(window.VideoCallApp);
  return new Promise((resolve) => {
    window.addEventListener('videocall:ready', () => resolve(window.VideoCallApp), { once: true });
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('ru-RU');
}

function setSession(token, user) {
  userState.token = token;
  userState.user = user;
  localStorage.setItem('vc_user_token', token);
  localStorage.setItem('vc_user_profile', JSON.stringify(user));
}

function clearSession() {
  userState.token = '';
  userState.user = null;
  localStorage.removeItem('vc_user_token');
  localStorage.removeItem('vc_user_profile');
}

async function openUserCabinet() {
  const app = await waitApp();
  const label = userState.user?.email || userState.user?.name || 'пользователь';
  $('#userCabinetLabel').textContent = label;
  app.showView('userCabinet');
  await renderUserConferences();
}

async function renderUserConferences() {
  const box = $('#userConferenceList');
  if (!box) return;
  box.innerHTML = '<p class="hint">Загрузка…</p>';
  try {
    const data = await api('/api/user/conferences');
    const list = data.conferences || [];
    if (!list.length) {
      box.innerHTML = '<p class="hint">Пока нет конференций. Создайте первую выше.</p>';
      return;
    }
    box.innerHTML = list
      .map((c) => {
        const status = c.active
          ? `<span class="admin-badge live">онлайн · ${c.participantCount}</span>`
          : `<span class="admin-badge">ожидает старта</span>`;
        const url = `${location.origin}/?room=${encodeURIComponent(c.id)}`;
        return `
          <article class="admin-conf-item" data-id="${c.id}">
            <div class="admin-conf-main">
              <div class="admin-conf-title">
                <strong>${escapeHtml(c.name)}</strong>
                ${status}
              </div>
              <div class="admin-conf-meta">
                ID: <code>${escapeHtml(c.id)}</code> · ${c.hasPassword ? '🔒 пароль' : 'без пароля'}<br/>
                Создана: ${formatDate(c.createdAt)}
              </div>
              <div class="admin-conf-link"><code>${escapeHtml(url)}</code></div>
            </div>
            <div class="admin-conf-actions">
              <button type="button" class="btn primary" data-action="start">Начать</button>
              <button type="button" class="btn secondary" data-action="copy">Копировать ссылку</button>
              <button type="button" class="btn ghost" data-action="password">Пароль</button>
              <button type="button" class="btn ghost danger-text" data-action="delete">Удалить</button>
            </div>
          </article>`;
      })
      .join('');
  } catch (err) {
    if (err.status === 401) {
      clearSession();
      window.VideoCallApp?.showView('lobby');
      window.VideoCallApp?.toast('Сессия истекла — войдите снова');
      return;
    }
    box.innerHTML = `<p class="hint">Ошибка: ${escapeHtml(err.message)}</p>`;
  }
}

async function createConference({ start = false } = {}) {
  const app = await waitApp();
  const name = $('#userRoomName').value.trim() || 'Конференция';
  const roomId = $('#userRoomId').value.trim() || undefined;
  const password = $('#userRoomPassword').value || '';
  const created = await api('/api/user/conferences', {
    method: 'POST',
    body: JSON.stringify({ name, roomId, password }),
  });
  $('#userRoomName').value = '';
  $('#userRoomId').value = '';
  $('#userRoomPassword').value = '';
  app.toast(`Конференция создана: ${created.id}`);
  await renderUserConferences();
  if (start) {
    const displayName = userState.user?.name || userState.user?.email || 'Пользователь';
    app.saveLobbyName(displayName);
    const localStream = await app.acquireMediaInGesture();
    await app.enterRoom({
      roomId: created.id,
      name: displayName,
      password,
      localStream,
    });
  }
  return created;
}

function initCabinet() {
  $('#registerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = await waitApp();
    const email = $('#registerEmail').value.trim();
    const name = $('#registerName').value.trim();
    const password = $('#registerPassword').value;
    const passwordConfirm = $('#registerPasswordConfirm').value;
    if (password !== passwordConfirm) {
      app.toast('Пароли не совпадают');
      return;
    }
    try {
      const data = await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, name, password, passwordConfirm }),
      });
      setSession(data.token, data.user);
      $('#registerPassword').value = '';
      $('#registerPasswordConfirm').value = '';
      app.toast('Регистрация успешна. Добро пожаловать!');
      await openUserCabinet();
    } catch (err) {
      app.toast(err.message || 'Ошибка регистрации');
    }
  });

  $('#userLoginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const app = await waitApp();
    const email = $('#userLoginEmail').value.trim();
    const password = $('#userLoginPassword').value;
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setSession(data.token, data.user);
      $('#userLoginPassword').value = '';
      if (data.user?.role === 'admin' || data.user?.role === 'superadmin') {
        // Admins can use admin cabinet via existing button; also allow user cabinet
        localStorage.setItem('vc_admin_token', data.token);
        localStorage.setItem('vc_admin_user', data.user.email || email);
      }
      app.toast('Вход выполнен');
      if (data.user?.role === 'admin' || data.user?.role === 'superadmin') {
        // Prefer admin cabinet for admins
        app.showView('adminCabinet');
        window.dispatchEvent(new Event('videocall:admin-refresh'));
      } else {
        await openUserCabinet();
      }
    } catch (err) {
      app.toast(err.message || 'Ошибка входа');
    }
  });

  $('#userCreateForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await createConference({ start: false });
    } catch (err) {
      window.VideoCallApp?.toast(err.message || 'Ошибка создания');
    }
  });

  $('#userCreateAndStartBtn')?.addEventListener('click', async () => {
    try {
      await createConference({ start: true });
    } catch (err) {
      window.VideoCallApp?.toast(err.message || 'Ошибка запуска');
    }
  });

  $('#userRefreshBtn')?.addEventListener('click', () => renderUserConferences());
  $('#userHomeBtn')?.addEventListener('click', async () => {
    const app = await waitApp();
    app.showView('lobby');
  });
  $('#userLogoutBtn')?.addEventListener('click', async () => {
    const app = await waitApp();
    try {
      await api('/api/auth/logout', { method: 'POST', body: '{}' });
    } catch (_) {
      /* ignore */
    }
    clearSession();
    app.showView('lobby');
    app.toast('Вы вышли из кабинета');
  });

  $('#userConferenceList')?.addEventListener('click', async (e) => {
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

    if (action === 'start') {
      const displayName = userState.user?.name || userState.user?.email || 'Пользователь';
      app.saveLobbyName(displayName);
      const localStream = await app.acquireMediaInGesture();
      await app.enterRoom({ roomId: id, name: displayName, password: '', localStream });
      return;
    }

    if (action === 'password') {
      const next = prompt('Новый пароль (пусто = без пароля):', '');
      if (next === null) return;
      try {
        await api(`/api/user/conferences/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ password: next }),
        });
        app.toast(next ? 'Пароль установлен' : 'Пароль снят');
        await renderUserConferences();
      } catch (err) {
        app.toast(err.message || 'Ошибка');
      }
      return;
    }

    if (action === 'delete') {
      if (!confirm(`Удалить конференцию «${id}»?`)) return;
      try {
        await api(`/api/user/conferences/${encodeURIComponent(id)}`, { method: 'DELETE' });
        app.toast('Удалено');
        await renderUserConferences();
      } catch (err) {
        app.toast(err.message || 'Ошибка удаления');
      }
    }
  });
}

initCabinet();
