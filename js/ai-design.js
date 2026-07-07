// 楊竹科技 — AI 設計文案生成模組
// 直接從瀏覽器呼叫 OpenAI API（Key 存於 localStorage）

const AI_KEY_STORAGE = 'yz_openai_key';
let lastAIOptions = [];
let lastGeneratedImageDataURL = null;
let lastCartoonImageDataURL  = null;
let cartoonSourceDataURL     = null;

// ── 主要生成函式（透過伺服器 API Key）────────
async function generateAIDesign() {
  const userPrompt = document.getElementById('ai-prompt').value.trim();
  if (!userPrompt) {
    showAIError('請先輸入描述文字');
    document.getElementById('ai-prompt').focus();
    return;
  }

  const p   = PRODUCTS[STATE.productId] || {};
  const mat = p.materials
    ? (p.materials.find(m => m.id === STATE.materialId) || p.materials[0])
    : {};

  setAILoading(true);
  hideAIError();

  const resultsEl = document.getElementById('ai-results');
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';

  try {
    const resp = await fetch('/api/generate-design', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userPrompt,
        productId:    STATE.productId,
        materialName: mat.name || 'PVC',
        qty:          STATE.qty || 100
      })
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '生成失敗');

    lastAIOptions = data.options || [];
    renderAIOptions(lastAIOptions);
    resultsEl.classList.remove('hidden');

  } catch (err) {
    if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
      showAIError('🌐 網路連線失敗，請確認網路後再試');
    } else {
      showAIError('生成失敗：' + err.message);
    }
  } finally {
    setAILoading(false);
  }
}

// ── 取得 API Key（localStorage 或彈出輸入框）──
async function getOrAskAPIKey() {
  const stored = localStorage.getItem(AI_KEY_STORAGE);
  if (stored && stored.startsWith('sk-')) return stored;

  return new Promise(resolve => {
    // 建立 modal
    const overlay = document.createElement('div');
    overlay.id = 'ai-key-modal';
    overlay.innerHTML = `
      <div class="ai-modal-box">
        <div class="ai-modal-header">
          <span class="ai-badge">✨ AI 設定</span>
          <button class="ai-modal-close" id="ai-key-cancel">✕</button>
        </div>
        <p class="ai-modal-desc">
          請輸入你的 <strong>OpenAI API Key</strong> 來啟用 AI 生成功能。<br>
          Key 僅存在你的瀏覽器，不會上傳至任何伺服器。
        </p>
        <input type="password" id="ai-key-input"
          placeholder="sk-proj-xxxxxxxxxxxxxxxxxxxx"
          autocomplete="off"
          style="width:100%;padding:10px 12px;border:1.5px solid #86efac;border-radius:8px;font-size:14px;margin:8px 0 4px;">
        <p style="font-size:11px;color:#9aa5b4;margin-bottom:14px;">
          前往 <a href="https://platform.openai.com/api-keys" target="_blank" style="color:#16a34a">platform.openai.com/api-keys</a> 取得 Key
        </p>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button class="btn btn-secondary btn-sm" id="ai-key-cancel2">取消</button>
          <button class="btn btn-primary btn-sm" id="ai-key-confirm">確認並生成</button>
        </div>
      </div>
    `;
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px';
    document.body.appendChild(overlay);

    const input   = document.getElementById('ai-key-input');
    const confirm = document.getElementById('ai-key-confirm');
    const cancel  = document.getElementById('ai-key-cancel');
    const cancel2 = document.getElementById('ai-key-cancel2');

    setTimeout(() => input.focus(), 100);

    function close(key) {
      overlay.remove();
      resolve(key || null);
    }

    confirm.addEventListener('click', () => {
      const key = input.value.trim();
      if (!key.startsWith('sk-')) {
        input.style.borderColor = '#ef4444';
        input.placeholder = 'Key 格式不正確，應以 sk- 開頭';
        return;
      }
      localStorage.setItem(AI_KEY_STORAGE, key);
      close(key);
    });

    input.addEventListener('keydown', e => { if (e.key === 'Enter') confirm.click(); });
    cancel.addEventListener('click',  () => close(null));
    cancel2.addEventListener('click', () => close(null));
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
  });
}

// ── 直接呼叫 OpenAI Chat Completions API ────
async function callOpenAI(apiKey, userPrompt, productName, materialName, qty) {
  const systemPrompt = `你是楊竹科技的設計顧問，協助客戶設計客製化禮贈品的印刷文案。
楊竹科技是台灣悠遊卡、一卡通官方授權製造廠。

根據客戶描述，生成適合印在產品上的設計文字方案：
- 第一行（主標題）：10字以內，簡潔有力
- 第二行（副標題）：15字以內，可含英文或日期
- 顏色要配合描述的風格，提供 HEX 色碼
- 生成 3 個不同風格的方案
- 只回傳 JSON，不要其他文字`;

  const userMessage = `產品：${productName}（${materialName}），數量 ${qty} 個
客戶需求：${userPrompt}

JSON 格式：
{"options":[{"style":"風格名","textLine1":"主標題","textLine2":"副標題","textColor":"#hex","bgColor":"#hex","reason":"設計理念一句話"}]}`;

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  }
      ],
      temperature: 0.85,
      max_tokens: 700,
      response_format: { type: 'json_object' }
    })
  });

  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    const code    = errData?.error?.code || '';
    const msg     = errData?.error?.message || resp.statusText;
    throw new Error(code ? `${code}: ${msg}` : `${resp.status} ${msg}`);
  }

  const data = await resp.json();
  const raw  = data.choices?.[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  return parsed.options || [];
}

