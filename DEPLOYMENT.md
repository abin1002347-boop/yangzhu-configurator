# 部署說明（DEPLOYMENT.md）

本文件只說明「怎麼部署、怎麼設定」，不包含任何真實的 API Key、Token、密碼或客戶個資。
所有變數名稱請對照 `.env.example`，實際的值只存在你自己的 `.env`（不會、也不應該被提交進版本控制）。

---

## 0. 重要：正式資料的永久保存（選擇部署平台前必讀）

這個專案是「單一 Node 進程＋本機檔案系統」架構，沒有使用外接雲端資料庫或雲端物件儲存服務。
所有正式資料都是直接寫在伺服器所在主機的磁碟上，`NODE_ENV=production` 時全部集中在單一的
**`APP_DATA_DIR`（永久資料根目錄）** 底下（路徑解析邏輯統一在 `app-data-paths.js`，
`db.js`／`server.js`／`admin-routes.js` 都從這裡取得路徑，不會各自寫一份）：

| 內容 | `APP_DATA_DIR` 底下的路徑 |
|---|---|
| SQLite 主資料庫（商品、庫存、管理員帳號、系統設定、稽核紀錄等） | `APP_DATA_DIR/admin.db`（含 `-wal`／`-shm`） |
| 資料庫備份檔 | `APP_DATA_DIR/backups/` |
| 正式訂單 JSON＋客戶上傳的設計圖 | `APP_DATA_DIR/orders/` |
| 工廠下載包 | `APP_DATA_DIR/factory-packages/` |
| 後台商品圖片上傳（既有 `/assets/uploads/products/檔名` 對外網址格式不變） | `APP_DATA_DIR/product-uploads/` |

如果部署平台是「每次部署都用全新容器、重啟後檔案系統會還原成映像檔原始狀態」的無狀態
（stateless）架構——多數主流 PaaS（Railway／Render／Heroku 等）的**預設**容器行為就是如此
——上面這些資料會在**每一次重新部署或容器重啟後被清空歸零**，不是效能或設定問題，是架構上
一定會發生的資料遺失。

上線前必須先確認以下其中一種方案，兩者擇一，不能跳過：

1. **部署平台提供「持久化磁碟／Volume」功能**，並且把它掛載到 `APP_DATA_DIR` 這一個路徑
   （例如 Railway 的 Volume、Render 的 Persistent Disk）。因為五類資料現在集中在同一個
   根目錄底下，**只需要掛載這一個路徑**，不必像分散式設計那樣一次掛載五個不同資料夾——
   這是這批修改的主要目的，解決了「部分平台一個服務只提供單一掛載點」的限制。
2. **改用真正的持久化主機**（例如一般 VPS、自有伺服器），資料本來就寫在主機自己的磁碟上，
   不受「重新部署」影響，只要不重灌系統或格式化磁碟即可。

`NODE_ENV=production` 時，`APP_DATA_DIR` 是**必填**環境變數：未設定、不是絕對路徑、或設定
成磁碟根目錄／專案原始碼根目錄，伺服器會在碰到任何資料庫讀寫之前就直接拒絕啟動，不會、
也不可能悄悄退回到專案目錄內的其他路徑。

**目前正式 3777 現況**：目前實際執行中的正式服務是在沒有設定 `NODE_ENV=production` 的模式下
啟動（`development` 分支），使用的是修改前就存在的舊路徑（`後台資料庫/admin.db`、
`訂單資料/`、`factory-packages/`、`assets/uploads/products/`）——這批修改刻意讓
`development` 分支的路徑判斷維持原樣不變，不會影響目前正式服務的行為。**只有將來明確把
正式服務改成 `NODE_ENV=production` 啟動時，才會需要／用到 `APP_DATA_DIR`。**

### 本機資料與遠端永久磁碟的差異（部署平台選定前必讀）

`scripts/prepare-deploy-data.js` 的 `--dest=` 只是把「來源路徑」複製到「目的地路徑」，兩者
都必須是**執行這支腳本的那台機器能直接用檔案系統路徑存取到的位置**：

