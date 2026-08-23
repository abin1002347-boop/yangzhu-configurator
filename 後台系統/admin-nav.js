// 楊竹科技後台系統 — 共用側邊導覽列 + 頂部工具列（三個後台頁面共用，改一次全部更新）
const ADMIN_NAV_COLLAPSE_KEY = 'yz_admin_nav_collapsed';

const ADMIN_NAV_GROUPS = [
  {
    label: '營運管理',
    items: [
      { key: 'overview',   label: '總覽',     href: '/admin/dashboard' },
      { key: 'orders',     label: '訂單管理', href: '/admin' },
      { key: 'products',   label: '商品管理', href: '/admin/products' },
      { key: 'customers',  label: '客戶管理', href: '/admin/customers' },
      { key: 'analytics',  label: '網站分析', href: '/admin/analytics', roles: ['owner', 'manager'] }
    ]
  },
  {
    label: '更多功能',
    items: [
      { key: 'site',      label: '網站內容設定', href: '/admin/site-settings', roles: ['owner', 'manager'] },
      { key: 'ai',        label: 'AI 功能設定',   href: '/admin/ai-settings', roles: ['owner', 'manager'] },
      { key: 'ai-usage',  label: 'AI 使用統計',   href: '/admin/ai-usage', roles: ['owner', 'manager'] },
      { key: 'settings',  label: '系統設定',     href: '/admin/system-settings', roles: ['owner'] }
    ]
  },
  {
    // 帳號管理／操作紀錄（正式管理員帳號、角色權限、登入限制與操作稽核批次）：導覽列只依
    // 目前角色決定要不要「顯示」這兩個入口，畫面隱藏只是改善體驗，後端 /api/admin/users、
    // /api/admin/audit-log 仍然各自獨立驗證角色（見 admin-rbac.js），不能只靠前端隱藏把關。
    label: '系統管理',
    items: [
      { key: 'users', label: '帳號管理', href: '/admin/users', roles: ['owner'] },
      { key: 'audit', label: '操作紀錄', href: '/admin/audit', roles: ['owner', 'manager'] },
      { key: 'db-backup', label: '資料庫備份', href: '/admin/db-backup', roles: ['owner'] },
      { key: 'notifications', label: '通知中心', href: '/admin/notifications' },
      { key: 'notification-settings', label: '通知設定', href: '/admin/notification-settings', roles: ['owner', 'manager'] }
    ]
  }
];

// 依目前登入者的角色（adminCurrentUser.role，來自 後台系統/admin-common.js 的
// checkAdminSession()／adminLogin()）過濾掉這個角色看不到的導覽項目；items 沒有指定
// roles 代表「四個角色都能看」。
function visibleAdminNavItems(items) {
  const role = (typeof adminCurrentUser !== 'undefined' && adminCurrentUser) ? adminCurrentUser.role : null;
  return items.filter(i => !i.roles || (role && i.roles.includes(role)));
}

const ADMIN_ROLE_LABELS = { owner: '擁有者', manager: '管理者', staff: '一般員工', viewer: '唯讀' };

// 2026-08-14 Codex獨立複驗指出：每個頁面載入時是先呼叫 renderAdminNav()／renderAdminTopbar()
// 再呼叫 initAdminPage()（見各頁面底部的內嵌script），但 adminCurrentUser 要等
// initAdminPage() 內部的 checkAdminSession() 非同步查詢 /api/admin/session 完成後才會有值——
// 第一次呼叫 renderAdminNav()／renderAdminTopbar() 時 adminCurrentUser 一定還是 null，導致
// 畫面上使用者名稱／角色顯示空白，且所有標了 roles 限制的選單項目（因為 role 是 null）
// 全部被判定為「看不到」而消失，就算目前登入者是owner也一樣。修正方式：記住最近一次
// renderAdminNav() 的 activeKey，讓 後台系統/admin-common.js 的 checkAdminSession()／
// adminLogin() 在拿到使用者資料後可以呼叫 refreshAdminNavForCurrentUser() 用同一個 activeKey
// 重新渲染一次，不需要每個頁面各自調整呼叫順序。
let _adminNavLastRenderedKey = null;
function refreshAdminNavForCurrentUser() {
  if (_adminNavLastRenderedKey !== null) renderAdminNav(_adminNavLastRenderedKey);
  if (document.getElementById('admin-topbar')) renderAdminTopbar();
}

