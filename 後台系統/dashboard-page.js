// 楊竹科技後台系統 — 儀表板頁面邏輯
let currentMovementProductId = null;

// ── 粒度切換（每天／每月／每季／每年）：2026-08-19新增，取代原本寫死「今日／本月」＋固定
// 30天趨勢的版本。currentDashboardGranularity 是唯一的狀態來源，切換選單、重新整理、匯出
// 都讀這個變數，跟後端 admin-routes.js 的 GRANULARITY_VALUES／GRANULARITY_TREND_COUNT
// 必須保持同一份對照（否則畫面顯示的粒度跟實際查詢的粒度會對不上）。
const DASHBOARD_GRANULARITY_VALUES = ['day', 'month', 'quarter', 'year'];
const DASHBOARD_TREND_COUNT = { day: 30, month: 12, quarter: 8, year: 5 };
const DASHBOARD_TREND_HEADING = {
  day: '最近 30 天營收趨勢', month: '最近 12 個月營收趨勢', quarter: '最近 8 季營收趨勢', year: '最近 5 年營收趨勢'
};
const DASHBOARD_GRANULARITY_TEXT = { day: '每天', month: '每月', quarter: '每季', year: '每年' };
let currentDashboardGranularity = 'day';
let lastDashboardData = null; // 最近一次成功載入的完整回應，供匯出Excel使用

