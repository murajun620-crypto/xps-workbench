import { createSpectrumChart } from './chart.js';
import { demoSpectrum, readSpectrumFile, spectrumToCsv } from './data.js';
import { englishExportFilename, englishExportLabel } from './export-labels.js';
import { installNumberInputs } from './number-input.js';
import { MIN_PEAK_FWHM, movePeakHandle } from './peak-handles.js';
import { PLOT_LAUNCHER_URL, toPlotLauncherFitCsv, toPlotLauncherProject } from './plot-launcher.js';
import { restorePeakFromCurve } from './restore-peaks.js';
import { installUpdateCheck } from './updates.js';
import { analyzeBackground, estimatePeak, evaluateFit, fitPeaks, fitStatistics, peakArea, shiftSpectrum } from './xps.js';

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
  refresh: '<path d="M20 7v5h-5M4 17v-5h5m10.45 0a7.5 7.5 0 0 0-13.32-4.7m-1.58 4.7a7.5 7.5 0 0 0 13.32 4.7"/>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name]}</svg>`;
}

for (const item of document.querySelectorAll('[data-icon]')) item.innerHTML = icon(item.dataset.icon);

const peakColors = ['#b9a0ff', '#51daba', '#ffc47b', '#fa91c3', '#79caff', '#ff957f', '#d4ed80', '#a3a6ff'];
const darkPeakColors = ['#704dd9', '#008666', '#b26413', '#be3c78', '#1979b4', '#b84225', '#5d7611', '#494dc8'];
const shapeOptions = [
  ['pseudo-voigt', 'Pseudo-Voigt'],
  ['gaussian', 'Gaussian'],
  ['lorentzian', 'Lorentzian'],
];
const fields = [
  ['center', 'Center (eV)', -Infinity, Infinity],
  ['fwhm', 'FWHM (eV)', MIN_PEAK_FWHM, Infinity],
  ['height', 'Height', 0, Infinity],
  ['mix', 'Lorentzian fraction (%)', 0, 1],
];
const peakColumns = [['center', 'Center', 5], ['fwhm', 'FWHM', 5], ['height', 'Height', 4]];
const si2pDoublet = { separation: 0.606, ratio: 2 };
const maxPeaks = 12;
const spectrumFileType = {
  description: 'Spectrum files',
  accept: {
    'text/csv': ['.csv'],
    'text/plain': ['.tsv', '.txt', '.xy', '.dat', '.vms', '.vamas', '.npl'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
  },
};
function emptyProject() {
  return {
    spectrum: null, dataset: null, sourceHandle: null, points: [], original: [], offset: 0,
    range: [], zoom: [], method: 'shirley',
    view: 'raw', shiftMode: 'direct', pick: null, peaks: [], nextId: 0, result: null, preview: null,
    background: null, section: [], start: 0, disabledSeries: new Set(),
  };
}
const state = { ...emptyProject(), revision: 0, fitting: false };
let fileLoad = 0;
let statusTimeout;
let fitWorker;
let workerObjectUrl;
let constraintPeakId;
let peakDrag;

function decimal(value, digits = 3) {
  return Number.isFinite(value)
    ? (Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < 10 ** -digits)
      ? value.toExponential(2) : Number(value.toFixed(digits)).toString())
    : '—';
}

function displayNumber(value, digits) {
  return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits }) : '—';
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
  return state.spectrum.energyScale === 'kinetic' ? 'Kinetic energy' : 'Binding energy';
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
  state.preview = evaluateFit(state.section, state.background.values, state.peaks, {
    energyScale: state.spectrum.energyScale,
  });
}

function recordManualModel() {
  if (!state.peaks.length) return;
  state.result = { ...state.preview, status: 'manual', iterations: 0, converged: false };
  state.preview = state.result;
}

function updateManualModel() {
  updatePreview();
  recordManualModel();
}

function refreshAnalysis() {
  const hadResult = Boolean(state.result);
  invalidate();
  recalculate();
  if (hadResult) recordManualModel();
}

function savedSection(values) {
  if (!values) return null;
  const section = values.slice(state.start, state.start + state.section.length);
  return section.length === state.section.length && section.every(Number.isFinite) ? section : null;
}

function savedRange(saved) {
  const full = rangeOf(state.points);
  const range = saved?.metadata?.range;
  if (range && range[0] >= full[0] && range[1] <= full[1] &&
    state.points.filter(({ x }) => x >= range[0] && x <= range[1]).length >= 3) {
    return range;
  }
  for (const values of [saved?.fit, saved?.corrected, saved?.background]) {
    if (!values) continue;
    const first = values.findIndex(Number.isFinite);
    const last = values.findLastIndex(Number.isFinite);
    if (first >= 0 && last - first >= 2) return [state.points[first].x, state.points[last].x];
  }
  return full;
}

