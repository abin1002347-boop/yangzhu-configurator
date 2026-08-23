// 應收總額統一解析函式：前後端（admin.html 與 server.js）共用同一份規則，
// 不可各自直接讀 order.quote.total，避免正式報價版本／人工調價發布後應收金額算錯。
// 只負責「解析出目前應該拿去當應收總額的數字」，不會、也不可以修改 order.quote 或
// 任何已發布的報價版本快照（quoteVersions 只增加、不覆蓋，維持事實證據不可變）。
//
// 優先順序：
//   1. 最新已發布正式報價版本（order.quoteVersions 裡 versionNumber 最大者）的
//      pricingSnapshot.finalTotal
//   2. 沒有正式版本時，最新一筆 order.pricingAdjustments 的 finalTotal
//   3. 都沒有時，原始 order.quote.total
//   4. 都沒有合法金額時，回傳 null

function isLegalReceivableAmount(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function resolveLatestQuoteVersion(order) {
  const versions = Array.isArray(order && order.quoteVersions) ? order.quoteVersions : [];
  let latest = null;
  for (let i = 0; i < versions.length; i++) {
    const v = versions[i];
    if (v && typeof v.versionNumber === 'number' && Number.isFinite(v.versionNumber)) {
      if (!latest || v.versionNumber > latest.versionNumber) latest = v;
    }
  }
  return latest;
}

function resolveReceivableTotal(order) {
  const latestVersion = resolveLatestQuoteVersion(order);
  if (latestVersion) {
    const amt = latestVersion.pricingSnapshot && latestVersion.pricingSnapshot.finalTotal;
    if (isLegalReceivableAmount(amt)) return amt;
  }

  const adjustments = Array.isArray(order && order.pricingAdjustments) ? order.pricingAdjustments : [];
  if (adjustments.length > 0) {
    const latestAdjustment = adjustments[adjustments.length - 1];
    const amt = latestAdjustment && latestAdjustment.finalTotal;
    if (isLegalReceivableAmount(amt)) return amt;
  }

  const original = order && order.quote && order.quote.total;
  if (isLegalReceivableAmount(original)) return original;

  return null;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { resolveReceivableTotal, resolveLatestQuoteVersion, isLegalReceivableAmount };
}
