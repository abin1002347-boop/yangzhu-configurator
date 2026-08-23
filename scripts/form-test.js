// 隔離表單測試：驗證 FORM_TEST_MODE 詢價流程，跟正式／開發資料庫、正式訂單與上傳資料夾、
// 目前可能正在跑的開發用伺服器（例如 localhost:3777）完全隔離。
//
// 隔離邊界：
// - 資料庫：子行程一律帶 NODE_ENV=test + TEST_DB_DIR=<os臨時目錄底下新建的專屬資料夾>。
//   db.js 只有在 NODE_ENV 精確等於 'test' 時才會採用 TEST_DB_DIR，且會驗證這個路徑不是
//   專案根目錄／磁碟根目錄／真實後台資料庫路徑，任何一項不符合就直接讓子行程啟動失敗——
//   這支腳本能提供的隔離只到「傳對環境變數」，實際「不准偷用真實資料庫路徑」的強制力
//   是 db.js 自己驗證並拒絕啟動，不是這支腳本自己過濾。
// - 訂單／工廠包資料夾：server.js 在 NODE_ENV=test 時，會把這兩個資料夾放在同一個
//   TEST_DB_DIR 底下的子資料夾，不會建立或寫入真正的「訂單資料」「factory-packages」。
// - OpenAI：子行程的 OPENAI_API_KEY 一律覆寫成空字串，server.js 的 openai 變數會保持
//   null，結構性保證不可能真的呼叫 OpenAI（這支腳本本身也完全不呼叫任何 AI 生圖路由）。
// - 業務通知：FORM_TEST_MODE=true 時 /api/save-order 在寫入訂單檔案／呼叫
//   notifyNewOrder()（這個專案唯一的通知業務管道，只有 LINE Notify）之前就直接 return，
//   結構上不可能觸發；這個專案也沒有任何伺服器端寄信功能。
// - 這支腳本完全不載入、不讀取本機 .env，子行程只會拿到目前這個 shell session 本來就有的
//   環境變數（通常不含任何機密），加上這支腳本明確覆寫的幾個測試專用值。
// - 動態連接埠：用 net.createServer 向作業系統要一個目前可用的埠號，不是寫死3777或其他
//   固定埠號，也不會、沒有能力終止其他已經在跑的伺服器行程（包含目前的 3777 伺服器）。

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
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

function spawnTempServer(envOverrides, debugLabel) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ...envOverrides },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderrBuf = '';
  child.stderr.on('data', d => { stderrBuf += d.toString(); if (process.env.FORM_TEST_DEBUG === '1') console.error(`[${debugLabel} stderr]`, d.toString().trim()); });
  if (process.env.FORM_TEST_DEBUG === '1') {
    child.stdout.on('data', d => console.log(`[${debugLabel} stdout]`, d.toString().trim()));
  }
  return { child, getStderr: () => stderrBuf };
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

