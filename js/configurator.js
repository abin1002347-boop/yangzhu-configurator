// 楊竹科技 — 步驟式配置器主邏輯

// 開發期診斷開關：預設關閉，不會在一般使用時洩漏任何內容。
// 需要除錯時在 console 執行 `YZ_DEBUG = true` 即可即時開啟，不需改程式碼重新部署。
window.YZ_DEBUG = window.YZ_DEBUG || false;
function _yzLog(label, data) {
  if (!window.YZ_DEBUG) return;
  // 禁止輸出完整 base64：canvasDataUrl／selectedAiImage 只印長度與是否存在，不印內容本身。
  console.log('[YZ_DEBUG] ' + label, data);
}

// 單一、明確的設計狀態物件：彙整目前商品的可列印內容，供預覽/驗證/診斷共用同一份資料，
// 不再讓每個頁面各自讀取不同的臨時變數。透過 syncDesignState() 從 STATE + canvas2d 重新產生，
// 而不是另外維護一份會漂移不同步的複本。
const designState = {
  productId: null,
  canvasDataUrl: null,
  canvasJson: null,
  mainTitle: '',
  subTitle: '',
  font: null,
  textColor: null,
  backgroundTemplate: null,
  uploadedImage: null,
  selectedAiImage: null,
  objects: [],
  zoom: 100,
  rotation: 0,
  updatedAt: null
};

// 從目前的 STATE + canvas2d 重新整理出 designState 的內容，在畫布狀態有實質變化的時機呼叫
// （套用至卡面、套用背景模板、選取黑卡候選圖、離開設計頁快照時）。
function syncDesignState() {
  designState.productId = STATE.productId;
  designState.canvasDataUrl = STATE.designDataURL;
  designState.canvasJson = STATE.canvasJSON;
  designState.mainTitle = STATE.textLine1;
  designState.subTitle = STATE.textLine2;
  designState.font = STATE.font || null;
  const textColorEl = document.getElementById('design-textcolor');
  designState.textColor = textColorEl ? textColorEl.value : null;
  designState.backgroundTemplate = STATE.backgroundTemplateId;
  designState.selectedAiImage = STATE.blackCardSelectedImage || null;

  let zoomPct = 100, rotationDeg = 0, uploadedImageInfo = null;
  const objects = [];
  if (typeof canvas2d !== 'undefined' && canvas2d) {
    designState.canvasWidth = canvas2d.getWidth();
    designState.canvasHeight = canvas2d.getHeight();
    canvas2d.getObjects().forEach(o => {
      // originX/originY 決定 left/top 是相對物件哪個基準點（黑卡圖案是 center/center），
      // 沒有這兩個值單靠 left/top 無法正確還原物件實際位置；baseScale 是黑卡圖案專用
      // 的縮放滑桿基準（見 placeBlackCardEffectObject），一併存起來供還原/診斷使用。
      objects.push({
        name: o.name || o.type,
        left: o.left, top: o.top,
        scaleX: o.scaleX, scaleY: o.scaleY,
        angle: o.angle,
        originX: o.originX, originY: o.originY,
        baseScale: o.baseScale || null
      });
      if (o.type === 'image' && !o.name) uploadedImageInfo = { left: o.left, top: o.top, scaleX: o.scaleX };
    });
    const active = canvas2d.getActiveObject();
    if (active) {
      const base = active.baseScale || 1;
      zoomPct = Math.round(((active.scaleX || base) / base) * 100);
      rotationDeg = Math.round(active.angle || 0);
    }
  }
  designState.objects = objects;
  designState.uploadedImage = uploadedImageInfo;
  designState.zoom = zoomPct;
  designState.rotation = rotationDeg;
  designState.updatedAt = Date.now();

  _yzLog('syncDesignState', {
    productId: designState.productId,
    hasCanvasDataUrl: !!designState.canvasDataUrl,
    canvasDataUrlLen: designState.canvasDataUrl ? designState.canvasDataUrl.length : 0,
    objectCount: designState.objects.length,
    hasSelectedAiImage: !!designState.selectedAiImage,
    zoom: designState.zoom,
    rotation: designState.rotation
  });
  // 畫布有實質變化就一併排入自動保存（debounce 500ms），這個函式已經是全站
  // 各種編輯操作（套用文字/圖片/簽名/滿版紋理、圖層顯示隱藏鎖定、縮放滑桿…）
  // 共用的「狀態有變動」入口，掛在這裡就不用逐一去每個編輯函式加保存呼叫。
  if (typeof scheduleSaveDesign === 'function') scheduleSaveDesign();
  return designState;
}

// 黑卡「是否已有可印製內容」的單一判斷依據：文字物件、使用者上傳圖片、已選取的 AI 圖案、
// 滿版元素圖案、或藝術簽名，任一項成立即可進入預覽。直接檢查 canvas2d 實際物件，
// 而非只看某個旗標，避免「AI 已生成但尚未選取候選圖」被誤判為已完成。
function hasPrintableDesign() {
  if (typeof canvas2d === 'undefined' || !canvas2d) return false;
  // 圖層面板新增「顯示/隱藏」功能後，被使用者手動隱藏的物件不應被視為「已完成可印製內容」
  const objs = canvas2d.getObjects().filter(o => o.visible !== false);
  const validTextObject = objs.some(o => (o.name === 'title' || o.name === 'subtitle') && (o.text || '').trim().length > 0);
  const validSelectedAiImage = objs.some(o => o.name === 'black-effect-image');
  const validUploadedImage = objs.some(o => o.type === 'image' && !['product-bg', 'hint'].includes(o.name));
  const validFullBleedPattern = objs.some(o => o.name === 'full-bleed-pattern');
  const validSignature = objs.some(o => (o.name === 'black-card-signature' || o.name === 'thermos-signature') && (o.text || '').trim().length > 0);
  // 裝飾圖形（愛心/星星等25款）本身就是使用者主動加上去的客製內容，跟上傳圖片、
  // AI圖案是同一個等級，這裡本來漏了這條，會讓「只加裝飾圖形、沒改示範文字」的
  // 客人卡在「預覽成品」按鈕前面，明明畫面上已經有東西了卻按不下去。
  const validSticker = objs.some(o => o.name === 'sticker');
  return Boolean(validTextObject || validUploadedImage || validSelectedAiImage || validFullBleedPattern || validSignature || validSticker);
}

// 「可以進入預覽」的統一判斷：光有可印製物件還不夠，如果那些物件其實就是模板內建、
// 使用者完全沒動過的示範文字（isDesignStillDemoPlaceholder()，定義見下方），一樣不能
// 放行——否則使用者什麼都沒改，直接把「專屬於你的 美好日常」這種示範文案送進 Step4／
// Step5，會被誤以為那就是自己要下單的正式內容。isDesignStillDemoPlaceholder() 本身
// 只在悠遊卡／一卡通／保溫杯有對應的示範文字表，黑卡與其餘商品一律回傳 false，不受影響。
function canProceedToPreview() {
  if (!hasPrintableDesign()) return false;
  if (typeof isDesignStillDemoPlaceholder === 'function' && isDesignStillDemoPlaceholder()) return false;
  return true;
}

// 設計步驟的「預覽成品」按鈕即時啟用/停用，依據永遠是 canProceedToPreview()，
// 由 canvas 的 object:added / object:removed / object:modified 等事件即時觸發，涵蓋
// 套用文字、上傳圖片、選取 AI 候選圖、刪除物件、清空重來等所有會改變畫布內容的操作。
// 通用於所有商品（原本僅限黑卡）：非黑卡商品的預設模板已內建示範文字（title/subtitle
// 皆為非空字串），但只要還是逐字相同的示範文字就不算「已完成範例設計」，必須使用者
// 實際修改任一示範文字、或加入自己的文字／圖片，才會被視為可預覽。
function updateStep3NextButtonState() {
  const btn = document.getElementById('step3-next-btn');
  const reasonEl = document.getElementById('cta-disabled-reason');
  if (!btn) return;
  const printable = hasPrintableDesign();
  const shouldDisable = !canProceedToPreview();
  btn.disabled = shouldDisable;
  if (reasonEl) {
    reasonEl.classList.toggle('hidden', !shouldDisable);
    if (shouldDisable) {
      reasonEl.textContent = !printable
        ? ((STATE.productId === 'black_card')
            ? '請先加入壓印文字、上傳圖片、選擇 AI 圖案、滿版紋理或藝術簽名其中一項，才能預覽成品。'
            : '請先輸入文字或上傳圖片，才能預覽成品。')
        : '請先修改示範文字，或加入自己的文字／圖片，再預覽成品。';
    }
  }
  const demoBadge = document.getElementById('demo-placeholder-badge');
  if (demoBadge) demoBadge.classList.toggle('hidden', !isDesignStillDemoPlaceholder());
}

// 悠遊卡／一卡通／保溫杯的預設模板本身就內建示範文字（例如「專屬於你的 美好日常」、
// 「YANGZHU / PREMIUM CUP」），使用者完全沒動過也會被 hasPrintableDesign() 判定為
// 「已有可印製內容」而能直接往下一步走，容易誤以為示範文字就是自己要下單的正式內容。
// 用「畫布上的 title/subtitle 文字是否仍與模板預設值逐字相同、且沒有任何使用者自行
// 加入的圖片／滿版圖案」判斷是否仍是純示範狀態，不用在物件上額外維護旗標（旗標在
// 草稿 JSON 序列化／還原之間反而容易漏標、對不齊）。黑卡完全空白直到使用者主動加入
// 內容才算完成，不存在「預設就有可印製內容」的情況，不適用此判斷。
// 保溫杯「文字與版面」「上傳Logo/圖片」已隱藏，示範內容改成一個示範簽名（見
// preview2d.js 的 THERMOS_DEMO_SIGNATURE_TEXT／addThermosDemoLayers()），不再是
// title/subtitle，跟悠遊卡／一卡通的判斷邏輯結構不同，另外拉一支分支處理。
const DEMO_PLACEHOLDER_TEXT = {
  easycard: { title: '專屬於你的美好日常', subtitle: '' },
  ipass:    { title: '專屬於你的美好日常', subtitle: '' }
};
function isDesignStillDemoPlaceholder() {
  if (typeof canvas2d === 'undefined' || !canvas2d || !STATE.productId) return false;
  const objs = canvas2d.getObjects().filter(o => o.visible !== false);

  if (STATE.productId === 'thermos') {
    const hasOtherContent = objs.some(o => o.type === 'image' && !['product-bg', 'hint'].includes(o.name))
      || objs.some(o => o.name === 'full-bleed-pattern')
      || objs.some(o => o.name === 'sticker');
    if (hasOtherContent) return false;
    const sigTexts = objs.filter(o => o.name === 'thermos-signature').map(o => (o.text || '').trim());
    if (sigTexts.length === 0) return false; // 示範簽名被刪掉了，畫布上就沒東西，hasPrintableDesign()已經會擋
    const demoText = (typeof THERMOS_DEMO_SIGNATURE_TEXT !== 'undefined') ? THERMOS_DEMO_SIGNATURE_TEXT : '';
    return sigTexts.every(t => t === demoText);
  }

  const demo = DEMO_PLACEHOLDER_TEXT[STATE.productId];
  if (!demo) return false;
  const hasOtherContent = objs.some(o => o.type === 'image' && !['product-bg', 'hint'].includes(o.name))
    || objs.some(o => o.name === 'full-bleed-pattern')
    || objs.some(o => o.name === 'sticker');
  if (hasOtherContent) return false;
  const titleText = objs.filter(o => o.name === 'title').map(o => (o.text || '').trim()).join('');
  const subtitleText = objs.filter(o => o.name === 'subtitle').map(o => (o.text || '').trim()).join('');
  return titleText === demo.title && subtitleText === demo.subtitle;
}

const STATE = {
  step: 1,
  productId: null,
  materialId: null,
  finishId: null,
  capacityId: null,
  cupColorId: null,       // 保溫杯：杯身顏色（純外觀，不加價；其他商品不使用，維持null）
  selectedLayerId: null,  // 目前選取的圖層id（四商品共用，見 preview2d.js 的 _ensureLayerId/renderLayerPanel）
  previewAngle: null,     // 成品預覽視角（使用者主動選過才有值；見 preview3d.js 的 setStandardPreviewAngle()）
  qty: 1,
  textLine1: '',
  textLine2: '',
  bgColor: '#ffffff',
  backgroundTemplateId: 'blank', // 背景造型id（對應 CARD_MASK_SHAPES，見 preview2d.js），只管形狀不管顏色。
                                  // 悠遊卡／一卡通新設計預設為空白背板（'blank'），客戶需要時才自行選擇造型；
                                  // 保溫杯／黑卡本來就不使用這個欄位（背景造型區塊對這兩商品隱藏，見 initDesignStep()）。
  waveColor: '#2D7D46',
  waveLightColor: '#dfead8',
  canvasJSON: null,       // 設計稿 canvas 狀態快照（返回時還原用）
  designDataURL: null,    // 設計稿影像快照（3D 貼圖備援）
  blackCardPatternDataURL: null, // 黑卡：套用浮雕效果後的圖案（去背＋黑化），供畫布物件與商品照合成使用
  blackCardPrompt: '',            // 黑卡：客戶輸入的圖案描述文字
  blackCardStyle: 'cute_round',   // 黑卡：選擇的 AI 圖案風格（cute_round／minimal_line／premium_emblem）
  blackCardCandidates: [],        // 黑卡：AI 產生的候選圖（data URL 陣列，最多 3 張，去背/黑化前的原圖）
  blackCardSelectedImage: null,   // 黑卡：候選圖中被選中的原始圖（去背/黑化前）
  blackCardFullBleedType: null,       // 黑卡：滿版元素圖案類型，見 preview2d.js 的 FULL_BLEED_PATTERN_OPTIONS
  blackCardFullBleedDataURL: null,    // 黑卡：滿版元素原始去背圖樣（商品預覽 CSS mask 來源）
  blackCardFullBleedDensity: 5,       // 黑卡：滿版元素密度（1~10）
  blackCardFullBleedThickness: 4,     // 黑卡：滿版元素粗細（1~10）
  blackCardFullBleedRelief: 5,        // 黑卡：滿版元素浮雕強度（1~10）
  blackCardSignatureText: '',         // 黑卡：藝術簽名文字
  blackCardSignatureFont: null,       // 黑卡：藝術簽名字體
  aiBackgroundPrompt: '',             // 悠遊卡／一卡通：AI生成背景的文字描述（只還原輸入框內容用，見 preview2d.js initAiBackgroundPanel()）
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  contactNote: ''
};

const TOTAL_STEPS = 5;

// ─── 設計自動保存（草稿服務，見 js/draft-store.js）─────────────────
// 使用者在配置器內任何有意義的修改都會（debounce 後）整包存進本分頁、本商品專屬的
// 草稿鍵值，重新整理網頁／關閉分頁後重開／再次進入 /customize 都能自動接回上次的完整
// 設計，不用重新選商品。直接存整個 STATE（含 canvasJSON——canvas 物件位置/縮放/旋轉/
// 顯示/鎖定/圖層順序全部包在裡面，見 preview2d.js 的 getCanvas2DJSON()），不是另外
// 維護一份精簡摘要，避免兩邊欄位漂移不同步。
//
// 跟舊版最大的差異：草稿鍵值＝ productId ＋ 本分頁的 draftId，不再是單一全域鍵——
// 兩個分頁編輯不同商品、或同一分頁在商品之間切換，都不會互相覆蓋（詳見 draft-store.js
// 開頭的說明）。
let _yzSaveTimer = null;

function scheduleSaveDesign() {
  if (_yzSaveTimer) clearTimeout(_yzSaveTimer);
  _yzSaveTimer = setTimeout(saveDesignNow, 500);
}

function saveDesignNow() {
  if (!STATE.productId) return; // 還沒選商品，沒有需要保存的內容
  // Step3 當下 STATE.canvasJSON／designDataURL 只有在「離開設計頁」時才會更新
  // （見 goStep()），保存當下若人還在 Step3，要先即時抓一次最新畫布狀態，
  // 否則存到的會是「進入設計頁那一刻」的舊快照，不是使用者剛剛做的修改。
  if (STATE.step === 3 && typeof getCanvas2DJSON === 'function' && typeof canvas2d !== 'undefined' && canvas2d) {
    STATE.canvasJSON = getCanvas2DJSON();
    STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : STATE.designDataURL;
  }
  const stateClone = _cloneSerializable(STATE);
  if (!stateClone) { _yzLog('saveDesignNow: STATE 無法序列化', null); return; }
  saveDraft({
    version: 1,
    draftId: getTabDraftId(),
    productId: STATE.productId,
    currentStep: STATE.step,
    updatedAt: Date.now(),
    state: stateClone
  });
  _updateClearSavedDesignBtn();
}

// canvas 尺寸依實際容器寬度計算（見 init2DCanvas 的 el.parentElement.offsetWidth），
// 容器必須先在畫面上真的顯示過一次才會量到正確寬度——如果直接把 STATE.step
// 設成 4／5 就 renderStep()，Step3 面板從沒顯示過，畫布會用預設寬度建立，
// 跟原本存檔時的尺寸對不上，物件位置/縮放全部跑掉。所以還原一律先讓 Step3
// 面板顯示、走一次正常的 initDesignStep()／loadCanvas2DJSON() 流程，等畫布
// 真的還原完成（物件數量到齊）才跳到使用者離開前所在的那一步。
function _waitForCanvasRestoreReady(expectedCount, timeoutMs) {
  return new Promise(resolve => {
    const start = Date.now();
    (function poll() {
      if (typeof canvas2d !== 'undefined' && canvas2d && canvas2d.getObjects().length >= expectedCount) { resolve(); return; }
      if (Date.now() - start > timeoutMs) { resolve(); return; }
      setTimeout(poll, 40);
    })();
  });
}

// 把一份草稿（draft-store.js 的 loadDraft()／createDraft() 回傳的物件）套進目前畫面：
// 還原 STATE、還原畫布，並跳到草稿記錄的那一步。initDesignStep()／selectProduct() 恢復
// 既有草稿、頁面載入自動恢復都共用這個函式，避免兩處各自維護一套「還原到第幾步」的邏輯。
async function _applyDraftToConfigurator(draft, opts) {
  opts = opts || {};
  const savedState = draft.state;
  Object.keys(STATE).forEach(key => {
    if (Object.prototype.hasOwnProperty.call(savedState, key)) STATE[key] = savedState[key];
  });
  STATE.productId = draft.productId; // 以草稿鍵值的 productId 為準，不受內容欄位影響

  document.querySelectorAll('.product-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.productId === STATE.productId);
  });

  let targetStep = Math.min(Math.max(parseInt(draft.currentStep, 10) || savedState.step || 1, 1), TOTAL_STEPS);
  if (opts.minStep) targetStep = Math.max(targetStep, opts.minStep);

  if (targetStep <= 2) {
    STATE.step = targetStep;
    renderStep();
  } else {
    STATE.step = 3;
    renderStep();
    if (STATE.canvasJSON && Array.isArray(STATE.canvasJSON.objects)) {
      await _waitForCanvasRestoreReady(STATE.canvasJSON.objects.length, 2000);
    }
    if (targetStep !== 3) {
      STATE.step = targetStep;
      renderStep();
    }
  }

  if (typeof syncDesignState === 'function') syncDesignState();
}

