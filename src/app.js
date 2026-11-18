import { createSpectrumChart } from './chart.js';
import { demoSpectrum, readSpectrumFile, spectrumToCsv } from './data.js';
import { PLOT_LAUNCHER_URL, toPlotLauncherProject } from './plot-launcher.js';
import { analyzeBackground, estimatePeak, evaluateFit, fitPeaks, peakArea, shiftSpectrum } from './xps.js';

const byId = (id) => document.getElementById(id);
const iconPaths = {
  upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4"/>',
  download: '<path d="M12 4v12m-4-4 4 4 4-4M4 17v3h16v-3"/>',
  external: '<path d="M14 4h6v6m0-6-9 9m8 0v6H5V5h6"/>',
  expand: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  shift: '<path d="M4 8h15m-4-4 4 4-4 4m5 4H5m4-4-4 4 4 4"/>',
  layers: '<path d="m12 4 8 5-8 5-8-5 8-5Zm-8 9 8 5 8-5m-16 4 8 5 8-5"/>',
  activity: '<path d="M3 15h5l3-8 3 11 2-5h5"/>',
  spark: '<path d="M12 3c.8 5.2 2.8 7.2 8 8-5.2.8-7.2 2.8-8 8-.8-5.2-2.8-7.2-8-8 5.2-.8 7.2-2.8 8-8Zm7 13v5m-2.5-2.5h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sliders: '<path d="M7 4v5m0 4v7m5-16v9m0 4v3m5-16v3m0 4v9M5 9h4v4H5zm5 4h4v4h-4zm5-6h4v4h-4z"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  shield: '<path d="M12 22s7-3 7-10V5l-7-3-7 3v7c0 7 7 10 7 10Zm-3-10 2 2 4-4"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

for (const item of document.querySelectorAll('[data-icon]')) item.innerHTML = icon(item.dataset.icon);

const peakColors = ['#b9a0ff', '#51daba', '#ffc47b', '#fa91c3', '#79caff', '#ff957f', '#d4ed80', '#a3a6ff'];
const darkPeakColors = ['#704dd9', '#008666', '#b26413', '#be3c78', '#1979b4', '#b84225', '#5d7611', '#494dc8'];
const shapeOptions = [
  ['pseudo-voigt', '擬Voigt'],
  ['gaussian', 'Gaussian'],
  ['lorentzian', 'Lorentzian'],
];
const fields = [
  ['center', '位置 (eV)', -Infinity, Infinity],
  ['fwhm', 'FWHM (eV)', 0.000001, Infinity],
  ['height', '高さ', 0, Infinity],
  ['mix', 'L比 (%)', 0, 1],
];
const maxPeaks = 12;
const state = {
  spectrum: null, dataset: null, points: [], offset: 0, range: [], zoom: [], method: 'shirley',
  view: 'raw', shiftMode: 'direct', pick: null, peaks: [], nextId: 0, result: null, preview: null,
  background: null, section: [], start: 0, disabledSeries: new Set(), revision: 0, fitting: false,
};
let fileLoad = 0;
let statusTimeout;
let fitWorker;
let workerObjectUrl;
let constraintPeakId;

function decimal(value, digits = 3) {
  return Number.isFinite(value)
    ? (Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < 10 ** -digits)
      ? value.toExponential(2) : Number(value.toFixed(digits)).toString())
    : '—';
}

function displayNumber(value, digits) {
  return Number.isFinite(value) ? value.toLocaleString('ja-JP', { maximumFractionDigits: digits }) : '—';
}

function rangeOf(points) {
  return [points[0].x, points[points.length - 1].x];
}

function notice(message = '') {
  const alert = byId('global-error');
  alert.textContent = message;
  alert.hidden = !message;
}

function toast(message) {
  clearTimeout(statusTimeout);
  const element = byId('toast');
  element.textContent = message;
  element.hidden = false;
  statusTimeout = setTimeout(() => { element.hidden = true; }, 3700);
}

function energyName() {
  return state.spectrum.energyScale === 'kinetic' ? '運動エネルギー' : '結合エネルギー';
}

function buildPeak(peak) {
  const id = state.nextId++;
  return { ...peak, label: peak.label || `Peak ${id + 1}`, id };
}

