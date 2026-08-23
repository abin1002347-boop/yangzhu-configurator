// 楊竹科技 — 產品資料庫與定價邏輯

const PRODUCTS = {
  easycard: {
    id: 'easycard',
    name: '客製化悠遊卡',
    nameEn: 'Custom EasyCard',
    icon: '🚇',
    image: 'assets/photos/easycard.jpg',
    badge: '授權製造',
    badgeColor: '#0072C6',
    description: '悠遊卡官方簽約授權廠，可搭乘大眾運輸、消費儲值',
    size: { w: 85.6, h: 54, unit: 'mm' },
    // 刀模輪廓 (圓角矩形)
    svgViewBox: '0 0 856 540',
    svgPath: 'M60,0 H796 Q856,0 856,60 V480 Q856,540 796,540 H60 Q0,540 0,480 V60 Q0,0 60,0 Z',
    // 建議安全印刷範圍（卡片四周約3mm安全邊界，避免文字太靠近卡緣/圓角），非限縮設計自由
    labelArea: { xRatio: 0.035, yRatio: 0.056, wRatio: 0.930, hRatio: 0.889 },
    materials: [
      { id: 'pvc', name: 'PVC 標準卡', priceBase: 120 },
      { id: 'pet', name: 'PET 環保卡', priceBase: 145 },
      { id: 'wood', name: '木質卡', priceBase: 220 }
    ],
    finishes: [
      { id: 'gloss', name: '亮面', price: 0 },
      { id: 'matte', name: '霧面', price: 8 },
      { id: 'spot_uv', name: '局部 UV', price: 25 }
    ],
    // minQty=1（商品列表「最低1個起」、材質「NT$xxx/個起」皆直接讀這份資料），
    // 級距必須從 1 開始涵蓋，否則 1~99 個會落在級距空隙，估價/成品預覽/報價單都會
    // 顯示「此數量沒有符合的價格級距」。1~99 沿用跟 100~299 相同的基礎價（不加價
    // 不打折），只有達到 300 個以上才開始有數量折扣。
    qtyBreaks: [
      { min: 1,    max: 99,   price: 0 },
      { min: 100,  max: 299,  price: 0 },
      { min: 300,  max: 499,  price: -10 },
      { min: 500,  max: 999,  price: -20 },
      { min: 1000, max: 9999, price: -35 }
    ],
    minQty: 1,
    leadDays: 15,
    color: '#0072C6'
  },

  ipass: {
    id: 'ipass',
    name: '客製化一卡通',
    nameEn: 'Custom iPASS',
    icon: '🚌',
    image: 'assets/photos/ipass.jpg',
    // 尚無楊竹自有實品照，暫用 icon（原圖為第三方品牌實際卡面設計，已移除避免版權疑慮）
    badge: '授權製造',
    badgeColor: '#E85C0D',
    description: '一卡通票證官方授權廠，全台通用電子票證',
    size: { w: 85.6, h: 54, unit: 'mm' },
    svgViewBox: '0 0 856 540',
    svgPath: 'M60,0 H796 Q856,0 856,60 V480 Q856,540 796,540 H60 Q0,540 0,480 V60 Q0,0 60,0 Z',
    // 建議安全印刷範圍（卡片四周約3mm安全邊界，跟悠遊卡同尺寸卡片共用同一組比例）
    labelArea: { xRatio: 0.035, yRatio: 0.056, wRatio: 0.930, hRatio: 0.889 },
    materials: [
      { id: 'pvc', name: 'PVC 標準卡', priceBase: 120 },
      { id: 'pet', name: 'PET 環保卡', priceBase: 145 }
    ],
    finishes: [
      { id: 'gloss', name: '亮面', price: 0 },
      { id: 'matte', name: '霧面', price: 8 },
      { id: 'spot_uv', name: '局部 UV', price: 25 }
    ],
    // minQty=1 但級距原本從100開始，1~99會落在級距空隙（悠遊卡同一批問題已修正，
    // 這裡沿用相同修法）：1~99沿用跟100~299相同的基礎價，滿300個以上才開始打折。
    qtyBreaks: [
      { min: 1,    max: 99,   price: 0 },
      { min: 100,  max: 299,  price: 0 },
      { min: 300,  max: 499,  price: -10 },
      { min: 500,  max: 999,  price: -20 },
      { min: 1000, max: 9999, price: -35 }
    ],
    minQty: 1,
    leadDays: 15,
    color: '#E85C0D'
  },

  thermos: {
    id: 'thermos',
    name: '客製化保溫杯',
    nameEn: 'Custom Thermos',
    icon: '🍵',
    image: 'assets/photos/thermos-preview.jpg',
    // 尚無楊竹自有實品照，暫用 icon（原圖為其他品牌廣告圖，已移除避免版權與品牌混淆疑慮）
    badge: '台灣製造',
    badgeColor: '#B87333',
    description: '304不鏽鋼真空保溫，雷射雕刻客製文字，送禮自用首選',
    // 設計畫布直接呈現「展開印刷稿」本身（234×130mm），不再是整張瓶身外觀比例——
    // 舊版 size 是 1126×796 SVG viewBox 代理比例，印刷區只占畫布中間一小塊
    // （labelArea 換算後才等於234×130mm）。改成畫布＝印刷稿本身後，圓柱曲面/接縫/
    // 分區提示改在 Step3 CSS overlay 與 Step4 Three.js 圓柱貼圖處理，不需要底圖示意瓶身。
    size: { w: 234, h: 130, unit: 'mm' },
    displaySize: '印刷範圍 234 × 130 mm',
    bgImage: null, // 不再用瓶身SVG當底圖，畫布本身即印刷稿
    // 整個畫布本身就是印刷區（見上方說明），故涵蓋全畫布
    labelArea: { xRatio: 0, yRatio: 0, wRatio: 1, hRatio: 1 },
    // 文字放置位置（相對畫布高度）：從舊版數值精確反推 new_yRatio=(old_yRatio-舊labelArea.yRatio)/舊labelArea.hRatio，
    // new_sizeRatio=old_sizeRatio/舊labelArea.hRatio，等同把舊印刷區原地放大填滿新畫布，視覺比例不變
    textLayout: {
      title:    { yRatio: 0.319, sizeRatio: 0.460 },
      subtitle: { yRatio: 0.699, sizeRatio: 0.319 }
    },
    // 杯身顏色（開放客戶自選，純外觀不加價）：雷射雕刻蝕刻色依此變化，見 preview3d.js
    // 的 THERMOS_LASER_ENGRAVE_PARAMS
    cupColors: [
      { id: 'metal', name: '金屬原色', hex: '#b7bcc1' },
      { id: 'black', name: '沉穩黑',   hex: '#1c1c1e' },
      { id: 'dark',  name: '深色',     hex: '#2a3550' },
      { id: 'light', name: '淺色',     hex: '#e9e6de' }
    ],
    materials: [
      { id: 'ss304', name: '304 不鏽鋼', priceBase: 480 },
      { id: 'ss316', name: '316 不鏽鋼（食品級）', priceBase: 620 }
    ],
    finishes: [
      { id: 'laser', name: '雷射雕刻', price: 0 },
      { id: 'print', name: '彩色印刷貼紙', price: 60 }
    ],
    qtyBreaks: [
      { min: 1,   max: 49,   price: 0 },
      { min: 50,  max: 99,   price: -30 },
      { min: 100, max: 299,  price: -60 },
      { min: 300, max: 9999, price: -100 }
    ],
    minQty: 1,
    leadDays: 20,
    color: '#B87333'
  },

  // usb_bar（USB 隨身碟）已從商品目錄下架：資料庫端已用既有的「封存」機制
  // （archived_at，見 admin-routes.js 的 /api/admin/products/:id/archive／/restore）
  // 排除在 /api/products 之外，這裡把本機備援資料也一併移除，離線／API 連不上時
  // 的備援清單同樣不會出現 USB 入口。要恢復上架：資料庫端呼叫 /restore 端點清空
  // archived_at，這裡再把下面這個物件貼回來即可，preview2d.js／preview3d.js／
  // configurator.js／css/style.css 內既有的 USB 專屬分支都還在，未被刪除。

  black_card: {
    id: 'black_card',
    name: '尊爵不凡黑卡',
    nameEn: 'Prestige Black Card',
    icon: '🖤',
    // 尚無實品照，先以 icon 呈現（無 image 欄位時，選卡片格會自動 fallback 為 icon）
    badge: '全黑質感客製',
    badgeColor: '#B8860B',
    description: '卡體與客製圖樣皆為黑色調，僅以光澤／霧面／浮雕層次呈現質感，不使用彩色印刷',
    size: { w: 85.6, h: 54, unit: 'mm' },
    svgViewBox: '0 0 856 540',
    svgPath: 'M60,0 H796 Q856,0 856,60 V480 Q856,540 796,540 H60 Q0,540 0,480 V60 Q0,0 60,0 Z',

    // 票證類型（重用 materials[] 軸，見 configurator.js 的 materialLabel 覆寫）
    materials: [
      { id: 'ticket_easycard', name: '悠遊卡 EasyCard', priceBase: 0 },
      { id: 'ticket_ipass',    name: '一卡通 iPASS',     priceBase: 0 },
      { id: 'ticket_icash',    name: 'ICASH 2.0',        priceBase: 0 }
    ],

    // 印刷效果（重用 finishes[] 軸，浮雕深淺攤平為獨立選項，見 finishLabel 覆寫）
    finishes: [
      { id: 'gloss_black',           name: '亮黑',            price: 0 },
      { id: 'matte_black',           name: '霧黑',            price: 0 },
      { id: 'emboss_black_light',    name: '黑色浮雕（淺）',   price: 0 },
      { id: 'emboss_black_standard', name: '黑色浮雕（標準）', price: 0 },
      { id: 'emboss_black_deep',     name: '黑色浮雕（深）',   price: 0 }
    ],

    qtyBreaks: [
      { min: 1, max: 9999, price: 0 }
    ],
    minQty: 1,
    leadDays: 20,
    color: '#0a0a0a',
    priceOnInquiry: true, // 尚無真實單價，報價相關 UI 一律顯示「價格由業務確認」
    materialLabel: '票證類型',
    finishLabel: '印刷效果'
  }
};

