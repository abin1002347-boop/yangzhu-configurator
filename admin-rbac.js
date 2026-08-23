// 楊竹科技後台系統 — 集中式角色權限表（正式管理員帳號、角色權限、登入限制與操作稽核批次）
// 所有後台頁面／API的權限判斷都集中在這一個檔案的 PERMISSIONS 表，不把權限判斷零散寫在
// 每個路由檔案裡；前端隱藏選單或按鈕只能改善畫面，後端這裡才是最終權限判斷來源。
//
// 角色（由低到高沒有嚴格的權限包含關係，viewer 是「唯讀」，其餘三者依業務範圍各自不同）：
//   owner   —— 所有權限，包含帳號、角色與安全設定
//   manager —— 訂單、商品、庫存、客戶、分析及網站營運功能；不可管理owner或安全設定
//   staff   —— 訂單、客戶及日常處理功能；不可管理帳號、網站設定、AI設定
//   viewer  —— 只可查看獲准資料，不可新增、修改、刪除、封存、下載工廠包或執行其他敏感操作
//
// PERMISSIONS[resource][action] 的值是「允許的角色陣列」；resource／action 沒有出現在這張表
// 裡（不論是打錯字、還是未來新增API忘了登記）一律視為「找不到 = 拒絕」，不是「找不到 = 放行」
// ——這是刻意的安全預設值（fail closed），對應需求「未列入權限表的新API預設拒絕，不可預設放行」。

const ALL_ROLES = ['owner', 'manager', 'staff', 'viewer'];

