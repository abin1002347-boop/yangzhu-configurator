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
  { id: 'Zcool KuaiLe',            label: '站酷快樂體',   preview: '楊竹Aa' },
  { id: 'Zcool QingKe HuangYou',   label: '站酷黃油體',   preview: '楊竹Aa' },
  { id: 'Ma Shan Zheng',           label: '馬善正楷',     preview: '楊竹Aa' },
  { id: 'Long Cang',               label: '龍藏手寫',     preview: '楊竹Aa' },
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

let _designFocusView = null;

function getDefaultViewportTransform() {
  return [1, 0, 0, 1, 0, 0];
}

function getProductFocusViewport() {
  if (!canvas2d || !currentProduct || !currentProduct.labelArea) return null;
  if (currentProduct.id === 'thermos') return null;
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  const la = currentProduct.labelArea;
  const areaLeft = w * la.xRatio;
  const areaTop = h * la.yRatio;
  const areaW = w * la.wRatio;
  const areaH = h * la.hRatio;
  const centerX = areaLeft + areaW / 2;
  const centerY = areaTop + areaH / 2;
  const focusPaddingX = currentProduct.id === 'usb_bar' ? 2.05 : 2.35;
  const focusPaddingY = currentProduct.id === 'usb_bar' ? 3.2 : 3.8;
  const zoom = Math.min(2.15, Math.max(1, Math.min(w / (areaW * focusPaddingX), h / (areaH * focusPaddingY))));
  if (zoom <= 1.02) return null;
  return [zoom, 0, 0, zoom, w / 2 - centerX * zoom, h / 2 - centerY * zoom];
}

// 悠遊卡／一卡通／保溫杯：canvas 層級裁切，確保使用者內容（上傳圖片／滿版縮放等）
// 不會溢出可印刷範圍，即使放大到 300% 也一樣被裁掉。刻意不透過 JSON 序列化保存，比照
// applyDesignFocusView() 的既有模式——每次建立畫布／還原草稿後依商品類型重新計算
// 套用，不進 STATE、不進草稿，避免綁進 draft-store 的資料結構，也避免 fabric 版本
// 升級後 canvas 級 clipPath 序列化行為改變導致草稿還原壞掉。
function _applyCardShellClipPath() {
  if (!canvas2d || !currentProduct) return;
  const cw = canvas2d.getWidth();
  const ch = canvas2d.getHeight();
  if (currentProduct.id === 'thermos') {
    // 保溫杯畫布本身即展開印刷稿（矩形、無圓角），裁切邊界等於整個畫布
    canvas2d.clipPath = new fabric.Rect({
      width: cw, height: ch, left: 0, top: 0, absolutePositioned: true
    });
    return;
  }
  if (!['easycard', 'ipass'].includes(currentProduct.id)) { canvas2d.clipPath = null; return; }
  canvas2d.clipPath = new fabric.Rect({
    width: cw, height: ch,
    rx: cw * (3.18 / 85.6), ry: cw * (3.18 / 85.6),
    left: 0, top: 0,
    absolutePositioned: true
  });
}

// 保溫杯：展開印刷稿左/正/右分區＋接縫區提示。恆常顯示（不像安全範圍可切換）——
// 這是圓柱形狀本身的必要說明，不是可選功能。用 CSS overlay 疊在 canvas 外層，
// 不畫進 canvas 本身，get2DDataURL() 匯出時天然不會捕捉到，不需要額外用
// _suppressOverlay 排除。其他商品呼叫時直接清空/隱藏，不殘留上一個商品的分區線。
function renderThermosZoneOverlay() {
  const overlay = document.getElementById('thermos-zone-overlay');
  if (!overlay) return;
  if (!currentProduct || currentProduct.id !== 'thermos') {
    overlay.classList.remove('on');
    overlay.innerHTML = '';
    return;
  }
  overlay.classList.add('on');
  overlay.innerHTML = `
    <div class="zone-divider" style="left:33.3%;"></div>
    <div class="zone-divider" style="left:66.6%;"></div>
    <div class="zone-caption" style="left:2%;">← 左側</div>
    <div class="zone-caption" style="left:46%;">正面</div>
    <div class="zone-caption" style="right:2%;">右側 →</div>
    <div class="seam-strip" style="left:0;"></div>
    <div class="seam-strip" style="right:0;"></div>
    <div class="seam-caption" style="left:0.5%;">接縫區・避免緊貼</div>
    <div class="seam-caption" style="right:0.5%;">接縫區・避免緊貼</div>
  `;
}

function applyDesignFocusView() {
  if (!canvas2d) return;
  _designFocusView = getProductFocusViewport();
  canvas2d.setViewportTransform(_designFocusView || getDefaultViewportTransform());
  canvas2d.requestRenderAll();
}

function withFullCanvasView(callback) {
  if (!canvas2d) return callback();
  const original = canvas2d.viewportTransform ? canvas2d.viewportTransform.slice() : getDefaultViewportTransform();
  canvas2d.setViewportTransform(getDefaultViewportTransform());
  canvas2d.renderAll();
  const result = callback();
  canvas2d.setViewportTransform(original);
  canvas2d.renderAll();
  return result;
}

// 畫布重建過程中（新畫布逐一 object:added、_refreshBlackCardNextButton()→renderLayerPanel()
// 反覆觸發）STATE.selectedLayerId 會被暫時同步成 null，這只是重建過程中間狀態的正常副作用，
// 不代表使用者真的取消選取——init2DCanvas() 一開始先把「這次要還原選取到哪個圖層」存進這個
// 模組變數，loadCanvas2DJSON() 真正把物件都載入完成後才拿出來用，不能直接信任重建過程中
// 任一時間點的 STATE.selectedLayerId（見 _restoreSelectedLayerFromState()）。
let _pendingRestoreLayerId = null;

function init2DCanvas(productId, onReady) {
  currentProduct = PRODUCTS[productId];
  if (!currentProduct) return;
  _pendingRestoreLayerId = (typeof STATE !== 'undefined') ? STATE.selectedLayerId : null;

  if (typeof fabric === 'undefined') {
    const wrap = document.querySelector('.canvas-wrap');
    if (wrap) {
      wrap.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#dc2626;font-size:14px;">⚠️ 設計工具載入失敗，請重新整理頁面再試一次。</div>';
    }
    return;
  }

  if (canvas2d) { canvas2d.dispose(); canvas2d = null; }
  // 舊畫布被整個丟棄重建時不會觸發 selection:cleared，手機縮放控制列若還顯示著
  // 上一個商品的物件縮放百分比（例如黑卡圖案的 3%／16%），會讓新商品的畫布看起來
  // 像被縮小了，即使新畫布物件其實都是乾淨的 scaleX=1——每次重建畫布一律先隱藏。
  if (typeof _hideScaleBar === 'function') _hideScaleBar();

  const el = document.getElementById('canvas-2d');
  if (!el) return;

  const containerW = el.parentElement.offsetWidth || 400;
  const ratio = currentProduct.size.h / currentProduct.size.w;
  // 桌面寬螢幕：畫布放大約 25%，讓商品畫布作為視覺核心更突出；
  // 手機/平板維持原本上限，避免超出容器寬度造成裁切或版面跑掉。
  const widthCap = window.innerWidth >= 1280 ? 600 : 480;
  const cw = Math.min(containerW - 40, widthCap);
  const ch = Math.round(cw * ratio);

  el.width  = cw;
  el.height = ch;

  const hasBgImage = !!currentProduct.bgImage;

  canvas2d = new fabric.Canvas('canvas-2d', {
    width: cw, height: ch,
    backgroundColor: hasBgImage ? null : '#ffffff'
  });
  _applyCardShellClipPath();

  // ── 手機觸控優化 + 選取控制點樣式 ──────────────────────────
  // 控制點尺寸縮小、顏色改為低調的香檳金（黑卡）／墨綠（其他商品），取代先前
  // 搶眼的亮綠，維持精品質感但仍保有足夠的觸控熱區。
  const isBlackCardCanvas = currentProduct.id === 'black_card';
  const selectColor = isBlackCardCanvas
    ? (getComputedStyle(document.documentElement).getPropertyValue('--select-gold').trim() || '#C8A968')
    : (getComputedStyle(document.documentElement).getPropertyValue('--select-green').trim() || '#3f6b4a');
  fabric.Object.prototype.cornerSize          = 11;
  fabric.Object.prototype.touchCornerSize     = 34;
  fabric.Object.prototype.cornerStyle         = 'circle';
  fabric.Object.prototype.transparentCorners  = false;
  fabric.Object.prototype.cornerColor         = selectColor;
  fabric.Object.prototype.borderColor         = selectColor;
  fabric.Object.prototype.borderScaleFactor   = 1.5;

  // 保溫杯：左/正/右分區＋接縫區提示（展開印刷稿專屬，其他商品不顯示）
  renderThermosZoneOverlay();

  canvas2d.on('selection:created', _showScaleBar);
  canvas2d.on('selection:updated', _showScaleBar);
  canvas2d.on('selection:cleared',  _hideScaleBar);
  canvas2d.on('selection:created', _handleTemplateSelection);
  canvas2d.on('selection:updated', _handleTemplateSelection);
  canvas2d.on('selection:created', _handleThermosSignatureClick);
  canvas2d.on('selection:updated', _handleThermosSignatureClick);
  canvas2d.on('selection:created', renderLayerPanel);
  canvas2d.on('selection:updated', renderLayerPanel);
  canvas2d.on('selection:cleared', renderLayerPanel);
  canvas2d.on('selection:created', _updateStickerColorPanel);
  canvas2d.on('selection:updated', _updateStickerColorPanel);
  canvas2d.on('selection:cleared', _updateStickerColorPanel);
  canvas2d.on('object:scaling',  _updateScaleSlider);
  canvas2d.on('object:modified', _updateScaleSlider);
  // 使用者拖曳/縮放/旋轉結束（放開滑鼠）時，把 left/top/scaleX/scaleY/angle/
  // originX/originY 完整存進 designState，回設計頁或重新整理都能還原
  canvas2d.on('object:modified', () => { if (typeof syncDesignState === 'function') syncDesignState(); });
  // 黑卡「下一步」按鈕即時啟用/停用：任何物件新增或移除都可能改變 hasPrintableDesign() 的結果
  canvas2d.on('object:added',   _refreshBlackCardNextButton);
  canvas2d.on('object:removed', _refreshBlackCardNextButton);
  // 黑卡設計頁的滑鼠光影追蹤（見下方 document 'mousemove' 監聽）在使用者正在拖曳／
  // 縮放／旋轉物件時會搶走視覺注意力，這裡標記操作中狀態，操作期間光影暫時凍結
  canvas2d.on('object:moving',   () => { _bcDraggingActive = true; });
  canvas2d.on('object:scaling',  () => { _bcDraggingActive = true; });
  canvas2d.on('object:rotating', () => { _bcDraggingActive = true; });
  canvas2d.on('mouse:up',        () => { _bcDraggingActive = false; });
  canvas2d.on('object:modified', () => { _bcDraggingActive = false; });
  _refreshBlackCardNextButton();


  // onReady：底圖（若有）真正載入完成後才觸發，呼叫端（initDesignStep()）在這裡決定要
  // 「加入空白模板預設元素」還是「還原已保存的草稿內容」，兩者只會擇一發生、不會搶跑。
  // 沒有底圖的商品（黑卡／悠遊卡／一卡通走內建模板，不讀外部圖檔）本來就是同步完成，
  // 這裡統一都透過 onReady 走一次，呼叫端就不用區分「這個商品是不是非同步載入」。
  if (hasBgImage) {
    _loadProductBgImage(currentProduct.bgImage, cw, ch, () => {
      if (typeof onReady === 'function') onReady();
    });
  } else {
    applyDesignFocusView();
    if (typeof onReady === 'function') onReady();
  }
}

// 載入產品外觀底圖作為 canvas 最底層（USB 外殼等點陣圖底圖，由 currentProduct.bgImage 驅動；
// 保溫杯自升級成「展開印刷稿」畫布後 bgImage 已改為 null，不再吃這支函式）。
// bgImage 來自後台商品資料，載入前一定要先過 isSafeImageUrl，擋掉 javascript:/data:image/svg+xml 等危險網址。
//
// afterLoaded 一律是函式：底圖真正加到 canvas2d 上之後才呼叫，由呼叫端決定接下來要
// 「加入空白模板預設元素」還是「還原已保存的草稿內容」。過去這裡用一個 withHint 布林值
// 內建二選一，導致還原草稿的呼叫端沒有機會插進來，只能整個排除在還原流程之外（過去有
// 底圖商品用非同步載入時，若讓「還原 JSON」跟這個非同步回呼各自獨立觸發，會產生「先跑
// 完的先贏、後跑完的疊上去」的競爭態——不管哪個先跑完，畫面都可能同時看到預設提示文字
// 跟還原後的文字疊在一起，或還原的內容被之後才跑完的預設模板蓋掉。改成回呼制之後，兩者
// 永遠只會擇一發生、且發生順序固定。
function _loadProductBgImage(url, cw, ch, afterLoaded) {
  const finish = () => {
    if (typeof afterLoaded === 'function') afterLoaded();
    else if (canvas2d) canvas2d.renderAll();
    applyDesignFocusView();
  };

  if (!isSafeImageUrl(url)) {
    console.warn('[preview2d] 商品底圖網址不安全，已略過載入：', url);
    finish();
    return;
  }

  fabric.Image.fromURL(url, img => {
    if (!canvas2d) return;
    img.set({
      left: 0, top: 0,
      scaleX: cw / img.width,
      scaleY: ch / img.height,
      selectable: false, evented: false,
      name: 'product-bg',
      originX: 'left', originY: 'top'
    });
    canvas2d.add(img);
    canvas2d.sendToBack(img);
    finish();
  });
}

