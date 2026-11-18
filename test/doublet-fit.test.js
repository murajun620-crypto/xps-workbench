import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPeaks, peakArea, peakLines } from '../src/xps.js';

const doublets = [
  {
    center: 100.55, fwhm: 0.74, height: 290, mix: 0.24, shape: 'pseudo-voigt',
    doublet: { separation: 0.606, ratio: 2 },
  },
  {
    center: 103.10, fwhm: 1.05, height: 64, mix: 0, shape: 'gaussian',
    doublet: { separation: 0.825, ratio: 0.5 },
  },
];

function profile(x, center, { fwhm, mix }) {
  const squared = ((x - center) / (fwhm / 2)) ** 2;
  return (1 - mix) * 2 ** -squared + mix / (1 + squared);
}

function spectrum(groups, direction) {
  const x = Array.from({ length: 201 }, (_, i) => 103 + direction * (i * 0.05 - 6));
  const background = x.map((energy) => 5 + energy * 0.1);
  const points = x.map((energy, i) => ({
    x: energy,
    y: background[i] + groups.reduce((sum, group) => {
      const { center, height, doublet: { separation, ratio } } = group;
      return sum + height * profile(energy, center, group) +
        (height / ratio) * profile(energy, center + direction * separation, group);
    }, 0),
  }));
  return { points, background };
}

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) < tolerance, `Expected ${actual} to be near ${expected}`);
}

for (const [energyScale, direction] of [['binding', 1], ['kinetic', -1]]) {
  test(`fits multiple linked doublets on a ${energyScale} energy scale`, () => {
    const groups = doublets.map((group) => ({
      ...group,
      center: 103 + direction * (group.center - 103),
    }));
    const { points, background } = spectrum(groups, direction);
    const initial = groups.map((group) => ({
      ...group, center: group.center + 0.14, fwhm: group.fwhm * 0.84, height: group.height * 0.9, mix: 0.38,
    }));
    const result = fitPeaks(points, background, initial, { energyScale });
    assert.equal(result.converged, true);
    assert.ok(result.rmse < 1e-5);

    result.peaks.forEach((group, index) => {
      const target = groups[index];
      near(group.center, target.center);
      near(group.fwhm, target.fwhm);
      near(group.height, target.height, 1e-5);
      near(group.mix, target.mix);
      assert.deepEqual(group.doublet, target.doublet);
      const [primary, secondary] = peakLines(group, { energyScale });
      near(secondary.center - primary.center, direction * target.doublet.separation);
      assert.equal(primary.fwhm, secondary.fwhm);
      near(peakArea(primary) / peakArea(secondary), target.doublet.ratio);
      near(peakArea(group), peakArea(primary) + peakArea(secondary));
      const [primaryCurve, secondaryCurve] = result.lines[index];
      result.components[index].forEach((y, i) => assert.equal(y, primaryCurve[i] + secondaryCurve[i]));
    });
  });
}

test('a fixed primary center and bounded width apply to the entire doublet', () => {
  const target = doublets[0];
  const { points, background } = spectrum([target], 1);
  const [group] = fitPeaks(points, background, [{
    ...target, fwhm: 0.78, height: 200, fixed: { center: true }, bounds: { fwhm: [0.7, 0.8] },
  }]).peaks;
  const [primary, secondary] = peakLines(group);
  assert.equal(primary.center, target.center);
  near(secondary.center, target.center + target.doublet.separation);
  near(primary.fwhm, target.fwhm);
  assert.equal(primary.fwhm, secondary.fwhm);
});
