// 楊竹科技後台系統 — 通用 Excel(.xlsx) 匯出工具
// 三個頁面（訂單管理／商品管理／客戶管理）各自的「匯出Excel」API都呼叫這裡的共用函式，
// 統一產生真正的Excel二進位格式（用exceljs），欄位標題固定用繁體中文、標題列加粗，
// 不需要每個頁面各自處理格式與中文編碼問題。
const ExcelJS = require('exceljs');

// 在同一個活頁簿裡加一個分頁，欄位標題列固定加粗＋AutoFilter。抽成獨立函式是因為「訂單／
// 商品／客戶匯出」只需要單一分頁（buildXlsxBuffer），但「網站分析匯出」需要在同一個檔案裡
// 放摘要總覽／事件明細／重點摘要三個分頁（buildMultiSheetXlsxBuffer），兩者共用同一份
// 「畫一個分頁」邏輯，不要各自重複一份。
// columns: [{ header:'欄位標題', key:'資料鍵名', width:數字 }, ...]
// rows: 陣列物件，每個物件的鍵名要對應到columns的key
function addSheetToWorkbook(workbook, sheetName, columns, rows) {
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns;
  rows.forEach(row => sheet.addRow(row));
  sheet.getRow(1).font = { bold: true };
  if (columns.length) {
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  return sheet;
}

// 單一分頁的活頁簿（訂單／商品／客戶匯出用）。
async function buildXlsxBuffer(sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  addSheetToWorkbook(workbook, sheetName, columns, rows);
  return workbook.xlsx.writeBuffer();
}

// 多分頁活頁簿：sheets = [{ name, columns, rows }, ...]，依陣列順序依序加入分頁（網站分析
// 匯出用：摘要總覽／事件明細／重點摘要三個分頁放在同一個檔案，不需要下載三個檔案）。
async function buildMultiSheetXlsxBuffer(sheets) {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach(({ name, columns, rows }) => addSheetToWorkbook(workbook, name, columns, rows));
  return workbook.xlsx.writeBuffer();
}

// 檔名格式固定為「前綴_YYYYMMDD.xlsx」，方便同仁依日期存檔比對。
function xlsxFilename(prefix) {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
}

// 統一設定Content-Type與下載檔名並回傳。filename同時提供純ASCII後備與UTF-8編碼版本
// （RFC 5987 filename*），避免中文檔名在部分瀏覽器被砍成亂碼或直接遺失副檔名。
function sendXlsx(res, filenamePrefix, buffer) {
  const filename = xlsxFilename(filenamePrefix);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="export.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(Buffer.from(buffer));
}

module.exports = { buildXlsxBuffer, buildMultiSheetXlsxBuffer, xlsxFilename, sendXlsx };