// 不可以直接信任 API 回傳的數字型別就呼叫 .toLocaleString()——非數字型別（例如惡意字串）
// 一路串進 innerHTML 樣板字串會造成 XSS；顯示前一律先驗證是合法有限數字，不合法用安全預設值。
function safeDashNumber(value, fallback) {
  return (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;
}

function onAdminReady() {
  const select = document.getElementById('dashboard-granularity-select');
  if (select) select.value = currentDashboardGranularity;
  updateStatCardLinks();
  attachAdminSortableHeaders(document.getElementById('by-product-thead'), byProductSortState, () => { byProductPageState.page = 1; renderByProductPage(); });
  attachAdminSortableHeaders(document.getElementById('customers-thead'), customersSortState, () => { customersPageState.page = 1; renderCustomersPage(); });
  loadDashboard();
}

// ── 可點擊統計卡：連結網址依「台北時區」目前選定粒度的期間起訖日期組成，跟後端
// toTaipeiDateParts()／periodStartParts()／stepPeriod() 是同一套固定 UTC+8 位移算法
// （純日曆天運算，不牽扯時分秒），不依賴使用者瀏覽器本身的系統時區設定。這幾組網址只需要在
// 頁面載入與粒度切換時算一次（跟 API 資料無關，不用等 loadDashboard() 的回應才能算）。
const STATCARD_TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
function statcardTaipeiTodayParts() {
  const t = new Date(Date.now() + STATCARD_TAIPEI_OFFSET_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}
function statcardFormatDateParts(parts) {
  return `${parts.y}-${String(parts.m + 1).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
}
function statcardMonthLastDayParts(parts) {
  // 「下個月第0天」＝「這個月最後一天」，這個算法本身天生正確處理跨年（12月→隔年1月）。
  const d = new Date(Date.UTC(parts.y, parts.m + 1, 0));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
}
// 目前選定粒度的「本期間」起訖日期（給訂單管理頁 dateStart／dateEnd 篩選用），規則跟後端
// admin-routes.js 的 periodStartParts()／stepPeriod() 一致：day＝今天／month＝本月／
// quarter＝本季（1-3/4-6/7-9/10-12月）／year＝本年，結束日一律是「下一期起點的前一天」。
function statcardPeriodRangeStrings(granularity, today) {
  if (granularity === 'day') return { start: statcardFormatDateParts(today), end: statcardFormatDateParts(today) };
  if (granularity === 'month') return { start: statcardFormatDateParts({ y: today.y, m: today.m, d: 1 }), end: statcardFormatDateParts(statcardMonthLastDayParts(today)) };
  if (granularity === 'quarter') {
    const qStartMonth = Math.floor(today.m / 3) * 3;
    const qEndMonthLastDay = statcardMonthLastDayParts({ y: today.y, m: qStartMonth + 2, d: 1 });
    return { start: statcardFormatDateParts({ y: today.y, m: qStartMonth, d: 1 }), end: statcardFormatDateParts(qEndMonthLastDay) };
  }
  // year
  return { start: statcardFormatDateParts({ y: today.y, m: 0, d: 1 }), end: statcardFormatDateParts({ y: today.y, m: 11, d: 31 }) };
}

function updateStatCardLinks() {
  const today = statcardTaipeiTodayParts();
  const range = statcardPeriodRangeStrings(currentDashboardGranularity, today);

  const setHref = (id, href) => {
    const el = document.getElementById(id);
    if (el) el.href = href;
  };
  setHref('stat-card-order-count', '/admin');
  setHref('stat-card-period', `/admin?dateStart=${range.start}&dateEnd=${range.end}`);
  // 待處理／製作中對應的狀態代碼，必須跟後端 admin-routes.js 的 PENDING_STATUSES／
  // PRODUCTION_STATUSES 完全一致。這兩張卡跟本期間篩選無關，網址維持不變。
  setHref('stat-card-pending', '/admin?statuses=' + ['new_inquiry', 'quoted'].map(encodeURIComponent).join(','));
  setHref('stat-card-production', '/admin?statuses=' + ['closed_won', 'in_production', 'qc', 'ready_to_ship'].map(encodeURIComponent).join(','));
  setHref('stat-card-overdue', '/admin?overdue=1');
}

function onDashboardGranularityChange() {
  const select = document.getElementById('dashboard-granularity-select');
  const value = select ? select.value : 'day';
  currentDashboardGranularity = DASHBOARD_GRANULARITY_VALUES.includes(value) ? value : 'day';
  updateStatCardLinks();
  loadDashboard();
}

// 防止重複請求：重新整理按鈕連續快速點擊時，只讓最先發出的那次請求真正執行，避免同時打出
// 多個 /api/admin/dashboard 請求互相競爭、畫面被較慢的舊回應覆蓋。
let dashboardLoadInFlight = false;

async function loadDashboard() {
  if (dashboardLoadInFlight) return;
  dashboardLoadInFlight = true;
  const refreshBtn = document.getElementById('dashboard-refresh-btn');
  const todayErrorEl = document.getElementById('dashboard-today-error');
  if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = '載入中…'; }
  todayErrorEl.classList.add('hidden');

  try {
    const resp = await adminFetch('/api/admin/dashboard?granularity=' + encodeURIComponent(currentDashboardGranularity));
    const data = await resp.json();
    if (!resp.ok) {
      showAdminToast(data.error || '載入失敗', true);
      todayErrorEl.textContent = data.error || '本期間營運概況載入失敗，請稍後再試';
      todayErrorEl.classList.remove('hidden');
      return;
    }
    lastDashboardData = data;

    document.getElementById('stat-order-count').textContent = safeDashNumber(data.orderCount, 0).toLocaleString();
    document.getElementById('stat-revenue').textContent = 'NT$ ' + safeDashNumber(data.revenueTotal, 0).toLocaleString();
    document.getElementById('stat-product-count').textContent = safeDashNumber(data.productCount, 0).toLocaleString();
    document.getElementById('stat-low-stock').textContent = safeDashNumber(data.lowStockCount, 0).toLocaleString();

    // periodLabel 是後端依粒度算好的具體文字（例如「2026年8月19日」／「2026年8月」／
    // 「2026年第3季」／「2026年」），不是自由文字、是固定格式產生的，直接當標題與卡片文字用。
    const periodLabel = (typeof data.periodLabel === 'string' && data.periodLabel) ? data.periodLabel : '本期間';
    // 這個標題後面接著「？」說明按鈕（.admin-help-icon），不可以用 .textContent 整個蓋掉
    // （會把按鈕一起刪掉）——只改第一個文字節點，按鈕跟其他子元素原封不動保留。
    document.getElementById('dashboard-period-heading').firstChild.textContent = periodLabel + '營運概況';
    document.getElementById('stat-period-order-count-label').textContent = periodLabel + '訂單數';
    document.getElementById('stat-period-revenue-label').textContent = periodLabel + '營業額（未稅）';
    document.getElementById('dashboard-trend-heading').textContent = DASHBOARD_TREND_HEADING[currentDashboardGranularity] || '營收趨勢';
    document.getElementById('dashboard-status-heading').textContent = periodLabel + '訂單狀態分布';
    document.getElementById('dashboard-topproducts-heading').firstChild.textContent = periodLabel + '熱門商品排行（前 5 名）';
    document.getElementById('dashboard-byproduct-heading').firstChild.textContent = periodLabel + '依商品訂單分布';
    document.getElementById('dashboard-customers-heading').textContent = periodLabel + '客戶訂單彙總（依 Email，依消費金額排序）';

    document.getElementById('stat-period-order-count').textContent = safeDashNumber(data.periodOrderCount, 0).toLocaleString();
    document.getElementById('stat-period-revenue').textContent = 'NT$ ' + safeDashNumber(data.periodRevenue, 0).toLocaleString();
    document.getElementById('stat-pending-count').textContent = safeDashNumber(data.pendingCount, 0).toLocaleString();
    document.getElementById('stat-production-count').textContent = safeDashNumber(data.productionCount, 0).toLocaleString();
    document.getElementById('stat-overdue-count').textContent = safeDashNumber(data.overdueCount, 0).toLocaleString();

    renderByProduct(data.byProduct);
    renderCustomers(data.customers);
    renderRevenueTrend(data.revenueTrend, currentDashboardGranularity);
    renderStatusBreakdown(data.statusBreakdown);
    renderTopProducts(data.topProducts);
  } catch (e) {
    showAdminToast('載入失敗：' + e.message, true);
    todayErrorEl.textContent = '本期間營運概況載入失敗：' + e.message;
    todayErrorEl.classList.remove('hidden');
  } finally {
    dashboardLoadInFlight = false;
    if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = '重新整理'; }
  }
  loadInventory();
}

// ─── 匯出Excel（總覽／營收趨勢／訂單狀態分布／熱門商品排行／依商品訂單分布／庫存概況／
// 客戶訂單彙總，7個分頁）───────────────────────────────────────
// 沿用網站分析匯出那批同一套原則：畫面上已經算好、正在顯示的資料才是唯一來源，不重新呼叫
// API，直接從 lastDashboardData／lastInventoryList 現算，保證匯出內容跟畫面上完全一致。
let isExportingDashboard = false;
async function exportDashboardXlsx() {
  if (isExportingDashboard) return;
  if (!lastDashboardData) {
    showAdminToast('目前沒有已載入的儀表板資料可以匯出，請先等頁面載入完成或按「重新整理」', true);
    return;
  }
  const btn = document.getElementById('dashboard-export-btn');
  const errEl = document.getElementById('dashboard-export-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';
  const originalText = btn.textContent;
  isExportingDashboard = true;
  btn.disabled = true;
  btn.textContent = '匯出中…';

  try {
    const data = lastDashboardData;
    const periodLabel = (typeof data.periodLabel === 'string' && data.periodLabel) ? data.periodLabel : '本期間';

    const summaryRows = [
      ['訂單總數（全站累計）', data.orderCount],
      ['估價總營收（全站累計，未稅）', 'NT$ ' + safeDashNumber(data.revenueTotal, 0).toLocaleString()],
      ['上架商品數', data.productCount],
      ['低庫存項目', data.lowStockCount],
      ['目前時間粒度', DASHBOARD_GRANULARITY_TEXT[currentDashboardGranularity] || currentDashboardGranularity],
      [periodLabel + '訂單數', data.periodOrderCount],
      [periodLabel + '營業額（未稅）', 'NT$ ' + safeDashNumber(data.periodRevenue, 0).toLocaleString()],
      ['待處理訂單（目前工作量，不受粒度篩選）', data.pendingCount],
      ['製作中訂單（目前工作量，不受粒度篩選）', data.productionCount],
      ['預估逾期訂單（目前工作量，不受粒度篩選）', data.overdueCount]
    ].map(([label, value]) => ({ label, value: String(value) }));

    const trendRows = (Array.isArray(data.revenueTrend) ? data.revenueTrend : [])
      .map(t => ({ period: t.periodLabel, orderCount: t.orderCount, revenue: t.revenue }));

    const statusRows = (Array.isArray(data.statusBreakdown) ? data.statusBreakdown : [])
      .map(s => ({ status: s.label, count: s.count }));

    const topProductRows = (Array.isArray(data.topProducts) ? data.topProducts : [])
      .map((p, i) => ({ rank: i + 1, productName: p.productName, orderCount: p.orderCount }));

    const byProductRows = Object.entries(data.byProduct || {})
      .sort((a, b) => b[1] - a[1])
      .map(([productName, orderCount]) => ({ productName, orderCount }));

    const inventoryRows = lastInventoryList.map(i => ({
      name: i.name, stockQty: i.stockQty, threshold: i.lowStockThreshold, unit: i.unit, status: i.low ? '低庫存' : '正常'
    }));

    const customerRows = (Array.isArray(data.customers) ? data.customers : [])
      .map(c => ({ name: c.name || '--', email: c.email, orderCount: c.orderCount, totalSpent: c.totalSpent, lastOrderAt: c.lastOrderAt }));

    const resp = await adminFetch('/api/admin/dashboard/export', {
      method: 'POST',
      body: JSON.stringify({ summaryRows, trendRows, statusRows, topProductRows, byProductRows, inventoryRows, customerRows })
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => null);
      throw new Error((errData && errData.error) || '匯出失敗，請稍後再試');
    }
    await adminDownloadBlob(resp, `楊竹儀表板_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    errEl.textContent = '匯出失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    isExportingDashboard = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// 兩張表格本身是後端一次彙總回傳的完整陣列（不是後端分頁），資料量會隨著商品／客戶數量
// 持續增加，這裡在瀏覽器端做分頁＋排序，不需要改動後端API。DASHBOARD_LIST_PAGE_SIZE統一
// 兩張表格的每頁筆數，狀態各自獨立保存，切換粒度重新載入資料時會在 loadDashboard() 裡
// 一併重置回第1頁（見下方 loadDashboard 內對應段落）。
const DASHBOARD_LIST_PAGE_SIZE = 20;
let byProductAllRows = [];
let byProductPageState = { page: 1 };
const byProductSortState = { sortKey: 'count', sortDir: 'desc' };
let customersAllRows = [];
let customersPageState = { page: 1 };
const customersSortState = { sortKey: 'totalSpent', sortDir: 'desc' };

function renderByProduct(byProduct) {
  byProductAllRows = Object.entries(byProduct || {}).map(([name, count]) => ({ name, count }));
  byProductPageState.page = 1;
  renderByProductPage();
}
function renderByProductPage() {
  const tbody = document.getElementById('by-product-body');
  const sorted = byProductAllRows.slice().sort((a, b) => adminCompareForSort(a[byProductSortState.sortKey], b[byProductSortState.sortKey], byProductSortState.sortDir));
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="2" style="text-align:center;color:var(--gray-400);padding:20px;">目前還沒有訂單資料</td></tr>`;
    renderAdminPagination(document.getElementById('by-product-pagination'), { page: 1, totalPages: 1, onChange: () => {} });
    return;
  }
  const { rows, page, totalPages } = adminPaginateArray(sorted, byProductPageState.page, DASHBOARD_LIST_PAGE_SIZE);
  byProductPageState.page = page;
  tbody.innerHTML = rows.map(r => `
    <tr><td>${escAdminHtml(r.name)}</td><td>${r.count}</td></tr>
  `).join('');
  renderAdminPagination(document.getElementById('by-product-pagination'), {
    page, totalPages, onChange: p => { byProductPageState.page = p; renderByProductPage(); }
  });
}

function renderCustomers(customers) {
  customersAllRows = Array.isArray(customers) ? customers : [];
  customersPageState.page = 1;
  renderCustomersPage();
}
function renderCustomersPage() {
  const tbody = document.getElementById('customers-body');
  const sorted = customersAllRows.slice().sort((a, b) => adminCompareForSort(a[customersSortState.sortKey], b[customersSortState.sortKey], customersSortState.sortDir));
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:20px;">目前還沒有訂單資料</td></tr>`;
    renderAdminPagination(document.getElementById('customers-pagination'), { page: 1, totalPages: 1, onChange: () => {} });
    return;
  }
  const { rows, page, totalPages } = adminPaginateArray(sorted, customersPageState.page, DASHBOARD_LIST_PAGE_SIZE);
  customersPageState.page = page;
  tbody.innerHTML = rows.map(c => `
    <tr>
      <td>${escAdminHtml(c.name || '--')}</td>
      <td>${escAdminHtml(c.email)}</td>
      <td>${safeDashNumber(c.orderCount, 0).toLocaleString()}</td>
      <td>NT$ ${safeDashNumber(c.totalSpent, 0).toLocaleString()}</td>
      <td>${fmtDashTime(c.lastOrderAt)}</td>
    </tr>
  `).join('');
  renderAdminPagination(document.getElementById('customers-pagination'), {
    page, totalPages, onChange: p => { customersPageState.page = p; renderCustomersPage(); }
  });
}

// ── 營收趨勢／訂單狀態分布圖表：一律用 createElementNS／createElement + textContent 建立
// 節點，不使用樣板字串拼接 innerHTML，動態文字（日期、數字、狀態中文名稱）不可能被解析成
// 真正的 HTML 標籤或觸發事件屬性，防止 XSS。圖表旁固定搭配一份完整資料表格，不是只靠
// 顏色或圖形辨識數字。
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
  return el;
}
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
function tableCell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}
function emptyStateRow(colspan) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan;
  td.style.textAlign = 'center';
  td.style.color = 'var(--gray-400)';
  td.style.padding = '20px';
  td.textContent = '目前沒有資料';
  tr.appendChild(td);
  return tr;
}