// ─── 報價計算 ──────────────────────────────────────────────
// 依 qty 找出「唯一命中」的數量級距。qtyBreaks 先依 min 由小到大排序，每一段的合法
// 涵蓋範圍是 [min, max]；max 缺漏、null 或不是有限數字，代表這段是最高級距、向上視為
// 無限（不會漏掉超過資料裡最後一筆 max 的大單）。級距資料本身「不可重疊、只有最高
// 級距能省略 max」由後台商品驗證（admin-routes.js 的 checkQtyBreaks）在儲存商品時把關，
// 這裡只單純負責在既有資料下找出這個數量唯一命中的那一段，找不到就回傳 null
// （由呼叫端顯示清楚錯誤，不會猜測或套用預設級距）。
function resolveQtyBreak(qtyBreaks, qty) {
  if (!Array.isArray(qtyBreaks) || !qtyBreaks.length) return null;
  const sorted = qtyBreaks
    .filter(b => b && typeof b.min === 'number' && Number.isFinite(b.min))
    .slice()
    .sort((a, b) => a.min - b.min);
  for (const b of sorted) {
    const max = (typeof b.max === 'number' && Number.isFinite(b.max)) ? b.max : Infinity;
    if (qty >= b.min && qty <= max) return b;
  }
  return null;
}