function recalculate() {
  state.start = state.points.findIndex(({ x }) => x >= state.range[0]);
  state.section = [];
  for (let i = state.start; i >= 0 && i < state.points.length && state.points[i].x <= state.range[1]; i++) {
    state.section.push(state.points[i]);
  }
  state.background = analyzeBackground(state.section, state.method, { energyScale: state.spectrum.energyScale });
  updatePreview();
}

function updatePreview() {
  state.preview = evaluateFit(state.section, state.background.values, state.peaks);
}

function invalidate() {
  state.revision++;
  state.result = null;
  state.fitting = false;
  if (fitWorker) {
    fitWorker.terminate();
    fitWorker = undefined;
  }
  if (workerObjectUrl) {
    URL.revokeObjectURL(workerObjectUrl);
    workerObjectUrl = undefined;
  }
}

function assignSpectrum(spectrum) {
  invalidate();
  notice();
  state.spectrum = spectrum;
  state.original = spectrum.x.map((x, index) => ({ x, y: spectrum.y[index] }));
  state.points = state.original;
  state.offset = 0;
  state.range = spectrum.range || rangeOf(state.points);
  state.zoom = rangeOf(state.points);
  state.pick = null;
  state.view = 'raw';
  state.shiftMode = 'direct';
  state.disabledSeries.clear();
  state.nextId = 0;
  state.peaks = (spectrum.peaks || []).map(buildPeak);
  byId('plot-coordinates').textContent = '';
  byId('observed').value = '';
  byId('target').value = '';
  recalculate();
  if (!state.peaks.length) {
    state.peaks = [buildPeak(estimatePeak(state.section, state.background.values))];
    updatePreview();
  }
  syncControls();
  render();
}

function loadDataset(dataset) {
  state.dataset = dataset;
  const regions = dataset.regions || [];
  const select = byId('region');
  select.replaceChildren(...regions.map((region, index) => new Option(region.name, index)));
  byId('region-wrap').hidden = regions.length < 2;
  assignSpectrum(regions[0] || dataset);
}

function syncControls() {
  byId('offset').value = state.offset;
  byId('range-min').value = state.range[0];
  byId('range-max').value = state.range[1];
  byId('background').value = state.method;
  const shift = state.offset > 0 ? '+' : state.offset < 0 ? '−' : '';
  byId('shift-info').textContent = `適用中　${shift}${Math.abs(state.offset).toFixed(3)} eV`;
}

function applyShift(offset) {
  if (!Number.isFinite(offset)) return;
  const previous = state.offset;
  const delta = offset - previous;
  if (!delta) {
    syncControls();
    return;
  }
  let shifted;
  try {
    shifted = shiftSpectrum(state.original, offset);
    if (shifted.some(({ x }, i) => i && x <= shifted[i - 1].x)) throw new RangeError();
  } catch {
    notice('有効なエネルギー刻みを保てるシフト量を入力してください。');
    return;
  }
  const move = (value) => value - previous + offset;
  const moveRange = (range) => range.map((value) => {
    const exact = state.points.findIndex(({ x }) => x === value);
    return exact === -1 ? move(value) : shifted[exact].x;
  });
  const [low, high] = moveRange(state.range);
  if (shifted.filter(({ x }) => x >= low && x <= high).length < 3) {
    notice('このシフト量では解析範囲内のデータ点を保持できません。');
    return;
  }
  invalidate();
  notice();
  state.offset = offset;
  state.range = [low, high];
  state.zoom = moveRange(state.zoom);
  state.points = shifted;
  byId('plot-coordinates').textContent = '';
  state.peaks = state.peaks.map((peak) => ({
    ...peak,
    center: move(peak.center),
    bounds: peak.bounds?.center ? {
      ...peak.bounds, center: peak.bounds.center.map(move),
    } : peak.bounds,
  }));
  state.pick = null;
  recalculate();
  syncControls();
  render();
}

function setRange(min, max) {
  const full = rangeOf(state.points);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min ||
    min < full[0] - 1e-8 || max > full[1] + 1e-8) {
    notice(`測定範囲（${decimal(full[0], 6)}–${decimal(full[1], 6)} eV）内で、下限より大きい上限を指定してください。`);
    return;
  }
  min = Math.max(min, full[0]);
  max = Math.min(max, full[1]);
  if (state.points.filter(({ x }) => x >= min && x <= max).length < 3) {
    notice('解析範囲に少なくとも3点の測定データを含めてください。');
    return;
  }
  invalidate();
  state.range = [min, max];
  notice();
  recalculate();
  syncControls();
  render();
}

