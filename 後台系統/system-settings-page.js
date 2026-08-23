// 楊竹科技後台系統 — 系統設定頁面邏輯（正式功能第一批）
// 本批只有一項真正可修改的全域設定：quoteDefaultValidDays（訂單詳情頁「發布新報價版本」
// 表單的預設有效天數）。其餘系統資訊全部唯讀，這裡不提供任何修改這些資訊本身的操作，
// 只有「重新檢查資料庫完整性」這個獨立的手動觸發動作。所有動態內容一律用 textContent／
// DOM API 賦值，不使用 innerHTML 插入任何來自 API 回應的文字，避免動態內容被解析成HTML。

let loadedSystemSettings = null; // { quoteDefaultValidDays, updatedAt }
let systemSettingsFormDirty = false;

function onAdminReady() {
  wireSystemSettingsDirtyTracking();
  wireSystemSettingsBeforeUnload();
  loadSystemSettings();
}

function ssQuoteDaysInput() {
  return document.getElementById('ss-quote-default-days');
}

function readSystemSettingsForm() {
  const raw = ssQuoteDaysInput().value;
  // 刻意保留原始字串（不在這裡先轉成 Number），讓後面的驗證能明確分辨「使用者根本沒填」
  // 與「填了非數字內容」，兩種狀況要顯示不同的欄位錯誤訊息。
  return { quoteDefaultValidDaysRaw: raw };
}

function applySystemSettingsToForm(settings) {
  ssQuoteDaysInput().value = String(settings.quoteDefaultValidDays);
}

// 「未修改時不可重複儲存」：跟最後一次成功讀取／儲存的內容比對，完全相同就視為沒有變更。
// 載入尚未完成（loadedSystemSettings 還是 null）時一律視為沒有變更。
function isSystemSettingsFormDirty() {
  if (!loadedSystemSettings) return false;
  const raw = readSystemSettingsForm().quoteDefaultValidDaysRaw;
  return raw !== String(loadedSystemSettings.quoteDefaultValidDays);
}

function updateSystemSettingsSaveButtonState() {
  const btn = document.getElementById('ss-save-btn');
  if (!btn) return;
  systemSettingsFormDirty = isSystemSettingsFormDirty();
  // 送出中的disabled狀態由 adminRunAction() 自行控制，這裡不強行覆蓋（送出中按鈕本來就是
  // disabled，isSystemSettingsFormDirty() 這時通常也是false，兩者不會互相打架）。
  btn.disabled = !systemSettingsFormDirty;
}

function wireSystemSettingsDirtyTracking() {
  const input = ssQuoteDaysInput();
  input.addEventListener('input', () => {
    clearSystemSettingsFieldError();
    updateSystemSettingsSaveButtonState();
  });
  input.addEventListener('change', updateSystemSettingsSaveButtonState);
}

