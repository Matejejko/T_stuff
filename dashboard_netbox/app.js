/* NetBox Device Export — Completeness & Analytics Dashboard
 * Entirely client-side: PapaParse for CSV, Chart.js for charts.
 */
(() => {
'use strict';

/* ================= Constants ================= */

const EXPECTED_COLUMNS = [
  'Asset Name','Name','Serial number','Criticality','Status','Tenant','Role','Manufacturer','Type',
  'BMC IP','BMC MAC','BMC Version','BIOS Version','Asset tag','FW Bundle','BIOS Date','ID',
  'Tenant Group','Region','Site Group','Site','Location','Rack','Parent Device','Position (Device Bay)',
  'Position','Rack face','Latitude','Longitude','Airflow','IP Address','IPv4 Address','IPv6 Address',
  'OOB IP','Cluster','Virtual Chassis','VC Position','VC Priority','Description','Config Template',
  'Comments','Contacts','Tags','Created','Last updated','Owner Group','Owner','U Height','Platform',
  'Console ports','Console server ports','Power ports','Power outlets','Interfaces','Front ports',
  'Rear ports','Device bays','Module bays','Inventory items','EOL','Installation Date',
  'Last updated (automatic)','OS Info','Product Name','UUID'
];

const DEFAULT_CRITICAL = [
  'Asset Name','Name','Serial number','Criticality','Status','Role','Manufacturer','Type',
  'Region','Site','BMC IP','BMC MAC','OOB IP','IPv4 Address'
];
const DEFAULT_IMPORTANT = [
  'Tenant','Location','Rack','Position','Platform','Asset tag','Owner',
  'Installation Date','EOL','BIOS Version','FW Bundle'
];
const DEFAULT_EMPTY_MARKERS = ['-','–','N/A','n/a','None','null','NULL'];

const FILTER_DIMS = [
  { key: 'Site',         label: 'Site',         get: r => catVal(r, 'Site') },
  { key: 'Region',       label: 'Region',       get: r => catVal(r, 'Region') },
  { key: 'Criticality',  label: 'Criticality',  get: r => catVal(r, 'Criticality') },
  { key: 'Status',       label: 'Status',       get: r => catVal(r, 'Status') },
  { key: 'Role',         label: 'Role',         get: r => catVal(r, 'Role') },
  { key: 'Manufacturer', label: 'Manufacturer', get: r => catVal(r, 'Manufacturer') },
  { key: 'Generation',   label: 'Generation',   get: r => r._gen, note: 'Parsed from the Type field — inferred, not raw data.' },
  { key: 'Tenant',       label: 'Tenant',       get: r => catVal(r, 'Tenant') },
];

/* Filters that live in the device-table card and narrow the table only
 * (they stack on top of the section filters above, like search does). */
const TABLE_FILTER_DIMS = [
  { key: 'Status', label: 'Status', get: r => catVal(r, 'Status') },
  { key: 'Role',   label: 'Role',   get: r => catVal(r, 'Role') },
  { key: 'Type',   label: 'Type',   get: r => catVal(r, 'Type') },
];

const BREAKDOWN_PANELS = [
  { title: 'Manufacturer', get: r => catVal(r, 'Manufacturer') },
  { title: 'Role',         get: r => catVal(r, 'Role') },
  { title: 'Status',       get: r => catVal(r, 'Status') },
  { title: 'Region',       get: r => catVal(r, 'Region') },
  { title: 'Criticality',  get: r => catVal(r, 'Criticality') },
  { title: 'Tenant',       get: r => catVal(r, 'Tenant') },
  { title: 'Generation (parsed from Type)', get: r => r._gen,
    note: 'Inferred from a trailing G#/Gen&nbsp;# token in Type — spot-check against the real fleet.' },
];

const TABLE_COLS = [
  { key: 'Name',          label: 'Name' },
  { key: 'Serial number', label: 'Serial' },
  { key: 'Site',          label: 'Site' },
  { key: 'Rack',          label: 'Rack' },
  { key: 'Role',          label: 'Role' },
  { key: 'Manufacturer',  label: 'Manufacturer' },
  { key: 'Type',          label: 'Type' },
  { key: 'Status',        label: 'Status' },
  { key: 'Criticality',   label: 'Criticality' },
  { key: '_gen',          label: 'Gen', title: 'Generation (parsed from Type)' },
  { key: '_missing',      label: 'Missing', title: 'Empty critical / important fields (ignored fields are not counted)' },
  { key: '_completeness', label: 'Completeness' },
];
const SEARCH_FIELDS = ['Asset Name','Name','Serial number','Site','Rack','Role','Manufacturer','Type','Status','Asset tag'];

const GEN_RE = /(^|[^a-z0-9])(?:gen|g)[\s\-]?(\d{1,2})$/i;

/* ================= State ================= */

function defaultSettings() {
  const tiers = {};
  for (const c of EXPECTED_COLUMNS) tiers[c] = 'ignored';
  for (const c of DEFAULT_CRITICAL) tiers[c] = 'critical';
  for (const c of DEFAULT_IMPORTANT) tiers[c] = 'important';
  return {
    weights: { critical: 3, important: 1 },
    tiers,
    emptyMarkers: [...DEFAULT_EMPTY_MARKERS],
    excludedStatuses: [],
  };
}

const state = {
  fileName: null,
  rows: [],
  fields: [],
  headerIssues: { missing: [], extra: [] },
  parseErrors: [],
  settings: defaultSettings(),
  scoreDenominator: 0,
  filters: {},           // dim key -> Set of selected values (absent/empty = all)
  tableFilters: {},      // same shape, applied to the device table only
  filtered: [],
  tableRows: [],
  sort: { key: '_completeness', dir: 1 },
  search: '',
  oobOnly: false,
  page: 0,
  pageSize: 50,
  densityMode: 'site',
  selectedIdx: null,     // _idx of the last-opened device row; kept highlighted until another row is clicked
};

let emptySet = new Set(DEFAULT_EMPTY_MARKERS);
const charts = {};

/* ================= Utilities ================= */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
const fmtInt = n => n.toLocaleString('en-US');
function fmtPct(x, dp = 1) {
  if (x == null || Number.isNaN(x)) return '—';
  const s = x.toFixed(dp);
  return (dp > 0 ? s.replace(/\.0+$/, '') : s) + '%';
}
function download(name, text, mime) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime || 'text/plain' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ================= Value semantics ================= */

function isEmptyVal(v) {
  if (v == null) return true;
  const t = String(v).trim();
  return t === '' || emptySet.has(t);
}
function catVal(r, col) {
  return isEmptyVal(r[col]) ? '(empty)' : String(r[col]).trim();
}
function parseGeneration(type) {
  if (isEmptyVal(type)) return 'Unspecified';
  const m = String(type).trim().match(GEN_RE);
  return m ? `Gen ${parseInt(m[2], 10)}` : 'Unspecified';
}

/* Permissive multi-format date parser.
 * Returns {kind:'date',date} | {kind:'empty'} | {kind:'ambiguous'} | {kind:'unparseable'}.
 * DD/MM vs MM/DD is only resolved when one side is >12 (or both sides equal);
 * otherwise the value is flagged ambiguous rather than guessed. */
function parseDateSmart(v) {
  if (isEmptyVal(v)) return { kind: 'empty' };
  const t = String(v).trim();
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})([T ].*)?$/);
  if (m) return checkYMD(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (m) return checkYMD(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/);
  if (m) {
    const a = +m[1], b = +m[2], y = +m[3];
    if (a > 12 && b >= 1 && b <= 12) return checkYMD(y, b, a);   // DD/MM/YYYY
    if (b > 12 && a >= 1 && a <= 12) return checkYMD(y, a, b);   // MM/DD/YYYY
    if (a >= 1 && a <= 12 && b >= 1 && b <= 12) {
      if (a === b) return checkYMD(y, a, b);
      return { kind: 'ambiguous' };
    }
    return { kind: 'unparseable' };
  }
  return { kind: 'unparseable' };
}
function checkYMD(y, mo, d) {
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1 || d > 31) return { kind: 'unparseable' };
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { kind: 'unparseable' };
  return { kind: 'date', date: dt };
}
function todayUTC() {
  const n = new Date();
  return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
}

