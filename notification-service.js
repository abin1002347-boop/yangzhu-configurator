// 楊竹科技後台系統 — 統一通知系統核心邏輯（Email／LINE／後台通知中心批次）
// 事件（notification_events）→ 後台通知（admin_notifications，一定建立）→ 外部傳送工作
// （notification_delivery_jobs，依notification_channel_settings決定要不要建立）三層資料，
// 呼叫端（新詢價／低庫存／客戶報價回覆／備份還原失敗／其他系統錯誤）只需要呼叫
// emitNotificationEvent()一個函式，事件建立、去重、後台通知、外部工作排程全部在同一個
// SQLite交易內完成，天生原子、天生冪等（event_key有UNIQUE，同一個key重複呼叫只會回傳
// 既有事件，不會建立第二筆或排入第二次外部傳送）。
//
// 這支函式設計上「絕不拋出例外」，跟low-stock-notify.js的checkLowStockTransition()同一套
// 原則——通知是附加功能，絕對不能讓呼叫端（訂單／庫存／報價等正式交易）因為通知寫入失敗
// 而跟著失敗或被回滾。
const { randomUUID } = require('crypto');
const { db } = require('./db');

const EVENT_TYPES = ['new_inquiry', 'low_stock', 'quote_accepted', 'quote_rejected', 'backup_restore_failed', 'system_error'];
const DEFAULT_MAX_ATTEMPTS = 5;
// 第1～5次重試前各自要等待的秒數，指數退避且封頂，避免SMTP／LINE服務短暫不穩時被瞬間洗版。
const RETRY_BACKOFF_SECONDS = [30, 120, 600, 1800, 3600];
// 派送中租約：一筆工作被claim成'sending'之後，最晚必須在這段時間內回報成功或失敗，否則視為
// claim它的行程已經中斷（伺服器重啟、崩潰等），下一輪claimDueDeliveryJobs()會安全回收。
// Email／LINE每次網路呼叫本身的逾時上限都是8秒（見notification-channels.js），60秒是這個
// 上限的7倍以上，就算加上偶發的DNS查詢延遲或系統忙碌，正常派送也不可能撐到這個時間才完成，
// 足夠寬鬆到不會提早回收「其實還在正常傳送中」的工作（Codex獨立複驗要求：避免正常派送尚未
// 結束就被提前回收）。
const SENDING_LEASE_SECONDS = 60;

function nowIso() { return new Date().toISOString(); }

// 依目前notification_channel_settings，在同一個交易裡把這個事件需要的外部傳送工作排進去。
// INSERT OR IGNORE＋UNIQUE(event_id,channel,target)：就算被呼叫兩次也只會有一筆，不會重複派送。
function enqueueDeliveryJobInTx(eventId, channel, target) {
  const now = nowIso();
  db.prepare(`
    INSERT OR IGNORE INTO notification_delivery_jobs
      (event_id, channel, target, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)
  `).run(eventId, channel, target, DEFAULT_MAX_ATTEMPTS, now, now, now);
}

