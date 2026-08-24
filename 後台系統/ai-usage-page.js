// 楊竹科技後台系統 — AI 使用統計頁面邏輯
// 所有動態內容一律用 textContent／DOM API 建立節點，絕不使用 innerHTML 插入 API 資料，
// 惡意字串（例如 model 欄位）不可能被解析成真正的 HTML 標籤或觸發事件屬性。
// API 回應在畫出任何圖表／表格前一律先嚴格驗證格式，格式不符就整頁顯示「統計資料格式錯誤」，
// 不允許只畫出部分資料造成誤導。

const AI_USAGE_FEATURE_KEYS = ['generate_image', 'generate_design', 'black_card_pattern', 'cartoon_image'];
const AI_USAGE_OUTCOMES = ['success', 'partial', 'validation_error', 'disabled', 'unavailable', 'provider_error', 'rate_limited', 'content_blocked', 'internal_error'];
const AI_USAGE_ERROR_CATEGORIES = ['validation', 'disabled', 'api_key_missing', 'settings_unavailable', 'timeout', 'moderation', 'quota', 'rate_limited', 'authentication', 'provider_error', 'response_parse_error', 'moderation_unavailable', 'internal_error'];
const AI_USAGE_MODERATION_CATEGORIES = [
  'sexual', 'sexual/minors', 'harassment', 'harassment/threatening',
  'hate', 'hate/threatening', 'illicit', 'illicit/violent',
  'self-harm', 'self-harm/intent', 'self-harm/instructions',
  'violence', 'violence/graphic'
];
const AI_USAGE_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };

const AI_USAGE_FEATURE_LABELS = {
  generate_image: 'AI 生圖（卡片背景設計）',
  generate_design: 'AI 設計文字建議',
  black_card_pattern: '尊爵不凡黑卡圖案生成',
  cartoon_image: 'Q版卡通化'
};
const AI_USAGE_OUTCOME_LABELS = {
  success: '成功', partial: '部分成功', validation_error: '輸入驗證失敗', disabled: '功能已停用',
  unavailable: '服務不可用', provider_error: 'OpenAI錯誤', rate_limited: '使用次數限制',
  content_blocked: '內容阻擋', internal_error: '系統內部錯誤'
};
const AI_USAGE_ERROR_CATEGORY_LABELS = {
  validation: '輸入驗證失敗', disabled: '功能已停用', api_key_missing: 'API Key未設定',
  settings_unavailable: '設定讀取失敗', timeout: '逾時', moderation: '內容審核拒絕',
  quota: '額度不足', rate_limited: '頻率限制', authentication: '認證失敗',
  provider_error: '其他OpenAI錯誤', response_parse_error: '回應解析失敗',
  moderation_unavailable: '審核服務不可用', internal_error: '系統內部錯誤'
};
const AI_USAGE_MODERATION_CATEGORY_LABELS = {
  'sexual': '性相關', 'sexual/minors': '未成年性相關', 'harassment': '騷擾',
  'harassment/threatening': '騷擾威脅', 'hate': '仇恨言論', 'hate/threatening': '仇恨威脅',
  'illicit': '非法行為', 'illicit/violent': '非法暴力行為', 'self-harm': '自我傷害',
  'self-harm/intent': '自我傷害意圖', 'self-harm/instructions': '自我傷害教學',
  'violence': '暴力', 'violence/graphic': '血腥暴力畫面'
};
const AI_USAGE_COST_COVERAGE_LABELS = { full: '完整', partial: '部分預估', unknown: '無法估算', none: '本期無資料' };

function onAdminReady() {
  loadAiUsageStats();
}