// ── 嚴格資料格式驗證：API 如果異常只回傳不完整或格式不對的資料，前端絕對不能畫出一張
// 「看起來正常但內容其實不完整」的圖表，一律整張顯示「目前沒有資料」，不允許畫出部分圖表。
// 這是額外的一層防線，就算後端邏輯本身沒有問題，前端也不會盲目信任回應內容的完整性。
function isNonNegativeInteger(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}
function isNonNegativeFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// 2026-08-19新增粒度切換後，趨勢筆數不再固定是30（day=30／month=12／quarter=8／year=5），
// 也不再是純日期字串（day="2026-08-19"／month="2026-08"／quarter="2026-Q3"／year="2026"）。
// 這4種periodKey格式剛好都符合「純字串大小排序＝實際時間先後排序」（年份在前、月/季/日都有
// 補零或固定寬度），不需要為每種粒度各寫一套換算成毫秒再比較的邏輯，直接用字串比較就能同時
// 驗證「由舊到新排列」與「沒有重複」，是這4種格式共用的巧合但穩固的不變量。
function isValidRevenueTrend(trend, granularity) {
  const expectedLength = DASHBOARD_TREND_COUNT[granularity] || DASHBOARD_TREND_COUNT.day;
  if (!Array.isArray(trend) || trend.length !== expectedLength) return false;
  for (const t of trend) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
    if (typeof t.periodKey !== 'string' || !t.periodKey) return false;
    if (typeof t.periodLabel !== 'string' || !t.periodLabel) return false;
    if (!isNonNegativeInteger(t.orderCount)) return false;
    if (!isNonNegativeFiniteNumber(t.revenue)) return false;
  }
  for (let i = 1; i < trend.length; i++) {
    if (!(trend[i].periodKey > trend[i - 1].periodKey)) return false;
  }
  return true;
}

// 狀態中文名稱是固定對照表產生的，不是自由文字——直接要求「這個status一定要對應到
// 這個exact的中文名稱」，比單純檢查「非空白字串」更嚴謹，惡意HTML字串或空白字串
// 都不可能剛好等於對照表裡的值，會被這裡直接擋下，整張圖表顯示「目前沒有資料」。
const STATUS_LABEL_MAP = {
  new_inquiry: '新詢價', quoted: '已報價', closed_won: '已成交', in_production: '生產中',
  qc: '品質檢查', ready_to_ship: '待出貨', shipped: '已出貨', completed: '已完成',
  cancelled: '已取消', other: '其他'
};
const ALLOWED_STATUS_KEYS = Object.keys(STATUS_LABEL_MAP);

function isValidStatusBreakdown(breakdown) {
  if (!Array.isArray(breakdown) || breakdown.length !== ALLOWED_STATUS_KEYS.length) return false;
  const seen = new Set();
  for (const b of breakdown) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    if (!Object.prototype.hasOwnProperty.call(STATUS_LABEL_MAP, b.status)) return false;
    if (seen.has(b.status)) return false; // 重複狀態
    seen.add(b.status);
    if (b.label !== STATUS_LABEL_MAP[b.status]) return false; // 空白／惡意HTML／文字不符對照表一律擋下
    if (!isNonNegativeInteger(b.count)) return false;
  }
  // 10種狀態各自唯一且不重複（上面seen已保證），再確認10種真的都到齊、沒有缺漏。
  return ALLOWED_STATUS_KEYS.every(k => seen.has(k));
}

// x軸刻度用的短版標籤：periodLabel是完整中文文字（表格與提示框用），x軸刻度另外從periodKey
// 截出精簡版本，避免「2026年8月19日」這種長文字在30根長條下互相重疊看不清楚。
function trendAxisLabel(periodKey, granularity) {
  if (typeof periodKey !== 'string') return '';
  if (granularity === 'day') return periodKey.slice(5); // "2026-08-19" → "08-19"
  if (granularity === 'month') return periodKey.slice(2); // "2026-08" → "26-08"
  return periodKey; // quarter"2026-Q3"／year"2026"本身已經夠短，不用再截
}

