// 楊竹科技 — AI Q版肖像生成模組

let lastCartoonImageDataURL  = null;
let cartoonSourceDataURL     = null;
let _cartoonAbortController  = null; // 切換商品/重新配置時用來中止尚未完成的 AI 請求

function abortCartoonGeneration() {
  if (_cartoonAbortController) {
    _cartoonAbortController.abort();
    _cartoonAbortController = null;
  }
}

// ── Q版卡通化 ──────────────────────────────────────────────

// 五種風格選項（id 需與 server.js 的 CARTOON_STYLES 對應）
const CARTOON_STYLES = [
  { id: 'classic_kawaii',  name: '經典可愛 Q版',   desc: '大眼可愛・粉彩背景',   thumb: 'assets/cartoon-styles/01_classic_kawaii.png' },
  { id: 'elegant_festive', name: '精緻喜氣肖像風', desc: '紅金配色・典雅線條',   thumb: 'assets/cartoon-styles/02_elegant_festive.png' },
  { id: 'sticker_mascot',  name: '貼紙吉祥物風',   desc: '粗外框・亮色貼紙感',   thumb: 'assets/cartoon-styles/03_sticker_mascot.png' },
  { id: 'watercolor_soft', name: '柔和水彩風',     desc: '手繪水彩・溫柔筆觸',   thumb: 'assets/cartoon-styles/04_soft_watercolor.png' }
];
let selectedCartoonStyle = 'classic_kawaii';

function initCartoonStylePicker() {
  const wrap = document.getElementById('cartoon-style-picker');
  if (!wrap) return;
  wrap.innerHTML = CARTOON_STYLES.map(s => `
    <div class="cartoon-style-card ${s.id === selectedCartoonStyle ? 'selected' : ''}"
         data-style="${s.id}" onclick="selectCartoonStyle('${s.id}')">
      <div class="cartoon-style-swatch">
        <img src="${s.thumb}" alt="${s.name}" loading="lazy">
      </div>
      <div class="cartoon-style-name">${s.name}</div>
      <div class="cartoon-style-desc">${s.desc}</div>
    </div>
  `).join('');
}

function selectCartoonStyle(styleId) {
  selectedCartoonStyle = styleId;
  document.querySelectorAll('.cartoon-style-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.style === styleId);
  });
}

async function compressImage(dataURL, maxWidth = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const cvs = document.createElement('canvas');
      cvs.width  = Math.round(img.width  * scale);
      cvs.height = Math.round(img.height * scale);
      cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
      resolve(cvs.toDataURL('image/jpeg', 0.82));
    };
    // 原本沒有onerror，圖片解碼失敗時這個Promise會永遠不resolve也不reject（唯一呼叫端
    // previewCartoonUpload()因此也會卡住）。加上onerror讓失敗有明確訊號，供upload_result
    // 事件追蹤使用，同時也修正了這個既有的靜默卡住問題。
    img.onerror = () => reject(new Error('圖片解碼失敗'));
    img.src = dataURL;
  });
}

