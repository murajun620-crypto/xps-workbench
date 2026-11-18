const palette = {
  tick: "#a9b6d4",
  axis: "#516080",
  grid: "#2a3653",
  range: "#947fff",
  hover: "#7e8caf",
  zero: "#586989",
  residual: "#9cb3ff",
};
const mono = '12px ui-monospace, Consolas, monospace';
const sans = '12px "Segoe UI", Meiryo, sans-serif';

function axisTicks(min, max, count) {
  const size = (max - min) / Math.max(count, 1);
  const magnitude = 10 ** Math.floor(Math.log10(size));
  const ratio = size / magnitude;
  const step = (ratio <= 1 ? 1 : ratio <= 2 ? 2 : ratio <= 2.5 ? 2.5 : ratio <= 5 ? 5 : 10) * magnitude;
  const ticks = [];
  for (let i = Math.ceil(min / step - 1e-9); i <= Math.floor(max / step + 1e-9) && ticks.length < 30; i++) {
    ticks.push(i * step);
  }
  return ticks;
}

function formatTick(value) {
  if (value === 0) return '0';
  const magnitude = Math.abs(value);
  if (magnitude >= 1e6 || magnitude < 0.00001) {
    return value.toExponential(1);
  }
  return Number(value.toPrecision(9)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function line(ctx, x1, y1, x2, y2, color) {
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function lowerBound(values, target) {
  let first = 0;
  let last = values.length;
  while (first < last) {
    const middle = (first + last) >>> 1;
    if (values[middle] < target) first = middle + 1;
    else last = middle;
  }
  return first;
}

function nearestIndex(values, target) {
  const i = lowerBound(values, target);
  if (!i || i === values.length) return Math.min(i, values.length - 1);
  return values[i] - target < target - values[i - 1] ? i : i - 1;
}

function path(ctx, values, x, y, first, last, stride) {
  let started = false;
  for (let i = first; i <= last; i = Math.min(i + stride, last)) {
    if (Number.isFinite(values[i])) {
      if (started) ctx.lineTo(x(i), y(values[i]));
      else ctx.moveTo(x(i), y(values[i]));
      started = true;
    } else {
      started = false;
    }
    if (i === last) break;
  }
}

export function createSpectrumChart(canvas, tooltip, onPick, onZoom) {
  const ctx = canvas.getContext('2d');
  let model;
  let scales;
  let pointer = null;
  let drag = null;
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      draw();
    });
  }

  function draw() {
    if (!model || !ctx) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const left = width < 430 ? 64 : 73;
    const right = width - 15;
    const top = 14;
    const residualBottom = height - 51;
    const residualTop = residualBottom - 54;
    const mainBottom = model.residual ? residualTop - 16 : residualBottom;
    const [xMin, xMax] = model.zoom;
    const span = xMax - xMin;
    const xValue = (value) => left + (model.reverse
      ? (xMax - value) / span : (value - xMin) / span) * (right - left);
    const energyAt = (pixel) => model.reverse ? xMax - span * (pixel - left) / (right - left)
      : xMin + span * (pixel - left) / (right - left);
    const x = (i) => xValue(model.x[i]);
    const first = Math.max(0, lowerBound(model.x, xMin) - 1);
    const last = Math.min(model.x.length - 1, lowerBound(model.x, xMax) + 1);
    const stride = Math.max(1, Math.floor((last - first) / Math.max(800, width * 3)));
    let yMin = 0;
    let yMax = 0;
    let residualMax = 0;
    for (let i = first; i <= last; i++) {
      for (const series of model.series) {
        // Keep a background-only or all-hidden view on the measured scale.
        if (!series.visible && !series.primary) continue;
        const value = series.values[i];
        if (!Number.isFinite(value)) continue;
        yMin = Math.min(yMin, value);
        yMax = Math.max(yMax, value);
      }
      if (Number.isFinite(model.residual?.[i])) {
        residualMax = Math.max(residualMax, Math.abs(model.residual[i]));
      }
    }
    const yPad = (yMax - yMin || 1) * 0.075;
    yMax += yPad;
    yMin -= yMin < 0 ? yPad : 0;
    residualMax = residualMax * 1.12 || 1;
    const y = (value) => mainBottom - (value - yMin) * (mainBottom - top) / (yMax - yMin);
    const residualY = (value) => (residualTop + residualBottom) / 2 - value / residualMax * (residualBottom - residualTop) / 2;
    scales = { left, top, right, bottom: residualBottom, energyAt };

    if (model.range[0] > xMin || model.range[1] < xMax) {
      const [rangeLeft, rangeRight] = model.range.map(xValue).sort((a, b) => a - b);
      const visibleLeft = Math.max(left, Math.min(right, rangeLeft));
      const visibleRight = Math.max(left, Math.min(right, rangeRight));
      ctx.fillStyle = '#080f2166';
      ctx.fillRect(left, top, visibleLeft - left, mainBottom - top);
      ctx.fillRect(visibleRight, top, right - visibleRight, mainBottom - top);
      for (const limit of [rangeLeft, rangeRight]) {
        if (limit > left && limit < right) {
          ctx.setLineDash([4, 4]);
          line(ctx, limit, top, limit, mainBottom, palette.range);
          ctx.setLineDash([]);
        }
      }
    }

    ctx.font = mono;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    if (model.residual) {
      ctx.fillStyle = '#17213a';
      ctx.fillRect(left, residualTop, right - left, residualBottom - residualTop);
    }
    for (const tick of axisTicks(yMin, yMax, (mainBottom - top) / 39)) {
      const at = y(tick);
      line(ctx, left, at, right, at, palette.grid);
      ctx.fillStyle = palette.tick;
      ctx.fillText(formatTick(tick), left - 7, at);
    }
    ctx.textAlign = 'center';
    for (const tick of axisTicks(xMin, xMax, (right - left) / (width < 430 ? 65 : 82))) {
      const at = xValue(tick);
      line(ctx, at, top, at, mainBottom, palette.grid);
      if (model.residual) line(ctx, at, residualTop, at, residualBottom, palette.grid);
      ctx.fillStyle = palette.tick;
      ctx.fillText(formatTick(tick), at, residualBottom + 15);
    }
    line(ctx, left, top, left, mainBottom, palette.axis);
    line(ctx, left, mainBottom, right, mainBottom, palette.axis);

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, mainBottom - top);
    ctx.clip();
    const visible = model.series.filter((series) => series.visible);
    for (const series of visible) {
      if (!series.base) continue;
      ctx.beginPath();
      path(ctx, series.values, x, y, Math.max(first, series.start), Math.min(last, series.end), stride);
      const low = Math.max(first, series.start);
      const high = Math.min(last, series.end);
      if (low > high) continue;
      for (let i = high; i >= low; i = Math.max(low, i - stride)) {
        ctx.lineTo(x(i), y(series.base[i]));
        if (i === low) break;
      }
      ctx.closePath();
      ctx.fillStyle = series.color + '30';
      ctx.fill();
    }
    for (const series of visible.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
      ctx.strokeStyle = series.color;
      ctx.fillStyle = series.color;
      ctx.lineWidth = series.width ?? 1.5;
      if (series.marker) {
        const dots = Math.max(1, Math.floor((last - first) / Math.max(1, (right - left) * 0.97)));
        ctx.globalAlpha = series.alpha ?? 0.86;
        ctx.beginPath();
        for (let i = first; i <= last; i += dots) {
          if (!Number.isFinite(series.values[i])) continue;
          const xx = x(i);
          const yy = y(series.values[i]);
          ctx.moveTo(xx + 1.7, yy);
          ctx.arc(xx, yy, 1.7, 0, Math.PI * 2);
        }
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.setLineDash(series.dash ? [6, 5] : []);
        ctx.beginPath();
        path(ctx, series.values, x, y, first, last, stride);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    if (model.residual) {
      line(ctx, left, residualY(0), right, residualY(0), palette.zero);
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, residualTop, right - left, residualBottom - residualTop);
      ctx.clip();
      ctx.strokeStyle = palette.residual;
      ctx.beginPath();
      path(ctx, model.residual, x, residualY, first, last, stride);
      ctx.stroke();
      ctx.restore();
      ctx.font = sans;
      ctx.textAlign = 'right';
      ctx.fillStyle = palette.tick;
      ctx.fillText('残差', left - 7, residualY(0));
      ctx.font = mono;
      const limit = axisTicks(0, residualMax, 2).at(-1);
      if (limit > 0) {
        ctx.fillText(`+${formatTick(limit)}`, left - 7, Math.max(residualTop + 5, residualY(limit)));
        ctx.fillText(`−${formatTick(limit)}`, left - 7, Math.min(residualBottom - 5, residualY(-limit)));
      }
    }

    ctx.font = sans;
    ctx.fillStyle = palette.tick;
    ctx.textAlign = 'center';
    ctx.fillText(model.xLabel, (left + right) / 2, height - 12);
    ctx.save();
    ctx.translate(12, (top + mainBottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(model.yLabel, 0, 0);
    ctx.restore();

    if (pointer && pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= residualBottom) {
      const index = nearestIndex(model.x, energyAt(pointer.x));
      const at = x(index);
      if (drag && Math.abs(pointer.x - drag.x) >= 7) {
        ctx.fillStyle = '#9985ff2f';
        ctx.fillRect(Math.min(drag.x, pointer.x), top, Math.abs(pointer.x - drag.x), residualBottom - top);
      } else {
        ctx.setLineDash([3, 4]);
        line(ctx, at, top, at, residualBottom, palette.hover);
        ctx.setLineDash([]);
      }
      const sample = model.series.find((series) => series.primary)?.values[index];
      if (Number.isFinite(sample)) {
        tooltip.hidden = false;
        tooltip.textContent = `${formatTick(model.x[index])} eV · ${formatTick(sample)}`;
        tooltip.style.left = `${Math.max(4, Math.min(at + 10, width - tooltip.offsetWidth - 5))}px`;
        tooltip.style.top = `${Math.max(7, pointer.y - 32)}px`;
        return;
      }
    }
    tooltip.hidden = true;
  }

  function point(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  canvas.addEventListener('pointerdown', (event) => {
    if (!scales || event.button !== 0) return;
    const position = point(event);
    if (position.x < scales.left || position.x > scales.right ||
      position.y < scales.top || position.y > scales.bottom) return;
    drag = position;
    pointer = position;
    canvas.setPointerCapture(event.pointerId);
    schedule();
  });
  canvas.addEventListener('pointermove', (event) => {
    pointer = point(event);
    if (drag) pointer.x = Math.min(scales.right, Math.max(scales.left, pointer.x));
    schedule();
  });
  canvas.addEventListener('pointerup', (event) => {
    if (!drag || !scales) return;
    const { x } = point(event);
    const to = Math.min(scales.right, Math.max(scales.left, x));
    if (Math.abs(to - drag.x) >= 7) {
      onZoom([scales.energyAt(drag.x), scales.energyAt(to)].sort((a, b) => a - b));
    } else {
      onPick(model.x[nearestIndex(model.x, scales.energyAt(to))]);
    }
    drag = null;
    pointer = null;
    schedule();
  });
  for (const name of ['pointerleave', 'pointercancel']) {
    canvas.addEventListener(name, () => {
      if (name === 'pointercancel') drag = null;
      if (!drag) pointer = null;
      schedule();
    });
  }
  new ResizeObserver(schedule).observe(canvas);
  return (nextModel) => {
    model = nextModel;
    schedule();
  };
}
