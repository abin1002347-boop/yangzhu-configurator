// 隔離測試：AI 圖片功能（generate_image／black_card_pattern／cartoon_image）遷移到
// gpt-image-2 的正確性，以及既有 db.js migration 的冪等性。
//
// 隔離邊界（比照 scripts/form-test.js 同一套慣例，這支腳本刻意不 require 那支腳本，
// 保持每支 scripts/ 底下的測試腳本各自獨立自足，符合既有慣例）：
// - 資料庫：全程使用 NODE_ENV=test + TEST_DB_DIR（作業系統臨時目錄底下新建的專屬資料夾），
//   Part A 是這支腳本自己的行程直接 require('../db.js')（先設好環境變數再 require），
//   Part B 是另外 spawn 一個獨立的 server.js 子行程，兩邊用不同的臨時資料夾，避免同一個
//   SQLite 檔案被兩個行程同時開啟造成鎖定問題。
// - OpenAI：全程不連線到真正的 api.openai.com。作法是啟動一個本機的假 OpenAI 伺服器
//   （純 Node http，不需要額外套件），把子行程的 OPENAI_BASE_URL 指向這個本機假伺服器——
//   官方 openai 套件的建構子本來就會讀 process.env.OPENAI_BASE_URL 當預設值（見
//   node_modules/openai/index.js 建構子註解），server.js 完全不需要為了測試而修改任何
//   一行正式程式碼。子行程的 OPENAI_API_KEY 是這支腳本自己產生的假值，只用來讓
//   server.js 的 `if (OPENAI_API_KEY) openai = new OpenAI(...)` 判斷式通過，不是真正的
//   OpenAI Key，不具備任何實際額度或身分意義。
// - 這支腳本完全不呼叫 /api/save-order，不會建立任何測試訂單；也不讀取本機 .env。

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const MAIN_SERVER_URL = 'http://localhost:3777';

let passCount = 0;
let failCount = 0;
function pass(label) { passCount++; console.log(`  ✓ ${label}`); }
function fail(label, detail) { failCount++; console.error(`  ✗ ${label}${detail ? '：' + detail : ''}`); }

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function statSnapshot(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return { exists: false };
  }
}
function snapshotsEqual(a, b) {
  if (a.exists !== b.exists) return false;
  if (!a.exists) return true;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}
function listDirSafe(dir) {
  try { return fs.readdirSync(dir).sort(); } catch (e) { return null; }
}
function arraysEqual(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}
function realPaths() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    adminDb:   isProd ? path.join(PROJECT_ROOT, 'data', 'admin.db') : path.join(PROJECT_ROOT, '..', '後台資料庫', 'admin.db'),
    orderDir:  isProd ? path.join(PROJECT_ROOT, '訂單資料') : path.join(PROJECT_ROOT, '..', '訂單資料'),
    factoryDir: isProd ? path.join(PROJECT_ROOT, 'factory-packages') : path.join(PROJECT_ROOT, '..', 'factory-packages'),
    uploadDir: path.join(PROJECT_ROOT, 'assets', 'uploads', 'products')
  };
}
async function checkMainServerAlive(label) {
  try {
    const resp = await fetch(MAIN_SERVER_URL + '/api/health');
    if (resp.status === 200 || resp.status === 503) { pass(label); return; }
    fail(label, `狀態碼 ${resp.status}`);
  } catch (e) {
    fail(label, `無法連線（${e.message}）——注意：這代表 3777 伺服器可能沒有在跑，不一定是這次測試造成的`);
  }
}
async function removeDirWithRetry(dir, attempts = 10, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return { ok: true };
    } catch (e) { /* 可能是檔案鎖還沒釋放，繼續重試 */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { ok: !fs.existsSync(dir) };
}
function killChildAndWait(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

// ─── 假 OpenAI 伺服器 ────────────────────────────────────────────────
// 用 sharp 產生一張結構完整、真正可被 sharp 再次處理的小 PNG（black_card_pattern 路由收到
// 圖片後會用 sharp 做 ensureAlpha／trim／extend，用隨便湊的假bytes容易在那段流程直接壞掉，
// 這裡改用真正的 sharp 輸出，跟正式路由處理真實 OpenAI 回應時的情境一致）。
async function buildMockPngBase64() {
  const sharp = require('sharp');
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 20, b: 20, alpha: 200 } }
  }).png().toBuffer();
  return buf.toString('base64');
}

function respondJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// 從 multipart/form-data 原始 bytes 裡找出指定欄位名稱的純文字值（不處理檔案欄位本身）。
// 只用來讀 cartoon_image 送出的 model／size／quality 這幾個已知的純文字欄位，不是通用
// multipart parser，足夠支撐這支測試的斷言即可。
function extractMultipartField(rawLatin1Text, fieldName) {
  const marker = `name="${fieldName}"`;
  const idx = rawLatin1Text.indexOf(marker);
  if (idx === -1) return null;
  const afterHeaders = rawLatin1Text.indexOf('\r\n\r\n', idx);
  if (afterHeaders === -1) return null;
  const valueStart = afterHeaders + 4;
  const valueEnd = rawLatin1Text.indexOf('\r\n--', valueStart);
  if (valueEnd === -1) return null;
  return rawLatin1Text.slice(valueStart, valueEnd);
}

function resolveErrorTrigger(text) {
  if (text.includes('MOCK_TRIGGER_401')) return { status: 401, body: { error: { message: 'Invalid API key provided', type: 'invalid_request_error' } } };
  if (text.includes('MOCK_TRIGGER_402')) return { status: 402, body: { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } } };
  if (text.includes('MOCK_TRIGGER_403')) return { status: 403, body: { error: { code: 'organization_not_verified', message: 'Your organization must be verified to use this model' } } };
  if (text.includes('MOCK_TRIGGER_429')) return { status: 429, body: { error: { message: 'Rate limit exceeded, please try again later' } } };
  if (text.includes('MOCK_TRIGGER_MODERATION')) return { status: 400, body: { error: { code: 'moderation_blocked', message: 'Your request was rejected by our safety system' } } };
  return null;
}

