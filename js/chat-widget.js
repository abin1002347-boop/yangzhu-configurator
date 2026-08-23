// 楊竹科技 — 客服浮動視窗共用元件（landing.html／index.html 共用同一份，不各自維護一套）
//
// 網址不再寫死在 HTML 裡。iframe 的 src 只有在後端確認客服服務「真的可用」之後才會
// 被設定，來源只有兩支同源後端 API：
//   1. GET /api/chatbot-config — 讀取伺服器環境變數 CHATBOT_PUBLIC_URL，瀏覽器本來就
//      讀不到 Node.js 的 process.env，一定要透過這一層才能安全取得公開網址本身。
//   2. GET /api/chatbot-status — 伺服器端主動對 CHATBOT_PUBLIC_URL 做健康檢查（HTTP
//      2xx 才算可用），因為 iframe 是跨網域載入，前端的 onload 事件無法分辨對方到底
//      是正常頁面還是 Railway 的 404 頁——只靠 iframe load 事件本身測不出來。
// 兩支 API 都只回傳伺服器自己環境變數裡固定好的網址／可用狀態，使用者沒有任何管道
// 自己指定要檢查的網址，不會有 SSRF 風險。
(function () {
  var state = {
    status: 'idle',       // idle / connecting / ready / fallback
    configPromise: null
  };

  // 前端這裡的逾時只是最後一道保險（後端自己已經有 5~8 秒逾時，正常情況下一定會先
  // 回應），避免極端情況下連線整個吊死，畫面卡在「正在連接」動畫。
  var STATUS_FETCH_TIMEOUT_MS = 10000;

  function panelEl()       { return document.getElementById('chat-panel'); }
  function iframeEl()      { return document.getElementById('chat-iframe'); }
  function connectingEl()  { return document.getElementById('chat-connecting'); }
  function fallbackEl()    { return document.getElementById('chat-fallback'); }

  function showOnly(which) {
    var map = { connecting: connectingEl(), iframe: iframeEl(), fallback: fallbackEl() };
    Object.keys(map).forEach(function (key) {
      var el = map[key];
      if (!el) return;
      el.classList.toggle('hidden', key !== which);
    });
  }

  function fetchConfig() {
    if (state.configPromise) return state.configPromise;
    state.configPromise = fetch('/api/chatbot-config')
      .then(function (r) { return r.ok ? r.json() : { chatbotUrl: null }; })
      .catch(function () { return { chatbotUrl: null }; });
    return state.configPromise;
  }

  function fetchStatus() {
    var hasAbort = typeof AbortController !== 'undefined';
    var controller = hasAbort ? new AbortController() : null;
    var timer = hasAbort ? setTimeout(function () { controller.abort(); }, STATUS_FETCH_TIMEOUT_MS) : null;
    return fetch('/api/chatbot-status', hasAbort ? { signal: controller.signal } : undefined)
      .then(function (r) { return r.ok ? r.json() : { available: false }; })
      .catch(function () { return { available: false }; })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        return data;
      });
  }

  // 依序：顯示「正在連接」→ 讀取公開網址設定 + 健康檢查（兩支平行打） →
  // 兩者都成功才真的建立 iframe，任何一邊沒過（沒設定網址／健康檢查回報不可用／
  // 逾時／連線失敗）一律顯示備援維護畫面，不讓使用者看到 Railway 的 404 頁。
  function connect() {
    state.status = 'connecting';
    showOnly('connecting');
    Promise.all([fetchConfig(), fetchStatus()]).then(function (results) {
      var config = results[0] || {};
      var status = results[1] || {};
      var url = config.chatbotUrl;
      if (url && status.available) {
        var ifr = iframeEl();
        if (ifr) ifr.src = url;
        state.status = 'ready';
        showOnly('iframe');
      } else {
        state.status = 'fallback';
        showOnly('fallback');
      }
    });
  }

  window.toggleChat = function () {
    var panel = panelEl();
    if (!panel) return;
    if (panel.classList.contains('open')) {
      window.closeChat();
    } else {
      window.openChat();
    }
  };

  window.openChat = function () {
    var panel = panelEl();
    if (!panel) return;
    panel.classList.add('open');
    // 已經成功連上的對話不用每次開關都重來一次，維持既有對話內容；只有「還沒
    // 連過」或「上次失敗」才重新走一次連線流程。
    if (state.status === 'idle' || state.status === 'fallback') {
      connect();
    }
  };

  window.closeChat = function () {
    var panel = panelEl();
    if (panel) panel.classList.remove('open');
  };

  // 使用者在備援畫面主動點「重新載入」：不管目前狀態如何，強制重新跑一次連線流程。
  window.reloadChat = function () {
    var ifr = iframeEl();
    if (ifr) ifr.src = 'about:blank';
    connect();
  };
})();