// ── 渲染方案卡片 ─────────────────────────────
function renderAIOptions(options) {
  const resultsEl = document.getElementById('ai-results');
  resultsEl.innerHTML = `
    <div style="font-size:12px;color:var(--gray-400);margin-bottom:6px;">
      ✅ 已生成 ${options.length} 個方案，點「套用」將文字填入設計區
    </div>
    ${options.map((opt, i) => {
      const fontFamily = (typeof STATE !== 'undefined' && STATE.font) ? STATE.font : 'Noto Sans TC';
      return `
      <div class="ai-option-card" id="ai-opt-${i}">
        <div class="ai-option-preview"
             style="background:${escHtml(opt.bgColor||'#fff')};color:${escHtml(opt.textColor||'#333')};font-family:'${escHtml(fontFamily)}',sans-serif">
          <div class="line1">${escHtml(opt.textLine1 || '')}</div>
          <div class="line2">${escHtml(opt.textLine2 || '')}</div>
        </div>
        <div class="ai-option-info">
          <div class="ai-option-style">方案 ${i+1}：${escHtml(opt.style||'')}</div>
          <div class="ai-option-text">
            ${escHtml(opt.textLine1||'')}
            ${opt.textLine2 ? `<span style="color:var(--gray-400)"> / </span>${escHtml(opt.textLine2)}` : ''}
          </div>
          <div class="ai-option-reason">${escHtml(opt.reason||'')}</div>
        </div>
        <button class="ai-apply-btn" onclick="applyAIOption(${i})">套用</button>
      </div>
    `}).join('')}
    <div style="text-align:right;margin-top:4px;">
      <button onclick="clearAIKey()" style="font-size:11px;color:var(--gray-400);background:none;border:none;cursor:pointer;text-decoration:underline;">
        更換 API Key
      </button>
    </div>
  `;
}

// ── 套用方案到 Canvas ─────────────────────────
function applyAIOption(index) {
  const opt = lastAIOptions[index];
  if (!opt) return;

  const fields = {
    'design-text1':   opt.textLine1 || '',
    'design-text2':   opt.textLine2 || '',
    'design-textcolor': opt.textColor || '#333333',
    'design-bgcolor':   opt.bgColor  || '#ffffff'
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });

  STATE.textLine1 = opt.textLine1 || '';
  STATE.textLine2 = opt.textLine2 || '';
  STATE.bgColor   = opt.bgColor   || '#ffffff';

  const font = STATE.font || document.getElementById('design-font')?.value || 'Noto Sans TC';
  clear2D();
  setBackground2D(opt.bgColor || '#ffffff');
  if (opt.textLine1) addText2D(opt.textLine1, opt.textColor || '#333333', null, font, 'title');
  if (opt.textLine2) addText2D(opt.textLine2, opt.textColor || '#333333', null, font, 'subtitle');

  document.querySelectorAll('.ai-option-card').forEach((el, i) => {
    el.classList.toggle('applied', i === index);
  });

  const btn = document.querySelector(`#ai-opt-${index} .ai-apply-btn`);
  if (btn) {
    btn.textContent = '✅ 已套用';
    setTimeout(() => { btn.textContent = '套用'; }, 1500);
  }

  document.querySelector('.canvas-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── 清除 Key ──────────────────────────────────
function clearAIKey() {
  localStorage.removeItem(AI_KEY_STORAGE);
  document.getElementById('ai-results').classList.add('hidden');
  hideAIError();
  showAIError('✅ API Key 已清除，下次生成時重新輸入。');
}

// ── AI 生圖（DALL-E 3）────────────────────
async function generateAIImage() {
  const prompt = document.getElementById('ai-image-prompt').value.trim();
  if (!prompt) {
    document.getElementById('ai-image-prompt').focus();
    return;
  }

  const p = PRODUCTS[STATE.productId] || {};
  setAIImageLoading(true);
  document.getElementById('ai-image-preview').classList.add('hidden');
  document.getElementById('ai-image-error').classList.add('hidden');

  try {
    const resp = await fetch('/api/generate-image', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ prompt, productName: p.name || '客製化卡片' })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '生成失敗');

    lastGeneratedImageDataURL = data.imageDataURL;

    const previewEl = document.getElementById('ai-image-preview');
    previewEl.innerHTML = `
      <img src="${data.imageDataURL}" style="width:100%;border-radius:8px;margin-top:10px;display:block;">
      <div style="font-size:12px;color:var(--gray-400);text-align:center;margin-top:6px;">✅ 已自動套用至卡面</div>
    `;
    previewEl.classList.remove('hidden');

    // 自動套用至 Canvas
    applyAIImage();

  } catch (err) {
    const errEl = document.getElementById('ai-image-error');
    errEl.textContent = '❌ ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    setAIImageLoading(false);
  }
}