function renderRevenueTrend(trend, granularity) {
  const svg = document.getElementById('revenue-trend-svg');
  const emptyEl = document.getElementById('revenue-trend-empty');
  const tbody = document.getElementById('revenue-trend-table-body');
  clearChildren(svg);
  clearChildren(tbody);

  // API 缺資料／格式不對時，不可以用猜的畫圖，一律顯示清楚的「目前沒有資料」，不能只畫出
  // 部分期間就當作正常圖表——資料不完整本身就是一種異常，寧可完全不畫，也不能誤導使用者。
  if (!isValidRevenueTrend(trend, granularity)) {
    emptyEl.classList.remove('hidden');
    tbody.appendChild(emptyStateRow(3));
    return;
  }
  emptyEl.classList.add('hidden');

  const W = 800, H = 220, padL = 66, padR = 10, padT = 12, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = trend.length;
  const revenues = trend.map(t => safeDashNumber(t.revenue, 0));
  const maxRevenue = Math.max(1, ...revenues); // 避免全部是0時除以0
  // x軸最多標6個刻度，不論目前是30根（每天）或5根（每年）長條都不會互相擠在一起。
  const labelStep = Math.max(1, Math.ceil(n / 6));

  // y軸只標0與最大值兩條格線，避免圖表在較多長條時顯得過度擁擠。
  [0, maxRevenue].forEach(val => {
    const y = padT + plotH - (val / maxRevenue) * plotH;
    svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'chart-grid-line' }));
    const label = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', class: 'chart-bar-label' });
    label.textContent = 'NT$' + Math.round(val).toLocaleString();
    svg.appendChild(label);
  });

  const slotW = plotW / n;
  const gap = 2;
  const barW = Math.max(1, slotW - gap);

  trend.forEach((t, i) => {
    const revenue = safeDashNumber(t.revenue, 0);
    const orderCount = safeDashNumber(t.orderCount, 0);
    const barH = (revenue / maxRevenue) * plotH;
    const x = padL + i * slotW + gap / 2;
    const y = padT + plotH - barH;

    const rect = svgEl('rect', { x, y, width: barW, height: Math.max(0, barH), class: 'chart-bar-revenue', rx: 1 });
    const titleEl = document.createElementNS(SVG_NS, 'title');
    titleEl.textContent = `${t.periodLabel}：${orderCount} 筆訂單，NT$ ${revenue.toLocaleString()}`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    // 依 labelStep 間隔標一次x軸刻度（含最後一筆），避免標籤互相重疊；完整明細資料仍然
    // 全部列在下方表格裡，不受標籤稀疏影響。
    if (i % labelStep === 0 || i === n - 1) {
      const axisLabel = svgEl('text', { x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-bar-label' });
      axisLabel.textContent = trendAxisLabel(t.periodKey, granularity);
      svg.appendChild(axisLabel);
    }

    const tr = document.createElement('tr');
    tr.appendChild(tableCell(t.periodLabel));
    tr.appendChild(tableCell(orderCount.toLocaleString()));
    tr.appendChild(tableCell('NT$ ' + revenue.toLocaleString()));
    tbody.appendChild(tr);
  });
}

function renderStatusBreakdown(breakdown) {
  const svg = document.getElementById('status-breakdown-svg');
  const emptyEl = document.getElementById('status-breakdown-empty');
  const tbody = document.getElementById('status-breakdown-table-body');
  clearChildren(svg);
  clearChildren(tbody);

  if (!isValidStatusBreakdown(breakdown)) {
    emptyEl.classList.remove('hidden');
    tbody.appendChild(emptyStateRow(2));
    return;
  }
  emptyEl.classList.add('hidden');

  const rowH = 26, padL = 130, padR = 60, padT = 8, padB = 8;
  const W = 800;
  const H = breakdown.length * rowH + padT + padB;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const plotW = W - padL - padR;
  const counts = breakdown.map(b => safeDashNumber(b.count, 0));
  const maxCount = Math.max(1, ...counts);

  breakdown.forEach((b, i) => {
    const count = safeDashNumber(b.count, 0);
    const y = padT + i * rowH;
    const barH = rowH - 8;
    const barW = (count / maxCount) * plotW;

    const label = svgEl('text', { x: padL - 8, y: y + rowH / 2 + 4, 'text-anchor': 'end', class: 'chart-bar-label' });
    label.textContent = b.label; // 固定對照表產生的繁體中文名稱，不是使用者輸入
    svg.appendChild(label);

    const rect = svgEl('rect', { x: padL, y: y + 4, width: Math.max(0, barW), height: barH, class: 'chart-bar-status', rx: 3 });
    const titleEl = document.createElementNS(SVG_NS, 'title');
    titleEl.textContent = `${b.label}：${count} 筆`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    const valueLabel = svgEl('text', { x: padL + barW + 8, y: y + rowH / 2 + 4, class: 'chart-value-label' });
    valueLabel.textContent = count.toLocaleString();
    svg.appendChild(valueLabel);

    const tr = document.createElement('tr');
    tr.appendChild(tableCell(b.label));
    tr.appendChild(tableCell(count.toLocaleString()));
    tbody.appendChild(tr);
  });
}

// ── 熱門商品排行：最多5筆（商品種類不足5種時可以少於5筆，但不可超過5筆）；每筆
// productName 必須是非空字串、orderCount 必須是非負整數。格式不符時整段顯示「目前沒有資料」，
// 原則跟營收趨勢／訂單狀態分布圖表一致，不會用猜的畫出部分排行。
function isValidTopProducts(list) {
  if (!Array.isArray(list) || list.length > 5) return false;
  return list.every(p => p && typeof p === 'object' && !Array.isArray(p)
    && typeof p.productName === 'string' && p.productName.trim().length > 0
    && isNonNegativeInteger(p.orderCount));
}

// 商品名稱一律用 textContent 賦值（連結文字也是），不使用 innerHTML／樣板字串拼接，避免
// 惡意商品名稱被解析成真正的 HTML 標籤或觸發事件屬性。連結用原生 <a href> 標籤，鍵盤 Tab
// 移動＋Enter 即可觸發，不需要額外的 JS 鍵盤事件處理。
function renderTopProducts(topProducts) {
  const tbody = document.getElementById('top-products-body');
  clearChildren(tbody);

  if (!isValidTopProducts(topProducts) || topProducts.length === 0) {
    tbody.appendChild(emptyStateRow(3));
    return;
  }

  topProducts.forEach((p, i) => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(String(i + 1)));

    const nameTd = document.createElement('td');
    const link = document.createElement('a');
    link.className = 'dashboard-rank-link';
    link.href = '/admin?product=' + encodeURIComponent(p.productName);
    link.textContent = p.productName;
    nameTd.appendChild(link);
    tr.appendChild(nameTd);

    tr.appendChild(tableCell(p.orderCount.toLocaleString()));
    tbody.appendChild(tr);
  });
}

let lastInventoryList = [];

async function loadInventory() {
  try {
    const resp = await adminFetch('/api/admin/inventory');
    const data = await resp.json();
    lastInventoryList = data.inventory || [];
    renderInventory(lastInventoryList);
  } catch (e) {
    showAdminToast('庫存載入失敗：' + e.message, true);
  }
}

