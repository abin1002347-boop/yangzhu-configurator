// 楊竹前台事件追蹤共用基礎（第一小步：只串接 page_view）。
// 對應後端 POST /api/analytics/events（見 server.js「分析事件基礎」章節）與
// 楊竹/後台資料庫/楊竹網站分析情報規劃書_合併版.md 第六節事件字典。
//
// 設計原則（全部圍繞同一件事：追蹤絕對不能影響網站本身的功能）：
// - 任何一步出錯（儲存被封鎖、fetch失敗、瀏覽器不支援API）都只能靜默放棄，
//   不丟出例外、不彈錯誤視窗、不阻塞頁面渲染或客製化／詢價流程。
// - 只送出後端規格明確允許的欄位；pagePath／landingPath 只送 location.pathname，
//   不送查詢字串或網址片段；不做 User-Agent 或任何形式的瀏覽器指紋辨識。
// - 只在這支檔案有被引入的公開前台頁面才會執行（目前只有 landing.html／index.html／
//   quote-confirmation.html 引入了這支檔案，後台頁面完全沒有引入）。
(function () {
  'use strict';

  var ENDPOINT = '/api/analytics/events';
  // 與 server.js 的 ANALYTICS_PAGE_PATH_WHITELIST 完全一致，前端先擋一次不合法路徑，
  // 避免明知道會被後端拒絕還發出請求；就算這裡漏了新頁面，後端仍然是最終防線。
  var PAGE_PATH_WHITELIST = ['/', '/customize', '/landing.html', '/index.html', '/quote-confirmation.html'];

  var VISITOR_ID_KEY = 'yz_analytics_visitor_id';       // localStorage：同一瀏覽器長期沿用
  var SESSION_ID_KEY = 'yz_analytics_session_id';       // sessionStorage：同一分頁工作階段沿用
  var SESSION_SOURCE_KEY = 'yz_analytics_session_source'; // sessionStorage：本次造訪來源，只在session開始時擷取一次

  var RETRY_DELAY_MS = 2000;
  var MAX_RETRY = 1; // 只重試1次，且沿用同一個clientEventId，避免真的送達卻被誤判成兩筆事件

  function safeGet(storage, key) {
    try { return storage.getItem(key); } catch (e) { return null; }
  }
  function safeSet(storage, key, value) {
    try { storage.setItem(key, value); } catch (e) { /* 無痕模式或容量限制，忽略即可 */ }
  }

  function generateUuid() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
    } catch (e) { /* 忽略，回傳null由呼叫端放棄本次追蹤 */ }
    return null;
  }

  function getOrCreateId(storage, key) {
    var existing = safeGet(storage, key);
    if (existing) return existing;
    var id = generateUuid();
    if (!id) return null;
    safeSet(storage, key, id);
    return id;
  }

  function getAnonymousVisitorId() {
    try { return getOrCreateId(window.localStorage, VISITOR_ID_KEY); }
    catch (e) { return null; }
  }
  function getSessionId() {
    try { return getOrCreateId(window.sessionStorage, SESSION_ID_KEY); }
    catch (e) { return null; }
  }

  function isWhitelistedPath(p) {
    return PAGE_PATH_WHITELIST.indexOf(p) !== -1;
  }

  // 只有跨網站的referrer才算「來源」；同網站內部導覽（例如landing.html點連結進到
  // index.html）不算外部來源，回傳null。
  function computeReferrerDomain() {
    try {
      if (!document.referrer) return null;
      var refUrl = new URL(document.referrer);
      if (refUrl.origin === window.location.origin) return null;
      return refUrl.hostname || null;
    } catch (e) {
      return null;
    }
  }

  // 本次造訪的來源（UTM、外部來源網域、到達頁）只在這個分頁工作階段第一次執行時擷取，
  // 之後同一個分頁裡的所有事件都沿用這份記錄——使用者從帶UTM參數的到達頁導覽到站內其他
  // 頁面後，網址通常已經不再帶著原始查詢參數，若不沿用就會遺失來源資訊。合併版文件的
  // 首次／最後來源是查詢時從完整事件歷史計算，不是靠這裡覆寫某個「目前來源」欄位，
  // 所以這裡只需要老實記錄「這個分頁工作階段真正看到的來源」即可。
  function getOrCreateSessionSource() {
    var existing = safeGet(window.sessionStorage, SESSION_SOURCE_KEY);
    if (existing) {
      try { return JSON.parse(existing); } catch (e) { /* 資料毀損，視為不存在，重新擷取 */ }
    }
    var params = null;
    try { params = new URLSearchParams(window.location.search); } catch (e) { /* 忽略 */ }
    var landingPath = window.location.pathname;
    var source = {
      utmSource: (params && params.get('utm_source')) || null,
      utmMedium: (params && params.get('utm_medium')) || null,
      utmCampaign: (params && params.get('utm_campaign')) || null,
      referrerDomain: computeReferrerDomain(),
      landingPath: isWhitelistedPath(landingPath) ? landingPath : null
    };
    safeSet(window.sessionStorage, SESSION_SOURCE_KEY, JSON.stringify(source));
    return source;
  }

  // deviceType／viewportGroup 都只依「目前可視寬度」判斷，跟 server.js 註解裡的固定斷點
  // 公式一致（narrow<768px；768~1279px是medium；>=1280px是wide），完全不解析User-Agent，
  // 避免變成瀏覽器指紋辨識的一種形式。
  function getViewportWidth() {
    return window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 0;
  }
  function detectDeviceType() {
    var w = getViewportWidth();
    if (w < 768) return 'mobile';
    if (w < 1280) return 'tablet';
    return 'desktop';
  }
  function detectViewportGroup() {
    var w = getViewportWidth();
    if (w < 768) return 'narrow';
    if (w < 1280) return 'medium';
    return 'wide';
  }

  function sendPayload(payload, attempt) {
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {
        // 只有「網路層真的送不出去」才重試，且沿用同一個payload（含同一個clientEventId），
        // 避免真的送達了卻因為重試又建立第二筆事件。後端驗證錯誤（4xx）不會拋到這個catch，
        // 那種情況重試也不會成功，所以不重試。
        if (attempt < MAX_RETRY) {
          setTimeout(function () { sendPayload(payload, attempt + 1); }, RETRY_DELAY_MS);
        }
      });
    } catch (e) {
      // fetch本身不存在或同步丟出例外（極舊瀏覽器），靜默放棄，不影響頁面其他功能。
    }
  }

  // 共用事件追蹤函式：eventName為後端事件字典裡的名稱，fields為該事件允許的頂層欄位
  // （＋metadata，若該事件有定義的話）。這一步只有page_view會呼叫它，但函式本身不限制
  // 事件名稱，供之後串接product_view等其他公開事件時直接沿用。
  function trackAnalyticsEvent(eventName, fields) {
    try {
      var visitorId = getAnonymousVisitorId();
      var sessionId = getSessionId();
      if (!visitorId || !sessionId) return; // 無法建立識別碼（儲存被封鎖等），放棄本次追蹤

      var clientEventId = (fields && fields.clientEventId) || generateUuid();
      if (!clientEventId) return;

      var payload = {
        clientEventId: clientEventId,
        eventName: eventName,
        occurredAt: new Date().toISOString(),
        anonymousVisitorId: visitorId,
        sessionId: sessionId
      };
      if (fields) {
        for (var key in fields) {
          if (!Object.prototype.hasOwnProperty.call(fields, key)) continue;
          if (key === 'clientEventId') continue; // 已經處理過，避免被下面覆寫成undefined
          if (fields[key] === undefined || fields[key] === null) continue; // 不送出空值鍵，交由後端schema判斷是否為必填
          payload[key] = fields[key];
        }
      }
      sendPayload(payload, 0);
    } catch (e) {
      // 追蹤程式本身發生任何未預期例外都不得影響頁面其他功能，安靜放棄即可。
    }
  }

  function trackPageView() {
    try {
      var pagePath = window.location.pathname;
      if (!isWhitelistedPath(pagePath)) return; // 不在白名單內的頁面一律不送出（含未來新增但尚未加入白名單的頁面）

      var source = getOrCreateSessionSource();
      trackAnalyticsEvent('page_view', {
        pagePath: pagePath,
        deviceType: detectDeviceType(),
        viewportGroup: detectViewportGroup(),
        landingPath: source.landingPath,
        referrerDomain: source.referrerDomain,
        utmSource: source.utmSource,
        utmMedium: source.utmMedium,
        utmCampaign: source.utmCampaign
      });
    } catch (e) {
      // 同上：page_view本身的擷取或送出失敗，不得影響頁面。
    }
  }

  // contact_click：電話／Email／LINE 這幾種「真的可以點擊、會離開頁面或喚起外部
  // App」的聯絡連結，用document層級的click事件委派偵測，一次涵蓋所有現有與未來
  // 新增的同類連結（頁首/頁尾電話、頁尾Email、詢價成功後才動態設定href的
  // #quote-mailto-link…），不用每個連結各自另外掛監聽器。只認href本身的協定／網域，
  // 不看元素id或所在頁面區塊，所以小竹客服的「href="#" onclick="openChat()"」
  // 天生不會被算進來（href不是tel:/mailto:，也不是可信LINE網域）。
  var LINE_TRUSTED_DOMAINS = ['line.me', 'lin.ee'];

  function isTrustedLineUrl(href) {
    try {
      var u = new URL(href, window.location.href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
      var host = u.hostname.toLowerCase();
      return LINE_TRUSTED_DOMAINS.some(function (d) {
        return host === d || host.slice(-(d.length + 1)) === ('.' + d);
      });
    } catch (e) {
      return false;
    }
  }

  // 只依連結本身的href判斷，不記錄href全文、電話號碼、Email地址或LINE帳號。
  function classifyContactLink(href) {
    if (!href) return null;
    if (href.indexOf('tel:') === 0) return 'phone';
    if (href.indexOf('mailto:') === 0) return 'email';
    if (isTrustedLineUrl(href)) return 'line';
    return null;
  }

  document.addEventListener('click', function (e) {
    try {
      var target = e.target;
      var anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
      if (!anchor) return;
      var contactType = classifyContactLink(anchor.getAttribute('href'));
      if (!contactType) return;
      var pagePath = window.location.pathname;
      if (!isWhitelistedPath(pagePath)) return; // 只在白名單頁面記錄，不阻擋連結本身的預設行為
      trackAnalyticsEvent('contact_click', { pagePath: pagePath, metadata: { contactType: contactType } });
    } catch (e) {
      // 追蹤本身出任何例外都不得影響連結原本的預設行為（不呼叫 preventDefault，這裡也不需要）。
    }
  });

  // 提供給之後步驟直接沿用的共用介面，這一步本身只呼叫trackPageView()並掛contact_click
  // 的委派監聽器，不會呼叫其他事件。
  window.YZAnalytics = {
    track: trackAnalyticsEvent,
    getAnonymousVisitorId: getAnonymousVisitorId,
    getSessionId: getSessionId
  };

  trackPageView();
})();