// 頁面載入時：若這個分頁有「正在使用中」的草稿索引，接回該商品該草稿；索引存在但實際
// 讀取失敗（損壞／版本不相容／商品已下架）則不讓頁面掛掉，改為建立乾淨新設計並提示使用者。
async function restoreSavedDesignIfAny() {
  migrateLegacyGlobalSave();

  let activeIdx = null;
  try {
    const raw = sessionStorage.getItem('customizer:activeDraft');
    if (raw) activeIdx = JSON.parse(raw);
  } catch (e) { activeIdx = null; }

  if (!activeIdx || !activeIdx.productId || !activeIdx.draftId) { _updateClearSavedDesignBtn(); return false; }

  const draft = loadDraft(activeIdx.productId, activeIdx.draftId);
  if (!draft) {
    try { sessionStorage.removeItem('customizer:activeDraft'); } catch (e) {}
    _showConfiguratorToast('草稿無法恢復，已建立新設計');
    _updateClearSavedDesignBtn();
    return false;
  }

  await _applyDraftToConfigurator(draft);
  // product_view的「商品確實存在於目前可用的PRODUCTS」條件：草稿記錄的商品有可能在使用者
  // 上次編輯之後已經下架／停售，這裡額外檢查一次，商品已經不在PRODUCTS裡就不記錄。
  if (PRODUCTS[draft.productId]) _trackProductView(draft.productId, 'other');
  _showRestoredDesignToast(PRODUCTS[draft.productId]?.name || '');
  _updateClearSavedDesignBtn();
  return true;
}

// 「清除已保存設計」是使用者主動觸發的破壞性操作，一定要先確認才能清除；只清除「目前
// 商品、目前分頁」的草稿，明確告知不影響其他商品／其他分頁，避免使用者誤以為會清光全部。
// 確認視窗用頁面內 DOM（見 index.html #clear-draft-modal）取代原生 window.confirm()：
// 原生 confirm() 會整個卡住分頁的 JS 執行緒，自動化測試控制器沒有另外處理原生對話框
// 事件的話會直接卡死；改成一般 DOM 元素後，測試工具可以像操作任何按鈕一樣點擊
// 「取消」／「確認清除」，也不影響真實使用者的操作體驗。
let _clearDraftModalReturnFocusEl = null;

function clearSavedDesign() {
  if (!STATE.productId) return;
  const modal = document.getElementById('clear-draft-modal');
  if (!modal) return;
  const p = PRODUCTS[STATE.productId];
  const nameEl = document.getElementById('clear-draft-modal-product');
  if (nameEl) nameEl.textContent = p ? p.name : '目前商品';

  _clearDraftModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _clearDraftModalKeydown);
  const confirmBtn = document.getElementById('clear-draft-modal-confirm-btn');
  if (confirmBtn) confirmBtn.focus();
}

function _clearDraftModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    _cancelClearDraftModal();
    return;
  }
  // 極簡焦點循環：視窗內只有「取消」「確認清除」兩個可聚焦元素，Tab/Shift+Tab
  // 在兩者之間互相銜接，避免焦點跑出視窗外面（背景頁面此時不應該被操作）。
  if (e.key === 'Tab') {
    const cancelBtn = document.getElementById('clear-draft-modal-cancel-btn');
    const confirmBtn = document.getElementById('clear-draft-modal-confirm-btn');
    if (!cancelBtn || !confirmBtn) return;
    const active = document.activeElement;
    if (e.shiftKey && active === cancelBtn) { e.preventDefault(); confirmBtn.focus(); }
    else if (!e.shiftKey && active === confirmBtn) { e.preventDefault(); cancelBtn.focus(); }
  }
}

function _closeClearDraftModal() {
  const modal = document.getElementById('clear-draft-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _clearDraftModalKeydown);
  if (_clearDraftModalReturnFocusEl && typeof _clearDraftModalReturnFocusEl.focus === 'function') {
    _clearDraftModalReturnFocusEl.focus();
  }
  _clearDraftModalReturnFocusEl = null;
}

function _cancelClearDraftModal() {
  _closeClearDraftModal();
}

function _confirmClearDraftModal() {
  _closeClearDraftModal();
  resetConfigurator(); // 內部會清除目前商品在本分頁的草稿並回到 Step1（見下方 resetConfigurator）
}

// 「清空目前卡面」（Step3 危險操作）：跟上面「刪除此商品草稿」是完全獨立的兩個
// 確認視窗（不同 id、不同文案、不同後續動作），只清空目前設計畫布內容並留在設計稿頁，
// 不離開 Step3、不影響其他商品／其他分頁的草稿。同樣用頁面內 DOM 取代原生
// window.confirm()，理由與 clearSavedDesign() 上方註解相同（自動化測試可操作、
// 不卡住整個分頁的 JS 執行緒）。
let _clearCanvasModalReturnFocusEl = null;

function openClearCanvasModal() {
  const modal = document.getElementById('clear-canvas-modal');
  if (!modal) return;
  _clearCanvasModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _clearCanvasModalKeydown);
  const confirmBtn = document.getElementById('clear-canvas-modal-confirm-btn');
  if (confirmBtn) confirmBtn.focus();
}

function _clearCanvasModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    _cancelClearCanvasModal();
    return;
  }
  if (e.key === 'Tab') {
    const cancelBtn = document.getElementById('clear-canvas-modal-cancel-btn');
    const confirmBtn = document.getElementById('clear-canvas-modal-confirm-btn');
    if (!cancelBtn || !confirmBtn) return;
    const active = document.activeElement;
    if (e.shiftKey && active === cancelBtn) { e.preventDefault(); confirmBtn.focus(); }
    else if (!e.shiftKey && active === confirmBtn) { e.preventDefault(); cancelBtn.focus(); }
  }
}

function _closeClearCanvasModal() {
  const modal = document.getElementById('clear-canvas-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _clearCanvasModalKeydown);
  if (_clearCanvasModalReturnFocusEl && typeof _clearCanvasModalReturnFocusEl.focus === 'function') {
    _clearCanvasModalReturnFocusEl.focus();
  }
  _clearCanvasModalReturnFocusEl = null;
}

function _cancelClearCanvasModal() {
  _closeClearCanvasModal();
}

function _confirmClearCanvasModal() {
  _closeClearCanvasModal();
  if (typeof clear2D === 'function') clear2D();
}

// 圖層管理區塊在悠遊卡/一卡通搬到右欄（跟一般照片/Q版照片面板放一起，方便對照
// 圖層順序調整結果），保溫杯/黑卡沒有對應的右欄可放，留在左欄原位。appendChild
// 對同一個節點呼叫是「搬移」不是複製，不會產生第二份、也不會有重複id的風險。
function _placeLayerManagementBlock(isThermos, isBlackCard) {
  const block = document.getElementById('layer-management-block');
  if (!block) return;
  if (!isThermos && !isBlackCard) {
    const rightSlot = document.getElementById('layer-management-right-slot');
    if (rightSlot) rightSlot.appendChild(block);
  } else {
    const leftAnchor = document.getElementById('layer-management-left-anchor');
    if (leftAnchor && leftAnchor.parentNode) leftAnchor.parentNode.insertBefore(block, leftAnchor.nextSibling);
  }
}

// ─── 產品與規格摘要視窗（純顯示用途，沒有確認/取消的危險操作語意，
// 所以沒有 _confirm 版本，只有開/關）沿用同一套 Esc關閉／回焦點的邏輯 ───
let _specSummaryModalReturnFocusEl = null;

function openSpecSummaryModal() {
  const modal = document.getElementById('spec-summary-modal');
  if (!modal) return;
  _specSummaryModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _specSummaryModalKeydown);
  const closeBtn = document.getElementById('spec-summary-modal-close-btn');
  if (closeBtn) closeBtn.focus();
}

function _specSummaryModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSpecSummaryModal();
  }
}

function closeSpecSummaryModal() {
  const modal = document.getElementById('spec-summary-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _specSummaryModalKeydown);
  if (_specSummaryModalReturnFocusEl && typeof _specSummaryModalReturnFocusEl.focus === 'function') {
    _specSummaryModalReturnFocusEl.focus();
  }
  _specSummaryModalReturnFocusEl = null;
}

// ─── 文字與版面視窗（同樣純顯示/編輯用途，沒有確認/取消的危險操作語意）───
let _textDesignModalReturnFocusEl = null;

function openTextDesignModal() {
  const modal = document.getElementById('text-design-modal');
  if (!modal) return;
  _textDesignModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _textDesignModalKeydown);
  const firstInput = document.getElementById('design-text1');
  if (firstInput) firstInput.focus();
}

function _textDesignModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeTextDesignModal();
  }
}

function closeTextDesignModal() {
  const modal = document.getElementById('text-design-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _textDesignModalKeydown);
  if (_textDesignModalReturnFocusEl && typeof _textDesignModalReturnFocusEl.focus === 'function') {
    _textDesignModalReturnFocusEl.focus();
  }
  _textDesignModalReturnFocusEl = null;
  _updateTextDesignTriggerBrief();
}

// 觸發按鈕上的一行摘要：跟規格摘要按鈕同樣的道理，收合進彈出視窗後按鈕本身
// 還是要能一眼看到目前填的是什麼內容，不用點開才知道。
function _updateTextDesignTriggerBrief() {
  const brief = document.getElementById('text-design-trigger-brief');
  if (!brief) return;
  const t1 = (document.getElementById('design-text1')?.value || '').trim();
  const t2 = (document.getElementById('design-text2')?.value || '').trim();
  brief.textContent = (t1 || t2) ? [t1, t2].filter(Boolean).join(' · ') : '尚未填寫文字內容';
}

// 藝術簽名彈窗說明文案：依商品類型產生對應文字，避免把特定商品的措辭（例如保溫杯的
// 「杯身」）寫死在共用彈窗邏輯裡；卡片類商品（悠遊卡／一卡通／黑卡）共用同一套「卡面」
// 措辭，其餘未來新增商品則退回「商品印刷範圍內」的通用說法。
function getSignatureDescription(productId) {
  if (productId === 'thermos') {
    return '加入專屬簽名文字，預設置中，可獨立調整大小、位置、旋轉與顏色，會呈現在杯身印刷範圍內。';
  }
  if (productId === 'easycard' || productId === 'ipass' || productId === 'black_card') {
    return '加入專屬簽名文字，可獨立調整大小、位置、旋轉與顏色，會呈現在卡面印刷範圍內。';
  }
  return '加入專屬簽名文字，可獨立調整大小、位置、旋轉與顏色，會呈現在商品印刷範圍內。';
}

// ─── AI 生成背景：裁切彈窗（跟文字與版面視窗同一套彈窗互動邏輯；實際畫布內容/裁切運算
//     在 preview2d.js _initAiBgCropCanvas() 等函式，這裡只負責彈窗開關本身）───
let _aiBgCropModalReturnFocusEl = null;

function openAiBgCropModal() {
  if (!lastAiBackgroundImageDataURL) return; // 還沒有可裁切的生成圖片，不開啟彈窗
  const modal = document.getElementById('ai-bg-crop-modal');
  if (!modal) return;
  _aiBgCropModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _aiBgCropModalKeydown);
  // 先讓彈窗顯示（class移除後容器才有真實寬度），再初始化裁切畫布，
  // 避免 wrap.clientWidth 在彈窗還是 display:none 時量到 0
  if (typeof _initAiBgCropCanvas === 'function') _initAiBgCropCanvas(lastAiBackgroundImageDataURL);
}

function _aiBgCropModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeAiBgCropModal();
  }
}

function closeAiBgCropModal() {
  const modal = document.getElementById('ai-bg-crop-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _aiBgCropModalKeydown);
  if (typeof _teardownAiBgCropCanvas === 'function') _teardownAiBgCropCanvas();
  if (_aiBgCropModalReturnFocusEl && typeof _aiBgCropModalReturnFocusEl.focus === 'function') {
    _aiBgCropModalReturnFocusEl.focus();
  }
  _aiBgCropModalReturnFocusEl = null;
}

// ─── 保溫杯「藝術簽名」視窗（跟文字與版面視窗同一套彈窗互動邏輯）───
let _thermosSignatureModalReturnFocusEl = null;

function openThermosSignatureModal() {
  const modal = document.getElementById('thermos-signature-modal');
  if (!modal) return;
  const desc = document.getElementById('thermos-signature-modal-desc');
  if (desc) desc.textContent = getSignatureDescription(STATE.productId);
  _thermosSignatureModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _thermosSignatureModalKeydown);
  const firstInput = document.getElementById('thermos-signature-input');
  if (firstInput) firstInput.focus();
}

function _thermosSignatureModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeThermosSignatureModal();
  }
}

function closeThermosSignatureModal() {
  const modal = document.getElementById('thermos-signature-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _thermosSignatureModalKeydown);
  if (_thermosSignatureModalReturnFocusEl && typeof _thermosSignatureModalReturnFocusEl.focus === 'function') {
    _thermosSignatureModalReturnFocusEl.focus();
  }
  _thermosSignatureModalReturnFocusEl = null;
  _updateThermosSignatureTriggerBrief();
}

function _updateThermosSignatureTriggerBrief() {
  const brief = document.getElementById('thermos-signature-trigger-brief');
  if (!brief) return;
  const text = (document.getElementById('thermos-signature-input')?.value || '').trim();
  brief.textContent = text || '尚未加入簽名';
}

// ─── 黑卡「藝術簽名」視窗（原本是右欄分頁的一部分，改成跟保溫杯同一套
// 「左欄收合卡片＋彈窗」樣式，因此需要一樣的開關互動邏輯）───
let _blackCardSignatureModalReturnFocusEl = null;

function openBlackCardSignatureModal() {
  const modal = document.getElementById('black-card-signature-modal');
  if (!modal) return;
  const desc = document.getElementById('black-card-signature-modal-desc');
  if (desc) desc.textContent = getSignatureDescription(STATE.productId);
  _blackCardSignatureModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _blackCardSignatureModalKeydown);
  const firstInput = document.getElementById('black-card-signature-input');
  if (firstInput) firstInput.focus();
}

function _blackCardSignatureModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeBlackCardSignatureModal();
  }
}

function closeBlackCardSignatureModal() {
  const modal = document.getElementById('black-card-signature-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _blackCardSignatureModalKeydown);
  if (_blackCardSignatureModalReturnFocusEl && typeof _blackCardSignatureModalReturnFocusEl.focus === 'function') {
    _blackCardSignatureModalReturnFocusEl.focus();
  }
  _blackCardSignatureModalReturnFocusEl = null;
  _updateBlackCardSignatureTriggerBrief();
}

// ─── 隱私權政策彈窗 ─────────────────────────────────────────
// 內容不寫死在這裡：第一次開啟時才 fetch /privacy 頁面本身，抓出裡面的
// .policy-wrap 內文區塊直接顯示，兩邊文字只會有一份，之後改 privacy.html
// 內容不需要記得回來同步這裡。fetch 對象是同站點自己的靜態頁面（不是使用者
// 輸入或第三方內容），innerHTML 寫入的是我們自己維護的信任內容，沒有 XSS 疑慮。
let _privacyModalReturnFocusEl = null;
let _privacyModalLoaded = false;

function openPrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (!modal) return;
  _privacyModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _privacyModalKeydown);

  const body = document.getElementById('privacy-modal-body');
  if (body && !_privacyModalLoaded) {
    fetch('/privacy')
      .then(r => r.text())
      .then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const main = doc.querySelector('.policy-wrap');
        if (!main) throw new Error('policy-wrap not found');
        // 彈窗已經有自己的標題與「關閉」按鈕，內文裡重複的標題/返回首頁按鈕不需要
        main.querySelectorAll('.policy-eyebrow, h1, .back-home-btn').forEach(el => el.remove());
        body.innerHTML = main.innerHTML;
        _privacyModalLoaded = true;
      })
      .catch(() => {
        body.innerHTML = '<p>載入隱私權政策內容時發生問題，請改用下方「開新分頁查看完整頁面」，或電洽 02-2680-9966。</p>';
      });
  }
}

function _privacyModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closePrivacyModal();
  }
}

function closePrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _privacyModalKeydown);
  if (_privacyModalReturnFocusEl && typeof _privacyModalReturnFocusEl.focus === 'function') {
    _privacyModalReturnFocusEl.focus();
  }
  _privacyModalReturnFocusEl = null;
}

function _updateBlackCardSignatureTriggerBrief() {
  const brief = document.getElementById('black-card-signature-trigger-brief');
  if (!brief) return;
  const text = (document.getElementById('black-card-signature-input')?.value || '').trim();
  brief.textContent = text || '尚未加入簽名';
}

// ─── 刪除單一圖層的確認視窗（沿用跟上面兩個危險操作同一套 .clear-draft-modal
// 樣式與鍵盤操作邏輯）：範圍最小，只刪除圖層面板點選的那一個物件。用
// _layerDeleteModalPendingIndex 記住是哪一個圖層要刪除，確認時才真的執行。
let _layerDeleteModalReturnFocusEl = null;
let _layerDeleteModalPendingIndex = null;

function _openLayerDeleteModal(index, label) {
  const modal = document.getElementById('layer-delete-modal');
  if (!modal) return;
  _layerDeleteModalPendingIndex = index;
  const nameEl = document.getElementById('layer-delete-modal-name');
  if (nameEl) nameEl.textContent = label || '此圖層';
  _layerDeleteModalReturnFocusEl = document.activeElement;
  modal.classList.remove('hidden');
  document.addEventListener('keydown', _layerDeleteModalKeydown);
  const confirmBtn = document.getElementById('layer-delete-modal-confirm-btn');
  if (confirmBtn) confirmBtn.focus();
}

function _layerDeleteModalKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    _cancelLayerDeleteModal();
    return;
  }
  if (e.key === 'Tab') {
    const cancelBtn = document.getElementById('layer-delete-modal-cancel-btn');
    const confirmBtn = document.getElementById('layer-delete-modal-confirm-btn');
    if (!cancelBtn || !confirmBtn) return;
    const active = document.activeElement;
    if (e.shiftKey && active === cancelBtn) { e.preventDefault(); confirmBtn.focus(); }
    else if (!e.shiftKey && active === confirmBtn) { e.preventDefault(); cancelBtn.focus(); }
  }
}

function _closeLayerDeleteModal() {
  const modal = document.getElementById('layer-delete-modal');
  if (modal) modal.classList.add('hidden');
  document.removeEventListener('keydown', _layerDeleteModalKeydown);
  if (_layerDeleteModalReturnFocusEl && typeof _layerDeleteModalReturnFocusEl.focus === 'function') {
    _layerDeleteModalReturnFocusEl.focus();
  }
  _layerDeleteModalReturnFocusEl = null;
  _layerDeleteModalPendingIndex = null;
}

function _cancelLayerDeleteModal() {
  _closeLayerDeleteModal();
}

function _confirmLayerDeleteModal() {
  const index = _layerDeleteModalPendingIndex;
  _closeLayerDeleteModal();
  if (index !== null && typeof _performLayerDelete === 'function') _performLayerDelete(index);
}

