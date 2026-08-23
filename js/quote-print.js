// 正式報價單預覽／列印頁。這個視窗完全不呼叫任何 API、不讀取 localStorage／
// sessionStorage、不知道 orderId 是誰——資料只能透過 opener（後台 admin.html）用
// postMessage 傳入「這一個報價版本」的固定快照欄位（productSnapshot／customerSnapshot／
// pricingSnapshot／versionLabel／createdAt／validUntil／notes／isLatest），不可能讀到
// 會隨時間變動的目前訂單資料（狀態、負責人、付款、物流……），因為這個視窗根本沒有
// 管道拿得到。所有動態資料一律用 textContent 顯示，不使用 innerHTML，避免 XSS。
(function () {
  'use strict';

  const els = {
    loading: document.getElementById('state-loading'),
    error: document.getElementById('state-error'),
    content: document.getElementById('state-content'),

    badgeVersion: document.getElementById('badge-version'),
    badgeHistory: document.getElementById('badge-history'),
    badgeExpired: document.getElementById('badge-expired'),

    quoteDate: document.getElementById('quote-date'),
    quoteValidUntil: document.getElementById('quote-valid-until'),

    customerName: document.getElementById('customer-name'),
    customerEmail: document.getElementById('customer-email'),
    customerPhone: document.getElementById('customer-phone'),

    productName: document.getElementById('product-name'),
    productMaterial: document.getElementById('product-material'),
    productFinish: document.getElementById('product-finish'),
    productCapacity: document.getElementById('product-capacity'),
    productQty: document.getElementById('product-qty'),

    priceInquiryNote: document.getElementById('price-inquiry-note'),
    priceBase: document.getElementById('price-base'),
    priceDiscount: document.getElementById('price-discount'),
    priceExtra: document.getElementById('price-extra'),
    priceShipping: document.getElementById('price-shipping'),
    priceTax: document.getElementById('price-tax'),
    priceFinal: document.getElementById('price-final'),

    quoteNotes: document.getElementById('quote-notes'),
    btnPrint: document.getElementById('btn-print')
  };

  function showState(name) {
    els.loading.hidden = name !== 'loading';
    els.error.hidden = name !== 'error';
    els.content.hidden = name !== 'content';
  }

  function set(el, text) {
    el.textContent = text;
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
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '未提供';
    return d.toLocaleString('zh-Hant-TW', { hour12: false });
  }

  // 跟 admin.html 的 quoteVersionDisplayStatus() 同一套邏輯：只比較 validUntil 跟
  // 目前時間，每次渲染都重新算一次（不依賴 opener 傳來的、可能早就過時的舊狀態），
  // 確保「已過期」徽章永遠反映實際列印當下的真實狀態。
  function isExpired(validUntil) {
    if (!validUntil) return true;
    const d = new Date(validUntil);
    if (Number.isNaN(d.getTime())) return true;
    return d.getTime() < Date.now();
  }

  function render(payload) {
    const product = (payload && payload.productSnapshot && typeof payload.productSnapshot === 'object') ? payload.productSnapshot : {};
    const customer = (payload && payload.customerSnapshot && typeof payload.customerSnapshot === 'object') ? payload.customerSnapshot : {};
    const pricing = (payload && payload.pricingSnapshot && typeof payload.pricingSnapshot === 'object') ? payload.pricingSnapshot : {};

    showState('content');

    set(els.badgeVersion, textOrFallback(payload.versionLabel, '未提供'));
    els.badgeHistory.hidden = !!payload.isLatest;
    els.badgeExpired.hidden = !isExpired(payload.validUntil);

    set(els.quoteDate, formatDateTime(payload.createdAt));
    set(els.quoteValidUntil, formatDateTime(payload.validUntil));

    set(els.customerName, textOrFallback(customer.name, '未提供'));
    set(els.customerEmail, textOrFallback(customer.email, '未提供'));
    set(els.customerPhone, textOrFallback(customer.phone, '未提供'));

    set(els.productName, textOrFallback(product.name, '未提供'));
    set(els.productMaterial, textOrFallback(product.material, '未提供'));
    set(els.productFinish, textOrFallback(product.finish, '未提供'));
    set(els.productCapacity, textOrFallback(product.capacity, '未提供'));
    set(els.productQty, (product.qty === null || product.qty === undefined) ? '未提供' : textOrFallback(product.qty, '未提供') + ' 個');

    const priceOnInquiry = !!product.priceOnInquiry;
    els.priceInquiryNote.hidden = !priceOnInquiry;
    const priceFallback = priceOnInquiry ? '洽業務' : '未提供';
    set(els.priceBase, moneyOrFallback(pricing.baseAmount, priceFallback));
    set(els.priceDiscount, moneyOrFallback(pricing.discountAmount, priceFallback));
    set(els.priceExtra, moneyOrFallback(pricing.extraFee, priceFallback));
    set(els.priceShipping, moneyOrFallback(pricing.shippingFee, priceFallback));
    set(els.priceTax, moneyOrFallback(pricing.taxAmount, priceFallback));
    set(els.priceFinal, moneyOrFallback(pricing.finalTotal, priceFallback));

    set(els.quoteNotes, textOrFallback(payload.notes, '無'));

    document.title = '正式報價單_' + textOrFallback(payload.versionLabel, '');
  }

  let readyTimer = null;

  function announceReady() {
    if (!window.opener) {
      showState('error');
      return;
    }
    try {
      window.opener.postMessage({ type: 'quote-print-ready' }, location.origin);
    } catch (e) {
      // opener 不同源或已關閉：直接顯示失效畫面，不重試。
      showState('error');
    }
  }

  window.addEventListener('message', function (event) {
    if (event.origin !== location.origin) return;
    if (!window.opener || event.source !== window.opener) return;
    if (!event.data || event.data.type !== 'quote-print-data' || !event.data.payload) return;
    if (readyTimer) { clearInterval(readyTimer); readyTimer = null; }
    render(event.data.payload);
  });

  els.btnPrint.addEventListener('click', function () {
    window.print();
  });

  if (!window.opener) {
    showState('error');
  } else {
    // 開新視窗到 opener 真的收到並回傳資料之間可能有時間差（視窗還在載入、
    // opener 的訊息監聽器還沒掛上），持續小間隔重送 ready 訊號直到收到資料為止；
    // 最多等待 5 秒完全沒有回應才顯示失效畫面，避免載入中畫面無限期卡住。
    announceReady();
    readyTimer = setInterval(announceReady, 200);
    setTimeout(function () {
      if (readyTimer) {
        clearInterval(readyTimer);
        readyTimer = null;
        if (els.content.hidden) showState('error');
      }
    }, 5000);
  }
})();
