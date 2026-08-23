// 楊竹科技後台系統 — 產品管理頁面邏輯
let allProducts = [];
let editingProductId = null;
let formState = null; // { materials:[], finishes:[], capacities:[]|null, qtyBreaks:[] }
let isSaving = false;
let formDirty = false;
let firstErrorEl = null;
let labelAreaOriginalSnapshot = null; // 開啟表單當下的 labelArea，供「重設」按鈕還原用
const pendingStatusIds = new Set(); // 正在送出狀態切換請求的商品 id，避免同一列重複點擊
let productFilter = 'current'; // 'current'（目前商品，預設）｜'archived'（已封存）
const pendingArchiveIds = new Set(); // 正在送出封存／還原請求的商品 id，避免同一列重複點擊

// 商品清單原本一次全部撈出、沒有分頁，商品數量成長後會需要分頁——這裡在瀏覽器端對已經
// 載入的allProducts分頁＋排序，不改動後端API（後端本來就是一次回傳全部）。
const PRODUCTS_PAGE_SIZE = 20;
const productsPageState = { page: 1 };
const productsSortState = { sortKey: null, sortDir: 'asc' };

// ─── 商品操作歷程 ─────────────────────────
let auditLogPage = 1;
const AUDIT_LOG_PAGE_SIZE = 20;

const AUDIT_ACTION_LABELS = { create: '新增', update: '編輯', status_change: '狀態切換', archive: '封存', restore: '還原' };
const AUDIT_FIELD_LABELS = {
  name: '名稱', nameEn: '英文名稱', icon: '圖示', image: '商品圖片', badge: '徽章文字', badgeColor: '徽章顏色',
  description: '說明', size: '尺寸', displaySize: '顯示尺寸文字', bgImage: '底圖', labelArea: '可印刷範圍',
  textLayout: '文字排版', materials: '材質', finishes: '工藝', capacities: '容量', qtyBreaks: '數量折扣',
  minQty: '最少訂購量', leadDays: '交期天數', color: '主題色', textOnly: '純文字商品', status: '狀態',
  sortOrder: '排序', priceOnInquiry: '價格洽詢', materialLabel: '材質欄位標題', finishLabel: '工藝欄位標題',
  svgViewBox: 'SVG viewBox', svgPath: 'SVG 路徑', archivedAt: '封存時間'
};

// 與 admin-routes.js 的 validateProductBody() 對齊的前端驗證規則（後端仍是最終驗證層，
// 這裡只是提前擋下明顯錯誤、給清楚提示，減少來回請求；後端規則若調整，這裡也要同步更新）。
const PRODUCT_ID_RE_CLIENT = /^[a-z0-9_]{2,40}$/;
const OPTION_ID_RE_CLIENT = /^[a-z0-9_]{1,40}$/;

const DYN_FIELDS = {
  materials:  [{ key: 'id', placeholder: '代碼 如 pvc' }, { key: 'name', placeholder: '名稱 如 PVC標準卡' }, { key: 'priceBase', placeholder: '基本單價', type: 'number' }],
  finishes:   [{ key: 'id', placeholder: '代碼' }, { key: 'name', placeholder: '名稱' }, { key: 'price', placeholder: '加價', type: 'number' }],
  capacities: [{ key: 'id', placeholder: '代碼' }, { key: 'name', placeholder: '名稱' }, { key: 'price', placeholder: '加價', type: 'number' }],
  qtyBreaks:  [{ key: 'min', placeholder: '最小數量', type: 'number' }, { key: 'max', placeholder: '最大數量', type: 'number' }, { key: 'price', placeholder: '單價調整(可負)', type: 'number' }]
};
// 每個動態欄位區塊固定顯示的欄位標題（跟DYN_FIELDS同一組key、同一個順序），用來在
// renderDynSection()裡渲染一列不會消失的標題列，跟只在欄位空白時才看得到的placeholder
// 分開，使用者一進來就知道每一欄要填什麼，不用等到有資料或聚焦欄位才看得出來。
const DYN_FIELD_HEADERS = {
  materials:  ['代碼', '名稱', '基本單價'],
  finishes:   ['代碼', '名稱', '加價'],
  capacities: ['代碼', '名稱', '加價'],
  qtyBreaks:  ['最小數量', '最大數量', '單價調整（可負數）']
};

async function onAdminReady() {
  attachAdminSortableHeaders(document.getElementById('product-table-head'), productsSortState, () => { productsPageState.page = 1; renderProductTable(); });
  await loadProducts();
  maybeOpenProductFromQuery();
}

// 深連結支援（最小範圍補上，供頂部快速搜尋點擊商品結果使用）：網址帶 ?product=商品編號 時，
// 等商品清單載入完成後自動開啟該筆商品既有的編輯表單（沿用既有openProductForm()，本身就會
// scrollIntoView定位）。找不到（例如商品編號打錯、剛好被封存）就靜默放棄，不跳錯誤訊息，
// 比照admin.html既有maybeOpenOrderFromQuery()深連結一樣的容錯方式。
function maybeOpenProductFromQuery() {
  const targetId = new URLSearchParams(location.search).get('product');
  if (!targetId) return;
  if (allProducts.some(p => p.id === targetId)) {
    openProductForm(targetId);
  }
}

// 2026-08-21盤點指出這裡原本完全沒有loading/錯誤狀態——失敗時只console.error，畫面會卡在
// 靜態HTML寫死的「載入中…」文字，使用者看不出是網路問題還是資料真的是空的。改成明確的
// 三態：載入中／錯誤（附重新嘗試按鈕）／實際內容，跟其他頁面（audit／customers／users等）
// 一致；沒有新增獨立的loading/error容器元素，直接沿用tbody本身顯示這三種狀態，是這個頁面
// 既有結構最小幅度的修改方式。
async function loadProducts() {
  const tbody = document.getElementById('product-table-body');
  tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:30px;">載入中…</td></tr>`;
  try {
    const qs = productFilter === 'archived' ? '?archived=1' : '';
    const resp = await adminFetch('/api/admin/products' + qs);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#dc2626;padding:30px;">${escAdminHtml((data && data.error) || '讀取失敗')}　<button type="button" class="btn btn-secondary btn-sm" onclick="loadProducts()">重新嘗試</button></td></tr>`;
      return;
    }
    allProducts = Array.isArray(data.products) ? data.products : [];
    productsPageState.page = 1;
    renderProductTable();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:#dc2626;padding:30px;">讀取失敗：${escAdminHtml(e.message)}　<button type="button" class="btn btn-secondary btn-sm" onclick="loadProducts()">重新嘗試</button></td></tr>`;
  }
}

function statusLabel(s) {
  return { active: '上架中', inactive: '已下架', coming_soon: '即將推出' }[s] || s;
}

function formatArchivedAt(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', { hour12: false });
}

