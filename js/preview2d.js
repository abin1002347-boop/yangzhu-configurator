// 楊竹科技 — 2D Canvas 設計預覽模組（Fabric.js）

let canvas2d = null;
let uploadedImage = null;
let currentProduct = null;
let _suppressOverlay = false;  // 匯出時暫時關閉虛線框

// 可用字體清單（需搭配 Google Fonts 載入）
const FONTS = [
  // ── 中文字體 ──────────────────────
  { id: 'Noto Sans TC',             label: '思源黑體',    preview: '楊竹Aa' },
  { id: 'Noto Serif TC',            label: '思源宋體',    preview: '楊竹Aa' },
  { id: 'Zen Old Mincho',           label: '典雅明朝',    preview: '楊竹Aa' },
  { id: 'LXGW WenKai TC',          label: '霞鶩文楷',    preview: '楊竹Aa' },
  { id: 'Zcool KuaiLe',            label: '站酷快樂體🎉', preview: '楊竹Aa' },
  { id: 'Zcool QingKe HuangYou',   label: '站酷黃油體✨', preview: '楊竹Aa' },
  { id: 'Ma Shan Zheng',           label: '馬善正楷🌸',   preview: '楊竹Aa' },
  { id: 'Long Cang',               label: '龍藏手寫🖌️',   preview: '楊竹Aa' },
  // ── 英文字體 ──────────────────────
  { id: 'Oswald',                   label: 'Oswald（英）', preview: 'YangZhu' },
  { id: 'Playfair Display',         label: 'Playfair（英）',preview: 'YangZhu' },
  { id: 'Bebas Neue',               label: 'Bebas（英）',  preview: 'YANGZHU' },
  { id: 'Arial',                    label: 'Arial',        preview: 'YangZhu' },
  // ── 保溫杯特色字體 ─────────────────────
  { id: 'Amalfi Coast',             label: 'Amalfi Coast', preview: 'YangZhu' },
  { id: 'Bacalisties',              label: 'Bacalisties',  preview: 'YangZhu' },
  { id: 'Chen Yuluoyan',            label: '陳宇洛燕體',    preview: '楊竹Aa' },
  { id: 'JF Open Huninn',           label: '俐方體',        preview: '楊竹Aa' },
  { id: 'Jinghong',                 label: '驚鴻',          preview: '楊竹Aa' },
  { id: 'Meiyi',                    label: '美意字',        preview: '楊竹Aa' },
  { id: 'Meiyi Mono',               label: '美意字等寬',     preview: '楊竹Aa' },
];

