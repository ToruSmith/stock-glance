/**
 * 初始化、排程與籌碼資料維護。
 * 第一次部署後，在編輯器選擇 setup 執行一次（會要求授權）。
 */

function setup() {
  ensureSheets_();
  installTriggers();
  const n = backfillChips(25);
  Logger.log('完成：已建立排程，補齊 ' + n + ' 個交易日的籌碼資料。');
}

function ensureSheets_() {
  const ss = ss_();
  const need = [
    [CONFIG.SHEETS.HOLDINGS, ['代號', '名稱', '股數', '成交均價', '投入成本', '類型', '市場', '備註']],
    [CONFIG.SHEETS.CHIPS, ['日期', '外資(億)', '投信(億)', '自營商(億)', '三大法人合計(億)', '融資餘額(億)', '融資增減(億)', '更新時間']],
    [CONFIG.SHEETS.NOTES, ['日期', '分類', '標題', '內容']],
    [CONFIG.SHEETS.SETTINGS, ['項目', '值', '說明']],
  ];
  need.forEach(([name, head]) => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
      sh.setFrozenRows(1);
      sh.getRange('A:A').setNumberFormat('@');
    }
  });
}

/** 每個交易日晚上自動抓籌碼（證交所融資資料約 21:00 後公布） */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'dailyChipsJob') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyChipsJob').timeBased().atHour(22).nearMinute(0).everyDays(1).inTimezone(CONFIG.TZ).create();
}

function dailyChipsJob() {
  const dow = Number(Utilities.formatDate(new Date(), CONFIG.TZ, 'u'));
  if (dow >= 6) return;
  updateChipsForDate_(new Date());
}

/**
 * 抓取某一天的三大法人與融資，寫入（或更新）籌碼分頁。
 * @return {Array|null} 寫入的列；休市日回傳 null
 */
function updateChipsForDate_(d) {
  const ymd = Utilities.formatDate(d, CONFIG.TZ, 'yyyyMMdd');
  const inst = twseInstitutional_(ymd);
  Utilities.sleep(1500);
  const mg = twseMargin_(ymd);
  if (!inst && !mg) return null;
  const row = [
    Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'),
    inst ? inst.foreign : '', inst ? inst.trust : '', inst ? inst.dealer : '', inst ? inst.total : '',
    mg ? mg.balance : '', mg && mg.change !== null ? mg.change : '',
    Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
  ];
  upsertChipRow_(row);
  return row;
}

function upsertChipRow_(row) {
  const sh = ss_().getSheetByName(CONFIG.SHEETS.CHIPS);
  const last = sh.getLastRow();
  const dates = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => cellDate_(r[0])) : [];
  const idx = dates.indexOf(row[0]);
  if (idx >= 0) {
    // 已有資料：只覆蓋有值的欄位（例如晚上補上融資）
    const cur = sh.getRange(idx + 2, 1, 1, row.length).getValues()[0];
    const merged = row.map((v, i) => (v === '' ? cur[i] : v));
    sh.getRange(idx + 2, 1, 1, row.length).setValues([merged]);
  } else {
    sh.getRange(last + 1, 1, 1, row.length).setValues([row]);
    if (last > 1) sh.getRange(2, 1, last, row.length).sort(1);
  }
}

/**
 * 回補過去的籌碼資料（可重複執行，已有的日期會略過）。
 * 證交所有頻率限制，每次請求間隔約 2 秒；執行時間上限約 5 分鐘。
 * @param {number} tradingDays 想要的交易日數
 */
function backfillChips(tradingDays) {
  tradingDays = tradingDays || 25;
  const started = Date.now();
  const sh = ss_().getSheetByName(CONFIG.SHEETS.CHIPS);
  const have = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => cellDate_(r[0])) : [];
  let got = 0;
  for (let back = 0; back < tradingDays * 1.6 && got < tradingDays; back++) {
    if (Date.now() - started > 300000) break;
    const d = new Date(Date.now() - back * 86400000);
    const dow = Number(Utilities.formatDate(d, CONFIG.TZ, 'u'));
    if (dow >= 6) continue;
    const key = Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd');
    if (have.indexOf(key) >= 0) { got++; continue; }
    const r = updateChipsForDate_(d);
    if (r) got++;
    Utilities.sleep(2000);
  }
  return got;
}
