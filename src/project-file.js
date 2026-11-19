const FORMAT = 'xps-workbench-project';
const VERSION = 1;
export const MAX_PROJECT_BYTES = 256 * 1024 * 1024;
const MAX_PEAKS = 12;
const PARAMETERS = ['center', 'fwhm', 'height', 'mix'];
const SHAPES = ['pseudo-voigt', 'gaussian', 'lorentzian'];
const METHODS = ['none', 'linear', 'shirley'];
const BACKGROUND_STATUSES = ['ok', 'no-peak', 'iteration-limit'];
const FIT_STATUSES = ['converged', 'fixed', 'stalled', 'iteration-limit', 'insufficient-points', 'restored', 'manual'];

function requireValue(condition, field) {
  if (!condition) throw new Error(`Invalid XPS Workbench project: ${field}.`);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCounter(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function numbers(values, length, field) {
  requireValue(Array.isArray(values) && values.length === length, field);
  for (const value of values) requireValue(Number.isFinite(value), field);
  return values;
}

function strings(values, field) {
  requireValue(Array.isArray(values), field);
  for (const value of values) requireValue(typeof value === 'string', field);
  return values;
}

function span(pair, field) {
  numbers(pair, 2, field);
  requireValue(pair[0] < pair[1] && Number.isFinite(pair[1] - pair[0]), field);
  return pair;
}

function energies(values, length, field) {
  numbers(values, length, field);
  requireValue(Number.isFinite(values.at(-1) - values[0]), field);
  for (let i = 1; i < values.length; i++) requireValue(values[i] > values[i - 1], field);
  return values;
}

function bound(value, infinity, encode, field) {
  if (value === null || (encode && value === infinity)) return encode ? null : infinity;
  requireValue(Number.isFinite(value), field);
  return value;
}

function peakData(peak, energyScale, encode, field) {
  requireValue(isRecord(peak) && isCounter(peak.id) && typeof peak.label === 'string' &&
    SHAPES.includes(peak.shape) && PARAMETERS.every((key) => Number.isFinite(peak[key])) &&
    peak.fwhm > 0 && peak.height >= 0 && peak.mix >= 0 && peak.mix <= 1, field);
  const { id, label, shape, center, fwhm, height, mix } = peak;
  const normalized = { id, label, shape, center, fwhm, height, mix };
  if (peak.doublet !== undefined) {
    requireValue(isRecord(peak.doublet), `${field} doublet`);
    const { separation, ratio } = peak.doublet;
    const secondary = center + (energyScale === 'kinetic' ? -separation : separation);
    requireValue(Number.isFinite(separation) && separation > 0 && Number.isFinite(secondary) && secondary !== center &&
      Number.isFinite(ratio) && ratio > 0 && Number.isFinite(1 / ratio) && Number.isFinite(height / ratio),
    `${field} doublet`);
    normalized.doublet = { separation, ratio };
  }
  if (peak.fixed !== undefined) {
    requireValue(isRecord(peak.fixed), `${field} fixed parameter flags`);
    normalized.fixed = {};
    for (const key of PARAMETERS) {
      if (peak.fixed[key] === undefined) continue;
      requireValue(typeof peak.fixed[key] === 'boolean', `${field} fixed ${key} flag`);
      normalized.fixed[key] = peak.fixed[key];
    }
  }
  if (peak.bounds !== undefined) {
    requireValue(isRecord(peak.bounds), `${field} parameter bounds`);
    normalized.bounds = {};
    for (const key of PARAMETERS) {
      const limits = peak.bounds[key];
      if (limits === undefined) continue;
      const boundField = `${field} ${key} bounds`;
      requireValue(Array.isArray(limits) && limits.length === 2, boundField);
      const low = bound(limits[0], -Infinity, encode, boundField);
      const high = bound(limits[1], Infinity, encode, boundField);
      requireValue((low ?? -Infinity) <= (high ?? Infinity), boundField);
      normalized.bounds[key] = [low, high];
    }
  }
  return normalized;
}

function resultData(result, peaks, length, field) {
  if (result === null) return null;
  requireValue(isRecord(result) && peaks.length > 0 && FIT_STATUSES.includes(result.status) &&
    isCounter(result.iterations) && typeof result.converged === 'boolean', field);
  const { status, iterations, converged, fit, components, lines, residuals } = result;
  numbers(fit, length, `${field} curve`);
  numbers(residuals, length, `${field} residuals`);
  requireValue(Array.isArray(components) && components.length === peaks.length &&
    Array.isArray(lines) && lines.length === peaks.length, `${field} peak curves`);
  for (const [i, peak] of peaks.entries()) {
    numbers(components[i], length, `${field} peak ${i + 1} curve`);
    requireValue(Array.isArray(lines[i]) && lines[i].length === (peak.doublet ? 2 : 1), `${field} peak ${i + 1} lines`);
    for (const line of lines[i]) numbers(line, length, `${field} peak ${i + 1} line`);
  }
  return { status, iterations, converged, fit, components, lines, residuals };
}

function analysisData(analysis, { x, energyScale }, encode, field) {
  if (analysis === null) return null;
  requireValue(isRecord(analysis), `${field} analysis`);
  const { offset, range, zoom, method, view, shiftMode, nextId, reference = ['', ''], disabledSeries = [] } = analysis;
  requireValue(Number.isFinite(offset) && METHODS.includes(method) &&
    ['raw', 'corrected'].includes(view) && ['direct', 'reference'].includes(shiftMode), `${field} analysis settings`);
  span(range, `${field} analysis range`);
  span(zoom, `${field} zoom range`);
  const shiftedX = analysis.shiftedX;
  const shifted = energies(shiftedX ?? x.map((value) => value + offset), x.length, `${field} shifted energies`);
  let sectionLength = 0;
  for (const value of shifted) {
    if (value >= range[0] && value <= range[1]) sectionLength++;
  }
  requireValue(sectionLength >= 3, `${field} analysis range must contain at least three points`);
  requireValue(Array.isArray(analysis.peaks) && analysis.peaks.length <= MAX_PEAKS && isCounter(nextId) &&
    nextId < Number.MAX_SAFE_INTEGER, `${field} peaks`);
  const peaks = Array.from(analysis.peaks, (peak, i) => peakData(peak, energyScale, encode, `${field} peak ${i + 1}`));
  requireValue(new Set(peaks.map(({ id }) => id)).size === peaks.length && peaks.every(({ id }) => id < nextId), `${field} peak IDs`);
  strings(reference, `${field} reference inputs`);
  requireValue(reference.length === 2, `${field} reference inputs`);
  strings(disabledSeries, `${field} hidden plot series`);
  const background = analysis.background;
  requireValue(isRecord(background) && BACKGROUND_STATUSES.includes(background.status) && isCounter(background.iterations),
    `${field} background`);
  numbers(background.values, sectionLength, `${field} background values`);
  return {
    offset, range, zoom, method, view, shiftMode, peaks, nextId, reference, disabledSeries,
    background: { values: background.values, status: background.status, iterations: background.iterations },
    result: resultData(analysis.result, peaks, sectionLength, `${field} fit result`),
    ...(shiftedX == null ? {} : { shiftedX }),
  };
}

function spectrumData(spectrum, index, encode) {
  const field = `spectrum ${index + 1}`;
  requireValue(isRecord(spectrum), field);
  const { name, filename, energyScale, yUnit, x, y, sourceEnergy } = spectrum;
  requireValue(typeof name === 'string' && typeof filename === 'string' && typeof yUnit === 'string' &&
    ['binding', 'kinetic'].includes(energyScale), `${field} metadata`);
  requireValue(Array.isArray(x) && x.length >= 3, `${field} measurements`);
  energies(x, x.length, `${field} original energies`);
  numbers(y, x.length, `${field} intensities`);
  requireValue(sourceEnergy === undefined || (Number.isFinite(sourceEnergy) && sourceEnergy > 0), `${field} source energy`);
  return {
    name, filename, energyScale, yUnit, x, y,
    ...(sourceEnergy === undefined ? {} : { sourceEnergy }),
    analysis: analysisData(spectrum.analysis, spectrum, encode, field),
  };
}

function projectData(project, encode) {
  requireValue(isRecord(project), 'project data');
  const { name, filename, activeIndex, chartScope, overlayZoom = null, overlayHidden = [], spectra } = project;
  requireValue(typeof name === 'string' && typeof filename === 'string', 'project name and filename');
  requireValue(Array.isArray(spectra) && spectra.length > 0, 'spectra');
  requireValue(isCounter(activeIndex) && activeIndex < spectra.length, 'active spectrum index');
  requireValue(chartScope === 'single' || (chartScope === 'all' && spectra.length > 1), 'chart scope');
  if (overlayZoom !== null) span(overlayZoom, 'overlay zoom range');
  strings(overlayHidden, 'hidden overlay spectra');
  return {
    format: FORMAT, version: VERSION, name, filename, activeIndex, chartScope, overlayZoom, overlayHidden,
    spectra: Array.from(spectra, (spectrum, index) => spectrumData(spectrum, index, encode)),
  };
}

export function serializeProjectFile(project) {
  return JSON.stringify(projectData(project, true));
}

export function parseProjectFile(text) {
  let project;
  try {
    project = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Could not read the XPS Workbench project. Check that the file is valid JSON.');
  }
  if (project?.format !== FORMAT) throw new Error('Choose an XPS Workbench project file.');
  if (project.version !== VERSION) throw new Error('This XPS Workbench project version is unsupported.');
  return projectData(project, false);
}
