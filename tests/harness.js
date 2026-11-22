/**
 * 本機測試：用假的 Apps Script 服務與「合成」行情資料執行後端程式，
 * 產生 getDashboard() 的輸出，並組出可在瀏覽器預覽的 preview.html。
 * 用法：node tests/harness.js  → 產生 tests/out/preview.html
 * 注意：這裡的價格全是程式產生的假資料，只用來測試畫面與計算邏輯。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

/* ---------- 合成資料 ---------- */
let seed = 42;
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const NOW = Date.parse('2026-11-20T05:30:00Z'); // 台北 13:30
function tradingDays(n) {
  const out = []; let t = NOW;
  while (out.length < n) { const d = new Date(t); const w = d.getUTCDay(); if (w !== 0 && w !== 6) out.unshift(t); t -= 86400000; }
  return out;
}
// 走勢：先漲到高點，最後一個半月大跌到 end
function series(n, start, peak, end, vol) {
  const days = tradingDays(n), pts = []; const peakAt = Math.floor(n * 0.86);
  for (let i = 0; i < n; i++) {
    const base = i <= peakAt ? start + (peak - start) * (i / peakAt) : peak + (end - peak) * ((i - peakAt) / (n - 1 - peakAt));
    const c = i === n - 1 ? end : base * (1 + (rnd() - 0.5) * vol);
    pts.push({ t: days[i], c });
  }
  return pts;
}
function yahooJson(pts, extra) {
  return { chart: { result: [{ meta: Object.assign({ regularMarketPrice: pts[pts.length - 1].c, regularMarketTime: pts[pts.length - 1].t / 1000,
    exchangeTimezoneName: 'Asia/Taipei', currency: 'TWD', fiftyTwoWeekHigh: Math.max(...pts.map(p => p.c)), fiftyTwoWeekLow: Math.min(...pts.map(p => p.c)) }, extra || {}),
    timestamp: pts.map(p => p.t / 1000),
    indicators: { quote: [{ open: pts.map(p => p.c), high: pts.map(p => p.c * 1.01), low: pts.map(p => p.c * 0.99), close: pts.map(p => p.c), volume: pts.map(() => 1000) }] },
    events: extra && extra.divs ? { dividends: extra.divs } : undefined }] } };
}
const Y = {
  '^TWII': series(260, 27000, 43675, 36033.29, 0.012),
  '2330.TW': series(260, 1100, 2150, 1880, 0.015),
  '^SOX': series(260, 7000, 11200, 8408.59, 0.02),
  '^IXIC': series(260, 20000, 25400, 22617.73, 0.012),
  '^GSPC': series(260, 6000, 7700, 6910, 0.01),
  'TSM': series(260, 220, 420, 330, 0.02),
  '^VIX': series(260, 16, 15, 35.89, 0.08),
  'TWD=X': series(260, 30.2, 31.6, 32.936, 0.002),
  '0050.TW': series(260, 70, 122, 98.35, 0.012),
  '00918.TW': series(260, 23, 27, 22.9, 0.008),
  '00919.TW': series(260, 23, 26, 21.6, 0.008),
  '00929.TW': series(260, 18, 22, 18.05, 0.01),
  '009816.TW': series(260, 10, 14.2, 11.8, 0.012),
  '00985A.TW': series(260, 16, 21, 17.4, 0.012),
};
const DIVS = { '00918.TW': [[-300, 0.7], [-210, 0.7], [-120, 0.72], [-30, 0.66]], '00919.TW': [[-330, 0.72], [-240, 0.72], [-150, 0.7], [-60, 0.54]] };

function chipsFor(ymd) {
  const d = new Date(ymd.slice(0, 4) + '-' + ymd.slice(4, 6) + '-' + ymd.slice(6) + 'T00:00:00Z');
  const w = d.getUTCDay(); if (w === 0 || w === 6) return null;
  const k = Number(ymd.slice(6));
  const f = -(200 + (k % 7) * 40) * 1e8;
  return { f, t: (k % 3 - 1) * 12e8, dS: -80e8, dH: -40e8, margin: (5100 - (20 - k) * -30 - k * 35) * 1e5 };
}