// 匯出目前畫面上這份商品清單（目前商品／已封存，依 productFilter 頁籤而定）為Excel。
// 這個頁面本來就是一次載入全部資料再用 JS 渲染（沒有分頁），所以匯出內容 = allProducts，
// 一定跟畫面上的表格一致。isExportingProducts旗標防止連續重複點擊。
let isExportingProducts = false;
async function exportProductsXlsx() {
  if (isExportingProducts) return;
  if (!allProducts.length) {
    alert('目前沒有可以匯出的商品');
    return;
  }
  const btn = document.getElementById('btn-export-products-xlsx');
  const originalText = btn.textContent;
  isExportingProducts = true;
  btn.disabled = true;
  btn.textContent = '匯出中…';
  try {
    const isArchivedView = productFilter === 'archived';
    const rows = allProducts.map(p => ({
      id: p.id || '',
      name: p.name || '',
      status: isArchivedView ? '已封存' : statusLabel(p.status),
      materialCount: (p.materials || []).length,
      finishCount: (p.finishes || []).length,
      minQty: p.minQty ?? '',
      leadDays: p.leadDays ?? '',
      sortInfo: isArchivedView ? formatArchivedAt(p.archivedAt) : `排序 ${p.sortOrder ?? ''}`
    }));
    const resp = await adminFetch('/api/admin/products/export', { method: 'POST', body: JSON.stringify({ rows }) });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      throw new Error((data && data.error) || '匯出失敗，請稍後再試');
    }
    await adminDownloadBlob(resp, `楊竹商品_${new Date().toISOString().slice(0,10)}.xlsx`);
  } catch (e) {
    alert(e.message || '匯出失敗，請稍後再試');
  } finally {
    isExportingProducts = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ─── 目前商品／已封存 篩選頁籤 ──────────────
document.getElementById('product-filter-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.admin-tab');
  if (!btn) return;
  const filter = btn.dataset.filter;
  if (filter === productFilter) return;
  productFilter = filter;
  document.querySelectorAll('#product-filter-tabs .admin-tab').forEach(t => t.classList.toggle('active', t.dataset.filter === filter));
  document.getElementById('btn-new-product').style.display = filter === 'archived' ? 'none' : '';
  const sortHeadCell = document.querySelector('#product-table-head th:nth-child(6)');
  if (sortHeadCell) {
    // 不能直接改sortHeadCell.textContent——attachAdminSortableHeaders()已經把th內容換成
    // 一個真正的<button>（含可聚焦、aria-label等無障礙屬性），改textContent會把整個button
    // 節點連同事件監聽器一起清掉。改成只更新button內文字span與dataset.sortKey，並呼叫
    // th._adminSortUpdateAria()同步aria-sort／aria-label，保持無障礙狀態正確。
    const labelSpan = sortHeadCell.querySelector('.admin-sort-btn span');
    const newLabel = filter === 'archived' ? '封存時間' : '排序';
    if (labelSpan) labelSpan.textContent = newLabel;
    sortHeadCell.dataset.sortKey = filter === 'archived' ? 'archivedAt' : 'sortOrder';
    if (typeof sortHeadCell._adminSortUpdateAria === 'function') sortHeadCell._adminSortUpdateAria();
  }
  productsSortState.sortKey = null; // 篩選條件（頁籤）改變時清掉排序狀態，避免用舊頁籤的排序欄位排新資料
  productsPageState.page = 1; // 篩選條件改變時回到第1頁
  loadProducts();
});

// materials／finishes／sortOrder在渲染前一律先算成安全值再使用——舊資料或欄位異常時
// p.materials.length這種直接存取會丟例外中斷整張表格渲染，2026-08-21盤點時發現這裡沒有
// 跟同專案其他表格一樣做防禦，這裡補齊。
function safeProductArrayLen(v) { return Array.isArray(v) ? v.length : 0; }
function renderProductTable() {
  const tbody = document.getElementById('product-table-body');
  const isArchivedView = productFilter === 'archived';

  if (!allProducts.length) {
    const emptyMsg = isArchivedView ? '目前沒有已封存的商品' : '還沒有任何產品，點右上角「新增產品」開始';
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:30px;">${emptyMsg}</td></tr>`;
    renderAdminPagination(document.getElementById('product-table-pagination'), { page: 1, totalPages: 1, onChange: () => {} });
    return;
  }

  const sortKey = productsSortState.sortKey;
  const sorted = sortKey
    ? allProducts.slice().sort((a, b) => {
        const av = sortKey === 'materialCount' ? safeProductArrayLen(a.materials)
          : sortKey === 'finishCount' ? safeProductArrayLen(a.finishes)
          : a[sortKey];
        const bv = sortKey === 'materialCount' ? safeProductArrayLen(b.materials)
          : sortKey === 'finishCount' ? safeProductArrayLen(b.finishes)
          : b[sortKey];
        return adminCompareForSort(av, bv, productsSortState.sortDir);
      })
    : allProducts;
  const { rows, page, totalPages } = adminPaginateArray(sorted, productsPageState.page, PRODUCTS_PAGE_SIZE);
  productsPageState.page = page;

  if (isArchivedView) {
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td><code>${escAdminHtml(p.id)}</code></td>
        <td>${escAdminHtml(p.name)}</td>
        <td><span class="status-pill archived">已封存</span></td>
        <td>${safeProductArrayLen(p.materials)}</td>
        <td>${safeProductArrayLen(p.finishes)}</td>
        <td>${escAdminHtml(formatArchivedAt(p.archivedAt))}</td>
        <td style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-secondary btn-sm" data-action="restore-product" data-id="${escAdminHtml(p.id)}" ${pendingArchiveIds.has(p.id) ? 'disabled' : ''}>還原</button>
        </td>
      </tr>
    `).join('');
  } else {
    tbody.innerHTML = rows.map(p => `
      <tr>
        <td><code>${escAdminHtml(p.id)}</code></td>
        <td>${escAdminHtml(p.name)}</td>
        <td><span class="status-pill ${escAdminHtml(p.status)}">${statusLabel(p.status)}</span></td>
        <td>${safeProductArrayLen(p.materials)}</td>
        <td>${safeProductArrayLen(p.finishes)}</td>
        <td>${p.sortOrder ?? ''}</td>
        <td style="display:flex;gap:8px;align-items:center;">
          <button class="btn btn-secondary btn-sm" data-action="edit-product" data-id="${escAdminHtml(p.id)}">編輯</button>
          <select class="status-select" data-action="status-select" data-id="${escAdminHtml(p.id)}" ${pendingStatusIds.has(p.id) ? 'disabled' : ''}>
            <option value="active" ${p.status === 'active' ? 'selected' : ''}>上架中</option>
            <option value="inactive" ${p.status === 'inactive' ? 'selected' : ''}>已下架</option>
            <option value="coming_soon" ${p.status === 'coming_soon' ? 'selected' : ''}>即將推出</option>
          </select>
          <button class="btn btn-secondary btn-sm" data-action="archive-product" data-id="${escAdminHtml(p.id)}" ${pendingArchiveIds.has(p.id) ? 'disabled' : ''}>封存</button>
        </td>
      </tr>
    `).join('');
  }

  renderAdminPagination(document.getElementById('product-table-pagination'), {
    page, totalPages, onChange: p => { productsPageState.page = p; renderProductTable(); }
  });
}

// 表格內「編輯」按鈕、狀態下拉選單、封存／還原按鈕改用事件委派（data-id 走 data-* 屬性，
// 不把商品 id 直接串進 onclick 字串），監聽器只在頁面載入時綁定一次，重繪表格不會重複綁定。
document.getElementById('product-table-body').addEventListener('click', (e) => {
  const editBtn = e.target.closest('[data-action="edit-product"]');
  if (editBtn) { openProductForm(editBtn.dataset.id); return; }
  const archiveBtn = e.target.closest('[data-action="archive-product"]');
  if (archiveBtn) { handleArchiveClick(archiveBtn.dataset.id); return; }
  const restoreBtn = e.target.closest('[data-action="restore-product"]');
  if (restoreBtn) { handleRestoreClick(restoreBtn.dataset.id); return; }
});
document.getElementById('product-table-body').addEventListener('change', (e) => {
  const sel = e.target.closest('[data-action="status-select"]');
  if (sel) handleStatusSelectChange(sel);
});

// ─── 封存／還原：操作前顯示商品名稱與影響的二次確認 ──────────
async function handleArchiveClick(id) {
  if (pendingArchiveIds.has(id)) return; // 防止重複送出
  const product = allProducts.find(p => p.id === id);
  if (!product) return;

  const { confirmed } = await adminConfirmDialog({
    title: '確認封存商品',
    message: `確定要封存商品「${product.name}」嗎？封存後此商品會從前台商品頁及後台「目前商品」清單中移除，但不會刪除商品本身、圖片、庫存或歷史訂單資料，之後仍可在「已封存」頁籤找到並還原。`,
    confirmLabel: '確認封存'
  });
  if (!confirmed) return;

  pendingArchiveIds.add(id);
  renderProductTable();
  try {
    const resp = await adminFetch(`/api/admin/products/${encodeURIComponent(id)}/archive`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      showAdminToast(data.error || '封存失敗，請稍後再試', true);
      return;
    }
    showAdminToast(data.alreadyArchived ? `「${product.name}」原本就已封存` : `已封存「${product.name}」`);
    await loadProducts();
  } catch (e) {
    showAdminToast('封存失敗：' + e.message, true);
  } finally {
    pendingArchiveIds.delete(id);
    // 失敗／網路中斷時 loadProducts() 不會執行，按鈕會停留在送出前 renderProductTable()
    // 畫出的 disabled 狀態；這裡清完 pending 狀態後一定要重新渲染，按鈕才會恢復可點擊。
    renderProductTable();
  }
}

async function handleRestoreClick(id) {
  if (pendingArchiveIds.has(id)) return; // 防止重複送出
  const product = allProducts.find(p => p.id === id);
  if (!product) return;

  const { confirmed } = await adminConfirmDialog({
    title: '確認還原商品',
    message: `確定要還原商品「${product.name}」嗎？還原後此商品會回到「目前商品」清單，並依原本的上架／下架狀態決定是否出現在前台商品頁。`,
    confirmLabel: '確認還原'
  });
  if (!confirmed) return;

  pendingArchiveIds.add(id);
  renderProductTable();
  try {
    const resp = await adminFetch(`/api/admin/products/${encodeURIComponent(id)}/restore`, { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) {
      showAdminToast(data.error || '還原失敗，請稍後再試', true);
      return;
    }
    showAdminToast(data.alreadyActive ? `「${product.name}」原本就不是封存狀態` : `已還原「${product.name}」`);
    await loadProducts();
  } catch (e) {
    showAdminToast('還原失敗：' + e.message, true);
  } finally {
    pendingArchiveIds.delete(id);
    // 失敗／網路中斷時 loadProducts() 不會執行，按鈕會停留在送出前 renderProductTable()
    // 畫出的 disabled 狀態；這裡清完 pending 狀態後一定要重新渲染，按鈕才會恢復可點擊。
    renderProductTable();
  }
}

// ─── 上下架／即將推出：切換前顯示確認對話框，取消不送出請求 ──────
async function handleStatusSelectChange(selectEl) {
  const id = selectEl.dataset.id;
  const newStatus = selectEl.value;
  const product = allProducts.find(p => p.id === id);
  if (!product) return;
  const prevStatus = product.status;
  if (newStatus === prevStatus) return;

  const { confirmed } = await adminConfirmDialog({
    title: '確認變更商品狀態',
    message: `確定要將商品「${product.name}」的狀態從「${statusLabel(prevStatus)}」改為「${statusLabel(newStatus)}」嗎？`,
    confirmLabel: '確認變更'
  });
  if (!confirmed) {
    selectEl.value = prevStatus;
    return;
  }

  pendingStatusIds.add(id);
  selectEl.disabled = true;
  try {
    const resp = await adminFetch(`/api/admin/products/${encodeURIComponent(id)}`, {
      method: 'PUT', body: JSON.stringify({ status: newStatus })
    });
    const data = await resp.json();
    if (!resp.ok) {
      showAdminToast(data.error || '狀態更新失敗', true);
      selectEl.value = prevStatus;
      return;
    }
    showAdminToast(`已將「${product.name}」改為「${statusLabel(newStatus)}」`);
    await loadProducts();
  } catch (e) {
    showAdminToast('狀態更新失敗：' + e.message, true);
    selectEl.value = prevStatus;
  } finally {
    pendingStatusIds.delete(id);
    // loadProducts() 成功時已經整張表重繪過（含這個 select），這裡的 disabled 還原只在失敗、
    // 表格沒有重繪的情況下才有意義；重繪後的新 select 元素不受影響。
    selectEl.disabled = false;
  }
}

// ─── 商品操作歷程 ─────────────────────────
async function openAuditLog() {
  document.getElementById('product-list-view').classList.add('hidden');
  document.getElementById('audit-log-view').classList.remove('hidden');
  // 每次打開都重新抓一次商品清單（不快取）：商品可能在上次打開之後被新增、改名、
  // 封存或還原，快取一次就不再更新的話，篩選選單會跟實際商品資料脫節；上次載入
  // 失敗時這裡重新呼叫也剛好等於自動重試，不需要另外記錄「要不要重試」的狀態。
  await loadAuditProductOptions();
  auditLogPage = 1;
  loadAuditLog();
}

function closeAuditLog() {
  document.getElementById('audit-log-view').classList.add('hidden');
  document.getElementById('product-list-view').classList.remove('hidden');
}

// 篩選用的商品下拉選單需要涵蓋「目前商品」與「已封存」商品（歷程本來就可能牽涉已封存商品）。
async function loadAuditProductOptions() {
  const select = document.getElementById('audit-filter-product');
  const previousValue = select.value; // 重新載入後盡量保留使用者原本選的商品

  // 一定要先清空再重新載入，不能只在成功時才清空：不然每次打開都呼叫這支函式的情況下，
  // 舊選項會一直往後疊加，同一個商品會在下拉選單裡出現好幾次。
  select.innerHTML = '<option value="">全部商品</option>';

  try {
    const [currentResp, archivedResp] = await Promise.all([
      adminFetch('/api/admin/products'),
      adminFetch('/api/admin/products?archived=1')
    ]);
    const currentData = await currentResp.json().catch(() => null);
    const archivedData = await archivedResp.json().catch(() => null);

    // 兩支商品 API 都要成功才算載入完成；只要有一支失敗（即使另一支回了 200），
    // 篩選清單就可能是不完整的（例如漏掉全部已封存商品），不能當成功處理。
    if (!currentResp.ok || !archivedResp.ok) {
      const err = (currentData && currentData.error) || (archivedData && archivedData.error) || '商品清單載入失敗';
      throw new Error(err);
    }

    const merged = [...(currentData.products || []), ...(archivedData.products || [])]
      .sort((a, b) => a.id.localeCompare(b.id));
    merged.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name}（${p.id}）`;
      select.appendChild(opt);
    });

    if (previousValue && merged.some(p => p.id === previousValue)) {
      select.value = previousValue;
    }
  } catch (e) {
    showAdminToast('商品篩選清單載入失敗：' + e.message, true);
  }
}

