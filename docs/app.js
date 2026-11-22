{
/* ============ 工具 ============ */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ok = v => v !== null && v !== undefined && isFinite(v);
const fmt = (v, d = 2) => ok(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—';
const sgn = (v, d = 2) => ok(v) ? (v > 0 ? '+' : '') + fmt(v, d) : '—';
const money = v => ok(v) ? Math.round(v).toLocaleString('en-US') : '—';
const sMoney = v => ok(v) ? (v > 0 ? '+' : '') + money(v) : '—';
const cls = v => !ok(v) || Math.abs(v) < 1e-9 ? 'flat' : (v > 0 ? 'up' : 'down');
const pad = n => String(n).padStart(2, '0');
const hhmm = ms => { if (!ms) return ''; const d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const hhmmss = ms => { const d = new Date(ms); return hhmm(ms) + ':' + pad(d.getSeconds()); };
const mmdd = ms => { const d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); };
const ymd = ms => { const d = new Date(ms); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()); };
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('sg:' + k)) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sg:' + k, JSON.stringify(v)); } catch (e) {} } };
const PALETTE = ['#1d3fd8', '#0e9aa7', '#d4a017', '#7b4dd6', '#64748b', '#e07a5f', '#2f855a', '#b83280'];
const STATE_LABEL = { pos: '偏多', neu: '中性', neg: '偏空', na: '無資料' };

const S = { data: null, tab: store.get('tab', 'overview'), sort: store.get('sort', 'weight'), chipKey: 'foreign',
  noteTag: '全部', timer: null, hist: {}, detail: null, loading: false };

/* ============ API（Apps Script 網頁應用程式） ============ */
// 預設的 API 網址；可在網頁右上角的齒輪修改
const DEFAULT_API = 'https://script.google.com/macros/s/AKfycbyGY7ggEk3w_61F0tDFV0_r4-tW4aYml0GGgVem88-z6RwOUPVZ6DVtM50XLFTcn4kflw/exec';
const CFG = { url: store.get('apiUrl', DEFAULT_API), key: store.get('apiKey', '') };
const ROUTES = {
  getDashboard: () => ({ api: 'dashboard' }),
  getLive: () => ({ api: 'live' }),
  getHistory: (id, range) => ({ api: 'history', id, range }),
  refreshChips: () => ({ api: 'refreshChips' }),
};

function api(fn, ...args) {
  if (window.__MOCK__) return Promise.resolve().then(() => window.__MOCK__[fn](...args));
  if (!CFG.url || !CFG.key) return Promise.reject(Object.assign(new Error('尚未設定 API 金鑰'), { auth: true }));
  const q = new URLSearchParams(Object.assign(ROUTES[fn](...args), { key: CFG.key, _: Date.now() }));
  return fetch(CFG.url + '?' + q.toString(), { redirect: 'follow' })
    .then(r => { if (!r.ok) throw new Error('API 回應 ' + r.status); return r.text(); })
    .then(t => {
      let j;
      try { j = JSON.parse(t); } catch (e) { throw new Error('API 沒有回傳資料：請確認部署的存取權是「任何人」'); }
      if (!j.ok) throw Object.assign(new Error(j.error === 'unauthorized' ? 'API 金鑰不正確' : j.error), { auth: j.error === 'unauthorized' });
      return j.data;
    });
}

function renderSetup(msg) {
  if (!S.data) $('#mkt b').textContent = '未連線';
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== 'setup'; });
  $('.tabs').hidden = true;
  $('#v-setup').innerHTML = `
  <article class="card" id="setup">
    <h2>連線設定</h2>
    <p class="sub">這個網頁的資料來自你的 Google Apps Script。金鑰只存在這台裝置的瀏覽器裡，不會出現在 GitHub 上。</p>
    ${msg ? `<div class="banner">${esc(msg)}</div>` : ''}
    <form id="setupForm" class="form">
      <label>API 網址<input name="url" type="url" required value="${esc(CFG.url)}" autocomplete="off"></label>
      <label>API 金鑰<input name="key" type="password" required value="${esc(CFG.key)}" autocomplete="off" placeholder="在 Apps Script 執行 showApiKey 取得"></label>
      <div class="row"><button class="btn primary" type="submit">儲存並連線</button>
        ${S.data ? '<button class="btn" type="button" id="btnSetupCancel">取消</button>' : ''}</div>
    </form>
    <p class="muted small">金鑰取得方式：在 Apps Script 編輯器選擇 <b>showApiKey</b> 並執行，再到「執行記錄」複製。</p>
  </article>`;
}