function restoreAnalysis(saved) {
  const metadata = saved.metadata;
  const baseline = savedSection(saved.background);
  if (baseline) {
    if (!metadata && state.method !== 'none') {
      const linear = analyzeBackground(state.section, 'linear').values;
      const error = (values) => values.reduce((sum, value, i) => sum + (value - baseline[i]) ** 2, 0);
      if (error(linear) < error(state.background.values)) state.method = 'linear';
    }
    state.background = { values: baseline, status: 'ok', iterations: 0 };
  }
  const curves = saved.components.slice(0, maxPeaks).map(({ values }) => savedSection(values));
  if (metadata) {
    state.peaks = metadata.peaks.slice(0, maxPeaks).map((peak) => {
      const bounds = Object.fromEntries(Object.entries(peak.bounds || {}).map(([key, [low, high]]) =>
        [key, [low ?? -Infinity, high ?? Infinity]]));
      return { ...peak, bounds };
    });
    state.nextId = Math.max(0, ...state.peaks.map(({ id }) => id + 1));
  } else {
    state.peaks = curves.flatMap((curve, i) => {
      if (!curve) return [];
      const label = saved.components[i].label;
      return [buildPeak({ ...restorePeakFromCurve(state.section, curve), label })];
    });
  }
  updatePreview();
  const fit = savedSection(saved.fit);
  if (!state.peaks.length) return;
  if (!fit) {
    if (metadata?.status === 'manual') recordManualModel();
    return;
  }
  const residuals = savedSection(saved.residual) || fit.map((value, i) => state.section[i].y - value);
  const status = metadata?.status || 'restored';
  const components = metadata
    ? state.peaks.map((_, i) => curves[i] || state.preview.components[i])
    : curves.filter(Boolean);
  state.result = {
    peaks: state.peaks, fit, residuals, ...fitStatistics(state.section, residuals),
    iterations: metadata?.iterations ?? 0, status,
    converged: status === 'converged' || status === 'fixed',
    components,
    lines: state.peaks.map((peak, i) => peak.doublet ? state.preview.lines[i] : [components[i]]),
  };
  state.preview = state.result;
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

function showAnalysis(visible) {
  byId('empty-project').hidden = visible;
  byId('analysis-workspace').hidden = !visible;
  byId('workspace-exports').hidden = !visible;
}

function resetProject() {
  ++fileLoad;
  peakDrag = undefined;
  invalidate();
  Object.assign(state, emptyProject());
  showAnalysis(false);
  notice();
  clearTimeout(statusTimeout);
  byId('toast').hidden = true;
  byId('toast').textContent = '';
  byId('workspace').classList.remove('dragging');
  byId('region-wrap').hidden = true;
  byId('region').replaceChildren();
  byId('legend').replaceChildren();
  byId('peak-rows').replaceChildren();
  byId('peak-count').textContent = '';
  byId('chart-title').textContent = 'Spectrum';
  for (const id of ['spectrum-meta', 'plot-coordinates', 'background-info', 'shift-info']) {
    byId(id).textContent = '';
  }
  for (const id of ['file', 'offset', 'observed', 'target', 'range-min', 'range-max']) {
    const input = byId(id);
    input.value = '';
    input.removeAttribute('min');
    input.removeAttribute('max');
  }
  byId('background').value = state.method;
  const constraints = byId('peak-dialog');
  if (constraints.open) constraints.close();
  byId('constraint-rows').replaceChildren();
  byId('doublet-enabled').checked = false;
  syncDoubletControls();
  constraintPeakId = undefined;
  renderPick();
  renderFit();
  drawChart(null);
}

function assignSpectrum(spectrum) {
  peakDrag = undefined;
  invalidate();
  notice();
  state.spectrum = spectrum;
  state.points = spectrum.x.map((x, index) => ({ x, y: spectrum.y[index] }));
  const saved = spectrum.analysis;
  state.offset = saved?.metadata?.offset ?? (saved?.originalX ? spectrum.x[0] - saved.originalX[0] : 0);
  state.original = !saved?.originalX && !state.offset ? state.points : state.points.map(({ x, y }, i) => ({
    x: saved?.originalX?.[i] ?? x - state.offset, y,
  }));
  state.range = spectrum.range || savedRange(saved);
  if (saved) state.method = saved.metadata?.method || (saved.background ? 'shirley' : 'none');
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
  if (saved) restoreAnalysis(saved);
  if (!state.peaks.length && !saved?.metadata) {
    state.peaks = [buildPeak(estimatePeak(state.section, state.background.values))];
    updatePreview();
  }
  syncControls();
  showAnalysis(true);
  render();
}

function loadDataset(dataset, sourceHandle = null) {
  state.dataset = dataset;
  state.sourceHandle = sourceHandle;
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
  const [minimum, maximum] = rangeOf(state.points);
  for (const id of ['range-min', 'range-max']) {
    byId(id).min = minimum;
    byId(id).max = maximum;
  }
  byId('background').value = state.method;
  const shift = state.offset > 0 ? '+' : state.offset < 0 ? '−' : '';
  byId('shift-info').textContent = `Applied: ${shift}${Math.abs(state.offset).toFixed(3)} eV`;
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
    notice('Enter an offset that preserves distinct energy values.');
    return;
  }
  const move = (value) => value - previous + offset;
  const moveRange = (range) => range.map((value) => {
    const exact = state.points.findIndex(({ x }) => x === value);
    return exact === -1 ? move(value) : shifted[exact].x;
  });
  const [low, high] = moveRange(state.range);
  if (shifted.filter(({ x }) => x >= low && x <= high).length < 3) {
    notice('This offset leaves too few points in the analysis range.');
    return;
  }
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
  refreshAnalysis();
  syncControls();
  render();
}

