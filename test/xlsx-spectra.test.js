import assert from 'node:assert/strict';
import { test } from 'node:test';
import { worksheetSpectra } from '../src/data.js';

function spectra(rows) {
  const cells = rows.map((fields, index) => ({ fields, rowNumber: index + 1 }));
  return worksheetSpectra(cells, 'spectra.xlsx', 'Si 2p');
}

test('reads all spectra with a common energy column and ignores metadata columns', () => {
  const result = spectra([
    ['Acquisition time (s)', '5'],
    ['Index', 'E_B [eV]', 'Sample A', 'Measured B (cps)', 'Time (s)', 'Pass energy (eV)', 'Comment'],
    ['1', '102', '8', '12', '1', '20', 'high energy'],
    ['2', '101', '7', '11', '2', '20', 'middle'],
    ['3', '100', '6', '10', '3', '20', 'low energy'],
  ]);
  assert.deepEqual(result.map(({ name, x, y, yUnit }) => ({ name, x, y, yUnit })), [
    { name: 'Si 2p — Sample A', x: [100, 101, 102], y: [6, 7, 8], yUnit: '' },
    { name: 'Si 2p — Measured B (cps)', x: [100, 101, 102], y: [10, 11, 12], yUnit: 'cps' },
  ]);
});

test('reads independent energy grids, lengths, units, and scales in repeated column pairs', () => {
  const [left, right] = spectra([
    ['Binding Energy', 'Intensity', , 'E_K', 'Intensity'],
    ['eV', 'counts', , 'meV', 'cps'],
    ['100', '3', , '1000', '4'],
    ['101', '2', , '2000', '9'],
    ['102', '1', , '3000', '5'],
    [, , , '4000', '7'],
  ]);
  assert.deepEqual(left, {
    name: 'Si 2p — Intensity (B1)', filename: 'spectra.xlsx', energyScale: 'binding', xUnit: 'eV',
    yUnit: 'counts', x: [100, 101, 102], y: [3, 2, 1],
  });
  assert.deepEqual(right, {
    name: 'Si 2p — Intensity (E1)', filename: 'spectra.xlsx', energyScale: 'kinetic', xUnit: 'eV',
    yUnit: 'cps', x: [1, 2, 3, 4], y: [4, 9, 5, 7],
  });
});

test('allows leading and trailing blanks for different spans on a shared energy grid', () => {
  const result = spectra([
    ['Energy', 'Step 1', 'Step 2'],
    ['100', '8'],
    ['101', '7', '9'],
    ['102', '6', '10'],
    ['103', , '11'],
  ]);
  assert.deepEqual(result.map(({ x, y }) => ({ x, y })), [
    { x: [100, 101, 102], y: [8, 7, 6] },
    { x: [101, 102, 103], y: [9, 10, 11] },
  ]);
});

test('starts a new spectrum when a vertical table repeats its column headings', () => {
  const result = spectra([
    ['X', 'Y'],
    ['2', '3'],
    ['1', '2'],
    ['0', '1'],
    ['Second scan'],
    ['X', 'Y'],
    ['0', '8'],
    ['1', '7'],
    ['2', '6'],
  ]);
  assert.deepEqual(result.map(({ name, y }) => ({ name, y })), [
    { name: 'Si 2p — Y (B1)', y: [1, 2, 3] },
    { name: 'Si 2p — Y (B6)', y: [8, 7, 6] },
  ]);
});

test('reports the row and series if a shared-axis series has a missing point', () => {
  assert.throws(() => spectra([
    ['Energy', 'Reference', 'Sample'],
    ['100', '5', '8'],
    ['101', '6'],
    ['102', '7', '9'],
    ['103', '8', '10'],
  ]), /Spectrum "Si 2p — Sample"\. Row 3 has a non-numeric energy or intensity value\./);
});

test('reports an invalid point instead of truncating a repeated pair', () => {
  assert.throws(() => spectra([
    ['X1', 'Y1', 'X2', 'Y2'],
    ['100', '8', '10', '11'],
    ['101', '9', 'invalid', '12'],
    ['102', '7', '30', '13'],
    [, , '40', '14'],
  ]), /Spectrum "Si 2p — Y2"\. Row 3 has a non-numeric energy or intensity value\./);
});

test('preserves the scale and energy column in a labeled kinetic spectrum', () => {
  const [result] = spectra([
    ['Index', 'Photoelectron kinetic energy (eV)', 'Counts'],
    ['1', '1201', '8'],
    ['2', '1200', '7'],
    ['3', '1199', '6'],
    ['', 'Total', '21'],
  ]);
  assert.equal(result.name, 'Si 2p');
  assert.equal(result.energyScale, 'kinetic');
  assert.deepEqual(result.x, [1199, 1200, 1201]);
  assert.deepEqual(result.y, [6, 7, 8]);
});

test('keeps the sheet name for a single headerless spectrum below unrelated text', () => {
  const [result] = spectra([
    ['Measurement data', , , 'Energy'],
    [, '102', '8'],
    [, '101', '7'],
    [, '100', '6'],
  ]);
  assert.equal(result.name, 'Si 2p');
  assert.deepEqual(result.x, [100, 101, 102]);
  assert.deepEqual(result.y, [6, 7, 8]);
});