const PERMISSIONS = {
  // 訂單管理（/api/orders/*）
  orders:            { view: ['owner', 'manager', 'staff', 'viewer'], write: ['owner', 'manager', 'staff'] },
  // 訂單狀態「恢復」（從終止狀態已完成／已取消改回其他狀態）：比一般狀態推進更容易造成
  // 資料混亂，限制在 owner／manager，staff 的「日常處理功能」不含這項例外操作。
  orders_restore:    { write: ['owner', 'manager'] },
  // 工廠包下載：viewer「不可…下載工廠包或執行其他敏感操作」，其餘三個角色都可以下載。
  factory_package:   { download: ['owner', 'manager', 'staff'] },

  // 商品管理（/api/admin/products*、/api/admin/upload-image）
  products:          { view: ['owner', 'manager', 'staff', 'viewer'], write: ['owner', 'manager'] },

  // 庫存管理（/api/admin/inventory*、/api/admin/stocktakes*）
  inventory:         { view: ['owner', 'manager', 'staff', 'viewer'], write: ['owner', 'manager'] },

  // 低庫存通知：查看開放給四個角色；標記已讀雖然風險低，但本質上仍是「寫入」（改變
  // read_at／status），viewer必須維持純唯讀，不可以有任何寫入型操作可以成功，因此排除viewer
  // （2026-08-14 Codex獨立複驗指出viewer原本可以呼叫標記已讀成功，已修正）。
  notifications:     { view: ALL_ROLES, write: ['owner', 'manager', 'staff'] },

  // 客戶管理（/api/admin/customers*、/api/admin/customer-tags、/api/admin/customer-merge*）
  customers:         { view: ['owner', 'manager', 'staff', 'viewer'], write: ['owner', 'manager', 'staff'] },
  // 客戶合併／解除合併：影響範圍橫跨多筆歷史訂單與備註，限制在 owner／manager。
  customer_merge:    { write: ['owner', 'manager'] },

  // 總覽儀表板：一般性統計數字，四個角色都可以查看。
  dashboard:         { view: ALL_ROLES },

  // 網站分析（/api/admin/analytics/overview、/api/admin/ai-usage-stats）：manager 明確列有
  // 「分析」權限，staff／viewer 沒有列在對應角色描述裡，不開放。
  analytics:         { view: ['owner', 'manager'] },

  // 網站內容設定：staff「不可管理…網站設定」，viewer 只能查看「獲准資料」，這裡不含管理設定。
  site_settings:     { view: ['owner', 'manager'], write: ['owner', 'manager'] },

  // AI 功能設定：staff「不可管理…AI設定」。
  ai_settings:       { view: ['owner', 'manager'], write: ['owner', 'manager'] },

  // 管理員帳號管理：只有 owner 可以新增帳號、修改角色、停用／啟用、設定新密碼；manager
  // 「不可管理owner或安全設定」。一般使用者查詢「自己」的帳號資訊走 GET /api/admin/session，
  // 不受這張表限制（那是任何已登入者都能看到自己的安全公開資料）。
  admin_users:       { view: ['owner'], write: ['owner'] },

  // 操作稽核紀錄查詢：只提供查詢，不提供修改／刪除 API（見 db.js 只有 recordAdminAuditLog／
  // queryAdminAuditLog 兩個函式）。開放給 owner／manager 查看團隊操作紀錄。
  audit_log:         { view: ['owner', 'manager'] },

  // 資料庫備份與還原驗證（後台資料庫備份與還原第一階段）：備份檔內含完整商品／客戶／帳號
  // ／分析資料庫快照與全部訂單資料，比一般業務資料更敏感，且刪除、還原驗證都屬於高風險操作，
  // 限制只有 owner 可以使用，manager 也不開放（跟 admin_users 同一等級的保護）。
  // restore（正式資料庫還原安全機制）：把選定備份真正覆蓋正式admin.db與正式訂單資料夾的
  // 高風險操作，跟其餘db_backup動作一樣限制只有owner，額外要求還原當下重新輸入密碼驗證身分
  // （見admin-routes.js的restore路由），角色權限只是第一道關卡，不是唯一防線。
  db_backup:         { view: ['owner'], create: ['owner'], download: ['owner'], delete: ['owner'], restore_verify: ['owner'], restore: ['owner'] },

  // 後台通知中心（統一通知系統批次）：查看與標記已讀開放給四個角色（viewer只能查看／標記
  // 已讀，不牽涉業務資料寫入，比照低庫存通知notifications資源的既有先例）；write僅供「標記
  // 已讀」使用，viewer必須維持純唯讀——因此write不含viewer，跟既有notifications資源同一套
  // 規則。
  notification_center: { view: ALL_ROLES, write: ['owner', 'manager', 'staff'] },

  // 通知管道設定（SMTP／LINE是否啟用、依事件類型選擇管道）：屬於系統層級設定，manager可以
  // 查看目前狀態，但只有owner可以修改設定或觸發測試通知——測試通知會實際呼叫外部Email／
  // LINE服務（或隔離測試時的本機mock），風險層級比照db_backup的owner限定。
  notification_settings: { view: ['owner', 'manager'], write: ['owner'] },

  // 系統設定（正式功能第一批）：系統層級全域設定＋唯讀系統資訊（伺服器時間、健康狀態、
  // 資料庫完整性、維護模式等），只有owner可以查看或修改，manager／staff／viewer一律403
  // ——跟admin_users、db_backup同一等級的保護，不對其他角色開放任何唯讀查看。
  // check_integrity是獨立的手動觸發動作（執行PRAGMA integrity_check），刻意跟view分開
  // 登記，避免單純打開頁面（view）就意外觸發這個成本較高的檢查。
  system_settings: { view: ['owner'], write: ['owner'], check_integrity: ['owner'] },

  // 報價預設有效天數（唯讀單一數值，供「訂單管理」的「發布新報價版本」表單當作預設值）：
  // 這個數值本身儲存在system_settings（只有owner能修改），但四個角色都可能需要在訂單詳情
  // 頁發布報價版本（見PERMISSIONS.orders.write包含owner／manager／staff），因此另外開一個
  // 極小範圍的唯讀端點，只回傳這一個非敏感整數，不受system_settings的owner限定，也不會
  // 回傳system_settings的其他任何欄位或系統資訊。
  quote_defaults:    { view: ALL_ROLES },

  // 後台快速搜尋（頂部搜尋框，正式功能）：只查詢訂單與商品兩類，四個角色都能看見的資料範圍
  // 本來就跟既有 orders.view／products.view 完全一致（皆為ALL_ROLES）——這裡只是提供比開啟
  // 完整清單頁再手動篩選更快的搜尋管道，沒有多開放任何原本看不到的資料範圍，因此比照兩者
  // 開放給全部角色。
  quick_search:      { view: ALL_ROLES },

  // 登入狀態確認（GET /api/admin/ping、GET /api/admin/session）：純粹確認「目前這個Session
  // 是否還有效」，不牽涉任何業務資料，四個角色都需要用它來判斷要不要顯示登入畫面，因此
  // 開放給全部角色查看（2026-08-14 Codex獨立複驗指出 /api/admin/ping 原本完全沒有登記在
  // 權限表裡、viewer可以直接取得200，已修正——未列入權限表的API一律預設拒絕，這裡改成
  // 明確登記，不再是「漏掉」的狀態）。
  session:           { view: ALL_ROLES }
};

// 未列入權限表的 resource／action 組合，PERMISSIONS[resource] 或 [resource][action] 會是
// undefined，Array.isArray(undefined) 為 false，requirePermission() 因此會直接回傳 403，
// 天生就是「預設拒絕」，不需要額外的白名單判斷。
function requirePermission(resource, action) {
  const allowedRoles = PERMISSIONS[resource] && PERMISSIONS[resource][action];
  return function (req, res, next) {
    const role = req.adminUser && req.adminUser.role;
    if (!role || !Array.isArray(allowedRoles) || !allowedRoles.includes(role)) {
      return res.status(403).json({ error: '您的帳號權限不足，無法執行此操作' });
    }
    next();
  };
}

// 只允許 owner 的專用捷徑（帳號管理、危險的角色／狀態變更），語意上等同
// requirePermission('admin_users', 'write')，但用在 admin-users 路由檔案內部一些不方便用
// resource/action 表達的細節判斷（例如「不可停用自己」）時，直接檢查 req.adminUser.role
// 更清楚。
function requireOwner(req, res, next) {
  if (!req.adminUser || req.adminUser.role !== 'owner') {
    return res.status(403).json({ error: '僅限 owner 執行此操作' });
  }
  next();
}

module.exports = { ALL_ROLES, PERMISSIONS, requirePermission, requireOwner };