document.getElementById('audit-filter-product').addEventListener('change', () => { auditLogPage = 1; loadAuditLog(); });
document.getElementById('audit-filter-action').addEventListener('change', () => { auditLogPage = 1; loadAuditLog(); });

async function loadAuditLog() {
  const tbody = document.getElementById('audit-log-body');
  tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:30px;">載入中…</td></tr>`;

  const productId = document.getElementById('audit-filter-product').value;
  const action = document.getElementById('audit-filter-action').value;
  const params = new URLSearchParams();
  if (productId) params.set('productId', productId);
  if (action) params.set('action', action);
  params.set('page', auditLogPage);
  params.set('pageSize', AUDIT_LOG_PAGE_SIZE);

  try {
    const resp = await adminFetch(`/api/admin/products/audit-log?${params.toString()}`);
    const data = await resp.json();
    if (!resp.ok) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:30px;">${escAdminHtml(data.error || '載入失敗')}</td></tr>`;
      return;
    }
    renderAuditLogTable(data.entries || []);
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / AUDIT_LOG_PAGE_SIZE));
    document.getElementById('audit-log-page-info').textContent = `第 ${data.page} / ${totalPages} 頁，共 ${data.total} 筆`;
    document.getElementById('btn-audit-prev-page').disabled = data.page <= 1;
    document.getElementById('btn-audit-next-page').disabled = data.page >= totalPages;
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:30px;">載入失敗：${escAdminHtml(e.message)}</td></tr>`;
  }
}

function changeAuditLogPage(delta) {
  auditLogPage = Math.max(1, auditLogPage + delta);
  loadAuditLog();
}

function formatAuditTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('zh-TW', { hour12: false });
}

// 只顯示「有變更的欄位」（entry.changedFields），不是整份 before/after JSON——
// 一筆商品有 20 幾個欄位，整份 JSON 攤開來完全無法閱讀，只列出真正改動的欄位跟前後值才有用。
function formatAuditValue(v) {
  if (v === null || v === undefined || v === '') return '（空）';
  if (typeof v === 'object') return escAdminHtml(JSON.stringify(v));
  return escAdminHtml(String(v));
}

function renderChangedFields(entry) {
  const fields = entry.changedFields || [];
  if (!fields.length) return '<span style="color:var(--gray-400);">（無欄位差異）</span>';
  return fields.map(key => {
    const label = AUDIT_FIELD_LABELS[key] || key;
    const beforeVal = entry.before ? entry.before[key] : undefined;
    const afterVal = entry.after ? entry.after[key] : undefined;
    const beforeText = entry.before ? formatAuditValue(beforeVal) : '（新建）';
    const afterText = formatAuditValue(afterVal);
    return `<div style="margin-bottom:4px;"><b>${escAdminHtml(label)}</b>：${beforeText} → ${afterText}</div>`;
  }).join('');
}