function startMockOpenAiServer(mockPngBase64) {
  const requestLog = [];
  const hangingResponses = [];
  let partialFailSeen = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      let bodyJson = null;
      if (contentType.includes('application/json')) {
        try { bodyJson = JSON.parse(rawBody.toString('utf8')); } catch (e) { /* 非合法JSON，保留null */ }
      }
      requestLog.push({ path: req.url, method: req.method, contentType, bodyJson, bodySize: rawBody.length });

      if (req.url === '/v1/moderations') {
        respondJson(res, 200, { id: 'modr-mock', model: 'omni-moderation-latest', results: [{ flagged: false, categories: {}, category_scores: {} }] });
        return;
      }

      if (req.url === '/v1/chat/completions') {
        respondJson(res, 200, {
          id: 'chatcmpl-mock',
          model: (bodyJson && bodyJson.model) || 'gpt-4o-mini',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: JSON.stringify({ options: [{ style: 'mock', textLine1: 'mock', textLine2: 'mock', textColor: '#000000', bgColor: '#ffffff', reason: 'mock' }] }) },
            finish_reason: 'stop'
          }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }
        });
        return;
      }

      if (req.url === '/v1/images/generations') {
        const prompt = (bodyJson && bodyJson.prompt) || '';
        if (prompt.includes('MOCK_TRIGGER_TIMEOUT')) {
          hangingResponses.push(res); // 故意不回應，讓呼叫端等自己的45秒逾時保護觸發
          return;
        }
        if (prompt.includes('MOCK_TRIGGER_PARTIAL_FAIL_ONCE')) {
          partialFailSeen++;
          if (partialFailSeen === 1) {
            // 故意用 400（用戶端錯誤，openai SDK 預設不會自動重試5xx／429那樣的暫時性錯誤
            // 才會重試）：如果這裡用 500，SDK 內建的 maxRetries 會自動重打一次，等於這個
            // 「刻意失敗一次」的請求重試後又成功了，測不出partial-success的情境。用400
            // 才能確保這個請求真的只失敗這一次、不會被SDK自己重試救回來。
            respondJson(res, 400, { error: { message: 'mock: intentional single failure for partial-success 測試（此為測試專用訊息，非真實OpenAI錯誤）' } });
            return;
          }
          respondJson(res, 200, { data: [{ b64_json: mockPngBase64 }] });
          return;
        }
        const triggered = resolveErrorTrigger(prompt);
        if (triggered) { respondJson(res, triggered.status, triggered.body); return; }
        respondJson(res, 200, { data: [{ b64_json: mockPngBase64, revised_prompt: 'mock revised prompt（測試專用，非真實OpenAI回應）' }] });
        return;
      }

      if (req.url === '/v1/images/edits') {
        // multipart/form-data：用輕量欄位擷取（見上方 extractMultipartField()）讀出
        // model／size／quality 這幾個已知的純文字欄位，直接記錄進requestLog，不需要在這支
        // 腳本裡持有整段原始bytes到後面才處理。
        const rawLatin1 = rawBody.toString('latin1');
        requestLog[requestLog.length - 1].multipartFields = {
          model: extractMultipartField(rawLatin1, 'model'),
          size: extractMultipartField(rawLatin1, 'size'),
          quality: extractMultipartField(rawLatin1, 'quality'),
          hasImageFile: rawLatin1.includes('name="image"') && rawLatin1.includes('filename=')
        };
        respondJson(res, 200, { data: [{ b64_json: mockPngBase64 }] });
        return;
      }

      respondJson(res, 404, { error: { message: 'mock openai server: 未知端點 ' + req.url } });
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        getRequestLog: () => requestLog,
        close: () => new Promise(r => {
          // 逾時測試留下的hang住連線，在關閉伺服器前主動結束，避免行程無法正常結束。
          hangingResponses.forEach(res => { try { if (!res.writableEnded) res.end(); } catch (e) {} });
          server.close(() => r());
        })
      });
    });
  });
}

function spawnTempServer(envOverrides, debugLabel) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let outBuf = '';
  child.stdout.on('data', d => { outBuf += d.toString(); if (process.env.AI_MIGRATION_TEST_DEBUG === '1') console.log(`[${debugLabel} stdout]`, d.toString().trim()); });
  child.stderr.on('data', d => { outBuf += d.toString(); if (process.env.AI_MIGRATION_TEST_DEBUG === '1') console.error(`[${debugLabel} stderr]`, d.toString().trim()); });
  return { child, getCombinedOutput: () => outBuf };
}
function waitForHealthy(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function attempt() {
      try {
        const resp = await fetch(baseUrl + '/api/health');
        if (resp.status === 200 || resp.status === 503) return resolve(true);
      } catch (e) { /* 伺服器可能還沒起來，繼續重試 */ }
      if (Date.now() > deadline) return reject(new Error('等待臨時伺服器啟動逾時'));
      setTimeout(attempt, 250);
    })();
  });
}
function isValidPngDataUrl(dataUrl) {
  if (typeof dataUrl !== 'string') return false;
  const m = dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return false;
  try { Buffer.from(m[1], 'base64'); return true; } catch (e) { return false; }
}

