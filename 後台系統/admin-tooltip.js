// 楊竹科技後台系統 — 全站共用「？」說明提示（Tooltip）元件
// 純HTML+CSS+JS實作（這個專案沒有用Vue／React等前端框架），不依賴任何外部套件或CDN。
// 用法：在標題後面加一顆問號按鈕 <button class="admin-help-icon" data-help-key="orders" aria-label="說明">?</button>，
// 或直接呼叫 adminHelpIconHtml('orders') 產生同樣的HTML字串。滑鼠移過或鍵盤Tab移入時淡入顯示說明；
// 觸控裝置點一下顯示、再點一下或點畫面其他地方關閉。

// ── 說明文案設定檔 ──────────────────────────────────────────
// 之後要新增或修改任何模組的說明文字，只需要改這個物件裡對應key的內容，
// 不需要動下面的元件邏輯，也不需要重新套用到每個頁面（HTML裡引用的是key，不是文字本身）。
const ADMIN_HELP_TEXT = {
  // ── 總覽（儀表板）模組 ──
  dashboardOverview: '顯示目前所選時間粒度（每天／每月／每季／每年）的訂單數與營收；待處理／製作中／預估逾期訂單則是目前實際的工作量快照，不受粒度切換影響。切換上方粒度選單或重新整理頁面就會抓最新資料。',
  dashboardTopProducts: '列出目前所選時間粒度（本期間）內銷售數量最高的前5項商品，方便判斷哪些產品線最受歡迎，作為生產排程與庫存準備的優先順序參考。',
  dashboardProductDistribution: '用圖表呈現目前所選時間粒度（本期間）內各商品線的訂單佔比，快速看出訂單集中在哪些產品，可以作為調整行銷資源或庫存策略的依據。',
  dashboardInventory: '顯示素材與半成品目前的庫存數量；低於安全庫存量的品項會特別標示提醒（低庫存預警），提醒同仁及早叫貨，避免生產排單時才發現缺料。',

  // ── 核心管理模組 ──
  orders: '管理所有客戶詢價與訂單，可依姓名／Email／商品／狀態篩選，逐筆更新訂單狀態（新詢價→已報價→已成交→⋯⋯→已完成）。可以封存不需要再處理的訂單、下載工廠包（給生產端使用的印刷檔與工單）。狀態原則上只能往下一步前進，取消或退回需要二次確認，避免手滑誤按。',
  products: '維護官網客製化配置器會用到的所有商品資料，包含名稱、材質、工藝、容量與數量折扣、上下架狀態。商品不會被真的刪除，只能封存（下架並從清單移除），需要時仍可還原。',
  customers: '依全部訂單的聯絡資訊自動彙總出的客戶清單（唯讀），可以看到每位客戶的累積消費金額、訂購次數與最後下單時間。同一人用不同Email或電話下單造成的重複資料，可以用「檢查重複客戶」功能手動合併。',
  analytics: '呈現網站訪客的行為數據，包含流量來源、進站頁面、裝置分布，以及客製化流程各步驟的完成與流失狀況，用來了解顧客從進站到詢價之間卡在哪個環節、AI功能實際被使用的情形。',

  // ── 進階與系統功能 ──
  siteSettings: '設定官網對外顯示的內容，例如首頁文案、聯絡資訊、客服浮動視窗等版面與文字，不會影響訂單或商品資料本身。',
  aiSettings: '設定官網AI客製化功能（例如智慧選色、文案建議）是否啟用、使用的模型與主要提示詞。這裡的調整會直接影響客人在官網上實際體驗到的AI功能行為，請謹慎修改並留意AI使用統計的變化。',
  aiUsage: '統計AI各項功能被呼叫的次數、成功率與錯誤原因，可以用來判斷AI功能是否穩定運作、是否接近用量上限，或需要調整限制設定。',
  systemSettings: '調整後台系統參數，並查看伺服器目前運作狀態（健康狀態、資料庫完整性、運行時間、維護模式等唯讀資訊）。僅擁有者可以使用這個頁面。',
  systemSettingsQuoteDefaultDays: '訂單詳情頁「發布新報價版本」表單開啟時預設帶入的有效天數（1～365天），只影響表單預設值，管理員仍可在發布當下自行調整成其他天數；已發布的報價版本不會因為之後修改這裡而改變。',
  systemSettingsDbIntegrity: '資料庫檔案結構是否正常（SQLite的PRAGMA integrity_check）。這項檢查會掃描整個資料庫檔案，成本較高，不會每次打開頁面就自動執行，需要手動按下「重新檢查」才會真的檢查一次；伺服器重新啟動後會回到「尚未檢查」狀態。',
  adminUsers: '管理正式登入後台的管理員帳號，包含新增帳號、調整角色（擁有者／管理者／一般員工／唯讀）、停用帳號與重設密碼。僅擁有者可以使用這個頁面，且系統一定會保留至少一位啟用中的擁有者，避免整個後台被鎖死。',
  auditLog: '記錄所有後台的重要操作（登入登出、資料新增修改刪除、狀態變更、檔案下載等），可依結果、資源類型與日期查詢。這份紀錄只能查看，沒有修改或刪除功能，確保紀錄不會被事後竄改。',
  dbBackup: '手動建立資料庫與訂單資料的完整備份（商品、客戶、帳號、分析資料及全部訂單），可下載保存或刪除舊備份。「隔離驗證」會把備份還原到系統背後獨立的測試位置檢查完整性與筆數，不會覆蓋正式資料。「正式還原」會真正覆蓋正式資料庫與訂單資料夾，需要重新輸入密碼並輸入備份識別碼確認，只能還原通過隔離驗證的完整備份；執行後系統會進入維護模式，需要工程人員重新啟動伺服器才能恢復服務，請務必謹慎使用。僅擁有者可以使用這個頁面。',
  notificationCenter: '集中顯示新詢價、低庫存、客戶接受／拒絕報價、資料庫備份或還原失敗等重要事件的後台通知，可依全部／未讀／已讀篩選、單筆或全部標記已讀。這裡只顯示「後台看到的通知」，是否同時透過Email或LINE發送則由「通知設定」頁面決定。',
  notificationSettings: '設定Email與LINE兩個外部通知管道是否已完成設定，並依事件類型選擇要透過哪些管道發送。SMTP密碼與LINE Token只能在伺服器環境變數修改，這裡只能查看「已設定／未設定」狀態；提供測試通知功能，會實際透過目前已設定的管道發送測試訊息。僅擁有者可以修改設定或送出測試通知，管理者可以查看目前設定。'
};

