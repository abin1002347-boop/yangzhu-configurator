// 楊竹科技 — 步驟式配置器主邏輯

const STATE = {
  step: 1,
  productId: null,
  materialId: null,
  finishId: null,
  capacityId: null,
  qty: 100,
  textLine1: '',
  textLine2: '',
  bgColor: '#ffffff',
  canvasJSON: null,       // 設計稿 canvas 狀態快照（返回時還原用）
  designDataURL: null,    // 設計稿影像快照（3D 貼圖備援）
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  contactNote: ''
};

const TOTAL_STEPS = 5;

// ─── 步驟導覽 ──────────────────────────────────────────────
function goStep(n) {
  if (n < 1 || n > TOTAL_STEPS) return;
  if (n > 1 && !STATE.productId) { alert('請先選擇產品'); return; }
  if (n > 2 && !STATE.materialId) { alert('請先完成規格選擇'); return; }

  // 離開設計步驟前，先快照 2D 設計圖（canvas 還在畫面上時最可靠）
  if (STATE.step === 3) {
    STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : null;
  }

  STATE.step = n;
  renderStep();
}

function nextStep() { goStep(STATE.step + 1); }
function prevStep() { goStep(STATE.step - 1); }

function renderStep() {
  // 更新進度條
  document.querySelectorAll('.step-indicator .step').forEach((el, i) => {
    el.classList.toggle('active',   i + 1 === STATE.step);
    el.classList.toggle('done',     i + 1 <  STATE.step);
  });

  // 顯示對應面板
  document.querySelectorAll('.step-panel').forEach(el => {
    el.classList.toggle('hidden', el.dataset.step != STATE.step);
  });

  // 各步驟初始化
  if (STATE.step === 3) initDesignStep();
  if (STATE.step === 4) initPreviewStep();
  if (STATE.step === 5) initQuoteStep();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Step 1：選產品 ────────────────────────────────────────
function selectProduct(productId) {
  STATE.productId = productId;
  STATE.materialId = null;
  STATE.finishId   = null;
  STATE.capacityId = null;

  document.querySelectorAll('.product-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.productId === productId);
  });

  // 預設第一個材質/工藝
  const p = PRODUCTS[productId];
  STATE.materialId = p.materials[0].id;
  STATE.finishId   = p.finishes[0].id;
  if (p.capacities) STATE.capacityId = p.capacities[0].id;

  nextStep();
}

// ─── Step 2：選規格 ────────────────────────────────────────
function renderSpecStep() {
  const p = PRODUCTS[STATE.productId];
  if (!p) return;

  // 材質
  const matContainer = document.getElementById('spec-materials');
  matContainer.innerHTML = p.materials.map(m => `
    <label class="spec-option ${m.id === STATE.materialId ? 'selected' : ''}">
      <input type="radio" name="material" value="${m.id}" ${m.id === STATE.materialId ? 'checked' : ''}>
      <span class="spec-label">${m.name}</span>
      <span class="spec-price">NT$${m.priceBase}/個起</span>
    </label>
  `).join('');

  matContainer.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      STATE.materialId = input.value;
      matContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
      input.closest('label').classList.add('selected');
      updateLiveQuote();
    });
  });

  // 表面工藝
  const finContainer = document.getElementById('spec-finishes');
  finContainer.innerHTML = p.finishes.map(f => `
    <label class="spec-option ${f.id === STATE.finishId ? 'selected' : ''}">
      <input type="radio" name="finish" value="${f.id}" ${f.id === STATE.finishId ? 'checked' : ''}>
      <span class="spec-label">${f.name}</span>
      <span class="spec-price">${f.price > 0 ? `+NT$${f.price}` : '標準'}</span>
    </label>
  `).join('');

  finContainer.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      STATE.finishId = input.value;
      finContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
      input.closest('label').classList.add('selected');
      updateLiveQuote();
    });
  });

  // 容量（USB 類才有）
  const capSection = document.getElementById('spec-capacity-section');
  if (p.capacities) {
    capSection.classList.remove('hidden');
    const capContainer = document.getElementById('spec-capacities');
    capContainer.innerHTML = p.capacities.map(c => `
      <label class="spec-option ${c.id === STATE.capacityId ? 'selected' : ''}">
        <input type="radio" name="capacity" value="${c.id}" ${c.id === STATE.capacityId ? 'checked' : ''}>
        <span class="spec-label">${c.name}</span>
        <span class="spec-price">${c.price > 0 ? `+NT$${c.price}` : '標準'}</span>
      </label>
    `).join('');

    capContainer.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        STATE.capacityId = input.value;
        capContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
        input.closest('label').classList.add('selected');
        updateLiveQuote();
      });
    });
  } else {
    capSection.classList.add('hidden');
  }

  // 數量滑桿
  const qtyInput = document.getElementById('spec-qty');
  const qtyDisplay = document.getElementById('spec-qty-display');
  qtyInput.min   = p.minQty;
  qtyInput.value = Math.max(STATE.qty, p.minQty);
  qtyDisplay.textContent = qtyInput.value;
  STATE.qty = parseInt(qtyInput.value);

  qtyInput.addEventListener('input', () => {
    STATE.qty = parseInt(qtyInput.value);
    qtyDisplay.textContent = STATE.qty;
    updateLiveQuote();
  });

  updateLiveQuote();
}