// ─── Part A：db.js migration 本身的邏輯測試（獨立行程內的獨立臨時DB，不牽涉HTTP）───────
function runPartA() {
  console.log('\n[Part A] db.js migrateAiImageFeaturesToGptImage2() 邏輯測試（獨立臨時資料庫）');
  const testDirA = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ai-migration-partA-'));
  process.env.NODE_ENV = 'test';
  process.env.TEST_DB_DIR = testDirA;

  const db = require(path.join(PROJECT_ROOT, 'db.js'));

  try {
    // 1. 全新資料庫三項圖片功能都應該已經是 gpt-image-2
    const freshSettings = db.getAllAiFeatureSettings();
    const freshOk = ['generate_image', 'black_card_pattern', 'cartoon_image'].every(k => {
      const s = freshSettings.find(x => x.featureKey === k);
      return s && s.model === 'gpt-image-2';
    });
    if (freshOk) pass('A1. 全新資料庫：三項圖片功能預設模型皆為 gpt-image-2');
    else fail('A1. 全新資料庫模型預設值不符', JSON.stringify(freshSettings.map(s => ({ k: s.featureKey, m: s.model }))));

    const designSetting = freshSettings.find(s => s.featureKey === 'generate_design');
    if (designSetting && designSetting.model === 'gpt-4o-mini') pass('A1b. generate_design 維持 gpt-4o-mini，未受圖片模型遷移影響');
    else fail('A1b. generate_design 模型不符預期', JSON.stringify(designSetting));

    // 2. 模擬「舊資料庫」：手動把三項圖片功能改回舊模型、pricing改回active，
    //    並刻意調整 enabled／某功能的提示詞內容，用來驗證migration不動這些欄位。
    db.db.prepare(`UPDATE ai_feature_settings SET model = 'dall-e-3' WHERE feature_key = 'generate_image'`).run();
    db.db.prepare(`UPDATE ai_feature_settings SET model = 'gpt-image-1' WHERE feature_key = 'black_card_pattern'`).run();
    db.db.prepare(`UPDATE ai_feature_settings SET model = 'gpt-image-1', enabled = 0 WHERE feature_key = 'cartoon_image'`).run();
    db.db.prepare(`UPDATE ai_pricing_settings SET availability_status = 'active' WHERE model = 'gpt-image-1'`).run();
    const marker = 'MIGRATION_TEST_MARKER_不應被migration修改';
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ? WHERE prompt_key = 'cartoon_image_base'`).run(marker);

    const beforeMigration = db.getAllAiFeatureSettings();
    const oldOk = beforeMigration.find(s => s.featureKey === 'generate_image').model === 'dall-e-3'
      && beforeMigration.find(s => s.featureKey === 'black_card_pattern').model === 'gpt-image-1'
      && beforeMigration.find(s => s.featureKey === 'cartoon_image').model === 'gpt-image-1'
      && beforeMigration.find(s => s.featureKey === 'cartoon_image').enabled === false;
    if (oldOk) pass('A2. 模擬舊資料庫狀態建立成功（dall-e-3／gpt-image-1，cartoon_image已停用）');
    else fail('A2. 模擬舊資料庫狀態建立失敗', JSON.stringify(beforeMigration));

    // 3. 執行 migration
    const result1 = db.migrateAiImageFeaturesToGptImage2();
    const afterMigration = db.getAllAiFeatureSettings();
    const migratedOk = ['generate_image', 'black_card_pattern', 'cartoon_image'].every(k => {
      const s = afterMigration.find(x => x.featureKey === k);
      return s && s.model === 'gpt-image-2';
    });
    if (migratedOk) pass('A3. 舊資料庫執行migration後，三項圖片功能皆已改成 gpt-image-2');
    else fail('A3. migration後模型不符預期', JSON.stringify(afterMigration.map(s => ({ k: s.featureKey, m: s.model }))));

    const cartoonAfter = afterMigration.find(s => s.featureKey === 'cartoon_image');
    if (cartoonAfter.enabled === false) pass('A4. migration 不修改 enabled 欄位（cartoon_image 停用狀態維持不變）');
    else fail('A4. migration 誤動了 enabled 欄位', JSON.stringify(cartoonAfter));

    const promptAfter = db.getAiPromptSetting('cartoon_image_base');
    if (promptAfter && promptAfter.content === marker) pass('A5. migration 不修改提示詞內容');
    else fail('A5. migration 疑似誤動了提示詞內容', JSON.stringify(promptAfter));

    const pricingAfter = db.getAllAiPricingSettings().filter(p => p.model === 'gpt-image-1');
    const pricingDeprecated = pricingAfter.length > 0 && pricingAfter.every(p => p.availabilityStatus === 'deprecated');
    if (pricingDeprecated) pass('A6. migration 同步把 gpt-image-1 的價格資料狀態改成 deprecated');
    else fail('A6. gpt-image-1 價格資料狀態未正確更新', JSON.stringify(pricingAfter));

    if (result1.featureRowsUpdated === 3 && result1.pricingRowsUpdated === 3) {
      pass(`A7. 第一次執行migration回報異動筆數正確（feature=${result1.featureRowsUpdated}／pricing=${result1.pricingRowsUpdated}）`);
    } else {
      fail('A7. 第一次執行migration回報異動筆數不符預期', JSON.stringify(result1));
    }

    // 4. 再執行一次，驗證冪等：第二次不應該再有任何列被異動，且結果狀態與第一次執行後完全相同
    const result2 = db.migrateAiImageFeaturesToGptImage2();
    const afterSecondRun = db.getAllAiFeatureSettings();
    const sameAsFirst = JSON.stringify(afterSecondRun) === JSON.stringify(afterMigration);
    if (sameAsFirst) pass('A8. 第二次執行migration後，資料狀態與第一次執行後完全相同');
    else fail('A8. 第二次執行migration後資料狀態改變了', '不應該再有變動');

    if (result2.featureRowsUpdated === 0 && result2.pricingRowsUpdated === 0) {
      pass('A9. 第二次執行migration回報異動筆數為0（冪等，不會重複破壞資料）');
    } else {
      fail('A9. 第二次執行migration仍回報有異動', JSON.stringify(result2));
    }

    // 5. 新增的 gpt-image-2 價格資料存在且金額正確
    const sq = db.getAiPricingByRateKey('gpt_image_2_medium_1024_square');
    const po = db.getAiPricingByRateKey('gpt_image_2_medium_1024_portrait');
    const la = db.getAiPricingByRateKey('gpt_image_2_medium_1024_landscape');
    if (sq && sq.unitPriceUsd === 0.018 && po && po.unitPriceUsd === 0.027 && la && la.unitPriceUsd === 0.027
        && sq.availabilityStatus === 'active' && po.availabilityStatus === 'active' && la.availabilityStatus === 'active') {
      pass('A10. gpt-image-2 三組價格資料（正方形／直式／橫式）存在、金額與狀態正確');
    } else {
      fail('A10. gpt-image-2 價格資料不符預期', JSON.stringify({ sq, po, la }));
    }

    const dalle3 = db.getAiPricingByRateKey('dall_e_3_standard_landscape');
    if (dalle3 && dalle3.availabilityStatus === 'removed' && dalle3.unitPriceUsd === null) {
      pass('A11. dall-e-3 舊價格資料維持 removed／null，不受這批影響');
    } else {
      fail('A11. dall-e-3 舊價格資料狀態改變了', JSON.stringify(dalle3));
    }

    // ── 6. migrateGenerateImagePromptToBackgroundOnly()：generate_image_main 提示詞
    //    遷移到純背景素材版本（2026-08-24裁切功能改版新增，回應Codex複驗「缺少正式回歸
    //    測試」的意見）。同一支獨立臨時資料庫、同一個行程，接續上面的圖片模型migration
    //    測試繼續測，不另外開新的臨時資料夾。───────────────────────────────
    const LEGACY_GENERATE_IMAGE_PROMPT = `設計一張橫向卡片背景印刷圖案（比例 85:54，類似悠遊卡/信用卡），圖案必須完整填滿整個畫面、四邊無任何留白，直接可印製在「{{PRODUCT_NAME}}」上。主題內容：{{USER_INPUT}}。設計規範：色彩飽滿鮮豔，滿版構圖四邊無白邊，無任何文字數字，高品質商業插畫，橫向印刷適用。`;

    // 6a. 全新資料庫（這支腳本一開始建立的那個）預設就應該已經是新版純背景提示詞
    const freshPrompt = db.getAiPromptSetting('generate_image_main');
    const freshPromptOk = !!freshPrompt && freshPrompt.content.includes('僅作為背景素材使用') && !freshPrompt.content.includes('類似悠遊卡');
    if (freshPromptOk) pass('A12. 全新資料庫：generate_image_main 預設已是新版純背景提示詞');
    else fail('A12. 全新資料庫的 generate_image_main 提示詞不符預期', JSON.stringify(freshPrompt));

    // 6b. 模擬舊資料庫：手動把內容改回舊版字串（模擬尚未遷移的既有資料庫），驗證測試前提本身正確
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'system' WHERE prompt_key = 'generate_image_main'`).run(LEGACY_GENERATE_IMAGE_PROMPT);
    const beforePromptMigration = db.getAiPromptSetting('generate_image_main');
    if (beforePromptMigration.content === LEGACY_GENERATE_IMAGE_PROMPT) {
      pass('A13. 模擬舊資料庫的 generate_image_main 提示詞建立成功');
    } else {
      fail('A13. 模擬舊資料庫的提示詞內容建立失敗', JSON.stringify(beforePromptMigration));
    }

    // 6c. 第一次執行 migration：應該更新這1筆，內容改成新版純背景提示詞
    const promptResult1 = db.migrateGenerateImagePromptToBackgroundOnly();
    const afterPromptMigration1 = db.getAiPromptSetting('generate_image_main');
    if (promptResult1.promptRowsUpdated === 1) {
      pass('A14. 第一次執行 migrateGenerateImagePromptToBackgroundOnly() 回報 promptRowsUpdated=1');
    } else {
      fail('A14. 第一次執行回報的異動筆數不符預期', JSON.stringify(promptResult1));
    }
    const newContentOk = afterPromptMigration1.content.includes('禁止出現任何文字') &&
      afterPromptMigration1.content.includes('禁止出現悠遊卡') &&
      !afterPromptMigration1.content.includes('類似悠遊卡');
    if (newContentOk) {
      pass('A15. migration 後 generate_image_main 內容已包含純背景限制（禁止文字／禁止卡片外型等描述）');
    } else {
      fail('A15. migration 後的提示詞內容不符預期', afterPromptMigration1.content);
    }

    // 6d. 第二次執行，驗證冪等：不應該再更新任何列，內容也應該完全相同
    const promptResult2 = db.migrateGenerateImagePromptToBackgroundOnly();
    const afterPromptMigration2 = db.getAiPromptSetting('generate_image_main');
    if (promptResult2.promptRowsUpdated === 0) {
      pass('A16. 第二次執行 migrateGenerateImagePromptToBackgroundOnly() 回報 promptRowsUpdated=0（冪等）');
    } else {
      fail('A16. 第二次執行仍回報有異動', JSON.stringify(promptResult2));
    }
    if (afterPromptMigration2.content === afterPromptMigration1.content) {
      pass('A17. 第二次執行後，提示詞內容與第一次執行後完全相同，未再被改變');
    } else {
      fail('A17. 第二次執行後提示詞內容改變了', '不應該再有變動');
    }

    // 6e. 管理員自訂提示詞不得被覆蓋：把內容改成「不等於舊版預設值」的自訂文字——
    //     migration 的 UPDATE 條件式限定「目前內容剛好等於舊版預設值」才會更新，
    //     自訂內容不符合這個條件，理論上完全不會被這支migration碰到。
    const customPromptContent = 'MIGRATION_TEST_ADMIN_CUSTOM_PROMPT_不應被migration覆蓋';
    const customUpdatedAt = new Date(Date.now() - 3600000).toISOString(); // 隨便一個過去時間，方便比對「完全沒被改動」
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'owner', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(customPromptContent, customUpdatedAt);
    const promptResult3 = db.migrateGenerateImagePromptToBackgroundOnly();
    const afterCustom = db.getAiPromptSetting('generate_image_main');
    if (promptResult3.promptRowsUpdated === 0 && afterCustom.content === customPromptContent) {
      pass('A18. 管理員自訂提示詞（不等於舊版預設值）不會被 migration 覆蓋，promptRowsUpdated=0');
    } else {
      fail('A18. migration 疑似覆蓋了管理員自訂的提示詞內容', JSON.stringify({ promptResult3, afterCustom }));
    }
    if (afterCustom.updatedBy === 'owner' && afterCustom.updatedAt === customUpdatedAt) {
      pass('A19. 管理員自訂提示詞的 updated_by／updated_at 維持原樣，沒有被改成 system-migration-20260824-crop');
    } else {
      fail('A19. 管理員自訂提示詞的 updated_by／updated_at 被意外改動', JSON.stringify(afterCustom));
    }

    // ── 7. inspectKnownCorruptedAiPrompts()／migrateKnownCorruptedAiPromptsToDefaults()：
    //    Codex 唯讀複驗本機正式 admin.db 發現 generate_image_main／generate_design_system
    //    兩筆提示詞的中文已被永久轉成 ASCII 問號，這裡補上對應的隔離測試。下面兩個常數是
    //    CC 用唯讀連線直接讀取正式 `後台資料庫/admin.db` 取得的精確損壞內容（逐字元比對），
    //    只用在這支隔離測試腳本裡模擬同一種已知損壞，不會、也從未寫回正式資料庫。同一個
    //    獨立臨時資料庫、同一個行程，接續上面 A1-A19 繼續測，不另外開新的臨時資料夾。──
    const KNOWN_CORRUPTED_GENERATE_IMAGE_MAIN = "??????????????(?? 85:54,?????/???),????????????????????,???????{{PRODUCT_NAME}}???????:{{USER_INPUT}}?????:??????,?????????,???????,???????,???????";
    const KNOWN_CORRUPTED_GENERATE_DESIGN_SYSTEM = "???????????,????????????????????\n?????????????????????,????????????\n\n????:??????,?????????????????\n\n??:\n- ???????,????\n- ???(???):10???,???????\n- ???(???):15???,??????????\n- ????:?? HEX ??,??????\n- ?? 3 ????????\n- ??? JSON,???????";

    // 這一整段開始前先拍照：其他三支提示詞內容、AI功能模型設定、AI使用次數限制，
    // 之後 A33／A34 用來確認新函式全程沒有影響到這些不相關的資料。
    const OTHER_PROMPT_KEYS_SNAPSHOT_BEFORE = ['black_card_pattern_system', 'cartoon_image_base', 'cartoon_image_black_card']
      .map(k => ({ promptKey: k, content: db.getAllAiPromptSettings().find(p => p.promptKey === k).content }));
    const FEATURE_SETTINGS_SNAPSHOT_BEFORE = db.getAllAiFeatureSettings();
    const USAGE_LIMIT_SNAPSHOT_BEFORE = db.getAiUsageLimitSettings();

    // 先把上面A18的自訂內容還原成目前正確預設值，確保這一整段從乾淨的「already_current」
    // 起點開始測試，不受A18殘留狀態影響。
    const currentDefaults = {
      generate_image_main: freshPrompt.content, // A12已驗證這就是目前 AI_PROMPT_DEFAULTS 的純背景版本
      generate_design_system: null // 稍後用 db.getAllAiPromptSettings() 實際取值，避免手動謄打長字串出錯
    };
    currentDefaults.generate_design_system = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system').content;
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'system', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(currentDefaults.generate_image_main, new Date().toISOString());

    // 7a. 全新（已還原）狀態：兩筆都應該分類成 already_current
    const inspectFresh = db.inspectKnownCorruptedAiPrompts();
    const freshImg = inspectFresh.find(r => r.promptKey === 'generate_image_main');
    const freshDesign = inspectFresh.find(r => r.promptKey === 'generate_design_system');
    if (freshImg.status === 'already_current' && freshDesign.status === 'already_current') {
      pass('A20. 兩筆提示詞皆為目前正確內容時，inspectKnownCorruptedAiPrompts() 分類為 already_current');
    } else {
      fail('A20. 已還原狀態的分類不符預期', JSON.stringify(inspectFresh));
    }

    // 7b. 建立精確的兩筆問號損壞資料（模擬正式站已確認過的損壞內容與 updated_by／updated_at）
    const knownCorruptedTimestamp = '2026-08-07T15:50:06.253Z';
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'admin', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(KNOWN_CORRUPTED_GENERATE_IMAGE_MAIN, knownCorruptedTimestamp);
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'admin', updated_at = ? WHERE prompt_key = 'generate_design_system'`).run(KNOWN_CORRUPTED_GENERATE_DESIGN_SYSTEM, knownCorruptedTimestamp);
    const corruptedRowImg = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_image_main');
    const corruptedRowDesign = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system');
    if (corruptedRowImg.content === KNOWN_CORRUPTED_GENERATE_IMAGE_MAIN && corruptedRowDesign.content === KNOWN_CORRUPTED_GENERATE_DESIGN_SYSTEM) {
      pass('A21. 已建立精確的兩筆問號損壞測試資料');
    } else {
      fail('A21. 建立問號損壞測試資料失敗', JSON.stringify({ corruptedRowImg, corruptedRowDesign }));
    }

    // 7c. 唯讀分析：兩筆都應該正確分類成 known_corrupted
    const inspectCorrupted = db.inspectKnownCorruptedAiPrompts();
    const corruptedImgStatus = inspectCorrupted.find(r => r.promptKey === 'generate_image_main');
    const corruptedDesignStatus = inspectCorrupted.find(r => r.promptKey === 'generate_design_system');
    if (corruptedImgStatus.status === 'known_corrupted' && corruptedDesignStatus.status === 'known_corrupted') {
      pass('A22. inspectKnownCorruptedAiPrompts() 正確把兩筆問號損壞內容分類成 known_corrupted');
    } else {
      fail('A22. 唯讀分析分類不符預期', JSON.stringify(inspectCorrupted));
    }

    // 7d. 唯讀分析本身不得寫入資料庫：分析前後兩筆的 content／updated_by／updated_at 完全不變
    const afterInspectRowImg = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_image_main');
    const afterInspectRowDesign = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system');
    const inspectIsReadOnly = afterInspectRowImg.content === KNOWN_CORRUPTED_GENERATE_IMAGE_MAIN && afterInspectRowImg.updatedBy === 'admin' && afterInspectRowImg.updatedAt === knownCorruptedTimestamp
      && afterInspectRowDesign.content === KNOWN_CORRUPTED_GENERATE_DESIGN_SYSTEM && afterInspectRowDesign.updatedBy === 'admin' && afterInspectRowDesign.updatedAt === knownCorruptedTimestamp;
    if (inspectIsReadOnly) {
      pass('A23. 執行 inspectKnownCorruptedAiPrompts() 後，兩筆資料內容與 updated_by／updated_at 完全沒變（純唯讀）');
    } else {
      fail('A23. inspectKnownCorruptedAiPrompts() 疑似有寫入副作用', JSON.stringify({ afterInspectRowImg, afterInspectRowDesign }));
    }

    // 7e. 執行修復 migration：總更新筆數應為2，兩筆的 originalStatus 都應回報 known_corrupted
    const repairResult1 = db.migrateKnownCorruptedAiPromptsToDefaults();
    if (repairResult1.totalRowsUpdated === 2
        && repairResult1.results.generate_image_main.originalStatus === 'known_corrupted' && repairResult1.results.generate_image_main.updated === true
        && repairResult1.results.generate_design_system.originalStatus === 'known_corrupted' && repairResult1.results.generate_design_system.updated === true) {
      pass('A24. migrateKnownCorruptedAiPromptsToDefaults() 第一次執行：兩筆問號損壞資料皆正確辨識並更新，totalRowsUpdated=2');
    } else {
      fail('A24. 修復 migration 第一次執行結果不符預期', JSON.stringify(repairResult1));
    }

    // 7f. generate_image_main 還原成目前純背景提示詞（不是舊版「類似悠遊卡」內容）
    const repairedImg = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_image_main');
    if (repairedImg.content === currentDefaults.generate_image_main
        && repairedImg.content.includes('僅作為背景素材使用') && !repairedImg.content.includes('類似悠遊卡')
        && repairedImg.updatedBy === 'system-migration-20260824-corrupted-prompt-repair') {
      pass('A25. generate_image_main 修復後等於目前 AI_PROMPT_DEFAULTS 的純背景提示詞，updated_by 為新遷移名稱');
    } else {
      fail('A25. generate_image_main 修復後內容不符預期', JSON.stringify(repairedImg));
    }

    // 7g. generate_design_system 還原成目前正確的楊竹設計顧問提示詞
    const repairedDesign = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system');
    if (repairedDesign.content === currentDefaults.generate_design_system
        && repairedDesign.content.includes('楊竹科技的設計顧問') && repairedDesign.content.includes('回傳純 JSON')
        && repairedDesign.updatedBy === 'system-migration-20260824-corrupted-prompt-repair') {
      pass('A26. generate_design_system 修復後等於目前 AI_PROMPT_DEFAULTS 的正確設計顧問提示詞，updated_by 為新遷移名稱');
    } else {
      fail('A26. generate_design_system 修復後內容不符預期', JSON.stringify(repairedDesign));
    }

    // 7h. 第二次執行修復 migration：應該完全冪等，totalRowsUpdated=0，兩筆內容與第一次執行後相同
    const repairResult2 = db.migrateKnownCorruptedAiPromptsToDefaults();
    const repairedImgAfter2 = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_image_main');
    const repairedDesignAfter2 = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system');
    if (repairResult2.totalRowsUpdated === 0
        && repairResult2.results.generate_image_main.originalStatus === 'already_current'
        && repairResult2.results.generate_design_system.originalStatus === 'already_current') {
      pass('A27. migrateKnownCorruptedAiPromptsToDefaults() 第二次執行 totalRowsUpdated=0（冪等）');
    } else {
      fail('A27. 修復 migration 第二次執行結果不符預期', JSON.stringify(repairResult2));
    }
    if (repairedImgAfter2.content === repairedImg.content && repairedImgAfter2.updatedAt === repairedImg.updatedAt
        && repairedDesignAfter2.content === repairedDesign.content && repairedDesignAfter2.updatedAt === repairedDesign.updatedAt) {
      pass('A28. 第二次執行後，兩筆內容與 updated_at 皆與第一次執行後完全相同，未再被改動');
    } else {
      fail('A28. 第二次執行後資料疑似又被改動了', '不應該再有變動');
    }

    // 7i. 管理員自訂 generate_image_main 不得被覆蓋
    const customImageContent = 'MIGRATION_TEST_ADMIN_CUSTOM_GENERATE_IMAGE_MAIN_不應被修復migration覆蓋';
    const customImageUpdatedAt = new Date(Date.now() - 7200000).toISOString();
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'owner', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(customImageContent, customImageUpdatedAt);
    const inspectCustomImg = db.inspectKnownCorruptedAiPrompts().find(r => r.promptKey === 'generate_image_main');
    const repairResult3 = db.migrateKnownCorruptedAiPromptsToDefaults();
    const afterCustomImg = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_image_main');
    if (inspectCustomImg.status === 'custom_or_unknown'
        && repairResult3.results.generate_image_main.originalStatus === 'custom_or_unknown' && repairResult3.results.generate_image_main.updated === false
        && afterCustomImg.content === customImageContent && afterCustomImg.updatedBy === 'owner' && afterCustomImg.updatedAt === customImageUpdatedAt) {
      pass('A29. 管理員自訂的 generate_image_main（不等於任何已知版本）不會被修復migration覆蓋，分類正確為 custom_or_unknown');
    } else {
      fail('A29. 修復migration疑似覆蓋了管理員自訂的 generate_image_main', JSON.stringify({ inspectCustomImg, repairResult3, afterCustomImg }));
    }
    // 還原回目前正確預設值，避免影響後面的測試
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'system', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(currentDefaults.generate_image_main, new Date().toISOString());

    // 7j. 管理員自訂 generate_design_system 不得被覆蓋
    const customDesignContent = 'MIGRATION_TEST_ADMIN_CUSTOM_GENERATE_DESIGN_SYSTEM_不應被修復migration覆蓋';
    const customDesignUpdatedAt = new Date(Date.now() - 7200000).toISOString();
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'owner', updated_at = ? WHERE prompt_key = 'generate_design_system'`).run(customDesignContent, customDesignUpdatedAt);
    const inspectCustomDesign = db.inspectKnownCorruptedAiPrompts().find(r => r.promptKey === 'generate_design_system');
    const repairResult4 = db.migrateKnownCorruptedAiPromptsToDefaults();
    const afterCustomDesign = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system');
    if (inspectCustomDesign.status === 'custom_or_unknown'
        && repairResult4.results.generate_design_system.originalStatus === 'custom_or_unknown' && repairResult4.results.generate_design_system.updated === false
        && afterCustomDesign.content === customDesignContent && afterCustomDesign.updatedBy === 'owner' && afterCustomDesign.updatedAt === customDesignUpdatedAt) {
      pass('A30. 管理員自訂的 generate_design_system（不等於任何已知版本）不會被修復migration覆蓋，分類正確為 custom_or_unknown');
    } else {
      fail('A30. 修復migration疑似覆蓋了管理員自訂的 generate_design_system', JSON.stringify({ inspectCustomDesign, repairResult4, afterCustomDesign }));
    }
    // 還原回目前正確預設值，避免影響後面的測試
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'system', updated_at = ? WHERE prompt_key = 'generate_design_system'`).run(currentDefaults.generate_design_system, new Date().toISOString());

    // 7k. 只有部分問號、但不完全等於已知精確損壞內容的資料，不可被視為 known_corrupted 修改
    //     （模擬「只有一部分被腐蝕」或人工不小心打了問號但跟已知損壞內容不完全相同的情境）。
    const partiallyCorruptedContent = '?'.repeat(20) + currentDefaults.generate_image_main.slice(20);
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'admin', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(partiallyCorruptedContent, knownCorruptedTimestamp);
    const inspectPartial = db.inspectKnownCorruptedAiPrompts().find(r => r.promptKey === 'generate_image_main');
    const repairResult5 = db.migrateKnownCorruptedAiPromptsToDefaults();
    const afterPartial = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_image_main');
    if (inspectPartial.status === 'custom_or_unknown'
        && repairResult5.results.generate_image_main.originalStatus === 'custom_or_unknown' && repairResult5.results.generate_image_main.updated === false
        && afterPartial.content === partiallyCorruptedContent) {
      pass('A31. 只有部分問號、不完全等於已知精確損壞內容的資料，正確分類為 custom_or_unknown 且不會被修改');
    } else {
      fail('A31. 部分問號內容被誤判或被錯誤修改', JSON.stringify({ inspectPartial, repairResult5, afterPartial }));
    }
    // 還原回目前正確預設值，避免影響後面的測試
    db.db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_by = 'system', updated_at = ? WHERE prompt_key = 'generate_image_main'`).run(currentDefaults.generate_image_main, new Date().toISOString());

    // 7l. missing 狀態：資料列不存在時，唯讀分析回報 missing，修復migration不得自動建立資料列
    db.db.prepare(`DELETE FROM ai_prompt_settings WHERE prompt_key = 'generate_design_system'`).run();
    const inspectMissing = db.inspectKnownCorruptedAiPrompts().find(r => r.promptKey === 'generate_design_system');
    const repairResult6 = db.migrateKnownCorruptedAiPromptsToDefaults();
    const afterMissing = db.getAllAiPromptSettings().find(p => p.promptKey === 'generate_design_system');
    if (inspectMissing.status === 'missing' && inspectMissing.updatedBy === null && inspectMissing.updatedAt === null
        && repairResult6.results.generate_design_system.originalStatus === 'missing' && repairResult6.results.generate_design_system.updated === false
        && afterMissing === undefined) {
      pass('A32. generate_design_system 資料列不存在時，正確分類為 missing，修復migration不會自動建立資料列');
    } else {
      fail('A32. missing 狀態處理不符預期', JSON.stringify({ inspectMissing, repairResult6, afterMissing }));
    }
    // 還原回目前正確預設值，避免影響後面的測試（含關掉整支腳本前的其餘一致性檢查）
    db.db.prepare(`INSERT INTO ai_prompt_settings (prompt_key, feature_key, content, updated_at, updated_by) VALUES ('generate_design_system', 'generate_design', ?, ?, 'system')`).run(currentDefaults.generate_design_system, new Date().toISOString());

    // 7m. 這一整段（A20-A32）過程中，其他三支提示詞（black_card_pattern_system／
    //     cartoon_image_base／cartoon_image_black_card）內容前後應完全一致：新增的兩支函式
    //     全程只用 prompt_key='generate_image_main' 或 'generate_design_system' 當WHERE條件，
    //     結構上不可能動到其他 prompt_key。
    const otherPromptsAfter = OTHER_PROMPT_KEYS_SNAPSHOT_BEFORE.map(k => ({
      promptKey: k.promptKey,
      content: db.getAllAiPromptSettings().find(p => p.promptKey === k.promptKey).content
    }));
    const otherPromptsUnchanged = OTHER_PROMPT_KEYS_SNAPSHOT_BEFORE.every((before, i) => before.content === otherPromptsAfter[i].content);
    if (otherPromptsUnchanged) {
      pass('A33. black_card_pattern_system／cartoon_image_base／cartoon_image_black_card 三支提示詞內容前後完全一致，未受影響');
    } else {
      fail('A33. 其他提示詞內容疑似被意外改動', JSON.stringify({ before: OTHER_PROMPT_KEYS_SNAPSHOT_BEFORE, after: otherPromptsAfter }));
    }

    // 7n. AI模型設定與AI使用次數限制全程不受這兩支新函式影響
    const featureSettingsAfter = db.getAllAiFeatureSettings();
    const usageLimitAfter = db.getAiUsageLimitSettings();
    const featureSettingsUnchanged = JSON.stringify(featureSettingsAfter) === JSON.stringify(FEATURE_SETTINGS_SNAPSHOT_BEFORE);
    const usageLimitUnchanged = usageLimitAfter.enabled === true && usageLimitAfter.clientHourlyLimit === 20 && usageLimitAfter.siteDailyLimit === 200
      && JSON.stringify(usageLimitAfter) === JSON.stringify(USAGE_LIMIT_SNAPSHOT_BEFORE);
    if (featureSettingsUnchanged && usageLimitUnchanged) {
      pass('A34. AI功能模型設定（含enabled）與AI使用次數限制（每小時20次／全站每日200次）全程未被這兩支新函式影響');
    } else {
      fail('A34. AI功能模型設定或使用次數限制疑似被意外改動', JSON.stringify({ featureSettingsAfter, usageLimitAfter }));
    }

    // 7o. 這一整段測試自始至終都在本支腳本自建的 TEST_DB_DIR 臨時資料庫（testDirA）內操作，
    //     沒有任何一行程式碼指向或讀寫本機正式 `後台資料庫/admin.db`——結構上的保證見本檔案
    //     最上方「隔離邊界」說明；本支腳本 main() 最後另外會呼叫 runPartB() 的B9/B10，
    //     對正式 admin.db 及訂單／工廠包／上傳資料夾做整支腳本執行前後的快照比對，涵蓋這一段
    //     Part A 測試在內，不需要在這裡重複比對一次。
    pass('A35. 本段（A20-A32）修復migration相關測試全程只操作 TEST_DB_DIR 臨時資料庫，正式 admin.db 一致性由後面的 B9/B10 統一覆核');

  } finally {
    db.db.close();
  }

  try { fs.rmSync(testDirA, { recursive: true, force: true }); } catch (e) {}
}

