// 客戶報價確認的安全公開存取：Token 產生／雜湊／驗證、公開唯讀資料白名單建構等純函式。
// 「掃描 ORDER_DIR 找出 token 對應哪一筆訂單」這種純粹的檔案 I/O 留在 server.js（跟其他
// 訂單讀寫邏輯同一個地方），這裡只負責跟檔案系統無關的規則判斷與資料整形，方便獨立單元測試。
// 「是否為最新版本」「報價版本是否過期」直接重用 quote-customer-response.js 既有匯出的
// isLatestQuoteVersion／checkQuoteVersionNotExpired，確保這兩條規則在報價相關功能裡
// 永遠是同一套定義，不重複實作、不會兜不起來。
const crypto = require('crypto');
const { isLatestQuoteVersion, checkQuoteVersionNotExpired } = require('./quote-customer-response.js');

const TOKEN_BYTES = 32; // 至少 32 bytes 高強度隨機值
const TOKEN_HEX_REGEX = /^[0-9a-f]{64}$/i; // 32 bytes 以 hex 編碼固定是 64 個字元，URL 安全、不需要額外編碼

// 產生一組原始 Token（十六進位字串）。這是本模組唯一會呼叫 crypto.randomBytes() 的地方，
// 刻意獨立成一個極小的函式，其餘函式全部維持真正的純函式（同樣輸入永遠得到同樣輸出），
// 方便測試用固定字串做雜湊／格式驗證的斷言，不需要每次都真的產生亂數。
function generateRawToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// SHA-256 雜湊：訂單資料只保存這個值，原始 Token 永遠不會被寫進任何檔案。
function hashToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isValidTokenFormat(token) {
  return typeof token === 'string' && TOKEN_HEX_REGEX.test(token);
}

// 常數時間比較兩個雜湊字串，避免透過回應時間差異猜測正確雜湊值。
// 長度不同時 crypto.timingSafeEqual() 會直接丟例外，這裡先擋掉、統一回傳 false，
// 呼叫端完全不需要處理例外情況。
function safeCompareHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// 建立要存進 quoteVersion.customerAccess 的紀錄；tokenHash／now／expiresAt 全部由
// 呼叫端明確傳入（呼叫端必須確保 expiresAt 不超過該報價版本的 validUntil，見 server.js
// 路由），這個函式本身不呼叫 new Date()，維持純函式。
function buildCustomerAccessRecord({ tokenHash, now, expiresAt }) {
  return {
    tokenHash,
    createdAt: now.toISOString(),
    expiresAt
  };
}

// Token 本身（相對於 customerAccess 紀錄）是否仍在有效期限內——跟報價版本的
// checkQuoteVersionNotExpired() 檢查的是不同欄位（customerAccess.expiresAt 而不是
// quoteVersion.validUntil），刻意分開成獨立函式，避免混淆兩種不同意義的到期時間。
function isCustomerAccessExpired(customerAccess, now) {
  const raw = customerAccess && customerAccess.expiresAt;
  if (!raw) return true;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return true;
  return d.getTime() < now.getTime();
}

// 綜合判斷「這組 token 對應到的訂單／報價版本，現在是否仍然可以公開存取」：
// 訂單未封存、token 雜湊仍然吻合且本身未過期、指向的版本仍是最新版本、報價本身未過期。
// 這是公開 GET／POST 共用的單一閘門，確保兩邊規則完全一致，不會各自兜出不同結果。
// reason 只給伺服器內部（路由）用來決定要回覆哪一種訊息，回傳給客戶端的文字仍由
// 呼叫端決定，這裡不直接組錯誤訊息字串。
function evaluatePublicAccess(order, quoteVersion, tokenHash, now) {
  if (!order || order.archivedAt) {
    return { ok: false, reason: 'archived' };
  }
  if (!quoteVersion) {
    return { ok: false, reason: 'not_found' };
  }
  const access = quoteVersion.customerAccess;
  if (!access || !safeCompareHash(access.tokenHash, tokenHash)) {
    return { ok: false, reason: 'not_found' };
  }
  if (isCustomerAccessExpired(access, now)) {
    return { ok: false, reason: 'token_expired' };
  }
  if (!isLatestQuoteVersion(order.quoteVersions, quoteVersion.id)) {
    return { ok: false, reason: 'not_latest' };
  }
  const expiryResult = checkQuoteVersionNotExpired(quoteVersion, now);
  if (!expiryResult.ok) {
    return { ok: false, reason: 'quote_expired' };
  }
  return { ok: true };
}

// 純畫面／回應用的狀態判斷，跟 admin.html 的 quoteVersionDisplayStatus() 概念一致：
// 只比較 validUntil 跟目前時間，不做任何背景改寫，每次呼叫重新算一次。
function resolvePublicQuoteStatus(quoteVersion, now) {
  const expiryResult = checkQuoteVersionNotExpired(quoteVersion, now);
  return expiryResult.ok ? 'valid' : 'expired';
}

// 公開回應的白名單建構：只挑選客戶真正需要看到的欄位。明確排除 quoteVersion.idempotencyKey、
// quoteVersion.actor、customerAccess（含 tokenHash）、originalQuoteSnapshot 等任何未被要求
// 公開的內部資料；customerResponse 只挑 decision／note／respondedAt，不含 actor／
// idempotencyKey。用 JSON 深層複製，回傳的物件不會跟 quoteVersion 共用任何可變參照。
function buildPublicQuoteConfirmationView(quoteVersion, status) {
  const product = quoteVersion.productSnapshot || {};
  const customer = quoteVersion.customerSnapshot || {};
  const pricing = quoteVersion.pricingSnapshot || {};
  const response = quoteVersion.customerResponse;

  return JSON.parse(JSON.stringify({
    versionId: quoteVersion.id,
    versionLabel: quoteVersion.versionLabel,
    validUntil: quoteVersion.validUntil,
    status,
    notes: quoteVersion.notes || '',
    product: {
      name: product.name ?? null,
      material: product.material ?? null,
      finish: product.finish ?? null,
      capacity: product.capacity ?? null,
      qty: product.qty ?? null,
      priceOnInquiry: !!product.priceOnInquiry
    },
    customer: {
      name: customer.name ?? null,
      email: customer.email ?? null,
      phone: customer.phone ?? null
    },
    pricing: {
      baseAmount: pricing.baseAmount ?? null,
      baseSource: pricing.baseSource ?? null,
      discountAmount: pricing.discountAmount ?? null,
      extraFee: pricing.extraFee ?? null,
      shippingFee: pricing.shippingFee ?? null,
      taxRate: pricing.taxRate ?? null,
      taxAmount: pricing.taxAmount ?? null,
      preTaxAmount: pricing.preTaxAmount ?? null,
      finalTotal: pricing.finalTotal ?? null
    },
    customerResponse: response ? {
      decision: response.decision,
      note: response.note,
      respondedAt: response.respondedAt
    } : null
  }));
}

module.exports = {
  TOKEN_BYTES,
  TOKEN_HEX_REGEX,
  generateRawToken,
  hashToken,
  isValidTokenFormat,
  safeCompareHash,
  buildCustomerAccessRecord,
  isCustomerAccessExpired,
  evaluatePublicAccess,
  resolvePublicQuoteStatus,
  buildPublicQuoteConfirmationView
};