function setRange(min, max) {
  const full = rangeOf(state.points);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min ||
    min < full[0] - 1e-8 || max > full[1] + 1e-8) {
    notice(`Enter an increasing range within ${decimal(full[0], 6)} to ${decimal(full[1], 6)} eV.`);
    return;
  }
  min = Math.max(min, full[0]);
  max = Math.min(max, full[1]);
  if (state.points.filter(({ x }) => x >= min && x <= max).length < 3) {
    notice('Include at least three measured points in the analysis range.');
    return;
  }
  if (min === state.range[0] && max === state.range[1]) {
    notice();
    syncControls();
    return;
  }
  state.range = [min, max];
  notice();
  refreshAnalysis();
  syncControls();
  render();
}

function sparseAligned(values, add = null, project = state) {
  const result = new Array(project.points.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    result[project.start + i] = values[i] + (add ? add[i] : 0);
  }
  return result;
}

function lineMember(index) {
  return index === 0 ? 'primary' : 'secondary';
}

function lineLabel(peak, index) {
  return peak.doublet ? `${peak.label} (${lineMember(index)})` : peak.label;
}

function backgroundAt(energy) {
  if (state.view === 'corrected') return 0;
  const points = state.section;
  const values = state.background.values;
  let low = 0;
  let high = points.length - 1;
  if (energy <= points[low].x) return values[low];
  if (energy >= points[high].x) return values[high];
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (points[middle].x <= energy) low = middle;
    else high = middle;
  }
  const fraction = (energy - points[low].x) / (points[high].x - points[low].x);
  return values[low] + fraction * (values[high] - values[low]);
}

function getPeakHandles() {
  if (state.pick || !state.section.length) return [];
  const low = Math.max(state.zoom[0], state.section[0].x);
  const high = Math.min(state.zoom[1], state.section.at(-1).x);
  const visible = (x) => x >= low && x <= high;
  return state.peaks.flatMap((peak) => {
    if (!visible(peak.center) || state.disabledSeries.has(`p${peak.id}`)) return [];
    const color = peakColors[peak.id % peakColors.length];
    const editable = (name) => !peak.fixed?.[name] &&
      !(peak.bounds?.[name] && peak.bounds[name][0] === peak.bounds[name][1]);
    const halfWidth = peak.fwhm / 2;
    const side = peakDrag?.handle.peakId === peak.id && peakDrag.handle.kind === 'width'
      ? peakDrag.handle.side
      : visible(peak.center + halfWidth) || !visible(peak.center - halfWidth) ? 1 : -1;
    const half = peak.center + side * halfWidth;
    const primary = lineLabel(peak, 0);
    return [
      {
        id: `top-${peak.id}`, peakId: peak.id, kind: 'top', x: peak.center,
        y: backgroundAt(peak.center) + peak.height, color,
        editable: editable('center') || editable('height'),
        label: `${primary} peak position and height`,
      },
      {
        id: `width-${peak.id}`, peakId: peak.id, kind: 'width', side, x: half,
        y: backgroundAt(half) + peak.height / 2, color, editable: editable('fwhm'),
        label: `${primary} FWHM`,
      },
    ];
  });
}