function drawProductOutline(w, h) {
  // 舊版外框已停用；保留此函式避免舊呼叫失效。
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

function makeTemplateLayerOptions(name) {
  return {
    selectable: true,
    evented: true,
    lockMovementX: true,
    lockMovementY: true,
    lockScalingX: true,
    lockScalingY: true,
    lockRotation: true,
    hasControls: false,
    hoverCursor: 'pointer',
    name
  };
}

function _handleTemplateSelection(e) {
  const obj = e?.selected?.[0] || canvas2d?.getActiveObject();
  if (!obj || !['template-wave', 'template-wave-light'].includes(obj.name)) return;
  const mainPicker = document.getElementById('wave-color-main');
  const lightPicker = document.getElementById('wave-color-light');
  if (obj.name === 'template-wave' && mainPicker) mainPicker.focus();
  if (obj.name === 'template-wave-light' && lightPicker) lightPicker.focus();
}

// 保溫杯：直接點畫布上的藝術簽名文字（不管是示範內容還是使用者自己套用過的），
// 直接跳出「藝術簽名」彈窗，不用先在左側面板找到「藝術簽名」再點一次才能編輯。
function _handleThermosSignatureClick(e) {
  const obj = e?.selected?.[0] || canvas2d?.getActiveObject();
  if (!obj || obj.name !== 'thermos-signature') return;
  if (typeof openThermosSignatureModal === 'function') openThermosSignatureModal();
}

function addDefaultElements() {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();

  if (currentProduct && currentProduct.id === 'black_card') {
    addBlackCardTemplate();
    return;
  }

  // 悠遊卡／一卡通共用同一份卡片模板（addYangZhuCardTemplate()，含圓角/邊緣高光/
  // 厚度暗邊視覺），兩者尺寸與視覺需求完全相同，共用同一支函式。
  if (currentProduct && !currentProduct.bgImage && ['easycard', 'ipass'].includes(currentProduct.id)) {
    addYangZhuCardTemplate();
    return;
  }

  // 保溫杯：全新空白草稿第一次進入設計頁時，補上三個容易辨識、可個別選取的示範圖層
  // （主標題／副標題／Logo圖形），方便直接驗收縮放保存等功能；只在「這個分頁從未
  // 顯示過」時建立一次，使用者清空重來或清除草稿後即便重新進入空白畫布也不會自動
  // 加回——見 addThermosDemoLayers() 開頭說明。非首次的空白畫布則落到下方通用的
  // 提示文字分支，跟其他商品行為一致。
  if (currentProduct && currentProduct.id === 'thermos' && !_thermosDemoAlreadySeeded()) {
    addThermosDemoLayers();
    _markThermosDemoSeeded();
    return;
  }

  let hintLeft, hintTop, hintSize;
  if (currentProduct && currentProduct.labelArea) {
    const la = currentProduct.labelArea;
    hintLeft = w * (la.xRatio + la.wRatio / 2);
    hintTop  = h * (la.yRatio + la.hRatio / 2);
    // 保溫杯印刷區 hRatio 是整張畫布（=1），用跟其他商品一樣的 0.28 倍率字會大到蓋住整個卡面，
    // 所以保溫杯單獨用較小倍率，其他商品（印刷區本來就比畫布小一圈）維持原本比例不動。
    const hintSizeRatio = (currentProduct.id === 'thermos') ? 0.09 : 0.28;
    hintSize = Math.max(9, Math.round(h * la.hRatio * hintSizeRatio));
  } else {
    hintLeft = w / 2;
    hintTop  = h / 2;
    hintSize = Math.round(h * 0.07);
  }

  // 保溫杯的文字客製只能透過左側「藝術簽名」彈窗輸入，畫布上沒有可以直接打字的欄位，
  // 提示文字要對應這個實際操作流程，不能沿用其他商品「輸入文字後點『套用文字』」的講法。
  const hintText = (currentProduct && currentProduct.id === 'thermos')
    ? '點選左側「藝術簽名」開始設計'
    : '輸入文字後點「套用文字」';

  const hint = new fabric.Text(hintText, {
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

// 悠遊卡／一卡通向量背景（白底＋波浪＋圓點）共用建構邏輯，套用指定色系並加到目前
// 畫布最底層。addYangZhuCardTemplate()（初次建立空白畫布）與 applyCardBackgroundTemplate2D()
// （客人在AI插畫背景生效時改選色系模板，需要換回可調色的向量背景）共用同一份，
// 避免兩處各自維護幾乎一樣的形狀定義。
// ─── 背景蒙版造型（10款，跟顏色完全拆開）────────────────────────
// 每款只負責「main／light」兩層的路徑幾何（形狀），不帶任何顏色資料——顏色一律
// 交給「波浪顏色」的主波浪／淺色波浪兩顆色票控制（見 setTemplateWaveColor2D()），
// 換造型不會影響使用者已經調好的顏色，換顏色也不會影響目前選的造型，兩件事徹底
// 互不干擾。main 疊在 light 上面（light 只在 main 沒蓋到的地方露出來，做出雙層
// 堆疊的立體感），沿用悠遊卡原本「經典波浪」的疊層邏輯。
const CARD_MASK_SHAPES = [
  {
    id: 'blank', name: '空白背板', desc: '純底色，無造型裝飾',
    // main/light 刻意留空字串：_addYangZhuVectorBackground() 看到空字串就不會建立
    // 這兩個 fabric.Path，右下角那組裝飾圓點也會一併跳過，做到真正的空白背板。
    build: (w, h) => ({ main: '', light: '' })
  },
  {
    id: 'wave_single', name: '經典波浪', desc: '單層弧線，柔和大方',
    build: (w, h) => ({
      main: `M 0 ${h*0.70} C ${w*0.22} ${h*0.60}, ${w*0.34} ${h*0.80}, ${w*0.55} ${h*0.70} C ${w*0.74} ${h*0.60}, ${w*0.86} ${h*0.70}, ${w} ${h*0.58} L ${w} ${h} L 0 ${h} Z`,
      light: `M 0 ${h*0.64} C ${w*0.18} ${h*0.58}, ${w*0.30} ${h*0.72}, ${w*0.48} ${h*0.64} C ${w*0.64} ${h*0.56}, ${w*0.80} ${h*0.64}, ${w} ${h*0.50} L ${w} ${h*0.58} C ${w*0.84} ${h*0.70}, ${w*0.72} ${h*0.60}, ${w*0.55} ${h*0.70} C ${w*0.34} ${h*0.80}, ${w*0.22} ${h*0.60}, 0 ${h*0.70} Z`
    })
  },
  {
    id: 'wave_double', name: '雙層波浪', desc: '較密的雙峰曲線',
    build: (w, h) => ({
      main: `M 0 ${h*0.74} C ${w*0.12} ${h*0.66}, ${w*0.20} ${h*0.82}, ${w*0.32} ${h*0.74} C ${w*0.44} ${h*0.66}, ${w*0.52} ${h*0.82}, ${w*0.64} ${h*0.74} C ${w*0.76} ${h*0.66}, ${w*0.84} ${h*0.82}, ${w} ${h*0.70} L ${w} ${h} L 0 ${h} Z`,
      light: `M 0 ${h*0.66} C ${w*0.12} ${h*0.60}, ${w*0.20} ${h*0.74}, ${w*0.32} ${h*0.66} C ${w*0.44} ${h*0.58}, ${w*0.52} ${h*0.74}, ${w*0.64} ${h*0.66} C ${w*0.76} ${h*0.58}, ${w*0.84} ${h*0.74}, ${w} ${h*0.62} L ${w} ${h*0.70} C ${w*0.84} ${h*0.82}, ${w*0.76} ${h*0.66}, ${w*0.64} ${h*0.74} C ${w*0.52} ${h*0.82}, ${w*0.44} ${h*0.66}, ${w*0.32} ${h*0.74} C ${w*0.20} ${h*0.82}, ${w*0.12} ${h*0.66}, 0 ${h*0.74} Z`
    })
  },
  {
    id: 'diagonal_cut', name: '斜角切面', desc: '俐落的雙色斜切',
    build: (w, h) => ({
      main: `M 0 ${h} L 0 ${h*0.78} L ${w} ${h*0.42} L ${w} ${h} Z`,
      light: `M 0 ${h*0.78} L 0 ${h*0.60} L ${w} ${h*0.24} L ${w} ${h*0.42} Z`
    })
  },
  {
    id: 'steps', name: '階梯造型', desc: '俐落的方塊階梯',
    build: (w, h) => ({
      main: `M 0 ${h} L 0 ${h*0.85} L ${w*0.25} ${h*0.85} L ${w*0.25} ${h*0.76} L ${w*0.5} ${h*0.76} L ${w*0.5} ${h*0.67} L ${w*0.75} ${h*0.67} L ${w*0.75} ${h*0.58} L ${w} ${h*0.58} L ${w} ${h} Z`,
      light: `M 0 ${h*0.85} L 0 ${h*0.77} L ${w*0.25} ${h*0.77} L ${w*0.25} ${h*0.68} L ${w*0.5} ${h*0.68} L ${w*0.5} ${h*0.59} L ${w*0.75} ${h*0.59} L ${w*0.75} ${h*0.50} L ${w} ${h*0.50} L ${w} ${h*0.58} L ${w*0.75} ${h*0.58} L ${w*0.75} ${h*0.67} L ${w*0.5} ${h*0.67} L ${w*0.5} ${h*0.76} L ${w*0.25} ${h*0.76} L ${w*0.25} ${h*0.85} Z`
    })
  },
  {
    id: 'blob_corner', name: '圓弧氣泡', desc: '右下角大圓弧',
    build: (w, h) => ({
      main: `M ${w*0.30} ${h} L ${w*0.30} ${h*0.68} C ${w*0.30} ${h*0.50}, ${w*0.55} ${h*0.40}, ${w*0.76} ${h*0.40} C ${w*0.95} ${h*0.40}, ${w} ${h*0.55}, ${w} ${h*0.68} L ${w} ${h} Z`,
      light: `M ${w*0.50} ${h} L ${w*0.50} ${h*0.80} C ${w*0.50} ${h*0.66}, ${w*0.68} ${h*0.58}, ${w*0.84} ${h*0.58} C ${w*0.96} ${h*0.58}, ${w} ${h*0.68}, ${w} ${h*0.80} L ${w} ${h} Z`
    })
  },
  {
    id: 'zigzag', name: '之字形', desc: '規律鋸齒線條',
    build: (w, h) => ({ main: _zigzagPath(w, h, 7, h*0.72, h), light: _zigzagPath(w, h, 7, h*0.60, h*0.80) })
  },
  {
    id: 'flags', name: '三角旗幟', desc: '三角旗排列裝飾',
    build: (w, h) => ({ main: _flagsPath(w, h, 8, h*0.68, h*0.94), light: _flagsPath(w, h, 8, h*0.56, h*0.80) })
  },
  {
    id: 'scallop', name: '扇形疊層', desc: '半圓弧連續排列',
    build: (w, h) => ({ main: _scallopPath(w, h, 6, h*0.72, h*0.13), light: _scallopPath(w, h, 6, h*0.60, h*0.13) })
  },
  {
    id: 'facet', name: '切角多邊形', desc: '折紙感不規則塊面',
    build: (w, h) => ({
      main: `M ${w*0.40} ${h} L ${w*0.55} ${h*0.75} L ${w*0.80} ${h*0.85} L ${w} ${h*0.60} L ${w} ${h} Z`,
      light: `M ${w*0.55} ${h*0.75} L ${w*0.68} ${h*0.53} L ${w*0.90} ${h*0.60} L ${w} ${h*0.40} L ${w} ${h*0.60} L ${w*0.80} ${h*0.85} Z`
    })
  },
  {
    id: 'stripes', name: '細線裝飾', desc: '極簡斜紋線條',
    build: (w, h) => ({ main: _stripesPath(w, h, 6, w*0.022, 0), light: _stripesPath(w, h, 5, w*0.016, w*0.06) })
  }
];

// 鋸齒／三角旗／扇形／細線這幾款重複性圖案改用小函式產生座標，避免手key一長串
// 容易算錯又難維護；有機曲線（波浪/氣泡/切角）圖形不規則，維持直接寫死路徑字串。
function _zigzagPath(w, h, teeth, topY, bottomY) {
  const toothW = w / teeth;
  let d = `M 0 ${bottomY} L 0 ${topY}`;
  for (let i = 0; i < teeth; i++) {
    const xMid = i * toothW + toothW / 2;
    const xEnd = (i + 1) * toothW;
    d += ` L ${xMid} ${topY - toothW * 0.42} L ${xEnd} ${topY}`;
  }
  d += ` L ${w} ${bottomY} Z`;
  return d;
}
function _flagsPath(w, h, count, topY, tipY) {
  const bandTop = topY - (tipY - topY) * 0.25;
  let d = `M 0 ${bandTop} L ${w} ${bandTop} L ${w} ${topY} L 0 ${topY} Z `;
  const fw = w / count;
  const triW = fw * 0.7;
  for (let i = 0; i < count; i++) {
    const xStart = i * fw + (fw - triW) / 2;
    const xEnd = xStart + triW;
    const xMid = (xStart + xEnd) / 2;
    d += `M ${xStart} ${topY} L ${xEnd} ${topY} L ${xMid} ${tipY} Z `;
  }
  return d;
}
function _scallopPath(w, h, count, baseY, radius) {
  const stepW = w / count;
  let d = `M 0 ${baseY}`;
  for (let i = 0; i < count; i++) {
    d += ` A ${stepW / 2} ${radius} 0 0 1 ${(i + 1) * stepW} ${baseY}`;
  }
  d += ` L ${w} ${h} L 0 ${h} Z`;
  return d;
}
function _stripesPath(w, h, count, thickness, offset) {
  const spacing = (w * 0.42) / count;
  let d = '';
  for (let i = 0; i < count; i++) {
    const x0 = w * 0.5 + offset + i * spacing;
    d += `M ${x0} ${h} L ${x0 + thickness} ${h} L ${x0 + thickness + h * 0.34} ${h * 0.42} L ${x0 + h * 0.34} ${h * 0.42} Z `;
  }
  return d;
}

function _addYangZhuVectorBackground(colors) {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  const cardRadius = w * (3.18 / 85.6);
  const c = colors || {};
  const bgColor = c.bg || '#ffffff';
  const waveColor = c.wave || '#2D7D46';
  const waveLightColor = c.waveLight || '#dfead8';
  const dotColor = c.dot || '#E7F1E3';
  const dotAltColor = c.dotAlt || '#d3e4cf';

  // 造型（形狀）跟顏色是兩條互相獨立的資料來源：顏色從呼叫端傳進來的 colors 參數
  // 決定，造型從 STATE.backgroundTemplateId 決定，兩者在這裡合流成實際要畫的
  // fabric.Path。找不到對應造型（例如舊草稿存的是改版前的模板id）就退回第一款，
  // 不會整個畫布壞掉。
  const shapeId = (typeof STATE !== 'undefined' && STATE.backgroundTemplateId) || CARD_MASK_SHAPES[0].id;
  const shape = CARD_MASK_SHAPES.find(s => s.id === shapeId) || CARD_MASK_SHAPES[0];
  const shapePaths = shape.build(w, h);

  const bg = new fabric.Rect({
    left: 0, top: 0, width: w, height: h,
    rx: cardRadius, ry: cardRadius,
    fill: bgColor,
    selectable: false, evented: false,
    name: 'template-bg'
  });

  // 「空白背板」造型的 main/light 是空字串：fabric.Path 不能吃空路徑字串，這裡
  // 直接跳過建立，連右下角那組裝飾圓點也一併跳過，才是真正乾淨的空白背板。
  const isBlank = !shapePaths.main && !shapePaths.light;

  const wave = isBlank ? null : new fabric.Path(shapePaths.main, {
    fill: waveColor,
    ...makeTemplateLayerOptions('template-wave')
  });

  const waveLight = isBlank ? null : new fabric.Path(shapePaths.light, {
    fill: waveLightColor,
    opacity: 0.9,
    ...makeTemplateLayerOptions('template-wave-light')
  });

  const dots = [];
  if (!isBlank) {
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 5; col++) {
        dots.push(new fabric.Circle({
          left: w * 0.82 + col * w * 0.036,
          top: h * 0.18 + row * h * 0.08,
          radius: Math.max(2, w * 0.008),
          fill: row % 2 === 0 ? dotColor : dotAltColor,
          selectable: false, evented: false,
          name: 'template-dot'
        }));
      }
    }
  }

  const layers = [bg, waveLight, wave, ...dots].filter(Boolean);
  canvas2d.add(...layers);
  // 新建立的向量背景整組排到畫布最底層（在既有的 card-shell-edge／title／
  // cartoon-avatar 等物件之下）：反向依序 sendToBack，維持組內 bg < waveLight <
  // wave < dots 的相對疊層順序
  [...layers].reverse().forEach(o => canvas2d.sendToBack(o));
}

// 楊竹卡片類商品共用底層模板（悠遊卡／一卡通共用同一份，都是 85.6×54mm 同尺寸卡片）：
// 帶圓角／邊緣高光／卡緣厚度暗邊的實體卡片視覺基底 + 波浪／圓點／Logo／示範標題副標
// 裝飾。刻意合併成單一函式而不是兩份幾乎一樣的程式碼各自維護——兩者除了 productId
// 不同之外，視覺與資料結構完全相同，分成兩份反而違反「不要建立第二套重複邏輯」。
function addYangZhuCardTemplate() {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  // 兩者實體尺寸皆為 85.6×54mm，真實圓角約 3.18mm（比照黑卡/ISO卡片圓角比例）
  const cardRadius = w * (3.18 / 85.6);

  // 邊緣高光：極淡描邊，勾勒卡片實體邊界，避免看起來像廉價玻璃感
  const edge = new fabric.Rect({
    left: 1, top: 1, width: w - 2, height: h - 2,
    rx: cardRadius, ry: cardRadius,
    fill: 'transparent',
    stroke: 'rgba(255,255,255,.85)',
    strokeWidth: 1.5,
    selectable: false, evented: false,
    name: 'card-shell-edge'
  });

  // 卡緣厚度暗邊：只在卡片下緣一小段窄帶用線性漸層做非常薄的暗化，multiply 疊入
  // 模擬實體卡片背光側的厚度感；強度比黑卡（0.30）更收斂，避免看起來像陰影髒污
  const edgeShadeGradient = new fabric.Gradient({
    type: 'linear',
    coords: { x1: 0, y1: 0, x2: 0, y2: h * 0.12 },
    colorStops: [
      { offset: 0, color: 'rgba(0,0,0,0)' },
      { offset: 1, color: 'rgba(0,0,0,0.12)' }
    ]
  });
  const edgeShade = new fabric.Rect({
    left: 0, top: h * 0.88, width: w, height: h * 0.12,
    fill: edgeShadeGradient,
    globalCompositeOperation: 'multiply',
    selectable: false, evented: false,
    name: 'card-shell-edge-shade'
  });

  canvas2d.add(edge, edgeShade);
  _addYangZhuVectorBackground();

  const titleSmall = new fabric.IText('專屬於你的', {
    left: w * 0.12, top: h * 0.36,
    fontSize: Math.round(h * 0.07),
    fontFamily: 'Noto Sans TC',
    fill: '#1f2933',
    name: 'title',
    editable: true
  });
  const titleMain = new fabric.IText('美好日常', {
    left: w * 0.12, top: h * 0.47,
    fontSize: Math.round(h * 0.115),
    fontFamily: 'Noto Sans TC',
    fontWeight: '700',
    fill: '#2D7D46',
    name: 'title',
    editable: true
  });
  const subtitle = new fabric.IText('', {
    left: w * 0.12, top: h * 0.62,
    fontSize: Math.round(h * 0.04),
    fontFamily: 'Noto Sans TC',
    fill: '#485548',
    name: 'subtitle',
    editable: true
  });
  canvas2d.add(titleSmall, titleMain, subtitle);
  canvas2d.renderAll();
}

// ─── 保溫杯：示範藝術簽名 ───────────────────────────────────
// 只在「這個分頁第一次進入保溫杯的全新空白草稿」時建立一次，標記獨立存在 sessionStorage
// （而不是寫進 STATE／草稿本身），所以草稿被清除（清空重來／清除草稿）之後即使 STATE 被
// 整個重設，這個標記依然存在，不會被誤判成「全新空白草稿」而又自動加回——sessionStorage
// 天生跟著分頁（跟 draftId 同一套隔離機制），不同分頁互不影響，分頁關閉後才會重置。
//
// 舊版這裡帶入的是主標題／副標題／示範Logo三個圖層，但「文字與版面」跟「上傳Logo/圖片」
// 這兩個編輯入口後來都對保溫杯隱藏了（客人的文字需求全部改走「藝術簽名」），舊示範內容
// 變成客人看得到、改不到的殘留物。改成直接帶入一個示範簽名，套用 applyThermosSignature()
// 的預設大小/位置（60、印刷區右下角），客人一進畫面就知道「這裡可以改」，也是實際套用
// 簽名時會拿到的同一組預設值，不是另外發明一套只在示範時出現的版面。
// 示範簽名文字：跟 configurator.js 的 isDesignStillDemoPlaceholder() 共用同一個常數，
// 客人沒把這個文字改掉之前，一律視為仍是示範狀態（見該函式內的保溫杯分支）。
const THERMOS_DEMO_SIGNATURE_TEXT = '請填中文或英文簽名';

function _thermosDemoSeededKey() {
  const draftId = (typeof getTabDraftId === 'function') ? getTabDraftId() : 'default';
  return `customizer:thermosDemoSeeded:${draftId}`;
}
function _thermosDemoAlreadySeeded() {
  try { return sessionStorage.getItem(_thermosDemoSeededKey()) === '1'; } catch (e) { return false; }
}
function _markThermosDemoSeeded() {
  try { sessionStorage.setItem(_thermosDemoSeededKey(), '1'); } catch (e) { /* 存不進去就算了，最多下次又出現一次示範圖層 */ }
}

function addThermosDemoLayers() {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  const sizePct = 60;
  const font = (typeof SIGNATURE_FONTS !== 'undefined' && SIGNATURE_FONTS[0]) ? SIGNATURE_FONTS[0].id : undefined;

  const sig = new fabric.Text(THERMOS_DEMO_SIGNATURE_TEXT, {
    name: 'thermos-signature',
    fontFamily: font,
    fontSize: Math.max(10, w * (sizePct / 1000)),
    left: w * 0.40, top: h / 2, // 跟 applyThermosSignature() 的預設位置公式保持一致，見該處註解
    originX: 'center', originY: 'center',
    angle: 0,
    fill: '#333333',
    selectable: true, evented: true
  });
  sig._signatureSizePct = sizePct;

  canvas2d.add(sig);
  canvas2d.renderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

// 尊爵不凡黑卡：全黑質感底層模板（漸層黑灰 + 極低透明度雜訊紋理 + 邊緣高光）
// 物件命名刻意避開 'template-bg' / 'template-wave' 等既有品牌模板用名，
// 避免被 applyCardBackgroundTemplate2D()（彩色模板配色用）誤抓改色。
function addBlackCardTemplate() {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();

  const bg = new fabric.Rect({
    left: 0, top: 0, width: w, height: h,
    selectable: false, evented: false,
    name: 'black-card-bg'
  });
  const gradient = new fabric.Gradient({
    type: 'linear',
    coords: { x1: 0, y1: 0, x2: w, y2: h },
    colorStops: [
      { offset: 0,   color: '#050505' },
      { offset: 0.5, color: '#232323' },
      { offset: 1,   color: '#050505' }
    ]
  });
  bg.set('fill', gradient);

  // 雜訊紋理：離屏 canvas 隨機亮/暗點混合，模擬霧面磨砂的細緻顆粒感。
  // 貼磚尺寸拉大、點數降低、單點放大並柔化邊緣，避免銳利孤立小點看起來像
  // 雪花/JPEG雜訊；暗點刻意比亮點少很多，霧面顆粒應以微亮為主、深色僅點綴。
  const noiseSize = 140;
  const noiseCanvas = document.createElement('canvas');
  noiseCanvas.width = noiseSize;
  noiseCanvas.height = noiseSize;
  const nctx = noiseCanvas.getContext('2d');
  for (let i = 0; i < 260; i++) {
    nctx.fillStyle = `rgba(255,255,255,${(0.03 + Math.random() * 0.06).toFixed(3)})`;
    nctx.fillRect(Math.random() * noiseSize, Math.random() * noiseSize, 1.4, 1.4);
  }
  for (let i = 0; i < 90; i++) {
    nctx.fillStyle = `rgba(0,0,0,${(0.04 + Math.random() * 0.06).toFixed(3)})`;
    nctx.fillRect(Math.random() * noiseSize, Math.random() * noiseSize, 1.4, 1.4);
  }
  // 柔化顆粒硬邊：不能對 canvas 用 drawImage 畫自己（結果未定義），
  // 透過第二張暫存 canvas 套一次輕微模糊濾鏡再轉繪回來
  const noiseBlurCanvas = document.createElement('canvas');
  noiseBlurCanvas.width = noiseSize;
  noiseBlurCanvas.height = noiseSize;
  const nbctx = noiseBlurCanvas.getContext('2d');
  nbctx.filter = 'blur(0.6px)';
  nbctx.drawImage(noiseCanvas, 0, 0);
  const noise = new fabric.Rect({
    left: 0, top: 0, width: w, height: h,
    fill: new fabric.Pattern({ source: noiseBlurCanvas, repeat: 'repeat' }),
    opacity: 0.52,
    selectable: false, evented: false,
    name: 'black-card-noise'
  });

  const edge = new fabric.Rect({
    left: 1, top: 1, width: w - 2, height: h - 2,
    fill: 'transparent',
    stroke: 'rgba(255,255,255,.26)',
    strokeWidth: 1.5,
    selectable: false, evented: false,
    name: 'black-card-edge'
  });

  // 卡緣厚度暗邊：只在卡片下緣一小段窄帶用線性漸層做「非常薄」的暗化，
  // multiply 疊入模擬實體卡片背光側的厚度感，不是描邊、不會變成粗框。
  const edgeShadeGradient = new fabric.Gradient({
    type: 'linear',
    coords: { x1: 0, y1: 0, x2: 0, y2: h * 0.12 },
    colorStops: [
      { offset: 0, color: 'rgba(0,0,0,0)' },
      { offset: 1, color: 'rgba(0,0,0,0.30)' }
    ]
  });
  const edgeShade = new fabric.Rect({
    left: 0, top: h * 0.88, width: w, height: h * 0.12,
    fill: edgeShadeGradient,
    globalCompositeOperation: 'multiply',
    selectable: false, evented: false,
    name: 'black-card-edge-shade'
  });

  // 卡面刻意不放預設文字／Logo，保持乾淨的霧黑磨砂底；
  // 提示文字改放在畫布下方說明（見 configurator.js 的 canvasNote）。
  canvas2d.add(bg, noise, edge, edgeShade);
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
  // addText2D() 因為要先等字型載入完成（document.fonts.load()...then）才會走到這裡，
  // 呼叫端 applyDesignText() 呼叫完 addText2D() 之後的同步保存（syncDesignState()）
  // 有可能早於這一行執行——也就是文字其實還沒真的加進畫布，那次保存排到的還是舊快照。
  // 這裡文字「真正」加進畫布之後才是這次套用的完成時間點，一定要在這裡再同步/排一次
  // 保存，才能保證保存到的內容包含剛剛這個文字物件，不能只靠呼叫端那次搶跑的保存。
  if (typeof syncDesignState === 'function') syncDesignState();
  return t;
}

// ─── 印刷區感知的置中/縮放計算 ──────────────────────────────
// 有 labelArea 的產品（USB、保溫杯等）：座標與縮放都以印刷區為基準；沒有則以整個 canvas 為基準
// coverMode=true 為「填滿裁切」（AI生圖背景用）；false 為「完整包含不裁切」（一般上傳用）
function getFillPlacement(img, coverMode) {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  let areaLeft = 0, areaTop = 0, areaW = w, areaH = h;
  if (currentProduct && currentProduct.labelArea) {
    const la = currentProduct.labelArea;
    areaLeft = w * la.xRatio; areaTop = h * la.yRatio;
    areaW    = w * la.wRatio; areaH   = h * la.hRatio;
  }
  const ratioFn = coverMode ? Math.max : Math.min;
  const scale = ratioFn(areaW / img.width, areaH / img.height);
  return { left: areaLeft + areaW / 2, top: areaTop + areaH / 2, scale, areaLeft, areaTop, areaW, areaH };
}

// 保溫杯：滿版鋪滿選取圖片。沿用既有 getFillPlacement(img, true)（填滿裁切模式），
// 圖片會覆蓋整個印刷稿（此時 labelArea 涵蓋全畫布），超出範圍的部分交給
// _applyCardShellClipPath() 已套用的矩形 clipPath 裁掉，不需要另外寫裁切邏輯。
function fillCanvasWithSelectedImage() {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (!obj || obj.type !== 'image') {
    // 正常操作路徑按鈕已依 _updateThermosFullBleedBtnState() 停用，走不到這裡；
    // 純屬防禦性檢查，一旦真的觸發改用 Toast，不用會卡住整個分頁的 alert()。
    if (typeof _showConfiguratorToast === 'function') _showConfiguratorToast('請先在圖層清單選取一張已上傳的圖片');
    return;
  }
  const place = getFillPlacement(obj, true);
  obj.set({
    left: place.left, top: place.top,
    originX: 'center', originY: 'center',
    scaleX: place.scale, scaleY: place.scale
  });
  keepAboveProductBg(obj);
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

// 確保「背景型」內容物件維持在 product-bg／template-bg 之上（避免被外觀底圖或卡面背景整個蓋住）
function keepAboveProductBg(img) {
  canvas2d.sendToBack(img);
  const bgName = (currentProduct && currentProduct.bgImage) ? 'product-bg' : 'template-bg';
  const bg = canvas2d.getObjects().find(o => o.name === bgName);
  if (bg) canvas2d.sendToBack(bg);
}

// ─── 悠遊卡／一卡通：「AI 生成背景」（POST /api/generate-image，2026-08-24 新增） ──────
// 只在 easycard／ipass 顯示（見 configurator.js initDesignStep() 的 isCardShell 判斷）；
// 保溫杯目前生成尺寸／提示詞是卡片比例，不適用；黑卡繼續用原本獨立的「主圖案」功能，
// 兩者互不影響、程式也完全分開，不共用任何函式或DOM id。
// 流程：輸入背景描述 → 生成 → 先只顯示預覽（不寫入畫布）→ 客戶按「套用到卡面」才真的
// 加入 Fabric Canvas，且再次套用會整個換掉舊的 AI 背景，不會一直堆疊。
let lastAiBackgroundImageDataURL = null;
let aiBackgroundGenerating       = false; // 防止同一顆按鈕在請求進行中被重複點擊送出
let _aiBackgroundAbortController = null;  // 切換商品/重新配置、或離開設計頁時用來中止尚未完成的請求

// 商品切換／離開設計頁時呼叫：中止還在進行中的請求，並清掉尚未套用的預覽圖，避免
// 舊商品（或舊描述）的回應在使用者已經離開之後才回來、被誤套到新的商品或畫面上。
function abortAiBackgroundGeneration() {
  if (_aiBackgroundAbortController) {
    _aiBackgroundAbortController.abort();
    _aiBackgroundAbortController = null;
  }
  aiBackgroundGenerating = false;
  lastAiBackgroundImageDataURL = null;
  const previewEl = document.getElementById('ai-bg-preview');
  if (previewEl) previewEl.classList.add('hidden');
  const applyBtn = document.getElementById('ai-bg-apply-btn');
  if (applyBtn) applyBtn.classList.add('hidden');
  const applyHintEl = document.getElementById('ai-bg-apply-hint');
  if (applyHintEl) applyHintEl.classList.add('hidden');
  const errEl = document.getElementById('ai-bg-error');
  if (errEl) errEl.classList.add('hidden');
}

// 從設計頁初始化時呼叫：只還原文字描述輸入框（跟 initBlackCardPatternPanel() 還原
// blackCardPrompt 同一套慣例），預覽圖／已套用狀態不特別還原——已經套用成功的 AI 背景
// 是畫布上的實體物件，會隨 canvasJSON 一起還原，不需要另外记錄；還沒套用的預覽圖
// 本來就只是「這次還沒按套用」的暫存內容，跟黑卡候選圖不同，不需要保存。
function initAiBackgroundPanel() {
  const promptInput = document.getElementById('ai-bg-prompt');
  if (promptInput) promptInput.value = STATE.aiBackgroundPrompt || '';
}

function setAiBackgroundLoading(on) {
  const btn  = document.getElementById('ai-bg-btn');
  const text = document.getElementById('ai-bg-btn-text');
  const load = document.getElementById('ai-bg-btn-loading');
  if (!btn) return;
  btn.disabled = on;
  text?.classList.toggle('hidden', on);
  load?.classList.toggle('hidden', !on);
}

// 跟 _blackCardFriendlyError() 同樣的錯誤分類邏輯（file://、前端逾時、網路中斷、
// 伺服器回應的 HTTP 狀態訊息），但訊息文字獨立維護，不直接呼叫黑卡那支——兩者
// 目前文字剛好幾乎一樣，但刻意不共用同一支函式，避免未來其中一邊調整文案時，
// 誤以為兩個完全不同的功能是綁在一起的。
function _aiBackgroundFriendlyError(err) {
  if (location.protocol === 'file:') {
    return '目前是以檔案模式開啟，AI 生成背景需要透過網站伺服器開啟才能使用，請改用瀏覽器開啟正式網站網址。';
  }
  if (err._clientTimeout) {
    return '請求逾時，AI 服務可能忙碌或網路不穩定，請稍後再試一次。';
  }
  if (err.name === 'TypeError' || /Failed to fetch/i.test(err.message || '')) {
    return '無法連線到 AI 服務，請確認網路連線正常後再試一次；若持續發生，請聯繫客服協助處理。';
  }
  if (err.status) {
    return err.message || `發生錯誤（狀態碼 ${err.status}），請稍後再試`;
  }
  return err.message || '發生未預期的錯誤，請稍後再試';
}

async function generateAiBackgroundImage() {
  if (aiBackgroundGenerating) return; // 請求進行中，從按鈕按下當下就已鎖定，不可重複送出

  const errEl = document.getElementById('ai-bg-error');
  const applyHintEl = document.getElementById('ai-bg-apply-hint');
  const previewEl = document.getElementById('ai-bg-preview');
  if (errEl) errEl.classList.add('hidden');
  if (applyHintEl) applyHintEl.classList.add('hidden');

  const input  = document.getElementById('ai-bg-prompt');
  const prompt = (input?.value || '').trim();
  if (prompt.length < 2 || prompt.length > 200) {
    if (errEl) { errEl.textContent = '請輸入 2～200 字的背景描述'; errEl.classList.remove('hidden'); }
    return;
  }
  STATE.aiBackgroundPrompt = prompt;

  aiBackgroundGenerating = true;
  setAiBackgroundLoading(true);
  // 這次重新生成期間，先把上一次的預覽／套用按鈕都收起來，避免「套用」按鈕還亮著、
  // 但畫面上其實已經看不到對應的預覽圖」這種狀態不一致；lastAiBackgroundImageDataURL
  // 也要同步清空，這次生成失敗的話就整個回到「尚未產生預覽」的乾淨狀態，不留半套。
  lastAiBackgroundImageDataURL = null;
  if (previewEl) previewEl.classList.add('hidden');
  const applyBtnAtStart = document.getElementById('ai-bg-apply-btn');
  if (applyBtnAtStart) applyBtnAtStart.classList.add('hidden');

  // 實測正式呼叫耗時可能落在 30～60 秒，等超過原本文案上限還沒完成時額外提示，
  // 避免畫面長時間停在同一句話讓人以為卡住了（跟黑卡圖案同一套做法）。
  const loadingTextEl = document.getElementById('ai-bg-btn-loading');
  const extendedWaitTimer = setTimeout(() => {
    if (loadingTextEl) loadingTextEl.textContent = '還在生成中，AI 繪圖有時較久，請再耐心等候一下……';
  }, 40000);

  const thisRequestProductId = STATE.productId; // 回應回來時用來判斷是否已經切換商品
  _aiBackgroundAbortController = new AbortController();

  // 前端最後一道逾時保險（後端本身沒有像黑卡/Q版那樣內建 45 秒逾時，正式測過單次
  // 請求約 53 秒屬正常範圍，這裡故意抓比實測更寬裕的 90 秒，避免把正常回應誤判逾時）。
  const CLIENT_TIMEOUT_MS = 90000;
  let _clientTimedOut = false;
  const clientTimeoutTimer = setTimeout(() => {
    _clientTimedOut = true;
    _aiBackgroundAbortController.abort();
  }, CLIENT_TIMEOUT_MS);

  const _aiBackgroundAnalyticsContext = (typeof _getAnalyticsContextForRequest === 'function') ? _getAnalyticsContextForRequest() : null;

  try {
    const resp = await fetch('/api/generate-image', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        prompt,
        productName: (currentProduct && currentProduct.name) || thisRequestProductId,
        productId:   thisRequestProductId,
        ...( _aiBackgroundAnalyticsContext ? { analyticsContext: _aiBackgroundAnalyticsContext } : {} )
      }),
      signal:  _aiBackgroundAbortController.signal
    });
    clearTimeout(clientTimeoutTimer);
    // 使用者可能在等待期間已經切換到別的商品，這種情況直接忽略回應，不寫進現在
    // 其實已經是別的商品的畫面／狀態裡。
    if (STATE.productId !== thisRequestProductId) return;

    const data = await resp.json();
    if (!resp.ok) {
      const err = new Error(data.error || '生成失敗');
      err.status = resp.status;
      throw err;
    }
    // 只接受 success=true 且具有合法圖片內容的結果，空值或格式錯誤一律當失敗處理，
    // 不能讓客戶以為已經生成、實際卻是空白或損壞的內容。
    if (!data.success || !data.imageDataURL || data.imageDataURL.length < 100) {
      throw new Error('AI 沒有回傳有效的圖片，請調整描述後再試一次');
    }

    // decode 期間（非同步）使用者也可能已經切換商品，寫入前的最後一道防線
    const img = await loadImageEl(data.imageDataURL);
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('AI 回傳的圖片無法正常載入，請再試一次');
    if (STATE.productId !== thisRequestProductId) return;

    lastAiBackgroundImageDataURL = data.imageDataURL;
    if (previewEl) {
      previewEl.innerHTML = `<img src="${data.imageDataURL}" alt="AI 生成的背景預覽" style="width:100%;border-radius:8px;margin-top:10px;display:block;">`;
      previewEl.classList.remove('hidden');
    }
    const applyBtn = document.getElementById('ai-bg-apply-btn');
    if (applyBtn) applyBtn.classList.remove('hidden');

  } catch (err) {
    clearTimeout(clientTimeoutTimer);
    // AbortError 兩種成因分開處理：使用者主動切換商品／離開設計頁＝不是錯誤，靜默返回；
    // 前端自己的逾時保護觸發＝要讓使用者知道的錯誤，不能被靜默吞掉。
    if (err.name === 'AbortError') {
      if (!_clientTimedOut) return;
      err._clientTimeout = true;
    }
    if (errEl) {
      errEl.innerHTML = '';
      const msgSpan = document.createElement('span');
      msgSpan.textContent = _aiBackgroundFriendlyError(err);
      errEl.appendChild(msgSpan);
      const retryWrap = document.createElement('div');
      retryWrap.className = 'ai-error-actions';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-outline btn-sm';
      retryBtn.textContent = '重新嘗試';
      retryBtn.onclick = generateAiBackgroundImage;
      retryWrap.appendChild(retryBtn);
      errEl.appendChild(retryWrap);
      errEl.classList.remove('hidden');
    }
  } finally {
    clearTimeout(clientTimeoutTimer);
    clearTimeout(extendedWaitTimer);
    if (loadingTextEl) loadingTextEl.textContent = '生成中（約30～60秒）…';
    aiBackgroundGenerating = false;
    setAiBackgroundLoading(false);
  }
}

// 套用到卡面：cover（填滿裁切）鋪滿整個印刷區，沿用 getFillPlacement(img, true) 與
// keepAboveProductBg()——跟 fillCanvasWithSelectedImage() 完全同一套算法與疊層規則，
// 圖層維持在文字／Logo／照片等客製內容下方，也維持在 product-bg／template-bg 之上；
// easycard／ipass 已有 canvas 級 clipPath（_applyCardShellClipPath()）處理圓角裁切，
// 不需要再另外設定物件級 clipPath。再次套用時先移除舊的 AI 背景物件，不會一直堆疊。
function applyAiBackgroundImage() {
  if (!lastAiBackgroundImageDataURL || !canvas2d) return;
  fabric.Image.fromURL(lastAiBackgroundImageDataURL, img => {
    canvas2d.getObjects().filter(o => o.name === 'ai-generate-background').forEach(o => canvas2d.remove(o));

    const place = getFillPlacement(img, true);
    img.set({
      left: place.left, top: place.top,
      originX: 'center', originY: 'center',
      scaleX: place.scale, scaleY: place.scale,
      selectable: true, evented: true,
      name: 'ai-generate-background'
    });
    canvas2d.add(img);
    keepAboveProductBg(img);
    canvas2d.requestRenderAll();

    if (typeof STATE !== 'undefined') {
      STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : STATE.designDataURL;
      STATE.canvasJSON = (typeof getCanvas2DJSON === 'function') ? getCanvas2DJSON() : STATE.canvasJSON;
    }
    if (typeof syncDesignState === 'function') syncDesignState();

    const applyHintEl = document.getElementById('ai-bg-apply-hint');
    if (applyHintEl) applyHintEl.classList.remove('hidden');
  });
}

// ─── 黑卡：上傳圖片轉黑色調效果 ──────────────────────────
// 把圖片轉成「黑色調剪影」：色值統一改為接近純黑，保留原始透明度（PNG 去背圖直接可用）。
// 若原圖沒有透明背景（一般 JPG），以亮度粗略去背（近白視為背景）作為 fallback。

// 抽樣判斷透明像素比例：只有「明顯比例」樣本透明，才視為圖片本身已是乾淨去背圖，
// 避免一般照片邊緣抗鋸齒造成的極少數半透明像素被誤判成「已去背」。
function _alphaCoverageRatio(px) {
  let transparentSamples = 0, totalSamples = 0;
  for (let i = 3; i < px.length; i += 4 * 37) {
    totalSamples++;
    if (px[i] < 200) transparentSamples++;
  }
  return totalSamples > 0 ? transparentSamples / totalSamples : 0;
}

// 判斷圖片是否已經是乾淨去背圖案（Logo／已去背圖）：符合的話可跳過 Q版化直接黑化
function imageHasCleanCutout(imgEl) {
  const w = imgEl.naturalWidth || imgEl.width;
  const h = imgEl.naturalHeight || imgEl.height;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const ctx = off.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  return _alphaCoverageRatio(px) >= 0.08;
}

function loadImageEl(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.src = dataURL;
  });
}