function route(url) {
  let m;
  if ((m = url.match(/v8\/finance\/chart\/([^?]+)\?range=([^&]+)/))) {
    const sym = decodeURIComponent(m[1]);
    if (!Y[sym]) return [404, '{}'];
    const days = { '1mo': 22, '3mo': 66, '6mo': 130, '1y': 260, '2y': 260, '5y': 260 }[m[2]] || 260;
    const pts = Y[sym].slice(-days);
    const divs = {};
    (DIVS[sym] || []).forEach(([dd, a]) => { const t = (NOW + dd * 86400000) / 1000; divs[t] = { date: t, amount: a }; });
    return [200, JSON.stringify(yahooJson(pts, Object.keys(divs).length ? { divs } : null))];
  }
  if (url.indexOf('mis.twse.com.tw') >= 0) {
    const ch = decodeURIComponent(url.match(/ex_ch=([^&]+)/)[1]).split('|');
    const arr = [];
    ch.forEach(c => {
      const [ex, rest] = c.split('_'); const code = rest.replace('.tw', '');
      if (ex !== 'tse') return;
      const sym = code === 't00' ? '^TWII' : code + '.TW';
      const p = Y[sym]; if (!p) return;
      const last = p[p.length - 1].c, prev = p[p.length - 2].c;
      arr.push({ c: code, n: code, ex: 'tse', z: code === '00929' ? '-' : last.toFixed(2), y: prev.toFixed(2), b: (last - 0.05).toFixed(2) + '_', a: (last + 0.05).toFixed(2) + '_',
        o: prev.toFixed(2), h: (last * 1.01).toFixed(2), l: (last * 0.99).toFixed(2), v: '12345', tlong: String(NOW) });
    });
    return [200, JSON.stringify({ msgArray: arr, rtcode: '0000' })];
  }
  if ((m = url.match(/BFI82U.*dayDate=(\d{8})/))) {
    const c = chipsFor(m[1]); if (!c) return [200, JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!' })];
    const r = (n, v) => [n, '1', '1', Math.round(v).toLocaleString('en-US')];
    return [200, JSON.stringify({ stat: 'OK', fields: ['單位名稱', '買進金額', '賣出金額', '買賣差額'], data: [
      r('自營商(自行買賣)', c.dS), r('自營商(避險)', c.dH), r('投信', c.t), r('外資及陸資(不含外資自營商)', c.f), r('外資自營商', 0), r('合計', c.dS + c.dH + c.t + c.f)] })];
  }
  if ((m = url.match(/MI_MARGN.*date=(\d{8})/))) {
    const c = chipsFor(m[1]); if (!c) return [200, JSON.stringify({ stat: '很抱歉，沒有符合條件的資料!' })];
    return [200, JSON.stringify({ stat: 'OK', tables: [{ title: '信用交易統計', fields: ['項目', '買進', '賣出', '現金(券)償還', '前日餘額', '今日餘額'],
      data: [['融資(交易單位)', '1', '1', '1', '1', '1'], ['融券(交易單位)', '1', '1', '1', '1', '1'],
        ['融資金額(仟元)', '1', '1', '1', Math.round(c.margin + 3e6).toLocaleString('en-US'), Math.round(c.margin).toLocaleString('en-US')]] }, { title: '其他', data: [] }] })];
  }
  if (url.indexOf('openapi.twse.com.tw') >= 0) {
    const rows = [['0050', '元大台灣50'], ['0056', '元大高股息'], ['00878', '國泰永續高股息'], ['00918', '大華優利高填息30'], ['00919', '群益台灣精選高息'],
      ['00929', '復華台灣科技優息'], ['009816', '凱基台灣TOP50'], ['00985A', '主動野村台灣50'], ['2330', '台積電'], ['2317', '鴻海'], ['2454', '聯發科']];
    for (let i = 0; i < 600; i++) rows.push([String(1101 + i), '測試股' + i]);
    return [200, JSON.stringify(rows.map(([Code, Name]) => ({ Code, Name, ClosingPrice: Y[Code + '.TW'] ? Y[Code + '.TW'].slice(-1)[0].c.toFixed(2) : '50.00' })))];
  }
  if (url.indexOf('tpex.org.tw') >= 0) return [200, JSON.stringify([{ SecuritiesCompanyCode: '6488', CompanyName: '環球晶', Close: '400.00' }, { SecuritiesCompanyCode: '700001', CompanyName: '權證', Close: '1' }])];
  return [404, ''];
}

/* ---------- 假的 Apps Script 服務 ---------- */
function fmtDate(d, tz, p) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(d).map(x => [x.type, x.value]));
  const u = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[parts.weekday];
  return p.replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day).replace('HH', parts.hour).replace('mm', parts.minute).replace('ss', parts.second).replace(/^u$/, String(u));
}
const sheets = {
  '交易紀錄': [['日期', '代號', '名稱', '動作', '股數', '成交價', '手續費', '交易稅', '淨收付', '類型', '市場', '備註', 'ID'],
    ['', '0050', '元大台灣50', '買進', 1000, 111.5, 167, 0, -111667, 'ETF', '上市', '期初庫存', 'init-0050'],
    ['', '00918', '大華優利高填息30', '買進', 1000, 34.07, 48, 0, -34118, 'ETF', '上市', '期初庫存', 'init-00918'],
    ['', '00919', '群益台灣精選高息', '買進', 1000, 32.04, 45, 0, -32085, 'ETF', '上市', '期初庫存', 'init-00919'],
    ['', '00929', '復華台灣科技優息', '買進', 1000, 28.51, 40, 0, -28550, 'ETF', '上市', '期初庫存', 'init-00929'],
    ['', '009816', '凱基台灣TOP50', '買進', 1000, 16.46, 23, 0, -16483, 'ETF', '上市', '期初庫存', 'init-009816'],
    ['', '00985A', '主動野村台灣50', '買進', 1000, 24.31, 34, 0, -24344, 'ETF', '上市', '期初庫存', 'init-00985A']],
  '持股': [['代號', '名稱', '股數', '成交均價', '投入成本', '類型', '市場', '備註'],
    ['0050', '元大台灣50', 1000, 111.5, 111667, 'ETF', '上市', '市值型'], ['00918', '大華優利高填息30', 1000, 34.07, 34118, 'ETF', '上市', '高股息'],
    ['00919', '群益台灣精選高息', 1000, 32.04, 32085, 'ETF', '上市', '高股息'], ['00929', '復華台灣科技優息', 1000, 28.51, 28550, 'ETF', '上市', '科技高息・月配'],
    ['009816', '凱基台灣TOP50', 1000, 16.46, 16483, 'ETF', '上市', '市值型'], ['00985A', '主動野村台灣50', 1000, 24.31, 24344, 'ETF', '上市', '主動式']],
  '籌碼': [['日期', '外資(億)', '投信(億)', '自營商(億)', '三大法人合計(億)', '融資餘額(億)', '融資增減(億)', '更新時間']],
  '觀察筆記': [['日期', '分類', '標題', '內容'], ['2026-11-22', '盤勢', '測試筆記 <b>不應變粗體</b>', '第一行\n第二行'], ['2026-11-22', '持股診斷', '重疊度高', '內容…']],
  '設定': [['項目', '值', '說明'], ['手續費折扣', 0.6, ''], ['自動刷新秒數', 60, '']],
};
function sheetStub(name) {
  const data = sheets[name];
  const rng = (r, c, nr, nc) => ({
    getValues: () => data.slice(r - 1, r - 1 + nr).map(row => { const o = row.slice(c - 1, c - 1 + nc); while (o.length < nc) o.push(''); return o; }),
    setValues: v => { v.forEach((row, i) => { data[r - 1 + i] = data[r - 1 + i] || []; row.forEach((x, j) => { data[r - 1 + i][c - 1 + j] = x; }); }); return this; },
    sort: col => { const body = data.slice(r - 1, r - 1 + nr).sort((a, b) => String(a[col - 1]) < String(b[col - 1]) ? -1 : 1); data.splice(r - 1, nr, ...body); },
    setFontWeight: () => ({}), setNumberFormat: () => ({}),
    clearContent: () => { for (let i = r - 1; i < r - 1 + nr; i++) if (data[i]) for (let j = c - 1; j < c - 1 + nc; j++) data[i][j] = ''; },
  });
  return { getDataRange: () => rng(1, 1, data.length, Math.max(...data.map(r => r.length))), getLastRow: () => data.length,
    getRange: (r, c, nr, nc) => rng(r, c, nr || 1, nc || 1), setFrozenRows: () => {},
    deleteRow: r => { data.splice(r - 1, 1); } };
}
const cache = new Map();
const props = {};
const resp = ([code, body]) => ({ getResponseCode: () => code, getContentText: () => body });
const ctx = {
  console, Date, Math, JSON, Number, String, Object, Array, isFinite, encodeURIComponent, decodeURIComponent,
  Utilities: { getUuid: () => crypto.randomUUID(), formatDate: fmtDate, sleep: () => {}, DigestAlgorithm: { MD5: 'md5' },
    computeDigest: (a, s) => Array.from(crypto.createHash('md5').update(s).digest()), base64EncodeWebSafe: b => Buffer.from(b).toString('base64url') },
  CacheService: { getScriptCache: () => ({ get: k => cache.get(k) || null, put: (k, v) => cache.set(k, v),
    getAll: ks => Object.fromEntries(ks.map(k => [k, cache.get(k)])), putAll: m => Object.entries(m).forEach(([k, v]) => cache.set(k, v)) }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ text: t, setMimeType() { return this; } }) },
  UrlFetchApp: { fetch: u => resp(route(u)), fetchAll: rs => rs.map(r => resp(route(r.url))) },
  SpreadsheetApp: { flush() {}, openById: () => ({ getSheetByName: n => (sheets[n] ? sheetStub(n) : null) }) },
  Logger: { log: console.log },
};
vm.createContext(ctx);
['Config.gs', 'Fetchers.gs', 'Signals.gs', 'Ledger.gs', 'Code.gs', 'Setup.gs'].forEach(f => vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f }));

