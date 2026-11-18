import assert from 'node:assert/strict';
import test from 'node:test';
import { MIN_PEAK_FWHM, movePeakHandle } from '../src/peak-handles.js';
import { peakLines } from '../src/xps.js';

const peak = { id: 1, center: 100, height: 40, fwhm: 0.75, mix: 0.3, shape: 'pseudo-voigt' };

test('a top drag clamps the center to the analysis range and the height to zero', () => {
  const moved = movePeakHandle(peak, 'top', { x: 98, y: -5 }, [99, 102]);
  assert.deepEqual(moved, { ...peak, center: 99, height: 0 });
  assert.equal(peak.center, 100);
  assert.equal(peak.height, 40);
});

test('a top drag respects fixed parameters and custom bounds', () => {
  const constrained = { ...peak, fixed: { center: true }, bounds: { height: [10, 50] } };
  assert.equal(movePeakHandle(constrained, 'top', { x: 101, y: 80 }, [99, 102]).height, 50);
  assert.equal(movePeakHandle(constrained, 'top', { x: 101, y: 40 }, [99, 102]), constrained);

  const bounded = { ...peak, bounds: { center: [99.5, 101.5] }, fixed: { height: true } };
  assert.deepEqual(movePeakHandle(bounded, 'top', { x: 98, y: 70 }, [99, 102]), { ...bounded, center: 99.5 });
});

test('a top drag measures height above the baseline at the permitted center', () => {
  const baselineAt = (x) => 5 * (x - 98);
  const bounded = { ...peak, bounds: { center: [99, 101] } };
  assert.deepEqual(
    movePeakHandle(bounded, 'top', { x: 102, y: 55 }, [98, 103], baselineAt),
    { ...bounded, center: 101, height: 40 },
  );
  const fixed = { ...peak, fixed: { center: true } };
  assert.equal(movePeakHandle(fixed, 'top', { x: 102, y: 30 }, [98, 103], baselineAt).height, 20);
});

test('half-height drags set twice the horizontal distance and obey width constraints', () => {
  assert.equal(movePeakHandle(peak, 'width', { x: 100.75 }).fwhm, 1.5);
  assert.equal(movePeakHandle(peak, 'width', { x: 99.25, side: -1 }).fwhm, 1.5);
  assert.equal(movePeakHandle(peak, 'width', { x: 99.25, side: 1 }).fwhm, MIN_PEAK_FWHM);

  const bounded = { ...peak, bounds: { fwhm: [0.5, 1] } };
  assert.equal(movePeakHandle(bounded, 'width', { x: 101 }).fwhm, 1);
  assert.equal(movePeakHandle(bounded, 'width', { x: 100 }).fwhm, 0.5);
  const fixed = { ...peak, fixed: { fwhm: true } };
  assert.equal(movePeakHandle(fixed, 'width', { x: 101 }), fixed);
});

test('dragging a doublet preserves its separation, ratio, shape, and common width', () => {
  const doublet = { ...peak, doublet: { separation: 0.606, ratio: 2 } };
  const moved = movePeakHandle(doublet, 'top', { x: 101, y: 80 }, [98, 104]);
  const resized = movePeakHandle(moved, 'width', { x: 101.75, side: 1 });
  const [primary, secondary] = peakLines(resized);
  assert.equal(resized.doublet, doublet.doublet);
  assert.equal(secondary.center, primary.center + 0.606);
  assert.equal(primary.height / secondary.height, 2);
  assert.equal(primary.fwhm, 1.5);
  assert.equal(secondary.fwhm, 1.5);
  assert.equal(primary.shape, secondary.shape);
});
