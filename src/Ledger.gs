/**
 * 交易帳本：每一筆買進／賣出／配息記在「交易紀錄」分頁，
 * 持股數量、平均成本（平均成本法）、已實現損益、累計配息都由這裡算出。
 * 「持股」分頁會在每次新增或刪除交易後自動重建，方便在 Sheet 裡瀏覽。
 *
 * 配息列的欄位意義：股數＝領息股數、成交價＝每股配息、手續費＝扣除額（二代健保補充保費＋匯費）、
 * 淨收付＝實際入帳金額。配息不影響股數與平均成本，只累計到「累計配息」。
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
  return sh.getRange(2, 1, sh.getLastRow() - 1, TX_HEAD.length).getValues().map((r, i) => {
    const t = {
      row: i + 2,
      date: cellDate_(r[0]),
      code: normCode_(r[1]),
      name: String(r[2] || '').trim(),
      side: txSide_(r[3]),
      shares: Number(r[4]) || 0,
      price: Number(r[5]) || 0,
      fee: Number(r[6]) || 0,
      tax: Number(r[7]) || 0,
      net: Number(r[8]) || 0,
      type: String(r[9] || '').trim(),
      market: String(r[10] || '').indexOf('櫃') >= 0 ? 'otc' : 'tse',
      note: String(r[11] || ''),
      id: String(r[12] || ''),
    };
    // 配息：以「淨收付」為準；沒填時用 股數 × 每股配息 − 扣除額 推回來
    if (t.side === 'div') t.amount = t.net > 0 ? t.net : Math.round(t.shares * t.price - t.fee);
    return t;
  }).filter(t => t.code && (t.side === 'div' ? t.amount > 0 : t.shares > 0));
}

/** 「動作」欄：賣出／配息（含「股利」「除息」等寫法）／其他一律視為買進 */
function txSide_(v) {
  const s = String(v || '');
  if (s.indexOf('賣') >= 0) return 'sell';
  if (/息|股利/.test(s)) return 'div';
  return 'buy';
}

