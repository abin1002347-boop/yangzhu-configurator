// 楊竹科技配置器 — Express 後端
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const OpenAI  = require('openai');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const port = process.env.PORT || 3000;

// ─── 訂單資料夾（本機在上層，雲端在專案目錄內）──────────────
const ORDER_DIR = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, '訂單資料')
  : path.join(__dirname, '..', '訂單資料');
if (!fs.existsSync(ORDER_DIR)) {
  fs.mkdirSync(ORDER_DIR, { recursive: true });
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));  // 設計圖 dataURL 可能較大
app.use(express.static(path.join(__dirname), { index: false }));  // 靜態資源，不自動服務 index.html

// ─── 頁面路由 ──────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/customize', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ─── OpenAI 初始化（Key 可選，無 Key 時 AI 功能停用）──────────
let openai = null;
if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-xxx')) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── 產品中文名對照 ────────────────────────
const PRODUCT_NAMES = {
  easycard: '客製化悠遊卡',
  ipass:    '客製化一卡通',
  usb_bar:  'USB 隨身碟',
  thermos:  '客製化保溫杯',
  usb_card: '名片型隨身碟'
};

// ─── 後台驗證（保護 /api/orders、/admin，避免客戶個資公開外洩）──
function checkAdminAuth(req, res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    return res.status(501).json({ error: '後台尚未設定 ADMIN_TOKEN，請在 .env 設定一組密碼後才能使用訂單查詢/後台功能' });
  }
  const provided = req.headers['x-admin-token'] || req.query.token;
  if (provided !== token) {
    return res.status(401).json({ error: '密碼錯誤或未提供，請輸入正確的後台密碼' });
  }
  next();
}

// ─── LINE Notify：新訂單主動推播（選填，設定 LINE_NOTIFY_TOKEN 才會發送）──
async function notifyNewOrder(order) {
  const token = process.env.LINE_NOTIFY_TOKEN;
  if (!token) return;
  try {
    const msg =
`\n📩 新詢價單
產品：${order.product.name} × ${order.product.qty} 個
客戶：${order.contact.name}
Email：${order.contact.email}
電話：${order.contact.phone || '未填寫'}
預估總額：NT$ ${order.quote?.total ? order.quote.total.toLocaleString() : '--'}`;
    await fetch('https://notify-api.line.me/api/notify', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ message: msg })
    });
  } catch (e) {
    console.error('[LINE Notify] 發送失敗:', e.message);
  }
}

// ─── AI 功能用量管控（避免被大量呼叫導致 OpenAI 帳單暴增）──────
const RATE_LIMIT_WINDOW_MS  = 60 * 60 * 1000; // 每小時
const RATE_LIMIT_MAX_PER_IP = 20;             // 每小時每 IP 上限
const DAILY_MAX_TOTAL       = 200;            // 每天全站上限（可依預算調整）
const _ipHits = new Map();
let _dailyCount = 0;
let _dailyResetAt = _startOfNextDay();

