/**
 * Stock Glance — 網頁進入點與前端呼叫的 API
 */

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Stock Glance 台股觀測')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/* ---------------- 共用 ---------------- */

function fmtDate_(d, pattern) {
  return Utilities.formatDate(d, CONFIG.TZ, pattern || 'yyyy-MM-dd');
}

function cellDate_(v) {
  if (v instanceof Date) return fmtDate_(v);
  return String(v || '').trim();
}

function marketState_() {
  const now = new Date();
  const dow = Number(fmtDate_(now, 'u')); // 1=一 … 7=日
  const hm = Number(fmtDate_(now, 'HHmm'));
  if (dow >= 6) return { open: false, label: '休市（週末）' };
  if (hm < 830) return { open: false, label: '盤前' };
  if (hm < 900) return { open: false, label: '試撮中' };
  if (hm <= 1335) return { open: true, label: '盤中' };
  return { open: false, label: '已收盤' };
}

function settings_() {
  const s = Object.assign({}, CONFIG.DEFAULTS);
  const sh = ss_().getSheetByName(CONFIG.SHEETS.SETTINGS);
  if (!sh) return s;
  sh.getDataRange().getValues().slice(1).forEach(r => {
    const k = String(r[0] || '').trim();
    if (k && r[1] !== '' && r[1] !== null) s[k] = isFinite(Number(r[1])) ? Number(r[1]) : r[1];
  });
  return s;
}

function normCode_(v) {
  let s = String(v === null || v === undefined ? '' : v).trim().toUpperCase();
  if (/^\d{1,3}$/.test(s)) s = ('0000' + s).slice(-4); // 50 → 0050（Sheet 吃掉前導 0 時的補救）
  return s;
}

/* ---------------- 持股 ---------------- */

function readHoldings_() {
  const sh = ss_().getSheetByName(CONFIG.SHEETS.HOLDINGS);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues();
  const head = rows.shift().map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const iCode = col('代號'), iName = col('名稱'), iShares = col('股數'), iAvg = col('成交均價'),
    iCost = col('投入成本'), iType = col('類型'), iMkt = col('市場'), iNote = col('備註');
  return rows.filter(r => r[iCode] !== '' && r[iCode] !== null).map(r => {
    const shares = Number(r[iShares]) || 0;
    const avg = Number(r[iAvg]) || 0;
    const cost = iCost >= 0 && r[iCost] !== '' ? Number(r[iCost]) : Math.round(avg * shares);
    const code = normCode_(r[iCode]);
    const type = iType >= 0 && r[iType] ? String(r[iType]) : (/^00/.test(code) ? 'ETF' : '股票');
    const mkt = iMkt >= 0 && String(r[iMkt]).indexOf('櫃') >= 0 ? 'otc' : 'tse';
    return { code: code, name: iName >= 0 ? String(r[iName]) : code, shares: shares, avg: avg, cost: cost,
      type: type, market: mkt, note: iNote >= 0 ? String(r[iNote] || '') : '' };
  });
}

function sellCost_(value, type, st) {
  if (!value) return { fee: 0, tax: 0 };
  const fee = Math.max(Number(st['最低手續費']) || 20, Math.floor(value * 0.001425 * (Number(st['手續費折扣']) || 1)));
  const taxRate = /ETF/i.test(type) ? 0.001 : 0.003;
  return { fee: fee, tax: Math.floor(value * taxRate) };
}