/** 依日期（期初的空白日期排最前）與輸入順序，用平均成本法彙總 */
function aggregate_(txs) {
  const map = {}, order = [];
  const sorted = txs.slice().sort((a, b) => (a.date === b.date ? a.row - b.row : (a.date < b.date ? -1 : 1)));
  sorted.forEach(t => {
    let h = map[t.code];
    if (!h) {
      h = map[t.code] = { code: t.code, name: t.name || t.code, type: t.type || (/^00/.test(t.code) ? 'ETF' : '股票'),
        market: t.market, shares: 0, cost: 0, realized: 0, divs: 0, txs: [] };
      order.push(t.code);
    }
    if (t.name) h.name = t.name;
    if (t.side === 'div') {
      h.divs += t.amount;
      h.txs.push({ id: t.id, date: t.date, side: 'div', shares: t.shares, price: t.price, fee: t.fee, tax: 0, note: t.note,
        amount: Math.round(t.amount), realized: null });
      return;
    }
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

/** 讀取投資組合：{ positions, realized, divs, closed } */
function readPortfolio_() {
  const txs = readTxs_();
  if (txs === null) return { positions: readHoldingsSheet_(), realized: 0, divs: 0, closed: [], ledger: false };
  const notes = {}, roles = {};
  readHoldingsSheet_().forEach(h => { if (h.note) notes[h.code] = h.note; if (h.role) roles[h.code] = h.role; });
  const agg = aggregate_(txs);
  const positions = agg.filter(h => h.shares > 0).map(h => ({
    code: h.code, name: h.name, shares: h.shares, avg: h.cost / h.shares, cost: Math.round(h.cost),
    type: h.type, market: h.market, note: notes[h.code] || '', role: roles[h.code] || '',
    realized: Math.round(h.realized), divs: Math.round(h.divs), txs: h.txs.slice().reverse(),
  }));
  const closed = agg.filter(h => h.shares === 0).map(h => ({ code: h.code, name: h.name, realized: Math.round(h.realized),
    divs: Math.round(h.divs), txs: h.txs.slice().reverse() }));
  return { positions: positions, realized: Math.round(agg.reduce((a, h) => a + h.realized, 0)),
    divs: Math.round(agg.reduce((a, h) => a + h.divs, 0)), closed: closed, ledger: true };
}

const HOLD_HEAD = ['代號', '名稱', '股數', '成交均價', '投入成本', '類型', '市場', '備註', '角色'];

/** 舊的持股分頁沒有「角色」欄時補上表頭 */
function ensureRoleColumn_(sh) {
  const head = sh.getRange(1, 1, 1, HOLD_HEAD.length).getValues()[0];
  if (String(head[8] || '').trim() !== '角色') sh.getRange(1, 9, 1, 1).setValues([['角色']]);
}

/** 依交易紀錄重建「持股」分頁（保留原本的備註與角色欄） */
function rebuildHoldingsSheet_() {
  const pf = readPortfolio_();
  if (!pf.ledger) return;
  const sh = ss_().getSheetByName(CONFIG.SHEETS.HOLDINGS);
  if (!sh) return;
  ensureRoleColumn_(sh);
  const n = HOLD_HEAD.length;
  const rows = pf.positions.map(h => [h.code, h.name, h.shares, Math.round(h.avg * 10000) / 10000, h.cost, h.type,
    h.market === 'otc' ? '上櫃' : '上市', h.note, h.role || '']);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, n).clearContent();
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sh.getRange(2, 1, rows.length, n).setValues(rows);
  }
}

/**
 * 設定某一檔的角色（核心／衛星）；空字串代表交給程式自動判斷
 * @param {string} code
 * @param {string} role '核心' | '衛星' | ''
 */
function setRole_(code, role) {
  code = normCode_(code);
  role = role === '核心' || role === '衛星' ? role : '';
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ss_().getSheetByName(CONFIG.SHEETS.HOLDINGS);
    if (!sh || sh.getLastRow() < 2) throw new Error('找不到「持股」分頁');
    ensureRoleColumn_(sh);
    const codes = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => normCode_(r[0]));
    const idx = codes.indexOf(code);
    if (idx < 0) throw new Error('目前沒有持有 ' + code);
    sh.getRange(idx + 2, 9, 1, 1).setValues([[role]]);
    SpreadsheetApp.flush();
    return { code: code, role: role };
  } finally {
    lock.releaseLock();
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

/**
 * 配息的預估扣除額：單筆達 2 萬元時預扣 2.11% 二代健保補充保費。
 * 實際只對股利所得（54C）部分扣，ETF 配息常常只有一部分是 54C，所以只是預估，請以入帳金額為準。
 */
function divDeduct_(gross) {
  return gross >= 20000 ? Math.round(gross * 0.0211) : 0;
}

/* ---------------- 新增／刪除交易 ---------------- */

/**
 * @param {Object} tx { code, side:'buy'|'sell'|'div', shares, price, date?, fee?, tax?, note? }
 *   side='div' 時：price＝每股配息、fee＝扣除額（二代健保補充保費＋匯費，空白時自動預估）
 */
function addTx_(tx) {
  const code = normCode_(tx.code);
  const side = tx.side === 'sell' ? 'sell' : tx.side === 'div' ? 'div' : 'buy';
  const shares = Math.round(Number(tx.shares));
  const price = Number(tx.price);
  if (!/^[0-9A-Z]{4,7}$/.test(code)) throw new Error('代號格式不正確');
  if (!(shares > 0)) throw new Error(side === 'div' ? '領息股數必須大於 0' : '股數必須大於 0');
  if (!(price > 0)) throw new Error(side === 'div' ? '每股配息必須大於 0' : '成交價必須大於 0');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(tx.date || '')) ? tx.date : Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const given = v => v !== undefined && v !== null && v !== '' && isFinite(Number(v));

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = ledgerSheet_();
    if (!sh) throw new Error('找不到「交易紀錄」分頁，請先執行 setup');
    const pf = readPortfolio_();
    const held = pf.positions.filter(h => h.code === code)[0];
    const past = pf.closed.filter(h => h.code === code)[0];
    let info = held ? { name: held.name, type: held.type, market: held.market } : null;
    if (!info && past) info = { name: past.name, type: /^00/.test(code) ? 'ETF' : '股票', market: 'tse' };
    if (!info) {
      const s = securities_().list.filter(x => x[0] === code)[0];
      if (!s && side !== 'sell') throw new Error('查不到代號 ' + code);
      if (s) info = { name: s[1], type: /^00/.test(code) ? 'ETF' : '股票', market: s[2] === 'o' ? 'otc' : 'tse' };
    }
    if (side === 'sell' && (!held || held.shares < shares)) throw new Error('賣出股數超過持有股數（目前 ' + (held ? held.shares : 0) + ' 股）');
    if (side === 'div' && !held && !past) throw new Error('帳本裡沒有 ' + code + ' 的買進紀錄，無法記錄配息');

    const st = settings_();
    const amount = shares * price;
    let fee, tax = 0, net, action;
    if (side === 'div') {
      const gross = Math.round(amount);
      fee = given(tx.fee) ? Math.round(Number(tx.fee)) : divDeduct_(gross);
      if (fee < 0 || fee >= gross) throw new Error('扣除額不正確');
      net = gross - fee;
      action = '配息';
    } else {
      fee = given(tx.fee) ? Math.round(Number(tx.fee)) : buyFee_(amount, shares, st);
      tax = side === 'sell' ? (given(tx.tax) ? Math.round(Number(tx.tax)) : sellTax_(amount, info.type)) : 0;
      net = side === 'buy' ? -Math.round(amount + fee) : Math.round(amount - fee - tax);
      action = side === 'buy' ? '買進' : '賣出';
    }
    const id = Utilities.getUuid().slice(0, 8);
    const row = [date, code, info.name, action, shares, price, fee, tax, net, info.type,
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
