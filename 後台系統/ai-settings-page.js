// 楊竹科技後台系統 — AI 功能設定頁面邏輯
// 四項功能的啟用狀態／模型透過 .checked／.value 讀寫，五段提示詞透過 textarea 的 .value
// 讀寫，不使用 innerHTML 插入設定內容，動態文字（惡意輸入）不可能被解析成真正的 HTML 標籤。
const AI_FEATURE_KEYS = ['generate_image', 'generate_design', 'black_card_pattern', 'cartoon_image'];
const AI_PROMPT_KEYS = ['generate_image_main', 'generate_design_system', 'black_card_pattern_system', 'cartoon_image_base', 'cartoon_image_black_card'];

let loadedAiSettings = null; // { features: [{featureKey,enabled,model}...], prompts: [{promptKey,content}...] }（僅保留比對用的欄位）
let aiSettingsSaveInFlight = false;

function onAdminReady() {
  wireAiSettingsDirtyTracking();
  loadAiSettings();
}

function aiFeatureEls(featureKey) {
  return {
    enabled: document.getElementById(`ai-feature-${featureKey}-enabled`),
    model: document.getElementById(`ai-feature-${featureKey}-model`)
  };
}
function aiPromptEls(promptKey) {
  return {
    content: document.getElementById(`ai-prompt-${promptKey}-content`),
    count: document.getElementById(`ai-prompt-${promptKey}-count`)
  };
}

function readAiSettingsForm() {
  return {
    features: AI_FEATURE_KEYS.map(featureKey => {
      const els = aiFeatureEls(featureKey);
      return { featureKey, enabled: els.enabled.checked, model: els.model.value };
    }),
    prompts: AI_PROMPT_KEYS.map(promptKey => {
      const els = aiPromptEls(promptKey);
      return { promptKey, content: els.content.value };
    })
  };
}

function applyAiSettingsToForm(settings) {
  AI_FEATURE_KEYS.forEach(featureKey => {
    const data = (settings.features || []).find(f => f.featureKey === featureKey);
    const els = aiFeatureEls(featureKey);
    els.enabled.checked = !!(data && data.enabled);
    if (data && data.model) els.model.value = data.model;
  });
  AI_PROMPT_KEYS.forEach(promptKey => {
    const data = (settings.prompts || []).find(p => p.promptKey === promptKey);
    const els = aiPromptEls(promptKey);
    els.content.value = (data && data.content) || '';
    updateAiPromptCount(promptKey);
  });
}

function updateAiPromptCount(promptKey) {
  const els = aiPromptEls(promptKey);
  els.count.textContent = String(els.content.value.length);
}

// 「未修改時不可重複儲存」：跟最後一次成功讀取／儲存的內容逐欄位比對，完全相同就視為
// 沒有變更。載入尚未完成（loadedAiSettings 還是 null）時一律視為沒有變更，避免載入中
// 空白表單被誤判成「已修改」而讓儲存按鈕提早可以點擊。
function isAiSettingsFormDirty() {
  if (!loadedAiSettings) return false;
  const current = readAiSettingsForm();
  // 用 featureKey／promptKey 逐一查找比對，不能假設兩邊陣列順序相同——後台 API 回應固定依
  // 代碼字母順序排序（見 db.js getAllAiFeatureSettings／getAllAiPromptSettings），跟表單畫面上
  // 由 AI_FEATURE_KEYS／AI_PROMPT_KEYS 決定的顯示順序不是同一套規則。
  const featuresDiffer = current.features.some(f => {
    const orig = loadedAiSettings.features.find(o => o.featureKey === f.featureKey);
    return !orig || f.enabled !== orig.enabled || f.model !== orig.model;
  });
  if (featuresDiffer) return true;
  return current.prompts.some(p => {
    const orig = loadedAiSettings.prompts.find(o => o.promptKey === p.promptKey);
    return !orig || p.content !== orig.content;
  });
}

function updateAiSettingsSaveButtonState() {
  const btn = document.getElementById('ai-settings-save-btn');
  if (!btn || aiSettingsSaveInFlight) return; // 送出中的disabled狀態由saveAiSettings()自行控制，這裡不覆蓋
  btn.disabled = !isAiSettingsFormDirty();
}

function wireAiSettingsDirtyTracking() {
  AI_FEATURE_KEYS.forEach(featureKey => {
    const els = aiFeatureEls(featureKey);
    [els.enabled, els.model].forEach(el => {
      el.addEventListener('input', updateAiSettingsSaveButtonState);
      el.addEventListener('change', updateAiSettingsSaveButtonState);
    });
  });
  AI_PROMPT_KEYS.forEach(promptKey => {
    const els = aiPromptEls(promptKey);
    els.content.addEventListener('input', () => {
      updateAiPromptCount(promptKey);
      updateAiSettingsSaveButtonState();
    });
  });
}

async function loadAiSettings() {
  const statusEl = document.getElementById('ai-settings-status');
  const formEl = document.getElementById('ai-settings-form');
  statusEl.textContent = '載入中…';
  statusEl.classList.remove('hidden');
  formEl.classList.add('hidden');

  try {
    const resp = await adminFetch('/api/admin/ai-settings');
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      statusEl.textContent = (data && data.error) || '載入失敗，請稍後再試';
      return;
    }
    loadedAiSettings = { features: data.features, prompts: data.prompts };
    applyAiSettingsToForm(loadedAiSettings);
    statusEl.classList.add('hidden');
    formEl.classList.remove('hidden');
    updateAiSettingsSaveButtonState();
  } catch (e) {
    statusEl.textContent = '載入失敗：' + e.message;
  }
}

async function saveAiSettings() {
  if (aiSettingsSaveInFlight) return; // 防止重複送出：送出中再次點擊（或快速連點）直接忽略
  if (!isAiSettingsFormDirty()) return; // 未修改不可重複儲存；按鈕本來就會是disabled，這裡是第二層防線
  aiSettingsSaveInFlight = true;
  const btn = document.getElementById('ai-settings-save-btn');
  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = '儲存中…';

  try {
    const payload = readAiSettingsForm();
    const resp = await adminFetch('/api/admin/ai-settings', { method: 'PUT', body: JSON.stringify(payload) });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      showAdminToast((data && data.error) || '儲存失敗，請稍後再試', true);
      return;
    }
    loadedAiSettings = { features: data.features, prompts: data.prompts };
    applyAiSettingsToForm(loadedAiSettings);
    showAdminToast('AI 功能設定已儲存');
  } catch (e) {
    showAdminToast('儲存失敗：' + e.message, true);
  } finally {
    aiSettingsSaveInFlight = false;
    btn.textContent = originalText;
    updateAiSettingsSaveButtonState();
  }
}
