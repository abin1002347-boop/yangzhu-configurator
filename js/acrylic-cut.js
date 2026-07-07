// 壓克力切割輪廓偵測 — 純瀏覽器端，無需後端 API

let _acrylicDataURL = null;

function initAcrylicCut() {
  const input = document.getElementById('acrylic-upload-input');
  if (!input) return;
  input.addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      _acrylicDataURL = ev.target.result;
      const preview = document.getElementById('acrylic-preview-img');
      if (preview) { preview.src = _acrylicDataURL; }
      document.getElementById('acrylic-preview-wrap').classList.remove('hidden');
      document.getElementById('acrylic-detect-btn').disabled = false;
      document.getElementById('acrylic-result').classList.add('hidden');
      document.getElementById('acrylic-error').classList.add('hidden');
    };
    reader.readAsDataURL(file);
  });
}

async function detectAcrylicContour() {
  if (!_acrylicDataURL) return;

  const btn       = document.getElementById('acrylic-detect-btn');
  const btnText   = document.getElementById('acrylic-detect-btn-text');
  const btnLoading= document.getElementById('acrylic-detect-btn-loading');
  const resultDiv = document.getElementById('acrylic-result');
  const errorDiv  = document.getElementById('acrylic-error');

  btn.disabled = true;
  btnText.classList.add('hidden');
  btnLoading.classList.remove('hidden');
  resultDiv.classList.add('hidden');
  errorDiv.classList.add('hidden');

  try {
    const { svg, pointCount, actualW, actualH } = await _processContour(_acrylicDataURL);

    document.getElementById('acrylic-info').textContent =
      `輪廓點數：${pointCount} 點　｜　實際尺寸：${actualW} cm × ${actualH} cm（最大邊 30 cm）`;

    // SVG 預覽（用 canvas 疊圖）
    await _renderPreview(_acrylicDataURL, svg, document.getElementById('acrylic-canvas-preview'));

    // 下載連結
    const dlBtn = document.getElementById('acrylic-download-btn');
    const blob  = new Blob([svg], { type: 'image/svg+xml' });
    if (dlBtn._prevObjUrl) URL.revokeObjectURL(dlBtn._prevObjUrl);
    const objUrl = URL.createObjectURL(blob);
    dlBtn._prevObjUrl = objUrl;
    dlBtn.href     = objUrl;
    dlBtn.download = 'acrylic_cut.svg';

    resultDiv.classList.remove('hidden');
  } catch (e) {
    errorDiv.textContent = '錯誤：' + e.message;
    errorDiv.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btnText.classList.remove('hidden');
    btnLoading.classList.add('hidden');
  }
}

// ── 主要處理流程 ────────────────────────────────────────────────
function _processContour(dataURL) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const origW = img.width, origH = img.height;

        // 縮圖加速（最大 800px）
        const ratio = Math.min(1, 800 / Math.max(origW, origH));
        const W = Math.round(origW * ratio);
        const H = Math.round(origH * ratio);

        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, W, H);

        const { data } = ctx.getImageData(0, 0, W, H);
        const mask     = _buildMask(data, W, H);
        const rawPts   = _traceContour(mask, W, H);

        if (rawPts.length < 6) {
          throw new Error('無法偵測到主體輪廓，請確認圖片有明顯主體（建議使用 PNG 透明背景，或白色底色）');
        }

        const simplified = _douglasPeucker(rawPts, 2.5);

        // 點座標換算回原始尺寸空間
        const origPts = simplified.map(([x, y]) => [x / ratio, y / ratio]);
        const { svgStr, actualW, actualH } = _generateSVG(origPts, origW, origH);

        resolve({ svg: svgStr, pointCount: simplified.length, actualW, actualH });
      } catch (e) {
        reject(e);
      }
    };
    img.onerror = () => reject(new Error('圖片載入失敗'));
    img.src = dataURL;
  });
}

// ── 建立二值遮罩 ────────────────────────────────────────────────
function _buildMask(data, W, H) {
  const mask = new Uint8Array(W * H);

  // 檢查是否有透明通道
  let minAlpha = 255;
  for (let i = 3; i < Math.min(data.length, W * H * 4); i += 4) {
    if (data[i] < minAlpha) minAlpha = data[i];
    if (minAlpha < 50) break;
  }
  const hasTransparency = minAlpha < 100;

  if (hasTransparency) {
    for (let i = 0; i < W * H; i++) {
      mask[i] = data[i * 4 + 3] > 64 ? 1 : 0;
    }
  } else {
    // 從四角取樣背景色
    const corners = [0, (W - 1), (H - 1) * W, (H - 1) * W + (W - 1)];
    let bgR = 0, bgG = 0, bgB = 0;
    corners.forEach(idx => {
      bgR += data[idx * 4];
      bgG += data[idx * 4 + 1];
      bgB += data[idx * 4 + 2];
    });
    bgR = Math.round(bgR / 4);
    bgG = Math.round(bgG / 4);
    bgB = Math.round(bgB / 4);

    for (let i = 0; i < W * H; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
      const diff = Math.abs(r - bgR) + Math.abs(g - bgG) + Math.abs(b - bgB);
      mask[i] = diff > 35 ? 1 : 0;
    }
  }

  return mask;
}

