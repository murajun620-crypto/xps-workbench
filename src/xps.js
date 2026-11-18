const LOG_TWO = Math.log(2);
const GAUSSIAN_AREA = Math.sqrt(Math.PI / LOG_TWO) / 2;
const LORENTZIAN_AREA = Math.PI / 2;
const DEFAULT_MIX = 0.35;
const PARAMETERS = ['center', 'fwhm', 'height', 'mix'];
const PRIMARY_LINE = { offset: 0, weight: 1 };
const SINGLE_LINE = [PRIMARY_LINE];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function validateSpectrum(points) {
  if (!points.length || !points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))) {
    throw new RangeError('A spectrum must contain finite energies and intensities.');
  }
  if (!Number.isFinite(points.at(-1).x - points[0].x)) throw new RangeError('The spectrum energy span is too large.');
  const ascending = points[0].x < points.at(-1).x;
  for (let index = 1; index < points.length; index += 1) {
    const step = points[index].x - points[index - 1].x;
    if (!Number.isFinite(step) || (ascending ? step <= 0 : step >= 0)) {
      throw new RangeError('Spectrum energies must be distinct and sorted.');
    }
  }
  return ascending;
}

export function shiftSpectrum(points, offset) {
  if (!Number.isFinite(offset)) throw new RangeError('The energy offset must be finite.');
  const shifted = points.map((point) => ({ ...point, x: point.x + offset }));
  if (shifted.length) validateSpectrum(shifted);
  return shifted;
}

export function computeBackground(points, method = 'shirley', options) {
  return analyzeBackground(points, method, options).values;
}

// Background values always use the supplied order of the spectrum points.
export function analyzeBackground(points, method = 'shirley', { energyScale = 'binding' } = {}) {
  if (points.length === 0 || method === 'none') {
    return { values: points.map(() => 0), status: 'ok', iterations: 0 };
  }
  const ascending = validateSpectrum(points);
  const first = points[0];
  const last = points.at(-1);
  const energySpan = last.x - first.x;
  const linear = points.map(({ x }) => {
    const fraction = energySpan === 0 ? 0 : (x - first.x) / energySpan;
    return (1 - fraction) * first.y + fraction * last.y;
  });

  if (method === 'linear') return { values: linear, status: 'ok', iterations: 0 };
  if (method !== 'shirley') throw new RangeError(`Unknown background method: ${method}`);
  if (energyScale !== 'binding' && energyScale !== 'kinetic') {
    throw new RangeError(`Unknown energy scale: ${energyScale}`);
  }
  if (points.length < 3 || first.y === last.y) {
    return { values: linear, status: 'ok', iterations: 0 };
  }

  // The inelastic step accumulates from high kinetic energy (low binding energy).
  const reverse = ascending === (energyScale === 'kinetic');
  const ordered = reverse ? points.slice().reverse() : points;
  const start = ordered[0].y;
  const change = ordered.at(-1).y - start;
  const span = Math.abs(energySpan);
  const length = points.length;
  const signal = new Float64Array(length);
  const widths = new Float64Array(length);
  let intensityScale = Math.abs(change);
  for (let index = 0; index < length; index += 1) {
    signal[index] = ordered[index].y - start;
    intensityScale = Math.max(intensityScale, Math.abs(signal[index]));
    if (index > 0) widths[index] = Math.abs(ordered[index].x - ordered[index - 1].x) / span;
  }

  const limit = 120;
  const tolerance = 1e-8 * intensityScale;
  const areaTolerance = 1e-12 * intensityScale;
  const baseline = Float64Array.from(ordered, ({ x }) => change * (Math.abs(x - ordered[0].x) / span));
  const integral = new Float64Array(length);
  baseline[length - 1] = change;

  for (let iteration = 1; iteration <= limit; iteration += 1) {
    let previous = signal[0] - baseline[0];
    let cumulative = 0;
    for (let index = 1; index < length; index += 1) {
      const net = signal[index] - baseline[index];
      cumulative += (previous + net) * 0.5 * widths[index];
      integral[index] = cumulative;
      previous = net;
    }
    if (!Number.isFinite(cumulative) || cumulative <= areaTolerance) {
      return { values: linear, status: 'no-peak', iterations: iteration };
    }

    let difference = 0;
    for (let index = 1; index < length - 1; index += 1) {
      const next = change * (integral[index] / cumulative);
      const adjustment = next - baseline[index];
      difference = Math.max(difference, Math.abs(adjustment));
      baseline[index] += 0.65 * adjustment;
    }
    if (difference <= tolerance) {
      const values = Array.from(baseline, (value) => start + value);
      values[length - 1] = ordered.at(-1).y;
      return { values: reverse ? values.reverse() : values, status: 'ok', iterations: iteration };
    }
  }

  return { values: linear, status: 'iteration-limit', iterations: limit };
}

