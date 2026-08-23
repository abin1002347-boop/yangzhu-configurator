// 楊竹科技後台系統 — Email／LINE 外部通知管道（統一通知系統批次）
// 機密設定只讀取伺服器環境變數，絕不寫入資料庫、絕不出現在API回應、前端或伺服器紀錄。
// LINE_API_BASE_URL只是LINE官方端點的可覆寫設定（不是機密，方便隔離測試指向本機mock
// 服務），未設定時就是官方端點，正式環境不需要、也不應該設定這個變數。
//
// 舊版LINE Notify（notify-api.line.me）已停止服務，這裡改用LINE Messaging API的
// push message（POST /v2/bot/message/push），需要在LINE Developers主控台建立
// Messaging API頻道，取得Channel Access Token，並讓LINE_NOTIFICATION_TARGET_ID
// 指向要接收通知的使用者／群組／聊天室ID。
const nodemailer = require('nodemailer');

const LINE_API_BASE_URL = process.env.LINE_API_BASE_URL || 'https://api.line.me';

function isEmailConfigured() {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASSWORD &&
    process.env.NOTIFICATION_EMAIL_FROM &&
    process.env.NOTIFICATION_EMAIL_TO
  );
}

function isLineConfigured() {
  return !!(process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_NOTIFICATION_TARGET_ID);
}

// 只回報「已設定／未設定」這個布林值給後台通知設定頁使用，絕對不回傳SMTP_HOST／帳號／
// 密碼、也不回傳LINE Token或目標ID本身——這是唯一允許往前端／API回應外流的通知管道資訊。
function getChannelStatus() {
  return {
    email: { configured: isEmailConfigured() },
    line: { configured: isLineConfigured() }
  };
}

// 連線設定（不含密碼本身以外的資訊）用來判斷是否需要重建transporter，避免每次寄信都重新
// 建立連線池；隔離測試時同一個行程可能會切換不同SMTP_HOST（例如從「尚未設定」切到指向
// 本機mock SMTP服務），這裡用setting組成的key確保會正確重建、不會沿用舊設定。
let cachedTransporter = null;
let cachedTransporterKey = null;
function getEmailTransporter() {
  const key = [process.env.SMTP_HOST, process.env.SMTP_PORT, process.env.SMTP_SECURE, process.env.SMTP_USER].join('|');
  if (cachedTransporter && cachedTransporterKey === key) return cachedTransporter;
  cachedTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000
  });
  cachedTransporterKey = key;
  return cachedTransporter;
}

// 把訊息裡可能意外夾帶到的機密值／收發件位址全部替換掉——這裡列出的是「這個管道本身用到
// 的敏感設定值」的完整清單（SMTP密碼、SMTP帳號、LINE Token、LINE目標ID、寄件與收件地址），
// 2026-08-21 Codex獨立複驗指出原本只遮罩SMTP_PASSWORD／LINE_CHANNEL_ACCESS_TOKEN兩項不夠
// 完整。這支函式現在只用在「寫進伺服器console供工程除錯」的訊息上（見下方
// sendEmailNotification／sendLineNotification的catch區塊）——真正會被寫進資料庫、或透過
// API回應給前端的錯誤內容，改由buildChannelError()只用固定的安全文字＋狀態碼組成，從架構上
// 就不會有任何外部服務原始回應本文流進資料庫，這裡的遮罩是console記錄的最後一層防線，
// 不是唯一防線。
function redactSecrets(message) {
  let s = typeof message === 'string' ? message : String(message || '');
  const secrets = [
    process.env.SMTP_PASSWORD,
    process.env.SMTP_USER,
    process.env.LINE_CHANNEL_ACCESS_TOKEN,
    process.env.LINE_NOTIFICATION_TARGET_ID,
    process.env.NOTIFICATION_EMAIL_FROM,
    process.env.NOTIFICATION_EMAIL_TO
  ].filter(Boolean);
  secrets.forEach(secret => { if (secret) s = s.split(secret).join('[REDACTED]'); });
  return s;
}