// ─── 手機版設計頁：四區塊分頁（設計預覽／文字與版面／圖層管理／AI・圖片工具）───
// 純粹切換 [data-mobile-group] 元素的顯示狀態（CSS 只在 <=760px 生效，見
// style.css），不重新渲染、不重建畫布，切換分頁不會清除任何輸入內容、圖層
// 或縮放值。桌面版完全不受影響（.wb-mobile-tabs 本身在桌面版就是 display:none）。
let _mobileDesignGroup = 'preview';
function setMobileDesignGroup(group) {
  _mobileDesignGroup = group;
  document.querySelectorAll('[data-mobile-group]').forEach(el => {
    el.classList.toggle('wb-mobile-hidden', el.dataset.mobileGroup !== group);
  });
  document.querySelectorAll('.wb-mobile-tab-btn').forEach(btn => {
    const isActive = btn.dataset.mobileTab === group;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}

// 訂單成功送出、或使用者主動「重新配置」後，這份設計已經完成階段性任務，不需要再被
// 「自動恢復」，避免下次開新訂單時被強制接回已經處理過的舊設計。只清除指定商品（或目前
// 商品）在本分頁的草稿，不影響其他商品／其他分頁。
function _clearSavedDesignSilently(productId) {
  const pid = productId || STATE.productId;
  if (!pid) return;
  try { clearDraft(pid, getTabDraftId()); } catch (e) {}
  _updateClearSavedDesignBtn();
}

function _updateClearSavedDesignBtn() {
  const btn = document.getElementById('clear-saved-design-btn');
  const kebabMenu = document.getElementById('draft-kebab-menu');
  if (!btn && !kebabMenu) return;
  let hasSaved = false;
  if (STATE.productId) {
    try { hasSaved = !!localStorage.getItem(draftKey(STATE.productId, getTabDraftId())); } catch (e) {}
  }
  if (btn) btn.classList.toggle('hidden', !hasSaved);
  // 手機版三點選單跟桌面按鈕用同一個 hasSaved 條件，CSS 媒體查詢再依螢幕寬度二選一顯示
  // 哪一種（見 style.css .draft-kebab-menu），這裡不用另外判斷是不是手機。
  if (kebabMenu) kebabMenu.classList.toggle('hidden', !hasSaved);
  if (!hasSaved && typeof closeDraftKebabMenu === 'function') closeDraftKebabMenu();
}

// 手機版「刪除此商品草稿」三點選單：點三點按鈕開關下拉選單，點選單外任何地方或按
// Esc 都會關閉，跟頁面其餘的彈出視窗（藝術簽名彈窗等）用同一套「Esc關閉、點背景關閉」
// 習慣一致。選單本身只有一個項目，點了直接觸發既有的 clearSavedDesign() 二次確認流程，
// 不另外重複實作刪除邏輯。
function toggleDraftKebabMenu() {
  const dropdown = document.getElementById('draft-kebab-dropdown');
  const trigger = document.getElementById('draft-kebab-trigger');
  if (!dropdown || !trigger) return;
  const willOpen = dropdown.classList.contains('hidden');
  if (willOpen) openDraftKebabMenu(); else closeDraftKebabMenu();
}
function openDraftKebabMenu() {
  const dropdown = document.getElementById('draft-kebab-dropdown');
  const trigger = document.getElementById('draft-kebab-trigger');
  if (!dropdown || !trigger) return;
  dropdown.classList.remove('hidden');
  trigger.setAttribute('aria-expanded', 'true');
  document.addEventListener('click', _draftKebabOutsideClick, true);
  document.addEventListener('keydown', _draftKebabKeydown);
}
function closeDraftKebabMenu() {
  const dropdown = document.getElementById('draft-kebab-dropdown');
  const trigger = document.getElementById('draft-kebab-trigger');
  if (dropdown) dropdown.classList.add('hidden');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  document.removeEventListener('click', _draftKebabOutsideClick, true);
  document.removeEventListener('keydown', _draftKebabKeydown);
}
function _draftKebabOutsideClick(e) {
  const menu = document.getElementById('draft-kebab-menu');
  if (menu && !menu.contains(e.target)) closeDraftKebabMenu();
}
function _draftKebabKeydown(e) {
  if (e.key === 'Escape') closeDraftKebabMenu();
}

// 呼叫這個函式的時間點本身就代表「商品模板／輸入值／Canvas 圖層已經還原完成」——
// 呼叫端（restoreSavedDesignIfAny() → _applyDraftToConfigurator()）已經 await 過
// canvas 還原的輪詢確認（_waitForCanvasRestoreReady()），這裡不需要、也不應該再等
// 字型或其他外部資源載入完成才顯示：那樣的等待時間不固定（字型可能因為網路狀況延遲
// 數秒甚至更久），反而會讓 toast「看起來」很久都不出現。只需要多等一個畫面重繪
// frame，確保 hidden→visible 的 class 切換能被瀏覽器實際觸發 CSS transition。
function _showConfiguratorToast(text) {
  const el = document.getElementById('design-restored-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(_showConfiguratorToast._t);
  _showConfiguratorToast._t = setTimeout(() => {
    el.classList.remove('show');
    el.setAttribute('aria-hidden', 'true');
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 3000);
}

function _showRestoredDesignToast(productName) {
  _showConfiguratorToast(productName ? `已恢復：${productName}` : '已恢復上次設計');
}

// 背景蒙版造型清單（CARD_MASK_SHAPES，10款）定義在 preview2d.js，跟實際畫路徑的
// _addYangZhuVectorBackground()／applyMaskShape2D() 放在一起維護；這裡不重複宣告
// 第二份，avoid 兩邊資料對不齊。

// ─── 可信結果的匿名關聯（楊竹分析後台第二階段第二批）────────────────────────
// 供 /api/save-order、/api/black-card-pattern-candidates、/api/cartoon-image、
// /api/generate-image、/api/generate-design 這5個正式請求選填夾帶 analyticsContext。
// 完全沿用 window.YZAnalytics 既有的唯讀方法（getAnonymousVisitorId()／getSessionId()），
// 不直接讀 localStorage／sessionStorage，也不建立第二套識別邏輯；preview2d.js、ai-design.js
// 透過 typeof 檢查呼叫這支函式（跟既有 _trackUploadResult() 等追蹤輔助函式相同的跨檔案共用
// 慣例，不受script標籤載入順序影響，因為實際呼叫都發生在使用者互動之後、全部腳本都已載入）。
// 任何一步失敗（YZAnalytics不存在、方法丟例外、回傳空值）一律回傳 null，呼叫端據此完全省略
// analyticsContext欄位，絕對不能讓詢價或AI功能因為這裡出錯而中斷。
function _getAnalyticsContextForRequest() {
  try {
    if (!window.YZAnalytics || typeof window.YZAnalytics.getAnonymousVisitorId !== 'function' || typeof window.YZAnalytics.getSessionId !== 'function') {
      return null;
    }
    const anonymousVisitorId = window.YZAnalytics.getAnonymousVisitorId();
    const sessionId = window.YZAnalytics.getSessionId();
    if (!anonymousVisitorId || !sessionId) return null;
    return { anonymousVisitorId: anonymousVisitorId, sessionId: sessionId };
  } catch (e) {
    return null;
  }
}

// ─── 事件追蹤（前台事件追蹤串接第二小步：商品瀏覽與開始客製化）─────────────────
// 沿用共用追蹤基礎 window.YZAnalytics.track()（見 js/analytics-tracker.js），這裡只負責
// 判斷「什麼時候該送 product_view／customization_start、送哪個 productId／entryPoint」，
// 不建立第二套追蹤程式，也完全不修改 server.js／db.js／事件規格。
// 用頁面記憶體中的 Set（重新整理網頁就會重置，不寫進 localStorage）避免同一個商品在同一次
// 頁面生命週期內，因為深連結、selectProduct()、草稿套用、renderStep() 重複渲染等不同路徑
// 同時觸發而重複記錄；換一個商品是不同的 Set key，會各自記錄一次。
const _trackedProductViewIds = new Set();
const _trackedCustomizationStartIds = new Set();
// 記錄「使用者最近一次是怎麼進到這個商品」，只有真的成立 customization_start（Step2→Step3）
// 時才會用到；即使 product_view 因為 Set 已經記過而被跳過，entryPoint 仍會依最新一次的
// 進入方式更新，避免用到很久以前、不是這次真正促成客製化開始的入口。
const _productEntryPoint = {};

function _trackProductView(productId, entryPoint) {
  if (entryPoint) _productEntryPoint[productId] = entryPoint;
  if (!productId || _trackedProductViewIds.has(productId)) return;
  _trackedProductViewIds.add(productId);
  if (window.YZAnalytics && typeof window.YZAnalytics.track === 'function') {
    try { window.YZAnalytics.track('product_view', { productId: productId }); } catch (e) { /* 追蹤失敗不得影響商品選擇 */ }
  }
}

function _trackCustomizationStart(productId) {
  if (!productId || _trackedCustomizationStartIds.has(productId)) return;
  _trackedCustomizationStartIds.add(productId);
  const entryPoint = _productEntryPoint[productId] || 'other';
  if (window.YZAnalytics && typeof window.YZAnalytics.track === 'function') {
    try {
      window.YZAnalytics.track('customization_start', {
        productId: productId,
        metadata: { entryPoint: entryPoint }
      });
    } catch (e) { /* 追蹤失敗不得影響步驟切換 */ }
  }
}

// ?product= 深連結的 entryPoint 判斷：只有從本站 landing.html／首頁進來才算 product_page，
// 外部網址、沒有來源（直接貼網址、書籤）一律算 direct，不自行新增後端未允許的值。
function _resolveDeepLinkEntryPoint() {
  try {
    const ref = document.referrer;
    if (!ref) return 'direct';
    const refUrl = new URL(ref);
    if (refUrl.origin !== window.location.origin) return 'direct';
    if (refUrl.pathname === '/' || refUrl.pathname === '/landing.html') return 'product_page';
    return 'direct';
  } catch (e) {
    return 'direct';
  }
}

// ─── 事件追蹤（前台事件追蹤串接下一批：customization_step_complete／upload_result／
// preview_complete）───────────────────────────────────────────────────
// 同樣沿用 window.YZAnalytics.track()，不建立第二套追蹤程式。

// customization_step_complete／preview_complete 都是「同一頁面生命週期、同一個商品
// 只算一次」，用 Set 去重；customization_step_complete 額外把 stepKey 併進key（同一個
// 商品的 specification／design 是兩個獨立的完成事件，都要各記一次），格式為
// `${productId}::${stepKey}`。
const _trackedStepCompleteKeys = new Set();
const _trackedPreviewCompleteIds = new Set();

// preview_complete 的「這次進 Step4 是不是一次合法的 Step3→4 前進」判斷：草稿恢復
// （_applyDraftToConfigurator()）、重新整理後直接還原到 Step4、返回修改後非經
// goStep() 的重繪，全部都不透過 goStep() 或不是從 Step3 合法前進而來，不該算數。
// 做法：只有 goStep() 判斷「這次是通過驗證、真的要從 Step3 前進到 Step4」那一刻，
// 才把 productId 寫進這個一次性的 pending 狀態，而且要在 renderStep()（會呼叫
// initPreviewStep()）執行「之前」就寫入，initPreviewStep() 才讀得到。initPreviewStep()
// 一開始就讀取並立刻清空這個值（不論這次渲染最後是否成功、有沒有真的建立有效
// callback），避免殘留下來被下一次非正式的重繪誤用。只有讀到的 pending productId
// 跟這次 initPreviewStep() 服務的商品相符，才會組出真正會呼叫 _trackPreviewComplete()
// 的 callback；否則組出一個什麼都不做的空 callback，讓渲染邏輯本身完全不用改。
let _pendingPreviewTrackProductId = null;

function _trackCustomizationStepComplete(productId, stepKey) {
  if (!productId || !stepKey) return;
  const key = productId + '::' + stepKey;
  if (_trackedStepCompleteKeys.has(key)) return;
  _trackedStepCompleteKeys.add(key);
  if (window.YZAnalytics && typeof window.YZAnalytics.track === 'function') {
    try { window.YZAnalytics.track('customization_step_complete', { productId: productId, stepKey: stepKey }); }
    catch (e) { /* 追蹤失敗不得影響步驟切換 */ }
  }
}

function _trackPreviewComplete(productId) {
  if (!productId || _trackedPreviewCompleteIds.has(productId)) return;
  _trackedPreviewCompleteIds.add(productId);
  if (window.YZAnalytics && typeof window.YZAnalytics.track === 'function') {
    try { window.YZAnalytics.track('preview_complete', { productId: productId }); }
    catch (e) { /* 追蹤失敗不得影響預覽功能 */ }
  }
}

// inquiry_form_start：Step5 聯絡表單4個欄位（姓名／Email／電話／備註）中，任何一個
// 欄位第一次發生「真正的使用者輸入」（'input'事件）就記錄一次，同一商品單次頁面生命
// 週期只算一次。只監聽原生'input'事件、不監聽'focus'——只是點進欄位、程式碼賦值
// （目前整個專案也沒有任何地方會自動把值填進這4個欄位）都不會觸發'input'，天生不會
// 誤算草稿恢復或自動填值。監聽器只綁一次（跟_bindContactFieldClearOnInput()同樣的
// 「進Step5就呼叫，內部用旗標防止重複綁定」模式），事件觸發當下讀取當時的
// STATE.productId，就算之後切換到別的商品也不會誤植（因為判斷式讀的是「觸發當下」
// 的值，不是綁定當下）。
const _trackedInquiryFormStartIds = new Set();
function _trackInquiryFormStart(productId) {
  if (!productId || _trackedInquiryFormStartIds.has(productId)) return;
  _trackedInquiryFormStartIds.add(productId);
  if (window.YZAnalytics && typeof window.YZAnalytics.track === 'function') {
    try { window.YZAnalytics.track('inquiry_form_start', { productId: productId }); }
    catch (e) { /* 追蹤失敗不得影響表單填寫 */ }
  }
}
let _inquiryFormFieldListenersBound = false;
function _bindInquiryFormStartListeners() {
  if (_inquiryFormFieldListenersBound) return;
  _inquiryFormFieldListenersBound = true;
  ['contact-name', 'contact-email', 'contact-phone', 'contact-note'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => _trackInquiryFormStart(STATE.productId));
  });
}

// inquiry_validation_error：DOM欄位id對應後端白名單fieldKey，只送這3個有對應分類的
// 欄位（contact-address目前表單沒有這個欄位，不會用到）。
const ANALYTICS_CONTACT_FIELD_KEY_MAP = {
  'contact-name': 'contactName',
  'contact-email': 'contactEmail',
  'contact-phone': 'contactPhone'
};
function _trackInquiryValidationError(productId, fieldKey, errorCategory) {
  if (!productId || !fieldKey || !errorCategory) return;
  if (window.YZAnalytics && typeof window.YZAnalytics.track === 'function') {
    try {
      window.YZAnalytics.track('inquiry_validation_error', {
        productId: productId,
        metadata: { fieldKey: fieldKey, errorCategory: errorCategory }
      });
    } catch (e) { /* 追蹤失敗不得影響紅框、錯誤提示與focus */ }
  }
}

// upload_result 不用Set去重——使用者每次主動選檔案都是獨立的一次上傳嘗試，各自都要
// 記錄一筆最終結果（成功或失敗擇一，不會兩者都送）。errorCategory 只能是這5種穩定分類
// 其中之一，不記錄檔名、圖片內容或原始錯誤訊息。
const ANALYTICS_UPLOAD_MAX_BYTES = 20 * 1024 * 1024; // 20MB，與現有Q版照片上傳的伺服器端上限一致
function _validateUploadFile(file) {
  if (!file || !file.type || file.type.indexOf('image/') !== 0) return 'unsupported_type';
  if (file.size > ANALYTICS_UPLOAD_MAX_BYTES) return 'file_too_large';
  return null;
}
function _trackUploadResult(productId, result, errorCategory) {
  if (!productId) return;
  if (!window.YZAnalytics || typeof window.YZAnalytics.track !== 'function') return;
  const metadata = { result: result };
  if (result === 'failure') metadata.errorCategory = errorCategory || 'processing_failed';
  try { window.YZAnalytics.track('upload_result', { productId: productId, metadata: metadata }); }
  catch (e) { /* 追蹤失敗不得影響圖片上傳功能 */ }
}

// 粗略但可靠的「畫布輸出非空白」判斷：base64 內容長度太短，代表輸出幾乎必定是
// 空白／純色／透明（PNG 壓縮率極高），正常卡面（含背景模板、文字或圖片）壓縮後
// 至少會有數 KB。用來擋下「canvas 尚未 render 完成就被拿去做預覽」這類情況。
function isDesignSnapshotValid(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return false;
  const base64 = dataUrl.split(',')[1] || '';
  return base64.length > 2000;
}

// ─── 步驟導覽 ──────────────────────────────────────────────
// 全站唯一一份 goStep()：曾經一度在 index.html 底部另外放了一份同名的內聯 function
// 覆寫這裡的定義（同一個全域作用域，後宣告的同名 function 會整個蓋掉先前的），導致
// 這裡的版本變成永遠不會執行的死碼，而真正在跑的 index.html 那份又少了下面的
// scheduleSaveDesign() 呼叫——結果是「STATE.step 已經改變、畫面也已經切換，但
// 這次的步驟數字沒有被排入自動保存」，使用者在 Step4／Step5 重新整理網頁時會被
// 退回上一步，讓人誤以為進度不見了（其實設計內容都還在，只是「目前在第幾步」這
// 一個數字沒存到）。現在把兩份的邏輯合併回這一份，不再有第二個 goStep() 定義。
function goStep(n) {
  if (n < 1 || n > TOTAL_STEPS) return;
  // 正常操作路徑不會走到這兩個分支（選商品／進 Step2 時規格一定已經有預設值），
  // 純屬防禦性檢查；一旦真的觸發，用不會卡住整個分頁 JS 執行緒的 Toast 取代
  // alert()，維持跟其餘步驟一致的錯誤提示方式。
  if (n > 1 && !STATE.productId) { _showConfiguratorToast('請先選擇產品'); return; }
  if (n > 2 && !STATE.materialId) { _showConfiguratorToast('請先完成規格選擇'); return; }

  _yzLog('goStep', {
    from: STATE.step, to: n, productId: STATE.productId,
    hasCanvasDataUrl: !!STATE.designDataURL,
    canvasDataUrlLen: STATE.designDataURL ? STATE.designDataURL.length : 0,
    canvasObjectCount: (typeof canvas2d !== 'undefined' && canvas2d) ? canvas2d.getObjects().length : 0,
    hasSelectedAiImage: !!STATE.blackCardSelectedImage,
    hasPrintableDesign: (typeof hasPrintableDesign === 'function') ? hasPrintableDesign() : null
  });

  // 離開設計步驟前必須通過 canProceedToPreview()（已有可印製內容，且不是原封不動的
  // 示範文字），否則預覽會是空白、或只是使用者從沒動過的模板示範內容。Step3「預覽成品」
  // 按鈕本身已經依同一個判斷停用，這裡是防止鍵盤操作、程式呼叫等繞過按鈕停用狀態的
  // 第二道防線，觸發時停在原地並指出怎麼修正，不會真的往下一步走。
  if (STATE.step === 3 && n > 3 && !canProceedToPreview()) {
    if (STATE.productId === 'black_card') {
      const errEl = document.getElementById('black-card-pattern-error');
      if (errEl) {
        errEl.textContent = '請先加入壓印文字、上傳圖片或選擇一個 AI 圖案。';
        errEl.classList.remove('hidden');
      }
      const candidatesGrid = document.getElementById('black-card-candidates');
      (candidatesGrid && !candidatesGrid.classList.contains('hidden') ? candidatesGrid : document.getElementById('black-card-generate-btn'))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // 非黑卡商品：Step3 CTA 列下方的 cta-disabled-reason 已經常駐顯示原因文字，
      // 這裡只需要確保按鈕/提示狀態是最新的並把畫面捲回去讓使用者看到，不用另外
      // 跳 Toast（避免跟常駐提示重複兩份訊息）。
      if (typeof updateStep3NextButtonState === 'function') updateStep3NextButtonState();
      document.getElementById('step3-next-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    return;
  }

  const _fromStepForTracking = STATE.step;

  // 離開設計步驟前，先快照 2D 設計圖（canvas 還在畫面上時最可靠）
  if (STATE.step === 3 && n !== 3) {
    // 中止尚未完成的 AI 生成背景請求，避免離開設計頁後回應才回來被誤套用
    // （黑卡圖案／Q版卡通化目前只在切換商品時中止，離開設計頁沒有對應處理；
    // 這裡只加這支新功能自己的中止呼叫，不更動既有兩支功能的既有行為）
    if (typeof abortAiBackgroundGeneration === 'function') abortAiBackgroundGeneration();
    STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : null;
    // 同時存下可編輯的 canvas 狀態（含物件位置/大小/旋轉角度），
    // 這樣「預覽 → 修改設計」返回時 initDesignStep() 才能真的還原，而不是重置成空白模板
    STATE.canvasJSON = (typeof getCanvas2DJSON === 'function') ? getCanvas2DJSON() : null;
    if (typeof syncDesignState === 'function') syncDesignState();
  }

  // 非黑卡商品進入 3D 預覽前，確認畫布輸出真的不是空白，避免商品貼圖套用失敗時
  // 使用者完全看不出來、還以為預覽已經正確完成。
  if (n === 4 && STATE.productId !== 'black_card' && !isDesignSnapshotValid(STATE.designDataURL)) {
    _showConfiguratorToast('設計圖尚未成功產生，請返回設計頁重新套用。');
    return;
  }

  // 離開預覽步驟時停止 3D 自動旋轉，避免動畫在背景持續佔用資源，
  // 也避免其他頁面截圖/互動時畫面仍在變動
  if (STATE.step === 4 && n !== 4) {
    if (typeof stopAnimation === 'function') stopAnimation();
    if (typeof stopBlackCardPreviewAnimation === 'function') stopBlackCardPreviewAnimation();
  }

  // 這裡已經通過上面所有驗證、確定是一次合法的 Step3→4 前進，在 renderStep()（會呼叫
  // initPreviewStep()）執行前先建立 pending 狀態，preview_complete 才知道這次渲染
  // 是不是要追蹤的對象（見上方 _pendingPreviewTrackProductId 宣告處的說明）。
  if (_fromStepForTracking === 3 && n === 4) _pendingPreviewTrackProductId = STATE.productId;

  STATE.step = n;
  renderStep();
  if (_fromStepForTracking === 2 && n === 3 && typeof _trackCustomizationStart === 'function') _trackCustomizationStart(STATE.productId);
  // customization_step_complete：只在通過上面所有驗證、真的成功換頁那一刻記錄，
  // 沒有走到這裡（驗證失敗提早return）就不會送出。Step1／Step5沒有對應的「完成」事件
  // （Step1還沒開始客製化；Step5是報價單頁本身，不是流程中的一個「完成的上一步」）。
  if (typeof _trackCustomizationStepComplete === 'function') {
    if (_fromStepForTracking === 2 && n === 3) _trackCustomizationStepComplete(STATE.productId, 'specification');
    else if (_fromStepForTracking === 3 && n === 4) _trackCustomizationStepComplete(STATE.productId, 'design');
    else if (_fromStepForTracking === 4 && n === 5) _trackCustomizationStepComplete(STATE.productId, 'preview');
  }
  if (typeof scheduleSaveDesign === 'function') scheduleSaveDesign();
}

function nextStep() { goStep(STATE.step + 1); }
function prevStep() { goStep(STATE.step - 1); }

const STEP_LABELS = ['選產品', '選規格', '設計稿', '預覽', '報價單'];

// 手機版步驟列精簡文字模式：視窗夠窄時把 5 個圓點換成「步驟 3／5・設計稿」純文字，
// 避免小螢幕上步驟列要橫向捲動才看得完整。
function updateStepIndicatorMode() {
  const el = document.getElementById('step-indicator');
  const label = document.getElementById('step-indicator-compact-label');
  if (!el) return;
  const compact = window.innerWidth <= 480;
  el.classList.toggle('step-indicator-compact', compact);
  if (compact && label) {
    label.textContent = `步驟 ${STATE.step}／${TOTAL_STEPS}・${STEP_LABELS[STATE.step - 1] || ''}`;
  }
}
window.addEventListener('resize', updateStepIndicatorMode);

function renderStep() {
  // 更新進度條
  document.querySelectorAll('.step-indicator .step').forEach((el, i) => {
    el.classList.toggle('active',   i + 1 === STATE.step);
    el.classList.toggle('done',     i + 1 <  STATE.step);
  });
  updateStepIndicatorMode();

  // 顯示對應面板
  document.querySelectorAll('.step-panel').forEach(el => {
    el.classList.toggle('hidden', el.dataset.step != STATE.step);
  });

  // 各步驟初始化。
  // 注意：Step2 的初始化（renderSpecStep()，負責畫出商品摘要／材質／工藝／容量／
  // 即時估價）過去只掛在 index.html 內一段覆寫 goStep() 的 inline script 裡
  // （`if (n === 2) renderSpecStep();`），本身沒有整合進這個「所有步驟共用的
  // 渲染入口」。草稿還原（_applyDraftToConfigurator()）等新流程是直接設定
  // STATE.step 後呼叫 renderStep()，完全不會經過 goStep()，導致還原到 Step2 時
  // 規格頁一片空白。這裡補上，讓「進入某一步該做什麼初始化」全部收斂在
  // renderStep() 這一個地方，不管透過 goStep() 或直接呼叫 renderStep() 都會正確
  // 初始化。renderSpecStep() 本身是用 innerHTML 整段重建＋重新綁定事件，重複呼叫
  // 不會累積殘留監聽器，跟 index.html 那段呼叫同時存在也不會有副作用。
  if (STATE.step === 2 && typeof renderSpecStep === 'function') renderSpecStep();
  if (STATE.step === 3) initDesignStep();
  if (STATE.step === 4) initPreviewStep();
  if (STATE.step === 5) initQuoteStep();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── Step 1：選產品 ────────────────────────────────────────
// 切換商品／重新配置時的唯一重設入口：停止上一個商品的動畫與尚未完成的 AI 生成工作、
// 清掉畫面上真正的 DOM（不是只用 CSS 隱藏）、把 STATE 與 designState 都重設成新商品的
// 乾淨初始值。selectProduct()／resetConfigurator() 都透過這個函式重設，避免各自維護
//一份容易漏掉欄位的重設邏輯。
function resetDesignStateForProduct(productId) {
  const _p = productId ? PRODUCTS[productId] : null;

  // 停止上一個商品的 3D 旋轉動畫，避免切換後還在背景跑
  if (typeof stopAnimation === 'function') stopAnimation();
  // 停止黑卡商品預覽的滑鼠光影互動迴圈，理由同上
  if (typeof stopBlackCardPreviewAnimation === 'function') stopBlackCardPreviewAnimation();
  // 取消尚未完成的 AI 請求，避免舊商品的回應在切換後才回來污染新商品狀態
  if (typeof abortBlackCardGeneration === 'function') abortBlackCardGeneration();
  if (typeof abortCartoonGeneration === 'function') abortCartoonGeneration();
  if (typeof abortAiBackgroundGeneration === 'function') abortAiBackgroundGeneration();

  // 黑卡候選圖是直接寫進 DOM 的，只切換面板可見度並不會清掉裡面的 .black-card-candidate
  // 節點與 selected 樣式，這裡直接清空，確保切到別的商品後 DOM 上真的沒有殘留候選圖。
  const candidatesGrid = document.getElementById('black-card-candidates');
  if (candidatesGrid) { candidatesGrid.innerHTML = ''; candidatesGrid.classList.add('hidden'); }
  const regenBtn = document.getElementById('black-card-regenerate-btn');
  if (regenBtn) regenBtn.classList.add('hidden');
  // 手機縮放控制列同理：不是同一個 canvas 觸發的 selection:cleared 不會自動隱藏
  if (typeof _hideScaleBar === 'function') _hideScaleBar();

  STATE.productId = productId;
  STATE.materialId = null;
  STATE.finishId   = null;
  STATE.capacityId = null;
  STATE.cupColorId = null;
  STATE.selectedLayerId = null;
  STATE.previewAngle = null;
  STATE.canvasJSON = null;
  STATE.designDataURL = null;
  STATE.blackCardPatternDataURL = null;
  STATE.blackCardPrompt = '';
  STATE.blackCardStyle = 'cute_round';
  STATE.blackCardCandidates = [];
  STATE.blackCardSelectedImage = null;
  STATE.blackCardFullBleedType = null;
  STATE.blackCardFullBleedDataURL = null;
  STATE.blackCardFullBleedDensity = 5;
  STATE.blackCardFullBleedThickness = 4;
  STATE.blackCardFullBleedRelief = 5;
  STATE.blackCardSignatureText = '';
  STATE.blackCardSignatureFont = null;
  STATE.aiBackgroundPrompt = '';
  _fullBleedCustomImg = null;
  STATE.textLine1 = '';
  STATE.textLine2 = '';
  // 商品專屬版面設定一律重設為預設值（zoom/rotation 也隨畫布重建回到 100%／0），
  // 避免沿用上一個商品的數量／背景／波浪色／字體
  STATE.qty = _p ? _p.minQty : 1;
  // 造型（backgroundTemplateId，現在存的是 CARD_MASK_SHAPES 的造型id）跟顏色兩者
  // 分開重設回預設值：顏色固定用楊竹綠白這組原本的預設色，造型固定用「空白背板」——
  // 悠遊卡／一卡通新設計預設為空白背板，客戶需要時才自行加入造型，不可再重設成
  // 'wave_single'（舊版預設「經典波浪」）。
  STATE.bgColor = '#ffffff';
  STATE.backgroundTemplateId = 'blank';
  STATE.waveColor = '#2D7D46';
  STATE.waveLightColor = '#dfead8';
  STATE.font = undefined;

  if (_p) {
    STATE.materialId = _p.materials[0].id;
    STATE.finishId   = (productId === 'black_card') ? 'emboss_black_standard' : _p.finishes[0].id;
    if (_p.capacities) STATE.capacityId = _p.capacities[0].id;
    if (_p.cupColors) STATE.cupColorId = _p.cupColors[0].id;
  }

  // designState 也一併歸零，不留上一個商品的 canvasDataUrl／selectedAiImage 等內容
  designState.productId = productId;
  designState.canvasDataUrl = null;
  designState.canvasJson = null;
  designState.mainTitle = '';
  designState.subTitle = '';
  designState.font = null;
  designState.textColor = null;
  designState.backgroundTemplate = STATE.backgroundTemplateId;
  designState.uploadedImage = null;
  designState.selectedAiImage = null;
  designState.objects = [];
  designState.zoom = 100;
  designState.rotation = 0;
  designState.updatedAt = Date.now();

  updateStep3NextButtonState();
  _yzLog('resetDesignStateForProduct', { productId });
}

// 選商品：先看「這個分頁」有沒有這個商品自己的草稿——有就接回上次編輯到的地方，
// 沒有才建立乾淨的新設計。不會、也不能把目前正在編輯的別的商品內容複製過來
// （見 draft-store.js 的 switchProductDraft() 說明，本階段明確不做跨商品複製）。
// entryPoint：未指定時預設 product_page（商品卡片點擊的正常情況），?product= 深連結會
// 明確傳入 _resolveDeepLinkEntryPoint() 判斷出的值。product_view 一定在確認商品真的存在
// （上面 _p 檢查通過）之後才記錄，商品不存在／已下架時直接return，不會走到這裡。
async function selectProduct(productId, entryPoint) {
  const _p = PRODUCTS[productId];
  if (!_p) {
    _showConfiguratorToast('此商品目前無法選購（可能已下架），請重新整理頁面或聯絡業務確認。');
    return;
  }

  _trackProductView(productId, entryPoint || 'product_page');

  const draft = loadDraft(productId, getTabDraftId());
  if (draft) {
    // 有草稿：直接接回上次的內容與步驟；若上次剛好停在 Step1（選商品當下就離開），
    // 這裡是使用者剛主動點選這個商品卡片的動作，理應至少進到 Step2 規格頁，
    // 不應該還停在商品選擇畫面。
    await _applyDraftToConfigurator(draft, { minStep: 2 });
  } else {
    resetDesignStateForProduct(productId);
    document.querySelectorAll('.product-card').forEach(el => {
      el.classList.toggle('selected', el.dataset.productId === productId);
    });
    nextStep();
  }
  scheduleSaveDesign();
}

// 「重新配置」：真正清除目前商品配置，回到乾淨的 Step 1，而不是只切換畫面
function resetConfigurator() {
  const prevProductId = STATE.productId;
  resetDesignStateForProduct(null);
  document.querySelectorAll('.product-card').forEach(el => el.classList.remove('selected'));
  STATE.step = 1;
  renderStep();
  // 開始全新配置，不應該保留舊的自動保存內容（否則重新整理網頁又會被接回剛剛
  // 主動清掉的那份設計）；只清除「原本那個商品、這個分頁」的草稿，不影響其他
  // 商品或其他分頁。這裡不彈確認框——呼叫端（clearSavedDesign() 或成功送出報價後
  // 的「重新配置」按鈕）各自已經在恰當時機處理過確認/完成的語意。
  if (typeof _clearSavedDesignSilently === 'function') _clearSavedDesignSilently(prevProductId);
}

// ─── Step 2：選規格 ────────────────────────────────────────
function getMaterialDescription(productId, materialId) {
  const notes = {
    easycard: {
      pvc: '常見票卡材質，耐用、成本穩定，適合一般客製卡。',
      pet: '較環保、質感較輕，適合企業 ESG 或活動禮贈。',
      wood: '自然紋理、送禮感強，適合紀念卡與特色禮品。'
    },
    ipass: {
      pvc: '標準票卡材質，耐用、適合日常使用與大量製作。',
      pet: '較環保、質感較輕，適合品牌活動與永續禮贈。'
    },
    usb_bar: {
      plastic: '輕巧、價格較親民，適合活動贈品與大量配送。',
      metal: '質感較好、耐用度高，適合企業禮贈與商務場合。',
      wood: '自然風格、辨識度高，適合紀念品與形象禮盒。'
    },
    thermos: {
      ss304: '主流不鏽鋼材質，耐用、適合日常保溫杯。',
      ss316: '耐蝕性更好、質感較高階，適合精緻禮贈。'
    },
    black_card: {
      ticket_easycard: '悠遊卡電子票證，可搭乘大眾運輸、消費儲值，卡面全黑客製。',
      ticket_ipass:    '一卡通電子票證，全台通用，卡面全黑客製。',
      ticket_icash:    'ICASH 2.0 電子票證，全黑質感客製設計。'
    }
  };
  return notes[productId]?.[materialId] || '適合一般客製需求，業務會依用途協助確認。';
}

function renderSpecStep() {
  const p = PRODUCTS[STATE.productId];
  if (!p) return;
  renderSelectedProductSummary('spec-product-summary');

  const matLabelEl = document.getElementById('spec-materials-label');
  const finLabelEl = document.getElementById('spec-finishes-label');
  if (matLabelEl) matLabelEl.textContent = p.materialLabel || '材質';
  if (finLabelEl) finLabelEl.textContent = p.finishLabel || '表面工藝';

  const matContainer = document.getElementById('spec-materials');
  matContainer.innerHTML = p.materials.map(m => `
    <label class="spec-option material-option ${m.id === STATE.materialId ? 'selected' : ''}">
      <input type="radio" name="material" value="${escapeHtml(m.id)}" ${m.id === STATE.materialId ? 'checked' : ''}>
      <span class="spec-label">${escapeHtml(m.name)}</span>
      ${p.priceOnInquiry ? '' : `<span class="spec-price">NT$${Number(m.priceBase) || 0}/個起</span>`}
      <span class="spec-desc">${escapeHtml(getMaterialDescription(STATE.productId, m.id))}</span>
    </label>
  `).join('');

  matContainer.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      STATE.materialId = input.value;
      matContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
      input.closest('label').classList.add('selected');
      updateLiveQuote();
    });
  });

  const finContainer = document.getElementById('spec-finishes');
  finContainer.innerHTML = p.finishes.map(f => `
    <label class="spec-option ${f.id === STATE.finishId ? 'selected' : ''}">
      <input type="radio" name="finish" value="${escapeHtml(f.id)}" ${f.id === STATE.finishId ? 'checked' : ''}>
      <span class="spec-label">${escapeHtml(f.name)}</span>
      ${p.priceOnInquiry ? '' : `<span class="spec-price">${f.price > 0 ? `+NT$${Number(f.price) || 0}` : '標準'}</span>`}
    </label>
  `).join('');

  finContainer.querySelectorAll('input').forEach(input => {
    input.addEventListener('change', () => {
      STATE.finishId = input.value;
      finContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
      input.closest('label').classList.add('selected');
      updateLiveQuote();
    });
  });

  const capSection = document.getElementById('spec-capacity-section');
  if (p.capacities) {
    capSection.classList.remove('hidden');
    const capContainer = document.getElementById('spec-capacities');
    capContainer.innerHTML = p.capacities.map(c => `
      <label class="spec-option ${c.id === STATE.capacityId ? 'selected' : ''}">
        <input type="radio" name="capacity" value="${escapeHtml(c.id)}" ${c.id === STATE.capacityId ? 'checked' : ''}>
        <span class="spec-label">${escapeHtml(c.name)}</span>
        <span class="spec-price">${c.price > 0 ? `+NT$${Number(c.price) || 0}` : '標準'}</span>
      </label>
    `).join('');

    capContainer.querySelectorAll('input').forEach(input => {
      input.addEventListener('change', () => {
        STATE.capacityId = input.value;
        capContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
        input.closest('label').classList.add('selected');
        updateLiveQuote();
      });
    });
  } else {
    capSection.classList.add('hidden');
  }

  // 杯身顏色（目前只有保溫杯有這個欄位；純外觀選項，不加價，沿用「有資料才顯示」的模式）
  const cupColorSection = document.getElementById('spec-cupcolor-section');
  if (cupColorSection) {
    if (p.cupColors && p.cupColors.length) {
      cupColorSection.classList.remove('hidden');
      if (!STATE.cupColorId || !p.cupColors.some(c => c.id === STATE.cupColorId)) {
        STATE.cupColorId = p.cupColors[0].id;
      }
      const cupColorContainer = document.getElementById('spec-cupcolors');
      cupColorContainer.innerHTML = p.cupColors.map(c => `
        <label class="spec-option ${c.id === STATE.cupColorId ? 'selected' : ''}">
          <input type="radio" name="cupcolor" value="${escapeHtml(c.id)}" ${c.id === STATE.cupColorId ? 'checked' : ''}>
          <span class="spec-label">
            <span style="display:inline-block;width:14px;height:14px;border-radius:50%;
              background:${escapeHtml(safeCssColor(c.hex, '#999999'))};border:1px solid rgba(0,0,0,.15);
              vertical-align:-2px;margin-right:6px;"></span>${escapeHtml(c.name)}
          </span>
        </label>
      `).join('');

      cupColorContainer.querySelectorAll('input').forEach(input => {
        input.addEventListener('change', () => {
          STATE.cupColorId = input.value;
          cupColorContainer.querySelectorAll('label').forEach(l => l.classList.remove('selected'));
          input.closest('label').classList.add('selected');
        });
      });
    } else {
      cupColorSection.classList.add('hidden');
    }
  }

  const qtyNumber = document.getElementById('spec-qty-input');
  qtyNumber.min = p.minQty;
  const initialQty = Math.max(STATE.qty || 1, p.minQty);
  qtyNumber.value = initialQty;
  STATE.qty = initialQty;

  qtyNumber.oninput = () => {
    let v = parseInt(qtyNumber.value, 10);
    if (!v || v < p.minQty) v = p.minQty;
    STATE.qty = v;
    updateLiveQuote();
  };

  // 各區塊（材質／工藝／容量／杯身顏色／數量）的 step-chip 編號原本是寫死在
  // HTML 裡的 1/2/3/4，但容量／杯身顏色只有部分商品才會顯示（見上面 capSection／
  // cupColorSection 的 hidden 切換）——沒有這兩個欄位的商品（悠遊卡/一卡通/黑卡）
  // 會變成 1、2、4，跳號缺 3。改成每次都依照「目前實際顯示的區塊順序」重新編號，
  // 不管哪些區塊被隱藏，永遠是連續的 1、2、3...。
  document.querySelectorAll('.spec-form-panel .spec-section:not(.hidden) .step-chip')
    .forEach((chip, index) => { chip.textContent = index + 1; });

  updateLiveQuote();
}
// 把 calcQuote() 回傳的 qtyBreakUsed（{min,max,price}）轉成一行人看得懂的文字，
// 三處顯示報價的地方（即時估價／規格摘要／Step5 報價單）共用同一份格式，
// 不會各寫一次、以後改一邊漏改另一邊。max 為 null 代表這段沒有上限（向上無限）。
function formatQtyBreakTier(qtyBreakUsed) {
  if (!qtyBreakUsed) return '--';
  const rangeText = qtyBreakUsed.max !== null
    ? `${qtyBreakUsed.min.toLocaleString()}～${qtyBreakUsed.max.toLocaleString()} 個`
    : `${qtyBreakUsed.min.toLocaleString()} 個以上`;
  const price = qtyBreakUsed.price;
  const priceText = price > 0 ? `加價 NT$${price.toLocaleString()}`
    : price < 0 ? `折扣 NT$${Math.abs(price).toLocaleString()}`
    : '不加價';
  return `${rangeText}，${priceText}`;
}

function updateLiveQuote() {
  const q = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);
  // 商品摘要面板跟即時估價共用同一份 STATE，規格一有變動就要一起重新渲染，
  // 避免畫面上出現「摘要」與「估價」兩份互相矛盾的規格資訊。
  renderSelectedProductSummary('spec-product-summary');
  // Step2（材質/工藝/容量/數量）的修改都會呼叫這個函式，一併排入自動保存，
  // 不用等使用者按下一步才存到（否則使用者在 Step2 調整完就直接關分頁，
  // 這些修改就遺失了）。
  if (typeof scheduleSaveDesign === 'function') scheduleSaveDesign();

  const el = document.getElementById('live-quote');
  if (!el) return;

  // 缺少或錯誤的價格資料（材質/工藝/容量不存在、數量低於最低訂購量、數量沒有符合的
  // 級距等）一律顯示清楚的錯誤文字，絕對不會出現 undefined／NaN，也不會偷套用 0 元。
  if (!q.ok) {
    el.innerHTML = `<div class="quote-error">⚠ ${escapeHtml(q.error)}</div>`;
    return;
  }

  if (q.priceOnInquiry) {
    el.innerHTML = `
      <div class="quote-row"><span>數量 × ${q.qty.toLocaleString()}</span></div>
      <div class="quote-row total"><span>預估總計</span><strong>價格由業務確認</strong></div>
      <div class="quote-note">新品項目，正式報價與交期由業務人員確認後回覆</div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="quote-row"><span>數量級距</span><strong>${escapeHtml(formatQtyBreakTier(q.qtyBreakUsed))}</strong></div>
    <div class="quote-row"><span>單價</span><strong>NT$ ${q.unitPrice.toLocaleString()}</strong></div>
    <div class="quote-row"><span>數量 × ${q.qty.toLocaleString()}</span><strong>NT$ ${q.subtotal.toLocaleString()}</strong></div>
    <div class="quote-row"><span>製版費</span><strong>NT$ ${q.setupFee.toLocaleString()}</strong></div>
    <div class="quote-row total"><span>預估總計</span><strong>NT$ ${q.total.toLocaleString()}</strong></div>
    <div class="quote-note">預計交期：下單後 ${q.leadDays ?? '--'} 個工作天</div>
  `;
}

function renderDesignSpecSummary() {
  const el = document.getElementById('design-spec-summary');
  const p = PRODUCTS[STATE.productId];
  if (!el || !p) return;

  const mat = p.materials.find(m => m.id === STATE.materialId) || p.materials[0];
  const fin = p.finishes.find(f => f.id === STATE.finishId) || p.finishes[0];
  const cap = p.capacities ? (p.capacities.find(c => c.id === STATE.capacityId) || p.capacities[0]) : null;
  const sizeText = p.displaySize || `${p.size.w} × ${p.size.h} ${p.size.unit}`;

  el.innerHTML = `
    <div class="design-spec-line"><span>產品</span><strong>${escapeHtml(p.name)}</strong></div>
    <div class="design-spec-line"><span>尺寸</span><strong>${escapeHtml(sizeText)}</strong></div>
    <div class="design-spec-line"><span>${escapeHtml(p.materialLabel || '材質')}</span><strong>${escapeHtml(mat.name)}</strong></div>
    <div class="design-spec-line"><span>${escapeHtml(p.finishLabel || '工藝')}</span><strong>${escapeHtml(fin.name)}</strong></div>
    ${cap ? `<div class="design-spec-line"><span>容量</span><strong>${escapeHtml(cap.name)}</strong></div>` : ''}
  `;

  // 觸發按鈕上的一行摘要：規格收合進彈出視窗後，按鈕本身還是要能讓人一眼
  // 看到目前選的是什麼，不用點開才知道，維持原本常駐版面時的資訊量。
  const brief = document.getElementById('design-summary-trigger-brief');
  if (brief) {
    const briefParts = [p.name, sizeText, mat.name, fin.name];
    if (cap) briefParts.push(cap.name);
    brief.textContent = briefParts.join(' · ');
  }
}

function renderSelectedProductSummary(targetId) {
  const el = document.getElementById(targetId);
  const p = PRODUCTS[STATE.productId];
  if (!el || !p) return;

  const mat = p.materials.find(m => m.id === STATE.materialId) || p.materials[0];
  const fin = p.finishes.find(f => f.id === STATE.finishId) || p.finishes[0];
  const cap = p.capacities ? (p.capacities.find(c => c.id === STATE.capacityId) || p.capacities[0]) : null;
  const sizeText = p.displaySize || `${p.size.w} × ${p.size.h} ${p.size.unit}`;
  // 這裡不能用 p.image（行銷示意照，畫面上是別人已經印好的固定設計，例如
  // 悠遊卡示意照其實是狼頭卡面），之前用大方塊縮圖呈現時，連續被誤判成
  // 「商品預覽」。真正的設計內容只由 2D 設計稿／3D 預覽／商品照預覽這幾個
  // 地方呈現，這裡只放文字化的商品類別標示（badge），不用 emoji 圖示。
  el.innerHTML = `
    <div class="selected-product-header">
      <div class="product-badge" style="background:${escapeHtml(safeCssColor(p.badgeColor, '#999999'))}">${escapeHtml(p.badge || '')}</div>
    </div>
    <h3>${escapeHtml(p.name)}</h3>
    <p>${escapeHtml(p.description || '')}</p>
    <div class="selected-product-meta">
      <div><span>尺寸</span><strong>${escapeHtml(sizeText)}</strong></div>
      <div><span>${escapeHtml(p.materialLabel || '材質')}</span><strong>${escapeHtml(mat.name)}</strong></div>
      <div><span>${escapeHtml(p.finishLabel || '工藝')}</span><strong>${escapeHtml(fin.name)}</strong></div>
      ${cap ? `<div><span>容量</span><strong>${escapeHtml(cap.name)}</strong></div>` : ''}
      <div><span>數量</span><strong>${STATE.qty.toLocaleString()} 個</strong></div>
    </div>
  `;
}

// ─── Step 3：設計 ──────────────────────────────────────────
function initDesignStep() {
  const isThermos   = STATE.productId === 'thermos';
  const isBlackCard = STATE.productId === 'black_card';
  const isEasyCard  = STATE.productId === 'easycard';
  const isCardShell = isEasyCard || STATE.productId === 'ipass'; // 悠遊卡／一卡通共用同一套卡片質感展示台/安全範圍說明

  // 手機版四區塊分頁：每次重新進入設計稿頁（含從其他步驟返回、切換商品）都
  // 預設展開「設計預覽」，符合需求「預設展開設計預覽」；桌面版此呼叫無視覺
  // 效果（.wb-mobile-tabs 本身就是 display:none）。
  if (typeof setMobileDesignGroup === 'function') setMobileDesignGroup('preview');

  // 商品底圖（保溫杯瓶身／USB外殼）是非同步載入，一定要等 init2DCanvas 回報「底圖真的
  // 已經放上畫布」才能決定接下來動作，否則「加入空白模板預設元素」跟「還原已保存的草稿
  // 內容」兩件事會跟底圖載入互相搶跑，內容有時候會被之後才跑完的預設模板蓋掉——這正是
  // 保溫杯過去被排除在還原流程之外的根本原因（黑卡／悠遊卡／一卡通因為不讀外部圖檔、
  // 走內建模板，onReady 一定同步觸發，所以看起來「原本就正常」）。
  // 所有商品統一走同一套判斷：有保存的 canvasJSON 就還原，沒有才補預設元素，不再有
  // 任何商品被特別排除。
  init2DCanvas(STATE.productId, () => {
    if (STATE.canvasJSON && typeof loadCanvas2DJSON === 'function') {
      loadCanvas2DJSON(STATE.canvasJSON);
    } else if (typeof addDefaultElements === 'function') {
      addDefaultElements();
    }
  });
  renderDesignSpecSummary();

  document.querySelector('.canvas-wrap')?.classList.toggle('black-card-mode', isBlackCard);
  document.querySelector('.canvas-wrap')?.classList.toggle('card-shell-mode', isCardShell);

  // 文字輸入：clone一次拔掉舊監聽（跟下面design-upload的做法一樣），避免每次進Step3
  // 重複綁定；重新取得節點後才寫入value，確保cloneNode不會漏帶目前的文字內容。
  // 初始值必須優先讀畫布上title/subtitle物件目前的文字，不能只讀STATE.textLine1/2——
  // 悠遊卡/一卡通/保溫杯的示範版面（addYangZhuCardTemplate()/addThermosDemoLayers()）
  // 是直接把示範文字寫進畫布物件，從來不會同步回STATE.textLine1/2，全新草稿這兩個欄位
  // 通常還是空字串。如果輸入框初始值只看STATE，會跟畫布顯示的示範文字對不上，之後只要
  // 使用者碰一次輸入框觸發同步，就會把「輸入框裡其實是空字串」的另一欄誤判成使用者要
  // 清空，把畫布上另一個demo文字物件整個刪掉。
  let t1 = document.getElementById('design-text1');
  let t2 = document.getElementById('design-text2');
  // 悠遊卡/一卡通示範版面的主標題是兩個同名'title'物件拼成的大小字兩行，這裡跟
  // isDesignStillDemoPlaceholder()同一套邏輯：同名物件文字要join('')起來才是完整內容。
  const _canvasTitles    = canvas2d ? canvas2d.getObjects().filter(o => o.name === 'title') : [];
  const _canvasSubtitles = canvas2d ? canvas2d.getObjects().filter(o => o.name === 'subtitle') : [];
  if (t1) { t1.replaceWith(t1.cloneNode(true)); t1 = document.getElementById('design-text1'); t1.value = _canvasTitles.length ? _canvasTitles.map(o => o.text || '').join('') : STATE.textLine1; }
  if (t2) { t2.replaceWith(t2.cloneNode(true)); t2 = document.getElementById('design-text2'); t2.value = _canvasSubtitles.length ? _canvasSubtitles.map(o => o.text || '').join('') : STATE.textLine2; }
  [t1, t2].forEach(el => {
    if (!el) return;
    el.addEventListener('input', scheduleDesignTextSync);
    el.addEventListener('change', flushDesignTextSync);
    el.addEventListener('blur', flushDesignTextSync);
  });
  if (typeof _updateTextDesignTriggerBrief === 'function') _updateTextDesignTriggerBrief();

  // 字體格子初始化
  initFontGrid();
  initMaskShapePicker();

  // Q版風格卡片初始化
  if (typeof initCartoonStylePicker === 'function') initCartoonStylePicker();

  // 黑卡：AI 文字產生圖案面板初始化（還原客戶先前輸入的文字/風格/候選圖，返回設計頁不遺失）
  if (isBlackCard && typeof initBlackCardPatternPanel === 'function') initBlackCardPatternPanel();

  // 圖片上傳：保溫杯是雷雕上去的，不支援上傳圖片/Logo，這裡先隱藏，不刪除——
  // 悠遊卡/一卡通原本就改用右側面板的「一般照片」分頁，黑卡改用右側專屬面板，
  // 現在保溫杯也隱藏後，這個左欄通用上傳區暫時沒有任何商品在用，先保留程式碼
  // 以備之後恢復（例如未來又想開放某商品用左欄上傳）。
  const uploadSection = document.getElementById('design-upload')?.closest('.tool-section, .tool-block');
  if (uploadSection) uploadSection.style.display = 'none';

  _placeLayerManagementBlock(isThermos, isBlackCard);

  // 圖形素材庫（貼紙）：保溫杯是雷雕上去的，不支援貼裝飾圖案，比照上傳圖片/主標題
  // 副標題的做法先隱藏不刪除；黑卡改用右側專屬面板本來就不需要這個。
  const stickerBlock = document.getElementById('sticker-picker-block');
  if (stickerBlock) stickerBlock.style.display = (isBlackCard || isThermos) ? 'none' : '';
  if (typeof initStickerPicker === 'function') initStickerPicker();

  // 保溫杯專屬：滿版鋪滿按鈕，只在保溫杯顯示
  const thermosFullBleedBtn = document.getElementById('thermos-fullbleed-btn');
  if (thermosFullBleedBtn) thermosFullBleedBtn.classList.toggle('hidden', !isThermos);
  if (typeof _updateThermosFullBleedBtnState === 'function') _updateThermosFullBleedBtnState();

  // 保溫杯專屬：藝術簽名觸發卡片，只在保溫杯顯示；字體選單需要重新渲染（跟字體
  // 選單本身一樣，每次進Step3都要重畫一次，避免切商品後選單內容跟STATE.thermosSignatureFont
  // 對不上）。文字/顏色/大小/旋轉的初始值優先讀畫布上已還原的物件，草稿還原、
  // 返回設計頁兩種情境都要正確顯示目前簽名內容，不能只看STATE有沒有存文字。
  const thermosSignatureTriggerBlock = document.getElementById('thermos-signature-trigger-block');
  if (thermosSignatureTriggerBlock) thermosSignatureTriggerBlock.classList.toggle('hidden', !isThermos);
  if (isThermos) {
    if (typeof renderThermosSignatureFontPicker === 'function') renderThermosSignatureFontPicker();
    const sigInput = document.getElementById('thermos-signature-input');
    const sigColor = document.getElementById('thermos-signature-color');
    const sigControls = document.getElementById('thermos-signature-controls');
    const sigRemoveBtn = document.getElementById('thermos-signature-remove-btn');
    const existingSig = canvas2d?.getObjects().find(o => o.name === 'thermos-signature');
    if (sigInput) sigInput.value = existingSig ? (existingSig.text || '') : '';
    if (existingSig) {
      if (sigColor) sigColor.value = _toHexColor(existingSig.fill) || '#333333';
      sigControls?.classList.remove('hidden');
      sigRemoveBtn?.classList.remove('hidden');
      const sizeSlider = document.getElementById('thermos-signature-size');
      const rotSlider = document.getElementById('thermos-signature-rotation');
      if (sizeSlider) sizeSlider.value = existingSig._signatureSizePct || 60;
      if (rotSlider) rotSlider.value = Math.round(existingSig.angle || 0);
    } else {
      sigControls?.classList.add('hidden');
      sigRemoveBtn?.classList.add('hidden');
    }
    if (typeof _updateThermosSignatureTriggerBrief === 'function') _updateThermosSignatureTriggerBrief();
  }

  // 黑卡專屬：藝術簽名觸發卡片，只在黑卡顯示；欄位內容同步交給上面已經呼叫過的
  // initBlackCardPatternPanel()（該函式改過，會一併更新這張觸發卡片的摘要文字）。
  const blackCardSignatureTriggerBlock = document.getElementById('black-card-signature-trigger-block');
  if (blackCardSignatureTriggerBlock) blackCardSignatureTriggerBlock.classList.toggle('hidden', !isBlackCard);

  const fileInput = document.getElementById('design-upload');
  if (fileInput) {
    fileInput.replaceWith(fileInput.cloneNode(true));
    const newFile = document.getElementById('design-upload');
    newFile.addEventListener('change', e => {
      if (e.target.files[0]) uploadImage2D(e.target.files[0]);
    });
  }

  // 右側面板「一般照片」分頁的上傳輸入框，跟左欄 design-upload 共用同一個
  // uploadImage2D()，兩個入口只是給不同產品線用，處理邏輯完全一致。
  const fileInputTab = document.getElementById('design-upload-tab');
  if (fileInputTab) {
    fileInputTab.replaceWith(fileInputTab.cloneNode(true));
    const newFileTab = document.getElementById('design-upload-tab');
    newFileTab.addEventListener('change', e => {
      if (e.target.files[0]) uploadImage2D(e.target.files[0]);
    });
  }

  // 背景色
  const bgPicker = document.getElementById('design-bgcolor');
  if (bgPicker) {
    bgPicker.value = STATE.bgColor;
    bgPicker.addEventListener('input', e => {
      STATE.bgColor = e.target.value;
      setBackground2D(e.target.value);
    });
  }

  const waveMain = document.getElementById('wave-color-main');
  const waveLight = document.getElementById('wave-color-light');
  if (waveMain) waveMain.value = STATE.waveColor || '#2D7D46';
  if (waveLight) waveLight.value = STATE.waveLightColor || '#dfead8';

  // 只補色，不動造型：進入設計頁時把畫布上既有的 template-wave/wave-light/bg/dot
  // 重新上一次 STATE 目前的顏色，確保跟波浪顏色色票一致；造型本身由 canvasJSON
  // 草稿快照還原（見 loadCanvas2DJSON()），這裡不重建路徑幾何。
  if (typeof applyCardBackgroundTemplate2D === 'function') {
    applyCardBackgroundTemplate2D({
      bg: STATE.bgColor || '#ffffff',
      wave: STATE.waveColor || '#2D7D46',
      waveLight: STATE.waveLightColor || '#dfead8',
      dot: STATE.waveLightColor || '#dfead8',
      dotAlt: STATE.waveColor || '#2D7D46'
    });
  }

  // 保溫杯：隱藏不適用的 AI 功能
  ['ai-cartoon-section'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = isThermos ? 'none' : '';
  });

  // AI 生成背景：只在悠遊卡／一卡通顯示（isCardShell），保溫杯目前生成尺寸／提示詞
  // 是卡片比例不適用，黑卡繼續用原本獨立的「主圖案」功能；分頁按鈕隱藏之外，
  // 也要確保不是這兩個商品時，分頁不會停留在「AI生成背景」（例如從悠遊卡切到保溫杯，
  // 保溫杯根本沒有這個分頁面板，若還留在active狀態，之後切回悠遊卡會顯示錯誤分頁）。
  const aiBgTabBtn = document.getElementById('wb-tab-btn-aibg');
  if (aiBgTabBtn) aiBgTabBtn.classList.toggle('hidden', !isCardShell);
  if (!isCardShell && typeof switchUploadTab === 'function') switchUploadTab('photo');
  if (isCardShell && typeof initAiBackgroundPanel === 'function') initAiBackgroundPanel();

  const qAvatarPanel = document.getElementById('q-avatar-panel');
  const blackCardPatternPanel = document.getElementById('black-card-pattern-panel');
  const workbench = document.querySelector('.customizer-workbench');
  if (qAvatarPanel) qAvatarPanel.style.display = (isThermos || isBlackCard) ? 'none' : '';
  // 用 .hidden class（而非 inline style）切換：CSS 裡 .hidden 是 !important，
  // 直接改 style.display 蓋不掉，必須透過 classList 才切得動。
  if (blackCardPatternPanel) blackCardPatternPanel.classList.toggle('hidden', !isBlackCard);
  if (workbench) workbench.classList.toggle('thermos-workbench', isThermos);

  // 保溫杯／黑卡：隱藏背景色選擇（瓶身有固定圖案／黑卡不提供彩色背景）
  const bgColorEl = document.getElementById('design-bgcolor');
  if (bgColorEl) {
    const bgSection = bgColorEl.closest('.color-row')?.parentElement;
    if (bgSection) bgSection.style.display = (isThermos || isBlackCard) ? 'none' : '';
  }

  // 黑卡：隱藏文字顏色選色器（文字固定為黑色調效果）
  const textColorEl = document.getElementById('design-textcolor');
  if (textColorEl) {
    const textColorRow = textColorEl.closest('.color-row');
    if (textColorRow) textColorRow.style.display = isBlackCard ? 'none' : '';
  }

  const bgTemplateBlock = document.querySelector('.background-template-block');
  if (bgTemplateBlock) bgTemplateBlock.style.display = (isThermos || isBlackCard) ? 'none' : '';
  _syncWaveColorPanelVisibility();
  // 保溫杯／黑卡：造型跟波浪顏色兩塊都藏起來之後，.text-design-tool 這個外層
  // 容器裡就只剩一顆看不到的隱藏色票 input，整塊（含「背景造型與波浪顏色」標題）
  // 一起藏起來，不留一個標題底下空空的區塊。
  const textDesignTool = document.querySelector('.text-design-tool');
  if (textDesignTool) textDesignTool.style.display = (isThermos || isBlackCard) ? 'none' : '';

  // 保溫杯／黑卡：更新 canvas 下方說明文字
  const canvasNote = document.querySelector('.canvas-wrap + p');
  if (canvasNote) {
    canvasNote.textContent = isThermos
      ? '虛線框為印刷範圍 · 文字套用後即出現在瓶身圖上'
      : isBlackCard
        ? '卡面初始為純霧黑底，上傳圖案或套用壓印文字後即呈現黑色調光澤／霧面／浮雕效果'
        : isCardShell
          ? '避免文字或圖片太靠近卡片邊緣或圓角'
          : '虛線為刀模輪廓參考線';
  }

  // 「清空目前卡面」按鈕與確認視窗：只有保溫杯不是卡片，文案要避開「卡面」字眼
  // （改講「設計」），其餘商品（含USB）維持原文案不變，逐字對照原本的靜態HTML，
  // 不改變任何非保溫杯商品實際看到的文字。
  const clearCanvasBtnLabel = document.getElementById('clear-canvas-btn-label');
  if (clearCanvasBtnLabel) clearCanvasBtnLabel.textContent = isThermos ? '清空目前設計' : '清空目前卡面';
  const clearCanvasModalTitle = document.getElementById('clear-canvas-modal-title');
  if (clearCanvasModalTitle) clearCanvasModalTitle.textContent = isThermos ? '清空目前設計' : '清空目前卡面';
  const clearCanvasModalDesc = document.getElementById('clear-canvas-modal-desc');
  if (clearCanvasModalDesc) {
    clearCanvasModalDesc.textContent = isThermos
      ? '確定要清空目前設計內容嗎？畫布上的文字、圖片與圖層都會被移除並改回空白模板，且會覆蓋掉自動保存的草稿，此動作無法復原。'
      : '確定要清空目前卡面的設計內容嗎？畫布上的文字、圖片與圖層都會被移除並改回空白模板，且會覆蓋掉自動保存的草稿，此動作無法復原。';
  }

  // 黑卡：頁面文案與左側面板文字改用黑卡專屬語氣
  const stepDesc = document.getElementById('design-step-desc');
  if (stepDesc) {
    stepDesc.textContent = isBlackCard
      ? '上傳圖案，製作專屬霧面黑卡，業務確認後安排打樣。'
      : isThermos
        ? '先輸入文字或上傳圖片，點選圖層可調整位置與大小，完成後預覽成品。'
        : '先輸入文字或上傳照片，點選圖層可調整位置與大小，完成後預覽成品。';
  }
  const textPanelHeadingText = isBlackCard ? '黑卡文字 / 壓印內容' : '文字與版面';
  const textPanelHeading = document.getElementById('text-panel-heading');
  if (textPanelHeading) textPanelHeading.textContent = textPanelHeadingText;
  // 觸發按鈕上的標題要跟彈出視窗裡的標題同步換文案，不然黑卡會出現按鈕還在講
  // 「文字與版面」、點開視窗才變成「黑卡文字/壓印內容」的文案不一致情況。
  const textPanelHeadingTrigger = document.getElementById('text-panel-heading-trigger');
  if (textPanelHeadingTrigger) textPanelHeadingTrigger.textContent = textPanelHeadingText;
  const label1Main = document.getElementById('label-text1-main');
  if (label1Main) label1Main.textContent = isBlackCard ? '主要壓印文字' : '主標題';
  const label2Main = document.getElementById('label-text2-main');
  if (label2Main) label2Main.textContent = isBlackCard ? '輔助壓印文字' : '副標題';
  const applyBtnLabel = document.getElementById('apply-text-btn-label');
  if (applyBtnLabel) applyBtnLabel.textContent = isBlackCard ? '套用黑卡壓印文字' : '套用至卡面';

  // 黑卡／保溫杯：文字功能統一改用「藝術簽名」處理，不再另外提供這組「主標題/
  // 副標題」輸入區塊（避免同時存在兩套文字機制讓客人搞混；保溫杯這裡先隱藏
  // 不刪除，之後想恢復只要把 isThermos 從條件式拿掉）。只藏觸發卡片，不動裡面的
  // modal/函式本身——悠遊卡/一卡通目前還在用同一套彈窗，不能整組砍掉。
  const textDesignTriggerBlock = document.getElementById('text-design-trigger-btn')?.closest('.tool-section');
  if (textDesignTriggerBlock) textDesignTriggerBlock.style.display = (isBlackCard || isThermos) ? 'none' : '';

  // 移除舊的參考圖 block（現在瓶身在 canvas 裡）
  const oldRef = document.getElementById('thermos-ref-block');
  if (oldRef) oldRef.remove();
}

