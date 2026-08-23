// 楊竹科技後台系統 — 共用登入驗證與 API 呼叫工具
// 登入與憑證傳輸安全批次：改用伺服器端 HttpOnly Cookie Session，取代原本把管理密碼存在
// localStorage、每次呼叫API帶x-admin-token標頭的做法——瀏覽器JavaScript完全讀不到Session
// 本身（Cookie是HttpOnly），這個檔案也不會、也不需要保存密碼。CSRF Token只放在下面這個
// 模組層級的記憶體變數，重新整理頁面就會透過 GET /api/admin/session 重新取得一份新的，
// 不會被寫進 localStorage、sessionStorage 或網址。

let _adminCsrfToken = null;
// 正式管理員帳號、角色權限、登入限制與操作稽核批次：目前登入者的安全公開資料（id／
// username／displayName／role），由 adminLogin()／checkAdminSession() 從伺服器回應寫入，
// 只保存這幾個非敏感欄位，絕對不包含密碼或密碼雜湊。admin-nav.js 用這個變數顯示右上角
// 目前管理員名稱與角色、並依角色決定要不要顯示「帳號管理」「操作紀錄」選單項目。
let adminCurrentUser = null;

// 帶Cookie（credentials: 'same-origin'）＋CSRF Token呼叫後台API；401時自動清除記憶體狀態
// 並顯示登入畫面。CSRF Token只加在GET／HEAD以外的方法（跟後端csrfProtection()判斷一致）。
async function adminFetch(url, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const headers = Object.assign({}, options.headers);
  if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && _adminCsrfToken) {
    headers['X-CSRF-Token'] = _adminCsrfToken;
  }
  const resp = await fetch(url, Object.assign({}, options, { headers, credentials: 'same-origin' }));
  if (resp.status === 401) {
    _adminCsrfToken = null;
    showAdminGate();
    throw new Error('尚未登入或登入已逾期');
  }
  return resp;
}

