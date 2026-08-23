// 楊竹科技 — 前台商品資料載入層
// 負責把「後台資料庫（SQLite）→ 公開 API」的商品資料，轉換成前台既有的 PRODUCTS 物件格式。
// 只處理「資料從哪裡來」，不處理計價邏輯（計價仍由 js/products.js 的 calcQuote 負責），
// 也不改變任何 UI／流程，讓 configurator.js／preview2d.js／preview3d.js／ai-design.js
// 完全不用修改，繼續照原本的方式讀取全域的 PRODUCTS[id]。

// ─── 資料契約：GET /api/products、GET /api/products/:id 回傳的單筆商品物件形狀 ───
// 跟 js/products.js 裡寫死的 PRODUCTS[id] 物件完全一致（camelCase），這樣資料來源
// 從「內建備援」切換成「資料庫」時，其他前台模組不用跟著改一行程式。
//
// {
//   id             : string                              // 商品代碼，永久不變，不因改名而變動
//   name           : string                               // 中文名稱
//   nameEn         : string | null
//   status         : 'active' | 'inactive' | 'coming_soon' // 公開 API 只會回傳 'active'
//   sortOrder      : number
//   icon           : string | null                         // emoji／圖示字元，image 讀取失敗時的備援顯示
//   image          : string | null                          // 商品縮圖路徑
//   bgImage        : string | null                          // 底圖路徑（有實體模板的商品才有）
//   badge          : string | null
//   badgeColor     : string | null                          // CSS 顏色字串
//   description    : string | null
//   size           : { w: number, h: number, unit: string }
//   displaySize    : string | null                          // 若有值，優先於 size 顯示
//   labelArea      : { xRatio, yRatio, wRatio, hRatio } | null
//   textLayout     : object | null
//   materials      : Array<{ id: string, name: string, priceBase: number }>
//   finishes       : Array<{ id: string, name: string, price: number }>
//   capacities     : Array<{ id: string, name: string, price: number }> | null
//   qtyBreaks      : Array<{ min: number, max: number, price: number }>
//   minQty         : number
//   leadDays       : number
//   color          : string | null
//   textOnly       : boolean
//   priceOnInquiry : boolean          // true 時報價相關 UI 一律顯示「價格由業務確認」（例如黑卡）
//   materialLabel  : string | null    // 覆寫 Step2「材質」標題文字（例如黑卡的「票證類型」）
//   finishLabel    : string | null    // 覆寫 Step2「表面工藝」標題文字（例如黑卡的「印刷效果」）
//   svgViewBox     : string | null    // 卡片向量外框資料，目前前台渲染尚未讀取，保留供未來使用
//   svgPath        : string | null
// }
//
// ─── 載入流程 ───
//   1. <script src="js/products.js"> 先同步建立 PRODUCTS（內建備援資料，開發期／API 連不上時使用）
//   2. 這支檔案的 loadProductsFromDatabase() 接著非同步呼叫 GET /api/products
//   3. 成功且格式正確 → 清空 PRODUCTS 後重新填入資料庫回傳的商品（同一個物件參照，
//      其他模組讀到的永遠是最新內容，不用改任何讀取 PRODUCTS 的地方）
//   4. 失敗（連不上、格式錯誤、沒有上架商品）→ 保留 js/products.js 的備援資料繼續運作，
//      不會造成前台白畫面
//   呼叫方：configurator.js 的 DOMContentLoaded 進入點要 await 這支函式完成後才 render
//   商品清單，不使用 setTimeout 猜測載入時間。

// 最小防呆：先確認整包回應「至少長得像」商品清單（避免 API 掛掉、回傳錯誤格式時
// 整段直接爆炸），細部完整性交給下面的 getProductShapeIssues() 逐筆檢查。
function validateProductListResponse(data) {
  if (!data || data.success !== true || !Array.isArray(data.products) || !data.products.length) return false;
  return data.products.every(p =>
    p && typeof p.id === 'string' &&
    Array.isArray(p.materials) && Array.isArray(p.finishes) && Array.isArray(p.qtyBreaks) &&
    p.size && typeof p.size.w === 'number' && typeof p.size.h === 'number'
  );
}