1. `--dest=/data` 這種寫法，只有在來源資料（`後台資料庫/`、`訂單資料/` 等）跟 `/data`
   能被**同一台主機或容器同時存取**時才能直接使用——例如在同一台自有主機／VPS 上操作，
   或本機額外掛載了一顆外接／網路磁碟到 `/data`。
2. Railway、Render 等遠端 PaaS（雲端部署平台）提供的「永久磁碟／Volume」，通常**無法直接
   讀取使用者這台開發電腦裡的資料**——遠端容器看得到的，只有它自己容器內的檔案系統，看不到
   你這台 Windows 電腦上的 `後台資料庫/`、`訂單資料/`。在遠端容器內執行
   `prepare-deploy-data.js --dest=/data`，`/data` 確實是遠端的持久化磁碟沒錯，但腳本預設
   讀取的來源路徑（或 `--src-*-dir` 指定的路徑）仍然只會指向那個容器自己的檔案系統，不會
   自動讀到這台電腦上的檔案。
3. 選定部署平台後，需要另外依該平台支援的方式規劃「安全上傳」流程，可能的做法包括：
   - 先在本機執行 `prepare-deploy-data.js --dest=<本機或區網暫存路徑> --execute
     --confirm-source-stopped`，產生一份已經通過完整性與逐檔 SHA-256 驗證的資料包；
   - 再透過該平台支援的受保護管道（例如 SSH／SFTP 傳輸、平台自帶的資料匯入工具、或該
     平台官方文件建議的方法）把這份資料包傳到遠端永久磁碟。
   實際指令依平台而定，選定平台後需要另外撰寫該平台專用的傳輸步驟。
4. 不論用哪種方式傳輸，**不得**把包含客戶資料、管理員帳號雜湊等敏感內容的遷移資料放到
   公開網址、公開 Git 儲存庫，或未加保護（例如公開分享連結）的雲端空間。
5. 在部署平台尚未選定前，本文件**不假設**任何一定可用的遠端上傳指令，也不會寫死特定平台的
   CLI 指令，避免文件內容跟實際選用的平台不符卻誤導操作者直接照做。
6. 真正部署時，需要另外確認該平台的永久磁碟掛載方式，以及符合該平台安全建議的傳輸方法，
   確認後再補上該平台專屬的操作步驟。

### 第一次改用 APP_DATA_DIR 部署（資料搬遷）

**正式遷移前必須先完成第3、4步「讓來源真正停止寫入」，下面第5步的 `--confirm-source-stopped`
只是操作者對這件事的人工確認，程式本身在發布前還會自動重新核對來源是否真的沒有變動，但兩者
都不能單獨保證安全——來源沒有真的停寫，程式的自動核對只能「事後抓到」，無法「事先避免」。**

1. **先公告短暫維護時間**，讓還在使用中的客人與後台同事知道即將有一段時間無法下單／操作。
2. **先完成 dry-run**，確認來源／目的地／筆數正確，此步驟不需要 `--confirm-source-stopped`、
   也完全不會寫入任何檔案：
   ```bash
   node scripts/prepare-deploy-data.js --dest=/data
   ```
3. **真正切換時，停止舊 3777（或讓它進入可靠的全站停寫狀態）**——確保沒有任何寫入路徑
   仍然開放（例如維護模式頁面，或直接停掉舊服務的進程）。
4. **確認舊服務不再接受前台訂單、也不再接受後台任何會修改資料庫或檔案的操作**（新增商品、
   上傳圖片、修改設定、發布報價等）。
