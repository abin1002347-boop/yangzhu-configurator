// 隔離測試：悠遊卡／一卡通「背景造型」新設計預設值改為「空白背板」（2026-08-25 新增）。
//
// 背景：CARD_MASK_SHAPES 原本就已支援 'blank'（空白背板）造型，本批只調整
// STATE.backgroundTemplateId 的預設值（頁面初始值＋resetDesignStateForProduct()）從
// 'wave_single' 改成 'blank'，並新增 _syncWaveColorPanelVisibility() 共用函式同步「波浪
// 顏色」面板的顯示/隱藏，沒有重寫任何一套既有的畫布繪製邏輯——_addYangZhuVectorBackground()
// 早就會在造型是 blank 時自動跳過建立 template-wave／template-wave-light／template-dot。
//
// 隔離邊界（比照 scripts/ai-background-frontend-test.js 同一套慣例，這支腳本刻意不 require
// 那支腳本，保持每支 scripts/ 底下的測試腳本各自獨立自足）：
// - 資料庫：獨立子行程 server.js + NODE_ENV=test + TEST_DB_DIR（作業系統臨時目錄），不碰
//   本機正式 admin.db、訂單、工廠包或上傳資料夾。
// - 這支測試完全不涉及 AI 生成／OpenAI，不需要假 OpenAI 伺服器，也不會呼叫任何付費 API。
// - 瀏覽器：用專案既有的 playwright devDependency 啟動本機 headless Chromium，實際操作
//   http://localhost:<測試用埠>/customize?product=... 這個由子行程伺服的真實前台頁面。

const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');
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