// 逐筆檢查單一商品是否具備前台計價／規格頁渲染實際會用到的必要資料：
// materials／finishes／qtyBreaks 不可為空、每項要有有限數字的價格欄位，size.w／size.h
// 要是大於 0 的數字。回傳問題原因陣列（空陣列代表完整可用），方便記錄清楚的略過原因，
// 而不是讓後台商品資料有缺漏時，前台直接算出錯誤報價或 NaN 卻沒有任何提示。
function getProductShapeIssues(p) {
  const issues = [];
  if (!p || typeof p !== 'object') return ['不是有效的商品物件'];

  if (!Array.isArray(p.materials) || p.materials.length === 0) {
    issues.push('materials 是空陣列或缺漏');
  } else if (p.materials.some(m => !m || typeof m.priceBase !== 'number' || !Number.isFinite(m.priceBase))) {
    issues.push('materials 內有項目缺少有效的 priceBase');
  }

  if (!Array.isArray(p.finishes) || p.finishes.length === 0) {
    issues.push('finishes 是空陣列或缺漏');
  } else if (p.finishes.some(f => !f || typeof f.price !== 'number' || !Number.isFinite(f.price))) {
    issues.push('finishes 內有項目缺少有效的 price');
  }

  if (!Array.isArray(p.qtyBreaks) || p.qtyBreaks.length === 0) {
    issues.push('qtyBreaks 是空陣列或缺漏');
  } else if (p.qtyBreaks.some(b => !b || typeof b.price !== 'number' || !Number.isFinite(b.price))) {
    issues.push('qtyBreaks 內有項目缺少有效的 price');
  }

  if (!p.size || typeof p.size.w !== 'number' || !(p.size.w > 0) || typeof p.size.h !== 'number' || !(p.size.h > 0)) {
    issues.push('size.w／size.h 缺漏或不是大於 0 的數字');
  }

  return issues;
}

// ─── 安全輸出工具：商品資料來自後台輸入，顯示到頁面前一律要經過這幾個函式 ───
// （後台商品表單本次沒有加驗證，所以前台這邊不能假設 name/description/badgeColor/image
//  一定是乾淨的字串，要在「顯示」這一關把關，才能防止商品名稱／說明等欄位被拿來塞
//  <script>、onerror=、javascript: 網址、或用 CSS 屬性值跳脫出 style 屬性。）

// HTML escape：把任意字串安全地插入 innerHTML 模板字串使用。& 一定要最先處理，
// 否則後面幾個 replace 產生的 &amp; 之類字串會被自己的規則再轉一次。
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 圖片來源白名單：只接受站內相對／絕對路徑，或明確的 http(s) 網址、安全的 data:image。
// 明確擋掉 javascript:／vbscript:／file:／data:text/html／data:image/svg+xml
// （SVG 可能內嵌 <script>，就算走 <img> 標籤在部分情境仍有風險，一律不允許）。
//
// 專案相對路徑刻意不限制字元集合（商品底圖檔名可能含中文，例如「保溫杯/保溫瓶.svg」），
// 改用「不含冒號」當防線：javascript:／data:／file:／vbscript:／mailto: 等所有協議型
// 網址都需要冒號，路徑裡完全沒有冒號就不可能是這類協議注入；同時擋掉 // 開頭的
// protocol-relative 網址（會被瀏覽器解析成外部網域）與控制字元。
function isSafeImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const v = url.trim();
  if (!v) return false;
  const lower = v.toLowerCase();

  if (lower.startsWith('javascript:')) return false;
  if (lower.startsWith('vbscript:')) return false;
  if (lower.startsWith('file:')) return false;
  if (lower.startsWith('data:text/html')) return false;
  if (lower.startsWith('data:image/svg+xml')) return false;
  if (/^data:image\/(png|jpe?g|gif|webp);base64,[a-zA-Z0-9+/=]+$/i.test(v)) return true; // 安全的點陣圖 data:image（不含 svg）
  if (lower.startsWith('data:')) return false; // 其他未明確允許的 data: 類型一律擋掉

  if (/^https?:\/\//i.test(v)) return true;   // 明確的 http(s) 網址
  if (v.startsWith('//')) return false;        // protocol-relative，可能指到任意外部網域，不允許
  if (v.startsWith('/')) return true;          // 站內絕對路徑

  if (v.includes(':')) return false;           // 含冒號代表可能是其他協議（mailto:／tel:／about: 等），一律擋掉
  if (/[\x00-\x1f]/.test(v)) return false;      // 控制字元一律擋掉
  return true;                                  // 其餘視為站內相對路徑（可含中文檔名等合法字元）
}

