// 訂單自動扣庫存／取消自動回補的安全底層。deductInventoryForOrder() 已經接到訂單狀態路由
// （quoted → closed_won），restockInventoryForOrderCancellation() 本階段只建立函式本身並完整
// 測試，刻意不接到任何路由——不修改訂單狀態路由、公開報價確認 API、前端畫面。目前唯一呼叫方
// 是測試程式；未來要接線時，路由只需要呼叫這支函式並把回傳的 { ok, status, error } 轉成對應的
// HTTP 回應即可。
const { db } = require('./db');
const { checkLowStockTransition } = require('./low-stock-notify');

const ORDER_ID_PATTERN = /^[a-zA-Z0-9@._-]+$/; // 跟 server.js 既有訂單相關路由同一套訂單編號格式限制
const DEDUCT_REASON = '訂單確認自動扣庫存';
const DEDUCT_SOURCE_TYPE = 'order_confirmed';
const RESTOCK_REASON = '訂單取消自動回補庫存';
const RESTOCK_SOURCE_TYPE = 'order_cancelled';

// ─── 扣庫存／回補循環識別碼 ──────────────────────────────
// 問題：如果 source_id 永遠等於裸的 orderId，UNIQUE INDEX(source_type, source_id) 就只能讓
// 「同一張訂單」永久最多扣庫存一次——但一張訂單合法的一生可能是「成交扣庫存 → 取消回補 →
// 恢復訂單 → 再次成交要再扣一次庫存 → 再次取消要再回補一次」，同一張訂單需要能重複經歷好幾輪
// 完整循環，不是只有一次。
//
// 解法：source_id 一律用 `${orderId}#${cycle}` 這種帶「第幾輪循環」的複合識別碼；同一輪循環的
// 扣庫存事件（order_confirmed）跟回補事件（order_cancelled）共用同一個 cycle 編號（回補是在
// 「還原」剛好同一輪的扣庫存，不是開新的一輪），下一輪扣庫存則換成 cycle+1、變成全新的
// source_id，不會撞到前一輪已經寫入、永遠不能刪改的紀錄。判斷「目前是第幾輪、目前是已扣庫存
// 還是已回補」不需要另外維護一張狀態表——inventory_log 本身依 id 由新到舊排序後，第一筆
// order_confirmed／order_cancelled 事件就是最新狀態，這裡直接查詢，inventory_log 依然是唯一
// 事實來源，不會有兩份資料互相兜不起來的風險。
const CYCLE_SOURCE_TYPES = [DEDUCT_SOURCE_TYPE, RESTOCK_SOURCE_TYPE];

function buildCycleSourceId(orderId, cycle) {
  return `${orderId}#${cycle}`;
}

// 從 source_id 還原出「這是不是這個 orderId 的循環識別碼、第幾輪」；用字串完全比對（不是
// SQL LIKE），刻意不用 LIKE 是因為 orderId 允許包含底線 `_`，那是 LIKE 的萬用字元，
// 用 LIKE 做前綴比對容易誤配到底線位置剛好對得上的別張訂單，字串比對沒有這個問題。
//
// 舊格式相容：循環識別碼是後來才加上去的機制，在那之前 deductInventoryForOrder() 寫入的
// source_id 一律是裸的 orderId（沒有 `#cycle` 後綴），等同「第 1 輪」。只認新格式會讓舊紀錄
// 被當成「這張訂單從來沒扣過庫存」：取消時不會回補（庫存少了卻沒人知道），下次成交又會被
// 誤判成從沒扣過而重新扣一次（庫存被多扣一次）。不得修改或重寫這些舊紀錄本身，只能在讀取時
// 正確辨識，因此這裡明確分兩種合法格式：
//   1. sourceId 跟 orderId 完全相等 → 舊格式，視為第 1 輪。
//   2. sourceId 是 `${orderId}#` 加上一個嚴格的正整數（開頭不是 0、只有數字，不接受小數點、
//      科學記號、正負號、前後空白等任何近似寫法，避免 `Number()` 的寬鬆轉型誤判）→ 新格式，
//      回傳該輪次。
// 其他任何字串一律視為不屬於這張訂單，回傳 null，不會被誤判。
//
// 數值安全邊界：格式驗證（正則）只保證「字串長得像一串正整數」，不保證轉成 Number 之後還是
// 精確、可安全運算的整數——極長的純數字字串轉成 Number 可能超出 Number.MAX_SAFE_INTEGER
// （超過這個範圍的整數無法精確表示，+1／比較大小都可能出錯）、甚至直接變成 Infinity（字串長到
// 超過浮點數可表示範圍）。這種字串仍然會通過正則檢查，如果不額外驗證，會被誤認成一個「有效」
// 的循環編號。因此格式驗證通過後，一定要再用 Number.isSafeInteger() 連同 `> 0` 一起檢查，
// 任何不安全的數值（含 Infinity）一律視為不相關的雜訊，回傳 null，不會被誤判成這張訂單的
// 循環事件。
const POSITIVE_INTEGER_STRING = /^[1-9][0-9]*$/;
function parseCycleForOrder(sourceId, orderId) {
  if (typeof sourceId !== 'string') return null;
  if (sourceId === orderId) return 1; // 舊格式：沒有 `#cycle` 後綴的裸 orderId，等同第 1 輪
  const prefix = `${orderId}#`;
  if (!sourceId.startsWith(prefix)) return null;
  const suffix = sourceId.slice(prefix.length);
  if (!POSITIVE_INTEGER_STRING.test(suffix)) return null;
  const cycle = Number(suffix);
  return (Number.isSafeInteger(cycle) && cycle > 0) ? cycle : null;
}

