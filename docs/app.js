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
const GL = window.GLOSSARY || {};
/** 名詞說明的小問號；k 為 glossary.js 的 key */
const gi = k => GL[k] ? `<span class="gi" data-gl="${k}" role="button" tabindex="0" aria-label="${esc(GL[k].title)} 說明">?</span>` : '';
const SIG_GL = { SOX: 'SOX', VIX: 'VIX', SPX: 'SPX', TWD: 'USDTWD', TAIEX: 'MA', FOREIGN: 'FOREIGN', MARGIN: 'MARGIN' };

function openGlossary(k) {
  const g = GL[k]; if (!g) return;
  $('#glossBody').innerHTML = `
    <h2 id="glossTitle">${esc(g.title)}</h2>
    <dl class="gloss-dl">
      <dt>這是什麼</dt><dd>${esc(g.what)}</dd>
      <dt>為什麼重要</dt><dd>${esc(g.why)}</dd>
      <dt>怎麼看</dt><dd>${esc(g.read)}</dd>
    </dl>
    ${g.link ? `<a class="btn wide" href="${esc(g.link[1])}" target="_blank" rel="noopener">延伸閱讀：${esc(g.link[0])} ↗</a>` : ''}`;
  $('#gloss').hidden = false;
  $('.gloss-card .sheet-x').focus();
}
function closeGlossary() { $('#gloss').hidden = true; }

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
  getSecurities: () => ({ api: 'securities' }),
};

function parseApi_(r) {
  if (!r.ok) throw new Error('API 回應 ' + r.status);
  return r.text().then(t => {
    let j;
    try { j = JSON.parse(t); } catch (e) { throw new Error('API 沒有回傳資料：請確認部署的存取權是「任何人」'); }
    if (!j.ok) throw Object.assign(new Error(j.error === 'unauthorized' ? 'API 金鑰不正確' : j.error), { auth: j.error === 'unauthorized' });
    return j.data;
  });
}

/** 寫入（新增／刪除交易）。以 text/plain 送出，避免 CORS 預檢 */
function apiPost(action, payload) {
  if (window.__MOCK__) return Promise.resolve().then(() => window.__MOCK__[action](payload));
  if (!CFG.url || !CFG.key) return Promise.reject(Object.assign(new Error('尚未設定 API 金鑰'), { auth: true }));
  return fetch(CFG.url, { method: 'POST', redirect: 'follow', body: JSON.stringify(Object.assign({ key: CFG.key, action }, payload)) }).then(parseApi_);
}