// ─── 基礎型別驗證 ─────────────────────────────────────────
function isNonNegInt(v) { return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0; }
function isNonNegNum(v) { return typeof v === 'number' && Number.isFinite(v) && v >= 0; }
function isNonNegIntOrNull(v) { return v === null || isNonNegInt(v); }
function isNonNegNumOrNull(v) { return v === null || isNonNegNum(v); }
function isRateOrNull(v) { return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1); }
function isValidCalendarDateString(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
function dateStringToUtcMs(s) {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function isValidIsoString(s) { return typeof s === 'string' && !isNaN(Date.parse(s)); }

function isValidSummary(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  const intFields = ['totalRequests', 'providerCalledRequests', 'moderationCalledRequests', 'successCount', 'partialCount', 'validationErrorCount', 'disabledCount', 'unavailableCount', 'providerErrorCount', 'rateLimitedCount', 'contentBlockedCount', 'internalErrorCount', 'inputTokens', 'outputTokens', 'totalTokens', 'generatedImageCount', 'unknownCostRequests', 'partialCostRequests'];
  if (!intFields.every(k => isNonNegInt(s[k]))) return false;
  if (!isRateOrNull(s.overallSuccessRate)) return false;
  if (!isRateOrNull(s.providerSuccessRate)) return false;
  if (!isNonNegNumOrNull(s.avgDurationMs)) return false;
  if (!isNonNegNum(s.estimatedKnownCostUsd)) return false;
  if (typeof s.hasIncompleteCostEstimate !== 'boolean') return false;
  return true;
}

function isValidDailyTrend(trend, expectedLength) {
  if (!Array.isArray(trend) || trend.length !== expectedLength) return false;
  for (const t of trend) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return false;
    if (!isValidCalendarDateString(t.date)) return false;
    if (!isNonNegInt(t.totalRequests) || !isNonNegInt(t.successCount) || !isNonNegInt(t.errorCount) || !isNonNegInt(t.generatedImageCount)) return false;
    if (!isNonNegNum(t.estimatedKnownCostUsd)) return false;
    if (t.successCount + t.errorCount !== t.totalRequests) return false;
  }
  for (let i = 1; i < trend.length; i++) {
    if (dateStringToUtcMs(trend[i].date) - dateStringToUtcMs(trend[i - 1].date) !== 86400000) return false;
  }
  return true;
}

function isValidByFeature(list) {
  if (!Array.isArray(list) || list.length !== AI_USAGE_FEATURE_KEYS.length) return false;
  const seen = new Set();
  for (const f of list) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return false;
    if (!AI_USAGE_FEATURE_KEYS.includes(f.featureKey) || seen.has(f.featureKey)) return false;
    seen.add(f.featureKey);
    if (!isNonNegInt(f.totalRequests) || !isNonNegInt(f.successCount) || !isNonNegInt(f.partialCount) || !isNonNegInt(f.errorCount)) return false;
    if (!isNonNegNumOrNull(f.avgDurationMs)) return false;
    if (!isNonNegInt(f.inputTokens) || !isNonNegInt(f.outputTokens) || !isNonNegInt(f.generatedImageCount)) return false;
    if (!isNonNegNum(f.estimatedKnownCostUsd)) return false;
    if (!Object.prototype.hasOwnProperty.call(AI_USAGE_COST_COVERAGE_LABELS, f.costCoverage)) return false;
  }
  return AI_USAGE_FEATURE_KEYS.every(k => seen.has(k));
}

function isValidErrorBreakdown(list) {
  if (!Array.isArray(list)) return false;
  const seen = new Set();
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
    if (!AI_USAGE_ERROR_CATEGORIES.includes(e.errorCategory) || seen.has(e.errorCategory)) return false;
    seen.add(e.errorCategory);
    if (!isNonNegInt(e.count) || e.count <= 0) return false;
  }
  return true;
}

function isValidModerationCategoryBreakdown(list) {
  if (!Array.isArray(list)) return false;
  const seen = new Set();
  for (const m of list) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    if (!AI_USAGE_MODERATION_CATEGORIES.includes(m.category) || seen.has(m.category)) return false;
    seen.add(m.category);
    if (!isNonNegInt(m.count) || m.count <= 0) return false;
  }
  return true;
}

function isValidRecentErrors(list) {
  if (!Array.isArray(list) || list.length > 50) return false;
  for (const r of list) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
    if (typeof r.id !== 'number') return false;
    if (typeof r.requestId !== 'string' || !r.requestId) return false;
    if (!AI_USAGE_FEATURE_KEYS.includes(r.featureKey)) return false;
    if (r.model !== null && typeof r.model !== 'string') return false;
    if (!AI_USAGE_OUTCOMES.includes(r.outcome) || r.outcome === 'success' || r.outcome === 'partial') return false;
    if (typeof r.httpStatus !== 'number') return false;
    if (r.errorCategory !== null && !AI_USAGE_ERROR_CATEGORIES.includes(r.errorCategory)) return false;
    if (!isNonNegInt(r.durationMs)) return false;
    if (!isValidIsoString(r.createdAt)) return false;
  }
  for (let i = 1; i < list.length; i++) {
    if (list[i].createdAt > list[i - 1].createdAt) return false; // 必須由新到舊
  }
  return true;
}