// 純函式版本：直接吃「已經解析好的商品物件」，不依賴任何全域狀態，前台（讀取全域
// PRODUCTS[id]，可能是內建備援資料，也可能是 product-service.js 從資料庫載入後蓋掉的
// 最新資料）與後端（讀取 db.js 的 getProductById() 查到的正式資料庫商品資料）共用同一份
// 計算邏輯，確保「同樣的商品資料＋同樣的選擇＋同樣的數量」在前後端永遠算出同一個結果。
//
// 回傳值一律是 { ok: boolean, ... }：
//   ok:false → { ok:false, error }，呼叫端必須顯示這個錯誤訊息，不可以嘗試讀取金額欄位
//   ok:true 且商品為 priceOnInquiry → { ok:true, priceOnInquiry:true, qty, leadDays }（沒有任何金額欄位，
//     避免對外部尚未公開單價的商品，算出並顯示/儲存一組看似真實、實則虛構的總額）
//   ok:true 且一般商品 → { ok:true, priceOnInquiry:false, unitPrice, subtotal, setupFee, total,
//     leadDays, qty, qtyBreakUsed:{min,max,price} }
// 缺少或錯誤的價格資料一律回傳明確的 error 訊息，絕不會回傳 undefined／NaN，
// 也不會為了「有個數字可以顯示」而偷套用 0 元或任何隨意的預設值。
function calcQuoteForProduct(product, materialId, finishId, capacityId, qty) {
  if (!product) return { ok: false, error: '找不到此商品' };

  if (!Array.isArray(product.materials) || !product.materials.length) {
    return { ok: false, error: '此商品缺少材質價格資料，無法計算報價' };
  }
  const material = product.materials.find(m => m.id === materialId);
  if (!material || typeof material.priceBase !== 'number' || !Number.isFinite(material.priceBase)) {
    return { ok: false, error: '選擇的材質不存在或缺少有效價格資料' };
  }

  if (!Array.isArray(product.finishes) || !product.finishes.length) {
    return { ok: false, error: '此商品缺少工藝價格資料，無法計算報價' };
  }
  const finish = product.finishes.find(f => f.id === finishId);
  if (!finish || typeof finish.price !== 'number' || !Number.isFinite(finish.price)) {
    return { ok: false, error: '選擇的工藝不存在或缺少有效價格資料' };
  }

  let capacity = null;
  if (Array.isArray(product.capacities) && product.capacities.length) {
    capacity = product.capacities.find(c => c.id === capacityId);
    if (!capacity || typeof capacity.price !== 'number' || !Number.isFinite(capacity.price)) {
      return { ok: false, error: '選擇的容量不存在或缺少有效價格資料' };
    }
  }

  const qtyNum = Number(qty);
  if (!Number.isFinite(qtyNum) || !Number.isInteger(qtyNum) || qtyNum <= 0) {
    return { ok: false, error: '數量必須是大於 0 的整數' };
  }

  const minQty = (typeof product.minQty === 'number' && Number.isFinite(product.minQty)) ? product.minQty : 1;
  if (qtyNum < minQty) {
    return { ok: false, error: `數量不可低於最低訂購量 ${minQty} 個` };
  }

  // priceOnInquiry 商品到此為止：確認選擇的材質／工藝／容量與數量都合法後直接回傳，
  // 完全不進入級距計價，不會產生任何金額欄位，避免顯示或儲存虛假的自動總額。
  if (product.priceOnInquiry) {
    return {
      ok: true,
      priceOnInquiry: true,
      qty: qtyNum,
      leadDays: (typeof product.leadDays === 'number' && Number.isFinite(product.leadDays)) ? product.leadDays : null
    };
  }

  const qtyBreak = resolveQtyBreak(product.qtyBreaks, qtyNum);
  if (!qtyBreak || typeof qtyBreak.price !== 'number' || !Number.isFinite(qtyBreak.price)) {
    return { ok: false, error: '此數量沒有符合的價格級距，請確認商品的數量價格設定' };
  }

  const unitPrice = material.priceBase + finish.price + (capacity ? capacity.price : 0) + qtyBreak.price;
  if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
    return { ok: false, error: '計算出的單價不合理，請確認商品價格與數量級距設定' };
  }

  const subtotal = unitPrice * qtyNum;
  const setupFee = 100; // 製版費（固定金額，本次不做人工調價／運費／稅額）
  const total = subtotal + setupFee;

  return {
    ok: true,
    priceOnInquiry: false,
    unitPrice,
    subtotal,
    setupFee,
    total,
    leadDays: (typeof product.leadDays === 'number' && Number.isFinite(product.leadDays)) ? product.leadDays : null,
    qty: qtyNum,
    qtyBreakUsed: {
      min: qtyBreak.min,
      max: (typeof qtyBreak.max === 'number' && Number.isFinite(qtyBreak.max)) ? qtyBreak.max : null,
      price: qtyBreak.price
    }
  };
}

// 舊有呼叫介面（productId 查表版）：前台既有程式碼都是呼叫 calcQuote(productId,...)，
// 讀取全域 PRODUCTS[productId]，實際計算邏輯統一委派給上面的 calcQuoteForProduct()，
// 前後端不會出現兩份互相可能兜不起來的計價規則。
function calcQuote(productId, materialId, finishId, qty, capacityId = null) {
  return calcQuoteForProduct(PRODUCTS[productId], materialId, finishId, capacityId, qty);
}

// Node.js 後端共用（工廠下載包等功能查詢 labelArea/尺寸用；server.js 的 /api/save-order
// 用 calcQuoteForProduct() 依資料庫商品資料重新計算報價，不信任前端傳入的金額）。
// 瀏覽器端載入時 module 不存在，不受影響。
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PRODUCTS, calcQuote, calcQuoteForProduct, resolveQtyBreak };
}
