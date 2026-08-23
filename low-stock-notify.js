// 低庫存主動通知：共用判斷邏輯，被所有會改變庫存的正式流程呼叫（手動進出貨/調整、訂單成交
// 自動扣庫存、訂單取消回補、庫存盤點確認）。核心規則：庫存從「正常」跨入「低庫存」
// （stock_qty <= low_stock_threshold）時建立一筆新通知；持續處於低庫存不重複建立；補貨恢復
// 正常後解除目前的低庫存狀態，允許未來再次降低時重新建立新通知。
//
// 呼叫端全部都是既有的庫存／訂單資料庫交易（db.transaction() 內）：這支函式只讀寫同一個
// db 連線，因此天生會參與呼叫端目前所在的 transaction，不需要另外傳遞 transaction 物件。
// 通知本身只是附加的觀察性功能，寫入失敗絕對不能讓庫存或訂單交易失敗或被回滾，所以整個函式
// 內部自行 try/catch 並只記錄錯誤、絕不對外拋出例外。
const { db } = require('./db');
const { emitNotificationEvent } = require('./notification-service'); // 統一通知系統批次：低庫存跨入時同步餵一筆事件進去，供後台通知中心／Email／LINE使用

function checkLowStockTransition(productId, stockQty, threshold) {
  try {
    const isLow = stockQty <= threshold;
    const activeNotif = db.prepare(`
      SELECT id FROM low_stock_notifications WHERE product_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1
    `).get(productId);

    if (isLow) {
      if (!activeNotif) {
        // 目前沒有進行中的低庫存通知：代表這次是從正常跨入低庫存，建立新的一筆。
        const now = new Date().toISOString();
        const info = db.prepare(`
          INSERT INTO low_stock_notifications (product_id, stock_qty, low_stock_threshold, status, created_at, read_at)
          VALUES (?, ?, ?, 'active', ?, NULL)
        `).run(productId, stockQty, threshold, now);
        // idempotencyKey用這張表自己剛建立的id：同一次「從正常跨入低庫存」只會有一個
        // low_stock_notifications id，天生保證只餵進統一通知系統一次；下次補貨恢復正常後
        // 再次降到警戒值以下時，activeNotif一定是新的一筆、id也不同，會被視為全新事件。
        emitNotificationEvent({
          eventType: 'low_stock',
          idempotencyKey: String(info.lastInsertRowid),
          title: `低庫存：商品 ${productId}`,
          summary: `目前庫存 ${stockQty}，警戒值 ${threshold}`,
          severity: 'warning',
          resourceType: 'product',
          resourceId: productId
        });
      }
      // 已經有 active 通知：持續處於低庫存，不重複建立。
    } else if (activeNotif) {
      // 庫存已經不再低於警戒值：解除目前的低庫存狀態，之後再次降低會被視為全新的一次跨入。
      db.prepare(`UPDATE low_stock_notifications SET status = 'resolved' WHERE id = ?`).run(activeNotif.id);
    }
  } catch (err) {
    console.error('[low-stock-notify] 低庫存通知檢查失敗（不影響庫存／訂單交易）：', err.message);
  }
}

module.exports = { checkLowStockTransition };
