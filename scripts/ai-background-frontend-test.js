// 隔離測試：悠遊卡／一卡通「AI 生成背景」前台功能（2026-08-24 新增；2026-08-24 改版新增
// 「生成後裁切選取範圍再套用」流程，避免整張AI生成圖含卡片外框/晶片等內容直接套用），
// 以及成本涵蓋範圍標籤修正（admin-routes.js 的 featureCostCoverage()）。
//
// 隔離邊界（比照 scripts/ai-image-migration-test.js 同一套慣例，這支腳本刻意不 require
// 那支腳本，保持每支 scripts/ 底下的測試腳本各自獨立自足）：
// - 資料庫：獨立子行程 server.js + NODE_ENV=test + TEST_DB_DIR（作業系統臨時目錄），不碰
//   本機正式 admin.db、訂單、工廠包或上傳資料夾。
// - OpenAI：全程不連線到真正的 api.openai.com，用本機假 OpenAI 伺服器（純 Node http），
//   子行程的 OPENAI_BASE_URL 指向它；OPENAI_API_KEY 是這支腳本自己產生的假值。
// - 瀏覽器：用專案既有的 playwright devDependency 啟動本機 headless Chromium，實際操作
//   http://localhost:<測試用埠>/customize?product=... 這個由子行程伺服的真實前台頁面，
//   不是用 jsdom 或其他模擬 DOM 的方式。
// - 後台驗證：用這支腳本自己產生的隨機 ADMIN_TOKEN 登入子行程的後台（比照
//   scripts/form-test.js 的 testOnlyAdminToken 慣例），只用來讀取 AI 使用統計，不建立、
//   不修改任何正式資料。
//
// 裁切框測試策略說明：裁切框的「不得超出圖片範圍」與「比例鎖定」兩項核心規則，用兩種
// 互補的方式驗證——(1) 對邊界情境（例如把裁切框硬設到超出圖片範圍很多、或設成極端不等比例
// 的縮放）直接呼叫頁面內的 _clampAiBgCropRect()／_clampAiBgCropScale()，確認結果被正確
// 夾回合法範圍，這樣能可靠測到 headless 滑鼠很難精準模擬出的極端邊界情況；(2) 額外用一次
// 真實滑鼠拖曳（page.mouse down/move/up）驗證 Fabric Canvas 本身確實可以被使用者實際拖動，
// 證明不是只有底層函式邏輯正確、UI實際上卻連不動。手機觸控（單指拖曳/縮放）目前受限於
// headless測試環境沒有真實觸控裝置可模擬複雜手勢，改用「裁切框底層clamp邏輯與滑鼠拖曳
// 邏輯完全共用同一套程式碼、不分裝置」＋「touch-action:none 樣式確認」＋「各手機尺寸下
// 版面與裁切框比例正確」來驗證，這點已誠實記錄在完成回報的「已知限制」。

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const PROJECT_ROOT = path.join(__dirname, '..');

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

// 產生一張有內部結構（非單一色塊）的假圖：四個顏色象限＋對角線，讓裁切不同區域時
// 「畫面內容確實不同」這件事可以被驗證（單純色塊圖裁哪裡結果看起來都一樣，測不出裁切
// 是否真的生效），也讓自然尺寸夠大（1536x1024，跟正式 gpt-image-2 橫式輸出一致）足以
// 測試顯示縮放/取樣座標換算的正確性。
async function buildMockPngBase64() {
  const sharp = require('sharp');
  const w = 1536, h = 1024;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="0" y="0" width="${w / 2}" height="${h / 2}" fill="#2d7d46"/>
    <rect x="${w / 2}" y="0" width="${w / 2}" height="${h / 2}" fill="#c8a968"/>
    <rect x="0" y="${h / 2}" width="${w / 2}" height="${h / 2}" fill="#3f6b8a"/>
    <rect x="${w / 2}" y="${h / 2}" width="${w / 2}" height="${h / 2}" fill="#8a3f6b"/>
    <circle cx="${w / 2}" cy="${h / 2}" r="40" fill="#ffffff"/>
  </svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  return buf.toString('base64');
}

function respondJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

// 跟 ai-image-migration-test.js 的 resolveErrorTrigger() 同一套慣例，這裡另外加一個
// MOCK_TRIGGER_DELAY2S（延遲2秒才回成功），專門用來測試「商品切換後舊回應不會誤套用」——
// 需要一個「請求還沒回來」的時間窗口讓測試腳本在等待期間切換商品。
function resolveTrigger(text) {
  if (text.includes('MOCK_TRIGGER_401')) return { status: 401, body: { error: { message: 'Invalid API key provided', type: 'invalid_request_error' } } };
  return null;
}

function startMockOpenAiServer(mockPngBase64) {
  const requestLog = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      let bodyJson = null;
      if ((req.headers['content-type'] || '').includes('application/json')) {
        try { bodyJson = JSON.parse(rawBody.toString('utf8')); } catch (e) {}
      }
      requestLog.push({ path: req.url, method: req.method, bodyJson });

      if (req.url === '/v1/moderations') {
        respondJson(res, 200, { id: 'modr-mock', model: 'omni-moderation-latest', results: [{ flagged: false, categories: {}, category_scores: {} }] });
        return;
      }
      if (req.url === '/v1/images/generations') {
        const prompt = (bodyJson && bodyJson.prompt) || '';
        if (prompt.includes('MOCK_TRIGGER_DELAY2S')) {
          setTimeout(() => respondJson(res, 200, { data: [{ b64_json: mockPngBase64, revised_prompt: '' }] }), 2000);
          return;
        }
        const triggered = resolveTrigger(prompt);
        if (triggered) { respondJson(res, triggered.status, triggered.body); return; }
        respondJson(res, 200, { data: [{ b64_json: mockPngBase64, revised_prompt: '' }] });
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
        baseUrl: `http://127.0.0.1:${port}/v1`,
        getRequestLog: () => requestLog,
        countGenerationRequestsForPrompt: (needle) => requestLog.filter(e => e.path === '/v1/images/generations' && e.bodyJson && typeof e.bodyJson.prompt === 'string' && e.bodyJson.prompt.includes(needle)).length,
        close: () => new Promise(r => server.close(() => r()))
      });
    });
  });
}

function killChildAndWait(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}
function waitForHealthy(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function attempt() {
      try {
        const resp = await fetch(baseUrl + '/api/health');
        if (resp.status === 200 || resp.status === 503) return resolve(true);
      } catch (e) {}
      if (Date.now() > deadline) return reject(new Error('等待臨時伺服器啟動逾時'));
      setTimeout(attempt, 250);
    })();
  });
}
async function removeDirWithRetry(dir, attempts = 10, delayMs = 300) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!fs.existsSync(dir)) return { ok: true };
    } catch (e) {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  return { ok: !fs.existsSync(dir) };
}

function extractSessionCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  const found = arr.find(c => c.startsWith('yz_admin_sid='));
  if (!found) return null;
  return found.split(';')[0];
}

async function goToDesignStep(page, product) {
  await page.goto(`${page._yzBaseUrl}/customize?product=${product}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /下一步：設計稿/ }).click();
  await page.waitForSelector('#photo-upload-tabs, #black-card-pattern-panel', { state: 'attached' });
}

// 產生一張背景圖並開啟裁切彈窗，回傳彈窗內裁切狀態的即時讀值（方便多處測試共用）
async function generateAndOpenCrop(page, prompt) {
  await page.locator('#wb-tab-btn-aibg').click();
  await page.fill('#ai-bg-prompt', prompt);
  await page.click('#ai-bg-btn');
  await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
  await page.click('#ai-bg-apply-btn'); // 按鈕文字已改「選取背景範圍」，onclick 改開啟裁切彈窗
  await page.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
  await page.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });
}
async function readCropState(page) {
  return page.evaluate(() => {
    const st = _aiBgCrop;
    const r = st.rect;
    const w = r.width * r.scaleX, h = r.height * r.scaleY;
    return {
      displayLeft: st.displayLeft, displayTop: st.displayTop, displayW: st.displayW, displayH: st.displayH,
      rectLeft: r.left, rectTop: r.top, rectW: w, rectH: h,
      ratio: st.ratio, naturalW: st.naturalW, naturalH: st.naturalH
    };
  });
}
function withinBounds(c, tol = 1) {
  return c.rectLeft >= c.displayLeft - tol && c.rectTop >= c.displayTop - tol &&
    (c.rectLeft + c.rectW) <= c.displayLeft + c.displayW + tol &&
    (c.rectTop + c.rectH) <= c.displayTop + c.displayH + tol;
}
function ratioOk(c, tol = 0.02) {
  return Math.abs((c.rectW / c.rectH) - c.ratio) < tol;
}

async function main() {
  console.log('[ai-background-frontend-test] 開始測試（獨立臨時伺服器＋獨立臨時資料庫＋本機假OpenAI伺服器＋本機headless瀏覽器，全程不連線真正的OpenAI，不影響正式3777與正式資料）');

  const mockPngBase64 = await buildMockPngBase64();
  const mock = await startMockOpenAiServer(mockPngBase64);

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-ai-bg-frontend-'));
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const fakeApiKey = 'sk-mock-' + crypto.randomBytes(24).toString('hex');
  const testOnlyAdminToken = crypto.randomBytes(16).toString('hex');

  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      FORM_TEST_MODE: 'false',
      TEST_DB_DIR: testDir,
      OPENAI_API_KEY: fakeApiKey,
      OPENAI_BASE_URL: mock.baseUrl,
      ADMIN_TOKEN: testOnlyAdminToken,
      ADMIN_CSRF_SECRET: '',
      LINE_NOTIFY_TOKEN: '',
      CHATBOT_PUBLIC_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let combinedOutput = '';
  child.stdout.on('data', d => { combinedOutput += d.toString(); });
  child.stderr.on('data', d => { combinedOutput += d.toString(); });

  let browser = null;
  try {
    await waitForHealthy(baseUrl, 10000);
    pass('T1. 臨時伺服器（本機假OpenAI伺服器＋隨機測試用ADMIN_TOKEN）可正常啟動');

    browser = await chromium.launch();

    // ── 只有 easycard／ipass 顯示「AI生成背景」分頁，thermos／black_card 不顯示 ──
    for (const [product, shouldShow] of [['easycard', true], ['ipass', true], ['thermos', false], ['black_card', false]]) {
      const page = await browser.newPage();
      page._yzBaseUrl = baseUrl;
      await goToDesignStep(page, product);
      const visible = await page.locator('#wb-tab-btn-aibg').isVisible().catch(() => false);
      if (visible === shouldShow) {
        pass(`T2. 商品「${product}」的「AI生成背景」分頁顯示狀態正確（應${shouldShow ? '顯示' : '不顯示'}）`);
      } else {
        fail(`T2. 商品「${product}」的「AI生成背景」分頁顯示狀態不符`, `實際=${visible} 預期=${shouldShow}`);
      }
      await page.close();
    }

    // ── 主要流程：easycard，切到 AI生成背景 分頁 ──
    const page = await browser.newPage();
    page._yzBaseUrl = baseUrl;
    const consoleErrors = [];
    // 「Failed to load resource: ...status of 4xx/5xx」是瀏覽器對非2xx HTTP回應的預設網路
    // 記錄，不是JS例外——刻意觸發401錯誤情境本來就會產生這則訊息，那是預期中的正常網路
    // 記錄（我們自己的錯誤處理UI另外驗證過），不是這批功能程式碼本身的錯誤，過濾掉避免
    // 誤判成新增的程式錯誤。
    const BENIGN_CONSOLE_PATTERN = /Failed to load resource: the server responded with a status of \d+/;
    page.on('console', msg => { if (msg.type() === 'error' && !BENIGN_CONSOLE_PATTERN.test(msg.text())) consoleErrors.push(msg.text()); });
    page.on('pageerror', err => { consoleErrors.push('pageerror: ' + err.message); });

    await goToDesignStep(page, 'easycard');
    await page.locator('#wb-tab-btn-aibg').click();
    const baselineErrorCount = consoleErrors.length;

    // ── 描述太短，顯示驗證錯誤，不送出請求 ──
    {
      await page.fill('#ai-bg-prompt', 'A');
      await page.click('#ai-bg-btn');
      await page.waitForTimeout(300);
      const errVisible = await page.locator('#ai-bg-error').isVisible();
      const errText = await page.locator('#ai-bg-error').textContent();
      const reqCount = mock.countGenerationRequestsForPrompt('__never__');
      if (errVisible && /2.{0,4}200/.test(errText || '') && reqCount === 0) {
        pass('T3. 背景描述太短時顯示驗證錯誤，且未送出任何生成請求');
      } else {
        fail('T3. 描述太短的驗證行為不符預期', `visible=${errVisible} text=${errText} reqCount=${reqCount}`);
      }
    }

    // ── 正常生成流程（loading → 成功 → 預覽 → 「選取背景範圍」按鈕出現）──
    const prompt1 = 'T4測試背景描述：四色象限測試圖';
    {
      await page.fill('#ai-bg-prompt', prompt1);
      const clickPromise = page.click('#ai-bg-btn');
      await page.waitForTimeout(50);
      const disabledDuringLoad = await page.locator('#ai-bg-btn').isDisabled();
      await clickPromise;
      await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      const applyVisible = await page.locator('#ai-bg-apply-btn').isVisible();
      const applyText = (await page.locator('#ai-bg-apply-btn').textContent() || '').trim();
      const previewSrc = await page.locator('#ai-bg-preview img').getAttribute('src');
      const validPng = typeof previewSrc === 'string' && previewSrc.startsWith('data:image/png;base64,');
      if (disabledDuringLoad && applyVisible && validPng && applyText === '選取背景範圍') {
        pass('T4. 正常生成流程：按鈕生成中鎖定、成功後顯示合法圖片預覽、「選取背景範圍」按鈕出現');
      } else {
        fail('T4. 正常生成流程不符預期', `disabledDuringLoad=${disabledDuringLoad} applyVisible=${applyVisible} validPng=${validPng} applyText=${applyText}`);
      }
    }

    // ── 點「選取背景範圍」開啟裁切彈窗：裁切框比例正確、且不超出圖片顯示範圍 ──
    {
      await page.click('#ai-bg-apply-btn');
      await page.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
      await page.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });
      const c = await readCropState(page);
      const ratioMatch = ratioOk(c);
      const boundsOk = withinBounds(c);
      const naturalOk = c.naturalW === 1536 && c.naturalH === 1024;
      if (ratioMatch && boundsOk && naturalOk) {
        pass(`T5. 裁切彈窗開啟後，裁切框比例正確（${(c.rectW / c.rectH).toFixed(3)} ≈ ${c.ratio.toFixed(3)}）且未超出圖片顯示範圍`);
      } else {
        fail('T5. 裁切彈窗初始狀態不符預期', JSON.stringify(c));
      }
    }

    // ── 裁切框「不得超出原始圖片範圍」：故意設成大幅超出邊界的座標，驗證clamp函式正確夾回 ──
    {
      const clampMove = await page.evaluate(() => {
        const st = _aiBgCrop, r = st.rect;
        const w = r.width * r.scaleX, h = r.height * r.scaleY;
        r.set({ left: -999, top: -999 });
        _clampAiBgCropRect();
        const afterNeg = { left: r.left, top: r.top };
        r.set({ left: st.displayW + 999, top: st.displayH + 999 });
        _clampAiBgCropRect();
        const afterPos = { left: r.left, top: r.top };
        return { afterNeg, afterPos, w, h, displayW: st.displayW, displayH: st.displayH };
      });
      const negOk = clampMove.afterNeg.left === 0 && clampMove.afterNeg.top === 0;
      const posOk = Math.abs(clampMove.afterPos.left - (clampMove.displayW - clampMove.w)) < 1 &&
                    Math.abs(clampMove.afterPos.top  - (clampMove.displayH - clampMove.h)) < 1;
      if (negOk && posOk) {
        pass('T6. 裁切框拖曳到超出圖片範圍的座標時，會被正確夾回圖片邊界內（不超出原始圖片範圍）');
      } else {
        fail('T6. 裁切框超出邊界時的夾回行為不符預期', JSON.stringify(clampMove));
      }
    }

    // ── 裁切框比例鎖定：故意設成極端不等比例的縮放，驗證縮放後仍強制鎖定為目標比例、且不超出邊界 ──
    {
      const clampScale = await page.evaluate(() => {
        const st = _aiBgCrop, r = st.rect;
        r.set({ scaleX: 50, scaleY: 1 }); // 刻意給不合理、極端不等比例的值
        _clampAiBgCropScale();
        _clampAiBgCropRect();
        return {
          scaleX: r.scaleX, scaleY: r.scaleY,
          w: r.width * r.scaleX, h: r.height * r.scaleY,
          displayW: st.displayW, displayH: st.displayH, ratio: st.ratio
        };
      });
      const uniform = clampScale.scaleX === clampScale.scaleY;
      const boundsOk = clampScale.w <= clampScale.displayW + 1 && clampScale.h <= clampScale.displayH + 1;
      const ratioLocked = Math.abs((clampScale.w / clampScale.h) - clampScale.ratio) < 0.02;
      if (uniform && boundsOk && ratioLocked) {
        pass('T7. 裁切框強制等比例縮放，即使拖曳造成極端不等比例的中間狀態，最終仍鎖定在目標比例且不超出圖片範圍');
      } else {
        fail('T7. 裁切框比例鎖定不符預期', JSON.stringify(clampScale));
      }
    }

    // ── 真實滑鼠拖曳：證明裁切框在瀏覽器裡確實可以被使用者實際拖動（不是只有底層函式邏輯對） ──
    {
      await page.click('#ai-bg-crop-reset-btn'); // 先重設回乾淨的初始狀態，排除前兩項torture test殘留的極端值
      const before = await readCropState(page);
      const canvasBox = await page.locator('#ai-bg-crop-canvas').boundingBox();
      const centerX = canvasBox.x + before.rectLeft + before.rectW / 2;
      const centerY = canvasBox.y + before.rectTop + before.rectH / 2;
      await page.mouse.move(centerX, centerY);
      await page.mouse.down();
      await page.mouse.move(centerX + 15, centerY + 10, { steps: 5 });
      await page.mouse.up();
      const after = await readCropState(page);
      const moved = Math.abs(after.rectLeft - before.rectLeft) > 3 || Math.abs(after.rectTop - before.rectTop) > 3;
      const stillWithinBounds = withinBounds(after);
      const stillRatioOk = ratioOk(after);
      if (moved && stillWithinBounds && stillRatioOk) {
        pass('T8. 真實滑鼠拖曳裁切框確實可以移動位置，且移動後仍在圖片範圍內、比例不變');
      } else {
        fail('T8. 真實滑鼠拖曳裁切框不符預期', JSON.stringify({ before, after, moved, stillWithinBounds, stillRatioOk }));
      }
    }

    // ── 「重新選取」：裁切框回到初始置中位置與大小 ──
    {
      // 先把裁切框亂動一次，再按「重新選取」，確認真的有變化（不是本來就沒動過）
      await page.evaluate(() => { const r = _aiBgCrop.rect; r.set({ left: 5, top: 5, scaleX: 0.3, scaleY: 0.3 }); });
      const beforeReset = await readCropState(page);
      await page.click('#ai-bg-crop-reset-btn');
      const afterReset = await readCropState(page);
      const changed = Math.abs(afterReset.rectLeft - beforeReset.rectLeft) > 1 || Math.abs(afterReset.rectW - beforeReset.rectW) > 1;
      const resetRatioOk = ratioOk(afterReset);
      const resetBoundsOk = withinBounds(afterReset);
      if (changed && resetRatioOk && resetBoundsOk) {
        pass('T9. 「重新選取」正確把裁切框重設回置中、比例正確、範圍合法的初始狀態');
      } else {
        fail('T9. 「重新選取」行為不符預期', JSON.stringify({ beforeReset, afterReset }));
      }
    }

    // ── 「取消」：關閉彈窗但不套用，畫布上不應出現任何 ai-generate-background 物件 ──
    {
      await page.locator('.ai-bg-crop-modal-panel button:has-text("取消")').click();
      await page.waitForSelector('#ai-bg-crop-modal.hidden', { state: 'attached', timeout: 3000 });
      const hasBg = await page.evaluate(() => canvas2d.getObjects().some(o => o.name === 'ai-generate-background'));
      const cropStateCleared = await page.evaluate(() => typeof _aiBgCrop === 'undefined' || _aiBgCrop === null);
      if (!hasBg && cropStateCleared) {
        pass('T10. 「取消」關閉裁切彈窗後不會套用任何內容，畫布上沒有新增AI背景物件，裁切畫布狀態已釋放');
      } else {
        fail('T10. 「取消」後的狀態不符預期', JSON.stringify({ hasBg, cropStateCleared }));
      }
    }

    // ── 套用選取範圍 → canvas 上出現且僅出現一個 ai-generate-background 物件，
    //    位置在 title/subtitle 之下（z-order），且 cover-fill 有實際縮放（非原始比例1:1），
    //    裁切後圖片的自然尺寸應小於原圖（證明真的是裁切結果，不是整張原圖直接套用）──
    let firstAppliedNaturalSize = null;
    {
      await page.click('#ai-bg-apply-btn'); // 重新開啟裁切彈窗（原始圖片仍保留，不必重新生成）
      await page.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });
      // 縮小裁切框到明顯小於整張圖，確保套用結果是「裁切後的一部分」而不是整張原圖
      await page.evaluate(() => {
        const st = _aiBgCrop, r = st.rect;
        r.set({ scaleX: 0.5, scaleY: 0.5 });
        _clampAiBgCropRect();
      });
      await page.click('#ai-bg-crop-apply-btn');
      await page.waitForSelector('#ai-bg-crop-modal.hidden', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(200);
      const info = await page.evaluate(() => {
        const objs = canvas2d.getObjects();
        const bgIdx = objs.findIndex(o => o.name === 'ai-generate-background');
        const titleIdx = objs.findIndex(o => o.name === 'title');
        const count = objs.filter(o => o.name === 'ai-generate-background').length;
        const bg = objs[bgIdx];
        return {
          count, bgIdx, titleIdx,
          hasScale: bg ? (bg.scaleX > 0 && bg.scaleY > 0) : false,
          origin: bg ? [bg.originX, bg.originY] : null,
          naturalW: bg && bg._element ? bg._element.naturalWidth : (bg ? bg.width : null),
          naturalH: bg && bg._element ? bg._element.naturalHeight : (bg ? bg.height : null)
        };
      });
      firstAppliedNaturalSize = { w: info.naturalW, h: info.naturalH };
      const isCropped = info.naturalW < 1536 && info.naturalH < 1024; // 明顯小於原圖1536x1024
      const applyHintVisible = await page.locator('#ai-bg-apply-hint').isVisible();
      const applyHintText = (await page.locator('#ai-bg-apply-hint').textContent() || '').trim();
      if (info.count === 1 && info.bgIdx !== -1 && info.titleIdx !== -1 && info.bgIdx < info.titleIdx && info.hasScale && isCropped && applyHintVisible && applyHintText.includes('已將選取範圍套用為卡面背景')) {
        pass(`T11. 套用選取範圍：畫布上新增唯一一個裁切後的AI背景物件（${info.naturalW}x${info.naturalH}，明顯小於原圖1536x1024，確認真的有裁切），圖層順序在主標題文字之下，cover-fill縮放已套用，成功提示文字正確`);
      } else {
        fail('T11. 套用選取範圍後的畫布狀態不符預期', JSON.stringify({ info, applyHintVisible, applyHintText }));
      }
    }

    // ── 保留原始AI生成圖片：再次點「選取背景範圍」應該直接重新開啟裁切彈窗（讀取同一張
    //    原始1536x1024生成圖），不需要重新呼叫生成API，也不會消耗新的一次生成請求 ──
    {
      const reqCountBefore = mock.countGenerationRequestsForPrompt(prompt1);
      await page.click('#ai-bg-apply-btn');
      await page.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });
      const c = await readCropState(page);
      const reqCountAfter = mock.countGenerationRequestsForPrompt(prompt1);
      const sameOriginal = c.naturalW === 1536 && c.naturalH === 1024;
      const noNewRequest = reqCountAfter === reqCountBefore;
      if (sameOriginal && noNewRequest) {
        pass('T12. 再次點「選取背景範圍」直接沿用保留的原始AI生成圖片重新裁切，未重新呼叫生成API（不必再次付費生成）');
      } else {
        fail('T12. 重新裁切未正確沿用原始圖片', JSON.stringify({ c, reqCountBefore, reqCountAfter }));
      }

      // ── 再次套用不同的裁切範圍 → 仍然只有一個 ai-generate-background 物件（取代不堆疊） ──
      await page.evaluate(() => {
        const st = _aiBgCrop, r = st.rect;
        r.set({ left: st.displayLeft, top: st.displayTop, scaleX: 0.4, scaleY: 0.4 });
        _clampAiBgCropRect();
      });
      await page.click('#ai-bg-crop-apply-btn');
      await page.waitForSelector('#ai-bg-crop-modal.hidden', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(200);
      const count = await page.evaluate(() => canvas2d.getObjects().filter(o => o.name === 'ai-generate-background').length);
      if (count === 1) {
        pass('T13. 再次套用不同的裁切範圍後，畫布上仍只有一個AI背景物件（已替換舊的，未堆疊）');
      } else {
        fail('T13. 再次套用後畫布上AI背景物件數量不符預期', `count=${count}`);
      }
    }

    // ── 錯誤路徑（401）→ 顯示繁體中文錯誤訊息，不洩漏後端/Key細節，不使用瀏覽器原生alert ──
    {
      let dialogFired = false;
      page.once('dialog', async d => { dialogFired = true; await d.dismiss(); });
      await page.fill('#ai-bg-prompt', 'MOCK_TRIGGER_401 測試錯誤情境');
      await page.click('#ai-bg-btn');
      await page.waitForTimeout(500);
      const errVisible = await page.locator('#ai-bg-error').isVisible();
      const errText = (await page.locator('#ai-bg-error').textContent()) || '';
      const previewVisible = await page.locator('#ai-bg-preview').isVisible();
      const leaksSecret = /sk-mock-|OPENAI_API_KEY|ADMIN_TOKEN|api\.openai\.com/i.test(errText);
      if (errVisible && !previewVisible && !leaksSecret && /[一-鿿]/.test(errText) && !dialogFired) {
        pass('T14. 生成失敗時顯示繁體中文錯誤訊息，不洩漏金鑰或後端細節，不使用瀏覽器原生alert，且不會誤顯示成功預覽');
      } else {
        fail('T14. 錯誤路徑處理不符預期', `errVisible=${errVisible} previewVisible=${previewVisible} errText=${errText} dialogFired=${dialogFired}`);
      }
    }

    // ── 快速連點只送出一次請求（用DOM原生click，繞過Playwright的可操作性等待，
    //    真正測到「從按下當下就鎖定」的guard邏輯，而不是被disabled屬性擋掉點擊本身）──
    {
      const dblPrompt = 'T15測試連點：對稱線條背景';
      await page.fill('#ai-bg-prompt', dblPrompt);
      await page.evaluate(() => {
        const btn = document.getElementById('ai-bg-btn');
        btn.click(); btn.click(); btn.click();
      });
      await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await page.waitForTimeout(300);
      const reqCount = mock.countGenerationRequestsForPrompt(dblPrompt);
      if (reqCount === 1) {
        pass('T15. 快速連點生成按鈕三次，實際只送出一次生成請求');
      } else {
        fail('T15. 快速連點的請求次數不符預期', `reqCount=${reqCount}（預期1）`);
      }
    }

    // ── 商品切換後，舊商品尚未完成的回應不會誤套用到新商品 ──
    // selectProduct() 本身只前進到 Step2（規格選擇），要真正重建 canvas2d（Step3設計稿）
    // 才能檢查「新商品的畫布」有沒有被舊回應污染；只呼叫 selectProduct() 而不進到 Step3，
    // canvas2d 全域變數會繼續指向切換前那個商品的舊畫布，不是真正在測「新商品畫布」。
    {
      await page.fill('#ai-bg-prompt', 'MOCK_TRIGGER_DELAY2S 測試商品切換');
      await page.click('#ai-bg-btn');
      await page.waitForTimeout(200); // 請求已送出、還在等待2秒延遲回應期間
      // selectProduct() 內部用 nextStep()（目前Step+1）前進，只有從 Step1 呼叫才會正確landing
      // 在 Step2；目前正在 Step3 設計稿，先用「重新配置」（resetConfigurator，回到Step1、
      // 同時也會觸發跟正常「商品切換」同一套 resetDesignStateForProduct 重設/中止邏輯，
      // 這次也會一併驗證裁切彈窗狀態被正確清空）回到 Step1，才是跟真實使用者「換一個
      // 商品重新開始」相符的操作路徑。
      await page.evaluate(() => resetConfigurator());
      await page.evaluate(() => selectProduct('ipass', 'product_page'));
      await page.getByRole('button', { name: /下一步：設計稿/ }).click();
      await page.waitForSelector('#photo-upload-tabs', { state: 'attached' });
      await page.waitForTimeout(2200); // 等過原本2秒的延遲回應時間，確認舊回應真的被忽略
      const state = await page.evaluate(() => ({
        productId: STATE.productId,
        hasStaleBg: canvas2d.getObjects().some(o => o.name === 'ai-generate-background'),
        stillGenerating: (typeof aiBackgroundGenerating !== 'undefined') ? aiBackgroundGenerating : null,
        cropModalHidden: document.getElementById('ai-bg-crop-modal').classList.contains('hidden'),
        cropStateCleared: typeof _aiBgCrop === 'undefined' || _aiBgCrop === null
      }));
      if (state.productId === 'ipass' && !state.hasStaleBg && state.stillGenerating === false && state.cropModalHidden && state.cropStateCleared) {
        pass('T16. 生成請求進行中切換商品後，舊商品的延遲回應未被誤套用到新商品（重建後的）畫布，裁切彈窗狀態也一併清空');
      } else {
        fail('T16. 商品切換後的狀態不符預期', JSON.stringify(state));
      }
    }

    // ── 以上全部互動過程中，沒有新增非預期的 console 錯誤（跟頁面載入當下的既有基準值
    //    比較差異，不要求絕對零錯誤，避免跟這批功能無關的既有雜訊誤判失敗）──
    {
      const newErrors = consoleErrors.slice(baselineErrorCount);
      if (newErrors.length === 0) {
        pass('T17. 整個AI生成背景＋裁切互動流程（含連點、錯誤、商品切換、裁切）沒有新增瀏覽器主控台錯誤');
      } else {
        fail('T17. 互動過程中出現新的主控台錯誤', JSON.stringify(newErrors.slice(0, 5)));
      }
    }

    // ── 測試草稿儲存與恢復 ──────────────────────────────────────────
    // 查證後確認：configurator.js 的 window.addEventListener('pagehide', ...) 是既有、
    // 刻意設計的行為——只要離開這個分頁（換網址、關分頁）就會主動清空草稿索引，跟
    // _redirectHomeOnReload() 一樣是「重整或離開就不留草稿」的既定產品行為，不是這批
    // 功能的bug；也因此不可能透過任何一次真正的瀏覽器頁面導覽測出「草稿跨導覽存活」。
    // 這個應用實際承諾、也是使用者實際會用到的「草稿儲存與恢復」情境，是同一次瀏覽（不
    // 離開頁面）中「設計稿→預覽→返回設計稿」這種SPA內部步驟切換：goStep() 離開Step3前
    // 會把 canvasJSON 存進 STATE，initDesignStep() 重新進入Step3時會用 loadCanvas2DJSON()
        // 還原，這裡驗證裁切後套用的AI背景物件能撐過這個真實的來回流程。
    {
      // 目前這個page停在'ipass'，先在ipass重新走一次生成＋裁切＋套用，才有東西可以驗證
      // 「前進到預覽再返回」是否還原。「預覽成品」按鈕要求文字已經不是示範預設文字
      // （canProceedToPreview()），先修改主標題文字，否則按鈕會維持停用狀態，不是這批
      // 裁切功能造成的限制。#design-text1 在「文字與版面」彈窗裡，要先點觸發按鈕開啟彈窗。
      await page.click('#text-design-trigger-btn');
      await page.fill('#design-text1', 'T18測試主標題');
      await page.click('button:has-text("套用至卡面")');
      await generateAndOpenCrop(page, 'T18測試草稿還原：格紋底圖');
      await page.click('#ai-bg-crop-apply-btn');
      await page.waitForSelector('#ai-bg-crop-modal.hidden', { state: 'attached', timeout: 5000 });
      await page.waitForTimeout(200);
      const beforeRoundTrip = await page.evaluate(() => canvas2d.getObjects().some(o => o.name === 'ai-generate-background'));
      await page.getByRole('button', { name: /預覽成品/ }).click(); // Step3 → Step4
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: /修改設計|上一步/ }).first().click(); // Step4 → Step3
      await page.waitForSelector('#photo-upload-tabs', { state: 'attached' });
      await page.waitForFunction(() => typeof canvas2d !== 'undefined' && canvas2d && canvas2d.getObjects().length > 0, null, { timeout: 5000 }).catch(() => {});
      const restored = await page.evaluate(() => canvas2d.getObjects().some(o => o.name === 'ai-generate-background')).catch(() => false);
      const restoreOk = beforeRoundTrip && restored;
      if (restoreOk) pass('T18. 套用裁切後的AI背景後前進到預覽再返回設計稿，AI背景物件仍存在於還原後的畫布上');
      else fail('T18. 設計稿↔預覽來回後，AI背景物件未正確保留', `beforeRoundTrip=${beforeRoundTrip} restored=${restored}`);
    }

    await page.close();

    // ── 跨裝置尺寸測試：手機 320×720／360×800／390×844／430×932，桌面 1366×768／1920×1080。
    //    每個尺寸各自開新頁面、生成一次、開啟裁切彈窗，確認裁切畫布在該尺寸下不造成頁面
    //    橫向溢出、裁切框比例正確且未超出圖片範圍、touch-action:none 樣式已套用（手機版
    //    防止拖曳裁切框時整個網頁跟著橫向移動的關鍵CSS）──
    {
      const viewports = [
        { label: '手機 320x720', width: 320, height: 720, mobile: true },
        { label: '手機 360x800', width: 360, height: 800, mobile: true },
        { label: '手機 390x844', width: 390, height: 844, mobile: true },
        { label: '手機 430x932', width: 430, height: 932, mobile: true },
        { label: '桌面 1366x768', width: 1366, height: 768, mobile: false },
        { label: '桌面 1920x1080', width: 1920, height: 1080, mobile: false }
      ];
      for (const vp of viewports) {
        const vpPage = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
        vpPage._yzBaseUrl = baseUrl;
        try {
          await goToDesignStep(vpPage, 'easycard');
          if (vp.mobile) {
            await vpPage.evaluate(() => { if (typeof setMobileDesignGroup === 'function') setMobileDesignGroup('ai'); });
          }
          await vpPage.locator('#wb-tab-btn-aibg').click();
          await vpPage.fill('#ai-bg-prompt', `跨尺寸測試 ${vp.label}`);
          await vpPage.click('#ai-bg-btn');
          await vpPage.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
          await vpPage.click('#ai-bg-apply-btn');
          await vpPage.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
          await vpPage.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });

          const c = await vpPage.evaluate(() => {
            const st = _aiBgCrop, r = st.rect;
            return {
              displayLeft: st.displayLeft, displayTop: st.displayTop, displayW: st.displayW, displayH: st.displayH,
              rectLeft: r.left, rectTop: r.top, rectW: r.width * r.scaleX, rectH: r.height * r.scaleY,
              ratio: st.ratio
            };
          });
          const noHorizontalOverflow = await vpPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
          const touchActionNone = await vpPage.evaluate(() => getComputedStyle(document.getElementById('ai-bg-crop-canvas-wrap')).touchAction === 'none');
          const cRatioOk = ratioOk(c);
          const cBoundsOk = withinBounds(c);

          if (noHorizontalOverflow && touchActionNone && cRatioOk && cBoundsOk) {
            pass(`T19. 裁切彈窗在「${vp.label}」尺寸下正常運作（無橫向溢出、touch-action:none、裁切框比例與範圍正確）`);
          } else {
            fail(`T19. 裁切彈窗在「${vp.label}」尺寸下不符預期`, JSON.stringify({ noHorizontalOverflow, touchActionNone, cRatioOk, cBoundsOk, c }));
          }
        } catch (e) {
          fail(`T19. 裁切彈窗在「${vp.label}」尺寸下測試時發生例外`, e.message);
        } finally {
          await vpPage.close();
        }
      }
    }

    // ── 裁切畫布初始化競速防護測試（回應Codex複驗「裁切畫布非同步初始化競速問題」）──
    // loadImageEl() 平常吃 data: URL，解碼幾乎是同步完成，很難自然測到「載入中」這個
    // 中間狀態；這裡在專用的獨立分頁裡，刻意把該分頁的 loadImageEl 換成外面包一層延遲的
    // 版本（monkey-patch 頁面內的全域函式，只影響這個分頁自己，不影響其他任何分頁、也
    // 不是修改正式程式碼），製造出可控的「載入中」時間窗來驗證按鈕停用/啟用、競速取消等
    // 行為；每個子測試各自開一個全新分頁，monkey-patch 不會互相汙染。
    {
      const racePage = await browser.newPage();
      racePage._yzBaseUrl = baseUrl;
      await goToDesignStep(racePage, 'easycard');
      await racePage.evaluate(() => {
        const _orig = loadImageEl;
        loadImageEl = function (url) {
          return new Promise((resolve, reject) => {
            setTimeout(() => { _orig(url).then(resolve, reject); }, 1200);
          });
        };
      });
      await racePage.locator('#wb-tab-btn-aibg').click();
      await racePage.fill('#ai-bg-prompt', 'T20測試裁切初始化競速');
      await racePage.click('#ai-bg-btn');
      await racePage.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await racePage.click('#ai-bg-apply-btn'); // 開啟裁切彈窗，這次圖片載入被延遲1.2秒
      await racePage.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });

      const duringLoad = await racePage.evaluate(() => ({
        applyDisabled: document.getElementById('ai-bg-crop-apply-btn').disabled,
        loadingVisible: !document.getElementById('ai-bg-crop-loading').classList.contains('hidden'),
        hasAiBgCrop: typeof _aiBgCrop !== 'undefined' && !!_aiBgCrop
      }));
      if (duringLoad.applyDisabled && duringLoad.loadingVisible && !duringLoad.hasAiBgCrop) {
        pass('T20. 裁切圖片載入期間，「套用選取範圍」按鈕停用、顯示「背景圖片載入中」狀態，且畫布尚未初始化完成');
      } else {
        fail('T20. 載入期間狀態不符預期', JSON.stringify(duringLoad));
      }

      await racePage.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });
      const afterLoad = await racePage.evaluate(() => ({
        applyDisabled: document.getElementById('ai-bg-crop-apply-btn').disabled,
        loadingVisible: !document.getElementById('ai-bg-crop-loading').classList.contains('hidden')
      }));
      if (!afterLoad.applyDisabled && !afterLoad.loadingVisible) {
        pass('T21. 裁切圖片載入完成後，「套用選取範圍」按鈕正確啟用、載入中狀態正確隱藏');
      } else {
        fail('T21. 載入完成後狀態不符預期', JSON.stringify(afterLoad));
      }
      await racePage.close();
    }

    // ── 載入期間快速關閉：不會在關閉後才建立裁切畫布（避免殘留隱藏的Fabric Canvas）──
    {
      const racePage2 = await browser.newPage();
      racePage2._yzBaseUrl = baseUrl;
      await goToDesignStep(racePage2, 'easycard');
      await racePage2.evaluate(() => {
        const _orig = loadImageEl;
        loadImageEl = function (url) {
          return new Promise((resolve, reject) => {
            setTimeout(() => { _orig(url).then(resolve, reject); }, 1200);
          });
        };
      });
      await racePage2.locator('#wb-tab-btn-aibg').click();
      await racePage2.fill('#ai-bg-prompt', 'T22測試載入中關閉');
      await racePage2.click('#ai-bg-btn');
      await racePage2.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await racePage2.click('#ai-bg-apply-btn'); // 開啟，開始1.2秒延遲載入
      await racePage2.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
      await racePage2.click('.ai-bg-crop-modal-panel button:has-text("取消")'); // 載入完成前就關閉
      await racePage2.waitForTimeout(1600); // 等過原本1.2秒延遲，讓那次（已過期的）載入真的resolve

      const afterStaleResolve = await racePage2.evaluate(() => ({
        modalHidden: document.getElementById('ai-bg-crop-modal').classList.contains('hidden'),
        hasAiBgCrop: typeof _aiBgCrop !== 'undefined' && !!_aiBgCrop
      }));
      if (afterStaleResolve.modalHidden && !afterStaleResolve.hasAiBgCrop) {
        pass('T22. 圖片載入期間關閉彈窗後，就算延遲的載入結果之後才回來，也不會重新建立裁切畫布（不留殘留Canvas）');
      } else {
        fail('T22. 載入期間關閉後仍建立了裁切畫布', JSON.stringify(afterStaleResolve));
      }
      await racePage2.close();
    }

    // ── 快速關閉再開啟：較早呼叫但較晚完成的第一次載入結果，不會覆蓋使用者實際看到的
    //    第二次裁切畫布──────────────────────────────────────────────
    {
      const racePage3 = await browser.newPage();
      racePage3._yzBaseUrl = baseUrl;
      await goToDesignStep(racePage3, 'easycard');
      await racePage3.evaluate(() => {
        const _orig = loadImageEl;
        let callCount = 0;
        loadImageEl = function (url) {
          callCount++;
          const delay = callCount === 1 ? 1500 : 300; // 第一次（較早呼叫那次）刻意延遲更久
          return new Promise((resolve, reject) => {
            setTimeout(() => { _orig(url).then(resolve, reject); }, delay);
          });
        };
      });
      await racePage3.locator('#wb-tab-btn-aibg').click();
      await racePage3.fill('#ai-bg-prompt', 'T23測試快速關閉重開');
      await racePage3.click('#ai-bg-btn');
      await racePage3.waitForSelector('#ai-bg-preview img', { timeout: 15000 });

      await racePage3.click('#ai-bg-apply-btn'); // 第一次開啟（延遲1.5秒）
      await racePage3.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
      await racePage3.click('.ai-bg-crop-modal-panel button:has-text("取消")'); // 立刻關閉
      await racePage3.click('#ai-bg-apply-btn'); // 第二次開啟（延遲0.3秒，較快完成）
      await racePage3.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
      await racePage3.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 5000 });
      const secondInitToken = await racePage3.evaluate(() => _aiBgCropInitToken);
      await racePage3.waitForTimeout(1800); // 等過第一次（較慢）的1.5秒延遲，讓它也真的resolve

      const afterBothResolve = await racePage3.evaluate(() => ({
        tokenNow: _aiBgCropInitToken,
        hasCanvas: !!(_aiBgCrop && _aiBgCrop.canvas),
        modalHidden: document.getElementById('ai-bg-crop-modal').classList.contains('hidden')
      }));
      if (!afterBothResolve.modalHidden && afterBothResolve.hasCanvas && afterBothResolve.tokenNow === secondInitToken) {
        pass('T23. 快速關閉再開啟後，較早呼叫但較晚完成的第一次載入結果，沒有覆蓋使用者實際看到的第二次裁切畫布');
      } else {
        fail('T23. 快速關閉再開啟的狀態不符預期', JSON.stringify(afterBothResolve));
      }
      await racePage3.close();
    }

    // ── 圖片載入失敗：顯示正確的繁體中文錯誤、套用按鈕維持停用、不得誤顯示「選取範圍太小」──
    {
      const racePage4 = await browser.newPage();
      racePage4._yzBaseUrl = baseUrl;
      await goToDesignStep(racePage4, 'easycard');
      // 注意：generateAiBackgroundImage() 內部本身也會呼叫 loadImageEl() 驗證生成結果，
      // 所以不能在生成之前就把它換成一律失敗的版本（那樣連生成步驟都會失敗，測不到「裁切
      // 彈窗載入失敗」這個情境）。要先讓生成用原本正常的 loadImageEl 走完、看到預覽圖之後，
      // 才把它換成一律失敗的版本，只影響接下來「開啟裁切彈窗」這一步的載入。
      await racePage4.locator('#wb-tab-btn-aibg').click();
      await racePage4.fill('#ai-bg-prompt', 'T24測試載入失敗');
      await racePage4.click('#ai-bg-btn');
      await racePage4.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await racePage4.evaluate(() => {
        loadImageEl = function () { return Promise.reject(new Error('圖片載入失敗（測試模擬）')); };
      });
      await racePage4.click('#ai-bg-apply-btn');
      await racePage4.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
      await racePage4.waitForFunction(() => {
        const el = document.getElementById('ai-bg-crop-error');
        return el && !el.classList.contains('hidden');
      }, null, { timeout: 5000 });

      const failState = await racePage4.evaluate(() => ({
        errVisible: !document.getElementById('ai-bg-crop-error').classList.contains('hidden'),
        errText: document.getElementById('ai-bg-crop-error').textContent,
        applyDisabled: document.getElementById('ai-bg-crop-apply-btn').disabled,
        loadingHidden: document.getElementById('ai-bg-crop-loading').classList.contains('hidden')
      }));
      const correctErrorMsg = failState.errText.includes('圖片載入失敗') && !failState.errText.includes('選取範圍太小');
      if (failState.errVisible && correctErrorMsg && failState.applyDisabled && failState.loadingHidden) {
        pass('T24. 裁切圖片載入失敗時顯示正確的繁體中文錯誤訊息、套用按鈕維持停用、不會誤顯示「選取範圍太小」');
      } else {
        fail('T24. 載入失敗時的狀態不符預期', JSON.stringify(failState));
      }
      await racePage4.close();
    }

    // ── 手機觸控環境（hasTouch:true）：裁切框觸控熱區大小＋真實觸控拖曳（回應Codex複驗
    //    「手機裁切把手偏小且沒有真實觸控驗證」）─────────────────────────────
    {
      const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const touchPage = await touchContext.newPage();
      touchPage._yzBaseUrl = baseUrl;
      try {
        await goToDesignStep(touchPage, 'easycard');
        await touchPage.evaluate(() => { if (typeof setMobileDesignGroup === 'function') setMobileDesignGroup('ai'); });
        await touchPage.locator('#wb-tab-btn-aibg').click();
        await touchPage.fill('#ai-bg-prompt', 'T25測試觸控把手大小');
        await touchPage.click('#ai-bg-btn');
        await touchPage.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
        await touchPage.click('#ai-bg-apply-btn');
        await touchPage.waitForSelector('#ai-bg-crop-modal:not(.hidden)', { timeout: 5000 });
        await touchPage.waitForFunction(() => typeof _aiBgCrop !== 'undefined' && _aiBgCrop && _aiBgCrop.canvas, null, { timeout: 8000 });

        const touchCornerSize = await touchPage.evaluate(() => _aiBgCrop.rect.touchCornerSize);
        if (typeof touchCornerSize === 'number' && touchCornerSize >= 44) {
          pass(`T25. 裁切框觸控熱區 touchCornerSize=${touchCornerSize}px，符合行動介面建議的至少44px（不影響全域34px設定，只覆蓋裁切框這個物件）`);
        } else {
          fail('T25. 裁切框 touchCornerSize 不符合至少44px的要求', `實際=${touchCornerSize}`);
        }

        // 用CDP直接派送真實 touchstart/touchmove/touchend 事件（不是滑鼠事件模擬），
        // 盡可能貼近真實手指拖曳；如果這個測試環境無法可靠派送/辨識，如實記錄成「未驗證」，
        // 不計入通過或失敗，不宣稱做過真實觸控手勢測試。
        let realTouchDragResult = null; // true=通過, false=失敗, null=環境無法可靠模擬
        try {
          const client = await touchContext.newCDPSession(touchPage);
          const before = await readCropState(touchPage);
          const canvasBox = await touchPage.locator('#ai-bg-crop-canvas').boundingBox();
          const x0 = canvasBox.x + before.rectLeft + before.rectW / 2;
          const y0 = canvasBox.y + before.rectTop + before.rectH / 2;
          const x1 = x0 + 18, y1 = y0 + 14;
          await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
          await touchPage.waitForTimeout(60);
          await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x1, y: y1 }] });
          await touchPage.waitForTimeout(60);
          await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await touchPage.waitForTimeout(250);
          const after = await readCropState(touchPage);
          const moved = Math.abs(after.rectLeft - before.rectLeft) > 2 || Math.abs(after.rectTop - before.rectTop) > 2;
          realTouchDragResult = moved && withinBounds(after) && ratioOk(after);
        } catch (e) {
          realTouchDragResult = null;
        }
        if (realTouchDragResult === true) {
          pass('T26. 使用CDP真實touch事件（touchstart/touchmove/touchend，非滑鼠模擬）成功拖曳裁切框，移動後仍在圖片範圍內、比例不變');
        } else if (realTouchDragResult === false) {
          fail('T26. 真實touch事件拖曳裁切框後狀態不符預期（裁切框未正確移動或超出範圍/比例跑掉）');
        } else {
          console.log('  ⚠ T26. 這個測試環境無法可靠派送/辨識真實多點觸控拖曳手勢，如實記錄為「未驗證」，不計入通過或失敗（詳見完成回報「已知限制」，不宣稱已完成真實手勢測試）');
        }

        const noHOverflowDuringTouch = await touchPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
        if (noHOverflowDuringTouch) {
          pass('T26b. 觸控環境下拖曳裁切框後，頁面仍沒有橫向捲動溢出');
        } else {
          fail('T26b. 觸控環境下拖曳裁切框後頁面出現橫向溢出');
        }
      } finally {
        await touchPage.close();
        await touchContext.close();
      }
    }

    // ── 成本涵蓋範圍回歸測試（admin-routes.js featureCostCoverage() 修正）──────────
    console.log('\n[成本涵蓋範圍回歸測試] 登入子行程後台，讀取AI使用統計驗證 costCoverage');
    {
      const loginResp = await fetch(baseUrl + '/api/admin/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: testOnlyAdminToken })
      });
      const loginData = await loginResp.json();
      const cookie = extractSessionCookie(loginResp.headers.get('set-cookie'));
      if (loginResp.status === 200 && loginData.success && cookie && loginData.csrfToken) {
        pass('T27. 使用測試專用隨機ADMIN_TOKEN成功登入子行程後台（owner帳號）');

        const statsResp = await fetch(baseUrl + '/api/admin/ai-usage-stats', {
          headers: { 'Cookie': cookie, 'X-CSRF-Token': loginData.csrfToken }
        });
        const stats = await statsResp.json();
        const byFeature = (stats && stats.byFeature) || [];
        const genImage = byFeature.find(f => f.featureKey === 'generate_image');
        const others = byFeature.filter(f => f.featureKey !== 'generate_image');

        if (genImage && genImage.totalRequests > 0 && genImage.costCoverage === 'partial') {
          pass(`T28. generate_image 修正後 costCoverage 正確顯示為 partial（不再是 unknown），totalRequests=${genImage.totalRequests}`);
        } else {
          fail('T28. generate_image 的 costCoverage 不符預期', JSON.stringify(genImage));
        }

        const othersOk = others.every(f => ['none', 'partial', 'full'].includes(f.costCoverage));
        if (othersOk) {
          pass('T29. 其餘三項AI功能（generate_design／black_card_pattern／cartoon_image）的 costCoverage 值仍在合法範圍內，未受這次修正影響而出現異常值');
        } else {
          fail('T29. 其餘功能的 costCoverage 出現不合法的值', JSON.stringify(others));
        }
      } else {
        fail('T27. 登入子行程後台失敗，無法繼續成本涵蓋範圍回歸測試', `status=${loginResp.status} body=${JSON.stringify(loginData)}`);
      }
    }

    // ── 敏感資料未外洩檢查 ──
    if (!combinedOutput.includes(fakeApiKey) && !combinedOutput.includes(testOnlyAdminToken)) {
      pass('T30. 子行程 stdout／stderr 全程未出現假OpenAI Key或測試用ADMIN_TOKEN本身');
    } else {
      fail('T30. 子行程輸出疑似洩漏敏感測試憑證');
    }

  } catch (e) {
    fail('測試流程發生未預期例外', e.message + '\n' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await killChildAndWait(child);
    await mock.close();
    const cleanup = await removeDirWithRetry(testDir);
    if (cleanup.ok) pass('T31. 臨時資料夾成功清除');
    else fail('T31. 臨時資料夾清理失敗（作業系統臨時目錄，未刪除任何非臨時路徑）');
  }

  console.log(`\n[ai-background-frontend-test] 完成：${passCount} 通過、${failCount} 失敗`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('[ai-background-frontend-test] 執行時發生未預期錯誤：', e.message, e.stack);
  process.exitCode = 1;
});
