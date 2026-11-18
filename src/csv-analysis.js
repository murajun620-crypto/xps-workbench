import { englishExportLabel } from './export-labels.js';

export const ANALYSIS_METADATA_COLUMN = 'XPS Workbench Metadata';
const METADATA_VERSION = 1;
const MAX_METADATA_CHARS = 32_000;
const MAX_PEAKS = 12;
const methods = new Set(['none', 'linear', 'shirley']);
const shapes = new Set(['gaussian', 'lorentzian', 'pseudo-voigt']);
const statuses = new Set(['converged', 'fixed', 'stalled', 'iteration-limit', 'insufficient-points', 'restored']);
const parameters = ['center', 'fwhm', 'height', 'mix'];

function peakMetadata(peak, index, sanitizeLabel) {
  if (!peak || !shapes.has(peak.shape) || !parameters.every((key) => Number.isFinite(peak[key])) ||
    peak.fwhm <= 0 || peak.height < 0 || peak.mix < 0 || peak.mix > 1) return null;
  const doublet = peak.doublet;
  if (doublet !== undefined && (!Number.isFinite(doublet?.separation) || doublet.separation <= 0 ||
    !Number.isFinite(doublet.ratio) || doublet.ratio <= 0 || !Number.isFinite(1 / doublet.ratio) ||
    !Number.isFinite(peak.height / doublet.ratio))) return null;
  const fixed = {};
  const bounds = {};
  for (const key of parameters) {
    if (peak.fixed?.[key] === true) fixed[key] = true;
    const limits = peak.bounds?.[key];
    if (limits === undefined) continue;
    if (!Array.isArray(limits) || limits.length !== 2) return null;
    const [min, max] = limits;
    const lower = min === -Infinity ? null : min;
    const upper = max === Infinity ? null : max;
    if ((lower !== null && !Number.isFinite(lower)) || (upper !== null && !Number.isFinite(upper)) ||
      (lower !== null && upper !== null && lower > upper)) return null;
    if (lower !== null || upper !== null) bounds[key] = [lower, upper];
  }
  const fallback = `Peak ${index + 1}`;
  const text = typeof peak.label === 'string' ? peak.label.slice(0, 200) : fallback;
  return {
    id: Number.isSafeInteger(peak.id) && peak.id >= 0 && peak.id <= Number.MAX_SAFE_INTEGER - MAX_PEAKS
      ? peak.id : index,
    label: (sanitizeLabel ? englishExportLabel(text, fallback) : text.trim() || fallback),
    shape: peak.shape,
    center: peak.center,
    fwhm: peak.fwhm,
    height: peak.height,
    mix: peak.mix,
    ...(doublet ? { doublet: { separation: doublet.separation, ratio: doublet.ratio } } : {}),
    ...(Object.keys(fixed).length ? { fixed } : {}),
    ...(Object.keys(bounds).length ? { bounds } : {}),
  };
}

function validatedMetadata(value, sanitizeLabel = false) {
  if (!value || value.version !== METADATA_VERSION || !methods.has(value.method) || !Number.isFinite(value.offset) ||
    !Array.isArray(value.range) || value.range.length !== 2 || !value.range.every(Number.isFinite) ||
    value.range[0] >= value.range[1] || !Array.isArray(value.peaks) || value.peaks.length > MAX_PEAKS) return null;
  const peaks = Array.from(value.peaks, (peak, index) => peakMetadata(peak, index, sanitizeLabel));
  if (peaks.includes(null)) return null;
  if (new Set(peaks.map(({ id }) => id)).size !== peaks.length) {
    peaks.forEach((peak, index) => { peak.id = index; });
  }
  return {
    version: METADATA_VERSION,
    method: value.method,
    offset: value.offset,
    range: value.range.slice(),
    peaks,
    status: statuses.has(value.status) ? value.status : null,
    iterations: Number.isSafeInteger(value.iterations) && value.iterations >= 0 ? value.iterations : null,
  };
}

export function serializeCsvAnalysis(analysis) {
  const normalized = validatedMetadata(analysis, true);
  return normalized ? JSON.stringify(normalized) : '';
}

export function findCsvAnalysisColumns(fields) {
  const names = fields.map((value) => value.normalize('NFKC').replace(/\s+/g, ' ').trim());
  const first = (pattern) => names.findIndex((name) => pattern.test(name));
  const metadata = first(/^xps workbench metadata$/i);
  const originalX = first(/^(?:original (?:binding |kinetic )?energy|補正前エネルギー)(?:\s*\(eV\))?$/i);
  const background = first(/^(?:background|バックグラウンド)$/i);
  const fit = first(/^(?:total fit|合成フィット)$/i);
  const residual = first(/^(?:residual|残差)$/i);
  const corrected = first(/^(?:background[- ]subtracted intensity|背景減算後)$/i);
  const components = [];
  names.forEach((name, column) => {
    const match = /^(?:Peak|成分)\s*(\d+)(?:\s+-\s+|\s+|$)(.*)$/i.exec(name);
    const number = Number(match?.[1]);
    if (number >= 1 && number <= MAX_PEAKS && !components.some((component) => component.number === number)) {
      components.push({ column, number, label: match[2] || `Peak ${number}` });
    }
  });
  components.sort((a, b) => a.number - b.number);
  if (metadata < 0 && (originalX < 0 || (background < 0 && fit < 0 && corrected < 0 && components.length === 0))) {
    return null;
  }
  return { metadata, originalX, background, fit, residual, corrected, components };
}

export function readCsvAnalysis(columns, pairs, asNumber) {
  function values(column) {
    if (column < 0) return null;
    return pairs.map(([, , row]) => {
      const value = asNumber(row[column]);
      return Number.isFinite(value) ? value : null;
    });
  }

  let metadata = null;
  if (columns.metadata >= 0) {
    const row = pairs.find(([, , fields]) => fields[columns.metadata]);
    const cell = row?.[2][columns.metadata];
    if (cell && cell.length <= MAX_METADATA_CHARS) {
      try {
        metadata = validatedMetadata(JSON.parse(cell));
      } catch {
        // Keep the numeric spectra and curves when metadata has been edited or removed.
      }
    }
  }
  const originalX = values(columns.originalX);
  return {
    metadata,
    originalX: originalX?.every((value, i) => Number.isFinite(value) && (i === 0 || value > originalX[i - 1]))
      ? originalX : null,
    background: values(columns.background),
    fit: values(columns.fit),
    residual: values(columns.residual),
    corrected: values(columns.corrected),
    components: columns.components.map(({ column, label }) => ({ label, values: values(column) })),
  };
}
