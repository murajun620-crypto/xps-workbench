const numberSelector = 'input[type="number"]';

function increment(input, base) {
  const field = input.dataset.field || /^constraint-([^-]+)-/.exec(input.id)?.[1];
  if (field === 'height') {
    const magnitude = Math.abs(base);
    return magnitude > 0 ? 10 ** (Math.floor(Math.log10(magnitude)) - 2) : 1;
  }
  return field === 'mix' ? 1 : 0.01;
}

function startValue(input) {
  if (Number.isFinite(input.valueAsNumber)) return input.valueAsNumber;
  const constraint = /^(constraint-[^-]+)-(?:min|max)$/.exec(input.id);
  if (constraint) {
    const value = input.ownerDocument.getElementById(`${constraint[1]}-value`)?.valueAsNumber;
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function adjust(input, direction) {
  if (input.matches(':disabled') || input.readOnly) return;
  const previous = input.value;
  const customIncrement = Number(input.dataset.increment);
  if (!(customIncrement > 0) && input.step && input.step !== 'any') {
    if (direction > 0) input.stepUp();
    else input.stepDown();
  } else {
    const value = startValue(input);
    const step = customIncrement > 0 && Number.isFinite(customIncrement) ? customIncrement : increment(input, value);
    const next = value + direction * step;
    if (!Number.isFinite(next) || next === value) return;
    const limits = [input.min, input.max].map((limit, index) =>
      limit !== '' && Number.isFinite(Number(limit)) ? Number(limit) : index === 0 ? -Infinity : Infinity);
    // Round floating-point addition noise before checking the exact limits.
    const bounded = Math.max(limits[0], Math.min(limits[1], Number(next.toPrecision(15))));
    input.valueAsNumber = bounded;
  }
  if (input.value === previous) return;
  const Event = input.ownerDocument.defaultView.Event;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function enhance(input) {
  if (input.parentElement?.classList.contains('number-input')) return;
  const document = input.ownerDocument;
  const label = input.getAttribute('aria-label') ||
    [...(input.labels || [])].map((item) => item.textContent.trim()).join(' ') || 'value';
  const field = document.createElement('div');
  field.className = 'number-input';
  const controls = document.createElement('div');
  controls.className = 'number-input-controls';
  for (const [action, direction] of [['Increase', 1], ['Decrease', -1]]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = `number-input-${action.toLowerCase()}`;
    button.title = `${action} ${label}`;
    button.setAttribute('aria-label', button.title);
    if (input.id) button.setAttribute('aria-controls', input.id);
    // Leave the text caret or mobile keyboard in its current state when clicking the controls.
    button.addEventListener('pointerdown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      adjust(input, direction);
    });
    controls.append(button);
  }
  input.replaceWith(field);
  field.append(input, controls);
  input.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || event.isComposing) return;
    event.preventDefault();
    adjust(input, event.key === 'ArrowUp' ? 1 : -1);
  });
}

export function installNumberInputs(root = document) {
  function inspect(node) {
    if (node.matches?.(numberSelector)) enhance(node);
    node.querySelectorAll?.(numberSelector).forEach(enhance);
  }
  inspect(root);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) inspect(node);
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  return () => observer.disconnect();
}