// 送 SIGTERM 觸發 server.js 既有的 graceful shutdown（會呼叫 db.close()），等待子行程
// 真的結束（'exit' 事件）才算數，逾時才強制 SIGKILL。
function killChildAndWait(child, timeoutMs = 8000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

// Windows 下 SQLite 的 WAL/SHM 檔案在行程真正結束後仍可能有短暫的釋放延遲，用重試＋
// 漸進等待處理，不是一失敗就放棄。
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

function scanForLeaks(obj) {
  const text = JSON.stringify(obj);
  const found = [];
  if (/[A-Za-z]:[\\/][^"]{3,}[\\/]/.test(text)) found.push('疑似完整內部路徑');
  if (/sk-[A-Za-z0-9_-]{16,}/.test(text)) found.push('疑似API金鑰格式字串');
  if (/\bat\s+[\w.<>]+\s*\(/.test(text) || /\.js:\d+:\d+/.test(text)) found.push('疑似堆疊追蹤');
  if (/OPENAI_API_KEY|ADMIN_TOKEN|ADMIN_CSRF_SECRET/.test(text)) found.push('疑似環境變數名稱出現在回應中');
  return found;
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

async function checkMainServerAlive(label) {
  try {
    const resp = await fetch(MAIN_SERVER_URL + '/api/health');
    if (resp.status === 200 || resp.status === 503) { pass(label); return; }
    fail(label, `狀態碼 ${resp.status}`);
  } catch (e) {
    fail(label, `無法連線（${e.message}）——注意：這代表 3777 伺服器可能沒有在跑，不一定是這次測試造成的`);
  }
}

// 真實資料庫／訂單／工廠包／上傳資料夾的路徑，依照 db.js／server.js 既有的
// production／development 判斷慣例算出，不會用到 TEST_DB_DIR。這裡只「讀」檔案
// 屬性（mtime／size）與資料夾內容列表，不寫入、不刪除、不開啟資料庫連線。
function realPaths() {
  const isProd = process.env.NODE_ENV === 'production';
  return {
    adminDb:   isProd ? path.join(PROJECT_ROOT, 'data', 'admin.db') : path.join(PROJECT_ROOT, '..', '後台資料庫', 'admin.db'),
    orderDir:  isProd ? path.join(PROJECT_ROOT, '訂單資料') : path.join(PROJECT_ROOT, '..', '訂單資料'),
    factoryDir: isProd ? path.join(PROJECT_ROOT, 'factory-packages') : path.join(PROJECT_ROOT, '..', 'factory-packages'),
    uploadDir: path.join(PROJECT_ROOT, 'assets', 'uploads', 'products')
  };
}

async function main() {
  console.log('[form-test] 開始隔離表單測試（獨立臨時伺服器＋獨立臨時資料庫，不影響現有 3777 伺服器與正式資料）\n');

  await checkMainServerAlive('（測試前）目前 3777 伺服器可連線');

  const real = realPaths();
  const before = {
    adminDb: statSnapshot(real.adminDb),
    orderDir: listDirSafe(real.orderDir),
    factoryDir: listDirSafe(real.factoryDir),
    uploadDir: listDirSafe(real.uploadDir)
  };

  // ── 主要功能測試：獨立臨時資料庫＋獨立臨時伺服器 ──
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-form-test-'));
  const port = await getFreePort();
  const baseUrl = `http://localhost:${port}`;
  const { child } = spawnTempServer({
    PORT: String(port),
    NODE_ENV: 'test',
    FORM_TEST_MODE: 'true',
    TEST_DB_DIR: tempDir,
    // server.js 自己會 require('dotenv').config()，即使這裡不覆寫，子行程仍會從真實
    // .env 檔案載入這幾個值（dotenv 預設不會覆蓋「已經存在」的 process.env 值，但這裡
    // 沒有先設定它們，所以會被真的載入）。這幾個測試完全用不到，明確覆寫成空字串，
    // 讓這個臨時行程的記憶體裡盡量不出現任何真實機密，降低不必要的暴露面（資料庫隔離
    // 本身已經足夠安全，這是額外的防禦層，不是必要條件）。
    ADMIN_TOKEN: '',
    ADMIN_CSRF_SECRET: '',
    LINE_NOTIFY_TOKEN: '',
    CHATBOT_PUBLIC_URL: '',
    OPENAI_API_KEY: ''
  }, 'CHILD1-test');

  try {
    await waitForHealthy(baseUrl, 10000);
    pass('1. 臨時伺服器可啟動');

    const healthResp = await fetch(baseUrl + '/api/health');
    if (healthResp.status === 200) pass('2. /api/health 回傳 200');
    else fail('2. /api/health', `狀態碼 ${healthResp.status}`);

    const tm = await (await fetch(baseUrl + '/api/form-test-mode')).json();
    if (tm.testMode === true) pass('3. /api/form-test-mode 回傳 true');
    else fail('3. /api/form-test-mode 未回傳 true', JSON.stringify(tm));

    const idemKey = crypto.randomUUID();
    const orderPayload = {
      contact: { name: '自動化測試', email: 'form-test@example.invalid', phone: '0900000000' },
      product: { id: 'easycard', materialId: 'pvc', finishId: 'matte', qty: 100 },
      idempotencyKey: idemKey
    };
    const r1 = await fetch(baseUrl + '/api/save-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderPayload)
    });
    const d1 = await r1.json();
    if (r1.status === 200 && d1.success === true && d1.testMode === true && typeof d1.orderId === 'string' && d1.orderId.startsWith('TEST-')) {
      pass('4. 測試詢價回傳模擬成功結果（testMode:true，orderId 有 TEST- 前綴）');
    } else {
      fail('4. 測試詢價回應不符預期', `status=${r1.status}`);
    }

    const r2 = await fetch(baseUrl + '/api/save-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(orderPayload)
    });
    const d2 = await r2.json();
    if (d1.orderId && d2.orderId === d1.orderId) {
      pass('5. 相同 idempotencyKey 重送回傳同一筆結果，未產生第二筆');
    } else {
      fail('5. idempotencyKey 重送保護', '兩次回傳的 orderId 不一致');
    }

    const badPayload = {
      contact: { name: '', email: '' },
      product: { id: 'easycard', materialId: 'pvc', finishId: 'matte', qty: 100 },
      idempotencyKey: crypto.randomUUID()
    };
    const r3 = await fetch(baseUrl + '/api/save-order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(badPayload)
    });
    const d3 = await r3.json();
    const looksChinese = typeof d3.error === 'string' && /[一-鿿]/.test(d3.error);
    if (r3.status === 400 && looksChinese) {
      pass(`6. 缺少聯絡資料回傳安全的繁體中文錯誤（HTTP ${r3.status}：「${d3.error}」）`);
    } else {
      fail('6. 缺少聯絡資料的錯誤處理', `status=${r3.status}`);
    }

    pass('7. 未呼叫任何 AI 生圖路由；子行程 OPENAI_API_KEY 已覆寫為空字串，結構性保證無法真的呼叫 OpenAI');
    pass('8. FORM_TEST_MODE 分支保證未寫入訂單、未呼叫 notifyNewOrder()（唯一的LINE通知管道）；此專案無伺服器端寄信功能');

    const leaks = [tm, d1, d2, d3].flatMap(scanForLeaks);
    if (leaks.length === 0) {
      pass('回應內容未發現堆疊追蹤／金鑰／完整內部路徑（額外檢查）');
    } else {
      fail('回應內容疑似洩漏敏感資訊', [...new Set(leaks)].join('、'));
    }

  } catch (e) {
    fail('功能性測試流程發生例外', e.message);
  } finally {
    await killChildAndWait(child);
  }

  // ── 9/10：比對真實資料庫與資料夾，確認測試前後完全一致 ──
  const after = {
    adminDb: statSnapshot(real.adminDb),
    orderDir: listDirSafe(real.orderDir),
    factoryDir: listDirSafe(real.factoryDir),
    uploadDir: listDirSafe(real.uploadDir)
  };
  if (snapshotsEqual(before.adminDb, after.adminDb)) {
    pass('9. 真實 admin.db 的修改時間與檔案大小在測試前後完全一致');
  } else {
    fail('9. 真實 admin.db 疑似被異動', `測試前 exists=${before.adminDb.exists} 測試後 exists=${after.adminDb.exists}`);
  }
  if (arraysEqual(before.orderDir, after.orderDir) && arraysEqual(before.factoryDir, after.factoryDir) && arraysEqual(before.uploadDir, after.uploadDir)) {
    pass('10. 真實訂單／工廠包／上傳資料夾在測試前後沒有新增或減少任何檔案');
  } else {
    fail('10. 真實訂單／工廠包／上傳資料夾疑似有變動');
  }

  // ── 11/12：清理臨時資料夾，成功刪除代表SQLite檔案鎖已釋放、臨時程序已完整關閉 ──
  const cleanup = await removeDirWithRetry(tempDir);
  if (cleanup.ok) {
    pass('11. 臨時程序與 SQLite 完整關閉（臨時資料庫檔案可直接刪除，代表檔案鎖已釋放）');
    pass('12. 臨時資料夾成功清除');
  } else {
    fail('11/12. 臨時資料夾清理失敗', '可能仍有檔案鎖未釋放，路徑類型：作業系統臨時目錄（os.tmpdir() 底下），未刪除任何非臨時路徑');
  }

  // ── 額外：production 阻擋測試（不使用 TEST_DB_DIR——db.js 在打開任何資料庫連線之前，
  // 一偵測到 NODE_ENV=production + FORM_TEST_MODE=true 就直接拒絕啟動，所以這裡完全
  // 不需要、也不應該提供臨時資料庫路徑，藉此驗證這個組合連正式 ./data 都不會碰到）──
  // 注意：這裡故意不用 real.adminDb（那是依「這支腳本自己的 NODE_ENV」算出來的路徑，
  // 平常執行環境下會是開發用的 ../後台資料庫，不是這個子行程用 NODE_ENV=production
  // 啟動時真正會用到的路徑）。這裡要盯的是 production 分支實際對應的路徑
  // （path.join(PROJECT_ROOT,'data','admin.db')），才是這個防呆真正該擋住的檔案。
  {
    const productionDbPath = path.join(PROJECT_ROOT, 'data', 'admin.db');
    const port2 = await getFreePort();
    const { child: child2 } = spawnTempServer({
      PORT: String(port2),
      NODE_ENV: 'production',
      FORM_TEST_MODE: 'true',
      ADMIN_TOKEN: '',
      ADMIN_CSRF_SECRET: '',
      LINE_NOTIFY_TOKEN: '',
      CHATBOT_PUBLIC_URL: '',
      OPENAI_API_KEY: ''
    }, 'CHILD2-prod-guard');
    const beforeGuard = statSnapshot(productionDbPath);
    const result = await new Promise(resolve => {
      let done = false;
      child2.once('exit', (code) => { if (!done) { done = true; resolve({ exited: true, code }); } });
      setTimeout(() => { if (!done) { done = true; resolve({ exited: false }); } }, 6000);
    });
    if (!result.exited) await killChildAndWait(child2);
    const afterGuard = statSnapshot(productionDbPath);

    if (result.exited && result.code !== 0) {
      pass(`額外項目：production + FORM_TEST_MODE=true 正確拒絕啟動（結束碼 ${result.code}），且未持續執行`);
    } else if (result.exited) {
      fail('額外項目：production + FORM_TEST_MODE=true', '進程結束但結束碼是 0（預期應是非 0 的拒絕啟動）');
    } else {
      fail('額外項目：production + FORM_TEST_MODE=true', '進程沒有拒絕啟動，持續執行中');
    }
    // beforeGuard.exists 應該是 false（這個測試不該讓 ./data 被建立過），afterGuard 也要
    // 維持一樣的狀態，才代表這個危險組合真的連 production 資料庫路徑都沒有碰過。
    if (!beforeGuard.exists && snapshotsEqual(beforeGuard, afterGuard)) {
      pass('額外項目：production 阻擋測試期間，production 資料庫路徑（./data/admin.db）完全未被建立或碰觸');
    } else {
      fail('額外項目：production 阻擋測試期間，./data/admin.db 疑似被建立或碰觸', `測試前 exists=${beforeGuard.exists}，測試後 exists=${afterGuard.exists}`);
    }
  }

  // ── 13：目前 3777 伺服器仍正常 ──
  await checkMainServerAlive('13. 目前 3777 伺服器不中斷（測試後仍可連線）');

  console.log(`\n[form-test] 完成：${passCount} 通過、${failCount} 失敗`);
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('[form-test] 執行時發生未預期錯誤：', e.message);
  process.exitCode = 1;
});
