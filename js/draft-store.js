// 客製化配置器 — 草稿保存服務（多分頁／多商品隔離）
//
// 背景：舊版只用單一全域 localStorage 鍵（yz_customizer_saved_design_v1）保存「目前這一份」
// 設計，導致兩個問題：(1) 同時開兩個分頁編輯不同商品時，後存檔的會蓋掉先存檔的；
// (2) 同一分頁內在商品之間切換，回頭選第一個商品時看到的是切換當下最後一次保存的內容，
// 不是「這個商品自己」上次編輯到的狀態。
//
// 解法：
//   - draftId：每個瀏覽器分頁各自獨立一組，存在 sessionStorage（分頁重新整理仍沿用同一個
//     draftId，但開新分頁會拿到新的 draftId——這正是 sessionStorage 天生的分頁隔離特性，
//     不用自己實作「偵測新分頁」）。
//   - 草稿鍵值＝ productId ＋ draftId 兩者共同決定，存在 localStorage（分頁之間本來就共用
//     同一個 origin 的 localStorage，用鍵值本身做隔離，而不是整份資料互相覆蓋）。
//   - 因此「這個分頁」可以同時保有好幾個商品各自的草稿（每個切換過的商品各存一份），
//     但「哪一份是這個分頁現在正在看的」另外用 sessionStorage 的 activeDraft 索引記錄，
//     重新整理時就是靠這個索引決定要接回哪個商品的哪份草稿。

const DRAFT_VERSION = 1;
const DRAFT_TAB_ID_KEY = 'customizer:tabDraftId';
const DRAFT_ACTIVE_KEY = 'customizer:activeDraft';
const DRAFT_LEGACY_KEY = 'yz_customizer_saved_design_v1';
const DRAFT_LEGACY_MIGRATED_FLAG = 'customizer:legacyMigrated_v1';

function draftKey(productId, draftId) {
  return `customizer:draft:${productId}:${draftId}`;
}

// 每個分頁固定一組 draftId：sessionStorage 本身就是「同分頁重新整理沿用、開新分頁重新產生」，
// 直接借用這個瀏覽器原生特性，不用自己維護分頁識別邏輯。sessionStorage 被封鎖時（無痕模式
// 部分瀏覽器設定）退回記憶體變數，至少同一次瀏覽（不重新整理）行為一致，不會整頁掛掉。
function getTabDraftId() {
  try {
    let id = sessionStorage.getItem(DRAFT_TAB_ID_KEY);
    if (!id) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('t' + Date.now() + '_' + Math.random().toString(36).slice(2));
      sessionStorage.setItem(DRAFT_TAB_ID_KEY, id);
    }
    return id;
  } catch (e) {
    if (!window._yzMemTabDraftId) window._yzMemTabDraftId = 't' + Date.now() + '_' + Math.random().toString(36).slice(2);
    return window._yzMemTabDraftId;
  }
}

function _cloneSerializable(obj) {
  try { return JSON.parse(JSON.stringify(obj)); } catch (e) { return null; }
}

// 非阻斷式錯誤提示：保存失敗（多半是 localStorage 容量爆掉或被瀏覽器封鎖）時用，
// 絕對不能拿 alert()，也不能清空畫面，使用者應該完全感覺不到操作被打斷。
function _yzDraftSaveError(msg) {
  const el = document.getElementById('draft-save-error-toast');
  if (!el) { console.warn('[draft-store] ' + msg); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(_yzDraftSaveError._t);
  _yzDraftSaveError._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 5000);
}

// 草稿基本結構是否成立：版本相符、有 draftId／productId、商品目前仍存在（未下架）、
// state 是個物件。這裡只驗證「形狀」，不驗證商品與鍵值是否對得起來——那是 loadDraft() 的責任
// （驗證要用「查詢時傳入的 productId/draftId」比對，而不是只信任內容本身宣稱的值）。
function validateDraft(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (raw.version !== DRAFT_VERSION) return false;
  if (!raw.draftId || !raw.productId) return false;
  if (typeof PRODUCTS !== 'undefined' && !PRODUCTS[raw.productId]) return false;
  if (!raw.state || typeof raw.state !== 'object') return false;
  return true;
}

// 版本升級轉換點：目前只有 v1，辨識不出的版本一律視為不可用（而不是硬套用可能對不上的欄位）。
function migrateDraft(rawDraft) {
  if (rawDraft && rawDraft.version === DRAFT_VERSION) return rawDraft;
  return null;
}

function createDraft(productId) {
  return {
    version: DRAFT_VERSION,
    draftId: getTabDraftId(),
    productId,
    currentStep: 1,
    updatedAt: Date.now(),
    state: null
  };
}

