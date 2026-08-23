// 楊竹科技 — 首頁（landing.html）／客製化頁（index.html）共用：讀取後台「網站內容設定」
// （GET /api/site-settings，公開唯讀，不需登入）並安全套用公告、聯絡資訊、頁尾文字。
//
// 核心原則：
// 1. 頁面載入時只呼叫一次 API。
// 2. 嚴格驗證回應格式（型別逐一檢查），格式不符或請求失敗（離線／逾時／伺服器錯誤／HTTP
//    非2xx／JSON解析失敗）一律保留頁面原本內容，不拋出例外、不讓頁面顯示空白。
// 3. 所有動態文字一律用 textContent 賦值，不使用 innerHTML，惡意內容不可能被解析成真正的
//    HTML標籤或觸發事件屬性。
// 4. 兩個頁面各自沒有的元素（例如 index.html 沒有 site-header-tel、landing.html 沒有
//    quote-success-tel）一律用 `if (!el) return` 安全跳過，不會因為缺少某個元素就整段失敗。
const SITE_CONTACT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidSiteSettingsShape(s) {
  return !!s && typeof s === 'object'
    && typeof s.announcementEnabled === 'boolean'
    && typeof s.announcementText === 'string'
    && typeof s.contactEmail === 'string'
    && typeof s.contactPhone === 'string'
    && typeof s.footerText === 'string';
}

// 只保留數字與「開頭」的加號，組出安全的 tel: 格式，不管原始輸入裡有沒有空格、括號、
// 分機符號等排版字元。沒有任何數字（例如整串都是符號或中文字）就視為無法組成合法電話。
function buildSafeTelHref(phone) {
  const trimmed = phone.trim();
  const hasLeadingPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return 'tel:' + (hasLeadingPlus ? '+' : '') + digits;
}

function applySiteAnnouncement(settings) {
  const banner = document.getElementById('site-announcement-banner');
  const textEl = document.getElementById('site-announcement-text');
  if (!banner || !textEl) return;

  const text = settings.announcementText.trim();
  const show = settings.announcementEnabled === true && text.length > 0;
  if (show) {
    textEl.textContent = text;
    banner.style.display = 'block';
  } else {
    banner.style.display = 'none';
  }

  // landing.html 的 <header> 是 position:fixed（不佔版面流動空間），.hero 原本用固定的
  // margin-top:60px 讓出頂部空間；公告出現時額外多需要banner的高度，這裡直接把.hero的
  // margin-top讓給banner自己的margin-top（見landing.html內嵌樣式.site-announcement），
  // 避免banner與hero之間出現重複的60px留白。index.html的<header>是position:sticky
  // （本來就佔版面流動空間）也沒有.hero元素，這段對它完全是no-op。
  const hero = document.querySelector('.hero');
  if (hero) hero.style.marginTop = show ? '0' : '';
}

function applySiteContactPhone(phoneRaw) {
  const trimmed = phoneRaw.trim();
  if (!trimmed) return; // 空白：保留原本的正式電話，不清空
  const href = buildSafeTelHref(trimmed);
  // 無法從這段文字組出安全的tel:連結（例如完全沒有數字）就整個放棄套用，不能只改顯示文字、
  // 卻讓href留在原本的正式電話——那會出現「畫面顯示這段文字、點擊卻撥打舊電話」的顯示與
  // 實際撥號不一致。後端已經擋掉這種非空白但沒有數字的內容（見admin-routes.js），這裡是
  // 前端第二層防線，避免萬一後端資料本身不合法（例如手動改資料庫）時前端仍照樣顯示錯誤內容。
  if (!href) return;
  ['site-header-tel', 'site-footer-tel', 'quote-success-tel'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = trimmed;
    if (el.tagName === 'A') el.setAttribute('href', href);
  });
}

function applySiteContactEmail(emailRaw) {
  const trimmed = emailRaw.trim();
  if (!trimmed || !SITE_CONTACT_EMAIL_RE.test(trimmed)) return; // 空白或格式不合法：保留原本Email

  // 提供給 js/configurator.js 動態組成「詢價成功」區塊的 mailto: 連結使用（那個連結是送出
  // 詢價單當下才動態產生 subject／body，不是在這裡直接設定 href，避免蓋掉那段查詢字串）；
  // 這裡先驗證過一次格式，configurator.js 使用時不需要再重新驗證。
  window.SITE_CONTACT_EMAIL = trimmed;

  const el = document.getElementById('site-footer-email');
  if (el) {
    el.textContent = trimmed;
    el.setAttribute('href', 'mailto:' + trimmed);
  }
}

function applySiteFooterText(textRaw) {
  const trimmed = textRaw.trim();
  if (!trimmed) return; // 空白：保留原本的授權製造廠與ISO說明
  const el = document.getElementById('site-footer-note');
  if (el) el.textContent = trimmed;
}

async function loadSiteContent() {
  try {
    const resp = await fetch('/api/site-settings');
    if (!resp.ok) return;
    const data = await resp.json().catch(() => null);
    if (!data || !isValidSiteSettingsShape(data.settings)) return;

    const settings = data.settings;
    applySiteAnnouncement(settings);
    applySiteContactPhone(settings.contactPhone);
    applySiteContactEmail(settings.contactEmail);
    applySiteFooterText(settings.footerText);
  } catch (e) {
    // 網路離線、逾時等任何例外，一律保留頁面原始內容，不影響頁面其他功能
  }
}

document.addEventListener('DOMContentLoaded', loadSiteContent);
