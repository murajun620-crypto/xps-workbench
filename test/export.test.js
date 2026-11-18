import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSpectrum, spectrumToCsv } from '../src/data.js';
import { toPlotLauncherProject } from '../src/plot-launcher.js';

const spectrum = {
  x: [100, 101, 102],
  y: [3, 8, 4],
  originalX: [100.5, 101.5, 102.5],
  residual: [-1, 3, 0],
  background: [2, 2, 3],
  corrected: [1, 6, 1],
  fit: [4, 5, 4],
  components: [{ label: '酸化物', values: [2, 3, 1], color: '#704dd9' }],
};
const nonAscii = /[^\x09\x0a\x0d\x20-\x7e]/;

function readProject(options) {
  const text = toPlotLauncherProject(options);
  assert.doesNotMatch(text, nonAscii);
  const project = JSON.parse(text);
  const csv = new TextDecoder().decode(Uint8Array.from(atob(project.data.base64), char => char.charCodeAt(0)));
  assert.doesNotMatch(csv, nonAscii);
  return { project, rows: csv.trimEnd().split('\r\n').map(line => line.split(',')) };
}

test('Plot Launcher XPS Fit uses the native fixed columns and net peak curves', () => {
  const { project, rows } = readProject({ ...spectrum, name: '測定.xlsx', yUnit: '計数' });
  assert.equal(project.settings.plotType, 'XPS Fit');
  assert.deepEqual(rows[0], [
    'Abscissa', 'Ordinate', 'Residual', 'Background', 'Background-subtracted intensity',
    'Original binding energy (eV)', 'Synthesize', 'Peak 1',
  ]);
  assert.deepEqual(rows.at(-1).map(Number), [100, 3, -1, 2, 1, 100.5, 4, 2]);
  assert.deepEqual(project.settings.options.fills, [{ x: 0, upper: 7, lower: 3, color: '#704dd9', alpha: 0.3 }]);
  assert.deepEqual(project.settings.axes, {
    xLabel: 'Binding energy', xUnit: 'eV', yLabel: 'Intensity', yUnit: 'arb. units',
    hideYTicks: true, hideYTickLabels: true,
  });
});

test('an unfitted kinetic spectrum opens with valid axes and blank fit columns', () => {
  const { project, rows } = readProject({ x: spectrum.x, y: spectrum.y, energyScale: 'kinetic' });
  assert.equal(project.settings.axes.xLabel, 'Kinetic energy');
  assert.equal(project.settings.options.fitLineWidth, 0);
  assert.equal(rows[1][0], '100');
  assert.deepEqual(rows[1].slice(6), ['', '']);
});

test('standard CSV sanitizes imported labels and keeps the energy and intensity values', () => {
  const csv = spectrumToCsv({
    ...spectrum, yUnit: 'カウント',
    columns: [{ label: '炭素', values: spectrum.corrected }],
  });
  assert.doesNotMatch(csv.replace(/^\uFEFF/, ''), nonAscii);
  assert.match(csv, /Binding Energy \(eV\),Measured Intensity/);
  assert.deepEqual(parseSpectrum(csv).y, spectrum.y);
});

test('reopening the standard CSV restores multiple saved components and fit parameters', () => {
  const peaks = [
    { id: 2, label: 'Matrix', shape: 'gaussian', center: 100.8, fwhm: 1.2, height: 5, mix: 0, fixed: { center: true } },
    { id: 4, label: '酸化物', shape: 'pseudo-voigt', center: 102.5, fwhm: 1.5, height: 2, mix: 0.4,
      bounds: { fwhm: [1, Infinity] }, doublet: { separation: 0.606, ratio: 2 } },
  ];
  const csv = spectrumToCsv({
    ...spectrum,
    columns: [
      { label: 'Background', values: spectrum.background },
      { label: 'Total fit', values: spectrum.fit },
      { label: 'Residual', values: spectrum.residual },
      { label: 'Peak 1 - Matrix', values: [2, 3, 1] },
      { label: 'Peak 2 - Oxide', values: [0, 1, 3] },
      { label: 'Doublet 2 primary - Oxide', values: [0, 0.8, 2] },
      { label: 'Doublet 2 secondary - Oxide', values: [0, 0.2, 1] },
      { label: 'Original binding energy (eV)', values: spectrum.originalX },
    ],
    analysis: { version: 1, method: 'linear', offset: -0.5, range: [100, 102], peaks, status: 'converged' },
  });
  const restored = parseSpectrum(csv).analysis;
  assert.equal(restored.metadata.offset, -0.5);
  assert.deepEqual(restored.originalX, spectrum.originalX);
  assert.deepEqual(restored.residual, spectrum.residual);
  assert.deepEqual(restored.metadata.peaks.map(({ id, label }) => [id, label]), [[2, 'Matrix'], [4, 'Peak 2']]);
  assert.deepEqual(restored.metadata.peaks[0].fixed, { center: true });
  assert.deepEqual(restored.metadata.peaks[1].bounds, { fwhm: [1, null] });
  assert.deepEqual(restored.metadata.peaks[1].doublet, { separation: 0.606, ratio: 2 });
  assert.deepEqual(restored.components.map(({ values }) => values), [[2, 3, 1], [0, 1, 3]]);
});

test('pre-metadata Japanese CSV restores every saved component in energy order', () => {
  const csv = [
    '結合エネルギー (eV),測定強度,バックグラウンド,合成フィット,残差,成分 1 Si-C,成分 2 Si-O,補正前エネルギー (eV)',
    '102,4,2,4,0,0,2,102.5',
    '101,8,2,7,1,3,2,101.5',
    '100,3,2,4,-1,2,0,100.5',
  ].join('\r\n');
  const restored = parseSpectrum(csv).analysis;
  assert.equal(restored.metadata, null);
  assert.deepEqual(restored.components, [{ label: 'Si-C', values: [2, 3, 0] }, { label: 'Si-O', values: [0, 2, 2] }]);
  assert.deepEqual(restored.fit, [4, 7, 4]);
});