// 深連結進入指定商品的設計稿頁（?product=xxx，等同客人直接分享/收藏連結的情境）
async function goToDesignStepViaDeepLink(page, product) {
  await page.goto(`${page._yzBaseUrl}/customize?product=${product}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /下一步：設計稿/ }).click();
  await page.waitForSelector('#photo-upload-tabs, #black-card-pattern-panel, #thermos-signature-trigger-block', { state: 'attached' });
}

// 從首頁（無 query）點選商品卡片進入，模擬客人在商品清單頁手動點選的正常流程
async function goToDesignStepViaProductCard(page, product) {
  await page.goto(`${page._yzBaseUrl}/customize`, { waitUntil: 'domcontentloaded' });
  await page.locator(`.product-card[data-product-id="${product}"]`).click();
  await page.waitForFunction(() => typeof STATE !== 'undefined' && STATE.step >= 2, null, { timeout: 5000 });
  // selectProduct() 全新設計會直接 nextStep() 到 Step2，這裡再點一次「下一步：設計稿」進 Step3
  await page.getByRole('button', { name: /下一步：設計稿/ }).click();
  await page.waitForSelector('#photo-upload-tabs, #black-card-pattern-panel, #thermos-signature-trigger-block', { state: 'attached' });
}

function templateObjectNames(page) {
  return page.evaluate(() => canvas2d.getObjects().map(o => o.name).filter(Boolean));
}

// 產生一張本機測試用照片檔（實體 PNG 檔案，供 page.setInputFiles() 模擬「一般照片」上傳，
// 完全不連線任何外部服務）。
async function buildTestPhotoFile(dir) {
  const sharp = require('sharp');
  const buf = await sharp({
    create: { width: 40, height: 30, channels: 4, background: { r: 90, g: 140, b: 200, alpha: 255 } }
  }).png().toBuffer();
  const filePath = path.join(dir, 'test-photo.png');
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// 產生一張本機測試用「AI 生成背景」圖片的 data URL，直接餵給 applyCroppedAiBackgroundImage()——
// 這支函式本來就是接收「已經裁切好的圖片 data URL」，跟真正呼叫 /api/generate-image／OpenAI
// 完全是兩個獨立步驟，這裡測的是「套用到畫布」這一段，不需要、也不會觸發任何真實生成請求。
async function buildTestAiBgDataUrl() {
  const sharp = require('sharp');
  const buf = await sharp({
    create: { width: 60, height: 40, channels: 4, background: { r: 40, g: 120, b: 90, alpha: 255 } }
  }).png().toBuffer();
  return 'data:image/png;base64,' + buf.toString('base64');
}

// 讀取目前畫布上「一般照片」（type=image 且沒有 name）與「AI 生成背景」
// （name='ai-generate-background'）兩個圖層的數量、相對疊層順序（陣列 index，數字越大
// 越接近最上層）、以及測試自己標記的 __yzTestMarker（用來確認前後是不是同一個物件實例，
// 不是被刪除後又剛好重建出位置相同的新物件）。
function getContentLayerSnapshot(page) {
  return page.evaluate(() => {
    const objs = canvas2d.getObjects();
    const photoIdx = objs.findIndex(o => o.type === 'image' && !o.name);
    const aiBgIdx = objs.findIndex(o => o.name === 'ai-generate-background');
    return {
      photoCount: objs.filter(o => o.type === 'image' && !o.name).length,
      aiBgCount: objs.filter(o => o.name === 'ai-generate-background').length,
      photoIdx,
      aiBgIdx,
      photoMarker: photoIdx >= 0 ? objs[photoIdx].__yzTestMarker : null,
      aiBgMarker: aiBgIdx >= 0 ? objs[aiBgIdx].__yzTestMarker : null
    };
  });
}
function contentLayersIntact(snap, expectPhotoAboveAiBg) {
  return snap.photoCount === 1 && snap.aiBgCount === 1
    && snap.photoMarker === 'photo-marker-A' && snap.aiBgMarker === 'aibg-marker-A'
    && (!expectPhotoAboveAiBg || snap.photoIdx > snap.aiBgIdx);
}

async function main() {
  console.log('[card-background-shape-test] 開始測試（獨立臨時伺服器＋獨立臨時資料庫＋本機headless瀏覽器，不呼叫任何AI/OpenAI，不影響正式3777與正式資料）');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-bg-shape-'));
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;

  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      FORM_TEST_MODE: 'false',
      TEST_DB_DIR: testDir,
      OPENAI_API_KEY: '',
      ADMIN_TOKEN: '',
      ADMIN_CSRF_SECRET: '',
      LINE_NOTIFY_TOKEN: '',
      CHATBOT_PUBLIC_URL: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let browser = null;
  try {
    await waitForHealthy(baseUrl, 20000);
    pass('T1. 臨時伺服器可正常啟動');

    browser = await chromium.launch();

    const consoleErrors = [];
    const BENIGN_CONSOLE_PATTERN = /Failed to load resource: the server responded with a status of \d+/;

    function trackConsole(page) {
      page.on('console', msg => { if (msg.type() === 'error' && !BENIGN_CONSOLE_PATTERN.test(msg.text())) consoleErrors.push(msg.text()); });
      page.on('pageerror', err => { consoleErrors.push('pageerror: ' + err.message); });
    }

    // ── T2/T3：從商品卡片點選（正常操作流程）進入全新悠遊卡／一卡通，預設應為 blank ──
    for (const product of ['easycard', 'ipass']) {
      const page = await browser.newPage();
      page._yzBaseUrl = baseUrl;
      trackConsole(page);
      await goToDesignStepViaProductCard(page, product);
      const bgId = await page.evaluate(() => STATE.backgroundTemplateId);
      if (bgId === 'blank') pass(`T${product === 'easycard' ? '2' : '3'}. 從商品卡片點選進入全新「${product}」，backgroundTemplateId 預設為 blank`);
      else fail(`T${product === 'easycard' ? '2' : '3'}. 全新「${product}」的 backgroundTemplateId 預設值不符`, `實際=${bgId}`);
      await page.close();
    }

    // ── T4/T5：深連結 ?product=xxx 進入全新設計，預設應為 blank ──
    for (const product of ['easycard', 'ipass']) {
      const page = await browser.newPage();
      page._yzBaseUrl = baseUrl;
      trackConsole(page);
      await goToDesignStepViaDeepLink(page, product);
      const bgId = await page.evaluate(() => STATE.backgroundTemplateId);
      if (bgId === 'blank') pass(`T${product === 'easycard' ? '4' : '5'}. 深連結 ?product=${product} 進入全新設計，backgroundTemplateId 預設為 blank`);
      else fail(`T${product === 'easycard' ? '4' : '5'}. 深連結 ?product=${product} 的 backgroundTemplateId 預設值不符`, `實際=${bgId}`);
      await page.close();
    }

    // ── 主要互動流程：easycard，沿用同一個分頁繼續測 T6~T13 ──
    const page = await browser.newPage();
    page._yzBaseUrl = baseUrl;
    trackConsole(page);
    await goToDesignStepViaDeepLink(page, 'easycard');

    // T6：新畫布只有 template-bg，沒有 template-wave／template-wave-light／template-dot
    {
      const names = await templateObjectNames(page);
      const hasBg = names.includes('template-bg');
      const hasWave = names.includes('template-wave');
      const hasWaveLight = names.includes('template-wave-light');
      const hasDot = names.includes('template-dot');
      if (hasBg && !hasWave && !hasWaveLight && !hasDot) {
        pass('T6. 全新空白背板畫布只有 template-bg，沒有 template-wave／template-wave-light／template-dot');
      } else {
        fail('T6. 全新空白背板畫布物件不符預期', `hasBg=${hasBg} hasWave=${hasWave} hasWaveLight=${hasWaveLight} hasDot=${hasDot}`);
      }
    }

    // T7：下拉按鈕預設顯示「空白背板」
    {
      const label = (await page.locator('#bg-template-select-label').textContent() || '').trim();
      if (label === '空白背板') pass('T7. 造型下拉按鈕預設顯示「空白背板」');
      else fail('T7. 造型下拉按鈕預設文字不符', `實際=${label}`);
    }

    // T8：空白狀態下，波浪顏色面板隱藏
    {
      const visible = await page.locator('#wave-color-panel').isVisible();
      if (!visible) pass('T8. 空白背板狀態下，波浪顏色面板正確隱藏');
      else fail('T8. 空白背板狀態下，波浪顏色面板未隱藏');
    }

    // T9：選擇「經典波浪」(wave_single) 後，波浪與圓點正確出現，波浪顏色面板顯示
    {
      await page.evaluate(() => { if (typeof selectMaskShape === 'function') selectMaskShape('wave_single'); });
      const names = await templateObjectNames(page);
      const hasWave = names.includes('template-wave');
      const hasWaveLight = names.includes('template-wave-light');
      const hasDot = names.includes('template-dot');
      const panelVisible = await page.locator('#wave-color-panel').isVisible();
      const label = (await page.locator('#bg-template-select-label').textContent() || '').trim();
      if (hasWave && hasWaveLight && hasDot && panelVisible && label === '經典波浪') {
        pass('T9. 選擇「經典波浪」後，波浪／淺色波浪／圓點正確出現，波浪顏色面板正確顯示，下拉按鈕文字同步更新');
      } else {
        fail('T9. 選擇「經典波浪」後的狀態不符預期', `hasWave=${hasWave} hasWaveLight=${hasWaveLight} hasDot=${hasDot} panelVisible=${panelVisible} label=${label}`);
      }
    }

    // T10：再切回「空白背板」後，波浪與圓點移除，純底板保留，波浪顏色面板重新隱藏
    {
      await page.evaluate(() => { if (typeof selectMaskShape === 'function') selectMaskShape('blank'); });
      const names = await templateObjectNames(page);
      const hasBg = names.includes('template-bg');
      const hasWave = names.includes('template-wave');
      const hasWaveLight = names.includes('template-wave-light');
      const hasDot = names.includes('template-dot');
      const panelVisible = await page.locator('#wave-color-panel').isVisible();
      if (hasBg && !hasWave && !hasWaveLight && !hasDot && !panelVisible) {
        pass('T10. 從「經典波浪」切回「空白背板」後，波浪與圓點移除、純底板保留，波浪顏色面板重新隱藏');
      } else {
        fail('T10. 切回空白背板後的狀態不符預期', `hasBg=${hasBg} hasWave=${hasWave} hasWaveLight=${hasWaveLight} hasDot=${hasDot} panelVisible=${panelVisible}`);
      }
    }

    // ── T11~T13：一般照片圖層與 ai-generate-background 圖層，在「空白背板 → 經典波浪 →
    // 空白背板」整趟切換過程中都不能被刪除、替換（同一物件實例）、重複，相對疊層順序
    // （照片在AI生成背景之上，兩者都在 template-* 之上）也不能跑掉。全程用本機測試圖片，
    // 不呼叫任何真正的 OpenAI API：照片走真實的 <input type=file> 上傳流程
    // （page.setInputFiles，模擬客人「一般照片」分頁上傳）；AI生成背景則直接呼叫
    // applyCroppedAiBackgroundImage(dataURL)——這支函式本來就只負責「把已經裁切好的圖片
    // 套到畫布」，跟真正呼叫 /api/generate-image 是兩個獨立步驟，這裡不需要、也不會觸發
    // 任何真實生成請求或費用。另開一個乾淨分頁，避免沿用前面 T9/T10 已經切換過幾次造型
    // 的畫布狀態，讓「blank → wave_single → blank」這趟測試從乾淨起點開始。
    const testPhotoPath = await buildTestPhotoFile(testDir);
    const testAiBgDataUrl = await buildTestAiBgDataUrl();
    const contentPage = await browser.newPage();
    contentPage._yzBaseUrl = baseUrl;
    trackConsole(contentPage);
    await goToDesignStepViaDeepLink(contentPage, 'easycard');

    // T11：空白背板狀態下，成功加入一般照片圖層與 ai-generate-background 圖層，各恰好一個，
    // 照片正確疊在AI生成背景之上（沿用既有 applyCroppedAiBackgroundImage() 的疊層規則）
    {
      const startBgId = await contentPage.evaluate(() => STATE.backgroundTemplateId);
      await contentPage.setInputFiles('#design-upload-tab', testPhotoPath);
      await contentPage.waitForFunction(() => canvas2d.getObjects().some(o => o.type === 'image' && !o.name), null, { timeout: 5000 });
      await contentPage.evaluate(() => {
        const obj = canvas2d.getObjects().find(o => o.type === 'image' && !o.name);
        if (obj) obj.__yzTestMarker = 'photo-marker-A';
      });
      await contentPage.evaluate((url) => {
        if (typeof applyCroppedAiBackgroundImage === 'function') applyCroppedAiBackgroundImage(url);
      }, testAiBgDataUrl);
      await contentPage.waitForFunction(() => canvas2d.getObjects().some(o => o.name === 'ai-generate-background'), null, { timeout: 5000 });
      await contentPage.evaluate(() => {
        const obj = canvas2d.getObjects().find(o => o.name === 'ai-generate-background');
        if (obj) obj.__yzTestMarker = 'aibg-marker-A';
      });
      const snap = await getContentLayerSnapshot(contentPage);
      if (startBgId === 'blank' && contentLayersIntact(snap, true)) {
        pass('T11. 空白背板狀態下成功加入一般照片圖層與 ai-generate-background 圖層，各恰好一個，照片疊在AI生成背景之上');
      } else {
        fail('T11. 加入照片與AI生成背景圖層後的狀態不符預期', `startBgId=${startBgId} snap=${JSON.stringify(snap)}`);
      }
    }

    // T12：切換到「經典波浪」後，兩個圖片圖層都還是同一個物件實例（__yzTestMarker 不變），
    // 沒有被刪除、替換或重複，相對疊層順序不變
    {
      await contentPage.evaluate(() => { if (typeof selectMaskShape === 'function') selectMaskShape('wave_single'); });
      const names = await templateObjectNames(contentPage);
      const snap = await getContentLayerSnapshot(contentPage);
      if (names.includes('template-wave') && contentLayersIntact(snap, true)) {
        pass('T12. 切換到「經典波浪」後，一般照片與AI生成背景圖層皆保留原物件（未被刪除/替換/重複），相對疊層順序不變');
      } else {
        fail('T12. 切換到「經典波浪」後，圖片圖層狀態不符預期', `hasWave=${names.includes('template-wave')} snap=${JSON.stringify(snap)}`);
      }
    }

    // T13：再切回「空白背板」後，兩個圖片圖層依然是同一個物件實例，未被動過
    {
      await contentPage.evaluate(() => { if (typeof selectMaskShape === 'function') selectMaskShape('blank'); });
      const names = await templateObjectNames(contentPage);
      const snap = await getContentLayerSnapshot(contentPage);
      if (names.includes('template-bg') && !names.includes('template-wave') && contentLayersIntact(snap, true)) {
        pass('T13. 再切回「空白背板」後，一般照片與AI生成背景圖層依然保留原物件，相對疊層順序不變');
      } else {
        fail('T13. 再切回「空白背板」後，圖片圖層狀態不符預期', `names=${JSON.stringify(names)} snap=${JSON.stringify(snap)}`);
      }
    }
    await contentPage.close();

    // T14：舊草稿（改版前存的 backgroundTemplateId=wave_single）恢復時，必須照原本造型還原，
    // 不可被新的 blank 預設值覆蓋——直接呼叫 _applyDraftToConfigurator() 帶入一份模擬舊草稿，
    // 跳過 sessionStorage/localStorage 與整頁重新整理的既有限制（見 configurator.js
    // _redirectHomeOnReload()，重新整理本來就會主動清空草稿，不是這裡要測的情境）。
    {
      const result = await page.evaluate(async () => {
        const legacyDraft = {
          version: 1,
          draftId: 'legacy-test-draft',
          productId: 'easycard',
          currentStep: 3,
          updatedAt: Date.now(),
          state: Object.assign({}, STATE, { backgroundTemplateId: 'wave_single', canvasJSON: null, designDataURL: null })
        };
        await _applyDraftToConfigurator(legacyDraft);
        await new Promise(r => setTimeout(r, 300));
        const names = canvas2d.getObjects().map(o => o.name).filter(Boolean);
        return {
          bgId: STATE.backgroundTemplateId,
          hasWave: names.includes('template-wave'),
          label: (document.getElementById('bg-template-select-label') || {}).textContent
        };
      });
      const labelTrim = (result.label || '').trim();
      if (result.bgId === 'wave_single' && result.hasWave && labelTrim === '經典波浪') {
        pass('T14. 舊草稿（backgroundTemplateId=wave_single）恢復時照原本造型還原，未被新的 blank 預設值覆蓋');
      } else {
        fail('T14. 舊草稿還原後的造型不符預期', JSON.stringify(result));
      }
    }

    // T15：客戶選擇造型後，從設計稿前進到預覽再返回，選擇的造型仍保留（不論是 STATE 標記
    // 還是畫布上實際的向量物件，兩者都要正確保留，不能只有其中一項對）。這裡先切回一個
    // 乾淨的 easycard 分頁，選「雙層波浪」，避免沿用上面 T14 注入的模擬舊草稿狀態。
    {
      const p2 = await browser.newPage();
      p2._yzBaseUrl = baseUrl;
      trackConsole(p2);
      await goToDesignStepViaDeepLink(p2, 'easycard');
      await p2.evaluate(() => { if (typeof selectMaskShape === 'function') selectMaskShape('wave_double'); });
      await p2.evaluate(() => { if (typeof goStep === 'function') goStep(4); });
      await p2.waitForTimeout(300);
      await p2.evaluate(() => { if (typeof goStep === 'function') goStep(3); });
      await p2.waitForSelector('#photo-upload-tabs', { state: 'attached' });
      await p2.waitForFunction(() => typeof canvas2d !== 'undefined' && canvas2d && canvas2d.getObjects().length > 0, null, { timeout: 5000 }).catch(() => {});
      const bgId = await p2.evaluate(() => STATE.backgroundTemplateId);
      const hasWave = await p2.evaluate(() => canvas2d.getObjects().some(o => o.name === 'template-wave'));
      const label = (await p2.locator('#bg-template-select-label').textContent() || '').trim();
      if (bgId === 'wave_double' && hasWave && label === '雙層波浪') {
        pass('T15. 設計稿↔預覽來回後，客戶選擇的背景造型（雙層波浪）仍正確保留');
      } else {
        fail('T15. 設計稿↔預覽來回後，背景造型未正確保留', `bgId=${bgId} hasWave=${hasWave} label=${label}`);
      }
      await p2.close();
    }

    await page.close();

    // ── T16：保溫杯／黑卡行為完全不變（本批只調整悠遊卡／一卡通）──
    {
      let ok = true;
      const details = [];
      for (const product of ['thermos', 'black_card']) {
        const p3 = await browser.newPage();
        p3._yzBaseUrl = baseUrl;
        trackConsole(p3);
        await goToDesignStepViaDeepLink(p3, product);
        const bgTemplateBlockVisible = await p3.locator('.background-template-block').isVisible().catch(() => false);
        const waveColorPanelVisible = await p3.locator('#wave-color-panel').isVisible().catch(() => false);
        if (bgTemplateBlockVisible || waveColorPanelVisible) {
          ok = false;
          details.push(`${product}: bgTemplateBlockVisible=${bgTemplateBlockVisible} waveColorPanelVisible=${waveColorPanelVisible}`);
        }
        await p3.close();
      }
      if (ok) pass('T16. 保溫杯／黑卡的背景造型區塊與波浪顏色面板依舊維持隱藏，行為完全不變');
      else fail('T16. 保溫杯／黑卡的顯示狀態被本批影響', details.join('；'));
    }

    // ── T17：320px／390px 手機寬度，沒有新增橫向溢出 ──
    {
      let ok = true;
      const details = [];
      for (const width of [320, 390]) {
        const p4 = await browser.newPage({ viewport: { width, height: 800 } });
        p4._yzBaseUrl = baseUrl;
        trackConsole(p4);
        await goToDesignStepViaDeepLink(p4, 'easycard');
        const overflow = await p4.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        if (overflow) { ok = false; details.push(`${width}px 出現橫向溢出`); }
        await p4.close();
      }
      if (ok) pass('T17. 320px／390px 手機寬度下沒有新增橫向溢出');
      else fail('T17. 手機寬度出現橫向溢出', details.join('；'));
    }

    // ── console 錯誤總檢查 ──
    if (consoleErrors.length === 0) {
      pass('T18. 整段互動流程沒有新增瀏覽器主控台錯誤');
    } else {
      fail('T18. 主控台出現未預期的錯誤', consoleErrors.slice(0, 5).join(' | '));
    }

  } catch (e) {
    fail('測試流程發生未預期例外', e.message + '\n' + e.stack);
  } finally {
    if (browser) await browser.close();
    await killChildAndWait(child);
    const cleanup = await removeDirWithRetry(testDir);
    if (cleanup.ok) pass('T19. 臨時資料夾成功清除');
    else fail('T19. 臨時資料夾清理失敗', '可能仍有檔案鎖未釋放，路徑為作業系統臨時目錄，未刪除任何非臨時路徑');
  }

  console.log(`\n[card-background-shape-test] 完成：${passCount} 通過、${failCount} 失敗`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('[card-background-shape-test] 執行時發生未預期錯誤：', e.message, e.stack);
  process.exitCode = 1;
});