// 查詢這張訂單「目前」的扣庫存循環狀態：從 inventory_log 找最新一筆屬於這張訂單的
// order_confirmed／order_cancelled 事件（id 最大＝最新）。回傳 null 代表這張訂單從來沒有被
// 扣過庫存。這支函式只讀不寫，deduct／restock 兩支函式共用。
function getLatestCycleEvent(orderId) {
  const rows = db.prepare(`
    SELECT * FROM inventory_log WHERE source_type IN (?, ?) ORDER BY id DESC
  `).all(...CYCLE_SOURCE_TYPES);
  for (const row of rows) {
    const cycle = parseCycleForOrder(row.source_id, orderId);
    if (cycle !== null) {
      return { cycle, sourceType: row.source_type, logRow: row };
    }
  }
  return null;
}

// 純函式：只負責格式檢查，不碰資料庫，方便單獨測試各種不合法輸入（缺商品代碼／數量錯誤等）。
function validateDeductInput({ orderId, productId, qty }) {
  if (typeof orderId !== 'string' || !ORDER_ID_PATTERN.test(orderId)) {
    return { ok: false, status: 400, error: '訂單編號格式不正確' };
  }
  // 舊訂單可能缺少商品代碼（product.id）——這裡明確拒絕，不可用商品名稱等其他欄位
  // 猜測對應到哪個商品，避免扣錯商品的庫存。
  if (typeof productId !== 'string' || !productId.trim()) {
    return { ok: false, status: 400, error: '此訂單缺少商品代碼，無法自動扣庫存，請人工確認並手動調整庫存' };
  }
  if (typeof qty !== 'number' || !Number.isInteger(qty) || qty <= 0) {
    return { ok: false, status: 400, error: '扣庫存數量必須是大於 0 的整數' };
  }
  return { ok: true };
}

// 用來把「transaction 內判斷出的驗證失敗」（商品不存在／無庫存資料列／庫存不足）安全地
// 帶出 db.transaction() 之外，同時仍然讓 better-sqlite3 對這個 transaction 做完整回滾——
// 不能只是 return，一定要用 throw，否則已經執行的 UPDATE 不會被撤銷。跟真正的資料庫寫入
// 失敗、UNIQUE 衝突用同一個 catch 分流，靠 instanceof 分辨。
class DeductAbort extends Error {
  constructor(result) {
    super('DEDUCT_ABORT');
    this.result = result;
  }
}