function enrichHoldings_(list, quotes, hist, st) {
  const rows = list.map(h => {
    const q = quotes[h.code] || null;
    const y = hist[h.code] || null;
    const price = q && q.price !== null ? q.price : (y ? y.price : null);
    const prev = q && q.prevClose !== null ? q.prevClose : (y ? y.prevClose : null);
    const value = price !== null ? Math.round(price * h.shares) : null;
    const sc = sellCost_(value, h.type, st);
    const pnl = value !== null ? value - h.cost : null;
    const net = value !== null ? value - sc.fee - sc.tax - h.cost : null;
    // 損益兩平價（含賣出手續費與交易稅）
    const taxRate = /ETF/i.test(h.type) ? 0.001 : 0.003;
    const feeRate = 0.001425 * (Number(st['手續費折扣']) || 1);
    const breakeven = h.shares ? h.cost / (h.shares * (1 - feeRate - taxRate)) : null;
    return Object.assign({}, h, {
      price: price, prevClose: prev,
      chg: price !== null && prev ? price - prev : null,
      chgPct: price !== null && prev ? (price / prev - 1) * 100 : null,
      value: value, pnl: pnl, pnlPct: pnl !== null && h.cost ? pnl / h.cost * 100 : null,
      netPnl: net, sellFee: sc.fee, sellTax: sc.tax,
      dayPnl: price !== null && prev ? Math.round((price - prev) * h.shares) : null,
      breakeven: breakeven,
      quoteTime: q ? q.time : (y ? y.time : null),
      quoteSource: q ? q.source + (q.priceKind !== 'trade' ? '（' + ({ bid: '買價', ask: '賣價', prev: '昨收' }[q.priceKind]) + '）' : '') : (y ? y.source : '無資料'),
      spark: y ? y.points.slice(-60).map(p => p.c) : [],
    });
  });
  const sum = k => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const totalValue = sum('value'), totalCost = sum('cost');
  rows.forEach(r => { r.weight = totalValue ? (r.value || 0) / totalValue * 100 : 0; });
  const prevValue = totalValue - sum('dayPnl');
  return {
    rows: rows,
    totals: {
      value: totalValue, cost: totalCost, pnl: totalValue - totalCost,
      pnlPct: totalCost ? (totalValue / totalCost - 1) * 100 : null,
      netPnl: sum('netPnl'), dayPnl: sum('dayPnl'),
      dayPct: prevValue ? sum('dayPnl') / prevValue * 100 : null,
      missing: rows.filter(r => r.price === null).map(r => r.code),
    },
  };
}

function holdingChannels_(list) {
  const ch = [];
  list.forEach(h => {
    ch.push(h.market + '_' + h.code + '.tw');
    if (h.market === 'tse') ch.push('otc_' + h.code + '.tw'); // 不確定市場時兩邊都問
  });
  return ch;
}

function yahooCode_(h) {
  return h.code + (h.market === 'otc' ? '.TWO' : '.TW');
}

/* ---------------- 市場指標 ---------------- */

function buildIndicators_(hist, mis) {
  return CONFIG.INDICATORS.map(ind => {
    const y = hist[ind.yahoo] || null;
    const misCode = ind.mis ? ind.mis.split('_')[1].replace('.tw', '') : null;
    const q = misCode && mis[misCode] ? mis[misCode] : null;
    let price = y ? y.price : null, prev = y ? y.prevClose : null, time = y ? y.time : null, source = y ? y.source : '無資料';
    if (q && q.price !== null) { price = q.price; prev = q.prevClose; time = q.time; source = q.source; }
    const pts = y ? y.points.slice() : [];
    return {
      key: ind.key, name: ind.name, group: ind.group, digits: ind.digits, badWhenUp: !!ind.badWhenUp,
      symbol: ind.yahoo, price: price, prevClose: prev,
      chg: price !== null && prev ? price - prev : null,
      chgPct: price !== null && prev ? (price / prev - 1) * 100 : null,
      time: time, source: source,
      high52: y ? y.high52 : null, low52: y ? y.low52 : null,
      spark: pts.slice(-60).map(p => p.c),
    };
  });
}

/* ---------------- 籌碼 Sheet ---------------- */

function readChips_(limit) {
  const sh = ss_().getSheetByName(CONFIG.SHEETS.CHIPS);
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues()
    .filter(r => r[0] !== '')
    .map(r => ({ date: cellDate_(r[0]), foreign: num_(r[1]), trust: num_(r[2]), dealer: num_(r[3]), total: num_(r[4]),
      margin: num_(r[5]), marginChg: num_(r[6]), updated: r[7] instanceof Date ? fmtDate_(r[7], 'yyyy-MM-dd HH:mm') : String(r[7] || '') }))
    .sort((a, b) => a.date < b.date ? -1 : 1);
  return limit ? rows.slice(-limit) : rows;
}

/* ---------------- 觀察筆記 ---------------- */

function readNotes_() {
  const sh = ss_().getSheetByName(CONFIG.SHEETS.NOTES);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .filter(r => r[2] || r[3])
    .map(r => ({ date: cellDate_(r[0]), tag: String(r[1] || ''), title: String(r[2] || ''), body: String(r[3] || '') }))
    .reverse();
}

/* ---------------- 前端 API ---------------- */