function closeSetup() {
  $('.tabs').hidden = false;
  showTab(S.tab);
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ============ 圖表 ============ */
function spark(vals, color) {
  const v = (vals || []).filter(ok);
  if (v.length < 2) return '<svg class="spark" aria-hidden="true"></svg>';
  const min = Math.min(...v), max = Math.max(...v), r = max - min || 1;
  const pts = v.map((x, i) => [(i / (v.length - 1)) * 100, 28 - ((x - min) / r) * 26]);
  const d = 'M' + pts.map(p => p[0].toFixed(2) + ',' + p[1].toFixed(2)).join('L');
  return `<svg class="spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}L100,30L0,30Z" style="fill:${color};opacity:.10"/>
    <path d="${d}" style="fill:none;stroke:${color};stroke-width:1.6;stroke-linejoin:round" vector-effect="non-scaling-stroke"/></svg>`;
}

function niceStep(span, n) {
  const raw = span / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
}

/**
 * 互動折線圖。cfg: { times:[ms], series:[{name, vals, color, width, dash, area}], hlines:[{v,label,color}], digits, bars:false }
 */
function chart(box, cfg) {
  if (box.__ro) box.__ro.disconnect();
  box.innerHTML = '<svg role="img"></svg><div class="tip"></div>';
  const svg = $('svg', box), tip = $('.tip', box);
  const n = cfg.times.length;
  let geo = null;
  const draw = () => {
    const W = box.clientWidth, H = box.clientHeight;
    if (!W || !H || n < 2) { if (n < 2) svg.innerHTML = ''; return; }
    const narrow = W < 420;
    const pl = 4, pr = narrow ? 46 : 58, pt = 10, pb = 22;
    const vals = [];
    cfg.series.forEach(s => s.vals.forEach(v => ok(v) && vals.push(v)));
    (cfg.hlines || []).forEach(h => ok(h.v) && vals.push(h.v));
    if (cfg.bars) vals.push(0);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const padv = (max - min) * 0.06; min -= padv; max += padv;
    const iw = W - pl - pr, ih = H - pt - pb;
    const step = iw / (cfg.bars ? n : n - 1);
    const x = i => pl + (cfg.bars ? (i + 0.5) * step : i * step);
    const y = v => pt + (max - v) / (max - min) * ih;
    geo = { x, y, pl, pr, iw, W, H, step };
    let g = '';
    // 格線與右側刻度
    const ts = niceStep(max - min, narrow ? 3 : 4);
    for (let v = Math.ceil(min / ts) * ts; v <= max; v += ts) {
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}" style="stroke:var(--line)" stroke-width="1"/>`;
      g += `<text x="${W - pr + 6}" y="${y(v) + 4}" style="fill:var(--muted);font:11px var(--num)">${fmt(v, cfg.axisDigits ?? (ts < 1 ? 2 : 0))}</text>`;
    }
    // 時間刻度
    const nt = narrow ? 3 : 5;
    for (let k = 0; k < nt; k++) {
      const i = Math.round(k * (n - 1) / (nt - 1));
      const anchor = k === 0 ? 'start' : k === nt - 1 ? 'end' : 'middle';
      g += `<text x="${x(i)}" y="${H - 5}" text-anchor="${anchor}" style="fill:var(--muted);font:11px var(--num)">${cfg.longDates ? ymd(cfg.times[i]).slice(2) : mmdd(cfg.times[i])}</text>`;
    }
    if (cfg.bars) {
      const s = cfg.series[0], bw = Math.max(2, step * 0.62);
      g += `<line x1="${pl}" x2="${W - pr}" y1="${y(0)}" y2="${y(0)}" style="stroke:var(--muted)" stroke-width="1"/>`;
      s.vals.forEach((v, i) => {
        if (!ok(v)) return;
        const y0 = y(0), y1 = y(v);
        g += `<rect x="${x(i) - bw / 2}" y="${Math.min(y0, y1)}" width="${bw}" height="${Math.max(1, Math.abs(y1 - y0))}" rx="2" style="fill:${v >= 0 ? 'var(--up)' : 'var(--down)'}"/>`;
      });
    } else {
      cfg.series.forEach(s => {
        let d = '', pen = false, first = null, last = null;
        s.vals.forEach((v, i) => {
          if (!ok(v)) { pen = false; return; }
          d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); pen = true;
          if (first === null) first = i; last = i;
        });
        if (!d) return;
        if (s.area) g += `<path d="${d}L${x(last)},${pt + ih}L${x(first)},${pt + ih}Z" style="fill:${s.color};opacity:.09"/>`;
        g += `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:${s.width || 1.5};stroke-linejoin:round${s.dash ? ';stroke-dasharray:' + s.dash : ''}"/>`;
      });
    }
    (cfg.hlines || []).forEach(h => {
      if (!ok(h.v)) return;
      const yy = y(h.v);
      g += `<line x1="${pl}" x2="${W - pr}" y1="${yy}" y2="${yy}" style="stroke:${h.color};stroke-dasharray:5 4" stroke-width="1.3"/>`;
      const lw = h.label.length * 7 + 12, ly = yy - pt < 22 ? yy + 4 : yy - 22;
      g += `<rect x="${pl + 4}" y="${ly}" width="${lw}" height="18" rx="4" style="fill:${h.color}"/>`;
      g += `<text x="${pl + 10}" y="${ly + 13}" style="fill:#fff;font:600 11px var(--num)">${esc(h.label)}</text>`;
    });
    g += `<g class="xh" style="display:none"><line y1="${pt}" y2="${pt + ih}" style="stroke:var(--muted)" stroke-dasharray="3 3"/><circle r="4" style="fill:var(--card);stroke:var(--ink)" stroke-width="2"/></g>`;
    svg.setAttribute('aria-label', cfg.label || '走勢圖');
    svg.innerHTML = g;
  };
  const hide = () => { tip.classList.remove('on'); const xh = $('.xh', svg); if (xh) xh.style.display = 'none'; };
  const move = e => {
    if (!geo) return;
    const r = svg.getBoundingClientRect();
    const px = e.clientX - r.left;
    let i = cfg.bars ? Math.floor((px - geo.pl) / geo.step) : Math.round((px - geo.pl) / geo.step);
    i = Math.max(0, Math.min(n - 1, i));
    const main = cfg.series[0].vals[i];
    if (!ok(main)) return hide();
    const xh = $('.xh', svg);
    xh.style.display = '';
    $('line', xh).setAttribute('x1', geo.x(i)); $('line', xh).setAttribute('x2', geo.x(i));
    const c = $('circle', xh); c.setAttribute('cx', geo.x(i)); c.setAttribute('cy', geo.y(main));
    c.style.display = cfg.bars ? 'none' : '';
    const lines = cfg.series.filter(s => ok(s.vals[i])).map(s =>
      `<div><span style="color:${s.color === 'var(--ink)' ? 'inherit' : s.color}">●</span> ${esc(s.name)} <b class="num">${cfg.bars ? sgn(s.vals[i], cfg.digits) : fmt(s.vals[i], cfg.digits)}</b></div>`).join('');
    tip.innerHTML = `<div class="num">${ymd(cfg.times[i])}</div>${lines}`;
    const tx = Math.max(70, Math.min(geo.W - 70, geo.x(i)));
    tip.style.left = tx + 'px';
    tip.style.top = Math.max(geo.y(main), 40) + 'px';
    tip.classList.add('on');
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerdown', move);
  svg.addEventListener('pointerleave', hide);
  const ro = new ResizeObserver(draw);
  ro.observe(box);
  box.__ro = ro;
  draw();
}