// CSS 顏色白名單：只接受合法 HEX、RGB／RGBA（數值範圍內）、或明確的顏色關鍵字清單，
// 避免 badgeColor、color 這類欄位被拿來塞任意 CSS（例如跳出屬性值插入其他樣式，
// 或 url(javascript:...)）。驗證不通過就回傳 fallback，不會把不明字串原樣塞進 style 屬性。
var SAFE_CSS_COLOR_KEYWORDS = [
  'black', 'white', 'red', 'green', 'blue', 'yellow', 'orange', 'purple', 'pink', 'brown',
  'gray', 'grey', 'cyan', 'magenta', 'lime', 'navy', 'teal', 'maroon', 'olive', 'silver',
  'gold', 'indigo', 'violet', 'coral', 'salmon', 'khaki', 'crimson', 'beige', 'ivory', 'transparent'
];

function _isValidRgbChannel(n) { return Number.isFinite(n) && n >= 0 && n <= 255; }
function _isValidAlphaChannel(n) { return Number.isFinite(n) && n >= 0 && n <= 1; }

// 布林版本：只判斷合不合法，不處理 fallback。前台 safeCssColor() 跟後台驗證都靠這個
// 共用同一套「合法顏色」定義，避免兩邊各寫一份規則、以後改一邊忘記改另一邊。
function isSafeCssColorValue(value) {
  if (!value || typeof value !== 'string') return false;
  const v = value.trim();

  if (/^#[0-9a-fA-F]{3}$/.test(v) || /^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{8}$/.test(v)) return true;

  const rgbMatch = v.match(/^rgb\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/i);
  if (rgbMatch) {
    const [r, g, b] = rgbMatch.slice(1, 4).map(Number);
    return [r, g, b].every(_isValidRgbChannel);
  }

  const rgbaMatch = v.match(/^rgba\(\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d*\.?\d+)\s*\)$/i);
  if (rgbaMatch) {
    const [r, g, b, a] = rgbaMatch.slice(1, 5).map(Number);
    return [r, g, b].every(_isValidRgbChannel) && _isValidAlphaChannel(a);
  }

  return SAFE_CSS_COLOR_KEYWORDS.includes(v.toLowerCase());
}

function safeCssColor(value, fallback) {
  const fb = fallback || '#999999';
  return isSafeCssColorValue(value) ? value.trim() : fb;
}

// 回傳 'database' 或 'fallback'，方便呼叫端（或開發時在 console）確認目前用的是哪一份資料。
// 注意：console 訊息只印商品筆數／錯誤訊息，不會印出任何密鑰或個資。
async function loadProductsFromDatabase() {
  try {
    const resp = await fetch('/api/products');
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!validateProductListResponse(data)) {
      throw new Error('回傳格式不正確或目前沒有上架商品');
    }

    // 整包回應格式沒問題後，逐筆再檢查一次「資料完不完整」——後台驗證理論上已經擋掉
    // 不完整的商品，但前台這層再檢查一次，才不會因為舊資料、手動改資料庫等後台驗證
    // 涵蓋不到的情況，讓報價／規格頁面拿到缺 price 的商品而算出錯誤金額或 NaN。
    const byId = {};
    const skipped = [];
    data.products.forEach(p => {
      const issues = getProductShapeIssues(p);
      if (issues.length === 0) {
        byId[p.id] = p;
      } else {
        skipped.push({ id: (p && p.id) || '(未知id)', issues });
      }
    });

    if (Object.keys(byId).length === 0) {
      throw new Error('資料庫回傳的商品全部資料不完整，沒有可用商品');
    }

    skipped.forEach(s => {
      console.warn(`[product-service] 商品「${s.id}」資料不完整，已略過此商品（原因：${s.issues.join('、')}），該商品暫時不會顯示在前台`);
    });

    Object.keys(PRODUCTS).forEach(k => delete PRODUCTS[k]);
    Object.assign(PRODUCTS, byId);
    const skippedNote = skipped.length ? `，另有 ${skipped.length} 個商品因資料不完整被略過` : '';
    console.log(`[product-service] 資料來源：database（已載入 ${Object.keys(byId).length} 個上架商品${skippedNote}）`);
    return 'database';
  } catch (err) {
    console.warn(`[product-service] 資料來源：fallback（原因：${err.message}，改用 js/products.js 內建資料）`);
    return 'fallback';
  }
}

// Node.js 後端共用（admin-routes.js 的商品驗證要用同一套 escapeHtml／isSafeImageUrl／
// safeCssColor 規則，避免前後端各寫一份、以後改一邊忘記改另一邊）。
// 瀏覽器端載入時 module 不存在，不受影響。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { escapeHtml, isSafeImageUrl, safeCssColor, isSafeCssColorValue, SAFE_CSS_COLOR_KEYWORDS };
}
