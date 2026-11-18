export const MIN_PEAK_FWHM = 0.000001;

function editableValue(peak, key, target, minimum, maximum) {
  if (peak.fixed?.[key] || !Number.isFinite(target)) return peak[key];
  const bounds = peak.bounds?.[key];
  const lower = Math.max(minimum, bounds?.[0] ?? -Infinity);
  const upper = Math.min(maximum, bounds?.[1] ?? Infinity);
  if (lower > upper) return peak[key];
  const value = Math.min(upper, Math.max(lower, target));
  return Number.isFinite(value) ? value : peak[key];
}

export function movePeakHandle(peak, kind, target, range = [-Infinity, Infinity], baselineAt) {
  if (kind === 'top') {
    const center = editableValue(peak, 'center', target.x, range[0], range[1]);
    const intensity = target.y - (baselineAt?.(center) ?? 0);
    let height = editableValue(peak, 'height', intensity, 0, Infinity);
    if (peak.doublet && !Number.isFinite(height / peak.doublet.ratio)) height = peak.height;
    return center === peak.center && height === peak.height ? peak : { ...peak, center, height };
  }
  if (kind === 'width') {
    const distance = target.x - peak.center;
    // A handle displayed on one side stays on that side when the pointer crosses the center.
    const sided = target.side === -1 || target.side === 1;
    const width = 2 * (sided ? distance * target.side : Math.abs(distance));
    const fwhm = editableValue(peak, 'fwhm', width, MIN_PEAK_FWHM, Infinity);
    return fwhm === peak.fwhm ? peak : { ...peak, fwhm };
  }
  return peak;
}
