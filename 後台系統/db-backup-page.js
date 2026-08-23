// 楊竹科技後台系統 — 資料庫備份頁（後台資料庫備份與還原第一階段）
// 這個頁面只有 owner 能實際操作成功：後端 /api/admin/db-backups 系列 API 用 requirePermission
// ('db_backup', ...) 把關（見 admin-rbac.js），這裡的畫面隱藏只是體驗改善，不是安全邊界。

let dbBackupsCache = [];
let isCreatingDbBackup = false;
let isSubmittingRestore = false;
let restoreConfirmTargetId = null;

function onAdminReady() {
  loadDbBackups();
  checkMaintenanceBanner();
}

// 維護模式（正式資料庫還原安全機制）：這支端點不需要登入即可查詢（見server.js允許清單），
// 頁面載入時查一次，正式還原成功後也會馬上再查一次更新畫面，讓使用者立刻看到警示橫幅。
async function checkMaintenanceBanner() {
  const banner = document.getElementById('maintenance-banner');
  try {
    const resp = await fetch('/api/admin/maintenance-status', { credentials: 'same-origin' });
    const data = await resp.json().catch(() => null);
    if (data && data.maintenanceMode) {
      banner.textContent = `系統目前處於維護模式（${data.maintenanceReason || '系統維護中'}），所有正式功能暫停使用，需要工程人員重新啟動正式伺服器才會恢復。`;
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  } catch (e) {
    // 查詢失敗不影響頁面其餘功能，維持橫幅原本的顯示狀態
  }
}

async function loadDbBackups() {
  document.getElementById('backups-loading').classList.remove('hidden');
  document.getElementById('backups-error').classList.add('hidden');
  document.getElementById('backups-table-wrap').classList.add('hidden');
  try {
    const resp = await adminFetch('/api/admin/db-backups');
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      document.getElementById('backups-loading').classList.add('hidden');
      document.getElementById('backups-error-text').textContent = (data && data.error) || '讀取失敗';
      document.getElementById('backups-error').classList.remove('hidden');
      return;
    }
    dbBackupsCache = Array.isArray(data.backups) ? data.backups : [];
    renderDbBackupsTable();
    document.getElementById('backups-loading').classList.add('hidden');
    document.getElementById('backups-table-wrap').classList.remove('hidden');
  } catch (e) {
    document.getElementById('backups-loading').classList.add('hidden');
    document.getElementById('backups-error-text').textContent = '讀取失敗：' + e.message;
    document.getElementById('backups-error').classList.remove('hidden');
  }
}

function fmtBackupTime(iso) {
  if (!iso) return '--';
  try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
  catch { return iso; }
}

function fmtBackupBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '--';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

// partialReason 對應的白話說明——後端只回傳固定分類代碼，畫面上要翻成使用者看得懂的文字。
const DB_BACKUP_PARTIAL_REASON_LABELS = {
  orders_dir_unreadable: '訂單資料夾讀取失敗',
  orders_invalid_entry: '訂單資料夾內有非正常檔案，已中止快照',
  orders_copy_failed: '訂單快照複製過程失敗或筆數核對不符',
  manifest_missing: '找不到備份紀錄檔，無法確認是否完整',
  manifest_mismatch: '訂單快照與備份紀錄檔不一致',
  unknown: '訂單快照狀態不明'
};
function dbBackupPartialReasonLabel(reason) {
  return DB_BACKUP_PARTIAL_REASON_LABELS[reason] || '訂單快照不完整';
}

