// 楊竹科技後台系統 — 客戶管理頁面邏輯（唯讀第一階段：只讀取既有訂單彙總，不提供編輯／
// 刪除／合併／備註／標籤功能，這些留到下一階段）

const CUSTOMER_ORDER_STATUS_LABELS = {
  new_inquiry: '新詢價', quoted: '已報價', closed_won: '已成交',
  in_production: '生產中', qc: '品質檢查', ready_to_ship: '待出貨', shipped: '已出貨',
  completed: '已完成', cancelled: '已取消'
};

let customerListState = { page: 1, pageSize: 20, search: '', sortBy: 'lastOrderAt', tag: '', total: 0 };
let customerRequestSeq = 0;

// 前端不可以直接信任 API 回傳的數字型別（伺服器邏輯未來被改壞、或中間層被竄改都有可能），
// 顯示前一律先驗證「型別是 number 且是有限值」，不合法就一律用安全預設值，絕對不會把原始值
// 直接串進 innerHTML 樣板字串。
function safeCustomerNumber(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}
function fmtCustomerCount(value) {
  return safeCustomerNumber(value, 0).toLocaleString();
}
function fmtCustomerAmount(value) {
  return 'NT$ ' + safeCustomerNumber(value, 0).toLocaleString();
}
// 歷史訂單明細用：qty／amount 允許 null（代表「沒有資料」／「詢價中」），但非 null 時一樣要
// 驗證是合法有限數字，不合法一律顯示「--」，不可以直接呼叫 .toLocaleString()（非數字型別會
// 噴例外，或更危險地把未經檢查的原始值一路串進 innerHTML）。
function fmtCustomerQty(value) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value.toLocaleString() : '--';
}
function fmtCustomerOrderAmount(value, priceOnInquiry) {
  if (priceOnInquiry) return '報價中';
  return (typeof value === 'number' && Number.isFinite(value)) ? ('NT$ ' + value.toLocaleString()) : '--';
}

function onAdminReady() {
  loadCustomers();
  loadCustomerTagFilterOptions();
}

// ─── 標籤篩選（清單頁）：篩選選單失敗不影響清單本身載入，安靜略過即可 ──────────
async function loadCustomerTagFilterOptions() {
  try {
    const resp = await adminFetch('/api/admin/customer-tags');
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) return;
    const select = document.getElementById('customer-tag-filter-select');
    const current = select.value;
    select.innerHTML = ['<option value="">全部標籤</option>']
      .concat((data.tags || []).map(t => `<option value="${escAdminHtml(t.tag)}">${escAdminHtml(t.tag)}（${safeCustomerNumber(t.count, 0)}）</option>`))
      .join('');
    select.value = current; // 盡量保留使用者原本選取的篩選（如果選項還存在）
  } catch (e) { /* 安靜略過，不影響清單載入 */ }
}

