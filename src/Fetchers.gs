/**
 * 資料抓取：證交所即時報價 (MIS)、Yahoo Finance 日線、證交所盤後資料。
 * 所有對外請求都經過快取，避免超過 Apps Script 每日 UrlFetch 配額。
 */

const UA_ = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function num_(x) {
  if (x === null || x === undefined) return null;
  const s = String(x).replace(/,/g, '').trim();
  if (s === '' || s === '-' || s === '--' || s === 'X') return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

function cacheGet_(key) {
  try {
    const v = CacheService.getScriptCache().get(key);
    return v ? JSON.parse(v) : null;
  } catch (e) { return null; }
}

function cachePut_(key, obj, sec) {
  try {
    const s = JSON.stringify(obj);
    if (s.length < 95000) CacheService.getScriptCache().put(key, s, sec);
  } catch (e) { /* 超過快取大小就略過 */ }
}

function req_(url) {
  return { url: url, muteHttpExceptions: true, followRedirects: true, headers: { 'User-Agent': UA_, 'Accept': 'application/json,text/plain,*/*' } };
}

function parseJson_(resp) {
  if (!resp || resp.getResponseCode() !== 200) return null;
  try { return JSON.parse(resp.getContentText()); } catch (e) { return null; }
}

/* ---------------- 證交所 MIS 即時報價 ---------------- */

/**
 * @param {string[]} channels 例如 ['tse_0050.tw','tse_t00.tw','otc_6488.tw']
 * @return {Object} 以代號（c 欄位，指數為 t00）為 key 的報價
 */
function misQuotes_(channels) {
  if (!channels.length) return {};
  const key = 'mis:' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, channels.join('|')));
  const hit = cacheGet_(key);
  if (hit) return hit;

  const out = {};
  // MIS 一次查詢不宜過多，分批
  const batches = [];
  for (let i = 0; i < channels.length; i += 20) batches.push(channels.slice(i, i + 20));
  const reqs = batches.map(b => req_('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?json=1&delay=0&ex_ch=' +
    encodeURIComponent(b.join('|')) + '&_=' + Date.now()));
  let resps = [];
  try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { return out; }

  resps.forEach(r => {
    const j = parseJson_(r);
    if (!j || !j.msgArray) return;
    j.msgArray.forEach(m => {
      const prev = num_(m.y);
      const firstOf = s => (s ? num_(String(s).split('_')[0]) : null);
      let price = num_(m.z);
      let priceKind = 'trade';
      if (price === null) { price = firstOf(m.b); priceKind = 'bid'; }
      if (price === null) { price = firstOf(m.a); priceKind = 'ask'; }
      if (price === null) { price = prev; priceKind = 'prev'; }
      out[m.c] = {
        code: m.c,
        name: m.n,
        ex: m.ex,
        price: price,
        priceKind: priceKind,
        prevClose: prev,
        open: num_(m.o),
        high: num_(m.h),
        low: num_(m.l),
        volume: num_(m.v),            // 累積成交量（張）
        time: m.tlong ? Number(m.tlong) : Date.now(),
        source: '證交所即時',
      };
    });
  });
  cachePut_(key, out, CONFIG.CACHE.QUOTE_SEC);
  return out;
}

/* ---------------- Yahoo Finance 日線 ---------------- */

function yahooUrl_(symbol, range, interval, host) {
  return 'https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) +
    '?range=' + range + '&interval=' + interval + '&includePrePost=false&events=div';
}

function parseYahoo_(j, symbol) {
  if (!j || !j.chart || !j.chart.result || !j.chart.result[0]) return null;
  const r = j.chart.result[0];
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const pts = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c === null || c === undefined) continue;
    pts.push({ t: ts[i] * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: c, v: q.volume ? q.volume[i] : null });
  }
  const m = r.meta || {};
  const n = pts.length;
  const price = (m.regularMarketPrice !== undefined && m.regularMarketPrice !== null) ? m.regularMarketPrice : (n ? pts[n - 1].c : null);
  // 若最後一根 K 棒就是最新交易日，前一根收盤就是昨收
  let prev = null;
  if (n >= 2) {
    const lastDay = Utilities.formatDate(new Date(pts[n - 1].t), m.exchangeTimezoneName || 'UTC', 'yyyyMMdd');
    const mktDay = m.regularMarketTime ? Utilities.formatDate(new Date(m.regularMarketTime * 1000), m.exchangeTimezoneName || 'UTC', 'yyyyMMdd') : lastDay;
    prev = lastDay === mktDay ? pts[n - 2].c : pts[n - 1].c;
  }
  const divs = [];
  if (r.events && r.events.dividends) {
    Object.keys(r.events.dividends).forEach(k => {
      const d = r.events.dividends[k];
      divs.push({ t: d.date * 1000, amount: d.amount });
    });
    divs.sort((a, b) => a.t - b.t);
  }
  return {
    symbol: symbol,
    price: price,
    prevClose: prev,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    currency: m.currency || '',
    high52: m.fiftyTwoWeekHigh || null,
    low52: m.fiftyTwoWeekLow || null,
    points: pts,
    dividends: divs,
    source: 'Yahoo Finance',
  };
}

/**
 * 一次抓多個代號的日線（平行請求）。
 * @return {Object} symbol -> parsed
 */
