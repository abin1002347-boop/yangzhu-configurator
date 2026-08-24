// 楊竹科技配置器 — Express 後端
require('dotenv').config();

const express  = require('express');
const helmet   = require('helmet'); // Helmet 安全標頭＋CSP Report-Only（第一階段）
const OpenAI   = require('openai');
const { toFile } = require('openai');
const path     = require('path');
const fs       = require('fs');
const sharp    = require('sharp');
const archiver = require('archiver');
const crypto   = require('crypto');
const { db, getActiveProducts, getProductById, getAiFeatureSetting, getAiPromptSetting, createAiUsageLog, getAiUsageLimitSettings, recordAiClientAttemptIfAllowed, reserveAiSiteUsageIfAllowed, recordAnalyticsEvent,
  normalizeAdminUsername, verifyAdminPassword, verifyAdminPasswordAgainstDummy,
  listAdminUsers, findAdminUserById, findAdminUserSafeById, findAdminUserByUsername, countActiveOwners,
  createAdminUser, updateAdminUserDisplayName, updateAdminUserRole, setAdminUserStatus, setAdminUserPassword,
  clearAdminUserLockDisplay, syncAdminUserLockDisplay, touchAdminUserLastLogin,
  computeAdminLoginIdentityHash, getAdminLoginLockState, recordAdminLoginFailure, clearAdminLoginAttempts,
  recordAdminAuditLog, queryAdminAuditLog
} = require('./db'); // 商品資料正式來源（SQLite），js/products.js 只作為前端 API 連不上時的備援；getAiFeatureSetting／getAiPromptSetting 供四支 AI 路由每次請求即時讀取後台「AI 功能設定」的最新啟用狀態／模型／主要提示詞；createAiUsageLog 供 createAiUsageTracker() 寫入 AI 使用紀錄；getAiUsageLimitSettings／recordAiClientAttemptIfAllowed／reserveAiSiteUsageIfAllowed 供 aiUsageLimitMiddleware()／reserveAiSiteUsage() 讀取次數限制設定並原子判斷是否超限；recordAnalyticsEvent 供分析事件寫入（見 runContentModeration() 之後的「分析事件基礎」章節）；normalizeAdminUsername 起到 queryAdminAuditLog 這一整組供「正式管理員帳號、角色權限、登入限制與操作稽核」批次的登入／帳號管理／稽核紀錄使用
const { requirePermission, requireOwner } = require('./admin-rbac'); // 集中式角色權限表：所有 /api/admin、/api/orders 路由的最終權限判斷來源
const { buildXlsxBuffer, sendXlsx } = require('./xlsx-export'); // 後台「匯出Excel」共用工具：統一產生真正的.xlsx二進位檔
const { deductInventoryForOrder, restockInventoryForOrderCancellation } = require('./inventory-deduction.js'); // 訂單自動扣庫存／取消自動回補安全底層：驗證／冪等／transaction 原子扣除或回補，見該檔案說明
const { calcQuoteForProduct } = require('./js/products.js'); // 報價計算純函式：前後端共用同一份級距/材質/工藝/容量計價邏輯
const { resolveReceivableTotal } = require('./js/quote-total-resolver.js'); // 應收總額統一解析函式：前後端（admin.html）共用同一份「正式報價版本／人工調價/原始報價」優先順序規則
const {
  validateAdjustmentFields,
  resolveBaseAmount,
  computeAdjustmentAmounts,
  adjustmentContentMatches,
  computeCurrentPricing
} = require('./pricing-adjustment.js'); // 人工調價（折扣/額外費用/運費/稅額）純函式：驗證與計算邏輯，跟路由分離方便單元測試
const {
  IDEMPOTENCY_KEY_REGEX: QUOTE_VERSION_IDEMPOTENCY_KEY_REGEX,
  validatePublishFields,
  quoteVersionIntentMatches,
  nextVersionNumber,
  resolvePublishablePricing,
  buildQuoteVersionSnapshot
} = require('./quote-version.js'); // 報價版本及有效期限純函式：目前可發布報價解析、版本快照建立、冪等比對
const {
  IDEMPOTENCY_KEY_REGEX: QUOTE_RESPONSE_IDEMPOTENCY_KEY_REGEX,
  validateResponseFields,
  responseContentMatches,
  isLatestQuoteVersion,
  checkQuoteVersionNotExpired,
  buildCustomerResponse
} = require('./quote-customer-response.js'); // 客戶報價確認（accepted／rejected）純函式：驗證、冪等比對、回覆快照建立
const {
  generateRawToken,
  hashToken,
  isValidTokenFormat,
  safeCompareHash,
  buildCustomerAccessRecord,
  evaluatePublicAccess,
  resolvePublicQuoteStatus,
  buildPublicQuoteConfirmationView
} = require('./quote-public-access.js'); // 客戶報價確認安全公開存取純函式：Token 產生／雜湊／驗證、公開白名單資料建構
const { emitNotificationEvent } = require('./notification-service'); // 統一通知系統批次：新訂單／客戶接受或拒絕報價事件的建立
const { startNotificationWorker } = require('./notification-worker'); // 統一通知系統批次：Email／LINE非同步派送背景工作

const app  = express();
const port = process.env.PORT || 3000;

// ─── 反向代理信任跳數（TRUST_PROXY_HOPS）──────────────────────────────
// 只能透過這個明確、範圍受限（0～3）的環境變數控制 Express 判斷「誰是真正的客戶端來源」時
// 要信任幾層反向代理回報的 X-Forwarded-For，不自行讀取或拆解任意 X-Forwarded-For 標頭字串
// ──否則使用者只要偽造這個標頭，就能讓 computeAiClientHash() 把自己算成別人，繞過每小時
// 使用次數限制。未設定或0＝完全不信任任何代理（目前是本機/localhost環境，適用這個預設值，
// req.ip 直接採用實際TCP連線來源）；之後部署到雲端反向代理（Railway／Render／Cloudflare等）
// 後方時，依實際代理層數設定成1～3。非整數、負數或超過3一律視為設定錯誤，直接讓伺服器啟動
// 失敗並印出明確的安全錯誤訊息，不用不安全的預設值悄悄放行。
const TRUST_PROXY_HOPS_RAW = process.env.TRUST_PROXY_HOPS;
let TRUST_PROXY_HOPS = 0;
if (TRUST_PROXY_HOPS_RAW !== undefined && TRUST_PROXY_HOPS_RAW !== '') {
  if (!/^\d+$/.test(TRUST_PROXY_HOPS_RAW) || parseInt(TRUST_PROXY_HOPS_RAW, 10) > 3) {
    console.error(`[安全設定錯誤] TRUST_PROXY_HOPS="${TRUST_PROXY_HOPS_RAW}" 不合法，只能是0～3的整數（0＝不信任任何代理），請確認實際部署的反向代理層數，伺服器拒絕啟動`);
    process.exit(1);
  }
  TRUST_PROXY_HOPS = parseInt(TRUST_PROXY_HOPS_RAW, 10);
}
app.set('trust proxy', TRUST_PROXY_HOPS);

// ─── 訂單資料夾／工廠下載包資料夾（部署前總驗收：單一永久資料根目錄批次）───────
// 改成呼叫集中式的 app-data-paths.js（跟 db.js 的 DB_DIR／BACKUP_DIR、admin-routes.js
// 的商品上傳圖片路徑共用同一份判斷邏輯），test 用 TEST_DB_DIR、production 用
// APP_DATA_DIR、development 維持修改前的舊路徑（上層 訂單資料／factory-packages），
// 不因這批修改而改變目前正式 3777 實際執行中（development 分支）的行為。
const { getOrderDir, getFactoryDir, getProductUploadDir } = require('./app-data-paths');
const ORDER_DIR = getOrderDir();
const FACTORY_DIR = getFactoryDir();

// ─── Helmet 必須掛載在 CORS 白名單中介層之前 ──────────────────────────────
// 下面的 CORS 中介層遇到 OPTIONS 請求時會直接 return res.sendStatus(204) 提前結束回應，
// 如果 Helmet 掛在 CORS 之後，OPTIONS 請求永遠不會執行到 Helmet，導致預檢請求缺少
// X-Content-Type-Options／X-Frame-Options／CSP Report-Only 等安全標頭、也不會移除
// X-Powered-By。Express 中介層是按掛載順序依序執行，所以讓 Helmet 一律先設定好安全標頭，
// 之後不論 CORS 中介層是放行還是提前用 sendStatus(204) 結束，已經設定好的標頭都會留在
// 回應裡，不需要在 OPTIONS 分支另外手動補標頭。
// ─── Helmet 安全標頭＋CSP Report-Only（第一階段）─────────────────────────
// 這批只建立安全標頭基礎與CSP「觀察」結果，刻意不直接套用會封鎖資源的正式CSP——先用
// Content-Security-Policy-Report-Only 蒐集違規報告，確認清單完整、不會誤傷現有功能後，
// 下一階段才考慮切成真正強制的 Content-Security-Policy。
//
// 來源清單是逐一盤點過整個專案（前台landing.html／index.html／quote-*.html，後台admin.html
// 與後台系統/*.html共9頁）之後才列出來的，不是憑印象猜測：
// - script-src：全部<script>都是同源相對路徑（含js/vendor/fabric.min.js、three.min.js兩個
//   vendored第三方函式庫，都是專案內自己保存的檔案，不是從CDN載入），沒有任何外部網域，
//   所以只需要 'self'。
// - style-src／font-src：除了同源的css/*.css外，多個頁面用<link>引入Google
//   Fonts（fonts.googleapis.com提供CSS、實際字型檔由fonts.gstatic.com提供），這是唯一用到
//   的外部資源。
// - img-src：商品設計預覽（canvas轉data:圖片）、Excel/CSV匯出下載（blob: URL）都會用到，
//   一定要保留 data: 與 blob:，否則預覽圖與匯出下載會直接壞掉。
// - connect-src：搜尋過所有前端fetch()呼叫，全部都是同源相對路徑的/api/...，OpenAI相關的
//   4支AI功能（黑卡圖案／Q版卡通化等）都是伺服器端呼叫OpenAI SDK，瀏覽器完全不會直接連線
//   到api.openai.com，所以 connect-src 只需要 'self'，不需要額外開放任何外部網域。
// - frame-src：landing.html／index.html的「小竹AI客服」用<iframe>嵌入外部Railway服務
//   （網址來自下面動態讀取的CHATBOT_PUBLIC_URL環境變數，不是寫死），這是唯一需要嵌入其他
//   網域的地方。
// - object-src 'none'／base-uri 'self'／form-action 'self'：這3個是常見防護基本盤，這個
//   專案完全沒有用到<object>/<embed>，也沒有任何合理理由需要送出表單到別的網域，設成最嚴格
//   值不會影響任何現有功能。
//
// 已知會被Report-Only回報大量「違規」的既有寫法（這批刻意不動，等下一階段CSP真的要強制生效
// 前才需要處理，詳細數量已整理進後台筆記）：全站大量使用行內onclick等事件屬性、部分行內
// <script>區塊（多半是頁面初始化呼叫或第三方函式庫的小補丁）、大量行內style屬性。這些現在
// 都還能正常運作，只是Report-Only模式下瀏覽器主控台／回報端點會標記成「如果真的套用CSP會被
// 擋下」，不影響目前任何功能。
let _cspChatbotOrigin = null;
try {
  const chatbotUrlForCsp = (process.env.CHATBOT_PUBLIC_URL || '').trim();
  if (chatbotUrlForCsp) _cspChatbotOrigin = new URL(chatbotUrlForCsp).origin;
} catch { _cspChatbotOrigin = null; } // 網址格式異常時安全退回null，不影響其餘標頭設定

// ─── CSP 正式化開關（正式部署環境準備）────────────────────────────────
// 預設（未設定 CSP_ENFORCE，或設定成非 'true' 的任何值）維持 Report-Only，這是安全的
// 預設值：全站目前還大量依賴行內 onclick 屬性／行內 style／少數行內 <script> 區塊
// （index.html 實測 93 處 onclick、76 處行內 style、4 個行內 <script> 區塊，landing.html
// 另有 13 處 onclick），這批目前完全沒有處理，真的切成強制模式會直接讓大量按鈕失效。
// 只有明確設定 CSP_ENFORCE=true 才會切成真正會擋資源的強制模式，且刻意跟 NODE_ENV 脫鉤——
// 可以先在非 production 環境開著測試會不會誤傷任何功能，確認沒問題後才在 production 打開，
// 不強迫兩者綁在一起切換。開下去之前務必先完成一次完整瀏覽器回歸（首頁／配置器／AI生圖／
// 3D預覽／客服iframe），見 DEPLOYMENT.md 的檢查清單。
const CSP_ENFORCE = process.env.CSP_ENFORCE === 'true';
if (CSP_ENFORCE) {
  console.warn('[CSP] CSP_ENFORCE=true，Content-Security-Policy 已切換為強制模式（非 Report-Only）。若全站行內 onclick／inline style／inline script 尚未完成遷移，會有功能被瀏覽器擋下的風險。');
}

app.use(helmet({
  // CSP本身另外用reportOnly控制是否強制套用，不使用helmet內建的CSP預設清單
  // （useDefaults:false）——預設清單是helmet自己維護的一般化建議，跟這個專案實際盤點過的
  // 來源不一定一致，全部自己明確列出，才不會有「以為套用了、實際上沒套用」或反過來
  // 「不小心套用了沒盤點過的規則」的落差。
  contentSecurityPolicy: {
    useDefaults: false,
    reportOnly: !CSP_ENFORCE,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'"],
      frameSrc: _cspChatbotOrigin ? ["'self'", _cspChatbotOrigin] : ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  // HSTS要求瀏覽器記住「這個網域之後一律只能用HTTPS連線」，本機/localhost開發與測試環境
  // 都還是走HTTP，一旦不小心啟用，瀏覽器會直接攔截接下來所有http://localhost的測試連線，
  // 所以先關閉，等未來正式部署到有HTTPS的網域再另外處理，不可以在這個階段開啟。
  hsts: false,
  // Cross-Origin-Embedder-Policy若採用helmet預設的require-corp，會要求所有跨來源資源
  // （包含小竹AI客服的Railway iframe）都要回應正確的Cross-Origin-Resource-Policy標頭才能
  // 載入——Railway那個服務不是這個專案維護、無法保證會回應相容的標頭，貿然開啟會直接讓客服
  // 視窗整個載入失敗，這裡先關閉。
  crossOriginEmbedderPolicy: false,
  // Cross-Origin-Resource-Policy若採用helmet預設的same-origin，會限制「其他網域可不可以
  // 跨來源讀取這台伺服器的資源」（例如商品圖片、上傳的設計圖）。指示要求先確認不會影響現有
  // 功能才能套用，這批還沒有逐一確認過是否有任何合理的跨來源讀取情境（例如分享連結預覽圖），
  // 為了不冒然打斷現有功能，這批先關閉，列入下一階段調查項目。
  crossOriginResourcePolicy: false
}));

// ─── CORS 白名單（取代原本 app.use(cors()) 完全開放任何來源）───────────────
// 同源請求（瀏覽器沒有帶 Origin，或 Origin 剛好等於這台伺服器自己）本來就不受 CORS 限制，
// 一律放行；只有「其他來源」才需要出現在 ADMIN_ALLOWED_ORIGINS（逗號分隔）才會拿到
// Access-Control-Allow-Origin／Access-Control-Allow-Credentials，瀏覽器才允許該來源的
// JavaScript 讀取回應內容。未設定 ADMIN_ALLOWED_ORIGINS 時預設等同「只允許同源」，不是
// 「全部放行」──必須明確列出才能通過，這是這次要修正的重點（沿用既有規則：不允許
// Origin:* 搭配Cookie憑證）。沒有 Origin 表頭的請求（健康檢查、伺服器對伺服器、同源導覽）
// 不受 CORS 規範管轄，直接放行，不額外附加任何 CORS 表頭。
const ADMIN_ALLOWED_ORIGINS = (process.env.ADMIN_ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);
function isOriginAllowedForCors(origin, req) {
  const selfOrigin = `${req.protocol}://${req.get('host')}`;
  if (origin === selfOrigin) return true;
  return ADMIN_ALLOWED_ORIGINS.includes(origin);
}
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && isOriginAllowedForCors(origin, req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── 維護模式（正式資料庫還原安全機制）───────────────────────────────
// 正式還原會直接置換 admin.db 與正式訂單資料夾檔案，這段期間必須擋下所有可能同時讀寫這些
// 檔案的請求，避免半套資料。允許清單只留「確認伺服器活著」「登入／查詢登入狀態」「查詢
// 維護狀態本身」三種完全不會碰資料庫或訂單檔案的端點，其餘所有 /api/ 開頭的請求（含公開
// 前台的送出詢價 /api/save-order、AI功能、後台全部路由）在維護模式期間一律回503，不逐一
// 列舉「哪些寫入端點要擋」——那種做法永遠可能漏掉新增的端點，改成「預設全部擋、白名單放行
// 少數幾個」才是安全預設值。放在CORS之後、其餘所有API路由之前，確保攔截發生在任何實際
// 業務邏輯執行之前。
const { isMaintenanceMode, getMaintenanceInfo } = require('./maintenance-mode');
const MAINTENANCE_MODE_ALLOWLIST = new Set(['/api/health', '/api/admin/session', '/api/admin/maintenance-status']);
app.use('/api', (req, res, next) => {
  // 注意：掛載在 app.use('/api', ...) 底下時，req.path 會被Express自動去掉 /api 這段掛載
  // 前綴（例如實際請求 /api/health，這裡的req.path只會是 /health），比對白名單一定要用
  // req.originalUrl（完整原始路徑，不受掛載點影響，沿用deriveAdminAuditResource()同一套
  // 「一律用originalUrl取完整路徑」慣例），不能直接用req.path，否則白名單永遠比對不到，
  // 維護模式期間連查詢維護狀態本身的端點都會被自己擋下。
  const fullPath = req.originalUrl.split('?')[0];
  if (!isMaintenanceMode() || MAINTENANCE_MODE_ALLOWLIST.has(fullPath)) return next();
  const info = getMaintenanceInfo();
  res.status(503).json({ error: info.maintenanceReason || '系統維護中，請稍後再試', maintenanceSince: info.maintenanceSince });
});
app.get('/api/admin/maintenance-status', (req, res) => res.json(getMaintenanceInfo()));

// /api/analytics/events 必須用比全域30mb嚴格得多的20KB請求上限（公開端點，防止被拿來塞入
// 大量垃圾資料），一定要在全域 express.json() 之前註冊專屬的小上限body parser——否則全域的
// 30mb會先把整個請求body解析完才輪到這支路由檢查，屆時「20KB上限」只是裝飾用的假上限。
// express.json() 本身是用「實際串流位元組數」判斷是否超過limit，不是看Content-Length標頭，
// 所以就算請求沒有帶Content-Length、或用chunked傳輸，一樣會被正確擋下（見
// analyticsBodyParseErrorHandler／analyticsRateLimit／handleAnalyticsEventRequest 三個
// function宣告，定義在下方「分析事件基礎」章節，因為是function宣告，載入時已整個被提升到
// 最上層可用，跟這裡的註冊位置無關）。
app.post('/api/analytics/events', analyticsRateLimit, express.json({ limit: '20kb' }), analyticsBodyParseErrorHandler, handleAnalyticsEventRequest);

// 30mb：Q版卡通化上傳照片本地驗證上限為20MB（配合OpenAI Moderation API的圖片輸入上限），
// Base64編碼後體積約膨脹1.33倍（20MB*4/3≈26.7MB），JSON body上限必須留有餘裕才能讓20MB的
// 照片真的送得到路由本身的驗證邏輯，否則body parser會在route處理之前就先用413擋下，讓
// 「20MB」這個提示文字變成實際上達不到的假上限。
app.use(express.json({ limit: '30mb' }));  // 設計圖／照片 dataURL 可能較大

// ─── 公開靜態資源白名單（登入與憑證傳輸安全批次修正）───────────────────────
// 原本 app.use(express.static(path.join(__dirname), { index: false })) 把整個專案目錄掛成
// 靜態伺服器根目錄，Codex獨立複驗實測未登入即可直接下載 server.js／db.js／admin-routes.js／
// package.json，以及隔離測試模式下的 data/admin.db、factory-packages/*，等同繞過所有登入
// 保護直接外洩原始碼與資料庫。改成只掛載前台/後台頁面真正需要公開的3個資料夾——不是用
// 黑名單擋幾個已知路徑（那種做法永遠可能漏掉新增的機敏檔案，例如專案裡大量一次性
// _tmp_*.js 測試腳本），而是只開放明確盤點過、確定只包含樣式/前端程式/圖片素材的資料夾。
// 伺服器原始碼、.env、資料庫、訂單資料、工廠包一律不在白名單內，不可能透過HTTP直接下載；
// 訂單只能透過受登入保護的API讀取，工廠包只能透過既有、需登入的factory-package API下載。
app.use('/css', express.static(path.join(__dirname, 'css'), { index: false }));
app.use('/js', express.static(path.join(__dirname, 'js'), { index: false }));
// 商品上傳圖片（部署前總驗收：單一永久資料根目錄批次）：實體檔案改存到 getProductUploadDir()
// 解析出的路徑（production／test 在資料根目錄底下，development 沿用原本的
// assets/uploads/products），但既有 /assets/uploads/products/檔名 這個對外網址格式維持不變
// ——這條更明確的路徑必須註冊在下面 /assets 這條較籠統的靜態掛載「之前」，Express 依註冊
// 順序比對路由，才會先命中這裡、從正確（可能已搬到資料根目錄）的實體路徑讀檔，而不是被下面
// /assets 攔下、去讀專案內已經不存在實體檔案的舊路徑。只公開這一個子路徑，資料庫、訂單、
// 工廠包、備份資料完全不在任何靜態掛載範圍內。
app.use('/assets/uploads/products', express.static(getProductUploadDir(), { index: false }));
app.use('/assets', express.static(path.join(__dirname, 'assets'), { index: false }));

// ─── 頁面路由 ──────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/customize', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
// 下面4個明確頁面路由取代原本靠「檔名剛好等於URL路徑」被express.static意外服務的行為：
// /landing.html／/index.html 是既有 js/analytics-tracker.js 的 PAGE_PATH_WHITELIST 明確承認
// 的合法頁面路徑；/quote-confirmation.html 是寄給客戶的報價確認連結實際使用的網址
// （見 admin.html 產生連結那段程式碼）；/quote-print.html 是後台報價單列印視窗
// window.open('quote-print.html', ...) 實際導覽到的網址。
app.get('/landing.html', (req, res) => res.sendFile(path.join(__dirname, 'landing.html')));
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/quote-confirmation.html', (req, res) => res.sendFile(path.join(__dirname, 'quote-confirmation.html')));
app.get('/quote-print.html', (req, res) => res.sendFile(path.join(__dirname, 'quote-print.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/admin/products',  (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'products.html')));
app.get('/admin/dashboard', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'dashboard.html')));
app.get('/admin/customers', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'customers.html')));
app.get('/admin/site-settings', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'site-settings.html')));
app.get('/admin/system-settings', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'system-settings.html')));
app.get('/admin/ai-settings', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'ai-settings.html')));
app.get('/admin/ai-usage', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'ai-usage.html')));
app.get('/admin/analytics', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'analytics.html')));
app.get('/admin/users', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'users.html')));
app.get('/admin/audit', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'audit.html')));
app.get('/admin/db-backup', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'db-backup.html')));
app.get('/admin/notifications', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'notifications.html')));
app.get('/admin/notification-settings', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'notification-settings.html')));
app.get('/admin/coming-soon', (req, res) => res.sendFile(path.join(__dirname, '後台系統', 'coming-soon.html')));

// 後台頁面網址是 /admin/products（無結尾斜線），頁面內用相對路徑（如 admin-common.js、../js/xxx.js）
// 引用資源時，瀏覽器會解析成 /admin/xxx，不是實際檔案所在的 後台系統/xxx。放在上面幾個明確頁面路由
// 之後才掛載，確保 /admin、/admin/products 等頁面路徑一律先被上面的明確路由處理，不會被這裡的
// 靜態目錄攔截造成非預期的 301（尾端斜線）重導向；只用來補上 admin-common.js 等資源檔案的路徑。
app.use('/admin', express.static(path.join(__dirname, '後台系統'), { index: false, redirect: false }));

// ─── 公開商品 API（前台用，只回傳上架中商品；後台完整清單走 /api/admin/products）──
// 公開欄位白名單：只列出前台真的會用到的欄位，明確排除 createdAt/updatedAt 這類後台
// 管理用的時間戳記，以及庫存、成本等從未存在於這個物件上的內部資料。用白名單（而非
// 從完整物件刪除欄位）是為了避免未來 rowToProduct() 新增欄位時，忘記從公開回應裡剔除。
const PUBLIC_PRODUCT_FIELDS = [
  'id', 'name', 'nameEn', 'status', 'sortOrder',
  'icon', 'image', 'bgImage', 'badge', 'badgeColor', 'description',
  'size', 'displaySize', 'labelArea', 'textLayout',
  'materials', 'finishes', 'capacities', 'qtyBreaks', 'cupColors',
  'minQty', 'leadDays', 'color', 'textOnly',
  'priceOnInquiry', 'materialLabel', 'finishLabel', 'svgViewBox', 'svgPath'
];

function toPublicProduct(product) {
  const out = {};
  PUBLIC_PRODUCT_FIELDS.forEach(key => { out[key] = product[key]; });
  return out;
}

app.get('/api/products', (req, res) => {
  try {
    res.json({ success: true, products: getActiveProducts().map(toPublicProduct) });
  } catch (err) {
    console.error('[api/products]', err.message);
    res.status(500).json({ error: '商品資料讀取失敗' });
  }
});

app.get('/api/products/:id', (req, res) => {
  try {
    const product = getProductById(req.params.id);
    if (!product || product.status !== 'active' || product.archivedAt) {
      return res.status(404).json({ error: '找不到此商品，或此商品目前未上架，請洽業務確認' });
    }
    res.json({ success: true, product: toPublicProduct(product) });
  } catch (err) {
    console.error('[api/products/:id]', err.message);
    res.status(500).json({ error: '商品資料讀取失敗' });
  }
});

// ─── 公開網站設定 API（前台用，唯讀）─────────────────────────
// 只回傳允許公開顯示的欄位子集，明確排除 updated_at／updated_by／id 這類後台管理資訊，
// 用白名單（逐一列出欄位）而不是整列回傳，避免未來 site_settings 新增管理用欄位時忘記排除。
app.get('/api/site-settings', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
    const settings = row
      ? {
          announcementEnabled: !!row.announcement_enabled,
          announcementText: row.announcement_text,
          contactEmail: row.contact_email,
          contactPhone: row.contact_phone,
          footerText: row.footer_text
        }
      : { announcementEnabled: false, announcementText: '', contactEmail: '', contactPhone: '', footerText: '' };
    res.json({ success: true, settings });
  } catch (err) {
    console.error('[api/site-settings]', err.message);
    res.status(500).json({ error: '網站設定讀取失敗' });
  }
});

// ─── 客服（小竹）公開設定 + 健康檢查 ─────────────────────────
// 網址一律只從伺服器自己的環境變數讀取，前端／使用者沒有任何管道指定要檢查的網址，
// 不會有 SSRF 風險；這裡也只回傳網址本身，絕不夾帶其他環境變數或 API Key。
const CHATBOT_PUBLIC_URL = (process.env.CHATBOT_PUBLIC_URL || '').trim();

app.get('/api/chatbot-config', (req, res) => {
  res.json({ chatbotUrl: CHATBOT_PUBLIC_URL || null });
});

// 5~8秒逾時＋30秒短期快取：客服視窗每次開啟都會打這支API，沒有快取的話等於
// 使用者每點一次「小竹客服」就幫Railway多打一次健康檢查，快取讓短時間內重複
// 開關視窗不會真的重複發出遠端請求。
const CHATBOT_STATUS_TIMEOUT_MS = 6000;
const CHATBOT_STATUS_CACHE_MS = 30000;
let _chatbotStatusCache = { ts: 0, available: false };

app.get('/api/chatbot-status', async (req, res) => {
  if (!CHATBOT_PUBLIC_URL) {
    return res.json({ available: false });
  }
  const now = Date.now();
  if (now - _chatbotStatusCache.ts < CHATBOT_STATUS_CACHE_MS) {
    return res.json({ available: _chatbotStatusCache.available, cached: true });
  }
  let available = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHATBOT_STATUS_TIMEOUT_MS);
    try {
      const resp = await fetch(CHATBOT_PUBLIC_URL, { signal: controller.signal });
      // 只有 HTTP 2xx 算可用；404／5xx／重導向到錯誤頁等都落在 resp.ok===false，
      // DNS 解析失敗、連線被拒、逾時中止則會直接丟例外，一律歸類為不可用。
      available = resp.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    available = false;
  }
  _chatbotStatusCache = { ts: now, available };
  res.json({ available });
});