// 固定、安全的錯誤說明：只依錯誤分類與（若有）狀態碼組成訊息，絕不接受外部服務的任何原始
// 回應本文或例外訊息字串——這是2026-08-21 Codex獨立複驗指出的阻擋問題（LINE錯誤回應本文
// 曾被直接保存前300字到last_error並透過測試通知API回傳）的根本修正：架構上讓「會被寫進
// 資料庫、回應給前端」的錯誤物件從一開始就不可能夾帶任何外部內容，不是靠事後過濾。
const CHANNEL_ERROR_MESSAGES = {
  timeout: '連線逾時或網路錯誤',
  rejected: '外部服務拒絕此次請求',
  service_error: '外部服務暫時發生錯誤',
  config_missing: '尚未設定',
  unknown: '發生未知錯誤'
};
function buildChannelError(category, code) {
  const base = CHANNEL_ERROR_MESSAGES[category] || CHANNEL_ERROR_MESSAGES.unknown;
  const message = (code !== null && code !== undefined) ? `${base}（狀態碼 ${code}）` : base;
  const err = new Error(message);
  err.category = category;
  return err;
}

// SMTP回覆代碼慣例跟HTTP相反：4xx是暫時性錯誤（服務忙碌、稍後可能自己恢復），5xx才是
// 永久拒絕（地址不存在、內容被拒絕等，重試也不會成功，但這裡仍在有限次數內重試，避免
// 因為分類誤判而漏掉「其實是暫時性」的邊界情況，重試上限本身已經足夠防止無限重送）。
function classifySmtpError(err) {
  const code = err && err.code;
  const responseCode = err && err.responseCode;
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION' || code === 'ECONNREFUSED') return 'timeout';
  if (typeof responseCode === 'number' && responseCode >= 500) return 'rejected';
  if (typeof responseCode === 'number' && responseCode >= 400) return 'service_error';
  return 'unknown';
}

async function sendEmailNotification({ subject, text }) {
  if (!isEmailConfigured()) throw buildChannelError('config_missing', null);
  try {
    await getEmailTransporter().sendMail({
      from: process.env.NOTIFICATION_EMAIL_FROM,
      to: process.env.NOTIFICATION_EMAIL_TO,
      subject,
      text
    });
  } catch (err) {
    // 原始SMTP回應本文只寫進伺服器console供工程除錯，絕不進入拋出的Error（那個Error之後會
    // 被記錄到資料庫、也可能透過測試通知API回傳給前端）——這裡先遮罩過一次機密值再印出，
    // 屬於console記錄的最後一層防線。
    console.error('[notification-channels] Email寄送失敗（僅記錄於伺服器console，不寫入資料庫或API回應）：', redactSecrets(err.message));
    throw buildChannelError(classifySmtpError(err), err.responseCode ?? null);
  }
}

function classifyLineHttpStatus(status) {
  if (status >= 500) return 'service_error';
  return 'rejected'; // 400/401/403等：Token或目標ID不正確、內容格式不合法，重試不會自己變好，但仍在有限次數內重試以因應LINE端暫時性問題
}

async function sendLineNotification({ text }) {
  if (!isLineConfigured()) throw buildChannelError('config_missing', null);
  let resp;
  try {
    resp = await fetch(`${LINE_API_BASE_URL}/v2/bot/message/push`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ to: process.env.LINE_NOTIFICATION_TARGET_ID, messages: [{ type: 'text', text }] }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (err) {
    console.error('[notification-channels] LINE推播連線失敗（僅記錄於伺服器console，不寫入資料庫或API回應）：', redactSecrets(err.message));
    throw buildChannelError('timeout', null);
  }
  if (!resp.ok) {
    // LINE的錯誤回應本文（可能包含目標ID、帳號設定細節等）只寫進伺服器console供工程除錯，
    // 絕不進入拋出的Error——2026-08-21 Codex獨立複驗指出原本這裡把回應本文前300字直接
    // 保存進last_error並透過測試通知API回傳，是本輪要修正的阻擋問題之一。
    let bodyTextForLog = '';
    try { bodyTextForLog = (await resp.text()).slice(0, 300); } catch (e) { /* 讀取失敗就不附細節 */ }
    console.error(`[notification-channels] LINE推播失敗（僅記錄於伺服器console，不寫入資料庫或API回應）：HTTP ${resp.status} ${redactSecrets(bodyTextForLog)}`);
    throw buildChannelError(classifyLineHttpStatus(resp.status), resp.status);
  }
}

module.exports = { sendEmailNotification, sendLineNotification, isEmailConfigured, isLineConfigured, getChannelStatus };