function applyAIImage() {
  if (!lastGeneratedImageDataURL || !canvas2d) return;
  fabric.Image.fromURL(lastGeneratedImageDataURL, img => {
    const w = canvas2d.getWidth();
    const h = canvas2d.getHeight();
    // Math.max = 滿版填滿（超出邊緣自動裁切）
    const scale = Math.max(w / img.width, h / img.height);
    img.set({ left: w / 2, top: h / 2, originX: 'center', originY: 'center', scaleX: scale, scaleY: scale });
    canvas2d.add(img);
    canvas2d.sendToBack(img);   // 放到文字下方
    canvas2d.renderAll();
  });
}

// ── Q版卡通化 ──────────────────────────────────────────────
async function compressImage(dataURL, maxWidth = 800) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const cvs = document.createElement('canvas');
      cvs.width  = Math.round(img.width  * scale);
      cvs.height = Math.round(img.height * scale);
      cvs.getContext('2d').drawImage(img, 0, 0, cvs.width, cvs.height);
      resolve(cvs.toDataURL('image/jpeg', 0.82));
    };
    img.src = dataURL;
  });
}

function previewCartoonUpload(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    cartoonSourceDataURL = await compressImage(e.target.result, 800);
    const preview = document.getElementById('cartoon-upload-preview');
    const hint    = document.getElementById('cartoon-upload-hint');
    if (preview) preview.innerHTML = `<img src="${cartoonSourceDataURL}" style="max-width:100%;max-height:120px;border-radius:8px;object-fit:contain;display:block;margin:0 auto;">`;
    if (hint)    hint.textContent  = '已選擇圖片，點擊可重新選擇';
  };
  reader.readAsDataURL(file);
}

async function generateCartoonImage() {
  if (!cartoonSourceDataURL) {
    document.getElementById('cartoon-upload-input')?.click();
    return;
  }

  setCartoonLoading(true);
  document.getElementById('cartoon-preview').classList.add('hidden');
  document.getElementById('cartoon-error').classList.add('hidden');

  try {
    const resp = await fetch('/api/cartoon-image', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ imageDataURL: cartoonSourceDataURL })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '生成失敗');

    lastCartoonImageDataURL = data.imageDataURL;

    const previewEl = document.getElementById('cartoon-preview');
    previewEl.innerHTML = `
      <img src="${data.imageDataURL}" style="width:100%;border-radius:8px;margin-top:10px;display:block;">
      <div style="font-size:12px;color:var(--gray-400);text-align:center;margin-top:6px;">✅ 已自動套用至卡面</div>
    `;
    previewEl.classList.remove('hidden');

    // 自動套用至 Canvas
    applyCartoonImage();

  } catch (err) {
    const errEl = document.getElementById('cartoon-error');
    errEl.textContent = '❌ ' + err.message;
    errEl.classList.remove('hidden');
  } finally {
    setCartoonLoading(false);
  }
}

function applyCartoonImage() {
  if (!lastCartoonImageDataURL || !canvas2d) return;
  fabric.Image.fromURL(lastCartoonImageDataURL, img => {
    const w = canvas2d.getWidth();
    const h = canvas2d.getHeight();
    // 滿版填滿（同 AI生圖）
    const scale = Math.max(w / img.width, h / img.height);
    img.set({ left: w / 2, top: h / 2, originX: 'center', originY: 'center', scaleX: scale, scaleY: scale });
    canvas2d.add(img);
    canvas2d.sendToBack(img);
    canvas2d.renderAll();
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

function setAIImageLoading(on) {
  const btn  = document.getElementById('ai-image-btn');
  const text = document.getElementById('ai-image-btn-text');
  const load = document.getElementById('ai-image-btn-loading');
  if (!btn) return;
  btn.disabled = on;
  text?.classList.toggle('hidden',  on);
  load?.classList.toggle('hidden', !on);
}

// ── 工具函式 ──────────────────────────────────
function setAILoading(on) {
  const btn  = document.getElementById('ai-generate-btn');
  const text = document.getElementById('ai-btn-text');
  const load = document.getElementById('ai-btn-loading');
  btn.disabled = on;
  text.classList.toggle('hidden',  on);
  load.classList.toggle('hidden', !on);
}

function showAIError(msg) {
  const el = document.getElementById('ai-error');
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

function hideAIError() {
  const el = document.getElementById('ai-error');
  if (el) el.classList.add('hidden');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