// ─── OpenAI 初始化（Key 可選，無 Key 時 AI 功能停用）──────────
let openai = null;
if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.startsWith('sk-xxx')) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── 部署前環境變數檢查（正式部署環境準備）───────────────────────────────
// 只印出「缺少哪個變數名稱」，絕對不印出任何變數的實際內容（本檔案其餘地方也一律遵守
// 這個原則，搜尋 console.log/console.warn/console.error 不會找到任何一處直接印出
// OPENAI_API_KEY／ADMIN_TOKEN／ADMIN_CSRF_SECRET 等機密變數的值）。
//
// 下面三組分類是實際讀過程式碼行為之後才分出來的，不是照抄一份「看起來合理」的清單：
// - OPENAI_API_KEY：openai 變數在上面已經處理過「未設定就維持 null」，四支 AI 路由
//   （見 if (!openai) 判斷）本來就會在未設定時回傳清楚的錯誤訊息、不會讓伺服器整個掛掉；
//   後台也有獨立的「AI 功能設定」開關可以個別停用 AI 功能。所以這個變數影響的是「AI 生圖
//   功能能不能用」，不是「伺服器能不能啟動」，歸類在「功能性、缺少會降級」。
// - ADMIN_TOKEN：只有在 admin_users 資料表完全是空的（全新安裝、第一次啟動）時才會被拿來
//   建立第一位管理員帳號（見 db.js 的 bootstrapAdminOwnerIfEmpty()）；只要資料庫裡已經有
//   任何一位啟用中的 owner，這個變數之後完全不會被讀取。所以在「已經有管理員帳號」的環境
//   （例如重新部署、換一台主機但接同一份資料庫）不需要它；只有「全新安裝且還沒有任何管理員」
//   時才是真正卡住整個後台無法使用的情況，這裡只在這個明確組合下才會拒絕啟動。
// - ADMIN_CSRF_SECRET：未設定時已經有安全的自動 fallback（啟動時隨機產生一把僅限本次執行
//   期間使用的密鑰，見下面 ADMIN_CSRF_SECRET 常數定義），可以正常運作，只是伺服器重啟後
//   所有人需要重新登入。影響的是「重啟後要不要重新登入」，不是「能不能啟動」，歸類在建議
//   設定、不強制。
const REQUIRED_ENV_VAR_NOTES = {
  OPENAI_API_KEY:     'AI 生圖／AI 文字設計功能會停用，其餘網站功能（客製化、報價、詢價、預覽）不受影響',
  ADMIN_TOKEN:        '只在後台管理員帳號完全是空的（全新安裝）時才會被用來建立第一位管理員；已有管理員帳號的環境不受影響',
  ADMIN_CSRF_SECRET:  '伺服器每次重啟會換一把暫時密鑰，所有既有後台登入需要重新登入；不影響伺服器啟動'
};
const CONDITIONAL_ENV_VAR_NOTES = {
  CHATBOT_PUBLIC_URL:         '未設定時小竹客服視窗會顯示「維護中」備援畫面，不會壞掉',
  // 統一通知系統批次：SMTP_HOST／SMTP_USER／SMTP_PASSWORD／NOTIFICATION_EMAIL_FROM／
  // NOTIFICATION_EMAIL_TO任一缺少就視為Email通知尚未設定（見notification-channels.js的
  // isEmailConfigured()），這裡只列host當代表，避免五個變數各自重複一次提示；未設定完全
  // 不影響伺服器啟動或詢價／訂單等主要功能，只是Email通知的傳送工作會被標記為
  // abandoned／error_category:'config_missing'，後台通知設定頁會清楚顯示「Email尚未設定」。
  SMTP_HOST:                  '未設定（或缺少SMTP_USER／SMTP_PASSWORD／NOTIFICATION_EMAIL_FROM／NOTIFICATION_EMAIL_TO任一項）時Email通知不會寄出，其餘功能不受影響，後台通知設定頁會顯示「尚未設定」',
  LINE_CHANNEL_ACCESS_TOKEN:  '未設定（或缺少LINE_NOTIFICATION_TARGET_ID）時LINE通知不會推播，其餘功能不受影響，後台通知設定頁會顯示「尚未設定」；舊版LINE Notify（LINE_NOTIFY_TOKEN）已停止服務，不再支援',
  ADMIN_ALLOWED_ORIGINS:      '未設定時後台 API 只接受同源請求（預設最嚴格，通常本來就不需要設定）',
  ADMIN_COOKIE_SECURE:        '未設定時依請求是否為 HTTPS 自動判斷，通常不需要手動設定',
  TRUST_PROXY_HOPS:           '未設定時預設 0（不信任任何代理）；已有獨立格式驗證，設定錯誤會直接拒絕啟動（見上方）'
};
function runStartupEnvironmentCheck() {
  const isProduction = process.env.NODE_ENV === 'production';
  const missingRequired = Object.keys(REQUIRED_ENV_VAR_NOTES).filter(name => !process.env[name] || !process.env[name].trim());
  const missingConditional = Object.keys(CONDITIONAL_ENV_VAR_NOTES).filter(name => !process.env[name] || !process.env[name].trim());

  if (missingRequired.length) {
    console.warn(`[環境變數檢查] 未設定：${missingRequired.join('、')}`);
    missingRequired.forEach(name => console.warn(`  - ${name}：${REQUIRED_ENV_VAR_NOTES[name]}`));
  }
  if (missingConditional.length) {
    console.log(`[環境變數檢查] 視功能啟用時才需要，目前未設定：${missingConditional.join('、')}`);
  }

  // 唯一真正會拒絕啟動的組合：production 環境、資料庫裡沒有任何啟用中的 owner、又沒有
  // ADMIN_TOKEN 可以建立第一位——這代表這個 production 部署上線後不會有任何人能登入後台，
  // 不是「為了符合檢查清單」而擋，是真的會造成無法使用。
  if (isProduction && !process.env.ADMIN_TOKEN) {
    let ownerCount = 0;
    try { ownerCount = countActiveOwners(); } catch (e) { console.error('[環境變數檢查] 無法確認現有管理員帳號數量：', e.message); }
    if (ownerCount === 0) {
      console.error('[環境變數檢查] production 環境下沒有任何啟用中的管理員帳號，且未設定 ADMIN_TOKEN，將無法建立第一位管理員、也無法登入後台，伺服器拒絕啟動。請設定 ADMIN_TOKEN 後重新啟動，或改用已有資料庫匯入既有管理員帳號。');
      process.exit(1);
    }
  }

  // FORM_TEST_MODE 絕對不能出現在 production：這個檢查本身已經移到 db.js 最上方
  // （require('./db') 是本檔案第一個會執行的 require，比這裡任何程式碼都早跑），
  // 目的是在「連正式資料庫檔案都還沒打開」之前就先擋下這個危險組合，避免測試腳本
  // 用 NODE_ENV=production 驗證這個防線時意外先碰到真實的 ./data/admin.db。這裡不用
  // 重複判斷一次——如果走到這行，代表 db.js 那關已經通過，這個組合此時一定不成立。
}
runStartupEnvironmentCheck();

// ─── 產品中文名對照 ────────────────────────
const PRODUCT_NAMES = {
  easycard:   '客製化悠遊卡',
  ipass:      '客製化一卡通',
  usb_bar:    'USB 隨身碟',
  thermos:    '客製化保溫杯',
  usb_card:   '名片型隨身碟',
  black_card: '尊爵不凡黑卡'
};

// ─── 後台登入 Session 與 CSRF 防護（登入與憑證傳輸安全批次）─────────────────
// 取代原本「管理密碼存在瀏覽器 localStorage、每次 API 呼叫用 x-admin-token 標頭或 ?token=
// 網址參數傳送」的做法：ADMIN_TOKEN 只用來驗證登入當下輸入的密碼，登入成功後絕對不會回傳
// 給瀏覽器；瀏覽器只會拿到一個隨機、不透明、無法反推回密碼的 Session ID（存在 HttpOnly
// Cookie，JavaScript 讀不到），伺服器端資料庫也只保存 Session ID 與 CSRF Token 的雜湊
// （見 db.js 的 admin_sessions 資料表），不保存任何原始值。

// Session 存活時間（小時）：只能是正數，格式錯誤時安全退回預設值8小時，不可以讓後台永久
// 不過期（那等於沒有登入逾期機制）。
const ADMIN_SESSION_TTL_HOURS = (() => {
  const raw = Number(process.env.ADMIN_SESSION_TTL_HOURS);
  return (Number.isFinite(raw) && raw > 0) ? raw : 8;
})();
const ADMIN_SESSION_COOKIE_NAME = 'yz_admin_sid';

// 手動解析 Cookie 表頭，不另外安裝 cookie-parser 套件（專案目前刻意維持精簡依賴清單，
// 這裡的解析邏輯簡單、範圍固定，不需要引入整個套件）。
function parseCookies(req) {
  const header = req.headers.cookie;
  const map = {};
  if (!header) return map;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) { try { map[key] = decodeURIComponent(val); } catch (e) { map[key] = val; } }
  });
  return map;
}

// Cookie 的 Secure 屬性（只能透過HTTPS傳送）：優先看明確的 ADMIN_COOKIE_SECURE 環境變數
// （'true'／'false'），沒有明確設定時才依 req.secure 判斷（尊重 app.set('trust proxy', ...)
// 對 X-Forwarded-Proto 的解讀，部署到雲端反向代理後方時通常不需要手動設定這個變數）。
// 刻意不能只用 NODE_ENV 判斷——本機 NODE_ENV=production 測試模式仍然是走HTTP，若寫死
// Secure=true 會讓Cookie在本機測試環境完全無法用來登入。
function isAdminCookieSecure(req) {
  const override = (process.env.ADMIN_COOKIE_SECURE || '').trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return !!req.secure;
}
function setAdminSessionCookie(req, res, rawSessionId, maxAgeMs) {
  const parts = [
    `${ADMIN_SESSION_COOKIE_NAME}=${encodeURIComponent(rawSessionId)}`,
    'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];
  if (isAdminCookieSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearAdminSessionCookie(req, res) {
  const parts = [`${ADMIN_SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isAdminCookieSecure(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// 只保存雜湊，不保存原始 Session ID／CSRF Token／密碼本身（跟既有
// computeAnalyticsIdentifierHash() 同一套「伺服器端只留雜湊」的安全考量）。
function hashAdminSecret(rawValue) {
  return crypto.createHash('sha256').update(rawValue).digest('hex');
}
// 固定時間安全比較：先各自算成固定長度的SHA-256雜湊再比較，避免直接比較不同長度的原始
// 字串時，字串比較本身的提早結束時間差異洩漏「猜對前幾個字元」的資訊（timing attack）。
function timingSafeEqualStrings(a, b) {
  const ah = Buffer.from(hashAdminSecret(a), 'hex');
  const bh = Buffer.from(hashAdminSecret(b), 'hex');
  return crypto.timingSafeEqual(ah, bh);
}

const insertAdminSession = db.prepare(`
  INSERT INTO admin_sessions (session_id_hash, csrf_token_hash, created_at, expires_at, last_seen_at, admin_user_id)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const findAdminSessionByHash = db.prepare(`SELECT * FROM admin_sessions WHERE session_id_hash = ?`);
const deleteAdminSessionByHash = db.prepare(`DELETE FROM admin_sessions WHERE session_id_hash = ?`);
const deleteExpiredAdminSessionsStmt = db.prepare(`DELETE FROM admin_sessions WHERE expires_at < ?`);

// 過期 Session 清理：每次登入或查詢登入狀態時順便清一次，不需要另外維護排程任務。
function cleanupExpiredAdminSessions() {
  try { deleteExpiredAdminSessionsStmt.run(new Date().toISOString()); }
  catch (err) { console.error('[admin-session] 清理過期Session失敗：', err.message); }
}
cleanupExpiredAdminSessions();

// 從請求的Cookie找出目前有效的Session（不存在、找不到、或已過期都回傳null，過期的順便刪除）；
// 同時回傳原始Session ID（raw），供下面CSRF Token用HMAC重新計算比對，不是查表取用。
function getValidAdminSession(req) {
  const raw = parseCookies(req)[ADMIN_SESSION_COOKIE_NAME];
  if (!raw) return null;
  const hash = hashAdminSecret(raw);
  const row = findAdminSessionByHash.get(hash);
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    deleteAdminSessionByHash.run(hash);
    return null;
  }
  return { hash, raw, row };
}

// ─── CSRF Token：HMAC(密鑰, 原始SessionID)，同一個Session永遠算出同一組Token ─────────
// Codex獨立複驗發現的缺陷：先前版本每次呼叫 GET /api/admin/session 都會隨機產生一組新
// CSRF Token並覆蓋資料庫裡的舊雜湊，導致同一個Session只要開第二個後台分頁（分頁B呼叫
// GET /session取得新Token），第一個分頁（分頁A）手上還拿著舊Token的所有修改操作立刻全部
// 回403——CSRF Token被誤設計成「只能有一份最新、其餘全部失效」，但實際使用情境本來就允許
// 同一次登入下開多個分頁。改用HMAC簽章：Token = HMAC-SHA256(ADMIN_CSRF_SECRET, 原始SessionID)，
// 純函式、不需要查資料庫也不需要寫入資料庫，同一個Session不論查詢幾次、開幾個分頁，算出來
// 的Token永遠相同，天生就能被多個分頁同時使用；不同Session的原始ID不同，算出來的Token
// 也一定不同，不會互相通用。ADMIN_CSRF_SECRET跟登入密碼(ADMIN_TOKEN)是兩把完全獨立的
// 密鑰，刻意不共用、也不能用其中一把推算出另一把——即使CSRF密鑰外洩，也不能拿來當登入密碼
// 使用，反之亦然。未在.env設定時，退回啟動當下才產生的隨機密鑰（僅存在於這次執行的記憶體，
// 重啟伺服器會換一把新的，屆時所有舊Session的CSRF Token會需要重新登入才能拿到用新密鑰算出
// 的正確值——這是可以接受的邊界情況，換取「不強迫管理員手動設定就無法啟動」的彈性），並印出
// 明確提醒建議在.env設定固定值，確保伺服器重啟不會意外讓所有分頁的CSRF Token同時失效。
const ADMIN_CSRF_SECRET = (() => {
  const fromEnv = (process.env.ADMIN_CSRF_SECRET || '').trim();
  if (fromEnv) return fromEnv;
  console.warn('[admin-session] 未設定 ADMIN_CSRF_SECRET，暫時使用僅存在於這次執行期間的隨機密鑰；伺服器重啟後所有既有Session需要重新登入才能取得新的CSRF Token，建議在.env設定一組固定值避免這個狀況');
  return crypto.randomBytes(32).toString('hex');
})();
function computeCsrfTokenForSession(rawSessionId) {
  return crypto.createHmac('sha256', ADMIN_CSRF_SECRET).update(rawSessionId).digest('hex');
}

// 登入端點本身還沒有Session可以綁定CSRF Token，改用嚴格Origin/Referer檢查＋CORS白名單防護，
// 不建立全站固定不變的CSRF Token（那等於變相繞過CSRF保護本身）。沒有Origin也沒有Referer的
// 請求（例如部分本機測試工具），只有在管理員尚未設定ADMIN_ALLOWED_ORIGINS（代表還沒有跨網域
// 風險意識、多半是本機開發階段）時才放行，一旦設定過白名單就必須明確符合，不能用「沒帶」
// 這種可以偽造的訊號繞過檢查。
function isAdminLoginOriginAllowed(req) {
  const selfOrigin = `${req.protocol}://${req.get('host')}`;
  const origin = req.headers.origin;
  if (origin) return origin === selfOrigin || ADMIN_ALLOWED_ORIGINS.includes(origin);
  const referer = req.headers.referer;
  if (referer) {
    try {
      const refOrigin = new URL(referer).origin;
      return refOrigin === selfOrigin || ADMIN_ALLOWED_ORIGINS.includes(refOrigin);
    } catch (e) { return false; }
  }
  return ADMIN_ALLOWED_ORIGINS.length === 0;
}

// ─── 後台驗證（保護 /api/orders、/api/admin/*，避免客戶個資公開外洩）──────────
// 只接受有效的 Session Cookie；x-admin-token 標頭與 ?token= 網址參數這兩種舊驗證方式
// 已經完全移除，不為了相容性保留（那會讓這次的安全修正沒有實際效果）。
// 正式管理員帳號、角色權限、登入限制與操作稽核批次：Session 現在必須明確歸屬到 admin_users
// 裡的一個帳號（見 admin_sessions.admin_user_id），這裡額外查出該帳號目前的角色／狀態，
// 附加到 req.adminUser 供後面的 requirePermission() 判斷權限。找不到對應帳號、或帳號已被
// 停用（可能在這個Session建立之後才被其他人停用），一律視同未登入，並順手刪除這筆已經
// 失效的Session——不需要等到自然過期，也不需要另外維護「帳號停用清單」跟Session的
// 交叉比對邏輯。
function checkAdminAuth(req, res, next) {
  const session = getValidAdminSession(req);
  if (!session) {
    return res.status(401).json({ error: '尚未登入或登入已逾期，請重新登入' });
  }
  const adminUser = session.row.admin_user_id ? findAdminUserById(session.row.admin_user_id) : null;
  if (!adminUser || adminUser.status !== 'active') {
    deleteAdminSessionByHash.run(session.hash);
    return res.status(401).json({ error: '尚未登入或登入已逾期，請重新登入' });
  }
  req.adminSessionHash = session.hash;
  req.adminSessionRawId = session.raw;
  req.adminUser = { id: adminUser.id, username: adminUser.username, displayName: adminUser.display_name, role: adminUser.role };
  next();
}

// ─── 操作稽核紀錄（正式管理員帳號、角色權限、登入限制與操作稽核批次）─────────────────
// 掛在需要checkAdminAuth的路由之後（req.adminUser此時一定已經設定好），只記錄「造成副作用」
// 的請求：POST／PUT／PATCH／DELETE，以及GET但是屬於下載工廠包的請求（工廠包下載屬於
// 「所有後台…及工廠包下載操作」明確要求要記錄的項目，雖然方法是GET）。用 res.on('finish')
// 而不是直接在這裡寫入，是因為這個時間點還不知道最終的res.statusCode／是否成功——要等到
// 回應真正送出後才能正確記錄result='success'或'failure'。寫入失敗只在伺服器端log，
// 不影響原本請求的回應內容或狀態碼。
function summarizeAdminAuditUserAgent(ua) {
  return (typeof ua === 'string' && ua) ? ua.slice(0, 150) : null;
}
function hashAdminAuditIp(ip) {
  return crypto.createHmac('sha256', ADMIN_CSRF_SECRET).update(`audit-ip:${ip || ''}`).digest('hex');
}
// changed_fields_json：只記錄「這次請求實際送出的欄位名稱」清單，不是欄位的值，也不是完整
// request body（2026-08-14 Codex獨立複驗指出原本完全沒有記錄異動欄位，已修正）。用
// Object.keys(req.body) 取得頂層欄位名稱——這是通用中介層能做到的合理粒度，不深入比對
// 資料庫裡實際變更前後的巢狀內容（那需要每支路由各自實作 before/after diff，超出這個
// 集中式中介層的職責範圍）。ADMIN_AUDIT_EXCLUDED_BODY_KEYS 是傳輸層欄位（CSRF Token一律
// 走X-CSRF-Token標頭、Session走Cookie，理論上不會出現在body裡，這裡僅作防禦性排除，避免
// 未來新增API不小心把這幾種欄位放進body時被誤記進changedFields)。密碼欄位（password／
// currentPassword）刻意「保留欄位名稱、不排除」——只記錄「password欄位已修改」這個事實
// （字串"password"本身不是機敏資料），密碼、雜湊、salt原始值從頭到尾不會被這支函式讀取
// 或記錄，因為這裡只取req.body的「鍵名」，從未讀取對應的「值」。
const ADMIN_AUDIT_EXCLUDED_BODY_KEYS = new Set(['csrfToken', 'cookie', 'sessionId', 'token']);
function deriveAdminAuditChangedFields(req) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return null;
  const keys = Object.keys(req.body).filter(k => !ADMIN_AUDIT_EXCLUDED_BODY_KEYS.has(k));
  return keys.length ? keys : null;
}
function deriveAdminAuditResource(req) {
  const p = req.originalUrl.split('?')[0];
  const paramValues = Object.values(req.params || {});
  const resourceId = paramValues.length ? String(paramValues[0]) : null;
  let resourceType = 'unknown';
  if (/^\/api\/orders\b/.test(p)) resourceType = 'order';
  else if (/^\/api\/admin\/upload-image\b/.test(p)) resourceType = 'product_image';
  else if (/^\/api\/admin\/products\b/.test(p)) resourceType = 'product';
  else if (/^\/api\/admin\/inventory\b/.test(p)) resourceType = 'inventory';
  else if (/^\/api\/admin\/stocktakes\b/.test(p)) resourceType = 'stocktake';
  else if (/^\/api\/admin\/low-stock-notifications\b/.test(p)) resourceType = 'low_stock_notification';
  else if (/^\/api\/admin\/customer-merges\b/.test(p)) resourceType = 'customer_merge';
  else if (/^\/api\/admin\/customer-tags\b/.test(p)) resourceType = 'customer_tag';
  else if (/^\/api\/admin\/customers\b/.test(p)) resourceType = 'customer';
  else if (/^\/api\/admin\/site-settings\b/.test(p)) resourceType = 'site_settings';
  else if (/^\/api\/admin\/ai-settings\b/.test(p)) resourceType = 'ai_settings';
  else if (/^\/api\/admin\/system-settings\b/.test(p)) resourceType = 'system_settings';
  else if (/^\/api\/admin\/users\b/.test(p)) resourceType = 'admin_user';
  else if (/^\/api\/admin\/db-backups\b/.test(p)) resourceType = 'db_backup';
  return { resourceType, resourceId, path: p };
}
function auditLogMiddleware(req, res, next) {
  const method = req.method;
  const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  // 工廠包下載、Excel匯出、資料庫備份下載都是GET但屬於資料取出動作，比照寫入操作留下稽核紀錄
  // （成功／失敗都算）。
  const isDownloadGet = method === 'GET' && (/\/factory-package$/.test(req.path) || /\/export$/.test(req.path) || /\/db-backups\/[^/]+\/download$/.test(req.path));
  if (!isWrite && !isDownloadGet) return next();
  res.on('finish', () => {
    // 正式資料庫還原路由（阻擋問題3修正）：一旦流程走到關閉正式SQLite連線那一步，這裡對
    // 已關閉連線寫入一定會失敗（The database connection is not open），該路由改用獨立連線
    // 自行寫入唯一一筆稽核（見admin-routes.js的writeRestoreAuditRecord），這裡明確跳過，
    // 避免對已關閉連線重複寫入、徒增錯誤訊息。
    if (req._adminAuditHandledExternally) return;
    try {
      const { resourceType, resourceId, path } = deriveAdminAuditResource(req);
      recordAdminAuditLog({
        actorUserId: req.adminUser ? req.adminUser.id : null,
        actorUsernameSnapshot: req.adminUser ? req.adminUser.username : null,
        action: `${method} ${path}`,
        resourceType,
        resourceId,
        result: res.statusCode < 400 ? 'success' : 'failure',
        httpStatus: res.statusCode,
        changedFields: isWrite ? deriveAdminAuditChangedFields(req) : null,
        ipHash: hashAdminAuditIp(req.ip),
        userAgentSummary: summarizeAdminAuditUserAgent(req.headers['user-agent'])
      });
    } catch (err) {
      console.error('[admin-audit] 寫入稽核紀錄失敗：', err.message);
    }
  });
  next();
}

// ─── CSRF 防護 ───────────────────────────────────────────────
// 只檢查會造成副作用的方法（POST／PUT／PATCH／DELETE）；GET／HEAD／OPTIONS 一律放行。
// 必須排在 checkAdminAuth 之後（需要 req.adminSessionRawId 才能用HMAC算出這個Session
// 正確的CSRF Token）。Session一旦登出或過期，checkAdminAuth會先回401，這裡完全不會被執行到，
// 不需要另外維護Token黑名單或額外的失效標記。
function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (!req.adminSessionRawId) {
    return res.status(401).json({ error: '尚未登入或登入已逾期，請重新登入' });
  }
  const provided = req.headers['x-csrf-token'];
  if (typeof provided !== 'string' || !provided) {
    return res.status(403).json({ error: 'CSRF Token 缺失，請重新整理頁面後再試' });
  }
  const expected = computeCsrfTokenForSession(req.adminSessionRawId);
  let providedBuf, expectedBuf;
  try {
    providedBuf = Buffer.from(provided, 'hex');
    expectedBuf = Buffer.from(expected, 'hex');
  } catch (e) {
    return res.status(403).json({ error: 'CSRF Token 不正確，請重新整理頁面後再試' });
  }
  if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
    return res.status(403).json({ error: 'CSRF Token 不正確，請重新整理頁面後再試' });
  }
  next();
}

// ─── 登入／登入狀態／登出：必須註冊在 checkAdminAuth 保護範圍之外 ───────────────
// （登入當下還沒有Session；查詢登入狀態與登出即使Session已經失效也要能正常回應，不能
// 變成先被401擋下才能運作）。三支端點都不經過 createAdminRouter（那個router整個掛在
// checkAdminAuth之後），直接掛在 app 上，且必須在下面 app.use('/api/admin', ...) 掛載之前
// 註冊，Express才會優先用這裡的處理常式，不會被router攔截。
// 這裡不再另外掛一層 express.json()：這支路由的註冊位置在全域 express.json({limit:'30mb'})
// 之後（見上方app.use()），全域parser對每個請求都會先執行一次，req.body在這裡已經可用，
// 重複掛第二層json()會嘗試重新讀取已經被消耗掉的請求串流，讀到空字串、把已經解析好的
// req.body覆蓋成{}，反而讓登入永遠失敗。
// 正式管理員帳號、角色權限、登入限制與操作稽核批次：登入改成 username＋password，不再只憑
// 單一 ADMIN_TOKEN 共用密碼。GENERIC_LOGIN_ERROR 統一用在「帳號不存在」與「帳號存在但密碼
// 錯誤」兩種情況，避免用不同錯誤訊息洩漏帳號是否存在；「帳號存在但密碼錯誤」與「帳號不存在」
// 都會執行一次相近成本的 scrypt 運算（見 verifyAdminPassword／verifyAdminPasswordAgainstDummy），
// 讓兩種情況的驗證耗時也接近，不會被拿來反推帳號是否存在。
const ADMIN_LOGIN_GENERIC_ERROR = '帳號或密碼錯誤，請重新輸入';

app.post('/api/admin/session', (req, res) => {
  if (!isAdminLoginOriginAllowed(req)) {
    return res.status(403).json({ error: '不允許的來源，請確認網址是否正確' });
  }
  const rawUsername = (req.body && typeof req.body.username === 'string') ? req.body.username : '';
  const password = (req.body && typeof req.body.password === 'string') ? req.body.password : '';
  const username = normalizeAdminUsername(rawUsername);
  const auditBase = { ipHash: hashAdminAuditIp(req.ip), userAgentSummary: summarizeAdminAuditUserAgent(req.headers['user-agent']) };

  if (!username || !password) {
    recordAdminAuditLog({ ...auditBase, actorUserId: null, actorUsernameSnapshot: username || null, action: 'POST /api/admin/session', resourceType: 'admin_session', resourceId: null, result: 'failure', httpStatus: 401 });
    return res.status(401).json({ error: ADMIN_LOGIN_GENERIC_ERROR });
  }

  // 登入限制：以「正規化username＋可信req.ip」組合計算節流身分，15分鐘內連續失敗5次鎖定
  // 15分鐘，鎖定狀態存在資料庫、伺服器重啟後仍有效。不論這個username是否對應真實帳號，
  // 都套用完全相同的節流邏輯，讓「是否出現鎖定」不會變成反推帳號是否存在的訊號。
  const identityHash = computeAdminLoginIdentityHash(ADMIN_CSRF_SECRET, username, req.ip);
  const lockState = getAdminLoginLockState(identityHash);
  if (lockState.locked) {
    recordAdminAuditLog({ ...auditBase, actorUserId: null, actorUsernameSnapshot: username, action: 'POST /api/admin/session', resourceType: 'admin_session', resourceId: null, result: 'failure', httpStatus: 429 });
    return res.status(429).json({ error: '登入嘗試次數過多，請稍後再試' });
  }

  const adminUser = findAdminUserByUsername(username);
  let passwordOk = false;
  if (adminUser && adminUser.status === 'active') {
    passwordOk = verifyAdminPassword(password, adminUser.password_salt, adminUser.password_hash);
  } else {
    verifyAdminPasswordAgainstDummy(password);
  }

  if (!passwordOk) {
    const { failCount, lockedUntil } = recordAdminLoginFailure(identityHash);
    if (adminUser) syncAdminUserLockDisplay(adminUser.id, failCount, lockedUntil);
    recordAdminAuditLog({ ...auditBase, actorUserId: adminUser ? adminUser.id : null, actorUsernameSnapshot: username, action: 'POST /api/admin/session', resourceType: 'admin_session', resourceId: null, result: 'failure', httpStatus: 401 });
    return res.status(401).json({ error: ADMIN_LOGIN_GENERIC_ERROR });
  }

  clearAdminLoginAttempts(identityHash);
  clearAdminUserLockDisplay(adminUser.id);
  touchAdminUserLastLogin(adminUser.id);

  cleanupExpiredAdminSessions();
  const rawSessionId = crypto.randomBytes(32).toString('hex');
  const sessionHash = hashAdminSecret(rawSessionId);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ADMIN_SESSION_TTL_HOURS * 3600000);
  const rawCsrf = computeCsrfTokenForSession(rawSessionId);
  // csrf_token_hash欄位保留（見db.js的admin_sessions資料表定義），寫入這次登入當下算出的
  // 雜湊值只是滿足NOT NULL約束、供人工排查時參考，實際驗證一律用上面的HMAC重新計算比對，
  // 不查詢、也不信任這個儲存值本身。
  insertAdminSession.run(sessionHash, hashAdminSecret(rawCsrf), now.toISOString(), expiresAt.toISOString(), now.toISOString(), adminUser.id);
  setAdminSessionCookie(req, res, rawSessionId, ADMIN_SESSION_TTL_HOURS * 3600000);
  recordAdminAuditLog({ ...auditBase, actorUserId: adminUser.id, actorUsernameSnapshot: adminUser.username, action: 'POST /api/admin/session', resourceType: 'admin_session', resourceId: null, result: 'success', httpStatus: 200 });
  res.json({
    success: true, csrfToken: rawCsrf, expiresAt: expiresAt.toISOString(),
    user: { id: adminUser.id, username: adminUser.username, displayName: adminUser.display_name, role: adminUser.role }
  });
});