function updateLiveQuote() {
  const q = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);
  if (!q) return;

  const el = document.getElementById('live-quote');
  if (el) {
    el.innerHTML = `
      <div class="quote-row"><span>單價</span><strong>NT$ ${q.unitPrice.toLocaleString()}</strong></div>
      <div class="quote-row"><span>數量 × ${q.qty.toLocaleString()}</span><strong>NT$ ${q.subtotal.toLocaleString()}</strong></div>
      <div class="quote-row"><span>製版費</span><strong>NT$ ${q.setupFee.toLocaleString()}</strong></div>
      <div class="quote-row total"><span>預估總計</span><strong>NT$ ${q.total.toLocaleString()}</strong></div>
      <div class="quote-note">預計交期：下單後 ${q.leadDays} 個工作天</div>
    `;
  }
}

// ─── Step 3：設計 ──────────────────────────────────────────
function initDesignStep() {
  const isThermos = STATE.productId === 'thermos';

  init2DCanvas(STATE.productId);

  // 若有先前的 canvas 狀態（從預覽返回），還原設計內容
  if (STATE.canvasJSON && typeof loadCanvas2DJSON === 'function') {
    loadCanvas2DJSON(STATE.canvasJSON);
  }

  // 文字輸入
  const t1 = document.getElementById('design-text1');
  const t2 = document.getElementById('design-text2');
  if (t1) t1.value = STATE.textLine1;
  if (t2) t2.value = STATE.textLine2;

  // 字體格子初始化
  initFontGrid();

  // 圖片上傳（保溫杯僅文字，隱藏上傳區）
  const uploadSection = document.getElementById('design-upload')?.closest('.tool-section');
  if (uploadSection) uploadSection.style.display = isThermos ? 'none' : '';

  const fileInput = document.getElementById('design-upload');
  if (fileInput) {
    fileInput.replaceWith(fileInput.cloneNode(true));
    const newFile = document.getElementById('design-upload');
    newFile.addEventListener('change', e => {
      if (e.target.files[0]) uploadImage2D(e.target.files[0]);
    });
  }

  // 背景色
  const bgPicker = document.getElementById('design-bgcolor');
  if (bgPicker) {
    bgPicker.value = STATE.bgColor;
    bgPicker.addEventListener('input', e => {
      STATE.bgColor = e.target.value;
      setBackground2D(e.target.value);
    });
  }

  // 保溫杯：隱藏不適用的 AI 功能
  ['ai-image-section', 'ai-cartoon-section', 'acrylic-cut-section'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isThermos ? 'none' : '';
  });

  // 保溫杯：隱藏背景色選擇（瓶身有固定圖案）
  const bgColorEl = document.getElementById('design-bgcolor');
  if (bgColorEl) {
    const bgSection = bgColorEl.closest('.color-row')?.parentElement;
    if (bgSection) bgSection.style.display = isThermos ? 'none' : '';
  }

  // 保溫杯：更新 canvas 下方說明文字
  const canvasNote = document.querySelector('.canvas-wrap + p');
  if (canvasNote) {
    canvasNote.textContent = isThermos
      ? '虛線框為印刷範圍 · 文字套用後即出現在瓶身圖上'
      : '虛線為刀模輪廓參考線';
  }

  // 移除舊的參考圖 block（現在瓶身在 canvas 裡）
  const oldRef = document.getElementById('thermos-ref-block');
  if (oldRef) oldRef.remove();
}