function renderAuditLogTable(entries) {
  const tbody = document.getElementById('audit-log-body');
  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--gray-400);padding:30px;">沒有符合條件的操作歷程</td></tr>`;
    return;
  }
  tbody.innerHTML = entries.map(entry => `
    <tr>
      <td style="white-space:nowrap;">${escAdminHtml(formatAuditTime(entry.createdAt))}</td>
      <td>${escAdminHtml(entry.productName)}<br><code style="font-size:11px;color:var(--gray-400);">${escAdminHtml(entry.productId)}</code></td>
      <td><span class="status-pill">${escAdminHtml(AUDIT_ACTION_LABELS[entry.action] || entry.action)}</span></td>
      <td style="white-space:normal;max-width:520px;">${renderChangedFields(entry)}</td>
    </tr>
  `).join('');
}

// ─── 動態列表（材質/工藝/容量/數量折扣）──────────────
function renderDynSection(key) {
  const el = document.getElementById(`dyn-${key}`);
  const rows = formState[key] || [];
  const fields = DYN_FIELDS[key];
  const headers = DYN_FIELD_HEADERS[key];
  // 固定標題列：跟下面輸入框用同一套flex排版對齊（3個flex:1欄位＋一個對齊移除按鈕寬度的
  // 佔位空白），不管目前有沒有資料都會顯示，讓使用者一眼看懂每一欄要填什麼。
  // 注意：這一列刻意「不」加上 .dyn-row這個class——validateOptionEntriesClient()／數量折扣
  // 重疊檢查都用 `#dyn-${key} .dyn-row` 抓資料列、再用index對應formState陣列，如果標題列也算
  // 一個.dyn-row，會讓第一筆真正的資料被誤判成標題列、後面全部資料錯位一格。標題列改用獨立
  // 的.dyn-row-header class（CSS另外給一樣的flex排版對齊），不會被這些查詢選到。
  const headerHtml = `<div class="dyn-row-header">${headers.map(h => `<span>${escAdminHtml(h)}</span>`).join('')}<span class="dyn-row-header-spacer"></span></div>`;
  const bodyHtml = rows.length ? rows.map((row, i) => `
    <div class="dyn-row">
      ${fields.map(f => `<input type="${f.type || 'text'}" placeholder="${f.placeholder}" value="${escAdminHtml(row[f.key] ?? '')}" oninput="updateDynField('${key}',${i},'${f.key}',this.value,'${f.type || 'text'}')">`).join('')}
      <button type="button" class="dyn-row-remove" onclick="removeDynRow('${key}',${i})">✕</button>
    </div>
  `).join('') : `<p style="font-size:12px;color:var(--gray-400);">尚未新增任何項目，點下方「＋新增」開始填寫</p>`;
  el.innerHTML = headerHtml + bodyHtml;
}

function updateDynField(key, idx, field, value, type) {
  // 數字欄位清空時要保留空字串 ''，不可以用 Number('') 靜靜變成 0——0 是合法的價格，
  // 空字串是「還沒填」，兩者意義完全不同，混在一起會讓「填完價格後又清空」被誤判為合法的 0 元。
  // parseRequiredNumber() 已經有處理 '' 視為必填未填的邏輯，這裡只要把原始字串狀態保留給它判斷即可。
  formState[key][idx][field] = (type === 'number' && value !== '') ? Number(value) : value;
}
function addDynRow(key) {
  formState[key] = formState[key] || [];
  formState[key].push({});
  renderDynSection(key);
  markFormDirty();
}
function removeDynRow(key, idx) {
  formState[key].splice(idx, 1);
  renderDynSection(key);
  markFormDirty();
}
function toggleCapacities(hasCapacities) {
  formState.capacities = hasCapacities ? (formState.capacities || []) : null;
  document.getElementById('dyn-capacities').closest('.admin-form-section').querySelector('#btn-add-capacity').style.display = hasCapacities ? '' : 'none';
  document.getElementById('dyn-capacities').style.display = hasCapacities ? '' : 'none';
  if (hasCapacities) renderDynSection('capacities');
}

// ─── 未儲存變更追蹤 ─────────────────────────
// 表單面板內任何原生欄位的 input／change 事件都會冒泡到這裡（含動態新增的材質/工藝/
// 容量/數量折扣列），一律視為「有修改」；openProductForm() 用 .value = ... 帶入既有資料
// 不會觸發這兩個事件，所以純開啟表單不會誤判成 dirty。新增/刪除動態列是按鈕點擊，
// 不在 input/change 事件範圍內，另外在 addDynRow()/removeDynRow() 內明確呼叫。
function markFormDirty() { formDirty = true; }
(function bindDirtyTracking() {
  const panel = document.getElementById('product-form-panel');
  panel.addEventListener('input', markFormDirty);
  panel.addEventListener('change', markFormDirty);
})();

