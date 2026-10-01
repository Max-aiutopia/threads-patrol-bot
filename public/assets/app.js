// Threads 海巡 後台。沒有框架、沒有外部 JS，圖表是手寫的 SVG。
// 安全：API 回來的值一律用 textContent／文字節點放進畫面，整份檔案不用 innerHTML。

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const TPE_OFFSET = 8 * HOUR; // 台灣沒有日光節約
const EST_IN = 1950; // 產一批 5 則留言的估計 token 數
const EST_OUT = 1040;
let usdTwd = 31.74;

// ============ DOM 小工具 ============

function el(tag, props, ...kids) {
  const n = document.createElement(tag);
  setProps(n, props);
  appendKids(n, kids);
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, props, ...kids) {
  const n = document.createElementNS(SVGNS, tag);
  setProps(n, props);
  appendKids(n, kids);
  return n;
}

function setProps(n, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = String(v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'value') n.value = v;
    else if (k === 'checked') n.checked = !!v;
    else n.setAttribute(k, v === true ? '' : String(v));
  }
}

function appendKids(n, kids) {
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false || c === '') continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

function clear(n) {
  while (n.firstChild) n.removeChild(n.firstChild);
}

function mount(n, ...kids) {
  clear(n);
  appendKids(n, kids);
}

const nw = (s) => el('span', { class: 'nw' }, s);

const THREADS_HOSTS = new Set(['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net']);
function threadsHref(u) {
  if (typeof u !== 'string') return null;
  try {
    const x = new URL(u);
    if (x.protocol === 'https:' && THREADS_HOSTS.has(x.hostname)) return x.href;
  } catch {
    /* 不是網址 */
  }
  return null;
}

function extLink(href, text) {
  const h = threadsHref(href);
  if (!h) return el('span', null, text);
  return el('a', { href: h, target: '_blank', rel: 'noopener noreferrer' }, text);
}

// ============ 格式 ============

const nf = new Intl.NumberFormat('zh-TW');
const fmtN = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : nf.format(Math.round(Number(n))));
const fmtSigned = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n === 0) return '±0';
  return `${n > 0 ? '+' : '−'}${nf.format(Math.abs(Math.round(n)))}`;
};
const fmtUsd = (n) =>
  `US$${Number(n || 0).toLocaleString('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtTwd = (usd, digits = 0) =>
  `NT$${(Number(usd || 0) * usdTwd).toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
const pad = (n) => String(n).padStart(2, '0');
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

function tpe(ms) {
  const d = new Date(ms + TPE_OFFSET);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), hh: pad(d.getUTCHours()), mm: pad(d.getUTCMinutes()), wd: d.getUTCDay() };
}
const fmtTime = (ms) => {
  if (!ms) return '—';
  const t = tpe(ms);
  return `${t.m}/${t.d} ${t.hh}:${t.mm}`;
};
const fmtHM = (ms) => {
  const t = tpe(ms);
  return `${t.hh}:${t.mm}`;
};
const fmtDate = (ms) => {
  const t = tpe(ms);
  return `${t.y}/${t.m}/${t.d}`;
};
const fmtDay = (s) => {
  const [, m, d] = String(s).split('-');
  return `${Number(m)}/${Number(d)}`;
};
const taipeiDateStr = (ms) => new Date(ms + TPE_OFFSET).toISOString().slice(0, 10);
const dayIndex = (s) => Math.round(Date.parse(`${s}T00:00:00Z`) / DAY);

function timeUntil(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return '現在';
  const m = Math.ceil(diff / 60000);
  if (m < 60) return `${m} 分鐘後`;
  const h = Math.round(diff / HOUR);
  if (h < 48) return `${h} 小時後`;
  return `${Math.round(diff / DAY)} 天後`;
}

// ============ API ============

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError('連不上伺服器，檢查網路後再試一次', 0);
  }
  if (res.status === 401) {
    location.href = '/login';
    throw new ApiError('登入過期了，重新登入', 401);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* 不是 JSON */
  }
  if (!res.ok) throw new ApiError((data && data.message) || `出錯了（${res.status}）`, res.status, data);
  return data;
}

// 按鈕送出時：鎖住、改字，結束還原
async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  if (label) btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.textContent = old;
  }
}

// 危險動作：按第一次變成「再按一次」，4 秒內再按才執行（不用彈窗）
function armButton(btn, armedLabel, fn) {
  let timer = null;
  const idle = btn.textContent;
  btn.addEventListener('click', async () => {
    if (!btn.classList.contains('is-armed')) {
      btn.classList.add('is-armed');
      btn.textContent = armedLabel;
      timer = setTimeout(() => {
        btn.classList.remove('is-armed');
        btn.textContent = idle;
      }, 4000);
      return;
    }
    clearTimeout(timer);
    btn.classList.remove('is-armed');
    btn.textContent = idle;
    await fn();
  });
  return btn;
}

// ============ 提示條 ============