function showCustomerListState(name) {
  ['loading', 'error', 'empty', 'wrap'].forEach(s => {
    const el = document.getElementById(`customer-list-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

// 用遞增序號處理「快速切換搜尋／排序時，較慢回應的舊請求不要覆蓋新畫面」（跟既有庫存異動
// 紀錄的寫法同一套慣例）。
async function loadCustomers() {
  customerRequestSeq++;
  const seq = customerRequestSeq;
  showCustomerListState('loading');

  const params = new URLSearchParams({
    page: String(customerListState.page),
    pageSize: String(customerListState.pageSize),
    sortBy: customerListState.sortBy
  });
  if (customerListState.search) params.set('search', customerListState.search);
  if (customerListState.tag) params.set('tag', customerListState.tag);

  try {
    const resp = await adminFetch('/api/admin/customers?' + params.toString());
    const data = await resp.json().catch(() => null);
    if (seq !== customerRequestSeq) return;
    if (!resp.ok) {
      document.getElementById('customer-list-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      showCustomerListState('error');
      return;
    }
    customerListState.total = data.total;

    if (!data.customers.length) {
      // 篩選條件變嚴格時，目前頁碼可能已經超出範圍（例如原本在第3頁，改用更嚴格的搜尋後
      // 只剩1頁資料）；先自動退回第1頁重新載入一次，而不是直接顯示「沒有資料」誤導使用者。
      if (customerListState.page > 1 && data.total > 0) {
        customerListState.page = 1;
        return loadCustomers();
      }
      showCustomerListState('empty');
      return;
    }

    renderCustomerList(data.customers);
    renderCustomerPagination();
    showCustomerListState('wrap');
  } catch (e) {
    if (seq !== customerRequestSeq) return;
    document.getElementById('customer-list-error-text').textContent = '讀取失敗：' + e.message;
    showCustomerListState('error');
  }
}

// 客戶清單是伺服器端分頁（一次最多100筆），畫面上看不到「目前篩選結果」的全部客戶，
// 所以匯出不能只送目前這一頁的資料——改成呼叫後端 /api/admin/customers/export，
// 帶上跟畫面一模一樣的搜尋／標籤／排序條件，由後端重新算出全部符合條件的客戶再產生Excel。
// isExportingCustomers旗標防止連續重複點擊。
let isExportingCustomers = false;
async function exportCustomersXlsx() {
  if (isExportingCustomers) return;
  const btn = document.getElementById('btn-export-customers-xlsx');
  const originalText = btn.textContent;
  isExportingCustomers = true;
  btn.disabled = true;
  btn.textContent = '匯出中…';
  try {
    const params = new URLSearchParams({ sortBy: customerListState.sortBy });
    if (customerListState.search) params.set('search', customerListState.search);
    if (customerListState.tag) params.set('tag', customerListState.tag);
    const resp = await adminFetch('/api/admin/customers/export?' + params.toString());
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      throw new Error((data && data.error) || '匯出失敗，請稍後再試');
    }
    await adminDownloadBlob(resp, `楊竹客戶_${new Date().toISOString().slice(0,10)}.xlsx`);
  } catch (e) {
    alert(e.message || '匯出失敗，請稍後再試');
  } finally {
    isExportingCustomers = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

function onCustomerSearchOrSortChanged() {
  customerListState.search = document.getElementById('customer-search-input').value.trim();
  customerListState.sortBy = document.getElementById('customer-sort-select').value;
  customerListState.tag = document.getElementById('customer-tag-filter-select').value;
  customerListState.page = 1;
  loadCustomers();
}

function renderCustomerList(list) {
  const tbody = document.getElementById('customer-list-body');
  tbody.innerHTML = list.map(c => `
    <tr>
      <td>${escAdminHtml(c.name || '--')}${safeCustomerNumber(c.mergedAliasCount, 0) > 0
        ? ` <span style="display:inline-block;background:var(--gray-100);border-radius:999px;padding:1px 7px;font-size:11px;color:var(--gray-400);">已合併${safeCustomerNumber(c.mergedAliasCount, 0)}筆</span>`
        : ''}</td>
      <td>${escAdminHtml(c.email || '--')}</td>
      <td>${escAdminHtml(c.phone || '--')}</td>
      <td>${fmtCustomerCount(c.orderCount)}</td>
      <td>${fmtCustomerAmount(c.totalSpent)}</td>
      <td>${fmtCustomerTime(c.lastOrderAt)}</td>
      <td><button class="btn btn-secondary btn-sm" data-customer-id="${escAdminHtml(c.customerId)}" onclick="openCustomerDetail(this.dataset.customerId)">查看詳情</button></td>
    </tr>
  `).join('');
}

function renderCustomerPagination() {
  const totalPages = Math.max(1, Math.ceil(customerListState.total / customerListState.pageSize));
  const el = document.getElementById('customer-pagination');
  el.innerHTML = `
    <span style="font-size:13px;color:var(--gray-400);">共 ${customerListState.total.toLocaleString()} 筆，第 ${customerListState.page} / ${totalPages} 頁</span>
    <button class="btn btn-secondary btn-sm" id="customer-prev-btn" ${customerListState.page <= 1 ? 'disabled' : ''} onclick="changeCustomerPage(-1)">上一頁</button>
    <button class="btn btn-secondary btn-sm" id="customer-next-btn" ${customerListState.page >= totalPages ? 'disabled' : ''} onclick="changeCustomerPage(1)">下一頁</button>
  `;
}

function changeCustomerPage(delta) {
  const totalPages = Math.max(1, Math.ceil(customerListState.total / customerListState.pageSize));
  const next = customerListState.page + delta;
  if (next < 1 || next > totalPages) return;
  customerListState.page = next;
  loadCustomers();
}

// 空值／不合法的時間字串一律顯示「--」，不可以顯示 new Date(undefined) 產生的「Invalid Date」
// 字樣（沿用既有 admin.html 的 fmtTime() 同一套安全處理方式）。
function fmtCustomerTime(iso) {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString('zh-TW', { hour12: false });
}

// ─── 客戶詳情：第二階段新增「編輯基本資料」與「新增內部備註」，仍不提供刪除／合併／
// 標籤／公司資料／收件資料功能 ──────────────────────────────────────────
let currentCustomerDetailId = null;
let currentCustomerDetailData = null; // 最近一次成功載入的客戶物件，供編輯表單預填
let currentCustomerCompanyData = null; // 最近一次成功載入的公司資料，供編輯表單預填
let currentCustomerAddresses = []; // 最近一次成功載入的收件地址清單，供編輯表單依id查找預填

function showCustomerDetailState(name) {
  ['loading', 'error', 'content'].forEach(s => {
    const el = document.getElementById(`customer-detail-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  });
}

function openCustomerDetail(customerId) {
  currentCustomerDetailId = customerId;
  currentCustomerDetailData = null;
  currentCustomerCompanyData = null;
  currentCustomerAddresses = [];
  toggleCustomerEditForm(false);
  toggleCustomerCompanyForm(false);
  closeCustomerAddressForm();
  document.getElementById('customer-merge-status-wrap').classList.add('hidden');
  document.getElementById('customer-detail-overlay').classList.remove('hidden');
  loadCustomerDetail(customerId);
  loadCustomerNotes(customerId);
}

function closeCustomerDetail() {
  document.getElementById('customer-detail-overlay').classList.add('hidden');
  currentCustomerDetailId = null;
  currentCustomerDetailData = null;
  currentCustomerCompanyData = null;
  currentCustomerAddresses = [];
  toggleCustomerEditForm(false);
  toggleCustomerCompanyForm(false);
  closeCustomerAddressForm();
}

function retryCustomerDetail() {
  if (currentCustomerDetailId) {
    loadCustomerDetail(currentCustomerDetailId);
    loadCustomerNotes(currentCustomerDetailId);
  }
}

async function loadCustomerDetail(customerId) {
  showCustomerDetailState('loading');
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(customerId)}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      document.getElementById('customer-detail-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      showCustomerDetailState('error');
      return;
    }
    // 如果查詢用的是舊 customerId（已經被合併），API 會自動導向主要客戶：把目前操作中的
    // customerId 同步更新成主要客戶，之後編輯／新增動作才會落在正確的一方（其實後端本身
    // 對任何 customerId 都會自動解析，這裡同步只是讓前端狀態跟畫面顯示一致）。
    currentCustomerDetailId = data.customer.customerId;
    currentCustomerDetailData = data.customer;
    currentCustomerCompanyData = data.company || null;
    currentCustomerAddresses = data.addresses || [];
    renderCustomerDetail(data.customer, data.orders);
    renderCustomerCompanySummary(data.company);
    renderCustomerTags(data.tags || []);
    renderCustomerAddresses(currentCustomerAddresses);
    renderCustomerMergeStatus(data.customer.customerId, data.mergedFrom || []);
    if (data.redirectFrom) {
      showAdminToast('這位客戶已合併，已自動導向主要客戶');
    }
    showCustomerDetailState('content');
  } catch (e) {
    document.getElementById('customer-detail-error-text').textContent = '讀取失敗：' + e.message;
    showCustomerDetailState('error');
  }
}

