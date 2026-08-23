// 人工調價（折扣／額外費用／運費／稅額）純函式：驗證輸入與計算金額，
// 完全不碰 req/res 或檔案系統，跟路由（server.js）分離以便獨立單元測試。

const IDEMPOTENCY_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON_MAX_LEN = 500;

function isNonNegativeInteger(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) && v >= 0;
}

function isPositiveInteger(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isSafeInteger(v) && v > 0;
}

// 稅率必須是 0～100 之間、最多兩位小數的數字；乘以 100 四捨五入後應完全等於原值
// （容忍極小的浮點誤差），藉此擋下 5.555 這種超過兩位小數的輸入。
function isValidTaxRate(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < 0 || v > 100) return false;
  return Math.abs(Math.round(v * 100) - v * 100) < 1e-9;
}

// 驗證 discountAmount／extraFee／shippingFee／taxRate／reason／idempotencyKey 這幾個
// 只看 request body 就能判斷格式對錯的欄位。manualBaseAmount 不在這裡驗證，因為它是否
// 必填要看訂單是不是 priceOnInquiry 商品，屬於 resolveBaseAmount() 的責任。
function validateAdjustmentFields(body) {
  const b = body || {};

  const discountAmount = b.discountAmount === undefined ? 0 : b.discountAmount;
  if (!isNonNegativeInteger(discountAmount)) {
    return { ok: false, error: 'discountAmount 必須是非負整數' };
  }

  const extraFee = b.extraFee === undefined ? 0 : b.extraFee;
  if (!isNonNegativeInteger(extraFee)) {
    return { ok: false, error: 'extraFee 必須是非負整數' };
  }

  const shippingFee = b.shippingFee === undefined ? 0 : b.shippingFee;
  if (!isNonNegativeInteger(shippingFee)) {
    return { ok: false, error: 'shippingFee 必須是非負整數' };
  }

  const taxRate = b.taxRate === undefined ? 0 : b.taxRate;
  if (!isValidTaxRate(taxRate)) {
    return { ok: false, error: 'taxRate 必須是 0～100 之間、最多兩位小數的數字' };
  }

  if (typeof b.reason !== 'string') {
    return { ok: false, error: 'reason 為必填欄位' };
  }
  const reason = b.reason.trim();
  if (reason.length < 1) {
    return { ok: false, error: 'reason 不可空白' };
  }
  if (reason.length > REASON_MAX_LEN) {
    return { ok: false, error: `reason 長度不可超過 ${REASON_MAX_LEN} 字` };
  }

  if (typeof b.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(b.idempotencyKey)) {
    return { ok: false, error: 'idempotencyKey 必須是合法的 UUID' };
  }

  return {
    ok: true,
    discountAmount,
    extraFee,
    shippingFee,
    taxRate,
    reason,
    idempotencyKey: b.idempotencyKey
  };
}

// 決定這筆調價要用哪個金額當基準：一般自動報價商品一律使用訂單原始 quote.total
// （前端傳什麼都不採信、也不允許覆蓋）；priceOnInquiry 商品因為原始訂單沒有
// quote.total，改成要求後台人員輸入 manualBaseAmount。
function resolveBaseAmount(order, rawManualBaseAmount) {
  const isPriceOnInquiry = order?.quote?.priceOnInquiry === true;

  if (isPriceOnInquiry) {
    if (!isPositiveInteger(rawManualBaseAmount)) {
      return { ok: false, error: '此訂單為 priceOnInquiry 詢價商品，manualBaseAmount 必須是正整數' };
    }
    return { ok: true, baseAmount: rawManualBaseAmount, baseSource: 'manual_inquiry' };
  }

  const total = order?.quote?.total;
  if (!isPositiveInteger(total)) {
    return { ok: false, error: '此訂單缺少有效的原始報價總額，無法進行人工調價' };
  }
  return { ok: true, baseAmount: total, baseSource: 'auto_quote' };
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);
const OVERFLOW_ERROR = { ok: false, error: '調整後金額超出系統可安全處理的範圍' };