function renderChart({ updateLegend = true } = {}) {
  const corrected = state.view === 'corrected';
  const measurement = state.spectrum.y;
  const { fit, lines, residuals } = state.preview;
  const { values: background } = state.background;
  const baseline = corrected ? background.map(() => 0) : background;
  const series = [];
  function add(id, label, color, values, options = {}) {
    series.push({ id, label, color, values, visible: !state.disabledSeries.has(id), ...options });
  }
  add('measured', corrected ? 'Background-subtracted' : 'Measured', '#f2f4ff',
    corrected ? sparseAligned(state.section.map(({ y }, i) => y - background[i])) : measurement,
    { primary: true, marker: true, order: 4 });
  if (state.peaks.length) {
    const label = state.result?.status === 'manual' ? 'Manual model' : state.result ? 'Total fit' : 'Initial model';
    add('total', label, '#a995ff',
      sparseAligned(fit.map((y, i) => corrected ? y - background[i] : y)), { width: 2.4, order: 3 });
  }
  if (!corrected && state.method !== 'none') {
    add('background', 'Background', '#9eaac7', sparseAligned(background), { dash: true, order: 2 });
  }
  const alignedBaseline = lines.length ? sparseAligned(baseline) : null;
  lines.forEach((members, index) => {
    const peak = state.peaks[index];
    members.forEach((values, member) => {
      const id = member ? `p${peak.id}-2` : `p${peak.id}`;
      add(id, lineLabel(peak, member), peakColors[peak.id % peakColors.length], sparseAligned(values, baseline), {
        base: alignedBaseline, start: state.start, end: state.start + state.section.length - 1,
        order: 1, dash: member > 0,
      });
    });
  });
  const residualExists = state.peaks.length > 0;
  if (residualExists) {
    add('residual', 'Residual', '#9cb3ff', [], { residualOnly: true });
  }
  if (updateLegend) renderLegend(series);
  drawChart({
    x: state.points.map(({ x }) => x),
    zoom: state.zoom, range: state.range,
    series: series.filter((item) => !item.residualOnly),
    residual: residualExists && !state.disabledSeries.has('residual') ? sparseAligned(residuals) : null,
    handles: getPeakHandles(),
    reverse: state.spectrum.energyScale !== 'kinetic',
    xLabel: `${energyName()} (eV)`,
    yLabel: state.spectrum.yUnit ? `Intensity (${state.spectrum.yUnit})` : 'Intensity',
  });
}

function renderLegend(series) {
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
}

function render() {
  const name = state.spectrum.name;
  byId('chart-title').textContent = name;
  byId('spectrum-meta').textContent = `${state.spectrum.filename || name}  ·  ${state.points.length.toLocaleString('en-US')} points  ·  ${energyName()}`;
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
  byId('add-doublet').setAttribute('aria-pressed', state.pick === 'doublet');
  byId('pick-reference').setAttribute('aria-pressed', state.pick === 'reference');
  byId('pick-reference').classList.toggle('active', state.pick === 'reference');
  const primary = state.spectrum?.energyScale === 'kinetic' ? 'higher-kinetic-energy' : 'lower-binding-energy';
  byId('plot-help').textContent = {
    peak: 'Click the peak center · Press Esc to cancel',
    doublet: `Click the ${primary} line of the doublet · Press Esc to cancel`,
    reference: 'Click the measured reference peak · Press Esc to cancel',
  }[state.pick] || (state.peaks.length
    ? 'Drag a circle to adjust position and height · Drag a diamond to change FWHM · Drag the plot to zoom'
    : 'Drag to zoom · Click to inspect energy');
}

function renderBackground() {
  const info = byId('background-info');
  const warning = state.background.status !== 'ok';
  const messages = { 'no-peak': 'Linear fallback: Shirley requires a positive peak area.', 'iteration-limit': 'Linear fallback: Shirley did not converge.' };
  info.classList.toggle('warning', warning);
  info.textContent = warning ? messages[state.background.status] : `Analysis points: ${state.section.length.toLocaleString('en-US')}`;
}