// ─── 編輯基本資料：儲存後立即更新詳情畫面與清單，覆蓋值只影響後台顯示，不會回寫任何訂單 ──
function toggleCustomerEditForm(show) {
  const form = document.getElementById('customer-edit-form');
  const shouldShow = (show === undefined) ? form.classList.contains('hidden') : !!show;
  form.classList.toggle('hidden', !shouldShow);
  document.getElementById('customer-edit-error').classList.add('hidden');
  if (shouldShow && currentCustomerDetailData) {
    document.getElementById('customer-edit-name').value = currentCustomerDetailData.name || '';
    document.getElementById('customer-edit-email').value = currentCustomerDetailData.email || '';
    document.getElementById('customer-edit-phone').value = currentCustomerDetailData.phone || '';
  }
}

async function saveCustomerProfile() {
  if (!currentCustomerDetailId) return;
  const errEl = document.getElementById('customer-edit-error');
  errEl.classList.add('hidden');
  const saveBtn = document.getElementById('customer-edit-save-btn');
  const body = {
    name: document.getElementById('customer-edit-name').value,
    email: document.getElementById('customer-edit-email').value,
    phone: document.getElementById('customer-edit-phone').value
  };
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/profile`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl.textContent = (data && data.error) || '儲存失敗，請稍後再試';
      errEl.classList.remove('hidden');
      return;
    }
    currentCustomerDetailData = data.customer;
    document.getElementById('customer-detail-title').textContent = data.customer.name || '（未填寫姓名）';
    document.getElementById('customer-detail-summary').textContent = buildCustomerSummaryText(data.customer);
    toggleCustomerEditForm(false);
    showAdminToast('客戶基本資料已更新');
    loadCustomers(); // 讓清單同步顯示最新的姓名／Email／電話
  } catch (e) {
    errEl.textContent = '儲存失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '儲存';
  }
}

function buildCustomerSummaryText(customer) {
  return `Email：${customer.email || '--'}　電話：${customer.phone || '--'}　訂單數：${fmtCustomerCount(customer.orderCount)}　` +
    `累計金額：${fmtCustomerAmount(customer.totalSpent)}　最後下單：${fmtCustomerTime(customer.lastOrderAt)}`;
}

// ─── 內部備註：只能新增，不提供修改或刪除舊備註 ──────────────────────────
async function loadCustomerNotes(customerId) {
  const loadingEl = document.getElementById('customer-notes-loading');
  const emptyEl = document.getElementById('customer-notes-empty');
  const listEl = document.getElementById('customer-notes-list');
  loadingEl.classList.remove('hidden');
  emptyEl.classList.add('hidden');
  listEl.innerHTML = '';
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(customerId)}/notes`);
    const data = await resp.json().catch(() => null);
    loadingEl.classList.add('hidden');
    if (!resp.ok) {
      emptyEl.textContent = (data && data.error) || '備註讀取失敗';
      emptyEl.classList.remove('hidden');
      return;
    }
    renderCustomerNotes(data.notes || []);
  } catch (e) {
    loadingEl.classList.add('hidden');
    emptyEl.textContent = '備註讀取失敗：' + e.message;
    emptyEl.classList.remove('hidden');
  }
}

