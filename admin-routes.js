// 楊竹科技後台系統 — 產品／庫存／儀表板 API
// 由 server.js 掛載：app.use('/api/admin', createAdminRouter(checkAdminAuth, ORDER_DIR))
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');
const archiver = require('archiver'); // 資料庫備份下載時即時打包成.zip，用法沿用既有工廠包下載路由
const Database = require('better-sqlite3'); // 僅供「隔離還原驗證」以唯讀模式開啟備份複本使用，不會開啟或修改正式資料庫
const { db, BACKUP_DIR, createSqliteBackup, rowToProduct, recordProductAudit, getAllAiFeatureSettings, getAllAiPromptSettings, getAllAiPricingSettings,
  listAdminUsers, findAdminUserById, findAdminUserSafeById, findAdminUserByUsername, countActiveOwners,
  createAdminUser, updateAdminUserDisplayName, updateAdminUserRole, setAdminUserStatus, setAdminUserPassword,
  verifyAdminPassword, queryAdminAuditLog,
  ADMIN_PASSWORD_MIN_LEN, ADMIN_PASSWORD_MAX_LEN, isAdminPasswordLengthValid,
  getAdminReverifyLockState, recordAdminReverifyFailure, clearAdminReverifyAttempts
} = require('./db');
const { enterMaintenanceMode, exitMaintenanceMode, isMaintenanceMode } = require('./maintenance-mode'); // 正式資料庫還原安全機制
const {
  emitNotificationEvent, emitTestNotificationEvent, listAdminNotifications, countUnreadAdminNotifications,
  markAdminNotificationRead, markAllAdminNotificationsRead, getAllNotificationChannelSettings,
  setNotificationChannelSetting, queryNotificationDeliveryJobs, EVENT_TYPES: NOTIFICATION_EVENT_TYPES
} = require('./notification-service'); // 統一通知系統批次
const { getChannelStatus } = require('./notification-channels');
const { processNotificationJobsOnce } = require('./notification-worker');
const NOTIFICATION_EVENT_LABELS = {
  new_inquiry: '新詢價',
  low_stock: '低庫存',
  quote_accepted: '客戶接受報價',
  quote_rejected: '客戶拒絕報價',
  backup_restore_failed: '資料庫備份或還原失敗',
  system_error: '其他重要系統錯誤'
};
const { isSafeImageUrl, isSafeCssColorValue } = require('./js/product-service.js');
const { checkLowStockTransition } = require('./low-stock-notify');
const { requirePermission, ALL_ROLES } = require('./admin-rbac');
const { buildXlsxBuffer, buildMultiSheetXlsxBuffer, sendXlsx } = require('./xlsx-export'); // 後台「匯出Excel」共用工具：統一產生真正的.xlsx二進位檔

// ─── 商品圖片上傳 ──────────────────────────────────────────────
// 存在記憶體裡先驗證（不信任副檔名／瀏覽器回報的 mimetype），確認是真的
// JPG/PNG/WEBP 之後才用 sharp 重新編碼寫檔，順便清掉圖片裡可能夾帶的其他資料。
// 實際存放路徑改用集中式的 app-data-paths.js（部署前總驗收：單一永久資料根目錄批次），
// 跟 db.js 的 DB_DIR／BACKUP_DIR、server.js 的 ORDER_DIR／FACTORY_DIR 共用同一份判斷
// 邏輯；getProductUploadDir() 呼叫時已經會自動 ensureDir()，不需要另外再檢查一次。
const { getProductUploadDir } = require('./app-data-paths');
const PRODUCT_UPLOAD_DIR = getProductUploadDir();
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5MB
const UPLOAD_MIME_WHITELIST = ['image/jpeg', 'image/png', 'image/webp'];
const UPLOAD_FORMAT_EXT = { jpeg: 'jpg', png: 'png', webp: 'webp' };

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!UPLOAD_MIME_WHITELIST.includes(file.mimetype)) {
      return cb(new Error('UNSUPPORTED_TYPE'));
    }
    cb(null, true);
  }
});

const PRODUCT_ID_RE = /^[a-z0-9_]{2,40}$/;
const OPTION_ID_RE = /^[a-z0-9_]{1,40}$/; // 材質／工藝／容量代碼：小寫英文、數字、底線，不可有空白或符號
const SVG_VIEWBOX_RE = /^-?\d+(\.\d+)?(\s+-?\d+(\.\d+)?){3}$/; // 4 個以空白分隔的數字
const SVG_PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9\s,.\-]*$/; // 僅 SVG path 指令字元、數字、逗號、小數點、空白
const DISALLOWED_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VALID_STATUS = ['active', 'inactive', 'coming_soon'];

// ─── 商品操作歷程：欄位比對 ──────────────────────────────────
// 只比對「有意義」的商品欄位，刻意排除 createdAt／updatedAt 這兩個每次寫入都會變的
// 記帳用時間戳記——否則「內容完全沒改、只是按了儲存」也會被 updatedAt 的差異誤判成
// 「有變更」，寫出一筆假的操作歷程（違反「只記錄確實有變更的操作」的要求）。
const AUDIT_DIFF_FIELDS = [
  'name', 'nameEn', 'icon', 'image', 'badge', 'badgeColor', 'description',
  'size', 'displaySize', 'bgImage', 'labelArea', 'textLayout',
  'materials', 'finishes', 'capacities', 'qtyBreaks',
  'minQty', 'leadDays', 'color', 'textOnly', 'status', 'sortOrder',
  'priceOnInquiry', 'materialLabel', 'finishLabel', 'svgViewBox', 'svgPath',
  'archivedAt'
];

// null 與 undefined 視為同一種「沒有值」，避免新增商品時單純沒填的選填欄位
// （值是 undefined 或 null）被誤判成一筆「變更」。
function _normalizeAuditValue(v) {
  return (v === undefined || v === null) ? null : v;
}

// before 為 null 代表「新增」：after 裡任何有實際值的欄位都算數（沒有 before 可比較）。
function diffProductFields(before, after) {
  const changed = [];
  for (const key of AUDIT_DIFF_FIELDS) {
    const b = _normalizeAuditValue(before ? before[key] : null);
    const a = _normalizeAuditValue(after ? after[key] : null);
    if (JSON.stringify(b) !== JSON.stringify(a)) changed.push(key);
  }
  return changed;
}

function asArray(v, fieldName) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${fieldName} 必須是陣列`);
  return v;
}

// ─── 新增／編輯商品共用的輸入驗證 ──────────────────────────────────
// 前台（product-service.js）只在「顯示」這一關做 escape／白名單過濾，資料源頭
// （這裡）也要擋，避免後台被塞進惡意 HTML／事件屬性／危險網址／不合理數值後，
// 存進資料庫，前台就算逃過某個顯示位置的 escape 也不會執行任何腳本。
// 驗證失敗一律回傳 400 + 清楚的繁體中文訊息；找到第一個問題就回傳，不用蒐集全部錯誤。

const TEXT_FIELD_LIMITS = {
  name: 100, nameEn: 100, description: 1000, badge: 40,
  displaySize: 60, materialLabel: 20, finishLabel: 20, sizeUnit: 10, icon: 40
};

// 粗略但可靠的「這段文字不安全」判斷：角括號（代表可能是標籤）、onXXX= 事件屬性、
// javascript:／vbscript: 協議字樣，只要出現任何一種就整段拒絕，不嘗試局部清理。
function containsDangerousMarkup(str) {
  if (typeof str !== 'string') return false;
  if (/[<>]/.test(str)) return true;
  if (/\bon[a-z][a-z0-9]*\s*=/i.test(str)) return true;
  if (/javascript\s*:/i.test(str)) return true;
  if (/vbscript\s*:/i.test(str)) return true;
  return false;
}

// 驗證可選文字欄位：允許 undefined（PUT 時代表「不更動」）；允許 null／空字串（代表清空）。
function checkOptionalText(value, fieldName, maxLen) {
  if (value === undefined) return null;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return `${fieldName} 格式不正確`;
  const trimmed = value.trim();
  if (trimmed.length > maxLen) return `${fieldName} 長度不可超過 ${maxLen} 字`;
  if (containsDangerousMarkup(trimmed)) return `${fieldName} 不可包含 HTML 標籤、事件屬性或危險網址`;
  return null;
}

// 驗證可選圖片欄位（image／bgImage）：空值代表沒有圖片，允許；有值就必須通過白名單。
function checkOptionalImageUrl(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return `${fieldName} 格式不正確`;
  if (!isSafeImageUrl(value.trim())) {
    return `${fieldName} 網址不安全或格式不正確（不允許 javascript:／vbscript:／file:／data:text/html／data:image/svg+xml，僅允許站內路徑、http(s) 網址或安全的點陣圖 data:image）`;
  }
  return null;
}

// 驗證可選顏色欄位（badgeColor／color）
function checkOptionalColor(value, fieldName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return `${fieldName} 格式不正確`;
  if (!isSafeCssColorValue(value.trim())) {
    return `${fieldName} 必須是合法的顏色值（HEX、RGB／RGBA 數值需在 0~255／0~1 範圍內，或明確允許的顏色關鍵字）`;
  }
  return null;
}

// 是否是「可能代表數字」的輸入型別：只接受 number／string，明確拒絕陣列、物件、null、
// boolean 等會被 Number() 靜靜轉成 0 或其他意外值的型別（例如 Number([]) === 0、
// Number([5]) === 5、Number(null) === 0），避免這類輸入繞過數字驗證。
function isNumericInputType(value) {
  return typeof value === 'number' || typeof value === 'string';
}

// 驗證可選有限數字欄位：先檢查型別，再轉換數值；拒絕 NaN、Infinity、陣列、物件、null，
// 並可加合理範圍限制（min／max／exclusiveMin）或要求整數（integer）。
function checkOptionalFiniteNumber(value, fieldName, { min, max, exclusiveMin, integer } = {}) {
  if (value === undefined) return null;
  if (value === null || value === '') return null;
  if (!isNumericInputType(value)) return `${fieldName} 必須是數字`;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return `${fieldName} 必須是有限的數字`;
  if (integer && !Number.isInteger(n)) return `${fieldName} 必須是整數`;
  if (exclusiveMin !== undefined && n <= exclusiveMin) return `${fieldName} 必須大於 ${exclusiveMin}`;
  if (min !== undefined && n < min) return `${fieldName} 不可小於 ${min}`;
  if (max !== undefined && n > max) return `${fieldName} 不可大於 ${max}`;
  return null;
}

// 驗證必填有限數字欄位：undefined／null／空字串一律視為缺漏。
function checkRequiredFiniteNumber(value, fieldName, opts = {}) {
  if (value === undefined || value === null || value === '') return `${fieldName} 為必填欄位`;
  return checkOptionalFiniteNumber(value, fieldName, opts);
}

// 驗證材質／工藝／容量陣列：不可為空陣列（至少一項）；id 只能小寫英文/數字/底線且
// 陣列內不可重複、name 必填；價格欄位（priceBase／price）為必填，且要是有限數字、
// 落在 priceOpts 指定的合理範圍內（材質/工藝/容量價格不得為負數）。
function checkOptionEntries(list, fieldName, priceField, priceOpts) {
  if (!Array.isArray(list)) return `${fieldName} 必須是陣列`;
  if (list.length === 0) return `${fieldName} 不可為空陣列，至少需要一項`;
  const seenIds = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return `${fieldName} 每一項必須是物件`;
    }
    if (typeof item.id !== 'string' || !OPTION_ID_RE.test(item.id.trim())) {
      return `${fieldName} 的代碼格式不正確，只能使用小寫英文、數字、底線，長度 1~40，不可有空白或符號`;
    }
    const idTrimmed = item.id.trim();
    if (seenIds.has(idTrimmed)) {
      return `${fieldName} 的代碼「${idTrimmed}」重複，同一組選項代碼不可重複`;
    }
    seenIds.add(idTrimmed);
    if (typeof item.name !== 'string' || !item.name.trim()) {
      return `${fieldName} 的名稱不可空白`;
    }
    if (item.name.length > 60 || containsDangerousMarkup(item.name)) {
      return `${fieldName}「${idTrimmed}」的名稱不可包含 HTML 標籤或事件屬性，長度需在 60 字以內`;
    }
    if (item[priceField] === undefined || item[priceField] === null) {
      return `${fieldName}「${item.name}」缺少必填的價格欄位（${priceField}）`;
    }
    const err = checkOptionalFiniteNumber(item[priceField], `${fieldName}「${item.name}」的價格`, priceOpts);
    if (err) return err;
  }
  return null;
}

// 驗證數量折扣陣列：不可為空陣列；min 必須是正整數；max 可省略／null，代表這一段
// 沒有上限（向上無限），但只有「min 最大的那一段」可以省略 max——其餘段落都必須填寫
// 明確的 max，否則一段宣稱無上限會把後面明明定義好的更高級距整段吃掉，導致同一個
// 數量同時符合兩段、無法判斷唯一命中哪一段。price 為必填欄位，且要是合理範圍內的
// 有限數字（允許合理負數代表折扣）；陣列內各區間（含向上無限那一段）不可重疊。
function checkQtyBreaks(list) {
  if (!Array.isArray(list)) return '數量折扣必須是陣列';
  if (list.length === 0) return '數量折扣不可為空陣列，至少需要一組級距';
  const ranges = [];
  for (const b of list) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return '數量折扣每一項必須是物件';
    const minErr = checkRequiredFiniteNumber(b.min, '數量折扣的最小數量', { integer: true, min: 1, max: 1000000 });
    if (minErr) return minErr;
    const minN = Number(b.min);

    let maxN = null; // null 代表這一段沒有上限
    if (b.max !== undefined && b.max !== null) {
      const maxErr = checkRequiredFiniteNumber(b.max, '數量折扣的最大數量', { integer: true, min: 1, max: 1000000 });
      if (maxErr) return maxErr;
      maxN = Number(b.max);
      if (minN > maxN) {
        return `數量折扣區間不正確：最小數量（${minN}）不可大於最大數量（${maxN}）`;
      }
    }

    const priceErr = checkRequiredFiniteNumber(b.price, '數量折扣的價格', { min: -100000, max: 1000000 });
    if (priceErr) return priceErr;
    ranges.push({ min: minN, max: maxN });
  }

  const sorted = ranges.slice().sort((a, c) => a.min - c.min);

  // 只有 min 最大的那一段（排序後的最後一筆）可以是無上限（max === null）；
  // 其餘段落一律要求填寫明確的 max，避免中間出現無上限的段落。
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].max === null) {
      return '只有數量最高的那一段可以不填最大數量（代表向上無限），其餘級距都必須填寫最大數量';
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const prevMax = sorted[i - 1].max; // 前面迴圈已確認除了最後一段以外都不是 null
    if (sorted[i].min <= prevMax) {
      const currMaxText = sorted[i].max === null ? '不限' : sorted[i].max;
      return `數量折扣區間互相重疊：${sorted[i - 1].min}~${prevMax} 與 ${sorted[i].min}~${currMaxText}`;
    }
  }
  return null;
}

// 驗證可選布林欄位：只接受真正的 boolean，拒絕字串 "true"／數字 1 等易混淆的型別。
function checkOptionalBoolean(value, fieldName) {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') return `${fieldName} 必須是布林值（true 或 false）`;
  return null;
}

function checkOptionalSvgViewBox(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'svgViewBox 格式不正確';
  const trimmed = value.trim();
  if (trimmed.length > 200) return 'svgViewBox 長度過長';
  if (!SVG_VIEWBOX_RE.test(trimmed)) {
    return 'svgViewBox 格式不正確，需為 4 個以空白分隔的數字（例如 0 0 856 540）';
  }
  return null;
}

function checkOptionalSvgPath(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') return 'svgPath 格式不正確';
  if (value.length > 20000) return 'svgPath 長度過長';
  if (!SVG_PATH_RE.test(value)) {
    return 'svgPath 只能包含 SVG path 指令字元（M/L/H/V/C/S/Q/T/A/Z）、數字、逗號、小數點與空白，不可包含標籤、文字或 script';
  }
  return null;
}

function checkOptionalLabelArea(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'labelArea 必須是物件';
  const xErr = checkRequiredFiniteNumber(value.xRatio, 'labelArea.xRatio', { min: 0, max: 1 });
  if (xErr) return xErr;
  const yErr = checkRequiredFiniteNumber(value.yRatio, 'labelArea.yRatio', { min: 0, max: 1 });
  if (yErr) return yErr;
  const wErr = checkRequiredFiniteNumber(value.wRatio, 'labelArea.wRatio', { exclusiveMin: 0, max: 1 });
  if (wErr) return wErr;
  const hErr = checkRequiredFiniteNumber(value.hRatio, 'labelArea.hRatio', { exclusiveMin: 0, max: 1 });
  if (hErr) return hErr;
  const x = Number(value.xRatio), y = Number(value.yRatio), w = Number(value.wRatio), h = Number(value.hRatio);
  if (x + w > 1) return 'labelArea 的 xRatio + wRatio 不可超過 1（印刷區域會超出卡面寬度）';
  if (y + h > 1) return 'labelArea 的 yRatio + hRatio 不可超過 1（印刷區域會超出卡面高度）';
  return null;
}

// 遞迴檢查 textLayout 是否為「純資料」物件：只能包含字串／有限數字／布林／null／
// 陣列／純物件，深度與陣列長度都有上限，且任何層級都不可出現 __proto__／constructor／
// prototype 這類會導致原型污染的鍵名。
function isPlainSafeValue(value, depth, maxDepth) {
  if (depth > maxDepth) return false;
  if (value === null) return true;
  const t = typeof value;
  if (t === 'string') return value.length <= 200 && !containsDangerousMarkup(value);
  if (t === 'number') return Number.isFinite(value);
  if (t === 'boolean') return true;
  if (Array.isArray(value)) {
    if (value.length > 50) return false;
    return value.every(item => isPlainSafeValue(item, depth + 1, maxDepth));
  }
  if (t === 'object') {
    const keys = Object.keys(value);
    if (keys.length > 50) return false;
    for (const k of keys) {
      if (DISALLOWED_OBJECT_KEYS.has(k)) return false;
      if (!isPlainSafeValue(value[k], depth + 1, maxDepth)) return false;
    }
    return true;
  }
  return false; // function、symbol、undefined 陣列元素等一律不允許
}

function checkOptionalTextLayout(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return 'textLayout 必須是物件';
  let json;
  try { json = JSON.stringify(value); } catch { return 'textLayout 格式不正確'; }
  if (json.length > 5000) return 'textLayout 內容過大';
  if (!isPlainSafeValue(value, 0, 4)) {
    return 'textLayout 內容格式不正確（不可包含 __proto__/constructor/prototype，內容深度或大小超出合理範圍）';
  }
  return null;
}

// 主驗證函式：新增（POST）與編輯（PUT）都呼叫這支，只驗證 body 裡「有出現」的欄位，
// 回傳第一個驗證錯誤訊息（string），全部通過回傳 null。
function validateProductBody(b, { isCreate }) {
  if (isCreate) {
    const id = String(b.id || '').trim();
    if (!PRODUCT_ID_RE.test(id)) {
      return '產品代碼只能用小寫英文/數字/底線，2~40 字，例如 usb_bar';
    }
    if (!b.name || !String(b.name).trim()) {
      return '請輸入產品名稱';
    }
    // 新增商品的必填欄位：只給 id/name 就想建立商品，會漏掉報價與規格頁面需要的
    // 核心資料，之後前台會整組壞掉，所以這裡一次擋下來，而不是等前台渲染時才發現。
    const wErr = checkRequiredFiniteNumber(b.size?.w, '寬度 (size.w)', { exclusiveMin: 0, max: 100000 });
    if (wErr) return wErr;
    const hErr = checkRequiredFiniteNumber(b.size?.h, '高度 (size.h)', { exclusiveMin: 0, max: 100000 });
    if (hErr) return hErr;
    if (!b.size || typeof b.size.unit !== 'string') {
      return '請提供尺寸單位 (size.unit)，若商品沒有實體單位可設為空字串';
    }
    if (b.materials === undefined) return '請提供材質清單 (materials)';
    if (b.finishes === undefined) return '請提供工藝清單 (finishes)';
    if (b.qtyBreaks === undefined) return '請提供數量價格級距 (qtyBreaks)';
    const minQtyErr = checkRequiredFiniteNumber(b.minQty, '最少訂購數量 (minQty)', { integer: true, min: 1, max: 1000000 });
    if (minQtyErr) return minQtyErr;
    const leadDaysErr = checkRequiredFiniteNumber(b.leadDays, '交期天數 (leadDays)', { integer: true, min: 0, max: 3650 });
    if (leadDaysErr) return leadDaysErr;
    if (b.status === undefined || !VALID_STATUS.includes(b.status)) {
      return '請選擇正確的狀態 (status)：active、inactive 或 coming_soon';
    }
  }
  if (b.name !== undefined && (!String(b.name).trim() || String(b.name).length > TEXT_FIELD_LIMITS.name)) {
    return `產品名稱不可空白，長度需在 ${TEXT_FIELD_LIMITS.name} 字以內`;
  }
  if (b.name !== undefined && containsDangerousMarkup(String(b.name))) {
    return '產品名稱不可包含 HTML 標籤、事件屬性或危險網址';
  }

  for (const field of ['nameEn', 'description', 'badge', 'displaySize', 'materialLabel', 'finishLabel', 'icon']) {
    const err = checkOptionalText(b[field], field, TEXT_FIELD_LIMITS[field]);
    if (err) return err;
  }
  if (b.size?.unit !== undefined) {
    const err = checkOptionalText(b.size.unit, '尺寸單位', TEXT_FIELD_LIMITS.sizeUnit);
    if (err) return err;
  }

  {
    const err = checkOptionalImageUrl(b.image, '商品圖片路徑');
    if (err) return err;
  }
  {
    const err = checkOptionalImageUrl(b.bgImage, '底圖路徑');
    if (err) return err;
  }
  {
    const err = checkOptionalColor(b.badgeColor, '徽章顏色');
    if (err) return err;
  }
  {
    const err = checkOptionalColor(b.color, '主題色');
    if (err) return err;
  }

  if (b.size?.w !== undefined) {
    const err = checkOptionalFiniteNumber(b.size.w, '寬度', { exclusiveMin: 0, max: 100000 });
    if (err) return err;
  }
  if (b.size?.h !== undefined) {
    const err = checkOptionalFiniteNumber(b.size.h, '高度', { exclusiveMin: 0, max: 100000 });
    if (err) return err;
  }
  {
    const err = checkOptionalFiniteNumber(b.minQty, '最少訂購數量', { integer: true, min: 1, max: 1000000 });
    if (err) return err;
  }
  {
    const err = checkOptionalFiniteNumber(b.leadDays, '交期天數', { integer: true, min: 0, max: 3650 });
    if (err) return err;
  }
  {
    const err = checkOptionalFiniteNumber(b.sortOrder, '排序', { integer: true, min: -1000000, max: 1000000 });
    if (err) return err;
  }

  {
    const err = checkOptionalSvgViewBox(b.svgViewBox);
    if (err) return err;
  }
  {
    const err = checkOptionalSvgPath(b.svgPath);
    if (err) return err;
  }
  {
    const err = checkOptionalLabelArea(b.labelArea);
    if (err) return err;
  }
  {
    const err = checkOptionalTextLayout(b.textLayout);
    if (err) return err;
  }
  {
    const err = checkOptionalBoolean(b.textOnly, 'textOnly');
    if (err) return err;
  }
  {
    const err = checkOptionalBoolean(b.priceOnInquiry, 'priceOnInquiry');
    if (err) return err;
  }
  if (b.status !== undefined && !VALID_STATUS.includes(b.status)) {
    return '狀態值不正確，只能是 active、inactive 或 coming_soon';
  }

  if (b.materials !== undefined) {
    const err = checkOptionEntries(b.materials, '材質', 'priceBase', { min: 0, max: 1000000 });
    if (err) return err;
  }
  if (b.finishes !== undefined) {
    const err = checkOptionEntries(b.finishes, '工藝', 'price', { min: 0, max: 1000000 });
    if (err) return err;
  }
  if (b.capacities !== undefined && b.capacities !== null) {
    const err = checkOptionEntries(b.capacities, '容量', 'price', { min: 0, max: 1000000 });
    if (err) return err;
  }
  if (b.qtyBreaks !== undefined) {
    const err = checkQtyBreaks(b.qtyBreaks);
    if (err) return err;
  }

  return null;
}

module.exports = function createAdminRouter(checkAdminAuth, ORDER_DIR, csrfProtection, auditLogMiddleware, adminSessionTtlHours) {
  const router = express.Router();
  router.use(checkAdminAuth);
  // 操作稽核（正式管理員帳號、角色權限、登入限制與操作稽核批次）：auditLogMiddleware 由
  // server.js建立並傳入（跟checkAdminAuth／csrfProtection同一套「共用同一份實作」慣例）。
  // 2026-08-14 Codex獨立複驗指出：原本掛在csrfProtection之後，CSRF Token驗證失敗或
  // requirePermission()權限被拒絕的請求，res.on('finish')監聽器根本還沒被註冊就已經被
  // 攔截回應，導致這些失敗一律不會留下稽核紀錄。改成排在checkAdminAuth之後、csrfProtection
  // 與requirePermission()之前——只要通過登入驗證，不論後面CSRF檢查或權限檢查是否通過，
  // 這個router底下「現在有的、以後新增的」所有寫入型（POST/PUT/PATCH/DELETE）路由都保證
  // 會留下稽核紀錄（成功或失敗），不需要每支路由各自手動呼叫一次寫入稽核紀錄的程式碼。
  router.use(auditLogMiddleware);
  // CSRF防護（登入與憑證傳輸安全批次）：對本router底下所有POST/PUT/PATCH/DELETE要求
  // X-CSRF-Token與目前Session綁定的雜湊相符，GET一律放行（見server.js的csrfProtection()）。
  // 2026-08-14 Codex獨立複驗建議的執行順序是 checkAdminAuth → auditLogMiddleware →
  // requirePermission() → CSRF檢查 → handler（沒有權限就不用再驗證CSRF）：改成不在router
  // 層級統一掛csrfProtection，而是跟requirePermission()一樣，各自以路由專屬中介層的方式
  // 插在每一支路由的requirePermission()「之後」（見下面每一支router.get／post／put／delete
  // 呼叫都自動補上了`, csrfProtection,`；GET路由csrfProtection()內部一律直接放行，掛上去
  // 不影響行為，只是保持所有路由統一寫法，不需要另外分兩種寫法）。

  // ── 登入驗證用（前端用來確認 Session 是否還有效）──
  router.get('/ping', requirePermission('session', 'view'), (req, res) => res.json({ ok: true }));

  // ── 共用：預估逾期截止時間（GET /dashboard 與 GET /analytics/overview 共用同一份公式）───
  // Codex獨立複驗發現這兩支路由原本各自維護一份「用leadDays推算逾期」的公式：dashboard用
  // 「savedAt換算成台北日曆日、加上leadDays個台北日曆天、以當天23:59:59.999為截止」，
  // analytics/overview卻用「savedAt精確時間直接加上leadDays*24小時」，同一筆訂單在兩支API上
  // 逾期判定會不一致。統一抽出這支函式，兩邊都改呼叫這裡，不得各自複製一份公式。
  // 回傳UTC毫秒時間戳；savedAtIso格式錯誤、或leadDays不是「型別為number、有限值、整數、
  // 且>=0」，一律回傳null（呼叫端據此不猜測、不計入逾期），不可以用0天或忽略驗證直接相減。
  const SHARED_ESTIMATED_DEADLINE_TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
  function computeEstimatedDeadlineUtcMs(savedAtIso, leadDays) {
    if (typeof savedAtIso !== 'string' || !savedAtIso) return null;
    const savedMs = new Date(savedAtIso).getTime();
    if (!Number.isFinite(savedMs)) return null;
    const leadDaysValid = typeof leadDays === 'number' && Number.isFinite(leadDays) && Number.isInteger(leadDays) && leadDays >= 0;
    if (!leadDaysValid) return null;
    const taipeiMs = savedMs + SHARED_ESTIMATED_DEADLINE_TAIPEI_OFFSET_MS;
    const taipei = new Date(taipeiMs);
    const y = taipei.getUTCFullYear(), m = taipei.getUTCMonth(), d = taipei.getUTCDate();
    const savedTaipeiMidnightUtcMs = Date.UTC(y, m, d, 0, 0, 0, 0) - SHARED_ESTIMATED_DEADLINE_TAIPEI_OFFSET_MS;
    return savedTaipeiMidnightUtcMs + leadDays * 86400000 + 86399999; // + N個台北日曆天 + 23:59:59.999
  }

  // ══════════════ 商品圖片上傳 ══════════════
  // 這支路由掛在 router 底下，checkAdminAuth 已經在最上面 router.use() 套用過了，
  // 未登入呼叫一樣會被擋在 multer 解析檔案之前，回傳 401。
  router.post('/upload-image', requirePermission('products', 'write'), csrfProtection, (req, res) => {
    upload.single('image')(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: '圖片檔案大小不可超過 5MB' });
        }
        if (err.message === 'UNSUPPORTED_TYPE') {
          return res.status(400).json({ error: '只允許上傳 JPG、PNG、WEBP 格式的圖片' });
        }
        return res.status(400).json({ error: '圖片上傳失敗，請重新選擇檔案' });
      }
      if (!req.file) {
        return res.status(400).json({ error: '請選擇要上傳的圖片' });
      }

      // 不信任副檔名或瀏覽器回報的 mimetype：實際讀取檔案內容判斷真正格式，
      // 避免有人把危險檔案（例如偽裝成 .jpg 的 HTML/SVG）改副檔名上傳。
      let meta;
      try {
        meta = await sharp(req.file.buffer).metadata();
      } catch {
        return res.status(400).json({ error: '檔案不是有效的圖片，請確認為 JPG、PNG 或 WEBP' });
      }
      const ext = UPLOAD_FORMAT_EXT[meta.format];
      if (!ext) {
        return res.status(400).json({ error: '只允許上傳 JPG、PNG、WEBP 格式的圖片，偵測到的檔案格式不符' });
      }

      try {
        // 檔名完全由伺服器產生（跟原始檔名無關），不會有路徑穿越問題；
        // 迴圈檢查是多一層保險，避免極端情況下的亂數碰撞覆蓋既有檔案。
        let filename, destPath;
        do {
          filename = crypto.randomBytes(16).toString('hex') + '.' + ext;
          destPath = path.join(PRODUCT_UPLOAD_DIR, filename);
        } while (fs.existsSync(destPath));

        // 用 sharp 重新編碼再寫檔（不是直接存原始 buffer），順便清掉圖片裡可能夾帶的
        // 額外資料，輸出的一定是乾淨、格式正確的圖片檔案。
        let pipeline = sharp(req.file.buffer);
        if (meta.format === 'jpeg') pipeline = pipeline.jpeg({ quality: 90 });
        else if (meta.format === 'png') pipeline = pipeline.png();
        else if (meta.format === 'webp') pipeline = pipeline.webp({ quality: 90 });
        const outputBuffer = await pipeline.toBuffer();

        fs.writeFileSync(destPath, outputBuffer);

        res.json({ success: true, path: `assets/uploads/products/${filename}` });
      } catch (e) {
        res.status(500).json({ error: '圖片儲存失敗，請稍後再試' });
      }
    });
  });

  // ══════════════ 產品管理 ══════════════
  // 預設（無 query 或 archived 不是 '1'）只回傳「目前商品」（未封存）；
  // ?archived=1 回傳「已封存」商品清單。封存不影響 status，兩者是互相獨立的篩選維度。
  router.get('/products', requirePermission('products', 'view'), csrfProtection, (req, res) => {
    const wantArchived = req.query.archived === '1';
    const rows = wantArchived
      ? db.prepare('SELECT * FROM products WHERE archived_at IS NOT NULL ORDER BY archived_at DESC').all()
      : db.prepare('SELECT * FROM products WHERE archived_at IS NULL ORDER BY sort_order ASC, id ASC').all();
    res.json({ success: true, products: rows.map(rowToProduct) });
  });

  // ─── API：商品匯出Excel ─────────────────────────────
  // 「商品管理」頁面沒有分頁、目前／已封存兩個頁籤各自載入全部資料後在瀏覽器端渲染，
  // 所以匯出邏輯比照訂單匯出：前端把目前畫面上看到的那份資料整理好傳過來，後端只負責
  // 轉成真正的.xlsx，避免又在後端重寫一次「目前商品／已封存」的判斷邏輯。
  router.post('/products/export', requirePermission('products', 'view'), csrfProtection, async (req, res) => {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) {
      return res.status(400).json({ error: '目前沒有可以匯出的商品' });
    }
    if (rows.length > 5000) {
      return res.status(400).json({ error: '一次最多匯出5000筆，請縮小範圍後再匯出' });
    }
    const columns = [
      { header: '產品代號', key: 'id', width: 16 },
      { header: '名稱', key: 'name', width: 20 },
      { header: '狀態', key: 'status', width: 12 },
      { header: '材質數量', key: 'materialCount', width: 10 },
      { header: '工藝數量', key: 'finishCount', width: 10 },
      { header: '最少訂購量', key: 'minQty', width: 12 },
      { header: '交期天數', key: 'leadDays', width: 10 },
      { header: '排序／封存時間', key: 'sortInfo', width: 20 }
    ];
    const safeRows = rows.map(r => ({
      id: String(r?.id ?? ''),
      name: String(r?.name ?? ''),
      status: String(r?.status ?? ''),
      materialCount: Number.isFinite(Number(r?.materialCount)) ? Number(r.materialCount) : 0,
      finishCount: Number.isFinite(Number(r?.finishCount)) ? Number(r.finishCount) : 0,
      minQty: String(r?.minQty ?? ''),
      leadDays: String(r?.leadDays ?? ''),
      sortInfo: String(r?.sortInfo ?? '')
    }));
    try {
      const buffer = await buildXlsxBuffer('商品', columns, safeRows);
      sendXlsx(res, '楊竹商品', buffer);
    } catch (err) {
      console.error('[products/export] 產生Excel失敗', err.message);
      res.status(500).json({ error: '匯出失敗，請稍後再試' });
    }
  });

  router.post('/products', requirePermission('products', 'write'), csrfProtection, (req, res) => {
    const b = req.body || {};
    const id = String(b.id || '').trim();
    const validationError = validateProductBody(b, { isCreate: true });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const exists = db.prepare('SELECT 1 FROM products WHERE id = ?').get(id);
    if (exists) {
      return res.status(409).json({ error: `產品代碼「${id}」已存在，請換一個` });
    }
    const status = VALID_STATUS.includes(b.status) ? b.status : 'active';

    let materials, finishes, capacities, qtyBreaks;
    try {
      materials  = asArray(b.materials, '材質');
      finishes   = asArray(b.finishes, '工藝');
      qtyBreaks  = asArray(b.qtyBreaks, '數量折扣');
      capacities = (b.capacities === undefined || b.capacities === null) ? null : asArray(b.capacities, '容量');
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const now = new Date().toISOString();
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM products').get().m;

    // 商品新增、庫存初始化、操作歷程寫入放在同一個 transaction：任何一步失敗都整批回滾，
    // 不會出現「商品已建立但歷程漏寫」或「歷程寫了但商品其實沒建立」的不一致狀態。
    const createTx = db.transaction(() => {
      db.prepare(`
        INSERT INTO products (
          id, name, name_en, icon, image, badge, badge_color, description,
          size_w, size_h, size_unit, display_size, bg_image, label_area_json, text_layout_json,
          materials_json, finishes_json, capacities_json, qty_breaks_json,
          min_qty, lead_days, color, text_only, status, sort_order,
          price_on_inquiry, material_label, finish_label, svg_view_box, svg_path,
          created_at, updated_at
        ) VALUES (
          @id, @name, @name_en, @icon, @image, @badge, @badge_color, @description,
          @size_w, @size_h, @size_unit, @display_size, @bg_image, @label_area_json, @text_layout_json,
          @materials_json, @finishes_json, @capacities_json, @qty_breaks_json,
          @min_qty, @lead_days, @color, @text_only, @status, @sort_order,
          @price_on_inquiry, @material_label, @finish_label, @svg_view_box, @svg_path,
          @created_at, @updated_at
        )
      `).run({
        id,
        name: String(b.name).trim(),
        name_en: b.nameEn || null,
        icon: b.icon || null,
        image: b.image || null,
        badge: b.badge || null,
        badge_color: b.badgeColor || null,
        description: b.description || null,
        size_w: b.size?.w != null ? Number(b.size.w) : null,
        size_h: b.size?.h != null ? Number(b.size.h) : null,
        size_unit: b.size?.unit || '',
        display_size: b.displaySize || null,
        bg_image: b.bgImage || null,
        label_area_json: b.labelArea ? JSON.stringify(b.labelArea) : null,
        text_layout_json: b.textLayout ? JSON.stringify(b.textLayout) : null,
        materials_json: JSON.stringify(materials),
        finishes_json: JSON.stringify(finishes),
        capacities_json: capacities ? JSON.stringify(capacities) : null,
        qty_breaks_json: JSON.stringify(qtyBreaks),
        min_qty: b.minQty != null ? Number(b.minQty) : 1,
        lead_days: b.leadDays != null ? Number(b.leadDays) : 15,
        color: b.color || null,
        text_only: b.textOnly ? 1 : 0,
        status,
        sort_order: maxSort + 1,
        price_on_inquiry: b.priceOnInquiry ? 1 : 0,
        material_label: b.materialLabel || null,
        finish_label: b.finishLabel || null,
        svg_view_box: b.svgViewBox || null,
        svg_path: b.svgPath || null,
        created_at: now,
        updated_at: now
      });

      db.prepare(`
        INSERT INTO inventory (product_id, stock_qty, low_stock_threshold, unit, updated_at)
        VALUES (?, 0, 0, '個', ?)
      `).run(id, now);

      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      const product = rowToProduct(row);
      recordProductAudit({
        productId: id,
        action: 'create',
        before: null,
        after: product,
        changedFields: diffProductFields(null, product)
      });
      return product;
    });

    res.json({ success: true, product: createTx() });
  });

  router.put('/products/:id', requirePermission('products', 'write'), csrfProtection, (req, res) => {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '找不到此產品' });
    if (existing.archived_at) {
      return res.status(409).json({ error: '此商品已封存，請先還原才能編輯或切換狀態' });
    }

    const b = req.body || {};
    const validationError = validateProductBody(b, { isCreate: false });
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    let materials, finishes, capacities, qtyBreaks;
    try {
      materials  = b.materials  !== undefined ? asArray(b.materials, '材質')   : JSON.parse(existing.materials_json || '[]');
      finishes   = b.finishes   !== undefined ? asArray(b.finishes, '工藝')    : JSON.parse(existing.finishes_json || '[]');
      qtyBreaks  = b.qtyBreaks  !== undefined ? asArray(b.qtyBreaks, '數量折扣') : JSON.parse(existing.qty_breaks_json || '[]');
      capacities = b.capacities !== undefined
        ? (b.capacities === null ? null : asArray(b.capacities, '容量'))
        : (existing.capacities_json ? JSON.parse(existing.capacities_json) : null);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const merged = {
      name: b.name !== undefined ? String(b.name).trim() : existing.name,
      name_en: b.nameEn !== undefined ? b.nameEn : existing.name_en,
      icon: b.icon !== undefined ? b.icon : existing.icon,
      image: b.image !== undefined ? b.image : existing.image,
      badge: b.badge !== undefined ? b.badge : existing.badge,
      badge_color: b.badgeColor !== undefined ? b.badgeColor : existing.badge_color,
      description: b.description !== undefined ? b.description : existing.description,
      size_w: b.size?.w !== undefined ? Number(b.size.w) : existing.size_w,
      size_h: b.size?.h !== undefined ? Number(b.size.h) : existing.size_h,
      size_unit: b.size?.unit !== undefined ? b.size.unit : existing.size_unit,
      display_size: b.displaySize !== undefined ? b.displaySize : existing.display_size,
      bg_image: b.bgImage !== undefined ? b.bgImage : existing.bg_image,
      label_area_json: b.labelArea !== undefined ? (b.labelArea ? JSON.stringify(b.labelArea) : null) : existing.label_area_json,
      text_layout_json: b.textLayout !== undefined ? (b.textLayout ? JSON.stringify(b.textLayout) : null) : existing.text_layout_json,
      materials_json: JSON.stringify(materials),
      finishes_json: JSON.stringify(finishes),
      capacities_json: capacities ? JSON.stringify(capacities) : null,
      qty_breaks_json: JSON.stringify(qtyBreaks),
      min_qty: b.minQty !== undefined ? Number(b.minQty) : existing.min_qty,
      lead_days: b.leadDays !== undefined ? Number(b.leadDays) : existing.lead_days,
      color: b.color !== undefined ? b.color : existing.color,
      text_only: b.textOnly !== undefined ? (b.textOnly ? 1 : 0) : existing.text_only,
      status: b.status !== undefined ? b.status : existing.status,
      sort_order: b.sortOrder !== undefined ? Number(b.sortOrder) : existing.sort_order,
      price_on_inquiry: b.priceOnInquiry !== undefined ? (b.priceOnInquiry ? 1 : 0) : existing.price_on_inquiry,
      material_label: b.materialLabel !== undefined ? (b.materialLabel || null) : existing.material_label,
      finish_label: b.finishLabel !== undefined ? (b.finishLabel || null) : existing.finish_label,
      svg_view_box: b.svgViewBox !== undefined ? (b.svgViewBox || null) : existing.svg_view_box,
      svg_path: b.svgPath !== undefined ? (b.svgPath || null) : existing.svg_path,
      updated_at: new Date().toISOString(),
      id
    };

    const beforeProduct = rowToProduct(existing);

    // 商品更新與操作歷程寫入放在同一個 transaction；「有沒有變更」的判斷也放在
    // transaction 裡面用更新後的實際資料來比對（而不是先比對 body 再更新），確保
    // 記錄的 before/after 一定跟資料庫實際寫入的內容一致。沒有任何欄位變更（例如
    // 表單原封不動按下儲存）時完全不寫歷程，不能留下一筆假紀錄。
    const updateTx = db.transaction(() => {
      db.prepare(`
        UPDATE products SET
          name=@name, name_en=@name_en, icon=@icon, image=@image, badge=@badge, badge_color=@badge_color,
          description=@description, size_w=@size_w, size_h=@size_h, size_unit=@size_unit,
          display_size=@display_size, bg_image=@bg_image, label_area_json=@label_area_json, text_layout_json=@text_layout_json,
          materials_json=@materials_json, finishes_json=@finishes_json, capacities_json=@capacities_json, qty_breaks_json=@qty_breaks_json,
          min_qty=@min_qty, lead_days=@lead_days, color=@color, text_only=@text_only,
          status=@status, sort_order=@sort_order,
          price_on_inquiry=@price_on_inquiry, material_label=@material_label, finish_label=@finish_label,
          svg_view_box=@svg_view_box, svg_path=@svg_path,
          updated_at=@updated_at
        WHERE id=@id
      `).run(merged);

      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      const afterProduct = rowToProduct(row);
      const changed = diffProductFields(beforeProduct, afterProduct);
      if (changed.length > 0) {
        // PUT 是商品編輯表單跟「上下架狀態下拉」共用的同一支 API：只有 status 這
        // 一個欄位變更時視為 status_change，其餘（含 status 混著其他欄位一起改）都算 update。
        const action = (changed.length === 1 && changed[0] === 'status') ? 'status_change' : 'update';
        recordProductAudit({ productId: id, action, before: beforeProduct, after: afterProduct, changedFields: changed });
      }
      return afterProduct;
    });

    res.json({ success: true, product: updateTx() });
  });

  // ══════════════ 商品封存／還原 ══════════════
  // 只寫入／清空 archived_at 一個欄位，不刪除商品本身、圖片、庫存（inventory）、
  // 庫存異動紀錄（inventory_log）或任何歷史訂單資料——訂單資料存在 ORDER_DIR 的
  // JSON 檔案裡，跟這張表完全無關，本來就不會被這裡的 UPDATE 影響到。
  router.post('/products/:id/archive', requirePermission('products', 'write'), csrfProtection, (req, res) => {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '找不到此產品' });

    if (existing.archived_at) {
      // 重複封存：不視為錯誤，直接回傳目前狀態，前端不需要特別處理就能安全地重複點擊。
      // 沒有實際變更，不寫任何歷程（避免假紀錄）。
      return res.json({ success: true, alreadyArchived: true, product: rowToProduct(existing) });
    }

    const beforeProduct = rowToProduct(existing);
    const now = new Date().toISOString();
    const archiveTx = db.transaction(() => {
      db.prepare('UPDATE products SET archived_at = ? WHERE id = ?').run(now, id);
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      const afterProduct = rowToProduct(row);
      recordProductAudit({ productId: id, action: 'archive', before: beforeProduct, after: afterProduct, changedFields: diffProductFields(beforeProduct, afterProduct) });
      return afterProduct;
    });
    res.json({ success: true, alreadyArchived: false, product: archiveTx() });
  });

  router.post('/products/:id/restore', requirePermission('products', 'write'), csrfProtection, (req, res) => {
    const { id } = req.params;
    const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: '找不到此產品' });

    if (!existing.archived_at) {
      // 重複還原：同樣安全處理，回傳目前狀態而非錯誤，不寫任何歷程。
      return res.json({ success: true, alreadyActive: true, product: rowToProduct(existing) });
    }

    const beforeProduct = rowToProduct(existing);
    const restoreTx = db.transaction(() => {
      db.prepare('UPDATE products SET archived_at = NULL WHERE id = ?').run(id);
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
      const afterProduct = rowToProduct(row);
      recordProductAudit({ productId: id, action: 'restore', before: beforeProduct, after: afterProduct, changedFields: diffProductFields(beforeProduct, afterProduct) });
      return afterProduct;
    });
    res.json({ success: true, alreadyActive: false, product: restoreTx() });
  });

  // ══════════════ 商品操作歷程（唯讀）══════════════
  // 只提供查詢，刻意不提供修改／刪除這張表的 API。掛在 router 底下已經套用 checkAdminAuth，
  // 未登入一律 401；不會被公開商品 API（server.js 的 /api/products）回傳，前台完全看不到。
  const AUDIT_ACTIONS = ['create', 'update', 'status_change', 'archive', 'restore'];

  router.get('/products/audit-log', requirePermission('products', 'view'), csrfProtection, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    const conditions = [];
    const params = {};
    if (req.query.productId) {
      conditions.push('l.product_id = @productId');
      params.productId = String(req.query.productId);
    }
    if (req.query.action) {
      if (!AUDIT_ACTIONS.includes(req.query.action)) {
        return res.status(400).json({ error: '不支援的操作類型篩選' });
      }
      conditions.push('l.action = @action');
      params.action = req.query.action;
    }
    const whereClause = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const total = db.prepare(`SELECT COUNT(*) AS c FROM product_audit_log l ${whereClause}`).get(params).c;
    const rows = db.prepare(`
      SELECT l.*, p.name AS product_name
      FROM product_audit_log l
      LEFT JOIN products p ON p.id = l.product_id
      ${whereClause}
      ORDER BY l.created_at DESC, l.id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit: pageSize, offset });

    const entries = rows.map(r => ({
      id: r.id,
      productId: r.product_id,
      productName: r.product_name || r.product_id,
      action: r.action,
      changedFields: r.changed_fields_json ? JSON.parse(r.changed_fields_json) : [],
      before: r.before_json ? JSON.parse(r.before_json) : null,
      after: r.after_json ? JSON.parse(r.after_json) : null,
      actor: r.actor,
      createdAt: r.created_at
    }));

    res.json({ success: true, entries, total, page, pageSize });
  });

  // ══════════════ 庫存管理 ══════════════
  router.get('/inventory', requirePermission('inventory', 'view'), csrfProtection, (req, res) => {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name, p.status,
             i.stock_qty, i.low_stock_threshold, i.unit, i.updated_at
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      ORDER BY p.sort_order ASC
    `).all();
    res.json({
      success: true,
      inventory: rows.map(r => ({
        productId: r.product_id,
        name: r.name,
        status: r.status,
        stockQty: r.stock_qty ?? 0,
        lowStockThreshold: r.low_stock_threshold ?? 0,
        unit: r.unit || '個',
        low: (r.stock_qty ?? 0) <= (r.low_stock_threshold ?? 0),
        updatedAt: r.updated_at
      }))
    });
  });

  // ─── CSV(逗號分隔值) 匯出：目前全部正式商品的庫存資料 ───────────────
  // 掛在 router 底下已經套用 checkAdminAuth（見檔案最上面 router.use(checkAdminAuth)），前端
  // 必須用既有 adminFetch()（帶 x-admin-token header）呼叫，不接受把密碼放進網址查詢字串。
  // 純粹只讀（SELECT），不修改任何商品／庫存／異動紀錄／訂單資料。
  const PRODUCT_STATUS_LABELS = { active: '上架中', inactive: '已下架', coming_soon: '即將推出' };
  const CSV_NOT_ESTABLISHED = '未建立'; // 商品沒有庫存資料列時，庫存相關欄位一律顯示這個字，不留空、不預設成0

  // 把單一欄位安全轉成 CSV 儲存格文字：
  // 1. 防止 CSV 公式注入——文字若以 =、+、-、@ 開頭，Excel／試算表軟體開啟時可能被當成公式執行，
  //    在前面加一個半形單引號強制當成純文字（業界慣用的 OWASP 建議寫法），單引號本身在 Excel
  //    儲存格內不會顯示出來，只是強制型別。
  // 2. 標準 CSV 逗號／雙引號／換行處理：內容含任一種就整格用雙引號包起來，雙引號本身用兩個
  //    雙引號跳脫（RFC 4180 標準寫法）。
  function csvCell(raw) {
    let s = raw === null || raw === undefined ? '' : String(raw);
    if (/^[=+\-@]/.test(s)) {
      s = `'${s}`;
    }
    if (/[",\r\n]/.test(s)) {
      s = `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  }

  router.get('/inventory/export', requirePermission('inventory', 'view'), csrfProtection, (req, res) => {
    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name, p.status,
             i.stock_qty, i.low_stock_threshold, i.unit, i.updated_at
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      ORDER BY p.sort_order ASC
    `).all();

    const header = ['商品代碼', '商品名稱', '商品狀態', '目前庫存', '安全庫存警戒值', '單位', '是否低庫存', '最後更新時間'];
    const lines = [header.map(csvCell).join(',')];

    rows.forEach(r => {
      // LEFT JOIN 沒有對應 inventory 資料列時，stock_qty 會是 SQL NULL；用這個判斷「這個商品
      // 到底有沒有庫存資料列」，不可以直接漏掉這個商品、也不可以把「沒有資料」偷偷當成 0。
      const hasInventory = r.stock_qty !== null && r.stock_qty !== undefined;
      const statusLabel = PRODUCT_STATUS_LABELS[r.status] || r.status;
      const stockQty   = hasInventory ? r.stock_qty : CSV_NOT_ESTABLISHED;
      const threshold  = hasInventory ? (r.low_stock_threshold ?? 0) : CSV_NOT_ESTABLISHED;
      const unit       = hasInventory ? (r.unit || '個') : CSV_NOT_ESTABLISHED;
      const low        = hasInventory ? ((r.stock_qty ?? 0) <= (r.low_stock_threshold ?? 0) ? '是' : '否') : CSV_NOT_ESTABLISHED;
      const updatedAt  = hasInventory ? (r.updated_at || CSV_NOT_ESTABLISHED) : CSV_NOT_ESTABLISHED;
      const cells = [r.product_id, r.name, statusLabel, stockQty, threshold, unit, low, updatedAt];
      lines.push(cells.map(csvCell).join(','));
    });

    // UTF-8 BOM：Windows Excel 用「雙擊開啟」CSV 時，沒有 BOM 會被誤判成系統預設編碼（通常是
    // Big5），繁體中文顯示成亂碼；加上 BOM 讓 Excel 正確辨識這是 UTF-8 內容。CSV 標準換行是
    // \r\n（RFC 4180），不是單純 \n。
    const UTF8_BOM = '﻿';
    const csvContent = UTF8_BOM + lines.join('\r\n');
    const filename = `庫存匯出_${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    // 同時提供 ASCII 安全的 filename 當退回值，以及 RFC 5987 格式的 filename*（可以正確帶中文檔名）
    res.setHeader('Content-Disposition', `attachment; filename="inventory-export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(csvContent);
  });

  router.post('/inventory/:productId/movement', requirePermission('inventory', 'write'), csrfProtection, (req, res) => {
    const { productId } = req.params;
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(productId);
    if (!product) return res.status(404).json({ error: '找不到此產品' });

    const changeQty = Number(req.body?.changeQty);
    if (!Number.isFinite(changeQty) || changeQty === 0) {
      return res.status(400).json({ error: '請輸入非 0 的異動數量（正數為進貨，負數為出貨/扣除）' });
    }
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    const note   = req.body?.note   ? String(req.body.note).trim()   : null;

    const inv = db.prepare('SELECT * FROM inventory WHERE product_id = ?').get(productId);
    const currentQty = inv ? inv.stock_qty : 0;
    const newQty = currentQty + changeQty;
    if (newQty < 0) {
      return res.status(400).json({ error: `庫存不足，目前庫存 ${currentQty}，扣除後會變成負數` });
    }

    const now = new Date().toISOString();
    const run = db.transaction(() => {
      if (inv) {
        db.prepare('UPDATE inventory SET stock_qty = ?, updated_at = ? WHERE product_id = ?')
          .run(newQty, now, productId);
      } else {
        db.prepare('INSERT INTO inventory (product_id, stock_qty, low_stock_threshold, unit, updated_at) VALUES (?, ?, 0, \'個\', ?)')
          .run(productId, newQty, now);
      }
      db.prepare('INSERT INTO inventory_log (product_id, change_qty, reason, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(productId, changeQty, reason, note, now);

      // 低庫存主動通知：跟庫存寫入放在同一個 transaction 內執行，讀到的一定是這次異動後
      // 剛寫入的最新數字；這支函式內部自行吞掉例外，通知失敗不會影響這筆進出貨登記本身。
      checkLowStockTransition(productId, newQty, inv ? inv.low_stock_threshold : 0);
    });
    run();

    res.json({ success: true, stockQty: newQty });
  });

  router.put('/inventory/:productId/threshold', requirePermission('inventory', 'write'), csrfProtection, (req, res) => {
    const { productId } = req.params;
    const threshold = Number(req.body?.lowStockThreshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return res.status(400).json({ error: '低庫存警戒值需為 0 以上的數字' });
    }
    const now = new Date().toISOString();
    const run = db.transaction(() => {
      const inv = db.prepare('SELECT * FROM inventory WHERE product_id = ?').get(productId);
      if (inv) {
        db.prepare('UPDATE inventory SET low_stock_threshold = ?, updated_at = ? WHERE product_id = ?')
          .run(threshold, now, productId);
      } else {
        db.prepare('INSERT INTO inventory (product_id, stock_qty, low_stock_threshold, unit, updated_at) VALUES (?, 0, ?, \'個\', ?)')
          .run(productId, threshold, now);
      }

      // 低庫存主動通知：「是否低庫存」由庫存數量與警戒值兩者共同決定，警戒值本身改變
      // 也可能讓商品跨入或脫離低庫存狀態（庫存沒變、只有警戒值變），所以這裡也要跟手動
      // 進出貨、訂單扣庫存／回補、盤點確認一樣呼叫同一支判斷函式；用寫入完成後重新查詢
      // 到的 stock_qty（不論是既有資料列還是剛新建的 0）跟這次寫入的 threshold 比對。
      const freshInv = db.prepare('SELECT stock_qty FROM inventory WHERE product_id = ?').get(productId);
      checkLowStockTransition(productId, freshInv ? freshInv.stock_qty : 0, threshold);
    });
    run();

    res.json({ success: true });
  });

  router.get('/inventory/:productId/log', requirePermission('inventory', 'view'), csrfProtection, (req, res) => {
    const { productId } = req.params;
    const rows = db.prepare(`
      SELECT * FROM inventory_log WHERE product_id = ? ORDER BY id DESC LIMIT 100
    `).all(productId);
    res.json({
      success: true,
      log: rows.map(r => ({
        id: r.id, changeQty: r.change_qty, reason: r.reason, note: r.note, createdAt: r.created_at
      }))
    });
  });

  // ══════════════ 庫存盤點 ══════════════
  // 核心原則：盤點期間系統庫存可能因為訂單扣庫存、取消回補或人工調整而改變，草稿階段
  // 完全不動 inventory 資料表（只讀不寫），確認盤點前一定要重新比對每個商品「現在」的
  // 系統庫存是否還跟建立盤點單當下拍下的快照一致，只要有任何一個商品不一致就整張拒絕
  // （409），不寫入任何正式庫存，避免蓋掉盤點期間發生的正常異動。不提供刪除已確認盤點單
  // 或修改歷史紀錄的 API（沒有 DELETE 路由；PUT 明確拒絕 status !== 'draft' 的盤點單）。
  const STOCKTAKE_ACTOR = 'admin'; // 沿用商品操作歷程同一套慣例，全程不接觸 ADMIN_TOKEN
  const STOCKTAKE_NOTE_MAX = 500;
  const STOCKTAKE_REASON = '盤點調整';
  const STOCKTAKE_SOURCE_TYPE = 'stocktake_confirm';

  function generateStocktakeId() {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    let id;
    do {
      id = `ST${datePart}${crypto.randomBytes(3).toString('hex')}`;
    } while (db.prepare('SELECT 1 FROM stocktakes WHERE id = ?').get(id));
    return id;
  }

  // 實際盤點數量必須是 0 以上的整數；明確拒絕字串／小數／NaN／Infinity／其他型別（例如陣列、
  // 物件、布林值）——刻意用 typeof 嚴格檢查型別，不用 Number() 寬鬆轉型，避免 Number('12')、
  // Number(true) 等值意外通過驗證。
  function checkCountedQty(value) {
    if (typeof value !== 'number') return '實際盤點數量必須是數字，不接受字串或其他型別';
    if (!Number.isFinite(value)) return '實際盤點數量必須是有限的數字，不可為 NaN 或 Infinity';
    if (!Number.isInteger(value)) return '實際盤點數量必須是整數，不可為小數';
    if (value < 0) return '實際盤點數量不可為負數';
    return null;
  }

  function getStocktakeDetail(id) {
    const st = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
    if (!st) return null;
    const items = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ? ORDER BY id ASC').all(id);
    return {
      id: st.id,
      status: st.status,
      actor: st.actor,
      note: st.note,
      createdAt: st.created_at,
      confirmedAt: st.confirmed_at,
      items: items.map(it => ({
        productId: it.product_id,
        productCode: it.product_code,
        productName: it.product_name,
        systemQty: it.system_qty,
        countedQty: it.counted_qty,
        diffQty: it.diff_qty
      }))
    };
  }

  // 建立盤點單：把「目前全部商品」（跟既有 /inventory、/inventory/export 同一段查詢，
  // 不限狀態、不排除已封存）當下的系統庫存拍成快照存進 stocktake_items，counted_qty／
  // diff_qty 一律先存 NULL（尚未輸入），不會動到 inventory 資料表本身。
  router.post('/stocktakes', requirePermission('inventory', 'write'), csrfProtection, (req, res) => {
    const b = req.body || {};
    const noteErr = checkOptionalText(b.note, '備註', STOCKTAKE_NOTE_MAX);
    if (noteErr) return res.status(400).json({ error: noteErr });
    const note = (b.note === undefined || b.note === null || b.note === '') ? null : String(b.note).trim();

    const rows = db.prepare(`
      SELECT p.id AS product_id, p.name, i.stock_qty
      FROM products p
      LEFT JOIN inventory i ON i.product_id = p.id
      ORDER BY p.sort_order ASC
    `).all();
    if (rows.length === 0) {
      return res.status(400).json({ error: '目前沒有任何商品，無法建立盤點單' });
    }

    const id = generateStocktakeId();
    const now = new Date().toISOString();

    const createTx = db.transaction(() => {
      db.prepare(`
        INSERT INTO stocktakes (id, status, actor, note, created_at, confirmed_at)
        VALUES (?, 'draft', ?, ?, ?, NULL)
      `).run(id, STOCKTAKE_ACTOR, note, now);

      const insertItem = db.prepare(`
        INSERT INTO stocktake_items (stocktake_id, product_id, product_code, product_name, system_qty, counted_qty, diff_qty)
        VALUES (?, ?, ?, ?, ?, NULL, NULL)
      `);
      rows.forEach(r => insertItem.run(id, r.product_id, r.product_id, r.name, r.stock_qty ?? 0));
    });
    createTx();

    res.json({ success: true, stocktake: getStocktakeDetail(id) });
  });

  // 歷史盤點清單（唯讀，分頁），依建立時間新到舊排序
  router.get('/stocktakes', requirePermission('inventory', 'view'), csrfProtection, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    const total = db.prepare('SELECT COUNT(*) AS c FROM stocktakes').get().c;
    const rows = db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM stocktake_items si WHERE si.stocktake_id = s.id) AS item_count
      FROM stocktakes s
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);

    res.json({
      success: true,
      total, page, pageSize,
      stocktakes: rows.map(r => ({
        id: r.id, status: r.status, actor: r.actor, note: r.note,
        createdAt: r.created_at, confirmedAt: r.confirmed_at, itemCount: r.item_count
      }))
    });
  });

  // 單張盤點單詳情（唯讀），草稿與已確認皆可查詢
  router.get('/stocktakes/:id', requirePermission('inventory', 'view'), csrfProtection, (req, res) => {
    const detail = getStocktakeDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: '找不到此盤點單' });
    res.json({ success: true, stocktake: detail });
  });

  // 儲存草稿：只更新 stocktake_items 的 counted_qty／diff_qty（與選填的 note），完全不碰
  // inventory 資料表，草稿期間系統庫存不會被改變。允許只傳部分商品（分批輸入、分批儲存），
  // 沒有傳入的商品維持原本已儲存的值。任一筆驗證失敗就整批拒絕，不寫入部分資料。
  router.put('/stocktakes/:id', requirePermission('inventory', 'write'), csrfProtection, (req, res) => {
    const { id } = req.params;
    const st = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
    if (!st) return res.status(404).json({ error: '找不到此盤點單' });
    if (st.status !== 'draft') {
      return res.status(409).json({ error: '此盤點單已確認，不可再修改' });
    }

    const b = req.body || {};
    const itemsInput = Array.isArray(b.items) ? b.items : null;
    if (!itemsInput || itemsInput.length === 0) {
      return res.status(400).json({ error: '請提供要更新的商品盤點數量（items）' });
    }
    const noteErr = checkOptionalText(b.note, '備註', STOCKTAKE_NOTE_MAX);
    if (noteErr) return res.status(400).json({ error: noteErr });

    const existingItems = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ?').all(id);
    const existingByProduct = new Map(existingItems.map(it => [it.product_id, it]));

    for (const entry of itemsInput) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return res.status(400).json({ error: '盤點項目格式不正確' });
      }
      if (typeof entry.productId !== 'string' || !entry.productId.trim()) {
        return res.status(400).json({ error: '缺少商品代碼（productId）' });
      }
      const existing = existingByProduct.get(entry.productId);
      if (!existing) {
        return res.status(400).json({ error: `商品「${entry.productId}」不屬於此盤點單` });
      }
      const qtyErr = checkCountedQty(entry.countedQty);
      if (qtyErr) {
        return res.status(400).json({ error: `商品「${existing.product_name}」：${qtyErr}` });
      }
    }

    const updateTx = db.transaction(() => {
      const updateItem = db.prepare(`
        UPDATE stocktake_items SET counted_qty = ?, diff_qty = ?
        WHERE stocktake_id = ? AND product_id = ?
      `);
      itemsInput.forEach(entry => {
        const existing = existingByProduct.get(entry.productId);
        const countedQty = Number(entry.countedQty);
        updateItem.run(countedQty, countedQty - existing.system_qty, id, entry.productId);
      });
      if (b.note !== undefined) {
        const note = (b.note === null || b.note === '') ? null : String(b.note).trim();
        db.prepare('UPDATE stocktakes SET note = ? WHERE id = ?').run(note, id);
      }
    });
    updateTx();

    res.json({ success: true, stocktake: getStocktakeDetail(id) });
  });

  // 用來把「transaction 內判斷出的各種提前中止情況」（找不到盤點單／已確認過／尚未輸入
  // 全部數量／系統庫存已被改變）安全地帶出 db.transaction() 之外，並讓 better-sqlite3 對
  // 這個 transaction 做完整回滾——任何一種中止都必須是 throw，不能只是 return，否則萬一
  // 之後在同一個 transaction 裡已經執行過的 UPDATE／INSERT 不會被撤銷。
  class StocktakeConfirmAbort extends Error {
    constructor(info) { super('STOCKTAKE_CONFIRM_ABORT'); this.info = info; }
  }

  // 確認盤點：在同一個 transaction 內完成「重新比對系統庫存是否仍與快照一致 → 逐項更新正式
  // 庫存 → 逐項寫入 inventory_log → 把盤點單狀態改成 confirmed」，任一步驟失敗（含比對不一致、
  // 資料庫寫入錯誤）整個 transaction 自動回滾，不會出現只調整部分商品的情況。
  //
  // 冪等：status 檢查放在 transaction 最前面，且因為 better-sqlite3 的 transaction 是同步執行、
  // 會整段阻塞 Node.js 的事件迴圈，同一個行程內不可能有第二個請求在這段 transaction 執行到一半
  // 時插進來——重複呼叫時，第二次進到 transaction 一定會讀到第一次已經寫入的 status='confirmed'，
  // 安全地回傳「已確認」而不會重複調整庫存。另外用 inventory_log 既有的
  // UNIQUE INDEX(source_type, source_id)（source_id 用 `${盤點編號}#${商品代碼}` 組成，每個
  // 商品在同一張盤點單只會出現一次）當作資料庫層的第二層防線。
  router.post('/stocktakes/:id/confirm', requirePermission('inventory', 'write'), csrfProtection, (req, res) => {
    const { id } = req.params;

    let result;
    try {
      const confirmTx = db.transaction(() => {
        const st = db.prepare('SELECT * FROM stocktakes WHERE id = ?').get(id);
        if (!st) throw new StocktakeConfirmAbort({ notFound: true });
        if (st.status === 'confirmed') {
          throw new StocktakeConfirmAbort({ alreadyConfirmed: true, confirmedAt: st.confirmed_at });
        }

        const items = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id = ? ORDER BY id ASC').all(id);
        if (items.length === 0) throw new StocktakeConfirmAbort({ empty: true });

        const uncounted = items.filter(it => it.counted_qty === null);
        if (uncounted.length > 0) {
          throw new StocktakeConfirmAbort({
            uncounted: uncounted.map(it => ({ productId: it.product_id, productName: it.product_name }))
          });
        }

        // 重新比對「現在」的系統庫存是否仍與建立盤點單當下拍下的快照一致；任一商品不一致
        // 就整批拒絕，這裡還沒有任何寫入動作，直接 throw 不需要額外回滾任何東西。
        const mismatches = [];
        items.forEach(it => {
          const inv = db.prepare('SELECT stock_qty FROM inventory WHERE product_id = ?').get(it.product_id);
          const currentQty = inv ? inv.stock_qty : 0;
          if (currentQty !== it.system_qty) {
            mismatches.push({
              productId: it.product_id, productName: it.product_name,
              snapshotQty: it.system_qty, currentQty
            });
          }
        });
        if (mismatches.length > 0) throw new StocktakeConfirmAbort({ mismatches });

        const now = new Date().toISOString();
        const noteText = `盤點單 ${id}`;
        const adjusted = [];
        // 商品可能還沒有 inventory 資料列（例如新增商品後從未登記過任何進出貨），這種情況下
        // 單純 UPDATE 會靜靜地影響 0 筆、庫存資料列永遠不會被建立，盤點數字就這樣憑空消失。
        // 改用 INSERT ... ON CONFLICT(product_id) DO UPDATE：沒有資料列時依 counted_qty 建立一筆
        // （低庫存警戒值預設 0、單位預設「個」）；已有資料列時只更新 stock_qty／updated_at，
        // DO UPDATE SET 沒有列出的 low_stock_threshold／unit 完全不受影響，保留原本設定的值。
        const upsertInventory = db.prepare(`
          INSERT INTO inventory (product_id, stock_qty, low_stock_threshold, unit, updated_at)
          VALUES (?, ?, 0, '個', ?)
          ON CONFLICT(product_id) DO UPDATE SET stock_qty = excluded.stock_qty, updated_at = excluded.updated_at
        `);
        items.forEach(it => {
          if (it.diff_qty !== 0) {
            const upsertInfo = upsertInventory.run(it.product_id, it.counted_qty, now);
            // 防呆：這個語句理論上一定會影響剛好 1 筆（沒有資料列就新建，有就更新），如果
            // 沒有——代表庫存寫入失敗，整張盤點必須回滾，不能只調整部分商品、也不能繼續往下
            // 寫入 inventory_log 或把盤點單標記為 confirmed。
            if (upsertInfo.changes !== 1) {
              throw new StocktakeConfirmAbort({ writeFailed: true, productId: it.product_id, productName: it.product_name });
            }
            const sourceId = `${id}#${it.product_id}`;
            db.prepare(`
              INSERT INTO inventory_log (product_id, change_qty, reason, note, source_type, source_id, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(it.product_id, it.diff_qty, STOCKTAKE_REASON, noteText, STOCKTAKE_SOURCE_TYPE, sourceId, now);
            adjusted.push({ productId: it.product_id, productName: it.product_name, diffQty: it.diff_qty });

            // 低庫存主動通知：用剛寫入完成後的 low_stock_threshold（不論是 UPSERT 新建的預設值 0，
            // 還是既有資料列被保留下來的原值）跟盤點數量比對，一樣放在同一個 transaction 內執行。
            const freshInv = db.prepare('SELECT low_stock_threshold FROM inventory WHERE product_id = ?').get(it.product_id);
            checkLowStockTransition(it.product_id, it.counted_qty, freshInv ? freshInv.low_stock_threshold : 0);
          }
        });

        db.prepare("UPDATE stocktakes SET status = 'confirmed', confirmed_at = ? WHERE id = ?").run(now, id);
        return { confirmedAt: now, adjusted };
      });
      result = confirmTx();
    } catch (err) {
      if (err instanceof StocktakeConfirmAbort) {
        const info = err.info;
        if (info.notFound) return res.status(404).json({ error: '找不到此盤點單' });
        if (info.alreadyConfirmed) {
          return res.json({ success: true, alreadyConfirmed: true, confirmedAt: info.confirmedAt, stocktake: getStocktakeDetail(id) });
        }
        if (info.empty) return res.status(400).json({ error: '此盤點單沒有任何商品項目' });
        if (info.uncounted) {
          return res.status(400).json({ error: '尚有商品未輸入實際盤點數量，請先完成所有商品的盤點數量再確認', uncounted: info.uncounted });
        }
        if (info.mismatches) {
          return res.status(409).json({
            error: '部分商品的系統庫存在盤點期間已被其他異動改變，請重新建立盤點單',
            mismatches: info.mismatches
          });
        }
        if (info.writeFailed) {
          console.error(`[stocktake confirm] 商品 ${info.productId} 庫存寫入失敗，已整張回滾`);
          return res.status(500).json({ error: `商品「${info.productName}」的庫存寫入失敗，請稍後再試` });
        }
      }
      console.error('[stocktake confirm]', err.message);
      return res.status(500).json({ error: '確認盤點失敗，請稍後再試' });
    }

    res.json({ success: true, alreadyConfirmed: false, confirmedAt: result.confirmedAt, adjusted: result.adjusted, stocktake: getStocktakeDetail(id) });
  });

  // ══════════════ 低庫存主動通知 ══════════════
  // 通知本身由 low-stock-notify.js 的 checkLowStockTransition() 在既有庫存交易內建立／解除，
  // 這裡只提供唯讀查詢與「標記已讀」，不提供新增、刪除或修改通知內容本身的 API。
  router.get('/low-stock-notifications', requirePermission('notifications', 'view'), csrfProtection, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const offset = (page - 1) * pageSize;

    const total = db.prepare('SELECT COUNT(*) AS c FROM low_stock_notifications').get().c;
    const rows = db.prepare(`
      SELECT n.*, p.name AS product_name
      FROM low_stock_notifications n
      LEFT JOIN products p ON p.id = n.product_id
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ? OFFSET ?
    `).all(pageSize, offset);

    res.json({
      success: true,
      total, page, pageSize,
      notifications: rows.map(r => ({
        id: r.id,
        productId: r.product_id,
        productName: r.product_name || r.product_id,
        stockQty: r.stock_qty,
        lowStockThreshold: r.low_stock_threshold,
        status: r.status,
        createdAt: r.created_at,
        readAt: r.read_at
      }))
    });
  });

  router.get('/low-stock-notifications/unread-count', requirePermission('notifications', 'view'), csrfProtection, (req, res) => {
    const unreadCount = db.prepare('SELECT COUNT(*) AS c FROM low_stock_notifications WHERE read_at IS NULL').get().c;
    res.json({ success: true, unreadCount });
  });

  router.post('/low-stock-notifications/:id/read', requirePermission('notifications', 'write'), csrfProtection, (req, res) => {
    const notifId = parseInt(req.params.id, 10);
    if (!Number.isInteger(notifId)) return res.status(400).json({ error: '通知編號格式不正確' });
    const existing = db.prepare('SELECT * FROM low_stock_notifications WHERE id = ?').get(notifId);
    if (!existing) return res.status(404).json({ error: '找不到此通知' });

    // 只在目前還沒讀過時才寫入已讀時間，保留第一次真正被讀取的時間點；重複呼叫是安全的，
    // 不會覆蓋掉原本的已讀時間，也不會被視為錯誤。
    if (!existing.read_at) {
      db.prepare('UPDATE low_stock_notifications SET read_at = ? WHERE id = ?').run(new Date().toISOString(), notifId);
    }
    const updated = db.prepare('SELECT read_at FROM low_stock_notifications WHERE id = ?').get(notifId);
    res.json({ success: true, readAt: updated.read_at });
  });

  router.post('/low-stock-notifications/read-all', requirePermission('notifications', 'write'), csrfProtection, (req, res) => {
    const now = new Date().toISOString();
    const info = db.prepare('UPDATE low_stock_notifications SET read_at = ? WHERE read_at IS NULL').run(now);
    res.json({ success: true, markedCount: info.changes });
  });

  // ══════════════ 統一通知中心（Email／LINE／後台通知中心批次）══════════════
  // 新詢價、低庫存跨入、客戶接受／拒絕報價、資料庫備份或還原失敗、其他重要系統錯誤等事件
  // 統一寫入 notification_events／admin_notifications／notification_delivery_jobs（見
  // notification-service.js），這裡只提供查詢、標記已讀、管道設定與測試通知——事件本身的
  // 建立都發生在各自的業務流程裡（server.js的save-order／low-stock-notify.js／公開報價
  // 回覆路由／本檔案下方的正式還原路由），這支路由檔案不負責「產生」事件。
  router.get('/notifications', requirePermission('notification_center', 'view'), csrfProtection, (req, res) => {
    try {
      const status = ['unread', 'read'].includes(req.query.status) ? req.query.status : undefined;
      const result = listAdminNotifications({ page: req.query.page, pageSize: req.query.pageSize, status });
      res.json({
        success: true,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        notifications: result.rows.map(r => ({
          id: r.id,
          eventType: r.event_type,
          eventTypeLabel: NOTIFICATION_EVENT_LABELS[r.event_type] || r.event_type,
          title: r.title,
          summary: r.summary,
          severity: r.severity,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          eventCreatedAt: r.event_created_at,
          readAt: r.read_at
        }))
      });
    } catch (err) {
      console.error('[api/admin/notifications list]', err.message);
      res.status(500).json({ error: '通知清單讀取失敗' });
    }
  });

  router.get('/notifications/unread-count', requirePermission('notification_center', 'view'), csrfProtection, (req, res) => {
    try {
      res.json({ success: true, unreadCount: countUnreadAdminNotifications() });
    } catch (err) {
      console.error('[api/admin/notifications unread-count]', err.message);
      res.status(500).json({ error: '未讀數量讀取失敗' });
    }
  });

  router.post('/notifications/:id/read', requirePermission('notification_center', 'write'), csrfProtection, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: '通知編號格式不正確' });
    try {
      markAdminNotificationRead(id); // 找不到或已經是已讀都安全地回傳success，冪等操作不需要另外報錯
      res.json({ success: true });
    } catch (err) {
      console.error('[api/admin/notifications read]', err.message);
      res.status(500).json({ error: '標記已讀失敗' });
    }
  });

  router.post('/notifications/read-all', requirePermission('notification_center', 'write'), csrfProtection, (req, res) => {
    try {
      const markedCount = markAllAdminNotificationsRead();
      res.json({ success: true, markedCount });
    } catch (err) {
      console.error('[api/admin/notifications read-all]', err.message);
      res.status(500).json({ error: '全部標記已讀失敗' });
    }
  });

  // 通知設定：三個管道目前是否已設定、依事件類型的Email／LINE開關。channelStatus只回報
  // 布林值（見notification-channels.js的getChannelStatus()），絕不回傳SMTP密碼、LINE Token
  // 或目標ID本身——這是這支API唯一允許回傳的通知管道資訊。
  router.get('/notification-settings', requirePermission('notification_settings', 'view'), csrfProtection, (req, res) => {
    try {
      res.json({
        success: true,
        channelStatus: getChannelStatus(),
        eventTypes: NOTIFICATION_EVENT_TYPES,
        eventLabels: NOTIFICATION_EVENT_LABELS,
        channelSettings: getAllNotificationChannelSettings()
      });
    } catch (err) {
      console.error('[api/admin/notification-settings]', err.message);
      res.status(500).json({ error: '通知設定讀取失敗' });
    }
  });

  router.put('/notification-settings/:eventType', requirePermission('notification_settings', 'write'), csrfProtection, (req, res) => {
    const eventType = req.params.eventType;
    if (!NOTIFICATION_EVENT_TYPES.includes(eventType)) return res.status(400).json({ error: '不支援的事件類型' });
    const emailEnabled = req.body.emailEnabled === true;
    const lineEnabled = req.body.lineEnabled === true;
    try {
      setNotificationChannelSetting(eventType, { emailEnabled, lineEnabled });
      res.json({ success: true, eventType, emailEnabled, lineEnabled });
    } catch (err) {
      console.error('[api/admin/notification-settings update]', err.message);
      res.status(500).json({ error: '通知設定更新失敗' });
    }
  });

  // 測試通知：建立一筆測試事件，依這次勾選的channels參數直接排入外部傳送工作（不受一般
  // notification_channel_settings開關影響），再立刻呼叫processNotificationJobsOnce()送出，
  // 不用等worker下一輪輪詢，方便管理員馬上看到結果。隔離測試時只要把SMTP_HOST／
  // LINE_API_BASE_URL指向本機mock服務，就完全不會對外真正寄信或推播LINE；正式環境會真的
  // 寄出，請管理員謹慎使用。這支路由本身走共用csrfProtection＋auditLogMiddleware，全程留下
  // 操作稽核，不需要額外處理。
  router.post('/notification-settings/test', requirePermission('notification_settings', 'write'), csrfProtection, async (req, res) => {
    const channels = Array.isArray(req.body.channels) ? req.body.channels.filter(c => c === 'email' || c === 'line') : ['email', 'line'];
    if (!channels.length) return res.status(400).json({ error: '請至少選擇一個管道' });
    try {
      const idempotencyKey = `${Date.now()}_${crypto.randomUUID()}`;
      const created = emitTestNotificationEvent({ idempotencyKey, actorDisplayName: req.adminUser.username, channels });
      if (!created || !created.eventId) return res.status(500).json({ error: '測試通知事件建立失敗' });
      await processNotificationJobsOnce(10);
      const jobs = queryNotificationDeliveryJobs({ eventId: created.eventId });
      res.json({
        success: true,
        eventId: created.eventId,
        jobs: jobs.map(j => ({ channel: j.channel, status: j.status, errorCategory: j.error_category, lastError: j.last_error }))
      });
    } catch (err) {
      console.error('[api/admin/notification-settings test]', err.message);
      res.status(500).json({ error: '測試通知發送失敗' });
    }
  });

  // ══════════════ 儀表板 ══════════════
  // 2026-08-19 新增「粒度切換」批次：使用者要求儀表板可以在「每天／每月／每季／每年」之間
  // 切換，且要套用到「幾乎全部區塊」——今日／本月概況卡片改成「本期間」卡片、營收趨勢圖改成
  // 依粒度分組、訂單狀態分布／熱門商品排行／依商品訂單分布／客戶訂單彙總都改成只統計「本期間」
  // 內建立的訂單，不再是固定「今日＋本月」＋「全部歷史訂單」的寫死版本。
  //
  // 刻意「不」套用粒度篩選、維持全量／目前狀態的3類例外（已跟使用者說明過原因，不是漏改）：
  // 1. 最上方「訂單總數／估價總營收／上架商品數／低庫存項目」4張總覽卡片——作為固定基準參考，
  //    不隨切換而變動意義。
  // 2. 「待處理訂單／製作中訂單／預估逾期訂單」——這3個代表「目前實際卡在這個狀態的工作量」，
  //    跟訂單什麼時候建立無關；如果被粒度篩選掉，切到「本日」會讓使用者誤以為工作量突然變少，
  //    反而失真。
  // 3. 庫存概況（目前庫存量／低庫存警戒）——這是「當下庫存狀態」的快照，沒有歷史紀錄可以回推
  //    「本季的庫存」是多少，所以維持顯示目前狀態。
  const GRANULARITY_VALUES = ['day', 'month', 'quarter', 'year'];
  const GRANULARITY_TREND_COUNT = { day: 30, month: 12, quarter: 8, year: 5 };

  router.get('/dashboard', requirePermission('dashboard', 'view'), csrfProtection, (req, res) => {
    const granularity = GRANULARITY_VALUES.includes(req.query.granularity) ? req.query.granularity : 'day';
    let orders = [];
    try {
      const files = fs.readdirSync(ORDER_DIR).filter(f => f.endsWith('.json'));
      orders = files.map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(ORDER_DIR, f), 'utf8')); }
        catch { return null; }
      }).filter(Boolean);
    } catch {
      orders = [];
    }

    const orderCount = orders.length;
    // 用同一套 normalizeCustomerAmount() 正規化：型別不是合法數字（例如惡意字串）不計入累加，
    // 避免 `sum + 字串` 被 JS 轉型成字串串接，讓非數字內容混進本來應該是純數字的統計欄位。
    // revenueTotal 是最上方總覽卡片用的全站累計金額，維持全量、不受粒度篩選。
    const revenueTotal = orders.reduce((sum, o) => {
      const amt = normalizeCustomerAmount(o.quote?.total);
      return amt !== null ? sum + amt : sum;
    }, 0);

    const inventoryRows = db.prepare(`
      SELECT p.id AS product_id, p.name, p.status, i.stock_qty, i.low_stock_threshold, i.unit
      FROM products p LEFT JOIN inventory i ON i.product_id = p.id
      WHERE p.status = 'active'
    `).all();
    const lowStock = inventoryRows
      .filter(r => (r.stock_qty ?? 0) <= (r.low_stock_threshold ?? 0))
      .map(r => ({ productId: r.product_id, name: r.name, stockQty: r.stock_qty ?? 0, lowStockThreshold: r.low_stock_threshold ?? 0, unit: r.unit || '個' }));

    const productCount = db.prepare("SELECT COUNT(*) AS c FROM products WHERE status = 'active'").get().c;

    // ── 本期間訂單與營業額、待處理／製作中訂單數 ───────────────────────
    // 時區固定使用 Asia/Taipei（UTC+8，台灣不使用夏令時間，用固定位移換算即可，不需要額外
    // 安裝時區套件）；savedAt 是 ISO 8601 UTC 字串，換算成台北時間後只比較年／月／日。
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const toTaipeiDateParts = isoString => {
      if (typeof isoString !== 'string' || !isoString) return null;
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return null;
      const taipei = new Date(d.getTime() + TAIPEI_OFFSET_MS);
      return { y: taipei.getUTCFullYear(), m: taipei.getUTCMonth(), d: taipei.getUTCDate() };
    };
    const nowTaipei = toTaipeiDateParts(new Date().toISOString());
    // 把「台北時間某年/月/日 00:00:00.000」換算成對應的 UTC 毫秒時間戳：台北是 UTC+8 固定
    // 位移，Date.UTC(y,m,d,0,0,0,0) 算出來的是「UTC 那個年/月/日的 00:00」，再減掉 8 小時
    // 才是台北那個年/月/日 00:00 實際對應的 UTC 瞬間。
    const taipeiMidnightUtcMs = parts => Date.UTC(parts.y, parts.m, parts.d, 0, 0, 0, 0) - TAIPEI_OFFSET_MS;

    // 待處理：還沒成交、需要業務跟進報價的訂單；製作中：已成交、正在生產流程但尚未出貨。
    // 沿用既有 server.js 的 ORDER_STATUS_FLOW 狀態代碼（new_inquiry/quoted/closed_won/
    // in_production/qc/ready_to_ship/shipped/completed，加上終止狀態 cancelled），不新增任何
    // 新的訂單狀態。這3個維持全量計算，不受粒度篩選（見上方大段說明）。
    const PENDING_STATUSES = ['new_inquiry', 'quoted'];
    const PRODUCTION_STATUSES = ['closed_won', 'in_production', 'qc', 'ready_to_ship'];
    // 預估逾期訂單：只有「已成交、還在履約流程中、尚未出貨」的訂單才有可能逾期（跟
    // PRODUCTION_STATUSES 是同一組狀態，共用同一個陣列——語意上剛好一致：還在製作中，
    // 才談得上有沒有超過預估交期）；new_inquiry／quoted（還沒成交）、shipped／completed
    // （已經出貨或完成）、cancelled／closed_lost（已終止）一律不可能逾期。
    const OVERDUE_ELIGIBLE_STATUSES = PRODUCTION_STATUSES;
    const nowMs = Date.now();

    // ── 粒度換算共用函式：day／month／quarter／year 四種粒度共用同一套「以月為底層單位
    // 位移」邏輯（day 例外，直接用天數位移），避免每種粒度各寫一份重複、容易分岔的日期運算。
    const addDaysToDateParts = (parts, deltaDays) => {
      const d = new Date(Date.UTC(parts.y, parts.m, parts.d, 0, 0, 0, 0) + deltaDays * 86400000);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
    };
    const addMonthsToDateParts = (parts, deltaMonths) => {
      const totalMonths = parts.y * 12 + parts.m + deltaMonths;
      const y = Math.floor(totalMonths / 12);
      const m = ((totalMonths % 12) + 12) % 12;
      return { y, m, d: 1 };
    };
    const formatDateParts = parts => `${parts.y}-${String(parts.m + 1).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
    const quarterOfMonth = m => Math.floor(m / 3); // 0~3

    // 某個台北年/月/日落在該粒度的哪個「桶」裡，回傳該桶的起點（day＝當天／month＝當月1號／
    // quarter＝當季第一個月1號／year＝當年1月1號），用來當作分組用的 key 依據。
    function periodStartParts(g, parts) {
      if (g === 'day') return { y: parts.y, m: parts.m, d: parts.d };
      if (g === 'month') return { y: parts.y, m: parts.m, d: 1 };
      if (g === 'quarter') return { y: parts.y, m: quarterOfMonth(parts.m) * 3, d: 1 };
      return { y: parts.y, m: 0, d: 1 }; // year
    }
    // 每個桶的機器可比對 key（用於分組／排序）與給人看的中文標籤，兩者分開，key 不受語言
    // 或格式調整影響，未來要改標籤文字不會牽動分組邏輯。
    function periodKeyAndLabel(g, startParts) {
      if (g === 'day') { const key = formatDateParts(startParts); return { key, label: `${startParts.y}年${startParts.m + 1}月${startParts.d}日` }; }
      if (g === 'month') { const key = `${startParts.y}-${String(startParts.m + 1).padStart(2, '0')}`; return { key, label: `${startParts.y}年${startParts.m + 1}月` }; }
      if (g === 'quarter') { const q = quarterOfMonth(startParts.m) + 1; const key = `${startParts.y}-Q${q}`; return { key, label: `${startParts.y}年第${q}季` }; }
      const key = String(startParts.y); return { key, label: `${startParts.y}年` }; // year
    }
    // 把某個桶起點往前／往後移動 deltaSteps 個「該粒度的單位週期」，用來遞迴算出趨勢圖需要
    // 的一整排歷史桶起點，以及「下一期」的起點（用來當作本期間篩選的結束邊界）。
    function stepPeriod(g, startParts, deltaSteps) {
      if (g === 'day') return addDaysToDateParts(startParts, deltaSteps);
      if (g === 'year') return { y: startParts.y + deltaSteps, m: 0, d: 1 };
      const stepMonths = g === 'quarter' ? deltaSteps * 3 : deltaSteps; // month／quarter都用「月」換算
      return addMonthsToDateParts(startParts, stepMonths);
    }

    // 本期間（依 granularity 決定是今天／本月／本季／本年）起訖的 UTC 瞬間：[periodStartUtcMs,
    // periodEndUtcMs) 半開區間，下一期起點就是本期間的結束邊界，不需要額外處理「月底/季底/
    // 年底最後一毫秒」這種容易算錯的邊界。
    const currentPeriodStart = nowTaipei ? periodStartParts(granularity, nowTaipei) : null;
    const periodStartUtcMs = currentPeriodStart ? taipeiMidnightUtcMs(currentPeriodStart) : null;
    const periodEndUtcMs = currentPeriodStart ? taipeiMidnightUtcMs(stepPeriod(granularity, currentPeriodStart, 1)) : null;
    const periodLabel = currentPeriodStart ? periodKeyAndLabel(granularity, currentPeriodStart).label : '本期間';

    // ── 營收趨勢：依粒度回傳固定筆數（day=30／month=12／quarter=8／year=5），含目前這一期，
    // 依時間由舊到新排列，沒有訂單的桶也要補0，不能省略。
    const TREND_COUNT = GRANULARITY_TREND_COUNT[granularity];
    const trendBuckets = [];
    const trendIndexByKey = new Map();
    for (let i = TREND_COUNT - 1; i >= 0; i--) {
      const startParts = currentPeriodStart ? stepPeriod(granularity, currentPeriodStart, -i) : null;
      const { key, label } = startParts ? periodKeyAndLabel(granularity, startParts) : { key: null, label: null };
      trendBuckets.push({ periodKey: key, periodLabel: label, orderCount: 0, revenue: 0 });
      if (key) trendIndexByKey.set(key, trendBuckets.length - 1);
    }

    // ── 訂單狀態分布：狀態中文名稱沿用 server.js 的 ORDER_STATUS_LABELS。admin-routes.js
    // 是被 server.js require 的模組（server.js 裡有 require('./admin-routes')），如果反過來
    // require server.js 會造成循環相依，所以這裡刻意複製同一份英文代碼→繁體中文對照表，
    // 兩邊改狀態名稱時要記得同步修改。未知或不在這張表裡的狀態，一律歸入固定的 other／其他，
    // 這個 key 是我們自己內部定義的字串，不會、也不可能是使用者能控制的原始文字，儀表板
    // 回應裡完全不會出現任何一筆訂單原始的、未經對照表轉換過的 status 字串本身。
    const DASHBOARD_STATUS_LABELS = {
      new_inquiry:   '新詢價',
      quoted:        '已報價',
      closed_won:    '已成交',
      in_production: '生產中',
      qc:            '品質檢查',
      ready_to_ship: '待出貨',
      shipped:       '已出貨',
      completed:     '已完成',
      cancelled:     '已取消'
    };
    const DASHBOARD_STATUS_ORDER = [...Object.keys(DASHBOARD_STATUS_LABELS), 'other'];
    const statusCounts = {};
    DASHBOARD_STATUS_ORDER.forEach(s => { statusCounts[s] = 0; });

    // ── 熱門商品排行：只依正規化過的商品名稱分組（缺少或不是字串一律歸入固定的「未知商品」
    // 桶），跟既有 byProduct（會退回 product.id）刻意不同——這裡的 productName 會直接被組進
    // 點擊排行後導向訂單頁的網址查詢字串（?product=），必須跟訂單頁篩選比對用的名稱是同一個
    // 值，不能夾雜 product.id 這種訂單頁篩選邏輯不認得的字串。
    //
    // normalizeProductName() 這條正規化規則必須跟前台 admin.html 的同名函式完全一致：
    // product.name 必須是字串、trim() 後不可為空白，合法名稱一律用 trim() 後的名稱；
    // 缺少／null／非字串／空字串／只有空白，統一轉成固定文字「未知商品」。兩邊分組／比對
    // 用的字串完全相同，才不會出現「排行顯示1筆、點擊後訂單頁篩選卻是0筆」這種不一致
    // （admin-routes.js 是被 server.js require() 的模組，admin.html 是純前端頁面，兩邊無法
    // 共用同一份程式檔案，只能各自實作、刻意保持規則同步，修改其中一邊要記得同步修改另一邊）。
    function normalizeProductName(name) {
      if (typeof name !== 'string') return '未知商品';
      const trimmed = name.trim();
      return trimmed ? trimmed : '未知商品';
    }
    const productCounts = new Map(); // 只計「本期間」內的訂單，餵給 topProducts
    const byProduct = {}; // 只計「本期間」內的訂單（沿用舊欄位保留 product.id 退回值的規則）
    const customerMap = new Map(); // 只計「本期間」內的訂單

    let periodOrderCount = 0, periodRevenue = 0;
    let pendingCount = 0, productionCount = 0, overdueCount = 0;
    orders.forEach(o => {
      const status = o.status || (o.processed ? 'closed_won' : 'new_inquiry');
      const priceOnInquiry = !!(o.product?.priceOnInquiry || o.quote?.priceOnInquiry);
      // 營業額計算跟既有 revenueTotal／aggregateCustomers 同一套規則：cancelled／closed_lost
      // 不計入，詢價商品（priceOnInquiry，還沒有正式金額）不計入，非法金額
      // （normalizeCustomerAmount 驗證不通過）也不計入；訂單數不受這些規則影響，
      // priceOnInquiry 訂單一樣要計入訂單數。
      const revenueEligible = !CUSTOMER_REVENUE_EXCLUDED_STATUSES.includes(status) && !priceOnInquiry;
      const amt = revenueEligible ? normalizeCustomerAmount(o.quote?.total) : null;

      // 待處理／製作中／預估逾期：全量計算，不受本期間篩選（見上方大段說明）。
      if (PENDING_STATUSES.includes(status)) pendingCount += 1;
      if (PRODUCTION_STATUSES.includes(status)) productionCount += 1;
      if (OVERDUE_ELIGIBLE_STATUSES.includes(status)) {
        const deadlineMs = computeEstimatedDeadlineUtcMs(o.savedAt, o.quote?.leadDays);
        if (deadlineMs !== null && nowMs > deadlineMs) overdueCount += 1;
      }

      const savedAtMs = (typeof o.savedAt === 'string') ? Date.parse(o.savedAt) : NaN;
      const inCurrentPeriod = Number.isFinite(savedAtMs) && periodStartUtcMs !== null
        && savedAtMs >= periodStartUtcMs && savedAtMs < periodEndUtcMs;

      if (inCurrentPeriod) {
        periodOrderCount += 1;
        if (amt !== null) periodRevenue += amt;

        const productName = normalizeProductName(o.product?.name);
        productCounts.set(productName, (productCounts.get(productName) || 0) + 1);
        const byProductKey = o.product?.name || o.product?.id || '未知商品';
        byProduct[byProductKey] = (byProduct[byProductKey] || 0) + 1;

        const email = o.contact?.email || '未填寫';
        if (!customerMap.has(email)) {
          customerMap.set(email, { email, name: o.contact?.name || '', orderCount: 0, totalSpent: 0, lastOrderAt: o.savedAt });
        }
        const c = customerMap.get(email);
        c.orderCount += 1;
        if (amt !== null) c.totalSpent += amt;
        if (o.savedAt > c.lastOrderAt) c.lastOrderAt = o.savedAt;

        // 訂單狀態分布：只統計本期間內建立的訂單，缺少 status 欄位的舊訂單沿用上面同一套
        // processed 判斷式；不在對照表裡的狀態一律歸入 other。
        if (Object.prototype.hasOwnProperty.call(statusCounts, status)) statusCounts[status] += 1;
        else statusCounts.other += 1;
      }

      // 營收趨勢：orderCount 計算「該桶內所有合法日期訂單」，不受狀態影響（跟既有
      // orderCount／periodOrderCount同一套慣例，只有revenue才排除特定狀態／詢價／非法金額）；
      // savedAt 換算失敗或日期落在趨勢範圍之外，兩種情況都直接跳過，不會落在任何一桶、也不會
      // 讓陣列長度變動（陣列筆數固定，取決於粒度）。
      const parts = toTaipeiDateParts(o.savedAt);
      if (parts) {
        const bucketKey = periodKeyAndLabel(granularity, periodStartParts(granularity, parts)).key;
        const trendIdx = trendIndexByKey.get(bucketKey);
        if (trendIdx !== undefined) {
          trendBuckets[trendIdx].orderCount += 1;
          if (amt !== null) trendBuckets[trendIdx].revenue += amt;
        }
      }
    });
    const customers = [...customerMap.values()].sort((a, b) => b.totalSpent - a.totalSpent);

    // 依訂單數由多至少排序，固定只回傳前5名；訂單數相同時用商品名稱做固定排序
    // （純字元碼點比較，不依賴瀏覽器／作業系統的地區排序規則），確保同一份資料
    // 不論何時、在哪裡重新整理，回傳的排序結果永遠一致。
    const topProducts = [...productCounts.entries()]
      .map(([productName, orderCount]) => ({ productName, orderCount }))
      .sort((a, b) => {
        if (b.orderCount !== a.orderCount) return b.orderCount - a.orderCount;
        if (a.productName < b.productName) return -1;
        if (a.productName > b.productName) return 1;
        return 0;
      })
      .slice(0, 5);

    // ── 詢價轉成交漏斗轉換率：只看「新詢價→已報價→已成交」三個決定顧客去留的關卡，
    // 不含生產中／品檢／待出貨等成交後的內部製作流程狀態。cancelled／closed_lost 這類終止
    // 狀態的訂單，代表這張訂單當初一定曾經處於 new_inquiry（一定送出過詢價），如果金額已經
    // 進到報價階段就一併計入 quoted，同一張訂單最終不論是否取消，都只會落在自己最後真正
    // 到達過的最深一關，不會重複計入多關。
    //
    // 用「這張訂單的 statusHistory 裡，from/to 是否出現過某個狀態」來判斷「是否曾經到達
    // 這一關」，而不是只看目前的 status——一張訂單現在是 in_production，也代表它一定曾經
    // 經過 quoted 與 closed_won，這樣算出來的三關人數才不會因為訂單目前已經往後推進到
    // 生產流程，反而漏算在漏斗最前面兩關。舊訂單如果沒有 statusHistory（欄位不存在或不是
    // 陣列），改用目前的 status 往前推算「這個狀態流程上，已經到達的最深一關」，確保新舊
    // 訂單都不會被排除在漏斗之外。
    const FUNNEL_STAGE_ORDER = ['new_inquiry', 'quoted', 'closed_won'];
    // 沿用上面 DASHBOARD_STATUS_ORDER 的完整訂單狀態流程順序，用來從「目前 status」往回推算
    // 這張訂單曾經到達過的最深漏斗關卡（例如目前是 shipped，代表一定經過 quoted／closed_won）。
    const FULL_STATUS_FLOW_ORDER = ['new_inquiry', 'quoted', 'closed_won', 'in_production', 'qc', 'ready_to_ship', 'shipped', 'completed'];
    function reachedFunnelStages(order, currentStatus) {
      const reached = new Set();
      const history = Array.isArray(order.statusHistory) ? order.statusHistory : null;
      if (history) {
        history.forEach(h => {
          if (h && FUNNEL_STAGE_ORDER.includes(h.from)) reached.add(h.from);
          if (h && FUNNEL_STAGE_ORDER.includes(h.to)) reached.add(h.to);
        });
      }
      // cancelled／closed_lost／other 這類不在正常流程順序裡的終止或未知狀態，沒有自己的
      // 「深度」可以推算，只能靠上面的 statusHistory 判斷；如果連 statusHistory 都沒有，
      // 就只能保守視為「至少到過 new_inquiry」（任何訂單存在，代表一定送出過詢價）。
      const flowIdx = FULL_STATUS_FLOW_ORDER.indexOf(currentStatus);
      if (flowIdx >= 0) {
        FULL_STATUS_FLOW_ORDER.slice(0, flowIdx + 1).forEach(s => {
          if (FUNNEL_STAGE_ORDER.includes(s)) reached.add(s);
        });
      } else if (reached.size === 0) {
        reached.add('new_inquiry');
      }
      return reached;
    }
    const funnelStageCounts = { new_inquiry: 0, quoted: 0, closed_won: 0 };
    orders.forEach(o => {
      const status = o.status || (o.processed ? 'closed_won' : 'new_inquiry');
      const reached = reachedFunnelStages(o, status);
      FUNNEL_STAGE_ORDER.forEach(stage => {
        if (reached.has(stage)) funnelStageCounts[stage] += 1;
      });
    });
    const FUNNEL_STAGE_LABELS = { new_inquiry: '新詢價', quoted: '已報價', closed_won: '已成交' };
    const conversionFunnel = FUNNEL_STAGE_ORDER.map((stage, idx) => {
      const count = funnelStageCounts[stage];
      const prevCount = idx > 0 ? funnelStageCounts[FUNNEL_STAGE_ORDER[idx - 1]] : null;
      // 上一關人數為0時，流失率沒有意義（0除以0），一律回傳 null，前端顯示「--」而不是
      // 誤導性的0%或Infinity。
      const dropRate = (prevCount !== null && prevCount > 0) ? (prevCount - count) / prevCount : null;
      return { stage, label: FUNNEL_STAGE_LABELS[stage], count, dropRate };
    });

    res.json({
      success: true,
      // 全站累計總覽（不受粒度篩選，見上方大段說明）
      orderCount,
      revenueTotal,
      productCount,
      lowStock,
      lowStockCount: lowStock.length,
      // 本期間（依 granularity 決定是今天／本月／本季／本年）
      granularity,
      periodLabel,
      periodOrderCount,
      periodRevenue,
      // 目前工作量快照（不受粒度篩選，見上方大段說明）
      pendingCount,
      productionCount,
      overdueCount,
      // 依粒度分組的趨勢，以及僅本期間內的分析區塊
      revenueTrend: trendBuckets,
      byProduct,
      customers,
      statusBreakdown: DASHBOARD_STATUS_ORDER.map(s => ({
        status: s,
        label: s === 'other' ? '其他' : DASHBOARD_STATUS_LABELS[s],
        count: statusCounts[s]
      })),
      topProducts,
      conversionFunnel
    });
  });

  // ─── API：儀表板匯出Excel（總覽／營收趨勢／訂單狀態分布／熱門商品排行／依商品訂單分布／
  // 庫存概況／客戶訂單彙總，7個分頁）───────────────────────────────
  // 沿用網站分析匯出那批同一套原則：畫面上已經算好、正在顯示的資料才是唯一來源，這裡不重新
  // 查一次訂單／資料庫，只負責把前端送來的資料轉成活頁簿分頁，避免匯出內容跟畫面對不上。
  router.post('/dashboard/export', requirePermission('dashboard', 'view'), csrfProtection, async (req, res) => {
    const arr = key => Array.isArray(req.body?.[key]) ? req.body[key] : [];
    const summaryRows = arr('summaryRows');
    const trendRows = arr('trendRows');
    const statusRows = arr('statusRows');
    const topProductRows = arr('topProductRows');
    const byProductRows = arr('byProductRows');
    const inventoryRows = arr('inventoryRows');
    const customerRows = arr('customerRows');
    const allEmpty = [summaryRows, trendRows, statusRows, topProductRows, byProductRows, inventoryRows, customerRows].every(a => !a.length);
    if (allEmpty) {
      return res.status(400).json({ error: '目前沒有可以匯出的儀表板資料' });
    }
    const cap = a => a.slice(0, 5000); // 這幾份資料本來就是固定筆數的摘要／清單，上限只是防禦性保護
    const str = v => String(v ?? '');
    const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    try {
      const buffer = await buildMultiSheetXlsxBuffer([
        { name: '總覽', columns: [{ header: '指標', key: 'label', width: 22 }, { header: '數值', key: 'value', width: 26 }],
          rows: cap(summaryRows).map(r => ({ label: str(r?.label), value: str(r?.value) })) },
        { name: '營收趨勢明細', columns: [{ header: '期間', key: 'period', width: 16 }, { header: '訂單數', key: 'orderCount', width: 10 }, { header: '營業額', key: 'revenue', width: 14 }],
          rows: cap(trendRows).map(r => ({ period: str(r?.period), orderCount: num(r?.orderCount), revenue: num(r?.revenue) })) },
        { name: '訂單狀態分布', columns: [{ header: '狀態', key: 'status', width: 16 }, { header: '訂單數', key: 'count', width: 10 }],
          rows: cap(statusRows).map(r => ({ status: str(r?.status), count: num(r?.count) })) },
        { name: '熱門商品排行', columns: [{ header: '排名', key: 'rank', width: 8 }, { header: '商品', key: 'productName', width: 22 }, { header: '訂單數', key: 'orderCount', width: 10 }],
          rows: cap(topProductRows).map(r => ({ rank: num(r?.rank), productName: str(r?.productName), orderCount: num(r?.orderCount) })) },
        { name: '依商品訂單分布', columns: [{ header: '商品', key: 'productName', width: 22 }, { header: '訂單數', key: 'orderCount', width: 10 }],
          rows: cap(byProductRows).map(r => ({ productName: str(r?.productName), orderCount: num(r?.orderCount) })) },
        { name: '庫存概況', columns: [
            { header: '商品', key: 'name', width: 22 }, { header: '目前庫存', key: 'stockQty', width: 12 },
            { header: '低庫存警戒值', key: 'threshold', width: 12 }, { header: '單位', key: 'unit', width: 10 }, { header: '狀態', key: 'status', width: 10 }
          ], rows: cap(inventoryRows).map(r => ({ name: str(r?.name), stockQty: num(r?.stockQty), threshold: num(r?.threshold), unit: str(r?.unit), status: str(r?.status) })) },
        { name: '客戶訂單彙總', columns: [
            { header: '客戶', key: 'name', width: 16 }, { header: 'Email', key: 'email', width: 26 },
            { header: '訂單數', key: 'orderCount', width: 10 }, { header: '累計估價金額', key: 'totalSpent', width: 14 }, { header: '最近下單時間', key: 'lastOrderAt', width: 20 }
          ], rows: cap(customerRows).map(r => ({ name: str(r?.name), email: str(r?.email), orderCount: num(r?.orderCount), totalSpent: num(r?.totalSpent), lastOrderAt: str(r?.lastOrderAt) })) }
      ]);
      sendXlsx(res, '楊竹儀表板', buffer);
    } catch (err) {
      console.error('[dashboard/export] 產生Excel失敗', err.message);
      res.status(500).json({ error: '匯出失敗，請稍後再試' });
    }
  });

  // ══════════════ 客戶管理（唯讀第一階段） ══════════════
  // 資料來源完全是既有訂單 JSON 檔案，不新增客戶資料表；本階段只提供查詢，不提供新增／編輯／
  // 刪除／合併客戶的 API。客戶識別規則：Email（trim＋轉小寫）優先；沒有 Email 但有電話則用
  // 清理過的電話；兩者都沒有時，不可以把所有「未填寫」訂單合併成同一位客戶（會誤把不同人的
  // 訂單兜在一起），改用該筆訂單自己的 orderId 當識別依據，確保只有這一筆訂單、不會被誤合併。
  // customerId 一律是這個識別字串的 SHA-256 雜湊十六進位字串（不可逆），對外 API 完全不會把
  // 原始 Email／電話放進網址或回應內容。
  const CUSTOMER_REVENUE_EXCLUDED_STATUSES = ['cancelled', 'closed_lost']; // closed_lost 目前系統未使用，一併排除是配合需求描述、面向未來擴充，不影響現況行為

  function normalizeCustomerEmail(email) {
    return (typeof email === 'string') ? email.trim().toLowerCase() : '';
  }
  // 只保留數字與開頭可能出現的加號（國際冠碼），清掉空白、括號、破折號等符號。
  function normalizeCustomerPhone(phone) {
    return (typeof phone === 'string') ? phone.replace(/[^0-9+]/g, '') : '';
  }
  function buildCustomerKey(order) {
    const email = normalizeCustomerEmail(order.contact?.email);
    if (email) return `email:${email}`;
    const phone = normalizeCustomerPhone(order.contact?.phone);
    if (phone) return `phone:${phone}`;
    return `order:${order.orderId}`;
  }
  function buildCustomerId(key) {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  // 金額正規化：只有「型別是 number、是有限值（非 NaN／非 Infinity）、且 >= 0」才視為合法
  // 金額，其餘一律回傳 null（字串、null、物件、陣列、負數都不合法）。不可以用 `value || 0`
  // 這種寫法——非空字串在 `||` 底下是 truthy，會被誤判成「有值」，之後如果又拿去做
  // `累計 += 字串`，JS 會把數字自動轉型成字串串接，讓惡意字串（例如帶 <img onerror> 的
  // HTML）就這樣混進本來應該是純數字的欄位、最後流進畫面。
  function normalizeCustomerAmount(value) {
    return (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : null;
  }

  // 安全讀取全部訂單：跟既有 GET /api/orders、GET /dashboard 同一套「單一壞檔不拖垮整批」
  // 寫法，額外補上明確的伺服器端錯誤紀錄（含檔名），滿足「留下伺服器錯誤紀錄」的要求。
  function readAllOrdersSafe() {
    let files;
    try {
      files = fs.readdirSync(ORDER_DIR).filter(f => f.endsWith('.json'));
    } catch (err) {
      console.error('[customers] 讀取訂單資料夾失敗：', err.message);
      return [];
    }
    return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(ORDER_DIR, f), 'utf8'));
      } catch (err) {
        console.error(`[customers] 訂單檔案解析失敗，已安全略過：${f}`, err.message);
        return null;
      }
    }).filter(Boolean);
  }

  // 把全部訂單（含已封存，跟既有 dashboard 客戶彙總邏輯一致）依 buildCustomerKey() 分組彙總。
  // 姓名／Email／電話一律顯示「最新一筆訂單」填寫的內容（用 savedAt 字串比較，ISO 8601
  // 字典序等同時間序），跟陣列本身的讀取順序無關。累計金額（totalSpent）排除
  // cancelled／closed_lost 訂單；每筆訂單金額一律先經過 normalizeCustomerAmount() 驗證
  // （型別必須是 number、Number.isFinite() 為真、且 >= 0），非法金額（詢價商品沒有
  // quote.total、字串、負數、NaN、Infinity 等）一律不參與加總，貢獻視同 0（加總語意下安全，
  // 不會讓總額失真），不是把它當成「賣 0 元」寫進任何顯示金額本身——單筆訂單金額在下面
  // /customers/:customerId 明細裡會明確用 null 表示「尚無正式金額」。
  function aggregateCustomers(orders) {
    const map = new Map();
    orders.forEach(o => {
      if (!o || typeof o !== 'object' || !o.orderId) return; // 資料格式完全不對就整筆略過，不猜測
      const key = buildCustomerKey(o);
      const customerId = buildCustomerId(key);
      if (!map.has(customerId)) {
        map.set(customerId, {
          customerId, name: '', email: '', phone: '',
          orderCount: 0, totalSpent: 0, lastOrderAt: null,
          _latestSavedAt: null, orders: []
        });
      }
      const c = map.get(customerId);
      c.orderCount += 1;
      if (!CUSTOMER_REVENUE_EXCLUDED_STATUSES.includes(o.status)) {
        const amt = normalizeCustomerAmount(o.quote?.total);
        if (amt !== null) c.totalSpent += amt;
      }
      if (!c.lastOrderAt || (o.savedAt && o.savedAt > c.lastOrderAt)) {
        c.lastOrderAt = o.savedAt || c.lastOrderAt;
      }
      if (!c._latestSavedAt || (o.savedAt && o.savedAt >= c._latestSavedAt)) {
        c._latestSavedAt = o.savedAt || c._latestSavedAt;
        c.name = o.contact?.name || c.name;
        c.email = o.contact?.email || c.email;
        c.phone = o.contact?.phone || c.phone;
      }
      c.orders.push(o);
    });
    return [...map.values()].map(c => {
      delete c._latestSavedAt;
      return c;
    });
  }

  // ── 客戶主檔覆蓋層（顯示用，第二階段：客戶資料編輯與內部備註）───────────────
  // customer_profiles 只覆蓋「後台顯示」的姓名／Email／電話，完全不會回寫、也不會影響任何
  // 訂單 JSON 檔案；customerId 與訂單歸屬永遠只由 aggregateCustomers()／buildCustomerId() 從
  // 訂單資料即時計算，這裡的編輯只是疊加一層顯示用的覆蓋值，不參與、也不影響分組邏輯，
  // 因此修改 Email／電話絕對不會讓 customerId 或既有歷史訂單關聯跟著改變。
  function loadCustomerOrNull(customerId) {
    const orders = readAllOrdersSafe();
    const customers = aggregateCustomers(orders);
    return customers.find(c => c.customerId === customerId) || null;
  }

  function getProfileMap() {
    const rows = db.prepare('SELECT * FROM customer_profiles').all();
    const map = new Map();
    rows.forEach(r => map.set(r.customer_id, r));
    return map;
  }

  function applyProfileOverride(customer, profile) {
    return {
      ...customer,
      name: (profile && profile.display_name) ? profile.display_name : customer.name,
      email: (profile && profile.display_email) ? profile.display_email : customer.email,
      phone: (profile && profile.display_phone) ? profile.display_phone : customer.phone
    };
  }

  // 記錄「這個穩定 customerId 曾經對應過哪些識別字串」的稽核歷史（見 db.js 裡
  // customer_identities 的說明），只在管理員實際編輯主檔或新增備註（真正「碰過」這位客戶）
  // 時才寫入，不在單純查詢（GET）時寫入，避免每次列表載入都對資料庫產生副作用。
  const insertCustomerIdentity = db.prepare(`
    INSERT OR IGNORE INTO customer_identities (customer_id, identity_key, first_seen_at)
    VALUES (?, ?, ?)
  `);
  function touchCustomerIdentities(customer) {
    const now = new Date().toISOString();
    const keys = new Set(customer.orders.map(o => buildCustomerKey(o)));
    keys.forEach(k => insertCustomerIdentity.run(customer.customerId, k, now));
  }

  const CUSTOMER_NAME_MAX_LEN = 100;
  const CUSTOMER_EMAIL_MAX_LEN = 254;
  const CUSTOMER_PHONE_MAX_LEN = 30;
  const CUSTOMER_NOTE_MAX_LEN = 2000;
  const CUSTOMER_EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const CUSTOMER_PHONE_FORMAT_RE = /^[0-9+\-\s()]+$/; // 僅接受數字、+、-、括號、空白

  // 驗證客戶主檔編輯的輸入：只接受 name／email／phone 三個欄位，且都是「有提供才驗證、
  // 沒提供就沿用原本覆蓋值」的部分更新語意；提供空字串代表「清空覆蓋，改回顯示訂單原始資料」。
  function validateCustomerProfileInput(body) {
    const errors = [];
    const result = {};
    if (Object.prototype.hasOwnProperty.call(body, 'name')) {
      if (typeof body.name !== 'string') {
        errors.push('name 必須是字串');
      } else {
        const trimmed = body.name.trim();
        if (trimmed.length > CUSTOMER_NAME_MAX_LEN) errors.push(`name 長度不可超過 ${CUSTOMER_NAME_MAX_LEN} 字`);
        else result.name = trimmed;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'email')) {
      if (typeof body.email !== 'string') {
        errors.push('email 必須是字串');
      } else {
        const trimmed = body.email.trim();
        if (trimmed.length > CUSTOMER_EMAIL_MAX_LEN) errors.push(`email 長度不可超過 ${CUSTOMER_EMAIL_MAX_LEN} 字`);
        else if (trimmed && !CUSTOMER_EMAIL_FORMAT_RE.test(trimmed)) errors.push('email 格式不正確');
        else result.email = trimmed.toLowerCase();
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'phone')) {
      if (typeof body.phone !== 'string') {
        errors.push('phone 必須是字串');
      } else {
        const trimmed = body.phone.trim();
        if (trimmed.length > CUSTOMER_PHONE_MAX_LEN) errors.push(`phone 長度不可超過 ${CUSTOMER_PHONE_MAX_LEN} 字`);
        else if (trimmed && !CUSTOMER_PHONE_FORMAT_RE.test(trimmed)) errors.push('phone 格式不正確（僅能包含數字、+、-、括號、空白）');
        else result.phone = trimmed;
      }
    }
    return { errors, result };
  }

  function validateCustomerNoteInput(body) {
    if (typeof body.content !== 'string') return { error: 'content 必須是字串' };
    const trimmed = body.content.trim();
    if (!trimmed) return { error: 'content 不可為空白' };
    if (trimmed.length > CUSTOMER_NOTE_MAX_LEN) return { error: `content 長度不可超過 ${CUSTOMER_NOTE_MAX_LEN} 字` };
    return { content: trimmed };
  }

  // ══════════════ 公司資料、收件地址、客戶標籤（第三階段） ══════════════
  const COMPANY_NAME_MAX_LEN = 100;
  const TAX_ID_RE = /^\d{8}$/; // 台灣統一編號固定8碼數字
  const INVOICE_TITLE_MAX_LEN = 150;
  const ADDRESS_RECIPIENT_MAX_LEN = 50;
  const ADDRESS_MAX_LEN = 200;
  const ADDRESS_PHONE_MAX_LEN = 30;
  const ADDRESS_POSTAL_RE = /^[0-9]{3,6}$/;
  const TAG_MAX_LEN = 20;
  const TAG_MAX_COUNT = 10; // 每位客戶最多可加的標籤數量

  // 部分更新語意跟 validateCustomerProfileInput() 同一套慣例：有提供才驗證，沒提供沿用舊值，
  // 給空字串代表清空該欄位。
  function validateCustomerCompanyInput(body) {
    const errors = [];
    const result = {};
    if (Object.prototype.hasOwnProperty.call(body, 'companyName')) {
      if (typeof body.companyName !== 'string') {
        errors.push('companyName 必須是字串');
      } else {
        const trimmed = body.companyName.trim();
        if (trimmed.length > COMPANY_NAME_MAX_LEN) errors.push(`companyName 長度不可超過 ${COMPANY_NAME_MAX_LEN} 字`);
        else result.companyName = trimmed;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'taxId')) {
      if (typeof body.taxId !== 'string') {
        errors.push('taxId 必須是字串');
      } else {
        const trimmed = body.taxId.trim();
        if (trimmed && !TAX_ID_RE.test(trimmed)) errors.push('taxId 必須是8碼數字');
        else result.taxId = trimmed;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'invoiceTitle')) {
      if (typeof body.invoiceTitle !== 'string') {
        errors.push('invoiceTitle 必須是字串');
      } else {
        const trimmed = body.invoiceTitle.trim();
        if (trimmed.length > INVOICE_TITLE_MAX_LEN) errors.push(`invoiceTitle 長度不可超過 ${INVOICE_TITLE_MAX_LEN} 字`);
        else result.invoiceTitle = trimmed;
      }
    }
    return { errors, result };
  }

  // isCreate=true 時 recipientName／address 為必填；編輯（部分更新）時兩者皆可省略沿用舊值。
  function validateCustomerAddressInput(body, isCreate) {
    const errors = [];
    const result = {};
    const has = k => Object.prototype.hasOwnProperty.call(body, k);

    if (has('recipientName')) {
      if (typeof body.recipientName !== 'string') errors.push('recipientName 必須是字串');
      else {
        const trimmed = body.recipientName.trim();
        if (!trimmed) errors.push('recipientName 不可為空白');
        else if (trimmed.length > ADDRESS_RECIPIENT_MAX_LEN) errors.push(`recipientName 長度不可超過 ${ADDRESS_RECIPIENT_MAX_LEN} 字`);
        else result.recipientName = trimmed;
      }
    } else if (isCreate) {
      errors.push('recipientName 為必填');
    }

    if (has('phone')) {
      if (typeof body.phone !== 'string') errors.push('phone 必須是字串');
      else {
        const trimmed = body.phone.trim();
        if (trimmed.length > ADDRESS_PHONE_MAX_LEN) errors.push(`phone 長度不可超過 ${ADDRESS_PHONE_MAX_LEN} 字`);
        else if (trimmed && !CUSTOMER_PHONE_FORMAT_RE.test(trimmed)) errors.push('phone 格式不正確（僅能包含數字、+、-、括號、空白）');
        else result.phone = trimmed;
      }
    }

    if (has('postalCode')) {
      if (typeof body.postalCode !== 'string') errors.push('postalCode 必須是字串');
      else {
        const trimmed = body.postalCode.trim();
        if (trimmed && !ADDRESS_POSTAL_RE.test(trimmed)) errors.push('postalCode 必須是3~6碼數字');
        else result.postalCode = trimmed;
      }
    }

    if (has('address')) {
      if (typeof body.address !== 'string') errors.push('address 必須是字串');
      else {
        const trimmed = body.address.trim();
        if (!trimmed) errors.push('address 不可為空白');
        else if (trimmed.length > ADDRESS_MAX_LEN) errors.push(`address 長度不可超過 ${ADDRESS_MAX_LEN} 字`);
        else result.address = trimmed;
      }
    } else if (isCreate) {
      errors.push('address 為必填');
    }

    if (has('isDefault')) {
      if (typeof body.isDefault !== 'boolean') errors.push('isDefault 必須是布林值');
      else result.isDefault = body.isDefault;
    }

    return { errors, result };
  }

  function validateCustomerTagInput(body) {
    if (typeof body.tag !== 'string') return { error: 'tag 必須是字串' };
    const trimmed = body.tag.trim();
    if (!trimmed) return { error: 'tag 不可為空白' };
    if (trimmed.length > TAG_MAX_LEN) return { error: `tag 長度不可超過 ${TAG_MAX_LEN} 字` };
    return { tag: trimmed };
  }


  // ══════════════ 重複客戶人工合併（第四階段） ══════════════
  // 核心原則：customer_merges 只記錄「舊 customerId → 主要 customerId」的關係，orders／
  // customer_profiles／customer_companies／customer_addresses／customer_tags／customer_notes
  // 全部原樣留在各自原本的 customer_id 底下，完全不搬動、不刪除、不回寫任何歷史訂單 JSON。
  // 合併／解除合併都只是「這筆關係是否生效」的開關，底層資料從頭到尾沒有被搬過，因此解除合併
  // 保證不會遺失任何資料。

  // 只做一次表查詢（O(1)）：db.js 的 migration 註解已說明寫入時如何維持「扁平化」不變量，
  // 讓這裡永遠不需要遞迴或迴圈往上找、也天生不可能出現循環合併。
  function resolvePrimaryCustomerId(customerId) {
    const row = db.prepare('SELECT primary_customer_id FROM customer_merges WHERE alias_customer_id = ? AND unmerged_at IS NULL').get(customerId);
    return row ? row.primary_customer_id : customerId;
  }

  // 回傳目前生效中、實際歸屬同一個合併群組的全部 customerId（含主要客戶自己）。
  function getMergedGroupMemberIds(primaryId) {
    const aliasRows = db.prepare('SELECT alias_customer_id FROM customer_merges WHERE primary_customer_id = ? AND unmerged_at IS NULL').all(primaryId);
    return [primaryId, ...aliasRows.map(r => r.alias_customer_id)];
  }

  // 把同一個合併群組內、各自從訂單即時彙總出來的原始客戶（members）合併成一筆顯示用客戶：
  // orderCount／totalSpent 直接加總（member 本身的數字已經過 aggregateCustomers() 的合法性驗證，
  // 這裡不需要重新驗證）；姓名／Email／電話重新用「全部訂單裡最新一筆 savedAt」決定（不是直接
  // 沿用某個 member 的顯示值），跟 aggregateCustomers() 單一客戶內部的邏輯完全一致，只是這次
  // 掃描的是整個合併群組的訂單。_rawMembers 保留給搜尋比對用（可以用被合併客戶的舊姓名／
  // Email／電話搜到合併後的主要客戶），輸出 API 前一律會被移除，不會外洩。
  function buildMergedCustomer(primaryId, members) {
    let orderCount = 0, totalSpent = 0, lastOrderAt = null;
    let latestSavedAt = null, name = '', email = '', phone = '';
    let orders = [];
    members.forEach(m => {
      orderCount += Number.isFinite(m.orderCount) ? m.orderCount : 0;
      totalSpent += Number.isFinite(m.totalSpent) ? m.totalSpent : 0;
      if (!lastOrderAt || (m.lastOrderAt && m.lastOrderAt > lastOrderAt)) lastOrderAt = m.lastOrderAt || lastOrderAt;
      orders = orders.concat(m.orders);
    });
    orders.forEach(o => {
      if (!latestSavedAt || (o.savedAt && o.savedAt >= latestSavedAt)) {
        latestSavedAt = o.savedAt || latestSavedAt;
        name = o.contact?.name || name;
        email = o.contact?.email || email;
        phone = o.contact?.phone || phone;
      }
    });
    return { customerId: primaryId, name, email, phone, orderCount, totalSpent, lastOrderAt, orders, _rawMembers: members };
  }

  // 把「訂單即時彙總出來的所有原始客戶」依目前生效中的合併關係分組，回傳一份已經彙總好的
  // 合併後客戶清單（每個合併群組一筆）。不管有沒有被合併過，每位客戶都會經過這支函式，
  // 沒被合併的客戶單純就是一個只有自己一個 member 的群組。
  function buildAllMergedCustomers() {
    const orders = readAllOrdersSafe();
    const rawCustomers = aggregateCustomers(orders);
    const groups = new Map();
    rawCustomers.forEach(c => {
      const primaryId = resolvePrimaryCustomerId(c.customerId);
      if (!groups.has(primaryId)) groups.set(primaryId, []);
      groups.get(primaryId).push(c);
    });
    return [...groups.entries()].map(([primaryId, members]) => buildMergedCustomer(primaryId, members));
  }

  // 公司資料是 1:1 覆蓋層，合併群組內可能有好幾筆（主要客戶自己＋各個被合併客戶原本填過的）。
  // 逐欄位取值：主要客戶自己填過的優先，缺的欄位才用被合併客戶裡最近更新的資料補齊，
  // 避免因為合併而讓已經填好的公司資料被沒填的空值蓋掉、也避免遺失被合併客戶原本填的資料。
  function getMergedCompany(primaryId, memberIds) {
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM customer_companies WHERE customer_id IN (${placeholders}) ORDER BY (customer_id = ?) DESC, updated_at DESC`
    ).all(...memberIds, primaryId);
    let companyName = '', taxId = '', invoiceTitle = '', updatedAt = null;
    rows.forEach(r => {
      if (!companyName && r.company_name) companyName = r.company_name;
      if (!taxId && r.tax_id) taxId = r.tax_id;
      if (!invoiceTitle && r.invoice_title) invoiceTitle = r.invoice_title;
      if (!updatedAt) updatedAt = r.updated_at;
    });
    return { companyName, taxId, invoiceTitle, updatedAt };
  }

  // 收件地址是可多筆的清單，合併群組內直接把所有 member 的地址列出來，用「收件人＋電話＋
  // 郵遞區號＋地址」正規化後的字串去重（同一組收件資訊如果兩邊都填過一樣的，只留一筆，
  // 優先保留主要客戶自己的那一筆）；預設地址同理最多只顯示一筆（優先保留主要客戶自己的
  // 預設狀態），這是顯示層面的收斂，不會真的去改資料庫裡各自原本的 is_default 欄位
  // （解除合併後每個客戶原本的預設狀態依然完整保留）。
  function getMergedAddresses(primaryId, memberIds) {
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM customer_addresses WHERE customer_id IN (${placeholders}) ORDER BY (customer_id = ?) DESC, is_default DESC, created_at ASC, id ASC`
    ).all(...memberIds, primaryId);
    const seen = new Set();
    let defaultAssigned = false;
    const result = [];
    rows.forEach(r => {
      const dedupKey = [
        String(r.recipient_name || '').trim().toLowerCase(),
        normalizeCustomerPhone(r.phone || ''),
        String(r.postal_code || '').trim().toLowerCase(),
        String(r.address || '').trim().toLowerCase()
      ].join('|');
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      const isDefault = !!r.is_default && !defaultAssigned;
      if (isDefault) defaultAssigned = true;
      result.push({
        id: r.id,
        recipientName: r.recipient_name,
        phone: r.phone || '',
        postalCode: r.postal_code || '',
        address: r.address,
        isDefault,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        ownerCustomerId: r.customer_id
      });
    });
    return result;
  }

  // 標籤直接是集合概念，合併群組內任何一邊加過的標籤都算數，用標籤文字去重（同一個標籤字串
  // 不管原本掛在哪個 customerId 底下，合併後只顯示一次）。
  function getMergedTags(primaryId, memberIds) {
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM customer_tags WHERE customer_id IN (${placeholders}) ORDER BY created_at ASC, id ASC`
    ).all(...memberIds);
    const seen = new Set();
    const result = [];
    rows.forEach(r => {
      if (seen.has(r.tag)) return;
      seen.add(r.tag);
      result.push({ id: r.id, tag: r.tag, createdAt: r.created_at, ownerCustomerId: r.customer_id });
    });
    return result;
  }

  // 備註是「只能新增」的追加式紀錄，合併群組內每一則都是獨立事實陳述，直接聯集、不去重，
  // 依時間新到舊排序。
  function getMergedNotes(memberIds) {
    const placeholders = memberIds.map(() => '?').join(',');
    const rows = db.prepare(
      `SELECT * FROM customer_notes WHERE customer_id IN (${placeholders}) ORDER BY created_at DESC, id DESC`
    ).all(...memberIds);
    return rows.map(r => ({ id: r.id, content: r.content, actor: r.actor, createdAt: r.created_at, ownerCustomerId: r.customer_id }));
  }

  // 判斷某個地址／標籤原本掛的 customer_id，是否確實屬於「這次請求解析出來的主要客戶」的合併
  // 群組——用來讓既有的編輯／刪除 API 在合併後仍然找得到、也能正確操作被合併客戶名下的資料，
  // 同時保證不會誤操作到完全無關的其他客戶（跨群組一律視為 404，隔離性跟合併前完全一致）。
  function isInMergedGroup(rowCustomerId, primaryId) {
    return rowCustomerId === primaryId || resolvePrimaryCustomerId(rowCustomerId) === primaryId;
  }

  // 組出跟 GET /customers/:customerId 一致的完整客戶詳情物件（給詳情路由本身、合併預覽共用），
  // 傳入的 primaryId 必須已經是解析過的主要客戶。找不到（連一個 member 都沒有訂單資料，理論上
  // 不會發生——因為 customerId 的存在前提就是至少有一筆訂單）時回傳 null。
  function buildFullCustomerDetail(primaryId) {
    const orders = readAllOrdersSafe();
    const rawCustomers = aggregateCustomers(orders);
    const rawMap = new Map(rawCustomers.map(c => [c.customerId, c]));
    const memberIds = getMergedGroupMemberIds(primaryId);
    const members = memberIds.map(id => rawMap.get(id)).filter(Boolean);
    if (!members.length) return null;

    const merged = buildMergedCustomer(primaryId, members);
    const profile = db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?').get(primaryId);
    const customer = applyProfileOverride(merged, profile);

    const orderSummaries = customer.orders
      .slice()
      .sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''))
      .map(o => {
        const priceOnInquiry = !!(o.product?.priceOnInquiry || o.quote?.priceOnInquiry);
        return {
          orderId: o.orderId,
          friendlyOrderNo: o.friendlyOrderNo || o.orderId,
          savedAt: o.savedAt || null,
          productName: o.product?.name || o.product?.id || '未知商品',
          qty: (typeof o.product?.qty === 'number') ? o.product.qty : ((typeof o.quote?.qty === 'number') ? o.quote.qty : null),
          status: o.status || (o.processed ? 'closed_won' : 'new_inquiry'),
          amount: priceOnInquiry ? null : normalizeCustomerAmount(o.quote?.total),
          priceOnInquiry,
          archived: !!o.archivedAt
        };
      });

    return {
      customer: {
        customerId: customer.customerId,
        name: customer.name || '',
        email: customer.email || '',
        phone: customer.phone || '',
        orderCount: Number.isFinite(customer.orderCount) ? customer.orderCount : 0,
        totalSpent: Number.isFinite(customer.totalSpent) ? customer.totalSpent : 0,
        lastOrderAt: customer.lastOrderAt
      },
      orders: orderSummaries,
      company: getMergedCompany(primaryId, memberIds),
      addresses: getMergedAddresses(primaryId, memberIds),
      tags: getMergedTags(primaryId, memberIds),
      mergedFrom: memberIds.filter(id => id !== primaryId)
    };
  }

  // ── 重複客戶判斷：簡單 Levenshtein 編輯距離，資料量只有幾十到幾百位客戶等級，
  // O(n²) 兩兩比對即可，不需要額外索引結構。──────────────────────────────
  function levenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i][j] = (a[i - 1] === b[j - 1]) ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
    return dp[m][n];
  }
  // 「高度接近」：同一組帳號名稱（@ 前面）但網域打錯，或整串編輯距離很小（打錯1~2個字）；
  // 刻意要求最短長度限制，避免短字串（例如 "ab@cd"）距離門檻太寬鬆而產生大量誤判。
  function emailsSimilar(a, b) {
    if (!a || !b || a === b) return false;
    const localA = a.split('@')[0], localB = b.split('@')[0];
    if (localA && localA === localB) return true;
    if (a.length >= 6 && b.length >= 6 && levenshteinDistance(a, b) <= 2) return true;
    return false;
  }
  function phonesSimilar(a, b) {
    if (!a || !b || a === b) return false;
    if (a.length >= 8 && b.length >= 8 && levenshteinDistance(a, b) <= 2) return true;
    return false;
  }

  // 只在「目前的合併後頂層客戶清單」裡兩兩比對——已經合併過的客戶不會再各自出現在頂層，
  // 自然不會被重複列為候選，也不會列出跟自己所屬同一群組的假候選。
  function detectMergeCandidates() {
    // 套用跟清單頁一致的主檔顯示覆蓋層：如果管理員已經手動修正過某位客戶的顯示 Email／電話
    // （customer_profiles），偵測也要依照「畫面上實際顯示的值」來比對，這樣管理員自己已經
    // 確認過的關聯（例如手動把打錯的 Email 改成跟另一位客戶一致）才可能真的被偵測出來。
    const profiles = getProfileMap();
    const merged = buildAllMergedCustomers().map(c => applyProfileOverride(c, profiles.get(c.customerId)));
    const whitelist = c => ({
      customerId: c.customerId, name: c.name || '', email: c.email || '', phone: c.phone || '',
      orderCount: Number.isFinite(c.orderCount) ? c.orderCount : 0,
      totalSpent: Number.isFinite(c.totalSpent) ? c.totalSpent : 0,
      lastOrderAt: c.lastOrderAt
    });
    const candidates = [];
    for (let i = 0; i < merged.length; i++) {
      for (let j = i + 1; j < merged.length; j++) {
        const A = merged[i], B = merged[j];
        const emailA = normalizeCustomerEmail(A.email), emailB = normalizeCustomerEmail(B.email);
        const phoneA = normalizeCustomerPhone(A.phone), phoneB = normalizeCustomerPhone(B.phone);
        const nameA = (A.name || '').trim(), nameB = (B.name || '').trim();
        const nameMatch = !!nameA && !!nameB && nameA === nameB;
        const reasons = [];
        if (emailA && emailB && emailA === emailB) reasons.push('email_exact');
        if (phoneA && phoneB && phoneA === phoneB) reasons.push('phone_exact');
        if (nameMatch && !reasons.includes('email_exact') && emailsSimilar(emailA, emailB)) reasons.push('name_and_similar_email');
        if (nameMatch && !reasons.includes('phone_exact') && phonesSimilar(phoneA, phoneB)) reasons.push('name_and_similar_phone');
        if (reasons.length) {
          candidates.push({ customerA: whitelist(A), customerB: whitelist(B), reasons });
        }
      }
    }
    return candidates;
  }

  // 客戶清單的篩選（關鍵字／標籤）＋排序邏輯，GET /customers（分頁顯示）跟
  // GET /customers/export（匯出目前篩選結果全部筆數，不分頁）共用同一份，避免兩邊各自
  // 維護一份規則、日後改了一邊卻忘記改另一邊，造成「畫面篩選結果」跟「匯出內容」兜不起來。
  function getFilteredSortedCustomers(query) {
    // 合併群組彙總（沒被合併過的客戶單純是「一人一組」，行為跟合併功能上線前完全一致）；
    // 每個 member 一定經過 aggregateCustomers() 的合法金額驗證，buildMergedCustomer() 再加總，
    // 不需要在這裡重新驗證數字。
    let customers = buildAllMergedCustomers();
    const profiles = getProfileMap();
    customers = customers.map(c => applyProfileOverride(c, profiles.get(c.customerId)));

    // 搜尋除了比對合併後的顯示姓名／Email／電話，也會比對群組內每個原始客戶自己的姓名／
    // Email／電話——這樣客戶換過 Email 或電話、被合併後，用舊的聯絡方式一樣搜得到主要客戶，
    // 這正是「重複客戶合併」要解決的情境。
    const search = (query.search || '').toString().trim().toLowerCase();
    if (search) {
      const matches = v => v && v.toLowerCase().includes(search);
      customers = customers.filter(c =>
        matches(c.name) || matches(c.email) || matches(c.phone) ||
        (c._rawMembers || []).some(m => matches(m.name) || matches(m.email) || matches(m.phone))
      );
    }

    // 標籤篩選：跟搜尋是各自獨立、用 AND 疊加的條件，不影響既有搜尋／排序／分頁邏輯本身；
    // 篩選依據是合併後去重的標籤集合（群組內任何一邊加過的標籤都算數）。
    const tagFilter = (query.tag || '').toString().trim();
    if (tagFilter) {
      customers = customers.filter(c =>
        getMergedTags(c.customerId, getMergedGroupMemberIds(c.customerId)).some(t => t.tag === tagFilter)
      );
    }

    const SORT_FIELDS = ['lastOrderAt', 'orderCount', 'totalSpent'];
    const sortBy = SORT_FIELDS.includes(query.sortBy) ? query.sortBy : 'lastOrderAt';
    const sortDir = query.sortDir === 'asc' ? 1 : -1; // 預設新到舊／多到少／高到低
    customers.sort((a, b) => {
      const av = a[sortBy] ?? (sortBy === 'lastOrderAt' ? '' : 0);
      const bv = b[sortBy] ?? (sortBy === 'lastOrderAt' ? '' : 0);
      if (av < bv) return -1 * sortDir;
      if (av > bv) return 1 * sortDir;
      return 0;
    });

    return customers;
  }

  router.get('/customers', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const customers = getFilteredSortedCustomers(req.query);

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));
    const total = customers.length;
    const offset = (page - 1) * pageSize;
    const pageItems = customers.slice(offset, offset + pageSize);

    res.json({
      success: true,
      total, page, pageSize,
      // 白名單輸出：只列出這幾個欄位，絕對不會把 quoteVersions／customerAccess（客戶報價公開
      // 存取憑證）、工廠檔案路徑或任何內部訂單資料一併吐出去。
      // 輸出前再次強制保證數字欄位一定是合法 number，即使聚合邏輯未來被改壞也不會外洩
      // 非數字型別（字串等）到前端，形成第二層防線。
      customers: pageItems.map(c => ({
        customerId: c.customerId,
        name: c.name || '',
        email: c.email || '',
        phone: c.phone || '',
        orderCount: Number.isFinite(c.orderCount) ? c.orderCount : 0,
        totalSpent: Number.isFinite(c.totalSpent) ? c.totalSpent : 0,
        lastOrderAt: c.lastOrderAt,
        // 這位客戶身上目前併入了幾筆被合併客戶（0＝從未被合併過），純粹給前端顯示徽章用，
        // 不影響既有欄位語意，也不會多洩漏任何內部識別資訊。
        mergedAliasCount: (c._rawMembers || []).length - 1
      }))
    });
  });

  // ─── API：客戶匯出Excel ─────────────────────────────
  // 客戶清單原本就是伺服器端分頁（一次最多100筆），畫面上看不到「篩選後的全部客戶」，
  // 所以跟訂單／商品不一樣，這裡不能只匯出前端目前這一頁——直接沿用getFilteredSortedCustomers()
  // 重新計算「目前這組搜尋／標籤／排序條件」下的全部客戶（不分頁），確保匯出結果不受分頁影響，
  // 跟畫面上調整篩選條件時看到的排序、範圍完全一致。
  // 注意：這支路由一定要放在 GET /customers/:customerId 前面，否則 Express 會把
  // "export" 誤判成 :customerId 參數值，永遠進不到這裡。
  router.get('/customers/export', requirePermission('customers', 'view'), csrfProtection, async (req, res) => {
    const customers = getFilteredSortedCustomers(req.query);
    if (!customers.length) {
      return res.status(400).json({ error: '目前篩選結果沒有任何客戶可以匯出，請調整篩選條件' });
    }
    if (customers.length > 5000) {
      return res.status(400).json({ error: '符合篩選條件的客戶超過5000筆，請縮小篩選範圍後再匯出' });
    }
    const columns = [
      { header: '客戶姓名', key: 'name', width: 14 },
      { header: 'Email', key: 'email', width: 26 },
      { header: '電話', key: 'phone', width: 16 },
      { header: '訂購次數', key: 'orderCount', width: 10 },
      { header: '累積消費金額', key: 'totalSpent', width: 14 },
      { header: '最後下單時間', key: 'lastOrderAt', width: 20 }
    ];
    const rows = customers.map(c => ({
      name: c.name || '',
      email: c.email || '',
      phone: c.phone || '',
      orderCount: Number.isFinite(c.orderCount) ? c.orderCount : 0,
      totalSpent: Number.isFinite(c.totalSpent) ? c.totalSpent : 0,
      lastOrderAt: c.lastOrderAt || ''
    }));
    try {
      const buffer = await buildXlsxBuffer('客戶', columns, rows);
      sendXlsx(res, '楊竹客戶', buffer);
    } catch (err) {
      console.error('[customers/export] 產生Excel失敗', err.message);
      res.status(500).json({ error: '匯出失敗，請稍後再試' });
    }
  });

  router.get('/customers/:customerId', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const requestedId = req.params.customerId;
    // 舊 customerId（被合併過的客戶）查詢時自動導向主要客戶：resolvePrimaryCustomerId() 找不到
    // 生效中的合併關係時就是原樣傳回，行為跟合併功能上線前完全一致。
    const primaryId = resolvePrimaryCustomerId(requestedId);
    const detail = buildFullCustomerDetail(primaryId);
    if (!detail) return res.status(404).json({ error: '找不到此客戶' });

    res.json({
      success: true,
      // redirectFrom 只在「查詢的 customerId 已經被合併」時才會有值，前端可以用來顯示
      // 「此客戶已合併至主要客戶」的提示；mergedFrom 列出目前併入這位主要客戶的所有舊
      // customerId（可能是空陣列，代表從沒被合併過）。
      redirectFrom: requestedId !== primaryId ? requestedId : null,
      ...detail
    });
  });

  // ── 編輯客戶主檔（顯示用覆蓋，不回寫訂單）──────────────────────────────
  // 以下所有客戶附加資料路由（主檔／備註／公司／地址／標籤）一律先把路由參數 customerId
  // 解析成目前生效中的主要客戶（resolvePrimaryCustomerId），對舊 customerId（被合併過的客戶）
  // 發出請求會自動導向到主要客戶身上操作，滿足「舊 customerId 查詢時自動導向主要客戶」——
  // 不只查詢，連編輯／新增都導向，行為更一致，也讓前端不需要另外處理「這個 customerId
  // 已經被合併，要改打哪一個」的分支邏輯。
  router.put('/customers/:customerId/profile', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const hasAnyField = ['name', 'email', 'phone'].some(k => Object.prototype.hasOwnProperty.call(body, k));
    if (!hasAnyField) {
      return res.status(400).json({ error: '至少需要提供 name／email／phone 其中一項' });
    }
    const { errors, result } = validateCustomerProfileInput(body);
    if (errors.length) {
      return res.status(400).json({ error: errors.join('；') });
    }

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM customer_profiles WHERE customer_id = ?').get(primaryId);
    // 部分更新語意：這次請求沒提供的欄位沿用原本已儲存的覆蓋值；提供空字串代表主動清空覆蓋
    // （之後改回顯示訂單原始資料），因此這裡故意用 `|| null` 而不是沿用舊值。
    const displayName  = ('name'  in result) ? (result.name  || null) : (existing ? existing.display_name  : null);
    const displayEmail = ('email' in result) ? (result.email || null) : (existing ? existing.display_email : null);
    const displayPhone = ('phone' in result) ? (result.phone || null) : (existing ? existing.display_phone : null);

    db.prepare(`
      INSERT INTO customer_profiles (customer_id, display_name, display_email, display_phone, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'admin')
      ON CONFLICT(customer_id) DO UPDATE SET
        display_name  = excluded.display_name,
        display_email = excluded.display_email,
        display_phone = excluded.display_phone,
        updated_at    = excluded.updated_at,
        updated_by    = excluded.updated_by
    `).run(primaryId, displayName, displayEmail, displayPhone, now);

    touchCustomerIdentities(customer);

    const detail = buildFullCustomerDetail(primaryId);
    res.json({ success: true, customer: detail.customer });
  });

  // ── 內部備註：只能新增、不能修改或刪除；合併群組內每一則備註都是獨立事實陳述，
  // GET 直接聯集全部 member 的備註（不去重），POST 一律新增在主要客戶身上 ──────────
  router.get('/customers/:customerId/notes', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });

    res.json({ success: true, notes: getMergedNotes(getMergedGroupMemberIds(primaryId)) });
  });

  router.post('/customers/:customerId/notes', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const result = validateCustomerNoteInput(body);
    if (result.error) return res.status(400).json({ error: result.error });

    const now = new Date().toISOString();
    const info = db.prepare(`
      INSERT INTO customer_notes (customer_id, content, actor, created_at)
      VALUES (?, ?, 'admin', ?)
    `).run(primaryId, result.content, now);

    touchCustomerIdentities(customer);

    res.status(201).json({
      success: true,
      note: { id: info.lastInsertRowid, content: result.content, actor: 'admin', createdAt: now, ownerCustomerId: primaryId }
    });
  });

  // ── 公司資料（顯示用，1:1 對應 customerId，不回寫訂單）───────────────────
  router.put('/customers/:customerId/company', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const hasAnyField = ['companyName', 'taxId', 'invoiceTitle'].some(k => Object.prototype.hasOwnProperty.call(body, k));
    if (!hasAnyField) {
      return res.status(400).json({ error: '至少需要提供 companyName／taxId／invoiceTitle 其中一項' });
    }
    const { errors, result } = validateCustomerCompanyInput(body);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });

    const now = new Date().toISOString();
    const existing = db.prepare('SELECT * FROM customer_companies WHERE customer_id = ?').get(primaryId);
    const companyName  = ('companyName'  in result) ? (result.companyName  || null) : (existing ? existing.company_name  : null);
    const taxId         = ('taxId'        in result) ? (result.taxId        || null) : (existing ? existing.tax_id        : null);
    const invoiceTitle  = ('invoiceTitle' in result) ? (result.invoiceTitle || null) : (existing ? existing.invoice_title : null);

    db.prepare(`
      INSERT INTO customer_companies (customer_id, company_name, tax_id, invoice_title, updated_at, updated_by)
      VALUES (?, ?, ?, ?, ?, 'admin')
      ON CONFLICT(customer_id) DO UPDATE SET
        company_name  = excluded.company_name,
        tax_id        = excluded.tax_id,
        invoice_title = excluded.invoice_title,
        updated_at    = excluded.updated_at,
        updated_by    = excluded.updated_by
    `).run(primaryId, companyName, taxId, invoiceTitle, now);

    touchCustomerIdentities(customer);

    res.json({ success: true, company: getMergedCompany(primaryId, getMergedGroupMemberIds(primaryId)) });
  });

  // ── 收件地址：可多筆，任何時間最多一筆預設 ────────────────────────────────
  // 地址本身的 id 是全資料庫唯一（AUTOINCREMENT），合併後不需要靠 customer_id 才能定位到
  // 正確的那一筆，只需要另外確認這筆地址「原本掛在哪個 customer_id」確實屬於目前這個合併
  // 群組（isInMergedGroup），避免跨群組誤操作到完全無關客戶的地址。
  function loadAddressById(addressId) {
    if (!Number.isInteger(addressId)) return null;
    return db.prepare('SELECT * FROM customer_addresses WHERE id = ?').get(addressId) || null;
  }

  router.post('/customers/:customerId/addresses', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const { errors, result } = validateCustomerAddressInput(body, true);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });

    const now = new Date().toISOString();
    const wantDefault = result.isDefault === true;
    const memberIds = getMergedGroupMemberIds(primaryId);

    // 新增地址若同時設為預設，必須跟「清除舊預設」放在同一個 transaction：任何一步失敗都
    // 整批回滾，確保任何時候最多只有一筆預設地址，不會出現中途失敗留下兩筆預設或完全沒有
    // 預設的中間狀態。清除範圍涵蓋整個合併群組的所有 member（不只主要客戶自己），確保合併
    // 後的地址清單也不會同時顯示兩筆預設地址；新增的地址一律直接寫在主要客戶自己的
    // customer_id 底下（往後新增的資料統一收斂到主要客戶，方便管理）。
    const createTx = db.transaction(() => {
      if (wantDefault) {
        const placeholders = memberIds.map(() => '?').join(',');
        db.prepare(`UPDATE customer_addresses SET is_default = 0, updated_at = ? WHERE customer_id IN (${placeholders}) AND is_default = 1`)
          .run(now, ...memberIds);
      }
      const info = db.prepare(`
        INSERT INTO customer_addresses (customer_id, recipient_name, phone, postal_code, address, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(primaryId, result.recipientName, result.phone || null, result.postalCode || null, result.address, wantDefault ? 1 : 0, now, now);
      return info.lastInsertRowid;
    });
    const newId = createTx();

    touchCustomerIdentities(customer);

    res.status(201).json({ success: true, addressId: newId, addresses: getMergedAddresses(primaryId, memberIds) });
  });

  router.put('/customers/:customerId/addresses/:addressId', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const addressId = parseInt(req.params.addressId, 10);
    if (!Number.isInteger(addressId)) return res.status(400).json({ error: '地址編號格式不正確' });
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });
    const existing = loadAddressById(addressId);
    if (!existing || !isInMergedGroup(existing.customer_id, primaryId)) return res.status(404).json({ error: '找不到此收件地址' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const hasAnyField = ['recipientName', 'phone', 'postalCode', 'address', 'isDefault'].some(k => Object.prototype.hasOwnProperty.call(body, k));
    if (!hasAnyField) return res.status(400).json({ error: '至少需要提供一項要更新的欄位' });
    const { errors, result } = validateCustomerAddressInput(body, false);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });

    const now = new Date().toISOString();
    const recipientName = ('recipientName' in result) ? result.recipientName : existing.recipient_name;
    const phone          = ('phone'         in result) ? (result.phone || null) : existing.phone;
    const postalCode     = ('postalCode'    in result) ? (result.postalCode || null) : existing.postal_code;
    const address         = ('address'       in result) ? result.address       : existing.address;
    const wantDefault = ('isDefault' in result) ? result.isDefault : null; // null＝這次沒有要求變動預設狀態
    const memberIds = getMergedGroupMemberIds(primaryId);

    // 這筆地址本身保留在原本的 customer_id（existing.customer_id）底下更新——合併／解除合併
    // 從頭到尾不搬動任何一筆既有資料，只有「設為預設」這個明確的使用者動作，才會連動清除
    // 同一個合併群組內其他 member 的舊預設（範圍是整個群組，不只 existing.customer_id 自己）。
    const updateTx = db.transaction(() => {
      if (wantDefault === true) {
        const placeholders = memberIds.map(() => '?').join(',');
        db.prepare(`UPDATE customer_addresses SET is_default = 0, updated_at = ? WHERE customer_id IN (${placeholders}) AND is_default = 1 AND id != ?`)
          .run(now, ...memberIds, addressId);
      }
      const isDefaultValue = (wantDefault === null) ? existing.is_default : (wantDefault ? 1 : 0);
      db.prepare(`
        UPDATE customer_addresses SET
          recipient_name = ?, phone = ?, postal_code = ?, address = ?, is_default = ?, updated_at = ?
        WHERE id = ? AND customer_id = ?
      `).run(recipientName, phone, postalCode, address, isDefaultValue, now, addressId, existing.customer_id);
    });
    updateTx();

    touchCustomerIdentities(customer);

    res.json({ success: true, addresses: getMergedAddresses(primaryId, memberIds) });
  });

  router.delete('/customers/:customerId/addresses/:addressId', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const addressId = parseInt(req.params.addressId, 10);
    if (!Number.isInteger(addressId)) return res.status(400).json({ error: '地址編號格式不正確' });
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });
    const existing = loadAddressById(addressId);
    if (!existing || !isInMergedGroup(existing.customer_id, primaryId)) return res.status(404).json({ error: '找不到此收件地址' });

    db.prepare('DELETE FROM customer_addresses WHERE id = ? AND customer_id = ?').run(addressId, existing.customer_id);

    res.json({ success: true, addresses: getMergedAddresses(primaryId, getMergedGroupMemberIds(primaryId)) });
  });

  // ── 客戶標籤：只能新增／移除，不提供修改文字的 API ─────────────────────────
  // 提供給前端篩選下拉選單使用：列出目前實際被使用過的所有標籤（不分客戶）。刻意放在
  // `/customer-tags`（不是 `/customers/...`），避免跟 `/customers/:customerId` 這條既有路由
  // 的路徑規則混淆。維持統計原始資料表（不做合併去重），單純是篩選下拉選單的候選清單，
  // 不影響任何篩選或顯示邏輯本身的正確性。
  router.get('/customer-tags', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const rows = db.prepare(
      'SELECT tag, COUNT(*) AS c FROM customer_tags GROUP BY tag ORDER BY tag ASC'
    ).all();
    res.json({ success: true, tags: rows.map(r => ({ tag: r.tag, count: r.c })) });
  });

  router.post('/customers/:customerId/tags', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });

    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const result = validateCustomerTagInput(body);
    if (result.error) return res.status(400).json({ error: result.error });

    const memberIds = getMergedGroupMemberIds(primaryId);
    const mergedTags = getMergedTags(primaryId, memberIds);
    if (mergedTags.length >= TAG_MAX_COUNT) {
      return res.status(400).json({ error: `每位客戶最多只能加 ${TAG_MAX_COUNT} 個標籤` });
    }
    if (mergedTags.some(t => t.tag === result.tag)) {
      return res.status(400).json({ error: '這個標籤已經加過了' });
    }

    const now = new Date().toISOString();
    const info = db.prepare('INSERT INTO customer_tags (customer_id, tag, created_at) VALUES (?, ?, ?)')
      .run(primaryId, result.tag, now);

    touchCustomerIdentities(customer);

    res.status(201).json({
      success: true,
      tag: { id: info.lastInsertRowid, tag: result.tag, createdAt: now, ownerCustomerId: primaryId },
      tags: getMergedTags(primaryId, memberIds)
    });
  });

  router.delete('/customers/:customerId/tags/:tagId', requirePermission('customers', 'write'), csrfProtection, (req, res) => {
    const primaryId = resolvePrimaryCustomerId(req.params.customerId);
    const tagId = parseInt(req.params.tagId, 10);
    if (!Number.isInteger(tagId)) return res.status(400).json({ error: '標籤編號格式不正確' });
    const customer = loadCustomerOrNull(primaryId);
    if (!customer) return res.status(404).json({ error: '找不到此客戶' });
    const existing = db.prepare('SELECT * FROM customer_tags WHERE id = ?').get(tagId);
    if (!existing || !isInMergedGroup(existing.customer_id, primaryId)) return res.status(404).json({ error: '找不到此標籤' });

    db.prepare('DELETE FROM customer_tags WHERE id = ? AND customer_id = ?').run(tagId, existing.customer_id);

    res.json({ success: true, tags: getMergedTags(primaryId, getMergedGroupMemberIds(primaryId)) });
  });

  // ══════════════ 重複客戶偵測、合併預覽、執行合併、解除合併 ══════════════
  router.get('/customer-merge-candidates', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    res.json({ success: true, candidates: detectMergeCandidates() });
  });

  router.get('/customer-merge-preview', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const primaryArg = (req.query.primaryId || '').toString().trim();
    const mergedArg = (req.query.mergedId || '').toString().trim();
    if (!primaryArg || !mergedArg) {
      return res.status(400).json({ error: 'primaryId 與 mergedId 皆為必填' });
    }
    if (!loadCustomerOrNull(primaryArg)) return res.status(404).json({ error: '找不到主要客戶' });
    if (!loadCustomerOrNull(mergedArg)) return res.status(404).json({ error: '找不到被合併客戶' });

    const resolvedPrimary = resolvePrimaryCustomerId(primaryArg);
    const resolvedMerged = resolvePrimaryCustomerId(mergedArg);
    if (resolvedPrimary === resolvedMerged) {
      return res.json({
        success: true, valid: false,
        reason: '這兩位客戶目前已經屬於同一個合併群組（或本來就是同一位），無法合併',
        primary: null, merged: null
      });
    }

    const primaryDetail = buildFullCustomerDetail(resolvedPrimary);
    const mergedDetail = buildFullCustomerDetail(resolvedMerged);
    res.json({
      success: true,
      valid: true,
      primary: { ...primaryDetail, notes: getMergedNotes(getMergedGroupMemberIds(resolvedPrimary)) },
      merged: { ...mergedDetail, notes: getMergedNotes(getMergedGroupMemberIds(resolvedMerged)) }
    });
  });

  router.post('/customer-merges', requirePermission('customer_merge', 'write'), csrfProtection, (req, res) => {
    const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {};
    const primaryArg = body.primaryCustomerId;
    const mergedArg = body.mergedCustomerId;
    if (typeof primaryArg !== 'string' || !primaryArg.trim() || typeof mergedArg !== 'string' || !mergedArg.trim()) {
      return res.status(400).json({ error: 'primaryCustomerId 與 mergedCustomerId 皆為必填字串' });
    }
    // 伺服器端的最後一道防線：即使前端沒有正確走完預覽＋二次確認流程，這裡也一定要求
    // 明確的 acknowledged:true 才會真的執行，避免任何腳本化或誤觸的請求直接生效。
    if (body.acknowledged !== true) {
      return res.status(400).json({ error: '必須明確確認合併（acknowledged 需為 true）' });
    }

    const primaryRaw = loadCustomerOrNull(primaryArg);
    if (!primaryRaw) return res.status(404).json({ error: '找不到主要客戶' });
    const mergedRaw = loadCustomerOrNull(mergedArg);
    if (!mergedRaw) return res.status(404).json({ error: '找不到被合併客戶' });

    const resolvedPrimary = resolvePrimaryCustomerId(primaryArg);
    const resolvedMerged = resolvePrimaryCustomerId(mergedArg);
    if (resolvedPrimary === resolvedMerged) {
      return res.status(400).json({ error: '相同客戶不可互相合併，這兩位客戶目前也已經屬於同一個合併群組' });
    }

    // 合併前的完整快照（雙方基本資料／訂單統計／公司／地址／標籤／備註），寫入
    // before_summary_json 留存，滿足「保存合併前摘要」的稽核需求。
    const beforeSummary = {
      primary: { ...buildFullCustomerDetail(resolvedPrimary), notes: getMergedNotes(getMergedGroupMemberIds(resolvedPrimary)) },
      merged: { ...buildFullCustomerDetail(resolvedMerged), notes: getMergedNotes(getMergedGroupMemberIds(resolvedMerged)) }
    };
    const now = new Date().toISOString();

    const mergeTx = db.transaction(() => {
      // 扁平化重新掛載：任何原本指向「被合併客戶」的生效中合併關係，一律直接改指向新的
      // 主要客戶，維持「primary_customer_id 絕不會同時是另一筆生效中列的 alias_customer_id」
      // 這個不變量（見 db.js migration 註解），確保 resolvePrimaryCustomerId() 永遠只需要查表
      // 一次，天生不會出現循環合併。
      db.prepare('UPDATE customer_merges SET primary_customer_id = ? WHERE primary_customer_id = ? AND unmerged_at IS NULL')
        .run(resolvedPrimary, resolvedMerged);
      const info = db.prepare(`
        INSERT INTO customer_merges (alias_customer_id, primary_customer_id, actor, created_at, before_summary_json)
        VALUES (?, ?, 'admin', ?, ?)
      `).run(resolvedMerged, resolvedPrimary, now, JSON.stringify(beforeSummary));
      return info.lastInsertRowid;
    });
    const mergeId = mergeTx();

    // customer_identities 本來就是為這個階段預留的稽核資料（見 db.js 說明）：把被合併客戶
    // 自己的識別字串也記一份在主要客戶身上，方便之後追查「這個 Email／電話曾經在哪個
    // customerId 底下出現過」。
    const mergedRawFresh = loadCustomerOrNull(resolvedMerged);
    if (mergedRawFresh) {
      const keys = new Set(mergedRawFresh.orders.map(o => buildCustomerKey(o)));
      keys.forEach(k => insertCustomerIdentity.run(resolvedPrimary, k, now));
    }
    const primaryRawFresh = loadCustomerOrNull(resolvedPrimary);
    if (primaryRawFresh) touchCustomerIdentities(primaryRawFresh);

    res.status(201).json({
      success: true,
      mergeId,
      primaryCustomerId: resolvedPrimary,
      mergedCustomerId: resolvedMerged,
      customer: buildFullCustomerDetail(resolvedPrimary)
    });
  });

  router.get('/customer-merges', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const rows = db.prepare('SELECT * FROM customer_merges ORDER BY created_at DESC, id DESC').all();
    res.json({
      success: true,
      merges: rows.map(r => ({
        id: r.id,
        aliasCustomerId: r.alias_customer_id,
        primaryCustomerId: r.primary_customer_id,
        actor: r.actor,
        createdAt: r.created_at,
        unmergedAt: r.unmerged_at,
        unmergedBy: r.unmerged_by,
        active: !r.unmerged_at
      }))
    });
  });

  router.get('/customer-merges/:mergeId', requirePermission('customers', 'view'), csrfProtection, (req, res) => {
    const mergeId = parseInt(req.params.mergeId, 10);
    if (!Number.isInteger(mergeId)) return res.status(400).json({ error: '合併紀錄編號格式不正確' });
    const row = db.prepare('SELECT * FROM customer_merges WHERE id = ?').get(mergeId);
    if (!row) return res.status(404).json({ error: '找不到此合併紀錄' });
    let beforeSummary = null;
    try { beforeSummary = JSON.parse(row.before_summary_json); } catch { /* 舊資料格式異常時安全忽略 */ }
    res.json({
      success: true,
      merge: {
        id: row.id,
        aliasCustomerId: row.alias_customer_id,
        primaryCustomerId: row.primary_customer_id,
        actor: row.actor,
        createdAt: row.created_at,
        unmergedAt: row.unmerged_at,
        unmergedBy: row.unmerged_by,
        active: !row.unmerged_at,
        beforeSummary
      }
    });
  });

  // 解除合併只是讓「這一筆合併關係」失效，被合併客戶的訂單／備註／公司資料／地址／標籤
  // 從頭到尾都還留在自己原本的 customer_id 底下（合併過程完全沒有搬動過），因此保證不會
  // 遺失任何資料；如果這筆合併之後，又有其他客戶因為扁平化重新掛載而直接指向同一個主要
  // 客戶，解除這一筆不會連鎖影響那些各自獨立的合併紀錄，需要各自分別解除。
  router.post('/customer-merges/:mergeId/unmerge', requirePermission('customer_merge', 'write'), csrfProtection, (req, res) => {
    const mergeId = parseInt(req.params.mergeId, 10);
    if (!Number.isInteger(mergeId)) return res.status(400).json({ error: '合併紀錄編號格式不正確' });
    const row = db.prepare('SELECT * FROM customer_merges WHERE id = ?').get(mergeId);
    if (!row) return res.status(404).json({ error: '找不到此合併紀錄' });
    if (row.unmerged_at) return res.status(400).json({ error: '這筆合併紀錄已經解除過了' });

    const now = new Date().toISOString();
    db.prepare('UPDATE customer_merges SET unmerged_at = ?, unmerged_by = ? WHERE id = ?').run(now, 'admin', mergeId);

    res.json({ success: true, mergeId, unmergedAt: now });
  });

  // ══════════ 網站內容設定（第一階段：公告開關／公告文字／聯絡Email／聯絡電話／頁尾文字）══════════
  // site_settings 是單一列設定表（id 固定為1，見 db.js 的 CHECK (id = 1)），這裡只讀寫這一列，
  // 不提供新增或刪除列的操作。GET /api/site-settings（公開、無需登入）只回傳這裡五個欄位的子集
  // （見 server.js），不會回傳 updated_at／updated_by 這類管理資訊。
  const SITE_SETTINGS_FIELDS = ['announcementEnabled', 'announcementText', 'contactEmail', 'contactPhone', 'footerText'];
  const SITE_SETTINGS_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function getSiteSettingsRow() {
    return db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  }
  function rowToSiteSettings(row) {
    return {
      announcementEnabled: !!row.announcement_enabled,
      announcementText: row.announcement_text,
      contactEmail: row.contact_email,
      contactPhone: row.contact_phone,
      footerText: row.footer_text,
      updatedAt: row.updated_at
    };
  }

  router.get('/site-settings', requirePermission('site_settings', 'view'), csrfProtection, (req, res) => {
    const row = getSiteSettingsRow();
    if (!row) return res.status(500).json({ error: '網站設定尚未初始化，請確認資料庫 migration 是否已執行' });
    res.json({ success: true, settings: rowToSiteSettings(row) });
  });

  // 驗證失敗一律回傳400、完全不寫入任何資料（先把五個欄位全部驗證過，最後才用單一次
  // UPDATE 寫入，不可能出現「驗證到一半失敗、但已經寫入部分欄位」的情況）。只接受這五個
  // 固定欄位、缺一不可、也不接受任何多餘欄位——這是一份完整表單提交，不是局部更新。
  router.put('/site-settings', requirePermission('site_settings', 'write'), csrfProtection, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: '請求內容格式不正確' });
    }
    const bodyKeys = Object.keys(body);
    const extraKeys = bodyKeys.filter(k => !SITE_SETTINGS_FIELDS.includes(k));
    if (extraKeys.length > 0) {
      return res.status(400).json({ error: `不接受未知欄位：${extraKeys.join('、')}` });
    }
    const missingKeys = SITE_SETTINGS_FIELDS.filter(k => !bodyKeys.includes(k));
    if (missingKeys.length > 0) {
      return res.status(400).json({ error: `缺少必要欄位：${missingKeys.join('、')}` });
    }

    const { announcementEnabled, announcementText, contactEmail, contactPhone, footerText } = body;

    if (typeof announcementEnabled !== 'boolean') {
      return res.status(400).json({ error: 'announcementEnabled 必須是布林值（true／false）' });
    }
    if (typeof announcementText !== 'string' || announcementText.length > 500) {
      return res.status(400).json({ error: 'announcementText 必須是字串，且長度不可超過500字' });
    }
    if (typeof contactEmail !== 'string' || (contactEmail !== '' && !SITE_SETTINGS_EMAIL_RE.test(contactEmail))) {
      return res.status(400).json({ error: 'contactEmail 必須是合法的Email格式，或留白' });
    }
    if (typeof contactPhone !== 'string' || contactPhone.length > 30) {
      return res.status(400).json({ error: 'contactPhone 必須是字串，且長度不可超過30字' });
    }
    // 空白（trim後為空字串）視為「尚未設定」，允許儲存；非空白時必須至少包含一個數字，否則
    // 前台無法從這段文字組出安全的tel:連結，會出現「畫面顯示這段文字、點擊卻撥打舊電話」的
    // 顯示與實際撥號不一致（例如「客服專線」「---」「ext」這種完全沒有數字的內容）。
    if (contactPhone.trim() !== '' && !/\d/.test(contactPhone)) {
      return res.status(400).json({ error: 'contactPhone 非空白時必須至少包含一個數字' });
    }
    if (typeof footerText !== 'string' || footerText.length > 200) {
      return res.status(400).json({ error: 'footerText 必須是字串，且長度不可超過200字' });
    }

    const now = new Date().toISOString();
    db.prepare(`
      UPDATE site_settings SET
        announcement_enabled = ?, announcement_text = ?, contact_email = ?, contact_phone = ?, footer_text = ?,
        updated_at = ?, updated_by = 'admin'
      WHERE id = 1
    `).run(announcementEnabled ? 1 : 0, announcementText, contactEmail, contactPhone, footerText, now);

    res.json({ success: true, settings: rowToSiteSettings(getSiteSettingsRow()) });
  });

  // ══════════ AI 功能設定（四項既有 AI 功能的開關／模型／五段主要固定提示詞）══════════
  // ai_feature_settings／ai_prompt_settings 皆為固定代碼的小型設定表（見 db.js migration），
  // 這裡的驗證只允許操作 migration 時建立好的既有代碼，不提供新增／刪除功能或提示詞代碼的
  // API——要新增第五個 AI 功能，需要另外寫一支新的 migration 與對應路由，不是這裡的職責。
  // 絕對不可以在這支路由的任何回應（GET／PUT）中帶出 OPENAI_API_KEY 或其他環境變數。
  const AI_FEATURE_KEYS = ['generate_image', 'generate_design', 'black_card_pattern', 'cartoon_image'];
  // 2026-08-24：dall-e-3 已被 OpenAI 官方下架、gpt-image-1 已被官方列為 Deprecated，三支
  // 圖片功能統一改用官方目前建議的 gpt-image-2（詳見 db.js AI_FEATURE_DEFAULTS 上方註解）。
  const AI_FEATURE_MODEL_WHITELIST = {
    generate_image:     ['gpt-image-2'],
    generate_design:    ['gpt-4o-mini'],
    black_card_pattern: ['gpt-image-2'],
    cartoon_image:       ['gpt-image-2']
  };
  const AI_PROMPT_KEYS = ['generate_image_main', 'generate_design_system', 'black_card_pattern_system', 'cartoon_image_base', 'cartoon_image_black_card'];
  const AI_PROMPT_KEY_FEATURE_MAP = {
    generate_image_main:       'generate_image',
    generate_design_system:    'generate_design',
    black_card_pattern_system: 'black_card_pattern',
    cartoon_image_base:        'cartoon_image',
    cartoon_image_black_card:  'cartoon_image'
  };
  // 只有這兩段提示詞在送出前會被 server.js 用 {{...}} 佔位符代換成實際內容（見 server.js
  // 四支 AI 路由），缺少任一必要佔位符就沒辦法正確代換，因此存檔時強制要求存在。其餘三段
  // 提示詞不含需要代換的佔位符，不列在這裡即代表沒有必要佔位符限制。
  const AI_PROMPT_REQUIRED_PLACEHOLDERS = {
    generate_image_main:       ['{{PRODUCT_NAME}}', '{{USER_INPUT}}'],
    black_card_pattern_system: ['{{USER_INPUT}}', '{{STYLE_PROMPT}}']
  };
  const AI_PROMPT_MAX_LENGTH = 10000;

  router.get('/ai-settings', requirePermission('ai_settings', 'view'), csrfProtection, (req, res) => {
    res.json({
      success: true,
      features: getAllAiFeatureSettings(),
      prompts: getAllAiPromptSettings()
    });
  });

  // 採「完整設定提交」：四項功能、五段提示詞缺一不可，也不接受多餘或重複的代碼。
  // 逐項驗證全部通過後，才用單一 transaction 一次寫入；任何一項驗證失敗，資料庫完全不變。
  router.put('/ai-settings', requirePermission('ai_settings', 'write'), csrfProtection, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: '請求內容格式不正確' });
    }
    const topKeys = Object.keys(body);
    const extraTopKeys = topKeys.filter(k => !['features', 'prompts'].includes(k));
    if (extraTopKeys.length > 0) {
      return res.status(400).json({ error: `不接受未知欄位：${extraTopKeys.join('、')}` });
    }
    if (!Array.isArray(body.features) || !Array.isArray(body.prompts)) {
      return res.status(400).json({ error: 'features 與 prompts 都必須是陣列' });
    }

    if (body.features.length !== AI_FEATURE_KEYS.length) {
      return res.status(400).json({ error: `features 必須剛好包含 ${AI_FEATURE_KEYS.length} 項功能` });
    }
    const seenFeatureKeys = new Set();
    const normalizedFeatures = [];
    for (const f of body.features) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        return res.status(400).json({ error: 'features 內容格式不正確' });
      }
      const fKeys = Object.keys(f);
      const extraFKeys = fKeys.filter(k => !['featureKey', 'enabled', 'model'].includes(k));
      if (extraFKeys.length > 0) {
        return res.status(400).json({ error: `features 不接受未知欄位：${extraFKeys.join('、')}` });
      }
      const missingFKeys = ['featureKey', 'enabled', 'model'].filter(k => !fKeys.includes(k));
      if (missingFKeys.length > 0) {
        return res.status(400).json({ error: `features 缺少必要欄位：${missingFKeys.join('、')}` });
      }
      if (typeof f.featureKey !== 'string' || !AI_FEATURE_KEYS.includes(f.featureKey)) {
        return res.status(400).json({ error: `未知的 featureKey：${f.featureKey}` });
      }
      if (seenFeatureKeys.has(f.featureKey)) {
        return res.status(400).json({ error: `featureKey 重複：${f.featureKey}` });
      }
      seenFeatureKeys.add(f.featureKey);
      if (typeof f.enabled !== 'boolean') {
        return res.status(400).json({ error: `${f.featureKey} 的 enabled 必須是布林值` });
      }
      const allowedModels = AI_FEATURE_MODEL_WHITELIST[f.featureKey];
      if (typeof f.model !== 'string' || !allowedModels.includes(f.model)) {
        return res.status(400).json({ error: `${f.featureKey} 的 model 必須是下列其中之一：${allowedModels.join('、')}` });
      }
      normalizedFeatures.push({ featureKey: f.featureKey, enabled: f.enabled, model: f.model });
    }
    const missingFeatureKeys = AI_FEATURE_KEYS.filter(k => !seenFeatureKeys.has(k));
    if (missingFeatureKeys.length > 0) {
      return res.status(400).json({ error: `缺少功能設定：${missingFeatureKeys.join('、')}` });
    }

    if (body.prompts.length !== AI_PROMPT_KEYS.length) {
      return res.status(400).json({ error: `prompts 必須剛好包含 ${AI_PROMPT_KEYS.length} 段提示詞` });
    }
    const seenPromptKeys = new Set();
    const normalizedPrompts = [];
    for (const p of body.prompts) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) {
        return res.status(400).json({ error: 'prompts 內容格式不正確' });
      }
      const pKeys = Object.keys(p);
      const extraPKeys = pKeys.filter(k => !['promptKey', 'content'].includes(k));
      if (extraPKeys.length > 0) {
        return res.status(400).json({ error: `prompts 不接受未知欄位：${extraPKeys.join('、')}` });
      }
      const missingPKeys = ['promptKey', 'content'].filter(k => !pKeys.includes(k));
      if (missingPKeys.length > 0) {
        return res.status(400).json({ error: `prompts 缺少必要欄位：${missingPKeys.join('、')}` });
      }
      if (typeof p.promptKey !== 'string' || !AI_PROMPT_KEYS.includes(p.promptKey)) {
        return res.status(400).json({ error: `未知的 promptKey：${p.promptKey}` });
      }
      if (seenPromptKeys.has(p.promptKey)) {
        return res.status(400).json({ error: `promptKey 重複：${p.promptKey}` });
      }
      seenPromptKeys.add(p.promptKey);
      if (typeof p.content !== 'string' || p.content.trim() === '') {
        return res.status(400).json({ error: `${p.promptKey} 的 content 必須是非空白字串` });
      }
      if (p.content.length > AI_PROMPT_MAX_LENGTH) {
        return res.status(400).json({ error: `${p.promptKey} 的 content 長度不可超過 ${AI_PROMPT_MAX_LENGTH} 字` });
      }
      const requiredPlaceholders = AI_PROMPT_REQUIRED_PLACEHOLDERS[p.promptKey] || [];
      const missingPlaceholders = requiredPlaceholders.filter(ph => !p.content.includes(ph));
      if (missingPlaceholders.length > 0) {
        return res.status(400).json({ error: `${p.promptKey} 缺少必要佔位符：${missingPlaceholders.join('、')}` });
      }
      normalizedPrompts.push({ promptKey: p.promptKey, content: p.content });
    }
    const missingPromptKeys = AI_PROMPT_KEYS.filter(k => !seenPromptKeys.has(k));
    if (missingPromptKeys.length > 0) {
      return res.status(400).json({ error: `缺少提示詞設定：${missingPromptKeys.join('、')}` });
    }

    // 全部驗證通過才用單一 transaction 一次寫入九列（四項功能＋五段提示詞），任一欄位失敗
    // 都會在上面提早 return，不可能執行到這裡、也不可能只寫入其中一部分。
    const now = new Date().toISOString();
    const updateFeature = db.prepare(`UPDATE ai_feature_settings SET enabled = ?, model = ?, updated_at = ?, updated_by = 'admin' WHERE feature_key = ?`);
    const updatePrompt = db.prepare(`UPDATE ai_prompt_settings SET content = ?, updated_at = ?, updated_by = 'admin' WHERE prompt_key = ?`);
    const writeAiSettings = db.transaction(() => {
      normalizedFeatures.forEach(f => updateFeature.run(f.enabled ? 1 : 0, f.model, now, f.featureKey));
      normalizedPrompts.forEach(p => updatePrompt.run(p.content, now, p.promptKey));
    });
    writeAiSettings();

    res.json({
      success: true,
      features: getAllAiFeatureSettings(),
      prompts: getAllAiPromptSettings()
    });
  });

  // ══════════ 系統設定（正式功能第一批：全域「預設報價有效天數」＋唯讀系統資訊）══════════
  // 本批只提供一項真正可修改的全域設定：quoteDefaultValidDays（見 db.js 的 system_settings
  // 資料表，單一列設計，跟 site_settings 同一套慣例）。其餘系統資訊（健康狀態、資料庫完整性、
  // 伺服器時間、時區、運行時間、Session有效時間、維護模式、應用程式版本）全部是唯讀，這裡
  // 完全不提供任何修改這些資訊本身的API——它們是「觀察目前系統狀態」，不是「設定」。
  // 只有owner可以查看或修改，跟admin_users、db_backup同一等級的保護（見admin-rbac.js）。
  const SYSTEM_SETTINGS_FIELDS = ['quoteDefaultValidDays'];
  const SYSTEM_SETTINGS_QUOTE_DAYS_MIN = 1;
  const SYSTEM_SETTINGS_QUOTE_DAYS_MAX = 365;

  function getSystemSettingsRow() {
    return db.prepare('SELECT * FROM system_settings WHERE id = 1').get();
  }
  function rowToSystemSettings(row) {
    return { quoteDefaultValidDays: row.quote_default_valid_days, updatedAt: row.updated_at };
  }

  // 應用程式版本：唯一可靠來源是 package.json 的 version 欄位（跟 server.js 啟動時實際載入
  // 的是同一份 package.json），伺服器啟動時讀取一次並快取，不會每次請求都重新讀檔案；
  // 讀取失敗或欄位缺漏時明確回傳null，前端顯示「未設定」，絕不自行捏造版本號。
  let cachedAppVersion = null;
  try {
    const pkg = require('./package.json');
    cachedAppVersion = (pkg && typeof pkg.version === 'string' && pkg.version.trim()) ? pkg.version.trim() : null;
  } catch (e) {
    cachedAppVersion = null;
  }

  // 資料庫完整性檢查快取：PRAGMA integrity_check 會掃描整個資料庫檔案，隨資料量成長成本
  // 會愈來愈高，不適合每次GET /system-settings（每次打開頁面、每次重新整理）都自動執行一次。
  // 這裡改成GET只回傳「上一次手動檢查」的快取結果（伺服器剛啟動、還沒有人手動檢查過時是
  // status:'not_checked'），真正執行檢查由管理員按下頁面上的「重新檢查」按鈕，呼叫獨立的
  // POST /system-settings/check-integrity觸發。快取只存在目前執行中的Node行程記憶體
  // （跟maintenance-mode.js的maintenanceMode旗標同一套設計慣例），伺服器重啟後自動變回
  // 「尚未檢查」，不需要另外持久化或提供清除功能。
  let lastDbIntegrityCheck = { status: 'not_checked', checkedAt: null };
  function runDbIntegrityCheck() {
    try {
      const rows = db.pragma('integrity_check');
      const ok = Array.isArray(rows) && rows.length === 1 && rows[0] && rows[0].integrity_check === 'ok';
      lastDbIntegrityCheck = { status: ok ? 'ok' : 'error', checkedAt: new Date().toISOString() };
    } catch (e) {
      lastDbIntegrityCheck = { status: 'error', checkedAt: new Date().toISOString() };
    }
    return lastDbIntegrityCheck;
  }

  // 系統健康狀態：沿用公開 GET /api/health 完全相同的判斷方式（只做一個最簡單的SELECT確認
  // DB檔案本身還能正常讀取），成本極低，可以放心每次GET都檢查一次，不需要另外快取。
  function checkSystemHealthy() {
    try { db.prepare('SELECT 1').get(); return true; } catch (e) { return false; }
  }

  function buildSystemInfo() {
    return {
      healthy: checkSystemHealthy(),
      dbIntegrity: lastDbIntegrityCheck,
      serverTime: new Date().toISOString(),
      timezone: 'Asia/Taipei',
      uptimeSeconds: Math.floor(process.uptime()),
      sessionTtlHours: adminSessionTtlHours,
      maintenanceMode: isMaintenanceMode(),
      appVersion: cachedAppVersion
    };
  }

  router.get('/system-settings', requirePermission('system_settings', 'view'), csrfProtection, (req, res) => {
    const row = getSystemSettingsRow();
    if (!row) return res.status(500).json({ error: '系統設定尚未初始化，請確認資料庫 migration 是否已執行' });
    res.json({ success: true, settings: rowToSystemSettings(row), systemInfo: buildSystemInfo() });
  });

  // 驗證失敗一律回傳400、完全不寫入任何資料。只接受這一個固定欄位、不接受任何多餘欄位——
  // 這是一份完整表單提交，不是局部更新（跟site-settings同一套慣例，即使本批只有一個欄位）。
  // 型別驗證刻意嚴格：只接受真正的number型別且是安全整數，不用Number()做任何隱性轉換，
  // 字串"30"、null、陣列、物件、NaN、小數全部直接拒絕，不會被靜默接受成看似合法的整數。
  router.put('/system-settings', requirePermission('system_settings', 'write'), csrfProtection, (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: '請求內容格式不正確' });
    }
    const bodyKeys = Object.keys(body);
    const extraKeys = bodyKeys.filter(k => !SYSTEM_SETTINGS_FIELDS.includes(k));
    if (extraKeys.length > 0) {
      return res.status(400).json({ error: `不接受未知欄位：${extraKeys.join('、')}` });
    }
    const missingKeys = SYSTEM_SETTINGS_FIELDS.filter(k => !bodyKeys.includes(k));
    if (missingKeys.length > 0) {
      return res.status(400).json({ error: `缺少必要欄位：${missingKeys.join('、')}` });
    }

    const { quoteDefaultValidDays } = body;
    if (
      typeof quoteDefaultValidDays !== 'number' ||
      !Number.isFinite(quoteDefaultValidDays) ||
      !Number.isInteger(quoteDefaultValidDays) ||
      quoteDefaultValidDays < SYSTEM_SETTINGS_QUOTE_DAYS_MIN ||
      quoteDefaultValidDays > SYSTEM_SETTINGS_QUOTE_DAYS_MAX
    ) {
      return res.status(400).json({ error: `quoteDefaultValidDays 必須是 ${SYSTEM_SETTINGS_QUOTE_DAYS_MIN}～${SYSTEM_SETTINGS_QUOTE_DAYS_MAX} 之間的整數` });
    }

    const now = new Date().toISOString();
    const writeSystemSettings = db.transaction(() => {
      db.prepare(`UPDATE system_settings SET quote_default_valid_days = ?, updated_at = ?, updated_by = 'admin' WHERE id = 1`).run(quoteDefaultValidDays, now);
    });
    writeSystemSettings();

    res.json({ success: true, settings: rowToSystemSettings(getSystemSettingsRow()) });
  });

  // 手動重新檢查資料庫完整性：獨立動作，不是「設定」，刻意跟system_settings的view/write
  // 分開登記權限（見admin-rbac.js），單純打開系統設定頁（view）不會意外觸發這個成本較高
  // 的PRAGMA integrity_check。
  router.post('/system-settings/check-integrity', requirePermission('system_settings', 'check_integrity'), csrfProtection, (req, res) => {
    const result = runDbIntegrityCheck();
    res.json({ success: true, dbIntegrity: result });
  });

  // 報價預設有效天數（唯讀，供訂單詳情頁「發布新報價版本」表單使用）：quoteDefaultValidDays
  // 本身儲存在system_settings（只有owner能修改），但四個角色都可能需要在訂單詳情頁發布報價
  // 版本（見PERMISSIONS.orders.write包含owner／manager／staff），因此另外開這個極小範圍的
  // 唯讀端點，只回傳一個非敏感整數，不受system_settings的owner限定，也不會回傳
  // system_settings的其他任何欄位或系統資訊（見admin-rbac.js quote_defaults的說明）。
  router.get('/quote-defaults', requirePermission('quote_defaults', 'view'), csrfProtection, (req, res) => {
    const row = getSystemSettingsRow();
    const defaultValidDays = row ? row.quote_default_valid_days : 30;
    res.json({ success: true, defaultValidDays });
  });

  // ══════════ 後台快速搜尋（頂部搜尋框，正式功能）══════════
  // 搜尋範圍限定訂單與商品兩類（本批需求明確排除客戶、操作紀錄等其他資料）。訂單資料是逐一
  // JSON檔案（沒有資料庫索引，跟既有GET /api/orders、GET /dashboard同一套安全讀檔方式：
  // 逐檔try/catch，壞掉的單一檔案跳過、不影響其他結果），商品是SQLite資料表——分開查詢後
  // 合併回應。權限只要求ALL_ROLES（見admin-rbac.js quick_search），因為四個角色本來就都能
  // 看訂單清單（orders.view）與商品清單（products.view），這裡只是換一種更快的查詢方式，
  // 沒有多開放任何原本看不到的資料範圍。
  // 只搜尋「目前」（未封存）訂單與商品：快速搜尋的定位是日常快速找到目前在處理的訂單／
  // 商品，已封存資料量小、且已有各自頁籤的既有篩選功能可以找到，不在本批範圍內（已知限制）。
  const QUICK_SEARCH_ORDER_STATUS_LABELS = {
    new_inquiry: '新詢價', quoted: '已報價', closed_won: '已成交', in_production: '生產中',
    qc: '品質檢查', ready_to_ship: '待出貨', shipped: '已出貨', completed: '已完成', cancelled: '已取消'
  };
  const QUICK_SEARCH_PRODUCT_STATUS_LABELS = { active: '上架中', inactive: '已下架', coming_soon: '即將推出' };
  const QUICK_SEARCH_RESULT_LIMIT = 10;
  const QUICK_SEARCH_MIN_LEN = 2;
  const QUICK_SEARCH_MAX_LEN = 100;
  // 參數化查詢本身已避免SQL注入；這裡跳脫使用者輸入裡的LIKE萬用字元（%、_），單純是避免
  // 使用者搜尋文字剛好含有這兩個符號時被誤判成SQL萬用比對，導致搜尋範圍失真（不是安全問題）。
  function quickSearchEscapeLike(s) {
    return s.replace(/[\\%_]/g, ch => '\\' + ch);
  }

  router.get('/quick-search', requirePermission('quick_search', 'view'), csrfProtection, (req, res) => {
    const raw = typeof req.query.q === 'string' ? req.query.q : '';
    const q = raw.trim();
    if (q.length < QUICK_SEARCH_MIN_LEN) {
      return res.status(400).json({ error: `搜尋文字至少需要${QUICK_SEARCH_MIN_LEN}個字` });
    }
    if (q.length > QUICK_SEARCH_MAX_LEN) {
      return res.status(400).json({ error: `搜尋文字長度不可超過${QUICK_SEARCH_MAX_LEN}字` });
    }
    const needle = q.toLowerCase();

    let orderResults;
    try {
      const files = fs.readdirSync(ORDER_DIR).filter(f => f.endsWith('.json'));
      const matched = [];
      for (const f of files) {
        let order;
        try { order = JSON.parse(fs.readFileSync(path.join(ORDER_DIR, f), 'utf8')); }
        catch { continue; }
        if (!order || order.archivedAt) continue;
        const haystacks = [order.orderId, order.contact?.name, order.contact?.email, order.contact?.phone, order.product?.name]
          .map(v => (typeof v === 'string' ? v.toLowerCase() : ''));
        if (haystacks.some(h => h.includes(needle))) matched.push(order);
      }
      // 依儲存時間新到舊排序：快速搜尋沒有做相關性評分，用「最近的訂單優先」當簡單且
      // 可預期的預設排序，符合日常最常找「最近這幾筆」訂單的實際使用情境。
      matched.sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));
      orderResults = matched.slice(0, QUICK_SEARCH_RESULT_LIMIT).map(o => ({
        orderId: o.orderId,
        customerName: o.contact?.name || '',
        productName: o.product?.name || '',
        status: o.status || 'new_inquiry',
        statusLabel: QUICK_SEARCH_ORDER_STATUS_LABELS[o.status] || o.status || '',
        savedAt: o.savedAt || null
      }));
    } catch (err) {
      return res.status(500).json({ error: '搜尋訂單時發生錯誤' });
    }

    let productResults;
    try {
      const likePattern = '%' + quickSearchEscapeLike(needle) + '%';
      const statusCodes = Object.keys(QUICK_SEARCH_PRODUCT_STATUS_LABELS).filter(code =>
        code.toLowerCase().includes(needle) || QUICK_SEARCH_PRODUCT_STATUS_LABELS[code].toLowerCase().includes(needle)
      );
      const clauses = [`LOWER(id) LIKE ? ESCAPE '\\'`, `LOWER(name) LIKE ? ESCAPE '\\'`];
      const params = [likePattern, likePattern];
      if (statusCodes.length) {
        clauses.push(`status IN (${statusCodes.map(() => '?').join(',')})`);
        params.push(...statusCodes);
      }
      const sql = `SELECT id, name, status FROM products WHERE archived_at IS NULL AND (${clauses.join(' OR ')}) ORDER BY sort_order ASC, id ASC LIMIT ?`;
      params.push(QUICK_SEARCH_RESULT_LIMIT);
      const rows = db.prepare(sql).all(...params);
      productResults = rows.map(r => ({
        id: r.id,
        name: r.name,
        status: r.status,
        statusLabel: QUICK_SEARCH_PRODUCT_STATUS_LABELS[r.status] || r.status
      }));
    } catch (err) {
      return res.status(500).json({ error: '搜尋商品時發生錯誤' });
    }

    res.json({ success: true, orders: orderResults, products: productResults });
  });

  // ══════════ AI 使用量、成本及錯誤統計（第二階段：只唯讀彙總 ai_usage_logs，不提供任何寫入）══════════
  // dall-e-3 已被 OpenAI 官方從 API 移除（見 https://developers.openai.com/api/docs/models/dall-e-3），
  // 沒有現行官方價格，這裡絕對不可以把它的成本算成0元。三支圖片功能已於 2026-08-24 改用
  // gpt-image-2（換模型是「AI 功能開關、模型及提示詞管理」那個既有頁面／db.js migration
  // 的職責，不是這裡）；這裡純粹依每一筆歷史紀錄「當時實際用的是哪個模型」（row.model）
  // 對應到正確的價格區間，同一個功能的新舊資料列可以用不同模型的價格分別計算，互不影響。
  const AI_USAGE_STATS_FEATURE_KEYS = ['generate_image', 'generate_design', 'black_card_pattern', 'cartoon_image'];
  const AI_USAGE_STATS_OUTCOMES = ['success', 'partial', 'validation_error', 'disabled', 'unavailable', 'provider_error', 'rate_limited', 'content_blocked', 'internal_error'];
  const AI_USAGE_STATS_RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
  const AI_USAGE_STATS_QUERY_KEYS = ['range', 'feature', 'outcome'];
  const AI_USAGE_STATS_COST_NOTICE = '此處為依目前設定費率計算的預估已知成本，不等於 OpenAI 最終帳單。圖片編輯可能另有未記錄的文字或輸入圖片 Token 成本；無現行官方價格的模型不會以0元計算。';

  // usd→nano-USD（十億分之一美元）整數，全程用整數累加避免大量浮點加總造成的誤差
  // （先前用micro-USD在大量小額請求下會累積誤差，因此改用精度更高的nano-USD），
  // 中途任何一筆、任何彙總層級都不先取位，只在最後組成API回應時才統一換算回usd並四捨五入到6位小數。
  function usdToNanos(usd) { return Math.round(usd * 1e9); }
  function nanosToUsdRounded(nanos) {
    return Math.round(nanos / 1000) / 1e6; // nanos/1e9換算成usd，四捨五入到6位小數
  }

  router.get('/ai-usage-stats', requirePermission('analytics', 'view'), csrfProtection, (req, res) => {
    const queryKeys = Object.keys(req.query);
    const extraKeys = queryKeys.filter(k => !AI_USAGE_STATS_QUERY_KEYS.includes(k));
    if (extraKeys.length > 0) {
      return res.status(400).json({ error: `不接受未知查詢參數：${extraKeys.join('、')}` });
    }
    for (const k of AI_USAGE_STATS_QUERY_KEYS) {
      if (Array.isArray(req.query[k])) {
        return res.status(400).json({ error: `查詢參數 ${k} 不可重複` });
      }
    }

    const rangeParam = req.query.range === undefined ? '30d' : req.query.range;
    if (!Object.prototype.hasOwnProperty.call(AI_USAGE_STATS_RANGE_DAYS, rangeParam)) {
      return res.status(400).json({ error: 'range 只允許 7d、30d、90d' });
    }
    const rangeDays = AI_USAGE_STATS_RANGE_DAYS[rangeParam];

    const featureParam = req.query.feature;
    if (featureParam !== undefined && !AI_USAGE_STATS_FEATURE_KEYS.includes(featureParam)) {
      return res.status(400).json({ error: `feature 必須是下列其中之一：${AI_USAGE_STATS_FEATURE_KEYS.join('、')}` });
    }

    const outcomeParam = req.query.outcome;
    if (outcomeParam !== undefined && !AI_USAGE_STATS_OUTCOMES.includes(outcomeParam)) {
      return res.status(400).json({ error: `outcome 必須是下列其中之一：${AI_USAGE_STATS_OUTCOMES.join('、')}` });
    }

    // 台北時區（UTC+8）日期運算：跟 admin-routes.js 內 /dashboard 路由同一套固定位移算法，
    // 這裡獨立各自持有一份（這個檔案既有的慣例——每支路由各自的時間運算是純函式、互不相依，
    // 刻意不牽動已經測試通過的 /dashboard 路由本身）。
    const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
    const toTaipeiDateParts = isoString => {
      if (typeof isoString !== 'string' || !isoString) return null;
      const d = new Date(isoString);
      if (Number.isNaN(d.getTime())) return null;
      const taipei = new Date(d.getTime() + TAIPEI_OFFSET_MS);
      return { y: taipei.getUTCFullYear(), m: taipei.getUTCMonth(), d: taipei.getUTCDate() };
    };
    const taipeiMidnightUtcMs = parts => Date.UTC(parts.y, parts.m, parts.d, 0, 0, 0, 0) - TAIPEI_OFFSET_MS;
    const addDaysToDateParts = (parts, deltaDays) => {
      const d = new Date(Date.UTC(parts.y, parts.m, parts.d, 0, 0, 0, 0) + deltaDays * 86400000);
      return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate() };
    };
    const formatDateParts = parts => `${parts.y}-${String(parts.m + 1).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;

    const nowTaipei = toTaipeiDateParts(new Date().toISOString());
    const rangeStartParts = addDaysToDateParts(nowTaipei, -(rangeDays - 1));
    const rangeStartMs = taipeiMidnightUtcMs(rangeStartParts);
    const rangeEndMs = taipeiMidnightUtcMs(nowTaipei) + 86399999; // 含今天整天最後一毫秒

    // ── 依range/feature/outcome一次撈出全部符合條件的紀錄，後續全部在JS內彙總，避免對同一張
    // 表重複下多次SQL；全部條件皆為參數化查詢（? 佔位符），不拼接任何使用者輸入進SQL字串。
    const whereClauses = ['created_at >= ?', 'created_at <= ?'];
    const sqlParams = [new Date(rangeStartMs).toISOString(), new Date(rangeEndMs).toISOString()];
    if (featureParam) { whereClauses.push('feature_key = ?'); sqlParams.push(featureParam); }
    if (outcomeParam) { whereClauses.push('outcome = ?'); sqlParams.push(outcomeParam); }
    const rows = db.prepare(`SELECT * FROM ai_usage_logs WHERE ${whereClauses.join(' AND ')} ORDER BY created_at ASC`).all(...sqlParams);

    // ── 價格資料：本階段唯讀顯示＋成本試算共用同一份，不在這支API裡另外寫死金額 ──
    const pricingRows = getAllAiPricingSettings();
    const pricingByKey = {};
    pricingRows.forEach(p => { pricingByKey[p.rateKey] = p; });
    const PRICE_GPT4O_INPUT   = pricingByKey.gpt4o_mini_input_1m;
    const PRICE_GPT4O_OUTPUT  = pricingByKey.gpt4o_mini_output_1m;
    // gpt-image-2（2026-08-24起三支圖片功能的現行模型）
    const PRICE_IMAGE_SQUARE_V2    = pricingByKey.gpt_image_2_medium_1024_square;
    const PRICE_IMAGE_PORTRAIT_V2  = pricingByKey.gpt_image_2_medium_1024_portrait;
    const PRICE_IMAGE_LANDSCAPE_V2 = pricingByKey.gpt_image_2_medium_1024_landscape;
    // gpt-image-1（已被官方列為Deprecated，僅供歷史紀錄裡 model='gpt-image-1' 的舊資料列查價）
    const PRICE_IMAGE_SQUARE_LEGACY    = pricingByKey.gpt_image_1_medium_1024_square;
    const PRICE_IMAGE_PORTRAIT_LEGACY  = pricingByKey.gpt_image_1_medium_1024_portrait;
    const PRICE_IMAGE_LANDSCAPE_LEGACY = pricingByKey.gpt_image_1_medium_1024_landscape;

    // ── 每日趨勢桶：固定回傳 rangeDays 筆（含今天），依日期由舊到新排列，沒有資料的日期
    // 也要補0，確保圖表日期連續，不受伺服器UTC日期偏移影響（全部用台北年/月/日計算）。
    const trendBuckets = [];
    const trendIndexByKey = new Map();
    for (let i = rangeDays - 1; i >= 0; i--) {
      const parts = addDaysToDateParts(nowTaipei, -i);
      const key = formatDateParts(parts);
      trendBuckets.push({ date: key, totalRequests: 0, successCount: 0, errorCount: 0, generatedImageCount: 0, knownCostNanos: 0 });
      trendIndexByKey.set(key, trendBuckets.length - 1);
    }

    // ── 各功能彙總：固定回傳四項功能，即使沒有資料也要回傳0 ──
    const byFeatureMap = {};
    AI_USAGE_STATS_FEATURE_KEYS.forEach(fk => {
      byFeatureMap[fk] = {
        featureKey: fk, totalRequests: 0, successCount: 0, partialCount: 0, errorCount: 0,
        durationSum: 0, durationCount: 0, inputTokens: 0, outputTokens: 0, generatedImageCount: 0,
        knownCostNanos: 0, unknownCostCount: 0, partialCostCount: 0
      };
    });

    const errorBreakdownMap = {};
    // 只彙總「真的被內容審核擋下」（moderation_flagged=1）的主要分類次數，不含分數、原文，
    // 只用固定分類代碼＋次數，供後台判斷阻擋內容的大致類型分布。
    const moderationCategoryBreakdownMap = {};

    let totalRequests = 0, providerCalledRequests = 0, moderationCalledRequests = 0;
    let successCount = 0, partialCount = 0, validationErrorCount = 0, disabledCount = 0,
        unavailableCount = 0, providerErrorCount = 0, rateLimitedCount = 0, contentBlockedCount = 0, internalErrorCount = 0;
    let durationSum = 0, durationCount = 0;
    let inputTokens = 0, outputTokens = 0, totalTokens = 0;
    let generatedImageCount = 0;
    let providerSuccessOrPartialCount = 0;
    let knownCostNanosTotal = 0;
    let unknownCostRequests = 0;
    let partialCostRequests = 0;

    rows.forEach(row => {
      totalRequests++;
      if (row.provider_called) providerCalledRequests++;
      if (row.moderation_called) moderationCalledRequests++;

      switch (row.outcome) {
        case 'success':          successCount++; break;
        case 'partial':          partialCount++; break;
        case 'validation_error': validationErrorCount++; break;
        case 'disabled':         disabledCount++; break;
        case 'unavailable':      unavailableCount++; break;
        case 'provider_error':   providerErrorCount++; break;
        case 'rate_limited':     rateLimitedCount++; break;
        case 'content_blocked':  contentBlockedCount++; break;
        case 'internal_error':   internalErrorCount++; break;
      }
      if (row.moderation_flagged && row.moderation_category) {
        moderationCategoryBreakdownMap[row.moderation_category] = (moderationCategoryBreakdownMap[row.moderation_category] || 0) + 1;
      }
      const isSuccessLike = row.outcome === 'success' || row.outcome === 'partial';
      if (row.provider_called && isSuccessLike) providerSuccessOrPartialCount++;

      durationSum += row.duration_ms;
      durationCount++;
      if (row.input_tokens !== null) inputTokens += row.input_tokens;
      if (row.output_tokens !== null) outputTokens += row.output_tokens;
      if (row.total_tokens !== null) totalTokens += row.total_tokens;
      if (row.generated_image_count !== null) generatedImageCount += row.generated_image_count;

      // ── 成本試算：沒有實際呼叫OpenAI（provider_called=0）的請求，成本就是真的0元
      // （不是「不知道」，是確實沒有發生用量），不計入 unknown／partial。只有真的呼叫過
      // OpenAI、但缺少必要用量資料（token或圖片數）或該模型沒有現行官方價格時，才算unknown。
      let rowKnownCostNanos = 0;
      let rowUnknownCost = false;
      let rowPartialCost = false;
      if (row.provider_called) {
        if (row.feature_key === 'generate_design') {
          if (row.input_tokens !== null && row.output_tokens !== null && PRICE_GPT4O_INPUT.unitPriceUsd !== null && PRICE_GPT4O_OUTPUT.unitPriceUsd !== null) {
            const costUsd = (row.input_tokens * PRICE_GPT4O_INPUT.unitPriceUsd / 1e6) + (row.output_tokens * PRICE_GPT4O_OUTPUT.unitPriceUsd / 1e6);
            rowKnownCostNanos = usdToNanos(costUsd);
          } else {
            rowUnknownCost = true;
          }
        } else if (row.feature_key === 'black_card_pattern' || row.feature_key === 'cartoon_image' || row.feature_key === 'generate_image') {
          // 三支圖片功能共用同一套「依這筆紀錄實際使用的模型挑對應價格」邏輯：
          // gpt-image-2（2026-08-24起現行模型）用新價格；gpt-image-1（已被官方列為Deprecated
          // 但尚未下架，歷史紀錄可能還有）用舊價格；dall-e-3（已被官方下架，沒有現行官方價格）
          // 或任何其他未知模型一律算 unknown，不可用舊價格回推估算現行費用。
          const IMAGE_PRICE_BY_FEATURE = {
            black_card_pattern: { v2: PRICE_IMAGE_SQUARE_V2,   legacy: PRICE_IMAGE_SQUARE_LEGACY },
            cartoon_image:      { v2: PRICE_IMAGE_PORTRAIT_V2, legacy: PRICE_IMAGE_PORTRAIT_LEGACY },
            generate_image:     { v2: PRICE_IMAGE_LANDSCAPE_V2, legacy: PRICE_IMAGE_LANDSCAPE_LEGACY }
          };
          const priceSet = IMAGE_PRICE_BY_FEATURE[row.feature_key];
          const price = row.model === 'gpt-image-2' ? priceSet.v2
                      : row.model === 'gpt-image-1' ? priceSet.legacy
                      : null;
          if (price && row.generated_image_count !== null && price.unitPriceUsd !== null) {
            rowKnownCostNanos = usdToNanos(row.generated_image_count * price.unitPriceUsd);
            rowPartialCost = true; // 只涵蓋已知的圖片輸出費用，沒有記錄文字（及輸入圖片）Token成本
          } else {
            rowUnknownCost = true;
          }
        }
      }
      if (rowUnknownCost) unknownCostRequests++;
      if (rowPartialCost) partialCostRequests++;
      knownCostNanosTotal += rowKnownCostNanos;

      // ── 各功能彙總 ──
      const fBucket = byFeatureMap[row.feature_key];
      if (fBucket) {
        fBucket.totalRequests++;
        if (row.outcome === 'success') fBucket.successCount++;
        if (row.outcome === 'partial') fBucket.partialCount++;
        if (!isSuccessLike) fBucket.errorCount++;
        fBucket.durationSum += row.duration_ms;
        fBucket.durationCount++;
        if (row.input_tokens !== null) fBucket.inputTokens += row.input_tokens;
        if (row.output_tokens !== null) fBucket.outputTokens += row.output_tokens;
        if (row.generated_image_count !== null) fBucket.generatedImageCount += row.generated_image_count;
        fBucket.knownCostNanos += rowKnownCostNanos;
        if (rowUnknownCost) fBucket.unknownCostCount++;
        if (rowPartialCost) fBucket.partialCostCount++;
      }

      // ── 每日趨勢：以台北日曆天分組，success／partial 都算「成功類」，其餘一律算錯誤，
      // totalRequests = successCount + errorCount 這個不變量永遠成立，方便前端交叉驗證。
      const parts = toTaipeiDateParts(row.created_at);
      if (parts) {
        const key = formatDateParts(parts);
        const idx = trendIndexByKey.get(key);
        if (idx !== undefined) {
          const bucket = trendBuckets[idx];
          bucket.totalRequests++;
          if (isSuccessLike) bucket.successCount++; else bucket.errorCount++;
          if (row.generated_image_count !== null) bucket.generatedImageCount += row.generated_image_count;
          bucket.knownCostNanos += rowKnownCostNanos;
        }
      }

      // ── 錯誤分類彙總：error_category=null（成功／部分成功）不放進這張表 ──
      if (row.error_category !== null) {
        errorBreakdownMap[row.error_category] = (errorBreakdownMap[row.error_category] || 0) + 1;
      }
    });

    const overallSuccessRate = totalRequests > 0 ? (successCount + partialCount) / totalRequests : null;
    const providerSuccessRate = providerCalledRequests > 0 ? providerSuccessOrPartialCount / providerCalledRequests : null;
    const avgDurationMs = durationCount > 0 ? durationSum / durationCount : null;
    const hasIncompleteCostEstimate = (unknownCostRequests + partialCostRequests) > 0;

    const summary = {
      totalRequests, providerCalledRequests, moderationCalledRequests,
      successCount, partialCount, validationErrorCount, disabledCount, unavailableCount, providerErrorCount, rateLimitedCount, contentBlockedCount, internalErrorCount,
      overallSuccessRate, providerSuccessRate,
      avgDurationMs,
      inputTokens, outputTokens, totalTokens,
      generatedImageCount,
      estimatedKnownCostUsd: nanosToUsdRounded(knownCostNanosTotal),
      unknownCostRequests, partialCostRequests, hasIncompleteCostEstimate
    };

    const dailyTrend = trendBuckets.map(b => ({
      date: b.date,
      totalRequests: b.totalRequests,
      successCount: b.successCount,
      errorCount: b.errorCount,
      generatedImageCount: b.generatedImageCount,
      estimatedKnownCostUsd: nanosToUsdRounded(b.knownCostNanos)
    }));

    function featureCostCoverage(fk, bucket) {
      if (bucket.totalRequests === 0) return 'none';
      if (fk === 'generate_image') return 'unknown';
      if (bucket.partialCostCount > 0 || bucket.unknownCostCount > 0) return 'partial';
      return 'full';
    }
    const byFeature = AI_USAGE_STATS_FEATURE_KEYS.map(fk => {
      const b = byFeatureMap[fk];
      return {
        featureKey: fk,
        totalRequests: b.totalRequests,
        successCount: b.successCount,
        partialCount: b.partialCount,
        errorCount: b.errorCount,
        avgDurationMs: b.durationCount > 0 ? b.durationSum / b.durationCount : null,
        inputTokens: b.inputTokens,
        outputTokens: b.outputTokens,
        generatedImageCount: b.generatedImageCount,
        estimatedKnownCostUsd: nanosToUsdRounded(b.knownCostNanos),
        costCoverage: featureCostCoverage(fk, b)
      };
    });

    const errorBreakdown = Object.keys(errorBreakdownMap)
      .map(cat => ({ errorCategory: cat, count: errorBreakdownMap[cat] }))
      .sort((a, b) => b.count - a.count);

    const moderationCategoryBreakdown = Object.keys(moderationCategoryBreakdownMap)
      .map(cat => ({ category: cat, count: moderationCategoryBreakdownMap[cat] }))
      .sort((a, b) => b.count - a.count);

    // ── 最近錯誤紀錄：不含成功／部分成功（partial不是「錯誤」，有自己獨立的partialCount），
    // 依時間由新到舊，最多50筆；欄位只挑選白名單裡的安全欄位，絕對不含提示詞、圖片、
    // 請求內容、IP、個資、API Key或原始錯誤訊息（ai_usage_logs資料表本身就沒有這些欄位）。
    const recentErrors = rows
      .filter(r => r.outcome !== 'success' && r.outcome !== 'partial')
      .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
      .slice(0, 50)
      .map(r => ({
        id: r.id,
        requestId: r.request_id,
        featureKey: r.feature_key,
        model: r.model,
        outcome: r.outcome,
        httpStatus: r.http_status,
        errorCategory: r.error_category,
        durationMs: r.duration_ms,
        createdAt: r.created_at
      }));

    res.json({
      success: true,
      range: rangeParam,
      summary,
      dailyTrend,
      byFeature,
      errorBreakdown,
      moderationCategoryBreakdown,
      recentErrors,
      pricing: pricingRows,
      costNotice: AI_USAGE_STATS_COST_NOTICE
    });
  });

  // ══════════ 網站分析：共用統計 API 與日期篩選基礎（第二階段第一批）══════════
  // 這支 API 只唯讀彙總 analytics_events，不修改任何分析事件、訂單或其他正式資料。
  // 只建立五個分析區塊共用的資料基礎（total/visitor/session/inquiry/ai 六個摘要數字＋事件
  // 明細＋資料涵蓋期間），不在這一批製作來源／漏斗／商品偏好／內部效率／顧客價值等圖表。
  const ANALYTICS_OVERVIEW_QUERY_KEYS = ['from', 'to'];
  const ANALYTICS_OVERVIEW_MAX_RANGE_DAYS = 366;
  const ANALYTICS_OVERVIEW_TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
  const ANALYTICS_OVERVIEW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // 事件字典固定順序（跟 db.js 的 analytics_events.event_name CHECK 約束、
  // 楊竹網站分析情報規劃書_合併版.md 第六節「事件字典」同一份順序），eventBreakdown
  // 一律依這個固定順序回傳，不依資料庫查詢結果的隨機順序改變。
  const ANALYTICS_OVERVIEW_EVENT_DICTIONARY = [
    'page_view', 'product_view', 'customization_start', 'customization_step_complete',
    'upload_result', 'ai_request', 'ai_result', 'preview_complete',
    'inquiry_form_start', 'inquiry_validation_error', 'inquiry_submit_success', 'contact_click'
  ];

  function isValidAnalyticsOverviewDateString(s) {
    if (typeof s !== 'string' || !ANALYTICS_OVERVIEW_DATE_RE.test(s)) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  // 台北日曆日 00:00 換算成UTC毫秒（固定位移，跟上面 /ai-usage-stats 路由同一套算法，
  // 這裡獨立各自持有一份，遵循這個檔案既有的「每支路由各自的時間運算是純函式、互不相依」慣例）。
  function analyticsOverviewDateStringToTaipeiMidnightUtcMs(s) {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d, 0, 0, 0, 0) - ANALYTICS_OVERVIEW_TAIPEI_OFFSET_MS;
  }
  function analyticsOverviewNowTaipeiDateParts() {
    const taipei = new Date(Date.now() + ANALYTICS_OVERVIEW_TAIPEI_OFFSET_MS);
    return { y: taipei.getUTCFullYear(), m: taipei.getUTCMonth(), d: taipei.getUTCDate() };
  }
  function analyticsOverviewFormatDateParts(p) {
    return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }
  function analyticsOverviewAddDaysToDateParts(p, deltaDays) {
    const dt = new Date(Date.UTC(p.y, p.m, p.d, 0, 0, 0, 0) + deltaDays * 86400000);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
  }

  // ── 第二階段第二批共用工具（流量來源分析＋客製化轉換漏斗）──────────────────
  const ANALYTICS_OVERVIEW_TOP_N = 10;
  const ANALYTICS_OVERVIEW_VALID_DEVICE_TYPES = ['mobile', 'tablet', 'desktop'];
  const ANALYTICS_OVERVIEW_AI_RESULT_VALID_RESULTS = ['success', 'partial', 'failure'];
  // 有效來源（至少一項非空）共用SQL片段：utm_source／utm_medium／utm_campaign／referrer_domain。
  const ANALYTICS_OVERVIEW_VALID_SOURCE_SQL = `(
      (utm_source IS NOT NULL AND utm_source != '') OR
      (utm_medium IS NOT NULL AND utm_medium != '') OR
      (utm_campaign IS NOT NULL AND utm_campaign != '') OR
      (referrer_domain IS NOT NULL AND referrer_domain != '')
    )`;
  function analyticsOverviewRoundPct(n) { return Math.round(n * 10) / 10; }
  function analyticsOverviewSqlPlaceholders(arr) { return arr.map(() => '?').join(','); }

  // ai_result 的 metadata_json 格式判斷（跟summary.aiSuccessCount共用同一套規則與同一批查詢
  // 結果，不重新查詢、不重複輸出異常摘要紀錄）：null/空值、解析失敗、非物件、或result欄位
  // 缺少/型別錯誤/不在success|partial|failure白名單，一律視為異常，安全忽略。
  function analyticsOverviewClassifyAiResultMetadata(metadataJsonRaw) {
    let meta = null;
    let parseFailed = false;
    if (metadataJsonRaw) {
      try { meta = JSON.parse(metadataJsonRaw); }
      catch (e) { parseFailed = true; }
    }
    const isPlainObject = !parseFailed && meta !== null && typeof meta === 'object' && !Array.isArray(meta);
    const hasValidResult = isPlainObject && typeof meta.result === 'string' && ANALYTICS_OVERVIEW_AI_RESULT_VALID_RESULTS.includes(meta.result);
    const isAnomaly = !metadataJsonRaw || parseFailed || !isPlainObject || !hasValidResult;
    return { isAnomaly, result: isAnomaly ? null : meta.result };
  }

  // 來源分類（流量來源分析＋詢價前最後來源共用同一套規則，見規劃書第16.3節與本批需求三）：
  // 優先序 1.有utm_source→type=utm；2.沒有utm_source但有referrer_domain→type=referrer；
  // 3.以上皆無→type=direct_or_unknown。null與空字串一律視為「沒有」，不會被拆成不同群組。
  function analyticsOverviewClassifySourceRow(row) {
    const utmSource = row.utm_source || '';
    const referrerDomain = row.referrer_domain || '';
    if (utmSource) {
      const medium = row.utm_medium || '';
      const campaign = row.utm_campaign || '';
      const sourceKey = `utm:${utmSource}|${medium}|${campaign}`;
      const sourceLabel = campaign ? `${utmSource} / ${medium || '未指定媒介'} / ${campaign}` : (medium ? `${utmSource} / ${medium}` : utmSource);
      return { sourceKey, sourceLabel };
    }
    if (referrerDomain) {
      return { sourceKey: `referrer:${referrerDomain}`, sourceLabel: referrerDomain };
    }
    return { sourceKey: 'direct_or_unknown', sourceLabel: '直接進站／未知來源' };
  }
  const ANALYTICS_OVERVIEW_DIRECT_OR_UNKNOWN = { sourceKey: 'direct_or_unknown', sourceLabel: '直接進站／未知來源' };

  // 固定排序＋前10名＋其餘合併other：數量由大到小，同數量時sourceKey字典順序，
  // 超過10筆時第11名起合併成一筆「other」，沒有資料回傳空陣列。
  function analyticsOverviewRankSources(aggMap, countKey) {
    const list = [...aggMap.values()];
    if (list.length === 0) return [];
    list.sort((a, b) => (b.count !== a.count) ? (b.count - a.count) : (a.sourceKey < b.sourceKey ? -1 : (a.sourceKey > b.sourceKey ? 1 : 0)));
    if (list.length <= ANALYTICS_OVERVIEW_TOP_N) {
      return list.map(x => ({ sourceKey: x.sourceKey, sourceLabel: x.sourceLabel, [countKey]: x.count }));
    }
    const top = list.slice(0, ANALYTICS_OVERVIEW_TOP_N);
    const rest = list.slice(ANALYTICS_OVERVIEW_TOP_N);
    const otherCount = rest.reduce((sum, x) => sum + x.count, 0);
    return [
      ...top.map(x => ({ sourceKey: x.sourceKey, sourceLabel: x.sourceLabel, [countKey]: x.count })),
      { sourceKey: 'other', sourceLabel: '其他來源', [countKey]: otherCount }
    ];
  }
  function analyticsOverviewBumpSource(map, cls) {
    if (!map.has(cls.sourceKey)) map.set(cls.sourceKey, { sourceKey: cls.sourceKey, sourceLabel: cls.sourceLabel, count: 0 });
    map.get(cls.sourceKey).count++;
  }

  // 客製化轉換漏斗固定8關（需求四）：每一關的match()判斷這筆事件是否屬於這個關卡。
  const ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS = [
    { key: 'visit', label: '進站', match: e => e.event_name === 'page_view' },
    { key: 'product_view', label: '查看商品', match: e => e.event_name === 'product_view' },
    { key: 'customization_start', label: '開始客製化', match: e => e.event_name === 'customization_start' },
    { key: 'specification_complete', label: '完成規格選擇', match: e => e.event_name === 'customization_step_complete' && e.step_key === 'specification' },
    { key: 'design_complete', label: '完成設計', match: e => e.event_name === 'customization_step_complete' && e.step_key === 'design' },
    { key: 'preview_complete', label: '完成預覽', match: e => e.event_name === 'preview_complete' },
    { key: 'inquiry_form_start', label: '開始填寫詢價', match: e => e.event_name === 'inquiry_form_start' },
    { key: 'inquiry_submit_success', label: '詢價成功', match: e => e.event_name === 'inquiry_submit_success' }
  ];
  // 共用的「時間+id」先後比較：cursorTime為null代表沒有下限（永遠算後面），否則occurred_at
  // 不同就比字串大小，相同時間才用id（自動遞增）當決勝——漏斗逐關判定與AI事件先後順序驗證
  // 共用同一套比較邏輯，不各自維護一份容易分岔的複製版本。
  function analyticsOverviewIsAfterCursor(occurredAt, id, cursorTime, cursorId) {
    if (cursorTime === null) return true;
    return (occurredAt !== cursorTime) ? (occurredAt > cursorTime) : (id > cursorId);
  }

  // ── 第二階段第三批共用工具（商品／客製化／AI偏好、業務與內部效率、顧客與訂單價值）──────
  // 訂單狀態中文名稱與完整流程順序，沿用 server.js 的 ORDER_STATUS_LABELS／ORDER_STATUS_FLOW
  // （admin-routes.js 無法 require server.js，避免循環相依，維持這個檔案既有的「刻意複製一份，
  // 改狀態要兩邊同步」慣例，等同上面 GET /dashboard 路由內的 DASHBOARD_STATUS_LABELS）。
  const ANALYTICS_OVERVIEW_ORDER_STATUS_FLOW = ['new_inquiry', 'quoted', 'closed_won', 'in_production', 'qc', 'ready_to_ship', 'shipped', 'completed'];
  const ANALYTICS_OVERVIEW_ORDER_STATUS_LABELS = {
    new_inquiry: '新詢價', quoted: '已報價', closed_won: '已成交', in_production: '生產中',
    qc: '品質檢查', ready_to_ship: '待出貨', shipped: '已出貨', completed: '已完成', cancelled: '已取消'
  };
  const ANALYTICS_OVERVIEW_AI_FEATURE_KEYS = ['generate_image', 'generate_design', 'black_card_pattern', 'cartoon_image'];
  // 判定「高瀏覽、低詢價」與「詢價率高、曝光不足」商品的固定門檻（需求一）：樣本數不足時
  // 一律回傳 null（不下結論），不可以用少量樣本硬套百分比。
  const ANALYTICS_OVERVIEW_LOW_INQUIRY_MIN_VIEW_SESSIONS = 10; // 至少累積這麼多次商品瀏覽工作階段，才夠格判斷「曝光足夠但詢價率偏低」
  const ANALYTICS_OVERVIEW_LOW_INQUIRY_MAX_RATE_PCT = 3;       // 整體商品瀏覽到詢價率低於這個百分比，視為偏低
  const ANALYTICS_OVERVIEW_UNDEREXPOSED_MAX_VIEW_SESSIONS = 10;  // 商品瀏覽工作階段數低於這個值，視為「曝光不足」
  const ANALYTICS_OVERVIEW_UNDEREXPOSED_MIN_INQUIRY_ORDERS = 3;  // 至少累積這麼多筆詢價訂單，才夠格判斷「詢價率其實很高」
  const ANALYTICS_OVERVIEW_UNDEREXPOSED_MIN_RATE_PCT = 20;       // 整體商品瀏覽到詢價率高於這個百分比，視為偏高

  // 中位數／平均數／最小/最大：輸入未排序的數字陣列，空陣列回傳全部null（樣本數0）；
  // 平均數／中位數四捨五入到整數（毫秒或金額皆適用，呼叫端決定單位）。
  function analyticsOverviewComputeStats(values) {
    const n = values.length;
    if (n === 0) return { sampleCount: 0, medianMs: null, meanMs: null, minMs: null, maxMs: null };
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(n / 2);
    const medianRaw = n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    const meanRaw = sorted.reduce((s, v) => s + v, 0) / n;
    return { sampleCount: n, medianMs: Math.round(medianRaw), meanMs: Math.round(meanRaw), minMs: sorted[0], maxMs: sorted[n - 1] };
  }
  // 找一張訂單statusHistory裡「第一次」變成某個狀態的changedAt（該陣列本身是依變更發生順序
  // append-only寫入，不需要再另外排序）；找不到（沒有statusHistory、不是陣列、或從未變成過
  //這個狀態）回傳null，不可以用savedAt或其他欄位猜測。
  function analyticsOverviewFirstReachedAt(order, targetStatus) {
    const history = Array.isArray(order.statusHistory) ? order.statusHistory : null;
    if (!history) return null;
    for (const h of history) {
      if (h && h.to === targetStatus && typeof h.changedAt === 'string' && h.changedAt) return h.changedAt;
    }
    return null;
  }
  // 計算兩個ISO時間字串之間的毫秒差；任一者缺失、格式錯誤、或差值為負數，一律回傳null並計入
  // 呼叫端自己的「無法計算筆數」，不可以用0或忽略負數的方式假裝有資料。
  function analyticsOverviewDiffMs(fromIso, toIso) {
    if (typeof fromIso !== 'string' || !fromIso || typeof toIso !== 'string' || !toIso) return null;
    const fromMs = new Date(fromIso).getTime();
    const toMs = new Date(toIso).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
    const diff = toMs - fromMs;
    return diff >= 0 ? diff : null;
  }

  router.get('/analytics/overview', requirePermission('analytics', 'view'), csrfProtection, (req, res) => {
    const queryKeys = Object.keys(req.query);
    const extraKeys = queryKeys.filter(k => !ANALYTICS_OVERVIEW_QUERY_KEYS.includes(k));
    if (extraKeys.length > 0) {
      return res.status(400).json({ error: `不接受未知查詢參數：${extraKeys.join('、')}` });
    }
    for (const k of ANALYTICS_OVERVIEW_QUERY_KEYS) {
      if (Array.isArray(req.query[k])) {
        return res.status(400).json({ error: `查詢參數 ${k} 不可重複` });
      }
    }

    const fromParam = req.query.from;
    const toParam = req.query.to;
    // from／to 必須同時提供或同時省略：只給其中一個時「該用哪一天當另一邊的邊界」沒有唯一
    // 合理定義，與其自行猜測，不如直接拒絕，避免管理者誤以為查到的是預期的範圍。
    if ((fromParam === undefined) !== (toParam === undefined)) {
      return res.status(400).json({ error: 'from 與 to 必須同時提供或同時省略' });
    }
    if (fromParam !== undefined && !isValidAnalyticsOverviewDateString(fromParam)) {
      return res.status(400).json({ error: 'from 格式錯誤，必須是 YYYY-MM-DD' });
    }
    if (toParam !== undefined && !isValidAnalyticsOverviewDateString(toParam)) {
      return res.status(400).json({ error: 'to 格式錯誤，必須是 YYYY-MM-DD' });
    }

    let fromStr, toStr;
    if (fromParam === undefined) {
      // 規則1：預設查詢最近30個台北日曆日（含當天）。
      const todayParts = analyticsOverviewNowTaipeiDateParts();
      toStr = analyticsOverviewFormatDateParts(todayParts);
      fromStr = analyticsOverviewFormatDateParts(analyticsOverviewAddDaysToDateParts(todayParts, -29));
    } else {
      fromStr = fromParam;
      toStr = toParam;
    }

    const fromMidnightUtcMs = analyticsOverviewDateStringToTaipeiMidnightUtcMs(fromStr);
    const toMidnightUtcMs = analyticsOverviewDateStringToTaipeiMidnightUtcMs(toStr);
    if (fromMidnightUtcMs > toMidnightUtcMs) {
      return res.status(400).json({ error: 'from 不得晚於 to' });
    }
    const rangeDaysInclusive = Math.round((toMidnightUtcMs - fromMidnightUtcMs) / 86400000) + 1;
    if (rangeDaysInclusive > ANALYTICS_OVERVIEW_MAX_RANGE_DAYS) {
      return res.status(400).json({ error: `查詢範圍最長 ${ANALYTICS_OVERVIEW_MAX_RANGE_DAYS} 天` });
    }

    // 規則3、4：from與to都包含當天完整範圍；資料庫查詢用「起始時間包含、結束時間不包含」——
    // 範圍結束邊界用 to 隔天的台北午夜（不含），涵蓋 to 當天最後一毫秒，不用 23:59:59.999
    // 這種容易漏掉毫秒尾數的寫法。
    const rangeStartIso = new Date(fromMidnightUtcMs).toISOString();
    const rangeEndExclusiveIso = new Date(toMidnightUtcMs + 86400000).toISOString();

    // 全部條件皆為參數化查詢（? 佔位符），不拼接任何使用者輸入進SQL字串。
    const eventCount = db.prepare(
      `SELECT COUNT(*) c FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ?`
    ).get(rangeStartIso, rangeEndExclusiveIso).c;

    const visitorCount = db.prepare(
      `SELECT COUNT(DISTINCT anonymous_visitor_id_hash) c FROM analytics_events
       WHERE occurred_at >= ? AND occurred_at < ?
         AND anonymous_visitor_id_hash IS NOT NULL AND anonymous_visitor_id_hash != ''`
    ).get(rangeStartIso, rangeEndExclusiveIso).c;

    const sessionCount = db.prepare(
      `SELECT COUNT(DISTINCT session_id_hash) c FROM analytics_events
       WHERE occurred_at >= ? AND occurred_at < ?
         AND session_id_hash IS NOT NULL AND session_id_hash != ''`
    ).get(rangeStartIso, rangeEndExclusiveIso).c;

    // 詢價成功數只信任可信後端事件 inquiry_submit_success，並以不重複 order_id 計算，
    // 不可以用公開事件的回報次數代替（見規劃書第16.2節）。
    const inquiryCount = db.prepare(
      `SELECT COUNT(DISTINCT order_id) c FROM analytics_events
       WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'inquiry_submit_success'
         AND order_id IS NOT NULL AND order_id != ''`
    ).get(rangeStartIso, rangeEndExclusiveIso).c;

    // 順便選出session_id_hash／occurred_at／id，供下面funnel的aiBranch（AI採用率／成功率）
    // 共用同一批查詢結果，不再另外重新查詢一次ai_request／ai_result；occurred_at／id是為了
    // 驗證「ai_request必須晚於customization_start、ai_result必須晚於對應的ai_request」的
    // 事件先後順序，不能只看「這個session有沒有出現過」。
    const aiRequestRows = db.prepare(
      `SELECT session_id_hash AS h, occurred_at, id FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'ai_request'`
    ).all(rangeStartIso, rangeEndExclusiveIso);
    const aiRequestCount = aiRequestRows.length;

    // aiSuccessCount 只計算 ai_result 且 metadata.result==='success'；metadata_json 解析失敗
    // 或格式異常（null／空值、陣列、純字串/數字/布林、缺少result、result型別錯誤、result不在
    // success/partial/failure白名單）一律安全忽略該筆、不計入分子分母，不可以讓單一筆壞資料
    // 造成整支API回500。partial／failure是合法格式（只是不計入aiSuccessCount），不算異常。
    // 異常不逐筆console，避免同一次查詢裡大量壞資料洗版；只在本次查詢結束後輸出一筆固定格式
    // 的安全摘要（只有筆數，不含metadata原文或任何顧客資料），供之後追查資料品質問題。
    const aiResultRows = db.prepare(
      `SELECT session_id_hash AS h, metadata_json, occurred_at, id FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'ai_result'`
    ).all(rangeStartIso, rangeEndExclusiveIso);
    let aiSuccessCount = 0;
    let aiResultAnomalyCount = 0;
    aiResultRows.forEach(row => {
      const cls = analyticsOverviewClassifyAiResultMetadata(row.metadata_json);
      if (cls.isAnomaly) aiResultAnomalyCount++;
      else if (cls.result === 'success') aiSuccessCount++;
    });
    if (aiResultAnomalyCount > 0) {
      console.error(`[analytics-overview] 本次查詢區間內有 ${aiResultAnomalyCount} 筆 ai_result 的 metadata_json 格式異常（null/空值、解析失敗、非物件、或result欄位缺少/型別錯誤/不在白名單內），已安全忽略、不計入aiSuccessCount，本紀錄不含metadata原文或任何顧客資料`);
    }

    // eventBreakdown：固定依事件字典順序回傳，即使某事件本期沒有資料也要回傳0。
    const eventBreakdownRows = db.prepare(
      `SELECT event_name, COUNT(*) c FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ? GROUP BY event_name`
    ).all(rangeStartIso, rangeEndExclusiveIso);
    const eventBreakdownMap = {};
    eventBreakdownRows.forEach(r => { eventBreakdownMap[r.event_name] = r.c; });
    const eventBreakdown = ANALYTICS_OVERVIEW_EVENT_DICTIONARY.map(name => ({
      eventName: name,
      count: eventBreakdownMap[name] || 0
    }));

    // dataRange：整張表（不受本次期間篩選限制）最早／最晚 occurred_at，沒有資料時回傳null。
    const dataRangeRow = db.prepare(
      `SELECT MIN(occurred_at) earliest, MAX(occurred_at) latest FROM analytics_events`
    ).get();

    // ══════════ traffic：流量來源分析（第二階段第二批）══════════
    // 新訪客／回訪者：以本期間內有活動、且anonymous_visitor_id_hash非null/空字串的訪客為對象，
    // 比對該訪客「整張表」（不受本次期間限制）最早一筆事件是否也落在本期間內。
    const activeVisitorHashRows = db.prepare(`
      SELECT DISTINCT anonymous_visitor_id_hash AS h FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ?
        AND anonymous_visitor_id_hash IS NOT NULL AND anonymous_visitor_id_hash != ''
    `).all(rangeStartIso, rangeEndExclusiveIso);
    const activeVisitorHashArr = activeVisitorHashRows.map(r => r.h);

    let newVisitorCount = 0, returningVisitorCount = 0;
    const firstTouchAgg = new Map();
    if (activeVisitorHashArr.length > 0) {
      const ph = analyticsOverviewSqlPlaceholders(activeVisitorHashArr);
      const globalMinRows = db.prepare(`
        SELECT anonymous_visitor_id_hash AS h, MIN(occurred_at) AS globalMin
        FROM analytics_events WHERE anonymous_visitor_id_hash IN (${ph})
        GROUP BY anonymous_visitor_id_hash
      `).all(...activeVisitorHashArr);
      globalMinRows.forEach(r => { if (r.globalMin >= rangeStartIso) newVisitorCount++; else returningVisitorCount++; });

      // 首次來源：往選定期間以前查完整歷史（不受rangeStartIso/rangeEndExclusiveIso限制），
      // 統計對象限定在本期間有活動的訪客（activeVisitorHashArr）。同一訪客只取最早一筆
      // 具有效來源的事件（ORDER BY occurred_at ASC, id ASC後取第一筆命中）。
      const firstTouchRows = db.prepare(`
        SELECT anonymous_visitor_id_hash AS h, utm_source, utm_medium, utm_campaign, referrer_domain, occurred_at, id
        FROM analytics_events
        WHERE anonymous_visitor_id_hash IN (${ph}) AND ${ANALYTICS_OVERVIEW_VALID_SOURCE_SQL}
        ORDER BY occurred_at ASC, id ASC
      `).all(...activeVisitorHashArr);
      const firstTouchByVisitor = new Map();
      firstTouchRows.forEach(r => { if (!firstTouchByVisitor.has(r.h)) firstTouchByVisitor.set(r.h, r); });

      activeVisitorHashArr.forEach(h => {
        const row = firstTouchByVisitor.get(h);
        const cls = row ? analyticsOverviewClassifySourceRow(row) : ANALYTICS_OVERVIEW_DIRECT_OR_UNKNOWN;
        analyticsOverviewBumpSource(firstTouchAgg, cls);
      });
    }
    const firstTouchSources = analyticsOverviewRankSources(firstTouchAgg, 'visitorCount');

    // 詢價前最後來源：只看選定期間內的可信inquiry_submit_success，以不重複order_id為單位；
    // 針對每筆訂單，往該訪客詢價之前（occurred_at嚴格早於詢價時間）找最晚一筆具有效來源的
    // 事件（沒有來源的內部瀏覽事件天生不會被看到，因為SQL已經先過濾只留有效來源的列）。
    const inquiryOrderRowsRaw = db.prepare(`
      SELECT id, order_id, anonymous_visitor_id_hash AS visitorHash, session_id_hash AS sessionHash, occurred_at
      FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'inquiry_submit_success'
        AND order_id IS NOT NULL AND order_id != ''
      ORDER BY id ASC
    `).all(rangeStartIso, rangeEndExclusiveIso);
    const inquiryByOrderId = new Map();
    inquiryOrderRowsRaw.forEach(r => { if (!inquiryByOrderId.has(r.order_id)) inquiryByOrderId.set(r.order_id, r); });

    const lastTouchBeforeInquiryStmt = db.prepare(`
      SELECT utm_source, utm_medium, utm_campaign, referrer_domain
      FROM analytics_events
      WHERE anonymous_visitor_id_hash = ? AND occurred_at < ? AND ${ANALYTICS_OVERVIEW_VALID_SOURCE_SQL}
      ORDER BY occurred_at DESC, id DESC
      LIMIT 1
    `);
    const lastTouchAgg = new Map();
    let unattributedInquiryCount = 0;
    inquiryByOrderId.forEach(orderRow => {
      let cls = null;
      if (orderRow.visitorHash) {
        const found = lastTouchBeforeInquiryStmt.get(orderRow.visitorHash, orderRow.occurred_at);
        if (found) cls = analyticsOverviewClassifySourceRow(found);
      }
      if (!cls) { cls = ANALYTICS_OVERVIEW_DIRECT_OR_UNKNOWN; unattributedInquiryCount++; }
      analyticsOverviewBumpSource(lastTouchAgg, cls);
    });
    const lastTouchBeforeInquirySources = analyticsOverviewRankSources(lastTouchAgg, 'inquiryCount');

    // landingPages：期間內page_view的landing_path，以不重複session計算；null/空值歸「未知進站頁」
    // （landing_path寫入當下已經套過白名單驗證，不含查詢字串）。
    const landingPageRows = db.prepare(`
      SELECT landing_path, session_id_hash AS h FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'page_view'
        AND session_id_hash IS NOT NULL AND session_id_hash != ''
    `).all(rangeStartIso, rangeEndExclusiveIso);
    const landingPageMap = new Map();
    landingPageRows.forEach(r => {
      const key = (r.landing_path && r.landing_path !== '') ? r.landing_path : '未知進站頁';
      if (!landingPageMap.has(key)) landingPageMap.set(key, new Set());
      landingPageMap.get(key).add(r.h);
    });
    const landingPages = [...landingPageMap.entries()]
      .map(([landingPath, set]) => ({ landingPath, sessionCount: set.size }))
      .sort((a, b) => (b.sessionCount !== a.sessionCount) ? (b.sessionCount - a.sessionCount) : a.landingPath.localeCompare(b.landingPath));

    // devices：固定回傳mobile/tablet/desktop/unknown，以不重複session計算；同一session取期間內
    // 最早一筆「有效」device_type，沒有有效值歸unknown。
    const deviceRows = db.prepare(`
      SELECT session_id_hash AS h, device_type FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ?
        AND session_id_hash IS NOT NULL AND session_id_hash != ''
      ORDER BY occurred_at ASC, id ASC
    `).all(rangeStartIso, rangeEndExclusiveIso);
    const sessionDeviceAssigned = new Map();
    const allDeviceSessions = new Set();
    deviceRows.forEach(r => {
      allDeviceSessions.add(r.h);
      if (!sessionDeviceAssigned.has(r.h) && r.device_type && ANALYTICS_OVERVIEW_VALID_DEVICE_TYPES.includes(r.device_type)) {
        sessionDeviceAssigned.set(r.h, r.device_type);
      }
    });
    const deviceCounts = { mobile: 0, tablet: 0, desktop: 0, unknown: 0 };
    allDeviceSessions.forEach(h => { deviceCounts[sessionDeviceAssigned.get(h) || 'unknown']++; });
    const devices = ['mobile', 'tablet', 'desktop', 'unknown'].map(d => ({ device: d, sessionCount: deviceCounts[d] }));

    const traffic = {
      newVisitorCount, returningVisitorCount,
      firstTouchSources, lastTouchBeforeInquirySources,
      landingPages, devices,
      unattributedInquiryCount
    };

    // ══════════ funnel：客製化轉換漏斗（第二階段第二批）══════════
    // 主漏斗只納入session_id_hash非null/空字串、且選定期間內有page_view的工作階段；後續每一關
    // 判定使用該session在「查詢期間結束以前」的歷史（不下限，允許往期間開始以前找，避免剛好
    // 卡在期間開始邊界的session被截斷；但上限固定卡在rangeEndExclusiveIso，查詢結束日之後才
    // 發生的事件不可以拿來完成歷史上這個期間的漏斗，否則同一個session會隨著時間經過、之後隨便
    // 補做剩下的步驟，就讓「過去某段期間」的漏斗結果一直改變，變成一支會動的箭靶）。
    const funnelEligibleSessionRows = db.prepare(`
      SELECT DISTINCT session_id_hash AS h FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'page_view'
        AND session_id_hash IS NOT NULL AND session_id_hash != ''
    `).all(rangeStartIso, rangeEndExclusiveIso);
    const funnelEligibleSessionArr = funnelEligibleSessionRows.map(r => r.h);

    const stageReachedCounts = new Array(ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS.length).fill(0);
    const sessionsReachingStage = ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS.map(() => new Set());
    // 記錄每個session實際成立customization_start那一筆事件的(occurred_at,id)，供下面AI分支
    // 驗證「ai_request必須晚於這個session真正的customization_start」使用，不能只看session
    // 有沒有到過這一關。
    const customizationStartCursorBySession = new Map();
    // 記錄每個session真正完成漏斗最後一關（詢價成功）時，實際匹配到的那一筆事件的order_id，
    // 不是「這個session名下所有訂單都算」——同一session出現第二筆詢價時，只有真正在漏斗依序
    // 判定裡被用來完成這一關的那筆order_id才算linked，其餘（例如同一session的第二筆詢價）
    // 仍然算unlinked。
    const finalStageOrderIdBySession = new Map();

    if (funnelEligibleSessionArr.length > 0) {
      const ph = analyticsOverviewSqlPlaceholders(funnelEligibleSessionArr);
      const funnelEventRows = db.prepare(`
        SELECT session_id_hash AS h, event_name, step_key, order_id, occurred_at, id
        FROM analytics_events
        WHERE session_id_hash IN (${ph})
          AND occurred_at < ?
          AND event_name IN ('page_view','product_view','customization_start','customization_step_complete','preview_complete','inquiry_form_start','inquiry_submit_success')
        ORDER BY session_id_hash ASC, occurred_at ASC, id ASC
      `).all(...funnelEligibleSessionArr, rangeEndExclusiveIso);

      const eventsBySession = new Map();
      funnelEventRows.forEach(r => {
        if (!eventsBySession.has(r.h)) eventsBySession.set(r.h, []);
        eventsBySession.get(r.h).push(r);
      });

      const CUSTOMIZATION_START_STAGE_INDEX = 2; // ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS[2]
      const FINAL_STAGE_INDEX = ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS.length - 1;

      // 逐session依序判定每一關：每一關只在「同一session、時間不早於上一個已成立步驟」的
      // 事件裡找最早一筆符合的，找不到就停在目前這一關，不會跳關往後找。
      funnelEligibleSessionArr.forEach(h => {
        const events = eventsBySession.get(h) || [];
        let cursorTime = null, cursorId = null;
        for (let i = 0; i < ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS.length; i++) {
          const def = ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS[i];
          let found = null;
          for (const e of events) {
            if (!def.match(e)) continue;
            if (!analyticsOverviewIsAfterCursor(e.occurred_at, e.id, cursorTime, cursorId)) continue;
            found = e;
            break;
          }
          if (!found) break;
          stageReachedCounts[i]++;
          sessionsReachingStage[i].add(h);
          cursorTime = found.occurred_at;
          cursorId = found.id;
          if (i === CUSTOMIZATION_START_STAGE_INDEX) customizationStartCursorBySession.set(h, { time: cursorTime, id: cursorId });
          if (i === FINAL_STAGE_INDEX && found.order_id) finalStageOrderIdBySession.set(h, found.order_id);
        }
      });
    }

    const stages = ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS.map((def, i) => {
      const count = stageReachedCounts[i];
      if (i === 0) {
        return { stageKey: def.key, label: def.label, count, conversionFromPreviousPct: null, dropOffCount: 0, dropOffRatePct: null };
      }
      const prevCount = stageReachedCounts[i - 1];
      // 規則7：每關人數理論上不得大於上一關；這裡只記錄診斷訊息，不用Math.min掩蓋數字本身
      // （演算法本身依序判定，正常情況下不會發生，若發生代表程式邏輯有誤，需要能被看見）。
      if (count > prevCount) {
        console.error(`[analytics-overview] 漏斗計算異常：關卡「${def.key}」人數(${count})大於上一關(${prevCount})，請檢查程式邏輯`);
      }
      const dropOffCount = prevCount - count;
      const conversionFromPreviousPct = prevCount > 0 ? analyticsOverviewRoundPct(count / prevCount * 100) : null;
      const dropOffRatePct = prevCount > 0 ? analyticsOverviewRoundPct(dropOffCount / prevCount * 100) : null;
      return { stageKey: def.key, label: def.label, count, conversionFromPreviousPct, dropOffCount, dropOffRatePct };
    });

    // aiBranch：AI不是主漏斗必經步驟，獨立另外計算，完全不影響上面的stages人數。重用上面
    // summary計算時已經查過的 aiRequestRows／aiResultRows，不再重新查詢一次；但這裡不是只看
    // 「這個session有沒有出現過ai_request/ai_result」，而是嚴格驗證事件先後順序：
    //   customization_start（真正成立的那一筆） → ai_request → ai_result
    // 早於customization_start的ai_request不算數；早於「已匹配到的那筆ai_request」的ai_result
    // 也不算數；同一session有多筆時，一律取依序成立的最早一筆有效事件（不是任意一筆）。
    const customizationStartCount = stageReachedCounts[2]; // ANALYTICS_OVERVIEW_FUNNEL_STAGE_DEFS[2] = customization_start

    let unlinkedAiEventCount = 0;
    const aiRequestsBySession = new Map();
    aiRequestRows.forEach(r => {
      if (!r.h) { unlinkedAiEventCount++; return; }
      if (!aiRequestsBySession.has(r.h)) aiRequestsBySession.set(r.h, []);
      aiRequestsBySession.get(r.h).push(r);
    });
    const aiResultsBySession = new Map();
    aiResultRows.forEach(r => {
      if (!r.h) { unlinkedAiEventCount++; return; }
      if (!aiResultsBySession.has(r.h)) aiResultsBySession.set(r.h, []);
      aiResultsBySession.get(r.h).push(r);
    });
    if (unlinkedAiEventCount > 0) {
      console.error(`[analytics-overview] 本次查詢區間內有 ${unlinkedAiEventCount} 筆 ai_request／ai_result 缺少session關聯，已從AI分支統計中排除，不影響主漏斗，本紀錄不含任何原始資料`);
    }

    const requestSessionSet = new Set();
    const matchedAiRequestBySession = new Map();
    customizationStartCursorBySession.forEach((cursor, h) => {
      const candidates = (aiRequestsBySession.get(h) || []).filter(r => analyticsOverviewIsAfterCursor(r.occurred_at, r.id, cursor.time, cursor.id));
      if (!candidates.length) return;
      candidates.sort((a, b) => (a.occurred_at !== b.occurred_at) ? (a.occurred_at < b.occurred_at ? -1 : 1) : (a.id - b.id));
      requestSessionSet.add(h);
      matchedAiRequestBySession.set(h, candidates[0]);
    });

    const successSessionSet = new Set();
    matchedAiRequestBySession.forEach((matchedRequest, h) => {
      const candidates = (aiResultsBySession.get(h) || []).filter(r => analyticsOverviewIsAfterCursor(r.occurred_at, r.id, matchedRequest.occurred_at, matchedRequest.id));
      if (!candidates.length) return;
      candidates.sort((a, b) => (a.occurred_at !== b.occurred_at) ? (a.occurred_at < b.occurred_at ? -1 : 1) : (a.id - b.id));
      const cls = analyticsOverviewClassifyAiResultMetadata(candidates[0].metadata_json);
      if (!cls.isAnomaly && cls.result === 'success') successSessionSet.add(h);
    });

    const requestSessionCount = requestSessionSet.size;
    const successSessionCount = successSessionSet.size;
    const adoptionRatePct = customizationStartCount > 0 ? analyticsOverviewRoundPct(requestSessionCount / customizationStartCount * 100) : null;
    const successRatePct = requestSessionCount > 0 ? analyticsOverviewRoundPct(successSessionCount / requestSessionCount * 100) : null;
    const aiBranch = { requestSessionCount, successSessionCount, adoptionRatePct, successRatePct };

    // unlinkedInquiryCount：選定期間內可信詢價訂單數，減掉「真正在漏斗依序判定裡被用來完成
    // 詢價成功這一關」的那些order_id數量——用finalStageOrderIdBySession（每個session最多
    // 只會有一筆真正匹配到的order_id），不是「這個session有沒有到過最後一關」這種session
    // 層級的粗略判斷，避免同一session的第二筆、第三筆詢價被一起誤判為已連結。
    const linkedOrderIdSet = new Set(finalStageOrderIdBySession.values());
    let linkedInquiryOrderCount = 0;
    inquiryByOrderId.forEach((orderRow, orderId) => {
      if (linkedOrderIdSet.has(orderId)) linkedInquiryOrderCount++;
    });
    const unlinkedInquiryCount = inquiryByOrderId.size - linkedInquiryOrderCount;

    const funnel = { unit: 'sessions', stages, aiBranch, unlinkedInquiryCount };

    // ══════════ productPreference：商品／客製化／AI偏好分析（第二階段第三批）══════════
    const analyticsOverviewProductRows = db.prepare('SELECT id, name, status, archived_at FROM products').all();
    const analyticsOverviewProductById = new Map(analyticsOverviewProductRows.map(p => [p.id, p]));

    // 商品瀏覽起始游標：每組(product_id, session_id_hash)取本期（rangeStartIso~rangeEndExclusiveIso）
    // 內最早一筆product_view的(occurred_at,id)當作這個session在商品漏斗的起點。這是每個商品判定
    // 資格的「入口」，也是下面依序漏斗判定的起始游標——Codex獨立複驗發現的缺陷：漏斗原本只限制
    // 查詢結束時間（occurred_at < rangeEndExclusiveIso），沒有從「本期真正命中的product_view事件」
    // 開始計算游標，導致同一session若在查詢期間開始之前就已經走完完整漏斗，會被誤判成本期也
    // 完整成立（借用了期間之前的舊事件）。改成先鎖定本期實際發生的product_view時間點，後續三關
    // 必須嚴格晚於這個時間點才算數，不再從cursor=null（等同「不限時間，隨便找最早一筆」）開始找。
    const productViewCursorRows = db.prepare(`
      SELECT product_id AS pid, session_id_hash AS h, occurred_at, id FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'product_view'
        AND product_id IS NOT NULL AND product_id != '' AND session_id_hash IS NOT NULL AND session_id_hash != ''
      ORDER BY product_id ASC, session_id_hash ASC, occurred_at ASC, id ASC
    `).all(rangeStartIso, rangeEndExclusiveIso);
    const productViewCursorMap = new Map(); // pid -> Map(session -> {occurred_at, id})，取本期最早一筆
    productViewCursorRows.forEach(r => {
      if (!productViewCursorMap.has(r.pid)) productViewCursorMap.set(r.pid, new Map());
      const sessMap = productViewCursorMap.get(r.pid);
      if (!sessMap.has(r.h)) sessMap.set(r.h, { occurred_at: r.occurred_at, id: r.id }); // 已依時間升冪排序，第一次出現即最早一筆
    });
    // 期間內每個商品可信、不重複的詢價訂單總數（「詢價量」，跟下面依序漏斗算出的
    // linkedInquirySessionCount是兩個不同單位的數字，不可直接相除）。
    const inquiryByProductMap = new Map();
    db.prepare(`
      SELECT product_id AS pid, order_id AS oid FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'inquiry_submit_success'
        AND product_id IS NOT NULL AND product_id != '' AND order_id IS NOT NULL AND order_id != ''
    `).all(rangeStartIso, rangeEndExclusiveIso).forEach(r => {
      if (!inquiryByProductMap.has(r.pid)) inquiryByProductMap.set(r.pid, new Set());
      inquiryByProductMap.get(r.pid).add(r.oid);
    });

    // Codex獨立複驗發現的缺陷：商品各階段原本各自獨立計算不重複session／order後直接相除，
    // 沒有確認同一session依序完成前後兩關，導致customization_start能大於product_view、
    // 轉換率可能超過100%（前端isValidPct只接受0~100，格式驗證失敗）；第一次修正後又發現漏斗
    // 只限制結束時間、沒有從本期實際命中的product_view事件開始算游標，導致借用查詢期間開始
    // 之前、同一session的舊完整漏斗（本期只有新的product_view，卻回傳已完成全部關卡）。
    // 修正為商品層級的依序漏斗：以productViewCursorMap鎖定的本期product_view時間點為起點，
    // 依序尋找 customization_start → preview_complete → inquiry_submit_success，以同一product_id、
    // 同一session_id_hash為單位，後一關事件必須嚴格晚於前一關（同時間用id判斷，重用跟主漏斗、
    // AI事件先後判定同一支analyticsOverviewIsAfterCursor()），所有匹配事件都不得晚於
    // rangeEndExclusiveIso，找不到上一關就不成立下一關，不同商品／不同session不可拼接，每個
    // session每一關最多計算一次——因此customizationStartSessionCount／previewCompleteSessionCount／
    // linkedInquirySessionCount天生是productViewSessionCount的巢狀子集合，比例保證落在0~100之間，
    // 不需要、也不可以用Math.min／Math.max硬裁切掩蓋演算法本身的錯誤。
    const PRODUCT_FUNNEL_FOLLOWUP_STAGE_DEFS = [
      { match: e => e.event_name === 'customization_start' },
      { match: e => e.event_name === 'preview_complete' },
      { match: e => e.event_name === 'inquiry_submit_success' }
    ];
    function analyticsOverviewComputeProductFunnel(pid, sessionCursorMap) {
      const sessionArr = [...sessionCursorMap.keys()];
      const result = { customizationStartSessionCount: 0, previewCompleteSessionCount: 0, linkedInquirySessionCount: 0, linkedOrderIdSet: new Set() };
      if (sessionArr.length === 0) return result;
      const ph = analyticsOverviewSqlPlaceholders(sessionArr);
      // 只查後三關（product_view已經由sessionCursorMap確立起始游標，不需要也不可以再重新從
      // 完整歷史尋找一次第一關，那正是先前借用舊事件的成因）。
      const rows = db.prepare(`
        SELECT session_id_hash AS h, event_name, order_id, occurred_at, id
        FROM analytics_events
        WHERE session_id_hash IN (${ph}) AND product_id = ? AND occurred_at < ?
          AND event_name IN ('customization_start','preview_complete','inquiry_submit_success')
        ORDER BY session_id_hash ASC, occurred_at ASC, id ASC
      `).all(...sessionArr, pid, rangeEndExclusiveIso);

      const eventsBySession = new Map();
      rows.forEach(r => {
        if (!eventsBySession.has(r.h)) eventsBySession.set(r.h, []);
        eventsBySession.get(r.h).push(r);
      });

      sessionArr.forEach(h => {
        const startCursor = sessionCursorMap.get(h);
        const events = eventsBySession.get(h) || [];
        let cursorTime = startCursor.occurred_at, cursorId = startCursor.id, reachedIdx = -1, matchedOrderId = null;
        for (let i = 0; i < PRODUCT_FUNNEL_FOLLOWUP_STAGE_DEFS.length; i++) {
          let found = null;
          for (const e of events) {
            if (!PRODUCT_FUNNEL_FOLLOWUP_STAGE_DEFS[i].match(e)) continue;
            if (!analyticsOverviewIsAfterCursor(e.occurred_at, e.id, cursorTime, cursorId)) continue;
            found = e; break;
          }
          if (!found) break;
          reachedIdx = i;
          cursorTime = found.occurred_at; cursorId = found.id;
          if (i === PRODUCT_FUNNEL_FOLLOWUP_STAGE_DEFS.length - 1 && found.order_id) matchedOrderId = found.order_id;
        }
        if (reachedIdx >= 0) result.customizationStartSessionCount++;
        if (reachedIdx >= 1) result.previewCompleteSessionCount++;
        if (reachedIdx >= 2) {
          result.linkedInquirySessionCount++;
          if (matchedOrderId) result.linkedOrderIdSet.add(matchedOrderId);
        }
      });
      return result;
    }

    // 只納入有查看過的商品，且必須連回正式products資料（商品事件寫入當下已驗證商品存在，
    // 這裡再次以products資料表為準，不維護第二份商品名稱清單；理論上不會出現查不到的
    // product_id，若真的發生一律安全略過，不可以顯示查不到名稱的商品）。
    const productPreferenceRows = [...productViewCursorMap.keys()]
      .map(pid => {
        const product = analyticsOverviewProductById.get(pid);
        if (!product) return null;
        const sessionCursorMap = productViewCursorMap.get(pid);
        const productViewSessionCount = sessionCursorMap.size;
        const funnelResult = analyticsOverviewComputeProductFunnel(pid, sessionCursorMap);
        const { customizationStartSessionCount, previewCompleteSessionCount, linkedInquirySessionCount, linkedOrderIdSet } = funnelResult;
        const inquiryOrderIdSet = inquiryByProductMap.get(pid) || new Set();
        const inquiryOrderCount = inquiryOrderIdSet.size;
        // 無法安全連回商品依序漏斗的詢價訂單，不可以猜測關聯，另外老實列出筆數。用集合交集
        // （本期inquiryOrderIdSet裡「沒有」被漏斗實際匹配到的order_id）計算，而不是用
        // inquiryOrderCount - linkedOrderIdSet.size直接相減——即使漏斗匹配出的order_id理論上
        // 因為某個未預期的邊界情況而不屬於inquiryOrderIdSet，這裡也保證天生落在
        // 0~inquiryOrderCount之間，不需要、也不可以用Math.max(0, ...)掩蓋演算法本身可能的錯誤。
        const unlinkedInquiryOrderCount = [...inquiryOrderIdSet].filter(oid => !linkedOrderIdSet.has(oid)).length;

        const productViewToCustomizationStartPct = productViewSessionCount > 0 ? analyticsOverviewRoundPct(customizationStartSessionCount / productViewSessionCount * 100) : null;
        const customizationStartToPreviewPct = customizationStartSessionCount > 0 ? analyticsOverviewRoundPct(previewCompleteSessionCount / customizationStartSessionCount * 100) : null;
        const previewToInquiryPct = previewCompleteSessionCount > 0 ? analyticsOverviewRoundPct(linkedInquirySessionCount / previewCompleteSessionCount * 100) : null;
        const overallProductViewToInquiryPct = productViewSessionCount > 0 ? analyticsOverviewRoundPct(linkedInquirySessionCount / productViewSessionCount * 100) : null;

        let highViewLowInquiry = null;
        if (productViewSessionCount >= ANALYTICS_OVERVIEW_LOW_INQUIRY_MIN_VIEW_SESSIONS) {
          highViewLowInquiry = (overallProductViewToInquiryPct === null || overallProductViewToInquiryPct < ANALYTICS_OVERVIEW_LOW_INQUIRY_MAX_RATE_PCT);
        }
        let highInquiryLowExposure = null;
        if (productViewSessionCount < ANALYTICS_OVERVIEW_UNDEREXPOSED_MAX_VIEW_SESSIONS && inquiryOrderCount >= ANALYTICS_OVERVIEW_UNDEREXPOSED_MIN_INQUIRY_ORDERS) {
          highInquiryLowExposure = (overallProductViewToInquiryPct !== null && overallProductViewToInquiryPct >= ANALYTICS_OVERVIEW_UNDEREXPOSED_MIN_RATE_PCT);
        }

        return {
          productId: pid, productName: product.name, productStatus: product.status, archived: !!product.archived_at,
          productViewSessionCount, customizationStartSessionCount, previewCompleteSessionCount,
          inquiryOrderCount, linkedInquirySessionCount, unlinkedInquiryOrderCount,
          productViewToCustomizationStartPct, customizationStartToPreviewPct, previewToInquiryPct, overallProductViewToInquiryPct,
          highViewLowInquiry, highInquiryLowExposure
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.productViewSessionCount !== a.productViewSessionCount) ? (b.productViewSessionCount - a.productViewSessionCount) : (a.productId < b.productId ? -1 : (a.productId > b.productId ? 1 : 0)));

    // 客製化與AI偏好：規格／設計步驟完成、上傳成功率、AI各功能使用結果，皆只用可信／既有欄位；
    // 材質、工藝、容量、顏色目前的分析事件沒有保存分類值（見規劃書第六節事件字典），明確標示
    // 「目前尚未蒐集」，不可以從其他文字或圖片猜測。
    const specCompleteSessionCount = new Set(db.prepare(`
      SELECT DISTINCT session_id_hash AS h FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'customization_step_complete' AND step_key = 'specification'
        AND session_id_hash IS NOT NULL AND session_id_hash != ''
    `).all(rangeStartIso, rangeEndExclusiveIso).map(r => r.h)).size;
    const designCompleteSessionCount = new Set(db.prepare(`
      SELECT DISTINCT session_id_hash AS h FROM analytics_events
      WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'customization_step_complete' AND step_key = 'design'
        AND session_id_hash IS NOT NULL AND session_id_hash != ''
    `).all(rangeStartIso, rangeEndExclusiveIso).map(r => r.h)).size;

    const uploadResultRows = db.prepare(`SELECT metadata_json FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'upload_result'`).all(rangeStartIso, rangeEndExclusiveIso);
    let uploadSuccessCount = 0, uploadFailureCount = 0, uploadAnomalyCount = 0;
    const uploadErrorCategoryMap = new Map();
    uploadResultRows.forEach(row => {
      let meta = null, parseFailed = false;
      if (row.metadata_json) { try { meta = JSON.parse(row.metadata_json); } catch (e) { parseFailed = true; } }
      const isPlainObject = !parseFailed && meta !== null && typeof meta === 'object' && !Array.isArray(meta);
      const result = isPlainObject && typeof meta.result === 'string' ? meta.result : null;
      if (!isPlainObject || (result !== 'success' && result !== 'failure')) { uploadAnomalyCount++; return; }
      if (result === 'success') { uploadSuccessCount++; return; }
      uploadFailureCount++;
      const cat = (typeof meta.errorCategory === 'string' && meta.errorCategory) ? meta.errorCategory : '未分類';
      uploadErrorCategoryMap.set(cat, (uploadErrorCategoryMap.get(cat) || 0) + 1);
    });
    if (uploadAnomalyCount > 0) {
      console.error(`[analytics-overview] 本次查詢區間內有 ${uploadAnomalyCount} 筆 upload_result 的 metadata_json 格式異常，已安全忽略、不計入成功／失敗統計，本紀錄不含metadata原文`);
    }
    const uploadErrorBreakdown = [...uploadErrorCategoryMap.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => (b.count !== a.count) ? (b.count - a.count) : a.category.localeCompare(b.category));

    // AI各功能使用結果：依feature_key固定回傳4支既有功能，即使本期沒有資料也回傳0，不遺漏
    // 任何一支功能；重用summary/funnel已經查過的可信ai_request／ai_result同一份期間條件，
    // 這裡另外依feature_key分組查一次（同一份資料的不同分組角度，不是重複認定業務結果）。
    // requestCount 是期間內該功能全部ai_request筆數（跟既有summary.aiRequestCount同一套定義，
    // 不做配對篩選）；但successCount／partialCount／failureCount 必須來自「同一session_id_hash
    // ＋同一feature_key、時間確實晚於某筆尚未被用過的ai_request」的一對一配對結果，孤立、
    // 找不到可配對request、或request已經被更早的result用掉的result，一律算unlinkedResultCount、
    // 不計入任何結果分類，確保 successCount+partialCount+failureCount 不會大於 requestCount
    // （Codex獨立複驗發現的缺陷：原本直接各自加總後相除，沒有驗證request／result的先後配對）。
    const aiRequestByFeatureRows = db.prepare(`SELECT feature_key AS fk, session_id_hash AS h, occurred_at, id FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'ai_request'`).all(rangeStartIso, rangeEndExclusiveIso);
    const aiResultByFeatureRows = db.prepare(`SELECT feature_key AS fk, session_id_hash AS h, metadata_json, occurred_at, id FROM analytics_events WHERE occurred_at >= ? AND occurred_at < ? AND event_name = 'ai_result'`).all(rangeStartIso, rangeEndExclusiveIso);

    const aiRequestCountByFeature = new Map();
    aiRequestByFeatureRows.forEach(r => { aiRequestCountByFeature.set(r.fk, (aiRequestCountByFeature.get(r.fk) || 0) + 1); });

    // 依 session_id_hash＋feature_key 分組、依(occurred_at,id)排序，做先進先出的一對一配對：
    // 每筆result只能領走「同一組裡尚未被用過、且確實比自己更早」的最舊一筆request，配對過的
    // request立刻從佇列移除，不會被第二筆result重複借用。沒有session關聯的request天生無法
    // 進入任何配對群組，只計入requestCount，不影響任何result的配對結果。
    const requestQueueByGroup = new Map(); // "${h}|${fk}" -> 依時間升冪排列、尚未被配對的request佇列
    [...aiRequestByFeatureRows]
      .filter(r => r.h)
      .sort((a, b) => (a.occurred_at !== b.occurred_at) ? (a.occurred_at < b.occurred_at ? -1 : 1) : (a.id - b.id))
      .forEach(r => {
        const key = `${r.h}|${r.fk}`;
        if (!requestQueueByGroup.has(key)) requestQueueByGroup.set(key, []);
        requestQueueByGroup.get(key).push(r);
      });

    const aiResultCountByFeature = new Map();
    const unlinkedResultCountByFeature = new Map();
    [...aiResultByFeatureRows]
      .sort((a, b) => (a.occurred_at !== b.occurred_at) ? (a.occurred_at < b.occurred_at ? -1 : 1) : (a.id - b.id))
      .forEach(r => {
        const cls = analyticsOverviewClassifyAiResultMetadata(r.metadata_json);
        if (cls.isAnomaly) return; // 已在summary計算時輸出過異常摘要，這裡不重複輸出
        const key = r.h ? `${r.h}|${r.fk}` : null;
        const queue = key ? requestQueueByGroup.get(key) : null;
        const matched = (queue && queue.length > 0 && analyticsOverviewIsAfterCursor(r.occurred_at, r.id, queue[0].occurred_at, queue[0].id))
          ? queue.shift() : null;
        if (!matched) {
          unlinkedResultCountByFeature.set(r.fk, (unlinkedResultCountByFeature.get(r.fk) || 0) + 1);
          return;
        }
        if (!aiResultCountByFeature.has(r.fk)) aiResultCountByFeature.set(r.fk, { success: 0, partial: 0, failure: 0 });
        aiResultCountByFeature.get(r.fk)[cls.result]++;
      });

    const aiByFeature = ANALYTICS_OVERVIEW_AI_FEATURE_KEYS.map(fk => {
      const requestCount = aiRequestCountByFeature.get(fk) || 0;
      const resultCounts = aiResultCountByFeature.get(fk) || { success: 0, partial: 0, failure: 0 };
      const successRatePct = requestCount > 0 ? analyticsOverviewRoundPct(resultCounts.success / requestCount * 100) : null;
      return {
        featureKey: fk, requestCount,
        successCount: resultCounts.success, partialCount: resultCounts.partial, failureCount: resultCounts.failure,
        successRatePct, unlinkedResultCount: unlinkedResultCountByFeature.get(fk) || 0
      };
    });

    const productPreference = {
      products: productPreferenceRows,
      customizationAiPreference: {
        specificationCompleteSessionCount: specCompleteSessionCount,
        designCompleteSessionCount: designCompleteSessionCount,
        upload: { successCount: uploadSuccessCount, failureCount: uploadFailureCount, errorBreakdown: uploadErrorBreakdown },
        aiByFeature,
        notCollected: ['材質', '工藝', '容量', '顏色']
      }
    };

    // ══════════ operationalEfficiency：業務與內部效率分析（第二階段第三批）══════════
    // 母體：以詢價建立時間（savedAt）落在查詢期間內的訂單為統計母體（固定歸屬規則）；
    // 積壓／逾期是「目前」快照，刻意不受查詢期間限制（見下方個別欄位註解）。
    const allOrdersForEfficiency = readAllOrdersSafe();
    const periodOrdersForEfficiency = allOrdersForEfficiency.filter(o => o && typeof o.savedAt === 'string' && o.savedAt >= rangeStartIso && o.savedAt < rangeEndExclusiveIso);

    function analyticsOverviewCollectDurations(orders, fromStatusOrSaved, toStatus) {
      const values = [];
      let invalidCount = 0;
      orders.forEach(o => {
        const fromIso = fromStatusOrSaved === 'savedAt' ? o.savedAt : analyticsOverviewFirstReachedAt(o, fromStatusOrSaved);
        const diff = analyticsOverviewDiffMs(fromIso, analyticsOverviewFirstReachedAt(o, toStatus));
        if (diff === null) invalidCount++;
        else values.push(diff);
      });
      return { ...analyticsOverviewComputeStats(values), invalidCount };
    }

    const inquiryToFirstQuote = analyticsOverviewCollectDurations(periodOrdersForEfficiency, 'savedAt', 'quoted');
    const quotedToClosedWon = analyticsOverviewCollectDurations(periodOrdersForEfficiency, 'quoted', 'closed_won');
    const closedWonToInProduction = analyticsOverviewCollectDurations(periodOrdersForEfficiency, 'closed_won', 'in_production');
    const inProductionToShipped = analyticsOverviewCollectDurations(periodOrdersForEfficiency, 'in_production', 'shipped');
    const inquiryToShippedTotal = analyticsOverviewCollectDurations(periodOrdersForEfficiency, 'savedAt', 'shipped');

    const cancelledCount = periodOrdersForEfficiency.filter(o => o.status === 'cancelled').length;
    const cancelRatePct = periodOrdersForEfficiency.length > 0 ? analyticsOverviewRoundPct(cancelledCount / periodOrdersForEfficiency.length * 100) : null;

    // 各狀態目前積壓數量／預估逾期訂單數：跟既有GET /dashboard的PRODUCTION_STATUSES／leadDays
    // 推算同一套規則，刻意不受查詢期間限制（積壓與逾期問的是「現在」卡在哪裡，不是「當時新增
    // 的訂單後來怎麼樣了」）。
    const currentBacklogMap = {};
    Object.keys(ANALYTICS_OVERVIEW_ORDER_STATUS_LABELS).forEach(s => { currentBacklogMap[s] = 0; });
    let currentBacklogOtherCount = 0;
    const OPERATIONAL_OVERDUE_ELIGIBLE_STATUSES = ['closed_won', 'in_production', 'qc', 'ready_to_ship'];
    let overdueCount = 0;
    const nowMsForOverdue = Date.now();
    allOrdersForEfficiency.forEach(o => {
      const status = o.status || 'new_inquiry';
      if (Object.prototype.hasOwnProperty.call(currentBacklogMap, status)) currentBacklogMap[status]++;
      else currentBacklogOtherCount++;

      // 跟 GET /dashboard 共用同一支 computeEstimatedDeadlineUtcMs()，確保同一筆訂單在兩支API的
      // 逾期判定完全一致（Codex獨立複驗發現的缺陷：兩邊原本各自維護一份不同的推算公式）。
      if (OPERATIONAL_OVERDUE_ELIGIBLE_STATUSES.includes(status)) {
        const deadlineMs = computeEstimatedDeadlineUtcMs(o.savedAt, o.quote?.leadDays);
        if (deadlineMs !== null && nowMsForOverdue > deadlineMs) overdueCount++;
      }
    });
    const currentBacklog = [...ANALYTICS_OVERVIEW_ORDER_STATUS_FLOW, 'cancelled']
      .map(s => ({ status: s, label: ANALYTICS_OVERVIEW_ORDER_STATUS_LABELS[s], count: currentBacklogMap[s] }))
      .concat(currentBacklogOtherCount > 0 ? [{ status: 'other', label: '其他', count: currentBacklogOtherCount }] : []);

    const operationalEfficiency = {
      population: { orderCount: periodOrdersForEfficiency.length },
      timings: { inquiryToFirstQuote, quotedToClosedWon, closedWonToInProduction, inProductionToShipped, inquiryToShippedTotal },
      cancelledCount, cancelRatePct,
      currentBacklog,
      overdueCount,
      notCollected: [
        '詢價到首次回覆時間（系統沒有獨立於「已報價」之外的回覆狀態，無法與首次報價時間區分，已合併為「詢價到首次報價時間」）',
        '準時交期率（尚無正式交期承諾欄位，只能用leadDays推算逾期，不等同正式準時率）'
      ]
    };

    // ══════════ customerOrderValue：顧客與訂單價值分析（第二階段第三批）══════════
    // 正式成交定義：排除cancelled／closed_lost（沿用既有CUSTOMER_REVENUE_EXCLUDED_STATUSES），
    // 且訂單必須已經到達closed_won（含之後的生產/出貨/完成狀態），跟既有GET /dashboard的
    // reachedFunnelStages()判斷「是否曾經到達closed_won」同一套邏輯精神，這裡獨立實作一份
    // （同一檔案其他路由的既有慣例，不跨路由共用內部變數）。
    function analyticsOverviewOrderReachedClosedWon(order) {
      if (analyticsOverviewFirstReachedAt(order, 'closed_won')) return true;
      const status = order.status || 'new_inquiry';
      return ANALYTICS_OVERVIEW_ORDER_STATUS_FLOW.indexOf(status) >= ANALYTICS_OVERVIEW_ORDER_STATUS_FLOW.indexOf('closed_won');
    }

    const allOrdersForCustomerValue = readAllOrdersSafe();
    const formalDealOrders = allOrdersForCustomerValue.filter(o =>
      o && typeof o === 'object' && o.orderId &&
      !CUSTOMER_REVENUE_EXCLUDED_STATUSES.includes(o.status) &&
      analyticsOverviewOrderReachedClosedWon(o)
    );

    // 每筆正式成交訂單的「成交時間」＝statusHistory裡第一次變成closed_won的changedAt；找不到
    // （例如沒有statusHistory的舊資料）就無法判定成交時間，不可以用savedAt頂替，只能明確列入
    // 無法判定成交時間的筆數、並排除在新客/回購客/距今天數等依成交時間分期間的統計之外。
    let closedWonAtUnknownCount = 0;
    const dealsWithClosedWonAt = formalDealOrders.map(o => {
      const closedWonAt = analyticsOverviewFirstReachedAt(o, 'closed_won');
      if (!closedWonAt) closedWonAtUnknownCount++;
      const customerId = resolvePrimaryCustomerId(buildCustomerId(buildCustomerKey(o)));
      const amount = normalizeCustomerAmount(o.quote?.total);
      return { closedWonAt, customerId, amount };
    });

    const dealsInPeriod = dealsWithClosedWonAt.filter(d => d.closedWonAt && d.closedWonAt >= rangeStartIso && d.closedWonAt < rangeEndExclusiveIso);
    let amountAnomalyCount = 0;
    dealsInPeriod.forEach(d => { if (d.amount === null) amountAnomalyCount++; });

    const dealOrderCount = dealsInPeriod.length;
    const dealCustomerIdSet = new Set(dealsInPeriod.map(d => d.customerId));
    const dealCustomerCount = dealCustomerIdSet.size;

    // 每位顧客（依合併後主要customerId）全歷史（不受查詢期間限制）最早一次／最近一次正式
    // 成交時間、全歷史正式成交總筆數，用來判斷新客／回購客與距離上次成交天數。成交時間未知的
    // 訂單不參與任何依時間排序/分期的計算（見上面closedWonAtUnknownCount）。
    const customerFirstDealAt = new Map();
    const customerDealCountLifetime = new Map();
    const customerLastDealAt = new Map();
    dealsWithClosedWonAt.forEach(d => {
      if (!d.closedWonAt) return;
      customerDealCountLifetime.set(d.customerId, (customerDealCountLifetime.get(d.customerId) || 0) + 1);
      if (!customerFirstDealAt.has(d.customerId) || d.closedWonAt < customerFirstDealAt.get(d.customerId)) customerFirstDealAt.set(d.customerId, d.closedWonAt);
      if (!customerLastDealAt.has(d.customerId) || d.closedWonAt > customerLastDealAt.get(d.customerId)) customerLastDealAt.set(d.customerId, d.closedWonAt);
    });

    let newCustomerCount = 0, returningCustomerCount = 0;
    dealCustomerIdSet.forEach(cid => {
      const firstAt = customerFirstDealAt.get(cid);
      if (firstAt && firstAt >= rangeStartIso && firstAt < rangeEndExclusiveIso) newCustomerCount++;
      if ((customerDealCountLifetime.get(cid) || 0) >= 2) returningCustomerCount++;
    });
    const repurchaseRatePct = dealCustomerCount > 0 ? analyticsOverviewRoundPct(returningCustomerCount / dealCustomerCount * 100) : null;

    const validAmounts = dealsInPeriod.map(d => d.amount).filter(a => a !== null);
    const amountStats = analyticsOverviewComputeStats(validAmounts);
    const avgDealAmount = amountStats.meanMs;
    const medianDealAmount = amountStats.medianMs;
    const cumulativeDealAmount = validAmounts.reduce((s, v) => s + v, 0);
    const avgDealsPerCustomer = dealCustomerCount > 0 ? Math.round((dealOrderCount / dealCustomerCount) * 10) / 10 : null;

    // 距離上次成交天數分布：以本次查詢的期間結束邊界（rangeEndExclusiveIso）為錨點，對象是
    // 「本期間內有正式成交」的顧客，取其（不限期間）最近一次正式成交時間計算天數，固定5個桶，
    // 確保同一份資料不論何時重新查詢，只要期間參數相同，結果就完全一致（不用「現在」當錨點）。
    const DAYS_BUCKETS = [
      { key: '0-30', label: '0-30天', maxDays: 30 },
      { key: '31-90', label: '31-90天', maxDays: 90 },
      { key: '91-180', label: '91-180天', maxDays: 180 },
      { key: '181-365', label: '181-365天', maxDays: 365 },
      { key: '365+', label: '365天以上', maxDays: Infinity }
    ];
    const daysSinceLastDealCounts = DAYS_BUCKETS.map(b => ({ ...b, count: 0 }));
    const anchorMs = new Date(rangeEndExclusiveIso).getTime();
    dealCustomerIdSet.forEach(cid => {
      const lastAt = customerLastDealAt.get(cid);
      if (!lastAt) return;
      const days = Math.floor((anchorMs - new Date(lastAt).getTime()) / 86400000);
      if (!Number.isFinite(days) || days < 0) return;
      const bucket = daysSinceLastDealCounts.find(b => days <= b.maxDays);
      if (bucket) bucket.count++;
    });

    const customerOrderValue = {
      dealOrderCount, dealCustomerCount, newCustomerCount, returningCustomerCount, repurchaseRatePct,
      avgDealAmount, medianDealAmount, cumulativeDealAmount, avgDealsPerCustomer,
      daysSinceLastDealDistribution: daysSinceLastDealCounts.map(b => ({ bucket: b.key, label: b.label, customerCount: b.count })),
      closedWonAtUnknownCount, amountAnomalyCount
    };

    res.json({
      success: true,
      period: { from: fromStr, to: toStr, timezone: 'Asia/Taipei' },
      summary: {
        eventCount, visitorCount, sessionCount, inquiryCount, aiRequestCount, aiSuccessCount
      },
      eventBreakdown,
      dataRange: {
        earliestOccurredAt: dataRangeRow.earliest || null,
        latestOccurredAt: dataRangeRow.latest || null
      },
      traffic,
      funnel,
      productPreference,
      operationalEfficiency,
      customerOrderValue
    });
  });

  // ─── API：網站分析匯出Excel（頁面上全部資料：摘要／事件明細／重點摘要／流量來源／
  // 轉換漏斗／商品偏好／AI功能使用／上傳失敗分類／業務時效／待處理訂單／顧客成交天數分布）
  // 「網站分析」頁面資料是前端已經算好、正在畫面上顯示的那份，這裡不重新查一次資料庫——
  // 原因跟訂單／商品匯出一樣：畫面上看到的內容要跟下載的內容保證一致，不要兩邊各自算一次
  // 有可能對不上。所有分頁的資料（含重點摘要）都是前端算好才傳過來，後端只負責把每組資料
  // 轉成同一個活頁簿裡對應的分頁，不涉及任何業務邏輯判斷。
  router.post('/analytics/export', requirePermission('analytics', 'view'), csrfProtection, async (req, res) => {
    const arr = key => Array.isArray(req.body?.[key]) ? req.body[key] : [];
    const summaryRows = arr('summaryRows');
    const eventRows = arr('eventRows');
    const insightRows = arr('insightRows');
    const trafficRows = arr('trafficRows');
    const funnelRows = arr('funnelRows');
    const productPrefRows = arr('productPrefRows');
    const aiFeatureRows = arr('aiFeatureRows');
    const uploadErrorRows = arr('uploadErrorRows');
    const timingRows = arr('timingRows');
    const backlogRows = arr('backlogRows');
    const daysDistributionRows = arr('daysDistributionRows');
    const allEmpty = [summaryRows, eventRows, insightRows, trafficRows, funnelRows, productPrefRows,
      aiFeatureRows, uploadErrorRows, timingRows, backlogRows, daysDistributionRows].every(a => !a.length);
    if (allEmpty) {
      return res.status(400).json({ error: '目前沒有可以匯出的分析資料' });
    }
    // 這幾份資料本來就是固定筆數的摘要／字典／商品清單，上限只是防禦性保護，不是預期會用到的正常上限
    const cap = a => a.slice(0, 2000);
    const str = v => String(v ?? '');
    const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
    try {
      const buffer = await buildMultiSheetXlsxBuffer([
        { name: '摘要總覽', columns: [{ header: '指標', key: 'label', width: 26 }, { header: '數值', key: 'value', width: 30 }],
          rows: cap(summaryRows).map(r => ({ label: str(r?.label), value: str(r?.value) })) },
        { name: '事件明細', columns: [{ header: '事件名稱', key: 'label', width: 22 }, { header: '筆數', key: 'count', width: 12 }],
          rows: cap(eventRows).map(r => ({ label: str(r?.label), count: num(r?.count) })) },
        { name: '重點摘要', columns: [{ header: '項目', key: 'label', width: 30 }, { header: '內容', key: 'value', width: 60 }],
          rows: cap(insightRows).map(r => ({ label: str(r?.label), value: str(r?.value) })) },
        { name: '流量來源明細', columns: [{ header: '類型', key: 'type', width: 18 }, { header: '名稱', key: 'name', width: 30 }, { header: '數值', key: 'count', width: 12 }],
          rows: cap(trafficRows).map(r => ({ type: str(r?.type), name: str(r?.name), count: num(r?.count) })) },
        { name: '轉換漏斗', columns: [
            { header: '階段', key: 'stage', width: 18 }, { header: '人數', key: 'count', width: 10 },
            { header: '上一階段轉換率', key: 'conversionFromPreviousPct', width: 16 },
            { header: '流失人數', key: 'dropOffCount', width: 10 }, { header: '流失率', key: 'dropOffRatePct', width: 12 }
          ], rows: cap(funnelRows).map(r => ({
            stage: str(r?.stage), count: num(r?.count), conversionFromPreviousPct: str(r?.conversionFromPreviousPct),
            dropOffCount: num(r?.dropOffCount), dropOffRatePct: str(r?.dropOffRatePct)
          })) },
        { name: '商品偏好明細', columns: [
            { header: '商品名稱', key: 'productName', width: 22 }, { header: '商品瀏覽', key: 'productViewSessionCount', width: 10 },
            { header: '開始客製化', key: 'customizationStartSessionCount', width: 10 }, { header: '完成預覽', key: 'previewCompleteSessionCount', width: 10 },
            { header: '詢價筆數', key: 'inquiryOrderCount', width: 10 }, { header: '已連結詢價session', key: 'linkedInquirySessionCount', width: 14 },
            { header: '未連結詢價筆數', key: 'unlinkedInquiryOrderCount', width: 12 }, { header: '瀏覽→客製化', key: 'productViewToCustomizationStartPct', width: 12 },
            { header: '客製化→預覽', key: 'customizationStartToPreviewPct', width: 12 }, { header: '預覽→詢價', key: 'previewToInquiryPct', width: 12 },
            { header: '整體瀏覽→詢價', key: 'overallProductViewToInquiryPct', width: 14 }, { header: '風險旗標', key: 'riskFlags', width: 40 }
          ], rows: cap(productPrefRows).map(r => ({
            productName: str(r?.productName), productViewSessionCount: num(r?.productViewSessionCount),
            customizationStartSessionCount: num(r?.customizationStartSessionCount), previewCompleteSessionCount: num(r?.previewCompleteSessionCount),
            inquiryOrderCount: num(r?.inquiryOrderCount), linkedInquirySessionCount: num(r?.linkedInquirySessionCount),
            unlinkedInquiryOrderCount: num(r?.unlinkedInquiryOrderCount), productViewToCustomizationStartPct: str(r?.productViewToCustomizationStartPct),
            customizationStartToPreviewPct: str(r?.customizationStartToPreviewPct), previewToInquiryPct: str(r?.previewToInquiryPct),
            overallProductViewToInquiryPct: str(r?.overallProductViewToInquiryPct), riskFlags: str(r?.riskFlags)
          })) },
        { name: 'AI功能使用明細', columns: [
            { header: 'AI功能', key: 'feature', width: 18 }, { header: '請求數', key: 'requestCount', width: 10 },
            { header: '成功數', key: 'successCount', width: 10 }, { header: '部分成功數', key: 'partialCount', width: 10 },
            { header: '失敗數', key: 'failureCount', width: 10 }, { header: '成功率', key: 'successRatePct', width: 12 },
            { header: '未連結結果數', key: 'unlinkedResultCount', width: 12 }
          ], rows: cap(aiFeatureRows).map(r => ({
            feature: str(r?.feature), requestCount: num(r?.requestCount), successCount: num(r?.successCount),
            partialCount: num(r?.partialCount), failureCount: num(r?.failureCount), successRatePct: str(r?.successRatePct),
            unlinkedResultCount: num(r?.unlinkedResultCount)
          })) },
        { name: '圖片上傳失敗分類', columns: [{ header: '原因分類', key: 'category', width: 22 }, { header: '筆數', key: 'count', width: 12 }],
          rows: cap(uploadErrorRows).map(r => ({ category: str(r?.category), count: num(r?.count) })) },
        { name: '業務時效統計', columns: [
            { header: '階段', key: 'stage', width: 20 }, { header: '樣本數', key: 'sampleCount', width: 10 },
            { header: '中位數', key: 'median', width: 12 }, { header: '平均值', key: 'mean', width: 12 },
            { header: '最小值', key: 'min', width: 12 }, { header: '最大值', key: 'max', width: 12 },
            { header: '無效筆數', key: 'invalidCount', width: 10 }
          ], rows: cap(timingRows).map(r => ({
            stage: str(r?.stage), sampleCount: num(r?.sampleCount), median: str(r?.median), mean: str(r?.mean),
            min: str(r?.min), max: str(r?.max), invalidCount: num(r?.invalidCount)
          })) },
        { name: '目前待處理訂單分布', columns: [{ header: '狀態', key: 'status', width: 22 }, { header: '筆數', key: 'count', width: 12 }],
          rows: cap(backlogRows).map(r => ({ status: str(r?.status), count: num(r?.count) })) },
        { name: '距上次成交天數分布', columns: [{ header: '區間', key: 'label', width: 18 }, { header: '客戶數', key: 'customerCount', width: 12 }],
          rows: cap(daysDistributionRows).map(r => ({ label: str(r?.label), customerCount: num(r?.customerCount) })) }
      ]);
      sendXlsx(res, '楊竹網站分析', buffer);
    } catch (err) {
      console.error('[analytics/export] 產生Excel失敗', err.message);
      res.status(500).json({ error: '匯出失敗，請稍後再試' });
    }
  });

  // ══════════════ 管理員帳號管理（正式管理員帳號、角色權限、登入限制與操作稽核批次）══════════
  // 全部只有 owner 能用（PERMISSIONS.admin_users，見 admin-rbac.js）；manager「不可管理owner
  // 或安全設定」。帳號不可真正刪除，這裡完全沒有 DELETE 路由，只有「停用」（status='disabled'）。
  const ADMIN_USER_ROLES = ['owner', 'manager', 'staff', 'viewer'];
  const ADMIN_USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;

  // ─── 高風險操作重新驗證操作者密碼（共用）───────────────────────────────
  // 新增帳號、停用／啟用、改角色、重設密碼共用這一支函式；正式資料庫還原因為流程本身
  // 更複雜（還要接著檢查維護模式、備份完整性等），不直接呼叫這支，但共用同一組
  // getAdminReverifyLockState／recordAdminReverifyFailure／clearAdminReverifyAttempts。
  // 回傳true代表驗證通過，呼叫端可以繼續往下執行真正的業務邏輯；回傳false代表已經直接
  // 送出400/403/429回應，呼叫端必須立刻return，不可以再執行任何業務邏輯或写入。
  // 缺密碼只回400、不計入失敗次數（純粹是前端沒填，不是真的猜錯一次）；密碼錯誤才會計入
  // 節流次數，鎖定中連正確密碼都直接429拒絕、不再嘗試比對，避免鎖定期間繼續消耗scrypt成本。
  // 錯誤訊息一律用固定的通用文字，不透露密碼哪裡錯、也不透露操作者帳號目前的失敗次數。
  function verifyActorPasswordOrRespond(req, res, password) {
    const actorId = req.adminUser.id;
    const lockState = getAdminReverifyLockState(actorId);
    if (lockState.locked) {
      res.status(429).json({ error: '密碼重新驗證失敗次數過多，請稍後再試' });
      return false;
    }
    if (typeof password !== 'string' || !password) {
      res.status(400).json({ error: '請輸入目前密碼以驗證身分' });
      return false;
    }
    if (password.length > ADMIN_PASSWORD_MAX_LEN) {
      // 超長輸入視同密碼錯誤處理（計入失敗次數），不特別回覆「太長」——避免額外洩漏
      // 密碼規則細節給嘗試暴力破解或探測系統行為的人。
      recordAdminReverifyFailure(actorId);
      res.status(403).json({ error: '密碼不正確，無法執行此操作' });
      return false;
    }
    const selfUser = findAdminUserById(actorId);
    if (!selfUser || !verifyAdminPassword(password, selfUser.password_salt, selfUser.password_hash)) {
      recordAdminReverifyFailure(actorId);
      res.status(403).json({ error: '密碼不正確，無法執行此操作' });
      return false;
    }
    clearAdminReverifyAttempts(actorId);
    return true;
  }

  function toSafeAdminUserView(row) {
    return {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      failedLoginCount: row.failed_login_count,
      lockedUntil: row.locked_until,
      lastLoginAt: row.last_login_at,
      passwordChangedAt: row.password_changed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  router.get('/users', requirePermission('admin_users', 'view'), csrfProtection, (req, res) => {
    try {
      res.json({ success: true, users: listAdminUsers().map(toSafeAdminUserView) });
    } catch (err) {
      console.error('[api/admin/users]', err.message);
      res.status(500).json({ error: '管理員帳號清單讀取失敗' });
    }
  });

  router.post('/users', requirePermission('admin_users', 'write'), csrfProtection, (req, res) => {
    try {
      const username = typeof req.body.username === 'string' ? req.body.username.trim().toLowerCase() : '';
      const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
      const password = typeof req.body.password === 'string' ? req.body.password : '';
      const role = req.body.role;
      if (!ADMIN_USERNAME_RE.test(username)) {
        return res.status(400).json({ error: '帳號名稱必須是3～32碼英數字、底線、句點或連字號' });
      }
      if (!displayName || displayName.length > 60) {
        return res.status(400).json({ error: '顯示名稱不可為空，且不可超過60字' });
      }
      if (!isAdminPasswordLengthValid(password)) {
        return res.status(400).json({ error: `密碼長度必須是${ADMIN_PASSWORD_MIN_LEN}～${ADMIN_PASSWORD_MAX_LEN}碼` });
      }
      if (!ADMIN_USER_ROLES.includes(role)) {
        return res.status(400).json({ error: '角色不正確' });
      }
      // 重新輸入密碼驗證身分：新增管理員（尤其是新增owner）屬於高風險操作，不能只靠角色
      // 權限守門——若Session與CSRF憑證被盜，攻擊者不需要碰角色變更路由，直接新增一個新
      // owner帳號就能取得持久控制權，因此這裡新增帳號時無論要建立哪個角色都要求操作者
      // 重新驗證自己目前的密碼。
      if (!verifyActorPasswordOrRespond(req, res, req.body.currentPassword)) return;
      if (findAdminUserByUsername(username)) {
        return res.status(409).json({ error: '這個帳號名稱已經有人使用（不分大小寫），請換一個' });
      }
      const id = createAdminUser({ username, displayName, password, role });
      res.json({ success: true, user: toSafeAdminUserView(findAdminUserById(id)) });
    } catch (err) {
      console.error('[api/admin/users create]', err.message);
      res.status(500).json({ error: '建立管理員帳號失敗' });
    }
  });

  router.put('/users/:id/display-name', requirePermission('admin_users', 'write'), csrfProtection, (req, res) => {
    try {
      const target = findAdminUserById(req.params.id);
      if (!target) return res.status(404).json({ error: '找不到這個管理員帳號' });
      const displayName = typeof req.body.displayName === 'string' ? req.body.displayName.trim() : '';
      if (!displayName || displayName.length > 60) {
        return res.status(400).json({ error: '顯示名稱不可為空，且不可超過60字' });
      }
      updateAdminUserDisplayName(target.id, displayName);
      res.json({ success: true, user: toSafeAdminUserView(findAdminUserById(target.id)) });
    } catch (err) {
      console.error('[api/admin/users display-name]', err.message);
      res.status(500).json({ error: '更新顯示名稱失敗' });
    }
  });

  router.put('/users/:id/role', requirePermission('admin_users', 'write'), csrfProtection, (req, res) => {
    try {
      const target = findAdminUserById(req.params.id);
      if (!target) return res.status(404).json({ error: '找不到這個管理員帳號' });
      const role = req.body.role;
      if (!ADMIN_USER_ROLES.includes(role)) {
        return res.status(400).json({ error: '角色不正確' });
      }
      // 重新輸入密碼驗證身分：跟正式資料庫還原同一套做法（scrypt比對操作者本人的密碼），
      // 不因為Session存在就跳過——變更別人的角色權限屬於高風險操作，需要第二層身分確認。
      // 這裡驗證的是「目前登入這個Session的人」的密碼，跟被異動角色的target帳號無關。
      if (!verifyActorPasswordOrRespond(req, res, req.body.password)) return;
      // 使用者不可移除自己目前使用中的owner權限：不論系統裡還有沒有其他owner，本人都不能
      // 把自己從owner改成別的角色，必須請另一位owner協助調整。
      if (String(req.adminUser.id) === String(target.id) && target.role === 'owner' && role !== 'owner') {
        return res.status(403).json({ error: '不可以自行移除自己目前使用中的owner權限，請由另一位owner協助調整' });
      }
      // 系統永遠至少保留一位啟用中的owner：把「最後一位啟用中的owner」降級會讓系統沒有任何
      // owner，一律拒絕。
      if (target.role === 'owner' && target.status === 'active' && role !== 'owner' && countActiveOwners(target.id) < 1) {
        return res.status(409).json({ error: '這是目前唯一一位啟用中的owner，不可以降級，請先指派另一位owner' });
      }
      updateAdminUserRole(target.id, role);
      res.json({ success: true, user: toSafeAdminUserView(findAdminUserById(target.id)) });
    } catch (err) {
      console.error('[api/admin/users role]', err.message);
      res.status(500).json({ error: '更新角色失敗' });
    }
  });

  router.post('/users/:id/status', requirePermission('admin_users', 'write'), csrfProtection, (req, res) => {
    try {
      const target = findAdminUserById(req.params.id);
      if (!target) return res.status(404).json({ error: '找不到這個管理員帳號' });
      const status = req.body.status;
      if (!['active', 'disabled'].includes(status)) {
        return res.status(400).json({ error: '狀態不正確' });
      }
      // 重新輸入密碼驗證身分：停用／啟用帳號會直接影響誰能登入系統，屬於高風險操作，
      // 理由跟改角色、新增帳號一致。
      if (!verifyActorPasswordOrRespond(req, res, req.body.password)) return;
      // 使用者不可停用自己（不論自己是不是owner）。
      if (String(req.adminUser.id) === String(target.id) && status === 'disabled') {
        return res.status(403).json({ error: '不可以停用自己的帳號，請由另一位管理員協助' });
      }
      // 系統永遠至少保留一位啟用中的owner：停用「最後一位啟用中的owner」一律拒絕。
      if (target.role === 'owner' && status === 'disabled' && countActiveOwners(target.id) < 1) {
        return res.status(409).json({ error: '這是目前唯一一位啟用中的owner，不可以停用，請先指派另一位owner' });
      }
      setAdminUserStatus(target.id, status);
      res.json({ success: true, user: toSafeAdminUserView(findAdminUserById(target.id)) });
    } catch (err) {
      console.error('[api/admin/users status]', err.message);
      res.status(500).json({ error: '更新帳號狀態失敗' });
    }
  });

  router.post('/users/:id/password', requirePermission('admin_users', 'write'), csrfProtection, (req, res) => {
    try {
      const target = findAdminUserById(req.params.id);
      if (!target) return res.status(404).json({ error: '找不到這個管理員帳號' });
      const newPassword = typeof req.body.password === 'string' ? req.body.password : '';
      if (!isAdminPasswordLengthValid(newPassword)) {
        return res.status(400).json({ error: `密碼長度必須是${ADMIN_PASSWORD_MIN_LEN}～${ADMIN_PASSWORD_MAX_LEN}碼` });
      }
      // 重新輸入密碼驗證身分：跟changeUserRole()同樣的理由與做法，用另一個欄位名稱
      // （currentPassword）跟要設定的新密碼（password）區分，避免前端不小心把同一個值
      // 誤填進兩個欄位時難以察覺。這裡驗證的是操作者本人目前的密碼，不是target的密碼。
      if (!verifyActorPasswordOrRespond(req, res, req.body.currentPassword)) return;
      setAdminUserPassword(target.id, newPassword);
      res.json({ success: true });
    } catch (err) {
      console.error('[api/admin/users password]', err.message);
      res.status(500).json({ error: '設定新密碼失敗' });
    }
  });

  // ══════════════ 操作稽核紀錄查詢（正式管理員帳號、角色權限、登入限制與操作稽核批次）══════
  // 只提供查詢，owner／manager 可看（見 admin-rbac.js 的 audit_log 權限）。不提供修改或刪除。
  router.get('/audit-log', requirePermission('audit_log', 'view'), csrfProtection, (req, res) => {
    try {
      const result = queryAdminAuditLog({
        page: req.query.page,
        pageSize: req.query.pageSize,
        action: typeof req.query.action === 'string' ? req.query.action : undefined,
        resourceType: typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined,
        actorUserId: req.query.actorUserId ? Number(req.query.actorUserId) : undefined,
        result: typeof req.query.result === 'string' ? req.query.result : undefined,
        dateStart: typeof req.query.dateStart === 'string' ? req.query.dateStart : undefined,
        dateEnd: typeof req.query.dateEnd === 'string' ? req.query.dateEnd : undefined
      });
      res.json({
        success: true,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
        entries: result.rows.map(r => ({
          id: r.id,
          actorUserId: r.actor_user_id,
          actorUsername: r.actor_username_snapshot,
          action: r.action,
          resourceType: r.resource_type,
          resourceId: r.resource_id,
          result: r.result,
          httpStatus: r.http_status,
          changedFields: r.changed_fields_json ? JSON.parse(r.changed_fields_json) : null,
          ipHash: r.ip_hash,
          userAgentSummary: r.user_agent_summary,
          createdAt: r.created_at
        }))
      });
    } catch (err) {
      console.error('[api/admin/audit-log]', err.message);
      res.status(500).json({ error: '稽核紀錄查詢失敗' });
    }
  });

  // ══════════════ 資料庫備份與還原驗證（後台資料庫備份與還原第一階段）══════════════
  // 只有 owner 可以使用（見 admin-rbac.js 的 db_backup 權限），目的是避免正式訂單、客戶、
  // 商品、帳號及分析資料因程式錯誤或資料庫損壞而無法救回。
  //
  // 一次備份包含兩部分，用同一個時間戳識別碼（backupId）配對：
  // 1. admin.db 的 SQLite 官方一致性快照（見 db.js 的 createSqliteBackup()，正確處理 WAL），
  //    存成 backups/backup_<id>.db。
  // 2. 當下訂單資料夾（ORDER_DIR）所有訂單 JSON 檔案的複本，存成 backups/backup_<id>_orders/
  //    資料夾。訂單本來就不是存在 SQLite 裡（每筆訂單是獨立 JSON 檔案），要讓備份真正涵蓋
  //    「正式訂單」，必須連同這個資料夾一起快照，不能只備份 admin.db。
  // 這兩部分刻意分開存成「一份 SQLite 檔＋一個資料夾」，不是每次都先打包成單一 .zip 檔——
  // 這樣「隔離還原驗證」步驟可以直接複製 admin.db 快照另開一份唯讀連線做 integrity_check，
  // 不需要先解壓縮（專案本身沒有安裝解壓縮套件，見下方下載路由改成「下載當下即時串流打包」，
  // 不需要另外新增解壓縮依賴）。
  //
  // backupId 格式固定為「YYYYMMDDTHHMMSSmmmZ」（ISO 8601 UTC 時間戳，去掉 - : . 這三個
  // 分隔符號），一律由伺服器用 generateBackupId() 產生，前端／API呼叫端完全不能自訂或
  // 指定要用哪個檔名——這是避免路徑穿越攻擊最根本的做法：只要備份檔名／資料夾名稱從頭到尾
  // 不曾接受過使用者輸入，就沒有「使用者輸入了 ../../ 之類的字串」這個攻擊面存在。
  // 下面 download／delete／restore-verify 三支路由雖然要接受 :backupId 網址參數才能指定
  // 「要對哪一份備份操作」，但每一支路由的第一步都會先用 BACKUP_ID_RE 嚴格比對格式，格式
  // 不符就直接 400 拒絕，不會進入任何檔案系統操作；比對通過後才用 path.join(BACKUP_DIR, ...)
  // 組出實際路徑，且該格式本身不可能包含 / \ .. 等任何路徑分隔或穿越字元，雙重保證組出來的
  // 路徑一定還在 BACKUP_DIR 底下。
  const BACKUP_ID_RE = /^\d{8}T\d{9}Z$/;
  function generateBackupId() {
    // 例："2026-08-20T07:15:54.123Z" → 去掉 - : . 三種分隔符號 → "20260820T071554123Z"
    return new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
  }
  function backupDbFilePath(id) { return path.join(BACKUP_DIR, `backup_${id}.db`); }
  function backupOrdersDirPath(id) { return path.join(BACKUP_DIR, `backup_${id}_orders`); }
  // 暫存資料夾：複製過程中先寫在這裡，全部驗證通過才原子性改名成正式的 backupOrdersDirPath()。
  // 檔名故意用 `.tmp_` 開頭，跟正式的 `backup_` 開頭不同，listDatabaseBackups() 的掃描規則
  // 天生就不會把它誤認成一份備份。
  function backupOrdersTempDirPath(id) { return path.join(BACKUP_DIR, `.tmp_backup_${id}_orders`); }
  // manifest：這份備份「訂單快照是否完整」的唯一權威紀錄（Codex獨立複驗指出的問題：原本
  // 只用「orders資料夾存不存在」判斷完整性，資料夾就算只複製到一半也「存在」，會被誤判成
  // status:'ok'）。manifest 一律在 performDatabaseBackup() 複製流程走完（不論成功或失敗）
  // 之後才寫入，且寫入的當下已經確定最終結果，不會有「manifest說ok但資料夾其實沒複製完」
  // 的中間狀態。
  function backupManifestFilePath(id) { return path.join(BACKUP_DIR, `backup_${id}_manifest.json`); }

  // 統計單一備份的中繼資料（列表／建立完成後的回應／下載／隔離驗證共用同一份邏輯，避免
  // 各處各自維護一份「怎麼判斷完整」不一致）。status 只有在manifest本身宣稱完整、且實際
  // 掃描訂單快照資料夾的真實檔案數與manifest記錄的筆數完全相符時，才會是'ok'；manifest
  // 遺失、或manifest宣稱完整但實際檔案系統對不上（可能遭外部修改或複製後才損毀），一律
  // 降級成'partial'，絕不直接信任manifest內容或單純「資料夾存不存在」。
  function statBackup(id) {
    const dbPath = backupDbFilePath(id);
    if (!fs.existsSync(dbPath)) return null;
    const dbStat = fs.statSync(dbPath);
    const ordersDir = backupOrdersDirPath(id);
    const manifestPath = backupManifestFilePath(id);

    let manifest = null;
    if (fs.existsSync(manifestPath)) {
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { manifest = null; }
    }

    let orderFileCount = 0, ordersSizeBytes = 0, ordersDirExists = false;
    if (fs.existsSync(ordersDir)) {
      ordersDirExists = true;
      fs.readdirSync(ordersDir).forEach(f => {
        orderFileCount++;
        ordersSizeBytes += fs.statSync(path.join(ordersDir, f)).size;
      });
    }

    let status, partialReason, expectedOrderCount, ordersComplete, errorMessage;
    if (!manifest) {
      status = 'partial';
      partialReason = 'manifest_missing';
      expectedOrderCount = null;
      ordersComplete = false;
      errorMessage = '找不到這份備份的訂單快照紀錄檔（manifest），無法確認訂單快照是否完整，請視為不完整處理';
    } else {
      expectedOrderCount = manifest.expectedOrderCount;
      errorMessage = manifest.errorMessage || null;
      const manifestSaysOk = manifest.status === 'ok' && manifest.ordersComplete === true;
      const actuallyMatches = ordersDirExists
        && orderFileCount === manifest.copiedOrderCount
        && manifest.expectedOrderCount === manifest.copiedOrderCount;
      if (manifestSaysOk && actuallyMatches) {
        status = 'ok';
        partialReason = null;
        ordersComplete = true;
      } else {
        status = 'partial';
        ordersComplete = false;
        if (manifestSaysOk && !actuallyMatches) {
          partialReason = 'manifest_mismatch';
          errorMessage = '訂單快照資料夾與備份紀錄檔不一致（可能遭外部修改或複製後損毀），已視為不完整';
        } else {
          partialReason = manifest.partialReason || 'unknown';
        }
      }
    }

    return {
      id,
      createdAt: dbStat.mtime.toISOString(),
      dbSizeBytes: dbStat.size,
      orderFileCount,          // 實際掃描到的訂單快照檔案數（永遠是即時重新掃描的真實值）
      expectedOrderCount,      // 建立備份當下，訂單資料夾原本應該有幾筆
      ordersSizeBytes,
      totalSizeBytes: dbStat.size + ordersSizeBytes,
      status,                  // 'ok'：SQLite與訂單快照都完整驗證通過；'partial'：其中一項不完整
      partialReason,           // null｜'orders_dir_unreadable'｜'orders_invalid_entry'｜'orders_copy_failed'｜'manifest_missing'｜'manifest_mismatch'｜'unknown'
      ordersComplete,
      errorMessage
    };
  }

  function listDatabaseBackups() {
    if (!fs.existsSync(BACKUP_DIR)) return [];
    const ids = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^backup_\d{8}T\d{9}Z\.db$/.test(f))
      .map(f => f.slice('backup_'.length, -'.db'.length));
    return ids.map(statBackup).filter(Boolean).sort((a, b) => b.id.localeCompare(a.id)); // id本身是可排序時間戳，新到舊
  }

  // 實際建立一份備份：先用SQLite官方backup API快照admin.db，再把訂單資料夾複製到「暫存」
  // 資料夾——Codex獨立複驗指出的根本問題：原本直接複製到正式資料夾，複製到一半失敗時
  // 正式資料夾仍然「存在」（只是內容不完整），而完整性判斷只看資料夾存不存在，導致殘缺
  // 備份被誤報成status:'ok'。修正後的流程：
  //   1. 讀出訂單資料夾目前有哪些.json檔案（讀取失敗→ partialReason='orders_dir_unreadable'）。
  //   2. 逐一用 fs.lstatSync().isFile() 確認每一項都是普通檔案，不是資料夾或符號連結等
  //      非預期型態（有任何一項不是→ partialReason='orders_invalid_entry'，整批中止，
  //      完全不開始複製，不會有「複製到一半」的暫存資料夾殘留）。
  //   3. 全部驗證通過才開始複製到暫存資料夾；複製中途拋例外，或複製完成後重新掃描暫存
  //      資料夾的實際檔案數與預期筆數對不上（→ partialReason='orders_copy_failed'），
  //      一律視為失敗，刪除暫存資料夾，不會留下任何殘缺的訂單快照。
  //   4. 只有複製筆數與預期筆數完全相符，才用 fs.renameSync() 原子性把暫存資料夾改名成
  //      正式資料夾——這一步之後，正式資料夾要嘛是完整的，要嘛從頭到尾不存在，不會有
  //      中間狀態。
  // SQLite快照本身如果失敗，會直接讓這支函式整個reject（連manifest都不會寫），route層會
  // 回500，不會產生任何備份殘留；只有SQLite成功、但訂單快照失敗時，才會保留SQLite備份＋
  // 寫入status:'partial'的manifest（比「整份備份都不算」更安全，管理員至少還救得回商品／
  // 客戶／帳號資料，但清楚標示訂單部分不完整，不會被誤認為完整備份）。
  async function performDatabaseBackup() {
    const id = generateBackupId();
    const dbDest = backupDbFilePath(id);
    const ordersDest = backupOrdersDirPath(id);
    const ordersTempDest = backupOrdersTempDirPath(id);
    const manifestPath = backupManifestFilePath(id);
    if (fs.existsSync(dbDest) || fs.existsSync(ordersDest) || fs.existsSync(manifestPath)) {
      throw new Error('備份識別碼剛好重複，請稍後幾秒再試一次');
    }

    await createSqliteBackup(dbDest); // 失敗直接reject，不寫manifest、不留任何殘留

    const manifest = {
      id,
      createdAt: new Date().toISOString(),
      expectedOrderCount: null,
      copiedOrderCount: 0,
      ordersComplete: false,
      status: 'partial',
      partialReason: 'orders_dir_unreadable',
      errorMessage: null
    };

    try {
      let orderFiles;
      try {
        orderFiles = fs.readdirSync(ORDER_DIR).filter(f => f.endsWith('.json'));
      } catch (err) {
        manifest.errorMessage = '訂單資料夾讀取失敗：' + err.message;
        throw err;
      }
      manifest.expectedOrderCount = orderFiles.length;

      for (const f of orderFiles) {
        const entryStat = fs.lstatSync(path.join(ORDER_DIR, f));
        if (!entryStat.isFile()) {
          manifest.partialReason = 'orders_invalid_entry';
          manifest.errorMessage = `訂單資料夾內「${f}」不是普通檔案，已中止這次訂單快照，未複製任何檔案`;
          throw new Error(manifest.errorMessage);
        }
      }

      if (fs.existsSync(ordersTempDest)) fs.rmSync(ordersTempDest, { recursive: true, force: true });
      fs.mkdirSync(ordersTempDest, { recursive: true });

      let copiedCount = 0;
      try {
        orderFiles.forEach(f => {
          fs.copyFileSync(path.join(ORDER_DIR, f), path.join(ordersTempDest, f));
          copiedCount++;
        });
      } catch (err) {
        manifest.copiedOrderCount = copiedCount;
        manifest.partialReason = 'orders_copy_failed';
        manifest.errorMessage = `訂單快照複製中途失敗（已複製${copiedCount}／${orderFiles.length}筆）：${err.message}`;
        throw err;
      }

      // 複製迴圈沒有拋例外，不代表結果一定正確——再實際重新掃描暫存資料夾核對筆數，
      // 防禦複製過程中沒有拋出例外、但實際檔案數仍然對不上的邊界情況。
      const actualCopied = fs.readdirSync(ordersTempDest).length;
      if (actualCopied !== orderFiles.length) {
        manifest.copiedOrderCount = actualCopied;
        manifest.partialReason = 'orders_copy_failed';
        manifest.errorMessage = `訂單快照筆數核對不符（預期${orderFiles.length}筆，實際${actualCopied}筆）`;
        throw new Error(manifest.errorMessage);
      }

      fs.renameSync(ordersTempDest, ordersDest); // 全部驗證通過，原子性改名成正式資料夾
      manifest.copiedOrderCount = actualCopied;
      manifest.ordersComplete = true;
      manifest.status = 'ok';
      manifest.partialReason = null;
    } catch (err) {
      console.error('[db-backup] 訂單快照未完整，SQLite部分仍保留：', err.message);
      if (fs.existsSync(ordersTempDest)) {
        try { fs.rmSync(ordersTempDest, { recursive: true, force: true }); }
        catch (e) { console.error('[db-backup] 清除暫存訂單快照失敗：', e.message); }
      }
    }

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return statBackup(id);
  }

  router.get('/db-backups', requirePermission('db_backup', 'view'), csrfProtection, (req, res) => {
    try {
      res.json({ success: true, backups: listDatabaseBackups() });
    } catch (err) {
      console.error('[api/admin/db-backups list]', err.message);
      res.status(500).json({ error: '備份清單讀取失敗' });
    }
  });

  router.post('/db-backups', requirePermission('db_backup', 'create'), csrfProtection, async (req, res) => {
    try {
      const backup = await performDatabaseBackup();
      res.json({ success: true, backup });
    } catch (err) {
      console.error('[api/admin/db-backups create]', err.message);
      emitNotificationEvent({
        eventType: 'backup_restore_failed',
        idempotencyKey: `backup_create_${Date.now()}_${crypto.randomUUID()}`,
        title: '資料庫備份建立失敗',
        summary: err.message,
        severity: 'warning',
        resourceType: 'db_backup',
        resourceId: null
      });
      res.status(500).json({ error: '建立備份失敗：' + err.message });
    }
  });

  // 下載：即時把 admin.db 快照＋orders 資料夾串流打包成單一 .zip 直接回傳，不在硬碟上另外
  // 保留一份 .zip（避免每次下載都佔用雙倍磁碟空間）。跟既有 factory-package 下載路由同一套
  // archiver 直接 pipe 到 res 的寫法。
  router.get('/db-backups/:backupId/download', requirePermission('db_backup', 'download'), csrfProtection, (req, res) => {
    const id = req.params.backupId;
    if (!BACKUP_ID_RE.test(id)) return res.status(400).json({ error: '備份識別碼格式不正確' });
    const dbPath = backupDbFilePath(id);
    if (!fs.existsSync(dbPath)) return res.status(404).json({ error: '找不到這個備份' });
    // 下載不完整（訂單快照缺漏）的備份時，把警告直接烙進下載檔名本身（_partial 後綴）——
    // 這個警告會跟著檔案一起留存在管理員的硬碟上，不像畫面上的提示訊息，下載完成後
    // 還是持續看得到，不會因為關掉分頁就消失。
    const meta = statBackup(id);
    const zipFilename = (meta && meta.status === 'ok') ? `backup_${id}.zip` : `backup_${id}_partial_incomplete.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${zipFilename}"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => {
      console.error('[db-backup] 下載打包失敗', err.message);
      if (!res.headersSent) res.status(500).json({ error: '備份下載打包失敗' });
    });
    archive.pipe(res);
    archive.file(dbPath, { name: 'admin.db' });
    const ordersDir = backupOrdersDirPath(id);
    if (fs.existsSync(ordersDir)) archive.directory(ordersDir, 'orders');
    archive.finalize();
  });

  router.delete('/db-backups/:backupId', requirePermission('db_backup', 'delete'), csrfProtection, (req, res) => {
    try {
      const id = req.params.backupId;
      if (!BACKUP_ID_RE.test(id)) return res.status(400).json({ error: '備份識別碼格式不正確' });
      const dbPath = backupDbFilePath(id);
      if (!fs.existsSync(dbPath)) return res.status(404).json({ error: '找不到這個備份' });
      fs.unlinkSync(dbPath);
      // 一併清除訂單快照資料夾、manifest紀錄檔，以及萬一先前建立中途中斷、殘留下來的暫存
      // 資料夾——四個部分要嘛全部存在、要嘛全部不存在，不留下任何一部分的孤兒檔案。
      const ordersDir = backupOrdersDirPath(id);
      if (fs.existsSync(ordersDir)) fs.rmSync(ordersDir, { recursive: true, force: true });
      const manifestPath = backupManifestFilePath(id);
      if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
      const tempDir = backupOrdersTempDirPath(id);
      if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
      res.json({ success: true });
    } catch (err) {
      console.error('[api/admin/db-backups delete]', err.message);
      res.status(500).json({ error: '刪除備份失敗' });
    }
  });

  // 隔離還原驗證（這一批只做這個，不做正式還原）：把選定備份的admin.db快照複製到獨立的
  // 暫存檔案（跟正式使用中的 db 物件完全無關的另一個檔案路徑），用唯讀模式另開一條連線，
  // 執行 integrity_check、確認必要資料表存在、統計商品／管理員筆數；訂單／客戶筆數則從這份
  // 備份當初快照下來的訂單資料夾獨立計算，不呼叫、也不影響正式客戶頁面使用中的
  // aggregateCustomers()（那支函式只服務 /customers 系列路由，這裡刻意用自己一份輕量重算，
  // 兩者互不依賴，修改其中一邊不會影響另一邊）。全程只讀取暫存複本，從頭到尾不會開啟、
  // 不會寫入正式 admin.db，也不會動到正式訂單資料夾（ORDER_DIR）任何一個檔案。
  // 隔離驗證核心邏輯抽成共用函式——restore-verify路由與下面「正式還原」路由都需要「這份
  // 備份是否backupComplete」的結論，還原路由必須在動手覆蓋正式檔案之前重新驗證一次最新
  // 狀態（不可信任前端傳來的、可能已經過期的驗證結果），兩處共用同一份邏輯才能保證兩邊
  // 判斷標準永遠一致，不會出現「隔離驗證頁面說完整，但還原路由用不同標準又判不完整」的
  // 落差。純函式，只讀取檔案，不寫入任何東西（除了驗證用的暫存複本，finally會清除）。
  function verifyBackupIntegrity(id) {
    const dbPath = backupDbFilePath(id);
    if (!fs.existsSync(dbPath)) return { notFound: true };
    const meta = statBackup(id);

    const verifyDir = path.join(BACKUP_DIR, '_restore_verify_tmp');
    fs.mkdirSync(verifyDir, { recursive: true });
    const tmpDbPath = path.join(verifyDir, `${crypto.randomUUID()}.db`);
    let verifyDb = null;
    try {
      fs.copyFileSync(dbPath, tmpDbPath);
      verifyDb = new Database(tmpDbPath, { readonly: true });

      const integrityRows = verifyDb.pragma('integrity_check');
      const integrityOk = integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok';

      const REQUIRED_TABLES = ['products', 'inventory', 'customer_profiles', 'admin_users', 'admin_audit_log'];
      const existingTables = new Set(
        verifyDb.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map(r => r.name)
      );
      const missingTables = REQUIRED_TABLES.filter(t => !existingTables.has(t));

      const productCount = existingTables.has('products') ? verifyDb.prepare('SELECT COUNT(*) c FROM products').get().c : null;
      const adminUserCount = existingTables.has('admin_users') ? verifyDb.prepare('SELECT COUNT(*) c FROM admin_users').get().c : null;

      const ordersDir = backupOrdersDirPath(id);
      let orderCount = 0;
      let orderParseErrorCount = 0;
      const customerKeys = new Set();
      if (fs.existsSync(ordersDir)) {
        const files = fs.readdirSync(ordersDir).filter(f => f.endsWith('.json'));
        orderCount = files.length;
        files.forEach(f => {
          try {
            const order = JSON.parse(fs.readFileSync(path.join(ordersDir, f), 'utf8'));
            const email = typeof order?.contact?.email === 'string' ? order.contact.email.trim().toLowerCase() : '';
            const phoneDigits = typeof order?.contact?.phone === 'string' ? order.contact.phone.replace(/\D/g, '') : '';
            const key = email ? `email:${email}` : (phoneDigits ? `phone:${phoneDigits}` : `order:${order?.orderId || f}`);
            customerKeys.add(key);
          } catch (e) {
            orderParseErrorCount++; // 單一壞檔安全略過，不影響其餘檔案的統計
          }
        });
      }

      const backupSnapshotOk = meta ? meta.status === 'ok' : false;
      const backupComplete = backupSnapshotOk && integrityOk && missingTables.length === 0 && orderParseErrorCount === 0;
      const verificationStatus = backupComplete ? 'passed' : 'failed';

      const warningReasons = [];
      if (!backupSnapshotOk) {
        warningReasons.push(meta ? (meta.errorMessage || '訂單快照建立不完整') : '找不到備份紀錄檔（manifest），訂單快照建立不完整');
      }
      if (!integrityOk) warningReasons.push('SQLite完整性檢查未通過');
      if (missingTables.length > 0) warningReasons.push(`缺少必要資料表：${missingTables.join('、')}`);
      if (orderParseErrorCount > 0) warningReasons.push(`有${orderParseErrorCount}筆訂單檔案無法解析`);
      const backupWarning = warningReasons.length ? warningReasons.join('；') : null;

      return {
        notFound: false,
        id,
        backupComplete,
        verificationStatus,
        backupStatus: meta ? meta.status : 'partial',
        partialReason: meta ? meta.partialReason : 'manifest_missing',
        backupWarning,
        integrityCheck: integrityOk ? 'ok' : integrityRows,
        missingTables,
        counts: {
          products: productCount,
          adminUsers: adminUserCount,
          orders: orderCount,
          expectedOrders: meta ? meta.expectedOrderCount : null,
          customersApprox: customerKeys.size
        },
        orderParseErrorCount,
        createdAt: meta ? meta.createdAt : null,
        totalSizeBytes: meta ? meta.totalSizeBytes : null
      };
    } finally {
      // 複製來源admin.db快照本身若是WAL模式，即使用readonly開啟，better-sqlite3／SQLite仍
      // 可能在同目錄產生對應的 -shm／-wal 暫存檔；三個檔案都要清除，只刪主檔會讓這兩個附屬檔
      // 每次驗證都留下、永久累積在硬碟上。verifyDb.close()理論上會讓SQLite自行清掉這兩個檔案，
      // 但這裡仍明確補刪一次，避免任何平台差異或例外情況下的殘留。
      if (verifyDb) { try { verifyDb.close(); } catch (e) { /* 忽略關閉失敗 */ } }
      [tmpDbPath, `${tmpDbPath}-shm`, `${tmpDbPath}-wal`].forEach(p => {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* 暫存檔可能從未成功建立，忽略 */ }
      });
    }
  }

  router.post('/db-backups/:backupId/restore-verify', requirePermission('db_backup', 'restore_verify'), csrfProtection, (req, res) => {
    const id = req.params.backupId;
    if (!BACKUP_ID_RE.test(id)) return res.status(400).json({ error: '備份識別碼格式不正確' });
    try {
      const result = verifyBackupIntegrity(id);
      if (result.notFound) return res.status(404).json({ error: '找不到這個備份' });
      res.json({
        success: true, // 只代表「這次驗證流程本身有跑完、沒有拋例外」，不代表備份本身完整——
                        // 備份是否完整請一律看下面的 backupComplete／verificationStatus。
        ...result,
        note: '客戶筆數為依Email／電話獨立輕量計算的概略值，不套用正式客戶頁面的人工合併規則，僅供驗證資料是否看起來合理使用；本次驗證全程只讀取暫存複本，未觸碰正式資料庫或正式訂單資料夾，也不是正式還原。'
      });
    } catch (err) {
      console.error('[db-backup] 隔離還原驗證失敗', err.message);
      res.status(500).json({ error: '隔離還原驗證失敗：' + err.message });
    }
  });

  // 正式還原稽核紀錄（阻擋問題3修正）：這支路由執行到破壞階段時，全域db已經被關閉，共用
  // auditLogMiddleware（見server.js）對已關閉連線寫入一定會失敗，因此還原路由自己開一條
  // 完全獨立、用完即關的SQLite連線，直接寫入目標admin.db（成功時是剛置換好的新資料庫；
  // 回復成功時是已經復原回原本內容的正式資料庫），確保每次正式還原都留下唯一一筆可靠稽核。
  // 刻意只接受這幾個結構化欄位、絕不接受完整req.body，天生就不可能夾帶密碼／Session／
  // CSRF Token或其他請求內容。寫入失敗只記錄到伺服器console，不影響還原本身的成功或失敗
  // 判斷（稽核紀錄是還原這個動作的附屬產物，不是還原是否成功的前提）。
  function writeRestoreAuditRecord(dbFilePath, { actorUserId, actorUsernameSnapshot, actorRole, action, restoredBackupId, safetyBackupId, outcome, rolledBack, restartRequired }) {
    let auditDb = null;
    try {
      auditDb = new Database(dbFilePath);
      auditDb.prepare(`
        INSERT INTO admin_audit_log (actor_user_id, actor_username_snapshot, action, resource_type, resource_id, result, http_status, changed_fields_json, ip_hash, user_agent_summary, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        actorUserId ?? null,
        actorUsernameSnapshot ?? null,
        action,
        'db_backup_restore',
        restoredBackupId,
        outcome,
        outcome === 'success' ? 200 : 500,
        JSON.stringify({ actorRole: actorRole ?? null, restoredBackupId, safetyBackupId: safetyBackupId ?? null, rolledBack: !!rolledBack, restartRequired: !!restartRequired }),
        null,
        null,
        new Date().toISOString()
      );
    } catch (err) {
      console.error('[db-backup] 正式還原稽核紀錄寫入失敗（不影響還原本身結果，需人工檢查）：', err.message);
    } finally {
      if (auditDb) { try { auditDb.close(); } catch (e) { /* 忽略關閉失敗 */ } }
    }
  }

  // ══════════════ 正式資料庫還原（正式資料庫還原安全機制）══════════════
  // 只有owner可以執行（見admin-rbac.js的db_backup.restore權限）。這是整個備份/還原功能裡
  // 唯一會真的覆蓋正式admin.db與正式訂單資料夾的操作，設計上疊加多層防線：
  //   1. 角色權限（owner限定）。
  //   2. 還原當下重新輸入目前密碼驗證身分（跟角色權限是兩件事——就算Session被盜用，
  //      沒有密碼也無法執行還原）。
  //   3. 必須輸入跟backupId完全相符的確認文字（前端會先顯示這份備份的時間／筆數／風險，
  //      確認文字直接用backupId本身，讀不到正確識別碼就打不出正確確認文字，天生防呆）。
  //   4. 還原前用verifyBackupIntegrity()重新驗證一次最新狀態，只有backupComplete:true
  //      才允許還原——不信任前端傳來的、可能已經過期的驗證結果。
  //   5. 還原前自動建立一份「當下正式資料」的備份，作為這次還原失敗時的救援點。
  //   6. 進入維護模式，擋下還原期間可能同時讀寫admin.db／訂單資料夾的其他請求。
  //   7. 檔案置換採「先改名保留舊檔、成功才視為完成」的階段式做法，任何一步失敗都會嘗試
  //      把舊檔案改名復原；但只要流程走到「關閉正式SQLite連線」這一步，不論最後成功或
  //      失敗，都必須重啟正式3777才能恢復服務——這是這個專案目前架構（所有檔案的
  //      db.prepare()語句在載入時就綁定同一個連線物件）的真實限制，不是偷懶，見下方
  //      維護模式相關訊息。
  router.post('/db-backups/:backupId/restore', requirePermission('db_backup', 'restore'), csrfProtection, async (req, res) => {
    const id = req.params.backupId;
    if (!BACKUP_ID_RE.test(id)) return res.status(400).json({ error: '備份識別碼格式不正確' });

    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const confirmText = typeof req.body.confirmText === 'string' ? req.body.confirmText.trim() : '';
    if (!password) return res.status(400).json({ error: '請輸入目前密碼以驗證身分' });
    if (confirmText !== id) return res.status(400).json({ error: '確認文字不正確，請完整輸入這份備份的識別碼' });

    // 重新輸入密碼驗證身分：跟登入用同一套scrypt比對，只驗證「這確實是目前這個owner本人」，
    // 不因為Session存在就跳過——這是還原這種高風險操作額外要求的第二層身分確認。跟帳號
    // 改角色／新增／停用啟用／重設密碼共用同一套獨立於登入的失敗節流（15分鐘5次鎖定
    // 15分鐘），鎖定中連正確密碼都直接429拒絕。
    const reverifyLockState = getAdminReverifyLockState(req.adminUser.id);
    if (reverifyLockState.locked) {
      return res.status(429).json({ error: '密碼重新驗證失敗次數過多，請稍後再試' });
    }
    if (password.length > ADMIN_PASSWORD_MAX_LEN) {
      recordAdminReverifyFailure(req.adminUser.id);
      return res.status(403).json({ error: '密碼不正確，無法執行還原' });
    }
    const selfUser = findAdminUserById(req.adminUser.id);
    if (!selfUser || !verifyAdminPassword(password, selfUser.password_salt, selfUser.password_hash)) {
      recordAdminReverifyFailure(req.adminUser.id);
      return res.status(403).json({ error: '密碼不正確，無法執行還原' });
    }
    clearAdminReverifyAttempts(req.adminUser.id);

    if (isMaintenanceMode()) {
      return res.status(409).json({ error: '系統目前已在維護模式中，可能有其他還原正在進行或尚未重啟完成，請稍後再試' });
    }

    // 還原前重新驗證一次最新狀態（不信任前端可能已過期的verify結果），只有backupComplete
    // 才可以繼續。這一步完全不具破壞性（只讀複本），驗證失敗時安全中止，不需要任何回復。
    let verifyResult;
    try {
      verifyResult = verifyBackupIntegrity(id);
    } catch (err) {
      console.error('[db-backup] 還原前驗證失敗', err.message);
      return res.status(500).json({ error: '還原前驗證失敗：' + err.message });
    }
    if (verifyResult.notFound) return res.status(404).json({ error: '找不到這個備份' });
    if (!verifyResult.backupComplete) {
      return res.status(409).json({ error: `這份備份未通過完整驗證，不可還原：${verifyResult.backupWarning || '驗證未通過'}` });
    }

    const nowStamp = generateBackupId(); // 沿用備份識別碼的時間戳格式，同時作為本次還原暫存檔案的唯一後綴
    const liveDbPath = db.name; // better-sqlite3 連線物件本身記得目前開啟的完整檔案路徑
    const liveOrdersDir = ORDER_DIR;
    const preRestoreOrdersDir = `${liveOrdersDir}_pre_restore_${nowStamp}`;
    let safetyBackup = null;
    let reachedDestructiveStage = false; // 一旦true，代表已經關閉正式SQLite連線，不論後續成功或失敗都必須重啟才能恢復服務
    let restoreCommitted = false; // 還原提交點：置換後最終覆核通過就設為true，之後只做best-effort清理，絕不再進入資料回復流程

    enterMaintenanceMode('正式資料庫還原進行中，請稍候');
    try {
      // 還原前自動建立「當下正式資料」的備份，作為這次還原失敗時的救援點。這一步本身完全
      // 不具破壞性（SQLite官方backup API對一個仍在使用中的連線是安全的，訂單複製也只是
      // 讀取），失敗就直接中止，不繼續往下做任何破壞性動作。
      try {
        safetyBackup = await performDatabaseBackup();
      } catch (err) {
        throw new Error(`無法建立回復點，已中止還原，正式資料未被觸碰：${err.message}`);
      }

      // 安全備份「有沒有拋例外」不等於「內容完整」——performDatabaseBackup()遇到訂單快照
      // 錯誤時只會回傳status:'partial'，不會reject。這裡沿用建立備份時manifest記錄的結果，
      // 再用跟隔離驗證同一套共用邏輯verifyBackupIntegrity()重新驗證一次最新狀態，兩層都通過
      // 才確定這份安全備份真的可以作為回復點；任一層沒過，直接中止，完全不觸碰正式檔案
      // （不呼叫db.close()、不置換任何東西），這份不完整的安全備份本身仍保留在磁碟上供事後
      // 排查，但manifest已經誠實標示為partial，不會被誤認成可用的回復點。
      if (safetyBackup.status !== 'ok' || safetyBackup.ordersComplete !== true) {
        throw new Error(`還原前自動建立的安全備份不完整（${safetyBackup.errorMessage || safetyBackup.partialReason || '訂單快照未完整'}），已中止還原，正式資料未被觸碰；這份不完整的安全備份「${safetyBackup.id}」已保留供排查，但不得作為回復點使用`);
      }
      let safetyVerify;
      try {
        safetyVerify = verifyBackupIntegrity(safetyBackup.id);
      } catch (err) {
        throw new Error(`還原前自動建立的安全備份驗證失敗，已中止還原，正式資料未被觸碰：${err.message}`);
      }
      if (!safetyVerify.backupComplete || safetyVerify.verificationStatus !== 'passed') {
        throw new Error(`還原前自動建立的安全備份未通過完整性驗證（${safetyVerify.backupWarning || '驗證未通過'}），已中止還原，正式資料未被觸碰；這份不完整的安全備份「${safetyBackup.id}」已保留供排查，但不得作為回復點使用`);
      }

      reachedDestructiveStage = true; // 接下來要關閉正式連線、置換檔案，從這裡開始不再是「安全中止」的範圍
      // 這之後全域db即將關閉，共用auditLogMiddleware的res.on('finish')若照常對它寫入一定會
      // 失敗（The database connection is not open）。這次還原的稽核紀錄改由下面的獨立SQLite
      // 連線負責寫入唯一一筆，這裡先標記讓共用中介層跳過，避免對已關閉連線重複寫入徒增錯誤。
      req._adminAuditHandledExternally = true;

      db.close(); // 關閉正式SQLite連線；同一行程內所有require('./db')拿到的都是同一個物件，這裡關閉後全域都會視為已關閉

      // 資料庫檔案置換：先把正式admin.db（含WAL／SHM）改名保留，再把選定備份的.db複製到
      // 正式路徑；任一步失敗會在下面catch裡嘗試把保留的舊檔案改名復原。
      const liveDbSidecars = [liveDbPath, `${liveDbPath}-wal`, `${liveDbPath}-shm`];
      liveDbSidecars.forEach(p => { if (fs.existsSync(p)) fs.renameSync(p, `${p}.pre_restore_${nowStamp}`); });
      fs.copyFileSync(backupDbFilePath(id), liveDbPath);

      // 訂單資料夾置換：先把正式訂單資料夾整個改名保留，再建立全新資料夾、複製備份快照進去。
      if (fs.existsSync(liveOrdersDir)) fs.renameSync(liveOrdersDir, preRestoreOrdersDir);
      fs.mkdirSync(liveOrdersDir, { recursive: true });
      const backupOrdersDir = backupOrdersDirPath(id);
      let restoredOrderCount = 0;
      if (fs.existsSync(backupOrdersDir)) {
        fs.readdirSync(backupOrdersDir).forEach(f => {
          fs.copyFileSync(path.join(backupOrdersDir, f), path.join(liveOrdersDir, f));
          restoredOrderCount++;
        });
      }

      // 置換完成後最後一次覆核：直接開一條唯讀連線檢查剛剛置換上去的正式admin.db，確認
      // integrity_check與必要資料表都沒問題，訂單筆數也跟預期相符，避免複製過程本身
      // （磁碟錯誤、權限問題等）又造成新的損毀卻沒被發現。
      let finalCheckOk = false;
      let finalCheckReason = '';
      try {
        const finalDb = new Database(liveDbPath, { readonly: true });
        try {
          const integrity = finalDb.pragma('integrity_check');
          const integrityOk = integrity.length === 1 && integrity[0].integrity_check === 'ok';
          const tables = new Set(finalDb.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));
          const requiredOk = ['products', 'inventory', 'customer_profiles', 'admin_users', 'admin_audit_log'].every(t => tables.has(t));
          const expectedOrders = verifyResult.counts.orders;
          const ordersOk = restoredOrderCount === expectedOrders;
          finalCheckOk = integrityOk && requiredOk && ordersOk;
          if (!finalCheckOk) {
            finalCheckReason = !integrityOk ? 'SQLite完整性檢查未通過' : (!requiredOk ? '缺少必要資料表' : `訂單筆數不符（預期${expectedOrders}，實際${restoredOrderCount}）`);
          }
        } finally {
          finalDb.close();
        }
      } catch (err) {
        finalCheckOk = false;
        finalCheckReason = '無法開啟置換後的資料庫：' + err.message;
      }

      if (!finalCheckOk) {
        throw new Error(`還原後覆核未通過（${finalCheckReason}），已嘗試回復原本檔案`);
      }

      // 還原提交點（阻擋問題2修正）：新資料庫與新訂單已通過上面的完整覆核，從這裡開始視為
      // 正式提交——後面只是釋放磁碟空間的收尾清理，不代表還原本身還沒成功。清理如果失敗，
      // 絕對不能被下面catch的資料回復流程捕捉到而去覆蓋回舊資料，那樣反而會把已提交的新
      // 資料庫／新訂單又蓋回舊版本，形成「新訂單搭配回復後的舊資料庫」這種比清理沒做完
      // 更嚴重的混合狀態。因此以下清理逐項各自try/catch，任何錯誤只記錄警告、不重新拋出。
      restoreCommitted = true;

      const cleanupWarnings = [];
      liveDbSidecars.forEach(p => {
        const pr = `${p}.pre_restore_${nowStamp}`;
        if (!fs.existsSync(pr)) return;
        try { fs.unlinkSync(pr); }
        catch (err) { cleanupWarnings.push(`舊資料庫暫存檔尚未清除，可於重啟後手動刪除：${pr}（${err.message}）`); }
      });
      if (fs.existsSync(preRestoreOrdersDir)) {
        try { fs.rmSync(preRestoreOrdersDir, { recursive: true, force: true }); }
        catch (err) { cleanupWarnings.push(`舊訂單暫存資料夾尚未清除，可於重啟後手動刪除：${preRestoreOrdersDir}（${err.message}）`); }
      }

      // 正式還原稽核（阻擋問題3修正）：全域db已關閉，改用獨立連線直接寫入剛置換好的正式
      // admin.db，確保這次還原留下唯一一筆可靠紀錄，且不含密碼／Session／CSRF Token。
      writeRestoreAuditRecord(liveDbPath, {
        actorUserId: req.adminUser.id,
        actorUsernameSnapshot: req.adminUser.username,
        actorRole: req.adminUser.role,
        action: `POST /api/admin/db-backups/${id}/restore`,
        restoredBackupId: id,
        safetyBackupId: safetyBackup.id,
        outcome: 'success',
        rolledBack: false,
        restartRequired: true
      });

      res.json({
        success: true,
        restoredBackupId: id,
        restoredOrderCount,
        safetyBackupId: safetyBackup.id,
        maintenanceMode: true,
        cleanupWarnings,
        message: `已成功還原至備份「${id}」，正式訂單資料夾共還原${restoredOrderCount}筆訂單。系統目前處於維護模式，所有正式功能會回應503，必須重新啟動正式3777才會恢復服務並套用還原結果；還原前的資料已備份為「${safetyBackup.id}」，可於需要時再次還原回去。${cleanupWarnings.length ? `另有${cleanupWarnings.length}項暫存舊檔清理失敗（不影響新資料已正式生效）：${cleanupWarnings.join('；')}` : ''}`
      });
    } catch (err) {
      console.error('[db-backup] 正式還原失敗', err.message);
      emitNotificationEvent({
        eventType: 'backup_restore_failed',
        idempotencyKey: `restore_${nowStamp}`,
        title: `正式資料庫還原失敗：${id}`,
        summary: err.message,
        severity: 'critical',
        resourceType: 'db_backup',
        resourceId: id
      });
      let rolledBack = false;
      if (reachedDestructiveStage && !restoreCommitted) {
        // 只有還沒走到「還原提交點」才需要嘗試資料回復；一旦restoreCommitted為true，代表
        // 新資料庫與新訂單已通過覆核並正式生效，這個條件是最後一道防線——避免任何意外情況
        // 下把已提交的新資料又覆蓋回舊版本（提交後的清理與稽核寫入本身都已各自吞掉例外，
        // 正常不會被拋到這裡）。
        // 嘗試把改名保留的舊檔案復原。關鍵原則：只有「這個檔案先前確實被成功改名保留過」
        // （也就是`.pre_restore_`對應檔真的存在）才動手覆蓋回去；如果對應檔不存在，代表
        // 這個檔案從頭到尾沒有被搬動過（例如WAL/SHM本來就不存在，或改名到一半就先失敗，
        // 還沒輪到它），這時候絕對不能因為「目前位置有檔案存在」就把它刪掉——那個檔案
        // 可能就是還沒被觸碰過的原始檔，誤刪會造成真正的資料遺失，而不是安全回復。
        try {
          const liveDbSidecars = [liveDbPath, `${liveDbPath}-wal`, `${liveDbPath}-shm`];
          liveDbSidecars.forEach(p => {
            const pr = `${p}.pre_restore_${nowStamp}`;
            if (fs.existsSync(pr)) {
              if (fs.existsSync(p)) fs.unlinkSync(p);
              fs.renameSync(pr, p);
              return;
            }
            // 沒有保留副本，代表這個檔案（多半是-wal／-shm）原本就不存在，但這次失敗的
            // 置換過程（複製新備份檔或finalCheck開啟連線驗證）可能意外產生了新的-wal／-shm——
            // 清除這種跟已還原主檔案不匹配的孤兒附屬檔，不留殘留；主檔案`p===liveDbPath`
            // 那一項一定會有對應副本（前面已經改名保留過），不會誤刪原始主檔。
            if (p !== liveDbPath && fs.existsSync(p)) {
              try { fs.unlinkSync(p); } catch (e) { /* 清除失敗不影響主檔案已經正確復原 */ }
            }
          });
          if (fs.existsSync(preRestoreOrdersDir)) { // 訂單資料夾同理：沒有保留副本就不動正式資料夾
            if (fs.existsSync(liveOrdersDir)) fs.rmSync(liveOrdersDir, { recursive: true, force: true });
            fs.renameSync(preRestoreOrdersDir, liveOrdersDir);
          }
          rolledBack = true;
        } catch (rollbackErr) {
          console.error('[db-backup] 還原失敗後的自動回復也失敗，需要人工介入：', rollbackErr.message);
          emitNotificationEvent({
            eventType: 'system_error',
            idempotencyKey: `restore_${nowStamp}_rollback_failed`,
            title: `正式還原失敗且自動回復也失敗，需要人工介入：${id}`,
            summary: rollbackErr.message,
            severity: 'critical',
            resourceType: 'db_backup',
            resourceId: id
          });
        }
      }
      if (rolledBack) {
        // 破壞階段失敗但成功回復：對已回復回原本內容的正式admin.db用獨立連線寫入一筆失敗
        // 稽核，同樣不含密碼／Session／CSRF Token。回復失敗（human介入的極端情況）時，正式
        // admin.db可能處於無法安全開啟的狀態，這裡刻意不嘗試寫入，避免對損毀檔案再動作。
        writeRestoreAuditRecord(liveDbPath, {
          actorUserId: req.adminUser.id,
          actorUsernameSnapshot: req.adminUser.username,
          actorRole: req.adminUser.role,
          action: `POST /api/admin/db-backups/${id}/restore`,
          restoredBackupId: id,
          safetyBackupId: safetyBackup ? safetyBackup.id : null,
          outcome: 'failure',
          rolledBack: true,
          restartRequired: true
        });
      }
      // reachedDestructiveStage之前失敗：正式連線從未被關閉，服務其實可以立刻恢復，這裡
      // 主動解除維護模式；reachedDestructiveStage之後失敗（不論rolledBack是否成功），
      // 正式連線已經關閉，維護模式必須維持開啟直到重啟，不能解除。必須在送出錯誤回應「之前」
      // 就先解除，再用isMaintenanceMode()取得解除後的真實狀態回傳，否則回應會在解除之前就
      // 已經送出、maintenanceMode又固定寫死true，造成同一份回應同時聲稱「不需重啟」又「仍在
      // 維護中」，跟GET /api/admin/maintenance-status查到的真實狀態矛盾，誤導管理員
      // （2026-08-20 Codex獨立複驗指出的回應狀態缺口）。
      if (!reachedDestructiveStage) exitMaintenanceMode();
      res.status(500).json({
        error: err.message,
        rolledBack,
        maintenanceMode: isMaintenanceMode(),
        restartRequired: reachedDestructiveStage,
        // restoreCommitted為true時，代表新資料其實已經正式生效，這次錯誤發生在提交之後
        // （理論上只會是最後一道防線攔到的意外狀況），明確告知不是還原失敗、不需要也不會
        // 回復成舊資料。
        ...(restoreCommitted ? { restoreCommitted: true } : {})
      });
    }
  });

  return router;
};
