// 楊竹科技配置器 — 集中式資料路徑解析（部署前總驗收：單一永久資料根目錄批次）
// db.js、server.js、admin-routes.js 都必須從這裡取得資料庫／備份／訂單／工廠包／商品上傳圖片
// 的實際存放路徑，不可以各自重複寫一份判斷邏輯——以後環境路徑規則要改，只需要改這一個檔案。
//
// 三種 NODE_ENV 的路徑規則：
// - test：沿用既有 TEST_DB_DIR 慣例（獨立隔離資料夾，五類資料都在它底下的子路徑），
//   不影響既有隔離測試寫法。
// - production：改用單一的 APP_DATA_DIR（永久資料根目錄，通常對應部署平台掛載的
//   持久化磁碟），五類資料都在它底下的子路徑，方便平台只需要掛載「一個」路徑。
// - development（NODE_ENV 未設定或其他值，包含目前正式 3777 實際執行中的模式）：
//   維持修改前的舊路徑（上層 後台資料庫／訂單資料／factory-packages，商品上傳圖片維持
//   專案內 assets/uploads/products），刻意不因為這批修改而改變目前正式服務的行為
//   ——正式 3777 (PID 31716) 目前是在這個分支下運作，禁止本批修改影響它。
const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname);
const LEGACY_BACKEND_DIR         = path.resolve(PROJECT_ROOT, '..', '後台資料庫');
const LEGACY_ORDER_DIR           = path.resolve(PROJECT_ROOT, '..', '訂單資料');
const LEGACY_FACTORY_DIR         = path.resolve(PROJECT_ROOT, '..', 'factory-packages');
const LEGACY_PRODUCT_UPLOAD_DIR  = path.join(PROJECT_ROOT, 'assets', 'uploads', 'products');
// 舊版 NODE_ENV=production 曾經使用過的專案內路徑（已被 APP_DATA_DIR 取代），繼續列在
// TEST_DB_DIR 的禁止清單裡，避免測試環境不小心指向這個舊路徑。
const OBSOLETE_PROD_DB_DIR = path.join(PROJECT_ROOT, 'data');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ─── production：APP_DATA_DIR ──────────────────────────────────────────
// 空值、不是絕對路徑、磁碟根目錄或專案原始碼根目錄，一律直接拒絕啟動（process.exit(1)）
// ——不使用「悄悄退回某個預設路徑」這種寬鬆做法，寧可讓設定錯誤的正式環境明確啟動失敗，
// 也不要讓正式服務在沒有察覺的情況下把資料寫到錯誤或臨時的地方。
function resolveAppDataDir() {
  const raw = process.env.APP_DATA_DIR;
  if (typeof raw !== 'string' || !raw.trim()) {
    console.error('[app-data-paths] 必須設定 APP_DATA_DIR（永久資料根目錄的絕對路徑，通常對應部署平台掛載的持久化磁碟），拒絕繼續執行。');
    process.exit(1);
  }
  const trimmed = raw.trim();
  if (!path.isAbsolute(trimmed)) {
    console.error(`[app-data-paths] APP_DATA_DIR="${trimmed}" 不是絕對路徑，拒絕繼續執行。`);
    process.exit(1);
  }
  const resolved = path.resolve(trimmed);
  const diskRoot = path.parse(resolved).root;
  const forbidden = [diskRoot, PROJECT_ROOT];
  if (forbidden.some(f => path.resolve(f) === resolved)) {
    console.error('[app-data-paths] APP_DATA_DIR 不可以是磁碟根目錄或專案原始碼根目錄，拒絕繼續執行。');
    process.exit(1);
  }
  return resolved;
}

// ─── test：沿用既有 TEST_DB_DIR 規則 ────────────────────────────────────
function resolveTestDataDir() {
  const raw = (process.env.TEST_DB_DIR || '').trim();
  if (!raw) {
    console.error('[app-data-paths] NODE_ENV=test 但未設定 TEST_DB_DIR，拒絕啟動（避免意外操作到正式或開發資料庫）');
    process.exit(1);
  }
  const resolved = path.resolve(raw);
  const diskRoot = path.parse(resolved).root;
  const forbidden = [PROJECT_ROOT, diskRoot, LEGACY_BACKEND_DIR, OBSOLETE_PROD_DB_DIR];
  if (forbidden.some(f => path.resolve(f) === resolved)) {
    console.error('[app-data-paths] TEST_DB_DIR 不可以是專案根目錄、磁碟根目錄，或真實資料庫所在路徑，拒絕啟動');
    process.exit(1);
  }
  return resolved;
}

// 只在第一次呼叫時解析＋驗證一次（同一個Node行程內環境變數不會中途變動），
// 避免多個檔案各自呼叫時重複印出同一組錯誤或重複做一樣的驗證。
let _cachedRoot = null;
function getDataRoot() {
  if (_cachedRoot) return _cachedRoot;
  const env = process.env.NODE_ENV;
  if (env === 'test') {
    _cachedRoot = { kind: 'test', dir: resolveTestDataDir() };
  } else if (env === 'production') {
    _cachedRoot = { kind: 'production', dir: resolveAppDataDir() };
  } else {
    _cachedRoot = { kind: 'development', dir: null }; // 開發環境維持舊的分散路徑，沒有單一root
  }
  return _cachedRoot;
}

function getDbDir() {
  const root = getDataRoot();
  const dir = root.kind === 'development' ? LEGACY_BACKEND_DIR : root.dir;
  ensureDir(dir);
  return dir;
}

function getBackupDir() {
  const dir = path.join(getDbDir(), 'backups');
  ensureDir(dir);
  return dir;
}

function getOrderDir() {
  const root = getDataRoot();
  const dir = root.kind === 'development' ? LEGACY_ORDER_DIR : path.join(root.dir, 'orders');
  ensureDir(dir);
  return dir;
}

function getFactoryDir() {
  const root = getDataRoot();
  const dir = root.kind === 'development' ? LEGACY_FACTORY_DIR : path.join(root.dir, 'factory-packages');
  ensureDir(dir);
  return dir;
}

// 商品上傳圖片：production／test 都集中在資料根目錄底下的 product-uploads，跟其餘四類
// 資料一致；development 沿用修改前唯一存在過的路徑（專案內 assets/uploads/products），
// 不因這批修改而改變目前開發環境的既有行為。
function getProductUploadDir() {
  const root = getDataRoot();
  const dir = root.kind === 'development' ? LEGACY_PRODUCT_UPLOAD_DIR : path.join(root.dir, 'product-uploads');
  ensureDir(dir);
  return dir;
}

module.exports = {
  PROJECT_ROOT,
  LEGACY_BACKEND_DIR,
  LEGACY_ORDER_DIR,
  LEGACY_FACTORY_DIR,
  LEGACY_PRODUCT_UPLOAD_DIR,
  resolveAppDataDir, // 供 scripts/prepare-deploy-data.js 重用同一套 APP_DATA_DIR 驗證規則，不重複寫一份
  getDataRoot,
  getDbDir,
  getBackupDir,
  getOrderDir,
  getFactoryDir,
  getProductUploadDir
};