// 回傳目前使用者的安全公開資料及權限（id／username／displayName／role），絕不回傳密碼雜湊、
// salt或其他內部安全欄位——findAdminUserSafeById() 本身就用白名單SELECT排除了那些欄位。
app.get('/api/admin/session', (req, res) => {
  const session = getValidAdminSession(req);
  if (!session) return res.json({ loggedIn: false });
  const adminUser = session.row.admin_user_id ? findAdminUserSafeById(session.row.admin_user_id) : null;
  if (!adminUser || adminUser.status !== 'active') {
    deleteAdminSessionByHash.run(session.hash);
    return res.json({ loggedIn: false });
  }
  // 用HMAC重新計算，不隨機產生、也不更新資料庫——同一個Session不論被幾個分頁同時查詢，
  // 每次都拿到同一組值，不會讓其他分頁手上的Token失效。
  const csrfToken = computeCsrfTokenForSession(session.raw);
  res.json({
    loggedIn: true, csrfToken,
    user: { id: adminUser.id, username: adminUser.username, displayName: adminUser.display_name, role: adminUser.role }
  });
});

app.delete('/api/admin/session', (req, res) => {
  const session = getValidAdminSession(req);
  if (session) {
    const adminUser = session.row.admin_user_id ? findAdminUserById(session.row.admin_user_id) : null;
    deleteAdminSessionByHash.run(session.hash);
    recordAdminAuditLog({
      actorUserId: adminUser ? adminUser.id : null,
      actorUsernameSnapshot: adminUser ? adminUser.username : null,
      action: 'DELETE /api/admin/session', resourceType: 'admin_session', resourceId: null,
      result: 'success', httpStatus: 200,
      ipHash: hashAdminAuditIp(req.ip), userAgentSummary: summarizeAdminAuditUserAgent(req.headers['user-agent'])
    });
  }
  clearAdminSessionCookie(req, res);
  res.json({ success: true });
});

// ─── 後台系統 API（產品／庫存／儀表板／帳號管理／稽核紀錄，見 後台系統/）──────────
const createAdminRouter = require('./admin-routes');
app.use('/api/admin', createAdminRouter(checkAdminAuth, ORDER_DIR, csrfProtection, auditLogMiddleware, ADMIN_SESSION_TTL_HOURS));

// ─── 新訂單主動通知（統一通知系統批次）──────────────────────────
// 舊版LINE Notify（notify-api.line.me）已停止服務，新訂單通知改走統一通知系統
// （見notification-service.js的emitNotificationEvent()＋notification-worker.js非同步派送），
// 依後台「通知設定」頁面目前的開關決定要不要透過Email／LINE Messaging API送出，這裡只負責
// 同步建立事件（一筆SQLite寫入，極快），不會、也不需要再自己組訊息或呼叫外部API。
function notifyNewOrder(order) {
  const priceOnInquiry = !!getProductById(order.product?.id)?.priceOnInquiry || !!order.product?.priceOnInquiry;
  const totalText = priceOnInquiry
    ? '價格由業務確認'
    : `NT$ ${order.quote?.total ? order.quote.total.toLocaleString() : '--'}`;
  emitNotificationEvent({
    eventType: 'new_inquiry',
    idempotencyKey: order.orderId,
    title: `新詢價：${order.product.name} × ${order.product.qty} 個`,
    // 只放客戶姓名與訂單編號，不把Email／電話等完整聯絡資料寫進通知本身——需要完整聯絡
    // 資訊時，後台通知中心會附上訂單編號，管理員可以點進訂單詳情頁查看。
    summary: `客戶：${order.contact.name}｜預估總額：${totalText}｜訂單編號：${order.friendlyOrderNo || order.orderId}`,
    severity: 'normal',
    resourceType: 'order',
    resourceId: order.orderId
  });
}

// ─── AI 功能用量管控（避免被大量呼叫導致 OpenAI 帳單暴增）──────
// 改成資料庫持久化（ai_usage_limit_events），不再用記憶體內的 Map／計數器，伺服器重啟後
// 計數不會歸零。限制數值（client_hourly_limit=20／site_daily_limit=200）本身仍是資料庫預設值
// ── 跟原本寫死在這裡的 RATE_LIMIT_MAX_PER_IP／DAILY_MAX_TOTAL 完全一致，本階段沒有提供修改
// 用的 API 或後台頁面（見 db.js getAiUsageLimitSettings()）。
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 每小時（client_hourly_limit 的滑動視窗長度）

// client_hash：只保存「原始IP用伺服器端密鑰算出的HMAC-SHA256雜湊值」，絕對不保存、也不需要
// 保存真實IP本身——這張表只需要知道「同一個雜湊值在時間範圍內出現幾次」就能判斷是否超限。
// 優先使用專屬的 AI_RATE_LIMIT_SECRET；未設定時暫時借用 ADMIN_TOKEN 當密鑰（同樣只存在
// 環境變數、不會外流），並在啟動時輸出一次安全警告，提醒之後應該另外設定一組專屬密鑰。
const AI_RATE_LIMIT_SECRET = process.env.AI_RATE_LIMIT_SECRET || process.env.ADMIN_TOKEN || '';
if (!process.env.AI_RATE_LIMIT_SECRET) {
  if (process.env.ADMIN_TOKEN) {
    console.warn('[ai-usage-limit] 未設定 AI_RATE_LIMIT_SECRET，暫時借用 ADMIN_TOKEN 作為 client_hash 的 HMAC 密鑰，建議另外在 .env 設定一組專屬密鑰');
  } else {
    console.warn('[ai-usage-limit] AI_RATE_LIMIT_SECRET 與 ADMIN_TOKEN 皆未設定，client_hash 將使用空字串密鑰計算，僅適合本機開發，正式環境請務必設定其中一個');
  }
}
function computeAiClientHash(req) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return crypto.createHmac('sha256', AI_RATE_LIMIT_SECRET).update(ip).digest('hex');
}

// 台北時區（UTC+8）當日 00:00～23:59:59.999 換算成UTC ISO字串範圍，用固定位移計算，
// 伺服器不論用什麼時區執行都不會算錯「今天」是哪一天（跟 admin-routes.js /ai-usage-stats
// 路由的既有慣例一致：每個獨立使用場景各自實作一份純函式的台北時間位移運算）。
// 刻意吃一個明確的參考時間（refMs），不直接在函式內部呼叫 Date.now()——reserveAiSiteUsage()
// 需要「保留當下時間」跟「這個時間所屬的台北日期範圍」用同一個參考時刻算出來，如果分開各自
// 呼叫一次 Date.now()，中間剛好跨過台北午夜時，這兩個值就會屬於不同一天，造成額度算到
// 錯誤的日期（Codex獨立複驗抓到的缺陷）。
const AI_USAGE_LIMIT_TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
function taipeiDayRangeIsoForMs(refMs) {
  const taipeiRef = new Date(refMs + AI_USAGE_LIMIT_TAIPEI_OFFSET_MS);
  const y = taipeiRef.getUTCFullYear(), m = taipeiRef.getUTCMonth(), d = taipeiRef.getUTCDate();
  const startUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - AI_USAGE_LIMIT_TAIPEI_OFFSET_MS;
  const endUtcMs = startUtcMs + 86400000 - 1; // 台北當天 23:59:59.999 換算的UTC毫秒
  return { startIso: new Date(startUtcMs).toISOString(), endIso: new Date(endUtcMs).toISOString() };
}

// 次數限制拆成兩個階段，避免空白／格式錯誤等從未真正準備呼叫OpenAI的請求消耗到全站每日
// 額度（Codex獨立複驗發現的風險：攻擊者可以用零成本的無效請求耗盡全站200次，讓正常顧客
// 整天無法使用）：
//   第一階段 aiUsageLimitMiddleware(featureKey)：掛在路由最前面，只檢查「這個client最近
//   60分鐘的通過次數」，用來擋同一來源的持續濫用，跟這次請求最終是否真的會呼叫OpenAI無關。
//   一開始就建立 tracker 並放到 req.aiUsageTracker，路由本身之後直接沿用同一個 tracker
//   （不可以再呼叫一次 createAiUsageTracker()，否則同一個請求會註冊兩個 res 'finish'
//   監聽器，各自寫入一筆，變成一次請求兩筆紀錄）。通過後把這次事件的 eventId／
//   siteDailyLimit／enabled 狀態放到 req 上，供第二階段使用。
//   第二階段 reserveAiSiteUsage(req, res)：四支AI路由各自在通過輸入驗證、功能設定與
//   API Key檢查、真正要呼叫OpenAI「之前」呼叫，原子把第一階段那筆事件標記成
//   site_reserved=1、同時計入台北當日全站已保留次數；只有真正準備呼叫OpenAI的請求才會
//   走到這裡，空白／格式錯誤／功能停用的請求全部停在這之前，不會消耗全站每日額度。
// 被限制時（不論哪一階段）直接回 429、標記 error_category='rate_limited'（會自動對應成
// 新的 outcome='rate_limited'，不會被誤顯示成 provider_error／「OpenAI錯誤」——本地限制
// 根本還沒呼叫到OpenAI），provider_called 維持 tracker 預設的 false／0，絕對不會呼叫 OpenAI。
function aiUsageLimitMiddleware(featureKey) {
  return function (req, res, next) {
    const tracker = createAiUsageTracker(res, featureKey);
    req.aiUsageTracker = tracker;

    let settings;
    try {
      settings = getAiUsageLimitSettings();
    } catch (err) {
      console.error(`[ai-usage-limit] 讀取次數限制設定失敗（功能：${featureKey}）：`, err.message);
      tracker.setErrorCategory('internal_error');
      return res.status(500).json({ error: '系統暫時無法處理，請稍後再試' });
    }

    if (!settings.enabled) {
      req.aiUsageLimitEnabled = false;
      return next(); // 管理員關閉了次數限制功能本身，不做次數判斷，直接放行進入路由
    }
    req.aiUsageLimitEnabled = true;
    req.aiUsageSiteDailyLimit = settings.siteDailyLimit;

    const clientHash = computeAiClientHash(req);
    const hourAgoIso = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();

    let result;
    try {
      result = recordAiClientAttemptIfAllowed({
        clientHash,
        featureKey,
        hourAgoIso,
        clientHourlyLimit: settings.clientHourlyLimit
      });
    } catch (err) {
      console.error(`[ai-usage-limit] client次數限制判斷發生例外（功能：${featureKey}）：`, err.message);
      tracker.setErrorCategory('internal_error');
      return res.status(500).json({ error: '系統暫時無法處理，請稍後再試' });
    }

    if (!result.allowed) {
      tracker.setErrorCategory('rate_limited');
      return res.status(429).json({ error: '您使用 AI 功能過於頻繁，請稍後再試' });
    }

    req.aiUsageEventId = result.eventId;
    next();
  };
}

// 第二階段：四支AI路由各自在通過輸入驗證、功能設定與API Key檢查、真正要呼叫OpenAI「之前」
// 呼叫這支函式。回傳 { allowed:false } 時，這支函式已經自己回應429／500並標記tracker，
// 呼叫端只需要直接 return，不能再往下呼叫OpenAI。req.aiUsageLimitEnabled===false（管理員
// 關閉了次數限制功能本身）時直接放行，不做任何全站額度判斷。
// reservedAtIso（真正保留的當下時間）與該時間所屬的台北日期範圍，一律從同一個 reservedAtMs
// 參考時刻算出來，避免「算日期範圍」跟「實際寫入保留時間」這兩個動作之間剛好跨過台北午夜，
// 導致額度算到錯誤的一天。
function reserveAiSiteUsage(req, res) {
  if (!req.aiUsageLimitEnabled) return { allowed: true };

  const reservedAtMs = Date.now();
  const reservedAtIso = new Date(reservedAtMs).toISOString();
  const { startIso: dayStartIso, endIso: dayEndIso } = taipeiDayRangeIsoForMs(reservedAtMs);

  let result;
  try {
    result = reserveAiSiteUsageIfAllowed({
      eventId: req.aiUsageEventId,
      reservedAtIso,
      dayStartIso,
      dayEndIso,
      siteDailyLimit: req.aiUsageSiteDailyLimit
    });
  } catch (err) {
    console.error('[ai-usage-limit] 全站每日額度保留發生例外：', err.message);
    req.aiUsageTracker.setErrorCategory('internal_error');
    res.status(500).json({ error: '系統暫時無法處理，請稍後再試' });
    return { allowed: false };
  }

  // reservation_invalid：eventId不存在、或這個eventId先前已經被保留成功過一次（同一個request
  // 不可以重複保留兩次全站額度）。這是資料完整性層級的系統錯誤，不是「額度已滿」這種正常的
  // 業務限制，絕對不可以誤標成rate_limited或回429，一律視為內部錯誤處理，且已經在這裡直接
  // return，呼叫端不會再往下呼叫OpenAI。
  if (result.reason === 'reservation_invalid') {
    console.error(`[ai-usage-limit] 全站額度保留發生系統完整性錯誤：eventId=${req.aiUsageEventId} 找不到對應的待保留事件，或已經被保留過一次`);
    req.aiUsageTracker.setErrorCategory('internal_error');
    res.status(500).json({ error: '系統暫時無法處理，請稍後再試' });
    return { allowed: false };
  }

  if (!result.allowed) {
    req.aiUsageTracker.setErrorCategory('rate_limited');
    res.status(429).json({ error: '今日 AI 生成額度已滿，請明天再試或直接聯絡業務 02-2680-9966' });
    return { allowed: false };
  }

  return { allowed: true };
}

// ─── AI 功能開關／模型／主要提示詞：四支 AI 路由每次請求即時讀取最新設定 ──────
// 讀取失敗（找不到設定列、或查詢過程拋出例外）一律視為安全考量下的服務不可用，直接回傳
// 503，只在伺服器端 log 記錄功能代碼與錯誤訊息，絕對不能把資料庫路徑、提示詞全文或任何
// 環境變數內容洩漏到 API 回應。呼叫端在拿到 null 時要立即 return，不可以接著呼叫 OpenAI。
// tracker 讓這裡的三種失敗分支（找不到功能列／功能停用／找不到提示詞列或讀取例外）都能
// 正確標記 error_category，供 AI 使用紀錄使用。
function loadAiRouteConfig(res, tracker, featureKey, promptKeys) {
  try {
    const feature = getAiFeatureSetting(featureKey);
    if (!feature) {
      console.error(`[ai-settings] 找不到功能設定：${featureKey}`);
      tracker.setErrorCategory('settings_unavailable');
      res.status(503).json({ error: 'AI 功能設定讀取失敗，請稍後再試或聯絡管理員' });
      return null;
    }
    if (!feature.enabled) {
      tracker.setErrorCategory('disabled');
      res.status(503).json({ error: '此 AI 功能目前已由管理員停用' });
      return null;
    }
    const prompts = {};
    for (const key of promptKeys) {
      const promptRow = getAiPromptSetting(key);
      if (!promptRow) {
        console.error(`[ai-settings] 找不到提示詞設定：${key}`);
        tracker.setErrorCategory('settings_unavailable');
        res.status(503).json({ error: 'AI 功能設定讀取失敗，請稍後再試或聯絡管理員' });
        return null;
      }
      prompts[key] = promptRow.content;
    }
    return { model: feature.model, prompts };
  } catch (err) {
    console.error(`[ai-settings] 讀取 ${featureKey} 設定發生例外：`, err.message);
    tracker.setErrorCategory('settings_unavailable');
    res.status(503).json({ error: 'AI 功能設定讀取失敗，請稍後再試或聯絡管理員' });
    return null;
  }
}

// ─── AI 使用紀錄：共用追蹤工具 ──────────────────────────────────
// 由 aiUsageLimitMiddleware() 在次數限制判斷「之前」就先建立好唯一一個 tracker、放到
// req.aiUsageTracker，四支 AI 路由沿用同一個（不可以在路由裡再建立第二個），確保被429擋下的
// 請求也會留下一筆使用紀錄。過程中逐步
// 設定 model／provider 呼叫狀況／token／圖片數量／outcome／error_category，最終統一在
// res 的 'finish'（正常完成）與 'close'（連線中途中斷，例如客戶端提前斷線）事件寫入唯一
// 一筆 ai_usage_logs。用 written 旗標保證同一個請求最多真正寫入一次，就算路由有多個
// return／catch／Promise.allSettled 分支、或兩個事件都觸發，也不會重複計數；request_id
// 另外有資料庫 UNIQUE 約束作為第二層防線。寫入本身失敗只在伺服器端 log 記錄安全訊息，
// 絕對不修改已經準備／已經送出給客戶的 AI 回應內容，也不會讓成功的請求因此變成500。
// error_category 與 outcome 是一組固定對照（見 AI_ERROR_CATEGORY_TO_OUTCOME），呼叫端只需要
// setErrorCategory()，outcome 會自動對應，不需要兩邊分別設定、避免兩者對不起來。
// 只保存固定分類、數字、功能代碼、模型名稱與時間，絕對不保存提示詞、圖片、個資或金鑰。
// rate_limited 這個 error_category 有兩種可能來源：本地使用次數限制（aiUsageLimitMiddleware，
// 根本還沒呼叫OpenAI）、或 OpenAI 自己回傳 429（classifyAiProviderError）。兩種都對應獨立的
// outcome='rate_limited'（不是 provider_error），才不會把本地限制誤顯示成「OpenAI錯誤」，
// 同時也讓 OpenAI 真正的429有自己更精確的分類，而不是被籠統歸類進 provider_error。
// moderation：內容審核拒絕（不論是我們主動送出的 Moderation API 預先檢查、還是 OpenAI 生成
// 呼叫本身因內容政策拒絕），一律對應 outcome='content_blocked'，明確跟其他「OpenAI錯誤」
// 區分，讓後台可以獨立統計「內容阻擋次數」。
// moderation_unavailable：內容審核服務本身故障或回應格式異常（不是「內容違規」，是「審核
// 服務打不通」），對應 outcome='unavailable'，比照 api_key_missing／settings_unavailable
// 這種「服務層級不可用」的既有分類方式。
const AI_ERROR_CATEGORY_TO_OUTCOME = {
  validation:             'validation_error',
  disabled:               'disabled',
  api_key_missing:        'unavailable',
  settings_unavailable:   'unavailable',
  timeout:                'provider_error',
  moderation:             'content_blocked',
  moderation_unavailable: 'unavailable',
  quota:                  'provider_error',
  rate_limited:           'rate_limited',
  authentication:         'provider_error',
  provider_error:         'provider_error',
  response_parse_error:   'provider_error',
  internal_error:         'internal_error'
};

function aiUsageOutcomeFallbackByStatus(status) {
  if (status >= 200 && status < 300) return 'success';
  if (status === 400) return 'validation_error';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'internal_error';
  return 'provider_error';
}

function createAiUsageTracker(res, featureKey) {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const data = {
    model: null,
    outcome: null,
    errorCategory: null,
    providerCalled: false,
    providerCallCount: 0,
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    requestedImageCount: null,
    generatedImageCount: null,
    partial: false,
    moderationCalled: false,
    moderationFlagged: false,
    moderationCategory: null,
    moderationDurationMs: null
  };
  let written = false;

  // ── 可信分析事件（ai_request／ai_result）：只在真正準備呼叫正式AI生成API的那一刻，
  // 由呼叫端明確呼叫 startTrustedAnalytics(productId) 才開始，不是每個請求都會有。這幾個
  // 變數跟上面 ai_usage_logs 用的 data 物件刻意分開放，但 outcome／errorCategory／featureKey
  // 完全共用同一份（見下面 writeOnce() 讀的都是同一個 data.outcome／data.errorCategory／
  // 外層 featureKey 閉包變數），確保兩張表對同一次請求的判斷結果不會分岔。
  let trustedAnalyticsStarted = false;
  let trustedAnalyticsProductId = null;
  let trustedAnalyticsStartedAtMs = null;
  let trustedAnalyticsRequestWritten = false; // 只有ai_request真的成功寫入，才允許之後建立ai_result（避免孤兒result）
  // 匿名關聯（楊竹分析後台第二階段第二批）：由呼叫端在 startTrustedAnalytics() 時一併傳入
  // 已經算好的雜湊值（見 resolveAnalyticsContextHashes()），ai_request／ai_result 共用同一份，
  // 不會、也不需要再重新計算一次。
  let trustedAnalyticsVisitorHash = null;
  let trustedAnalyticsSessionHash = null;

  function startTrustedAnalytics(productId, analyticsIdentifiers) {
    if (trustedAnalyticsStarted) return; // 一個請求最多開始一次，防止路由邏輯不慎呼叫兩次
    trustedAnalyticsStarted = true;
    trustedAnalyticsProductId = productId;
    trustedAnalyticsStartedAtMs = Date.now();
    trustedAnalyticsVisitorHash = analyticsIdentifiers?.anonymousVisitorIdHash ?? null;
    trustedAnalyticsSessionHash = analyticsIdentifiers?.sessionIdHash ?? null;
    try {
      recordAnalyticsEvent({
        eventId: crypto.randomUUID(),
        clientEventId: null, // 伺服器內部直接建立的可信事件，不使用瀏覽器重送防重複用途的client_event_id
        eventName: 'ai_request',
        anonymousVisitorIdHash: trustedAnalyticsVisitorHash,
        sessionIdHash: trustedAnalyticsSessionHash,
        orderId: null,
        pagePath: null,
        landingPath: null,
        referrerDomain: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        deviceType: null,
        viewportGroup: null,
        productId,
        featureKey,
        stepKey: null,
        metadataJson: null,
        occurredAt: new Date(trustedAnalyticsStartedAtMs).toISOString()
      });
      trustedAnalyticsRequestWritten = true;
    } catch (err) {
      console.error(`[analytics-events] 記錄ai_request事件失敗，不影響正式AI呼叫（功能：${featureKey}）：`, err.message);
    }
  }

  // ai_result 的 result／errorCategory 判斷，跟 ai_usage_logs 的 outcome 共用同一份 data 物件，
  // 但刻意「不」沿用 aiUsageOutcomeFallbackByStatus()（那支是給 ai_usage_logs 用、在data.outcome
  // 從未被設定時依res.statusCode猜，預設200會被當成success）。分析事件的可信度要求更高：
  // 正式生成已經開始（trustedAnalyticsStarted===true）之後，只要 data.outcome 沒有被明確設成
  // 'success'或'partial'，一律視為failure，就算是客戶端提前斷線、res.statusCode還停在預設的200、
  // data.outcome跟data.errorCategory都還是null，也不會被誤記成success（呼應規則：正式生成
  // 開始後若客戶端提前斷線，不能因預設HTTP狀態為200而誤記success）。
  function resolveTrustedAnalyticsResult() {
    if (data.outcome === 'success') return { result: 'success', errorCategory: null };
    if (data.outcome === 'partial') return { result: 'partial', errorCategory: null };
    return { result: 'failure', errorCategory: data.errorCategory || 'internal_error' };
  }

  function writeOnce() {
    if (written) return;
    written = true;
    const durationMs = Math.max(0, Date.now() - startedAt);
    const outcome = data.outcome || aiUsageOutcomeFallbackByStatus(res.statusCode);
    try {
      createAiUsageLog({
        requestId,
        featureKey,
        model: data.model,
        outcome,
        httpStatus: res.statusCode,
        errorCategory: data.errorCategory,
        durationMs,
        providerCalled: data.providerCalled,
        providerCallCount: data.providerCallCount,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        totalTokens: data.totalTokens,
        requestedImageCount: data.requestedImageCount,
        generatedImageCount: data.generatedImageCount,
        partial: data.partial,
        moderationCalled: data.moderationCalled,
        moderationFlagged: data.moderationFlagged,
        moderationCategory: data.moderationCategory,
        moderationDurationMs: data.moderationDurationMs
      });
    } catch (err) {
      console.error(`[ai-usage-log] 寫入失敗，不影響本次AI回應（功能：${featureKey}）：`, err.message);
    }

    // ai_result：只有這個請求真的成功建立過 ai_request 才寫，避免出現沒有對應request的孤立
    // result；finish／close就算兩個事件都觸發，也因為written旗標只會真正跑到這裡一次，
    // ai_result最多只會被建立一筆。寫入失敗只記錄伺服器端安全訊息，不影響已經送出的AI回應。
    if (trustedAnalyticsRequestWritten) {
      const { result, errorCategory } = resolveTrustedAnalyticsResult();
      const resultDurationMs = Math.max(0, Date.now() - trustedAnalyticsStartedAtMs); // 只算「正式生成開始」到「結果確定」這段
      const metadata = { result, durationMs: resultDurationMs };
      if (result === 'failure') metadata.errorCategory = errorCategory;
      try {
        recordAnalyticsEvent({
          eventId: crypto.randomUUID(),
          clientEventId: null,
          eventName: 'ai_result',
          anonymousVisitorIdHash: trustedAnalyticsVisitorHash,
          sessionIdHash: trustedAnalyticsSessionHash,
          orderId: null,
          pagePath: null,
          landingPath: null,
          referrerDomain: null,
          utmSource: null,
          utmMedium: null,
          utmCampaign: null,
          deviceType: null,
          viewportGroup: null,
          productId: trustedAnalyticsProductId,
          featureKey,
          stepKey: null,
          metadataJson: JSON.stringify(metadata),
          occurredAt: new Date().toISOString()
        });
      } catch (err) {
        console.error(`[analytics-events] 記錄ai_result事件失敗（功能：${featureKey}）：`, err.message);
      }
    }
  }
  res.once('finish', writeOnce);
  res.once('close', writeOnce);

  return {
    requestId,
    setModel(model) { data.model = model; },
    setProviderCalled(v) { data.providerCalled = !!v; },
    setProviderCallCount(n) { data.providerCallCount = n; },
    setTokens({ inputTokens, outputTokens, totalTokens } = {}) {
      if (inputTokens !== undefined) data.inputTokens = inputTokens;
      if (outputTokens !== undefined) data.outputTokens = outputTokens;
      if (totalTokens !== undefined) data.totalTokens = totalTokens;
    },
    setImageCounts({ requested, generated } = {}) {
      if (requested !== undefined) data.requestedImageCount = requested;
      if (generated !== undefined) data.generatedImageCount = generated;
    },
    setOutcome(outcome) { if (!data.outcome) data.outcome = outcome; },
    setErrorCategory(category) {
      if (!data.errorCategory) data.errorCategory = category;
      if (!data.outcome) data.outcome = AI_ERROR_CATEGORY_TO_OUTCOME[category] || 'internal_error';
    },
    setPartial(v) { data.partial = !!v; },
    // 內容審核結果四個獨立欄位跟 provider_called／provider_call_count（只代表正式AI生成呼叫）
    // 完全分開記錄，避免內容審核呼叫被誤算進成本／呼叫次數統計。
    setModerationResult({ called, flagged, category, durationMs } = {}) {
      if (called !== undefined) data.moderationCalled = !!called;
      if (flagged !== undefined) data.moderationFlagged = !!flagged;
      if (category !== undefined) data.moderationCategory = category;
      if (durationMs !== undefined) data.moderationDurationMs = durationMs;
    },
    // 四支AI路由在通過所有前置檢查（輸入驗證／productId／功能啟用／API Key／內容審核／
    // 本地與全站次數限制）、真正要呼叫正式生成API的那一刻呼叫，建立唯一一筆ai_request；
    // 結果（ai_result）由上面的writeOnce()統一在請求真正結束時建立，不需要呼叫端另外處理。
    startTrustedAnalytics
  };
}