function renderAdminNav(activeKey) {
  _adminNavLastRenderedKey = activeKey;
  const el = document.getElementById('admin-nav');
  if (!el) return;

  const visibleGroups = ADMIN_NAV_GROUPS
    .map(g => ({ ...g, items: visibleAdminNavItems(g.items) }))
    .filter(g => g.items.length > 0);

  el.innerHTML = `
    <div class="admin-shell-brand">
      <div class="admin-brand-text">
        <svg class="admin-brand-logo" viewBox="0 0 178 48" width="110" height="30" aria-label="楊竹科技">
          <text x="1" y="45" font-family="Georgia,'Palatino Linotype',serif" font-size="32" font-style="italic" font-weight="700" fill="#4d7c14">YangZhu</text>
        </svg>
        <div class="admin-shell-sub">後台系統</div>
      </div>
      <button class="admin-nav-collapse-btn" onclick="toggleAdminNavCollapse()" title="收合／展開選單">«</button>
    </div>
    <nav class="admin-sidenav">
      ${visibleGroups.map(g => `
        <div class="admin-nav-group">
          <div class="admin-nav-group-label">${g.label}</div>
          ${g.items.map(i => `
            <a href="${i.href}" class="admin-nav-link ${i.key === activeKey ? 'active' : ''}" title="${i.label}">
              <span class="admin-nav-text">${i.label}</span>
              ${i.dev ? '<span class="admin-dev-tag">開發中</span>' : ''}
            </a>
          `).join('')}
        </div>
      `).join('')}
    </nav>
    <button class="admin-nav-logout" onclick="adminLogout();">
      <span class="admin-nav-text">登出</span>
    </button>
  `;

  if (localStorage.getItem(ADMIN_NAV_COLLAPSE_KEY) === '1') {
    el.classList.add('collapsed');
  }
}

function toggleAdminNavCollapse() {
  const el = document.getElementById('admin-nav');
  if (!el) return;
  const collapsed = el.classList.toggle('collapsed');
  localStorage.setItem(ADMIN_NAV_COLLAPSE_KEY, collapsed ? '1' : '0');
}

// ─── 頂部工具列（搜尋／通知／使用者頭像）──────────────────────
// 通知改接統一通知系統（新詢價／低庫存／客戶接受或拒絕報價／備份還原失敗等，見
// notification-service.js／後端 /api/admin/notifications 系列 API），低庫存通知本身也會
// 同步餵一筆事件進來（見 low-stock-notify.js），這裡不用再另外接舊的
// /api/admin/low-stock-notifications 系列 API。搜尋功能仍是外觀佔位、非必要不接真實邏輯。
function renderAdminTopbar() {
  const el = document.getElementById('admin-topbar');
  if (!el) return;

  // 右上角顯示目前管理員名稱及角色（正式管理員帳號、角色權限、登入限制與操作稽核批次）：
  // adminCurrentUser 由 後台系統/admin-common.js 的 checkAdminSession()／adminLogin() 寫入，
  // 這裡只顯示 displayName／role 這兩個非敏感欄位，不顯示帳號或任何內部安全資訊。
  const user = (typeof adminCurrentUser !== 'undefined' && adminCurrentUser) ? adminCurrentUser : null;
  const roleLabel = user ? (ADMIN_ROLE_LABELS[user.role] || user.role) : '';
  const displayName = user ? user.displayName : '';
  const avatarChar = displayName ? displayName.trim().charAt(0) : '竹';

  el.innerHTML = `
    <div class="admin-search-wrap">
      <input type="text" class="admin-search-input" id="admin-quick-search-input" placeholder="快速搜尋訂單／商品" autocomplete="off" maxlength="100"
        role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-controls="admin-quick-search-results" aria-autocomplete="list" aria-label="快速搜尋訂單或商品">
      <div class="admin-quick-search-results hidden" id="admin-quick-search-results" role="listbox" aria-label="搜尋結果"></div>
    </div>
    <div class="admin-topbar-right">
      <div class="admin-notif-wrap">
        <button class="admin-icon-btn" id="admin-notif-btn" onclick="toggleAdminNotif(event)" title="通知中心">通知</button>
        <div id="admin-notif-popover" class="admin-notif-popover hidden">載入中…</div>
      </div>
      <div class="admin-current-user" title="${escAdminHtml(displayName)}（${escAdminHtml(roleLabel)}）">
        <div class="admin-avatar">${escAdminHtml(avatarChar)}</div>
        <div class="admin-current-user-text">
          <div class="admin-current-user-name">${escAdminHtml(displayName)}</div>
          <div class="admin-current-user-role">${escAdminHtml(roleLabel)}</div>
        </div>
      </div>
    </div>
  `;

  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.admin-notif-wrap');
    const popover = document.getElementById('admin-notif-popover');
    if (wrap && popover && !wrap.contains(e.target)) popover.classList.add('hidden');
  });

  refreshAdminNotifBadge();
  initAdminQuickSearch();
}