function renderInventory(list) {
  const tbody = document.getElementById('inventory-body');
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--gray-400);padding:20px;">還沒有任何商品，請先到「產品管理」新增</td></tr>`;
    return;
  }
  // 用 data-product-id 傳遞，商品名稱等從 lastInventoryList 查回，避免商品名稱裡有引號字元把 onclick 弄壞。
  // stockQty／lowStockThreshold 一律先經過 safeDashNumber() 才呼叫 .toLocaleString()——
  // 舊資料或欄位異常時 undefined.toLocaleString() 會直接丟例外中斷整張表格渲染，2026-08-21
  // 盤點時發現這裡沒有跟同檔案其他表格一樣做防禦，這裡補齊。
  tbody.innerHTML = list.map(i => `
    <tr>
      <td>${escAdminHtml(i.name)}</td>
      <td>${safeDashNumber(i.stockQty, 0).toLocaleString()} ${escAdminHtml(i.unit)}</td>
      <td>${safeDashNumber(i.lowStockThreshold, 0).toLocaleString()}</td>
      <td>${i.low ? '<span class="status-pill low">低庫存</span>' : '<span class="status-pill active">正常</span>'}</td>
      <td>
        <button class="btn btn-secondary btn-sm" data-product-id="${escAdminHtml(i.productId)}" onclick="openMovementPanel(this.dataset.productId)">登記進出貨</button>
        <button class="btn btn-secondary btn-sm" data-product-id="${escAdminHtml(i.productId)}" onclick="openInventoryLog(this.dataset.productId)">查看異動紀錄</button>
      </td>
    </tr>
  `).join('');
}