function fraction(peak) {
  if (peak.shape === 'gaussian') return 0;
  if (peak.shape === 'lorentzian') return 1;
  return peak.mix ?? DEFAULT_MIX;
}

function lineValue(x, peak) {
  const mix = fraction(peak);
  const distance = 2 * (x - peak.center) / peak.fwhm;
  const square = distance * distance;
  return peak.height * ((1 - mix) * Math.exp(-LOG_TWO * square) + mix / (1 + square));
}

function doubletSpec(peak) {
  if (peak.doublet == null) return null;
  const { separation, ratio } = peak.doublet;
  if (!Number.isFinite(separation) || separation <= 0 ||
      !Number.isFinite(ratio) || ratio <= 0 || !Number.isFinite(1 / ratio)) {
    throw new RangeError('Doublet separation and primary-to-secondary area ratio must be finite and positive.');
  }
  return peak.doublet;
}

function doubletOffset(separation, energyScale) {
  if (energyScale === 'binding') return separation;
  if (energyScale === 'kinetic') return -separation;
  throw new RangeError(`Unknown energy scale: ${energyScale}`);
}

// The primary line is at the lower binding energy, including when plotted on a kinetic-energy axis.
export function peakLines(peak, { energyScale = 'binding' } = {}) {
  const doublet = doubletSpec(peak);
  if (!doublet) return [peak];
  const { doublet: _, ...primary } = peak;
  const center = primary.center + doubletOffset(doublet.separation, energyScale);
  if (!Number.isFinite(center) || center === primary.center) {
    throw new RangeError('The doublet must have two distinct, finite peak centers.');
  }
  // Shared width and line shape make the height ratio equal to the integrated area ratio.
  const height = primary.height / doublet.ratio;
  if (!Number.isFinite(height)) throw new RangeError('The doublet line heights must be finite.');
  return [primary, { ...primary, center, height }];
}

export function peakValue(x, peak, options) {
  if (peak.doublet == null) return lineValue(x, peak);
  return peakLines(peak, options).reduce((sum, line) => sum + lineValue(x, line), 0);
}

// The analytical area includes the full tails of the model.
export function peakArea(peak) {
  const mix = fraction(peak);
  const area = peak.height * peak.fwhm * ((1 - mix) * GAUSSIAN_AREA + mix * LORENTZIAN_AREA);
  const doublet = doubletSpec(peak);
  return doublet ? area + area / doublet.ratio : area;
}

function halfHeightCrossing(points, net, peakIndex, direction, halfHeight) {
  if (net[peakIndex] <= halfHeight) return null;
  for (let index = peakIndex + direction; index >= 0 && index < points.length; index += direction) {
    if (net[index] <= halfHeight) {
      const previous = index - direction;
      const fraction = (net[previous] - halfHeight) / (net[previous] - net[index]);
      return points[previous].x + fraction * (points[index].x - points[previous].x);
    }
  }
  return null;
}

export function estimatePeak(points, background, center) {
  validateSpectrum(points);
  const net = points.map(({ y }, index) => y - (background?.[index] ?? 0));
  const hasCenter = Number.isFinite(center);
  let peakIndex = 0;
  let largest = 0;
  for (let index = 0; index < points.length; index += 1) {
    const better = hasCenter
      ? Math.abs(points[index].x - center) < Math.abs(points[peakIndex].x - center)
      : net[index] > net[peakIndex];
    if (better) peakIndex = index;
    largest = Math.max(largest, net[index]);
  }
  const firstX = points[0].x;
  const lastX = points.at(-1).x;
  const span = Math.abs(firstX - lastX);
  const height = Math.max(net[peakIndex], largest * 0.015, Number.EPSILON);
  const left = halfHeightCrossing(points, net, peakIndex, -1, height / 2);
  const right = halfHeightCrossing(points, net, peakIndex, 1, height / 2);
  const width = left !== null && right !== null ? Math.abs(left - right) : span / 12;
  return {
    center: hasCenter ? clamp(center, Math.min(firstX, lastX), Math.max(firstX, lastX)) : points[peakIndex].x,
    fwhm: Math.max(width, span / Math.max(1, points.length - 1), Number.EPSILON),
    height,
    mix: DEFAULT_MIX,
    shape: 'pseudo-voigt',
  };
}