function sparseAligned(values, add = null) {
  const result = new Array(state.points.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    result[state.start + i] = values[i] + (add ? add[i] : 0);
  }
  return result;
}

function renderChart() {
  const corrected = state.view === 'corrected';
  const measurement = state.spectrum.y;
  const { fit, components, residuals } = state.preview;
  const { values: background } = state.background;
  const baseline = corrected ? background.map(() => 0) : background;
  const series = [];
  function add(id, label, color, values, options = {}) {
    series.push({ id, label, color, values, visible: !state.disabledSeries.has(id), ...options });
  }
  add('measured', corrected ? '背景減算後' : '測定データ', '#f2f4ff',
    corrected ? sparseAligned(state.section.map(({ y }, i) => y - background[i])) : measurement,
    { primary: true, marker: true, order: 4 });
  if (state.peaks.length) {
    add('total', state.result ? '合成フィット' : '初期モデル', '#a995ff',
      sparseAligned(fit.map((y, i) => corrected ? y - background[i] : y)), { width: 2.4, order: 3 });
  }
  if (!corrected && state.method !== 'none') {
    add('background', '背景', '#9eaac7', sparseAligned(background), { dash: true, order: 2 });
  }
  const alignedBaseline = components.length ? sparseAligned(baseline) : null;
  components.forEach((values, index) => {
    const peak = state.peaks[index];
    add(`p${peak.id}`, peak.label, peakColors[peak.id % peakColors.length], sparseAligned(values, baseline), {
      base: alignedBaseline, start: state.start, end: state.start + state.section.length - 1, order: 1,
    });
  });
  const residualExists = !!state.result && state.peaks.length > 0;
  if (residualExists) {
    add('residual', '残差', '#9cb3ff', [], { residualOnly: true });
  }
  const legend = byId('legend');
  const focusedId = legend.contains(document.activeElement) ? document.activeElement.dataset.series : null;
  legend.replaceChildren(...series.map(({ id, label, color, visible, marker, dash }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.series = id;
    button.setAttribute('aria-pressed', visible);
    const mark = document.createElement('span');
    mark.className = `legend-mark${marker ? ' dots' : dash ? ' dashed' : ''}`;
    mark.style.setProperty('--series', color);
    button.append(mark, label);
    return button;
  }));
  if (focusedId) [...legend.children].find((button) => button.dataset.series === focusedId)?.focus();
  drawChart({
    x: state.points.map(({ x }) => x),
    zoom: state.zoom, range: state.range,
    series: series.filter((item) => !item.residualOnly),
    residual: residualExists && !state.disabledSeries.has('residual') ? sparseAligned(residuals) : null,
    reverse: state.spectrum.energyScale !== 'kinetic',
    xLabel: `${energyName()} (eV)`,
    yLabel: state.spectrum.yUnit ? `強度 (${state.spectrum.yUnit})` : '強度',
  });
}

function render() {
  const name = state.spectrum.name;
  byId('chart-title').textContent = name;
  byId('spectrum-meta').textContent = `${state.spectrum.filename || name}  ·  ${state.points.length.toLocaleString('ja-JP')} 点  ·  ${energyName()}`;
  for (const button of document.querySelectorAll('[data-view]')) {
    button.setAttribute('aria-pressed', button.dataset.view === state.view);
  }
  for (const button of document.querySelectorAll('[data-shift-mode]')) {
    button.setAttribute('aria-pressed', button.dataset.shiftMode === state.shiftMode);
  }
  byId('direct-form').hidden = state.shiftMode !== 'direct';
  byId('reference-form').hidden = state.shiftMode !== 'reference';
  renderPick();
  renderBackground();
  renderFit();
  renderPeaks();
  renderChart();
}

function renderPick() {
  byId('add-peak').setAttribute('aria-pressed', state.pick === 'peak');
  byId('pick-reference').setAttribute('aria-pressed', state.pick === 'reference');
  byId('pick-reference').classList.toggle('active', state.pick === 'reference');
  byId('plot-help').textContent = {
    peak: 'ピークの位置をクリック · Escでキャンセル',
    reference: '参照に使う測定位置をクリック · Escでキャンセル',
  }[state.pick] || 'ドラッグで拡大 · クリックで座標を確認';
}