function renderDbBackupsTable() {
  const tbody = document.getElementById('backups-tbody');
  tbody.textContent = '';
  document.getElementById('backups-empty').classList.toggle('hidden', dbBackupsCache.length > 0);

  dbBackupsCache.forEach(b => {
    const isOk = b.status === 'ok';
    const tr = document.createElement('tr');

    const tdTime = document.createElement('td');
    tdTime.textContent = fmtBackupTime(b.createdAt);
    tr.appendChild(tdTime);

    const tdSize = document.createElement('td');
    tdSize.textContent = fmtBackupBytes(b.totalSizeBytes);
    tr.appendChild(tdSize);

    const tdOrders = document.createElement('td');
    // 不完整時同時顯示「實際複製筆數／預期筆數」，一眼就能看出缺了多少，不是只顯示一個
    // 可能誤導的單一數字。
    tdOrders.textContent = isOk
      ? String(b.orderFileCount)
      : `${b.orderFileCount}／預期${b.expectedOrderCount != null ? b.expectedOrderCount : '?'}`;
    tr.appendChild(tdOrders);

    const tdStatus = document.createElement('td');
    const pill = document.createElement('span');
    // 沿用既有「低庫存警示」同一套紅色樣式（status-pill.low），不完整的備份跟低庫存一樣
    // 屬於需要管理員注意的警示狀態，不新增CSS類別。絕對不會在非'ok'狀態顯示「正常」。
    pill.className = 'status-pill ' + (isOk ? 'active' : 'low');
    pill.textContent = isOk ? '正常' : `不完整：${dbBackupPartialReasonLabel(b.partialReason)}`;
    tdStatus.appendChild(pill);
    tr.appendChild(tdStatus);

    const tdActions = document.createElement('td');
    tdActions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    const btnDownload = document.createElement('button');
    btnDownload.type = 'button';
    btnDownload.className = 'btn btn-secondary btn-sm';
    btnDownload.textContent = '下載';
    btnDownload.addEventListener('click', () => downloadDbBackup(b.id, btnDownload));
    tdActions.appendChild(btnDownload);

    const btnVerify = document.createElement('button');
    btnVerify.type = 'button';
    btnVerify.className = 'btn btn-secondary btn-sm';
    btnVerify.textContent = '隔離驗證';
    btnVerify.addEventListener('click', () => verifyDbBackupRestore(b.id, btnVerify));
    tdActions.appendChild(btnVerify);

    const btnRestore = document.createElement('button');
    btnRestore.type = 'button';
    btnRestore.className = 'btn btn-danger btn-sm';
    btnRestore.textContent = '正式還原';
    btnRestore.addEventListener('click', () => openRestoreConfirmModal(b.id, btnRestore));
    tdActions.appendChild(btnRestore);

    const btnDelete = document.createElement('button');
    btnDelete.type = 'button';
    btnDelete.className = 'btn btn-danger btn-sm';
    btnDelete.textContent = '刪除';
    btnDelete.addEventListener('click', () => deleteDbBackup(b.id, btnDelete));
    tdActions.appendChild(btnDelete);

    tr.appendChild(tdActions);
    tbody.appendChild(tr);
  });
}

