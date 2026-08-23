// 客戶報價確認（accepted／rejected）：驗證、冪等比對、快照建立等純函式，
// 完全不碰 req/res 或檔案系統，跟路由（server.js）分離以便獨立單元測試。
// idempotencyKey 格式直接重用 pricing-adjustment.js 既有匯出的 IDEMPOTENCY_KEY_REGEX，
// 確保「合法 UUID」在報價相關功能裡永遠是同一套定義，不重複實作、不會兜不起來。
const { IDEMPOTENCY_KEY_REGEX } = require('./pricing-adjustment.js');

const NOTE_MAX_LEN = 1000;

// 驗證 decision／note／idempotencyKey——只在「這個報價版本目前還沒有任何 customerResponse」
// 的情況下才會被呼叫；已經有回覆、要判斷是不是同一次重試意圖的比對邏輯在
// responseContentMatches()，兩者刻意分開，理由見該函式上方的說明。
function validateResponseFields(body) {
  const b = body || {};

  if (b.decision !== 'accepted' && b.decision !== 'rejected') {
    return { ok: false, error: 'decision 必須是 accepted 或 rejected' };
  }

  // 只有「缺少」note（undefined）才視為空字串；null／數字／物件／陣列都是不合法型別，
  // 一律回傳驗證失敗，不可被靜默正規化成空字串——這是本次要修正的問題本身，
  // 舊版誤把 `b.note !== null` 也放進「視為空字串」的條件，導致明確傳入 note:null 時
  // 完全沒有經過下面的 typeof 檢查就被當成合法的空字串。
  let note = '';
  if (b.note !== undefined) {
    if (typeof b.note !== 'string') {
      return { ok: false, error: 'note 必須是字串' };
    }
    note = b.note.trim();
    if (note.length > NOTE_MAX_LEN) {
      return { ok: false, error: `note 長度不可超過 ${NOTE_MAX_LEN} 字` };
    }
  }

  if (typeof b.idempotencyKey !== 'string' || !IDEMPOTENCY_KEY_REGEX.test(b.idempotencyKey)) {
    return { ok: false, error: 'idempotencyKey 必須是合法的 UUID' };
  }

  return { ok: true, decision: b.decision, note, idempotencyKey: b.idempotencyKey };
}

// 判斷「這次送來的內容」是不是跟既有那筆同 idempotencyKey 的 customerResponse 完全相同的
// 回覆意圖——直接比對原始 incomingBody，不先呼叫 validateResponseFields()，這是刻意的：
// 如果先驗證格式，「同 key 但這次不小心夾帶了不合法型別」會被誤判成 400（格式錯誤），
// 但正確的行為應該是 409（同一組識別碼的內容跟第一次不一樣，視為衝突），不可能是格式問題
// 才對——這一組 key 本來就已經成功寫入過一次合法內容了。跟 quote-version.js 的
// quoteVersionIntentMatches() 同一套原則，且同樣不使用 Number()／String() 等強制轉型：
// decision 型別或值不合法、note 型別不是字串，一律直接判定「不相符」，交由路由回傳 409。
function responseContentMatches(existing, incomingBody) {
  const incoming = incomingBody || {};

  if (incoming.decision !== 'accepted' && incoming.decision !== 'rejected') return false;
  if (existing.decision !== incoming.decision) return false;

  // 只有「缺少」note（undefined）才視為空字串；null 跟其他非字串型別一律直接判定
  // 不相符，不可用 `=== null` 併入「視為空字串」的分支，也不可用 `note || ''` 或
  // String() 等方式把 null／非法型別轉成空字串——這正是本次要修正的問題本身：舊版把
  // note:null 也正規化成 ''，導致「已用 note:'' 確認過」的版本，用同一組 key 重送
  // note:null 時被誤判成內容相同而安全回放，但這其實是不同的（非法）輸入，應該回傳 409。
  const incomingNoteRaw = incoming.note;
  let incomingNote;
  if (incomingNoteRaw === undefined) {
    incomingNote = '';
  } else if (typeof incomingNoteRaw === 'string') {
    incomingNote = incomingNoteRaw.trim();
  } else {
    return false;
  }

  // existing.note 一律是本模組自己透過 buildCustomerResponse() 寫入的既有資料，
  // 型別保證永遠是字串，因此直接比較即可，不需要（也不可以再用）`|| ''` 這種
  // 會掩蓋非法型別的防禦寫法。
  return existing.note === incomingNote;
}

// 「最新版本」的定義跟 admin.html 的 latestQuoteVersion() 完全一致：versionNumber 最大的
// 那一筆，不是陣列最後一筆（避免資料手動編輯過、追加順序跟版本號不一致時判斷錯誤）；
// 版本號格式異常（缺漏、非整數）一律不列入「最大值」候選，目標版本號格式異常時也直接
// 視為「不是最新」，不可回覆——沒有真正合法的版本號，就沒有辦法安全判斷它是不是最新。
function isLatestQuoteVersion(quoteVersions, versionId) {
  const list = Array.isArray(quoteVersions) ? quoteVersions : [];
  const target = list.find(v => v && v.id === versionId);
  if (!target) return false;

  const isValidVersionNumber = n => typeof n === 'number' && Number.isInteger(n);
  if (!isValidVersionNumber(target.versionNumber)) return false;

  let maxNumber = -Infinity;
  for (const v of list) {
    if (v && isValidVersionNumber(v.versionNumber) && v.versionNumber > maxNumber) {
      maxNumber = v.versionNumber;
    }
  }
  return target.versionNumber === maxNumber;
}

// validUntil 必須是合法日期，且尚未超過傳入的「目前時間」——now 由呼叫端明確傳入
// （不在這裡呼叫 new Date()），維持純函式（同樣輸入永遠得到同樣輸出），方便測試用
// 固定時間做精確斷言，也方便測試「剛好卡在到期邊界」的情境。
function checkQuoteVersionNotExpired(quoteVersion, now) {
  const raw = quoteVersion && quoteVersion.validUntil;
  if (!raw) {
    return { ok: false, error: '此報價版本缺少有效期限，無法回覆' };
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return { ok: false, error: '此報價版本有效期限格式異常，無法回覆' };
  }
  if (d.getTime() < now.getTime()) {
    return { ok: false, error: '此報價版本已過期，無法回覆，請洽業務重新發布報價版本' };
  }
  return { ok: true };
}

// 建立完整的客戶回覆快照：decision／note／idempotencyKey 由呼叫端明確傳入（已經過
// validateResponseFields() 驗證），respondedAt 由呼叫端傳入的 now（Date 物件）產生，
// 這個函式本身不呼叫 new Date()，維持真正的純函式。actor 固定寫死 'customer'，
// 跟訂單負責人／狀態歷程／付款交易／人工調價／報價版本的 actor 欄位同一套安全考量：
// 這個欄位代表「是誰做出這個回覆」的事實記錄，不接受前端傳入、不可能被偽造成別人。
function buildCustomerResponse({ decision, note, idempotencyKey, now }) {
  return {
    decision,
    note: note || '',
    respondedAt: now.toISOString(),
    actor: 'customer',
    idempotencyKey
  };
}

module.exports = {
  IDEMPOTENCY_KEY_REGEX,
  NOTE_MAX_LEN,
  validateResponseFields,
  responseContentMatches,
  isLatestQuoteVersion,
  checkQuoteVersionNotExpired,
  buildCustomerResponse
};