function initFontGrid() {
  const grid = document.getElementById('font-grid');
  if (!grid || typeof FONTS === 'undefined') return;

  const currentFont = STATE.font || FONTS[0].id;

  grid.innerHTML = FONTS.map(f => `
    <div class="font-chip ${f.id === currentFont ? 'selected' : ''}"
         data-font="${f.id}"
         onclick="selectFont('${f.id}')">
      <span class="font-name">${f.label}</span>
      <span class="font-sample" style="font-family:'${f.id}',sans-serif">楊竹Aa</span>
    </div>
  `).join('');

  // 同步按鈕顯示文字
  const f = FONTS.find(f => f.id === currentFont);
  if (f) {
    const lbl = document.getElementById('font-select-label');
    if (lbl) lbl.textContent = f.label;
  }
  // 確保格子預設關閉
  grid.classList.add('font-grid-hidden');
}

// 波浪顏色面板可見性同步（唯一入口，不分散寫多套顯示判斷）：保溫杯／黑卡本來就完全
// 不提供背景造型（沿用上面 bgTemplateBlock 的既有判斷，跟這裡的商品類型檢查一致）；
// 悠遊卡／一卡通則另外依「目前造型是否為空白背板」決定——空白背板底下沒有波浪可
// 調色，繼續顯示一組波浪色票只會讓客戶誤以為畫面壞掉。呼叫時機：設計頁初始化
// （initDesignStep()）、草稿恢復完成（會經過 initDesignStep()）、selectMaskShape()
// 切換造型、切換商品後重新進入設計稿（同樣會經過 initDesignStep()），四個時機都呼叫
// 這一個函式，不各自維護一份判斷邏輯。
function _syncWaveColorPanelVisibility() {
  const waveColorPanel = document.getElementById('wave-color-panel');
  if (!waveColorPanel) return;
  const isThermos = STATE.productId === 'thermos';
  const isBlackCard = STATE.productId === 'black_card';
  const isBlank = STATE.backgroundTemplateId === 'blank';
  waveColorPanel.style.display = (isThermos || isBlackCard || isBlank) ? 'none' : '';
}