function isValidPricing(list) {
  if (!Array.isArray(list) || !list.length) return false;
  for (const p of list) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
    if (typeof p.rateKey !== 'string' || !p.rateKey) return false;
    if (typeof p.model !== 'string' || typeof p.usageType !== 'string' || typeof p.unit !== 'string') return false;
    if (p.unitPriceUsd !== null && !isNonNegNum(p.unitPriceUsd)) return false;
    if (!['active', 'deprecated', 'removed', 'unknown'].includes(p.availabilityStatus)) return false;
    if (typeof p.sourceUrl !== 'string' || !p.sourceUrl.startsWith('https://developers.openai.com/')) return false;
    if (typeof p.verifiedAt !== 'string' || !p.verifiedAt) return false;
  }
  return true;
}

function isValidAiUsageStatsResponse(data, expectedRange) {
  if (!data || typeof data !== 'object') return false;
  if (data.range !== expectedRange) return false;
  const expectedDays = AI_USAGE_RANGE_DAYS[expectedRange];
  if (!isValidSummary(data.summary)) return false;
  if (!isValidDailyTrend(data.dailyTrend, expectedDays)) return false;
  if (!isValidByFeature(data.byFeature)) return false;
  if (!isValidErrorBreakdown(data.errorBreakdown)) return false;
  if (!isValidModerationCategoryBreakdown(data.moderationCategoryBreakdown)) return false;
  if (!isValidRecentErrors(data.recentErrors)) return false;
  if (!isValidPricing(data.pricing)) return false;
  if (typeof data.costNotice !== 'string' || !data.costNotice) return false;
  return true;
}

// ─── 顯示格式化 ─────────────────────────────────────────
function fmtCount(n) { return isNonNegInt(n) ? n.toLocaleString() : '--'; }
function fmtRate(r) { return r === null ? '--' : (r * 100).toFixed(1) + '%'; }
function fmtDuration(ms) { return ms === null ? '--' : Math.round(ms).toLocaleString() + ' ms'; }
// 金額固定顯示到小數第4位以上（實際固定6位），避免小金額被四捨五入成看起來像0元。
function fmtUsd(v) { return 'USD ' + (typeof v === 'number' ? v.toFixed(6) : '0.000000'); }

function clearChildren(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function tableCell(text) { const td = document.createElement('td'); td.textContent = text; return td; }
function emptyStateRow(colspan, text) {
  const tr = document.createElement('tr');
  const td = document.createElement('td');
  td.colSpan = colspan; td.style.textAlign = 'center'; td.style.color = 'var(--gray-400)'; td.style.padding = '20px';
  td.textContent = text || '目前沒有資料';
  tr.appendChild(td);
  return tr;
}

let aiUsageLoadInFlight = false;

async function loadAiUsageStats() {
  if (aiUsageLoadInFlight) return;
  aiUsageLoadInFlight = true;
  const btn = document.getElementById('ai-usage-refresh-btn');
  const statusEl = document.getElementById('ai-usage-status');
  const contentEl = document.getElementById('ai-usage-content');
  if (btn) { btn.disabled = true; btn.textContent = '載入中…'; }
  statusEl.textContent = '載入中…';
  statusEl.classList.remove('hidden');
  contentEl.classList.add('hidden');

  const range = document.getElementById('ai-usage-filter-range').value;
  const feature = document.getElementById('ai-usage-filter-feature').value;
  const outcome = document.getElementById('ai-usage-filter-outcome').value;

  const qs = new URLSearchParams();
  qs.set('range', range);
  if (feature) qs.set('feature', feature);
  if (outcome) qs.set('outcome', outcome);

  try {
    const resp = await adminFetch('/api/admin/ai-usage-stats?' + qs.toString());
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      statusEl.textContent = (data && data.error) || '載入失敗，請稍後再試';
      return;
    }
    if (!isValidAiUsageStatsResponse(data, range)) {
      statusEl.textContent = '統計資料格式錯誤';
      return;
    }
    renderAiUsageStats(data);
    statusEl.classList.add('hidden');
    contentEl.classList.remove('hidden');
  } catch (e) {
    statusEl.textContent = '載入失敗：' + e.message;
  } finally {
    aiUsageLoadInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = '重新整理'; }
  }
}

