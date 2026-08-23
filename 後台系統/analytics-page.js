// 楊竹科技後台系統 — 網站分析頁面邏輯
// 第二階段第一批：共用統計API與日期篩選基礎（summary／eventBreakdown／dataRange）。
// 第二階段第二批：新增流量來源分析（traffic）與客製化轉換漏斗（funnel）。
// 第二階段第三批：新增商品／客製化／AI偏好（productPreference）、業務與內部效率
// （operationalEfficiency）、顧客與訂單價值（customerOrderValue）3大區塊。
// 所有動態內容一律用 textContent／DOM API 建立節點，絕不使用 innerHTML 插入 API 資料。
// API 回應在畫出任何內容前一律先嚴格驗證格式，格式不符就整頁顯示「統計資料格式錯誤」，
// 不允許只畫出部分資料造成誤導（沿用 ai-usage-page.js 既有的驗證慣例）。

const ANALYTICS_EVENT_DICTIONARY = [
  'page_view', 'product_view', 'customization_start', 'customization_step_complete',
  'upload_result', 'ai_request', 'ai_result', 'preview_complete',
  'inquiry_form_start', 'inquiry_validation_error', 'inquiry_submit_success', 'contact_click'
];
const ANALYTICS_EVENT_LABELS = {
  page_view: '頁面瀏覽',
  product_view: '商品瀏覽',
  customization_start: '開始客製化',
  customization_step_complete: '完成客製化步驟',
  upload_result: '圖片上傳結果',
  ai_request: 'AI生成請求',
  ai_result: 'AI生成結果',
  preview_complete: '完成預覽',
  inquiry_form_start: '開始填寫詢價',
  inquiry_validation_error: '詢價欄位驗證失敗',
  inquiry_submit_success: '詢價成功',
  contact_click: '點擊聯絡方式'
};
const ANALYTICS_RANGE_PRESET_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

// 客製化轉換漏斗固定8關（跟 admin-routes.js 的 ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS 同一份
// 順序與key，前端只用來驗證回應格式與顯示中文標籤，不參與任何計算）。
const ANALYTICS_FUNNEL_STAGE_KEYS = [
  'visit', 'product_view', 'customization_start', 'specification_complete',
  'design_complete', 'preview_complete', 'inquiry_form_start', 'inquiry_submit_success'
];
const ANALYTICS_FUNNEL_STAGE_LABELS = {
  visit: '進站', product_view: '查看商品', customization_start: '開始客製化',
  specification_complete: '完成規格選擇', design_complete: '完成設計',
  preview_complete: '完成預覽', inquiry_form_start: '開始填寫詢價', inquiry_submit_success: '詢價成功'
};

function onAdminReady() {
  loadAnalyticsOverview();
}

// ─── 基礎型別與格式驗證 ─────────────────────────────────────
function isNonNegInt(v) { return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0; }
function isValidDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function isValidIsoStringOrNull(v) { return v === null || (typeof v === 'string' && !isNaN(Date.parse(v))); }
// 轉換率／流失率／採用率／成功率：分母為0時一律null，不可是0%（誤導成「確定是0」）；
// 有值時必須是0~100之間、四捨五入到小數1位的有限數字。
function isValidPct(v) { return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100); }
function isNonEmptyString(v) { return typeof v === 'string' && v.length > 0; }

function isValidSourceList(list, countKey) {
  if (!Array.isArray(list)) return false;
  const seenKeys = new Set();
  for (const row of list) {
    if (!row || typeof row !== 'object') return false;
    if (!isNonEmptyString(row.sourceKey) || !isNonEmptyString(row.sourceLabel)) return false;
    if (!isNonNegInt(row[countKey])) return false;
    if (seenKeys.has(row.sourceKey)) return false; // 同一sourceKey不可出現兩次
    seenKeys.add(row.sourceKey);
  }
  return true;
}

function isValidTrafficBlock(traffic) {
  if (!traffic || typeof traffic !== 'object') return false;
  if (!isNonNegInt(traffic.newVisitorCount) || !isNonNegInt(traffic.returningVisitorCount)) return false;
  if (!isValidSourceList(traffic.firstTouchSources, 'visitorCount')) return false;
  if (!isValidSourceList(traffic.lastTouchBeforeInquirySources, 'inquiryCount')) return false;
  if (!Array.isArray(traffic.landingPages)) return false;
  for (const row of traffic.landingPages) {
    if (!row || typeof row !== 'object') return false;
    if (!isNonEmptyString(row.landingPath)) return false;
    if (!isNonNegInt(row.sessionCount)) return false;
  }
  if (!Array.isArray(traffic.devices) || traffic.devices.length !== 4) return false;
  const expectedDevices = ['mobile', 'tablet', 'desktop', 'unknown'];
  for (let i = 0; i < traffic.devices.length; i++) {
    const row = traffic.devices[i];
    if (!row || typeof row !== 'object') return false;
    if (row.device !== expectedDevices[i]) return false; // 固定順序
    if (!isNonNegInt(row.sessionCount)) return false;
  }
  if (!isNonNegInt(traffic.unattributedInquiryCount)) return false;
  return true;
}