export function fitStatistics(points, residuals) {
  let squaredError = 0;
  let mean = 0;
  let variation = 0;
  for (let index = 0; index < points.length; index += 1) {
    const delta = points[index].y - mean;
    mean += delta / (index + 1);
    variation += delta * (points[index].y - mean);
    squaredError += residuals[index] * residuals[index];
  }
  return {
    rmse: points.length ? Math.sqrt(squaredError / points.length) : null,
    rSquared: variation > 0 ? 1 - squaredError / variation : null,
  };
}

export function evaluateFit(points, background, peaks, options) {
  const lines = peaks.map((peak) => peakLines(peak, options).map((line) =>
    points.map(({ x }) => lineValue(x, line))));
  const components = lines.map(([primary, secondary]) => secondary
    ? primary.map((value, index) => value + secondary[index])
    : primary);
  const fit = points.map((_, index) => components.reduce(
    (sum, component) => sum + component[index], background[index],
  ));
  const residuals = points.map(({ y }, index) => y - fit[index]);
  return { peaks, components, lines, fit, residuals, ...fitStatistics(points, residuals) };
}

function parameterize(peaks, minimum, span, intensityScale, sampleSpacing, energyScale) {
  const defaultBounds = {
    center: [minimum, minimum + span],
    fwhm: [Math.max(sampleSpacing * 0.1, span * 1e-8), Infinity],
    height: [0, Infinity],
    mix: [0, 1],
  };
  const physicalBounds = {
    center: [-Infinity, Infinity],
    fwhm: [span * 1e-12, Infinity],
    height: [0, Infinity],
    mix: [0, 1],
  };
  const scales = { center: span, fwhm: span, mix: 1 };
  const variables = [];
  const models = peaks.map((peak, peakIndex) => {
    const doublet = doubletSpec(peak);
    const primaryWeight = doublet ? Math.min(1, doublet.ratio) : 1;
    const model = { indexes: [], lines: SINGLE_LINE, heightScale: intensityScale * primaryWeight };
    if (doublet) {
      const offset = doubletOffset(doublet.separation, energyScale) / span;
      if (!Number.isFinite(offset) || offset === 0) {
        throw new RangeError(`Peak ${peakIndex + 1} has an unresolvable doublet separation.`);
      }
      // Scale the fitted height by the stronger line to keep both profile weights bounded.
      model.lines = [{ offset: 0, weight: primaryWeight }, { offset, weight: primaryWeight / doublet.ratio }];
    }
    for (const [parameterIndex, key] of PARAMETERS.entries()) {
      const offset = key === 'center' ? minimum : 0;
      const scale = key === 'height' ? model.heightScale : scales[key];
      const value = key === 'mix' ? fraction(peak) : peak[key];
      const pureShape = key === 'mix' && (peak.shape === 'gaussian' || peak.shape === 'lorentzian');
      const locked = pureShape || Boolean(peak.fixed?.[key]);
      const bounds = pureShape ? physicalBounds[key] : peak.bounds?.[key];
      const [minimumValue, maximumValue] = physicalBounds[key];
      const [defaultLower, defaultUpper] = locked ? physicalBounds[key] : defaultBounds[key];
      const lower = Math.max(bounds?.[0] ?? defaultLower, minimumValue);
      const upper = Math.min(bounds?.[1] ?? defaultUpper, maximumValue);
      const normalized = (clamp(value, lower, upper) - offset) / scale;
      if (!Number.isFinite(value) || !Number.isFinite(normalized) || lower > upper ||
          (locked && (value < lower || value > upper))) {
        throw new RangeError(`Peak ${peakIndex + 1} has an invalid ${key} or conflicting bounds.`);
      }
      model[key] = normalized;
      model.indexes[parameterIndex] = -1;
      if (!locked && lower < upper) {
        model.indexes[parameterIndex] = variables.length;
        variables.push({ peakIndex, key, lower: (lower - offset) / scale, upper: (upper - offset) / scale });
      }
    }
    return model;
  });
  return { models, variables };
}