const sma = (arr, n) => arr.map((_, i) => {
  if (i < n - 1) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) { if (!ok(arr[k])) return null; s += arr[k]; }
  return s / n;
});

/* ============ 頁首狀態 ============ */
function renderStatus() {
  const d = S.data; if (!d) return;
  const m = $('#mkt');
  m.classList.toggle('open', !!d.market.open);
  $('b', m).textContent = d.market.label;
  $('#upd').textContent = '更新 ' + hhmmss(d.asOf);
  const b = $('#banner');
  if (d.errors && d.errors.length) { b.hidden = false; b.textContent = '部分資料暫時抓不到：' + d.errors.join('、'); }
  else b.hidden = true;
}

/* ============ 總覽 ============ */
function renderOverview() {
  const d = S.data, sg = d.signals;
  const order = { pos: 0, neu: 1, na: 2, neg: 3 };
  const segs = sg.items.slice().sort((a, b) => order[a.state] - order[b.state]);
  const neu = sg.items.filter(i => i.state === 'neu').length;
  const sigHtml = `
  <article class="card" id="signals">
    <div class="gauge-head">
      <div>
        <div class="muted small">反彈訊號儀表</div>
        <div class="gauge-score num">${sg.pos}<small>/ ${sg.items.length} 偏多</small></div>
      </div>
      <div class="gauge-legend">
        <span><i class="dot pos" style="display:inline-block"></i> 偏多 <b>${sg.pos}</b></span>
        <span><i class="dot neu" style="display:inline-block"></i> 中性 <b>${neu}</b></span>
        <span><i class="dot neg" style="display:inline-block"></i> 偏空 <b>${sg.neg}</b></span>
      </div>
    </div>
    <div class="segs" aria-hidden="true">${segs.map((s, i) => `<span class="seg ${s.state}" style="animation-delay:${i * 50}ms"></span>`).join('')}</div>
    <p class="gauge-sum">${esc(sg.summary)}</p>
    <div class="muted small">點每一項可看判斷依據。紅色代表偏多（台股慣例），僅供參考，不是投資建議。</div>
    <ul class="sig-list">
      ${sg.items.map(s => `<li><details>
        <summary><span class="dot ${s.state}"></span>
          <span><span class="sig-name">${esc(s.name)}</span><span class="sig-val num">${esc(s.value)}</span></span>
          <span class="tag ${s.state}">${STATE_LABEL[s.state]}</span></summary>
        <p class="rule">${esc(s.rule)}</p></details></li>`).join('')}
    </ul>
  </article>`;

  const tiles = d.indicators.map(ind => {
    const first = ind.spark[0], last = ind.spark[ind.spark.length - 1];
    const trendColor = ok(first) && ok(last) ? (last >= first ? 'var(--up)' : 'var(--down)') : 'var(--muted)';
    let hint = '';
    if (ind.badWhenUp && ok(ind.chg) && Math.abs(ind.chg) > 0) hint = `<div class="hint ${ind.chg > 0 ? 'down' : 'up'}">${ind.chg > 0 ? '對台股偏不利' : '對台股偏有利'}</div>`;
    return `<button class="tile" data-ind="${esc(ind.key)}" id="ind-${esc(ind.key)}">
      <div class="t-name"><span>${esc(ind.name)}</span><span class="small">${esc(ind.group)}</span></div>
      <div class="t-price num">${fmt(ind.price, ind.digits)}</div>
      <div class="t-chg num ${cls(ind.chg)}">${sgn(ind.chg, ind.digits)}　${sgn(ind.chgPct, 2)}%</div>
      ${hint}
      ${spark(ind.spark, trendColor)}
    </button>`;
  }).join('');

  $('#v-overview').innerHTML = `${sigHtml}
    <div class="sec-title"><h3>市場指標</h3><span class="muted small">近 60 個交易日　點卡片看走勢</span></div>
    <div class="grid2 wide">${tiles}</div>`;
}