// 讓 backfill 以 2026-11-20 為今天
const RealNow = Date.now; Date.now = () => NOW;
const got = vm.runInContext('backfillChips(25)', ctx);
console.log('backfill 交易日:', got, '籌碼列數:', sheets['籌碼'].length - 1);
// ---- 交易帳本測試：加碼、賣出、刪除 ----
const post = b => JSON.parse(vm.runInContext('doPost(' + JSON.stringify({ postData: { contents: JSON.stringify(b) } }) + ').text', ctx));
const k0 = vm.runInContext('setupApiKey()', ctx);
const pos = () => vm.runInContext('readPortfolio_()', ctx);
const r1 = post({ key: k0, action: 'addTx', tx: { code: '0050', side: 'buy', shares: 1000, price: 98, date: '2026-11-20' } });
const p1 = pos().positions.find(h => h.code === '0050');
console.log('加碼 0050:', r1.ok, '股數', p1.shares, '均價', p1.avg.toFixed(4), '成本', p1.cost, '(預期 (111667+98000+139)/2000)');
const r2 = post({ key: k0, action: 'addTx', tx: { code: '0050', side: 'sell', shares: 500, price: 100, date: '2026-11-20' } });
const pf2 = pos(); const p2 = pf2.positions.find(h => h.code === '0050');
console.log('賣 500:', r2.ok, '剩', p2.shares, '已實現', pf2.realized, '持股頁列數', sheets['持股'].filter(r => r[0]).length - 1);
console.log('超賣:', post({ key: k0, action: 'addTx', tx: { code: '0050', side: 'sell', shares: 99999, price: 100 } }).error);
console.log('新股 2330 零股:', JSON.stringify(post({ key: k0, action: 'addTx', tx: { code: '2330', side: 'buy', shares: 10, price: 1880 } }).data.row));
console.log('上櫃 6488:', post({ key: k0, action: 'addTx', tx: { code: '6488', side: 'buy', shares: 1000, price: 400 } }).data.row.slice(9, 11));
console.log('錯代號:', post({ key: k0, action: 'addTx', tx: { code: '9999', side: 'buy', shares: 1, price: 1 } }).error);
const sellId = sheets['交易紀錄'].find(r => r[3] === '賣出')[12];
console.log('刪除賣出:', post({ key: k0, action: 'deleteTx', id: sellId }).ok, '0050 股數回到', pos().positions.find(h => h.code === '0050').shares);
const t2330 = sheets['交易紀錄'].find(r => r[1] === '2330')[12], t6488 = sheets['交易紀錄'].find(r => r[1] === '6488')[12];
post({ key: k0, action: 'deleteTx', id: t2330 }); post({ key: k0, action: 'deleteTx', id: t6488 });
// 出清一檔：00929 全賣，測試已出清
post({ key: k0, action: 'addTx', tx: { code: '00929', side: 'sell', shares: 1000, price: 18, date: '2026-11-21' } });
console.log('代號表筆數:', vm.runInContext('securities_().list.length', ctx), '權證已排除:', !vm.runInContext('securities_().list.some(x=>x[0]==="700001")', ctx));
const dash = vm.runInContext('getDashboard()', ctx);
console.log('已出清:', JSON.stringify(dash.holdings.closed.map(c => [c.code, c.realized])), '累計已實現', dash.holdings.totals.realized);
const live = vm.runInContext('getLive()', ctx);
const hist = vm.runInContext('getHistory("00918","1y")', ctx);
const key = vm.runInContext('setupApiKey()', ctx);
const call = q => JSON.parse(vm.runInContext('doGet(' + JSON.stringify({ parameter: q }) + ').text', ctx));
console.log('API 無金鑰:', call({ api: 'dashboard' }).error, '| 錯金鑰:', call({ api: 'dashboard', key: 'x' }).error,
  '| 正確:', call({ api: 'dashboard', key }).ok, '| history:', call({ api: 'history', id: 'SOX', range: '1mo', key }).data.points.length,
  '| 無 api:', call({}).name);
