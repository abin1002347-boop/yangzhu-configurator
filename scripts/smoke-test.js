// 基礎驗收腳本：不呼叫任何付費 AI API、不送出真實詢價，只確認伺服器基本路由與安全設定
// 正常運作。假設伺服器已經另外啟動（npm run dev / npm start），這支腳本只負責發 HTTP
// 請求檢查回應，不會自己啟動或關閉伺服器。
// 用法：SMOKE_TEST_BASE_URL=http://localhost:3777 npm run smoke-test
//（未設定 SMOKE_TEST_BASE_URL 時，依序改用 .env 的 PORT，最後預設 3000）。

const path = require('path');
// 載入專案根目錄的 .env，只是為了讀取 PORT 這類非機密設定值，用來組出預設要打的網址——
// dotenv.config() 本身不會印出任何內容到 console，這裡也絕對不會把 process.env 的內容
// 輸出到任何地方，只取用需要的單一數字。
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// 網址優先順序：1. SMOKE_TEST_BASE_URL 明確指定  2. .env 的 PORT  3. 預設 3000
const BASE_URL = process.env.SMOKE_TEST_BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

let failCount = 0;
let passCount = 0;

function pass(label) {
  passCount++;
  console.log(`  ✓ ${label}`);
}
function fail(label, detail) {
  failCount++;
  console.error(`  ✗ ${label}${detail ? '：' + detail : ''}`);
}

async function checkStatus(label, path, expectedStatus) {
  try {
    const resp = await fetch(BASE_URL + path, { redirect: 'manual' });
    if (resp.status === expectedStatus) {
      pass(`${label}（${path} → ${resp.status}）`);
    } else {
      fail(`${label}（${path}）`, `預期 ${expectedStatus}，實際 ${resp.status}`);
    }
    return resp;
  } catch (e) {
    fail(`${label}（${path}）`, e.message);
    return null;
  }
}

async function main() {
  console.log(`[smoke-test] 目標伺服器：${BASE_URL}\n`);

  console.log('基本頁面：');
  await checkStatus('首頁', '/', 200);
  await checkStatus('配置器', '/customize', 200);
  await checkStatus('隱私權政策', '/privacy', 200);

  console.log('\n商品深連結：');
  for (const pid of ['easycard', 'ipass', 'thermos', 'black_card']) {
    await checkStatus(`深連結 ${pid}`, `/customize?product=${pid}`, 200);
  }

  console.log('\n404 處理：');
  await checkStatus('未知頁面回品牌404', '/this-page-does-not-exist', 404);
  await checkStatus('未知API回JSON404', '/api/does-not-exist', 404);

  console.log('\n健康檢查：');
  const healthResp = await checkStatus('/api/health', '/api/health', 200);
  if (healthResp) {
    try {
      const data = await healthResp.json();
      if (data.status === 'ok' && data.service === 'yangzhu-customizer') {
        pass('健康檢查回應格式正確');
      } else {
        fail('健康檢查回應格式', JSON.stringify(data));
      }
      const forbiddenKeys = ['apiKey', 'token', 'password', 'stack', 'env'];
      const leaked = forbiddenKeys.filter(k => JSON.stringify(data).toLowerCase().includes(k.toLowerCase()));
      if (leaked.length === 0) {
        pass('健康檢查回應未包含敏感欄位名稱');
      } else {
        fail('健康檢查回應疑似包含敏感欄位', leaked.join('、'));
      }
    } catch (e) {
      fail('健康檢查回應解析', e.message);
    }
  }

  console.log('\n測試模式旗標：');
  await checkStatus('/api/form-test-mode', '/api/form-test-mode', 200);

  console.log(`\n[smoke-test] 完成：${passCount} 通過、${failCount} 失敗`);
  // 用 exitCode 而不是直接 process.exit()：讓事件迴圈自然跑完、fetch底層的網路控制代碼
  // 正常關閉，避免在部分 Node 版本／Windows 環境下跟尚未關閉的內部控制代碼搶跑，
  // 造成程序被判定為非預期崩潰（結果本身仍然正確，只是結束方式不乾淨）。
  process.exitCode = failCount > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('[smoke-test] 執行時發生未預期錯誤：', e.message);
  process.exitCode = 1;
});