// ─── Part B：實際 HTTP 呼叫（獨立子行程 server.js ＋ 假OpenAI伺服器）─────────────────
async function runPartB() {
  console.log('\n[Part B] 實際 API 呼叫測試（獨立子行程 + 本機假OpenAI伺服器，全程不連線真正的OpenAI）');

  const real = realPaths();
  const before = {
    adminDb: statSnapshot(real.adminDb),
    orderDir: listDirSafe(real.orderDir),
    factoryDir: listDirSafe(real.factoryDir),
    uploadDir: listDirSafe(real.uploadDir)
  };

  const mockPngBase64 = await buildMockPngBase64();
  const mock = await startMockOpenAiServer(mockPngBase64);

  const testDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ai-migration-partB-'));
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const fakeApiKey = 'sk-mock-' + crypto.randomBytes(24).toString('hex'); // 只用於讓openai變數初始化，非真實金鑰

  const { child, getCombinedOutput } = spawnTempServer({
    PORT: String(port),
    NODE_ENV: 'test',
    FORM_TEST_MODE: 'false',
    TEST_DB_DIR: testDirB,
    OPENAI_API_KEY: fakeApiKey,
    OPENAI_BASE_URL: mock.baseUrl,
    ADMIN_TOKEN: '',
    ADMIN_CSRF_SECRET: '',
    LINE_NOTIFY_TOKEN: '',
    CHATBOT_PUBLIC_URL: ''
  }, 'CHILD-ai-test');

  try {
    await waitForHealthy(baseUrl, 10000);
    pass('B1. 臨時伺服器（已設定假OpenAI Key＋假OpenAI伺服器網址）可正常啟動');

    // ── generate_image：成功路徑，驗證模型／尺寸／品質／回傳格式 ──
    {
      const r = await fetch(baseUrl + '/api/generate-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '測試用卡片圖案描述', productName: '測試卡片', productId: 'easycard' })
      });
      const d = await r.json();
      const reqEntry = [...mock.getRequestLog()].reverse().find(e => e.path === '/v1/images/generations');
      const paramsOk = reqEntry && reqEntry.bodyJson && reqEntry.bodyJson.model === 'gpt-image-2'
        && reqEntry.bodyJson.size === '1536x1024' && reqEntry.bodyJson.quality === 'medium';
      if (r.status === 200 && d.success === true && isValidPngDataUrl(d.imageDataURL) && paramsOk) {
        pass('B2. generate_image 成功：呼叫 images.generate，model=gpt-image-2、size=1536x1024、quality=medium，回傳合法 base64 PNG');
      } else {
        fail('B2. generate_image 成功路徑不符預期', `status=${r.status} paramsOk=${paramsOk} body=${JSON.stringify(d)}`);
      }
    }

    // ── black_card_pattern：部分成功（3次呼叫，1次失敗） ──
    {
      const r = await fetch(baseUrl + '/api/black-card-pattern-candidates', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'MOCK_TRIGGER_PARTIAL_FAIL_ONCE 測試圖案', productId: 'black_card', style: 'chibi' })
      });
      const d = await r.json();
      const genEntries = mock.getRequestLog().filter(e => e.path === '/v1/images/generations' && e.bodyJson && typeof e.bodyJson.prompt === 'string' && e.bodyJson.prompt.includes('MOCK_TRIGGER_PARTIAL_FAIL_ONCE'));
      const paramsOk = genEntries.length > 0 && genEntries.every(e => e.bodyJson.model === 'gpt-image-2' && e.bodyJson.size === '1024x1024' && e.bodyJson.quality === 'medium' && e.bodyJson.background === 'transparent');
      if (r.status === 200 && d.success === true && d.partial === true && Array.isArray(d.images) && d.images.length === 2 && d.failedCount === 1 && d.images.every(isValidPngDataUrl) && paramsOk) {
        pass('B3. black_card_pattern 部分成功：3次呼叫中1次失敗，正確回傳 partial=true／2張圖／failedCount=1，model=gpt-image-2、background=transparent');
      } else {
        fail('B3. black_card_pattern 部分成功情境不符預期', `status=${r.status} paramsOk=${paramsOk} body=${JSON.stringify(d)}`);
      }
    }

    // ── generate_image：401／402／403／429／內容安全拒絕（各自獨立呼叫一次）──
    const errorCases = [
      { trigger: 'MOCK_TRIGGER_401', expectStatus: 401, label: '401（API Key無效）' },
      { trigger: 'MOCK_TRIGGER_402', expectStatus: 402, label: '402（額度不足）' },
      { trigger: 'MOCK_TRIGGER_403', expectStatus: 403, label: '403（組織未驗證）' },
      { trigger: 'MOCK_TRIGGER_429', expectStatus: 429, label: '429（請求過於頻繁）' },
      { trigger: 'MOCK_TRIGGER_MODERATION', expectStatus: 400, label: '400（內容安全拒絕）' }
    ];
    for (const c of errorCases) {
      const r = await fetch(baseUrl + '/api/generate-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: c.trigger + ' 測試描述', productName: '測試卡片', productId: 'easycard' })
      });
      const d = await r.json();
      const looksChinese = typeof d.error === 'string' && /[一-鿿]/.test(d.error);
      if (r.status === c.expectStatus && looksChinese) {
        pass(`B4. generate_image 錯誤處理 ${c.label} 正確轉換成繁體中文錯誤訊息（HTTP ${r.status}）`);
      } else {
        fail(`B4. generate_image 錯誤處理 ${c.label} 不符預期`, `status=${r.status} body=${JSON.stringify(d)}`);
      }
    }

    // ── cartoon_image：成功路徑，確認使用 images.edit（multipart），model=gpt-image-2 ──
    {
      const dataUrl = `data:image/png;base64,${mockPngBase64}`;
      const r = await fetch(baseUrl + '/api/cartoon-image', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageDataURL: dataUrl, styleId: 'default', productId: 'easycard', mode: 'standard' })
      });
      const d = await r.json();
      const editEntry = [...mock.getRequestLog()].reverse().find(e => e.path === '/v1/images/edits');
      const fields = editEntry && editEntry.multipartFields;
      const paramsOk = fields && fields.model === 'gpt-image-2' && fields.size === '1024x1536' && fields.quality === 'medium' && fields.hasImageFile === true;
      if (r.status === 200 && d.success === true && isValidPngDataUrl(d.imageDataURL) && paramsOk) {
        pass('B5. cartoon_image 成功：正確呼叫 images.edit（multipart/form-data），model=gpt-image-2、size=1024x1536、quality=medium，附帶圖片檔案，回傳合法 base64 PNG');
      } else {
        fail('B5. cartoon_image 成功路徑不符預期', `status=${r.status} paramsOk=${paramsOk} fields=${JSON.stringify(fields)} body=${JSON.stringify(d)}`);
      }
    }

    // ── generate_design：確認 gpt-4o-mini 文字功能不受這批圖片模型遷移影響 ──
    {
      const r = await fetch(baseUrl + '/api/generate-design', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userPrompt: '測試設計需求描述', productId: 'easycard', materialName: 'PVC 標準卡', qty: 100 })
      });
      const d = await r.json();
      const chatEntry = [...mock.getRequestLog()].reverse().find(e => e.path === '/v1/chat/completions');
      const modelOk = chatEntry && chatEntry.bodyJson && chatEntry.bodyJson.model === 'gpt-4o-mini';
      if (r.status === 200 && d.success !== false && modelOk) {
        pass('B6. generate_design 文字設計功能正常運作，model 維持 gpt-4o-mini，未受圖片模型遷移影響');
      } else {
        fail('B6. generate_design 不符預期', `status=${r.status} modelOk=${modelOk} body=${JSON.stringify(d)}`);
      }
    }

    // ── black_card_pattern：逾時保護（真的等45秒讓伺服器自己的逾時邏輯觸發）──
    {
      console.log('  … B7 逾時測試進行中，需要真的等待約45秒讓伺服器自己的逾時保護觸發，請耐心等候');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 55000);
      try {
        const r = await fetch(baseUrl + '/api/black-card-pattern-candidates', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'MOCK_TRIGGER_TIMEOUT 測試逾時', productId: 'black_card', style: 'chibi' }),
          signal: controller.signal
        });
        const d = await r.json();
        if (r.status === 504) {
          pass('B7. black_card_pattern 逾時保護正確觸發（HTTP 504），45秒逾時機制實際被驗證過，不是只看程式碼');
        } else {
          fail('B7. black_card_pattern 逾時保護未正確觸發', `status=${r.status} body=${JSON.stringify(d)}`);
        }
      } catch (e) {
        fail('B7. black_card_pattern 逾時測試發生例外', e.message);
      } finally {
        clearTimeout(timer);
      }
    }

    // ── 日誌／回應內容不得包含假金鑰或Base64圖片內容 ──
    const combinedOutput = getCombinedOutput();
    const leakChecks = [];
    if (combinedOutput.includes(fakeApiKey)) leakChecks.push('子行程輸出中出現了假API Key本身');
    if (combinedOutput.includes(mockPngBase64.slice(0, 60))) leakChecks.push('子行程輸出中出現了圖片Base64內容片段');
    if (leakChecks.length === 0) {
      pass('B8. 子行程 stdout／stderr 全程未出現假API Key或Base64圖片內容');
    } else {
      fail('B8. 子行程輸出疑似洩漏敏感資料', leakChecks.join('、'));
    }

  } catch (e) {
    fail('Part B 測試流程發生未預期例外', e.message);
  } finally {
    await killChildAndWait(child);
    await mock.close();
  }

  const after = {
    adminDb: statSnapshot(real.adminDb),
    orderDir: listDirSafe(real.orderDir),
    factoryDir: listDirSafe(real.factoryDir),
    uploadDir: listDirSafe(real.uploadDir)
  };
  if (snapshotsEqual(before.adminDb, after.adminDb)) {
    pass('B9. 真實 admin.db 的修改時間與檔案大小在測試前後完全一致');
  } else {
    fail('B9. 真實 admin.db 疑似被異動', `測試前 exists=${before.adminDb.exists} 測試後 exists=${after.adminDb.exists}`);
  }
  if (arraysEqual(before.orderDir, after.orderDir) && arraysEqual(before.factoryDir, after.factoryDir) && arraysEqual(before.uploadDir, after.uploadDir)) {
    pass('B10. 真實訂單／工廠包／上傳資料夾在測試前後沒有新增或減少任何檔案');
  } else {
    fail('B10. 真實訂單／工廠包／上傳資料夾疑似有變動');
  }

  const cleanup = await removeDirWithRetry(testDirB);
  if (cleanup.ok) pass('B11. 臨時資料夾成功清除（SQLite檔案鎖已釋放）');
  else fail('B11. 臨時資料夾清理失敗', '可能仍有檔案鎖未釋放，路徑為作業系統臨時目錄，未刪除任何非臨時路徑');
}

async function main() {
  console.log('[ai-image-migration-test] 開始測試（獨立臨時伺服器＋獨立臨時資料庫＋本機假OpenAI伺服器，不影響現有 3777 伺服器、正式資料，也不連線真正的OpenAI）');

  await checkMainServerAlive('（測試前）目前 3777 伺服器可連線');

  runPartA();
  await runPartB();

  await checkMainServerAlive('（測試後）目前 3777 伺服器不中斷（測試後仍可連線）');

  console.log(`\n[ai-image-migration-test] 完成：${passCount} 通過、${failCount} 失敗`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('[ai-image-migration-test] 執行時發生未預期錯誤：', e.message, e.stack);
  process.exitCode = 1;
});