function _startOfNextDay() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function aiRateLimit(req, res, next) {
  const now = Date.now();
  if (now >= _dailyResetAt) {
    _dailyCount = 0;
    _dailyResetAt = _startOfNextDay();
  }
  if (_dailyCount >= DAILY_MAX_TOTAL) {
    return res.status(429).json({ error: '今日 AI 生成額度已滿，請明天再試或直接聯絡業務 02-2680-9966' });
  }
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const hits = (_ipHits.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (hits.length >= RATE_LIMIT_MAX_PER_IP) {
    return res.status(429).json({ error: '您使用 AI 功能過於頻繁，請稍後再試' });
  }
  hits.push(now);
  _ipHits.set(ip, hits);
  _dailyCount++;
  next();
}

// ─── API：儲存訂單 ─────────────────────────
app.post('/api/save-order', (req, res) => {
  try {
    const { contact, product, quote, designDataURL } = req.body;

    // 產生時間戳檔名
    const now    = new Date();
    const ts     = now.toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
    const safeEmail = (contact?.email || 'unknown').replace(/[^a-z0-9@._-]/gi, '_');
    const baseName  = `${ts}_${safeEmail}`;

    // 儲存設計圖 PNG（若有）
    let designImageFile = null;
    if (designDataURL && designDataURL.startsWith('data:image/')) {
      const base64 = designDataURL.replace(/^data:image\/\w+;base64,/, '');
      designImageFile = `${baseName}.png`;
      fs.writeFileSync(path.join(ORDER_DIR, designImageFile), Buffer.from(base64, 'base64'));
    }

    // 儲存訂單 JSON
    const orderRecord = {
      orderId:     baseName,
      savedAt:     now.toISOString(),
      contact,
      product,
      quote,
      designImageFile
    };
    fs.writeFileSync(
      path.join(ORDER_DIR, `${baseName}.json`),
      JSON.stringify(orderRecord, null, 2),
      'utf8'
    );

    console.log(`[訂單] 已儲存：${baseName}.json`);
    notifyNewOrder(orderRecord); // 不 await，避免拖慢客戶端回應
    res.json({ success: true, orderId: baseName });

  } catch (err) {
    console.error('[save-order]', err.message);
    res.status(500).json({ error: '訂單儲存失敗' });
  }
});

// ─── API：列出訂單（內部查詢用，需後台密碼）────────────────
app.get('/api/orders', checkAdminAuth, (req, res) => {
  try {
    const files = fs.readdirSync(ORDER_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse()
      .slice(0, 50);  // 最近 50 筆

    const orders = files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ORDER_DIR, f), 'utf8'));
      } catch { return null; }
    }).filter(Boolean);

    res.json({ success: true, count: orders.length, orders });
  } catch (err) {
    res.status(500).json({ error: '讀取失敗' });
  }
});

// ─── API：AI 生圖（DALL-E 3）──────────────
app.post('/api/generate-image', aiRateLimit, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI API Key 未設定' });

  const { prompt, productName } = req.body;
  if (!prompt || prompt.trim().length < 2) {
    return res.status(400).json({ error: '請輸入描述文字' });
  }

  const enhancedPrompt = `設計一張橫向卡片背景印刷圖案（比例 85:54，類似悠遊卡/信用卡），圖案必須完整填滿整個畫面、四邊無任何留白，直接可印製在「${productName || '客製化卡片'}」上。主題內容：${prompt.trim()}。設計規範：色彩飽滿鮮豔，滿版構圖四邊無白邊，無任何文字數字，高品質商業插畫，橫向印刷適用。`;

  try {
    const response = await openai.images.generate({
      model:           'dall-e-3',
      prompt:          enhancedPrompt,
      n:               1,
      size:            '1792x1024',
      quality:         'standard',
      response_format: 'b64_json'
    });

    const b64           = response.data[0].b64_json;
    const revisedPrompt = response.data[0].revised_prompt || '';
    res.json({
      success:       true,
      imageDataURL:  `data:image/png;base64,${b64}`,
      revisedPrompt
    });
  } catch (err) {
    console.error('[generate-image]', err.status, err.message);
    if (err.status === 400) return res.status(400).json({ error: '圖片描述違反內容政策，請修改描述後再試' });
    if (err.status === 401) return res.status(401).json({ error: 'API Key 無效' });
    if (err.status === 429) return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    if (err.status === 402) return res.status(402).json({ error: 'OpenAI 帳戶餘額不足，請至 platform.openai.com 儲值' });
    res.status(500).json({ error: `生成失敗：${err.message}` });
  }
});

