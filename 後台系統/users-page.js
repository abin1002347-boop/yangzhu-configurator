// 楊竹科技後台系統 — 帳號管理頁（正式管理員帳號、角色權限、登入限制與操作稽核批次）
// 這個頁面只有 owner 能實際操作成功：後端 /api/admin/users 系列 API 用 requirePermission
// ('admin_users', ...) 把關（見 admin-rbac.js），這裡的畫面隱藏／按鈕只是體驗改善，
// 不是安全邊界——manager／staff／viewer 就算硬改網址進來，呼叫API一律會被後端擋在403。

const ADMIN_USERS_ROLE_LABELS = { owner: 'owner（所有權限）', manager: 'manager（營運管理）', staff: 'staff（日常處理）', viewer: 'viewer（唯讀）' };
let adminUsersCache = [];

function onAdminReady() {
  loadAdminUsers();
}

async function loadAdminUsers() {
  document.getElementById('users-loading').classList.remove('hidden');
  document.getElementById('users-error').classList.add('hidden');
  document.getElementById('users-table-wrap').classList.add('hidden');
  try {
    const resp = await adminFetch('/api/admin/users');
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      document.getElementById('users-loading').classList.add('hidden');
      document.getElementById('users-error-text').textContent = (data && data.error) || '讀取失敗';
      document.getElementById('users-error').classList.remove('hidden');
      return;
    }
    adminUsersCache = Array.isArray(data.users) ? data.users : [];
    renderAdminUsersTable();
    document.getElementById('users-loading').classList.add('hidden');
    document.getElementById('users-table-wrap').classList.remove('hidden');
  } catch (e) {
    document.getElementById('users-loading').classList.add('hidden');
    document.getElementById('users-error-text').textContent = '讀取失敗：' + e.message;
    document.getElementById('users-error').classList.remove('hidden');
  }
}

function fmtUsersTime(iso) {
  if (!iso) return '--';
  try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
  catch { return iso; }
}

function renderAdminUsersTable() {
  const tbody = document.getElementById('users-tbody');
  tbody.textContent = '';
  const myId = (typeof adminCurrentUser !== 'undefined' && adminCurrentUser) ? adminCurrentUser.id : null;

  adminUsersCache.forEach(u => {
    const tr = document.createElement('tr');

    const tdUsername = document.createElement('td');
    tdUsername.textContent = u.username;
    tr.appendChild(tdUsername);

    const tdDisplayName = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = u.displayName;
    nameInput.style.cssText = 'width:100%;padding:4px 6px;border:1px solid var(--gray-200);border-radius:4px;font-size:12.5px;';
    nameInput.addEventListener('change', () => saveDisplayName(u.id, nameInput));
    tdDisplayName.appendChild(nameInput);
    tr.appendChild(tdDisplayName);

    const tdRole = document.createElement('td');
    const roleSelect = document.createElement('select');
    roleSelect.style.cssText = 'padding:4px 6px;border:1px solid var(--gray-200);border-radius:4px;font-size:12.5px;';
    Object.keys(ADMIN_USERS_ROLE_LABELS).forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = ADMIN_USERS_ROLE_LABELS[r];
      if (r === u.role) opt.selected = true;
      roleSelect.appendChild(opt);
    });
    roleSelect.addEventListener('change', () => changeUserRole(u, roleSelect));
    tdRole.appendChild(roleSelect);
    tr.appendChild(tdRole);

    const tdStatus = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'status-pill ' + (u.status === 'active' ? 'active' : 'inactive');
    pill.textContent = u.status === 'active' ? '啟用中' : '已停用';
    tdStatus.appendChild(pill);
    tr.appendChild(tdStatus);

    const tdFail = document.createElement('td');
    tdFail.textContent = String(u.failedLoginCount || 0);
    tr.appendChild(tdFail);

    const tdLocked = document.createElement('td');
    const lockedActive = u.lockedUntil && new Date(u.lockedUntil).getTime() > Date.now();
    tdLocked.textContent = lockedActive ? fmtUsersTime(u.lockedUntil) : '--';
    tr.appendChild(tdLocked);

    const tdLastLogin = document.createElement('td');
    tdLastLogin.textContent = fmtUsersTime(u.lastLoginAt);
    tr.appendChild(tdLastLogin);

    const tdActions = document.createElement('td');
    tdActions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    const pwBtn = document.createElement('button');
    pwBtn.type = 'button';
    pwBtn.className = 'btn btn-secondary btn-sm';
    pwBtn.textContent = '設定新密碼';
    pwBtn.addEventListener('click', () => openResetPasswordModal(u.id, u.username));
    tdActions.appendChild(pwBtn);

    const isSelf = myId != null && String(myId) === String(u.id);
    const statusBtn = document.createElement('button');
    statusBtn.type = 'button';
    statusBtn.className = 'btn btn-secondary btn-sm';
    statusBtn.textContent = u.status === 'active' ? '停用' : '啟用';
    if (isSelf && u.status === 'active') {
      statusBtn.disabled = true;
      statusBtn.title = '不可以停用自己的帳號';
    }
    statusBtn.addEventListener('click', () => toggleUserStatus(u, statusBtn));
    tdActions.appendChild(statusBtn);

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });
}

