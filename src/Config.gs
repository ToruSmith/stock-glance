/**
 * Stock Glance — 設定
 * 換成自己的 Sheet 時，只要改 SHEET_ID（或在「專案設定 > 指令碼屬性」新增 SHEET_ID）。
 */
const CONFIG = {
  SHEET_ID: '12_HJ7xI7NCCBNMayjWJnVbUVbucCvt5r9apdOOCgT1w',
  TZ: 'Asia/Taipei',

  SHEETS: {
    LEDGER: '交易紀錄',
    HOLDINGS: '持股',
    CHIPS: '籌碼',
    NOTES: '觀察筆記',
    SETTINGS: '設定',
  },

  // 總覽頁的市場指標。yahoo = Yahoo Finance 代號；mis = 證交所即時報價代號（盤中優先使用）
  // badWhenUp: 數值上升對台股是壞事（例如 VIX、美元兌台幣）
  INDICATORS: [
    { key: 'TAIEX',  name: '加權指數',     yahoo: '^TWII',   mis: 'tse_t00.tw',  digits: 2, group: '台股' },
    { key: 'TSMC',   name: '台積電',       yahoo: '2330.TW', mis: 'tse_2330.tw', digits: 1, group: '台股' },
    { key: 'SOX',    name: '費城半導體',   yahoo: '^SOX',    digits: 2, group: '美股' },
    { key: 'NASDAQ', name: '那斯達克',     yahoo: '^IXIC',   digits: 2, group: '美股' },
    { key: 'SPX',    name: '標普 500',     yahoo: '^GSPC',   digits: 2, group: '美股' },
    { key: 'TSM',    name: '台積電 ADR',   yahoo: 'TSM',     digits: 2, group: '美股' },
    { key: 'VIX',    name: 'VIX 恐慌指數', yahoo: '^VIX',    digits: 2, group: '情緒', badWhenUp: true },
    { key: 'USDTWD', name: '美元／台幣',   yahoo: 'TWD=X',   digits: 3, group: '匯率', badWhenUp: true },
  ],

  CACHE: {
    QUOTE_SEC: 20,     // 即時報價快取
    HISTORY_SEC: 900,  // 日線歷史快取（15 分鐘）
  },

  // 預設值；「設定」分頁的值會覆蓋
  DEFAULTS: {
    '手續費折扣': 1,
    '最低手續費': 20,
    '零股最低手續費': 1,
    '自動刷新秒數': 60,
    '融資警戒增幅': 3,
    '外資大賣門檻(億)': 300,
    // 我的投資規則（持股頁會依此提醒；填 0 代表不提醒）
    '衛星比重上限(%)': 20,
    '單一衛星上限(%)': 10,
  },

  LINKS: [
    { group: '籌碼', name: '三大法人買賣金額統計（證交所）', url: 'https://www.twse.com.tw/zh/trading/foreign/bfi82u.html' },
    { group: '籌碼', name: '融資融券餘額（證交所）', url: 'https://www.twse.com.tw/zh/trading/margin/mi-margn.html' },
    { group: '籌碼', name: '期貨三大法人未平倉（期交所）', url: 'https://www.taifex.com.tw/cht/3/futContractsDate' },
    { group: '籌碼', name: '台指期即時與夜盤行情（期交所）', url: 'https://mis.taifex.com.tw/futures/' },
    { group: '總經', name: '新台幣匯率（央行）', url: 'https://www.cbc.gov.tw/tw/lp-645-1.html' },
    { group: '總經', name: 'FedWatch 利率預期（CME）', url: 'https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html' },
    { group: '總經', name: '國發會景氣對策信號', url: 'https://index.ndc.gov.tw/n/zh_tw' },
    { group: '公司', name: '公開資訊觀測站', url: 'https://mops.twse.com.tw/' },
    { group: '公司', name: 'Yahoo 股市（ETF 成分股、配息）', url: 'https://tw.stock.yahoo.com/' },
  ],
};

function getSheetId_() {
  const p = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  return p || CONFIG.SHEET_ID;
}

function ss_() {
  return SpreadsheetApp.openById(getSheetId_());
}
