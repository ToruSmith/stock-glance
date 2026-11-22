/**
 * 交易帳本：每一筆買進／賣出記在「交易紀錄」分頁，
 * 持股數量、平均成本（平均成本法）、已實現損益都由這裡算出。
 * 「持股」分頁會在每次新增或刪除交易後自動重建，方便在 Sheet 裡瀏覽。
 */

const TX_HEAD = ['日期', '代號', '名稱', '動作', '股數', '成交價', '手續費', '交易稅', '淨收付', '類型', '市場', '備註', 'ID'];

function ledgerSheet_() {
  return ss_().getSheetByName(CONFIG.SHEETS.LEDGER);
}

/** @return {Array|null} 沒有交易紀錄分頁時回傳 null（改用舊的持股分頁） */
function readTxs_() {
  const sh = ledgerSheet_();
  if (!sh) return null;
  if (sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, TX_HEAD.length).getValues().map((r, i) => ({
    row: i + 2,
    date: cellDate_(r[0]),
    code: normCode_(r[1]),
    name: String(r[2] || '').trim(),
    side: String(r[3]).indexOf('賣') >= 0 ? 'sell' : 'buy',
    shares: Number(r[4]) || 0,
    price: Number(r[5]) || 0,
    fee: Number(r[6]) || 0,
    tax: Number(r[7]) || 0,
    type: String(r[9] || '').trim(),
    market: String(r[10] || '').indexOf('櫃') >= 0 ? 'otc' : 'tse',
    note: String(r[11] || ''),
    id: String(r[12] || ''),
  })).filter(t => t.code && t.shares > 0);
}

/** 依日期（期初的空白日期排最前）與輸入順序，用平均成本法彙總 */
function aggregate_(txs) {
  const map = {}, order = [];
  const sorted = txs.slice().sort((a, b) => (a.date === b.date ? a.row - b.row : (a.date < b.date ? -1 : 1)));
  sorted.forEach(t => {
    let h = map[t.code];
    if (!h) {
      h = map[t.code] = { code: t.code, name: t.name || t.code, type: t.type || (/^00/.test(t.code) ? 'ETF' : '股票'),
        market: t.market, shares: 0, cost: 0, realized: 0, txs: [] };
      order.push(t.code);
    }
    if (t.name) h.name = t.name;
    let realized = null;
    if (t.side === 'buy') {
      h.shares += t.shares;
      h.cost += t.shares * t.price + t.fee;
    } else {
      const q = Math.min(t.shares, h.shares);
      const avg = h.shares ? h.cost / h.shares : 0;
      realized = q * t.price - t.fee - t.tax - avg * q;
      h.realized += realized;
      h.cost -= avg * q;
      h.shares -= q;
      if (h.shares <= 0) { h.shares = 0; h.cost = 0; }
    }
    h.txs.push({ id: t.id, date: t.date, side: t.side, shares: t.shares, price: t.price, fee: t.fee, tax: t.tax, note: t.note,
      realized: realized === null ? null : Math.round(realized) });
  });
  return order.map(c => map[c]);
}

/** 讀取投資組合：{ positions, realized, closed } */
function readPortfolio_() {
  const txs = readTxs_();
  if (txs === null) return { positions: readHoldingsSheet_(), realized: 0, closed: [], ledger: false };
  const notes = {};
  readHoldingsSheet_().forEach(h => { if (h.note) notes[h.code] = h.note; });
  const agg = aggregate_(txs);
  const positions = agg.filter(h => h.shares > 0).map(h => ({
    code: h.code, name: h.name, shares: h.shares, avg: h.cost / h.shares, cost: Math.round(h.cost),
    type: h.type, market: h.market, note: notes[h.code] || '', realized: Math.round(h.realized), txs: h.txs.slice().reverse(),
  }));
  const closed = agg.filter(h => h.shares === 0).map(h => ({ code: h.code, name: h.name, realized: Math.round(h.realized), txs: h.txs.slice().reverse() }));
  return { positions: positions, realized: Math.round(agg.reduce((a, h) => a + h.realized, 0)), closed: closed, ledger: true };
}

/** 依交易紀錄重建「持股」分頁（保留原本的備註欄） */
function rebuildHoldingsSheet_() {
  const pf = readPortfolio_();
  if (!pf.ledger) return;
  const sh = ss_().getSheetByName(CONFIG.SHEETS.HOLDINGS);
  if (!sh) return;
  const rows = pf.positions.map(h => [h.code, h.name, h.shares, Math.round(h.avg * 10000) / 10000, h.cost, h.type,
    h.market === 'otc' ? '上櫃' : '上市', h.note]);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 8).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, 8).setValues(rows);
  }
}

/* ---------------- 手續費 ---------------- */

function buyFee_(amount, shares, st) {
  const odd = shares % 1000 !== 0;
  const min = odd ? (Number(st['零股最低手續費']) || 1) : (Number(st['最低手續費']) || 20);
  return Math.max(min, Math.floor(amount * 0.001425 * (Number(st['手續費折扣']) || 1)));
}

function sellTax_(amount, type) {
  return Math.floor(amount * (/ETF/i.test(type) ? 0.001 : 0.003));
}

/* ---------------- 新增／刪除交易 ---------------- */