// 寫入草稿。容量爆掉時先嘗試丟掉最大宗的 base64 圖片欄位重存一次精簡版（保留使用者最在意
// 的可編輯狀態：文字/圖層/位置/縮放/旋轉），兩次都失敗才真的放棄，並用非阻斷提示告知。
function saveDraft(draft) {
  if (!draft || !draft.productId || !draft.draftId) return false;
  draft.updatedAt = Date.now();
  const key = draftKey(draft.productId, draft.draftId);
  const payload = _cloneSerializable(draft);
  if (!payload) { _yzDraftSaveError('設計資料無法序列化，本次修改未能保存'); return false; }

  let ok = false;
  try {
    localStorage.setItem(key, JSON.stringify(payload));
    ok = true;
  } catch (e) {
    const slim = _cloneSerializable(draft);
    if (slim && slim.state) {
      delete slim.state.blackCardCandidates;
      delete slim.state.blackCardSelectedImage;
      delete slim.state.blackCardPatternDataURL;
      delete slim.state.designDataURL;
      // 一卡通／悠遊卡／保溫杯上傳的照片是內嵌在 canvasJson.objects[].src 裡的
      // base64字串，實測才是真正把容量塞爆的元凶（黑卡的圖片欄位在上面已經先清過，
      // 但一般商品的照片走的是這條路徑，之前完全沒清到，導致「精簡版」其實沒有
      // 精簡到真正的大宗，第二次還是失敗）。單一物件的 src 超過 50KB 就先拔掉，
      // 保留文字/圖層/位置/縮放/旋轉等其餘可編輯狀態；代價是重新整理後這個物件會
      // 少了圖片本身，需要使用者重新上傳一次，但至少不會整份草稿都救不回來。
      const objs = slim.state.canvasJson && slim.state.canvasJson.objects;
      if (Array.isArray(objs)) {
        objs.forEach(o => {
          if (o && typeof o.src === 'string' && o.src.length > 50000) delete o.src;
        });
      }
    }
    try {
      localStorage.setItem(key, JSON.stringify(slim));
      ok = true;
      _yzDraftSaveError('本機儲存空間不足，已保留設計內容但略過部分圖片快取');
    } catch (e2) {
      _yzDraftSaveError('自動保存失敗（本機儲存空間不足或被瀏覽器封鎖），目前修改僅存在於本次瀏覽');
      return false;
    }
  }

  try {
    sessionStorage.setItem(DRAFT_ACTIVE_KEY, JSON.stringify({
      draftId: draft.draftId, productId: draft.productId, updatedAt: draft.updatedAt
    }));
  } catch (e) { /* sessionStorage 被封鎖不影響本次保存是否成功，僅影響下次重整能否自動接回 */ }
  return ok;
}

// 讀取草稿，並用「查詢時傳入的 productId/draftId」跟內容比對，不信任內容自己宣稱的值
// （防止鍵值跟內容 productId 對不上時被誤用套到別的商品）。損壞或版本不相容的資料不直接
// 丟棄，先搬到除錯用鍵值保留，再從正式鍵值移除，避免下次還是讀到同一份壞資料。
function loadDraft(productId, draftId) {
  const key = draftKey(productId, draftId);
  let raw;
  try { raw = localStorage.getItem(key); } catch (e) { return null; }
  if (!raw) return null;

  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
  const migrated = parsed ? migrateDraft(parsed) : null;
  const valid = migrated && validateDraft(migrated) && migrated.productId === productId && migrated.draftId === draftId;

  if (!valid) {
    try {
      localStorage.setItem(`customizer:draft:corrupt:${Date.now()}`, raw);
      localStorage.removeItem(key);
    } catch (e) { /* 清不掉就算了，不影響回傳 null 這個結果 */ }
    return null;
  }
  return migrated;
}

// 目前分頁「正在使用中」的草稿（頁面載入時自動恢復用）。索引本身若損壞/指向不存在的資料，
// 一律回傳 null，交由呼叫端決定要不要顯示「草稿無法恢復」提示，不在這裡直接下判斷。
function getActiveDraft() {
  let idx = null;
  try {
    const raw = sessionStorage.getItem(DRAFT_ACTIVE_KEY);
    if (raw) idx = JSON.parse(raw);
  } catch (e) { idx = null; }
  if (!idx || !idx.productId || !idx.draftId) return null;
  return loadDraft(idx.productId, idx.draftId);
}

function updateDraft(productId, draftId, patch) {
  const existing = loadDraft(productId, draftId) || createDraft(productId);
  existing.productId = productId;
  existing.draftId = draftId;
  Object.assign(existing, patch);
  return saveDraft(existing);
}

// 切換商品時的唯一入口：有這個分頁、這個商品的草稿就回傳既有的，沒有就回傳一份全新、
// 尚未寫入的空白草稿骨架（state 留給呼叫端依 resetDesignStateForProduct() 後的 STATE 填入）。
// 不會、也不能把「目前正在編輯的別的商品」內容複製過來——本階段明確不做跨商品複製。
function switchProductDraft(productId) {
  const draftId = getTabDraftId();
  const existing = loadDraft(productId, draftId);
  if (existing) return existing;
  return createDraft(productId);
}