/* ============ 持股 ============ */
function renderHoldings() {
  const h = S.data.holdings, t = h.totals;
  const rows = h.rows.slice().sort((a, b) => {
    if (S.sort === 'pnl') return (b.pnlPct ?? -1e9) - (a.pnlPct ?? -1e9);
    if (S.sort === 'day') return (b.chgPct ?? -1e9) - (a.chgPct ?? -1e9);
    return (b.weight || 0) - (a.weight || 0);
  });
  const colorOf = code => PALETTE[h.rows.findIndex(r => r.code === code) % PALETTE.length];
  const missing = t.missing && t.missing.length ? `<div class="muted small" style="margin-top:8px">以下代號暫無報價，未計入市值：${esc(t.missing.join('、'))}</div>` : '';

  $('#v-holdings').innerHTML = `
  <article class="card" id="pf-summary">
    <div class="muted small">總市值（新台幣）</div>
    <div class="kv"><div class="v big num">${money(t.value)}</div></div>
    <div class="sum-grid">
      <div class="kv"><div class="k">未實現損益</div><div class="v num ${cls(t.pnl)}">${sMoney(t.pnl)}<small>${sgn(t.pnlPct)}%</small></div></div>
      <div class="kv"><div class="k">今日損益</div><div class="v num ${cls(t.dayPnl)}">${sMoney(t.dayPnl)}<small>${sgn(t.dayPct)}%</small></div></div>
      <div class="kv"><div class="k">投入成本</div><div class="v num">${money(t.cost)}</div></div>
      <div class="kv"><div class="k">若今天全部賣出（扣費稅）</div><div class="v num ${cls(t.netPnl)}">${sMoney(t.netPnl)}</div></div>
    </div>
    <div class="alloc" role="img" aria-label="持股比重">${h.rows.map(r => `<span style="width:${(r.weight || 0).toFixed(2)}%;background:${colorOf(r.code)}" title="${esc(r.name)} ${fmt(r.weight, 1)}%"></span>`).join('')}</div>
    <div class="alloc-legend">${h.rows.slice().sort((a, b) => b.weight - a.weight).map(r => `<span><i style="background:${colorOf(r.code)}"></i>${esc(r.code)} <span class="num">${fmt(r.weight, 1)}%</span></span>`).join('')}</div>
    ${missing}
  </article>
  <div class="sec-title"><h3>持股明細</h3>
    <div class="seg-ctl" role="group" aria-label="排序">
      ${[['weight', '比重'], ['pnl', '損益%'], ['day', '今日']].map(([k, l]) => `<button data-sort="${k}" aria-pressed="${S.sort === k}">${l}</button>`).join('')}
    </div></div>
  <div class="list">
    ${rows.map(r => `<button class="hold" data-code="${esc(r.code)}" id="hold-${esc(r.code)}">
      <div><div class="h-name">${esc(r.name)}</div><div class="h-code"><span class="num">${esc(r.code)}</span>　${money(r.shares)} 股</div>${r.note ? `<span class="tag">${esc(r.note)}</span>` : ''}</div>
      ${spark(r.spark, ok(r.chg) && r.chg < 0 ? 'var(--down)' : 'var(--up)')}
      <div class="h-px num"><b>${fmt(r.price, 2)}</b><span class="${cls(r.chg)}">${sgn(r.chg, 2)} (${sgn(r.chgPct, 2)}%)</span></div>
      <div class="h-foot"><span class="muted">均價 <span class="num">${fmt(r.avg, 2)}</span>　市值 <span class="num">${money(r.value)}</span></span>
        <span class="pl num ${cls(r.pnl)}">${sMoney(r.pnl)}（${sgn(r.pnlPct)}%）</span></div>
    </button>`).join('')}
  </div>
  <div class="row" style="justify-content:space-between;padding:4px">
    <span class="muted small">手續費折扣 ${esc(S.data.settings.feeDiscount)}，ETF 交易稅 0.1%</span>
    <a class="btn" href="${esc(S.data.sheetUrl)}" target="_blank" rel="noopener">在 Google Sheet 編輯持股</a>
  </div>`;
}