function initFontGrid() {
  const grid = document.getElementById('font-grid');
  if (!grid || typeof FONTS === 'undefined') return;

  const currentFont = STATE.font || FONTS[0].id;

  grid.innerHTML = FONTS.map(f => `
    <div class="font-chip ${f.id === currentFont ? 'selected' : ''}"
         data-font="${f.id}"
         onclick="selectFont('${f.id}')">
      <span class="font-name">${f.label}</span>
      <span class="font-sample" style="font-family:'${f.id}',sans-serif">楊竹Aa</span>
    </div>
  `).join('');

  // 同步按鈕顯示文字
  const f = FONTS.find(f => f.id === currentFont);
  if (f) {
    const lbl = document.getElementById('font-select-label');
    if (lbl) lbl.textContent = f.label;
  }
  // 確保格子預設關閉
  grid.classList.add('font-grid-hidden');
}

function toggleFontPicker() {
  const grid = document.getElementById('font-grid');
  const btn  = document.getElementById('font-select-btn');
  if (!grid) return;
  const open = !grid.classList.contains('font-grid-hidden');
  grid.classList.toggle('font-grid-hidden', open);
  btn.classList.toggle('open', !open);
}

function selectFont(fontId) {
  STATE.font = fontId;
  document.getElementById('design-font').value = fontId;
  document.querySelectorAll('.font-chip').forEach(el => {
    el.classList.toggle('selected', el.dataset.font === fontId);
  });
  // 更新按鈕標籤
  if (typeof FONTS !== 'undefined') {
    const f = FONTS.find(f => f.id === fontId);
    if (f) {
      const lbl = document.getElementById('font-select-label');
      if (lbl) lbl.textContent = f.label;
    }
  }
  // 關閉選擇格
  const grid = document.getElementById('font-grid');
  if (grid) grid.classList.add('font-grid-hidden');
  const btn = document.getElementById('font-select-btn');
  if (btn) btn.classList.remove('open');
}

function applyDesignText() {
  const t1    = document.getElementById('design-text1').value.trim();
  const t2    = document.getElementById('design-text2').value.trim();
  const color = document.getElementById('design-textcolor').value;
  const font  = STATE.font || document.getElementById('design-font').value || 'Noto Sans TC';

  STATE.textLine1 = t1;
  STATE.textLine2 = t2;
  STATE.font = font;

  // 只移除文字層（hint / title / subtitle），保留圖片等使用者上傳物件
  if (canvas2d) {
    canvas2d.getObjects()
      .filter(o => ['hint', 'title', 'subtitle'].includes(o.name))
      .forEach(o => canvas2d.remove(o));
    canvas2d.renderAll();
  }

  setBackground2D(STATE.bgColor);
  if (t1) addText2D(t1, color, null, font, 'title');
  if (t2) addText2D(t2, color, null, font, 'subtitle');
}