const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(msg, bad = false) {
  toastEl.textContent = msg;
  toastEl.classList.toggle('is-bad', bad);
  toastEl.classList.remove('is-hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add('is-hidden'), bad ? 4200 : 2600);
}

// ============ 共用區塊 ============

function sec(title, aside, ...content) {
  return el('section', { class: 'sec' },
    el('div', { class: 'sec-head' }, el('h2', { text: title }), aside ? el('div', { class: 'aside' }, aside) : null),
    ...content);
}

function skeleton() {
  return el('div', { class: 'skel', 'aria-hidden': 'true' },
    el('i', { class: 'w40' }), el('i', { class: 'tall' }), el('i', { class: 'w80' }), el('i', { class: 'w60' }));
}

function emptyState(text, action) {
  return el('div', { class: 'empty' }, el('p', { text }), action || null);
}

function errorBox(err, retry) {
  return el('div', { class: 'error-box', role: 'alert' },
    el('p', { text: err && err.message ? err.message : '讀取失敗' }),
    retry ? el('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: retry }, '再試一次') : null);
}

function facts(rows) {
  return el('dl', { class: 'facts' }, rows.filter(Boolean).map(([k, v]) => el('div', null, el('dt', { text: k }), el('dd', null, v))));
}

function formMsg() {
  const p = el('p', { class: 'form-msg', role: 'status', 'aria-live': 'polite' });
  p.set = (text, kind) => {
    p.textContent = text || '';
    p.classList.toggle('is-bad', kind === 'bad');
    p.classList.toggle('is-good', kind === 'good');
  };
  return p;
}

function table(columns, rows, { rowClass } = {}) {
  const thead = el('thead', null, el('tr', null, columns.map((c) => el('th', { class: c.th || c.cls || null, scope: 'col' }, c.label))));
  const tbody = el('tbody', null, rows.map((r) =>
    el('tr', { class: rowClass ? rowClass(r) : null }, columns.map((c) => el('td', { class: c.cls || null, 'data-label': c.label }, c.cell(r))))));
  return el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' }, thead, tbody));
}

function field({ id, label, hint, input, err }) {
  if (hint) {
    const target = input.id === id ? input : input.querySelector(`#${CSS.escape(id)}`);
    if (target) target.setAttribute('aria-describedby', `${id}-hint`);
  }
  return el('div', { class: 'field' },
    el('label', { for: id }, label),
    input,
    hint ? el('p', { class: 'hint', id: `${id}-hint` }, hint) : null,
    err || null);
}

function splitList(s) {
  return String(s || '')
    .split(/[\n,，、]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function splitLines(s) {
  return String(s || '')
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

// ============ 圖表 ============

function niceTicks(min, max, count, { zero = false, integer = true } = {}) {
  if (zero) min = Math.min(0, min);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0, hi: 1, ticks: [0, 1] };
  if (min === max) {
    const p = Math.max(integer ? 1 : 0.01, Math.abs(max) * 0.05);
    max += p;
    if (!zero) min -= p;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return { lo, hi, ticks };
}

function whenSized(wrap, draw) {
  let lastW = 0;
  const run = () => {
    const w = Math.floor(wrap.clientWidth);
    if (!w || w === lastW) return;
    lastW = w;
    draw(w);
  };
  if ('ResizeObserver' in window) new ResizeObserver(run).observe(wrap);
  else window.addEventListener('resize', run);
  requestAnimationFrame(run);
}

// 折線圖（粉絲數）。points: [{ date, value }]
function lineChart(points, { height = 190, label, readout }) {
  const wrap = el('div', { class: 'chart' });
  const read = el('p', { class: 'chart-read', 'aria-live': 'off' });
  const svg = sv('svg', { role: 'img', 'aria-label': label });
  wrap.append(read, svg);
  const setRead = (i) => mount(read, readout(points[i]));
  setRead(points.length - 1);

  whenSized(wrap, (w) => {
    clear(svg);
    const h = height;
    const padL = 46, padR = 14, padT = 12, padB = 26;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('height', String(h));
    const vals = points.map((p) => p.value);
    const { lo, hi, ticks } = niceTicks(Math.min(...vals), Math.max(...vals), w < 480 ? 3 : 4);
    const xs = points.map((p) => dayIndex(p.date));
    const x0 = xs[0];
    const spanX = Math.max(1, xs[xs.length - 1] - x0);
    const plotW = w - padL - padR;
    const X = (i) => (points.length === 1 ? padL + plotW / 2 : padL + ((xs[i] - x0) / spanX) * plotW);
    const Y = (v) => padT + ((hi - v) / (hi - lo || 1)) * (h - padT - padB);

    for (const t of ticks) {
      const y = Math.round(Y(t)) + 0.5;
      svg.append(sv('line', { class: 'c-grid', x1: padL, x2: w - padR, y1: y, y2: y }));
      svg.append(sv('text', { class: 'c-ax', x: padL - 8, y: y + 4, 'text-anchor': 'end' }, fmtN(t)));
    }
    const labelIdx = points.length <= 2 ? [0, points.length - 1] : [0, Math.floor((points.length - 1) / 2), points.length - 1];
    [...new Set(labelIdx)].forEach((i, k, arr) => {
      const anchor = arr.length === 1 ? 'middle' : k === 0 ? 'start' : k === arr.length - 1 ? 'end' : 'middle';
      svg.append(sv('text', { class: 'c-ax', x: X(i), y: h - 6, 'text-anchor': anchor }, fmtDay(points[i].date)));
    });

    if (points.length > 1) {
      const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.value).toFixed(1)}`).join('');
      svg.append(sv('path', { class: 'c-line', d }));
    }
    const li = points.length - 1;
    svg.append(sv('circle', { class: 'c-dot-ring', cx: X(li), cy: Y(points[li].value), r: 3.5 }));

    const guide = sv('line', { class: 'c-guide', y1: padT, y2: h - padB, visibility: 'hidden' });
    const dot = sv('circle', { class: 'c-dot', r: 3.5, visibility: 'hidden' });
    svg.append(guide, dot);
    const hit = sv('rect', { class: 'c-hit', x: padL, y: 0, width: plotW, height: h - padB });
    svg.append(hit);

    const nearest = (clientX) => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * w;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < points.length; i++) {
        const dd = Math.abs(X(i) - px);
        if (dd < bd) { bd = dd; best = i; }
      }
      return best;
    };
    const on = (e) => {
      const i = nearest(e.clientX);
      const x = X(i);
      guide.setAttribute('x1', x); guide.setAttribute('x2', x); guide.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', x); dot.setAttribute('cy', Y(points[i].value)); dot.setAttribute('visibility', 'visible');
      setRead(i);
    };
    const off = () => {
      guide.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      setRead(points.length - 1);
    };
    hit.addEventListener('pointermove', on);
    hit.addEventListener('pointerdown', on);
    hit.addEventListener('pointerleave', off);
  });
  return wrap;
}

// 長條圖（個人檔案瀏覽、每日花費）。points: [{ date, value|null, ... }]
function barChart(points, { height = 160, label, readout, format = fmtN, integer = true }) {
  const wrap = el('div', { class: 'chart' });
  const read = el('p', { class: 'chart-read', 'aria-live': 'off' });
  const svg = sv('svg', { role: 'img', 'aria-label': label });
  wrap.append(read, svg);
  let lastIdx = points.length - 1;
  for (let i = points.length - 1; i >= 0; i--) if (points[i].value != null) { lastIdx = i; break; }
  const setRead = (i) => mount(read, readout(points[i]));
  setRead(lastIdx);

  whenSized(wrap, (w) => {
    clear(svg);
    const h = height;
    const padL = 46, padR = 6, padT = 10, padB = 26;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('height', String(h));
    const vals = points.map((p) => p.value).filter((v) => v != null);
    const { hi, ticks } = niceTicks(0, Math.max(0, ...vals), 3, { zero: true, integer });
    const plotW = w - padL - padR;
    const band = plotW / points.length;
    const bw = Math.max(2, Math.min(22, band * 0.64));
    const Y = (v) => padT + ((hi - v) / (hi || 1)) * (h - padT - padB);

    for (const t of ticks) {
      const y = Math.round(Y(t)) + 0.5;
      svg.append(sv('line', { class: t === 0 ? 'c-base' : 'c-grid', x1: padL, x2: w - padR, y1: y, y2: y }));
      svg.append(sv('text', { class: 'c-ax', x: padL - 8, y: y + 4, 'text-anchor': 'end' }, format(t)));
    }
    const bars = points.map((p, i) => {
      if (p.value == null || p.value <= 0) return null;
      const x = padL + band * i + (band - bw) / 2;
      const y = Y(p.value);
      const r = sv('rect', { class: i === lastIdx ? 'c-bar is-on' : 'c-bar', x: x.toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: Math.max(1, Y(0) - y).toFixed(1), rx: 1 });
      svg.append(r);
      return r;
    });
    const labelIdx = [0, Math.floor((points.length - 1) / 2), points.length - 1];
    [...new Set(labelIdx)].forEach((i, k, arr) => {
      const anchor = k === 0 ? 'start' : k === arr.length - 1 ? 'end' : 'middle';
      const x = anchor === 'start' ? padL + band * i : anchor === 'end' ? padL + band * (i + 1) : padL + band * (i + 0.5);
      svg.append(sv('text', { class: 'c-ax', x, y: h - 6, 'text-anchor': anchor }, fmtDay(points[i].date)));
    });

    const hit = sv('rect', { class: 'c-hit', x: padL, y: 0, width: plotW, height: h - padB });
    svg.append(hit);
    let cur = lastIdx;
    const select = (i) => {
      if (bars[cur]) bars[cur].setAttribute('class', 'c-bar');
      cur = i;
      if (bars[cur]) bars[cur].setAttribute('class', 'c-bar is-on');
      setRead(i);
    };
    const on = (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * w;
      const i = Math.min(points.length - 1, Math.max(0, Math.floor((px - padL) / band)));
      if (i !== cur) select(i);
    };
    hit.addEventListener('pointermove', on);
    hit.addEventListener('pointerdown', on);
    hit.addEventListener('pointerleave', () => select(lastIdx));
  });
  return wrap;
}

// 熱力圖：星期 × 2 小時
function heatmap(hm) {
  const wrap = el('div', { class: 'chart' });
  const read = el('p', { class: 'chart-read' });
  const vals = [];
  hm.cells.forEach((row) => row.forEach((c) => { if (c.avgViews != null) vals.push(c.avgViews); }));
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * vals.length))];
  const cuts = vals.length ? [q(0.2), q(0.4), q(0.6), q(0.8)] : [];
  const level = (v) => {
    if (v == null) return 0;
    let lv = 1;
    for (const c of cuts) if (v > c) lv++;
    return Math.min(5, lv);
  };
  const describe = (wd, slot) => {
    const c = hm.cells[wd][slot];
    const span = `週${hm.weekdayLabels[wd]} ${pad(slot * 2)}:00–${pad(slot * 2 + 2)}:00`;
    if (!c.count) return [el('b', { text: span }), '　沒有貼文'];
    return [el('b', { text: span }), `　${fmtN(c.count)} 篇`, c.avgViews != null ? `　平均觀看 ${fmtN(c.avgViews)}` : '　還沒有觀看數'];
  };
  mount(read, '點一格看細節');

  const svg = sv('svg', { role: 'img', 'aria-label': '發文時段熱力圖：星期 × 2 小時，顏色越深平均觀看越高' });
  wrap.append(read, svg);
  whenSized(wrap, (w) => {
    clear(svg);
    const labelW = 24;
    const topH = 18;
    const cw = (w - labelW) / 12;
    const ch = Math.min(34, Math.max(22, cw * 0.8));
    const h = topH + ch * 7;
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('height', String(h));
    for (let s = 0; s < 12; s++) {
      if (w < 520 && s % 3) continue;
      svg.append(sv('text', { class: 'c-ax', x: labelW + s * cw + 2, y: 12 }, `${s * 2}`));
    }
    let active = null;
    for (let d = 0; d < 7; d++) {
      svg.append(sv('text', { class: 'c-ax', x: 0, y: topH + d * ch + ch / 2 + 4 }, hm.weekdayLabels[d]));
      for (let s = 0; s < 12; s++) {
        const c = hm.cells[d][s];
        const x = labelW + s * cw;
        const y = topH + d * ch;
        const rect = c.count
          ? sv('rect', { class: `hm-cell hm${level(c.avgViews)}`, x: x.toFixed(1), y: y.toFixed(1), width: cw.toFixed(1), height: ch.toFixed(1), rx: 2 })
          : sv('rect', { class: 'hm-cell hm-empty', x: (x + 2).toFixed(1), y: (y + 2).toFixed(1), width: (cw - 4).toFixed(1), height: (ch - 4).toFixed(1), rx: 2 });
        const pick = () => {
          if (active) active.classList.remove('is-on');
          active = rect;
          rect.classList.add('is-on');
          mount(read, describe(d, s));
        };
        rect.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') pick(); });
        rect.addEventListener('click', pick);
        svg.append(rect);
      }
    }
  });

  const legend = el('div', { class: 'hm-legend', 'aria-hidden': 'true' },
    '觀看少', [1, 2, 3, 4, 5].map((i) => el('i', { style: `background: var(--heat-${i})` })), '多',
    el('span', { style: 'margin-left: 12px' }, el('i', { style: 'background: var(--heat-0)' }), ' 有貼文、還沒數據'));
  wrap.append(legend);
  return wrap;
}

// ============ 狀態列（刊頭與暫停橫條） ============

let overviewCache = null;
let overviewLoadedAt = 0;

async function loadOverview() {
  const d = await api('/api/overview');
  overviewCache = d;
  overviewLoadedAt = Date.now();
  paintStatus(d);
  return d;
}

function paintStatus(d) {
  const status = document.getElementById('mast-status');
  const bits = [];
  if (d.threads && d.threads.connected) {
    bits.push(el('span', null, `@${d.threads.username || '帳號'} 已連結`));
    if (d.threads.daysLeft != null && d.threads.daysLeft < 10) bits.push(el('span', { style: 'color: var(--bad)' }, `授權剩 ${d.threads.daysLeft} 天`));
  } else {
    bits.push(el('a', { href: '#settings' }, '還沒連結 Threads'));
  }
  if (d.today) {
    bits.push(el('span', null, '今天 ', nw(`${fmtN(d.today.opened)}／${fmtN(d.today.cap)} 則`)));
    if (d.today.nextAllowedAt) bits.push(el('span', null, nw(`下一則 ${fmtHM(d.today.nextAllowedAt)} 後`)));
  }
  mount(status, bits.map((b, i) => (i ? [el('span', { class: 'sep', 'aria-hidden': 'true' }, '·'), b] : b)));

  const band = document.getElementById('pause-band');
  if (d.pause) {
    document.getElementById('pause-text').textContent = `到 ${fmtTime(d.pause.untilAt)}（${d.pause.reason}）。草稿照樣能產，只是不開 Threads。`;
    band.hidden = false;
  } else {
    band.hidden = true;
  }
}

document.getElementById('pause-resume').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  try {
    await busy(btn, '恢復中…', () => api('/api/resume', { method: 'POST' }));
    toast('已恢復');
    await loadOverview();
    rerenderIfShown(['overview']);
    if (repaintPause && currentRoute().id === 'settings') repaintPause();
  } catch (err) {
    toast(err.message, true);
  }
});

function threadsBlock(t) {
  if (t && t.connected) {
    return el('div', null,
      facts([
        ['帳號', `@${t.username || '—'}`],
        ['授權剩', el('span', { style: t.daysLeft < 10 ? 'color: var(--bad)' : null }, nw(`${fmtN(t.daysLeft)} 天`))],
        ['到期日', t.expiresAt ? fmtDate(t.expiresAt) : '—'],
      ]),
      el('p', { class: 'hint', style: 'margin-top: 10px' }, '每週一 03:00 自動續期。續期失敗或剩不到 10 天會在 LINE 通知。'),
      el('div', { class: 'actions' }, el('a', { class: 'btn btn-sm btn-quiet', href: '/auth/threads/start' }, '重新連結')));
  }
  const expired = t && t.expiresAt && !t.connected;
  return el('div', null,
    el('p', { class: 'prose' }, expired ? 'Threads 授權過期了，要重新連結。' : '還沒連結 Threads。連結後才抓得到粉絲數、貼文成效和留言觀看。'),
    el('div', { class: 'actions' }, el('a', { class: 'btn', href: '/auth/threads/start' }, '連結 Threads')));
}

// ============ 總覽 ============

let markDrawn = false;

async function renderOverview(body) {
  const d = await loadOverview();
  const t = tpe(Date.now());
  document.getElementById('ov-date').textContent = `${t.m} 月 ${t.d} 日（${WEEK[t.wd]}）`;

  // 第一次打開：還沒連結、近 7 天也沒留言 → 最上面放「開始使用」
  const fresh = !d.threads.connected && !(d.week && d.week.comments);
  const start = fresh
    ? sec('開始使用', null,
        el('ol', { class: 'steps' },
          el('li', null, '按下面的「連結 Threads」，授權讀取你自己帳號的數據。'),
          el('li', null, '在 LINE 貼一篇 Threads 貼文網址，下一行貼原文（或下一則傳截圖）。'),
          el('li', null, '按卡片上的「開 Threads 回覆」，在 Threads 按送出。下一個整點過 15 分會出現在「留言紀錄」。')),
        el('div', { class: 'actions' }, el('a', { class: 'btn', href: '/auth/threads/start' }, '連結 Threads')))
    : null;

  // 粉絲
  let followers;
  if (!d.followersSeries.length) {
    followers = sec('粉絲', null, emptyState(
      d.threads.connected ? '還沒有粉絲數據。每天 23:50 存一次；想現在就存，到「用量」手動跑每日快照。' : '還沒有粉絲數據。連結 Threads 之後，每天 23:50 存一次。',
      d.threads.connected ? el('a', { class: 'btn btn-sm btn-quiet', href: '#usage' }, '去用量') : null));
  } else {
    const f = d.followers;
    const num = el('span', { class: 'mark' }, fmtN(f.today));
    if (!markDrawn && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      num.classList.add('is-drawing');
      markDrawn = true;
    }
    const delta = (label, v) => el('span', { class: v > 0 ? 'up' : v < 0 ? 'down' : null }, nw(`${label} ${fmtSigned(v)}`));
    followers = sec('粉絲', f.asOf ? `${fmtDay(f.asOf)} 的數字` : null,
      el('p', null, el('span', { class: 'figure' }, num), el('span', { class: 'figure-unit' }, '位')),
      el('p', { class: 'figure-sub' }, delta('7 天', f.delta7), '　', delta('30 天', f.delta30)),
      el('div', { style: 'margin-top: 20px' },
        lineChart(d.followersSeries.map((p) => ({ date: p.date, value: p.followers })), {
          label: `近 90 天粉絲數，最新 ${fmtN(f.today)} 位`,
          readout: (p) => [el('b', { text: fmtDay(p.date) }), `　${fmtN(p.value)} 位`],
        })));
  }

  // 個人檔案瀏覽
  let views;
  const pv = d.profileViewsSeries || [];
  if (!pv.some((p) => p.views != null)) {
    views = sec('個人檔案瀏覽', '近 30 天', emptyState('還沒有瀏覽數據。'));
  } else {
    const total = pv.reduce((a, p) => a + (p.views || 0), 0);
    views = sec('個人檔案瀏覽', `近 30 天合計 ${fmtN(total)}`,
      barChart(fill30(pv.map((p) => ({ date: p.date, value: p.views }))), {
        label: `近 30 天個人檔案瀏覽，合計 ${fmtN(total)}`,
        readout: (p) => [el('b', { text: fmtDay(p.date) }), p.value == null ? '　沒有資料' : `　${fmtN(p.value)} 次瀏覽`],
      }));
  }

  // 右欄
  const w = d.week;
  const week = sec('近 7 天海巡', null,
    facts([
      ['送出的留言', el('span', { class: 'big' }, fmtN(w.comments))],
      ['24 小時觀看合計', el('span', null, el('span', { class: 'big' }, fmtN(w.totalViews24h)), w.comments ? el('span', { class: 'sub muted', style: 'display:block;font-size:12.5px' }, `${fmtN(w.withSnapshot24h)} 則有數據`) : null)],
    ]),
    el('div', { class: 'actions' }, el('a', { href: '#comments' }, '看留言紀錄')));

  const td = d.today;
  const today = sec('今天', null,
    facts([
      ['已開', nw(`${fmtN(td.opened)}／${fmtN(td.cap)} 則`)],
      td.nextAllowedAt ? ['下一則最早', nw(`${fmtHM(td.nextAllowedAt)}（${timeUntil(td.nextAllowedAt)}）`)] : null,
      td.nightStart === td.nightEnd ? ['夜間時段', '沒有設'] : ['夜間不送出', nw(`${td.nightStart}–${td.nightEnd}`)],
    ]));

  // 「開始使用」那張已經有連結按鈕，右欄就只寫狀態，不再放一顆一樣的
  const threads = sec('Threads', null, fresh ? el('p', { class: 'prose' }, '還沒連結。') : threadsBlock(d.threads));

  mount(body,
    start,
    el('div', { class: 'grid grid-2-1' },
      el('div', null, followers, views),
      el('div', null, week, today, threads)));
}

function fill30(points) {
  // 補齊 30 天，沒資料的日子留空
  const map = new Map(points.map((p) => [p.date, p.value]));
  const out = [];
  const end = dayIndex(taipeiDateStr(Date.now()));
  for (let i = 29; i >= 0; i--) {
    const date = new Date((end - i) * DAY).toISOString().slice(0, 10);
    out.push({ date, value: map.has(date) ? map.get(date) : null });
  }
  return out;
}

// ============ 留言紀錄 ============

const commentsState = { rows: [], total: 0, sort: 'recent' };

async function renderComments(body, { append = false } = {}) {
  const offset = append ? commentsState.rows.length : 0;
  const [d, br] = await Promise.all([
    api(`/api/comments?limit=50&offset=${offset}`),
    append ? commentsState.breakdown : api('/api/breakdown'),
  ]);
  commentsState.breakdown = br;
  commentsState.rows = append ? commentsState.rows.concat(d.rows) : d.rows;
  commentsState.total = d.total;
  commentsState.unmatched = d.opened_unmatched || [];
  paintComments(body);
}

function snapCell(s) {
  if (!s) return el('span', { class: 'muted', title: '還沒到時間或還沒抓到' }, '—');
  return el('span', null, fmtN(s.views), s.likes != null ? el('span', { class: 'sub' }, `讚 ${fmtN(s.likes)}`) : null);
}

function paintComments(body) {
  const st = commentsState;
  const rows = [...st.rows];
  if (st.sort === 'views24') {
    rows.sort((a, b) => ((b.snapshots['24h'] && b.snapshots['24h'].views) ?? -1) - ((a.snapshots['24h'] && a.snapshots['24h'].views) ?? -1));
  }

  const sortSel = el('select', {
    'aria-label': '排序',
    style: 'width:auto;min-height:32px;padding-block:4px;font-size:13.5px',
    onchange: (e) => { st.sort = e.target.value; paintComments(body); },
  },
  el('option', { value: 'recent' }, '最新的在前'),
  el('option', { value: 'views24' }, '24 小時觀看多的在前'));
  sortSel.value = st.sort;

  let main;
  if (!rows.length) {
    main = emptyState('還沒有比對到送出的留言。在 LINE 貼網址產留言、按「開 Threads 回覆」送出後，下一個整點過 15 分會出現在這裡。');
  } else {
    main = table([
      { label: '送出', cls: 'lead', cell: (r) => el('span', null, nw(fmtTime(r.postedAt))) },
      {
        label: '回覆的貼文',
        cell: (r) => el('span', null,
          r.target.author ? extLink(r.target.url, `@${r.target.author}`) : r.target.url ? extLink(r.target.url, '貼文') : el('span', { class: 'muted' }, '紀錄已刪除'),
          r.target.keyword ? el('span', { class: 'sub' }, `關鍵字：${r.target.keyword}`) : null),
      },
      {
        label: '人設',
        cell: (r) => el('span', null, r.persona || el('span', { class: 'muted' }, '—'), r.draftIdx ? el('span', { class: 'sub' }, `第 ${r.draftIdx} 則`) : null),
      },
      {
        label: '留言',
        cls: 'txt',
        cell: (r) => el('div', null,
          el('span', { class: 'clip' }, r.text),
          el('span', { class: 'sub' },
            r.similarity == null ? '' : r.similarity >= 0.95 ? '照草稿送出' : `改過（相似 ${Math.round(r.similarity * 100)}%）`,
            r.permalink && threadsHref(r.permalink) ? ['　', extLink(r.permalink, '看留言')] : null)),
      },
      { label: '1h', cls: 'n inline-3', cell: (r) => snapCell(r.snapshots['1h']) },
      { label: '24h', cls: 'n inline-3', cell: (r) => snapCell(r.snapshots['24h']) },
      { label: '72h', cls: 'n inline-3', cell: (r) => snapCell(r.snapshots['72h']) },
      {
        label: '狀態',
        cell: (r) => r.status === 'missing'
          ? el('span', { class: 'tag tag-bad', title: r.missingAt ? `${fmtTime(r.missingAt)} 發現` : null }, '查不到')
          : el('span', { class: 'tag tag-good' }, '存在'),
      },
    ], rows, { rowClass: (r) => (r.status === 'missing' ? 'is-missing' : null) });
  }

  const more = st.rows.length < st.total
    ? el('div', { class: 'actions' }, el('button', {
        class: 'btn btn-quiet', type: 'button',
        onclick: async (e) => {
          try { await busy(e.currentTarget, '讀取中…', () => renderComments(body, { append: true })); } catch (err) { toast(err.message, true); }
        },
      }, `再載入 ${Math.min(50, st.total - st.rows.length)} 則`))
    : null;

  const un = st.unmatched || [];
  const unmatched = sec('開了還沒比對到', '72 小時內',
    un.length
      ? el('ul', { class: 'list' }, un.map((u) => el('li', null,
          el('div', { class: 'row' },
            el('span', null, u.target.author ? extLink(u.target.url, `@${u.target.author}`) : '貼文', u.persona ? el('span', { class: 'muted' }, ` · ${u.persona}`) : null, u.draftIdx ? el('span', { class: 'muted' }, ` · 第 ${u.draftIdx} 則`) : null),
            el('span', { class: 'meta' }, `${fmtTime(u.openedAt)} 開啟`)),
          el('p', { class: 'body' }, u.text))))
      : emptyState('72 小時內沒有開過、還沒比對到的草稿。'),
    el('p', { class: 'hint', style: 'margin-top: 12px' }, '比對方式：拿你的回覆跟草稿比相似度，50% 以上才算同一則。改太多字、或還沒到整點過 15 分，就會留在這裡。'));

  mount(body,
    sec('送出的留言', el('span', null, `共 ${fmtN(st.total)} 則　`, sortSel), main, more),
    unmatched,
    st.breakdown ? breakdownSections(st.breakdown) : null);
}

function breakdownSections(br) {
  const groupTable = (rows, key, label) => rows.length
    ? table([
        { label, cls: 'lead', cell: (r) => r[key] },
        { label: '留言', cls: 'n inline-3', cell: (r) => fmtN(r.comments) },
        { label: '24h 觀看中位數', cls: 'n inline-3', cell: (r) => (r.medianViews24h == null ? '—' : fmtN(r.medianViews24h)) },
        { label: '24h 平均讚', cls: 'n inline-3', cell: (r) => (r.avgLikes24h == null ? '—' : r.avgLikes24h.toLocaleString('zh-TW', { maximumFractionDigits: 1 })) },
      ], rows)
    : emptyState('還沒有資料。');
  // 手機上表頭會拿掉，兩張表各放一個看得到的小標，才分得出哪張是人設、哪張是關鍵字
  const group = (title, rows, key, label) => el('div', null, el('h3', { class: 'sub-head' }, title), groupTable(rows, key, label));
  const noGroups = !br.byPersona.length && !br.byKeyword.length;
  const days = br.daily.slice(-14).reverse();
  const noDaily = days.every((r) => !r.comments && r.followersDelta == null && r.profileViews == null);
  return [
    sec('人設與關鍵字', `近 ${br.rangeDays} 天`,
      noGroups
        ? emptyState('還沒有送出的留言。累積幾則之後，這裡會依人設和關鍵字分組。')
        : el('div', null,
            el('div', { class: 'grid grid-1-1' },
              group('依人設', br.byPersona, 'persona', '人設'),
              group('依關鍵字', br.byKeyword, 'keyword', '關鍵字')),
            el('p', { class: 'hint', style: 'margin-top: 12px' }, '中位數只算已經有 24 小時數據的留言。樣本少的組別先別下結論。'))),
    sec('每天對照', '近 14 天',
      noDaily
        ? emptyState('連結 Threads、送出第一則留言後，這裡每天會多一列。')
        : el('div', null,
            el('p', { class: 'prose', style: 'margin-bottom: 14px' }, el('span', { class: 'mark' }, br.attributionNote), '。這裡只把同一天的數字排在一起。'),
            table([
              { label: '日期', cls: 'lead', cell: (r) => fmtDay(r.date) },
              { label: '留言', cls: 'n inline-3', cell: (r) => fmtN(r.comments) },
              { label: '粉絲淨增', cls: 'n inline-3', cell: (r) => (r.followersDelta == null ? '—' : fmtSigned(r.followersDelta)) },
              { label: '個人檔案瀏覽', cls: 'n inline-3', cell: (r) => fmtN(r.profileViews) },
            ], days))),
  ];
}

// ============ 人設與產品 ============

const personaState = { list: [], activeId: null, selected: null, box: null };

function applyPersonas(p) {
  const st = personaState;
  st.list = p.personas;
  st.activeId = p.activeId;
  if (st.selected !== 'new' && !st.list.some((x) => x.id === st.selected)) {
    st.selected = st.activeId ?? (st.list[0] && st.list[0].id) ?? 'new';
  }
}

async function renderPersonas(body) {
  const [p, prod] = await Promise.all([api('/api/personas'), api('/api/product')]);
  applyPersonas(p);
  personaState.box = el('div');
  mount(body, personaState.box, productSection(prod.product));
  paintPersonas();
}

async function reloadPersonas() {
  applyPersonas(await api('/api/personas'));
  paintPersonas();
}

function paintPersonas({ focusEditor = false } = {}) {
  const st = personaState;
  if (!st.box) return;
  const listBox = el('div');
  const editorBox = el('div');
  paintPersonaList(listBox);
  paintPersonaEditor(editorBox);
  const editorSec = sec(st.selected === 'new' ? '新增人設' : '編輯人設', null, editorBox);
  mount(st.box, el('div', { class: 'grid grid-1-2' }, sec('人設', `${fmtN(st.list.length)} 個`, listBox), editorSec));
  if (focusEditor && window.innerWidth < 960) editorSec.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function selectPersona(id) {
  personaState.selected = id;
  paintPersonas({ focusEditor: true });
}

function paintPersonaList(box) {
  const st = personaState;
  mount(box,
    el('ul', { class: 'plist' }, st.list.map((p) => el('li', null,
      el('button', {
        type: 'button',
        'aria-current': st.selected === p.id ? 'true' : 'false',
        onclick: () => selectPersona(p.id),
      },
      el('span', { class: 'pname' }, p.name),
      p.id === st.activeId ? el('span', { class: 'tag tag-ink' }, '使用中') : null,
      !p.isActive ? el('span', { class: 'tag pinactive' }, '停用') : null)))),
    el('div', { class: 'actions' },
      el('button', { class: 'btn btn-sm btn-quiet', type: 'button', onclick: () => selectPersona('new') }, '新增人設')),
    el('p', { class: 'hint', style: 'margin-top: 12px' }, '在 LINE 打 /人設 也能切換。'));
}

function paintPersonaEditor(box) {
  const st = personaState;
  const isNew = st.selected === 'new';
  const p = isNew
    ? { name: '', tone: '', identityNote: '', bannedWords: [], examples: [], isActive: true, sortOrder: (st.list.length + 1) * 10 }
    : st.list.find((x) => x.id === st.selected);
  if (!p) return mount(box, emptyState('選左邊一個人設來編輯。'));

  const f = {
    name: el('input', { id: 'p-name', type: 'text', maxlength: 20, value: p.name, required: true, autocomplete: 'off' }),
    tone: el('textarea', { id: 'p-tone', maxlength: 500, rows: 3 }),
    identityNote: el('textarea', { id: 'p-id', maxlength: 300, rows: 2 }),
    bannedWords: el('textarea', { id: 'p-ban', rows: 3 }),
    examples: el('textarea', { id: 'p-ex', rows: 4 }),
    sortOrder: el('input', { id: 'p-sort', type: 'number', min: 0, max: 9999, step: 1, value: p.sortOrder, class: 'w-num', inputmode: 'numeric' }),
    isActive: el('input', { id: 'p-act', type: 'checkbox', checked: p.isActive }),
  };
  f.tone.value = p.tone;
  f.identityNote.value = p.identityNote || '';
  f.bannedWords.value = p.bannedWords.join('\n');
  f.examples.value = p.examples.join('\n');
  const msg = formMsg();

  const save = el('button', { class: 'btn', type: 'submit' }, isNew ? '新增' : '儲存');
  const setActive = !isNew && p.isActive && p.id !== st.activeId
    ? el('button', {
        class: 'btn btn-quiet', type: 'button',
        onclick: async (e) => {
          try {
            await busy(e.currentTarget, '切換中…', () => api('/api/settings', { method: 'PUT', body: { active_persona_id: p.id } }));
            toast(`已切換成「${p.name}」`);
            await reloadPersonas();
          } catch (err) { msg.set(err.message, 'bad'); }
        },
      }, '設為使用中')
    : null;
  const del = !isNew
    ? armButton(el('button', { class: 'btn btn-danger', type: 'button' }, '刪除'), '再按一次刪除', async () => {
        try {
          await api(`/api/personas/${p.id}`, { method: 'DELETE' });
          toast(`已刪除「${p.name}」`);
          st.selected = null;
          await reloadPersonas();
        } catch (err) { msg.set(err.message, 'bad'); }
      })
    : null;

  const form = el('form', {
    class: 'form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const payload = {
        name: f.name.value.trim(),
        tone: f.tone.value.trim(),
        identityNote: f.identityNote.value.trim() || null,
        bannedWords: splitList(f.bannedWords.value),
        examples: splitLines(f.examples.value),
        sortOrder: Number(f.sortOrder.value) || 0,
        isActive: f.isActive.checked,
      };
      if (!payload.name) { msg.set('人設要有名稱', 'bad'); f.name.focus(); return; }
      if (!payload.tone) { msg.set('要寫語氣說明', 'bad'); f.tone.focus(); return; }
      try {
        const res = await busy(save, '儲存中…', () => isNew
          ? api('/api/personas', { method: 'POST', body: payload })
          : api(`/api/personas/${p.id}`, { method: 'PUT', body: payload }));
        st.selected = res.persona.id;
        toast(isNew ? `已新增「${res.persona.name}」` : '已儲存');
        await reloadPersonas();
      } catch (err) { msg.set(err.message, 'bad'); }
    },
  },
  el('div', { class: 'form-grid' },
    field({ id: 'p-name', label: '名稱', hint: '最多 20 個字，LINE 裡切換時看得到。', input: f.name }),
    el('div', { class: 'field' },
      el('span', { class: 'label' }, '狀態'),
      el('label', { class: 'check', for: 'p-act' }, f.isActive, el('span', null, '啟用', el('span', { class: 'hint' }, '停用的人設不會出現在 /人設 清單。'))),
      el('label', { for: 'p-sort', class: 'hint', style: 'margin-top: 8px' }, '排序（小的在前）'),
      f.sortOrder),
    el('div', { class: 'span-all' }, field({ id: 'p-tone', label: '語氣', hint: '怎麼說話。例：講具體做法，不吹噓、不說教。', input: f.tone })),
    el('div', { class: 'span-all' }, field({ id: 'p-id', label: '真實身分', hint: '每個人設各自填，只寫真的。留空的人設不會提到你的身分，但產品資料卡上的事實還是可能用到。', input: f.identityNote })),
    field({ id: 'p-ban', label: '禁用詞', hint: '一行一個，或用逗號分開。留言裡出現就整則丟掉。', input: f.bannedWords }),
    field({ id: 'p-ex', label: '範例留言', hint: '一行一則，最多 10 則，讓語氣抓得準。', input: f.examples })),
  el('div', { class: 'actions' }, save, setActive, del),
  msg);
  mount(box, form);
}

function productSection(prod) {
  const p = prod || { title: '', facts: [], ctaHint: '', isActive: true };
  const f = {
    title: el('input', { id: 'pr-title', type: 'text', maxlength: 60, value: p.title, autocomplete: 'off' }),
    facts: el('textarea', { id: 'pr-facts', rows: 6 }),
    cta: el('input', { id: 'pr-cta', type: 'text', maxlength: 60, value: p.ctaHint || '', autocomplete: 'off' }),
    active: el('input', { id: 'pr-act', type: 'checkbox', checked: p.isActive }),
  };
  f.facts.value = p.facts.join('\n');
  const msg = formMsg();
  const save = el('button', { class: 'btn', type: 'submit' }, '儲存產品資料卡');
  const form = el('form', {
    class: 'form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const body = { title: f.title.value.trim(), facts: splitLines(f.facts.value), ctaHint: f.cta.value.trim() || null, isActive: f.active.checked };
      if (!body.title) { msg.set('產品要有標題', 'bad'); f.title.focus(); return; }
      try {
        await busy(save, '儲存中…', () => api('/api/product', { method: 'PUT', body }));
        msg.set('');
        toast('產品資料卡已儲存');
      } catch (err) { msg.set(err.message, 'bad'); }
    },
  },
  el('div', { class: 'form-grid' },
    field({ id: 'pr-title', label: '標題', input: f.title }),
    field({ id: 'pr-cta', label: '導流提示', hint: '例：有興趣可以看我主頁。不要放網址。', input: f.cta }),
    el('div', { class: 'span-all' }, field({ id: 'pr-facts', label: '事實', hint: '一行一條。只寫你講得出處的事；卡上沒有的，留言裡不會出現。', input: f.facts })),
    el('label', { class: 'check span-all', for: 'pr-act' }, f.active, el('span', null, '留言可以提到產品', el('span', { class: 'hint' }, '5 則裡最多 2 則輕輕帶到；多久能提一次在「安全設定」調。')))),
  el('div', { class: 'actions' }, save),
  msg);
  return sec('產品資料卡', p.updatedAt ? `${fmtTime(p.updatedAt)} 更新` : null, form);
}

// ============ 我的貼文 ============

const postsState = { sort: 'recent', data: null };

async function renderPosts(body) {
  const [data] = await Promise.all([api('/api/posts'), overviewCache ? null : loadOverview().catch(() => null)]);
  postsState.data = data;
  paintPosts(body);
}

function paintPosts(body) {
  const d = postsState.data;
  const hm = d.heatmap;
  const notConnected = !!(overviewCache && overviewCache.threads && !overviewCache.threads.connected);
  if (notConnected && !d.rows.length) {
    mount(body, sec('貼文', null, emptyState('還沒連結 Threads。連結後，每天 23:50 會把你的貼文存進來。',
      el('a', { class: 'btn btn-sm', href: '/auth/threads/start' }, '連結 Threads'))));
    return;
  }
  let heat;
  if (!hm.sample) {
    heat = emptyState('近 90 天還沒有貼文數據。每天 23:50 的快照會把貼文存進來；想現在就存，到「用量」手動跑每日快照。');
  } else {
    let best = null;
    hm.cells.forEach((row, wd) => row.forEach((c, s) => {
      if (c.avgViews != null && c.withViews >= 2 && (!best || c.avgViews > best.v)) best = { wd, s, v: c.avgViews, n: c.count };
    }));
    heat = el('div', null,
      best
        ? el('p', { style: 'margin-bottom: 14px' }, '目前平均觀看最高：', el('span', { class: 'mark' }, `週${hm.weekdayLabels[best.wd]} ${best.s * 2}–${best.s * 2 + 2} 點`), `（${fmtN(best.n)} 篇，平均 ${fmtN(best.v)}）`)
        : null,
      heatmap(hm),
      hm.sample < 30 ? el('p', { class: 'hint', style: 'margin-top: 8px' }, `樣本只有 ${fmtN(hm.sample)} 篇，僅供參考。`) : null);
  }

  const rows = [...d.rows];
  if (postsState.sort === 'views') rows.sort((a, b) => ((b.snapshot && b.snapshot.views) ?? -1) - ((a.snapshot && a.snapshot.views) ?? -1));
  const sortSel = el('select', {
    'aria-label': '排序',
    style: 'width:auto;min-height:32px;padding-block:4px;font-size:13.5px',
    onchange: (e) => { postsState.sort = e.target.value; paintPosts(body); },
  }, el('option', { value: 'recent' }, '最新的在前'), el('option', { value: 'views' }, '觀看多的在前'));
  sortSel.value = postsState.sort;

  const metric = (k) => (r) => (r.snapshot ? fmtN(r.snapshot[k]) : el('span', { class: 'muted' }, '—'));
  const list = rows.length
    ? table([
        { label: '發文', cls: 'lead', cell: (r) => nw(fmtTime(r.postedAt)) },
        {
          label: '內容',
          cls: 'txt',
          cell: (r) => el('div', null,
            el('span', { class: 'clip' }, r.text || el('span', { class: 'muted' }, r.mediaType ? `（${r.mediaType}）` : '（沒有文字）')),
            el('span', { class: 'sub' }, r.topic ? `主題：${r.topic}　` : '', r.permalink ? extLink(r.permalink, '開貼文') : null)),
        },
        { label: '觀看', cls: 'n inline-3', cell: metric('views') },
        { label: '讚', cls: 'n inline-3', cell: metric('likes') },
        { label: '回覆', cls: 'n inline-3', cell: metric('replies') },
        { label: '轉發', cls: 'n inline-3', cell: metric('reposts') },
        { label: '引用', cls: 'n inline-3', cell: metric('quotes') },
        { label: '分享', cls: 'n inline-3', cell: metric('shares') },
      ], rows)
    : emptyState('近 90 天沒有貼文。');

  mount(body,
    sec('發文時段', '台北時間，星期 × 2 小時', heat),
    sec('貼文', el('span', null, `${fmtN(rows.length)} 篇　`, sortSel), list));
}

// ============ 安全設定 ============

const MODEL_NAMES = { 'claude-opus-5': 'Opus 5', 'claude-sonnet-5': 'Sonnet 5', 'claude-haiku-4-5': 'Haiku 4.5' };

// 每個可改設定的中文名稱與說明；後台多了新 key 也會顯示（用 key 當名稱）
const SETTING_META = {
  llm_effort: { group: 'gen', label: '思考程度', type: 'select', options: [['low', '低：快、便宜'], ['medium', '中'], ['high', '高：慢、比較貴']], hint: 'Haiku 4.5 不吃這個設定。' },
  monthly_budget_usd: { group: 'gen', label: '每月預算（美元）', type: 'num', step: 1, hint: '本月 Claude 花費到這個數字就停止產留言。0＝不限。' },
  daily_cap_first14: { group: 'rate', label: '前 14 天每日上限', type: 'int', unit: '則', hint: '從開始海巡那天算起的頭兩週。' },
  daily_cap: { group: 'rate', label: '之後每日上限', type: 'int', unit: '則', hint: '第 15 天起用這個。' },
  hourly_cap: { group: 'rate', label: '每小時上限', type: 'int', unit: '則' },
  min_interval_min: { group: 'rate', label: '間隔下限', type: 'int', unit: '分鐘', hint: '每則之間在下限到上限之間隨機等。' },
  max_interval_min: { group: 'rate', label: '間隔上限', type: 'int', unit: '分鐘' },
  night_start: { group: 'rate', label: '夜間開始', type: 'time', hint: '台北時間。夜間不開 Threads，草稿照樣能產。開始和結束設成一樣＝不限制。上午 12:00＝半夜 12 點。' },
  night_end: { group: 'rate', label: '夜間結束', type: 'time' },
  started_at: { group: 'rate', label: '開始海巡的日期', type: 'date', hint: '算「前 14 天」用。清空＝還沒開始，第一次開 Threads 時自動記。' },
  same_author_days: { group: 'content', label: '同一作者幾天內只回一次', type: 'int', unit: '天' },
  reopen_grace_min: { group: 'content', label: '換草稿寬限', type: 'int', unit: '分鐘', hint: '同一篇打開後這段時間內換別則再開，不重算次數。' },
  product_every: { group: 'content', label: '每幾則最多一則提產品', type: 'int', unit: '則' },
  similarity_block: { group: 'content', label: '相似度門檻', type: 'num', step: 0.05, max: 1, hint: '跟以前送出的留言相似度到這個值就擋。0 到 1，越小越嚴。' },
  missing_pause_threshold: { group: 'auto', label: '7 天內查不到幾則就暫停', type: 'int', unit: '則', hint: '留言被刪或被隱藏會查不到。' },
  auto_pause_hours: { group: 'auto', label: '自動暫停幾小時', type: 'int', unit: '小時', hint: '限流、查不到太多則時使用。' },
  push_warn_at: { group: 'line', label: 'push 用到幾則提醒', type: 'int', unit: '則', hint: '輕用量方案每月 200 則，用完要等下個月。' },
  morning_report: { group: 'line', label: '每天 08:30 在 LINE 傳早報', type: 'bool' },
  flex_clipboard: { group: 'line', label: '卡片放「複製」按鈕', type: 'bool', hint: '手機 LINE 14.0.0 以上才有。' },
  open_external_browser: { group: 'line', label: '用外部瀏覽器開 Threads', type: 'bool', hint: 'LINE 內建瀏覽器跳不到 Threads app 時再打開。' },
};
const GROUPS = [
  ['rate', '送出頻率'],
  ['content', '對象與內容'],
  ['auto', '自動暫停'],
  ['line', 'LINE'],
  ['other', '其他'],
];
const SKIP_KEYS = new Set(['llm_model', 'active_persona_id']); // 模型另外畫；人設在「人設與產品」切換

function settingInput(key, meta, value) {
  const id = `s-${key}`;
  if (meta.type === 'bool') {
    const cb = el('input', { id, type: 'checkbox', checked: !!value });
    return { node: el('label', { class: 'check', for: id }, cb, el('span', null, meta.label, meta.hint ? el('span', { class: 'hint' }, meta.hint) : null)), read: () => cb.checked };
  }
  let input;
  let read;
  if (meta.type === 'select') {
    input = el('select', { id }, meta.options.map(([v, t]) => el('option', { value: v }, t)));
    input.value = value;
    read = () => input.value;
  } else if (meta.type === 'time') {
    input = el('input', { id, type: 'time', value, step: 60 });
    read = () => input.value;
  } else if (meta.type === 'date') {
    input = el('input', { id, type: 'date', value: value ? taipeiDateStr(value) : '' });
    // 日期沒動就回傳原本的毫秒值，才不會每次儲存都改到
    read = () => {
      if (!input.value) return 0;
      if (value && input.value === taipeiDateStr(value)) return value;
      return Date.parse(`${input.value}T00:00:00+08:00`);
    };
  } else if (meta.type === 'int' || meta.type === 'num') {
    input = el('input', {
      id, type: 'number', min: 0, max: meta.max ?? null, step: meta.type === 'int' ? 1 : meta.step || 'any',
      value, class: 'w-num', inputmode: meta.type === 'int' ? 'numeric' : 'decimal',
    });
    read = () => (input.value === '' ? NaN : Number(input.value));
  } else {
    input = el('input', { id, type: 'text', value: value == null ? '' : String(value) });
    read = () => input.value;
  }
  const row = meta.unit ? el('div', { class: 'inline-fields' }, input, el('span', { class: 'muted' }, meta.unit)) : input;
  return { node: field({ id, label: meta.label, hint: meta.hint, input: row }), read, input };
}

function modelPicker(models, prices, current) {
  const name = 's-llm_model';
  const opts = models.map((m) => {
    const pr = prices[m];
    const usd = pr ? (EST_IN * pr.in + EST_OUT * pr.out) / 1e6 : null;
    const radio = el('input', { type: 'radio', name, value: m, checked: m === current });
    return el('label', { class: 'opt' },
      radio,
      el('span', null, el('span', { class: 'opt-name' }, MODEL_NAMES[m] || m), el('span', { class: 'opt-id' }, m)),
      el('span', { class: 'opt-cost' },
        usd == null ? '—' : [el('span', null, '每次約 ', el('b', null, fmtTwd(usd, 2))), el('small', null, `100 次約 ${fmtTwd(usd * 100)}`)]));
  });
  const wrap = el('div', { class: 'field' },
    el('span', { class: 'label', id: 'm-label' }, '模型'),
    el('div', { class: 'opts', role: 'radiogroup', 'aria-labelledby': 'm-label' }, opts),
    el('p', { class: 'hint' }, `估計值：產一批 5 則約 ${fmtN(EST_IN)} 個輸入、${fmtN(EST_OUT)} 個輸出 token，匯率 ${usdTwd}。實際花費看「用量」。`));
  return { node: wrap, read: () => { const r = wrap.querySelector(`input[name="${name}"]:checked`); return r ? r.value : current; } };
}

// 標出現在用的是哪一個每日上限（驗收時才不會改錯欄）
function dailyCapHints(startedAt) {
  const now = Date.now();
  if (!startedAt) {
    return {
      daily_cap_first14: '還沒開始，第一次開 Threads 之後的頭兩週用這個。',
      daily_cap: '第 15 天起用這個。',
    };
  }
  if (now < startedAt + 14 * DAY) {
    const day = Math.floor((now - startedAt) / DAY) + 1;
    return {
      daily_cap_first14: `現在用這個（第 ${day} 天，共 14 天）。`,
      daily_cap: `第 15 天起用這個，${fmtDate(startedAt + 14 * DAY)} 開始。`,
    };
  }
  return {
    daily_cap_first14: '頭兩週已經過了，現在不用這個。',
    daily_cap: '現在用這個。',
  };
}

async function renderSettings(body) {
  const [s, bl] = await Promise.all([api('/api/settings'), api('/api/blocklist'), overviewCache ? null : loadOverview()]);
  if (s.usdToTwd) usdTwd = s.usdToTwd;
  const ov = overviewCache;
  const settings = s.settings;
  const editable = s.editable.filter((k) => !SKIP_KEYS.has(k));
  const readers = {};

  // 產生留言
  const genNodes = [];
  if (s.editable.includes('llm_model')) {
    const mp = modelPicker(s.models, s.prices, settings.llm_model);
    readers.llm_model = mp.read;
    genNodes.push(el('div', { class: 'span-all' }, mp.node));
  }
  const groups = { gen: [], rate: [], content: [], auto: [], line: [], other: [] };
  const capHints = dailyCapHints(settings.started_at);
  for (const k of editable) {
    const base = SETTING_META[k] || { group: 'other', label: k, type: typeof settings[k] === 'boolean' ? 'bool' : typeof settings[k] === 'number' ? 'num' : 'text' };
    const meta = capHints[k] ? { ...base, hint: capHints[k] } : base;
    const inp = settingInput(k, meta, settings[k]);
    readers[k] = inp.read;
    groups[meta.group].push(inp.node);
  }
  const msg = formMsg();
  const save = el('button', { class: 'btn', type: 'submit' }, '儲存設定');
  const form = el('form', {
    class: 'form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const changed = {};
      for (const [k, read] of Object.entries(readers)) {
        const v = read();
        if (typeof v === 'number' && Number.isNaN(v)) { msg.set(`「${(SETTING_META[k] || { label: k }).label}」要填數字`, 'bad'); return; }
        if (v !== settings[k]) changed[k] = v;
      }
      if (!Object.keys(changed).length) { msg.set('沒有改動'); return; }
      try {
        const res = await busy(save, '儲存中…', () => api('/api/settings', { method: 'PUT', body: changed }));
        Object.assign(settings, res.settings || changed);
        msg.set('');
        toast(`已儲存 ${Object.keys(changed).length} 項設定`);
        loadOverview().catch(() => {});
      } catch (err) {
        // 後端訊息用設定的英文 key，換成畫面上的中文名稱
        const errs = (err.data && err.data.errors) || {};
        const keys = Object.keys(errs);
        const label = (k) => (SETTING_META[k] ? `「${SETTING_META[k].label}」` : k === 'llm_model' ? '「模型」' : k);
        msg.set(keys.length ? keys.map((k) => String(errs[k]).replace(k, label(k))).join('；') : err.message, 'bad');
        for (const k of keys) {
          const input = document.getElementById(`s-${k}`);
          if (input) input.setAttribute('aria-invalid', 'true');
        }
      }
    },
    oninput: (e) => { if (e.target.removeAttribute) e.target.removeAttribute('aria-invalid'); },
  },
  sec('產生留言', null, el('div', { class: 'form-grid' }, genNodes, groups.gen)),
  GROUPS.filter(([g]) => groups[g].length).map(([g, title]) => sec(title, null, el('div', { class: 'form-grid cols-3' }, groups[g]))),
  el('div', { class: 'savebar' }, el('div', { class: 'actions', style: 'margin-top:0' }, save, msg)));

  // Haiku 選了就停用思考程度
  const effort = form.querySelector('#s-llm_effort');
  const syncEffort = () => {
    if (!effort || !readers.llm_model) return;
    effort.disabled = readers.llm_model() === 'claude-haiku-4-5';
  };
  form.addEventListener('change', syncEffort);
  syncEffort();

  mount(body,
    el('div', { class: 'grid grid-1-1' },
      sec('Threads 連結', null, threadsBlock(ov ? ov.threads : null)),
      sec('暫停', null, pauseBox())),
    form,
    blocklistSection(bl.items));
}

let repaintPause = null;

function pauseBox() {
  const box = el('div');
  const paint = () => mount(box, pauseBlock(overviewCache ? overviewCache.pause : null, paint));
  repaintPause = paint;
  paint();
  return box;
}

function pauseBlock(pause, repaint) {
  const msg = formMsg();
  const after = async (text) => {
    toast(text);
    await loadOverview();
    repaint();
    rerenderIfShown(['overview']);
  };
  if (pause) {
    const btn = el('button', {
      class: 'btn btn-danger', type: 'button',
      onclick: async (e) => {
        try {
          await busy(e.currentTarget, '恢復中…', () => api('/api/resume', { method: 'POST' }));
          await after('已恢復');
        } catch (err) { msg.set(err.message, 'bad'); }
      },
    }, '現在恢復');
    return el('div', null,
      facts([['暫停到', nw(fmtTime(pause.untilAt))], ['原因', pause.reason], ['來源', pause.source === 'auto' ? '自動' : '手動']]),
      el('div', { class: 'actions' }, btn), msg);
  }
  const hours = el('input', { id: 'pause-hours', type: 'number', min: 1, max: 720, step: 1, value: 72, class: 'w-num', inputmode: 'numeric' });
  const btn = el('button', {
    class: 'btn btn-quiet', type: 'button',
    onclick: async (e) => {
      const h = Number(hours.value);
      if (!Number.isFinite(h) || h < 1 || h > 720) { msg.set('時數要在 1 到 720 之間', 'bad'); return; }
      try {
        await busy(e.currentTarget, '暫停中…', () => api('/api/pause', { method: 'POST', body: { hours: h } }));
        await after(`已暫停 ${h} 小時`);
      } catch (err) { msg.set(err.message, 'bad'); }
    },
  }, '暫停');
  return el('div', null,
    el('p', { class: 'prose' }, '目前沒有暫停。在 Threads 看到「稍後再試」這類限制，就先暫停 72 小時。'),
    el('div', { class: 'actions' }, el('label', { for: 'pause-hours', class: 'muted' }, '暫停'), hours, el('span', { class: 'muted' }, '小時'), btn),
    msg);
}

function blocklistSection(items) {
  const listBox = el('div');
  const paintList = (arr) => mount(listBox,
    arr.length
      ? el('ul', { class: 'list' }, arr.map((it) => el('li', null,
          el('div', { class: 'row' },
            el('span', null, el('span', { class: 'tag' }, it.kind === 'author' ? '作者' : '貼文'), ' ', it.kind === 'author' ? `@${it.value}` : it.value),
            armButton(el('button', { class: 'btn btn-sm btn-danger', type: 'button' }, '移除'), '再按一次移除', async () => {
              try {
                await api(`/api/blocklist/${it.id}`, { method: 'DELETE' });
                toast('已移除');
                paintList(arr.filter((x) => x.id !== it.id));
              } catch (err) { toast(err.message, true); }
            })),
          el('span', { class: 'meta' }, fmtTime(it.createdAt), it.reason ? `　${it.reason}` : ''))))
      : emptyState('黑名單是空的。'));
  paintList(items);

  const kind = el('select', { id: 'bl-kind' }, el('option', { value: 'author' }, '作者'), el('option', { value: 'shortcode' }, '貼文'));
  const value = el('input', { id: 'bl-value', type: 'text', placeholder: '@帳號或貼文網址', autocomplete: 'off', spellcheck: 'false' });
  const reason = el('input', { id: 'bl-reason', type: 'text', maxlength: 100, placeholder: '選填', autocomplete: 'off' });
  const msg = formMsg();
  const add = el('button', { class: 'btn btn-quiet', type: 'submit' }, '加入黑名單');
  const form = el('form', {
    class: 'form',
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      if (!value.value.trim()) { msg.set('要填作者帳號或貼文網址', 'bad'); value.focus(); return; }
      try {
        const res = await busy(add, '加入中…', () => api('/api/blocklist', { method: 'POST', body: { kind: kind.value, value: value.value, reason: reason.value || null } }));
        items = [res.item, ...items];
        paintList(items);
        value.value = '';
        reason.value = '';
        msg.set('');
        toast('已加入黑名單');
      } catch (err) { msg.set(err.message, 'bad'); }
    },
  },
  el('div', { class: 'form-grid cols-3' },
    field({ id: 'bl-kind', label: '種類', input: kind }),
    field({ id: 'bl-value', label: '帳號或網址', hint: '貼 Threads 網址也可以，會自動抓出作者或貼文代碼。', input: value }),
    field({ id: 'bl-reason', label: '原因', input: reason })),
  el('div', { class: 'actions', style: 'margin-top:0' }, add), msg);

  return sec('黑名單', `${fmtN(items.length)} 筆`, el('p', { class: 'prose', style: 'margin-bottom: 16px' }, '黑名單裡的作者或貼文，按「開 Threads 回覆」會被擋下。'), form, el('div', { style: 'margin-top: 20px' }, listBox));
}

// ============ 用量 ============

const PURPOSE = { comments: '產留言', keywords: '找關鍵字', topics: '主題分析' };
const JOB_NAMES = {
  hourly: '每小時比對', daily: '每日快照', morning: '早報', weekly: '每週續期與清理', cleanup: '每日清理',
  'queue:line_event': 'LINE 訊息處理', 'queue:snapshot_posts': '貼文快照',
  delete_author: '刪除作者資料', meta_deauthorize: 'Meta 解除授權', meta_data_deletion: 'Meta 刪除資料',
  generate: '產留言', 'llm:comments': 'Claude 產留言', 'llm:keywords': 'Claude 找關鍵字', 'llm:topics': 'Claude 分主題',
  line_reply: 'LINE 回覆', line_push: 'LINE 推播', line_content: '下載截圖', line_event: 'LINE 訊息處理',
  threads_oauth: '連結 Threads', 'daily:threads': '每日快照（貼文）', 'daily:user_insights': '每日快照（帳號）',
};
const jobName = (job) => JOB_NAMES[job] || (String(job).startsWith('alert') ? 'LINE 警示' : job);

async function renderUsage(body) {
  const d = await api('/api/usage');
  if (d.usdToTwd) usdTwd = d.usdToTwd;
  const L = d.llm;

  const budget = L.budgetUsd > 0 ? Math.min(1, L.monthCostUsd / L.budgetUsd) : null;
  const claude = sec('Claude', '本月（台北時間）',
    el('p', null, el('span', { class: 'figure' }, fmtUsd(L.monthCostUsd)), el('span', { class: 'figure-unit' }, `≈ ${fmtTwd(L.monthCostUsd)}`)),
    el('p', { class: 'figure-sub' },
      budget == null ? '沒有設每月預算' : `預算 ${fmtUsd(L.budgetUsd)}，用了 ${Math.round(budget * 100)}%`,
      `　現在用 ${MODEL_NAMES[L.model] || L.model}`),
    budget == null ? null : el('div', { class: budget >= 0.8 ? 'meter is-warn' : 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(budget * 100), 'aria-label': '預算用量' },
      el('span', { style: `width: ${(budget * 100).toFixed(1)}%` })),
    el('div', { style: 'margin-top: 24px' },
      L.byDay.some((x) => x.costUsd > 0)
        ? barChart(L.byDay.map((x) => ({ date: x.date, value: x.costUsd || null, calls: x.calls })), {
            label: '近 30 天每日 Claude 花費',
            format: (v) => `$${v < 1 ? v.toFixed(2) : Math.round(v)}`,
            integer: false,
            readout: (p) => [el('b', { text: fmtDay(p.date) }), p.value ? `　${fmtUsd(p.value)}（≈ ${fmtTwd(p.value)}）· ${fmtN(p.calls)} 次` : '　沒有花費'],
          })
        : emptyState('近 30 天還沒有呼叫 Claude。')),
    L.byPurpose.length
      ? el('div', { style: 'margin-top: 20px' }, table([
          { label: '用途', cell: (r) => PURPOSE[r.purpose] || r.purpose },
          { label: '次數', cls: 'n', cell: (r) => fmtN(r.calls) },
          { label: '輸入 token', cls: 'n', cell: (r) => fmtN(r.inputTokens) },
          { label: '輸出 token', cls: 'n', cell: (r) => fmtN(r.outputTokens) },
          { label: '花費', cls: 'n', cell: (r) => el('span', null, fmtUsd(r.costUsd), el('span', { class: 'sub' }, `≈ ${fmtTwd(r.costUsd)}`)) },
        ], L.byPurpose))
      : null);

  const P = d.push;
  const q = P.quota || {};
  const push = sec('LINE push', '本月（日本時間算月份）',
    facts([
      ['系統記到送出', el('span', { style: P.usedThisMonth >= P.warnAt ? 'color: var(--bad)' : null }, el('span', { class: 'big' }, fmtN(P.usedThisMonth)), ' 則')],
      ['LINE 回報用量', q.used == null ? '查不到' : nw(`${fmtN(q.used)}${q.limit != null ? `／${fmtN(q.limit)}` : ''} 則`)],
      ['提醒門檻', nw(`${fmtN(P.warnAt)} 則`)],
    ]),
    el('p', { class: 'hint', style: 'margin-top: 10px' }, '回覆（reply）不算則數，只有 reply 過期改用 push、早報和警示才算。LINE 的數字是約略值。'));

  const threads = sec('Threads 授權', null, threadsBlock(d.threads));

  const runMsg = formMsg();
  const jobBtn = (job, label, desc) => el('li', null,
    el('div', { class: 'row' },
      el('span', null, el('b', null, label), el('span', { class: 'meta' }, `　${desc}`)),
      el('button', {
        class: 'btn btn-sm btn-quiet', type: 'button',
        onclick: async (e) => {
          try {
            const r = await busy(e.currentTarget, '執行中…', () => api('/api/jobs/run', { method: 'POST', body: { job } }));
            runMsg.set(`${r.label}：${r.summary}（${(r.ms / 1000).toFixed(1)} 秒）`, r.ok ? 'good' : 'bad');
            loadOverview().catch(() => {});
          } catch (err) { runMsg.set(err.message, 'bad'); }
        },
      }, '立即執行')));
  const manual = sec('手動執行排程', null,
    el('ul', { class: 'list' },
      jobBtn('hourly', '每小時比對', '比對送出的留言、抓 1/24/72 小時觀看'),
      jobBtn('daily', '每日快照', '存粉絲數、個人檔案瀏覽、貼文成效'),
      jobBtn('morning', '早報', '在 LINE 傳今天的摘要（會用 1 則 push）'),
      jobBtn('weekly', '每週續期與清理', '續期 Threads 授權、清掉過期資料（清理每天 23:50 也會跑）')),
    runMsg);

  const jobs = sec('工作紀錄', '最近 30 筆',
    d.jobs.length
      ? el('ul', { class: 'list' }, d.jobs.map((j) => el('li', null,
          el('div', { class: 'row' },
            el('span', null, el('span', { class: j.ok ? 'tag tag-good' : 'tag tag-bad' }, j.ok ? '成功' : '失敗'), '　', jobName(j.job)),
            el('span', { class: 'meta' }, fmtTime(j.createdAt))),
          j.detail ? el('p', { class: 'meta', style: 'overflow-wrap:anywhere' }, j.detail) : null)))
      : emptyState('還沒有紀錄。'));

  mount(body,
    el('div', { class: 'grid grid-2-1' },
      el('div', null, claude),
      el('div', null, push, threads)),
    el('div', { class: 'grid grid-1-1' }, manual, jobs));
}

// ============ 資料與隱私 ============

async function renderPrivacy(body) {
  const origin = location.origin;
  const username = el('input', { id: 'del-user', type: 'text', placeholder: '@帳號或個人頁網址', autocomplete: 'off', spellcheck: 'false' });
  const msg = formMsg();
  const del = armButton(el('button', { class: 'btn btn-danger', type: 'button' }, '刪除這位作者的紀錄'), '再按一次確定刪除', async () => {
    const u = username.value.trim();
    if (!u) { msg.set('要填 Threads 帳號', 'bad'); username.focus(); return; }
    try {
      const r = await api('/api/data/delete-author', { method: 'POST', body: { username: u } });
      const rows = r.rows || {};
      msg.set(r.deleted
        ? `已刪除 @${r.username}：${fmtN(rows.targets)} 篇貼文紀錄、${fmtN(rows.drafts)} 則草稿、${fmtN(rows.clicks)} 筆點擊。${rows.postedUnlinked ? `${fmtN(rows.postedUnlinked)} 則你送出的留言保留，但不再連到他的貼文。` : ''}`
        : `沒有 @${r.username} 的紀錄。`, 'good');
      username.value = '';
    } catch (err) { msg.set(err.message, 'bad'); }
  });

  const urlRow = (label, path) => [label, el('span', { style: 'overflow-wrap:anywhere;text-align:right' }, `${origin}${path}`)];

  mount(body,
    el('div', { class: 'grid grid-1-1' },
      sec('存多久', null,
        el('div', { class: 'prose' },
          el('ul', null,
            el('li', null, '貼文摘要（100 字內）：最多 30 天，從寫入摘要那天算。別人的貼文原文和截圖不存。'),
            el('li', null, '目標貼文紀錄、留言草稿、點擊紀錄：最多 90 天；你送出的留言對應的貼文紀錄會保留。'),
            el('li', null, '你送出的留言與成效、自己帳號的數據：一直保留，直到你刪除或 Threads 通知刪除。'),
            el('li', null, 'LINE 事件 ID 最多 7 天、登入失敗紀錄最多 2 天、工作紀錄最多 90 天。')),
          el('p', null, '清理每天 23:50 自動跑，上面是最長的保存時間。'))),
      sec('刪除某位作者的資料', null,
        el('p', { class: 'prose', style: 'margin-bottom: 14px' }, '有人要求刪除時用。會刪掉那位作者的貼文網址、摘要、草稿和點擊紀錄；黑名單不會動。'),
        el('div', { class: 'form' },
          field({ id: 'del-user', label: 'Threads 帳號', input: username }),
          el('div', { class: 'actions', style: 'margin-top:0' }, del),
          msg))),
    sec('公開頁面與 Meta 設定', null,
      el('p', { class: 'prose', style: 'margin-bottom: 14px' }, '這兩頁不用登入，Meta 送審時要填。解除授權和刪除資料的 callback 也填在 Meta 的 app 設定裡。'),
      facts([
        urlRow('隱私權政策', '/privacy'),
        urlRow('資料刪除說明', '/data-deletion'),
        urlRow('解除授權 callback', '/meta/deauthorize'),
        urlRow('刪除資料 callback', '/meta/data-deletion'),
      ]),
      el('div', { class: 'actions' },
        el('a', { class: 'btn btn-sm btn-quiet', href: '/privacy', target: '_blank', rel: 'noopener' }, '看隱私權政策'),
        el('a', { class: 'btn btn-sm btn-quiet', href: '/data-deletion', target: '_blank', rel: 'noopener' }, '看資料刪除說明'))));
}

// ============ 分頁切換 ============

const tabsRow = document.getElementById('tabs');

const RENDER = {
  overview: renderOverview,
  comments: renderComments,
  personas: renderPersonas,
  posts: renderPosts,
  settings: renderSettings,
  usage: renderUsage,
  privacy: renderPrivacy,
};
const TAB_IDS = Object.keys(RENDER);

function currentRoute() {
  const h = location.hash.replace(/^#/, '');
  const [id, q] = h.split('?');
  return { id: TAB_IDS.includes(id) ? id : 'overview', params: new URLSearchParams(q || '') };
}

async function renderTab(id) {
  const body = document.querySelector(`#panel-${id} .panel-body`);
  if (!body.firstChild) mount(body, skeleton());
  try {
    await RENDER[id](body);
  } catch (err) {
    if (err && err.status === 401) return;
    mount(body, errorBox(err, () => renderTab(id)));
  }
}

function rerenderIfShown(ids) {
  const { id } = currentRoute();
  if (ids.includes(id)) renderTab(id);
}

function show() {
  const { id, params } = currentRoute();
  for (const a of document.querySelectorAll('.tab')) {
    if (a.dataset.tab === id) {
      a.setAttribute('aria-current', 'page');
      // 只橫向捲分頁列，不動整頁（scrollIntoView 會連帶捲頁面）
      const rr = tabsRow.getBoundingClientRect();
      const ar = a.getBoundingClientRect();
      if (ar.left < rr.left || ar.right > rr.right - 24) tabsRow.scrollLeft += ar.left - rr.left - 16;
    } else {
      a.removeAttribute('aria-current');
    }
  }
  for (const p of document.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== id;
  const tabLabel = document.querySelector(`.tab[data-tab="${id}"]`);
  document.title = `${tabLabel ? tabLabel.textContent : '後台'}｜Threads 海巡`;

  if (params.get('threads') === 'connected') {
    toast('Threads 已連結');
    history.replaceState(null, '', `#${id}`);
    overviewCache = null;
  }
  renderTab(id);
  if (id !== 'overview' && !overviewCache) loadOverview().catch(() => {});
}

// 分頁列在手機上可以橫向滑，滑到底就拿掉淡出
const syncTabsEdge = () => tabsRow.classList.toggle('at-end', tabsRow.scrollLeft + tabsRow.clientWidth >= tabsRow.scrollWidth - 4);
tabsRow.addEventListener('scroll', syncTabsEdge, { passive: true });
window.addEventListener('resize', syncTabsEdge);

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
window.addEventListener('hashchange', () => {
  // 換分頁回到頁首，不然會停在上一頁捲到的位置
  window.scrollTo({ top: 0 });
  show();
});
// 從 LINE 或 Threads 切回後台時，刊頭的「今天 N 則」「下一則幾點後」可能已經過時，超過 1 分鐘就重抓
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - overviewLoadedAt > 60_000) {
    loadOverview().catch(() => {});
  }
});
show();
syncTabsEdge();