// 有未儲存修改時，離開或重新整理頁面必須提醒。
function wireSystemSettingsBeforeUnload() {
  window.addEventListener('beforeunload', (e) => {
    if (systemSettingsFormDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

function clearSystemSettingsFieldError() {
  const errEl = document.getElementById('ss-quote-default-days-error');
  errEl.textContent = '';
  ssQuoteDaysInput().classList.remove('field-invalid');
}

function setSystemSettingsFieldError(msg) {
  const errEl = document.getElementById('ss-quote-default-days-error');
  errEl.textContent = msg;
  ssQuoteDaysInput().classList.add('field-invalid');
}

// 前端只做最基本的必填與範圍檢查，真正的型別／範圍驗證一律以後端為準，不在這裡重複實作
// 一套規則（跟報價版本、付款交易同一套原則）。回傳合法的number或null（並同步顯示欄位錯誤）。
function validateQuoteDefaultDaysInput() {
  const raw = ssQuoteDaysInput().value;
  if (raw.trim() === '') {
    setSystemSettingsFieldError('請輸入預設報價有效天數');
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || String(raw).includes('.') || n < 1 || n > 365) {
    setSystemSettingsFieldError('必須是 1～365 之間的整數');
    return null;
  }
  clearSystemSettingsFieldError();
  return n;
}

async function loadSystemSettings() {
  const loadingEl = document.getElementById('ss-loading');
  const errorEl = document.getElementById('ss-error');
  const contentEl = document.getElementById('ss-content');
  loadingEl.classList.remove('hidden');
  errorEl.classList.add('hidden');
  contentEl.classList.add('hidden');

  try {
    const resp = await adminFetch('/api/admin/system-settings');
    const data = await resp.json().catch(() => null);
    loadingEl.classList.add('hidden');
    if (!resp.ok || !data) {
      document.getElementById('ss-error-text').textContent = (data && data.error) || '讀取失敗，請稍後再試';
      errorEl.classList.remove('hidden');
      return;
    }
    loadedSystemSettings = data.settings;
    applySystemSettingsToForm(loadedSystemSettings);
    clearSystemSettingsFieldError();
    renderSystemInfoGrid(data.systemInfo || {});
    contentEl.classList.remove('hidden');
    updateSystemSettingsSaveButtonState();
  } catch (e) {
    loadingEl.classList.add('hidden');
    document.getElementById('ss-error-text').textContent = '讀取失敗：' + e.message;
    errorEl.classList.remove('hidden');
  }
}

async function saveSystemSettings() {
  const btn = document.getElementById('ss-save-btn');
  if (!isSystemSettingsFormDirty()) return; // 未修改不可重複儲存；按鈕本來就會是disabled，這裡是第二層防線

  const quoteDefaultValidDays = validateQuoteDefaultDaysInput();
  if (quoteDefaultValidDays === null) return;

  const resultEl = document.getElementById('ss-save-result');
  // adminRunAction() 包住從確認對話框開始的整個流程，按鈕從觸發當下就鎖定，避免快速連點
  // 開出兩個確認視窗、各自確認後各送一次API的競態；busyText傳null，「儲存中…」文字改成
  // 確認後才手動設定，避免使用者在還沒確認前就看到「儲存中」字樣。
  const originalLabel = btn.textContent;
  await adminRunAction(btn, null, async () => {
    const { confirmed } = await adminConfirmDialog({
      title: '確認儲存系統設定',
      message: `即將把「預設報價有效天數」改為 ${quoteDefaultValidDays} 天，套用後所有訂單詳情頁「發布新報價版本」表單開啟時都會改用這個新的預設值。確定要儲存嗎？`,
      confirmLabel: '確認儲存'
    });
    if (!confirmed) return; // 取消時完全不呼叫API，表單內容原封不動保留

    resultEl.textContent = '';
    btn.textContent = '儲存中…';
    try {
      const resp = await adminFetch('/api/admin/system-settings', {
        method: 'PUT',
        body: JSON.stringify({ quoteDefaultValidDays })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data) {
        resultEl.textContent = (data && data.error) || '儲存失敗，請稍後再試';
        resultEl.style.color = '#dc2626';
        return;
      }
      loadedSystemSettings = data.settings;
      applySystemSettingsToForm(loadedSystemSettings);
      resultEl.textContent = '已儲存';
      resultEl.style.color = '';
    } catch (e) {
      resultEl.textContent = '儲存失敗：' + e.message;
      resultEl.style.color = '#dc2626';
    } finally {
      btn.textContent = originalLabel;
      updateSystemSettingsSaveButtonState();
    }
  });
}

// ─── 系統資訊（唯讀）渲染 ─────────────────────────────────────
// 每個項目各自獨立包一層 try/catch：其中一項資料異常（缺漏、型別不對）只讓那一個
// stat-card顯示「--」，不會讓整個系統資訊區塊、更不會讓整頁失敗或空白。
function fmtSsBoolean(v, trueText, falseText) {
  return v === true ? trueText : (v === false ? falseText : '--');
}

function fmtSsUptime(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(days + '天');
  if (hours > 0 || days > 0) parts.push(hours + '小時');
  parts.push(mins + '分鐘');
  return parts.join('');
}

function fmtSsServerTime(iso) {
  if (typeof iso !== 'string' || !iso) return '--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--';
  try {
    return d.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
  } catch (e) {
    return d.toISOString();
  }
}

function fmtSsDbIntegrity(info) {
  const statusLabels = { ok: '正常', error: '異常，請盡快確認', not_checked: '尚未檢查' };
  if (!info || typeof info.status !== 'string') return { text: '--', className: '' };
  const label = statusLabels[info.status] || info.status;
  const checkedText = info.checkedAt ? '（檢查時間：' + fmtSsServerTime(info.checkedAt) + '）' : '';
  return { text: label + checkedText, className: info.status === 'error' ? 'warn' : '' };
}

function buildSsStatCard(label, valueText, extraClassName, appendEl) {
  const card = document.createElement('div');
  card.className = 'stat-card';
  const labelEl = document.createElement('div');
  labelEl.className = 'stat-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('div');
  valueEl.className = 'stat-value' + (extraClassName ? ' ' + extraClassName : '');
  valueEl.style.fontSize = '15px';
  valueEl.textContent = valueText;
  card.appendChild(labelEl);
  card.appendChild(valueEl);
  if (appendEl) card.appendChild(appendEl);
  return card;
}

function renderSystemInfoGrid(systemInfo) {
  const grid = document.getElementById('ss-system-info-grid');
  grid.textContent = '';

  const rows = [
    () => buildSsStatCard('系統健康狀態', fmtSsBoolean(systemInfo.healthy, '正常', '異常，請盡快確認'), systemInfo.healthy === false ? 'warn' : ''),
    () => {
      const result = fmtSsDbIntegrity(systemInfo.dbIntegrity);
      const recheckBtn = document.createElement('button');
      recheckBtn.type = 'button';
      recheckBtn.className = 'btn btn-secondary btn-sm';
      recheckBtn.textContent = '重新檢查';
      recheckBtn.style.marginTop = '8px';
      recheckBtn.addEventListener('click', () => checkDbIntegrityNow(recheckBtn));
      return buildSsStatCard('資料庫完整性狀態', result.text, result.className, recheckBtn);
    },
    () => buildSsStatCard('伺服器目前時間', fmtSsServerTime(systemInfo.serverTime)),
    () => buildSsStatCard('系統時區', typeof systemInfo.timezone === 'string' ? systemInfo.timezone : '--'),
    () => buildSsStatCard('伺服器運行時間', fmtSsUptime(systemInfo.uptimeSeconds)),
    () => buildSsStatCard('管理員 Session 有效時間', typeof systemInfo.sessionTtlHours === 'number' ? systemInfo.sessionTtlHours + ' 小時' : '--'),
    () => buildSsStatCard('維護模式是否啟用', fmtSsBoolean(systemInfo.maintenanceMode, '已啟用', '未啟用'), systemInfo.maintenanceMode === true ? 'warn' : ''),
    () => buildSsStatCard('應用程式版本', (typeof systemInfo.appVersion === 'string' && systemInfo.appVersion) ? systemInfo.appVersion : '未設定')
  ];

  rows.forEach(buildRow => {
    try {
      grid.appendChild(buildRow());
    } catch (e) {
      const fallback = document.createElement('div');
      fallback.className = 'stat-card';
      const label = document.createElement('div');
      label.className = 'stat-label';
      label.textContent = '（此項目載入失敗）';
      fallback.appendChild(label);
      grid.appendChild(fallback);
    }
  });
}

// 手動重新檢查資料庫完整性：獨立呼叫，只更新這一張卡片對應的資料，不重新載入整頁
// （避免使用者剛編輯到一半的表單內容被重繪打斷）。
async function checkDbIntegrityNow(btn) {
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '檢查中…';
  try {
    const resp = await adminFetch('/api/admin/system-settings/check-integrity', { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      showAdminToast((data && data.error) || '資料庫完整性檢查失敗', true);
      return;
    }
    const result = fmtSsDbIntegrity(data.dbIntegrity);
    const card = btn.closest('.stat-card');
    if (card) {
      const valueEl = card.querySelector('.stat-value');
      valueEl.textContent = result.text;
      valueEl.className = 'stat-value' + (result.className ? ' ' + result.className : '');
      valueEl.style.fontSize = '15px';
    }
    showAdminToast(data.dbIntegrity && data.dbIntegrity.status === 'ok' ? '資料庫完整性正常' : '資料庫完整性檢查完成，請留意結果', data.dbIntegrity && data.dbIntegrity.status !== 'ok');
  } catch (e) {
    showAdminToast('資料庫完整性檢查失敗：' + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