function api(fn, ...args) {
  if (window.__MOCK__) return Promise.resolve().then(() => window.__MOCK__[fn](...args));
  if (!CFG.url || !CFG.key) return Promise.reject(Object.assign(new Error('尚未設定 API 金鑰'), { auth: true }));
  const q = new URLSearchParams(Object.assign(ROUTES[fn](...args), { key: CFG.key, _: Date.now() }));
  return fetch(CFG.url + '?' + q.toString(), { redirect: 'follow' }).then(parseApi_);
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
        <div class="muted small">反彈訊號儀表 ${gi('SIGNAL')}</div>
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
          <span><span class="sig-name">${esc(s.name)} ${gi(SIG_GL[s.key])}</span><span class="sig-val num">${esc(s.value)}</span></span>
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
      <div class="t-name"><span>${esc(ind.name)} ${gi(ind.key)}</span><span class="small">${esc(ind.group)}</span></div>
      <div class="t-price num">${fmt(ind.price, ind.digits)}</div>
      <div class="t-chg num ${cls(ind.chg)}">${sgn(ind.chg, ind.digits)}　${sgn(ind.chgPct, 2)}%</div>
      ${hint}
      ${spark(ind.spark, trendColor)}
    </button>`;
  }).join('');

  $('#v-overview').innerHTML = `${sigHtml}
    <div class="sec-title"><h3>市場指標</h3><span class="muted small">點 ? 看說明，點卡片看走勢</span></div>
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
  const st = S.data.settings || {};
  const warns = h.warnings || [];

  $('#v-holdings').innerHTML = `
  <article class="card" id="pf-summary">
    <div class="muted small">總市值（新台幣）</div>
    <div class="kv"><div class="v big num">${money(t.value)}</div></div>
    <div class="sum-grid">
      <div class="kv"><div class="k">未實現損益 ${gi('UNREAL')}</div><div class="v num ${cls(t.pnl)}">${sMoney(t.pnl)}<small>${sgn(t.pnlPct)}%</small></div></div>
      ${h.ledger ? `<div class="kv"><div class="k">含息損益 ${gi('TOTALRET')}</div><div class="v num ${cls(t.totalPnl)}">${sMoney(t.totalPnl)}<small>${sgn(t.totalPct)}%</small></div></div>` : ''}
      <div class="kv"><div class="k">今日損益 ${gi('DAY')}</div><div class="v num ${cls(t.dayPnl)}">${sMoney(t.dayPnl)}<small>${sgn(t.dayPct)}%</small></div></div>
      <div class="kv"><div class="k">投入成本</div><div class="v num">${money(t.cost)}</div></div>
      <div class="kv"><div class="k">若今天全部賣出（扣費稅） ${gi('NET')}</div><div class="v num ${cls(t.netPnl)}">${sMoney(t.netPnl)}</div></div>
      ${h.ledger ? `<div class="kv"><div class="k">已實現損益（累計） ${gi('REAL')}</div><div class="v num ${cls(t.realized)}">${sMoney(t.realized)}</div></div>
      <div class="kv"><div class="k">累計領息 ${gi('DIV')}</div><div class="v num ${cls(t.divs)}">${sMoney(t.divs)}</div></div>` : ''}
    </div>
    <div class="muted small" style="margin-top:16px">持股比重 ${gi('WEIGHT')}</div>
    <div class="alloc" style="margin-top:6px" role="img" aria-label="持股比重">${h.rows.map(r => `<span style="width:${(r.weight || 0).toFixed(2)}%;background:${colorOf(r.code)}" title="${esc(r.name)} ${fmt(r.weight, 1)}%"></span>`).join('')}</div>
    <div class="alloc-legend">${h.rows.slice().sort((a, b) => b.weight - a.weight).map(r => `<span><i style="background:${colorOf(r.code)}"></i>${esc(r.code)} <span class="num">${fmt(r.weight, 1)}%</span></span>`).join('')}</div>
    ${groupBar('資產類別', 'ASSET', h.byAsset, ASSET_COLOR)}
    ${groupBar('核心／衛星', 'ROLE', h.byRole, ROLE_COLOR)}
    ${h.byStyle && h.byStyle.length ? `<div class="style-line">風格：${h.byStyle.map(g => `${esc(g.name)} <span class="num">${fmt(g.weight, 1)}%</span>`).join('　')}</div>` : ''}
    ${warns.length ? `<div class="rule-warn" role="note"><b>⚠️ 對照你的投資規則</b><ul>${warns.map(w => `<li>${esc(w)}</li>`).join('')}</ul>
      <div class="muted">規則：衛星合計 ≤ ${esc(st.satMax)}%、單一衛星 ≤ ${esc(st.satOneMax)}%。可在 Sheet「設定」分頁修改，填 0 不提醒。這只是提醒，不是買賣建議。</div></div>` : ''}
    ${missing}
  </article>
  ${h.ledger && !apiV2() ? `<div class="banner">網頁已經更新，但 Apps Script 還是舊版，所以「配息入帳、含息損益、類別比重」還不能用。請依說明到 Apps Script 更新程式並重新部署。</div>` : ''}
  ${h.ledger && apiV2() ? renderDivHints() : ''}
  ${h.ledger ? `<button class="btn primary wide" id="btnAddTx"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>新增交易（買進／賣出${apiV2() ? '／配息' : ''}）</button>` : ''}
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
        <span class="pl-wrap"><span class="pl num ${cls(r.pnl)}">${sMoney(r.pnl)}（${sgn(r.pnlPct)}%）</span>
        ${r.divs ? `<span class="pl-div num ${cls(r.totalPnl)}">含息 ${sMoney(r.totalPnl)}（${sgn(r.totalPct)}%）</span>` : ''}</span></div>
    </button>`).join('')}
  </div>
  ${h.closed && h.closed.length ? `<details class="card closed"><summary><b>已出清</b> <span class="muted small">${h.closed.length} 檔</span></summary>
    <ul class="txlist">${h.closed.map(c => `<li><span>${esc(c.name)} <span class="muted num">${esc(c.code)}</span>${c.divs ? `<span class="muted small">　另領息 <span class="num">${money(c.divs)}</span></span>` : ''}</span><span class="num ${cls(c.realized)}">${sMoney(c.realized)}</span></li>`).join('')}</ul></details>` : ''}
  <div class="row" style="justify-content:space-between;padding:4px">
    <span class="muted small">手續費折扣 ${esc(S.data.settings.feeDiscount)} ${gi('FEE')}　平均成本法 ${gi('AVGCOST')}</span>
    <a class="btn" href="${esc(S.data.sheetUrl)}" target="_blank" rel="noopener">在 Google Sheet 查看紀錄</a>
  </div>`;
}

const ASSET_COLOR = { '台股': '#1d3fd8', '海外股票': '#0e9aa7', '債券': '#2f855a' };
const ROLE_COLOR = { '核心': '#1d3fd8', '衛星': '#b83280' };

/** 分組比重條（資產類別、核心／衛星） */
function groupBar(title, gl, groups, colors) {
  if (!groups || !groups.length) return '';
  const c = (g, i) => colors[g.name] || PALETTE[(i + 3) % PALETTE.length];
  return `<div class="alloc-title"><span class="muted small">${esc(title)} ${gi(gl)}</span></div>
    <div class="alloc thin" role="img" aria-label="${esc(title)}">${groups.map((g, i) => `<span style="width:${(g.weight || 0).toFixed(2)}%;background:${c(g, i)}" title="${esc(g.name)} ${fmt(g.weight, 1)}%"></span>`).join('')}</div>
    <div class="alloc-legend">${groups.map((g, i) => `<span><i style="background:${c(g, i)}"></i>${esc(g.name)} <span class="num">${fmt(g.weight, 1)}%</span></span>`).join('')}</div>`;
}

/* ---- 可能還沒記錄的配息 ---- */
const hintKey = x => x.code + '@' + x.exDate;
function visibleHints() {
  const ign = new Set(store.get('divIgnore', []));
  return (S.data.divHints || []).filter(x => !ign.has(hintKey(x)));
}
function renderDivHints() {
  const list = visibleHints();
  if (!list.length) return '';
  const undated = list.some(x => x.undated);
  return `<article class="card" id="divhints"><details ${list.length <= 3 ? 'open' : ''}>
    <summary><span><b>📬 可能還沒記錄的配息</b> <span class="muted small">${list.length} 筆</span></span><span class="muted small">展開 ▾</span></summary>
    <p class="sub">比對除息資料與你的持股找出來的。先到券商 App 或存摺確認<b>真的有入帳</b>，再按「記錄」；不是你的就按「忽略」。${gi('DIV')}</p>
    <ul class="txlist">${list.map(x => `<li>
      <div><div><b>${esc(x.name)}</b> <span class="muted num">${esc(x.code)}</span></div>
        <div class="small muted">除息 <span class="num">${esc(x.exDate)}</span>・每股 <span class="num">${fmt(x.perShare, 4).replace(/0+$/, '').replace(/\.$/, '')}</span> 元 × <span class="num">${money(x.shares)}</span> 股</div>
        <div class="small">約 <b class="num">${money(x.gross - x.deduct)}</b> 元${x.deduct ? `<span class="muted">（已預扣補充保費 ${money(x.deduct)}）</span>` : ''}</div></div>
      <div class="hint-act"><button class="btn small-btn" data-divrec="${esc(hintKey(x))}">記錄</button><button class="btn ghost small-btn" data-divign="${esc(hintKey(x))}">忽略</button></div></li>`).join('')}</ul>
    ${undated ? `<p class="muted small">期初庫存沒有買進日期，所以只列近 120 天的除息。想更精準，可在 Sheet「設定」分頁新增一列「配息提醒起算日」（例如開始記帳的日期）。</p>` : ''}
    ${list.length > 1 ? `<button class="btn ghost small-btn" data-divignall>全部忽略</button>` : ''}
  </details></article>`;
}
function ignoreHintsSilently(keys) {
  const ign = new Set(store.get('divIgnore', []));
  keys.forEach(k => ign.add(k));
  store.set('divIgnore', Array.from(ign).slice(-300));
}
function ignoreHints(keys) { ignoreHintsSilently(keys); renderHoldings(); }

/** 設定核心／衛星（role 空字串＝改回自動判斷） */
function setRole(code, role, btn) {
  if (btn) btn.disabled = true;
  apiPost('setRole', { code, role }).then(() => {
    const it = heldOf(code);
    if (it) { it.roleSet = !!role; it.role = role || it.autoRole; }
    toast(role ? `${code} 設為${role}` : `${code} 改回自動判斷`);
    if (S.detail) { renderDetail(); loadDetail(); }
    load(true);
  }).catch(e => { toast('設定失敗：' + (e.message || e)); if (btn) btn.disabled = false; });
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
      ${keys.slice(0, 3).map(([k, l]) => `<div class="kv"><div class="k">${l} ${gi('FOREIGN')}</div><div class="v num ${cls(L[k])}">${sgn(L[k], 1)}</div></div>`).join('')}
      <div class="kv"><div class="k">三大法人合計</div><div class="v num ${cls(L.total)}">${sgn(L.total, 1)}</div></div>
      <div class="kv"><div class="k">融資餘額 ${gi('MARGIN')}</div><div class="v num">${fmt(L.margin, 0)}</div></div>
      <div class="kv"><div class="k">融資增減</div><div class="v num ${cls(L.marginChg)}">${sgn(L.marginChg, 1)}</div></div>
    </div>
  </article>
  <article class="card" id="chips-flow">
    <div class="row" style="justify-content:space-between"><h2>法人買賣超 ${gi('FOREIGN')}</h2>
      <div class="seg-ctl" role="group" aria-label="法人">${keys.map(([k, l]) => `<button data-chip="${k}" aria-pressed="${S.chipKey === k}">${l}</button>`).join('')}</div></div>
    <p class="sub">近 ${recent.length} 個交易日，紅色為買超、綠色為賣超</p>
    <div class="fig" id="figFlow"></div>
  </article>
  <article class="card" id="chips-margin">
    <h2>融資餘額 ${gi('MARGIN')}</h2><p class="sub">散戶槓桿水位：急降代表斷頭清洗，急升代表追價或攤平</p>
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
  <article class="card" id="glossary"><h2>名詞小辭典</h2><p class="sub">看不懂的名詞點這裡，也可以點頁面上任何一個 ? 圖示</p>
    <div class="gl-list">${Object.keys(GL).map(k => `<button class="chip" data-gl="${k}">${esc(GL[k].title)}</button>`).join('')}</div></article>
  <article class="card" id="links"><h2>常用資料連結</h2>
    <ul class="links">${groups.map(g => `<li class="grp">${esc(g)}</li>` + S.data.links.filter(l => l.group === g)
      .map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name)}</a></li>`).join('')).join('')}</ul></article>
  <p class="disclaimer">資料來源：證交所、Yahoo Finance。報價可能延遲，訊號依公開資料以固定規則計算，僅供參考，不構成投資建議；下單前請以券商報價為準。</p>`;
}

/* ============ 詳情（底部面板） ============ */
const RANGES = [['1mo', '1月', 31, '6mo'], ['3mo', '3月', 92, '1y'], ['6mo', '6月', 183, '1y'], ['1y', '1年', 366, '2y'], ['2y', '2年', 731, '5y'], ['5y', '5年', 1830, '5y']];

function openDetail(kind, id) {
  const opts = store.get('ma', { ma5: false, ma20: true, ma60: true, cost: true });
  S.tx = null;
  S.detail = { kind, id, range: store.get('range', '6mo'), opts };
  $('#sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  renderDetail();
  loadDetail();
}

function closeDetail() {
  const f = $('#figDetail'); if (f && f.__ro) f.__ro.disconnect();
  $('#sheet').hidden = true; document.body.style.overflow = ''; S.detail = null; S.tx = null;
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
      <div class="d-name">${esc(it.name)} <span class="muted num" style="font-size:14px;font-weight:500">${esc(D.kind === 'hold' ? it.code : it.symbol)}</span> ${D.kind === 'ind' ? gi(it.key) : ''}</div>
      <div class="d-price num">${fmt(it.price, digits)}</div>
      <div class="num ${cls(it.chg)}">${sgn(it.chg, digits)}（${sgn(it.chgPct)}%）<span class="muted small">　${esc(D.kind === 'hold' ? it.quoteSource : it.source)} ${hhmm(D.kind === 'hold' ? it.quoteTime : it.time)}</span></div>
    </div>
    ${D.kind === 'hold' && S.data.holdings.ledger ? `<div class="row act-row"><button class="btn" data-txopen="buy" data-txcode="${esc(it.code)}">加碼買進</button><button class="btn" data-txopen="sell" data-txcode="${esc(it.code)}">賣出</button>${apiV2() ? `<button class="btn" data-txopen="div" data-txcode="${esc(it.code)}">記錄配息</button>` : ''}</div>` : ''}
    ${D.kind === 'hold' && S.data.holdings.ledger && apiV2() ? `<div class="role-row"><span>角色 ${gi('ROLE')}</span>
      <div class="ranges" role="group" aria-label="核心或衛星">${['核心', '衛星'].map(r => `<button data-role="${r}" data-rolecode="${esc(it.code)}" aria-pressed="${it.role === r}">${r}</button>`).join('')}</div>
      <span>${it.roleSet ? `<button class="btn ghost small-btn" data-role="" data-rolecode="${esc(it.code)}">改回自動</button>` : `自動判斷：${esc(it.style || '')}`}</span></div>` : ''}
    <div class="ranges" role="group" aria-label="期間">${RANGES.map(r => `<button data-range="${r[0]}" aria-pressed="${D.range === r[0]}">${r[1]}</button>`).join('')}</div>
    <div class="toggles">${gi('MA')}${toggles.map(([k, l, c]) => `<label><input type="checkbox" data-opt="${k}" ${D.opts[k] ? 'checked' : ''}><i style="background:${c}"></i>${l}</label>`).join('')}</div>
    <div class="fig tall" id="figDetail"><div class="loading">載入走勢中…</div></div>
    <div class="stats" id="dStats"></div>
    ${D.kind === 'hold' && it.txs ? `<div class="sec-title" style="margin:16px 4px 6px"><h3>交易明細</h3><span class="muted small">${it.txs.length} 筆</span></div>
    <ul class="txlist card" id="txList">${it.txs.map(t => `<li>
      ${t.side === 'div' ? `<div><span class="tag div">配息</span>
        <span class="num">${esc(t.date || '—')}</span>
        <div class="num">每股 ${fmt(t.price, 4).replace(/0+$/, '').replace(/\.$/, '')} × ${money(t.shares)} 股<span class="muted small">${t.fee ? '　扣 ' + money(t.fee) : ''}</span></div>
        <div class="small">實收 <b class="num up">${sMoney(t.amount)}</b>${t.note ? `<span class="muted">　${esc(t.note)}</span>` : ''}</div>` : `
      <div><span class="tag ${t.side === 'buy' ? 'pos' : 'neg'}">${t.side === 'buy' ? '買進' : '賣出'}</span>
        <span class="num">${esc(t.date || '期初')}</span>
        <div class="num">${money(t.shares)} 股 × ${fmt(t.price, 2)}<span class="muted small">　費 ${money(t.fee)}${t.tax ? '　稅 ' + money(t.tax) : ''}</span></div>`}
        ${ok(t.realized) ? `<div class="small">已實現 <b class="num ${cls(t.realized)}">${sMoney(t.realized)}</b></div>` : ''}
        ${t.side === 'buy' && ok(it.price) ? `<div class="small muted">這筆目前 <b class="num ${cls((it.price - t.price) * t.shares)}">${sgn((it.price / t.price - 1) * 100)}%</b></div>` : ''}</div>
      ${t.id ? `<button class="btn ghost small-btn" data-deltx="${esc(t.id)}">刪除</button>` : ''}</li>`).join('')}</ul>` : ''}`;
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
  const cell = (k, v, c = '', g = '') => `<div><div class="k">${k} ${g ? gi(g) : ''}</div><div class="v num ${c}">${v}</div></div>`;
  let s = cell('區間報酬', sgn(rangeRet) + '%', cls(rangeRet), 'DRAWDOWN') + cell('區間最高', fmt(hi, digits)) + cell('區間最低', fmt(lo, digits)) +
    cell('距區間高點', sgn(fromHi) + '%', cls(fromHi), 'DRAWDOWN') + cell('距區間低點', sgn(fromLo) + '%', cls(fromLo));
  if (D.kind === 'hold') {
    const yieldPct = ok(h.ttmDiv) && h.ttmDiv > 0 && ok(last) ? h.ttmDiv / last * 100 : null;
    s = cell('持有股數', money(it.shares), '', 'ODD') + cell('平均成本', fmt(it.avg, 2), '', 'AVGCOST') + cell('損益兩平價', fmt(it.breakeven, 2), '', 'BREAKEVEN') +
      cell('市值', money(it.value)) + cell('未實現損益', sMoney(it.pnl) + '（' + sgn(it.pnlPct) + '%）', cls(it.pnl), 'UNREAL') +
      (S.data.holdings.ledger ? cell('累計領息', sMoney(it.divs || 0), cls(it.divs), 'DIV') +
        cell('含息損益', sMoney(it.totalPnl) + '（' + sgn(it.totalPct) + '%）', cls(it.totalPnl), 'TOTALRET') : '') +
      cell('賣出淨損益', sMoney(it.netPnl), cls(it.netPnl), 'NET') + cell('今日損益', sMoney(it.dayPnl), cls(it.dayPnl), 'DAY') +
      cell('占投資組合', fmt(it.weight, 1) + '%', '', 'WEIGHT') +
      cell('近 12 月配息', ok(h.ttmDiv) && h.ttmDiv > 0 ? fmt(h.ttmDiv, 2) + ' 元' : '—', '', 'YIELD') +
      cell('估算殖利率', ok(yieldPct) ? fmt(yieldPct, 2) + '%' : '—', '', 'YIELD') + s;
    s += `<div style="grid-column:1/-1"><div class="k">賣出成本估算 ${gi('FEE')}</div><div class="v small" style="font-weight:500">手續費 ${money(it.sellFee)} 元＋交易稅 ${money(it.sellTax)} 元；兩平價已含這兩項</div></div>`;
  } else {
    s += cell('5 日線', fmt(L('ma5'), digits), '', 'MA') + cell('20 日線', fmt(L('ma20'), digits), '', 'MA') + cell('60 日線', fmt(L('ma60'), digits), '', 'MA') +
      cell('52 週高', fmt(it.high52, digits)) + cell('52 週低', fmt(it.low52, digits));
  }
  s += `<div style="grid-column:1/-1"><div class="k">資料來源</div><div class="v small" style="font-weight:500">${esc(h.source)}${h.interval === '1wk' ? '（週線）' : '（日線）'}</div></div>`;
  $('#dStats').innerHTML = s;
}

