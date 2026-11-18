import { estimatePeak, fitPeaks } from './xps.js';

const MAX_WIDE_SAMPLES = 1024;
const APEX_NEIGHBORS = 128;
const PURE_MIX_TOLERANCE = 1e-7;

function energyOf(point) {
  return typeof point === 'number' ? point : point?.x;
}

export function restorePeakFromCurve(points, values) {
  if (!points.length || points.length !== values.length) {
    throw new RangeError('A saved peak needs one intensity per energy.');
  }
  let last = -Infinity;
  let apex = 0;
  for (let index = 0; index < points.length; index++) {
    const energy = energyOf(points[index]);
    if (!Number.isFinite(energy) || energy <= last || !Number.isFinite(values[index])) {
      throw new RangeError('A saved peak needs finite intensities and ascending energies.');
    }
    if (values[index] > values[apex]) apex = index;
    last = energy;
  }

  const first = energyOf(points[0]);
  const span = last - first;
  if (!Number.isFinite(span)) throw new RangeError('The saved peak energy span is too large.');
  const height = Math.max(0, values[apex]);
  if (height === 0) {
    return {
      center: first + span / 2, fwhm: Math.max(span / 12, 1e-6),
      height: 0, mix: 0.35, shape: 'pseudo-voigt',
    };
  }

  // Keep the peak apex and its neighborhood when reopening large exports.
  const curve = [];
  const stride = Math.ceil(points.length / MAX_WIDE_SAMPLES);
  for (let index = 0; index < points.length; index++) {
    if (index % stride === 0 || Math.abs(apex - index) <= APEX_NEIGHBORS || index === points.length - 1) {
      curve.push({ x: energyOf(points[index]), y: Math.max(0, values[index]) / height });
    }
  }
  const background = new Float64Array(curve.length);
  const estimate = estimatePeak(curve, background);
  if (curve.length < 4) return { ...estimate, height };

  // A truncated analysis can contain only one side of a previously fixed peak.
  const atEdge = apex === 0 || apex === points.length - 1;
  const initial = atEdge ? { ...estimate, bounds: { center: [first - span, last + span] } } : estimate;
  const { peaks: [{ center, fwhm, height: fittedHeight, mix }] } =
    fitPeaks(curve, background, [initial], { maxIterations: 60 });
  const fitted = { center, fwhm, height: fittedHeight * height, mix, shape: estimate.shape };
  if (fitted.mix <= PURE_MIX_TOLERANCE) {
    return { ...fitted, mix: 0, shape: 'gaussian' };
  }
  if (fitted.mix >= 1 - PURE_MIX_TOLERANCE) {
    return { ...fitted, mix: 1, shape: 'lorentzian' };
  }
  return fitted;
}