// ── 掃描線輪廓追蹤 ──────────────────────────────────────────────
// 分四邊掃描，拼出封閉多邊形（適合凸形或近凸形輪廓）
function _traceContour(mask, W, H) {
  const pts = [];

  // 上邊：每列最靠上的前景點，從左到右
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (mask[y * W + x]) { pts.push([x, y]); break; }
    }
  }
  // 右邊：每行最靠右的前景點，從上到下
  for (let y = 0; y < H; y++) {
    for (let x = W - 1; x >= 0; x--) {
      if (mask[y * W + x]) { pts.push([x, y]); break; }
    }
  }
  // 下邊：每列最靠下的前景點，從右到左
  for (let x = W - 1; x >= 0; x--) {
    for (let y = H - 1; y >= 0; y--) {
      if (mask[y * W + x]) { pts.push([x, y]); break; }
    }
  }
  // 左邊：每行最靠左的前景點，從下到上
  for (let y = H - 1; y >= 0; y--) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) { pts.push([x, y]); break; }
    }
  }

  return pts;
}

// ── Douglas-Peucker 簡化 ────────────────────────────────────────
function _douglasPeucker(pts, eps) {
  if (pts.length <= 2) return pts;
  let maxD = 0, idx = 0;
  const end = pts.length - 1;
  for (let i = 1; i < end; i++) {
    const d = _ptSegDist(pts[i], pts[0], pts[end]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const L = _douglasPeucker(pts.slice(0, idx + 1), eps);
    const R = _douglasPeucker(pts.slice(idx), eps);
    return [...L.slice(0, -1), ...R];
  }
  return [pts[0], pts[end]];
}

function _ptSegDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  return Math.abs(dy * px - dx * py + bx * ay - by * ax) / Math.sqrt(len2);
}

// ── 產生 SVG ────────────────────────────────────────────────────
function _generateSVG(points, W, H) {
  const MAX_CM = 30;
  const px2mm  = (MAX_CM * 10) / Math.max(W, H); // 1mm = 10 SVG units
  const svgW   = +(W * px2mm).toFixed(1);
  const svgH   = +(H * px2mm).toFixed(1);
  const actualW = +(svgW / 10).toFixed(1);
  const actualH = +(svgH / 10).toFixed(1);

  const ptStr = points
    .map(([x, y]) => `${+(x * px2mm).toFixed(1)},${+(y * px2mm).toFixed(1)}`)
    .join(' ');

  const svgStr =
`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     width="${svgW}mm" height="${svgH}mm"
     viewBox="0 0 ${svgW} ${svgH}">
  <rect x="0" y="0" width="${svgW}" height="${svgH}"
        fill="none" stroke="#000000" stroke-width="0.5"/>
  <polygon points="${ptStr}"
           fill="none" stroke="#FF0000" stroke-width="0.3"/>
  <text x="1" y="${(svgH - 1).toFixed(1)}"
        font-size="2" fill="#333333">W:${actualW}cm  H:${actualH}cm  (max 30cm)</text>
</svg>`;

  return { svgStr, actualW, actualH };
}

// ── Canvas 預覽（原圖 + 紅色輪廓線疊加）──────────────────────────
async function _renderPreview(dataURL, svgStr, canvas) {
  if (!canvas) return;

  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = dataURL;
  });

  const MAX = 480;
  const ratio = Math.min(1, MAX / Math.max(img.width, img.height));
  canvas.width  = Math.round(img.width  * ratio);
  canvas.height = Math.round(img.height * ratio);

  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // 從 SVG 取出 polygon points 並疊畫紅線
  const match = svgStr.match(/points="([^"]+)"/);
  if (!match) return;

  // SVG points 在 30cm 座標系，換算回 canvas 像素
  const svgW = parseFloat(svgStr.match(/width="([\d.]+)mm"/)?.[1] || '300');
  const pts  = match[1].trim().split(' ').map(s => {
    const [x, y] = s.split(',').map(Number);
    return [
      (x / svgW) * canvas.width,
      (y / (parseFloat(svgStr.match(/height="([\d.]+)mm"/)?.[1] || '300'))) * canvas.height
    ];
  });

  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  pts.slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.closePath();
  ctx.strokeStyle = '#FF0000';
  ctx.lineWidth = 2;
  ctx.stroke();
}