// ─── API：AI 設計文字生成 ──────────────────
app.post('/api/generate-design', aiRateLimit, async (req, res) => {
  const { userPrompt, productId, materialName, qty } = req.body;

  if (!userPrompt || userPrompt.trim().length < 2) {
    return res.status(400).json({ error: '請輸入描述文字' });
  }

  if (!openai) {
    return res.status(503).json({ error: 'OpenAI API Key 尚未設定，AI 功能暫不可用' });
  }

  const productName = PRODUCT_NAMES[productId] || '客製化產品';

  const systemPrompt = `你是楊竹科技的設計顧問，專門協助客戶設計客製化禮贈品的印刷文案。
楊竹科技是台灣悠遊卡、一卡通官方授權製造廠，提供企業禮贈品客製服務。

你的任務：根據客戶描述，生成適合印在產品上的設計文字方案。

規則：
- 文字要簡潔有力，適合印刷
- 第一行（主標題）：10字以內，中文或中英混合
- 第二行（副標題）：15字以內，可含英文日期、品牌名
- 顏色建議：提供 HEX 色碼，要與產品相配
- 提供 3 個不同風格的方案
- 回傳純 JSON，不要有其他文字`;

  const userMessage = `產品：${productName}（${materialName || 'PVC 標準'}）
數量：${qty || 100} 個
客戶需求：${userPrompt.trim()}

請生成 3 個設計文字方案，以下列 JSON 格式回傳：
{
  "options": [
    {
      "style": "風格名稱",
      "textLine1": "主標題",
      "textLine2": "副標題",
      "textColor": "#hex顏色",
      "bgColor": "#hex顏色",
      "reason": "這個方案的設計理念（一句話）"
    }
  ]
}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  }
      ],
      temperature: 0.85,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    const raw  = completion.choices[0].message.content;
    const data = JSON.parse(raw);

    res.json({ success: true, options: data.options || [], usage: completion.usage });

  } catch (err) {
    console.error('[OpenAI Error]', err.message);
    if (err.status === 401) return res.status(401).json({ error: 'API Key 無效，請確認 .env 設定' });
    if (err.status === 429) return res.status(429).json({ error: 'API 請求過於頻繁，請稍後再試' });
    res.status(500).json({ error: '生成失敗，請稍後再試' });
  }
});

// ─── API：Q版卡通化（GPT-4o 描述 + DALL-E 3 生成）──────────
app.post('/api/cartoon-image', aiRateLimit, async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI API Key 未設定' });

  const { imageDataURL } = req.body;
  if (!imageDataURL || !imageDataURL.startsWith('data:image/')) {
    return res.status(400).json({ error: '請上傳圖片' });
  }

  try {
    // Step 1：GPT-4o-mini 描述圖片主體
    const visionResp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataURL, detail: 'low' } },
          { type: 'text', text: 'Describe the main subject in this photo in English, under 60 words. Focus on appearance: species/type, colors, expression, clothing, pose. Be specific.' }
        ]
      }],
      max_tokens: 120
    });

    const description = visionResp.choices[0].message.content.trim();

    // Step 2：DALL-E 3 生成 Q版卡通（橫向卡片格式）
    const cartoonPrompt = `A cute Japanese chibi Q-version cartoon illustration of: ${description}. The artwork MUST fill the entire horizontal card frame (85:54 ratio, like a credit card), with NO white space or margins on any edge — the design bleeds to all four sides. Style: big round sparkling eyes, tiny round body, pastel colors, kawaii anime style, vibrant background pattern that fills the whole card, NO text, NO numbers, NO words anywhere, high quality print-ready digital art.`;

    const imgResp = await openai.images.generate({
      model:           'dall-e-3',
      prompt:          cartoonPrompt,
      n:               1,
      size:            '1792x1024',
      quality:         'standard',
      response_format: 'b64_json'
    });

    const b64 = imgResp.data[0].b64_json;
    res.json({ success: true, imageDataURL: `data:image/png;base64,${b64}` });

  } catch (err) {
    console.error('[cartoon-image]', err.status, err.message);
    if (err.status === 400) return res.status(400).json({ error: '圖片內容違反政策，請換一張圖片' });
    if (err.status === 401) return res.status(401).json({ error: 'API Key 無效' });
    if (err.status === 429) return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    if (err.status === 402) return res.status(402).json({ error: 'OpenAI 帳戶餘額不足' });
    res.status(500).json({ error: `生成失敗：${err.message}` });
  }
});

// ─── 健康檢查 ──────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    version: '1.0',
    hasApiKey: !!(process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-xxx')),
    orderCount: fs.readdirSync(ORDER_DIR).filter(f => f.endsWith('.json')).length
  });
});

// ─── 啟動 ──────────────────────────────────
app.listen(port, () => {
  console.log('\n楊竹科技配置器已啟動');
  console.log(`→ 瀏覽器開啟：http://localhost:${port}`);
  console.log(`→ 訂單資料夾：${ORDER_DIR}`);
  console.log(`→ API Key 狀態：${process.env.OPENAI_API_KEY ? '已設定' : '❌ 未設定（請建立 .env）'}\n`);
});