function isValidFunnelBlock(funnel) {
  if (!funnel || typeof funnel !== 'object') return false;
  if (funnel.unit !== 'sessions') return false;
  if (!Array.isArray(funnel.stages) || funnel.stages.length !== ANALYTICS_FUNNEL_STAGE_KEYS.length) return false;
  for (let i = 0; i < funnel.stages.length; i++) {
    const st = funnel.stages[i];
    if (!st || typeof st !== 'object') return false;
    if (st.stageKey !== ANALYTICS_FUNNEL_STAGE_KEYS[i]) return false; // 順序必須固定
    if (typeof st.label !== 'string' || !st.label) return false;
    if (!isNonNegInt(st.count)) return false;
    if (!isNonNegInt(st.dropOffCount)) return false;
    if (i === 0) {
      if (st.conversionFromPreviousPct !== null || st.dropOffRatePct !== null) return false; // 第一關固定null
    } else {
      if (!isValidPct(st.conversionFromPreviousPct)) return false;
      if (!isValidPct(st.dropOffRatePct)) return false;
    }
  }
  const ab = funnel.aiBranch;
  if (!ab || typeof ab !== 'object') return false;
  if (!isNonNegInt(ab.requestSessionCount) || !isNonNegInt(ab.successSessionCount)) return false;
  if (!isValidPct(ab.adoptionRatePct) || !isValidPct(ab.successRatePct)) return false;
  if (!isNonNegInt(funnel.unlinkedInquiryCount)) return false;
  return true;
}

// ─── 第二階段第三批：商品／客製化／AI偏好、業務與內部效率、顧客與訂單價值 ─────────
const ANALYTICS_AI_FEATURE_KEYS = ['generate_image', 'generate_design', 'black_card_pattern', 'cartoon_image'];
const ANALYTICS_AI_FEATURE_LABELS = {
  generate_image: 'AI生成圖片', generate_design: 'AI設計文案', black_card_pattern: '黑卡圖案候選', cartoon_image: 'Q版卡通化'
};
const ANALYTICS_TIMING_KEYS = ['inquiryToFirstQuote', 'quotedToClosedWon', 'closedWonToInProduction', 'inProductionToShipped', 'inquiryToShippedTotal'];
const ANALYTICS_TIMING_LABELS = {
  inquiryToFirstQuote: '詢價到首次報價', quotedToClosedWon: '報價到成交',
  closedWonToInProduction: '成交到開始生產', inProductionToShipped: '生產到出貨', inquiryToShippedTotal: '詢價到出貨（總計）'
};
const ANALYTICS_DAYS_BUCKET_KEYS = ['0-30', '31-90', '91-180', '181-365', '365+'];

function isValidNonNegNumberOrNull(v) { return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0); }