/* ============ 新增交易 ============ */
const todayStr = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };

function loadSecurities() {
  const c = store.get('secs', null);
  if (c && c.list && Date.now() - c.at < 12 * 3600e3) return Promise.resolve(c.list);
  return api('getSecurities').then(r => { store.set('secs', { at: Date.now(), list: r.list }); return r.list; });
}

function secPool() {
  const held = S.data.holdings.rows.map(r => [r.code, r.name, r.market === 'otc' ? 'o' : 't', r.price]);
  const seen = new Set(held.map(h => h[0]));
  return held.concat((S.secs || []).filter(s => !seen.has(s[0])));
}

function searchSecs(q) {
  q = q.trim().toUpperCase();
  if (!q) return [];
  const out = [];
  for (const s of secPool()) {
    const c = s[0], n = String(s[1]).toUpperCase();
    const sc = c === q ? 0 : c.startsWith(q) ? 1 : n.includes(q) ? 2 : c.includes(q) ? 3 : -1;
    if (sc >= 0) out.push([sc, s]);
  }
  out.sort((a, b) => a[0] - b[0] || a[1][0].length - b[1][0].length || (a[1][0] < b[1][0] ? -1 : 1));
  return out.slice(0, 30).map(x => x[1]);
}

const heldOf = code => S.data.holdings.rows.find(r => r.code === code);
/** Apps Script 是否已更新到支援配息與核心／衛星的版本（舊版會把配息當成買進，所以一定要擋） */
const apiV2 = () => (S.data && S.data.apiVersion || 1) >= 2;
const calcFee = (amount, shares) => {
  const st = S.data.settings, min = shares % 1000 ? st.oddMinFee : st.minFee;
  return amount > 0 ? Math.max(min, Math.floor(amount * 0.001425 * st.feeDiscount)) : 0;
};
const calcTax = (amount, code) => Math.floor(amount * (/^00/.test(code) ? 0.001 : 0.003));
// 配息預估扣除額：單筆達 2 萬元預扣 2.11% 二代健保補充保費（實際只對 54C 部分扣，以入帳為準）
const calcDivDeduct = gross => gross >= 20000 ? Math.round(gross * 0.0211) : 0;
/** 可以記錄配息的標的：目前持有＋已出清 */
const divPool = () => S.data.holdings.rows.map(r => [r.code, r.name, r.market === 'otc' ? 'o' : 't', r.price])
  .concat((S.data.holdings.closed || []).filter(c => !heldOf(c.code)).map(c => [c.code, c.name, 't', null]));

