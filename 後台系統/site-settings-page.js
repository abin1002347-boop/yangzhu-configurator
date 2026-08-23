// 楊竹科技後台系統 — 網站內容設定頁面邏輯
// 公告開關／公告文字／聯絡Email／聯絡電話／頁尾文字，全部透過表單欄位的 .value／.checked
// 讀寫，不使用 innerHTML 插入設定內容，動態文字（惡意輸入）不可能被解析成真正的 HTML 標籤。
let loadedSiteSettings = null;
let siteSettingsSaveInFlight = false;

function onAdminReady() {
  wireSiteSettingsDirtyTracking();
  loadSiteSettings();
}

function siteSettingsFormEls() {
  return {
    enabled: document.getElementById('site-announcement-enabled'),
    text: document.getElementById('site-announcement-text'),
    email: document.getElementById('site-contact-email'),
    phone: document.getElementById('site-contact-phone'),
    footer: document.getElementById('site-footer-text')
  };
}

function readSiteSettingsForm() {
  const els = siteSettingsFormEls();
  return {
    announcementEnabled: els.enabled.checked,
    announcementText: els.text.value,
    contactEmail: els.email.value,
    contactPhone: els.phone.value,
    footerText: els.footer.value
  };
}

function applySiteSettingsToForm(settings) {
  const els = siteSettingsFormEls();
  els.enabled.checked = !!settings.announcementEnabled;
  els.text.value = settings.announcementText || '';
  els.email.value = settings.contactEmail || '';
  els.phone.value = settings.contactPhone || '';
  els.footer.value = settings.footerText || '';
}

// 「未修改時不可重複儲存」：跟最後一次成功讀取／儲存的內容逐欄位比對，完全相同就視為
// 沒有變更。載入尚未完成（loadedSiteSettings 還是 null）時一律視為沒有變更，避免載入中
// 空白表單被誤判成「已修改」而讓儲存按鈕提早可以點擊。
function isSiteSettingsFormDirty() {
  if (!loadedSiteSettings) return false;
  const current = readSiteSettingsForm();
  return current.announcementEnabled !== loadedSiteSettings.announcementEnabled
    || current.announcementText !== loadedSiteSettings.announcementText
    || current.contactEmail !== loadedSiteSettings.contactEmail
    || current.contactPhone !== loadedSiteSettings.contactPhone
    || current.footerText !== loadedSiteSettings.footerText;
}

function updateSiteSettingsSaveButtonState() {
  const btn = document.getElementById('site-settings-save-btn');
  if (!btn || siteSettingsSaveInFlight) return; // 送出中的disabled狀態由saveSiteSettings()自行控制，這裡不覆蓋
  btn.disabled = !isSiteSettingsFormDirty();
}

function wireSiteSettingsDirtyTracking() {
  const els = siteSettingsFormEls();
  [els.enabled, els.text, els.email, els.phone, els.footer].forEach(el => {
    el.addEventListener('input', updateSiteSettingsSaveButtonState);
    el.addEventListener('change', updateSiteSettingsSaveButtonState);
  });
}

async function loadSiteSettings() {
  const statusEl = document.getElementById('site-settings-status');
  const formEl = document.getElementById('site-settings-form');
  statusEl.textContent = '載入中…';
  statusEl.classList.remove('hidden');
  formEl.classList.add('hidden');

  try {
    const resp = await adminFetch('/api/admin/site-settings');
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      statusEl.textContent = (data && data.error) || '載入失敗，請稍後再試';
      return;
    }
    loadedSiteSettings = data.settings;
    applySiteSettingsToForm(loadedSiteSettings);
    statusEl.classList.add('hidden');
    formEl.classList.remove('hidden');
    updateSiteSettingsSaveButtonState();
  } catch (e) {
    statusEl.textContent = '載入失敗：' + e.message;
  }
}

async function saveSiteSettings() {
  if (siteSettingsSaveInFlight) return; // 防止重複送出：送出中再次點擊（或快速連點）直接忽略
  if (!isSiteSettingsFormDirty()) return; // 未修改不可重複儲存；按鈕本來就會是disabled，這裡是第二層防線
  siteSettingsSaveInFlight = true;
  const btn = document.getElementById('site-settings-save-btn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '儲存中…';

  try {
    const payload = readSiteSettingsForm();
    const resp = await adminFetch('/api/admin/site-settings', { method: 'PUT', body: JSON.stringify(payload) });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showAdminToast((data && data.error) || '儲存失敗，請稍後再試', true);
      return;
    }
    loadedSiteSettings = data.settings;
    applySiteSettingsToForm(loadedSiteSettings);
    showAdminToast('網站內容設定已儲存');
  } catch (e) {
    showAdminToast('儲存失敗：' + e.message, true);
  } finally {
    siteSettingsSaveInFlight = false;
    btn.textContent = originalText;
    updateSiteSettingsSaveButtonState();
  }
}