// 造型選單：顏色徹底跟造型脫鉤（見 CARD_MASK_SHAPES 開頭註解），這裡每一款的
// 預覽縮圖直接畫成小 SVG、套用「目前」的波浪主色/淺色，讓縮圖看起來跟畫布上
// 實際的顏色一致，不是每款都給一組固定假色。
function initMaskShapePicker() {
  const grid = document.getElementById('background-template-grid');
  if (!grid || typeof CARD_MASK_SHAPES === 'undefined') return;

  const current = STATE.backgroundTemplateId || CARD_MASK_SHAPES[0].id;
  const previewMain = STATE.waveColor || '#2D7D46';
  const previewLight = STATE.waveLightColor || '#dfead8';
  grid.innerHTML = CARD_MASK_SHAPES.map(s => {
    const p = s.build(64, 40);
    return `
    <button type="button"
            class="background-template-card ${s.id === current ? 'selected' : ''}"
            data-template="${s.id}"
            onclick="selectMaskShape('${s.id}')">
      <span class="bg-template-preview">
        <svg viewBox="0 0 64 40" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;">
          <path d="${p.light}" fill="${previewLight}" opacity="0.9"></path>
          <path d="${p.main}" fill="${previewMain}"></path>
        </svg>
      </span>
      <span class="bg-template-name">${s.name}</span>
      <small>${s.desc}</small>
    </button>
  `;
  }).join('');

  _updateMaskShapeSelectBtn(CARD_MASK_SHAPES.find(s => s.id === current) || CARD_MASK_SHAPES[0]);
}