async function removeCartoonBackground(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const maxSide = 1400;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const cvs = document.createElement('canvas');
      cvs.width = w;
      cvs.height = h;
      const ctx = cvs.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);

      const image = ctx.getImageData(0, 0, w, h);
      const data = image.data;
      const idx = (x, y) => (y * w + x) * 4;
      const sampleStep = Math.max(1, Math.floor(Math.min(w, h) / 80));
      let sr = 0, sg = 0, sb = 0, count = 0;

      for (let x = 0; x < w; x += sampleStep) {
        for (const y of [0, h - 1]) {
          const i = idx(x, y);
          sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; count++;
        }
      }
      for (let y = 0; y < h; y += sampleStep) {
        for (const x of [0, w - 1]) {
          const i = idx(x, y);
          sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; count++;
        }
      }

      const br = sr / count, bg = sg / count, bb = sb / count;
      const colorDistance = i => {
        const dr = data[i] - br;
        const dg = data[i + 1] - bg;
        const db = data[i + 2] - bb;
        return Math.sqrt(dr * dr + dg * dg + db * db);
      };

      // AI 生成圖不一定是純白背景，有時會帶淡淡漸層／暗角（vignette）。原本只跟「邊框
      // 平均色」比對距離的作法，遇到漸層背景時要嘛整片吃不掉（漸層另一端跟邊框色差太多），
      // 要嘛沿漸層一路吃進主體本身的淺色填色區。改成「跟前一步鄰居像素比對」的局部容差
      // flood-fill：漸層本身相鄰像素落差很小，容易被吃掉；碰到黑色線稿邊緣時落差會突然
      // 變大而停下來，才不會被漸層牽著走進主體內部。同時保留跟邊框平均色的總落差上限，
      // 避免真的一路淺色到底時整張圖被誤判成背景。
      const localTolerance = 30;
      const globalDriftCap = 150;
      const visited = new Uint8Array(w * h);
      const removed = new Uint8Array(w * h);
      const stack = []; // [x, y, refR, refG, refB]：refR/G/B 是「推進到這格」的來源像素顏色

      const seedBorder = (x, y) => {
        const p = y * w + x;
        if (visited[p]) return;
        const i = idx(x, y);
        if (colorDistance(i) > globalDriftCap) return; // 邊框本身就明顯不像背景色，不強制當背景
        visited[p] = 1;
        removed[p] = 1;
        stack.push([x, y, data[i], data[i + 1], data[i + 2]]);
      };
      for (let x = 0; x < w; x++) { seedBorder(x, 0); seedBorder(x, h - 1); }
      for (let y = 0; y < h; y++) { seedBorder(0, y); seedBorder(w - 1, y); }

      const tryExpand = (x, y, refR, refG, refB) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return;
        const p = y * w + x;
        if (visited[p]) return;
        visited[p] = 1;
        const i = idx(x, y);
        const dr = data[i] - refR, dg = data[i + 1] - refG, db = data[i + 2] - refB;
        const localDist = Math.sqrt(dr * dr + dg * dg + db * db);
        if (localDist <= localTolerance && colorDistance(i) <= globalDriftCap) {
          removed[p] = 1;
          stack.push([x, y, data[i], data[i + 1], data[i + 2]]);
        }
      };

      while (stack.length) {
        const [x, y, r, g, b] = stack.pop();
        tryExpand(x + 1, y, r, g, b);
        tryExpand(x - 1, y, r, g, b);
        tryExpand(x, y + 1, r, g, b);
        tryExpand(x, y - 1, r, g, b);
      }

      const removeThreshold = localTolerance;
      const featherThreshold = 96;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const i = idx(x, y);
          if (removed[p]) {
            data[i + 3] = 0;
            continue;
          }

          let bgNeighbors = 0;
          for (let yy = -2; yy <= 2; yy++) {
            for (let xx = -2; xx <= 2; xx++) {
              if (!xx && !yy) continue;
              const nx = x + xx, ny = y + yy;
              if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
              if (removed[ny * w + nx]) bgNeighbors++;
            }
          }
          if (bgNeighbors > 0) {
            const dist = colorDistance(i);
            if (dist < featherThreshold) {
              const fade = Math.max(0.25, Math.min(1, (dist - removeThreshold) / (featherThreshold - removeThreshold)));
              const edgeSoftness = Math.max(0.65, 1 - bgNeighbors / 48);
              data[i + 3] = Math.round(data[i + 3] * Math.max(fade, edgeSoftness));
            }
          }
        }
      }

      ctx.putImageData(image, 0, 0);
      resolve(cvs.toDataURL('image/png'));
    };
    img.onerror = () => reject(new Error('去背處理失敗'));
    img.src = dataURL;
  });
}

