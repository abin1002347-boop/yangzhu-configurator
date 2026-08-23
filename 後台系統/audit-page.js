// 楊竹科技後台系統 — 操作紀錄查詢頁（正式管理員帳號、角色權限、登入限制與操作稽核批次）
// 只提供查詢，沒有任何修改／刪除這張表資料的按鈕或API可以呼叫（後端 admin-routes.js 的
// GET /api/admin/audit-log 也只有這一支路由，沒有對應的 PUT／DELETE）。

let auditCurrentPage = 1;
let auditTotalPages = 1;
const AUDIT_RESULT_LABELS = { success: '成功', failure: '失敗' };
// 請求序號：快速切換篩選條件或連續點頁碼時，較慢的舊回應理論上可能在較快的新回應之後才
// 回來、把畫面覆蓋回舊資料。每次呼叫loadAuditLog()都取一個新序號，回應回來時比對序號是否
// 還是「目前最新這次」，不是就直接捨棄該次回應（2026-08-21盤點指出這裡原本完全沒有防護）。
let auditRequestSeq = 0;

function onAdminReady() {
  loadAuditLog(1);
}

async function loadAuditLog(page) {
  auditCurrentPage = page || 1;
  const mySeq = ++auditRequestSeq;
  document.getElementById('audit-loading').classList.remove('hidden');
  document.getElementById('audit-error').classList.add('hidden');
  document.getElementById('audit-empty').classList.add('hidden');
  document.getElementById('audit-table-wrap').classList.add('hidden');

  const params = new URLSearchParams();
  params.set('page', String(auditCurrentPage));
  params.set('pageSize', '20');
  const result = document.getElementById('audit-result-filter').value;
  const resourceType = document.getElementById('audit-resource-type-filter').value.trim();
  const dateStart = document.getElementById('audit-date-start').value;
  const dateEnd = document.getElementById('audit-date-end').value;
  if (result) params.set('result', result);
  if (resourceType) params.set('resourceType', resourceType);
  if (dateStart) params.set('dateStart', dateStart + 'T00:00:00.000Z');
  if (dateEnd) params.set('dateEnd', dateEnd + 'T23:59:59.999Z');

  try {
    const resp = await adminFetch('/api/admin/audit-log?' + params.toString());
    const data = await resp.json().catch(() => null);
    if (mySeq !== auditRequestSeq) return; // 已經有更新的請求送出，這次回應已經過時，捨棄
    document.getElementById('audit-loading').classList.add('hidden');
    if (!resp.ok) {
      document.getElementById('audit-error-text').textContent = (data && data.error) || '讀取失敗';
      document.getElementById('audit-error').classList.remove('hidden');
      return;
    }
    const entries = Array.isArray(data.entries) ? data.entries : [];
    auditTotalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 20)));
    if (!entries.length) {
      document.getElementById('audit-empty').classList.remove('hidden');
      return;
    }
    renderAuditTable(entries);
    document.getElementById('audit-page-info-text').textContent = `第 ${data.page} / ${auditTotalPages} 頁，共 ${data.total} 筆`;
    document.getElementById('btn-audit-prev-page').disabled = auditCurrentPage <= 1;
    document.getElementById('btn-audit-next-page').disabled = auditCurrentPage >= auditTotalPages;
    document.getElementById('audit-table-wrap').classList.remove('hidden');
  } catch (e) {
    if (mySeq !== auditRequestSeq) return;
    document.getElementById('audit-loading').classList.add('hidden');
    document.getElementById('audit-error-text').textContent = '讀取失敗：' + e.message;
    document.getElementById('audit-error').classList.remove('hidden');
  }
}

function changeAuditPage(delta) {
  const next = auditCurrentPage + delta;
  if (next < 1 || next > auditTotalPages) return;
  loadAuditLog(next);
}

function fmtAuditTime(iso) {
  try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
  catch { return iso || '--'; }
}

function renderAuditTable(entries) {
  const tbody = document.getElementById('audit-tbody');
  tbody.textContent = '';
  entries.forEach(e => {
    const tr = document.createElement('tr');

    const cells = [
      fmtAuditTime(e.createdAt),
      e.actorUsername || '（未登入／查無帳號）',
      e.action || '--',
      e.resourceType || '--',
      e.resourceId || '--'
    ];
    cells.forEach(text => {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    });

    const tdResult = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = 'status-pill ' + (e.result === 'success' ? 'active' : 'low');
    pill.textContent = AUDIT_RESULT_LABELS[e.result] || e.result;
    tdResult.appendChild(pill);
    tr.appendChild(tdResult);

    const tdStatus = document.createElement('td');
    tdStatus.textContent = e.httpStatus != null ? String(e.httpStatus) : '--';
    tr.appendChild(tdStatus);

    tbody.appendChild(tr);
  });
}