window.addEventListener('beforeunload', (e) => {
  const panel = document.getElementById('product-form-panel');
  const panelOpen = panel && !panel.classList.contains('hidden');
  if (panelOpen && formDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ─── 圖片網址即時預覽 ───────────────────────
function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function renderImagePreviewBox(boxId, url) {
  const box = document.getElementById(boxId);
  box.innerHTML = '';
  const trimmed = (url || '').trim();
  if (!trimmed) {
    const span = document.createElement('span');
    span.className = 'img-preview-empty';
    span.textContent = '尚未設定圖片';
    box.appendChild(span);
    return;
  }
  if (typeof isSafeImageUrl !== 'function' || !isSafeImageUrl(trimmed)) {
    const span = document.createElement('span');
    span.className = 'img-preview-error';
    span.textContent = '網址不安全，已封鎖預覽';
    box.appendChild(span);
    return;
  }
  const img = document.createElement('img');
  img.alt = '';
  img.addEventListener('error', () => {
    box.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'img-preview-error';
    span.textContent = '圖片載入失敗，請確認網址是否正確';
    box.appendChild(span);
  });
  // 商品圖片路徑存的是「相對於網站根目錄」的路徑（例如 assets/photos/xxx.jpg），是給
  // 網站根目錄的前台頁面（index.html／customize）用的。這個後台表單網址是 /admin/products，
  // 若原樣當成相對路徑會被瀏覽器解析成 /admin/assets/photos/xxx.jpg 而 404。純預覽用途，
  // 補上開頭的 / 讓它變成從網站根目錄解析，不影響實際存進資料庫的原始字串。
  const isAbsoluteUrl = /^https?:\/\//i.test(trimmed) || trimmed.startsWith('/');
  img.src = isAbsoluteUrl ? trimmed : ('/' + trimmed);
  box.appendChild(img);
}

function setupImagePreview(inputId, boxId) {
  const input = document.getElementById(inputId);
  const render = () => renderImagePreviewBox(boxId, input.value);
  input.addEventListener('input', debounce(render, 350));
  return render;
}

const renderImagePreview = setupImagePreview('form-image', 'preview-image');
const renderBgImagePreview = setupImagePreview('form-bg-image', 'preview-bg-image');

// ─── 圖片直接上傳 ───────────────────────────
// 上傳按鈕只是觸發旁邊那個隱藏的 <input type="file">；實際送出交給 handleImageUpload()。
document.querySelectorAll('[data-upload-btn]').forEach(btn => {
  btn.addEventListener('click', () => {
    const fileInput = document.getElementById('upload-' + btn.dataset.uploadBtn);
    if (fileInput) fileInput.click();
  });
});
document.querySelectorAll('[data-upload-target]').forEach(fileInput => {
  fileInput.addEventListener('change', () => handleImageUpload(fileInput));
});

async function handleImageUpload(fileInput) {
  const targetId = fileInput.dataset.uploadTarget; // 'form-image' 或 'form-bg-image'
  const file = fileInput.files && fileInput.files[0];
  if (!file) return;

  const statusEl = document.getElementById('upload-status-' + targetId);
  const targetInput = document.getElementById(targetId);
  const btn = document.querySelector(`[data-upload-btn="${targetId}"]`);

  if (statusEl) { statusEl.textContent = '上傳中…'; statusEl.className = 'upload-status uploading'; }
  if (btn) btn.disabled = true;

  try {
    const formData = new FormData();
    formData.append('image', file);
    // adminFetch 對 FormData body 不會強塞 Content-Type，瀏覽器會自己補上正確的
    // multipart/form-data 邊界字串；401 時也會沿用它既有的自動登出／顯示登入畫面邏輯。
    const resp = await adminFetch('/api/admin/upload-image', { method: 'POST', body: formData });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || '圖片上傳失敗，請重新選擇檔案');
    }

    targetInput.value = data.path;
    // 用真正的 input 事件（不是直接改 formState）觸發：會冒泡到表單面板讓 markFormDirty()
    // 生效，同時也會被這個欄位自己的圖片預覽監聽器接住，兩件事都不用再另外寫一次。
    targetInput.dispatchEvent(new Event('input', { bubbles: true }));

    if (statusEl) { statusEl.textContent = '上傳成功：' + data.path; statusEl.className = 'upload-status success'; }
  } catch (e) {
    if (statusEl) { statusEl.textContent = e.message || '圖片上傳失敗，請重新選擇檔案'; statusEl.className = 'upload-status error'; }
  } finally {
    if (btn) btn.disabled = false;
    fileInput.value = ''; // 清空選擇，允許使用者重新選同一個檔案也能再次觸發 change
  }
}

// ─── 可印刷範圍視覺編輯器 ───────────────────────
// 比例（xRatio/yRatio/wRatio/hRatio）跟前台 preview2d.js 的 labelArea 用法一致：
// 都是相對於「整張底圖／畫布」的 0~1 比例，跟圖片實際顯示的像素大小無關。範圍框直接用
// CSS 百分比定位（left/top/width/height 用 %），比例數字可以直接當百分比套用，視窗大小
// 改變、圖片縮放時瀏覽器會自動維持相對位置，不需要另外用像素換算重新計算一次。
const LABELAREA_MIN_RATIO = 0.02; // 拖曳/縮放時的最小寬高比例，避免縮到看不見或變成 0

function labelAreaInputs() {
  return {
    x: document.getElementById('form-la-x'),
    y: document.getElementById('form-la-y'),
    w: document.getElementById('form-la-w'),
    h: document.getElementById('form-la-h')
  };
}

// 回傳目前 4 個輸入框代表的狀態：null（四格都空，代表沒有印刷區限制）、
// 'partial'（只填了部分，還不是合法狀態，先不畫框，等使用者填完或存檔驗證會擋）、
// 或 { xRatio, yRatio, wRatio, hRatio }（四格都有值）。
function getLabelAreaValues() {
  const { x, y, w, h } = labelAreaInputs();
  const raw = [x.value, y.value, w.value, h.value];
  if (raw.every(v => v === '')) return null;
  if (raw.some(v => v === '')) return 'partial';
  const n = raw.map(Number);
  if (n.some(v => !Number.isFinite(v))) return 'partial';
  return { xRatio: n[0], yRatio: n[1], wRatio: n[2], hRatio: n[3] };
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// 把 la（null 或 4 個比例的物件）寫回 4 個輸入框，並重繪範圍框。silent=true 用於表單
// 初始化時帶入既有資料（不算使用者操作，不觸發未儲存提醒）；一般拖曳/縮放/手動輸入/
// 清除/重設都要送出真正的 input 事件，讓既有的 markFormDirty() 委派監聽器接住。
function setLabelAreaInputs(la, { silent } = {}) {
  const { x, y, w, h } = labelAreaInputs();
  if (!la) {
    x.value = ''; y.value = ''; w.value = ''; h.value = '';
  } else {
    x.value = round4(la.xRatio);
    y.value = round4(la.yRatio);
    w.value = round4(la.wRatio);
    h.value = round4(la.hRatio);
  }
  if (!silent) {
    x.dispatchEvent(new Event('input', { bubbles: true }));
  }
  renderLabelAreaBox();
}

function renderLabelAreaBox() {
  const box = document.getElementById('labelarea-box');
  if (!box) return;
  const la = getLabelAreaValues();
  if (!la || la === 'partial') {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  box.style.left = (la.xRatio * 100) + '%';
  box.style.top = (la.yRatio * 100) + '%';
  box.style.width = (la.wRatio * 100) + '%';
  box.style.height = (la.hRatio * 100) + '%';
}

// 印刷範圍編輯器的背景預覽圖：優先用底圖（bgImage），沒有底圖用商品圖片（image），
// 都沒有就顯示清楚提示；沿用跟商品圖片預覽一樣的安全網址規則與根路徑補正。
function refreshLabelAreaBackground() {
  const imageVal = document.getElementById('form-image').value.trim();
  const bgVal = document.getElementById('form-bg-image').value.trim();
  const url = bgVal || imageVal;

  const emptyEl = document.getElementById('labelarea-editor-empty');
  const stageEl = document.getElementById('labelarea-editor-stage');
  const imgEl = document.getElementById('labelarea-editor-img');
  if (!emptyEl || !stageEl || !imgEl) return;

  if (!url) {
    emptyEl.textContent = '尚未設定商品圖片或底圖，請先在上方填寫圖片路徑或底圖路徑，才能編輯可印刷範圍';
    emptyEl.style.display = '';
    stageEl.style.display = 'none';
    return;
  }
  if (typeof isSafeImageUrl !== 'function' || !isSafeImageUrl(url)) {
    emptyEl.textContent = '圖片網址不安全，無法載入可印刷範圍編輯器';
    emptyEl.style.display = '';
    stageEl.style.display = 'none';
    return;
  }

  const isAbsoluteUrl = /^https?:\/\//i.test(url) || url.startsWith('/');
  const resolvedUrl = isAbsoluteUrl ? url : ('/' + url);

  imgEl.onerror = () => {
    emptyEl.textContent = '圖片載入失敗，無法顯示可印刷範圍編輯器，請確認圖片路徑是否正確';
    emptyEl.style.display = '';
    stageEl.style.display = 'none';
  };
  imgEl.onload = () => {
    emptyEl.style.display = 'none';
    stageEl.style.display = '';
    renderLabelAreaBox();
  };
  imgEl.src = resolvedUrl;
}

// 拖曳／縮放：全程用比例座標運算（滑鼠位移 ÷ 圖片目前顯示的寬高），不快取像素值，
// 每次動作都重新讀取 getBoundingClientRect()，所以視窗大小或圖片縮放改變後位置不會跑掉。
function initLabelAreaDragResize() {
  const stage = document.getElementById('labelarea-editor-stage');
  const box = document.getElementById('labelarea-box');
  if (!stage || !box) return;

  let mode = null; // 'move' | 'nw' | 'ne' | 'sw' | 'se'
  let startPointer = null;
  let startBox = null;

  function clamp01(n) { return Math.min(1, Math.max(0, n)); }

  function ratioFromEvent(e) {
    const rect = stage.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / rect.width,
      y: (e.clientY - rect.top) / rect.height
    };
  }

  // 統一收斂：寬高限制在 [最小值, 1]，位置限制在 [0,1]，且 x+w／y+h 不可超過 1——
  // 跟後端 checkOptionalLabelArea() 的規則一致，拖曳時就不可能產生會被後端拒絕的數值。
  function applyBox(nx, ny, nw, nh) {
    nw = Math.max(LABELAREA_MIN_RATIO, Math.min(1, nw));
    nh = Math.max(LABELAREA_MIN_RATIO, Math.min(1, nh));
    nx = clamp01(nx);
    ny = clamp01(ny);
    if (nx + nw > 1) nx = 1 - nw;
    if (ny + nh > 1) ny = 1 - nh;
    nx = clamp01(nx);
    ny = clamp01(ny);
    setLabelAreaInputs({ xRatio: nx, yRatio: ny, wRatio: nw, hRatio: nh });
  }

  function onPointerMove(e) {
    if (!mode) return;
    const p = ratioFromEvent(e);
    const dx = p.x - startPointer.x;
    const dy = p.y - startPointer.y;
    const { xRatio: x, yRatio: y, wRatio: w, hRatio: h } = startBox;

    if (mode === 'move') {
      applyBox(x + dx, y + dy, w, h);
      return;
    }

    let nx = x, ny = y, nw = w, nh = h;

    // 西側／北側縮放：對面那條邊（右邊界 x+w、下邊界 y+h）是固定錨點，先算出縮到最小
    // 之後「還剩多少寬/高」，再用「錨點 - 剩餘寬/高」反推左/上邊界，而不是直接拿游標位移
    // 當作左/上邊界。這樣游標繼續往錨點方向拖過頭時，寬高會停在 LABELAREA_MIN_RATIO、
    // 邊界也會跟著停在貼齊錨點的位置，不會出現「寬高卡住了但邊界還在跟著游標亂跑」的跳位。
    if (mode.includes('w')) {
      const rightEdge = x + w;
      nw = Math.max(LABELAREA_MIN_RATIO, w - dx);
      nx = rightEdge - nw;
    } else if (mode.includes('e')) {
      nw = w + dx;
    }
    if (mode.includes('n')) {
      const bottomEdge = y + h;
      nh = Math.max(LABELAREA_MIN_RATIO, h - dy);
      ny = bottomEdge - nh;
    } else if (mode.includes('s')) {
      nh = h + dy;
    }
    applyBox(nx, ny, nw, nh);
  }

  function endInteraction() {
    mode = null;
    startPointer = null;
    startBox = null;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', endInteraction);
    document.removeEventListener('pointercancel', endInteraction);
  }

  function startInteraction(e, interactionMode) {
    e.preventDefault();
    mode = interactionMode;
    startPointer = ratioFromEvent(e);
    const la = getLabelAreaValues();
    // 還沒有印刷範圍（null 或格式不完整）就先給一個預設起始框，讓使用者能直接開始拖曳，
    // 不用先手動輸入四個數字才能用視覺編輯器。
    startBox = (la && la !== 'partial') ? la : { xRatio: 0.25, yRatio: 0.25, wRatio: 0.5, hRatio: 0.5 };
    if (!la || la === 'partial') {
      setLabelAreaInputs(startBox);
      startBox = getLabelAreaValues();
    }
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', endInteraction, { once: true });
    // 觸控操作被系統中斷（例如切換 App、跳出系統手勢）只會收到 pointercancel、收不到
    // pointerup，沒有這個清理的話 mode 會卡住，之後的點擊會被誤判成還在拖曳中。
    document.addEventListener('pointercancel', endInteraction, { once: true });
  }

  box.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.labelarea-handle')) return; // 角落的縮放把手各自處理
    startInteraction(e, 'move');
  });
  box.querySelectorAll('.labelarea-handle').forEach(handle => {
    handle.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      startInteraction(e, handle.dataset.handle);
    });
  });

  // 目前還沒有印刷範圍時，框是 display:none、點不到；改成點圖片空白處直接在該點「畫出」
  // 一個新框（從小範圍開始），接著沿用同一套拖曳邏輯讓使用者馬上能拉開大小，
  // 不用被迫先手動輸入四個數字才能開始用視覺編輯器。
  stage.addEventListener('pointerdown', (e) => {
    if (mode) return;
    if (e.target.closest('.labelarea-box')) return;
    const la = getLabelAreaValues();
    if (la && la !== 'partial') return; // 已經有框了，交給框自己的拖曳處理
    const p = ratioFromEvent(e);
    // 一定要走 applyBox() 收斂，不能直接把 clamp01(p.x)／clamp01(p.y) 寫進輸入框：
    // 在圖片最右或最下邊緣點擊時 p.x／p.y 會很接近 1，加上最小寬高 LABELAREA_MIN_RATIO
    // 就會讓 xRatio+wRatio 或 yRatio+hRatio 超過 1——即使使用者只點一下、沒有拖曳移動
    // （不會觸發 pointermove），這個起始框也必須是合法的，applyBox() 才會在寫入前
    // 就把 x／y 往回收，讓新框從一開始就完全落在圖片內。
    applyBox(p.x, p.y, LABELAREA_MIN_RATIO, LABELAREA_MIN_RATIO);
    startInteraction(e, 'se');
  });
}
initLabelAreaDragResize();