function openTxForm(side, code, prefill) {
  closeDetail();
  S.tx = { side: side || 'buy', pick: null, feeEdited: false, taxEdited: false, prefill: prefill || null };
  $('#sheet').hidden = false; document.body.style.overflow = 'hidden';
  if (code) {
    const h = heldOf(code);
    if (h) S.tx.pick = [h.code, h.name, h.market === 'otc' ? 'o' : 't', h.price];
    else if (S.tx.side === 'div') S.tx.pick = divPool().find(s => s[0] === code) || null;
  }
  renderTxForm();
  if (!S.secs) loadSecurities().then(l => { S.secs = l; if (S.tx && !S.tx.pick) txSearch(); })
    .catch(e => { const r = $('#txResults'); if (r) r.innerHTML = `<li class="muted small">代號清單載入失敗（${esc(e.message || e)}），仍可搜尋已持有的股票</li>`; });
}

function renderTxForm() {
  const T = S.tx;
  if (T.side === 'div' && !apiV2()) T.side = 'buy';
  if (T.side === 'div') return renderDivForm();
  const p = T.pick, held = p ? heldOf(p[0]) : null;
  const sellable = S.data.holdings.rows.length > 0;
  $('#sheetBody').innerHTML = `
  <div class="d-head"><div class="d-name">新增交易</div><div class="muted small">平均成本法 ${gi('AVGCOST')}；手續費依設定的折扣自動計算，可以手動修改 ${gi('FEE')}</div></div>
  ${sideSwitch(sellable)}
  <form id="txForm" class="form" autocomplete="off" novalidate>
    ${p ? `<div class="picked card">
        <div><div class="d-name" style="font-size:17px">${esc(p[1])}</div>
        <div class="muted small"><span class="num">${esc(p[0])}</span>　${p[2] === 'o' ? '上櫃' : '上市'}${held ? '　持有 <span class="num">' + money(held.shares) + '</span> 股・均價 <span class="num">' + fmt(held.avg, 2) + '</span>' : ''}</div></div>
        <button type="button" class="btn ghost small-btn" data-unpick>更換</button></div>`
    : `<label>股票代號或名稱<input id="txQ" type="search" inputmode="search" placeholder="例如 0056、台積電、高股息" enterkeyhint="search"></label>
       <ul class="results" id="txResults">${T.side === 'sell' ? '' : '<li class="muted small">輸入代號或名稱開始搜尋</li>'}</ul>`}
    ${!p && T.side === 'sell' ? '' : ''}
    <div class="form-grid" ${p ? '' : 'hidden'}>
      <label>交易日期<input name="date" type="date" value="${todayStr()}" max="${todayStr()}"></label>
      <label>成交價<input name="price" type="text" inputmode="decimal" value="${p && ok(p[3]) ? p[3] : ''}"></label>
      <label class="span2">股數<input name="shares" type="text" inputmode="numeric" value="${T.side === 'sell' && held ? held.shares : 1000}"></label>
      <div class="span2 lots">${[[1000, '1 張'], [2000, '2 張'], [5000, '5 張'], [100, '100 股']].map(([v, l]) => `<button type="button" class="chip" data-lot="${v}">${l}</button>`).join('')}
        ${T.side === 'sell' && held ? `<button type="button" class="chip" data-lot="${held.shares}">全部 ${money(held.shares)} 股</button>` : ''}</div>
      <label>手續費<input name="fee" type="text" inputmode="numeric"></label>
      ${T.side === 'sell' ? '<label>交易稅<input name="tax" type="text" inputmode="numeric"></label>' : '<span></span>'}
      <label class="span2">備註（選填）<input name="note" type="text" maxlength="100" placeholder="例如：定期定額、跌深加碼"></label>
    </div>
    <div class="tx-sum card" id="txSum" ${p ? '' : 'hidden'}></div>
    <div class="banner" id="txErr" hidden></div>
    <button class="btn primary wide" type="submit" id="txSubmit" ${p ? '' : 'hidden'}>${T.side === 'buy' ? '確認買進' : '確認賣出'}</button>
  </form>`;
  if (p) updateTxSum(); else { const q = $('#txQ'); if (T.side === 'sell') txSearch(); setTimeout(() => q && q.focus(), 60); }
}