// OpenAI 呼叫失敗時的 error_category 分類：沿用四支路由既有的 status／code／message 判斷條件，
// 統一轉換成固定分類代碼，不可以把 err.message 原文寫進資料庫（見 db.js ai_usage_logs 的
// error_category CHECK 白名單）。generate-image 目前對「任何 status 400」都當成內容政策拒絕
// 處理（沒有另外檢查 moderation 關鍵字），treatPlain400AsModeration 讓分類結果跟那支路由
// 既有的使用者訊息邏輯保持一致；err.status 不是數字（例如 sharp 影像處理拋出的例外，不是
// OpenAI 回傳的錯誤）一律視為非 OpenAI 的內部錯誤。
function classifyAiProviderError(err, { treatPlain400AsModeration = false } = {}) {
  if (!err) return 'internal_error';
  if (err.isTimeout) return 'timeout';
  const status = err.status;
  if (typeof status !== 'number') return 'internal_error';
  const code = (err.error && err.error.code) || err.code || '';
  const message = (err.message || '').toLowerCase();
  const looksLikeModeration = code === 'moderation_blocked' || code === 'content_policy_violation'
    || message.includes('safety system') || message.includes('moderation') || message.includes('rejected') || message.includes('policy');
  if (status === 400 && (looksLikeModeration || treatPlain400AsModeration)) return 'moderation';
  if (status === 402 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') return 'quota';
  if (status === 429) return 'rate_limited';
  if (status === 401) return 'authentication';
  return 'provider_error';
}

// ─── AI 禁止內容審核（OpenAI Moderation API）───────────────────────────
// 四支AI路由在通過輸入驗證、真正呼叫OpenAI生成圖片／文字之前，一律先把使用者輸入內容送這裡
// 做內容審核；只依照官方 results[0].flagged 判斷是否阻擋，不自行用 category_scores 設定分數
// 門檻（門檻調校屬於官方model本身的責任，見官方文件：
// https://developers.openai.com/api/docs/guides/moderation）。model固定使用
// omni-moderation-latest，文字直接送文字，圖片用 image_url 格式送出既有的Base64 data URL
// （官方Moderation API本身支援最大20MB的圖片輸入）。
// 審核服務本身故障（網路例外、逾時、回應格式不是預期的陣列）一律視為安全考量下的服務不可用，
// 直接阻擋、不允許略過審核繼續生成——絕對不能在審核服務故障時「預設放行」。
const AI_MODERATION_MODEL = 'omni-moderation-latest';
// 官方 omni-moderation-latest 固定分類（需與 db.js 的 AI_MODERATION_KNOWN_CATEGORIES／
// moderation_category CHECK 白名單保持一致），只用於後台統計顯示「主要阻擋分類」，
// 不保存分數，也不保存這份清單以外的任何未知分類字串。
const AI_MODERATION_KNOWN_CATEGORIES = [
  'sexual', 'sexual/minors', 'harassment', 'harassment/threatening',
  'hate', 'hate/threatening', 'illicit', 'illicit/violent',
  'self-harm', 'self-harm/intent', 'self-harm/instructions',
  'violence', 'violence/graphic'
];

// 從 flagged=true 的官方分類中，挑出 category_scores 最高分的一個當作「主要阻擋分類」，
// 只用於後台統計顯示；找不到已知分類、或分類物件格式不符預期時回傳null，避免寫入資料庫時
// 因為未知分類字串觸發 CHECK 約束例外。
function pickPrimaryModerationCategory(result) {
  if (!result || typeof result !== 'object') return null;
  const categories = result.categories;
  const scores = result.category_scores;
  if (!categories || typeof categories !== 'object') return null;
  let best = null, bestScore = -1;
  for (const cat of AI_MODERATION_KNOWN_CATEGORIES) {
    if (categories[cat] === true) {
      const score = (scores && typeof scores[cat] === 'number') ? scores[cat] : 0;
      if (score > bestScore) { best = cat; bestScore = score; }
    }
  }
  return best;
}

// 回傳值：
//   { ok:true }               審核通過，呼叫端可以繼續 reserveAiSiteUsage() 與正式生成
//   { ok:false, blocked:true }  內容審核明確拒絕，呼叫端回400，不執行reserveAiSiteUsage
//   { ok:false, blocked:false } 審核服務本身故障，呼叫端回503，同樣不執行reserveAiSiteUsage
// tracker 在這裡直接寫入 moderation_called／moderation_flagged／moderation_category／
// moderation_duration_ms 四個獨立欄位；setErrorCategory('moderation') 會自動對應成
// outcome='content_blocked'，setErrorCategory('moderation_unavailable') 自動對應成
// outcome='unavailable'（見 AI_ERROR_CATEGORY_TO_OUTCOME）。
async function runContentModeration(tracker, { text, imageDataURL } = {}) {
  const input = [];
  if (typeof text === 'string' && text.trim()) {
    input.push({ type: 'text', text: text.trim() });
  }
  if (typeof imageDataURL === 'string' && imageDataURL.startsWith('data:image/')) {
    input.push({ type: 'image_url', image_url: { url: imageDataURL } });
  }
  if (input.length === 0) {
    // 呼叫端已經先做過輸入驗證，理論上不會有「文字與圖片皆空」的情況；為求保守仍視為
    // 服務不可用，不可以在缺少可審核內容時預設放行。
    console.error('[content-moderation] 沒有可送出審核的內容（文字與圖片皆空）');
    tracker.setModerationResult({ called: false, flagged: false, category: null, durationMs: null });
    tracker.setErrorCategory('moderation_unavailable');
    return { ok: false, blocked: false };
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await openai.moderations.create({ model: AI_MODERATION_MODEL, input });
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error('[content-moderation] 呼叫審核服務失敗：', err.message);
    tracker.setModerationResult({ called: true, flagged: false, category: null, durationMs });
    tracker.setErrorCategory('moderation_unavailable');
    return { ok: false, blocked: false };
  }
  const durationMs = Date.now() - startedAt;

  const result = response && Array.isArray(response.results) ? response.results[0] : null;
  if (!result || typeof result.flagged !== 'boolean') {
    console.error('[content-moderation] 審核服務回傳格式異常');
    tracker.setModerationResult({ called: true, flagged: false, category: null, durationMs });
    tracker.setErrorCategory('moderation_unavailable');
    return { ok: false, blocked: false };
  }

  if (result.flagged) {
    const category = pickPrimaryModerationCategory(result);
    tracker.setModerationResult({ called: true, flagged: true, category, durationMs });
    tracker.setErrorCategory('moderation');
    return { ok: false, blocked: true };
  }

  tracker.setModerationResult({ called: true, flagged: false, category: null, durationMs });
  return { ok: true };
}

// ─── 分析事件基礎（楊竹後台分析系統第一階段：事件追蹤基礎，第二輪修正資料可信度與防濫用）──
// 依 楊竹/後台資料庫/楊竹網站分析情報規劃書_合併版.md 第六節「上線前事件追蹤規格」的事件
// 字典建立，事件名稱與必要欄位以該文件為最高依據（不另外創造同義事件名稱）。
//
// 資料可信度分界（本輪修正的核心）：
//   公開事件（前台匿名訪客可以直接送出，見 ANALYTICS_EVENT_SCHEMAS 的9個key）：
//     page_view／product_view／customization_start／customization_step_complete／
//     upload_result／preview_complete／inquiry_form_start／inquiry_validation_error／
//     contact_click。這些事件只代表「使用者聲稱發生過的行為」，不能被拿來冒充業務結果。
//   可信後端事件（只能由伺服器內部流程建立，公開API完全拒絕）：
//     inquiry_submit_success／ai_request／ai_result。詢價成功與否、AI是否真的被呼叫，
//     必須由伺服器親自確認（例如訂單真的寫入成功）才能記錄，不可以讓任何人對公開端點
//     發一個POST就宣稱「我詢價成功了」卻沒有對應的真實訂單。
// 公開API也完全不接受 orderId（避免偽造order_id去污染統計）；也不接受 eventId（event_id
// 一律由伺服器用 crypto.randomUUID() 產生，公開端點只接受 clientEventId 作為「這是同一個
// 事件的重送」標記，見下方 client_event_id 的重送／衝突判斷）。
//
// 隱私規則（見合併版文件第十節）：不保存姓名、Email、電話、地址、密碼、付款資料、表單輸入
// 全文、AI提示詞全文、原始圖片、完整User-Agent或原始IP位址；anonymous_visitor_id／
// session_id 一律先雜湊再儲存；這支API從頭到尾不會把原始IP寫進SQLite或log，只用HMAC雜湊後
// 的值當頻率限制的記憶體內key（見下方 analyticsRateLimit()）。
const ANALYTICS_EVENT_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // clientEventId格式沿用同一套UUID規則
const ANALYTICS_DOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;
const ANALYTICS_DEVICE_TYPES = ['mobile', 'tablet', 'desktop'];
// viewport_group 分組公式（固定斷點，供未來指標公式沿用，避免不同頁面各自定義出不同答案）：
//   narrow：寬度 < 768px；medium：768px ≤ 寬度 < 1280px；wide：寬度 ≥ 1280px
const ANALYTICS_VIEWPORT_GROUPS = ['narrow', 'medium', 'wide'];
const ANALYTICS_MAX_SHORT_LEN = 100;   // utm_source／utm_medium／utm_campaign／referrer_domain／productId／stepKey 等短欄位
const ANALYTICS_MAX_ID_LEN = 200;      // anonymous_visitor_id／session_id（雜湊前的原始長度上限）
const ANALYTICS_MAX_METADATA_BYTES = 2000; // 目前per-欄位長度上限已經讓總量遠低於這個門檻，這道門檻是為未來白名單擴充預留的防線
const ANALYTICS_OCCURRED_AT_MAX_FUTURE_MS = 5 * 60 * 1000;        // 容忍5分鐘的使用者端時鐘誤差
const ANALYTICS_OCCURRED_AT_MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000; // 事件時間最多回溯7天，避免任意補寫歷史資料

function isValidAnalyticsShortString(v, maxLen) {
  return typeof v === 'string' && v.length > 0 && v.length <= maxLen;
}

// pagePath／landingPath 固定公開路徑白名單（見合併版文件第六節與Codex第二次複驗要求）：
// 只允許這5個精確字串，不接受任何查詢字串（?...）、片段（#...）、反斜線、控制字元或完整
// http／https網址，也不接受後台路徑（例如/admin、/admin/dashboard）。前台未來只能送
// window.location.pathname（純路徑，瀏覽器已經幫忙拿掉query string與fragment），不可以送
// location.href或location.search——即使前端不慎送出帶query string的完整網址，這裡的精確
// 字串比對也會直接拒絕，不會被原樣寫入資料庫（Codex第二次複驗抓到的缺陷：
// /customize?email=secret@example.com 原本會被當成合法路徑接受並保存）。
const ANALYTICS_PAGE_PATH_WHITELIST = ['/', '/customize', '/landing.html', '/index.html', '/quote-confirmation.html'];
function isValidAnalyticsPagePath(v) {
  return typeof v === 'string' && ANALYTICS_PAGE_PATH_WHITELIST.includes(v);
}

// productId 必須對應一個「現在真的可以下單」的商品：存在、status=active、未封存。刻意直接
// 呼叫商品資料庫正式來源 getProductById()（跟 /api/save-order 報價計算用的是同一個查詢函式），
// 不另外維護第二份寫死的商品代碼清單，避免後台調整商品（下架／封存／新增）後這裡沒有同步更新，
// 讓分析資料跟實際商品狀態脫節（Codex第二次複驗抓到的缺陷：不存在的productId原本會被接受
// 並原樣寫入）。
function isValidActiveProductId(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > ANALYTICS_MAX_SHORT_LEN) return false;
  const product = getProductById(v);
  return !!product && product.status === 'active' && !product.archivedAt;
}

// inquiry_validation_error 的 metadata.fieldKey：「不得記錄欄位內容」——只能是固定表單欄位
// 識別碼，不是使用者實際輸入或驗證錯誤的原始文字，白名單對應公開報價表單既有欄位。
const ANALYTICS_FORM_FIELD_KEYS = ['contactName', 'contactEmail', 'contactPhone', 'contactAddress', 'qty', 'materialId', 'finishId', 'capacityId', 'note', 'other'];

// 每個頂層欄位各自的格式驗證（哪個事件允許用到哪個欄位，由下面 ANALYTICS_EVENT_SCHEMAS 決定）。
const ANALYTICS_TOP_LEVEL_FIELD_VALIDATORS = {
  pagePath:       v => isValidAnalyticsPagePath(v),
  landingPath:    v => isValidAnalyticsPagePath(v),
  referrerDomain: v => isValidAnalyticsShortString(v, ANALYTICS_MAX_SHORT_LEN) && ANALYTICS_DOMAIN_REGEX.test(v),
  utmSource:      v => isValidAnalyticsShortString(v, ANALYTICS_MAX_SHORT_LEN),
  utmMedium:      v => isValidAnalyticsShortString(v, ANALYTICS_MAX_SHORT_LEN),
  utmCampaign:    v => isValidAnalyticsShortString(v, ANALYTICS_MAX_SHORT_LEN),
  deviceType:     v => typeof v === 'string' && ANALYTICS_DEVICE_TYPES.includes(v),
  viewportGroup:  v => typeof v === 'string' && ANALYTICS_VIEWPORT_GROUPS.includes(v),
  productId:      v => isValidActiveProductId(v),
  stepKey:        v => isValidAnalyticsShortString(v, ANALYTICS_MAX_SHORT_LEN)
};
// metadata 底下各欄位各自的格式驗證（哪個事件允許用到哪個metadata欄位，同樣由
// ANALYTICS_EVENT_SCHEMAS 決定；qty／priceOnInquiry／durationMs／featureKey 只有可信後端
// 事件會用到，公開API的事件字典完全不會用到，因此這裡不需要、也不提供對應的驗證器）。
const ANALYTICS_METADATA_FIELD_VALIDATORS = {
  entryPoint:    v => typeof v === 'string' && ['product_page', 'banner', 'direct', 'other'].includes(v),
  result:        v => typeof v === 'string' && ['success', 'failure'].includes(v),
  errorCategory: v => typeof v === 'string' && v.length > 0 && v.length <= 60,
  fieldKey:      v => typeof v === 'string' && ANALYTICS_FORM_FIELD_KEYS.includes(v),
  contactType:   v => typeof v === 'string' && ['phone', 'email', 'line'].includes(v)
};

// 逐事件schema：每個公開事件只能接受自己需要的頂層欄位與metadata欄位，其餘一律視為未知欄位
// 拒絕——不使用單一全域白名單（那樣會讓「這個事件不該有的欄位」有機可乘，例如把只屬於
// 詢價流程的 metadata.qty 混進 page_view）。required／optional 是頂層欄位，
// metadataRequired／metadataOptional 是 metadata 物件底下的欄位；事件如果完全不需要
// metadata（兩個陣列都是空的），送出 metadata 欄位本身就會被視為不允許而拒絕。
const ANALYTICS_EVENT_SCHEMAS = {
  page_view: {
    required: ['pagePath', 'deviceType', 'viewportGroup'],
    optional: ['landingPath', 'referrerDomain', 'utmSource', 'utmMedium', 'utmCampaign'],
    metadataRequired: [], metadataOptional: []
  },
  product_view: {
    required: ['productId'], optional: [],
    metadataRequired: [], metadataOptional: []
  },
  customization_start: {
    required: ['productId'], optional: [],
    metadataRequired: ['entryPoint'], metadataOptional: []
  },
  customization_step_complete: {
    required: ['productId', 'stepKey'], optional: [],
    metadataRequired: [], metadataOptional: []
  },
  upload_result: {
    required: ['productId'], optional: [],
    // result=failure時必須有errorCategory、result=success時不可以有errorCategory，
    // 這條「條件式必填」規則在 validateAnalyticsEventBody() 裡另外特別處理。
    metadataRequired: ['result'], metadataOptional: ['errorCategory']
  },
  preview_complete: {
    required: ['productId'], optional: [],
    metadataRequired: [], metadataOptional: []
  },
  inquiry_form_start: {
    required: ['productId'], optional: [],
    metadataRequired: [], metadataOptional: []
  },
  inquiry_validation_error: {
    required: ['productId'], optional: [],
    metadataRequired: ['fieldKey', 'errorCategory'], metadataOptional: []
  },
  contact_click: {
    required: ['pagePath'], optional: [],
    metadataRequired: ['contactType'], metadataOptional: []
  }
};
const ANALYTICS_PUBLIC_EVENT_NAMES = Object.keys(ANALYTICS_EVENT_SCHEMAS);
// 所有公開事件共同必填（見合併版文件補充校正第3點）：clientEventId／eventName／occurredAt／
// anonymousVisitorId／sessionId。這5個不是「頂層可選欄位」，是每個公開事件都必須有的核心欄位。
const ANALYTICS_COMMON_REQUIRED_FIELDS = ['clientEventId', 'eventName', 'occurredAt', 'anonymousVisitorId', 'sessionId'];

// anonymous_visitor_id／session_id 一律用HMAC-SHA256雜湊後才寫入資料庫，絕不保存原始值。
// 沿用既有 AI_RATE_LIMIT_SECRET 當作HMAC密鑰（不另外新增一組專屬密鑰管理負擔），用固定
// 用途前綴做域分離，確保就算未來剛好有輸入字串跟AI次數限制的client_hash用到同一個原始值，
// 算出來的雜湊結果也不會相同。
function computeAnalyticsIdentifierHash(purposePrefix, rawValue) {
  if (typeof rawValue !== 'string' || !rawValue) return null;
  return crypto.createHmac('sha256', AI_RATE_LIMIT_SECRET).update(`${purposePrefix}:${rawValue}`).digest('hex');
}

// ─── 可信結果的匿名關聯（analyticsContext）：楊竹分析後台第二階段第二批 ──────────
// /api/save-order 與四支AI路由都可以選填在請求body帶一個 analyticsContext，讓伺服器把
// 「已經證明成功」的可信事件（inquiry_submit_success／ai_request／ai_result）安全連回
// window.YZAnalytics既有的匿名訪客與工作階段識別碼——雜湊方式、格式驗證跟既有公開分析
// 事件API完全相同（同一個computeAnalyticsIdentifierHash()／isValidAnalyticsShortString()，
// 不是第二套邏輯），資料庫只會保存雜湊值，這支函式本身也絕對不會回傳、記錄或外流原始值。
// analyticsContext只代表「瀏覽器聲稱的匿名關聯」，不是不可偽造的身分證明——業務結果本身
// （訂單真的寫入、AI真的呼叫成功）完全由伺服器主流程獨立證明，這裡只是替已經證明的結果
// 額外標註「來自哪個匿名瀏覽器」，缺少或格式錯誤時整個忽略，絕對不能阻擋主流程。
const ANALYTICS_CONTEXT_ALLOWED_KEYS = new Set(['anonymousVisitorId', 'sessionId']);
function resolveAnalyticsContextHashes(body, logLabel) {
  const ctx = body && typeof body === 'object' && !Array.isArray(body) ? body.analyticsContext : undefined;
  if (ctx === undefined) return { anonymousVisitorIdHash: null, sessionIdHash: null }; // 完全沒帶，正常情況，不記錄
  if (ctx === null || typeof ctx !== 'object' || Array.isArray(ctx)) {
    console.error(`[analytics-context] ${logLabel} 的 analyticsContext 格式不正確（必須是物件），已忽略匿名關聯，不影響主流程`);
    return { anonymousVisitorIdHash: null, sessionIdHash: null };
  }
  const extraKeys = Object.keys(ctx).filter(k => !ANALYTICS_CONTEXT_ALLOWED_KEYS.has(k));
  if (extraKeys.length > 0) {
    console.error(`[analytics-context] ${logLabel} 的 analyticsContext 含不允許的欄位，已忽略匿名關聯，不影響主流程`);
    return { anonymousVisitorIdHash: null, sessionIdHash: null };
  }
  const visitorRaw = ctx.anonymousVisitorId;
  const sessionRaw = ctx.sessionId;
  const visitorOk = visitorRaw === undefined || isValidAnalyticsShortString(visitorRaw, ANALYTICS_MAX_ID_LEN);
  const sessionOk = sessionRaw === undefined || isValidAnalyticsShortString(sessionRaw, ANALYTICS_MAX_ID_LEN);
  if (!visitorOk || !sessionOk) {
    console.error(`[analytics-context] ${logLabel} 的 analyticsContext 欄位格式不正確，已忽略匿名關聯，不影響主流程`);
    return { anonymousVisitorIdHash: null, sessionIdHash: null };
  }
  return {
    anonymousVisitorIdHash: visitorRaw !== undefined ? computeAnalyticsIdentifierHash('visitor', visitorRaw) : null,
    sessionIdHash: sessionRaw !== undefined ? computeAnalyticsIdentifierHash('session', sessionRaw) : null
  };
}

// 逐事件驗證：只允許這個事件字典裡明確列出的頂層欄位與metadata欄位，任何一項不合法立刻回傳
// 明確錯誤訊息（不吞掉、不靜默修正）。回傳值裡 orderId／featureKey 一律是 null——公開API
// 完全不接受這兩個欄位（見上方說明），資料庫裡這兩欄只由可信後端事件填入。
function validateAnalyticsEventBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: '請求格式不正確' };
  }

  if (typeof body.eventName !== 'string' || !ANALYTICS_PUBLIC_EVENT_NAMES.includes(body.eventName)) {
    return { ok: false, error: 'eventName 不在允許的事件白名單內' };
  }
  const schema = ANALYTICS_EVENT_SCHEMAS[body.eventName];
  const hasMetadataFields = schema.metadataRequired.length > 0 || schema.metadataOptional.length > 0;

  const allowedKeys = new Set([...ANALYTICS_COMMON_REQUIRED_FIELDS, ...schema.required, ...schema.optional]);
  if (hasMetadataFields) allowedKeys.add('metadata');
  const extraKeys = Object.keys(body).filter(k => !allowedKeys.has(k));
  if (extraKeys.length > 0) {
    return { ok: false, error: `${body.eventName} 事件不接受這些欄位：${extraKeys.join('、')}` };
  }

  if (typeof body.clientEventId !== 'string' || !ANALYTICS_EVENT_ID_REGEX.test(body.clientEventId)) {
    return { ok: false, error: 'clientEventId 必須是合法的 UUID' };
  }
  if (typeof body.occurredAt !== 'string') {
    return { ok: false, error: 'occurredAt 必須是合法的日期時間字串' };
  }
  const occurredAtMs = Date.parse(body.occurredAt);
  if (Number.isNaN(occurredAtMs)) {
    return { ok: false, error: 'occurredAt 必須是合法的日期時間字串' };
  }
  const nowMs = Date.now();
  if (occurredAtMs > nowMs + ANALYTICS_OCCURRED_AT_MAX_FUTURE_MS || occurredAtMs < nowMs - ANALYTICS_OCCURRED_AT_MAX_PAST_MS) {
    return { ok: false, error: 'occurredAt 超出允許的時間範圍' };
  }
  if (!isValidAnalyticsShortString(body.anonymousVisitorId, ANALYTICS_MAX_ID_LEN)) {
    return { ok: false, error: 'anonymousVisitorId 為必填欄位，且格式不正確' };
  }
  if (!isValidAnalyticsShortString(body.sessionId, ANALYTICS_MAX_ID_LEN)) {
    return { ok: false, error: 'sessionId 為必填欄位，且格式不正確' };
  }

  const topLevelValues = {};
  for (const field of schema.required) {
    if (body[field] === undefined) {
      return { ok: false, error: `${field} 為必填欄位` };
    }
    if (!ANALYTICS_TOP_LEVEL_FIELD_VALIDATORS[field](body[field])) {
      return { ok: false, error: `${field} 格式不正確` };
    }
    topLevelValues[field] = body[field];
  }
  for (const field of schema.optional) {
    if (body[field] === undefined) continue;
    if (!ANALYTICS_TOP_LEVEL_FIELD_VALIDATORS[field](body[field])) {
      return { ok: false, error: `${field} 格式不正確` };
    }
    topLevelValues[field] = body[field];
  }

  let metadataJson = null;
  if (hasMetadataFields) {
    if (schema.metadataRequired.length > 0 && body.metadata === undefined) {
      return { ok: false, error: 'metadata 為必填' };
    }
    if (body.metadata !== undefined) {
      if (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata)) {
        return { ok: false, error: 'metadata 必須是物件' };
      }
      const allowedMetaKeys = new Set([...schema.metadataRequired, ...schema.metadataOptional]);
      const metaKeys = Object.keys(body.metadata);
      const unknownMetaKeys = metaKeys.filter(k => !allowedMetaKeys.has(k));
      if (unknownMetaKeys.length > 0) {
        return { ok: false, error: `${body.eventName} 事件的 metadata 不接受這些欄位：${unknownMetaKeys.join('、')}` };
      }
      for (const reqKey of schema.metadataRequired) {
        if (!(reqKey in body.metadata)) {
          return { ok: false, error: `metadata.${reqKey} 為必填` };
        }
      }
      for (const k of metaKeys) {
        if (!ANALYTICS_METADATA_FIELD_VALIDATORS[k](body.metadata[k])) {
          return { ok: false, error: `metadata.${k} 型別或值不正確` };
        }
      }
      // upload_result 專屬條件式規則：result=failure時errorCategory必填，result=success時
      // errorCategory不可以出現（避免「成功卻附一個失敗原因」這種矛盾資料混進去）。
      if (body.eventName === 'upload_result') {
        if (body.metadata.result === 'failure' && !('errorCategory' in body.metadata)) {
          return { ok: false, error: 'metadata.result 為 failure 時，metadata.errorCategory 為必填' };
        }
        if (body.metadata.result === 'success' && ('errorCategory' in body.metadata)) {
          return { ok: false, error: 'metadata.result 為 success 時不可以帶 metadata.errorCategory' };
        }
      }
      const serialized = JSON.stringify(body.metadata);
      if (Buffer.byteLength(serialized, 'utf8') > ANALYTICS_MAX_METADATA_BYTES) {
        return { ok: false, error: 'metadata 內容過大' };
      }
      metadataJson = serialized;
    }
  }

  return {
    ok: true,
    clientEventId: body.clientEventId,
    eventName: body.eventName,
    occurredAt: new Date(occurredAtMs).toISOString(),
    anonymousVisitorIdHash: computeAnalyticsIdentifierHash('visitor', body.anonymousVisitorId),
    sessionIdHash: computeAnalyticsIdentifierHash('session', body.sessionId),
    orderId: null,   // 公開API永遠不接受orderId，避免偽造order_id污染統計
    featureKey: null, // ai_request／ai_result不開放公開寫入，公開事件不會用到這個欄位
    pagePath: topLevelValues.pagePath ?? null,
    landingPath: topLevelValues.landingPath ?? null,
    referrerDomain: topLevelValues.referrerDomain ?? null,
    utmSource: topLevelValues.utmSource ?? null,
    utmMedium: topLevelValues.utmMedium ?? null,
    utmCampaign: topLevelValues.utmCampaign ?? null,
    deviceType: topLevelValues.deviceType ?? null,
    viewportGroup: topLevelValues.viewportGroup ?? null,
    productId: topLevelValues.productId ?? null,
    stepKey: topLevelValues.stepKey ?? null,
    metadataJson
  };
}

// ─── 公開分析端點專用頻率限制 ─────────────────────────────────────
// 固定時間窗計數器，完全不影響AI功能的使用次數（不共用 ai_usage_limit_events 或
// aiUsageLimitMiddleware那一套）；key一律是HMAC雜湊、只存在記憶體裡（重啟即清空，不寫入
// SQLite、不寫入log，符合「不可把原始IP寫入SQLite、日誌或analytics_events」的要求）。
// req.ip 已經是 app.set('trust proxy', TRUST_PROXY_HOPS) 處理過的可信位址（見上方
// TRUST_PROXY_HOPS 設定），不自行解析X-Forwarded-For。
//
// 修正Codex第二次複驗抓到的記憶體清理缺陷：原本每個來源存一個時間戳陣列，且只有「這個來源
// 剛好又送出新請求」時才會順便濾掉過期時間戳；長期不再出現的來源會讓Map裡留著永遠不會被
// 清除的舊entry，記憶體隨不同來源數量無上限成長。修正後每個來源只存 {count, resetAt} 兩個
// 數字（固定時間窗計數器，不是滑動視窗，但對「每分鐘最多120次」這個需求已經足夠精確）；
// 另外用一個獨立的定時清理器主動掃過整個Map、刪除所有已經過期（now>=resetAt）的entry，
// 不必依賴「這個來源剛好又來一次請求」才觸發清理；清理定時器呼叫.unref()，確保它不會阻止
// Node.js程序正常結束（例如測試腳本呼叫child.kill()時）；Map也設定了最大key數上限，達到
// 上限時，全新來源（Map裡還沒有這個key）一律直接視為超限拒絕，不會讓Map繼續無上限成長
// ——已經在Map裡的既有來源不受這個上限影響，仍然依照自己的count/resetAt正常判斷。
// 三個時間相關常數改成可用環境變數覆寫（僅供隔離測試加快驗證速度用，正式環境未設定時维持
// 下面這些預設值），沿用專案裡 TRUST_PROXY_HOPS 那種「明確、範圍可控的環境變數」慣例。
const ANALYTICS_RATE_LIMIT_WINDOW_MS = parseInt(process.env.ANALYTICS_RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000; // 每分鐘
const ANALYTICS_RATE_LIMIT_MAX_PER_SOURCE = 120;
const ANALYTICS_RATE_LIMIT_MAX_MAP_KEYS = parseInt(process.env.ANALYTICS_RATE_LIMIT_MAX_KEYS, 10) || 5000;
const ANALYTICS_RATE_LIMIT_CLEANUP_MS = parseInt(process.env.ANALYTICS_RATE_LIMIT_CLEANUP_MS, 10) || 60 * 1000;
const _analyticsRateLimitBuckets = new Map(); // key(HMAC雜湊) -> { count, resetAt }
function analyticsRateLimit(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const key = crypto.createHmac('sha256', AI_RATE_LIMIT_SECRET).update(`analytics_rate_limit:${ip}`).digest('hex');
  const now = Date.now();

  let bucket = _analyticsRateLimitBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (!bucket && _analyticsRateLimitBuckets.size >= ANALYTICS_RATE_LIMIT_MAX_MAP_KEYS) {
      // 全新來源、但Map已經達到上限：安全考量下直接拒絕，不繼續無限制新增key。
      return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    bucket = { count: 0, resetAt: now + ANALYTICS_RATE_LIMIT_WINDOW_MS };
    _analyticsRateLimitBuckets.set(key, bucket);
  }
  bucket.count++;
  if (bucket.count > ANALYTICS_RATE_LIMIT_MAX_PER_SOURCE) {
    return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
  }
  next();
}
const analyticsRateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of _analyticsRateLimitBuckets) {
    if (now >= bucket.resetAt) _analyticsRateLimitBuckets.delete(key);
  }
}, ANALYTICS_RATE_LIMIT_CLEANUP_MS);
analyticsRateLimitCleanupTimer.unref(); // 不阻止Node.js程序正常結束（例如測試腳本結束時kill此程序）

// express.json({limit:'20kb'})解析失敗時，body-parser會呼叫next(err)；Express依函式參數
// 個數（4個）辨識這是錯誤處理中介層，只有在有例外待處理時才會被呼叫。依錯誤實際類型分流
// （修正Codex第二次複驗抓到的缺陷：原本不分青紅皂白把所有解析錯誤都偽裝成413「內容過大」，
// 連格式錯誤的JSON、其他未預期的錯誤也一併誤判）：
//   entity.too.large（真的超過20KB）→ 413
//   entity.parse.failed（JSON語法錯誤，例如漏逗號、body根本不是合法JSON）→ 400
//   其他未知錯誤 → 呼叫 next(err) 交給後續錯誤處理，不在這裡假裝成任何一種已知錯誤
function analyticsBodyParseErrorHandler(err, req, res, next) {
  if (!err) return next();
  if (err.type === 'entity.too.large' || err.status === 413) {
    return res.status(413).json({ error: '請求內容過大' });
  }
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    return res.status(400).json({ error: '請求格式不正確' });
  }
  return next(err);
}