5. **執行正式遷移**：
   ```bash
   node scripts/prepare-deploy-data.js --dest=/data --execute --confirm-source-stopped
   ```
   `--confirm-source-stopped` 代表操作者已經完成第3、4步；缺少這個參數，`--execute` 會在
   建立任何目的地或暫存資料**之前**就直接拒絕、回傳非0結束碼。即使加了這個參數，腳本在正式
   發布前仍會：(a) 重新遞迴掃描訂單／工廠包／商品上傳圖片／備份四類來源資料、重新計算
   SHA-256，跟初次掃描時的快照逐項比對；(b) 用同一條資料庫連線重新讀取
   `PRAGMA data_version`，跟遷移開始時讀到的值比對。只要偵測到來源在這段期間有任何新增、
   刪除、內容變化，或資料庫被其他連線寫入過，會自動中止發布、清除暫存區、回傳非0結束碼——
   但這只是最後一道自動化防線，不能取代第3、4步真正把來源停下來，因為最後一次檢查之後仍
   可能存在極短的時間差。
   腳本會在複製前檢查來源資料庫 `integrity_check`，用 SQLite 官方 Online Backup API 複製
   資料庫（不是直接複製運作中的 `admin.db` 主檔）。訂單、工廠包、商品上傳圖片、以及既有的
   資料庫備份（`後台資料庫/backups/`，若有）四類資料都會**遞迴掃描所有子資料夾**（工廠包
   實際結構是 `factory-packages/<訂單編號>/...` 多層目錄，只看第一層會漏掉大部分內容）；
   複製時先寫入本工具自建的暫存區，逐檔比對相對路徑、檔案大小、SHA-256 雜湊值全部一致後才
   會發布到最終位置，**不是只比對檔案數量**，任一步驟失敗只會清除暫存區、不留下半套資料。
   目的地任一最終位置（含子資料夾深處）已經有資料時會直接拒絕、不覆蓋。來源內如果出現符號
   連結（symlink）或目錄連結（junction），會直接拒絕遷移，避免複製範圍被連結導向來源以外
   的地方。
6. **遷移成功**（工具回報「複製完成，來源與目的地資料一致」、結束碼0）之後，才啟動新的
   `NODE_ENV=production` 服務——確認 `.env`（或部署平台的環境變數設定）已經有
   `NODE_ENV=production` 與 `APP_DATA_DIR=/data`，以及其他必要變數（見第 4 節）。
7. **啟動後驗證**：`/api/health` 回應正常、管理員可以正常登入、商品數量正確、訂單數量正確、
   工廠包可以正常下載、既有商品圖片網址（`/assets/uploads/products/檔名`）可以正常讀取。
8. **新服務確認一切正常之前，保留原始（舊）資料，不得刪除**——遷移工具本身也從不刪除來源，
   這裡是額外提醒操作者自己也不要手動清除舊資料夾。
9. **如果新服務啟動失敗或驗證未通過**，依第 12 節「正式上線後的回滾方式」復原，改回啟動
   舊服務；因為來源資料完整保留，回滾不會造成資料遺失。

### 後續每次重新部署

只要 `APP_DATA_DIR` 掛載的持久化磁碟沒有變動，重新部署（更新程式碼）不需要重複執行資料
搬遷步驟——磁碟內容會原封不動保留，`db.js` 的資料表異動一律用 `CREATE TABLE IF NOT EXISTS`
與 `PRAGMA table_info` 檢查後才 `ALTER TABLE`，可重複執行、不會刪除既有資料。

---

## 1. Node.js 建議版本

建議 **Node.js 20 LTS 以上**（`package.json` 已設定 `engines.node: ">=20"`）。
本機開發與測試環境實測版本為 v24。

專案使用了 `better-sqlite3`、`sharp` 兩個原生編譯模組，部署平台需要能正常執行
`npm install` 的原生模組編譯（多數主流 Node.js 容器平台如 Railway／Render 都支援）。**部署
平台必須自己重新執行 `npm install`，不能只是把本機（Windows）已經裝好的 `node_modules`
原封不動複製過去**——這兩個模組是平台相關的原生二進位檔，Windows 編譯出來的檔案在 Linux
容器上無法執行。

---

## 2. 部署必要檔案清單（2026-08-23 依 Git 追蹤狀態盤點）

如果採用「連接 Git 儲存庫」的部署方式（例如 Railway／Render 直接接 GitHub），遠端只會拿到
**已經被 Git 追蹤的檔案**。目前這個專案的工作目錄裡有大量測試草稿、截圖、暫存資料夾，
**不能整批 `git add -A` 一次全部加入**，必須明確篩選過。以下依「必要」與「禁止」分兩份清單。