function isValidTimingBlock(t) {
  if (!t || typeof t !== 'object') return false;
  if (!isNonNegInt(t.sampleCount) || !isNonNegInt(t.invalidCount)) return false;
  const fields = [t.medianMs, t.meanMs, t.minMs, t.maxMs];
  if (t.sampleCount === 0) return fields.every(v => v === null);
  return fields.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

function isValidProductPreferenceBlock(pp) {
  if (!pp || typeof pp !== 'object') return false;
  if (!Array.isArray(pp.products)) return false;
  for (const p of pp.products) {
    if (!p || typeof p !== 'object') return false;
    if (!isNonEmptyString(p.productId) || !isNonEmptyString(p.productName) || !isNonEmptyString(p.productStatus)) return false;
    if (typeof p.archived !== 'boolean') return false;
    if (!isNonNegInt(p.productViewSessionCount) || !isNonNegInt(p.customizationStartSessionCount) ||
        !isNonNegInt(p.previewCompleteSessionCount) || !isNonNegInt(p.inquiryOrderCount) ||
        !isNonNegInt(p.linkedInquirySessionCount) || !isNonNegInt(p.unlinkedInquiryOrderCount)) return false;
    if (!isValidPct(p.productViewToCustomizationStartPct) || !isValidPct(p.customizationStartToPreviewPct) ||
        !isValidPct(p.previewToInquiryPct) || !isValidPct(p.overallProductViewToInquiryPct)) return false;
    if (p.highViewLowInquiry !== null && typeof p.highViewLowInquiry !== 'boolean') return false;
    if (p.highInquiryLowExposure !== null && typeof p.highInquiryLowExposure !== 'boolean') return false;
  }
  const cap = pp.customizationAiPreference;
  if (!cap || typeof cap !== 'object') return false;
  if (!isNonNegInt(cap.specificationCompleteSessionCount) || !isNonNegInt(cap.designCompleteSessionCount)) return false;
  if (!cap.upload || typeof cap.upload !== 'object') return false;
  if (!isNonNegInt(cap.upload.successCount) || !isNonNegInt(cap.upload.failureCount)) return false;
  if (!Array.isArray(cap.upload.errorBreakdown)) return false;
  for (const row of cap.upload.errorBreakdown) {
    if (!row || typeof row !== 'object' || !isNonEmptyString(row.category) || !isNonNegInt(row.count)) return false;
  }
  if (!Array.isArray(cap.aiByFeature) || cap.aiByFeature.length !== ANALYTICS_AI_FEATURE_KEYS.length) return false;
  for (let i = 0; i < cap.aiByFeature.length; i++) {
    const row = cap.aiByFeature[i];
    if (!row || typeof row !== 'object' || row.featureKey !== ANALYTICS_AI_FEATURE_KEYS[i]) return false;
    if (!isNonNegInt(row.requestCount) || !isNonNegInt(row.successCount) || !isNonNegInt(row.partialCount) ||
        !isNonNegInt(row.failureCount) || !isNonNegInt(row.unlinkedResultCount)) return false;
    if (!isValidPct(row.successRatePct)) return false;
    if (row.successCount + row.partialCount + row.failureCount > row.requestCount) return false; // 結果總數不得大於請求數
  }
  if (!Array.isArray(cap.notCollected) || !cap.notCollected.every(s => typeof s === 'string')) return false;
  return true;
}

function isValidOperationalEfficiencyBlock(oe) {
  if (!oe || typeof oe !== 'object') return false;
  if (!oe.population || typeof oe.population !== 'object' || !isNonNegInt(oe.population.orderCount)) return false;
  if (!oe.timings || typeof oe.timings !== 'object') return false;
  for (const k of ANALYTICS_TIMING_KEYS) { if (!isValidTimingBlock(oe.timings[k])) return false; }
  if (!isNonNegInt(oe.cancelledCount) || !isValidPct(oe.cancelRatePct)) return false;
  if (!Array.isArray(oe.currentBacklog)) return false;
  for (const row of oe.currentBacklog) {
    if (!row || typeof row !== 'object' || !isNonEmptyString(row.status) || !isNonEmptyString(row.label) || !isNonNegInt(row.count)) return false;
  }
  if (!isNonNegInt(oe.overdueCount)) return false;
  if (!Array.isArray(oe.notCollected) || !oe.notCollected.every(s => typeof s === 'string')) return false;
  return true;
}

function isValidCustomerOrderValueBlock(cv) {
  if (!cv || typeof cv !== 'object') return false;
  if (!isNonNegInt(cv.dealOrderCount) || !isNonNegInt(cv.dealCustomerCount) ||
      !isNonNegInt(cv.newCustomerCount) || !isNonNegInt(cv.returningCustomerCount)) return false;
  if (!isValidPct(cv.repurchaseRatePct)) return false;
  if (!isValidNonNegNumberOrNull(cv.avgDealAmount) || !isValidNonNegNumberOrNull(cv.medianDealAmount)) return false;
  if (typeof cv.cumulativeDealAmount !== 'number' || !Number.isFinite(cv.cumulativeDealAmount) || cv.cumulativeDealAmount < 0) return false;
  if (!isValidNonNegNumberOrNull(cv.avgDealsPerCustomer)) return false;
  if (!Array.isArray(cv.daysSinceLastDealDistribution) || cv.daysSinceLastDealDistribution.length !== ANALYTICS_DAYS_BUCKET_KEYS.length) return false;
  for (let i = 0; i < cv.daysSinceLastDealDistribution.length; i++) {
    const row = cv.daysSinceLastDealDistribution[i];
    if (!row || typeof row !== 'object' || row.bucket !== ANALYTICS_DAYS_BUCKET_KEYS[i]) return false;
    if (!isNonEmptyString(row.label) || !isNonNegInt(row.customerCount)) return false;
  }
  if (!isNonNegInt(cv.closedWonAtUnknownCount) || !isNonNegInt(cv.amountAnomalyCount)) return false;
  return true;
}

function isValidOverviewResponse(data) {
  if (!data || typeof data !== 'object') return false;
  if (!data.period || typeof data.period !== 'object') return false;
  if (!isValidDateString(data.period.from) || !isValidDateString(data.period.to)) return false;
  if (data.period.timezone !== 'Asia/Taipei') return false;

  const s = data.summary;
  if (!s || typeof s !== 'object') return false;
  const summaryFields = ['eventCount', 'visitorCount', 'sessionCount', 'inquiryCount', 'aiRequestCount', 'aiSuccessCount'];
  if (!summaryFields.every(k => isNonNegInt(s[k]))) return false;

  if (!Array.isArray(data.eventBreakdown) || data.eventBreakdown.length !== ANALYTICS_EVENT_DICTIONARY.length) return false;
  for (let i = 0; i < data.eventBreakdown.length; i++) {
    const row = data.eventBreakdown[i];
    if (!row || typeof row !== 'object') return false;
    if (row.eventName !== ANALYTICS_EVENT_DICTIONARY[i]) return false; // 順序必須固定，不可隨機
    if (!isNonNegInt(row.count)) return false;
  }

  if (!data.dataRange || typeof data.dataRange !== 'object') return false;
  if (!isValidIsoStringOrNull(data.dataRange.earliestOccurredAt)) return false;
  if (!isValidIsoStringOrNull(data.dataRange.latestOccurredAt)) return false;

  if (!isValidTrafficBlock(data.traffic)) return false;
  if (!isValidFunnelBlock(data.funnel)) return false;
  if (!isValidProductPreferenceBlock(data.productPreference)) return false;
  if (!isValidOperationalEfficiencyBlock(data.operationalEfficiency)) return false;
  if (!isValidCustomerOrderValueBlock(data.customerOrderValue)) return false;

  return true;
}

// ─── 台北日曆日期工具（前端只用來組出 from／to 查詢參數，實際範圍判斷一律以後端為準）──
function taipeiTodayDateString() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = {};
  parts.forEach(p => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day}`;
}
function addDaysToDateString(s, delta) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d) + delta * 86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function onAnalyticsRangeChange() {
  const range = document.getElementById('analytics-filter-range').value;
  const wrap = document.getElementById('analytics-custom-range-wrap');
  if (range === 'custom') {
    wrap.classList.remove('hidden');
    const fromInput = document.getElementById('analytics-custom-from');
    const toInput = document.getElementById('analytics-custom-to');
    if (!fromInput.value || !toInput.value) {
      const today = taipeiTodayDateString();
      toInput.value = today;
      fromInput.value = addDaysToDateString(today, -29);
    }
  } else {
    wrap.classList.add('hidden');
  }
  loadAnalyticsOverview();
}

// 請求序號：避免使用者快速切換日期時，先送出的舊請求比後送出的新請求還晚回來，
// 用舊資料覆蓋掉畫面上已經顯示的新日期結果。
let analyticsRequestSeq = 0;
let analyticsLastData = null; // 最近一次成功載入的完整回應（summary／eventBreakdown／period），供匯出Excel使用

async function loadAnalyticsOverview() {
  const mySeq = ++analyticsRequestSeq;
  const btn = document.getElementById('analytics-refresh-btn');
  const statusEl = document.getElementById('analytics-status');
  const contentEl = document.getElementById('analytics-content');

  const range = document.getElementById('analytics-filter-range').value;
  const qs = new URLSearchParams();
  if (range === 'custom') {
    const from = document.getElementById('analytics-custom-from').value;
    const to = document.getElementById('analytics-custom-to').value;
    if (!isValidDateString(from) || !isValidDateString(to)) {
      // mySeq 在函式一開始已經遞增，所以就算前一筆請求還在進行中，這裡也已經讓它的回應失效
      // （前一筆的 finally 比對 mySeq !== analyticsRequestSeq 會直接略過，不會覆蓋畫面）；
      // 但因為這個分支自己完全不送出新的API請求，也不會再有屬於這個mySeq的finally區塊來
      // 恢復按鈕，必須在這裡自己明確恢復，否則按鈕會維持在前一筆請求設定的「停用」狀態。
      if (btn) { btn.disabled = false; btn.textContent = '重新整理'; }
      statusEl.textContent = '請選擇正確的自訂日期範圍';
      statusEl.classList.remove('hidden');
      contentEl.classList.add('hidden');
      return;
    }
    qs.set('from', from);
    qs.set('to', to);
  } else if (Object.prototype.hasOwnProperty.call(ANALYTICS_RANGE_PRESET_DAYS, range)) {
    const today = taipeiTodayDateString();
    qs.set('to', today);
    qs.set('from', addDaysToDateString(today, -(ANALYTICS_RANGE_PRESET_DAYS[range] - 1)));
  }

  if (btn) { btn.disabled = true; btn.textContent = '載入中…'; }
  statusEl.textContent = '載入中…';
  statusEl.classList.remove('hidden');
  contentEl.classList.add('hidden');

  try {
    const resp = await adminFetch('/api/admin/analytics/overview' + (qs.toString() ? '?' + qs.toString() : ''));
    const data = await resp.json().catch(() => null);
    if (mySeq !== analyticsRequestSeq) return; // 已經有更新的請求送出，這筆回應過期，直接忽略

    if (!resp.ok) {
      statusEl.textContent = (data && data.error) || '載入失敗，請稍後再試';
      return;
    }
    if (!isValidOverviewResponse(data)) {
      statusEl.textContent = '統計資料格式錯誤';
      return;
    }
    analyticsLastData = data; // 供「匯出Excel」使用，避免匯出時要再打一次API、也保證匯出內容跟畫面上顯示的完全一致
    renderAnalyticsOverview(data);
    statusEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  } catch (e) {
    if (mySeq !== analyticsRequestSeq) return;
    statusEl.textContent = '載入失敗：' + e.message;
  } finally {
    if (mySeq === analyticsRequestSeq && btn) {
      btn.disabled = false;
      btn.textContent = '重新整理';
    }
  }
}

// ─── 顯示格式化與畫面渲染 ─────────────────────────────────
function fmtCount(n) { return isNonNegInt(n) ? n.toLocaleString() : '--'; }
function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function tableCell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function fmtTaipeiDateTime(iso) {
  if (!iso) return '--';
  try { return new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }); }
  catch { return iso; }
}

function fmtPct(v) { return v === null ? '資料不足' : `${v}%`; }

// 時間長度依適合單位顯示：60分鐘內用分鐘，48小時內用小時，其餘用天（四捨五入到小數1位）。
function fmtDuration(ms) {
  if (ms === null) return '資料不足';
  const minutes = ms / 60000;
  if (minutes < 60) return `${Math.round(minutes)} 分鐘`;
  const hours = ms / 3600000;
  if (hours < 48) return `${Math.round(hours * 10) / 10} 小時`;
  return `${Math.round(ms / 86400000 * 10) / 10} 天`;
}
function fmtMoney(n) { return (n === null) ? '資料不足' : `NT$ ${Math.round(n).toLocaleString()}`; }
function fmtFlag(v) { return v === null ? '樣本不足' : (v ? '是' : '否'); }

// 純CSS水平長條列表（流量來源／裝置分布共用）：寬度只代表「相對這份清單裡最大值」的比例，
// 用inline style.width設定（不是innerHTML插資料），名稱與數字一律另外用textContent顯示。
function renderHbarList(container, rows, labelFn, valueFn) {
  clearChildren(container);
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'color:var(--gray-400);font-size:12.5px;margin:6px 0;';
    empty.textContent = '目前沒有資料';
    container.appendChild(empty);
    return;
  }
  const maxValue = Math.max(1, ...rows.map(valueFn));
  rows.forEach(row => {
    const value = valueFn(row);
    const rowEl = document.createElement('div');
    rowEl.className = 'hbar-row';

    const labelEl = document.createElement('div');
    labelEl.className = 'hbar-label';
    labelEl.textContent = labelFn(row);
    labelEl.title = labelFn(row);

    const trackEl = document.createElement('div');
    trackEl.className = 'hbar-track';
    const fillEl = document.createElement('div');
    fillEl.className = 'hbar-fill';
    fillEl.style.width = `${Math.max(1, Math.round(value / maxValue * 100))}%`;
    trackEl.appendChild(fillEl);

    const valueEl = document.createElement('div');
    valueEl.className = 'hbar-value';
    valueEl.textContent = fmtCount(value);

    rowEl.appendChild(labelEl);
    rowEl.appendChild(trackEl);
    rowEl.appendChild(valueEl);
    container.appendChild(rowEl);
  });
}

const ANALYTICS_DEVICE_LABELS = { mobile: '手機', tablet: '平板', desktop: '桌機', unknown: '未知' };

function renderAnalyticsTraffic(traffic) {
  document.getElementById('analytics-stat-newVisitorCount').textContent = fmtCount(traffic.newVisitorCount);
  document.getElementById('analytics-stat-returningVisitorCount').textContent = fmtCount(traffic.returningVisitorCount);
  document.getElementById('analytics-stat-unattributedInquiryCount').textContent = fmtCount(traffic.unattributedInquiryCount);

  renderHbarList(document.getElementById('analytics-firsttouch-list'), traffic.firstTouchSources, r => r.sourceLabel, r => r.visitorCount);
  renderHbarList(document.getElementById('analytics-lasttouch-list'), traffic.lastTouchBeforeInquirySources, r => r.sourceLabel, r => r.inquiryCount);
  renderHbarList(document.getElementById('analytics-devices-list'), traffic.devices, r => ANALYTICS_DEVICE_LABELS[r.device] || r.device, r => r.sessionCount);

  const tbody = document.getElementById('analytics-landingpages-body');
  clearChildren(tbody);
  if (!traffic.landingPages.length) {
    tbody.appendChild((() => {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 2; td.style.textAlign = 'center'; td.style.color = 'var(--gray-400)'; td.style.padding = '20px';
      td.textContent = '目前沒有資料';
      tr.appendChild(td);
      return tr;
    })());
  } else {
    traffic.landingPages.forEach(row => {
      const tr = document.createElement('tr');
      tr.appendChild(tableCell(row.landingPath));
      tr.appendChild(tableCell(fmtCount(row.sessionCount)));
      tbody.appendChild(tr);
    });
  }
}

function renderAnalyticsFunnel(funnel) {
  const tbody = document.getElementById('analytics-funnel-body');
  clearChildren(tbody);
  funnel.stages.forEach(st => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(ANALYTICS_FUNNEL_STAGE_LABELS[st.stageKey] || st.label));
    tr.appendChild(tableCell(fmtCount(st.count)));
    tr.appendChild(tableCell(fmtPct(st.conversionFromPreviousPct)));
    tr.appendChild(tableCell(fmtCount(st.dropOffCount)));
    tr.appendChild(tableCell(fmtPct(st.dropOffRatePct)));
    tbody.appendChild(tr);
  });

  const ab = funnel.aiBranch;
  document.getElementById('analytics-stat-aiBranchRequestSessionCount').textContent = fmtCount(ab.requestSessionCount);
  document.getElementById('analytics-stat-aiBranchSuccessSessionCount').textContent = fmtCount(ab.successSessionCount);
  document.getElementById('analytics-stat-aiBranchAdoptionRatePct').textContent = fmtPct(ab.adoptionRatePct);
  document.getElementById('analytics-stat-aiBranchSuccessRatePct').textContent = fmtPct(ab.successRatePct);
  document.getElementById('analytics-stat-unlinkedInquiryCount').textContent = fmtCount(funnel.unlinkedInquiryCount);
}

function renderAnalyticsProductPreference(pp) {
  const tbody = document.getElementById('analytics-productpref-body');
  clearChildren(tbody);
  if (!pp.products.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12; td.style.textAlign = 'center'; td.style.color = 'var(--gray-400)'; td.style.padding = '20px';
    td.textContent = '目前期間內沒有商品瀏覽資料';
    tr.appendChild(td);
    tbody.appendChild(tr);
  } else {
    pp.products.forEach(p => {
      const tr = document.createElement('tr');
      const nameCell = tableCell(p.productName + (p.archived ? '（已封存）' : ''));
      tr.appendChild(nameCell);
      tr.appendChild(tableCell(fmtCount(p.productViewSessionCount)));
      tr.appendChild(tableCell(fmtCount(p.customizationStartSessionCount)));
      tr.appendChild(tableCell(fmtCount(p.previewCompleteSessionCount)));
      tr.appendChild(tableCell(fmtCount(p.inquiryOrderCount)));
      tr.appendChild(tableCell(fmtCount(p.linkedInquirySessionCount)));
      tr.appendChild(tableCell(fmtCount(p.unlinkedInquiryOrderCount)));
      tr.appendChild(tableCell(fmtPct(p.productViewToCustomizationStartPct)));
      tr.appendChild(tableCell(fmtPct(p.customizationStartToPreviewPct)));
      tr.appendChild(tableCell(fmtPct(p.previewToInquiryPct)));
      tr.appendChild(tableCell(fmtPct(p.overallProductViewToInquiryPct)));
      tr.appendChild(tableCell(`高瀏覽低詢價：${fmtFlag(p.highViewLowInquiry)}／曝光不足高詢價：${fmtFlag(p.highInquiryLowExposure)}`));
      tbody.appendChild(tr);
    });
  }

  const cap = pp.customizationAiPreference;
  document.getElementById('analytics-stat-specCompleteCount').textContent = fmtCount(cap.specificationCompleteSessionCount);
  document.getElementById('analytics-stat-designCompleteCount').textContent = fmtCount(cap.designCompleteSessionCount);
  document.getElementById('analytics-stat-uploadSuccessCount').textContent = fmtCount(cap.upload.successCount);
  document.getElementById('analytics-stat-uploadFailureCount').textContent = fmtCount(cap.upload.failureCount);

  const errBody = document.getElementById('analytics-uploaderror-body');
  clearChildren(errBody);
  if (!cap.upload.errorBreakdown.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2; td.style.textAlign = 'center'; td.style.color = 'var(--gray-400)'; td.style.padding = '14px';
    td.textContent = '目前沒有上傳失敗紀錄';
    tr.appendChild(td);
    errBody.appendChild(tr);
  } else {
    cap.upload.errorBreakdown.forEach(row => {
      const tr = document.createElement('tr');
      tr.appendChild(tableCell(row.category));
      tr.appendChild(tableCell(fmtCount(row.count)));
      errBody.appendChild(tr);
    });
  }

  const aiBody = document.getElementById('analytics-aibyfeature-body');
  clearChildren(aiBody);
  cap.aiByFeature.forEach(row => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(ANALYTICS_AI_FEATURE_LABELS[row.featureKey] || row.featureKey));
    tr.appendChild(tableCell(fmtCount(row.requestCount)));
    tr.appendChild(tableCell(fmtCount(row.successCount)));
    tr.appendChild(tableCell(fmtCount(row.partialCount)));
    tr.appendChild(tableCell(fmtCount(row.failureCount)));
    tr.appendChild(tableCell(fmtPct(row.successRatePct)));
    tr.appendChild(tableCell(fmtCount(row.unlinkedResultCount)));
    aiBody.appendChild(tr);
  });

  const noteEl = document.getElementById('analytics-productpref-notcollected');
  clearChildren(noteEl);
  cap.notCollected.forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    noteEl.appendChild(li);
  });
}

function renderAnalyticsOperationalEfficiency(oe) {
  const timingBody = document.getElementById('analytics-timing-body');
  clearChildren(timingBody);
  ANALYTICS_TIMING_KEYS.forEach(key => {
    const t = oe.timings[key];
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(ANALYTICS_TIMING_LABELS[key]));
    tr.appendChild(tableCell(fmtCount(t.sampleCount)));
    tr.appendChild(tableCell(fmtDuration(t.medianMs)));
    tr.appendChild(tableCell(fmtDuration(t.meanMs)));
    tr.appendChild(tableCell(fmtDuration(t.minMs)));
    tr.appendChild(tableCell(fmtDuration(t.maxMs)));
    tr.appendChild(tableCell(fmtCount(t.invalidCount)));
    timingBody.appendChild(tr);
  });

  document.getElementById('analytics-stat-cancelledCount').textContent = fmtCount(oe.cancelledCount);
  document.getElementById('analytics-stat-cancelRatePct').textContent = fmtPct(oe.cancelRatePct);
  document.getElementById('analytics-stat-overdueCount').textContent = fmtCount(oe.overdueCount);
  document.getElementById('analytics-stat-efficiencyPopulation').textContent = fmtCount(oe.population.orderCount);

  const backlogBody = document.getElementById('analytics-backlog-body');
  clearChildren(backlogBody);
  oe.currentBacklog.forEach(row => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(row.label));
    tr.appendChild(tableCell(fmtCount(row.count)));
    backlogBody.appendChild(tr);
  });

  const noteEl = document.getElementById('analytics-efficiency-notcollected');
  clearChildren(noteEl);
  oe.notCollected.forEach(text => {
    const li = document.createElement('li');
    li.textContent = text;
    noteEl.appendChild(li);
  });
}

function renderAnalyticsCustomerOrderValue(cv) {
  document.getElementById('analytics-stat-dealOrderCount').textContent = fmtCount(cv.dealOrderCount);
  document.getElementById('analytics-stat-dealCustomerCount').textContent = fmtCount(cv.dealCustomerCount);
  document.getElementById('analytics-stat-newCustomerCount').textContent = fmtCount(cv.newCustomerCount);
  document.getElementById('analytics-stat-returningCustomerCount').textContent = fmtCount(cv.returningCustomerCount);
  document.getElementById('analytics-stat-repurchaseRatePct').textContent = fmtPct(cv.repurchaseRatePct);
  document.getElementById('analytics-stat-avgDealAmount').textContent = fmtMoney(cv.avgDealAmount);
  document.getElementById('analytics-stat-medianDealAmount').textContent = fmtMoney(cv.medianDealAmount);
  document.getElementById('analytics-stat-cumulativeDealAmount').textContent = fmtMoney(cv.cumulativeDealAmount);
  document.getElementById('analytics-stat-avgDealsPerCustomer').textContent = cv.avgDealsPerCustomer === null ? '資料不足' : cv.avgDealsPerCustomer;
  document.getElementById('analytics-stat-closedWonAtUnknownCount').textContent = fmtCount(cv.closedWonAtUnknownCount);

  const daysBody = document.getElementById('analytics-daysdistribution-body');
  clearChildren(daysBody);
  cv.daysSinceLastDealDistribution.forEach(row => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(row.label));
    tr.appendChild(tableCell(fmtCount(row.customerCount)));
    daysBody.appendChild(tr);
  });
}

function renderAnalyticsOverview(data) {
  document.getElementById('analytics-period-label').textContent =
    `資料期間：${data.period.from} ～ ${data.period.to}（${data.period.timezone}）`;

  const s = data.summary;
  document.getElementById('analytics-stat-eventCount').textContent = fmtCount(s.eventCount);
  document.getElementById('analytics-stat-visitorCount').textContent = fmtCount(s.visitorCount);
  document.getElementById('analytics-stat-sessionCount').textContent = fmtCount(s.sessionCount);
  document.getElementById('analytics-stat-inquiryCount').textContent = fmtCount(s.inquiryCount);
  document.getElementById('analytics-stat-aiRequestCount').textContent = fmtCount(s.aiRequestCount);
  document.getElementById('analytics-stat-aiSuccessCount').textContent = fmtCount(s.aiSuccessCount);

  const tbody = document.getElementById('analytics-eventbreakdown-body');
  clearChildren(tbody);
  data.eventBreakdown.forEach(row => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(ANALYTICS_EVENT_LABELS[row.eventName] || row.eventName));
    tr.appendChild(tableCell(fmtCount(row.count)));
    tbody.appendChild(tr);
  });

  renderAnalyticsTraffic(data.traffic);
  renderAnalyticsFunnel(data.funnel);
  renderAnalyticsProductPreference(data.productPreference);
  renderAnalyticsOperationalEfficiency(data.operationalEfficiency);
  renderAnalyticsCustomerOrderValue(data.customerOrderValue);

  const dr = data.dataRange;
  const dataRangeLabel = document.getElementById('analytics-datarange-label');
  dataRangeLabel.textContent = (dr.earliestOccurredAt && dr.latestOccurredAt)
    ? `全部歷史資料期間：${fmtTaipeiDateTime(dr.earliestOccurredAt)} ～ ${fmtTaipeiDateTime(dr.latestOccurredAt)}`
    : '目前資料庫尚無任何分析事件';
}

// ─── 匯出Excel（畫面上「網站分析」頁全部資料，含流量來源／轉換漏斗／商品偏好／
// 業務與內部效率／顧客訂單價值，不只是最上面的摘要卡片）─────────────────
// 使用者原本要求只匯出摘要卡片＋事件明細，後來改成要「所有數據資料都下載」，
// 所以這裡把 renderAnalyticsOverview() 畫出來的每一個子區塊都各自整理成一份表格
// 一起送出，不重新呼叫API——理由跟之前一樣：畫面上看到的內容要跟下載的內容保證
// 一致，全部從已經載入的 analyticsLastData 現算，不會跟畫面對不上。
// 「重點摘要」是純前端計算，算法很單純（比例、最大值），沒有牽涉任何後端才有的資料。
function computeAnalyticsInsightRows(data) {
  const s = data.summary;
  const rows = [];
  rows.push(['資料期間', `${data.period.from} ～ ${data.period.to}（${data.period.timezone}）`]);
  rows.push(['事件總數', `${fmtCount(s.eventCount)} 筆`]);
  rows.push(['不重複訪客', `${fmtCount(s.visitorCount)} 人`]);
  rows.push(['不重複造訪（session）', `${fmtCount(s.sessionCount)} 次`]);

  if (s.visitorCount > 0) {
    const avgEventsPerVisitor = (s.eventCount / s.visitorCount).toFixed(1);
    rows.push(['平均每位訪客事件數', `約 ${avgEventsPerVisitor} 筆（事件總數 ÷ 不重複訪客，粗略概念，非嚴謹漏斗指標）`]);
  }

  rows.push(['詢價成功', `${fmtCount(s.inquiryCount)} 筆`]);

  if (s.aiRequestCount > 0) {
    const aiSuccessRate = ((s.aiSuccessCount / s.aiRequestCount) * 100).toFixed(1);
    rows.push(['AI生成請求／成功', `${fmtCount(s.aiRequestCount)} / ${fmtCount(s.aiSuccessCount)}（成功率 ${aiSuccessRate}%）`]);
  } else {
    rows.push(['AI生成請求／成功', '本期間內無AI生成請求']);
  }

  const nonZeroEvents = data.eventBreakdown.filter(r => r.count > 0);
  if (nonZeroEvents.length) {
    const top = nonZeroEvents.reduce((a, b) => (b.count > a.count ? b : a));
    const label = ANALYTICS_EVENT_LABELS[top.eventName] || top.eventName;
    const pct = s.eventCount > 0 ? ((top.count / s.eventCount) * 100).toFixed(1) : '0';
    rows.push(['筆數最多的事件類型', `${label}（${fmtCount(top.count)} 筆，佔事件總數 ${pct}%）`]);
  }

  // 樣本數偏低時，前面算出來的比例／百分比容易被少數幾筆資料大幅拉動，跟頁面既有的
  // 「資料限制說明」保持同一套提醒口徑，不讓匯出的Excel看起來比實際上更肯定。
  if (s.visitorCount > 0 && s.visitorCount < 30) {
    rows.push(['提醒', `本期間不重複訪客僅 ${s.visitorCount} 人，樣本數較小，以上百分比僅供參考，不宜過度解讀`]);
  }

  // 商品偏好／業務效率頁面上「尚未收集的資料」提醒，也一併帶進Excel，避免只看檔案的人
  // 誤以為某些指標是「查出來是0」而不是「目前根本沒有在收集」。
  (data.productPreference?.customizationAiPreference?.notCollected || []).forEach(text => {
    rows.push(['尚未收集的資料（商品／客製化／AI偏好）', text]);
  });
  (data.operationalEfficiency?.notCollected || []).forEach(text => {
    rows.push(['尚未收集的資料（業務與內部效率）', text]);
  });

  return rows;
}

let isExportingAnalytics = false;
async function exportAnalyticsXlsx() {
  if (isExportingAnalytics) return;
  if (!analyticsLastData) {
    alert('目前沒有已載入的分析資料可以匯出，請先等頁面載入完成或按「重新整理」');
    return;
  }
  const btn = document.getElementById('analytics-export-btn');
  const originalText = btn.textContent;
  isExportingAnalytics = true;
  btn.disabled = true;
  btn.textContent = '匯出中…';
  try {
    const data = analyticsLastData;
    const traffic = data.traffic;
    const funnel = data.funnel;
    const pp = data.productPreference;
    const cap = pp.customizationAiPreference;
    const oe = data.operationalEfficiency;
    const cv = data.customerOrderValue;

    const summaryRows = [
      ['資料期間', `${data.period.from} ～ ${data.period.to}`],
      ['時區', data.period.timezone],
      ['事件總數', data.summary.eventCount],
      ['不重複訪客', data.summary.visitorCount],
      ['不重複造訪（session）', data.summary.sessionCount],
      ['詢價成功', data.summary.inquiryCount],
      ['AI 生成請求', data.summary.aiRequestCount],
      ['AI 生成成功', data.summary.aiSuccessCount],
      ['新訪客數', traffic.newVisitorCount],
      ['回訪客數', traffic.returningVisitorCount],
      ['未歸因詢價數（找不到對應訪客來源）', traffic.unattributedInquiryCount],
      ['AI客製化分支：請求session數', funnel.aiBranch.requestSessionCount],
      ['AI客製化分支：成功session數', funnel.aiBranch.successSessionCount],
      ['AI客製化分支：採用率', fmtPct(funnel.aiBranch.adoptionRatePct)],
      ['AI客製化分支：成功率', fmtPct(funnel.aiBranch.successRatePct)],
      ['未關聯到訪客來源的詢價筆數（漏斗）', funnel.unlinkedInquiryCount],
      ['規格選擇完成session數', cap.specificationCompleteSessionCount],
      ['設計完成session數', cap.designCompleteSessionCount],
      ['圖片上傳成功數', cap.upload.successCount],
      ['圖片上傳失敗數', cap.upload.failureCount],
      ['取消訂單數', oe.cancelledCount],
      ['取消率', fmtPct(oe.cancelRatePct)],
      ['逾期未出貨數', oe.overdueCount],
      ['納入業務效率計算的訂單數', oe.population.orderCount],
      ['成交訂單數', cv.dealOrderCount],
      ['成交客戶數', cv.dealCustomerCount],
      ['新客數', cv.newCustomerCount],
      ['回購客數', cv.returningCustomerCount],
      ['回購率', fmtPct(cv.repurchaseRatePct)],
      ['平均成交金額', fmtMoney(cv.avgDealAmount)],
      ['中位數成交金額', fmtMoney(cv.medianDealAmount)],
      ['累計成交金額', fmtMoney(cv.cumulativeDealAmount)],
      ['平均每位客戶成交次數', cv.avgDealsPerCustomer === null ? '資料不足' : cv.avgDealsPerCustomer],
      ['成交當下客戶所屬階段不明筆數', cv.closedWonAtUnknownCount]
    ].map(([label, value]) => ({ label, value: String(value) }));

    const eventRows = data.eventBreakdown.map(row => ({
      label: ANALYTICS_EVENT_LABELS[row.eventName] || row.eventName,
      count: row.count
    }));

    const insightRows = computeAnalyticsInsightRows(data).map(([label, value]) => ({ label, value }));

    const trafficRows = [
      ...traffic.firstTouchSources.map(r => ({ type: '首次接觸來源', name: r.sourceLabel, count: r.visitorCount })),
      ...traffic.lastTouchBeforeInquirySources.map(r => ({ type: '詢價前最後接觸來源', name: r.sourceLabel, count: r.inquiryCount })),
      ...traffic.devices.map(r => ({ type: '裝置', name: ANALYTICS_DEVICE_LABELS[r.device] || r.device, count: r.sessionCount })),
      ...traffic.landingPages.map(r => ({ type: '到達頁面', name: r.landingPath, count: r.sessionCount }))
    ];

    const funnelRows = funnel.stages.map(st => ({
      stage: ANALYTICS_FUNNEL_STAGE_LABELS[st.stageKey] || st.label,
      count: st.count,
      conversionFromPreviousPct: fmtPct(st.conversionFromPreviousPct),
      dropOffCount: st.dropOffCount,
      dropOffRatePct: fmtPct(st.dropOffRatePct)
    }));

    const productPrefRows = pp.products.map(p => ({
      productName: p.productName + (p.archived ? '（已封存）' : ''),
      productViewSessionCount: p.productViewSessionCount,
      customizationStartSessionCount: p.customizationStartSessionCount,
      previewCompleteSessionCount: p.previewCompleteSessionCount,
      inquiryOrderCount: p.inquiryOrderCount,
      linkedInquirySessionCount: p.linkedInquirySessionCount,
      unlinkedInquiryOrderCount: p.unlinkedInquiryOrderCount,
      productViewToCustomizationStartPct: fmtPct(p.productViewToCustomizationStartPct),
      customizationStartToPreviewPct: fmtPct(p.customizationStartToPreviewPct),
      previewToInquiryPct: fmtPct(p.previewToInquiryPct),
      overallProductViewToInquiryPct: fmtPct(p.overallProductViewToInquiryPct),
      riskFlags: `高瀏覽低詢價：${fmtFlag(p.highViewLowInquiry)}／曝光不足高詢價：${fmtFlag(p.highInquiryLowExposure)}`
    }));

    const aiFeatureRows = cap.aiByFeature.map(row => ({
      feature: ANALYTICS_AI_FEATURE_LABELS[row.featureKey] || row.featureKey,
      requestCount: row.requestCount,
      successCount: row.successCount,
      partialCount: row.partialCount,
      failureCount: row.failureCount,
      successRatePct: fmtPct(row.successRatePct),
      unlinkedResultCount: row.unlinkedResultCount
    }));

    const uploadErrorRows = cap.upload.errorBreakdown.map(row => ({ category: row.category, count: row.count }));

    const timingRows = ANALYTICS_TIMING_KEYS.map(key => {
      const t = oe.timings[key];
      return {
        stage: ANALYTICS_TIMING_LABELS[key],
        sampleCount: t.sampleCount,
        median: fmtDuration(t.medianMs),
        mean: fmtDuration(t.meanMs),
        min: fmtDuration(t.minMs),
        max: fmtDuration(t.maxMs),
        invalidCount: t.invalidCount
      };
    });

    const backlogRows = oe.currentBacklog.map(row => ({ status: row.label, count: row.count }));

    const daysDistributionRows = cv.daysSinceLastDealDistribution.map(row => ({ label: row.label, customerCount: row.customerCount }));

    const resp = await adminFetch('/api/admin/analytics/export', {
      method: 'POST',
      body: JSON.stringify({
        summaryRows, eventRows, insightRows, trafficRows, funnelRows,
        productPrefRows, aiFeatureRows, uploadErrorRows, timingRows, backlogRows, daysDistributionRows
      })
    });
    if (!resp.ok) {
      const errData = await resp.json().catch(() => null);
      throw new Error((errData && errData.error) || '匯出失敗，請稍後再試');
    }
    await adminDownloadBlob(resp, `楊竹網站分析_${new Date().toISOString().slice(0, 10)}.xlsx`);
  } catch (e) {
    alert(e.message || '匯出失敗，請稍後再試');
  } finally {
    isExportingAnalytics = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