// 實際處理邏輯：驗證通過後，event_id一律由伺服器產生（絕對不接受、也不使用任何用戶端傳入的
// 識別碼），呼叫db.js的recordAnalyticsEvent()做clientEventId重送比對。conflict（同一個
// clientEventId被拿去標記不同內容）回409，不修改原紀錄；其餘情況回應 recorded 布林值，
// 不洩漏任何內部資料庫細節。
function handleAnalyticsEventRequest(req, res) {
  const result = validateAnalyticsEventBody(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.error });
  }

  const eventId = crypto.randomUUID();
  try {
    const outcome = recordAnalyticsEvent(Object.assign({ eventId }, result));
    if (outcome.status === 'conflict') {
      return res.status(409).json({ error: '這個 clientEventId 已經用於另一筆內容不同的事件，請重新產生新的 clientEventId' });
    }
    res.json({ success: true, recorded: outcome.recorded });
  } catch (err) {
    console.error('[analytics-events] 寫入失敗：', err.message); // 絕不記錄請求內容本身
    res.status(500).json({ error: '事件記錄失敗，請稍後再試' });
  }
}
// 路由本身註冊在檔案最前面（CORS白名單中介軟體之後、全域 express.json({limit:'30mb'}) 之前，
// 見上方），這裡的 function 宣告會在模組載入時整個被提升到最上層可用，跟註冊位置無關。

// ─── 訂單狀態流程 ──────────────────────────────
// 正常流程（依序前進）：新詢價 → 已報價 → 已成交 → 生產中 → 品質檢查 → 待出貨 → 已出貨 → 已完成
// 「已取消」是例外流程（不算流程中的一個「下一步」），可以從任何非終止狀態直接取消。
// 「已完成」／「已取消」都是終止狀態，不能再用一般狀態更新變更，只能透過獨立的
// 「恢復」API（見下方 restore-status 路由）並且一定要帶 confirm:true。
// 沿用既有狀態代碼（new_inquiry／quoted／closed_won／shipped）確保舊訂單資料與既有測試不失效，
// 新增狀態一律使用穩定的英文代碼。
const ORDER_STATUS_FLOW = [
  'new_inquiry', 'quoted', 'closed_won',
  'in_production', 'qc', 'ready_to_ship', 'shipped', 'completed'
];
const CANCELLED_STATUS = 'cancelled';
const TERMINAL_STATUSES = ['completed', CANCELLED_STATUS];
const ORDER_STATUSES = [...ORDER_STATUS_FLOW, CANCELLED_STATUS];
// 「恢復」的定義是把終止狀態的訂單重新拉回正常流程，目標只能是非終止的流程狀態，
// 不可以恢復成另一個終止狀態（completed → cancelled 或 cancelled → completed 都不合理，
// 那應該分別是「正常走完流程」與「取消」，不是「恢復」）。
const RESTORABLE_STATUSES = ORDER_STATUS_FLOW.filter(s => !TERMINAL_STATUSES.includes(s));
const ORDER_STATUS_LABELS = {
  new_inquiry:    '新詢價',
  quoted:         '已報價',
  closed_won:     '已成交',
  in_production:  '生產中',
  qc:             '品質檢查',
  ready_to_ship:  '待出貨',
  shipped:        '已出貨',
  completed:      '已完成',
  cancelled:      '已取消'
};

// 判斷一個狀態轉換是否合法，回傳 { ok, needsConfirm, reason }：
// - ok=false：不合法轉換（未知狀態、非法跳級、從終止狀態直接變更…），一律回絕，不接受前端自行判斷。
// - needsConfirm=true：合法但屬於例外操作（取消、倒退），呼叫端必須明確帶 confirm:true 才會真的執行。
function evaluateStatusTransition(from, to) {
  if (!ORDER_STATUSES.includes(to)) {
    return { ok: false, reason: '狀態值不正確' };
  }
  if (from === to) {
    return { ok: false, reason: '狀態未變更' };
  }
  if (TERMINAL_STATUSES.includes(from)) {
    return { ok: false, reason: '此訂單已為終止狀態（已完成／已取消），請使用「恢復」功能並二次確認後才能變更' };
  }
  if (to === CANCELLED_STATUS) {
    return { ok: true, needsConfirm: true, action: 'cancel', reason: '取消訂單需要二次確認' };
  }
  const fromIdx = ORDER_STATUS_FLOW.indexOf(from);
  const toIdx   = ORDER_STATUS_FLOW.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) {
    return { ok: false, reason: '狀態值不正確' };
  }
  if (toIdx === fromIdx + 1) {
    return { ok: true, needsConfirm: false, action: 'forward' }; // 一般操作：往下一個合理階段前進
  }
  if (toIdx < fromIdx) {
    return { ok: true, needsConfirm: true, action: 'regress', reason: '狀態倒退需要二次確認' }; // 倒退：允許，但需二次確認
  }
  return { ok: false, reason: '不可跳級變更狀態，請依流程逐步前進' }; // 非法跳級
}

// ─── 狀態歷程：追加式紀錄，只有真的成功變更狀態時才會寫入一筆 ────────
// actor 固定寫死 'admin'（跟訂單負責人／內部備註同一套安全考量：後台目前只有單一組共用密碼，
// 完全不接受前端傳入 actor，避免有人偽造成別人的操作紀錄）。任何驗證失敗、非法跳級、
// 缺少二次確認、找不到訂單等情況都會在寫入前就被回絕，不會呼叫這個函式，也就不會產生假紀錄。
const STATUS_HISTORY_ACTOR = 'admin';
function appendStatusHistory(order, { from, to, action, changedAt }) {
  if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
  order.statusHistory.push({ from, to, action, actor: STATUS_HISTORY_ACTOR, changedAt });
}

// ─── 客戶單號（YZ-YYYYMMDD-XXX，當天第幾筆訂單）──────────────
// 只用來給業務/客戶對單用的「好記編號」，不影響既有 orderId（檔名/工廠包下載連結仍用 orderId）。
// 2026-08-18後台版面調整批次：訂單編號格式從「YZ-20260729-001」縮短成「260729-001」
// （拿掉YZ-前綴、年份只留末兩碼），全站（客人看到的確認頁、列印單、工廠包、後台）統一套用
// 新格式。這裡只改「往後新產生」的編號，已經存在的正式訂單維持原本存檔時的舊格式不去改動
// （不可修改正式訂單資料），所以正式環境會有新舊兩種格式並存，這是預期中的正常現象。
function generateFriendlyOrderNo(now) {
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD，跟現有檔名開頭格式一致
  let todayCount = 0;
  try {
    todayCount = fs.readdirSync(ORDER_DIR).filter(f => f.startsWith(dateStr) && f.endsWith('.json')).length;
  } catch { /* ORDER_DIR 讀取失敗時退回 0，仍可產生編號 */ }
  const seq = String(todayCount + 1).padStart(3, '0');
  const shortDate = dateStr.replace(/-/g, '').slice(2); // YYYYMMDD → 去掉斜線後只留末6碼（YYMMDD）
  return `${shortDate}-${seq}`;
}

// ─── 詢價送出冪等性保護（正式部署環境準備）──────────────────────────────
// key 由前端在使用者第一次點「送出詢價單」時產生一次（見 js/configurator.js
// submitQuote()），重試同一次詢價（例如網路逾時後使用者再點一次送出）沿用同一把 key；
// 只接受隨機格式（英數字/-/_，8~100字），刻意不接受自由文字，避免有人把姓名、Email
// 等個資塞進這個欄位。同一把 key 只會真的寫入一次訂單，第二次以後直接回傳第一次的
// 結果，不會產生兩筆訂單、也不會重複發送 LINE 通知。用進程內 Map 保存（這個專案是
// 單一 Node 進程、非多副本水平擴展架構，跟既有 analyticsRateLimit 的 Map 快取是同一套
// 設計慣例），24小時後自動清除，避免長期佔用記憶體。
const SAVE_ORDER_IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{8,100}$/;
const SAVE_ORDER_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const _saveOrderIdempotencyCache = new Map(); // idempotencyKey -> { response, cachedAt }
const saveOrderIdempotencyCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _saveOrderIdempotencyCache) {
    if (now - entry.cachedAt > SAVE_ORDER_IDEMPOTENCY_TTL_MS) _saveOrderIdempotencyCache.delete(key);
  }
}, 60 * 60 * 1000);
saveOrderIdempotencyCleanupTimer.unref();

// ─── API：儲存訂單 ─────────────────────────
// 報價一律由後端依資料庫商品資料（getProductById()，正式來源，不是 js/products.js 的
// 內建備援資料）重新計算，完全不信任前端傳入的單價／總額：前端只需要送出「選了哪個
// 商品／材質／工藝／容量／數量」這幾個 id，實際計價（含顯示用的商品/材質/工藝/容量
// 名稱）全部由後端重新算出並寫進訂單。前端若一併附上它自己算出的 quote，只用來比對
// 是否一致並記錄警告，不一致一律以後端計算結果為準，絕不採信前端數字。
app.post('/api/save-order', (req, res) => {
  try {
    const { contact, product, quote: clientQuote, designDataURL, idempotencyKey } = req.body;

    let validIdempotencyKey = null;
    if (typeof idempotencyKey === 'string' && SAVE_ORDER_IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
      validIdempotencyKey = idempotencyKey;
      const cached = _saveOrderIdempotencyCache.get(validIdempotencyKey);
      if (cached) return res.json(cached.response);
    }

    // 聯絡資料基本驗證（正式部署環境準備）：前端 _validateContactFormFields() 已經擋過一次，
    // 這裡是後端最後一道防線——避免有人繞過前台頁面直接呼叫這支 API，用空白或明顯不合法的
    // 聯絡資料寫入訂單。姓名／Email 是前台畫面上唯一標了必填(*)的兩個欄位，跟前端驗證範圍
    // 一致；電話維持選填不擋。訊息只說「請填寫...」，不回傳使用者送出的原始內容，避免意外
    // 把使用者輸入原樣反射回應（沒有實際風險，但沒有必要）。
    const contactName  = (contact?.name  || '').trim();
    const contactEmail = (contact?.email || '').trim();
    if (!contactName || !contactEmail) {
      return res.status(400).json({ error: '請填寫姓名/公司名稱與 Email 後再送出' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      return res.status(400).json({ error: 'Email 格式不正確，請確認後再送出' });
    }

    const productId = product?.id;
    if (typeof productId !== 'string' || !productId) {
      return res.status(400).json({ error: '商品編號不正確' });
    }
    const dbProduct = getProductById(productId);
    if (!dbProduct) {
      return res.status(400).json({ error: '找不到此商品，請重新整理頁面後再試一次' });
    }

    // 商品已封存或非上架中（inactive／coming_soon）一律擋下，不進入計價與寫檔流程，
    // 避免繞過前台商品清單直接呼叫本 API 對已下架／已封存商品建立訂單。
    // 對外一律回傳同一句籠統訊息，不透露商品實際狀態。
    if (dbProduct.archivedAt || dbProduct.status !== 'active') {
      return res.status(400).json({ error: '商品目前無法下單，請重新整理後再試。' });
    }

    const materialId = product?.materialId;
    const finishId    = product?.finishId;
    const capacityId  = product?.capacityId ?? null;
    const qty         = product?.qty;

    const calc = calcQuoteForProduct(dbProduct, materialId, finishId, capacityId, qty);
    if (!calc.ok) {
      return res.status(400).json({ error: calc.error });
    }

    // 前端金額跟後端重新計算不一致時只記錄警告（可能是前端資料過舊、或請求被竄改），
    // 一律以後端計算結果為準寫入訂單，不會、也不可能採信前端傳入的數字。
    if (!calc.priceOnInquiry && clientQuote && typeof clientQuote.total === 'number' && clientQuote.total !== calc.total) {
      console.warn(`[save-order] 前端金額與後端重新計算不一致（商品 ${productId}）：前端 total=${clientQuote.total}，後端 total=${calc.total}，已採用後端計算結果`);
    }

    const material = dbProduct.materials.find(m => m.id === materialId);
    const finish   = dbProduct.finishes.find(f => f.id === finishId);
    const capacity = Array.isArray(dbProduct.capacities) ? dbProduct.capacities.find(c => c.id === capacityId) : null;

    // 顯示用的商品/材質/工藝/容量名稱同樣一律採用資料庫資料，不信任前端傳入的字串，
    // 確保訂單記錄裡「顯示的名稱」永遠跟「實際被拿去計價的那個項目」完全一致。
    const resolvedProduct = {
      id: dbProduct.id,
      name: dbProduct.name,
      material: material.name,
      finish: finish.name,
      capacity: capacity ? capacity.name : null,
      qty: calc.qty,
      priceOnInquiry: !!dbProduct.priceOnInquiry
    };

    const resolvedQuote = calc.priceOnInquiry
      ? { priceOnInquiry: true, qty: calc.qty, leadDays: calc.leadDays }
      : {
          priceOnInquiry: false,
          unitPrice: calc.unitPrice,
          subtotal: calc.subtotal,
          setupFee: calc.setupFee,
          total: calc.total,
          leadDays: calc.leadDays,
          qty: calc.qty,
          qtyBreakUsed: calc.qtyBreakUsed
        };

    // 產生時間戳檔名
    const now    = new Date();
    const ts     = now.toISOString().replace(/T/, '_').replace(/:/g, '-').slice(0, 19);
    const safeEmail = (contact?.email || 'unknown').replace(/[^a-z0-9@._-]/gi, '_');
    const baseName  = `${ts}_${safeEmail}`;
    const friendlyOrderNo = generateFriendlyOrderNo(now);

    // ─── 測試模式（FORM_TEST_MODE=true）────────────────────────────────
    // 不寫入訂單檔案、不儲存設計圖、不呼叫 notifyNewOrder()（唯一的「通知業務」管道，
    // 只有 LINE Notify，這個專案沒有伺服器端寄信功能）、也不記錄分析事件，避免測試資料
    // 混進正式業務資料或報表。回應格式跟正式送出完全一致（多一個 testMode:true 欄位），
    // 讓前端可以完整測試整個表單流程。db.js 最上方已經擋下 production + FORM_TEST_MODE=true
    // 的組合（連資料庫都不會打開就直接拒絕啟動），這裡不會在正式環境被執行到。
    if (process.env.FORM_TEST_MODE === 'true') {
      const testResponse = {
        success: true,
        testMode: true,
        orderId: `TEST-${crypto.randomUUID()}`,
        friendlyOrderNo: `TEST-${friendlyOrderNo}`,
        product: resolvedProduct,
        quote: resolvedQuote
      };
      if (validIdempotencyKey) _saveOrderIdempotencyCache.set(validIdempotencyKey, { response: testResponse, cachedAt: Date.now() });
      return res.json(testResponse);
    }

    // 儲存設計圖 PNG（若有）
    let designImageFile = null;
    if (designDataURL && designDataURL.startsWith('data:image/')) {
      const base64 = designDataURL.replace(/^data:image\/\w+;base64,/, '');
      designImageFile = `${baseName}.png`;
      fs.writeFileSync(path.join(ORDER_DIR, designImageFile), Buffer.from(base64, 'base64'));
    }

    // 儲存訂單 JSON
    const orderRecord = {
      orderId:         baseName,
      friendlyOrderNo,
      savedAt:         now.toISOString(),
      contact,
      product: resolvedProduct,
      quote:   resolvedQuote,
      designImageFile,
      status:                     'new_inquiry',
      statusUpdatedAt:            null,
      factoryPackageDownloadedAt: null
    };
    fs.writeFileSync(
      path.join(ORDER_DIR, `${baseName}.json`),
      JSON.stringify(orderRecord, null, 2),
      'utf8'
    );

    console.log(`[訂單] 已儲存：${baseName}.json（${friendlyOrderNo}）`);
    notifyNewOrder(orderRecord); // 只同步寫入通知事件（見上方定義），實際Email／LINE發送由背景worker非同步處理，不拖慢這次回應

    // 分析事件（楊竹後台分析系統第一階段，見合併版規劃書第六節）：詢價成功時記錄
    // inquiry_submit_success，只在訂單真的寫入成功後才記錄，失敗絕對不能讓這次詢價主流程
    // 失敗——整段包住try/catch，出錯只記錄不含敏感資料的伺服器錯誤訊息（不含contact內容）。
    try {
      const analyticsHashes = resolveAnalyticsContextHashes(req.body, 'save-order');
      recordAnalyticsEvent({
        eventId: crypto.randomUUID(),
        clientEventId: null, // 伺服器內部直接建立的可信事件，不需要瀏覽器重送防重複用途的client_event_id
        eventName: 'inquiry_submit_success',
        anonymousVisitorIdHash: analyticsHashes.anonymousVisitorIdHash,
        sessionIdHash: analyticsHashes.sessionIdHash,
        orderId: baseName,
        pagePath: null,
        landingPath: null,
        referrerDomain: null,
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        deviceType: null,
        viewportGroup: null,
        productId: dbProduct.id,
        featureKey: null,
        stepKey: null,
        metadataJson: JSON.stringify({ qty: calc.qty, priceOnInquiry: !!dbProduct.priceOnInquiry }),
        occurredAt: now.toISOString()
      });
    } catch (err) {
      console.error('[analytics-events] 記錄inquiry_submit_success事件失敗（不影響訂單建立）：', err.message);
    }

    const successResponse = { success: true, orderId: baseName, friendlyOrderNo, product: resolvedProduct, quote: resolvedQuote };
    if (validIdempotencyKey) _saveOrderIdempotencyCache.set(validIdempotencyKey, { response: successResponse, cachedAt: Date.now() });
    res.json(successResponse);

  } catch (err) {
    console.error('[save-order]', err.message);
    res.status(500).json({ error: '訂單儲存失敗' });
  }
});

// ─── API：列出訂單（內部查詢用，需後台密碼）────────────────
// 回傳全部訂單（不再只取最近 50 筆），讓後台的篩選／分頁可以涵蓋完整歷史訂單，
// 而不是只能在「最近 50 筆」裡面做前端分頁。分頁本身在後台頁面（admin.html）用
// 已經取得的完整訂單清單做前端分頁，不需要另外開分頁參數的 API。
app.get('/api/orders', checkAdminAuth, requirePermission('orders', 'view'), csrfProtection, (req, res) => {
  try {
    const files = fs.readdirSync(ORDER_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .reverse();

    const orders = files.map(f => {
      try {
        const filePath = path.join(ORDER_DIR, f);
        const order = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        // 舊訂單沒有 status 欄位時，依原本「已處理/未處理」二態換算成新狀態，並寫回檔案避免每次都要重算
        if (!order.status) {
          order.status = order.processed ? 'closed_won' : 'new_inquiry';
          order.statusUpdatedAt = order.processedAt || null;
          fs.writeFileSync(filePath, JSON.stringify(order, null, 2), 'utf8');
        }
        return order;
      } catch { return null; }
    }).filter(Boolean);

    // 預設只回傳未封存訂單；帶 ?archived=1 才回傳已封存訂單。後台用兩個頁籤（目前訂單／已封存）
    // 各自呼叫一次取得各自的清單，不會混在同一份回應裡，也不影響既有「不帶參數」呼叫方式的行為。
    const showArchived = req.query.archived === '1';
    const visibleOrders = orders.filter(o => isOrderArchived(o) === showArchived);

    res.json({ success: true, count: visibleOrders.length, orders: visibleOrders });
  } catch (err) {
    res.status(500).json({ error: '讀取失敗' });
  }
});

// ─── API：訂單匯出Excel ─────────────────────────────
// 前端「訂單管理」頁面篩選（關鍵字／日期區間／商品／狀態／預估逾期）全部是拿同一份已載入的
// 訂單資料在瀏覽器端計算（getFilteredOrders()），畫面上看到的表格跟匯出結果本來就要完全一致，
// 所以這裡不重新在後端實作一次篩選邏輯——直接讓前端把「目前篩選結果」的每一列資料傳過來，
// 後端只負責把這些資料轉成真正的.xlsx二進位檔案。權限只需要view（能看訂單列表就能匯出，
// 跟能不能下載工廠包這種更敏感的操作分開判斷）。
app.post('/api/orders/export', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'view'), csrfProtection, async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) {
    return res.status(400).json({ error: '目前沒有可以匯出的資料' });
  }
  if (rows.length > 5000) {
    return res.status(400).json({ error: '一次最多匯出5000筆，請縮小篩選範圍後再匯出' });
  }
  const columns = [
    { header: '訂單編號', key: 'orderNo', width: 20 },
    { header: '時間', key: 'time', width: 18 },
    { header: '客戶', key: 'name', width: 12 },
    { header: 'Email', key: 'email', width: 24 },
    { header: '電話', key: 'phone', width: 14 },
    { header: '產品', key: 'product', width: 20 },
    { header: '材質', key: 'material', width: 12 },
    { header: '工藝', key: 'finish', width: 12 },
    { header: '數量', key: 'qty', width: 8 },
    { header: '預估總額', key: 'total', width: 12 },
    { header: '訂單狀態', key: 'status', width: 14 },
    { header: '工廠包已下載', key: 'downloaded', width: 12 },
    { header: '備註', key: 'note', width: 26 }
  ];
  // 白名單轉型：只信任這些固定欄位的「值」，不管前端body裡多帶了什麼欄位都不會被寫進Excel。
  const safeRows = rows.map(r => ({
    orderNo: String(r?.orderNo ?? ''),
    time: String(r?.time ?? ''),
    name: String(r?.name ?? ''),
    email: String(r?.email ?? ''),
    phone: String(r?.phone ?? ''),
    product: String(r?.product ?? ''),
    material: String(r?.material ?? ''),
    finish: String(r?.finish ?? ''),
    qty: Number.isFinite(Number(r?.qty)) ? Number(r.qty) : 0,
    total: Number.isFinite(Number(r?.total)) ? Number(r.total) : 0,
    status: String(r?.status ?? ''),
    downloaded: String(r?.downloaded ?? ''),
    note: String(r?.note ?? '')
  }));
  try {
    const buffer = await buildXlsxBuffer('訂單', columns, safeRows);
    sendXlsx(res, '楊竹訂單', buffer);
  } catch (err) {
    console.error('[orders/export] 產生Excel失敗', err.message);
    res.status(500).json({ error: '匯出失敗，請稍後再試' });
  }
});

// 舊訂單沒有 status 欄位時，安全換算成既有的預設狀態；跟 GET /api/orders 用同一套邏輯。
function orderStatusOf(order) {
  return order.status || (order.processed ? 'closed_won' : 'new_inquiry');
}

// ─── API：更新訂單狀態（伺服器端存放，任何人登入後台看到的都是同一份狀態）──
// 合法轉換規則完全由後端 evaluateStatusTransition() 決定，不接受未知狀態、不接受非法跳級、
// 不接受從終止狀態直接變更；取消／倒退這種例外操作一定要求 body 帶 confirm:true 才會真的執行，
// 前端就算漏做二次確認的畫面，後端也不會被繞過。
app.post('/api/orders/:orderId/status', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  const status = req.body.status;
  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  try {
    const order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
    if (guardOrderNotArchived(order, res)) return;
    const from = orderStatusOf(order);
    const evalResult = evaluateStatusTransition(from, status);
    if (!evalResult.ok) {
      return res.status(400).json({ error: evalResult.reason });
    }
    if (evalResult.needsConfirm && req.body.confirm !== true) {
      return res.status(400).json({ error: evalResult.reason });
    }

    // 自動扣庫存：只在「這次轉換本身就是從已報價正式變成已成交」時觸發，只認 evaluateStatusTransition()
    // 算出的 from（伺服器端讀到的舊狀態，不是前端傳入值），刻意用嚴格比對 from==='quoted' && status
    // ==='closed_won'，不會被「已成交倒退回已報價、再前進到已成交」以外的任何路徑誤觸——例如
    // restore-status（見上方路由）只會從終止狀態（已完成／已取消）出發，from 永遠不可能是 quoted，
    // 天生就不會撞到這個條件；公開客戶報價確認頁（quote-confirmations/:token/response）完全是另一支
    // 路由、只會寫入 quoteVersion.customerResponse，從來不會呼叫這支 API，也不會走到這裡。
    // 一定要先扣庫存成功、才能寫入新狀態：扣庫存用訂單自己保存的 product.id／product.qty（穩定商品
    // 代碼與數量，不用商品名稱猜測），失敗時直接回傳明確錯誤並中止，完全不寫檔、訂單狀態維持原狀。
    // 同一張訂單重複進入已成交（例如倒退後再次前進）不會被擋下、也不會重複扣庫存——
    // deductInventoryForOrder() 本身用 orderId 做冪等判斷，重複觸發只會回傳 alreadyDeducted:true，
    // 這裡把它視為成功，讓狀態照常更新。
    if (from === 'quoted' && status === 'closed_won') {
      const deductResult = deductInventoryForOrder({
        orderId,
        productId: order.product?.id,
        qty: order.product?.qty,
        orderLabel: order.friendlyOrderNo || orderId
      });
      if (!deductResult.ok) {
        return res.status(deductResult.status || 500).json({ error: deductResult.error });
      }
    }

    // 自動回補庫存：只認這次要變成的目標狀態是否為 cancelled（跟 from 無關——取消可以從
    // new_inquiry 一路到 shipped 任何一個非終止狀態直接發生，見上面 evaluateStatusTransition()
    // 對 to===CANCELLED_STATUS 的特別處理）。restockInventoryForOrderCancellation() 本身是安全、
    // 冪等的：這張訂單如果從來沒被扣過庫存（例如已報價就直接取消），會回傳 restocked:false 加
    // neverDeducted:true，不會平白增加庫存；如果確實扣過庫存（已成交、生產中……取消），會正確
    // 依當初扣庫存紀錄的商品與數量回補；如果這一輪已經回補過（重複請求或並行呼叫），會回傳
    // alreadyRestocked:true，不會重複加庫存。三種情況都是 ok:true，都視為可以安全繼續讓訂單變成
    // cancelled；只有 ok:false（例如底層資料庫寫入失敗）才會擋下狀態變更。
    // 一定要先回補成功、才能寫入 cancelled 狀態：回補失敗時直接回傳錯誤並中止，完全不寫檔，
    // 訂單狀態與狀態歷程都維持原狀。
    if (status === CANCELLED_STATUS) {
      const restockResult = restockInventoryForOrderCancellation({
        orderId,
        orderLabel: order.friendlyOrderNo || orderId
      });
      if (!restockResult.ok) {
        return res.status(restockResult.status || 500).json({ error: restockResult.error });
      }
    }

    const now = new Date().toISOString();
    order.status = status;
    order.statusUpdatedAt = now;
    appendStatusHistory(order, { from, to: status, action: evalResult.action, changedAt: now });
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({ success: true, status: order.status, statusUpdatedAt: order.statusUpdatedAt, statusHistory: order.statusHistory });
  } catch (err) {
    console.error('[order-status]', err.message);
    res.status(500).json({ error: '狀態更新失敗' });
  }
});

// ─── API：恢復終止狀態（已完成／已取消 → 重新進入流程）─────────────
// 獨立於一般狀態更新之外的路由，只有目前是終止狀態的訂單才能呼叫，且一定要 confirm:true，
// 避免「恢復」這種例外操作被一般狀態更新的邏輯或前端疏漏誤觸。
app.post('/api/orders/:orderId/restore-status', checkAdminAuth, auditLogMiddleware, requirePermission('orders_restore', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  const status = req.body.status;
  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  try {
    const order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
    if (guardOrderNotArchived(order, res)) return;
    const from = orderStatusOf(order);
    if (!TERMINAL_STATUSES.includes(from)) {
      return res.status(409).json({ error: '此訂單目前不是終止狀態，請直接使用一般狀態更新' });
    }
    if (!RESTORABLE_STATUSES.includes(status)) {
      return res.status(400).json({ error: '恢復目標必須是正常流程中的非終止狀態，不可以恢復成「已完成」或「已取消」' });
    }
    if (status === from) {
      return res.status(400).json({ error: '狀態未變更' });
    }
    if (req.body.confirm !== true) {
      return res.status(400).json({ error: '恢復終止狀態需要二次確認' });
    }

    // 從「已取消」恢復、且恢復目標是「已成交」或更後面的正常流程狀態時，代表這張訂單當初如果
    // 真的扣過庫存，已經被取消當下的自動回補沖銷掉了，必須先重新扣庫存成功，才能把狀態寫成
    // 恢復後的目標值；重新扣除失敗時，訂單必須維持「已取消」，完全不寫檔、不變更狀態歷程。
    // 只在 from===CANCELLED_STATUS 才需要考慮這件事：from==='completed' 的訂單能走到「已完成」
    // 必然依序經過「已成交」，代表當初的扣庫存從來沒有被回補沖銷過，不需要、也不應該再扣一次。
    // 恢復目標若是「新詢價」或「已報價」（都在「已成交」之前）也不立即扣庫存——之後這張訂單
    // 如果又走到「已成交」，會由一般狀態更新路由裡既有的扣庫存邏輯（quoted→closed_won）自然處理，
    // 不需要在這裡搶先扣。用 ORDER_STATUS_FLOW 的索引位置判斷「closed_won 或更後面」，跟
    // evaluateStatusTransition() 判斷正常前進/倒退方向同一套資料來源，不另外維護一份順序清單。
    const needsRededuct = from === CANCELLED_STATUS &&
      ORDER_STATUS_FLOW.indexOf(status) >= ORDER_STATUS_FLOW.indexOf('closed_won');
    if (needsRededuct) {
      const deductResult = deductInventoryForOrder({
        orderId,
        productId: order.product?.id,
        qty: order.product?.qty,
        orderLabel: order.friendlyOrderNo || orderId
      });
      if (!deductResult.ok) {
        return res.status(deductResult.status || 500).json({ error: deductResult.error });
      }
    }

    const now = new Date().toISOString();
    order.status = status;
    order.statusUpdatedAt = now;
    appendStatusHistory(order, { from, to: status, action: 'restore', changedAt: now });
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({ success: true, status: order.status, statusUpdatedAt: order.statusUpdatedAt, statusHistory: order.statusHistory });
  } catch (err) {
    console.error('[order-restore-status]', err.message);
    res.status(500).json({ error: '恢復狀態失敗' });
  }
});