// 顯示名稱是欄位失焦(change)時直接送出，用adminRunAction把輸入框在送出期間disable，
// 防止使用者在請求還沒回來前又觸發第二次change（例如快速切換到別的欄位又切回來）。
async function saveDisplayName(id, inputEl) {
  const displayName = inputEl.value.trim();
  if (!displayName) { showAdminToast('顯示名稱不可為空', true); loadAdminUsers(); return; }
  await adminRunAction(inputEl, null, async () => {
    try {
      const resp = await adminFetch(`/api/admin/users/${encodeURIComponent(id)}/display-name`, {
        method: 'PUT', body: JSON.stringify({ displayName })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) { showAdminToast((data && data.error) || '更新失敗', true); loadAdminUsers(); return; }
      showAdminToast('顯示名稱已更新');
      loadAdminUsers();
    } catch (e) {
      showAdminToast('更新失敗：' + e.message, true);
      loadAdminUsers();
    }
  });
}

// 危險操作二次確認：修改角色影響這個帳號能做什麼，尤其是「移除owner」這種不可逆的權限
// 調整，改用共用確認對話框＋要求輸入帳號名稱作為確認文字（提高誤觸門檻）。2026-08-21
// 後端 PUT /users/:id/role 已經補上操作者密碼重新驗證（跟正式資料庫還原同一套scrypt比對
// 方式），這裡收集requirePassword並真的把值送給後端驗證。
// 2026-08-21 Codex獨立檢測指出adminRunAction()原本只包住確認後的fetch，原始select在
// 確認視窗開啟期間並未鎖定，快速連續觸發可以在第一個確認視窗還沒關閉前再開一個——改成
// adminRunAction()包住整個流程（含確認對話框），select從函式一開始被呼叫就立刻鎖定。
async function changeUserRole(u, selectEl) {
  const newRole = selectEl.value;
  if (newRole === u.role) return;
  await adminRunAction(selectEl, null, async () => {
    const { confirmed, password } = await adminConfirmDialog({
      title: '確認變更角色',
      message: `確定要把「${u.username}」的角色從 ${ADMIN_USERS_ROLE_LABELS[u.role] || u.role} 改成 ${ADMIN_USERS_ROLE_LABELS[newRole] || newRole} 嗎？這會直接改變這個帳號能操作的功能範圍。`,
      danger: true,
      confirmLabel: '確認變更',
      requireText: { label: `請輸入帳號名稱「${u.username}」以確認變更`, matchValue: u.username },
      requirePassword: true
    });
    if (!confirmed) { selectEl.value = u.role; return; }
    try {
      const resp = await adminFetch(`/api/admin/users/${encodeURIComponent(u.id)}/role`, {
        method: 'PUT', body: JSON.stringify({ role: newRole, password })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) { showAdminToast((data && data.error) || '更新角色失敗', true); selectEl.value = u.role; return; }
      showAdminToast('角色已更新');
      loadAdminUsers();
    } catch (e) {
      showAdminToast('更新角色失敗：' + e.message, true);
      selectEl.value = u.role;
    }
  });
}

// 同樣把adminRunAction()改成包住整個流程（含確認對話框）。busyText改傳null（不假手
// adminRunAction()自動管理文字），「停用中…／啟用中…」延後到使用者確認後才手動設定，
// 避免確認視窗還開著的時候背景按鈕就先顯示忙碌文字；失敗時手動恢復原文字，成功時
// loadAdminUsers()會整批重繪表格、舊按鈕直接被換掉，不需要另外恢復。
async function toggleUserStatus(u, btnEl) {
  const nextStatus = u.status === 'active' ? 'disabled' : 'active';
  const verb = nextStatus === 'disabled' ? '停用' : '啟用';
  const originalLabel = btnEl.textContent;
  await adminRunAction(btnEl, null, async () => {
    const { confirmed, password } = await adminConfirmDialog({
      title: `確認${verb}帳號`,
      message: `確定要${verb}帳號「${u.username}」嗎？` + (nextStatus === 'disabled' ? '停用後這個帳號目前所有登入中的Session會立即失效。' : ''),
      danger: nextStatus === 'disabled',
      confirmLabel: `確認${verb}`,
      requirePassword: true
    });
    if (!confirmed) return;
    btnEl.textContent = verb + '中…';
    try {
      const resp = await adminFetch(`/api/admin/users/${encodeURIComponent(u.id)}/status`, {
        method: 'POST', body: JSON.stringify({ status: nextStatus, password })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) { showAdminToast((data && data.error) || `${verb}失敗`, true); btnEl.textContent = originalLabel; return; }
      showAdminToast(`已${verb}`);
      loadAdminUsers();
    } catch (e) {
      showAdminToast(`${verb}失敗：` + e.message, true);
      btnEl.textContent = originalLabel;
    }
  });
}

// ─── 新增管理員 ─────────────────────────────
function openNewUserModal() {
  document.getElementById('new-user-username').value = '';
  document.getElementById('new-user-display-name').value = '';
  document.getElementById('new-user-password').value = '';
  document.getElementById('new-user-role').value = 'manager';
  document.getElementById('new-user-error').textContent = '';
  document.getElementById('new-user-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-user-username').focus(), 30);
}
function closeNewUserModal() {
  document.getElementById('new-user-modal').classList.add('hidden');
}
// 新增帳號本身雖然可逆（之後可以停用），但仍是會實際建立具登入權限帳號的操作，加上一道
// 確認對話框；2026-08-21後端 POST /api/admin/users 已經補上操作者密碼重新驗證（新增owner
// 帳號屬於高風險操作，不能只靠角色權限擋），這裡收集requirePassword一併送出。
// adminRunAction()包住整個流程（含確認對話框），按鈕從函式一開始被呼叫就立刻鎖定，避免
// 快速連續觸發時確認視窗還沒關閉又開出第二個。busyText改傳null，「建立中…」延後到確認
// 之後才手動設定；失敗時表單內容原樣保留、手動恢復按鈕文字，方便使用者修正錯誤後重新送出。
async function submitNewUser(btnEl) {
  const username = document.getElementById('new-user-username').value.trim();
  const displayName = document.getElementById('new-user-display-name').value.trim();
  const password = document.getElementById('new-user-password').value;
  const role = document.getElementById('new-user-role').value;
  const errEl = document.getElementById('new-user-error');
  errEl.textContent = '';
  if (!username || !displayName || !password) {
    errEl.textContent = '請完整填寫帳號、顯示名稱與初始密碼';
    return;
  }
  const originalLabel = btnEl.textContent;
  await adminRunAction(btnEl, null, async () => {
    const { confirmed, password: currentPassword } = await adminConfirmDialog({
      title: '確認建立管理員帳號',
      message: `確定要建立帳號「${username}」（${ADMIN_USERS_ROLE_LABELS[role] || role}）嗎？`,
      confirmLabel: '確認建立',
      requirePassword: true
    });
    if (!confirmed) return;
    btnEl.textContent = '建立中…';
    try {
      const resp = await adminFetch('/api/admin/users', {
        method: 'POST', body: JSON.stringify({ username, displayName, password, role, currentPassword })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) { errEl.textContent = (data && data.error) || '建立失敗'; btnEl.textContent = originalLabel; return; }
      closeNewUserModal();
      showAdminToast('管理員帳號已建立');
      loadAdminUsers();
    } catch (e) {
      errEl.textContent = '建立失敗：' + e.message;
      btnEl.textContent = originalLabel;
    }
  });
}

// ─── 設定新密碼 ─────────────────────────────
let resetPasswordTargetId = null;
function openResetPasswordModal(id, username) {
  resetPasswordTargetId = id;
  document.getElementById('reset-password-title').textContent = `設定新密碼 — ${username}`;
  document.getElementById('reset-password-input').value = '';
  document.getElementById('reset-password-error').textContent = '';
  document.getElementById('reset-password-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('reset-password-input').focus(), 30);
}
function closeResetPasswordModal() {
  document.getElementById('reset-password-modal').classList.add('hidden');
  resetPasswordTargetId = null;
}
// 跟changeUserRole()同樣的理由，後端 POST /users/:id/password 已經補上操作者密碼重新
// 驗證，這裡收集requirePassword。對話框收集的是「操作者目前登入密碼」（送給後端當
// currentPassword驗證身分），跟上面表單裡「要設定給target帳號的新密碼」（password欄位）
// 是兩個不同的值，即使操作者正在幫自己重設密碼、新舊密碼欄位容易混淆，也不會互相覆蓋。
// 2026-08-21改成adminRunAction()包住整個流程（含確認對話框），按鈕從函式一開始被呼叫
// 就立刻鎖定；busyText改傳null，「設定中…」延後到確認之後才手動設定。
async function submitResetPassword(btnEl) {
  if (resetPasswordTargetId == null) return;
  const password = document.getElementById('reset-password-input').value;
  const errEl = document.getElementById('reset-password-error');
  errEl.textContent = '';
  if (!password) { errEl.textContent = '請輸入新密碼'; return; }
  const originalLabel = btnEl.textContent;
  await adminRunAction(btnEl, null, async () => {
    const { confirmed, password: currentPassword } = await adminConfirmDialog({
      title: '確認設定新密碼',
      message: '確定要設定新密碼嗎？這個帳號目前所有登入中的Session會立即失效。',
      danger: true,
      confirmLabel: '確認設定',
      requirePassword: true
    });
    if (!confirmed) return;
    btnEl.textContent = '設定中…';
    try {
      const resp = await adminFetch(`/api/admin/users/${encodeURIComponent(resetPasswordTargetId)}/password`, {
        method: 'POST', body: JSON.stringify({ password, currentPassword })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok) { errEl.textContent = (data && data.error) || '設定失敗'; btnEl.textContent = originalLabel; return; }
      closeResetPasswordModal();
      showAdminToast('新密碼已設定');
      loadAdminUsers();
    } catch (e) {
      errEl.textContent = '設定失敗：' + e.message;
      btnEl.textContent = originalLabel;
    }
  });
}