// 背景預設色套用
function applyBgPreset(color) {
  STATE.bgColor = color;
  const picker = document.getElementById('design-bgcolor');
  if (picker) picker.value = color;
  setBackground2D(color);
}

// ─── Step 4：預覽 ──────────────────────────────────────────
function initPreviewStep() {
  const dataURL  = STATE.designDataURL;
  const finishId = STATE.finishId;

  if (STATE.productId === 'thermos') {
    // 保溫杯：直接顯示含瓶身的設計合成圖
    const container = document.getElementById('preview3d-container');
    container.setAttribute('style',
      'display:flex;align-items:center;justify-content:center;' +
      'min-height:300px;padding:20px;background:#edf2f7;border-radius:12px;'
    );
    container.innerHTML = dataURL
      ? `<div style="text-align:center;">
           <img src="${dataURL}" alt="保溫杯設計預覽"
                style="max-height:420px;max-width:100%;object-fit:contain;
                       border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,.15);">
           <p style="font-size:11px;color:#9aa5b4;margin-top:10px;">
             雷射雕刻效果預覽 · 正式稿以業務確認為準
           </p>
         </div>`
      : `<p style="color:#9aa5b4;font-size:14px;">請先在設計稿步驟輸入客製文字</p>`;
  } else {
    // 卡片 / USB：Three.js 3D 預覽
    const container = document.getElementById('preview3d-container');
    container.style = '';
    setTimeout(() => {
      init3DPreview('preview3d-container');
      if (STATE.productId === 'usb_bar') {
        buildUSB(finishId);
      } else if (dataURL) {
        buildCard(dataURL, finishId);
      } else {
        buildCard(null, finishId);
      }
    }, 150);
  }

  renderSpecSummary();
}

function renderSpecSummary() {
  const p = PRODUCTS[STATE.productId];
  if (!p) return;
  const mat = p.materials.find(m => m.id === STATE.materialId) || p.materials[0];
  const fin = p.finishes.find(f => f.id === STATE.finishId)     || p.finishes[0];
  const cap = p.capacities ? (p.capacities.find(c => c.id === STATE.capacityId) || p.capacities[0]) : null;
  const q   = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);

  const el = document.getElementById('preview-spec-summary');
  if (el) {
    el.innerHTML = `
      <div class="summary-badge" style="background:${p.color}">${p.name}</div>
      <table class="summary-table">
        <tr><td>材質</td><td>${mat.name}</td></tr>
        <tr><td>表面工藝</td><td>${fin.name}</td></tr>
        ${cap ? `<tr><td>容量</td><td>${cap.name}</td></tr>` : ''}
        <tr><td>數量</td><td>${STATE.qty.toLocaleString()} 個</td></tr>
        <tr><td>預估單價</td><td>NT$ ${q ? q.unitPrice.toLocaleString() : '--'}</td></tr>
        <tr><td>預估總計</td><td><strong>NT$ ${q ? q.total.toLocaleString() : '--'}</strong></td></tr>
        <tr><td>預計交期</td><td>${p.leadDays} 個工作天</td></tr>
      </table>
    `;
  }
}

// ─── Step 5：報價單 ────────────────────────────────────────
function initQuoteStep() {
  renderSpecSummary();

  const q = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);
  const quoteEl = document.getElementById('final-quote');
  if (quoteEl && q) {
    quoteEl.innerHTML = `
      <div class="quote-row"><span>單價</span><strong>NT$ ${q.unitPrice.toLocaleString()}</strong></div>
      <div class="quote-row"><span>小計（× ${q.qty.toLocaleString()}）</span><strong>NT$ ${q.subtotal.toLocaleString()}</strong></div>
      <div class="quote-row"><span>製版費</span><strong>NT$ ${q.setupFee.toLocaleString()}</strong></div>
      <div class="quote-row total"><span>預估總計（未稅）</span><strong>NT$ ${q.total.toLocaleString()}</strong></div>
      <p class="quote-disclaimer">※ 以上為估算報價，實際金額以業務確認為準。含稅報價另計。</p>
    `;
  }
}