function renderFit() {
  const status = byId('fit-status');
  const result = state.result;
  const labels = {
    converged: 'Converged', fixed: 'Evaluated with fixed parameters', 'stalled': 'Optimization stalled',
    'iteration-limit': 'Iteration limit reached', 'insufficient-points': 'Too few points for the free parameters',
    restored: 'Restored fit', manual: 'Manual model',
  };
  const manual = result?.status === 'manual';
  status.classList.toggle('success', !state.fitting && !!result?.converged);
  status.classList.toggle('manual', !state.fitting && manual);
  status.classList.toggle('warning', !state.fitting && !!result && !manual && !result.converged && result.status !== 'restored');
  status.textContent = state.fitting ? 'Fitting…' : result ? labels[result.status] : 'Fit not run';
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
    const [, , min, max] = fields.find(([field]) => field === key);
    const [lower, upper] = peak.bounds?.[key] ?? [min, max];
    if (Number.isFinite(lower)) input.min = lower;
    if (Number.isFinite(upper)) input.max = upper;
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
    cell.textContent = 'Select Add peak or Add doublet, then click a center in the plot.';
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
    name.append(swatch, rowInput(peak, 'label', 'name'));
    const identity = row.insertCell();
    identity.append(name);
    if (peak.doublet) {
      const summary = document.createElement('small');
      summary.className = 'doublet-summary';
      summary.textContent = `${decimal(peak.doublet.separation, 5)} eV · ${decimal(peak.doublet.ratio, 5)}:1`;
      summary.title = 'Doublet separation and primary-to-secondary area ratio';
      identity.append(summary);
    }
    const select = document.createElement('select');
    select.dataset.field = 'shape';
    select.setAttribute('aria-label', `${peak.label} shape`);
    select.replaceChildren(...shapeOptions.map(([value, label]) => new Option(label, value)));
    select.value = peak.shape;
    row.insertCell().append(select);
    for (const [key, label, digits] of peakColumns) {
      const input = rowInput(peak, key, label, digits);
      if (peak.doublet) input.title = key === 'fwhm' ? 'Shared by both lines' : `Primary line ${label.toLowerCase()}`;
      row.insertCell().append(input);
    }
    const area = row.insertCell();
    area.className = 'number';
    area.textContent = displayNumber(peakArea(peak), 2);
    area.title = peak.doublet ? 'Integrated area of both lines' : 'Integral of the full component profile';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [action, glyph, label] of [['constraint', 'sliders', 'Constraints'], ['delete', 'trash', 'Delete']]) {
      const button = document.createElement('button');
      button.className = 'icon-button';
      if (action === 'constraint' && (peak.doublet ||
        Object.values(peak.fixed || {}).some(Boolean) || Object.keys(peak.bounds || {}).length)) {
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

function syncDoubletControls() {
  const enabled = byId('doublet-enabled').checked;
  const options = byId('doublet-options');
  options.hidden = !enabled;
  options.disabled = !enabled;
}

function openConstraints(peak) {
  constraintPeakId = peak.id;
  const rows = byId('constraint-rows');
  rows.replaceChildren();
  byId('peak-dialog-title').textContent = `Constraints for ${peak.label}`;
  const grid = document.createElement('div');
  grid.className = 'constraint-grid';
  for (const value of ['Parameter', 'Value', 'Fixed', 'Lower', 'Upper']) {
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
      ['value', peak[key], 'Value'], ['fixed', peak.fixed?.[key], 'Fixed'],
      ['min', peak.bounds?.[key]?.[0], 'Lower'], ['max', peak.bounds?.[key]?.[1], 'Upper'],
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
  byId('doublet-enabled').checked = Boolean(peak.doublet);
  const doublet = peak.doublet || si2pDoublet;
  byId('doublet-separation').valueAsNumber = doublet.separation;
  byId('doublet-ratio').valueAsNumber = doublet.ratio;
  byId('doublet-separation').setCustomValidity('');
  byId('doublet-ratio').setCustomValidity('');
  syncDoubletControls();
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
      value.setCustomValidity('Enter a value between the lower and upper bounds.');
      value.reportValidity();
      return;
    }
    if (fixed) next.fixed[key] = true;
    if (lower.value !== '' || upper.value !== '') next.bounds[key] = [low, high];
  }
  if (byId('doublet-enabled').checked) {
    const separationInput = byId('doublet-separation');
    const ratioInput = byId('doublet-ratio');
    const separation = separationInput.valueAsNumber;
    const ratio = ratioInput.valueAsNumber;
    const secondary = next.center + (state.spectrum.energyScale === 'kinetic' ? -separation : separation);
    if (!(separation > 0) || !Number.isFinite(secondary) || secondary === next.center) {
      separationInput.setCustomValidity('Enter a positive separation that gives two distinct line centers.');
      separationInput.reportValidity();
      return;
    }
    if (!(ratio > 0) || !Number.isFinite(1 / ratio) || !Number.isFinite(next.height / ratio)) {
      ratioInput.setCustomValidity('Enter a positive area ratio with a finite secondary intensity.');
      ratioInput.reportValidity();
      return;
    }
    next.doublet = { separation, ratio };
  } else {
    delete next.doublet;
  }
  invalidate();
  state.peaks = state.peaks.map((item) => item.id === peak.id ? next : item);
  updateManualModel();
  byId('peak-dialog').close();
  render();
}

function runFit() {
  if (state.fitting || !state.peaks.length) return;
  notice();
  const previous = state.result;
  invalidate();
  state.result = previous;
  state.fitting = true;
  const revision = state.revision;
  const args = [state.section, state.background.values, state.peaks, { energyScale: state.spectrum.energyScale }];
  renderFit();
  renderChart();
  function done(result, error) {
    if (revision !== state.revision) return;
    invalidate();
    if (error) {
      state.result = previous;
      notice('Fit failed. Check the initial centers, FWHMs, heights, and constraints.');
    } else {
      state.result = result;
      state.peaks = result.peaks;
      state.preview = result;
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

const exportFormats = {
  csv: { description: 'Spectrum CSV', extension: '.csv', mime: 'text/csv' },
  plotproject: { description: 'Plot Launcher XPS Fit project', extension: '.plotproject', mime: 'application/json' },
  xpsFitCsv: { description: 'Plot Launcher XPS Fit CSV', extension: '.csv', mime: 'text/csv' },
};

function exportPayload(project, format, name) {
  const { result, spectrum: { energyScale, y, yUnit }, method, peaks } = project;
  const forPlotLauncher = format !== 'csv';
  const model = result ?? (forPlotLauncher && peaks.length ? project.preview : null);
  const originalX = project.original.map((point) => point.x);
  const x = project.points.map((point) => point.x);
  const { values: baseline } = project.background;
  const align = (values) => sparseAligned(values, null, project);
  const corrected = align(project.section.map((point, i) => point.y - baseline[i]));
  const background = method !== 'none' || model ? align(baseline) : undefined;
  const fit = model ? align(model.fit) : undefined;
  const residual = model ? align(model.residuals) : undefined;
  if (forPlotLauncher) {
    const components = (model?.lines ?? []).flatMap((members, i) =>
      members.map((values, member) => ({
        label: lineLabel(peaks[i], member), values: align(values),
        color: darkPeakColors[peaks[i].id % darkPeakColors.length],
      })));
    const data = { name, x, y, energyScale, corrected, originalX, background, fit, residual, components };
    return format === 'plotproject' ? toPlotLauncherProject(data) : toPlotLauncherFitCsv(data);
  }

  const columns = [];
  if (method !== 'none') columns.push({ label: 'Background', values: background });
  columns.push({ label: 'Background-subtracted intensity', values: corrected });
  if (result) {
    columns.push({ label: 'Total fit', values: fit }, { label: 'Residual', values: residual });
    result.components.forEach((values, i) => {
      const prefix = `Peak ${i + 1}`;
      const sanitized = englishExportLabel(peaks[i].label, prefix);
      columns.push({ label: sanitized === prefix ? prefix : `${prefix} - ${sanitized}`, values: align(values) });
      if (peaks[i].doublet) {
        result.lines[i].forEach((line, member) => {
          columns.push({ label: `Doublet ${i + 1} ${lineMember(member)} - ${sanitized}`, values: align(line) });
        });
      }
    });
  }
  const energy = energyScale === 'kinetic' ? 'kinetic' : 'binding';
  columns.push({ label: `Original ${energy} energy (eV)`, values: originalX });
  return spectrumToCsv({
    x, y, yUnit, energyScale, columns,
    analysis: {
      version: 1, method, offset: project.offset, range: project.range,
      peaks, status: result?.status ?? null, iterations: result?.iterations ?? 0,
    },
  });
}

function pickerUnavailable(error) {
  return error?.name === 'SecurityError' || error?.name === 'NotSupportedError';
}

function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function exportData(format) {
  if (!state.spectrum) return;
  const project = { ...state, peaks: state.peaks.map((peak) => ({ ...peak })) };
  const { dataset, spectrum, sourceHandle } = project;
  const stem = englishExportFilename(spectrum.filename || spectrum.name);
  const region = dataset.regions?.length > 1
    ? `-${englishExportFilename(spectrum.name, `region-${Number(byId('region').value) + 1}`)}` : '';
  const suffix = format === 'xpsFitCsv' ? '-xps-fit' : '-xps';
  const name = (stem + region).slice(0, 120 - suffix.length) + suffix;
  const { extension, mime, description } = exportFormats[format];
  const filename = name + extension;

  try {
    let destination;
    if (sourceHandle && typeof window.showSaveFilePicker === 'function') {
      try {
        destination = await window.showSaveFilePicker({
          startIn: sourceHandle,
          suggestedName: filename,
          types: [{ description, accept: { [mime]: [extension] } }],
        });
      } catch (error) {
        if (error?.name === 'AbortError') return;
        if (!pickerUnavailable(error)) throw error;
      }
    }

    const blob = new Blob([exportPayload(project, format, name)], {
      type: extension === '.csv' ? mime + ';charset=utf-8' : mime,
    });
    if (destination) {
      const writer = await destination.createWritable();
      try {
        await writer.write(blob);
        await writer.close();
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
    } else {
      downloadBlob(blob, filename);
    }
    if (state.dataset === dataset) toast(`${description} exported.`);
  } catch (error) {
    if (state.dataset === dataset) notice(error.message || 'Could not export the file.');
  }
}

function choosePeak(x) {
  byId('plot-coordinates').textContent = `${decimal(x, 5)} eV`;
  if (state.pick === 'reference') {
    byId('observed').value = decimal(x - state.offset, 8);
    state.pick = null;
    byId('target').focus();
    renderPick();
  } else if (state.pick === 'peak' || state.pick === 'doublet') {
    if (x < state.range[0] || x > state.range[1]) {
      toast('Pick a position within the analysis range.');
      return;
    }
    invalidate();
    const peak = estimatePeak(state.section, state.background.values, x);
    if (state.pick === 'doublet') {
      peak.doublet = { ...si2pDoublet };
      peak.label = 'Si 2p';
      for (let n = 2; state.peaks.some(({ label }) => label === peak.label); n++) {
        peak.label = `Si 2p ${n}`;
      }
    }
    state.peaks.push(buildPeak(peak));
    state.pick = null;
    updateManualModel();
    render();
  }
}

function setZoom(range) {
  const count = state.points.filter(({ x }) => x >= range[0] && x <= range[1]).length;
  if (count < 2) return;
  state.zoom = range;
  renderChart();
}

function refreshPeakRow(peak) {
  const row = byId('peak-rows').querySelector(`tr[data-id="${peak.id}"]`);
  if (!row) return;
  for (const [key, , digits] of peakColumns) {
    row.querySelector(`[data-field="${key}"]`).value = decimal(peak[key], digits);
  }
  row.querySelector('.number').textContent = displayNumber(peakArea(peak), 2);
}

function previewDraggedPeak(drag, peak) {
  const updated = evaluateFit(state.section, state.background.values, [peak], {
    energyScale: state.spectrum.energyScale,
  });
  const previous = drag.preview.components[drag.index];
  const component = updated.components[0];
  const fit = drag.preview.fit.map((value, i) => value - previous[i] + component[i]);
  const components = drag.preview.components.slice();
  const lines = drag.preview.lines.slice();
  const residuals = fit.map((value, i) => state.section[i].y - value);
  components[drag.index] = component;
  lines[drag.index] = updated.lines[0];
  state.preview = {
    peaks: state.peaks, fit, components, lines, residuals, ...fitStatistics(state.section, residuals),
  };
}

function dragPeakHandle(handle, point, phase) {
  if (phase === 'start') {
    if (state.pick) return;
    const index = state.peaks.findIndex(({ id }) => id === handle.peakId);
    if (index >= 0) {
      peakDrag = {
        handle, index, peak: state.peaks[index], preview: state.preview,
        result: state.result, revision: state.revision, changed: false,
        coordinates: byId('plot-coordinates').textContent,
      };
    }
    return;
  }

  const drag = peakDrag;
  if (!drag || drag.handle.id !== handle.id || drag.revision !== state.revision) {
    if (phase !== 'move') peakDrag = undefined;
    return;
  }
  if (phase === 'cancel') {
    peakDrag = undefined;
    if (drag.changed) {
      state.peaks[drag.index] = drag.peak;
      state.preview = drag.preview;
      state.result = drag.result;
      byId('plot-coordinates').textContent = drag.coordinates;
      refreshPeakRow(drag.peak);
      renderFit();
      renderChart();
    }
    return;
  }

  const atStart = point.x === drag.handle.x && (handle.kind === 'width' || point.y === drag.handle.y);
  const moved = atStart ? drag.peak : movePeakHandle(drag.peak, handle.kind, { ...point, side: handle.side }, state.range, backgroundAt);
  const current = state.peaks[drag.index];
  const changed = moved.center !== current.center || moved.height !== current.height || moved.fwhm !== current.fwhm;
  const previousStatus = state.result?.status;
  const firstChange = changed && !drag.changed;
  if (changed) {
    if (firstChange) {
      invalidate();
      drag.revision = state.revision;
      drag.changed = true;
    }
    state.peaks[drag.index] = moved;
    if (atStart) {
      state.preview = drag.preview;
      state.result = drag.result;
    } else {
      previewDraggedPeak(drag, moved);
      recordManualModel();
    }
    refreshPeakRow(moved);
    byId('plot-coordinates').textContent = atStart ? drag.coordinates : handle.kind === 'width'
      ? `FWHM ${decimal(moved.fwhm, 5)} eV`
      : `Center ${decimal(moved.center, 5)} eV · Height ${displayNumber(moved.height, 4)}`;
    renderFit();
  }
  if (phase === 'end') {
    peakDrag = undefined;
    if (drag.changed) renderChart();
  } else if (changed) {
    renderChart({ updateLegend: previousStatus !== state.result?.status });
  }
}

const drawChart = createSpectrumChart(byId('spectrum'), byId('tooltip'), choosePeak, setZoom, dragPeakHandle);

async function open(readSource, nativePicker = false) {
  const load = ++fileLoad;
  notice();
  try {
    const { file, handle } = await readSource();
    if (!file || load !== fileLoad) return;
    const spectrum = await readSpectrumFile(file);
    if (load === fileLoad) loadDataset(spectrum, handle);
  } catch (error) {
    if (load !== fileLoad || error?.name === 'AbortError') return;
    if (nativePicker && pickerUnavailable(error)) byId('file').click();
    else notice(error.message || 'Could not open the file.');
  }
}

byId('file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) void open(() => ({ file }));
  event.target.value = '';
});
for (const id of ['open-file', 'empty-open-file']) {
  byId(id).addEventListener('click', () => {
    if (typeof window.showOpenFilePicker !== 'function' || typeof window.showSaveFilePicker !== 'function') {
      byId('file').click();
      return;
    }
    void open(async () => {
      const [handle] = await window.showOpenFilePicker({ multiple: false, types: [spectrumFileType] });
      return { file: await handle?.getFile(), handle };
    }, true);
  });
}
byId('new-project').addEventListener('click', resetProject);
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
  renderChart();
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
  state.method = event.target.value;
  refreshAnalysis();
  render();
});
byId('range-form').addEventListener('submit', (event) => {
  event.preventDefault();
  setRange(byId('range-min').valueAsNumber, byId('range-max').valueAsNumber);
});
byId('full-range').addEventListener('click', () => setRange(...rangeOf(state.points)));
byId('fit').addEventListener('click', runFit);
for (const kind of ['peak', 'doublet']) {
  byId(`add-${kind}`).addEventListener('click', () => {
    if (state.peaks.length >= maxPeaks) {
      toast(`Add up to ${maxPeaks} peak components.`);
      return;
    }
    state.pick = state.pick === kind ? null : kind;
    renderPick();
    renderChart();
    if (state.pick && window.innerWidth <= 780) byId('plot').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });
}
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
    toast('Enter a value within the allowed range and constraints.');
    return;
  }
  if (peak[key] === value) return;
  peak[key] = value;
  invalidate();
  updateManualModel();
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
    updateManualModel();
    render();
  }
});
byId('peak-form').addEventListener('submit', applyConstraints);
byId('doublet-enabled').addEventListener('change', syncDoubletControls);
byId('peak-form').addEventListener('input', () => {
  for (const input of byId('peak-form').querySelectorAll('input')) input.setCustomValidity('');
});
byId('export-csv').addEventListener('click', () => exportData('csv'));
byId('export-plot').addEventListener('click', () => exportData('plotproject'));
byId('export-plot-csv').addEventListener('click', () => exportData('xpsFitCsv'));
byId('show-help').addEventListener('click', () => byId('help-dialog').showModal());
const launcherLink = document.createElement('a');
launcherLink.href = PLOT_LAUNCHER_URL;
launcherLink.target = '_blank';
launcherLink.rel = 'noopener noreferrer';
launcherLink.textContent = 'Open Plot Launcher';
byId('help-dialog').querySelector('ol li:last-child').append(' ', launcherLink);
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => byId(button.dataset.close).close());
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.pick) {
    state.pick = null;
    renderPick();
    renderChart();
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
  const file = event.dataTransfer?.files[0];
  if (!file) return;
  event.preventDefault();
  const item = Array.from(event.dataTransfer.items ?? []).find(({ kind }) => kind === 'file');
  void open(async () => {
    let handle;
    try {
      handle = await item?.getAsFileSystemHandle?.();
    } catch {
      // Some browsers provide the dropped file without a local file handle.
    }
    return { file, handle: handle?.kind === 'file' ? handle : null };
  });
});

installNumberInputs();
installUpdateCheck();
resetProject();