### 必要（部署上線必須存在，否則伺服器無法啟動或功能不完整）

| 類別 | 檔案／資料夾 | 目前 Git 追蹤狀態（2026-08-23 盤點） |
|---|---|---|
| 伺服器核心 | `server.js` | 已追蹤 |
| 資料庫與資料路徑 | `db.js`、`app-data-paths.js` | **未追蹤**（`db.js`）／新檔案（`app-data-paths.js`，需要本批一併加入） |
| 後台 API 與權限 | `admin-routes.js`、`admin-rbac.js` | **未追蹤** |
| 通知系統 | `notification-service.js`、`notification-channels.js`、`notification-worker.js` | **未追蹤** |
| 報價／訂單相關 | `quote-version.js`、`quote-public-access.js`、`quote-customer-response.js` | **未追蹤** |
| 庫存／維護模式／匯出 | `inventory-deduction.js`、`low-stock-notify.js`、`maintenance-mode.js`、`xlsx-export.js`、`pricing-adjustment.js` | **未追蹤** |
| 部署資料準備工具 | `scripts/prepare-deploy-data.js`、`scripts/smoke-test.js`、`scripts/form-test.js` | **未追蹤**（整個 `scripts/` 資料夾） |
| 前台頁面 | `landing.html`、`index.html`、`privacy.html`、`quote-confirmation.html`、`quote-print.html`、`404.html` | 部分已追蹤（`landing.html`／`index.html`），其餘**未追蹤** |
| 後台頁面 | `admin.html`＋整個 `後台系統/` 資料夾（14 個頁面） | `admin.html` 已追蹤，**`後台系統/` 整個資料夾未追蹤** |
| 前端程式與樣式 | 整個 `js/`、整個 `css/`、`assets/`（不含 `assets/uploads/`，那是正式資料，見下方禁止清單） | 部分已追蹤，`js/` 有 9 個檔案、`css/` 有 2 個檔案未追蹤（見下方明細） |
| 套件設定 | `package.json`、`package-lock.json` | 已追蹤 |
| 環境變數範例 | `.env.example` | 已追蹤（本批已更新內容） |
| 部署文件 | `DEPLOYMENT.md`（本檔案） | **未追蹤** |

**目前確認未被 Git 追蹤、但部署必要的明細**：
- `js/`：`analytics-tracker.js`、`black-card-finish.js`、`chat-widget.js`、`draft-store.js`、`product-service.js`、`quote-confirmation.js`、`quote-print.js`、`quote-total-resolver.js`、`site-content.js`
- `css/`：`quote-confirmation.css`、`quote-print.css`
- `後台系統/`：整個資料夾（`admin-common.js`、`admin-nav.js`、`admin-tooltip.js`、`admin-style.css`，以及 dashboard／products／customers／site-settings／system-settings／ai-settings／ai-usage／analytics／users／audit／db-backup／notifications／notification-settings／coming-soon 共 14 個頁面）
- `scripts/`：整個資料夾

**這代表：如果現在直接用 Git 連接式部署，遠端會缺少 `server.js` 執行時需要的多個模組
（`require('./db')`、`require('./admin-routes')` 等），伺服器無法啟動。** 上線前必須先把
上面「未追蹤」的檔案明確加入 Git（依前面已 review 過的內容個別 `git add`，不要用 `-A`／`.`
整批加入，避免連測試暫存檔一起加進去），這件事本批**沒有**代為執行（見下方禁止清單與
「本批不執行 git add／commit／push」的限制）。

### 禁止部署／禁止加入 Git 的內容

