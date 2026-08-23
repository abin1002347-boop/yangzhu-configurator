// 報價版本及有效期限：驗證、目前可發布報價解析、版本快照建立等純函式，
// 完全不碰 req/res 或檔案系統，跟路由（server.js）分離以便獨立單元測試。
// 金額型別驗證直接沿用 pricing-adjustment.js 既有的安全整數／稅率規則，
// 確保「安全整數」「稅率格式」在整個報價相關功能裡永遠是同一套定義，不重複實作、不會兜不起來。
const { IDEMPOTENCY_KEY_REGEX, isPositiveInteger, isNonNegativeInteger, isValidTaxRate } = require('./pricing-adjustment.js');

const NOTES_MAX_LEN = 1000;

// 驗證 validDays／notes——idempotencyKey 的格式驗證與「是否已發布過」的冪等查找必須排在
// 這之前完成（見 server.js 路由的處理順序），故意不放在這個函式裡，避免呼叫順序被誤用。
function validatePublishFields(body) {
  const b = body || {};

  const validDays = b.validDays;
  if (typeof validDays !== 'number' || !Number.isFinite(validDays) || !Number.isInteger(validDays) || validDays < 1 || validDays > 365) {
    return { ok: false, error: 'validDays 必須是 1～365 之間的正整數' };
  }

  let notes = '';
  if (b.notes !== undefined && b.notes !== null) {
    if (typeof b.notes !== 'string') {
      return { ok: false, error: 'notes 必須是字串' };
    }
    notes = b.notes.trim();
    if (notes.length > NOTES_MAX_LEN) {
      return { ok: false, error: `notes 長度不可超過 ${NOTES_MAX_LEN} 字` };
    }
  }

  return { ok: true, validDays, notes };
}

// 判斷「這次要發布的內容」是不是跟既有那筆同 idempotencyKey 的版本完全相同的意圖——
// 只比對 validDays／notes（notes 用 trim 後的正式內容比對），不比對版本號／金額快照等
// 由伺服器決定的欄位，這幾個欄位本來就不該、也不會被拿來判斷「是不是同一次發布意圖」。
//
// 型別比對必須嚴格，不可用 Number()／String() 等強制轉型：
// 用 Number(incoming.validDays) 會把非法字串 "30" 轉成合法數字 30，導致同一個
// idempotencyKey 第二次改送格式不合法的內容時，仍被誤判成「跟第一次相同」而回放成功；
// notes 若把非字串直接轉成空字串，也會讓「原本 notes 為空、這次送非法型別」被誤判成相同。
// 所以這裡對 validDays／notes 都採「型別不符就直接判定不同」，交由路由回傳 409，
// 而不是靜默轉型後才比對。
function quoteVersionIntentMatches(version, incomingBody) {
  const incoming = incomingBody || {};

  const incomingValidDays = incoming.validDays;
  const validDaysMatches =
    typeof incomingValidDays === 'number' &&
    Number.isFinite(incomingValidDays) &&
    Number.isInteger(incomingValidDays) &&
    incomingValidDays >= 1 &&
    incomingValidDays <= 365 &&
    incomingValidDays === version.validDays;
  if (!validDaysMatches) return false;

  const incomingNotesRaw = incoming.notes;
  let incomingNotes;
  if (incomingNotesRaw === undefined || incomingNotesRaw === null) {
    incomingNotes = '';
  } else if (typeof incomingNotesRaw === 'string') {
    incomingNotes = incomingNotesRaw.trim();
  } else {
    return false;
  }

  return (version.notes || '') === incomingNotes;
}

// 下一個版本號：一律取「目前所有合法版本號中的最大值」＋1，不是 quoteVersions.length＋1——
// 避免舊資料缺號、重複號或格式異常（例如手動編輯過的檔案）造成版本號碰撞或重複使用。
function nextVersionNumber(quoteVersions) {
  const list = Array.isArray(quoteVersions) ? quoteVersions : [];
  let max = 0;
  for (const v of list) {
    if (typeof v?.versionNumber === 'number' && Number.isInteger(v.versionNumber) && v.versionNumber > max) {
      max = v.versionNumber;
    }
  }
  return max + 1;
}