function renderCustomerNotes(notes) {
  const emptyEl = document.getElementById('customer-notes-empty');
  const listEl = document.getElementById('customer-notes-list');
  if (!notes.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  // content／actor 一律用 escAdminHtml() 跳脫，惡意 HTML 只會顯示為純文字，不會產生真正標籤。
  listEl.innerHTML = notes.map(n => `
    <li style="border:1px solid var(--gray-200);border-radius:var(--radius-sm);padding:8px 10px;">
      <div style="font-size:13px;white-space:pre-wrap;word-break:break-word;">${escAdminHtml(n.content)}</div>
      <div style="font-size:12px;color:var(--gray-400);margin-top:4px;">${escAdminHtml(n.actor)}　${fmtCustomerTime(n.createdAt)}</div>
    </li>
  `).join('');
}

async function addCustomerNote() {
  if (!currentCustomerDetailId) return;
  const input = document.getElementById('customer-note-input');
  const errEl = document.getElementById('customer-note-error');
  errEl.classList.add('hidden');
  const content = input.value;
  if (!content.trim()) {
    errEl.textContent = '請先輸入備註內容';
    errEl.classList.remove('hidden');
    return;
  }
  const saveBtn = document.getElementById('customer-note-save-btn');
  saveBtn.disabled = true;
  saveBtn.textContent = '新增中…';
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/notes`, {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl.textContent = (data && data.error) || '新增備註失敗，請稍後再試';
      errEl.classList.remove('hidden');
      return;
    }
    input.value = '';
    showAdminToast('備註已新增');
    loadCustomerNotes(currentCustomerDetailId);
  } catch (e) {
    errEl.textContent = '新增備註失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = '新增備註';
  }
}

function renderCustomerDetail(customer, orders) {
  document.getElementById('customer-detail-title').textContent = customer.name || '（未填寫姓名）';
  document.getElementById('customer-detail-summary').textContent = buildCustomerSummaryText(customer);

  const tbody = document.getElementById('customer-detail-orders-body');
  if (!orders.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--gray-400);padding:20px;">沒有歷史訂單</td></tr>`;
    return;
  }
  // 歷史訂單連到既有訂單管理頁（/admin?order=訂單編號），該頁面會自動找到並開啟對應的
  // 訂單詳情面板（含已封存訂單，會自動切到已封存頁籤）；用新分頁開啟，不影響目前客戶詳情。
  tbody.innerHTML = orders.map(o => `
    <tr>
      <td><a href="/admin?order=${encodeURIComponent(o.orderId)}" target="_blank" rel="noopener">${escAdminHtml(o.friendlyOrderNo)}</a></td>
      <td>${fmtCustomerTime(o.savedAt)}</td>
      <td>${escAdminHtml(o.productName)}</td>
      <td>${fmtCustomerQty(o.qty)}</td>
      <td>${escAdminHtml(CUSTOMER_ORDER_STATUS_LABELS[o.status] || o.status)}</td>
      <td>${fmtCustomerOrderAmount(o.amount, o.priceOnInquiry)}</td>
      <td>${o.archived ? '已封存' : '--'}</td>
    </tr>
  `).join('');
}

// ─── 公司資料：1:1覆蓋層，不回寫訂單 ────────────────────────────────────
function renderCustomerCompanySummary(company) {
  const el = document.getElementById('customer-company-summary');
  const hasAny = company && (company.companyName || company.taxId || company.invoiceTitle);
  if (!hasAny) {
    el.textContent = '尚未填寫公司資料';
    return;
  }
  el.textContent = `公司名稱：${company.companyName || '--'}　統一編號：${company.taxId || '--'}　發票抬頭：${company.invoiceTitle || '--'}`;
}

function toggleCustomerCompanyForm(show) {
  const form = document.getElementById('customer-company-form');
  const shouldShow = (show === undefined) ? form.classList.contains('hidden') : !!show;
  form.classList.toggle('hidden', !shouldShow);
  document.getElementById('customer-company-error').classList.add('hidden');
  if (shouldShow) {
    const c = currentCustomerCompanyData || {};
    document.getElementById('customer-company-name').value = c.companyName || '';
    document.getElementById('customer-company-taxid').value = c.taxId || '';
    document.getElementById('customer-company-invoice').value = c.invoiceTitle || '';
  }
}

let customerCompanySaveInFlight = false;
async function saveCustomerCompany() {
  if (!currentCustomerDetailId || customerCompanySaveInFlight) return;
  const errEl = document.getElementById('customer-company-error');
  errEl.classList.add('hidden');
  const saveBtn = document.getElementById('customer-company-save-btn');
  const body = {
    companyName: document.getElementById('customer-company-name').value,
    taxId: document.getElementById('customer-company-taxid').value,
    invoiceTitle: document.getElementById('customer-company-invoice').value
  };
  customerCompanySaveInFlight = true;
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/company`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl.textContent = (data && data.error) || '儲存失敗，請稍後再試';
      errEl.classList.remove('hidden');
      return;
    }
    currentCustomerCompanyData = data.company;
    renderCustomerCompanySummary(data.company);
    toggleCustomerCompanyForm(false);
    showAdminToast('公司資料已更新');
  } catch (e) {
    errEl.textContent = '儲存失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    customerCompanySaveInFlight = false;
    saveBtn.disabled = false;
    saveBtn.textContent = '儲存';
  }
}

// ─── 客戶標籤：只能新增／移除，不提供修改標籤文字的操作 ──────────────────
function renderCustomerTags(tags) {
  const el = document.getElementById('customer-tags-list');
  if (!tags.length) {
    el.innerHTML = `<span style="font-size:13px;color:var(--gray-400);">尚未加入標籤</span>`;
    return;
  }
  // 標籤文字一律用 escAdminHtml() 跳脫，惡意 HTML 只會顯示為純文字，不會產生真正標籤或事件。
  el.innerHTML = tags.map(t => `
    <span style="display:inline-flex;align-items:center;gap:4px;background:var(--gray-100);border-radius:999px;padding:3px 10px;font-size:12px;">
      ${escAdminHtml(t.tag)}
      <button type="button" data-tag-id="${t.id}" onclick="removeCustomerTag(this.dataset.tagId)"
        style="border:none;background:none;cursor:pointer;color:var(--gray-400);font-size:14px;line-height:1;padding:0;" title="移除標籤">×</button>
    </span>
  `).join('');
}

let customerTagAddInFlight = false;
async function addCustomerTag() {
  if (!currentCustomerDetailId || customerTagAddInFlight) return;
  const input = document.getElementById('customer-tag-input');
  const errEl = document.getElementById('customer-tag-error');
  errEl.classList.add('hidden');
  const tag = input.value;
  if (!tag.trim()) {
    errEl.textContent = '請先輸入標籤內容';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('customer-tag-add-btn');
  customerTagAddInFlight = true;
  btn.disabled = true;
  btn.textContent = '新增中…';
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/tags`, {
      method: 'POST',
      body: JSON.stringify({ tag })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl.textContent = (data && data.error) || '新增標籤失敗，請稍後再試';
      errEl.classList.remove('hidden');
      return;
    }
    input.value = '';
    renderCustomerTags(data.tags || []);
    loadCustomerTagFilterOptions();
    showAdminToast('標籤已新增');
  } catch (e) {
    errEl.textContent = '新增標籤失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    customerTagAddInFlight = false;
    btn.disabled = false;
    btn.textContent = '新增標籤';
  }
}