/* ================= Ingest & derived data ================= */

function handleFile(file) {
  Papa.parse(file, {
    header: true,
    skipEmptyLines: 'greedy',
    complete: res => ingest(res, file.name),
    error: err => toast('Parse failed: ' + err.message),
  });
}
function loadCSVText(text, name) {
  const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' });
  ingest(res, name || 'pasted.csv');
}

function ingest(res, name) {
  state.fileName = name;
  state.fields = (res.meta.fields || []).filter(f => f !== '__parsed_extra');
  state.rows = res.data;
  state.rows.forEach((r, i) => { r._idx = i; });

  const missing = EXPECTED_COLUMNS.filter(c => !state.fields.includes(c));
  const extra = state.fields.filter(c => !EXPECTED_COLUMNS.includes(c));
  state.headerIssues = { missing, extra };

  // extra columns become adjustable tiers too (default: ignored)
  for (const c of extra) if (!(c in state.settings.tiers)) state.settings.tiers[c] = 'ignored';

  state.parseErrors = (res.errors || [])
    .filter(e => e.row != null)
    .map(e => ({
      row: e.row,
      code: e.code,
      message: e.message,
      device: res.data[e.row] ? (catVal(res.data[e.row], 'Name') !== '(empty)'
        ? catVal(res.data[e.row], 'Name') : catVal(res.data[e.row], 'Asset Name')) : '?',
    }));

  Object.assign(state, { filters: {}, tableFilters: {}, search: '', oobOnly: false, page: 0, sort: { key: '_completeness', dir: 1 }, selectedIdx: null });
  $('#tableSearch').value = '';
  $('#btnOobOnly').classList.remove('active');

  $('#emptyState').classList.add('hidden');
  $('#dashboard').classList.remove('hidden');
  const badge = $('#fileBadge');
  badge.textContent = `${name} · ${fmtInt(state.rows.length)} rows`;
  badge.classList.remove('hidden');
  $('#btnLoadCsv').textContent = 'Load another CSV';

  recomputeAll();
  renderSettingsPanel();
  toast(`Loaded ${fmtInt(state.rows.length)} devices from ${name}`);
}

function computeDerived() {
  const { tiers, weights, excludedStatuses } = state.settings;
  emptySet = new Set(state.settings.emptyMarkers);
  const scorable = state.fields.filter(f => tiers[f] === 'critical' || tiers[f] === 'important');
  const wOf = f => (tiers[f] === 'critical' ? weights.critical : weights.important);
  const denom = scorable.reduce((s, f) => s + wOf(f), 0);
  state.scoreDenominator = denom;
  state.scorableFields = scorable;
  const excl = new Set(excludedStatuses);
  const hasBMC = state.fields.includes('BMC IP');
  const hasOOB = state.fields.includes('OOB IP');

  for (const r of state.rows) {
    r._gen = parseGeneration(r['Type']);
    const status = catVal(r, 'Status');
    r._active = /^active$/i.test(status);
    r._excluded = excl.has(status);
    const missC = [], missI = [];
    let got = 0;
    for (const f of scorable) {
      if (isEmptyVal(r[f])) (tiers[f] === 'critical' ? missC : missI).push(f);
      else got += wOf(f);
    }
    r._missingCritical = missC;
    r._missingImportant = missI;
    r._completeness = (r._excluded || denom === 0) ? null : (got / denom) * 100;
    r._oobGap = r._active && ((hasBMC && isEmptyVal(r['BMC IP'])) || (hasOOB && isEmptyVal(r['OOB IP'])));
    r._eol = parseDateSmart(r['EOL']);
    r._fw = !isEmptyVal(r['FW Bundle']);
  }
}

function recomputeAll() {
  computeDerived();
  renderFilterBar();
  applyFilters();
  renderDataHealth();
  renderAll();
}

/* ================= Filtering ================= */

function applyFilters() {
  const active = FILTER_DIMS.filter(d => state.filters[d.key]?.size);
  state.filtered = active.length
    ? state.rows.filter(r => active.every(d => state.filters[d.key].has(d.get(r))))
    : state.rows.slice();
  state.page = 0;
}

const onFilterChange = debounce(() => { applyFilters(); renderAll(); }, 150);

/* Multi-select dropdown pill. `values` is [[value, count], …] in display order;
 * `getSel` reads the live selection, `setSel` replaces it, `onChange` re-renders. */