// 目前應該拿去發布成正式報價版本的金額組合：有人工調整紀錄就完整複製陣列最後一筆調整結果
// （不重新計算，直接信任那筆調整當初寫入時已經驗證過的金額）；完全沒有調整過的一般自動報價
// 商品，用原始 order.quote.total 當作 baseAmount／preTaxAmount／finalTotal，折扣/加價/運費/
// 稅額全部為 0；priceOnInquiry 商品在還沒有任何人工調整之前完全無法發布（沒有真實金額可用）。
// 發布前一律重新驗證每個金額欄位仍是合法的非負安全整數，防止訂單檔案被手動編輯出不合法數字
// 時還被拿去發布成看似正式的報價版本。
function resolvePublishablePricing(order) {
  const isPriceOnInquiry = order?.quote?.priceOnInquiry === true;
  const adjustments = Array.isArray(order?.pricingAdjustments) ? order.pricingAdjustments : [];
  const latest = adjustments.length > 0 ? adjustments[adjustments.length - 1] : null;

  if (latest) {
    const fields = {
      baseAmount: latest.baseAmount,
      baseSource: latest.baseSource,
      discountAmount: latest.discountAmount,
      extraFee: latest.extraFee,
      shippingFee: latest.shippingFee,
      taxRate: latest.taxRate,
      taxAmount: latest.taxAmount,
      preTaxAmount: latest.preTaxAmount,
      finalTotal: latest.finalTotal
    };
    if (!isPositiveInteger(fields.baseAmount)) {
      return { ok: false, error: '目前報價資料的 baseAmount 不是合法的安全整數，無法發布報價版本' };
    }
    for (const key of ['discountAmount', 'extraFee', 'shippingFee', 'taxAmount', 'preTaxAmount', 'finalTotal']) {
      if (!isNonNegativeInteger(fields[key])) {
        return { ok: false, error: `目前報價資料的 ${key} 不是合法的非負安全整數，無法發布報價版本` };
      }
    }
    if (!isValidTaxRate(fields.taxRate)) {
      return { ok: false, error: '目前報價資料的 taxRate 不合法，無法發布報價版本' };
    }
    if (fields.baseSource !== 'auto_quote' && fields.baseSource !== 'manual_inquiry') {
      return { ok: false, error: '目前報價資料的 baseSource 不合法，無法發布報價版本' };
    }
    return { ok: true, ...fields, adjustmentId: latest.id || null };
  }

  if (isPriceOnInquiry) {
    return { ok: false, error: '此訂單為詢價商品，尚未有人工調整結果，無法發布正式報價版本' };
  }

  const total = order?.quote?.total;
  if (!isPositiveInteger(total)) {
    return { ok: false, error: '此訂單缺少有效的原始報價總額，無法發布報價版本' };
  }
  return {
    ok: true,
    baseAmount: total,
    baseSource: 'auto_quote',
    discountAmount: 0,
    extraFee: 0,
    shippingFee: 0,
    taxRate: 0,
    taxAmount: 0,
    preTaxAmount: total,
    finalTotal: total,
    adjustmentId: null
  };
}

// 建立完整的報價版本快照：id／versionNumber／validDays／notes／now（Date 物件）／pricing
// 全部由呼叫端（server.js）明確傳入，這個函式本身不呼叫 crypto.randomUUID() 或 new Date()，
// 維持真正的純函式（同樣的輸入永遠得到同樣的輸出），方便測試用固定的 id／時間做精確斷言。
// productSnapshot／customerSnapshot／pricingSnapshot／originalQuoteSnapshot 全部用
// JSON.parse(JSON.stringify(...)) 建立真正獨立的深層複製，不會跟 order.product／order.contact／
// order.quote 共用任何可變參照——之後訂單資料再怎麼變動，這個版本裡存的內容永遠不變。
function buildQuoteVersionSnapshot(order, options) {
  const { id, idempotencyKey, versionNumber, validDays, notes, now, pricing } = options;
  const validFrom = now.toISOString();
  const validUntil = new Date(now.getTime() + validDays * 24 * 60 * 60 * 1000).toISOString();

  return {
    id,
    idempotencyKey,
    versionNumber,
    versionLabel: 'V' + versionNumber,
    validFrom,
    validUntil,
    validDays,
    notes: notes || '',
    actor: 'admin', // 後台目前只有單一組共用密碼，還沒有多帳號機制，固定寫死，不接受前端傳入
    createdAt: validFrom,
    productSnapshot: JSON.parse(JSON.stringify({
      id: order?.product?.id ?? null,
      name: order?.product?.name ?? null,
      material: order?.product?.material ?? null,
      finish: order?.product?.finish ?? null,
      capacity: order?.product?.capacity ?? null,
      qty: order?.product?.qty ?? null,
      priceOnInquiry: !!(order?.product?.priceOnInquiry)
    })),
    customerSnapshot: JSON.parse(JSON.stringify({
      name: order?.contact?.name ?? null,
      email: order?.contact?.email ?? null,
      phone: order?.contact?.phone ?? null
    })),
    pricingSnapshot: JSON.parse(JSON.stringify({
      baseAmount: pricing.baseAmount,
      baseSource: pricing.baseSource,
      discountAmount: pricing.discountAmount,
      extraFee: pricing.extraFee,
      shippingFee: pricing.shippingFee,
      taxRate: pricing.taxRate,
      taxAmount: pricing.taxAmount,
      preTaxAmount: pricing.preTaxAmount,
      finalTotal: pricing.finalTotal,
      adjustmentId: pricing.adjustmentId
    })),
    originalQuoteSnapshot: JSON.parse(JSON.stringify(order?.quote ?? null))
  };
}

module.exports = {
  IDEMPOTENCY_KEY_REGEX,
  NOTES_MAX_LEN,
  validatePublishFields,
  quoteVersionIntentMatches,
  nextVersionNumber,
  resolvePublishablePricing,
  buildQuoteVersionSnapshot
};