function init2DCanvas(productId) {
  currentProduct = PRODUCTS[productId];
  if (!currentProduct) return;

  if (typeof fabric === 'undefined') {
    const wrap = document.querySelector('.canvas-wrap');
    if (wrap) {
      wrap.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#dc2626;font-size:14px;">⚠️ 設計工具載入失敗，請重新整理頁面再試一次。</div>';
    }
    return;
  }

  if (canvas2d) { canvas2d.dispose(); canvas2d = null; }

  const el = document.getElementById('canvas-2d');
  if (!el) return;

  const containerW = el.parentElement.offsetWidth || 400;
  const ratio = currentProduct.size.h / currentProduct.size.w;
  const cw = Math.min(containerW - 40, 480);
  const ch = Math.round(cw * ratio);

  el.width  = cw;
  el.height = ch;

  const isThermos = currentProduct.id === 'thermos';

  canvas2d = new fabric.Canvas('canvas-2d', {
    width: cw, height: ch,
    backgroundColor: isThermos ? null : '#ffffff'
  });

  // ── 手機觸控優化 ──────────────────────────
  fabric.Object.prototype.cornerSize          = 14;
  fabric.Object.prototype.touchCornerSize     = 42;
  fabric.Object.prototype.cornerStyle         = 'circle';
  fabric.Object.prototype.transparentCorners  = false;
  fabric.Object.prototype.cornerColor         = '#16a34a';
  fabric.Object.prototype.borderColor         = '#16a34a';
  fabric.Object.prototype.borderScaleFactor   = 2;

  canvas2d.on('selection:created', _showScaleBar);
  canvas2d.on('selection:updated', _showScaleBar);
  canvas2d.on('selection:cleared',  _hideScaleBar);
  canvas2d.on('object:scaling',  _updateScaleSlider);
  canvas2d.on('object:modified', _updateScaleSlider);

  // after:render — 保溫杯只畫印刷區虛線框；其他產品畫全 canvas 圓角框
  canvas2d.on('after:render', function() {
    if (!currentProduct || _suppressOverlay) return;
    const ctx = canvas2d.contextContainer;
    const w   = canvas2d.getWidth();
    const h   = canvas2d.getHeight();

    ctx.save();
    ctx.setLineDash([10, 5]);

    if (currentProduct.labelArea) {
      const la = currentProduct.labelArea;
      ctx.strokeStyle = currentProduct.color || '#B87333';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(
        w * la.xRatio + 1, h * la.yRatio + 1,
        w * la.wRatio - 2, h * la.hRatio - 2
      );
    } else {
      const r   = Math.round(Math.min(w, h) * 0.06);
      const sw  = 2.5;
      const off = sw / 2;
      ctx.strokeStyle = currentProduct.color || '#2D7D46';
      ctx.lineWidth   = sw;
      ctx.beginPath();
      ctx.moveTo(r + off, off);
      ctx.lineTo(w - r - off, off);
      ctx.arcTo(w - off, off,     w - off, r + off,    r);
      ctx.lineTo(w - off, h - r - off);
      ctx.arcTo(w - off, h - off, w - r - off, h - off, r);
      ctx.lineTo(r + off, h - off);
      ctx.arcTo(off, h - off,     off, h - r - off,     r);
      ctx.lineTo(off, r + off);
      ctx.arcTo(off, off,         r + off, off,          r);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  });

  if (isThermos) {
    _loadThermosBottleBg(cw, ch, true);
  } else {
    addDefaultElements();
  }
}

// 載入保溫杯瓶身 SVG 作為 canvas 最底層
function _loadThermosBottleBg(cw, ch, withHint) {
  fabric.Image.fromURL('保溫杯/保溫瓶_MrFoster_簽名流線_20260512.svg', img => {
    if (!canvas2d) return;
    img.set({
      left: 0, top: 0,
      scaleX: cw / img.width,
      scaleY: ch / img.height,
      selectable: false, evented: false,
      name: 'bottle-bg',
      originX: 'left', originY: 'top'
    });
    canvas2d.add(img);
    canvas2d.sendToBack(img);
    if (withHint) addDefaultElements();
    else canvas2d.renderAll();
  });
}

function drawProductOutline(w, h) {
  // 虛線外框已改為 after:render 事件繪製（永遠在最上層）
  // 只保留品名浮水印
  const watermark = new fabric.Text(currentProduct.name, {
    left: w / 2, top: h / 2,
    originX: 'center', originY: 'center',
    fontSize: Math.round(h * 0.12),
    fill: 'rgba(0,0,0,0.04)',
    fontFamily: 'Arial',
    selectable: false, evented: false
  });
  canvas2d.add(watermark);
}

function addDefaultElements() {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();

  let hintLeft, hintTop, hintSize;
  if (currentProduct && currentProduct.labelArea) {
    const la = currentProduct.labelArea;
    hintLeft = w * (la.xRatio + la.wRatio / 2);
    hintTop  = h * (la.yRatio + la.hRatio / 2);
    hintSize = Math.max(9, Math.round(h * la.hRatio * 0.28));
  } else {
    hintLeft = w / 2;
    hintTop  = h / 2;
    hintSize = Math.round(h * 0.07);
  }

  const hint = new fabric.Text('輸入文字後點「套用文字」', {
    left: hintLeft, top: hintTop,
    originX: 'center', originY: 'center',
    fontSize: hintSize,
    fill: '#bbbbbb',
    fontFamily: 'Arial',
    fontStyle: 'italic',
    selectable: false, evented: false,
    name: 'hint'
  });
  canvas2d.add(hint);
  canvas2d.renderAll();
}

// ─── 加入文字（role: 'title' | 'subtitle'）────────────────
// title   → 上方 25% 處
// subtitle → 下方 75% 處
function addText2D(text, color = '#333333', size = null, font = 'Noto Sans TC', role = 'title') {
  if (!canvas2d || !text) return;

  // 確保字體已載入（對中文字體尤其重要）
  document.fonts.load(`16px "${font}"`).then(() => {
    _doAddText2D(text, color, size, font, role);
  }).catch(() => {
    _doAddText2D(text, color, size, font, role);
  });
}

function _doAddText2D(text, color, size, font, role) {
  if (!canvas2d) return;
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();

  const hint = canvas2d.getObjects().find(o => o.name === 'hint');
  if (hint) canvas2d.remove(hint);

  let topPos, defaultSize;
  if (currentProduct && currentProduct.textLayout && currentProduct.textLayout[role]) {
    const tl = currentProduct.textLayout[role];
    topPos      = h * tl.yRatio;
    defaultSize = Math.round(h * tl.sizeRatio);
  } else {
    topPos      = role === 'subtitle' ? h * 0.78 : h * 0.28;
    defaultSize = role === 'subtitle' ? Math.round(h * 0.10) : Math.round(h * 0.14);
  }

  const t = new fabric.IText(text, {
    left: w / 2,
    top: topPos,
    originX: 'center',
    originY: 'center',
    fontSize: size || defaultSize,
    fill: color,
    fontFamily: font,
    editable: true,
    name: role
  });

  canvas2d.add(t);
  canvas2d.bringToFront(t);
  canvas2d.setActiveObject(t);
  canvas2d.renderAll();
  return t;
}

// ─── 上傳圖片 ────────────────────────────────────────────
function uploadImage2D(file) {
  if (!canvas2d || !file) return;
  const reader = new FileReader();
  reader.onload = e => {
    fabric.Image.fromURL(e.target.result, img => {
      const w = canvas2d.getWidth();
      const h = canvas2d.getHeight();
      const scale = Math.min(w / img.width, h / img.height) * 0.65;
      img.set({
        left: w / 2, top: h / 2,
        originX: 'center', originY: 'center',
        scaleX: scale, scaleY: scale
      });
      canvas2d.add(img);
      canvas2d.sendToBack(img);   // 圖片在文字下方
      canvas2d.setActiveObject(img);
      canvas2d.renderAll();
      uploadedImage = img;
    });
  };
  reader.readAsDataURL(file);
}

// ─── 背景色 ──────────────────────────────────────────────
function setBackground2D(color) {
  if (!canvas2d) return;
  if (currentProduct && currentProduct.id === 'thermos') return; // 保溫杯保留瓶身圖
  canvas2d.setBackgroundColor(color, canvas2d.renderAll.bind(canvas2d));
}

// ─── 取得 DataURL（排除輔助線與虛線框）──────────────────────
function get2DDataURL() {
  if (!canvas2d) return null;
  // bottle-bg 保留在匯出圖中（保溫杯瓶身），只隱藏 hint 等輔助物件
  const bgObjs = canvas2d.getObjects().filter(o => !o.selectable && o.name !== 'bottle-bg');
  bgObjs.forEach(o => o.set('visible', false));
  _suppressOverlay = true;
  canvas2d.renderAll();
  const dataURL = canvas2d.toDataURL({ format: 'png', multiplier: 2 });
  _suppressOverlay = false;
  bgObjs.forEach(o => o.set('visible', true));
  canvas2d.renderAll();
  return dataURL;
}

// ─── Canvas JSON 存取（供返回設計稿時還原使用）─────────────────
function getCanvas2DJSON() {
  if (!canvas2d) return null;
  return canvas2d.toJSON();
}

function loadCanvas2DJSON(json) {
  if (!canvas2d || !json) return;
  canvas2d.loadFromJSON(json, function() {
    canvas2d.renderAll();
  });
}

// ─── 取得乾淨 Canvas Element（不含虛線框，供 3D 貼圖用）──────
function get2DCanvas() {
  if (!canvas2d) return null;
  const bgObjs = canvas2d.getObjects().filter(o => !o.selectable && o.name !== 'bottle-bg');
  bgObjs.forEach(o => o.set('visible', false));
  _suppressOverlay = true;
  canvas2d.renderAll();
  const lc = canvas2d.lowerCanvasEl;
  const copy = document.createElement('canvas');
  copy.width  = lc.width;
  copy.height = lc.height;
  copy.getContext('2d').drawImage(lc, 0, 0);
  _suppressOverlay = false;
  bgObjs.forEach(o => o.set('visible', true));
  canvas2d.renderAll();
  return copy;
}

// ─── 手機縮放控制列 ───────────────────────────────────────
function _showScaleBar() {
  const bar = document.getElementById('mobile-scale-bar');
  if (bar) bar.style.display = 'flex';
  _updateScaleSlider();
}
function _hideScaleBar() {
  const bar = document.getElementById('mobile-scale-bar');
  if (bar) bar.style.display = 'none';
}
function _updateScaleSlider() {
  const obj    = canvas2d?.getActiveObject();
  const slider = document.getElementById('scale-slider');
  const pct    = document.getElementById('scale-pct');
  if (!obj || !slider) return;
  const val = Math.round((obj.scaleX || 1) * 100);
  slider.value = Math.max(5, Math.min(300, val));
  if (pct) pct.textContent = val + '%';
}
function scaleSelectedTo(scale) {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (!obj) return;
  const s = Math.max(0.05, Math.min(3.0, parseFloat(scale)));
  obj.set({ scaleX: s, scaleY: s });
  canvas2d.requestRenderAll();
  const pct = document.getElementById('scale-pct');
  if (pct) pct.textContent = Math.round(s * 100) + '%';
}

// ─── 刪除選取 ─────────────────────────────────────────────
function deleteSelected2D() {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (obj) { canvas2d.remove(obj); canvas2d.renderAll(); }
}

// ─── 清空 ─────────────────────────────────────────────────
function clear2D() {
  if (!canvas2d) return;
  canvas2d.getObjects().slice().forEach(o => canvas2d.remove(o));
  if (currentProduct && currentProduct.id === 'thermos') {
    canvas2d.setBackgroundColor(null, () => {});
    _loadThermosBottleBg(canvas2d.getWidth(), canvas2d.getHeight(), true);
  } else {
    canvas2d.setBackgroundColor('#ffffff', () => { canvas2d.renderAll(); });
    drawProductOutline(canvas2d.getWidth(), canvas2d.getHeight());
  }
}