function renderAiUsageStats(data) {
  const s = data.summary;
  document.getElementById('ai-usage-stat-total').textContent = fmtCount(s.totalRequests);
  document.getElementById('ai-usage-stat-success-rate').textContent = fmtRate(s.overallSuccessRate);
  document.getElementById('ai-usage-stat-provider-called').textContent = fmtCount(s.providerCalledRequests);
  document.getElementById('ai-usage-stat-tokens').textContent = fmtCount(s.totalTokens);
  document.getElementById('ai-usage-stat-images').textContent = fmtCount(s.generatedImageCount);
  document.getElementById('ai-usage-stat-cost').textContent = fmtUsd(s.estimatedKnownCostUsd);
  document.getElementById('ai-usage-stat-unknown-cost').textContent = fmtCount(s.unknownCostRequests);
  document.getElementById('ai-usage-stat-avg-duration').textContent = fmtDuration(s.avgDurationMs);
  document.getElementById('ai-usage-stat-content-blocked').textContent = fmtCount(s.contentBlockedCount);
  document.getElementById('ai-usage-cost-notice').textContent = data.costNotice;

  renderAiUsageTrend(data.dailyTrend);
  renderAiUsageByFeature(data.byFeature);
  renderAiUsageErrorBreakdown(data.errorBreakdown);
  renderAiUsageModerationBreakdown(data.moderationCategoryBreakdown);
  renderAiUsageRecentErrors(data.recentErrors);
  renderAiUsagePricing(data.pricing);
  renderAiUsageModelWarnings(data.pricing);
}

// ─── 每日趨勢圖：沿用既有 dashboard 營收趨勢的SVG／純CSS做法，不引入外部圖表套件 ──
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, attrs[k]));
  return el;
}

function renderAiUsageTrend(trend) {
  const svg = document.getElementById('ai-usage-trend-svg');
  const emptyEl = document.getElementById('ai-usage-trend-empty');
  const tbody = document.getElementById('ai-usage-trend-table-body');
  clearChildren(svg);
  clearChildren(tbody);

  const hasAnyData = trend.some(t => t.totalRequests > 0);
  if (!hasAnyData) {
    emptyEl.classList.remove('hidden');
  } else {
    emptyEl.classList.add('hidden');
  }

  const W = 800, H = 220, padL = 46, padR = 10, padT = 12, padB = 26;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = trend.length;
  const totals = trend.map(t => t.totalRequests);
  const maxTotal = Math.max(1, ...totals);

  [0, maxTotal].forEach(val => {
    const y = padT + plotH - (val / maxTotal) * plotH;
    svg.appendChild(svgEl('line', { x1: padL, y1: y, x2: W - padR, y2: y, class: 'chart-grid-line' }));
    const label = svgEl('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', class: 'chart-bar-label' });
    label.textContent = String(val);
    svg.appendChild(label);
  });

  const slotW = plotW / n;
  const gap = n > 40 ? 1 : 2;
  const barW = Math.max(1, slotW - gap);

  trend.forEach((t, i) => {
    const barH = (t.totalRequests / maxTotal) * plotH;
    const x = padL + i * slotW + gap / 2;
    const y = padT + plotH - barH;

    const rect = svgEl('rect', { x, y, width: barW, height: Math.max(0, barH), class: t.errorCount > 0 ? 'chart-bar-ai-mixed' : 'chart-bar-ai-total', rx: 1 });
    const titleEl = document.createElementNS(SVG_NS, 'title');
    titleEl.textContent = `${t.date}：共${t.totalRequests}筆（成功${t.successCount}／錯誤${t.errorCount}），${fmtUsd(t.estimatedKnownCostUsd)}`;
    rect.appendChild(titleEl);
    svg.appendChild(rect);

    if (i % Math.max(1, Math.ceil(n / 12)) === 0 || i === n - 1) {
      const dateLabel = svgEl('text', { x: x + barW / 2, y: H - 6, 'text-anchor': 'middle', class: 'chart-bar-label' });
      dateLabel.textContent = t.date.slice(5);
      svg.appendChild(dateLabel);
    }

    const tr = document.createElement('tr');
    tr.appendChild(tableCell(t.date));
    tr.appendChild(tableCell(fmtCount(t.totalRequests)));
    tr.appendChild(tableCell(fmtCount(t.successCount)));
    tr.appendChild(tableCell(fmtCount(t.errorCount)));
    tr.appendChild(tableCell(fmtCount(t.generatedImageCount)));
    tr.appendChild(tableCell(fmtUsd(t.estimatedKnownCostUsd)));
    tbody.appendChild(tr);
  });
}

