import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseProjectFile, serializeProjectFile } from '../src/project-file.js';
import { evaluateFit } from '../src/xps.js';

function example() {
  const x = [99, 100, 101, 102, 103];
  const y = [2, 12, 24, 8, 3];
  const shiftedX = [99.4, 100.3, 101.4, 102.4, 103.4];
  const peaks = [{
    id: 4, label: 'Si 2p <酸化物>', center: 101.4, fwhm: 0.8, height: 21, mix: 0.35, shape: 'pseudo-voigt',
    doublet: { separation: 0.606, ratio: 2 },
    fixed: { mix: true },
    bounds: { center: [-Infinity, 102], height: [0, Infinity] },
  }];
  const values = [1.75, 2, 2.5];
  const section = shiftedX.slice(1, 4).map((x, i) => ({ x, y: y[i + 1] }));
  const { components, lines, fit, residuals } = evaluateFit(section, values, peaks, { energyScale: 'binding' });
  return {
    name: 'SiC analysis', filename: 'measurements.xlsx', activeIndex: 1,
    chartScope: 'all', overlayZoom: [100, 105], overlayHidden: ['spectrum-0'],
    spectra: [
      { name: 'Si 2p', filename: 'measurements.xlsx', energyScale: 'binding', yUnit: 'counts', x, y,
        analysis: {
          offset: 0.4, range: [100.3, 102.4], zoom: [99.3999999, 103.4], shiftedX, method: 'shirley',
          view: 'corrected', shiftMode: 'reference', reference: ['101', '101.4'],
          disabledSeries: ['p4'], peaks, nextId: 8, background: { values, status: 'ok', iterations: 4 },
          result: { status: 'manual', iterations: 0, converged: false, components, lines, fit, residuals },
        },
      },
      { name: 'C 1s', filename: 'measurements.xlsx', energyScale: 'kinetic', yUnit: 'cps', x: [200, 201, 203],
        y: [5, 10, 7], sourceEnergy: 1486.6, analysis: null },
    ],
  };
}

test('round-trips multiple spectra, a calibrated grid, model curves, and analysis controls', () => {
  const project = example();
  const json = serializeProjectFile(project);
  const disk = JSON.parse(json);
  assert.deepEqual(disk.spectra[0].analysis.peaks[0].bounds, { center: [null, 102], height: [0, null] });
  const { format, version, ...restored } = parseProjectFile(`\uFEFF${json}`);
  assert.equal(format, 'xps-workbench-project');
  assert.equal(version, 1);
  assert.deepEqual(restored, project);
});

test('allows an unsolved model and derives the shifted grid when an exact shifted grid is unnecessary', () => {
  const project = example();
  const analysis = project.spectra[0].analysis;
  delete analysis.shiftedX;
  analysis.range = [100.4, 102.4];
  analysis.result = null;
  const restored = parseProjectFile(serializeProjectFile(project)).spectra[0].analysis;
  assert.equal(restored.shiftedX, undefined);
  assert.equal(restored.result, null);
});

test('rejects invalid project types, versions, bounds, grids, and section-aligned results', () => {
  assert.throws(() => parseProjectFile('{'), /valid JSON/);
  assert.throws(() => parseProjectFile('{"format":"plotlauncher"}'), /Choose an XPS Workbench project/);
  const valid = serializeProjectFile(example());
  const change = (mutate, message) => {
    const disk = JSON.parse(valid);
    mutate(disk, disk.spectra[0], disk.spectra[0].analysis);
    assert.throws(() => parseProjectFile(JSON.stringify(disk)), message);
  };
  change((disk) => { disk.version = 2; }, /version is unsupported/);
  change((disk) => { disk.activeIndex = 2; }, /active spectrum index/);
  change((_, spectrum) => { spectrum.x = [99, 100, 101, 101, 103]; }, /original energies/);
  change((_, __, analysis) => { analysis.range = [100.3, 101.4]; }, /at least three points/);
  change((_, __, analysis) => { analysis.result.fit.pop(); }, /fit result curve/);
  change((_, __, analysis) => { analysis.peaks[0].bounds.height = [2, 1]; }, /height bounds/);
  change((_, __, analysis) => { analysis.peaks[0].doublet.separation = 1e-30; }, /peak 1 doublet/);
});

test('returns only the specified project, spectrum, and analysis fields', () => {
  const disk = JSON.parse(serializeProjectFile(example()));
  disk.externalSource = 'outside.xlsx';
  disk.spectra[0].sourceHandle = { name: 'outside.xlsx' };
  disk.spectra[0].analysis.fitting = true;
  const restored = parseProjectFile(JSON.stringify(disk));
  assert.equal(restored.externalSource, undefined);
  assert.equal(restored.spectra[0].sourceHandle, undefined);
  assert.equal(restored.spectra[0].analysis.fitting, undefined);
});