function renderBackground() {
  const info = byId('background-info');
  const warning = state.background.status !== 'ok';
  const messages = { 'no-peak': 'Shirleyの積分量が不足したためLinearを表示しています。', 'iteration-limit': 'Shirleyが収束しなかったためLinearを表示しています。' };
  info.classList.toggle('warning', warning);
  info.textContent = warning ? messages[state.background.status] : `解析に使用　${state.section.length.toLocaleString('ja-JP')} 点`;
}

function renderFit() {
  const status = byId('fit-status');
  const result = state.result;
  const labels = {
    converged: '収束', fixed: '固定値で評価', 'stalled': '最適化が停滞',
    'iteration-limit': '反復上限に到達', 'insufficient-points': '自由変数に対し測定点が不足',
  };
  status.classList.toggle('success', !!result?.converged);
  status.classList.toggle('warning', !!result && !result.converged);
  status.textContent = state.fitting ? '計算中…' : result ? labels[result.status] : 'フィット前';
  byId('r-squared').value = Number.isFinite(result?.rSquared) ? result.rSquared.toFixed(5) : '—';
  byId('rmse').value = displayNumber(result?.rmse, 3);
  const button = byId('fit');
  button.disabled = state.fitting || !state.peaks.length;
}

function rowInput(peak, key, label, digits) {
  const input = document.createElement('input');
  input.type = key === 'label' ? 'text' : 'number';
  input.dataset.field = key;
  input.setAttribute('aria-label', `${peak.label} ${label}`);
  if (key === 'label') {
    input.value = peak.label;
    input.maxLength = 60;
  } else {
    input.step = 'any';
    input.value = decimal(peak[key], digits);
  }
  return input;
}

function renderPeaks() {
  byId('peak-count').textContent = state.peaks.length;
  const body = byId('peak-rows');
  body.replaceChildren();
  if (!state.peaks.length) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 7;
    cell.className = 'peak-empty';
    cell.textContent = '「ピークを追加」を押し、グラフで成分の位置を選択してください。';
    return;
  }
  for (const peak of state.peaks) {
    const row = body.insertRow();
    row.dataset.id = peak.id;
    const name = document.createElement('div');
    name.className = 'name-field';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.setProperty('--swatch', darkPeakColors[peak.id % darkPeakColors.length]);
    name.append(swatch, rowInput(peak, 'label', '名前'));
    row.insertCell().append(name);
    const select = document.createElement('select');
    select.dataset.field = 'shape';
    select.setAttribute('aria-label', `${peak.label} 形状`);
    select.replaceChildren(...shapeOptions.map(([value, label]) => new Option(label, value)));
    select.value = peak.shape;
    row.insertCell().append(select);
    for (const [key, label, digits] of [['center', '位置', 5], ['fwhm', 'FWHM', 5], ['height', '高さ', 4]]) {
      row.insertCell().append(rowInput(peak, key, label, digits));
    }
    const area = row.insertCell();
    area.className = 'number';
    area.textContent = displayNumber(peakArea(peak), 2);
    area.title = '成分の全域積分';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [action, glyph, label] of [['constraint', 'sliders', '調整'], ['delete', 'trash', '削除']]) {
      const button = document.createElement('button');
      button.className = 'icon-button';
      if (action === 'constraint' && (Object.values(peak.fixed || {}).some(Boolean) || Object.keys(peak.bounds || {}).length)) {
        button.classList.add('constrained');
      }
      button.type = 'button';
      button.dataset.action = action;
      button.title = label;
      button.setAttribute('aria-label', `${peak.label} ${label}`);
      button.innerHTML = icon(glyph);
      actions.append(button);
    }
    row.insertCell().append(actions);
  }
}