// 送出詢價
async function submitQuote() {
  const name  = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const phone = document.getElementById('contact-phone').value.trim();
  const note  = document.getElementById('contact-note').value.trim();

  if (!name || !email) { alert('請填寫姓名與 Email'); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { alert('Email 格式不正確'); return; }

  const p   = PRODUCTS[STATE.productId];
  const q   = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);
  const mat = p.materials.find(m => m.id === STATE.materialId) || p.materials[0];
  const fin = p.finishes.find(f => f.id === STATE.finishId)     || p.finishes[0];
  const cap = p.capacities ? (p.capacities.find(c => c.id === STATE.capacityId) || p.capacities[0]) : null;

  // ── 儲存訂單資料至伺服器 ──
  try {
    await fetch('/api/save-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact: { name, email, phone, note },
        product: {
          id: p.id, name: p.name,
          material: mat.name,
          finish: fin.name,
          capacity: cap ? cap.name : null,
          qty: STATE.qty
        },
        quote: q,
        designDataURL: STATE.designDataURL || null
      })
    });
  } catch (e) {
    // 儲存失敗不阻止送出流程
    console.warn('[submitQuote] 訂單儲存失敗（不影響送出）', e);
  }

  // ── 開啟 mailto ──
  const subject = encodeURIComponent(`[楊竹科技詢價] ${p.name} × ${STATE.qty} 個`);
  const body = encodeURIComponent(
`楊竹科技線上詢價單
==================
聯絡人：${name}
Email：${email}
電話：${phone || '未填寫'}

產品：${p.name}
材質：${mat.name}
工藝：${fin.name}${cap ? `\n容量：${cap.name}` : ''}
數量：${STATE.qty.toLocaleString()} 個
預估總計：NT$ ${q ? q.total.toLocaleString() : '--'}（未稅，含製版費）

備註：
${note || '無'}

--
此詢價單由楊竹科技線上配置器自動產生
`);

  window.location.href = `mailto:sales@yangzhu.com.tw?subject=${subject}&body=${body}`;

  // 顯示成功訊息
  document.getElementById('quote-success').classList.remove('hidden');
}

// ─── 初始化 ───────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // 渲染產品卡片
  const grid = document.getElementById('product-grid');
  if (grid) {
    grid.innerHTML = Object.values(PRODUCTS).map(p => {
      const isSvg = p.image && p.image.toLowerCase().endsWith('.svg');
      const imgStyle = isSvg ? 'object-fit:contain;padding:8px;background:#f5f0ea;' : '';
      const sizeText = p.displaySize || `${p.size.w} × ${p.size.h} ${p.size.unit}`;
      const imgHtml = p.image
        ? `<div class="product-img-wrap">
             <img src="${p.image}" alt="${p.name}" class="product-img" loading="lazy"
                  style="${imgStyle}"
                  onerror="this.parentElement.outerHTML='<div class=\\'product-icon\\'>${p.icon}</div>'">
           </div>`
        : `<div class="product-icon">${p.icon}</div>`;
      return `
      <div class="product-card" data-product-id="${p.id}" onclick="selectProduct('${p.id}')">
        ${imgHtml}
        <div class="product-badge" style="background:${p.badgeColor}">${p.badge}</div>
        <h3>${p.name}</h3>
        <p>${p.description}</p>
        <div class="product-size">${sizeText}</div>
        <div class="product-min">最低 ${p.minQty} 個起</div>
      </div>
    `;
    }).join('');
  }

  // 綁定規格步驟事件（在切到 Step 2 時 render）
  document.querySelectorAll('.step-panel').forEach(panel => {
    if (panel.dataset.step == 2) {
      // 由 goStep 呼叫 renderSpecStep
    }
  });

  renderStep();
});

// Step 2 切入時需重新渲染
const _origGoStep = goStep;
