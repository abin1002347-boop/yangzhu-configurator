// 楊竹科技後台系統 — 通知非同步派送工作（統一通知系統批次）
// 定期（預設每5秒）從notification_delivery_jobs撈出到期的pending工作、逐筆嘗試外部傳送，
// 成功／失敗都寫回資料庫。刻意用輪詢＋資料庫狀態機而不是記憶體佇列：伺服器重啟後尚未完成
// 的工作仍然留在資料庫裡，下次啟動會被下一輪輪詢撿回來繼續處理，不會遺失；claim階段的
// 條件式UPDATE（見notification-service.js的claimDueDeliveryJobs()）也讓同一筆工作不會被
// 重複搶占、重複傳送。
//
// 這裡完全不會阻塞任何詢價／訂單／庫存等主要交易API——那些API只負責同步寫入
// notification_delivery_jobs（一筆SQLite INSERT，極快），實際對外的Email／LINE網路呼叫
// 全部發生在這支獨立的計時器迴圈裡，就算SMTP或LINE服務很慢或整個掛掉，也不會拖慢任何
// 客戶或管理員正在等待回應的請求。
const {
  claimDueDeliveryJobs, recordDeliverySuccess, recordDeliveryFailure, abandonDeliveryJobImmediately
} = require('./notification-service');
const { sendEmailNotification, sendLineNotification } = require('./notification-channels');

function buildNotificationText(job) {
  const lines = [job.title];
  if (job.summary) lines.push(job.summary);
  return lines.join('\n');
}

// job.claim_token是這次claimDueDeliveryJobs()替這筆工作產生的一次性權杖，三個完成函式
// 都要求資料庫裡的claim_token仍等於這個值才會生效——如果這次網路呼叫（Email／LINE）拖太久、
// 租約已經過期被下一輪回收甚至被別的worker重新claim走，這裡帶的就是舊token，完成函式會
// 回傳false且不改動任何欄位。false只代表「這次回報已經來不及生效」，不是例外，這裡只留下
// 不含敏感資料的診斷紀錄（純id、channel、判定結果），供事後排查對帳是否可能造成重複寄送
// （2026-08-21第二次獨立複驗要求）。
async function processOneJob(job) {
  try {
    const text = buildNotificationText(job);
    if (job.channel === 'email') {
      await sendEmailNotification({ subject: job.title, text });
    } else if (job.channel === 'line') {
      await sendLineNotification({ text });
    } else {
      throw Object.assign(new Error('未知的通知管道：' + job.channel), { category: 'unknown' });
    }
    const applied = recordDeliverySuccess(job.id, job.claim_token);
    if (!applied) {
      console.warn(`[notification-worker] 工作#${job.id}（${job.channel}）已成功送出，但回報時租約權杖已失效（可能已被回收或被其他行程接手），本次回報未生效`);
    }
  } catch (err) {
    const category = (err && err.category) || 'unknown';
    let applied;
    if (category === 'config_missing') {
      // 管道根本沒設定：不會自己變好，直接標記abandoned，不浪費重試次數。
      applied = abandonDeliveryJobImmediately(job.id, job.claim_token, { errorMessage: err.message, errorCategory: category });
    } else {
      applied = recordDeliveryFailure(job.id, job.claim_token, { errorMessage: err.message, errorCategory: category });
    }
    if (!applied) {
      console.warn(`[notification-worker] 工作#${job.id}（${job.channel}）處理失敗，但回報時租約權杖已失效（可能已被回收或被其他行程接手），本次回報未生效`);
    }
  }
}

// 供隔離測試直接呼叫（不需要等待計時器），回傳這一輪實際處理了幾筆工作，方便測試斷言。
async function processNotificationJobsOnce(limit) {
  const jobs = claimDueDeliveryJobs(limit || 10);
  for (const job of jobs) {
    await processOneJob(job);
  }
  return jobs.length;
}

let workerInterval = null;
function startNotificationWorker(intervalMs) {
  if (workerInterval) return; // 已經在跑，不重複啟動第二個計時器
  workerInterval = setInterval(() => {
    processNotificationJobsOnce().catch(err => console.error('[notification-worker] 派送迴圈發生未預期例外：', err.message));
  }, intervalMs || 5000);
  // unref()：這個計時器不應該阻止行程自然結束（測試腳本啟動短命的伺服器行程時尤其重要），
  // 跟正式環境長駐行程的實際運作沒有衝突——只要行程還活著，計時器就會繼續按原本間隔觸發。
  if (typeof workerInterval.unref === 'function') workerInterval.unref();
}
function stopNotificationWorker() {
  if (workerInterval) { clearInterval(workerInterval); workerInterval = null; }
}

module.exports = { processNotificationJobsOnce, startNotificationWorker, stopNotificationWorker };