// ─── 付款資料：追加式交易紀錄，永遠只增加、不覆蓋不刪除舊交易 ──────────
// 完全獨立於訂單製作狀態（status／statusHistory）之外，新增付款交易不會、也不應該
// 觸碰這兩個欄位，避免「登記收款」被誤解成連帶推進生產流程。
const PAYMENT_TYPES = ['receive', 'refund'];
const PAYMENT_METHODS = ['bank_transfer', 'cash', 'card', 'other'];
const PAYMENT_REFERENCE_MAX_LEN = 100;
const PAYMENT_NOTE_MAX_LEN = 500;
const PAYMENT_MAX_AMOUNT = 10000000; // 純防呆用的合理上限（單筆一千萬），不是實際營業額度限制
const PAYMENT_ACTOR = 'admin'; // 跟訂單負責人／內部備註／狀態歷程同一套安全考量：固定寫死，不接受前端傳入
// crypto.randomUUID() 產生的標準 UUID 格式；只驗證格式，不限定版本位元，避免未來換一套產生器就要跟著改規則。
const PAYMENT_IDEMPOTENCY_KEY_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 判斷兩筆付款交易「內容」是否相同（用於冪等重放比對），故意不比對 createdAt／actor／idempotencyKey
// 本身，這三者要嘛是伺服器產生、要嘛就是比對的 key，不該影響「是不是同一筆交易」的判斷。
function paymentTransactionContentMatches(a, b) {
  return a.type === b.type &&
    a.amount === b.amount &&
    a.method === b.method &&
    (a.reference || null) === (b.reference || null) &&
    (a.note || null) === (b.note || null);
}

// 根據交易紀錄計算付款摘要：累計收款／累計退款／實收金額（收款減退款）／尚欠金額／付款狀態。
// 「尚欠金額」需要一個明確的報價總額（quote.total）當作目標金額才算得出來，priceOnInquiry
// 或缺報價的訂單無法判斷「欠多少」，owed 一律回傳 null，交由呼叫端顯示為「--」。
function computePaymentSummary(order) {
  const txs = Array.isArray(order.paymentTransactions) ? order.paymentTransactions : [];
  let totalReceived = 0, totalRefunded = 0;
  txs.forEach(t => {
    if (t.type === 'receive' && typeof t.amount === 'number' && Number.isFinite(t.amount)) totalReceived += t.amount;
    else if (t.type === 'refund' && typeof t.amount === 'number' && Number.isFinite(t.amount)) totalRefunded += t.amount;
  });
  const netReceived = totalReceived - totalRefunded;
  const target = resolveReceivableTotal(order);
  const owed = target !== null ? Math.max(0, target - netReceived) : null;

  let paymentStatus;
  if (totalReceived === 0) {
    paymentStatus = 'unpaid';
  } else if (netReceived <= 0) {
    paymentStatus = 'refunded'; // 曾經收過款，但退款後淨收款歸零或以下＝全額退款
  } else if (target !== null && netReceived >= target) {
    paymentStatus = 'paid';
  } else {
    paymentStatus = 'partial'; // 有淨收款但未達報價總額，或報價總額未知時的保守判斷
  }
  return { totalReceived, totalRefunded, netReceived, owed, paymentStatus };
}

// ─── API：新增付款交易（收款／退款）─────────────────────
app.post('/api/orders/:orderId/payment-transactions', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[order-payment-transaction]', err.message);
    return res.status(500).json({ error: '付款交易新增失敗' });
  }
  // 已封存訂單的唯讀檢查必須排在所有 body 欄位驗證之前：否則空白／格式錯誤的 body 會先被
  // 判成 400（欄位驗證錯誤），已封存訂單不論 body 內容為何都要優先回傳 409。
  if (guardOrderNotArchived(order, res)) return;

  const type = req.body?.type;
  if (!PAYMENT_TYPES.includes(type)) {
    return res.status(400).json({ error: '交易類型不正確' });
  }

  // 金額必須是有限正數：拒絕字串、0、負數、NaN、Infinity；另外設一個合理上限防呆。
  const amount = req.body?.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: '金額必須是大於 0 的有限數字' });
  }
  if (amount > PAYMENT_MAX_AMOUNT) {
    return res.status(400).json({ error: `金額不可超過 NT$ ${PAYMENT_MAX_AMOUNT.toLocaleString()}` });
  }

  const method = req.body?.method;
  if (!PAYMENT_METHODS.includes(method)) {
    return res.status(400).json({ error: '付款方式不正確' });
  }

  const referenceRaw = req.body?.reference;
  if (referenceRaw !== undefined && referenceRaw !== null && typeof referenceRaw !== 'string') {
    return res.status(400).json({ error: '交易編號格式不正確' });
  }
  const reference = (referenceRaw || '').trim();
  if (reference.length > PAYMENT_REFERENCE_MAX_LEN) {
    return res.status(400).json({ error: `交易編號長度不可超過 ${PAYMENT_REFERENCE_MAX_LEN} 字` });
  }

  const noteRaw = req.body?.note;
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== 'string') {
    return res.status(400).json({ error: '內部說明格式不正確' });
  }
  const note = (noteRaw || '').trim();
  if (note.length > PAYMENT_NOTE_MAX_LEN) {
    return res.status(400).json({ error: `內部說明長度不可超過 ${PAYMENT_NOTE_MAX_LEN} 字` });
  }

  // 冪等鍵：同一筆使用者意圖的付款操作（含網路中斷或使用者手動重試）必須帶同一組 key，
  // 讓後端能辨識「這是同一次操作再送一次」，不是「新的一筆交易」。一律要求合法 UUID 格式，
  // 不接受空白或任意字串，避免變成形同虛設的防呆。
  const idempotencyKey = req.body?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !PAYMENT_IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    return res.status(400).json({ error: 'idempotencyKey 必須是合法的 UUID' });
  }

  try {
    const existingTxs = Array.isArray(order.paymentTransactions) ? order.paymentTransactions : [];

    // 冪等檢查一定要在退款餘額檢查與寫入之前完成：一筆已經成功寫入的退款重送時，
    // 此時的可退款餘額已經因為那筆退款而改變，如果先做餘額檢查會誤判成「超額退款」而失敗，
    // 明明這筆退款本來就已經成功過。先比對 key，命中就直接回放結果，完全不重新計算餘額。
    const existingByKey = existingTxs.find(t => t.idempotencyKey === idempotencyKey);
    if (existingByKey) {
      const incoming = { type, amount, method, reference: reference || null, note: note || null };
      if (paymentTransactionContentMatches(existingByKey, incoming)) {
        return res.json({
          success: true,
          idempotentReplay: true,
          transaction: existingByKey,
          paymentTransactions: existingTxs,
          paymentSummary: computePaymentSummary(order)
        });
      }
      return res.status(409).json({ error: '這組付款交易識別碼已用於另一筆內容不同的交易，請重新整理後再試一次' });
    }

    // 退款金額不可超過目前可退款餘額（已收款總額 － 已退款總額），避免退超過實際收到的錢。
    if (type === 'refund') {
      const { totalReceived, totalRefunded } = computePaymentSummary(order);
      const refundableBalance = totalReceived - totalRefunded;
      if (amount > refundableBalance + 1e-6) {
        return res.status(400).json({
          error: `退款金額超過可退款餘額（已收款 NT$ ${totalReceived.toLocaleString()}，已退款 NT$ ${totalRefunded.toLocaleString()}，可退 NT$ ${Math.max(0, refundableBalance).toLocaleString()}）`
        });
      }
    }

    if (!Array.isArray(order.paymentTransactions)) order.paymentTransactions = [];
    const transaction = {
      type,
      amount,
      method,
      reference: reference || null,
      note: note || null,
      createdAt: new Date().toISOString(),
      actor: PAYMENT_ACTOR,
      idempotencyKey
    };
    order.paymentTransactions.push(transaction);
    // 刻意不動 order.status／order.statusUpdatedAt／order.statusHistory：付款只是財務紀錄，
    // 不代表訂單製作進度改變，兩者要分開由後台人員各自手動操作。
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({
      success: true,
      idempotentReplay: false,
      transaction,
      paymentTransactions: order.paymentTransactions,
      paymentSummary: computePaymentSummary(order)
    });
  } catch (err) {
    console.error('[order-payment-transaction]', err.message);
    res.status(500).json({ error: '付款交易新增失敗' });
  }
});

// ─── API：人工調價（折扣／額外費用／運費／稅額）───────────────
// 追加式歷程：pricingAdjustments 只增加、不覆蓋不刪除舊紀錄；原始 order.quote 永遠不被
// 修改，代表「系統自動報價」這個事實紀錄，人工調整是另外疊加在上面的一層。
// 驗證與金額計算全部委派給 pricing-adjustment.js 的純函式，這裡只負責 HTTP 流程與檔案讀寫。
app.post('/api/orders/:orderId/pricing-adjustments', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[pricing-adjustment]', err.message);
    return res.status(500).json({ error: '人工調價新增失敗' });
  }
  // 已封存訂單的唯讀檢查必須排在所有 body 欄位驗證之前：否則空白／格式錯誤的 body 會先被
  // 判成 400（欄位驗證錯誤），已封存訂單不論 body 內容為何都要優先回傳 409。
  if (guardOrderNotArchived(order, res)) return;

  const fieldsResult = validateAdjustmentFields(req.body);
  if (!fieldsResult.ok) {
    return res.status(400).json({ error: fieldsResult.error });
  }
  const { discountAmount, extraFee, shippingFee, taxRate, reason, idempotencyKey } = fieldsResult;

  const baseResult = resolveBaseAmount(order, req.body?.manualBaseAmount);
  if (!baseResult.ok) {
    return res.status(400).json({ error: baseResult.error });
  }
  const { baseAmount, baseSource } = baseResult;

  try {
    const existingAdjustments = Array.isArray(order.pricingAdjustments) ? order.pricingAdjustments : [];

    // 冪等檢查：同一組 idempotencyKey 之前已經寫入過，比對「調整意圖」內容是否相同，
    // 完全相同就直接回放舊紀錄（不重算、不新增），內容不同則回傳 409、不寫入。
    const existingByKey = existingAdjustments.find(a => a.idempotencyKey === idempotencyKey);
    if (existingByKey) {
      const incoming = { baseAmount, baseSource, discountAmount, extraFee, shippingFee, taxRate, reason };
      if (adjustmentContentMatches(existingByKey, incoming)) {
        return res.json({
          success: true,
          idempotentReplay: true,
          adjustment: existingByKey,
          currentPricing: computeCurrentPricing(order)
        });
      }
      return res.status(409).json({ error: '這組人工調價識別碼已用於另一筆內容不同的調整，請重新整理後再試一次' });
    }

    const amountsResult = computeAdjustmentAmounts({
      baseAmount, discountAmount, extraFee, shippingFee, taxRate
    });
    if (!amountsResult.ok) {
      return res.status(400).json({ error: amountsResult.error });
    }
    const { preTaxAmount, taxAmount, finalTotal } = amountsResult;

    const adjustment = {
      id: crypto.randomUUID(),
      idempotencyKey,
      baseAmount,
      baseSource,
      discountAmount,
      extraFee,
      shippingFee,
      taxRate,
      taxAmount,
      preTaxAmount,
      finalTotal,
      reason,
      actor: 'admin', // 後台目前只有單一組共用密碼，還沒有多帳號機制，固定寫死，不接受前端傳入
      createdAt: new Date().toISOString()
    };

    if (!Array.isArray(order.pricingAdjustments)) order.pricingAdjustments = [];
    order.pricingAdjustments.push(adjustment);
    // 刻意不動 order.quote：那是系統自動報價的原始事實紀錄，人工調整永遠是疊加在上面的
    // 另一層歷程，不可被覆蓋或刪除，之後任何時候都能重新算出「原始報價 vs 人工調整後」的差異。
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');

    res.json({
      success: true,
      idempotentReplay: false,
      adjustment,
      currentPricing: computeCurrentPricing(order)
    });
  } catch (err) {
    console.error('[pricing-adjustment]', err.message);
    res.status(500).json({ error: '人工調價新增失敗' });
  }
});

// ─── API：報價版本及有效期限（發布用，只能追加，不提供修改／刪除）──────
// 報價版本是「發布當下的完整事實證據」：一旦建立就不可再變動，之後價格若有異動，只能發布
// 下一個版本（V2、V3…），不可回頭修改已發布的版本。驗證與快照建立全部委派給 quote-version.js
// 的純函式，這裡只負責 HTTP 流程、檔案讀寫，以及嚴格的處理順序（見下方每一步的註解編號）。
app.post('/api/orders/:orderId/quote-versions', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  // 2. 驗證 orderId 格式
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  // 3. 確認訂單存在
  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  // 4. 讀取訂單
  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[quote-version]', err.message);
    return res.status(500).json({ error: '報價版本發布失敗' });
  }

  // 5. 已封存訂單一律優先擋下：不論 body 是否合法，排在所有 body 檢查之前。
  if (guardOrderNotArchived(order, res)) return;

  // 6. 驗證冪等 key 格式，並檢查是否已經發布過——這一步必須排在「重新解析目前可發布報價」
  // 之前完成：如果第一次發布其實已經成功、只是回應在半路遺失，即使之後人工調價又發生變動，
  // 同一個發布請求重試時仍要原封不動回放第一次建立的版本，不可以依照「現在」變動後的新價格
  // 另外做出一個內容不同的版本。
  const idempotencyKey = req.body?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !QUOTE_VERSION_IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    return res.status(400).json({ error: 'idempotencyKey 必須是合法的 UUID' });
  }

  try {
    const existingVersions = Array.isArray(order.quoteVersions) ? order.quoteVersions : [];
    const existingByKey = existingVersions.find(v => v.idempotencyKey === idempotencyKey);
    if (existingByKey) {
      if (quoteVersionIntentMatches(existingByKey, req.body)) {
        // 完全相同的發布意圖：直接回放既有版本，不重新計算、不新增第二個版本、不重寫檔案。
        return res.json({
          success: true,
          idempotentReplay: true,
          quoteVersion: existingByKey,
          quoteVersions: existingVersions
        });
      }
      return res.status(409).json({ error: '這組報價版本識別碼已用於另一筆內容不同的發布請求，請重新整理後再試一次' });
    }

    // 7. 驗證 body（validDays／notes）
    const fieldsResult = validatePublishFields(req.body);
    if (!fieldsResult.ok) {
      return res.status(400).json({ error: fieldsResult.error });
    }
    const { validDays, notes } = fieldsResult;

    // 8. 解析目前可發布報價：一般商品沒有調整過就用原始 quote.total，有調整過用最後一筆
    // pricingAdjustments；priceOnInquiry 商品沒有調整過完全無法發布，回傳明確錯誤。
    const pricingResult = resolvePublishablePricing(order);
    if (!pricingResult.ok) {
      return res.status(400).json({ error: pricingResult.error });
    }

    // 9. 建立完整快照（id／版本號／時間全部由後端產生，前端夾帶的任何同名欄位一律忽略不採用）
    const versionNumber = nextVersionNumber(existingVersions);
    const quoteVersion = buildQuoteVersionSnapshot(order, {
      id: crypto.randomUUID(),
      idempotencyKey,
      versionNumber,
      validDays,
      notes,
      now: new Date(),
      pricing: pricingResult
    });

    // 10. 追加 quoteVersions（只增加，不覆蓋、不修改、不刪除舊版本）
    if (!Array.isArray(order.quoteVersions)) order.quoteVersions = [];
    order.quoteVersions.push(quoteVersion);

    // 11. 成功後才寫入訂單檔案；刻意不動 order.quote／order.pricingAdjustments，報價版本永遠只是
    // 疊加在既有報價資料之上的「發布快照」，不會、也不可能反過來影響原始報價或人工調整歷程。
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');

    res.json({
      success: true,
      idempotentReplay: false,
      quoteVersion,
      quoteVersions: order.quoteVersions
    });
  } catch (err) {
    console.error('[quote-version]', err.message);
    res.status(500).json({ error: '報價版本發布失敗' });
  }
});

// ─── API：客戶報價確認（accepted／rejected，後端基礎）───────────────
// 只允許回覆訂單目前「最新」的報價版本；一旦回覆就不可再被覆蓋或產生第二筆——每個
// quoteVersion 最多只有一筆 customerResponse（單一物件，不是陣列），跟報價版本本身
// 一樣是「事實證據」，只能追加、不能修改。accepted／rejected 本身刻意完全不觸發
// order.status、庫存、付款或任何通知的連動，這些都是未來各自獨立的階段，本階段只
// 負責忠實記錄客戶回覆這件事實本身。驗證與比對全部委派給 quote-customer-response.js
// 的純函式，這裡只負責 HTTP 流程、檔案讀寫，以及嚴格的處理順序（見下方編號）。
app.post('/api/orders/:orderId/quote-versions/:versionId/customer-response', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  // 2. 驗證 orderId／versionId 格式（versionId 跟報價版本的 id 一樣是 crypto.randomUUID()）
  const { orderId, versionId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  if (typeof versionId !== 'string' || !QUOTE_RESPONSE_IDEMPOTENCY_KEY_REGEX.test(versionId)) {
    return res.status(400).json({ error: '報價版本編號格式不正確' });
  }

  // 3. 確認訂單存在
  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  // 4. 讀取訂單
  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[quote-customer-response]', err.message);
    return res.status(500).json({ error: '客戶報價回覆失敗' });
  }

  // 5. 已封存訂單一律優先擋下：不論 body 或版本狀態為何，排在所有後續檢查之前。
  if (guardOrderNotArchived(order, res)) return;

  // 6. 確認該報價版本存在
  const quoteVersions = Array.isArray(order.quoteVersions) ? order.quoteVersions : [];
  const quoteVersion = quoteVersions.find(v => v && v.id === versionId);
  if (!quoteVersion) {
    return res.status(404).json({ error: '找不到此報價版本' });
  }

  // 7. 驗證 idempotencyKey 格式——這一步必須排在「檢查是否已經回覆過」之前，因為判斷
  // 是不是同一次重試意圖，本來就需要先拿到一組格式合法的 key 才能比較。
  const idempotencyKey = req.body?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !QUOTE_RESPONSE_IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    return res.status(400).json({ error: 'idempotencyKey 必須是合法的 UUID' });
  }

  try {
    // 這個報價版本如果已經有 customerResponse，代表「回覆」這件事已經發生過一次，
    // 之後不論內容如何一律不會再新增第二筆——只有兩種結果：同一組 key 且內容完全
    // 相同 → 安全回放；其他任何情況（同 key 不同內容、或不同 key）→ 409，
    // 完全不重新驗證是否為最新版本、是否過期、decision／note 格式，因為根本不會寫入
    // 任何新資料，這些檢查對「已經有結果的版本」沒有意義。
    const existingResponse = quoteVersion.customerResponse;
    if (existingResponse) {
      if (existingResponse.idempotencyKey === idempotencyKey) {
        if (responseContentMatches(existingResponse, req.body)) {
          return res.json({
            success: true,
            idempotentReplay: true,
            customerResponse: existingResponse,
            quoteVersion
          });
        }
        return res.status(409).json({ error: '這組報價確認識別碼已用於另一筆內容不同的回覆，請重新整理後再試一次' });
      }
      return res.status(409).json({ error: '此報價版本已經回覆過，不可重複回覆' });
    }

    // 8. 只允許回覆目前最新的報價版本
    if (!isLatestQuoteVersion(quoteVersions, versionId)) {
      return res.status(409).json({ error: '只能回覆目前最新的報價版本，請重新整理後確認最新版本' });
    }

    // 9. validUntil 必須是合法日期且尚未過期
    const expiryResult = checkQuoteVersionNotExpired(quoteVersion, new Date());
    if (!expiryResult.ok) {
      return res.status(409).json({ error: expiryResult.error });
    }

    // 10. 驗證 decision／note（idempotencyKey 格式已在第 7 步驗證過，這裡一併回傳整理後的值）
    const fieldsResult = validateResponseFields(req.body);
    if (!fieldsResult.ok) {
      return res.status(400).json({ error: fieldsResult.error });
    }
    const { decision, note } = fieldsResult;

    // 11. 建立回覆快照（respondedAt／actor 由後端產生，前端無法指定）
    const customerResponse = buildCustomerResponse({ decision, note, idempotencyKey, now: new Date() });

    // 12. 只在指定的 quoteVersion 物件上追加 customerResponse 這個欄位，完全不修改或
    // 重新計算商品／客戶／金額／有效期限等既有快照內容，也不動 order.status、
    // order.pricingAdjustments、付款、物流等其他資料。
    quoteVersion.customerResponse = customerResponse;
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');

    res.json({
      success: true,
      idempotentReplay: false,
      customerResponse,
      quoteVersion
    });
  } catch (err) {
    console.error('[quote-customer-response]', err.message);
    res.status(500).json({ error: '客戶報價回覆失敗' });
  }
});

// ─── API：客戶確認 Token（建立／重新產生，供公開安全存取用）─────────────
// 只有管理員能建立或重新產生 Token；原始 Token 只在這次回應中出現一次，訂單資料永遠
// 只保存 SHA-256 雜湊，之後任何人（包含開發者查看訂單檔案）都無法反推出原始 Token。
// 重新產生時直接覆蓋（不是追加）舊的 customerAccess，等於讓舊 Token 立即失效——舊值從此
// 在任何地方都比對不到，公開 API 掃描時自然找不到這筆訂單。
app.post('/api/orders/:orderId/quote-versions/:versionId/customer-access', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId, versionId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  if (typeof versionId !== 'string' || !QUOTE_RESPONSE_IDEMPOTENCY_KEY_REGEX.test(versionId)) {
    return res.status(400).json({ error: '報價版本編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[quote-customer-access]', err.message);
    return res.status(500).json({ error: '客戶確認連結建立失敗' });
  }

  if (guardOrderNotArchived(order, res)) return;

  const quoteVersions = Array.isArray(order.quoteVersions) ? order.quoteVersions : [];
  const quoteVersion = quoteVersions.find(v => v && v.id === versionId);
  if (!quoteVersion) {
    return res.status(404).json({ error: '找不到此報價版本' });
  }

  if (!isLatestQuoteVersion(quoteVersions, versionId)) {
    return res.status(409).json({ error: '只能為目前最新的報價版本建立客戶確認連結' });
  }

  const now = new Date();
  const expiryResult = checkQuoteVersionNotExpired(quoteVersion, now);
  if (!expiryResult.ok) {
    return res.status(409).json({ error: expiryResult.error });
  }

  // 已經有客戶回覆（accepted／rejected）的版本代表這個決定已經確定，不可能再重新開放確認，
  // 也就沒有必要（也不應該）再建立一組新的存取連結。
  if (quoteVersion.customerResponse) {
    return res.status(409).json({ error: '此報價版本已經有客戶回覆，不可再建立確認連結' });
  }

  try {
    const token = generateRawToken();
    const tokenHash = hashToken(token);
    // expiresAt 直接採用該報價版本的 validUntil，確保「不得超過報價版本 validUntil」
    // 這個規則不需要額外比較邏輯，天然成立。
    const customerAccess = buildCustomerAccessRecord({ tokenHash, now, expiresAt: quoteVersion.validUntil });

    quoteVersion.customerAccess = customerAccess;
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');

    // 原始 token 只在這次回應中出現一次；下面刻意不用 console.log 記錄任何內容，
    // 避免不小心把 token 留在伺服器日誌裡。
    res.json({
      success: true,
      token,
      expiresAt: customerAccess.expiresAt,
      versionId: quoteVersion.id,
      versionLabel: quoteVersion.versionLabel
    });
  } catch (err) {
    console.error('[quote-customer-access]', err.message);
    res.status(500).json({ error: '客戶確認連結建立失敗' });
  }
});

// ─── 公開報價確認：安全 Token 存取（無需登入，供客戶端使用）──────────────
// Token 對應到哪一筆訂單、哪一個報價版本，只能靠掃描 ORDER_DIR 逐一比對
// customerAccess.tokenHash 才能得知——訂單檔名／內容本身跟 token 完全無關，
// 不可能靠猜檔名或訂單編號找到，符合「只有拿到合法 token 才找得到資料」的最小揭露原則。
function findOrderAndVersionByTokenHash(tokenHash) {
  const files = fs.readdirSync(ORDER_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    let order;
    try {
      order = JSON.parse(fs.readFileSync(path.join(ORDER_DIR, file), 'utf8'));
    } catch {
      continue; // 單一檔案壞掉不影響其他訂單的查詢
    }
    const quoteVersions = Array.isArray(order.quoteVersions) ? order.quoteVersions : [];
    for (const v of quoteVersions) {
      if (v && v.customerAccess && safeCompareHash(v.customerAccess.tokenHash, tokenHash)) {
        return { order, orderJsonPath: path.join(ORDER_DIR, file), quoteVersion: v };
      }
    }
  }
  return null;
}

// 公開端點的基本頻率限制：避免暴力嘗試猜測 token。跟既有 aiRateLimit 同一套滑動視窗設計，
// 但用獨立的 Map，不共用 AI 功能的額度，也不影響一般訂單／後台 API。
const PUBLIC_QUOTE_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 分鐘
const PUBLIC_QUOTE_RATE_LIMIT_MAX_PER_IP = 60; // 正常客戶單次確認流程只會用到 1 次 GET＋1 次 POST，這個上限主要是擋暴力猜測 token
const _publicQuoteIpHits = new Map();
function publicQuoteRateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const hits = (_publicQuoteIpHits.get(ip) || []).filter(t => now - t < PUBLIC_QUOTE_RATE_LIMIT_WINDOW_MS);
  if (hits.length >= PUBLIC_QUOTE_RATE_LIMIT_MAX_PER_IP) {
    return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
  }
  hits.push(now);
  _publicQuoteIpHits.set(ip, hits);
  next();
}

// 找不到、格式不對、雜湊比對不到、token 本身過期——全部回傳同一句錯誤訊息與同一個
// HTTP 狀態碼，避免攻擊者透過訊息差異判斷「這個 token 格式對但查無資料」還是
// 「這個訂單／版本根本不存在」，任何一種都不該洩漏比「連結失效」更多的資訊。
const PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE = '此連結無效或已失效，請洽業務確認';

app.get('/api/public/quote-confirmations/:token', publicQuoteRateLimit, (req, res) => {
  const { token } = req.params;
  if (!isValidTokenFormat(token)) {
    return res.status(404).json({ error: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE });
  }
  const tokenHash = hashToken(token);
  try {
    const found = findOrderAndVersionByTokenHash(tokenHash);
    if (!found) {
      return res.status(404).json({ error: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE });
    }
    const now = new Date();
    const access = evaluatePublicAccess(found.order, found.quoteVersion, tokenHash, now);
    if (!access.ok) {
      // 讀取這個閘門一律用同一句訊息：GET 是唯讀操作，不需要（也不應該）額外揭露
      // 「是封存、過期、還是被取代」，這些細節只在客戶已經確認可以寫入（POST）時才有意義。
      return res.status(404).json({ error: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE });
    }
    const status = resolvePublicQuoteStatus(found.quoteVersion, now);
    res.json({ success: true, quote: buildPublicQuoteConfirmationView(found.quoteVersion, status) });
  } catch (err) {
    console.error('[public-quote-confirmation]', err.message); // 絕不記錄原始 token 或其雜湊
    res.status(500).json({ error: '報價資料讀取失敗' });
  }
});