async function createDbBackup() {
  if (isCreatingDbBackup) return;
  isCreatingDbBackup = true;
  const btn = document.getElementById('btn-create-backup');
  const errEl = document.getElementById('backup-create-error');
  errEl.classList.add('hidden');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '建立中…';
  try {
    const resp = await adminFetch('/api/admin/db-backups', { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || '建立備份失敗');
    // 只有status:'ok'才能說「已建立完成」；訂單快照不完整時必須明確警告，不可以顯示成功訊息，
    // 避免管理員誤以為這份備份可以安心依賴（Codex獨立複驗指出的問題）。
    const backup = data.backup;
    if (backup && backup.status === 'ok') {
      showAdminToast('備份已建立完成');
    } else {
      const reason = backup ? dbBackupPartialReasonLabel(backup.partialReason) : '';
      errEl.textContent = `資料庫已備份，但訂單快照不完整（${reason}）。SQLite部分仍可正常使用，但這份備份不含完整訂單資料，請盡快重新建立一次備份。`;
      errEl.classList.remove('hidden');
    }
    loadDbBackups();
  } catch (e) {
    errEl.textContent = e.message || '建立備份失敗';
    errEl.classList.remove('hidden');
  } finally {
    isCreatingDbBackup = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function downloadDbBackup(id, btnEl) {
  const cached = dbBackupsCache.find(b => b.id === id);
  if (cached && cached.status !== 'ok') {
    const reason = dbBackupPartialReasonLabel(cached.partialReason);
    const { confirmed } = await adminConfirmDialog({
      title: '確認下載不完整備份',
      message: `這份備份的訂單快照不完整（${reason}），下載到的.zip檔名會加上「_partial_incomplete」提醒，且不含完整訂單資料。確定要下載嗎？`,
      danger: true,
      confirmLabel: '仍要下載'
    });
    if (!confirmed) return;
  }
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '下載中…';
  try {
    const resp = await adminFetch(`/api/admin/db-backups/${encodeURIComponent(id)}/download`);
    if (!resp.ok) {
      const data = await resp.json().catch(() => null);
      throw new Error((data && data.error) || '備份下載失敗');
    }
    await adminDownloadBlob(resp, `backup_${id}.zip`);
  } catch (e) {
    showAdminToast(e.message || '備份下載失敗', true);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

async function deleteDbBackup(id, btnEl) {
  const { confirmed } = await adminConfirmDialog({
    title: '確認刪除備份',
    message: `確定要刪除備份「${id}」嗎？刪除後無法復原，請確認已經下載保存需要的備份。`,
    danger: true,
    confirmLabel: '確認刪除',
    requireText: { label: `請輸入備份識別碼「${id}」以確認刪除`, matchValue: id }
  });
  if (!confirmed) return;
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '刪除中…';
  try {
    const resp = await adminFetch(`/api/admin/db-backups/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || '刪除備份失敗');
    showAdminToast('備份已刪除');
    loadDbBackups();
  } catch (e) {
    showAdminToast(e.message || '刪除備份失敗', true);
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

async function verifyDbBackupRestore(id, btnEl) {
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '驗證中…';
  try {
    const resp = await adminFetch(`/api/admin/db-backups/${encodeURIComponent(id)}/restore-verify`, { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || '隔離還原驗證失敗');
    showVerifyResult(data);
  } catch (e) {
    showAdminToast(e.message || '隔離還原驗證失敗', true);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

function showVerifyResult(data) {
  const body = document.getElementById('verify-result-body');
  body.textContent = '';

  // 整體判定用醒目橫幅呈現在最上方，不能只靠success:true讓人誤以為備份完整
  // （Codex獨立複驗指出的問題）——backupComplete才是「這份備份能不能安心依賴」的真正答案。
  const banner = document.createElement('div');
  if (data.backupComplete) {
    banner.style.cssText = 'padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:13px;font-weight:600;background:var(--green-pale);color:var(--green);';
    banner.textContent = '驗證通過：這份備份的資料庫與訂單快照都完整，可以安心保留。';
  } else {
    banner.style.cssText = 'padding:10px 12px;border-radius:6px;margin-bottom:12px;font-size:13px;font-weight:600;background:#fee2e2;color:#dc2626;';
    banner.textContent = '警告：' + (data.backupWarning || '這份備份不完整，還原後可能遺漏部分資料，請勿當作完整備份使用。');
  }
  body.appendChild(banner);

  function addRow(label, value) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--gray-100);font-size:13px;';
    const l = document.createElement('span');
    l.style.color = 'var(--gray-400)';
    l.textContent = label;
    const v = document.createElement('span');
    v.style.fontWeight = '600';
    v.textContent = value;
    row.appendChild(l);
    row.appendChild(v);
    body.appendChild(row);
  }

  addRow('備份識別碼', data.id);
  // backupStatus（建立備份當下的快照／manifest狀態）跟verificationStatus（這次隔離還原驗證
  // 本身的結論）是兩件不同的事，分開各顯示一列，不要合成一句話——快照當下完整，不代表
  // 這次驗證的SQLite完整性、資料表或訂單JSON內容檢查也一定通過，反之亦然。
  addRow('備份快照狀態', data.backupStatus === 'ok' ? '完整' : `不完整（${dbBackupPartialReasonLabel(data.partialReason)}）`);
  addRow('隔離驗證結果', data.verificationStatus === 'passed' ? '通過' : '未通過');
  addRow('整體判定', data.backupComplete ? '完整可用' : `不完整：${data.backupWarning || '未通過驗證'}`);
  addRow('SQLite 完整性檢查', data.integrityCheck === 'ok' ? '通過' : '未通過，詳見伺服器log');
  addRow('必要資料表', data.missingTables && data.missingTables.length ? `缺少：${data.missingTables.join('、')}` : '齊全');
  addRow('商品筆數', data.counts && data.counts.products != null ? data.counts.products : '--');
  addRow('管理員帳號筆數', data.counts && data.counts.adminUsers != null ? data.counts.adminUsers : '--');
  addRow('訂單快照筆數', data.counts && data.counts.orders != null ? `${data.counts.orders}／預期${data.counts.expectedOrders != null ? data.counts.expectedOrders : '?'}` : '--');
  addRow('客戶筆數（概略值）', data.counts && data.counts.customersApprox != null ? data.counts.customersApprox : '--');
  if (data.orderParseErrorCount) addRow('無法解析的訂單檔案', data.orderParseErrorCount);

  if (data.note) {
    const note = document.createElement('p');
    note.style.cssText = 'font-size:12px;color:var(--gray-400);margin-top:10px;';
    note.textContent = data.note;
    body.appendChild(note);
  }

  document.getElementById('verify-result-modal').classList.remove('hidden');
}

function closeVerifyResultModal() {
  document.getElementById('verify-result-modal').classList.add('hidden');
}

// ─── 正式還原（正式資料庫還原安全機制）───────────────────────────────
// 點擊「正式還原」時，先重新呼叫一次隔離驗證取得最新狀態（不能沿用列表裡可能已經過期的
// 快取結果）——只有這次重新驗證仍然backupComplete的備份，才會打開確認視窗；沒通過就直接
// 用toast說明原因，不讓使用者進到只是浪費時間、最後一定會被後端擋下的確認流程。
async function openRestoreConfirmModal(id, btnEl) {
  const originalText = btnEl.textContent;
  btnEl.disabled = true;
  btnEl.textContent = '確認中…';
  try {
    const resp = await adminFetch(`/api/admin/db-backups/${encodeURIComponent(id)}/restore-verify`, { method: 'POST' });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error((data && data.error) || '隔離還原驗證失敗');
    if (!data.backupComplete) {
      showAdminToast(`這份備份未通過完整驗證，不能執行正式還原：${data.backupWarning || '驗證未通過'}`, true);
      return;
    }

    restoreConfirmTargetId = id;
    document.getElementById('restore-confirm-password').value = '';
    document.getElementById('restore-confirm-text').value = '';
    document.getElementById('restore-confirm-error').textContent = '';
    const summary = document.getElementById('restore-confirm-summary');
    summary.textContent = '';
    [
      ['備份識別碼', id],
      ['備份時間', fmtBackupTime(data.createdAt)],
      ['商品筆數', data.counts.products],
      ['管理員帳號筆數', data.counts.adminUsers],
      ['訂單筆數', data.counts.orders],
      ['客戶筆數（概略值）', data.counts.customersApprox]
    ].forEach(([label, value]) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;padding:4px 0;';
      const l = document.createElement('span');
      l.style.color = 'var(--gray-400)';
      l.textContent = label;
      const v = document.createElement('span');
      v.style.fontWeight = '600';
      v.textContent = value;
      row.appendChild(l);
      row.appendChild(v);
      summary.appendChild(row);
    });

    document.getElementById('restore-confirm-modal').classList.remove('hidden');
  } catch (e) {
    showAdminToast(e.message || '隔離還原驗證失敗', true);
  } finally {
    btnEl.disabled = false;
    btnEl.textContent = originalText;
  }
}

function closeRestoreConfirmModal() {
  document.getElementById('restore-confirm-modal').classList.add('hidden');
  document.getElementById('restore-confirm-password').value = '';
  document.getElementById('restore-confirm-text').value = '';
  restoreConfirmTargetId = null;
}

async function submitRestore() {
  if (isSubmittingRestore || !restoreConfirmTargetId) return;
  const id = restoreConfirmTargetId;
  const password = document.getElementById('restore-confirm-password').value;
  const confirmText = document.getElementById('restore-confirm-text').value.trim();
  const errEl = document.getElementById('restore-confirm-error');
  errEl.textContent = '';

  if (!password) { errEl.textContent = '請輸入目前登入密碼'; return; }
  if (confirmText !== id) { errEl.textContent = '確認文字必須完整輸入這份備份的識別碼'; return; }

  isSubmittingRestore = true;
  const btn = document.getElementById('restore-confirm-submit-btn');
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '還原中，請勿關閉頁面…';
  try {
    const resp = await adminFetch(`/api/admin/db-backups/${encodeURIComponent(id)}/restore`, {
      method: 'POST',
      body: JSON.stringify({ password, confirmText })
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      throw new Error((data && data.error) || '正式還原失敗');
    }
    closeRestoreConfirmModal();
    showAdminToast(data.message || '正式還原已完成');
    checkMaintenanceBanner();
    loadDbBackups();
  } catch (e) {
    errEl.textContent = e.message || '正式還原失敗';
  } finally {
    isSubmittingRestore = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
}