function openMovementPanel(productId) {
  const item = lastInventoryList.find(i => i.productId === productId);
  if (!item) return;
  currentMovementProductId = productId;
  document.getElementById('movement-title').textContent = `${item.name}（目前庫存 ${item.stockQty}）`;
  document.getElementById('movement-qty').value = '';
  document.getElementById('movement-reason').value = '';
  document.getElementById('movement-note').value = '';
  document.getElementById('movement-threshold').value = item.lowStockThreshold;
  const panel = document.getElementById('movement-panel');
  panel.classList.remove('hidden');
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeMovementPanel() {
  document.getElementById('movement-panel').classList.add('hidden');
  currentMovementProductId = null;
}

// 2026-08-21盤點指出這裡原本完全沒有confirm()、也沒有防重複送出——庫存異動會實際增減
// 庫存數字，快速連點「登記異動」理論上可以送出多次疊加的異動。這裡補上確認對話框（列出
// 這次異動的商品、方向與數量）＋adminRunAction防連點與送出中狀態。
async function submitMovement(btnEl) {
  if (!currentMovementProductId) return;
  const changeQty = Number(document.getElementById('movement-qty').value);
  if (!changeQty) { showAdminToast('請輸入非 0 的異動數量', true); return; }
  const reason = document.getElementById('movement-reason').value.trim() || null;
  const note = document.getElementById('movement-note').value.trim() || null;
  const item = lastInventoryList.find(i => i.productId === currentMovementProductId);
  const itemName = item ? item.name : currentMovementProductId;
  const direction = changeQty > 0 ? '增加' : '減少';

  const { confirmed } = await adminConfirmDialog({
    title: '確認登記庫存異動',
    message: `確定要為「${itemName}」登記庫存${direction} ${Math.abs(changeQty)} 嗎？`,
    confirmLabel: '確認登記'
  });
  if (!confirmed) return;

  await adminRunAction(btnEl, '登記中…', async () => {
    try {
      const resp = await adminFetch(`/api/admin/inventory/${encodeURIComponent(currentMovementProductId)}/movement`, {
        method: 'POST', body: JSON.stringify({ changeQty, reason, note })
      });
      const data = await resp.json();
      if (!resp.ok) { showAdminToast(data.error || '登記失敗', true); return; }
      showAdminToast(`已登記，最新庫存 ${data.stockQty}`);
      closeMovementPanel();
      loadDashboard();
    } catch (e) {
      showAdminToast('登記失敗：' + e.message, true);
    }
  });
}

async function saveThreshold(btnEl) {
  if (!currentMovementProductId) return;
  const threshold = Number(document.getElementById('movement-threshold').value);
  if (!Number.isFinite(threshold) || threshold < 0) { showAdminToast('警戒值需為 0 以上的數字', true); return; }

  await adminRunAction(btnEl, '更新中…', async () => {
    try {
      const resp = await adminFetch(`/api/admin/inventory/${encodeURIComponent(currentMovementProductId)}/threshold`, {
        method: 'PUT', body: JSON.stringify({ lowStockThreshold: threshold })
      });
      const data = await resp.json();
      if (!resp.ok) { showAdminToast(data.error || '更新失敗', true); return; }
      showAdminToast('警戒值已更新');
      closeMovementPanel();
      loadDashboard();
    } catch (e) {
      showAdminToast('更新失敗：' + e.message, true);
    }
  });
}

function fmtDashTime(iso) {
  try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
  catch { return iso || '--'; }
}

// ─── 匯出庫存 CSV：串接既有 GET /api/admin/inventory/export，用 adminFetch()（帶登入
// Session Cookie）下載，不把密碼放進網址查詢字串。下載期間停用按鈕，成功或失敗都會
// 恢復；失敗時顯示明確錯誤訊息，按鈕本身重新可點擊即是「重新嘗試」。
async function exportInventoryCsv() {
  const btn = document.getElementById('inventory-export-btn');
  const errEl = document.getElementById('inventory-export-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '匯出中…';

  try {
    const resp = await adminFetch('/api/admin/inventory/export');
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      throw new Error((data && data.error) || `下載失敗（HTTP ${resp.status}）`);
    }
    const blob = await resp.blob();

    // 從 Content-Disposition 取出（可能含中文的）檔名，拿不到就用固定的英文檔名退回值。
    let filename = 'inventory-export.csv';
    const disposition = resp.headers.get('Content-Disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match) {
      filename = decodeURIComponent(utf8Match[1]);
    } else {
      const asciiMatch = disposition.match(/filename="([^"]+)"/i);
      if (asciiMatch) filename = asciiMatch[1];
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    errEl.textContent = '匯出失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

// ─── 庫存異動紀錄：只做唯讀顯示，串接既有 GET /api/admin/inventory/:productId/log，
// 不新增修改／刪除紀錄的功能，也不處理自動扣庫存。API 本身已經用 `ORDER BY id DESC`
// 回傳（最新在最前面），前端直接照回傳順序顯示，不再自己排序一次。
let currentInventoryLogProductId = null;
let inventoryLogRequestSeq = 0;

function openInventoryLog(productId) {
  const item = lastInventoryList.find(i => i.productId === productId);
  if (!item) return;
  currentInventoryLogProductId = productId;
  document.getElementById('inventory-log-title').textContent = `${item.name} — 庫存異動紀錄`;
  document.getElementById('inventory-log-overlay').classList.remove('hidden');
  loadInventoryLog(productId);
}

function closeInventoryLog() {
  document.getElementById('inventory-log-overlay').classList.add('hidden');
  currentInventoryLogProductId = null;
  // 關閉當下如果還有一筆讀取請求在飛行中，讓它之後回來時比對到「已經不是最新一次」
  // 而直接被捨棄，不會在面板關閉後才突然把資料寫進畫面。
  inventoryLogRequestSeq++;
}

function retryInventoryLog() {
  if (!currentInventoryLogProductId) return;
  loadInventoryLog(currentInventoryLogProductId);
}

function showInventoryLogState(name) {
  ['loading', 'error', 'empty', 'list'].forEach(s => {
    document.getElementById(`inventory-log-${s}`).classList.toggle('hidden', s !== name);
  });
}

async function loadInventoryLog(productId) {
  // 每次載入（含切換商品、重新嘗試）都遞增一次序號；商品切換很快時，較慢回來的
  // 舊請求比對序號不符就直接捨棄，不會蓋掉使用者已經切換過去的新商品畫面。
  inventoryLogRequestSeq++;
  const seq = inventoryLogRequestSeq;
  showInventoryLogState('loading');

  try {
    const resp = await adminFetch(`/api/admin/inventory/${encodeURIComponent(productId)}/log`);
    const data = await resp.json().catch(() => null);
    if (seq !== inventoryLogRequestSeq) return;
    if (!resp.ok) {
      document.getElementById('inventory-log-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      showInventoryLogState('error');
      return;
    }
    renderInventoryLogList(Array.isArray(data && data.log) ? data.log : []);
  } catch (e) {
    if (seq !== inventoryLogRequestSeq) return;
    document.getElementById('inventory-log-error-text').textContent = '讀取失敗：' + e.message;
    showInventoryLogState('error');
  }
}

// 所有動態資料一律用 textContent 賦值、DOM API 逐筆建立節點，不使用 innerHTML 寫入，避免 XSS。
function renderInventoryLogList(log) {
  const listEl = document.getElementById('inventory-log-list');
  listEl.textContent = '';

  if (!log.length) {
    showInventoryLogState('empty');
    return;
  }

  log.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'inventory-log-item';

    const qtyLine = document.createElement('div');
    qtyLine.className = 'inventory-log-qty-line';

    const qtyEl = document.createElement('span');
    const changeQty = entry.changeQty;
    const isIncrease = typeof changeQty === 'number' && Number.isFinite(changeQty) && changeQty > 0;
    const isDecrease = typeof changeQty === 'number' && Number.isFinite(changeQty) && changeQty < 0;
    qtyEl.className = 'inventory-log-qty' + (isIncrease ? ' increase' : (isDecrease ? ' decrease' : ''));
    const qtyAbsText = (typeof changeQty === 'number' && Number.isFinite(changeQty)) ? Math.abs(changeQty).toLocaleString() : '未提供';
    const actionText = isIncrease ? '增加' : (isDecrease ? '減少' : '異動');
    qtyEl.textContent = `${actionText} ${qtyAbsText}`;

    const timeEl = document.createElement('span');
    timeEl.className = 'inventory-log-time';
    timeEl.textContent = fmtDashTime(entry.createdAt);

    qtyLine.appendChild(qtyEl);
    qtyLine.appendChild(timeEl);

    const reasonEl = document.createElement('div');
    reasonEl.className = 'inventory-log-reason';
    reasonEl.textContent = '原因：' + (entry.reason || '未填寫');

    li.appendChild(qtyLine);
    li.appendChild(reasonEl);

    if (entry.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'inventory-log-note';
      noteEl.textContent = '備註：' + entry.note;
      li.appendChild(noteEl);
    }

    listEl.appendChild(li);
  });

  showInventoryLogState('list');
}

// ─── 庫存盤點：建立草稿、輸入實際數量、顯示差異、儲存草稿、確認盤點、查看歷史盤點 ────
// 核心原則跟後端一致：草稿期間（`儲存草稿`）完全不呼叫任何會改動正式庫存的 API，只有
// `確認盤點` 才會真正調整庫存；確認前一律要求先按過「儲存草稿」，欄位目前的輸入內容跟
// 伺服器上次儲存的結果不一致就擋下確認、提示使用者先儲存，避免送出一份使用者以為已經
// 存檔、實際上還沒同步到伺服器的資料。
const STOCKTAKE_STATUS_LABELS = { draft: '草稿', confirmed: '已確認' };
let currentStocktakeDetail = null;
let stocktakeHistoryList = [];

function openStocktakePanel() {
  document.getElementById('stocktake-overlay').classList.remove('hidden');
  loadStocktakePanel();
}

function closeStocktakePanel() {
  document.getElementById('stocktake-overlay').classList.add('hidden');
}

function retryStocktakePanel() {
  loadStocktakePanel();
}

function showStocktakePanelState(name) {
  ['loading', 'error', 'empty', 'draft'].forEach(s => {
    document.getElementById(`stocktake-${s}`).classList.toggle('hidden', s !== name);
  });
}

// 目前是否有進行中的草稿：定義成「最近一張盤點單，且狀態仍是 draft」。確認後的盤點單
// 不會再被當成可續編的草稿，下次打開會回到「建立新盤點」的空狀態，需要開新的一張。
async function loadStocktakePanel() {
  showStocktakePanelState('loading');
  try {
    const resp = await adminFetch('/api/admin/stocktakes?page=1&pageSize=1');
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      document.getElementById('stocktake-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      showStocktakePanelState('error');
      return;
    }
    const latest = (data.stocktakes && data.stocktakes[0]) || null;
    if (!latest || latest.status !== 'draft') {
      currentStocktakeDetail = null;
      showStocktakePanelState('empty');
      return;
    }
    await loadStocktakeDetailInto(latest.id);
  } catch (e) {
    document.getElementById('stocktake-error-text').textContent = '讀取失敗：' + e.message;
    showStocktakePanelState('error');
  }
}

async function loadStocktakeDetailInto(id) {
  try {
    const resp = await adminFetch(`/api/admin/stocktakes/${encodeURIComponent(id)}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      document.getElementById('stocktake-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      showStocktakePanelState('error');
      return;
    }
    currentStocktakeDetail = data.stocktake;
    renderStocktakeDraft(currentStocktakeDetail);
    showStocktakePanelState('draft');
  } catch (e) {
    document.getElementById('stocktake-error-text').textContent = '讀取失敗：' + e.message;
    showStocktakePanelState('error');
  }
}

async function createStocktakeDraft() {
  const btn = document.getElementById('stocktake-create-btn');
  btn.disabled = true;
  try {
    const resp = await adminFetch('/api/admin/stocktakes', { method: 'POST', body: JSON.stringify({}) });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) { showAdminToast((data && data.error) || '建立盤點單失敗', true); return; }
    currentStocktakeDetail = data.stocktake;
    renderStocktakeDraft(currentStocktakeDetail);
    showStocktakePanelState('draft');
  } catch (e) {
    showAdminToast('建立盤點單失敗：' + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function fmtStocktakeDiff(diff) {
  if (diff === null || diff === undefined) return '尚未輸入';
  if (diff === 0) return '0';
  const cls = diff > 0 ? 'increase' : 'decrease';
  const sign = diff > 0 ? '+' : '';
  return `<span class="stocktake-diff ${cls}">${sign}${diff}</span>`;
}

function renderStocktakeDraft(detail) {
  document.getElementById('stocktake-id-text').textContent = detail.id;
  document.getElementById('stocktake-status-text').textContent = STOCKTAKE_STATUS_LABELS[detail.status] || detail.status;
  const noteInput = document.getElementById('stocktake-note');
  noteInput.value = detail.note || '';
  noteInput.disabled = detail.status !== 'draft';

  const tbody = document.getElementById('stocktake-items-body');
  tbody.innerHTML = detail.items.map(it => `
    <tr>
      <td>${escAdminHtml(it.productCode)}</td>
      <td>${escAdminHtml(it.productName)}</td>
      <td>${safeDashNumber(it.systemQty, 0).toLocaleString()}</td>
      <td>
        <input type="number" class="stocktake-qty-input" min="0" step="1"
          value="${it.countedQty === null ? '' : it.countedQty}"
          data-product-id="${escAdminHtml(it.productId)}"
          data-system-qty="${it.systemQty}"
          ${detail.status !== 'draft' ? 'disabled' : ''}
          oninput="onStocktakeQtyInput(this)">
      </td>
      <td class="stocktake-diff-cell">${fmtStocktakeDiff(it.diffQty)}</td>
    </tr>
  `).join('');

  const isDraft = detail.status === 'draft';
  document.getElementById('stocktake-save-btn').style.display = isDraft ? '' : 'none';
  document.getElementById('stocktake-confirm-btn').style.display = isDraft ? '' : 'none';
  document.getElementById('stocktake-submit-error').classList.add('hidden');
}

function onStocktakeQtyInput(input) {
  const row = input.closest('tr');
  const cell = row.querySelector('.stocktake-diff-cell');
  if (!cell) return;
  if (input.value === '') { cell.innerHTML = fmtStocktakeDiff(null); return; }
  const n = Number(input.value);
  if (!Number.isFinite(n)) { cell.innerHTML = fmtStocktakeDiff(null); return; }
  const systemQty = Number(input.dataset.systemQty);
  cell.innerHTML = fmtStocktakeDiff(Math.trunc(n) - systemQty);
}

// 蒐集畫面上目前每一格輸入框的內容：空白代表「這個商品先不儲存」，直接略過（沿用後端
// 允許只傳部分商品的設計）；有值的一律先用跟後端一致的規則（只能是 0 以上的整數字串，
// 不接受負號、小數點）在前端先擋一次，減少明顯不合法的請求。
function collectStocktakeItemsInput() {
  const rows = document.querySelectorAll('#stocktake-items-body tr');
  const items = [];
  let invalidMsg = null;
  rows.forEach(row => {
    const input = row.querySelector('.stocktake-qty-input');
    if (!input || input.value === '') return;
    const productId = input.dataset.productId;
    const raw = input.value.trim();
    if (!/^\d+$/.test(raw)) {
      invalidMsg = invalidMsg || `商品「${productId}」的實際盤點數量必須是 0 以上的整數`;
      return;
    }
    items.push({ productId, countedQty: Number(raw) });
  });
  return { items, invalidMsg };
}

async function saveStocktakeDraft() {
  if (!currentStocktakeDetail) return;
  const errEl = document.getElementById('stocktake-submit-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  const { items, invalidMsg } = collectStocktakeItemsInput();
  if (invalidMsg) { errEl.textContent = invalidMsg; errEl.classList.remove('hidden'); return; }
  if (items.length === 0) { errEl.textContent = '請至少輸入一項商品的實際盤點數量'; errEl.classList.remove('hidden'); return; }

  const saveBtn = document.getElementById('stocktake-save-btn');
  const confirmBtn = document.getElementById('stocktake-confirm-btn');
  saveBtn.disabled = true;
  confirmBtn.disabled = true;
  const note = document.getElementById('stocktake-note').value.trim();

  try {
    const resp = await adminFetch(`/api/admin/stocktakes/${encodeURIComponent(currentStocktakeDetail.id)}`, {
      method: 'PUT', body: JSON.stringify({ items, note: note || null })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) { errEl.textContent = (data && data.error) || '儲存草稿失敗'; errEl.classList.remove('hidden'); return; }
    // 成功才用伺服器回傳的最新資料重畫表格；失敗時完全不重畫，保留使用者目前的輸入內容，
    // 讓使用者可以直接修正後重試，不會白白遺失剛剛打的數字。
    currentStocktakeDetail = data.stocktake;
    renderStocktakeDraft(currentStocktakeDetail);
    showAdminToast('草稿已儲存');
  } catch (e) {
    errEl.textContent = '儲存草稿失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    confirmBtn.disabled = false;
  }
}

// 確認盤點前先檢查畫面上的輸入框是否跟伺服器最後一次儲存的結果完全一致，只要有任何一格
// 不同就擋下並提示先儲存草稿——避免使用者以為剛打的數字已經送出，結果確認盤點用的其實是
// 舊的、還沒儲存的資料。
function hasUnsavedStocktakeChanges() {
  if (!currentStocktakeDetail) return false;
  const rows = document.querySelectorAll('#stocktake-items-body tr');
  let unsaved = false;
  rows.forEach(row => {
    const input = row.querySelector('.stocktake-qty-input');
    if (!input) return;
    const productId = input.dataset.productId;
    const item = currentStocktakeDetail.items.find(it => it.productId === productId);
    const savedVal = (item && item.countedQty !== null) ? String(item.countedQty) : '';
    if (input.value !== savedVal) unsaved = true;
  });
  return unsaved;
}

async function confirmStocktake() {
  if (!currentStocktakeDetail) return;
  const errEl = document.getElementById('stocktake-submit-error');
  errEl.classList.add('hidden');
  errEl.textContent = '';

  if (hasUnsavedStocktakeChanges()) {
    errEl.textContent = '有尚未儲存的變更，請先按「儲存草稿」再確認盤點';
    errEl.classList.remove('hidden');
    return;
  }

  const items = currentStocktakeDetail.items;
  const uncounted = items.filter(it => it.countedQty === null);
  if (uncounted.length > 0) {
    errEl.textContent = `尚有 ${uncounted.length} 項商品未輸入實際盤點數量：${uncounted.map(it => it.productName).join('、')}`;
    errEl.classList.remove('hidden');
    return;
  }

  // 二次確認：清楚列出每一項有差異的商品與差異數量，讓使用者確認送出前看得到實際會被
  // 調整的內容，不是只有一句籠統的「確定嗎？」——改用共用確認對話框，內容維持原本的逐項
  // 差異明細（每一段動態文字都先用escAdminHtml()跳脫過才組進messageHtml，避免商品名稱
  // 裡萬一有特殊字元被解析成HTML標籤）。
  const changed = items.filter(it => it.diffQty !== 0);
  let messageHtml;
  if (changed.length === 0) {
    messageHtml = escAdminHtml('確定要確認這張盤點單嗎？所有商品的盤點結果都與系統庫存相同，不會調整任何庫存。');
  } else {
    const lines = changed.map(it => {
      const newQty = it.systemQty + it.diffQty;
      const action = it.diffQty > 0 ? '增加' : '減少';
      return escAdminHtml(`${it.productName}：${it.systemQty} → ${newQty}（${action} ${Math.abs(it.diffQty)}）`);
    });
    messageHtml = `確定要送出這張盤點單嗎？以下商品的庫存將被調整：<br><br>${lines.join('<br>')}<br><br>沒有列出的商品盤點結果與系統庫存相同，不會被調整。`;
  }
  const { confirmed } = await adminConfirmDialog({ title: '確認盤點', messageHtml, danger: true, confirmLabel: '確認送出' });
  if (!confirmed) return;

  const saveBtn = document.getElementById('stocktake-save-btn');
  const confirmBtn = document.getElementById('stocktake-confirm-btn');
  saveBtn.disabled = true;
  confirmBtn.disabled = true;

  try {
    const resp = await adminFetch(`/api/admin/stocktakes/${encodeURIComponent(currentStocktakeDetail.id)}/confirm`, { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      if (data && data.mismatches) {
        const detailText = data.mismatches.map(m => `${m.productName}：建立盤點時 ${m.snapshotQty}／目前 ${m.currentQty}`).join('、');
        errEl.textContent = `${data.error}（${detailText}）`;
      } else {
        errEl.textContent = (data && data.error) || '確認盤點失敗';
      }
      errEl.classList.remove('hidden');
      return;
    }
    currentStocktakeDetail = data.stocktake;
    renderStocktakeDraft(currentStocktakeDetail);
    showAdminToast(data.alreadyConfirmed ? '此盤點單先前已經確認過，庫存未再次調整' : '盤點已確認，庫存已更新');
    loadDashboard();
  } catch (e) {
    errEl.textContent = '確認盤點失敗：' + e.message;
    errEl.classList.remove('hidden');
  } finally {
    saveBtn.disabled = false;
    confirmBtn.disabled = false;
  }
}

// ─── 歷史盤點：唯讀清單與明細，不提供刪除或修改既有紀錄的功能 ──────────────
let stocktakeHistoryPage = 1;
const STOCKTAKE_HISTORY_PAGE_SIZE = 20;
function openStocktakeHistory() {
  document.getElementById('stocktake-history-overlay').classList.remove('hidden');
  document.getElementById('stocktake-history-detail').classList.add('hidden');
  loadStocktakeHistory(1);
}

function closeStocktakeHistory() {
  document.getElementById('stocktake-history-overlay').classList.add('hidden');
}

function showStocktakeHistoryState(name) {
  ['loading', 'error', 'empty', 'list'].forEach(s => {
    document.getElementById(`stocktake-history-${s}`).classList.toggle('hidden', s !== name);
  });
}

// 後端 GET /stocktakes 本來就已經支援page／pageSize分頁參數（回傳total/page/pageSize），
// 只是原本前端固定寫死pageSize=50、完全沒有翻頁功能，超過50筆的較舊盤點紀錄會直接看不到。
// 這裡改成串接既有的分頁參數，不需要改動後端。
async function loadStocktakeHistory(page) {
  showStocktakeHistoryState('loading');
  document.getElementById('stocktake-history-detail').classList.add('hidden');
  const p = Math.max(1, page || 1);
  try {
    const resp = await adminFetch(`/api/admin/stocktakes?page=${p}&pageSize=${STOCKTAKE_HISTORY_PAGE_SIZE}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      document.getElementById('stocktake-history-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      showStocktakeHistoryState('error');
      return;
    }
    stocktakeHistoryList = data.stocktakes || [];
    stocktakeHistoryPage = data.page || p;
    const totalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || STOCKTAKE_HISTORY_PAGE_SIZE)));
    renderStocktakeHistoryList(stocktakeHistoryList);
    renderAdminPagination(document.getElementById('stocktake-history-pagination'), {
      page: stocktakeHistoryPage, totalPages, onChange: newPage => loadStocktakeHistory(newPage)
    });
  } catch (e) {
    document.getElementById('stocktake-history-error-text').textContent = '讀取失敗：' + e.message;
    showStocktakeHistoryState('error');
  }
}

