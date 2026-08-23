// 楊竹科技後台系統 — 全站維護模式（正式資料庫還原安全機制）
// 單一Node行程共用的記憶體旗標，只存在於目前執行中的行程記憶體，重啟後自動變回false，
// 不需要另外持久化清除。目的是在「正式資料庫還原」這種會直接置換 admin.db／訂單資料夾
// 檔案的高風險操作進行時，擋下所有可能同時讀寫這些檔案的請求，避免半套資料或競爭寫入。
//
// 一旦還原流程進行到「關閉正式SQLite連線、開始置換檔案」這一步（見 admin-routes.js 的
// restore路由），不論最後還原成功或失敗，這個行程內所有模組層級的 `db.prepare(...)`
// 語句都是綁定在同一個已關閉的連線物件上，無法在同一個行程內安全恢復——維護模式旗標會
// 持續維持開啟，直到有人手動重啟正式3777為止，這是刻意設計，不是忘記關閉。
let maintenanceMode = false;
let maintenanceReason = null;
let maintenanceSince = null;

function isMaintenanceMode() {
  return maintenanceMode;
}
function enterMaintenanceMode(reason) {
  maintenanceMode = true;
  maintenanceReason = reason || '系統維護中，請稍後再試';
  maintenanceSince = new Date().toISOString();
}
function exitMaintenanceMode() {
  maintenanceMode = false;
  maintenanceReason = null;
  maintenanceSince = null;
}
function getMaintenanceInfo() {
  return { maintenanceMode, maintenanceReason, maintenanceSince };
}

module.exports = { isMaintenanceMode, enterMaintenanceMode, exitMaintenanceMode, getMaintenanceInfo };
