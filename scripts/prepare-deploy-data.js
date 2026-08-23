// 楊竹科技配置器 — 部署資料準備工具（Codex 獨立複驗修正批次：遞迴＋逐檔雜湊驗證＋暫存區發布）
//
// 用途：把目前正式服務實際使用的資料（後台資料庫/admin.db、訂單資料/、factory-packages/、
// assets/uploads/products/、以及可選的既有備份 後台資料庫/backups/，也就是 app-data-paths.js
// 的 LEGACY_* 路徑）複製一份到新的 APP_DATA_DIR 永久資料根目錄，供改用 APP_DATA_DIR 部署時的
// 第一次資料搬遷使用。
//
// 這支腳本本身不會、也不可以修改任何來源資料（只有讀取／複製動作，找不到任何寫入來源路徑
// 的程式碼）；預設是「預演模式」（dry-run），只列出會複製什麼、複製到哪裡、幾筆資料，
// 完全不寫入任何檔案，需要明確加上 --execute 才會真正執行複製。
//
// 用法：
//   node scripts/prepare-deploy-data.js --dest=<APP_DATA_DIR絕對路徑>          （預演，預設）
//   node scripts/prepare-deploy-data.js --dest=<APP_DATA_DIR絕對路徑> --execute （真正複製）
// 也可以用 APP_DATA_DIR 環境變數代替 --dest 參數。
//
// 安全設計（2026-08-23 修正版）：
// 1. 預設dry-run，不執行寫入。
// 2. 正式執行前用 PRAGMA integrity_check 檢查來源資料庫。
// 3. 用 SQLite 官方 Online Backup API（better-sqlite3 的 db.backup()）複製資料庫，
//    不是直接 fs.copyFileSync 運作中的 admin.db 主檔。
// 4. 訂單、工廠包、商品上傳圖片、可選的既有備份，四類資料都遞迴掃描所有子資料夾、
//    保留完整相對目錄結構；掃描過程中遇到符號連結（symlink）、目錄連結（junction）
//    或其他非一般檔案／資料夾的特殊項目，一律直接中止、拒絕遷移，避免遷移範圍
//    被連結導向來源以外的地方。
// 5. 目的地五個最終位置（admin.db、backups/、orders/、factory-packages/、
//    product-uploads/）只要遞迴掃描發現任何既有檔案或子資料夾，一律在複製開始前拒絕，
//    不覆蓋、不部分複製。
// 6. 不直接寫入最終位置：所有資料先複製到本工具自建、名稱含隨機值的 staging（暫存）
//    資料夾，在 staging 內完成資料庫完整性／筆數比對，以及每一個檔案的相對路徑、
//    檔案大小、SHA-256 逐項驗證，全部通過後才把 staging 內容發布（改名搬移）到正式
//    最終位置。任一驗證步驟失敗，只清除本次建立的 staging，不動來源、也不留下任何
//    半套的最終資料。
// 7. 發布（改名搬移到最終位置）階段如果中途失敗，會把本次已經成功搬移的項目復原
//    刪除，讓最終位置回到執行前「完全沒有這批資料」的狀態，不留下半套資料。
// 8. 所有清除動作（清除 staging、發布失敗時的復原刪除）都會先核對絕對路徑是否精確
//    等於「本工具自己建立、且命名符合已知規則」的路徑，才會執行刪除，不使用會誤刪
//    其他內容的廣泛遞迴刪除。
// 9.（2026-08-23 停寫保護批次）--execute 必須同時提供 --confirm-source-stopped，代表
//    操作者已經人工確認來源目前處於停寫狀態，缺少這個參數會在建立目的地／staging／
//    任何寫入之前就直接拒絕。這個參數只是第二道人工確認，不能取代下面第10、11項的
//    自動化來源穩定性檢查。
// 10. 初次掃描來源時，就對訂單／工廠包／商品上傳圖片／備份四類資料建立完整的相對路徑、
//     檔案大小、SHA-256 清單（第一次快照）；staging 複製與驗證完成後、正式發布前，
//     重新從來源資料夾遞迴掃描並重新計算一次 SHA-256（第二次快照），逐項比對兩次快照，
//     只要有新增、刪除、大小變化或雜湊變化，立即中止發布、清除 staging、回傳非0結束碼。
// 11. 資料庫維持同一條來源連線（同一個 better-sqlite3 Database 物件）從頭到尾，記錄
//     遷移開始時該連線讀到的 PRAGMA data_version，staging驗證完成後、發布前再讀一次
//     同一連線的 data_version；數值改變代表遷移期間有其他連線修改過資料庫，一樣會中止
//     發布並清理 staging。即使有這項檢查，正式操作仍必須先讓舊服務停止或進入可靠的
//     全站停寫狀態，因為最後一次檢查之後仍可能存在極短的時間差。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const {
  LEGACY_BACKEND_DIR, LEGACY_ORDER_DIR, LEGACY_FACTORY_DIR, LEGACY_PRODUCT_UPLOAD_DIR,
  resolveAppDataDir
} = require('../app-data-paths');