function sideSwitch(sellable) {
  const T = S.tx, canDiv = apiV2() && divPool().length > 0;
  return `<div class="ranges side" role="group" aria-label="交易類型">
    <button type="button" data-side="buy" aria-pressed="${T.side === 'buy'}">買進</button>
    <button type="button" data-side="sell" aria-pressed="${T.side === 'sell'}" ${sellable ? '' : 'disabled'}>賣出</button>
    <button type="button" data-side="div" aria-pressed="${T.side === 'div'}" ${canDiv ? '' : 'disabled'}>配息</button>
  </div>`;
}

/** 配息入帳表單：股數與平均成本不變，只累計「累計領息」 */
function renderDivForm() {
  const T = S.tx, p = T.pick, pf = T.prefill || {};
  const held = p ? heldOf(p[0]) : null;
  $('#sheetBody').innerHTML = `
  <div class="d-head"><div class="d-name">記錄配息</div><div class="muted small">券商入帳後記一筆，帳面損益就會把配息算回來 ${gi('DIV')}</div></div>
  ${sideSwitch(S.data.holdings.rows.length > 0)}
  <form id="txForm" class="form" autocomplete="off" novalidate>
    ${p ? `<div class="picked card">
        <div><div class="d-name" style="font-size:17px">${esc(p[1])}</div>
        <div class="muted small"><span class="num">${esc(p[0])}</span>${held ? '　持有 <span class="num">' + money(held.shares) + '</span> 股' : '　已出清'}</div></div>
        <button type="button" class="btn ghost small-btn" data-unpick>更換</button></div>`
    : `<label>股票代號或名稱<input id="txQ" type="search" inputmode="search" placeholder="例如 00929、高息" enterkeyhint="search"></label>
       <ul class="results" id="txResults"></ul>`}
    <div class="form-grid" ${p ? '' : 'hidden'}>
      <label>入帳日期<input name="date" type="date" value="${esc(pf.date || todayStr())}" max="${todayStr()}"></label>
      <label>每股配息（元）<input name="price" type="text" inputmode="decimal" value="${ok(pf.price) ? pf.price : ''}" placeholder="例如 0.38"></label>
      <label class="span2">領息股數<input name="shares" type="text" inputmode="numeric" value="${ok(pf.shares) ? pf.shares : held ? held.shares : ''}"></label>
      <label class="span2">扣除額（二代健保補充保費＋匯費）<input name="fee" type="text" inputmode="numeric"></label>
      <label class="span2">備註（選填）<input name="note" type="text" maxlength="100" value="${esc(pf.note || '')}" placeholder="例如：除息日 2026-10-19"></label>
    </div>
    <p class="muted small" ${p ? '' : 'hidden'}>扣除額會自動預估（單筆 2 萬元以上預扣 2.11%），但 ETF 配息常常只有一部分要扣，<b>請以存摺或券商的實際入帳金額為準</b>，不同就直接改。</p>
    <div class="tx-sum card" id="txSum" ${p ? '' : 'hidden'}></div>
    <div class="banner" id="txErr" hidden></div>
    <button class="btn primary wide" type="submit" id="txSubmit" ${p ? '' : 'hidden'}>確認記錄配息</button>
  </form>`;
  if (p) updateTxSum(); else { txSearch(); setTimeout(() => { const q = $('#txQ'); if (q) q.focus(); }, 60); }
}