// 確認目前伺服器端Session是否仍然有效，並取得（同時輪替）一份新的CSRF Token，順便更新
// adminCurrentUser（正式管理員帳號、角色權限、登入限制與操作稽核批次）。
async function checkAdminSession() {
  try {
    const resp = await fetch('/api/admin/session', { credentials: 'same-origin' });
    if (!resp.ok) return false;
    const data = await resp.json().catch(() => null);
    if (data && data.loggedIn) {
      _adminCsrfToken = data.csrfToken || null;
      adminCurrentUser = data.user || null;
      // 2026-08-14 Codex獨立複驗指出：頁面載入時 renderAdminNav()／renderAdminTopbar() 會在
      // adminCurrentUser 有值「之前」就先執行過一次，導致使用者名稱／角色空白、owner應有的
      // 選單項目也一併消失。這裡拿到使用者資料後主動重新渲染一次導覽列與頂部工具列
      // （見 admin-nav.js 的 refreshAdminNavForCurrentUser()），修正這個時序問題。
      if (typeof refreshAdminNavForCurrentUser === 'function') refreshAdminNavForCurrentUser();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 用帳號＋密碼登入：成功時伺服器會設定HttpOnly Cookie（這裡的JavaScript讀不到、也不需要
// 讀到），只把伺服器回傳的CSRF Token與目前使用者安全公開資料保存在記憶體變數，密碼本身
// 用完即丟、不會被保存在任何地方（正式管理員帳號、角色權限、登入限制與操作稽核批次：
// 取代原本只有單一密碼欄位的登入方式）。
async function adminLogin(username, password) {
  const resp = await fetch('/api/admin/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  const data = await resp.json().catch(() => null);
  if (resp.ok && data && data.success) {
    _adminCsrfToken = data.csrfToken || null;
    adminCurrentUser = data.user || null;
    // 同 checkAdminSession()：登入成功後主動重新渲染一次導覽列／頂部工具列，確保使用者
    // 名稱、角色與依角色顯示的選單項目正確反映剛登入的帳號（見 admin-nav.js 的
    // refreshAdminNavForCurrentUser()）。
    if (typeof refreshAdminNavForCurrentUser === 'function') refreshAdminNavForCurrentUser();
    return { ok: true };
  }
  return { ok: false, error: (data && data.error) || '登入失敗' };
}

// 登出：通知伺服器讓目前Session立即失效並清除Cookie，不論請求是否成功都會清除前端記憶體
// 狀態並重新整理頁面回到登入畫面。
async function adminLogout() {
  try {
    await fetch('/api/admin/session', { method: 'DELETE', credentials: 'same-origin' });
  } catch (e) {
    // 登出請求本身失敗也不影響前端清除狀態，避免使用者卡在「看起來已登出、實際上還留在頁面」
  }
  _adminCsrfToken = null;
  adminCurrentUser = null;
  location.reload();
}

// 顯示登入遮罩（尚未登入或Session已逾期時）。正式管理員帳號、角色權限、登入限制與操作稽核
// 批次：改成帳號＋密碼兩個欄位，各自搭配正式關聯的 <label>（用 visually-hidden 樣式不在畫面
// 上顯示文字，但螢幕報讀軟體讀得到，也讓輸入框能透過 label 正確定位，不只依賴 placeholder）。
function showAdminGate() {
  if (document.getElementById('admin-gate-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'admin-gate-overlay';
  overlay.innerHTML = `
    <div class="admin-gate-box">
      <h2>楊竹科技後台系統</h2>
      <p>請輸入管理員帳號與密碼</p>
      <label for="admin-gate-username" class="visually-hidden">管理員帳號</label>
      <input type="text" id="admin-gate-username" placeholder="管理員帳號" autocomplete="username">
      <label for="admin-gate-input" class="visually-hidden">密碼</label>
      <input type="password" id="admin-gate-input" placeholder="密碼" autocomplete="current-password">
      <button id="admin-gate-btn" class="btn btn-primary" style="width:100%;margin-top:10px;">登入</button>
      <div id="admin-gate-error"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const usernameInput = document.getElementById('admin-gate-username');
  const input   = document.getElementById('admin-gate-input');
  const btn     = document.getElementById('admin-gate-btn');
  const errEl   = document.getElementById('admin-gate-error');

  async function tryLogin() {
    const username = usernameInput.value.trim();
    const password = input.value;
    if (!username || !password) return;
    btn.disabled = true;
    errEl.textContent = '登入中…';
    const result = await adminLogin(username, password);
    input.value = ''; // 不論成功或失敗，欄位裡的密碼都不保留
    btn.disabled = false;
    if (result.ok) {
      overlay.remove();
      if (typeof onAdminReady === 'function') onAdminReady();
    } else {
      errEl.textContent = result.error || '登入失敗';
    }
  }

  btn.addEventListener('click', tryLogin);
  usernameInput.addEventListener('keydown', e => { if (e.key === 'Enter') input.focus(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryLogin(); });
  setTimeout(() => usernameInput.focus(), 50);
}

// 維護模式（正式資料庫還原安全機制）：正式還原一旦執行到關閉正式SQLite連線那一步，同一行程
// 內所有會查資料庫的端點（包含GET /api/admin/session本身）都會開始回應錯誤，不是乾淨的503——
// 這裡先查一次完全不碰資料庫、只讀記憶體旗標的 /api/admin/maintenance-status，維護模式期間
// 直接顯示明確的維護畫面，不讓使用者看到一個原因不明、重新輸入帳密也無法解決的登入失敗畫面。
async function checkGlobalMaintenanceMode() {
  try {
    const resp = await fetch('/api/admin/maintenance-status', { credentials: 'same-origin' });
    const data = await resp.json().catch(() => null);
    return !!(data && data.maintenanceMode);
  } catch (e) {
    return false;
  }
}
function showMaintenanceNotice() {
  if (document.getElementById('admin-maintenance-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'admin-maintenance-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(15,15,20,0.75);display:flex;align-items:center;justify-content:center;z-index:9999;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:10px;padding:28px 32px;max-width:420px;text-align:center;">
      <h2 style="margin:0 0 10px;">系統維護中</h2>
      <p style="font-size:13.5px;color:var(--gray-400);">後台正在進行正式資料庫還原，所有功能暫停使用，需要工程人員重新啟動伺服器才會恢復。請稍後再重新整理頁面。</p>
    </div>
  `;
  document.body.appendChild(overlay);
}

// 頁面進入點：先確認是否在維護模式，再確認登入狀態後才呼叫 onAdminReady()
async function initAdminPage() {
  if (await checkGlobalMaintenanceMode()) {
    showMaintenanceNotice();
    return;
  }
  const ok = await checkAdminSession();
  if (ok) {
    if (typeof onAdminReady === 'function') onAdminReady();
  } else {
    showAdminGate();
  }
}

function escAdminHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 通用檔案下載：把 adminFetch() 拿到的 Response 轉存成本機檔案（Excel匯出等二進位下載共用）。
// 優先採用伺服器回應標頭裡的檔名（Content-Disposition 的 filename*，支援中文），沒有的話
// 才退回呼叫端提供的預設檔名。
async function adminDownloadBlob(resp, fallbackFilename) {
  const blob = await resp.blob();
  const disposition = resp.headers.get('Content-Disposition') || '';
  const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  const plainMatch = disposition.match(/filename="([^"]+)"/i);
  const filename = utf8Match ? decodeURIComponent(utf8Match[1]) : (plainMatch ? plainMatch[1] : fallbackFilename);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function showAdminToast(msg, isError) {
  const el = document.createElement('div');
  el.className = 'admin-toast' + (isError ? ' error' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// ══════════════ 介面操作一致性共用元件（2026-08-21 批次）══════════════
// 這批之前，每個頁面的「送出中disable按鈕」「防止重複送出」「危險操作confirm()」都是各自
// 土法煉鋼、寫法不一致（見 後台筆記.md 盤點紀錄）。這裡集中補齊共用版本，新增或修正頁面時
// 一律用這幾個函式，不要再各自複製一份類似邏輯；已經運作正常、行為一致的既有頁面不強迫
// 全部改用共用版本，避免無必要的風險。

// ─── 忙碌按鈕：載入狀態＋防止重複送出 ─────────────────────────────
// 用WeakSet記錄「目前正在處理中」的按鈕，就算呼叫端忘記檢查、或極快速的第二次點擊搶在
// disabled屬性真正生效前觸發，這裡仍會直接擋下第二次呼叫（回傳undefined、不執行fn），
// 是比單純btn.disabled更保險的第二層防護。busyText是送出期間顯示的文字（例如「儲存中…」），
// 不論成功或失敗，finally都會恢復原本文字與可點擊狀態；fn的回傳值或例外原樣往外傳遞，
// 呼叫端原本的錯誤處理邏輯不需要改變。
const _adminBusyButtons = new WeakSet();
async function adminRunAction(btn, busyText, fn) {
  if (!btn || _adminBusyButtons.has(btn)) return undefined;
  _adminBusyButtons.add(btn);
  const originalText = btn.textContent;
  const originalDisabled = btn.disabled;
  btn.disabled = true;
  if (busyText) btn.textContent = busyText;
  try {
    return await fn();
  } finally {
    _adminBusyButtons.delete(btn);
    btn.disabled = originalDisabled;
    if (busyText) btn.textContent = originalText;
  }
}

// ─── 共用危險操作確認對話框（取代零散的瀏覽器原生confirm()）─────────────
// 回傳 Promise<{confirmed:boolean, password?:string}>；使用者取消（按取消／點遮罩／按Esc）
// 時confirmed為false，password一律是undefined。requirePassword／requireText是「進一步強化」
// 用，只會讓確認門檻更高，不會降低任何既有安全門檻——後端的密碼驗證、確認文字比對等邏輯
// 完全不變，這裡只統一前端的呈現方式與互動行為。
// message：一般文字，會用textContent安全顯示；如果需要列出多行明細（例如盤點差異清單）
// 這種比純文字複雜的內容，改用messageHtml——呼叫端自己要用escAdminHtml()把每一段動態內容
// 都跳脫過再組成HTML字串，這裡不會再幫忙跳脫，用法跟專案裡其他地方组innerHTML的既有慣例
// 一致。
function adminConfirmDialog({
  title, message, messageHtml, danger = false,
  confirmLabel = '確認', cancelLabel = '取消',
  requirePassword = false, requireText = null // requireText: { label, matchValue }
}) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'admin-modal-overlay admin-confirm-overlay';
    const passwordFieldHtml = requirePassword ? `
      <label class="admin-confirm-label" for="admin-confirm-password">請重新輸入目前登入密碼</label>
      <input type="password" id="admin-confirm-password" class="admin-confirm-input" autocomplete="current-password">
    ` : '';
    const textFieldHtml = requireText ? `
      <label class="admin-confirm-label" for="admin-confirm-text">${escAdminHtml(requireText.label)}</label>
      <input type="text" id="admin-confirm-text" class="admin-confirm-input" autocomplete="off">
    ` : '';
    const messageContentHtml = messageHtml != null ? messageHtml : escAdminHtml(message || '');
    overlay.innerHTML = `
      <div class="admin-modal-box admin-confirm-box" role="alertdialog" aria-modal="true" aria-labelledby="admin-confirm-title">
        <div class="admin-modal-header">
          <h3 id="admin-confirm-title">${escAdminHtml(title || '請確認')}</h3>
        </div>
        <div class="admin-modal-body">
          <div class="admin-confirm-message">${messageContentHtml}</div>
          ${passwordFieldHtml}
          ${textFieldHtml}
          <div class="admin-confirm-error" id="admin-confirm-error"></div>
          <div class="admin-confirm-actions">
            <button type="button" class="btn btn-outline" id="admin-confirm-cancel">${escAdminHtml(cancelLabel)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="admin-confirm-ok">${escAdminHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('#admin-confirm-ok');
    const cancelBtn = overlay.querySelector('#admin-confirm-cancel');
    const pwInput = overlay.querySelector('#admin-confirm-password');
    const textInput = overlay.querySelector('#admin-confirm-text');
    const errEl = overlay.querySelector('#admin-confirm-error');
    const previouslyFocused = document.activeElement;

    function cleanup() {
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') previouslyFocused.focus();
    }
    function doCancel() { cleanup(); resolve({ confirmed: false }); }
    function doConfirm() {
      if (requireText && textInput.value !== requireText.matchValue) {
        errEl.textContent = '確認文字不相符，請重新輸入';
        textInput.focus();
        return;
      }
      if (requirePassword && !pwInput.value) {
        errEl.textContent = '請輸入密碼';
        pwInput.focus();
        return;
      }
      const password = requirePassword ? pwInput.value : undefined;
      cleanup();
      resolve({ confirmed: true, password });
    }
    okBtn.addEventListener('click', doConfirm);
    cancelBtn.addEventListener('click', doCancel);
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) doCancel(); });

    // 焦點鎖定在對話框內（Tab／Shift+Tab循環），Escape取消，輸入框內按Enter視同按下確認，
    // 手機版沿用既有.admin-modal-box的響應式樣式（見admin-style.css），不需要另外處理。
    const focusablesSelector = 'button, input, [tabindex]:not([tabindex="-1"])';
    function onKeydown(e) {
      if (e.key === 'Escape') { e.preventDefault(); doCancel(); return; }
      if (e.key === 'Tab') {
        const focusables = Array.from(overlay.querySelectorAll(focusablesSelector)).filter(el => !el.disabled);
        if (!focusables.length) return;
        const first = focusables[0], last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener('keydown', onKeydown, true);
    if (pwInput) pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') doConfirm(); });
    if (textInput) textInput.addEventListener('keydown', e => { if (e.key === 'Enter') doConfirm(); });
    setTimeout(() => (pwInput || textInput || okBtn).focus(), 30);
  });
}

// ─── 共用分頁列（後端分頁／前端分頁通用）───────────────────────────
// 只負責畫「上一頁／第X/Y頁／下一頁」＋在邊界自動disable，不管資料從哪裡來；
// onChange(newPage) 由呼叫端決定要重新打API還是重新渲染已經在瀏覽器端的陣列。
function renderAdminPagination(container, { page, totalPages, onChange }) {
  if (!container) return;
  container.innerHTML = '';
  if (!totalPages || totalPages <= 1) return;
  const bar = document.createElement('div');
  bar.className = 'pagination-bar';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'btn btn-outline btn-sm';
  prevBtn.textContent = '上一頁';
  prevBtn.disabled = page <= 1;
  prevBtn.addEventListener('click', () => onChange(page - 1));
  const info = document.createElement('span');
  info.className = 'pagination-info';
  info.textContent = `第 ${page} / ${totalPages} 頁`;
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'btn btn-outline btn-sm';
  nextBtn.textContent = '下一頁';
  nextBtn.disabled = page >= totalPages;
  nextBtn.addEventListener('click', () => onChange(page + 1));
  bar.append(prevBtn, info, nextBtn);
  container.appendChild(bar);
}

// ─── 共用前端分頁（資料已經一次全部載入到瀏覽器端時使用）──────────────
function adminPaginateArray(arr, page, pageSize) {
  const list = Array.isArray(arr) ? arr : [];
  const total = list.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);
  const start = (p - 1) * pageSize;
  return { rows: list.slice(start, start + pageSize), page: p, totalPages, total };
}

// ─── 共用表頭排序（2026-08-21 Codex獨立檢測指出鍵盤與無障礙缺口後修正）────────────────
// 呼叫端在<th>上加 data-sort-key="欄位名"（例如<th data-sort-key="stockQty">），這裡統一
// 綁定排序互動、維護目前排序欄位與方向，並呼叫onSortChange(key, dir)交給呼叫端重新排序＋
// 重新渲染（陣列通常已經在瀏覽器端，不需要重打API）。state是呼叫端持有的一個
// {sortKey, sortDir}物件，讓排序狀態可以被「重新整理資料後保留」的邏輯一起保存。
//
// 無障礙設計：每個th內原本的純文字改成一個真正的<button type="button">——原生button天生
// 就能用Tab聚焦、用Enter或Space觸發click事件，不需要額外寫keydown處理去模擬（比在th或span
// 上綁click再手動處理鍵盤事件更可靠，也是瀏覽器原生語意，讀屏軟體都認得）。三角形視覺
// 指示標成aria-hidden="true"（純裝飾，不重複朗讀），實際排序方向改用button的aria-label
// 傳達完整可讀文字（例如「依商品排序，目前遞增排序中」），不只靠三角形這種純視覺線索。
// th本身同步維護aria-sort="none／ascending／descending"，符合WAI-ARIA表格排序規範，讓
// 讀屏軟體在瀏覽表格結構時也能得知目前排序狀態（不只是在按鈕上才聽得到）。
const ADMIN_SORT_DIR_ARIA = { asc: 'ascending', desc: 'descending' };
const ADMIN_SORT_DIR_TEXT = { asc: '遞增排序中', desc: '遞減排序中' };
function attachAdminSortableHeaders(theadEl, state, onSortChange) {
  if (!theadEl) return;
  const ths = Array.from(theadEl.querySelectorAll('th[data-sort-key]'));
  ths.forEach(th => {
    th.classList.add('sortable');
    const label = th.textContent.trim();
    th.textContent = '';
    th.setAttribute('aria-sort', 'none');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-sort-btn';

    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    const indicator = document.createElement('span');
    indicator.className = 'admin-sort-indicator';
    indicator.setAttribute('aria-hidden', 'true');
    btn.appendChild(indicator);

    th.appendChild(btn);

    function updateAria() {
      const isActive = state.sortKey === th.dataset.sortKey;
      const dir = isActive ? state.sortDir : null;
      th.setAttribute('aria-sort', dir ? ADMIN_SORT_DIR_ARIA[dir] : 'none');
      indicator.setAttribute('data-dir', dir || '');
      // 讀取labelSpan目前的文字（不是綁定當下擷取到的固定值）——呼叫端如果之後動態改了
      // labelSpan.textContent（例如products-page.js依頁籤把「排序」換成「封存時間」），
      // 這裡的aria-label會自動反映最新文字，不會停留在綁定當下的舊標籤。
      btn.setAttribute('aria-label', `依${labelSpan.textContent}排序${dir ? '，' + ADMIN_SORT_DIR_TEXT[dir] : ''}`);
    }
    updateAria();
    th._adminSortUpdateAria = updateAria;

    btn.addEventListener('click', () => {
      const key = th.dataset.sortKey;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.sortKey = key;
        state.sortDir = 'asc';
      }
      ths.forEach(h => { if (h._adminSortUpdateAria) h._adminSortUpdateAria(); });
      onSortChange(state.sortKey, state.sortDir);
    });
  });
}
// null/undefined一律排在最後（不論asc/desc），避免舊資料缺欄位時排序結果忽前忽後造成混淆；
// 數字用數值比較，其餘一律轉字串用中文語系比較（本站排序欄位目前只有數字或日期字串兩種）。
function adminCompareForSort(a, b, dir) {
  const aMissing = a === null || a === undefined;
  const bMissing = b === null || b === undefined;
  let result;
  if (aMissing && bMissing) result = 0;
  else if (aMissing) return 1;
  else if (bMissing) return -1;
  else if (typeof a === 'number' && typeof b === 'number') result = a - b;
  else result = String(a).localeCompare(String(b), 'zh-Hant');
  return dir === 'desc' ? -result : result;
}