/**
 * @param {Object} tx { code, side:'buy'|'sell', shares, price, date?, fee?, tax?, note? }
 */
function addTx_(tx) {
  const code = normCode_(tx.code);
  const side = tx.side === 'sell' ? 'sell' : 'buy';
  const shares = Math.round(Number(tx.shares));
  const price = Number(tx.price);
  if (!/^[0-9A-Z]{4,7}$/.test(code)) throw new Error('代號格式不正確');
  if (!(shares > 0)) throw new Error('股數必須大於 0');
  if (!(price > 0)) throw new Error('成交價必須大於 0');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(tx.date || '')) ? tx.date : Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ledgerSheet_();
    if (!sh) throw new Error('找不到「交易紀錄」分頁，請先執行 setup');
    const pf = readPortfolio_();
    const held = pf.positions.filter(h => h.code === code)[0];
    let info = held ? { name: held.name, type: held.type, market: held.market } : null;
    if (!info) {
      const s = securities_().list.filter(x => x[0] === code)[0];
      if (!s && side === 'buy') throw new Error('查不到代號 ' + code);
      if (s) info = { name: s[1], type: /^00/.test(code) ? 'ETF' : '股票', market: s[2] === 'o' ? 'otc' : 'tse' };
    }
    if (side === 'sell' && (!held || held.shares < shares)) throw new Error('賣出股數超過持有股數（目前 ' + (held ? held.shares : 0) + ' 股）');

    const st = settings_();
    const amount = shares * price;
    const fee = tx.fee !== undefined && tx.fee !== '' && isFinite(Number(tx.fee)) ? Math.round(Number(tx.fee)) : buyFee_(amount, shares, st);
    const tax = side === 'sell' ? (tx.tax !== undefined && tx.tax !== '' && isFinite(Number(tx.tax)) ? Math.round(Number(tx.tax)) : sellTax_(amount, info.type)) : 0;
    const net = side === 'buy' ? -Math.round(amount + fee) : Math.round(amount - fee - tax);
    const id = Utilities.getUuid().slice(0, 8);
    const row = [date, code, info.name, side === 'buy' ? '買進' : '賣出', shares, price, fee, tax, net, info.type,
      info.market === 'otc' ? '上櫃' : '上市', String(tx.note || '').slice(0, 200), id];
    const r = sh.getLastRow() + 1;
    sh.getRange(r, 1, 1, 2).setNumberFormat('@');
    sh.getRange(r, 13).setNumberFormat('@');
    sh.getRange(r, 1, 1, row.length).setValues([row]);
    SpreadsheetApp.flush();
    rebuildHoldingsSheet_();
    return { id: id, row: row };
  } finally {
    lock.releaseLock();
  }
}

function deleteTx_(id) {
  if (!id) throw new Error('缺少交易 ID');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ledgerSheet_();
    const last = sh.getLastRow();
    if (last < 2) throw new Error('找不到這筆交易');
    const ids = sh.getRange(2, 13, last - 1, 1).getValues().map(r => String(r[0]));
    const idx = ids.indexOf(String(id));
    if (idx < 0) throw new Error('找不到這筆交易');
    sh.deleteRow(idx + 2);
    SpreadsheetApp.flush();
    rebuildHoldingsSheet_();
    return { deleted: id };
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- 上市櫃代號表（給搜尋用） ---------------- */

function cacheGetBig_(key) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(key + ':n'));
  if (!n) return null;
  const parts = c.getAll(Array.from({ length: n }, (_, i) => key + ':' + i));
  let s = '';
  for (let i = 0; i < n; i++) { const p = parts[key + ':' + i]; if (!p) return null; s += p; }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function cachePutBig_(key, obj, sec) {
  const s = JSON.stringify(obj), size = 90000, map = {};
  const n = Math.ceil(s.length / size);
  for (let i = 0; i < n; i++) map[key + ':' + i] = s.slice(i * size, (i + 1) * size);
  map[key + ':n'] = String(n);
  try { CacheService.getScriptCache().putAll(map, sec); } catch (e) { /* 略過 */ }
}

/**
 * @return {{list: Array<[code, name, 't'|'o', close]>, asOf: number}}
 */
function securities_() {
  const hit = cacheGetBig_('secs');
  if (hit) return hit;
  const urls = ['https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
    'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes'];
  let resps = [];
  try { resps = UrlFetchApp.fetchAll(urls.map(req_)); } catch (e) { resps = []; }
  const tse = parseJson_(resps[0]) || [], otc = parseJson_(resps[1]) || [];
  const ok = c => /^\d{4}$/.test(c) || /^00\d{2,4}[A-Z]?$/.test(c);
  const seen = {}, list = [];
  const push = (c, n, m, p) => {
    c = String(c || '').trim().toUpperCase();
    if (!c || seen[c] || !ok(c)) return;
    seen[c] = 1;
    list.push([c, String(n || '').trim(), m, num_(p)]);
  };
  tse.forEach(r => push(r.Code, r.Name, 't', r.ClosingPrice));
  otc.forEach(r => push(r.SecuritiesCompanyCode || r.Code, r.CompanyName || r.Name, 'o', r.Close || r.ClosingPrice));
  const out = { list: list, asOf: Date.now() };
  if (list.length > 500) cachePutBig_('secs', out, 21600);
  return out;
}