// 收合狀態按鈕上的造型縮圖＋名稱，同樣用目前的波浪顏色畫小 SVG。
function _updateMaskShapeSelectBtn(shape) {
  if (!shape) return;
  const swatch = document.getElementById('bg-template-select-swatch');
  const label = document.getElementById('bg-template-select-label');
  if (swatch) {
    const p = shape.build(28, 28);
    const previewMain = STATE.waveColor || '#2D7D46';
    const previewLight = STATE.waveLightColor || '#dfead8';
    swatch.style.background = '#fff';
    swatch.innerHTML = `<svg viewBox="0 0 28 28" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;"><path d="${p.light}" fill="${previewLight}" opacity="0.9"></path><path d="${p.main}" fill="${previewMain}"></path></svg>`;
  }
  if (label) label.textContent = shape.name;
}

function toggleBackgroundTemplatePicker() {
  const grid = document.getElementById('background-template-grid');
  const btn = document.getElementById('bg-template-select-btn');
  if (!grid) return;
  const open = !grid.classList.contains('bg-template-grid-hidden');
  grid.classList.toggle('bg-template-grid-hidden', open);
  if (btn) btn.classList.toggle('open', !open);
}

// 只換造型（形狀），完全不碰顏色——不再像舊版模板一樣連帶覆寫
// design-bgcolor／wave-color-main／wave-color-light，使用者已經調好的顏色維持不變。
function selectMaskShape(shapeId) {
  if (typeof CARD_MASK_SHAPES === 'undefined') return;
  const shape = CARD_MASK_SHAPES.find(s => s.id === shapeId) || CARD_MASK_SHAPES[0];
  STATE.backgroundTemplateId = shape.id;
  _syncWaveColorPanelVisibility();

  document.querySelectorAll('.background-template-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.template === shape.id);
  });
  _updateMaskShapeSelectBtn(shape);

  // 選好之後收合下拉，跟字體選擇器同一套互動邏輯
  const grid = document.getElementById('background-template-grid');
  if (grid) grid.classList.add('bg-template-grid-hidden');
  const btn = document.getElementById('bg-template-select-btn');
  if (btn) btn.classList.remove('open');

  if (typeof applyMaskShape2D === 'function') applyMaskShape2D(shape.id);
}

function updateWaveColor(kind, color) {
  if (kind === 'light') STATE.waveLightColor = color;
  else STATE.waveColor = color;

  if (typeof setTemplateWaveColor2D === 'function') {
    setTemplateWaveColor2D(kind, color);
  }
}

function toggleStickerPicker() {
  const grid = document.getElementById('sticker-picker');
  const btn  = document.getElementById('sticker-select-btn');
  if (!grid) return;
  const open = !grid.classList.contains('sticker-grid-hidden');
  grid.classList.toggle('sticker-grid-hidden', open);
  if (btn) btn.classList.toggle('open', !open);
}