// ─── 後台快速搜尋（頂部搜尋框，正式功能）──────────────────────────────
// 搜尋範圍只有訂單與商品（見admin-routes.js的GET /api/admin/quick-search）。300ms debounce
// 避免每個字都送出請求；每次新搜尋開始前用AbortController取消尚未完成的舊請求並直接捨棄
// 它的結果，避免使用者連續輸入時，較慢的舊請求晚回來反而覆蓋掉較新一次輸入的正確結果。
// 這個函式跟著renderAdminTopbar()的el.innerHTML一起重新執行也沒問題：每次都是全新的DOM
// 節點＋全新綁定的事件監聽器，不會有事件重複綁定的問題（舊節點連同舊監聽器一起被丟棄）。
const QUICK_SEARCH_DEBOUNCE_MS = 300;
const QUICK_SEARCH_MIN_LEN = 2; // 上限100字改用input的maxlength="100"屬性直接限制輸入，不需要另外用JS判斷
let _qsDebounceTimer = null;
let _qsAbortController = null;
let _qsActiveIndex = -1; // 鍵盤上下鍵目前選取的結果索引；-1＝未選取任何一筆
let _qsFlatResults = []; // 「訂單＋商品」攤平後的清單，供上下鍵／Enter依索引存取

function initAdminQuickSearch() {
  const input = document.getElementById('admin-quick-search-input');
  const panel = document.getElementById('admin-quick-search-results');
  if (!input || !panel) return;

  input.addEventListener('input', () => {
    clearTimeout(_qsDebounceTimer);
    // 2026-08-22 Codex獨立驗收阻擋1／2：每次新輸入都立即重設選取狀態（不等debounce結束），
    // 並立即中止尚未完成的舊請求（不等下一次debounce才在runQuickSearch()裡中止）——避免
    // 使用者連續輸入時，舊請求晚回來造成畫面短暫顯示成新關鍵字的結果，也避免aria-activedescendant
    // 停留在「改搜其他關鍵字後已經不存在對應aria-selected項目」的舊節點上。
    resetQuickSearchSelection();
    if (_qsAbortController) { _qsAbortController.abort(); _qsAbortController = null; }
    const raw = input.value.trim();
    if (raw.length < QUICK_SEARCH_MIN_LEN) {
      closeQuickSearchResults();
      return;
    }
    _qsDebounceTimer = setTimeout(() => runQuickSearch(raw), QUICK_SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeQuickSearchResults(); return; }
    if (panel.classList.contains('hidden') || !_qsFlatResults.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); moveQuickSearchActive(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); moveQuickSearchActive(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      const target = _qsFlatResults[_qsActiveIndex >= 0 ? _qsActiveIndex : 0];
      if (target) openQuickSearchResult(target);
    }
  });

  // 用composedPath()而不是wrap.contains(e.target)：像「重新嘗試」這種按鈕，點擊時會在自己的
  // click監聽器裡把自己從DOM移除（重新渲染面板），輪到這個document層級的監聽器執行時
  // e.target已經不在wrap底下了，wrap.contains()會誤判成「點在外面」而錯誤關閉／中止剛觸發的
  // 重試請求。composedPath()記錄的是事件「派送當下」的完整路徑，不受後續DOM異動影響，才能
  // 正確判斷這次點擊原本是不是發生在搜尋框範圍內。
  document.addEventListener('click', (e) => {
    const wrap = document.querySelector('.admin-search-wrap');
    if (wrap && !e.composedPath().includes(wrap)) closeQuickSearchResults();
  });
}