// Q版人物照片上傳（黑卡AI圖案功能）。upload_result事件追蹤：類型／大小先擋
// （unsupported_type／file_too_large）；FileReader失敗算read_failed；compressImage()
// 內部解碼失敗（見上方compressImage新增的onerror→reject）算decode_failed；其餘處理過程
// 例外算processing_failed；只有真的完成壓縮並更新預覽畫面才算success。
function previewCartoonUpload(input) {
  const file = input.files[0];
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
  reader.onload = async e => {
    try {
      cartoonSourceDataURL = await compressImage(e.target.result, 800);
    } catch (err) {
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'decode_failed');
      return;
    }
    try {
      const preview = document.getElementById('cartoon-upload-preview');
      const hint    = document.getElementById('cartoon-upload-hint');
      if (preview) preview.innerHTML = `<img src="${cartoonSourceDataURL}" alt="已上傳的照片預覽" style="max-width:100%;max-height:120px;border-radius:8px;object-fit:contain;display:block;margin:0 auto;">`;
      if (hint)    hint.textContent  = '已選擇圖片，點擊可重新選擇';
      // 已補上照片，清除先前「未上傳照片」的錯誤狀態
      document.getElementById('cartoon-upload-zone')?.classList.remove('upload-zone-error');
      const errEl = document.getElementById('cartoon-error');
      if (errEl) errEl.classList.add('hidden');
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'success');
    } catch (err) {
      if (typeof _trackUploadResult === 'function') _trackUploadResult(_uploadProductId, 'failure', 'processing_failed');
    }
  };
  reader.readAsDataURL(file);
}

function _showCartoonError(message, { withRetry = false } = {}) {
  const errEl = document.getElementById('cartoon-error');
  if (!errEl) return;
  errEl.innerHTML = '';
  const msg = document.createElement('span');
  msg.textContent = '❌ ' + message;
  errEl.appendChild(msg);
  if (withRetry) {
    const retryBtn = document.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'btn btn-outline btn-sm';
    retryBtn.style.marginLeft = '10px';
    retryBtn.textContent = '重新生成';
    retryBtn.onclick = generateCartoonImage;
    errEl.appendChild(retryBtn);
  }
  errEl.classList.remove('hidden');
}

async function generateCartoonImage() {
  if (!cartoonSourceDataURL) {
    _showCartoonError('請先上傳一張單人正面清晰照片，再開始製作 Q版肖像。');
    const zone = document.getElementById('cartoon-upload-zone');
    zone?.classList.add('upload-zone-error');
    zone?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  setCartoonLoading(true);
  document.getElementById('cartoon-preview').classList.add('hidden');
  document.getElementById('cartoon-error').classList.add('hidden');

  const thisRequestProductId = STATE.productId;
  _cartoonAbortController = new AbortController();

  // 在請求開始前鎖定這次的匿名關聯，避免等待期間資料切換；_getAnalyticsContextForRequest()
  // 定義於 configurator.js，跨檔案共用慣例（typeof檢查，不受script載入順序影響）。
  const _cartoonAnalyticsContext = (typeof _getAnalyticsContextForRequest === 'function') ? _getAnalyticsContextForRequest() : null;

  try {
    const resp = await fetch('/api/cartoon-image', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        imageDataURL: cartoonSourceDataURL,
        styleId:      selectedCartoonStyle,
        productId:    thisRequestProductId,
        mode:         thisRequestProductId === 'black_card' ? 'black_card' : 'standard',
        ...( _cartoonAnalyticsContext ? { analyticsContext: _cartoonAnalyticsContext } : {} )
      }),
      signal:  _cartoonAbortController.signal
    });
    // 使用者可能在等待期間已經切換到別的商品，這種情況直接忽略回應，不套用到現在的畫布上
    if (STATE.productId !== thisRequestProductId) return;
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '生成失敗');
    // 防呆：AI 沒有真的回傳可用圖片（空白 data URL／過短的無效內容）時，當成失敗處理，
    // 不要讓消費者以為空白圖已經套用成功。
    if (!data.imageDataURL || data.imageDataURL.length < 100) {
      throw new Error('AI 沒有回傳有效的圖片，請點「重新生成」再試一次');
    }

    let processedImageDataURL = data.imageDataURL;
    try {
      processedImageDataURL = await removeCartoonBackground(data.imageDataURL);
    } catch (bgErr) {
      console.warn('[cartoon-bg-removal]', bgErr);
    }

    lastCartoonImageDataURL = processedImageDataURL;

    const previewEl = document.getElementById('cartoon-preview');
    previewEl.innerHTML = `
      <img src="${processedImageDataURL}" alt="AI 生成的 Q 版肖像預覽" style="width:100%;border-radius:8px;margin-top:10px;display:block;background:linear-gradient(45deg,#f8faf7 25%,#eef3ec 25%,#eef3ec 50%,#f8faf7 50%,#f8faf7 75%,#eef3ec 75%);background-size:18px 18px;">
      <div style="font-size:12px;color:var(--gray-400);text-align:center;margin-top:6px;">✅ 已自動去背並套用至卡面</div>
    `;
    previewEl.classList.remove('hidden');

    // 自動套用至 Canvas
    applyCartoonImage();

  } catch (err) {
    if (err.name === 'AbortError') return; // 使用者主動切換商品造成的中止，不是錯誤
    _showCartoonError(err.message, { withRetry: true });
  } finally {
    setCartoonLoading(false);
  }
}