function txSearch() {
  const box = $('#txResults'); if (!box) return;
  const q = ($('#txQ') || {}).value || '';
  let list;
  if (S.tx.side === 'sell') list = S.data.holdings.rows.filter(r => !q || r.code.includes(q.toUpperCase()) || r.name.includes(q))
    .map(r => [r.code, r.name, r.market === 'otc' ? 'o' : 't', r.price]);
  else if (S.tx.side === 'div') list = divPool().filter(s => !q || s[0].includes(q.toUpperCase()) || String(s[1]).includes(q));
  else list = searchSecs(q);
  if (!q && S.tx.side === 'buy') { box.innerHTML = `<li class="muted small">${S.secs ? '輸入代號或名稱開始搜尋' : '正在載入上市櫃代號清單…'}</li>`; return; }
  box.innerHTML = list.length ? list.map(s => `<li><button type="button" data-pick="${esc(s[0])}">
      <span class="num code">${esc(s[0])}</span><span class="nm">${esc(s[1])}${heldOf(s[0]) ? ' <span class="tag pos">持有</span>' : S.tx.side === 'div' ? ' <span class="tag">已出清</span>' : ''}</span>
      <span class="num muted">${ok(s[3]) ? fmt(s[3], 2) : ''}</span></button></li>`).join('')
    : `<li class="muted small">${S.secs || S.tx.side !== 'buy' ? '找不到符合的股票' : '代號清單載入中…'}</li>`;
}