| 類別 | 內容 | 目前狀態 |
|---|---|---|
| 環境變數與金鑰 | `.env` | 已在 `.gitignore`，確認未被追蹤過 |
| 正式資料庫 | `後台資料庫/`（含 `admin.db`）、未來的 `data/`／`APP_DATA_DIR` 內容 | 已在 `.gitignore` |
| 正式訂單 | `訂單資料/` | 已在 `.gitignore` |
| 工廠包 | `factory-packages/` | 已在 `.gitignore` |
| 商品上傳圖片 | `assets/uploads/` | 已在 `.gitignore` |
| 測試草稿與暫存 | `_tmp_*.js`、`.audit_shots/`、`.audit_findings.txt`、`Users...scratchpad*` 系列殘留檔、`_tmp_backup_api_test_dst.db-*` | 目前皆為未追蹤的工作目錄雜項，不應該被加入 |
| 客戶個資、API Key、Token、密碼 | 任何形式（程式碼、文件、測試檔案） | `DEPLOYMENT.md` 第 11 節已有金鑰外洩檢查方式 |

若之後要正式把「必要清單」的檔案加入 Git，建議先確認 `.gitignore` 已經涵蓋上面「禁止」清單
的每一項，再用明確的檔案／資料夾路徑（不是 `-A` 或 `.`）逐一 `git add`，加入後跑一次
`git status` 確認沒有意外帶入不該有的檔案。

---

## 3. 安裝方式

```bash
npm install
```

---

## 4. 必要與選用環境變數

複製 `.env.example` 為 `.env`，依照下面分類決定要不要填：

### 影響功能是否可用（沒有不會讓伺服器啟動失敗，但對應功能會停用或降級）

| 變數 | 沒有設定時會怎樣 |
|---|---|
| `OPENAI_API_KEY` | AI 生圖／AI 文字設計功能停用，其餘客製化、報價、詢價功能不受影響 |
| `ADMIN_TOKEN` | 只在後台管理員帳號資料表是空的（全新安裝）時用來建立第一位管理員；已有管理員帳號的環境不需要 |
| `ADMIN_CSRF_SECRET` | 自動使用僅限本次執行期間的隨機密鑰，可正常運作，但每次重啟伺服器所有人都要重新登入後台 |

> production 環境有一個例外會直接拒絕啟動：**沒有任何啟用中的管理員帳號，又沒有設定 `ADMIN_TOKEN`**——這代表上線後沒有人能登入後台，伺服器會在啟動時印出明確訊息並拒絕啟動。

### 視功能是否啟用才需要

| 變數 | 用途 |
|---|---|
| `CHATBOT_PUBLIC_URL` | 小竹 AI 客服 iframe 的外部服務網址；未設定時客服視窗顯示「維護中」畫面 |
| `LINE_CHANNEL_ACCESS_TOKEN`／`LINE_NOTIFICATION_TARGET_ID` | 新詢價單、客戶接受／拒絕報價等事件推播到 LINE（LINE Messaging API push message，兩項都要填才算已設定）；未設定就不推播，訂單仍正常寫入。舊版 LINE Notify（`LINE_NOTIFY_TOKEN`）已停止服務，不再支援 |
| `ADMIN_ALLOWED_ORIGINS` | 需要從「另一個網域」呼叫後台 API 時才要設定；未設定＝只允許同源請求（最嚴格、最安全的預設值） |
| `ADMIN_COOKIE_SECURE` | 後台登入 Cookie 是否要求 HTTPS；未設定會依請求是否為 HTTPS 自動判斷 |
| `TRUST_PROXY_HOPS` | 部署在反向代理（Railway／Render／Cloudflare 等）後方時，依實際代理層數設定 1～3；格式錯誤會直接拒絕啟動 |
| `ADMIN_BOOTSTRAP_USERNAME` | 第一位管理員帳號的帳號名稱，未設定預設 `owner` |
| `AI_RATE_LIMIT_SECRET` | AI 使用次數限制的雜湊密鑰，未設定會暫時借用 `ADMIN_TOKEN` |
| `PORT` | 監聽埠號，未設定預設 3000；多數部署平台會自動注入這個變數 |

### 本次部署準備新增的變數