// 產生一顆問號說明圖示的HTML字串，套用到頁面標題旁邊。key要對應ADMIN_HELP_TEXT裡的欄位；
// 找不到對應文案時仍會顯示圖示但內容是空的，方便開發時先卡位、之後再補文案。
function adminHelpIconHtml(key) {
  return `<button type="button" class="admin-help-icon" data-help-key="${key}" aria-label="說明">?</button>`;
}

// ── 元件邏輯：事件代理＋單一共用氣泡框 ──────────────────────
// 不是每顆問號各自建立一個氣泡DOM，而是全站共用同一個，滑鼠/焦點移到哪顆問號上就顯示對應
// 文字並移動位置——元素數量再多也只有一個氣泡在DOM裡，效能較好也比較好維護。
(function () {
  let bubble = null;
  let activeIcon = null;
  let hideTimer = null;

  function ensureBubble() {
    if (bubble) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'admin-help-bubble';
    bubble.setAttribute('role', 'tooltip');
    document.body.appendChild(bubble);
    return bubble;
  }

  // 預設顯示在問號正下方置中；量出氣泡實際寬高後，依視窗邊界自動水平/垂直修正，
  // 避免貼著螢幕邊緣被裁掉（下方空間不夠就改顯示在上方，箭頭方向跟著換）。
  function positionBubble(icon) {
    const b = ensureBubble();
    const rect = icon.getBoundingClientRect();
    const bw = b.offsetWidth, bh = b.offsetHeight;
    const margin = 8;
    let left = rect.left + rect.width / 2 - bw / 2;
    let top = rect.bottom + 8;
    let arrow = 'top';
    if (left < margin) left = margin;
    if (left + bw > window.innerWidth - margin) left = window.innerWidth - margin - bw;
    if (top + bh > window.innerHeight - margin && rect.top - bh - 8 > margin) {
      top = rect.top - bh - 8;
      arrow = 'bottom';
    }
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    b.dataset.arrow = arrow;
    const arrowLeft = Math.max(12, Math.min(bw - 12, rect.left + rect.width / 2 - left));
    b.style.setProperty('--admin-help-arrow-left', arrowLeft + 'px');
  }

  function showTooltip(icon) {
    const text = ADMIN_HELP_TEXT[icon.dataset.helpKey];
    if (!text) return;
    clearTimeout(hideTimer);
    activeIcon = icon;
    const b = ensureBubble();
    b.textContent = text;
    positionBubble(icon);
    requestAnimationFrame(() => b.classList.add('visible'));
  }

  function hideTooltip() {
    if (bubble) bubble.classList.remove('visible');
    activeIcon = null;
  }

  // 用pointerover／pointerout（而不是mouseover／mouseout）並限定pointerType==='mouse'，
  // 是因為觸控點按鈕時瀏覽器為了相容舊網站，也會補發一組合成的滑鼠事件（mouseover／
  // mousedown／mouseup／click）；如果hover邏輯照單全收，會跟下面click的顯示/隱藏切換邏輯
  // 互相打架——實測會出現「觸控點一下，氣泡顯示後100毫秒內又被自己的滑鼠事件關掉」的
  // 情況。PointerEvent能明確分辨這次事件是真的滑鼠、觸控還是觸控筆，只讓真滑鼠觸發hover。
  document.addEventListener('pointerover', e => {
    if (e.pointerType !== 'mouse') return;
    const icon = e.target.closest('.admin-help-icon');
    if (icon) showTooltip(icon);
  });
  document.addEventListener('pointerout', e => {
    if (e.pointerType !== 'mouse') return;
    const icon = e.target.closest('.admin-help-icon');
    if (icon && !icon.contains(e.relatedTarget)) hideTimer = setTimeout(hideTooltip, 100);
  });
  // 鍵盤操作（Tab移入/移出）也要能看到說明，不是只有滑鼠使用者。用:focus-visible判斷，
  // 只在「看起來像鍵盤導覽」的focus才觸發——觸控裝置點按鈕時，瀏覽器也會讓按鈕短暫取得
  // 焦點又立刻失焦，如果這裡對所有focus/blur一視同仁，會跟下面click的顯示/隱藏邏輯互相
  // 打架（點一下→click顯示→緊接著的blur又把它關掉，變成完全看不到）。用一個變數記住
  // focusin當下判斷的結果，focusout時套用同一個結果，避免:focus-visible在blur當下
  // 讀不到的邊界情況。
  let iconWasFocusVisible = false;
  document.addEventListener('focusin', e => {
    const icon = e.target.closest('.admin-help-icon');
    if (!icon) return;
    iconWasFocusVisible = icon.matches(':focus-visible');
    if (iconWasFocusVisible) showTooltip(icon);
  });
  document.addEventListener('focusout', e => {
    if (e.target.closest('.admin-help-icon') && iconWasFocusVisible) hideTooltip();
  });
  // 觸控裝置沒有hover，改成點擊切換顯示／隱藏；點畫面其他地方會關閉。
  document.addEventListener('click', e => {
    const icon = e.target.closest('.admin-help-icon');
    if (icon) {
      e.preventDefault();
      if (activeIcon === icon && bubble && bubble.classList.contains('visible')) {
        hideTooltip();
      } else {
        showTooltip(icon);
      }
      return;
    }
    if (!e.target.closest('.admin-help-bubble')) hideTooltip();
  });
  // 滾動或縮放視窗時，氣泡要跟著問號的新位置移動，不然會飄在錯誤的地方。
  window.addEventListener('scroll', () => { if (activeIcon) positionBubble(activeIcon); }, true);
  window.addEventListener('resize', () => { if (activeIcon) positionBubble(activeIcon); });
})();