function buildFilterDropdown({ label, note, values, getSel, setSel, onChange }) {
  const wrap = document.createElement('div');
  wrap.className = 'fdrop';
  const btn = document.createElement('button');
  btn.className = 'fdrop-btn';
  btn.type = 'button';
  if (note) btn.title = note;
  wrap.appendChild(btn);

  const menu = document.createElement('div');
  menu.className = 'fdrop-menu hidden';
  menu.innerHTML = `
    ${note ? `<p class="card-note" style="margin:0 0 6px">${note}</p>` : ''}
    <input type="search" placeholder="Filter values…" aria-label="Filter ${esc(label)} values">
    <div class="fdrop-list"></div>
    <div class="fdrop-foot">
      <button type="button" class="linklike" data-act="all">Select all</button>
      <button type="button" class="linklike" data-act="none">Clear</button>
    </div>`;
  wrap.appendChild(menu);

  const list = menu.querySelector('.fdrop-list');
  const renderList = (q = '') => {
    const sel = getSel();
    list.innerHTML = values
      .filter(([v]) => !q || v.toLowerCase().includes(q))
      .map(([v, n]) => `
        <label><input type="checkbox" value="${esc(v)}" ${sel.has(v) ? 'checked' : ''}>
          <span class="${v === '(empty)' ? 'empty-val muted' : ''}">${esc(v)}</span>
          <span class="vcount">${fmtInt(n)}</span></label>`).join('');
  };
  const refreshBtn = () => {
    const n = getSel().size;
    btn.innerHTML = n
      ? `${esc(label)} <span class="count">· ${n}</span> ▾`
      : `${esc(label)} ▾`;
    btn.classList.toggle('active', n > 0);
  };

  btn.addEventListener('click', e => {
    e.stopPropagation();
    const wasOpen = !menu.classList.contains('hidden');
    closeAllMenus();
    if (!wasOpen) { renderList(); menu.classList.remove('hidden'); menu.querySelector('input').focus(); }
  });
  menu.addEventListener('click', e => e.stopPropagation());
  menu.querySelector('input').addEventListener('input', e => renderList(e.target.value.toLowerCase()));
  list.addEventListener('change', e => {
    const sel = new Set(getSel());
    e.target.checked ? sel.add(e.target.value) : sel.delete(e.target.value);
    setSel(sel);
    refreshBtn();
    onChange();
  });
  menu.querySelector('.fdrop-foot').addEventListener('click', e => {
    const act = e.target.dataset.act;
    if (!act) return;
    setSel(act === 'all' ? new Set(values.map(([v]) => v)) : new Set());
    renderList(menu.querySelector('input').value.toLowerCase());
    refreshBtn();
    onChange();
  });

  refreshBtn();
  return wrap;
}

function countValues(rows, get) {
  const counts = new Map();
  for (const r of rows) {
    const v = get(r);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  return counts;
}
const byCountThenName = (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]);

function renderFilterBar() {
  const bar = $('#filterBar');
  bar.innerHTML = '';
  for (const dim of FILTER_DIMS) {
    const counts = countValues(state.rows, dim.get);
    // prune selections whose value no longer exists
    if (state.filters[dim.key]) {
      for (const v of [...state.filters[dim.key]]) if (!counts.has(v)) state.filters[dim.key].delete(v);
    }
    bar.appendChild(buildFilterDropdown({
      label: dim.label,
      note: dim.note,
      values: [...counts.entries()].sort(byCountThenName),
      getSel: () => state.filters[dim.key] || new Set(),
      setSel: s => { state.filters[dim.key] = s; },
      onChange: () => { updateFilterMeta(); onFilterChange(); },
    }));
  }
  updateFilterMeta();
}

function closeAllMenus() { $$('.fdrop-menu').forEach(m => m.classList.add('hidden')); }
document.addEventListener('click', closeAllMenus);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeAllMenus();
    $$('.modal-backdrop').forEach(m => m.classList.add('hidden'));
  }
});

function anyFilterActive() { return FILTER_DIMS.some(d => state.filters[d.key]?.size); }
function updateFilterMeta() {
  const el = $('#filterCount');
  if (!state.rows.length) { el.textContent = ''; return; }
  el.textContent = anyFilterActive()
    ? `Showing ${fmtInt(state.filtered.length)} of ${fmtInt(state.rows.length)} devices`
    : `${fmtInt(state.rows.length)} devices · no filters active`;
  $('#btnClearFilters').classList.toggle('hidden', !anyFilterActive());
}

/* ================= Rendering ================= */

function renderAll() {
  updateFilterMeta();
  renderKPIs();
  renderComposition();
  renderDensity();
  renderCompletenessBadges();
  renderCompletenessCharts();
  renderLifecycle();
  renderTableFull();
}

function completenessTone(p) {
  if (p == null) return 'none';
  return p < 50 ? 'crit' : p < 80 ? 'warn' : 'good';
}
function statusColorFor(p) {
  return p < 50 ? cssVar('--status-crit') : p < 80 ? cssVar('--status-warn') : cssVar('--status-good');
}

/* ---------- KPIs ---------- */
function renderKPIs() {
  const rows = state.filtered;
  const scored = rows.filter(r => r._completeness != null);
  const excluded = rows.length - scored.length;
  const avg = scored.length ? scored.reduce((s, r) => s + r._completeness, 0) / scored.length : null;
  const active = rows.filter(r => r._active);
  const t = todayUTC();
  const eolDated = rows.filter(r => r._eol.kind === 'date');
  const pastEol = eolDated.filter(r => r._eol.date.getTime() < t);
  const eolPop = rows.length ? eolDated.length / rows.length * 100 : 0;
  const fwGap = active.filter(r => !r._fw);
  const critMiss = scored.filter(r => r._missingCritical.length);

  const kpi = (label, value, sub, cls = '', vcls = '') => `
    <div class="kpi ${cls}">
      <div class="kpi-label">${label}</div>
      <div class="kpi-value ${vcls}">${value}</div>
      <div class="kpi-sub">${sub}</div>
    </div>`;

  $('#kpiGrid').innerHTML =
    kpi('Devices', fmtInt(rows.length),
      anyFilterActive() ? `of ${fmtInt(state.rows.length)} in file` : 'in file', 'kpi-accent') +
    kpi('Avg completeness', fmtPct(avg),
      scored.length ? `weighted · ${fmtInt(scored.length)} scored${excluded ? ` · ${fmtInt(excluded)} excluded by status` : ''}` : 'no scored devices',
      '', avg != null ? 'tone-' + completenessTone(avg) : '') +
    kpi('Empty critical fields', fmtInt(critMiss.length),
      scored.length ? `${fmtPct(critMiss.length / scored.length * 100)} of ${fmtInt(scored.length)} scored devices flagged` : 'no scored devices',
      critMiss.length ? 'kpi-danger' : '') +
    kpi('Past EOL', fmtInt(pastEol.length),
      `EOL populated on ${fmtPct(eolPop)} of devices`, '', pastEol.length ? 'tone-crit' : '') +
    kpi('Active w/o FW bundle', fmtInt(fwGap.length),
      active.length ? `${fmtPct(fwGap.length / active.length * 100)} of ${fmtInt(active.length)} active` : 'no active devices',
      '', fwGap.length ? 'tone-warn' : '');
}