document.getElementById('form-image').addEventListener('input', debounce(refreshLabelAreaBackground, 350));
document.getElementById('form-bg-image').addEventListener('input', debounce(refreshLabelAreaBackground, 350));
document.getElementById('btn-labelarea-clear').addEventListener('click', () => setLabelAreaInputs(null));
document.getElementById('btn-labelarea-reset').addEventListener('click', () => setLabelAreaInputs(labelAreaOriginalSnapshot));

// 手動修改四個比例數字時也要同步更新視覺框（拖曳/縮放是反過來：框→輸入框，這裡是輸入框→框）。
['form-la-x', 'form-la-y', 'form-la-w', 'form-la-h'].forEach(id => {
  document.getElementById(id).addEventListener('input', renderLabelAreaBox);
});

// ─── 開啟/關閉編輯表單 ─────────────────────────
function openProductForm(id) {
  const panel = document.getElementById('product-form-panel');
  const alreadyOpen = !panel.classList.contains('hidden');
  if (alreadyOpen && formDirty) {
    if (!confirm('目前表單有尚未儲存的變更，切換商品會放棄這些變更，確定要繼續嗎？')) return;
  }

  editingProductId = id || null;
  const p = id ? allProducts.find(x => x.id === id) : null;

  formState = {
    materials: p ? JSON.parse(JSON.stringify(p.materials || [])) : [],
    finishes: p ? JSON.parse(JSON.stringify(p.finishes || [])) : [],
    capacities: p && p.capacities ? JSON.parse(JSON.stringify(p.capacities)) : null,
    qtyBreaks: p ? JSON.parse(JSON.stringify(p.qtyBreaks || [])) : []
  };

  document.getElementById('form-id').value = p ? p.id : '';
  document.getElementById('form-id').disabled = !!p;
  document.getElementById('form-name').value = p?.name || '';
  document.getElementById('form-name-en').value = p?.nameEn || '';
  document.getElementById('form-image').value = p?.image || '';
  document.getElementById('form-badge').value = p?.badge || '';
  document.getElementById('form-badge-color').value = p?.badgeColor || '#2D7D46';
  document.getElementById('form-color').value = p?.color || '#2D7D46';
  document.getElementById('form-description').value = p?.description || '';
  document.getElementById('form-size-w').value = p?.size?.w ?? '';
  document.getElementById('form-size-h').value = p?.size?.h ?? '';
  document.getElementById('form-size-unit').value = p?.size?.unit || '';
  document.getElementById('form-display-size').value = p?.displaySize || '';
  document.getElementById('form-bg-image').value = p?.bgImage || '';
  document.getElementById('form-min-qty').value = p?.minQty ?? 1;
  document.getElementById('form-lead-days').value = p?.leadDays ?? 15;
  document.getElementById('form-text-only').checked = !!p?.textOnly;
  document.getElementById('form-status').value = p?.status || 'active';
  document.getElementById('form-sort-order').value = p?.sortOrder ?? 0;

  const hasCap = !!(p && p.capacities);
  document.getElementById('form-has-capacities').checked = hasCap;
  toggleCapacities(hasCap);

  const la = p?.labelArea || null;
  labelAreaOriginalSnapshot = la ? { xRatio: la.xRatio, yRatio: la.yRatio, wRatio: la.wRatio, hRatio: la.hRatio } : null;
  setLabelAreaInputs(la, { silent: true });
  refreshLabelAreaBackground();

  renderDynSection('materials');
  renderDynSection('finishes');
  renderDynSection('qtyBreaks');
  renderImagePreview();
  renderBgImagePreview();
  clearFormErrors();
  document.querySelectorAll('.upload-status').forEach(el => { el.textContent = ''; el.className = 'upload-status'; });

  document.getElementById('product-form-title').textContent = p ? `編輯產品：${p.name}` : '新增產品';
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // 上面全部是程式帶入既有資料（.value = ...），不會觸發 input/change 事件，
  // 所以到這裡 formDirty 理應仍是 false；明確重置一次以絕對保險。
  formDirty = false;
}

function closeProductForm(opts) {
  const skipDirtyCheck = opts && opts.skipDirtyCheck;
  if (!skipDirtyCheck && formDirty) {
    if (!confirm('有尚未儲存的變更，確定要放棄嗎？')) return false;
  }
  document.getElementById('product-form-panel').classList.add('hidden');
  editingProductId = null;
  formDirty = false;
  clearFormErrors();
  return true;
}

// ─── 表單驗證錯誤顯示 ───────────────────────
function clearFormErrors() {
  document.querySelectorAll('#product-form-panel .field-invalid').forEach(el => el.classList.remove('field-invalid'));
  document.querySelectorAll('#product-form-panel .field-error').forEach(el => el.remove());
  document.querySelectorAll('#product-form-panel .section-error').forEach(el => { el.textContent = ''; });
  firstErrorEl = null;
}