| 變數 | 用途 | 正式環境限制 |
|---|---|---|
| `NODE_ENV` | `production` 或留空／`development` | 正式部署務必設為 `production` |
| `APP_DATA_DIR` | `NODE_ENV=production` 時，資料庫／備份／訂單／工廠包／商品上傳圖片的永久資料根目錄絕對路徑 | `NODE_ENV=production` 時**必填**；未設定、不是絕對路徑、或設為磁碟根目錄／專案原始碼根目錄，會在任何資料庫讀寫之前直接拒絕啟動。詳見上方第 0 節 |
| `CSP_ENFORCE` | `true` 才會把 CSP 從 Report-Only 切成正式強制模式 | 見下方第 9 節，未完成瀏覽器回歸前不要設 |
| `FORM_TEST_MODE` | `true` 時詢價表單不會寫入真正訂單、不會通知業務，只回傳模擬成功結果 | **production 絕對不能設為 true**，伺服器啟動時會主動檢查並拒絕啟動 |

---

## 5. 本機啟動方式

```bash
npm run dev
```

等同 `node server.js`，會讀取專案根目錄的 `.env`。預設監看 `http://localhost:3000`
（或 `.env` 裡設定的 `PORT`）。

---

## 6. production 啟動方式

```bash
NODE_ENV=production npm start
```

部署平台通常會自動設定 `NODE_ENV=production` 並執行 `npm start`（對應 `node server.js`），
依平台介面設定環境變數即可，不需要額外指令。

啟動時終端機會印出環境變數檢查結果：只會列出「缺少哪個變數名稱」，不會印出任何變數的值。

---

## 7. `/api/health` 檢查方式

```bash
curl https://你的網域/api/health
```

正常回應：

```json
{"status":"ok","service":"yangzhu-customizer","time":"2026-01-01T00:00:00.000Z"}
```

HTTP 200。若資料庫無法讀取會回傳 HTTP 503（`{"status":"error","service":"yangzhu-customizer"}`），
可以接到部署平台的健康檢查機制，讓平台自動判斷這個部署是否存活。

---

## 8. 正式網域設定後要填寫的位置

目前專案還沒有寫死任何正式網域，以下是網域確定後需要更新的地方：

- 部署平台的自訂網域設定（依平台介面操作）
- 若之後要加上 `canonical`／`og:url`（目前刻意先略過，見專案內先前的 SEO 整理紀錄），
  屆時可以新增一個 `SITE_URL` 環境變數並在頁面 `<head>` 動態輸出，不建議寫死在 HTML 裡
- `ADMIN_ALLOWED_ORIGINS`：如果後台 API 需要被「另一個網域」的前端呼叫（目前是同源架構，
  通常不需要），才需要把正式網域加進這個白名單
- 後台「網站內容設定」頁面裡的聯絡資訊（電話／Email／頁尾文字），這些是資料庫內容，
  跟環境變數無關，透過後台介面調整即可

---

## 9. `CSP_ENFORCE` 啟用前的檢查步驟

目前 Content-Security-Policy 是 Report-Only（只回報違規、不封鎖），這是安全的預設值。

**目前已知會被正式 CSP 擋下的既有寫法**（尚未處理，貿然開啟 `CSP_ENFORCE=true` 會直接讓
這些功能壞掉）：

- `index.html` 實測約 93 處行內 `onclick` 屬性，`landing.html` 另有約 13 處
- `index.html` 實測約 76 處行內 `style` 屬性
- `index.html` 有 4 個行內 `<script>` 區塊（多半是頁面初始化呼叫）

CSP 目前的白名單本身已經盤點過整個專案的合法來源（本站資源、Google Fonts、`data:`／
`blob:` 圖片、同源 API、小竹客服 iframe 的 `CHATBOT_PUBLIC_URL`），刻意沒有加入
`unsafe-inline` 或 `unsafe-eval`（加了等於失去 CSP 大部分的防護意義），所以要正式啟用前，
必須先把上面這些行內寫法遷移掉：

1. 把 `onclick="xxx()"` 改成在對應 JS 檔案裡用 `addEventListener` 綁定
2. 把行內 `style="..."` 改成 CSS class
3. 把行內 `<script>` 區塊搬到獨立的 `.js` 檔案，用 `<script src="...">` 載入