/* ---------- Composition panels ---------- */
function tally(rows, get) {
  const m = new Map();
  for (const r of rows) {
    const v = get(r);
    m.set(v, (m.get(v) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderComposition() {
  const rows = state.filtered;
  const total = rows.length || 1;
  $('#compositionGrid').innerHTML = BREAKDOWN_PANELS.map(p => {
    const entries = tally(rows, p.get);
    const max = entries.length ? entries[0][1] : 1;
    return `
      <div class="card bpanel">
        <div class="card-head">
          <h3>${p.title}</h3>
          <span class="muted">${entries.length} value${entries.length === 1 ? '' : 's'}</span>
        </div>
        ${p.note ? `<p class="card-note" style="margin:0 0 8px">${p.note}</p>` : ''}
        <div class="blist">
          ${entries.map(([v, n]) => `
            <div class="brow">
              <span class="blabel ${v === '(empty)' ? 'empty-val' : ''}" title="${esc(v)}">${esc(v)}</span>
              <span class="bbar-track"><span class="bbar" style="width:${(n / max * 100).toFixed(1)}%"></span></span>
              <span class="bnum">${fmtInt(n)}<span class="pct">${fmtPct(n / total * 100)}</span></span>
            </div>`).join('')}
        </div>
      </div>`;
  }).join('');
}

/* ---------- Density ---------- */
function renderDensity() {
  const rows = state.filtered;
  const mode = state.densityMode;
  let entries, skipped;
  if (mode === 'site') {
    entries = tally(rows.filter(r => catVal(r, 'Site') !== '(empty)'), r => catVal(r, 'Site'));
    skipped = rows.length - rows.filter(r => catVal(r, 'Site') !== '(empty)').length;
  } else {
    const withRack = rows.filter(r => catVal(r, 'Rack') !== '(empty)');
    entries = tally(withRack, r => `${catVal(r, 'Site')} › ${catVal(r, 'Rack')}`);
    skipped = rows.length - withRack.length;
  }
  const top = entries.slice(0, 10);
  $('#densityNote').textContent =
    (entries.length > 10 ? `Top 10 of ${entries.length} ${mode === 'site' ? 'sites' : 'racks'}. ` : '') +
    (skipped ? `${fmtInt(skipped)} device${skipped === 1 ? ' has' : 's have'} no ${mode} value.` : '');
  $('#densityBox').style.height = Math.max(120, top.length * 26 + 50) + 'px';
  upsertBar('chDensity', {
    horizontal: true,
    labels: top.map(e => e[0]),
    values: top.map(e => e[1]),
    colors: cssVar('--slot-1'),
    valueMax: undefined,
    tooltip: ctx => ` ${fmtInt(ctx.parsed.x)} devices`,
  });
}

/* ---------- Out-of-band badges (small fill-rate indicators) ---------- */
function renderCompletenessBadges() {
  const rows = state.filtered;
  const n = rows.length || 1;
  $('#completenessBadges').innerHTML = ['BMC IP', 'OOB IP'].map(col => {
    let filled = 0;
    for (const r of rows) if (!isEmptyVal(r[col])) filled++;
    const p = filled / n * 100;
    const cls = p < 5 ? 'b-crit' : p < 50 ? 'b-warn' : '';
    return `<span class="badge ${cls}" title="Use the &ldquo;Missing OOB only&rdquo; toggle in the device table to list active devices without BMC/OOB IP">${col}: ${fmtPct(p)} populated</span>`;
  }).join('');
}

/* ---------- Completeness charts ---------- */
function renderCompletenessCharts() {
  const rows = state.filtered;
  const n = rows.length || 1;

  // Fill rate by field (non-ignored), worst first
  const fields = state.scorableFields || [];
  const stats = fields.map(f => {
    let filled = 0;
    for (const r of rows) if (!isEmptyVal(r[f])) filled++;
    return { f, pct: filled / n * 100, tier: state.settings.tiers[f] };
  }).sort((a, b) => a.pct - b.pct);
  $('#fieldFillBox').style.height = Math.max(140, stats.length * 22 + 55) + 'px';
  upsertBar('chFieldFill', {
    horizontal: true,
    labels: stats.map(s => s.f),
    values: stats.map(s => s.pct),
    colors: stats.map(s => statusColorFor(s.pct)),
    valueMax: 100,
    tooltip: ctx => ` ${fmtPct(ctx.parsed.x)} filled · ${stats[ctx.dataIndex].tier} field`,
  });

  // Histogram of device completeness
  const scored = rows.filter(r => r._completeness != null);
  const buckets = [0, 0, 0, 0];
  for (const r of scored) buckets[Math.min(3, Math.floor(r._completeness / 25))]++;
  upsertBar('chHistogram', {
    horizontal: false,
    labels: ['0–25%', '25–50%', '50–75%', '75–100%'],
    values: buckets,
    colors: [cssVar('--status-crit'), cssVar('--status-serious'), cssVar('--status-warn'), cssVar('--status-good')],
    tooltip: ctx => ` ${fmtInt(ctx.parsed.y)} devices (${fmtPct(ctx.parsed.y / (scored.length || 1) * 100)})`,
  });

  // Avg completeness by role / by site
  renderAvgChart('chByRole', 'byRoleBox', r => catVal(r, 'Role'), null);
  renderAvgChart('chBySite', 'bySiteBox', r => catVal(r, 'Site'), 'bySiteSub');
}

function renderAvgChart(chartId, boxId, get, subId) {
  const groups = new Map();
  for (const r of state.filtered) {
    if (r._completeness == null) continue;
    const v = get(r);
    const g = groups.get(v) || { sum: 0, n: 0 };
    g.sum += r._completeness; g.n++;
    groups.set(v, g);
  }
  let entries = [...groups.entries()]
    .map(([v, g]) => ({ v, avg: g.sum / g.n, n: g.n }))
    .sort((a, b) => a.avg - b.avg);
  const totalGroups = entries.length;
  if (entries.length > 20) entries = entries.slice(0, 20);
  if (subId) $('#' + subId).textContent =
    totalGroups > 20 ? `— 20 worst of ${totalGroups} sites` : '';
  $('#' + boxId).style.height = Math.max(120, entries.length * 24 + 55) + 'px';
  upsertBar(chartId, {
    horizontal: true,
    labels: entries.map(e => e.v),
    values: entries.map(e => e.avg),
    colors: entries.map(e => statusColorFor(e.avg)),
    valueMax: 100,
    tooltip: ctx => ` avg ${fmtPct(ctx.parsed.x)} · ${fmtInt(entries[ctx.dataIndex].n)} devices`,
  });
}

/* ---------- Lifecycle ---------- */
function renderLifecycle() {
  const rows = state.filtered;
  const n = rows.length || 1;
  const t = todayUTC();
  const DAY = 86400000;

  // populated badges
  const popPct = col => {
    let f = 0;
    for (const r of rows) if (!isEmptyVal(r[col])) f++;
    return f / n * 100;
  };
  $('#lifecycleBadges').innerHTML = ['EOL', 'Installation Date', 'BIOS Date'].map(col => {
    const p = popPct(col);
    const cls = p < 5 ? 'b-crit' : p < 50 ? 'b-warn' : '';
    return `<span class="badge ${cls}">${col}: ${fmtPct(p)} populated</span>`;
  }).join('');

  // EOL chart
  const eol = { past: 0, d90: 0, d180: 0, later: 0, unparseable: 0, empty: 0 };
  for (const r of rows) {
    const e = r._eol;
    if (e.kind === 'empty') eol.empty++;
    else if (e.kind !== 'date') eol.unparseable++;
    else {
      const dd = (e.date.getTime() - t) / DAY;
      if (dd < 0) eol.past++;
      else if (dd <= 90) eol.d90++;
      else if (dd <= 180) eol.d180++;
      else eol.later++;
    }
  }
  const eolHasDates = (eol.past + eol.d90 + eol.d180 + eol.later + eol.unparseable) > 0;
  $('#eolEmpty').classList.toggle('hidden', eolHasDates);
  $('#eolBox').classList.toggle('hidden', !eolHasDates);
  if (!eolHasDates) {
    $('#eolEmpty').textContent =
      `EOL is empty on all ${fmtInt(rows.length)} devices in the current filter. This says nothing about actual EOL risk — the field simply isn't populated.`;
  } else {
    $('#eolBox').style.height = '220px';
    upsertBar('chEol', {
      horizontal: true,
      labels: ['Past EOL', '≤90 days', '91–180 days', '>180 days', 'Unparseable / ambiguous', 'No EOL date'],
      values: [eol.past, eol.d90, eol.d180, eol.later, eol.unparseable, eol.empty],
      colors: [cssVar('--status-crit'), cssVar('--status-serious'), cssVar('--status-warn'),
               cssVar('--status-good'), cssVar('--muted'), cssVar('--surface-3')],
      tooltip: ctx => ` ${fmtInt(ctx.parsed.x)} devices (${fmtPct(ctx.parsed.x / n * 100)})`,
    });
  }

  // FW bundle
  const active = rows.filter(r => r._active);
  const activeNoFw = active.filter(r => !r._fw).length;
  const allNoFw = rows.filter(r => !r._fw).length;
  $('#fwStats').innerHTML = `
    <div class="fw-stat">
      <span class="num ${activeNoFw ? 'bad' : ''}">${fmtInt(activeNoFw)}</span>
      <span class="lbl">active devices with no FW Bundle${active.length ? ` (${fmtPct(activeNoFw / active.length * 100)} of ${fmtInt(active.length)} active)` : ''}</span>
    </div>
    <p class="fw-sub">Stale or unknown firmware on live gear.</p>
    <div class="fw-stat">
      <span class="num">${fmtInt(allNoFw)}</span>
      <span class="lbl">devices with no FW Bundle overall (${fmtPct(allNoFw / n * 100)})</span>
    </div>`;
}

/* ---------- Data health (schema + parse errors) ---------- */
function renderDataHealth() {
  const { missing, extra } = state.headerIssues;
  const tieredMissing = missing.filter(c => state.settings.tiers[c] !== 'ignored');
  const issues = (missing.length ? 1 : 0) + (extra.length ? 1 : 0);
  const errs = state.parseErrors.length;
  const el = $('#dataHealth');
  if (!issues && !errs) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  $('#healthSummary').textContent =
    `⚠ ${issues ? `${issues} schema warning${issues > 1 ? 's' : ''}` : ''}${issues && errs ? ' · ' : ''}${errs ? `${errs} malformed row${errs > 1 ? 's' : ''}` : ''} — click to inspect`;

  let hw = '';
  if (missing.length) hw += `<div class="issue-block"><h4>Missing columns (${missing.length})</h4>
    <p>${missing.map(c => `<code>${esc(c)}</code>`).join(' ')}</p>
    ${tieredMissing.length ? `<p>These are tiered fields — they are excluded from the completeness score while absent: ${tieredMissing.map(c => `<code>${esc(c)}</code>`).join(' ')}</p>` : ''}</div>`;
  if (extra.length) hw += `<div class="issue-block"><h4>Unexpected extra columns (${extra.length})</h4>
    <p>${extra.map(c => `<code>${esc(c)}</code>`).join(' ')} — defaulted to the <em>ignored</em> tier; reclassify in Settings if they should count.</p></div>`;
  $('#headerWarnings').innerHTML = hw;

  $('#parseErrors').innerHTML = errs ? `<div class="issue-block">
    <h4>Malformed rows (${errs})</h4>
    <p>These rows had a field count that doesn't match the header. They are kept in the dataset (missing cells count as empty) but should be checked at the source.</p>
    <ul>${state.parseErrors.slice(0, 50).map(e =>
      `<li>Data row ${e.row + 1} (device: ${esc(e.device)}) — ${esc(e.message)}</li>`).join('')}
    ${errs > 50 ? `<li>…and ${errs - 50} more</li>` : ''}</ul></div>` : '';
}

/* ---------- Device table ---------- */
function anyTableFilterActive() { return TABLE_FILTER_DIMS.some(d => state.tableFilters[d.key]?.size); }

function renderTableFilterBar() {
  const bar = $('#tableFilterBar');
  bar.innerHTML = '';
  for (const dim of TABLE_FILTER_DIMS) {
    // counts reflect the rows reaching the table, i.e. after the section filters above
    const counts = countValues(state.filtered, dim.get);
    // keep a selected value visible (as 0) if the filters above have excluded it,
    // so an empty table is never caused by a checkbox the user can't see
    for (const v of state.tableFilters[dim.key] || []) if (!counts.has(v)) counts.set(v, 0);
    bar.appendChild(buildFilterDropdown({
      label: dim.label,
      values: [...counts.entries()].sort(byCountThenName),
      getSel: () => state.tableFilters[dim.key] || new Set(),
      setSel: s => { state.tableFilters[dim.key] = s; },
      onChange: () => {
        state.page = 0;
        computeTableRows();
        renderTableBody();
        updateTableFilterMeta();
      },
    }));
  }
  updateTableFilterMeta();
}

function updateTableFilterMeta() {
  $('#btnClearTableFilters').classList.toggle('hidden', !anyTableFilterActive());
}

function computeTableRows() {
  let rows = state.filtered;
  const tf = TABLE_FILTER_DIMS.filter(d => state.tableFilters[d.key]?.size);
  if (tf.length) rows = rows.filter(r => tf.every(d => state.tableFilters[d.key].has(d.get(r))));
  if (state.oobOnly) rows = rows.filter(r => r._oobGap);
  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter(r => SEARCH_FIELDS.some(f => String(r[f] ?? '').toLowerCase().includes(q)));
  }
  const { key, dir } = state.sort;
  rows = rows.slice().sort((a, b) => {
    if (key === '_completeness') {
      const av = a._completeness, bv = b._completeness;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av - bv) * dir;
    }
    if (key === '_missing') {
      // worst first on the initial click; excluded (unscored) devices always sort last
      const rank = r => r._completeness == null ? -1
        : r._missingCritical.length * 1000 + r._missingImportant.length;
      return (rank(b) - rank(a)) * dir;
    }
    const av = key.startsWith('_') ? String(a[key] ?? '') : catVal(a, key);
    const bv = key.startsWith('_') ? String(b[key] ?? '') : catVal(b, key);
    return av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' }) * dir;
  });
  state.tableRows = rows;
}

function renderTableFull() {
  renderTableFilterBar();
  computeTableRows();
  renderTableHead();
  renderTableBody();
}

function renderTableHead() {
  $('#tableHead').innerHTML = TABLE_COLS.map(c => {
    const arrow = state.sort.key === c.key ? `<span class="arrow">${state.sort.dir > 0 ? '▲' : '▼'}</span>` : '';
    return `<th data-key="${esc(c.key)}" ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}${arrow}</th>`;
  }).join('');
}

function missingCellHTML(r) {
  if (r._completeness == null)
    return '<td><span class="empty-val" title="Excluded from scoring by status">—</span></td>';
  const crit = r._missingCritical, imp = r._missingImportant;
  if (!crit.length && !imp.length)
    return '<td><span class="ok-val" title="All tiered fields populated">✓ complete</span></td>';
  const parts = [];
  const shown = crit.slice(0, 2);
  for (const f of shown) parts.push(`<span class="mchip m-crit">${esc(f)}</span>`);
  if (crit.length > shown.length) parts.push(`<span class="mchip m-crit">+${crit.length - shown.length}</span>`);
  if (imp.length) parts.push(`<span class="mchip m-warn">${imp.length} important</span>`);
  const title =
    (crit.length ? `Critical empty: ${crit.join(', ')}` : '') +
    (crit.length && imp.length ? '\n' : '') +
    (imp.length ? `Important empty: ${imp.join(', ')}` : '');
  return `<td class="miss-cell" title="${esc(title)}">${parts.join('')}</td>`;
}

function renderTableBody() {
  const total = state.tableRows.length;
  const pages = Math.max(1, Math.ceil(total / state.pageSize));
  state.page = Math.min(state.page, pages - 1);
  const start = state.page * state.pageSize;
  const slice = state.tableRows.slice(start, start + state.pageSize);

  $('#tableBody').innerHTML = slice.map(r => {
    const cells = TABLE_COLS.map(c => {
      if (c.key === '_completeness') {
        if (r._completeness == null)
          return `<td><span class="pill p-none" title="Excluded from scoring by status">— excluded</span></td>`;
        const tone = completenessTone(r._completeness);
        return `<td><span class="pill p-${tone}"><span class="dot"></span>${fmtPct(r._completeness)}</span></td>`;
      }
      if (c.key === '_missing') return missingCellHTML(r);
      if (c.key === '_gen') return `<td>${r._gen === 'Unspecified' ? '<span class="empty-val">—</span>' : esc(r._gen)}</td>`;
      const v = catVal(r, c.key);
      if (v === '(empty)') {
        const tier = state.settings.tiers[c.key];
        if (r._completeness != null && tier === 'critical')
          return `<td class="cell-empty-crit" title="${esc(c.label)} — critical field is empty"><span class="empty-val ev-crit">⚠ empty</span></td>`;
        if (r._completeness != null && tier === 'important')
          return `<td title="${esc(c.label)} — important field is empty"><span class="empty-val ev-warn">empty</span></td>`;
        return `<td><span class="empty-val">—</span></td>`;
      }
      return `<td title="${esc(String(r[c.key] ?? ''))}">${esc(v)}</td>`;
    }).join('');
    return `<tr data-idx="${r._idx}"${r._idx === state.selectedIdx ? ' class="row-selected"' : ''}>${cells}</tr>`;
  }).join('');

  $('#pgInfo').textContent = total
    ? `${fmtInt(start + 1)}–${fmtInt(Math.min(start + state.pageSize, total))} of ${fmtInt(total)} · page ${state.page + 1}/${pages}`
    : 'No devices match';
  $('#pgPrev').disabled = state.page === 0;
  $('#pgNext').disabled = state.page >= pages - 1;

  const extras = [];
  if (anyTableFilterActive()) extras.push('table filters');
  if (state.search) extras.push('search');
  if (state.oobOnly) extras.push('missing-OOB toggle');
  $('#tableCount').textContent = extras.length ? `${fmtInt(total)} rows after ${extras.join(' + ')}` : '';
}

/* ---------- Device detail modal ---------- */
function markSelectedRow() {
  $$('#tableBody tr.row-selected').forEach(tr => tr.classList.remove('row-selected'));
  if (state.selectedIdx == null) return;
  const tr = $(`#tableBody tr[data-idx="${state.selectedIdx}"]`);
  if (tr) tr.classList.add('row-selected');
}

function openDeviceModal(idx) {
  const r = state.rows[idx];
  if (!r) return;
  state.selectedIdx = idx;
  markSelectedRow();
  const name = catVal(r, 'Name') !== '(empty)' ? catVal(r, 'Name')
    : (catVal(r, 'Asset Name') !== '(empty)' ? catVal(r, 'Asset Name') : `Row ${idx + 1}`);
  $('#dmTitle').textContent = name;

  const tone = completenessTone(r._completeness);
  const pill = r._completeness == null
    ? `<span class="pill p-none">not scored — status &ldquo;${esc(catVal(r, 'Status'))}&rdquo; excluded</span>`
    : `<span class="pill p-${tone}"><span class="dot"></span>${fmtPct(r._completeness)} complete</span>`;

  const chips = (list, cls) => list.length
    ? list.map(f => `<span class="chip ${cls}">${esc(f)}</span>`).join('')
    : '<span class="muted">none — all populated ✓</span>';

  const tiers = state.settings.tiers;
  const group = (title, tier, open) => {
    const cols = state.fields.filter(f => tiers[f] === tier);
    if (!cols.length) return '';
    return `<details class="dm-group" ${open ? 'open' : ''}>
      <summary>${title} <span class="muted">(${cols.length})</span></summary>
      <div class="dm-fields">${cols.map(f => {
        const empty = isEmptyVal(r[f]);
        const cls = empty ? (tier === 'critical' ? 'is-empty' : tier === 'important' ? 'is-empty-warn' : '') : '';
        const val = empty ? '(empty)' : String(r[f]).trim();
        return `<div class="dm-field ${cls}"><span class="fname">${esc(f)}</span><span class="fval" title="${esc(val)}">${esc(val)}</span></div>`;
      }).join('')}</div>
    </details>`;
  };

  $('#dmBody').innerHTML = `
    <div class="dm-summary">${pill}
      <span class="chip">${esc(catVal(r, 'Status'))}</span>
      <span class="chip">${esc(catVal(r, 'Site'))}${catVal(r, 'Rack') !== '(empty)' ? ' › ' + esc(catVal(r, 'Rack')) : ''}</span>
      ${r._gen !== 'Unspecified' ? `<span class="chip" title="Generation (parsed from Type)">${esc(r._gen)}</span>` : ''}
      ${r._oobGap ? '<span class="chip c-crit">⚠ active without BMC/OOB IP</span>' : ''}
    </div>
    <h4>Empty critical fields <span class="muted">(weight ${state.settings.weights.critical})</span></h4>
    <div class="dm-chips">${chips(r._missingCritical, 'c-crit')}</div>
    <h4>Empty important fields <span class="muted">(weight ${state.settings.weights.important})</span></h4>
    <div class="dm-chips">${chips(r._missingImportant, 'c-warn')}</div>
    ${group('Critical fields', 'critical', true)}
    ${group('Important fields', 'important', true)}
    ${group('Ignored fields (excluded from scoring)', 'ignored', false)}`;
  $('#deviceModal').classList.remove('hidden');
}

/* ---------- Settings panel ---------- */
function renderSettingsPanel() {
  const s = state.settings;
  $('#wCritical').value = s.weights.critical;
  $('#wImportant').value = s.weights.important;
  $('#emptyMarkers').value = s.emptyMarkers.join('\n');

  // excluded statuses (from data)
  const statuses = tally(state.rows, r => catVal(r, 'Status'));
  $('#excludedStatuses').innerHTML = statuses.length
    ? statuses.map(([v, n]) => `
      <label><input type="checkbox" value="${esc(v)}" ${s.excludedStatuses.includes(v) ? 'checked' : ''}>
        <span class="${v === '(empty)' ? 'muted' : ''}">${esc(v)}</span> <span class="muted">(${fmtInt(n)})</span></label>`).join('')
    : '<p class="card-note">Load a CSV first to see the statuses present in your data.</p>';

  renderTierEditor();
}

function renderTierEditor() {
  const s = state.settings;
  const all = [...EXPECTED_COLUMNS];
  for (const f of state.fields) if (!all.includes(f)) all.push(f);
  $('#tierEditor').innerHTML = all.map(col => {
    const tier = s.tiers[col] || 'ignored';
    const isExtra = !EXPECTED_COLUMNS.includes(col);
    const absent = state.fields.length && !state.fields.includes(col);
    return `<div class="tier-row" data-col="${esc(col)}">
      <span class="tname">${esc(col)}
        ${isExtra ? '<span class="extra">extra column</span>' : ''}
        ${absent ? '<span class="absent">not in file</span>' : ''}</span>
      <span class="tier-seg">
        ${['critical', 'important', 'ignored'].map(t =>
          `<button type="button" data-tier="${t}" class="${tier === t ? 'on-' + t : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      </span>
    </div>`;
  }).join('');
  updateTierCounts();
}

function updateTierCounts() {
  const vals = Object.values(state.settings.tiers);
  const c = vals.filter(v => v === 'critical').length;
  const i = vals.filter(v => v === 'important').length;
  $('#tierCounts').textContent = `— ${c} critical · ${i} important · ${vals.length - c - i} ignored`;
}

const settingsRecompute = debounce(() => { saveSettings(); recomputeAll(); }, 250);

const SETTINGS_STORE_KEY = 'netboxDashboard.settings.v1';

function saveSettings() {
  try { localStorage.setItem(SETTINGS_STORE_KEY, currentConfigJSON()); }
  catch { /* storage unavailable (private mode / quota) — settings stay session-only */ }
}

function loadSavedSettings() {
  let raw = null;
  try { raw = localStorage.getItem(SETTINGS_STORE_KEY); } catch { return; }
  if (!raw) return;
  try {
    applyConfigJSON(raw);
    emptySet = new Set(state.settings.emptyMarkers);
  } catch {
    try { localStorage.removeItem(SETTINGS_STORE_KEY); } catch { /* ignore */ }
  }
}

function currentConfigJSON() {
  const s = state.settings;
  return JSON.stringify({
    version: 1,
    weights: s.weights,
    tiers: s.tiers,
    emptyMarkers: s.emptyMarkers,
    excludedStatuses: s.excludedStatuses,
  }, null, 2);
}

function applyConfigJSON(text) {
  const cfg = JSON.parse(text);
  const s = state.settings;
  if (cfg.weights) {
    if (Number.isFinite(+cfg.weights.critical)) s.weights.critical = Math.max(0, +cfg.weights.critical);
    if (Number.isFinite(+cfg.weights.important)) s.weights.important = Math.max(0, +cfg.weights.important);
  }
  if (cfg.tiers && typeof cfg.tiers === 'object') {
    for (const [col, tier] of Object.entries(cfg.tiers)) {
      if (['critical', 'important', 'ignored'].includes(tier)) s.tiers[col] = tier;
    }
  }
  if (Array.isArray(cfg.emptyMarkers)) s.emptyMarkers = cfg.emptyMarkers.map(String);
  if (Array.isArray(cfg.excludedStatuses)) s.excludedStatuses = cfg.excludedStatuses.map(String);
}

/* ---------- Export ---------- */
function buildAnnotatedCSV() {
  const fields = [...state.fields, 'Completeness %', 'Missing Critical Fields', 'Missing Important Fields'];
  const data = state.tableRows.map(r => {
    const row = state.fields.map(f => r[f] ?? '');
    row.push(r._completeness == null ? 'excluded' : r._completeness.toFixed(1));
    row.push(r._missingCritical.join('; '));
    row.push(r._missingImportant.join('; '));
    return row;
  });
  return Papa.unparse({ fields, data });
}

/* ================= Charts ================= */

function chartInk() {
  return { grid: cssVar('--grid'), muted: cssVar('--muted'), text2: cssVar('--text-2') };
}

function upsertBar(id, o) {
  const ink = chartInk();
  const horizontal = !!o.horizontal;
  const data = {
    labels: o.labels,
    datasets: [{
      data: o.values,
      backgroundColor: o.colors,
      borderRadius: 4,
      borderSkipped: 'start',
      maxBarThickness: horizontal ? 15 : 56,
      categoryPercentage: 0.82,
      barPercentage: 0.94,
    }],
  };
  const valueAxis = {
    beginAtZero: true,
    max: o.valueMax,
    grid: { color: ink.grid },
    border: { display: false },
    ticks: { color: ink.muted, precision: 0 },
  };
  const catAxis = {
    grid: { display: false },
    border: { display: false },
    ticks: { color: ink.text2, autoSkip: !horizontal },
  };
  const options = {
    indexAxis: horizontal ? 'y' : 'x',
    responsive: true,
    maintainAspectRatio: false,
    animation: charts[id] ? false : { duration: 350 },
    plugins: {
      legend: { display: false },
      tooltip: { callbacks: o.tooltip ? { label: o.tooltip } : {} },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
  if (charts[id]) {
    charts[id].data = data;
    charts[id].options = options;
    charts[id].update('none');
  } else {
    charts[id] = new Chart(document.getElementById(id), { type: 'bar', data, options });
  }
}

function destroyCharts() {
  for (const k of Object.keys(charts)) { charts[k].destroy(); delete charts[k]; }
}

/* ================= Events ================= */

function wireEvents() {
  // upload
  $('#btnLoadCsv').addEventListener('click', () => $('#fileInput').click());
  $('#btnBrowse').addEventListener('click', e => { e.stopPropagation(); $('#fileInput').click(); });
  $('#fileInput').addEventListener('change', e => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#dropzone').addEventListener('click', () => $('#fileInput').click());
  $('#btnSample').addEventListener('click', async e => {
    e.stopPropagation();
    try {
      const res = await fetch('sample_devices.csv');
      if (!res.ok) throw new Error(res.statusText);
      loadCSVText(await res.text(), 'sample_devices.csv (synthetic demo)');
    } catch {
      toast('Sample not reachable — serve this folder over http, or drop your own CSV.');
    }
  });
  document.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dragover-page'); });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dragover-page'); });
  document.addEventListener('drop', e => {
    e.preventDefault();
    document.body.classList.remove('dragover-page');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  // theme
  $('#btnTheme').addEventListener('click', () => {
    const root = document.documentElement;
    root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    $('#btnTheme').innerHTML = root.dataset.theme === 'dark' ? '&#9788;' : '&#9789;';
    destroyCharts();
    if (state.rows.length) renderAll();
  });

  // filters
  $('#btnClearFilters').addEventListener('click', () => {
    state.filters = {};
    renderFilterBar();
    applyFilters();
    renderAll();
  });

  // density toggle
  $('#densityToggle').addEventListener('click', e => {
    const mode = e.target.dataset?.mode;
    if (!mode || mode === state.densityMode) return;
    state.densityMode = mode;
    $$('#densityToggle button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    renderDensity();
  });

  // table
  $('#tableSearch').addEventListener('input', debounce(e => {
    state.search = e.target.value.trim();
    state.page = 0;
    computeTableRows();
    renderTableBody();
  }, 250));
  $('#btnClearTableFilters').addEventListener('click', () => {
    state.tableFilters = {};
    state.page = 0;
    renderTableFilterBar();
    computeTableRows();
    renderTableBody();
  });
  $('#btnOobOnly').addEventListener('click', () => {
    state.oobOnly = !state.oobOnly;
    $('#btnOobOnly').classList.toggle('active', state.oobOnly);
    state.page = 0;
    computeTableRows();
    renderTableBody();
  });
  $('#tableHead').addEventListener('click', e => {
    const th = e.target.closest('th');
    if (!th) return;
    const key = th.dataset.key;
    if (state.sort.key === key) state.sort.dir *= -1;
    else state.sort = { key, dir: 1 };
    computeTableRows();
    renderTableHead();
    renderTableBody();
  });
  $('#tableBody').addEventListener('click', e => {
    const tr = e.target.closest('tr');
    if (tr) openDeviceModal(+tr.dataset.idx);
  });
  $('#pgPrev').addEventListener('click', () => { state.page--; renderTableBody(); });
  $('#pgNext').addEventListener('click', () => { state.page++; renderTableBody(); });
  $('#btnExport').addEventListener('click', () => {
    if (!state.rows.length) return;
    const stamp = new Date().toISOString().slice(0, 10);
    download(`netbox_completeness_annotated_${stamp}.csv`, buildAnnotatedCSV(), 'text/csv');
    toast(`Exported ${fmtInt(state.tableRows.length)} rows (current table view).`);
  });

  // modals
  $$('.modal-close').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));
  $$('.modal-backdrop').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
  $('#btnSettings').addEventListener('click', () => {
    renderSettingsPanel();
    $('#settingsModal').classList.remove('hidden');
  });

  // settings
  $('#wCritical').addEventListener('input', e => {
    const v = Math.max(0, +e.target.value || 0);
    state.settings.weights.critical = v;
    settingsRecompute();
  });
  $('#wImportant').addEventListener('input', e => {
    const v = Math.max(0, +e.target.value || 0);
    state.settings.weights.important = v;
    settingsRecompute();
  });
  $('#emptyMarkers').addEventListener('input', debounce(e => {
    state.settings.emptyMarkers = e.target.value.split('\n').map(l => l.trim()).filter(Boolean);
    settingsRecompute();
  }, 400));
  $('#excludedStatuses').addEventListener('change', e => {
    if (e.target.type !== 'checkbox') return;
    const v = e.target.value;
    const list = state.settings.excludedStatuses;
    if (e.target.checked) { if (!list.includes(v)) list.push(v); }
    else state.settings.excludedStatuses = list.filter(x => x !== v);
    settingsRecompute();
  });
  $('#tierEditor').addEventListener('click', e => {
    const btn = e.target.closest('button[data-tier]');
    if (!btn) return;
    const col = btn.closest('.tier-row').dataset.col;
    state.settings.tiers[col] = btn.dataset.tier;
    btn.parentElement.querySelectorAll('button').forEach(b =>
      b.className = b.dataset.tier === btn.dataset.tier ? 'on-' + btn.dataset.tier : '');
    updateTierCounts();
    settingsRecompute();
  });
  $('#btnCfgDownload').addEventListener('click', () =>
    download('netbox_dashboard_config.json', currentConfigJSON(), 'application/json'));
  $('#btnCfgCopy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(currentConfigJSON()); toast('Config JSON copied to clipboard'); }
    catch { toast('Clipboard unavailable — use Download instead'); }
  });
  $('#btnCfgApply').addEventListener('click', () => {
    const msg = $('#cfgMsg');
    try {
      applyConfigJSON($('#cfgPaste').value);
      saveSettings();
      renderSettingsPanel();
      recomputeAll();
      msg.textContent = '✓ Config applied.';
    } catch (err) {
      msg.textContent = '✗ Invalid JSON: ' + err.message;
    }
  });
  $('#btnCfgReset').addEventListener('click', () => {
    state.settings = defaultSettings();
    for (const c of state.fields) if (!(c in state.settings.tiers)) state.settings.tiers[c] = 'ignored';
    try { localStorage.removeItem(SETTINGS_STORE_KEY); } catch { /* ignore */ }
    renderSettingsPanel();
    recomputeAll();
    $('#cfgMsg').textContent = 'Defaults restored.';
  });
}

/* ================= Init ================= */

function init() {
  Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  Chart.defaults.font.size = 11;
  loadSavedSettings();
  wireEvents();
  renderSettingsPanel();
}
init();

// exposed for testing & console use
window.app = { state, loadCSVText, buildAnnotatedCSV, currentConfigJSON, applyConfigJSON, parseDateSmart, parseGeneration, recomputeAll };

})();
