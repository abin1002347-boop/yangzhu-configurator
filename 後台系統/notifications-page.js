// 楊竹科技後台系統 — 通知中心頁（統一通知系統批次）
// 只提供查詢與標記已讀，通知事件本身的建立完全由後端業務流程觸發（新詢價／低庫存／客戶
// 報價回覆／備份還原失敗），這個頁面不提供新增或刪除通知的功能。

let notifCurrentPage = 1;
let notifTotalPages = 1;
// 請求序號：跟audit-page.js同一套防護，避免快速切換篩選或連續點頁碼時，較慢的舊回應蓋掉
//較快的新回應（2026-08-21盤點指出這裡原本完全沒有防護）。
let notifRequestSeq = 0;

const NOTIF_SEVERITY_LABELS = { normal: '一般', warning: '警告', critical: '嚴重' };

function onAdminReady() {
  loadNotificationCenter(1);
}

async function loadNotificationCenter(page) {
  notifCurrentPage = page || 1;
  const mySeq = ++notifRequestSeq;
  document.getElementById('notif-loading').classList.remove('hidden');
  document.getElementById('notif-error').classList.add('hidden');
  document.getElementById('notif-empty').classList.add('hidden');
  document.getElementById('notif-list-wrap').classList.add('hidden');

  const params = new URLSearchParams();
  params.set('page', String(notifCurrentPage));
  params.set('pageSize', '20');
  const status = document.getElementById('notif-status-filter').value;
  if (status) params.set('status', status);

  try {
    const resp = await adminFetch('/api/admin/notifications?' + params.toString());
    const data = await resp.json().catch(() => null);
    if (mySeq !== notifRequestSeq) return; // 已經有更新的請求送出，這次回應已經過時，捨棄
    document.getElementById('notif-loading').classList.add('hidden');
    if (!resp.ok) {
      document.getElementById('notif-error-text').textContent = (data && data.error) || '讀取失敗';
      document.getElementById('notif-error').classList.remove('hidden');
      return;
    }
    const notifications = Array.isArray(data.notifications) ? data.notifications : [];
    notifTotalPages = Math.max(1, Math.ceil((data.total || 0) / (data.pageSize || 20)));
    if (!notifications.length) {
      document.getElementById('notif-empty').classList.remove('hidden');
      return;
    }
    renderNotificationList(notifications);
    document.getElementById('notif-page-info-text').textContent = `第 ${data.page} / ${notifTotalPages} 頁，共 ${data.total} 筆`;
    document.getElementById('btn-notif-prev-page').disabled = notifCurrentPage <= 1;
    document.getElementById('btn-notif-next-page').disabled = notifCurrentPage >= notifTotalPages;
    document.getElementById('notif-list-wrap').classList.remove('hidden');
  } catch (e) {
    if (mySeq !== notifRequestSeq) return;
    document.getElementById('notif-loading').classList.add('hidden');
    document.getElementById('notif-error-text').textContent = '讀取失敗：' + e.message;
    document.getElementById('notif-error').classList.remove('hidden');
  }
  if (typeof refreshAdminNotifBadge === 'function') refreshAdminNotifBadge();
}

function changeNotificationPage(delta) {
  const next = notifCurrentPage + delta;
  if (next < 1 || next > notifTotalPages) return;
  loadNotificationCenter(next);
}

function fmtNotifTime(iso) {
  try { return new Date(iso).toLocaleString('zh-TW', { hour12: false }); }
  catch { return iso || '--'; }
}

// 全部動態內容一律用 DOM API 建立節點＋textContent 賦值，不使用未跳脫的innerHTML，避免
// 事件標題／摘要等資料造成 XSS。
function renderNotificationList(list) {
  const ul = document.getElementById('notif-list');
  ul.textContent = '';
  list.forEach(n => {
    const li = document.createElement('li');
    li.className = 'admin-notif-center-item' + (n.readAt ? '' : ' unread') + ' severity-' + (n.severity || 'normal');

    const head = document.createElement('div');
    head.className = 'admin-notif-center-item-head';

    const typeTag = document.createElement('span');
    typeTag.className = 'admin-notif-center-type-tag';
    typeTag.textContent = n.eventTypeLabel || n.eventType;
    head.appendChild(typeTag);

    if (n.severity && n.severity !== 'normal') {
      const sevTag = document.createElement('span');
      sevTag.className = 'admin-notif-center-severity-tag severity-' + n.severity;
      sevTag.textContent = NOTIF_SEVERITY_LABELS[n.severity] || n.severity;
      head.appendChild(sevTag);
    }

    const timeEl = document.createElement('span');
    timeEl.className = 'admin-notif-center-item-time';
    timeEl.textContent = fmtNotifTime(n.eventCreatedAt);
    head.appendChild(timeEl);

    li.appendChild(head);

    const titleEl = document.createElement('div');
    titleEl.className = 'admin-notif-center-item-title';
    titleEl.textContent = n.title;
    li.appendChild(titleEl);

    if (n.summary) {
      const summaryEl = document.createElement('div');
      summaryEl.className = 'admin-notif-center-item-summary';
      summaryEl.textContent = n.summary;
      li.appendChild(summaryEl);
    }

    // admin.html本身就支援 ?order=訂單編號 深連結（見該檔案的maybeOpenOrderFromQuery()），
    // 會自動開啟該筆訂單既有的詳情面板；products.html沒有對應的商品深連結，先連到列表頁。
    if (n.resourceType === 'order' && n.resourceId) {
      const linkEl = document.createElement('a');
      linkEl.href = '/admin?order=' + encodeURIComponent(n.resourceId);
      linkEl.className = 'admin-notif-center-item-link';
      linkEl.textContent = '查看訂單';
      li.appendChild(linkEl);
    } else if (n.resourceType === 'product' && n.resourceId) {
      const linkEl = document.createElement('a');
      linkEl.href = '/admin/products';
      linkEl.className = 'admin-notif-center-item-link';
      linkEl.textContent = `前往商品管理（商品編號：${n.resourceId}）`;
      li.appendChild(linkEl);
    }

    if (!n.readAt) {
      const readBtn = document.createElement('button');
      readBtn.type = 'button';
      readBtn.className = 'btn btn-secondary btn-sm';
      readBtn.textContent = '標示已讀';
      readBtn.addEventListener('click', () => markNotificationRead(n.id, li, readBtn));
      li.appendChild(readBtn);
    }

    ul.appendChild(li);
  });
}

async function markNotificationRead(id, liEl, btnEl) {
  if (btnEl) btnEl.disabled = true;
  try {
    const resp = await adminFetch(`/api/admin/notifications/${encodeURIComponent(id)}/read`, { method: 'POST' });
    if (resp.ok) {
      liEl.classList.remove('unread');
      if (btnEl) btnEl.remove();
      if (typeof refreshAdminNotifBadge === 'function') refreshAdminNotifBadge();
    } else if (btnEl) {
      btnEl.disabled = false;
    }
  } catch (e) {
    if (btnEl) btnEl.disabled = false;
  }
}

async function markAllNotificationsRead() {
  const btn = document.getElementById('notif-mark-all-btn');
  btn.disabled = true;
  try {
    await adminFetch('/api/admin/notifications/read-all', { method: 'POST' });
  } catch (e) {
    // 靜默失敗，使用者可以再次點擊重試
  }
  btn.disabled = false;
  loadNotificationCenter(notifCurrentPage);
}