**建議遷移完成、且不再有 Report-Only 違規回報後**，照這個順序啟用：

1. 先在非 production 環境（本機或 staging）設定 `CSP_ENFORCE=true` 測試
2. 完整跑過一次瀏覽器回歸：首頁、配置器（含選商品／規格／設計／AI 生圖／3D 預覽）、
   隱私權政策、客服 iframe 開關、後台登入
3. 確認 Console 沒有新增的 CSP 違規訊息
4. 才在 production 環境設定 `CSP_ENFORCE=true`

---

## 10. `FORM_TEST_MODE` 的限制

- 只能在非 production 環境使用（`NODE_ENV` 不是 `production`）
- production 環境設定 `FORM_TEST_MODE=true` 會被伺服器啟動檢查擋下，直接拒絕啟動
- 開啟後 `/api/save-order` 不會寫入真正的訂單檔案、不會呼叫 LINE 通知，只回傳格式一致
  （多一個 `testMode:true` 欄位）的模擬成功結果
- 前台詢價表單頁面（Step 5）會顯示明確的橫幅：「測試模式，不會送出正式詢價」
- 用完記得關閉（移除這個環境變數或設為 `false`），避免忘記關掉導致正式環境也不小心開著

---

## 11. 如何確認沒有提交 `.env`

```bash
git status --short .env      # 應該沒有任何輸出（代表沒有被追蹤或修改）
git ls-files | grep '^\.env$'  # 應該沒有任何輸出（代表從未被 git 追蹤過）
cat .gitignore | grep '^\.env$'  # 應該看到 .env 這一行
```

提交前的最後防線：`.gitignore` 已經包含 `.env`；`.env.example` 只放變數名稱與空白／安全
範例值，不含任何真實金鑰。若要額外確認整個專案沒有疑似外洩的金鑰，可以搜尋
`sk-proj-` 或 `sk-` 開頭的長字串（排除 `.env`、`node_modules`、圖片與資料庫檔案）。

---

## 12. 正式上線後的回滾方式

這個專案目前是單一 Node 進程＋本機 SQLite 資料庫（`data/admin.db`）＋本機檔案系統存放
訂單與工廠包資料，沒有使用需要額外遷移步驟的雲端資料庫服務，回滾相對單純：

1. **程式碼回滾**：部署平台通常支援「回到上一次成功部署」（依平台介面操作，例如
   Railway／Render 的 Deployments 頁面選擇舊版本重新部署）。若是自行用 git 部署，
   `git revert` 或切回上一個 commit 再重新部署即可。
2. **資料庫**：`db.js` 的資料表異動一律用 `CREATE TABLE IF NOT EXISTS` 與
   `PRAGMA table_info` 檢查後才 `ALTER TABLE`，可重複執行、不會刪除既有資料，
   所以純粹的程式碼回滾通常不需要額外處理資料庫；如果該次上線包含真正的破壞性資料庫
   異動，回滾前務必先確認有資料庫備份。
3. **環境變數**：若該次上線同時調整了環境變數（例如 `CSP_ENFORCE`、`FORM_TEST_MODE`），
   回滾程式碼的同時記得一併確認這些變數是否也要改回原本的值。
4. **驗證回滾成功**：回滾完成後執行 `npm run smoke-test`（或手動打 `/api/health`）
   確認服務恢復正常。

---

## 附錄：`npm run smoke-test`

不呼叫任何付費 AI API、不送出真實詢價，只用一般 HTTP 請求檢查：首頁／配置器／隱私權政策
是否正常開啟、4 個商品深連結、404 處理（品牌頁面＋API JSON）、`/api/health` 回應格式與
安全性、測試模式旗標端點。伺服器需要先另外啟動（`npm run dev` 或 `npm start`），這支腳本
只負責發送請求檢查回應：

```bash
npm run dev              # 另一個終端機視窗先啟動伺服器
SMOKE_TEST_BASE_URL=http://localhost:3000 npm run smoke-test
```