/** 首次載入：全部資料 */
function getDashboard() {
  const errors = [];
  const st = settings_();
  const holdings = readHoldings_();

  const yahooSyms = CONFIG.INDICATORS.map(i => i.yahoo).concat(holdings.map(yahooCode_));
  const hist = yahooMany_(yahooSyms, '1y', '1d');

  const misCh = CONFIG.INDICATORS.filter(i => i.mis).map(i => i.mis).concat(holdingChannels_(holdings));
  const mis = misQuotes_(misCh);

  const histByCode = {};
  holdings.forEach(h => {
    let y = hist[yahooCode_(h)];
    if (!y) { y = twseStockDay_(h.code, 3); if (!y) errors.push(h.code + ' 歷史價格抓取失敗'); }
    if (y) histByCode[h.code] = y;
  });
  CONFIG.INDICATORS.forEach(i => { if (!hist[i.yahoo]) errors.push(i.name + ' 資料抓取失敗'); });
  if (!Object.keys(mis).length) errors.push('證交所即時報價暫時無回應，改用 Yahoo 收盤資料');

  const chips = readChips_(120);
  const indicators = buildIndicators_(hist, mis);

  return {
    asOf: Date.now(),
    market: marketState_(),
    settings: { refreshSec: Number(st['自動刷新秒數']) || 60, feeDiscount: st['手續費折扣'] },
    indicators: indicators,
    signals: computeSignals_(hist, mis, chips, st),
    holdings: enrichHoldings_(holdings, mis, histByCode, st),
    chips: chips,
    notes: readNotes_(),
    links: CONFIG.LINKS,
    sheetUrl: 'https://docs.google.com/spreadsheets/d/' + getSheetId_() + '/edit',
    errors: errors,
  };
}

/** 盤中自動刷新：只更新台股即時報價與持股損益 */
function getLive() {
  const st = settings_();
  const holdings = readHoldings_();
  const misCh = CONFIG.INDICATORS.filter(i => i.mis).map(i => i.mis).concat(holdingChannels_(holdings));
  const mis = misQuotes_(misCh);
  const hist = yahooMany_(holdings.map(yahooCode_), '1y', '1d'); // 已快取，不會重抓
  const histByCode = {};
  holdings.forEach(h => { if (hist[yahooCode_(h)]) histByCode[h.code] = hist[yahooCode_(h)]; });
  const ind = {};
  CONFIG.INDICATORS.filter(i => i.mis).forEach(i => {
    const q = mis[i.mis.split('_')[1].replace('.tw', '')];
    if (q && q.price !== null) ind[i.key] = { price: q.price, prevClose: q.prevClose, chg: q.price - q.prevClose,
      chgPct: q.prevClose ? (q.price / q.prevClose - 1) * 100 : null, time: q.time, source: q.source };
  });
  return { asOf: Date.now(), market: marketState_(), indicators: ind, holdings: enrichHoldings_(holdings, mis, histByCode, st) };
}

/**
 * 個股／指標的歷史走勢
 * @param {string} id 持股代號（如 0050）或指標 key（如 SOX）
 * @param {string} range 1mo|3mo|6mo|1y|2y|5y
 */
function getHistory(id, range) {
  const allowed = ['1mo', '3mo', '6mo', '1y', '2y', '5y'];
  if (allowed.indexOf(range) < 0) range = '6mo';
  const ind = CONFIG.INDICATORS.filter(i => i.key === id)[0];
  let sym, fallbackCode = null;
  if (ind) sym = ind.yahoo;
  else {
    const h = readHoldings_().filter(x => x.code === normCode_(id))[0];
    if (!h) throw new Error('找不到代號 ' + id);
    sym = yahooCode_(h); fallbackCode = h.code;
  }
  const interval = range === '5y' ? '1wk' : '1d';
  let y = yahooMany_([sym], range, interval)[sym];
  if (!y && fallbackCode) {
    const months = { '1mo': 2, '3mo': 3, '6mo': 6, '1y': 12, '2y': 12, '5y': 12 }[range];
    y = twseStockDay_(fallbackCode, months);
  }
  if (!y) throw new Error('暫時抓不到 ' + id + ' 的歷史資料');
  // 近 12 個月配息（只對持股計算）
  let ttmDiv = null;
  if (fallbackCode) {
    const y1 = range === '1y' ? y : yahooMany_([sym], '1y', '1d')[sym];
    if (y1 && y1.dividends) {
      const since = Date.now() - 365 * 86400000;
      ttmDiv = y1.dividends.filter(d => d.t >= since).reduce((a, d) => a + d.amount, 0);
    }
  }
  return { id: id, range: range, interval: interval, points: y.points, dividends: y.dividends || [], ttmDiv: ttmDiv, source: y.source };
}

/** 從網頁按鈕手動更新今日籌碼 */
function refreshChips() {
  const r = updateChipsForDate_(new Date());
  return { ok: !!r, row: r, chips: readChips_(120) };
}