function addFieldError(inputEl, message) {
  if (!inputEl) return;
  inputEl.classList.add('field-invalid');
  const errEl = document.createElement('div');
  errEl.className = 'field-error';
  errEl.textContent = message;
  inputEl.insertAdjacentElement('afterend', errEl);
  if (!firstErrorEl) firstErrorEl = inputEl;
}

function containsDangerousMarkupClient(str) {
  if (typeof str !== 'string') return false;
  if (/[<>]/.test(str)) return true;
  if (/\bon[a-z][a-z0-9]*\s*=/i.test(str)) return true;
  if (/javascript\s*:/i.test(str)) return true;
  if (/vbscript\s*:/i.test(str)) return true;
  return false;
}

// 與後端 checkOptionalText() 對齊：空字串永遠合法（代表這個選填欄位沒填），有填才檢查
// 長度上限與危險內容。size.unit 也是用這支驗證，maxLen=10 且允許空字串。
function checkOptionalTextClient(inputEl, maxLen, label) {
  const trimmed = inputEl.value.trim();
  if (trimmed === '') return;
  if (trimmed.length > maxLen) {
    addFieldError(inputEl, `${label}長度不可超過 ${maxLen} 字`);
    return;
  }
  if (containsDangerousMarkupClient(trimmed)) {
    addFieldError(inputEl, `${label}不可包含 HTML 標籤、事件屬性或危險網址`);
  }
}

// 與後端 checkOptionalFiniteNumber／checkRequiredFiniteNumber 對齊：先確認型別再轉數字，
// 拒絕空值、NaN、Infinity，並可加範圍限制。rawValue 一律是表單 <input> 的字串值。
function parseRequiredNumber(rawValue, opts) {
  const { integer, min, max, exclusiveMin } = opts || {};
  if (rawValue === '' || rawValue === null || rawValue === undefined) {
    return { ok: false, message: '為必填欄位' };
  }
  const n = Number(rawValue);
  if (!Number.isFinite(n)) return { ok: false, message: '必須是有限的數字' };
  if (integer && !Number.isInteger(n)) return { ok: false, message: '必須是整數' };
  if (exclusiveMin !== undefined && n <= exclusiveMin) return { ok: false, message: `必須大於 ${exclusiveMin}` };
  if (min !== undefined && n < min) return { ok: false, message: `不可小於 ${min}` };
  if (max !== undefined && n > max) return { ok: false, message: `不可大於 ${max}` };
  return { ok: true, value: n };
}

function validateOptionEntriesClient(key, label, priceField, sectionErrorId) {
  const list = formState[key] || [];
  const sectionEl = document.getElementById(sectionErrorId);
  const rowEls = Array.from(document.querySelectorAll(`#dyn-${key} .dyn-row`));
  if (!list.length) {
    if (sectionEl) sectionEl.textContent = `請至少新增一項${label}`;
    if (!firstErrorEl) firstErrorEl = document.getElementById(`dyn-${key}`);
    return;
  }
  const seenIds = new Set();
  list.forEach((item, i) => {
    const rowEl = rowEls[i];
    const inputs = rowEl ? rowEl.querySelectorAll('input') : [];
    const idInput = inputs[0], nameInput = inputs[1], priceInput = inputs[2];
    const idVal = String(item.id ?? '').trim();
    if (!OPTION_ID_RE_CLIENT.test(idVal)) {
      addFieldError(idInput, '代碼只能用小寫英文/數字/底線，長度 1~40，不可有空白或符號');
    } else if (seenIds.has(idVal)) {
      addFieldError(idInput, `代碼「${idVal}」重複，同一組選項代碼不可重複`);
    } else {
      seenIds.add(idVal);
    }
    const nameVal = String(item.name ?? '').trim();
    if (!nameVal) {
      addFieldError(nameInput, '名稱不可空白');
    } else if (nameVal.length > 60 || containsDangerousMarkupClient(nameVal)) {
      addFieldError(nameInput, '名稱不可包含 HTML 標籤或事件屬性，長度需在 60 字以內');
    }
    const priceCheck = parseRequiredNumber(item[priceField], { min: 0, max: 1000000 });
    if (!priceCheck.ok) addFieldError(priceInput, `價格${priceCheck.message}`);
  });
}

function validateQtyBreaksClient() {
  const list = formState.qtyBreaks || [];
  const sectionEl = document.getElementById('err-qtyBreaks');
  const rowEls = Array.from(document.querySelectorAll('#dyn-qtyBreaks .dyn-row'));
  if (!list.length) {
    if (sectionEl) sectionEl.textContent = '請至少新增一組數量折扣區間';
    if (!firstErrorEl) firstErrorEl = document.getElementById('dyn-qtyBreaks');
    return;
  }
  const ranges = [];
  list.forEach((b, i) => {
    const rowEl = rowEls[i];
    const inputs = rowEl ? rowEl.querySelectorAll('input') : [];
    const minInput = inputs[0], maxInput = inputs[1], priceInput = inputs[2];
    const minCheck = parseRequiredNumber(b.min, { integer: true, min: 1, max: 1000000 });
    if (!minCheck.ok) addFieldError(minInput, `最小數量${minCheck.message}`);
    const maxCheck = parseRequiredNumber(b.max, { integer: true, min: 1, max: 1000000 });
    if (!maxCheck.ok) addFieldError(maxInput, `最大數量${maxCheck.message}`);
    if (minCheck.ok && maxCheck.ok && minCheck.value > maxCheck.value) {
      addFieldError(maxInput, '最大數量不可小於最小數量');
    }
    const priceCheck = parseRequiredNumber(b.price, { min: -100000, max: 1000000 });
    if (!priceCheck.ok) addFieldError(priceInput, `單價調整${priceCheck.message}`);
    if (minCheck.ok && maxCheck.ok && minCheck.value <= maxCheck.value) {
      ranges.push({ min: minCheck.value, max: maxCheck.value, rowEl });
    }
  });
  const sorted = ranges.slice().sort((a, c) => a.min - c.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min <= sorted[i - 1].max) {
      if (sectionEl) {
        sectionEl.textContent = `數量折扣區間互相重疊：${sorted[i - 1].min}~${sorted[i - 1].max} 與 ${sorted[i].min}~${sorted[i].max}`;
      }
      if (sorted[i - 1].rowEl) sorted[i - 1].rowEl.classList.add('field-invalid');
      if (sorted[i].rowEl) sorted[i].rowEl.classList.add('field-invalid');
      if (!firstErrorEl) firstErrorEl = sorted[i - 1].rowEl || sorted[i].rowEl;
      break;
    }
  }
}

function validateLabelAreaClient() {
  const xEl = document.getElementById('form-la-x');
  const yEl = document.getElementById('form-la-y');
  const wEl = document.getElementById('form-la-w');
  const hEl = document.getElementById('form-la-h');
  const sectionEl = document.getElementById('err-labelArea');
  const vals = [xEl.value, yEl.value, wEl.value, hEl.value];
  const filledCount = vals.filter(v => v !== '').length;
  if (filledCount === 0) return;
  if (filledCount < 4) {
    if (sectionEl) sectionEl.textContent = '請完整填寫 X／Y／寬／高 四個比例，或全部留空代表沒有印刷區限制';
    if (!firstErrorEl) firstErrorEl = xEl;
    return;
  }
  const xCheck = parseRequiredNumber(xEl.value, { min: 0, max: 1 });
  if (!xCheck.ok) addFieldError(xEl, `X 比例${xCheck.message}`);
  const yCheck = parseRequiredNumber(yEl.value, { min: 0, max: 1 });
  if (!yCheck.ok) addFieldError(yEl, `Y 比例${yCheck.message}`);
  const wCheck = parseRequiredNumber(wEl.value, { exclusiveMin: 0, max: 1 });
  if (!wCheck.ok) addFieldError(wEl, `寬比例${wCheck.message}`);
  const hCheck = parseRequiredNumber(hEl.value, { exclusiveMin: 0, max: 1 });
  if (!hCheck.ok) addFieldError(hEl, `高比例${hCheck.message}`);
  if (xCheck.ok && wCheck.ok && xCheck.value + wCheck.value > 1) {
    addFieldError(wEl, 'X 比例 + 寬比例不可超過 1（印刷區域會超出卡面寬度）');
  }
  if (yCheck.ok && hCheck.ok && yCheck.value + hCheck.value > 1) {
    addFieldError(hEl, 'Y 比例 + 高比例不可超過 1（印刷區域會超出卡面高度）');
  }
}