// 填滿色／外框線色調整：只對「目前選取中的裝飾圖形」生效，不是全域設定，所以每次都要
// 重新讀 canvas2d.getActiveObject()，不快取物件參照（避免圖層被刪除/換選取後還誤改到舊物件）。
function updateStickerColor(kind, color) {
  const active = canvas2d ? canvas2d.getActiveObject() : null;
  if (!active || active.name !== 'sticker') return;
  if (kind === 'stroke') active.set('stroke', color);
  else active.set('fill', color);
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

function toggleStickerStroke(enabled) {
  const active = canvas2d ? canvas2d.getActiveObject() : null;
  if (!active || active.name !== 'sticker') return;
  active.set('strokeWidth', enabled ? 2 : 0);
  if (enabled && !active.stroke) {
    const strokeInput = document.getElementById('sticker-stroke-color');
    active.set('stroke', (strokeInput && strokeInput.value) || '#333333');
  }
  canvas2d.requestRenderAll();
  if (typeof syncDesignState === 'function') syncDesignState();
}

function toggleFontPicker() {
  const grid = document.getElementById('font-grid');
  const btn  = document.getElementById('font-select-btn');
  if (!grid) return;
  const open = !grid.classList.contains('font-grid-hidden');
  grid.classList.toggle('font-grid-hidden', open);
  btn.classList.toggle('open', !open);
}

function selectFont(fontId) {
  STATE.font = fontId;
  document.getElementById('design-font').value = fontId;
  document.querySelectorAll('.font-chip').forEach(el => {
    el.classList.toggle('selected', el.dataset.font === fontId);
  });
  // 更新按鈕標籤
  if (typeof FONTS !== 'undefined') {
    const f = FONTS.find(f => f.id === fontId);
    if (f) {
      const lbl = document.getElementById('font-select-label');
      if (lbl) lbl.textContent = f.label;
    }
  }
  // 關閉選擇格
  const grid = document.getElementById('font-grid');
  if (grid) grid.classList.add('font-grid-hidden');
  const btn = document.getElementById('font-select-btn');
  if (btn) btn.classList.remove('open');
}

// 追根究柢：canProceedToPreview()／updateStep3NextButtonState() 讀的是「畫布上title/
// subtitle物件的文字」，不是輸入框的value。過去只有點擊「套用至卡面」（applyDesignText()）
// 才會把輸入框內容寫進畫布，物件異動再靠object:added/removed事件觸發按鈕重新判斷——
// 所以純打字、不點套用時，畫布內容根本沒變，按鈕自然讀不到新值，一直卡在修改前的
// disabled狀態。這裡讓輸入框直接（非破壞性、用.set('text',...)保留縮放/位置，不像
// applyDesignText()整層remove再重建）即時同步進畫布物件，再呼叫唯一的
// updateStep3NextButtonState() 重新判斷，不另外維護第二套條件。
let _designTextSyncTimer = null;
function _syncDesignTextRoleToCanvas(role, text) {
  if (!canvas2d) return;
  // 悠遊卡／一卡通示範版面的主標題其實是兩個同名'title'物件組成的大小字兩行
  // （addYangZhuCardTemplate()：「專屬於你的」+「美好日常」），輸入框只有一欄，
  // 只留第一個物件承載完整新文字，其餘同名物件視為已被取代一併移除——跟
  // applyDesignText()「整層移除再以單一物件重建」的最終結果一致，避免殘留的
  // 第二行示範文字讓後續文字比對／字數判斷讀到舊值。
  const matches = canvas2d.getObjects().filter(o => o.name === role);
  if (text) {
    if (matches.length) {
      matches[0].set('text', text);
      for (let i = 1; i < matches.length; i++) canvas2d.remove(matches[i]);
    } else if (typeof _doAddText2D === 'function') {
      const color = STATE.productId === 'black_card' ? '#141414' : (document.getElementById('design-textcolor')?.value || '#333333');
      const font  = STATE.font || document.getElementById('design-font')?.value || 'Noto Sans TC';
      _doAddText2D(text, color, null, font, role);
    }
  } else {
    matches.forEach(o => canvas2d.remove(o));
  }
}
function syncDesignTextInputsToCanvas() {
  if (!canvas2d) return;
  const t1 = document.getElementById('design-text1');
  const t2 = document.getElementById('design-text2');
  if (t1) { _syncDesignTextRoleToCanvas('title', t1.value.trim()); STATE.textLine1 = t1.value.trim(); }
  if (t2) { _syncDesignTextRoleToCanvas('subtitle', t2.value.trim()); STATE.textLine2 = t2.value.trim(); }
  canvas2d.requestRenderAll();
  // 文字同步進畫布是這個函式裡最後才完成的動作，資格判斷必須排在它「之後」執行，
  // 才不會讀到畫布還沒更新前的舊物件文字。
  if (typeof updateStep3NextButtonState === 'function') updateStep3NextButtonState();
  if (typeof syncDesignState === 'function') syncDesignState();
}
function scheduleDesignTextSync() {
  clearTimeout(_designTextSyncTimer);
  _designTextSyncTimer = setTimeout(syncDesignTextInputsToCanvas, 200);
}
function flushDesignTextSync() {
  clearTimeout(_designTextSyncTimer);
  syncDesignTextInputsToCanvas();
}

function applyDesignText() {
  const t1    = document.getElementById('design-text1').value.trim();
  const t2    = document.getElementById('design-text2').value.trim();
  // 黑卡：文字固定黑色調，不讀取（已隱藏的）文字顏色選色器
  const color = STATE.productId === 'black_card' ? '#141414' : document.getElementById('design-textcolor').value;
  const font  = STATE.font || document.getElementById('design-font').value || 'Noto Sans TC';

  STATE.textLine1 = t1;
  STATE.textLine2 = t2;
  STATE.font = font;

  // 只移除文字層（hint / title / subtitle），保留圖片等使用者上傳物件
  if (canvas2d) {
    canvas2d.getObjects()
      .filter(o => ['hint', 'title', 'subtitle'].includes(o.name))
      .forEach(o => canvas2d.remove(o));
    canvas2d.renderAll();
  }

  setBackground2D(STATE.bgColor);
  if (t1) addText2D(t1, color, null, font, 'title');
  if (t2) addText2D(t2, color, null, font, 'subtitle');

  // 「套用至卡面」當下就把目前畫布輸出成 canvasDataUrl 並寫回 designState，
  // 不用等到離開設計頁才產生快照——按下按鈕當下就該是最新結果的來源。
  if (canvas2d) {
    canvas2d.requestRenderAll();
    STATE.designDataURL = (typeof get2DDataURL === 'function') ? get2DDataURL() : STATE.designDataURL;
    STATE.canvasJSON = (typeof getCanvas2DJSON === 'function') ? getCanvas2DJSON() : STATE.canvasJSON;
  }
  if (typeof syncDesignState === 'function') syncDesignState();
}

// 背景預設色套用
function applyBgPreset(color) {
  STATE.bgColor = color;
  const picker = document.getElementById('design-bgcolor');
  if (picker) picker.value = color;
  setBackground2D(color);
}

// ─── Step 4：預覽 ──────────────────────────────────────────
function initPreviewStep() {
  const dataURL  = STATE.designDataURL;
  const finishId = STATE.finishId;
  // preview_complete 只能在「實際渲染真的完成」那一刻記錄，不能在剛進 Step4 就假設成功
  // （黑卡走renderBlackCardPhotoPreview()、一般商品走buildCard()/buildUSB()/buildThermos()，
  // 這幾支都是非同步——內部用<img>.onload載入設計圖貼圖才算真的畫完）。這裡先把「這次
  // initPreviewStep()是為哪個商品執行」的productId鎖起來，用callback在真正完成時才記錄，
  // 不用固定延遲時間猜測；就算使用者在渲染完成前就切換商品，鎖住的還是當初那個productId，
  // 不會誤植到後來切換過去的商品上。
  const _previewProductId = STATE.productId;
  // 消耗並立刻清除 pending 狀態：不管這次渲染最後有沒有真的建立有效 callback，
  // 都不能把這個值留給下一次（可能是草稿恢復、返回修改後的非正式重繪）誤用。
  const _isTrackedTransition = _pendingPreviewTrackProductId === _previewProductId;
  _pendingPreviewTrackProductId = null;
  const _onPreviewRenderComplete = _isTrackedTransition
    ? () => { if (typeof _trackPreviewComplete === 'function') _trackPreviewComplete(_previewProductId); }
    : () => {}; // 草稿恢復／直接renderStep()／非合法前進的重繪：渲染邏輯不變，但不記錄事件
  renderSelectedProductSummary('preview-product-summary');

  const caption = document.getElementById('preview-stage-caption');
  const reapplyBtn = document.getElementById('preview-reapply-btn');
  const backNote = document.getElementById('preview-easycard-back-note');
  if (backNote) backNote.classList.toggle('hidden', !['easycard', 'ipass', 'thermos'].includes(STATE.productId));
  const angleTools = document.getElementById('preview-angle-tools');
  if (angleTools) angleTools.classList.toggle('hidden', STATE.productId !== 'black_card');

  // 一般卡片/USB/保溫杯商品都走 Three.js 3D 預覽，只有黑卡走攝影棚 CSS 合成（不建模）
  const isStandard3D = STATE.productId !== 'black_card';
  const isThermosPreview = STATE.productId === 'thermos';
  const angleTools3D = document.getElementById('preview-angle-tools-3d');
  if (angleTools3D) {
    angleTools3D.classList.toggle('hidden', !isStandard3D);
    if (isStandard3D) {
      // 保溫杯是圓柱形狀，需要「正面/左側/右側/近拍」4顆按鈕；其餘商品維持原本
      // 「正視/側視/近拍」3顆。每次進 Step4 都重寫整段 innerHTML，不會累積殘留按鈕。
      // 使用者若曾主動點過角度按鈕（STATE.previewAngle 有值），畫面重新整理／返回修改／
      // 切換商品再返回都要維持在同一個角度，按鈕的 active 樣式先依這個值決定；還沒選過
      // 角度的全新設計則維持原本「正視/正面」+ 自動旋轉展示的預設體驗，不強制凍結畫面。
      const restoredAngle = STATE.previewAngle;
      const activeAngle = restoredAngle || 'front';
      const activeCls = (a) => a === activeAngle ? ' active' : '';
      angleTools3D.innerHTML = isThermosPreview
        ? `<button type="button" class="align-btn${activeCls('front')}" data-angle="front" onclick="setStandardPreviewAngle('front')">正面</button>
           <button type="button" class="align-btn${activeCls('left')}" data-angle="left" onclick="setStandardPreviewAngle('left')">左側</button>
           <button type="button" class="align-btn${activeCls('right')}" data-angle="right" onclick="setStandardPreviewAngle('right')">右側</button>
           <button type="button" class="align-btn${activeCls('closeup')}" data-angle="closeup" onclick="setStandardPreviewAngle('closeup')">近拍</button>`
        : `<button type="button" class="align-btn${activeCls('front')}" data-angle="front" onclick="setStandardPreviewAngle('front')">正視</button>
           <button type="button" class="align-btn${activeCls('side')}" data-angle="side" onclick="setStandardPreviewAngle('side')">側視</button>
           <button type="button" class="align-btn${activeCls('closeup')}" data-angle="closeup" onclick="setStandardPreviewAngle('closeup')">近拍</button>`;
      if (typeof _standardPreviewAngle !== 'undefined') _standardPreviewAngle = activeAngle;
    }
  }

  if (STATE.productId === 'black_card') {
    // 尊爵不凡黑卡：改用攝影棚風格 2D 商品預覽，卡體/紋理/圓角/投影純 CSS 繪製，
    // 圖案依卡面比例自動置中縮放（不沿用設計稿上的手動位置/縮放），不做 3D 建模。
    const container = document.getElementById('preview3d-container');
    container.style = '';
    // 建立商品照式預覽前的短暫空檔（setTimeout 50ms）用文字提示取代空白區域，
    // 避免使用者以為畫面壞了；renderBlackCardPhotoPreview() 執行時一定會先整個
    // 重繪這個容器，提示文字不會殘留。
    container.innerHTML = '<div class="preview3d-loading">預覽載入中…</div>';
    if (caption) caption.textContent = '商品照式預覽 · 正式打樣以業務確認為準';
    if (reapplyBtn) reapplyBtn.style.display = '';
    // 使用者曾主動選過角度（STATE.previewAngle）才還原成那個角度，否則維持原本預設的
    // 'oblique' 斜角展示——避免切換到別的商品又切回來時，沿用上一個商品殘留在記憶體
    // 裡的舊角度變數。
    if (typeof _blackCardPreviewAngle !== 'undefined') _blackCardPreviewAngle = STATE.previewAngle || 'oblique';
    setTimeout(() => renderBlackCardPhotoPreview('preview3d-container', _onPreviewRenderComplete), 50);

  } else {
    // 卡片 / USB / 保溫杯：Three.js 3D 預覽
    const container = document.getElementById('preview3d-container');
    container.style = '';
    if (caption) {
      caption.textContent = isThermosPreview
        ? '固定視角展示，點其他角度按鈕可切換'
        : '自動旋轉展示產品正反面效果';
    }
    if (reapplyBtn) reapplyBtn.style.display = '';
    // 3D 場景需要一點時間建立（下方 150ms delay + WebGL/貼圖建置），這段空檔用簡短
    // 文字提示取代空白區域，避免使用者以為畫面壞了。
    container.innerHTML = '<div class="preview3d-loading">預覽載入中…</div>';
    setTimeout(() => {
      // 不管 init3DPreview() 內部是否會清空容器（只有 renderer 已存在時才會清），
      // 這裡先手動清乾淨再重建，確保上面的載入提示一定會被移除，不會殘留在畫面上。
      const c = document.getElementById('preview3d-container');
      if (c) c.innerHTML = '';
      init3DPreview('preview3d-container');
      if (STATE.productId === 'usb_bar') {
        buildUSB(finishId, dataURL, _onPreviewRenderComplete);
      } else if (isThermosPreview) {
        buildThermos(finishId, dataURL, STATE.cupColorId, _onPreviewRenderComplete);
      } else if (dataURL) {
        buildCard(dataURL, finishId, _onPreviewRenderComplete);
      } else {
        buildCard(null, finishId, _onPreviewRenderComplete);
      }
      // 使用者曾主動選過角度才凍結畫面套用回去；否則維持 init3DPreview() 內建的
      // 自動旋轉展示（見上方按鈕 active 樣式判斷同一個 STATE.previewAngle）。
      if (STATE.previewAngle && typeof setStandardPreviewAngle === 'function') {
        setStandardPreviewAngle(STATE.previewAngle);
      }
    }, 150);
  }

  renderSpecSummary();
}

// Step 4「↺ 重新套用設計圖」按鈕：依產品類型分派到對應的預覽重繪函式
function reapplyPreview() {
  if (STATE.productId === 'black_card') {
    renderBlackCardPhotoPreview('preview3d-container');
  } else {
    applyTexture3D();
  }
}

function renderSpecSummary() {
  const p = PRODUCTS[STATE.productId];
  if (!p) return;
  const mat = p.materials.find(m => m.id === STATE.materialId) || p.materials[0];
  const fin = p.finishes.find(f => f.id === STATE.finishId)     || p.finishes[0];
  const cap = p.capacities ? (p.capacities.find(c => c.id === STATE.capacityId) || p.capacities[0]) : null;
  const q   = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);

  const isBlackCard = p.id === 'black_card';
  // 缺少或錯誤的價格資料一律顯示清楚錯誤，絕不出現 undefined／NaN，也不會偷套用 0 元。
  let priceRows;
  if (!q.ok) {
    priceRows = `<tr><td colspan="2" class="quote-error">⚠ ${escapeHtml(q.error)}</td></tr>`;
  } else if (q.priceOnInquiry) {
    priceRows = `<tr><td>預估總計</td><td><strong>價格由業務確認</strong></td></tr>`;
  } else {
    priceRows = `<tr><td>數量級距</td><td>${escapeHtml(formatQtyBreakTier(q.qtyBreakUsed))}</td></tr>
       <tr><td>預估單價</td><td>NT$ ${q.unitPrice.toLocaleString()}</td></tr>
       <tr><td>預估總計</td><td><strong>NT$ ${q.total.toLocaleString()}</strong></td></tr>`;
  }

  // Step4／Step5 都會看到這份摘要：若卡面文字仍是模板內建的示範內容（使用者完全
  // 沒有修改過），額外提醒一次，避免使用者誤以為示範文字就是要送出的正式訂單內容。
  // 保溫杯沒有「卡面」，這裡的示範內容其實是藝術簽名，文案要對應改掉。
  const demoNoteRow = (typeof isDesignStillDemoPlaceholder === 'function' && isDesignStillDemoPlaceholder())
    ? `<tr><td colspan="2" class="demo-placeholder-note">⚠ ${p.id === 'thermos' ? '簽名內容' : '卡面文字'}目前仍為示範內容，尚未輸入您的內容，如需修改請點選「修改設計」返回設計稿頁。</td></tr>`
    : '';

  const html = `
      <div class="summary-badge" style="background:${escapeHtml(safeCssColor(p.color, '#999999'))}">${escapeHtml(p.name)}</div>
      <table class="summary-table">
        <tr><td>${escapeHtml(p.materialLabel || '材質')}</td><td>${escapeHtml(mat.name)}</td></tr>
        <tr><td>${escapeHtml(p.finishLabel || '表面工藝')}</td><td>${escapeHtml(fin.name)}</td></tr>
        ${cap ? `<tr><td>容量</td><td>${escapeHtml(cap.name)}</td></tr>` : ''}
        ${isBlackCard ? `<tr><td>印製面</td><td>單面設計（雙面客製請另洽業務）</td></tr>` : ''}
        <tr><td>數量</td><td>${STATE.qty.toLocaleString()} 個</td></tr>
        ${priceRows}
        <tr><td>預計交期</td><td>${Number(p.leadDays) || 0} 個工作天</td></tr>
        ${demoNoteRow}
      </table>
    `;
  ['preview-spec-summary', 'quote-spec-summary'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

// ─── Step 5：報價單 ────────────────────────────────────────
function initQuoteStep() {
  // 每次「真正重新進入」Step5都要先復原表單顯示狀態——submitQuote()成功後會把
  // .quote-layout藏起來防止重複送出（見該處註解），但如果使用者送出成功後又
  // 返回上一步、再往前來到Step5（例如檢查設計），這裡不重置的話表單會永遠消失。
  document.querySelector('.quote-layout')?.classList.remove('hidden');
  document.getElementById('quote-success')?.classList.add('hidden');
  renderSpecSummary();

  // 每次重新進入Step5視為新的一次詢價，換一把新的冪等性key；同一次停留在Step5期間
  // 不論送出失敗重試幾次都沿用同一把（見 submitQuote()），避免网路重試造成後端建立
  // 兩筆訂單。
  _quoteIdempotencyKey = null;

  // 測試模式提示：只讀取一個布林值，失敗（離線／伺服器錯誤）時安全略過、不顯示提示，
  // 不影響正式送出流程本身。
  const testModeBanner = document.getElementById('form-test-mode-banner');
  if (testModeBanner) {
    fetch('/api/form-test-mode').then(r => r.json()).then(data => {
      testModeBanner.classList.toggle('hidden', !data?.testMode);
    }).catch(() => { testModeBanner.classList.add('hidden'); });
  }
  if (typeof _bindContactFieldClearOnInput === 'function') _bindContactFieldClearOnInput();
  if (typeof _bindInquiryFormStartListeners === 'function') _bindInquiryFormStartListeners();

  const q = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);
  const quoteEl = document.getElementById('final-quote');
  const submitBtn = document.getElementById('submit-quote-btn');
  if (!quoteEl) return;

  // 計算失敗（材質/工藝/容量不存在、數量低於最低訂購量、數量沒有符合的級距等）時，
  // 顯示清楚錯誤並停用送出按鈕，避免帶著壞掉的報價送出詢價；不猜測、不套用 0 元。
  if (!q.ok) {
    quoteEl.innerHTML = `<div class="quote-error">⚠ ${escapeHtml(q.error)}</div>`;
    if (submitBtn) submitBtn.disabled = true;
    return;
  }
  if (submitBtn) submitBtn.disabled = false;

  if (q.priceOnInquiry) {
    quoteEl.innerHTML = `
      <div class="quote-row"><span>數量</span><strong>× ${q.qty.toLocaleString()}</strong></div>
      <div class="quote-row total"><span>預估總計</span><strong>價格由業務確認</strong></div>
      <p class="quote-disclaimer">※ 新品項目，尚無公開單價，業務確認後將另行回覆正式報價。</p>
    `;
    return;
  }

  quoteEl.innerHTML = `
    <div class="quote-row"><span>數量級距</span><strong>${escapeHtml(formatQtyBreakTier(q.qtyBreakUsed))}</strong></div>
    <div class="quote-row"><span>單價</span><strong>NT$ ${q.unitPrice.toLocaleString()}</strong></div>
    <div class="quote-row"><span>小計（× ${q.qty.toLocaleString()}）</span><strong>NT$ ${q.subtotal.toLocaleString()}</strong></div>
    <div class="quote-row"><span>製版費</span><strong>NT$ ${q.setupFee.toLocaleString()}</strong></div>
    <div class="quote-row total"><span>預估總計（未稅）</span><strong>NT$ ${q.total.toLocaleString()}</strong></div>
    <p class="quote-disclaimer">※ 以上為估算報價，實際金額以業務確認為準。含稅報價另計。</p>
  `;
}

// 聯絡電話格式友善驗證：非必填，但填了就要看起來像電話（數字/常見符號組成，
// 長度落在合理範圍），不要求嚴格的市話/手機格式規則，避免擋掉分機、國際碼等寫法。
const CONTACT_PHONE_FRIENDLY_RE = /^[0-9+()#\-\s]{7,20}$/;

// 逐欄檢查聯絡資料，回傳 { 欄位id: { message, category } }（沒問題的欄位不會出現在
// 裡面）。message 直接顯示在該欄位正下方（明確對應「哪一個欄位」出了什麼問題，也才
// 有各自的元素可以掛 aria-describedby）；category 是給 inquiry_validation_error 事件
// 追蹤用的穩定分類代碼（'required'／'invalid_format'），跟這裡的判斷式一一對應，
// 不用另外猜測顯示文字反推分類，這是唯一一份驗證邏輯來源。
function _validateContactFormFields(name, email, phone) {
  const errors = {};
  if (!name) errors['contact-name'] = { message: '請輸入姓名或公司名稱。', category: 'required' };
  if (!email) {
    errors['contact-email'] = { message: '請輸入 Email。', category: 'required' };
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors['contact-email'] = { message: 'Email 格式不正確，請確認後再試。', category: 'invalid_format' };
  }
  if (phone && !CONTACT_PHONE_FRIENDLY_RE.test(phone)) {
    errors['contact-phone'] = { message: '電話格式不正確，請輸入市話或手機號碼。', category: 'invalid_format' };
  }
  return errors;
}

// 標記／解除單一欄位的錯誤狀態：紅框樣式＋aria-invalid（給輔助科技辨識）＋欄位
// 正下方的錯誤文字（aria-describedby 已在 HTML 靜態指到這個元素，這裡只切換內容
// 與顯示/隱藏，role="alert" 讓螢幕閱讀器在文字出現時主動朗讀）。只改樣式與文字，
// 完全不動 input.value，使用者已填的其他欄位內容不會被清空。
function _setContactFieldError(id, message) {
  const input = document.getElementById(id);
  const errEl = document.getElementById(id + '-error');
  if (input) input.classList.add('field-invalid');
  if (input) input.setAttribute('aria-invalid', 'true');
  if (errEl) { errEl.textContent = message; errEl.classList.remove('hidden'); }
}
function _clearContactFieldError(id) {
  const input = document.getElementById(id);
  const errEl = document.getElementById(id + '-error');
  if (input) input.classList.remove('field-invalid');
  if (input) input.removeAttribute('aria-invalid');
  if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
}

// 使用者開始修正某個標紅框的欄位時，立即移除該欄位的錯誤狀態（不用等再次點送出
// 才知道有沒有修好）；只綁定一次，不會因為每次進 Step5 都重新 renderStep() 而
// 重複掛上多個相同的 input 監聽器。
let _contactFieldListenersBound = false;
function _bindContactFieldClearOnInput() {
  if (_contactFieldListenersBound) return;
  _contactFieldListenersBound = true;
  ['contact-name', 'contact-email', 'contact-phone'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => _clearContactFieldError(id));
  });
}