function txValues() {
  const f = $('#txForm'); if (!f) return null;
  const g = n => (f.elements[n] ? String(f.elements[n].value).replace(/,/g, '').trim() : '');
  return { date: g('date'), price: Number(g('price')), shares: Math.round(Number(g('shares'))), fee: g('fee'), tax: g('tax'), note: g('note') };
}

function updateTxSum() {
  const T = S.tx, p = T.pick, v = txValues(); if (!p || !v) return;
  const f = $('#txForm'), held = heldOf(p[0]);
  const amount = ok(v.price) && ok(v.shares) ? v.price * v.shares : 0;
  if (T.side === 'div') {
    const gross = Math.round(amount);
    if (!T.feeEdited) f.elements.fee.value = gross ? calcDivDeduct(gross) : '';
    const ded = Number(f.elements.fee.value) || 0, net = gross - ded;
    const newTotal = held && ok(held.totalPnl) ? held.totalPnl + net : null;
    $('#txSum').innerHTML = `<div class="kv"><div class="k">應收（股數 × 每股配息）</div><div class="v num">${money(gross)} 元</div></div>
      <div class="kv"><div class="k">實際入帳</div><div class="v num up">${money(net)} 元</div></div>
      ${held && held.cost ? `<div class="kv"><div class="k">這次配息 ÷ 投入成本</div><div class="v num">${fmt(net / held.cost * 100, 2)}%</div></div>
      <div class="kv"><div class="k">記錄後的含息損益</div><div class="v num ${cls(newTotal)}">${sMoney(newTotal)}<small>${sgn(newTotal / held.cost * 100)}%</small></div></div>` : ''}`;
    return;
  }
  if (!T.feeEdited) f.elements.fee.value = amount ? calcFee(amount, v.shares) : '';
  if (T.side === 'sell' && !T.taxEdited) f.elements.tax.value = amount ? calcTax(amount, p[0]) : '';
  const fee = Number(f.elements.fee.value) || 0, tax = T.side === 'sell' ? (Number(f.elements.tax.value) || 0) : 0;
  let html;
  if (T.side === 'buy') {
    const total = amount + fee;
    const newAvg = held ? (held.cost + total) / (held.shares + v.shares) : (v.shares ? total / v.shares : null);
    html = `<div class="kv"><div class="k">總付出</div><div class="v num">${money(total)} 元</div></div>
      <div class="kv"><div class="k">${held ? '加碼後平均成本' : '平均成本'}</div><div class="v num">${fmt(newAvg, 2)}${held ? `<small class="muted">原 ${fmt(held.avg, 2)}</small>` : ''}</div></div>`;
  } else {
    const net = amount - fee - tax, cost = held ? held.avg * v.shares : 0, pl = net - cost;
    html = `<div class="kv"><div class="k">實收金額</div><div class="v num">${money(net)} 元</div></div>
      <div class="kv"><div class="k">預估已實現損益</div><div class="v num ${cls(pl)}">${sMoney(pl)}<small>${cost ? sgn(pl / cost * 100) + '%' : ''}</small></div></div>`;
  }
  $('#txSum').innerHTML = html;
}