function yahooMany_(symbols, range, interval) {
  range = range || '6mo';
  interval = interval || '1d';
  const out = {};
  const need = [];
  symbols.forEach(s => {
    const hit = cacheGet_('y:' + s + ':' + range + ':' + interval);
    if (hit) out[s] = hit; else need.push(s);
  });
  if (!need.length) return out;

  let resps = [];
  try { resps = UrlFetchApp.fetchAll(need.map(s => req_(yahooUrl_(s, range, interval, 'query1')))); } catch (e) { resps = []; }
  const retry = [];
  need.forEach((s, i) => {
    const p = parseYahoo_(parseJson_(resps[i]), s);
    if (p) { out[s] = p; cachePut_('y:' + s + ':' + range + ':' + interval, p, CONFIG.CACHE.HISTORY_SEC); }
    else retry.push(s);
  });
  if (retry.length) {
    try { resps = UrlFetchApp.fetchAll(retry.map(s => req_(yahooUrl_(s, range, interval, 'query2')))); } catch (e) { resps = []; }
    retry.forEach((s, i) => {
      const p = parseYahoo_(parseJson_(resps[i]), s);
      if (p) { out[s] = p; cachePut_('y:' + s + ':' + range + ':' + interval, p, CONFIG.CACHE.HISTORY_SEC); }
    });
  }
  return out;
}

/* ---------------- 證交所個股月成交資訊（Yahoo 失敗時的備援） ---------------- */

function rocToMs_(s) {
  // '115/11/20' -> ms
  const p = String(s).trim().split('/');
  if (p.length !== 3) return null;
  return new Date(Number(p[0]) + 1911, Number(p[1]) - 1, Number(p[2])).getTime();
}

function twseStockDay_(code, months) {
  const key = 'sd:' + code + ':' + months;
  const hit = cacheGet_(key);
  if (hit) return hit;
  const now = new Date();
  const reqs = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    reqs.push(req_('https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?response=json&stockNo=' + encodeURIComponent(code) +
      '&date=' + Utilities.formatDate(d, CONFIG.TZ, 'yyyyMMdd')));
  }
  const pts = [];
  // 證交所有頻率限制，逐一請求並稍作間隔
  reqs.forEach((r, i) => {
    if (i) Utilities.sleep(400);
    let j = null;
    try { j = parseJson_(UrlFetchApp.fetch(r.url, r)); } catch (e) { j = null; }
    if (!j || j.stat !== 'OK' || !j.data) return;
    j.data.forEach(row => {
      const t = rocToMs_(row[0]);
      const c = num_(row[6]);
      if (t && c !== null) pts.push({ t: t, o: num_(row[3]), h: num_(row[4]), l: num_(row[5]), c: c, v: num_(row[1]) });
    });
  });
  if (!pts.length) return null;
  const n = pts.length;
  const res = { symbol: code, price: pts[n - 1].c, prevClose: n > 1 ? pts[n - 2].c : null, time: pts[n - 1].t, points: pts, dividends: [], source: '證交所' };
  cachePut_(key, res, CONFIG.CACHE.HISTORY_SEC);
  return res;
}

/* ---------------- 證交所盤後籌碼 ---------------- */

/** 三大法人買賣金額（元 → 億） */
function twseInstitutional_(yyyymmdd) {
  const url = 'https://www.twse.com.tw/rwd/zh/fund/BFI82U?type=day&response=json&dayDate=' + yyyymmdd;
  const j = parseJson_(UrlFetchApp.fetch(url, req_(url)));
  if (!j || j.stat !== 'OK' || !j.data) return null;
  let foreign = 0, trust = 0, dealer = 0, total = null;
  j.data.forEach(row => {
    const name = String(row[0]);
    const diff = num_(row[3]) || 0;
    if (name.trim().indexOf('外資自營商') === 0) return; // 「外資自營商」列已含在自營商內，也不計入合計
    if (name.indexOf('外資及陸資') >= 0 || name.indexOf('外資') === 0) foreign += diff;
    else if (name.indexOf('投信') >= 0) trust += diff;
    else if (name.indexOf('自營商') >= 0) dealer += diff;
    else if (name.indexOf('合計') >= 0) total = diff;
  });
  const yi = v => Math.round(v / 1e6) / 100; // 元 → 億，保留兩位
  return { foreign: yi(foreign), trust: yi(trust), dealer: yi(dealer), total: yi(total !== null ? total : foreign + trust + dealer) };
}

/** 融資餘額（仟元 → 億） */
function twseMargin_(yyyymmdd) {
  const url = 'https://www.twse.com.tw/rwd/zh/marginTrading/MI_MARGN?response=json&selectType=MS&date=' + yyyymmdd;
  const j = parseJson_(UrlFetchApp.fetch(url, req_(url)));
  if (!j || j.stat !== 'OK') return null;
  // 新版格式：tables[]；舊版：creditFields / creditList
  const tables = j.tables ? j.tables.slice() : [];
  if (j.creditList) tables.push({ fields: j.creditFields, data: j.creditList });
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    if (!t || !t.data) continue;
    const fields = t.fields || [];
    let iToday = fields.indexOf('今日餘額'); if (iToday < 0) iToday = 5;
    let iPrev = fields.indexOf('前日餘額'); if (iPrev < 0) iPrev = 4;
    for (let k = 0; k < t.data.length; k++) {
      const row = t.data[k];
      if (String(row[0]).indexOf('融資金額') >= 0) {
        const today = num_(row[iToday]);
        const prev = num_(row[iPrev]);
        if (today === null) return null;
        return { balance: Math.round(today / 1e3) / 100, change: prev !== null ? Math.round((today - prev) / 1e3) / 100 : null };
      }
    }
  }
  return null;
}