// 共用的搜尋選取狀態重設函式（2026-08-22 Codex獨立驗收阻擋1修正）：新輸入、載入中、搜尋
// 失敗、空結果、重新渲染結果，以及整個關閉搜尋，都必須呼叫這裡，確保不會有「輸入框的
// aria-activedescendant指向一個實際上已經沒有aria-selected=true的舊項目」這種不一致狀態
// ——只清掉目前記錄的那一個active項目（moveQuickSearchActive()本身保證同一時間最多只有
// 一筆aria-selected=true，不需要整批掃描DOM）。
function resetQuickSearchSelection() {
  if (_qsActiveIndex >= 0 && _qsFlatResults[_qsActiveIndex]) {
    const prevEl = _qsFlatResults[_qsActiveIndex].el;
    prevEl.classList.remove('active');
    prevEl.setAttribute('aria-selected', 'false');
  }
  _qsActiveIndex = -1;
  _qsFlatResults = [];
  const input = document.getElementById('admin-quick-search-input');
  if (input) input.removeAttribute('aria-activedescendant');
}

function closeQuickSearchResults() {
  const panel = document.getElementById('admin-quick-search-results');
  const input = document.getElementById('admin-quick-search-input');
  resetQuickSearchSelection();
  if (panel) { panel.textContent = ''; panel.classList.add('hidden'); }
  if (input) input.setAttribute('aria-expanded', 'false');
  if (_qsAbortController) { _qsAbortController.abort(); _qsAbortController = null; }
}

async function runQuickSearch(q) {
  const panel = document.getElementById('admin-quick-search-results');
  if (!panel) return;

  if (_qsAbortController) _qsAbortController.abort();
  const controller = new AbortController();
  _qsAbortController = controller;

  renderQuickSearchState('搜尋中…');

  let data = null;
  let failed = false;
  try {
    const resp = await adminFetch('/api/admin/quick-search?q=' + encodeURIComponent(q), { signal: controller.signal });
    data = await resp.json().catch(() => null);
    if (!resp.ok || !data) failed = true;
  } catch (e) {
    if (controller.signal.aborted || e.name === 'AbortError') return; // 已被更新的搜尋取代，這筆結果直接捨棄
    failed = true;
  }
  if (_qsAbortController !== controller) return; // 保險：確認仍是最新這一筆才渲染，避免舊結果覆蓋新結果

  if (failed) {
    renderQuickSearchError(q);
    return;
  }
  renderQuickSearchResults(data.orders || [], data.products || []);
}

function renderQuickSearchState(text) {
  const panel = document.getElementById('admin-quick-search-results');
  const input = document.getElementById('admin-quick-search-input');
  resetQuickSearchSelection();
  panel.textContent = '';
  const div = document.createElement('div');
  div.className = 'admin-qs-state';
  div.textContent = text;
  panel.appendChild(div);
  panel.classList.remove('hidden');
  if (input) input.setAttribute('aria-expanded', 'true');
}

function renderQuickSearchError(q) {
  const panel = document.getElementById('admin-quick-search-results');
  resetQuickSearchSelection();
  panel.textContent = '';
  const div = document.createElement('div');
  div.className = 'admin-qs-state admin-qs-error';
  div.textContent = '搜尋失敗，請稍後再試';
  const retryBtn = document.createElement('button');
  retryBtn.type = 'button';
  retryBtn.className = 'btn btn-secondary btn-sm';
  retryBtn.textContent = '重新嘗試';
  retryBtn.addEventListener('click', () => runQuickSearch(q));
  panel.appendChild(div);
  panel.appendChild(retryBtn);
  panel.classList.remove('hidden');
}