function fitSystem(energies, net, models, variableCount, derivatives) {
  const jacobianRow = derivatives ? new Float64Array(variableCount) : null;
  const hessian = derivatives ? Array.from({ length: variableCount }, () => new Float64Array(variableCount)) : null;
  const gradient = derivatives ? new Float64Array(variableCount) : null;
  let cost = 0;

  for (let index = 0; index < energies.length; index += 1) {
    let value = 0;
    for (const model of models) {
      const position = energies[index] - model.center;
      const gaussianFraction = 1 - model.mix;
      let shape = 0;
      let centerSlope = 0;
      let widthSlope = 0;
      let mixSlope = 0;
      for (const { offset, weight } of model.lines) {
        const distance = 2 * (position - offset) / model.fwhm;
        const square = distance * distance;
        if (!Number.isFinite(square)) continue;
        const gaussian = Math.exp(-LOG_TWO * square);
        const lorentzian = 1 / (1 + square);
        shape += weight * (gaussianFraction * gaussian + model.mix * lorentzian);
        if (derivatives) {
          const slope = -2 * distance * (gaussianFraction * LOG_TWO * gaussian + model.mix * lorentzian * lorentzian);
          centerSlope += weight * slope;
          widthSlope += weight * distance * slope;
          mixSlope += weight * (lorentzian - gaussian);
        }
      }
      value += model.height * shape;
      if (derivatives) {
        const [center, fwhm, height, mix] = model.indexes;
        if (center >= 0) jacobianRow[center] = -2 * model.height * centerSlope / model.fwhm;
        if (fwhm >= 0) jacobianRow[fwhm] = -model.height * widthSlope / model.fwhm;
        if (height >= 0) jacobianRow[height] = shape;
        if (mix >= 0) jacobianRow[mix] = model.height * mixSlope;
      }
    }
    const residual = net[index] - value;
    cost += residual * residual;
    if (derivatives) {
      for (let row = 0; row < variableCount; row += 1) {
        const derivative = jacobianRow[row];
        gradient[row] += derivative * residual;
        for (let column = 0; column <= row; column += 1) {
          hessian[row][column] += derivative * jacobianRow[column];
        }
      }
    }
  }
  return { cost, hessian, gradient };
}

function solveDamped(hessian, gradient, free, damping) {
  const size = free.length;
  const matrix = Array.from({ length: size }, () => new Float64Array(size));
  const rhs = new Float64Array(size);
  const diagonal = free.map((index) => Math.sqrt(Math.max(hessian[index][index], 1e-20)));

  // Cholesky factorization of the damped normal equations in scaled coordinates.
  for (let row = 0; row < size; row += 1) {
    const originalRow = free[row];
    let value = gradient[originalRow] / diagonal[row];
    for (let column = 0; column <= row; column += 1) {
      const originalColumn = free[column];
      let element = hessian[originalRow][originalColumn] / (diagonal[row] * diagonal[column]);
      if (row === column) element += damping;
      for (let previous = 0; previous < column; previous += 1) {
        element -= matrix[row][previous] * matrix[column][previous];
      }
      if (row === column) {
        if (!(element > 0) || !Number.isFinite(element)) return null;
        matrix[row][column] = Math.sqrt(element);
      } else {
        matrix[row][column] = element / matrix[column][column];
        value -= matrix[row][column] * rhs[column];
      }
    }
    rhs[row] = value / matrix[row][row];
  }

  const step = new Float64Array(gradient.length);
  for (let row = size - 1; row >= 0; row -= 1) {
    let value = rhs[row];
    for (let column = row + 1; column < size; column += 1) {
      value -= matrix[column][row] * rhs[column];
    }
    rhs[row] = value / matrix[row][row];
    step[free[row]] = rhs[row] / diagonal[row];
  }
  return step;
}

