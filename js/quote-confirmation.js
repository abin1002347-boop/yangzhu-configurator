// 客戶報價確認頁面。只從 location.hash 讀取原始權杖，絕不放進 query string、
// 絕不印出到 console／錯誤訊息／畫面，也絕不傳給第三方。所有伺服器資料一律用
// textContent 顯示，不使用 innerHTML，避免 XSS。
//
// 同一分頁可能在不重新載入文件的情況下切換權杖（#token=A → #token=B），瀏覽器
// 只會觸發 hashchange，不會重新執行整份程式，因此「載入某個權杖的報價」這件事
// 一律走同一個 handleTokenChange() 流程（初次載入與 hashchange 共用），並用遞增的
// requestSeq 搭配 AbortController 確保較慢的舊權杖回應不會蓋掉使用者目前已經切換
// 到的新權杖畫面；所有跟 sessionStorage 有關的函式都改成明確接受 tokenHash 參數，
// 不再讀取可能已經被切換掉的全域變數，避免非同步回呼誤用到別的權杖的資料。
(function () {
  'use strict';

  var TOKEN_HASH_PATTERN = /^#token=([0-9a-f]{64})$/i;
  var NOTE_MAX_LEN = 1000;

  var els = {
    loading: document.getElementById('state-loading'),
    invalid: document.getElementById('state-invalid'),
    content: document.getElementById('state-content'),

    versionLabel: document.getElementById('version-label'),
    validUntil: document.getElementById('valid-until'),
    statusLabel: document.getElementById('status-label'),

    productName: document.getElementById('product-name'),
    productMaterial: document.getElementById('product-material'),
    productFinish: document.getElementById('product-finish'),
    productCapacity: document.getElementById('product-capacity'),
    productQty: document.getElementById('product-qty'),

    customerName: document.getElementById('customer-name'),
    customerEmail: document.getElementById('customer-email'),
    customerPhone: document.getElementById('customer-phone'),

    priceInquiryNote: document.getElementById('price-inquiry-note'),
    priceBase: document.getElementById('price-base'),
    priceDiscount: document.getElementById('price-discount'),
    priceExtra: document.getElementById('price-extra'),
    priceShipping: document.getElementById('price-shipping'),
    priceTax: document.getElementById('price-tax'),
    priceFinal: document.getElementById('price-final'),

    quoteNotes: document.getElementById('quote-notes'),

    responseForm: document.getElementById('response-form'),
    pendingNotice: document.getElementById('pending-notice'),
    noteInput: document.getElementById('note-input'),
    noteCounter: document.getElementById('note-counter'),
    btnAccept: document.getElementById('btn-accept'),
    btnReject: document.getElementById('btn-reject'),
    submitError: document.getElementById('submit-error'),

    responseCompleted: document.getElementById('response-completed'),
    completedDecision: document.getElementById('completed-decision'),
    completedTime: document.getElementById('completed-time'),
    completedNote: document.getElementById('completed-note')
  };

  // currentToken／currentTokenHash 只代表「目前網址片段對應的權杖」，用來讓按鈕
  // 點擊時知道要送去哪個權杖；任何非同步回呼（GET／POST 的 then／catch）一律使用
  // 呼叫當下明確傳入或閉包捕捉到的 token／tokenHash，不得在回呼內才臨時讀取這兩個
  // 全域變數，避免切換權杖後這兩個值已經改變、造成新舊資料交錯。
  var currentToken = null;
  var currentTokenHash = null;
  var submitting = false;

  // requestSeq 每次權杖切換就遞增一次；每個載入請求在發出當下捕捉自己的 seq，
  // 回來時比對是否仍是最新的 seq，不是就直接捨棄結果（畫面已經在顯示更新的權杖）。
  // activeController 是目前這一組請求的 AbortController，權杖切換時主動中止上一組，
  // 讓瀏覽器盡快放棄已經不需要的網路請求。
  var requestSeq = 0;
  var activeController = null;

  function showState(name) {
    els.loading.hidden = name !== 'loading';
    els.invalid.hidden = name !== 'invalid';
    els.content.hidden = name !== 'content';
  }

  function getTokenFromHash() {
    var m = TOKEN_HASH_PATTERN.exec(window.location.hash || '');
    return m ? m[1].toLowerCase() : null;
  }

  // 純粹的本機儲存鍵計算，跟伺服器端邏輯無關；只用來避免 sessionStorage 鍵名
  // 直接出現原始權杖。此雜湊值只留在瀏覽器本地，不會被送出。
  function sha256Hex(text) {
    var data = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', data).then(function (buf) {
      var bytes = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0');
      }
      return hex;
    });
  }

  function textOrFallback(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
  }

  function moneyOrFallback(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return value.toLocaleString('zh-Hant-TW') + ' 元';
  }

  function formatDateTime(iso) {
    if (typeof iso !== 'string' || !iso) return '未提供';
    var d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '未提供';
    return d.toLocaleString('zh-Hant-TW', { hour12: false });
  }

  function set(el, text) {
    el.textContent = text;
  }

  // ── sessionStorage 待送出紀錄（鍵名用 token 的 SHA-256，不直接含原始權杖）──
  // 一律要求呼叫端明確傳入 tokenHash，不讀取全域變數：確保即使使用者已經切換到
  // 別的權杖，先前某個權杖自己發起的讀寫仍然只會動到「它自己那個權杖」的紀錄，
  // 不會誤用切換後的新 tokenHash，也不會刪掉其他權杖原本保存的待送出紀錄。
  function pendingKey(tokenHash) {
    return 'qc_pending_' + tokenHash;
  }

  function loadPending(tokenHash) {
    try {
      var raw = sessionStorage.getItem(pendingKey(tokenHash));
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function savePending(tokenHash, data) {
    try {
      sessionStorage.setItem(pendingKey(tokenHash), JSON.stringify(data));
    } catch (e) {
      // sessionStorage 不可用時（例如私密瀏覽模式限制），不影響本次送出流程，
      // 只是重新整理後無法沿用同一組 idempotencyKey。
    }
  }

  function clearPending(tokenHash) {
    try {
      sessionStorage.removeItem(pendingKey(tokenHash));
    } catch (e) {
      // 同上，忽略。
    }
  }

  function resolveIdempotencyKey(tokenHash, decision, note) {
    var existing = loadPending(tokenHash);
    if (existing && existing.decision === decision && existing.note === note && typeof existing.idempotencyKey === 'string') {
      return existing.idempotencyKey;
    }
    var key = crypto.randomUUID();
    savePending(tokenHash, { idempotencyKey: key, decision: decision, note: note });
    return key;
  }

  function setSubmitting(state) {
    submitting = state;
    els.btnAccept.disabled = state;
    els.btnReject.disabled = state;
    els.noteInput.disabled = state;
  }

  function showError(msg) {
    set(els.submitError, msg);
  }

  function clearError() {
    set(els.submitError, '');
  }

  function updateNoteCounter() {
    set(els.noteCounter, els.noteInput.value.length + ' / ' + NOTE_MAX_LEN);
  }

  // 權杖即將切換（或初次載入）時，先把畫面回復成乾淨的初始狀態，避免任何一瞬間
  // 殘留上一位客戶的報價、完成狀態或表單內容：顯示載入中、清空備註／錯誤／待重送
  // 提示、恢復按鈕與輸入欄位可用狀態。真正的報價內容要等新權杖的資料回來後才會
  // 由 renderQuote() 重新填入。
  function resetViewForTokenChange() {
    showState('loading');
    clearError();
    els.pendingNotice.hidden = true;
    els.noteInput.value = '';
    updateNoteCounter();
    setSubmitting(false);
  }

  function renderQuote(quote, tokenHash) {
    showState('content');

    set(els.versionLabel, textOrFallback(quote.versionLabel, '未提供'));
    set(els.validUntil, formatDateTime(quote.validUntil));
    set(els.statusLabel, quote.status === 'expired' ? '已過期' : '有效');

    var product = quote.product || {};
    set(els.productName, textOrFallback(product.name, '未提供'));
    set(els.productMaterial, textOrFallback(product.material, '未提供'));
    set(els.productFinish, textOrFallback(product.finish, '未提供'));
    set(els.productCapacity, textOrFallback(product.capacity, '未提供'));
    set(els.productQty, product.qty === null || product.qty === undefined ? '未提供' : textOrFallback(product.qty, '未提供') + ' 個');

    var customer = quote.customer || {};
    set(els.customerName, textOrFallback(customer.name, '未提供'));
    set(els.customerEmail, textOrFallback(customer.email, '未提供'));
    set(els.customerPhone, textOrFallback(customer.phone, '未提供'));

    var pricing = quote.pricing || {};
    var priceOnInquiry = !!product.priceOnInquiry;
    els.priceInquiryNote.hidden = !priceOnInquiry;
    var priceFallback = priceOnInquiry ? '洽業務' : '未提供';
    set(els.priceBase, moneyOrFallback(pricing.baseAmount, priceFallback));
    set(els.priceDiscount, moneyOrFallback(pricing.discountAmount, priceFallback));
    set(els.priceExtra, moneyOrFallback(pricing.extraFee, priceFallback));
    set(els.priceShipping, moneyOrFallback(pricing.shippingFee, priceFallback));
    set(els.priceTax, moneyOrFallback(pricing.taxAmount, priceFallback));
    set(els.priceFinal, moneyOrFallback(pricing.finalTotal, priceFallback));

    set(els.quoteNotes, textOrFallback(quote.notes, '無'));

    if (quote.customerResponse) {
      clearPending(tokenHash);
      els.responseForm.hidden = true;
      els.responseCompleted.hidden = false;
      renderCompleted(quote.customerResponse);
    } else {
      els.responseCompleted.hidden = true;
      els.responseForm.hidden = false;

      var pending = loadPending(tokenHash);
      if (pending && typeof pending.note === 'string') {
        els.noteInput.value = pending.note;
        updateNoteCounter();
        els.pendingNotice.hidden = false;
      } else {
        els.noteInput.value = '';
        updateNoteCounter();
        els.pendingNotice.hidden = true;
      }
    }
  }

  function renderCompleted(response) {
    set(els.completedDecision, response.decision === 'accepted' ? '已接受' : '已拒絕');
    set(els.completedTime, formatDateTime(response.respondedAt));
    set(els.completedNote, textOrFallback(response.note, '無'));
  }

  // token／tokenHash／seq／controller 全部由呼叫端明確傳入，不讀取可能已經被
  // 切換掉的全域變數；每個非同步分支回來時都先比對 seq 是否仍是目前最新的一組
  // 請求，不是就直接捨棄（代表使用者已經切換到別的權杖，這筆結果已經過期）。
  function loadQuote(token, tokenHash, seq, controller) {
    return fetch('/api/public/quote-confirmations/' + token, {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal
    }).then(function (res) {
      if (seq !== requestSeq) return;
      if (!res.ok) {
        showState('invalid');
        return;
      }
      return res.json().then(function (data) {
        if (seq !== requestSeq) return;
        if (!data || data.success !== true || !data.quote) {
          showState('invalid');
          return;
        }
        renderQuote(data.quote, tokenHash);
      });
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return; // 被更新的權杖切換中止，不是真的失敗
      if (seq !== requestSeq) return;
      showState('invalid');
    });
  }

  // 送出成功／格式錯誤或衝突後想重新讀取目前狀態時使用；同樣套用 seq／controller
  // 規則，並且會被記為目前這個權杖最新的一組進行中請求，讓後續若切換權杖時能正確中止。
  function quietReloadQuote(token, tokenHash) {
    var seq = requestSeq;
    var controller = new AbortController();
    activeController = controller;
    return loadQuote(token, tokenHash, seq, controller);
  }

  function submitResponse(decision) {
    if (submitting) return;
    if (!currentToken || !currentTokenHash) return; // 目前沒有合法權杖可以送出（例如正顯示失效畫面）

    var token = currentToken;
    var tokenHash = currentTokenHash;

    var note = els.noteInput.value.trim();
    if (note.length > NOTE_MAX_LEN) {
      showError('備註不可超過 ' + NOTE_MAX_LEN + ' 字');
      return;
    }

    var decisionLabel = decision === 'accepted' ? '接受' : '拒絕';
    var confirmMsg = '您確定要「' + decisionLabel + '」這份報價嗎？' +
      (note ? '\n備註：' + note : '') +
      '\n送出後將無法修改。';
    if (!window.confirm(confirmMsg)) return;

    clearError();
    setSubmitting(true);

    var idempotencyKey = resolveIdempotencyKey(tokenHash, decision, note);

    fetch('/api/public/quote-confirmations/' + token + '/response', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: decision, note: note, idempotencyKey: idempotencyKey })
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        return { res: res, data: data };
      });
    }).then(function (result) {
      var res = result.res, data = result.data;
      // 送出期間使用者可能已經切換到別的權杖：sessionStorage 的讀寫一律只認送出當下
      // 捕捉到的 token／tokenHash，跟目前畫面無關；但畫面本身（renderQuote／setSubmitting／
      // showError）只在使用者仍停留在同一個權杖時才更新，避免蓋掉使用者已經切過去的新畫面。
      var stillSameToken = token === currentToken;

      if (res.ok && data && data.success === true && data.quote) {
        clearPending(tokenHash);
        if (stillSameToken) {
          renderQuote(data.quote, tokenHash);
        }
        return;
      }

      if (res.status === 400 || res.status === 409) {
        // 格式錯誤或衝突（連結已失效、已被其他請求回覆過等）：重送同樣內容不會成功，
        // 清除待送出紀錄並重新讀取最新狀態，讓畫面反映伺服器目前的真實狀態。
        clearPending(tokenHash);
        if (stillSameToken) {
          setSubmitting(false);
          quietReloadQuote(token, tokenHash);
        }
        return;
      }

      // 網路中斷或伺服器錯誤：保留待送出紀錄，允許重新整理頁面後安全重送。
      if (stillSameToken) {
        setSubmitting(false);
        showError('送出失敗，請確認網路連線後再試一次，或重新整理頁面重試。');
      }
    }).catch(function () {
      if (token === currentToken) {
        setSubmitting(false);
        showError('送出失敗，請確認網路連線後再試一次，或重新整理頁面重試。');
      }
    });
  }

  // 初次載入與 hashchange（同分頁切換權杖）共用同一個流程：不使用 location.reload()，
  // 只重新解析 hash、重置畫面、並照目前流程重新載入對應權杖的報價。
  function handleTokenChange() {
    requestSeq += 1;
    var seq = requestSeq;

    if (activeController) {
      activeController.abort();
      activeController = null;
    }

    resetViewForTokenChange();

    var token = getTokenFromHash();

    if (!token) {
      currentToken = null;
      currentTokenHash = null;
      showState('invalid');
      return;
    }

    currentToken = token;
    currentTokenHash = null; // 雜湊算出前先清空，避免這段期間有任何動作誤用上一個權杖的雜湊

    var controller = new AbortController();
    activeController = controller;

    sha256Hex(token).then(function (hash) {
      if (seq !== requestSeq) return; // 雜湊算好前使用者已經又切換權杖，捨棄
      currentTokenHash = hash;
      return loadQuote(token, hash, seq, controller);
    }).catch(function () {
      if (seq !== requestSeq) return;
      showState('invalid');
    });
  }

  function init() {
    els.noteInput.addEventListener('input', updateNoteCounter);
    els.btnAccept.addEventListener('click', function () { submitResponse('accepted'); });
    els.btnReject.addEventListener('click', function () { submitResponse('rejected'); });
    window.addEventListener('hashchange', handleTokenChange);

    handleTokenChange();
  }

  init();
})();