function renderQuickSearchResults(orders, products) {
  const panel = document.getElementById('admin-quick-search-results');
  const input = document.getElementById('admin-quick-search-input');
  resetQuickSearchSelection();
  panel.textContent = '';

  if (!orders.length && !products.length) {
    const empty = document.createElement('div');
    empty.className = 'admin-qs-state';
    empty.textContent = '查無符合的訂單或商品';
    panel.appendChild(empty);
    panel.classList.remove('hidden');
    if (input) input.setAttribute('aria-expanded', 'true');
    return;
  }

  function buildSection(titleText, items, kind) {
    if (!items.length) return;
    const section = document.createElement('div');
    section.className = 'admin-qs-section';
    const heading = document.createElement('div');
    heading.className = 'admin-qs-section-title';
    heading.textContent = titleText;
    section.appendChild(heading);
    items.forEach(item => {
      const idx = _qsFlatResults.length;
      const row = document.createElement('div');
      row.className = 'admin-qs-item';
      row.id = 'admin-qs-item-' + idx;
      row.setAttribute('role', 'option');
      row.setAttribute('tabindex', '-1');
      row.setAttribute('aria-selected', 'false');

      const main = document.createElement('div');
      main.className = 'admin-qs-item-main';
      main.textContent = kind === 'order' ? (item.customerName || item.orderId) : item.name;
      const sub = document.createElement('div');
      sub.className = 'admin-qs-item-sub';
      sub.textContent = kind === 'order'
        ? (item.orderId + '｜' + (item.productName || '') + '｜' + (item.statusLabel || ''))
        : (item.id + '｜' + (item.statusLabel || ''));

      row.appendChild(main);
      row.appendChild(sub);
      const entry = { kind, data: item, el: row };
      row.addEventListener('click', () => openQuickSearchResult(entry));
      section.appendChild(row);
      _qsFlatResults.push(entry);
    });
    panel.appendChild(section);
  }

  buildSection('訂單', orders, 'order');
  buildSection('商品', products, 'product');

  panel.classList.remove('hidden');
  if (input) input.setAttribute('aria-expanded', 'true');
}

function moveQuickSearchActive(delta) {
  if (!_qsFlatResults.length) return;
  _qsActiveIndex = (_qsActiveIndex + delta + _qsFlatResults.length) % _qsFlatResults.length;
  const input = document.getElementById('admin-quick-search-input');
  _qsFlatResults.forEach((r, i) => {
    const isActive = i === _qsActiveIndex;
    r.el.classList.toggle('active', isActive);
    r.el.setAttribute('aria-selected', isActive ? 'true' : 'false');
    if (isActive) {
      r.el.scrollIntoView({ block: 'nearest' });
      if (input) input.setAttribute('aria-activedescendant', r.el.id);
    }
  });
}

// 點擊訂單結果：沿用既有 /admin?order=訂單編號 深連結（訂單管理頁既有的maybeOpenOrderFromQuery()
// 會自動開啟該筆訂單詳情，見admin.html）。點擊商品結果：前往商品管理頁並帶?product=商品編號，
// 由products-page.js的onAdminReady()最小幅度補上讀取這個參數、呼叫既有openProductForm()定位。
// 兩者都用整頁導覽（location.href）而不是局部路由，因為頂部搜尋是所有後台頁面共用元件，
// 這樣無論目前在哪一頁點擊搜尋結果都能正確運作，不需要為「目前頁面剛好就是目的頁」另外
// 寫一套局部更新邏輯。
function openQuickSearchResult(entry) {
  const { kind, data } = entry;
  closeQuickSearchResults();
  const input = document.getElementById('admin-quick-search-input');
  if (input) input.value = '';
  if (kind === 'order') {
    location.href = '/admin?order=' + encodeURIComponent(data.orderId);
  } else {
    location.href = '/admin/products?product=' + encodeURIComponent(data.id);
  }
}

function toggleAdminNotif(e) {
  if (e) e.stopPropagation();
  const popover = document.getElementById('admin-notif-popover');
  if (!popover) return;
  const wasHidden = popover.classList.contains('hidden');
  popover.classList.toggle('hidden');
  if (wasHidden) loadAdminNotifList();
}

// ─── 統一通知系統：未讀數量徽章 ─────────────────────────────
// 只查一支輕量的COUNT查詢（見notification-service.js的countUnreadAdminNotifications()），
// 不會因為輪詢造成大量資料庫查詢；輪詢間隔刻意設在60秒，不追求即時、只求不會漏掉太久。
let adminNotifUnreadCount = 0;
let _adminNotifPollTimer = null;

async function refreshAdminNotifBadge() {
  try {
    const resp = await adminFetch('/api/admin/notifications/unread-count');
    const data = await resp.json().catch(() => null);
    if (resp.ok && data) {
      adminNotifUnreadCount = data.unreadCount || 0;
      renderAdminNotifBadge();
    }
  } catch (e) {
    // 徽章載入失敗不影響後台其他功能，使用者點擊通知圖示時仍會重新嘗試載入清單
  }
  if (!_adminNotifPollTimer) {
    _adminNotifPollTimer = setInterval(refreshAdminNotifBadge, 60000);
  }
}