app.post('/api/public/quote-confirmations/:token/response', publicQuoteRateLimit, (req, res) => {
  const { token } = req.params;
  if (!isValidTokenFormat(token)) {
    return res.status(404).json({ error: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE });
  }
  const tokenHash = hashToken(token);

  let found;
  try {
    found = findOrderAndVersionByTokenHash(tokenHash);
  } catch (err) {
    console.error('[public-quote-response]', err.message);
    return res.status(500).json({ error: '客戶報價回覆失敗' });
  }
  if (!found) {
    return res.status(404).json({ error: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE });
  }

  const { order, orderJsonPath, quoteVersion } = found;

  // 已封存訂單一律最優先擋下——不論是全新的回覆、或是同 idempotencyKey 的重放請求都不
  // 例外，跟其他既有寫入 API（人工調價／報價版本／管理員版 customer-response）同一套
  // 「已封存訂單不論 body 或內部狀態為何都優先回傳 409」原則，排在所有其他檢查之前。
  if (isOrderArchived(order)) {
    return res.status(409).json({ error: '此訂單已封存，無法確認報價，請洽業務確認' });
  }

  try {
    // 存取閘門必須排在 idempotencyKey 格式檢查與 existingResponse 冪等比對之前——
    // token 是否過期、這個版本是否還是最新版本、報價本身是否過期，這些都是「這個連結
    // 現在還能不能用」的問題，不論是全新回覆還是同 key 重送都必須先過這一關；
    // 如果先看 existingResponse 再看存取閘門，會出現「同一組 key、內容也相符」就被
    // 誤判成可以安全回放，但其實 token 已經過期、或訂單已經追加了更新的報價版本
    // 取代掉這個 token 指向的版本——這種情況絕不能回傳 200 與 quote 資料，只能告知
    // 連結已失效／已被取代，逼客戶回頭跟業務要最新連結。
    const now = new Date();
    const access = evaluatePublicAccess(order, quoteVersion, tokenHash, now);
    if (!access.ok) {
      const reasonMessages = {
        not_latest: '此報價版本已不是最新版本，請洽業務取得最新的確認連結',
        quote_expired: '此報價版本已過期，無法確認，請洽業務重新發布報價版本',
        token_expired: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE,
        not_found: PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE,
        archived: '此訂單已封存，無法確認報價，請洽業務確認'
      };
      return res.status(409).json({ error: reasonMessages[access.reason] || PUBLIC_QUOTE_INVALID_TOKEN_MESSAGE });
    }

    const idempotencyKey = req.body?.idempotencyKey;
    if (typeof idempotencyKey !== 'string' || !QUOTE_RESPONSE_IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
      return res.status(400).json({ error: 'idempotencyKey 必須是合法的 UUID' });
    }

    // 完全共用既有的 customerResponse 冪等比對邏輯（responseContentMatches），不另外
    // 複製一套規則：同一組 key 且內容相符 → 安全回放；其他任何情況（同 key 不同內容、
    // 或不同 key）→ 一律 409。走到這裡代表存取閘門已經通過（token 未過期、仍是最新
    // 版本、報價本身未過期），安全回放的內容一定是「這個連結現在仍然有效」的結果。
    const existingResponse = quoteVersion.customerResponse;
    if (existingResponse) {
      if (existingResponse.idempotencyKey === idempotencyKey) {
        if (responseContentMatches(existingResponse, req.body)) {
          const status = resolvePublicQuoteStatus(quoteVersion, now);
          return res.json({
            success: true,
            idempotentReplay: true,
            quote: buildPublicQuoteConfirmationView(quoteVersion, status)
          });
        }
        return res.status(409).json({ error: '這組報價確認識別碼已用於另一筆內容不同的回覆，請重新整理後再試一次' });
      }
      return res.status(409).json({ error: '此報價版本已經回覆過，不可重複回覆' });
    }

    // decision／note／idempotencyKey 格式驗證，跟管理員版 customer-response 完全共用
    // 同一個 validateResponseFields()，不另外實作一套規則（note:null 等非法型別會在
    // 這裡被擋下，回傳 400，不會被靜默正規化）。
    const fieldsResult = validateResponseFields(req.body);
    if (!fieldsResult.ok) {
      return res.status(400).json({ error: fieldsResult.error });
    }
    const { decision, note } = fieldsResult;

    const customerResponse = buildCustomerResponse({ decision, note, idempotencyKey, now });

    // 只在指定的 quoteVersion 物件上追加 customerResponse，完全不修改或重新計算商品／
    // 客戶／金額／有效期限等既有快照內容，也不動 order.status、庫存、付款、物流、
    // customerAccess 等其他資料——accepted 不自動改狀態／扣庫存／建立付款／寄信，
    // rejected 也不自動發布新版本。
    quoteVersion.customerResponse = customerResponse;
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');

    // 統一通知系統批次：客戶接受／拒絕報價通知業務。idempotencyKey直接沿用客戶送出的
    // idempotencyKey（已通過上面QUOTE_RESPONSE_IDEMPOTENCY_KEY_REGEX格式驗證且唯一對應
    // 這一次回覆），天生保證同一次客戶回覆只會建立一筆通知事件，就算網路重送也不會重複。
    emitNotificationEvent({
      eventType: decision === 'accepted' ? 'quote_accepted' : 'quote_rejected',
      idempotencyKey: idempotencyKey,
      title: `客戶${decision === 'accepted' ? '接受' : '拒絕'}報價：${order.friendlyOrderNo || order.orderId}`,
      summary: note ? `客戶留言：${String(note).slice(0, 200)}` : null,
      severity: 'normal',
      resourceType: 'order',
      resourceId: order.orderId
    });

    const status = resolvePublicQuoteStatus(quoteVersion, now);
    res.json({
      success: true,
      idempotentReplay: false,
      quote: buildPublicQuoteConfirmationView(quoteVersion, status)
    });
  } catch (err) {
    console.error('[public-quote-response]', err.message); // 絕不記錄原始 token 或其雜湊
    res.status(500).json({ error: '客戶報價回覆失敗' });
  }
});

// ─── API：訂單負責人（單一目前值，可覆寫／清空成尚未指派）─────────
// 跟客戶自己填寫的 contact.note 是完全不同的欄位，存在訂單 JSON 的 assignee，
// 不會混進客戶備註裡；先用純文字欄位，之後要改成正式帳號清單只要換掉這支 API 的驗證邏輯即可。
const ASSIGNEE_MAX_LEN = 50;
app.post('/api/orders/:orderId/assignee', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[order-assignee]', err.message);
    return res.status(500).json({ error: '訂單負責人更新失敗' });
  }
  // 已封存訂單的唯讀檢查必須排在 body 欄位驗證之前：否則空白／格式錯誤的 body 會先被
  // 判成 400（欄位驗證錯誤），已封存訂單不論 body 內容為何都要優先回傳 409。
  if (guardOrderNotArchived(order, res)) return;

  const raw = req.body?.assignee;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: '訂單負責人格式不正確' });
  }
  const assignee = raw.trim();
  if (assignee.length > ASSIGNEE_MAX_LEN) {
    return res.status(400).json({ error: `訂單負責人長度不可超過 ${ASSIGNEE_MAX_LEN} 字` });
  }

  try {
    // 空字串代表清空指派，統一存 null，跟舊訂單「本來就沒有這個欄位」的語意一致，
    // 前端顯示時都用同一套「沒有值就顯示尚未指派」的判斷，不用再分兩種情況處理。
    order.assignee = assignee || null;
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({ success: true, assignee: order.assignee });
  } catch (err) {
    console.error('[order-assignee]', err.message);
    res.status(500).json({ error: '訂單負責人更新失敗' });
  }
});

// ─── API：內部備註（追加式紀錄，永遠只增加、不覆蓋舊紀錄）──────────
// 同樣跟客戶填寫的 contact.note 分開存放（另一個欄位 internalNotes），只有登入後台的人看得到。
const INTERNAL_NOTE_MAX_LEN = 2000;
app.post('/api/orders/:orderId/internal-notes', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[order-internal-note]', err.message);
    return res.status(500).json({ error: '內部備註新增失敗' });
  }
  // 已封存訂單的唯讀檢查必須排在 body 欄位驗證之前：否則空白／格式錯誤的 body 會先被
  // 判成 400（欄位驗證錯誤），已封存訂單不論 body 內容為何都要優先回傳 409。
  if (guardOrderNotArchived(order, res)) return;

  const raw = req.body?.content;
  if (typeof raw !== 'string') {
    return res.status(400).json({ error: '備註內容格式不正確' });
  }
  const content = raw.trim();
  if (!content) {
    return res.status(400).json({ error: '備註內容不可空白' });
  }
  if (content.length > INTERNAL_NOTE_MAX_LEN) {
    return res.status(400).json({ error: `備註內容長度不可超過 ${INTERNAL_NOTE_MAX_LEN} 字` });
  }

  try {
    // 舊訂單沒有 internalNotes 欄位時安全初始化成空陣列，不會因為欄位不存在而報錯或蓋掉其他資料。
    if (!Array.isArray(order.internalNotes)) order.internalNotes = [];
    // actor 現階段固定寫死 'admin'（後台目前只有單一組共用密碼，還沒有多帳號機制），
    // 完全不接受前端傳入 actor，避免有人偽造成別人留的備註。
    const note = { content, createdAt: new Date().toISOString(), actor: 'admin' };
    order.internalNotes.push(note);
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({ success: true, note, internalNotes: order.internalNotes });
  } catch (err) {
    console.error('[order-internal-note]', err.message);
    res.status(500).json({ error: '內部備註新增失敗' });
  }
});

// ─── 物流資料：追加式紀錄，永遠只增加、不覆蓋不刪除舊紀錄 ──────────
// 跟付款交易同一套冪等設計（沿用 PAYMENT_IDEMPOTENCY_KEY_REGEX 的 UUID 格式規則），
// 完全獨立於訂單製作狀態（status／statusHistory）與付款資料（paymentTransactions）之外，
// 新增物流紀錄不會、也不應該觸碰這些欄位或客戶聯絡資料。
const LOGISTICS_STATUSES = ['preparing', 'shipped', 'delivered', 'returned'];
const LOGISTICS_STATUS_LABELS = { preparing: '備貨中', shipped: '已出貨', delivered: '已送達', returned: '已退回' };
const LOGISTICS_CARRIER_MAX_LEN = 50;
const LOGISTICS_TRACKING_MAX_LEN = 100;
const LOGISTICS_NOTE_MAX_LEN = 500;
const LOGISTICS_ACTOR = 'admin'; // 跟訂單負責人／內部備註／狀態歷程／付款交易同一套安全考量：固定寫死，不接受前端傳入

// 判斷兩筆物流紀錄「內容」是否相同（用於冪等重放比對），故意不比對 createdAt／actor／
// idempotencyKey 本身，這三者要嘛是伺服器產生、要嘛就是比對的 key，不該影響「是不是同一筆」的判斷。
function logisticsRecordContentMatches(a, b) {
  return a.carrier === b.carrier &&
    (a.trackingNumber || null) === (b.trackingNumber || null) &&
    a.status === b.status &&
    (a.note || null) === (b.note || null);
}

// ─── API：新增物流紀錄 ─────────────────────────
app.post('/api/orders/:orderId/logistics', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch (err) {
    console.error('[order-logistics]', err.message);
    return res.status(500).json({ error: '物流紀錄新增失敗' });
  }
  // 已封存訂單的唯讀檢查必須排在 body 欄位驗證之前：否則空白／格式錯誤的 body 會先被
  // 判成 400（欄位驗證錯誤），已封存訂單不論 body 內容為何都要優先回傳 409。
  if (guardOrderNotArchived(order, res)) return;

  const carrierRaw = req.body?.carrier;
  if (typeof carrierRaw !== 'string') {
    return res.status(400).json({ error: '物流商格式不正確' });
  }
  const carrier = carrierRaw.trim();
  if (!carrier) {
    return res.status(400).json({ error: '物流商不可空白' });
  }
  if (carrier.length > LOGISTICS_CARRIER_MAX_LEN) {
    return res.status(400).json({ error: `物流商長度不可超過 ${LOGISTICS_CARRIER_MAX_LEN} 字` });
  }

  const trackingRaw = req.body?.trackingNumber;
  if (trackingRaw !== undefined && trackingRaw !== null && typeof trackingRaw !== 'string') {
    return res.status(400).json({ error: '追蹤單號格式不正確' });
  }
  const trackingNumber = (trackingRaw || '').trim();
  if (trackingNumber.length > LOGISTICS_TRACKING_MAX_LEN) {
    return res.status(400).json({ error: `追蹤單號長度不可超過 ${LOGISTICS_TRACKING_MAX_LEN} 字` });
  }

  const status = req.body?.status;
  if (!LOGISTICS_STATUSES.includes(status)) {
    return res.status(400).json({ error: '配送狀態不正確' });
  }

  const noteRaw = req.body?.note;
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== 'string') {
    return res.status(400).json({ error: '備註格式不正確' });
  }
  const note = (noteRaw || '').trim();
  if (note.length > LOGISTICS_NOTE_MAX_LEN) {
    return res.status(400).json({ error: `備註長度不可超過 ${LOGISTICS_NOTE_MAX_LEN} 字` });
  }

  // 冪等鍵：規則與 API 格式完全比照付款交易，同一筆使用者意圖（含網路中斷或手動重試）
  // 必須帶同一組合法 UUID，讓後端能辨識「這是同一次操作再送一次」，不是「新的一筆紀錄」。
  const idempotencyKey = req.body?.idempotencyKey;
  if (typeof idempotencyKey !== 'string' || !PAYMENT_IDEMPOTENCY_KEY_REGEX.test(idempotencyKey)) {
    return res.status(400).json({ error: 'idempotencyKey 必須是合法的 UUID' });
  }

  try {
    const existingRecords = Array.isArray(order.logisticsHistory) ? order.logisticsHistory : [];

    // 冪等檢查一定要在寫入前完成：命中且內容相同直接回放，不重新計算或修改任何東西；
    // 命中但內容不同（同一組 key 被挪去代表另一筆紀錄）視為衝突，回絕且不寫入。
    const existingByKey = existingRecords.find(r => r.idempotencyKey === idempotencyKey);
    if (existingByKey) {
      const incoming = { carrier, trackingNumber: trackingNumber || null, status, note: note || null };
      if (logisticsRecordContentMatches(existingByKey, incoming)) {
        return res.json({
          success: true,
          idempotentReplay: true,
          record: existingByKey,
          logisticsHistory: existingRecords
        });
      }
      return res.status(409).json({ error: '這組物流紀錄識別碼已用於另一筆內容不同的紀錄，請重新整理後再試一次' });
    }

    if (!Array.isArray(order.logisticsHistory)) order.logisticsHistory = [];
    const record = {
      carrier,
      trackingNumber: trackingNumber || null,
      status,
      note: note || null,
      createdAt: new Date().toISOString(),
      actor: LOGISTICS_ACTOR,
      idempotencyKey
    };
    order.logisticsHistory.push(record);
    // 刻意不動 order.status／order.statusUpdatedAt／order.statusHistory／order.paymentTransactions
    // 或任何客戶聯絡資料：物流只是配送紀錄，不代表訂單製作進度或付款狀態改變。
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({
      success: true,
      idempotentReplay: false,
      record,
      logisticsHistory: order.logisticsHistory
    });
  } catch (err) {
    console.error('[order-logistics]', err.message);
    res.status(500).json({ error: '物流紀錄新增失敗' });
  }
});

// ─── 訂單封存／還原：只標記欄位，永遠不刪除訂單檔案 ──────────────
// 舊訂單沒有 archivedAt 欄位時一律視為未封存（isOrderArchived 對 undefined／null 都回傳 false），
// 且這裡完全不會像 status 那樣「讀取時順便補寫」，只有真的呼叫封存 API 才會第一次寫入這些欄位，
// 避免舊資料被意外改寫。archivedBy 固定寫死 'admin'，跟訂單負責人／內部備註／狀態歷程／
// 付款交易／物流紀錄同一套安全考量：完全不接受前端傳入。
const ARCHIVE_REASON_MAX_LEN = 500;
const ARCHIVE_ACTOR = 'admin';

function isOrderArchived(order) {
  return !!order.archivedAt;
}

// 已封存訂單視為唯讀（還原本身除外）：狀態更新、恢復狀態、負責人、內部備註、付款、物流
// 這幾支既有的寫入 API 都在讀到訂單資料後、做任何欄位驗證或寫入之前，先呼叫這支函式擋下來，
// 確保「完全不可修改檔案」不是只靠前端不顯示表單，後端一律會再擋一次。
function guardOrderNotArchived(order, res) {
  if (isOrderArchived(order)) {
    res.status(409).json({ error: '此訂單已封存，為唯讀狀態，請先在「已封存」頁籤還原後再進行此操作' });
    return true;
  }
  return false;
}

app.post('/api/orders/:orderId/archive', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: '封存訂單需要二次確認' });
  }
  const reasonRaw = req.body?.archiveReason;
  if (reasonRaw !== undefined && reasonRaw !== null && typeof reasonRaw !== 'string') {
    return res.status(400).json({ error: '封存原因格式不正確' });
  }
  const archiveReason = (reasonRaw || '').trim();
  if (archiveReason.length > ARCHIVE_REASON_MAX_LEN) {
    return res.status(400).json({ error: `封存原因長度不可超過 ${ARCHIVE_REASON_MAX_LEN} 字` });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  try {
    const order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
    // 重複封存要安全回傳「已經是封存狀態」，不可以再蓋掉原本的封存時間／原因，也不可以報錯。
    if (isOrderArchived(order)) {
      return res.json({
        success: true,
        alreadyArchived: true,
        archivedAt: order.archivedAt,
        archivedBy: order.archivedBy || null,
        archiveReason: order.archiveReason || null
      });
    }
    const now = new Date().toISOString();
    order.archivedAt = now;
    order.archivedBy = ARCHIVE_ACTOR;
    order.archiveReason = archiveReason || null;
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({
      success: true,
      alreadyArchived: false,
      archivedAt: order.archivedAt,
      archivedBy: order.archivedBy,
      archiveReason: order.archiveReason
    });
  } catch (err) {
    console.error('[order-archive]', err.message);
    res.status(500).json({ error: '訂單封存失敗' });
  }
});

app.post('/api/orders/:orderId/unarchive', checkAdminAuth, auditLogMiddleware, requirePermission('orders', 'write'), csrfProtection, (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: '還原訂單需要二次確認' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  try {
    const order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
    // 重複還原（訂單本來就不是封存狀態）要安全回傳，不可以報錯或產生任何寫入。
    if (!isOrderArchived(order)) {
      return res.json({ success: true, alreadyActive: true });
    }
    order.archivedAt = null;
    order.archivedBy = null;
    order.archiveReason = null;
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
    res.json({ success: true, alreadyActive: false });
  } catch (err) {
    console.error('[order-unarchive]', err.message);
    res.status(500).json({ error: '訂單還原失敗' });
  }
});

// ─── 工廠下載包：工具函式 ──────────────────
function computeCropRect(width, height, labelArea) {
  let left = Math.round(width  * labelArea.xRatio);
  let top  = Math.round(height * labelArea.yRatio);
  let w    = Math.round(width  * labelArea.wRatio);
  let h    = Math.round(height * labelArea.hRatio);
  left = Math.max(0, Math.min(left, width  - 1));
  top  = Math.max(0, Math.min(top,  height - 1));
  w    = Math.max(1, Math.min(w, width  - left));
  h    = Math.max(1, Math.min(h, height - top));
  return { left, top, width: w, height: h };
}

function maskEmail(email) {
  if (!email) return '未填寫';
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const masked = user.length <= 2 ? user[0] + '*' : user.slice(0, 2) + '*'.repeat(user.length - 2);
  return `${masked}@${domain}`;
}

function maskPhone(phone) {
  if (!phone) return '未填寫';
  if (phone.length <= 4) return phone;
  return phone.slice(0, 2) + '*'.repeat(Math.max(1, phone.length - 4)) + phone.slice(-2);
}

function buildWorkOrderText(order, product, filesList, maskContact) {
  const p       = order.product || {};
  const contact = order.contact || {};
  const q       = order.quote   || {};
  const priceOnInquiry = !!product?.priceOnInquiry || !!p.priceOnInquiry;
  const sizeText = product
    ? (product.displaySize || `${product.size.w} × ${product.size.h} ${product.size.unit || ''}`.trim())
    : '--';
  const printNote = (product && product.labelArea)
    ? '⚠ 本產品僅印刷「中央印刷區」範圍，請勿印滿整張圖，請以 03_print-file.png（已依實際印刷範圍裁切）為準。'
    : '本產品印刷範圍為整張圖，請直接以 03_print-file.png 印製。';

  return `楊竹科技 — 工廠製作工單
========================================
客戶單號：${order.friendlyOrderNo || '--'}
系統編號：${order.orderId || '--'}
建立時間：${order.savedAt || '--'}

【產品資訊】
商品名稱：${p.name || '--'}
材質　　：${p.material || '--'}
印刷方式：${p.finish || '--'}${p.capacity ? `\n容量　　：${p.capacity}` : ''}
數量　　：${(p.qty || 0).toLocaleString()} 個
尺寸　　：${sizeText}

【檔案清單】
${filesList.map(f => `- ${f}`).join('\n')}

【注意事項】
${printNote}
本工單內容如與網站截圖不一致，請以本工單與 03_print-file.png 為準。

【客戶聯絡資料】${maskContact ? '（已遮蔽）' : ''}
姓名：${contact.name || '--'}
電話：${maskContact ? maskPhone(contact.phone) : (contact.phone || '未填寫')}
Email：${maskContact ? maskEmail(contact.email) : (contact.email || '未填寫')}
備註：${contact.note || '無'}

【預估報價（未稅，僅供估算，非最終請款金額）】
${priceOnInquiry ? '價格由業務確認' : `單價：NT$ ${q.unitPrice != null ? q.unitPrice.toLocaleString() : '--'}
小計：NT$ ${q.subtotal   != null ? q.subtotal.toLocaleString()   : '--'}
製版費：NT$ ${q.setupFee != null ? q.setupFee.toLocaleString()   : '--'}
總計：NT$ ${q.total      != null ? q.total.toLocaleString()      : '--'}`}

--
此工單由楊竹科技線上配置器系統自動產生
`;
}

function buildReadmeText(hasDesign) {
  return `楊竹科技 — 訂單工廠資料包說明
========================================

01_order.json
  完整訂單原始資料（JSON），包含客戶資訊、商品規格、報價明細，供系統/程式讀取用。

02_customer-preview.png
  客戶在網站上看到的完整設計預覽圖，用於業務確認設計內容、客訴時比對用，非印刷用檔案。

03_print-file.png
  工廠實際印刷用圖檔。已依產品類型輸出實際可印刷範圍（悠遊卡／一卡通為整張卡面；隨身碟／保溫杯僅裁切中央印刷區），可直接用於打樣或印刷作業。

04_work-order.txt
  簡易製作工單，列出訂單編號、商品規格、數量、尺寸、印刷方式、注意事項與客戶聯絡資料，供工廠端排單與製作參考。
${hasDesign ? '' : '\n※ 此訂單客戶尚未儲存設計稿，02、03 檔案暫缺，請先與業務確認設計內容。\n'}
如有疑問請聯絡楊竹科技業務窗口。
`;
}

// ─── API：訂單工廠下載包（含裁切後印刷檔 + 工單，打包成 ZIP）──
// 只有後台（ADMIN_TOKEN）可以下載，避免客戶個資與印刷檔外洩
app.get('/api/orders/:orderId/factory-package', checkAdminAuth, auditLogMiddleware, requirePermission('factory_package', 'download'), async (req, res) => {
  const { orderId } = req.params;
  if (!/^[a-zA-Z0-9@._-]+$/.test(orderId)) {
    return res.status(400).json({ error: '訂單編號格式不正確' });
  }

  const orderJsonPath = path.join(ORDER_DIR, `${orderId}.json`);
  if (!fs.existsSync(orderJsonPath)) {
    return res.status(404).json({ error: '找不到此訂單' });
  }

  let order;
  try {
    order = JSON.parse(fs.readFileSync(orderJsonPath, 'utf8'));
  } catch {
    return res.status(500).json({ error: '訂單資料讀取失敗' });
  }

  const maskContact = req.query.mask === '1';
  const product      = getProductById(order.product?.id) || null;
  const pkgDir        = path.join(FACTORY_DIR, orderId);

  // 記錄「工廠包已下載」，讓後台訂單列表能區分哪些訂單還沒被業務拉過工廠包
  try {
    order.factoryPackageDownloadedAt = new Date().toISOString();
    fs.writeFileSync(orderJsonPath, JSON.stringify(order, null, 2), 'utf8');
  } catch (err) {
    console.error('[factory-package] 更新下載紀錄失敗', err.message);
    // 記錄失敗不影響下載本身，繼續往下產生工廠包
  }

  try {
    fs.mkdirSync(pkgDir, { recursive: true });

    const designFile = order.designImageFile;
    const designPath  = designFile ? path.join(ORDER_DIR, designFile) : null;
    const hasDesign   = !!(designPath && fs.existsSync(designPath));

    const filesList = ['01_order.json'];
    if (hasDesign) filesList.push('02_customer-preview.png', '03_print-file.png');
    filesList.push('04_work-order.txt', 'README.txt');

    // 01_order.json — 完整訂單資料
    fs.writeFileSync(path.join(pkgDir, '01_order.json'), JSON.stringify(order, null, 2), 'utf8');

    if (hasDesign) {
      // 02_customer-preview.png — 客戶完整預覽圖（原樣複製）
      const srcBuffer = fs.readFileSync(designPath);
      fs.writeFileSync(path.join(pkgDir, '02_customer-preview.png'), srcBuffer);

      // 03_print-file.png — 工廠印刷用圖：依產品 labelArea 裁切印刷區，無 labelArea 者輸出整張
      let printBuffer = srcBuffer;
      if (product && product.labelArea) {
        const meta = await sharp(srcBuffer).metadata();
        const rect = computeCropRect(meta.width, meta.height, product.labelArea);
        printBuffer = await sharp(srcBuffer).extract(rect).png().toBuffer();
      }
      fs.writeFileSync(path.join(pkgDir, '03_print-file.png'), printBuffer);
    }

    // 04_work-order.txt
    fs.writeFileSync(
      path.join(pkgDir, '04_work-order.txt'),
      buildWorkOrderText(order, product, filesList, maskContact),
      'utf8'
    );

    // README.txt
    fs.writeFileSync(path.join(pkgDir, 'README.txt'), buildReadmeText(hasDesign), 'utf8');

  } catch (err) {
    console.error('[factory-package] 產生檔案失敗', err.message);
    return res.status(500).json({ error: '工廠資料包產生失敗，請稍後再試' });
  }

  // 打包成 ZIP 直接回傳下載（資料夾本身也保留在 factory-packages/ 供後台直接瀏覽）
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${orderId}_factory-package.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('[factory-package] 壓縮失敗', err.message);
    if (!res.headersSent) res.status(500).json({ error: '壓縮失敗' });
  });
  archive.pipe(res);
  archive.directory(pkgDir, false);
  archive.finalize();
});

// ─── API：AI 生圖（gpt-image-2，2026-08-24 由已下架的 dall-e-3 經 gpt-image-1 過渡後，
// 改到官方目前建議的 gpt-image-2，詳見 db.js AI_FEATURE_DEFAULTS 上方註解）──────────────
app.post('/api/generate-image', aiUsageLimitMiddleware('generate_image'), async (req, res) => {
  const tracker = req.aiUsageTracker;

  if (!openai) {
    tracker.setErrorCategory('api_key_missing');
    return res.status(503).json({ error: 'OpenAI API Key 未設定' });
  }

  const cfg = loadAiRouteConfig(res, tracker, 'generate_image', ['generate_image_main']);
  if (!cfg) return;
  tracker.setModel(cfg.model);

  const { prompt, productName, productId } = req.body;
  if (!prompt || prompt.trim().length < 2) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '請輸入描述文字' });
  }
  // productId 必須是正式資料庫中 active 且未封存的商品，不可信任前端另外送來的 productName
  // （那只是拿去代入提示詞當顯示文字用，不是身分依據）；驗證失敗不可以再往下呼叫內容審核
  // 或正式生成，也不會建立 ai_request／ai_result。
  if (!isValidActiveProductId(productId)) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '找不到此商品，請重新整理頁面後再試一次' });
  }

  const enhancedPrompt = cfg.prompts.generate_image_main
    .replace(/\{\{PRODUCT_NAME\}\}/g, productName || '客製化卡片')
    .replace(/\{\{USER_INPUT\}\}/g, prompt.trim());

  tracker.setImageCounts({ requested: 1 });

  const moderation = await runContentModeration(tracker, { text: prompt.trim() });
  if (!moderation.ok) {
    if (moderation.blocked) return res.status(400).json({ error: '內容不符合使用規範，請修改後再試' });
    return res.status(503).json({ error: '內容審核服務暫時無法使用，請稍後再試' });
  }

  if (!reserveAiSiteUsage(req, res).allowed) return; // 真正要呼叫OpenAI前才保留全站每日額度

  tracker.startTrustedAnalytics(productId, resolveAnalyticsContextHashes(req.body, 'generate-image')); // 真正準備呼叫正式生成API的這一刻才建立ai_request

  try {
    tracker.setProviderCalled(true);
    tracker.setProviderCallCount(1);
    // gpt-image-2 的 size／quality 是它自己的固定選項，不是 dall-e-3 那組
    // '1792x1024'／'standard'；1536x1024 是官方文件列出的常用尺寸中最接近原本橫向卡片比例者。
    // response_format 不指定，沿用官方預設的 b64_json。
    const response = await openai.images.generate({
      model:   cfg.model,
      prompt:  enhancedPrompt,
      n:       1,
      size:    '1536x1024',
      quality: 'medium'
    });

    const b64           = response.data[0].b64_json;
    const revisedPrompt = response.data[0].revised_prompt || '';
    tracker.setImageCounts({ generated: 1 });
    tracker.setOutcome('success');
    res.json({
      success:       true,
      imageDataURL:  `data:image/png;base64,${b64}`,
      revisedPrompt
    });
  } catch (err) {
    console.error('[generate-image]', err.status, err.message);
    tracker.setImageCounts({ generated: 0 });
    tracker.setErrorCategory(classifyAiProviderError(err, { treatPlain400AsModeration: true }));
    const msgLower = (err.message || '').toLowerCase();
    // 帳號/組織未驗證：查得到 gpt-image-2 模型（GET /models/gpt-image-2 成功）不代表這個
    // 帳號已經通過組織驗證、可以實際呼叫生成，兩者是分開的檢查，錯誤仍可能在真正呼叫時出現。
    if (err.status === 403 || err.error?.code === 'organization_not_verified' || msgLower.includes('must be verified') || msgLower.includes('verify your organization')) {
      return res.status(403).json({ error: '此功能需要 OpenAI 帳號完成組織驗證才能使用，請聯絡管理員確認設定（platform.openai.com 組織驗證狀態）' });
    }
    if (err.status === 400) return res.status(400).json({ error: '圖片描述違反內容政策，請修改描述後再試' });
    if (err.status === 401) return res.status(401).json({ error: 'API Key 無效' });
    if (err.status === 429) return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    if (err.status === 402) return res.status(402).json({ error: 'OpenAI 帳戶餘額不足，請至 platform.openai.com 儲值' });
    res.status(500).json({ error: '生成失敗，請稍後再試' });
  }
});