// 核心計算：折扣／加價／運費／稅額，全程整數金額，四捨五入只發生在稅額這一步。
// discountAmount／extraFee／shippingFee／baseAmount 個別都通過 Number.isSafeInteger()
// 檢查，但相加、計稅之後的中間結果與最終結果仍可能超出 Number.MAX_SAFE_INTEGER；
// 因此全程改用 BigInt 運算（加減完全沒有精度問題），每一步算完立刻用 BigInt 比較
// 是否超出安全整數上限，絕不會「先產生一個已經失去精度的 Number，事後才檢查」。
// 回傳 { ok:false, error } 代表任何一個中間或最終金額超出安全整數範圍；正常情況
// 回傳 { ok:true, preTaxAmount, taxAmount, finalTotal }。
function computeAdjustmentAmounts({ baseAmount, discountAmount, extraFee, shippingFee, taxRate }) {
  const baseBig = BigInt(baseAmount);
  const discountBig = BigInt(discountAmount);
  const extraBig = BigInt(extraFee);
  const shippingBig = BigInt(shippingFee);

  let preTaxBig = baseBig - discountBig + extraBig + shippingBig;
  if (preTaxBig < 0n) preTaxBig = 0n; // 折扣超過其他金額時保底為 0，跟原本規則一致
  if (preTaxBig > MAX_SAFE_BIGINT) return OVERFLOW_ERROR;

  // 稅率換算成整數基點（taxRate×100）：taxRate 已經過 validateAdjustmentFields 驗證最多
  // 兩位小數，這裡的 Math.round 只是消除浮點表示誤差（例如 5.55 實際存成
  // 5.549999999999999），不會改變使用者輸入的稅率意圖，換算後全部改用 BigInt 計算稅額，
  // 避免大數字乘除時的浮點精度流失。
  const taxBasisPoints = BigInt(Math.round(taxRate * 100));
  const numerator = preTaxBig * taxBasisPoints;
  const denominator = 10000n;
  let taxBig = numerator / denominator;
  const remainder = numerator % denominator;
  // 四捨五入：分子分母皆非負，逢半進位，結果跟原本 Math.round() 的行為完全一致。
  if (remainder * 2n >= denominator) taxBig += 1n;
  if (taxBig > MAX_SAFE_BIGINT) return OVERFLOW_ERROR;

  const finalBig = preTaxBig + taxBig;
  if (finalBig > MAX_SAFE_BIGINT) return OVERFLOW_ERROR;

  const preTaxAmount = Number(preTaxBig);
  const taxAmount = Number(taxBig);
  const finalTotal = Number(finalBig);

  // 轉回 Number 後再次確認每個結果都是安全整數：上面的 BigInt 上限比較理論上已經保證
  // 這裡一定成立，這一步是最後一道防線，避免之後計算邏輯改動時默默引入精度誤差卻沒被擋下。
  if (!Number.isSafeInteger(preTaxAmount) || !Number.isSafeInteger(taxAmount) || !Number.isSafeInteger(finalTotal)) {
    return OVERFLOW_ERROR;
  }

  return { ok: true, preTaxAmount, taxAmount, finalTotal };
}

// 冪等重送比對：只比對「使用者送出的調整意圖」相關欄位，不比對 id／actor／createdAt／
// idempotencyKey 本身——這幾個要嘛是伺服器產生、要嘛就是比對用的 key，不該影響「是不是
// 同一筆調整」的判斷。這跟既有付款交易的冪等比對邏輯（paymentTransactionContentMatches）
// 是同一套設計原則。
function adjustmentContentMatches(a, b) {
  return a.baseAmount === b.baseAmount &&
    a.baseSource === b.baseSource &&
    a.discountAmount === b.discountAmount &&
    a.extraFee === b.extraFee &&
    a.shippingFee === b.shippingFee &&
    a.taxRate === b.taxRate &&
    a.reason === b.reason;
}

// 訂單目前應該顯示的報價：有人工調整紀錄就用最後一筆調整結果，完全沒有調整過就直接
// 用原始自動報價（priceOnInquiry 訂單原始報價沒有金額，finalTotal 回傳 null，交由呼叫端
// 顯示「價格由業務確認」）。純函式，不寫入任何東西，GET 或 POST 都可以拿來算目前狀態。
function computeCurrentPricing(order) {
  const adjustments = Array.isArray(order?.pricingAdjustments) ? order.pricingAdjustments : [];
  if (adjustments.length > 0) {
    return { source: 'adjustment', ...adjustments[adjustments.length - 1] };
  }
  const total = order?.quote?.priceOnInquiry === true ? null : (order?.quote?.total ?? null);
  return { source: 'original_quote', baseAmount: total, finalTotal: total };
}

module.exports = {
  IDEMPOTENCY_KEY_REGEX,
  REASON_MAX_LEN,
  isNonNegativeInteger,
  isPositiveInteger,
  isValidTaxRate,
  validateAdjustmentFields,
  resolveBaseAmount,
  computeAdjustmentAmounts,
  adjustmentContentMatches,
  computeCurrentPricing
};