let customerTagRemoveInFlight = false;
async function removeCustomerTag(tagId) {
  if (!currentCustomerDetailId || customerTagRemoveInFlight) return;
  customerTagRemoveInFlight = true;
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/tags/${encodeURIComponent(tagId)}`, {
      method: 'DELETE'
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showAdminToast((data && data.error) || '移除標籤失敗，請稍後再試', true);
      return;
    }
    renderCustomerTags(data.tags || []);
    loadCustomerTagFilterOptions();
    showAdminToast('標籤已移除');
  } catch (e) {
    showAdminToast('移除標籤失敗：' + e.message, true);
  } finally {
    customerTagRemoveInFlight = false;
  }
}

// ─── 收件地址：可多筆，任何時間最多一筆預設（切換預設由後端 transaction 保證） ──────
function renderCustomerAddresses(addresses) {
  const listEl = document.getElementById('customer-addresses-list');
  const emptyEl = document.getElementById('customer-addresses-empty');
  if (!addresses.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  // 收件人／電話／郵遞區號／地址皆一律用 escAdminHtml() 跳脫，惡意 HTML 只會顯示為純文字。
  listEl.innerHTML = addresses.map(a => `
    <div style="border:1px solid var(--gray-200);border-radius:var(--radius-sm);padding:10px 12px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div style="font-size:13px;line-height:1.7;">
        ${a.isDefault ? '<span style="display:inline-block;background:#2D7D46;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;margin-right:6px;">預設</span>' : ''}
        <strong>${escAdminHtml(a.recipientName)}</strong>　${escAdminHtml(a.phone || '--')}<br>
        （${escAdminHtml(a.postalCode || '--')}）${escAdminHtml(a.address)}
      </div>
      <div style="display:flex;gap:6px;align-items:flex-start;flex-wrap:wrap;">
        ${a.isDefault ? '' : `<button type="button" class="btn btn-secondary btn-sm" data-address-id="${a.id}" onclick="setCustomerAddressDefault(this.dataset.addressId)">設為預設</button>`}
        <button type="button" class="btn btn-secondary btn-sm" data-address-id="${a.id}" onclick="editCustomerAddress(this.dataset.addressId)">編輯</button>
        <button type="button" class="btn btn-secondary btn-sm" data-address-id="${a.id}" onclick="deleteCustomerAddress(this.dataset.addressId)">刪除</button>
      </div>
    </div>
  `).join('');
}

function openCustomerAddressForm() {
  document.getElementById('customer-address-editing-id').value = '';
  document.getElementById('customer-address-recipient').value = '';
  document.getElementById('customer-address-phone').value = '';
  document.getElementById('customer-address-postal').value = '';
  document.getElementById('customer-address-address').value = '';
  document.getElementById('customer-address-default').checked = false;
  document.getElementById('customer-address-error').classList.add('hidden');
  document.getElementById('customer-address-form').classList.remove('hidden');
}

function editCustomerAddress(addressId) {
  const a = currentCustomerAddresses.find(x => String(x.id) === String(addressId));
  if (!a) return;
  document.getElementById('customer-address-editing-id').value = String(a.id);
  document.getElementById('customer-address-recipient').value = a.recipientName || '';
  document.getElementById('customer-address-phone').value = a.phone || '';
  document.getElementById('customer-address-postal').value = a.postalCode || '';
  document.getElementById('customer-address-address').value = a.address || '';
  document.getElementById('customer-address-default').checked = !!a.isDefault;
  document.getElementById('customer-address-error').classList.add('hidden');
  document.getElementById('customer-address-form').classList.remove('hidden');
}

function closeCustomerAddressForm() {
  const form = document.getElementById('customer-address-form');
  if (form) form.classList.add('hidden');
}

let customerAddressSaveInFlight = false;
async function saveCustomerAddress() {
  if (!currentCustomerDetailId || customerAddressSaveInFlight) return;
  const errEl = document.getElementById('customer-address-error');
  errEl.classList.add('hidden');
  const editingId = document.getElementById('customer-address-editing-id').value;
  const body = {
    recipientName: document.getElementById('customer-address-recipient').value,
    phone: document.getElementById('customer-address-phone').value,
    postalCode: document.getElementById('customer-address-postal').value,
    address: document.getElementById('customer-address-address').value,
    isDefault: document.getElementById('customer-address-default').checked
  };
  const saveBtn = document.getElementById('customer-address-save-btn');
  customerAddressSaveInFlight = true;
  saveBtn.disabled = true;
  saveBtn.textContent = '儲存中…';
  try {
    const url = editingId
      ? `/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/addresses/${encodeURIComponent(editingId)}`
      : `/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/addresses`;
    const resp = await adminFetch(url, { method: editingId ? 'PUT' : 'POST', body: JSON.stringify(body) });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl.textContent = (data && data.error) || '儲存失敗，請稍後再試';
      errEl.classList.remove('hidden');
      return;
    }
    currentCustomerAddresses = data.addresses || [];
    renderCustomerAddresses(currentCustomerAddresses);
    closeCustomerAddressForm();
    showAdminToast(editingId ? '地址已更新' : '地址已新增');
  } catch (e) {
    errEl.textContent = '儲存失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    customerAddressSaveInFlight = false;
    saveBtn.disabled = false;
    saveBtn.textContent = '儲存';
  }
}

let customerAddressActionInFlight = false;
async function setCustomerAddressDefault(addressId) {
  if (!currentCustomerDetailId || customerAddressActionInFlight) return;
  customerAddressActionInFlight = true;
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/addresses/${encodeURIComponent(addressId)}`, {
      method: 'PUT',
      body: JSON.stringify({ isDefault: true })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showAdminToast((data && data.error) || '設定預設地址失敗，請稍後再試', true);
      return;
    }
    currentCustomerAddresses = data.addresses || [];
    renderCustomerAddresses(currentCustomerAddresses);
    showAdminToast('已設為預設地址');
  } catch (e) {
    showAdminToast('設定預設地址失敗：' + e.message, true);
  } finally {
    customerAddressActionInFlight = false;
  }
}