Date.now = RealNow;

console.log('訊號:', dash.signals.items.map(i => i.key + '=' + i.state).join(' '), '|', dash.signals.summary);
console.log('總市值', dash.holdings.totals.value, '損益', dash.holdings.totals.pnl, '淨', dash.holdings.totals.netPnl);
console.log('0050 來源:', dash.holdings.rows.find(r => r.code === '0050').quoteSource);
console.log('00918 近12月配息:', hist.ttmDiv);
console.log('錯誤:', dash.errors);
fs.writeFileSync(path.join(OUT, 'dashboard.json'), JSON.stringify(dash, null, 1));

/* ---------- 組預覽頁（GitHub Pages 前端 + 假 API） ---------- */
const DOCS = path.join(ROOT, 'docs');
const read = f => fs.readFileSync(path.join(DOCS, f), 'utf8');
const mock = `<script>
window.__MOCK__ = (function(){
  const dash = ${JSON.stringify(dash)};
  const Y = ${JSON.stringify(Object.fromEntries(Object.entries(Y).map(([k, v]) => [k, v.map(p => ({ t: p.t, c: p.c }))])))};
  const map = { TAIEX:'^TWII', TSMC:'2330.TW', SOX:'^SOX', NASDAQ:'^IXIC', SPX:'^GSPC', TSM:'TSM', VIX:'^VIX', USDTWD:'TWD=X' };
  return {
    getDashboard: () => JSON.parse(JSON.stringify(dash)),
    getLive: () => ({ asOf: Date.now(), market: dash.market, indicators: {}, holdings: dash.holdings }),
    getHistory: (id, range) => { const s = map[id] || (id + '.TW'); return { id, range, interval: range === '5y' ? '1wk' : '1d', points: Y[s], ttmDiv: id === '00918' ? 2.78 : null, source: '測試資料' }; },
    refreshChips: () => ({ ok: true, chips: dash.chips }),
    getSecurities: () => ({ list: ${JSON.stringify(vm.runInContext('securities_()', ctx).list)}, asOf: Date.now() }),
    addTx: p => ({ id: 'x' }), deleteTx: p => ({ deleted: p.id }),
  };
})();
</script>`;
const html = read('index.html')
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>' + read('styles.css') + '</style>')
  .replace('<script src="app.js"></script>', () => mock + '<script>' + read('app.js') + '</script>');
fs.writeFileSync(path.join(OUT, 'preview.html'), html);
console.log('預覽頁:', path.join(OUT, 'preview.html'));