function renderAiUsageByFeature(byFeature) {
  const tbody = document.getElementById('ai-usage-byfeature-body');
  clearChildren(tbody);
  byFeature.forEach(f => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(AI_USAGE_FEATURE_LABELS[f.featureKey] || f.featureKey));
    tr.appendChild(tableCell(fmtCount(f.totalRequests)));
    tr.appendChild(tableCell(fmtCount(f.successCount)));
    tr.appendChild(tableCell(fmtCount(f.partialCount)));
    tr.appendChild(tableCell(fmtCount(f.errorCount)));
    tr.appendChild(tableCell(fmtDuration(f.avgDurationMs)));
    tr.appendChild(tableCell(fmtCount(f.inputTokens)));
    tr.appendChild(tableCell(fmtCount(f.outputTokens)));
    tr.appendChild(tableCell(fmtCount(f.generatedImageCount)));
    tr.appendChild(tableCell(fmtUsd(f.estimatedKnownCostUsd)));
    tr.appendChild(tableCell(AI_USAGE_COST_COVERAGE_LABELS[f.costCoverage] || f.costCoverage));
    tbody.appendChild(tr);
  });
}

function renderAiUsageErrorBreakdown(list) {
  const tbody = document.getElementById('ai-usage-errorbreakdown-body');
  clearChildren(tbody);
  if (!list.length) {
    tbody.appendChild(emptyStateRow(2, '目前沒有錯誤紀錄'));
    return;
  }
  list.forEach(e => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(AI_USAGE_ERROR_CATEGORY_LABELS[e.errorCategory] || e.errorCategory));
    tr.appendChild(tableCell(fmtCount(e.count)));
    tbody.appendChild(tr);
  });
}

// 只顯示固定分類代碼＋次數，資料本身（moderationCategoryBreakdown）已經在後端就不含
// 顧客原始文字／圖片內容，這裡不需要另外過濾。
function renderAiUsageModerationBreakdown(list) {
  const tbody = document.getElementById('ai-usage-moderation-body');
  clearChildren(tbody);
  if (!list.length) {
    tbody.appendChild(emptyStateRow(2, '目前沒有內容阻擋紀錄'));
    return;
  }
  list.forEach(m => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(AI_USAGE_MODERATION_CATEGORY_LABELS[m.category] || m.category));
    tr.appendChild(tableCell(fmtCount(m.count)));
    tbody.appendChild(tr);
  });
}

function fmtTaipeiTime(iso) {
  try {
    return new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  } catch { return iso; }
}

function renderAiUsageRecentErrors(list) {
  const tbody = document.getElementById('ai-usage-recenterrors-body');
  clearChildren(tbody);
  if (!list.length) {
    tbody.appendChild(emptyStateRow(7, '目前沒有錯誤紀錄'));
    return;
  }
  list.forEach(r => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(fmtTaipeiTime(r.createdAt)));
    tr.appendChild(tableCell(AI_USAGE_FEATURE_LABELS[r.featureKey] || r.featureKey));
    tr.appendChild(tableCell(r.model || '--'));
    tr.appendChild(tableCell(AI_USAGE_OUTCOME_LABELS[r.outcome] || r.outcome));
    tr.appendChild(tableCell(String(r.httpStatus)));
    tr.appendChild(tableCell(r.errorCategory ? (AI_USAGE_ERROR_CATEGORY_LABELS[r.errorCategory] || r.errorCategory) : '--'));
    tr.appendChild(tableCell(fmtDuration(r.durationMs)));
    tbody.appendChild(tr);
  });
}

