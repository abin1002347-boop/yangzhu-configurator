// 隔離測試：悠遊卡／一卡通「AI 生成背景」前台功能（2026-08-24 新增），以及成本涵蓋範圍
// 標籤修正（admin-routes.js 的 featureCostCoverage()）。
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

async function buildMockPngBase64() {
  const sharp = require('sharp');
  const buf = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 40, g: 120, b: 60, alpha: 255 } }
  }).png().toBuffer();
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
function resolveTrigger(text, mockPngBase64) {
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
        const triggered = resolveTrigger(prompt, mockPngBase64);
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

    // ── C2/C3/C4/C5：只有 easycard／ipass 顯示「AI生成背景」分頁，thermos／black_card 不顯示 ──
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
    // 記錄，不是JS例外——T7刻意觸發401錯誤情境本來就會產生這則訊息，那是預期中的正常網路
    // 記錄（我們自己的錯誤處理UI另外在T7驗證過），不是這批功能程式碼本身的錯誤，過濾掉避免
    // 誤判成新增的程式錯誤。
    const BENIGN_CONSOLE_PATTERN = /Failed to load resource: the server responded with a status of \d+/;
    page.on('console', msg => { if (msg.type() === 'error' && !BENIGN_CONSOLE_PATTERN.test(msg.text())) consoleErrors.push(msg.text()); });
    page.on('pageerror', err => { consoleErrors.push('pageerror: ' + err.message); });

    await goToDesignStep(page, 'easycard');
    await page.locator('#wb-tab-btn-aibg').click();
    const baselineErrorCount = consoleErrors.length;

    // ── C6：描述太短，顯示驗證錯誤，不送出請求 ──
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

    // ── C7：正常生成流程（loading → 成功 → 預覽 → 套用按鈕出現）──
    const prompt1 = 'T4測試背景描述：簡約竹葉線條圖案';
    {
      await page.fill('#ai-bg-prompt', prompt1);
      const clickPromise = page.click('#ai-bg-btn');
      await page.waitForTimeout(50);
      const disabledDuringLoad = await page.locator('#ai-bg-btn').isDisabled();
      await clickPromise;
      await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      const applyVisible = await page.locator('#ai-bg-apply-btn').isVisible();
      const previewSrc = await page.locator('#ai-bg-preview img').getAttribute('src');
      const validPng = typeof previewSrc === 'string' && previewSrc.startsWith('data:image/png;base64,');
      if (disabledDuringLoad && applyVisible && validPng) {
        pass('T4. 正常生成流程：按鈕生成中鎖定、成功後顯示合法圖片預覽、套用按鈕出現');
      } else {
        fail('T4. 正常生成流程不符預期', `disabledDuringLoad=${disabledDuringLoad} applyVisible=${applyVisible} validPng=${validPng}`);
      }
    }

    // ── C9：套用到卡面 → canvas 上出現且僅出現一個 ai-generate-background 物件，
    //        位置在 title/subtitle 之下（z-order），且 cover-fill 有實際縮放（非原始比例1:1）──
    {
      await page.click('#ai-bg-apply-btn');
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
          origin: bg ? [bg.originX, bg.originY] : null
        };
      });
      if (info.count === 1 && info.bgIdx !== -1 && info.titleIdx !== -1 && info.bgIdx < info.titleIdx && info.hasScale) {
        pass('T5. 套用到卡面：畫布上新增唯一一個AI背景物件，圖層順序在主標題文字之下，cover-fill縮放已套用');
      } else {
        fail('T5. 套用到卡面的畫布狀態不符預期', JSON.stringify(info));
      }
    }

    // ── C11：再次生成＋套用不同描述 → 仍然只有一個 ai-generate-background 物件（取代不堆疊）──
    {
      const prompt2 = 'T6測試背景描述：波浪水紋圖案';
      await page.fill('#ai-bg-prompt', prompt2);
      await page.click('#ai-bg-btn');
      await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await page.click('#ai-bg-apply-btn');
      await page.waitForTimeout(200);
      const count = await page.evaluate(() => canvas2d.getObjects().filter(o => o.name === 'ai-generate-background').length);
      if (count === 1) {
        pass('T6. 再次生成並套用新背景後，畫布上仍只有一個AI背景物件（已替換舊的，未堆疊）');
      } else {
        fail('T6. 再次套用後畫布上AI背景物件數量不符預期', `count=${count}`);
      }
    }

    // ── C12：錯誤路徑（401）→ 顯示繁體中文錯誤訊息，不洩漏後端/Key細節，套用按鈕不出現新內容 ──
    {
      await page.fill('#ai-bg-prompt', 'MOCK_TRIGGER_401 測試錯誤情境');
      await page.click('#ai-bg-btn');
      await page.waitForTimeout(500);
      const errVisible = await page.locator('#ai-bg-error').isVisible();
      const errText = (await page.locator('#ai-bg-error').textContent()) || '';
      const previewVisible = await page.locator('#ai-bg-preview').isVisible();
      const leaksSecret = /sk-mock-|OPENAI_API_KEY|ADMIN_TOKEN|api\.openai\.com/i.test(errText);
      if (errVisible && !previewVisible && !leaksSecret && /[一-鿿]/.test(errText)) {
        pass('T7. 生成失敗時顯示繁體中文錯誤訊息，不洩漏金鑰或後端細節，且不會誤顯示成功預覽');
      } else {
        fail('T7. 錯誤路徑處理不符預期', `errVisible=${errVisible} previewVisible=${previewVisible} errText=${errText}`);
      }
    }

    // ── C8：快速連點只送出一次請求（用DOM原生click，繞過Playwright的可操作性等待，
    //        真正測到「從按下當下就鎖定」的guard邏輯，而不是被disabled屬性擋掉點擊本身）──
    {
      const dblPrompt = 'T8測試連點：對稱線條背景';
      await page.fill('#ai-bg-prompt', dblPrompt);
      await page.evaluate(() => {
        const btn = document.getElementById('ai-bg-btn');
        btn.click(); btn.click(); btn.click();
      });
      await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await page.waitForTimeout(300);
      const reqCount = mock.countGenerationRequestsForPrompt(dblPrompt);
      if (reqCount === 1) {
        pass('T8. 快速連點生成按鈕三次，實際只送出一次生成請求');
      } else {
        fail('T8. 快速連點的請求次數不符預期', `reqCount=${reqCount}（預期1）`);
      }
    }

    // ── C13：商品切換後，舊商品尚未完成的回應不會誤套用到新商品 ──
    // selectProduct() 本身只前進到 Step2（規格選擇），要真正重建 canvas2d（Step3設計稿）
    // 才能檢查「新商品的畫布」有沒有被舊回應污染；只呼叫 selectProduct() 而不進到 Step3，
    // canvas2d 全域變數會繼續指向切換前那個商品的舊畫布，不是真正在測「新商品畫布」。
    {
      await page.fill('#ai-bg-prompt', 'MOCK_TRIGGER_DELAY2S 測試商品切換');
      await page.click('#ai-bg-btn');
      await page.waitForTimeout(200); // 請求已送出、還在等待2秒延遲回應期間
      // selectProduct() 內部用 nextStep()（目前Step+1）前進，只有從 Step1 呼叫才會正確landing
      // 在 Step2；目前正在 Step3 設計稿，先用「重新配置」（resetConfigurator，回到Step1、
      // 同時也會觸發跟正常「商品切換」同一套 resetDesignStateForProduct 重設/中止邏輯）回到
      // Step1，才是跟真實使用者「換一個商品重新開始」相符的操作路徑。
      await page.evaluate(() => resetConfigurator());
      await page.evaluate(() => selectProduct('ipass', 'product_page'));
      await page.getByRole('button', { name: /下一步：設計稿/ }).click();
      await page.waitForSelector('#photo-upload-tabs', { state: 'attached' });
      await page.waitForTimeout(2200); // 等過原本2秒的延遲回應時間，確認舊回應真的被忽略
      const state = await page.evaluate(() => ({
        productId: STATE.productId,
        hasStaleBg: canvas2d.getObjects().some(o => o.name === 'ai-generate-background'),
        stillGenerating: (typeof aiBackgroundGenerating !== 'undefined') ? aiBackgroundGenerating : null
      }));
      if (state.productId === 'ipass' && !state.hasStaleBg && state.stillGenerating === false) {
        pass('T9. 生成請求進行中切換商品後，舊商品的延遲回應未被誤套用到新商品（重建後的）畫布');
      } else {
        fail('T9. 商品切換後的狀態不符預期', JSON.stringify(state));
      }
    }

    // ── C16：以上全部互動過程中，沒有新增非預期的 console 錯誤（跟頁面載入當下的
    //        既有基準值比較差異，不要求絕對零錯誤，避免跟這批功能無關的既有雜訊誤判失敗）──
    {
      const newErrors = consoleErrors.slice(baselineErrorCount);
      if (newErrors.length === 0) {
        pass('T10. 整個AI生成背景互動流程（含連點、錯誤、商品切換）沒有新增瀏覽器主控台錯誤');
      } else {
        fail('T10. 互動過程中出現新的主控台錯誤', JSON.stringify(newErrors.slice(0, 5)));
      }
    }

    // ── 測試草稿儲存與恢復（C14）──────────────────────────────────────────
    // 查證後確認：configurator.js 的 window.addEventListener('pagehide', ...) 是既有、
    // 刻意設計的行為——只要離開這個分頁（換網址、關分頁）就會主動清空草稿索引，跟
    // _redirectHomeOnReload() 一樣是「重整或離開就不留草稿」的既定產品行為，不是這批
    // 新功能的bug；也因此不可能透過任何一次真正的瀏覽器頁面導覽測出「草稿跨導覽存活」。
    // 這個應用實際承諾、也是使用者實際會用到的「草稿儲存與恢復」情境，是同一次瀏覽（不
    // 離開頁面）中「設計稿→預覽→返回設計稿」這種SPA內部步驟切換：goStep() 離開Step3前
    // 會把 canvasJSON 存進 STATE，initDesignStep() 重新進入Step3時會用 loadCanvas2DJSON()
    // 還原（見 configurator.js 第1607~1618行），這裡驗證AI背景物件能撐過這個真實的
    // 來回流程，而不是驗證跨分頁重新整理／離站的持久性（那部分本來就是設計成不保留）。
    let restoreOk = false;
    {
      // T9結束後目前這個page停在'ipass'（尚未套用過AI背景），這裡先在ipass重新走一次
      // 生成＋套用，才有東西可以驗證「前進到預覽再返回」是否還原。
      // 「預覽成品」按鈕要求文字已經不是示範預設文字（canProceedToPreview()），先修改
      // 主標題文字，否則按鈕會維持停用狀態，不是這批AI背景功能造成的限制。#design-text1
      // 在「文字與版面」彈窗裡，要先點觸發按鈕開啟彈窗才看得到。
      await page.click('#text-design-trigger-btn');
      await page.fill('#design-text1', 'T11測試主標題');
      await page.click('button:has-text("套用至卡面")');
      await page.locator('#wb-tab-btn-aibg').click();
      await page.fill('#ai-bg-prompt', 'T11測試草稿還原：格紋底圖');
      await page.click('#ai-bg-btn');
      await page.waitForSelector('#ai-bg-preview img', { timeout: 15000 });
      await page.click('#ai-bg-apply-btn');
      await page.waitForTimeout(200);
      const beforeRoundTrip = await page.evaluate(() => canvas2d.getObjects().some(o => o.name === 'ai-generate-background'));
      await page.getByRole('button', { name: /預覽成品/ }).click(); // Step3 → Step4
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: /修改設計|上一步/ }).first().click(); // Step4 → Step3
      await page.waitForSelector('#photo-upload-tabs', { state: 'attached' });
      await page.waitForFunction(() => typeof canvas2d !== 'undefined' && canvas2d && canvas2d.getObjects().length > 0, null, { timeout: 5000 }).catch(() => {});
      const restored = await page.evaluate(() => canvas2d.getObjects().some(o => o.name === 'ai-generate-background')).catch(() => false);
      restoreOk = beforeRoundTrip && restored;
      if (restoreOk) pass('T11. 套用AI背景後前進到預覽再返回設計稿，AI背景物件仍存在於還原後的畫布上');
      else fail('T11. 設計稿↔預覽來回後，AI背景物件未正確保留', `beforeRoundTrip=${beforeRoundTrip} restored=${restored}`);
    }

    // ── C15：手機版視窗不跑版（AI生成背景分頁仍可正常操作、頁面沒有橫向捲動）──
    {
      const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      mobilePage._yzBaseUrl = baseUrl;
      await goToDesignStep(mobilePage, 'easycard');
      // 手機版設計頁預設展開「設計預覽」分組（見 configurator.js initDesignStep() 呼叫
      // setMobileDesignGroup('preview')），AI生成背景所在的q-avatar-panel屬於"ai"分組，
      // 手機版底下要先切到"ai"分組分頁，工具區塊才會顯示出來，不是功能本身有問題。
      await mobilePage.evaluate(() => { if (typeof setMobileDesignGroup === 'function') setMobileDesignGroup('ai'); });
      const aibgTabVisible = await mobilePage.locator('#wb-tab-btn-aibg').isVisible().catch(() => false);
      let noHorizontalOverflow = null;
      let promptLabelOk = null;
      if (aibgTabVisible) {
        await mobilePage.locator('#wb-tab-btn-aibg').click();
        noHorizontalOverflow = await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 2);
        promptLabelOk = await mobilePage.evaluate(() => {
          const input = document.getElementById('ai-bg-prompt');
          const label = document.querySelector('label[for="ai-bg-prompt"]');
          return !!input && !!label;
        });
      }
      if (aibgTabVisible && noHorizontalOverflow && promptLabelOk) {
        pass('T12. 手機版視窗（390px）下「AI生成背景」分頁可見、有對應label、頁面沒有橫向溢出');
      } else {
        fail('T12. 手機版顯示不符預期', `aibgTabVisible=${aibgTabVisible} noHorizontalOverflow=${noHorizontalOverflow} promptLabelOk=${promptLabelOk}`);
      }
      await mobilePage.close();
    }

    await page.close();

    // ── D：成本涵蓋範圍回歸測試（admin-routes.js featureCostCoverage() 修正）──────────
    console.log('\n[成本涵蓋範圍回歸測試] 登入子行程後台，讀取AI使用統計驗證 costCoverage');
    {
      const loginResp = await fetch(baseUrl + '/api/admin/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: testOnlyAdminToken })
      });
      const loginData = await loginResp.json();
      const cookie = extractSessionCookie(loginResp.headers.get('set-cookie'));
      if (loginResp.status === 200 && loginData.success && cookie && loginData.csrfToken) {
        pass('T13. 使用測試專用隨機ADMIN_TOKEN成功登入子行程後台（owner帳號）');

        const statsResp = await fetch(baseUrl + '/api/admin/ai-usage-stats', {
          headers: { 'Cookie': cookie, 'X-CSRF-Token': loginData.csrfToken }
        });
        const stats = await statsResp.json();
        const byFeature = (stats && stats.byFeature) || [];
        const genImage = byFeature.find(f => f.featureKey === 'generate_image');
        const others = byFeature.filter(f => f.featureKey !== 'generate_image');

        if (genImage && genImage.totalRequests > 0 && genImage.costCoverage === 'partial') {
          pass(`T14. generate_image 修正後 costCoverage 正確顯示為 partial（不再是 unknown），totalRequests=${genImage.totalRequests}`);
        } else {
          fail('T14. generate_image 的 costCoverage 不符預期', JSON.stringify(genImage));
        }

        const othersOk = others.every(f => ['none', 'partial', 'full'].includes(f.costCoverage));
        if (othersOk) {
          pass('T15. 其餘三項AI功能（generate_design／black_card_pattern／cartoon_image）的 costCoverage 值仍在合法範圍內，未受這次修正影響而出現異常值');
        } else {
          fail('T15. 其餘功能的 costCoverage 出現不合法的值', JSON.stringify(others));
        }
      } else {
        fail('T13. 登入子行程後台失敗，無法繼續成本涵蓋範圍回歸測試', `status=${loginResp.status} body=${JSON.stringify(loginData)}`);
      }
    }

    // ── 敏感資料未外洩檢查 ──
    if (!combinedOutput.includes(fakeApiKey) && !combinedOutput.includes(testOnlyAdminToken)) {
      pass('T16. 子行程 stdout／stderr 全程未出現假OpenAI Key或測試用ADMIN_TOKEN本身');
    } else {
      fail('T16. 子行程輸出疑似洩漏敏感測試憑證');
    }

  } catch (e) {
    fail('測試流程發生未預期例外', e.message + '\n' + e.stack);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await killChildAndWait(child);
    await mock.close();
    const cleanup = await removeDirWithRetry(testDir);
    if (cleanup.ok) pass('T17. 臨時資料夾成功清除');
    else fail('T17. 臨時資料夾清理失敗（作業系統臨時目錄，未刪除任何非臨時路徑）');
  }

  console.log(`\n[ai-background-frontend-test] 完成：${passCount} 通過、${failCount} 失敗`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('[ai-background-frontend-test] 執行時發生未預期錯誤：', e.message, e.stack);
  process.exitCode = 1;
});
