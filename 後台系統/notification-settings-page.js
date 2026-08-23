// 楊竹科技後台系統 — 通知設定頁（統一通知系統批次）
// 只讀取／切換Email／LINE兩個管道的「已設定／未設定」狀態與各事件類型的開關，機密內容
// （SMTP密碼、LINE Token）完全不會出現在這個頁面或任何API回應裡，只能在伺服器環境變數修改。

let notificationEventTypes = [];
let notificationEventLabels = {};

function onAdminReady() {
  loadNotificationSettings();
}

async function loadNotificationSettings() {
  document.getElementById('ns-loading').classList.remove('hidden');
  document.getElementById('ns-error').classList.add('hidden');
  document.getElementById('ns-content').classList.add('hidden');
  try {
    const resp = await adminFetch('/api/admin/notification-settings');
    const data = await resp.json().catch(() => null);
    document.getElementById('ns-loading').classList.add('hidden');
    if (!resp.ok || !data) {
      document.getElementById('ns-error-text').textContent = (data && data.error) || '讀取失敗';
      document.getElementById('ns-error').classList.remove('hidden');
      return;
    }
    notificationEventTypes = data.eventTypes || [];
    notificationEventLabels = data.eventLabels || {};
    renderChannelStatus(data.channelStatus || {});
    renderEventSettingsTable(data.channelSettings || {});
    document.getElementById('ns-content').classList.remove('hidden');
  } catch (e) {
    document.getElementById('ns-loading').classList.add('hidden');
    document.getElementById('ns-error-text').textContent = '讀取失敗：' + e.message;
    document.getElementById('ns-error').classList.remove('hidden');
  }
}

function renderChannelStatus(channelStatus) {
  const emailEl = document.getElementById('ns-email-status');
  const lineEl = document.getElementById('ns-line-status');
  const emailConfigured = !!(channelStatus.email && channelStatus.email.configured);
  const lineConfigured = !!(channelStatus.line && channelStatus.line.configured);
  emailEl.textContent = emailConfigured ? '已設定' : '尚未設定';
  emailEl.className = 'status-pill ' + (emailConfigured ? 'active' : 'low');
  lineEl.textContent = lineConfigured ? '已設定' : '尚未設定';
  lineEl.className = 'status-pill ' + (lineConfigured ? 'active' : 'low');
}

function renderEventSettingsTable(channelSettings) {
  const tbody = document.getElementById('ns-event-table-body');
  tbody.textContent = '';
  notificationEventTypes.forEach(eventType => {
    const setting = channelSettings[eventType] || { emailEnabled: false, lineEnabled: false };
    const tr = document.createElement('tr');

    const tdLabel = document.createElement('td');
    tdLabel.textContent = notificationEventLabels[eventType] || eventType;
    tr.appendChild(tdLabel);

    const tdCenter = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'status-pill active';
    pill.textContent = '一律建立';
    tdCenter.appendChild(pill);
    tr.appendChild(tdCenter);

    const tdEmail = document.createElement('td');
    const emailCheckbox = document.createElement('input');
    emailCheckbox.type = 'checkbox';
    emailCheckbox.checked = !!setting.emailEnabled;
    emailCheckbox.addEventListener('change', () => updateEventChannelSetting(eventType, 'emailEnabled', emailCheckbox.checked, tr));
    tdEmail.appendChild(emailCheckbox);
    tr.appendChild(tdEmail);

    const tdLine = document.createElement('td');
    const lineCheckbox = document.createElement('input');
    lineCheckbox.type = 'checkbox';
    lineCheckbox.checked = !!setting.lineEnabled;
    lineCheckbox.addEventListener('change', () => updateEventChannelSetting(eventType, 'lineEnabled', lineCheckbox.checked, tr));
    tdLine.appendChild(lineCheckbox);
    tr.appendChild(tdLine);

    tbody.appendChild(tr);
  });
}

async function updateEventChannelSetting(eventType, field, value, trEl) {
  const checkboxes = trEl.querySelectorAll('input[type="checkbox"]');
  checkboxes.forEach(cb => { cb.disabled = true; });
  try {
    const emailCheckbox = trEl.children[2].querySelector('input');
    const lineCheckbox = trEl.children[3].querySelector('input');
    const body = { emailEnabled: emailCheckbox.checked, lineEnabled: lineCheckbox.checked };
    body[field] = value;
    const resp = await adminFetch(`/api/admin/notification-settings/${encodeURIComponent(eventType)}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      showAdminToast((data && data.error) || '設定更新失敗', true);
      loadNotificationSettings(); // 失敗時重新整理，避免畫面上的勾選狀態跟伺服器實際設定不一致
      return;
    }
    showAdminToast('已更新通知設定');
  } catch (e) {
    showAdminToast('設定更新失敗：' + e.message, true);
    loadNotificationSettings();
  } finally {
    checkboxes.forEach(cb => { cb.disabled = false; });
  }
}

async function sendTestNotification() {
  const channels = [];
  if (document.getElementById('ns-test-email').checked) channels.push('email');
  if (document.getElementById('ns-test-line').checked) channels.push('line');
  const resultEl = document.getElementById('ns-test-result');
  if (!channels.length) {
    resultEl.textContent = '請至少選擇一個管道';
    return;
  }
  // 2026-08-21盤點指出：頁面文案明確警告「正式環境會真的寄出／推播，請謹慎使用」，卻沒有
  // 搭配任何二次確認，跟警告語氣不一致，這裡補上共用確認對話框。
  const { confirmed } = await adminConfirmDialog({
    title: '確認送出測試通知',
    message: `確定要透過 ${channels.map(c => c === 'email' ? 'Email' : 'LINE').join('、')} 送出測試通知嗎？正式環境會真的寄出信件或推播訊息。`,
    confirmLabel: '確認送出'
  });
  if (!confirmed) return;
  const btn = document.getElementById('ns-test-btn');
  btn.disabled = true;
  resultEl.textContent = '傳送中…';
  try {
    const resp = await adminFetch('/api/admin/notification-settings/test', {
      method: 'POST',
      body: JSON.stringify({ channels })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data) {
      resultEl.textContent = (data && data.error) || '測試通知發送失敗';
      return;
    }
    const jobResults = (data.jobs || []).map(j => {
      const channelLabel = j.channel === 'email' ? 'Email' : 'LINE';
      const statusLabel = { sent: '已送出', failed: '失敗（將自動重試）', abandoned: '未送出', sending: '傳送中' }[j.status] || j.status;
      const errorText = j.errorCategory ? `（${j.errorCategory}${j.lastError ? '：' + j.lastError : ''}）` : '';
      return `${channelLabel}：${statusLabel}${errorText}`;
    });
    resultEl.textContent = jobResults.length ? jobResults.join('｜') : '已建立測試通知，但沒有排入任何傳送工作';
  } catch (e) {
    resultEl.textContent = '測試通知發送失敗：' + e.message;
  } finally {
    btn.disabled = false;
  }
}