function applyCartoonImage() {
  if (!lastCartoonImageDataURL || !canvas2d) return;
  // 卡片背景換成跟客人選的Q版風格對應的插畫背景（只對悠遊卡/一卡通生效，函式內部自行判斷商品）
  if (typeof applyCartoonStyleCardBackground2D === 'function') {
    applyCartoonStyleCardBackground2D(selectedCartoonStyle);
  }
  fabric.Image.fromURL(lastCartoonImageDataURL, img => {
    // 先移除舊的 Q版肖像物件，避免重新生成時重疊
    canvas2d.getObjects().filter(o => o.name === 'cartoon-avatar').forEach(o => canvas2d.remove(o));

    const w = canvas2d.getWidth();
    const h = canvas2d.getHeight();

    // 有印刷區(labelArea)的產品（如USB）：頭像限制在印刷區內；卡片類商品則預設放在右側主視覺區。
    let areaLeft = 0, areaTop = 0, areaW = w, areaH = h;
    let targetLeftRatio = 0.5;
    let targetTopRatio = 0.5;
    let widthRatio = 0.52;
    let heightLimitRatio = 0.92;
    // 卡片類商品（易受 labelArea 影響版位判斷，需優先比對，見下方註解）先判斷，
    // 其餘有 labelArea 的商品（如USB）才落入印刷區判斷分支
    if (typeof currentProduct !== 'undefined' && currentProduct && ['easycard', 'ipass'].includes(currentProduct.id)) {
      areaLeft = w * 0.46;
      areaTop  = h * 0.08;
      areaW    = w * 0.45;
      areaH    = h * 0.86;
      targetLeftRatio = 0.56;
      targetTopRatio = 0.55;
      widthRatio = 0.86;
      heightLimitRatio = 0.94;
    } else if (typeof currentProduct !== 'undefined' && currentProduct && currentProduct.labelArea) {
      const la = currentProduct.labelArea;
      areaLeft = w * la.xRatio; areaTop = h * la.yRatio;
      areaW    = w * la.wRatio; areaH   = h * la.hRatio;
    }

    let scale = (areaW * widthRatio) / img.width;
    if (img.height * scale > areaH * heightLimitRatio) {
      scale = (areaH * heightLimitRatio) / img.height;
    }

    img.set({
      left: areaLeft + areaW * targetLeftRatio,
      top:  areaTop  + areaH * targetTopRatio,
      originX: 'center', originY: 'center',
      scaleX: scale, scaleY: scale,
      selectable: true, evented: true,   // 可拖拉、可縮放、可旋轉
      name: 'cartoon-avatar'
    });

    canvas2d.add(img);
    canvas2d.bringToFront(img);   // 維持在文字/背景上方，不 sendToBack（不當滿版背景）
    canvas2d.setActiveObject(img);
    canvas2d.requestRenderAll();
    // 圖片已確定 decode 完成並畫進 canvas，立刻更新快照與 designState
    if (typeof STATE !== 'undefined') {
      STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : STATE.designDataURL;
      STATE.canvasJSON = (typeof getCanvas2DJSON === 'function') ? getCanvas2DJSON() : STATE.canvasJSON;
    }
    if (typeof syncDesignState === 'function') syncDesignState();
  });
}

function setCartoonLoading(on) {
  const btn  = document.getElementById('cartoon-btn');
  const text = document.getElementById('cartoon-btn-text');
  const load = document.getElementById('cartoon-btn-loading');
  if (!btn) return;
  btn.disabled = on;
  text?.classList.toggle('hidden',  on);
  load?.classList.toggle('hidden', !on);
}