function renderAiUsagePricing(pricing) {
  const tbody = document.getElementById('ai-usage-pricing-body');
  clearChildren(tbody);
  const statusLabels = { active: '現行', deprecated: '即將淘汰', removed: '官方已移除', unknown: '狀態不明' };
  pricing.forEach(p => {
    const tr = document.createElement('tr');
    tr.appendChild(tableCell(p.model));
    tr.appendChild(tableCell(p.usageType));
    tr.appendChild(tableCell(p.unit));
    tr.appendChild(tableCell(p.unitPriceUsd === null ? '無現行官方價格' : p.unitPriceUsd.toFixed(6)));
    tr.appendChild(tableCell(statusLabels[p.availabilityStatus] || p.availabilityStatus));
    tr.appendChild(tableCell(p.verifiedAt));

    const linkTd = document.createElement('td');
    const a = document.createElement('a');
    // sourceUrl 已經在 isValidPricing() 驗證過必須以 https://developers.openai.com/ 開頭，
    // 這裡再次確認才建立連結，雙重防線，絕不使用 innerHTML 插入這個網址。
    if (typeof p.sourceUrl === 'string' && p.sourceUrl.startsWith('https://developers.openai.com/')) {
      a.setAttribute('href', p.sourceUrl);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = '官方模型頁';
      linkTd.appendChild(a);
    } else {
      linkTd.textContent = '--';
    }
    tr.appendChild(linkTd);

    tbody.appendChild(tr);
  });
}

function renderAiUsageModelWarnings(pricing) {
  const wrap = document.getElementById('ai-usage-model-warnings');
  clearChildren(wrap);

  const dalle3 = pricing.find(p => p.model === 'dall-e-3');
  if (dalle3 && dalle3.availabilityStatus === 'removed') {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginBottom = '12px';
    box.style.borderColor = '#dc2626';
    const title = document.createElement('p');
    title.style.fontWeight = '700';
    title.style.color = '#dc2626';
    title.textContent = 'dall-e-3：官方已移除，無現行官方價格';
    const desc = document.createElement('p');
    desc.style.fontSize = '12px';
    desc.style.color = 'var(--gray-400)';
    desc.style.margin = '6px 0 0';
    desc.textContent = 'AI 生圖（卡片背景設計）已改用官方目前建議的 gpt-image-2，此警示只代表歷史紀錄中曾經使用 dall-e-3 的舊資料列無法估算成本，不代表目前功能仍在使用這個模型。';
    box.appendChild(title);
    box.appendChild(desc);
    wrap.appendChild(box);
  }

  const gptImage1 = pricing.find(p => p.model === 'gpt-image-1');
  if (gptImage1 && gptImage1.availabilityStatus === 'deprecated') {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginBottom = '12px';
    box.style.borderColor = '#d97706';
    const title = document.createElement('p');
    title.style.fontWeight = '700';
    title.style.color = '#d97706';
    title.textContent = 'gpt-image-1：官方已列為 Deprecated（已淘汰）';
    const desc = document.createElement('p');
    desc.style.fontSize = '12px';
    desc.style.color = 'var(--gray-400)';
    desc.style.margin = '6px 0 0';
    desc.textContent = 'AI 生圖、尊爵不凡黑卡圖案生成與Q版卡通化已於 2026-08-24 全部改用官方目前建議的 gpt-image-2，此警示只代表歷史紀錄中曾經使用 gpt-image-1 的舊資料列，這些舊資料列仍依 gpt-image-1 當時的價格估算成本，不代表目前功能仍在使用這個模型。';
    box.appendChild(title);
    box.appendChild(desc);
    wrap.appendChild(box);
  }

  const hasGptImage2 = pricing.some(p => p.model === 'gpt-image-2');
  if (hasGptImage2) {
    const box = document.createElement('div');
    box.className = 'card';
    box.style.marginBottom = '12px';
    const title = document.createElement('p');
    title.style.fontWeight = '700';
    title.textContent = 'gpt-image-2：費用為部分預估';
    const desc = document.createElement('p');
    desc.style.fontSize = '12px';
    desc.style.color = 'var(--gray-400)';
    desc.style.margin = '6px 0 0';
    desc.textContent = 'AI 生圖（卡片背景設計）、尊爵不凡黑卡圖案生成與Q版卡通化目前只記錄並估算已知的輸出圖片費用，圖片編輯可能另有未記錄的文字或輸入圖片 Token 成本，此頁顯示的成本不等於 OpenAI 最終帳單。';
    box.appendChild(title);
    box.appendChild(desc);
    wrap.appendChild(box);
  }
}