function openConstraints(peak) {
  constraintPeakId = peak.id;
  const rows = byId('constraint-rows');
  rows.replaceChildren();
  byId('peak-dialog-title').textContent = `${peak.label} の制約`;
  const grid = document.createElement('div');
  grid.className = 'constraint-grid';
  for (const value of ['変数', '値', '固定', '下限', '上限']) {
    const heading = document.createElement('span');
    heading.textContent = value;
    grid.append(heading);
  }
  for (const [key, label, min, max] of fields) {
    if (key === 'mix' && peak.shape !== 'pseudo-voigt') continue;
    const factor = key === 'mix' ? 100 : 1;
    const title = document.createElement('label');
    title.htmlFor = `constraint-${key}-value`;
    title.textContent = label;
    grid.append(title);
    for (const [column, value, aria] of [
      ['value', peak[key], '値'], ['fixed', peak.fixed?.[key], '固定'],
      ['min', peak.bounds?.[key]?.[0], '下限'], ['max', peak.bounds?.[key]?.[1], '上限'],
    ]) {
      const input = document.createElement('input');
      input.id = `constraint-${key}-${column}`;
      input.name = input.id;
      input.setAttribute('aria-label', `${label} ${aria}`);
      if (column === 'fixed') {
        input.type = 'checkbox';
        input.checked = !!value;
      } else {
        input.type = 'number';
        input.step = 'any';
        input.required = column === 'value';
        input.value = Number.isFinite(value) ? decimal(value * factor, 8) : '';
        if (Number.isFinite(min)) input.min = min * factor;
        if (Number.isFinite(max)) input.max = max * factor;
      }
      grid.append(input);
    }
  }
  rows.append(grid);
  byId('peak-dialog').showModal();
}

function applyConstraints(event) {
  event.preventDefault();
  const peak = state.peaks.find(({ id }) => id === constraintPeakId);
  if (!peak) return;
  const next = { ...peak, bounds: {}, fixed: {} };
  for (const [key, , min, max] of fields) {
    const value = byId(`constraint-${key}-value`);
    if (!value) continue;
    const factor = key === 'mix' ? 100 : 1;
    const fixed = byId(`constraint-${key}-fixed`).checked;
    const lower = byId(`constraint-${key}-min`);
    const upper = byId(`constraint-${key}-max`);
    const low = lower.value === '' ? min : lower.valueAsNumber / factor;
    const high = upper.value === '' ? max : upper.valueAsNumber / factor;
    next[key] = value.valueAsNumber / factor;
    if (low > high || next[key] < low || next[key] > high) {
      value.setCustomValidity('下限・上限と値の関係を確認してください。');
      value.reportValidity();
      return;
    }
    if (fixed) next.fixed[key] = true;
    if (lower.value !== '' || upper.value !== '') next.bounds[key] = [low, high];
  }
  invalidate();
  state.peaks = state.peaks.map((item) => item.id === peak.id ? next : item);
  updatePreview();
  byId('peak-dialog').close();
  render();
}

function runFit() {
  if (state.fitting || !state.peaks.length) return;
  notice();
  invalidate();
  state.fitting = true;
  const revision = state.revision;
  const args = [state.section, state.background.values, state.peaks];
  renderFit();
  renderChart();
  function done(result, error) {
    if (revision !== state.revision) return;
    invalidate();
    if (error) {
      notice('フィットを完了できませんでした。位置・FWHM・高さと制約を確認してください。');
    } else {
      state.result = result;
      state.peaks = result.peaks;
      updatePreview();
    }
    render();
  }
  function fallback() {
    requestAnimationFrame(() => setTimeout(() => {
      if (revision !== state.revision) return;
      try { done(fitPeaks(...args)); }
      catch (error) { done(null, error); }
    }, 0));
  }
  try {
    const inlineWorker = typeof __XPS_WORKER_SOURCE__ === 'string' ? __XPS_WORKER_SOURCE__ : null;
    if (inlineWorker) workerObjectUrl = URL.createObjectURL(new Blob([inlineWorker], { type: 'text/javascript' }));
    fitWorker = new Worker(workerObjectUrl || new URL('./fit-worker.js', import.meta.url), { type: 'module' });
    fitWorker.onmessage = ({ data }) => done(data.result, data.error);
    fitWorker.onerror = fallback;
    fitWorker.postMessage(args);
  } catch {
    fallback();
  }
}