function _toBlackSilhouetteCanvas(imgEl) {
  const w = imgEl.naturalWidth || imgEl.width;
  const h = imgEl.naturalHeight || imgEl.height;
  const off = document.createElement('canvas');
  off.width = w; off.height = h;
  const ctx = off.getContext('2d');
  ctx.drawImage(imgEl, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;

  const hasAlpha = _alphaCoverageRatio(px) >= 0.08;

  // 保留原始明暗層次（而非整張壓成同一個近黑值），讓線稿的眼睛/嘴巴/耳朵輪廓
  // 跟臉頰/身體的填色之間仍有明暗差異，黑化後才看得出五官，不會變成一團純黑剪影。
  const toneMin = 8;    // 最深的線條／陰影
  const toneMax = 112;  // 最亮的填色區，拉高一些讓圖案在黑卡上更容易被看清楚，但仍偏黑維持黑上黑質感

  for (let i = 0; i < px.length; i += 4) {
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (hasAlpha) {
      px[i] = px[i + 1] = px[i + 2] = Math.round(toneMin + (lum / 255) * (toneMax - toneMin)); // 保留原始 alpha
    } else {
      if (lum > 235) {
        px[i + 3] = 0; // 近白視為背景，去背
      } else {
        px[i] = px[i + 1] = px[i + 2] = Math.round(toneMin + (lum / 255) * (toneMax - toneMin));
        px[i + 3] = 255;
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
  return off;
}

// 浮雕邊緣遮罩：畫一份「位移後的剪影」，再用 destination-out 把原始剪影範圍整個挖空，
// 只留下位移後多出來的那一圈邊緣弧形。這樣亮部/暗部層才是真正的「邊緣高光/陰影」，
// 而不是把整張剪影都疊亮/疊暗——後者會讓圖案主體整片發白，變成銀色貼圖的視覺。
function _embossRimCanvas(silhouette, dx, dy) {
  const w = silhouette.width, h = silhouette.height;
  const rim = document.createElement('canvas');
  rim.width = w; rim.height = h;
  const rctx = rim.getContext('2d');
  rctx.drawImage(silhouette, dx, dy);
  rctx.globalCompositeOperation = 'destination-out';
  rctx.drawImage(silhouette, 0, 0);
  return rim;
}

// 五種工藝的壓印參數。所有工藝都用同一套「三層壓印」結構（暗部凹陷陰影／亮黑高光邊／
// 深黑但不死黑的主體層），差別只在偏移深度與亮部強度——這樣每種工藝都是真的靠光影/浮雕
// 邊緣讓圖案被看見，不會變成「一塊黑色圖片直接蓋在黑卡上」。
// depthRatio 用圖片較短邊的比例計算偏移量（避免縮小後偏移量小到看不出差異）。
//
// 5種工藝的實際數值由 js/black-card-finish.js 的 blackCardCanvasParams() 統一提供
// （跟 Step4 成品預覽共用同一份物理描述來源，兩邊材質感受才會同步變化）。

// 依黑卡印刷效果（亮黑／霧黑／浮雕淺中深）把黑色剪影組成「三層壓印」的 fabric 群組。
// 統一透過 globalCompositeOperation 讓圖案跟底下的黑卡漸層/雜訊紋理互相疊色，
// 呈現「壓印在材質裡」的觸感，而不是一張圖片乾淨地貼在卡面最上層。
// effectId 可以是既有 5 種工藝的字串鍵值，也可以直接傳一組自訂參數物件
// （例如滿版元素的「浮雕強度」滑桿需要 1~10 的連續值，不是離散的 5 檔）。
function applyBlackEffectToImage(imgEl, effectId) {
  const silhouette = _toBlackSilhouetteCanvas(imgEl);
  const p = (effectId && typeof effectId === 'object') ? effectId : blackCardCanvasParams(effectId);
  const depth = Math.max(2, Math.round(Math.min(silhouette.width, silhouette.height) * p.depthRatio));

  // 暗部凹陷陰影：只取右下「邊緣弧形」（不是整張剪影往右下移），transparent黑、multiply 疊入，
  // 做出「往下凹」的暗邊，主體內部不會被額外壓暗
  const shadowRim = _embossRimCanvas(silhouette, depth, depth);
  const shadowLayer = new fabric.Image(shadowRim, { opacity: p.shadowOpa });
  shadowLayer.filters = [new fabric.Image.filters.BlendColor({ color: '#000000', mode: 'tint', alpha: 0.8 })];
  shadowLayer.applyFilters();
  shadowLayer.globalCompositeOperation = 'multiply';

  // 亮黑高光邊：只取左上「邊緣弧形」，半透明灰白、screen 疊上——只有邊緣會反光，
  // 圖案主體不會整片發白（那樣會變成銀色/白色貼圖，不是黑上黑壓印）
  const hiliteRim = _embossRimCanvas(silhouette, -depth, -depth);
  const hiliteLayer = new fabric.Image(hiliteRim, { opacity: p.hiliteOpa });
  hiliteLayer.filters = [new fabric.Image.filters.BlendColor({ color: '#f2f2f2', mode: 'tint', alpha: 0.9 })];
  hiliteLayer.applyFilters();
  hiliteLayer.globalCompositeOperation = 'screen';

  // 主體壓印層：疊色融入卡面，深黑但不死黑，維持圖案輪廓清晰。
  // 'overlay' 對「幾乎全黑」的底色會把疊色壓到接近看不見（overlay 在底色極暗時結果趨近底色本身），
  // AI 人像通常置中在底色漸層較亮的區域所以沒事，但滿版元素要蓋滿整張卡面（含底色漸層最暗的四角），
  // 這裡才會出現「紋理只在漸層較亮的那一段看得到、角落像消失」的狀況——因此滿版元素改用
  // 'screen'（不受底色暗部拖累，任何底色亮度都能疊出穩定可見的效果），維持整張卡面均勻可見。
  const baseLayer = new fabric.Image(silhouette, { opacity: p.baseOpacity });
  baseLayer.globalCompositeOperation = p.baseBlend || 'overlay';

  const layers = [shadowLayer, hiliteLayer, baseLayer];

  if (effectId === 'gloss_black' || !effectId) {
    // 亮黑額外加一小塊高對比反光，模擬鏡面光澤的局部反光點
    const highlight = new fabric.Ellipse({
      rx: silhouette.width * 0.1, ry: silhouette.height * 0.06,
      left: silhouette.width * 0.3, top: silhouette.height * 0.24,
      originX: 'center', originY: 'center',
      fill: 'rgba(255,255,255,.9)', opacity: 0.4,
      selectable: false, evented: false
    });
    highlight.globalCompositeOperation = 'screen';
    layers.push(highlight);
  }

  return new fabric.Group(layers, { name: 'black-effect-image' });
}

// 黑卡：套用效果後的圖案置中，依卡片高度比例縮放（放大到接近主視覺的比例），
// 並限制最大寬度比例，避免長寬比極端的圖片橫向超出卡面太多。
function placeBlackCardEffectObject(obj) {
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  const targetHeightRatio = 0.60;
  const maxWidthRatio = 0.85;

  let scale = (h * targetHeightRatio) / obj.height;
  if (obj.width * scale > w * maxWidthRatio) {
    scale = (w * maxWidthRatio) / obj.width;
  }

  obj.set({
    left: w / 2, top: h / 2,
    originX: 'center', originY: 'center',
    scaleX: scale, scaleY: scale
  });
  // 縮放滑桿的 100% 基準：原始 AI 圖片解析度很高，直接用 Fabric 的 scaleX（相對於
  // 原始像素）當滑桿數值，剛套用就會顯示成 12%～15% 這種違反直覺的數字。改記錄
  // 這個「預設自動置入時的縮放值」為基準，滑桿的 100% 永遠對應「剛套用時的大小」，
  // 使用者拖曳滑桿時感受到的才是「相對於預設大小再放大/縮小」，符合直覺。
  obj.baseScale = scale;
}

// ─── 黑卡：滿版元素圖案 ──────────────────────────────────────
// 6 種紋理都用同一支 2D canvas 產生器畫出「黑色線條/點陣在透明背景上」，再送進跟
// AI 人像同一套 applyBlackEffectToImage() 壓印流程，維持一致的黑上黑浮雕質感，
// 不是另外疊一塊顏色/透明度不同調的圖層。
// 2026-08-19：客戶挑選用的清單改成新一批16款高級感設計（見「黑卡滿版紋理候選設計」
// 資料夾）。原本 zigzag/lines/dots/grid/circuit 這5款的繪圖邏輯刻意保留在
// _drawFullBleedPatternOnCanvas() 裡完全不動，只是從這份「客戶看得到的清單」拿掉——
// 之後如果新款不合適，把對應那行加回這個陣列就能立刻復原，不用重新設計或改繪圖程式碼。
const FULL_BLEED_PATTERN_OPTIONS = [
  { id: 'marble',          name: '大理石紋' },
  { id: 'mountains',       name: '山脈剪影' },
  { id: 'honeycomb2',      name: '蜂巢六角' },
  { id: 'feather',         name: '羽毛紋' },
  { id: 'ripples',         name: '波光漣漪' },
  { id: 'constellation',   name: '星座連線' },
  { id: 'silk',            name: '絲綢皺褶' },
  { id: 'facets',          name: '鑽石切割面' },
  { id: 'greekkey',        name: '羅馬回紋' },
  { id: 'woodgrain',       name: '年輪木紋' },
  { id: 'premiumdots',     name: '圓點網格' },
  { id: 'premiumtriangle', name: '三角網格' },
  { id: 'premiumhex',      name: '六角網格' },
  { id: 'herringbone',     name: '人字紋' },
  { id: 'stripes2',        name: '直線壓紋' },
  { id: 'squaregrid',      name: '方格網' },
  { id: 'custom',          name: '自訂上傳圖案' }
];

// 舊版5款（zigzag/lines/dots/grid/circuit）復原用：想恢復時把這幾行貼回上面的
// FULL_BLEED_PATTERN_OPTIONS 陣列即可，繪圖邏輯本來就還在 _drawFullBleedPatternOnCanvas()。
// { id: 'zigzag',  name: '幾何折線' },
// { id: 'lines',   name: '平行細線' },
// { id: 'dots',    name: '點陣' },
// { id: 'grid',    name: '菱格網格' },
// { id: 'circuit', name: '科技電路紋' },

let _fullBleedCustomImg = null; // 使用者上傳的自訂滿版圖案來源（僅 'custom' 類型使用）

// 滿版紋理方向性反光：固定一個「假想光源角度」（跟 applyBlackEffectToImage 內
// _embossRimCanvas 高光邊 -depth,-depth 的左上光源方向一致，整張卡面光源方向統一），
// 線條角度越接近這個方向（或其180度對稱方向，線條本身沒有正反面之分）alpha 越高、
// 反光感越強。只能調 alpha、不能調顏色——純黑色線條送進 _toBlackSilhouetteCanvas 的
// 亮度公式後 RGB 一律被壓成同一個 toneMin，只有 alpha 通道會被保留、真正影響最終
// 合成深淺（已直接讀原始碼確認）。
// -25 度刻意避開 0°/45°/90°/135° 這些紋理常用角度的對稱中點（例如 -45 度剛好是
// 0 度跟 90 度的正中間，會讓科技電路紋的水平/垂直線算出同一個 alpha，反而看不出
// 方向性差異；-25 度對這裡用到的所有角度組合都能算出有意義的深淺差異）。
const FULLBLEED_LIGHT_ANGLE = -25; // 度
function _dirAlpha(lineAngleDeg, baseAlpha) {
  const rad = (lineAngleDeg - FULLBLEED_LIGHT_ANGLE) * Math.PI / 180;
  // Math.abs(cos) 天然滿足「線條180度對稱視覺相同」，角度對齊光源方向時 factor=1，
  // 垂直於光源方向時 factor 降到下限，不會整條線消失不見。
  const factor = 0.4 + 0.6 * Math.abs(Math.cos(rad));
  return Math.max(0, Math.min(1, baseAlpha * factor));
}

// 這16款新設計右下角統一留一塊直角三角形空白，給黑卡「藝術簽名」使用——避免簽名文字
// 疊在密集紋理線條上看不清楚。三角形頂點跟使用者截圖框選的位置一致（直角頂點在卡片
// 右下角）。舊版5款是全版鋪滿沒有這個限制，不放進這個清單。
const SIGNATURE_RESERVED_FULLBLEED_TYPES = new Set([
  'marble', 'mountains', 'honeycomb2', 'feather', 'ripples', 'constellation',
  'silk', 'facets', 'greekkey', 'woodgrain',
  'premiumdots', 'premiumtriangle', 'premiumhex', 'herringbone', 'stripes2', 'squaregrid'
]);

function _drawFullBleedPatternOnCanvas(canvasEl, type, opts) {
  const density   = opts.density   || 5; // 1~10，越高間距越小、紋理越密
  const thickness = opts.thickness || 4; // 1~10，線條/點的粗細
  // renderScale：canvasEl 實際像素尺寸可以是「邏輯尺寸」的倍數（例如2倍緩衝），
  // 讓縮放到180%時底層像素密度仍夠用不糊。畫圖邏輯全部維持用 w,h（邏輯尺寸）
  // 計算，一開始用 ctx.scale() 把倍數吃掉，其餘程式碼完全不用改。
  const renderScale = opts.renderScale || 1;
  const ctx = canvasEl.getContext('2d');
  ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  ctx.save();
  ctx.scale(renderScale, renderScale);
  const w = canvasEl.width / renderScale, h = canvasEl.height / renderScale;

  const spacing = Math.max(6, (11 - density) * (Math.min(w, h) / 42));
  const lineW = Math.max(0.6, thickness * (Math.min(w, h) / 480));
  const baseAlpha = 0.85;
  ctx.strokeStyle = '#000';
  ctx.fillStyle = '#000';
  ctx.lineWidth = lineW;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const reserveCorner = SIGNATURE_RESERVED_FULLBLEED_TYPES.has(type);
  if (reserveCorner) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.moveTo(w * 0.28, h);
    ctx.lineTo(w, h);
    ctx.lineTo(w, h * 0.63);
    ctx.closePath();
    ctx.clip('evenodd');
  }

  if (type === 'lines') {
    // 平行細線：固定 30 度斜角，卡片質感常見的滿版壓線效果。
    // 整條紋理只有單一方向，alpha 只需算一次。
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(-30, baseAlpha).toFixed(3)})`;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(-30 * Math.PI / 180);
    const diag = Math.sqrt(w * w + h * h);
    for (let y = -diag / 2; y < diag / 2; y += spacing) {
      ctx.beginPath(); ctx.moveTo(-diag / 2, y); ctx.lineTo(diag / 2, y); ctx.stroke();
    }
    ctx.restore();

  } else if (type === 'dots') {
    // 點陣無方向性，維持原樣不套用方向性反光。
    const r = Math.max(0.7, thickness * (Math.min(w, h) / 900));
    for (let y = spacing / 2; y < h; y += spacing) {
      for (let x = spacing / 2; x < w; x += spacing) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
    }

  } else if (type === 'grid') {
    // 菱格：畫水平/垂直格線後整體旋轉 45 度即成菱形網格。兩組線互相垂直，
    // 旋轉後的實際角度分別是 135 度與 45 度，各自套不同 alpha，方向性對比最明顯。
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate(45 * Math.PI / 180);
    const diag = Math.sqrt(w * w + h * h);
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(135, baseAlpha).toFixed(3)})`;
    for (let x = -diag / 2; x < diag / 2; x += spacing) {
      ctx.beginPath(); ctx.moveTo(x, -diag / 2); ctx.lineTo(x, diag / 2); ctx.stroke();
    }
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(45, baseAlpha).toFixed(3)})`;
    for (let y = -diag / 2; y < diag / 2; y += spacing) {
      ctx.beginPath(); ctx.moveTo(-diag / 2, y); ctx.lineTo(diag / 2, y); ctx.stroke();
    }
    ctx.restore();

  } else if (type === 'zigzag') {
    // 折線每一段方向都不同，拆成逐段 stroke 才能依段落實際角度分別套用方向性 alpha
    // （這是唯一需要改變繪圖結構、而非只改顏色的紋理）。
    const step = spacing * 0.9;
    for (let y = 0; y < h + step; y += step * 1.5) {
      let x = 0, dir = 1, yy = y;
      while (x < w) {
        const x2 = x + step;
        const yy2 = yy + dir * step * 0.55;
        const segAngle = Math.atan2(yy2 - yy, x2 - x) * 180 / Math.PI;
        ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(segAngle, baseAlpha).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x2, yy2); ctx.stroke();
        x = x2; yy = yy2; dir *= -1;
      }
    }

  } else if (type === 'circuit') {
    // 科技電路紋：固定亂數種子（非 Math.random）確保同一組密度/粗細參數
    // 每次重繪出來的紋理都一樣，使用者調整滑桿時才看得出「連續變化」而不是每次亂跳。
    // 水平線段固定 0 度、垂直線段固定 90 度，各自套不同方向性 alpha。
    let seed = 20260717;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const cell = spacing;
    const nodeR = lineW * 1.6;
    const hAlpha = `rgba(0,0,0,${_dirAlpha(0, baseAlpha).toFixed(3)})`;
    const vAlpha = `rgba(0,0,0,${_dirAlpha(90, baseAlpha).toFixed(3)})`;
    for (let gy = 0; gy < h; gy += cell) {
      for (let gx = 0; gx < w; gx += cell) {
        const cx = gx + cell / 2, cy = gy + cell / 2;
        if (rand() > 0.45) {
          ctx.strokeStyle = hAlpha;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx + cell * (rand() > 0.5 ? 0.95 : 0.5), cy);
          ctx.stroke();
        }
        if (rand() > 0.45) {
          ctx.strokeStyle = vAlpha;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(cx, cy + cell * (rand() > 0.5 ? 0.95 : 0.5));
          ctx.stroke();
        }
        if (rand() > 0.72) {
          ctx.fillStyle = '#000';
          ctx.beginPath(); ctx.arc(cx, cy, nodeR, 0, Math.PI * 2); ctx.fill();
        }
      }
    }

  } else if (type === 'marble') {
    // 大理石紋：隨機游走曲線模擬石紋脈絡，固定亂數種子確保滑桿調整時紋理連續變化。
    let seed = 4001;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const veins = Math.round(5 + density * 0.6);
    const segLen = Math.max(6, spacing * 0.35);
    for (let i = 0; i < veins; i++) {
      let x = rand() * w, y = rand() * h;
      let ang = rand() * Math.PI * 2;
      ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(ang * 180 / Math.PI, baseAlpha).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 55; s++) {
        ang += (rand() - 0.5) * 0.7;
        x += Math.cos(ang) * segLen;
        y += Math.sin(ang) * segLen;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

  } else if (type === 'mountains') {
    // 山脈剪影：多列不規則折線模擬遠山稜線。
    let seed = 4002;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const rows = Math.max(3, Math.round(density * 0.7));
    const rowGap = h / (rows + 1);
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(0, baseAlpha).toFixed(3)})`;
    for (let row = 0; row < rows; row++) {
      const baseY = rowGap * (row + 1);
      ctx.beginPath();
      let x = 0, y = baseY;
      ctx.moveTo(x, y);
      while (x < w) {
        x += spacing * (0.6 + rand() * 0.7);
        y = baseY + (rand() - 0.5) * spacing * 0.9;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

  } else if (type === 'honeycomb2') {
    // 蜂巢六角：正六邊形密鋪網格。
    const r = spacing * 0.55;
    const dx = r * 1.732, dy = r * 1.5;
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(30, baseAlpha).toFixed(3)})`;
    let row = 0;
    for (let y = -r; y < h + r; y += dy) {
      const offset = (row % 2 === 0) ? 0 : dx / 2;
      for (let x = -r + offset; x < w + r; x += dx) {
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
          const a = Math.PI / 3 * i;
          const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      row++;
    }

  } else if (type === 'feather') {
    // 羽毛紋：主軸線＋兩側斜向羽枝。
    let seed = 4004;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const count = Math.max(2, Math.round(density * 0.4));
    for (let f = 0; f < count; f++) {
      const cx = w * (0.2 + rand() * 0.6), cy = h * (0.2 + rand() * 0.6);
      const ang = rand() * Math.PI * 2;
      const length = spacing * (3 + rand() * 2);
      const p1x = cx - Math.cos(ang) * length / 2, p1y = cy - Math.sin(ang) * length / 2;
      const p2x = cx + Math.cos(ang) * length / 2, p2y = cy + Math.sin(ang) * length / 2;
      ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(ang * 180 / Math.PI, baseAlpha).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(p1x, p1y); ctx.lineTo(p2x, p2y); ctx.stroke();
      const n = 18;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const px = p1x + (p2x - p1x) * t, py = p1y + (p2y - p1y) * t;
        const barbLen = spacing * 0.5 * Math.sin(t * Math.PI);
        for (const side of [1, -1]) {
          const bang = ang + side * 2.2;
          const ex = px + Math.cos(bang) * barbLen, ey = py + Math.sin(bang) * barbLen;
          ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(bang * 180 / Math.PI, baseAlpha).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(ex, ey); ctx.stroke();
        }
      }
    }

  } else if (type === 'ripples') {
    // 波光漣漪：3個中心點的同心圓，無方向性維持原樣不套用方向性反光。
    const centers = [[w * 0.22, h * 0.3], [w * 0.75, h * 0.68], [w * 0.85, h * 0.18]];
    ctx.strokeStyle = `rgba(0,0,0,${baseAlpha.toFixed(3)})`;
    for (const [cx, cy] of centers) {
      for (let r = spacing * 0.4; r < Math.max(w, h); r += spacing * 0.5) {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      }
    }

  } else if (type === 'constellation') {
    // 星座連線：隨機點雲，距離內的點兩兩連線＋端點小圓。
    let seed = 4006;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const n = Math.max(10, Math.round(density * 3));
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([w * (0.05 + rand() * 0.9), h * (0.05 + rand() * 0.9)]);
    const threshold = spacing * 2.2;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const [x1, y1] = pts[i], [x2, y2] = pts[j];
        const dist = Math.hypot(x2 - x1, y2 - y1);
        if (dist < threshold) {
          const ang = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
          ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(ang, baseAlpha * 0.8).toFixed(3)})`;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
        }
      }
    }
    ctx.fillStyle = `rgba(0,0,0,${baseAlpha.toFixed(3)})`;
    const dotR = Math.max(1, lineW * 1.3);
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, dotR, 0, Math.PI * 2); ctx.fill(); }

  } else if (type === 'silk') {
    // 絲綢皺褶：多列正弦波橫線。
    const rows = Math.max(6, Math.round(density * 1.6));
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(5, baseAlpha).toFixed(3)})`;
    for (let i = -2; i < rows; i++) {
      ctx.beginPath();
      let started = false;
      for (let x = 0; x <= w + spacing; x += spacing * 0.3) {
        const y = (h / rows) * i + Math.sin(x / (spacing * 2) + i) * spacing * 0.5;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

  } else if (type === 'facets') {
    // 鑽石切割面：格狀分佈的不規則多邊形＋頂點到中心的稜線。
    let seed = 4008;
    const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
    const cell = spacing * 1.8;
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(40, baseAlpha).toFixed(3)})`;
    for (let gy = -1; gy < h / cell + 2; gy++) {
      for (let gx = -1; gx < w / cell + 2; gx++) {
        const cx = gx * cell + (rand() - 0.5) * cell * 0.3;
        const cy = gy * cell + (rand() - 0.5) * cell * 0.3;
        const r = cell * 0.5;
        const n = rand() > 0.5 ? 6 : 5;
        const baseAng = rand() * Math.PI;
        ctx.beginPath();
        let first = null;
        for (let i = 0; i < n; i++) {
          const a = baseAng + i * (2 * Math.PI / n);
          const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
          if (i === 0) { ctx.moveTo(px, py); first = [px, py]; } else ctx.lineTo(px, py);
        }
        ctx.closePath(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(first[0], first[1]); ctx.lineTo(cx, cy); ctx.stroke();
      }
    }

  } else if (type === 'greekkey') {
    // 羅馬回紋：方形迴紋線條單元密鋪。
    const unit = spacing * 0.6;
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(0, baseAlpha).toFixed(3)})`;
    for (let y = unit; y < h; y += unit * 2.6) {
      for (let x = 0; x < w; x += unit * 2.6) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + unit * 2, y);
        ctx.lineTo(x + unit * 2, y + unit * 1.3);
        ctx.lineTo(x + unit * 0.6, y + unit * 1.3);
        ctx.lineTo(x + unit * 0.6, y + unit * 0.6);
        ctx.lineTo(x + unit * 2 - unit * 0.5, y + unit * 0.6);
        ctx.stroke();
      }
    }

  } else if (type === 'woodgrain') {
    // 年輪木紋：畫布外一個圓心，畫出一系列同心弧線。
    const cx = w * 0.15, cy = h * 1.3;
    ctx.strokeStyle = `rgba(0,0,0,${baseAlpha.toFixed(3)})`;
    for (let r = spacing * 0.6; r < h * 2.6; r += spacing * 0.45) {
      ctx.beginPath();
      let started = false;
      for (let a = -45; a <= 45; a += 2) {
        const ang = a * Math.PI / 180;
        const rr = r + Math.sin(ang * 5 + r * 0.05) * spacing * 0.15;
        const px = cx + rr * Math.sin(ang), py = cy - rr * Math.cos(ang);
        if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

  } else if (type === 'premiumdots') {
    // 圓點網格：每個點外圈＋內圈雙層描邊，模擬壓凹洞孔的層次感。
    const r = spacing * 0.32;
    let row = 0;
    for (let y = -spacing; y < h + spacing; y += spacing, row++) {
      const offset = (row % 2 === 0) ? 0 : spacing / 2;
      for (let x = -spacing + offset; x < w + spacing; x += spacing) {
        ctx.strokeStyle = `rgba(0,0,0,${baseAlpha.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `rgba(0,0,0,${(baseAlpha * 0.6).toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2); ctx.stroke();
      }
    }

  } else if (type === 'premiumtriangle') {
    // 三角網格：正三角形密鋪網格線。
    const unit = spacing * 1.3;
    const rowH = unit * 0.866;
    ctx.strokeStyle = `rgba(0,0,0,${baseAlpha.toFixed(3)})`;
    let row = 0;
    for (let y = -rowH; y < h + rowH; y += rowH, row++) {
      const offsetX = (row % 2 === 0) ? 0 : unit / 2;
      for (let x = -unit + offsetX; x < w + unit; x += unit) {
        ctx.beginPath();
        ctx.moveTo(x, y); ctx.lineTo(x + unit, y); ctx.lineTo(x + unit / 2, y + rowH); ctx.closePath();
        ctx.stroke();
      }
    }

  } else if (type === 'premiumhex') {
    // 六角網格：比蜂巢六角更大顆、更俐落的正六邊形網格。
    const r = spacing * 0.75;
    const dx = r * 1.732, dy = r * 1.5;
    ctx.strokeStyle = `rgba(0,0,0,${baseAlpha.toFixed(3)})`;
    let row = 0;
    for (let y = -r; y < h + r; y += dy) {
      const offset = (row % 2 === 0) ? 0 : dx / 2;
      for (let x = -r + offset; x < w + r; x += dx) {
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
          const a = Math.PI / 3 * i;
          const px = x + r * Math.cos(a), py = y + r * Math.sin(a);
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      row++;
    }

  } else if (type === 'herringbone') {
    // 人字紋：交錯排列的V形折線，模擬雁行紋。
    const unit = spacing * 1.1;
    for (let row = -1; row * unit < h + unit; row++) {
      const y = row * unit;
      const offsetX = (row % 2 === 0) ? 0 : unit / 2;
      for (let col = -1; col * unit < w + unit; col++) {
        const cx = col * unit + offsetX;
        const top = [cx, y - unit / 2], right = [cx + unit / 2, y], bottom = [cx, y + unit / 2];
        const ang1 = Math.atan2(right[1] - top[1], right[0] - top[0]) * 180 / Math.PI;
        ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(ang1, baseAlpha).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(top[0], top[1]); ctx.lineTo(right[0], right[1]); ctx.stroke();
        const ang2 = Math.atan2(bottom[1] - right[1], bottom[0] - right[0]) * 180 / Math.PI;
        ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(ang2, baseAlpha).toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(right[0], right[1]); ctx.lineTo(bottom[0], bottom[1]); ctx.stroke();
      }
    }

  } else if (type === 'stripes2') {
    // 直線壓紋：45度平行斜線，模擬拉絲金屬。
    const gap = spacing * 0.55;
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(-45, baseAlpha).toFixed(3)})`;
    const n = Math.ceil((w + h) / gap) + 2;
    for (let i = -2; i < n; i++) {
      const x0 = i * gap;
      ctx.beginPath(); ctx.moveTo(x0, 0); ctx.lineTo(x0 - h, h); ctx.stroke();
    }

  } else if (type === 'squaregrid') {
    // 方格網：水平/垂直等距格線。
    const unit = spacing * 1.3;
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(90, baseAlpha).toFixed(3)})`;
    for (let x = -unit; x < w + unit; x += unit) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    ctx.strokeStyle = `rgba(0,0,0,${_dirAlpha(0, baseAlpha).toFixed(3)})`;
    for (let y = -unit; y < h + unit; y += unit) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  } else if (type === 'custom' && _fullBleedCustomImg) {
    const tileSize = Math.max(24, (11 - density) * 10);
    const scale = tileSize / (_fullBleedCustomImg.naturalWidth || _fullBleedCustomImg.width);
    ctx.save();
    ctx.globalAlpha = Math.min(1, 0.5 + thickness * 0.05);
    for (let y = 0; y < h; y += tileSize) {
      for (let x = 0; x < w; x += tileSize) {
        ctx.drawImage(_fullBleedCustomImg, x, y, tileSize, tileSize * scale * ((_fullBleedCustomImg.naturalHeight || _fullBleedCustomImg.height) / (_fullBleedCustomImg.naturalWidth || _fullBleedCustomImg.width)) / scale);
      }
    }
    ctx.restore();
  }
  if (reserveCorner) ctx.restore(); // 對應上面 reserveCorner 的裁切 save()
  ctx.restore(); // 對應函式開頭的 ctx.scale(renderScale, renderScale)
}

function renderFullBleedPicker() {
  const wrap = document.getElementById('black-card-fullbleed-picker');
  if (!wrap) return;
  wrap.innerHTML = FULL_BLEED_PATTERN_OPTIONS.map(p => `
    <div class="cartoon-style-card ${p.id === STATE.blackCardFullBleedType ? 'selected' : ''}"
         data-fullbleed="${p.id}" onclick="selectFullBleedPattern('${p.id}')">
      <div class="cartoon-style-swatch" style="background:#101113;">
        <canvas width="60" height="60" style="width:100%;height:100%;display:block;" data-preview="${p.id}"></canvas>
      </div>
      <div class="cartoon-style-name">${p.name}</div>
    </div>
  `).join('');
  FULL_BLEED_PATTERN_OPTIONS.forEach(p => {
    if (p.id === 'custom') return;
    const c = wrap.querySelector(`canvas[data-preview="${p.id}"]`);
    if (c) {
      const pctx = c.getContext('2d');
      pctx.fillStyle = '#101113';
      pctx.fillRect(0, 0, c.width, c.height);
      _drawFullBleedPatternOnCanvas(c, p.id, { density: 6, thickness: 4 });
      // 縮圖底色是深色，剛剛畫的是黑色線條看不出來，疊一層白色描邊示意即可
      const img = pctx.getImageData(0, 0, c.width, c.height);
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3] > 0) { img.data[i] = img.data[i + 1] = img.data[i + 2] = 210; img.data[i+3] = 200; }
      }
      pctx.putImageData(img, 0, 0);
    }
  });
}

function selectFullBleedPattern(type) {
  document.querySelectorAll('#black-card-fullbleed-picker .cartoon-style-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.fullbleed === type);
  });
  STATE.blackCardFullBleedType = type;
  const uploadWrap = document.getElementById('black-card-fullbleed-upload-wrap');
  const controls = document.getElementById('black-card-fullbleed-controls');
  if (type === 'custom') {
    if (uploadWrap) uploadWrap.classList.remove('hidden');
    if (_fullBleedCustomImg) { if (controls) controls.classList.remove('hidden'); applyFullBleedPattern(); }
    return; // 還沒上傳圖片前不動畫布
  }
  if (uploadWrap) uploadWrap.classList.add('hidden');
  if (controls) controls.classList.remove('hidden');
  applyFullBleedPattern();
}

// 黑卡滿版自訂圖片上傳。upload_result事件追蹤：類型／大小先擋（unsupported_type／
// file_too_large）；FileReader失敗算read_failed；圖片解碼失敗算decode_failed；套用
// 滿版圖案這段本身出例外算processing_failed；只有真的套用完成才算success。
function handleFullBleedCustomUpload(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const _uploadProductId = (typeof STATE !== 'undefined') ? STATE.productId : null;
  try {
    const invalidCategory = (typeof _validateUploadFile === 'function') ? _validateUploadFile(file) : null;
    if (invalidCategory) {
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', invalidCategory);
      return;
    }
  } catch (e) { /* 驗證本身若意外出錯，不擋使用者上傳，直接往下走原本流程 */ }

  const reader = new FileReader();
  reader.onerror = () => {
    if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'read_failed');
  };
  reader.onload = e => {
    const img = new Image();
    img.onerror = () => {
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'decode_failed');
    };
    img.onload = () => {
      try {
        _fullBleedCustomImg = img;
        document.getElementById('black-card-fullbleed-controls')?.classList.remove('hidden');
        applyFullBleedPattern();
        if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'success');
      } catch (err) {
        if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'processing_failed');
      }
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// 套用/更新滿版元素圖案：移除舊物件、依目前滑桿參數重畫，加入畫布並裁切在卡片圓角內。
// z-order 固定在黑卡底色（bg/noise/edge）之上、AI 人像與文字之下。
function applyFullBleedPattern() {
  if (!canvas2d || !STATE.blackCardFullBleedType) return;
  const type = STATE.blackCardFullBleedType;
  if (type === 'custom' && !_fullBleedCustomImg) return;

  const density   = parseInt(document.getElementById('fullbleed-density')?.value || 5, 10);
  const thickness = parseInt(document.getElementById('fullbleed-thickness')?.value || 4, 10);
  const reliefPct = parseInt(document.getElementById('fullbleed-relief')?.value || 5, 10);

  const w = canvas2d.getWidth(), h = canvas2d.getHeight();
  const safeMarginRatio = 0.05; // 留一點安全邊距，避免紋理直接貼到卡緣圓角
  const patW = Math.max(20, Math.round(w * (1 - safeMarginRatio * 2)));
  const patH = Math.max(20, Math.round(h * (1 - safeMarginRatio * 2)));

  // 底層畫布用 2 倍緩衝解析度繪製，畫面顯示大小不變（靠下方 patternGroup 群組
  // 層級 scaleX/scaleY 補償縮小回原尺寸），縮放到180%時像素密度仍有餘裕不糊。
  const PATTERN_RENDER_SCALE = 2;
  const patCanvas = document.createElement('canvas');
  patCanvas.width = patW * PATTERN_RENDER_SCALE;
  patCanvas.height = patH * PATTERN_RENDER_SCALE;
  _drawFullBleedPatternOnCanvas(patCanvas, type, { density, thickness, renderScale: PATTERN_RENDER_SCALE });

  canvas2d.getObjects().filter(o => o.name === 'full-bleed-pattern').forEach(o => canvas2d.remove(o));

  // 浮雕強度滑桿（1~10）直接內插出壓印參數，比硬套 5 種離散工藝更連續平滑；
  // base 主體填色刻意壓低、不隨滑桿變動太多，避免整片紋理蓋過主圖案風頭。
  const t = (reliefPct - 1) / 9; // 0~1
  const reliefParams = {
    depthRatio: 0.010 + t * 0.022,
    hiliteOpa: 0.30 + t * 0.35,
    shadowOpa: 0.28 + t * 0.40,
    baseOpacity: 0.55 + t * 0.20,
    baseBlend: 'screen' // 滿版紋理要蓋滿含底色漸層最暗的四角，用 screen 避免暗部把紋理蓋到消失
  };

  const patternGroup = applyBlackEffectToImage(patCanvas, reliefParams);
  // patCanvas 是用 PATTERN_RENDER_SCALE 倍緩衝解析度畫的，applyBlackEffectToImage
  // 產生的圖層原生像素尺寸也跟著放大了同樣倍數，這裡在「群組」層級整體縮小補償
  // 回來，畫面顯示大小才會跟原本一樣，但底層像素密度提高、縮放到180%不會糊。
  // 用群組層級縮放而不是動 applyBlackEffectToImage 內部邏輯，是因為那個函式
  // 同時服務 AI 人像合成，不能為了滿版紋理的需求改動共用邏輯。
  // 必須設 baseScale（而不是只設 scaleX/scaleY）：scaleSelectedTo()／
  // _updateScaleSlider()（縮放滑桿40%~300%）都是以 obj.baseScale 當作「100%」
  // 的基準去換算 scaleX = baseScale * 使用者選的比例——只設 scaleX 沒有同步設
  // baseScale 的話，使用者一拖動縮放滑桿，scaleSelectedTo 會用預設 base=1
  // 直接覆蓋掉這裡設的 0.5，讓紋理瞬間放大兩倍。
  const patternBaseScale = 1 / PATTERN_RENDER_SCALE;
  patternGroup.baseScale = patternBaseScale;
  patternGroup.scaleX = patternBaseScale;
  patternGroup.scaleY = patternBaseScale;
  patternGroup.set({
    name: 'full-bleed-pattern',
    left: w / 2, top: h / 2,
    originX: 'center', originY: 'center',
    // 滿版背景不可被使用者誤選取/移動/縮放/旋轉（避免蓋住整張卡的物件被誤操作，
    // 也避免它攔截原本要點到簽名或其他圖案的點擊）
    selectable: false, evented: false, hasControls: false, hoverCursor: 'default'
  });

  // 裁切在卡片圓角範圍內，跟商品預覽卡片使用同一個 ISO 卡片圓角比例。
  // clipPath 沒有設 absolutePositioned，Fabric 會把它的座標視為「相對物件自己中心」而非
  // 畫布絕對座標——之前誤填 left:w/2,top:h/2（畫布絕對座標），等於把裁切窗往右下角
  // 整整偏移半個卡寬/卡高，導致左上角一大片被裁掉，只剩右下角看得到紋理。相對座標下
  // 裁切窗要置中在物件自己身上，left/top 必須是 0。
  // clipPath 的座標也是「相對物件自己」的本地座標系，會跟著 patternGroup 的
  // scaleX/scaleY 一起被縮放，所以這裡要反過來乘上 PATTERN_RENDER_SCALE 補償，
  // 縮放後的實際裁切範圍才會等於卡片真正的 w×h（否則會被誤裁成只剩一半大小）。
  const cornerRatio = 3.18 / 85.6;
  patternGroup.clipPath = new fabric.Rect({
    width: w * PATTERN_RENDER_SCALE, height: h * PATTERN_RENDER_SCALE,
    rx: w * cornerRatio * PATTERN_RENDER_SCALE, ry: w * cornerRatio * PATTERN_RENDER_SCALE,
    left: 0, top: 0, originX: 'center', originY: 'center'
  });

  canvas2d.add(patternGroup);
  // 送到黑卡底色（bg/noise/edge/edge-shade）之上，但仍在 AI 人像/文字/簽名之下。
  // sendToBack 是「每呼叫一次就變成當下最底層」，所以陣列要反過來寫成
  // 「最上層的先呼叫」，最後呼叫的（bg）才會落在真正最底部，疊層順序才會是
  // bg（最底）→noise→edge→edge-shade（最上，貼齊 addBlackCardTemplate 裡
  // canvas2d.add(bg, noise, edge, edgeShade) 的原始由下往上順序）。
  canvas2d.sendToBack(patternGroup);
  ['black-card-edge-shade', 'black-card-edge', 'black-card-noise', 'black-card-bg'].forEach(n => {
    const o = canvas2d.getObjects().find(x => x.name === n);
    if (o) canvas2d.sendToBack(o);
  });

  canvas2d.requestRenderAll();
  // 存一份「原始去背圖樣」的 data URL（黑色線條在透明背景上，套壓印效果前），
  // 商品預覽跟黑卡人像用同一套技術——CSS mask 直接讀這份乾淨的 alpha 圖樣，
  // 而不是去讀已經套過多層 blend 的設計頁物件（那樣顏色會疊加錯誤）。
  STATE.blackCardFullBleedDataURL = patCanvas.toDataURL('image/png');
  STATE.blackCardFullBleedDensity = density;
  STATE.blackCardFullBleedThickness = thickness;
  STATE.blackCardFullBleedRelief = reliefPct;
  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof _refreshBlackCardNextButton === 'function') _refreshBlackCardNextButton();
}

function updateFullBleedPattern() {
  if (!STATE.blackCardFullBleedType) return;
  applyFullBleedPattern();
}

function removeFullBleedPattern() {
  if (!canvas2d) return;
  canvas2d.getObjects().filter(o => o.name === 'full-bleed-pattern').forEach(o => canvas2d.remove(o));
  canvas2d.requestRenderAll();
  STATE.blackCardFullBleedType = null;
  STATE.blackCardFullBleedDataURL = null;
  document.getElementById('black-card-fullbleed-controls')?.classList.add('hidden');
  document.getElementById('black-card-fullbleed-upload-wrap')?.classList.add('hidden');
  document.querySelectorAll('#black-card-fullbleed-picker .cartoon-style-card').forEach(el => el.classList.remove('selected'));
  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof _refreshBlackCardNextButton === 'function') _refreshBlackCardNextButton();
}

// ─── 黑卡：藝術簽名 ──────────────────────────────────────────
// 4 種明顯不同手寫風格：兩種英文連筆簽名體＋兩種支援完整中文字集的手寫/毛筆字體
// （LXGW WenKai TC、Ma Shan Zheng 都是涵蓋常用中文字的字型，不會缺字變方框）。
// 黑卡、保溫杯的「藝術簽名」共用同一套手寫字體（保溫杯這邊沿用黑卡已經選定的4款，
// 兩邊視覺調性一致，不用另外設計一套）。BLACK_CARD_SIGNATURE_FONTS 這個舊名稱保留
// 一份參照，避免漏改到還在用舊名稱的地方。
const SIGNATURE_FONTS = [
  { id: 'Dancing Script', name: '英文優雅連筆', sample: 'Signature' },
  { id: 'Great Vibes',    name: '英文華麗簽名', sample: 'Signature' },
  { id: 'LXGW WenKai TC', name: '中文手寫楷書', sample: '簽名範例' },
  { id: 'Ma Shan Zheng',  name: '中文毛筆簽名', sample: '簽名範例' }
];
const BLACK_CARD_SIGNATURE_FONTS = SIGNATURE_FONTS;

function renderSignatureFontPicker() {
  const wrap = document.getElementById('black-card-signature-font-picker');
  if (!wrap) return;
  if (!STATE.blackCardSignatureFont) STATE.blackCardSignatureFont = BLACK_CARD_SIGNATURE_FONTS[0].id;
  wrap.innerHTML = BLACK_CARD_SIGNATURE_FONTS.map(f => `
    <div class="cartoon-style-card ${f.id === STATE.blackCardSignatureFont ? 'selected' : ''}"
         data-sigfont="${escapeHtml(f.id)}" onclick="selectSignatureFont('${f.id.replace(/'/g, "\\'")}')">
      <div class="cartoon-style-swatch" style="background:#101113;display:flex;align-items:center;justify-content:center;">
        <span style="font-family:'${f.id}',cursive;color:#d8d8da;font-size:20px;">${f.sample}</span>
      </div>
      <div class="cartoon-style-name">${f.name}</div>
    </div>
  `).join('');
}

function selectSignatureFont(fontId) {
  STATE.blackCardSignatureFont = fontId;
  document.querySelectorAll('#black-card-signature-font-picker .cartoon-style-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.sigfont === fontId);
  });
  if (canvas2d && canvas2d.getObjects().find(o => o.name === 'black-card-signature')) {
    applyBlackCardSignature();
  }
}

// 套用簽名：文字/字體改變時整個重建（fabric.Text 換字體最單純的做法是重新產生物件），
// 大小/旋轉調整則交給 updateBlackCardSignatureStyle() 直接改現有物件，不用重建。
function applyBlackCardSignature() {
  if (!canvas2d) return;
  const input = document.getElementById('black-card-signature-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  const font = STATE.blackCardSignatureFont || BLACK_CARD_SIGNATURE_FONTS[0].id;
  const existing = canvas2d.getObjects().find(o => o.name === 'black-card-signature');
  const sizePct = existing ? existing._signatureSizePct : parseInt(document.getElementById('signature-size')?.value || 47, 10);
  const rotation = existing ? (existing.angle || 0) : parseInt(document.getElementById('signature-rotation')?.value || 0, 10);
  const left = existing ? existing.left : canvas2d.getWidth() * 0.80;
  const top = existing ? existing.top : canvas2d.getHeight() * 0.82;

  if (existing) canvas2d.remove(existing);

  const w = canvas2d.getWidth();
  const fontSize = Math.max(10, w * (sizePct / 1000)); // sizePct 10~60 對應約 1%~6% 卡面寬度的字級

  const sig = new fabric.Text(text, {
    name: 'black-card-signature',
    fontFamily: font,
    fontSize,
    left, top,
    originX: 'center', originY: 'center',
    angle: rotation,
    // 藝術簽名改用低調香檳銀色調＋深色細描邊，模擬燙印/雷雕金屬字的質感，
    // 不用純白（純白在畫面上太搶眼、太像印刷字，跟參考的燙印簽名質感不符）。
    fill: '#CFC8B4',
    stroke: 'rgba(20,18,14,0.35)',
    strokeWidth: Math.max(0.4, fontSize * 0.012),
    selectable: true, evented: true
  });
  sig._signatureSizePct = sizePct;
  // 方向性較明確的陰影（右下偏移＋較高不透明度），模擬單一光源下刻字邊緣的
  // 立體落差，比之前那個幾乎看不見的柔光陰影更有壓凹刻字的存在感。
  sig.set('shadow', new fabric.Shadow({ color: 'rgba(0,0,0,0.55)', blur: fontSize * 0.07, offsetX: fontSize * 0.015, offsetY: fontSize * 0.045 }));

  canvas2d.add(sig);
  canvas2d.setActiveObject(sig);
  canvas2d.requestRenderAll();

  STATE.blackCardSignatureText = text;
  document.getElementById('black-card-signature-controls')?.classList.remove('hidden');
  document.getElementById('black-card-signature-remove-btn')?.classList.remove('hidden');
  const sizeSlider = document.getElementById('signature-size');
  const rotSlider = document.getElementById('signature-rotation');
  if (sizeSlider) sizeSlider.value = sizePct;
  if (rotSlider) rotSlider.value = rotation;

  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof _refreshBlackCardNextButton === 'function') _refreshBlackCardNextButton();
  if (typeof _updateBlackCardSignatureTriggerBrief === 'function') _updateBlackCardSignatureTriggerBrief();
}

function updateBlackCardSignatureStyle() {
  if (!canvas2d) return;
  const sig = canvas2d.getObjects().find(o => o.name === 'black-card-signature');
  if (!sig) return;
  const sizePct = parseInt(document.getElementById('signature-size')?.value || 47, 10);
  const rotation = parseInt(document.getElementById('signature-rotation')?.value || 0, 10);
  const w = canvas2d.getWidth();
  const fontSize = Math.max(10, w * (sizePct / 1000));
  sig.set({ fontSize, angle: rotation, strokeWidth: Math.max(0.4, fontSize * 0.012) });
  if (sig.shadow) sig.shadow.set({ blur: fontSize * 0.07, offsetX: fontSize * 0.015, offsetY: fontSize * 0.045 });
  sig._signatureSizePct = sizePct;
  sig.setCoords();
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

function removeBlackCardSignature() {
  if (!canvas2d) return;
  canvas2d.getObjects().filter(o => o.name === 'black-card-signature').forEach(o => canvas2d.remove(o));
  canvas2d.requestRenderAll();
  STATE.blackCardSignatureText = '';
  const input = document.getElementById('black-card-signature-input');
  if (input) input.value = '';
  document.getElementById('black-card-signature-controls')?.classList.add('hidden');
  document.getElementById('black-card-signature-remove-btn')?.classList.add('hidden');
  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof _refreshBlackCardNextButton === 'function') _refreshBlackCardNextButton();
  if (typeof _updateBlackCardSignatureTriggerBrief === 'function') _updateBlackCardSignatureTriggerBrief();
}

// ─── 保溫杯「藝術簽名」───────────────────────────────────────────
// 跟黑卡藝術簽名幾乎同一套邏輯（同一套 SIGNATURE_FONTS 字體、同一套大小/旋轉滑桿），
// 唯一差別是顏色：黑卡底色固定黑，簽名寫死白色才看得清楚；保溫杯有4種杯身顏色可選
// （含淺色杯身），顏色必須開放客人自己選，不能沿用黑卡那個固定值，所以另外寫一組
// 函式而不是共用黑卡那組，避免把「固定白色」跟「自選顏色」兩種邏輯揉在一起。
function renderThermosSignatureFontPicker() {
  const wrap = document.getElementById('thermos-signature-font-picker');
  if (!wrap) return;
  if (!STATE.thermosSignatureFont) STATE.thermosSignatureFont = SIGNATURE_FONTS[0].id;
  wrap.innerHTML = SIGNATURE_FONTS.map(f => `
    <div class="cartoon-style-card ${f.id === STATE.thermosSignatureFont ? 'selected' : ''}"
         data-sigfont="${escapeHtml(f.id)}" onclick="selectThermosSignatureFont('${f.id.replace(/'/g, "\\'")}')">
      <div class="cartoon-style-swatch" style="background:#101113;display:flex;align-items:center;justify-content:center;">
        <span style="font-family:'${f.id}',cursive;color:#d8d8da;font-size:20px;">${f.sample}</span>
      </div>
      <div class="cartoon-style-name">${f.name}</div>
    </div>
  `).join('');
}

function selectThermosSignatureFont(fontId) {
  STATE.thermosSignatureFont = fontId;
  document.querySelectorAll('#thermos-signature-font-picker .cartoon-style-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.sigfont === fontId);
  });
  if (canvas2d && canvas2d.getObjects().find(o => o.name === 'thermos-signature')) {
    applyThermosSignature();
  }
}

function applyThermosSignature() {
  if (!canvas2d) return;
  const input = document.getElementById('thermos-signature-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  const hint = canvas2d.getObjects().find(o => o.name === 'hint');
  if (hint) canvas2d.remove(hint);

  const font = STATE.thermosSignatureFont || SIGNATURE_FONTS[0].id;
  const color = document.getElementById('thermos-signature-color')?.value || '#333333';
  const existing = canvas2d.getObjects().find(o => o.name === 'thermos-signature');
  const sizePct = existing ? existing._signatureSizePct : parseInt(document.getElementById('thermos-signature-size')?.value || 60, 10);
  const rotation = existing ? (existing.angle || 0) : parseInt(document.getElementById('thermos-signature-rotation')?.value || 0, 10);
  // 新簽名預設落在印刷區水平中心偏左一點（0.40，不是正中間0.5），套用後仍落在3D預覽
  // 「正面」視角範圍內；保溫杯正中央剛好卡在場景燈光的反光帶最亮處，深色蝕刻文字會被
  // 曝光洗淡看不到，稍微偏移可以避開反光最強的那條線（另外也調降了材質金屬度、拉高蝕刻
  // 對比，三者一起處理才夠穩，見 preview3d.js THERMOS_LASER_ENGRAVE_PARAMS/buildThermos()）。
  // 若是編輯既有簽名，沿用使用者已經拖動調整過的位置，不強制拉回這個預設值。
  const la = (currentProduct && currentProduct.labelArea) ? currentProduct.labelArea : null;
  const defaultLeft = la ? canvas2d.getWidth() * (la.xRatio + la.wRatio * 0.40) : canvas2d.getWidth() * 0.40;
  const defaultTop  = la ? canvas2d.getHeight() * (la.yRatio + la.hRatio / 2) : canvas2d.getHeight() / 2;
  const left = existing ? existing.left : defaultLeft;
  const top = existing ? existing.top : defaultTop;

  if (existing) canvas2d.remove(existing);

  const w = canvas2d.getWidth();
  const fontSize = Math.max(10, w * (sizePct / 1000));

  const sig = new fabric.Text(text, {
    name: 'thermos-signature',
    fontFamily: font,
    fontSize,
    left, top,
    originX: 'center', originY: 'center',
    angle: rotation,
    fill: color,
    selectable: true, evented: true
  });
  sig._signatureSizePct = sizePct;

  canvas2d.add(sig);
  canvas2d.setActiveObject(sig);
  canvas2d.requestRenderAll();

  STATE.thermosSignatureText = text;
  STATE.thermosSignatureColor = color;
  document.getElementById('thermos-signature-controls')?.classList.remove('hidden');
  document.getElementById('thermos-signature-remove-btn')?.classList.remove('hidden');
  const sizeSlider = document.getElementById('thermos-signature-size');
  const rotSlider = document.getElementById('thermos-signature-rotation');
  if (sizeSlider) sizeSlider.value = sizePct;
  if (rotSlider) rotSlider.value = rotation;

  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof _updateThermosSignatureTriggerBrief === 'function') _updateThermosSignatureTriggerBrief();
}

function updateThermosSignatureStyle() {
  if (!canvas2d) return;
  const sig = canvas2d.getObjects().find(o => o.name === 'thermos-signature');
  if (!sig) return;
  const sizePct = parseInt(document.getElementById('thermos-signature-size')?.value || 60, 10);
  const rotation = parseInt(document.getElementById('thermos-signature-rotation')?.value || 0, 10);
  const color = document.getElementById('thermos-signature-color')?.value || '#333333';
  const w = canvas2d.getWidth();
  sig.set({ fontSize: Math.max(10, w * (sizePct / 1000)), angle: rotation, fill: color });
  sig._signatureSizePct = sizePct;
  sig.setCoords();
  canvas2d.requestRenderAll();
  STATE.thermosSignatureColor = color;
  if (typeof syncDesignState === 'function') syncDesignState();
}

function removeThermosSignature() {
  if (!canvas2d) return;
  canvas2d.getObjects().filter(o => o.name === 'thermos-signature').forEach(o => canvas2d.remove(o));
  canvas2d.requestRenderAll();
  STATE.thermosSignatureText = '';
  const input = document.getElementById('thermos-signature-input');
  if (input) input.value = '';
  document.getElementById('thermos-signature-controls')?.classList.add('hidden');
  document.getElementById('thermos-signature-remove-btn')?.classList.add('hidden');
  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof _updateThermosSignatureTriggerBrief === 'function') _updateThermosSignatureTriggerBrief();
}

// ─── 上傳圖片 ────────────────────────────────────────────
// 一般設計圖片／Logo上傳（Step3設計頁，所有商品共用）。upload_result事件追蹤：
// 檔案類型／大小先在FileReader之前擋（unsupported_type／file_too_large）；FileReader
// 本身失敗算read_failed；圖片解碼失敗算decode_failed（fabric.Image.fromURL在部分情況下
// 解碼失敗不一定會呼叫callback或回傳可用物件，這裡另外用原生Image()先探測一次確保能
// 可靠偵測到，不依賴fabric內部行為）；套用到畫布這段本身出例外算processing_failed；
// 只有真的加入畫布並更新完STATE快照才算success。整段追蹤失敗（例如window.YZAnalytics
// 不存在）都不能影響原本的上傳功能，所以最外層再包一層try/catch保險。
function uploadImage2D(file) {
  if (!canvas2d || !file) return;
  const _uploadProductId = (typeof STATE !== 'undefined') ? STATE.productId : null;
  try {
    const invalidCategory = (typeof _validateUploadFile === 'function') ? _validateUploadFile(file) : null;
    if (invalidCategory) {
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', invalidCategory);
      return;
    }
  } catch (e) { /* 驗證本身若意外出錯，不擋使用者上傳，直接往下走原本流程 */ }

  const reader = new FileReader();
  reader.onerror = () => {
    if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'read_failed');
  };
  reader.onload = e => {
    const dataUrl = e.target.result;
    const probe = new Image();
    probe.onerror = () => {
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'decode_failed');
    };
    probe.onload = () => {
      try {
        fabric.Image.fromURL(dataUrl, img => {
          try {
            // coverMode=true：跟 fillCanvasWithSelectedImage()「滿版鋪滿」用同一套算法，
            // 客人上傳照片後直接鋪滿卡面／印刷區，不用再自己手動放大拖曳。超出範圍的
            // 部分交給既有的 clipPath 裁掉，不需要另外寫裁切邏輯。
            const place = getFillPlacement(img, true);

            img.set({
              left: place.left, top: place.top,
              originX: 'center', originY: 'center',
              scaleX: place.scale, scaleY: place.scale
            });
            canvas2d.add(img);
            canvas2d.bringToFront(img);   // 一般照片上傳後自動疊在最上層（含主標題/副標題文字之上）
            canvas2d.setActiveObject(img);
            canvas2d.requestRenderAll();
            uploadedImage = img;
            // 圖片已確定 decode 完成並畫進 canvas，這裡立刻更新 STATE 快照，
            // 不必等到離開設計頁才產生，避免中途查看 designState 時內容是舊的。
            if (typeof STATE !== 'undefined') {
              STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : STATE.designDataURL;
              STATE.canvasJSON = (typeof getCanvas2DJSON === 'function') ? getCanvas2DJSON() : STATE.canvasJSON;
            }
            if (typeof syncDesignState === 'function') syncDesignState();
            if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'success');
          } catch (err) {
            if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'processing_failed');
          }
        });
      } catch (err) {
        if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'processing_failed');
      }
    };
    probe.src = dataUrl;
  };
  reader.readAsDataURL(file);
}

// ─── 圖形素材庫（貼紙裝飾）─────────────────────────────────────
// 客人不用自己上傳圖片，也能直接加入現成的裝飾圖形（愛心/星星/亮片等）。跟
// uploadImage2D() 加入的照片一樣，是獨立、可個別選取／搬移／縮放／刪除的圖層，
// 共用同一套圖層面板機制（renderLayerPanel() 只要把 'sticker' 加進
// LAYER_NAMES 清單就會自動列出，不需要另外寫一套面板邏輯）。
const STICKER_LIBRARY = [
  { id: 'heart',   name: '愛心', color: '#e0455f',
    path: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z' },
  { id: 'star',    name: '星星', color: '#f0b429',
    path: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z' },
  { id: 'sparkle', name: '亮片', color: '#f6cd45',
    path: 'M12 2l2 8 8 2-8 2-2 8-2-8-8-2 8-2z' },
  { id: 'flower',  name: '花朵', color: '#e58fb0',
    path: 'M12 2c-1.1 1.1-2 2.9-2 4.5C10 8 10.9 9 12 9s2-1 2-2.5C14 4.9 13.1 3.1 12 2zM12 15c1.1-1.1 2-2.9 2-4.5C14 9 13.1 8 12 8s-2 1-2 2.5c0 1.6.9 3.4 2 4.5zM2 12c1.1-1.1 2.9-2 4.5-2C8 10 9 10.9 9 12s-1 2-2.5 2C4.9 14 3.1 13.1 2 12zM15 12c0-1.1 1-2 2.5-2 1.6 0 3.4.9 4.5 2-1.1 1.1-2.9 2-4.5 2-1.5 0-2.5-.9-2.5-2z' },
  { id: 'crown',   name: '皇冠', color: '#d4a017',
    path: 'M5 16L3 6l5.5 4L12 4l3.5 6L21 6l-2 10H5zm0 2h14v2H5v-2z' },
  // ─── 新增20款：幾何造型 + 裝飾線條風格，延續背景蒙版造型（CARD_MASK_SHAPES）
  // 同一套「混合幾何/裝飾線條」調性，百搭不搶戲，可套用在各種商品/主題上。
  { id: 'circle',    name: '圓形', color: '#4a90d9',
    path: 'M12,2 C17.52,2 22,6.48 22,12 C22,17.52 17.52,22 12,22 C6.48,22 2,17.52 2,12 C2,6.48 6.48,2 12,2 Z' },
  { id: 'triangle',  name: '三角形', color: '#e8734a',
    path: 'M12 3 L21 20 L3 20 Z' },
  { id: 'square',    name: '方形', color: '#6b7280',
    path: 'M5 4 H19 A2 2 0 0 1 21 6 V18 A2 2 0 0 1 19 20 H5 A2 2 0 0 1 3 18 V6 A2 2 0 0 1 5 4 Z' },
  { id: 'diamond',   name: '菱形', color: '#a855c9',
    path: 'M12 2 L22 12 L12 22 L2 12 Z' },
  { id: 'hexagon',   name: '六角形', color: '#14b8a6',
    path: 'M6 3 H18 L22 12 L18 21 H6 L2 12 Z' },
  { id: 'pentagon',  name: '五角形', color: '#f59e0b',
    path: 'M12 2 L22 9.5 L18 21 L6 21 L2 9.5 Z' },
  { id: 'octagon',   name: '八角形', color: '#ef4444',
    path: 'M8 2 H16 L22 8 V16 L16 22 H8 L2 16 V8 Z' },
  { id: 'ring',      name: '圓環', color: '#22c55e', fillRule: 'evenodd',
    path: 'M2,12 A10,10 0 1,0 22,12 A10,10 0 1,0 2,12 Z M6,12 A6,6 0 1,0 18,12 A6,6 0 1,0 6,12 Z' },
  { id: 'semicircle', name: '半圓', color: '#eab308',
    path: 'M2 12 A10 10 0 0 1 22 12 Z' },
  { id: 'cross',     name: '十字', color: '#64748b',
    path: 'M9 2 H15 V9 H22 V15 H15 V22 H9 V15 H2 V9 H9 Z' },
  { id: 'ribbon',    name: '緞帶', color: '#dc2626',
    path: 'M6 2 H18 V22 L12 17 L6 22 Z' },
  { id: 'arrow',     name: '箭頭', color: '#2563eb',
    path: 'M2 10 H14 V5 L22 12 L14 19 V14 H2 Z' },
  { id: 'crescent',  name: '弦月', color: '#6366f1', fillRule: 'evenodd',
    path: 'M2,12 A10,10 0 1,0 22,12 A10,10 0 1,0 2,12 Z M9,12 A8,8 0 1,0 25,12 A8,8 0 1,0 9,12 Z' },
  { id: 'teardrop',  name: '水滴', color: '#0ea5e9',
    path: 'M12 2 C12 2 5 11 5 16 A7 7 0 0 0 19 16 C19 11 12 2 12 2 Z' },
  { id: 'cloud',     name: '雲朵', color: '#94a3b8',
    path: 'M7 18 A5 5 0 0 1 6.5 8.1 A6 6 0 0 1 18 9 A4.5 4.5 0 0 1 17.5 18 Z' },
  { id: 'leaf',      name: '葉子', color: '#16a34a',
    path: 'M4 20 C4 10 12 2 21 3 C20 12 12 20 4 20 Z' },
  { id: 'bolt',      name: '閃電', color: '#facc15',
    path: 'M13 2 L4.5 13.5 H11 L9.5 22 L19.5 9.5 H12.5 Z' },
  { id: 'speech',    name: '對話框', color: '#f472b6',
    path: 'M4 4 H20 A2 2 0 0 1 22 6 V15 A2 2 0 0 1 20 17 H10 L5 21 V17 H4 A2 2 0 0 1 2 15 V6 A2 2 0 0 1 4 4 Z' },
  { id: 'wavyline',  name: '波浪線', color: '#2D7D46',
    path: 'M2 14 C6 6 10 6 12 12 C14 18 18 18 22 10 L22 13 C18 21 14 21 12 15 C10 9 6 9 2 17 Z' },
  { id: 'zigzagline', name: '鋸齒線', color: '#d4a017',
    path: 'M2 16 L7 8 L12 16 L17 8 L22 16 L22 19 L17 11 L12 19 L7 11 L2 19 Z' }
];

function addStickerToCanvas(stickerId) {
  if (!canvas2d) return;
  const def = STICKER_LIBRARY.find(s => s.id === stickerId);
  if (!def) return;

  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();
  const targetSize = Math.min(w, h) * 0.16;
  const scale = targetSize / 24; // 圖形path本身是 0~24 viewBox 座標系
  // 連續加入多個貼紙時，每次都往右下位移，避免每次都疊在正中央同一個位置。位移量
  // 是圖案本身尺寸的70%，確保加第二、三個貼紙時肉眼能立刻看出是分開的圖案，
  // 不用等客人自己拖開才發現——原本只位移18%，圖案彼此重疊太多，看起來像疊成一坨。
  // 位移量算「目前畫布上已經有幾個貼紙」，不能用一個頁面載入時才歸零的模組變數
  // 計數器——否則從草稿還原（畫布上已經有貼紙）之後再新增一個，會跟計數器歸零前
  // 誤判成「這是第一個」，直接疊在既有貼紙正上方。
  const existingStickerCount = canvas2d.getObjects().filter(o => o.name === 'sticker').length;
  const cascade = (existingStickerCount % 5) * (targetSize * 0.7);

  const shape = new fabric.Path(def.path, {
    left: w / 2 + cascade,
    top:  h / 2 + cascade,
    originX: 'center', originY: 'center',
    fill: def.color,
    // 外框線預設關閉（跟原本5款圖案一致），使用者選取該圖層後可在
    // #sticker-color-panel 勾選「顯示外框線」並自訂顏色（見 toggleStickerStroke()）。
    stroke: null,
    strokeWidth: 0,
    fillRule: def.fillRule || 'nonzero',
    scaleX: scale, scaleY: scale,
    selectable: true, evented: true,
    name: 'sticker',
    stickerId: def.id
  });

  canvas2d.add(shape);
  canvas2d.setActiveObject(shape);
  canvas2d.requestRenderAll();

  if (typeof STATE !== 'undefined') {
    STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : STATE.designDataURL;
    STATE.canvasJSON = (typeof getCanvas2DJSON === 'function') ? getCanvas2DJSON() : STATE.canvasJSON;
  }
  if (typeof syncDesignState === 'function') syncDesignState();
  if (typeof renderLayerPanel === 'function') renderLayerPanel();
}

function initStickerPicker() {
  const wrap = document.getElementById('sticker-picker');
  if (!wrap) return;
  wrap.innerHTML = STICKER_LIBRARY.map(s => `
    <button type="button" class="sticker-picker-btn" title="加入${s.name}" onclick="addStickerToCanvas('${s.id}')">
      <svg viewBox="0 0 24 24"><path d="${s.path}" fill="${s.color}" fill-rule="${s.fillRule || 'nonzero'}"></path></svg>
    </button>
  `).join('');
}

// ─── 黑卡：右側「AI 文字產生圖案」面板 ────────────────────────
// 流程：客戶輸入文字描述＋選風格 → 後端組 prompt 呼叫 AI 產生 3 張候選黑白 Q 版圖
// → 客戶點選其中一張 → 前端去背（白色像素透明化，保留內部五官線條）→ 送進既有的
// applyBlackEffectToImage() 轉黑色浮雕、加入畫布。不上傳照片，AI 也不生成整張黑卡。
let blackCardProcessedImg = null; // 快取「去背後、套浮雕前」的來源圖，同一張候選圖不重複去背
let blackCardGenerating   = false; // 防止同一顆按鈕在請求進行中被重複點擊送出
let _blackCardAbortController = null; // 切換商品/重新配置時用來中止尚未完成的 AI 請求

// 商品切換時呼叫：中止還在進行中的黑卡 AI 請求，避免舊請求的回應在使用者已經
// 換到別的商品之後才回來，把候選圖寫進錯誤的商品狀態裡。
function abortBlackCardGeneration() {
  if (_blackCardAbortController) {
    _blackCardAbortController.abort();
    _blackCardAbortController = null;
  }
  blackCardGenerating = false;
}

const BLACK_CARD_STYLE_OPTIONS = [
  { id: 'cute_round',     name: '可愛圓潤', recommended: true },
  { id: 'minimal_line',   name: '簡約圖標' },
  { id: 'premium_emblem', name: '精緻半身' }
];

// 三張候選圖固定對應三種構圖方向（見 server.js BLACK_CARD_PATTERN_COMPOSITION_VARIANTS），
// 前端顯示對應的方案名稱，讓客戶清楚三張的差異不只是隨機微調。
const BLACK_CARD_CANDIDATE_LABELS = ['方案一：可愛正面', '方案二：動作造型', '方案三：精緻半身'];

// 從設計頁初始化 / 從預覽頁返回時呼叫：把 STATE 目前的文字/風格/候選圖同步回畫面，
// 確保「返回設計頁不遺失已選圖案與擺放位置」不只是 canvas 本身，面板顯示也要一致。
function initBlackCardPatternPanel() {
  const promptInput = document.getElementById('black-card-prompt-input');
  if (promptInput) promptInput.value = STATE.blackCardPrompt || '';

  const applyHintEl = document.getElementById('black-card-apply-hint');
  if (applyHintEl) applyHintEl.classList.add('hidden');

  renderBlackCardStylePicker();

  const grid = document.getElementById('black-card-candidates');
  const regenBtn = document.getElementById('black-card-regenerate-btn');
  if (STATE.blackCardCandidates && STATE.blackCardCandidates.length) {
    renderBlackCardCandidates(STATE.blackCardCandidates, STATE.blackCardSelectedImage);
    if (regenBtn) regenBtn.classList.remove('hidden');
  } else {
    if (grid) { grid.innerHTML = ''; grid.classList.add('hidden'); }
    if (regenBtn) regenBtn.classList.add('hidden');
  }

  // 滿版元素／藝術簽名：面板重新顯示對應 UI 狀態；實際物件已經隨 canvasJSON 一起
  // 還原（見 initDesignStep 的 loadCanvas2DJSON），這裡只需要同步控制項本身的顯示。
  renderFullBleedPicker();
  const fullBleedControls = document.getElementById('black-card-fullbleed-controls');
  const fullBleedUploadWrap = document.getElementById('black-card-fullbleed-upload-wrap');
  if (STATE.blackCardFullBleedType) {
    if (STATE.blackCardFullBleedType === 'custom' && !_fullBleedCustomImg) {
      fullBleedUploadWrap?.classList.remove('hidden');
    } else {
      fullBleedControls?.classList.remove('hidden');
    }
    const densitySlider = document.getElementById('fullbleed-density');
    const thicknessSlider = document.getElementById('fullbleed-thickness');
    const reliefSlider = document.getElementById('fullbleed-relief');
    if (densitySlider && STATE.blackCardFullBleedDensity) densitySlider.value = STATE.blackCardFullBleedDensity;
    if (thicknessSlider && STATE.blackCardFullBleedThickness) thicknessSlider.value = STATE.blackCardFullBleedThickness;
    if (reliefSlider && STATE.blackCardFullBleedRelief) reliefSlider.value = STATE.blackCardFullBleedRelief;
  } else {
    fullBleedControls?.classList.add('hidden');
    fullBleedUploadWrap?.classList.add('hidden');
  }

  renderSignatureFontPicker();
  const sigInput = document.getElementById('black-card-signature-input');
  const sigControls = document.getElementById('black-card-signature-controls');
  const sigRemoveBtn = document.getElementById('black-card-signature-remove-btn');
  if (sigInput) sigInput.value = STATE.blackCardSignatureText || '';
  if (STATE.blackCardSignatureText) {
    sigControls?.classList.remove('hidden');
    sigRemoveBtn?.classList.remove('hidden');
    const existing = canvas2d?.getObjects().find(o => o.name === 'black-card-signature');
    const sizeSlider = document.getElementById('signature-size');
    const rotSlider = document.getElementById('signature-rotation');
    if (existing && sizeSlider) sizeSlider.value = existing._signatureSizePct || 47;
    if (existing && rotSlider) rotSlider.value = Math.round(existing.angle || 0);
  } else {
    sigControls?.classList.add('hidden');
    sigRemoveBtn?.classList.add('hidden');
  }
  if (typeof _updateBlackCardSignatureTriggerBrief === 'function') _updateBlackCardSignatureTriggerBrief();
}

function renderBlackCardStylePicker() {
  const wrap = document.getElementById('black-card-style-picker');
  if (!wrap) return;
  wrap.innerHTML = BLACK_CARD_STYLE_OPTIONS.map(s => `
    <div class="cartoon-style-card ${s.id === STATE.blackCardStyle ? 'selected' : ''}"
         data-style="${s.id}" onclick="selectBlackCardStyle('${s.id}')">
      ${s.recommended ? '<div class="black-card-style-recommend">推薦</div>' : ''}
      <div class="cartoon-style-name">${s.name}</div>
    </div>
  `).join('');
}

function selectBlackCardStyle(styleId) {
  STATE.blackCardStyle = styleId;
  document.querySelectorAll('#black-card-style-picker .cartoon-style-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.style === styleId);
  });
}

function fillBlackCardExample(text) {
  const input = document.getElementById('black-card-prompt-input');
  if (input) input.value = text;
  STATE.blackCardPrompt = text;
  input?.focus();
}

function setBlackCardGenerateLoading(on) {
  const btn  = document.getElementById('black-card-generate-btn');
  const text = document.getElementById('black-card-generate-btn-text');
  const load = document.getElementById('black-card-generate-btn-loading');
  if (!btn) return;
  btn.disabled = on;
  text?.classList.toggle('hidden', on);
  load?.classList.toggle('hidden', !on);
}

// err._clientTimeout：前端自己的逾時中止（見 generateBlackCardPatternCandidates），
// 跟「使用者切換商品」同樣是 AbortError，但成因完全不同，必須分開判斷、分開顯示，
// 不能兩種情況都靜默吞掉，也不能都顯示成「連不到伺服器」。
function _blackCardFriendlyError(err) {
  if (location.protocol === 'file:') {
    // 用 file:// 直接開 index.html 時，相對路徑的 fetch('/api/...') 一定連不到伺服器。
    // 2026-08-23部署前總驗收：訊息原本寫死 http://localhost:3777，正式環境網域不會是這個
    // 網址，改成不寫死特定網址的通用說法，本機開發與正式環境都適用。
    return '目前是以檔案模式開啟，AI 圖案製作需要透過網站伺服器開啟才能使用，請改用瀏覽器開啟正式網站網址。';
  }
  if (err._clientTimeout) {
    return '請求逾時，AI 服務可能忙碌或網路不穩定，請稍後再試一次。';
  }
  if (err.name === 'TypeError' || /Failed to fetch/i.test(err.message || '')) {
    return '無法連線到 AI 服務，請確認網路連線正常後再試一次；若持續發生，請聯繫客服協助處理。';
  }
  if (err.status) {
    // 有 HTTP 狀態碼＝伺服器有回應，一律顯示伺服器給的實際訊息，不要統一蓋成單一說法，
    // 否則除錯時完全看不出是額度用完、格式錯誤還是內容審核問題（server.js 已依 401／402／
    // 429／400 moderation／504 timeout 分開回傳對應訊息，這裡直接沿用即可）。
    return err.message || `發生錯誤（狀態碼 ${err.status}），請稍後再試`;
  }
  return err.message || '發生未預期的錯誤，請稍後再試';
}

async function generateBlackCardPatternCandidates() {
  if (blackCardGenerating) return; // 同一顆按鈕的請求進行中，不可重複送出
  const errEl = document.getElementById('black-card-pattern-error');
  if (errEl) errEl.classList.add('hidden');
  const applyHintEl = document.getElementById('black-card-apply-hint');
  if (applyHintEl) applyHintEl.classList.add('hidden');

  const input  = document.getElementById('black-card-prompt-input');
  const prompt = (input?.value || '').trim();

  if (prompt.length < 2 || prompt.length > 80) {
    if (errEl) { errEl.textContent = '請輸入 2～80 字的圖案描述'; errEl.classList.remove('hidden'); }
    return;
  }

  STATE.blackCardPrompt = prompt;
  blackCardGenerating = true;
  setBlackCardGenerateLoading(true);

  // 實測生成時間可能落在 15～45 秒，等超過原本文案的上限還沒完成時，
  // 額外提示「還在處理中」，避免畫面長時間停在同一句話、讓人以為卡住了。
  const loadingTextEl = document.getElementById('black-card-generate-btn-loading');
  const extendedWaitTimer = setTimeout(() => {
    if (loadingTextEl) loadingTextEl.textContent = '還在生成中，AI 繪圖有時較久，請再耐心等候一下……';
  }, 30000);

  // 重新產生時「不清空舊候選圖」：舊的一組會一直留在畫面上，直到這次請求真的成功
  // 才整組換新；失敗的話舊候選圖完全不受影響。避免使用者因為網路錯誤而白白
  // 損失原本已經選好的圖案，被迫重新跑一次整個流程。
  const regenBtn = document.getElementById('black-card-regenerate-btn');
  if (regenBtn) regenBtn.disabled = true; // 生成期間鎖定「重新產生一組」，防止重複扣款

  const thisRequestProductId = STATE.productId; // 用來偵測回應回來時是否已經切換商品
  _blackCardAbortController = new AbortController();

  // 後端自己有 45 秒內部逾時、一定會回傳明確的 504 訊息，這裡的前端逾時只是最後一道
  // 保險——真的遇到連線中斷、回應永遠送不到瀏覽器這種後端管不到的情況時，才由前端
  // 主動中止並顯示「請求逾時」，避免使用者看著載入動畫等到天荒地老、什麼提示都沒有。
  const CLIENT_TIMEOUT_MS = 55000;
  let _clientTimedOut = false;
  const clientTimeoutTimer = setTimeout(() => {
    _clientTimedOut = true;
    _blackCardAbortController.abort();
  }, CLIENT_TIMEOUT_MS);

  // 在請求開始前鎖定這次的匿名關聯（跟 thisRequestProductId 同一時機鎖定），避免等待期間
  // 資料切換；_getAnalyticsContextForRequest() 定義於 configurator.js，跨檔案共用慣例跟
  // 既有 _trackUploadResult() 相同，用 typeof 檢查、不受 script 載入順序影響。
  const _blackCardAnalyticsContext = (typeof _getAnalyticsContextForRequest === 'function') ? _getAnalyticsContextForRequest() : null;

  try {
    const resp = await fetch('/api/black-card-pattern-candidates', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        prompt, style: STATE.blackCardStyle, productId: thisRequestProductId,
        ...( _blackCardAnalyticsContext ? { analyticsContext: _blackCardAnalyticsContext } : {} )
      }),
      signal:  _blackCardAbortController.signal
    });
    clearTimeout(clientTimeoutTimer);
    // 請求送出後，使用者可能已經切到別的商品——這種情況直接忽略回應，
    // 不要把黑卡候選圖寫進現在其實已經是別的商品的 STATE 裡。
    if (STATE.productId !== thisRequestProductId) return;
    const data = await resp.json();
    if (!resp.ok) {
      const err = new Error(data.error || '生成失敗');
      err.status = resp.status;
      throw err;
    }

    const images = data.images || [];
    if (!images.length) throw new Error('AI 沒有產生任何圖案，請調整描述後再試一次');

    // 逐張確認圖片真的能成功 decode、且不是空白/損壞內容，全部完成才顯示候選區，
    // 避免把還沒載入好或格式錯誤的圖片就顯示給使用者選取。
    let decodedImages;
    try {
      decodedImages = await Promise.all(images.map(async (src) => {
        const img = await loadImageEl(src);
        if (!img.naturalWidth || !img.naturalHeight) throw new Error('圖片內容為空');
        return src;
      }));
    } catch (decodeErr) {
      throw new Error('AI 回傳的圖片無法正常載入，請點「重新產生一組」再試一次');
    }

    // decode 期間（非同步）使用者也可能已經切換商品，這裡是寫入 STATE 前的最後一道防線
    if (STATE.productId !== thisRequestProductId) return;

    STATE.blackCardCandidates = decodedImages;
    STATE.blackCardSelectedImage = null;
    renderBlackCardCandidates(decodedImages, null); // 成功才覆蓋舊的一組
    if (regenBtn) regenBtn.classList.remove('hidden');

    if (data.partial && errEl) {
      errEl.textContent = `這次只成功產生 ${decodedImages.length} 張候選圖，可以直接選用，或點「重新產生一組」再試一次`;
      errEl.classList.remove('hidden');
    }

  } catch (err) {
    clearTimeout(clientTimeoutTimer);
    // AbortError 有兩種完全不同的成因，必須分開處理：
    // (1) 使用者主動切換商品——不是錯誤，靜默返回即可（此時多半已經在別的商品頁面了）
    // (2) 前端自己的逾時保護觸發——是真的要讓使用者知道的錯誤，不能被靜默吞掉
    if (err.name === 'AbortError') {
      if (!_clientTimedOut) return;
      err._clientTimeout = true;
    }
    // 失敗時完全不動 grid，舊候選圖（若有）維持原樣可繼續選用。錯誤訊息旁直接
    // 附一顆「重新嘗試」按鈕（跟 Q版肖像 _showCartoonError 的 withRetry 同一種
    // 做法），不用讓使用者自己往上找生成按鈕才能重試。
    if (errEl) {
      errEl.innerHTML = '';
      const msgSpan = document.createElement('span');
      msgSpan.textContent = _blackCardFriendlyError(err);
      errEl.appendChild(msgSpan);
      const retryWrap = document.createElement('div');
      retryWrap.className = 'ai-error-actions';
      const retryBtn = document.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn btn-outline btn-sm';
      retryBtn.textContent = '重新嘗試';
      retryBtn.onclick = generateBlackCardPatternCandidates;
      retryWrap.appendChild(retryBtn);
      errEl.appendChild(retryWrap);
      errEl.classList.remove('hidden');
    }
    if (STATE.blackCardCandidates && STATE.blackCardCandidates.length && regenBtn) {
      regenBtn.classList.remove('hidden'); // 失敗也給「重新產生」的路，不要卡死
    }
  } finally {
    clearTimeout(clientTimeoutTimer);
    clearTimeout(extendedWaitTimer);
    if (loadingTextEl) loadingTextEl.textContent = '正在設計黑卡圖案，通常約 15～45 秒完成……';
    blackCardGenerating = false;
    setBlackCardGenerateLoading(false);
    if (regenBtn) regenBtn.disabled = false;
  }
}

function renderBlackCardCandidates(images, selectedImage) {
  const grid = document.getElementById('black-card-candidates');
  if (!grid) return;
  grid.classList.remove('hidden');
  grid.innerHTML = images.map((src, i) => {
    const isSelected = src === selectedImage;
    const label = BLACK_CARD_CANDIDATE_LABELS[i] || `方案${i + 1}`;
    return `
    <div class="black-card-candidate ${isSelected ? 'selected' : ''}" data-index="${i}"
         tabindex="0" role="button" aria-pressed="${isSelected}" aria-label="候選圖案${i + 1}：${escapeHtml(label)}"
         onclick="selectBlackCardCandidate(${i})"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectBlackCardCandidate(${i});}">
      <div class="black-card-candidate-imgwrap">
        <img src="${src}" alt="候選圖案 ${i + 1}" loading="lazy"
             onerror="this.parentElement.innerHTML='<div class=&quot;black-card-candidate-fail-text&quot;>圖片載入失敗</div>'">
      </div>
      <div class="black-card-candidate-label">${escapeHtml(label)}</div>
    </div>
  `;
  }).join('');
}

// 客戶點選一張候選圖：去背（白色像素透明化，flood-fill 只吃掉與邊緣相連的背景，
// 內部眼睛/嘴巴等封閉區域不會被誤刪）→ 送進既有的黑卡浮雕合成 → 加入畫布。
async function selectBlackCardCandidate(index) {
  const errEl = document.getElementById('black-card-pattern-error');
  if (errEl) errEl.classList.add('hidden');
  const applyHintEl = document.getElementById('black-card-apply-hint');
  if (applyHintEl) applyHintEl.classList.add('hidden');

  const images = STATE.blackCardCandidates || [];
  const src = images[index];
  if (!src || !canvas2d) return;

  document.querySelectorAll('#black-card-candidates .black-card-candidate').forEach((el, i) => {
    el.classList.toggle('selected', i === index);
    el.setAttribute('aria-pressed', i === index ? 'true' : 'false');
  });

  setBlackCardGenerateLoading(true); // 借用同一顆按鈕的 loading 顯示「處理中」
  try {
    STATE.blackCardSelectedImage = src;

    // 候選圖是後端以 background:'transparent' 向 gpt-image-2 要求的結果，本來就應該
    // 已經是乾淨透明背景。只有在「模型這次沒有真的給透明背景」的少數情況（imageHasCleanCutout
    // 檢查不到足夠的透明像素比例）才需要再跑一次色彩式去背當保險，避免對已經乾淨的圖案
    // 做不必要、反而可能傷到細節的二次處理。
    const rawImg = await loadImageEl(src);
    if (imageHasCleanCutout(rawImg)) {
      blackCardProcessedImg = rawImg;
    } else {
      let cleaned = src;
      try {
        cleaned = await removeCartoonBackground(src);
      } catch (bgErr) {
        console.warn('[black-card-bg-removal]', bgErr);
      }
      blackCardProcessedImg = await loadImageEl(cleaned);
    }

    const effectId = (typeof STATE !== 'undefined' && STATE.finishId) || 'emboss_black_standard';

    canvas2d.getObjects().filter(o => o.name === 'black-effect-image').forEach(o => canvas2d.remove(o));

    const obj = applyBlackEffectToImage(blackCardProcessedImg, effectId);
    placeBlackCardEffectObject(obj);
    canvas2d.add(obj);
    canvas2d.setActiveObject(obj);
    canvas2d.renderAll();
    uploadedImage = obj;

    // 額外匯出一張「只有圖案本身」的去背圖，供 3D 預覽/商品照合成做獨立浮雕層用
    if (typeof STATE !== 'undefined') {
      STATE.blackCardPatternDataURL = obj.toDataURL({ format: 'png', multiplier: 2 });
    }
    if (typeof syncDesignState === 'function') syncDesignState();

    if (applyHintEl) applyHintEl.classList.remove('hidden');

  } catch (err) {
    if (errEl) { errEl.textContent = err.message || '圖案套用失敗，請重新選擇或再試一次'; errEl.classList.remove('hidden'); }
  } finally {
    setBlackCardGenerateLoading(false);
  }
}

// ─── 背景色 ──────────────────────────────────────────────
function setBackground2D(color) {
  if (!canvas2d) return;
  if (currentProduct && currentProduct.bgImage) return; // 有外觀底圖的產品（保溫杯、USB等）保留底圖
  const templateBg = canvas2d.getObjects().find(o => o.name === 'template-bg');
  if (templateBg) {
    templateBg.set('fill', color);
    canvas2d.renderAll();
    return;
  }
  canvas2d.setBackgroundColor(color, canvas2d.renderAll.bind(canvas2d));
}

function applyCardBackgroundTemplate2D(template) {
  if (!canvas2d || !template) return;
  if (currentProduct && currentProduct.bgImage) return;

  // 客人在AI插畫背景生效時改點「背景模板」選色系，代表不想要插畫背景了：先移除
  // 插畫、重建可調色的向量背景（白底＋波浪＋圓點），下面原有的上色邏輯才找得到
  // template-bg／template-wave 等物件可以套色。
  const illustration = canvas2d.getObjects().find(o => o.name === 'template-bg-illustration');
  if (illustration) {
    canvas2d.remove(illustration);
    if (typeof _addYangZhuVectorBackground === 'function' && typeof currentProduct !== 'undefined' && currentProduct && ['easycard', 'ipass'].includes(currentProduct.id)) {
      _addYangZhuVectorBackground();
    }
  }

  const bg = canvas2d.getObjects().find(o => o.name === 'template-bg');
  const wave = canvas2d.getObjects().find(o => o.name === 'template-wave');
  const waveLight = canvas2d.getObjects().find(o => o.name === 'template-wave-light');
  const dots = canvas2d.getObjects().filter(o => o.name === 'template-dot');
  const titleMain = canvas2d.getObjects().filter(o => o.name === 'title')[1];

  if (bg) bg.set('fill', template.bg);
  if (wave) wave.set('fill', template.wave);
  if (waveLight) waveLight.set('fill', template.waveLight);
  dots.forEach((dot, index) => {
    dot.set('fill', index % 2 === 0 ? (template.dot || template.waveLight) : (template.dotAlt || template.dot || template.waveLight));
  });
  if (titleMain && !titleMain.__userColor) titleMain.set('fill', template.wave);

  canvas2d.renderAll();
}

// 換造型（形狀）：只有換造型才需要整組背景裝飾物件砍掉重畫（顏色不變的話沒必要
// 重建，_addYangZhuVectorBackground() 本身沒有「只換path不動其他屬性」的局部更新
// 介面）。移除舊的 template-bg/wave/wave-light/dot 後照原樣重建，新的一組物件
// 一樣會被送到最底層，不會插到使用者內容中間；使用者的圖片/文字物件完全沒被碰到。
function applyMaskShape2D(shapeId) {
  if (!canvas2d) return;
  if (typeof STATE !== 'undefined') STATE.backgroundTemplateId = shapeId;
  ['template-bg', 'template-wave', 'template-wave-light', 'template-dot'].forEach(name => {
    canvas2d.getObjects().filter(o => o.name === name).forEach(o => canvas2d.remove(o));
  });
  _addYangZhuVectorBackground({
    bg: (typeof STATE !== 'undefined' && STATE.bgColor) || '#ffffff',
    wave: (typeof STATE !== 'undefined' && STATE.waveColor) || '#2D7D46',
    waveLight: (typeof STATE !== 'undefined' && STATE.waveLightColor) || '#dfead8',
    dot: (typeof STATE !== 'undefined' && STATE.waveLightColor) || '#dfead8',
    dotAlt: (typeof STATE !== 'undefined' && STATE.waveColor) || '#2D7D46'
  });
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

function setTemplateWaveColor2D(kind, color) {
  if (!canvas2d || !color) return;
  const targetName = kind === 'light' ? 'template-wave-light' : 'template-wave';
  const obj = canvas2d.getObjects().find(o => o.name === targetName);
  if (!obj) return;
  obj.set('fill', color);
  canvas2d.renderAll();
}

// ─── Q版風格插畫背景（悠遊卡／一卡通）────────────────────────────
// 客人在AI Q版化選了風格並套用大頭貼後，把手刻波浪／圓點背景換成對應風格的
// 插畫背景圖（assets/card-backgrounds/），取代 addYangZhuCardTemplate() 原本的
// 向量背景。移除波浪／圓點／白底後，setTemplateWaveColor2D（波浪顏色滑桿）會因為
// 找不到對應物件自動安全跳過；但客人若不喜歡插畫、改點「背景模板」選色系，
// applyCardBackgroundTemplate2D() 會偵測到插畫背景並換回可調色的向量背景，
// 不是單純跳過不處理。
const CARTOON_STYLE_CARD_BACKGROUND_FILES = {
  classic_kawaii:  '01_classic_kawaii.png',
  elegant_festive: '02_elegant_festive.png',
  sticker_mascot:  '03_sticker_mascot.png',
  watercolor_soft: '04_soft_watercolor.png'
};

function applyCartoonStyleCardBackground2D(styleId) {
  if (!canvas2d) return;
  if (!(typeof currentProduct !== 'undefined' && currentProduct && ['easycard', 'ipass'].includes(currentProduct.id))) return;

  const safeStyleId = CARTOON_STYLE_CARD_BACKGROUND_FILES[styleId] ? styleId : 'classic_kawaii';
  const fileName = CARTOON_STYLE_CARD_BACKGROUND_FILES[safeStyleId];
  const w = canvas2d.getWidth();
  const h = canvas2d.getHeight();

  fabric.Image.fromURL(`assets/card-backgrounds/${fileName}`, img => {
    if (!canvas2d) return;
    // fromURL在圖片404／載入失敗時仍會呼叫callback，只是img沒有實際內容（width/height為0）。
    // 這種情況直接放棄套用、保留原本畫面，避免卡面被清空變成一片空白又沒有任何提示。
    if (!img.width || !img.height) {
      console.warn('[cartoon-style-bg] 背景圖載入失敗，保留原本背景：', fileName);
      return;
    }

    // 確認新圖真的載入成功後，才清掉手刻的波浪／圓點／白底，以及上一次套用過的插畫背景
    canvas2d.getObjects()
      .filter(o => ['template-bg', 'template-wave', 'template-wave-light', 'template-dot', 'template-bg-illustration'].includes(o.name))
      .forEach(o => canvas2d.remove(o));

    // 圓角裁切不需要在這裡另外處理：_applyCardShellClipPath() 已經對整個 canvas
    // 套用跟這裡完全相同比例的圓角 clipPath（悠遊卡/一卡通共用），這張圖本來就會
    // 被裁到卡片圓角範圍內。物件級 clipPath 純屬多餘，而且 toJSON() 的
    // propertiesToInclude 清單（見 getCanvas2DJSON()）沒有列 clipPath，草稿存檔/
    // 還原也不會保留，加了也是白加。
    const scale = Math.max(w / img.width, h / img.height);
    img.set({
      left: 0, top: 0,
      scaleX: scale, scaleY: scale,
      selectable: false, evented: false,
      name: 'template-bg-illustration'
    });
    canvas2d.add(img);
    canvas2d.sendToBack(img); // card-shell-edge／edgeShade／title/subtitle都是之前就加入的既有物件，維持疊在插畫背景之上
    canvas2d.renderAll();
  });
}

// ─── 取得 DataURL（排除輔助線與虛線框）──────────────────────
function get2DDataURL() {
  if (!canvas2d) return null;
  const originalViewport = canvas2d.viewportTransform ? canvas2d.viewportTransform.slice() : getDefaultViewportTransform();
  canvas2d.setViewportTransform(getDefaultViewportTransform());
  // 只隱藏提示字等操作輔助；商品模板、外觀底圖需保留在匯出圖中。
  const bgObjs = canvas2d.getObjects().filter(o => ['hint'].includes(o.name));
  bgObjs.forEach(o => o.set('visible', false));
  _suppressOverlay = true;
  canvas2d.renderAll();
  const dataURL = canvas2d.toDataURL({ format: 'png', multiplier: 2 });
  _suppressOverlay = false;
  bgObjs.forEach(o => o.set('visible', true));
  canvas2d.setViewportTransform(originalViewport);
  canvas2d.renderAll();
  return dataURL;
}

// ─── Canvas JSON 存取（供返回設計稿時還原使用）─────────────────
// 一定要把 'name' 傳進 toJSON 的 propertiesToInclude，否則 fabric 預設不會序列化這個
// 自訂屬性，還原後就找不到 'black-effect-image'／'black-card-bg' 等靠 name 辨識的物件。
function getCanvas2DJSON() {
  if (!canvas2d) return null;
  // 'baseScale' 是黑卡圖案（black-effect-image）自訂屬性，縮放滑桿用它換算「相對於
  // 預設大小的百分比」；'_signatureSizePct' 是藝術簽名的大小滑桿基準。不列進來的話，
  // 返回設計頁重新載入 JSON 後這些基準會遺失，滑桿會變回顯示令人困惑的原始數值。
  // 'selectable'/'evented'/'hasControls' 同樣要列進來——這是 fabric.js 常見的坑：預設
  // toJSON() 不會序列化這幾個互動屬性，只會序列化外觀/幾何屬性。少了它們，黑卡底色
  // （black-card-bg/noise/edge）跟滿版背景（full-bleed-pattern）原本設好的「不可選取」
  // 在使用者從預覽返回設計稿、觸發一次 JSON 存檔/還原後就會被 fabric 的預設值
  // （selectable:true, evented:true）悄悄蓋掉，變回可以被誤點誤拖的狀態。
  // 'visible'/'lockMovementX/Y'/'lockScalingX/Y'/'lockRotation' 是圖層面板「顯示/隱藏」
  // 「鎖定」功能用到的屬性，同樣不在 fabric 預設序列化清單內，一併補上。
  // 'stickerId' 是圖形素材庫（addStickerToCanvas()）用來反查貼紙名稱顯示在圖層面板的
  // 自訂屬性，不列進來的話，草稿還原後圖層面板會顯示成沒有名字的「裝飾圖形」。
  return canvas2d.toJSON([
    'name', 'baseScale', '_signatureSizePct', 'layerId', 'stickerId',
    'selectable', 'evented', 'hasControls', 'hoverCursor',
    'visible', 'lockMovementX', 'lockMovementY', 'lockScalingX', 'lockScalingY', 'lockRotation'
  ]);
}

function loadCanvas2DJSON(json) {
  if (!canvas2d || !json) return;
  canvas2d.loadFromJSON(json, function() {
    _applyCardShellClipPath();
    canvas2d.renderAll();
    applyDesignFocusView();
    // loadFromJSON 是整批載入，不保證逐一觸發 object:added，離開/返回設計頁時需手動校正一次按鈕狀態
    _refreshBlackCardNextButton();
    _restoreSelectedLayerFromState();
  });
}

// 依 init2DCanvas() 一開始存下的 _pendingRestoreLayerId 還原選取狀態（重新整理／返回修改／
// 切商品再返回都會走這裡）——不能改讀當下的 STATE.selectedLayerId，因為畫布重建過程本身
// 會把它暫時同步成 null（見 _pendingRestoreLayerId 宣告處說明）。找不到對應圖層（該圖層
// 已被刪除，或這份草稿是舊格式沒有 layerId）就清成 null，不強行選取任何東西。
function _restoreSelectedLayerFromState() {
  const wantId = _pendingRestoreLayerId;
  _pendingRestoreLayerId = null;
  if (!wantId || !canvas2d || typeof STATE === 'undefined') return;
  const target = canvas2d.getObjects().find(o => o.layerId === wantId);
  if (target) {
    canvas2d.setActiveObject(target);
    canvas2d.requestRenderAll();
    STATE.selectedLayerId = wantId;
  } else {
    STATE.selectedLayerId = null;
  }
}

function _refreshBlackCardNextButton() {
  if (typeof updateStep3NextButtonState === 'function') updateStep3NextButtonState();
  renderLayerPanel();
  updateBlackCardTabBadges();
}

// ─── 右側工具頁籤（黑卡：主圖案／滿版紋理／藝術簽名）────────────
function switchDesignTab(name) {
  document.querySelectorAll('#black-card-tabs .wb-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('#black-card-pattern-panel .wb-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tabpanel === name);
  });
}

// 悠遊卡／一卡通右側面板：「一般照片」／「Q版照片」分頁，跟上面 switchDesignTab()
// 是同一套 wb-tabs 元件，只是換一組容器 id（#photo-upload-tabs／#q-avatar-panel），
// 避免跟黑卡那組選取器互相影響。
function switchUploadTab(name) {
  document.querySelectorAll('#photo-upload-tabs .wb-tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === name);
  });
  document.querySelectorAll('#q-avatar-panel .wb-tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.tabpanel === name);
  });
}

// 頁籤上的完成狀態小圓點：沿用 hasPrintableDesign() 判斷同一批物件名稱，
// 已套用內容的頁籤圓點會變成金色，讓使用者一眼看出還缺哪一類設計
function updateBlackCardTabBadges() {
  if (!canvas2d || typeof STATE === 'undefined' || STATE.productId !== 'black_card') return;
  const objs = canvas2d.getObjects().filter(o => o.visible !== false);
  const hasPattern   = objs.some(o => o.name === 'black-effect-image');
  const hasFullBleed = objs.some(o => o.name === 'full-bleed-pattern');
  const hasSignature = objs.some(o => o.name === 'black-card-signature' && (o.text || '').trim());
  const map = { pattern: hasPattern, fullbleed: hasFullBleed, signature: hasSignature };
  Object.keys(map).forEach(key => {
    const btn = document.getElementById('wb-tab-btn-' + key);
    if (btn) btn.classList.toggle('tab-complete', map[key]);
  });
}

// ─── 圖層面板：選取／顯示隱藏／鎖定／刪除 ─────────────────────
// 只列出對使用者有意義的內容物件（沿用既有命名慣例，跟 hasPrintableDesign() 判斷同一批），
// 底色/雜訊/邊框/裁切用的輔助物件（black-card-bg 等）不算「圖層」，不列出。
let _layerPanelObjects = [];
function _layerObjectLabel(o) {
  if (o.name === 'title') return (o.text || '').trim() ? `主標題：${o.text}` : '主標題文字';
  if (o.name === 'subtitle') return (o.text || '').trim() ? `副標題：${o.text}` : '副標題文字';
  if (o.name === 'black-effect-image') return 'AI 主圖案';
  if (o.name === 'full-bleed-pattern') return '滿版紋理';
  if (o.name === 'ai-generate-background') return 'AI 生成背景';
  if (o.name === 'black-card-signature') return (o.text || '').trim() ? `藝術簽名：${o.text}` : '藝術簽名';
  if (o.name === 'thermos-signature') return (o.text || '').trim() ? `藝術簽名：${o.text}` : '藝術簽名';
  if (o.name === 'thermos-demo-logo') return 'Logo 圖形';
  if (o.name === 'sticker') {
    const def = (typeof STICKER_LIBRARY !== 'undefined') ? STICKER_LIBRARY.find(s => s.id === o.stickerId) : null;
    return def ? `裝飾圖形：${def.name}` : '裝飾圖形';
  }
  if (o.type === 'image') return '上傳圖片';
  return o.name || o.type || '物件';
}
// 圖層穩定識別碼：四商品共用同一套（跟 name 不同，name 在悠遊卡/一卡通模板等情境下
// 可能重複，例如兩行標題都叫 'title'），只在物件第一次進到圖層面板時補發一次，之後
// 隨 getCanvas2DJSON()／loadCanvas2DJSON() 一起序列化/還原，讓 STATE.selectedLayerId
// 能在重新整理／返回修改後仍指向同一個圖層。
let _layerIdCounter = 0;
function _ensureLayerId(o) {
  if (!o.layerId) o.layerId = 'ly_' + Date.now().toString(36) + '_' + (_layerIdCounter++);
  return o.layerId;
}

function renderLayerPanel() {
  const wrap = document.getElementById('layer-panel');
  if (!wrap || !canvas2d) return;
  const LAYER_NAMES = ['title', 'subtitle', 'black-effect-image', 'full-bleed-pattern', 'black-card-signature', 'thermos-signature', 'thermos-demo-logo', 'sticker'];
  _layerPanelObjects = canvas2d.getObjects().filter(o =>
    LAYER_NAMES.includes(o.name) || (o.type === 'image' && !['product-bg', 'hint'].includes(o.name))
  );
  _layerPanelObjects.forEach(_ensureLayerId);

  const active = canvas2d.getActiveObject();
  // 目前選取的圖層 id 同步進 STATE，隨草稿一併保存／還原；選取的不是圖層面板管理的物件
  // （或沒有選取任何東西）時清成 null，不殘留上一次選取的舊 id。
  if (typeof STATE !== 'undefined') {
    STATE.selectedLayerId = (active && _layerPanelObjects.includes(active)) ? active.layerId : null;
  }

  if (!_layerPanelObjects.length) {
    wrap.innerHTML = '<div class="layer-panel-empty">尚未加入任何內容</div>';
    // 早退時也要同步「刪除選取」等按鈕狀態（例如黑卡全新空白畫布：完全沒有圖層
    // 可選，按鈕理應停用），不能只靠下面的路徑更新，否則黑卡會漏掉這次更新。
    if (typeof _updateThermosFullBleedBtnState === 'function') _updateThermosFullBleedBtnState();
    _updateLayerToolButtonStates();
    return;
  }
  const eyeOpenSvg  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const eyeOffSvg   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 3l18 18M10.6 10.6a3 3 0 004.24 4.24M6.6 6.7C4 8.3 2 12 2 12s3.6 7 10 7c1.7 0 3.2-.4 4.5-1.1M17.5 17.4C20 15.7 22 12 22 12s-1.4-2.7-4-4.6"/></svg>';
  const lockSvg     = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 018 0v4"/></svg>';
  const unlockSvg   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 017.6-1.8"/></svg>';
  const trashSvg    = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13a1 1 0 001 1h6a1 1 0 001-1l1-13"/></svg>';
  const toFrontSvg  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 20V7M6 12l6-6 6 6"/><path d="M4 3.5h16"/></svg>';
  const toBackSvg   = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 4v13M6 12l6 6 6-6"/><path d="M4 20.5h16"/></svg>';

  wrap.innerHTML = _layerPanelObjects.map((o, i) => {
    const isVisible = o.visible !== false;
    const isLocked = !!o.lockMovementX;
    return `
      <div class="layer-row ${o === active ? 'active' : ''} ${isVisible ? '' : 'layer-hidden'}">
        <span class="layer-row-name" onclick="layerSelect(${i})" title="點選以在畫布上選取">${escapeHtml(_layerObjectLabel(o))}</span>
        <button type="button" class="layer-btn" onclick="layerBringToFront(${i})" title="移到最上層" aria-label="移到最上層">${toFrontSvg}</button>
        <button type="button" class="layer-btn" onclick="layerSendToBack(${i})" title="移到最下層" aria-label="移到最下層">${toBackSvg}</button>
        <button type="button" class="layer-btn ${isVisible ? 'on' : ''}" onclick="layerToggleVisible(${i})" title="顯示／隱藏" aria-label="顯示／隱藏">${isVisible ? eyeOpenSvg : eyeOffSvg}</button>
        <button type="button" class="layer-btn ${isLocked ? 'on' : ''}" onclick="layerToggleLock(${i})" title="鎖定／解鎖" aria-label="鎖定／解鎖">${isLocked ? lockSvg : unlockSvg}</button>
        <button type="button" class="layer-btn" onclick="layerDelete(${i})" title="刪除" aria-label="刪除此圖層">${trashSvg}</button>
      </div>`;
  }).join('');
  if (typeof _updateThermosFullBleedBtnState === 'function') _updateThermosFullBleedBtnState();
  _updateLayerToolButtonStates();
}

// 圖層工具統一停用邏輯：沒有選取任何「可操作圖層」時（沒選東西，或選到的是模板背景
// template- 這類不可操作物件），刪除選取／置中／水平置中／垂直置中／縮放全部停用，
// 並顯示同一句原因，避免使用者點了沒反應卻搞不清楚是按鈕壞了還是自己沒選對東西。
// 縮放滑桿所在的 #mobile-scale-bar 本身在沒有選取時就是整個隱藏（_hideScaleBar()），
// 這裡另外加 disabled 屬性是防禦性保險，不影響既有的顯示/隱藏機制。
// 「旋轉」沒有獨立按鈕——只能透過畫布上選取物件才會出現的原生旋轉控制點操作，天生
// 就只有選到東西才摸得到，不需要額外的停用邏輯。滿版鋪滿選取圖片是保溫杯專屬工具，
// 需要「選到的剛好是圖片」這個更嚴格的條件，維持原本 _updateThermosFullBleedBtnState()
// 的獨立判斷與提示文字，不套用這裡的統一訊息。
function _updateLayerToolButtonStates() {
  const active = canvas2d ? canvas2d.getActiveObject() : null;
  const hasUsableSelection = !!active && !(typeof active.name === 'string' && active.name.startsWith('template-'));

  const deleteBtn = document.getElementById('delete-selected-btn');
  if (deleteBtn) deleteBtn.disabled = !hasUsableSelection;
  const deleteHint = document.getElementById('delete-selected-hint');
  if (deleteHint) deleteHint.classList.toggle('hidden', hasUsableSelection);

  ['align-center-btn', 'align-h-btn', 'align-v-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = !hasUsableSelection;
  });
  const alignHint = document.getElementById('canvas-align-tools-hint');
  if (alignHint) alignHint.classList.toggle('hidden', hasUsableSelection);

  const scaleSlider = document.getElementById('scale-slider');
  if (scaleSlider) scaleSlider.disabled = !hasUsableSelection;
  const scaleBarDeleteBtn = document.querySelector('#mobile-scale-bar button.btn-danger');
  if (scaleBarDeleteBtn) scaleBarDeleteBtn.disabled = !hasUsableSelection;
}
function layerSelect(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  canvas2d.setActiveObject(o);
  canvas2d.requestRenderAll();
  renderLayerPanel();
  // 手機版：從「圖層管理」分頁點選圖層後，自動切到「設計預覽」分頁，讓使用者
  // 立刻看到畫布上的選取狀態，並能直接使用縮放滑桿／置中等工具（兩者都在
  // 「設計預覽」分頁內），不需要使用者自己再手動切換分頁才找得到。
  if (typeof setMobileDesignGroup === 'function') setMobileDesignGroup('preview');
}

// 保溫杯專屬：「滿版鋪滿選取圖片」只有在選取到一張已上傳圖片時才可操作，未選取
// 圖片圖層時停用並顯示原因說明（不得套用到文字/藝術簽名圖層——fillCanvasWithSelectedImage()
// 本身已經用 obj.type==='image' 擋掉，這裡只是同步按鈕的可操作狀態與提示文字）。
function _updateThermosFullBleedBtnState() {
  if (typeof STATE === 'undefined' || STATE.productId !== 'thermos') return;
  const btn = document.getElementById('thermos-fullbleed-btn');
  if (!btn) return;
  const hint = document.getElementById('thermos-fullbleed-hint');
  const active = canvas2d ? canvas2d.getActiveObject() : null;
  const isImage = !!active && active.type === 'image';
  btn.disabled = !isImage;
  if (hint) hint.classList.toggle('hidden', isImage);
}
function layerToggleVisible(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  o.visible = o.visible === false;
  // 隱藏的物件如果剛好是目前選取中的，畫布控制點(選取框/縮放旋轉手把)不會
  // 因為 visible=false 自動消失——Fabric 的控制點繪製跟物件本身的顯示是分開
  // 兩條邏輯，只設 visible 不會連帶取消選取，所以要手動 discardActiveObject()。
  if (!o.visible && canvas2d.getActiveObject() === o) {
    canvas2d.discardActiveObject();
  }
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
  _refreshBlackCardNextButton();
}
// 卡面自己的背景裝飾（外觀底圖／向量波浪造型）永遠要墊在使用者內容最底下，
// 不然「移到最下層」會把使用者的圖片/文字整個蓋到背景色塊之下、直接消失不見。
// 沿用 keepAboveProductBg() 同一組判斷條件（product-bg／template- 開頭），差別是
// 這裡要處理「一次把所有背景裝飾物件都墊回最底」，不只單一個 bg 矩形。
function _keepBackgroundLayersAtBack() {
  if (!canvas2d) return;
  canvas2d.getObjects()
    .filter(o => o.name === 'product-bg' || (typeof o.name === 'string' && o.name.indexOf('template-') === 0))
    .forEach(o => canvas2d.sendToBack(o));
}
function layerBringToFront(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  canvas2d.bringToFront(o);
  canvas2d.requestRenderAll();
  renderLayerPanel();
  if (typeof syncDesignState === 'function') syncDesignState();
}
function layerSendToBack(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  canvas2d.sendToBack(o);
  _keepBackgroundLayersAtBack();
  canvas2d.requestRenderAll();
  renderLayerPanel();
  if (typeof syncDesignState === 'function') syncDesignState();
}
function layerToggleLock(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  const lock = !o.lockMovementX;
  o.set({ lockMovementX: lock, lockMovementY: lock, lockScalingX: lock, lockScalingY: lock, lockRotation: lock });
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
  renderLayerPanel();
}
// 刪除單一圖層屬於危險操作（點錯就會弄丟客人調整好的照片/文字位置），跟「清空
// 目前卡面」一樣加二次確認，先跳出確認視窗，實際刪除移到 _performLayerDelete()、
// 等使用者按下確認才執行（見 index.html #layer-delete-modal、configurator.js
// _openLayerDeleteModal()／_confirmLayerDeleteModal()）。
function layerDelete(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  if (typeof _openLayerDeleteModal === 'function') {
    _openLayerDeleteModal(i, _layerObjectLabel(o));
  } else {
    _performLayerDelete(i); // 防呆：確認視窗的函式意外不存在時退回直接刪除，不讓刪除鍵整個失效
  }
}

function _performLayerDelete(i) {
  const o = _layerPanelObjects[i];
  if (!canvas2d || !o) return;
  canvas2d.remove(o);
  canvas2d.requestRenderAll();
  if (o.name === 'black-effect-image' && typeof STATE !== 'undefined') STATE.blackCardPatternDataURL = null;
  if (typeof syncDesignState === 'function') syncDesignState();
}

// 「清空目前卡面」屬於危險操作，加二次確認降低誤觸機率。改用頁面內 DOM 對話框
// （見 index.html #clear-canvas-modal、configurator.js openClearCanvasModal()）取代
// 原生 window.confirm()，理由跟「刪除此商品草稿」的確認視窗一致：原生
// confirm() 會卡住整個分頁的 JS 執行緒，自動化測試工具需要另外處理原生對話框
// 事件才能繼續操作；改成一般 DOM 元素後可以像操作任何按鈕一樣點擊取消/確認。
function confirmClear2D() {
  if (typeof openClearCanvasModal === 'function') openClearCanvasModal();
}

// ─── 取得乾淨 Canvas Element（不含虛線框，供 3D 貼圖用）──────
function get2DCanvas() {
  if (!canvas2d) return null;
  const originalViewport = canvas2d.viewportTransform ? canvas2d.viewportTransform.slice() : getDefaultViewportTransform();
  canvas2d.setViewportTransform(getDefaultViewportTransform());
  const bgObjs = canvas2d.getObjects().filter(o => ['hint'].includes(o.name));
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
  canvas2d.setViewportTransform(originalViewport);
  canvas2d.renderAll();
  return copy;
}

// ─── 黑卡：預覽頁改為「攝影棚黑卡」渲染（第四輪重新設計）──────────────
// 舊版把整張設計稿快照透視貼到深色木桌/皮革商品照上：AI 人像經整張畫布攤平＋
// 透視變形後被壓成一小塊、外圍又帶著畫布本身的方形卡面底色，看起來像貼紙／
// 徽章，木桌與厚重邊框还搶走視覺焦點。改成不依賴任何商品照素材、純 DOM/CSS
// 呈現的薄型黑色 PVC 卡：卡片本體、霧面紋理、圓角、投影全部用 CSS 畫出來，
// AI 圖案直接拿後端已清乾淨 alpha 的原始去背圖（STATE.blackCardSelectedImage）
// 當 CSS mask 遮罩，用兩層 drop-shadow（左上高光／右下陰影）做出壓印/浮雕的
// 光影層次，而不是把黑色圖片直接以 opacity 蓋在黑色卡片上（那樣顏色相同、
// 完全糊在一起看不出圖案）。

// 五種印刷效果對應的「壓印光影」參數：亮黑對比最強、加一道鏡面反光；霧黑同色調、
// 反光最弱；三種浮雕深淺只差在高光/陰影的偏移量與強度，愈深偏移愈大、對比愈明顯，
// 但仍維持柔和、不做成厚貼紙的生硬描邊。
// 第五輪微調：左上高光 +15%、右下陰影 +10%（只加強輪廓邊緣的高低差，
// base 主體填色刻意不變，避免整張人物一起變亮）。
// 第六輪微調：高光/陰影再加強、邊緣模糊縮小（更銳利），讓頭髮、眼鏡、耳環這類
// 細節邊緣的辨識度提高；base（主體填色）與 shOff（偏移深度）刻意不動，維持
// 「只加強邊緣局部對比、不整片提亮」的原則，不做成整片圓形亮區。
//
// 5種工藝的實際數值由 js/black-card-finish.js 的 blackCardPreviewParams() 統一提供
// （跟 Step3 設計畫布共用同一份物理描述來源，兩邊材質感受才會同步變化，不會各調各的）。

// 卡片版面規則集中放這裡，之後要調視覺只改數字，不用到處找魔術數字。
// 圖案本身的大小/位置/旋轉第七輪起改為直接讀取編輯畫布上的實際物件狀態
// （見下方 _drawBlackCardStudioPreview），不再套用這裡的固定比例；只有完全
// 找不到物件時才會用到函式內建的備援版面。
const BLACK_CARD_PREVIEW_LAYOUT = {
  widthRatio: 0.80,                 // 卡片寬度占攝影棚容器寬度（規格：75%～85%）
  rotationDeg: -10,                 // 規格：-8°～-12°
  cornerRatioOfWidth: 3.18 / 85.6   // ISO/IEC 7810 ID-1 卡片圓角比例
};

let _bcPreviewRafId = null;

// ─── 成品預覽視角切換（正視／斜視／浮雕特寫）───────────────────
// 第八輪重新設計：正視／斜視改用真正的 3D 傾斜（rotateX/rotateY，搭配
// .black-card-stage 既有的 perspective），斜視會有明顯透視收縮＋其中一角
// 「抬起」的效果，不再只是平面 rotate()。浮雕特寫改用 transform-origin
// 把縮放焦點移到卡面右上局部區域，是真的裁切放大局部紋理，不是整卡等比
// 放大同一張平面圖。三種模式都不影響卡面內任何圖層的定位公式（人像/滿版/
// 簽名的座標換算全部套在卡片自己的座標系內，外層 transform 不會讓它們跑位）。
let _blackCardPreviewAngle = 'oblique';

// 浮雕特寫底下再細分「主圖案／文字／簽名」三個特寫子選項，預設對準主圖案
// （滿版紋理或 AI 圖案，沒有的話退回卡面右上通用位置）。焦點座標一律即時
// 讀取 canvas2d 上對應物件目前的實際位置換算，不是寫死的固定裁切座標——
// 使用者在設計稿移動過簽名/文字/圖案後，重新進預覽會自動對準新位置。
let _blackCardCloseupTarget = 'pattern';
function _blackCardCloseupOrigin(target) {
  const fallback = { originX: 68, originY: 32 };
  if (typeof canvas2d === 'undefined' || !canvas2d) return fallback;
  const cw = canvas2d.getWidth(), ch = canvas2d.getHeight();
  if (!cw || !ch) return fallback;
  const clampPct = v => Math.min(92, Math.max(8, v));

  if (target === 'text') {
    const texts = canvas2d.getObjects().filter(o => (o.name === 'title' || o.name === 'subtitle') && (o.text || '').trim());
    if (!texts.length) return fallback;
    const rects = texts.map(o => o.getBoundingRect(true, true));
    const minX = Math.min(...rects.map(r => r.left));
    const maxX = Math.max(...rects.map(r => r.left + r.width));
    const minY = Math.min(...rects.map(r => r.top));
    const maxY = Math.max(...rects.map(r => r.top + r.height));
    return {
      originX: clampPct((minX + maxX) / 2 / cw * 100),
      originY: clampPct((minY + maxY) / 2 / ch * 100)
    };
  }

  let obj = null;
  if (target === 'signature') {
    obj = canvas2d.getObjects().find(o => o.name === 'black-card-signature' && (o.text || '').trim());
  } else { // 'pattern'：AI 圖案優先，沒有的話用滿版紋理
    obj = canvas2d.getObjects().find(o => o.name === 'black-effect-image') ||
          canvas2d.getObjects().find(o => o.name === 'full-bleed-pattern');
  }
  if (!obj) return fallback;
  const center = obj.getCenterPoint();
  return { originX: clampPct(center.x / cw * 100), originY: clampPct(center.y / ch * 100) };
}

// 簽名本身通常比主圖案窄很多（幾個字的手寫字，遠比 AI 圖案/滿版紋理常見的
// 卡面寬度佔比小），同樣的特寫倍率下更容易讓筆觸貼邊甚至被裁到框外；簽名
// 特寫縮小一點，讓完整簽名連同四周至少 10~15% 的黑卡材質都留在框內，
// 主圖案／文字特寫維持原本強度不變。
function _blackCardCloseupScale(target) {
  return target === 'signature' ? 5.0 : 2.3;
}
function _blackCardAngleParams(mode) {
  if (mode === 'front')   return { deg: 0,  scale: 1,   rx: 0, ry: 0,   originX: 50, originY: 50 };
  if (mode === 'closeup') {
    const o = _blackCardCloseupOrigin(_blackCardCloseupTarget);
    return { deg: -2, scale: _blackCardCloseupScale(_blackCardCloseupTarget), rx: 3, ry: -8, originX: o.originX, originY: o.originY };
  }
  return { deg: -4, scale: 1, rx: 8, ry: -20, originX: 50, originY: 50 }; // oblique：真透視＋一角抬起
}
function _applyBlackCardAngleTransform(card, mode, extraRx, extraRy) {
  const p = _blackCardAngleParams(mode);
  card.style.transformOrigin = p.originX + '% ' + p.originY + '%';

  // transform-origin 只會讓該點在螢幕上的位置「固定不動」，不會自動把它移到
  // 畫面正中央——特寫焦點（例如靠邊放置的簽名）離卡片中心越遠，縮放後裁切
  // 框就越不對稱（近的一側很快就被裁掉，遠的一側留一大片空白）。這裡額外
  // 算一個「把焦點移到 stage 正中央」的位移，用 translate() 補在 scale 之後
  // （CSS transform 靠右的函式先套用、靠左的後套用：先用 transform-origin 定
  // 的焦點縮放，再整體平移，平移量是螢幕像素、不會被 scale 放大）。
  let translatePart = '';
  if (mode === 'closeup' && p.scale > 1 && card.parentElement) {
    const stageRect = card.parentElement.getBoundingClientRect();
    const cardW = parseFloat(card.dataset.cardW) || card.offsetWidth;
    const cardH = parseFloat(card.dataset.cardH) || card.offsetHeight;
    if (stageRect.width && cardW && cardH) {
      const cardLeft = stageRect.left + (stageRect.width - cardW) / 2;
      const cardTop  = stageRect.top  + (stageRect.height - cardH) / 2;
      const originScreenX = cardLeft + (p.originX / 100) * cardW;
      const originScreenY = cardTop  + (p.originY / 100) * cardH;
      const stageCenterX = stageRect.left + stageRect.width / 2;
      const stageCenterY = stageRect.top  + stageRect.height / 2;
      const tx = stageCenterX - originScreenX;
      const ty = stageCenterY - originScreenY;
      translatePart = `translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) `;
    }
  }

  card.style.transform = `${translatePart}rotate(${p.deg}deg) scale(${p.scale}) rotateX(${p.rx + (extraRx || 0)}deg) rotateY(${p.ry + (extraRy || 0)}deg)`;
}
function setBlackCardPreviewAngle(mode) {
  _blackCardPreviewAngle = mode;
  document.querySelectorAll('#preview-angle-tools .align-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.angle === mode);
  });
  document.getElementById('preview-closeup-subtools')?.classList.toggle('hidden', mode !== 'closeup');
  // 記錄使用者主動選擇的視角，跟其他商品共用同一個 STATE 欄位，讓重新整理／返回修改／
  // 切商品再返回都能維持在同一個角度（見 configurator.js 的 initPreviewStep()）。
  if (typeof STATE !== 'undefined') {
    STATE.previewAngle = mode;
    if (typeof scheduleSaveDesign === 'function') scheduleSaveDesign();
  }
  const card = document.querySelector('.black-card');
  if (!card) return;
  _applyBlackCardAngleTransform(card, mode);
}
// 特寫子選項切換：只改 Step4 這裡的 transform-origin/scale（純渲染層），
// 完全不觸碰畫布上任何物件的實際位置/縮放，符合「特寫切換不可改變設計
// 元素的實際位置或縮放」的要求。
function setBlackCardCloseupTarget(target) {
  _blackCardCloseupTarget = target;
  document.querySelectorAll('#preview-closeup-subtools .align-btn-sm').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.closeup === target);
  });
  const card = document.querySelector('.black-card');
  if (card) _applyBlackCardAngleTransform(card, 'closeup');
}

// 離開黑卡預覽（切商品／回設計頁／離開 Step 4）時呼叫，停止滑鼠光影互動的
// requestAnimationFrame 迴圈，避免背景持續佔用資源或疊加多個迴圈。
function stopBlackCardPreviewAnimation() {
  if (_bcPreviewRafId !== null) {
    cancelAnimationFrame(_bcPreviewRafId);
    _bcPreviewRafId = null;
  }
}

function _loadImageOrNull(src, cb) {
  if (!src) { cb(null); return; }
  const img = new Image();
  img.onload  = () => cb(img);
  img.onerror = () => cb(null);
  img.src = src;
}

// onComplete（選填）：這次商品照式預覽真正畫完時呼叫（等artImg／patternImg都載入
// 完成、_drawBlackCardStudioPreview()整個DOM都建好之後），供preview_complete事件追蹤
// 使用，不影響原本渲染邏輯。
function renderBlackCardPhotoPreview(containerId, onComplete) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const artSrc = (typeof STATE !== 'undefined' && STATE.blackCardSelectedImage) || null;
  const patternSrc = (typeof STATE !== 'undefined' && STATE.blackCardFullBleedDataURL) || null;

  _loadImageOrNull(artSrc, artImg => {
    _loadImageOrNull(patternSrc, patternImg => {
      _drawBlackCardStudioPreview(container, artImg, patternImg);
      if (typeof onComplete === 'function') onComplete();
    });
  });
}

function _drawBlackCardStudioPreview(container, artImg, patternImg) {
  stopBlackCardPreviewAnimation();

  const finishId = (typeof STATE !== 'undefined' && STATE.finishId) || 'emboss_black_standard';
  const params = blackCardPreviewParams(finishId);
  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  container.innerHTML = '';
  container.style.position   = 'relative';
  container.style.overflow   = 'hidden';
  // 精品攝影棚背景：低彩度暖灰放射狀漸層（無縫背景紙棚拍效果的暖色調版本，
  // R>G>B 維持偏暖，取代先前偏冷灰的色階），襯托黑卡本身同時不搶焦，
  // 不使用木桌/皮革等場景素材。
  container.style.background = 'radial-gradient(circle at 42% 30%, #726a5f 0%, #4f483e 55%, #26221d 100%)';

  const stage = document.createElement('div');
  stage.className = 'black-card-stage';
  container.appendChild(stage);

  // 接觸陰影：卡片正下方的柔和橢圓落影，跟卡體 box-shadow 的大範圍環境陰影
  // 分開，尺寸依卡片實際大小設定（見下方 finalW/finalH 算出後補寬高）。
  const contactShadow = document.createElement('div');
  contactShadow.className = 'black-card-contact-shadow';
  stage.appendChild(contactShadow);

  const card = document.createElement('div');
  card.className = 'black-card' + (params.specular ? ' black-card-specular' : '');
  stage.appendChild(card);

  // 卡緣厚度暗邊：優先插入，確保 DOM 順序在卡體背景之上、圖案/文字/簽名之下
  const thickness = document.createElement('div');
  thickness.className = 'black-card-thickness';
  card.appendChild(thickness);

  const boxW = container.clientWidth || 480;
  const boxH = Math.max(container.clientHeight || 0, 380);

  // 卡片占容器寬度 75%～85%；若容器很扁（手機橫幅），改用高度反推寬度，
  // 確保任何容器尺寸下卡片都完整顯示、不被裁切。
  let finalW = boxW * BLACK_CARD_PREVIEW_LAYOUT.widthRatio;
  let finalH = finalW * (54 / 85.6);
  if (finalH > boxH * 0.86) {
    finalH = boxH * 0.86;
    finalW = finalH * (85.6 / 54);
  }
  const cornerRadius = finalW * BLACK_CARD_PREVIEW_LAYOUT.cornerRatioOfWidth;

  contactShadow.style.width  = (finalW * 0.86) + 'px';
  contactShadow.style.height = Math.max(10, finalH * 0.16) + 'px';

  card.style.width        = finalW + 'px';
  card.style.height       = finalH + 'px';
  card.style.borderRadius = cornerRadius + 'px';
  // 卡片未變形前的實際寬高，供 _applyBlackCardAngleTransform() 的浮雕特寫
  // 置中位移計算使用（transform-origin 只會固定「該點在螢幕上的位置不動」，
  // 不會自動把該點移到畫面正中央，兩者是不同的事——縮放時若不額外位移，
  // 特寫焦點越靠近卡片邊緣，裁切框就會越不對稱）。
  card.dataset.cardW = finalW;
  card.dataset.cardH = finalH;
  card.style.setProperty('--bc-base-alpha', params.base);
  card.style.setProperty('--bc-hi-alpha',   params.hiA);
  card.style.setProperty('--bc-hi-blur',    params.hiBlur + 'px');
  card.style.setProperty('--bc-sh-alpha',   params.shA);
  card.style.setProperty('--bc-sh-blur',    params.shBlur + 'px');
  card.style.setProperty('--bc-sh-off',     params.shOff + 'px');
  _applyBlackCardAngleTransform(card, _blackCardPreviewAngle);
  document.querySelectorAll('#preview-angle-tools .align-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.angle === _blackCardPreviewAngle);
  });
  document.getElementById('preview-closeup-subtools')?.classList.toggle('hidden', _blackCardPreviewAngle !== 'closeup');
  document.querySelectorAll('#preview-closeup-subtools .align-btn-sm').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.closeup === _blackCardCloseupTarget);
  });

  // 卡緣厚度側邊（左右各一條窄暗帶，接近卡片實際厚度 1mm 換算比例），
  // 搭配上面新的 rotateX/rotateY 真透視，斜視時其中一側會因為背光而更明顯，
  // 呈現真實卡片的側面厚度感，不是純平面貼圖。
  const mmToPx = finalW / 85.6;
  const edgeThicknessPx = Math.max(2, mmToPx * 1.0);
  const sideR = document.createElement('div');
  sideR.className = 'black-card-side-edge black-card-side-edge-r';
  sideR.style.width = edgeThicknessPx + 'px';
  card.appendChild(sideR);
  const sideL = document.createElement('div');
  sideL.className = 'black-card-side-edge black-card-side-edge-l';
  sideL.style.width = edgeThicknessPx + 'px';
  card.appendChild(sideL);

  // 滿版元素圖案：先於 AI 人像加入（DOM 順序＝疊層順序，先加的在下面），
  // 讀取編輯畫布上 'full-bleed-pattern' 物件的實際位置/縮放/旋轉，同樣換算成
  // 卡面座標百分比；clipPath 已在畫布端裁到卡片圓角範圍內，這裡的物件尺寸
  // 本身就已經是裁切後的安全區大小，不需要再另外裁切。
  if (patternImg && patternImg.naturalWidth && patternImg.naturalHeight) {
    const liveObj = (typeof canvas2d !== 'undefined' && canvas2d)
      ? canvas2d.getObjects().find(o => o.name === 'full-bleed-pattern')
      : null;
    if (liveObj && canvas2d) {
      const pat = document.createElement('div');
      pat.className = 'black-card-art black-card-pattern';
      const cw = canvas2d.getWidth(), ch = canvas2d.getHeight();
      const objW = liveObj.width * liveObj.scaleX;
      const objH = liveObj.height * liveObj.scaleY;
      const center = liveObj.getCenterPoint();
      pat.style.width  = Math.max(1, objW / cw * 100) + '%';
      pat.style.height = Math.max(1, objH / ch * 100) + '%';
      pat.style.left   = (center.x / cw * 100) + '%';
      pat.style.top    = (center.y / ch * 100) + '%';
      pat.style.transform = `translate(-50%,-50%) rotate(${liveObj.angle || 0}deg)`;
      pat.style.setProperty('--ai-art', 'url(' + JSON.stringify(patternImg.src) + ')');
      card.appendChild(pat);
    }
  }

  // AI 圖案：直接讀取編輯畫布上 'black-effect-image' 物件目前的實際位置/縮放/旋轉，
  // 換算成卡面座標的百分比套用——不再用固定的自動置中比例覆蓋使用者在設計稿頁
  // 調整過的結果。畫布本身就是卡面比例（85.6:54），换算不會造成變形。
  // 只有在真的找不到編輯畫布物件時（理論上不會發生，hasPrintableDesign() 已擋在
  // 進入預覽之前），才退回一個置中偏左的預設版面當最後防線，不是常態路徑。
  if (artImg && artImg.naturalWidth && artImg.naturalHeight) {
    const art = document.createElement('div');
    art.className = 'black-card-art';

    const liveObj = (typeof canvas2d !== 'undefined' && canvas2d)
      ? canvas2d.getObjects().find(o => o.name === 'black-effect-image')
      : null;

    if (liveObj && canvas2d) {
      const cw = canvas2d.getWidth(), ch = canvas2d.getHeight();
      const objW = liveObj.width * liveObj.scaleX;
      const objH = liveObj.height * liveObj.scaleY;
      const center = liveObj.getCenterPoint();
      art.style.width  = Math.max(1, objW / cw * 100) + '%';
      art.style.height = Math.max(1, objH / ch * 100) + '%';
      art.style.left   = (center.x / cw * 100) + '%';
      art.style.top    = (center.y / ch * 100) + '%';
      art.style.transform = `translate(-50%,-50%) rotate(${liveObj.angle || 0}deg)`;
    } else {
      const aspect = artImg.naturalWidth / artImg.naturalHeight;
      const fallbackWRatio = 0.68;
      art.style.width  = (fallbackWRatio * 100) + '%';
      art.style.height = (fallbackWRatio * finalW / aspect / finalH * 100) + '%';
      art.style.left   = '43.5%';
      art.style.top    = '50%';
      art.style.transform = 'translate(-50%,-50%)';
    }
    art.style.setProperty('--ai-art', 'url(' + JSON.stringify(artImg.src) + ')');
    card.appendChild(art);
  }

  // 壓印文字（主標題／副標題）：位置依畫布上實際相對座標換算成卡面百分比，
  // 沒有文字物件時不產生節點；黑卡的 canvas 本身就是卡面比例，換算不失真。
  if (typeof canvas2d !== 'undefined' && canvas2d) {
    const cw = canvas2d.getWidth(), ch = canvas2d.getHeight();
    canvas2d.getObjects()
      .filter(o => (o.name === 'title' || o.name === 'subtitle') && (o.text || '').trim())
      .forEach(o => {
        const rect = o.getBoundingRect(true, true);
        const el = document.createElement('div');
        el.className = 'black-card-text';
        el.textContent = o.text;
        el.style.left     = Math.max(0, rect.left / cw * 100) + '%';
        el.style.top      = Math.max(0, rect.top / ch * 100) + '%';
        el.style.width    = Math.min(100, rect.width / cw * 100) + '%';
        el.style.fontSize = Math.max(9, (rect.height / ch) * finalH * 0.62) + 'px';
        el.style.textAlign = o.textAlign || 'center';
        card.appendChild(el);
      });

    // 藝術簽名：獨立於壓印文字之外的圖層，永遠疊在最上層；直接用畫布上的
    // fontFamily/位置/縮放/旋轉，字型已經是頁面共用的 Google Fonts，不需要另外載入。
    canvas2d.getObjects()
      .filter(o => o.name === 'black-card-signature' && (o.text || '').trim())
      .forEach(o => {
        const rect = o.getBoundingRect(true, true);
        const center = o.getCenterPoint();
        const el = document.createElement('div');
        el.className = 'black-card-text black-card-signature';
        el.textContent = o.text;
        el.style.left = (center.x / cw * 100) + '%';
        el.style.top  = (center.y / ch * 100) + '%';
        el.style.fontFamily = `'${o.fontFamily}', cursive`;
        el.style.fontSize = Math.max(6, (o.fontSize * o.scaleX / ch) * finalH) + 'px';
        el.style.transform = `translate(-50%,-50%) rotate(${o.angle || 0}deg)`;
        el.style.whiteSpace = 'nowrap';
        el.style.width = 'auto';
        card.appendChild(el);
      });
  }

  if (reducedMotion) return;

  // 滑鼠移動時的細微傾斜與反光互動；靜止時做非常緩慢的自然漂移，讓卡面反光帶
  // 持續有極輕微的變化。只改 transform 與 CSS 變數（不改版面尺寸/位置屬性），
  // 不會造成 layout shift。
  let curX = 0.5, curY = 0.35, targetX = 0.5, targetY = 0.35, lastMoveTs = 0;
  const startTs = performance.now();
  function tick(now) {
    if (!stage.isConnected) { _bcPreviewRafId = null; return; }
    if (now - lastMoveTs > 1200) {
      const t = (now - startTs) / 1000;
      targetX = 0.5 + Math.sin(t * 0.25) * 0.28;
      targetY = 0.35 + Math.cos(t * 0.2) * 0.14;
    }
    curX += (targetX - curX) * 0.04;
    curY += (targetY - curY) * 0.04;
    card.style.setProperty('--sheen-x', (curX * 100).toFixed(1) + '%');
    card.style.setProperty('--sheen-y', (curY * 100).toFixed(1) + '%');
    const tiltX = (curY - 0.5) * -3;
    const tiltY = (curX - 0.5) * 3;
    _applyBlackCardAngleTransform(card, _blackCardPreviewAngle, tiltX, tiltY);
    _bcPreviewRafId = requestAnimationFrame(tick);
  }
  stage.addEventListener('mousemove', e => {
    const r = stage.getBoundingClientRect();
    targetX = (e.clientX - r.left) / r.width;
    targetY = (e.clientY - r.top) / r.height;
    lastMoveTs = performance.now();
  });
  _bcPreviewRafId = requestAnimationFrame(tick);
}

// ─── 手機縮放控制列 ───────────────────────────────────────
function _showScaleBar() {
  const bar = document.getElementById('mobile-scale-bar');
  const obj = canvas2d?.getActiveObject();
  if (obj && typeof obj.name === 'string' && obj.name.startsWith('template-')) {
    if (bar) bar.style.display = 'none';
    return;
  }
  if (bar) bar.style.display = 'flex';
  _updateScaleSlider();
}
function _hideScaleBar() {
  const bar = document.getElementById('mobile-scale-bar');
  if (bar) bar.style.display = 'none';
}
// 裝飾圖形（sticker）的填滿色／外框線調色面板：只在選取的物件是裝飾圖形時顯示，
// 選到別的圖層或取消選取時整塊隱藏——避免使用者以為這是全域設定。
function _updateStickerColorPanel() {
  const panel = document.getElementById('sticker-color-panel');
  if (!panel) return;
  const active = canvas2d ? canvas2d.getActiveObject() : null;
  if (!active || active.name !== 'sticker') {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const fillInput   = document.getElementById('sticker-fill-color');
  const strokeInput = document.getElementById('sticker-stroke-color');
  const strokeToggle = document.getElementById('sticker-stroke-toggle');
  const hasStroke = !!(active.strokeWidth > 0 && active.stroke);
  if (fillInput)   fillInput.value   = _toHexColor(active.fill) || '#000000';
  if (strokeInput) strokeInput.value = _toHexColor(active.stroke) || '#333333';
  if (strokeToggle) strokeToggle.checked = hasStroke;
}
// <input type=color> 只吃 #rrggbb，畫布上的圖案顏色理論上都是我們自己指定的 hex，
// 但保險起見還是擋一下非 hex 值（例如萬一是 rgba()），避免整個 color input 直接吃錯值失效。
function _toHexColor(v) {
  return (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)) ? v : null;
}
// 滑桿數值＝目前 scaleX 相對於 obj.baseScale 的百分比（見 placeBlackCardEffectObject）；
// 沒有 baseScale 的物件（文字、其他商品的上傳圖片）維持原本「直接讀 scaleX」的行為，
// 不影響既有功能。
// _sliderUserEditing：使用者正在用滑鼠/觸控/鍵盤拖動滑桿的當下，不要讓
// object:scaling／object:modified 這類監聽器用「舊的物件狀態」把 slider.value 蓋回去
// （拖動滑桿本身不會觸發這些事件，但保留這道防線比較保險，符合使用者明確要求）。
let _sliderUserEditing = false;
function _updateScaleSlider() {
  if (_sliderUserEditing) return;
  const obj    = canvas2d?.getActiveObject();
  const slider = document.getElementById('scale-slider');
  const pct    = document.getElementById('scale-pct');
  if (!obj || !slider) return;
  const base = obj.baseScale || 1;
  const val = Math.round(((obj.scaleX || base) / base) * 100);
  slider.value = Math.max(5, Math.min(300, val));
  if (pct) pct.textContent = val + '%';
}
function scaleSelectedTo(ratio) {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (!obj) return;
  _sliderUserEditing = true;
  if (scaleSelectedTo._releaseTimer) clearTimeout(scaleSelectedTo._releaseTimer);
  scaleSelectedTo._releaseTimer = setTimeout(() => { _sliderUserEditing = false; }, 300);
  const base = obj.baseScale || 1;
  const r = Math.max(0.05, Math.min(3.0, parseFloat(ratio)));
  obj.set({ scaleX: base * r, scaleY: base * r });
  obj.setCoords();
  canvas2d.requestRenderAll();
  const pct = document.getElementById('scale-pct');
  if (pct) pct.textContent = Math.round(r * 100) + '%';
  // 滑桿拖曳當下就即時儲存設計狀態，不用等到 object:modified（放開滑鼠）才存，
  // 避免使用者拖到一半時查看/切換頁面時抓到舊狀態。
  if (typeof syncDesignState === 'function') syncDesignState();
}

// ─── 對齊工具（置中／水平置中／垂直置中）───────────────────
// 跟 scaleSelectedTo() 同一套「set + setCoords + requestRenderAll + syncDesignState」模式，
// 對齊基準一律用畫布中心（不管物件的 originX/originY 是 center 或 left/top，
// getCenterPoint()/物件自身尺寸換算都已經處理好，這裡只需要決定要置中的是哪個軸）。
function alignActiveObject(mode) {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (!obj) return;
  const cw = canvas2d.getWidth(), ch = canvas2d.getHeight();
  const center = obj.getCenterPoint();
  const targetX = cw / 2, targetY = ch / 2;
  const dx = targetX - center.x, dy = targetY - center.y;
  const patch = {};
  if (mode === 'center' || mode === 'h') patch.left = obj.left + dx;
  if (mode === 'center' || mode === 'v') patch.top = obj.top + dy;
  obj.set(patch);
  obj.setCoords();
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

// 目前選取圖層順時針旋轉90度，連續按4次會轉回原本角度。
function rotateActiveObject90() {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (!obj) return;
  obj.set({ angle: ((obj.angle || 0) + 90) % 360 });
  obj.setCoords();
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

// ─── 刪除選取 ─────────────────────────────────────────────
function deleteSelected2D() {
  if (!canvas2d) return;
  const obj = canvas2d.getActiveObject();
  if (obj && typeof obj.name === 'string' && obj.name.startsWith('template-')) return;
  if (obj) {
    canvas2d.remove(obj);
    canvas2d.renderAll();
    if (obj.name === 'black-effect-image' && typeof STATE !== 'undefined') {
      STATE.blackCardPatternDataURL = null;
    }
  }
}

// ─── 清空 ─────────────────────────────────────────────────
function clear2D() {
  if (!canvas2d) return;
  canvas2d.getObjects().slice().forEach(o => canvas2d.remove(o));
  if (typeof STATE !== 'undefined') STATE.blackCardPatternDataURL = null;
  if (currentProduct && currentProduct.bgImage) {
    canvas2d.setBackgroundColor(null, () => {});
    _loadProductBgImage(currentProduct.bgImage, canvas2d.getWidth(), canvas2d.getHeight(), addDefaultElements);
  } else {
    canvas2d.setBackgroundColor('#ffffff', () => { canvas2d.renderAll(); });
    addDefaultElements();
    // addDefaultElements() 內部的 _addYangZhuVectorBackground() 已經會讀
    // STATE.backgroundTemplateId 自己挑對造型（見該函式開頭註解），這裡只需要
    // 補一次顏色，確保跟波浪顏色色票一致，不用再找「造型」的顏色資料。
    if (typeof STATE !== 'undefined' && typeof applyCardBackgroundTemplate2D === 'function') {
      applyCardBackgroundTemplate2D({
        bg: STATE.bgColor || '#ffffff',
        wave: STATE.waveColor || '#2D7D46',
        waveLight: STATE.waveLightColor || '#dfead8',
        dot: STATE.waveLightColor || '#dfead8',
        dotAlt: STATE.waveColor || '#2D7D46'
      });
    }
  }
}

// ─── 黑卡：滑鼠移動時的光影角度微調（純 CSS 疊層，不動 Fabric 渲染）──
// 只在畫面上出現 .black-card-mode 容器時才有作用，其餘情況直接短路 return，
// 綁定一次即可，不需要每次進入/離開設計步驟另外掛載/移除監聽器。
// _bcDraggingActive：使用者正在拖曳/縮放/旋轉畫布上的物件時（見 init2DCanvas 內
// object:moving/scaling/rotating 監聽），光影追蹤暫時凍結在最後位置，避免拖曳
// 物件的同時卡面光影跟著滑鼠亂動，兩種視覺變化互相干擾、看起來像抖動。
let _bcDraggingActive = false;
document.addEventListener('mousemove', e => {
  if (_bcDraggingActive) return;
  const wrap = document.querySelector('.canvas-wrap.black-card-mode');
  if (!wrap) return;
  const r = wrap.getBoundingClientRect();
  const lx = ((e.clientX - r.left) / r.width) * 100;
  const ly = ((e.clientY - r.top) / r.height) * 100;
  wrap.style.setProperty('--lx', `${Math.max(0, Math.min(100, lx))}%`);
  wrap.style.setProperty('--ly', `${Math.max(0, Math.min(100, ly))}%`);
});