// 刪除地址前一律要求二次確認，避免誤刪。
async function deleteCustomerAddress(addressId) {
  if (!currentCustomerDetailId || customerAddressActionInFlight) return;
  const { confirmed } = await adminConfirmDialog({
    title: '確認刪除地址',
    message: '確定要刪除這筆收件地址嗎？此操作無法復原。',
    danger: true,
    confirmLabel: '確認刪除'
  });
  if (!confirmed) return;
  customerAddressActionInFlight = true;
  try {
    const resp = await adminFetch(`/api/admin/customers/${encodeURIComponent(currentCustomerDetailId)}/addresses/${encodeURIComponent(addressId)}`, {
      method: 'DELETE'
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showAdminToast((data && data.error) || '刪除地址失敗，請稍後再試', true);
      return;
    }
    currentCustomerAddresses = data.addresses || [];
    renderCustomerAddresses(currentCustomerAddresses);
    closeCustomerAddressForm();
    showAdminToast('地址已刪除');
  } catch (e) {
    showAdminToast('刪除地址失敗：' + e.message, true);
  } finally {
    customerAddressActionInFlight = false;
  }
}

// ─── 重複客戶合併：偵測候選、預覽比較、二次確認、執行合併、解除合併 ───────────────
// 只做偵測與提示，實際合併一律由管理員在合併確認視窗手動選擇主要客戶並勾選二次確認，
// 絕不自動合併；合併／解除合併都不會搬動或刪除任何一邊原本的訂單、備註、公司資料、
// 地址或標籤，全部原樣留在各自的 customerId 底下。
let customerMergeCandidates = [];
let customerMergePreviewPrimaryId = null;
let customerMergePreviewMergedId = null;
let customerMergeExecuteInFlight = false;
let customerMergeUnmergeInFlight = false;

function openCustomerMergeCandidates() {
  document.getElementById('customer-merge-candidates-overlay').classList.remove('hidden');
  loadCustomerMergeCandidates();
}
function closeCustomerMergeCandidates() {
  document.getElementById('customer-merge-candidates-overlay').classList.add('hidden');
}

async function loadCustomerMergeCandidates() {
  const loadingEl = document.getElementById('customer-merge-candidates-loading');
  const errorEl = document.getElementById('customer-merge-candidates-error');
  const emptyEl = document.getElementById('customer-merge-candidates-empty');
  const listEl = document.getElementById('customer-merge-candidates-list');
  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  emptyEl.classList.add('hidden');
  listEl.innerHTML = '';
  try {
    const resp = await adminFetch('/api/admin/customer-merge-candidates');
    const data = await resp.json().catch(() => null);
    loadingEl.classList.add('hidden');
    if (!resp.ok) {
      document.getElementById('customer-merge-candidates-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      errorEl.classList.remove('hidden');
      return;
    }
    customerMergeCandidates = data.candidates || [];
    if (!customerMergeCandidates.length) {
      emptyEl.classList.remove('hidden');
      return;
    }
    renderCustomerMergeCandidates(customerMergeCandidates);
  } catch (e) {
    loadingEl.classList.add('hidden');
    document.getElementById('customer-merge-candidates-error-text').textContent = '讀取失敗：' + e.message;
    errorEl.classList.remove('hidden');
  }
}

const CUSTOMER_MERGE_REASON_LABELS = {
  email_exact: 'Email 完全相同',
  phone_exact: '電話正規化後相同',
  name_and_similar_email: '姓名相同、Email 高度接近',
  name_and_similar_phone: '姓名相同、電話高度接近'
};

function renderCustomerMergeCandidates(candidates) {
  const listEl = document.getElementById('customer-merge-candidates-list');
  // 姓名／Email／電話一律用 escAdminHtml() 跳脫，惡意 HTML 只會顯示為純文字。
  listEl.innerHTML = candidates.map((c, idx) => `
    <div style="border:1px solid var(--gray-200);border-radius:var(--radius-sm);padding:12px 14px;">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
        ${c.reasons.map(r => `<span style="background:var(--gray-100);border-radius:999px;padding:2px 8px;font-size:11px;">${escAdminHtml(CUSTOMER_MERGE_REASON_LABELS[r] || r)}</span>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;line-height:1.7;">
        <div>
          <strong>${escAdminHtml(c.customerA.name || '（未填寫姓名）')}</strong><br>
          Email：${escAdminHtml(c.customerA.email || '--')}　電話：${escAdminHtml(c.customerA.phone || '--')}<br>
          訂單數：${fmtCustomerCount(c.customerA.orderCount)}　累計金額：${fmtCustomerAmount(c.customerA.totalSpent)}
        </div>
        <div>
          <strong>${escAdminHtml(c.customerB.name || '（未填寫姓名）')}</strong><br>
          Email：${escAdminHtml(c.customerB.email || '--')}　電話：${escAdminHtml(c.customerB.phone || '--')}<br>
          訂單數：${fmtCustomerCount(c.customerB.orderCount)}　累計金額：${fmtCustomerAmount(c.customerB.totalSpent)}
        </div>
      </div>
      <div style="margin-top:8px;">
        <button type="button" class="btn btn-primary btn-sm" data-idx="${idx}" onclick="openCustomerMergePreviewFromCandidate(this.dataset.idx)">檢視並合併</button>
      </div>
    </div>
  `).join('');
}

function openCustomerMergePreviewFromCandidate(idx) {
  const c = customerMergeCandidates[Number(idx)];
  if (!c) return;
  // 預設以訂單數較多的一方作為主要客戶，管理員仍可在下一步的比較畫面手動切換。
  const primaryFirst = (c.customerA.orderCount || 0) >= (c.customerB.orderCount || 0);
  openCustomerMergePreview(
    primaryFirst ? c.customerA.customerId : c.customerB.customerId,
    primaryFirst ? c.customerB.customerId : c.customerA.customerId
  );
}

function openCustomerMergePreview(primaryId, mergedId) {
  customerMergePreviewPrimaryId = primaryId;
  customerMergePreviewMergedId = mergedId;
  document.getElementById('customer-merge-ack-checkbox').checked = false;
  document.getElementById('customer-merge-confirm-error').classList.add('hidden');
  document.getElementById('customer-merge-preview-overlay').classList.remove('hidden');
  loadCustomerMergePreview();
}

function closeCustomerMergePreview() {
  document.getElementById('customer-merge-preview-overlay').classList.add('hidden');
  customerMergePreviewPrimaryId = null;
  customerMergePreviewMergedId = null;
}

function switchCustomerMergePrimary(newPrimaryId) {
  if (!customerMergePreviewPrimaryId || !customerMergePreviewMergedId) return;
  if (newPrimaryId === customerMergePreviewPrimaryId) return;
  const oldPrimary = customerMergePreviewPrimaryId;
  customerMergePreviewPrimaryId = customerMergePreviewMergedId;
  customerMergePreviewMergedId = oldPrimary;
  loadCustomerMergePreview();
}

async function loadCustomerMergePreview() {
  const loadingEl = document.getElementById('customer-merge-preview-loading');
  const errorEl = document.getElementById('customer-merge-preview-error');
  const contentEl = document.getElementById('customer-merge-preview-content');
  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  contentEl.classList.add('hidden');
  try {
    const params = new URLSearchParams({ primaryId: customerMergePreviewPrimaryId, mergedId: customerMergePreviewMergedId });
    const resp = await adminFetch('/api/admin/customer-merge-preview?' + params.toString());
    const data = await resp.json().catch(() => null);
    loadingEl.classList.add('hidden');
    if (!resp.ok) {
      document.getElementById('customer-merge-preview-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      errorEl.classList.remove('hidden');
      return;
    }
    if (!data.valid) {
      document.getElementById('customer-merge-preview-error-text').textContent = data.reason || '這個合併組合目前無效';
      errorEl.classList.remove('hidden');
      return;
    }
    renderCustomerMergePreview(data);
    contentEl.classList.remove('hidden');
  } catch (e) {
    loadingEl.classList.add('hidden');
    document.getElementById('customer-merge-preview-error-text').textContent = '讀取失敗：' + e.message;
    errorEl.classList.remove('hidden');
  }
}

function renderCustomerMergePreview(data) {
  const primary = data.primary.customer;
  const merged = data.merged.customer;
  const choiceEl = document.getElementById('customer-merge-primary-choice');
  // name／email 一律用 escAdminHtml() 跳脫；customerId 本身是雜湊字串（不含使用者輸入），
  // 直接放進 value 屬性安全無虞。
  choiceEl.innerHTML = [primary, merged].map(c => `
    <label style="font-size:13px;display:flex;align-items:center;gap:6px;">
      <input type="radio" name="customer-merge-primary-radio" value="${escAdminHtml(c.customerId)}"
        ${c.customerId === customerMergePreviewPrimaryId ? 'checked' : ''}
        onchange="switchCustomerMergePrimary('${c.customerId}')">
      ${escAdminHtml(c.name || '（未填寫姓名）')}（${escAdminHtml(c.email || '--')}）作為主要客戶
    </label>
  `).join('');

  const row = (label, a, b) => `<tr><td style="white-space:nowrap;color:var(--gray-400);">${escAdminHtml(label)}</td><td>${a}</td><td>${b}</td></tr>`;
  const fmtTags = tags => (tags && tags.length) ? tags.map(t => escAdminHtml(t.tag)).join('、') : '--';
  const fmtAddrs = addrs => (addrs && addrs.length)
    ? addrs.map(a => `${a.isDefault ? '[預設] ' : ''}${escAdminHtml(a.recipientName)}／${escAdminHtml(a.address)}`).join('<br>')
    : '--';
  const fmtNotes = notes => (notes && notes.length) ? notes.length + ' 則' : '0 則';
  const fmtCompany = c => (c && (c.companyName || c.taxId || c.invoiceTitle))
    ? `${escAdminHtml(c.companyName || '--')}／${escAdminHtml(c.taxId || '--')}`
    : '--';

  document.getElementById('customer-merge-compare-wrap').innerHTML = `
    <table class="admin-table">
      <thead><tr><th>比較項目</th><th>主要客戶（保留）</th><th>被合併客戶（併入）</th></tr></thead>
      <tbody>
        ${row('姓名', escAdminHtml(primary.name || '--'), escAdminHtml(merged.name || '--'))}
        ${row('Email', escAdminHtml(primary.email || '--'), escAdminHtml(merged.email || '--'))}
        ${row('電話', escAdminHtml(primary.phone || '--'), escAdminHtml(merged.phone || '--'))}
        ${row('訂單數', fmtCustomerCount(primary.orderCount), fmtCustomerCount(merged.orderCount))}
        ${row('累計金額', fmtCustomerAmount(primary.totalSpent), fmtCustomerAmount(merged.totalSpent))}
        ${row('公司資料', fmtCompany(data.primary.company), fmtCompany(data.merged.company))}
        ${row('收件地址', fmtAddrs(data.primary.addresses), fmtAddrs(data.merged.addresses))}
        ${row('客戶標籤', fmtTags(data.primary.tags), fmtTags(data.merged.tags))}
        ${row('內部備註', fmtNotes(data.primary.notes), fmtNotes(data.merged.notes))}
      </tbody>
    </table>
  `;
}

async function executeCustomerMerge() {
  if (customerMergeExecuteInFlight) return;
  if (!customerMergePreviewPrimaryId || !customerMergePreviewMergedId) return;
  const errEl = document.getElementById('customer-merge-confirm-error');
  errEl.classList.add('hidden');
  if (!document.getElementById('customer-merge-ack-checkbox').checked) {
    errEl.textContent = '請先勾選確認，再執行合併';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = document.getElementById('customer-merge-confirm-btn');
  customerMergeExecuteInFlight = true;
  btn.disabled = true;
  btn.textContent = '合併中…';
  try {
    const resp = await adminFetch('/api/admin/customer-merges', {
      method: 'POST',
      body: JSON.stringify({
        primaryCustomerId: customerMergePreviewPrimaryId,
        mergedCustomerId: customerMergePreviewMergedId,
        acknowledged: true
      })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      errEl.textContent = (data && data.error) || '合併失敗，請稍後再試';
      errEl.classList.remove('hidden');
      return;
    }
    const mergedPrimaryId = data.primaryCustomerId;
    showAdminToast('客戶合併完成');
    closeCustomerMergePreview();
    closeCustomerMergeCandidates();
    loadCustomers();
    if (currentCustomerDetailId) {
      openCustomerDetail(mergedPrimaryId);
    }
  } catch (e) {
    errEl.textContent = '合併失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    customerMergeExecuteInFlight = false;
    btn.disabled = false;
    btn.textContent = '確認合併';
  }
}

// ─── 客戶詳情內的合併狀態：顯示目前併入這位主要客戶的舊客戶，並可個別解除合併 ───────
async function renderCustomerMergeStatus(customerId, mergedFrom) {
  const wrap = document.getElementById('customer-merge-status-wrap');
  const listEl = document.getElementById('customer-merge-status-list');
  if (!mergedFrom || !mergedFrom.length) {
    wrap.classList.add('hidden');
    listEl.innerHTML = '';
    return;
  }
  wrap.classList.remove('hidden');
  listEl.innerHTML = '<p style="font-size:13px;color:var(--gray-400);margin:0;">載入合併紀錄中…</p>';
  try {
    const resp = await adminFetch('/api/admin/customer-merges');
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      listEl.innerHTML = '<p style="font-size:13px;color:var(--gray-400);margin:0;">合併紀錄讀取失敗</p>';
      return;
    }
    const activeRows = (data.merges || []).filter(m => m.active && m.primaryCustomerId === customerId);
    // aliasId 本身是雜湊字串（不含使用者輸入），只取前段顯示方便辨識，仍用 escAdminHtml() 跳脫。
    listEl.innerHTML = mergedFrom.map(aliasId => {
      const row = activeRows.find(m => m.aliasCustomerId === aliasId);
      return `
        <div style="font-size:13px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <span>已併入舊客戶（${escAdminHtml(aliasId.slice(0, 12))}…）</span>
          ${row ? `<button type="button" class="btn btn-secondary btn-sm" data-merge-id="${row.id}" onclick="unmergeCustomer(this.dataset.mergeId)">解除合併</button>` : ''}
        </div>
      `;
    }).join('');
  } catch (e) {
    listEl.innerHTML = '<p style="font-size:13px;color:var(--gray-400);margin:0;">合併紀錄讀取失敗：' + escAdminHtml(e.message) + '</p>';
  }
}

// 解除合併前一律要求二次確認，避免誤觸。
async function unmergeCustomer(mergeId) {
  if (customerMergeUnmergeInFlight) return;
  const { confirmed } = await adminConfirmDialog({
    title: '確認解除合併',
    message: '確定要解除這筆合併嗎？被合併客戶會恢復成獨立客戶顯示（雙方原始資料完全不會遺失）。',
    confirmLabel: '確認解除'
  });
  if (!confirmed) return;
  customerMergeUnmergeInFlight = true;
  try {
    const resp = await adminFetch(`/api/admin/customer-merges/${encodeURIComponent(mergeId)}/unmerge`, { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showAdminToast((data && data.error) || '解除合併失敗，請稍後再試', true);
      return;
    }
    showAdminToast('已解除合併');
    loadCustomers();
    if (currentCustomerDetailId) loadCustomerDetail(currentCustomerDetailId);
  } catch (e) {
    showAdminToast('解除合併失敗：' + e.message, true);
  } finally {
    customerMergeUnmergeInFlight = false;
  }
}
