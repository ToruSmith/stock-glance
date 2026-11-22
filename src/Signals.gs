/**
 * 反彈訊號：把分析師常看的 7 個指標，轉成「偏多／中性／偏空」。
 * 規則刻意保持簡單透明，每一條都會在網頁上顯示判斷依據。
 */

function closes_(y) { return y && y.points ? y.points.map(p => p.c) : []; }

function sma_(arr, n, offset) {
  offset = offset || 0;
  const end = arr.length - offset;
  if (end < n) return null;
  let s = 0;
  for (let i = end - n; i < end; i++) s += arr[i];
  return s / n;
}

function fmtN_(v, d) {
  if (v === null || v === undefined || !isFinite(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

function pct_(a, b) { return a !== null && b ? (a / b - 1) * 100 : null; }

/** 讓最新報價（盤中）取代日線最後一根 */
function withLive_(y, q) {
  const arr = closes_(y);
  if (!q || q.price === null || q.price === undefined || !arr.length) return arr;
  const a = arr.slice();
  const lastDay = Utilities.formatDate(new Date(y.points[y.points.length - 1].t), CONFIG.TZ, 'yyyyMMdd');
  const liveDay = Utilities.formatDate(new Date(q.time || Date.now()), CONFIG.TZ, 'yyyyMMdd');
  if (lastDay === liveDay) a[a.length - 1] = q.price;
  else if (liveDay > lastDay) a.push(q.price);
  return a;
}

function computeSignals_(hist, mis, chips, st) {
  const items = [];
  const add = (key, name, state, value, rule) => items.push({ key: key, name: name, state: state, value: value, rule: rule });

  // 1. 費城半導體：止跌與否
  (function () {
    const c = closes_(hist['^SOX']);
    if (c.length < 25) return add('SOX', '費半止跌', 'na', '資料不足', '');
    const last = c[c.length - 1], prev = c[c.length - 2];
    const ma5 = sma_(c, 5), ma20 = sma_(c, 20);
    const low20 = Math.min.apply(null, c.slice(-21, -1));
    const chg = pct_(last, prev);
    let s = 'neu';
    if (last > ma5 && chg > 0) s = 'pos';
    else if (last <= low20 || (last < ma5 && chg < -2)) s = 'neg';
    add('SOX', '費半止跌', s, fmtN_(last, 0) + '（' + (chg >= 0 ? '+' : '') + fmtN_(chg, 2) + '%）',
      '站上 5 日線 ' + fmtN_(ma5, 0) + ' 且收紅為偏多；創 20 日新低或跌破 5 日線且跌逾 2% 為偏空。20 日線 ' + fmtN_(ma20, 0));
  })();

  // 2. VIX：恐慌是否退燒
  (function () {
    const c = closes_(hist['^VIX']);
    if (c.length < 10) return add('VIX', '恐慌退燒', 'na', '資料不足', '');
    const v = c[c.length - 1];
    const max10 = Math.max.apply(null, c.slice(-10));
    let s = 'neu';
    if (v < 20 || (max10 >= 30 && v <= max10 * 0.8)) s = 'pos';
    else if (v >= 30 && v >= max10 * 0.95) s = 'neg';
    add('VIX', '恐慌退燒', s, fmtN_(v, 2) + '（10 日高 ' + fmtN_(max10, 1) + '）',
      'VIX 低於 20，或從 30 以上的高點回落 20% 為偏多；仍在 30 以上且接近高點為偏空。');
  })();

  // 3. 美股大盤（標普 500）趨勢
  (function () {
    const c = closes_(hist['^GSPC']);
    if (c.length < 30) return add('SPX', '美股趨勢', 'na', '資料不足', '');
    const last = c[c.length - 1];
    const ma20 = sma_(c, 20), ma20p = sma_(c, 20, 5);
    const hi = Math.max.apply(null, c.slice(-250));
    let s = 'neu';
    if (last > ma20) s = 'pos';
    else if (ma20 < ma20p) s = 'neg';
    add('SPX', '美股趨勢', s, fmtN_(last, 0) + '（距高點 ' + fmtN_(pct_(last, hi), 1) + '%）',
      '標普 500 站上 20 日線 ' + fmtN_(ma20, 0) + ' 為偏多；在 20 日線下且 20 日線下彎為偏空。');
  })();

  // 4. 新台幣：外資資金方向
  (function () {
    const c = closes_(hist['TWD=X']);
    if (c.length < 7) return add('TWD', '台幣動向', 'na', '資料不足', '');
    const last = c[c.length - 1], base = c[c.length - 6];
    const p = pct_(last, base);
    let s = 'neu';
    if (p <= -0.3) s = 'pos'; else if (p >= 0.3) s = 'neg';
    add('TWD', '台幣動向', s, fmtN_(last, 3) + '（5 日 ' + (p >= 0 ? '台幣貶 ' : '台幣升 ') + fmtN_(Math.abs(p), 2) + '%）',
      '5 日內台幣升值逾 0.3% 代表外資匯入，偏多；貶值逾 0.3% 代表資金匯出，偏空。');
  })();

  // 5. 加權指數：短線止跌
  (function () {
    const c = withLive_(hist['^TWII'], mis['t00']);
    if (c.length < 65) return add('TAIEX', '加權止跌', 'na', '資料不足', '');
    const last = c[c.length - 1];
    const ma5 = sma_(c, 5), ma5p = sma_(c, 5, 1), ma60 = sma_(c, 60);
    let s = 'neu';
    if (last > ma5 && ma5 > ma5p) s = 'pos';
    else if (last < ma5 && last < ma60) s = 'neg';
    add('TAIEX', '加權止跌', s, fmtN_(last, 0) + '（5 日線 ' + fmtN_(ma5, 0) + '）',
      '站上 5 日線且 5 日線翻揚為偏多；同時跌破 5 日線與季線（60 日 ' + fmtN_(ma60, 0) + '）為偏空。');
  })();

  // 6. 外資買賣超（近 3 日）
  (function () {
    const rows = chips.filter(r => r.foreign !== null).slice(-3);
    if (rows.length < 3) return add('FOREIGN', '外資回補', 'na', '尚無籌碼資料', '執行 backfillChips() 或按「籌碼」頁的更新按鈕即可取得。');
    const sum = rows.reduce((a, r) => a + r.foreign, 0);
    const th = Number(st['外資大賣門檻(億)']) || 300;
    let s = 'neu';
    if (sum > 0) s = 'pos'; else if (sum < -th) s = 'neg';
    add('FOREIGN', '外資回補', s, '近 3 日 ' + (sum >= 0 ? '+' : '') + fmtN_(sum, 1) + ' 億',
      '近 3 日合計買超為偏多；合計賣超超過 ' + th + ' 億為偏空（可在設定分頁調整）。');
  })();

  // 7. 融資餘額（散戶槓桿）
  (function () {
    const rows = chips.filter(r => r.margin !== null);
    if (rows.length < 6) return add('MARGIN', '融資清洗', 'na', '尚無足夠融資資料', '需要至少 6 個交易日的融資餘額。');
    const last = rows[rows.length - 1].margin, base = rows[rows.length - 6].margin;
    const p = pct_(last, base);
    const warn = Number(st['融資警戒增幅']) || 3;
    let s = 'neu';
    if (p <= -3) s = 'pos'; else if (p >= warn) s = 'neg';
    add('MARGIN', '融資清洗', s, fmtN_(last, 0) + ' 億（5 日 ' + (p >= 0 ? '+' : '') + fmtN_(p, 1) + '%）',
      '5 日減少逾 3% 表示斷頭與去槓桿，籌碼較乾淨，偏多；增加逾 ' + warn + '% 表示散戶追價或攤平，偏空。');
  })();

  const pos = items.filter(i => i.state === 'pos').length;
  const neg = items.filter(i => i.state === 'neg').length;
  const valid = items.filter(i => i.state !== 'na').length;
  let summary;
  if (pos >= 5) summary = '多數指標轉正，反彈條件相對成熟';
  else if (neg >= 5) summary = '空方仍主導，先觀望，不急著接刀';
  else if (pos >= 3 && pos > neg) summary = '部分指標轉正，可開始留意分批布局時機';
  else if (neg > pos) summary = '偏空訊號較多，止跌尚未確認';
  else summary = '多空交錯，等待更多訊號確認';
  return { items: items, pos: pos, neg: neg, valid: valid, summary: summary };
}