// 所有動態資料一律用 textContent 賦值、DOM API 逐筆建立節點，不使用 innerHTML 寫入，避免 XSS
// （跟既有庫存異動紀錄清單同一套寫法）。
function renderStocktakeHistoryList(list) {
  const listEl = document.getElementById('stocktake-history-list');
  listEl.textContent = '';

  if (!list.length) {
    showStocktakeHistoryState('empty');
    return;
  }

  list.forEach(s => {
    const li = document.createElement('li');
    li.className = 'inventory-log-item';
    li.style.cursor = 'pointer';

    const line = document.createElement('div');
    line.className = 'inventory-log-qty-line';
    const idEl = document.createElement('span');
    idEl.className = 'inventory-log-qty';
    idEl.textContent = `${s.id}（${STOCKTAKE_STATUS_LABELS[s.status] || s.status}）`;
    const timeEl = document.createElement('span');
    timeEl.className = 'inventory-log-time';
    timeEl.textContent = fmtDashTime(s.createdAt);
    line.appendChild(idEl);
    line.appendChild(timeEl);

    const meta = document.createElement('div');
    meta.className = 'inventory-log-reason';
    meta.textContent = `商品項目 ${s.itemCount} 項` + (s.confirmedAt ? `，確認時間 ${fmtDashTime(s.confirmedAt)}` : '');

    li.appendChild(line);
    li.appendChild(meta);

    if (s.note) {
      const noteEl = document.createElement('div');
      noteEl.className = 'inventory-log-note';
      noteEl.textContent = '備註：' + s.note;
      li.appendChild(noteEl);
    }

    li.addEventListener('click', () => openStocktakeHistoryDetail(s.id));
    listEl.appendChild(li);
  });

  showStocktakeHistoryState('list');
}