// 建立一筆通知事件（如果event_key已存在，直接回傳既有事件，不重複建立、不重複排入外部
// 傳送工作）。idempotencyKey由呼叫端提供，必須是這個事件在業務上真正唯一的識別（例如
// 訂單編號、低庫存通知本身的id、客戶報價回覆自帶的UUID），確保「同一件事」不論被呼叫幾次
// 都只留下一筆事件與最多一組外部傳送工作。
function emitNotificationEvent({ eventType, idempotencyKey, title, summary, severity, resourceType, resourceId, metadata }) {
  if (!EVENT_TYPES.includes(eventType)) {
    console.error('[notification] 未知事件類型，拒絕建立事件：' + eventType);
    return null;
  }
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) {
    console.error('[notification] 缺少idempotencyKey，拒絕建立事件：' + eventType);
    return null;
  }
  if (typeof title !== 'string' || !title) {
    console.error('[notification] 缺少title，拒絕建立事件：' + eventType);
    return null;
  }
  try {
    const eventKey = `${eventType}:${idempotencyKey}`;
    let eventId = null;
    let created = false;
    const tx = db.transaction(() => {
      const existing = db.prepare('SELECT id FROM notification_events WHERE event_key = ?').get(eventKey);
      if (existing) { eventId = existing.id; return; }

      const now = nowIso();
      const info = db.prepare(`
        INSERT INTO notification_events (event_key, event_type, title, summary, severity, resource_type, resource_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventKey, eventType, title, summary || null, severity || 'normal', resourceType || null, resourceId || null, metadata ? JSON.stringify(metadata) : null, now);
      eventId = info.lastInsertRowid;
      created = true;

      db.prepare(`INSERT INTO admin_notifications (event_id, read_at, created_at) VALUES (?, NULL, ?)`).run(eventId, now);

      const settings = db.prepare('SELECT email_enabled, line_enabled FROM notification_channel_settings WHERE event_type = ?').get(eventType);
      if (settings && settings.email_enabled) enqueueDeliveryJobInTx(eventId, 'email', 'default');
      if (settings && settings.line_enabled) enqueueDeliveryJobInTx(eventId, 'line', 'default');
    });
    tx();
    return { eventId, created };
  } catch (err) {
    console.error('[notification] 建立通知事件失敗（不影響原本呼叫端的交易）：', err.message);
    return null;
  }
}

// 測試通知（通知設定頁「測試通知」按鈕專用）：跳過notification_channel_settings的一般
// 開關判斷，直接依管理員這次勾選的channels參數排入外部傳送工作——這是一次性的手動驗證
// 動作，不代表往後system_error這個事件類型平常就會透過這些管道發送。event_type固定用
// 'system_error'，idempotencyKey由呼叫端帶入（每次測試都不同，不會被當成重複事件擋掉）。
function emitTestNotificationEvent({ idempotencyKey, actorDisplayName, channels }) {
  if (typeof idempotencyKey !== 'string' || !idempotencyKey) throw new Error('缺少idempotencyKey');
  const eventKey = `system_error:${idempotencyKey}`;
  let eventId = null;
  const tx = db.transaction(() => {
    const now = nowIso();
    const info = db.prepare(`
      INSERT INTO notification_events (event_key, event_type, title, summary, severity, resource_type, resource_id, metadata_json, created_at)
      VALUES (?, 'system_error', '測試通知', ?, 'normal', NULL, NULL, NULL, ?)
    `).run(eventKey, `由管理員（${actorDisplayName || '未知帳號'}）手動觸發，用來確認通知管道設定是否正確`, now);
    eventId = info.lastInsertRowid;
    db.prepare(`INSERT INTO admin_notifications (event_id, read_at, created_at) VALUES (?, NULL, ?)`).run(eventId, now);
    (Array.isArray(channels) ? channels : []).forEach(ch => {
      if (ch === 'email' || ch === 'line') enqueueDeliveryJobInTx(eventId, ch, 'default');
    });
  });
  tx();
  return { eventId };
}

// ─── 後台通知中心：查詢與已讀狀態 ─────────────────────────────
function listAdminNotifications({ page, pageSize, status } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const ps = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (p - 1) * ps;
  let where = '';
  if (status === 'unread') where = 'WHERE an.read_at IS NULL';
  else if (status === 'read') where = 'WHERE an.read_at IS NOT NULL';

  const total = db.prepare(`SELECT COUNT(*) c FROM admin_notifications an ${where}`).get().c;
  const rows = db.prepare(`
    SELECT an.id, an.read_at, an.created_at AS notified_at,
           ev.event_type, ev.title, ev.summary, ev.severity, ev.resource_type, ev.resource_id, ev.created_at AS event_created_at
    FROM admin_notifications an
    JOIN notification_events ev ON ev.id = an.event_id
    ${where}
    ORDER BY an.id DESC
    LIMIT ? OFFSET ?
  `).all(ps, offset);
  return { total, page: p, pageSize: ps, rows };
}

function countUnreadAdminNotifications() {
  return db.prepare('SELECT COUNT(*) c FROM admin_notifications WHERE read_at IS NULL').get().c;
}

function markAdminNotificationRead(id) {
  const info = db.prepare('UPDATE admin_notifications SET read_at = ? WHERE id = ? AND read_at IS NULL').run(nowIso(), id);
  return info.changes > 0;
}

function markAllAdminNotificationsRead() {
  const info = db.prepare('UPDATE admin_notifications SET read_at = ? WHERE read_at IS NULL').run(nowIso());
  return info.changes;
}

// ─── 通知管道設定 ─────────────────────────────────────────
function getAllNotificationChannelSettings() {
  const rows = db.prepare('SELECT * FROM notification_channel_settings').all();
  const map = {};
  EVENT_TYPES.forEach(t => { map[t] = { emailEnabled: false, lineEnabled: false }; });
  rows.forEach(r => { map[r.event_type] = { emailEnabled: !!r.email_enabled, lineEnabled: !!r.line_enabled }; });
  return map;
}

function setNotificationChannelSetting(eventType, { emailEnabled, lineEnabled }) {
  if (!EVENT_TYPES.includes(eventType)) {
    throw new Error('未知的事件類型');
  }
  db.prepare(`
    INSERT INTO notification_channel_settings (event_type, email_enabled, line_enabled, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(event_type) DO UPDATE SET
      email_enabled = excluded.email_enabled,
      line_enabled  = excluded.line_enabled,
      updated_at    = excluded.updated_at
  `).run(eventType, emailEnabled ? 1 : 0, lineEnabled ? 1 : 0, nowIso());
}

// ─── 外部傳送工作：worker專用 ───────────────────────────────
// 租約回收：把「已經超過安全逾時、還停在sending」的工作視為claim它的行程已經中斷，安全地
// 收回成pending準備重試（或達重試上限就直接abandoned）。跟recordDeliveryFailure()同一套
// attempt_count／退避／上限邏輯，確保「因租約過期而重試」也受同樣的重試次數上限保護，不會
// 無限重試；error_category固定寫成'lease_expired'（不是'timeout'／'rejected'等一般傳送失敗
// 分類），讓管理員在紀錄裡能明確分辨這筆是「派送行程中斷被回收」，不是外部服務真的拒絕或
// 逾時——這是可能造成重複寄送的情況（如果行程中斷前其實已經送出成功，只是還沒來得及回報），
// 刻意保留清楚可追蹤的紀錄而不是靜默重試掩蓋，供事後對帳排查（2026-08-21 Codex獨立複驗
// 要求「明確處理重試可能造成重複寄送的情況」）。條件式UPDATE要求status仍是'sending'且
// lease_expires_at仍是同一個已過期的值才會生效，避免跟其他同時執行的行程搶到同一筆。回收
// 時一併清空claim_token：舊claim_token失效後，晚到回報的舊worker（帶著舊token）之後
// 呼叫recordDeliverySuccess／recordDeliveryFailure時WHERE會比對不到、更新0筆，不會誤改
// 新worker之後重新claim這筆工作所產生的狀態（2026-08-21第二次獨立複驗要求）。
function reclaimExpiredLeasesInTx(now) {
  const expired = db.prepare(`
    SELECT id, attempt_count, max_attempts, lease_expires_at FROM notification_delivery_jobs
    WHERE status = 'sending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).all(now);
  expired.forEach(job => {
    const attemptCount = job.attempt_count + 1;
    if (attemptCount >= job.max_attempts) {
      db.prepare(`
        UPDATE notification_delivery_jobs
        SET status = 'abandoned', attempt_count = ?, last_error = ?, error_category = 'lease_expired',
            claimed_at = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(attemptCount, '派送程序已中斷超過安全逾時，已達重試上限', now, job.id, job.lease_expires_at);
    } else {
      const backoffSec = RETRY_BACKOFF_SECONDS[Math.min(attemptCount - 1, RETRY_BACKOFF_SECONDS.length - 1)];
      const nextAttemptAt = new Date(Date.now() + backoffSec * 1000).toISOString();
      db.prepare(`
        UPDATE notification_delivery_jobs
        SET status = 'pending', attempt_count = ?, next_attempt_at = ?, last_error = ?, error_category = 'lease_expired',
            claimed_at = NULL, lease_expires_at = NULL, claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'sending' AND lease_expires_at = ?
      `).run(attemptCount, nextAttemptAt, '派送程序已中斷超過安全逾時，準備重試', now, job.id, job.lease_expires_at);
    }
  });
}

// 先回收租約過期的sending工作，再挑出符合條件（到期的pending工作）的id，逐一用「status還是
// 預期值才更新」的條件式UPDATE搶占：即使同一行程內的計時器意外重疊執行、或多個工作程序同時
// 執行，也不會有兩邊同時把同一筆工作判定成「我搶到了」，天生防止同一筆通知被重複傳送。
// claim成功的同時寫入claimed_at／lease_expires_at供回收機制使用，並用crypto.randomUUID()
// 產生全新的一次性claim_token寫入資料庫、同時回傳給呼叫端——每次claim（不論是同一筆工作
// 第一次被領取，或租約過期回收後被下一個worker重新領取）都是全新的token，不可用時間值或
// 遞增序號代替（2026-08-21第二次獨立複驗明確要求），確保後續recordDeliverySuccess／
// recordDeliveryFailure／abandonDeliveryJobImmediately能可靠分辨「這次回報是不是當前這次
// claim發出的」。
function claimDueDeliveryJobs(limit) {
  const now = nowIso();
  reclaimExpiredLeasesInTx(now);

  const n = Math.max(1, Math.min(50, parseInt(limit, 10) || 10));
  const candidates = db.prepare(`
    SELECT id FROM notification_delivery_jobs
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY id ASC LIMIT ?
  `).all(now, n);

  const leaseExpiresAt = new Date(Date.now() + SENDING_LEASE_SECONDS * 1000).toISOString();
  const claimedIds = [];
  candidates.forEach(c => {
    const claimToken = randomUUID();
    const info = db.prepare(`
      UPDATE notification_delivery_jobs
      SET status = 'sending', claimed_at = ?, lease_expires_at = ?, claim_token = ?, updated_at = ?
      WHERE id = ? AND status = 'pending'
    `).run(now, leaseExpiresAt, claimToken, now, c.id);
    if (info.changes > 0) claimedIds.push(c.id);
  });
  if (!claimedIds.length) return [];

  const placeholders = claimedIds.map(() => '?').join(',');
  return db.prepare(`
    SELECT j.*, ev.event_type, ev.title, ev.summary, ev.resource_type, ev.resource_id, ev.metadata_json
    FROM notification_delivery_jobs j
    JOIN notification_events ev ON ev.id = j.event_id
    WHERE j.id IN (${placeholders})
    ORDER BY j.id ASC
  `).all(...claimedIds);
}

// claimToken必須等於這筆工作目前資料庫裡的claim_token、且status仍是'sending'才會生效——
// 這是2026-08-21第二次獨立複驗要求的權杖比對：如果租約已經過期被回收、甚至已被下一個worker
// 重新claim並處理完，這裡帶的是舊token，UPDATE會比對不到、更新0筆，回傳false，不會誤把
// 新worker正在處理或已經處理完的工作狀態覆蓋掉（也不會清掉新worker剛寫入的租約）。
function recordDeliverySuccess(jobId, claimToken) {
  const now = nowIso();
  const info = db.prepare(`
    UPDATE notification_delivery_jobs
    SET status = 'sent', sent_at = ?, updated_at = ?, last_error = NULL, error_category = NULL,
        claimed_at = NULL, lease_expires_at = NULL, claim_token = NULL
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `).run(now, now, jobId, claimToken);
  return info.changes > 0;
}

// 只保存精簡、截斷過的錯誤訊息分類代碼，絕不保存Token、SMTP密碼、完整請求或回應內容——
// 呼叫端（notification-worker.js）在拋出例外時已經先做過一層過濾／截斷，這裡再截斷一次
// 當作第二層防線。
function sanitizeErrorMessage(message) {
  const s = typeof message === 'string' && message ? message : '未知錯誤';
  return s.slice(0, 500);
}

// 跟recordDeliverySuccess()同一套claimToken比對：先用「status仍是sending且claim_token
// 仍等於這次呼叫帶的token」為條件確認這次回報還有效，無效就直接回傳false、完全不更動任何
// 欄位（包含attempt_count也不會被舊worker誤增加），交由worker只留下不含敏感資料的診斷紀錄。
function recordDeliveryFailure(jobId, claimToken, { errorMessage, errorCategory }) {
  const job = db.prepare(`
    SELECT attempt_count, max_attempts FROM notification_delivery_jobs
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `).get(jobId, claimToken);
  if (!job) return false;
  const now = nowIso();
  const attemptCount = job.attempt_count + 1;
  const safeMessage = sanitizeErrorMessage(errorMessage);
  const category = errorCategory || 'unknown';

  if (attemptCount >= job.max_attempts) {
    const info = db.prepare(`
      UPDATE notification_delivery_jobs
      SET status = 'abandoned', attempt_count = ?, last_error = ?, error_category = ?, updated_at = ?,
          claimed_at = NULL, lease_expires_at = NULL, claim_token = NULL
      WHERE id = ? AND status = 'sending' AND claim_token = ?
    `).run(attemptCount, safeMessage, category, now, jobId, claimToken);
    return info.changes > 0;
  }
  const backoffSec = RETRY_BACKOFF_SECONDS[Math.min(attemptCount - 1, RETRY_BACKOFF_SECONDS.length - 1)];
  const nextAttemptAt = new Date(Date.now() + backoffSec * 1000).toISOString();
  const info = db.prepare(`
    UPDATE notification_delivery_jobs
    SET status = 'pending', attempt_count = ?, next_attempt_at = ?, last_error = ?, error_category = ?, updated_at = ?,
        claimed_at = NULL, lease_expires_at = NULL, claim_token = NULL
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `).run(attemptCount, nextAttemptAt, safeMessage, category, now, jobId, claimToken);
  return info.changes > 0;
}

// 管道根本沒設定（config_missing）時不用照一般退避流程白白重試——設定不會自己變好，直接
// 標記abandoned並清楚說明原因，管理員到通知設定頁看到「尚未設定」就知道為什麼會卡在這裡。
function abandonDeliveryJobImmediately(jobId, claimToken, { errorMessage, errorCategory }) {
  const now = nowIso();
  const info = db.prepare(`
    UPDATE notification_delivery_jobs
    SET status = 'abandoned', last_error = ?, error_category = ?, updated_at = ?,
        claimed_at = NULL, lease_expires_at = NULL, claim_token = NULL
    WHERE id = ? AND status = 'sending' AND claim_token = ?
  `).run(sanitizeErrorMessage(errorMessage), errorCategory || 'config_missing', now, jobId, claimToken);
  return info.changes > 0;
}

function queryNotificationDeliveryJobs({ eventId } = {}) {
  if (eventId) {
    return db.prepare('SELECT * FROM notification_delivery_jobs WHERE event_id = ? ORDER BY id ASC').all(eventId);
  }
  return db.prepare('SELECT * FROM notification_delivery_jobs ORDER BY id DESC LIMIT 100').all();
}

module.exports = {
  EVENT_TYPES,
  emitNotificationEvent,
  emitTestNotificationEvent,
  listAdminNotifications,
  countUnreadAdminNotifications,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  getAllNotificationChannelSettings,
  setNotificationChannelSetting,
  claimDueDeliveryJobs,
  recordDeliverySuccess,
  recordDeliveryFailure,
  abandonDeliveryJobImmediately,
  queryNotificationDeliveryJobs
};