// 刪除「這個分頁ID」名下所有商品的草稿（一個分頁可能同時編輯過好幾個商品，各自存一份）。
// 用途：F5重整／離開頁面時分頁ID會直接換一組新的（見 configurator.js _redirectHomeOnReload()／
// pagehide），舊分頁ID若只是棄置不用，草稿內容還留在 localStorage 沒有真的被清掉，重整測試
// 次數一多會慢慢塞滿容量，最後導致上傳圖片時「自動保存失敗」。這裡在換新分頁ID之前，先把
// 舊分頁ID名下每個商品的草稿都實際刪掉，才不會留下永遠不會再被讀到、又刪不掉的殭屍資料。
function clearAllDraftsForTab(draftId) {
  if (!draftId) return;
  try {
    const prefix = 'customizer:draft:';
    const suffix = ':' + draftId;
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix) && k.endsWith(suffix)) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) { /* localStorage 讀不到就算了，不影響換新分頁ID這件事本身 */ }
}

// 清掉「太久沒動過」的舊草稿：clearAllDraftsForTab() 只能防止「以後」繼續累積殭屍資料，
// 對於在這個修法上線前就已經堆在使用者瀏覽器裡的舊垃圾沒有幫助——這正是容量爆掉、
// 上傳圖片時「自動保存失敗」的根本原因。用 updatedAt 判斷（不是拿分頁ID比對），
// 因為就算是「別的分頁」的草稿，只要是最近還在編輯的，updatedAt 一定很新，這樣才不會
// 誤刪使用者現在真的開在另一個分頁、正在編輯中的草稿。每次頁面載入都會跑一次，
// 直接掛在 DOMContentLoaded，成本很低（localStorage本來就是同步、本機讀寫）。
function purgeStaleDrafts(maxAgeMs) {
  maxAgeMs = maxAgeMs || (24 * 60 * 60 * 1000);
  try {
    const prefix = 'customizer:draft:';
    const now = Date.now();
    const toRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(prefix) || k.startsWith(prefix + 'corrupt:')) continue;
      let updatedAt = 0;
      try {
        const parsed = JSON.parse(localStorage.getItem(k));
        updatedAt = (parsed && parsed.updatedAt) || 0;
      } catch (e) { /* 解析不出來的舊格式資料視為updatedAt=0，一併當作過期清掉 */ }
      if (now - updatedAt > maxAgeMs) toRemove.push(k);
    }
    toRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) { /* 清理本身失敗不影響正常使用流程 */ }
}

// 只刪除「這個商品＋這個分頁」的草稿。只有目前分頁的 activeDraft 索引剛好指向這份草稿時
// 才一併清掉索引，避免誤刪「索引其實指向別的商品」這種邊界情況下的索引本身。
function clearDraft(productId, draftId) {
  try { localStorage.removeItem(draftKey(productId, draftId)); } catch (e) {}
  try {
    const raw = sessionStorage.getItem(DRAFT_ACTIVE_KEY);
    if (raw) {
      const idx = JSON.parse(raw);
      if (idx && idx.productId === productId && idx.draftId === draftId) {
        sessionStorage.removeItem(DRAFT_ACTIVE_KEY);
      }
    }
  } catch (e) {}
}

// 舊版全域鍵值一次性搬遷：只在「全瀏覽器範圍」執行一次（用 localStorage 旗標，不是
// sessionStorage，避免同一台電腦每開一個新分頁都重跑一次）。搬遷對象沒有 productId 或
// 商品已不存在時，不套用到任何商品，直接標記完成並捨棄，不亂猜要塞進哪個商品。
function migrateLegacyGlobalSave() {
  try {
    if (localStorage.getItem(DRAFT_LEGACY_MIGRATED_FLAG)) return null;
    const raw = localStorage.getItem(DRAFT_LEGACY_KEY);
    if (!raw) { localStorage.setItem(DRAFT_LEGACY_MIGRATED_FLAG, '1'); return null; }

    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
    const legacyState = parsed && parsed.state;
    const legacyProductId = legacyState && legacyState.productId;

    if (!legacyState || !legacyProductId || typeof PRODUCTS === 'undefined' || !PRODUCTS[legacyProductId]) {
      localStorage.setItem(DRAFT_LEGACY_MIGRATED_FLAG, '1');
      return null;
    }

    const draft = {
      version: DRAFT_VERSION,
      draftId: getTabDraftId(),
      productId: legacyProductId,
      currentStep: legacyState.step || 1,
      updatedAt: Date.now(),
      state: legacyState
    };
    saveDraft(draft);
    localStorage.removeItem(DRAFT_LEGACY_KEY);
    localStorage.setItem(DRAFT_LEGACY_MIGRATED_FLAG, '1');
    return draft;
  } catch (e) {
    try { localStorage.setItem(DRAFT_LEGACY_MIGRATED_FLAG, '1'); } catch (e2) {}
    return null;
  }
}