// 共用底層：驗證 → 冪等快速檢查 → 在同一個 SQLite transaction 內用「原子條件更新」扣庫存
// 並寫入 inventory_log。刻意不在 transaction 外讀取 stock_qty、算出絕對的新庫存數字再寫回去
// ——那種寫法在兩張訂單同時扣同一個商品時會互相覆蓋對方的結果（lost update）：兩邊都讀到
// 同一個舊數字、各自算出「應該要變成多少」，後寫入的那個會直接蓋掉先寫入的扣除量。改成
// `stock_qty = stock_qty - ?` 讓資料庫在真正寫入的當下才用「當時最新的值」計算，配合
// SQLite 對同一個資料庫檔案的寫入序列化，兩次扣庫存無論交錯順序為何都不會遺失更新。
//
// orderLabel 是呼叫端傳入、給人看的可辨識訂單編號（例如 friendlyOrderNo），沒有的話退回 orderId
// 本身；純粹寫進 note 欄位方便後台對照，不影響任何驗證或比對邏輯。
function deductInventoryForOrder({ orderId, productId, qty, orderLabel }) {
  const validation = validateDeductInput({ orderId, productId, qty });
  if (!validation.ok) return validation;

  // 先查一次快速路徑：如果這張訂單目前最新一筆循環事件就是「已扣庫存」，代表這一輪已經扣過，
  // 直接回覆 alreadyDeducted，不需要進到 transaction。真正防止「兩次呼叫同時通過這個檢查」的
  // 保護，是下面 UNIQUE INDEX 擋下 INSERT 之後、catch 區塊裡的處理，不是這一段。
  // 如果最新事件是「已回補」（代表上一輪已經完整跑完取消回補），或完全沒有任何事件（從來沒扣過），
  // 這次都要當成全新的一輪，cycle 用「目前最新輪次＋1」，不能沿用舊的 cycle（那個 source_id
  // 已經是別輪用過的，只會撞到 UNIQUE INDEX，或更糟——如果檢查邏輯有漏洞，誤判成 alreadyDeducted）。
  const latest = getLatestCycleEvent(orderId);
  if (latest && latest.sourceType === DEDUCT_SOURCE_TYPE) {
    const invRow = db.prepare('SELECT stock_qty FROM inventory WHERE product_id = ?').get(latest.logRow.product_id);
    return { ok: true, alreadyDeducted: true, stockQty: invRow ? invRow.stock_qty : null, logId: latest.logRow.id };
  }
  const cycle = (latest ? latest.cycle : 0) + 1;
  // latest.cycle 本身一定已經是 Number.isSafeInteger() 驗證過的安全整數（parseCycleForOrder()
  // 的保證），但 +1 之後仍然可能剛好跨過 Number.MAX_SAFE_INTEGER 這條界線——這種情況極不可能在
  // 真實世界發生（代表同一張訂單已經合法循環了超過九千兆輪），但既然理論上可能發生，就必須明確
  // 擋下，不能讓一個不再安全、無法精確運算的數字被拿去組成 source_id 寫進資料庫：一旦寫進去，
  // 之後任何一次讀取都會被 parseCycleForOrder() 判定為不安全而回傳 null，等於讓這筆紀錄「消失」
  // 在循環追蹤之外，形同資料損毀。因此直接擋下，完全不扣庫存、不寫入任何紀錄。
  if (!Number.isSafeInteger(cycle)) {
    return { ok: false, status: 500, error: '這張訂單的扣庫存循環次數已達系統可安全處理的上限，請人工確認並手動調整庫存' };
  }
  const sourceId = buildCycleSourceId(orderId, cycle);

  const now = new Date().toISOString();
  const note = orderLabel ? String(orderLabel) : orderId;

  try {
    let finalResult;
    const run = db.transaction(() => {
      // 原子條件更新：WHERE 子句的 stock_qty >= ? 由資料庫在寫入當下用最新的值判斷，
      // 不是用 transaction 外某個時間點讀到、可能已經過期的數字。changes 才是唯一可信的
      // 「這次到底有沒有扣成功」依據。
      const updateInfo = db.prepare(`
        UPDATE inventory SET stock_qty = stock_qty - ?, updated_at = ?
        WHERE product_id = ? AND stock_qty >= ?
      `).run(qty, now, productId, qty);

      if (updateInfo.changes === 0) {
        // 沒有任何一列被更新：重新查詢商品與庫存資料列，才能區分是「商品不存在」「這個商品
        // 還沒有庫存資料列」還是「庫存不足」，不可以憑空猜測是哪一種。
        const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
        if (!product) {
          throw new DeductAbort({ ok: false, status: 404, error: `找不到商品代碼 ${productId}，無法自動扣庫存` });
        }
        const inv = db.prepare('SELECT * FROM inventory WHERE product_id = ?').get(productId);
        if (!inv) {
          throw new DeductAbort({ ok: false, status: 404, error: `商品 ${productId} 尚未建立庫存資料，無法自動扣庫存` });
        }
        throw new DeductAbort({ ok: false, status: 409, error: `庫存不足，目前庫存 ${inv.stock_qty}，扣除 ${qty} 後會變成負數` });
      }

      // 扣庫存成功後才寫入紀錄；INSERT 若失敗（含下面的 UNIQUE 衝突），better-sqlite3 會讓
      // 整個 transaction 自動回滾，剛剛的 UPDATE 也會一併復原，不會產生只扣庫存沒寫紀錄的
      // 部分寫入。
      const insertInfo = db.prepare(`
        INSERT INTO inventory_log (product_id, change_qty, reason, note, source_type, source_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(productId, -qty, DEDUCT_REASON, note, DEDUCT_SOURCE_TYPE, sourceId, now);

      // 回傳值一律用 transaction 內、UPDATE 之後實際查到的庫存數字，不是外部算出來的數字
      // ——確保回傳的永遠是資料庫真正落地的結果。
      const stockRow = db.prepare('SELECT stock_qty, low_stock_threshold FROM inventory WHERE product_id = ?').get(productId);
      // 低庫存主動通知：同一個 transaction 內執行，讀到的是這次扣庫存後剛寫入的最新數字；
      // 通知寫入失敗由 checkLowStockTransition() 內部自行吞掉，不影響這筆訂單扣庫存的結果。
      checkLowStockTransition(productId, stockRow.stock_qty, stockRow.low_stock_threshold);
      finalResult = { ok: true, alreadyDeducted: false, stockQty: stockRow.stock_qty, logId: insertInfo.lastInsertRowid };
    });
    run();
    return finalResult;
  } catch (err) {
    if (err instanceof DeductAbort) return err.result;

    // UNIQUE INDEX 擋下的情況：代表這段時間內已經有另一次呼叫搶先扣過這張訂單同一輪循環的
    // 庫存，整個 transaction（含這次的 UPDATE）已經自動回滾，回報 alreadyDeducted 而不是錯誤。
    const isDuplicate = err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err.message || ''));
    if (isDuplicate) {
      const raceExisting = db.prepare(`
        SELECT * FROM inventory_log WHERE source_type = ? AND source_id = ?
      `).get(DEDUCT_SOURCE_TYPE, sourceId);
      const invRow = db.prepare('SELECT stock_qty FROM inventory WHERE product_id = ?').get(productId);
      return { ok: true, alreadyDeducted: true, stockQty: invRow ? invRow.stock_qty : null, logId: raceExisting ? raceExisting.id : null };
    }
    console.error('[deductInventoryForOrder]', err.message);
    return { ok: false, status: 500, error: '庫存扣除失敗，請稍後再試' };
  }
}

// 共用底層：取消訂單時把「這張訂單目前最新一輪循環裡已經扣過的庫存」加回去。刻意只接受
// orderId（跟 orderLabel，純粹寫進 note 方便對照），不接受呼叫端傳入 productId／qty——商品與
// 數量一律從 getLatestCycleEvent() 查到的、當初實際寫入的扣庫存紀錄（inventory_log 的
// product_id／change_qty）取得，不使用訂單 JSON 或前端當下的商品名稱／數量，避免用可能已經
// 被之後編輯過、或跟當初扣庫存當下不一致的資料回補錯商品或錯數量。
//
// 回傳 restocked:false 有兩種完全正常、不算錯誤的情況，用旗標分開表示：
//   neverDeducted  —— 這張訂單目前這一輪從來沒有被扣過庫存（例如成交前就取消），本來就不該
//                      增加庫存，安全地什麼都不做。
//   alreadyRestocked —— 這一輪已經回補過了（含並行呼叫被 UNIQUE INDEX 擋下的情況），
//                      不會重複加庫存。
function restockInventoryForOrderCancellation({ orderId, orderLabel }) {
  if (typeof orderId !== 'string' || !ORDER_ID_PATTERN.test(orderId)) {
    return { ok: false, status: 400, error: '訂單編號格式不正確' };
  }

  // 快速路徑：查目前這張訂單最新一輪循環事件。不是「已扣庫存」就沒有東西可以回補
  // （從來沒扣過，或上一輪已經回補完成），直接安全地回傳，不進 transaction。真正防止
  // 「同一輪回補被同時呼叫兩次」的保護，是下面 UNIQUE INDEX 擋下 INSERT 之後的 catch 處理。
  const latest = getLatestCycleEvent(orderId);
  if (!latest || latest.sourceType !== DEDUCT_SOURCE_TYPE) {
    return { ok: true, restocked: false, neverDeducted: !latest, alreadyRestocked: !!latest };
  }

  const deductLog = latest.logRow; // 回補商品／數量的唯一依據：當初實際扣庫存時寫入的那一筆紀錄
  const productId = deductLog.product_id;
  const qty = -deductLog.change_qty; // change_qty 當初存的是負數，取絕對值就是要加回去的數量
  const sourceId = buildCycleSourceId(orderId, latest.cycle); // 回補沿用同一輪的 cycle，不是開新的一輪

  const now = new Date().toISOString();
  const note = orderLabel ? String(orderLabel) : orderId;

  try {
    let finalResult;
    const run = db.transaction(() => {
      const updateInfo = db.prepare(`
        UPDATE inventory SET stock_qty = stock_qty + ?, updated_at = ?
        WHERE product_id = ?
      `).run(qty, now, productId);

      if (updateInfo.changes === 0) {
        // 理論上不會發生：當初能扣庫存成功，代表 inventory 資料列一定存在過；這裡仍然防呆，
        // 不假設它一定還在，並且用跟 deductInventoryForOrder 一致的 DeductAbort 機制讓
        // transaction 完整回滾（雖然這個分支目前還沒有任何寫入需要回滾，但保持同一套模式，
        // 避免以後在這個 transaction 裡加東西時忘記處理）。
        throw new DeductAbort({ ok: false, status: 404, error: `商品 ${productId} 的庫存資料列已不存在，無法回補` });
      }

      // 回補成功後才寫入紀錄；INSERT 若失敗（含下面的 UNIQUE 衝突），整個 transaction 會自動
      // 回滾，剛剛的 UPDATE 也會一併復原，不會有只加庫存沒寫紀錄的部分寫入。原本的扣庫存紀錄
      // （deductLog）從頭到尾只有被讀取，這個函式完全不會 UPDATE 或 DELETE inventory_log 裡
      // 任何既有的資料列。
      const insertInfo = db.prepare(`
        INSERT INTO inventory_log (product_id, change_qty, reason, note, source_type, source_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(productId, qty, RESTOCK_REASON, note, RESTOCK_SOURCE_TYPE, sourceId, now);

      const stockRow = db.prepare('SELECT stock_qty, low_stock_threshold FROM inventory WHERE product_id = ?').get(productId);
      // 低庫存主動通知：回補後庫存可能已經恢復到警戒值以上，這裡會正確解除目前的低庫存狀態
      // （若回補後仍然 <= 警戒值，則維持既有的 active 通知，不重複建立）。
      checkLowStockTransition(productId, stockRow.stock_qty, stockRow.low_stock_threshold);
      finalResult = { ok: true, restocked: true, stockQty: stockRow.stock_qty, logId: insertInfo.lastInsertRowid, productId, qty };
    });
    run();
    return finalResult;
  } catch (err) {
    if (err instanceof DeductAbort) return err.result;

    // UNIQUE INDEX 擋下的情況：代表這段時間內已經有另一次呼叫搶先回補過這一輪，
    // 整個 transaction（含這次的 UPDATE）已經自動回滾，回報「已回補」而不是錯誤。
    const isDuplicate = err && (err.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE constraint failed/.test(err.message || ''));
    if (isDuplicate) {
      const invRow = db.prepare('SELECT stock_qty FROM inventory WHERE product_id = ?').get(productId);
      const raceRow = db.prepare(`
        SELECT * FROM inventory_log WHERE source_type = ? AND source_id = ?
      `).get(RESTOCK_SOURCE_TYPE, sourceId);
      return { ok: true, restocked: false, alreadyRestocked: true, stockQty: invRow ? invRow.stock_qty : null, logId: raceRow ? raceRow.id : null };
    }
    console.error('[restockInventoryForOrderCancellation]', err.message);
    return { ok: false, status: 500, error: '庫存回補失敗，請稍後再試' };
  }
}

module.exports = {
  deductInventoryForOrder,
  restockInventoryForOrderCancellation,
  validateDeductInput,
  DEDUCT_REASON,
  DEDUCT_SOURCE_TYPE,
  RESTOCK_REASON,
  RESTOCK_SOURCE_TYPE
};