// Bounded least squares on the measured intensity after subtraction of the selected background.
export function fitPeaks(points, background, peaks, { maxIterations = 180, energyScale = 'binding' } = {}) {
  validateSpectrum(points);
  if (points.length < 2 || background.length !== points.length || !background.every(Number.isFinite)) {
    throw new RangeError('Fit requires at least two points and one finite background value per point.');
  }
  if (peaks.length === 0) throw new RangeError('Fit requires at least one peak.');
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new RangeError('Invalid fit iteration limit.');

  const minimum = Math.min(points[0].x, points.at(-1).x);
  const span = Math.abs(points[0].x - points.at(-1).x);
  const energies = Float64Array.from(points, ({ x }) => (x - minimum) / span);
  const net = Float64Array.from(points, ({ y }, index) => y - background[index]);
  let intensityScale = 0;
  for (const value of net) intensityScale = Math.max(intensityScale, Math.abs(value));
  if (intensityScale === 0) {
    for (const peak of peaks) {
      const height = Math.abs(peak.height);
      const doublet = doubletSpec(peak);
      intensityScale = Math.max(intensityScale, height, doublet ? height / doublet.ratio : 0);
    }
  }
  if (intensityScale === 0) intensityScale = 1;
  if (!Number.isFinite(intensityScale)) throw new RangeError('Fit requires finite intensities and peak parameters.');
  for (let index = 0; index < net.length; index += 1) net[index] /= intensityScale;

  let sampleSpacing = span;
  for (let index = 1; index < points.length; index += 1) {
    sampleSpacing = Math.min(sampleSpacing, Math.abs(points[index].x - points[index - 1].x));
  }
  const parameterization = parameterize(peaks, minimum, span, intensityScale, sampleSpacing, energyScale);
  let models = parameterization.models;
  const variables = parameterization.variables;
  const count = variables.length;
  let status = count === 0 ? 'fixed' : count > points.length ? 'insufficient-points' : 'iteration-limit';
  let iterations = 0;
  let damping = 1e-3;
  let system;

  while (status === 'iteration-limit' && iterations < maxIterations) {
    system ??= fitSystem(energies, net, models, count, true);
    const { cost, hessian, gradient } = system;
    const free = [];
    let projectedGradient = 0;
    for (let index = 0; index < count; index += 1) {
      const { peakIndex, key, lower, upper } = variables[index];
      const value = models[peakIndex][key];
      const slope = gradient[index];
      if ((value <= lower && slope <= 0) || (value >= upper && slope >= 0)) continue;
      free.push(index);
      projectedGradient = Math.max(projectedGradient, Math.abs(slope) / Math.sqrt(Math.max(hessian[index][index], 1e-20)));
    }
    if (cost <= 1e-24 * points.length || projectedGradient <= 1e-8 * Math.max(1, Math.sqrt(cost))) {
      status = 'converged';
      break;
    }

    iterations += 1;
    const step = solveDamped(hessian, gradient, free, damping);
    if (step) {
      const candidate = models.map((model) => ({ ...model }));
      let stepSize = 0;
      for (let index = 0; index < count; index += 1) {
        const { peakIndex, key, lower, upper } = variables[index];
        const value = models[peakIndex][key];
        const next = clamp(value + step[index], lower, upper);
        candidate[peakIndex][key] = next;
        stepSize = Math.max(stepSize, Math.abs(next - value) / Math.max(1, Math.abs(value)));
      }
      const trialCost = fitSystem(energies, net, candidate, count, false).cost;
      if (trialCost < cost) {
        models = candidate;
        system = null;
        damping = Math.max(1e-10, damping / 3);
        if (damping < 1 && stepSize < 1e-6 && cost - trialCost < 1e-9 * cost) status = 'converged';
        continue;
      }
    }
    damping *= 6;
    if (damping > 1e12) status = 'stalled';
  }

  const fittedPeaks = peaks.map((peak, index) => {
    const model = models[index];
    return {
      ...peak,
      center: peak.fixed?.center ? peak.center : minimum + span * model.center,
      fwhm: peak.fixed?.fwhm ? peak.fwhm : span * model.fwhm,
      height: peak.fixed?.height ? peak.height : model.heightScale * model.height,
      mix: model.mix,
    };
  });
  return {
    ...evaluateFit(points, background, fittedPeaks, { energyScale }),
    iterations,
    converged: status === 'converged' || status === 'fixed',
    status,
  };
}