async function openStocktakeHistoryDetail(id) {
  try {
    const resp = await adminFetch(`/api/admin/stocktakes/${encodeURIComponent(id)}`);
    const data = await resp.json().catch(() => null);
    if (!resp.ok) { showAdminToast((data && data.error) || '讀取失敗', true); return; }
    renderStocktakeHistoryDetail(data.stocktake);
  } catch (e) {
    showAdminToast('讀取失敗：' + e.message, true);
  }
}

function renderStocktakeHistoryDetail(detail) {
  document.getElementById('stocktake-detail-id').textContent = detail.id;
  document.getElementById('stocktake-detail-status').textContent = STOCKTAKE_STATUS_LABELS[detail.status] || detail.status;
  document.getElementById('stocktake-detail-created').textContent = fmtDashTime(detail.createdAt);
  document.getElementById('stocktake-detail-confirmed').textContent = detail.confirmedAt ? fmtDashTime(detail.confirmedAt) : '--';

  const tbody = document.getElementById('stocktake-detail-items-body');
  tbody.innerHTML = detail.items.map(it => `
    <tr>
      <td>${escAdminHtml(it.productCode)}</td>
      <td>${escAdminHtml(it.productName)}</td>
      <td>${safeDashNumber(it.systemQty, 0).toLocaleString()}</td>
      <td>${it.countedQty === null ? '--' : safeDashNumber(it.countedQty, 0).toLocaleString()}</td>
      <td>${fmtStocktakeDiff(it.diffQty)}</td>
    </tr>
  `).join('');

  document.getElementById('stocktake-history-list').classList.add('hidden');
  document.getElementById('stocktake-history-detail').classList.remove('hidden');
}

function backToStocktakeHistoryList() {
  document.getElementById('stocktake-history-detail').classList.add('hidden');
  document.getElementById('stocktake-history-list').classList.remove('hidden');
}