// ─── API：AI 設計文字生成 ──────────────────
app.post('/api/generate-design', aiUsageLimitMiddleware('generate_design'), async (req, res) => {
  const tracker = req.aiUsageTracker;
  const { userPrompt, productId, materialName, qty } = req.body;

  if (!userPrompt || userPrompt.trim().length < 2) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '請輸入描述文字' });
  }
  // productId 必須是正式資料庫中 active 且未封存的商品；PRODUCT_NAMES[productId] 只是拿來
  // 代入提示詞的顯示名稱，不能當成身分依據。驗證失敗不可以再往下呼叫內容審核或正式生成。
  if (!isValidActiveProductId(productId)) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '找不到此商品，請重新整理頁面後再試一次' });
  }

  if (!openai) {
    tracker.setErrorCategory('api_key_missing');
    return res.status(503).json({ error: 'OpenAI API Key 尚未設定，AI 功能暫不可用' });
  }

  const cfg = loadAiRouteConfig(res, tracker, 'generate_design', ['generate_design_system']);
  if (!cfg) return;
  tracker.setModel(cfg.model);

  const productName = PRODUCT_NAMES[productId] || '客製化產品';
  const systemPrompt = cfg.prompts.generate_design_system;

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

  const moderation = await runContentModeration(tracker, { text: userPrompt.trim() });
  if (!moderation.ok) {
    if (moderation.blocked) return res.status(400).json({ error: '內容不符合使用規範，請修改後再試' });
    return res.status(503).json({ error: '內容審核服務暫時無法使用，請稍後再試' });
  }

  if (!reserveAiSiteUsage(req, res).allowed) return; // 真正要呼叫OpenAI前才保留全站每日額度

  tracker.startTrustedAnalytics(productId, resolveAnalyticsContextHashes(req.body, 'generate-design')); // 真正準備呼叫正式生成API的這一刻才建立ai_request

  try {
    tracker.setProviderCalled(true);
    tracker.setProviderCallCount(1);
    const completion = await openai.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userMessage  }
      ],
      temperature: 0.85,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    // completion.usage 缺少時（部分相容端點／模擬環境不一定回傳）保留 null，不可以寫成
    // 錯誤的0——0代表「這次真的用了0個token」，null才是「不知道用了多少」。
    const usage = completion.usage || {};
    tracker.setTokens({
      inputTokens:  usage.prompt_tokens ?? null,
      outputTokens: usage.completion_tokens ?? null,
      totalTokens:  usage.total_tokens ?? null
    });

    const raw = completion.choices[0].message.content;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (parseErr) {
      // OpenAI 有正常回應（呼叫本身成功），只是內容不是合法JSON——跟「呼叫OpenAI失敗」是
      // 不同的失敗原因，分類成 response_parse_error 而不是一般的 provider_error。
      tracker.setErrorCategory('response_parse_error');
      throw parseErr;
    }

    tracker.setOutcome('success');
    res.json({ success: true, options: data.options || [], usage: completion.usage });

  } catch (err) {
    console.error('[OpenAI Error]', err.message);
    tracker.setErrorCategory(classifyAiProviderError(err));
    if (err.status === 401) return res.status(401).json({ error: 'API Key 無效，請確認 .env 設定' });
    if (err.status === 429) return res.status(429).json({ error: 'API 請求過於頻繁，請稍後再試' });
    res.status(500).json({ error: '生成失敗，請稍後再試' });
  }
});

// ─── Q版肖像風格庫（id 需與前端 js/ai-design.js 的 CARTOON_STYLES 對應）──
// CARTOON_BASE_PROMPT／BLACK_CARD_PROMPT 兩段主要固定提示詞已改由後台「AI 功能設定」管理
// （見 db.js 的 ai_prompt_settings，prompt_key＝cartoon_image_base／cartoon_image_black_card），
// 四支 AI 路由每次請求即時讀取最新內容（見 loadAiRouteConfig()），這裡不再寫死。
// CARTOON_STYLES 這份風格庫本身不在本階段管理範圍內，仍維持寫死。
const CARTOON_STYLES = {
  classic_kawaii:  'Classic kawaii chibi avatar, big sparkling eyes, round head, tiny body, cheerful and friendly, clean commercial illustration, isolated cutout character only.',
  elegant_festive: 'Elegant festive chibi portrait, refined clean line art, delicate blush, premium red and gold outfit accents, graceful celebratory feeling, isolated cutout character only.',
  sticker_mascot:  'Sticker mascot chibi style, bold outline, simplified cute shapes, playful expression, clean cutout sticker character, suitable for product stickers and custom merchandise.',
  watercolor_soft: 'Soft watercolor chibi portrait, hand-painted texture on the character only, gentle edges, romantic and elegant, isolated cutout character only.'
};
const DEFAULT_CARTOON_STYLE = 'classic_kawaii';

// 尊爵不凡黑卡「圖案製作」專用 prompt（cartoon_image_black_card）與「文字生成圖案」專用
// 系統提示詞（black_card_pattern_system，內含 {{USER_INPUT}}／{{STYLE_PROMPT}} 佔位符，客戶輸入
// 一律當作「主題描述」處理、不會被當成指令執行）已改由後台「AI 功能設定」管理，見上方
// loadAiRouteConfig() 與各路由的實際代換邏輯，這裡不再寫死。

// 三種風格皆強調「實心黑色主體＋負空間五官」，避免部分風格（尤其簡約風）
// 生成結果偏向空心細線外框，導致轉浮雕後圖案幾乎沒有實體、只剩一圈邊線。
const BLACK_CARD_PATTERN_STYLE_PROMPTS = {
  cute_round:     'adorable rounded chibi mascot, predominantly solid black filled character, large friendly head, compact body, soft curves, expressive face created with clean transparent negative-space details, bold connected shapes, suitable for raised embossing',
  minimal_line:   'minimal modern pictogram mascot, bold solid black shapes combined with a limited number of thick contour lines, strong readable silhouette, no fragile thin strokes, no outline-only illustration',
  premium_emblem: 'refined premium mascot portrait, natural relaxed half-body framing with shoulders extending toward one side, elegant negative-space facial details, sophisticated but approachable feeling, suitable for luxury black-on-black embossing, no enclosing circular, oval or medallion background shape behind the character'
};
const DEFAULT_BLACK_CARD_PATTERN_STYLE = 'cute_round';

// 3 張候選圖固定用三種明確不同的構圖方向請求，避免同一組 prompt 連續呼叫 3 次
// 只是同一角色稍微轉頭、彼此差異不足以讓客戶真的有得選。
const BLACK_CARD_PATTERN_COMPOSITION_VARIANTS = [
  'Candidate 1: front-facing seated pose, cutest rounded proportions, clear friendly expression.',
  'Candidate 2: slight three-quarter pose with one simple meaningful gesture, more playful and dynamic.',
  'Candidate 3: natural half-body portrait, subject weighted slightly left-of-center, shoulders extending naturally toward the right side of the frame for a wider half-body silhouette, simplified and refined, no enclosing circular or badge-shaped backdrop.'
];

// 只留下英數字、常見中日文標點與空白，其餘（含所有 HTML/script 標籤）一律移除，
// 避免使用者輸入被誤當成指令或注入內容送進提示詞。長度上限、去空白在呼叫端各自判斷。
function sanitizeBlackCardPromptInput(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<[^>]*>/g, ' ')   // 移除 HTML/script 標籤
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// GPT Image 即使回傳透明背景，偶爾仍會在主體外圍留下一大片中低透明度的圓形光暈/柔光。
// 這些像素若直接送進浮雕流程，會被視為圖案的一部分，在卡面上形成明顯的圓形背景。
// 後端統一把候選圖整理成「純黑＋乾淨 alpha」遮罩：低 alpha 移除，中間值保留短暫漸層
// 作為抗鋸齒，高 alpha 則完全不透明。閾值刻意拉高（96/192 → 150/210）：光暈通常落在
// 中低透明度區間，舊閾值只濾得掉非常淡的雜訊；拉高後，只有真正接近不透明（提示詞
// 要求的「實心黑色主體」）才會保留，光暈本身這種中段透明度區域會被整個清乾淨。
const BLACK_CARD_ALPHA_TRANSPARENT_CUTOFF = 150;
const BLACK_CARD_ALPHA_OPAQUE_CUTOFF = 210;

async function normalizeBlackCardCandidate(base64Png) {
  const input = Buffer.from(base64Png, 'base64');
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const transparentCutoff = BLACK_CARD_ALPHA_TRANSPARENT_CUTOFF;
  const opaqueCutoff = BLACK_CARD_ALPHA_OPAQUE_CUTOFF;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    data[i] = data[i + 1] = data[i + 2] = 0;

    if (alpha <= transparentCutoff) {
      data[i + 3] = 0;
    } else if (alpha >= opaqueCutoff) {
      data[i + 3] = 255;
    } else {
      data[i + 3] = Math.round(((alpha - transparentCutoff) / (opaqueCutoff - transparentCutoff)) * 255);
    }
  }

  // 原始 1024x1024 圖片周圍常有大片透明留白，直接整張塞進卡片會讓人物實際只佔
  // 容器一半左右（外層容器 65% 寬，但人物有效像素被留白稀釋到只剩 45%~50%）。
  // 裁到「非透明內容」的實際外框，再補一點安全邊距，讓人物本身填滿裁切後畫布的
  // 8~9 成，前端 contain 縮放時才會真的把人物放大到規格比例，而不是把大量留白
  // 也一起等比縮放進去。
  let trimmedRaw = data, trimmedInfo = info;
  try {
    const trimmed = await sharp(data, {
      raw: { width: info.width, height: info.height, channels: 4 }
    }).trim({ threshold: 20 }).raw().toBuffer({ resolveWithObject: true });
    trimmedRaw = trimmed.data;
    trimmedInfo = trimmed.info;
  } catch (trimErr) {
    // 極端情況（例如清乾淨後幾乎全透明）trim 會丟例外，這時退回未裁切版本，
    // 至少還有乾淨的 alpha 遮罩可用，不讓整次生成失敗。
    console.warn('[black-card-pattern-candidates] trim failed, fallback to untrimmed:', trimErr.message);
  }

  const marginRatio = 0.06; // 主體占裁切後畫布約 88%，留 6% 邊距避免壓印時貼邊
  const marginX = Math.round(trimmedInfo.width * marginRatio);
  const marginY = Math.round(trimmedInfo.height * marginRatio);

  return sharp(trimmedRaw, {
    raw: { width: trimmedInfo.width, height: trimmedInfo.height, channels: 4 }
  })
    .extend({
      top: marginY, bottom: marginY, left: marginX, right: marginX,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    })
    .png()
    .toBuffer();
}

app.post('/api/black-card-pattern-candidates', aiUsageLimitMiddleware('black_card_pattern'), async (req, res) => {
  const tracker = req.aiUsageTracker;

  if (!openai) {
    tracker.setErrorCategory('api_key_missing');
    return res.status(503).json({ error: 'OpenAI API Key 未設定' });
  }

  const cfg = loadAiRouteConfig(res, tracker, 'black_card_pattern', ['black_card_pattern_system']);
  if (!cfg) return;
  tracker.setModel(cfg.model);

  const rawPrompt = sanitizeBlackCardPromptInput(req.body?.prompt);
  if (rawPrompt.length < 2 || rawPrompt.length > 80) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '請輸入 2～80 字的圖案描述' });
  }
  // 這支路由只服務尊爵不凡黑卡商品，productId 除了要通過一般的active／未封存驗證，
  // 還必須精確等於 'black_card'，不接受其他商品借用這個端點。
  const productId = req.body?.productId;
  if (!isValidActiveProductId(productId) || productId !== 'black_card') {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '此功能僅限尊爵不凡黑卡商品使用' });
  }

  const style = BLACK_CARD_PATTERN_STYLE_PROMPTS[req.body?.style] ? req.body.style : DEFAULT_BLACK_CARD_PATTERN_STYLE;
  const stylePrompt = BLACK_CARD_PATTERN_STYLE_PROMPTS[style];

  const basePrompt = cfg.prompts.black_card_pattern_system
    .replace(/\{\{USER_INPUT\}\}/g, rawPrompt)
    .replace(/\{\{STYLE_PROMPT\}\}/g, stylePrompt);

  const GENERATE_TIMEOUT_MS = 45000;
  const withTimeout = (promise) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { isTimeout: true })), GENERATE_TIMEOUT_MS))
  ]);

  // 2026-08-24 改用官方目前建議的 gpt-image-2（images.generate，純文字生圖，不同於
  // /api/cartoon-image 用的 images.edit）。查得到這個模型（GET /models/gpt-image-2 成功）
  // 不等於實際生成一定會通過，組織驗證等問題仍可能在下方 catch 區塊的403分支出現。
  // background:'transparent' 是 gpt-image-2 正式支援的參數，直接回傳乾淨 alpha 透明背景的
  // PNG，不必依賴模型是否真的畫出「純白背景」再靠前端去背猜測邊界——實測發現即使 prompt
  // 明確要求純白背景，模型仍偶爾會畫出淡淡漸層／暗角，導致色彩式去背抓不準邊界；
  // 直接請 API 給透明背景可以完全避開這個不確定性。
  const moderation = await runContentModeration(tracker, { text: rawPrompt });
  if (!moderation.ok) {
    if (moderation.blocked) return res.status(400).json({ error: '內容不符合使用規範，請修改後再試' });
    return res.status(503).json({ error: '內容審核服務暫時無法使用，請稍後再試' });
  }

  if (!reserveAiSiteUsage(req, res).allowed) return; // 真正要建立3個OpenAI請求前才保留全站每日額度

  // 黑卡一次會平行送出3個OpenAI請求，但對分析事件來說仍是「這一次請求」，只呼叫一次
  // startTrustedAnalytics()，只建立1筆ai_request（tracker內部本身也有防重複呼叫的保護）。
  tracker.startTrustedAnalytics(productId, resolveAnalyticsContextHashes(req.body, 'black-card-pattern-candidates'));

  // .map() 本身就會立刻同步送出全部3個OpenAI請求（呼叫當下就啟動，不是等到 await 才送出），
  // 所以 provider_called／provider_call_count／requested_image_count 要在這裡設定，不是等
  // Promise.allSettled 結束後才設定。
  tracker.setProviderCalled(true);
  tracker.setProviderCallCount(BLACK_CARD_PATTERN_COMPOSITION_VARIANTS.length);
  tracker.setImageCounts({ requested: BLACK_CARD_PATTERN_COMPOSITION_VARIANTS.length });
  const calls = BLACK_CARD_PATTERN_COMPOSITION_VARIANTS.map(variant =>
    withTimeout(
      openai.images.generate({
        model:      cfg.model,
        prompt:     `${basePrompt}\n\n${variant}`,
        n:          1,
        size:       '1024x1024',
        quality:    'medium',
        background: 'transparent'
      }).then(async result => {
        const cleaned = await normalizeBlackCardCandidate(result.data[0].b64_json);
        return cleaned.toString('base64');
      })
    )
  );

  const settled = await Promise.allSettled(calls);

  const images = [];
  let firstError = null;
  settled.forEach(r => {
    if (r.status === 'fulfilled') {
      images.push(`data:image/png;base64,${r.value}`);
    } else if (!firstError) {
      firstError = r.reason;
    }
  });

  tracker.setImageCounts({ generated: images.length });

  if (images.length === 0) {
    const err = firstError || new Error('生成失敗');
    const status  = err.status;
    const code    = err.error?.code || err.code || '';
    const message = err.message || '';
    console.error('[black-card-pattern-candidates]', status, code, err.isTimeout ? 'timeout' : message);
    tracker.setErrorCategory(classifyAiProviderError(err));

    const msgLower = message.toLowerCase();
    if (err.isTimeout) {
      return res.status(504).json({ error: 'AI 圖案生成逾時，請稍後再試一次' });
    }
    // 帳號/組織未驗證
    if (status === 403 || code === 'organization_not_verified' || msgLower.includes('must be verified') || msgLower.includes('verify your organization')) {
      return res.status(403).json({ error: '此功能需要 OpenAI 帳號完成組織驗證才能使用，請聯絡管理員確認設定（platform.openai.com 組織驗證狀態）' });
    }
    if (status === 400 && (code === 'moderation_blocked' || msgLower.includes('safety system') || msgLower.includes('moderation') || msgLower.includes('rejected') || msgLower.includes('policy'))) {
      return res.status(400).json({ error: '這個描述無法生成圖案，可能觸發 AI 圖像安全限制，請修改描述後再試一次' });
    }
    if (status === 402 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
      return res.status(402).json({ error: 'AI 圖像服務額度不足，請聯絡管理員確認 OpenAI 帳戶餘額' });
    }
    if (status === 429) {
      return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    if (status === 401) {
      return res.status(401).json({ error: 'API Key 無效，請聯絡管理員確認設定' });
    }
    return res.status(500).json({ error: '生成失敗，請稍後再試' });
  }

  const isPartial = images.length < BLACK_CARD_PATTERN_COMPOSITION_VARIANTS.length;
  tracker.setPartial(isPartial);
  tracker.setOutcome(isPartial ? 'partial' : 'success');

  res.json({
    success: true,
    images,
    partial: isPartial,
    failedCount: BLACK_CARD_PATTERN_COMPOSITION_VARIANTS.length - images.length
  });
});

// ─── API：Q版卡通化（gpt-image-2 image edit，直接以照片為輸入，2026-08-24 由
// gpt-image-1 改過來）──────
// 注意：呼叫 GPT Image 系列模型的 images.edit 需要 OpenAI 組織已完成驗證（Individual 或
// Business），否則一律會收到「帳號/組織未驗證」錯誤（詳見 test-gpt-image-edit.js）；能查到
// gpt-image-2 這個模型不代表組織驗證已經完成，這是兩件互相獨立的事。
app.post('/api/cartoon-image', aiUsageLimitMiddleware('cartoon_image'), async (req, res) => {
  const tracker = req.aiUsageTracker;

  if (!openai) {
    tracker.setErrorCategory('api_key_missing');
    return res.status(503).json({ error: 'OpenAI API Key 未設定' });
  }

  const cfg = loadAiRouteConfig(res, tracker, 'cartoon_image', ['cartoon_image_base', 'cartoon_image_black_card']);
  if (!cfg) return;
  tracker.setModel(cfg.model);

  const { imageDataURL, styleId, productId, mode } = req.body;
  if (!imageDataURL || !imageDataURL.startsWith('data:image/')) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '請上傳圖片' });
  }
  // productId 必須是正式資料庫中 active 且未封存的商品，驗證失敗不可以再往下呼叫內容審核
  // 或正式生成。
  if (!isValidActiveProductId(productId)) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '找不到此商品，請重新整理頁面後再試一次' });
  }
  // mode 不能直接信任前端送來的任意字串——先過允許值白名單，不在名單內一律安全退回
  // 'standard'。mode='black_card' 時 productId 必須確實是 'black_card'，兩者對不上直接
  // 400拒絕（不可以安全退回一般模式，避免使用者/前端bug誤送mode='black_card'卻套用到別的
  // 商品，或反過來想繞過黑卡專屬提示詞去測試其他商品的行為）；不論哪個分支，套用的都是
  // 伺服器自己 cfg.prompts 裡固定的兩組提示詞之一，使用者沒有管道自行注入任意 prompt 文字。
  const ALLOWED_CARTOON_MODES = ['standard', 'black_card'];
  const safeMode = ALLOWED_CARTOON_MODES.includes(mode) ? mode : 'standard';
  if (safeMode === 'black_card' && productId !== 'black_card') {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '商品與模式不符，請重新整理頁面後再試一次' });
  }
  const isBlackCard = safeMode === 'black_card' && productId === 'black_card';

  // ── 先在本地驗證格式與大小，避免無謂的 API 呼叫 ──
  const matches = imageDataURL.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '圖片格式無法辨識，請重新上傳一張照片' });
  }
  const mimeSub = matches[1].toLowerCase();
  const extMap  = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
  const ext = extMap[mimeSub];
  if (!ext) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '圖片格式不支援，請使用 JPG、PNG 或 WEBP 格式的照片' });
  }
  const buffer = Buffer.from(matches[2], 'base64');
  // 20MB 上限跟 OpenAI Moderation API 的圖片輸入大小上限一致（見官方文件），本地先擋過大檔案，
  // 避免明知道審核一定會因為超過大小而失敗，還浪費一次網路往返。
  if (buffer.length > 20 * 1024 * 1024) {
    tracker.setErrorCategory('validation');
    return res.status(400).json({ error: '圖片檔案過大，請使用 20MB 以下的照片' });
  }

  tracker.setImageCounts({ requested: 1 });

  const moderation = await runContentModeration(tracker, { imageDataURL });
  if (!moderation.ok) {
    if (moderation.blocked) return res.status(400).json({ error: '內容不符合使用規範，請修改後再試' });
    return res.status(503).json({ error: '內容審核服務暫時無法使用，請稍後再試' });
  }

  if (!reserveAiSiteUsage(req, res).allowed) return; // 真正要呼叫OpenAI前才保留全站每日額度

  tracker.startTrustedAnalytics(productId, resolveAnalyticsContextHashes(req.body, 'cartoon-image')); // 真正準備呼叫正式生成API的這一刻才建立ai_request

  try {
    const imageFile = await toFile(buffer, `photo.${ext}`, {
      type: `image/${ext === 'jpg' ? 'jpeg' : ext}`
    });

    const cartoonPrompt = isBlackCard
      ? cfg.prompts.cartoon_image_black_card
      : `${cfg.prompts.cartoon_image_base} ${CARTOON_STYLES[styleId] || CARTOON_STYLES[DEFAULT_CARTOON_STYLE]}`;

    // 跟 /api/black-card-pattern-candidates 同一套逾時保護：images.edit() 偶爾會卡住
    // 遠超過使用者能接受的等待時間，45 秒後主動放棄並回傳明確逾時訊息，不要讓請求
    // 無限期掛著、前端loading轉到天荒地老。
    const GENERATE_TIMEOUT_MS = 45000;
    const withTimeout = (promise) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { isTimeout: true })), GENERATE_TIMEOUT_MS))
    ]);

    tracker.setProviderCalled(true);
    tracker.setProviderCallCount(1);
    const result = await withTimeout(openai.images.edit({
      model:   cfg.model,
      image:   imageFile,
      prompt:  cartoonPrompt,
      size:    '1024x1536',
      quality: 'medium'
    }));

    const b64 = result.data[0].b64_json;
    tracker.setImageCounts({ generated: 1 });
    tracker.setOutcome('success');
    res.json({ success: true, imageDataURL: `data:image/png;base64,${b64}` });

  } catch (err) {
    const status  = err.status;
    const code    = err.error?.code || err.code || '';
    const message = err.message || '';
    console.error('[cartoon-image]', status, code, message);
    tracker.setImageCounts({ generated: 0 });
    tracker.setErrorCategory(classifyAiProviderError(err));

    const msgLower = message.toLowerCase();

    // 伺服器端45秒逾時保護觸發
    if (err.isTimeout) {
      return res.status(504).json({ error: 'AI 圖片處理時間較長，請稍後重新生成。' });
    }
    // 帳號/組織未驗證（呼叫 gpt-image-1 的先決條件）
    if (status === 403 || code === 'organization_not_verified' || msgLower.includes('must be verified') || msgLower.includes('verify your organization')) {
      return res.status(403).json({ error: '此功能需要 OpenAI 帳號完成組織驗證才能使用，請聯絡管理員確認設定（platform.openai.com 組織驗證狀態）' });
    }
    // 圖片格式或大小錯誤（本地已預先檢查，這裡是 API 端額外拒絕的情況）
    if (status === 400 && (msgLower.includes('image') && (msgLower.includes('format') || msgLower.includes('size') || msgLower.includes('invalid') || msgLower.includes('dimension')))) {
      return res.status(400).json({ error: '圖片格式或尺寸不符合要求，請換一張 JPG/PNG 照片再試' });
    }
    // 圖片安全審核未通過
    if (status === 400 && (code === 'moderation_blocked' || msgLower.includes('safety system') || msgLower.includes('moderation') || msgLower.includes('rejected') || msgLower.includes('policy'))) {
      return res.status(400).json({ error: '這張照片目前無法生成 Q版肖像，可能是照片不清楚、多人入鏡、臉部遮擋，或觸發 AI 圖像安全限制。請改用清楚的單人照片再試一次。' });
    }
    // API 額度或付款問題
    if (status === 402 || code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
      return res.status(402).json({ error: 'AI 圖像服務額度不足，請聯絡管理員確認 OpenAI 帳戶餘額' });
    }
    if (status === 429) {
      return res.status(429).json({ error: '請求過於頻繁，請稍後再試' });
    }
    // API Key 問題
    if (status === 401) {
      return res.status(401).json({ error: 'API Key 無效，請聯絡管理員確認設定' });
    }
    // 其他伺服器錯誤
    res.status(500).json({ error: '生成失敗，請稍後再試' });
  }
});

// ─── 健康檢查 ──────────────────────────────
// 公開健康檢查：刻意只回傳「活著、時間」，不回傳任何內部狀態——不讀資料夾、不讀環境變數、
// 不透露是否有設定 API Key，避免這支公開端點變成未登入也能打聽伺服器內部狀態的管道。
// 唯一會檢查的關鍵依賴是資料庫（better-sqlite3 是同步、進程內的連線，不會因為網路问题
// 而卡住，用一個最簡單的 SELECT 確認 DB 檔案本身還能正常讀取）；DB 有問題時回 503，
// 訊息保持簡短安全，不包含資料庫路徑或原始錯誤內容。
app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
  } catch (e) {
    console.error('[health] 資料庫健康檢查失敗：', e.message);
    return res.status(503).json({ status: 'error', service: 'yangzhu-customizer' });
  }
  res.json({
    status: 'ok',
    service: 'yangzhu-customizer',
    time: new Date().toISOString()
  });
});

// 公開端點：讓前端詢價表單知道目前是不是測試模式，才能顯示明確的「測試模式」提示。
// 只回傳一個布林值，不含任何其他環境資訊。
app.get('/api/form-test-mode', (req, res) => {
  res.json({ testMode: process.env.FORM_TEST_MODE === 'true' });
});

// ─── 404／全域錯誤處理（正式上線前第一階段技術整理）──────────────
// 放在所有真實路由（含靜態資源掛載）之後、app.listen 之前，Express 依註冊順序比對路由，
// 前面都沒命中才會落到這裡。分兩層：先擋 /api/* 讓前端一律拿到可預期的 JSON（不是HTML錯誤頁），
// 其餘網址一律回傳跟網站品牌一致的 404.html，狀態碼仍是 404（不是 200 呈現假的「找到了」）。
app.use('/api', (req, res) => {
  res.status(404).json({ error: '找不到此 API 路徑' });
});
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// 全域錯誤處理中介層必須放在最後、且維持4個參數（err, req, res, next）Express才會
// 認得這是錯誤處理層。目的是接住前面所有路由「沒有自己try/catch」而意外拋出的例外，
// 避免退回Express預設行為（開發模式下會把完整錯誤堆疊直接印在回應HTML裡）。
// 一律記錄完整錯誤到伺服器端 console，回給使用者的只有不洩漏內部細節的通用訊息。
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[unhandled-error]', req.method, req.originalUrl, err);
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: '系統暫時發生問題，請稍後再試' });
  }
  res.status(500).send('系統暫時發生問題，請稍後再試，或電洽 02-2680-9966。');
});

// ─── 啟動 ──────────────────────────────────
// 監聽位址刻意不手動指定 host（保持 Express 預設行為，等同綁定所有網路介面），這是多數
// 部署平台（Railway／Render 等容器化平台）期待的行為——只綁定 127.0.0.1 會讓平台外層的
// 反向代理連不到這個進程。
const server = app.listen(port, () => {
  console.log('\n楊竹科技配置器已啟動');
  console.log(`→ 瀏覽器開啟：http://localhost:${port}`);
  console.log(`→ 訂單資料夾：${ORDER_DIR}`);
  console.log(`→ 工廠資料包：${FACTORY_DIR}`);
  console.log(`→ API Key 狀態：${process.env.OPENAI_API_KEY ? '已設定' : '❌ 未設定（請建立 .env）'}\n`);
});

// 通知非同步派送背景工作（統一通知系統批次）：NODE_ENV=test時不自動啟動，隔離測試改用
// notification-worker.js匯出的processNotificationJobsOnce()明確、確定性地觸發一輪派送，
// 避免背景計時器跟測試斷言的時間點互相打架；開發／正式環境則照常自動啟動。
if (process.env.NODE_ENV !== 'test') startNotificationWorker();

// ─── Graceful shutdown（正式部署環境準備）──────────────────────────────
// 部署平台重新部署／重啟時一律先送 SIGTERM，給進程時間關閉，不是直接砍掉——先讓 HTTP
// server 停止接受「新」連線、同時讓已經在處理中的請求正常跑完再真正結束，避免使用者
// 送出詢價單送到一半被直接中斷；資料庫也要明確關閉（better-sqlite3 是同步、進程內連線，
// 不關閉理論上不會造成資料損毀，但養成明確關閉的習慣，避免未來換成其他資料庫時忘記處理）。
// 10 秒後如果還沒關閉乾淨，強制結束，避免部署卡住。
let _shuttingDown = false;
function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`\n[shutdown] 收到 ${signal}，開始關閉伺服器（等待現有請求完成）...`);
  server.close(() => {
    try { db.close(); } catch (e) { console.error('[shutdown] 關閉資料庫時發生問題：', e.message); }
    console.log('[shutdown] 伺服器已安全關閉');
    process.exit(0);
  });
  setTimeout(() => {
    console.error('[shutdown] 等待逾時，強制結束');
    process.exit(1);
  }, 10000).unref();
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 未捕捉的例外／Promise rejection：只記錄「有錯誤發生」與安全的錯誤訊息／堆疊到伺服器端
// console（絕對不會傳到任何 HTTP 回應，這裡本來就沒有 res 物件可以送），不記錄請求內容、
// 不記錄環境變數。uncaughtException 代表 Node 執行環境可能已經處於不可預期的狀態，記錄後
// 直接結束進程，交給部署平台（或本機的 process manager）重啟，比繼續帶著不明確的狀態
// 運作更安全；unhandledRejection 通常代表某個 Promise 少了 .catch()，先記錄但不強制結束
// 進程，避免單一次遺漏的錯誤處理就讓整台伺服器不必要地重啟。
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
