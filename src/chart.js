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

function handleKey(handle) {
  return `${handle.id}:${handle.kind}`;
}

function drawHandle(ctx, item, active) {
  const { handle, x, y } = item;
  const radius = active ? 7 : 5;
  ctx.save();
  ctx.beginPath();
  if (handle.kind === 'top') {
    ctx.arc(x, y, radius, 0, Math.PI * 2);
  } else {
    ctx.moveTo(x, y - radius - 1);
    ctx.lineTo(x + radius + 1, y);
    ctx.lineTo(x, y + radius + 1);
    ctx.lineTo(x - radius - 1, y);
    ctx.closePath();
  }
  ctx.globalAlpha = handle.editable === false ? 0.48 : 1;
  ctx.fillStyle = handle.editable === false ? '#111a2e' : handle.color;
  ctx.strokeStyle = active ? '#ffffff' : '#111a2e';
  ctx.lineWidth = active ? 2.25 : 1.5;
  ctx.fill();
  ctx.stroke();
  if (handle.editable === false) {
    ctx.strokeStyle = handle.color;
    ctx.stroke();
  }
  ctx.restore();
}

export function createSpectrumChart(canvas, tooltip, onPick, onZoom, onHandleDrag) {
  const ctx = canvas.getContext('2d');
  const frame = canvas.parentElement;
  const document = canvas.ownerDocument;
  const targets = new Map();
  let model;
  let scales;
  let handles = [];
  let pointer = null;
  let drag = null;
  let pendingHandleCoordinates = null;
  let scheduled = false;

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      try {
        if (pendingHandleCoordinates && drag?.handle) {
          const coordinates = pendingHandleCoordinates;
          pendingHandleCoordinates = null;
          onHandleDrag(drag.handle, coordinates, 'move');
        }
      } finally {
        scheduled = false;
      }
      draw();
    });
  }

  function nearestHandle(position, radius = 13) {
    let nearest;
    let distance = radius ** 2;
    for (const item of handles) {
      if (item.handle.editable === false) continue;
      const candidate = (item.x - position.x) ** 2 + (item.y - position.y) ** 2;
      if (candidate < distance) {
        distance = candidate;
        nearest = item;
      }
    }
    return nearest;
  }

  function syncHandleTargets() {
    const visible = new Set();
    for (const { handle, x, y } of handles) {
      if (handle.editable === false) continue;
      const key = handleKey(handle);
      visible.add(key);
      let button = targets.get(key);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.dataset.peakHandle = key;
        Object.assign(button.style, {
          position: 'absolute', width: '34px', height: '34px', transform: 'translate(-50%, -50%)',
          padding: '0', border: '0', borderRadius: '50%', background: 'transparent',
          touchAction: 'none', cursor: handle.kind === 'width' ? 'ew-resize' : 'grab',
        });
        button.setAttribute('aria-keyshortcuts', handle.kind === 'width'
          ? 'ArrowLeft ArrowRight' : 'ArrowLeft ArrowRight ArrowUp ArrowDown');
        button.addEventListener('focus', schedule);
        button.addEventListener('blur', schedule);
        button.addEventListener('keydown', (event) => {
          const move = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
          const current = model?.handles?.find((handle) => handleKey(handle) === key);
          if (!move || !current || current.editable === false || !scales || drag ||
            (current.kind === 'width' && move[1])) return;
          event.preventDefault();
          const amount = event.shiftKey ? 10 : 2;
          const start = { x: current.x, y: current.y };
          const end = {
            x: move[0] ? start.x + (scales.energyAt(move[0] * amount) - scales.energyAt(0)) : start.x,
            y: move[1] ? start.y + (scales.intensityAt(move[1] * amount) - scales.intensityAt(0)) : start.y,
          };
          onHandleDrag(current, start, 'start');
          onHandleDrag(current, end, 'move');
          onHandleDrag(current, end, 'end');
        });
        targets.set(key, button);
        frame.append(button);
      }
      button.style.left = `${x}px`;
      button.style.top = `${y}px`;
      button.setAttribute('aria-label', handle.label || (handle.kind === 'width' ? 'Adjust peak width' : 'Move peak center and height'));
    }
    for (const [key, button] of targets) {
      if (!visible.has(key)) {
        button.remove();
        targets.delete(key);
      }
    }
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
    const hasResidual = drag?.handle ? drag.scales.hasResidual : Boolean(model.residual);
    const mainBottom = hasResidual ? residualTop - 16 : residualBottom;
    const [xMin, xMax] = model.zoom;
    const span = xMax - xMin;
    const xValue = (value) => left + (model.reverse
      ? (xMax - value) / span : (value - xMin) / span) * (right - left);
    const energyAt = (pixel) => model.reverse ? xMax - span * (pixel - left) / (right - left)
      : xMin + span * (pixel - left) / (right - left);
    function plotWindow(energies) {
      if (!energies?.length || energies[0] > xMax || energies.at(-1) < xMin) return null;
      const first = Math.max(0, lowerBound(energies, xMin) - 1);
      const last = Math.min(energies.length - 1, lowerBound(energies, xMax) + 1);
      const stride = Math.max(1, Math.floor((last - first) / Math.max(800, width * 3)));
      return { x: (i) => xValue(energies[i]), first, last, stride };
    }
    const sharedWindow = plotWindow(model.x);
    const traces = model.series.map((series) => ({
      series, window: series.x ? plotWindow(series.x) : sharedWindow,
    })).filter((trace) => trace.window);
    let yMin = 0;
    let yMax = 0;
    let residualMax = 0;
    for (const { series, window: { first, last } } of traces) {
      // Keep a background-only or all-hidden view on the measured scale.
      if (!series.visible && !series.primary) continue;
      for (let i = first; i <= last; i++) {
        const value = series.values[i];
        if (!Number.isFinite(value)) continue;
        yMin = Math.min(yMin, value);
        yMax = Math.max(yMax, value);
      }
    }
    if (model.residual && sharedWindow) {
      for (let i = sharedWindow.first; i <= sharedWindow.last; i++) {
        if (Number.isFinite(model.residual[i])) {
          residualMax = Math.max(residualMax, Math.abs(model.residual[i]));
        }
      }
    }
    if (drag?.handle) {
      ({ yMin, yMax } = drag.scales);
    } else {
      for (const handle of model.handles || []) {
        if (handle.x < xMin || handle.x > xMax || !Number.isFinite(handle.y)) continue;
        yMin = Math.min(yMin, handle.y);
        yMax = Math.max(yMax, handle.y);
      }
      const yPad = (yMax - yMin || 1) * 0.075;
      yMax += yPad;
      yMin -= yMin < 0 ? yPad : 0;
    }
    residualMax = residualMax * 1.12 || 1;
    const y = (value) => mainBottom - (value - yMin) * (mainBottom - top) / (yMax - yMin);
    const intensityAt = (pixel) => yMin + (mainBottom - pixel) * (yMax - yMin) / (mainBottom - top);
    const residualY = (value) => (residualTop + residualBottom) / 2 - value / residualMax * (residualBottom - residualTop) / 2;
    scales = { left, top, right, bottom: residualBottom, energyAt, intensityAt, yMin, yMax, hasResidual };

    if (model.range && (model.range[0] > xMin || model.range[1] < xMax)) {
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
    const visible = traces.filter(({ series }) => series.visible);
    for (const { series, window: { x, first, last, stride } } of visible) {
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
    visible.sort(({ series: a }, { series: b }) => (a.order ?? 0) - (b.order ?? 0));
    for (const { series, window: { x, first, last, stride } } of visible) {
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
    ctx.setLineDash([]);
    handles = onHandleDrag ? (model.handles || []).map((handle) => ({
      handle, x: xValue(handle.x), y: y(handle.y),
    })).filter(({ x, y }) => x >= left && x <= right && y >= top && y <= mainBottom) : [];
    syncHandleTargets();
    const hovered = pointer && !drag ? nearestHandle(pointer) : null;
    const focused = document.activeElement?.dataset.peakHandle;
    const activeKey = drag?.handle ? handleKey(drag.handle) : hovered ? handleKey(hovered.handle) : focused;
    let activeHandle;
    for (const item of handles) {
      if (handleKey(item.handle) === activeKey) activeHandle = item;
      else drawHandle(ctx, item, false);
    }
    if (activeHandle) drawHandle(ctx, activeHandle, true);
    ctx.restore();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;

    if (model.residual && sharedWindow) {
      const { x, first, last, stride } = sharedWindow;
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
      ctx.fillText('Residual', left - 7, residualY(0));
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

    if (pointer && !drag?.handle && !hovered && pointer.x >= left && pointer.x <= right && pointer.y >= top && pointer.y <= residualBottom) {
      const energy = energyAt(pointer.x);
      let sampleEnergy = energy;
      let sample;
      let label;
      if (model.x) {
        const index = nearestIndex(model.x, energy);
        sampleEnergy = model.x[index];
        sample = model.series.find((series) => series.primary)?.values[index];
      } else if (!drag) {
        let distance = 20 ** 2;
        for (const { series } of visible) {
          const index = nearestIndex(series.x, energy);
          const sampleX = series.x[index];
          const sampleY = series.values[index];
          if (sampleX < xMin || sampleX > xMax || !Number.isFinite(sampleY)) continue;
          const candidate = (xValue(sampleX) - pointer.x) ** 2 + (y(sampleY) - pointer.y) ** 2;
          if (candidate < distance) {
            distance = candidate;
            sampleEnergy = sampleX;
            sample = sampleY;
            label = series.label;
          }
        }
      }
      const at = xValue(sampleEnergy);
      if (drag && Math.abs(pointer.x - drag.x) >= 7) {
        ctx.fillStyle = '#9985ff2f';
        ctx.fillRect(Math.min(drag.x, pointer.x), top, Math.abs(pointer.x - drag.x), residualBottom - top);
      } else {
        ctx.setLineDash([3, 4]);
        line(ctx, at, top, at, residualBottom, palette.hover);
        ctx.setLineDash([]);
      }
      if (Number.isFinite(sample)) {
        tooltip.hidden = false;
        tooltip.textContent = `${label ? `${label} · ` : ''}${formatTick(sampleEnergy)} eV · ${formatTick(sample)}`;
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

  function handleCoordinates(position) {
    const { handle, scales, x, y } = drag;
    return {
      x: handle.x + (scales.energyAt(position.x) - scales.energyAt(x)),
      y: handle.y + (scales.intensityAt(position.y) - scales.intensityAt(y)),
    };
  }

  frame.addEventListener('pointerdown', (event) => {
    if (!scales || drag || event.button !== 0) return;
    const position = point(event);
    const target = nearestHandle(position, event.pointerType === 'touch' ? 17 : 13);
    if (position.x < scales.left || position.x > scales.right ||
      position.y < scales.top || position.y > scales.bottom) {
      if (!target) return;
    }
    drag = { ...position, pointerId: event.pointerId };
    pointer = position;
    if (target) {
      drag.handle = target.handle;
      drag.scales = scales;
      canvas.style.cursor = target.handle.kind === 'width' ? 'ew-resize' : 'grabbing';
      onHandleDrag(drag.handle, handleCoordinates(position), 'start');
    }
    canvas.setPointerCapture(event.pointerId);
    schedule();
  });
  frame.addEventListener('pointermove', (event) => {
    if (!model || (drag && drag.pointerId !== event.pointerId)) return;
    pointer = point(event);
    if (drag?.handle) {
      pendingHandleCoordinates = handleCoordinates(pointer);
    } else if (drag) {
      pointer.x = Math.min(scales.right, Math.max(scales.left, pointer.x));
    }
    schedule();
  });
  frame.addEventListener('pointerup', (event) => {
    if (!drag || !scales || drag.pointerId !== event.pointerId) return;
    if (drag.handle) {
      const handle = drag.handle;
      const coordinates = handleCoordinates(point(event));
      drag = null;
      pendingHandleCoordinates = null;
      canvas.style.cursor = '';
      onHandleDrag(handle, coordinates, 'end');
    } else {
      const to = Math.min(scales.right, Math.max(scales.left, point(event).x));
      if (Math.abs(to - drag.x) >= 7) {
        onZoom([scales.energyAt(drag.x), scales.energyAt(to)].sort((a, b) => a - b));
      } else if (model.x) {
        onPick(model.x[nearestIndex(model.x, scales.energyAt(to))]);
      }
      drag = null;
    }
    pointer = null;
    schedule();
  });
  frame.addEventListener('pointerleave', () => {
    if (!drag) pointer = null;
    schedule();
  });
  function cancelDrag(pointerId) {
    if (!drag || drag.pointerId !== pointerId) return;
    const handle = drag.handle;
    drag = null;
    pendingHandleCoordinates = null;
    pointer = null;
    if (canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
    if (handle) {
      canvas.style.cursor = '';
      onHandleDrag(handle, { x: handle.x, y: handle.y }, 'cancel');
    }
    schedule();
  }
  for (const name of ['pointercancel', 'lostpointercapture']) {
    frame.addEventListener(name, (event) => cancelDrag(event.pointerId));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && drag?.handle) cancelDrag(drag.pointerId);
  });
  new ResizeObserver(schedule).observe(canvas);
  return (nextModel) => {
    model = nextModel;
    if (!model?.handles?.length) {
      handles = [];
      syncHandleTargets();
    }
    if (!model) {
      const pointerId = drag?.pointerId;
      scales = null;
      pointer = null;
      drag = null;
      pendingHandleCoordinates = null;
      canvas.style.cursor = '';
      if (pointerId != null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      tooltip.hidden = true;
      tooltip.textContent = '';
      if (ctx) {
        ctx.resetTransform();
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
      return;
    }
    schedule();
  };
}