const STAGING_PREFIX = '.prepare-deploy-staging-';
const FINAL_TARGET_NAMES = ['admin.db', 'backups', 'orders', 'factory-packages', 'product-uploads'];

// 掃描或驗證階段發現不安全內容（符號連結／特殊檔案）或發布階段失敗時使用，
// 讓 main() 可以統一在 catch 裡決定要不要清理 staging。
class SafetyAbortError extends Error {}

// --src-*-dir 三個參數只給「隔離測試」或「來源資料已經搬到別的路徑」這類特殊情境使用；
// 正常部署時完全不需要帶這些參數，會自動使用目前正式服務實際在用的舊路徑
// （app-data-paths.js 的 LEGACY_* 常數）。備份來源固定是「資料庫來源目錄底下的 backups/」，
// 沒有獨立的覆寫參數，這樣 --src-db-dir 覆寫時備份來源會自動一起跟著指向測試用假資料。
function parseArgs(argv) {
  const args = { execute: false, confirmSourceStopped: false, dest: null, srcDbDir: null, srcOrderDir: null, srcFactoryDir: null, srcUploadDir: null };
  argv.forEach(a => {
    if (a === '--execute') args.execute = true;
    else if (a === '--confirm-source-stopped') args.confirmSourceStopped = true;
    else if (a.startsWith('--dest=')) args.dest = a.slice('--dest='.length);
    else if (a.startsWith('--src-db-dir=')) args.srcDbDir = a.slice('--src-db-dir='.length);
    else if (a.startsWith('--src-order-dir=')) args.srcOrderDir = a.slice('--src-order-dir='.length);
    else if (a.startsWith('--src-factory-dir=')) args.srcFactoryDir = a.slice('--src-factory-dir='.length);
    else if (a.startsWith('--src-upload-dir=')) args.srcUploadDir = a.slice('--src-upload-dir='.length);
  });
  return args;
}

// ─── 遞迴掃描：保留完整相對目錄結構，遇到符號連結／junction／特殊檔案直接拒絕 ──────
function scanDirSafe(rootDir, currentDir, out) {
  const entries = fs.readdirSync(currentDir);
  for (const name of entries) {
    const full = path.join(currentDir, name);
    const st = fs.lstatSync(full); // 用 lstat（不 follow 連結）才能偵測到符號連結／junction 本身
    if (st.isSymbolicLink()) {
      throw new SafetyAbortError(`發現符號連結或目錄連結，為避免遷移範圍逃出來源目錄，拒絕遷移：${full}`);
    } else if (st.isDirectory()) {
      scanDirSafe(rootDir, full, out);
    } else if (st.isFile()) {
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      out.push({ rel, abs: full, size: st.size });
    } else {
      throw new SafetyAbortError(`發現不支援的特殊檔案類型（非一般檔案或資料夾），拒絕遷移：${full}`);
    }
  }
  return out;
}

