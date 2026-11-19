import assert from 'node:assert/strict';
import { test } from 'node:test';
import JSZip from 'jszip';
import { spectraToXlsx } from '../src/xlsx.js';

const binding = { x: [100.25, 101.125, 102.5], y: [10, 20, 30], yUnit: 'counts' };
const kinetic = { x: [201, 202, 204, 206], y: [40, 50, 60, 70], energyScale: 'kinetic' };

async function worksheet(zip, index) {
  const xml = await zip.file(`xl/worksheets/sheet${index}.xml`).async('string');
  const headers = [...xml.matchAll(/<t>([^<]+)<\/t>/g)].map(([, label]) => label);
  const values = [...xml.matchAll(/<c r="[AB]\d+"><v>([^<]+)<\/v><\/c>/g)].map(([, value]) => Number(value));
  assert.doesNotMatch(xml, /<c r="[C-Z]|<f>/);
  return { headers, values };
}

test('shifted XLSX has a two-column sheet for each spectrum with its own grid and energy scale', async () => {
  const bytes = await spectraToXlsx([
    { ...binding, name: 'Si 2p — First', originalX: [100, 101, 102], fit: [1, 2, 3] },
    { ...kinetic, name: 'C 1s' },
  ]);
  assert.ok(bytes instanceof Uint8Array);
  const zip = await JSZip.loadAsync(bytes);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const links = await zip.file('xl/_rels/workbook.xml.rels').async('string');
  assert.match(workbook, /name="Si 2p - First" sheetId="1" r:id="rId1"/);
  assert.match(workbook, /name="C 1s" sheetId="2" r:id="rId2"/);
  assert.match(links, /Id="rId2"[^>]+Target="worksheets\/sheet2.xml"/);
  assert.equal(zip.file('xl/worksheets/sheet3.xml'), null);
  assert.deepEqual(await worksheet(zip, 1), {
    headers: ['Binding Energy (eV)', 'Measured Intensity (counts)'],
    values: [102.5, 30, 101.125, 20, 100.25, 10],
  });
  assert.deepEqual(await worksheet(zip, 2), {
    headers: ['Kinetic Energy (eV)', 'Measured Intensity'],
    values: [201, 40, 202, 50, 204, 60, 206, 70],
  });
});

test('worksheet labels are English, Excel-safe, escaped, and unique after truncation', async () => {
  const long = 'abcdefghijklmnopqrstuvwxyz123456789';
  const spectra = ['  \'A/B:C*D?[E] & "F"\' ', '測定', long, long.toUpperCase(), 'History']
    .map((name) => ({ ...binding, name }));
  const zip = await JSZip.loadAsync(await spectraToXlsx(spectra));
  const workbook = await zip.file('xl/workbook.xml').async('string');
  const names = [...workbook.matchAll(/<sheet name="([^"]+)"/g)].map(([, name]) => name);
  assert.deepEqual(names, [
    'A B C D E &amp; &quot;F&quot;',
    'Spectrum 2',
    'abcdefghijklmnopqrstuvwxyz12345',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ1 (2)',
    'History (2)',
  ]);
});

test('refuses to write missing or invalid shifted measurements', async () => {
  await assert.rejects(spectraToXlsx([]), /at least one spectrum/);
  await assert.rejects(spectraToXlsx([{ ...binding, y: [1, 2] }]), /paired energy and intensity/);
  await assert.rejects(spectraToXlsx([{ ...binding, x: [0, 1, NaN] }]), /invalid energy or intensity/);
});