function renderAdminNotifBadge() {
  const btn = document.getElementById('admin-notif-btn');
  if (!btn) return;
  const existing = btn.querySelector('.admin-notif-badge');
  if (existing) existing.remove();
  if (adminNotifUnreadCount > 0) {
    const badge = document.createElement('span');
    badge.className = 'admin-notif-badge';
    badge.textContent = adminNotifUnreadCount > 99 ? '99+' : String(adminNotifUnreadCount);
    btn.appendChild(badge);
  }
}

// ─── 統一通知系統：清單彈窗（顯示最近20筆，完整清單請到「通知中心」頁面）──────────
// 所有動態內容（標題、摘要、時間等）一律用 DOM API 建立節點＋textContent 賦值，不使用未
// 跳脫的 innerHTML，避免通知內容造成 XSS。
async function loadAdminNotifList() {
  const popover = document.getElementById('admin-notif-popover');
  if (!popover) return;
  popover.textContent = '載入中…';
  try {
    const resp = await adminFetch('/api/admin/notifications?pageSize=20');
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      popover.textContent = (data && data.error) || '載入失敗，請稍後再試';
      return;
    }
    renderAdminNotifList(Array.isArray(data.notifications) ? data.notifications : []);
  } catch (e) {
    popover.textContent = '載入失敗：' + e.message;
  }
}

function renderAdminNotifList(list) {
  const popover = document.getElementById('admin-notif-popover');
  if (!popover) return;
  popover.textContent = '';

  const header = document.createElement('div');
  header.className = 'admin-notif-header';
  const title = document.createElement('span');
  title.textContent = '通知';
  header.appendChild(title);
  if (list.some(n => !n.readAt)) {
    const markAllBtn = document.createElement('button');
    markAllBtn.type = 'button';
    markAllBtn.className = 'btn btn-secondary btn-sm';
    markAllBtn.textContent = '全部標記已讀';
    markAllBtn.addEventListener('click', (ev) => { ev.stopPropagation(); markAllAdminNotifRead(); });
    header.appendChild(markAllBtn);
  }
  popover.appendChild(header);

  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'admin-notif-empty';
    empty.textContent = '目前沒有通知';
    popover.appendChild(empty);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'admin-notif-list';
  list.forEach(n => {
    const li = document.createElement('li');
    li.className = 'admin-notif-item' + (n.readAt ? '' : ' unread');

    const nameEl = document.createElement('div');
    nameEl.className = 'admin-notif-item-name';
    nameEl.textContent = n.title;

    const detailEl = document.createElement('div');
    detailEl.className = 'admin-notif-item-detail';
    detailEl.textContent = n.summary || (n.eventTypeLabel || n.eventType);

    const timeEl = document.createElement('div');
    timeEl.className = 'admin-notif-item-time';
    timeEl.textContent = fmtAdminNotifTime(n.eventCreatedAt);

    li.appendChild(nameEl);
    li.appendChild(detailEl);
    li.appendChild(timeEl);

    if (!n.readAt) {
      li.addEventListener('click', (ev) => { ev.stopPropagation(); markAdminNotifRead(n.id, li); });
    }

    ul.appendChild(li);
  });
  popover.appendChild(ul);

  const footer = document.createElement('a');
  footer.href = '/admin/notifications';
  footer.className = 'admin-notif-footer-link';
  footer.textContent = '查看全部通知';
  popover.appendChild(footer);
}

function fmtAdminNotifTime(iso) {
  try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
  catch { return iso || '--'; }
}

async function markAdminNotifRead(id, liEl) {
  try {
    const resp = await adminFetch(`/api/admin/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
    if (resp.ok) {
      liEl.classList.remove('unread');
      adminNotifUnreadCount = Math.max(0, adminNotifUnreadCount - 1);
      renderAdminNotifBadge();
    }
  } catch (e) {
    // 靜默失敗：這筆通知會繼續顯示為未讀，使用者可以再次點擊重試
  }
}

async function markAllAdminNotifRead() {
  try {
    const resp = await adminFetch('/api/admin/notifications/read-all', { method: 'POST' });
    if (resp.ok) {
      adminNotifUnreadCount = 0;
      renderAdminNotifBadge();
      loadAdminNotifList();
    }
  } catch (e) {
    // 靜默失敗，使用者可以再次點擊「全部標記已讀」重試
  }
}