// 回傳 { count, totalSize, map: Map(相對路徑 -> { size, abs }) }；來源資料夾不存在時視為0筆
// （例如目前正式 後台資料庫/backups/ 是空的／不存在，屬於正常情況，不視為錯誤）。
function buildManifest(rootDir) {
  const map = new Map();
  let totalSize = 0;
  if (fs.existsSync(rootDir)) {
    const files = scanDirSafe(rootDir, rootDir, []);
    files.forEach(f => {
      map.set(f.rel, { size: f.size, abs: f.abs });
      totalSize += f.size;
    });
  }
  return { count: map.size, totalSize, map };
}

function fileSha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// 對 manifest 裡每個檔案實際算一次 SHA-256——只在真正需要驗證正確性時呼叫（dry-run
// 預覽階段不需要，避免不必要的時間成本）。
function hashManifest(manifest) {
  const hashed = new Map();
  for (const [rel, info] of manifest.map) {
    hashed.set(rel, { size: info.size, sha256: fileSha256(info.abs) });
  }
  return hashed;
}

// 逐項比對來源與目的地（皆為已算好雜湊的 Map）：檔案數量、相對路徑、大小、SHA-256
// 缺一不可，只要任何一項不一致就記錄問題；目的地多出來源沒有的檔案也視為不一致。
function compareHashedManifests(label, srcHashed, destHashed) {
  const problems = [];
  if (srcHashed.size !== destHashed.size) {
    problems.push(`${label}：檔案數量不一致（來源${srcHashed.size}／目的地${destHashed.size}）`);
  }
  for (const [rel, srcInfo] of srcHashed) {
    const destInfo = destHashed.get(rel);
    if (!destInfo) { problems.push(`${label}：目的地缺少檔案 ${rel}`); continue; }
    if (destInfo.size !== srcInfo.size) problems.push(`${label}：檔案大小不一致 ${rel}（來源${srcInfo.size}／目的地${destInfo.size}）`);
    if (destInfo.sha256 !== srcInfo.sha256) problems.push(`${label}：SHA-256不一致 ${rel}`);
  }
  for (const rel of destHashed.keys()) {
    if (!srcHashed.has(rel)) problems.push(`${label}：目的地多出來源沒有的檔案 ${rel}`);
  }
  return problems;
}

// 目的地衝突檢查：遞迴掃描，只要任何子資料夾深處有檔案（或有連結）就視為衝突，
// 不能只看第一層——上一版的臭蟲就是因為第一層檢查漏掉了深層目錄。
function dirHasAnyFileRecursive(dir) {
  if (!fs.existsSync(dir)) return false;
  const entries = fs.readdirSync(dir);
  for (const name of entries) {
    const full = path.join(dir, name);
    const st = fs.lstatSync(full);
    if (st.isSymbolicLink() || st.isFile()) return true;
    if (st.isDirectory() && dirHasAnyFileRecursive(full)) return true;
  }
  return false;
}

// 把 manifest 裡的每個檔案複製到 staging 底下對應的相對路徑，保留完整目錄結構。
function copyManifestToStaging(manifest, stagingSubDir) {
  for (const [rel, info] of manifest.map) {
    const destFull = path.join(stagingSubDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(destFull), { recursive: true });
    fs.copyFileSync(info.abs, destFull);
  }
}

// 只清除「本工具自己建立、直接位於 destDir 底下、名稱符合 staging 命名規則」的路徑，
// 先核對絕對路徑再刪除，避免誤刪其他內容。
function safeRemoveStaging(stagingDir, destDir) {
  const resolvedStaging = path.resolve(stagingDir);
  const resolvedDest = path.resolve(destDir);
  const parent = path.dirname(resolvedStaging);
  const base = path.basename(resolvedStaging);
  if (parent !== resolvedDest || !base.startsWith(STAGING_PREFIX)) {
    throw new Error(`內部安全檢查失敗，拒絕清除非本工具建立的路徑：${resolvedStaging}`);
  }
  if (fs.existsSync(resolvedStaging)) fs.rmSync(resolvedStaging, { recursive: true, force: true });
}