function exportData(plotLauncher) {
  try {
    const result = state.result;
    const { values: background } = state.background;
    const columns = [];
    const series = [{ label: '測定データ', column: 1, color: '#253853', mode: 'scatter' }];
    function add(label, values, options) {
      columns.push({ label, values });
      if (options) series.push({ label, column: columns.length + 1, ...options });
    }
    if (state.method !== 'none') {
      add('バックグラウンド', sparseAligned(background), { color: '#6f7890', style: '--' });
    }
    add('背景減算後', sparseAligned(state.section.map(({ y }, i) => y - background[i])));
    if (result) {
      add('合成フィット', sparseAligned(result.fit), { color: '#5441d0' });
      add('残差', sparseAligned(result.residuals));
      result.components.forEach((component, i) => {
        const peak = state.peaks[i];
        add(`成分 ${i + 1} ${peak.label}`, sparseAligned(component));
        if (plotLauncher) {
          add(`背景付き成分 ${i + 1} ${peak.label}`, sparseAligned(component, background), {
            color: darkPeakColors[peak.id % darkPeakColors.length],
          });
        }
      });
    }
    add('補正前エネルギー (eV)', state.spectrum.x);
    const csv = spectrumToCsv({ ...state.spectrum, x: state.points.map(({ x }) => x), columns });
    const stem = (state.spectrum.filename || state.spectrum.name).replace(/\.[^.]+$/, '');
    const region = state.dataset.regions?.length > 1 ? `-${state.spectrum.name}` : '';
    const name = (stem + region).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    if (plotLauncher && state.points.length > 200000) throw new Error('Plot Launcherは20万点まで読み込めます。CSVで保存してください。');
    const payload = plotLauncher ? toPlotLauncherProject({
      name: `${name}-xps`, csv, xLabel: energyName(), yUnit: state.spectrum.yUnit, series,
      reverseX: state.spectrum.energyScale !== 'kinetic',
    }) : csv;
    const link = document.createElement('a');
    const url = URL.createObjectURL(new Blob([payload], { type: plotLauncher ? 'application/json' : 'text/csv;charset=utf-8' }));
    link.href = url;
    link.download = `${name}-xps.${plotLauncher ? 'plotproject' : 'csv'}`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast(plotLauncher ? 'Plot Launcherの編集用ファイルを保存しました。' : '解析データをCSVで保存しました。');
  } catch (error) {
    notice(error.message || 'ファイルの書き出しに失敗しました。');
  }
}

function choosePeak(x) {
  byId('plot-coordinates').textContent = `${decimal(x, 5)} eV`;
  if (state.pick === 'reference') {
    byId('observed').value = decimal(x - state.offset, 8);
    state.pick = null;
    byId('target').focus();
    renderPick();
  } else if (state.pick === 'peak') {
    if (x < state.range[0] || x > state.range[1]) {
      toast('解析範囲内の位置を選択してください。');
      return;
    }
    invalidate();
    state.peaks.push(buildPeak(estimatePeak(state.section, state.background.values, x)));
    state.pick = null;
    updatePreview();
    render();
  }
}

function setZoom(range) {
  const count = state.points.filter(({ x }) => x >= range[0] && x <= range[1]).length;
  if (count < 2) return;
  state.zoom = range;
  renderChart();
}

const drawChart = createSpectrumChart(byId('spectrum'), byId('tooltip'), choosePeak, setZoom);

async function open(file) {
  if (!file) return;
  const load = ++fileLoad;
  notice();
  try {
    const spectrum = await readSpectrumFile(file);
    if (load === fileLoad) loadDataset(spectrum);
  } catch (error) {
    if (load === fileLoad) notice(error.message || 'ファイルを開けませんでした。');
  }
}