/* ============ 籌碼 ============ */
function renderChips() {
  const rows = S.data.chips || [];
  const el = $('#v-chips');
  const links = S.data.links.filter(l => l.group === '籌碼');
  const linkHtml = `<article class="card"><h2>官方資料來源</h2><p class="sub">想看更細的數字，可以直接到這些網站</p>
    <ul class="links">${links.map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></li>`).join('')}</ul></article>`;
  if (!rows.length) {
    el.innerHTML = `<article class="card"><h2>還沒有籌碼資料</h2>
      <p class="sub">在 Apps Script 編輯器執行一次 <b>setup</b>，會自動補齊最近 25 個交易日；之後每個交易日 22:00 自動更新。也可以按下方按鈕先抓今天的資料。</p>
      <button class="btn primary" id="btnChips">抓取今日籌碼</button></article>${linkHtml}`;
    return;
  }
  const L = rows[rows.length - 1];
  const keys = [['foreign', '外資'], ['trust', '投信'], ['dealer', '自營商'], ['total', '三大法人']];
  const recent = rows.slice(-30);
  el.innerHTML = `
  <article class="card" id="chips-latest">
    <div class="row" style="justify-content:space-between"><h2>${esc(L.date)} 盤後籌碼</h2><span class="muted small">單位：億元</span></div>
    <div class="chip-now" style="margin-top:10px">
      ${keys.slice(0, 3).map(([k, l]) => `<div class="kv"><div class="k">${l}</div><div class="v num ${cls(L[k])}">${sgn(L[k], 1)}</div></div>`).join('')}
      <div class="kv"><div class="k">三大法人合計</div><div class="v num ${cls(L.total)}">${sgn(L.total, 1)}</div></div>
      <div class="kv"><div class="k">融資餘額</div><div class="v num">${fmt(L.margin, 0)}</div></div>
      <div class="kv"><div class="k">融資增減</div><div class="v num ${cls(L.marginChg)}">${sgn(L.marginChg, 1)}</div></div>
    </div>
  </article>
  <article class="card" id="chips-flow">
    <div class="row" style="justify-content:space-between"><h2>法人買賣超</h2>
      <div class="seg-ctl" role="group" aria-label="法人">${keys.map(([k, l]) => `<button data-chip="${k}" aria-pressed="${S.chipKey === k}">${l}</button>`).join('')}</div></div>
    <p class="sub">近 ${recent.length} 個交易日，紅色為買超、綠色為賣超</p>
    <div class="fig" id="figFlow"></div>
  </article>
  <article class="card" id="chips-margin">
    <h2>融資餘額</h2><p class="sub">散戶槓桿水位：急降代表斷頭清洗，急升代表追價或攤平</p>
    <div class="fig" id="figMargin"></div>
  </article>
  <article class="card" id="chips-table">
    <div class="row" style="justify-content:space-between"><h2>近 10 日明細</h2><button class="btn" id="btnChips">更新今日籌碼</button></div>
    <div class="scroll"><table class="compact">
      <thead><tr><th>日期</th><th>外資</th><th>投信</th><th>自營</th><th>合計</th><th>融資</th><th>增減</th></tr></thead>
      <tbody>${rows.slice(-10).reverse().map(r => `<tr>
        <td class="num">${esc(r.date.slice(5).replace('-', '/'))}</td>
        <td data-l="外資" class="num ${cls(r.foreign)}">${sgn(r.foreign, 1)}</td>
        <td data-l="投信" class="num ${cls(r.trust)}">${sgn(r.trust, 1)}</td>
        <td data-l="自營商" class="num ${cls(r.dealer)}">${sgn(r.dealer, 1)}</td>
        <td data-l="合計" class="num ${cls(r.total)}">${sgn(r.total, 1)}</td>
        <td data-l="融資餘額" class="num">${fmt(r.margin, 0)}</td>
        <td data-l="融資增減" class="num ${cls(r.marginChg)}">${sgn(r.marginChg, 1)}</td></tr>`).join('')}</tbody>
    </table></div>
  </article>${linkHtml}`;
  drawChipCharts();
}

function drawChipCharts() {
  const rows = S.data.chips || [];
  const recent = rows.slice(-30);
  const label = { foreign: '外資', trust: '投信', dealer: '自營商', total: '三大法人' }[S.chipKey];
  const f = $('#figFlow');
  if (f) chart(f, { bars: true, times: recent.map(r => new Date(r.date.replace(/-/g, '/')).getTime()), digits: 1, label: label + '買賣超',
    series: [{ name: label + '（億）', vals: recent.map(r => r[S.chipKey]), color: 'var(--ink)' }] });
  const m = $('#figMargin');
  const mr = rows.filter(r => ok(r.margin)).slice(-60);
  if (m) chart(m, { times: mr.map(r => new Date(r.date.replace(/-/g, '/')).getTime()), digits: 0, label: '融資餘額',
    series: [{ name: '融資餘額（億）', vals: mr.map(r => r.margin), color: 'var(--accent)', area: true, width: 2 }] });
}

/* ============ 觀察 ============ */
function renderNotes() {
  const notes = S.data.notes || [];
  const tags = ['全部', ...new Set(notes.map(n => n.tag).filter(Boolean))];
  const shown = S.noteTag === '全部' ? notes : notes.filter(n => n.tag === S.noteTag);
  const groups = [...new Set(S.data.links.map(l => l.group))];
  $('#v-notes').innerHTML = `
  <div class="sec-title"><h3>市場觀察與持股診斷</h3><a class="small" href="${esc(S.data.sheetUrl)}" target="_blank" rel="noopener">編輯筆記</a></div>
  <div class="seg-ctl" role="group" aria-label="分類">${tags.map(t => `<button data-tag="${esc(t)}" aria-pressed="${S.noteTag === t}">${esc(t)}</button>`).join('')}</div>
  ${shown.length ? shown.map((n, i) => `<article class="card note" id="note-${i}">
    <div class="meta"><span class="tag">${esc(n.tag)}</span><span class="num">${esc(n.date)}</span></div>
    <h4>${esc(n.title)}</h4><p>${esc(n.body)}</p></article>`).join('') : '<div class="empty">這個分類還沒有筆記</div>'}
  <article class="card" id="links"><h2>常用資料連結</h2>
    <ul class="links">${groups.map(g => `<li class="grp">${esc(g)}</li>` + S.data.links.filter(l => l.group === g)
      .map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></li>`).join('')).join('')}</ul></article>
  <p class="disclaimer">資料來源：證交所、Yahoo Finance。報價可能延遲，訊號依公開資料以固定規則計算，僅供參考，不構成投資建議；下單前請以券商報價為準。</p>`;
}

/* ============ 詳情（底部面板） ============ */
const RANGES = [['1mo', '1月', 31, '6mo'], ['3mo', '3月', 92, '1y'], ['6mo', '6月', 183, '1y'], ['1y', '1年', 366, '2y'], ['2y', '2年', 731, '5y'], ['5y', '5年', 1830, '5y']];

function openDetail(kind, id) {
  const opts = store.get('ma', { ma5: false, ma20: true, ma60: true, cost: true });
  S.detail = { kind, id, range: store.get('range', '6mo'), opts };
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  renderDetail();
  loadDetail();
}

function closeDetail() {
  const f = $('#figDetail'); if (f && f.__ro) f.__ro.disconnect();
  $('#sheet').hidden = true; document.body.style.overflow = ''; S.detail = null;
}

function detailItem() {
  const D = S.detail;
  if (D.kind === 'hold') return S.data.holdings.rows.find(r => r.code === D.id);
  return S.data.indicators.find(i => i.key === D.id);
}

function renderDetail() {
  const D = S.detail, it = detailItem();
  if (!it) return closeDetail();
  const digits = D.kind === 'hold' ? 2 : it.digits;
  const toggles = [['ma5', 'MA5', '#d4a017'], ['ma20', 'MA20', '#7b4dd6'], ['ma60', 'MA60', '#0e9aa7']];
  if (D.kind === 'hold') toggles.push(['cost', '成本線', '#1d3fd8']);
  $('#sheetBody').innerHTML = `
    <div class="d-head">
      <div class="d-name">${esc(it.name)} <span class="muted num" style="font-size:14px;font-weight:500">${esc(D.kind === 'hold' ? it.code : it.symbol)}</span></div>
      <div class="d-price num">${fmt(it.price, digits)}</div>
      <div class="num ${cls(it.chg)}">${sgn(it.chg, digits)}（${sgn(it.chgPct)}%）<span class="muted small">　${esc(D.kind === 'hold' ? it.quoteSource : it.source)} ${hhmm(D.kind === 'hold' ? it.quoteTime : it.time)}</span></div>
    </div>
    <div class="ranges" role="group" aria-label="期間">${RANGES.map(r => `<button data-range="${r[0]}" aria-pressed="${D.range === r[0]}">${r[1]}</button>`).join('')}</div>
    <div class="toggles">${toggles.map(([k, l, c]) => `<label><input type="checkbox" data-opt="${k}" ${D.opts[k] ? 'checked' : ''}><i style="background:${c}"></i>${l}</label>`).join('')}</div>
    <div class="fig tall" id="figDetail"><div class="loading">載入走勢中…</div></div>
    <div class="stats" id="dStats"></div>`;
}

function loadDetail() {
  const D = S.detail; if (!D) return;
  const r = RANGES.find(x => x[0] === D.range);
  const key = D.id + ':' + r[3];
  const done = h => { if (S.detail === D) drawDetail(h); };
  if (S.hist[key]) return done(S.hist[key]);
  api('getHistory', D.id, r[3]).then(h => { S.hist[key] = h; done(h); })
    .catch(e => { const f = $('#figDetail'); if (f) f.innerHTML = `<div class="loading">${esc(e.message || e)}</div>`; });
}

function drawDetail(h) {
  const D = S.detail, it = detailItem();
  const r = RANGES.find(x => x[0] === D.range);
  const pts = h.points;
  const closes = pts.map(p => p.c);
  const ma = { ma5: sma(closes, 5), ma20: sma(closes, 20), ma60: sma(closes, 60) };
  const since = Date.now() - r[2] * 86400000;
  let start = pts.findIndex(p => p.t >= since); if (start < 0) start = 0;
  const vis = pts.slice(start);
  const cut = a => a.slice(start);
  const digits = D.kind === 'hold' ? 2 : it.digits;
  const series = [{ name: '收盤', vals: cut(closes), color: 'var(--ink)', width: 1.8, area: true }];
  if (D.opts.ma5) series.push({ name: 'MA5', vals: cut(ma.ma5), color: '#d4a017', width: 1.2 });
  if (D.opts.ma20) series.push({ name: 'MA20', vals: cut(ma.ma20), color: '#7b4dd6', width: 1.2 });
  if (D.opts.ma60) series.push({ name: 'MA60', vals: cut(ma.ma60), color: '#0e9aa7', width: 1.2 });
  const hl = [];
  if (D.kind === 'hold' && D.opts.cost && ok(it.avg)) hl.push({ v: it.avg, label: '成本 ' + fmt(it.avg, 2), color: '#1d3fd8' });
  chart($('#figDetail'), { times: vis.map(p => p.t), series, hlines: hl, digits, longDates: r[2] > 400, label: it.name + ' 走勢' });

  const vc = vis.map(p => p.c).filter(ok);
  const hi = Math.max(...vc), lo = Math.min(...vc), last = it.price ?? vc[vc.length - 1];
  const fromHi = (last / hi - 1) * 100, fromLo = (last / lo - 1) * 100;
  const rangeRet = (last / vc[0] - 1) * 100;
  const L = i => ma[i][ma[i].length - 1];
  const cell = (k, v, c = '') => `<div><div class="k">${k}</div><div class="v num ${c}">${v}</div></div>`;
  let s = cell('區間報酬', sgn(rangeRet) + '%', cls(rangeRet)) + cell('區間最高', fmt(hi, digits)) + cell('區間最低', fmt(lo, digits)) +
    cell('距區間高點', sgn(fromHi) + '%', cls(fromHi)) + cell('距區間低點', sgn(fromLo) + '%', cls(fromLo));
  if (D.kind === 'hold') {
    const yieldPct = ok(h.ttmDiv) && h.ttmDiv > 0 && ok(last) ? h.ttmDiv / last * 100 : null;
    s = cell('持有股數', money(it.shares)) + cell('平均成本', fmt(it.avg, 2)) + cell('損益兩平價', fmt(it.breakeven, 2)) +
      cell('市值', money(it.value)) + cell('未實現損益', sMoney(it.pnl) + '（' + sgn(it.pnlPct) + '%）', cls(it.pnl)) +
      cell('賣出淨損益', sMoney(it.netPnl), cls(it.netPnl)) + cell('今日損益', sMoney(it.dayPnl), cls(it.dayPnl)) +
      cell('占投資組合', fmt(it.weight, 1) + '%') +
      cell('近 12 月配息', ok(h.ttmDiv) && h.ttmDiv > 0 ? fmt(h.ttmDiv, 2) + ' 元' : '—') +
      cell('估算殖利率', ok(yieldPct) ? fmt(yieldPct, 2) + '%' : '—') + s;
    s += `<div style="grid-column:1/-1"><div class="k">賣出成本估算</div><div class="v small" style="font-weight:500">手續費 ${money(it.sellFee)} 元＋交易稅 ${money(it.sellTax)} 元；兩平價已含這兩項</div></div>`;
  } else {
    s += cell('5 日線', fmt(L('ma5'), digits)) + cell('20 日線', fmt(L('ma20'), digits)) + cell('60 日線', fmt(L('ma60'), digits)) +
      cell('52 週高', fmt(it.high52, digits)) + cell('52 週低', fmt(it.low52, digits));
  }
  s += `<div style="grid-column:1/-1"><div class="k">資料來源</div><div class="v small" style="font-weight:500">${esc(h.source)}${h.interval === '1wk' ? '（週線）' : '（日線）'}</div></div>`;
  $('#dStats').innerHTML = s;
}

/* ============ 載入與刷新 ============ */
function renderAll() {
  renderStatus(); renderOverview(); renderHoldings(); renderNotes(); renderChips();
}

function showTab(tab) {
  S.tab = tab; store.set('tab', tab);
  $$('.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  $$('.view').forEach(v => { v.hidden = v.dataset.view !== tab; });
  if (tab === 'chips' && S.data) drawChipCharts();
  window.scrollTo({ top: 0 });
}

function load(silent) {
  if (S.loading) return;
  S.loading = true;
  $('#btnRefresh').classList.add('spin');
  api('getDashboard').then(d => {
    S.data = d; $('.tabs').hidden = false; renderAll(); showTab(S.tab); schedule();
    if (silent !== true) toast('資料已更新');
  }).catch(e => {
    if (e.auth) return renderSetup(CFG.key ? e.message : '');
    const b = $('#banner'); b.hidden = false; b.textContent = '載入失敗：' + (e.message || e);
  }).finally(() => { S.loading = false; $('#btnRefresh').classList.remove('spin'); });
}

function live() {
  if (S.loading || document.hidden) return;
  api('getLive').then(l => {
    const d = S.data;
    d.asOf = l.asOf; d.market = l.market; d.holdings = l.holdings;
    d.indicators.forEach(ind => { if (l.indicators[ind.key]) Object.assign(ind, l.indicators[ind.key]); });
    renderStatus(); renderOverview(); renderHoldings();
    if (!l.market.open) schedule();
  }).catch(() => {});
}

function schedule() {
  clearInterval(S.timer); S.timer = null;
  if (S.data && S.data.market.open) S.timer = setInterval(live, Math.max(20, S.data.settings.refreshSec) * 1000);
}

/* ============ 事件 ============ */
document.addEventListener('click', e => {
  const t = e.target.closest('button,[data-close]');
  if (!t) return;
  if (t.hasAttribute('data-close')) return closeDetail();
  if (t.dataset.tab) return showTab(t.dataset.tab);
  if (t.id === 'btnRefresh') return load();
  if (t.id === 'btnSettings') return renderSetup();
  if (t.id === 'btnSetupCancel') return closeSetup();
  if (t.dataset.ind) return openDetail('ind', t.dataset.ind);
  if (t.dataset.code) return openDetail('hold', t.dataset.code);
  if (t.dataset.sort) { S.sort = t.dataset.sort; store.set('sort', S.sort); return renderHoldings(); }
  if (t.dataset.chip) { S.chipKey = t.dataset.chip; $$('[data-chip]').forEach(b => b.setAttribute('aria-pressed', b.dataset.chip === S.chipKey)); return drawChipCharts(); }
  if (t.dataset.tag) { S.noteTag = t.dataset.tag; return renderNotes(); }
  if (t.dataset.range && S.detail) {
    S.detail.range = t.dataset.range; store.set('range', S.detail.range);
    $$('[data-range]').forEach(b => b.setAttribute('aria-pressed', b.dataset.range === S.detail.range));
    $('#figDetail').innerHTML = '<div class="loading">載入走勢中…</div>';
    return loadDetail();
  }
  if (t.id === 'btnChips') {
    t.disabled = true; t.textContent = '抓取中…';
    api('refreshChips').then(r => {
      S.data.chips = r.chips; renderChips();
      toast(r.ok ? '已更新今日籌碼' : '今天還沒有籌碼資料（休市，或證交所尚未公布）');
    }).catch(err => { toast('更新失敗：' + (err.message || err)); t.disabled = false; t.textContent = '更新今日籌碼'; });
  }
});

document.addEventListener('change', e => {
  const o = e.target.dataset && e.target.dataset.opt;
  if (!o || !S.detail) return;
  S.detail.opts[o] = e.target.checked; store.set('ma', S.detail.opts);
  loadDetail();
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'setupForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  CFG.url = String(f.get('url')).trim(); CFG.key = String(f.get('key')).trim();
  store.set('apiUrl', CFG.url); store.set('apiKey', CFG.key);
  S.hist = {};
  $('#v-setup').innerHTML = '<div class="skeleton"></div>';
  load();
});

document.addEventListener('keydown', e => { if (e.key === 'Escape' && S.detail) closeDetail(); });
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.data && Date.now() - S.data.asOf > 5 * 60000) load(true);
});

if (S.tab === 'setup') S.tab = 'overview';
showTab(S.tab);
load(true);
}
