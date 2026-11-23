/**
 * Stock Glance — JSON API（給 GitHub Pages 上的網頁呼叫）
 *
 * GET ?api=dashboard|live|history|refreshChips&key=API金鑰[&id=代號&range=6mo]
 * 回傳 { ok: true, data } 或 { ok: false, error }
 * 部署設定：執行身分「我」、存取權「任何人」。資料由 API 金鑰保護。
 */

/** API 版本：2 起支援配息入帳、資產分類與核心／衛星。網頁會依此判斷要不要開放新功能 */
const API_VERSION = 2;

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (!p.api) return json_({ ok: true, name: 'Stock Glance API', hint: '請從 GitHub Pages 網頁使用' });
  if (!checkKey_(p.key)) return json_({ ok: false, error: 'unauthorized' });
  try {
    let data;
    switch (p.api) {
      case 'dashboard': data = getDashboard(); break;
      case 'live': data = getLive(); break;
      case 'history': data = getHistory(String(p.id || ''), String(p.range || '6mo')); break;
      case 'refreshChips': data = refreshChips(); break;
      case 'securities': data = securities_(); break;
      default: throw new Error('未知的 api：' + p.api);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * 寫入用：POST body 為 JSON 字串 { key, action, ... }
 * action: addTx { tx: {code, side:'buy'|'sell'|'div', shares, price, date?, fee?, tax?, note?} }
 *       | deleteTx { id } | setRole { code, role:'核心'|'衛星'|'' }
 */
function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  if (!checkKey_(body.key)) return json_({ ok: false, error: 'unauthorized' });
  try {
    let data;
    switch (body.action) {
      case 'addTx': data = addTx_(body.tx || {}); break;
      case 'deleteTx': data = deleteTx_(String(body.id || '')); break;
      case 'setRole': data = setRole_(String(body.code || ''), String(body.role || '')); break;
      default: throw new Error('未知的 action：' + body.action);
    }
    return json_({ ok: true, data: data });
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(k) {
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  return !!key && typeof k === 'string' && k === key;
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
  return readPortfolio_().positions;
}

/** 舊版：直接讀「持股」分頁（沒有交易紀錄分頁時使用） */
function readHoldingsSheet_() {
  const sh = ss_().getSheetByName(CONFIG.SHEETS.HOLDINGS);
  if (!sh) return [];
  const rows = sh.getDataRange().getValues();
  const head = rows.shift().map(h => String(h).trim());
  const col = name => head.indexOf(name);
  const iCode = col('代號'), iName = col('名稱'), iShares = col('股數'), iAvg = col('成交均價'),
    iCost = col('投入成本'), iType = col('類型'), iMkt = col('市場'), iNote = col('備註'), iRole = col('角色');
  return rows.filter(r => r[iCode] !== '' && r[iCode] !== null).map(r => {
    const shares = Number(r[iShares]) || 0;
    const avg = Number(r[iAvg]) || 0;
    const cost = iCost >= 0 && r[iCost] !== '' ? Number(r[iCost]) : Math.round(avg * shares);
    const code = normCode_(r[iCode]);
    const type = iType >= 0 && r[iType] ? String(r[iType]) : (/^00/.test(code) ? 'ETF' : '股票');
    const mkt = iMkt >= 0 && String(r[iMkt]).indexOf('櫃') >= 0 ? 'otc' : 'tse';
    return { code: code, name: iName >= 0 ? String(r[iName]) : code, shares: shares, avg: avg, cost: cost,
      type: type, market: mkt, note: iNote >= 0 ? String(r[iNote] || '') : '',
      role: iRole >= 0 ? String(r[iRole] || '').trim() : '' };
  });
}

function sellCost_(value, type, st) {
  if (!value) return { fee: 0, tax: 0 };
  const fee = Math.max(Number(st['最低手續費']) || 20, Math.floor(value * 0.001425 * (Number(st['手續費折扣']) || 1)));
  const taxRate = /ETF/i.test(type) ? 0.001 : 0.003;
  return { fee: fee, tax: Math.floor(value * taxRate) };
}

function settingsOut_(st) {
  return { refreshSec: Number(st['自動刷新秒數']) || 60, feeDiscount: Number(st['手續費折扣']) || 1,
    minFee: Number(st['最低手續費']) || 20, oddMinFee: Number(st['零股最低手續費']) || 1,
    satMax: limit_(st, '衛星比重上限(%)'), satOneMax: limit_(st, '單一衛星上限(%)') };
}

/** 設定分頁的百分比上限；空白或非數字時用預設值，0 代表不提醒 */
function limit_(st, k) {
  const v = Number(st[k]);
  return isFinite(v) && st[k] !== '' && st[k] !== null ? v : CONFIG.DEFAULTS[k];
}

/* ---------------- 資產分類（類別比重與核心／衛星） ---------------- */

/**
 * 依代號、名稱與「備註」判斷：
 *   style 風格：市值型｜高股息｜主動式｜主題型｜債券｜槓桿反向｜個股
 *   asset 資產類別：台股｜海外股票｜債券
 *   autoRole 預設角色：市值型、債券、海外市值型 → 核心；其他 → 衛星
 * 判斷不準時，在 Sheet「持股」分頁的備註寫上「市值型」「高股息」「債券」「海外」等字即可覆蓋。
 */
function classify_(h) {
  const code = String(h.code || ''), name = String(h.name || ''), note = String(h.note || '');
  const s = name + ' ' + note;
  const isEtf = /ETF/i.test(h.type || '') || /^00/.test(code);
  let style;
  if (/債/.test(s) || /^00\d{2,4}B$/.test(code)) style = '債券';
  else if (/正2|反1|反向|槓桿/.test(name) || /^00\d{2,4}[LR]$/.test(code)) style = '槓桿反向';
  else if (/主動/.test(s) || /^00\d{2,4}A$/.test(code)) style = '主動式';
  else if (/高息|高股息|優息|股息|收益|填息|月配/.test(s)) style = '高股息';
  else if (/市值|台灣50|台50|TOP\s?50|臺灣50|中型100|全球|美國|標普|S&P|那斯達克|日本|歐洲|全市場|指數/i.test(s)) style = '市值型';
  else if (isEtf) style = '主題型';
  else style = '個股';
  let asset = '台股';
  if (style === '債券') asset = '債券';
  else if (/海外|全球|美國|標普|S&P|那斯達克|NASDAQ|費城|日本|日經|歐洲|中國|印度|越南|韓國|美股/i.test(s)) asset = '海外股票';
  const autoRole = style === '市值型' || style === '債券' ? '核心' : '衛星';
  return { style: style, asset: asset, autoRole: autoRole };
}

/** 依權重彙總成 [{ name, weight, value }]，由大到小 */
function groupWeights_(rows, key, total) {
  const m = {};
  rows.forEach(r => { m[r[key]] = (m[r[key]] || 0) + (r.value || 0); });
  return Object.keys(m).map(k => ({ name: k, value: m[k], weight: total ? m[k] / total * 100 : 0 }))
    .sort((a, b) => b.value - a.value);
}

/** 依「設定」分頁的規則產生提醒 */
function ruleWarnings_(rows, byRole, byAsset, st) {
  const out = [];
  const satMax = limit_(st, '衛星比重上限(%)'), oneMax = limit_(st, '單一衛星上限(%)');
  const sat = byRole.filter(g => g.name === '衛星')[0];
  if (satMax > 0 && sat && sat.weight > satMax + 0.05)
    out.push('衛星部位合計占 ' + sat.weight.toFixed(1) + '%，超過你設定的上限 ' + satMax + '%');
  if (oneMax > 0) rows.filter(r => r.role === '衛星' && r.weight > oneMax + 0.05).forEach(r =>
    out.push(r.name + '（' + r.code + '）占 ' + r.weight.toFixed(1) + '%，超過單一衛星上限 ' + oneMax + '%'));
  if (rows.length >= 2 && byAsset.length === 1)
    out.push('全部持股都屬於「' + byAsset[0].name + '」，大盤下跌時會一起跌；可以考慮是否需要其他類別分散');
  return out;
}

function enrichHoldings_(list, quotes, hist, st, pf) {
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
    const divs = h.divs || 0;
    const cl = classify_(h);
    return Object.assign({}, h, {
      price: price, prevClose: prev,
      chg: price !== null && prev ? price - prev : null,
      chgPct: price !== null && prev ? (price / prev - 1) * 100 : null,
      value: value, pnl: pnl, pnlPct: pnl !== null && h.cost ? pnl / h.cost * 100 : null,
      // 含息損益＝未實現損益＋這一檔累計領到的配息
      divs: divs,
      totalPnl: pnl !== null ? pnl + divs : null,
      totalPct: pnl !== null && h.cost ? (pnl + divs) / h.cost * 100 : null,
      style: cl.style, asset: cl.asset, autoRole: cl.autoRole,
      role: h.role === '核心' || h.role === '衛星' ? h.role : cl.autoRole, roleSet: h.role === '核心' || h.role === '衛星',
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
  const byAsset = groupWeights_(rows, 'asset', totalValue);
  const byStyle = groupWeights_(rows, 'style', totalValue);
  const byRole = groupWeights_(rows, 'role', totalValue);
  const realized = pf ? pf.realized || 0 : 0;
  const divsAll = pf && pf.divs !== undefined ? pf.divs : sum('divs'); // 含已出清持股領過的配息
  const pnl = totalValue - totalCost;
  return {
    rows: rows,
    totals: {
      value: totalValue, cost: totalCost, pnl: pnl,
      pnlPct: totalCost ? (totalValue / totalCost - 1) * 100 : null,
      netPnl: sum('netPnl'), dayPnl: sum('dayPnl'),
      dayPct: prevValue ? sum('dayPnl') / prevValue * 100 : null,
      missing: rows.filter(r => r.price === null).map(r => r.code),
      realized: realized,
      divs: divsAll,
      openDivs: sum('divs'),
      // 目前持股的含息損益（未實現＋這些持股領過的配息）
      totalPnl: pnl + sum('divs'),
      totalPct: totalCost ? (pnl + sum('divs')) / totalCost * 100 : null,
      // 從開始記帳到現在的全部成果：未實現＋已實現＋全部配息
      allTimePnl: pnl + realized + divsAll,
    },
    byAsset: byAsset, byStyle: byStyle, byRole: byRole,
    warnings: ruleWarnings_(rows, byRole, byAsset, st),
    closed: pf ? pf.closed : [],
    ledger: pf ? pf.ledger : false,
  };
}

/**
 * 找出「可能還沒記錄」的配息：Yahoo 的除息資料 × 除息日當時的持股，
 * 但帳本裡沒有對應的配息紀錄（除息日前 10 天到後 75 天內）。
 * 期初庫存沒有日期，視為一直持有，所以也可能列出你其實沒領到的配息，前端可以按「忽略」。
 */
function divHints_(positions, histByCode, st) {
  const out = [];
  const DAY = 86400000;
  // 「設定」分頁可填「配息提醒起算日」（例如開始記帳的那天），更早的除息不提醒
  const raw = st ? st['配息提醒起算日'] : null; // Sheet 的日期格會被 settings_() 轉成毫秒數
  let start = null;
  if (raw instanceof Date) start = raw.getTime();
  else if (typeof raw === 'number' && raw > 1e11) start = raw;
  else if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(String(raw || '').trim()))
    start = Date.parse(String(raw).trim().replace(/\//g, '-').replace(/-(\d)(?=-|$)/g, '-0$1') + 'T00:00:00+08:00');
  if (!isFinite(start)) start = null;
  positions.forEach(h => {
    const y = histByCode[h.code];
    if (!y || !y.dividends || !y.dividends.length) return;
    const txs = (h.txs || []).slice().reverse(); // 由舊到新
    const trades = txs.filter(t => t.side !== 'div');
    const divDates = txs.filter(t => t.side === 'div' && t.date).map(t => Date.parse(t.date + 'T00:00:00+08:00'));
    const firstDated = trades.filter(t => t.date).map(t => Date.parse(t.date + 'T00:00:00+08:00'));
    const hasUndated = trades.some(t => !t.date);
    // 期初庫存沒有買進日期：沒設定起算日時只看近 120 天，避免把買進前的配息也列出來
    const since = Math.max(Date.now() - (hasUndated && start === null ? 120 : 366) * DAY, start || 0);
    y.dividends.forEach(d => {
      if (!(d.t >= since) || !(d.amount > 0)) return;
      if (!hasUndated && firstDated.length && d.t <= Math.min.apply(null, firstDated)) return;
      // 除息日「之前」買進、且到除息日前一天還持有的股數
      let sh = 0;
      trades.forEach(t => {
        const tt = t.date ? Date.parse(t.date + 'T00:00:00+08:00') : -Infinity;
        if (tt < d.t - 12 * 3600000) sh += t.side === 'sell' ? -t.shares : t.shares;
      });
      if (sh <= 0) return;
      if (divDates.some(t => t >= d.t - 10 * DAY && t <= d.t + 75 * DAY)) return;
      const gross = Math.round(sh * d.amount);
      out.push({ code: h.code, name: h.name, exDate: fmtDate_(new Date(d.t)), perShare: Math.round(d.amount * 10000) / 10000,
        shares: sh, gross: gross, deduct: divDeduct_(gross), undated: hasUndated });
    });
  });
  return out.sort((a, b) => a.exDate < b.exDate ? 1 : -1);
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
  const pf = readPortfolio_();
  const holdings = pf.positions;

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
    apiVersion: API_VERSION,
    asOf: Date.now(),
    market: marketState_(),
    settings: settingsOut_(st),
    indicators: indicators,
    signals: computeSignals_(hist, mis, chips, st),
    holdings: enrichHoldings_(holdings, mis, histByCode, st, pf),
    divHints: pf.ledger ? divHints_(holdings, histByCode, st) : [],
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
  const pf = readPortfolio_();
  const holdings = pf.positions;
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
  return { asOf: Date.now(), market: marketState_(), indicators: ind, holdings: enrichHoldings_(holdings, mis, histByCode, st, pf) };
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