// 回傳 true/false；驗證不通過時已經把錯誤訊息插進表單、標紅欄位，並把第一個錯誤
// 欄位記在 firstErrorEl 供呼叫端捲動畫面。
function validateProductFormClient() {
  clearFormErrors();

  const idEl = document.getElementById('form-id');
  const nameEl = document.getElementById('form-name');
  const sizeWEl = document.getElementById('form-size-w');
  const sizeHEl = document.getElementById('form-size-h');
  const minQtyEl = document.getElementById('form-min-qty');
  const leadDaysEl = document.getElementById('form-lead-days');
  const statusEl = document.getElementById('form-status');
  const sortOrderEl = document.getElementById('form-sort-order');
  const imageEl = document.getElementById('form-image');
  const bgImageEl = document.getElementById('form-bg-image');

  // 商品代碼（新增才需要檢查，編輯時欄位鎖定不可改）
  if (!editingProductId) {
    const idVal = idEl.value.trim();
    if (!PRODUCT_ID_RE_CLIENT.test(idVal)) {
      addFieldError(idEl, '產品代碼只能用小寫英文/數字/底線，長度 2~40 字，例如 usb_bar');
    }
  }

  // 名稱
  const nameVal = nameEl.value.trim();
  if (!nameVal) {
    addFieldError(nameEl, '請輸入產品名稱');
  } else if (nameVal.length > 100) {
    addFieldError(nameEl, '產品名稱長度不可超過 100 字');
  } else if (containsDangerousMarkupClient(nameVal)) {
    addFieldError(nameEl, '產品名稱不可包含 HTML 標籤、事件屬性或危險網址');
  }

  // 選填文字欄位：長度上限與危險內容規則與 admin-routes.js 的 TEXT_FIELD_LIMITS 一致
  checkOptionalTextClient(document.getElementById('form-name-en'), 100, '英文名稱');
  checkOptionalTextClient(document.getElementById('form-description'), 1000, '產品說明');
  checkOptionalTextClient(document.getElementById('form-badge'), 40, '徽章文字');
  checkOptionalTextClient(document.getElementById('form-display-size'), 60, '顯示用尺寸文字');
  checkOptionalTextClient(document.getElementById('form-size-unit'), 10, '尺寸單位');

  // 尺寸
  const wCheck = parseRequiredNumber(sizeWEl.value, { exclusiveMin: 0, max: 100000 });
  if (!wCheck.ok) addFieldError(sizeWEl, `寬度${wCheck.message}`);
  const hCheck = parseRequiredNumber(sizeHEl.value, { exclusiveMin: 0, max: 100000 });
  if (!hCheck.ok) addFieldError(sizeHEl, `高度${hCheck.message}`);

  // 最少訂購數量／交期
  const minQtyCheck = parseRequiredNumber(minQtyEl.value, { integer: true, min: 1, max: 1000000 });
  if (!minQtyCheck.ok) addFieldError(minQtyEl, `最少訂購數量${minQtyCheck.message}`);
  const leadDaysCheck = parseRequiredNumber(leadDaysEl.value, { integer: true, min: 0, max: 3650 });
  if (!leadDaysCheck.ok) addFieldError(leadDaysEl, `交期天數${leadDaysCheck.message}`);

  // 排序（選填）
  if (sortOrderEl.value !== '') {
    const sortCheck = parseRequiredNumber(sortOrderEl.value, { integer: true, min: -1000000, max: 1000000 });
    if (!sortCheck.ok) addFieldError(sortOrderEl, `排序${sortCheck.message}`);
  }

  // 狀態
  if (!['active', 'inactive', 'coming_soon'].includes(statusEl.value)) {
    addFieldError(statusEl, '請選擇正確的狀態');
  }

  // 圖片網址（沿用與前台相同的安全網址規則）
  const imageVal = imageEl.value.trim();
  if (imageVal && (typeof isSafeImageUrl !== 'function' || !isSafeImageUrl(imageVal))) {
    addFieldError(imageEl, '圖片網址不安全或格式不正確，僅允許站內路徑、http(s) 網址或安全的點陣圖 data:image');
  }
  const bgImageVal = bgImageEl.value.trim();
  if (bgImageVal && (typeof isSafeImageUrl !== 'function' || !isSafeImageUrl(bgImageVal))) {
    addFieldError(bgImageEl, '底圖網址不安全或格式不正確，僅允許站內路徑、http(s) 網址或安全的點陣圖 data:image');
  }

  // 材質／工藝／容量
  validateOptionEntriesClient('materials', '材質', 'priceBase', 'err-materials');
  validateOptionEntriesClient('finishes', '工藝', 'price', 'err-finishes');
  if (document.getElementById('form-has-capacities').checked) {
    validateOptionEntriesClient('capacities', '容量', 'price', 'err-capacities');
  }

  // 數量折扣
  validateQtyBreaksClient();

  // 印刷區座標比例
  validateLabelAreaClient();

  if (firstErrorEl) {
    firstErrorEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (typeof firstErrorEl.focus === 'function') {
      try { firstErrorEl.focus({ preventScroll: true }); } catch { firstErrorEl.focus(); }
    }
    return false;
  }
  return true;
}

// ─── 儲存 ───────────────────────────────────
async function saveProduct() {
  if (isSaving) return; // 連續快速點擊只送出一次請求

  if (!validateProductFormClient()) {
    showAdminToast('請修正表單中標示的錯誤欄位', true);
    return;
  }

  const id = document.getElementById('form-id').value.trim();
  const laX = document.getElementById('form-la-x').value;
  const laY = document.getElementById('form-la-y').value;
  const laW = document.getElementById('form-la-w').value;
  const laH = document.getElementById('form-la-h').value;

  const body = {
    name: document.getElementById('form-name').value.trim(),
    nameEn: document.getElementById('form-name-en').value.trim() || null,
    image: document.getElementById('form-image').value.trim() || null,
    badge: document.getElementById('form-badge').value.trim() || null,
    badgeColor: document.getElementById('form-badge-color').value || null,
    description: document.getElementById('form-description').value.trim() || null,
    size: {
      w: Number(document.getElementById('form-size-w').value),
      h: Number(document.getElementById('form-size-h').value),
      unit: document.getElementById('form-size-unit').value.trim()
    },
    displaySize: document.getElementById('form-display-size').value.trim() || null,
    bgImage: document.getElementById('form-bg-image').value.trim() || null,
    labelArea: (laX !== '' && laY !== '' && laW !== '' && laH !== '')
      ? { xRatio: Number(laX), yRatio: Number(laY), wRatio: Number(laW), hRatio: Number(laH) }
      : null,
    minQty: Number(document.getElementById('form-min-qty').value),
    leadDays: Number(document.getElementById('form-lead-days').value),
    color: document.getElementById('form-color').value || null,
    textOnly: document.getElementById('form-text-only').checked,
    status: document.getElementById('form-status').value,
    sortOrder: document.getElementById('form-sort-order').value !== '' ? Number(document.getElementById('form-sort-order').value) : 0,
    materials: formState.materials,
    finishes: formState.finishes,
    capacities: document.getElementById('form-has-capacities').checked ? formState.capacities : null,
    qtyBreaks: formState.qtyBreaks
  };

  let url = '/api/admin/products';
  let method = 'POST';
  if (editingProductId) {
    url = `/api/admin/products/${encodeURIComponent(editingProductId)}`;
    method = 'PUT';
  } else {
    body.id = id;
  }

  const saveBtn = document.getElementById('btn-save-product');
  const originalText = saveBtn.textContent;
  isSaving = true;
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';

  try {
    const resp = await adminFetch(url, { method, body: JSON.stringify(body) });
    const data = await resp.json();
    if (!resp.ok) {
      // 後端仍是最終驗證層：400／409 等錯誤直接顯示伺服器回傳的安全錯誤訊息，不自行改寫。
      showAdminToast(data.error || '儲存失敗', true);
      return;
    }
    showAdminToast('已儲存');
    formDirty = false;
    closeProductForm({ skipDirtyCheck: true });
    loadProducts();
  } catch (e) {
    showAdminToast('儲存失敗：' + e.message, true);
  } finally {
    isSaving = false;
    saveBtn.disabled = false;
    saveBtn.textContent = originalText;
  }
}