function submitTx() {
  const T = S.tx, p = T.pick, v = txValues(), err = $('#txErr');
  const fail = m => { err.hidden = false; err.textContent = m; };
  err.hidden = true;
  if (!p) return fail('請先選擇股票');
  if (T.side === 'div') {
    if (!(v.price > 0)) return fail('請輸入每股配息');
    if (!(v.shares > 0)) return fail('請輸入領息股數');
    const gross = Math.round(v.price * v.shares), ded = Number(v.fee) || 0;
    if (ded < 0 || ded >= gross) return fail('扣除額不正確');
    const btn = $('#txSubmit'); btn.disabled = true; btn.textContent = '寫入中…';
    return apiPost('addTx', { tx: { code: p[0], side: 'div', date: v.date, price: v.price, shares: v.shares, fee: v.fee, note: v.note } })
      .then(() => {
        if (T.prefill && T.prefill.key) ignoreHintsSilently([T.prefill.key]);
        toast(`已記錄配息：${p[1]} ${money(gross - ded)} 元`);
        closeDetail(); S.hist = {}; load(true);
      })
      .catch(e => { fail(e.message || String(e)); btn.disabled = false; btn.textContent = '確認記錄配息'; });
  }
  if (!(v.price > 0)) return fail('請輸入成交價');
  if (!(v.shares > 0)) return fail('請輸入股數');
  const held = heldOf(p[0]);
  if (T.side === 'sell' && (!held || v.shares > held.shares)) return fail('賣出股數超過持有股數');
  const btn = $('#txSubmit'); btn.disabled = true; btn.textContent = '寫入中…';
  apiPost('addTx', { tx: { code: p[0], side: T.side, date: v.date, price: v.price, shares: v.shares, fee: v.fee, tax: T.side === 'sell' ? v.tax : '', note: v.note } })
    .then(() => {
      toast(`已記錄：${T.side === 'buy' ? '買進' : '賣出'} ${p[1]} ${money(v.shares)} 股`);
      closeDetail(); S.hist = {}; load(true);
    })
    .catch(e => { fail(e.message || String(e)); btn.disabled = false; btn.textContent = T.side === 'buy' ? '確認買進' : '確認賣出'; });
}

function deleteTx(btn) {
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1'; btn.textContent = '再按一次確認'; btn.classList.add('danger');
    setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = '刪除'; btn.classList.remove('danger'); } }, 4000);
    return;
  }
  btn.disabled = true; btn.textContent = '刪除中…';
  apiPost('deleteTx', { id: btn.dataset.deltx })
    .then(() => { toast('已刪除這筆交易'); closeDetail(); load(true); })
    .catch(e => { toast('刪除失敗：' + (e.message || e)); btn.disabled = false; btn.textContent = '刪除'; });
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
  const g = e.target.closest('[data-gl]');
  if (g) { e.preventDefault(); e.stopPropagation(); return openGlossary(g.dataset.gl); }
  if (e.target.closest('[data-gclose]')) return closeGlossary();
  const t = e.target.closest('button,[data-close]');
  if (!t) return;
  if (t.hasAttribute('data-close')) return closeDetail();
  if (t.dataset.tab) return showTab(t.dataset.tab);
  if (t.id === 'btnRefresh') return load();
  if (t.id === 'btnSettings') return renderSetup();
  if (t.id === 'btnAddTx') return openTxForm('buy');
  if (t.dataset.txopen) return openTxForm(t.dataset.txopen, t.dataset.txcode);
  if (t.dataset.deltx) return deleteTx(t);
  if (t.dataset.divign) return ignoreHints([t.dataset.divign]);
  if (t.hasAttribute('data-divignall')) return ignoreHints(visibleHints().map(hintKey));
  if (t.dataset.divrec) {
    const x = visibleHints().find(h => hintKey(h) === t.dataset.divrec); if (!x) return;
    return openTxForm('div', x.code, { key: hintKey(x), price: x.perShare, shares: x.shares, note: '除息日 ' + x.exDate });
  }
  if (t.dataset.rolecode !== undefined && t.dataset.role !== undefined && S.detail) {
    const it = heldOf(t.dataset.rolecode);
    if (it && it.roleSet && it.role === t.dataset.role) return;
    if (it && !it.roleSet && t.dataset.role === it.role) return setRole(t.dataset.rolecode, t.dataset.role, t); // 鎖定成手動
    return setRole(t.dataset.rolecode, t.dataset.role, t);
  }
  if (S.tx) {
    if (t.dataset.side && !t.disabled) { S.tx.side = t.dataset.side; S.tx.feeEdited = S.tx.taxEdited = false;
      if (S.tx.side === 'sell' && S.tx.pick && !heldOf(S.tx.pick[0])) S.tx.pick = null;
      if (S.tx.side === 'div' && S.tx.pick && !divPool().some(x => x[0] === S.tx.pick[0])) S.tx.pick = null;
      return renderTxForm(); }
    if (t.dataset.pick) { S.tx.pick = (S.tx.side === 'div' ? divPool() : secPool()).find(s => s[0] === t.dataset.pick); return renderTxForm(); }
    if (t.hasAttribute('data-unpick')) { S.tx.pick = null; S.tx.prefill = null; return renderTxForm(); }
    if (t.dataset.lot) { $('#txForm').elements.shares.value = t.dataset.lot; return updateTxSum(); }
  }
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

document.addEventListener('input', e => {
  if (!S.tx) return;
  if (e.target.id === 'txQ') return txSearch();
  if (e.target.name === 'fee') S.tx.feeEdited = true;
  if (e.target.name === 'tax') S.tx.taxEdited = true;
  if (e.target.closest('#txForm')) updateTxSum();
});

document.addEventListener('submit', e => {
  if (e.target.id === 'txForm') { e.preventDefault(); return submitTx(); }
  if (e.target.id !== 'setupForm') return;
  e.preventDefault();
  const f = new FormData(e.target);
  CFG.url = String(f.get('url')).trim(); CFG.key = String(f.get('key')).trim();
  store.set('apiUrl', CFG.url); store.set('apiKey', CFG.key);
  S.hist = {};
  $('#v-setup').innerHTML = '<div class="skeleton"></div>';
  load();
});

document.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.dataset && e.target.dataset.gl && e.target.tagName === 'SPAN') { e.preventDefault(); return openGlossary(e.target.dataset.gl); }
  if (e.key === 'Escape') { if (!$('#gloss').hidden) return closeGlossary(); if (S.detail || S.tx) closeDetail(); }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.data && Date.now() - S.data.asOf > 5 * 60000) load(true);
});

if (S.tab === 'setup') S.tab = 'overview';
showTab(S.tab);
load(true);
}
