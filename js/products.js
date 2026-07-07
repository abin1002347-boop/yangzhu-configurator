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
    qtyBreaks: [
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
    badge: '授權製造',
    badgeColor: '#E85C0D',
    description: '一卡通票證官方授權廠，全台通用電子票證',
    size: { w: 85.6, h: 54, unit: 'mm' },
    svgViewBox: '0 0 856 540',
    svgPath: 'M60,0 H796 Q856,0 856,60 V480 Q856,540 796,540 H60 Q0,540 0,480 V60 Q0,0 60,0 Z',
    materials: [
      { id: 'pvc', name: 'PVC 標準卡', priceBase: 120 },
      { id: 'pet', name: 'PET 環保卡', priceBase: 145 }
    ],
    finishes: [
      { id: 'gloss', name: '亮面', price: 0 },
      { id: 'matte', name: '霧面', price: 8 },
      { id: 'spot_uv', name: '局部 UV', price: 25 }
    ],
    qtyBreaks: [
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
    image: 'assets/photos/thermos.jpg',   // 請將保溫杯照片存於此路徑
    badge: '台灣製造',
    badgeColor: '#B87333',
    description: '304不鏽鋼真空保溫，雷射雕刻客製文字，送禮自用首選',
    size: { w: 1126, h: 796, unit: '' },  // 對應 SVG viewBox 比例，供 canvas 用
    displaySize: '印刷範圍 234 × 130 mm',
    // 印刷區在 SVG (1125.77×796.01) 內的比例座標
    labelArea: { xRatio: 0.386, yRatio: 0.333, wRatio: 0.208, hRatio: 0.163 },
    // 文字放置位置（相對 canvas 高度）
    textLayout: {
      title:    { yRatio: 0.385, sizeRatio: 0.075 },
      subtitle: { yRatio: 0.447, sizeRatio: 0.052 }
    },
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
    color: '#B87333',
    textOnly: true
  },

  usb_bar: {
    id: 'usb_bar',
    name: 'USB 隨身碟（條形）',
    nameEn: 'Bar USB Drive',
    icon: '💾',
    image: 'assets/photos/usb_bar.jpg',
    badge: '台灣製造',
    badgeColor: '#2D7D46',
    description: '客製外殼印刷，容量 16GB～256GB，Type-A / Type-C 雙介面可選',
    size: { w: 62, h: 20, unit: 'mm' },
    svgViewBox: '0 0 620 200',
    svgPath: 'M20,0 H600 Q620,0 620,20 V180 Q620,200 600,200 H20 Q0,200 0,180 V20 Q0,0 20,0 Z',
    materials: [
      { id: 'plastic', name: '塑膠殼', priceBase: 85 },
      { id: 'metal',   name: '金屬殼', priceBase: 130 },
      { id: 'wood',    name: '木質殼', priceBase: 160 }
    ],
    capacities: [
      { id: '16gb',  name: '16 GB',  price: 0 },
      { id: '32gb',  name: '32 GB',  price: 15 },
      { id: '64gb',  name: '64 GB',  price: 28 },
      { id: '128gb', name: '128 GB', price: 50 },
      { id: '256gb', name: '256 GB', price: 90 }
    ],
    finishes: [
      { id: 'print', name: '彩色印刷', price: 0 },
      { id: 'laser', name: '雷射雕刻', price: 18 }
    ],
    qtyBreaks: [
      { min: 50,   max: 99,   price: 0 },
      { min: 100,  max: 299,  price: -8 },
      { min: 300,  max: 999,  price: -18 },
      { min: 1000, max: 9999, price: -28 }
    ],
    minQty: 1,
    leadDays: 20,
    color: '#2D7D46'
  }
};

// 報價計算函式
function calcQuote(productId, materialId, finishId, qty, capacityId = null) {
  const p = PRODUCTS[productId];
  if (!p) return null;

  const material = p.materials.find(m => m.id === materialId) || p.materials[0];
  const finish   = p.finishes.find(f => f.id === finishId)     || p.finishes[0];
  const capacity = p.capacities ? (p.capacities.find(c => c.id === capacityId) || p.capacities[0]) : null;

  let unitPrice = material.priceBase + finish.price + (capacity ? capacity.price : 0);

  // 數量折扣
  const qb = p.qtyBreaks.slice().reverse().find(b => qty >= b.min);
  if (qb) unitPrice += qb.price;

  const subtotal = unitPrice * qty;
  const setupFee = 800; // 製版費
  const total = subtotal + setupFee;

  return {
    unitPrice: Math.max(unitPrice, 1),
    subtotal,
    setupFee,
    total,
    leadDays: p.leadDays,
    qty
  };
}