byId('file').addEventListener('change', (event) => {
  void open(event.target.files[0]);
  event.target.value = '';
});
byId('open-file').addEventListener('click', () => byId('file').click());
byId('demo').addEventListener('click', () => {
  ++fileLoad;
  loadDataset(demoSpectrum());
  runFit();
});
byId('region').addEventListener('change', (event) => assignSpectrum(state.dataset.regions[event.target.value]));
byId('direct-form').addEventListener('submit', (event) => {
  event.preventDefault();
  applyShift(byId('offset').valueAsNumber);
});
byId('reference-form').addEventListener('submit', (event) => {
  event.preventDefault();
  applyShift(byId('target').valueAsNumber - byId('observed').valueAsNumber);
});
byId('pick-reference').addEventListener('click', () => {
  state.pick = state.pick === 'reference' ? null : 'reference';
  renderPick();
});
for (const button of document.querySelectorAll('[data-shift-mode]')) {
  button.addEventListener('click', () => {
    state.shiftMode = button.dataset.shiftMode;
    if (state.shiftMode === 'direct' && state.pick === 'reference') state.pick = null;
    render();
  });
}
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    state.view = button.dataset.view;
    render();
  });
}
byId('reset-zoom').addEventListener('click', () => setZoom(rangeOf(state.points)));
byId('background').addEventListener('change', (event) => {
  notice();
  invalidate();
  state.method = event.target.value;
  recalculate();
  render();
});
byId('range-form').addEventListener('submit', (event) => {
  event.preventDefault();
  setRange(byId('range-min').valueAsNumber, byId('range-max').valueAsNumber);
});
byId('full-range').addEventListener('click', () => setRange(...rangeOf(state.points)));
byId('fit').addEventListener('click', runFit);
byId('add-peak').addEventListener('click', () => {
  if (state.peaks.length >= maxPeaks) {
    toast(`ピーク成分は最大${maxPeaks}個です。`);
    return;
  }
  state.pick = state.pick === 'peak' ? null : 'peak';
  renderPick();
  if (state.pick && window.innerWidth <= 780) byId('plot').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
byId('legend').addEventListener('click', (event) => {
  const id = event.target.closest('button')?.dataset.series;
  if (!id) return;
  if (state.disabledSeries.has(id)) state.disabledSeries.delete(id);
  else state.disabledSeries.add(id);
  renderChart();
});
byId('peak-rows').addEventListener('change', (event) => {
  const input = event.target;
  const key = input.dataset.field;
  const peak = state.peaks.find(({ id }) => id === Number(input.closest('tr')?.dataset.id));
  if (!peak || !key) return;
  if (key === 'label') {
    peak.label = input.value.trim() || `Peak ${peak.id + 1}`;
    input.value = peak.label;
    renderChart();
    return;
  }
  const value = key === 'shape' ? input.value : input.valueAsNumber;
  const limits = fields.find(([field]) => field === key)?.slice(2);
  if (limits && (!Number.isFinite(value) || value < limits[0] || value > limits[1] ||
    (peak.bounds?.[key] && (value < peak.bounds[key][0] || value > peak.bounds[key][1])))) {
    input.value = decimal(peak[key], 8);
    toast('数値が有効範囲または設定済みの制約を外れています。');
    return;
  }
  peak[key] = value;
  invalidate();
  updatePreview();
  renderFit();
  renderChart();
  const area = input.closest('tr').querySelector('.number');
  area.textContent = displayNumber(peakArea(peak), 2);
});
byId('peak-rows').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement) event.target.blur();
});
byId('peak-rows').addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const id = Number(button.closest('tr').dataset.id);
  if (button.dataset.action === 'constraint') {
    openConstraints(state.peaks.find((peak) => peak.id === id));
  } else {
    invalidate();
    state.peaks = state.peaks.filter((peak) => peak.id !== id);
    updatePreview();
    render();
  }
});
byId('peak-form').addEventListener('submit', applyConstraints);
byId('peak-form').addEventListener('input', () => {
  for (const input of byId('peak-form').querySelectorAll('input')) input.setCustomValidity('');
});
byId('export-csv').addEventListener('click', () => exportData(false));
byId('export-plot').addEventListener('click', () => exportData(true));
byId('show-help').addEventListener('click', () => byId('help-dialog').showModal());
const launcherLink = document.createElement('a');
launcherLink.href = PLOT_LAUNCHER_URL;
launcherLink.target = '_blank';
launcherLink.rel = 'noopener noreferrer';
launcherLink.textContent = 'Plot Launcherを開く';
byId('help-dialog').querySelector('ol li:last-child').append(' ', launcherLink);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => byId(button.dataset.close).close());
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.pick) {
    state.pick = null;
    renderPick();
  }
});
document.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  byId('workspace').classList.add('dragging');
});
document.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget) byId('workspace').classList.remove('dragging');
});
document.addEventListener('drop', (event) => {
  byId('workspace').classList.remove('dragging');
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  void open(event.dataTransfer.files[0]);
});

loadDataset(demoSpectrum());
runFit();