// 詢價送出冪等性key：由前端產生一次，同一次停留在Step5期間重試送出（例如網路逾時後
// 使用者再點一次）沿用同一把，讓後端 /api/save-order 能辨識「這是同一次詢價的重試」，
// 不會因為重試就建立兩筆訂單。只用亂數格式，不放入姓名/Email等個資；每次重新進入
// Step5會換一把新的（見 initQuoteStep()）。
let _quoteIdempotencyKey = null;

// 送出詢價
async function submitQuote() {
  const name  = document.getElementById('contact-name').value.trim();
  const email = document.getElementById('contact-email').value.trim();
  const phone = document.getElementById('contact-phone').value.trim();
  const note  = document.getElementById('contact-note').value.trim();

  const errEl = document.getElementById('submit-quote-error'); // 保留給下面API/網路層級的錯誤用，不用於欄位驗證
  ['contact-name', 'contact-email', 'contact-phone'].forEach(id => _clearContactFieldError(id));

  // 缺漏／格式錯誤一律標在對應欄位正下方，不使用會卡住整個分頁 JS 執行緒的
  // alert()，也不會呼叫下面的正式詢價 API（return 在 fetch('/api/save-order') 之前）。
  const fieldErrors = _validateContactFormFields(name, email, phone);
  const invalidIds = Object.keys(fieldErrors);
  if (invalidIds.length) {
    invalidIds.forEach(id => _setContactFieldError(id, fieldErrors[id].message));
    document.getElementById(invalidIds[0])?.focus();
    // inquiry_validation_error：沿用上面_validateContactFormFields()的真實驗證結果，
    // 一次送出有幾個欄位沒過就各記一筆（invalidIds本身已經是不重複的欄位id，同一次
    // 送出同一欄位天生只會出現一次）；只送白名單裡有對應的3個欄位，且放在紅框／
    // 錯誤提示／focus都處理完、return之前，就算追蹤本身出例外也不影響上面已經做完
    // 的UI行為與這裡的return。
    try {
      invalidIds.forEach(id => {
        const fieldKey = ANALYTICS_CONTACT_FIELD_KEY_MAP[id];
        if (fieldKey) _trackInquiryValidationError(STATE.productId, fieldKey, fieldErrors[id].category);
      });
    } catch (e) { /* 追蹤失敗不得影響原本的return流程 */ }
    return;
  }
  if (errEl) errEl.classList.add('hidden');

  const btn     = document.getElementById('submit-quote-btn');
  const btnText = document.getElementById('submit-quote-text');
  const btnLoad = document.getElementById('submit-quote-loading');
  if (btn.disabled) return; // 防止重複點擊

  const p = PRODUCTS[STATE.productId];
  const q = calcQuote(STATE.productId, STATE.materialId, STATE.finishId, STATE.qty, STATE.capacityId);
  // 報價計算失敗（材質/工藝/容量不存在、數量低於最低訂購量、數量沒有符合的級距等）
  // 就不送出：initQuoteStep() 已經在畫面上停用送出按鈕，這裡再檔一次防止繞過。
  if (!q.ok) {
    errEl.textContent = `❌ ${q.error}`;
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btnText.classList.add('hidden');
  btnLoad.classList.remove('hidden');
  errEl.classList.add('hidden');

  // ── 儲存訂單資料至伺服器：只送出商品／材質／工藝／容量的 id 與數量，實際報價
  // （單價、小計、總額、顯示用的材質／工藝／容量名稱）一律由後端依資料庫商品資料
  // 重新計算，不信任前端算出的金額；這裡的 q 只附上供後端比對是否一致（僅供記錄
  // 警告用，不一致一律以後端為準），畫面之後顯示的也一律改用後端回應的權威資料。
  let saveOk = false;
  let friendlyOrderNo = null;
  let savedQuote = null;
  let savedProduct = null;
  let saveErrorMessage = null;
  try {
    // 在送出請求之前先鎖定這次的匿名關聯，避免等待期間（await fetch）資料被切換；
    // 取得失敗時 _getAnalyticsContextForRequest() 回傳 null，整個 analyticsContext 欄位
    // 直接省略，不影響詢價送出。
    const _saveOrderAnalyticsContext = (typeof _getAnalyticsContextForRequest === 'function') ? _getAnalyticsContextForRequest() : null;
    if (!_quoteIdempotencyKey) {
      _quoteIdempotencyKey = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    const resp = await fetch('/api/save-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contact: { name, email, phone, note },
        product: {
          id: p.id,
          materialId: STATE.materialId,
          finishId: STATE.finishId,
          capacityId: STATE.capacityId || null,
          qty: STATE.qty
        },
        quote: q,
        designDataURL: STATE.designDataURL || null,
        idempotencyKey: _quoteIdempotencyKey,
        ...( _saveOrderAnalyticsContext ? { analyticsContext: _saveOrderAnalyticsContext } : {} )
      })
    });
    saveOk = resp.ok;
    const data = await resp.json().catch(() => null);
    if (saveOk) {
      friendlyOrderNo = data?.friendlyOrderNo || null;
      savedQuote = data?.quote || null;
      savedProduct = data?.product || null;
    } else {
      saveErrorMessage = data?.error || null;
    }
  } catch (e) {
    console.warn('[submitQuote] 訂單儲存失敗', e);
    saveOk = false;
  }

  btn.disabled = false;
  btnText.classList.remove('hidden');
  btnLoad.classList.add('hidden');

  if (!saveOk) {
    errEl.textContent = saveErrorMessage ? `❌ ${saveErrorMessage}` : '❌ 送出失敗，請確認網路連線後再試一次，或直接來電 02-2680-9966。';
    errEl.classList.remove('hidden');
    return;
  }

  // ── 準備 mailto 連結，供消費者「額外」自行寄信用，不自動跳轉 ──
  // 一律使用後端回應的權威資料（savedProduct／savedQuote），不使用前端本地算出的 q／
  // mat／fin／cap，確保信件內容跟實際存進訂單、業務看到的資料完全一致。
  const matName = savedProduct?.material || '--';
  const finName = savedProduct?.finish || '--';
  const capName = savedProduct?.capacity || null;
  const quoteTotalText = savedQuote?.priceOnInquiry
    ? '價格由業務確認'
    : (savedQuote && typeof savedQuote.total === 'number' ? `NT$ ${savedQuote.total.toLocaleString()}（未稅，含製版費）` : '--');
  const subject = encodeURIComponent(`[楊竹科技詢價] ${p.name} × ${STATE.qty} 個`);
  const body = encodeURIComponent(
`楊竹科技線上詢價單
==================
聯絡人：${name}
Email：${email}
電話：${phone || '未填寫'}

產品：${p.name}
材質：${matName}
工藝：${finName}${capName ? `\n容量：${capName}` : ''}
數量：${STATE.qty.toLocaleString()} 個
預估總計：${quoteTotalText}

備註：
${note || '無'}

--
此詢價單由楊竹科技線上配置器自動產生
`);
  // window.SITE_CONTACT_EMAIL 由 js/site-content.js 在頁面載入時讀取後台「網站內容設定」
  // 並驗證過Email格式才會設定；沒有自訂或驗證失敗時維持 undefined，這裡退回原本的正式Email。
  const mailtoLink = document.getElementById('quote-mailto-link');
  if (mailtoLink) mailtoLink.href = `mailto:${window.SITE_CONTACT_EMAIL || 'sales@yangzhu.com.tw'}?subject=${subject}&body=${body}`;

  const orderNoEl = document.getElementById('quote-order-no');
  if (orderNoEl) {
    if (friendlyOrderNo) {
      orderNoEl.textContent = `您的訂單編號：${friendlyOrderNo}（與業務聯絡時可提供此編號加速核對）`;
      orderNoEl.classList.remove('hidden');
    } else {
      orderNoEl.classList.add('hidden');
    }
  }

  // 顯示成功訊息（訂單已確實存進伺服器才會顯示）。同時把整個聯絡表單／送出按鈕
  // 一起藏起來——in-flight的重複點擊已經靠上面的btn.disabled擋掉，但送出成功、
  // 按鈕重新變回可點擊之後，表單如果還留在畫面上，使用者很容易誤按第二次「送出
  // 詢價單」，用同一批聯絡資料/設計又建立一張重複訂單。成功後直接讓表單消失，
  // 從源頭排除這個路徑；「返回預覽」「重新配置」在.quote-layout之外，不受影響。
  document.querySelector('.quote-layout')?.classList.add('hidden');
  document.getElementById('quote-success').classList.remove('hidden');
  // 訂單已成功送出，這份設計已完成階段性任務，清掉自動保存內容，避免下次
  // 開新訂單時被強制接回這份已經處理過的舊設計。
  if (typeof _clearSavedDesignSilently === 'function') _clearSavedDesignSilently();
}

// 商品卡片清單：商品資料來自後台輸入（資料庫或備援檔），一律用 escapeHtml／
// isSafeImageUrl／safeCssColor 把關才能插入 innerHTML，避免商品名稱、說明、
// 圖片路徑、徽章顏色被拿來塞腳本或跳脫屬性。點擊改用事件委派，不用字串拼接 onclick。
function renderProductGrid() {
  const grid = document.getElementById('product-grid');
  if (!grid) return;
  const productList = Object.values(PRODUCTS);
  if (!productList.length) {
    grid.innerHTML = '<p style="color:var(--gray-400);padding:20px;">目前沒有可選購的商品，請稍後再試或聯絡業務。</p>';
    return;
  }
  grid.innerHTML = productList.map(p => {
    const safeId = escapeHtml(p.id);
    const safeName = escapeHtml(p.name || '');
    const safeDesc = escapeHtml(p.description || '');
    const safeBadge = escapeHtml(p.badge || '');
    const safeBadgeColor = escapeHtml(safeCssColor(p.badgeColor, '#999999'));
    const isSvg = p.image && p.image.toLowerCase().endsWith('.svg');
    const imgStyle = isSvg ? 'object-fit:contain;padding:8px;background:#f5f0ea;' : '';
    const sizeText = escapeHtml(p.displaySize || `${p.size.w} × ${p.size.h} ${p.size.unit}`);
    // 沒有照片時不再用 emoji 圓形圖示佔位，直接留白讓純文字卡自然往上銜接，
    // 不用新圖案替代（見 renderProductGrid 下方 img 載入失敗的 fallback，邏輯同步）。
    const imgHtml = isSafeImageUrl(p.image)
      ? `<div class="product-img-wrap">
           <img src="${escapeHtml(p.image)}" alt="${safeName}" class="product-img" loading="lazy" style="${imgStyle}">
         </div>`
      : '';
    return `
    <div class="product-card product-${safeId}" data-product-id="${safeId}">
      ${imgHtml}
      <div class="product-badge" style="background:${safeBadgeColor}">${safeBadge}</div>
      <h3>${safeName}</h3>
      <p>${safeDesc}</p>
      <div class="product-size">${sizeText}</div>
      <div class="product-min">最低 ${Number.isFinite(p.minQty) ? p.minQty : 1} 個起</div>
    </div>
  `;
  }).join('');

  // 圖片載入失敗時直接移除圖片區塊，退回純文字卡片（不用 emoji 圖示佔位，
  // 避免留下空白圓圈或用新圖案替代）
  grid.querySelectorAll('.product-img').forEach(img => {
    img.addEventListener('error', () => {
      const wrap = img.closest('.product-img-wrap');
      if (wrap) wrap.remove();
    }, { once: true });
  });
}

// 重整/離開頁面就不保留草稿：偵測到這次進入是「重新整理」（F5／瀏覽器重整鈕），
// 清掉這個分頁「目前指向哪份草稿」的索引，並導回首頁，不接續任何舊設計。
// 光清 activeDraft 索引還不夠——草稿內容實際上是用「分頁ID＋商品」當鑰匙存在
// localStorage，而分頁ID（customizer:tabDraftId）本身存在 sessionStorage，F5重整
// 並不會換掉它，所以就算索引被清掉，只要使用者重整後再點回同一個商品，
// selectProduct() 還是會用同一把分頁ID鑰匙撈到舊草稿、原封不動恢復回來。
// 因此這裡把分頁ID也一併清掉，下次呼叫 getTabDraftId() 會產生全新的ID，
// 保證找不到任何舊草稿——等同每次都先按了「刪除此商品草稿」。舊草稿內容本身留在
// localStorage 不會主動刪除（只是換了鑰匙後永遠不會再被讀到），草稿系統其餘用途
// （同一次瀏覽中途分頁切換、報價確認頁）都是同一頁面內的操作，不會觸發這裡，不受影響。
(function _redirectHomeOnReload() {
  try {
    const navEntries = performance.getEntriesByType('navigation');
    const isReload = navEntries.length > 0
      ? navEntries[0].type === 'reload'
      : (performance.navigation && performance.navigation.type === 1);
    if (isReload) {
      try {
        const oldTabDraftId = sessionStorage.getItem('customizer:tabDraftId');
        if (oldTabDraftId && typeof clearAllDraftsForTab === 'function') clearAllDraftsForTab(oldTabDraftId);
      } catch (e) {}
      try { sessionStorage.removeItem('customizer:activeDraft'); } catch (e) {}
      try { sessionStorage.removeItem('customizer:tabDraftId'); } catch (e) {}
      location.replace('/');
    }
  } catch (e) { /* 偵測失敗就照常進入配置器，不影響原本流程 */ }
})();

// 離開這個分頁（關閉分頁、換網址、按回主頁）時同樣清掉草稿索引與分頁ID，讓下次
// 重新進入配置器一定是全新空白草稿，不會被帶回舊設計（原因同上）。
window.addEventListener('pagehide', () => {
  try {
    const oldTabDraftId = sessionStorage.getItem('customizer:tabDraftId');
    if (oldTabDraftId && typeof clearAllDraftsForTab === 'function') clearAllDraftsForTab(oldTabDraftId);
  } catch (e) {}
  try { sessionStorage.removeItem('customizer:activeDraft'); } catch (e) {}
  try { sessionStorage.removeItem('customizer:tabDraftId'); } catch (e) {}
});

// ─── 初始化 ───────────────────────────────────────────────
// 商品資料載入交給 js/product-service.js（database 優先，連不上退回 js/products.js 備援），
// 這裡只負責「等它跑完再 render」，不重複實作載入/備援邏輯。
document.addEventListener('DOMContentLoaded', async () => {
  if (typeof purgeStaleDrafts === 'function') purgeStaleDrafts();

  await loadProductsFromDatabase();
  renderProductGrid();

  // 深連結（?product=xxx）判斷必須排在「一般草稿恢復」之前，且完全獨立判斷，
  // 不能等 restoreSavedDesignIfAny() 跑完再看要不要覆蓋。原因：saveDraft()
  // 每次存檔都會把 sessionStorage 的 customizer:activeDraft 指標改成「這個分頁
  // 最後動過的商品」，只要分頁裡曾經編輯過任何商品，之後不管網址帶哪個
  // product 參數，restoreSavedDesignIfAny() 都會先把那個舊指標指到的商品畫面
  // 恢復出來——這正是先前「?product=ipass/thermos/black_card 深連結卻顯示
  // 悠遊卡、重新整理仍是悠遊卡」的成因。網址參數必須優先於這個全域指標、優先於
  // localStorage 裡其他商品的草稿，也不能落回預設第一個商品 easycard。
  const DEEP_LINK_ALLOWED_IDS = ['easycard', 'ipass', 'thermos', 'black_card'];
  const rawProductParam = new URLSearchParams(window.location.search).get('product');

  if (rawProductParam !== null) {
    const isValidDeepLink = DEEP_LINK_ALLOWED_IDS.includes(rawProductParam) && !!PRODUCTS[rawProductParam];
    if (isValidDeepLink) {
      // selectProduct() 是商品切換唯一入口：只讀取「這個商品＋這個分頁」自己的
      // 草稿（loadDraft(productId, getTabDraftId())），不理會 activeDraft 指標，
      // 也會完整跑規格/材質/工藝/數量/報價初始化並進到 Step2，不是只改網址或
      // 步驟數字。之後 scheduleSaveDesign() 才會把 activeDraft 指標更新成這個
      // 商品，讓「同一分頁單純重新整理（網址不變）」也能接回同一個商品。
      await selectProduct(rawProductParam, _resolveDeepLinkEntryPoint());
    } else {
      // 參數不在白名單、或商品已下架（不在目前 PRODUCTS 內）：停在 Step1，
      // 不恢復任何商品草稿，也不預設 easycard；用既有 Toast 提示一次，
      // 不使用會卡住整個分頁 JS 執行緒的 alert()。
      renderStep();
      _showConfiguratorToast('此商品目前無法線上配置，請重新選擇商品。');
    }
  } else {
    // 網址沒有帶 product 參數：維持原本「有已保存的設計就自動接回，沒有才顯示
    // Step1」的一般流程。restoreSavedDesignIfAny() 內部已經處理好面板切換與
    // 畫布還原，這裡不用再多呼叫一次 renderStep()。
    const restored = (typeof restoreSavedDesignIfAny === 'function') ? await restoreSavedDesignIfAny() : false;
    if (!restored) renderStep();
  }

  // 商品卡片點擊：事件委派到外層容器，只綁一次，不會因為 renderProductGrid 重新
  // render 而重複綁定，也不需要在商品 id 裡拼接 inline onclick 字串。
  const grid = document.getElementById('product-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.product-card');
      if (card && card.dataset.productId) selectProduct(card.dataset.productId);
    });
  }
});

// Step 2 切入時需重新渲染
const _origGoStep = goStep;