// 發布階段中途失敗時的復原刪除：只允許刪除「直接位於 destDir 底下、檔名精確等於五個
// 已知最終目標名稱之一」的路徑，且只刪除本次執行真的建立成功的項目（見 published 陣列）。
function safeRemoveFinalTarget(targetPath, destDir) {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedDest = path.resolve(destDir);
  const parent = path.dirname(resolvedTarget);
  const base = path.basename(resolvedTarget);
  if (parent !== resolvedDest || !FINAL_TARGET_NAMES.includes(base)) {
    throw new Error(`內部安全檢查失敗，拒絕清除非預期路徑：${resolvedTarget}`);
  }
  if (fs.existsSync(resolvedTarget)) fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── 停寫確認：必須在建立目的地、staging或任何寫入之前檢查，dry-run不需要 ──────────
  if (args.execute && !args.confirmSourceStopped) {
    console.error('拒絕執行：--execute 必須同時提供 --confirm-source-stopped，尚未建立任何目的地或暫存資料。');
    console.error('  1. 舊網站（正式服務）必須已經停止接受訂單與後台資料修改。');
    console.error('  2. --confirm-source-stopped 代表操作者已經人工確認來源目前處於停寫狀態。');
    console.error('  3. 如果來源仍在運作、仍可能有人送出訂單或修改後台資料，不得繼續遷移。');
    console.error('  （這個參數只是第二道人工確認，本工具在正式發布前仍會自動重新核對來源是否真的沒有變動，');
    console.error('   但無法完全取代人工先把來源停下來——請先完成上面兩項，再加上這個參數重新執行。）');
    process.exitCode = 1;
    return;
  }

  const destRaw = args.dest || process.env.APP_DATA_DIR;
  if (!destRaw) {
    console.error('請用 --dest=<絕對路徑> 或設定 APP_DATA_DIR 環境變數指定目的地資料根目錄。');
    process.exitCode = 1;
    return;
  }
  // 重用跟正式程式完全相同的 APP_DATA_DIR 驗證規則（空值／非絕對路徑／磁碟根目錄／
  // 專案原始碼根目錄一律拒絕）——這裡暫時把驗證要用到的環境變數指到指令參數的值，
  // 驗證完立刻還原，不residual影響後續程式碼判斷環境的行為。
  const originalEnvValue = process.env.APP_DATA_DIR;
  process.env.APP_DATA_DIR = destRaw;
  let destDir;
  try {
    destDir = resolveAppDataDir();
  } finally {
    if (originalEnvValue === undefined) delete process.env.APP_DATA_DIR;
    else process.env.APP_DATA_DIR = originalEnvValue;
  }

  const srcDbDir = args.srcDbDir || LEGACY_BACKEND_DIR;
  const srcDbPath = path.join(srcDbDir, 'admin.db');
  const srcBackupDir = path.join(srcDbDir, 'backups'); // 固定跟著資料庫來源目錄走，沒有獨立覆寫參數
  const srcOrderDir = args.srcOrderDir || LEGACY_ORDER_DIR;
  const srcFactoryDir = args.srcFactoryDir || LEGACY_FACTORY_DIR;
  const srcUploadDir = args.srcUploadDir || LEGACY_PRODUCT_UPLOAD_DIR;

  const destDbPath = path.join(destDir, 'admin.db');
  const destBackupDir = path.join(destDir, 'backups');
  const destOrderDir = path.join(destDir, 'orders');
  const destFactoryDir = path.join(destDir, 'factory-packages');
  const destUploadDir = path.join(destDir, 'product-uploads');

  console.log(`模式：${args.execute ? '正式執行（會寫入檔案）' : '預演 dry-run（不會寫入任何檔案）'}`);
  if (args.execute) {
    console.log('警告：已提供 --confirm-source-stopped，代表操作者確認以下事項：');
    console.log('  1. 舊網站必須已經停止接受訂單與後台資料修改。');
    console.log('  2. 此參數代表操作者已確認來源目前處於停寫狀態。');
    console.log('  3. 如果來源仍在運作，不得繼續遷移——本工具在正式發布前仍會自動重新核對來源是否');
    console.log('     真的沒有變動，但這只是最後一道防線，無法完全取代人工確認停寫。');
  }

  if (!fs.existsSync(srcDbPath)) {
    console.error('找不到來源資料庫，中止：' + srcDbPath);
    process.exitCode = 1;
    return;
  }

  // 遞迴掃描四類目錄型資料，建立來源檔案清單（相對路徑＋大小）。掃描階段就會偵測
  // 符號連結／特殊檔案並直接中止，dry-run 與正式執行都一樣會先做這一步。
  let orderManifest, factoryManifest, uploadManifest, backupManifest;
  try {
    orderManifest = buildManifest(srcOrderDir);
    factoryManifest = buildManifest(srcFactoryDir);
    uploadManifest = buildManifest(srcUploadDir);
    backupManifest = buildManifest(srcBackupDir);
  } catch (err) {
    if (err instanceof SafetyAbortError) {
      console.error('安全檢查未通過，拒絕遷移，未寫入任何檔案：' + err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log('來源：');
  console.log('  資料庫  ', srcDbPath, '（存在）');
  console.log('  訂單    ', srcOrderDir, `（${orderManifest.count} 個檔案，${formatBytes(orderManifest.totalSize)}，含子資料夾）`);
  console.log('  工廠包  ', srcFactoryDir, `（${factoryManifest.count} 個檔案，${formatBytes(factoryManifest.totalSize)}，含子資料夾）`);
  console.log('  上傳圖片', srcUploadDir, `（${uploadManifest.count} 個檔案，${formatBytes(uploadManifest.totalSize)}，含子資料夾）`);
  console.log('  備份    ', srcBackupDir, `（${backupManifest.count} 個檔案，${formatBytes(backupManifest.totalSize)}，含子資料夾，選用）`);
  console.log('目的地：', destDir);
  console.log(`  ${destDbPath}`);
  console.log(`  ${destOrderDir}${path.sep}`);
  console.log(`  ${destFactoryDir}${path.sep}`);
  console.log(`  ${destUploadDir}${path.sep}`);
  console.log(`  ${destBackupDir}${path.sep}`);

  // 初次掃描來源時就建立完整的相對路徑／大小／SHA-256清單（第一次快照），供發布前
  // 重新核對來源是否維持靜止狀態使用。dry-run只是預覽，不需要花時間算雜湊。
  let orderHashed1 = null, factoryHashed1 = null, uploadHashed1 = null, backupHashed1 = null;
  if (args.execute) {
    console.log('\n記錄初次掃描時的來源 SHA-256（第一次快照，供發布前二次核對來源是否仍為靜止狀態）...');
    orderHashed1 = hashManifest(orderManifest);
    factoryHashed1 = hashManifest(factoryManifest);
    uploadHashed1 = hashManifest(uploadManifest);
    backupHashed1 = hashManifest(backupManifest);
  }

  // 來源資料庫完整性檢查（正式執行前一定要做；dry-run也順便做一次，讓使用者提早發現問題）。
  // execute模式下這條連線會一路保持開啟到發布前（供PRAGMA data_version二次核對使用），
  // dry-run或完整性檢查未通過時則立刻關閉，不需要保留。
  const srcDb = new Database(srcDbPath, { readonly: true });
  const srcIntegrity = srcDb.pragma('integrity_check', { simple: true });
  const srcAdminCount = srcDb.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
  const srcProductCount = srcDb.prepare('SELECT COUNT(*) c FROM products').get().c;
  let srcSystemSettingsCount = 0;
  try { srcSystemSettingsCount = srcDb.prepare('SELECT COUNT(*) c FROM system_settings').get().c; } catch { /* 舊資料庫可能還沒有這張表 */ }
  const srcDataVersionInitial = srcDb.pragma('data_version', { simple: true });
  console.log(`來源資料庫完整性：${srcIntegrity}（管理員${srcAdminCount}筆、商品${srcProductCount}筆、系統設定${srcSystemSettingsCount}筆、data_version=${srcDataVersionInitial}）`);
  if (srcIntegrity !== 'ok') {
    srcDb.close();
    console.error('來源資料庫完整性檢查未通過，中止，不執行任何複製。');
    process.exitCode = 1;
    return;
  }

  if (!args.execute) {
    srcDb.close();
    console.log('\n（預演模式結束，未寫入任何檔案。加上 --execute --confirm-source-stopped 才會真正複製。）');
    return;
  }

  // 目的地五個最終位置只要遞迴掃描發現任何既有檔案，一律拒絕，不覆蓋、不部分複製。
  const conflicts = [];
  if (fs.existsSync(destDbPath)) conflicts.push(destDbPath);
  if (dirHasAnyFileRecursive(destBackupDir)) conflicts.push(destBackupDir);
  if (dirHasAnyFileRecursive(destOrderDir)) conflicts.push(destOrderDir);
  if (dirHasAnyFileRecursive(destFactoryDir)) conflicts.push(destFactoryDir);
  if (dirHasAnyFileRecursive(destUploadDir)) conflicts.push(destUploadDir);
  if (conflicts.length) {
    srcDb.close();
    console.error('目的地已有資料（含子資料夾深處），預設拒絕覆蓋，中止：');
    conflicts.forEach(c => console.error('  ' + c));
    process.exitCode = 1;
    return;
  }

  // ── 不直接寫入最終位置：先建立本工具專用、名稱含隨機值的 staging 資料夾 ──────────
  fs.mkdirSync(destDir, { recursive: true });
  const stagingDir = path.join(destDir, STAGING_PREFIX + crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(stagingDir, { recursive: true });

  const stagingDbPath = path.join(stagingDir, 'admin.db');
  const stagingBackupDir = path.join(stagingDir, 'backups');
  const stagingOrderDir = path.join(stagingDir, 'orders');
  const stagingFactoryDir = path.join(stagingDir, 'factory-packages');
  const stagingUploadDir = path.join(stagingDir, 'product-uploads');

  try {
    console.log('\n開始複製到暫存區（staging）...');
    console.log('  暫存區：' + stagingDir);

    // 用SQLite官方Online Backup API複製資料庫，不是直接複製運作中的admin.db主檔——
    // 沿用同一條 srcDb 連線（從main()開頭開到現在），才能在發布前用同一連線重新讀取
    // PRAGMA data_version，正確偵測「遷移期間有沒有其他連線改過這個資料庫」。
    await srcDb.backup(stagingDbPath);
    console.log('  資料庫已複製到暫存區');

    copyManifestToStaging(orderManifest, stagingOrderDir);
    console.log(`  訂單已複製 ${orderManifest.count} 個檔案（含子資料夾）到暫存區`);
    copyManifestToStaging(factoryManifest, stagingFactoryDir);
    console.log(`  工廠包已複製 ${factoryManifest.count} 個檔案（含子資料夾）到暫存區`);
    copyManifestToStaging(uploadManifest, stagingUploadDir);
    console.log(`  商品上傳圖片已複製 ${uploadManifest.count} 個檔案（含子資料夾）到暫存區`);
    if (backupManifest.count > 0) {
      copyManifestToStaging(backupManifest, stagingBackupDir);
      console.log(`  既有備份已複製 ${backupManifest.count} 個檔案（含子資料夾）到暫存區`);
    } else {
      console.log('  既有備份：來源沒有任何檔案，暫存區不建立此項目');
    }

    // ── 在 staging 內完成資料庫完整性／筆數，以及逐檔 SHA-256 驗證，全部通過才發布 ──
    console.log('\n驗證暫存區內容...');
    const stagingDb = new Database(stagingDbPath, { readonly: true });
    const stagingIntegrity = stagingDb.pragma('integrity_check', { simple: true });
    const stagingAdminCount = stagingDb.prepare('SELECT COUNT(*) c FROM admin_users').get().c;
    const stagingProductCount = stagingDb.prepare('SELECT COUNT(*) c FROM products').get().c;
    let stagingSystemSettingsCount = 0;
    try { stagingSystemSettingsCount = stagingDb.prepare('SELECT COUNT(*) c FROM system_settings').get().c; } catch { /* 可能沒有這張表 */ }
    stagingDb.close();

    const problems = [];
    function checkEqual(label, a, b) {
      if (a !== b) problems.push(`${label}不一致（來源${a}／暫存區${b}）`);
      else console.log(`  通過：${label}（${a}）`);
    }
    checkEqual('資料庫完整性', srcIntegrity, stagingIntegrity);
    checkEqual('管理員筆數', srcAdminCount, stagingAdminCount);
    checkEqual('商品筆數', srcProductCount, stagingProductCount);
    checkEqual('系統設定筆數', srcSystemSettingsCount, stagingSystemSettingsCount);

    // 逐檔 SHA-256：對來源與暫存區（複製結果）都重新掃描＋算雜湊，獨立驗證位元組內容
    // 真的一致，不只是「相信 copyFileSync 應該有成功」。
    const orderStagingManifest = buildManifest(stagingOrderDir);
    const factoryStagingManifest = buildManifest(stagingFactoryDir);
    const uploadStagingManifest = buildManifest(stagingUploadDir);
    const backupStagingManifest = buildManifest(stagingBackupDir);

    problems.push(...compareHashedManifests('訂單', orderHashed1, hashManifest(orderStagingManifest)));
    problems.push(...compareHashedManifests('工廠包', factoryHashed1, hashManifest(factoryStagingManifest)));
    problems.push(...compareHashedManifests('商品上傳圖片', uploadHashed1, hashManifest(uploadStagingManifest)));
    problems.push(...compareHashedManifests('備份', backupHashed1, hashManifest(backupStagingManifest)));

    if (orderManifest.count === orderStagingManifest.count) console.log(`  通過：訂單逐檔路徑／大小／SHA-256 全部一致（${orderManifest.count}個檔案）`);
    if (factoryManifest.count === factoryStagingManifest.count) console.log(`  通過：工廠包逐檔路徑／大小／SHA-256 全部一致（${factoryManifest.count}個檔案，含子資料夾）`);
    if (uploadManifest.count === uploadStagingManifest.count) console.log(`  通過：商品上傳圖片逐檔路徑／大小／SHA-256 全部一致（${uploadManifest.count}個檔案）`);
    if (backupManifest.count === backupStagingManifest.count) console.log(`  通過：備份逐檔路徑／大小／SHA-256 全部一致（${backupManifest.count}個檔案）`);

    if (problems.length) {
      console.error('\n暫存區驗證發現不一致，中止發布，清除本次暫存區，不留下任何最終資料：');
      problems.forEach(p => console.error('  ' + p));
      safeRemoveStaging(stagingDir, destDir);
      srcDb.close();
      process.exitCode = 1;
      return;
    }

    // ── 發布前重新核對來源是否仍為靜止狀態（第二次快照＋data_version二次核對） ────────
    // 第一道防線是操作者手動加上的 --confirm-source-stopped，這裡是自動化的第二道防線：
    // 只要來源在「初次掃描」到「現在準備發布」這段期間有任何檔案新增／刪除／內容變化，
    // 或資料庫被其他連線寫入過，一律視為停寫確認不可靠，中止發布並清理staging。
    console.log('\n發布前重新核對來源是否仍維持靜止狀態（第二次快照）...');
    const orderManifest2 = buildManifest(srcOrderDir);
    const factoryManifest2 = buildManifest(srcFactoryDir);
    const uploadManifest2 = buildManifest(srcUploadDir);
    const backupManifest2 = buildManifest(srcBackupDir);

    const stabilityProblems = [];
    stabilityProblems.push(...compareHashedManifests('訂單來源二次核對', orderHashed1, hashManifest(orderManifest2)));
    stabilityProblems.push(...compareHashedManifests('工廠包來源二次核對', factoryHashed1, hashManifest(factoryManifest2)));
    stabilityProblems.push(...compareHashedManifests('商品上傳圖片來源二次核對', uploadHashed1, hashManifest(uploadManifest2)));
    stabilityProblems.push(...compareHashedManifests('備份來源二次核對', backupHashed1, hashManifest(backupManifest2)));

    const srcDataVersionBeforePublish = srcDb.pragma('data_version', { simple: true });
    if (srcDataVersionBeforePublish !== srcDataVersionInitial) {
      stabilityProblems.push(`資料庫 PRAGMA data_version 改變（初次掃描時${srcDataVersionInitial}／發布前${srcDataVersionBeforePublish}），代表遷移期間有其他連線修改過資料庫`);
    }

    if (stabilityProblems.length) {
      console.error('\n發布前重新核對發現來源在遷移期間仍有變動，來源顯然沒有真正停寫，中止發布，清除本次暫存區：');
      stabilityProblems.forEach(p => console.error('  ' + p));
      safeRemoveStaging(stagingDir, destDir);
      srcDb.close();
      process.exitCode = 1;
      return;
    }
    console.log('  通過：來源在整個遷移期間維持靜止狀態（檔案與資料庫皆未變動）');

    // ── 全部驗證通過，才把 staging 內容發布（改名搬移）到正式最終位置 ──────────────
    console.log('\n暫存區驗證全數通過，開始發布到正式最終位置...');
    const published = [];
    try {
      fs.renameSync(stagingDbPath, destDbPath);
      published.push(destDbPath);
      console.log('  已發布：' + destDbPath);

      if (orderManifest.count > 0) {
        fs.renameSync(stagingOrderDir, destOrderDir);
        published.push(destOrderDir);
        console.log('  已發布：' + destOrderDir);
      }
      if (factoryManifest.count > 0) {
        fs.renameSync(stagingFactoryDir, destFactoryDir);
        published.push(destFactoryDir);
        console.log('  已發布：' + destFactoryDir);
      }
      if (uploadManifest.count > 0) {
        fs.renameSync(stagingUploadDir, destUploadDir);
        published.push(destUploadDir);
        console.log('  已發布：' + destUploadDir);
      }
      if (backupManifest.count > 0) {
        fs.renameSync(stagingBackupDir, destBackupDir);
        published.push(destBackupDir);
        console.log('  已發布：' + destBackupDir);
      }
    } catch (publishErr) {
      console.error('\n發布階段失敗，復原已發布的項目，讓最終位置回到執行前的狀態：' + publishErr.message);
      for (const target of published) {
        try { safeRemoveFinalTarget(target, destDir); console.error('  已復原刪除：' + target); }
        catch (rollbackErr) { console.error('  復原刪除失敗（需要人工檢查）：' + target + '：' + rollbackErr.message); }
      }
      safeRemoveStaging(stagingDir, destDir);
      srcDb.close();
      process.exitCode = 1;
      return;
    }

    // staging 內容已全部搬空，清掉剩下的空資料夾。
    safeRemoveStaging(stagingDir, destDir);
    srcDb.close();

    console.log('\n複製完成，來源與目的地資料一致（逐檔路徑／大小／SHA-256 已驗證）。');
    process.exitCode = 0;
  } catch (err) {
    // 複製到 staging 過程中任何失敗（例如來源檔案在掃描後、複製前被移除）：
    // 因為所有寫入動作都只發生在 staging，最終位置從未被觸碰，這裡只需要清掉 staging。
    try { srcDb.close(); } catch { /* 可能已經關閉 */ }
    console.error('\n複製到暫存區時發生錯誤，清除本次暫存區，不留下任何最終資料：' + err.message);
    try { safeRemoveStaging(stagingDir, destDir); } catch (cleanupErr) {
      console.error('清除暫存區失敗（需要人工檢查）：' + cleanupErr.message);
    }
    process.exitCode = 1;
  }
}

// 只有直接用 `node scripts/prepare-deploy-data.js` 執行時才自動跑 main()；被其他程式
// require() 時（例如隔離測試要單獨呼叫 compareHashedManifests 等純函式）不會有任何副作用。
if (require.main === module) {
  main().catch(err => {
    console.error('執行時發生未預期錯誤：', err.message);
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  buildManifest,
  hashManifest,
  compareHashedManifests,
  scanDirSafe,
  dirHasAnyFileRecursive,
  copyManifestToStaging,
  safeRemoveStaging,
  safeRemoveFinalTarget,
  formatBytes,
  SafetyAbortError
};
